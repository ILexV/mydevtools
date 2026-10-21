//! Longest-prefix ASN lookup against a prefix snapshot shipped with the agent.
//!
//! The table is the iptoasn.com dump from 2026-10-21 (RouteViews origins).
//! The country column is not stored, and ASN 0 ("Not routed") is omitted.
//! A lookup does not call a geo-IP API, does not resolve a hostname, and is
//! not part of path trace.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};

use crate::model::ApiError;

/// Lookups in flight. Separate from HTTP, ICMP, DNS, TCP, TLS and WHOIS.
pub(crate) const MAX_CONCURRENT_LOOKUPS: usize = 2;
const MAX_QUERY_CHARS: usize = 128;
const MAX_NAME_BYTES: usize = 96;
const MAX_NAMES: u32 = 200_000;
const MAX_V4: u32 = 1_000_000;
const MAX_V6: u32 = 400_000;
const SNAPSHOT: &[u8] = include_bytes!("../data/asn-prefixes.bin");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsnLookupRequest {
    pub(crate) query: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsnLookupResponse {
    pub(crate) query: String,
    pub(crate) address: String,
    pub(crate) prefix: Option<String>,
    pub(crate) asn: Option<u32>,
    pub(crate) name: String,
    pub(crate) status: &'static str,
    pub(crate) covers: bool,
}

pub(crate) struct Prepared {
    query: String,
    address: String,
    span: Span,
}

enum Span {
    V4 { start: u32, end: u32 },
    V6 { start: u128, end: u128 },
}

struct Table {
    names: HashMap<u32, String>,
    v4: Vec<V4Range>,
    v6: Vec<V6Range>,
}

struct V4Range {
    start: u32,
    end: u32,
    asn: u32,
}

struct V6Range {
    start: u128,
    end: u128,
    asn: u32,
}

/// IPv4 ranges this route reports as reserved before it consults the table.
/// A row in the snapshot must not give 127.0.0.1 a name.
const RESERVED_V4: [(u32, u32); 14] = [
    (0x0000_0000, 0x00ff_ffff), // 0.0.0.0/8
    (0x0a00_0000, 0x0aff_ffff), // 10.0.0.0/8
    (0x6440_0000, 0x647f_ffff), // 100.64.0.0/10
    (0x7f00_0000, 0x7fff_ffff), // 127.0.0.0/8
    (0xa9fe_0000, 0xa9fe_ffff), // 169.254.0.0/16
    (0xac10_0000, 0xac1f_ffff), // 172.16.0.0/12
    (0xc000_0000, 0xc000_00ff), // 192.0.0.0/24
    (0xc000_0200, 0xc000_02ff), // 192.0.2.0/24
    (0xc0a8_0000, 0xc0a8_ffff), // 192.168.0.0/16
    (0xc612_0000, 0xc613_ffff), // 198.18.0.0/15
    (0xc633_6400, 0xc633_64ff), // 198.51.100.0/24
    (0xcb00_7100, 0xcb00_71ff), // 203.0.113.0/24
    (0xe000_0000, 0xefff_ffff), // 224.0.0.0/4
    (0xf000_0000, 0xffff_ffff), // 240.0.0.0/4
];

const RESERVED_V6: [(u128, u128); 6] = [
    (0, 0), // ::/128
    (1, 1), // ::1/128
    (
        v6([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0]),
        v6([
            0x2001, 0x0db8, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
        ]),
    ), // 2001:db8::/32
    (
        v6([0xfc00, 0, 0, 0, 0, 0, 0, 0]),
        v6([
            0xfdff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
        ]),
    ), // fc00::/7
    (
        v6([0xfe80, 0, 0, 0, 0, 0, 0, 0]),
        v6([
            0xfebf, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
        ]),
    ), // fe80::/10
    (
        v6([0xff00, 0, 0, 0, 0, 0, 0, 0]),
        v6([
            0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
        ]),
    ), // ff00::/8
];

const fn v6(segments: [u16; 8]) -> u128 {
    let mut out = 0u128;
    let mut index = 0;
    while index < 8 {
        out = (out << 16) | segments[index] as u128;
        index += 1;
    }
    out
}

/// Syntax only. One address or one CIDR. A bad query does not take a lookup slot
/// and does not open a socket. Host bits in a CIDR are masked.
pub(crate) fn prepare(query: &str) -> Result<Prepared, ApiError> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
        return Err(ApiError::invalid_request());
    }
    if !query.is_ascii()
        || query
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
        || query.contains("://")
        || query.contains(',')
        || query.contains('-')
        || query.contains('%')
        || query.bytes().filter(|byte| *byte == b'/').count() > 1
    {
        return Err(ApiError::invalid_request());
    }
    let (addr_text, prefix) = split_prefix(query)?;
    let ip: IpAddr = addr_text.parse().map_err(|_| ApiError::invalid_request())?;
    match ip {
        IpAddr::V4(addr) => prepare_v4(addr, prefix),
        IpAddr::V6(addr) => prepare_v6(addr, prefix),
    }
}

