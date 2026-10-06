//! IPv6 CIDR calculator: network prefix, first/last address, address count
//! (as a decimal string — /0 is 2^128 and overflows u128), compressed
//! (RFC 5952) and fully expanded forms, prefix mask and address-type scope
//! (loopback, link-local, unique local, multicast, documentation, global…).
//! IPv6 has no broadcast: every address in the prefix is assignable.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::net::Ipv6Addr;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq)]
pub struct Ipv6Cidr {
    address: u128,
    prefix_len: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Ipv6Result {
    pub input: String,
    pub ip: String,
    pub ip_expanded: String,
    pub prefix: u8,
    pub netmask: String,
    pub network: String,
    pub network_expanded: String,
    pub first: String,
    pub last: String,
    /// Exact number of addresses in the prefix, base-10 (up to 2^128).
    pub address_count: String,
    pub scope: String,
}

#[derive(Debug, Clone)]
pub enum Ipv6ParseError {
    InvalidIp,
    InvalidPrefix,
}

impl fmt::Display for Ipv6ParseError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Ipv6ParseError::InvalidIp => write!(f, "Invalid IPv6 address"),
            Ipv6ParseError::InvalidPrefix => write!(f, "Invalid prefix length (0-128)"),
        }
    }
}

/// Prefix mask with `prefix` leading one-bits (0 → all zeros).
fn mask_for(prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix as u32)
    }
}

/// Full 8×4-hex-digit form, e.g. `2001:0db8:0000:…:0001`.
fn expanded(addr: u128) -> String {
    Ipv6Addr::from(addr)
        .segments()
        .iter()
        .map(|s| format!("{s:04x}"))
        .collect::<Vec<_>>()
        .join(":")
}

impl Ipv6Cidr {
    pub fn prefix_len(&self) -> u8 {
        self.prefix_len
    }

    /// Network address (entered address with host bits cleared).
    pub fn network(&self) -> u128 {
        self.address & mask_for(self.prefix_len)
    }

    /// Parses `addr/prefix` or a bare address (treated as /128). Zone ids
    /// (`fe80::1%eth0`) are rejected — they are interface-local, not routable.
    pub fn parse(input: &str) -> Result<Self, Ipv6ParseError> {
        let input = input.trim();
        let (ip_str, prefix) = match input.split_once('/') {
            Some((ip, p)) => {
                let prefix = p.trim().parse::<u8>().map_err(|_| Ipv6ParseError::InvalidPrefix)?;
                if prefix > 128 {
                    return Err(Ipv6ParseError::InvalidPrefix);
                }
                (ip.trim(), prefix)
            }
            None => (input, 128),
        };
        let ip = Ipv6Addr::from_str(ip_str).map_err(|_| Ipv6ParseError::InvalidIp)?;
        Ok(Self {
            address: u128::from(ip),
            prefix_len: prefix,
        })
    }

    pub fn calculate(&self) -> Ipv6Result {
        let mask = mask_for(self.prefix_len);
        let network = self.address & mask;
        let last = network | !mask;
        let address_count = if self.prefix_len == 0 {
            // 2^128 does not fit in u128.
            "340282366920938463463374607431768211456".to_string()
        } else {
            (1u128 << (128 - self.prefix_len as u32)).to_string()
        };
        Ipv6Result {
            input: String::new(),
            ip: Ipv6Addr::from(self.address).to_string(),
            ip_expanded: expanded(self.address),
            prefix: self.prefix_len,
            netmask: Ipv6Addr::from(mask).to_string(),
            network: Ipv6Addr::from(network).to_string(),
            network_expanded: expanded(network),
            first: Ipv6Addr::from(network).to_string(),
            last: Ipv6Addr::from(last).to_string(),
            address_count,
            scope: scope_of(self.address).to_string(),
        }
    }
}

