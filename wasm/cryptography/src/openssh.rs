use wasm_bindgen::prelude::*;

use aes::Aes256;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use bcrypt_pbkdf::bcrypt_pbkdf;
use ctr::cipher::{KeyIvInit, StreamCipher};
use ed25519_dalek::{
    pkcs8::{DecodePrivateKey as Ed25519DecodePrivateKey, EncodePrivateKey as Ed25519EncodePrivateKey},
    SigningKey as Ed25519SigningKey,
};
use getrandom::getrandom;
use num_bigint_dig::{BigInt, Sign};
use p256::pkcs8::{
    DecodePrivateKey as P256DecodePrivateKey, EncodePrivateKey as P256EncodePrivateKey,
    EncodePublicKey as P256EncodePublicKey,
};
use p256::PublicKey as P256PublicKey;
use p256::SecretKey as P256SecretKey;
use p384::pkcs8::{
    DecodePrivateKey as P384DecodePrivateKey, EncodePrivateKey as P384EncodePrivateKey,
    EncodePublicKey as P384EncodePublicKey,
};
use p384::PublicKey as P384PublicKey;
use p384::SecretKey as P384SecretKey;
use pkcs8::{der::SecretDocument, EncryptedPrivateKeyInfo};
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::{
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey},
    BigUint, RsaPrivateKey, RsaPublicKey,
};

use crate::ecdsa;

const OPENSSH_ED25519: &str = "ssh-ed25519";
const OPENSSH_ECDSA_P256: &str = "ecdsa-sha2-nistp256";
const OPENSSH_ECDSA_P384: &str = "ecdsa-sha2-nistp384";
const OPENSSH_CURVE_P256: &str = "nistp256";
const OPENSSH_CURVE_P384: &str = "nistp384";
const OPENSSH_RSA: &str = "ssh-rsa";

const OPENSSH_PRIVATE_MAGIC: &[u8] = b"openssh-key-v1\0";
const OPENSSH_PRIVATE_BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_PRIVATE_END: &str = "-----END OPENSSH PRIVATE KEY-----";
const OPENSSH_CIPHER_NONE: &str = "none";
const OPENSSH_CIPHER_AES256_CTR: &str = "aes256-ctr";
const OPENSSH_KDF_NONE: &str = "none";
const OPENSSH_KDF_BCRYPT: &str = "bcrypt";

type Aes256Ctr = ctr::Ctr128BE<Aes256>;

const OPENSSH_ALG_ED25519: u8 = 1;
const OPENSSH_ALG_ECDSA_P256: u8 = 2;
const OPENSSH_ALG_ECDSA_P384: u8 = 3;
const OPENSSH_ALG_RSA: u8 = 4;

fn write_u32_be(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn read_u32_be(data: &[u8], pos: &mut usize) -> Result<u32, JsValue> {
    if *pos + 4 > data.len() {
        return Err(JsValue::from_str("invalid blob length"));
    }
    let value = u32::from_be_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
    *pos += 4;
    Ok(value)
}

fn write_mpint(buf: &mut Vec<u8>, value: &BigUint) {
    let mut bytes = value.to_bytes_be();
    if bytes.first().is_some_and(|b| (b & 0x80) != 0) {
        bytes.insert(0, 0);
    }
    write_u32_be(buf, bytes.len() as u32);
    buf.extend_from_slice(&bytes);
}

fn read_mpint(data: &[u8], pos: &mut usize) -> Result<BigUint, JsValue> {
    let len = read_u32_be(data, pos)? as usize;
    if *pos + len > data.len() {
        return Err(JsValue::from_str("invalid mpint length"));
    }
    let slice = &data[*pos..*pos + len];
    *pos += len;

    let mut bytes = slice;
    if let Some(0) = bytes.first().copied() {
        bytes = &bytes[1..];
    }
    Ok(BigUint::from_bytes_be(bytes))
}

fn write_string(buf: &mut Vec<u8>, value: &[u8]) {
    write_u32_be(buf, value.len() as u32);
    buf.extend_from_slice(value);
}

fn read_string(data: &[u8], pos: &mut usize) -> Result<Vec<u8>, JsValue> {
    let len = read_u32_be(data, pos)? as usize;
    if *pos + len > data.len() {
        return Err(JsValue::from_str("invalid string length"));
    }
    let out = data[*pos..*pos + len].to_vec();
    *pos += len;
    Ok(out)
}

fn read_string_as_str(data: &[u8], pos: &mut usize) -> Result<String, JsValue> {
    let bytes = read_string(data, pos)?;
    String::from_utf8(bytes).map_err(|_| JsValue::from_str("invalid utf-8"))
}

fn openssh_private_key_pem_from_blob(blob: &[u8]) -> String {
    let b64 = BASE64_STANDARD.encode(blob);
    let mut out = String::with_capacity(b64.len() + 96);
    out.push_str(OPENSSH_PRIVATE_BEGIN);
    out.push('\n');
    for chunk in b64.as_bytes().chunks(70) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str(OPENSSH_PRIVATE_END);
    out.push('\n');
    out
}

fn openssh_private_key_blob_from_pem(pem: &str) -> Result<Vec<u8>, JsValue> {
    let mut b64 = String::new();
    for line in pem.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("-----") {
            continue;
        }
        b64.push_str(line);
    }
    if b64.is_empty() {
        return Err(JsValue::from_str("invalid PEM"));
    }
    BASE64_STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| JsValue::from_str("invalid base64"))
}

fn pad_private_blob(mut data: Vec<u8>, block_size: usize) -> Vec<u8> {
    let mut pad_len = block_size - (data.len() % block_size);
    if pad_len == 0 {
        pad_len = block_size;
    }
    for i in 1..=pad_len {
        data.push(i as u8);
    }
    data
}

fn bcrypt_kdf(passphrase: &[u8], salt: &[u8], rounds: u32, out_len: usize) -> Result<Vec<u8>, JsValue> {
    let mut out = vec![0u8; out_len];
    bcrypt_pbkdf(passphrase, salt, rounds, &mut out)
        .map_err(|_| JsValue::from_str("bcrypt kdf failed"))?;
    Ok(out)
}

fn aes256_ctr_crypt(key: &[u8], iv: &[u8], data: &mut [u8]) -> Result<(), JsValue> {
    let mut cipher = Aes256Ctr::new_from_slices(key, iv)
        .map_err(|_| JsValue::from_str("invalid key/iv"))?;
    cipher.apply_keystream(data);
    Ok(())
}

fn modinv(a: &BigUint, m: &BigUint) -> Option<BigUint> {
    let mut t = BigInt::from(0);
    let mut new_t = BigInt::from(1);
    let mut r = BigInt::from_biguint(Sign::Plus, m.clone());
    let mut new_r = BigInt::from_biguint(Sign::Plus, a.clone());

    while new_r != BigInt::from(0) {
        let q = &r / &new_r;
        let tmp_t = new_t.clone();
        new_t = &t - &q * &new_t;
        t = tmp_t;

        let tmp_r = new_r.clone();
        new_r = &r - &q * &new_r;
        r = tmp_r;
    }

    if r != BigInt::from(1) {
        return None;
    }

    if t.sign() == Sign::Minus {
        t += BigInt::from_biguint(Sign::Plus, m.clone());
    }

    t.to_biguint()
}

