use wasm_bindgen::prelude::*;

use crate::signing;

const SIG_MAGIC: [u8; 4] = *b"MDS1";
const SIG_VERSION: u8 = 1;

fn write_u32_be(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn read_u32_be(data: &[u8], pos: &mut usize) -> Result<u32, JsValue> {
    if *pos + 4 > data.len() {
        return Err(JsValue::from_str("invalid data length"));
    }
    let value = u32::from_be_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
    *pos += 4;
    Ok(value)
}

fn parse_signature_header(data: &[u8]) -> Result<(u8, u32, usize), JsValue> {
    if data.len() < 10 {
        return Err(JsValue::from_str("data too короткие для header"));
    }
    if data[0..4] != SIG_MAGIC {
        return Err(JsValue::from_str("invalid magic"));
    }
    if data[4] != SIG_VERSION {
        return Err(JsValue::from_str("unsupported version"));
    }

    let algorithm = data[5];
    let mut offset = 6usize;
    let sig_len = read_u32_be(data, &mut offset)?;
    let header_len = offset;

    if data.len() < header_len + sig_len as usize {
        return Err(JsValue::from_str("invalid signature length"));
    }

    Ok((algorithm, sig_len, header_len))
}

/// Packs a detached signature with a tiny header.
///
/// Format: "MDS1" + version(1) + alg(1) + sig_len(u32) + sig_bytes
#[wasm_bindgen]
pub fn detached_signature_pack(algorithm: u8, signature: &[u8]) -> Result<Vec<u8>, JsValue> {
    if signature.len() > u32::MAX as usize {
        return Err(JsValue::from_str("signature too long"));
    }

    let mut out = Vec::with_capacity(10 + signature.len());
    out.extend_from_slice(&SIG_MAGIC);
    out.push(SIG_VERSION);
    out.push(algorithm);
    write_u32_be(&mut out, signature.len() as u32);
    out.extend_from_slice(signature);
    Ok(out)
}

/// Returns header info: [algorithm, sig_len, header_len].
#[wasm_bindgen]
pub fn detached_signature_info(data: &[u8]) -> Result<Vec<u32>, JsValue> {
    let (algorithm, sig_len, header_len) = parse_signature_header(data)?;
    Ok(vec![algorithm as u32, sig_len, header_len as u32])
}

/// Extracts the raw signature bytes.
#[wasm_bindgen]
pub fn detached_signature_extract(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (_, sig_len, header_len) = parse_signature_header(data)?;
    Ok(data[header_len..header_len + sig_len as usize].to_vec())
}

/// Signs data with selected algorithm and packs into detached signature format.
#[wasm_bindgen]
pub fn detached_sign_and_pack(algorithm: u8, private_key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    let signature = signing::sign_detached(algorithm, private_key, message)?;
    detached_signature_pack(algorithm, &signature)
}

/// Verifies packed detached signature (algorithm is read from header).
#[wasm_bindgen]
pub fn detached_verify_packed(public_key: &[u8], message: &[u8], packed: &[u8]) -> Result<bool, JsValue> {
    let (algorithm, _sig_len, _header_len) = parse_signature_header(packed)?;
    let signature = detached_signature_extract(packed)?;
    signing::verify_detached(algorithm, public_key, message, &signature)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detached_signature_roundtrip() {
        let sig = [0xABu8; 64];
        let packed = detached_signature_pack(1, &sig).expect("pack");
        let info = detached_signature_info(&packed).expect("info");
        assert_eq!(info[0], 1);
        assert_eq!(info[1], 64);

        let out = detached_signature_extract(&packed).expect("extract");
        assert_eq!(out, sig);
    }

    #[test]
    fn detached_sign_and_verify_packed() {
        let private_key = [7u8; 32];
        let public_key = crate::ed25519::ed25519_public_key(&private_key).expect("public");
        let message = b"hello";

        let packed = detached_sign_and_pack(signing::SIG_ALG_ED25519, &private_key, message).expect("pack");
        let ok = detached_verify_packed(&public_key, message, &packed).expect("verify");
        assert!(ok);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn detached_signature_invalid_magic() {
        let data = [0u8; 8];
        assert!(detached_signature_info(&data).is_err());
    }

    #[test]
    fn detached_verify_fails_on_tampered_signature() {
        let private_key = [7u8; 32];
        let public_key = crate::ed25519::ed25519_public_key(&private_key).expect("public");
        let message = b"hello";

        let mut packed = detached_sign_and_pack(signing::SIG_ALG_ED25519, &private_key, message).expect("pack");
        let last = packed.len() - 1;
        packed[last] ^= 0xFF;

        let ok = detached_verify_packed(&public_key, message, &packed).expect("verify");
        assert!(!ok);
    }
}