/// Longest match in the embedded snapshot. Reserved addresses are answered
/// before the table, so a bad row cannot name them.
pub(crate) fn lookup(prepared: Prepared) -> Result<AsnLookupResponse, ApiError> {
    Ok(answer(embedded()?, &prepared))
}

fn prepare_v4(addr: Ipv4Addr, prefix: Option<u32>) -> Result<Prepared, ApiError> {
    let bits = prefix.unwrap_or(32);
    if bits > 32 {
        return Err(ApiError::invalid_request());
    }
    let (start, end) = mask_range(u128::from(u32::from(addr)), bits, 32);
    let start = start as u32;
    let end = end as u32;
    let network = Ipv4Addr::from(start);
    let address = network.to_string();
    let query = match prefix {
        Some(bits) => format!("{address}/{bits}"),
        None => address.clone(),
    };
    Ok(Prepared {
        query,
        address,
        span: Span::V4 { start, end },
    })
}

fn prepare_v6(addr: Ipv6Addr, prefix: Option<u32>) -> Result<Prepared, ApiError> {
    let bits = prefix.unwrap_or(128);
    if bits > 128 {
        return Err(ApiError::invalid_request());
    }
    let (start, end) = mask_range(u128::from(addr), bits, 128);
    // A bare IPv4-mapped address, or a /128 that is exactly one, is a v4 lookup.
    // A shorter mapped prefix stays in the v6 table. NAT64 is not rewritten.
    if start == end {
        if let Some(mapped) = Ipv6Addr::from(start).to_ipv4_mapped() {
            return prepare_v4(mapped, None);
        }
    }
    let network = Ipv6Addr::from(start);
    let address = network.to_string();
    let query = match prefix {
        Some(bits) => format!("{address}/{bits}"),
        None => address.clone(),
    };
    Ok(Prepared {
        query,
        address,
        span: Span::V6 { start, end },
    })
}

fn split_prefix(query: &str) -> Result<(&str, Option<u32>), ApiError> {
    let Some((addr, raw)) = query.split_once('/') else {
        return Ok((query, None));
    };
    if addr.is_empty() || !valid_prefix_text(raw) {
        return Err(ApiError::invalid_request());
    }
    let value: u32 = raw.parse().map_err(|_| ApiError::invalid_request())?;
    Ok((addr, Some(value)))
}

fn valid_prefix_text(raw: &str) -> bool {
    let mut chars = raw.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_digit() || raw.len() > 3 {
        return false;
    }
    if raw.len() > 1 && first == '0' {
        return false;
    }
    chars.all(|ch| ch.is_ascii_digit())
}

/// Inclusive start and end after clearing host bits. `bits` is 32 or 128.
fn mask_range(ip: u128, prefix: u32, bits: u32) -> (u128, u128) {
    let host = bits - prefix;
    if host == 128 {
        return (0, u128::MAX);
    }
    let mask = u128::MAX << host;
    let start = ip & mask;
    (start, start | !mask)
}

