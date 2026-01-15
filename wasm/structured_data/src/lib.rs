use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_structured_data@0.1.0".to_string()
}

/// Placeholder "format" operation.
///
/// For now it just trims outer whitespace; later this module will handle JSON/XML/YAML
/// formatting, normalization, validation, and (optionally) conversions.
#[wasm_bindgen]
pub fn normalize_whitespace(input: &str) -> String {
    input.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_whitespace_trims() {
        assert_eq!(normalize_whitespace("  hi \n"), "hi");
    }
}
