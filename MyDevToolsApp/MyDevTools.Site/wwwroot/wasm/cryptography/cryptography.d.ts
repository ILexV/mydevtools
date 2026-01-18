/* tslint:disable */
/* eslint-disable */

/**
 * Decrypts data with the custom header using the provided key and AAD.
 */
export function aead_decrypt_with_header(data: Uint8Array, key: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Decrypts data with header using password-derived key.
 *
 * kdf: 1 = Argon2id, 2 = PBKDF2-SHA512
 */
export function aead_decrypt_with_password(data: Uint8Array, kdf_id: number, password: Uint8Array, mem_kib: number, iterations: number, parallelism: number, aad: Uint8Array): Uint8Array;

/**
 * Derives a 12-byte nonce from 4-byte prefix + 64-bit counter (big-endian).
 */
export function aead_derive_nonce_12(prefix4: Uint8Array, counter: bigint): Uint8Array;

/**
 * Derives a 24-byte nonce from 16-byte prefix + 64-bit counter (big-endian).
 */
export function aead_derive_nonce_24(prefix16: Uint8Array, counter: bigint): Uint8Array;

/**
 * Encrypts and prepends a custom AEAD header.
 *
 * algorithm: 1 = AES-256-GCM, 2 = ChaCha20-Poly1305, 3 = XChaCha20-Poly1305
 */
export function aead_encrypt_with_header(algorithm: number, key: Uint8Array, salt: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Encrypts with password-derived key and prepends a custom AEAD header.
 *
 * kdf: 1 = Argon2id, 2 = PBKDF2-SHA512
 */
export function aead_encrypt_with_password(algorithm: number, kdf_id: number, password: Uint8Array, salt: Uint8Array, nonce: Uint8Array, mem_kib: number, iterations: number, parallelism: number, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;

/**
 * Extracts ciphertext (payload after header).
 */
export function aead_extract_ciphertext(data: Uint8Array): Uint8Array;

/**
 * Extracts nonce from header.
 */
export function aead_extract_nonce(data: Uint8Array): Uint8Array;

/**
 * Extracts salt from header.
 */
export function aead_extract_salt(data: Uint8Array): Uint8Array;

/**
 * Returns header info: [algorithm, salt_len, nonce_len, tag_len, header_len].
 */
export function aead_header_info(data: Uint8Array): Uint32Array;

/**
 * Decrypts a single chunk using stream parameters.
 */
export function aead_stream_decrypt_chunk(algorithm: number, key: Uint8Array, nonce_prefix: Uint8Array, counter: bigint, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Derives key from stream header (password-based).
 */
export function aead_stream_derive_key_from_header(data: Uint8Array, password: Uint8Array, mem_kib: number, iterations: number, parallelism: number): Uint8Array;

/**
 * Encrypts a single chunk using stream parameters.
 */
export function aead_stream_encrypt_chunk(algorithm: number, key: Uint8Array, nonce_prefix: Uint8Array, counter: bigint, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Extracts nonce prefix from stream header.
 */
export function aead_stream_extract_nonce_prefix(data: Uint8Array): Uint8Array;

/**
 * Extracts salt from stream header.
 */
export function aead_stream_extract_salt(data: Uint8Array): Uint8Array;

/**
 * Returns stream header info: [algorithm, kdf_id, salt_len, nonce_prefix_len, chunk_size, header_len].
 */
export function aead_stream_header_info(data: Uint8Array): Uint32Array;

/**
 * Builds a stream header for chunk-by-chunk encryption.
 */
export function aead_stream_header_pack(algorithm: number, kdf_id: number, salt: Uint8Array, nonce_prefix: Uint8Array, chunk_size: number): Uint8Array;

/**
 * AES-256-GCM decrypt (nonce = 12 bytes). Expects ciphertext with tag appended.
 */
export function aes256_gcm_decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Chunk decrypt helper (AES-256-GCM) using prefix+counter nonce.
 */
export function aes256_gcm_decrypt_chunk(key: Uint8Array, prefix4: Uint8Array, counter: bigint, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * AES-256-GCM encrypt (nonce = 12 bytes). Returns ciphertext with tag appended.
 */
export function aes256_gcm_encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Chunk encrypt helper (AES-256-GCM) using prefix+counter nonce.
 */
export function aes256_gcm_encrypt_chunk(key: Uint8Array, prefix4: Uint8Array, counter: bigint, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * ChaCha20-Poly1305 decrypt (nonce = 12 bytes). Expects ciphertext with tag appended.
 */
export function chacha20_poly1305_decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Chunk decrypt helper (ChaCha20-Poly1305) using prefix+counter nonce.
 */
export function chacha20_poly1305_decrypt_chunk(key: Uint8Array, prefix4: Uint8Array, counter: bigint, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * ChaCha20-Poly1305 encrypt (nonce = 12 bytes). Returns ciphertext with tag appended.
 */
export function chacha20_poly1305_encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Chunk encrypt helper (ChaCha20-Poly1305) using prefix+counter nonce.
 */
export function chacha20_poly1305_encrypt_chunk(key: Uint8Array, prefix4: Uint8Array, counter: bigint, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Signs data with selected algorithm and packs into detached signature format.
 */
export function detached_sign_and_pack(algorithm: number, private_key: Uint8Array, message: Uint8Array): Uint8Array;

/**
 * Extracts the raw signature bytes.
 */
export function detached_signature_extract(data: Uint8Array): Uint8Array;

/**
 * Returns header info: [algorithm, sig_len, header_len].
 */
export function detached_signature_info(data: Uint8Array): Uint32Array;

/**
 * Packs a detached signature with a tiny header.
 *
 * Format: "MDS1" + version(1) + alg(1) + sig_len(u32) + sig_bytes
 */
export function detached_signature_pack(algorithm: number, signature: Uint8Array): Uint8Array;

/**
 * Verifies packed detached signature (algorithm is read from header).
 */
export function detached_verify_packed(public_key: Uint8Array, message: Uint8Array, packed: Uint8Array): boolean;

/**
 * Generates a new ECDSA P-256 keypair.
 *
 * Returns 96 bytes: [private_key(32) || public_key_uncompressed(65)]
 */
export function ecdsa_p256_generate_keypair(): Uint8Array;

/**
 * Converts PKCS#8 DER to a 32-byte ECDSA P-256 private key.
 */
export function ecdsa_p256_private_key_from_pkcs8(private_key_der: Uint8Array): Uint8Array;

/**
 * Converts a 32-byte ECDSA P-256 private key to PKCS#8 DER.
 */
export function ecdsa_p256_private_key_to_pkcs8(private_key: Uint8Array): Uint8Array;

/**
 * Derives the P-256 public key from a 32-byte private key (uncompressed SEC1).
 */
export function ecdsa_p256_public_key(private_key: Uint8Array): Uint8Array;

/**
 * Signs a message using a 32-byte ECDSA P-256 private key.
 */
export function ecdsa_p256_sign(private_key: Uint8Array, message: Uint8Array): Uint8Array;

/**
 * Verifies a DER-encoded signature using a P-256 uncompressed public key (65 bytes).
 */
export function ecdsa_p256_verify(public_key_uncompressed: Uint8Array, message: Uint8Array, signature_der: Uint8Array): boolean;

/**
 * Generates a new ECDSA P-384 keypair.
 *
 * Returns 113 bytes: [private_key(48) || public_key_uncompressed(97)]
 */
export function ecdsa_p384_generate_keypair(): Uint8Array;

/**
 * Converts PKCS#8 DER to a 48-byte ECDSA P-384 private key.
 */
export function ecdsa_p384_private_key_from_pkcs8(private_key_der: Uint8Array): Uint8Array;

/**
 * Converts a 48-byte ECDSA P-384 private key to PKCS#8 DER.
 */
export function ecdsa_p384_private_key_to_pkcs8(private_key: Uint8Array): Uint8Array;

/**
 * Derives the P-384 public key from a 48-byte private key (uncompressed SEC1).
 */
export function ecdsa_p384_public_key(private_key: Uint8Array): Uint8Array;

/**
 * Signs a message using a 48-byte ECDSA P-384 private key.
 */
export function ecdsa_p384_sign(private_key: Uint8Array, message: Uint8Array): Uint8Array;

/**
 * Verifies a DER-encoded signature using a P-384 uncompressed public key (97 bytes).
 */
export function ecdsa_p384_verify(public_key_uncompressed: Uint8Array, message: Uint8Array, signature_der: Uint8Array): boolean;

/**
 * Generates a new Ed25519 keypair.
 *
 * Returns 64 bytes: [private_key(32) || public_key(32)].
 */
export function ed25519_generate_keypair(): Uint8Array;

/**
 * Converts PKCS#8 DER to a 32-byte Ed25519 private key.
 */
export function ed25519_private_key_from_pkcs8(private_key_der: Uint8Array): Uint8Array;

/**
 * Converts a 32-byte Ed25519 private key to PKCS#8 DER.
 */
export function ed25519_private_key_to_pkcs8(private_key: Uint8Array): Uint8Array;

/**
 * Derives the Ed25519 public key from a 32-byte private key.
 */
export function ed25519_public_key(private_key: Uint8Array): Uint8Array;

/**
 * Signs a message using a 32-byte Ed25519 private key.
 */
export function ed25519_sign(private_key: Uint8Array, message: Uint8Array): Uint8Array;

/**
 * Verifies a signature using a 32-byte Ed25519 public key.
 */
export function ed25519_verify(public_key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;

/**
 * Derives a 32-byte key using Argon2id.
 *
 * Params are intentionally explicit for UI control.
 */
export function kdf_argon2id(password: Uint8Array, salt: Uint8Array, mem_kib: number, iterations: number, parallelism: number): Uint8Array;

/**
 * Derives a 32-byte key using PBKDF2-HMAC-SHA512.
 */
export function kdf_pbkdf2_sha512(password: Uint8Array, salt: Uint8Array, iterations: number): Uint8Array;

/**
 * Parses an OpenSSH ECDSA P-256 public key line and returns the uncompressed public key.
 */
export function openssh_ecdsa_p256_parse_public_key(line: string): Uint8Array;

/**
 * Builds OpenSSH private key (new format) for ECDSA P-256.
 */
export function openssh_ecdsa_p256_private_key(private_key: Uint8Array, comment?: string | null, passphrase?: string | null, rounds?: number | null): string;

/**
 * Builds OpenSSH public key line for ECDSA P-256.
 *
 * Output: "ecdsa-sha2-nistp256 <base64> [comment]"
 */
export function openssh_ecdsa_p256_public_key(public_key_uncompressed: Uint8Array, comment?: string | null): string;

/**
 * Builds OpenSSH public key line for ECDSA P-256 from a 32-byte private key.
 */
export function openssh_ecdsa_p256_public_key_from_private(private_key: Uint8Array, comment?: string | null): string;

/**
 * Parses an OpenSSH ECDSA P-384 public key line and returns the uncompressed public key.
 */
export function openssh_ecdsa_p384_parse_public_key(line: string): Uint8Array;

/**
 * Builds OpenSSH private key (new format) for ECDSA P-384.
 */
export function openssh_ecdsa_p384_private_key(private_key: Uint8Array, comment?: string | null, passphrase?: string | null, rounds?: number | null): string;

/**
 * Builds OpenSSH public key line for ECDSA P-384.
 *
 * Output: "ecdsa-sha2-nistp384 <base64> [comment]"
 */
export function openssh_ecdsa_p384_public_key(public_key_uncompressed: Uint8Array, comment?: string | null): string;

/**
 * Builds OpenSSH public key line for ECDSA P-384 from a 48-byte private key.
 */
export function openssh_ecdsa_p384_public_key_from_private(private_key: Uint8Array, comment?: string | null): string;

/**
 * Parses an OpenSSH Ed25519 public key line and returns the raw 32-byte public key.
 */
export function openssh_ed25519_parse_public_key(line: string): Uint8Array;

/**
 * Builds OpenSSH private key (new format) for Ed25519.
 */
export function openssh_ed25519_private_key(private_key: Uint8Array, comment?: string | null, passphrase?: string | null, rounds?: number | null): string;

/**
 * Builds OpenSSH public key line for Ed25519.
 *
 * Output: "ssh-ed25519 <base64> [comment]"
 */
export function openssh_ed25519_public_key(public_key: Uint8Array, comment?: string | null): string;

/**
 * Builds OpenSSH public key line for Ed25519 from a 32-byte private key.
 */
export function openssh_ed25519_public_key_from_private(private_key: Uint8Array, comment?: string | null): string;

/**
 * Returns algorithm id for an OpenSSH private key (new format).
 */
export function openssh_private_key_algorithm(pem: string, passphrase?: string | null): number;

/**
 * Returns comment from an OpenSSH private key (new format).
 */
export function openssh_private_key_comment(pem: string, passphrase?: string | null): string;

/**
 * Converts PKCS#8 DER to OpenSSH private key (new format).
 */
export function openssh_private_key_from_pkcs8(private_key_der: Uint8Array, comment?: string | null, passphrase?: string | null, rounds?: number | null): string;

/**
 * Converts PKCS#8 PEM (encrypted or not) to OpenSSH private key (new format).
 */
export function openssh_private_key_from_pkcs8_pem(pem: string, pkcs8_passphrase?: string | null, comment?: string | null, passphrase?: string | null, rounds?: number | null): string;

/**
 * Returns private key bytes from an OpenSSH private key (new format).
 * Ed25519/ECDSA return raw private key bytes. RSA returns PKCS#8 DER.
 */
export function openssh_private_key_private_key_bytes(pem: string, passphrase?: string | null): Uint8Array;

/**
 * Returns public key bytes from an OpenSSH private key (new format).
 */
export function openssh_private_key_public_key_bytes(pem: string, passphrase?: string | null): Uint8Array;

/**
 * Converts an OpenSSH private key (new format) to PKCS#8 DER.
 */
export function openssh_private_key_to_pkcs8(pem: string, passphrase?: string | null): Uint8Array;

/**
 * Converts an OpenSSH private key (new format) to PKCS#8 PEM.
 */
export function openssh_private_key_to_pkcs8_pem(pem: string, passphrase?: string | null): string;

/**
 * Converts an OpenSSH private key (new format) to OpenSSH public key line.
 */
export function openssh_private_key_to_public_key_line(pem: string, passphrase?: string | null, comment_override?: string | null): string;

/**
 * Converts an OpenSSH private key (new format) to SPKI DER (RSA/ECDSA only).
 */
export function openssh_private_key_to_spki(pem: string, passphrase?: string | null): Uint8Array;

/**
 * Returns warnings for OpenSSH private key (RSA size, ssh-rsa deprecation).
 */
export function openssh_private_key_warnings(pem: string, passphrase?: string | null): string[];

/**
 * Returns algorithm id for a supported OpenSSH public key line.
 *
 * 1 = Ed25519, 2 = ECDSA P-256, 3 = ECDSA P-384
 */
export function openssh_public_key_algorithm(line: string): number;

/**
 * Parses an OpenSSH public key line (Ed25519/P-256/P-384) and returns raw key bytes.
 */
export function openssh_public_key_bytes(line: string): Uint8Array;

/**
 * Converts SPKI PEM to OpenSSH public key line (RSA/ECDSA only).
 */
export function openssh_public_key_from_spki_pem(pem: string, comment?: string | null): string;

/**
 * Converts an OpenSSH public key line to SPKI DER (RSA/ECDSA only).
 */
export function openssh_public_key_to_spki(line: string): Uint8Array;

/**
 * Converts an OpenSSH public key line to SPKI PEM (RSA/ECDSA only).
 */
export function openssh_public_key_to_spki_pem(line: string): string;

/**
 * Returns warnings for OpenSSH public key (RSA size, ssh-rsa deprecation).
 */
export function openssh_public_key_warnings(line: string): string[];

/**
 * Parses an OpenSSH RSA public key line and returns SPKI DER.
 */
export function openssh_rsa_parse_public_key(line: string): Uint8Array;

/**
 * Builds OpenSSH private key (new format) for RSA from PKCS#8 DER.
 */
export function openssh_rsa_private_key_from_pkcs8(private_key_der: Uint8Array, comment?: string | null, passphrase?: string | null, rounds?: number | null): string;

/**
 * Builds OpenSSH public key line for RSA from PKCS#8 private key (DER).
 */
export function openssh_rsa_public_key_from_private_pkcs8(private_key_der: Uint8Array, comment?: string | null): string;

/**
 * Builds OpenSSH public key line for RSA from SPKI DER.
 *
 * Output: "ssh-rsa <base64> [comment]"
 */
export function openssh_rsa_public_key_from_spki(public_key_der: Uint8Array, comment?: string | null): string;

/**
 * Generates an RSA private key (PKCS#8 DER). Recommended bits: 3072 or 4096.
 */
export function rsa_generate_private_key_pkcs8(bits: number): Uint8Array;

/**
 * Signs message using RSA-PSS with SHA-256.
 *
 * private_key_der: PKCS#8 DER
 */
export function rsa_pss_sign_pkcs8(private_key_der: Uint8Array, message: Uint8Array, salt_len: number): Uint8Array;

/**
 * Verifies message using RSA-PSS with SHA-256.
 *
 * public_key_der: SubjectPublicKeyInfo (SPKI) DER
 */
export function rsa_pss_verify_spki(public_key_der: Uint8Array, message: Uint8Array, signature: Uint8Array, salt_len: number): boolean;

/**
 * Derives RSA public key (SPKI DER) from a PKCS#8 private key.
 */
export function rsa_public_key_from_private_pkcs8(private_key_der: Uint8Array): Uint8Array;

/**
 * Parses RSA public key (SPKI DER) to validate it is well-formed.
 */
export function rsa_validate_public_key_spki(public_key_der: Uint8Array): boolean;

/**
 * Signs data using selected algorithm.
 *
 * Algorithms:
 * 1 = Ed25519 (signature = 64 bytes)
 * 2 = ECDSA P-256 (signature = DER)
 * 3 = ECDSA P-384 (signature = DER)
 */
export function sign_detached(algorithm: number, private_key: Uint8Array, message: Uint8Array): Uint8Array;

/**
 * Verifies a detached signature using selected algorithm.
 */
export function verify_detached(algorithm: number, public_key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;

export function version(): string;

/**
 * Basic chain checks for a PEM certificate list (order: leaf -> root).
 *
 * Note: signature verification is not performed; checks only subject/issuer linkage and validity.
 */
export function x509_chain_warnings_pem(pem_chain: string[], now_unix: bigint): string[];

/**
 * Generates a CSR and private key (PEM).
 *
 * algorithm: 1 = Ed25519, 2 = ECDSA P-256, 3 = ECDSA P-384
 * Returns [csr_pem, key_pem].
 */
export function x509_csr_pem(algorithm: number, subject_cn: string | null | undefined, san_dns: string[], san_ip: string[]): string[];

/**
 * Parses certificate from DER and returns JSON string with basic fields.
 */
export function x509_parse_der(der: Uint8Array): string;

/**
 * Parses certificate from PEM and returns JSON string with basic fields.
 */
export function x509_parse_pem(pem: string): string;

/**
 * Generates a self-signed certificate and private key (PEM).
 *
 * algorithm: 1 = Ed25519, 2 = ECDSA P-256, 3 = ECDSA P-384
 * Returns [cert_pem, key_pem].
 */
export function x509_self_signed_pem(algorithm: number, subject_cn: string | null | undefined, san_dns: string[], san_ip: string[]): string[];

/**
 * Returns warnings for a DER certificate (provide current unix timestamp).
 */
export function x509_warnings_der(der: Uint8Array, now_unix: bigint): string[];

/**
 * Returns warnings for a PEM certificate (provide current unix timestamp).
 */
export function x509_warnings_pem(pem: string, now_unix: bigint): string[];

/**
 * XChaCha20-Poly1305 decrypt (nonce = 24 bytes). Expects ciphertext with tag appended.
 */
export function xchacha20_poly1305_decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Chunk decrypt helper (XChaCha20-Poly1305) using prefix+counter nonce.
 */
export function xchacha20_poly1305_decrypt_chunk(key: Uint8Array, prefix16: Uint8Array, counter: bigint, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * XChaCha20-Poly1305 encrypt (nonce = 24 bytes). Returns ciphertext with tag appended.
 */
export function xchacha20_poly1305_encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Chunk encrypt helper (XChaCha20-Poly1305) using prefix+counter nonce.
 */
export function xchacha20_poly1305_encrypt_chunk(key: Uint8Array, prefix16: Uint8Array, counter: bigint, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly openssh_ecdsa_p256_parse_public_key: (a: number, b: number) => [number, number, number, number];
    readonly openssh_ecdsa_p256_private_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly openssh_ecdsa_p256_public_key: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_ecdsa_p256_public_key_from_private: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_ecdsa_p384_parse_public_key: (a: number, b: number) => [number, number, number, number];
    readonly openssh_ecdsa_p384_private_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly openssh_ecdsa_p384_public_key: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_ecdsa_p384_public_key_from_private: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_ed25519_parse_public_key: (a: number, b: number) => [number, number, number, number];
    readonly openssh_ed25519_private_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly openssh_ed25519_public_key: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_ed25519_public_key_from_private: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_private_key_algorithm: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly openssh_private_key_comment: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_private_key_from_pkcs8: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly openssh_private_key_from_pkcs8_pem: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly openssh_private_key_private_key_bytes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_private_key_public_key_bytes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_private_key_to_pkcs8: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_private_key_to_pkcs8_pem: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_private_key_to_public_key_line: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly openssh_private_key_to_spki: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_private_key_warnings: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_public_key_algorithm: (a: number, b: number) => [number, number, number];
    readonly openssh_public_key_bytes: (a: number, b: number) => [number, number, number, number];
    readonly openssh_public_key_from_spki_pem: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_public_key_to_spki: (a: number, b: number) => [number, number, number, number];
    readonly openssh_public_key_to_spki_pem: (a: number, b: number) => [number, number, number, number];
    readonly openssh_public_key_warnings: (a: number, b: number) => [number, number, number, number];
    readonly openssh_rsa_parse_public_key: (a: number, b: number) => [number, number, number, number];
    readonly openssh_rsa_private_key_from_pkcs8: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly openssh_rsa_public_key_from_private_pkcs8: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly openssh_rsa_public_key_from_spki: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly aead_decrypt_with_header: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly aead_decrypt_with_password: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly aead_derive_nonce_12: (a: number, b: number, c: bigint) => [number, number, number, number];
    readonly aead_derive_nonce_24: (a: number, b: number, c: bigint) => [number, number, number, number];
    readonly aead_encrypt_with_header: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly aead_encrypt_with_password: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number, number];
    readonly aead_extract_ciphertext: (a: number, b: number) => [number, number, number, number];
    readonly aead_extract_nonce: (a: number, b: number) => [number, number, number, number];
    readonly aead_extract_salt: (a: number, b: number) => [number, number, number, number];
    readonly aead_header_info: (a: number, b: number) => [number, number, number, number];
    readonly aead_stream_decrypt_chunk: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly aead_stream_derive_key_from_header: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly aead_stream_encrypt_chunk: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly aead_stream_extract_nonce_prefix: (a: number, b: number) => [number, number, number, number];
    readonly aead_stream_extract_salt: (a: number, b: number) => [number, number, number, number];
    readonly aead_stream_header_info: (a: number, b: number) => [number, number, number, number];
    readonly aead_stream_header_pack: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly aes256_gcm_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly aes256_gcm_decrypt_chunk: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly aes256_gcm_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly aes256_gcm_encrypt_chunk: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly chacha20_poly1305_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly chacha20_poly1305_decrypt_chunk: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly chacha20_poly1305_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly chacha20_poly1305_encrypt_chunk: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly xchacha20_poly1305_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly xchacha20_poly1305_decrypt_chunk: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly xchacha20_poly1305_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly xchacha20_poly1305_encrypt_chunk: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly x509_chain_warnings_pem: (a: number, b: number, c: bigint) => [number, number, number, number];
    readonly x509_csr_pem: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly x509_parse_der: (a: number, b: number) => [number, number, number, number];
    readonly x509_parse_pem: (a: number, b: number) => [number, number, number, number];
    readonly x509_self_signed_pem: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly x509_warnings_der: (a: number, b: number, c: bigint) => [number, number, number, number];
    readonly x509_warnings_pem: (a: number, b: number, c: bigint) => [number, number, number, number];
    readonly kdf_argon2id: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly kdf_pbkdf2_sha512: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly sign_detached: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly verify_detached: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly detached_sign_and_pack: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly detached_signature_extract: (a: number, b: number) => [number, number, number, number];
    readonly detached_signature_info: (a: number, b: number) => [number, number, number, number];
    readonly detached_signature_pack: (a: number, b: number, c: number) => [number, number, number, number];
    readonly detached_verify_packed: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly ecdsa_p256_generate_keypair: () => [number, number, number, number];
    readonly ecdsa_p256_private_key_from_pkcs8: (a: number, b: number) => [number, number, number, number];
    readonly ecdsa_p256_private_key_to_pkcs8: (a: number, b: number) => [number, number, number, number];
    readonly ecdsa_p256_public_key: (a: number, b: number) => [number, number, number, number];
    readonly ecdsa_p256_sign: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly ecdsa_p256_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly ecdsa_p384_generate_keypair: () => [number, number, number, number];
    readonly ecdsa_p384_private_key_from_pkcs8: (a: number, b: number) => [number, number, number, number];
    readonly ecdsa_p384_private_key_to_pkcs8: (a: number, b: number) => [number, number, number, number];
    readonly ecdsa_p384_public_key: (a: number, b: number) => [number, number, number, number];
    readonly ecdsa_p384_sign: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly ecdsa_p384_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly ed25519_generate_keypair: () => [number, number, number, number];
    readonly ed25519_private_key_from_pkcs8: (a: number, b: number) => [number, number, number, number];
    readonly ed25519_private_key_to_pkcs8: (a: number, b: number) => [number, number, number, number];
    readonly ed25519_public_key: (a: number, b: number) => [number, number, number, number];
    readonly ed25519_sign: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly ed25519_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly version: () => [number, number];
    readonly rsa_generate_private_key_pkcs8: (a: number) => [number, number, number, number];
    readonly rsa_pss_sign_pkcs8: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly rsa_pss_verify_spki: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly rsa_public_key_from_private_pkcs8: (a: number, b: number) => [number, number, number, number];
    readonly rsa_validate_public_key_spki: (a: number, b: number) => [number, number, number];
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
