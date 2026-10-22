//! WebSocket connections (`websocket.connect`). The handshake runs on the
//! agent's own connection: policy-checked addresses, the proxy tunnel, TLS
//! verification and a host-bound client certificate, as for `http.request`.
//! The page reads the handshake and every frame as NDJSON lines from
//! `/v1/ws/connect`, and sends with `/v1/ws/send` and `/v1/ws/close`.

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    body::Body,
    http::{HeaderValue, Request, StatusCode, header::HOST},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, mpsc};
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config,
    tungstenite::{
        self, Message,
        handshake::client::generate_key,
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::{
    http_client::{MAX_URL_BYTES, has_userinfo, parse_headers, parse_proxy, proxy_for},
    http_transport::{self, HttpVersionChoice, Io, Options, TlsSummary},
    model::{ApiError, HeaderEntry, MAX_TIMEOUT_MS, ProxyInput},
    state::{ActiveRequestGuard, AgentConfig, AgentState, SessionKey},
    vault::{self, CertificateRecord, SecretBook, Substitutions},
};

/// One message either way; bigger incoming ones end the connection.
pub(crate) const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_PROTOCOLS: usize = 16;
const MAX_REJECTED_BODY_BYTES: usize = 64 * 1024;
/// How long a close waits for the other side's close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

const fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectInput {
    pub(crate) id: String,
    url: String,
    #[serde(default)]
    headers: Vec<HeaderEntry>,
    /// Offered in `Sec-WebSocket-Protocol`; the server picks one.
    #[serde(default)]
    protocols: Vec<String>,
    /// For the handshake; the open connection has no time limit.
    timeout_ms: u64,
    #[serde(default = "default_true")]
    verify_tls: bool,
    #[serde(default)]
    proxy: Option<ProxyInput>,
    #[serde(default)]
    pub(crate) client_certificate: Option<String>,
}

impl ConnectInput {
    /// True when the URL or a header value has `{{secret:`.
    pub(crate) fn mentions_secret(&self) -> bool {
        vault::mentions_secret(self.url.as_bytes())
            || self
                .headers
                .iter()
                .any(|header| vault::mentions_secret(header.value.as_bytes()))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendInput {
    pub(crate) id: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    binary_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloseInput {
    pub(crate) id: String,
    #[serde(default)]
    code: Option<u16>,
    #[serde(default)]
    reason: Option<String>,
}

enum Command {
    Send(Message),
    Close(Option<CloseFrame>),
}

/// Open connections the page can send to, by session and request id.
#[derive(Default)]
pub(crate) struct Sockets(Mutex<HashMap<(SessionKey, Uuid), mpsc::Sender<Command>>>);

impl Sockets {
    fn sender(&self, session: SessionKey, id: Uuid) -> Result<mpsc::Sender<Command>, ApiError> {
        self.0
            .lock()
            .get(&(session, id))
            .cloned()
            .ok_or_else(ApiError::not_found)
    }

    pub(crate) async fn send(
        &self,
        session: SessionKey,
        id: Uuid,
        input: SendInput,
    ) -> Result<(), ApiError> {
        let message = match (input.text, input.binary_base64) {
            (Some(text), None) => Message::text(text),
            (None, Some(encoded)) => Message::binary(
                STANDARD
                    .decode(encoded)
                    .map_err(|_| ApiError::invalid_request())?,
            ),
            _ => return Err(ApiError::invalid_request()),
        };
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
            ));
        }
        self.sender(session, id)?
            .send(Command::Send(message))
            .await
            .map_err(|_| ApiError::not_found())
    }

    /// Code 1000 or an application code 3000–4999; the reason fits a control frame.
    pub(crate) async fn close(
        &self,
        session: SessionKey,
        id: Uuid,
        input: CloseInput,
    ) -> Result<(), ApiError> {
        let reason = input.reason.unwrap_or_default();
        let code = input.code.unwrap_or(1000);
        if !(code == 1000 || (3000..=4999).contains(&code)) || reason.len() > 123 {
            return Err(ApiError::invalid_request());
        }
        self.sender(session, id)?
            .send(Command::Close(Some(CloseFrame {
                code: CloseCode::from(code),
                reason: reason.into(),
            })))
            .await
            .map_err(|_| ApiError::not_found())
    }
}

/// Removes the connection from `Sockets` when its task ends.
struct Registered {
    state: Arc<AgentState>,
    key: (SessionKey, Uuid),
}

impl Drop for Registered {
    fn drop(&mut self) {
        self.state.sockets.0.lock().remove(&self.key);
    }
}

/// One NDJSON line of the connection.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Line {
    #[serde(rename_all = "camelCase")]
    Open {
        status: u16,
        headers: Vec<HeaderEntry>,
        protocol: Option<String>,
        remote_address: String,
        tls: Option<TlsSummary>,
    },
    /// The server answered the handshake with an HTTP reply instead of 101.
    #[serde(rename_all = "camelCase")]
    Rejected {
        status: u16,
        headers: Vec<HeaderEntry>,
        body_base64: String,
    },
    #[serde(rename_all = "camelCase")]
    Message {
        kind: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data_base64: Option<String>,
    },
    /// `initiator` is `server`, `client` (the page) or `agent` (cancel, revoked session).
    Close {
        code: u16,
        reason: String,
        initiator: &'static str,
    },
    Error {
        code: &'static str,
    },
}