fn answer(table: &Table, prepared: &Prepared) -> AsnLookupResponse {
    let reserved = match prepared.span {
        Span::V4 { start, .. } => reserved_v4(start),
        Span::V6 { start, .. } => reserved_v6(start),
    };
    if reserved {
        return blank(prepared, "reserved");
    }
    let found = match prepared.span {
        Span::V4 { start, end } => find_v4(&table.v4, start).map(|row| {
            let covers = row.end >= end && !hits_reserved_v4(start, end);
            (prefix_v4(row.start, row.end), row.asn, covers)
        }),
        Span::V6 { start, end } => find_v6(&table.v6, start).map(|row| {
            let covers = row.end >= end && !hits_reserved_v6(start, end);
            (prefix_v6(row.start, row.end), row.asn, covers)
        }),
    };
    match found {
        Some((prefix, asn, covers)) => AsnLookupResponse {
            query: prepared.query.clone(),
            address: prepared.address.clone(),
            prefix: Some(prefix),
            asn: Some(asn),
            name: table.names.get(&asn).cloned().unwrap_or_default(),
            status: "found",
            covers,
        },
        None => blank(prepared, "not_found"),
    }
}

fn blank(prepared: &Prepared, status: &'static str) -> AsnLookupResponse {
    AsnLookupResponse {
        query: prepared.query.clone(),
        address: prepared.address.clone(),
        prefix: None,
        asn: None,
        name: String::new(),
        status,
        covers: false,
    }
}

fn reserved_v4(addr: u32) -> bool {
    RESERVED_V4
        .iter()
        .any(|&(start, end)| (start..=end).contains(&addr))
}

fn reserved_v6(addr: u128) -> bool {
    RESERVED_V6
        .iter()
        .any(|&(start, end)| (start..=end).contains(&addr))
}

fn hits_reserved_v4(start: u32, end: u32) -> bool {
    RESERVED_V4.iter().any(|&(lo, hi)| start <= hi && lo <= end)
}

fn hits_reserved_v6(start: u128, end: u128) -> bool {
    RESERVED_V6.iter().any(|&(lo, hi)| start <= hi && lo <= end)
}

fn find_v4(rows: &[V4Range], addr: u32) -> Option<&V4Range> {
    let index = rows.partition_point(|row| row.start <= addr);
    let row = rows.get(index.checked_sub(1)?)?;
    (addr <= row.end).then_some(row)
}

fn find_v6(rows: &[V6Range], addr: u128) -> Option<&V6Range> {
    let index = rows.partition_point(|row| row.start <= addr);
    let row = rows.get(index.checked_sub(1)?)?;
    (addr <= row.end).then_some(row)
}

/// A single aligned power-of-two span is a CIDR. Anything else stays `start-end`.
fn prefix_len(start: u128, end: u128, bits: u32) -> Option<u32> {
    if start > end {
        return None;
    }
    if bits == 128 && start == 0 && end == u128::MAX {
        return Some(0);
    }
    let span = (end - start).checked_add(1)?;
    if !span.is_power_of_two() || start & (span - 1) != 0 {
        return None;
    }
    let host = span.trailing_zeros();
    (host <= bits).then_some(bits - host)
}

fn prefix_v4(start: u32, end: u32) -> String {
    let start_addr = Ipv4Addr::from(start);
    match prefix_len(u128::from(start), u128::from(end), 32) {
        Some(len) => format!("{start_addr}/{len}"),
        None => format!("{start_addr}-{}", Ipv4Addr::from(end)),
    }
}

fn prefix_v6(start: u128, end: u128) -> String {
    let start_addr = Ipv6Addr::from(start);
    match prefix_len(start, end, 128) {
        Some(len) => format!("{start_addr}/{len}"),
        None => format!("{start_addr}-{}", Ipv6Addr::from(end)),
    }
}

fn embedded() -> Result<&'static Table, ApiError> {
    static TABLE: OnceLock<Result<Table, ()>> = OnceLock::new();
    match TABLE.get_or_init(|| parse(SNAPSHOT).map_err(|_| ())) {
        Ok(table) => Ok(table),
        Err(()) => Err(ApiError::asn_unavailable()),
    }
}

