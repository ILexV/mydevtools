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

/// Alphabet pre-check shared by the Base64/Base32/Base58 text decoders: the
/// first character outside the format's symbol set (padding `=` counts as a
/// symbol where the format has it) is reported as
/// "Invalid <name> character 'c' at position i" before any length/padding
/// check, so a typo is not misreported as truncated input. `i` is a 0-based
/// char index into the ORIGINAL input (whitespace included), like hex.
fn check_symbols(
    input: &str,
    name: &str,
    allow_whitespace: bool,
    is_symbol: impl Fn(char) -> bool,
) -> Result<(), String> {
    for (i, c) in input.chars().enumerate() {
        if allow_whitespace && c.is_whitespace() {
            continue;
        }
        if !is_symbol(c) {
            return Err(format!("Invalid {} character '{}' at position {}", name, c, i));
        }
    }
    Ok(())
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

    check_symbols(input, "Base64", allow_whitespace, |c| {
        c.is_ascii_alphanumeric()
            || c == '='
            || match alphabet {
                Base64Alphabet::Standard => c == '+' || c == '/',
                Base64Alphabet::UrlSafe => c == '-' || c == '_',
            }
    })?;

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

    // "optional" accepts both padded and unpadded input: strip trailing '='
    // and decode with the no-pad engine (the padded engines require canonical
    // padding, so they would reject unpadded input).
    if padding == PaddingMode::Optional {
        let trimmed_len = cleaned.trim_end_matches('=').len();
        cleaned.truncate(trimmed_len);
    }

    let engine = match (alphabet, padding) {
        (Base64Alphabet::Standard, PaddingMode::Required) => &general_purpose::STANDARD,
        (Base64Alphabet::Standard, _) => &general_purpose::STANDARD_NO_PAD,
        (Base64Alphabet::UrlSafe, PaddingMode::Required) => &general_purpose::URL_SAFE,
        (Base64Alphabet::UrlSafe, _) => &general_purpose::URL_SAFE_NO_PAD,
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
    hex_decode_internal(input, ignore_whitespace, allow_separators, allow_0x)
        .map_err(|e| JsValue::from_str(&e))
}

/// Hex → bytes. Optional leniency: whitespace, `:`/`-` separators and a `0x`
/// prefix on every token ("0x48 0x65", "0x4865"). Error positions are
/// 0-based char indices into the ORIGINAL input so the UI can select the
/// offending character.
fn hex_decode_internal(
    input: &str,
    ignore_whitespace: bool,
    allow_separators: bool,
    allow_0x: bool,
) -> Result<Vec<u8>, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut digits: Vec<u8> = Vec::with_capacity(chars.len());
    let mut token_start = true;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if ignore_whitespace && c.is_whitespace() {
            token_start = true;
            i += 1;
            continue;
        }
        if allow_separators && (c == ':' || c == '-') {
            token_start = true;
            i += 1;
            continue;
        }
        if allow_0x && token_start && c == '0' && matches!(chars.get(i + 1), Some('x') | Some('X')) {
            token_start = false;
            i += 2;
            continue;
        }
        match hex_value(c) {
            Some(v) => digits.push(v),
            None => return Err(format!("Invalid hex character '{}' at position {}", c, i)),
        }
        token_start = false;
        i += 1;
    }

    if digits.len() % 2 != 0 {
        return Err("Invalid hex length (must be even)".to_string());
    }

    Ok(digits.chunks_exact(2).map(|p| (p[0] << 4) | p[1]).collect())
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

const BASE32_RFC4648_SYMBOLS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/// Crockford Base32: no I, L, O, U (https://www.crockford.com/base32.html).
const BASE32_CROCKFORD_SYMBOLS: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// z-base-32 (human-oriented, lowercase, never padded).
const BASE32_ZBASE32_SYMBOLS: &str = "ybndrfg8ejkmcpqxot1uwisza345h769";

