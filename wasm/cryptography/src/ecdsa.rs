use wasm_bindgen::prelude::*;

use getrandom::getrandom;
use p256::ecdsa::{Signature as P256Signature, SigningKey as P256SigningKey, VerifyingKey as P256VerifyingKey};
use p256::pkcs8::{DecodePrivateKey as P256DecodePrivateKey, EncodePrivateKey as P256EncodePrivateKey};
use p256::SecretKey as P256SecretKey;
use p384::ecdsa::{Signature as P384Signature, SigningKey as P384SigningKey, VerifyingKey as P384VerifyingKey};
use p384::SecretKey as P384SecretKey;
use signature::{Signer, Verifier};

fn random_bytes<const N: usize>() -> Result<[u8; N], JsValue> {
    let mut bytes = [0u8; N];
    getrandom(&mut bytes).map_err(|_| JsValue::from_str("getrandom failed"))?;
    Ok(bytes)
}

fn p256_signing_key_from_random() -> Result<P256SigningKey, JsValue> {
    for _ in 0..32 {
        let bytes = random_bytes::<32>()?;
        if let Ok(key) = P256SigningKey::from_bytes(&bytes.into()) {
            return Ok(key);
        }
    }
    Err(JsValue::from_str("p256 key generation failed"))
}

fn p384_signing_key_from_random() -> Result<P384SigningKey, JsValue> {
    for _ in 0..32 {
        let bytes = random_bytes::<48>()?;
        if let Ok(key) = P384SigningKey::from_bytes(&bytes.into()) {
            return Ok(key);
        }
    }
    Err(JsValue::from_str("p384 key generation failed"))
}

/// Generates a new ECDSA P-256 keypair.
///
/// Returns 96 bytes: [private_key(32) || public_key_uncompressed(65)]
#[wasm_bindgen]
pub fn ecdsa_p256_generate_keypair() -> Result<Vec<u8>, JsValue> {
    let signing_key = p256_signing_key_from_random()?;
    let verifying_key = P256VerifyingKey::from(&signing_key);

    let mut out = Vec::with_capacity(97);
    out.extend_from_slice(signing_key.to_bytes().as_slice());
    out.extend_from_slice(verifying_key.to_encoded_point(false).as_bytes());
    Ok(out)
}

/// Signs a message using a 32-byte ECDSA P-256 private key.
#[wasm_bindgen]
pub fn ecdsa_p256_sign(private_key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let signing_key = P256SigningKey::from_bytes(&bytes.into())
        .map_err(|_| JsValue::from_str("invalid private_key"))?;
    let signature: P256Signature = signing_key.sign(message);
    Ok(signature.to_der().as_bytes().to_vec())
}

/// Derives the P-256 public key from a 32-byte private key (uncompressed SEC1).
#[wasm_bindgen]
pub fn ecdsa_p256_public_key(private_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let signing_key = P256SigningKey::from_bytes(&bytes.into())
        .map_err(|_| JsValue::from_str("invalid private_key"))?;
    let verifying_key = P256VerifyingKey::from(&signing_key);
    Ok(verifying_key.to_encoded_point(false).as_bytes().to_vec())
}

/// Verifies a DER-encoded signature using a P-256 uncompressed public key (65 bytes).
#[wasm_bindgen]
pub fn ecdsa_p256_verify(public_key_uncompressed: &[u8], message: &[u8], signature_der: &[u8]) -> Result<bool, JsValue> {
    let verifying_key = P256VerifyingKey::from_sec1_bytes(public_key_uncompressed)
        .map_err(|_| JsValue::from_str("invalid public_key"))?;
    let signature = P256Signature::from_der(signature_der)
        .map_err(|_| JsValue::from_str("invalid signature"))?;
    Ok(verifying_key.verify(message, &signature).is_ok())
}

/// Generates a new ECDSA P-384 keypair.
///
/// Returns 113 bytes: [private_key(48) || public_key_uncompressed(97)]
#[wasm_bindgen]
pub fn ecdsa_p384_generate_keypair() -> Result<Vec<u8>, JsValue> {
    let signing_key = p384_signing_key_from_random()?;
    let verifying_key = P384VerifyingKey::from(&signing_key);

    let mut out = Vec::with_capacity(145);
    out.extend_from_slice(signing_key.to_bytes().as_slice());
    out.extend_from_slice(verifying_key.to_encoded_point(false).as_bytes());
    Ok(out)
}

/// Signs a message using a 48-byte ECDSA P-384 private key.
#[wasm_bindgen]
pub fn ecdsa_p384_sign(private_key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 48] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 48 bytes"))?;
    let signing_key = P384SigningKey::from_bytes(&bytes.into())
        .map_err(|_| JsValue::from_str("invalid private_key"))?;
    let signature: P384Signature = signing_key.sign(message);
    Ok(signature.to_der().as_bytes().to_vec())
}

