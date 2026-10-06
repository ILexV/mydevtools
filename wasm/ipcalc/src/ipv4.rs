use serde::{Deserialize, Serialize};
use std::fmt;
use std::net::Ipv4Addr;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq)]
pub struct Ipv4Cidr {
    address: u32,
    prefix_len: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CalculationResult {
    pub input: String,
    pub ip: String,
    pub prefix: u8,
    pub netmask: String,
    pub wildcard: String,
    pub network: String,
    pub broadcast: String,
    pub host_min: String,
    pub host_max: String,
    pub total_hosts: u64,
    pub usable_hosts: u64,
    pub class: String,
    pub is_private: bool,
    /// Address type of the entered IP: private | shared | loopback |
    /// link-local | documentation | multicast | reserved | public.
    pub scope: String,
    pub ip_binary: String,
    pub mask_binary: String,
}

#[derive(Debug, Clone)]
pub enum ParseError {
    InvalidFormat,
    InvalidIp,
    InvalidPrefix,
    InvalidMask,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ParseError::InvalidFormat => {
                write!(f, "Invalid format (expected IP/Prefix or IP Mask)")
            }
            ParseError::InvalidIp => write!(f, "Invalid IPv4 address"),
            ParseError::InvalidPrefix => write!(f, "Invalid prefix length (0-32)"),
            ParseError::InvalidMask => write!(f, "Invalid netmask"),
        }
    }
}

impl Ipv4Cidr {
    pub fn parse(input: &str) -> Result<Self, ParseError> {
        let input = input.trim();

        // Try CIDR notation: "192.168.1.1/24"
        if let Some((ip_str, prefix_str)) = input.split_once('/') {
            // Tolerate spaces around the slash ("10.0.0.1 / 8").
            let ip = Ipv4Addr::from_str(ip_str.trim()).map_err(|_| ParseError::InvalidIp)?;
            let prefix = prefix_str
                .trim()
                .parse::<u8>()
                .map_err(|_| ParseError::InvalidPrefix)?;
            if prefix > 32 {
                return Err(ParseError::InvalidPrefix);
            }
            return Ok(Self {
                address: u32::from(ip),
                prefix_len: prefix,
            });
        }

        // Try IP Mask notation: "192.168.1.1 255.255.255.0"
        // Split by whitespace
        let parts: Vec<&str> = input.split_whitespace().collect();
        if parts.len() == 2 {
            let ip = Ipv4Addr::from_str(parts[0]).map_err(|_| ParseError::InvalidIp)?;
            let mask = Ipv4Addr::from_str(parts[1]).map_err(|_| ParseError::InvalidMask)?;
            let mask_u32 = u32::from(mask);

            // Validate mask and convert to prefix
            let prefix = (!mask_u32).leading_zeros() as u8;
            // Verify it's a contiguous mask (no 0s followed by 1s)
            // A valid mask is ones followed by zeros.
            // In u32, !mask should be 00...0011...11 = 2^(32-prefix) - 1
            let valid_mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };

            if mask_u32 != valid_mask {
                return Err(ParseError::InvalidMask);
            }

            return Ok(Self {
                address: u32::from(ip),
                prefix_len: prefix,
            });
        }

        // Try just IP (assume /32)
        if let Ok(ip) = Ipv4Addr::from_str(input) {
            return Ok(Self {
                address: u32::from(ip),
                prefix_len: 32,
            });
        }

