//! Subnet splitting (subnetting): divide an IPv4 or IPv6 prefix into equal
//! smaller subnets of a longer prefix. Counts are decimal strings (an IPv6
//! /0 split into /128 is 2^128 subnets, beyond u128 and JS numbers); only the
//! first `MAX_SPLIT_ROWS` subnets are listed, the rest is reported via
//! `count` + `truncated`.

use crate::ipv4::Ipv4Cidr;
use crate::ipv6::Ipv6Cidr;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};

/// Upper bound on listed subnets per split (keeps the DOM and the JSON small).
pub const MAX_SPLIT_ROWS: u32 = 256;

/// 2^128 in decimal: the one power of two that does not fit in u128.
const TWO_POW_128: &str = "340282366920938463463374607431768211456";

/// One subnet of a split. IPv4: `first`/`last` are the usable host range and
/// `broadcast` is set; IPv6: `first`/`last` span the whole prefix.
#[derive(Debug, Serialize, Deserialize)]
pub struct SubnetRow {
    pub cidr: String,
    pub first: String,
    pub last: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broadcast: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SplitResult {
    /// Parent network in CIDR form (normalized to the network address).
    pub parent: String,
    pub prefix: u8,
    pub new_prefix: u8,
    /// Total number of subnets, base-10 (up to 2^128).
    pub count: String,
    /// Addresses in each subnet, base-10 (IPv4: total, incl. network/broadcast).
    pub addresses_per_subnet: String,
    /// IPv4 only: usable hosts per subnet (RFC 3021 for /31, 1 for /32).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usable_per_subnet: Option<String>,
    /// First `min(count, MAX_SPLIT_ROWS)` subnets in address order.
    pub subnets: Vec<SubnetRow>,
    /// True when `subnets` lists fewer than `count` entries.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SplitError {
    /// New prefix shorter than the parent prefix or longer than 32 / 128.
    InvalidNewPrefix,
}

impl fmt::Display for SplitError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            SplitError::InvalidNewPrefix => write!(f, "Invalid split prefix"),
        }
    }
}

/// 2^bits as a decimal string, valid for bits in 0..=128.
fn pow2_string(bits: u32) -> String {
    if bits >= 128 {
        TWO_POW_128.to_string()
    } else {
        (1u128 << bits).to_string()
    }
}

/// Split an IPv4 network into `/new_prefix` subnets (`prefix <= new_prefix <= 32`).
pub fn split_ipv4(cidr: &Ipv4Cidr, new_prefix: u8) -> Result<SplitResult, SplitError> {
    let prefix = cidr.prefix_len();
    if new_prefix < prefix || new_prefix > 32 {
        return Err(SplitError::InvalidNewPrefix);
    }
    let parent = cidr.calculate();
    let network = u64::from(u32::from(parent.network.parse::<Ipv4Addr>().expect("own output")));
    let count = 1u64 << (new_prefix - prefix);
    let step = 1u64 << (32 - new_prefix);
    let listed = count.min(u64::from(MAX_SPLIT_ROWS));
    let mut subnets = Vec::with_capacity(listed as usize);
    let mut usable = 0u64;
    for i in 0..listed {
        let net = (network + i * step) as u32;
        let sub = Ipv4Cidr::from_parts(net, new_prefix).calculate();
        usable = sub.usable_hosts;
        subnets.push(SubnetRow {
            cidr: format!("{}/{}", sub.network, new_prefix),
            first: sub.host_min,
            last: sub.host_max,
            broadcast: Some(sub.broadcast),
        });
    }
    Ok(SplitResult {
        parent: format!("{}/{}", parent.network, prefix),
        prefix,
        new_prefix,
        count: count.to_string(),
        addresses_per_subnet: step.to_string(),
        usable_per_subnet: Some(usable.to_string()),
        truncated: listed < count,
        subnets,
    })
}

