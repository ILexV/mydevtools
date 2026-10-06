use wasm_bindgen::prelude::*;

use rcgen::{CertificateParams, DistinguishedName, DnType, Ia5String, KeyPair, SanType, SignatureAlgorithm};
use std::net::IpAddr;
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::*;
use x509_parser::public_key::PublicKey;

const X509_ALG_ED25519: u8 = 1;
const X509_ALG_ECDSA_P256: u8 = 2;
const X509_ALG_ECDSA_P384: u8 = 3;

const OID_RSA_ENCRYPTION: &str = "1.2.840.113549.1.1.1";
const OID_ECDSA: &str = "1.2.840.10045.2.1";

const OID_SHA1_WITH_RSA: &str = "1.2.840.113549.1.1.5";
const OID_MD5_WITH_RSA: &str = "1.2.840.113549.1.1.4";
const OID_ECDSA_WITH_SHA1: &str = "1.2.840.10045.4.1";

const OID_SECP256R1: &str = "1.2.840.10045.3.1.7";
const OID_SECP384R1: &str = "1.3.132.0.34";

fn signature_algorithm(alg: u8) -> Result<&'static SignatureAlgorithm, JsValue> {
    match alg {
        X509_ALG_ED25519 => Ok(&rcgen::PKCS_ED25519),
        X509_ALG_ECDSA_P256 => Ok(&rcgen::PKCS_ECDSA_P256_SHA256),
        X509_ALG_ECDSA_P384 => Ok(&rcgen::PKCS_ECDSA_P384_SHA384),
        _ => Err(JsValue::from_str("unsupported algorithm")),
    }
}

fn build_params(
    _alg: u8,
    subject_cn: Option<String>,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
) -> Result<CertificateParams, JsValue> {
    let mut params = if san_dns.is_empty() {
        CertificateParams::default()
    } else {
        CertificateParams::new(san_dns).map_err(|_| JsValue::from_str("invalid san"))?
    };

    if let Some(cn) = subject_cn {
        if !cn.is_empty() {
            let mut dn = DistinguishedName::new();
            dn.push(DnType::CommonName, cn);
            params.distinguished_name = dn;
        }
    }

    for ip in san_ip {
        let ip: IpAddr = ip.parse().map_err(|_| JsValue::from_str("invalid ip"))?;
        params.subject_alt_names.push(SanType::IpAddress(ip));
    }

    Ok(params)
}

fn parse_pem_to_der(pem: &str) -> Result<Vec<u8>, JsValue> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(pem.as_bytes())
        .map_err(|_| JsValue::from_str("invalid PEM"))?;
    Ok(pem.contents)
}

fn parse_cert_from_der(der: &[u8]) -> Result<X509Certificate<'_>, JsValue> {
    let (_, cert) = parse_x509_certificate(der)
        .map_err(|_| JsValue::from_str("invalid certificate"))?;
    Ok(cert)
}

fn escape_json(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out
}

fn san_to_strings(cert: &X509Certificate<'_>) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in san.value.general_names.iter() {
            match name {
                GeneralName::DNSName(name) => out.push(format!("DNS:{}", name)),
                GeneralName::IPAddress(bytes) => {
                    if bytes.len() == 4 {
                        if let Ok(arr) = <[u8; 4]>::try_from(bytes.as_ref()) {
                            out.push(format!("IP:{}", IpAddr::from(arr)));
                        }
                    } else if bytes.len() == 16 {
                        if let Ok(arr) = <[u8; 16]>::try_from(bytes.as_ref()) {
                            out.push(format!("IP:{}", IpAddr::from(arr)));
                        }
                    }
                }
                GeneralName::RFC822Name(name) => out.push(format!("EMAIL:{}", name)),
                GeneralName::URI(name) => out.push(format!("URI:{}", name)),
                _ => {}
            }
        }
    }
    out
}

fn subject_string(cert: &X509Certificate<'_>) -> String {
    format!("{}", cert.subject())
}

fn issuer_string(cert: &X509Certificate<'_>) -> String {
    format!("{}", cert.issuer())
}

fn sig_alg_oid(cert: &X509Certificate<'_>) -> String {
    cert.signature_algorithm.algorithm.to_id_string()
}

fn public_key_alg_oid(cert: &X509Certificate<'_>) -> String {
    cert.tbs_certificate
        .subject_pki
        .algorithm
        .algorithm
        .to_id_string()
}

fn public_key_curve_oid(cert: &X509Certificate<'_>) -> Option<String> {
    let alg = &cert.tbs_certificate.subject_pki.algorithm;
    if alg.algorithm.to_id_string() != OID_ECDSA {
        return None;
    }
    let params = alg.parameters.as_ref()?;
    let oid = params.as_oid().ok()?;
    Some(oid.to_id_string())
}