        Err(ParseError::InvalidFormat)
    }

    pub fn calculate(&self) -> CalculationResult {
        let ip = self.address;
        let prefix = self.prefix_len;

        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - prefix)
        };
        let wildcard = !mask;
        let network = ip & mask;
        let broadcast = network | wildcard;

        let (host_min, host_max, usable_hosts) = if prefix == 31 {
            (network, broadcast, 2) // Point-to-point links (RFC 3021)
        } else if prefix == 32 {
            (network, network, 1) // Single host
        } else {
            // /0../30: network and broadcast are not usable. /0 = 2^32 - 2
            // (previously reported as 0).
            (network + 1, broadcast - 1, (1u64 << (32 - prefix)) - 2)
        };

        let total_hosts = if prefix == 32 {
            1
        } else {
            1u64 << (32 - prefix)
        };

        CalculationResult {
            input: "".to_string(), // Filled by caller if needed
            ip: Ipv4Addr::from(ip).to_string(),
            prefix,
            netmask: Ipv4Addr::from(mask).to_string(),
            wildcard: Ipv4Addr::from(wildcard).to_string(),
            network: Ipv4Addr::from(network).to_string(),
            broadcast: Ipv4Addr::from(broadcast).to_string(),
            host_min: Ipv4Addr::from(host_min).to_string(),
            host_max: Ipv4Addr::from(host_max).to_string(),
            total_hosts,
            usable_hosts,
            class: self.get_class(),
            is_private: self.is_private(),
            scope: self.scope().to_string(),
            ip_binary: to_binary_string(ip),
            mask_binary: to_binary_string(mask),
        }
    }

    fn get_class(&self) -> String {
        let first_octet = (self.address >> 24) & 0xFF;
        if first_octet < 128 {
            "A".to_string()
        } else if first_octet < 192 {
            "B".to_string()
        } else if first_octet < 224 {
            "C".to_string()
        } else if first_octet < 240 {
            "D (Multicast)".to_string()
        } else {
            "E (Reserved)".to_string()
        }
    }

    fn is_private(&self) -> bool {
        let ip = self.address;
        // 10.0.0.0/8
        if (ip & 0xFF000000) == 0x0A000000 {
            return true;
        }
        // 172.16.0.0/12
        if (ip & 0xFFF00000) == 0xAC100000 {
            return true;
        }
        // 192.168.0.0/16
        if (ip & 0xFFFF0000) == 0xC0A80000 {
            return true;
        }
        false
    }

    /// IANA IPv4 special-purpose registry (main entries) for the entered
    /// address; anything not listed is "public" (globally routable).
    fn scope(&self) -> &'static str {
        let ip = self.address;
        let in_net = |net: u32, len: u32| ip & (u32::MAX << (32 - len)) == net;
        if self.is_private() {
            "private"
        } else if in_net(0x6440_0000, 10) {
            "shared" // 100.64.0.0/10 carrier-grade NAT (RFC 6598)
        } else if in_net(0x7F00_0000, 8) {
            "loopback"
        } else if in_net(0xA9FE_0000, 16) {
            "link-local"
        } else if in_net(0xC000_0200, 24) || in_net(0xC633_6400, 24) || in_net(0xCB00_7100, 24) {
            "documentation" // TEST-NET-1/2/3 (RFC 5737)
        } else if in_net(0xE000_0000, 4) {
            "multicast"
        } else if in_net(0x0000_0000, 8)
            || in_net(0xF000_0000, 4)
            || in_net(0xC612_0000, 15)
            || in_net(0xC000_0000, 24)
        {
            "reserved" // this-network, class E/broadcast, benchmarking, IETF protocol
        } else {
            "public"
        }
    }
}

