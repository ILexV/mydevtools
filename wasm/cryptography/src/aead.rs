use wasm_bindgen::prelude::*;

use aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use chacha20poly1305::{ChaCha20Poly1305, XChaCha20Poly1305};

use crate::kdf;

const AEAD_MAGIC: [u8; 4] = *b"MDT1";
const AEAD_VERSION: u8 = 1;
const AEAD_ALGO_AES256_GCM: u8 = 1;
const AEAD_ALGO_CHACHA20_POLY1305: u8 = 2;
const AEAD_ALGO_XCHACHA20_POLY1305: u8 = 3;
const AEAD_TAG_LEN: u16 = 16;

const AEAD_STREAM_MAGIC: [u8; 4] = *b"MDT2";
const AEAD_STREAM_VERSION: u8 = 1;
/// MDT3: same header layout as MDT2, but every chunk authenticates
/// `header ‖ final_flag` as AAD, so truncation at a chunk boundary, dropped
/// tails, appended chunks and header edits are detected.
const AEAD_STREAM3_MAGIC: [u8; 4] = *b"MDT3";

const KDF_ARGON2ID: u8 = 1;
const KDF_PBKDF2_SHA512: u8 = 2;

fn pack_aead_header(algorithm: u8, salt: &[u8], nonce: &[u8], tag_len: u16) -> Result<Vec<u8>, JsValue> {
    if salt.len() > u16::MAX as usize || nonce.len() > u16::MAX as usize {
        return Err(JsValue::from_str("salt/nonce too long"));
    }

    let mut header = Vec::with_capacity(12 + salt.len() + nonce.len());
    header.extend_from_slice(&AEAD_MAGIC);
    header.push(AEAD_VERSION);
    header.push(algorithm);
    header.extend_from_slice(&(salt.len() as u16).to_le_bytes());
    header.extend_from_slice(&(nonce.len() as u16).to_le_bytes());
    header.extend_from_slice(&tag_len.to_le_bytes());
    header.extend_from_slice(salt);
    header.extend_from_slice(nonce);
    Ok(header)
}

fn parse_aead_header(data: &[u8]) -> Result<(u8, u16, u16, u16, usize), JsValue> {
    if data.len() < 12 {
        return Err(JsValue::from_str("data too короткие для header"));
    }
    if data[0..4] != AEAD_MAGIC {
        return Err(JsValue::from_str("invalid magic"));
    }
    if data[4] != AEAD_VERSION {
        return Err(JsValue::from_str("unsupported version"));
    }

    let algorithm = data[5];
    let salt_len = u16::from_le_bytes([data[6], data[7]]);
    let nonce_len = u16::from_le_bytes([data[8], data[9]]);
    let tag_len = u16::from_le_bytes([data[10], data[11]]);

    let header_len = 12usize + salt_len as usize + nonce_len as usize;
    if data.len() < header_len {
        return Err(JsValue::from_str("data too короткие для salt/nonce"));
    }

    Ok((algorithm, salt_len, nonce_len, tag_len, header_len))
}

fn pack_aead_stream_header(
    algorithm: u8,
    kdf_id: u8,
    salt: &[u8],
    nonce_prefix: &[u8],
    chunk_size: u32,
) -> Result<Vec<u8>, JsValue> {
    if salt.len() > u16::MAX as usize || nonce_prefix.len() > u16::MAX as usize {
        return Err(JsValue::from_str("salt/nonce too long"));
    }

    let mut header = Vec::with_capacity(18 + salt.len() + nonce_prefix.len());
    header.extend_from_slice(&AEAD_STREAM_MAGIC);
    header.push(AEAD_STREAM_VERSION);
    header.push(algorithm);
    header.push(kdf_id);
    header.extend_from_slice(&(salt.len() as u16).to_le_bytes());
    header.extend_from_slice(&(nonce_prefix.len() as u16).to_le_bytes());
    header.extend_from_slice(&chunk_size.to_le_bytes());
    header.extend_from_slice(salt);
    header.extend_from_slice(nonce_prefix);
    Ok(header)
}

fn parse_aead_stream_header(data: &[u8]) -> Result<(u8, u8, u16, u16, u32, usize), JsValue> {
    let h = parse_stream_header_core(data).map_err(|e| JsValue::from_str(e.message()))?;
    Ok((h.algorithm, h.kdf_id, h.salt_len, h.nonce_len, h.chunk_size, h.header_len))
}

/// Failure of the streaming container core. Kept free of `JsValue` so native
/// (non-wasm) tests can assert error paths; wasm exports map it to a string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamError {
    /// Fewer bytes than a fixed header / salt / nonce prefix needs.
    ShortHeader,
    /// Not an MDT2/MDT3 container.
    BadMagic,
    UnsupportedVersion,
    /// MDT3 header field out of range (algorithm, KDF, prefix length, chunk size).
    BadHeader,
    UnknownAlgorithm,
    BadKey,
    /// AEAD tag mismatch: wrong password/key, tampered, reordered, truncated or extended data.
    Auth,
    /// MDT3 container without its final chunk (e.g. cut right after the header).
    Truncated,
}

impl StreamError {
    pub fn message(self) -> &'static str {
        match self {
            StreamError::ShortHeader => "data too short for header",
            StreamError::BadMagic => "invalid magic",
            StreamError::UnsupportedVersion => "unsupported version",
            StreamError::BadHeader => "invalid header",
            StreamError::UnknownAlgorithm => "unknown algorithm",
            StreamError::BadKey => "key must be 32 bytes",
            StreamError::Auth => "decrypt failed",
            StreamError::Truncated => "truncated container",
        }
    }
}

/// Parsed MDT2/MDT3 stream header. `format` is 2 (legacy, no final-chunk
/// authentication) or 3 (header + final flag bound into every chunk's AAD).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamHeader {
    pub format: u8,
    pub algorithm: u8,
    pub kdf_id: u8,
    pub salt_len: u16,
    pub nonce_len: u16,
    pub chunk_size: u32,
    pub header_len: usize,
}

/// Largest chunk size an MDT3 header may declare (the site writes 1 MiB).
pub const AEAD_STREAM3_MAX_CHUNK: u32 = 64 * 1024 * 1024;