fn public_key_bits(cert: &X509Certificate<'_>) -> Option<u32> {
    let spki = &cert.tbs_certificate.subject_pki;
    let alg = spki.algorithm.algorithm.to_id_string();
    if alg == OID_RSA_ENCRYPTION {
        if let Ok(public_key) = spki.parsed() {
            if let PublicKey::RSA(rsa) = public_key {
                let bytes = rsa.modulus;
                if bytes.is_empty() {
                    return None;
                }
                let mut bits = (bytes.len() * 8) as u32;
                let leading = bytes[0].leading_zeros() as u32;
                bits = bits.saturating_sub(leading);
                return Some(bits);
            }
        }
    }
    None
}

fn validity_strings(cert: &X509Certificate<'_>) -> (String, String) {
    let validity = cert.validity();
    (format!("{}", validity.not_before), format!("{}", validity.not_after))
}

fn cert_to_json(cert: &X509Certificate<'_>) -> String {
    let subject = escape_json(&subject_string(cert));
    let issuer = escape_json(&issuer_string(cert));
    let (not_before, not_after) = validity_strings(cert);
    let not_before = escape_json(&not_before);
    let not_after = escape_json(&not_after);
    let sig_alg = escape_json(&sig_alg_oid(cert));
    let pk_alg = escape_json(&public_key_alg_oid(cert));
    let san = san_to_strings(cert)
        .into_iter()
        .map(|s| format!("\"{}\"", escape_json(&s)))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"subject\":\"{}\",\"issuer\":\"{}\",\"notBefore\":\"{}\",\"notAfter\":\"{}\",\"signatureAlgorithmOid\":\"{}\",\"publicKeyAlgorithmOid\":\"{}\",\"subjectAltNames\":[{}]}}",
        subject, issuer, not_before, not_after, sig_alg, pk_alg, san
    )
}

fn cert_warnings(cert: &X509Certificate<'_>, now_unix: i64) -> Vec<String> {
    let mut warnings = Vec::new();

    let sig_oid = sig_alg_oid(cert);
    if sig_oid == OID_SHA1_WITH_RSA || sig_oid == OID_ECDSA_WITH_SHA1 {
        warnings.push("signature uses SHA-1".to_string());
    }
    if sig_oid == OID_MD5_WITH_RSA {
        warnings.push("signature uses MD5".to_string());
    }

    let nb = cert.validity().not_before.to_datetime();
    if now_unix < nb.unix_timestamp() {
        warnings.push("certificate not yet valid".to_string());
    }
    let na = cert.validity().not_after.to_datetime();
    if now_unix > na.unix_timestamp() {
        warnings.push("certificate expired".to_string());
    }

    if let Some(bits) = public_key_bits(cert) {
        if bits < 3072 {
            warnings.push("RSA key size < 3072".to_string());
        }
    }

    if let Some(curve_oid) = public_key_curve_oid(cert) {
        if curve_oid != OID_SECP256R1 && curve_oid != OID_SECP384R1 {
            warnings.push("weak or unsupported EC curve".to_string());
        }
    }

    warnings
}

/// Generates a self-signed certificate and private key (PEM).
///
/// algorithm: 1 = Ed25519, 2 = ECDSA P-256, 3 = ECDSA P-384
/// Returns [cert_pem, key_pem].
#[wasm_bindgen]
pub fn x509_self_signed_pem(
    algorithm: u8,
    subject_cn: Option<String>,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
) -> Result<Vec<String>, JsValue> {
    let params = build_params(algorithm, subject_cn, san_dns, san_ip)?;
    let key_pair = KeyPair::generate_for(signature_algorithm(algorithm)?)
        .map_err(|_| JsValue::from_str("key generation failed"))?;
    let key_pem = key_pair.serialize_pem();
    let cert = params.self_signed(&key_pair)
        .map_err(|_| JsValue::from_str("certificate failed"))?;
    let cert_pem = cert.pem();

    Ok(vec![cert_pem, key_pem])
}

/// Generates a CSR and private key (PEM).
///
/// algorithm: 1 = Ed25519, 2 = ECDSA P-256, 3 = ECDSA P-384
/// Returns [csr_pem, key_pem].
#[wasm_bindgen]
pub fn x509_csr_pem(
    algorithm: u8,
    subject_cn: Option<String>,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
) -> Result<Vec<String>, JsValue> {
    let params = build_params(algorithm, subject_cn, san_dns, san_ip)?;
    let key_pair = KeyPair::generate_for(signature_algorithm(algorithm)?)
        .map_err(|_| JsValue::from_str("key generation failed"))?;
    let key_pem = key_pair.serialize_pem();
    let csr = params
        .serialize_request(&key_pair)
        .map_err(|_| JsValue::from_str("encode failed"))?;
    let csr_pem = csr.pem().map_err(|_| JsValue::from_str("encode failed"))?;

    Ok(vec![csr_pem, key_pem])
}

/// Upper bound for the validity period of generated certificates (~100 years).
pub const X509_MAX_VALIDITY_DAYS: u32 = 36_500;

/// Splits a DN like `CN=example.com, O=My Org\, Inc, C=US` on unescaped commas.
fn split_dn(subject: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut chars = subject.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if chars.peek().is_some() => cur.push(chars.next().unwrap_or_default()),
            ',' => parts.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    parts.push(cur);
    parts
}