/// Builds OpenSSH public key line for Ed25519.
///
/// Output: "ssh-ed25519 <base64> [comment]"
#[wasm_bindgen]
pub fn openssh_ed25519_public_key(public_key: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    if public_key.len() != 32 {
        return Err(JsValue::from_str("public_key must be 32 bytes"));
    }

    let key_type = OPENSSH_ED25519.as_bytes();
    let mut blob = Vec::with_capacity(4 + key_type.len() + 4 + public_key.len());
    write_u32_be(&mut blob, key_type.len() as u32);
    blob.extend_from_slice(key_type);
    write_u32_be(&mut blob, public_key.len() as u32);
    blob.extend_from_slice(public_key);

    let b64 = BASE64_STANDARD.encode(blob);
    let mut out = String::with_capacity(OPENSSH_ED25519.len() + 1 + b64.len() + 1 + 32);
    out.push_str(OPENSSH_ED25519);
    out.push(' ');
    out.push_str(&b64);

    if let Some(c) = comment {
        if !c.is_empty() {
            out.push(' ');
            out.push_str(&c);
        }
    }

    Ok(out)
}

/// Builds OpenSSH public key line for Ed25519 from a 32-byte private key.
#[wasm_bindgen]
pub fn openssh_ed25519_public_key_from_private(private_key: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let signing_key = Ed25519SigningKey::from_bytes(&bytes);
    let public_key = signing_key.verifying_key().to_bytes();
    openssh_ed25519_public_key(&public_key, comment)
}

/// Builds OpenSSH public key line for ECDSA P-256.
///
/// Output: "ecdsa-sha2-nistp256 <base64> [comment]"
#[wasm_bindgen]
pub fn openssh_ecdsa_p256_public_key(public_key_uncompressed: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    if public_key_uncompressed.len() != 65 {
        return Err(JsValue::from_str("public_key must be 65 bytes (uncompressed)"));
    }

    let key_type = OPENSSH_ECDSA_P256.as_bytes();
    let curve = OPENSSH_CURVE_P256.as_bytes();

    let mut blob = Vec::with_capacity(
        4 + key_type.len() + 4 + curve.len() + 4 + public_key_uncompressed.len(),
    );
    write_u32_be(&mut blob, key_type.len() as u32);
    blob.extend_from_slice(key_type);
    write_u32_be(&mut blob, curve.len() as u32);
    blob.extend_from_slice(curve);
    write_u32_be(&mut blob, public_key_uncompressed.len() as u32);
    blob.extend_from_slice(public_key_uncompressed);

    let b64 = BASE64_STANDARD.encode(blob);
    let mut out = String::with_capacity(OPENSSH_ECDSA_P256.len() + 1 + b64.len() + 1 + 32);
    out.push_str(OPENSSH_ECDSA_P256);
    out.push(' ');
    out.push_str(&b64);

    if let Some(c) = comment {
        if !c.is_empty() {
            out.push(' ');
            out.push_str(&c);
        }
    }

    Ok(out)
}

/// Builds OpenSSH public key line for ECDSA P-256 from a 32-byte private key.
#[wasm_bindgen]
pub fn openssh_ecdsa_p256_public_key_from_private(private_key: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    let public_key = ecdsa::ecdsa_p256_public_key(private_key)?;
    openssh_ecdsa_p256_public_key(&public_key, comment)
}

/// Builds OpenSSH public key line for ECDSA P-384.
///
/// Output: "ecdsa-sha2-nistp384 <base64> [comment]"
#[wasm_bindgen]
pub fn openssh_ecdsa_p384_public_key(public_key_uncompressed: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    if public_key_uncompressed.len() != 97 {
        return Err(JsValue::from_str("public_key must be 97 bytes (uncompressed)"));
    }

    let key_type = OPENSSH_ECDSA_P384.as_bytes();
    let curve = OPENSSH_CURVE_P384.as_bytes();

    let mut blob = Vec::with_capacity(
        4 + key_type.len() + 4 + curve.len() + 4 + public_key_uncompressed.len(),
    );
    write_u32_be(&mut blob, key_type.len() as u32);
    blob.extend_from_slice(key_type);
    write_u32_be(&mut blob, curve.len() as u32);
    blob.extend_from_slice(curve);
    write_u32_be(&mut blob, public_key_uncompressed.len() as u32);
    blob.extend_from_slice(public_key_uncompressed);

    let b64 = BASE64_STANDARD.encode(blob);
    let mut out = String::with_capacity(OPENSSH_ECDSA_P384.len() + 1 + b64.len() + 1 + 32);
    out.push_str(OPENSSH_ECDSA_P384);
    out.push(' ');
    out.push_str(&b64);

    if let Some(c) = comment {
        if !c.is_empty() {
            out.push(' ');
            out.push_str(&c);
        }
    }

    Ok(out)
}

/// Builds OpenSSH public key line for RSA from SPKI DER.
///
/// Output: "ssh-rsa <base64> [comment]"
#[wasm_bindgen]
pub fn openssh_rsa_public_key_from_spki(public_key_der: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    let public_key = RsaPublicKey::from_public_key_der(public_key_der)
        .map_err(|_| JsValue::from_str("invalid public key"))?;

    let key_type = OPENSSH_RSA.as_bytes();
    let mut blob = Vec::with_capacity(4 + key_type.len() + 4 + 8 + 4 + 512);
    write_u32_be(&mut blob, key_type.len() as u32);
    blob.extend_from_slice(key_type);
    write_mpint(&mut blob, public_key.e());
    write_mpint(&mut blob, public_key.n());

    let b64 = BASE64_STANDARD.encode(blob);
    let mut out = String::with_capacity(OPENSSH_RSA.len() + 1 + b64.len() + 1 + 32);
    out.push_str(OPENSSH_RSA);
    out.push(' ');
    out.push_str(&b64);

    if let Some(c) = comment {
        if !c.is_empty() {
            out.push(' ');
            out.push_str(&c);
        }
    }

    Ok(out)
}

/// Builds OpenSSH public key line for RSA from PKCS#8 private key (DER).
#[wasm_bindgen]
pub fn openssh_rsa_public_key_from_private_pkcs8(private_key_der: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    let spki = crate::rsa_pss::rsa_public_key_from_private_pkcs8(private_key_der)?;
    openssh_rsa_public_key_from_spki(&spki, comment)
}

fn openssh_ed25519_public_blob(public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    if public_key.len() != 32 {
        return Err(JsValue::from_str("public_key must be 32 bytes"));
    }

    let key_type = OPENSSH_ED25519.as_bytes();
    let mut blob = Vec::with_capacity(4 + key_type.len() + 4 + public_key.len());
    write_u32_be(&mut blob, key_type.len() as u32);
    blob.extend_from_slice(key_type);
    write_u32_be(&mut blob, public_key.len() as u32);
    blob.extend_from_slice(public_key);
    Ok(blob)
}

fn openssh_ecdsa_public_blob(public_key_uncompressed: &[u8], key_type: &str, curve: &str) -> Result<Vec<u8>, JsValue> {
    let mut blob = Vec::with_capacity(
        4 + key_type.len() + 4 + curve.len() + 4 + public_key_uncompressed.len(),
    );
    write_u32_be(&mut blob, key_type.len() as u32);
    blob.extend_from_slice(key_type.as_bytes());
    write_u32_be(&mut blob, curve.len() as u32);
    blob.extend_from_slice(curve.as_bytes());
    write_u32_be(&mut blob, public_key_uncompressed.len() as u32);
    blob.extend_from_slice(public_key_uncompressed);
    Ok(blob)
}

fn openssh_rsa_public_blob(public_key: &RsaPublicKey) -> Vec<u8> {
    let key_type = OPENSSH_RSA.as_bytes();
    let mut blob = Vec::with_capacity(4 + key_type.len() + 4 + 8 + 4 + 512);
    write_u32_be(&mut blob, key_type.len() as u32);
    blob.extend_from_slice(key_type);
    write_mpint(&mut blob, public_key.e());
    write_mpint(&mut blob, public_key.n());
    blob
}

