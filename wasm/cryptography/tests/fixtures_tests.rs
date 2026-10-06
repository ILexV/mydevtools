use mydevtools_cryptography::{detached, openssh};

mod common;

#[test]
fn openssh_public_key_fixture_parses() {
    let line = common::read_fixture("openssh_ed25519_public_key.txt");

    let alg = openssh::openssh_public_key_algorithm(&line).expect("alg");
    assert_eq!(alg, 1);

    let bytes = openssh::openssh_public_key_bytes(&line).expect("bytes");
    assert_eq!(bytes.len(), 32);
}

#[test]
fn detached_signature_fixture_parses() {
    let data = common::read_fixture_b64("detached_signature_packed.b64");

    let info = detached::detached_signature_info(&data).expect("info");
    assert_eq!(info[0], 1);
    assert_eq!(info[1], 64);

    let sig = detached::detached_signature_extract(&data).expect("sig");
    assert_eq!(sig.len(), 64);
}

#[test]
fn openssh_public_key_fixture_spki_roundtrip() {
    // Real ssh-keygen Ed25519 key: OpenSSH line → SPKI PEM → OpenSSH line.
    let line = common::read_fixture("openssh_ed25519_public_key.txt");
    let comment = line.split_whitespace().nth(2).map(str::to_string);
    let spki = openssh::openssh_public_key_to_spki_pem(&line).expect("to spki");
    assert!(spki.starts_with("-----BEGIN PUBLIC KEY-----"));
    let back = openssh::openssh_public_key_from_spki_pem(&spki, comment).expect("from spki");
    assert_eq!(back.split_whitespace().take(2).collect::<Vec<_>>(), line.split_whitespace().take(2).collect::<Vec<_>>());
}

#[test]
fn aead_mdt2_legacy_fixture_still_decrypts() {
    // Produced by the pre-MDT3 site code (scratch gen-mdt2.mjs) with small
    // Argon2id params (256 KiB, 1 iteration, 1 lane), ChaCha20-Poly1305,
    // 1000-byte chunks, password "legacy pass", plaintext (i*7) % 251 × 2500.
    use mydevtools_cryptography::aead;
    let container = common::read_fixture_b64("aead_mdt2_legacy_chacha.b64");
    assert_eq!(&container[..4], b"MDT2");
    let info = aead::aead_stream_header_info(&container[..128]).expect("info");
    assert_eq!(info[6], 2, "format");
    let header = &container[..info[5] as usize];
    let key = aead::aead_stream_derive_key_from_header(header, b"legacy pass", 256, 1, 1).expect("key");
    let plain = aead::stream_open(&container, &key).expect("legacy MDT2 must still open");
    let expected: Vec<u8> = (0..2500u32).map(|i| (i * 7 % 251) as u8).collect();
    assert_eq!(plain, expected);
    // The site-parameter fixture (1 MiB chunk header) parses as MDT2 too.
    let site = common::read_fixture_b64("aead_mdt2_legacy_site.b64");
    assert_eq!(aead::parse_stream_header_core(&site).expect("site").chunk_size, 1024 * 1024);
}