/// Parses the fixed MDT2/MDT3 header layout (identical for both formats):
/// magic(4) ‖ version u8 = 1 ‖ algorithm u8 ‖ kdf u8 ‖ salt_len u16le ‖
/// nonce_prefix_len u16le ‖ chunk_size u32le ‖ salt ‖ nonce_prefix.
/// MDT2 is accepted as before (no field checks); MDT3 is validated strictly.
pub fn parse_stream_header_core(data: &[u8]) -> Result<StreamHeader, StreamError> {
    if data.len() < 15 {
        return Err(StreamError::ShortHeader);
    }
    let format = if data[0..4] == AEAD_STREAM_MAGIC {
        2
    } else if data[0..4] == AEAD_STREAM3_MAGIC {
        3
    } else {
        return Err(StreamError::BadMagic);
    };
    if data[4] != AEAD_STREAM_VERSION {
        return Err(StreamError::UnsupportedVersion);
    }

    let algorithm = data[5];
    let kdf_id = data[6];
    let salt_len = u16::from_le_bytes([data[7], data[8]]);
    let nonce_len = u16::from_le_bytes([data[9], data[10]]);
    let chunk_size = u32::from_le_bytes([data[11], data[12], data[13], data[14]]);

    let header_len = 15usize + salt_len as usize + nonce_len as usize;
    if data.len() < header_len {
        return Err(StreamError::ShortHeader);
    }
    if format == 3 {
        let prefix_ok = match algorithm {
            AEAD_ALGO_AES256_GCM | AEAD_ALGO_CHACHA20_POLY1305 => nonce_len == 4,
            AEAD_ALGO_XCHACHA20_POLY1305 => nonce_len == 16,
            _ => false,
        };
        let kdf_ok = kdf_id == KDF_ARGON2ID || kdf_id == KDF_PBKDF2_SHA512;
        if !prefix_ok || !kdf_ok || salt_len < 8 || chunk_size == 0 || chunk_size > AEAD_STREAM3_MAX_CHUNK {
            return Err(StreamError::BadHeader);
        }
    }

    Ok(StreamHeader { format, algorithm, kdf_id, salt_len, nonce_len, chunk_size, header_len })
}

/// Returns stream header info for MDT2 or MDT3 containers:
/// [algorithm, kdf_id, salt_len, nonce_prefix_len, chunk_size, header_len, format]
/// where format is 2 (legacy MDT2) or 3 (MDT3, final chunk authenticated).
#[wasm_bindgen]
pub fn aead_stream_header_info(data: &[u8]) -> Result<Vec<u32>, JsValue> {
    let h = parse_stream_header_core(data).map_err(|e| JsValue::from_str(e.message()))?;
    Ok(vec![
        h.algorithm as u32,
        h.kdf_id as u32,
        h.salt_len as u32,
        h.nonce_len as u32,
        h.chunk_size,
        h.header_len as u32,
        h.format as u32,
    ])
}

/// Builds a stream header for chunk-by-chunk encryption.
#[wasm_bindgen]
pub fn aead_stream_header_pack(
    algorithm: u8,
    kdf_id: u8,
    salt: &[u8],
    nonce_prefix: &[u8],
    chunk_size: u32,
) -> Result<Vec<u8>, JsValue> {
    pack_aead_stream_header(algorithm, kdf_id, salt, nonce_prefix, chunk_size)
}

/// Extracts salt from stream header.
#[wasm_bindgen]
pub fn aead_stream_extract_salt(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (_, _, salt_len, _, _, _) = parse_aead_stream_header(data)?;
    let salt_start = 15;
    let salt_end = salt_start + salt_len as usize;
    Ok(data[salt_start..salt_end].to_vec())
}

/// Extracts nonce prefix from stream header.
#[wasm_bindgen]
pub fn aead_stream_extract_nonce_prefix(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (_, _, salt_len, nonce_len, _, _) = parse_aead_stream_header(data)?;
    let nonce_start = 15 + salt_len as usize;
    let nonce_end = nonce_start + nonce_len as usize;
    Ok(data[nonce_start..nonce_end].to_vec())
}