/// Parses the X.509 tool's subject field. Accepts a bare common name
/// (`example.com`, legacy behaviour) or an RFC 4514-style list of
/// `CN`, `O`, `OU`, `C`, `ST`, `L` attributes (`CN=x,O=y,C=US`; keys are
/// case-insensitive, `\,` escapes a comma). Empty → `None` (rcgen default DN).
/// Errors are plain strings so native tests can assert on them.
pub(crate) fn parse_subject_dn(subject: &str) -> Result<Option<DistinguishedName>, String> {
    let subject = subject.trim();
    if subject.is_empty() {
        return Ok(None);
    }
    let mut dn = DistinguishedName::new();
    if !subject.contains('=') {
        dn.push(DnType::CommonName, subject);
        return Ok(Some(dn));
    }
    for part in split_dn(subject) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (key, value) = part
            .split_once('=')
            .ok_or_else(|| format!("invalid subject: missing '=' in \"{part}\""))?;
        let value = value.trim();
        if value.is_empty() {
            return Err(format!("invalid subject: empty value for {}", key.trim()));
        }
        let dn_type = match key.trim().to_ascii_uppercase().as_str() {
            "CN" => DnType::CommonName,
            "O" => DnType::OrganizationName,
            "OU" => DnType::OrganizationalUnitName,
            "C" => {
                if value.len() != 2 || !value.chars().all(|c| c.is_ascii_alphabetic()) {
                    return Err(format!("invalid subject: country must be 2 letters, got \"{value}\""));
                }
                DnType::CountryName
            }
            "ST" => DnType::StateOrProvinceName,
            "L" => DnType::LocalityName,
            other => return Err(format!("invalid subject: unsupported attribute \"{other}\"")),
        };
        let value = if matches!(dn_type, DnType::CountryName) { value.to_ascii_uppercase() } else { value.to_string() };
        dn.push(dn_type, value);
    }
    Ok(Some(dn))
}

/// Subject Alternative Names for generated certificates / CSRs: DNS names
/// (incl. `*.` wildcards), IP addresses and e-mail addresses (rfc822Name).
/// Written as the subjectAltName extension (CSR: inside extensionRequest).
fn build_params_ex(
    subject: &str,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
    san_email: Vec<String>,
) -> Result<CertificateParams, String> {
    let mut params = CertificateParams::default();
    if let Some(dn) = parse_subject_dn(subject)? {
        params.distinguished_name = dn;
    }
    for name in san_dns {
        let value = Ia5String::try_from(name.as_str()).map_err(|_| format!("invalid san: {name}"))?;
        if name.is_empty() {
            return Err("invalid san: empty DNS name".to_string());
        }
        params.subject_alt_names.push(SanType::DnsName(value));
    }
    for ip in san_ip {
        let addr: IpAddr = ip.parse().map_err(|_| format!("invalid san: {ip}"))?;
        params.subject_alt_names.push(SanType::IpAddress(addr));
    }
    for email in san_email {
        if !email.contains('@') {
            return Err(format!("invalid san: {email}"));
        }
        let value = Ia5String::try_from(email.as_str()).map_err(|_| format!("invalid san: {email}"))?;
        params.subject_alt_names.push(SanType::Rfc822Name(value));
    }
    Ok(params)
}

fn key_pair_for(algorithm: u8) -> Result<KeyPair, String> {
    let alg = match algorithm {
        X509_ALG_ED25519 => &rcgen::PKCS_ED25519,
        X509_ALG_ECDSA_P256 => &rcgen::PKCS_ECDSA_P256_SHA256,
        X509_ALG_ECDSA_P384 => &rcgen::PKCS_ECDSA_P384_SHA384,
        _ => return Err("unsupported algorithm".to_string()),
    };
    KeyPair::generate_for(alg).map_err(|_| "key generation failed".to_string())
}

pub(crate) fn self_signed_ex(
    algorithm: u8,
    subject: &str,
    validity_days: u32,
    now_unix: i64,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
    san_email: Vec<String>,
) -> Result<Vec<String>, String> {
    if validity_days == 0 || validity_days > X509_MAX_VALIDITY_DAYS {
        return Err(format!("invalid validity: {validity_days} days (1..={X509_MAX_VALIDITY_DAYS})"));
    }
    let mut params = build_params_ex(subject, san_dns, san_ip, san_email)?;
    let not_before =
        ::time::OffsetDateTime::from_unix_timestamp(now_unix).map_err(|_| "invalid current time".to_string())?;
    params.not_before = not_before;
    params.not_after = not_before + ::time::Duration::days(i64::from(validity_days));
    let key_pair = key_pair_for(algorithm)?;
    let cert = params.self_signed(&key_pair).map_err(|_| "certificate failed".to_string())?;
    Ok(vec![cert.pem(), key_pair.serialize_pem()])
}

pub(crate) fn csr_ex(
    algorithm: u8,
    subject: &str,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
    san_email: Vec<String>,
) -> Result<Vec<String>, String> {
    let params = build_params_ex(subject, san_dns, san_ip, san_email)?;
    let key_pair = key_pair_for(algorithm)?;
    let csr = params.serialize_request(&key_pair).map_err(|_| "encode failed".to_string())?;
    let csr_pem = csr.pem().map_err(|_| "encode failed".to_string())?;
    Ok(vec![csr_pem, key_pair.serialize_pem()])
}

