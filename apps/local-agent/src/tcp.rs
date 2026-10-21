//! One TCP connection to one host and one port. The elapsed time is the
//! handshake, then the socket is closed. A range, a list, and a banner grab
//! are rejected so this stays a single check.

use std::{
    io::ErrorKind,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;

use crate::{model::ApiError, policy::enforce_destination};

/// Connects in flight. Separate from the HTTP, ICMP and DNS caps.
pub(crate) const MAX_CONCURRENT_CONNECTS: usize = 2;
const MIN_TIMEOUT: Duration = Duration::from_millis(200);
const MAX_TIMEOUT: Duration = Duration::from_millis(10_000);
const MAX_HOST_CHARS: usize = 253;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TcpConnectRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TcpConnectResponse {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) address: String,
    pub(crate) status: &'static str,
    pub(crate) elapsed_ms: u64,
}

pub(crate) struct Prepared {
    host: String,
    port: u16,
    timeout: Duration,
}

/// Syntax only. A bad host, port 0, or a timeout outside 200..=10000 ms does
/// not take a connect slot. A port range in the host is `invalid_request`.
pub(crate) fn prepare(host: &str, port: u16, timeout_ms: u64) -> Result<Prepared, ApiError> {
    if port == 0 {
        return Err(ApiError::invalid_request());
    }
    let timeout = Duration::from_millis(timeout_ms);
    if timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT {
        return Err(ApiError::invalid_request());
    }
    Ok(Prepared {
        host: normalize_host(host)?,
        port,
        timeout,
    })
}

/// Resolves the first address, applies the same destination policy as HTTP,
/// and connects once. The socket is closed without sending data.
pub(crate) async fn connect_prepared(
    prepared: Prepared,
    agent_port: u16,
    allow_private: bool,
) -> Result<TcpConnectResponse, ApiError> {
    let host = prepared.host.clone();
    let address = tokio::task::spawn_blocking(move || resolve_host(&host))
        .await
        .map_err(|_| ApiError::busy())??;
    enforce_destination(address, prepared.port, agent_port, allow_private)?;
    let socket = SocketAddr::new(address, prepared.port);
    let started = Instant::now();
    let outcome = tokio::time::timeout(prepared.timeout, TcpStream::connect(socket)).await;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let status = match outcome {
        Ok(Ok(stream)) => {
            drop(stream);
            "open"
        }
        Ok(Err(error)) => classify_connect_error(error)?,
        Err(_) => "timeout",
    };
    Ok(TcpConnectResponse {
        host: prepared.host,
        port: prepared.port,
        address: address.to_string(),
        status,
        elapsed_ms,
    })
}

fn normalize_host(raw: &str) -> Result<String, ApiError> {
    let host = raw.trim();
    if host.is_empty() || host.chars().count() > MAX_HOST_CHARS {
        return Err(ApiError::invalid_request());
    }
    let host = if let Some(inner) = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    {
        if inner.parse::<IpAddr>().is_err() {
            return Err(ApiError::invalid_request());
        }
        inner
    } else {
        host
    };
    if host.contains("://")
        || host.chars().any(|ch| {
            ch.is_whitespace()
                || ch.is_control()
                || matches!(ch, '/' | '\\' | '@' | '?' | '#' | ',' | '*' | '%')
        })
    {
        return Err(ApiError::invalid_request());
    }
    if host.contains(':') && host.parse::<IpAddr>().is_err() {
        return Err(ApiError::invalid_request());
    }
    if is_port_range(host) {
        return Err(ApiError::invalid_request());
    }
    Ok(host.to_owned())
}

/// `80-443` in the host field is a range, not a name. One hyphenated word
/// that is not all digits stays a host name.
fn is_port_range(host: &str) -> bool {
    let Some((left, right)) = host.split_once('-') else {
        return false;
    };
    !left.is_empty()
        && !right.is_empty()
        && !right.contains('-')
        && left.bytes().all(|byte| byte.is_ascii_digit())
        && right.bytes().all(|byte| byte.is_ascii_digit())
}

/// First address only. A later A or AAAA is not a fallback.
fn resolve_host(host: &str) -> Result<IpAddr, ApiError> {
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(address);
    }
    let mut addresses = (host, 0)
        .to_socket_addrs()
        .map_err(|_| ApiError::name_not_found())?;
    addresses
        .next()
        .map(|address| address.ip())
        .ok_or_else(ApiError::name_not_found)
}

fn classify_connect_error(error: std::io::Error) -> Result<&'static str, ApiError> {
    match error.kind() {
        ErrorKind::ConnectionRefused => Ok("refused"),
        ErrorKind::TimedOut => Ok("timeout"),
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable | ErrorKind::NetworkDown => {
            Ok("unreachable")
        }
        _ => match error.raw_os_error() {
            Some(111 | 61) => Ok("refused"),
            Some(110 | 60) => Ok("timeout"),
            Some(101 | 113 | 51 | 65) => Ok("unreachable"),
            _ => Err(ApiError::tcp_unavailable()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_accepts_one_host_and_rejects_a_range() {
        let prepared = prepare(" [::1] ", 443, 3_000).expect("ipv6");
        assert_eq!(prepared.host, "::1");
        assert_eq!(prepared.port, 443);
        assert!(prepare("example.com", 0, 3_000).is_err());
        assert!(prepare("example.com", 80, 199).is_err());
        assert!(prepare("example.com", 80, 10_001).is_err());
        assert!(prepare("127.0.0.1:80", 80, 3_000).is_err());
        assert!(prepare("10.0.0.0/8", 80, 3_000).is_err());
        assert!(prepare("example.com,example.org", 80, 3_000).is_err());
        assert!(prepare("http://example.com", 80, 3_000).is_err());
        assert!(prepare("80-443", 80, 3_000).is_err());
        assert!(prepare("1-65535", 443, 3_000).is_err());
        assert!(prepare("example-host.com", 443, 200).is_ok());
    }
}
