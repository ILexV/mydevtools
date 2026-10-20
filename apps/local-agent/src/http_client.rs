use std::{
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::{Client, redirect::Policy};
use tokio::net::lookup_host;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use crate::{
    model::{
        ApiError, HeaderEntry, HttpRequestInput, HttpResponseOutput, MAX_REQUEST_BODY_BYTES,
        MAX_RESPONSE_BODY_BYTES, MAX_TIMEOUT_MS,
    },
    policy::enforce_destination,
    state::AgentConfig,
};

const MAX_REDIRECTS: usize = 5;
const MAX_REQUEST_HEADERS: usize = 256;
const MAX_REQUEST_HEADER_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_HEADERS: usize = 256;
const MAX_RESPONSE_HEADER_BYTES: usize = 128 * 1024;
const MAX_URL_BYTES: usize = 16 * 1024;
const MAX_PINNED_ADDRESSES: usize = 16;

pub(crate) async fn execute(
    input: HttpRequestInput,
    config: &AgentConfig,
    cancellation: CancellationToken,
) -> Result<HttpResponseOutput, ApiError> {
    let timeout = input.timeout_ms;
    if timeout == 0 || timeout > MAX_TIMEOUT_MS {
        return Err(ApiError::invalid_request());
    }

    let method = parse_method(&input.method)?;
    let url = parse_url(&input.url)?;
    let headers = parse_headers(input.headers)?;
    let body = decode_request_body(&input.body_base64)?;
    let started = Instant::now();

    let operation = execute_redirect_chain(
        method,
        url,
        headers,
        body,
        input.follow_redirects,
        config,
        &cancellation,
    );
    let output = tokio::select! {
        _ = cancellation.cancelled() => Err(cancelled()),
        result = tokio::time::timeout(Duration::from_millis(timeout), operation) => {
            match result {
                Ok(result) => result,
                Err(_) => Err(ApiError::new(StatusCode::REQUEST_TIMEOUT, "timeout")),
            }
        }
    }?;

    Ok(HttpResponseOutput {
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        ..output
    })
}

async fn execute_redirect_chain(
    mut method: Method,
    mut url: Url,
    mut headers: HeaderMap,
    mut body: Bytes,
    follow_redirects: bool,
    config: &AgentConfig,
    cancellation: &CancellationToken,
) -> Result<HttpResponseOutput, ApiError> {
    let mut redirects = 0;
    loop {
        let client = pinned_client(&url, config).await?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled()),
            response = client
                .request(method.clone(), url.clone())
                .headers(headers.clone())
                .body(body.clone())
                .send() => response.map_err(map_network_error)?,
        };

        if follow_redirects && is_followable_redirect(response.status()) {
            if let Some(location) = response.headers().get(reqwest::header::LOCATION) {
                if redirects >= MAX_REDIRECTS {
                    return Err(ApiError::new(StatusCode::BAD_GATEWAY, "network_error"));
                }
                let location = location
                    .to_str()
                    .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "network_error"))?;
                let next_url = parse_redirect_url(&url, location)?;
                if url.scheme() == "https" && next_url.scheme() == "http" {
                    return Err(ApiError::new(StatusCode::FORBIDDEN, "target_denied"));
                }
                if !same_origin(&url, &next_url) {
                    retain_cross_origin_safe_headers(&mut headers);
                }
                rewrite_redirect_request(response.status(), &mut method, &mut body, &mut headers);
                url = next_url;
                redirects += 1;
                continue;
            }
        }

        return read_response(response, cancellation).await;
    }
}

async fn pinned_client(url: &Url, config: &AgentConfig) -> Result<Client, ApiError> {
    let port = url
        .port_or_known_default()
        .ok_or_else(ApiError::invalid_request)?;
    if port == 0 {
        return Err(ApiError::invalid_request());
    }

    let mut builder = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(0)
        .http2_max_header_list_size(MAX_RESPONSE_HEADER_BYTES as u32)
        .user_agent(concat!(
            "MyDevTools-Local-Agent/",
            env!("CARGO_PKG_VERSION")
        ));

    match url.host().ok_or_else(ApiError::invalid_request)? {
        Host::Ipv4(address) => {
            enforce_destination(IpAddr::V4(address), port, config.port, config.allow_private)?;
        }
        Host::Ipv6(address) => {
            enforce_destination(IpAddr::V6(address), port, config.port, config.allow_private)?;
        }
        Host::Domain(domain) => {
            let resolved = lookup_host((domain, port))
                .await
                .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "network_error"))?;
            let mut addresses: Vec<SocketAddr> = Vec::new();
            for address in resolved {
                if !addresses.iter().any(|pinned| pinned.ip() == address.ip()) {
                    if addresses.len() >= MAX_PINNED_ADDRESSES {
                        return Err(ApiError::new(StatusCode::FORBIDDEN, "target_denied"));
                    }
                    enforce_destination(address.ip(), port, config.port, config.allow_private)?;
                    addresses.push(SocketAddr::new(address.ip(), port));
                }
            }
            if addresses.is_empty() {
                return Err(ApiError::new(StatusCode::BAD_GATEWAY, "network_error"));
            }
            builder = builder.resolve_to_addrs(domain, &addresses);
        }
    }

    builder
        .build()
        .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "network_error"))
}

