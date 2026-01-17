use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_encoding@0.1.0".to_string()
}

// ============================================================================
// Charset encoding/decoding
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Charset {
    Utf8,
    Utf16Le,
    Utf16Be,
    Ascii,
    Latin1,
}

impl Charset {
    fn parse(s: &str) -> Result<Self, String> {
        match s.to_lowercase().as_str() {
            "utf-8" => Ok(Self::Utf8),
            "utf-16le" => Ok(Self::Utf16Le),
            "utf-16be" => Ok(Self::Utf16Be),
            "ascii" => Ok(Self::Ascii),
            "latin1" => Ok(Self::Latin1),
            _ => Err(format!("Unknown charset: {}", s)),
        }
    }

    fn encode_text_to_bytes(&self, text: &str) -> Result<Vec<u8>, String> {
        match self {
            Self::Utf8 => Ok(text.as_bytes().to_vec()),
            Self::Utf16Le => {
                let mut bytes = Vec::with_capacity(text.len() * 2);
                for ch in text.chars() {
                    let code = ch as u32;
                    if code > 0xFFFF {
                        // Surrogate pair
                        let code = code - 0x10000;
                        let high = 0xD800 + ((code >> 10) & 0x3FF);
                        let low = 0xDC00 + (code & 0x3FF);
                        bytes.extend_from_slice(&(high as u16).to_le_bytes());
                        bytes.extend_from_slice(&(low as u16).to_le_bytes());
                    } else {
                        bytes.extend_from_slice(&(code as u16).to_le_bytes());
                    }
                }
                Ok(bytes)
            }
            Self::Utf16Be => {
                let mut bytes = Vec::with_capacity(text.len() * 2);
                for ch in text.chars() {
                    let code = ch as u32;
                    if code > 0xFFFF {
                        // Surrogate pair
                        let code = code - 0x10000;
                        let high = 0xD800 + ((code >> 10) & 0x3FF);
                        let low = 0xDC00 + (code & 0x3FF);
                        bytes.extend_from_slice(&(high as u16).to_be_bytes());
                        bytes.extend_from_slice(&(low as u16).to_be_bytes());
                    } else {
                        bytes.extend_from_slice(&(code as u16).to_be_bytes());
                    }
                }
                Ok(bytes)
            }
            Self::Ascii => {
                let mut bytes = Vec::with_capacity(text.len());
                for ch in text.chars() {
                    let code = ch as u32;
                    if code > 0x7F {
                        return Err(format!("Non-ASCII character at position {}", bytes.len()));
                    }
                    bytes.push(code as u8);
                }
                Ok(bytes)
            }
            Self::Latin1 => {
                let mut bytes = Vec::with_capacity(text.len());
                for ch in text.chars() {
                    let code = ch as u32;
                    if code > 0xFF {
                        return Err(format!("Character not representable in Latin-1 at position {}", bytes.len()));
                    }
                    bytes.push(code as u8);
                }
                Ok(bytes)
            }
        }
    }

