use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_cryptography@0.1.0".to_string()
}

/// Placeholder function (no real crypto yet).
#[wasm_bindgen]
pub fn xor_bytes(a: u8, b: u8) -> u8 {
    a ^ b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xor_bytes_works() {
        assert_eq!(xor_bytes(0b1010, 0b1100), 0b0110);
    }
}
