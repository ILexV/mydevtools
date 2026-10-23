//! File signatures: sign and verify files of any size with streamed digests.
//! Formats: OpenSSH SSHSIG (`ssh-keygen -Y sign/verify`), minisign `.minisig`
//! (verify only) and raw OpenSSL-style signatures (`openssl dgst -sign`,
//! `pkeyutl -rawin`) — Ed25519, ECDSA P-256/P-384, RSA PKCS#1 v1.5 / PSS.
//! Keys: PEM (SPKI, PKCS#8 incl. encrypted, SEC1, PKCS#1, X.509 certificate),
//! OpenSSH public/private keys, authorized_keys/allowed_signers lines, JWK/JWKS.
//! Errors are stable codes (see `E_*`) the UI localizes.

use wasm_bindgen::prelude::*;

use base64::engine::general_purpose::{STANDARD as B64, STANDARD_NO_PAD as B64_NO_PAD, URL_SAFE_NO_PAD as B64_URL};
use base64::Engine;
use blake2::Blake2b512;
use ed25519_dalek::{Signer as _, Verifier as _};
use pkcs8::EncryptedPrivateKeyInfo;
use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey};
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, Pkcs1v15Sign, Pss, RsaPrivateKey, RsaPublicKey};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256, Sha384, Sha512};
use signature::hazmat::{PrehashSigner, PrehashVerifier};

use crate::openssh::{
    openssh_ecdsa_public_blob, openssh_ed25519_public_blob, openssh_rsa_public_blob, parse_openssh_private_key, write_mpint,
    write_string, write_u32_be, OPENSSH_ALG_ECDSA_P256, OPENSSH_ALG_ECDSA_P384, OPENSSH_ALG_ED25519, OPENSSH_ALG_RSA,
};
use crate::rsa_pss::WasmRng;

/// Pure Ed25519 and legacy minisign sign the message itself, so the file is held in memory up to this size.
const MAX_WHOLE_FILE: usize = 128 * 1024 * 1024;

const E_SIG_FORMAT: &str = "signature-format";
const E_KEY_FORMAT: &str = "key-format";
const E_KEY_UNSUPPORTED: &str = "key-unsupported";
const E_KEY_PRIVATE_GIVEN: &str = "key-private-given";
const E_KEY_PUBLIC_GIVEN: &str = "key-public-given";
const E_KEY_MISSING: &str = "key-missing";
const E_PASSPHRASE_REQUIRED: &str = "passphrase-required";
const E_PASSPHRASE_WRONG: &str = "passphrase-wrong";
const E_PEM_LEGACY_ENCRYPTED: &str = "pem-legacy-encrypted";
const E_NAMESPACE: &str = "namespace-empty";
const E_TOO_LARGE: &str = "too-large";
const E_OPTIONS: &str = "options";
const E_SIGN: &str = "sign-failed";

type Res<T> = Result<T, &'static str>;

fn js(code: &'static str) -> JsValue {
    JsValue::from_str(code)
}

// ---------------------------------------------------------------- SSH wire reader

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Res<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(E_SIG_FORMAT)?;
        let out = self.data.get(self.pos..end).ok_or(E_SIG_FORMAT)?;
        self.pos = end;
        Ok(out)
    }
    fn u32(&mut self) -> Res<u32> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn string(&mut self) -> Res<&'a [u8]> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    fn str(&mut self) -> Res<&'a str> {
        std::str::from_utf8(self.string()?).map_err(|_| E_SIG_FORMAT)
    }
    /// SSH mpint as unsigned big-endian bytes without leading zeros.
    fn mpint(&mut self) -> Res<&'a [u8]> {
        let mut b = self.string()?;
        while let [0, rest @ ..] = b {
            b = rest;
        }
        Ok(b)
    }
}

fn left_pad(bytes: &[u8], len: usize) -> Res<Vec<u8>> {
    if bytes.len() > len {
        return Err(E_SIG_FORMAT);
    }
    let mut out = vec![0u8; len - bytes.len()];
    out.extend_from_slice(bytes);
    Ok(out)
}

fn strip_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

// ---------------------------------------------------------------- keys

#[derive(Clone)]
enum PubKey {
    Ed25519(ed25519_dalek::VerifyingKey),
    P256(p256::ecdsa::VerifyingKey),
    P384(p384::ecdsa::VerifyingKey),
    Rsa(RsaPublicKey),
}

impl PubKey {
    fn algorithm(&self) -> String {
        match self {
            PubKey::Ed25519(_) => "Ed25519".into(),
            PubKey::P256(_) => "ECDSA P-256".into(),
            PubKey::P384(_) => "ECDSA P-384".into(),
            PubKey::Rsa(k) => format!("RSA {}", k.n().bits()),
        }
    }

    fn ssh_type(&self) -> &'static str {
        match self {
            PubKey::Ed25519(_) => "ssh-ed25519",
            PubKey::P256(_) => "ecdsa-sha2-nistp256",
            PubKey::P384(_) => "ecdsa-sha2-nistp384",
            PubKey::Rsa(_) => "ssh-rsa",
        }
    }

    fn ssh_blob(&self) -> Vec<u8> {
        match self {
            PubKey::Ed25519(k) => openssh_ed25519_public_blob(k.as_bytes()).unwrap_or_default(),
            PubKey::P256(k) => {
                openssh_ecdsa_public_blob(k.to_encoded_point(false).as_bytes(), "ecdsa-sha2-nistp256", "nistp256").unwrap_or_default()
            }
            PubKey::P384(k) => {
                openssh_ecdsa_public_blob(k.to_encoded_point(false).as_bytes(), "ecdsa-sha2-nistp384", "nistp384").unwrap_or_default()
            }
            PubKey::Rsa(k) => openssh_rsa_public_blob(k),
        }
    }

    fn ssh_line(&self) -> String {
        format!("{} {}", self.ssh_type(), B64.encode(self.ssh_blob()))
    }

    /// OpenSSH-style fingerprint `SHA256:<base64 without padding>` of the SSH key blob.
    fn fingerprint(&self) -> String {
        format!("SHA256:{}", B64_NO_PAD.encode(Sha256::digest(self.ssh_blob())))
    }

    fn spki_pem(&self) -> String {
        use p256::pkcs8::EncodePublicKey;
        let der = match self {
            PubKey::Ed25519(k) => k.to_public_key_der().map(|d| d.as_bytes().to_vec()),
            PubKey::P256(k) => k.to_public_key_der().map(|d| d.as_bytes().to_vec()),
            PubKey::P384(k) => k.to_public_key_der().map(|d| d.as_bytes().to_vec()),
            PubKey::Rsa(k) => rsa::pkcs8::EncodePublicKey::to_public_key_der(k).map(|d| d.as_bytes().to_vec()),
        }
        .unwrap_or_default();
        pem_encode("PUBLIC KEY", &der)
    }

    fn from_ssh_blob(blob: &[u8]) -> Res<PubKey> {
        let mut r = Reader::new(blob);
        let key_type = r.str()?;
        let key = match key_type {
            "ssh-ed25519" => {
                let bytes: [u8; 32] = r.string()?.try_into().map_err(|_| E_KEY_FORMAT)?;
                PubKey::Ed25519(ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|_| E_KEY_FORMAT)?)
            }
            "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" => {
                let curve = r.str()?;
                let point = r.string()?;
                match (key_type, curve) {
                    ("ecdsa-sha2-nistp256", "nistp256") => {
                        PubKey::P256(p256::ecdsa::VerifyingKey::from_sec1_bytes(point).map_err(|_| E_KEY_FORMAT)?)
                    }
                    ("ecdsa-sha2-nistp384", "nistp384") => {
                        PubKey::P384(p384::ecdsa::VerifyingKey::from_sec1_bytes(point).map_err(|_| E_KEY_FORMAT)?)
                    }
                    _ => return Err(E_KEY_FORMAT),
                }
            }
            "ssh-rsa" => {
                let e = BigUint::from_bytes_be(r.mpint()?);
                let n = BigUint::from_bytes_be(r.mpint()?);
                PubKey::Rsa(RsaPublicKey::new_with_max_size(n, e, 16384).map_err(|_| E_KEY_FORMAT)?)
            }
            _ => return Err(E_KEY_UNSUPPORTED),
        };
        Ok(key)
    }

    fn from_spki_der(der: &[u8]) -> Res<PubKey> {
        use p256::pkcs8::DecodePublicKey;
        if let Ok(k) = ed25519_dalek::VerifyingKey::from_public_key_der(der) {
            return Ok(PubKey::Ed25519(k));
        }
        if let Ok(k) = p256::ecdsa::VerifyingKey::from_public_key_der(der) {
            return Ok(PubKey::P256(k));
        }
        if let Ok(k) = p384::ecdsa::VerifyingKey::from_public_key_der(der) {
            return Ok(PubKey::P384(k));
        }
        if let Ok(k) = <RsaPublicKey as rsa::pkcs8::DecodePublicKey>::from_public_key_der(der) {
            return Ok(PubKey::Rsa(k));
        }
        Err(E_KEY_UNSUPPORTED)
    }
}

