//! One HTTP exchange on a fresh connection with timed phases (DNS, TCP, TLS,
//! first byte, download), a chosen HTTP version, optional TLS verification,
//! an optional client certificate and an optional HTTP proxy. Every resolved
//! address passes the destination policy; nothing is pooled between requests.

use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use axum::http::{
    HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, Version,
    header::{ACCEPT, HOST, PROXY_AUTHORIZATION, USER_AGENT},
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::{http1, http2};
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, PrivateKeyDer, ServerName, pem::PemObject},
    sign::CertifiedKey,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpStream, lookup_host},
};
use tokio_rustls::TlsConnector;
use url::{Host, Url};

use crate::{
    model::{ApiError, MAX_RESPONSE_BODY_BYTES},
    policy::enforce_destination,
    state::AgentConfig,
    tls,
};

pub(crate) const MAX_RESPONSE_HEADERS: usize = 256;
pub(crate) const MAX_RESPONSE_HEADER_BYTES: usize = 128 * 1024;
const MAX_PINNED_ADDRESSES: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PROXY_REPLY_BYTES: usize = 16 * 1024;
const MAX_CLIENT_CHAIN: usize = 8;
const USER_AGENT_VALUE: &str = concat!("MyDevTools-Local-Agent/", env!("CARGO_PKG_VERSION"));

/// Postman's "HTTP version" request setting. `auto` offers h2 and HTTP/1.1 by ALPN.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum HttpVersionChoice {
    #[default]
    Auto,
    Http1,
    Http2,
}

/// A plain HTTP proxy: `CONNECT` tunnels for https, absolute-form requests for http.
#[derive(Clone, Debug)]
pub(crate) struct Proxy {
    pub(crate) host: Host<String>,
    pub(crate) port: u16,
    pub(crate) authorization: Option<HeaderValue>,
}

/// Certificate chain and private key the agent presents when the server asks (mTLS).
#[derive(Debug)]
pub(crate) struct ClientIdentity {
    pub(crate) chain: Vec<CertificateDer<'static>>,
    pub(crate) key: PrivateKeyDer<'static>,
}

impl ClientIdentity {
    /// An unencrypted PEM key (PKCS#8, PKCS#1 or SEC1) and a PEM chain, leaf first.
    pub(crate) fn from_pem(certificate_pem: &str, key_pem: &str) -> Result<Self, ApiError> {
        let invalid = || ApiError::new(StatusCode::BAD_REQUEST, "client_certificate_invalid");
        let chain = CertificateDer::pem_slice_iter(certificate_pem.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| invalid())?;
        if chain.is_empty() || chain.len() > MAX_CLIENT_CHAIN {
            return Err(invalid());
        }
        let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).map_err(|_| invalid())?;
        // Loads the key and checks it belongs to the leaf certificate.
        CertifiedKey::from_der(chain.clone(), key.clone_key(), &tls::provider())
            .map_err(|_| invalid())?;
        Ok(Self { chain, key })
    }
}

pub(crate) struct Options<'a> {
    pub(crate) verify_tls: bool,
    pub(crate) version: HttpVersionChoice,
    pub(crate) proxy: Option<&'a Proxy>,
    pub(crate) identity: Option<&'a ClientIdentity>,
}

/// Phase durations of the last connection in milliseconds; `tls_ms` is absent for http.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Timings {
    pub(crate) dns_ms: f64,
    pub(crate) connect_ms: f64,
    pub(crate) tls_ms: Option<f64>,
    pub(crate) first_byte_ms: f64,
    pub(crate) download_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TlsSummary {
    pub(crate) protocol: String,
    pub(crate) cipher: String,
    /// False when verification was turned off for this request.
    pub(crate) verified: bool,
}

pub(crate) struct Exchange {
    pub(crate) status: StatusCode,
    pub(crate) reason: Option<String>,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Vec<u8>,
    pub(crate) version: &'static str,
    pub(crate) remote: SocketAddr,
    pub(crate) timings: Timings,
    pub(crate) tls: Option<TlsSummary>,
}

