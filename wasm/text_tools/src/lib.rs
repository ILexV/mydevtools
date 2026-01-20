use wasm_bindgen::prelude::*;
use convert_case::{Case, Casing};

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_text_tools@0.1.0".to_string()
}

#[wasm_bindgen]
pub fn convert_text_case(text: &str, case_type: &str) -> Result<String, String> {
    if case_type == "sentence" {
        return Ok(to_sentence_case(text));
    }
    if case_type == "inverse" {
        return Ok(text.chars().map(|c| {
            if c.is_lowercase() {
                c.to_uppercase().to_string()
            } else {
                c.to_lowercase().to_string()
            }
        }).collect());
    }

    let case = match case_type {
        "upper" => Case::Upper,
        "lower" => Case::Lower,
        "title" => Case::Title,
        "camel" => Case::Camel,
        "snake" => Case::Snake,
        "kebab" => Case::Kebab,
        "pascal" => Case::Pascal,
        "train" => Case::Train,
        "alternating" => Case::Alternating,
        _ => return Err(format!("Unknown case type: {}", case_type)),
    };
    
    Ok(text.to_case(case))
}

fn to_sentence_case(text: &str) -> String {
    // Simple sentence case: Uppercase first letter, lowercase rest.
    // Ideally split by sentences, but for now treat whole block as one "sentence" style or line by line?
    // convertcase.net treats the whole selection or line. 
    // Let's just lowercase everything and uppercase the very first char.
    // Or maybe we should split by '.'? 
    // Let's stick to simple "First letter upper, rest lower" for the whole string for now, 
    // as "Sentence Case" often implies that for headlines.
    // Better: let's try to be smart about ". "
    
    let mut result = String::with_capacity(text.len());
    let mut new_sentence = true;
    
    for c in text.chars() {
        if new_sentence && c.is_alphanumeric() {
            result.extend(c.to_uppercase());
            new_sentence = false;
        } else {
            result.extend(c.to_lowercase());
        }
        
        if c == '.' || c == '!' || c == '?' {
            new_sentence = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upper() {
        assert_eq!(convert_text_case("hello", "upper").unwrap(), "HELLO");
    }

    #[test]
    fn test_sentence() {
        assert_eq!(convert_text_case("hello world. how are you?", "sentence").unwrap(), "Hello world. How are you?");
    }
}
