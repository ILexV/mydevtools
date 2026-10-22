//! Port scan (`port.scan`) and network scan (`network.scan`). Both stream
//! NDJSON lines while they run and stop on `/v1/http/cancel`, a revoked
//! session, agent shutdown or a page that stops reading. Limits decided for
//! §5.3: a port scan is one host the user typed and up to all 65535 ports, at
//! most 64 connects in flight; a network scan stays inside one of this
//! computer's own IPv4 subnets and covers at most a /22 (1024 addresses), 32
//! hosts in flight. Two scans run at once in the process. Every probe goes
//! through the destination policy again, so turning private-network access
//! off in the agent window stops a scan of a private target.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{body::Body, http::StatusCode};
use bytes::Bytes;
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpStream,
    sync::{OwnedSemaphorePermit, mpsc},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    icmp,
    model::ApiError,
    policy::enforce_destination,
    state::{ActiveRequestGuard, AgentState},
    tcp,
};

pub(crate) const MAX_CONCURRENT_SCANS: usize = 2;
const MAX_PORT_PARALLEL: usize = 64;
const MAX_HOST_PARALLEL: usize = 32;
const MIN_TIMEOUT: Duration = Duration::from_millis(200);
const MAX_TIMEOUT: Duration = Duration::from_millis(5_000);
const MAX_PORT_RANGES: usize = 1024;
/// Shortest prefix a network scan accepts: a /22 is 1024 addresses.
const MIN_NETWORK_PREFIX: u8 = 22;
const MAX_PROBE_PORTS: usize = 16;
/// Up to this many ports every result is listed; above it only open ports are.
const LIST_EVERY_PORT_UP_TO: usize = 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PortScanRequest {
    id: String,
    host: String,
    /// Inclusive ranges; a single port is `[p, p]`. Overlaps are merged.
    ports: Vec<[u16; 2]>,
    timeout_ms: u64,
    #[serde(default)]
    parallel: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NetworkScanRequest {
    id: String,
    /// `192.168.1.0/24`; the address may be any address inside the network.
    network: String,
    timeout_ms: u64,
    /// TCP ports tried on each address besides the ICMP echo; may be empty.
    #[serde(default)]
    ports: Vec<u16>,
    #[serde(default)]
    resolve_names: bool,
}

pub(crate) struct PortScan {
    pub(crate) id: Uuid,
    pub(crate) host: String,
    ports: Vec<u16>,
    timeout: Duration,
    parallel: usize,
}

pub(crate) struct NetworkScan {
    pub(crate) id: Uuid,
    network: Ipv4Addr,
    prefix: u8,
    timeout: Duration,
    ports: Vec<u16>,
    resolve_names: bool,
}

fn bounded_timeout(timeout_ms: u64) -> Result<Duration, ApiError> {
    let timeout = Duration::from_millis(timeout_ms);
    if timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT {
        return Err(ApiError::invalid_request());
    }
    Ok(timeout)
}

/// Syntax only; a bad request does not take a scan slot.
pub(crate) fn prepare_port_scan(input: PortScanRequest) -> Result<PortScan, ApiError> {
    let id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    if input.ports.is_empty() || input.ports.len() > MAX_PORT_RANGES {
        return Err(ApiError::invalid_request());
    }
    let mut wanted = vec![false; usize::from(u16::MAX) + 1];
    for [start, end] in input.ports {
        if start == 0 || start > end {
            return Err(ApiError::invalid_request());
        }
        for port in start..=end {
            wanted[usize::from(port)] = true;
        }
    }
    let ports = (1..=u16::MAX)
        .filter(|port| wanted[usize::from(*port)])
        .collect();
    let parallel = input.parallel.unwrap_or(MAX_PORT_PARALLEL);
    if !(1..=MAX_PORT_PARALLEL).contains(&parallel) {
        return Err(ApiError::invalid_request());
    }
    Ok(PortScan {
        id,
        host: tcp::normalize_host(&input.host)?,
        ports,
        timeout: bounded_timeout(input.timeout_ms)?,
        parallel,
    })
}

/// Syntax only: an IPv4 CIDR from /22 to /32 and up to 16 probe ports. Whether
/// it is one of this computer's subnets is checked by [`check_local_network`].
pub(crate) fn prepare_network_scan(input: NetworkScanRequest) -> Result<NetworkScan, ApiError> {
    let id = Uuid::parse_str(&input.id).map_err(|_| ApiError::invalid_request())?;
    let (address, prefix) = input
        .network
        .trim()
        .split_once('/')
        .ok_or_else(ApiError::invalid_request)?;
    let address: Ipv4Addr = address.parse().map_err(|_| ApiError::invalid_request())?;
    let prefix: u8 = prefix.parse().map_err(|_| ApiError::invalid_request())?;
    if prefix > 32 {
        return Err(ApiError::invalid_request());
    }
    if prefix < MIN_NETWORK_PREFIX {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "network_too_large"));
    }
    if input.ports.len() > MAX_PROBE_PORTS || input.ports.contains(&0) {
        return Err(ApiError::invalid_request());
    }
    let mut ports = input.ports;
    ports.sort_unstable();
    ports.dedup();
    Ok(NetworkScan {
        id,
        network: Ipv4Addr::from(u32::from(address) & mask(prefix)),
        prefix,
        timeout: bounded_timeout(input.timeout_ms)?,
        ports,
        resolve_names: input.resolve_names,
    })
}

