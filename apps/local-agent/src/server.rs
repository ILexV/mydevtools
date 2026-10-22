use std::{future::IntoFuture, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN, VARY},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::de::DeserializeOwned;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    asn, dns, http_client, icmp,
    model::{
        AGENT_CAPABILITIES, AGENT_FEATURES, ApiError, CancelRequest, HttpRequestInput,
        InfoResponse, LimitsResponse, MAX_INCOMING_JSON_BYTES, MAX_REQUEST_BODY_BYTES,
        MAX_RESPONSE_BODY_BYTES, MAX_TIMEOUT_MS, PairRequest,
    },
    sse,
    state::AgentState,
    tcp, tls,
    vault::{
        CertificateWrite, DocumentDelete, DocumentName, DocumentWrite, SecretName, SecretWrite,
    },
    websocket, whois,
};

const ALLOW_METHODS: &str = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS: &str = "Authorization, Content-Type";

pub(crate) fn router(state: Arc<AgentState>) -> Router {
    Router::new()
        .route("/v1/info", get(info).options(preflight))
        .route("/v1/pair", post(pair).options(preflight))
        .route("/v1/session", delete(revoke_session).options(preflight))
        .route("/v1/http/request", post(http_request).options(preflight))
        .route("/v1/http/cancel", post(cancel_request).options(preflight))
        .route("/v1/sse/stream", post(sse_stream).options(preflight))
        .route("/v1/ws/connect", post(websocket_connect).options(preflight))
        .route("/v1/ws/send", post(websocket_send).options(preflight))
        .route("/v1/ws/close", post(websocket_close).options(preflight))
        .route("/v1/icmp/trace", post(icmp_trace).options(preflight))
        .route("/v1/icmp/snapshot", post(icmp_snapshot).options(preflight))
        .route("/v1/icmp/cancel", post(icmp_cancel).options(preflight))
        .route("/v1/icmp/mtu", post(icmp_mtu).options(preflight))
        .route(
            "/v1/icmp/interfaces",
            get(icmp_interfaces).options(preflight),
        )
        .route("/v1/dns/lookup", post(dns_lookup).options(preflight))
        .route("/v1/tcp/connect", post(tcp_connect).options(preflight))
        .route("/v1/tls/inspect", post(tls_inspect).options(preflight))
        .route("/v1/whois/lookup", post(whois_lookup).options(preflight))
        .route("/v1/asn/lookup", post(asn_lookup).options(preflight))
        .route(
            "/v1/vault/documents",
            get(vault_documents).options(preflight),
        )
        .route(
            "/v1/vault/document/read",
            post(vault_document_read).options(preflight),
        )
        .route(
            "/v1/vault/document/write",
            post(vault_document_write).options(preflight),
        )
        .route(
            "/v1/vault/document/delete",
            post(vault_document_delete).options(preflight),
        )
        .route("/v1/vault/secrets", get(vault_secrets).options(preflight))
        .route(
            "/v1/vault/certificates",
            get(vault_certificates).options(preflight),
        )
        .route(
            "/v1/vault/certificate/write",
            post(vault_certificate_write).options(preflight),
        )
        .route(
            "/v1/vault/certificate/delete",
            post(vault_certificate_delete).options(preflight),
        )
        .route(
            "/v1/vault/secret/write",
            post(vault_secret_write).options(preflight),
        )
        .route(
            "/v1/vault/secret/delete",
            post(vault_secret_delete).options(preflight),
        )
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            security_gate,
        ))
        .with_state(state)
}

pub(crate) async fn serve(
    listener: TcpListener,
    state: Arc<AgentState>,
    shutdown: CancellationToken,
) -> std::io::Result<()> {
    let server = axum::serve(listener, router(Arc::clone(&state)))
        .with_graceful_shutdown(shutdown.clone().cancelled_owned())
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result,
        _ = shutdown.cancelled() => {
            state.revoke_all();
            // A partially uploaded request must not keep the tray's Exit action alive.
            tokio::time::timeout(Duration::from_secs(2), &mut server)
                .await
                .unwrap_or(Ok(()))
        }
    }
}

