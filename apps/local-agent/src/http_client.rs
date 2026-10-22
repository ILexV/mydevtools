use std::time::{Duration, Instant};

use axum::http::{
    HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
    header::{CONTENT_ENCODING, CONTENT_TYPE, COOKIE, LOCATION},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    cookies::{self, Jar},
    http_transport::{
        self, BodyStream, ClientIdentity, Exchange, Head, HttpVersionChoice,
        MAX_RESPONSE_HEADER_BYTES, MAX_RESPONSE_HEADERS, Options, Proxy, response_too_large,
    },
    model::{
        ApiError, HeaderEntry, HttpRequestInput, HttpResponseOutput, MAX_REQUEST_BODY_BYTES,
        MAX_TIMEOUT_MS, ProxyInput,
    },
    state::AgentConfig,
    vault::{self, CertificateRecord, SecretBook, Substitutions},
};

const MAX_REDIRECTS: usize = 5;
const MAX_REQUEST_HEADERS: usize = 256;
const MAX_REQUEST_HEADER_BYTES: usize = 64 * 1024;
pub(crate) const MAX_URL_BYTES: usize = 16 * 1024;

/// True when the URL, a header value or the body has `{{secret:`.
pub(crate) fn mentions_secret(input: &HttpRequestInput) -> bool {
    vault::mentions_secret(input.url.as_bytes())
        || input
            .headers
            .iter()
            .any(|header| vault::mentions_secret(header.value.as_bytes()))
        || STANDARD
            .decode(&input.body_base64)
            .is_ok_and(|body| vault::mentions_secret(&body))
        || input.basic_auth.as_ref().is_some_and(|basic| {
            vault::mentions_secret(basic.username.as_bytes())
                || vault::mentions_secret(basic.password.as_bytes())
        })
}

/// A 2xx `text/event-stream` reply whose body is left to `/v1/sse/stream`;
/// secret echoes in its events are redacted like the rest of the reply.
pub(crate) struct EventStream {
    pub(crate) body: BodyStream,
    pub(crate) substitutions: Substitutions,
}

/// `secrets` is the origin's book when the request uses placeholders. Each used
/// secret must list the target host and every followed redirect host; echoes of
/// its value in the response are redacted back to the placeholder. With
/// `stream_events` an event stream reply returns its head and the unread body.
pub(crate) async fn execute(
    input: HttpRequestInput,
    config: &AgentConfig,
    cancellation: CancellationToken,
    secrets: Option<&SecretBook>,
    certificate: Option<&CertificateRecord>,
    stream_events: bool,
) -> Result<(HttpResponseOutput, Option<EventStream>), ApiError> {
    let timeout = input.timeout_ms;
    if timeout == 0 || timeout > MAX_TIMEOUT_MS {
        return Err(ApiError::invalid_request());
    }

    let method = parse_method(&input.method)?;
    let mut substitutions = Substitutions::default();
    let mut url_text = input.url;
    let mut header_entries = input.headers;
    let mut body = decode_request_body(&input.body_base64)?;
    if let Some(book) = secrets {
        url_text = String::from_utf8(substitutions.apply(url_text.as_bytes(), book)?)
            .map_err(|_| ApiError::invalid_request())?;
        for entry in &mut header_entries {
            entry.value = String::from_utf8(substitutions.apply(entry.value.as_bytes(), book)?)
                .map_err(|_| ApiError::invalid_request())?;
        }
        let substituted = substitutions.apply(&body, book)?;
        if substituted.len() > MAX_REQUEST_BODY_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
            ));
        }
        body = Bytes::from(substituted);
    }
    if let Some(basic) = input.basic_auth {
        if header_entries
            .iter()
            .any(|entry| entry.name.eq_ignore_ascii_case("authorization"))
        {
            return Err(ApiError::invalid_request());
        }
        let template = format!("{}:{}", basic.username, basic.password);
        let credential = match secrets {
            Some(book) => String::from_utf8(substitutions.apply(template.as_bytes(), book)?)
                .map_err(|_| ApiError::invalid_request())?,
            None => template.clone(),
        };
        let encoded = STANDARD.encode(credential.as_bytes());
        if credential != template {
            // An echoed Authorization header shows the placeholder, not the encoded secret.
            substitutions.redact_also(encoded.as_bytes(), STANDARD.encode(template).as_bytes());
        }
        header_entries.push(HeaderEntry {
            name: "Authorization".to_owned(),
            value: format!("Basic {encoded}"),
        });
    }
    let url = parse_url(&url_text)?;
    if !substitutions.is_empty() && !substitutions.host_allowed(&url) {
        return Err(vault::secret_host_denied());
    }
    let headers = parse_headers(header_entries)?;
    let client = match certificate {
        Some(record) if !record.allows(&url) => return Err(vault::certificate_host_denied()),
        Some(record) => Some((record.identity()?, record)),
        None => None,
    };
    let mut jar = input.cookies.map(Jar::new).transpose()?;
    let options = RequestOptions {
        verify_tls: input.verify_tls,
        version: input.http_version,
        proxy: input.proxy.map(parse_proxy).transpose()?,
        client,
    };
    let started = Instant::now();

    let chain = execute_redirect_chain(
        method,
        url,
        headers,
        body,
        input.follow_redirects,
        config,
        &options,
        &substitutions,
        jar.as_mut(),
    );
    let operation = async {
        let (head, url, redirects) = chain.await?;
        if stream_events && is_event_stream(&head) {
            let (exchange, body) = head.into_stream();
            Ok((exchange_output(exchange, &url, redirects)?, Some(body)))
        } else {
            Ok((output(head, &url, redirects).await?, None))
        }
    };
    let (output, events) = tokio::select! {
        _ = cancellation.cancelled() => Err(cancelled()),
        result = tokio::time::timeout(Duration::from_millis(timeout), operation) => {
            match result {
                Ok(result) => result,
                Err(_) => Err(ApiError::new(StatusCode::REQUEST_TIMEOUT, "timeout")),
            }
        }
    }?;

    let output = HttpResponseOutput {
        cookies: jar.map(Jar::into_changes),
        ..output
    };
    let output = if substitutions.is_empty() {
        output
    } else {
        redact_output(output, &substitutions)
    };
    Ok((
        HttpResponseOutput {
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            stream: events.is_some().then_some("sse"),
            ..output
        },
        events.map(|body| EventStream {
            body,
            substitutions,
        }),
    ))
}

