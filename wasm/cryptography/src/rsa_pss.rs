use wasm_bindgen::prelude::*;

use getrandom::getrandom;
use rand_core::{CryptoRng, Error as RandError, RngCore};
use rsa::{
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey},
    Pss, RsaPrivateKey, RsaPublicKey,
};
use sha2::Sha256;

struct WasmRng;

impl RngCore for WasmRng {
    fn next_u32(&mut self) -> u32 {
        let mut bytes = [0u8; 4];
        let _ = getrandom(&mut bytes);
        u32::from_le_bytes(bytes)
    }

    fn next_u64(&mut self) -> u64 {
        let mut bytes = [0u8; 8];
        let _ = getrandom(&mut bytes);
        u64::from_le_bytes(bytes)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        let _ = getrandom(dest);
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), RandError> {
        getrandom(dest).map_err(|_| RandError::new("getrandom failed"))
    }
}

impl CryptoRng for WasmRng {}

/// Signs message using RSA-PSS with SHA-256.
///
/// private_key_der: PKCS#8 DER
#[wasm_bindgen]
pub fn rsa_pss_sign_pkcs8(private_key_der: &[u8], message: &[u8], salt_len: u16) -> Result<Vec<u8>, JsValue> {
    let private_key = RsaPrivateKey::from_pkcs8_der(private_key_der)
        .map_err(|_| JsValue::from_str("invalid private key"))?;

    let padding = if salt_len == 0 {
        Pss::new::<Sha256>()
    } else {
        Pss::new_with_salt::<Sha256>(salt_len as usize)
    };

    let mut rng = WasmRng;
    private_key
        .sign_with_rng(&mut rng, padding, message)
        .map_err(|_| JsValue::from_str("sign failed"))
}

/// Verifies message using RSA-PSS with SHA-256.
///
/// public_key_der: SubjectPublicKeyInfo (SPKI) DER
#[wasm_bindgen]
pub fn rsa_pss_verify_spki(public_key_der: &[u8], message: &[u8], signature: &[u8], salt_len: u16) -> Result<bool, JsValue> {
    let public_key = RsaPublicKey::from_public_key_der(public_key_der)
        .map_err(|_| JsValue::from_str("invalid public key"))?;

    let padding = if salt_len == 0 {
        Pss::new::<Sha256>()
    } else {
        Pss::new_with_salt::<Sha256>(salt_len as usize)
    };

    Ok(public_key.verify(padding, message, signature).is_ok())
}

/// Generates an RSA private key (PKCS#8 DER). Recommended bits: 3072 or 4096.
#[wasm_bindgen]
pub fn rsa_generate_private_key_pkcs8(bits: u32) -> Result<Vec<u8>, JsValue> {
    if bits < 2048 {
        return Err(JsValue::from_str("bits must be >= 2048"));
    }

    let mut rng = WasmRng;
    let private_key = RsaPrivateKey::new(&mut rng, bits as usize)
        .map_err(|_| JsValue::from_str("key generation failed"))?;
    private_key
        .to_pkcs8_der()
        .map(|der| der.as_bytes().to_vec())
        .map_err(|_| JsValue::from_str("encode failed"))
}

/// Derives RSA public key (SPKI DER) from a PKCS#8 private key.
#[wasm_bindgen]
pub fn rsa_public_key_from_private_pkcs8(private_key_der: &[u8]) -> Result<Vec<u8>, JsValue> {
    let private_key = RsaPrivateKey::from_pkcs8_der(private_key_der)
        .map_err(|_| JsValue::from_str("invalid private key"))?;
    let public_key = RsaPublicKey::from(&private_key);
    public_key
        .to_public_key_der()
        .map(|der| der.as_bytes().to_vec())
        .map_err(|_| JsValue::from_str("encode failed"))
}

/// Parses RSA public key (SPKI DER) to validate it is well-formed.
#[wasm_bindgen]
pub fn rsa_validate_public_key_spki(public_key_der: &[u8]) -> Result<bool, JsValue> {
    let _ = RsaPublicKey::from_public_key_der(public_key_der)
        .map_err(|_| JsValue::from_str("invalid public key"))?;
    Ok(true)
}
