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
    use hex;

    fn hex_to_bytes(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    #[test]
    fn hmac_sha256_test_vector() {
        // Test vector from RFC 4231
        let key = hex_to_bytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        let message = b"Hi There";
        let expected =
            hex_to_bytes("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");

        let result = hmac_sha256(&key, message).unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn hmac_sha512_test_vector() {
        // Test vector from RFC 4231
        let key = hex_to_bytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        let message = b"Hi There";
        let expected = hex_to_bytes("87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854");

        let result = hmac_sha512(&key, message).unwrap();
        assert_eq!(result, expected);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn hmac_sha256_wasm() {
        let key = b"key";
        let message = b"message";
        let result = hmac_sha256(key, message).unwrap();
        assert_eq!(result.len(), 32); // SHA256 output is 32 bytes
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn hmac_sha512_wasm() {
        let key = b"key";
        let message = b"message";
        let result = hmac_sha512(key, message).unwrap();
        assert_eq!(result.len(), 64); // SHA512 output is 64 bytes
    }
}
