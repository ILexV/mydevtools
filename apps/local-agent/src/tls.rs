//! One TLS handshake to one host and one port. The page shows the protocol,
//! the cipher, the expiry and the certificate chain the peer sent. A pasted
//! PEM stays in the certificate tool. The socket is closed without application data.

use std::{
    io,
    net::SocketAddr,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use rustls::{
    ClientConfig, DigitallySignedStruct, Error as TlsError, RootCertStore, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{ring::default_provider, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::{model::ApiError, policy::enforce_destination, tcp};

/// Handshakes in flight. Separate from the HTTP, ICMP, DNS and TCP caps.
pub(crate) const MAX_CONCURRENT_INSPECTIONS: usize = 2;
const MIN_TIMEOUT: Duration = Duration::from_millis(200);
const MAX_TIMEOUT: Duration = Duration::from_millis(10_000);
const MAX_CHAIN: usize = 16;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TlsInspectRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TlsInspectResponse {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) address: String,
    pub(crate) status: &'static str,
    pub(crate) elapsed_ms: u64,
    pub(crate) protocol: Option<String>,
    pub(crate) cipher: Option<String>,
    pub(crate) trusted: Option<bool>,
    pub(crate) certificates: Vec<TlsCertificate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TlsCertificate {
    pub(crate) subject: String,
    pub(crate) issuer: String,
    pub(crate) not_before: Option<String>,
    pub(crate) not_after: Option<String>,
    pub(crate) sha256: String,
}

pub(crate) struct Prepared {
    host: String,
    port: u16,
    timeout: Duration,
    server_name: ServerName<'static>,
}

enum HandshakeStop {
    Tcp(io::Error),
    Failed,
}

/// Syntax only. A bad host, port 0, or a timeout outside 200..=10000 ms does
/// not take an inspection slot. A pasted certificate field is rejected here
/// by `deny_unknown_fields` before this function runs.
pub(crate) fn prepare(host: &str, port: u16, timeout_ms: u64) -> Result<Prepared, ApiError> {
    if port == 0 {
        return Err(ApiError::invalid_request());
    }
    let timeout = Duration::from_millis(timeout_ms);
    if timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT {
        return Err(ApiError::invalid_request());
    }
    let host = tcp::normalize_host(host)?;
    let server_name =
        ServerName::try_from(host.clone()).map_err(|_| ApiError::invalid_request())?;
    Ok(Prepared {
        host,
        port,
        timeout,
        server_name,
    })
}

/// Resolves the first address, applies the same destination policy as TCP,
/// and completes one handshake. An untrusted or expired chain is still a
/// result: `trusted` is false and the certificates stay in the response.
pub(crate) async fn inspect_prepared(
    prepared: Prepared,
    agent_port: u16,
    allow_private: bool,
) -> Result<TlsInspectResponse, ApiError> {
    let host_for_resolve = prepared.host.clone();
    let address = tokio::task::spawn_blocking(move || tcp::resolve_host(&host_for_resolve))
        .await
        .map_err(|_| ApiError::busy())??;
    enforce_destination(address, prepared.port, agent_port, allow_private)?;
    let socket = SocketAddr::new(address, prepared.port);
    let started = Instant::now();
    let outcome = tokio::time::timeout(
        prepared.timeout,
        handshake(socket, prepared.server_name.clone()),
    )
    .await;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let mut response = TlsInspectResponse {
        host: prepared.host,
        port: prepared.port,
        address: address.to_string(),
        status: "handshake_failed",
        elapsed_ms,
        protocol: None,
        cipher: None,
        trusted: None,
        certificates: Vec::new(),
    };
    match outcome {
        Ok(Ok(done)) => {
            response.status = "ok";
            response.protocol = Some(done.protocol);
            response.cipher = Some(done.cipher);
            response.trusted = Some(done.trusted);
            response.certificates = done.certificates;
        }
        Ok(Err(HandshakeStop::Tcp(error))) => {
            response.status =
                tcp::classify_connect_error(error).map_err(|_| ApiError::tls_unavailable())?;
        }
        Ok(Err(HandshakeStop::Failed)) => {}
        Err(_) => response.status = "timeout",
    }
    Ok(response)
}

struct Done {
    protocol: String,
    cipher: String,
    trusted: bool,
    certificates: Vec<TlsCertificate>,
}

async fn handshake(
    socket: SocketAddr,
    server_name: ServerName<'static>,
) -> Result<Done, HandshakeStop> {
    let stream = TcpStream::connect(socket)
        .await
        .map_err(HandshakeStop::Tcp)?;
    let tls = connector()
        .connect(server_name.clone(), stream)
        .await
        .map_err(|_| HandshakeStop::Failed)?;
    let (_io, session) = tls.get_ref();
    let protocol = session
        .protocol_version()
        .and_then(|version| version.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let cipher = session
        .negotiated_cipher_suite()
        .map(|suite| suite.suite().as_str().unwrap_or("unknown"))
        .unwrap_or("unknown")
        .to_owned();
    let ders = session
        .peer_certificates()
        .map(|certs| certs.to_vec())
        .unwrap_or_default();
    drop(tls);
    if ders.is_empty() {
        return Err(HandshakeStop::Failed);
    }
    let trusted = chain_is_trusted(&ders, &server_name);
    let certificates = ders
        .iter()
        .take(MAX_CHAIN)
        .map(describe_certificate)
        .collect();
    Ok(Done {
        protocol,
        cipher,
        trusted,
        certificates,
    })
}

fn connector() -> TlsConnector {
    static CONNECTOR: OnceLock<TlsConnector> = OnceLock::new();
    CONNECTOR
        .get_or_init(|| {
            let config = ClientConfig::builder_with_provider(provider())
                .with_safe_default_protocol_versions()
                .expect("ring supports the default TLS versions")
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(ObserveServerCerts))
                .with_no_client_auth();
            TlsConnector::from(Arc::new(config))
        })
        .clone()
}

pub(crate) fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    static PROVIDER: OnceLock<Arc<rustls::crypto::CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| {
            let provider = default_provider();
            let _ = provider.clone().install_default();
            Arc::new(provider)
        })
        .clone()
}

/// Accepts any chain (signatures still checked); for inspection and for
/// HTTP requests that turned certificate verification off.
pub(crate) fn observe_verifier() -> Arc<dyn ServerCertVerifier> {
    Arc::new(ObserveServerCerts)
}

fn trust_verifier() -> Arc<rustls::client::WebPkiServerVerifier> {
    static VERIFIER: OnceLock<Arc<rustls::client::WebPkiServerVerifier>> = OnceLock::new();
    VERIFIER
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
                .build()
                .expect("webpki roots build a verifier")
        })
        .clone()
}

