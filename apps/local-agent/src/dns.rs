//! One-shot DNS lookup for `dns.lookup`.
//!
//! The query goes to the operating system's resolver (Linux `res_query`,
//! Windows `DnsQuery_A`). It is not DNS-over-HTTPS and it is not sent to a
//! MyDevTools server. The hosts file is not an answer: Windows skips it, and
//! Linux `res_query` never reads it. A, AAAA, CNAME, MX, NS, TXT, SOA and PTR
//! are the only types.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};

use crate::model::ApiError;

pub(crate) const MAX_CONCURRENT_LOOKUPS: usize = 4;

const MAX_NAME_CHARS: usize = 253;
const MAX_LABEL_CHARS: usize = 63;
const MAX_RECORDS: usize = 64;
const MAX_POINTER_HOPS: usize = 16;
const CLASS_IN: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecordType {
    A,
    Aaaa,
    Cname,
    Mx,
    Ns,
    Txt,
    Soa,
    Ptr,
}

impl RecordType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "A" => Some(Self::A),
            "AAAA" => Some(Self::Aaaa),
            "CNAME" => Some(Self::Cname),
            "MX" => Some(Self::Mx),
            "NS" => Some(Self::Ns),
            "TXT" => Some(Self::Txt),
            "SOA" => Some(Self::Soa),
            "PTR" => Some(Self::Ptr),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::Aaaa => "AAAA",
            Self::Cname => "CNAME",
            Self::Mx => "MX",
            Self::Ns => "NS",
            Self::Txt => "TXT",
            Self::Soa => "SOA",
            Self::Ptr => "PTR",
        }
    }

    fn code(self) -> u16 {
        match self {
            Self::A => 1,
            Self::Ns => 2,
            Self::Cname => 5,
            Self::Soa => 6,
            Self::Ptr => 12,
            Self::Mx => 15,
            Self::Txt => 16,
            Self::Aaaa => 28,
        }
    }

    fn from_code(code: u16) -> Option<Self> {
        Some(match code {
            1 => Self::A,
            2 => Self::Ns,
            5 => Self::Cname,
            6 => Self::Soa,
            12 => Self::Ptr,
            15 => Self::Mx,
            16 => Self::Txt,
            28 => Self::Aaaa,
            _ => return None,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DnsLookupRequest {
    pub(crate) name: String,
    /// Record type mnemonic: A, AAAA, CNAME, MX, NS, TXT, SOA, PTR.
    #[serde(rename = "type")]
    pub(crate) record_type: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DnsRecord {
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) record_type: String,
    pub(crate) ttl: u32,
    pub(crate) data: String,
    /// MX preference. Null for every other type.
    pub(crate) preference: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DnsLookupResponse {
    /// Name that was queried, after PTR reversal and ASCII folding.
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) record_type: String,
    /// `noerror`, `nodata`, or `nxdomain`. Other outcomes are errors.
    pub(crate) status: String,
    pub(crate) records: Vec<DnsRecord>,
}

pub(crate) struct Prepared {
    name: String,
    record_type: RecordType,
}

/// Validates the name and type before a lookup takes a concurrency slot.
pub(crate) fn prepare(name: &str, record_type: &str) -> Result<Prepared, ApiError> {
    let record_type = RecordType::parse(record_type).ok_or_else(ApiError::invalid_request)?;
    let name = normalize_query_name(name, record_type)?;
    Ok(Prepared { name, record_type })
}

pub(crate) fn lookup_prepared(prepared: Prepared) -> Result<DnsLookupResponse, ApiError> {
    query_resolver(&prepared)
}

/// Host name, or an IP when the type is PTR. Not a URL and not a scan.
fn normalize_query_name(input: &str, record_type: RecordType) -> Result<String, ApiError> {
    let name = input.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(ApiError::invalid_request());
    }
    if name.contains("://")
        || name
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, '/' | '\\' | '@'))
    {
        return Err(ApiError::invalid_request());
    }
    if !name.is_ascii() {
        return Err(ApiError::invalid_request());
    }
    let bare = name.trim_end_matches('.');
    if bare.is_empty() || bare.starts_with('.') || bare.contains("..") {
        return Err(ApiError::invalid_request());
    }
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if record_type != RecordType::Ptr {
            return Err(ApiError::invalid_request());
        }
        return Ok(ptr_name(ip));
    }
    for label in bare.split('.') {
        let len = label.len();
        if len == 0 || len > MAX_LABEL_CHARS {
            return Err(ApiError::invalid_request());
        }
        let mut chars = label.chars();
        let first = chars.next().unwrap_or(' ');
        let last = label.chars().next_back().unwrap_or(' ');
        if !first.is_ascii_alphanumeric() && first != '_' {
            return Err(ApiError::invalid_request());
        }
        if !last.is_ascii_alphanumeric() && last != '_' {
            return Err(ApiError::invalid_request());
        }
        if !label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            return Err(ApiError::invalid_request());
        }
    }
    Ok(bare.to_ascii_lowercase())
}

