//! HTTP request options: timed phases, TLS verification, HTTP version and proxy.

use std::{convert::Infallible, sync::Arc};

use axum::http::{Method, StatusCode};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{server::conn, service::service_fn};
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;
use uuid::Uuid;

use crate::security_tests::{http_input, pair, request, response_json, test_app};

fn self_signed() -> (CertificateDer<'static>, PrivateKeyDer<'static>) {
    let dir = std::env::temp_dir().join(format!("mdt-http-tls-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let key_path = dir.join("key.pem");
    let cert_path = dir.join("cert.pem");
    let status = std::process::Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
        ])
        .arg("-keyout")
        .arg(&key_path)
        .arg("-out")
        .arg(&cert_path)
        .args(["-days", "2", "-nodes", "-subj", "/CN=localhost"])
        .args(["-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"])
        .stderr(std::process::Stdio::null())
        .status()
        .expect("openssl");
    assert!(status.success(), "openssl certificate");
    let cert = CertificateDer::from_pem_slice(&std::fs::read(&cert_path).unwrap()).unwrap();
    let key = PrivateKeyDer::from_pem_slice(&std::fs::read(&key_path).unwrap()).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    (cert, key)
}

/// HTTPS server with a self-signed certificate; answers with the HTTP version it served.
async fn spawn_https() -> (u16, tokio::task::JoinHandle<()>) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (cert, key) = self_signed();
    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(stream).await else {
                    return;
                };
                let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
                let service = service_fn(
                    |request: hyper::Request<hyper::body::Incoming>| async move {
                        let text = format!("{:?} {}", request.version(), request.uri());
                        Ok::<_, Infallible>(hyper::Response::new(Full::new(Bytes::from(text))))
                    },
                );
                if h2 {
                    let _ = conn::http2::Builder::new(TokioExecutor::new())
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                } else {
                    let _ = conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                }
            });
        }
    });
    (port, task)
}

async fn send(input: Value) -> (StatusCode, Value) {
    let (_, app) = test_app(true, 48_732);
    let token = pair(&app).await;
    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(input),
            Some(&token),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, response_json(response).await)
}

fn body_text(reply: &Value) -> String {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    String::from_utf8(
        STANDARD
            .decode(reply["bodyBase64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn http_reply_has_version_remote_address_and_phases() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0_u8; 4096];
        let _ = socket.read(&mut buffer).await;
        socket
            .write_all(
                b"HTTP/1.1 418 Short And Stout\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            )
            .await
            .unwrap();
    });
    let (status, reply) = send(http_input(
        Uuid::new_v4(),
        format!("http://{address}/"),
        false,
    ))
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["status"], 418);
    assert_eq!(reply["statusText"], "Short And Stout");
    assert_eq!(reply["httpVersion"], "HTTP/1.1");
    assert_eq!(reply["remoteAddress"], address.to_string());
    assert_eq!(reply["redirects"], 0);
    assert!(reply["tls"].is_null());
    let timings = &reply["timings"];
    for phase in ["dnsMs", "connectMs", "firstByteMs", "downloadMs"] {
        assert!(timings[phase].as_f64().unwrap() >= 0.0, "{phase}");
    }
    assert!(timings["tlsMs"].is_null());
    server.await.unwrap();
}

#[tokio::test]
async fn tls_verification_is_on_by_default_and_can_be_turned_off() {
    let (port, server) = spawn_https().await;
    let url = format!("https://127.0.0.1:{port}/path?q=1");

    let (status, reply) = send(http_input(Uuid::new_v4(), url.clone(), false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply["error"]["code"], "tls_certificate_invalid");

    let mut input = http_input(Uuid::new_v4(), url.clone(), false);
    input["verifyTls"] = json!(false);
    let (status, reply) = send(input).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["httpVersion"], "HTTP/2");
    assert_eq!(body_text(&reply), format!("HTTP/2.0 {url}"));
    assert_eq!(reply["tls"]["verified"], false);
    assert_eq!(reply["tls"]["protocol"], "TLSv1_3");
    assert!(reply["timings"]["tlsMs"].as_f64().unwrap() >= 0.0);

    let mut input = http_input(Uuid::new_v4(), url, false);
    input["verifyTls"] = json!(false);
    input["httpVersion"] = json!("http1");
    let (status, reply) = send(input).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["httpVersion"], "HTTP/1.1");
    assert_eq!(body_text(&reply), "HTTP/1.1 /path?q=1");
    server.abort();
}