/// Derives key from stream header (password-based).
#[wasm_bindgen]
pub fn aead_stream_derive_key_from_header(
    data: &[u8],
    password: &[u8],
    mem_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Vec<u8>, JsValue> {
    let (_algorithm, kdf_id, _salt_len, _nonce_len, _chunk_size, _header_len) =
        parse_aead_stream_header(data)?;
    let salt = aead_stream_extract_salt(data)?;

    match kdf_id {
        KDF_ARGON2ID => kdf::kdf_argon2id(password, &salt, mem_kib, iterations, parallelism),
        KDF_PBKDF2_SHA512 => kdf::kdf_pbkdf2_sha512(password, &salt, iterations),
        _ => Err(JsValue::from_str("unknown kdf")),
    }
}

/// Encrypts a single chunk using stream parameters.
#[wasm_bindgen]
pub fn aead_stream_encrypt_chunk(
    algorithm: u8,
    key: &[u8],
    nonce_prefix: &[u8],
    counter: u64,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    match algorithm {
        AEAD_ALGO_AES256_GCM => aes256_gcm_encrypt_chunk(key, nonce_prefix, counter, plaintext, aad),
        AEAD_ALGO_CHACHA20_POLY1305 => {
            chacha20_poly1305_encrypt_chunk(key, nonce_prefix, counter, plaintext, aad)
        }
        AEAD_ALGO_XCHACHA20_POLY1305 => {
            xchacha20_poly1305_encrypt_chunk(key, nonce_prefix, counter, plaintext, aad)
        }
        _ => Err(JsValue::from_str("unknown algorithm")),
    }
}

/// Decrypts a single chunk using stream parameters.
#[wasm_bindgen]
pub fn aead_stream_decrypt_chunk(
    algorithm: u8,
    key: &[u8],
    nonce_prefix: &[u8],
    counter: u64,
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    match algorithm {
        AEAD_ALGO_AES256_GCM => aes256_gcm_decrypt_chunk(key, nonce_prefix, counter, ciphertext, aad),
        AEAD_ALGO_CHACHA20_POLY1305 => {
            chacha20_poly1305_decrypt_chunk(key, nonce_prefix, counter, ciphertext, aad)
        }
        AEAD_ALGO_XCHACHA20_POLY1305 => {
            xchacha20_poly1305_decrypt_chunk(key, nonce_prefix, counter, ciphertext, aad)
        }
        _ => Err(JsValue::from_str("unknown algorithm")),
    }
}

/* ── MDT3: final-chunk-authenticated stream container ─────────────────────
 *
 * container = header ‖ chunk₀ ‖ … ‖ chunkₙ₋₁   (n ≥ 1, even for empty input)
 * chunkᵢ    = AEAD(key, prefix ‖ u64be(i), plaintextᵢ, aad = header ‖ flagᵢ)
 * flagᵢ     = 0x01 for the last chunk, 0x00 otherwise
 * Every non-final plaintext chunk is exactly `chunk_size` bytes; the final
 * one is 0..=chunk_size. The decryptor treats the chunk that ends the file
 * as final, so a container cut at a chunk boundary (its new last chunk was
 * sealed with flag 0) or extended past the real final chunk fails the tag.
 */

/// Builds an MDT3 stream header (same layout as MDT2, magic `MDT3`).
#[wasm_bindgen]
pub fn aead_stream3_header_pack(
    algorithm: u8,
    kdf_id: u8,
    salt: &[u8],
    nonce_prefix: &[u8],
    chunk_size: u32,
) -> Result<Vec<u8>, JsValue> {
    let mut header = pack_aead_stream_header(algorithm, kdf_id, salt, nonce_prefix, chunk_size)?;
    header[0..4].copy_from_slice(&AEAD_STREAM3_MAGIC);
    parse_stream_header_core(&header).map_err(|e| JsValue::from_str(e.message()))?;
    Ok(header)
}

/// MDT3 chunk AAD: the full header followed by the final-chunk flag.
pub fn stream3_aad(header: &[u8], is_final: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(header.len() + 1);
    aad.extend_from_slice(header);
    aad.push(u8::from(is_final));
    aad
}

fn cipher_op<C: KeyInit + Aead>(key: &[u8], nonce: &[u8], encrypt: bool, data: &[u8], aad: &[u8]) -> Result<Vec<u8>, StreamError> {
    let cipher = C::new_from_slice(key).map_err(|_| StreamError::BadKey)?;
    let nonce = aead::Nonce::<C>::from_slice(nonce);
    let payload = Payload { msg: data, aad };
    if encrypt {
        cipher.encrypt(nonce, payload).map_err(|_| StreamError::Auth)
    } else {
        cipher.decrypt(nonce, payload).map_err(|_| StreamError::Auth)
    }
}

/// Seals/opens one chunk with nonce = prefix ‖ u64be(counter) (MDT2 and MDT3).
pub fn stream_chunk_core(
    encrypt: bool,
    algorithm: u8,
    key: &[u8],
    nonce_prefix: &[u8],
    counter: u64,
    data: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, StreamError> {
    if key.len() != 32 {
        return Err(StreamError::BadKey);
    }
    let mut nonce = Vec::with_capacity(24);
    nonce.extend_from_slice(nonce_prefix);
    nonce.extend_from_slice(&counter.to_be_bytes());
    match algorithm {
        AEAD_ALGO_AES256_GCM if nonce.len() == 12 => cipher_op::<Aes256Gcm>(key, &nonce, encrypt, data, aad),
        AEAD_ALGO_CHACHA20_POLY1305 if nonce.len() == 12 => cipher_op::<ChaCha20Poly1305>(key, &nonce, encrypt, data, aad),
        AEAD_ALGO_XCHACHA20_POLY1305 if nonce.len() == 24 => cipher_op::<XChaCha20Poly1305>(key, &nonce, encrypt, data, aad),
        AEAD_ALGO_AES256_GCM | AEAD_ALGO_CHACHA20_POLY1305 | AEAD_ALGO_XCHACHA20_POLY1305 => Err(StreamError::BadHeader),
        _ => Err(StreamError::UnknownAlgorithm),
    }
}

fn stream3_chunk(encrypt: bool, header: &[u8], key: &[u8], counter: u64, is_final: bool, data: &[u8]) -> Result<Vec<u8>, StreamError> {
    let h = parse_stream_header_core(header)?;
    if h.format != 3 || header.len() != h.header_len {
        return Err(StreamError::BadHeader);
    }
    let prefix = &header[h.header_len - h.nonce_len as usize..h.header_len];
    stream_chunk_core(encrypt, h.algorithm, key, prefix, counter, data, &stream3_aad(header, is_final))
}

/// Encrypts one MDT3 chunk. `header` is the exact container header; set
/// `is_final` on the last chunk (the only one allowed to be shorter).
#[wasm_bindgen]
pub fn aead_stream3_encrypt_chunk(header: &[u8], key: &[u8], counter: u64, is_final: bool, plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
    stream3_chunk(true, header, key, counter, is_final, plaintext).map_err(|e| JsValue::from_str(e.message()))
}

/// Decrypts one MDT3 chunk; `is_final` must be true exactly for the chunk that ends the file.
#[wasm_bindgen]
pub fn aead_stream3_decrypt_chunk(header: &[u8], key: &[u8], counter: u64, is_final: bool, ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
    stream3_chunk(false, header, key, counter, is_final, ciphertext).map_err(|e| JsValue::from_str(e.message()))
}

/// Reference MDT3 encryption of a whole buffer (the browser client does the
/// same chunk by chunk from a `File`). `header` comes from `aead_stream3_header_pack`.
pub fn stream3_seal(header: &[u8], key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, StreamError> {
    let h = parse_stream_header_core(header)?;
    if h.format != 3 {
        return Err(StreamError::BadHeader);
    }
    let chunk = h.chunk_size as usize;
    let count = plaintext.len().div_ceil(chunk).max(1);
    let mut out = header.to_vec();
    for i in 0..count {
        let part = &plaintext[(i * chunk).min(plaintext.len())..((i + 1) * chunk).min(plaintext.len())];
        out.extend(stream3_chunk(true, header, key, i as u64, i + 1 == count, part)?);
    }
    Ok(out)
}

/// Reference decryption of a whole MDT2 or MDT3 container with a derived key.
/// MDT2 (legacy) cannot detect a cut at a chunk boundary; MDT3 can.
pub fn stream_open(container: &[u8], key: &[u8]) -> Result<Vec<u8>, StreamError> {
    let h = parse_stream_header_core(container)?;
    if h.chunk_size == 0 {
        return Err(StreamError::BadHeader);
    }
    let header = &container[..h.header_len];
    let prefix = &header[h.header_len - h.nonce_len as usize..];
    let body = &container[h.header_len..];
    if h.format == 3 && body.is_empty() {
        return Err(StreamError::Truncated);
    }
    let step = h.chunk_size as usize + AEAD_TAG_LEN as usize;
    let mut out = Vec::with_capacity(body.len());
    let mut offset = 0usize;
    let mut counter = 0u64;
    while offset < body.len() {
        let end = (offset + step).min(body.len());
        let ct = &body[offset..end];
        let pt = if h.format == 3 {
            stream_chunk_core(false, h.algorithm, key, prefix, counter, ct, &stream3_aad(header, end == body.len()))?
        } else {
            stream_chunk_core(false, h.algorithm, key, prefix, counter, ct, b"")?
        };
        out.extend(pt);
        offset = end;
        counter += 1;
    }
    Ok(out)
}

/// AES-256-GCM encrypt (nonce = 12 bytes). Returns ciphertext with tag appended.
#[wasm_bindgen]
pub fn aes256_gcm_encrypt(key: &[u8], nonce: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str("key must be 32 bytes"));
    }
    if nonce.len() != 12 {
        return Err(JsValue::from_str("nonce must be 12 bytes"));
    }

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| JsValue::from_str("invalid key"))?;
    cipher
        .encrypt(nonce.into(), Payload { msg: plaintext, aad })
        .map_err(|_| JsValue::from_str("encrypt failed"))
}

