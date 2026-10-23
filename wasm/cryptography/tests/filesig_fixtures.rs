//! File signatures against real tools: signatures made by `ssh-keygen -Y sign` and
//! `openssl dgst/pkeyutl` (tests/fixtures/filesig, OpenSSH 10.2, OpenSSL 3.5).
use mydevtools_cryptography::filesig::{FileSignatureVerifier, FileSigner};
use serde_json::Value;

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/filesig/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|_| panic!("missing fixture {path}"))
}

fn text(name: &str) -> String {
    String::from_utf8(fixture(name)).expect("utf-8 fixture")
}

fn verify(sig: &[u8], key: &str, ns: &str, data: &[u8]) -> Value {
    let mut v = FileSignatureVerifier::new(sig, key, ns).ok().expect("verifier");
    for chunk in data.chunks(1000) {
        v.update(chunk).ok().expect("update");
    }
    serde_json::from_str(&v.finish()).expect("json")
}

#[test]
fn ssh_keygen_signatures_verify() {
    let data = fixture("data.txt");
    let signers = text("allowed_signers");
    for (key, alg) in [("ed25519", "Ed25519"), ("ecdsa256", "ECDSA P-256"), ("ecdsa384", "ECDSA P-384"), ("rsa", "RSA 3072")] {
        let sig = fixture(&format!("ssh_{key}.sig"));
        let r = verify(&sig, &signers, "file", &data);
        assert_eq!(r["valid"], true, "{key}: {r}");
        assert_eq!(r["algorithm"], alg);
        assert_eq!(r["principal"], format!("{key}@example.com"));
        assert_eq!(r["hash"], "SHA-512");
        let mut tampered = data.clone();
        tampered[0] ^= 1;
        assert_eq!(verify(&sig, &signers, "file", &tampered)["failure"], "signature", "{key}");
        // A .pub file is accepted as the trusted key too.
        assert_eq!(verify(&sig, &text(&format!("ssh_{key}.pub")), "file", &data)["valid"], true, "{key}");
    }
}

#[test]
fn openssl_signatures_verify() {
    let data = fixture("data.txt");
    for (sig, key, scheme, hash) in [
        ("ossl_ed25519.sig", "ossl_ed25519.pub.pem", "Ed25519", "—"),
        ("ossl_p384_sha384.sig", "ossl_p384.pub.pem", "ECDSA P-384 · DER", "SHA-384"),
        ("ossl_p384_sha384.sig", "ossl_p384_cert.pem", "ECDSA P-384 · DER", "SHA-384"),
        ("ossl_rsa_pkcs1_sha256.sig", "ossl_rsa.pub.pem", "RSA PKCS#1 v1.5", "SHA-256"),
        ("ossl_rsa_pss_sha256.sig", "ossl_rsa.pub.pem", "RSA-PSS", "SHA-256"),
        ("ossl_rsa_pssmax_sha512.sig", "ossl_rsa.pub.pem", "RSA-PSS", "SHA-512"),
    ] {
        let r = verify(&fixture(sig), &text(key), "", &data);
        assert_eq!(r["valid"], true, "{sig}: {r}");
        assert_eq!(r["scheme"], scheme, "{sig}");
        assert_eq!(r["hash"], hash, "{sig}");
        assert_eq!(r["encoding"], "binary", "{sig}");
    }
}

#[test]
fn signing_with_every_key_format_roundtrips() {
    let data = fixture("data.txt");
    for (key, pass) in [
        ("ssh_ed25519", None),
        ("ssh_ed25519_enc", Some("correct horse")),
        ("ssh_ecdsa384", None),
        ("ssh_rsa", None),
        ("ossl_p384_enc.pem", Some("secret")),
        ("ossl_p384_sec1.pem", None),
        ("ossl_rsa_pkcs1.pem", None),
        ("ossl_ed25519.pem", None),
    ] {
        for options in [r#"{"format":"sshsig","namespace":"file"}"#, r#"{"format":"raw","hash":"sha512","padding":"pss"}"#] {
            let mut s = FileSigner::new(&text(key), pass.map(str::to_string), options).ok().expect("signer");
            let info: Value = serde_json::from_str(&s.info()).unwrap();
            for chunk in data.chunks(999) {
                s.update(chunk).ok().unwrap();
            }
            let out: Value = serde_json::from_str(&s.finish().ok().unwrap()).unwrap();
            let r = match out.get("armored") {
                Some(armored) => verify(armored.as_str().unwrap().as_bytes(), info["publicKey"].as_str().unwrap(), "file", &data),
                None => verify(out["signature"].as_str().unwrap().as_bytes(), info["publicKeyPem"].as_str().unwrap(), "", &data),
            };
            assert_eq!(r["valid"], true, "{key} {options}: {r}");
            assert_eq!(r["fingerprint"], info["fingerprint"]);
        }
    }
}