/// Build the data-encoding codec for an alphabet. Decoding is
/// case-insensitive for every alphabet; Crockford additionally maps the
/// look-alikes I/L → 1 and O → 0 and ignores `-` group separators.
fn base32_codec(alphabet: Base32Alphabet, padded: bool) -> data_encoding::Encoding {
    let mut spec = data_encoding::Specification::new();
    match alphabet {
        Base32Alphabet::Rfc4648 => {
            spec.symbols.push_str(BASE32_RFC4648_SYMBOLS);
            spec.translate.from.push_str("abcdefghijklmnopqrstuvwxyz");
            spec.translate.to.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
        }
        Base32Alphabet::Crockford => {
            spec.symbols.push_str(BASE32_CROCKFORD_SYMBOLS);
            spec.translate.from.push_str("abcdefghjkmnpqrstvwxyzIiLlOo");
            spec.translate.to.push_str("ABCDEFGHJKMNPQRSTVWXYZ111100");
            spec.ignore.push('-');
        }
        Base32Alphabet::ZBase32 => {
            spec.symbols.push_str(BASE32_ZBASE32_SYMBOLS);
            spec.translate.from.push_str("YBNDRFGEJKMCPQXOTUWISZAH");
            spec.translate.to.push_str("ybndrfgejkmcpqxotuwiszah");
        }
    }
    if padded && alphabet != Base32Alphabet::ZBase32 {
        spec.padding = Some('=');
    }
    spec.encoding().expect("static base32 specification is valid")
}

fn base32_encode_bytes(
    bytes: &[u8],
    alphabet: Base32Alphabet,
    padding: PaddingMode,
    case: Option<&str>,
) -> String {
    let result = base32_codec(alphabet, padding != PaddingMode::None).encode(bytes);
    match case {
        Some("upper") => result.to_uppercase(),
        Some("lower") => result.to_lowercase(),
        // "auto"/None: the alphabet's canonical case.
        _ => result,
    }
}

fn base32_decode_string(
    input: &str,
    alphabet: Base32Alphabet,
    padding: PaddingMode,
    allow_whitespace: bool,
) -> Result<Vec<u8>, String> {
    let mut cleaned = input.to_string();

    if allow_whitespace {
        cleaned = cleaned.chars().filter(|c| !c.is_whitespace()).collect();
    } else if cleaned.chars().any(|c| c.is_whitespace()) {
        return Err("Whitespace not allowed".to_string());
    }

    // Case-insensitive like the codec; Crockford also accepts I/L/O and `-`.
    check_symbols(input, "Base32", allow_whitespace, |c| {
        c == '='
            || match alphabet {
                Base32Alphabet::Rfc4648 => c.is_ascii_alphabetic() || ('2'..='7').contains(&c),
                Base32Alphabet::Crockford => {
                    (c.is_ascii_alphanumeric() && !c.eq_ignore_ascii_case(&'u')) || c == '-'
                }
                Base32Alphabet::ZBase32 => {
                    c.is_ascii() && BASE32_ZBASE32_SYMBOLS.contains(c.to_ascii_lowercase())
                }
            }
    })?;

    if padding == PaddingMode::None && cleaned.contains('=') {
        return Err("Padding '=' is not allowed".to_string());
    }
    // "optional" (and z-base-32, which has no padding) accepts padded and
    // unpadded input.
    let padded = padding == PaddingMode::Required && alphabet != Base32Alphabet::ZBase32;
    if !padded {
        let trimmed_len = cleaned.trim_end_matches('=').len();
        cleaned.truncate(trimmed_len);
    }

    base32_codec(alphabet, padded)
        .decode(cleaned.as_bytes())
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

fn base58_alphabet(alpha: Base58Alphabet) -> &'static bs58::Alphabet {
    match alpha {
        Base58Alphabet::Bitcoin => bs58::Alphabet::BITCOIN,
        Base58Alphabet::Flickr => bs58::Alphabet::FLICKR,
        Base58Alphabet::Ripple => bs58::Alphabet::RIPPLE,
    }
}

fn base58_encode_bytes(bytes: &[u8], alphabet: Base58Alphabet) -> String {
    bs58::encode(bytes)
        .with_alphabet(base58_alphabet(alphabet))
        .into_string()
}

