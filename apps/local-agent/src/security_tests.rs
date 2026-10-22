use std::{collections::HashSet, net::IpAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    policy::enforce_destination,
    server,
    state::{AgentConfig, AgentState},
};

pub(super) const ORIGIN: &str = "https://mydevtools.app";
const PAIRING_CODE: &str = "11111111111111111111111111111111";

pub(super) fn test_app(allow_private: bool, port: u16) -> (Arc<AgentState>, Router) {
    let state = AgentState::new(AgentConfig {
        port,
        allow_private,
        allowed_origins: HashSet::from([ORIGIN.to_owned()]),
        data_dir: None,
    });
    assert_eq!(state.replace_pairing_code([0x11; 16]), PAIRING_CODE);
    let app = server::router(Arc::clone(&state));
    (state, app)
}

pub(super) fn request(
    method: Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:48732")
        .header("origin", ORIGIN);
    let body = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        Body::from(serde_json::to_vec(&body).expect("test JSON"))
    } else {
        Body::empty()
    };
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder.body(body).expect("test request")
}

pub(super) async fn response_json(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), 32 * 1024 * 1024)
        .await
        .expect("response body");
    serde_json::from_slice(&body).expect("JSON response")
}

pub(super) async fn pair(app: &Router) -> String {
    let response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/pair",
            Some(json!({
                "code": PAIRING_CODE,
                "capabilities": ["http.request"]
            })),
            None,
        ))
        .await
        .expect("pair response");
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await["token"]
        .as_str()
        .expect("session token")
        .to_owned()
}

pub(super) fn http_input(id: Uuid, url: String, follow_redirects: bool) -> Value {
    json!({
        "id": id.to_string(),
        "method": "GET",
        "url": url,
        "headers": [],
        "bodyBase64": "",
        "timeoutMs": 5000,
        "followRedirects": follow_redirects
    })
}

#[tokio::test]
async fn every_route_requires_exact_host_and_origin_and_cors_is_not_wildcard() {
    let (_, app) = test_app(false, 48_732);

    let response = app
        .clone()
        .oneshot(request(Method::GET, "/v1/info", None, None))
        .await
        .expect("info response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["access-control-allow-origin"], ORIGIN);
    assert_ne!(response.headers()["access-control-allow-origin"], "*");

    let wrong_host = Request::builder()
        .method(Method::GET)
        .uri("/v1/info")
        .header("host", "localhost:48732")
        .header("origin", ORIGIN)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(wrong_host).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(response_json(response).await["error"]["code"], "forbidden");

    let missing_origin = Request::builder()
        .method(Method::GET)
        .uri("/v1/info")
        .header("host", "127.0.0.1:48732")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(missing_origin).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );

    let wrong_method = request(Method::POST, "/v1/info", Some(json!({})), None);
    let response = app.clone().oneshot(wrong_method).await.unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "invalid_request"
    );

    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/v1/http/request")
        .header("host", "127.0.0.1:48732")
        .header("origin", ORIGIN)
        .header("access-control-request-method", "POST")
        .header(
            "access-control-request-headers",
            "authorization, content-type",
        )
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(preflight).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response.headers()["access-control-allow-private-network"],
        "true"
    );
}

#[tokio::test]
async fn pairing_is_one_time_capability_scoped_and_protected_routes_require_bearer() {
    let (_, app) = test_app(false, 48_732);
    let unsupported = request(
        Method::POST,
        "/v1/pair",
        Some(json!({"code": PAIRING_CODE, "capabilities": ["network.scan"]})),
        None,
    );
    let response = app.clone().oneshot(unsupported).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "unsupported_capability"
    );

    let token = pair(&app).await;
    assert_eq!(token.len(), 43);

    let reused = request(
        Method::POST,
        "/v1/pair",
        Some(json!({"code": PAIRING_CODE, "capabilities": ["http.request"]})),
        None,
    );
    let response = app.clone().oneshot(reused).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "pairing_invalid"
    );

    let unprotected = request(
        Method::POST,
        "/v1/http/cancel",
        Some(json!({"id": Uuid::new_v4().to_string()})),
        None,
    );
    let response = app.oneshot(unprotected).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pairing_attempts_are_rate_limited() {
    let (_, app) = test_app(false, 48_732);
    for _ in 0..10 {
        let invalid = request(
            Method::POST,
            "/v1/pair",
            Some(json!({
                "code": "00000000000000000000000000000000",
                "capabilities": ["http.request"]
            })),
            None,
        );
        let response = app.clone().oneshot(invalid).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let limited = request(
        Method::POST,
        "/v1/pair",
        Some(json!({
            "code": PAIRING_CODE,
            "capabilities": ["http.request"]
        })),
        None,
    );
    let response = app.oneshot(limited).await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "pairing_rate_limited"
    );
}

#[tokio::test]
async fn outbound_policy_blocks_private_and_own_listener_even_with_opt_in() {
    let (_, public_only_app) = test_app(false, 48_732);
    let token = pair(&public_only_app).await;
    let response = public_only_app
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(http_input(
                Uuid::new_v4(),
                "http://127.0.0.1:49123/".to_owned(),
                false,
            )),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "private_network_denied"
    );

    let (_, private_app) = test_app(true, 48_732);
    let token = pair(&private_app).await;
    let response = private_app
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(http_input(
                Uuid::new_v4(),
                "http://[::ffff:127.0.0.1]:48732/".to_owned(),
                false,
            )),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "target_denied"
    );
}

#[tokio::test]
async fn cancellation_tombstone_closes_cancel_before_registration_race() {
    let (_, app) = test_app(false, 48_732);
    let token = pair(&app).await;
    let id = Uuid::new_v4();
    let cancel = request(
        Method::POST,
        "/v1/http/cancel",
        Some(json!({"id": id.to_string()})),
        Some(&token),
    );
    assert_eq!(
        app.clone().oneshot(cancel).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(http_input(
                id,
                "https://example.com/never-contact".to_owned(),
                false,
            )),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response_json(response).await["error"]["code"], "cancelled");
}

