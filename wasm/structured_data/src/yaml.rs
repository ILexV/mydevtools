use wasm_bindgen::prelude::*;
use yaml_rust::YamlEmitter;
use yaml_rust::YamlLoader;

/// YAML beautifier: formats YAML, but comments are not preserved due to library limitations.
#[wasm_bindgen]
pub fn yaml_format(input: &str) -> Result<String, JsValue> {
    let docs = YamlLoader::load_from_str(input)
        .map_err(|e| JsValue::from_str(&format!("YAML parsing error: {}", e)))?;

    let mut output = String::new();
    {
        let mut emitter = YamlEmitter::new(&mut output);
        for doc in &docs {
            emitter.dump(doc);
        }
    }

    Ok(output)
}

/// YAML validator: checks if input is valid YAML.
#[wasm_bindgen]
pub fn yaml_validate(input: &str) -> Result<(), JsValue> {
    YamlLoader::load_from_str(input)
        .map_err(|e| JsValue::from_str(&format!("YAML validation error: {}", e)))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_format_valid() {
        let input = "key: value\nlist:\n  - item1\n  - item2";
        let result = yaml_format(input).unwrap();
        assert!(result.contains("key: value"));
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn yaml_format_invalid() {
        let input = "key: value\n  invalid: [unclosed";
        assert!(yaml_format(input).is_err());
    }

    #[test]
    fn yaml_validate_valid() {
        let input = "key: value\nlist:\n  - item1\n  - item2";
        assert!(yaml_validate(input).is_ok());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn yaml_validate_invalid() {
        let input = "key: value\n  invalid: [unclosed";
        assert!(yaml_validate(input).is_err());
    }
}