/// Reverse IPv4 `in-addr.arpa` or IPv6 nibble `ip6.arpa` name.
fn ptr_name(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(addr) => {
            let [a, b, c, d] = addr.octets();
            format!("{d}.{c}.{b}.{a}.in-addr.arpa")
        }
        IpAddr::V6(addr) => {
            let mut nibbles = [0u8; 32];
            for (index, byte) in addr.octets().into_iter().enumerate() {
                nibbles[index * 2] = byte >> 4;
                nibbles[index * 2 + 1] = byte & 0x0f;
            }
            let body = nibbles
                .iter()
                .rev()
                .map(|n| format!("{n:x}"))
                .collect::<Vec<_>>()
                .join(".");
            format!("{body}.ip6.arpa")
        }
    }
}

fn response_shell(prepared: &Prepared, status: &str, records: Vec<DnsRecord>) -> DnsLookupResponse {
    DnsLookupResponse {
        name: prepared.name.clone(),
        record_type: prepared.record_type.as_str().to_owned(),
        status: status.to_owned(),
        records,
    }
}

/// Answer section of one DNS message. A CNAME that arrived with the query is kept.
fn parse_message(prepared: &Prepared, buf: &[u8]) -> Result<DnsLookupResponse, ApiError> {
    if buf.len() < 12 {
        return Err(ApiError::dns_unavailable());
    }
    if buf[2] & 0x02 != 0 {
        return Err(ApiError::dns_truncated());
    }
    if buf[2] & 0x80 == 0 {
        return Err(ApiError::dns_unavailable());
    }
    let rcode = buf[3] & 0x0f;
    let questions = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let answers = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    let mut cursor = 12;
    for _ in 0..questions {
        cursor = skip_name(buf, cursor).map_err(|_| ApiError::dns_unavailable())?;
        cursor = cursor
            .checked_add(4)
            .ok_or_else(ApiError::dns_unavailable)?;
        if cursor > buf.len() {
            return Err(ApiError::dns_unavailable());
        }
    }
    let mut records = Vec::new();
    for _ in 0..answers {
        if records.len() >= MAX_RECORDS {
            break;
        }
        let (owner, next) = read_name(buf, cursor).map_err(|_| ApiError::dns_unavailable())?;
        if next + 10 > buf.len() {
            return Err(ApiError::dns_unavailable());
        }
        let rr_type = u16::from_be_bytes([buf[next], buf[next + 1]]);
        let class = u16::from_be_bytes([buf[next + 2], buf[next + 3]]);
        let ttl = u32::from_be_bytes([buf[next + 4], buf[next + 5], buf[next + 6], buf[next + 7]]);
        let rdlen = u16::from_be_bytes([buf[next + 8], buf[next + 9]]) as usize;
        let rdata = next + 10;
        let rdata_end = rdata
            .checked_add(rdlen)
            .ok_or_else(ApiError::dns_unavailable)?;
        if rdata_end > buf.len() {
            return Err(ApiError::dns_unavailable());
        }
        cursor = rdata_end;
        if class != CLASS_IN {
            continue;
        }
        let Some(kind) = RecordType::from_code(rr_type) else {
            continue;
        };
        if let Some(record) = decode_rdata(buf, rdata, rdata_end, owner, kind, ttl) {
            records.push(record);
        }
    }
    let status = match rcode {
        0 if records.is_empty() => "nodata",
        0 => "noerror",
        3 => "nxdomain",
        _ => return Err(ApiError::dns_unavailable()),
    };
    Ok(response_shell(prepared, status, records))
}