/// A successful `text/event-stream` reply, whatever its parameters.
fn is_event_stream(head: &Head) -> bool {
    head.status().is_success()
        && head
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
}

fn redact_output(output: HttpResponseOutput, substitutions: &Substitutions) -> HttpResponseOutput {
    let body = STANDARD
        .decode(&output.body_base64)
        .map(|body| STANDARD.encode(substitutions.redact(&body)))
        .unwrap_or(output.body_base64);
    HttpResponseOutput {
        url: substitutions.redact_str(&output.url),
        headers: output
            .headers
            .into_iter()
            .map(|header| HeaderEntry {
                name: header.name,
                value: substitutions.redact_str(&header.value),
            })
            .collect(),
        body_base64: body,
        cookies: output.cookies.map(|cookies| {
            cookies
                .into_iter()
                .map(|cookie| cookies::Cookie {
                    value: substitutions.redact_str(&cookie.value),
                    ..cookie
                })
                .collect()
        }),
        ..output
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_redirect_chain(
    mut method: Method,
    mut url: Url,
    mut headers: HeaderMap,
    mut body: Bytes,
    follow_redirects: bool,
    config: &AgentConfig,
    options: &RequestOptions<'_>,
    substitutions: &Substitutions,
    mut jar: Option<&mut Jar>,
) -> Result<(Head, Url, u8), ApiError> {
    let mut redirects: u8 = 0;
    loop {
        let jar_cookies = jar
            .as_deref()
            .and_then(|jar| jar.header(&url, cookies::now()));
        let hop_headers = jar_cookies.map(|value| with_jar_cookies(&headers, &value));
        let transport = Options {
            verify_tls: options.verify_tls,
            version: options.version,
            proxy: options.proxy_for(&url),
            // A redirect to a host outside the certificate's list goes without it.
            identity: options
                .client
                .as_ref()
                .filter(|(_, record)| record.allows(&url))
                .map(|(identity, _)| identity),
        };
        let head = http_transport::send(
            &method,
            &url,
            hop_headers.as_ref().unwrap_or(&headers),
            body.clone(),
            config,
            &transport,
        )
        .await?;
        if let Some(jar) = jar.as_deref_mut() {
            jar.store(&url, head.headers(), cookies::now());
        }

        if follow_redirects && is_followable_redirect(head.status()) {
            if let Some(location) = head.headers().get(LOCATION) {
                if usize::from(redirects) >= MAX_REDIRECTS {
                    return Err(ApiError::new(StatusCode::BAD_GATEWAY, "network_error"));
                }
                let location = location
                    .to_str()
                    .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "network_error"))?;
                let next_url = parse_redirect_url(&url, location)?;
                // A secret never follows a redirect to a host outside its list:
                // the page gets the 3xx itself.
                if !substitutions.is_empty() && !substitutions.host_allowed(&next_url) {
                    return Ok((head, url, redirects));
                }
                if url.scheme() == "https" && next_url.scheme() == "http" {
                    return Err(ApiError::new(StatusCode::FORBIDDEN, "target_denied"));
                }
                if !same_origin(&url, &next_url) {
                    retain_cross_origin_safe_headers(&mut headers);
                }
                rewrite_redirect_request(head.status(), &mut method, &mut body, &mut headers);
                url = next_url;
                redirects += 1;
                continue;
            }
        }

        return Ok((head, url, redirects));
    }
}

