use wasm_bindgen::prelude::*;

use crate::ecdsa;
use crate::ed25519;

pub const SIG_ALG_ED25519: u8 = 1;
pub const SIG_ALG_ECDSA_P256: u8 = 2;
pub const SIG_ALG_ECDSA_P384: u8 = 3;

/// Signs data using selected algorithm.
///
/// Algorithms:
/// 1 = Ed25519 (signature = 64 bytes)
/// 2 = ECDSA P-256 (signature = DER)
/// 3 = ECDSA P-384 (signature = DER)
#[wasm_bindgen]
pub fn sign_detached(algorithm: u8, private_key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    match algorithm {
        SIG_ALG_ED25519 => ed25519::ed25519_sign(private_key, message),
        SIG_ALG_ECDSA_P256 => ecdsa::ecdsa_p256_sign(private_key, message),
        SIG_ALG_ECDSA_P384 => ecdsa::ecdsa_p384_sign(private_key, message),
        _ => Err(JsValue::from_str("unknown algorithm")),
    }
}

/// Verifies a detached signature using selected algorithm.
#[wasm_bindgen]
pub fn verify_detached(algorithm: u8, public_key: &[u8], message: &[u8], signature: &[u8]) -> Result<bool, JsValue> {
    match algorithm {
        SIG_ALG_ED25519 => ed25519::ed25519_verify(public_key, message, signature),
        SIG_ALG_ECDSA_P256 => ecdsa::ecdsa_p256_verify(public_key, message, signature),
        SIG_ALG_ECDSA_P384 => ecdsa::ecdsa_p384_verify(public_key, message, signature),
        _ => Err(JsValue::from_str("unknown algorithm")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_ed25519() {
        let private_key = [7u8; 32];
        let message = b"hello";
        let signature = sign_detached(SIG_ALG_ED25519, &private_key, message).expect("sign");
        let public_key = ed25519::ed25519_public_key(&private_key).expect("public");
        let ok = verify_detached(SIG_ALG_ED25519, &public_key, message, &signature).expect("verify");
        assert!(ok);
    }

    #[test]
    fn sign_verify_p256() {
        let keypair = ecdsa::ecdsa_p256_generate_keypair().expect("keypair");
        let private_key = &keypair[..32];
        let public_key = &keypair[32..];
        let message = b"hello";
        let signature = sign_detached(SIG_ALG_ECDSA_P256, private_key, message).expect("sign");
        let ok = verify_detached(SIG_ALG_ECDSA_P256, public_key, message, &signature).expect("verify");
        assert!(ok);
    }

    #[test]
    fn sign_verify_p384() {
        let keypair = ecdsa::ecdsa_p384_generate_keypair().expect("keypair");
        let private_key = &keypair[..48];
        let public_key = &keypair[48..];
        let message = b"hello";
        let signature = sign_detached(SIG_ALG_ECDSA_P384, private_key, message).expect("sign");
        let ok = verify_detached(SIG_ALG_ECDSA_P384, public_key, message, &signature).expect("verify");
        assert!(ok);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn sign_verify_unknown_algorithm() {
        let private_key = [7u8; 32];
        let public_key = ed25519::ed25519_public_key(&private_key).expect("public");
        assert!(sign_detached(99, &private_key, b"msg").is_err());
        assert!(verify_detached(99, &public_key, b"msg", &[0u8; 64]).is_err());
    }
}