fn decode_rdata(
    buf: &[u8],
    start: usize,
    end: usize,
    owner: String,
    kind: RecordType,
    ttl: u32,
) -> Option<DnsRecord> {
    let (data, preference) = match kind {
        RecordType::A => {
            if end - start != 4 {
                return None;
            }
            (
                Ipv4Addr::new(buf[start], buf[start + 1], buf[start + 2], buf[start + 3])
                    .to_string(),
                None,
            )
        }
        RecordType::Aaaa => {
            if end - start != 16 {
                return None;
            }
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&buf[start..end]);
            (Ipv6Addr::from(octets).to_string(), None)
        }
        RecordType::Cname | RecordType::Ns | RecordType::Ptr => {
            let (name, next) = read_name(buf, start).ok()?;
            if next != end {
                return None;
            }
            (display_name(&name), None)
        }
        RecordType::Mx => {
            if end - start < 2 {
                return None;
            }
            let preference = u16::from_be_bytes([buf[start], buf[start + 1]]) as u32;
            let (name, next) = read_name(buf, start + 2).ok()?;
            if next != end {
                return None;
            }
            (display_name(&name), Some(preference))
        }
        RecordType::Soa => {
            let (mname, after_m) = read_name(buf, start).ok()?;
            let (rname, after_r) = read_name(buf, after_m).ok()?;
            if end - after_r != 20 {
                return None;
            }
            let mut values = [0u32; 5];
            for (index, value) in values.iter_mut().enumerate() {
                let at = after_r + index * 4;
                *value = u32::from_be_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
            }
            (
                format!(
                    "{} {} {} {} {} {} {}",
                    display_name(&mname),
                    display_name(&rname),
                    values[0],
                    values[1],
                    values[2],
                    values[3],
                    values[4]
                ),
                None,
            )
        }
        RecordType::Txt => (decode_txt(&buf[start..end])?, None),
    };
    Some(DnsRecord {
        name: display_name(&owner),
        record_type: kind.as_str().to_owned(),
        ttl,
        data,
        preference,
    })
}

fn display_name(name: &str) -> String {
    if name.is_empty() {
        ".".to_owned()
    } else {
        name.to_owned()
    }
}

fn decode_txt(rdata: &[u8]) -> Option<String> {
    let mut out = String::new();
    let mut index = 0;
    if rdata.is_empty() {
        return Some(out);
    }
    while index < rdata.len() {
        let len = rdata[index] as usize;
        index += 1;
        if index + len > rdata.len() {
            return None;
        }
        let chunk = &rdata[index..index + len];
        index += len;
        let text = String::from_utf8_lossy(chunk);
        for ch in text.chars() {
            if ch.is_control() && ch != '\t' {
                out.push('\u{FFFD}');
            } else {
                out.push(ch);
            }
        }
    }
    Some(out)
}

fn skip_name(buf: &[u8], at: usize) -> Result<usize, ()> {
    Ok(read_name(buf, at)?.1)
}

/// Reads a possibly compressed domain name. The second value is the cursor
/// just after this occurrence, not after a jumped-to name.
fn read_name(buf: &[u8], at: usize) -> Result<(String, usize), ()> {
    let mut pos = at;
    let mut end = at;
    let mut jumped = false;
    let mut hops = 0usize;
    let mut labels = Vec::new();
    let mut chars = 0usize;
    loop {
        if hops > MAX_POINTER_HOPS || pos >= buf.len() {
            return Err(());
        }
        let len = buf[pos];
        if len == 0 {
            if !jumped {
                end = pos + 1;
            }
            break;
        }
        if len & 0xC0 == 0xC0 {
            if pos + 1 >= buf.len() {
                return Err(());
            }
            let pointer = (((len as usize) & 0x3F) << 8) | buf[pos + 1] as usize;
            if pointer >= pos {
                return Err(());
            }
            if !jumped {
                end = pos + 2;
            }
            pos = pointer;
            jumped = true;
            hops += 1;
            continue;
        }
        if len & 0xC0 != 0 {
            return Err(());
        }
        let start = pos + 1;
        let stop = start + len as usize;
        if stop > buf.len() {
            return Err(());
        }
        let label = std::str::from_utf8(&buf[start..stop]).map_err(|_| ())?;
        if !label.is_ascii() {
            return Err(());
        }
        let extra = label.len() + usize::from(!labels.is_empty());
        if chars + extra > MAX_NAME_CHARS {
            return Err(());
        }
        chars += extra;
        labels.push(label.to_owned());
        pos = stop;
        if !jumped {
            end = pos;
        }
        hops += 1;
    }
    Ok((labels.join("."), end))
}