fn line(value: &Line) -> Bytes {
    let mut bytes = serde_json::to_vec(value).unwrap_or_default();
    bytes.push(b'\n');
    Bytes::from(bytes)
}

pub(crate) enum Handshake {
    Open(Box<WebSocketStream<Box<dyn Io>>>, Line),
    Rejected(Line),
}

fn header_entries<'a>(
    headers: impl Iterator<Item = (&'a axum::http::HeaderName, &'a HeaderValue)>,
) -> Vec<HeaderEntry> {
    headers
        .map(|(name, value)| HeaderEntry {
            name: name.as_str().to_owned(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        })
        .collect()
}

/// Validates the input and runs the handshake within its timeout.
pub(crate) async fn connect(
    input: ConnectInput,
    config: &AgentConfig,
    secrets: Option<&SecretBook>,
    certificate: Option<&CertificateRecord>,
) -> Result<(Handshake, Substitutions), ApiError> {
    if input.timeout_ms == 0 || input.timeout_ms > MAX_TIMEOUT_MS {
        return Err(ApiError::invalid_request());
    }
    let mut substitutions = Substitutions::default();
    let mut url_text = input.url;
    let mut header_entries_in = input.headers;
    if let Some(book) = secrets {
        url_text = String::from_utf8(substitutions.apply(url_text.as_bytes(), book)?)
            .map_err(|_| ApiError::invalid_request())?;
        for entry in &mut header_entries_in {
            entry.value = String::from_utf8(substitutions.apply(entry.value.as_bytes(), book)?)
                .map_err(|_| ApiError::invalid_request())?;
        }
    }
    if url_text.is_empty() || url_text.len() > MAX_URL_BYTES {
        return Err(ApiError::invalid_request());
    }
    let url = Url::parse(&url_text).map_err(|_| ApiError::invalid_request())?;
    if !matches!(url.scheme(), "ws" | "wss")
        || url.host().is_none()
        || has_userinfo(&url)
        || url.port() == Some(0)
        || url.fragment().is_some()
    {
        return Err(ApiError::invalid_request());
    }
    if !substitutions.is_empty() && !substitutions.host_allowed(&url) {
        return Err(vault::secret_host_denied());
    }
    let headers = parse_headers(header_entries_in)?;
    if headers
        .keys()
        .any(|name| name.as_str().starts_with("sec-websocket-"))
    {
        return Err(ApiError::invalid_request());
    }
    if input.protocols.len() > MAX_PROTOCOLS
        || input.protocols.iter().any(|protocol| {
            protocol.is_empty()
                || !protocol
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic() && !b"()<>@,;:\\\"/[]?={}".contains(&byte))
        })
    {
        return Err(ApiError::invalid_request());
    }
    let identity = match certificate {
        Some(record) if !record.allows(&url) => return Err(vault::certificate_host_denied()),
        Some(record) => Some(record.identity()?),
        None => None,
    };
    let proxy = input.proxy.map(parse_proxy).transpose()?;
    let options = Options {
        verify_tls: input.verify_tls,
        // WebSocket upgrades are HTTP/1.1: ALPN offers only that.
        version: HttpVersionChoice::Http1,
        proxy: proxy_for(proxy.as_ref(), &url),
        identity: identity.as_ref(),
    };

    let mut request = Request::builder()
        .uri(url.as_str())
        .header(HOST, host_header(&url)?)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .body(())
        .map_err(|_| ApiError::invalid_request())?;
    if !input.protocols.is_empty() {
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&input.protocols.join(", "))
                .map_err(|_| ApiError::invalid_request())?,
        );
    }
    request.headers_mut().extend(headers);

    let handshake = async {
        let connection = http_transport::open(&url, true, config, &options).await?;
        let remote = connection.remote;
        let tls = connection.tls;
        let socket_config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        match client_async_with_config(request, connection.stream, Some(socket_config)).await {
            Ok((socket, response)) => {
                let protocol = response
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                Ok(Handshake::Open(
                    Box::new(socket),
                    Line::Open {
                        status: response.status().as_u16(),
                        headers: header_entries(response.headers().iter()),
                        protocol,
                        remote_address: remote.to_string(),
                        tls,
                    },
                ))
            }
            Err(tungstenite::Error::Http(response)) => {
                let body = response.body().as_deref().unwrap_or_default();
                Ok(Handshake::Rejected(Line::Rejected {
                    status: response.status().as_u16(),
                    headers: header_entries(response.headers().iter()),
                    body_base64: STANDARD.encode(&body[..body.len().min(MAX_REJECTED_BODY_BYTES)]),
                }))
            }
            Err(tungstenite::Error::Io(_) | tungstenite::Error::ConnectionClosed) => {
                Err(ApiError::new(StatusCode::BAD_GATEWAY, "network_error"))
            }
            Err(_) => Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "websocket_handshake_failed",
            )),
        }
    };
    let handshake = tokio::time::timeout(Duration::from_millis(input.timeout_ms), handshake)
        .await
        .map_err(|_| ApiError::new(StatusCode::REQUEST_TIMEOUT, "timeout"))??;
    Ok((handshake, substitutions))
}

