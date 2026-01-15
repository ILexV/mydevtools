use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_encoding@0.1.0".to_string()
}

/// Placeholder hex encoder (ASCII bytes).
#[wasm_bindgen]
pub fn to_hex(input: &str) -> String {
    input
        .as_bytes()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_hex_works() {
        assert_eq!(to_hex("Hi"), "4869");
    }
}