    fn decode_bytes_to_text(&self, bytes: &[u8]) -> Result<String, String> {
        match self {
            Self::Utf8 => {
                String::from_utf8(bytes.to_vec())
                    .map_err(|e| format!("Invalid UTF-8: {}", e))
            }
            Self::Utf16Le => {
                if bytes.len() % 2 != 0 {
                    return Err("Odd number of bytes for UTF-16LE".to_string());
                }
                let mut chars = Vec::new();
                let mut i = 0;
                while i < bytes.len() {
                    let code = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
                    if (0xD800..=0xDBFF).contains(&code) {
                        // High surrogate
                        if i + 3 >= bytes.len() {
                            return Err("Truncated UTF-16LE surrogate pair".to_string());
                        }
                        let low = u16::from_le_bytes([bytes[i + 2], bytes[i + 3]]);
                        if !(0xDC00..=0xDFFF).contains(&low) {
                            return Err("Invalid UTF-16LE surrogate pair".to_string());
                        }
                        let code_point = 0x10000 + (((code as u32 - 0xD800) << 10) | (low as u32 - 0xDC00));
                        chars.push(char::from_u32(code_point).ok_or("Invalid code point")?);
                        i += 4;
                    } else {
                        chars.push(char::from_u32(code as u32).ok_or("Invalid code point")?);
                        i += 2;
                    }
                }
                Ok(chars.into_iter().collect())
            }
            Self::Utf16Be => {
                if bytes.len() % 2 != 0 {
                    return Err("Odd number of bytes for UTF-16BE".to_string());
                }
                let mut chars = Vec::new();
                let mut i = 0;
                while i < bytes.len() {
                    let code = u16::from_be_bytes([bytes[i], bytes[i + 1]]);
                    if (0xD800..=0xDBFF).contains(&code) {
                        // High surrogate
                        if i + 3 >= bytes.len() {
                            return Err("Truncated UTF-16BE surrogate pair".to_string());
                        }
                        let low = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]);
                        if !(0xDC00..=0xDFFF).contains(&low) {
                            return Err("Invalid UTF-16BE surrogate pair".to_string());
                        }
                        let code_point = 0x10000 + (((code as u32 - 0xD800) << 10) | (low as u32 - 0xDC00));
                        chars.push(char::from_u32(code_point).ok_or("Invalid code point")?);
                        i += 4;
                    } else {
                        chars.push(char::from_u32(code as u32).ok_or("Invalid code point")?);
                        i += 2;
                    }
                }
                Ok(chars.into_iter().collect())
            }
            Self::Ascii => {
                for &b in bytes {
                    if b > 0x7F {
                        return Err(format!("Byte not representable in ASCII: 0x{:02x}", b));
                    }
                }
                Ok(bytes.iter().map(|&b| b as char).collect())
            }
            Self::Latin1 => {
                Ok(bytes.iter().map(|&b| b as char).collect())
            }
        }
    }
}

// ============================================================================
// Base64 encoding/decoding
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base64Alphabet {
    Standard,
    UrlSafe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaddingMode {
    Required,
    Optional,
    None,
}

fn base64_encode_bytes(
    bytes: &[u8],
    alphabet: Base64Alphabet,
    padding: PaddingMode,
    line_wrap: Option<usize>,
) -> String {
    use base64::{engine::general_purpose, Engine as _};
    
    let encoded = match alphabet {
        Base64Alphabet::Standard => {
            match padding {
                PaddingMode::None => general_purpose::STANDARD_NO_PAD.encode(bytes),
                _ => general_purpose::STANDARD.encode(bytes),
            }
        }
        Base64Alphabet::UrlSafe => {
            match padding {
                PaddingMode::None => general_purpose::URL_SAFE_NO_PAD.encode(bytes),
                _ => general_purpose::URL_SAFE.encode(bytes),
            }
        }
    };

    let mut result = encoded;
    
    // Handle line wrap
    if let Some(wrap_at) = line_wrap {
        if wrap_at > 0 {
            let mut wrapped = String::with_capacity(result.len() + (result.len() / wrap_at));
            let mut i = 0;
            while i < result.len() {
                let end = (i + wrap_at).min(result.len());
                wrapped.push_str(&result[i..end]);
                if end < result.len() {
                    wrapped.push('\n');
                }
                i = end;
            }
            result = wrapped;
        }
    }

    result
}

fn base64_decode_string(
    input: &str,
    alphabet: Base64Alphabet,
    padding: PaddingMode,
    allow_whitespace: bool,
) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose, Engine as _};
    
    let mut cleaned = input.to_string();
    
    if allow_whitespace {
        cleaned = cleaned.chars().filter(|c| !c.is_whitespace()).collect();
    } else if cleaned.chars().any(|c| c.is_whitespace()) {
        return Err("Whitespace not allowed".to_string());
    }

    if padding == PaddingMode::None && cleaned.contains('=') {
        return Err("Padding '=' is not allowed".to_string());
    }

    // Handle padding requirements
    let len = cleaned.len();
    let rem = len % 4;
    match padding {
        PaddingMode::Required => {
            if rem != 0 {
                return Err("Invalid Base64 length (padding required)".to_string());
            }
        }
        PaddingMode::Optional | PaddingMode::None => {
            if rem == 1 {
                return Err("Invalid Base64 length".to_string());
            }
        }
    }

    let engine = match (alphabet, padding) {
        (Base64Alphabet::Standard, PaddingMode::None) => &general_purpose::STANDARD_NO_PAD,
        (Base64Alphabet::Standard, _) => &general_purpose::STANDARD,
        (Base64Alphabet::UrlSafe, PaddingMode::None) => &general_purpose::URL_SAFE_NO_PAD,
        (Base64Alphabet::UrlSafe, _) => &general_purpose::URL_SAFE,
    };

    engine.decode(&cleaned)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

