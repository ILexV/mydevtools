/**
 * Hash algorithm catalog (39) — canonical ids matching `wasm/hash` `Algorithm::parse`
 * (first alias of each match arm). Display labels are user-facing names; the id
 * is what's sent to WASM. Source of truth: `wasm/hash/src/lib.rs`.
 */
export interface HashAlgorithm {
  id: string;
  label: string;
}

export const HASH_ALGORITHMS: readonly HashAlgorithm[] = [
  { id: "md5", label: "MD5" },
  { id: "sha1", label: "SHA-1" },
  { id: "sha224", label: "SHA-224" },
  { id: "sha256", label: "SHA-256" },
  { id: "sha384", label: "SHA-384" },
  { id: "sha512", label: "SHA-512" },
  { id: "sha512-224", label: "SHA-512/224" },
  { id: "sha512-256", label: "SHA-512/256" },
  { id: "streebog-256", label: "Streebog-256" },
  { id: "streebog-512", label: "Streebog-512" },
  { id: "sha3-224", label: "SHA3-224" },
  { id: "sha3-256", label: "SHA3-256" },
  { id: "sha3-384", label: "SHA3-384" },
  { id: "sha3-512", label: "SHA3-512" },
  { id: "keccak-224", label: "Keccak-224" },
  { id: "keccak-256", label: "Keccak-256" },
  { id: "keccak-384", label: "Keccak-384" },
  { id: "keccak-512", label: "Keccak-512" },
  { id: "shake128", label: "SHAKE128-256" },
  { id: "shake256", label: "SHAKE256-256" },
  { id: "blake3", label: "BLAKE3" },
  { id: "blake2b", label: "BLAKE2b-512" },
  { id: "blake2s", label: "BLAKE2s-256" },
  { id: "ripemd128", label: "RIPEMD-128" },
  { id: "ripemd160", label: "RIPEMD-160" },
  { id: "ripemd256", label: "RIPEMD-256" },
  { id: "ripemd320", label: "RIPEMD-320" },
  { id: "xxh32", label: "xxHash32" },
  { id: "xxh64", label: "xxHash64" },
  { id: "xxh3", label: "xxh3-64" },
  { id: "fxhash", label: "FxHash64" },
  { id: "fnv", label: "FNV-1a-64" },
  { id: "seahash", label: "SeaHash64" },
  { id: "crc32", label: "CRC32" },
  { id: "adler32", label: "Adler-32" },
  { id: "siphash13", label: "SipHash-1-3" },
  { id: "siphash24", label: "SipHash-2-4" },
  { id: "highwayhash64", label: "HighwayHash64" },
  { id: "metrohash64", label: "MetroHash64" },
] as const;

/** Default selection (matches legacy): MD5, SHA-1, SHA-256. */
export const DEFAULT_HASH_ALGORITHMS: readonly string[] = ["md5", "sha1", "sha256"];