enum PrivKey {
    Ed25519(ed25519_dalek::SigningKey),
    P256(p256::ecdsa::SigningKey),
    P384(p384::ecdsa::SigningKey),
    Rsa(Box<RsaPrivateKey>),
}

impl PrivKey {
    fn public(&self) -> PubKey {
        match self {
            PrivKey::Ed25519(k) => PubKey::Ed25519(k.verifying_key()),
            PrivKey::P256(k) => PubKey::P256(*k.verifying_key()),
            PrivKey::P384(k) => PubKey::P384(*k.verifying_key()),
            PrivKey::Rsa(k) => PubKey::Rsa(k.to_public_key()),
        }
    }

    fn from_pkcs8_der(der: &[u8]) -> Res<PrivKey> {
        use p256::pkcs8::DecodePrivateKey;
        if let Ok(k) = ed25519_dalek::SigningKey::from_pkcs8_der(der) {
            return Ok(PrivKey::Ed25519(k));
        }
        if let Ok(k) = p256::ecdsa::SigningKey::from_pkcs8_der(der) {
            return Ok(PrivKey::P256(k));
        }
        if let Ok(k) = p384::ecdsa::SigningKey::from_pkcs8_der(der) {
            return Ok(PrivKey::P384(k));
        }
        if let Ok(k) = <RsaPrivateKey as rsa::pkcs8::DecodePrivateKey>::from_pkcs8_der(der) {
            return Ok(PrivKey::Rsa(Box::new(k)));
        }
        Err(E_KEY_UNSUPPORTED)
    }
}

/// One PEM block: label, decoded body, and whether it carries legacy `Proc-Type: 4,ENCRYPTED` headers.
struct PemBlock {
    label: String,
    der: Vec<u8>,
    legacy_encrypted: bool,
}

fn pem_blocks(text: &str) -> Vec<PemBlock> {
    let mut out = Vec::new();
    let mut current: Option<(String, String, bool)> = None;
    for line in text.lines().map(str::trim) {
        if let Some(label) = line.strip_prefix("-----BEGIN ").and_then(|l| l.strip_suffix("-----")) {
            current = Some((label.to_string(), String::new(), false));
        } else if line.starts_with("-----END ") {
            if let Some((label, body, legacy)) = current.take() {
                if let Ok(der) = B64.decode(body.as_bytes()) {
                    out.push(PemBlock { label, der, legacy_encrypted: legacy });
                }
            }
        } else if let Some((_, body, legacy)) = current.as_mut() {
            if line.contains(':') {
                if line.starts_with("Proc-Type:") && line.contains("ENCRYPTED") {
                    *legacy = true;
                }
            } else {
                body.push_str(line);
            }
        }
    }
    out
}

