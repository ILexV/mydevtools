use wasm_bindgen::prelude::*;
use digest::Digest;

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_hash@0.1.0".to_string()
}

fn to_hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Algorithm {
    Md5,
    Sha256,
    Sha384,
    Sha512,
    Sha3_256,
}

impl Algorithm {
    fn parse(id: &str) -> Option<Self> {
        match id.trim().to_ascii_lowercase().as_str() {
            "md5" | "md-5" => Some(Self::Md5),
            "sha256" | "sha-256" => Some(Self::Sha256),
            "sha384" | "sha-384" => Some(Self::Sha384),
            "sha512" | "sha-512" => Some(Self::Sha512),
            "sha3-256" | "sha3_256" | "sha3" => Some(Self::Sha3_256),
            _ => None,
        }
    }
}

enum HasherImpl {
    Md5(md5::Md5),
    Sha256(sha2::Sha256),
    Sha384(sha2::Sha384),
    Sha512(sha2::Sha512),
    Sha3_256(sha3::Sha3_256),
}

impl HasherImpl {
    fn new(algorithm: Algorithm) -> Self {
        match algorithm {
            Algorithm::Md5 => Self::Md5(md5::Md5::new()),
            Algorithm::Sha256 => Self::Sha256(sha2::Sha256::new()),
            Algorithm::Sha384 => Self::Sha384(sha2::Sha384::new()),
            Algorithm::Sha512 => Self::Sha512(sha2::Sha512::new()),
            Algorithm::Sha3_256 => Self::Sha3_256(sha3::Sha3_256::new()),
        }
    }

    fn update(&mut self, chunk: &[u8]) {
        match self {
            Self::Md5(h) => h.update(chunk),
            Self::Sha256(h) => h.update(chunk),
            Self::Sha384(h) => h.update(chunk),
            Self::Sha512(h) => h.update(chunk),
            Self::Sha3_256(h) => h.update(chunk),
        }
    }

    fn finalize(self) -> Vec<u8> {
        match self {
            Self::Md5(h) => h.finalize().to_vec(),
            Self::Sha256(h) => h.finalize().to_vec(),
            Self::Sha384(h) => h.finalize().to_vec(),
            Self::Sha512(h) => h.finalize().to_vec(),
            Self::Sha3_256(h) => h.finalize().to_vec(),
        }
    }
}

/// Streaming hasher for large inputs (files).
///
/// Intended usage from JS:
/// - `const h = new hash.Hasher("md5"); // or "sha256"`
/// - `h.update(chunkUint8Array);` for each chunk
/// - `const hex = h.finalize();`
#[wasm_bindgen]
pub struct Hasher {
    algorithm: Algorithm,
    inner: HasherImpl,
}

#[wasm_bindgen]
impl Hasher {
    #[wasm_bindgen(constructor)]
    pub fn new(algorithm: &str) -> Result<Hasher, JsValue> {
        let algorithm = Algorithm::parse(algorithm)
            .ok_or_else(|| JsValue::from_str("Unknown hash algorithm"))?;

        Ok(Hasher {
            algorithm,
            inner: HasherImpl::new(algorithm),
        })
    }

    /// Update hasher state with the next chunk.
    pub fn update(&mut self, chunk: &[u8]) {
        self.inner.update(chunk)
    }

    /// Finalize and return hex string (lowercase).
    ///
    /// Consumes the hasher instance to avoid accidental re-use.
    pub fn finalize(self) -> String {
        let digest = self.inner.finalize();
        to_hex_lower(&digest)
    }

    /// Returns normalized algorithm id (for debugging/telemetry).
    pub fn algorithm(&self) -> String {
        match self.algorithm {
            Algorithm::Md5 => "md5".to_string(),
            Algorithm::Sha256 => "sha256".to_string(),
            Algorithm::Sha384 => "sha384".to_string(),
            Algorithm::Sha512 => "sha512".to_string(),
            Algorithm::Sha3_256 => "sha3-256".to_string(),
        }
    }
}

