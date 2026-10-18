use std::{future::IntoFuture, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::to_bytes,
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
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    http_client,
    model::{
        ApiError, CancelRequest, HTTP_CAPABILITY, HttpRequestInput, InfoResponse, LimitsResponse,
        MAX_INCOMING_JSON_BYTES, MAX_REQUEST_BODY_BYTES, MAX_RESPONSE_BODY_BYTES, MAX_TIMEOUT_MS,
        PairRequest,
    },
    state::AgentState,
};

const ALLOW_METHODS: &str = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS: &str = "Authorization, Content-Type";

pub(crate) fn router(state: Arc<AgentState>) -> Router {
    Router::new()
        .route("/v1/info", get(info).options(preflight))
        .route("/v1/pair", post(pair).options(preflight))
        .route("/v1/session", delete(revoke_session).options(preflight))
        .route(
            "/v1/http/request",
            post(http_request).options(preflight),
        )
        .route("/v1/http/cancel", post(cancel_request).options(preflight))
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
        version: env!("CARGO_PKG_VERSION"),
        capabilities: [HTTP_CAPABILITY],
        private_network_allowed: state.config.allow_private,
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
    let session_key = authorize(&state, request.headers())?;
    state.revoke(session_key);
    Ok(StatusCode::NO_CONTENT)
}

async fn http_request(
    State(state): State<Arc<AgentState>>,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let session_key = authorize(&state, request.headers())?;
    let input: HttpRequestInput = parse_json(request).await?;
    let request_id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    let permit = state.try_acquire_request_slot()?;
    let cancellation = CancellationToken::new();
    let active_request = state.register_request(session_key, request_id, cancellation.clone())?;
    let result = http_client::execute(input, &state.config, cancellation).await;
    drop(active_request);
    drop(permit);
    Ok((StatusCode::OK, Json(result?)))
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
        "/v1/info" => "GET",
        "/v1/pair" | "/v1/http/request" | "/v1/http/cancel" => "POST",
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
            name.eq_ignore_ascii_case("authorization")
                || name.eq_ignore_ascii_case("content-type")
        })
    })
}

fn authorize(state: &AgentState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let origin = required_header(headers, ORIGIN)?;
    let authorization = optional_single_header(headers, AUTHORIZATION)?;
    state.authorize_http(authorization, &origin)
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
        .map_err(|_| {
            ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large")
        })?;
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