fn build_openssh_private_key(
    public_key_blob: Vec<u8>,
    mut private_blob: Vec<u8>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    let mut cipher_name = OPENSSH_CIPHER_NONE;
    let mut kdf_name = OPENSSH_KDF_NONE;
    let mut kdf_options = Vec::new();

    if let Some(pass) = passphrase {
        if !pass.is_empty() {
            cipher_name = OPENSSH_CIPHER_AES256_CTR;
            kdf_name = OPENSSH_KDF_BCRYPT;
            let rounds = rounds.unwrap_or(16);
            let mut salt = [0u8; 16];
            getrandom(&mut salt).map_err(|_| JsValue::from_str("getrandom failed"))?;
            write_string(&mut kdf_options, &salt);
            write_u32_be(&mut kdf_options, rounds);

            private_blob = pad_private_blob(private_blob, 16);

            let key_iv = bcrypt_kdf(pass.as_bytes(), &salt, rounds, 48)?;
            let key = &key_iv[..32];
            let iv = &key_iv[32..];
            aes256_ctr_crypt(key, iv, &mut private_blob)?;
        }
    }

    if cipher_name == OPENSSH_CIPHER_NONE {
        private_blob = pad_private_blob(private_blob, 8);
    }

    let mut blob = Vec::with_capacity(OPENSSH_PRIVATE_MAGIC.len() + public_key_blob.len() + private_blob.len() + 64);
    blob.extend_from_slice(OPENSSH_PRIVATE_MAGIC);
    write_string(&mut blob, cipher_name.as_bytes());
    write_string(&mut blob, kdf_name.as_bytes());
    write_string(&mut blob, &kdf_options);
    write_u32_be(&mut blob, 1);
    write_string(&mut blob, &public_key_blob);
    write_string(&mut blob, &private_blob);

    Ok(openssh_private_key_pem_from_blob(&blob))
}

fn build_private_key_header() -> Result<[u8; 8], JsValue> {
    let mut check = [0u8; 8];
    getrandom(&mut check).map_err(|_| JsValue::from_str("getrandom failed"))?;
    Ok(check)
}

/// Builds OpenSSH private key (new format) for Ed25519.
#[wasm_bindgen]
pub fn openssh_ed25519_private_key(
    private_key: &[u8],
    comment: Option<String>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let signing_key = Ed25519SigningKey::from_bytes(&bytes);
    let public_key = signing_key.verifying_key().to_bytes();

    let public_key_blob = openssh_ed25519_public_blob(&public_key)?;

    let mut private_blob = Vec::with_capacity(128);
    let check = build_private_key_header()?;
    private_blob.extend_from_slice(&check[..4]);
    private_blob.extend_from_slice(&check[..4]);
    write_string(&mut private_blob, OPENSSH_ED25519.as_bytes());
    write_string(&mut private_blob, &public_key);
    let mut private_key64 = Vec::with_capacity(64);
    private_key64.extend_from_slice(&bytes);
    private_key64.extend_from_slice(&public_key);
    write_string(&mut private_blob, &private_key64);
    write_string(&mut private_blob, comment.unwrap_or_default().as_bytes());

    build_openssh_private_key(public_key_blob, private_blob, passphrase, rounds)
}

/// Builds OpenSSH private key (new format) for ECDSA P-256.
#[wasm_bindgen]
pub fn openssh_ecdsa_p256_private_key(
    private_key: &[u8],
    comment: Option<String>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    let public_key = ecdsa::ecdsa_p256_public_key(private_key)?;
    let public_key_blob = openssh_ecdsa_public_blob(&public_key, OPENSSH_ECDSA_P256, OPENSSH_CURVE_P256)?;

    let mut private_blob = Vec::with_capacity(192);
    let check = build_private_key_header()?;
    private_blob.extend_from_slice(&check[..4]);
    private_blob.extend_from_slice(&check[..4]);
    write_string(&mut private_blob, OPENSSH_ECDSA_P256.as_bytes());
    write_string(&mut private_blob, OPENSSH_CURVE_P256.as_bytes());
    write_string(&mut private_blob, &public_key);
    let d = BigUint::from_bytes_be(private_key);
    write_mpint(&mut private_blob, &d);
    write_string(&mut private_blob, comment.unwrap_or_default().as_bytes());

    build_openssh_private_key(public_key_blob, private_blob, passphrase, rounds)
}

/// Builds OpenSSH private key (new format) for ECDSA P-384.
#[wasm_bindgen]
pub fn openssh_ecdsa_p384_private_key(
    private_key: &[u8],
    comment: Option<String>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    let public_key = ecdsa::ecdsa_p384_public_key(private_key)?;
    let public_key_blob = openssh_ecdsa_public_blob(&public_key, OPENSSH_ECDSA_P384, OPENSSH_CURVE_P384)?;

    let mut private_blob = Vec::with_capacity(256);
    let check = build_private_key_header()?;
    private_blob.extend_from_slice(&check[..4]);
    private_blob.extend_from_slice(&check[..4]);
    write_string(&mut private_blob, OPENSSH_ECDSA_P384.as_bytes());
    write_string(&mut private_blob, OPENSSH_CURVE_P384.as_bytes());
    write_string(&mut private_blob, &public_key);
    let d = BigUint::from_bytes_be(private_key);
    write_mpint(&mut private_blob, &d);
    write_string(&mut private_blob, comment.unwrap_or_default().as_bytes());

    build_openssh_private_key(public_key_blob, private_blob, passphrase, rounds)
}

/// Builds OpenSSH private key (new format) for RSA from PKCS#8 DER.
#[wasm_bindgen]
pub fn openssh_rsa_private_key_from_pkcs8(
    private_key_der: &[u8],
    comment: Option<String>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    let private_key = RsaPrivateKey::from_pkcs8_der(private_key_der)
        .map_err(|_| JsValue::from_str("invalid private key"))?;
    let public_key = RsaPublicKey::from(&private_key);
    let public_key_blob = openssh_rsa_public_blob(&public_key);

    let p = private_key
        .primes()
        .get(0)
        .ok_or_else(|| JsValue::from_str("missing RSA prime"))?
        .clone();
    let q = private_key
        .primes()
        .get(1)
        .ok_or_else(|| JsValue::from_str("missing RSA prime"))?
        .clone();

    let iqmp = modinv(&q, &p).ok_or_else(|| JsValue::from_str("rsa iqmp failed"))?;

    let mut private_blob = Vec::with_capacity(512);
    let check = build_private_key_header()?;
    private_blob.extend_from_slice(&check[..4]);
    private_blob.extend_from_slice(&check[..4]);
    write_string(&mut private_blob, OPENSSH_RSA.as_bytes());
    write_mpint(&mut private_blob, public_key.n());
    write_mpint(&mut private_blob, public_key.e());
    write_mpint(&mut private_blob, private_key.d());
    write_mpint(&mut private_blob, &iqmp);
    write_mpint(&mut private_blob, &p);
    write_mpint(&mut private_blob, &q);
    write_string(&mut private_blob, comment.unwrap_or_default().as_bytes());

    build_openssh_private_key(public_key_blob, private_blob, passphrase, rounds)
}

/// Builds OpenSSH public key line for ECDSA P-384 from a 48-byte private key.
#[wasm_bindgen]
pub fn openssh_ecdsa_p384_public_key_from_private(private_key: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    let public_key = ecdsa::ecdsa_p384_public_key(private_key)?;
    openssh_ecdsa_p384_public_key(&public_key, comment)
}