/// One-shot hashing for small inputs.
///
/// For large files prefer `Hasher` + chunked updates.
#[wasm_bindgen]
pub fn hash_bytes(algorithm: &str, bytes: &[u8]) -> Result<String, JsValue> {
    let mut hasher = Hasher::new(algorithm)?;
    hasher.update(bytes);
    Ok(hasher.finalize())
}

/// One-shot helper for text inputs (UTF-8).
#[wasm_bindgen]
pub fn hash_text_utf8(algorithm: &str, text: &str) -> Result<String, JsValue> {
    hash_bytes(algorithm, text.as_bytes())
}

/// Placeholder hash implementation.
///
/// This is NOT a real hash yet; it only exists to validate toolchain and module wiring.
#[wasm_bindgen]
pub fn placeholder_hash(input: &str) -> String {
    format!("hash:{}:{}", input.len(), input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_hash_is_stable() {
        assert_eq!(placeholder_hash("abc"), "hash:3:abc");
    }

    #[test]
    fn sha256_known_vector_abc() {
        // SHA-256("abc")
        assert_eq!(
            hash_text_utf8("sha256", "abc").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_streaming_matches_one_shot() {
        let input = b"hello world";
        let one_shot = hash_bytes("sha256", input).unwrap();

        let mut h = Hasher::new("sha256").unwrap();
        h.update(&input[..3]);
        h.update(&input[3..]);
        let streaming = h.finalize();

        assert_eq!(streaming, one_shot);
    }

    #[test]
    fn sha384_known_vector_abc() {
        // SHA-384("abc")
        assert_eq!(
            hash_text_utf8("sha384", "abc").unwrap(),
            "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"
        );
    }

    #[test]
    fn sha512_known_vector_abc() {
        // SHA-512("abc")
        assert_eq!(
            hash_text_utf8("sha512", "abc").unwrap(),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
    }

    #[test]
    fn sha3_256_known_vectors() {
        assert_eq!(
            hash_text_utf8("sha3-256", "").unwrap(),
            "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a"
        );
        assert_eq!(
            hash_text_utf8("sha3-256", "abc").unwrap(),
            "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532"
        );
    }

    #[test]
    fn sha_family_streaming_matches_one_shot() {
        let input = b"The quick brown fox jumps over the lazy dog";
        for alg in ["sha256", "sha384", "sha512", "sha3-256"] {
            let one_shot = hash_bytes(alg, input).unwrap();

            let mut h = Hasher::new(alg).unwrap();
            h.update(&input[..10]);
            h.update(&input[10..25]);
            h.update(&input[25..]);
            let streaming = h.finalize();

            assert_eq!(streaming, one_shot, "streaming mismatch for {alg}");
        }
    }

    #[test]
    fn md5_known_vectors() {
        // RFC 1321 test suite
        assert_eq!(
            hash_text_utf8("md5", "").unwrap(),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(
            hash_text_utf8("md5", "a").unwrap(),
            "0cc175b9c0f1b6a831c399e269772661"
        );
        assert_eq!(
            hash_text_utf8("md5", "abc").unwrap(),
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            hash_text_utf8("md5", "message digest").unwrap(),
            "f96b697d7cb7938d525a2f31aaf161d0"
        );
    }

    #[test]
    fn md5_streaming_matches_one_shot() {
        let input = b"The quick brown fox jumps over the lazy dog";
        let one_shot = hash_bytes("md5", input).unwrap();

        let mut h = Hasher::new("md5").unwrap();
        h.update(&input[..10]);
        h.update(&input[10..25]);
        h.update(&input[25..]);
        let streaming = h.finalize();

        assert_eq!(streaming, one_shot);
        assert_eq!(
            one_shot,
            "9e107d9d372bb6826bd81d3542a419d6"
        );
    }
}
