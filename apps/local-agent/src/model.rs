use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

pub(crate) const HTTP_CAPABILITY: &str = "http.request";
/// Continuous ICMP traceroute. Granted only when the page asks for it; pairing
/// for `http.request` does not include this capability.
pub(crate) const ICMP_CAPABILITY: &str = "icmp.trace";
pub(crate) const AGENT_CAPABILITIES: [&str; 2] = [HTTP_CAPABILITY, ICMP_CAPABILITY];
pub(crate) const MAX_INCOMING_JSON_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InfoResponse {
    pub(crate) protocol_version: u8,
    pub(crate) version: &'static str,
    pub(crate) capabilities: &'static [&'static str],
    pub(crate) private_network_allowed: bool,
    pub(crate) limits: LimitsResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitsResponse {
    pub(crate) max_request_body_bytes: usize,
    pub(crate) max_response_body_bytes: usize,
    pub(crate) max_timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PairRequest {
    pub(crate) code: String,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairResponse {
    pub(crate) token: String,
    /// Granted subset, stable order: `http.request`, then `icmp.trace`.
    pub(crate) capabilities: Vec<&'static str>,
    pub(crate) expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HeaderEntry {
    pub(crate) name: String,
    pub(crate) value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HttpRequestInput {
    pub(crate) id: String,
    pub(crate) method: String,
    pub(crate) url: String,
    pub(crate) headers: Vec<HeaderEntry>,
    pub(crate) body_base64: String,
    pub(crate) timeout_ms: u64,
    pub(crate) follow_redirects: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelRequest {
    pub(crate) id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpResponseOutput {
    pub(crate) status: u16,
    pub(crate) status_text: String,
    pub(crate) url: String,
    pub(crate) headers: Vec<HeaderEntry>,
    pub(crate) body_base64: String,
    pub(crate) elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
}

impl ApiError {
    pub(crate) const fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }

    pub(crate) const fn invalid_request() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request")
    }

    pub(crate) const fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }

    pub(crate) const fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden")
    }

    pub(crate) const fn unsupported_capability() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "unsupported_capability")
    }

    pub(crate) const fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found")
    }

    pub(crate) const fn busy() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "busy")
    }

    pub(crate) const fn name_not_found() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "name_not_found")
    }

    /// The OS refused an ICMP socket (missing ping group range or CAP_NET_RAW).
    pub(crate) const fn icmp_unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "icmp_unavailable")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorEnvelope {
                error: ErrorBody { code: self.code },
            }),
        )
            .into_response()
    }
}
