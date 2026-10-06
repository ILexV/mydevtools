use wasm_bindgen::prelude::*;
use rand::Rng;

#[wasm_bindgen]
pub struct PasswordOptions {
    pub length: usize,
    pub uppercase: bool,
    pub lowercase: bool,
    pub numbers: bool,
    pub special: bool,
    #[wasm_bindgen(getter_with_clone)]
    pub special_chars: String,
}

#[wasm_bindgen]
impl PasswordOptions {
    #[wasm_bindgen(constructor)]
    pub fn new(
        length: usize,
        uppercase: bool,
        lowercase: bool,
        numbers: bool,
        special: bool,
        special_chars: String,
    ) -> PasswordOptions {
        PasswordOptions {
            length,
            uppercase,
            lowercase,
            numbers,
            special,
            special_chars,
        }
    }
}

const UPPERCASE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE: &str = "abcdefghijklmnopqrstuvwxyz";
const NUMBERS: &str = "0123456789";
const DEFAULT_SPECIAL: &str = "!@#$%^&*()_+-=[]{}|;:,.<>?";

/// Builds the candidate alphabet from the selected character classes.
/// Custom symbols replace the default special set; duplicates and
/// whitespace/control chars are dropped so every symbol has equal
/// probability (typing "!!!!a" must not make '!' four times likelier).
fn build_charset(options: &PasswordOptions) -> Vec<char> {
    let mut charset: Vec<char> = Vec::new();
    let mut push_unique = |set: &str| {
        for ch in set.chars() {
            if !ch.is_whitespace() && !ch.is_control() && !charset.contains(&ch) {
                charset.push(ch);
            }
        }
    };
    if options.uppercase {
        push_unique(UPPERCASE);
    }
    if options.lowercase {
        push_unique(LOWERCASE);
    }
    if options.numbers {
        push_unique(NUMBERS);
    }
    if options.special {
        let custom = options.special_chars.trim();
        push_unique(if custom.is_empty() { DEFAULT_SPECIAL } else { custom });
    }
    charset
}

/// Random password over the alphabet (CSPRNG via `rand::thread_rng`).
/// `None` when no character class is selected / the alphabet is empty.
fn generate_with<R: Rng>(options: &PasswordOptions, rng: &mut R) -> Option<String> {
    let charset = build_charset(options);
    if charset.is_empty() {
        return None;
    }
    Some(
        (0..options.length)
            .map(|_| charset[rng.gen_range(0..charset.len())])
            .collect(),
    )
}

#[wasm_bindgen]
pub fn generate_password(options: &PasswordOptions) -> Result<String, JsValue> {
    generate_with(options, &mut rand::thread_rng())
        .ok_or_else(|| JsValue::from_str("No character set selected"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(len: usize, u: bool, l: bool, n: bool, s: bool, custom: &str) -> PasswordOptions {
        PasswordOptions::new(len, u, l, n, s, custom.to_string())
    }

    fn gen(o: &PasswordOptions) -> String {
        generate_with(o, &mut rand::thread_rng()).expect("charset")
    }

    #[test]
    fn length_is_exact_in_chars() {
        for len in [4usize, 16, 64, 128] {
            assert_eq!(gen(&opts(len, true, true, true, true, "")).chars().count(), len);
        }
        // Multi-byte custom symbols: length counts chars, not bytes.
        assert_eq!(gen(&opts(32, false, false, false, true, "€ж😀")).chars().count(), 32);
    }

    #[test]
    fn only_selected_classes_are_used() {
        let p = gen(&opts(200, false, false, true, false, ""));
        assert!(p.chars().all(|c| c.is_ascii_digit()), "{p}");
        let p = gen(&opts(200, true, false, false, false, ""));
        assert!(p.chars().all(|c| c.is_ascii_uppercase()), "{p}");
        let p = gen(&opts(200, false, true, false, false, ""));
        assert!(p.chars().all(|c| c.is_ascii_lowercase()), "{p}");
        let p = gen(&opts(200, false, false, false, true, ""));
        assert!(p.chars().all(|c| DEFAULT_SPECIAL.contains(c)), "{p}");
    }

    #[test]
    fn custom_symbols_replace_default_special_set() {
        let p = gen(&opts(300, false, false, false, true, "#~"));
        assert!(p.chars().all(|c| c == '#' || c == '~'), "{p}");
        assert!(p.contains('#') && p.contains('~'));
    }

    #[test]
    fn custom_symbols_are_deduplicated_and_whitespace_dropped() {
        let charset = build_charset(&opts(8, false, false, false, true, "!!!! a\t\n!a"));
        assert_eq!(charset, vec!['!', 'a']);
        // Whitespace-only custom input falls back to the default set.
        let charset = build_charset(&opts(8, false, false, false, true, "   "));
        assert_eq!(charset.len(), DEFAULT_SPECIAL.chars().count());
    }

    #[test]
    fn full_alphabet_size() {
        let charset = build_charset(&opts(8, true, true, true, true, ""));
        assert_eq!(charset.len(), 26 + 26 + 10 + DEFAULT_SPECIAL.chars().count());
    }

    #[test]
    fn no_charset_is_rejected() {
        assert!(generate_with(&opts(16, false, false, false, false, "xyz"), &mut rand::thread_rng()).is_none());
    }

    #[test]
    fn zero_length_yields_empty_password() {
        assert_eq!(gen(&opts(0, true, false, false, false, "")), "");
    }

    #[test]
    fn output_is_not_constant() {
        let a = gen(&opts(32, true, true, true, true, ""));
        let b = gen(&opts(32, true, true, true, true, ""));
        assert_ne!(a, b, "two 32-char passwords collided");
    }

    #[test]
    fn distribution_roughly_uniform() {
        // 10 digits × 20_000 draws: each bucket ≈ 2000; allow ±15 %.
        let p = gen(&opts(20_000, false, false, true, false, ""));
        let mut counts = [0usize; 10];
        for c in p.chars() {
            counts[c.to_digit(10).unwrap() as usize] += 1;
        }
        for (d, n) in counts.iter().enumerate() {
            assert!((1700..=2300).contains(n), "digit {d}: {n}");
        }
    }
}