/// Self-signed certificate with a full subject DN and an explicit validity
/// window `[now, now + validity_days]` (the legacy `x509_self_signed_pem`
/// only sets a CN and keeps rcgen's 1975–4096 default validity).
///
/// algorithm: 1 = Ed25519, 2 = ECDSA P-256, 3 = ECDSA P-384. Returns [cert_pem, key_pem].
#[wasm_bindgen]
pub fn x509_self_signed_pem_ex(
    algorithm: u8,
    subject: &str,
    validity_days: u32,
    now_unix: i64,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
    san_email: Vec<String>,
) -> Result<Vec<String>, JsValue> {
    self_signed_ex(algorithm, subject, validity_days, now_unix, san_dns, san_ip, san_email).map_err(|e| JsValue::from_str(&e))
}

/// CSR with a full subject DN (see `parse_subject_dn`) and optional SANs
/// (requested via the PKCS#9 extensionRequest attribute). Returns [csr_pem, key_pem].
#[wasm_bindgen]
pub fn x509_csr_pem_ex(
    algorithm: u8,
    subject: &str,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
    san_email: Vec<String>,
) -> Result<Vec<String>, JsValue> {
    csr_ex(algorithm, subject, san_dns, san_ip, san_email).map_err(|e| JsValue::from_str(&e))
}

/// Parses certificate from PEM and returns JSON string with basic fields.
#[wasm_bindgen]
pub fn x509_parse_pem(pem: &str) -> Result<String, JsValue> {
    let der = parse_pem_to_der(pem)?;
    let (_, cert) = parse_x509_certificate(&der)
        .map_err(|_| JsValue::from_str("invalid certificate"))?;
    Ok(cert_to_json(&cert))
}

/// Parses certificate from DER and returns JSON string with basic fields.
#[wasm_bindgen]
pub fn x509_parse_der(der: &[u8]) -> Result<String, JsValue> {
    let cert = parse_cert_from_der(der)?;
    Ok(cert_to_json(&cert))
}

/* ── CSR (PKCS#10) parsing ───────────────────────────────────────────── */

const OID_ED25519: &str = "1.3.101.112";

/// Short human label for a public key: "Ed25519", "ECDSA P-256", "RSA 2048", else the OID.
fn spki_label(spki: &x509_parser::x509::SubjectPublicKeyInfo<'_>) -> String {
    let oid = spki.algorithm.algorithm.to_id_string();
    match oid.as_str() {
        OID_ED25519 => "Ed25519".to_string(),
        OID_ECDSA => {
            let curve = spki
                .algorithm
                .parameters
                .as_ref()
                .and_then(|p| p.as_oid().ok())
                .map(|o| o.to_id_string());
            match curve.as_deref() {
                Some(OID_SECP256R1) => "ECDSA P-256".to_string(),
                Some(OID_SECP384R1) => "ECDSA P-384".to_string(),
                Some(other) => format!("ECDSA ({other})"),
                None => "ECDSA".to_string(),
            }
        }
        OID_RSA_ENCRYPTION => match spki.parsed() {
            Ok(PublicKey::RSA(rsa)) if !rsa.modulus.is_empty() => {
                let modulus = rsa.modulus.iter().skip_while(|b| **b == 0).copied().collect::<Vec<u8>>();
                let bits = modulus.len() as u32 * 8 - modulus.first().map_or(0, |b| b.leading_zeros());
                format!("RSA {bits}")
            }
            _ => "RSA".to_string(),
        },
        _ => oid,
    }
}

fn general_name_string(name: &GeneralName<'_>) -> Option<String> {
    match name {
        GeneralName::DNSName(n) => Some(format!("DNS:{n}")),
        GeneralName::IPAddress(bytes) => match bytes.len() {
            4 => <[u8; 4]>::try_from(*bytes).ok().map(|a| format!("IP:{}", IpAddr::from(a))),
            16 => <[u8; 16]>::try_from(*bytes).ok().map(|a| format!("IP:{}", IpAddr::from(a))),
            _ => None,
        },
        GeneralName::RFC822Name(n) => Some(format!("EMAIL:{n}")),
        GeneralName::URI(n) => Some(format!("URI:{n}")),
        _ => None,
    }
}

/// PEM → DER for a certificate request (`CERTIFICATE REQUEST` or the older
/// `NEW CERTIFICATE REQUEST` label).
pub(crate) fn csr_der_from_pem(pem: &str) -> Result<Vec<u8>, String> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).map_err(|_| "invalid PEM".to_string())?;
    if pem.label != "CERTIFICATE REQUEST" && pem.label != "NEW CERTIFICATE REQUEST" {
        return Err("not a certificate request".to_string());
    }
    Ok(pem.contents)
}

