use wasm_bindgen::prelude::*;

pub mod aead;
pub mod detached;
pub mod ecdsa;
pub mod ed25519;
pub mod kdf;
pub mod openssh;
pub mod signing;
pub mod rsa_pss;
pub mod x509;

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_cryptography@0.1.0".to_string()
}
