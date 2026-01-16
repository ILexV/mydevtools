use wasm_bindgen::prelude::*;
use digest::{Digest, ExtendableOutput, XofReader};
use std::hash::Hasher as StdHasher;

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

fn u64_to_bytes_le(v: u64) -> [u8; 8] {
    v.to_le_bytes()
}

fn u32_to_bytes_le(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Algorithm {
    Md5,
    Sha1,
    Sha224,
    Sha256,
    Sha384,
    Sha512,
    Sha512_224,
    Sha512_256,
    Sha3_256,
    Sha3_224,
    Sha3_384,
    Sha3_512,
    Keccak224,
    Keccak256,
    Keccak384,
    Keccak512,
    Shake128_256,
    Shake256_256,
    Blake3,
    Blake2b512,
    Blake2s256,
    Ripemd160,
    Ripemd128,
    Ripemd256,
    Ripemd320,
    Xxh32,
    Xxh64,
    Xxh3_64,
    FxHash64,
    Fnv1a64,
    SeaHash64,
    Crc32,
    Adler32,
    SipHash13,
    SipHash24,
    HighwayHash64,
    MetroHash64,
}

impl Algorithm {
    fn parse(id: &str) -> Option<Self> {
        match id.trim().to_ascii_lowercase().as_str() {
            "md5" | "md-5" => Some(Self::Md5),
            "sha1" | "sha-1" => Some(Self::Sha1),
            "sha224" | "sha-224" => Some(Self::Sha224),
            "sha256" | "sha-256" => Some(Self::Sha256),
            "sha384" | "sha-384" => Some(Self::Sha384),
            "sha512" | "sha-512" => Some(Self::Sha512),
            "sha512-224" | "sha512_224" => Some(Self::Sha512_224),
            "sha512-256" | "sha512_256" => Some(Self::Sha512_256),
            "sha3-256" | "sha3_256" | "sha3" => Some(Self::Sha3_256),
            "sha3-224" | "sha3_224" => Some(Self::Sha3_224),
            "sha3-384" | "sha3_384" => Some(Self::Sha3_384),
            "sha3-512" | "sha3_512" => Some(Self::Sha3_512),
            "keccak-224" | "keccak224" => Some(Self::Keccak224),
            "keccak-256" | "keccak256" | "keccak" => Some(Self::Keccak256),
            "keccak-384" | "keccak384" => Some(Self::Keccak384),
            "keccak-512" | "keccak512" => Some(Self::Keccak512),
            "shake128" | "shake128-256" | "shake128_256" => Some(Self::Shake128_256),
            "shake256" | "shake256-256" | "shake256_256" => Some(Self::Shake256_256),
            "blake3" | "blake-3" => Some(Self::Blake3),
            "blake2b" | "blake2b-512" | "blake2b512" => Some(Self::Blake2b512),
            "blake2s" | "blake2s-256" | "blake2s256" => Some(Self::Blake2s256),
            "ripemd160" | "ripemd-160" => Some(Self::Ripemd160),
            "ripemd128" | "ripemd-128" => Some(Self::Ripemd128),
            "ripemd256" | "ripemd-256" => Some(Self::Ripemd256),
            "ripemd320" | "ripemd-320" => Some(Self::Ripemd320),
            "xxh32" | "xxhash32" | "xxhash-32" => Some(Self::Xxh32),
            "xxh64" | "xxhash64" | "xxhash-64" => Some(Self::Xxh64),
            "xxh3" | "xxh3-64" | "xxhash" => Some(Self::Xxh3_64),
            "fxhash" | "fxhash64" => Some(Self::FxHash64),
            "fnv" | "fnv1a" | "fnv1a64" => Some(Self::Fnv1a64),
            "seahash" | "seahash64" => Some(Self::SeaHash64),
            "crc32" | "crc-32" => Some(Self::Crc32),
            "adler32" | "adler-32" => Some(Self::Adler32),
            "siphash13" | "siphash-1-3" | "siphash1-3" => Some(Self::SipHash13),
            "siphash24" | "siphash-2-4" | "siphash2-4" => Some(Self::SipHash24),
            "highwayhash64" | "highwayhash-64" | "highway64" => Some(Self::HighwayHash64),
            "metrohash64" | "metrohash-64" | "metro64" => Some(Self::MetroHash64),
            _ => None,
        }
    }
}

enum HasherImpl {
    Md5(md5::Md5),
    Sha1(sha1::Sha1),
    Sha224(sha2::Sha224),
    Sha256(sha2::Sha256),
    Sha384(sha2::Sha384),
    Sha512(sha2::Sha512),
    Sha3_256(sha3::Sha3_256),
    Sha512_224(sha2::Sha512_224),
    Sha512_256(sha2::Sha512_256),
    Sha3_224(sha3::Sha3_224),
    Sha3_384(sha3::Sha3_384),
    Sha3_512(sha3::Sha3_512),
    Keccak224(sha3::Keccak224),
    Keccak256(sha3::Keccak256),
    Keccak384(sha3::Keccak384),
    Keccak512(sha3::Keccak512),
    Shake128_256(sha3::Shake128),
    Shake256_256(sha3::Shake256),
    Blake3(blake3::Hasher),
    Blake2b512(blake2::Blake2b512),
    Blake2s256(blake2::Blake2s256),
    Ripemd160(ripemd::Ripemd160),
    Ripemd128(ripemd::Ripemd128),
    Ripemd256(ripemd::Ripemd256),
    Ripemd320(ripemd::Ripemd320),
    Xxh32(xxhash_rust::xxh32::Xxh32),
    Xxh64(xxhash_rust::xxh64::Xxh64),
    Xxh3_64(xxhash_rust::xxh3::Xxh3),
    FxHash64(rustc_hash::FxHasher),
    Fnv1a64(fnv::FnvHasher),
    SeaHash64(seahash::SeaHasher),
    Crc32(crc32fast::Hasher),
    Adler32(adler::Adler32),
    SipHash13(siphasher::sip::SipHasher13),
    SipHash24(siphasher::sip::SipHasher24),
    HighwayHash64(highway::HighwayHasher),
    MetroHash64(metrohash::MetroHash64),
}

impl HasherImpl {
    fn new(algorithm: Algorithm) -> Self {
        match algorithm {
            Algorithm::Md5 => Self::Md5(md5::Md5::new()),
            Algorithm::Sha1 => Self::Sha1(sha1::Sha1::new()),
            Algorithm::Sha224 => Self::Sha224(sha2::Sha224::new()),
            Algorithm::Sha256 => Self::Sha256(sha2::Sha256::new()),
            Algorithm::Sha384 => Self::Sha384(sha2::Sha384::new()),
            Algorithm::Sha512 => Self::Sha512(sha2::Sha512::new()),
            Algorithm::Sha3_256 => Self::Sha3_256(sha3::Sha3_256::new()),
            Algorithm::Sha512_224 => Self::Sha512_224(sha2::Sha512_224::new()),
            Algorithm::Sha512_256 => Self::Sha512_256(sha2::Sha512_256::new()),
            Algorithm::Sha3_224 => Self::Sha3_224(sha3::Sha3_224::new()),
            Algorithm::Sha3_384 => Self::Sha3_384(sha3::Sha3_384::new()),
            Algorithm::Sha3_512 => Self::Sha3_512(sha3::Sha3_512::new()),
            Algorithm::Keccak224 => Self::Keccak224(sha3::Keccak224::new()),
            Algorithm::Keccak256 => Self::Keccak256(sha3::Keccak256::new()),
            Algorithm::Keccak384 => Self::Keccak384(sha3::Keccak384::new()),
            Algorithm::Keccak512 => Self::Keccak512(sha3::Keccak512::new()),
            Algorithm::Shake128_256 => Self::Shake128_256(sha3::Shake128::default()),
            Algorithm::Shake256_256 => Self::Shake256_256(sha3::Shake256::default()),
            Algorithm::Blake3 => Self::Blake3(blake3::Hasher::new()),
            Algorithm::Blake2b512 => Self::Blake2b512(blake2::Blake2b512::new()),
            Algorithm::Blake2s256 => Self::Blake2s256(blake2::Blake2s256::new()),
            Algorithm::Ripemd160 => Self::Ripemd160(ripemd::Ripemd160::new()),
            Algorithm::Ripemd128 => Self::Ripemd128(ripemd::Ripemd128::new()),
            Algorithm::Ripemd256 => Self::Ripemd256(ripemd::Ripemd256::new()),
            Algorithm::Ripemd320 => Self::Ripemd320(ripemd::Ripemd320::new()),
            Algorithm::Xxh32 => Self::Xxh32(xxhash_rust::xxh32::Xxh32::new(0)),
            Algorithm::Xxh64 => Self::Xxh64(xxhash_rust::xxh64::Xxh64::new(0)),
            Algorithm::Xxh3_64 => Self::Xxh3_64(xxhash_rust::xxh3::Xxh3::new()),
            Algorithm::FxHash64 => Self::FxHash64(rustc_hash::FxHasher::default()),
            Algorithm::Fnv1a64 => Self::Fnv1a64(fnv::FnvHasher::default()),
            Algorithm::SeaHash64 => Self::SeaHash64(seahash::SeaHasher::new()),
            Algorithm::Crc32 => Self::Crc32(crc32fast::Hasher::new()),
            Algorithm::Adler32 => Self::Adler32(adler::Adler32::new()),
            Algorithm::SipHash13 => Self::SipHash13(siphasher::sip::SipHasher13::new_with_keys(0, 0)),
            Algorithm::SipHash24 => Self::SipHash24(siphasher::sip::SipHasher24::new_with_keys(0, 0)),
            Algorithm::HighwayHash64 => {
                let key = highway::Key([0, 0, 0, 0]);
                Self::HighwayHash64(highway::HighwayHasher::new(key))
            }
            Algorithm::MetroHash64 => Self::MetroHash64(metrohash::MetroHash64::new()),
        }
    }

    fn update(&mut self, chunk: &[u8]) {
        match self {
            Self::Md5(h) => h.update(chunk),
            Self::Sha1(h) => h.update(chunk),
            Self::Sha224(h) => h.update(chunk),
            Self::Sha256(h) => h.update(chunk),
            Self::Sha384(h) => h.update(chunk),
            Self::Sha512(h) => h.update(chunk),
            Self::Sha3_256(h) => h.update(chunk),
            Self::Sha512_224(h) => h.update(chunk),
            Self::Sha512_256(h) => h.update(chunk),
            Self::Sha3_224(h) => h.update(chunk),
            Self::Sha3_384(h) => h.update(chunk),
            Self::Sha3_512(h) => h.update(chunk),
            Self::Keccak224(h) => h.update(chunk),
            Self::Keccak256(h) => h.update(chunk),
            Self::Keccak384(h) => h.update(chunk),
            Self::Keccak512(h) => h.update(chunk),
            Self::Shake128_256(h) => digest::Update::update(h, chunk),
            Self::Shake256_256(h) => digest::Update::update(h, chunk),
            Self::Blake3(h) => {
                h.update(chunk);
            }
            Self::Blake2b512(h) => h.update(chunk),
            Self::Blake2s256(h) => h.update(chunk),
            Self::Ripemd160(h) => h.update(chunk),
            Self::Ripemd128(h) => h.update(chunk),
            Self::Ripemd256(h) => h.update(chunk),
            Self::Ripemd320(h) => h.update(chunk),
            Self::Xxh32(h) => h.update(chunk),
            Self::Xxh64(h) => h.write(chunk),
            Self::Xxh3_64(h) => h.write(chunk),
            Self::FxHash64(h) => h.write(chunk),
            Self::Fnv1a64(h) => h.write(chunk),
            Self::SeaHash64(h) => h.write(chunk),
            Self::Crc32(h) => h.update(chunk),
            Self::Adler32(h) => {
                h.write_slice(chunk);
            }
            Self::SipHash13(h) => h.write(chunk),
            Self::SipHash24(h) => h.write(chunk),
            Self::HighwayHash64(h) => {
                use highway::HighwayHash;
                h.append(chunk);
            }
            Self::MetroHash64(h) => h.write(chunk),
        }
    }

    fn finalize(self) -> Vec<u8> {
        match self {
            Self::Md5(h) => h.finalize().to_vec(),
            Self::Sha1(h) => h.finalize().to_vec(),
            Self::Sha224(h) => h.finalize().to_vec(),
            Self::Sha256(h) => h.finalize().to_vec(),
            Self::Sha384(h) => h.finalize().to_vec(),
            Self::Sha512(h) => h.finalize().to_vec(),
            Self::Sha3_256(h) => h.finalize().to_vec(),
            Self::Sha512_224(h) => h.finalize().to_vec(),
            Self::Sha512_256(h) => h.finalize().to_vec(),
            Self::Sha3_224(h) => h.finalize().to_vec(),
            Self::Sha3_384(h) => h.finalize().to_vec(),
            Self::Sha3_512(h) => h.finalize().to_vec(),
            Self::Keccak224(h) => h.finalize().to_vec(),
            Self::Keccak256(h) => h.finalize().to_vec(),
            Self::Keccak384(h) => h.finalize().to_vec(),
            Self::Keccak512(h) => h.finalize().to_vec(),
            Self::Shake128_256(h) => {
                let mut reader = h.finalize_xof();
                let mut out = [0u8; 32];
                reader.read(&mut out);
                out.to_vec()
            }
            Self::Shake256_256(h) => {
                let mut reader = h.finalize_xof();
                let mut out = [0u8; 32];
                reader.read(&mut out);
                out.to_vec()
            }
            Self::Blake3(h) => h.finalize().as_bytes().to_vec(),
            Self::Blake2b512(h) => h.finalize().to_vec(),
            Self::Blake2s256(h) => h.finalize().to_vec(),
            Self::Ripemd160(h) => h.finalize().to_vec(),
            Self::Ripemd128(h) => h.finalize().to_vec(),
            Self::Ripemd256(h) => h.finalize().to_vec(),
            Self::Ripemd320(h) => h.finalize().to_vec(),
            Self::Xxh32(h) => u32_to_bytes_le(h.digest()).to_vec(),
            Self::Xxh64(h) => u64_to_bytes_le(h.finish()).to_vec(),
            Self::Xxh3_64(h) => u64_to_bytes_le(h.finish()).to_vec(),
            Self::FxHash64(h) => u64_to_bytes_le(h.finish()).to_vec(),
            Self::Fnv1a64(h) => u64_to_bytes_le(h.finish()).to_vec(),
            Self::SeaHash64(h) => u64_to_bytes_le(h.finish()).to_vec(),
            Self::Crc32(h) => u32_to_bytes_le(h.finalize()).to_vec(),
            Self::Adler32(h) => u32_to_bytes_le(h.checksum()).to_vec(),
            Self::SipHash13(h) => u64_to_bytes_le(h.finish()).to_vec(),
            Self::SipHash24(h) => u64_to_bytes_le(h.finish()).to_vec(),
            Self::HighwayHash64(h) => {
                use highway::HighwayHash;
                u64_to_bytes_le(h.finalize64()).to_vec()
            }
            Self::MetroHash64(h) => u64_to_bytes_le(h.finish()).to_vec(),
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
            Algorithm::Sha1 => "sha1".to_string(),
            Algorithm::Sha224 => "sha224".to_string(),
            Algorithm::Sha256 => "sha256".to_string(),
            Algorithm::Sha384 => "sha384".to_string(),
            Algorithm::Sha512 => "sha512".to_string(),
            Algorithm::Sha512_224 => "sha512-224".to_string(),
            Algorithm::Sha512_256 => "sha512-256".to_string(),
            Algorithm::Sha3_256 => "sha3-256".to_string(),
            Algorithm::Sha3_224 => "sha3-224".to_string(),
            Algorithm::Sha3_384 => "sha3-384".to_string(),
            Algorithm::Sha3_512 => "sha3-512".to_string(),
            Algorithm::Keccak224 => "keccak-224".to_string(),
            Algorithm::Keccak256 => "keccak-256".to_string(),
            Algorithm::Keccak384 => "keccak-384".to_string(),
            Algorithm::Keccak512 => "keccak-512".to_string(),
            Algorithm::Shake128_256 => "shake128-256".to_string(),
            Algorithm::Shake256_256 => "shake256-256".to_string(),
            Algorithm::Blake3 => "blake3".to_string(),
            Algorithm::Blake2b512 => "blake2b-512".to_string(),
            Algorithm::Blake2s256 => "blake2s-256".to_string(),
            Algorithm::Ripemd160 => "ripemd-160".to_string(),
            Algorithm::Ripemd128 => "ripemd-128".to_string(),
            Algorithm::Ripemd256 => "ripemd-256".to_string(),
            Algorithm::Ripemd320 => "ripemd-320".to_string(),
            Algorithm::Xxh32 => "xxh32".to_string(),
            Algorithm::Xxh64 => "xxh64".to_string(),
            Algorithm::Xxh3_64 => "xxh3-64".to_string(),
            Algorithm::FxHash64 => "fxhash64".to_string(),
            Algorithm::Fnv1a64 => "fnv1a64".to_string(),
            Algorithm::SeaHash64 => "seahash64".to_string(),
            Algorithm::Crc32 => "crc32".to_string(),
            Algorithm::Adler32 => "adler32".to_string(),
            Algorithm::SipHash13 => "siphash-1-3".to_string(),
            Algorithm::SipHash24 => "siphash-2-4".to_string(),
            Algorithm::HighwayHash64 => "highwayhash64".to_string(),
            Algorithm::MetroHash64 => "metrohash64".to_string(),
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
    use digest::{ExtendableOutput, Update, XofReader};

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
    fn sha1_known_vector_abc() {
        // SHA-1("abc")
        assert_eq!(
            hash_text_utf8("sha1", "abc").unwrap(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
    }

    #[test]
    fn sha224_known_vector_abc() {
        // SHA-224("abc")
        assert_eq!(
            hash_text_utf8("sha224", "abc").unwrap(),
            "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"
        );
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
        for alg in ["sha1", "sha224", "sha256", "sha384", "sha512", "sha3-256"] {
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
    fn other_algorithms_match_reference() {
        let input = b"abc";

        // blake3
        let expected_blake3 = to_hex_lower(blake3::hash(input).as_bytes());
        assert_eq!(hash_bytes("blake3", input).unwrap(), expected_blake3);

        // blake2b-512
        let expected_blake2b = to_hex_lower(&blake2::Blake2b512::digest(input));
        assert_eq!(hash_bytes("blake2b-512", input).unwrap(), expected_blake2b);

        // blake2s-256
        let expected_blake2s = to_hex_lower(&blake2::Blake2s256::digest(input));
        assert_eq!(hash_bytes("blake2s-256", input).unwrap(), expected_blake2s);

        // sha512-224
        let expected_sha512_224 = to_hex_lower(&sha2::Sha512_224::digest(input));
        assert_eq!(hash_bytes("sha512-224", input).unwrap(), expected_sha512_224);

        // sha512-256
        let expected_sha512_256 = to_hex_lower(&sha2::Sha512_256::digest(input));
        assert_eq!(hash_bytes("sha512-256", input).unwrap(), expected_sha512_256);

        // sha3-224
        let expected_sha3_224 = to_hex_lower(&sha3::Sha3_224::digest(input));
        assert_eq!(hash_bytes("sha3-224", input).unwrap(), expected_sha3_224);

        // sha3-384
        let expected_sha3_384 = to_hex_lower(&sha3::Sha3_384::digest(input));
        assert_eq!(hash_bytes("sha3-384", input).unwrap(), expected_sha3_384);

        // sha3-512
        let expected_sha3_512 = to_hex_lower(&sha3::Sha3_512::digest(input));
        assert_eq!(hash_bytes("sha3-512", input).unwrap(), expected_sha3_512);

        // keccak-256
        let expected_keccak_256 = to_hex_lower(&sha3::Keccak256::digest(input));
        assert_eq!(hash_bytes("keccak-256", input).unwrap(), expected_keccak_256);

        // keccak-224
        let expected_keccak_224 = to_hex_lower(&sha3::Keccak224::digest(input));
        assert_eq!(hash_bytes("keccak-224", input).unwrap(), expected_keccak_224);

        // keccak-384
        let expected_keccak_384 = to_hex_lower(&sha3::Keccak384::digest(input));
        assert_eq!(hash_bytes("keccak-384", input).unwrap(), expected_keccak_384);

        // keccak-512
        let expected_keccak_512 = to_hex_lower(&sha3::Keccak512::digest(input));
        assert_eq!(hash_bytes("keccak-512", input).unwrap(), expected_keccak_512);

        // shake128-256 (fixed 32 bytes)
        let mut shake128 = sha3::Shake128::default();
        shake128.update(input);
        let mut reader128 = shake128.finalize_xof();
        let mut out128 = [0u8; 32];
        reader128.read(&mut out128);
        let expected_shake128_256 = to_hex_lower(&out128);
        assert_eq!(hash_bytes("shake128-256", input).unwrap(), expected_shake128_256);

        // shake256-256 (fixed 32 bytes)
        let mut shake256 = sha3::Shake256::default();
        shake256.update(input);
        let mut reader256 = shake256.finalize_xof();
        let mut out256 = [0u8; 32];
        reader256.read(&mut out256);
        let expected_shake256_256 = to_hex_lower(&out256);
        assert_eq!(hash_bytes("shake256-256", input).unwrap(), expected_shake256_256);

        // ripemd-160
        let expected_ripemd = to_hex_lower(&ripemd::Ripemd160::digest(input));
        assert_eq!(hash_bytes("ripemd-160", input).unwrap(), expected_ripemd);

        // ripemd-128
        let expected_ripemd128 = to_hex_lower(&ripemd::Ripemd128::digest(input));
        assert_eq!(hash_bytes("ripemd-128", input).unwrap(), expected_ripemd128);

        // ripemd-256
        let expected_ripemd256 = to_hex_lower(&ripemd::Ripemd256::digest(input));
        assert_eq!(hash_bytes("ripemd-256", input).unwrap(), expected_ripemd256);

        // ripemd-320
        let expected_ripemd320 = to_hex_lower(&ripemd::Ripemd320::digest(input));
        assert_eq!(hash_bytes("ripemd-320", input).unwrap(), expected_ripemd320);

        // xxh32 (little-endian bytes in our wasm API)
        let expected_xxh32 = to_hex_lower(&xxhash_rust::xxh32::xxh32(input, 0).to_le_bytes());
        assert_eq!(hash_bytes("xxh32", input).unwrap(), expected_xxh32);

        // xxh64 (little-endian bytes in our wasm API)
        let expected_xxh64 = to_hex_lower(&xxhash_rust::xxh64::xxh64(input, 0).to_le_bytes());
        assert_eq!(hash_bytes("xxh64", input).unwrap(), expected_xxh64);

        // xxh3-64 (little-endian bytes in our wasm API)
        let expected_xxh3 = to_hex_lower(&xxhash_rust::xxh3::xxh3_64(input).to_le_bytes());
        assert_eq!(hash_bytes("xxh3-64", input).unwrap(), expected_xxh3);

        // fxhash64
        let mut fx = rustc_hash::FxHasher::default();
        fx.write(input);
        let expected_fx = to_hex_lower(&fx.finish().to_le_bytes());
        assert_eq!(hash_bytes("fxhash64", input).unwrap(), expected_fx);

        // fnv1a64
        let mut fnv = fnv::FnvHasher::default();
        fnv.write(input);
        let expected_fnv = to_hex_lower(&fnv.finish().to_le_bytes());
        assert_eq!(hash_bytes("fnv1a64", input).unwrap(), expected_fnv);

        // seahash64
        let mut sea = seahash::SeaHasher::new();
        sea.write(input);
        let expected_sea = to_hex_lower(&sea.finish().to_le_bytes());
        assert_eq!(hash_bytes("seahash64", input).unwrap(), expected_sea);

        // crc32 (little-endian bytes in our wasm API)
        let expected_crc32 = to_hex_lower(&crc32fast::hash(input).to_le_bytes());
        assert_eq!(hash_bytes("crc32", input).unwrap(), expected_crc32);

        // adler32 (little-endian bytes in our wasm API)
        let expected_adler32 = to_hex_lower(&adler::adler32_slice(input).to_le_bytes());
        assert_eq!(hash_bytes("adler32", input).unwrap(), expected_adler32);

        // siphash-1-3 (k0=k1=0)
        let mut sip13 = siphasher::sip::SipHasher13::new_with_keys(0, 0);
        sip13.write(input);
        let expected_sip13 = to_hex_lower(&sip13.finish().to_le_bytes());
        assert_eq!(hash_bytes("siphash-1-3", input).unwrap(), expected_sip13);

        // siphash-2-4 (k0=k1=0)
        let mut sip24 = siphasher::sip::SipHasher24::new_with_keys(0, 0);
        sip24.write(input);
        let expected_sip24 = to_hex_lower(&sip24.finish().to_le_bytes());
        assert_eq!(hash_bytes("siphash-2-4", input).unwrap(), expected_sip24);

        // highwayhash64 (key = 0)
        let key = highway::Key([0, 0, 0, 0]);
        let mut highway_hasher = highway::HighwayHasher::new(key);
        use highway::HighwayHash;
        highway_hasher.append(input);
        let expected_highway64 = to_hex_lower(&highway_hasher.finalize64().to_le_bytes());
        assert_eq!(hash_bytes("highwayhash64", input).unwrap(), expected_highway64);

        // metrohash64
        let mut metro = metrohash::MetroHash64::new();
        metro.write(input);
        let expected_metro64 = to_hex_lower(&metro.finish().to_le_bytes());
        assert_eq!(hash_bytes("metrohash64", input).unwrap(), expected_metro64);
    }

    #[test]
    fn crc32_known_vector_123456789() {
        // CRC-32/ISO-HDLC (aka "CRC-32" / IEEE 802.3)
        // CRC32("123456789") = 0xCBF43926
        assert_eq!(hash_text_utf8("crc32", "123456789").unwrap(), "2639f4cb");
    }

    #[test]
    fn adler32_known_vectors() {
        // Adler32("") = 1
        assert_eq!(hash_text_utf8("adler32", "").unwrap(), "01000000");

        // Adler32("Wikipedia") = 0x11E60398
        assert_eq!(hash_text_utf8("adler32", "Wikipedia").unwrap(), "9803e611");
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
