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

const ORIGIN: &str = "https://mydevtools.app";
const PAIRING_CODE: &str = "11111111111111111111111111111111";

fn test_app(allow_private: bool, port: u16) -> (Arc<AgentState>, Router) {
    let state = AgentState::new(AgentConfig {
        port,
        allow_private,
        allowed_origins: HashSet::from([ORIGIN.to_owned()]),
    });
    assert_eq!(state.replace_pairing_code([0x11; 16]), PAIRING_CODE);
    let app = server::router(Arc::clone(&state));
    (state, app)
}

fn request(method: Method, path: &str, body: Option<Value>, token: Option<&str>) -> Request<Body> {
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

async fn response_json(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), 32 * 1024 * 1024)
        .await
        .expect("response body");
    serde_json::from_slice(&body).expect("JSON response")
}

async fn pair(app: &Router) -> String {
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

fn http_input(id: Uuid, url: String, follow_redirects: bool) -> Value {
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

async fn pair_capabilities(state: &AgentState, app: &Router, capabilities: Value) -> Value {
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
        json!(["http.request", "icmp.trace"])
    );

    for capabilities in [
        json!([]),
        json!(["http.request", "http.request"]),
        json!(["icmp.trace", "icmp.trace"]),
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
    }
}