/// Parses a PKCS#10 certificate signing request (DER) into a JSON summary:
/// subject, public key, signature algorithm, whether the self-signature
/// (proof of key possession) verifies, and requested extensions (SAN, key
/// usage, extended key usage, basic constraints).
pub(crate) fn csr_json(der: &[u8]) -> Result<String, String> {
    use x509_parser::certification_request::X509CertificationRequest;
    let (_, req) = X509CertificationRequest::from_der(der).map_err(|_| "invalid certificate request".to_string())?;
    let info = &req.certification_request_info;

    // null = signature algorithm not supported by the verifier (e.g. RSA-PSS).
    let signature_valid = match req.verify_signature() {
        Ok(()) => serde_json::Value::Bool(true),
        Err(X509Error::SignatureUnsupportedAlgorithm) => serde_json::Value::Null,
        Err(_) => serde_json::Value::Bool(false),
    };

    let mut sans = Vec::new();
    let mut key_usage = serde_json::Value::Null;
    let mut ext_key_usage = Vec::new();
    let mut basic_constraints = serde_json::Value::Null;
    if let Some(exts) = req.requested_extensions() {
        for ext in exts {
            match ext {
                ParsedExtension::SubjectAlternativeName(san) => {
                    sans.extend(san.general_names.iter().filter_map(general_name_string));
                }
                ParsedExtension::KeyUsage(ku) => key_usage = serde_json::Value::String(ku.to_string()),
                ParsedExtension::ExtendedKeyUsage(eku) => {
                    for (on, name) in [
                        (eku.any, "any"),
                        (eku.server_auth, "serverAuth"),
                        (eku.client_auth, "clientAuth"),
                        (eku.code_signing, "codeSigning"),
                        (eku.email_protection, "emailProtection"),
                        (eku.time_stamping, "timeStamping"),
                        (eku.ocsp_signing, "OCSPSigning"),
                    ] {
                        if on {
                            ext_key_usage.push(name.to_string());
                        }
                    }
                    ext_key_usage.extend(eku.other.iter().map(|o| o.to_id_string()));
                }
                ParsedExtension::BasicConstraints(bc) => {
                    basic_constraints = serde_json::json!({ "ca": bc.ca, "pathLen": bc.path_len_constraint });
                }
                _ => {}
            }
        }
    }

    // Fixed, reader-friendly key order (serde_json maps would sort keys).
    let fields: [(&str, serde_json::Value); 10] = [
        ("type", "PKCS#10 certificate request".into()),
        ("subject", info.subject.to_string().into()),
        ("publicKey", spki_label(&info.subject_pki).into()),
        ("publicKeyAlgorithmOid", info.subject_pki.algorithm.algorithm.to_id_string().into()),
        ("signatureAlgorithmOid", req.signature_algorithm.algorithm.to_id_string().into()),
        ("signatureValid", signature_valid),
        ("subjectAltNames", sans.into()),
        ("keyUsage", key_usage),
        ("extendedKeyUsage", ext_key_usage.into()),
        ("basicConstraints", basic_constraints),
    ];
    let body = fields
        .iter()
        .map(|(k, v)| format!("{}:{}", serde_json::Value::from(*k), v))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("{{{body}}}"))
}

/// Parses a PEM certificate signing request (PKCS#10) → JSON summary.
#[wasm_bindgen]
pub fn x509_parse_csr_pem(pem: &str) -> Result<String, JsValue> {
    csr_der_from_pem(pem).and_then(|der| csr_json(&der)).map_err(|e| JsValue::from_str(&e))
}

/// Parses a DER certificate signing request (PKCS#10) → JSON summary.
#[wasm_bindgen]
pub fn x509_parse_csr_der(der: &[u8]) -> Result<String, JsValue> {
    csr_json(der).map_err(|e| JsValue::from_str(&e))
}

/// Returns warnings for a PEM certificate (provide current unix timestamp).
#[wasm_bindgen]
pub fn x509_warnings_pem(pem: &str, now_unix: i64) -> Result<Vec<String>, JsValue> {
    let der = parse_pem_to_der(pem)?;
    let (_, cert) = parse_x509_certificate(&der)
        .map_err(|_| JsValue::from_str("invalid certificate"))?;
    Ok(cert_warnings(&cert, now_unix))
}

/// Returns warnings for a DER certificate (provide current unix timestamp).
#[wasm_bindgen]
pub fn x509_warnings_der(der: &[u8], now_unix: i64) -> Result<Vec<String>, JsValue> {
    let cert = parse_cert_from_der(der)?;
    Ok(cert_warnings(&cert, now_unix))
}