/// Derives the P-384 public key from a 48-byte private key (uncompressed SEC1).
#[wasm_bindgen]
pub fn ecdsa_p384_public_key(private_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 48] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 48 bytes"))?;
    let signing_key = P384SigningKey::from_bytes(&bytes.into())
        .map_err(|_| JsValue::from_str("invalid private_key"))?;
    let verifying_key = P384VerifyingKey::from(&signing_key);
    Ok(verifying_key.to_encoded_point(false).as_bytes().to_vec())
}

/// Converts a 32-byte ECDSA P-256 private key to PKCS#8 DER.
#[wasm_bindgen]
pub fn ecdsa_p256_private_key_to_pkcs8(private_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 32] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 32 bytes"))?;
    let secret_key = P256SecretKey::from_bytes(&bytes.into())
        .map_err(|_| JsValue::from_str("invalid private_key"))?;
    secret_key
        .to_pkcs8_der()
        .map(|der| der.as_bytes().to_vec())
        .map_err(|_| JsValue::from_str("encode failed"))
}

/// Converts PKCS#8 DER to a 32-byte ECDSA P-256 private key.
#[wasm_bindgen]
pub fn ecdsa_p256_private_key_from_pkcs8(private_key_der: &[u8]) -> Result<Vec<u8>, JsValue> {
    let secret_key = P256SecretKey::from_pkcs8_der(private_key_der)
        .map_err(|_| JsValue::from_str("invalid private key"))?;
    Ok(secret_key.to_bytes().to_vec())
}

/// Converts a 48-byte ECDSA P-384 private key to PKCS#8 DER.
#[wasm_bindgen]
pub fn ecdsa_p384_private_key_to_pkcs8(private_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bytes: [u8; 48] = private_key
        .try_into()
        .map_err(|_| JsValue::from_str("private_key must be 48 bytes"))?;
    let secret_key = P384SecretKey::from_bytes(&bytes.into())
        .map_err(|_| JsValue::from_str("invalid private_key"))?;
    secret_key
        .to_pkcs8_der()
        .map(|der| der.as_bytes().to_vec())
        .map_err(|_| JsValue::from_str("encode failed"))
}

/// Converts PKCS#8 DER to a 48-byte ECDSA P-384 private key.
#[wasm_bindgen]
pub fn ecdsa_p384_private_key_from_pkcs8(private_key_der: &[u8]) -> Result<Vec<u8>, JsValue> {
    let secret_key = P384SecretKey::from_pkcs8_der(private_key_der)
        .map_err(|_| JsValue::from_str("invalid private key"))?;
    Ok(secret_key.to_bytes().to_vec())
}

/// Verifies a DER-encoded signature using a P-384 uncompressed public key (97 bytes).
#[wasm_bindgen]
pub fn ecdsa_p384_verify(public_key_uncompressed: &[u8], message: &[u8], signature_der: &[u8]) -> Result<bool, JsValue> {
    let verifying_key = P384VerifyingKey::from_sec1_bytes(public_key_uncompressed)
        .map_err(|_| JsValue::from_str("invalid public_key"))?;
    let signature = P384Signature::from_der(signature_der)
        .map_err(|_| JsValue::from_str("invalid signature"))?;
    Ok(verifying_key.verify(message, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p256_sign_and_verify() {
        let keypair = ecdsa_p256_generate_keypair().expect("keypair");
        let private_key = &keypair[..32];
        let public_key = &keypair[32..];
        let message = b"hello p256";

        let signature = ecdsa_p256_sign(private_key, message).expect("sign");
        let ok = ecdsa_p256_verify(public_key, message, &signature).expect("verify");
        assert!(ok);

        let derived = ecdsa_p256_public_key(private_key).expect("public");
        assert_eq!(derived, public_key);
    }

    #[test]
    fn p384_sign_and_verify() {
        let keypair = ecdsa_p384_generate_keypair().expect("keypair");
        let private_key = &keypair[..48];
        let public_key = &keypair[48..];
        let message = b"hello p384";

        let signature = ecdsa_p384_sign(private_key, message).expect("sign");
        let ok = ecdsa_p384_verify(public_key, message, &signature).expect("verify");
        assert!(ok);

        let derived = ecdsa_p384_public_key(private_key).expect("public");
        assert_eq!(derived, public_key);
    }

    #[test]
    fn p256_verify_fails_on_modified_message() {
        let keypair = ecdsa_p256_generate_keypair().expect("keypair");
        let private_key = &keypair[..32];
        let public_key = &keypair[32..];
        let signature = ecdsa_p256_sign(private_key, b"hello").expect("sign");

        let ok = ecdsa_p256_verify(public_key, b"hell0", &signature).expect("verify");
        assert!(!ok);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn p384_rejects_invalid_signature() {
        let keypair = ecdsa_p384_generate_keypair().expect("keypair");
        let public_key = &keypair[48..];
        let bad_signature = [0u8; 5];
        assert!(ecdsa_p384_verify(public_key, b"hello", &bad_signature).is_err());
    }
}
