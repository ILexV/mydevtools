mod ipv4;
mod ipv6;

use crate::ipv4::Ipv4Cidr;
use crate::ipv6::Ipv6Cidr;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn calc_ipv4(input: &str) -> Result<JsValue, JsValue> {
    match Ipv4Cidr::parse(input) {
        Ok(cidr) => {
            let mut result = cidr.calculate();
            result.input = input.to_string();
            Ok(serde_wasm_bindgen::to_value(&result)?)
        }
        Err(e) => Err(JsValue::from_str(&e.to_string())),
    }
}

/// IPv6 CIDR (`2001:db8::1/64`) or bare address (/128). The address count is
/// returned as a decimal string because /0 = 2^128 exceeds u128 and JS numbers.
#[wasm_bindgen]
pub fn calc_ipv6(input: &str) -> Result<JsValue, JsValue> {
    match Ipv6Cidr::parse(input) {
        Ok(cidr) => {
            let mut result = cidr.calculate();
            result.input = input.to_string();
            Ok(serde_wasm_bindgen::to_value(&result)?)
        }
        Err(e) => Err(JsValue::from_str(&e.to_string())),
    }
}
