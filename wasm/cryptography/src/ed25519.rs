use wasm_bindgen::prelude::*;

use ed25519_dalek::{
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
    Signature, SigningKey, VerifyingKey,
};
use ed25519_dalek::Signer;
use getrandom::getrandom;

/// Generates a new Ed25519 keypair.
///
/// Returns 64 bytes: [private_key(32) || public_key(32)].
#[wasm_bindgen]
pub fn ed25519_generate_keypair() -> Result<Vec<u8>, JsValue> {
    let mut secret = [0u8; 32];
    getrandom(&mut secret).map_err(|_| JsValue::from_str("getrandom failed"))?;
    let signing_key = SigningKey::from_bytes(&secret);
    let verifying_key = signing_key.verifying_key();

    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(signing_key.to_bytes().as_slice());
    out.extend_from_slice(verifying_key.to_bytes().as_slice());
    Ok(out)
}

/// Derives the Ed25519 public key from a 32-byte private key.
#[wasm_bindgen]
pub fn ed25519_public_key(private_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let signing_key = SigningKey::from_bytes(&bytes);
    Ok(signing_key.verifying_key().to_bytes().to_vec())
}

/// Converts a 32-byte Ed25519 private key to PKCS#8 DER.
#[wasm_bindgen]
pub fn ed25519_private_key_to_pkcs8(private_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let signing_key = SigningKey::from_bytes(&bytes);
    signing_key
        .to_pkcs8_der()
        .map(|der| der.as_bytes().to_vec())
        .map_err(|_| JsValue::from_str("encode failed"))
}

/// Converts PKCS#8 DER to a 32-byte Ed25519 private key.
#[wasm_bindgen]
pub fn ed25519_private_key_from_pkcs8(private_key_der: &[u8]) -> Result<Vec<u8>, JsValue> {
    let signing_key = SigningKey::from_pkcs8_der(private_key_der)
        .map_err(|_| JsValue::from_str("invalid private key"))?;
    Ok(signing_key.to_bytes().to_vec())
}

/// Signs a message using a 32-byte Ed25519 private key.
#[wasm_bindgen]
pub fn ed25519_sign(private_key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let signing_key = SigningKey::from_bytes(&bytes);
    let signature: Signature = signing_key.sign(message);
    Ok(signature.to_bytes().to_vec())
}

/// Verifies a signature using a 32-byte Ed25519 public key.
#[wasm_bindgen]
pub fn ed25519_verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> Result<bool, JsValue> {
    let pk: [u8; 32] = public_key
        .try_into()
        .map_err(|_| JsValue::from_str("public_key must be 32 bytes"))?;
    let sig: [u8; 64] = signature
        .try_into()
        .map_err(|_| JsValue::from_str("signature must be 64 bytes"))?;

    let verifying_key = VerifyingKey::from_bytes(&pk)
        .map_err(|_| JsValue::from_str("invalid public_key"))?;
    let signature = Signature::from_bytes(&sig);

    Ok(verifying_key.verify_strict(message, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ed25519_sign_and_verify() {
        let private_key = [42u8; 32];
        let message = b"hello";
        let signature = ed25519_sign(&private_key, message).expect("sign");
        let public_key = ed25519_public_key(&private_key).expect("public");

        let ok = ed25519_verify(&public_key, message, &signature).expect("verify");
        assert!(ok);
    }
}