/// Parses an OpenSSH Ed25519 public key line and returns the raw 32-byte public key.
#[wasm_bindgen]
pub fn openssh_ed25519_parse_public_key(line: &str) -> Result<Vec<u8>, JsValue> {
    let mut parts = line.split_whitespace();
    let key_type = parts.next().ok_or_else(|| JsValue::from_str("missing key type"))?;
    let b64 = parts.next().ok_or_else(|| JsValue::from_str("missing base64"))?;

    if key_type != OPENSSH_ED25519 {
        return Err(JsValue::from_str("unsupported key type"));
    }

    let blob = BASE64_STANDARD
        .decode(b64)
        .map_err(|_| JsValue::from_str("invalid base64"))?;

    if blob.len() < 4 {
        return Err(JsValue::from_str("invalid blob"));
    }

    let mut offset = 0usize;

    let key_type_len = read_u32_be(&blob, &mut offset)? as usize;
    if offset + key_type_len > blob.len() {
        return Err(JsValue::from_str("invalid key type length"));
    }
    let key_type_bytes = &blob[offset..offset + key_type_len];
    offset += key_type_len;

    if key_type_bytes != OPENSSH_ED25519.as_bytes() {
        return Err(JsValue::from_str("invalid key type in blob"));
    }

    let key_len = read_u32_be(&blob, &mut offset)? as usize;
    if key_len != 32 {
        return Err(JsValue::from_str("invalid key length"));
    }
    if offset + key_len > blob.len() {
        return Err(JsValue::from_str("invalid key data"));
    }

    Ok(blob[offset..offset + key_len].to_vec())
}

/// Parses an OpenSSH ECDSA P-256 public key line and returns the uncompressed public key.
#[wasm_bindgen]
pub fn openssh_ecdsa_p256_parse_public_key(line: &str) -> Result<Vec<u8>, JsValue> {
    parse_openssh_ecdsa_public_key(line, OPENSSH_ECDSA_P256, OPENSSH_CURVE_P256, 65)
}

/// Parses an OpenSSH ECDSA P-384 public key line and returns the uncompressed public key.
#[wasm_bindgen]
pub fn openssh_ecdsa_p384_parse_public_key(line: &str) -> Result<Vec<u8>, JsValue> {
    parse_openssh_ecdsa_public_key(line, OPENSSH_ECDSA_P384, OPENSSH_CURVE_P384, 97)
}

/// Parses an OpenSSH RSA public key line and returns SPKI DER.
#[wasm_bindgen]
pub fn openssh_rsa_parse_public_key(line: &str) -> Result<Vec<u8>, JsValue> {
    let mut parts = line.split_whitespace();
    let key_type = parts.next().ok_or_else(|| JsValue::from_str("missing key type"))?;
    let b64 = parts.next().ok_or_else(|| JsValue::from_str("missing base64"))?;

    if key_type != OPENSSH_RSA {
        return Err(JsValue::from_str("unsupported key type"));
    }

    let blob = BASE64_STANDARD
        .decode(b64)
        .map_err(|_| JsValue::from_str("invalid base64"))?;

    let mut offset = 0usize;
    let key_type_len = read_u32_be(&blob, &mut offset)? as usize;
    if offset + key_type_len > blob.len() {
        return Err(JsValue::from_str("invalid key type length"));
    }
    let key_type_bytes = &blob[offset..offset + key_type_len];
    offset += key_type_len;
    if key_type_bytes != OPENSSH_RSA.as_bytes() {
        return Err(JsValue::from_str("invalid key type in blob"));
    }

    let e = read_mpint(&blob, &mut offset)?;
    let n = read_mpint(&blob, &mut offset)?;

    let public_key = RsaPublicKey::new(n, e)
        .map_err(|_| JsValue::from_str("invalid RSA key"))?;
    public_key
        .to_public_key_der()
        .map(|der| der.as_bytes().to_vec())
        .map_err(|_| JsValue::from_str("encode failed"))
}

fn parse_openssh_ecdsa_public_key(
    line: &str,
    expected_key_type: &str,
    expected_curve: &str,
    expected_key_len: usize,
) -> Result<Vec<u8>, JsValue> {
    let mut parts = line.split_whitespace();
    let key_type = parts.next().ok_or_else(|| JsValue::from_str("missing key type"))?;
    let b64 = parts.next().ok_or_else(|| JsValue::from_str("missing base64"))?;

    if key_type != expected_key_type {
        return Err(JsValue::from_str("unsupported key type"));
    }

    let blob = BASE64_STANDARD
        .decode(b64)
        .map_err(|_| JsValue::from_str("invalid base64"))?;

    let mut offset = 0usize;
    let key_type_len = read_u32_be(&blob, &mut offset)? as usize;
    if offset + key_type_len > blob.len() {
        return Err(JsValue::from_str("invalid key type length"));
    }
    let key_type_bytes = &blob[offset..offset + key_type_len];
    offset += key_type_len;
    if key_type_bytes != expected_key_type.as_bytes() {
        return Err(JsValue::from_str("invalid key type in blob"));
    }

    let curve_len = read_u32_be(&blob, &mut offset)? as usize;
    if offset + curve_len > blob.len() {
        return Err(JsValue::from_str("invalid curve length"));
    }
    let curve = &blob[offset..offset + curve_len];
    offset += curve_len;
    if curve != expected_curve.as_bytes() {
        return Err(JsValue::from_str("invalid curve"));
    }

    let key_len = read_u32_be(&blob, &mut offset)? as usize;
    if key_len != expected_key_len {
        return Err(JsValue::from_str("invalid key length"));
    }
    if offset + key_len > blob.len() {
        return Err(JsValue::from_str("invalid key data"));
    }

    Ok(blob[offset..offset + key_len].to_vec())
}

/// Returns algorithm id for a supported OpenSSH public key line.
///
/// 1 = Ed25519, 2 = ECDSA P-256, 3 = ECDSA P-384
#[wasm_bindgen]
pub fn openssh_public_key_algorithm(line: &str) -> Result<u8, JsValue> {
    let key_type = line
        .split_whitespace()
        .next()
        .ok_or_else(|| JsValue::from_str("missing key type"))?;

    match key_type {
        OPENSSH_ED25519 => Ok(OPENSSH_ALG_ED25519),
        OPENSSH_ECDSA_P256 => Ok(OPENSSH_ALG_ECDSA_P256),
        OPENSSH_ECDSA_P384 => Ok(OPENSSH_ALG_ECDSA_P384),
        OPENSSH_RSA => Ok(OPENSSH_ALG_RSA),
        _ => Err(JsValue::from_str("unsupported key type")),
    }
}

/// Parses an OpenSSH public key line (Ed25519/P-256/P-384) and returns raw key bytes.
#[wasm_bindgen]
pub fn openssh_public_key_bytes(line: &str) -> Result<Vec<u8>, JsValue> {
    let alg = openssh_public_key_algorithm(line)?;
    match alg {
        OPENSSH_ALG_ED25519 => openssh_ed25519_parse_public_key(line),
        OPENSSH_ALG_ECDSA_P256 => openssh_ecdsa_p256_parse_public_key(line),
        OPENSSH_ALG_ECDSA_P384 => openssh_ecdsa_p384_parse_public_key(line),
        OPENSSH_ALG_RSA => openssh_rsa_parse_public_key(line),
        _ => Err(JsValue::from_str("unsupported key type")),
    }
}

/// Converts an OpenSSH public key line to SPKI DER (RSA/ECDSA only).
#[wasm_bindgen]
pub fn openssh_public_key_to_spki(line: &str) -> Result<Vec<u8>, JsValue> {
    let alg = openssh_public_key_algorithm(line)?;
    match alg {
        OPENSSH_ALG_RSA => openssh_rsa_parse_public_key(line),
        OPENSSH_ALG_ECDSA_P256 => {
            let key_bytes = openssh_ecdsa_p256_parse_public_key(line)?;
            let pk = P256PublicKey::from_sec1_bytes(&key_bytes)
                .map_err(|_| JsValue::from_str("invalid public key"))?;
            pk.to_public_key_der()
                .map(|der| der.as_bytes().to_vec())
                .map_err(|_| JsValue::from_str("encode failed"))
        }
        OPENSSH_ALG_ECDSA_P384 => {
            let key_bytes = openssh_ecdsa_p384_parse_public_key(line)?;
            let pk = P384PublicKey::from_sec1_bytes(&key_bytes)
                .map_err(|_| JsValue::from_str("invalid public key"))?;
            pk.to_public_key_der()
                .map(|der| der.as_bytes().to_vec())
                .map_err(|_| JsValue::from_str("encode failed"))
        }
        OPENSSH_ALG_ED25519 => Err(JsValue::from_str("ed25519 SPKI conversion not implemented yet")),
        _ => Err(JsValue::from_str("unsupported key type")),
    }
}