#[tokio::test]
async fn session_revocation_cancels_an_in_flight_socket_request() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_address = target.local_addr().unwrap();
    let (accepted_tx, accepted_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let target_task = tokio::spawn(async move {
        let (mut socket, _) = target.accept().await.unwrap();
        let mut request_bytes = [0_u8; 2048];
        let _ = socket.read(&mut request_bytes).await;
        let _ = accepted_tx.send(());
        let _ = release_rx.await;
    });

    let (_, app) = test_app(true, 48_732);
    let token = pair(&app).await;
    let outgoing = tokio::spawn(app.clone().oneshot(request(
        Method::POST,
        "/v1/http/request",
        Some(http_input(
            Uuid::new_v4(),
            format!("http://{target_address}/wait"),
            false,
        )),
        Some(&token),
    )));
    tokio::time::timeout(Duration::from_secs(2), accepted_rx)
        .await
        .expect("outbound connection")
        .expect("accept signal");

    let revoke = request(Method::DELETE, "/v1/session", None, Some(&token));
    assert_eq!(
        app.clone().oneshot(revoke).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let response = tokio::time::timeout(Duration::from_secs(2), outgoing)
        .await
        .expect("cancelled promptly")
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response_json(response).await["error"]["code"], "cancelled");

    let after_revoke = request(
        Method::POST,
        "/v1/http/cancel",
        Some(json!({"id": Uuid::new_v4().to_string()})),
        Some(&token),
    );
    assert_eq!(
        app.oneshot(after_revoke).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let _ = release_tx.send(());
    target_task.await.unwrap();
}

#[tokio::test]
async fn redirects_revalidate_destination_and_oversized_responses_fail_explicitly() {
    let redirect_target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect_address = redirect_target.local_addr().unwrap();
    let redirect_task = tokio::spawn(async move {
        let (mut socket, _) = redirect_target.accept().await.unwrap();
        let mut bytes = [0_u8; 2048];
        let _ = socket.read(&mut bytes).await;
        socket
            .write_all(
                b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
    });
    let (_, redirect_app) = test_app(true, 48_732);
    let token = pair(&redirect_app).await;
    let response = redirect_app
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(http_input(
                Uuid::new_v4(),
                format!("http://{redirect_address}/"),
                true,
            )),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "target_denied"
    );
    redirect_task.await.unwrap();

    let large_target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let large_address = large_target.local_addr().unwrap();
    let large_task = tokio::spawn(async move {
        let (mut socket, _) = large_target.accept().await.unwrap();
        let mut bytes = [0_u8; 2048];
        let _ = socket.read(&mut bytes).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16777217\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let (_, large_app) = test_app(true, 48_732);
    let token = pair(&large_app).await;
    let response = large_app
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(http_input(
                Uuid::new_v4(),
                format!("http://{large_address}/"),
                false,
            )),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "response_too_large"
    );
    large_task.await.unwrap();
}
#[tokio::test]
async fn cross_origin_redirect_does_not_forward_secret_headers() {
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination_address = destination.local_addr().unwrap();
    let (headers_tx, headers_rx) = oneshot::channel();
    let destination_task = tokio::spawn(async move {
        let (mut socket, _) = destination.accept().await.unwrap();
        let mut bytes = vec![0_u8; 8192];
        let count = socket.read(&mut bytes).await.unwrap();
        bytes.truncate(count);
        let _ = headers_tx.send(String::from_utf8_lossy(&bytes).into_owned());
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });

    let redirect = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect_address = redirect.local_addr().unwrap();
    let redirect_task = tokio::spawn(async move {
        let (mut socket, _) = redirect.accept().await.unwrap();
        let mut bytes = [0_u8; 8192];
        let _ = socket.read(&mut bytes).await;
        let response = format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{destination_address}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });

    let (_, app) = test_app(true, 48_732);
    let token = pair(&app).await;
    let mut input = http_input(
        Uuid::new_v4(),
        format!("http://{redirect_address}/start"),
        true,
    );
    input["headers"] = json!([
        {"name": "Authorization", "value": "Bearer target-secret"},
        {"name": "Cookie", "value": "session=target-secret"},
        {"name": "X-Api-Key", "value": "target-secret"},
        {"name": "Accept", "value": "application/json"}
    ]);
    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(input),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["status"], 200);

    let forwarded = headers_rx.await.unwrap().to_ascii_lowercase();
    assert!(forwarded.contains("accept: application/json"));
    assert!(!forwarded.contains("target-secret"));
    assert!(!forwarded.contains("x-api-key"));
    assert!(!forwarded.contains("cookie:"));
    redirect_task.await.unwrap();
    destination_task.await.unwrap();
}

#[tokio::test]
async fn incoming_json_limit_is_enforced_before_deserialization() {
    let (_, app) = test_app(false, 48_732);
    let oversized = Request::builder()
        .method(Method::POST)
        .uri("/v1/pair")
        .header("host", "127.0.0.1:48732")
        .header("origin", ORIGIN)
        .header("content-type", "application/json")
        .body(Body::from(vec![b' '; 2 * 1024 * 1024 + 1]))
        .unwrap();
    let response = app.oneshot(oversized).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "request_too_large"
    );
}

#[test]
fn ipv6_embedding_cannot_bypass_private_and_reserved_policy() {
    let mapped_private: IpAddr = "::ffff:10.0.0.1".parse().unwrap();
    assert_eq!(
        enforce_destination(mapped_private, 80, 48_732, false)
            .unwrap_err()
            .code,
        "private_network_denied"
    );

    let nat64_metadata: IpAddr = "64:ff9b::a9fe:a9fe".parse().unwrap();
    assert_eq!(
        enforce_destination(nat64_metadata, 80, 48_732, true)
            .unwrap_err()
            .code,
        "target_denied"
    );

    let six_to_four_private: IpAddr = "2002:0a00:0001::1".parse().unwrap();
    assert_eq!(
        enforce_destination(six_to_four_private, 80, 48_732, false)
            .unwrap_err()
            .code,
        "private_network_denied"
    );
    for (address, allow_private, expected) in [
        ("fd12::5efe:808:808", false, "private_network_denied"),
        ("fe80::5efe:808:808", true, "target_denied"),
        ("64:ff9b:1:a9fe:a9:fe00:808:808", true, "target_denied"),
        ("4000::1", true, "target_denied"),
    ] {
        assert_eq!(
            enforce_destination(address.parse().unwrap(), 80, 48_732, allow_private)
                .unwrap_err()
                .code,
            expected,
            "{address}"
        );
    }
}

#[tokio::test]
async fn shutdown_finishes_even_when_an_upload_never_finishes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (state, _) = test_app(false, address.port());
    let shutdown = tokio_util::sync::CancellationToken::new();
    let server_task = tokio::spawn(server::serve(listener, state, shutdown.clone()));
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let headers = format!(
        "POST /v1/pair HTTP/1.1\r\nHost: {address}\r\nOrigin: {ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nExpect: 100-continue\r\n\r\n"
    );
    socket.write_all(headers.as_bytes()).await.unwrap();
    let mut interim = [0; 25];
    tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut interim))
        .await
        .expect("server should start reading the request body")
        .unwrap();
    assert!(interim.starts_with(b"HTTP/1.1 100"));
    socket.write_all(b"{").await.unwrap();
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(4), server_task)
        .await
        .expect("Exit must not wait indefinitely for an unfinished request body")
        .unwrap()
        .unwrap();
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
}

fn trace_input(id: Uuid, target: &str) -> Value {
    json!({
        "id": id.to_string(),
        "target": target,
        "intervalMs": 200,
        "payloadBytes": 8,
        "maxHops": 1,
        "timeoutMs": 1000,
        "resolveNames": false
    })
}

pub(super) async fn pair_capabilities(
    state: &AgentState,
    app: &Router,
    capabilities: Value,
) -> Value {
    state.replace_pairing_code([0x11; 16]);
    let response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/pair",
            Some(json!({
                "code": PAIRING_CODE,
                "capabilities": capabilities
            })),
            None,
        ))
        .await
        .expect("pair response");
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
}