/// The response head; the body is read by `Exchange::read_body`.
pub(crate) struct Head {
    response: hyper::Response<hyper::body::Incoming>,
    started_body: Instant,
    exchange: Exchange,
    _driver: AbortOnDrop,
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) trait Io: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Io for T {}

/// A connected stream to the URL's host: policy-checked addresses, the proxy
/// tunnel when set, TLS for https and wss.
pub(crate) struct Connection {
    pub(crate) stream: Box<dyn Io>,
    pub(crate) remote: SocketAddr,
    pub(crate) timings: Timings,
    pub(crate) tls: Option<TlsSummary>,
    alpn_h2: bool,
}

/// Opens the connection a request or a WebSocket runs on. `tunnel_plain`
/// tunnels a plain target through the proxy too (WebSocket); plain HTTP uses
/// absolute-form instead.
pub(crate) async fn open(
    url: &Url,
    tunnel_plain: bool,
    config: &AgentConfig,
    options: &Options<'_>,
) -> Result<Connection, ApiError> {
    let host = url.host().ok_or_else(ApiError::invalid_request)?.to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(ApiError::invalid_request)?;
    if port == 0 {
        return Err(ApiError::invalid_request());
    }
    let secure = matches!(url.scheme(), "https" | "wss");
    let mut timings = Timings::default();

    let (connect_host, connect_port) = match options.proxy {
        Some(proxy) => {
            // The proxy resolves a named target; a literal one is still checked here.
            if let Some(address) = literal(&host) {
                enforce_destination(address, port, config.port, config.allow_private)?;
            }
            (proxy.host.clone(), proxy.port)
        }
        None => (host.clone(), port),
    };
    let started = Instant::now();
    let addresses = resolve(&connect_host, connect_port, config).await?;
    timings.dns_ms = millis(started.elapsed());

    let started = Instant::now();
    let (tcp, remote) = connect(&addresses).await?;
    let mut stream: Box<dyn Io> = Box::new(tcp);
    if let (Some(proxy), true) = (options.proxy, secure || tunnel_plain) {
        stream = Box::new(tunnel(stream, &host, port, proxy).await?);
    }
    timings.connect_ms = millis(started.elapsed());

    let mut tls_summary = None;
    let mut alpn_h2 = false;
    if secure {
        let started = Instant::now();
        let connector = TlsConnector::from(client_config(options)?);
        let tls_stream = connector
            .connect(server_name(&host)?, stream)
            .await
            .map_err(map_tls_error)?;
        timings.tls_ms = Some(millis(started.elapsed()));
        let (_, session) = tls_stream.get_ref();
        alpn_h2 = session.alpn_protocol() == Some(b"h2");
        tls_summary = Some(TlsSummary {
            protocol: session
                .protocol_version()
                .and_then(|version| version.as_str())
                .unwrap_or("unknown")
                .to_owned(),
            cipher: session
                .negotiated_cipher_suite()
                .and_then(|suite| suite.suite().as_str())
                .unwrap_or("unknown")
                .to_owned(),
            verified: options.verify_tls,
        });
        stream = Box::new(tls_stream);
    }
    Ok(Connection {
        stream,
        remote,
        timings,
        tls: tls_summary,
        alpn_h2,
    })
}