fn chain_is_trusted(ders: &[CertificateDer<'static>], server_name: &ServerName<'_>) -> bool {
    let Some((end, intermediates)) = ders.split_first() else {
        return false;
    };
    trust_verifier()
        .verify_server_cert(end, intermediates, server_name, &[], UnixTime::now())
        .is_ok()
}

/// Subject, issuer, validity and SHA-256 of one certificate.
pub(crate) fn describe_certificate(der: &CertificateDer<'_>) -> TlsCertificate {
    let mut hasher = Sha256::new();
    hasher.update(der.as_ref());
    let sha256 = hex::encode(hasher.finalize());
    let Some(view) = certificate_names(der.as_ref()) else {
        return TlsCertificate {
            subject: String::new(),
            issuer: String::new(),
            not_before: None,
            not_after: None,
            sha256,
        };
    };
    TlsCertificate {
        subject: view.subject,
        issuer: view.issuer,
        not_before: Some(view.not_before),
        not_after: Some(view.not_after),
        sha256,
    }
}

struct CertificateNames {
    subject: String,
    issuer: String,
    not_before: String,
    not_after: String,
}

/// Subject, issuer and the two validity dates from one certificate.
/// Trust is decided by webpki. This only labels the chain the peer sent.
fn certificate_names(der: &[u8]) -> Option<CertificateNames> {
    let (_, certificate) = der_tlv(der, 0x30)?;
    let (_, tbs) = der_tlv(certificate, 0x30)?;
    let mut rest = tbs;
    if rest.first() == Some(&0xA0) {
        let (next, _) = der_tlv(rest, 0xA0)?;
        rest = next;
    }
    let (next, _, _) = der_any(rest)?;
    let (next, _) = der_tlv(next, 0x30)?;
    let (next, issuer) = der_tlv(next, 0x30)?;
    let (next, validity) = der_tlv(next, 0x30)?;
    let (_, subject) = der_tlv(next, 0x30)?;
    let (after, not_before) = der_time(validity)?;
    let (_, not_after) = der_time(after)?;
    Some(CertificateNames {
        subject: der_name(subject)?,
        issuer: der_name(issuer)?,
        not_before,
        not_after,
    })
}

fn der_tlv(input: &[u8], tag: u8) -> Option<(&[u8], &[u8])> {
    let (rest, actual, content) = der_any(input)?;
    if actual != tag {
        return None;
    }
    Some((rest, content))
}

fn der_any(input: &[u8]) -> Option<(&[u8], u8, &[u8])> {
    let (tag, after_tag) = input.split_first()?;
    let (len, header) = der_length(after_tag)?;
    if header.len() < len {
        return None;
    }
    let (content, rest) = header.split_at(len);
    Some((rest, *tag, content))
}

fn der_length(input: &[u8]) -> Option<(usize, &[u8])> {
    let (first, rest) = input.split_first()?;
    if first & 0x80 == 0 {
        return Some((*first as usize, rest));
    }
    let count = (first & 0x7F) as usize;
    if count == 0 || count > 3 || rest.len() < count {
        return None;
    }
    let mut length = 0usize;
    for byte in &rest[..count] {
        length = length << 8 | *byte as usize;
    }
    Some((length, &rest[count..]))
}

fn der_time(input: &[u8]) -> Option<(&[u8], String)> {
    let (rest, tag, content) = der_any(input)?;
    let text = std::str::from_utf8(content).ok()?;
    let formatted = match tag {
        0x17 => format_utc_time(text)?,
        0x18 => format_generalized_time(text)?,
        _ => return None,
    };
    Some((rest, formatted))
}

fn format_utc_time(text: &str) -> Option<String> {
    let body = text.strip_suffix('Z')?;
    if body.len() < 10 {
        return None;
    }
    let year: u16 = body[0..2].parse().ok()?;
    let year = if year >= 50 { 1900 + year } else { 2000 + year };
    format_clock(year, &body[2..])
}

fn format_generalized_time(text: &str) -> Option<String> {
    let body = text.strip_suffix('Z')?;
    if body.len() < 12 {
        return None;
    }
    let year: u16 = body[0..4].parse().ok()?;
    format_clock(year, &body[4..])
}

fn format_clock(year: u16, rest: &str) -> Option<String> {
    if rest.len() < 8 {
        return None;
    }
    Some(format!(
        "{year:04}-{}-{}T{}:{}:{}Z",
        &rest[0..2],
        &rest[2..4],
        &rest[4..6],
        &rest[6..8],
        if rest.len() >= 10 { &rest[8..10] } else { "00" },
    ))
}

fn der_name(input: &[u8]) -> Option<String> {
    let mut rest = input;
    let mut parts = Vec::new();
    while !rest.is_empty() {
        let (next, rdn) = der_tlv(rest, 0x31)?;
        let mut attributes = Vec::new();
        let mut rdn_rest = rdn;
        while !rdn_rest.is_empty() {
            let (next_attr, attr) = der_tlv(rdn_rest, 0x30)?;
            let (value_bytes, oid) = der_tlv(attr, 0x06)?;
            let (_, tag, value) = der_any(value_bytes)?;
            attributes.push(format!("{}={}", oid_label(oid), der_string(tag, value)));
            rdn_rest = next_attr;
        }
        parts.push(attributes.join("+"));
        rest = next;
    }
    Some(parts.join(","))
}

fn oid_label(oid: &[u8]) -> &'static str {
    match oid {
        [0x55, 0x04, 0x03] => "CN",
        [0x55, 0x04, 0x06] => "C",
        [0x55, 0x04, 0x07] => "L",
        [0x55, 0x04, 0x08] => "ST",
        [0x55, 0x04, 0x0A] => "O",
        [0x55, 0x04, 0x0B] => "OU",
        [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x01] => "emailAddress",
        _ => "OID",
    }
}

fn der_string(tag: u8, value: &[u8]) -> String {
    let text = if tag == 0x1E {
        let units: Vec<u16> = value
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(value).into_owned()
    };
    text.replace([',', '+', '"', '\\', '='], "_")
}

/// Completes the handshake for an untrusted chain, then the caller reports
/// webpki trust separately. Handshake signatures are still checked. No
/// application data is written.
#[derive(Debug)]
struct ObserveServerCerts;

impl ServerCertVerifier for ObserveServerCerts {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_accepts_one_host_and_rejects_a_range() {
        let prepared = prepare(" [::1] ", 443, 5_000).expect("ipv6");
        assert_eq!(prepared.host, "::1");
        assert_eq!(prepared.port, 443);
        assert!(prepare("example.com", 0, 5_000).is_err());
        assert!(prepare("example.com", 443, 199).is_err());
        assert!(prepare("example.com", 443, 10_001).is_err());
        assert!(prepare("127.0.0.1:443", 443, 5_000).is_err());
        assert!(prepare("80-443", 443, 5_000).is_err());
        assert!(prepare("example-host.com", 443, 200).is_ok());
    }
}