#[wasm_bindgen]
pub fn base64_encode(
    bytes: &[u8],
    alphabet: &str,
    padding: &str,
    line_wrap: Option<usize>,
) -> Result<String, JsValue> {
    let alphabet = match alphabet {
        "standard" => Base64Alphabet::Standard,
        "urlsafe" => Base64Alphabet::UrlSafe,
        _ => return Err(JsValue::from_str("Invalid alphabet")),
    };
    let padding = match padding {
        "required" => PaddingMode::Required,
        "optional" => PaddingMode::Optional,
        "none" => PaddingMode::None,
        _ => return Err(JsValue::from_str("Invalid padding mode")),
    };
    Ok(base64_encode_bytes(bytes, alphabet, padding, line_wrap))
}

#[wasm_bindgen]
pub fn base64_decode(
    input: &str,
    alphabet: &str,
    padding: &str,
    allow_whitespace: bool,
) -> Result<Vec<u8>, JsValue> {
    let alphabet = match alphabet {
        "standard" => Base64Alphabet::Standard,
        "urlsafe" => Base64Alphabet::UrlSafe,
        _ => return Err(JsValue::from_str("Invalid alphabet")),
    };
    let padding = match padding {
        "required" => PaddingMode::Required,
        "optional" => PaddingMode::Optional,
        "none" => PaddingMode::None,
        _ => return Err(JsValue::from_str("Invalid padding mode")),
    };
    base64_decode_string(input, alphabet, padding, allow_whitespace)
        .map_err(|e| JsValue::from_str(&e))
}

// ============================================================================
// Hex encoding/decoding
// ============================================================================