/// Sends one request and waits for the response head.
pub(crate) async fn send(
    method: &Method,
    url: &Url,
    headers: &HeaderMap,
    body: Bytes,
    config: &AgentConfig,
    options: &Options<'_>,
) -> Result<Head, ApiError> {
    let https = url.scheme() == "https";
    let Connection {
        stream,
        remote,
        mut timings,
        tls: tls_summary,
        alpn_h2,
    } = open(url, false, config, options).await?;
    if https && options.version == HttpVersionChoice::Http2 && !alpn_h2 {
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "http2_unsupported"));
    }
    let use_h2 = if https {
        alpn_h2
    } else {
        options.version == HttpVersionChoice::Http2 && options.proxy.is_none()
    };

    let absolute_form = options.proxy.is_some() && !https;
    let request = build_request(method, url, headers, body, use_h2, absolute_form, options)?;
    let started = Instant::now();
    let (response, driver) = if use_h2 {
        let (mut sender, connection) = http2::Builder::new(TokioExecutor::new())
            .max_header_list_size(MAX_RESPONSE_HEADER_BYTES as u32)
            .handshake(TokioIo::new(stream))
            .await
            .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "http2_unsupported"))?;
        let driver = AbortOnDrop(tokio::spawn(async move {
            let _ = connection.await;
        }));
        (sender.send_request(request).await, driver)
    } else {
        let (mut sender, connection) = http1::Builder::new()
            .max_headers(MAX_RESPONSE_HEADERS + 1)
            .handshake(TokioIo::new(stream))
            .await
            .map_err(|_| network_error())?;
        let driver = AbortOnDrop(tokio::spawn(async move {
            let _ = connection.await;
        }));
        (sender.send_request(request).await, driver)
    };
    let response = response.map_err(map_hyper_error)?;
    timings.first_byte_ms = millis(started.elapsed());

    let reason = response
        .extensions()
        .get::<hyper::ext::ReasonPhrase>()
        .map(|phrase| String::from_utf8_lossy(phrase.as_bytes()).into_owned());
    let version = match response.version() {
        Version::HTTP_2 => "HTTP/2",
        Version::HTTP_10 => "HTTP/1.0",
        _ => "HTTP/1.1",
    };
    Ok(Head {
        exchange: Exchange {
            status: response.status(),
            reason,
            headers: response.headers().clone(),
            body: Vec::new(),
            version,
            remote,
            timings,
            tls: tls_summary,
        },
        response,
        started_body: Instant::now(),
        _driver: driver,
    })
}

impl Head {
    pub(crate) fn status(&self) -> StatusCode {
        self.exchange.status
    }

    pub(crate) fn headers(&self) -> &HeaderMap {
        &self.exchange.headers
    }

    /// The head without reading the body, and the body to read as it arrives (event streams).
    pub(crate) fn into_stream(self) -> (Exchange, BodyStream) {
        let Head {
            response,
            started_body: _,
            exchange,
            _driver,
        } = self;
        (
            exchange,
            BodyStream {
                body: response.into_body(),
                _driver,
            },
        )
    }

    /// Reads the body up to the response limit; an announced larger length fails first.
    pub(crate) async fn read_body(self) -> Result<Exchange, ApiError> {
        let Head {
            response,
            started_body,
            mut exchange,
            _driver,
        } = self;
        if exchange
            .headers
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
        {
            return Err(response_too_large());
        }
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(map_hyper_error)?;
            if let Some(chunk) = frame.data_ref() {
                if chunk.len() > MAX_RESPONSE_BODY_BYTES.saturating_sub(bytes.len()) {
                    return Err(response_too_large());
                }
                bytes.extend_from_slice(chunk);
            }
        }
        exchange.timings.download_ms = millis(started_body.elapsed());
        exchange.body = bytes;
        Ok(exchange)
    }
}

/// A response body read chunk by chunk; the connection lives as long as it does.
pub(crate) struct BodyStream {
    body: hyper::body::Incoming,
    _driver: AbortOnDrop,
}

impl BodyStream {
    /// The next data chunk, none at the end; trailers are skipped.
    pub(crate) async fn chunk(&mut self) -> Option<Result<Bytes, ApiError>> {
        loop {
            match self.body.frame().await? {
                Ok(frame) => {
                    if let Ok(data) = frame.into_data() {
                        return Some(Ok(data));
                    }
                }
                Err(error) => return Some(Err(map_hyper_error(error))),
            }
        }
    }
}

