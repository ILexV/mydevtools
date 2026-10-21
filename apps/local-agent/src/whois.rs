//! One WHOIS query to one public server on TCP port 43 (RFC 3912).
//! The agent writes a single line and reads until the server closes or the
//! reply reaches 64 KiB. A referral inside the text is not a second connection.

use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use crate::{
    model::ApiError,
    policy::enforce_destination,
    tcp::{self, classify_connect_error},
};

/// Queries in flight. Separate from HTTP, ICMP, DNS, TCP and TLS.
pub(crate) const MAX_CONCURRENT_QUERIES: usize = 2;
/// The only port this route dials. Callers cannot choose another.
pub(crate) const WHOIS_PORT: u16 = 43;
const MIN_TIMEOUT: Duration = Duration::from_millis(200);
const MAX_TIMEOUT: Duration = Duration::from_millis(10_000);
const MAX_QUERY_CHARS: usize = 255;
const MAX_REPLY_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WhoisLookupRequest {
    pub(crate) query: String,
    pub(crate) server: String,
    pub(crate) timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WhoisLookupResponse {
    pub(crate) query: String,
    pub(crate) server: String,
    pub(crate) port: u16,
    pub(crate) address: String,
    pub(crate) status: &'static str,
    pub(crate) elapsed_ms: u64,
    pub(crate) truncated: bool,
    pub(crate) text: String,
}

pub(crate) struct Prepared {
    query: String,
    server: String,
    timeout: Duration,
}

/// Syntax only. A bad query, a bad server, or a timeout outside 200..=10000 ms
/// does not take a query slot. The port is not a field: it is always 43.
pub(crate) fn prepare(query: &str, server: &str, timeout_ms: u64) -> Result<Prepared, ApiError> {
    let timeout = Duration::from_millis(timeout_ms);
    if timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT {
        return Err(ApiError::invalid_request());
    }
    Ok(Prepared {
        query: normalize_query(query)?,
        server: tcp::normalize_host(server)?,
        timeout,
    })
}

/// Resolves the server, applies the destination policy, and exchanges one line.
/// `port` is [`WHOIS_PORT`] on the HTTP route. Tests pass an ephemeral port.
pub(crate) async fn lookup_on_port(
    prepared: Prepared,
    agent_port: u16,
    allow_private: bool,
    port: u16,
) -> Result<WhoisLookupResponse, ApiError> {
    let server = prepared.server.clone();
    let address = tokio::task::spawn_blocking(move || tcp::resolve_host(&server))
        .await
        .map_err(|_| ApiError::busy())??;
    enforce_destination(address, port, agent_port, allow_private)?;
    let socket = SocketAddr::new(address, port);
    let started = Instant::now();
    let outcome = exchange(socket, &prepared.query, prepared.timeout).await;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let (status, truncated, text) = match outcome {
        Ok(reply) => ("ok", reply.truncated, reply.text),
        Err(ExchangeError::Timeout) => ("timeout", false, String::new()),
        Err(ExchangeError::Io(error)) => (whois_connect_status(error)?, false, String::new()),
    };
    Ok(WhoisLookupResponse {
        query: prepared.query,
        server: prepared.server,
        port,
        address: address.to_string(),
        status,
        elapsed_ms,
        truncated,
        text,
    })
}

struct Reply {
    text: String,
    truncated: bool,
}

enum ExchangeError {
    Timeout,
    Io(std::io::Error),
}

async fn exchange(
    socket: SocketAddr,
    query: &str,
    timeout: Duration,
) -> Result<Reply, ExchangeError> {
    match tokio::time::timeout(timeout, read_reply(socket, query)).await {
        Ok(Ok(reply)) => Ok(reply),
        Ok(Err(error)) => Err(ExchangeError::Io(error)),
        Err(_) => Err(ExchangeError::Timeout),
    }
}

/// Writes `query\r\n`, half-closes, and reads until EOF or the 64 KiB cap.
async fn read_reply(socket: SocketAddr, query: &str) -> std::io::Result<Reply> {
    let mut stream = TcpStream::connect(socket).await?;
    stream.write_all(query.as_bytes()).await?;
    stream.write_all(b"\r\n").await?;
    stream.shutdown().await?;
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut truncated = false;
    loop {
        if buf.len() >= MAX_REPLY_BYTES {
            let mut extra = [0_u8; 1];
            if stream.read(&mut extra).await.unwrap_or(0) > 0 {
                truncated = true;
            }
            break;
        }
        let n = match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) if !buf.is_empty() => break,
            Err(error) => return Err(error),
        };
        let room = MAX_REPLY_BYTES - buf.len();
        if n > room {
            buf.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(Reply {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    })
}

fn whois_connect_status(error: std::io::Error) -> Result<&'static str, ApiError> {
    match classify_connect_error(error) {
        Ok(status) => Ok(status),
        Err(_) => Err(ApiError::whois_unavailable()),
    }
}

/// One WHOIS line. A newline, a URL, or a numeric range is not a name.
fn normalize_query(raw: &str) -> Result<String, ApiError> {
    let query = raw.trim();
    if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
        return Err(ApiError::invalid_request());
    }
    if query.contains("://") || query.chars().any(|ch| ch.is_control()) {
        return Err(ApiError::invalid_request());
    }
    if let Some((left, right)) = query.split_once('-') {
        if !left.is_empty()
            && !right.is_empty()
            && !right.contains('-')
            && left.bytes().all(|byte| byte.is_ascii_digit())
            && right.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(ApiError::invalid_request());
        }
    }
    Ok(query.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_accepts_one_name_and_rejects_a_second_line() {
        let prepared = prepare(" example.com ", "whois.iana.org", 5_000).expect("name");
        assert_eq!(prepared.query, "example.com");
        assert_eq!(prepared.server, "whois.iana.org");
        assert!(prepare("example.com\nexample.org", "whois.iana.org", 5_000).is_err());
        assert!(prepare("80-443", "whois.iana.org", 5_000).is_err());
        assert!(prepare("http://example.com", "whois.iana.org", 5_000).is_err());
        assert!(prepare("example.com", "whois.iana.org:43", 5_000).is_err());
        assert!(prepare("example.com", "whois.iana.org", 199).is_err());
        assert!(prepare("example.com", "whois.iana.org", 10_001).is_err());
        assert!(prepare("  ", "whois.iana.org", 5_000).is_err());
        assert!(prepare("AS15169", "whois.iana.org", 200).is_ok());
    }
}
