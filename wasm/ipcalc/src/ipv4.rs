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
            let ip = Ipv4Addr::from_str(ip_str).map_err(|_| ParseError::InvalidIp)?;
            let prefix = prefix_str
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
            (
                network + 1,
                broadcast - 1,
                if prefix == 0 {
                    0
                } else {
                    (1u64 << (32 - prefix)) - 2
                },
            )
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
}