#[wasm_bindgen]
pub fn hex_encode(bytes: &[u8], upper: bool) -> String {
    if upper {
        bytes.iter().map(|b| format!("{:02X}", b)).collect()
    } else {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

fn is_hex_digit(c: char) -> bool {
    matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F')
}

fn hex_value(c: char) -> Option<u8> {
    match c {
        '0'..='9' => Some((c as u8) - b'0'),
        'a'..='f' => Some((c as u8) - b'a' + 10),
        'A'..='F' => Some((c as u8) - b'A' + 10),
        _ => None,
    }
}

#[wasm_bindgen]
pub fn hex_decode(
    input: &str,
    ignore_whitespace: bool,
    allow_separators: bool,
    allow_0x: bool,
) -> Result<Vec<u8>, JsValue> {
    let mut cleaned = input.to_string();
    
    // Remove 0x prefix if allowed
    if allow_0x && cleaned.starts_with("0x") || cleaned.starts_with("0X") {
        cleaned = cleaned[2..].to_string();
    }

    // Remove whitespace and separators
    cleaned = cleaned
        .chars()
        .filter(|c| {
            if ignore_whitespace && c.is_whitespace() {
                return false;
            }
            if allow_separators && (*c == ':' || *c == '-') {
                return false;
            }
            true
        })
        .collect();

    // Validate hex digits
    for (i, c) in cleaned.chars().enumerate() {
        if !is_hex_digit(c) {
            return Err(JsValue::from_str(&format!("Invalid hex character '{}' at position {}", c, i)));
        }
    }

    if cleaned.len() % 2 != 0 {
        return Err(JsValue::from_str("Invalid hex length (must be even)"));
    }

    let mut bytes = Vec::with_capacity(cleaned.len() / 2);
    let mut chars = cleaned.chars();
    while let (Some(high), Some(low)) = (chars.next(), chars.next()) {
        let high_val = hex_value(high).unwrap();
        let low_val = hex_value(low).unwrap();
        bytes.push((high_val << 4) | low_val);
    }

    Ok(bytes)
}

// ============================================================================
// Base32 encoding/decoding
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base32Alphabet {
    Rfc4648,
    Crockford,
    ZBase32,
}

fn base32_encode_bytes(
    bytes: &[u8],
    alphabet: Base32Alphabet,
    padding: PaddingMode,
    case: Option<&str>,
) -> String {
    use data_encoding::{BASE32, BASE32_NOPAD};
    
    let (encoded, use_padding) = match alphabet {
        Base32Alphabet::Rfc4648 => {
            match padding {
                PaddingMode::None => (BASE32_NOPAD.encode(bytes), false),
                _ => (BASE32.encode(bytes), true),
            }
        }
        Base32Alphabet::Crockford => {
            // Crockford uses RFC4648 but with different case handling
            match padding {
                PaddingMode::None => (BASE32_NOPAD.encode(bytes), false),
                _ => (BASE32.encode(bytes), true),
            }
        }
        Base32Alphabet::ZBase32 => {
            // z-base-32 uses lowercase and no padding
            let encoded = BASE32_NOPAD.encode(bytes).to_lowercase();
            (encoded, false)
        }
    };

    let mut result = encoded;
    
    // Handle padding
    match padding {
        PaddingMode::None => {
            result = result.trim_end_matches('=').to_string();
        }
        PaddingMode::Optional | PaddingMode::Required => {
            if !use_padding {
                result = result.trim_end_matches('=').to_string();
            }
        }
    }

    // Handle case
    match case {
        Some("upper") => result = result.to_uppercase(),
        Some("lower") => result = result.to_lowercase(),
        Some("auto") => {
            // Keep as is (usually uppercase from BASE32)
        }
        _ => {}
    }

    result
}

fn base32_decode_string(
    input: &str,
    _alphabet: Base32Alphabet,
    padding: PaddingMode,
    allow_whitespace: bool,
) -> Result<Vec<u8>, String> {
    use data_encoding::{BASE32, BASE32_NOPAD};
    
    let mut cleaned = input.to_string();
    
    if allow_whitespace {
        cleaned = cleaned.chars().filter(|c| !c.is_whitespace()).collect();
    } else if cleaned.chars().any(|c| c.is_whitespace()) {
        return Err("Whitespace not allowed".to_string());
    }

    // Normalize case for decoding (RFC4648 is case-insensitive)
    cleaned = cleaned.to_uppercase();

    // Handle padding
    if padding == PaddingMode::None && cleaned.contains('=') {
        return Err("Padding '=' is not allowed".to_string());
    }

    // Remove padding for decoding if needed
    let decoder = match padding {
        PaddingMode::None => &BASE32_NOPAD,
        _ => &BASE32,
    };

    decoder.decode(cleaned.as_bytes())
        .map_err(|e| format!("Base32 decode error: {}", e))
}

#[wasm_bindgen]
pub fn base32_encode(
    bytes: &[u8],
    alphabet: &str,
    padding: &str,
    case: Option<String>,
) -> Result<String, JsValue> {
    let alphabet = match alphabet {
        "rfc4648" => Base32Alphabet::Rfc4648,
        "crockford" => Base32Alphabet::Crockford,
        "zbase32" => Base32Alphabet::ZBase32,
        _ => return Err(JsValue::from_str("Invalid alphabet")),
    };
    let padding = match padding {
        "required" => PaddingMode::Required,
        "optional" => PaddingMode::Optional,
        "none" => PaddingMode::None,
        _ => return Err(JsValue::from_str("Invalid padding mode")),
    };
    Ok(base32_encode_bytes(bytes, alphabet, padding, case.as_deref()))
}

#[wasm_bindgen]
pub fn base32_decode(
    input: &str,
    alphabet: &str,
    padding: &str,
    allow_whitespace: bool,
) -> Result<Vec<u8>, JsValue> {
    let alphabet = match alphabet {
        "rfc4648" => Base32Alphabet::Rfc4648,
        "crockford" => Base32Alphabet::Crockford,
        "zbase32" => Base32Alphabet::ZBase32,
        _ => return Err(JsValue::from_str("Invalid alphabet")),
    };
    let padding = match padding {
        "required" => PaddingMode::Required,
        "optional" => PaddingMode::Optional,
        "none" => PaddingMode::None,
        _ => return Err(JsValue::from_str("Invalid padding mode")),
    };
    base32_decode_string(input, alphabet, padding, allow_whitespace)
        .map_err(|e| JsValue::from_str(&e))
}

// ============================================================================
// Base58 encoding/decoding
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base58Alphabet {
    Bitcoin,
    Flickr,
    Ripple,
}

fn base58_encode_bytes(bytes: &[u8], alphabet: Base58Alphabet) -> String {
    match alphabet {
        Base58Alphabet::Bitcoin => bs58::encode(bytes).into_string(),
        Base58Alphabet::Flickr => {
            // Flickr uses same alphabet as Bitcoin
            bs58::encode(bytes).into_string()
        }
        Base58Alphabet::Ripple => {
            // Ripple uses same alphabet as Bitcoin
            bs58::encode(bytes).into_string()
        }
    }
}

fn base58_decode_string(
    input: &str,
    _alphabet: Base58Alphabet,
    allow_whitespace: bool,
) -> Result<Vec<u8>, String> {
    let mut cleaned = input.to_string();
    
    if allow_whitespace {
        cleaned = cleaned.chars().filter(|c| !c.is_whitespace()).collect();
    } else if cleaned.chars().any(|c| c.is_whitespace()) {
        return Err("Whitespace not allowed".to_string());
    }

    bs58::decode(&cleaned)
        .into_vec()
        .map_err(|e| format!("Base58 decode error: {}", e))
}

#[wasm_bindgen]
pub fn base58_encode(bytes: &[u8], alphabet: &str) -> Result<String, JsValue> {
    // Base58 has O(n²) complexity and becomes very slow with large inputs
    // Limit to 1MB to prevent browser freezing
    const MAX_BASE58_SIZE: usize = 1024 * 1024; // 1 MB
    
    if bytes.len() > MAX_BASE58_SIZE {
        return Err(JsValue::from_str(&format!(
            "Base58 encoding is limited to {} bytes (1 MB). Input size: {} bytes. For larger files, use Base64 or Hex encoding instead.",
            MAX_BASE58_SIZE,
            bytes.len()
        )));
    }
    
    let alphabet = match alphabet {
        "bitcoin" => Base58Alphabet::Bitcoin,
        "flickr" => Base58Alphabet::Flickr,
        "ripple" => Base58Alphabet::Ripple,
        _ => return Err(JsValue::from_str("Invalid alphabet")),
    };
    Ok(base58_encode_bytes(bytes, alphabet))
}

#[wasm_bindgen]
pub fn base58_decode(
    input: &str,
    alphabet: &str,
    allow_whitespace: bool,
) -> Result<Vec<u8>, JsValue> {
    // Base58 has O(n²) complexity and becomes very slow with large inputs
    // Limit input length to prevent browser freezing
    const MAX_BASE58_INPUT_LEN: usize = 2_000_000; // ~1.4 MB of encoded data
    
    if input.len() > MAX_BASE58_INPUT_LEN {
        return Err(JsValue::from_str(&format!(
            "Base58 decoding is limited to {} characters. Input length: {} characters. For larger files, use Base64 or Hex encoding instead.",
            MAX_BASE58_INPUT_LEN,
            input.len()
        )));
    }
    
    let alphabet = match alphabet {
        "bitcoin" => Base58Alphabet::Bitcoin,
        "flickr" => Base58Alphabet::Flickr,
        "ripple" => Base58Alphabet::Ripple,
        _ => return Err(JsValue::from_str("Invalid alphabet")),
    };
    base58_decode_string(input, alphabet, allow_whitespace)
        .map_err(|e| JsValue::from_str(&e))
}

// ============================================================================
// URL encoding/decoding
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UrlMode {
    Component, // encodeURIComponent style
    Uri,        // encodeURI style
    Form,       // application/x-www-form-urlencoded
}

fn url_encode_bytes(bytes: &[u8], mode: UrlMode) -> String {
    match mode {
        UrlMode::Component => {
            // encodeURIComponent: encode everything except: A-Z a-z 0-9 - _ . ! ~ * ' ( )
            bytes.iter().map(|&b| {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{:02X}", b),
                }
            }).collect()
        }
        UrlMode::Uri => {
            // encodeURI: encode everything except: A-Z a-z 0-9 ; , / ? : @ & = + $ # - _ . ! ~ * ' ( )
            bytes.iter().map(|&b| {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b';' | b',' | b'/' | b'?' | b':' | b'@' | b'&' | b'=' | b'+' | b'$' | b'#' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{:02X}", b),
                }
            }).collect()
        }
        UrlMode::Form => {
            // application/x-www-form-urlencoded: space becomes +, encode most special chars
            bytes.iter().map(|&b| {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                        (b as char).to_string()
                    }
                    b' ' => "+".to_string(),
                    _ => format!("%{:02X}", b),
                }
            }).collect()
        }
    }
}

