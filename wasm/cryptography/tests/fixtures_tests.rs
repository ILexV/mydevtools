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
