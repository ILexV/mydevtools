//! Event streams (`sse.stream`) and WebSockets (`websocket.connect`).

use std::convert::Infallible;

use axum::{
    Router,
    body::Body,
    http::{Method, StatusCode},
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, StreamBody};
use hyper::{body::Frame, server::conn, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{Request as HandshakeRequest, Response as HandshakeResponse},
    http::HeaderValue,
};
use tower::ServiceExt;
use uuid::Uuid;

use crate::security_tests::{http_input, pair_capabilities, request, response_json, test_app};

async fn call(app: &Router, path: &str, body: Value, token: &str) -> axum::response::Response {
    app.clone()
        .oneshot(request(Method::POST, path, Some(body), Some(token)))
        .await
        .unwrap()
}

fn events_input(id: Uuid, url: String) -> Value {
    let mut input = http_input(id, url, false);
    input["streamEvents"] = json!(true);
    input
}

/// Reads NDJSON lines from a streamed response body.
struct Lines {
    body: Body,
    buffer: Vec<u8>,
}

impl Lines {
    fn new(response: axum::response::Response) -> Self {
        assert_eq!(response.headers()["content-type"], "application/x-ndjson");
        Self {
            body: response.into_body(),
            buffer: Vec::new(),
        }
    }

    async fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();
                return Some(serde_json::from_slice(&line).unwrap());
            }
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), self.body.frame())
                .await
                .expect("line in time")?
                .unwrap();
            if let Ok(data) = frame.into_data() {
                self.buffer.extend_from_slice(&data);
            }
        }
    }
}

/// `/events` streams two events then waits for `/events?end` style closing:
/// `keep` stays open until the client goes away; anything else answers JSON.
async fn spawn_event_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let service = service_fn(
                    |request: hyper::Request<hyper::body::Incoming>| async move {
                        let keep = request.uri().query() == Some("keep");
                        if request.uri().path() != "/events" {
                            return Ok::<_, Infallible>(
                                hyper::Response::builder()
                                    .header("content-type", "application/json")
                                    .body(BodyExt::boxed(http_body_util::Full::new(
                                        Bytes::from_static(b"{\"plain\":true}"),
                                    )))
                                    .unwrap(),
                            );
                        }
                        let (sender, receiver) =
                            mpsc::channel::<Result<Frame<Bytes>, Infallible>>(4);
                        tokio::spawn(async move {
                            let _ = sender
                                .send(Ok(Frame::data(Bytes::from_static(b": hi\ndata: one\n\n"))))
                                .await;
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            let _ = sender
                                .send(Ok(Frame::data(Bytes::from_static(
                                    b"event: tick\nid: 2\ndata: {{secret}}\r\n\r\n",
                                ))))
                                .await;
                            if keep {
                                sender.closed().await;
                            }
                        });
                        let body = StreamBody::new(futures_util::stream::unfold(
                            receiver,
                            |mut receiver| async move {
                                receiver.recv().await.map(|frame| (frame, receiver))
                            },
                        ));
                        Ok(hyper::Response::builder()
                            .header("content-type", "text/event-stream; charset=utf-8")
                            .body(BodyExt::boxed(body))
                            .unwrap())
                    },
                );
                let _ = conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    port
}