#[cfg(target_os = "linux")]
fn query_resolver(prepared: &Prepared) -> Result<DnsLookupResponse, ApiError> {
    let mut name = prepared.name.clone();
    name.push('\0');
    let mut buf = vec![0u8; 65_535];
    let rc = unsafe {
        // `res_query` is the default glibc symbol (`res_query@@GLIBC_2.34`).
        // `__res_query` exists only as the old versioned symbol and does not link.
        res_query(
            name.as_ptr().cast(),
            CLASS_IN as libc::c_int,
            prepared.record_type.code() as libc::c_int,
            buf.as_mut_ptr(),
            buf.len() as libc::c_int,
        )
    };
    if rc < 0 {
        return match unsafe { *__h_errno_location() } {
            1 => Ok(response_shell(prepared, "nxdomain", Vec::new())),
            4 => Ok(response_shell(prepared, "nodata", Vec::new())),
            2 => Err(ApiError::dns_timeout()),
            _ => Err(ApiError::dns_unavailable()),
        };
    }
    let len = rc as usize;
    if !(12..=buf.len()).contains(&len) {
        return Err(ApiError::dns_unavailable());
    }
    buf.truncate(len);
    parse_message(prepared, &buf)
}

#[cfg(target_os = "linux")]
unsafe extern "C" {
    /// System resolver query. Uses this computer's `resolv.conf` and its search list.
    fn res_query(
        dname: *const libc::c_char,
        class: libc::c_int,
        qtype: libc::c_int,
        answer: *mut u8,
        anslen: libc::c_int,
    ) -> libc::c_int;
    fn __h_errno_location() -> *mut libc::c_int;
}

/// Windows DNS client. `DNS_QUERY_NO_HOSTS_FILE` keeps the hosts file out of
/// the answer so a lookup stays a DNS query. The configured resolver is unchanged.
#[cfg(windows)]
fn query_resolver(prepared: &Prepared) -> Result<DnsLookupResponse, ApiError> {
    use windows_sys::Win32::NetworkManagement::Dns::{
        DNS_QUERY_NO_HOSTS_FILE, DNS_RECORDA, DnsFree, DnsFreeRecordList, DnsQuery_A,
    };

    let mut encoded = prepared.name.clone();
    encoded.push('\0');
    let mut head: *mut DNS_RECORDA = std::ptr::null_mut();
    let status = unsafe {
        DnsQuery_A(
            encoded.as_ptr().cast(),
            prepared.record_type.code(),
            DNS_QUERY_NO_HOSTS_FILE,
            std::ptr::null_mut(),
            &mut head,
            std::ptr::null_mut(),
        )
    };
    if status == 9003 || status == 9501 || status == 1460 {
        if !head.is_null() {
            unsafe { DnsFree(head.cast(), DnsFreeRecordList) };
        }
        if status == 1460 {
            return Err(ApiError::dns_timeout());
        }
        let outcome = if status == 9003 { "nxdomain" } else { "nodata" };
        return Ok(response_shell(prepared, outcome, Vec::new()));
    }
    if status != 0 {
        if !head.is_null() {
            unsafe { DnsFree(head.cast(), DnsFreeRecordList) };
        }
        return Err(ApiError::dns_unavailable());
    }
    let mut records = Vec::new();
    let mut cursor = head;
    while !cursor.is_null() && records.len() < MAX_RECORDS {
        let record = unsafe { &*cursor };
        cursor = record.pNext;
        let section = unsafe { record.Flags.S._bitfield } & 0b11;
        if section != 1 {
            continue;
        }
        let Some(kind) = RecordType::from_code(record.wType) else {
            continue;
        };
        let owner = unsafe { cstr_lossy(record.pName.cast()) };
        if let Some(decoded) = windows_record(record, owner, kind) {
            records.push(decoded);
        }
    }
    unsafe { DnsFree(head.cast(), DnsFreeRecordList) };
    let status_name = if records.is_empty() {
        "nodata"
    } else {
        "noerror"
    };
    Ok(response_shell(prepared, status_name, records))
}