/// Basic chain checks for a PEM certificate list (order: leaf -> root).
///
/// Note: signature verification is not performed; checks only subject/issuer linkage and validity.
#[wasm_bindgen]
pub fn x509_chain_warnings_pem(pem_chain: Vec<String>, now_unix: i64) -> Result<Vec<String>, JsValue> {
    if pem_chain.is_empty() {
        return Err(JsValue::from_str("empty chain"));
    }

    let mut warnings = Vec::new();
    let mut subjects = Vec::with_capacity(pem_chain.len());
    let mut issuers = Vec::with_capacity(pem_chain.len());

    for pem in pem_chain.iter() {
        let der = parse_pem_to_der(pem)?;
        let (_, cert) = parse_x509_certificate(&der)
            .map_err(|_| JsValue::from_str("invalid certificate"))?;
        warnings.extend(cert_warnings(&cert, now_unix));
        subjects.push(subject_string(&cert));
        issuers.push(issuer_string(&cert));
    }

    for i in 0..subjects.len().saturating_sub(1) {
        if issuers[i] != subjects[i + 1] {
            warnings.push(format!("issuer mismatch at index {}", i));
        }
    }

    if let (Some(last_subject), Some(last_issuer)) = (subjects.last(), issuers.last()) {
        if last_subject != last_issuer {
            warnings.push("root is not self-signed".to_string());
        }
    }

    warnings.push("signature verification not performed".to_string());
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x509_self_signed_ed25519() {
        let out = x509_self_signed_pem(
            X509_ALG_ED25519,
            Some("example.local".to_string()),
            vec!["localhost".to_string()],
            vec!["127.0.0.1".to_string()],
        )
        .expect("cert");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("BEGIN CERTIFICATE"));
        assert!(out[1].contains("BEGIN PRIVATE KEY"));
    }

    #[test]
    fn x509_csr_ed25519() {
        let out = x509_csr_pem(
            X509_ALG_ED25519,
            Some("example.local".to_string()),
            vec!["localhost".to_string()],
            vec!["127.0.0.1".to_string()],
        )
        .expect("csr");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("BEGIN CERTIFICATE REQUEST"));
        assert!(out[1].contains("BEGIN PRIVATE KEY"));
    }

    #[test]
    fn x509_warnings_not_yet_valid() {
        let out = x509_self_signed_pem(
            X509_ALG_ED25519,
            Some("example.local".to_string()),
            vec!["localhost".to_string()],
            vec!["127.0.0.1".to_string()],
        )
        .expect("cert");

        let warnings = x509_warnings_pem(&out[0], 0).expect("warnings");
        assert!(warnings.iter().any(|w| w.contains("not yet valid")));
    }

    #[test]
    fn x509_chain_warnings_mismatch() {
        let cert1 = x509_self_signed_pem(
            X509_ALG_ED25519,
            Some("example1.local".to_string()),
            vec!["localhost".to_string()],
            vec!["127.0.0.1".to_string()],
        )
        .expect("cert1");
        let cert2 = x509_self_signed_pem(
            X509_ALG_ED25519,
            Some("example2.local".to_string()),
            vec!["localhost".to_string()],
            vec!["127.0.0.1".to_string()],
        )
        .expect("cert2");

        let warnings = x509_chain_warnings_pem(vec![cert1[0].clone(), cert2[0].clone()], 0)
            .expect("warnings");
        assert!(warnings.iter().any(|w| w.contains("issuer mismatch")));
        assert!(warnings.iter().any(|w| w.contains("signature verification not performed")));
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn x509_parse_rejects_invalid_data() {
        assert!(x509_parse_pem("not a pem").is_err());
        assert!(x509_parse_der(&[0u8; 8]).is_err());
    }

    const NOW: i64 = 1_767_225_600; // 2026-01-01T00:00:00Z

    fn parse_cert(pem: &str) -> serde_json::Value {
        serde_json::from_str(&x509_parse_pem(pem).expect("parse")).expect("json")
    }

    #[test]
    fn subject_dn_bare_name_is_common_name() {
        let out = self_signed_ex(X509_ALG_ED25519, "example.com", 30, NOW, vec![], vec![], vec![]).expect("cert");
        assert_eq!(parse_cert(&out[0])["subject"], "CN=example.com");
    }

    #[test]
    fn subject_dn_full_attributes() {
        let out = self_signed_ex(
            X509_ALG_ECDSA_P256,
            "CN=example.com, O=My Org\\, Inc, OU=Dev, L=Omsk, ST=Omsk Oblast, c=ru",
            30,
            NOW,
            vec![],
            vec![],
            vec![],
        )
        .expect("cert");
        let json = parse_cert(&out[0]);
        let subject = json["subject"].as_str().unwrap();
        for part in ["CN=example.com", "O=My Org, Inc", "OU=Dev", "L=Omsk", "ST=Omsk Oblast", "C=RU"] {
            assert!(subject.contains(part), "{part} missing in {subject}");
        }
        // Self-signed: issuer == subject.
        assert_eq!(json["issuer"], json["subject"]);
        assert_eq!(json["signatureAlgorithmOid"], "1.2.840.10045.4.3.2"); // ecdsa-with-SHA256
    }

    #[test]
    fn subject_dn_rejects_bad_input() {
        assert!(parse_subject_dn("CN=a, XX=b").unwrap_err().contains("unsupported attribute"));
        assert!(parse_subject_dn("CN=").unwrap_err().contains("empty value"));
        assert!(parse_subject_dn("CN=a, C=USA").unwrap_err().contains("country"));
        assert!(parse_subject_dn("CN=a, junk").unwrap_err().contains("missing '='"));
        assert!(parse_subject_dn("   ").unwrap().is_none());
        // Unicode values are kept verbatim.
        assert!(parse_subject_dn("CN=пример.рф, O=Компания 😀").unwrap().is_some());
    }

    #[test]
    fn validity_window_matches_days() {
        let out = self_signed_ex(X509_ALG_ED25519, "CN=v", 365, NOW, vec![], vec![], vec![]).expect("cert");
        let der = parse_pem_to_der(&out[0]).expect("der");
        let (_, cert) = parse_x509_certificate(&der).expect("cert");
        let nb = cert.validity().not_before.timestamp();
        let na = cert.validity().not_after.timestamp();
        assert_eq!(nb, NOW);
        assert_eq!(na - nb, 365 * 86_400);
        // Fresh cert: no warnings now, "expired" after the window.
        assert!(x509_warnings_pem(&out[0], NOW + 1).expect("w").is_empty());
        let late = x509_warnings_pem(&out[0], NOW + 366 * 86_400).expect("w");
        assert!(late.iter().any(|w| w.contains("expired")));
    }

    #[test]
    fn validity_days_out_of_range_rejected() {
        assert!(self_signed_ex(X509_ALG_ED25519, "CN=v", 0, NOW, vec![], vec![], vec![]).is_err());
        assert!(self_signed_ex(X509_ALG_ED25519, "CN=v", X509_MAX_VALIDITY_DAYS + 1, NOW, vec![], vec![], vec![]).is_err());
        assert!(self_signed_ex(X509_ALG_ED25519, "CN=v", X509_MAX_VALIDITY_DAYS, NOW, vec![], vec![], vec![]).is_ok());
    }

    #[test]
    fn csr_ex_carries_subject() {
        let out = csr_ex(X509_ALG_ECDSA_P384, "CN=req.example, O=Org", vec!["req.example".into()], vec![], vec![]).expect("csr");
        assert!(out[0].contains("BEGIN CERTIFICATE REQUEST"));
        assert!(out[1].contains("BEGIN PRIVATE KEY"));
        let (_, pem) = x509_parser::pem::parse_x509_pem(out[0].as_bytes()).expect("pem");
        let (_, req) = X509CertificationRequest::from_der(&pem.contents).expect("csr der");
        let subject = req.certification_request_info.subject.to_string();
        assert!(subject.contains("CN=req.example") && subject.contains("O=Org"), "{subject}");
    }

    #[test]
    fn unsupported_algorithm_rejected() {
        assert!(self_signed_ex(9, "CN=v", 1, NOW, vec![], vec![], vec![]).unwrap_err().contains("unsupported algorithm"));
    }

    #[test]
    fn parse_der_matches_parse_pem() {
        let out = self_signed_ex(X509_ALG_ED25519, "CN=der", 10, NOW, vec!["der.local".into()], vec!["10.0.0.1".into()], vec![]).expect("cert");
        let der = parse_pem_to_der(&out[0]).expect("der");
        assert_eq!(x509_parse_der(&der).expect("der json"), x509_parse_pem(&out[0]).expect("pem json"));
        let json = parse_cert(&out[0]);
        let sans: Vec<&str> = json["subjectAltNames"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(sans, vec!["DNS:der.local", "IP:10.0.0.1"]);
        assert_eq!(json["publicKeyAlgorithmOid"], "1.3.101.112"); // Ed25519
    }

    fn sans_of(v: &serde_json::Value) -> Vec<String> {
        v["subjectAltNames"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn san_dns_ip_email_in_certificate_and_csr() {
        let dns = vec!["example.com".to_string(), "*.example.com".to_string()];
        let ip = vec!["192.0.2.1".to_string(), "2001:db8::1".to_string()];
        let email = vec!["admin@example.com".to_string()];
        let expected = ["DNS:example.com", "DNS:*.example.com", "IP:192.0.2.1", "IP:2001:db8::1", "EMAIL:admin@example.com"];
        let cert = self_signed_ex(X509_ALG_ECDSA_P256, "CN=example.com", 30, NOW, dns.clone(), ip.clone(), email.clone())
            .expect("cert");
        assert_eq!(sans_of(&parse_cert(&cert[0])), expected);
        let csr = csr_ex(X509_ALG_ECDSA_P256, "CN=example.com", dns, ip, email).expect("csr");
        let v = csr_value(&csr[0]);
        assert_eq!(sans_of(&v), expected);
        assert_eq!(v["signatureValid"], true);
    }

    #[test]
    fn san_without_entries_has_no_extension() {
        let cert = self_signed_ex(X509_ALG_ED25519, "CN=plain", 1, NOW, vec![], vec![], vec![]).expect("cert");
        assert!(sans_of(&parse_cert(&cert[0])).is_empty());
    }

    #[test]
    fn san_invalid_entries_rejected() {
        let err = |dns: Vec<&str>, ip: Vec<&str>, email: Vec<&str>| {
            let v = |l: Vec<&str>| l.into_iter().map(String::from).collect::<Vec<_>>();
            csr_ex(X509_ALG_ED25519, "CN=x", v(dns), v(ip), v(email)).unwrap_err()
        };
        assert_eq!(err(vec![], vec!["300.1.1.1"], vec![]), "invalid san: 300.1.1.1");
        assert_eq!(err(vec!["bücher.example"], vec![], vec![]), "invalid san: bücher.example");
        assert_eq!(err(vec![""], vec![], vec![]), "invalid san: empty DNS name");
        assert_eq!(err(vec![], vec![], vec!["no-at-sign"]), "invalid san: no-at-sign");
    }

    /* ── CSR parsing ── */

    fn csr_value(pem: &str) -> serde_json::Value {
        serde_json::from_str(&csr_json(&csr_der_from_pem(pem).expect("pem")).expect("csr")).expect("json")
    }

    #[test]
    fn csr_parse_own_requests_all_algorithms() {
        for (alg, label, oid) in [
            (X509_ALG_ED25519, "Ed25519", "1.3.101.112"),
            (X509_ALG_ECDSA_P256, "ECDSA P-256", "1.2.840.10045.2.1"),
            (X509_ALG_ECDSA_P384, "ECDSA P-384", "1.2.840.10045.2.1"),
        ] {
            let out = csr_ex(alg, "CN=req.example, O=Org, C=de", vec!["req.example".into()], vec!["10.1.2.3".into()], vec![]).expect("csr");
            let v = csr_value(&out[0]);
            assert_eq!(v["publicKey"], label);
            assert_eq!(v["publicKeyAlgorithmOid"], oid);
            assert_eq!(v["signatureValid"], true, "{label}");
            let subject = v["subject"].as_str().unwrap();
            assert!(subject.contains("CN=req.example") && subject.contains("O=Org") && subject.contains("C=DE"), "{subject}");
            let sans: Vec<&str> = v["subjectAltNames"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert_eq!(sans, vec!["DNS:req.example", "IP:10.1.2.3"]);
        }
    }

    #[test]
    fn csr_parse_openssl_rsa_fixture() {
        let pem = std::fs::read_to_string("tests/fixtures/csr_rsa2048_openssl.pem").expect("fixture");
        let v = csr_value(&pem);
        assert_eq!(v["subject"], "C=DE, O=Example GmbH, CN=api.example.com");
        assert_eq!(v["publicKey"], "RSA 2048");
        assert_eq!(v["signatureAlgorithmOid"], "1.2.840.113549.1.1.11"); // sha256WithRSAEncryption
        assert_eq!(v["signatureValid"], true);
        let sans: Vec<&str> = v["subjectAltNames"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        assert_eq!(sans, vec!["DNS:api.example.com", "DNS:www.example.com", "IP:192.0.2.10", "EMAIL:ops@example.com"]);
        assert_eq!(v["extendedKeyUsage"], serde_json::json!(["serverAuth", "clientAuth"]));
        let ku = v["keyUsage"].as_str().unwrap();
        assert!(ku.contains("Digital Signature") && ku.contains("Key Encipherment"), "{ku}");
    }

    #[test]
    fn csr_parse_openssl_ed25519_der_fixture() {
        use base64::Engine;
        let b64 = std::fs::read_to_string("tests/fixtures/csr_ed25519_openssl.der.b64").expect("fixture");
        let der = base64::engine::general_purpose::STANDARD.decode(b64.trim()).expect("b64");
        let v: serde_json::Value = serde_json::from_str(&csr_json(&der).expect("csr")).expect("json");
        assert_eq!(v["subject"], "CN=ed.example");
        assert_eq!(v["publicKey"], "Ed25519");
        assert_eq!(v["signatureValid"], true);
        assert_eq!(v["subjectAltNames"], serde_json::json!([]));
    }

    #[test]
    fn csr_tampered_signature_is_reported_invalid() {
        let out = csr_ex(X509_ALG_ECDSA_P256, "CN=tamper.example", vec![], vec![], vec![]).expect("csr");
        let mut der = csr_der_from_pem(&out[0]).expect("der");
        // Flip a byte inside the subject CN ("tamper" → "uamper"): still parses, signature breaks.
        let pos = der.windows(6).position(|w| w == b"tamper").expect("cn bytes");
        der[pos] = b'u';
        let raw = csr_json(&der).expect("parse");
        assert!(raw.starts_with("{\"type\":\"PKCS#10 certificate request\",\"subject\":"), "{raw}");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(v["subject"], "CN=uamper.example");
        assert_eq!(v["signatureValid"], false);
    }

    #[test]
    fn csr_parse_rejects_non_requests() {
        let cert = self_signed_ex(X509_ALG_ED25519, "CN=c", 1, NOW, vec![], vec![], vec![]).expect("cert");
        assert_eq!(csr_der_from_pem(&cert[0]).unwrap_err(), "not a certificate request");
        let cert_der = parse_pem_to_der(&cert[0]).expect("der");
        assert_eq!(csr_json(&cert_der).unwrap_err(), "invalid certificate request");
        assert_eq!(csr_json(b"garbage").unwrap_err(), "invalid certificate request");
        let legacy_label = csr_ex(X509_ALG_ED25519, "CN=old", vec![], vec![], vec![]).expect("csr")[0]
            .replace("CERTIFICATE REQUEST", "NEW CERTIFICATE REQUEST");
        assert_eq!(csr_value(&legacy_label)["subject"], "CN=old");
    }
}