async fn read_response(
    response: reqwest::Response,
    cancellation: &CancellationToken,
) -> Result<HttpResponseOutput, ApiError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
    {
        return Err(response_too_large());
    }

    let status = response.status();
    let url = response.url().to_string();
    let headers = response_headers(response.headers())?;
    let capacity = response
        .content_length()
        .unwrap_or(0)
        .min(MAX_RESPONSE_BODY_BYTES as u64) as usize;
    let mut body = Vec::with_capacity(capacity);
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(map_network_error)?;
        if chunk.len() > MAX_RESPONSE_BODY_BYTES.saturating_sub(body.len()) {
            return Err(response_too_large());
        }
        body.extend_from_slice(&chunk);
    }

    Ok(HttpResponseOutput {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        url,
        headers,
        body_base64: STANDARD.encode(body),
        elapsed_ms: 0,
    })
}

fn parse_method(value: &str) -> Result<Method, ApiError> {
    if value.is_empty() || value.len() > 32 {
        return Err(ApiError::invalid_request());
    }
    let method = Method::from_bytes(value.as_bytes()).map_err(|_| ApiError::invalid_request())?;
    if value.eq_ignore_ascii_case("CONNECT") || value.eq_ignore_ascii_case("TRACE") {
        return Err(ApiError::invalid_request());
    }
    Ok(method)
}

fn parse_url(value: &str) -> Result<Url, ApiError> {
    if value.is_empty() || value.len() > MAX_URL_BYTES {
        return Err(ApiError::invalid_request());
    }
    let url = Url::parse(value).map_err(|_| ApiError::invalid_request())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || has_userinfo(&url)
        || url.port() == Some(0)
    {
        return Err(ApiError::invalid_request());
    }
    Ok(url)
}

fn has_userinfo(url: &Url) -> bool {
    let serialized = url.as_str();
    let authority = &serialized[url.scheme().len() + 3..];
    authority
        .split(['/', '?', '#'])
        .next()
        .is_some_and(|authority| authority.contains('@'))
}

fn parse_redirect_url(base: &Url, location: &str) -> Result<Url, ApiError> {
    if location.len() > MAX_URL_BYTES {
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "network_error"));
    }
    let joined = base
        .join(location)
        .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "network_error"))?;
    parse_url(joined.as_str()).map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "network_error"))
}

fn parse_headers(entries: Vec<HeaderEntry>) -> Result<HeaderMap, ApiError> {
    if entries.len() > MAX_REQUEST_HEADERS {
        return Err(ApiError::invalid_request());
    }
    let mut total_bytes = 0_usize;
    let mut headers = HeaderMap::with_capacity(entries.len());
    for entry in entries {
        total_bytes = total_bytes
            .checked_add(entry.name.len())
            .and_then(|total| total.checked_add(entry.value.len()))
            .ok_or_else(ApiError::invalid_request)?;
        if total_bytes > MAX_REQUEST_HEADER_BYTES {
            return Err(ApiError::invalid_request());
        }
        let name = HeaderName::from_bytes(entry.name.as_bytes())
            .map_err(|_| ApiError::invalid_request())?;
        if is_unsafe_transport_header(&name) {
            return Err(ApiError::invalid_request());
        }
        let value = HeaderValue::from_str(&entry.value).map_err(|_| ApiError::invalid_request())?;
        headers.append(name, value);
    }
    Ok(headers)
}

fn decode_request_body(encoded: &str) -> Result<Bytes, ApiError> {
    let max_encoded = MAX_REQUEST_BODY_BYTES.div_ceil(3) * 4;
    if encoded.len() > max_encoded {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
        ));
    }
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::invalid_request())?;
    if decoded.len() > MAX_REQUEST_BODY_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
        ));
    }
    Ok(Bytes::from(decoded))
}

fn response_headers(headers: &HeaderMap) -> Result<Vec<HeaderEntry>, ApiError> {
    if headers.len() > MAX_RESPONSE_HEADERS {
        return Err(response_too_large());
    }
    let mut total_bytes = 0_usize;
    let mut output = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        total_bytes = total_bytes
            .checked_add(name.as_str().len())
            .and_then(|total| total.checked_add(value.as_bytes().len()))
            .ok_or_else(response_too_large)?;
        if total_bytes > MAX_RESPONSE_HEADER_BYTES {
            return Err(response_too_large());
        }
        output.push(HeaderEntry {
            name: name.as_str().to_owned(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        });
    }
    Ok(output)
}

fn is_unsafe_transport_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "proxy-connection"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "keep-alive"
            | "upgrade"
            | "trailer"
            | "te"
            | "expect"
            | "http2-settings"
    )
}

fn is_followable_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn rewrite_redirect_request(
    status: StatusCode,
    method: &mut Method,
    body: &mut Bytes,
    headers: &mut HeaderMap,
) {
    let switch_to_get = status == StatusCode::SEE_OTHER && *method != Method::HEAD
        || matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND)
            && *method == Method::POST;
    if switch_to_get {
        *method = Method::GET;
        *body = Bytes::new();
        headers.remove(reqwest::header::CONTENT_TYPE);
        headers.remove(reqwest::header::CONTENT_ENCODING);
    }
}

fn retain_cross_origin_safe_headers(headers: &mut HeaderMap) {
    let removed: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            !matches!(
                name.as_str(),
                "accept" | "accept-language" | "content-type" | "content-encoding"
            )
        })
        .cloned()
        .collect();
    for name in removed {
        headers.remove(name);
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn map_network_error(error: reqwest::Error) -> ApiError {
    if error.is_timeout() {
        ApiError::new(StatusCode::REQUEST_TIMEOUT, "timeout")
    } else {
        ApiError::new(StatusCode::BAD_GATEWAY, "network_error")
    }
}

fn cancelled() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "cancelled")
}

fn response_too_large() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "response_too_large")
}
