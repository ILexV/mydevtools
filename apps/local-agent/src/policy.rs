use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use axum::http::StatusCode;

use crate::model::ApiError;

pub(crate) fn enforce_destination(
    address: IpAddr,
    target_port: u16,
    agent_port: u16,
    allow_private: bool,
) -> Result<(), ApiError> {
    match address {
        IpAddr::V4(address) => enforce_v4(address, target_port, agent_port, allow_private),
        IpAddr::V6(address) => enforce_v6(address, target_port, agent_port, allow_private),
    }
}

fn enforce_v4(
    address: Ipv4Addr,
    target_port: u16,
    agent_port: u16,
    allow_private: bool,
) -> Result<(), ApiError> {
    let value = u32::from(address);

    if address.is_loopback() && target_port == agent_port {
        return Err(target_denied());
    }

    if in_v4(value, 0x0000_0000, 8)
        || in_v4(value, 0x6440_0000, 10)
        || in_v4(value, 0xa9fe_0000, 16)
        || in_v4(value, 0xc000_0000, 24)
        || in_v4(value, 0xc000_0200, 24)
        || in_v4(value, 0xc058_6300, 24)
        || in_v4(value, 0xc612_0000, 15)
        || in_v4(value, 0xc633_6400, 24)
        || in_v4(value, 0xcb00_7100, 24)
        || in_v4(value, 0xe000_0000, 4)
        || in_v4(value, 0xf000_0000, 4)
    {
        return Err(target_denied());
    }

    let private_or_loopback = address.is_private() || address.is_loopback();
    if private_or_loopback && !allow_private {
        return Err(private_network_denied());
    }

    Ok(())
}

fn enforce_v6(
    address: Ipv6Addr,
    target_port: u16,
    agent_port: u16,
    allow_private: bool,
) -> Result<(), ApiError> {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return enforce_v4(mapped, target_port, agent_port, allow_private);
    }

    if address.is_loopback() && target_port == agent_port {
        return Err(target_denied());
    }

    // Link-local, multicast, documentation, Teredo and other special-use ranges
    // are never valid HTTP client destinations.
    if address.is_unspecified()
        || address.is_unicast_link_local()
        || address.is_multicast()
        || address == Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254)
        || in_v6(address, 0x0100_0000_0000_0000_0000_0000_0000_0000, 64)
        || in_v6(address, 0x2001_0000_0000_0000_0000_0000_0000_0000, 23)
        || in_v6(address, 0x2001_0db8_0000_0000_0000_0000_0000_0000, 32)
        || in_v6(address, 0x3fff_0000_0000_0000_0000_0000_0000_0000, 20)
        || in_v6(address, 0x5f00_0000_0000_0000_0000_0000_0000_0000, 16)
        || in_v6(address, 0xfec0_0000_0000_0000_0000_0000_0000_0000, 10)
    {
        return Err(target_denied());
    }

    if (address.is_loopback() || address.is_unique_local()) && !allow_private {
        return Err(private_network_denied());
    }
    let bytes = address.octets();

    // Deprecated IPv4-compatible addresses can still be interpreted by some stacks.
    if bytes[..12] == [0; 12] && !address.is_unspecified() && !address.is_loopback() {
        return enforce_v4(
            Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]),
            target_port,
            agent_port,
            allow_private,
        );
    }

    // A network-specific NAT64 /48 can use different embedding lengths; its
    // low 32 bits alone do not identify the translated destination.
    if in_v6(address, 0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48) {
        return Err(target_denied());
    }
    // The well-known NAT64 /96 carries the complete IPv4 address in the suffix.
    if in_v6(address, 0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96) {
        return enforce_v4(
            Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]),
            target_port,
            agent_port,
            allow_private,
        );
    }

    // 6to4 embeds the routed IPv4 address immediately after 2002::/16.
    if in_v6(address, 0x2002_0000_0000_0000_0000_0000_0000_0000, 16) {
        return enforce_v4(
            Ipv4Addr::new(bytes[2], bytes[3], bytes[4], bytes[5]),
            target_port,
            agent_port,
            allow_private,
        );
    }

    // ISATAP interface identifiers embed IPv4 after 0000:5efe or 0200:5efe.
    if bytes[8..12] == [0x00, 0x00, 0x5e, 0xfe]
        || bytes[8..12] == [0x02, 0x00, 0x5e, 0xfe]
    {
        return enforce_v4(
            Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]),
            target_port,
            agent_port,
            allow_private,
        );
    }

    if !address.is_loopback()
        && !address.is_unique_local()
        && !in_v6(address, 0x2000_0000_0000_0000_0000_0000_0000_0000, 3)
    {
        return Err(target_denied());
    }

    Ok(())
}

fn in_v4(address: u32, network: u32, prefix: u8) -> bool {
    let mask = u32::MAX << (32 - prefix);
    address & mask == network & mask
}

fn in_v6(address: Ipv6Addr, network: u128, prefix: u8) -> bool {
    let mask = u128::MAX << (128 - prefix);
    u128::from(address) & mask == network & mask
}

fn private_network_denied() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "private_network_denied")
}

fn target_denied() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "target_denied")
}