fn pem_encode(label: &str, der: &[u8]) -> String {
    let b64 = B64.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn is_private_label(label: &str) -> bool {
    label.ends_with("PRIVATE KEY")
}

/// A trusted public key plus allowed_signers metadata (principals, `namespaces="…"` restriction).
struct KeyEntry {
    key: PubKey,
    principal: Option<String>,
    namespaces: Option<Vec<String>>,
}

impl KeyEntry {
    fn plain(key: PubKey) -> Self {
        Self { key, principal: None, namespaces: None }
    }
}

fn b64url_field(obj: &Value, name: &str) -> Res<Option<Vec<u8>>> {
    match obj.get(name).and_then(Value::as_str) {
        None => Ok(None),
        Some(s) => B64_URL.decode(s.trim_end_matches('=')).map(Some).map_err(|_| E_KEY_FORMAT),
    }
}

fn jwk_required(obj: &Value, name: &str) -> Res<Vec<u8>> {
    b64url_field(obj, name)?.ok_or(E_KEY_FORMAT)
}

fn jwk_public(obj: &Value) -> Res<PubKey> {
    let kty = obj.get("kty").and_then(Value::as_str).ok_or(E_KEY_FORMAT)?;
    let crv = obj.get("crv").and_then(Value::as_str).unwrap_or("");
    match (kty, crv) {
        ("OKP", "Ed25519") => {
            let x: [u8; 32] = jwk_required(obj, "x")?.try_into().map_err(|_| E_KEY_FORMAT)?;
            Ok(PubKey::Ed25519(ed25519_dalek::VerifyingKey::from_bytes(&x).map_err(|_| E_KEY_FORMAT)?))
        }
        ("EC", "P-256") | ("EC", "P-384") => {
            let mut point = vec![4u8];
            point.extend(jwk_required(obj, "x")?);
            point.extend(jwk_required(obj, "y")?);
            if crv == "P-256" {
                Ok(PubKey::P256(p256::ecdsa::VerifyingKey::from_sec1_bytes(&point).map_err(|_| E_KEY_FORMAT)?))
            } else {
                Ok(PubKey::P384(p384::ecdsa::VerifyingKey::from_sec1_bytes(&point).map_err(|_| E_KEY_FORMAT)?))
            }
        }
        ("RSA", _) => {
            let n = BigUint::from_bytes_be(&jwk_required(obj, "n")?);
            let e = BigUint::from_bytes_be(&jwk_required(obj, "e")?);
            Ok(PubKey::Rsa(RsaPublicKey::new(n, e).map_err(|_| E_KEY_FORMAT)?))
        }
        _ => Err(E_KEY_UNSUPPORTED),
    }
}

fn jwk_private(obj: &Value) -> Res<PrivKey> {
    let d = b64url_field(obj, "d")?.ok_or(E_KEY_PUBLIC_GIVEN)?;
    match jwk_public(obj)? {
        PubKey::Ed25519(_) => {
            let d: [u8; 32] = d.try_into().map_err(|_| E_KEY_FORMAT)?;
            Ok(PrivKey::Ed25519(ed25519_dalek::SigningKey::from_bytes(&d)))
        }
        PubKey::P256(_) => Ok(PrivKey::P256(p256::ecdsa::SigningKey::from_slice(&d).map_err(|_| E_KEY_FORMAT)?)),
        PubKey::P384(_) => Ok(PrivKey::P384(p384::ecdsa::SigningKey::from_slice(&d).map_err(|_| E_KEY_FORMAT)?)),
        PubKey::Rsa(_) => {
            let n = BigUint::from_bytes_be(&jwk_required(obj, "n")?);
            let e = BigUint::from_bytes_be(&jwk_required(obj, "e")?);
            let p = BigUint::from_bytes_be(&jwk_required(obj, "p")?);
            let q = BigUint::from_bytes_be(&jwk_required(obj, "q")?);
            let key = RsaPrivateKey::from_components(n, e, BigUint::from_bytes_be(&d), vec![p, q]).map_err(|_| E_KEY_FORMAT)?;
            Ok(PrivKey::Rsa(Box::new(key)))
        }
    }
}

const SSH_KEY_TYPES: [&str; 4] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ssh-rsa"];

/// Splits an authorized_keys/allowed_signers line on whitespace outside double quotes.
fn split_ssh_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in line.chars() {
        if c == '"' {
            quoted = !quoted;
            cur.push(c);
        } else if c.is_whitespace() && !quoted {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `namespaces="file,git"` from a comma-separated SSH options token.
fn namespaces_option(options: &str) -> Option<Vec<String>> {
    let start = options.find("namespaces=\"")? + "namespaces=\"".len();
    let end = options[start..].find('"')? + start;
    Some(options[start..end].split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

/// OpenSSH key lines: `.pub` files, authorized_keys (`[options] type key [comment]`) and
/// allowed_signers (`principals [options] type key [comment]`). Unknown key types are skipped.
fn parse_ssh_key_lines(text: &str) -> Res<Vec<KeyEntry>> {
    let mut out = Vec::new();
    let mut unsupported = false;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let tokens = split_ssh_line(line);
        let Some(idx) = tokens.iter().position(|t| SSH_KEY_TYPES.contains(&t.as_str()) || t.starts_with("sk-") || t.contains("-cert-v01@") || t == "ssh-dss") else {
            continue;
        };
        if !SSH_KEY_TYPES.contains(&tokens[idx].as_str()) {
            unsupported = true;
            continue;
        }
        let Some(b64) = tokens.get(idx + 1) else { continue };
        let blob = B64.decode(b64.as_bytes()).map_err(|_| E_KEY_FORMAT)?;
        let key = PubKey::from_ssh_blob(&blob).map_err(|_| E_KEY_FORMAT)?;
        if key.ssh_type() != tokens[idx] {
            return Err(E_KEY_FORMAT);
        }
        let before = &tokens[..idx];
        let first_is_principal = before.first().is_some_and(|t| !t.contains('=') && t != "cert-authority");
        if before.iter().any(|t| t.split(',').any(|o| o == "cert-authority")) {
            unsupported = true;
            continue;
        }
        let principal = if first_is_principal {
            Some(before[0].clone())
        } else {
            tokens.get(idx + 2).cloned()
        };
        let namespaces = before.iter().find_map(|t| namespaces_option(t));
        out.push(KeyEntry { key, principal, namespaces });
    }
    if out.is_empty() {
        return Err(if unsupported { E_KEY_UNSUPPORTED } else { E_KEY_FORMAT });
    }
    Ok(out)
}

/// Public keys from any supported text: JWK/JWKS, PEM (SPKI, PKCS#1, certificate) or OpenSSH lines.
fn parse_public_keys(text: &str) -> Res<Vec<KeyEntry>> {
    let text = text.trim();
    if text.is_empty() {
        return Err(E_KEY_MISSING);
    }
    if text.starts_with('{') {
        let value: Value = serde_json::from_str(text).map_err(|_| E_KEY_FORMAT)?;
        if let Some(keys) = value.get("keys").and_then(Value::as_array) {
            let parsed: Vec<KeyEntry> = keys.iter().filter_map(|k| jwk_public(k).ok()).map(KeyEntry::plain).collect();
            return if parsed.is_empty() { Err(E_KEY_UNSUPPORTED) } else { Ok(parsed) };
        }
        if value.get("d").is_some() {
            return Err(E_KEY_PRIVATE_GIVEN);
        }
        return Ok(vec![KeyEntry::plain(jwk_public(&value)?)]);
    }
    if text.contains("-----BEGIN ") {
        let mut out = Vec::new();
        for block in pem_blocks(text) {
            let key = match block.label.as_str() {
                "PUBLIC KEY" => PubKey::from_spki_der(&block.der)?,
                "RSA PUBLIC KEY" => PubKey::Rsa(RsaPublicKey::from_pkcs1_der(&block.der).map_err(|_| E_KEY_FORMAT)?),
                "CERTIFICATE" => {
                    let (_, cert) = x509_parser::parse_x509_certificate(&block.der).map_err(|_| E_KEY_FORMAT)?;
                    PubKey::from_spki_der(cert.public_key().raw)?
                }
                label if is_private_label(label) => return Err(E_KEY_PRIVATE_GIVEN),
                _ => continue,
            };
            out.push(KeyEntry::plain(key));
        }
        return if out.is_empty() { Err(E_KEY_FORMAT) } else { Ok(out) };
    }
    parse_ssh_key_lines(text)
}

fn openssh_error_code(e: JsValue) -> &'static str {
    match e.as_string().as_deref() {
        Some("passphrase required") => E_PASSPHRASE_REQUIRED,
        Some("invalid passphrase or corrupted key") => E_PASSPHRASE_WRONG,
        Some("unsupported key type") | Some("unsupported cipher") | Some("unsupported kdf") => E_KEY_UNSUPPORTED,
        _ => E_KEY_FORMAT,
    }
}

/// Private key from OpenSSH, PKCS#8 (plain or encrypted), SEC1, PKCS#1 PEM or a private JWK.
fn parse_private_key(text: &str, passphrase: Option<String>) -> Res<PrivKey> {
    let text = text.trim();
    let passphrase = passphrase.filter(|p| !p.is_empty());
    if text.is_empty() {
        return Err(E_KEY_MISSING);
    }
    if text.starts_with('{') {
        let value: Value = serde_json::from_str(text).map_err(|_| E_KEY_FORMAT)?;
        return jwk_private(&value);
    }
    if text.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        let parsed = parse_openssh_private_key(text, passphrase).map_err(openssh_error_code)?;
        return match parsed.algorithm {
            OPENSSH_ALG_ED25519 => {
                let d: [u8; 32] = parsed.private_key.as_slice().try_into().map_err(|_| E_KEY_FORMAT)?;
                Ok(PrivKey::Ed25519(ed25519_dalek::SigningKey::from_bytes(&d)))
            }
            OPENSSH_ALG_ECDSA_P256 => Ok(PrivKey::P256(
                p256::ecdsa::SigningKey::from_slice(&parsed.private_key).map_err(|_| E_KEY_FORMAT)?,
            )),
            OPENSSH_ALG_ECDSA_P384 => Ok(PrivKey::P384(
                p384::ecdsa::SigningKey::from_slice(&parsed.private_key).map_err(|_| E_KEY_FORMAT)?,
            )),
            OPENSSH_ALG_RSA => PrivKey::from_pkcs8_der(&parsed.private_key),
            _ => Err(E_KEY_UNSUPPORTED),
        };
    }
    if text.contains("-----BEGIN ") {
        for block in pem_blocks(text) {
            if block.legacy_encrypted {
                return Err(E_PEM_LEGACY_ENCRYPTED);
            }
            match block.label.as_str() {
                "PRIVATE KEY" => return PrivKey::from_pkcs8_der(&block.der),
                "ENCRYPTED PRIVATE KEY" => {
                    let passphrase = passphrase.ok_or(E_PASSPHRASE_REQUIRED)?;
                    let info = EncryptedPrivateKeyInfo::try_from(block.der.as_slice()).map_err(|_| E_KEY_FORMAT)?;
                    let doc = info.decrypt(passphrase).map_err(|_| E_PASSPHRASE_WRONG)?;
                    return PrivKey::from_pkcs8_der(doc.as_bytes());
                }
                "EC PRIVATE KEY" => {
                    if let Ok(k) = p256::SecretKey::from_sec1_der(&block.der) {
                        return Ok(PrivKey::P256(k.into()));
                    }
                    if let Ok(k) = p384::SecretKey::from_sec1_der(&block.der) {
                        return Ok(PrivKey::P384(k.into()));
                    }
                    return Err(E_KEY_UNSUPPORTED);
                }
                "RSA PRIVATE KEY" => {
                    let k = RsaPrivateKey::from_pkcs1_der(&block.der).map_err(|_| E_KEY_FORMAT)?;
                    return Ok(PrivKey::Rsa(Box::new(k)));
                }
                "PUBLIC KEY" | "RSA PUBLIC KEY" | "CERTIFICATE" => return Err(E_KEY_PUBLIC_GIVEN),
                _ => continue,
            }
        }
        return Err(E_KEY_FORMAT);
    }
    if parse_ssh_key_lines(text).is_ok() {
        return Err(E_KEY_PUBLIC_GIVEN);
    }
    Err(E_KEY_FORMAT)
}

// ---------------------------------------------------------------- digests

#[derive(Clone, Copy, PartialEq, Eq)]
enum Hash {
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    fn name(self) -> &'static str {
        match self {
            Hash::Sha256 => "SHA-256",
            Hash::Sha384 => "SHA-384",
            Hash::Sha512 => "SHA-512",
        }
    }
    fn parse(s: &str) -> Res<Hash> {
        match s {
            "sha256" => Ok(Hash::Sha256),
            "sha384" => Ok(Hash::Sha384),
            "sha512" => Ok(Hash::Sha512),
            _ => Err(E_OPTIONS),
        }
    }
    fn len(self) -> usize {
        match self {
            Hash::Sha256 => 32,
            Hash::Sha384 => 48,
            Hash::Sha512 => 64,
        }
    }
}

/// Digests requested by a plan, fed chunk by chunk (1 MiB from the worker).
#[derive(Default)]
struct Digests {
    sha256: Option<Sha256>,
    sha384: Option<Sha384>,
    sha512: Option<Sha512>,
    blake2b: Option<Blake2b512>,
    whole: Option<Vec<u8>>,
}

#[derive(Default)]
struct Finished {
    sha256: Vec<u8>,
    sha384: Vec<u8>,
    sha512: Vec<u8>,
    blake2b: Vec<u8>,
    whole: Vec<u8>,
}

impl Finished {
    fn get(&self, hash: Hash) -> &[u8] {
        match hash {
            Hash::Sha256 => &self.sha256,
            Hash::Sha384 => &self.sha384,
            Hash::Sha512 => &self.sha512,
        }
    }
}

impl Digests {
    fn with(hashes: &[Hash], blake2b: bool, whole: bool) -> Self {
        Digests {
            sha256: hashes.contains(&Hash::Sha256).then(Sha256::new),
            sha384: hashes.contains(&Hash::Sha384).then(Sha384::new),
            sha512: hashes.contains(&Hash::Sha512).then(Sha512::new),
            blake2b: blake2b.then(Blake2b512::new),
            whole: whole.then(Vec::new),
        }
    }

    fn update(&mut self, chunk: &[u8]) -> Res<()> {
        if let Some(w) = self.whole.as_mut() {
            if w.len() + chunk.len() > MAX_WHOLE_FILE {
                return Err(E_TOO_LARGE);
            }
            w.extend_from_slice(chunk);
        }
        if let Some(h) = self.sha256.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = self.sha384.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = self.sha512.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = self.blake2b.as_mut() {
            h.update(chunk);
        }
        Ok(())
    }

    fn finish(&mut self) -> Finished {
        Finished {
            sha256: self.sha256.take().map(|h| h.finalize().to_vec()).unwrap_or_default(),
            sha384: self.sha384.take().map(|h| h.finalize().to_vec()).unwrap_or_default(),
            sha512: self.sha512.take().map(|h| h.finalize().to_vec()).unwrap_or_default(),
            blake2b: self.blake2b.take().map(|h| h.finalize().to_vec()).unwrap_or_default(),
            whole: self.whole.take().unwrap_or_default(),
        }
    }

    fn whole_file(&self) -> bool {
        self.whole.is_some()
    }
}

// ---------------------------------------------------------------- SSHSIG

const SSHSIG_MAGIC: &[u8] = b"SSHSIG";
const SSHSIG_BEGIN: &str = "-----BEGIN SSH SIGNATURE-----";
const SSHSIG_END: &str = "-----END SSH SIGNATURE-----";

struct SshSig {
    key: PubKey,
    namespace: String,
    hash: Hash,
    sig_type: String,
    sig: Vec<u8>,
}

fn parse_sshsig(text: &str) -> Res<SshSig> {
    let start = text.find(SSHSIG_BEGIN).ok_or(E_SIG_FORMAT)? + SSHSIG_BEGIN.len();
    let end = text[start..].find(SSHSIG_END).ok_or(E_SIG_FORMAT)? + start;
    let blob = B64.decode(strip_ws(&text[start..end]).as_bytes()).map_err(|_| E_SIG_FORMAT)?;
    let mut r = Reader::new(&blob);
    if r.take(6)? != SSHSIG_MAGIC || r.u32()? != 1 {
        return Err(E_SIG_FORMAT);
    }
    let key = PubKey::from_ssh_blob(r.string()?).map_err(|e| if e == E_KEY_UNSUPPORTED { e } else { E_SIG_FORMAT })?;
    let namespace = r.str()?.to_string();
    let _reserved = r.string()?;
    let hash = match r.str()? {
        "sha256" => Hash::Sha256,
        "sha512" => Hash::Sha512,
        _ => return Err(E_SIG_FORMAT),
    };
    let mut sr = Reader::new(r.string()?);
    let sig_type = sr.str()?.to_string();
    let sig = sr.string()?.to_vec();
    Ok(SshSig { key, namespace, hash, sig_type, sig })
}

fn sshsig_hash_name(hash: Hash) -> &'static str {
    if hash == Hash::Sha256 { "sha256" } else { "sha512" }
}