impl NetworkScan {
    /// The first address probed; the policy check before the scan starts uses it.
    pub(crate) fn first_host(&self) -> Ipv4Addr {
        hosts(self.network, self.prefix)[0]
    }
}

fn mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    }
}

/// The range must lie inside a subnet assigned to this computer right now:
/// a scan of somebody else's network or of the internet is refused.
pub(crate) fn check_local_network(
    scan: &NetworkScan,
    local: &[(String, Ipv4Addr, u8)],
) -> Result<Vec<Ipv4Addr>, ApiError> {
    let network = u32::from(scan.network);
    let inside = local.iter().any(|(_, address, prefix)| {
        *prefix <= scan.prefix && network & mask(*prefix) == u32::from(*address) & mask(*prefix)
    });
    if !inside {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "network_not_local"));
    }
    Ok(local.iter().map(|(_, address, _)| *address).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalNetwork {
    interface: String,
    address: String,
    /// The subnet as CIDR; one wider than /22 is offered as the /22 around the address.
    network: String,
    prefix: u8,
}

#[derive(Serialize)]
pub(crate) struct LocalNetworks {
    networks: Vec<LocalNetwork>,
}

/// The subnets offered to the page, narrowed to /22 so each one can be scanned as is.
pub(crate) fn network_list(local: &[(String, Ipv4Addr, u8)]) -> LocalNetworks {
    let mut networks: Vec<LocalNetwork> = local
        .iter()
        .filter(|(_, address, _)| !address.is_link_local())
        .map(|(interface, address, prefix)| {
            let prefix = (*prefix).max(MIN_NETWORK_PREFIX);
            LocalNetwork {
                interface: interface.clone(),
                address: address.to_string(),
                network: format!(
                    "{}/{prefix}",
                    Ipv4Addr::from(u32::from(*address) & mask(prefix))
                ),
                prefix,
            }
        })
        .collect();
    networks.sort_by(|left, right| {
        left.interface
            .cmp(&right.interface)
            .then(left.address.cmp(&right.address))
    });
    LocalNetworks { networks }
}

/// Every address to probe: without the network and broadcast address up to /30.
fn hosts(network: Ipv4Addr, prefix: u8) -> Vec<Ipv4Addr> {
    let first = u32::from(network);
    let count = 1u32 << (32 - u32::from(prefix));
    let (skip_ends, count) = (prefix <= 30, count);
    (0..count)
        .filter(|offset| !skip_ends || (*offset != 0 && *offset != count - 1))
        .map(|offset| Ipv4Addr::from(first + offset))
        .collect()
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortCounts {
    done: usize,
    open: usize,
    closed: usize,
    filtered: usize,
    other: usize,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PortLine<'a> {
    #[serde(rename_all = "camelCase")]
    Start {
        address: String,
        total: usize,
    },
    #[serde(rename_all = "camelCase")]
    Port {
        port: u16,
        status: &'static str,
        elapsed_ms: u64,
    },
    Progress(&'a PortCounts),
    #[serde(rename_all = "camelCase")]
    End {
        #[serde(flatten)]
        counts: &'a PortCounts,
        elapsed_ms: u64,
        stopped: bool,
    },
    Error {
        code: &'static str,
    },
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCounts {
    done: usize,
    found: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoundHost {
    address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mac: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rtt_ms: Option<u32>,
    open_ports: Vec<u16>,
    /// How the host showed itself: `icmp`, `tcp`, `arp`.
    via: Vec<&'static str>,
    this_computer: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HostLine<'a> {
    #[serde(rename_all = "camelCase")]
    Start {
        network: String,
        total: usize,
    },
    Host(FoundHost),
    Progress(&'a HostCounts),
    #[serde(rename_all = "camelCase")]
    End {
        #[serde(flatten)]
        counts: &'a HostCounts,
        elapsed_ms: u64,
        stopped: bool,
    },
    Error {
        code: &'static str,
    },
}

fn line(value: &impl Serialize) -> Bytes {
    let mut bytes = serde_json::to_vec(value).unwrap_or_default();
    bytes.push(b'\n');
    Bytes::from(bytes)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// One TCP connect: `open`, `closed` (refused), `filtered` (no answer),
/// `unreachable`, `denied` (the agent's own port) or `error`.
async fn probe_port(
    address: IpAddr,
    port: u16,
    timeout: Duration,
    state: &AgentState,
) -> Result<(&'static str, u64), &'static str> {
    if let Err(error) = enforce_destination(
        address,
        port,
        state.config.port,
        state.config.allow_private.allowed(),
    ) {
        return match error.code {
            "target_denied" => Ok(("denied", 0)),
            code => Err(code),
        };
    }
    let started = Instant::now();
    let outcome =
        tokio::time::timeout(timeout, TcpStream::connect(SocketAddr::new(address, port))).await;
    let status = match outcome {
        Ok(Ok(stream)) => {
            drop(stream);
            "open"
        }
        Ok(Err(error)) => match tcp::classify_connect_error(error) {
            Ok("refused") => "closed",
            Ok("timeout") => "filtered",
            Ok(other) => other,
            Err(_) => "error",
        },
        Err(_) => "filtered",
    };
    Ok((status, elapsed_ms(started)))
}

/// Streams the port scan: `start`, `port` lines (open ones always, all of
/// them up to 1024 ports), `progress` every 250 ms, then `end` or `error`.
pub(crate) fn port_scan_body(
    state: Arc<AgentState>,
    scan: PortScan,
    address: IpAddr,
    cancellation: CancellationToken,
    guard: ActiveRequestGuard,
    permit: OwnedSemaphorePermit,
) -> Body {
    let (sender, receiver) = mpsc::channel::<Bytes>(64);
    tokio::spawn(async move {
        let _held = (guard, permit);
        let started = Instant::now();
        let list_every = scan.ports.len() <= LIST_EVERY_PORT_UP_TO;
        let start = PortLine::Start {
            address: address.to_string(),
            total: scan.ports.len(),
        };
        if sender.send(line(&start)).await.is_err() {
            return;
        }
        let timeout = scan.timeout;
        let probes = stream::iter(scan.ports)
            .map(|port| {
                let state = Arc::clone(&state);
                async move { (port, probe_port(address, port, timeout, &state).await) }
            })
            .buffer_unordered(scan.parallel);
        tokio::pin!(probes);
        let mut counts = PortCounts::default();
        let mut last_progress = Instant::now();
        let stopped = loop {
            let next = tokio::select! {
                _ = cancellation.cancelled() => break true,
                _ = sender.closed() => return,
                next = probes.next() => next,
            };
            let Some((port, result)) = next else {
                break false;
            };
            let (status, elapsed) = match result {
                Ok(result) => result,
                Err(code) => {
                    let _ = sender.send(line(&PortLine::Error { code })).await;
                    return;
                }
            };
            counts.done += 1;
            match status {
                "open" => counts.open += 1,
                "closed" => counts.closed += 1,
                "filtered" => counts.filtered += 1,
                _ => counts.other += 1,
            }
            if status == "open" || list_every {
                let port_line = PortLine::Port {
                    port,
                    status,
                    elapsed_ms: elapsed,
                };
                if sender.send(line(&port_line)).await.is_err() {
                    return;
                }
            }
            if last_progress.elapsed() >= PROGRESS_EVERY {
                last_progress = Instant::now();
                if sender
                    .send(line(&PortLine::Progress(&counts)))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        };
        let end = PortLine::End {
            counts: &counts,
            elapsed_ms: elapsed_ms(started),
            stopped,
        };
        let _ = sender.send(line(&end)).await;
    });
    channel_body(receiver)
}

/// One address of a network scan: ICMP echo and TCP probes at once, then the
/// MAC from ARP; `None` when nothing answered.
async fn probe_host(
    address: Ipv4Addr,
    scan: &NetworkScan,
    own: bool,
    cancellation: &CancellationToken,
) -> Option<FoundHost> {
    let target = IpAddr::V4(address);
    let echo = {
        let timeout = scan.timeout;
        let cancellation = cancellation.clone();
        tokio::task::spawn_blocking(move || icmp::echo_once(target, timeout, &cancellation))
    };
    let connects = scan.ports.iter().map(|port| {
        let socket = SocketAddr::new(target, *port);
        async move {
            match tokio::time::timeout(scan.timeout, TcpStream::connect(socket)).await {
                Ok(Ok(stream)) => {
                    drop(stream);
                    (*port, Some(true))
                }
                Ok(Err(error)) => (
                    *port,
                    matches!(tcp::classify_connect_error(error), Ok("refused")).then_some(false),
                ),
                Err(_) => (*port, None),
            }
        }
    });
    let results = futures_util::future::join_all(connects).await;
    let rtt_ms = echo.await.ok().flatten();
    let open_ports: Vec<u16> = results
        .iter()
        .filter(|(_, open)| *open == Some(true))
        .map(|(port, _)| *port)
        .collect();
    let tcp_answered = results.iter().any(|(_, answer)| answer.is_some());
    let mac = if own {
        None
    } else {
        tokio::task::spawn_blocking(move || arp::mac_address(address))
            .await
            .ok()
            .flatten()
    };
    let mut via = Vec::new();
    if rtt_ms.is_some() {
        via.push("icmp");
    }
    if tcp_answered {
        via.push("tcp");
    }
    if mac.is_some() {
        via.push("arp");
    }
    if via.is_empty() && !own {
        return None;
    }
    let name = if scan.resolve_names {
        tokio::task::spawn_blocking(move || icmp::reverse_name(target))
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    Some(FoundHost {
        address: address.to_string(),
        name,
        mac,
        rtt_ms,
        open_ports,
        via,
        this_computer: own,
    })
}

/// Streams the network scan: `start`, a `host` line per address that
/// answered, `progress` every 250 ms, then `end` or `error`.
pub(crate) fn network_scan_body(
    state: Arc<AgentState>,
    scan: NetworkScan,
    own: Vec<Ipv4Addr>,
    cancellation: CancellationToken,
    guard: ActiveRequestGuard,
    permit: OwnedSemaphorePermit,
) -> Body {
    let (sender, receiver) = mpsc::channel::<Bytes>(64);
    tokio::spawn(async move {
        let _held = (guard, permit);
        let started = Instant::now();
        let addresses = hosts(scan.network, scan.prefix);
        let start = HostLine::Start {
            network: format!("{}/{}", scan.network, scan.prefix),
            total: addresses.len(),
        };
        if sender.send(line(&start)).await.is_err() {
            return;
        }
        let scan = Arc::new(scan);
        let probes = stream::iter(addresses)
            .map(|address| {
                let state = Arc::clone(&state);
                let scan = Arc::clone(&scan);
                let cancellation = cancellation.clone();
                let own = own.contains(&address);
                async move {
                    if let Err(error) = enforce_destination(
                        IpAddr::V4(address),
                        0,
                        state.config.port,
                        state.config.allow_private.allowed(),
                    ) {
                        return match error.code {
                            "target_denied" => Ok(None),
                            code => Err(code),
                        };
                    }
                    Ok(probe_host(address, &scan, own, &cancellation).await)
                }
            })
            .buffer_unordered(MAX_HOST_PARALLEL);
        tokio::pin!(probes);
        let mut counts = HostCounts::default();
        let mut last_progress = Instant::now();
        let stopped = loop {
            let next = tokio::select! {
                _ = cancellation.cancelled() => break true,
                _ = sender.closed() => {
                    cancellation.cancel();
                    return;
                }
                next = probes.next() => next,
            };
            let Some(result) = next else {
                break false;
            };
            counts.done += 1;
            match result {
                Ok(Some(host)) => {
                    counts.found += 1;
                    if sender.send(line(&HostLine::Host(host))).await.is_err() {
                        cancellation.cancel();
                        return;
                    }
                }
                Ok(None) => {}
                Err(code) => {
                    cancellation.cancel();
                    let _ = sender.send(line(&HostLine::Error { code })).await;
                    return;
                }
            }
            if last_progress.elapsed() >= PROGRESS_EVERY {
                last_progress = Instant::now();
                if sender
                    .send(line(&HostLine::Progress(&counts)))
                    .await
                    .is_err()
                {
                    cancellation.cancel();
                    return;
                }
            }
        };
        let end = HostLine::End {
            counts: &counts,
            elapsed_ms: elapsed_ms(started),
            stopped,
        };
        let _ = sender.send(line(&end)).await;
    });
    channel_body(receiver)
}

fn channel_body(receiver: mpsc::Receiver<Bytes>) -> Body {
    Body::from_stream(stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|bytes| (Ok::<_, std::convert::Infallible>(bytes), receiver))
    }))
}

/// The MAC address of a neighbour in this computer's ARP table. Windows asks
/// with `SendARP` (no administrator rights needed); Linux reads `/proc/net/arp`.
mod arp {
    use std::net::Ipv4Addr;

    #[cfg(windows)]
    pub(super) fn mac_address(address: Ipv4Addr) -> Option<String> {
        use windows_sys::Win32::NetworkManagement::IpHelper::SendARP;
        let mut mac = [0u8; 8];
        let mut length = mac.len() as u32;
        // SAFETY: `mac` outlives the call and `length` holds its size in bytes.
        let status = unsafe {
            SendARP(
                u32::from_ne_bytes(address.octets()),
                0,
                mac.as_mut_ptr().cast(),
                &mut length,
            )
        };
        (status == 0 && length == 6).then(|| format_mac(&mac[..6]))?
    }

    #[cfg(target_os = "linux")]
    pub(super) fn mac_address(address: Ipv4Addr) -> Option<String> {
        let table = std::fs::read_to_string("/proc/net/arp").ok()?;
        parse_proc_arp(&table, address)
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    pub(super) fn mac_address(_address: Ipv4Addr) -> Option<String> {
        None
    }

    /// A complete entry (flags 0x2) for the address; an incomplete one has no MAC yet.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(super) fn parse_proc_arp(table: &str, address: Ipv4Addr) -> Option<String> {
        let wanted = address.to_string();
        table.lines().skip(1).find_map(|row| {
            let columns: Vec<&str> = row.split_whitespace().collect();
            let [ip, _, flags, mac, ..] = columns.as_slice() else {
                return None;
            };
            let complete = u32::from_str_radix(flags.trim_start_matches("0x"), 16)
                .is_ok_and(|flags| flags & 0x2 != 0);
            (*ip == wanted && complete && *mac != "00:00:00:00:00:00")
                .then(|| mac.to_ascii_uppercase())
        })
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub(super) fn format_mac(bytes: &[u8]) -> Option<String> {
        if bytes.iter().all(|byte| *byte == 0) {
            return None;
        }
        Some(
            bytes
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect::<Vec<_>>()
                .join(":"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port_request(ports: Vec<[u16; 2]>, timeout_ms: u64) -> PortScanRequest {
        PortScanRequest {
            id: Uuid::new_v4().to_string(),
            host: "example.com".to_owned(),
            ports,
            timeout_ms,
            parallel: None,
        }
    }

    fn network_request(network: &str, ports: Vec<u16>) -> NetworkScanRequest {
        NetworkScanRequest {
            id: Uuid::new_v4().to_string(),
            network: network.to_owned(),
            timeout_ms: 500,
            ports,
            resolve_names: false,
        }
    }

    #[test]
    fn port_ranges_merge_and_cover_every_port_at_most() {
        let scan =
            prepare_port_scan(port_request(vec![[80, 82], [81, 81], [22, 22]], 500)).unwrap();
        assert_eq!(scan.ports, [22, 80, 81, 82]);
        assert_eq!(scan.parallel, MAX_PORT_PARALLEL);
        let all = prepare_port_scan(port_request(vec![[1, 65_535]], 500)).unwrap();
        assert_eq!(all.ports.len(), 65_535);
        assert!(prepare_port_scan(port_request(vec![], 500)).is_err());
        assert!(prepare_port_scan(port_request(vec![[0, 10]], 500)).is_err());
        assert!(prepare_port_scan(port_request(vec![[90, 80]], 500)).is_err());
        assert!(prepare_port_scan(port_request(vec![[80, 80]], 199)).is_err());
        assert!(prepare_port_scan(port_request(vec![[80, 80]], 5_001)).is_err());
        let mut many = port_request(vec![[80, 80]], 500);
        many.parallel = Some(65);
        assert!(prepare_port_scan(many).is_err());
        let mut range_host = port_request(vec![[80, 80]], 500);
        range_host.host = "10.0.0.0/24".to_owned();
        assert!(prepare_port_scan(range_host).is_err());
    }

    #[test]
    fn network_scan_is_ipv4_no_wider_than_slash_22() {
        let scan =
            prepare_network_scan(network_request("192.168.1.77/24", vec![80, 22, 80])).unwrap();
        assert_eq!(scan.network, Ipv4Addr::new(192, 168, 1, 0));
        assert_eq!(scan.ports, [22, 80]);
        assert_eq!(
            prepare_network_scan(network_request("10.0.0.0/21", vec![]))
                .err()
                .unwrap()
                .code,
            "network_too_large"
        );
        assert!(prepare_network_scan(network_request("10.0.0.0", vec![])).is_err());
        assert!(prepare_network_scan(network_request("fd00::/120", vec![])).is_err());
        assert!(prepare_network_scan(network_request("10.0.0.0/33", vec![])).is_err());
        assert!(prepare_network_scan(network_request("10.0.0.0/24", vec![0])).is_err());
        assert!(prepare_network_scan(network_request("10.0.0.0/24", (1..=17).collect())).is_err());
    }

    #[test]
    fn only_this_computers_subnets_can_be_scanned() {
        let local = [
            ("Ethernet".to_owned(), Ipv4Addr::new(192, 168, 1, 20), 24),
            ("VPN".to_owned(), Ipv4Addr::new(10, 8, 0, 5), 16),
        ];
        let inside = |network: &str| {
            check_local_network(
                &prepare_network_scan(network_request(network, vec![])).unwrap(),
                &local,
            )
        };
        assert!(inside("192.168.1.0/24").is_ok());
        assert!(inside("192.168.1.128/25").is_ok());
        assert!(inside("10.8.4.0/22").is_ok());
        assert_eq!(
            inside("192.168.0.0/22").err().unwrap().code,
            "network_not_local"
        );
        assert_eq!(
            inside("192.168.2.0/24").err().unwrap().code,
            "network_not_local"
        );
        assert_eq!(
            inside("8.8.8.0/24").err().unwrap().code,
            "network_not_local"
        );
    }

    #[test]
    fn offered_networks_are_narrowed_to_slash_22_without_link_local() {
        let local = [
            ("Wi-Fi".to_owned(), Ipv4Addr::new(10, 1, 7, 9), 16),
            ("Ethernet".to_owned(), Ipv4Addr::new(192, 168, 1, 20), 24),
            ("APIPA".to_owned(), Ipv4Addr::new(169, 254, 3, 4), 16),
        ];
        let list = serde_json::to_value(network_list(&local)).unwrap();
        assert_eq!(
            list,
            serde_json::json!({ "networks": [
                { "interface": "Ethernet", "address": "192.168.1.20", "network": "192.168.1.0/24", "prefix": 24 },
                { "interface": "Wi-Fi", "address": "10.1.7.9", "network": "10.1.4.0/22", "prefix": 22 }
            ]})
        );
    }

    #[test]
    fn hosts_skip_network_and_broadcast_up_to_slash_30() {
        let network = Ipv4Addr::new(192, 168, 1, 0);
        let list = hosts(network, 24);
        assert_eq!(list.len(), 254);
        assert_eq!(list[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(list[253], Ipv4Addr::new(192, 168, 1, 254));
        assert_eq!(hosts(Ipv4Addr::new(10, 0, 0, 0), 22).len(), 1022);
        assert_eq!(hosts(Ipv4Addr::new(10, 0, 0, 4), 30).len(), 2);
        assert_eq!(hosts(Ipv4Addr::new(10, 0, 0, 4), 31).len(), 2);
        assert_eq!(
            hosts(Ipv4Addr::new(10, 0, 0, 4), 32),
            [Ipv4Addr::new(10, 0, 0, 4)]
        );
    }

    #[test]
    fn arp_table_gives_complete_entries_only() {
        let table = "IP address       HW type     Flags       HW address            Mask     Device\n\
                     192.168.1.1      0x1         0x2         aa:bb:cc:00:11:22     *        eth0\n\
                     192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0\n";
        assert_eq!(
            arp::parse_proc_arp(table, Ipv4Addr::new(192, 168, 1, 1)).as_deref(),
            Some("AA:BB:CC:00:11:22")
        );
        assert_eq!(
            arp::parse_proc_arp(table, Ipv4Addr::new(192, 168, 1, 9)),
            None
        );
        assert_eq!(
            arp::parse_proc_arp(table, Ipv4Addr::new(192, 168, 1, 2)),
            None
        );
        assert_eq!(arp::format_mac(&[0; 6]), None);
        assert_eq!(
            arp::format_mac(&[0x0a, 0, 0, 0, 0, 0xff]).as_deref(),
            Some("0A:00:00:00:00:FF")
        );
    }
}
