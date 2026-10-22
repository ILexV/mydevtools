use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use crate::{
    cookies::Cookie,
    http_transport::{HttpVersionChoice, Timings, TlsSummary},
};

pub(crate) const HTTP_CAPABILITY: &str = "http.request";
/// Continuous ICMP traceroute. Granted only when the page asks for it; pairing
/// for `http.request` does not include this capability.
pub(crate) const ICMP_CAPABILITY: &str = "icmp.trace";
/// One DNS query through the computer's own resolver. Pairing for HTTP or ICMP
/// does not include this capability.
pub(crate) const DNS_CAPABILITY: &str = "dns.lookup";
/// One TCP handshake to one host and one port. Pairing for HTTP, ICMP or DNS
/// does not include this capability, and the check does not scan a range.
pub(crate) const TCP_CAPABILITY: &str = "tcp.connect";
/// One TLS handshake to one host and one port. Shows protocol, cipher, expiry
/// and the peer chain. Pairing for TCP does not include this capability.
/// A pasted PEM is not accepted on this route.
pub(crate) const TLS_CAPABILITY: &str = "tls.inspect";
/// One WHOIS query on TCP port 43. Pairing for TLS does not include this
/// capability, and the reply is not followed to another server.
pub(crate) const WHOIS_CAPABILITY: &str = "whois.lookup";
/// One ASN lookup in the prefix snapshot shipped with the agent. Pairing for
/// WHOIS does not include this capability. The lookup does not call a geo-IP
/// API and is not part of path trace.
pub(crate) const ASN_CAPABILITY: &str = "asn.lookup";
/// Encrypted documents on this computer (workspace, environments, history).
/// Pairing for HTTP does not include this capability.
pub(crate) const VAULT_DATA_CAPABILITY: &str = "vault.data";
/// Write-only secrets: names and hosts are listed, values never leave the agent.
/// `http.request` substitutes `{{secret:name}}` only with this capability too.
pub(crate) const VAULT_SECRETS_CAPABILITY: &str = "vault.secrets";
/// Reading a `text/event-stream` reply of `http.request` as it arrives. Without
/// it such a reply is read whole, like any other. Pairing for HTTP does not include it.
pub(crate) const SSE_CAPABILITY: &str = "sse.stream";
/// A WebSocket connection: the page reads its messages as a stream and sends
/// through the agent. Pairing for HTTP or SSE does not include this capability.
pub(crate) const WEBSOCKET_CAPABILITY: &str = "websocket.connect";
/// TCP connects to many ports of one host the user typed, with live results.
/// Pairing for `tcp.connect` does not include it.
pub(crate) const PORT_SCAN_CAPABILITY: &str = "port.scan";
/// Host discovery inside this computer's own IPv4 subnets (ICMP echo, TCP
/// probes, ARP). Pairing for any other tool does not include it.
pub(crate) const NETWORK_SCAN_CAPABILITY: &str = "network.scan";
pub(crate) const AGENT_CAPABILITIES: [&str; 13] = [
    HTTP_CAPABILITY,
    ICMP_CAPABILITY,
    DNS_CAPABILITY,
    TCP_CAPABILITY,
    TLS_CAPABILITY,
    WHOIS_CAPABILITY,
    ASN_CAPABILITY,
    VAULT_DATA_CAPABILITY,
    VAULT_SECRETS_CAPABILITY,
    SSE_CAPABILITY,
    WEBSOCKET_CAPABILITY,
    PORT_SCAN_CAPABILITY,
    NETWORK_SCAN_CAPABILITY,
];
/// `http.options`: `verifyTls`, `httpVersion`, `proxy` and timed phases in replies.
/// `http.client_certificates`: vault certificates and `clientCertificate` (mTLS).
pub(crate) const AGENT_FEATURES: [&str; 3] =
    ["http.options", "http.client_certificates", "http.cookies"];