fn url_decode_string(input: &str, mode: UrlMode) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chars = input.chars().peekable();
    
    while let Some(ch) = chars.next() {
        match ch {
            '%' => {
                let high = chars.next().ok_or("Truncated % encoding")?;
                let low = chars.next().ok_or("Truncated % encoding")?;
                let byte = u8::from_str_radix(&format!("{}{}", high, low), 16)
                    .map_err(|_| format!("Invalid hex in % encoding: {}{}", high, low))?;
                bytes.push(byte);
            }
            '+' if mode == UrlMode::Form => {
                bytes.push(b' ');
            }
            _ => {
                let mut buf = [0; 4];
                let encoded = ch.encode_utf8(&mut buf);
                bytes.extend_from_slice(encoded.as_bytes());
            }
        }
    }
    
    Ok(bytes)
}

#[wasm_bindgen]
pub fn url_encode(bytes: &[u8], mode: &str) -> Result<String, JsValue> {
    let mode = match mode {
        "component" => UrlMode::Component,
        "uri" => UrlMode::Uri,
        "form" => UrlMode::Form,
        _ => return Err(JsValue::from_str("Invalid mode")),
    };
    Ok(url_encode_bytes(bytes, mode))
}

#[wasm_bindgen]
pub fn url_decode(input: &str, mode: &str) -> Result<Vec<u8>, JsValue> {
    let mode = match mode {
        "component" => UrlMode::Component,
        "uri" => UrlMode::Uri,
        "form" => UrlMode::Form,
        _ => return Err(JsValue::from_str("Invalid mode")),
    };
    url_decode_string(input, mode)
        .map_err(|e| JsValue::from_str(&e))
}

