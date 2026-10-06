use regex::Regex;
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Hard cap on reported matches so a pattern like `.` or `a*` over a huge text
/// cannot serialize millions of objects into JS and freeze the tab.
pub const MAX_MATCHES: usize = 10_000;

#[derive(Serialize, Debug, PartialEq)]
pub struct RegexMatch {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub captures: Vec<CaptureGroup>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CaptureGroup {
    pub name: Option<String>,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RegexResult {
    pub matches: Vec<RegexMatch>,
    pub error: Option<String>,
    /// True when matching stopped at `MAX_MATCHES`.
    pub truncated: bool,
}

/// Incremental byte-offset → UTF-16 code-unit offset converter. JS strings are
/// indexed in UTF-16 units, Rust `regex` reports UTF-8 byte offsets; without
/// conversion highlights drift on any non-ASCII text (Cyrillic, CJK, emoji).
/// Match starts are queried in non-decreasing order, so the whole scan is O(n).
struct Utf16Cursor<'a> {
    text: &'a str,
    byte: usize,
    unit: usize,
}

impl<'a> Utf16Cursor<'a> {
    fn new(text: &'a str) -> Self {
        Self { text, byte: 0, unit: 0 }
    }

    fn advance_to(&mut self, byte: usize) -> usize {
        self.unit += self.text[self.byte..byte].encode_utf16().count();
        self.byte = byte;
        self.unit
    }