fn to_binary_string(val: u32) -> String {
    let b = val.to_be_bytes(); // Big endian for network order logic
    format!("{:08b}.{:08b}.{:08b}.{:08b}", b[0], b[1], b[2], b[3])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_cidr() {
        let cidr = Ipv4Cidr::parse("192.168.1.1/24").unwrap();
        assert_eq!(cidr.prefix_len, 24);
        assert_eq!(Ipv4Addr::from(cidr.address).to_string(), "192.168.1.1");
    }

    #[test]
    fn test_parse_mask() {
        let cidr = Ipv4Cidr::parse("10.0.0.1 255.0.0.0").unwrap();
        assert_eq!(cidr.prefix_len, 8);
        assert_eq!(Ipv4Addr::from(cidr.address).to_string(), "10.0.0.1");
    }

    #[test]
    fn test_calculate_slash_24() {
        let res = Ipv4Cidr::parse("192.168.1.10/24").unwrap().calculate();
        assert_eq!(res.network, "192.168.1.0");
        assert_eq!(res.broadcast, "192.168.1.255");
        assert_eq!(res.netmask, "255.255.255.0");
        assert_eq!(res.wildcard, "0.0.0.255");
        assert_eq!(res.host_min, "192.168.1.1");
        assert_eq!(res.host_max, "192.168.1.254");
        assert_eq!(res.usable_hosts, 254);
        assert_eq!(res.class, "C");
        assert!(res.is_private);
    }

    #[test]
    fn test_calculate_slash_30() {
        let res = Ipv4Cidr::parse("10.10.10.1/30").unwrap().calculate();
        assert_eq!(res.usable_hosts, 2);
    }

    #[test]
    fn test_calculate_slash_31() {
        let res = Ipv4Cidr::parse("10.10.10.0/31").unwrap().calculate();
        assert_eq!(res.usable_hosts, 2); // RFC 3021
        assert_eq!(res.network, "10.10.10.0");
        assert_eq!(res.broadcast, "10.10.10.1");
    }

    #[test]
    fn test_calculate_slash_32() {
        let res = Ipv4Cidr::parse("10.10.10.1/32").unwrap().calculate();
        assert_eq!(res.usable_hosts, 1);
    }

    fn calc(input: &str) -> CalculationResult {
        Ipv4Cidr::parse(input).unwrap().calculate()
    }

    #[test]
    fn test_slash_0_whole_space() {
        let res = calc("1.2.3.4/0");
        assert_eq!(res.network, "0.0.0.0");
        assert_eq!(res.broadcast, "255.255.255.255");
        assert_eq!(res.netmask, "0.0.0.0");
        assert_eq!(res.wildcard, "255.255.255.255");
        assert_eq!(res.host_min, "0.0.0.1");
        assert_eq!(res.host_max, "255.255.255.254");
        assert_eq!(res.total_hosts, 4_294_967_296);
        assert_eq!(res.usable_hosts, 4_294_967_294);
    }

    #[test]
    fn test_slash_1_and_8() {
        let res = calc("200.0.0.1/1");
        assert_eq!(res.network, "128.0.0.0");
        assert_eq!(res.broadcast, "255.255.255.255");
        assert_eq!(res.usable_hosts, (1u64 << 31) - 2);
        let res = calc("10.20.30.40/8");
        assert_eq!(res.network, "10.0.0.0");
        assert_eq!(res.broadcast, "10.255.255.255");
        assert_eq!(res.host_min, "10.0.0.1");
        assert_eq!(res.host_max, "10.255.255.254");
        assert_eq!(res.total_hosts, 16_777_216);
        assert_eq!(res.usable_hosts, 16_777_214);
        assert_eq!(res.class, "A");
    }

    #[test]
    fn test_slash_31_32_host_ranges() {
        let res = calc("10.10.10.1/31");
        assert_eq!(res.host_min, "10.10.10.0");
        assert_eq!(res.host_max, "10.10.10.1");
        assert_eq!(res.total_hosts, 2);
        let res = calc("8.8.8.8/32");
        assert_eq!(res.network, "8.8.8.8");
        assert_eq!(res.broadcast, "8.8.8.8");
        assert_eq!(res.host_min, "8.8.8.8");
        assert_eq!(res.host_max, "8.8.8.8");
        assert_eq!(res.netmask, "255.255.255.255");
        assert_eq!(res.wildcard, "0.0.0.0");
        assert_eq!(res.total_hosts, 1);
        assert!(!res.is_private);
    }

    #[test]
    fn test_usable_hosts_every_prefix() {
        for p in 0u8..=32 {
            let res = calc(&format!("10.0.0.0/{p}"));
            let total = 1u64 << (32 - p as u32);
            assert_eq!(res.total_hosts, total, "/{p}");
            let usable = match p {
                31 => 2,
                32 => 1,
                _ => total - 2,
            };
            assert_eq!(res.usable_hosts, usable, "/{p}");
            assert_eq!(res.prefix, p);
        }
    }

    #[test]
    fn test_mask_notation_equals_cidr() {
        let a = calc("172.16.0.1 255.240.0.0");
        let b = calc("172.16.0.1/12");
        assert_eq!(a.prefix, 12);
        assert_eq!(a.network, b.network);
        assert_eq!(a.broadcast, "172.31.255.255");
        assert!(a.is_private);
        assert_eq!(calc("1.2.3.4 0.0.0.0").prefix, 0);
        assert_eq!(calc("1.2.3.4 255.255.255.255").prefix, 32);
        assert_eq!(calc("1.2.3.4   255.255.255.128").prefix, 25);
    }

    #[test]
    fn test_bare_ip_is_slash_32_and_whitespace_tolerated() {
        assert_eq!(calc("192.168.0.1").prefix, 32);
        assert_eq!(calc("  10.0.0.1/8  ").network, "10.0.0.0");
        assert_eq!(calc("10.0.0.1 / 8").network, "10.0.0.0");
    }

    #[test]
    fn test_invalid_inputs() {
        let err = |s: &str| Ipv4Cidr::parse(s).unwrap_err().to_string();
        assert_eq!(err("256.0.0.1/24"), "Invalid IPv4 address");
        assert_eq!(err("10.0.0/24"), "Invalid IPv4 address");
        assert_eq!(err("10.0.0.1/33"), "Invalid prefix length (0-32)");
        assert_eq!(err("10.0.0.1/-1"), "Invalid prefix length (0-32)");
        assert_eq!(err("10.0.0.1/"), "Invalid prefix length (0-32)");
        assert_eq!(err("10.0.0.1/abc"), "Invalid prefix length (0-32)");
        assert_eq!(err("10.0.0.1 255.0.255.0"), "Invalid netmask");
        assert_eq!(err("10.0.0.1 255.255.255.1"), "Invalid netmask");
        assert_eq!(err("10.0.0.1 300.0.0.0"), "Invalid netmask");
        assert_eq!(err(""), "Invalid format (expected IP/Prefix or IP Mask)");
        assert_eq!(err("hello"), "Invalid format (expected IP/Prefix or IP Mask)");
        assert_eq!(err("1.2.3.4 5.6.7.8 9"), "Invalid format (expected IP/Prefix or IP Mask)");
        // IPv6 goes through ipv6.rs; the IPv4 parser still rejects it.
        assert_eq!(err("2001:db8::1/64"), "Invalid IPv4 address");
        assert_eq!(err("::1"), "Invalid format (expected IP/Prefix or IP Mask)");
    }

    #[test]
    fn test_class_boundaries() {
        let class = |s: &str| calc(s).class;
        assert_eq!(class("0.0.0.0/8"), "A");
        assert_eq!(class("127.255.255.255/32"), "A");
        assert_eq!(class("128.0.0.0/16"), "B");
        assert_eq!(class("191.255.0.0/16"), "B");
        assert_eq!(class("192.0.0.0/24"), "C");
        assert_eq!(class("223.255.255.0/24"), "C");
        assert_eq!(class("224.0.0.1/32"), "D (Multicast)");
        assert_eq!(class("239.255.255.255/32"), "D (Multicast)");
        assert_eq!(class("240.0.0.1/32"), "E (Reserved)");
        assert_eq!(class("255.255.255.255/32"), "E (Reserved)");
    }

    #[test]
    fn test_private_ranges_rfc1918_boundaries() {
        let private = |s: &str| calc(s).is_private;
        assert!(private("10.0.0.0/32"));
        assert!(private("10.255.255.255/32"));
        assert!(!private("11.0.0.0/32"));
        assert!(!private("172.15.255.255/32"));
        assert!(private("172.16.0.0/32"));
        assert!(private("172.31.255.255/32"));
        assert!(!private("172.32.0.0/32"));
        assert!(private("192.168.0.0/32"));
        assert!(!private("192.169.0.0/32"));
        assert!(!private("8.8.8.8/32"));
    }

    #[test]
    fn test_binary_strings() {
        let res = calc("192.168.1.10/24");
        assert_eq!(res.ip_binary, "11000000.10101000.00000001.00001010");
        assert_eq!(res.mask_binary, "11111111.11111111.11111111.00000000");
        assert_eq!(calc("0.0.0.0/0").mask_binary, "00000000.00000000.00000000.00000000");
    }

    #[test]
    fn test_scopes() {
        let scope = |s: &str| calc(s).scope;
        assert_eq!(scope("192.168.1.10/24"), "private");
        assert_eq!(scope("172.31.0.1/16"), "private");
        assert_eq!(scope("8.8.8.8/32"), "public");
        assert_eq!(scope("1.1.1.1"), "public");
        assert_eq!(scope("100.64.0.1/10"), "shared");
        assert_eq!(scope("100.127.255.255"), "shared");
        assert_eq!(scope("100.128.0.0"), "public");
        assert_eq!(scope("127.0.0.1/8"), "loopback");
        assert_eq!(scope("169.254.10.20/16"), "link-local");
        assert_eq!(scope("192.0.2.1/24"), "documentation");
        assert_eq!(scope("198.51.100.7"), "documentation");
        assert_eq!(scope("203.0.113.200"), "documentation");
        assert_eq!(scope("224.0.0.251"), "multicast");
        assert_eq!(scope("239.255.255.250"), "multicast");
        assert_eq!(scope("0.0.0.0/0"), "reserved");
        assert_eq!(scope("198.18.0.1"), "reserved");
        assert_eq!(scope("198.20.0.1"), "public");
        assert_eq!(scope("255.255.255.255"), "reserved");
        assert_eq!(scope("240.0.0.1"), "reserved");
        // Public ranges are fully calculated — no private-only restriction.
        let r = calc("203.0.114.77/20");
        assert_eq!(r.network, "203.0.112.0");
        assert_eq!(r.broadcast, "203.0.127.255");
        assert_eq!(r.usable_hosts, 4094);
        assert_eq!(r.scope, "public");
    }
}