/// Split an IPv6 prefix into `/new_prefix` subnets (`prefix <= new_prefix <= 128`).
pub fn split_ipv6(cidr: &Ipv6Cidr, new_prefix: u8) -> Result<SplitResult, SplitError> {
    let prefix = cidr.prefix_len();
    if new_prefix < prefix || new_prefix > 128 {
        return Err(SplitError::InvalidNewPrefix);
    }
    let network = cidr.network();
    let diff = u32::from(new_prefix - prefix);
    // Number of rows to list without computing 2^diff (may be 2^128).
    let listed: u32 = if diff >= 9 { MAX_SPLIT_ROWS } else { (1u32 << diff).min(MAX_SPLIT_ROWS) };
    // Subnet size; /0 → step is never used past i = 0, so 0 avoids the shl overflow.
    let host_bits = 128 - u32::from(new_prefix);
    let step: u128 = if host_bits >= 128 { 0 } else { 1u128 << host_bits };
    let last_offset: u128 = if host_bits >= 128 { u128::MAX } else { step - 1 };
    let subnets = (0..listed)
        .map(|i| {
            let net = network + u128::from(i) * step;
            SubnetRow {
                cidr: format!("{}/{}", Ipv6Addr::from(net), new_prefix),
                first: Ipv6Addr::from(net).to_string(),
                last: Ipv6Addr::from(net + last_offset).to_string(),
                broadcast: None,
            }
        })
        .collect();
    Ok(SplitResult {
        parent: format!("{}/{}", Ipv6Addr::from(network), prefix),
        prefix,
        new_prefix,
        count: pow2_string(diff),
        addresses_per_subnet: pow2_string(host_bits),
        usable_per_subnet: None,
        truncated: diff >= 9 || (1u32 << diff) > MAX_SPLIT_ROWS,
        subnets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(input: &str, new_prefix: u8) -> SplitResult {
        split_ipv4(&Ipv4Cidr::parse(input).unwrap(), new_prefix).unwrap()
    }

    fn v6(input: &str, new_prefix: u8) -> SplitResult {
        split_ipv6(&Ipv6Cidr::parse(input).unwrap(), new_prefix).unwrap()
    }

    #[test]
    fn ipv4_slash24_into_slash26() {
        let r = v4("192.168.1.77/24", 26);
        assert_eq!(r.parent, "192.168.1.0/24");
        assert_eq!(r.count, "4");
        assert_eq!(r.addresses_per_subnet, "64");
        assert_eq!(r.usable_per_subnet.as_deref(), Some("62"));
        assert!(!r.truncated);
        let cidrs: Vec<&str> = r.subnets.iter().map(|s| s.cidr.as_str()).collect();
        assert_eq!(cidrs, ["192.168.1.0/26", "192.168.1.64/26", "192.168.1.128/26", "192.168.1.192/26"]);
        assert_eq!(r.subnets[1].first, "192.168.1.65");
        assert_eq!(r.subnets[1].last, "192.168.1.126");
        assert_eq!(r.subnets[1].broadcast.as_deref(), Some("192.168.1.127"));
    }

    #[test]
    fn ipv4_same_prefix_and_host_routes() {
        let r = v4("10.0.0.0/30", 30);
        assert_eq!(r.count, "1");
        assert_eq!(r.subnets.len(), 1);
        let r = v4("10.0.0.0/30", 32);
        assert_eq!(r.count, "4");
        assert_eq!(r.usable_per_subnet.as_deref(), Some("1"));
        assert_eq!(r.subnets[3].cidr, "10.0.0.3/32");
        let r = v4("10.0.0.0/30", 31);
        assert_eq!(r.usable_per_subnet.as_deref(), Some("2"));
        assert_eq!(r.subnets[1].first, "10.0.0.2");
        assert_eq!(r.subnets[1].last, "10.0.0.3");
    }

    #[test]
    fn ipv4_truncated_and_extremes() {
        let r = v4("10.0.0.0/8", 24);
        assert_eq!(r.count, "65536");
        assert!(r.truncated);
        assert_eq!(r.subnets.len(), MAX_SPLIT_ROWS as usize);
        assert_eq!(r.subnets[255].cidr, "10.0.255.0/24");
        let r = v4("0.0.0.0/0", 32);
        assert_eq!(r.count, "4294967296");
        assert_eq!(r.subnets.len(), MAX_SPLIT_ROWS as usize);
        let r = v4("1.2.3.4/0", 0);
        assert_eq!(r.count, "1");
        assert_eq!(r.subnets[0].cidr, "0.0.0.0/0");
        assert_eq!(r.subnets[0].broadcast.as_deref(), Some("255.255.255.255"));
        // The last /24 of the address space does not overflow.
        let r = v4("255.255.255.0/24", 25);
        assert_eq!(r.subnets[1].cidr, "255.255.255.128/25");
    }

    #[test]
    fn ipv4_invalid_new_prefix() {
        let cidr = Ipv4Cidr::parse("10.0.0.0/16").unwrap();
        assert_eq!(split_ipv4(&cidr, 15).unwrap_err(), SplitError::InvalidNewPrefix);
        assert_eq!(split_ipv4(&cidr, 33).unwrap_err(), SplitError::InvalidNewPrefix);
    }

    #[test]
    fn ipv6_slash48_into_slash64() {
        let r = v6("2001:db8:abcd::1/48", 64);
        assert_eq!(r.parent, "2001:db8:abcd::/48");
        assert_eq!(r.count, "65536");
        assert_eq!(r.addresses_per_subnet, "18446744073709551616");
        assert!(r.usable_per_subnet.is_none());
        assert!(r.truncated);
        assert_eq!(r.subnets.len(), MAX_SPLIT_ROWS as usize);
        assert_eq!(r.subnets[0].cidr, "2001:db8:abcd::/64");
        assert_eq!(r.subnets[1].cidr, "2001:db8:abcd:1::/64");
        assert_eq!(r.subnets[1].last, "2001:db8:abcd:1:ffff:ffff:ffff:ffff");
        assert_eq!(r.subnets[255].cidr, "2001:db8:abcd:ff::/64");
        assert!(r.subnets[0].broadcast.is_none());
    }

    #[test]
    fn ipv6_small_and_non_nibble_splits() {
        let r = v6("2001:db8::/62", 64);
        assert_eq!(r.count, "4");
        assert!(!r.truncated);
        assert_eq!(r.subnets[3].cidr, "2001:db8:0:3::/64");
        let r = v6("2001:db8::/32", 35);
        assert_eq!(r.count, "8");
        assert_eq!(r.subnets[1].cidr, "2001:db8:2000::/35");
        assert_eq!(r.subnets[7].last, "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff");
        // Exactly MAX_SPLIT_ROWS subnets is not truncated.
        let r = v6("2001:db8::/56", 64);
        assert_eq!(r.count, "256");
        assert!(!r.truncated);
        assert_eq!(r.subnets.len(), 256);
    }

    #[test]
    fn ipv6_extremes() {
        let r = v6("::/0", 128);
        assert_eq!(r.count, TWO_POW_128);
        assert_eq!(r.addresses_per_subnet, "1");
        assert!(r.truncated);
        assert_eq!(r.subnets[255].cidr, "::ff/128");
        let r = v6("::/0", 0);
        assert_eq!(r.count, "1");
        assert_eq!(r.addresses_per_subnet, TWO_POW_128);
        assert_eq!(r.subnets[0].last, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
        let r = v6("::/0", 1);
        assert_eq!(r.subnets[1].cidr, "8000::/1");
        assert_eq!(r.subnets[1].last, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
        let r = v6("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ff00/120", 128);
        assert_eq!(r.subnets[255].cidr, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128");
    }

    #[test]
    fn ipv6_invalid_new_prefix() {
        let cidr = Ipv6Cidr::parse("2001:db8::/64").unwrap();
        assert_eq!(split_ipv6(&cidr, 63).unwrap_err(), SplitError::InvalidNewPrefix);
        assert_eq!(split_ipv6(&cidr, 129).unwrap_err(), SplitError::InvalidNewPrefix);
    }
}