fn build_request(
    method: &Method,
    url: &Url,
    headers: &HeaderMap,
    body: Bytes,
    h2: bool,
    absolute_form: bool,
    options: &Options<'_>,
) -> Result<Request<Full<Bytes>>, ApiError> {
    let target = if h2 || absolute_form {
        let mut absolute = url.clone();
        absolute.set_fragment(None);
        absolute.to_string()
    } else {
        let mut path = url.path().to_owned();
        if let Some(query) = url.query() {
            path.push('?');
            path.push_str(query);
        }
        path
    };
    let uri: Uri = target.parse().map_err(|_| ApiError::invalid_request())?;
    let mut request = Request::builder()
        .method(method.clone())
        .uri(uri)
        .version(if h2 {
            Version::HTTP_2
        } else {
            Version::HTTP_11
        })
        .body(Full::new(body))
        .map_err(|_| ApiError::invalid_request())?;
    let request_headers = request.headers_mut();
    request_headers.extend(headers.clone());
    if !h2 {
        request_headers.insert(HOST, host_header(url)?);
    }
    if !request_headers.contains_key(USER_AGENT) {
        request_headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    }
    if !request_headers.contains_key(ACCEPT) {
        request_headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    }
    if absolute_form {
        if let Some(authorization) = options.proxy.and_then(|proxy| proxy.authorization.clone()) {
            request_headers.insert(PROXY_AUTHORIZATION, authorization);
        }
    }
    Ok(request)
}

fn host_header(url: &Url) -> Result<HeaderValue, ApiError> {
    let host = match url.host().ok_or_else(ApiError::invalid_request)? {
        Host::Ipv6(address) => format!("[{address}]"),
        other => other.to_string(),
    };
    let value = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    HeaderValue::from_str(&value).map_err(|_| ApiError::invalid_request())
}

fn literal(host: &Host<String>) -> Option<IpAddr> {
    match host {
        Host::Ipv4(address) => Some(IpAddr::V4(*address)),
        Host::Ipv6(address) => Some(IpAddr::V6(*address)),
        Host::Domain(_) => None,
    }
}

/// All addresses of the host, each checked by the destination policy.
async fn resolve(
    host: &Host<String>,
    port: u16,
    config: &AgentConfig,
) -> Result<Vec<SocketAddr>, ApiError> {
    if let Some(address) = literal(host) {
        enforce_destination(address, port, config.port, config.allow_private)?;
        return Ok(vec![SocketAddr::new(address, port)]);
    }
    let Host::Domain(domain) = host else {
        return Err(ApiError::invalid_request());
    };
    let resolved = lookup_host((domain.as_str(), port))
        .await
        .map_err(|_| network_error())?;
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
        return Err(network_error());
    }
    Ok(addresses)
}

/// Tries the addresses in resolver order within one connect timeout.
async fn connect(addresses: &[SocketAddr]) -> Result<(TcpStream, SocketAddr), ApiError> {
    let attempt = async {
        for address in addresses {
            if let Ok(stream) = TcpStream::connect(address).await {
                let _ = stream.set_nodelay(true);
                return Ok((stream, *address));
            }
        }
        Err(network_error())
    };
    tokio::time::timeout(CONNECT_TIMEOUT, attempt)
        .await
        .map_err(|_| ApiError::new(StatusCode::REQUEST_TIMEOUT, "timeout"))?
}

/// `CONNECT host:port` through the proxy; any status but 2xx stops the request.
async fn tunnel(
    mut stream: Box<dyn Io>,
    host: &Host<String>,
    port: u16,
    proxy: &Proxy,
) -> Result<Box<dyn Io>, ApiError> {
    let authority = match host {
        Host::Ipv6(address) => format!("[{address}]:{port}"),
        other => format!("{other}:{port}"),
    };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(authorization) = &proxy.authorization {
        request.push_str("Proxy-Authorization: ");
        request.push_str(
            authorization
                .to_str()
                .map_err(|_| ApiError::invalid_request())?,
        );
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| proxy_failed())?;
    let mut reply = Vec::with_capacity(256);
    let mut byte = [0_u8; 1];
    // Byte by byte so nothing after the reply head (the TLS handshake) is consumed.
    while !reply.ends_with(b"\r\n\r\n") {
        if reply.len() >= MAX_PROXY_REPLY_BYTES {
            return Err(proxy_failed());
        }
        let read = stream.read(&mut byte).await.map_err(|_| proxy_failed())?;
        if read == 0 {
            return Err(proxy_failed());
        }
        reply.push(byte[0]);
    }
    let status = reply
        .split(|byte| *byte == b' ')
        .nth(1)
        .and_then(|code| std::str::from_utf8(code).ok())
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(proxy_failed)?;
    if !reply.starts_with(b"HTTP/1.") {
        return Err(proxy_failed());
    }
    match status {
        200..=299 => Ok(stream),
        407 => Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "proxy_auth_required",
        )),
        _ => Err(proxy_failed()),
    }
}