/// AES-256-GCM decrypt (nonce = 12 bytes). Expects ciphertext with tag appended.
#[wasm_bindgen]
pub fn aes256_gcm_decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str("key must be 32 bytes"));
    }
    if nonce.len() != 12 {
        return Err(JsValue::from_str("nonce must be 12 bytes"));
    }

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| JsValue::from_str("invalid key"))?;
    cipher
        .decrypt(nonce.into(), Payload { msg: ciphertext, aad })
        .map_err(|_| JsValue::from_str("decrypt failed"))
}

/// ChaCha20-Poly1305 encrypt (nonce = 12 bytes). Returns ciphertext with tag appended.
#[wasm_bindgen]
pub fn chacha20_poly1305_encrypt(key: &[u8], nonce: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str("key must be 32 bytes"));
    }
    if nonce.len() != 12 {
        return Err(JsValue::from_str("nonce must be 12 bytes"));
    }

    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| JsValue::from_str("invalid key"))?;
    cipher
        .encrypt(nonce.into(), Payload { msg: plaintext, aad })
        .map_err(|_| JsValue::from_str("encrypt failed"))
}

/// ChaCha20-Poly1305 decrypt (nonce = 12 bytes). Expects ciphertext with tag appended.
#[wasm_bindgen]
pub fn chacha20_poly1305_decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str("key must be 32 bytes"));
    }
    if nonce.len() != 12 {
        return Err(JsValue::from_str("nonce must be 12 bytes"));
    }

    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| JsValue::from_str("invalid key"))?;
    cipher
        .decrypt(nonce.into(), Payload { msg: ciphertext, aad })
        .map_err(|_| JsValue::from_str("decrypt failed"))
}

/// XChaCha20-Poly1305 encrypt (nonce = 24 bytes). Returns ciphertext with tag appended.
#[wasm_bindgen]
pub fn xchacha20_poly1305_encrypt(key: &[u8], nonce: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str("key must be 32 bytes"));
    }
    if nonce.len() != 24 {
        return Err(JsValue::from_str("nonce must be 24 bytes"));
    }

    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| JsValue::from_str("invalid key"))?;
    cipher
        .encrypt(nonce.into(), Payload { msg: plaintext, aad })
        .map_err(|_| JsValue::from_str("encrypt failed"))
}

/// XChaCha20-Poly1305 decrypt (nonce = 24 bytes). Expects ciphertext with tag appended.
#[wasm_bindgen]
pub fn xchacha20_poly1305_decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str("key must be 32 bytes"));
    }
    if nonce.len() != 24 {
        return Err(JsValue::from_str("nonce must be 24 bytes"));
    }

    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| JsValue::from_str("invalid key"))?;
    cipher
        .decrypt(nonce.into(), Payload { msg: ciphertext, aad })
        .map_err(|_| JsValue::from_str("decrypt failed"))
}

/// Returns header info: [algorithm, salt_len, nonce_len, tag_len, header_len].
#[wasm_bindgen]
pub fn aead_header_info(data: &[u8]) -> Result<Vec<u32>, JsValue> {
    let (algorithm, salt_len, nonce_len, tag_len, header_len) = parse_aead_header(data)?;
    Ok(vec![
        algorithm as u32,
        salt_len as u32,
        nonce_len as u32,
        tag_len as u32,
        header_len as u32,
    ])
}

/// Extracts salt from header.
#[wasm_bindgen]
pub fn aead_extract_salt(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (_, salt_len, _, _, _) = parse_aead_header(data)?;
    let salt_start = 12;
    let salt_end = salt_start + salt_len as usize;
    Ok(data[salt_start..salt_end].to_vec())
}

/// Extracts nonce from header.
#[wasm_bindgen]
pub fn aead_extract_nonce(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (_, salt_len, nonce_len, _, _) = parse_aead_header(data)?;
    let nonce_start = 12 + salt_len as usize;
    let nonce_end = nonce_start + nonce_len as usize;
    Ok(data[nonce_start..nonce_end].to_vec())
}

/// Extracts ciphertext (payload after header).
#[wasm_bindgen]
pub fn aead_extract_ciphertext(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (_, _, _, _, header_len) = parse_aead_header(data)?;
    Ok(data[header_len..].to_vec())
}