#[tokio::test]
async fn icmp_capability_is_separate_from_http_and_rejects_bad_targets() {
    let (state, app) = test_app(false, 48_732);
    let info = app
        .clone()
        .oneshot(request(Method::GET, "/v1/info", None, None))
        .await
        .unwrap();
    assert_eq!(info.status(), StatusCode::OK);
    assert_eq!(
        response_json(info).await["capabilities"],
        json!([
            "http.request",
            "icmp.trace",
            "dns.lookup",
            "tcp.connect",
            "tls.inspect",
            "whois.lookup",
            "asn.lookup",
            "vault.data",
            "vault.secrets",
            "sse.stream",
            "websocket.connect"
        ])
    );

    for capabilities in [
        json!([]),
        json!(["http.request", "http.request"]),
        json!(["icmp.trace", "icmp.trace"]),
        json!(["dns.lookup", "dns.lookup"]),
        json!(["tcp.connect", "tcp.connect"]),
        json!(["tls.inspect", "tls.inspect"]),
        json!(["whois.lookup", "whois.lookup"]),
        json!(["asn.lookup", "asn.lookup"]),
        json!(["vault.data", "vault.data"]),
        json!(["vault.secrets", "vault.secrets"]),
    ] {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/pair",
                Some(json!({"code": PAIRING_CODE, "capabilities": capabilities})),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "unsupported_capability"
        );
    }

    let http_only = pair_capabilities(&state, &app, json!(["http.request"])).await;
    assert_eq!(http_only["capabilities"], json!(["http.request"]));
    let http_token = http_only["token"].as_str().unwrap().to_owned();
    let denied = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(Uuid::new_v4(), "127.0.0.1")),
            Some(&http_token),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(response_json(denied).await["error"]["code"], "forbidden");

    let icmp_only = pair_capabilities(&state, &app, json!(["icmp.trace"])).await;
    assert_eq!(icmp_only["capabilities"], json!(["icmp.trace"]));
    let icmp_token = icmp_only["token"].as_str().unwrap().to_owned();
    let denied_http = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(json!({})),
            Some(&icmp_token),
        ))
        .await
        .unwrap();
    assert_eq!(denied_http.status(), StatusCode::FORBIDDEN);

    for target in ["bad host", "http://example.test", ""] {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/icmp/trace",
                Some(trace_input(Uuid::new_v4(), target)),
                Some(&icmp_token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{target}");
        assert_eq!(
            response_json(response).await["error"]["code"],
            "invalid_request",
            "{target}"
        );
    }

    let private_target = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(Uuid::new_v4(), "10.1.1.1")),
            Some(&icmp_token),
        ))
        .await
        .unwrap();
    assert_eq!(private_target.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(private_target).await["error"]["code"],
        "private_network_denied"
    );

    let revoked = app
        .clone()
        .oneshot(request(
            Method::DELETE,
            "/v1/session",
            None,
            Some(&icmp_token),
        ))
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn icmp_trace_records_a_localhost_echo_and_blocks_metadata() {
    let (state, app) = test_app(true, 48_732);
    let paired = pair_capabilities(&state, &app, json!(["http.request", "icmp.trace"])).await;
    assert_eq!(
        paired["capabilities"],
        json!(["http.request", "icmp.trace"])
    );
    let token = paired["token"].as_str().unwrap().to_owned();

    let metadata = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(Uuid::new_v4(), "169.254.169.254")),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(metadata).await["error"]["code"],
        "target_denied"
    );

    let cgnat = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(Uuid::new_v4(), "100.64.0.1")),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(cgnat.status(), StatusCode::FORBIDDEN);
    assert_eq!(response_json(cgnat).await["error"]["code"], "target_denied");

    let id = Uuid::new_v4();
    let started = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(id, "127.0.0.1")),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(started.status(), StatusCode::OK);
    let started = response_json(started).await;
    assert_eq!(started["state"], "tracing");
    assert_eq!(started["target"], "127.0.0.1");
    assert_eq!(started["targetInput"], "127.0.0.1");
    assert!(started["sourceAddress"].is_null());
    assert!(started["sourceInterface"].is_null());

    let mut received = 0;
    let mut address = String::new();
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let snapshot = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/icmp/snapshot",
                Some(json!({"id": id.to_string()})),
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(snapshot.status(), StatusCode::OK);
        let snapshot = response_json(snapshot).await;
        if snapshot["hops"].as_array().is_some_and(|hops| {
            hops.first()
                .is_some_and(|hop| hop["received"].as_u64().unwrap_or(0) >= 1)
        }) {
            received = snapshot["hops"][0]["received"].as_u64().unwrap();
            address = snapshot["hops"][0]["address"].as_str().unwrap().to_owned();
            break;
        }
    }
    assert!(received >= 1, "localhost echo was not recorded");
    assert_eq!(address, "127.0.0.1");

    let missing = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/snapshot",
            Some(json!({"id": Uuid::new_v4().to_string()})),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(response_json(missing).await["error"]["code"], "not_found");

    let cancel = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/cancel",
            Some(json!({"id": id.to_string()})),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(cancel.status(), StatusCode::NO_CONTENT);

    let mut idle = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let snapshot = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/icmp/snapshot",
                Some(json!({"id": id.to_string()})),
                Some(&token),
            ))
            .await
            .unwrap();
        let snapshot = response_json(snapshot).await;
        if snapshot["state"] == "idle" {
            idle = true;
            assert!(snapshot["hops"][0]["received"].as_u64().unwrap_or(0) >= 1);
            break;
        }
    }
    assert!(idle, "trace did not become idle after cancel");
}

async fn icmp_snapshot(app: &Router, token: &str, id: Uuid) -> Value {
    let response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/snapshot",
            Some(json!({ "id": id.to_string() })),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
}

async fn wait_for_echo(app: &Router, token: &str, id: Uuid) -> u64 {
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let snapshot = icmp_snapshot(app, token, id).await;
        let received = snapshot["hops"]
            .get(0)
            .and_then(|hop| hop["received"].as_u64())
            .unwrap_or(0);
        if received >= 1 {
            assert_eq!(snapshot["state"], "tracing");
            return received;
        }
    }
    panic!("echo missing for {id}");
}

/// Two desktop windows share a paired session but each owns its trace id.
/// A third start is refused until one of those traces is idle.
#[tokio::test]
async fn icmp_traces_stay_independent_and_the_third_is_busy() {
    let (state, app) = test_app(true, 48_732);
    let paired = pair_capabilities(&state, &app, json!(["icmp.trace"])).await;
    let token = paired["token"].as_str().unwrap().to_owned();

    let mut ids = Vec::new();
    for target in ["127.0.0.1", "::1"] {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/icmp/trace",
                Some(trace_input(Uuid::new_v4(), target)),
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{target}");
        let body = response_json(response).await;
        assert_eq!(body["target"], target);
        assert_eq!(body["state"], "tracing");
        ids.push(body["id"].as_str().unwrap().to_owned());
    }
    assert_ne!(ids[0], ids[1]);

    let first = Uuid::parse_str(&ids[0]).unwrap();
    let second = Uuid::parse_str(&ids[1]).unwrap();
    let first_received = wait_for_echo(&app, &token, first).await;
    let second_received = wait_for_echo(&app, &token, second).await;
    let first_snapshot = icmp_snapshot(&app, &token, first).await;
    let second_snapshot = icmp_snapshot(&app, &token, second).await;
    assert_eq!(first_snapshot["target"], "127.0.0.1");
    assert_eq!(first_snapshot["hops"][0]["address"], "127.0.0.1");
    assert_eq!(second_snapshot["target"], "::1");
    assert_eq!(second_snapshot["hops"][0]["address"], "::1");
    assert!(first_received >= 1 && second_received >= 1);

    let busy = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(Uuid::new_v4(), "127.0.0.1")),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(busy.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response_json(busy).await["error"]["code"], "busy");

    let cancel = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/cancel",
            Some(json!({ "id": first.to_string() })),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(cancel.status(), StatusCode::NO_CONTENT);

    let mut first_idle = false;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let snapshot = icmp_snapshot(&app, &token, first).await;
        let other = icmp_snapshot(&app, &token, second).await;
        assert_eq!(other["state"], "tracing");
        assert_eq!(other["target"], "::1");
        if snapshot["state"] == "idle" {
            first_idle = true;
            assert!(snapshot["hops"][0]["received"].as_u64().unwrap_or(0) >= 1);
            break;
        }
    }
    assert!(first_idle, "cancelled trace did not become idle");

    let mut grew = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let other = icmp_snapshot(&app, &token, second).await;
        if other["hops"][0]["received"].as_u64().unwrap_or(0) > second_received {
            grew = true;
            break;
        }
    }
    assert!(
        grew,
        "the other trace stopped when its sibling was cancelled"
    );

    let resumed = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(Uuid::new_v4(), "127.0.0.1")),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(resumed.status(), StatusCode::OK);
    let resumed_id = response_json(resumed).await["id"]
        .as_str()
        .unwrap()
        .to_owned();

    for id in [second.to_string(), resumed_id] {
        let cancel = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/icmp/cancel",
                Some(json!({ "id": id })),
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(cancel.status(), StatusCode::NO_CONTENT);
    }
}

#[test]
fn path_mtu_search_shares_the_two_trace_cap() {
    let (state, _) = test_app(false, 48_732);
    let first = state.try_begin_mtu().expect("first slot");
    let second = state.try_begin_mtu().expect("second slot");
    match state.try_begin_mtu() {
        Err(error) => assert_eq!(error.code, "busy"),
        Ok(permit) => {
            drop(permit);
            panic!("a third path MTU search must be busy");
        }
    }
    drop(first);
    let freed = state.try_begin_mtu().expect("freed slot");
    drop(second);
    drop(freed);
}