fn spki_to_pem(spki_der: &[u8]) -> String {
    let b64 = BASE64_STANDARD.encode(spki_der);
    let mut out = String::with_capacity(b64.len() + 64);
    out.push_str("-----BEGIN PUBLIC KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str("-----END PUBLIC KEY-----\n");
    out
}

fn pkcs8_to_pem(pkcs8_der: &[u8]) -> String {
    let b64 = BASE64_STANDARD.encode(pkcs8_der);
    let mut out = String::with_capacity(b64.len() + 64);
    out.push_str("-----BEGIN PRIVATE KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str("-----END PRIVATE KEY-----\n");
    out
}

fn pkcs8_der_from_pem(pem: &str, passphrase: Option<String>) -> Result<Vec<u8>, JsValue> {
    let (label, doc) = SecretDocument::from_pem(pem)
        .map_err(|_| JsValue::from_str("invalid PEM"))?;

    if label == "PRIVATE KEY" {
        return Ok(doc.as_bytes().to_vec());
    }

    if label == "ENCRYPTED PRIVATE KEY" {
        let passphrase = passphrase.ok_or_else(|| JsValue::from_str("passphrase required"))?;
        let encrypted = EncryptedPrivateKeyInfo::try_from(doc.as_bytes())
            .map_err(|_| JsValue::from_str("invalid encrypted PKCS#8"))?;
        let decrypted = encrypted
            .decrypt(passphrase)
            .map_err(|_| JsValue::from_str("decrypt failed"))?;
        return Ok(decrypted.as_bytes().to_vec());
    }

    Err(JsValue::from_str("unsupported PEM label"))
}

fn pem_to_spki(pem: &str) -> Result<Vec<u8>, JsValue> {
    let mut b64 = String::new();
    for line in pem.lines() {
        if line.starts_with("-----") {
            continue;
        }
        b64.push_str(line.trim());
    }

    if b64.is_empty() {
        return Err(JsValue::from_str("invalid PEM"));
    }

    BASE64_STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| JsValue::from_str("invalid base64"))
}

/// Converts an OpenSSH public key line to SPKI PEM (RSA/ECDSA only).
#[wasm_bindgen]
pub fn openssh_public_key_to_spki_pem(line: &str) -> Result<String, JsValue> {
    let spki = openssh_public_key_to_spki(line)?;
    Ok(spki_to_pem(&spki))
}

/// Converts SPKI PEM to OpenSSH public key line (RSA/ECDSA only).
#[wasm_bindgen]
pub fn openssh_public_key_from_spki_pem(pem: &str, comment: Option<String>) -> Result<String, JsValue> {
    let spki = pem_to_spki(pem)?;
    openssh_public_key_from_spki_der(&spki, comment)
}

fn openssh_public_key_from_spki_der(spki_der: &[u8], comment: Option<String>) -> Result<String, JsValue> {
    if let Ok(rsa_key) = RsaPublicKey::from_public_key_der(spki_der) {
        return openssh_rsa_public_key_from_spki(rsa_key.to_public_key_der().map_err(|_| JsValue::from_str("encode failed"))?.as_bytes(), comment);
    }

    if let Ok(p256_key) = P256PublicKey::from_public_key_der(spki_der) {
        let pub_bytes = p256_key.to_encoded_point(false).as_bytes().to_vec();
        return openssh_ecdsa_p256_public_key(&pub_bytes, comment);
    }

    if let Ok(p384_key) = P384PublicKey::from_public_key_der(spki_der) {
        let pub_bytes = p384_key.to_encoded_point(false).as_bytes().to_vec();
        return openssh_ecdsa_p384_public_key(&pub_bytes, comment);
    }

    Err(JsValue::from_str("unsupported SPKI"))
}

struct ParsedOpenSshPrivateKey {
    algorithm: u8,
    public_key: Vec<u8>,
    private_key: Vec<u8>,
    comment: String,
}

fn parse_openssh_private_key(pem: &str, passphrase: Option<String>) -> Result<ParsedOpenSshPrivateKey, JsValue> {
    let blob = openssh_private_key_blob_from_pem(pem)?;
    if blob.len() < OPENSSH_PRIVATE_MAGIC.len() || &blob[..OPENSSH_PRIVATE_MAGIC.len()] != OPENSSH_PRIVATE_MAGIC {
        return Err(JsValue::from_str("invalid OpenSSH private key"));
    }

    let mut pos = OPENSSH_PRIVATE_MAGIC.len();
    let cipher_name = read_string_as_str(&blob, &mut pos)?;
    let kdf_name = read_string_as_str(&blob, &mut pos)?;
    let kdf_options = read_string(&blob, &mut pos)?;
    let nkeys = read_u32_be(&blob, &mut pos)?;

    if nkeys != 1 {
        return Err(JsValue::from_str("only single-key files are supported"));
    }

    let _public_key_blob = read_string(&blob, &mut pos)?;
    let mut private_blob = read_string(&blob, &mut pos)?;

    if cipher_name == OPENSSH_CIPHER_NONE {
        if kdf_name != OPENSSH_KDF_NONE {
            return Err(JsValue::from_str("invalid kdf for none cipher"));
        }
    } else if cipher_name == OPENSSH_CIPHER_AES256_CTR {
        if kdf_name != OPENSSH_KDF_BCRYPT {
            return Err(JsValue::from_str("unsupported kdf"));
        }
        let passphrase = passphrase.unwrap_or_default();
        if passphrase.is_empty() {
            return Err(JsValue::from_str("passphrase required"));
        }
        let mut kdf_pos = 0usize;
        let salt = read_string(&kdf_options, &mut kdf_pos)?;
        let rounds = read_u32_be(&kdf_options, &mut kdf_pos)?;
        let key_iv = bcrypt_kdf(passphrase.as_bytes(), &salt, rounds, 48)?;
        let key = &key_iv[..32];
        let iv = &key_iv[32..];
        aes256_ctr_crypt(key, iv, &mut private_blob)?;
    } else {
        return Err(JsValue::from_str("unsupported cipher"));
    }

    let mut priv_pos = 0usize;
    let check1 = read_u32_be(&private_blob, &mut priv_pos)?;
    let check2 = read_u32_be(&private_blob, &mut priv_pos)?;
    if check1 != check2 {
        return Err(JsValue::from_str("invalid passphrase or corrupted key"));
    }

    let key_type = read_string_as_str(&private_blob, &mut priv_pos)?;

    match key_type.as_str() {
        OPENSSH_ED25519 => {
            let public_key = read_string(&private_blob, &mut priv_pos)?;
            let private_key64 = read_string(&private_blob, &mut priv_pos)?;
            let comment = read_string_as_str(&private_blob, &mut priv_pos)?;
            if public_key.len() != 32 || private_key64.len() != 64 {
                return Err(JsValue::from_str("invalid ed25519 key"));
            }
            Ok(ParsedOpenSshPrivateKey {
                algorithm: OPENSSH_ALG_ED25519,
                public_key,
                private_key: private_key64[..32].to_vec(),
                comment,
            })
        }
        OPENSSH_ECDSA_P256 => {
            let curve = read_string_as_str(&private_blob, &mut priv_pos)?;
            if curve != OPENSSH_CURVE_P256 {
                return Err(JsValue::from_str("invalid curve"));
            }
            let public_key = read_string(&private_blob, &mut priv_pos)?;
            let d = read_mpint(&private_blob, &mut priv_pos)?;
            let comment = read_string_as_str(&private_blob, &mut priv_pos)?;
            let mut d_bytes = d.to_bytes_be();
            if d_bytes.len() > 32 {
                return Err(JsValue::from_str("invalid private key length"));
            }
            if d_bytes.len() < 32 {
                let mut padded = vec![0u8; 32 - d_bytes.len()];
                padded.append(&mut d_bytes);
                d_bytes = padded;
            }
            Ok(ParsedOpenSshPrivateKey {
                algorithm: OPENSSH_ALG_ECDSA_P256,
                public_key,
                private_key: d_bytes,
                comment,
            })
        }
        OPENSSH_ECDSA_P384 => {
            let curve = read_string_as_str(&private_blob, &mut priv_pos)?;
            if curve != OPENSSH_CURVE_P384 {
                return Err(JsValue::from_str("invalid curve"));
            }
            let public_key = read_string(&private_blob, &mut priv_pos)?;
            let d = read_mpint(&private_blob, &mut priv_pos)?;
            let comment = read_string_as_str(&private_blob, &mut priv_pos)?;
            let mut d_bytes = d.to_bytes_be();
            if d_bytes.len() > 48 {
                return Err(JsValue::from_str("invalid private key length"));
            }
            if d_bytes.len() < 48 {
                let mut padded = vec![0u8; 48 - d_bytes.len()];
                padded.append(&mut d_bytes);
                d_bytes = padded;
            }
            Ok(ParsedOpenSshPrivateKey {
                algorithm: OPENSSH_ALG_ECDSA_P384,
                public_key,
                private_key: d_bytes,
                comment,
            })
        }
        OPENSSH_RSA => {
            let n = read_mpint(&private_blob, &mut priv_pos)?;
            let e = read_mpint(&private_blob, &mut priv_pos)?;
            let d = read_mpint(&private_blob, &mut priv_pos)?;
            let _iqmp = read_mpint(&private_blob, &mut priv_pos)?;
            let p = read_mpint(&private_blob, &mut priv_pos)?;
            let q = read_mpint(&private_blob, &mut priv_pos)?;
            let comment = read_string_as_str(&private_blob, &mut priv_pos)?;

            let private_key = RsaPrivateKey::from_components(n.clone(), e.clone(), d, vec![p, q])
                .map_err(|_| JsValue::from_str("invalid RSA key"))?;
            let public_key = RsaPublicKey::new(n, e)
                .map_err(|_| JsValue::from_str("invalid RSA key"))?
                .to_public_key_der()
                .map_err(|_| JsValue::from_str("encode failed"))?
                .as_bytes()
                .to_vec();

            let pkcs8 = private_key
                .to_pkcs8_der()
                .map_err(|_| JsValue::from_str("encode failed"))?
                .as_bytes()
                .to_vec();

            Ok(ParsedOpenSshPrivateKey {
                algorithm: OPENSSH_ALG_RSA,
                public_key,
                private_key: pkcs8,
                comment,
            })
        }
        _ => Err(JsValue::from_str("unsupported key type")),
    }
}

/// Returns algorithm id for an OpenSSH private key (new format).
#[wasm_bindgen]
pub fn openssh_private_key_algorithm(pem: &str, passphrase: Option<String>) -> Result<u8, JsValue> {
    Ok(parse_openssh_private_key(pem, passphrase)?.algorithm)
}

/// Returns public key bytes from an OpenSSH private key (new format).
#[wasm_bindgen]
pub fn openssh_private_key_public_key_bytes(pem: &str, passphrase: Option<String>) -> Result<Vec<u8>, JsValue> {
    Ok(parse_openssh_private_key(pem, passphrase)?.public_key)
}

/// Returns private key bytes from an OpenSSH private key (new format).
/// Ed25519/ECDSA return raw private key bytes. RSA returns PKCS#8 DER.
#[wasm_bindgen]
pub fn openssh_private_key_private_key_bytes(pem: &str, passphrase: Option<String>) -> Result<Vec<u8>, JsValue> {
    Ok(parse_openssh_private_key(pem, passphrase)?.private_key)
}

/// Returns comment from an OpenSSH private key (new format).
#[wasm_bindgen]
pub fn openssh_private_key_comment(pem: &str, passphrase: Option<String>) -> Result<String, JsValue> {
    Ok(parse_openssh_private_key(pem, passphrase)?.comment)
}

/// Returns warnings for OpenSSH public key (RSA size, ssh-rsa deprecation).
#[wasm_bindgen]
pub fn openssh_public_key_warnings(line: &str) -> Result<Vec<String>, JsValue> {
    let mut warnings = Vec::new();
    let alg = openssh_public_key_algorithm(line)?;
    if alg == OPENSSH_ALG_RSA {
        warnings.push("ssh-rsa uses SHA-1".to_string());
        let mut parts = line.split_whitespace();
        let _key_type = parts.next().ok_or_else(|| JsValue::from_str("missing key type"))?;
        let b64 = parts.next().ok_or_else(|| JsValue::from_str("missing base64"))?;
        let blob = BASE64_STANDARD
            .decode(b64)
            .map_err(|_| JsValue::from_str("invalid base64"))?;
        let mut offset = 0usize;
        let key_type_len = read_u32_be(&blob, &mut offset)? as usize;
        if offset + key_type_len > blob.len() {
            return Err(JsValue::from_str("invalid key type length"));
        }
        offset += key_type_len;
        let e = read_mpint(&blob, &mut offset)?;
        let n = read_mpint(&blob, &mut offset)?;
        let public_key = RsaPublicKey::new(n, e)
            .map_err(|_| JsValue::from_str("invalid RSA key"))?;
        let bits = public_key.n().bits();
        if bits < 3072 {
            warnings.push("RSA key size < 3072".to_string());
        }
    }
    Ok(warnings)
}

/// Returns warnings for OpenSSH private key (RSA size, ssh-rsa deprecation).
#[wasm_bindgen]
pub fn openssh_private_key_warnings(pem: &str, passphrase: Option<String>) -> Result<Vec<String>, JsValue> {
    let mut warnings = Vec::new();
    let parsed = parse_openssh_private_key(pem, passphrase)?;
    if parsed.algorithm == OPENSSH_ALG_RSA {
        warnings.push("ssh-rsa uses SHA-1".to_string());
        let private_key = RsaPrivateKey::from_pkcs8_der(&parsed.private_key)
            .map_err(|_| JsValue::from_str("invalid private key"))?;
        let bits = private_key.n().bits();
        if bits < 3072 {
            warnings.push("RSA key size < 3072".to_string());
        }
    }
    Ok(warnings)
}

/// Converts an OpenSSH private key (new format) to OpenSSH public key line.
#[wasm_bindgen]
pub fn openssh_private_key_to_public_key_line(
    pem: &str,
    passphrase: Option<String>,
    comment_override: Option<String>,
) -> Result<String, JsValue> {
    let parsed = parse_openssh_private_key(pem, passphrase)?;
    let comment = comment_override.unwrap_or(parsed.comment);

    match parsed.algorithm {
        OPENSSH_ALG_ED25519 => openssh_ed25519_public_key(&parsed.public_key, Some(comment)),
        OPENSSH_ALG_ECDSA_P256 => openssh_ecdsa_p256_public_key(&parsed.public_key, Some(comment)),
        OPENSSH_ALG_ECDSA_P384 => openssh_ecdsa_p384_public_key(&parsed.public_key, Some(comment)),
        OPENSSH_ALG_RSA => openssh_rsa_public_key_from_spki(&parsed.public_key, Some(comment)),
        _ => Err(JsValue::from_str("unsupported key type")),
    }
}

/// Converts an OpenSSH private key (new format) to SPKI DER (RSA/ECDSA only).
#[wasm_bindgen]
pub fn openssh_private_key_to_spki(pem: &str, passphrase: Option<String>) -> Result<Vec<u8>, JsValue> {
    let parsed = parse_openssh_private_key(pem, passphrase)?;

    match parsed.algorithm {
        OPENSSH_ALG_RSA => Ok(parsed.public_key),
        OPENSSH_ALG_ECDSA_P256 => {
            let pk = P256PublicKey::from_sec1_bytes(&parsed.public_key)
                .map_err(|_| JsValue::from_str("invalid public key"))?;
            pk.to_public_key_der()
                .map(|der| der.as_bytes().to_vec())
                .map_err(|_| JsValue::from_str("encode failed"))
        }
        OPENSSH_ALG_ECDSA_P384 => {
            let pk = P384PublicKey::from_sec1_bytes(&parsed.public_key)
                .map_err(|_| JsValue::from_str("invalid public key"))?;
            pk.to_public_key_der()
                .map(|der| der.as_bytes().to_vec())
                .map_err(|_| JsValue::from_str("encode failed"))
        }
        OPENSSH_ALG_ED25519 => Err(JsValue::from_str("ed25519 SPKI conversion not implemented yet")),
        _ => Err(JsValue::from_str("unsupported key type")),
    }
}

/// Converts an OpenSSH private key (new format) to PKCS#8 DER.
#[wasm_bindgen]
pub fn openssh_private_key_to_pkcs8(pem: &str, passphrase: Option<String>) -> Result<Vec<u8>, JsValue> {
    let parsed = parse_openssh_private_key(pem, passphrase)?;

    match parsed.algorithm {
        OPENSSH_ALG_RSA => Ok(parsed.private_key),
        OPENSSH_ALG_ED25519 => {
            let bytes: [u8; 32] = parsed
                .private_key
                .try_into()
                .map_err(|_| JsValue::from_str("invalid ed25519 key"))?;
            let signing_key = Ed25519SigningKey::from_bytes(&bytes);
            signing_key
                .to_pkcs8_der()
                .map(|der| der.as_bytes().to_vec())
                .map_err(|_| JsValue::from_str("encode failed"))
        }
        OPENSSH_ALG_ECDSA_P256 => {
            let bytes: [u8; 32] = parsed
                .private_key
                .try_into()
                .map_err(|_| JsValue::from_str("invalid private key length"))?;
            let secret_key = P256SecretKey::from_bytes(&bytes.into())
                .map_err(|_| JsValue::from_str("invalid private key"))?;
            secret_key
                .to_pkcs8_der()
                .map(|der| der.as_bytes().to_vec())
                .map_err(|_| JsValue::from_str("encode failed"))
        }
        OPENSSH_ALG_ECDSA_P384 => {
            let bytes: [u8; 48] = parsed
                .private_key
                .try_into()
                .map_err(|_| JsValue::from_str("invalid private key length"))?;
            let secret_key = P384SecretKey::from_bytes(&bytes.into())
                .map_err(|_| JsValue::from_str("invalid private key"))?;
            secret_key
                .to_pkcs8_der()
                .map(|der| der.as_bytes().to_vec())
                .map_err(|_| JsValue::from_str("encode failed"))
        }
        _ => Err(JsValue::from_str("unsupported key type")),
    }
}

/// Converts an OpenSSH private key (new format) to PKCS#8 PEM.
#[wasm_bindgen]
pub fn openssh_private_key_to_pkcs8_pem(pem: &str, passphrase: Option<String>) -> Result<String, JsValue> {
    let der = openssh_private_key_to_pkcs8(pem, passphrase)?;
    Ok(pkcs8_to_pem(&der))
}

fn openssh_private_key_from_pkcs8_der(
    private_key_der: &[u8],
    comment: Option<String>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    if RsaPrivateKey::from_pkcs8_der(private_key_der).is_ok() {
        return openssh_rsa_private_key_from_pkcs8(private_key_der, comment, passphrase, rounds);
    }

    if let Ok(secret_key) = P256SecretKey::from_pkcs8_der(private_key_der) {
        return openssh_ecdsa_p256_private_key(
            secret_key.to_bytes().as_slice(),
            comment,
            passphrase,
            rounds,
        );
    }

    if let Ok(secret_key) = P384SecretKey::from_pkcs8_der(private_key_der) {
        return openssh_ecdsa_p384_private_key(
            secret_key.to_bytes().as_slice(),
            comment,
            passphrase,
            rounds,
        );
    }

    if let Ok(signing_key) = Ed25519SigningKey::from_pkcs8_der(private_key_der) {
        return openssh_ed25519_private_key(
            signing_key.to_bytes().as_slice(),
            comment,
            passphrase,
            rounds,
        );
    }

    Err(JsValue::from_str("unsupported PKCS#8 key"))
}

/// Converts PKCS#8 DER to OpenSSH private key (new format).
#[wasm_bindgen]
pub fn openssh_private_key_from_pkcs8(
    private_key_der: &[u8],
    comment: Option<String>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    openssh_private_key_from_pkcs8_der(private_key_der, comment, passphrase, rounds)
}

/// Converts PKCS#8 PEM (encrypted or not) to OpenSSH private key (new format).
#[wasm_bindgen]
pub fn openssh_private_key_from_pkcs8_pem(
    pem: &str,
    pkcs8_passphrase: Option<String>,
    comment: Option<String>,
    passphrase: Option<String>,
    rounds: Option<u32>,
) -> Result<String, JsValue> {
    let der = pkcs8_der_from_pem(pem, pkcs8_passphrase)?;
    openssh_private_key_from_pkcs8_der(&der, comment, passphrase, rounds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openssh_ed25519_public_key_format() {
        let public_key = [3u8; 32];
        let line = openssh_ed25519_public_key(&public_key, Some("test@local".to_string())).expect("openssh");
        assert!(line.starts_with("ssh-ed25519 "));

        let parts: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(parts.len(), 3);

        let blob = BASE64_STANDARD.decode(parts[1]).expect("b64");
        assert!(blob.len() >= 4 + OPENSSH_ED25519.len() + 4 + 32);
    }

    #[test]
    fn openssh_ed25519_parse_public_key_roundtrip() {
        let public_key = [9u8; 32];
        let line = openssh_ed25519_public_key(&public_key, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_ed25519_parse_public_key(&line).expect("parse");
        assert_eq!(parsed, public_key);
    }

    #[test]
    fn openssh_ed25519_public_key_from_private_roundtrip() {
        let private_key = [7u8; 32];
        let line = openssh_ed25519_public_key_from_private(&private_key, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_ed25519_parse_public_key(&line).expect("parse");
        assert_eq!(parsed.len(), 32);
    }

    #[test]
    fn openssh_ecdsa_p256_roundtrip() {
        let public_key = [4u8; 65];
        let line = openssh_ecdsa_p256_public_key(&public_key, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_ecdsa_p256_parse_public_key(&line).expect("parse");
        assert_eq!(parsed, public_key);
    }

    #[test]
    fn openssh_ecdsa_p256_public_key_from_private_roundtrip() {
        let private_key = [8u8; 32];
        let line = openssh_ecdsa_p256_public_key_from_private(&private_key, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_ecdsa_p256_parse_public_key(&line).expect("parse");
        assert_eq!(parsed.len(), 65);
    }

    #[test]
    fn openssh_ecdsa_p384_roundtrip() {
        let public_key = [5u8; 97];
        let line = openssh_ecdsa_p384_public_key(&public_key, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_ecdsa_p384_parse_public_key(&line).expect("parse");
        assert_eq!(parsed, public_key);
    }

    #[test]
    fn openssh_ecdsa_p384_public_key_from_private_roundtrip() {
        let private_key = [9u8; 48];
        let line = openssh_ecdsa_p384_public_key_from_private(&private_key, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_ecdsa_p384_parse_public_key(&line).expect("parse");
        assert_eq!(parsed.len(), 97);
    }

    #[test]
    fn openssh_rsa_roundtrip() {
        let private_key = crate::rsa_pss::rsa_generate_private_key_pkcs8(2048).expect("key");
        let spki = crate::rsa_pss::rsa_public_key_from_private_pkcs8(&private_key).expect("spki");

        let line = openssh_rsa_public_key_from_spki(&spki, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_rsa_parse_public_key(&line).expect("parse");
        assert_eq!(parsed, spki);
    }

    #[test]
    fn openssh_rsa_from_private_roundtrip() {
        let private_key = crate::rsa_pss::rsa_generate_private_key_pkcs8(2048).expect("key");
        let line = openssh_rsa_public_key_from_private_pkcs8(&private_key, Some("test@local".to_string())).expect("openssh");
        let parsed = openssh_rsa_parse_public_key(&line).expect("parse");
        assert!(crate::rsa_pss::rsa_validate_public_key_spki(&parsed).unwrap());
    }

    #[test]
    fn openssh_public_key_algorithm_detects() {
        let ed = openssh_ed25519_public_key(&[1u8; 32], None).expect("ed");
        let p256 = openssh_ecdsa_p256_public_key(&[4u8; 65], None).expect("p256");
        let p384 = openssh_ecdsa_p384_public_key(&[4u8; 97], None).expect("p384");
        let rsa = {
            let private_key = crate::rsa_pss::rsa_generate_private_key_pkcs8(2048).expect("key");
            let spki = crate::rsa_pss::rsa_public_key_from_private_pkcs8(&private_key).expect("spki");
            openssh_rsa_public_key_from_spki(&spki, None).expect("rsa")
        };

        assert_eq!(openssh_public_key_algorithm(&ed).unwrap(), OPENSSH_ALG_ED25519);
        assert_eq!(openssh_public_key_algorithm(&p256).unwrap(), OPENSSH_ALG_ECDSA_P256);
        assert_eq!(openssh_public_key_algorithm(&p384).unwrap(), OPENSSH_ALG_ECDSA_P384);
        assert_eq!(openssh_public_key_algorithm(&rsa).unwrap(), OPENSSH_ALG_RSA);
    }

    #[test]
    fn openssh_public_key_bytes_parses() {
        let ed = openssh_ed25519_public_key(&[1u8; 32], None).expect("ed");
        let bytes = openssh_public_key_bytes(&ed).expect("bytes");
        assert_eq!(bytes.len(), 32);
    }

    #[test]
    fn openssh_public_key_to_spki_roundtrip() {
        let keypair = crate::ecdsa::ecdsa_p256_generate_keypair().expect("keypair");
        let public_key = &keypair[32..];
        let line = openssh_ecdsa_p256_public_key(public_key, None).expect("line");
        let spki = openssh_public_key_to_spki(&line).expect("spki");
        assert!(!spki.is_empty());
    }

    #[test]
    fn openssh_public_key_to_spki_pem_roundtrip() {
        let keypair = crate::ecdsa::ecdsa_p256_generate_keypair().expect("keypair");
        let public_key = &keypair[32..];
        let line = openssh_ecdsa_p256_public_key(public_key, None).expect("line");
        let pem = openssh_public_key_to_spki_pem(&line).expect("pem");
        assert!(pem.contains("BEGIN PUBLIC KEY"));
    }

    #[test]
    fn openssh_public_key_from_spki_pem_roundtrip() {
        let keypair = crate::ecdsa::ecdsa_p256_generate_keypair().expect("keypair");
        let public_key = &keypair[32..];
        let line = openssh_ecdsa_p256_public_key(public_key, None).expect("line");
        let pem = openssh_public_key_to_spki_pem(&line).expect("pem");
        let back = openssh_public_key_from_spki_pem(&pem, None).expect("back");
        let parsed = openssh_ecdsa_p256_parse_public_key(&back).expect("parse");
        assert_eq!(parsed, public_key);
    }

    #[test]
    fn openssh_ed25519_private_key_roundtrip_plain() {
        let private_key = [7u8; 32];
        let pem = openssh_ed25519_private_key(&private_key, Some("test@local".to_string()), None, None)
            .expect("pem");
        let parsed = openssh_private_key_private_key_bytes(&pem, None).expect("parse");
        assert_eq!(parsed, private_key);
    }

    #[test]
    fn openssh_ed25519_private_key_roundtrip_encrypted() {
        let private_key = [9u8; 32];
        let pem = openssh_ed25519_private_key(
            &private_key,
            Some("test@local".to_string()),
            Some("passphrase".to_string()),
            Some(4),
        )
        .expect("pem");
        let parsed = openssh_private_key_private_key_bytes(&pem, Some("passphrase".to_string())).expect("parse");
        assert_eq!(parsed, private_key);
    }

    #[test]
    fn openssh_ecdsa_p256_private_key_roundtrip_plain() {
        let keypair = crate::ecdsa::ecdsa_p256_generate_keypair().expect("keypair");
        let private_key = &keypair[..32];
        let pem = openssh_ecdsa_p256_private_key(private_key, None, None, None).expect("pem");
        let parsed = openssh_private_key_private_key_bytes(&pem, None).expect("parse");
        assert_eq!(parsed, private_key);
    }

    #[test]
    fn openssh_rsa_private_key_roundtrip_plain() {
        let private_key = crate::rsa_pss::rsa_generate_private_key_pkcs8(2048).expect("key");
        let pem = openssh_rsa_private_key_from_pkcs8(&private_key, None, None, None).expect("pem");
        let parsed = openssh_private_key_private_key_bytes(&pem, None).expect("parse");
        let parsed_key = RsaPrivateKey::from_pkcs8_der(&parsed).expect("pkcs8");
        assert!(parsed_key.n().bits() >= 2048);
    }

    #[test]
    fn openssh_private_key_to_pkcs8_ed25519() {
        let private_key = [7u8; 32];
        let pem = openssh_ed25519_private_key(&private_key, None, None, None).expect("pem");
        let pkcs8 = openssh_private_key_to_pkcs8(&pem, None).expect("pkcs8");
        assert!(!pkcs8.is_empty());
    }

    #[test]
    fn openssh_private_key_to_pkcs8_ecdsa_p256() {
        let keypair = crate::ecdsa::ecdsa_p256_generate_keypair().expect("keypair");
        let private_key = &keypair[..32];
        let pem = openssh_ecdsa_p256_private_key(private_key, None, None, None).expect("pem");
        let pkcs8 = openssh_private_key_to_pkcs8(&pem, None).expect("pkcs8");
        assert!(!pkcs8.is_empty());
    }

    #[test]
    fn pkcs8_pem_to_openssh_private_key_roundtrip_ed25519() {
        let private_key = [7u8; 32];
        let signing_key = Ed25519SigningKey::from_bytes(&private_key);
        let pkcs8 = signing_key.to_pkcs8_der().expect("pkcs8");
        let pem = pkcs8_to_pem(pkcs8.as_bytes());

        let openssh = openssh_private_key_from_pkcs8_pem(&pem, None, None, None, None).expect("openssh");
        let parsed = openssh_private_key_private_key_bytes(&openssh, None).expect("parse");
        assert_eq!(parsed, private_key);
    }
}
