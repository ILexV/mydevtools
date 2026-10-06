use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use hmac::{Hmac, Mac};
use sha2::{Sha256, Sha384, Sha512};
use rsa::{Pkcs1v15Sign, RsaPublicKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::pkcs1::DecodeRsaPublicKey;

type HmacSha256 = Hmac<Sha256>;
type HmacSha384 = Hmac<Sha384>;
type HmacSha512 = Hmac<Sha512>;

#[derive(Serialize, Deserialize)]
struct JwtParts {
    header: String,
    payload: String,
}

#[derive(Serialize, Deserialize)]
struct JwtHeader {
    typ: Option<String>,
    alg: String,
}

#[wasm_bindgen]
pub fn jwt_decode(token: &str) -> Result<String, JsValue> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return Err(JsValue::from_str("Invalid JWT format"));
    }

    let header_bytes = base64_url_decode(parts[0])
        .map_err(|e| JsValue::from_str(&format!("Header decode error: {}", e)))?;
    let payload_bytes = base64_url_decode(parts[1])
        .map_err(|e| JsValue::from_str(&format!("Payload decode error: {}", e)))?;

    let header_decoded = String::from_utf8(header_bytes)
        .map_err(|e| JsValue::from_str(&format!("Header invalid UTF-8: {}", e)))?;
    let payload_decoded = String::from_utf8(payload_bytes)
        .map_err(|e| JsValue::from_str(&format!("Payload invalid UTF-8: {}", e)))?;

    let header_json: serde_json::Value = serde_json::from_str(&header_decoded)
        .unwrap_or(serde_json::Value::String(header_decoded));
    let payload_json: serde_json::Value = serde_json::from_str(&payload_decoded)
        .unwrap_or(serde_json::Value::String(payload_decoded));

    let result = JwtParts {
        header: serde_json::to_string_pretty(&header_json).unwrap_or_default(),
        payload: serde_json::to_string_pretty(&payload_json).unwrap_or_default(),
    };

    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn jwt_sign(header_json: &str, payload_json: &str, secret: &str, alg: &str) -> Result<String, JsValue> {
    let mut header: JwtHeader = serde_json::from_str(header_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid header JSON: {}", e)))?;
    header.alg = alg.to_string();
    
    let header_part = base64_url_encode(serde_json::to_string(&header).map_err(|e| e.to_string())?.as_bytes());
    
    let payload_val: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid payload JSON: {}", e)))?;
    let payload_part = base64_url_encode(serde_json::to_string(&payload_val).map_err(|e| e.to_string())?.as_bytes());
    
    let message = format!("{}.{}", header_part, payload_part);
    let signature_bytes = sign_message(&message, secret, alg)?;
    let signature_part = base64_url_encode(&signature_bytes);
    
    Ok(format!("{}.{}", message, signature_part))
}

#[wasm_bindgen]
pub fn jwt_verify(token: &str, secret: &str, alg: &str) -> Result<bool, JsValue> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Ok(false);
    }
    
    let message = format!("{}.{}", parts[0], parts[1]);
    let signature = base64_url_decode(parts[2]).map_err(|e| JsValue::from_str(&e))?;
    
    verify_signature(&message, &signature, secret, alg)
}

/// Signs a ready JWS signing input (`base64url(header).base64url(payload)`) and
/// returns the base64url signature segment. Lets the JWT encoder build the
/// header/payload segments itself (preserving claim order and extra header
/// fields such as `kid`, which `jwt_sign` drops) and only delegate the HMAC.
#[wasm_bindgen]
pub fn jwt_sign_input(signing_input: &str, secret: &str, alg: &str) -> Result<String, JsValue> {
    Ok(base64_url_encode(&sign_message(signing_input, secret, alg)?))
}

fn sign_message(message: &str, secret: &str, alg: &str) -> Result<Vec<u8>, JsValue> {
    match alg {
        "HS256" => {
            let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
                .map_err(|_| JsValue::from_str("Invalid key length"))?;
            mac.update(message.as_bytes());
            Ok(mac.finalize().into_bytes().to_vec())
        },
        "HS384" => {
            let mut mac = HmacSha384::new_from_slice(secret.as_bytes())
                .map_err(|_| JsValue::from_str("Invalid key length"))?;
            mac.update(message.as_bytes());
            Ok(mac.finalize().into_bytes().to_vec())
        },
        "HS512" => {
            let mut mac = HmacSha512::new_from_slice(secret.as_bytes())
                .map_err(|_| JsValue::from_str("Invalid key length"))?;
            mac.update(message.as_bytes());
            Ok(mac.finalize().into_bytes().to_vec())
        },
        "RS256" => Err(JsValue::from_str("RS256 signing not implemented (requires Private Key Parser)")),
        _ => Err(JsValue::from_str("Unsupported algorithm")),
    }
}