/// The blob the SSH key actually signs: magic, namespace, reserved, hash name, H(file).
fn sshsig_signed_data(namespace: &str, hash: Hash, digest: &[u8]) -> Vec<u8> {
    let mut out = SSHSIG_MAGIC.to_vec();
    write_string(&mut out, namespace.as_bytes());
    write_string(&mut out, b"");
    write_string(&mut out, sshsig_hash_name(hash).as_bytes());
    write_string(&mut out, digest);
    out
}

fn sshsig_verify(sig: &SshSig, digest: &[u8]) -> bool {
    let data = sshsig_signed_data(&sig.namespace, sig.hash, digest);
    match &sig.key {
        PubKey::Ed25519(k) => {
            sig.sig_type == "ssh-ed25519"
                && ed25519_dalek::Signature::from_slice(&sig.sig).is_ok_and(|s| k.verify(&data, &s).is_ok())
        }
        PubKey::P256(k) => {
            sig.sig_type == "ecdsa-sha2-nistp256"
                && ssh_ecdsa_rs(&sig.sig, 32)
                    .and_then(|rs| p256::ecdsa::Signature::from_slice(&rs).map_err(|_| E_SIG_FORMAT))
                    .is_ok_and(|s| signature::Verifier::verify(k, &data, &s).is_ok())
        }
        PubKey::P384(k) => {
            sig.sig_type == "ecdsa-sha2-nistp384"
                && ssh_ecdsa_rs(&sig.sig, 48)
                    .and_then(|rs| p384::ecdsa::Signature::from_slice(&rs).map_err(|_| E_SIG_FORMAT))
                    .is_ok_and(|s| signature::Verifier::verify(k, &data, &s).is_ok())
        }
        PubKey::Rsa(k) => match sig.sig_type.as_str() {
            "rsa-sha2-512" => k.verify(Pkcs1v15Sign::new::<Sha512>(), &Sha512::digest(&data), &sig.sig).is_ok(),
            "rsa-sha2-256" => k.verify(Pkcs1v15Sign::new::<Sha256>(), &Sha256::digest(&data), &sig.sig).is_ok(),
            _ => false,
        },
    }
}

/// SSH ECDSA signature body (`mpint r, mpint s`) → fixed-size r‖s.
fn ssh_ecdsa_rs(body: &[u8], size: usize) -> Res<Vec<u8>> {
    let mut r = Reader::new(body);
    let mut out = left_pad(r.mpint()?, size)?;
    out.extend(left_pad(r.mpint()?, size)?);
    Ok(out)
}