// ============================================================================
// High-level API with charset support
// ============================================================================

#[wasm_bindgen]
pub fn encode_text_to_bytes(text: &str, charset: &str) -> Result<Vec<u8>, JsValue> {
    let charset = Charset::parse(charset)
        .map_err(|e| JsValue::from_str(&e))?;
    charset.encode_text_to_bytes(text)
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn decode_bytes_to_text(bytes: &[u8], charset: &str) -> Result<String, JsValue> {
    let charset = Charset::parse(charset)
        .map_err(|e| JsValue::from_str(&e))?;
    charset.decode_bytes_to_text(bytes)
        .map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_encode() {
        let bytes = b"Hello, World!";
        let result = base64_encode_bytes(bytes, Base64Alphabet::Standard, PaddingMode::Required, None);
        assert_eq!(result, "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn test_hex_encode() {
        let bytes = b"Hi";
        assert_eq!(hex_encode(bytes, false), "4869");
        assert_eq!(hex_encode(bytes, true), "4869");
    }

    #[test]
    fn test_charset_utf8() {
        let text = "Hello, 世界!";
        let bytes = Charset::Utf8.encode_text_to_bytes(text).unwrap();
        let decoded = Charset::Utf8.decode_bytes_to_text(&bytes).unwrap();
        assert_eq!(decoded, text);
    }
}