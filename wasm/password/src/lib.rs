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

#[wasm_bindgen]
pub fn generate_password(options: &PasswordOptions) -> Result<String, JsValue> {
    let mut charset = String::new();
    
    if options.uppercase {
        charset.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    }
    if options.lowercase {
        charset.push_str("abcdefghijklmnopqrstuvwxyz");
    }
    if options.numbers {
        charset.push_str("0123456789");
    }
    if options.special {
        if options.special_chars.is_empty() {
             charset.push_str("!@#$%^&*()_+-=[]{}|;:,.<>?");
        } else {
            charset.push_str(&options.special_chars);
        }
    }

    if charset.is_empty() {
        return Err(JsValue::from_str("No character set selected"));
    }

    let charset_chars: Vec<char> = charset.chars().collect();
    let mut password = String::with_capacity(options.length);
    let mut rng = rand::thread_rng();

    for _ in 0..options.length {
        let idx = rng.gen_range(0..charset_chars.len());
        password.push(charset_chars[idx]);
    }

    Ok(password)
}