#[tokio::test]
async fn http2_choice_fails_when_the_server_has_only_http1() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (cert, key) = self_signed();
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = acceptor.accept(stream).await;
    });
    let mut input = http_input(Uuid::new_v4(), format!("https://127.0.0.1:{port}/"), false);
    input["verifyTls"] = json!(false);
    input["httpVersion"] = json!("http2");
    let (status, reply) = send(input).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply["error"]["code"], "http2_unsupported");
    server.await.unwrap();

    let mut input = http_input(Uuid::new_v4(), format!("https://127.0.0.1:{port}/"), false);
    input["httpVersion"] = json!("http3");
    assert_eq!(send(input).await.0, StatusCode::BAD_REQUEST);
}

/// One-connection proxy: reports what it received, then answers `reply`.
async fn spawn_proxy(
    reply: &'static [u8],
) -> (std::net::SocketAddr, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 4096];
        while !received.ends_with(b"\r\n\r\n") {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..read]);
        }
        let _ = tx.send(String::from_utf8_lossy(&received).into_owned());
        socket.write_all(reply).await.unwrap();
    });
    (address, rx)
}

#[tokio::test]
async fn proxy_gets_absolute_form_for_http_and_connect_for_https() {
    let (proxy, mut seen) =
        spawn_proxy(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied")
            .await;
    let mut input = http_input(Uuid::new_v4(), "http://example.com/a?b=1".to_owned(), false);
    input["proxy"] =
        json!({"url": format!("http://{proxy}"), "username": "user", "password": "pass"});
    let (status, reply) = send(input).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body_text(&reply), "proxied");
    assert_eq!(reply["remoteAddress"], proxy.to_string());
    let received = seen.recv().await.unwrap();
    assert!(
        received.starts_with("GET http://example.com/a?b=1 HTTP/1.1\r\n"),
        "{received}"
    );
    assert!(
        received
            .to_ascii_lowercase()
            .contains("proxy-authorization: basic dxnlcjpwyxnz")
    );
    assert!(received.to_ascii_lowercase().contains("host: example.com"));

    let (proxy, mut seen) =
        spawn_proxy(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").await;
    let mut input = http_input(Uuid::new_v4(), "https://example.com/".to_owned(), false);
    input["proxy"] = json!({"url": format!("http://{proxy}")});
    let (status, reply) = send(input).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply["error"]["code"], "proxy_auth_required");
    let received = seen.recv().await.unwrap();
    assert!(
        received.starts_with("CONNECT example.com:443 HTTP/1.1\r\n"),
        "{received}"
    );
    assert!(
        !received
            .to_ascii_lowercase()
            .contains("proxy-authorization")
    );
}

#[tokio::test]
async fn proxy_is_policy_checked_validated_and_bypassed_by_host() {
    let mut input = http_input(Uuid::new_v4(), "http://example.com/".to_owned(), false);
    input["proxy"] = json!({"url": "http://169.254.169.254:3128"});
    let (status, reply) = send(input).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(reply["error"]["code"], "target_denied");

    // A literal target is checked even though the proxy would reach it.
    let (proxy, _seen) = spawn_proxy(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
    let mut input = http_input(
        Uuid::new_v4(),
        "http://169.254.169.254/latest".to_owned(),
        false,
    );
    input["proxy"] = json!({"url": format!("http://{proxy}")});
    assert_eq!(send(input).await.1["error"]["code"], "target_denied");

    for url in [
        "https://proxy.example:3128",
        "http://proxy.example:3128/path",
        "socks5://proxy.example:1080",
        "http://user:pass@proxy.example:3128",
    ] {
        let mut input = http_input(Uuid::new_v4(), "http://example.com/".to_owned(), false);
        input["proxy"] = json!({"url": url});
        assert_eq!(send(input).await.0, StatusCode::BAD_REQUEST, "{url}");
    }

    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_address = target.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = target.accept().await.unwrap();
        let mut buffer = [0_u8; 4096];
        let _ = socket.read(&mut buffer).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect")
            .await
            .unwrap();
    });
    let mut input = http_input(Uuid::new_v4(), format!("http://{target_address}/"), false);
    input["proxy"] = json!({"url": "http://192.0.2.1:3128", "bypass": ["127.0.0.1"]});
    let (status, reply) = send(input).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body_text(&reply), "direct");
    server.await.unwrap();
}