async fn info(State(state): State<Arc<AgentState>>) -> Json<InfoResponse> {
    Json(InfoResponse {
        protocol_version: 1,
        features: &AGENT_FEATURES,
        version: env!("CARGO_PKG_VERSION"),
        capabilities: &AGENT_CAPABILITIES,
        private_network_allowed: state.config.allow_private,
        vault_available: state.vault.available(),
        limits: LimitsResponse {
            max_request_body_bytes: MAX_REQUEST_BODY_BYTES,
            max_response_body_bytes: MAX_RESPONSE_BODY_BYTES,
            max_timeout_ms: MAX_TIMEOUT_MS,
        },
    })
}

async fn pair(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let origin = required_header(request.headers(), ORIGIN)?;
    let input: PairRequest = parse_json(request).await?;
    Ok((StatusCode::OK, Json(state.pair(input, &origin)?)))
}

async fn revoke_session(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = required_header(request.headers(), ORIGIN)?;
    let authorization = optional_single_header(request.headers(), AUTHORIZATION)?;
    let session_key = state.authorize_session(authorization, &origin)?;
    state.revoke(session_key);
    Ok(StatusCode::NO_CONTENT)
}

async fn http_request(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let session_key = authorize(&state, request.headers())?;
    let origin = required_header(request.headers(), ORIGIN)?;
    let authorization =
        optional_single_header(request.headers(), AUTHORIZATION)?.map(str::to_owned);
    let input: HttpRequestInput = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    // With `sse.stream` an event stream reply is parked for `/v1/sse/stream`.
    let stream_events = input.stream_events && state.sse_allowed(authorization.as_deref(), &origin);
    // `{{secret:name}}` needs `vault.secrets` as well; values stay in the agent.
    let secrets = if http_client::mentions_secret(&input) {
        state.authorize_vault_secrets(authorization.as_deref(), &origin)?;
        let vault = Arc::clone(&state.vault);
        let origin = origin.clone();
        Some(run_vault(move || vault.secret_book(&origin)).await?)
    } else {
        None
    };
    // A client certificate is a vault secret too: its key stays in the agent.
    let certificate = match input.client_certificate.clone() {
        Some(name) => {
            state.authorize_vault_secrets(authorization.as_deref(), &origin)?;
            let vault = Arc::clone(&state.vault);
            Some(run_vault(move || vault.certificate(&origin, &name)).await?)
        }
        None => None,
    };
    let permit = state.try_acquire_request_slot()?;
    let cancellation = CancellationToken::new();
    let active_request = state.register_request(session_key, request_id, cancellation.clone())?;
    let result = http_client::execute(
        input,
        &state.config,
        cancellation,
        secrets.as_ref(),
        certificate.as_ref(),
        stream_events,
    )
    .await;
    drop(active_request);
    drop(permit);
    let (output, events) = result?;
    if let Some(events) = events {
        state.parked_streams.park(session_key, request_id, events);
    }
    Ok((StatusCode::OK, Json(output)))
}

