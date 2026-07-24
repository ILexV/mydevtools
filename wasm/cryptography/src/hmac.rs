use hmac::{Hmac, Mac};
use sha2::{Sha256, Sha512};
use wasm_bindgen::prelude::*;

/// Computes HMAC-SHA256
#[wasm_bindgen]
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key).map_err(|_| JsValue::from_str("invalid key length"))?;
    mac.update(message);
    let result = mac.finalize().into_bytes();
    Ok(result.to_vec())
}

/// Computes HMAC-SHA512
#[wasm_bindgen]
pub fn hmac_sha512(key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut mac =
        Hmac::<Sha512>::new_from_slice(key).map_err(|_| JsValue::from_str("invalid key length"))?;
    mac.update(message);
    let result = mac.finalize().into_bytes();
    Ok(result.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_to_bytes(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    /// RFC 4231 §4, Test Case 1: 20-byte key (0x0b), data "Hi There".
    #[test]
    fn hmac_sha256_test_vector() {
        let key = hex_to_bytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"); // 20 bytes
        let message = b"Hi There";
        let expected =
            hex_to_bytes("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        assert_eq!(hmac_sha256(&key, message).unwrap(), expected);
    }

    /// RFC 4231 §4, Test Case 1 (SHA-512): same 20-byte key + "Hi There".
    #[test]
    fn hmac_sha512_test_vector() {
        let key = hex_to_bytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"); // 20 bytes
        let message = b"Hi There";
        let expected = hex_to_bytes("87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854");
        assert_eq!(hmac_sha512(&key, message).unwrap(), expected);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn hmac_sha256_wasm() {
        assert_eq!(hmac_sha256(b"key", b"message").unwrap().len(), 32);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn hmac_sha512_wasm() {
        assert_eq!(hmac_sha512(b"key", b"message").unwrap().len(), 64);
    }
}