pub(crate) const MAX_INCOMING_JSON_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InfoResponse {
    pub(crate) protocol_version: u8,
    /// Optional parts of the protocol; a page checks one before using it.
    pub(crate) features: &'static [&'static str],
    pub(crate) version: &'static str,
    pub(crate) capabilities: &'static [&'static str],
    pub(crate) private_network_allowed: bool,
    /// False when the agent has no data directory; vault routes then fail.
    pub(crate) vault_available: bool,
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
    /// Granted subset, stable order: `http.request`, `icmp.trace`, `dns.lookup`, `tcp.connect`, `tls.inspect`, `whois.lookup`, `asn.lookup`, `vault.data`, `vault.secrets`.
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
    /// HTTP Basic credentials encoded by the agent, so a `{{secret:name}}`
    /// password is substituted before Base64. Excludes an `Authorization` header.
    #[serde(default)]
    pub(crate) basic_auth: Option<BasicAuthInput>,
    /// Off accepts any server certificate (self-signed, expired, wrong name).
    #[serde(default = "default_true")]
    pub(crate) verify_tls: bool,
    #[serde(default)]
    pub(crate) http_version: HttpVersionChoice,
    #[serde(default)]
    pub(crate) proxy: Option<ProxyInput>,
    /// A vault client certificate by name; needs `vault.secrets` and is
    /// presented only to hosts in its list.
    #[serde(default)]
    pub(crate) client_certificate: Option<String>,
    /// The page's cookie jar: cookies are picked per hop and `Set-Cookie`
    /// changes come back in the output. Absent leaves cookies to the headers.
    #[serde(default)]
    pub(crate) cookies: Option<Vec<Cookie>>,
    /// Asks to leave a 2xx `text/event-stream` reply unread for `/v1/sse/stream`
    /// (needs `sse.stream`); otherwise it is read whole like any body.
    #[serde(default)]
    pub(crate) stream_events: bool,
}

const fn default_true() -> bool {
    true
}

/// A plain `http://host:port` proxy; hosts matching `bypass` connect directly.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProxyInput {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) username: String,
    #[serde(default)]
    pub(crate) password: String,
    #[serde(default)]
    pub(crate) bypass: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BasicAuthInput {
    pub(crate) username: String,
    pub(crate) password: String,
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
    /// `HTTP/1.1` or `HTTP/2` of the last hop.
    pub(crate) http_version: &'static str,
    pub(crate) remote_address: String,
    /// Phases of the last hop; earlier redirect hops count only in `elapsed_ms`.
    pub(crate) timings: Timings,
    pub(crate) redirects: u8,
    pub(crate) tls: Option<TlsSummary>,
    /// Jar changes made by the hops (an expiry in the past deletes); only when the request sent a jar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cookies: Option<Vec<Cookie>>,
    /// `sse`: the body is an event stream for `/v1/sse/stream` with the same id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) stream: Option<&'static str>,
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

    /// The source is not a current local unicast address, the family does not
    /// match the target, or the socket refused to bind it. Not a spoofed address.
    pub(crate) const fn source_unavailable() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "source_unavailable")
    }

    /// The system resolver did not answer before its own timeout.
    pub(crate) const fn dns_timeout() -> Self {
        Self::new(StatusCode::GATEWAY_TIMEOUT, "dns_timeout")
    }

    /// The resolver failed, or the reply was not a usable DNS message.
    pub(crate) const fn dns_unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "dns_unavailable")
    }

    /// The reply was still truncated after the resolver's TCP retry.
    pub(crate) const fn dns_truncated() -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "dns_truncated")
    }

    /// The TCP stack failed before a definite open, refusal, timeout or unreachable.
    pub(crate) const fn tcp_unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "tcp_unavailable")
    }

    /// The TLS stack failed before a handshake result or a TCP outcome.
    pub(crate) const fn tls_unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "tls_unavailable")
    }

    /// The WHOIS exchange failed before a reply or a TCP outcome.
    pub(crate) const fn whois_unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "whois_unavailable")
    }

    /// The embedded ASN prefix table could not be read.
    pub(crate) const fn asn_unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "asn_unavailable")
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