fn ndjson(body: Body) -> Response {
    (
        [
            (CONTENT_TYPE, "application/x-ndjson"),
            (CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// The parked event stream of an `http.request` reply, as NDJSON lines while
/// events arrive. `sse.stream` only; cancel with `/v1/http/cancel` or by
/// closing the response.
async fn sse_stream(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<Response, ApiError> {
    let origin = required_header(request.headers(), ORIGIN)?;
    let authorization = optional_single_header(request.headers(), AUTHORIZATION)?;
    let session_key = state.authorize_sse(authorization, &origin)?;
    let input: CancelRequest = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    let stream = state
        .parked_streams
        .take(session_key, request_id)
        .ok_or_else(ApiError::not_found)?;
    let permit = state.try_acquire_stream_slot()?;
    let cancellation = CancellationToken::new();
    let guard = state.register_request(session_key, request_id, cancellation.clone())?;
    Ok(ndjson(sse::body(stream, cancellation, guard, permit)))
}

/// Opens a WebSocket and streams its handshake and frames as NDJSON lines.
/// `websocket.connect` only; secrets and a client certificate need `vault.secrets`.
async fn websocket_connect(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<Response, ApiError> {
    let origin = required_header(request.headers(), ORIGIN)?;
    let authorization =
        optional_single_header(request.headers(), AUTHORIZATION)?.map(str::to_owned);
    let session_key = state.authorize_websocket(authorization.as_deref(), &origin)?;
    let input: websocket::ConnectInput = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    let secrets = if input.mentions_secret() {
        state.authorize_vault_secrets(authorization.as_deref(), &origin)?;
        let vault = Arc::clone(&state.vault);
        let origin = origin.clone();
        Some(run_vault(move || vault.secret_book(&origin)).await?)
    } else {
        None
    };
    let certificate = match input.client_certificate.clone() {
        Some(name) => {
            state.authorize_vault_secrets(authorization.as_deref(), &origin)?;
            let vault = Arc::clone(&state.vault);
            Some(run_vault(move || vault.certificate(&origin, &name)).await?)
        }
        None => None,
    };
    let permit = state.try_acquire_stream_slot()?;
    let cancellation = CancellationToken::new();
    let guard = state.register_request(session_key, request_id, cancellation.clone())?;
    let connecting =
        websocket::connect(input, &state.config, secrets.as_ref(), certificate.as_ref());
    let (handshake, substitutions) = tokio::select! {
        _ = cancellation.cancelled() => return Err(ApiError::new(StatusCode::CONFLICT, "cancelled")),
        result = connecting => result?,
    };
    Ok(ndjson(websocket::body(
        Arc::clone(&state),
        session_key,
        request_id,
        handshake,
        substitutions,
        cancellation,
        guard,
        permit,
    )))
}

async fn websocket_send(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = required_header(request.headers(), ORIGIN)?;
    let authorization = optional_single_header(request.headers(), AUTHORIZATION)?;
    let session_key = state.authorize_websocket(authorization, &origin)?;
    let input: websocket::SendInput = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    state.sockets.send(session_key, request_id, input).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn websocket_close(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = required_header(request.headers(), ORIGIN)?;
    let authorization = optional_single_header(request.headers(), AUTHORIZATION)?;
    let session_key = state.authorize_websocket(authorization, &origin)?;
    let input: websocket::CloseInput = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    state.sockets.close(session_key, request_id, input).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_request(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let session_key = authorize(&state, request.headers())?;
    let input: CancelRequest = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    state.cancel_request(session_key, request_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn icmp_trace(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let session_key = authorize_icmp(&state, request.headers())?;
    let input = parse_json(request).await?;
    let snapshot = icmp::start_trace(Arc::clone(&state), session_key, input).await?;
    Ok((StatusCode::OK, Json(snapshot)))
}

async fn icmp_snapshot(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let session_key = authorize_icmp(&state, request.headers())?;
    let input: CancelRequest = parse_json(request).await?;
    Ok((
        StatusCode::OK,
        Json(icmp::snapshot_trace(&state, session_key, input)?),
    ))
}

async fn icmp_cancel(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let session_key = authorize_icmp(&state, request.headers())?;
    let input: CancelRequest = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    state.cancel_trace(session_key, request_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn icmp_mtu(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let _session_key = authorize_icmp(&state, request.headers())?;
    let input = parse_json(request).await?;
    let snapshot = icmp::find_path_mtu(Arc::clone(&state), input).await?;
    Ok((StatusCode::OK, Json(snapshot)))
}

/// Local unicast addresses for a probe source. Does not take an ICMP slot.
async fn icmp_interfaces(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let _session_key = authorize_icmp(&state, request.headers())?;
    let interfaces = tokio::task::spawn_blocking(icmp::list_interfaces)
        .await
        .map_err(|_| ApiError::busy())??;
    Ok((StatusCode::OK, Json(interfaces)))
}

/// One DNS query through the computer's resolver. `dns.lookup` only.
async fn dns_lookup(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let _session_key = authorize_dns(&state, request.headers())?;
    let input: dns::DnsLookupRequest = parse_json(request).await?;
    let prepared = dns::prepare(&input.name, &input.record_type)?;
    let permit = state.try_acquire_dns_slot()?;
    let response = tokio::task::spawn_blocking(move || dns::lookup_prepared(prepared))
        .await
        .map_err(|_| ApiError::busy())??;
    drop(permit);
    Ok((StatusCode::OK, Json(response)))
}

/// One TCP handshake. `tcp.connect` only. The socket is closed without a payload.
async fn tcp_connect(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let _session_key = authorize_tcp(&state, request.headers())?;
    let input: tcp::TcpConnectRequest = parse_json(request).await?;
    let prepared = tcp::prepare(&input.host, input.port, input.timeout_ms)?;
    let permit = state.try_acquire_tcp_slot()?;
    let response =
        tcp::connect_prepared(prepared, state.config.port, state.config.allow_private).await?;
    drop(permit);
    Ok((StatusCode::OK, Json(response)))
}

/// One TLS handshake. `tls.inspect` only. The socket is closed without application data.
async fn tls_inspect(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let _session_key = authorize_tls(&state, request.headers())?;
    let input: tls::TlsInspectRequest = parse_json(request).await?;
    let prepared = tls::prepare(&input.host, input.port, input.timeout_ms)?;
    let permit = state.try_acquire_tls_slot()?;
    let response =
        tls::inspect_prepared(prepared, state.config.port, state.config.allow_private).await?;
    drop(permit);
    Ok((StatusCode::OK, Json(response)))
}

/// One WHOIS line on port 43. `whois.lookup` only. The reply is not chased.
async fn whois_lookup(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let _session_key = authorize_whois(&state, request.headers())?;
    let input: whois::WhoisLookupRequest = parse_json(request).await?;
    let prepared = whois::prepare(&input.query, &input.server, input.timeout_ms)?;
    let permit = state.try_acquire_whois_slot()?;
    let response = whois::lookup_on_port(
        prepared,
        state.config.port,
        state.config.allow_private,
        whois::WHOIS_PORT,
    )
    .await?;
    drop(permit);
    Ok((StatusCode::OK, Json(response)))
}

/// One address in the local prefix table. `asn.lookup` only. No network call.
async fn asn_lookup(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let _session_key = authorize_asn(&state, request.headers())?;
    let input: asn::AsnLookupRequest = parse_json(request).await?;
    let prepared = asn::prepare(&input.query)?;
    let permit = state.try_acquire_asn_slot()?;
    let response = asn::lookup(prepared)?;
    drop(permit);
    Ok((StatusCode::OK, Json(response)))
}

/// Names, revisions and times of this origin's documents. `vault.data` only.
async fn vault_documents(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let origin = authorize_vault_data(&state, request.headers())?;
    let vault = Arc::clone(&state.vault);
    let documents = run_vault(move || vault.list_documents(&origin)).await?;
    Ok((StatusCode::OK, Json(json!({ "documents": documents }))))
}

async fn vault_document_read(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let origin = authorize_vault_data(&state, request.headers())?;
    let input: DocumentName = parse_json(request).await?;
    let vault = Arc::clone(&state.vault);
    let document = run_vault(move || vault.read_document(&origin, &input.name)).await?;
    Ok((StatusCode::OK, Json(document)))
}

async fn vault_document_write(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let origin = authorize_vault_data(&state, request.headers())?;
    let input: DocumentWrite = parse_json(request).await?;
    let vault = Arc::clone(&state.vault);
    let revision = run_vault(move || vault.write_document(&origin, input)).await?;
    Ok((StatusCode::OK, Json(revision)))
}

async fn vault_document_delete(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = authorize_vault_data(&state, request.headers())?;
    let input: DocumentDelete = parse_json(request).await?;
    let vault = Arc::clone(&state.vault);
    run_vault(move || vault.delete_document(&origin, input)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Secret names and hosts without values. `vault.secrets` only.
async fn vault_secrets(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let origin = authorize_vault_secrets(&state, request.headers())?;
    let vault = Arc::clone(&state.vault);
    let secrets = run_vault(move || vault.list_secrets(&origin)).await?;
    Ok((StatusCode::OK, Json(json!({ "secrets": secrets }))))
}

async fn vault_secret_write(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = authorize_vault_secrets(&state, request.headers())?;
    let input: SecretWrite = parse_json(request).await?;
    let vault = Arc::clone(&state.vault);
    run_vault(move || vault.write_secret(&origin, input)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn vault_secret_delete(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = authorize_vault_secrets(&state, request.headers())?;
    let input: SecretName = parse_json(request).await?;
    let vault = Arc::clone(&state.vault);
    run_vault(move || vault.delete_secret(&origin, &input.name)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Client certificate names, hosts, subjects and expiry; never keys. `vault.secrets` only.
async fn vault_certificates(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let origin = authorize_vault_secrets(&state, request.headers())?;
    let vault = Arc::clone(&state.vault);
    let certificates = run_vault(move || vault.list_certificates(&origin)).await?;
    Ok((
        StatusCode::OK,
        Json(json!({ "certificates": certificates })),
    ))
}

async fn vault_certificate_write(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = authorize_vault_secrets(&state, request.headers())?;
    let input: CertificateWrite = parse_json(request).await?;
    let vault = Arc::clone(&state.vault);
    run_vault(move || vault.write_certificate(&origin, input)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn vault_certificate_delete(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let origin = authorize_vault_secrets(&state, request.headers())?;
    let input: SecretName = parse_json(request).await?;
    let vault = Arc::clone(&state.vault);
    run_vault(move || vault.delete_certificate(&origin, &input.name)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Vault file work is blocking and serialized by the vault's own lock.
async fn run_vault<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| ApiError::busy())?
}

async fn preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "invalid_request")
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "invalid_request")
}

async fn security_gate(
    State(state): State<Arc<AgentState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(origin_value) = single_header_value(request.headers(), ORIGIN) else {
        return ApiError::forbidden().into_response();
    };
    let Ok(origin) = origin_value.to_str() else {
        return ApiError::forbidden().into_response();
    };
    if !state.config.allowed_origins.contains(origin) {
        return ApiError::forbidden().into_response();
    }
    let origin_value = origin_value.clone();

    let host_valid =
        single_header(request.headers(), HOST).is_some_and(|host| host == state.expected_host);
    let preflight_valid = request.method() != Method::OPTIONS || valid_preflight(&request);
    let mut response = if host_valid && preflight_valid {
        next.run(request).await
    } else {
        ApiError::forbidden().into_response()
    };

    response.headers_mut().insert(
        HeaderName::from_static("access-control-allow-origin"),
        origin_value,
    );
    response.headers_mut().insert(
        HeaderName::from_static("access-control-allow-methods"),
        HeaderValue::from_static(ALLOW_METHODS),
    );
    response.headers_mut().insert(
        HeaderName::from_static("access-control-allow-headers"),
        HeaderValue::from_static(ALLOW_HEADERS),
    );
    response.headers_mut().insert(
        HeaderName::from_static("access-control-allow-private-network"),
        HeaderValue::from_static("true"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("access-control-max-age"),
        HeaderValue::from_static("600"),
    );
    response
        .headers_mut()
        .insert(VARY, HeaderValue::from_static("Origin"));
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn valid_preflight(request: &Request) -> bool {
    let requested_method = single_header(
        request.headers(),
        HeaderName::from_static("access-control-request-method"),
    );
    let expected_method = match request.uri().path() {
        "/v1/info"
        | "/v1/icmp/interfaces"
        | "/v1/vault/documents"
        | "/v1/vault/secrets"
        | "/v1/vault/certificates" => "GET",
        "/v1/pair"
        | "/v1/http/request"
        | "/v1/http/cancel"
        | "/v1/sse/stream"
        | "/v1/ws/connect"
        | "/v1/ws/send"
        | "/v1/ws/close"
        | "/v1/icmp/trace"
        | "/v1/icmp/snapshot"
        | "/v1/icmp/cancel"
        | "/v1/icmp/mtu"
        | "/v1/dns/lookup"
        | "/v1/tcp/connect"
        | "/v1/tls/inspect"
        | "/v1/whois/lookup"
        | "/v1/asn/lookup"
        | "/v1/vault/document/read"
        | "/v1/vault/document/write"
        | "/v1/vault/document/delete"
        | "/v1/vault/secret/write"
        | "/v1/vault/secret/delete"
        | "/v1/vault/certificate/write"
        | "/v1/vault/certificate/delete" => "POST",
        "/v1/session" => "DELETE",
        _ => return false,
    };
    if requested_method != Some(expected_method) {
        return false;
    }

    let requested_headers = match optional_single_header(
        request.headers(),
        HeaderName::from_static("access-control-request-headers"),
    ) {
        Ok(headers) => headers,
        Err(_) => return false,
    };
    requested_headers.is_none_or(|headers| {
        headers.split(',').all(|name| {
            let name = name.trim();
            name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("content-type")
        })
    })
}

fn authorize(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_http(authorization, &origin)
}

fn authorize_icmp(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_icmp(authorization, &origin)
}

fn authorize_dns(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_dns(authorization, &origin)
}

fn authorize_tcp(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_tcp(authorization, &origin)
}

fn authorize_whois(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_whois(authorization, &origin)
}

fn authorize_asn(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_asn(authorization, &origin)
}

/// Returns the origin: vault data is namespaced per origin.
fn authorize_vault_data(state: &AgentState, headers: &HeaderMap) -> Result<String, ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_vault_data(authorization, &origin)?;
    Ok(origin)
}

fn authorize_vault_secrets(state: &AgentState, headers: &HeaderMap) -> Result<String, ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_vault_secrets(authorization, &origin)?;
    Ok(origin)
}

fn authorize_tls(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_tls(authorization, &origin)
}

async fn parse_json<T: DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    let content_type = required_header(request.headers(), CONTENT_TYPE)?;
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(ApiError::invalid_request());
    }
    if request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_INCOMING_JSON_BYTES as u64)
    {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
        ));
    }
    let bytes = to_bytes(request.into_body(), MAX_INCOMING_JSON_BYTES)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large"))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid_request())
}

fn required_header(headers: &HeaderMap, name: HeaderName) -> Result<String, ApiError> {
    optional_single_header(headers, name)?
        .map(str::to_owned)
        .ok_or_else(ApiError::invalid_request)
}

fn optional_single_header<'a>(
    headers: &'a HeaderMap,
    name: HeaderName,
) -> Result<Option<&'a str>, ApiError> {
    let all_values = headers.get_all(name);
    let mut values = all_values.iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(ApiError::invalid_request());
    }
    first
        .map(|value| value.to_str().map_err(|_| ApiError::invalid_request()))
        .transpose()
}

fn single_header_value(headers: &HeaderMap, name: HeaderName) -> Option<&HeaderValue> {
    let all_values = headers.get_all(name);
    let mut values = all_values.iter();
    let first = values.next()?;
    values.next().is_none().then_some(first)
}

fn single_header(headers: &HeaderMap, name: HeaderName) -> Option<&str> {
    single_header_value(headers, name)?.to_str().ok()
}