fn ssh_mpint_pair(rs: &[u8]) -> Vec<u8> {
    let half = rs.len() / 2;
    let mut out = Vec::new();
    write_mpint(&mut out, &BigUint::from_bytes_be(&rs[..half]));
    write_mpint(&mut out, &BigUint::from_bytes_be(&rs[half..]));
    out
}

/// Armored SSHSIG (`ssh-keygen -Y sign` output): SHA-512 of the file, rsa-sha2-512 for RSA keys.
fn sshsig_sign(key: &PrivKey, namespace: &str, sha512: &[u8]) -> Res<String> {
    let data = sshsig_signed_data(namespace, Hash::Sha512, sha512);
    let (sig_type, sig) = match key {
        PrivKey::Ed25519(k) => ("ssh-ed25519", k.sign(&data).to_bytes().to_vec()),
        PrivKey::P256(k) => {
            let s: p256::ecdsa::Signature = signature::Signer::sign(k, &data);
            ("ecdsa-sha2-nistp256", ssh_mpint_pair(&s.to_bytes()))
        }
        PrivKey::P384(k) => {
            let s: p384::ecdsa::Signature = signature::Signer::sign(k, &data);
            ("ecdsa-sha2-nistp384", ssh_mpint_pair(&s.to_bytes()))
        }
        PrivKey::Rsa(k) => (
            "rsa-sha2-512",
            k.sign(Pkcs1v15Sign::new::<Sha512>(), &Sha512::digest(&data)).map_err(|_| E_SIGN)?,
        ),
    };
    let mut sig_blob = Vec::new();
    write_string(&mut sig_blob, sig_type.as_bytes());
    write_string(&mut sig_blob, &sig);

    let mut blob = SSHSIG_MAGIC.to_vec();
    write_u32_be(&mut blob, 1);
    write_string(&mut blob, &key.public().ssh_blob());
    write_string(&mut blob, namespace.as_bytes());
    write_string(&mut blob, b"");
    write_string(&mut blob, b"sha512");
    write_string(&mut blob, &sig_blob);

    // ssh-keygen wraps the armor at 70 columns.
    let b64 = B64.encode(&blob);
    let mut out = format!("{SSHSIG_BEGIN}\n");
    for chunk in b64.as_bytes().chunks(70) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str(SSHSIG_END);
    out.push('\n');
    Ok(out)
}

// ---------------------------------------------------------------- minisign

struct Minisig {
    prehashed: bool,
    key_id: [u8; 8],
    sig: [u8; 64],
    untrusted_comment: String,
    trusted_comment: String,
    global_sig: [u8; 64],
}

fn is_minisig(text: &str) -> bool {
    text.trim_start().starts_with("untrusted comment:")
}

/// `.minisig`: untrusted comment, base64(alg ‖ key id ‖ sig), trusted comment, base64(global sig).
fn parse_minisig(text: &str) -> Res<Minisig> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.trim().is_empty()).collect();
    if lines.len() < 4 {
        return Err(E_SIG_FORMAT);
    }
    let untrusted_comment = lines[0].strip_prefix("untrusted comment:").ok_or(E_SIG_FORMAT)?.trim().to_string();
    let bin = B64.decode(lines[1].trim()).map_err(|_| E_SIG_FORMAT)?;
    let trusted_comment = lines[2].strip_prefix("trusted comment: ").ok_or(E_SIG_FORMAT)?.to_string();
    let global = B64.decode(lines[3].trim()).map_err(|_| E_SIG_FORMAT)?;
    if bin.len() != 74 || global.len() != 64 {
        return Err(E_SIG_FORMAT);
    }
    let prehashed = match &bin[..2] {
        b"ED" => true,
        b"Ed" => false,
        _ => return Err(E_SIG_FORMAT),
    };
    Ok(Minisig {
        prehashed,
        key_id: bin[2..10].try_into().map_err(|_| E_SIG_FORMAT)?,
        sig: bin[10..74].try_into().map_err(|_| E_SIG_FORMAT)?,
        untrusted_comment,
        trusted_comment,
        global_sig: global.as_slice().try_into().map_err(|_| E_SIG_FORMAT)?,
    })
}

/// minisign public key: the base64 line `RW…` (42 bytes: "Ed" ‖ key id ‖ Ed25519 key), comment optional.
fn parse_minisign_public_key(text: &str) -> Res<([u8; 8], ed25519_dalek::VerifyingKey)> {
    let text = text.trim();
    if text.is_empty() {
        return Err(E_KEY_MISSING);
    }
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("untrusted comment:")) {
        let Ok(bin) = B64.decode(line) else { continue };
        if bin.len() == 42 && &bin[..2] == b"Ed" {
            let key_id: [u8; 8] = bin[2..10].try_into().map_err(|_| E_KEY_FORMAT)?;
            let pk: [u8; 32] = bin[10..42].try_into().map_err(|_| E_KEY_FORMAT)?;
            let vk = ed25519_dalek::VerifyingKey::from_bytes(&pk).map_err(|_| E_KEY_FORMAT)?;
            return Ok((key_id, vk));
        }
    }
    Err(E_KEY_FORMAT)
}

/// minisign prints key ids as 16 uppercase hex digits of the little-endian u64.
fn minisign_key_id(id: &[u8; 8]) -> String {
    format!("{:016X}", u64::from_le_bytes(*id))
}

// ---------------------------------------------------------------- raw signatures

/// Possible decodings of a raw signature: text as hex or base64 (std/url), else the bytes themselves.
fn raw_signature_candidates(bytes: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let mut out = Vec::new();
    if let Ok(text) = std::str::from_utf8(bytes) {
        let compact = strip_ws(text);
        let hex_like = compact.len() % 2 == 0 && !compact.is_empty() && compact.bytes().all(|b| b.is_ascii_hexdigit());
        if hex_like {
            let decoded: Vec<u8> = (0..compact.len()).step_by(2).filter_map(|i| u8::from_str_radix(&compact[i..i + 2], 16).ok()).collect();
            out.push(("hex", decoded));
        }
        if !compact.is_empty() {
            if let Ok(b) = B64.decode(compact.as_bytes()).or_else(|_| B64_NO_PAD.decode(compact.as_bytes())) {
                out.push(("base64", b));
            } else if let Ok(b) = B64_URL.decode(compact.trim_end_matches('=').as_bytes()) {
                out.push(("base64url", b));
            }
        }
    }
    out.push(("binary", bytes.to_vec()));
    out
}

const RAW_HASHES: [Hash; 3] = [Hash::Sha256, Hash::Sha384, Hash::Sha512];

fn rsa_verify_prehash(key: &RsaPublicKey, hash: Hash, digest: &[u8], sig: &[u8], pss_salt: Option<usize>) -> bool {
    macro_rules! go {
        ($d:ty) => {
            match pss_salt {
                None => key.verify(Pkcs1v15Sign::new::<$d>(), digest, sig).is_ok(),
                Some(salt) => key.verify(Pss::new_with_salt::<$d>(salt), digest, sig).is_ok(),
            }
        };
    }
    match hash {
        Hash::Sha256 => go!(Sha256),
        Hash::Sha384 => go!(Sha384),
        Hash::Sha512 => go!(Sha512),
    }
}

