use wasm_bindgen::prelude::*;
use yaml_rust::YamlEmitter;
use yaml_rust::YamlLoader;

/// Pure YAML pretty-printer (native-testable core of `yaml_format`).
/// Every document is re-emitted with a `---` header; multi-document input is
/// separated by newlines. Comments are not preserved (yaml-rust limitation).
/// Errors carry the scanner message with line/column.
pub fn format_yaml(input: &str) -> Result<String, String> {
    let docs = YamlLoader::load_from_str(input).map_err(|e| e.to_string())?;
    let mut parts = Vec::with_capacity(docs.len());
    for doc in &docs {
        let mut out = String::new();
        YamlEmitter::new(&mut out).dump(doc).map_err(|e| format!("{e:?}"))?;
        parts.push(out);
    }
    Ok(parts.join("\n"))
}

/// Pure YAML syntax check (native-testable core of `yaml_validate`).
pub fn validate_yaml(input: &str) -> Result<(), String> {
    YamlLoader::load_from_str(input).map(|_| ()).map_err(|e| e.to_string())
}

/// YAML beautifier: formats YAML, but comments are not preserved due to library limitations.
/// Error text is the parser detail (the UI prefixes a localized "invalid" label).
#[wasm_bindgen]
pub fn yaml_format(input: &str) -> Result<String, JsValue> {
    format_yaml(input).map_err(|e| JsValue::from_str(&e))
}

/// YAML validator: checks if input is valid YAML; error text is the parser detail.
#[wasm_bindgen]
pub fn yaml_validate(input: &str) -> Result<(), JsValue> {
    validate_yaml(input).map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_mapping_and_sequence() {
        let input = "key:   value\nlist:\n    - item1\n    -   item2\nnested: {a: 1, b: [x, y]}";
        assert_eq!(
            format_yaml(input).unwrap(),
            "---\nkey: value\nlist:\n  - item1\n  - item2\nnested:\n  a: 1\n  b:\n    - x\n    - y"
        );
    }

    #[test]
    fn format_scalars_keep_types_and_quote_when_needed() {
        let out = format_yaml("a: 'true'\nb: true\nc: '123'\nd: 1.50\ne: ~\nf: \"x: y\"").unwrap();
        assert_eq!(out, "---\na: \"true\"\nb: true\nc: \"123\"\nd: 1.50\ne: ~\nf: \"x: y\"");
    }

    #[test]
    fn format_unicode_and_emoji() {
        let out = format_yaml("имя: Ёжик 🦔\n日本: 語").unwrap();
        assert_eq!(out, "---\nимя: Ёжик 🦔\n日本: 語");
    }

    #[test]
    fn format_multi_document_keeps_documents_separated() {
        let out = format_yaml("a: 1\n---\nb: 2\n").unwrap();
        assert_eq!(out, "---\na: 1\n---\nb: 2");
        // Round-trip stays valid and keeps both documents.
        assert_eq!(YamlLoader::load_from_str(&out).unwrap().len(), 2);
    }

    #[test]
    fn legacy_shared_emitter_glued_documents() {
        // Regression: the old implementation dumped every document through one
        // emitter, producing "---\na: 1---\nb: 2" (documents glued on one line).
        let docs = YamlLoader::load_from_str("a: 1\n---\nb: 2").unwrap();
        let mut glued = String::new();
        {
            let mut emitter = YamlEmitter::new(&mut glued);
            for doc in &docs {
                emitter.dump(doc).unwrap();
            }
        }
        assert_eq!(glued, "---\na: 1---\nb: 2");
        assert_eq!(format_yaml("a: 1\n---\nb: 2").unwrap(), "---\na: 1\n---\nb: 2");
    }

    #[test]
    fn format_is_idempotent() {
        let once = format_yaml("x:\n  - {k: v, n: [1, 2]}\n  - plain\n").unwrap();
        assert_eq!(format_yaml(&once).unwrap(), once);
    }

    #[test]
    fn format_deep_nesting() {
        let depth = 200;
        let mut input = String::new();
        for i in 0..depth {
            input.push_str(&" ".repeat(i * 2));
            input.push_str("k:\n");
        }
        input.push_str(&" ".repeat(depth * 2));
        input.push_str("v");
        let out = format_yaml(&input).unwrap();
        // `---` header + one line per level; the innermost scalar shares the last key's line.
        assert_eq!(out.lines().count(), depth + 1);
        assert!(out.ends_with(&format!("{}k: v", " ".repeat((depth - 1) * 2))));
        assert_eq!(format_yaml(&out).unwrap(), out);
    }

    #[test]
    fn format_empty_input_is_empty() {
        assert_eq!(format_yaml("").unwrap(), "");
        assert_eq!(format_yaml("# only a comment\n").unwrap(), "");
    }

    #[test]
    fn invalid_yaml_reports_position() {
        for bad in ["key: value\n  invalid: [unclosed", "a: [1, 2", "a: b: c", "- a\nb: c"] {
            let err = format_yaml(bad).unwrap_err();
            assert!(err.contains("line"), "{bad:?} → {err}");
            assert!(validate_yaml(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn validate_valid_inputs() {
        for ok in ["key: value\nlist:\n  - item1\n  - item2", "", "---\n...\n", "a: |\n  multi\n  line\n", "[1, 2, 3]"] {
            assert!(validate_yaml(ok).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn wasm_wrappers_succeed_on_valid_input() {
        assert!(yaml_format("key: value").unwrap().contains("key: value"));
        assert!(yaml_validate("key: value").is_ok());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn wasm_wrappers_fail_on_invalid_input() {
        assert!(yaml_format("key: value\n  invalid: [unclosed").is_err());
        assert!(yaml_validate("key: value\n  invalid: [unclosed").is_err());
    }
}