    /// Offset of `byte` inside the current match (`byte >= self.byte`), without moving.
    fn peek(&self, byte: usize) -> usize {
        self.unit + self.text[self.byte..byte].encode_utf16().count()
    }
}

/// Runs `pattern` over `text` (Rust regex syntax, inline flags like `(?i)`).
/// Positions in the result are UTF-16 code-unit offsets (JS string indices).
/// Invalid patterns return `error` with the engine message and no matches.
pub fn run_regex(pattern: &str, text: &str) -> RegexResult {
    let re = match Regex::new(pattern) {
        Ok(re) => re,
        Err(e) => {
            return RegexResult { matches: Vec::new(), error: Some(e.to_string()), truncated: false };
        }
    };
    let names: Vec<Option<String>> = re.capture_names().map(|n| n.map(str::to_string)).collect();
    let mut cursor = Utf16Cursor::new(text);
    let mut matches = Vec::new();
    let mut truncated = false;

    for cap in re.captures_iter(text) {
        if matches.len() == MAX_MATCHES {
            truncated = true;
            break;
        }
        let full = cap.get(0).expect("group 0 is always present");
        let start = cursor.advance_to(full.start());
        let mut captures = Vec::new();
        for i in 1..cap.len() {
            if let Some(c) = cap.get(i) {
                captures.push(CaptureGroup {
                    name: names.get(i).cloned().flatten(),
                    text: c.as_str().to_string(),
                    start: cursor.peek(c.start()),
                    end: cursor.peek(c.end()),
                });
            }
        }
        let end = cursor.peek(full.end());
        matches.push(RegexMatch { text: full.as_str().to_string(), start, end, captures });
    }

    RegexResult { matches, error: None, truncated }
}

#[wasm_bindgen]
pub fn test_regex(pattern: &str, text: &str) -> JsValue {
    serde_wasm_bindgen::to_value(&run_regex(pattern, text)).unwrap_or(JsValue::NULL)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(r: &RegexResult) -> Vec<(usize, usize, &str)> {
        r.matches.iter().map(|m| (m.start, m.end, m.text.as_str())).collect()
    }

    #[test]
    fn ascii_matches_and_positions() {
        let r = run_regex(r"\d+", "a1 b22 c333");
        assert_eq!(r.error, None);
        assert!(!r.truncated);
        assert_eq!(spans(&r), vec![(1, 2, "1"), (4, 6, "22"), (8, 11, "333")]);
    }

    #[test]
    fn offsets_are_utf16_for_cyrillic_cjk_and_emoji() {
        // "Привет" is 12 UTF-8 bytes but 6 UTF-16 units; 😀 is 4 bytes / 2 units.
        let text = "Привет мир 😀 日本 ok";
        let r = run_regex(r"ok|мир|日本|😀", text);
        let js: Vec<u16> = text.encode_utf16().collect();
        for m in &r.matches {
            let slice = String::from_utf16(&js[m.start..m.end]).unwrap();
            assert_eq!(slice, m.text, "UTF-16 slice must equal match text");
        }
        assert_eq!(spans(&r), vec![(7, 10, "мир"), (11, 13, "😀"), (14, 16, "日本"), (17, 19, "ok")]);
    }

    #[test]
    fn nested_groups_positions() {
        let r = run_regex(r"(ж(ё))", "ааж ё жё");
        let m = &r.matches[0];
        assert_eq!((m.start, m.end), (6, 8));
        assert_eq!((m.captures[0].start, m.captures[0].end), (6, 8));
        assert_eq!((m.captures[1].start, m.captures[1].end), (7, 8));
    }

    #[test]
    fn capture_groups_named_and_positional() {
        let r = run_regex(r"(?P<year>\d{4})-(\d{2})", "до 2024-05");
        assert_eq!(r.matches.len(), 1);
        let m = &r.matches[0];
        assert_eq!((m.start, m.end), (3, 10));
        assert_eq!(m.captures.len(), 2);
        assert_eq!(m.captures[0].name.as_deref(), Some("year"));
        assert_eq!((m.captures[0].start, m.captures[0].end, m.captures[0].text.as_str()), (3, 7, "2024"));
        assert_eq!(m.captures[1].name, None);
        assert_eq!((m.captures[1].start, m.captures[1].end), (8, 10));
    }

    #[test]
    fn optional_group_that_did_not_participate_is_skipped() {
        let r = run_regex(r"a(b)?", "a");
        assert_eq!(r.matches.len(), 1);
        assert!(r.matches[0].captures.is_empty());
    }

    #[test]
    fn inline_flags_case_insensitive_multiline_dotall() {
        assert_eq!(run_regex("(?i)HELLO", "hello").matches.len(), 1);
        assert_eq!(run_regex("(?m)^x", "x\nx").matches.len(), 2);
        assert_eq!(run_regex("^x", "x\nx").matches.len(), 1);
        assert_eq!(run_regex("(?s)a.b", "a\nb").matches.len(), 1);
        assert_eq!(run_regex("a.b", "a\nb").matches.len(), 0);
    }

    #[test]
    fn invalid_pattern_reports_error() {
        let r = run_regex("(unclosed", "text");
        assert!(r.matches.is_empty());
        assert!(r.error.as_deref().unwrap_or("").contains("unclosed group"));
    }

    #[test]
    fn lookaround_and_backrefs_are_rejected_not_hung() {
        assert!(run_regex(r"(?=a)", "a").error.is_some());
        assert!(run_regex(r"(a)\1", "aa").error.is_some());
    }

    #[test]
    fn catastrophic_backtracking_pattern_is_linear() {
        // Exponential in backtracking engines; the Rust engine finishes instantly.
        let text = format!("{}!", "a".repeat(50_000));
        let r = run_regex(r"^(a+)+$", &text);
        assert_eq!(r.error, None);
        assert!(r.matches.is_empty());
    }

    #[test]
    fn empty_matches_and_cap() {
        let r = run_regex("x*", "ab");
        assert_eq!(spans(&r), vec![(0, 0, ""), (1, 1, ""), (2, 2, "")]);

        let big = "a".repeat(MAX_MATCHES + 5);
        let r = run_regex("a", &big);
        assert_eq!(r.matches.len(), MAX_MATCHES);
        assert!(r.truncated);
    }

    #[test]
    fn empty_text_and_pattern() {
        assert!(run_regex("a", "").matches.is_empty());
        assert_eq!(run_regex("", "ab").matches.len(), 3);
    }
}