/// Encrypts and prepends a custom AEAD header.
///
/// algorithm: 1 = AES-256-GCM, 2 = ChaCha20-Poly1305, 3 = XChaCha20-Poly1305
#[wasm_bindgen]
pub fn aead_encrypt_with_header(
    algorithm: u8,
    key: &[u8],
    salt: &[u8],
    nonce: &[u8],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let header = pack_aead_header(algorithm, salt, nonce, AEAD_TAG_LEN)?;
    let ciphertext = match algorithm {
        AEAD_ALGO_AES256_GCM => aes256_gcm_encrypt(key, nonce, plaintext, aad)?,
        AEAD_ALGO_CHACHA20_POLY1305 => chacha20_poly1305_encrypt(key, nonce, plaintext, aad)?,
        AEAD_ALGO_XCHACHA20_POLY1305 => xchacha20_poly1305_encrypt(key, nonce, plaintext, aad)?,
        _ => return Err(JsValue::from_str("unknown algorithm")),
    };

    let mut out = Vec::with_capacity(header.len() + ciphertext.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts data with the custom header using the provided key and AAD.
#[wasm_bindgen]
pub fn aead_decrypt_with_header(data: &[u8], key: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (algorithm, _salt_len, _nonce_len, _tag_len, header_len) = parse_aead_header(data)?;
    let salt = aead_extract_salt(data)?;
    let nonce = aead_extract_nonce(data)?;
    let ciphertext = &data[header_len..];

    match algorithm {
        AEAD_ALGO_AES256_GCM => aes256_gcm_decrypt(key, &nonce, ciphertext, aad),
        AEAD_ALGO_CHACHA20_POLY1305 => chacha20_poly1305_decrypt(key, &nonce, ciphertext, aad),
        AEAD_ALGO_XCHACHA20_POLY1305 => xchacha20_poly1305_decrypt(key, &nonce, ciphertext, aad),
        _ => Err(JsValue::from_str("unknown algorithm")),
    }
    .map(|pt| {
        let _ = salt; // keep for future validation/use
        pt
    })
}

/// Encrypts with password-derived key and prepends a custom AEAD header.
///
/// kdf: 1 = Argon2id, 2 = PBKDF2-SHA512
#[wasm_bindgen]
pub fn aead_encrypt_with_password(
    algorithm: u8,
    kdf_id: u8,
    password: &[u8],
    salt: &[u8],
    nonce: &[u8],
    mem_kib: u32,
    iterations: u32,
    parallelism: u32,
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let key = match kdf_id {
        KDF_ARGON2ID => kdf::kdf_argon2id(password, salt, mem_kib, iterations, parallelism)?,
        KDF_PBKDF2_SHA512 => kdf::kdf_pbkdf2_sha512(password, salt, iterations)?,
        _ => return Err(JsValue::from_str("unknown kdf")),
    };

    aead_encrypt_with_header(algorithm, &key, salt, nonce, plaintext, aad)
}

/// Decrypts data with header using password-derived key.
///
/// kdf: 1 = Argon2id, 2 = PBKDF2-SHA512
#[wasm_bindgen]
pub fn aead_decrypt_with_password(
    data: &[u8],
    kdf_id: u8,
    password: &[u8],
    mem_kib: u32,
    iterations: u32,
    parallelism: u32,
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let salt = aead_extract_salt(data)?;
    let key = match kdf_id {
        KDF_ARGON2ID => kdf::kdf_argon2id(password, &salt, mem_kib, iterations, parallelism)?,
        KDF_PBKDF2_SHA512 => kdf::kdf_pbkdf2_sha512(password, &salt, iterations)?,
        _ => return Err(JsValue::from_str("unknown kdf")),
    };

    aead_decrypt_with_header(data, &key, aad)
}

/// Derives a 12-byte nonce from 4-byte prefix + 64-bit counter (big-endian).
#[wasm_bindgen]
pub fn aead_derive_nonce_12(prefix4: &[u8], counter: u64) -> Result<Vec<u8>, JsValue> {
    if prefix4.len() != 4 {
        return Err(JsValue::from_str("prefix4 must be 4 bytes"));
    }
    let mut nonce = [0u8; 12];
    nonce[0..4].copy_from_slice(prefix4);
    nonce[4..12].copy_from_slice(&counter.to_be_bytes());
    Ok(nonce.to_vec())
}

/// Derives a 24-byte nonce from 16-byte prefix + 64-bit counter (big-endian).
#[wasm_bindgen]
pub fn aead_derive_nonce_24(prefix16: &[u8], counter: u64) -> Result<Vec<u8>, JsValue> {
    if prefix16.len() != 16 {
        return Err(JsValue::from_str("prefix16 must be 16 bytes"));
    }
    let mut nonce = [0u8; 24];
    nonce[0..16].copy_from_slice(prefix16);
    nonce[16..24].copy_from_slice(&counter.to_be_bytes());
    Ok(nonce.to_vec())
}

/// Chunk encrypt helper (AES-256-GCM) using prefix+counter nonce.
#[wasm_bindgen]
pub fn aes256_gcm_encrypt_chunk(
    key: &[u8],
    prefix4: &[u8],
    counter: u64,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let nonce = aead_derive_nonce_12(prefix4, counter)?;
    aes256_gcm_encrypt(key, &nonce, plaintext, aad)
}

/// Chunk decrypt helper (AES-256-GCM) using prefix+counter nonce.
#[wasm_bindgen]
pub fn aes256_gcm_decrypt_chunk(
    key: &[u8],
    prefix4: &[u8],
    counter: u64,
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let nonce = aead_derive_nonce_12(prefix4, counter)?;
    aes256_gcm_decrypt(key, &nonce, ciphertext, aad)
}

/// Chunk encrypt helper (ChaCha20-Poly1305) using prefix+counter nonce.
#[wasm_bindgen]
pub fn chacha20_poly1305_encrypt_chunk(
    key: &[u8],
    prefix4: &[u8],
    counter: u64,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let nonce = aead_derive_nonce_12(prefix4, counter)?;
    chacha20_poly1305_encrypt(key, &nonce, plaintext, aad)
}

/// Chunk decrypt helper (ChaCha20-Poly1305) using prefix+counter nonce.
#[wasm_bindgen]
pub fn chacha20_poly1305_decrypt_chunk(
    key: &[u8],
    prefix4: &[u8],
    counter: u64,
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let nonce = aead_derive_nonce_12(prefix4, counter)?;
    chacha20_poly1305_decrypt(key, &nonce, ciphertext, aad)
}

/// Chunk encrypt helper (XChaCha20-Poly1305) using prefix+counter nonce.
#[wasm_bindgen]
pub fn xchacha20_poly1305_encrypt_chunk(
    key: &[u8],
    prefix16: &[u8],
    counter: u64,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let nonce = aead_derive_nonce_24(prefix16, counter)?;
    xchacha20_poly1305_encrypt(key, &nonce, plaintext, aad)
}

/// Chunk decrypt helper (XChaCha20-Poly1305) using prefix+counter nonce.
#[wasm_bindgen]
pub fn xchacha20_poly1305_decrypt_chunk(
    key: &[u8],
    prefix16: &[u8],
    counter: u64,
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let nonce = aead_derive_nonce_24(prefix16, counter)?;
    xchacha20_poly1305_decrypt(key, &nonce, ciphertext, aad)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes256_gcm_roundtrip() {
        let key = [7u8; 32];
        let nonce = [1u8; 12];
        let aad = b"aad";
        let msg = b"secret";
        let ct = aes256_gcm_encrypt(&key, &nonce, msg, aad).expect("encrypt");
        let pt = aes256_gcm_decrypt(&key, &nonce, &ct, aad).expect("decrypt");
        assert_eq!(pt, msg);
    }

    #[test]
    fn chacha20_poly1305_roundtrip() {
        let key = [9u8; 32];
        let nonce = [2u8; 12];
        let aad = b"aad";
        let msg = b"secret";
        let ct = chacha20_poly1305_encrypt(&key, &nonce, msg, aad).expect("encrypt");
        let pt = chacha20_poly1305_decrypt(&key, &nonce, &ct, aad).expect("decrypt");
        assert_eq!(pt, msg);
    }

    #[test]
    fn xchacha20_poly1305_roundtrip() {
        let key = [11u8; 32];
        let nonce = [3u8; 24];
        let aad = b"aad";
        let msg = b"secret";
        let ct = xchacha20_poly1305_encrypt(&key, &nonce, msg, aad).expect("encrypt");
        let pt = xchacha20_poly1305_decrypt(&key, &nonce, &ct, aad).expect("decrypt");
        assert_eq!(pt, msg);
    }

    #[test]
    fn aead_header_roundtrip() {
        let key = [5u8; 32];
        let salt = [6u8; 16];
        let nonce = [7u8; 12];
        let aad = b"aad";
        let msg = b"secret";

        let blob = aead_encrypt_with_header(AEAD_ALGO_AES256_GCM, &key, &salt, &nonce, msg, aad)
            .expect("encrypt");
        let info = aead_header_info(&blob).expect("info");
        assert_eq!(info[0], AEAD_ALGO_AES256_GCM as u32);
        assert_eq!(info[1], 16);
        assert_eq!(info[2], 12);
        assert_eq!(info[3], AEAD_TAG_LEN as u32);

        let out = aead_decrypt_with_header(&blob, &key, aad).expect("decrypt");
        assert_eq!(out, msg);
    }

    #[test]
    fn aead_with_password_roundtrip() {
        let salt = [1u8; 16];
        let nonce = [2u8; 12];
        let aad = b"aad";
        let msg = b"secret";

        let blob = aead_encrypt_with_password(
            AEAD_ALGO_AES256_GCM,
            KDF_PBKDF2_SHA512,
            b"password",
            &salt,
            &nonce,
            64 * 1024,
            10_000,
            1,
            aad,
            msg,
        )
        .expect("encrypt");

        let out = aead_decrypt_with_password(
            &blob,
            KDF_PBKDF2_SHA512,
            b"password",
            64 * 1024,
            10_000,
            1,
            aad,
        )
        .expect("decrypt");

        assert_eq!(out, msg);
    }

    #[test]
    fn aead_chunk_roundtrip() {
        let key = [1u8; 32];
        let prefix4 = [2u8; 4];
        let prefix16 = [3u8; 16];
        let aad = b"aad";
        let msg = b"chunk";

        let ct = aes256_gcm_encrypt_chunk(&key, &prefix4, 1, msg, aad).expect("enc");
        let pt = aes256_gcm_decrypt_chunk(&key, &prefix4, 1, &ct, aad).expect("dec");
        assert_eq!(pt, msg);

        let ct = chacha20_poly1305_encrypt_chunk(&key, &prefix4, 2, msg, aad).expect("enc");
        let pt = chacha20_poly1305_decrypt_chunk(&key, &prefix4, 2, &ct, aad).expect("dec");
        assert_eq!(pt, msg);

        let ct = xchacha20_poly1305_encrypt_chunk(&key, &prefix16, 3, msg, aad).expect("enc");
        let pt = xchacha20_poly1305_decrypt_chunk(&key, &prefix16, 3, &ct, aad).expect("dec");
        assert_eq!(pt, msg);
    }

    #[test]
    fn aead_stream_header_roundtrip() {
        let salt = [1u8; 16];
        let prefix = [2u8; 4];
        let header = aead_stream_header_pack(
            AEAD_ALGO_AES256_GCM,
            KDF_PBKDF2_SHA512,
            &salt,
            &prefix,
            64 * 1024,
        )
        .expect("header");
        let info = aead_stream_header_info(&header).expect("info");
        assert_eq!(info[0], AEAD_ALGO_AES256_GCM as u32);
        assert_eq!(info[1], KDF_PBKDF2_SHA512 as u32);
        assert_eq!(info[2], 16);
        assert_eq!(info[3], 4);
        assert_eq!(info[4], 64 * 1024);

        let out_salt = aead_stream_extract_salt(&header).expect("salt");
        let out_prefix = aead_stream_extract_nonce_prefix(&header).expect("prefix");
        assert_eq!(out_salt, salt);
        assert_eq!(out_prefix, prefix);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn aead_invalid_key_and_nonce_lengths() {
        let aad = b"aad";
        let msg = b"secret";
        assert!(aes256_gcm_encrypt(&[0u8; 31], &[0u8; 12], msg, aad).is_err());
        assert!(aes256_gcm_encrypt(&[0u8; 32], &[0u8; 11], msg, aad).is_err());
        assert!(chacha20_poly1305_encrypt(&[0u8; 31], &[0u8; 12], msg, aad).is_err());
        assert!(xchacha20_poly1305_encrypt(&[0u8; 32], &[0u8; 23], msg, aad).is_err());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn aead_decrypt_fails_with_wrong_key() {
        let key = [7u8; 32];
        let wrong_key = [8u8; 32];
        let nonce = [1u8; 12];
        let aad = b"aad";
        let msg = b"secret";
        let ct = aes256_gcm_encrypt(&key, &nonce, msg, aad).expect("encrypt");
        assert!(aes256_gcm_decrypt(&wrong_key, &nonce, &ct, aad).is_err());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn aead_decrypt_with_password_wrong_password() {
        let salt = [1u8; 16];
        let nonce = [2u8; 12];
        let aad = b"aad";
        let msg = b"secret";

        let blob = aead_encrypt_with_password(
            AEAD_ALGO_AES256_GCM,
            KDF_PBKDF2_SHA512,
            b"password",
            &salt,
            &nonce,
            64 * 1024,
            10_000,
            1,
            aad,
            msg,
        )
        .expect("encrypt");

        assert!(aead_decrypt_with_password(
            &blob,
            KDF_PBKDF2_SHA512,
            b"wrong-password",
            64 * 1024,
            10_000,
            1,
            aad,
        )
        .is_err());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn aead_stream_header_invalid_magic() {
        let data = [0u8; 16];
        assert!(aead_stream_header_info(&data).is_err());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn aead_nonce_derivation_invalid_prefix() {
        assert!(aead_derive_nonce_12(&[0u8; 3], 0).is_err());
        assert!(aead_derive_nonce_24(&[0u8; 15], 0).is_err());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn aead_stream_unknown_kdf() {
        let salt = [1u8; 16];
        let prefix = [2u8; 4];
        let header = aead_stream_header_pack(
            AEAD_ALGO_AES256_GCM,
            9,
            &salt,
            &prefix,
            1024,
        )
        .expect("header");

        assert!(aead_stream_derive_key_from_header(&header, b"password", 64 * 1024, 3, 1).is_err());
    }

    /// Mirrors apps/site aead-file-client: header → Argon2id key → per-chunk
    /// counter nonces; ciphertext = header ‖ chunk₀+tag ‖ chunk₁+tag ‖ …
    #[test]
    fn aead_stream_multi_chunk_roundtrip_all_algorithms() {
        let chunk_size = 1000usize;
        let plaintext: Vec<u8> = (0..2_500u32).map(|i| (i * 7 % 251) as u8).collect();
        for (alg, prefix_len) in [
            (AEAD_ALGO_AES256_GCM, 4usize),
            (AEAD_ALGO_CHACHA20_POLY1305, 4),
            (AEAD_ALGO_XCHACHA20_POLY1305, 16),
        ] {
            let salt = [0x11u8; 16];
            let prefix = vec![0x22u8; prefix_len];
            let header = aead_stream_header_pack(alg, KDF_ARGON2ID, &salt, &prefix, chunk_size as u32).expect("header");
            // Small Argon2 params keep the debug test fast; the site uses 64 MiB / 3 / 1.
            let key = aead_stream_derive_key_from_header(&header, "pässwörd 🔑".as_bytes(), 256, 1, 1).expect("key");
            assert_eq!(key.len(), 32);

            let mut container = header.clone();
            for (i, chunk) in plaintext.chunks(chunk_size).enumerate() {
                let ct = aead_stream_encrypt_chunk(alg, &key, &prefix, i as u64, chunk, b"").expect("enc");
                assert_eq!(ct.len(), chunk.len() + AEAD_TAG_LEN as usize);
                container.extend_from_slice(&ct);
            }

            // Decrypt exactly like the browser client: parse header, re-derive, walk chunks.
            let info = aead_stream_header_info(&container[..container.len().min(128)]).expect("info");
            assert_eq!(info[0], alg as u32);
            assert_eq!(info[4], chunk_size as u32);
            let header_len = info[5] as usize;
            assert_eq!(header_len, 15 + 16 + prefix_len);
            let hdr = &container[..header_len];
            let key2 = aead_stream_derive_key_from_header(hdr, "pässwörd 🔑".as_bytes(), 256, 1, 1).expect("key2");
            assert_eq!(key2, key);
            let nonce_prefix = aead_stream_extract_nonce_prefix(hdr).expect("prefix");
            let mut out = Vec::new();
            for (i, ct) in container[header_len..].chunks(chunk_size + AEAD_TAG_LEN as usize).enumerate() {
                out.extend(aead_stream_decrypt_chunk(alg, &key2, &nonce_prefix, i as u64, ct, b"").expect("dec"));
            }
            assert_eq!(out, plaintext);
        }
    }

    #[test]
    fn aead_stream_different_password_gives_different_key() {
        let header = aead_stream_header_pack(AEAD_ALGO_AES256_GCM, KDF_ARGON2ID, &[1u8; 16], &[2u8; 4], 1024).expect("header");
        let a = aead_stream_derive_key_from_header(&header, b"password", 256, 1, 1).expect("a");
        let b = aead_stream_derive_key_from_header(&header, b"password ", 256, 1, 1).expect("b");
        assert_ne!(a, b);
    }

    #[test]
    fn aead_stream_nonces_differ_per_chunk() {
        assert_ne!(
            aead_derive_nonce_12(&[9u8; 4], 0).expect("n0"),
            aead_derive_nonce_12(&[9u8; 4], 1).expect("n1")
        );
        assert_eq!(aead_derive_nonce_12(&[9u8; 4], 5).expect("n").len(), 12);
        assert_eq!(aead_derive_nonce_24(&[9u8; 16], 5).expect("n").len(), 24);
    }

    /* ── MDT3 ── */

    fn mdt3_header(alg: u8, chunk: u32) -> Vec<u8> {
        let prefix = vec![0x5au8; if alg == AEAD_ALGO_XCHACHA20_POLY1305 { 16 } else { 4 }];
        aead_stream3_header_pack(alg, KDF_ARGON2ID, &[0x33u8; 16], &prefix, chunk).expect("mdt3 header")
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len as u32).map(|i| (i * 13 % 251) as u8).collect()
    }

    #[test]
    fn mdt3_roundtrip_all_algorithms_and_sizes() {
        for alg in [AEAD_ALGO_AES256_GCM, AEAD_ALGO_CHACHA20_POLY1305, AEAD_ALGO_XCHACHA20_POLY1305] {
            let header = mdt3_header(alg, 100);
            let key = aead_stream_derive_key_from_header(&header, "pässwörd 🔑".as_bytes(), 256, 1, 1).expect("key");
            for len in [0usize, 1, 99, 100, 101, 300, 345] {
                let plain = sample(len);
                let container = stream3_seal(&header, &key, &plain).expect("seal");
                assert_eq!(&container[..4], b"MDT3");
                // At least one (final) chunk even for empty input.
                let chunks = len.div_ceil(100).max(1);
                assert_eq!(container.len(), header.len() + len + chunks * AEAD_TAG_LEN as usize, "alg {alg} len {len}");
                assert_eq!(stream_open(&container, &key).expect("open"), plain, "alg {alg} len {len}");
            }
        }
    }

    #[test]
    fn mdt3_chunk_api_matches_reference() {
        // The browser client calls the per-chunk export; it must equal stream3_seal.
        let header = mdt3_header(AEAD_ALGO_AES256_GCM, 64);
        let key = [7u8; 32];
        let plain = sample(150);
        let mut manual = header.clone();
        for (i, part) in plain.chunks(64).enumerate() {
            manual.extend(aead_stream3_encrypt_chunk(&header, &key, i as u64, i == 2, part).expect("chunk"));
        }
        assert_eq!(manual, stream3_seal(&header, &key, &plain).expect("seal"));
        let info = aead_stream_header_info(&header).expect("info");
        assert_eq!(info, vec![1, 1, 16, 4, 64, 35, 3]);
    }

    #[test]
    fn mdt3_detects_truncation_at_chunk_boundary() {
        let header = mdt3_header(AEAD_ALGO_CHACHA20_POLY1305, 100);
        let key = [9u8; 32];
        let container = stream3_seal(&header, &key, &sample(300)).expect("seal"); // 3 full chunks
        let step = 100 + AEAD_TAG_LEN as usize;
        for kept in 1..3 {
            let cut = &container[..header.len() + kept * step];
            assert_eq!(stream_open(cut, &key), Err(StreamError::Auth), "cut after {kept} chunk(s)");
        }
        // Cut right after the header: no final chunk at all.
        assert_eq!(stream_open(&container[..header.len()], &key), Err(StreamError::Truncated));
        // Cut inside a chunk also fails.
        assert_eq!(stream_open(&container[..container.len() - 1], &key), Err(StreamError::Auth));
    }

    #[test]
    fn mdt2_cannot_detect_boundary_truncation_but_mdt3_can() {
        // Documents why MDT3 exists: the legacy layout silently returns a prefix.
        let salt = [1u8; 16];
        let prefix = [2u8; 4];
        let key = [3u8; 32];
        let h2 = aead_stream_header_pack(AEAD_ALGO_AES256_GCM, KDF_ARGON2ID, &salt, &prefix, 100).expect("h2");
        let mut c2 = h2.clone();
        for (i, part) in sample(300).chunks(100).enumerate() {
            c2.extend(stream_chunk_core(true, AEAD_ALGO_AES256_GCM, &key, &prefix, i as u64, part, b"").expect("enc"));
        }
        let cut2 = &c2[..h2.len() + 2 * 116];
        assert_eq!(stream_open(cut2, &key).expect("mdt2 opens a truncated file"), sample(200));
    }

    #[test]
    fn mdt3_detects_reorder_append_and_tamper() {
        let header = mdt3_header(AEAD_ALGO_XCHACHA20_POLY1305, 100);
        let key = [4u8; 32];
        let container = stream3_seal(&header, &key, &sample(250)).expect("seal");
        let h = header.len();
        let step = 116;
        // Swap chunk 0 and 1 (counter nonces).
        let mut swapped = container[..h].to_vec();
        swapped.extend_from_slice(&container[h + step..h + 2 * step]);
        swapped.extend_from_slice(&container[h..h + step]);
        swapped.extend_from_slice(&container[h + 2 * step..]);
        assert_eq!(swapped.len(), container.len());
        assert_eq!(stream_open(&swapped, &key), Err(StreamError::Auth));
        // Append a copy of chunk 0 after the real final chunk.
        let mut extended = container.clone();
        extended.extend_from_slice(&container[h..h + step]);
        assert_eq!(stream_open(&extended, &key), Err(StreamError::Auth));
        // Flip a ciphertext bit / a tag bit.
        let mut flipped = container.clone();
        flipped[h + 5] ^= 1;
        assert_eq!(stream_open(&flipped, &key), Err(StreamError::Auth));
        let mut tag = container.clone();
        *tag.last_mut().unwrap() ^= 0x80;
        assert_eq!(stream_open(&tag, &key), Err(StreamError::Auth));
        // Header is authenticated: change the declared chunk size 100 → 99.
        let mut hdr = container.clone();
        hdr[11] = 99;
        assert_eq!(stream_open(&hdr, &key), Err(StreamError::Auth));
        // Wrong key.
        assert_eq!(stream_open(&container, &[5u8; 32]), Err(StreamError::Auth));
    }

    #[test]
    fn mdt3_header_validation() {
        let ok = mdt3_header(AEAD_ALGO_AES256_GCM, 1024);
        assert_eq!(parse_stream_header_core(&ok).expect("ok").format, 3);
        let mut bad_alg = ok.clone();
        bad_alg[5] = 9;
        assert_eq!(parse_stream_header_core(&bad_alg), Err(StreamError::BadHeader));
        let mut bad_kdf = ok.clone();
        bad_kdf[6] = 7;
        assert_eq!(parse_stream_header_core(&bad_kdf), Err(StreamError::BadHeader));
        let mut zero_chunk = ok.clone();
        zero_chunk[11..15].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_stream_header_core(&zero_chunk), Err(StreamError::BadHeader));
        // XChaCha needs a 16-byte prefix: a 4-byte prefix header is rejected.
        let mut wrong_prefix = ok.clone();
        wrong_prefix[5] = AEAD_ALGO_XCHACHA20_POLY1305;
        assert_eq!(parse_stream_header_core(&wrong_prefix), Err(StreamError::BadHeader));
        assert_eq!(parse_stream_header_core(&ok[..20]), Err(StreamError::ShortHeader));
        assert_eq!(parse_stream_header_core(b"not an aead file"), Err(StreamError::BadMagic));
        let mut bad_version = ok.clone();
        bad_version[4] = 2;
        assert_eq!(parse_stream_header_core(&bad_version), Err(StreamError::UnsupportedVersion));
        // MDT2 keeps its lenient legacy parsing (unknown algorithm is rejected later).
        let mut legacy = ok.clone();
        legacy[0..4].copy_from_slice(b"MDT2");
        legacy[5] = 9;
        assert_eq!(parse_stream_header_core(&legacy).expect("mdt2").format, 2);
    }
}