fn parse(bytes: &[u8]) -> Result<Table, ()> {
    let mut cursor = Cursor { bytes, at: 0 };
    if cursor.take(8)? != b"MDTASN01" {
        return Err(());
    }
    let name_count = cursor.u32()?;
    if name_count > MAX_NAMES {
        return Err(());
    }
    let mut names = HashMap::with_capacity(name_count as usize);
    for _ in 0..name_count {
        let asn = cursor.u32()?;
        let nbytes = cursor.u16()? as usize;
        if nbytes > MAX_NAME_BYTES {
            return Err(());
        }
        let text = std::str::from_utf8(cursor.take(nbytes)?).map_err(|_| ())?;
        if names.insert(asn, text.to_owned()).is_some() {
            return Err(());
        }
    }
    let v4_count = cursor.u32()?;
    if v4_count > MAX_V4 {
        return Err(());
    }
    let mut v4 = Vec::with_capacity(v4_count as usize);
    for _ in 0..v4_count {
        let start = cursor.u32()?;
        let end = cursor.u32()?;
        let asn = cursor.u32()?;
        if start > end {
            return Err(());
        }
        if v4.last().is_some_and(|row: &V4Range| start <= row.end) {
            return Err(());
        }
        v4.push(V4Range { start, end, asn });
    }
    let v6_count = cursor.u32()?;
    if v6_count > MAX_V6 {
        return Err(());
    }
    let mut v6 = Vec::with_capacity(v6_count as usize);
    for _ in 0..v6_count {
        let start = cursor.u128()?;
        let end = cursor.u128()?;
        let asn = cursor.u32()?;
        if start > end {
            return Err(());
        }
        if v6.last().is_some_and(|row: &V6Range| start <= row.end) {
            return Err(());
        }
        v6.push(V6Range { start, end, asn });
    }
    if cursor.at != cursor.bytes.len() {
        return Err(());
    }
    Ok(Table { names, v4, v6 })
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], ()> {
        let end = self.at.checked_add(len).ok_or(())?;
        if end > self.bytes.len() {
            return Err(());
        }
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, ()> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes(bytes.try_into().map_err(|_| ())?))
    }

    fn u32(&mut self) -> Result<u32, ()> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes(bytes.try_into().map_err(|_| ())?))
    }

    fn u128(&mut self) -> Result<u128, ()> {
        let bytes = self.take(16)?;
        Ok(u128::from_le_bytes(bytes.try_into().map_err(|_| ())?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_tiny() -> Table {
        Table {
            names: HashMap::from([
                (13335, "CLOUDFLARENET".to_owned()),
                (1, "SHORT".to_owned()),
                (999, "SHOULD-NOT-WIN".to_owned()),
            ]),
            v4: vec![
                V4Range {
                    start: u32::from(Ipv4Addr::new(1, 1, 1, 0)),
                    end: u32::from(Ipv4Addr::new(1, 1, 1, 255)),
                    asn: 13335,
                },
                V4Range {
                    start: u32::from(Ipv4Addr::new(9, 9, 9, 1)),
                    end: u32::from(Ipv4Addr::new(9, 9, 9, 3)),
                    asn: 1,
                },
                V4Range {
                    start: u32::from(Ipv4Addr::new(127, 0, 0, 0)),
                    end: u32::from(Ipv4Addr::new(127, 255, 255, 255)),
                    asn: 999,
                },
            ],
            v6: Vec::new(),
        }
    }

    #[test]
    fn prepare_rejects_a_name_a_url_a_range_and_an_empty_query() {
        for query in [
            "",
            "   ",
            "example.com",
            "http://1.1.1.1",
            "1.1.1.1-1.1.1.2",
            "1.1.1.1,8.8.8.8",
            "fe80::1%eth0",
            "1.1.1.1/24/32",
            "1.1.1.1/",
            "1.1.1.1/33",
            "::1/129",
            "1.1.1.1/024",
        ] {
            assert!(prepare(query).is_err(), "{query}");
        }
    }

    #[test]
    fn prepare_accepts_an_address_and_masks_a_cidr() {
        let host = prepare(" 1.1.1.1 ").expect("host");
        assert_eq!(host.query, "1.1.1.1");
        assert_eq!(host.address, "1.1.1.1");
        let cidr = prepare("1.1.1.1/24").expect("cidr");
        assert_eq!(cidr.query, "1.1.1.0/24");
        assert_eq!(cidr.address, "1.1.1.0");
        let mapped = prepare("::ffff:1.1.1.1").expect("mapped");
        assert_eq!(mapped.query, "1.1.1.1");
        let mapped_one = prepare("::ffff:8.8.8.8/128").expect("mapped /128");
        assert_eq!(mapped_one.query, "8.8.8.8");
    }

    #[test]
    fn longest_match_on_a_tiny_table_reserves_private_space_first() {
        let table = fixed_tiny();
        let found = answer(&table, &prepare("1.1.1.1").unwrap());
        assert_eq!(found.status, "found");
        assert_eq!(found.asn, Some(13335));
        assert_eq!(found.name, "CLOUDFLARENET");
        assert_eq!(found.prefix.as_deref(), Some("1.1.1.0/24"));
        assert!(found.covers);

        let cidr = answer(&table, &prepare("1.1.1.50/24").unwrap());
        assert_eq!(cidr.query, "1.1.1.0/24");
        assert!(cidr.covers);

        let partial = answer(&table, &prepare("9.9.9.1").unwrap());
        assert_eq!(partial.prefix.as_deref(), Some("9.9.9.1-9.9.9.3"));
        assert!(partial.covers);
        let wider = answer(&table, &prepare("9.9.9.0/28").unwrap());
        assert_eq!(wider.status, "not_found");
        assert!(!wider.covers);

        let inside_short = answer(
            &Table {
                names: HashMap::from([(1, "SHORT".to_owned())]),
                v4: vec![V4Range {
                    start: u32::from(Ipv4Addr::new(9, 9, 9, 0)),
                    end: u32::from(Ipv4Addr::new(9, 9, 9, 10)),
                    asn: 1,
                }],
                v6: Vec::new(),
            },
            &prepare("9.9.9.0/28").unwrap(),
        );
        assert_eq!(inside_short.status, "found");
        assert_eq!(inside_short.prefix.as_deref(), Some("9.9.9.0-9.9.9.10"));
        assert!(!inside_short.covers);

        for query in ["10.0.0.1", "203.0.113.5", "127.0.0.1", "192.0.2.1"] {
            let reserved = answer(&table, &prepare(query).unwrap());
            assert_eq!(reserved.status, "reserved", "{query}");
            assert_eq!(reserved.asn, None);
            assert_eq!(reserved.prefix, None);
            assert!(reserved.name.is_empty());
            assert!(!reserved.covers);
        }
        assert_eq!(
            answer(&table, &prepare("8.8.4.4").unwrap()).status,
            "not_found"
        );
    }

    #[test]
    fn embedded_snapshot_matches_the_2026_10_21_origins() {
        let cloudflare = lookup(prepare("1.1.1.1").unwrap()).expect("table");
        assert_eq!(cloudflare.status, "found");
        assert_eq!(cloudflare.asn, Some(13335));
        assert_eq!(cloudflare.name, "CLOUDFLARENET");
        assert_eq!(cloudflare.prefix.as_deref(), Some("1.1.1.0/24"));
        assert!(cloudflare.covers);

        let google = lookup(prepare("8.8.8.8").unwrap()).expect("google");
        assert_eq!(google.asn, Some(15169));
        assert_eq!(google.name, "GOOGLE");
        assert_eq!(google.prefix.as_deref(), Some("8.8.8.0/24"));

        let icann = lookup(prepare("192.0.47.59").unwrap()).expect("icann");
        assert_eq!(icann.status, "found");
        assert_eq!(icann.asn, Some(16876));
        assert_eq!(icann.name, "ICANN-DC");

        let google_v6 = lookup(prepare("2001:4860:4860::8888").unwrap()).expect("v6");
        assert_eq!(google_v6.asn, Some(15169));
        assert_eq!(google_v6.name, "GOOGLE");

        assert_eq!(
            lookup(prepare("127.0.0.1").unwrap()).unwrap().status,
            "reserved"
        );
        assert_eq!(
            lookup(prepare("192.0.2.1").unwrap()).unwrap().status,
            "reserved"
        );
        assert!(parse(b"MDTASN00").is_err());
    }
}
