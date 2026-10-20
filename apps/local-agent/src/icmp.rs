//! Continuous ICMP path trace and a one-shot path MTU search for `icmp.trace`.
//!
//! The browser cannot send ICMP. A paired session probes one user-supplied
//! target with rising TTL and keeps per-hop loss and RTT (best, average, worst,
//! last). Intermediate routers, including a home gateway or CGNAT hop, are
//! observations and are stored even when destination policy would reject them
//! as the user's target. The engine does not re-ping a hop as a new destination.
//! Path MTU reuses those Don't Fragment echoes: it binary-searches the payload
//! and keeps the largest size that earns an echo. A lost probe is not a size
//! limit, and the search does not add an `icmp.mtu` capability. It shares the
//! process cap of two ICMP operations with running traces.
//! Behavior follows a traceroute/WinMTR-style loop; WinMTR source is not copied.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    model::{ApiError, CancelRequest},
    policy::enforce_destination,
    state::{AgentState, SessionKey},
};

const MIN_INTERVAL: Duration = Duration::from_millis(200);
const MAX_INTERVAL: Duration = Duration::from_secs(60);
const MAX_PAYLOAD_BYTES: usize = 1472;
/// IPv4 header plus ICMP echo header. A 1472-byte payload is a 1500-byte packet.
const IPV4_ECHO_OVERHEAD: u32 = 28;
/// IPv6 header plus ICMP echo header. The 1500-byte ceiling is a 1452-byte payload.
const IPV6_ECHO_OVERHEAD: u32 = 48;
const PATH_MTU_CEILING: u32 = 1500;
const IPV4_MINIMUM_MTU: u32 = 68;
const IPV6_MINIMUM_MTU: u32 = 1280;
const PATH_MTU_PROBE_LIMIT: u32 = 16;
const PATH_MTU_HOP_LIMIT: u8 = 64;
const MIN_HOPS: usize = 1;
const MAX_HOPS: usize = 64;
const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TARGET_CHARS: usize = 253;
const POLL_SLICE: Duration = Duration::from_millis(200);
const SLEEP_SLICE: Duration = Duration::from_millis(50);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TraceStartRequest {
    pub(crate) id: String,
    pub(crate) target: String,
    pub(crate) interval_ms: u64,
    pub(crate) payload_bytes: u64,
    pub(crate) max_hops: u64,
    pub(crate) timeout_ms: u64,
    pub(crate) resolve_names: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MtuSearchRequest {
    pub(crate) target: String,
    pub(crate) timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TraceState {
    Tracing,
    Stopping,
    Idle,
}

impl TraceState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tracing => "tracing",
            Self::Stopping => "stopping",
            Self::Idle => "idle",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Windows ICMP status codes construct the variants Linux does not see.
enum ProbeStatus {
    EchoReply,
    TtlExpired,
    TtlExpiredReassembly,
    DestNetUnreachable,
    DestHostUnreachable,
    DestProtUnreachable,
    DestPortUnreachable,
    PacketTooBig,
    Timeout,
    BadRoute,
    ParamProblem,
    SourceQuench,
    NoResources,
    BadOption,
    HwError,
    BadRequest,
    OptionTooBig,
    BadDestination,
    BufferTooSmall,
    GeneralFailure,
}

impl ProbeStatus {
    /// Echo reply and TTL expiry count as a returned packet. Other ICMP
    /// statuses still update the hop address and the reason code.
    fn counts_as_reply(self) -> bool {
        matches!(self, Self::EchoReply | Self::TtlExpired)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::EchoReply => "echo_reply",
            Self::TtlExpired => "ttl_expired",
            Self::TtlExpiredReassembly => "ttl_expired_reassembly",
            Self::DestNetUnreachable => "dest_net_unreachable",
            Self::DestHostUnreachable => "dest_host_unreachable",
            Self::DestProtUnreachable => "dest_prot_unreachable",
            Self::DestPortUnreachable => "dest_port_unreachable",
            Self::PacketTooBig => "packet_too_big",
            Self::Timeout => "timeout",
            Self::BadRoute => "bad_route",
            Self::ParamProblem => "param_problem",
            Self::SourceQuench => "source_quench",
            Self::NoResources => "no_resources",
            Self::BadOption => "bad_option",
            Self::HwError => "hw_error",
            Self::BadRequest => "bad_request",
            Self::OptionTooBig => "option_too_big",
            Self::BadDestination => "bad_destination",
            Self::BufferTooSmall => "buffer_too_small",
            Self::GeneralFailure => "general_failure",
        }
    }
}

struct ProbeOutcome {
    status: ProbeStatus,
    from: Option<IpAddr>,
    rtt_ms: u32,
}

struct HopRecord {
    sent: u32,
    received: u32,
    total_ms: u64,
    last_ms: Option<u32>,
    best_ms: Option<u32>,
    worst_ms: Option<u32>,
    /// Running mean of reply RTTs. The displayed average stays an integer quotient.
    rtt_mean: f64,
    /// Welford sum of squares. Sample variance is this divided by `received - 1`.
    rtt_m2: f64,
    /// Running mean of absolute gaps between consecutive replies. The first reply adds a zero gap.
    jitter_avg: f64,
    address: Option<IpAddr>,
    name: Option<String>,
    status: Option<ProbeStatus>,
    reached_destination: bool,
}

impl HopRecord {
    fn empty() -> Self {
        Self {
            sent: 0,
            received: 0,
            total_ms: 0,
            last_ms: None,
            best_ms: None,
            worst_ms: None,
            rtt_mean: 0.0,
            rtt_m2: 0.0,
            jitter_avg: 0.0,
            address: None,
            name: None,
            status: None,
            reached_destination: false,
        }
    }
}

pub(crate) struct SharedTrace {
    pub(crate) state: TraceState,
    target: IpAddr,
    target_input: String,
    resolve_names: bool,
    hops: Vec<HopRecord>,
    limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceSnapshot {
    pub(crate) id: Uuid,
    pub(crate) state: &'static str,
    pub(crate) target: String,
    pub(crate) target_input: String,
    pub(crate) hops: Vec<HopSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HopSnapshot {
    hop: u32,
    address: Option<String>,
    name: Option<String>,
    sent: u32,
    received: u32,
    loss_percent: u32,
    last_ms: Option<u32>,
    best_ms: Option<u32>,
    avg_ms: Option<u32>,
    worst_ms: Option<u32>,
    /// Sample standard deviation of reply RTTs, in milliseconds, to one decimal.
    stdev_ms: Option<f64>,
    /// Average jitter of consecutive reply RTTs, in milliseconds, to one decimal.
    jitter_ms: Option<f64>,
    status: Option<&'static str>,
}

struct TraceParams {
    interval: Duration,
    payload: Vec<u8>,
    timeout: Duration,
}

pub(crate) async fn start_trace(
    state: Arc<AgentState>,
    session_key: SessionKey,
    request: TraceStartRequest,
) -> Result<TraceSnapshot, ApiError> {
    let request_id = Uuid::parse_str(&request.id).map_err(|_| ApiError::invalid_request())?;
    let target_input = validate_target(&request.target)?;
    let interval = bounded_duration(request.interval_ms, MIN_INTERVAL, MAX_INTERVAL)?;
    let timeout = bounded_duration(request.timeout_ms, MIN_TIMEOUT, MAX_TIMEOUT)?;
    let payload_bytes = usize_in(request.payload_bytes, 0, MAX_PAYLOAD_BYTES)?;
    let max_hops = usize_in(request.max_hops, MIN_HOPS, MAX_HOPS)?;
    let payload = vec![b' '; payload_bytes];

    let host = target_input.clone();
    let target = tokio::task::spawn_blocking(move || resolve_target(&host))
        .await
        .map_err(|_| ApiError::busy())??;
    enforce_destination(target, 0, state.config.port, state.config.allow_private)?;
    ensure_icmp_available(target)?;

    let shared = Arc::new(Mutex::new(SharedTrace {
        state: TraceState::Tracing,
        target,
        target_input,
        resolve_names: request.resolve_names,
        hops: (0..max_hops).map(|_| HopRecord::empty()).collect(),
        limit: max_hops,
    }));
    let cancellation = CancellationToken::new();
    let guard = state.begin_trace(
        session_key,
        request_id,
        cancellation.clone(),
        Arc::clone(&shared),
    )?;
    let params = TraceParams {
        interval,
        payload,
        timeout,
    };
    let trace_for_task = Arc::clone(&shared);
    let spawned = thread::Builder::new()
        .name("icmp-trace".to_owned())
        .spawn(move || run_trace(guard, trace_for_task, cancellation, target, params));
    if spawned.is_err() {
        state.abandon_trace(session_key, request_id);
        return Err(ApiError::busy());
    }
    Ok(snapshot_of(request_id, &shared.lock()))
}

pub(crate) fn snapshot_trace(
    state: &AgentState,
    session_key: SessionKey,
    request: CancelRequest,
) -> Result<TraceSnapshot, ApiError> {
    let request_id = Uuid::parse_str(&request.id).map_err(|_| ApiError::invalid_request())?;
    let trace = state.trace(session_key, request_id)?;
    Ok(snapshot_of(request_id, &trace.lock()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeFit {
    Fits,
    TooBig,
    Lost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MtuBounds {
    overhead: u32,
    floor_payload: u32,
    ceiling_payload: u32,
    minimum_mtu: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MtuDiscovery {
    status: &'static str,
    mtu: Option<u32>,
    payload_bytes: Option<u32>,
    at_ceiling: bool,
    minimum_mtu: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MtuSnapshot {
    pub(crate) target: String,
    pub(crate) target_input: String,
    pub(crate) status: &'static str,
    pub(crate) mtu: Option<u32>,
    pub(crate) payload_bytes: Option<u32>,
    pub(crate) at_ceiling: bool,
    pub(crate) minimum_mtu: Option<u32>,
}

/// Searches the path MTU with the same Don't Fragment ICMP echoes as a trace.
/// The largest echo that fits is the answer. A lost probe is not a size limit.
/// The search takes one of the two process-wide ICMP slots.
pub(crate) async fn find_path_mtu(
    state: Arc<AgentState>,
    request: MtuSearchRequest,
) -> Result<MtuSnapshot, ApiError> {
    let target_input = validate_target(&request.target)?;
    let timeout = bounded_duration(request.timeout_ms, MIN_TIMEOUT, MAX_TIMEOUT)?;
    let host = target_input.clone();
    let port = state.config.port;
    let allow_private = state.config.allow_private;
    let target = tokio::task::spawn_blocking(move || resolve_target(&host))
        .await
        .map_err(|_| ApiError::busy())??;
    enforce_destination(target, 0, port, allow_private)?;
    // A missing socket must not occupy a slot.
    ensure_icmp_available(target)?;

    // Declared first so a dropped handler cancels the probe before the slot is freed.
    let _permit = state.try_begin_mtu()?;
    let cancellation = CancellationToken::new();
    let mut cancel_on_drop = CancelOnDrop {
        token: cancellation.clone(),
        armed: true,
    };
    let search_token = cancellation.clone();
    let joined =
        tokio::task::spawn_blocking(move || run_mtu_search(target, timeout, &search_token)).await;
    cancel_on_drop.armed = false;
    let discovery = joined.map_err(|_| ApiError::busy())??;
    if cancellation.is_cancelled() {
        return Err(cancelled());
    }
    Ok(MtuSnapshot {
        target: target.to_string(),
        target_input,
        status: discovery.status,
        mtu: discovery.mtu,
        payload_bytes: discovery.payload_bytes,
        at_ceiling: discovery.at_ceiling,
        minimum_mtu: discovery.minimum_mtu,
    })
}

struct CancelOnDrop {
    token: CancellationToken,
    armed: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.token.cancel();
        }
    }
}

fn cancelled() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "cancelled")
}

fn mtu_bounds(target: IpAddr) -> MtuBounds {
    match target {
        IpAddr::V4(_) => MtuBounds {
            overhead: IPV4_ECHO_OVERHEAD,
            floor_payload: IPV4_MINIMUM_MTU - IPV4_ECHO_OVERHEAD,
            ceiling_payload: PATH_MTU_CEILING - IPV4_ECHO_OVERHEAD,
            minimum_mtu: IPV4_MINIMUM_MTU,
        },
        IpAddr::V6(_) => MtuBounds {
            overhead: IPV6_ECHO_OVERHEAD,
            floor_payload: IPV6_MINIMUM_MTU - IPV6_ECHO_OVERHEAD,
            ceiling_payload: PATH_MTU_CEILING - IPV6_ECHO_OVERHEAD,
            minimum_mtu: IPV6_MINIMUM_MTU,
        },
    }
}

/// Binary search of Don't Fragment echo payloads, ceiling 1500 bytes.
/// Echo reply fits. Packet Too Big does not. Any other status, including a
/// timeout or TTL expiry, is a lost probe: retry once, then stop. A loss is
/// inconclusive and is never stored as a smaller path MTU. `None` from the
/// probe means the caller cancelled.
fn discover_path_mtu(
    bounds: MtuBounds,
    mut probe: impl FnMut(u32) -> Option<ProbeFit>,
) -> Option<MtuDiscovery> {
    let mut remaining = PATH_MTU_PROBE_LIMIT;
    match classify(&mut probe, bounds.ceiling_payload, &mut remaining)? {
        ProbeFit::Fits => return Some(found_mtu(bounds, bounds.ceiling_payload)),
        ProbeFit::Lost => {
            let floor = classify(&mut probe, bounds.floor_payload, &mut remaining)?;
            return Some(match floor {
                ProbeFit::TooBig => below_minimum(bounds),
                ProbeFit::Fits | ProbeFit::Lost => inconclusive(),
            });
        }
        ProbeFit::TooBig => {}
    }
    match classify(&mut probe, bounds.floor_payload, &mut remaining)? {
        ProbeFit::TooBig => return Some(below_minimum(bounds)),
        ProbeFit::Lost => return Some(inconclusive()),
        ProbeFit::Fits => {}
    }

    let mut fits = bounds.floor_payload;
    let mut too_big = bounds.ceiling_payload;
    while too_big - fits > 1 && remaining > 0 {
        let mid = fits + (too_big - fits) / 2;
        match classify(&mut probe, mid, &mut remaining)? {
            ProbeFit::Fits => fits = mid,
            ProbeFit::TooBig => too_big = mid,
            ProbeFit::Lost => return Some(inconclusive()),
        }
    }
    if too_big - fits > 1 {
        return Some(inconclusive());
    }
    Some(found_mtu(bounds, fits))
}

fn classify(
    probe: &mut impl FnMut(u32) -> Option<ProbeFit>,
    payload: u32,
    remaining: &mut u32,
) -> Option<ProbeFit> {
    let first = ask(probe, payload, remaining)?;
    if first == ProbeFit::Lost && *remaining > 0 {
        return ask(probe, payload, remaining);
    }
    Some(first)
}

fn ask(
    probe: &mut impl FnMut(u32) -> Option<ProbeFit>,
    payload: u32,
    remaining: &mut u32,
) -> Option<ProbeFit> {
    if *remaining == 0 {
        return Some(ProbeFit::Lost);
    }
    *remaining -= 1;
    probe(payload)
}

fn found_mtu(bounds: MtuBounds, payload: u32) -> MtuDiscovery {
    MtuDiscovery {
        status: "found",
        mtu: Some(payload + bounds.overhead),
        payload_bytes: Some(payload),
        at_ceiling: payload == bounds.ceiling_payload,
        minimum_mtu: None,
    }
}

fn below_minimum(bounds: MtuBounds) -> MtuDiscovery {
    MtuDiscovery {
        status: "below_minimum",
        mtu: None,
        payload_bytes: None,
        at_ceiling: false,
        minimum_mtu: Some(bounds.minimum_mtu),
    }
}

fn inconclusive() -> MtuDiscovery {
    MtuDiscovery {
        status: "inconclusive",
        mtu: None,
        payload_bytes: None,
        at_ceiling: false,
        minimum_mtu: None,
    }
}

fn run_mtu_search(
    target: IpAddr,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<MtuDiscovery, ApiError> {
    if cancellation.is_cancelled() {
        return Err(cancelled());
    }
    let socket = ProbeSocket::open(target).map_err(|_| ApiError::icmp_unavailable())?;
    socket
        .set_hop_limit(usize::from(PATH_MTU_HOP_LIMIT))
        .map_err(|_| ApiError::icmp_unavailable())?;
    let bounds = mtu_bounds(target);
    let mut sequence = 1u16;
    let discovery = discover_path_mtu(bounds, |payload_len| {
        if cancellation.is_cancelled() {
            return None;
        }
        let payload = vec![b' '; payload_len as usize];
        let current = sequence;
        sequence = sequence.wrapping_add(1);
        if sequence == 0 {
            sequence = 1;
        }
        match probe_once(
            &socket,
            target,
            current,
            &payload,
            timeout,
            PATH_MTU_HOP_LIMIT,
            cancellation,
        ) {
            ProbeControl::Cancelled => None,
            ProbeControl::Done(outcome) => Some(match outcome.status {
                ProbeStatus::EchoReply => ProbeFit::Fits,
                ProbeStatus::PacketTooBig => ProbeFit::TooBig,
                _ => ProbeFit::Lost,
            }),
        }
    });
    if cancellation.is_cancelled() {
        return Err(cancelled());
    }
    discovery.ok_or_else(cancelled)
}

fn validate_target(raw: &str) -> Result<String, ApiError> {
    let target = raw.trim();
    if target.is_empty()
        || target.len() > MAX_TARGET_CHARS
        || target.chars().any(|ch| {
            ch.is_whitespace() || ch.is_control() || matches!(ch, '/' | '\\' | '@' | '?' | '#')
        })
    {
        return Err(ApiError::invalid_request());
    }
    Ok(target.to_owned())
}

fn bounded_duration(millis: u64, min: Duration, max: Duration) -> Result<Duration, ApiError> {
    let duration = Duration::from_millis(millis);
    if duration < min || duration > max {
        return Err(ApiError::invalid_request());
    }
    Ok(duration)
}

fn usize_in(value: u64, min: usize, max: usize) -> Result<usize, ApiError> {
    let value = usize::try_from(value).map_err(|_| ApiError::invalid_request())?;
    if value < min || value > max {
        return Err(ApiError::invalid_request());
    }
    Ok(value)
}

/// First resolved address only. A policy failure must not fall through to another A/AAAA.
fn resolve_target(host: &str) -> Result<IpAddr, ApiError> {
    let mut addresses = (host, 0)
        .to_socket_addrs()
        .map_err(|_| ApiError::name_not_found())?;
    addresses
        .next()
        .map(|address| address.ip())
        .ok_or_else(ApiError::name_not_found)
}

fn run_trace(
    guard: crate::state::ActiveRequestGuard,
    trace: Arc<Mutex<SharedTrace>>,
    cancellation: CancellationToken,
    target: IpAddr,
    params: TraceParams,
) {
    // Declared after the session guard so a panic still marks the trace idle
    // before the id leaves the session's active map.
    let _finish = FinishTrace {
        trace: &trace,
        cancellation: &cancellation,
    };
    let hop_count = trace.lock().hops.len();
    let mut joins = Vec::with_capacity(hop_count);
    for hop_index in 0..hop_count {
        let trace = Arc::clone(&trace);
        let hop_cancellation = cancellation.clone();
        let params = TraceParams {
            interval: params.interval,
            payload: params.payload.clone(),
            timeout: params.timeout,
        };
        let handle = thread::Builder::new()
            .name(format!("icmp-hop-{}", hop_index + 1))
            .stack_size(256 * 1024)
            .spawn(move || hop_loop(trace, hop_cancellation, target, hop_index, params));
        match handle {
            Ok(handle) => joins.push(handle),
            Err(_) => {
                cancellation.cancel();
                break;
            }
        }
    }
    for handle in joins {
        let _ = handle.join();
    }
    // `guard` drops after `FinishTrace`, which marks the snapshot idle first.
    drop(_finish);
    drop(guard);
}

struct FinishTrace<'a> {
    trace: &'a Mutex<SharedTrace>,
    cancellation: &'a CancellationToken,
}

impl Drop for FinishTrace<'_> {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.trace.lock().state = TraceState::Idle;
    }
}

fn hop_loop(
    trace: Arc<Mutex<SharedTrace>>,
    cancellation: CancellationToken,
    target: IpAddr,
    hop_index: usize,
    params: TraceParams,
) {
    let Ok(socket) = ProbeSocket::open(target) else {
        return;
    };
    if socket.set_hop_limit(hop_index + 1).is_err() {
        return;
    }
    let mut sequence = hop_index as u16;
    loop {
        if cancellation.is_cancelled() {
            return;
        }
        if hop_index >= trace.lock().limit {
            return;
        }
        let started = Instant::now();
        let hop_limit = u8::try_from(hop_index + 1).unwrap_or(u8::MAX);
        match probe_once(
            &socket,
            target,
            sequence,
            &params.payload,
            params.timeout,
            hop_limit,
            &cancellation,
        ) {
            ProbeControl::Cancelled => return,
            ProbeControl::Done(outcome) => {
                let lookup = {
                    let mut guard = trace.lock();
                    record_probe(&mut guard, hop_index, &outcome)
                };
                if let Some(address) = lookup {
                    spawn_reverse_lookup(Arc::clone(&trace), hop_index, address);
                }
            }
        }
        sequence = sequence.wrapping_add(1);
        sleep_remainder(started.elapsed(), params.interval, &cancellation);
    }
}

fn sleep_remainder(spent: Duration, interval: Duration, cancellation: &CancellationToken) {
    let mut rest = interval.saturating_sub(spent);
    while !rest.is_zero() {
        if cancellation.is_cancelled() {
            return;
        }
        let slice = rest.min(SLEEP_SLICE);
        thread::sleep(slice);
        rest = rest.saturating_sub(slice);
    }
}

fn spawn_reverse_lookup(trace: Arc<Mutex<SharedTrace>>, hop_index: usize, address: IpAddr) {
    let _ = thread::Builder::new()
        .name("icmp-dns".to_owned())
        .spawn(move || {
            let Some(name) = reverse_lookup(address) else {
                return;
            };
            let mut guard = trace.lock();
            let Some(hop) = guard.hops.get_mut(hop_index) else {
                return;
            };
            // A later reply from a different router must keep its own lookup.
            if hop.address == Some(address) {
                hop.name = Some(name);
            }
        });
}

/// Applies one probe to a hop. Worst RTT is tracked on its own; a timeout does
/// not replace a name that reverse DNS already resolved.
fn record_probe(
    trace: &mut SharedTrace,
    hop_index: usize,
    outcome: &ProbeOutcome,
) -> Option<IpAddr> {
    let target = trace.target;
    let resolve_names = trace.resolve_names;
    let hop = &mut trace.hops[hop_index];
    hop.sent = hop.sent.saturating_add(1);
    hop.status = Some(outcome.status);
    let mut lookup = None;
    if let Some(address) = outcome.from {
        if hop.address != Some(address) {
            hop.address = Some(address);
            hop.name = None;
            if resolve_names {
                lookup = Some(address);
            }
        }
    }
    if outcome.status.counts_as_reply() {
        hop.received = hop.received.saturating_add(1);
        hop.total_ms = hop.total_ms.saturating_add(u64::from(outcome.rtt_ms));
        // Spread uses the previous reply. A timeout must not become a sample or a gap.
        note_reply_spread(hop, outcome.rtt_ms);
        hop.last_ms = Some(outcome.rtt_ms);
        hop.best_ms = Some(
            hop.best_ms
                .map_or(outcome.rtt_ms, |best| best.min(outcome.rtt_ms)),
        );
        hop.worst_ms = Some(
            hop.worst_ms
                .map_or(outcome.rtt_ms, |worst| worst.max(outcome.rtt_ms)),
        );
    }
    if outcome.status == ProbeStatus::EchoReply || hop.address == Some(target) {
        hop.reached_destination = true;
    }
    trace.limit = compute_limit(trace);
    lookup
}

/// Stop probing past the destination. Otherwise trim a trailing run of the same
/// observed address, which is how a silent tail collapses onto the last router.
fn compute_limit(trace: &SharedTrace) -> usize {
    if let Some(index) = trace.hops.iter().position(|hop| hop.reached_destination) {
        return index + 1;
    }
    let mut limit = trace.hops.len();
    while limit >= 2 {
        let last = &trace.hops[limit - 1];
        let previous = &trace.hops[limit - 2];
        let repeated = last.sent > 0
            && previous.sent > 0
            && observed_address(last.address)
            && last.address == previous.address;
        if !repeated {
            break;
        }
        limit -= 1;
    }
    limit
}

fn observed_address(address: Option<IpAddr>) -> bool {
    match address {
        Some(IpAddr::V4(address)) => !address.is_unspecified(),
        Some(IpAddr::V6(address)) => !address.is_unspecified(),
        None => false,
    }
}

fn loss_percent(sent: u32, received: u32) -> u32 {
    if sent == 0 {
        0
    } else {
        100 - (100 * received) / sent
    }
}

fn avg_ms(total_ms: u64, received: u32) -> Option<u32> {
    if received == 0 {
        None
    } else {
        u32::try_from(total_ms / u64::from(received)).ok()
    }
}

/// Sample standard deviation and mtr-style average jitter of reply round-trip times.
/// Lost probes are not samples. Both stay hidden until a second reply, because the
/// first reply has no previous gap and a standard deviation needs two values.
fn note_reply_spread(hop: &mut HopRecord, rtt_ms: u32) {
    let rtt = f64::from(rtt_ms);
    let count = f64::from(hop.received);
    if hop.received <= 1 {
        hop.rtt_mean = rtt;
        hop.rtt_m2 = 0.0;
        hop.jitter_avg = 0.0;
        return;
    }
    let previous = f64::from(hop.last_ms.unwrap_or(rtt_ms));
    let jitter = (rtt - previous).abs();
    hop.jitter_avg += (jitter - hop.jitter_avg) / count;
    let delta = rtt - hop.rtt_mean;
    hop.rtt_mean += delta / count;
    hop.rtt_m2 += delta * (rtt - hop.rtt_mean);
}

fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn stdev_ms(hop: &HopRecord) -> Option<f64> {
    if hop.received < 2 {
        return None;
    }
    let variance = hop.rtt_m2 / f64::from(hop.received - 1);
    if !variance.is_finite() || variance < 0.0 {
        return None;
    }
    Some(round_tenth(variance.sqrt()))
}

fn jitter_ms(hop: &HopRecord) -> Option<f64> {
    if hop.received < 2 || !hop.jitter_avg.is_finite() {
        return None;
    }
    Some(round_tenth(hop.jitter_avg))
}

fn snapshot_of(id: Uuid, trace: &SharedTrace) -> TraceSnapshot {
    let end = visible_hop_count(trace);
    TraceSnapshot {
        id,
        state: trace.state.as_str(),
        target: trace.target.to_string(),
        target_input: trace.target_input.clone(),
        hops: trace.hops[..end]
            .iter()
            .enumerate()
            .map(|(index, hop)| HopSnapshot {
                hop: index as u32 + 1,
                address: hop.address.map(|address| address.to_string()),
                name: hop.name.clone(),
                sent: hop.sent,
                received: hop.received,
                loss_percent: loss_percent(hop.sent, hop.received),
                last_ms: hop.last_ms,
                best_ms: hop.best_ms,
                avg_ms: avg_ms(hop.total_ms, hop.received),
                worst_ms: hop.worst_ms,
                stdev_ms: stdev_ms(hop),
                jitter_ms: jitter_ms(hop),
                status: hop.status.map(ProbeStatus::as_str),
            })
            .collect(),
    }
}

fn visible_hop_count(trace: &SharedTrace) -> usize {
    let limit = trace.limit.min(trace.hops.len());
    trace.hops[..limit]
        .iter()
        .rposition(|hop| hop.sent > 0)
        .map(|index| index + 1)
        .unwrap_or(0)
}

enum ProbeControl {
    Done(ProbeOutcome),
    Cancelled,
}

fn timeout_outcome() -> ProbeOutcome {
    ProbeOutcome {
        status: ProbeStatus::Timeout,
        from: None,
        rtt_ms: 0,
    }
}

fn failure_outcome(status: ProbeStatus) -> ProbeOutcome {
    ProbeOutcome {
        status,
        from: None,
        rtt_ms: 0,
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    const SO_EE_ORIGIN_ICMP: u8 = 2;
    const SO_EE_ORIGIN_ICMP6: u8 = 3;

    #[repr(C)]
    struct SockExtendedErr {
        ee_errno: u32,
        ee_origin: u8,
        ee_type: u8,
        ee_code: u8,
        ee_pad: u8,
        ee_info: u32,
        ee_data: u32,
    }

    pub(super) struct ProbeSocket {
        fd: libc::c_int,
        family: Family,
    }

    #[derive(Clone, Copy)]
    enum Family {
        V4,
        V6,
    }

    enum OpenError {
        Permission,
        Busy,
        Unavailable,
    }

    impl Drop for ProbeSocket {
        fn drop(&mut self) {
            unsafe { libc::close(self.fd) };
        }
    }

    impl ProbeSocket {
        fn open_detailed(target: IpAddr) -> Result<Self, OpenError> {
            let (domain, protocol, family) = match target {
                IpAddr::V4(_) => (libc::AF_INET, libc::IPPROTO_ICMP, Family::V4),
                IpAddr::V6(_) => (libc::AF_INET6, libc::IPPROTO_ICMPV6, Family::V6),
            };
            let fd =
                unsafe { libc::socket(domain, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, protocol) };
            if fd < 0 {
                return Err(open_error());
            }
            let socket = Self { fd, family };
            if socket.enable_errors().is_err() || socket.dont_fragment().is_err() {
                return Err(OpenError::Unavailable);
            }
            Ok(socket)
        }

        pub(super) fn open(target: IpAddr) -> Result<Self, ()> {
            Self::open_detailed(target).map_err(|_| ())
        }

        pub(super) fn set_hop_limit(&self, hop_limit: usize) -> Result<(), ()> {
            let value = libc::c_int::try_from(hop_limit).map_err(|_| ())?;
            let (level, name) = match self.family {
                Family::V4 => (libc::IPPROTO_IP, libc::IP_TTL),
                Family::V6 => (libc::IPPROTO_IPV6, libc::IPV6_UNICAST_HOPS),
            };
            self.setsockopt(level, name, &value)
        }

        fn enable_errors(&self) -> Result<(), ()> {
            let on: libc::c_int = 1;
            match self.family {
                Family::V4 => self.setsockopt(libc::SOL_IP, libc::IP_RECVERR, &on),
                Family::V6 => self.setsockopt(libc::IPPROTO_IPV6, libc::IPV6_RECVERR, &on),
            }
        }

        fn dont_fragment(&self) -> Result<(), ()> {
            let mode: libc::c_int = libc::IP_PMTUDISC_DO as libc::c_int;
            match self.family {
                Family::V4 => self.setsockopt(libc::IPPROTO_IP, libc::IP_MTU_DISCOVER, &mode),
                Family::V6 => self.setsockopt(libc::IPPROTO_IPV6, libc::IPV6_MTU_DISCOVER, &mode),
            }
        }

        fn setsockopt<T>(
            &self,
            level: libc::c_int,
            name: libc::c_int,
            value: &T,
        ) -> Result<(), ()> {
            let rc = unsafe {
                libc::setsockopt(
                    self.fd,
                    level,
                    name,
                    value as *const T as *const libc::c_void,
                    std::mem::size_of::<T>() as libc::socklen_t,
                )
            };
            if rc == 0 { Ok(()) } else { Err(()) }
        }
    }

    pub(super) fn ensure_icmp_available(target: IpAddr) -> Result<(), ApiError> {
        match ProbeSocket::open_detailed(target) {
            Ok(socket) => {
                drop(socket);
                Ok(())
            }
            Err(OpenError::Permission) => Err(ApiError::icmp_unavailable()),
            Err(OpenError::Busy) => Err(ApiError::busy()),
            Err(OpenError::Unavailable) => Err(ApiError::icmp_unavailable()),
        }
    }

    fn open_error() -> OpenError {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(code) if code == libc::EPERM || code == libc::EACCES => OpenError::Permission,
            Some(code) if code == libc::EMFILE || code == libc::ENFILE => OpenError::Busy,
            _ => OpenError::Unavailable,
        }
    }

    pub(super) fn probe_once(
        socket: &ProbeSocket,
        target: IpAddr,
        sequence: u16,
        payload: &[u8],
        timeout: Duration,
        _hop_limit: u8,
        cancellation: &CancellationToken,
    ) -> ProbeControl {
        drain(socket);
        let started = Instant::now();
        if let Err(status) = send_echo(socket, target, sequence, payload) {
            if cancellation.is_cancelled() {
                return ProbeControl::Cancelled;
            }
            return ProbeControl::Done(failure_outcome(status));
        }
        match wait_reply(socket, timeout, cancellation) {
            ProbeControl::Cancelled => ProbeControl::Cancelled,
            ProbeControl::Done(mut outcome) => {
                if cancellation.is_cancelled() {
                    return ProbeControl::Cancelled;
                }
                outcome.rtt_ms = elapsed_ms(started);
                ProbeControl::Done(outcome)
            }
        }
    }

    fn send_echo(
        socket: &ProbeSocket,
        target: IpAddr,
        sequence: u16,
        payload: &[u8],
    ) -> Result<(), ProbeStatus> {
        let kind = match socket.family {
            Family::V4 => 8,
            Family::V6 => 128,
        };
        let packet = echo_packet(kind, sequence, payload);
        let rc = unsafe {
            match target {
                IpAddr::V4(address) => {
                    let destination = libc::sockaddr_in {
                        sin_family: libc::AF_INET as libc::sa_family_t,
                        sin_port: 0,
                        sin_addr: libc::in_addr {
                            s_addr: u32::from(address).to_be(),
                        },
                        sin_zero: [0; 8],
                    };
                    libc::sendto(
                        socket.fd,
                        packet.as_ptr() as *const libc::c_void,
                        packet.len(),
                        0,
                        &destination as *const _ as *const libc::sockaddr,
                        std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
                    )
                }
                IpAddr::V6(address) => {
                    let destination = libc::sockaddr_in6 {
                        sin6_family: libc::AF_INET6 as libc::sa_family_t,
                        sin6_port: 0,
                        sin6_flowinfo: 0,
                        sin6_addr: libc::in6_addr {
                            s6_addr: address.octets(),
                        },
                        sin6_scope_id: 0,
                    };
                    libc::sendto(
                        socket.fd,
                        packet.as_ptr() as *const libc::c_void,
                        packet.len(),
                        0,
                        &destination as *const _ as *const libc::sockaddr,
                        std::mem::size_of::<libc::sockaddr_in6>() as libc::socklen_t,
                    )
                }
            }
        };
        if rc >= 0 {
            return Ok(());
        }
        Err(send_status())
    }

    fn send_status() -> ProbeStatus {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(code) if code == libc::ENETUNREACH => ProbeStatus::DestNetUnreachable,
            Some(code) if code == libc::EHOSTUNREACH => ProbeStatus::DestHostUnreachable,
            Some(code) if code == libc::EMSGSIZE => ProbeStatus::PacketTooBig,
            Some(code) if code == libc::EACCES || code == libc::EPERM => {
                ProbeStatus::GeneralFailure
            }
            _ => ProbeStatus::GeneralFailure,
        }
    }

    fn echo_packet(kind: u8, sequence: u16, payload: &[u8]) -> Vec<u8> {
        let mut packet = vec![0; 8 + payload.len()];
        packet[0] = kind;
        let sequence = sequence.to_be_bytes();
        packet[6] = sequence[0];
        packet[7] = sequence[1];
        packet[8..].copy_from_slice(payload);
        packet
    }

    fn wait_reply(
        socket: &ProbeSocket,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> ProbeControl {
        let deadline = Instant::now() + timeout;
        loop {
            if cancellation.is_cancelled() {
                return ProbeControl::Cancelled;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return ProbeControl::Done(timeout_outcome());
            }
            let slice = remaining.min(POLL_SLICE);
            let mut pollfd = libc::pollfd {
                fd: socket.fd,
                events: libc::POLLIN | libc::POLLERR,
                revents: 0,
            };
            let rc = unsafe { libc::poll(&mut pollfd, 1, slice.as_millis() as libc::c_int) };
            if rc < 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return ProbeControl::Done(failure_outcome(ProbeStatus::GeneralFailure));
            }
            if rc == 0 {
                continue;
            }
            if pollfd.revents & libc::POLLERR != 0 {
                if let Some(outcome) = read_error_queue(socket) {
                    return ProbeControl::Done(outcome);
                }
            }
            if pollfd.revents & libc::POLLIN != 0 {
                if let Some(outcome) = read_echo(socket) {
                    return ProbeControl::Done(outcome);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn drain(socket: &ProbeSocket) {
        while read_error_queue(socket).is_some() {}
        while read_echo(socket).is_some() {}
    }

    fn read_error_queue(socket: &ProbeSocket) -> Option<ProbeOutcome> {
        let mut buffer = [0u8; 256];
        let mut control = [0u64; 32];
        let mut name = [0u8; 128];
        let mut iov = libc::iovec {
            iov_base: buffer.as_mut_ptr() as *mut libc::c_void,
            iov_len: buffer.len(),
        };
        let mut header: libc::msghdr = unsafe { std::mem::zeroed() };
        header.msg_name = name.as_mut_ptr() as *mut libc::c_void;
        header.msg_namelen = name.len() as libc::socklen_t;
        header.msg_iov = &mut iov;
        header.msg_iovlen = 1;
        header.msg_control = control.as_mut_ptr() as *mut libc::c_void;
        header.msg_controllen = std::mem::size_of_val(&control);
        let rc = unsafe {
            libc::recvmsg(
                socket.fd,
                &mut header,
                libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT,
            )
        };
        if rc < 0 {
            return None;
        }
        unsafe {
            let mut message = libc::CMSG_FIRSTHDR(&header);
            while !message.is_null() {
                let current = &*message;
                let level_matches = match socket.family {
                    Family::V4 => current.cmsg_level == libc::SOL_IP,
                    Family::V6 => {
                        current.cmsg_level == libc::IPPROTO_IPV6
                            || current.cmsg_level == libc::SOL_IPV6
                    }
                };
                let type_matches = match socket.family {
                    Family::V4 => current.cmsg_type == libc::IP_RECVERR,
                    Family::V6 => current.cmsg_type == libc::IPV6_RECVERR,
                };
                if level_matches && type_matches {
                    let data = libc::CMSG_DATA(message);
                    if !data.is_null() {
                        return Some(outcome_from_error(socket.family, data));
                    }
                }
                message = libc::CMSG_NXTHDR(&header, message);
            }
        }
        None
    }

    fn outcome_from_error(family: Family, data: *const u8) -> ProbeOutcome {
        let extended = unsafe { std::ptr::read_unaligned(data as *const SockExtendedErr) };
        let from = offender_address(family, data);
        let status = match extended.ee_origin {
            SO_EE_ORIGIN_ICMP if matches!(family, Family::V4) => {
                map_icmp_v4(extended.ee_type, extended.ee_code)
            }
            SO_EE_ORIGIN_ICMP6 if matches!(family, Family::V6) => {
                map_icmp_v6(extended.ee_type, extended.ee_code)
            }
            _ => map_local_errno(extended.ee_errno),
        };
        ProbeOutcome {
            status,
            from,
            rtt_ms: 0,
        }
    }

    fn offender_address(family: Family, data: *const u8) -> Option<IpAddr> {
        // sock_extended_err is 16 bytes; the offender sockaddr follows it.
        let sockaddr = unsafe { data.add(std::mem::size_of::<SockExtendedErr>()) };
        match family {
            Family::V4 => {
                let bytes = unsafe { std::slice::from_raw_parts(sockaddr, 8) };
                Some(IpAddr::V4(Ipv4Addr::new(
                    bytes[4], bytes[5], bytes[6], bytes[7],
                )))
            }
            Family::V6 => {
                let mut octets = [0u8; 16];
                unsafe {
                    std::ptr::copy_nonoverlapping(sockaddr.add(8), octets.as_mut_ptr(), 16);
                }
                Some(IpAddr::V6(Ipv6Addr::from(octets)))
            }
        }
    }

    fn read_echo(socket: &ProbeSocket) -> Option<ProbeOutcome> {
        let mut buffer = [0u8; 256];
        let (from, size) = match socket.family {
            Family::V4 => {
                let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
                let mut length = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
                let size = unsafe {
                    libc::recvfrom(
                        socket.fd,
                        buffer.as_mut_ptr() as *mut libc::c_void,
                        buffer.len(),
                        libc::MSG_DONTWAIT,
                        &mut address as *mut _ as *mut libc::sockaddr,
                        &mut length,
                    )
                };
                if size < 0 {
                    return None;
                }
                let ip = Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr));
                (IpAddr::V4(ip), size as usize)
            }
            Family::V6 => {
                let mut address: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
                let mut length = std::mem::size_of::<libc::sockaddr_in6>() as libc::socklen_t;
                let size = unsafe {
                    libc::recvfrom(
                        socket.fd,
                        buffer.as_mut_ptr() as *mut libc::c_void,
                        buffer.len(),
                        libc::MSG_DONTWAIT,
                        &mut address as *mut _ as *mut libc::sockaddr,
                        &mut length,
                    )
                };
                if size < 0 {
                    return None;
                }
                (
                    IpAddr::V6(Ipv6Addr::from(address.sin6_addr.s6_addr)),
                    size as usize,
                )
            }
        };
        if size < 1 {
            return None;
        }
        let kind = buffer[0];
        let code = if size > 1 { buffer[1] } else { 0 };
        let status = match socket.family {
            Family::V4 if kind == 0 => ProbeStatus::EchoReply,
            Family::V4 => map_icmp_v4(kind, code),
            Family::V6 if kind == 129 => ProbeStatus::EchoReply,
            Family::V6 => map_icmp_v6(kind, code),
        };
        Some(ProbeOutcome {
            status,
            from: Some(from),
            rtt_ms: 0,
        })
    }

    fn map_icmp_v4(kind: u8, code: u8) -> ProbeStatus {
        match (kind, code) {
            (0, _) => ProbeStatus::EchoReply,
            (11, 0) => ProbeStatus::TtlExpired,
            (11, 1) => ProbeStatus::TtlExpiredReassembly,
            (3, 0) => ProbeStatus::DestNetUnreachable,
            (3, 1) => ProbeStatus::DestHostUnreachable,
            (3, 2) => ProbeStatus::DestProtUnreachable,
            (3, 3) => ProbeStatus::DestPortUnreachable,
            (3, 4) => ProbeStatus::PacketTooBig,
            (12, _) => ProbeStatus::ParamProblem,
            (4, _) => ProbeStatus::SourceQuench,
            _ => ProbeStatus::GeneralFailure,
        }
    }

    fn map_icmp_v6(kind: u8, code: u8) -> ProbeStatus {
        match (kind, code) {
            (129, _) => ProbeStatus::EchoReply,
            (3, 0) => ProbeStatus::TtlExpired,
            (3, 1) => ProbeStatus::TtlExpiredReassembly,
            (2, _) => ProbeStatus::PacketTooBig,
            (1, 0 | 2) => ProbeStatus::DestNetUnreachable,
            (1, 3) => ProbeStatus::DestHostUnreachable,
            (1, 4) => ProbeStatus::DestPortUnreachable,
            (1, 1 | 5) => ProbeStatus::DestHostUnreachable,
            (4, _) => ProbeStatus::ParamProblem,
            _ => ProbeStatus::GeneralFailure,
        }
    }

    fn map_local_errno(errno: u32) -> ProbeStatus {
        match errno as i32 {
            code if code == libc::ENETUNREACH => ProbeStatus::DestNetUnreachable,
            code if code == libc::EHOSTUNREACH => ProbeStatus::DestHostUnreachable,
            code if code == libc::EMSGSIZE => ProbeStatus::PacketTooBig,
            code if code == libc::EACCES || code == libc::EPERM => ProbeStatus::GeneralFailure,
            _ => ProbeStatus::GeneralFailure,
        }
    }

    pub(super) fn reverse_lookup(address: IpAddr) -> Option<String> {
        let mut host = [0u8; 256];
        let rc = unsafe {
            match address {
                IpAddr::V4(ip) => {
                    let sockaddr = libc::sockaddr_in {
                        sin_family: libc::AF_INET as libc::sa_family_t,
                        sin_port: 0,
                        sin_addr: libc::in_addr {
                            s_addr: u32::from(ip).to_be(),
                        },
                        sin_zero: [0; 8],
                    };
                    libc::getnameinfo(
                        &sockaddr as *const _ as *const libc::sockaddr,
                        std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
                        host.as_mut_ptr() as *mut libc::c_char,
                        host.len() as libc::socklen_t,
                        std::ptr::null_mut(),
                        0,
                        libc::NI_NAMEREQD,
                    )
                }
                IpAddr::V6(ip) => {
                    let sockaddr = libc::sockaddr_in6 {
                        sin6_family: libc::AF_INET6 as libc::sa_family_t,
                        sin6_port: 0,
                        sin6_flowinfo: 0,
                        sin6_addr: libc::in6_addr {
                            s6_addr: ip.octets(),
                        },
                        sin6_scope_id: 0,
                    };
                    libc::getnameinfo(
                        &sockaddr as *const _ as *const libc::sockaddr,
                        std::mem::size_of::<libc::sockaddr_in6>() as libc::socklen_t,
                        host.as_mut_ptr() as *mut libc::c_char,
                        host.len() as libc::socklen_t,
                        std::ptr::null_mut(),
                        0,
                        libc::NI_NAMEREQD,
                    )
                }
            }
        };
        if rc != 0 {
            return None;
        }
        let end = host
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(host.len());
        let name = String::from_utf8_lossy(&host[..end]).trim().to_owned();
        if name.is_empty() { None } else { Some(name) }
    }

    fn elapsed_ms(started: Instant) -> u32 {
        u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::mem::size_of;

    use windows_sys::Win32::{
        Foundation::{GetLastError, INVALID_HANDLE_VALUE},
        NetworkManagement::IpHelper::{
            ICMPV6_ECHO_REPLY_LH, IP_BAD_DESTINATION, IP_BAD_OPTION, IP_BAD_REQ, IP_BAD_ROUTE,
            IP_BUF_TOO_SMALL, IP_DEST_HOST_UNREACHABLE, IP_DEST_NET_UNREACHABLE,
            IP_DEST_PORT_UNREACHABLE, IP_DEST_PROT_UNREACHABLE, IP_FLAG_DF, IP_GENERAL_FAILURE,
            IP_HW_ERROR, IP_NO_RESOURCES, IP_OPTION_INFORMATION, IP_OPTION_TOO_BIG,
            IP_PACKET_TOO_BIG, IP_PARAM_PROBLEM, IP_REQ_TIMED_OUT, IP_SOURCE_QUENCH, IP_SUCCESS,
            IP_TTL_EXPIRED_REASSEM, IP_TTL_EXPIRED_TRANSIT, Icmp6CreateFile, Icmp6SendEcho2,
            IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho,
        },
        Networking::WinSock::{
            AF_INET, AF_INET6, GetNameInfoW, IN_ADDR, IN6_ADDR, NI_NAMEREQD, SOCKADDR, SOCKADDR_IN,
            SOCKADDR_IN6,
        },
    };

    pub(super) struct ProbeSocket {
        handle: windows_sys::Win32::Foundation::HANDLE,
        family: Family,
    }

    #[derive(Clone, Copy)]
    enum Family {
        V4,
        V6,
    }

    impl Drop for ProbeSocket {
        fn drop(&mut self) {
            unsafe { IcmpCloseHandle(self.handle) };
        }
    }

    impl ProbeSocket {
        pub(super) fn open(target: IpAddr) -> Result<Self, ()> {
            let (handle, family) = match target {
                IpAddr::V4(_) => (unsafe { IcmpCreateFile() }, Family::V4),
                IpAddr::V6(_) => (unsafe { Icmp6CreateFile() }, Family::V6),
            };
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                return Err(());
            }
            Ok(Self { handle, family })
        }

        pub(super) fn set_hop_limit(&self, _hop_limit: usize) -> Result<(), ()> {
            // Windows takes the TTL on each echo call, not on the handle.
            Ok(())
        }
    }

    pub(super) fn ensure_icmp_available(target: IpAddr) -> Result<(), ApiError> {
        ProbeSocket::open(target)
            .map(|socket| drop(socket))
            .map_err(|_| ApiError::icmp_unavailable())
    }

    pub(super) fn probe_once(
        socket: &ProbeSocket,
        target: IpAddr,
        _sequence: u16,
        payload: &[u8],
        timeout: Duration,
        hop_limit: u8,
        cancellation: &CancellationToken,
    ) -> ProbeControl {
        if cancellation.is_cancelled() {
            return ProbeControl::Cancelled;
        }
        let started = Instant::now();
        let outcome = match (socket.family, target) {
            (Family::V4, IpAddr::V4(address)) => {
                send_v4(socket, address, payload, timeout, started, hop_limit)
            }
            (Family::V6, IpAddr::V6(address)) => {
                send_v6(socket, address, payload, timeout, started, hop_limit)
            }
            _ => failure_outcome(ProbeStatus::GeneralFailure),
        };
        if cancellation.is_cancelled() {
            ProbeControl::Cancelled
        } else {
            ProbeControl::Done(outcome)
        }
    }

    fn send_v4(
        socket: &ProbeSocket,
        address: Ipv4Addr,
        payload: &[u8],
        timeout: Duration,
        started: Instant,
        ttl: u8,
    ) -> ProbeOutcome {
        let mut options = IP_OPTION_INFORMATION {
            Ttl: ttl,
            Tos: 0,
            Flags: IP_FLAG_DF as u8,
            OptionsSize: 0,
            OptionsData: std::ptr::null_mut(),
        };
        let mut reply = vec![0u64; 32 + payload.len().div_ceil(8)];
        let (request_ptr, request_len) = request_parts(payload);
        let replies = unsafe {
            IcmpSendEcho(
                socket.handle,
                u32::from(address).to_be(),
                request_ptr,
                request_len,
                &options,
                reply.as_mut_ptr() as *mut _,
                (reply.len() * size_of::<u64>()) as u32,
                timeout.as_millis() as u32,
            )
        };
        if replies == 0 {
            return windows_error_outcome();
        }
        // The first three fields are address, status, and RTT in both the
        // native reply and the 32-bit layout IcmpSendEcho writes on x64.
        #[repr(C)]
        struct ReplyHead {
            address: u32,
            status: u32,
            round_trip_time: u32,
        }
        let head = unsafe { &*(reply.as_ptr() as *const ReplyHead) };
        let mut outcome = ProbeOutcome {
            status: map_windows_status(head.status),
            from: Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(head.address)))),
            rtt_ms: head.round_trip_time,
        };
        if outcome.rtt_ms == 0 && outcome.status.counts_as_reply() {
            outcome.rtt_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        }
        let _ = options;
        outcome
    }

    fn send_v6(
        socket: &ProbeSocket,
        address: Ipv6Addr,
        payload: &[u8],
        timeout: Duration,
        started: Instant,
        ttl: u8,
    ) -> ProbeOutcome {
        let mut options = IP_OPTION_INFORMATION {
            Ttl: ttl,
            Tos: 0,
            Flags: IP_FLAG_DF as u8,
            OptionsSize: 0,
            OptionsData: std::ptr::null_mut(),
        };
        let mut source: SOCKADDR_IN6 = unsafe { std::mem::zeroed() };
        source.sin6_family = AF_INET6;
        let mut destination: SOCKADDR_IN6 = unsafe { std::mem::zeroed() };
        destination.sin6_family = AF_INET6;
        destination.sin6_addr = IN6_ADDR {
            u: windows_sys::Win32::Networking::WinSock::IN6_ADDR_0 {
                Byte: address.octets(),
            },
        };
        let mut reply = vec![0u64; 32 + payload.len().div_ceil(8)];
        let (request_ptr, request_len) = request_parts(payload);
        let replies = unsafe {
            Icmp6SendEcho2(
                socket.handle,
                std::ptr::null_mut(),
                None,
                std::ptr::null(),
                &source,
                &destination,
                request_ptr,
                request_len,
                &options,
                reply.as_mut_ptr() as *mut _,
                (reply.len() * size_of::<u64>()) as u32,
                timeout.as_millis() as u32,
            )
        };
        if replies == 0 {
            return windows_error_outcome();
        }
        let parsed = unsafe { &*(reply.as_ptr() as *const ICMPV6_ECHO_REPLY_LH) };
        let mut octets = [0u8; 16];
        for (index, word) in parsed.Address.sin6_addr.iter().enumerate() {
            let bytes = word.to_be_bytes();
            octets[index * 2] = bytes[0];
            octets[index * 2 + 1] = bytes[1];
        }
        let mut outcome = ProbeOutcome {
            status: map_windows_status(parsed.Status),
            from: Some(IpAddr::V6(Ipv6Addr::from(octets))),
            rtt_ms: parsed.RoundTripTime,
        };
        if outcome.rtt_ms == 0 && outcome.status.counts_as_reply() {
            outcome.rtt_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        }
        outcome
    }

    fn request_parts(payload: &[u8]) -> (*const std::ffi::c_void, u16) {
        if payload.is_empty() {
            (std::ptr::null(), 0)
        } else {
            (
                payload.as_ptr() as *const std::ffi::c_void,
                payload.len() as u16,
            )
        }
    }

    fn windows_error_outcome() -> ProbeOutcome {
        let code = unsafe { GetLastError() };
        if code == IP_REQ_TIMED_OUT {
            timeout_outcome()
        } else {
            failure_outcome(map_windows_status(code))
        }
    }

    fn map_windows_status(status: u32) -> ProbeStatus {
        match status {
            IP_SUCCESS => ProbeStatus::EchoReply,
            IP_TTL_EXPIRED_TRANSIT => ProbeStatus::TtlExpired,
            IP_TTL_EXPIRED_REASSEM => ProbeStatus::TtlExpiredReassembly,
            IP_DEST_NET_UNREACHABLE => ProbeStatus::DestNetUnreachable,
            IP_DEST_HOST_UNREACHABLE => ProbeStatus::DestHostUnreachable,
            IP_DEST_PROT_UNREACHABLE => ProbeStatus::DestProtUnreachable,
            IP_DEST_PORT_UNREACHABLE => ProbeStatus::DestPortUnreachable,
            IP_PACKET_TOO_BIG => ProbeStatus::PacketTooBig,
            IP_REQ_TIMED_OUT => ProbeStatus::Timeout,
            IP_BAD_ROUTE => ProbeStatus::BadRoute,
            IP_PARAM_PROBLEM => ProbeStatus::ParamProblem,
            IP_SOURCE_QUENCH => ProbeStatus::SourceQuench,
            IP_NO_RESOURCES => ProbeStatus::NoResources,
            IP_BAD_OPTION => ProbeStatus::BadOption,
            IP_HW_ERROR => ProbeStatus::HwError,
            IP_BAD_REQ => ProbeStatus::BadRequest,
            IP_OPTION_TOO_BIG => ProbeStatus::OptionTooBig,
            IP_BAD_DESTINATION => ProbeStatus::BadDestination,
            IP_BUF_TOO_SMALL => ProbeStatus::BufferTooSmall,
            IP_GENERAL_FAILURE => ProbeStatus::GeneralFailure,
            _ => ProbeStatus::GeneralFailure,
        }
    }

    pub(super) fn reverse_lookup(address: IpAddr) -> Option<String> {
        let mut node = [0u16; 256];
        let rc = unsafe {
            match address {
                IpAddr::V4(ip) => {
                    let mut sockaddr: SOCKADDR_IN = std::mem::zeroed();
                    sockaddr.sin_family = AF_INET;
                    sockaddr.sin_addr = IN_ADDR {
                        S_un: windows_sys::Win32::Networking::WinSock::IN_ADDR_0 {
                            S_addr: u32::from(ip).to_be(),
                        },
                    };
                    GetNameInfoW(
                        &sockaddr as *const _ as *const SOCKADDR,
                        size_of::<SOCKADDR_IN>() as i32,
                        node.as_mut_ptr(),
                        node.len() as u32,
                        std::ptr::null_mut(),
                        0,
                        NI_NAMEREQD as i32,
                    )
                }
                IpAddr::V6(ip) => {
                    let mut sockaddr: SOCKADDR_IN6 = std::mem::zeroed();
                    sockaddr.sin6_family = AF_INET6;
                    sockaddr.sin6_addr = IN6_ADDR {
                        u: windows_sys::Win32::Networking::WinSock::IN6_ADDR_0 {
                            Byte: ip.octets(),
                        },
                    };
                    GetNameInfoW(
                        &sockaddr as *const _ as *const SOCKADDR,
                        size_of::<SOCKADDR_IN6>() as i32,
                        node.as_mut_ptr(),
                        node.len() as u32,
                        std::ptr::null_mut(),
                        0,
                        NI_NAMEREQD as i32,
                    )
                }
            }
        };
        if rc != 0 {
            return None;
        }
        let end = node
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(node.len());
        let name = String::from_utf16_lossy(&node[..end]).trim().to_owned();
        if name.is_empty() { None } else { Some(name) }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod platform {
    use super::*;

    pub(super) struct ProbeSocket;

    impl ProbeSocket {
        pub(super) fn open(_target: IpAddr) -> Result<Self, ()> {
            Err(())
        }

        pub(super) fn set_hop_limit(&self, _hop_limit: usize) -> Result<(), ()> {
            Err(())
        }
    }

    pub(super) fn ensure_icmp_available(_target: IpAddr) -> Result<(), ApiError> {
        Err(ApiError::icmp_unavailable())
    }

    pub(super) fn probe_once(
        _socket: &ProbeSocket,
        _target: IpAddr,
        _sequence: u16,
        _payload: &[u8],
        _timeout: Duration,
        _hop_limit: u8,
        cancellation: &CancellationToken,
    ) -> ProbeControl {
        if cancellation.is_cancelled() {
            ProbeControl::Cancelled
        } else {
            ProbeControl::Done(failure_outcome(ProbeStatus::GeneralFailure))
        }
    }

    pub(super) fn reverse_lookup(_address: IpAddr) -> Option<String> {
        None
    }
}

use platform::{ProbeSocket, ensure_icmp_available, probe_once, reverse_lookup};

#[cfg(test)]
mod tests {
    use super::*;

    fn trace_with(hops: usize, target: IpAddr) -> SharedTrace {
        SharedTrace {
            state: TraceState::Tracing,
            target,
            target_input: target.to_string(),
            resolve_names: true,
            hops: (0..hops).map(|_| HopRecord::empty()).collect(),
            limit: hops,
        }
    }

    fn outcome(status: ProbeStatus, from: Option<IpAddr>, rtt_ms: u32) -> ProbeOutcome {
        ProbeOutcome {
            status,
            from,
            rtt_ms,
        }
    }

    #[test]
    fn loss_percent_uses_the_integer_sent_received_formula() {
        assert_eq!(loss_percent(0, 0), 0);
        assert_eq!(loss_percent(4, 4), 0);
        assert_eq!(loss_percent(4, 3), 25);
        assert_eq!(loss_percent(3, 1), 67);
    }

    #[test]
    fn worst_rtt_is_tracked_separately_and_echo_reply_stops_later_hops() {
        let target = IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1));
        let mut trace = trace_with(4, target);
        let gateway = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1));
        record_probe(
            &mut trace,
            0,
            &outcome(ProbeStatus::TtlExpired, Some(gateway), 12),
        );
        record_probe(
            &mut trace,
            0,
            &outcome(ProbeStatus::TtlExpired, Some(gateway), 40),
        );
        record_probe(&mut trace, 0, &outcome(ProbeStatus::Timeout, None, 0));
        record_probe(
            &mut trace,
            2,
            &outcome(
                ProbeStatus::EchoReply,
                Some(IpAddr::V4(Ipv4Addr::new(9, 9, 9, 9))),
                7,
            ),
        );

        assert_eq!(trace.hops[0].best_ms, Some(12));
        assert_eq!(trace.hops[0].worst_ms, Some(40));
        assert_eq!(trace.hops[0].last_ms, Some(40));
        assert_eq!(trace.hops[0].received, 2);
        assert_eq!(trace.hops[0].sent, 3);
        assert_eq!(trace.hops[0].name, None);
        assert_eq!(loss_percent(trace.hops[0].sent, trace.hops[0].received), 34);
        // A multi-homed echo reply counts as the destination even when the
        // source address differs from the resolved target.
        assert_eq!(trace.limit, 3);
        assert!(trace.hops[2].reached_destination);
    }

    #[test]
    fn spread_is_sample_deviation_and_a_timeout_is_not_a_sample() {
        let target = IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1));
        let mut trace = trace_with(1, target);
        let from = Some(target);
        record_probe(&mut trace, 0, &outcome(ProbeStatus::EchoReply, from, 10));
        let first = snapshot_of(Uuid::nil(), &trace);
        assert_eq!(first.hops[0].stdev_ms, None);
        assert_eq!(first.hops[0].jitter_ms, None);

        record_probe(&mut trace, 0, &outcome(ProbeStatus::Timeout, None, 0));
        record_probe(&mut trace, 0, &outcome(ProbeStatus::EchoReply, from, 100));
        record_probe(&mut trace, 0, &outcome(ProbeStatus::EchoReply, from, 1));
        let snapshot = snapshot_of(Uuid::nil(), &trace);
        assert_eq!(trace.hops[0].received, 3);
        assert!((snapshot.hops[0].stdev_ms.unwrap() - 54.7).abs() < 0.001);
        assert!((snapshot.hops[0].jitter_ms.unwrap() - 63.0).abs() < 0.001);

        let mut steady = trace_with(1, target);
        for rtt in [5, 6, 3] {
            record_probe(&mut steady, 0, &outcome(ProbeStatus::TtlExpired, from, rtt));
        }
        let steady_snapshot = snapshot_of(Uuid::nil(), &steady);
        assert!((steady_snapshot.hops[0].stdev_ms.unwrap() - 1.5).abs() < 0.001);
        assert!((steady_snapshot.hops[0].jitter_ms.unwrap() - 1.3).abs() < 0.001);
    }

    #[test]
    fn repeated_trailing_router_shrinks_the_probe_limit() {
        let target = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let mut trace = trace_with(4, target);
        let router = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 5));
        record_probe(
            &mut trace,
            1,
            &outcome(ProbeStatus::TtlExpired, Some(router), 3),
        );
        record_probe(
            &mut trace,
            2,
            &outcome(ProbeStatus::TtlExpired, Some(router), 4),
        );
        record_probe(
            &mut trace,
            3,
            &outcome(ProbeStatus::TtlExpired, Some(router), 5),
        );
        assert_eq!(trace.limit, 2);
    }

    #[test]
    fn timeout_keeps_a_resolved_name_and_cgnat_hops_are_recorded() {
        let target = IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1));
        let mut trace = trace_with(2, target);
        let cgnat = IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1));
        record_probe(
            &mut trace,
            0,
            &outcome(ProbeStatus::TtlExpired, Some(cgnat), 8),
        );
        trace.hops[0].name = Some("gateway.home".to_owned());
        record_probe(&mut trace, 0, &outcome(ProbeStatus::Timeout, None, 0));
        assert_eq!(trace.hops[0].address, Some(cgnat));
        assert_eq!(trace.hops[0].name.as_deref(), Some("gateway.home"));
        assert_eq!(trace.hops[0].status, Some(ProbeStatus::Timeout));
        assert_eq!(trace.hops[0].received, 1);
    }

    #[test]
    fn a_changed_hop_address_clears_the_previous_name() {
        let target = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let mut trace = trace_with(1, target);
        let first = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
        let second = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2));
        record_probe(
            &mut trace,
            0,
            &outcome(ProbeStatus::TtlExpired, Some(first), 1),
        );
        trace.hops[0].name = Some("first.example".to_owned());
        record_probe(
            &mut trace,
            0,
            &outcome(ProbeStatus::TtlExpired, Some(second), 2),
        );
        assert_eq!(trace.hops[0].address, Some(second));
        assert_eq!(trace.hops[0].name, None);
    }

    #[test]
    fn path_mtu_binary_search_keeps_the_largest_echo_and_a_loss_is_not_a_limit() {
        let v4 = mtu_bounds(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let v6 = mtu_bounds(IpAddr::V6(Ipv6Addr::LOCALHOST));
        assert_eq!(v4.ceiling_payload as usize, MAX_PAYLOAD_BYTES);
        assert_eq!(v4.floor_payload, 40);
        assert_eq!(v6.ceiling_payload, 1452);
        assert_eq!(v6.floor_payload, 1232);

        let (fits_v4, v4_calls) = search_with(v4, |_| Some(ProbeFit::Fits));
        assert_eq!(v4_calls, vec![1472]);
        assert_eq!(
            fits_v4,
            MtuDiscovery {
                status: "found",
                mtu: Some(1500),
                payload_bytes: Some(1472),
                at_ceiling: true,
                minimum_mtu: None,
            }
        );
        let (fits_v6, v6_calls) = search_with(v6, |_| Some(ProbeFit::Fits));
        assert_eq!(v6_calls, vec![1452]);
        assert_eq!(fits_v6.mtu, Some(1500));
        assert_eq!(fits_v6.payload_bytes, Some(1452));
        assert!(fits_v6.at_ceiling);

        let (limited, calls) = search_with(v4, |payload| {
            Some(if payload <= 500 {
                ProbeFit::Fits
            } else {
                ProbeFit::TooBig
            })
        });
        assert!(calls.len() <= PATH_MTU_PROBE_LIMIT as usize);
        assert_eq!(
            calls.iter().filter(|payload| **payload <= 500).max(),
            Some(&500)
        );
        assert!(calls.contains(&501));
        assert_eq!(
            limited,
            MtuDiscovery {
                status: "found",
                mtu: Some(528),
                payload_bytes: Some(500),
                at_ceiling: false,
                minimum_mtu: None,
            }
        );

        let (too_small, _) = search_with(v4, |_| Some(ProbeFit::TooBig));
        assert_eq!(too_small.status, "below_minimum");
        assert_eq!(too_small.minimum_mtu, Some(68));
        assert_eq!(too_small.mtu, None);
        let (too_small_v6, _) = search_with(v6, |_| Some(ProbeFit::TooBig));
        assert_eq!(too_small_v6.minimum_mtu, Some(1280));

        let (lost, lost_calls) = search_with(v4, |_| Some(ProbeFit::Lost));
        assert_eq!(lost, inconclusive());
        assert_eq!(lost_calls, vec![1472, 1472, 40, 40]);

        let (ceiling_lost, ceiling_calls) = search_with(v4, |payload| {
            Some(if payload == v4.floor_payload {
                ProbeFit::Fits
            } else {
                ProbeFit::Lost
            })
        });
        assert_eq!(ceiling_lost, inconclusive());
        assert_eq!(ceiling_calls, vec![1472, 1472, 40]);

        let (mid_lost, _) = search_with(v4, |payload| {
            Some(if payload == v4.ceiling_payload || payload == 756 {
                ProbeFit::TooBig
            } else if payload == v4.floor_payload {
                ProbeFit::Fits
            } else {
                ProbeFit::Lost
            })
        });
        assert_eq!(mid_lost.mtu, None);
        assert_eq!(mid_lost.status, "inconclusive");

        assert!(discover_path_mtu(v4, |_| None).is_none());
    }

    #[test]
    fn path_mtu_permit_counts_toward_the_trace_cap() {
        use std::collections::HashSet;

        use crate::{
            model::PairRequest,
            state::{AgentConfig, AgentState},
        };

        let state = AgentState::new(AgentConfig {
            port: 48_732,
            allow_private: true,
            allowed_origins: HashSet::from(["https://mydevtools.app".to_owned()]),
        });
        state.replace_pairing_code([0x11; 16]);
        let paired = state
            .pair(
                PairRequest {
                    code: "11111111111111111111111111111111".to_owned(),
                    capabilities: vec!["icmp.trace".to_owned()],
                },
                "https://mydevtools.app",
            )
            .expect("pair");
        let key = state
            .authorize_icmp(
                Some(&format!("Bearer {}", paired.token)),
                "https://mydevtools.app",
            )
            .expect("icmp session");
        let first = state.try_begin_mtu().expect("first slot");
        let second = state.try_begin_mtu().expect("second slot");
        let trace = Arc::new(Mutex::new(trace_with(1, IpAddr::V4(Ipv4Addr::LOCALHOST))));
        let blocked = state.begin_trace(
            key,
            Uuid::new_v4(),
            CancellationToken::new(),
            Arc::clone(&trace),
        );
        match blocked {
            Err(error) => assert_eq!(error.code, "busy"),
            Ok(_) => panic!("a trace must not start beside two path MTU searches"),
        }
        drop(second);
        let guard = state
            .begin_trace(
                key,
                Uuid::new_v4(),
                CancellationToken::new(),
                Arc::clone(&trace),
            )
            .expect("one slot free");
        match state.try_begin_mtu() {
            Err(error) => assert_eq!(error.code, "busy"),
            Ok(permit) => {
                drop(permit);
                panic!("a search must not start beside a trace and another search");
            }
        }
        trace.lock().state = TraceState::Idle;
        drop(guard);
        drop(first);
    }

    fn search_with(
        bounds: MtuBounds,
        mut probe: impl FnMut(u32) -> Option<ProbeFit>,
    ) -> (MtuDiscovery, Vec<u32>) {
        let mut calls = Vec::new();
        let discovery = discover_path_mtu(bounds, |payload| {
            calls.push(payload);
            probe(payload)
        })
        .expect("search finished");
        (discovery, calls)
    }
}