/// Tries every supported scheme/hash/encoding; returns (encoding, scheme, hash) of the first match.
fn raw_verify(key: &PubKey, candidates: &[(&'static str, Vec<u8>)], d: &Finished) -> Option<(&'static str, String, Option<Hash>)> {
    for (encoding, sig) in candidates {
        match key {
            PubKey::Ed25519(k) => {
                if let Ok(s) = ed25519_dalek::Signature::from_slice(sig) {
                    if k.verify(&d.whole, &s).is_ok() {
                        return Some((encoding, "Ed25519".into(), None));
                    }
                }
            }
            PubKey::P256(k) => {
                let parsed = if sig.len() == 64 { p256::ecdsa::Signature::from_slice(sig) } else { p256::ecdsa::Signature::from_der(sig) };
                if let Ok(s) = parsed {
                    for h in RAW_HASHES {
                        if k.verify_prehash(d.get(h), &s).is_ok() {
                            return Some((encoding, format!("ECDSA P-256 · {}", if sig.len() == 64 { "P1363" } else { "DER" }), Some(h)));
                        }
                    }
                }
            }
            PubKey::P384(k) => {
                let parsed = if sig.len() == 96 { p384::ecdsa::Signature::from_slice(sig) } else { p384::ecdsa::Signature::from_der(sig) };
                if let Ok(s) = parsed {
                    for h in RAW_HASHES {
                        if k.verify_prehash(d.get(h), &s).is_ok() {
                            return Some((encoding, format!("ECDSA P-384 · {}", if sig.len() == 96 { "P1363" } else { "DER" }), Some(h)));
                        }
                    }
                }
            }
            PubKey::Rsa(k) => {
                if sig.len() != k.size() {
                    continue;
                }
                for h in RAW_HASHES {
                    if rsa_verify_prehash(k, h, d.get(h), sig, None) {
                        return Some((encoding, "RSA PKCS#1 v1.5".into(), Some(h)));
                    }
                }
                // OpenSSL signs PSS with salt = digest length (3.1+ default) or the maximum (older default).
                let em_len = (k.n().bits() - 1).div_ceil(8);
                for h in RAW_HASHES {
                    for salt in [h.len(), em_len.saturating_sub(h.len() + 2), 0] {
                        if rsa_verify_prehash(k, h, d.get(h), sig, Some(salt)) {
                            return Some((encoding, "RSA-PSS".into(), Some(h)));
                        }
                    }
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------- wasm API: verify

enum VerifyKind {
    SshSig { sig: SshSig, trusted: Option<String> },
    Minisign { sig: Minisig, key: ed25519_dalek::VerifyingKey },
    Raw { key: PubKey, candidates: Vec<(&'static str, Vec<u8>)> },
}

/// Streaming file signature verifier. `new` parses the signature and key (fails fast before
/// hashing), `info()` describes the plan, `update()` takes file chunks, `finish()` returns the verdict JSON.
#[wasm_bindgen]
pub struct FileSignatureVerifier {
    kind: VerifyKind,
    digests: Digests,
    info: Map<String, Value>,
    failure: Option<&'static str>,
}

impl FileSignatureVerifier {
    fn create(signature: &[u8], key_text: &str, namespace: &str) -> Res<FileSignatureVerifier> {
        let text = std::str::from_utf8(signature).unwrap_or("");
        let mut info = Map::new();
        let mut failure = None;

        if text.contains(SSHSIG_BEGIN) {
            let sig = parse_sshsig(text)?;
            let expected = namespace.trim();
            if expected.is_empty() {
                return Err(E_NAMESPACE);
            }
            info.insert("format".into(), json!("sshsig"));
            info.insert("algorithm".into(), json!(sig.key.algorithm()));
            info.insert("hash".into(), json!(sig.hash.name()));
            info.insert("namespace".into(), json!(sig.namespace));
            info.insert("fingerprint".into(), json!(sig.key.fingerprint()));
            info.insert("publicKey".into(), json!(sig.key.ssh_line()));
            if sig.namespace != expected {
                failure = Some("namespace");
            }
            // Without trusted keys the signature is only checked against the key it carries.
            let mut trusted = None;
            if !key_text.trim().is_empty() {
                let blob = sig.key.ssh_blob();
                let matched = parse_public_keys(key_text)?.into_iter().find(|e| {
                    e.key.ssh_blob() == blob
                        && e.namespaces.as_ref().is_none_or(|ns| ns.iter().any(|n| n == "*" || n == &sig.namespace))
                });
                match matched {
                    Some(entry) => {
                        info.insert("trusted".into(), json!(true));
                        if let Some(p) = &entry.principal {
                            info.insert("principal".into(), json!(p));
                        }
                        trusted = Some(entry.principal.unwrap_or_default());
                    }
                    None => {
                        info.insert("trusted".into(), json!(false));
                        failure = failure.or(Some("untrusted"));
                    }
                }
            }
            let digests = Digests::with(&[sig.hash], false, false);
            return Ok(FileSignatureVerifier { kind: VerifyKind::SshSig { sig, trusted }, digests, info, failure });
        }

        if is_minisig(text) {
            let sig = parse_minisig(text)?;
            let (key_id, key) = parse_minisign_public_key(key_text)?;
            info.insert("format".into(), json!("minisign"));
            info.insert("algorithm".into(), json!("Ed25519"));
            info.insert("hash".into(), json!(if sig.prehashed { "BLAKE2b-512" } else { "—" }));
            info.insert("keyId".into(), json!(minisign_key_id(&sig.key_id)));
            info.insert("trustedComment".into(), json!(sig.trusted_comment));
            info.insert("untrustedComment".into(), json!(sig.untrusted_comment));
            if key_id != sig.key_id {
                info.insert("expectedKeyId".into(), json!(minisign_key_id(&key_id)));
                failure = Some("key-mismatch");
            }
            let digests = Digests::with(&[], sig.prehashed, !sig.prehashed);
            return Ok(FileSignatureVerifier { kind: VerifyKind::Minisign { sig, key }, digests, info, failure });
        }

        // Printable text that is neither hex nor base64 cannot be a raw signature.
        let candidates = raw_signature_candidates(signature);
        let printable = std::str::from_utf8(signature).is_ok_and(|t| !t.chars().any(|c| c.is_control() && !c.is_whitespace()));
        if signature.is_empty() || (printable && candidates.len() == 1) {
            return Err(E_SIG_FORMAT);
        }
        let mut keys = parse_public_keys(key_text)?;
        if keys.len() != 1 {
            return Err(E_KEY_FORMAT);
        }
        let key = keys.remove(0).key;
        info.insert("format".into(), json!("raw"));
        info.insert("algorithm".into(), json!(key.algorithm()));
        info.insert("fingerprint".into(), json!(key.fingerprint()));
        let digests = match key {
            PubKey::Ed25519(_) => Digests::with(&[], false, true),
            _ => Digests::with(&RAW_HASHES, false, false),
        };
        Ok(FileSignatureVerifier { kind: VerifyKind::Raw { key, candidates }, digests, info, failure })
    }

    fn outcome(&mut self) -> Map<String, Value> {
        let mut out = self.info.clone();
        if let Some(f) = self.failure {
            out.insert("valid".into(), json!(false));
            out.insert("failure".into(), json!(f));
            return out;
        }
        let d = self.digests.finish();
        let failure = match &self.kind {
            VerifyKind::SshSig { sig, trusted } => {
                out.insert("scheme".into(), json!(sig.sig_type));
                let ok = sshsig_verify(sig, d.get(sig.hash));
                if ok && trusted.is_none() {
                    out.insert("trusted".into(), Value::Null);
                }
                (!ok).then_some("signature")
            }
            VerifyKind::Minisign { sig, key } => {
                let message: &[u8] = if sig.prehashed { &d.blake2b } else { &d.whole };
                let s = ed25519_dalek::Signature::from_bytes(&sig.sig);
                if key.verify(message, &s).is_err() {
                    Some("signature")
                } else {
                    let mut global = sig.sig.to_vec();
                    global.extend_from_slice(sig.trusted_comment.as_bytes());
                    let g = ed25519_dalek::Signature::from_bytes(&sig.global_sig);
                    key.verify(&global, &g).is_err().then_some("comment")
                }
            }
            VerifyKind::Raw { key, candidates } => match raw_verify(key, candidates, &d) {
                Some((encoding, scheme, hash)) => {
                    out.insert("encoding".into(), json!(encoding));
                    out.insert("scheme".into(), json!(scheme));
                    out.insert("hash".into(), json!(hash.map_or("—", Hash::name)));
                    None
                }
                None => Some("signature"),
            },
        };
        out.insert("valid".into(), json!(failure.is_none()));
        if let Some(f) = failure {
            out.insert("failure".into(), json!(f));
        }
        out
    }
}

#[wasm_bindgen]
impl FileSignatureVerifier {
    /// `signature`: armored SSHSIG, `.minisig` text, or a raw signature (binary, hex or base64).
    /// `key_text`: trusted public key(s); optional for SSHSIG. `namespace`: expected SSHSIG namespace.
    #[wasm_bindgen(constructor)]
    pub fn new(signature: &[u8], key_text: &str, namespace: &str) -> Result<FileSignatureVerifier, JsValue> {
        Self::create(signature, key_text, namespace).map_err(js)
    }

    /// Plan as JSON: format, algorithm, fingerprint, … plus `wholeFile` and an early `failure` (skip hashing).
    pub fn info(&self) -> String {
        let mut info = self.info.clone();
        info.insert("wholeFile".into(), json!(self.digests.whole_file()));
        if let Some(f) = self.failure {
            info.insert("failure".into(), json!(f));
        }
        Value::Object(info).to_string()
    }

    pub fn update(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.digests.update(chunk).map_err(js)
    }

    /// Verdict JSON: `valid`, `failure` (signature | namespace | untrusted | key-mismatch | comment), details.
    pub fn finish(&mut self) -> String {
        Value::Object(self.outcome()).to_string()
    }
}

// ---------------------------------------------------------------- wasm API: sign

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignOptions {
    format: String,
    #[serde(default)]
    namespace: String,
    #[serde(default = "default_hash")]
    hash: String,
    #[serde(default)]
    padding: String,
    #[serde(default)]
    encoding: String,
}

fn default_hash() -> String {
    "sha256".into()
}

/// Streaming file signer: SSHSIG (any key) or a raw OpenSSL-compatible signature.
#[wasm_bindgen]
pub struct FileSigner {
    key: PrivKey,
    sshsig: bool,
    namespace: String,
    hash: Hash,
    pss: bool,
    p1363: bool,
    digests: Digests,
}

impl FileSigner {
    fn create(key_text: &str, passphrase: Option<String>, options_json: &str) -> Res<FileSigner> {
        let o: SignOptions = serde_json::from_str(options_json).map_err(|_| E_OPTIONS)?;
        let key = parse_private_key(key_text, passphrase)?;
        let sshsig = match o.format.as_str() {
            "sshsig" => true,
            "raw" => false,
            _ => return Err(E_OPTIONS),
        };
        let namespace = o.namespace.trim().to_string();
        if sshsig && namespace.is_empty() {
            return Err(E_NAMESPACE);
        }
        let hash = Hash::parse(&o.hash)?;
        let digests = if sshsig {
            Digests::with(&[Hash::Sha512], false, false)
        } else if matches!(key, PrivKey::Ed25519(_)) {
            Digests::with(&[], false, true)
        } else {
            Digests::with(&[hash], false, false)
        };
        Ok(FileSigner { key, sshsig, namespace, hash, pss: o.padding == "pss", p1363: o.encoding == "p1363", digests })
    }

    fn scheme(&self) -> String {
        if self.sshsig {
            return match self.key {
                PrivKey::Rsa(_) => "rsa-sha2-512".into(),
                _ => self.key.public().ssh_type().into(),
            };
        }
        match &self.key {
            PrivKey::Ed25519(_) => "Ed25519".into(),
            PrivKey::P256(_) | PrivKey::P384(_) => {
                format!("{} · {} · {}", self.key.public().algorithm(), self.hash.name(), if self.p1363 { "P1363" } else { "DER" })
            }
            PrivKey::Rsa(_) => format!("{} · {}", if self.pss { "RSA-PSS" } else { "RSA PKCS#1 v1.5" }, self.hash.name()),
        }
    }

    fn sign_raw(&self, d: &Finished) -> Res<Vec<u8>> {
        let digest = d.get(self.hash);
        Ok(match &self.key {
            PrivKey::Ed25519(k) => k.sign(&d.whole).to_bytes().to_vec(),
            PrivKey::P256(k) => {
                let s: p256::ecdsa::Signature = k.sign_prehash(digest).map_err(|_| E_SIGN)?;
                if self.p1363 { s.to_bytes().to_vec() } else { s.to_der().as_bytes().to_vec() }
            }
            PrivKey::P384(k) => {
                let s: p384::ecdsa::Signature = k.sign_prehash(digest).map_err(|_| E_SIGN)?;
                if self.p1363 { s.to_bytes().to_vec() } else { s.to_der().as_bytes().to_vec() }
            }
            PrivKey::Rsa(k) => {
                // Salt = digest length (OpenSSL 3.1+ default), capped for small keys.
                let salt = self.hash.len().min((k.n().bits() - 1).div_ceil(8).saturating_sub(self.hash.len() + 2));
                macro_rules! go {
                    ($d:ty) => {
                        if self.pss {
                            k.sign_with_rng(&mut WasmRng, Pss::new_with_salt::<$d>(salt), digest)
                        } else {
                            k.sign(Pkcs1v15Sign::new::<$d>(), digest)
                        }
                    };
                }
                match self.hash {
                    Hash::Sha256 => go!(Sha256),
                    Hash::Sha384 => go!(Sha384),
                    Hash::Sha512 => go!(Sha512),
                }
                .map_err(|_| E_SIGN)?
            }
        })
    }
}

#[wasm_bindgen]
impl FileSigner {
    /// `options_json`: `{format: "sshsig"|"raw", namespace, hash: "sha256"|"sha384"|"sha512",
    /// padding: "pkcs1"|"pss", encoding: "der"|"p1363"}`. Fails fast on a bad key or passphrase.
    #[wasm_bindgen(constructor)]
    pub fn new(key_text: &str, passphrase: Option<String>, options_json: &str) -> Result<FileSigner, JsValue> {
        Self::create(key_text, passphrase, options_json).map_err(js)
    }

    /// Key and scheme as JSON: algorithm, fingerprint, publicKey (OpenSSH line), publicKeyPem, scheme, wholeFile.
    pub fn info(&self) -> String {
        let public = self.key.public();
        json!({
            "format": if self.sshsig { "sshsig" } else { "raw" },
            "algorithm": public.algorithm(),
            "fingerprint": public.fingerprint(),
            "publicKey": public.ssh_line(),
            "publicKeyPem": public.spki_pem(),
            "scheme": self.scheme(),
            "namespace": if self.sshsig { self.namespace.as_str() } else { "" },
            "wholeFile": self.digests.whole_file(),
        })
        .to_string()
    }

    pub fn update(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.digests.update(chunk).map_err(js)
    }

    /// `{armored}` (SSHSIG text) or `{signature}` (raw bytes as base64).
    pub fn finish(&mut self) -> Result<String, JsValue> {
        let d = self.digests.finish();
        let out = if self.sshsig {
            json!({ "armored": sshsig_sign(&self.key, &self.namespace, &d.sha512).map_err(js)? })
        } else {
            json!({ "signature": B64.encode(self.sign_raw(&d).map_err(js)?) })
        };
        Ok(out.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(d: &mut Digests, data: &[u8]) {
        for chunk in data.chunks(7) {
            d.update(chunk).unwrap();
        }
    }

    fn verify(sig: &[u8], key: &str, ns: &str, data: &[u8]) -> Value {
        let mut v = FileSignatureVerifier::create(sig, key, ns).unwrap_or_else(|e| panic!("create: {e}"));
        feed(&mut v.digests, data);
        Value::Object(v.outcome())
    }

    fn sign(key: &str, options: &str, data: &[u8]) -> Value {
        let mut s = FileSigner::create(key, None, options).unwrap_or_else(|e| panic!("signer: {e}"));
        feed(&mut s.digests, data);
        let d = s.digests.finish();
        if s.sshsig {
            json!({ "armored": sshsig_sign(&s.key, &s.namespace, &d.sha512).unwrap() })
        } else {
            json!({ "signature": B64.encode(s.sign_raw(&d).unwrap()) })
        }
    }

    const P256_PKCS8: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYOWx4fNWkEGeFUCb
pnRGeCRpLz6HiQwFBVTTPeko+NihRANCAARF+ksfq0NCmDUFdkGibH48SWkqwoAp
C7R4TwcplgQHf8WkxVTwed05oMJS0o+oBGZndyE4rFlH4lhG2saK+BWa
-----END PRIVATE KEY-----
";

    #[test]
    fn sshsig_roundtrip_and_namespace() {
        let data = b"hello file signatures";
        let armored = sign(P256_PKCS8, r#"{"format":"sshsig","namespace":"file"}"#, data)["armored"].as_str().unwrap().to_string();
        assert!(armored.starts_with(SSHSIG_BEGIN));
        assert!(armored.lines().all(|l| l.len() <= 70 || l.starts_with("-----")));
        let ok = verify(armored.as_bytes(), "", "file", data);
        assert_eq!(ok["valid"], true);
        assert_eq!(ok["trusted"], Value::Null);
        assert_eq!(verify(armored.as_bytes(), "", "file", b"tampered")["failure"], "signature");
        assert_eq!(verify(armored.as_bytes(), "", "git", data)["failure"], "namespace");
    }

    #[test]
    fn allowed_signers_matching() {
        let data = b"x";
        let armored = sign(P256_PKCS8, r#"{"format":"sshsig","namespace":"file"}"#, data)["armored"].as_str().unwrap().to_string();
        let key = parse_private_key(P256_PKCS8, None).ok().unwrap().public().ssh_line();
        let signers = format!("# team\nalice@example.com namespaces=\"file,git\" {key} laptop\n");
        let r = verify(armored.as_bytes(), &signers, "file", data);
        assert_eq!(r["valid"], true);
        assert_eq!(r["principal"], "alice@example.com");
        let only_git = format!("alice@example.com namespaces=\"git\" {key}\n");
        assert_eq!(verify(armored.as_bytes(), &only_git, "file", data)["failure"], "untrusted");
    }

    #[test]
    fn raw_signatures_roundtrip_all_encodings() {
        let data = vec![42u8; 5000];
        for (opts, hash) in [
            (r#"{"format":"raw","hash":"sha384"}"#, "SHA-384"),
            (r#"{"format":"raw","hash":"sha512","encoding":"p1363"}"#, "SHA-512"),
        ] {
            let b64 = sign(P256_PKCS8, opts, &data)["signature"].as_str().unwrap().to_string();
            let public = parse_private_key(P256_PKCS8, None).ok().unwrap().public().spki_pem();
            let r = verify(b64.as_bytes(), &public, "", &data);
            assert_eq!(r["valid"], true, "{opts}");
            assert_eq!(r["hash"], hash);
            assert_eq!(r["encoding"], "base64");
            let binary = B64.decode(&b64).unwrap();
            assert_eq!(verify(&binary, &public, "", &data)["valid"], true);
            assert_eq!(verify(&binary, &public, "", b"other")["valid"], false);
        }
    }

    #[test]
    fn rsa_pkcs1_and_pss_and_jwk() {
        let key = RsaPrivateKey::new(&mut WasmRng, 2048).unwrap();
        let pem = rsa::pkcs1::EncodeRsaPrivateKey::to_pkcs1_pem(&key, Default::default()).unwrap().to_string();
        let data = b"rsa data";
        let public = PubKey::Rsa(key.to_public_key()).spki_pem();
        for opts in [r#"{"format":"raw","hash":"sha256"}"#, r#"{"format":"raw","hash":"sha512","padding":"pss"}"#] {
            let sig = sign(&pem, opts, data)["signature"].as_str().unwrap().to_string();
            let r = verify(sig.as_bytes(), &public, "", data);
            assert_eq!(r["valid"], true, "{opts}");
        }
        let jwk = json!({"kty":"RSA","n":B64_URL.encode(key.n().to_bytes_be()),"e":B64_URL.encode(key.e().to_bytes_be())}).to_string();
        let sig = sign(&pem, r#"{"format":"raw"}"#, data)["signature"].as_str().unwrap().to_string();
        assert_eq!(verify(sig.as_bytes(), &jwk, "", data)["scheme"], "RSA PKCS#1 v1.5");
    }

    #[test]
    fn ed25519_raw_needs_whole_file() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let jwk = json!({"kty":"OKP","crv":"Ed25519","x":B64_URL.encode(sk.verifying_key().as_bytes()),"d":B64_URL.encode(sk.to_bytes())}).to_string();
        let data = b"pure ed25519";
        let hex: String = sign(&jwk, r#"{"format":"raw"}"#, data)["signature"]
            .as_str()
            .map(|s| B64.decode(s).unwrap().iter().map(|b| format!("{b:02x}")).collect())
            .unwrap();
        let public = json!({"kty":"OKP","crv":"Ed25519","x":B64_URL.encode(sk.verifying_key().as_bytes())}).to_string();
        let r = verify(hex.as_bytes(), &public, "", data);
        assert_eq!(r["valid"], true);
        assert_eq!(r["encoding"], "hex");
        assert!(matches!(parse_public_keys(&jwk), Err(E_KEY_PRIVATE_GIVEN)));
    }

    #[test]
    fn minisign_prehashed_and_comment() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let key_id = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let data = b"minisign payload";
        let sig = sk.sign(&Blake2b512::digest(data)).to_bytes();
        let comment = "timestamp:1700000000\tfile:payload.txt\tprehashed";
        let mut global = sig.to_vec();
        global.extend_from_slice(comment.as_bytes());
        let gsig = sk.sign(&global).to_bytes();
        let mut bin = b"ED".to_vec();
        bin.extend_from_slice(&key_id);
        bin.extend_from_slice(&sig);
        let minisig = format!("untrusted comment: signature from minisign secret key\n{}\ntrusted comment: {comment}\n{}\n", B64.encode(&bin), B64.encode(gsig));
        let mut pk = b"Ed".to_vec();
        pk.extend_from_slice(&key_id);
        pk.extend_from_slice(sk.verifying_key().as_bytes());
        let pubkey = format!("untrusted comment: minisign public key 0807060504030201\n{}\n", B64.encode(&pk));
        let r = verify(minisig.as_bytes(), &pubkey, "", data);
        assert_eq!(r["valid"], true);
        assert_eq!(r["keyId"], "0807060504030201");
        assert_eq!(r["trustedComment"], comment);
        let forged = minisig.replace("prehashed", "prehashed!");
        assert_eq!(verify(forged.as_bytes(), &pubkey, "", data)["failure"], "comment");
    }

    #[test]
    fn whole_file_limit() {
        let mut d = Digests::with(&[], false, true);
        assert!(d.update(&vec![0u8; MAX_WHOLE_FILE]).is_ok());
        assert_eq!(d.update(&[0u8]).err(), Some(E_TOO_LARGE));
    }

    #[test]
    fn key_errors() {
        assert!(matches!(parse_private_key(&PubKey::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[1; 32]).verifying_key()).ssh_line(), None), Err(E_KEY_PUBLIC_GIVEN)));
        assert!(matches!(parse_public_keys(P256_PKCS8), Err(E_KEY_PRIVATE_GIVEN)));
        assert!(matches!(parse_public_keys("ssh-dss AAAAB3NzaC1kc3M="), Err(E_KEY_UNSUPPORTED)));
        assert!(matches!(parse_public_keys("garbage"), Err(E_KEY_FORMAT)));
        assert!(matches!(FileSignatureVerifier::create(b"garbage!!", "RWQ", ""), Err(E_SIG_FORMAT)));
    }
}
