use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_hash@0.1.0".to_string()
}

/// Placeholder hash implementation.
///
/// This is NOT a real hash yet; it only exists to validate toolchain and module wiring.
#[wasm_bindgen]
pub fn placeholder_hash(input: &str) -> String {
    format!("hash:{}:{}", input.len(), input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_hash_is_stable() {
        assert_eq!(placeholder_hash("abc"), "hash:3:abc");
    }
}
