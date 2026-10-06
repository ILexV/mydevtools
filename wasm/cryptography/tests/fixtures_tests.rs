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
