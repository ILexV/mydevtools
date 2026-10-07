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

/// One capture group of a match. Every group of the pattern (1..=n) is
/// reported, in pattern order: a group that did not participate in the match
/// (optional / other alternation branch) has `matched: false` and no
/// text/range, which keeps it distinct from a group that matched "".
#[derive(Serialize, Debug, PartialEq)]
pub struct CaptureGroup {
    /// Group number as in the pattern (1-based; 0 is the whole match).
    pub index: usize,
    /// User-defined name, verbatim, for `(?<name>…)` / `(?P<name>…)`.
    pub name: Option<String>,
    pub matched: bool,
    pub text: Option<String>,
    pub start: Option<usize>,
    pub end: Option<usize>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RegexResult {
    pub matches: Vec<RegexMatch>,
    pub error: Option<String>,
    /// True when matching stopped at `MAX_MATCHES`.
    pub truncated: bool,
    /// Names of capture groups 1..=n (None = unnamed). Known even without
    /// matches, so the UI can draw a group legend for any valid pattern.
    pub groups: Vec<Option<String>>,
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
            return RegexResult { matches: Vec::new(), error: Some(e.to_string()), truncated: false, groups: Vec::new() };
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
            let name = names.get(i).cloned().flatten();
            captures.push(match cap.get(i) {
                Some(c) => CaptureGroup {
                    index: i,
                    name,
                    matched: true,
                    text: Some(c.as_str().to_string()),
                    start: Some(cursor.peek(c.start())),
                    end: Some(cursor.peek(c.end())),
                },
                None => CaptureGroup { index: i, name, matched: false, text: None, start: None, end: None },
            });
        }
        let end = cursor.peek(full.end());
        matches.push(RegexMatch { text: full.as_str().to_string(), start, end, captures });
    }

    let groups = names.into_iter().skip(1).collect();
    RegexResult { matches, error: None, truncated, groups }
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
        assert_eq!((m.captures[0].start, m.captures[0].end), (Some(6), Some(8)));
        assert_eq!((m.captures[1].start, m.captures[1].end), (Some(7), Some(8)));
        assert_eq!((m.captures[0].index, m.captures[1].index), (1, 2));
    }

    #[test]
    fn capture_groups_named_and_positional() {
        let r = run_regex(r"(?P<year>\d{4})-(\d{2})", "до 2024-05");
        assert_eq!(r.matches.len(), 1);
        let m = &r.matches[0];
        assert_eq!((m.start, m.end), (3, 10));
        assert_eq!(m.captures.len(), 2);
        assert_eq!(m.captures[0].name.as_deref(), Some("year"));
        assert_eq!((m.captures[0].start, m.captures[0].end, m.captures[0].text.as_deref()), (Some(3), Some(7), Some("2024")));
        assert_eq!(m.captures[1].name, None);
        assert_eq!((m.captures[1].start, m.captures[1].end), (Some(8), Some(10)));
        assert_eq!(r.groups, vec![Some("year".to_string()), None]);
    }

    #[test]
    fn group_offsets_after_emoji_are_utf16() {
        // 😀 = 2 UTF-16 units, "й" = 1; group 1 starts right after the emoji.
        let r = run_regex(r"😀(й+)", "x😀йй");
        let g = &r.matches[0].captures[0];
        assert_eq!((g.start, g.end, g.text.as_deref()), (Some(3), Some(5), Some("йй")));
    }

    #[test]
    fn optional_group_that_did_not_participate_is_reported_unmatched() {
        let r = run_regex(r"a(b)?(c*)", "a");
        assert_eq!(r.matches.len(), 1);
        let caps = &r.matches[0].captures;
        assert_eq!(caps.len(), 2);
        assert!(!caps[0].matched);
        assert_eq!((caps[0].index, caps[0].text.as_deref(), caps[0].start), (1, None, None));
        // Participating but empty: matched with "" and a zero-length range.
        assert!(caps[1].matched);
        assert_eq!((caps[1].text.as_deref(), caps[1].start, caps[1].end), (Some(""), Some(1), Some(1)));
    }

    #[test]
    fn groups_listed_without_matches_and_on_error() {
        assert_eq!(run_regex(r"(x)(?<n>y)", "abc").groups, vec![None, Some("n".to_string())]);
        assert!(run_regex(r"(x", "abc").groups.is_empty());
        assert!(run_regex(r"x", "abc").groups.is_empty());
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