fn base58_decode_string(
    input: &str,
    alphabet: Base58Alphabet,
    allow_whitespace: bool,
) -> Result<Vec<u8>, String> {
    let mut cleaned = input.to_string();
    
    if allow_whitespace {
        cleaned = cleaned.chars().filter(|c| !c.is_whitespace()).collect();
    } else if cleaned.chars().any(|c| c.is_whitespace()) {
        return Err("Whitespace not allowed".to_string());
    }

    // All three alphabets use the same 58 symbols (alphanumerics minus 0 O I l).
    check_symbols(input, "Base58", allow_whitespace, |c| {
        c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l')
    })?;

    bs58::decode(&cleaned)
        .with_alphabet(base58_alphabet(alphabet))
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
                // from_str_radix alone would accept a sign ("%+1").
                match (hex_value(high), hex_value(low)) {
                    (Some(h), Some(l)) => bytes.push((h << 4) | l),
                    _ => return Err(format!("Invalid hex in % encoding: {}{}", high, low)),
                }
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

    // ============================================================================
    // Base64 Tests
    // ============================================================================

    #[test]
    fn test_base64_encode_standard() {
        let bytes = b"Hello, World!";
        let result = base64_encode_bytes(bytes, Base64Alphabet::Standard, PaddingMode::Required, None);
        assert_eq!(result, "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn test_base64_decode_standard() {
        let input = "SGVsbG8sIFdvcmxkIQ==";
        let result = base64_decode_string(input, Base64Alphabet::Standard, PaddingMode::Required, true).unwrap();
        assert_eq!(result, b"Hello, World!");
    }

    #[test]
    fn test_base64_urlsafe() {
        let bytes = b"test\xff\xfe";
        let encoded = base64_encode_bytes(bytes, Base64Alphabet::UrlSafe, PaddingMode::None, None);
        let decoded = base64_decode_string(&encoded, Base64Alphabet::UrlSafe, PaddingMode::None, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_base64_no_padding() {
        let bytes = b"test";
        let encoded = base64_encode_bytes(bytes, Base64Alphabet::Standard, PaddingMode::None, None);
        assert!(!encoded.contains('='));
        let decoded = base64_decode_string(&encoded, Base64Alphabet::Standard, PaddingMode::None, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_base64_line_wrap() {
        let bytes = b"This is a long text that should be wrapped into multiple lines when encoded";
        let encoded = base64_encode_bytes(bytes, Base64Alphabet::Standard, PaddingMode::Required, Some(64));
        assert!(encoded.contains('\n'));
    }

    #[test]
    fn test_base64_empty() {
        let bytes = b"";
        let encoded = base64_encode_bytes(bytes, Base64Alphabet::Standard, PaddingMode::Required, None);
        assert_eq!(encoded, "");
        let decoded = base64_decode_string(&encoded, Base64Alphabet::Standard, PaddingMode::Required, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    // ============================================================================
    // Hex Tests
    // ============================================================================

    #[test]
    fn test_hex_encode_lowercase() {
        let bytes = b"Hello";
        assert_eq!(hex_encode(bytes, false), "48656c6c6f");
    }

    #[test]
    fn test_hex_encode_uppercase() {
        let bytes = b"Hello";
        assert_eq!(hex_encode(bytes, true), "48656C6C6F");
    }

    #[test]
    fn test_hex_decode() {
        let input = "48656c6c6f";
        let result = hex_decode_internal(input, false, false, false).unwrap();
        assert_eq!(result, b"Hello");
    }

    #[test]
    fn test_hex_decode_uppercase() {
        let input = "48656C6C6F";
        let result = hex_decode_internal(input, false, false, false).unwrap();
        assert_eq!(result, b"Hello");
    }

    #[test]
    fn test_hex_decode_with_separators() {
        let input = "48:65:6c:6c:6f";
        let result = hex_decode_internal(input, false, true, false).unwrap();
        assert_eq!(result, b"Hello");
    }

    #[test]
    fn test_hex_decode_with_whitespace() {
        let input = "48 65 6c 6c 6f";
        let result = hex_decode_internal(input, true, false, false).unwrap();
        assert_eq!(result, b"Hello");
    }

    #[test]
    fn test_hex_roundtrip() {
        let bytes = b"\x00\x01\x02\xfe\xff";
        let encoded = hex_encode(bytes, false);
        let decoded = hex_decode_internal(&encoded, false, false, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_hex_invalid_character() {
        let result = hex_decode_internal("48g5", false, false, false);
        assert!(result.is_err());
    }

    #[test]
    fn test_hex_odd_length() {
        let result = hex_decode_internal("486", false, false, false);
        assert!(result.is_err());
    }

    // ============================================================================
    // Base32 Tests
    // ============================================================================

    #[test]
    fn test_base32_encode() {
        let bytes = b"Hello";
        let encoded = base32_encode_bytes(bytes, Base32Alphabet::Rfc4648, PaddingMode::Required, None);
        assert_eq!(encoded, "JBSWY3DP");
    }

    #[test]
    fn test_base32_decode() {
        let input = "JBSWY3DP";
        let decoded = base32_decode_string(input, Base32Alphabet::Rfc4648, PaddingMode::Required, false).unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn test_base32_no_padding() {
        let bytes = b"test";
        let encoded = base32_encode_bytes(bytes, Base32Alphabet::Rfc4648, PaddingMode::None, None);
        assert!(!encoded.contains('='));
        let decoded = base32_decode_string(&encoded, Base32Alphabet::Rfc4648, PaddingMode::None, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_base32_roundtrip() {
        let bytes = b"The quick brown fox";
        let encoded = base32_encode_bytes(bytes, Base32Alphabet::Rfc4648, PaddingMode::Required, None);
        let decoded = base32_decode_string(&encoded, Base32Alphabet::Rfc4648, PaddingMode::Required, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    // ============================================================================
    // Base58 Tests
    // ============================================================================

    #[test]
    fn test_base58_encode() {
        let bytes = b"Hello";
        let encoded = base58_encode_bytes(bytes, Base58Alphabet::Bitcoin);
        assert_eq!(encoded, "9Ajdvzr");
    }

    #[test]
    fn test_base58_decode() {
        let input = "9Ajdvzr";
        let decoded = base58_decode_string(input, Base58Alphabet::Bitcoin, false).unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn test_base58_roundtrip() {
        let bytes = b"The quick brown fox jumps over the lazy dog";
        let encoded = base58_encode_bytes(bytes, Base58Alphabet::Bitcoin);
        let decoded = base58_decode_string(&encoded, Base58Alphabet::Bitcoin, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_base58_empty() {
        let bytes = b"";
        let encoded = base58_encode_bytes(bytes, Base58Alphabet::Bitcoin);
        assert_eq!(encoded, "");
        let decoded = base58_decode_string(&encoded, Base58Alphabet::Bitcoin, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_base58_leading_zeros() {
        let bytes = b"\x00\x00test";
        let encoded = base58_encode_bytes(bytes, Base58Alphabet::Bitcoin);
        let decoded = base58_decode_string(&encoded, Base58Alphabet::Bitcoin, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_base58_alphabets_are_distinct() {
        // Regression: Flickr and Ripple were incorrectly mapped to the Bitcoin alphabet.
        let bytes = b"Hello World";
        let btc = base58_encode_bytes(bytes, Base58Alphabet::Bitcoin);
        let fl = base58_encode_bytes(bytes, Base58Alphabet::Flickr);
        let rip = base58_encode_bytes(bytes, Base58Alphabet::Ripple);
        assert_ne!(btc, fl);
        assert_ne!(btc, rip);
        assert_ne!(fl, rip);
        // Each alphabet round-trips against itself.
        for alpha in [Base58Alphabet::Bitcoin, Base58Alphabet::Flickr, Base58Alphabet::Ripple] {
            let enc = base58_encode_bytes(bytes, alpha);
            assert_eq!(base58_decode_string(&enc, alpha, false).unwrap(), bytes);
        }
    }

    // ============================================================================
    // URL Encoding Tests
    // ============================================================================

    #[test]
    fn test_url_encode_component() {
        let bytes = b"Hello World!";
        let encoded = url_encode_bytes(bytes, UrlMode::Component);
        // ! is not encoded in encodeURIComponent
        assert_eq!(encoded, "Hello%20World!");
    }

    #[test]
    fn test_url_decode_component() {
        let input = "Hello%20World%21";
        let decoded = url_decode_string(input, UrlMode::Component).unwrap();
        assert_eq!(decoded, b"Hello World!");
    }

    #[test]
    fn test_url_encode_special_chars() {
        let bytes = b"key=value&other=data";
        let encoded = url_encode_bytes(bytes, UrlMode::Component);
        assert!(encoded.contains("%3D")); // =
        assert!(encoded.contains("%26")); // &
    }

    #[test]
    fn test_url_form_mode() {
        let bytes = b"Hello World";
        let encoded = url_encode_bytes(bytes, UrlMode::Form);
        assert_eq!(encoded, "Hello+World");
    }

    #[test]
    fn test_url_decode_form_mode() {
        let input = "Hello+World";
        let decoded = url_decode_string(input, UrlMode::Form).unwrap();
        assert_eq!(decoded, b"Hello World");
    }

    #[test]
    fn test_url_decode_invalid_percent() {
        let result = url_decode_string("test%ZZ", UrlMode::Component);
        assert!(result.is_err());
    }

    #[test]
    fn test_url_roundtrip() {
        let bytes = b"test@example.com?key=value&data=123";
        let encoded = url_encode_bytes(bytes, UrlMode::Component);
        let decoded = url_decode_string(&encoded, UrlMode::Component).unwrap();
        assert_eq!(decoded, bytes);
    }

    // ============================================================================
    // Charset Tests
    // ============================================================================

    #[test]
    fn test_charset_utf8() {
        let text = "Hello, 世界! 🌍";
        let bytes = Charset::Utf8.encode_text_to_bytes(text).unwrap();
        let decoded = Charset::Utf8.decode_bytes_to_text(&bytes).unwrap();
        assert_eq!(decoded, text);
    }

    #[test]
    fn test_charset_ascii() {
        let text = "Hello";
        let bytes = Charset::Ascii.encode_text_to_bytes(text).unwrap();
        assert_eq!(bytes, b"Hello");
        let decoded = Charset::Ascii.decode_bytes_to_text(&bytes).unwrap();
        assert_eq!(decoded, text);
    }

    #[test]
    fn test_charset_ascii_invalid() {
        let text = "Hello 世界";
        let result = Charset::Ascii.encode_text_to_bytes(text);
        assert!(result.is_err());
    }

    #[test]
    fn test_charset_latin1() {
        let text = "Héllo";
        let bytes = Charset::Latin1.encode_text_to_bytes(text).unwrap();
        let decoded = Charset::Latin1.decode_bytes_to_text(&bytes).unwrap();
        assert_eq!(decoded, text);
    }

    #[test]
    fn test_charset_utf16le() {
        let text = "Hello";
        let bytes = Charset::Utf16Le.encode_text_to_bytes(text).unwrap();
        let decoded = Charset::Utf16Le.decode_bytes_to_text(&bytes).unwrap();
        assert_eq!(decoded, text);
    }

    #[test]
    fn test_charset_utf16be() {
        let text = "World";
        let bytes = Charset::Utf16Be.encode_text_to_bytes(text).unwrap();
        let decoded = Charset::Utf16Be.decode_bytes_to_text(&bytes).unwrap();
        assert_eq!(decoded, text);
    }

    #[test]
    fn test_charset_utf16_emoji() {
        let text = "🎉";
        let bytes_le = Charset::Utf16Le.encode_text_to_bytes(text).unwrap();
        let decoded_le = Charset::Utf16Le.decode_bytes_to_text(&bytes_le).unwrap();
        assert_eq!(decoded_le, text);

        let bytes_be = Charset::Utf16Be.encode_text_to_bytes(text).unwrap();
        let decoded_be = Charset::Utf16Be.decode_bytes_to_text(&bytes_be).unwrap();
        assert_eq!(decoded_be, text);
    }

    #[test]
    fn test_charset_parse() {
        assert_eq!(Charset::parse("utf-8").unwrap(), Charset::Utf8);
        assert_eq!(Charset::parse("UTF-16LE").unwrap(), Charset::Utf16Le);
        assert_eq!(Charset::parse("ASCII").unwrap(), Charset::Ascii);
        assert_eq!(Charset::parse("LATIN1").unwrap(), Charset::Latin1);
        assert!(Charset::parse("unknown").is_err());
    }

    // ============================================================================
    // Integration Tests
    // ============================================================================

    #[test]
    fn test_base64_with_binary_data() {
        let bytes: Vec<u8> = (0..=255).collect();
        let encoded = base64_encode_bytes(&bytes, Base64Alphabet::Standard, PaddingMode::Required, None);
        let decoded = base64_decode_string(&encoded, Base64Alphabet::Standard, PaddingMode::Required, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_hex_with_binary_data() {
        let bytes: Vec<u8> = (0..=255).collect();
        let encoded = hex_encode(&bytes, false);
        let decoded = hex_decode_internal(&encoded, false, false, false).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_mixed_encoding_flow() {
        // Original text -> UTF-8 bytes -> Base64 -> Hex -> decode chain
        let text = "Hello, World!";
        let utf8_bytes = Charset::Utf8.encode_text_to_bytes(text).unwrap();
        let base64 = base64_encode_bytes(&utf8_bytes, Base64Alphabet::Standard, PaddingMode::Required, None);
        let hex = hex_encode(base64.as_bytes(), false);
        
        // Decode back
        let hex_decoded = hex_decode_internal(&hex, false, false, false).unwrap();
        let base64_str = String::from_utf8(hex_decoded).unwrap();
        let base64_decoded = base64_decode_string(&base64_str, Base64Alphabet::Standard, PaddingMode::Required, false).unwrap();
        let final_text = Charset::Utf8.decode_bytes_to_text(&base64_decoded).unwrap();
        
        assert_eq!(final_text, text);
    }

    // ============================================================================
    // QA additions (2026-10-06): RFC 4648 vectors, padding modes, alphabets,
    // hex leniency, URL strictness
    // ============================================================================

    /// RFC 4648 §10 test vectors ("", "f", "fo", … "foobar").
    const RFC4648_INPUTS: [&str; 7] = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];

    #[test]
    fn test_base64_rfc4648_vectors() {
        let expected = ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"];
        for (input, want) in RFC4648_INPUTS.iter().zip(expected) {
            let enc = base64_encode_bytes(input.as_bytes(), Base64Alphabet::Standard, PaddingMode::Required, None);
            assert_eq!(enc, want);
            let dec = base64_decode_string(want, Base64Alphabet::Standard, PaddingMode::Required, false).unwrap();
            assert_eq!(dec, input.as_bytes());
        }
    }

    #[test]
    fn test_base64_optional_padding_accepts_both_forms() {
        for input in ["Zm8=", "Zm8"] {
            let dec = base64_decode_string(input, Base64Alphabet::Standard, PaddingMode::Optional, false).unwrap();
            assert_eq!(dec, b"fo");
        }
    }

    #[test]
    fn test_base64_padding_modes_reject() {
        assert!(base64_decode_string("Zm8", Base64Alphabet::Standard, PaddingMode::Required, false).is_err());
        let err = base64_decode_string("Zm8=", Base64Alphabet::Standard, PaddingMode::None, false).unwrap_err();
        assert!(err.contains("Padding"));
        assert!(base64_decode_string("Z", Base64Alphabet::Standard, PaddingMode::Optional, false).is_err());
    }

    #[test]
    fn test_base64_whitespace_and_invalid_symbol() {
        let wrapped = "Zm9v\nYmFy";
        assert_eq!(
            base64_decode_string(wrapped, Base64Alphabet::Standard, PaddingMode::Required, true).unwrap(),
            b"foobar"
        );
        let err = base64_decode_string(wrapped, Base64Alphabet::Standard, PaddingMode::Required, false).unwrap_err();
        assert!(err.contains("Whitespace"));
        assert!(base64_decode_string("Zm9v!mFy", Base64Alphabet::Standard, PaddingMode::Required, false).is_err());
    }

    #[test]
    fn test_base64_urlsafe_vs_standard_symbols() {
        let bytes = [0xfb, 0xff, 0xbf];
        assert_eq!(base64_encode_bytes(&bytes, Base64Alphabet::Standard, PaddingMode::Required, None), "+/+/");
        assert_eq!(base64_encode_bytes(&bytes, Base64Alphabet::UrlSafe, PaddingMode::Required, None), "-_-_");
        assert!(base64_decode_string("-_-_", Base64Alphabet::Standard, PaddingMode::Required, false).is_err());
    }

    #[test]
    fn test_base64_line_wrap_76() {
        let bytes = vec![0u8; 100];
        let enc = base64_encode_bytes(&bytes, Base64Alphabet::Standard, PaddingMode::Required, Some(76));
        let lines: Vec<&str> = enc.split('\n').collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 76);
        let dec = base64_decode_string(&enc, Base64Alphabet::Standard, PaddingMode::Required, true).unwrap();
        assert_eq!(dec, bytes);
    }

    #[test]
    fn test_base32_rfc4648_vectors() {
        let expected = ["", "MY======", "MZXQ====", "MZXW6===", "MZXW6YQ=", "MZXW6YTB", "MZXW6YTBOI======"];
        for (input, want) in RFC4648_INPUTS.iter().zip(expected) {
            let enc = base32_encode_bytes(input.as_bytes(), Base32Alphabet::Rfc4648, PaddingMode::Required, None);
            assert_eq!(enc, want);
            let dec = base32_decode_string(want, Base32Alphabet::Rfc4648, PaddingMode::Required, false).unwrap();
            assert_eq!(dec, input.as_bytes());
        }
    }

    #[test]
    fn test_base32_optional_padding_and_case_insensitive() {
        for input in ["MZXW6===", "MZXW6", "mzxw6"] {
            let dec = base32_decode_string(input, Base32Alphabet::Rfc4648, PaddingMode::Optional, false).unwrap();
            assert_eq!(dec, b"foo");
        }
        assert!(base32_decode_string("MZXW6", Base32Alphabet::Rfc4648, PaddingMode::Required, false).is_err());
        assert!(base32_decode_string("MZXW6===", Base32Alphabet::Rfc4648, PaddingMode::None, false).is_err());
    }

    #[test]
    fn test_base32_case_option() {
        let lower = base32_encode_bytes(b"foo", Base32Alphabet::Rfc4648, PaddingMode::None, Some("lower"));
        assert_eq!(lower, "mzxw6");
        let upper = base32_encode_bytes(b"foo", Base32Alphabet::ZBase32, PaddingMode::None, Some("upper"));
        assert_eq!(upper, upper.to_uppercase());
        assert_eq!(base32_decode_string(&upper, Base32Alphabet::ZBase32, PaddingMode::None, false).unwrap(), b"foo");
    }

    #[test]
    fn test_base32_crockford_alphabet() {
        // "hello": RFC 4648 NBSWY3DP → Crockford D1JPRV3F (same 5-bit groups, other symbols).
        let enc = base32_encode_bytes(b"hello", Base32Alphabet::Crockford, PaddingMode::None, None);
        assert_eq!(enc, "D1JPRV3F");
        // Lowercase, look-alikes (I/L → 1, O → 0) and '-' separators decode.
        for input in ["D1JPRV3F", "d1jprv3f", "DIJPRV3F", "DLJP-RV3F"] {
            let dec = base32_decode_string(input, Base32Alphabet::Crockford, PaddingMode::None, false).unwrap();
            assert_eq!(dec, b"hello", "input {input}");
        }
        assert_eq!(base32_decode_string("0o", Base32Alphabet::Crockford, PaddingMode::None, false).unwrap(), vec![0]);
        // 'U' is not in the Crockford alphabet.
        assert!(base32_decode_string("UUUUUUUU", Base32Alphabet::Crockford, PaddingMode::None, false).is_err());
    }

    #[test]
    fn test_base32_zbase32_alphabet() {
        let enc = base32_encode_bytes(b"hello", Base32Alphabet::ZBase32, PaddingMode::Required, None);
        assert_eq!(enc, "pb1sa5dx");
        assert_eq!(base32_decode_string("pb1sa5dx", Base32Alphabet::ZBase32, PaddingMode::Required, false).unwrap(), b"hello");
        // RFC 4648 text is not z-base-32.
        assert_ne!(
            base32_decode_string("NBSWY3DP", Base32Alphabet::ZBase32, PaddingMode::None, false).ok(),
            Some(b"hello".to_vec())
        );
    }

    #[test]
    fn test_base32_alphabet_roundtrips_binary() {
        let bytes: Vec<u8> = (0..=255u8).collect();
        for alphabet in [Base32Alphabet::Rfc4648, Base32Alphabet::Crockford, Base32Alphabet::ZBase32] {
            for padding in [PaddingMode::Required, PaddingMode::Optional, PaddingMode::None] {
                let enc = base32_encode_bytes(&bytes, alphabet, padding, None);
                let dec = base32_decode_string(&enc, alphabet, padding, false).unwrap();
                assert_eq!(dec, bytes, "{alphabet:?} {padding:?}");
            }
        }
    }

    #[test]
    fn test_hex_0x_prefix_handling() {
        assert_eq!(hex_decode_internal("0x48656c6c6f", false, false, true).unwrap(), b"Hello");
        assert_eq!(hex_decode_internal("0X4865", false, false, true).unwrap(), b"He");
        assert_eq!(hex_decode_internal("0x48 0x65", true, false, true).unwrap(), b"He");
        assert_eq!(hex_decode_internal("0x48:0x65", false, true, true).unwrap(), b"He");
        // Disabled: both spellings are rejected (was: "0X" stripped regardless).
        assert!(hex_decode_internal("0x48", false, false, false).is_err());
        assert!(hex_decode_internal("0X48", false, false, false).is_err());
        // "0x" only counts at a token start.
        assert!(hex_decode_internal("480x65", false, false, true).is_err());
    }

    #[test]
    fn test_hex_error_position_is_in_original_input() {
        let err = hex_decode_internal("48 65 zz", true, false, false).unwrap_err();
        assert!(err.contains("'z' at position 6"), "{err}");
        let err = hex_decode_internal("48 65", false, false, false).unwrap_err();
        assert!(err.contains("position 2"), "{err}");
        let err = hex_decode_internal("48:65", true, false, false).unwrap_err();
        assert!(err.contains("':' at position 2"), "{err}");
    }

    #[test]
    fn test_hex_empty_and_dash_separator() {
        assert_eq!(hex_decode_internal("", true, true, true).unwrap(), Vec::<u8>::new());
        assert_eq!(hex_decode_internal("de-ad-BE-EF", false, true, false).unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn test_url_decode_rejects_signed_escape() {
        assert!(url_decode_string("%+1", UrlMode::Component).is_err());
        assert!(url_decode_string("%4", UrlMode::Component).is_err());
        assert_eq!(url_decode_string("%e2%82%AC", UrlMode::Component).unwrap(), "€".as_bytes());
    }

    #[test]
    fn test_url_component_vs_uri_reserved() {
        let input = "a b&c=d/é?#";
        assert_eq!(url_encode_bytes(input.as_bytes(), UrlMode::Component), "a%20b%26c%3Dd%2F%C3%A9%3F%23");
        assert_eq!(url_encode_bytes(input.as_bytes(), UrlMode::Uri), "a%20b&c=d/%C3%A9?#");
        assert_eq!(url_encode_bytes(input.as_bytes(), UrlMode::Form), "a+b%26c%3Dd%2F%C3%A9%3F%23");
        // '+' is literal outside form mode.
        assert_eq!(url_decode_string("a+b", UrlMode::Component).unwrap(), b"a+b");
        assert_eq!(url_decode_string("a+b", UrlMode::Form).unwrap(), b"a b");
    }

    #[test]
    fn test_base58_known_vectors_and_invalid() {
        // Bitcoin alphabet: "Hello World!" → 2NEpo7TZRRrLZSi2U; leading zero bytes → '1'.
        assert_eq!(base58_encode_bytes(b"Hello World!", Base58Alphabet::Bitcoin), "2NEpo7TZRRrLZSi2U");
        assert_eq!(base58_encode_bytes(&[0, 0, 1], Base58Alphabet::Bitcoin), "112");
        // '0', 'O', 'I', 'l' are not in the Bitcoin alphabet.
        for bad in ["0", "O", "I", "l"] {
            assert!(base58_decode_string(bad, Base58Alphabet::Bitcoin, false).is_err(), "{bad}");
        }
        assert!(base58_decode_string("2NEp o7", Base58Alphabet::Bitcoin, false).is_err());
        assert!(base58_decode_string("2NEp o7", Base58Alphabet::Bitcoin, true).is_ok());
    }

    #[test]
    fn test_invalid_symbol_reported_before_length_with_char_position() {
        // A bad symbol wins over the length/padding checks; the position is a
        // 0-based char index into the original input (multi-byte chars count once).
        let err = base32_decode_string("MZXW6$==", Base32Alphabet::Rfc4648, PaddingMode::Required, false).unwrap_err();
        assert_eq!(err, "Invalid Base32 character '$' at position 5");
        let err = base32_decode_string("ЖЖMZ$", Base32Alphabet::Rfc4648, PaddingMode::Optional, false).unwrap_err();
        assert!(err.ends_with("'Ж' at position 0"), "{err}");
        assert!(base32_decode_string("mzxw6ylp", Base32Alphabet::Rfc4648, PaddingMode::None, false).is_ok());
        // Crockford look-alikes and `-` separators pass the symbol check.
        assert!(base32_decode_string("ilo0-ILO0", Base32Alphabet::Crockford, PaddingMode::None, false).is_ok());
        let err = base32_decode_string("UUUUUUUU", Base32Alphabet::Crockford, PaddingMode::None, false).unwrap_err();
        assert!(err.contains("character 'U' at position 0"), "{err}");
        let err = base32_decode_string("ybnl", Base32Alphabet::ZBase32, PaddingMode::None, false).unwrap_err();
        assert!(err.contains("'l' at position 3"), "{err}");

        let err = base64_decode_string("@@@ not base64 !!!", Base64Alphabet::Standard, PaddingMode::Optional, true).unwrap_err();
        assert_eq!(err, "Invalid Base64 character '@' at position 0");
        let err = base64_decode_string("Zm 9v!mFy", Base64Alphabet::Standard, PaddingMode::Required, true).unwrap_err();
        assert!(err.ends_with("'!' at position 5"), "{err}");
        let err = base64_decode_string("€Zm9", Base64Alphabet::Standard, PaddingMode::Required, false).unwrap_err();
        assert!(err.ends_with("position 0"), "{err}");
        let err = base64_decode_string("-_-_", Base64Alphabet::Standard, PaddingMode::Required, false).unwrap_err();
        assert!(err.contains("character '-' at position 0"), "{err}");
        // Length errors still surface for well-formed symbols.
        let err = base64_decode_string("SGVsbG8", Base64Alphabet::Standard, PaddingMode::Required, false).unwrap_err();
        assert!(err.contains("length"), "{err}");

        let err = base58_decode_string("2NEp😀0", Base58Alphabet::Bitcoin, false).unwrap_err();
        assert_eq!(err, "Invalid Base58 character '😀' at position 4");
    }

    #[test]
    fn test_charset_errors_carry_positions() {
        let err = Charset::Ascii.encode_text_to_bytes("abé").unwrap_err();
        assert!(err.contains("position 2"), "{err}");
        let err = Charset::Latin1.encode_text_to_bytes("ab€").unwrap_err();
        assert!(err.contains("position 2"), "{err}");
        assert!(Charset::Utf8.decode_bytes_to_text(&[0xff]).is_err());
        assert_eq!(Charset::Latin1.decode_bytes_to_text(&[0xe9]).unwrap(), "é");
    }
}