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
    if data.len() < 15 {
        return Err(JsValue::from_str("data too короткие для header"));
    }
    if data[0..4] != AEAD_STREAM_MAGIC {
        return Err(JsValue::from_str("invalid magic"));
    }
    if data[4] != AEAD_STREAM_VERSION {
        return Err(JsValue::from_str("unsupported version"));
    }

    let algorithm = data[5];
    let kdf_id = data[6];
    let salt_len = u16::from_le_bytes([data[7], data[8]]);
    let nonce_len = u16::from_le_bytes([data[9], data[10]]);
    let chunk_size = u32::from_le_bytes([data[11], data[12], data[13], data[14]]);

    let header_len = 15usize + salt_len as usize + nonce_len as usize;
    if data.len() < header_len {
        return Err(JsValue::from_str("data too короткие для salt/nonce"));
    }

    Ok((algorithm, kdf_id, salt_len, nonce_len, chunk_size, header_len))
}

/// Returns stream header info: [algorithm, kdf_id, salt_len, nonce_prefix_len, chunk_size, header_len].
#[wasm_bindgen]
pub fn aead_stream_header_info(data: &[u8]) -> Result<Vec<u32>, JsValue> {
    let (algorithm, kdf_id, salt_len, nonce_len, chunk_size, header_len) = parse_aead_stream_header(data)?;
    Ok(vec![
        algorithm as u32,
        kdf_id as u32,
        salt_len as u32,
        nonce_len as u32,
        chunk_size,
        header_len as u32,
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
}
