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