fn verify_signature(message: &str, signature: &[u8], secret: &str, alg: &str) -> Result<bool, JsValue> {
    match alg {
        "HS256" => {
            let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
                .map_err(|_| JsValue::from_str("Invalid key length"))?;
            mac.update(message.as_bytes());
            Ok(mac.verify_slice(signature).is_ok())
        },
        "HS384" => {
            let mut mac = HmacSha384::new_from_slice(secret.as_bytes())
                .map_err(|_| JsValue::from_str("Invalid key length"))?;
            mac.update(message.as_bytes());
            Ok(mac.verify_slice(signature).is_ok())
        },
        "HS512" => {
            let mut mac = HmacSha512::new_from_slice(secret.as_bytes())
                .map_err(|_| JsValue::from_str("Invalid key length"))?;
            mac.update(message.as_bytes());
            Ok(mac.verify_slice(signature).is_ok())
        },
        "RS256" => {
            let pub_key = RsaPublicKey::from_public_key_pem(secret)
                .or_else(|_| RsaPublicKey::from_pkcs1_pem(secret))
                .map_err(|e| JsValue::from_str(&format!("Invalid RSA PEM: {}", e)))?;
            
            use sha2::Digest;
            let mut hasher = Sha256::new();
            hasher.update(message.as_bytes());
            let hashed = hasher.finalize();
            
            pub_key.verify(Pkcs1v15Sign::new::<Sha256>(), &hashed, signature)
                .map(|_| true)
                .or(Ok(false))
        },
         "RS384" => {
            let pub_key = RsaPublicKey::from_public_key_pem(secret)
                .or_else(|_| RsaPublicKey::from_pkcs1_pem(secret))
                .map_err(|e| JsValue::from_str(&format!("Invalid RSA PEM: {}", e)))?;
             
            use sha2::Digest;
            let mut hasher = Sha384::new();
            hasher.update(message.as_bytes());
            let hashed = hasher.finalize();
            
            pub_key.verify(Pkcs1v15Sign::new::<Sha384>(), &hashed, signature)
                .map(|_| true)
                .or(Ok(false))
         },
          "RS512" => {
             let pub_key = RsaPublicKey::from_public_key_pem(secret)
                .or_else(|_| RsaPublicKey::from_pkcs1_pem(secret))
                .map_err(|e| JsValue::from_str(&format!("Invalid RSA PEM: {}", e)))?;
             
            use sha2::Digest;
            let mut hasher = Sha512::new();
            hasher.update(message.as_bytes());
            let hashed = hasher.finalize();
            
            pub_key.verify(Pkcs1v15Sign::new::<Sha512>(), &hashed, signature)
                .map(|_| true)
                .or(Ok(false))
         },
        _ => Err(JsValue::from_str("Unsupported algorithm")),
    }
}

fn base64_url_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.decode(input).map_err(|e| e.to_string())
}

fn base64_url_encode(input: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 7515 / jwt.io reference token (HS256, secret "your-256-bit-secret").
    const JWT_IO_HEADER: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const JWT_IO_PAYLOAD: &str = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    const JWT_IO_SIG: &str = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    fn jwt_io_token() -> String {
        format!("{JWT_IO_HEADER}.{JWT_IO_PAYLOAD}.{JWT_IO_SIG}")
    }

    #[test]
    fn sign_input_matches_jwt_io_vector() {
        let input = format!("{JWT_IO_HEADER}.{JWT_IO_PAYLOAD}");
        assert_eq!(jwt_sign_input(&input, "your-256-bit-secret", "HS256").unwrap(), JWT_IO_SIG);
    }

    #[test]
    fn sign_input_hs384_hs512_lengths_and_empty_secret() {
        let sig384 = jwt_sign_input("a.b", "k", "HS384").unwrap();
        let sig512 = jwt_sign_input("a.b", "k", "HS512").unwrap();
        assert_eq!(base64_url_decode(&sig384).unwrap().len(), 48);
        assert_eq!(base64_url_decode(&sig512).unwrap().len(), 64);
        // HMAC accepts an empty key (legacy behavior: token is still produced).
        assert!(jwt_sign_input("a.b", "", "HS256").is_ok());
    }

    #[test]
    fn verify_jwt_io_vector_and_tampering() {
        let token = jwt_io_token();
        assert!(jwt_verify(&token, "your-256-bit-secret", "HS256").unwrap());
        assert!(!jwt_verify(&token, "wrong-secret", "HS256").unwrap());
        let tampered = token.replacen(JWT_IO_PAYLOAD, "eyJzdWIiOiIwIn0", 1);
        assert!(!jwt_verify(&tampered, "your-256-bit-secret", "HS256").unwrap());
        // Wrong part count is "not verified", not an error.
        assert!(!jwt_verify("a.b", "s", "HS256").unwrap());
        assert!(!jwt_verify("a.b.c.d", "s", "HS256").unwrap());
    }

    #[test]
    fn sign_then_verify_round_trip_all_hmac_algs() {
        for alg in ["HS256", "HS384", "HS512"] {
            let token = jwt_sign(r#"{"typ":"JWT","alg":"HS256"}"#, r#"{"sub":"ü"}"#, "s3cr3t", alg).unwrap();
            assert_eq!(token.split('.').count(), 3);
            assert!(jwt_verify(&token, "s3cr3t", alg).unwrap(), "{alg}");
            assert!(!jwt_verify(&token, "other", alg).unwrap(), "{alg}");
        }
    }

    #[test]
    fn decode_jwt_io_vector_pretty_json() {
        let decoded: serde_json::Value = serde_json::from_str(&jwt_decode(&jwt_io_token()).unwrap()).unwrap();
        let header: serde_json::Value = serde_json::from_str(decoded["header"].as_str().unwrap()).unwrap();
        let payload: serde_json::Value = serde_json::from_str(decoded["payload"].as_str().unwrap()).unwrap();
        assert_eq!(header["alg"], "HS256");
        assert_eq!(payload["name"], "John Doe");
        assert_eq!(payload["iat"], 1516239022);
    }

    #[test]
    fn decode_unsigned_alg_none_token() {
        // {"alg":"none"}.{"sub":"x"}. — decodes; verification is the caller's concern.
        let decoded = jwt_decode("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.").unwrap();
        assert!(decoded.contains("none"));
    }
}