/// The hop's headers with the jar's cookies after a `Cookie` header written
/// by hand; a name set by hand wins over the jar's cookie of the same name.
fn with_jar_cookies(headers: &HeaderMap, jar_value: &str) -> HeaderMap {
    let mut headers = headers.clone();
    let explicit: Vec<String> = headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_owned)
        .collect();
    let written: Vec<&str> = explicit
        .iter()
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.split_once('=').map(|(name, _)| name.trim()))
        .collect();
    let added: Vec<&str> = jar_value
        .split("; ")
        .filter(|pair| {
            pair.split_once('=')
                .is_some_and(|(name, _)| !written.contains(&name))
        })
        .collect();
    let combined = explicit
        .iter()
        .map(String::as_str)
        .chain(added)
        .collect::<Vec<_>>()
        .join("; ");
    headers.remove(COOKIE);
    // from_bytes keeps UTF-8 cookie values that from_str would reject.
    if let Ok(value) = HeaderValue::from_bytes(combined.as_bytes()) {
        headers.insert(COOKIE, value);
    }
    headers
}

/// Per-request transport settings from the page.
struct RequestOptions<'a> {
    verify_tls: bool,
    version: HttpVersionChoice,
    proxy: Option<(Proxy, Vec<String>)>,
    client: Option<(ClientIdentity, &'a CertificateRecord)>,
}

impl RequestOptions<'_> {
    fn proxy_for(&self, url: &Url) -> Option<&Proxy> {
        proxy_for(self.proxy.as_ref(), url)
    }
}

/// The proxy for this URL, or none when its host matches a bypass pattern.
pub(crate) fn proxy_for<'a>(
    proxy: Option<&'a (Proxy, Vec<String>)>,
    url: &Url,
) -> Option<&'a Proxy> {
    let (proxy, bypass) = proxy?;
    let host = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let bypassed = bypass.iter().any(|pattern| {
        if let Some(suffix) = pattern.strip_prefix("*.") {
            host.len() > suffix.len() + 1
                && host.ends_with(suffix)
                && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
        } else {
            host == *pattern
        }
    });
    (!bypassed).then_some(proxy)
}

const MAX_PROXY_BYPASS: usize = 64;

pub(crate) fn parse_proxy(input: ProxyInput) -> Result<(Proxy, Vec<String>), ApiError> {
    let url = parse_url(&input.url)?;
    if url.scheme() != "http"
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::invalid_request());
    }
    let authorization = if input.username.is_empty() && input.password.is_empty() {
        None
    } else {
        let encoded = STANDARD.encode(format!("{}:{}", input.username, input.password));
        Some(
            HeaderValue::from_str(&format!("Basic {encoded}"))
                .map_err(|_| ApiError::invalid_request())?,
        )
    };
    if input.bypass.len() > MAX_PROXY_BYPASS
        || input
            .bypass
            .iter()
            .any(|pattern| pattern.is_empty() || pattern.len() > 253)
    {
        return Err(ApiError::invalid_request());
    }
    let bypass = input
        .bypass
        .iter()
        .map(|pattern| {
            pattern
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_ascii_lowercase()
        })
        .collect();
    Ok((
        Proxy {
            host: url.host().ok_or_else(ApiError::invalid_request)?.to_owned(),
            port: url
                .port_or_known_default()
                .ok_or_else(ApiError::invalid_request)?,
            authorization,
        },
        bypass,
    ))
}

async fn output(head: Head, url: &Url, redirects: u8) -> Result<HttpResponseOutput, ApiError> {
    exchange_output(head.read_body().await?, url, redirects)
}

fn exchange_output(
    exchange: Exchange,
    url: &Url,
    redirects: u8,
) -> Result<HttpResponseOutput, ApiError> {
    let headers = response_headers(&exchange.headers)?;
    Ok(HttpResponseOutput {
        status: exchange.status.as_u16(),
        status_text: exchange
            .reason
            .filter(|reason| !reason.is_empty())
            .unwrap_or_else(|| {
                exchange
                    .status
                    .canonical_reason()
                    .unwrap_or_default()
                    .to_owned()
            }),
        url: url.to_string(),
        headers,
        body_base64: STANDARD.encode(exchange.body),
        elapsed_ms: 0,
        http_version: exchange.version,
        remote_address: exchange.remote.to_string(),
        timings: exchange.timings,
        redirects,
        tls: exchange.tls,
        cookies: None,
        stream: None,
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

pub(crate) fn has_userinfo(url: &Url) -> bool {
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

pub(crate) fn parse_headers(entries: Vec<HeaderEntry>) -> Result<HeaderMap, ApiError> {
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
        headers.remove(CONTENT_TYPE);
        headers.remove(CONTENT_ENCODING);
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

fn cancelled() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "cancelled")
}