#[tokio::test]
async fn icmp_path_mtu_accepts_loopback_and_rejects_metadata() {
    let (state, app) = test_app(true, 48_732);
    let http_only = pair_capabilities(&state, &app, json!(["http.request"])).await;
    let http_token = http_only["token"].as_str().unwrap();
    let denied = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/mtu",
            Some(json!({"target": "127.0.0.1", "timeoutMs": 1000})),
            Some(http_token),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(response_json(denied).await["error"]["code"], "forbidden");

    let paired = pair_capabilities(&state, &app, json!(["icmp.trace"])).await;
    let token = paired["token"].as_str().unwrap().to_owned();
    let metadata = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/mtu",
            Some(json!({"target": "169.254.169.254", "timeoutMs": 1000})),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(metadata).await["error"]["code"],
        "target_denied"
    );

    for (target, payload) in [("127.0.0.1", 1472), ("::1", 1452)] {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/icmp/mtu",
                Some(json!({"target": target, "timeoutMs": 1000})),
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{target}");
        let body = response_json(response).await;
        assert_eq!(body["status"], "found", "{target}");
        assert_eq!(body["target"], target, "{target}");
        assert_eq!(body["mtu"], 1500, "{target}");
        assert_eq!(body["payloadBytes"], payload, "{target}");
        assert_eq!(body["atCeiling"], true, "{target}");
        assert!(body["minimumMtu"].is_null(), "{target}");
        assert!(body["sourceAddress"].is_null(), "{target}");
        assert!(body["sourceInterface"].is_null(), "{target}");
    }
}

#[tokio::test]
async fn icmp_source_lists_local_addresses_and_binds_loopback() {
    let (state, app) = test_app(true, 48_732);
    let http_only = pair_capabilities(&state, &app, json!(["http.request"])).await;
    let http_token = http_only["token"].as_str().unwrap();
    let denied = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/icmp/interfaces",
            None,
            Some(http_token),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(response_json(denied).await["error"]["code"], "forbidden");

    let paired = pair_capabilities(&state, &app, json!(["icmp.trace"])).await;
    let token = paired["token"].as_str().unwrap().to_owned();
    let first = state.try_begin_mtu().expect("first slot");
    let second = state.try_begin_mtu().expect("second slot");
    let listed = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/icmp/interfaces",
            None,
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    drop(first);
    drop(second);
    let listed = response_json(listed).await;
    let interfaces = listed["interfaces"].as_array().expect("interfaces");
    let v4 = interfaces
        .iter()
        .find(|item| item["address"] == "127.0.0.1")
        .expect("loopback v4");
    let v4_name = v4["name"].as_str().unwrap().to_owned();
    let v6_name = interfaces
        .iter()
        .find(|item| item["address"] == "::1")
        .expect("loopback v6")["name"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut one_sided = trace_input(Uuid::new_v4(), "127.0.0.1");
    one_sided["sourceAddress"] = json!("127.0.0.1");
    let one_sided = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(one_sided),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(one_sided.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(one_sided).await["error"]["code"],
        "invalid_request"
    );

    let mut missing = trace_input(Uuid::new_v4(), "127.0.0.1");
    missing["sourceAddress"] = json!("203.0.113.5");
    missing["sourceInterface"] = json!("lo");
    let missing = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(missing),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(missing).await["error"]["code"],
        "source_unavailable"
    );

    let mut family = trace_input(Uuid::new_v4(), "127.0.0.1");
    family["sourceAddress"] = json!("::1");
    family["sourceInterface"] = json!(v6_name);
    let family = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(family),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(family.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(family).await["error"]["code"],
        "source_unavailable"
    );

    let id = Uuid::new_v4();
    let mut sourced = trace_input(id, "127.0.0.1");
    sourced["sourceAddress"] = json!("127.0.0.1");
    sourced["sourceInterface"] = json!(v4_name);
    let started = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(sourced),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(started.status(), StatusCode::OK);
    let started = response_json(started).await;
    assert_eq!(started["sourceAddress"], "127.0.0.1");
    assert_eq!(started["sourceInterface"], v4_name);

    let mut received = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let snapshot = icmp_snapshot(&app, &token, id).await;
        if snapshot["hops"][0]["received"].as_u64().unwrap_or(0) >= 1 {
            received = true;
            assert_eq!(snapshot["sourceAddress"], "127.0.0.1");
            break;
        }
    }
    assert!(received, "sourced loopback echo was not recorded");
    let cancel = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/cancel",
            Some(json!({ "id": id.to_string() })),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(cancel.status(), StatusCode::NO_CONTENT);

    let mtu = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/mtu",
            Some(json!({
                "target": "127.0.0.1",
                "timeoutMs": 1000,
                "sourceAddress": "127.0.0.1",
                "sourceInterface": v4_name,
            })),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(mtu.status(), StatusCode::OK);
    let mtu = response_json(mtu).await;
    assert_eq!(mtu["status"], "found");
    assert_eq!(mtu["mtu"], 1500);
    assert_eq!(mtu["payloadBytes"], 1472);
    assert_eq!(mtu["atCeiling"], true);
    assert_eq!(mtu["sourceAddress"], "127.0.0.1");
    assert_eq!(mtu["sourceInterface"], v4_name);
}

