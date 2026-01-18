use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;

pub fn read_fixture(name: &str) -> String {
    std::fs::read_to_string(format!("tests/fixtures/{}", name))
        .expect("fixture")
        .trim()
        .to_string()
}

pub fn read_fixture_b64(name: &str) -> Vec<u8> {
    let b64 = read_fixture(name);
    BASE64_STANDARD.decode(b64.as_bytes()).expect("b64")
}
