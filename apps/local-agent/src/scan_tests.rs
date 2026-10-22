//! Port scans (`port.scan`) and network scans (`network.scan`) through the router.

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    icmp,
    security_tests::{ORIGIN, pair_capabilities, request, response_json, test_app},
    stream_tests::Lines,
};

async fn post(app: &Router, path: &str, body: Value, token: &str) -> axum::response::Response {
    app.clone()
        .oneshot(request(Method::POST, path, Some(body), Some(token)))
        .await
        .unwrap()
}

async fn collect(response: axum::response::Response) -> Vec<Value> {
    assert_eq!(response.status(), StatusCode::OK);
    let mut lines = Lines::new(response);
    let mut all = Vec::new();
    while let Some(line) = lines.next().await {
        all.push(line);
    }
    all
}

/// A port that refuses: bound, then released.
async fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

#[tokio::test]
async fn port_scan_lists_open_closed_and_the_agents_own_port() {
    let open = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let open_port = open.local_addr().unwrap().port();
    let closed = closed_port().await;
    let agent_port = 48_732;
    let (state, app) = test_app(true, agent_port);
    let token = pair_capabilities(&state, &app, json!(["port.scan"])).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let ports = json!([
        [open_port, open_port],
        [closed, closed],
        [agent_port, agent_port]
    ]);
    let response = post(
        &app,
        "/v1/scan/ports",
        json!({ "id": Uuid::new_v4(), "host": "127.0.0.1", "ports": ports, "timeoutMs": 1000 }),
        &token,
    )
    .await;
    let lines = collect(response).await;
    assert_eq!(
        lines[0],
        json!({ "type": "start", "address": "127.0.0.1", "total": 3 })
    );
    let status = |port: u16| {
        lines
            .iter()
            .find(|line| line["type"] == "port" && line["port"] == port)
            .map(|line| line["status"].clone())
    };
    assert_eq!(status(open_port), Some(json!("open")));
    assert_eq!(status(closed), Some(json!("closed")));
    assert_eq!(status(agent_port), Some(json!("denied")));
    let end = lines.last().unwrap();
    assert_eq!(end["type"], "end");
    assert_eq!(
        (
            end["done"].clone(),
            end["open"].clone(),
            end["closed"].clone(),
            end["other"].clone()
        ),
        (json!(3), json!(1), json!(1), json!(1))
    );
    assert_eq!(end["stopped"], false);
}

#[tokio::test]
async fn a_large_port_scan_lists_only_open_ports_and_stops_on_cancel() {
    let (state, app) = test_app(true, 48_732);
    let token = pair_capabilities(&state, &app, json!(["port.scan"])).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = Uuid::new_v4();
    let response = post(
        &app,
        "/v1/scan/ports",
        json!({ "id": id, "host": "127.0.0.1", "ports": [[1, 65535]], "timeoutMs": 1000, "parallel": 4 }),
        &token,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut lines = Lines::new(response);
    assert_eq!(lines.next().await.unwrap()["total"], 65_535);
    let cancel = post(&app, "/v1/http/cancel", json!({ "id": id }), &token).await;
    assert_eq!(cancel.status(), StatusCode::NO_CONTENT);
    let mut last = Value::Null;
    while let Some(line) = lines.next().await {
        assert_ne!(
            line["status"], "closed",
            "closed ports are not listed above 1024"
        );
        last = line;
    }
    assert_eq!(last["type"], "end");
    assert_eq!(last["stopped"], true);
    assert!(last["done"].as_u64().unwrap() < 65_535);
}

#[tokio::test]
async fn scans_need_their_own_capability_and_private_access() {
    let (state, app) = test_app(false, 48_732);
    let token = pair_capabilities(&state, &app, json!(["tcp.connect"])).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let ports =
        json!({ "id": Uuid::new_v4(), "host": "127.0.0.1", "ports": [[80, 80]], "timeoutMs": 500 });
    assert_eq!(
        post(&app, "/v1/scan/ports", ports.clone(), &token)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let network = json!({ "id": Uuid::new_v4(), "network": "192.168.1.0/24", "timeoutMs": 500 });
    assert_eq!(
        post(&app, "/v1/scan/network", network, &token)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    let networks = |token: &str| request(Method::GET, "/v1/scan/networks", None, Some(token));
    let listed = app.clone().oneshot(networks(&token)).await.unwrap();
    assert_eq!(listed.status(), StatusCode::FORBIDDEN);

    let token =
        pair_capabilities(&state, &app, json!(["port.scan", "network.scan"])).await["token"]
            .as_str()
            .unwrap()
            .to_owned();
    let listed = app.clone().oneshot(networks(&token)).await.unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    assert!(response_json(listed).await["networks"].is_array());
    let response = post(&app, "/v1/scan/ports", ports, &token).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "private_network_denied"
    );
    let metadata = json!({ "id": Uuid::new_v4(), "host": "169.254.169.254", "ports": [[80, 80]], "timeoutMs": 500 });
    let response = post(&app, "/v1/scan/ports", metadata, &token).await;
    assert_eq!(
        response_json(response).await["error"]["code"],
        "target_denied"
    );
}

#[tokio::test]
async fn network_scan_stays_inside_this_computers_subnets() {
    let (state, app) = test_app(true, 48_732);
    let token = pair_capabilities(&state, &app, json!(["network.scan"])).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let scan = |network: &str| json!({ "id": Uuid::new_v4(), "network": network, "timeoutMs": 300, "ports": [9] });
    let response = post(&app, "/v1/scan/network", scan("8.8.8.0/24"), &token).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(response).await["error"]["code"],
        "network_not_local"
    );
    let response = post(&app, "/v1/scan/network", scan("10.0.0.0/21"), &token).await;
    assert_eq!(
        response_json(response).await["error"]["code"],
        "network_too_large"
    );
    let response = post(&app, "/v1/scan/network", scan("127.0.0.0/30"), &token).await;
    assert_eq!(
        response_json(response).await["error"]["code"],
        "network_not_local"
    );

    // This computer's own address as a /32: it is always reported, marked as itself.
    let own = icmp::local_ipv4_networks()
        .unwrap()
        .into_iter()
        .map(|(_, address, _)| address)
        .find(|address| address.is_private());
    let Some(own) = own else {
        return;
    };
    let lines =
        collect(post(&app, "/v1/scan/network", scan(&format!("{own}/32")), &token).await).await;
    assert_eq!(lines[0]["total"], 1);
    let host = lines
        .iter()
        .find(|line| line["type"] == "host")
        .expect("own host");
    assert_eq!(host["address"], own.to_string());
    assert_eq!(host["thisComputer"], true);
    assert_eq!(lines.last().unwrap()["found"], 1);
}

#[tokio::test]
async fn scan_routes_answer_the_cors_preflight() {
    let (_, app) = test_app(false, 48_732);
    for (path, method) in [
        ("/v1/scan/ports", "POST"),
        ("/v1/scan/network", "POST"),
        ("/v1/scan/networks", "GET"),
    ] {
        let preflight = Request::builder()
            .method(Method::OPTIONS)
            .uri(path)
            .header("host", "127.0.0.1:48732")
            .header("origin", ORIGIN)
            .header("access-control-request-method", method)
            .header(
                "access-control-request-headers",
                "authorization, content-type",
            )
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(preflight).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{path}");
    }
}