#[tokio::test]
async fn dns_lookup_is_a_separate_capability_and_uses_the_system_resolver() {
    let (state, app) = test_app(false, 48_732);

    let http_only = pair_capabilities(&state, &app, json!(["http.request"])).await;
    let denied = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/dns/lookup",
            Some(json!({"name": "example.com", "type": "A"})),
            Some(http_only["token"].as_str().unwrap()),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let icmp_only = pair_capabilities(&state, &app, json!(["icmp.trace"])).await;
    let denied_icmp = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/dns/lookup",
            Some(json!({"name": "example.com", "type": "A"})),
            Some(icmp_only["token"].as_str().unwrap()),
        ))
        .await
        .unwrap();
    assert_eq!(denied_icmp.status(), StatusCode::FORBIDDEN);

    let dns_only = pair_capabilities(&state, &app, json!(["dns.lookup"])).await;
    assert_eq!(dns_only["capabilities"], json!(["dns.lookup"]));
    let token = dns_only["token"].as_str().unwrap();
    let denied_http = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/http/request",
            Some(json!({})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(denied_http.status(), StatusCode::FORBIDDEN);
    let denied_trace = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/icmp/trace",
            Some(trace_input(Uuid::new_v4(), "127.0.0.1")),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(denied_trace.status(), StatusCode::FORBIDDEN);

    for body in [
        json!({"name": "example.com", "type": "ANY"}),
        json!({"name": "http://example.com", "type": "A"}),
        json!({"name": "127.0.0.1", "type": "A"}),
        json!({"name": "example.com", "type": "A", "server": "1.1.1.1"}),
    ] {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/dns/lookup",
                Some(body),
                Some(token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "invalid_request"
        );
    }

    let ptr = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/dns/lookup",
            Some(json!({"name": "127.0.0.1", "type": "PTR"})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(ptr.status(), StatusCode::OK);
    let ptr = response_json(ptr).await;
    assert_eq!(ptr["name"], "1.0.0.127.in-addr.arpa");
    assert_eq!(ptr["type"], "PTR");
    assert!(ptr["status"] == "noerror" || ptr["status"] == "nodata" || ptr["status"] == "nxdomain");

    let answer = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/dns/lookup",
            Some(json!({"name": "example.com", "type": "A"})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(answer.status(), StatusCode::OK);
    let answer = response_json(answer).await;
    assert_eq!(answer["name"], "example.com");
    assert_eq!(answer["type"], "A");
    assert_eq!(answer["status"], "noerror");
    let records = answer["records"].as_array().expect("records");
    assert!(records.iter().any(|record| {
        record["type"] == "A"
            && record["data"]
                .as_str()
                .is_some_and(|ip| ip.parse::<IpAddr>().is_ok())
    }));
}

#[tokio::test]
async fn tcp_connect_is_one_port_and_a_separate_capability() {
    let (state, app) = test_app(true, 48_732);

    for capabilities in [
        json!(["http.request"]),
        json!(["icmp.trace"]),
        json!(["dns.lookup"]),
    ] {
        let paired = pair_capabilities(&state, &app, capabilities).await;
        let denied = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/tcp/connect",
                Some(json!({"host": "127.0.0.1", "port": 9, "timeoutMs": 3000})),
                Some(paired["token"].as_str().unwrap()),
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    let tcp_only = pair_capabilities(&state, &app, json!(["tcp.connect"])).await;
    assert_eq!(tcp_only["capabilities"], json!(["tcp.connect"]));
    let token = tcp_only["token"].as_str().unwrap();
    for (path, body) in [
        ("/v1/http/request", json!({})),
        ("/v1/icmp/trace", trace_input(Uuid::new_v4(), "127.0.0.1")),
        (
            "/v1/dns/lookup",
            json!({"name": "example.com", "type": "A"}),
        ),
    ] {
        let denied = app
            .clone()
            .oneshot(request(Method::POST, path, Some(body), Some(token)))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    for body in [
        json!({"host": "127.0.0.1", "port": 0, "timeoutMs": 3000}),
        json!({"host": "127.0.0.1:80", "port": 80, "timeoutMs": 3000}),
        json!({"host": "80-90", "port": 80, "timeoutMs": 3000}),
        json!({"host": "10.0.0.0/8", "port": 80, "timeoutMs": 3000}),
        json!({"host": "example.com,example.org", "port": 80, "timeoutMs": 3000}),
        json!({"host": "127.0.0.1", "port": 80, "timeoutMs": 50}),
        json!({"host": "127.0.0.1", "port": 80, "timeoutMs": 3000, "ports": [81, 443]}),
    ] {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/tcp/connect",
                Some(body),
                Some(token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "invalid_request"
        );
    }

    let metadata = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tcp/connect",
            Some(json!({"host": "169.254.169.254", "port": 80, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(metadata).await["error"]["code"],
        "target_denied"
    );

    let self_port = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tcp/connect",
            Some(json!({"host": "127.0.0.1", "port": 48732, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(self_port.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(self_port).await["error"]["code"],
        "target_denied"
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let open_port = listener.local_addr().expect("port").port();
    assert_ne!(open_port, 48_732);
    let opened = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tcp/connect",
            Some(json!({"host": "127.0.0.1", "port": open_port, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let opened = response_json(opened).await;
    assert_eq!(opened["host"], "127.0.0.1");
    assert_eq!(opened["port"], open_port);
    assert_eq!(opened["address"], "127.0.0.1");
    assert_eq!(opened["status"], "open");
    assert!(opened["elapsedMs"].as_u64().is_some());
    drop(listener);

    let (_held, closed_port) = held_closed_port();
    let refused = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tcp/connect",
            Some(json!({"host": "127.0.0.1", "port": closed_port, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::OK);
    let refused = response_json(refused).await;
    assert_eq!(refused["status"], "refused");
    assert_eq!(refused["address"], "127.0.0.1");

    let (closed, closed_app) = test_app(false, 48_732);
    let closed_pair = pair_capabilities(&closed, &closed_app, json!(["tcp.connect"])).await;
    let private = closed_app
        .oneshot(request(
            Method::POST,
            "/v1/tcp/connect",
            Some(json!({"host": "127.0.0.1", "port": 9, "timeoutMs": 3000})),
            Some(closed_pair["token"].as_str().unwrap()),
        ))
        .await
        .unwrap();
    assert_eq!(private.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(private).await["error"]["code"],
        "private_network_denied"
    );
}

#[tokio::test]
async fn tls_inspect_is_one_handshake_and_a_separate_capability() {
    let (state, app) = test_app(true, 48_732);

    for capabilities in [
        json!(["http.request"]),
        json!(["icmp.trace"]),
        json!(["dns.lookup"]),
        json!(["tcp.connect"]),
    ] {
        let paired = pair_capabilities(&state, &app, capabilities).await;
        let denied = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/tls/inspect",
                Some(json!({"host": "127.0.0.1", "port": 9, "timeoutMs": 3000})),
                Some(paired["token"].as_str().unwrap()),
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    let tls_only = pair_capabilities(&state, &app, json!(["tls.inspect"])).await;
    assert_eq!(tls_only["capabilities"], json!(["tls.inspect"]));
    let token = tls_only["token"].as_str().unwrap();
    for (path, body) in [
        ("/v1/http/request", json!({})),
        ("/v1/icmp/trace", trace_input(Uuid::new_v4(), "127.0.0.1")),
        (
            "/v1/dns/lookup",
            json!({"name": "example.com", "type": "A"}),
        ),
        (
            "/v1/tcp/connect",
            json!({"host": "127.0.0.1", "port": 9, "timeoutMs": 3000}),
        ),
    ] {
        let denied = app
            .clone()
            .oneshot(request(Method::POST, path, Some(body), Some(token)))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    for body in [
        json!({"host": "127.0.0.1", "port": 0, "timeoutMs": 3000}),
        json!({"host": "127.0.0.1:443", "port": 443, "timeoutMs": 3000}),
        json!({"host": "80-443", "port": 443, "timeoutMs": 3000}),
        json!({"host": "10.0.0.0/8", "port": 443, "timeoutMs": 3000}),
        json!({"host": "127.0.0.1", "port": 443, "timeoutMs": 50}),
        json!({"host": "127.0.0.1", "port": 443, "timeoutMs": 3000, "pem": "-----BEGIN CERTIFICATE-----"}),
    ] {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/tls/inspect",
                Some(body),
                Some(token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "invalid_request"
        );
    }

    let metadata = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tls/inspect",
            Some(json!({"host": "169.254.169.254", "port": 443, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(metadata).await["error"]["code"],
        "target_denied"
    );

    let self_port = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tls/inspect",
            Some(json!({"host": "127.0.0.1", "port": 48732, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(self_port.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(self_port).await["error"]["code"],
        "target_denied"
    );

    let (listen_port, server) = spawn_test_tls().await;
    assert_ne!(listen_port, 48_732);
    let opened = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tls/inspect",
            Some(json!({"host": "127.0.0.1", "port": listen_port, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let opened = response_json(opened).await;
    assert_eq!(opened["host"], "127.0.0.1");
    assert_eq!(opened["port"], listen_port);
    assert_eq!(opened["address"], "127.0.0.1");
    assert_eq!(opened["status"], "ok");
    assert!(
        opened["protocol"]
            .as_str()
            .is_some_and(|value| value.starts_with("TLS"))
    );
    assert!(
        opened["cipher"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(opened["trusted"], false);
    let certificates = opened["certificates"].as_array().expect("chain");
    assert!(!certificates.is_empty());
    assert!(
        certificates[0]["subject"]
            .as_str()
            .is_some_and(|subject| subject.contains("localhost"))
    );
    assert!(
        certificates[0]["notAfter"]
            .as_str()
            .is_some_and(|expiry| expiry.ends_with('Z'))
    );
    assert_eq!(certificates[0]["sha256"].as_str().map(str::len), Some(64));
    server.abort();

    let (_held, closed_port) = held_closed_port();
    let refused = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/tls/inspect",
            Some(json!({"host": "127.0.0.1", "port": closed_port, "timeoutMs": 3000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::OK);
    assert_eq!(response_json(refused).await["status"], "refused");

    let (closed, closed_app) = test_app(false, 48_732);
    let closed_pair = pair_capabilities(&closed, &closed_app, json!(["tls.inspect"])).await;
    let private = closed_app
        .oneshot(request(
            Method::POST,
            "/v1/tls/inspect",
            Some(json!({"host": "127.0.0.1", "port": 9, "timeoutMs": 3000})),
            Some(closed_pair["token"].as_str().unwrap()),
        ))
        .await
        .unwrap();
    assert_eq!(private.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(private).await["error"]["code"],
        "private_network_denied"
    );
}

/// A loopback port that refuses connections and stays reserved while the socket lives:
/// bound without `listen`, so parallel tests cannot pick it up the way they can a dropped listener's.
fn held_closed_port() -> (tokio::net::TcpSocket, u16) {
    let socket = tokio::net::TcpSocket::new_v4().expect("socket");
    socket
        .bind("127.0.0.1:0".parse().expect("address"))
        .expect("bind");
    let port = socket.local_addr().expect("address").port();
    (socket, port)
}

async fn spawn_test_tls() -> (u16, tokio::task::JoinHandle<()>) {
    use std::process::Command;

    use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
    use tokio_rustls::TlsAcceptor;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = std::env::temp_dir().join(format!("mdt-tls-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let key_path = dir.join("key.pem");
    let cert_path = dir.join("cert.pem");
    let status = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-keyout",
            key_path.to_str().expect("key path"),
            "-out",
            cert_path.to_str().expect("cert path"),
            "-days",
            "2",
            "-nodes",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
        ])
        .status()
        .expect("openssl");
    assert!(status.success(), "openssl certificate");
    let cert = CertificateDer::from_pem_slice(&std::fs::read(&cert_path).expect("cert"))
        .expect("cert pem");
    let key =
        PrivateKeyDer::from_pem_slice(&std::fs::read(&key_path).expect("key")).expect("key pem");
    let _ = std::fs::remove_dir_all(&dir);
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .expect("server config");
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("tls listener");
    let port = listener.local_addr().expect("port").port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let _ = acceptor.accept(stream).await;
            });
        }
    });
    (port, task)
}

#[tokio::test]
async fn whois_lookup_is_one_query_on_port_43_and_a_separate_capability() {
    let (state, app) = test_app(true, 48_732);

    for capabilities in [
        json!(["http.request"]),
        json!(["icmp.trace"]),
        json!(["dns.lookup"]),
        json!(["tcp.connect"]),
        json!(["tls.inspect"]),
        json!(["asn.lookup"]),
    ] {
        let paired = pair_capabilities(&state, &app, capabilities).await;
        let denied = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/whois/lookup",
                Some(json!({"query": "example.com", "server": "127.0.0.1", "timeoutMs": 1000})),
                Some(paired["token"].as_str().unwrap()),
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    let whois_only = pair_capabilities(&state, &app, json!(["whois.lookup"])).await;
    assert_eq!(whois_only["capabilities"], json!(["whois.lookup"]));
    let token = whois_only["token"].as_str().unwrap();
    for (path, body) in [
        ("/v1/http/request", json!({})),
        ("/v1/icmp/trace", trace_input(Uuid::new_v4(), "127.0.0.1")),
        (
            "/v1/dns/lookup",
            json!({"name": "example.com", "type": "A"}),
        ),
        (
            "/v1/tcp/connect",
            json!({"host": "127.0.0.1", "port": 9, "timeoutMs": 3000}),
        ),
        (
            "/v1/tls/inspect",
            json!({"host": "127.0.0.1", "port": 443, "timeoutMs": 3000}),
        ),
        ("/v1/asn/lookup", json!({"query": "1.1.1.1"})),
    ] {
        let denied = app
            .clone()
            .oneshot(request(Method::POST, path, Some(body), Some(token)))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    for body in [
        json!({"query": "", "server": "whois.iana.org", "timeoutMs": 3000}),
        json!({"query": "example.com\nexample.org", "server": "whois.iana.org", "timeoutMs": 3000}),
        json!({"query": "80-443", "server": "whois.iana.org", "timeoutMs": 3000}),
        json!({"query": "example.com", "server": "whois.iana.org:43", "timeoutMs": 3000}),
        json!({"query": "example.com", "server": "whois.iana.org", "timeoutMs": 50}),
        json!({"query": "example.com", "server": "whois.iana.org", "timeoutMs": 3000, "port": 43}),
    ] {
        let rejected = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/whois/lookup",
                Some(body),
                Some(token),
            ))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(rejected).await["error"]["code"],
            "invalid_request"
        );
    }

    let metadata = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/whois/lookup",
            Some(json!({"query": "example.com", "server": "169.254.169.254", "timeoutMs": 1000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(metadata).await["error"]["code"],
        "target_denied"
    );

    let dialed = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/whois/lookup",
            Some(json!({"query": "example.com", "server": "127.0.0.1", "timeoutMs": 1000})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(dialed.status(), StatusCode::OK);
    let dialed = response_json(dialed).await;
    assert_eq!(dialed["status"], "refused");
    assert_eq!(dialed["port"], 43);
    assert_eq!(dialed["text"], "");
    assert_eq!(dialed["truncated"], false);

    let (closed, closed_app) = test_app(false, 48_732);
    let closed_pair = pair_capabilities(&closed, &closed_app, json!(["whois.lookup"])).await;
    let private_denied = closed_app
        .oneshot(request(
            Method::POST,
            "/v1/whois/lookup",
            Some(json!({"query": "example.com", "server": "127.0.0.1", "timeoutMs": 1000})),
            Some(closed_pair["token"].as_str().unwrap()),
        ))
        .await
        .unwrap();
    assert_eq!(private_denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(private_denied).await["error"]["code"],
        "private_network_denied"
    );

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("whois listener");
    let port = listener.local_addr().expect("port").port();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 64];
        loop {
            let n = socket.read(&mut tmp).await.expect("read query");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(2).any(|pair| pair == b"\r\n") {
                break;
            }
        }
        assert_eq!(buf, b"example.com\r\n");
        socket
            .write_all(b"domain: example.com\r\n")
            .await
            .expect("reply");
    });
    let prepared = crate::whois::prepare(" example.com ", "127.0.0.1", 3_000).expect("prepare");
    let response = crate::whois::lookup_on_port(prepared, 48_732, true, port)
        .await
        .expect("lookup");
    assert_eq!(response.status, "ok");
    assert_eq!(response.port, port);
    assert!(!response.truncated);
    assert!(response.text.contains("example.com"));
    task.await.expect("listener");

    let prepared = crate::whois::prepare("example.com", "127.0.0.1", 1_000).expect("prepare");
    let closed_port = crate::whois::lookup_on_port(prepared, 48_732, true, port)
        .await
        .expect("refused");
    assert_eq!(closed_port.status, "refused");
    assert!(closed_port.text.is_empty());
    assert!(!closed_port.truncated);
}

/// whois.iana.org and whois.kg drop the reply when the client half-closes after the
/// query line, so the agent must keep its write side open until the server closes.
#[tokio::test]
async fn whois_reply_arrives_from_servers_that_drop_half_closed_clients() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("whois listener");
    let port = listener.local_addr().expect("port").port();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 64];
        while !buf.windows(2).any(|pair| pair == b"\r\n") {
            let n = socket.read(&mut tmp).await.expect("read query");
            assert!(n > 0, "query line before EOF");
            buf.extend_from_slice(&tmp[..n]);
        }
        let after = tokio::time::timeout(Duration::from_millis(300), socket.read(&mut tmp)).await;
        if matches!(after, Ok(Ok(0))) {
            return;
        }
        socket
            .write_all(b"refer: whois.kg\r\ndomain: KG\r\n")
            .await
            .expect("reply");
    });
    let prepared = crate::whois::prepare("ogogo.kg", "127.0.0.1", 3_000).expect("prepare");
    let response = crate::whois::lookup_on_port(prepared, 48_732, true, port)
        .await
        .expect("lookup");
    assert_eq!(response.status, "ok");
    assert!(
        response.text.contains("refer: whois.kg"),
        "reply text: {:?}",
        response.text
    );
    task.await.expect("listener");
}

#[tokio::test]
async fn asn_lookup_uses_the_local_prefix_table_and_a_separate_capability() {
    let (state, app) = test_app(false, 48_732);

    for capabilities in [
        json!(["http.request"]),
        json!(["icmp.trace"]),
        json!(["dns.lookup"]),
        json!(["tcp.connect"]),
        json!(["tls.inspect"]),
        json!(["whois.lookup"]),
    ] {
        let paired = pair_capabilities(&state, &app, capabilities).await;
        let denied = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/asn/lookup",
                Some(json!({"query": "1.1.1.1"})),
                Some(paired["token"].as_str().unwrap()),
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    let asn_only = pair_capabilities(&state, &app, json!(["asn.lookup"])).await;
    assert_eq!(asn_only["capabilities"], json!(["asn.lookup"]));
    let token = asn_only["token"].as_str().unwrap();
    for (path, body) in [
        ("/v1/http/request", json!({})),
        ("/v1/icmp/trace", trace_input(Uuid::new_v4(), "127.0.0.1")),
        (
            "/v1/dns/lookup",
            json!({"name": "example.com", "type": "A"}),
        ),
        (
            "/v1/tcp/connect",
            json!({"host": "127.0.0.1", "port": 9, "timeoutMs": 3000}),
        ),
        (
            "/v1/tls/inspect",
            json!({"host": "127.0.0.1", "port": 443, "timeoutMs": 3000}),
        ),
        (
            "/v1/whois/lookup",
            json!({"query": "example.com", "server": "whois.iana.org", "timeoutMs": 3000}),
        ),
    ] {
        let denied = app
            .clone()
            .oneshot(request(Method::POST, path, Some(body), Some(token)))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    for body in [
        json!({"query": "example.com"}),
        json!({"query": "http://1.1.1.1"}),
        json!({"query": "1.1.1.1-1.1.1.2"}),
        json!({"query": ""}),
        json!({"query": "1.1.1.1", "port": 43}),
        json!({"query": "1.1.1.1", "server": "example.com"}),
        json!({"query": "1.1.1.1", "timeoutMs": 1000}),
    ] {
        let rejected = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/asn/lookup",
                Some(body),
                Some(token),
            ))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(rejected).await["error"]["code"],
            "invalid_request"
        );
    }

    let found = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/asn/lookup",
            Some(json!({"query": "1.1.1.1"})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(found.status(), StatusCode::OK);
    let found = response_json(found).await;
    assert_eq!(found["status"], "found");
    assert_eq!(found["asn"], 13335);
    assert_eq!(found["name"], "CLOUDFLARENET");
    assert_eq!(found["prefix"], "1.1.1.0/24");
    assert_eq!(found["covers"], true);
    assert_eq!(found["address"], "1.1.1.1");

    let reserved = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/asn/lookup",
            Some(json!({"query": "127.0.0.1"})),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(reserved.status(), StatusCode::OK);
    let reserved = response_json(reserved).await;
    assert_eq!(reserved["status"], "reserved");
    assert_eq!(reserved["asn"], serde_json::Value::Null);
    assert_eq!(reserved["prefix"], serde_json::Value::Null);
    assert_eq!(reserved["name"], "");
    assert_eq!(reserved["covers"], false);
}

const SECOND_ORIGIN: &str = "http://127.0.0.1:3312";

pub(super) struct TempDir(pub(super) std::path::PathBuf);

impl TempDir {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdt-vault-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn vault_app(
    allow_private: bool,
    data_dir: Option<std::path::PathBuf>,
) -> (Arc<AgentState>, Router) {
    let state = AgentState::new(AgentConfig {
        port: 48_732,
        allow_private,
        allowed_origins: HashSet::from([ORIGIN.to_owned(), SECOND_ORIGIN.to_owned()]),
        data_dir,
    });
    let app = server::router(Arc::clone(&state));
    (state, app)
}

pub(super) fn origin_request(
    origin: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
    token: &str,
) -> Request<Body> {
    let mut request = request(method, path, body, Some(token));
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    request
}

pub(super) async fn pair_from(
    state: &AgentState,
    app: &Router,
    origin: &str,
    capabilities: Value,
) -> String {
    state.replace_pairing_code([0x11; 16]);
    let mut pair = request(
        Method::POST,
        "/v1/pair",
        Some(json!({"code": PAIRING_CODE, "capabilities": capabilities})),
        None,
    );
    pair.headers_mut().insert("origin", origin.parse().unwrap());
    let response = app.clone().oneshot(pair).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

pub(super) async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    let json = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    (status, json)
}

pub(super) fn vault_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(vault_files(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[tokio::test]
async fn vault_documents_are_encrypted_revisioned_and_isolated_per_origin() {
    let (state, app) = vault_app(false, None);
    let info = call(&app, request(Method::GET, "/v1/info", None, None))
        .await
        .1;
    assert_eq!(info["vaultAvailable"], false);
    let token = pair_from(&state, &app, ORIGIN, json!(["vault.data"])).await;
    let (status, body) = call(
        &app,
        origin_request(ORIGIN, Method::GET, "/v1/vault/documents", None, &token),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "vault_unavailable");

    let dir = TempDir::new();
    let (state, app) = vault_app(false, Some(dir.0.clone()));
    let info = call(&app, request(Method::GET, "/v1/info", None, None))
        .await
        .1;
    assert_eq!(info["vaultAvailable"], true);

    let http_only = pair_from(&state, &app, ORIGIN, json!(["http.request"])).await;
    for (method, path, body) in [
        (Method::GET, "/v1/vault/documents", None),
        (
            Method::POST,
            "/v1/vault/document/read",
            Some(json!({"name": "http-workspace"})),
        ),
        (Method::GET, "/v1/vault/secrets", None),
    ] {
        let (status, _) = call(&app, origin_request(ORIGIN, method, path, body, &http_only)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
    }

    let token = pair_from(&state, &app, ORIGIN, json!(["vault.data"])).await;
    let (status, _) = call(
        &app,
        origin_request(ORIGIN, Method::GET, "/v1/vault/secrets", None, &token),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "vault.data must not open secrets"
    );

    let write = |base: u64, marker: &str| {
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/document/write",
            Some(
                json!({"name": "http-workspace", "baseRevision": base, "data": {"marker": marker}}),
            ),
            &token,
        )
    };
    let (status, body) = call(&app, write(0, "plaintext-marker-one")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], 1);
    let (status, body) = call(&app, write(0, "stale")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "revision_conflict");
    let (status, body) = call(&app, write(1, "plaintext-marker-two")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], 2);

    let (status, body) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/document/read",
            Some(json!({"name": "http-workspace"})),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], 2);
    assert_eq!(body["data"]["marker"], "plaintext-marker-two");

    for name in ["../escape", "Upper", "", "a/b", &"x".repeat(65)] {
        let (status, _) = call(
            &app,
            origin_request(
                ORIGIN,
                Method::POST,
                "/v1/vault/document/read",
                Some(json!({"name": name})),
                &token,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }

    for file in vault_files(&dir.0) {
        let bytes = std::fs::read(&file).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains("plaintext-marker"),
            "{} holds plaintext",
            file.display()
        );
    }

    // The development origin has its own directory and does not see this data.
    let second = pair_from(&state, &app, SECOND_ORIGIN, json!(["vault.data"])).await;
    let (status, body) = call(
        &app,
        origin_request(
            SECOND_ORIGIN,
            Method::GET,
            "/v1/vault/documents",
            None,
            &second,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["documents"], json!([]));

    let (status, body) = call(
        &app,
        origin_request(ORIGIN, Method::GET, "/v1/vault/documents", None, &token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["documents"][0]["name"], "http-workspace");
    assert_eq!(body["documents"][0]["revision"], 2);

    // A file copied under another name fails authentication.
    let (status, _) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/document/write",
            Some(json!({"name": "other", "baseRevision": 0, "data": 1})),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let workspace_file = vault_files(&dir.0)
        .into_iter()
        .find(|path| path.ends_with("doc-http-workspace.mdtv"))
        .unwrap();
    let other_file = workspace_file.with_file_name("doc-other.mdtv");
    std::fs::copy(&workspace_file, &other_file).unwrap();
    let (status, body) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/document/read",
            Some(json!({"name": "other"})),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["error"]["code"], "vault_corrupt");
    std::fs::remove_file(&other_file).unwrap();

    let delete = |base: u64| {
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/document/delete",
            Some(json!({"name": "http-workspace", "baseRevision": base})),
            &token,
        )
    };
    assert_eq!(call(&app, delete(1)).await.0, StatusCode::CONFLICT);
    assert_eq!(call(&app, delete(2)).await.0, StatusCode::NO_CONTENT);
    let (status, _) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/document/read",
            Some(json!({"name": "http-workspace"})),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A lost key is reported; a fresh key never replaces existing ciphertext.
    let (status, _) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/document/write",
            Some(json!({"name": "keep", "baseRevision": 0, "data": true})),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let key = vault_files(&dir.0)
        .into_iter()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("key."))
        })
        .unwrap();
    std::fs::remove_file(&key).unwrap();
    let (state, app) = vault_app(false, Some(dir.0.clone()));
    let token = pair_from(&state, &app, ORIGIN, json!(["vault.data"])).await;
    let (status, body) = call(
        &app,
        origin_request(ORIGIN, Method::GET, "/v1/vault/documents", None, &token),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "vault_key_unavailable");
    assert!(!key.exists());
}

/// Accepts `count` connections in turn. Each reply is either the redirect or
/// an echo of the raw request; the raw request is also sent to the test.
async fn spawn_echo(
    count: usize,
    redirect_to: Option<String>,
) -> (
    std::net::SocketAddr,
    tokio::sync::mpsc::UnboundedReceiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for _ in 0..count {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received).to_ascii_lowercase();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let text = String::from_utf8_lossy(&received).into_owned();
            let _ = tx.send(text.clone());
            let response = match &redirect_to {
                Some(location) => format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                ),
                None => format!(
                    "HTTP/1.1 200 OK\r\nX-Echo: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.lines()
                        .find(|line| line.to_ascii_lowercase().starts_with("x-api-key:"))
                        .unwrap_or(""),
                    text.len()
                ),
            };
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address, rx, task)
}

#[tokio::test]
async fn secrets_are_write_only_host_bound_and_redacted_from_echoes() {
    let dir = TempDir::new();
    let (state, app) = vault_app(true, Some(dir.0.clone()));
    let token = pair_from(
        &state,
        &app,
        ORIGIN,
        json!(["http.request", "vault.secrets"]),
    )
    .await;
    let secret = "sk-live-0123456789abcdef";
    let write_secret = |name: &str, value: Option<&str>, hosts: Value| {
        let mut body = json!({"name": name, "hosts": hosts});
        if let Some(value) = value {
            body["value"] = json!(value);
        }
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/vault/secret/write",
            Some(body),
            &token,
        )
    };
    assert_eq!(
        call(
            &app,
            write_secret("apiToken", Some(secret), json!(["127.0.0.1"]))
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            write_secret(
                "remoteOnly",
                Some("remote-value-123"),
                json!(["api.example.com"])
            )
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    for (value, hosts) in [
        (Some("line\r\nbreak"), json!(["127.0.0.1"])),
        (Some(""), json!(["127.0.0.1"])),
        (Some("ok-value"), json!([])),
        (Some("ok-value"), json!(["*.com"])),
    ] {
        assert_eq!(
            call(&app, write_secret("bad", value, hosts)).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        call(&app, write_secret("missing", None, json!(["127.0.0.1"])))
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    let (status, listed) = call(
        &app,
        origin_request(ORIGIN, Method::GET, "/v1/vault/secrets", None, &token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["secrets"][0]["name"], "apiToken");
    assert_eq!(listed["secrets"][0]["hosts"], json!(["127.0.0.1"]));
    assert!(listed["secrets"][0].get("value").is_none());
    assert!(!listed.to_string().contains(secret));
    for file in vault_files(&dir.0) {
        assert!(!String::from_utf8_lossy(&std::fs::read(file).unwrap()).contains(secret));
    }

    // The agent substitutes in URL, headers and body, and redacts the echo.
    let (address, mut received, server) = spawn_echo(1, None).await;
    let mut input = http_input(
        Uuid::new_v4(),
        format!("http://{address}/echo?key={{{{secret:apiToken}}}}"),
        false,
    );
    input["method"] = json!("POST");
    input["headers"] = json!([{"name": "X-Api-Key", "value": "{{secret:apiToken}}"}]);
    input["bodyBase64"] = json!(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        b"{\"token\":\"{{secret:apiToken}}\"}"
    ));
    let (status, response) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/http/request",
            Some(input.clone()),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let wire = received.recv().await.unwrap();
    assert!(wire.contains(&format!("/echo?key={secret}")));
    assert!(
        wire.to_ascii_lowercase()
            .contains(&format!("x-api-key: {secret}"))
    );
    assert!(wire.contains(&format!("{{\"token\":\"{secret}\"}}")));
    server.await.unwrap();
    let echoed = String::from_utf8(
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            response["bodyBase64"].as_str().unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!response.to_string().contains(secret));
    assert!(!echoed.contains(secret));
    assert!(echoed.contains("{{secret:apiToken}}"));
    let echo_header = response["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|header| header["name"] == "x-echo")
        .unwrap();
    assert!(
        echo_header["value"]
            .as_str()
            .unwrap()
            .contains("{{secret:apiToken}}")
    );

    // Basic credentials are encoded after substitution; the echo shows the template.
    let (basic_address, mut basic_received, basic_server) = spawn_echo(1, None).await;
    let mut basic = http_input(
        Uuid::new_v4(),
        format!("http://{basic_address}/basic"),
        false,
    );
    basic["basicAuth"] = json!({"username": "alice", "password": "{{secret:apiToken}}"});
    let (status, response) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/http/request",
            Some(basic.clone()),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let encode =
        |text: &str| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text);
    let real = encode(&format!("alice:{secret}"));
    let wire = basic_received.recv().await.unwrap();
    assert!(wire.contains(&format!("basic {real}")) || wire.contains(&format!("Basic {real}")));
    basic_server.await.unwrap();
    let echoed = String::from_utf8(
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            response["bodyBase64"].as_str().unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!response.to_string().contains(&real));
    assert!(echoed.contains(&encode("alice:{{secret:apiToken}}")));
    basic["id"] = json!(Uuid::new_v4().to_string());
    basic["headers"] = json!([{"name": "authorization", "value": "Bearer x"}]);
    let (status, _) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/http/request",
            Some(basic),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Without `vault.secrets` the placeholder is refused, not sent literally.
    let http_only = pair_from(&state, &app, ORIGIN, json!(["http.request"])).await;
    let (status, _) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/http/request",
            Some(input.clone()),
            &http_only,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let mut wrong_host = input.clone();
    wrong_host["id"] = json!(Uuid::new_v4().to_string());
    wrong_host["headers"] = json!([{"name": "X-Api-Key", "value": "{{secret:remoteOnly}}"}]);
    wrong_host["url"] = json!(format!("http://{address}/"));
    wrong_host["bodyBase64"] = json!("");
    let (status, body) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/http/request",
            Some(wrong_host.clone()),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "secret_host_denied");

    wrong_host["id"] = json!(Uuid::new_v4().to_string());
    wrong_host["headers"] = json!([{"name": "X-Api-Key", "value": "{{secret:nope}}"}]);
    let (status, body) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/http/request",
            Some(wrong_host),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "secret_not_found");

    // A redirect to a host outside the list is returned, not followed.
    let (outside, mut outside_received, outside_server) = spawn_echo(1, None).await;
    let (redirect, _, redirect_server) =
        spawn_echo(1, Some(format!("http://localhost:{}/next", outside.port()))).await;
    let mut redirected = http_input(Uuid::new_v4(), format!("http://{redirect}/start"), true);
    redirected["headers"] = json!([{"name": "X-Api-Key", "value": "{{secret:apiToken}}"}]);
    let (status, body) = call(
        &app,
        origin_request(
            ORIGIN,
            Method::POST,
            "/v1/http/request",
            Some(redirected),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], 307);
    redirect_server.await.unwrap();
    assert!(outside_received.try_recv().is_err());
    outside_server.abort();

    assert_eq!(
        call(
            &app,
            origin_request(
                ORIGIN,
                Method::POST,
                "/v1/vault/secret/delete",
                Some(json!({"name": "apiToken"})),
                &token
            )
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let listed = call(
        &app,
        origin_request(ORIGIN, Method::GET, "/v1/vault/secrets", None, &token),
    )
    .await
    .1;
    assert_eq!(listed["secrets"].as_array().unwrap().len(), 1);
    assert_eq!(listed["secrets"][0]["name"], "remoteOnly");
}
