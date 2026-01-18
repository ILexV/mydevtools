use wasm_bindgen::prelude::*;

use rcgen::{Certificate, CertificateParams, DistinguishedName, DnType, KeyPair, SanType, SignatureAlgorithm};
use std::net::IpAddr;
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::*;

const X509_ALG_ED25519: u8 = 1;
const X509_ALG_ECDSA_P256: u8 = 2;
const X509_ALG_ECDSA_P384: u8 = 3;

const OID_RSA_ENCRYPTION: &str = "1.2.840.113549.1.1.1";
const OID_ECDSA: &str = "1.2.840.10045.2.1";
const OID_ED25519: &str = "1.3.101.112";

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
    alg: u8,
    subject_cn: Option<String>,
    san_dns: Vec<String>,
    san_ip: Vec<String>,
) -> Result<CertificateParams, JsValue> {
    let mut params = if san_dns.is_empty() {
        CertificateParams::default()
    } else {
        CertificateParams::new(san_dns).map_err(|_| JsValue::from_str("invalid san"))?
    };

    params.alg = signature_algorithm(alg)?;

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

fn parse_cert_from_pem(pem: &str) -> Result<X509Certificate<'_>, JsValue> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(pem.as_bytes())
        .map_err(|_| JsValue::from_str("invalid PEM"))?;
    let (_, cert) = parse_x509_certificate(&pem.contents)
        .map_err(|_| JsValue::from_str("invalid certificate"))?;
    Ok(cert)
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
                GeneralName::IPAddress(bytes) => out.push(format!("IP:{}", IpAddr::from(*bytes))),
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
                return Some(rsa.modulus.bits() as u32);
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

    if let Ok(nb) = cert.validity().not_before.to_datetime() {
        if now_unix < nb.unix_timestamp() {
            warnings.push("certificate not yet valid".to_string());
        }
    }
    if let Ok(na) = cert.validity().not_after.to_datetime() {
        if now_unix > na.unix_timestamp() {
            warnings.push("certificate expired".to_string());
        }
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
    let mut params = build_params(algorithm, subject_cn, san_dns, san_ip)?;
    let key_pair = KeyPair::generate(params.alg)
        .map_err(|_| JsValue::from_str("key generation failed"))?;
    let key_pem = key_pair.serialize_pem();
    params.key_pair = Some(key_pair);

    let cert = Certificate::from_params(params).map_err(|_| JsValue::from_str("certificate failed"))?;
    let cert_pem = cert.serialize_pem().map_err(|_| JsValue::from_str("encode failed"))?;

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
    let mut params = build_params(algorithm, subject_cn, san_dns, san_ip)?;
    let key_pair = KeyPair::generate(params.alg)
        .map_err(|_| JsValue::from_str("key generation failed"))?;
    let key_pem = key_pair.serialize_pem();
    params.key_pair = Some(key_pair);

    let cert = Certificate::from_params(params).map_err(|_| JsValue::from_str("certificate failed"))?;
    let csr_pem = cert
        .serialize_request_pem()
        .map_err(|_| JsValue::from_str("encode failed"))?;

    Ok(vec![csr_pem, key_pem])
}

/// Parses certificate from PEM and returns JSON string with basic fields.
#[wasm_bindgen]
pub fn x509_parse_pem(pem: &str) -> Result<String, JsValue> {
    let cert = parse_cert_from_pem(pem)?;
    Ok(cert_to_json(&cert))
}

/// Parses certificate from DER and returns JSON string with basic fields.
#[wasm_bindgen]
pub fn x509_parse_der(der: &[u8]) -> Result<String, JsValue> {
    let cert = parse_cert_from_der(der)?;
    Ok(cert_to_json(&cert))
}

/// Returns warnings for a PEM certificate (provide current unix timestamp).
#[wasm_bindgen]
pub fn x509_warnings_pem(pem: &str, now_unix: i64) -> Result<Vec<String>, JsValue> {
    let cert = parse_cert_from_pem(pem)?;
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

    let mut certs = Vec::with_capacity(pem_chain.len());
    for pem in pem_chain.iter() {
        certs.push(parse_cert_from_pem(pem)?);
    }

    let mut warnings = Vec::new();
    for cert in certs.iter() {
        warnings.extend(cert_warnings(cert, now_unix));
    }

    for i in 0..certs.len() - 1 {
        let issuer = issuer_string(&certs[i]);
        let subject = subject_string(&certs[i + 1]);
        if issuer != subject {
            warnings.push(format!("issuer mismatch at index {}", i));
        }
    }

    let last = certs.last().expect("chain");
    if issuer_string(last) != subject_string(last) {
        warnings.push("root is not self-signed".to_string());
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
}