#[cfg(windows)]
fn windows_record(
    record: &windows_sys::Win32::NetworkManagement::Dns::DNS_RECORDA,
    owner: String,
    kind: RecordType,
) -> Option<DnsRecord> {
    let (data, preference) = unsafe {
        match kind {
            RecordType::A => {
                let ip = u32::from_be(record.Data.A.IpAddress);
                (Ipv4Addr::from(ip).to_string(), None)
            }
            RecordType::Aaaa => {
                let octets = record.Data.AAAA.Ip6Address.IP6Byte;
                (Ipv6Addr::from(octets).to_string(), None)
            }
            RecordType::Cname | RecordType::Ns | RecordType::Ptr => {
                (cstr_lossy(record.Data.PTR.pNameHost.cast()), None)
            }
            RecordType::Mx => {
                let preference = record.Data.MX.wPreference as u32;
                (
                    cstr_lossy(record.Data.MX.pNameExchange.cast()),
                    Some(preference),
                )
            }
            RecordType::Soa => {
                let primary = cstr_lossy(record.Data.SOA.pNamePrimaryServer.cast());
                let admin = cstr_lossy(record.Data.SOA.pNameAdministrator.cast());
                (
                    format!(
                        "{primary} {admin} {} {} {} {} {}",
                        record.Data.SOA.dwSerialNo,
                        record.Data.SOA.dwRefresh,
                        record.Data.SOA.dwRetry,
                        record.Data.SOA.dwExpire,
                        record.Data.SOA.dwDefaultTtl
                    ),
                    None,
                )
            }
            RecordType::Txt => {
                let count = record.Data.TXT.dwStringCount as usize;
                if count > 64 {
                    return None;
                }
                let mut text = String::new();
                let first = record.Data.TXT.pStringArray.as_ptr();
                for index in 0..count {
                    let part = cstr_lossy((*first.add(index)).cast());
                    text.push_str(&part);
                }
                (text, None)
            }
        }
    };
    Some(DnsRecord {
        name: display_name(&owner),
        record_type: kind.as_str().to_owned(),
        ttl: record.dwTtl,
        data,
        preference,
    })
}

