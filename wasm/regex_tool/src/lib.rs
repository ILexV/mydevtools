use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use regex::Regex;

#[derive(Serialize)]
struct RegexMatch {
    text: String,
    start: usize,
    end: usize,
    captures: Vec<CaptureGroup>,
}

#[derive(Serialize)]
struct CaptureGroup {
    name: Option<String>,
    text: String,
    start: usize,
    end: usize,
}

#[derive(Serialize)]
struct RegexResult {
    matches: Vec<RegexMatch>,
    error: Option<String>,
}

#[wasm_bindgen]
pub fn test_regex(pattern: &str, text: &str) -> JsValue {
    match Regex::new(pattern) {
        Ok(re) => {
            let mut matches = Vec::new();
            
            for cap in re.captures_iter(text) {
                let full_match = cap.get(0).unwrap(); // 0 is always present if captures_iter yielded
                let mut capture_groups = Vec::new();

                // Iterate over all capture groups (including implicit ones, but skipping 0 usually as it's the whole match)
                // However, regex crate's captures.iter() includes the whole match at index 0.
                // We want explicit groups or named groups.
                // captures.len() returns total groups.
                
                for i in 1..cap.len() {
                    if let Some(c) = cap.get(i) {
                         // internal regex logic to find name if it exists is a bit complex with just index loop
                         // simple approach: just store them by index/name if possible
                         // Regex crate doesn't easily map index -> name in the iteration without looking up names
                         // Actually `re.capture_names()` gives an iterator of names.
                         
                         let name = re.capture_names().nth(i).flatten().map(|s| s.to_string());
                         
                         capture_groups.push(CaptureGroup {
                             name,
                             text: c.as_str().to_string(),
                             start: c.start(),
                             end: c.end(),
                         });
                    }
                }

                matches.push(RegexMatch {
                    text: full_match.as_str().to_string(),
                    start: full_match.start(),
                    end: full_match.end(),
                    captures: capture_groups,
                });
            }

            let result = RegexResult {
                matches,
                error: None,
            };
            serde_wasm_bindgen::to_value(&result).unwrap()
        },
        Err(e) => {
            let result = RegexResult {
                matches: Vec::new(),
                error: Some(e.to_string()),
            };
            serde_wasm_bindgen::to_value(&result).unwrap()
        }
    }
}