#[tokio::test]
async fn event_stream_replies_are_parked_and_streamed_only_with_the_capability() {
    let port = spawn_event_server().await;
    let (state, app) = test_app(true, 48_732);
    let paired = pair_capabilities(&state, &app, json!(["http.request", "sse.stream"])).await;
    let token = paired["token"].as_str().unwrap().to_owned();

    let id = Uuid::new_v4();
    let reply = call(
        &app,
        "/v1/http/request",
        events_input(id, format!("http://127.0.0.1:{port}/events")),
        &token,
    )
    .await;
    assert_eq!(reply.status(), StatusCode::OK);
    let reply = response_json(reply).await;
    assert_eq!(reply["stream"], "sse");
    assert_eq!(reply["status"], 200);
    assert_eq!(reply["bodyBase64"], "");
    let mut lines = Lines::new(
        call(
            &app,
            "/v1/sse/stream",
            json!({"id": id.to_string()}),
            &token,
        )
        .await,
    );
    assert_eq!(
        lines.next().await.unwrap(),
        json!({"type": "event", "event": "message", "data": "one"})
    );
    assert_eq!(
        lines.next().await.unwrap(),
        json!({"type": "event", "event": "tick", "data": "{{secret}}", "id": "2"})
    );
    assert_eq!(lines.next().await.unwrap(), json!({"type": "end"}));
    assert!(lines.next().await.is_none());
    // A stream is read once.
    let again = call(
        &app,
        "/v1/sse/stream",
        json!({"id": id.to_string()}),
        &token,
    )
    .await;
    assert_eq!(again.status(), StatusCode::NOT_FOUND);

    // A plain reply is read whole as before.
    let plain = response_json(
        call(
            &app,
            "/v1/http/request",
            events_input(Uuid::new_v4(), format!("http://127.0.0.1:{port}/plain")),
            &token,
        )
        .await,
    )
    .await;
    assert!(plain.get("stream").is_none());
    // A request that does not ask for a stream is read whole too (the Runner).
    let unasked = response_json(
        call(
            &app,
            "/v1/http/request",
            http_input(
                Uuid::new_v4(),
                format!("http://127.0.0.1:{port}/events"),
                false,
            ),
            &token,
        )
        .await,
    )
    .await;
    assert!(unasked.get("stream").is_none());
    assert_ne!(unasked["bodyBase64"], "");

    // Cancelling an open stream ends it.
    let id = Uuid::new_v4();
    let reply = response_json(
        call(
            &app,
            "/v1/http/request",
            events_input(id, format!("http://127.0.0.1:{port}/events?keep")),
            &token,
        )
        .await,
    )
    .await;
    assert_eq!(reply["stream"], "sse");
    let mut lines = Lines::new(
        call(
            &app,
            "/v1/sse/stream",
            json!({"id": id.to_string()}),
            &token,
        )
        .await,
    );
    assert_eq!(lines.next().await.unwrap()["data"], "one");
    assert_eq!(lines.next().await.unwrap()["event"], "tick");
    let cancel = call(
        &app,
        "/v1/http/cancel",
        json!({"id": id.to_string()}),
        &token,
    )
    .await;
    assert_eq!(cancel.status(), StatusCode::NO_CONTENT);
    assert_eq!(lines.next().await.unwrap(), json!({"type": "end"}));

    // Without `sse.stream` the same reply is read to its end, and the route is closed.
    let (state, app) = test_app(true, 48_732);
    let token = pair_capabilities(&state, &app, json!(["http.request"])).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let whole = response_json(
        call(
            &app,
            "/v1/http/request",
            events_input(Uuid::new_v4(), format!("http://127.0.0.1:{port}/events")),
            &token,
        )
        .await,
    )
    .await;
    assert!(whole.get("stream").is_none());
    assert_ne!(whole["bodyBase64"], "");
    let denied = call(
        &app,
        "/v1/sse/stream",
        json!({"id": Uuid::new_v4().to_string()}),
        &token,
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
}

/// Echoes text as `echo: …` and binary as is; greets with the `x-token`
/// header; `/deny` answers 401; requires the `chat.v1` subprotocol.
async fn spawn_websocket_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut token = String::new();
                let accepted = tokio_tungstenite::accept_hdr_async(
                    stream,
                    |request: &HandshakeRequest, mut response: HandshakeResponse| {
                        if request.uri().path() == "/deny" {
                            let mut rejection = tokio_tungstenite::tungstenite::http::Response::new(
                                Some("no".to_owned()),
                            );
                            *rejection.status_mut() =
                                tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                            return Err(rejection);
                        }
                        token = request
                            .headers()
                            .get("x-token")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("-")
                            .to_owned();
                        response.headers_mut().insert(
                            "sec-websocket-protocol",
                            HeaderValue::from_static("chat.v1"),
                        );
                        Ok(response)
                    },
                )
                .await;
                let Ok(mut socket) = accepted else { return };
                let _ = socket.send(Message::text(format!("hello {token}"))).await;
                while let Some(Ok(message)) = socket.next().await {
                    match message {
                        Message::Text(text) => {
                            let _ = socket
                                .send(Message::text(format!("echo: {}", text.as_str())))
                                .await;
                        }
                        Message::Binary(bytes) => {
                            let _ = socket.send(Message::binary(bytes)).await;
                        }
                        // The library answers the close; the stream then ends.
                        Message::Close(_) => {}
                        _ => {}
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn websocket_handshake_frames_and_close_go_through_the_agent() {
    let port = spawn_websocket_server().await;
    let (state, app) = test_app(true, 48_732);
    let token = pair_capabilities(&state, &app, json!(["http.request", "websocket.connect"])).await
        ["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let connect = |id: Uuid, path: &str| {
        json!({
            "id": id.to_string(),
            "url": format!("ws://127.0.0.1:{port}{path}"),
            "headers": [{"name": "X-Token", "value": "abc"}],
            "protocols": ["chat.v1"],
            "timeoutMs": 3000,
        })
    };

    let id = Uuid::new_v4();
    let response = call(&app, "/v1/ws/connect", connect(id, "/chat"), &token).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut lines = Lines::new(response);
    let open = lines.next().await.unwrap();
    assert_eq!(
        (open["type"].as_str(), open["status"].as_u64()),
        (Some("open"), Some(101))
    );
    assert_eq!(open["protocol"], "chat.v1");
    assert!(open["tls"].is_null());
    assert_eq!(
        lines.next().await.unwrap(),
        json!({"type": "message", "kind": "text", "data": "hello abc"})
    );

    let send = call(
        &app,
        "/v1/ws/send",
        json!({"id": id.to_string(), "text": "ping"}),
        &token,
    )
    .await;
    assert_eq!(send.status(), StatusCode::NO_CONTENT);
    assert_eq!(lines.next().await.unwrap()["data"], "echo: ping");
    let send = call(
        &app,
        "/v1/ws/send",
        json!({"id": id.to_string(), "binaryBase64": "AAEC"}),
        &token,
    )
    .await;
    assert_eq!(send.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        lines.next().await.unwrap(),
        json!({"type": "message", "kind": "binary", "dataBase64": "AAEC"})
    );
    let both = call(
        &app,
        "/v1/ws/send",
        json!({"id": id.to_string(), "text": "a", "binaryBase64": "AA=="}),
        &token,
    )
    .await;
    assert_eq!(both.status(), StatusCode::BAD_REQUEST);
    let bad_code = call(
        &app,
        "/v1/ws/close",
        json!({"id": id.to_string(), "code": 1006}),
        &token,
    )
    .await;
    assert_eq!(bad_code.status(), StatusCode::BAD_REQUEST);

    let close = call(
        &app,
        "/v1/ws/close",
        json!({"id": id.to_string(), "code": 1000, "reason": "bye"}),
        &token,
    )
    .await;
    assert_eq!(close.status(), StatusCode::NO_CONTENT);
    let closed = lines.next().await.unwrap();
    assert_eq!(
        (closed["type"].as_str(), closed["initiator"].as_str()),
        (Some("close"), Some("client"))
    );
    assert!(lines.next().await.is_none());
    let gone = call(
        &app,
        "/v1/ws/send",
        json!({"id": id.to_string(), "text": "late"}),
        &token,
    )
    .await;
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);

    // An HTTP answer to the handshake is shown, not hidden behind an error.
    let mut lines = Lines::new(
        call(
            &app,
            "/v1/ws/connect",
            connect(Uuid::new_v4(), "/deny"),
            &token,
        )
        .await,
    );
    let rejected = lines.next().await.unwrap();
    assert_eq!(
        (rejected["type"].as_str(), rejected["status"].as_u64()),
        (Some("rejected"), Some(401))
    );
    assert!(lines.next().await.is_none());

    // Cancelling closes the socket from the agent's side.
    let id = Uuid::new_v4();
    let mut lines = Lines::new(call(&app, "/v1/ws/connect", connect(id, "/chat"), &token).await);
    lines.next().await.unwrap();
    lines.next().await.unwrap();
    call(
        &app,
        "/v1/http/cancel",
        json!({"id": id.to_string()}),
        &token,
    )
    .await;
    let closed = lines.next().await.unwrap();
    assert_eq!(
        (closed["type"].as_str(), closed["initiator"].as_str()),
        (Some("close"), Some("agent"))
    );

    let mut bad = connect(Uuid::new_v4(), "/chat");
    bad["url"] = json!(format!("http://127.0.0.1:{port}/chat"));
    assert_eq!(
        call(&app, "/v1/ws/connect", bad, &token).await.status(),
        StatusCode::BAD_REQUEST
    );
    let mut reserved = connect(Uuid::new_v4(), "/chat");
    reserved["headers"] = json!([{"name": "Sec-WebSocket-Key", "value": "x"}]);
    assert_eq!(
        call(&app, "/v1/ws/connect", reserved, &token)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );

    // The capability is separate from HTTP.
    let (state, app) = test_app(true, 48_732);
    let http_only = pair_capabilities(&state, &app, json!(["http.request"])).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        call(
            &app,
            "/v1/ws/connect",
            connect(Uuid::new_v4(), "/chat"),
            &http_only
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "/v1/ws/send",
            json!({"id": Uuid::new_v4().to_string(), "text": "x"}),
            &http_only
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn websocket_targets_pass_the_destination_policy() {
    let (state, app) = test_app(false, 48_732);
    let token = pair_capabilities(&state, &app, json!(["websocket.connect"])).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let response = call(
        &app,
        "/v1/ws/connect",
        json!({"id": Uuid::new_v4().to_string(), "url": "ws://169.254.169.254/", "timeoutMs": 2000}),
        &token,
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "target_denied"
    );
}