/// Address type of the entered address (IANA IPv6 special-purpose registry,
/// most relevant entries). Order matters: more specific ranges first.
fn scope_of(addr: u128) -> &'static str {
    let in_net = |net: u128, len: u8| addr & mask_for(len) == net;
    if addr == 0 {
        "unspecified"
    } else if addr == 1 {
        "loopback"
    } else if in_net(0xffff_0000_0000u128, 96) {
        "ipv4-mapped"
    } else if in_net(0x2001_0db8u128 << 96, 32) {
        "documentation"
    } else if in_net(0xfe80u128 << 112, 10) {
        "link-local"
    } else if in_net(0xfc00u128 << 112, 7) {
        "unique-local"
    } else if in_net(0xff00u128 << 112, 8) {
        "multicast"
    } else if in_net(0x2000u128 << 112, 3) {
        "global"
    } else {
        "reserved"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calc(input: &str) -> Ipv6Result {
        Ipv6Cidr::parse(input).unwrap().calculate()
    }

    #[test]
    fn slash_64_documentation_prefix() {
        let r = calc("2001:db8:abcd:12::1/64");
        assert_eq!(r.ip, "2001:db8:abcd:12::1");
        assert_eq!(r.ip_expanded, "2001:0db8:abcd:0012:0000:0000:0000:0001");
        assert_eq!(r.prefix, 64);
        assert_eq!(r.netmask, "ffff:ffff:ffff:ffff::");
        assert_eq!(r.network, "2001:db8:abcd:12::");
        assert_eq!(r.network_expanded, "2001:0db8:abcd:0012:0000:0000:0000:0000");
        assert_eq!(r.first, "2001:db8:abcd:12::");
        assert_eq!(r.last, "2001:db8:abcd:12:ffff:ffff:ffff:ffff");
        assert_eq!(r.address_count, "18446744073709551616");
        assert_eq!(r.scope, "documentation");
    }

    #[test]
    fn extreme_prefixes() {
        let r = calc("::/0");
        assert_eq!(r.network, "::");
        assert_eq!(r.last, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
        assert_eq!(r.netmask, "::");
        assert_eq!(r.address_count, "340282366920938463463374607431768211456");
        let r = calc("2001:db8::1/1");
        assert_eq!(r.network, "::");
        assert_eq!(r.last, "7fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
        assert_eq!(r.address_count, "170141183460469231731687303715884105728");
        let r = calc("2001:db8::1/127");
        assert_eq!(r.first, "2001:db8::");
        assert_eq!(r.last, "2001:db8::1");
        assert_eq!(r.address_count, "2");
        let r = calc("2001:db8::1");
        assert_eq!(r.prefix, 128);
        assert_eq!(r.network, "2001:db8::1");
        assert_eq!(r.last, "2001:db8::1");
        assert_eq!(r.address_count, "1");
        assert_eq!(r.netmask, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
    }

    #[test]
    fn address_count_every_prefix() {
        for p in 1u8..=128 {
            let r = calc(&format!("2001:db8::/{p}"));
            assert_eq!(r.address_count, (1u128 << (128 - p as u32)).to_string(), "/{p}");
        }
    }

    #[test]
    fn non_nibble_prefix_and_compression() {
        let r = calc("2001:db8:1234:5678::/45");
        assert_eq!(r.network, "2001:db8:1230::");
        assert_eq!(r.last, "2001:db8:1237:ffff:ffff:ffff:ffff:ffff");
        assert_eq!(r.netmask, "ffff:ffff:fff8::");
        // Input in expanded / upper-case form is normalized (RFC 5952).
        let r = calc("2001:0DB8:0000:0000:0000:0000:0000:0001/128");
        assert_eq!(r.ip, "2001:db8::1");
        // Spaces around the slash are tolerated, as in the IPv4 parser.
        assert_eq!(calc(" fe80::1 / 64 ").network, "fe80::");
    }

    #[test]
    fn scopes() {
        let scope = |s: &str| calc(s).scope;
        assert_eq!(scope("::"), "unspecified");
        assert_eq!(scope("::1"), "loopback");
        assert_eq!(scope("::ffff:192.0.2.1"), "ipv4-mapped");
        assert_eq!(scope("fe80::1/64"), "link-local");
        assert_eq!(scope("febf:ffff::1"), "link-local");
        assert_eq!(scope("fec0::1"), "reserved");
        assert_eq!(scope("fd12:3456::1/48"), "unique-local");
        assert_eq!(scope("fc00::"), "unique-local");
        assert_eq!(scope("ff02::1"), "multicast");
        assert_eq!(scope("2001:db8::1"), "documentation");
        assert_eq!(scope("2606:4700::1111"), "global");
        assert_eq!(scope("3fff:ffff::1"), "global");
        assert_eq!(scope("4000::1"), "reserved");
    }

    #[test]
    fn invalid_inputs() {
        let err = |s: &str| Ipv6Cidr::parse(s).unwrap_err().to_string();
        assert_eq!(err("2001:db8::1/129"), "Invalid prefix length (0-128)");
        assert_eq!(err("2001:db8::1/"), "Invalid prefix length (0-128)");
        assert_eq!(err("2001:db8::1/-1"), "Invalid prefix length (0-128)");
        assert_eq!(err("2001:db8::g/64"), "Invalid IPv6 address");
        assert_eq!(err("2001:db8:::1"), "Invalid IPv6 address");
        assert_eq!(err("1:2:3:4:5:6:7:8:9"), "Invalid IPv6 address");
        assert_eq!(err("fe80::1%eth0"), "Invalid IPv6 address");
        assert_eq!(err("10.0.0.1"), "Invalid IPv6 address");
        assert_eq!(err(""), "Invalid IPv6 address");
    }
}
