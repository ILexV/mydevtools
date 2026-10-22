//! HTTP request options: timed phases, TLS verification, HTTP version, proxy,
//! client certificates and the cookie jar.

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

struct Pki {
    ca: CertificateDer<'static>,
    client_cert: String,
    client_key: String,
    other_key: String,
}

/// A CA, a client certificate it signed (CN=mdt-client) and an unrelated key.
fn client_pki() -> Pki {
    let dir = std::env::temp_dir().join(format!("mdt-mtls-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let run = |args: &[&str]| {
        let status = std::process::Command::new("openssl")
            .args(args)
            .current_dir(&dir)
            .stderr(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .status()
            .expect("openssl");
        assert!(status.success(), "openssl {args:?}");
    };
    run(&[
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-days",
        "2",
        "-nodes",
        "-subj",
        "/CN=mdt-test-ca",
    ]);
    run(&[
        "req",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        "client.key",
        "-out",
        "client.csr",
        "-nodes",
        "-subj",
        "/CN=mdt-client",
    ]);
    std::fs::write(dir.join("ext.cnf"), "extendedKeyUsage=clientAuth\n").unwrap();
    run(&[
        "x509",
        "-req",
        "-in",
        "client.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "client.pem",
        "-days",
        "2",
        "-extfile",
        "ext.cnf",
    ]);
    run(&[
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        "other.key",
    ]);
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap();
    let pki = Pki {
        ca: CertificateDer::from_pem_slice(read("ca.pem").as_bytes()).unwrap(),
        client_cert: read("client.pem"),
        client_key: read("client.key"),
        other_key: read("other.key"),
    };
    let _ = std::fs::remove_dir_all(&dir);
    pki
}

/// HTTPS server that requires a client certificate from `ca` and echoes the result.
async fn spawn_mtls(ca: CertificateDer<'static>) -> (u16, tokio::task::JoinHandle<()>) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (cert, key) = self_signed();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca).unwrap();
    let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .unwrap();
    let config = rustls::ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(vec![cert], key)
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(stream).await else {
                    return;
                };
                let presented = tls.get_ref().1.peer_certificates().map_or(0, <[_]>::len);
                let mut buffer = [0_u8; 4096];
                let read = tls.read(&mut buffer).await.unwrap_or(0);
                // `/hop` sends the client on to the same server under another host name.
                let reply = if buffer[..read].starts_with(b"GET /hop ") {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: https://localhost:{port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                } else {
                    let body = format!("client chain {presented}");
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = tls.write_all(reply.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    (port, task)
}

#[tokio::test]
async fn client_certificates_are_validated_host_bound_and_keys_never_listed() {
    use crate::security_tests::{
        ORIGIN, TempDir, call, origin_request, pair_from, vault_app, vault_files,
    };

    let pki = client_pki();
    let dir = TempDir::new();
    let (state, app) = vault_app(true, Some(dir.0.clone()));
    let token = pair_from(
        &state,
        &app,
        ORIGIN,
        json!(["http.request", "vault.secrets"]),
    )
    .await;
    let http_only = pair_from(&state, &app, ORIGIN, json!(["http.request"])).await;
    let write = |body: Value| {
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/certificate/write",
            Some(body),
            &token,
        )
    };

    let bad = [
        json!({"name": "c", "hosts": ["127.0.0.1"], "certificatePem": "nope", "keyPem": pki.client_key}),
        json!({"name": "c", "hosts": ["127.0.0.1"], "certificatePem": pki.client_cert, "keyPem": pki.other_key}),
        json!({"name": "c", "hosts": ["127.0.0.1"], "certificatePem": pki.client_cert}),
    ];
    assert_eq!(
        call(&app, write(bad[0].clone())).await.1["error"]["code"],
        "client_certificate_invalid"
    );
    assert_eq!(
        call(&app, write(bad[1].clone())).await.1["error"]["code"],
        "client_certificate_invalid"
    );
    assert_eq!(
        call(&app, write(bad[2].clone())).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, write(json!({"name": "c", "hosts": ["127.0.0.1"]})))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let good = json!({"name": "client", "hosts": ["localhost"], "certificatePem": pki.client_cert, "keyPem": pki.client_key});
    assert_eq!(call(&app, write(good)).await.0, StatusCode::NO_CONTENT);

    let (status, listed) = call(
        &app,
        origin_request(ORIGIN, Method::GET, "/v1/vault/certificates", None, &token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entry = &listed["certificates"][0];
    assert_eq!(entry["name"], "client");
    assert_eq!(entry["hosts"], json!(["localhost"]));
    assert!(entry["subject"].as_str().unwrap().contains("mdt-client"));
    assert!(entry["notAfter"].is_string());
    let text = listed.to_string();
    assert!(!text.contains("PRIVATE KEY") && !text.contains("BEGIN CERTIFICATE"));
    let key_line = pki.client_key.lines().nth(1).unwrap();
    for file in vault_files(&dir.0) {
        let bytes = std::fs::read(file).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains(key_line),
            "key stored in clear"
        );
    }
    let denied = origin_request(
        ORIGIN,
        Method::GET,
        "/v1/vault/certificates",
        None,
        &http_only,
    );
    assert_eq!(call(&app, denied).await.0, StatusCode::FORBIDDEN);

    let (port, server) = spawn_mtls(pki.ca.clone()).await;
    let input = |certificate: Option<&str>| {
        let mut input = http_input(Uuid::new_v4(), format!("https://127.0.0.1:{port}/"), false);
        input["verifyTls"] = json!(false);
        if let Some(name) = certificate {
            input["clientCertificate"] = json!(name);
        }
        input
    };
    let send = |input: Value, token: &str| {
        origin_request(ORIGIN, Method::POST, "/v1/http/request", Some(input), token)
    };

    // The certificate lists localhost, not 127.0.0.1.
    let (status, reply) = call(&app, send(input(Some("client")), &token)).await;
    assert_eq!(
        (status, reply["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("certificate_host_denied"))
    );
    let hosts_only = json!({"name": "client", "hosts": ["127.0.0.1", "localhost"]});
    assert_eq!(
        call(&app, write(hosts_only)).await.0,
        StatusCode::NO_CONTENT
    );

    let (status, reply) = call(&app, send(input(Some("client")), &token)).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(body_text(&reply), "client chain 1");
    let (status, _) = call(&app, send(input(None), &token)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let (status, _) = call(&app, send(input(Some("client")), &http_only)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Every redirect hop is checked against the hosts: localhost gets the
    // certificate only while it is listed, else the server refuses the handshake.
    let hop = || {
        let mut hop = input(Some("client"));
        hop["url"] = json!(format!("https://127.0.0.1:{port}/hop"));
        hop["followRedirects"] = json!(true);
        hop
    };
    let (status, reply) = call(&app, send(hop(), &token)).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(body_text(&reply), "client chain 1");
    let first_host_only = json!({"name": "client", "hosts": ["127.0.0.1"]});
    assert_eq!(
        call(&app, write(first_host_only)).await.0,
        StatusCode::NO_CONTENT
    );
    let (status, _) = call(&app, send(hop(), &token)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);

    let delete = origin_request(
        ORIGIN,
        Method::POST,
        "/v1/vault/certificate/delete",
        Some(json!({"name": "client"})),
        &token,
    );
    assert_eq!(call(&app, delete).await.0, StatusCode::NO_CONTENT);
    let (_, reply) = call(&app, send(input(Some("client")), &token)).await;
    assert_eq!(reply["error"]["code"], "certificate_not_found");
    server.abort();
}

/// `/login` sets a session and redirects to `/me`; `/logout` deletes it; every
/// other path echoes the `Cookie` header it received.
async fn spawn_cookie_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let service = service_fn(
                    |request: hyper::Request<hyper::body::Incoming>| async move {
                        let cookie = request
                            .headers()
                            .get("cookie")
                            .map_or("-".to_owned(), |value| {
                                String::from_utf8_lossy(value.as_bytes()).into_owned()
                            });
                        let response = match request.uri().path() {
                            "/login" => hyper::Response::builder()
                                .status(302)
                                .header("location", "/me")
                                .header("set-cookie", "sid=abc; Path=/; HttpOnly")
                                .header("set-cookie", "theme=light; Path=/; Max-Age=3600")
                                .body(Full::new(Bytes::new())),
                            "/logout" => hyper::Response::builder()
                                .header("set-cookie", "sid=; Path=/; Max-Age=0")
                                .body(Full::new(Bytes::from(cookie))),
                            _ => hyper::Response::builder().body(Full::new(Bytes::from(cookie))),
                        };
                        Ok::<_, Infallible>(response.unwrap())
                    },
                );
                let _ = conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    (port, task)
}

#[tokio::test]
async fn cookie_jar_follows_redirect_hops_merges_written_cookies_and_reports_changes() {
    let (port, server) = spawn_cookie_server().await;
    let input = |path: &str, cookies: Option<Value>| {
        let mut input = http_input(
            Uuid::new_v4(),
            format!("http://127.0.0.1:{port}{path}"),
            true,
        );
        if let Some(cookies) = cookies {
            input["cookies"] = cookies;
        }
        input
    };

    // The session set by the 302 reaches the next hop.
    let (status, reply) = send(input("/login", Some(json!([])))).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(body_text(&reply), "sid=abc; theme=light");
    let changes = reply["cookies"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["name"], "sid");
    assert_eq!(changes[0]["domain"], "127.0.0.1");
    assert_eq!(changes[0]["hostOnly"], true);
    assert_eq!(changes[0]["httpOnly"], true);
    assert!(changes[0].get("expires").is_none());
    assert!(changes[1]["expires"].as_i64().unwrap() > crate::cookies::now());

    // A cookie written by hand wins over the jar's one of the same name.
    let jar = json!([
        {"name": "sid", "value": "abc", "domain": "127.0.0.1", "path": "/", "hostOnly": true},
        {"name": "theme", "value": "light", "domain": "127.0.0.1", "path": "/", "hostOnly": true},
        {"name": "other", "value": "1", "domain": "example.com", "path": "/"},
    ]);
    let mut written = input("/me", Some(jar.clone()));
    written["headers"] = json!([{"name": "Cookie", "value": "theme=dark"}]);
    let (_, reply) = send(written).await;
    assert_eq!(body_text(&reply), "theme=dark; sid=abc");
    assert_eq!(reply["cookies"], json!([]));

    let (_, reply) = send(input("/logout", Some(jar))).await;
    assert_eq!(body_text(&reply), "sid=abc; theme=light");
    assert_eq!(reply["cookies"][0]["name"], "sid");
    assert_eq!(reply["cookies"][0]["expires"], 0);

    // Without a jar nothing is added or reported.
    let (_, reply) = send(input("/login", None)).await;
    assert_eq!(body_text(&reply), "-");
    assert!(reply.get("cookies").is_none());

    let bad = json!([{"name": "a b", "value": "1", "domain": "127.0.0.1", "path": "/"}]);
    let (status, _) = send(input("/me", Some(bad))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    server.abort();
}