#[cfg(windows)]
fn cstr_lossy(ptr: *const u8) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe {
        let bytes = std::ffi::CStr::from_ptr(ptr.cast()).to_bytes();
        let capped = if bytes.len() > MAX_NAME_CHARS {
            &bytes[..MAX_NAME_CHARS]
        } else {
            bytes
        };
        String::from_utf8_lossy(capped).into_owned()
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn query_resolver(_prepared: &Prepared) -> Result<DnsLookupResponse, ApiError> {
    Err(ApiError::dns_unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_wire(name: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for label in name.split('.') {
            out.push(label.len() as u8);
            out.extend(label.as_bytes());
        }
        out.push(0);
        out
    }

    fn message(rcode: u8, question: &str, answers: &[u8]) -> Vec<u8> {
        let qname = name_wire(question);
        let mut buf = vec![0u8; 12];
        buf[2] = 0x81;
        buf[3] = 0x80 | rcode;
        buf[5] = 1;
        buf[7] = 1;
        buf.extend(qname);
        buf.extend_from_slice(&[0, 1, 0, 1]);
        let before = buf.len();
        buf.extend_from_slice(answers);
        if answers.is_empty() {
            buf[7] = 0;
        }
        let _ = before;
        buf
    }

    fn prepared(name: &str, record_type: RecordType) -> Prepared {
        Prepared {
            name: name.to_owned(),
            record_type,
        }
    }

    #[test]
    fn query_name_accepts_a_host_and_reverses_ptr() {
        let host = prepare("Example.COM.", "A").expect("host");
        assert_eq!(host.name, "example.com");
        assert_eq!(host.record_type, RecordType::A);
        let ptr = prepare("127.0.0.1", "PTR").expect("ptr");
        assert_eq!(ptr.name, "1.0.0.127.in-addr.arpa");
        let v6 = prepare("::1", "ptr").ok();
        assert!(v6.is_none(), "type is case-sensitive");
        let v6 = prepare("::1", "PTR").expect("v6");
        assert_eq!(
            v6.name,
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa"
        );
        assert!(prepare("http://example.com", "A").is_err());
        assert!(prepare("127.0.0.1", "A").is_err());
        assert!(prepare("example.com", "ANY").is_err());
        assert!(prepare("_dmarc.example.com", "TXT").is_ok());
    }

    #[test]
    fn parser_reads_address_mail_text_and_soa_records() {
        let question = "example.com";
        let qname = name_wire(question);
        let mut packet = vec![0x12, 0x34, 0x81, 0x80, 0, 1, 0, 4, 0, 0, 0, 0];
        packet.extend(&qname);
        packet.extend_from_slice(&[0, 1, 0, 1]);
        let pointer = [0xC0, 0x0C];
        packet.extend(&pointer);
        packet.extend_from_slice(&[0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);
        packet.extend(&pointer);
        packet.extend_from_slice(&[0, 15, 0, 1, 0, 0, 0, 60, 0, 9, 0, 10]);
        packet.extend(name_wire("mail.example.com"));
        // Fix MX rdlen: preference 2 + mail.example.com wire.
        let mail = name_wire("mail.example.com");
        let mx_rdlen_at = packet.len() - mail.len() - 2 - 2;
        let mx_rdlen = (2 + mail.len()) as u16;
        packet[mx_rdlen_at] = (mx_rdlen >> 8) as u8;
        packet[mx_rdlen_at + 1] = mx_rdlen as u8;
        packet.extend(&pointer);
        packet.extend_from_slice(&[0, 16, 0, 1, 0, 0, 0, 60, 0, 5, 4, b'v', b'=', b's', b'1']);
        packet.extend(&pointer);
        let soa_start = packet.len();
        packet.extend_from_slice(&[0, 6, 0, 1, 0, 0, 0, 60, 0, 0]);
        let rdata_at = packet.len();
        packet.extend(name_wire("ns.example.com"));
        packet.extend(name_wire("host.example.com"));
        for value in [1u32, 2, 3, 4, 5] {
            packet.extend(value.to_be_bytes());
        }
        let rdlen = (packet.len() - rdata_at) as u16;
        packet[soa_start + 8] = (rdlen >> 8) as u8;
        packet[soa_start + 9] = rdlen as u8;

        let parsed =
            parse_message(&prepared("example.com", RecordType::A), &packet).expect("parse");
        assert_eq!(parsed.status, "noerror");
        assert_eq!(parsed.records.len(), 4);
        assert_eq!(parsed.records[0].data, "93.184.216.34");
        assert_eq!(parsed.records[1].preference, Some(10));
        assert_eq!(parsed.records[1].data, "mail.example.com");
        assert_eq!(parsed.records[2].data, "v=s1");
        assert!(
            parsed.records[3]
                .data
                .starts_with("ns.example.com host.example.com 1 2 3 4 5")
        );
    }

    #[test]
    fn parser_reports_nxdomain_nodata_and_rejects_a_pointer_loop() {
        let empty = message(0, "example.com", &[]);
        let nodata =
            parse_message(&prepared("example.com", RecordType::Aaaa), &empty).expect("nodata");
        assert_eq!(nodata.status, "nodata");
        let missing = message(3, "missing.example", &[]);
        let nx = parse_message(&prepared("missing.example", RecordType::A), &missing).expect("nx");
        assert_eq!(nx.status, "nxdomain");

        let mut looped = message(0, "example.com", &[]);
        looped[7] = 1;
        looped.extend_from_slice(&[0xC0, (looped.len()) as u8]);
        // Point at the pointer itself: offset is the current position.
        let at = looped.len() - 2;
        looped[at + 1] = at as u8;
        assert!(parse_message(&prepared("example.com", RecordType::A), &looped).is_err());
    }

    #[test]
    fn ipv6_ptr_reverses_nibbles() {
        let ip: Ipv6Addr = "2001:db8::1".parse().unwrap();
        let name = ptr_name(IpAddr::V6(ip));
        assert!(name.ends_with(".ip6.arpa"));
        assert!(name.starts_with("1.0.0.0"));
        assert!(name.contains("8.b.d.0.1.0.0.2.ip6.arpa"));
    }
}