fn host_header(url: &Url) -> Result<String, ApiError> {
    let host = url.host_str().ok_or_else(ApiError::invalid_request)?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

/// The response body: the handshake line, then frames until a close. The
/// page closing its reader, a cancel or a revoked session closes the socket.
#[allow(clippy::too_many_arguments)]
pub(crate) fn body(
    state: Arc<AgentState>,
    session: SessionKey,
    id: Uuid,
    handshake: Handshake,
    substitutions: Substitutions,
    cancellation: CancellationToken,
    guard: ActiveRequestGuard,
    permit: OwnedSemaphorePermit,
) -> Body {
    let (events, receiver) = mpsc::channel::<Bytes>(16);
    let (commands_sender, mut commands) = mpsc::channel::<Command>(16);
    let registered = matches!(handshake, Handshake::Open(..)).then(|| {
        state
            .sockets
            .0
            .lock()
            .insert((session, id), commands_sender);
        Registered {
            state,
            key: (session, id),
        }
    });
    tokio::spawn(async move {
        let _held = (guard, permit, registered);
        let (mut socket, open) = match handshake {
            Handshake::Open(socket, open) => (socket, open),
            Handshake::Rejected(rejected) => {
                let _ = events.send(line(&rejected)).await;
                return;
            }
        };
        if events.send(line(&open)).await.is_err() {
            return;
        }
        // Who started the close, and until when its echo is awaited.
        let mut closing: Option<(&'static str, tokio::time::Instant)> = None;
        let last = loop {
            let deadline = closing.map(|(_, until)| until);
            tokio::select! {
                _ = cancellation.cancelled(), if closing.is_none() => {
                    closing = Some(("agent", tokio::time::Instant::now() + CLOSE_GRACE));
                    let frame = CloseFrame { code: CloseCode::Away, reason: "".into() };
                    if socket.send(Message::Close(Some(frame))).await.is_err() {
                        break Line::Close { code: 1001, reason: String::new(), initiator: "agent" };
                    }
                }
                _ = events.closed() => {
                    let _ = tokio::time::timeout(CLOSE_GRACE, socket.close()).await;
                    return;
                }
                Some(command) = commands.recv(), if closing.is_none() => match command {
                    Command::Send(message) => {
                        if socket.send(message).await.is_err() {
                            break Line::Error { code: "network_error" };
                        }
                    }
                    Command::Close(frame) => {
                        closing = Some(("client", tokio::time::Instant::now() + CLOSE_GRACE));
                        if socket.send(Message::Close(frame)).await.is_err() {
                            break Line::Close { code: 1006, reason: String::new(), initiator: "client" };
                        }
                    }
                },
                () = sleep_until(deadline), if closing.is_some() => {
                    let initiator = closing.map_or("agent", |(who, _)| who);
                    break Line::Close { code: 1006, reason: String::new(), initiator };
                }
                frame = socket.next() => {
                    let initiator = closing.map_or("server", |(who, _)| who);
                    match frame {
                        Some(Ok(Message::Text(text))) => {
                            let data = if substitutions.is_empty() {
                                text.as_str().to_owned()
                            } else {
                                substitutions.redact_str(text.as_str())
                            };
                            let message = Line::Message { kind: "text", data: Some(data), data_base64: None };
                            if events.send(line(&message)).await.is_err() {
                                return;
                            }
                        }
                        Some(Ok(Message::Binary(bytes))) => {
                            let bytes = if substitutions.is_empty() { bytes.to_vec() } else { substitutions.redact(&bytes) };
                            let message = Line::Message { kind: "binary", data: None, data_base64: Some(STANDARD.encode(bytes)) };
                            if events.send(line(&message)).await.is_err() {
                                return;
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            let (code, reason) = frame.map_or((1005, String::new()), |frame| {
                                (u16::from(frame.code), frame.reason.as_str().to_owned())
                            });
                            break Line::Close { code, reason, initiator };
                        }
                        // Pings are answered by the library; pongs and raw frames are not shown.
                        Some(Ok(_)) => {}
                        Some(Err(tungstenite::Error::Capacity(_))) => break Line::Error { code: "message_too_large" },
                        Some(Err(
                            tungstenite::Error::ConnectionClosed
                            | tungstenite::Error::AlreadyClosed
                            | tungstenite::Error::Protocol(tungstenite::error::ProtocolError::ResetWithoutClosingHandshake),
                        ))
                        | None => {
                            break Line::Close { code: 1006, reason: String::new(), initiator };
                        }
                        Some(Err(_)) => break Line::Error { code: "network_error" },
                    }
                }
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), socket.close()).await;
        let _ = events.send(line(&last)).await;
    });
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move {
            receiver
                .recv()
                .await
                .map(|bytes| (Ok::<_, std::convert::Infallible>(bytes), receiver))
        },
    ))
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
