use wasm_bindgen::prelude::*;

use argon2::{Argon2, Params, Version};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha512;

/// Derives a 32-byte key using Argon2id.
///
/// Params are intentionally explicit for UI control.
#[wasm_bindgen]
pub fn kdf_argon2id(
    password: &[u8],
    salt: &[u8],
    mem_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Vec<u8>, JsValue> {
    if salt.len() < 8 {
        return Err(JsValue::from_str("salt must be at least 8 bytes"));
    }

    let params = Params::new(mem_kib, iterations, parallelism, Some(32))
        .map_err(|_| JsValue::from_str("invalid params"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params);

    let mut out = [0u8; 32];
    argon2
        .hash_password_into(password, salt, &mut out)
        .map_err(|_| JsValue::from_str("argon2 failed"))?;
    Ok(out.to_vec())
}

/// Derives a 32-byte key using PBKDF2-HMAC-SHA512.
#[wasm_bindgen]
pub fn kdf_pbkdf2_sha512(password: &[u8], salt: &[u8], iterations: u32) -> Result<Vec<u8>, JsValue> {
    if iterations == 0 {
        return Err(JsValue::from_str("iterations must be > 0"));
    }

    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha512>(password, salt, iterations, &mut out);
    Ok(out.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2id_kdf_length() {
        let password = b"password";
        let salt = b"saltsalt";
        let key = kdf_argon2id(password, salt, 64 * 1024, 3, 1).expect("kdf");
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn pbkdf2_kdf_length() {
        let password = b"password";
        let salt = b"salt";
        let key = kdf_pbkdf2_sha512(password, salt, 10_000).expect("kdf");
        assert_eq!(key.len(), 32);
    }
}