fn server_name(host: &Host<String>) -> Result<ServerName<'static>, ApiError> {
    match host {
        Host::Domain(domain) => {
            ServerName::try_from(domain.clone()).map_err(|_| ApiError::invalid_request())
        }
        Host::Ipv4(address) => Ok(ServerName::IpAddress(IpAddr::V4(*address).into())),
        Host::Ipv6(address) => Ok(ServerName::IpAddress(IpAddr::V6(*address).into())),
    }
}

fn alpn(version: HttpVersionChoice) -> Vec<Vec<u8>> {
    match version {
        HttpVersionChoice::Auto => vec![b"h2".to_vec(), b"http/1.1".to_vec()],
        HttpVersionChoice::Http1 => vec![b"http/1.1".to_vec()],
        HttpVersionChoice::Http2 => vec![b"h2".to_vec()],
    }
}

/// Cached per (verify, version) without a client certificate; built per request with one.
fn client_config(options: &Options<'_>) -> Result<Arc<ClientConfig>, ApiError> {
    // Through a proxy plain HTTP/1.1 is used for http; https keeps ALPN.
    let version = options.version;
    if let Some(identity) = options.identity {
        let mut config = config_builder(options.verify_tls)
            .with_client_auth_cert(identity.chain.clone(), identity.key.clone_key())
            .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "client_certificate_invalid"))?;
        config.alpn_protocols = alpn(version);
        return Ok(Arc::new(config));
    }
    static CACHE: OnceLock<[Arc<ClientConfig>; 6]> = OnceLock::new();
    let cache = CACHE.get_or_init(|| {
        let make = |verify: bool, version: HttpVersionChoice| {
            let mut config = config_builder(verify).with_no_client_auth();
            config.alpn_protocols = alpn(version);
            Arc::new(config)
        };
        [
            make(true, HttpVersionChoice::Auto),
            make(true, HttpVersionChoice::Http1),
            make(true, HttpVersionChoice::Http2),
            make(false, HttpVersionChoice::Auto),
            make(false, HttpVersionChoice::Http1),
            make(false, HttpVersionChoice::Http2),
        ]
    });
    let index = usize::from(!options.verify_tls) * 3
        + match version {
            HttpVersionChoice::Auto => 0,
            HttpVersionChoice::Http1 => 1,
            HttpVersionChoice::Http2 => 2,
        };
    Ok(Arc::clone(&cache[index]))
}

fn config_builder(
    verify: bool,
) -> rustls::ConfigBuilder<ClientConfig, rustls::client::WantsClientCert> {
    let builder = ClientConfig::builder_with_provider(tls::provider())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions");
    if verify {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots)
    } else {
        // Handshake signatures are still checked; only the chain and name are not.
        builder
            .dangerous()
            .with_custom_certificate_verifier(tls::observe_verifier())
    }
}

fn map_tls_error(error: std::io::Error) -> ApiError {
    match error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        Some(rustls::Error::InvalidCertificate(_)) => {
            ApiError::new(StatusCode::BAD_GATEWAY, "tls_certificate_invalid")
        }
        Some(_) => ApiError::new(StatusCode::BAD_GATEWAY, "tls_handshake_failed"),
        None => network_error(),
    }
}

fn map_hyper_error(error: hyper::Error) -> ApiError {
    if error.is_parse_too_large() {
        response_too_large()
    } else {
        network_error()
    }
}

fn millis(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 100_000.0).round() / 100.0
}

fn network_error() -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, "network_error")
}

fn proxy_failed() -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, "proxy_failed")
}

pub(crate) fn response_too_large() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "response_too_large")
}
