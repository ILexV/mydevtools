mod ipv4;
mod ipv6;
mod split;

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

/// Split an IPv4 network (same input forms as `calc_ipv4`) into `/new_prefix`
/// subnets. Lists at most `split::MAX_SPLIT_ROWS`; `count` is a decimal string.
#[wasm_bindgen]
pub fn split_ipv4(input: &str, new_prefix: u8) -> Result<JsValue, JsValue> {
    let cidr = Ipv4Cidr::parse(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let result = split::split_ipv4(&cidr, new_prefix).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

/// Split an IPv6 prefix into `/new_prefix` subnets (count up to 2^128 as a
/// decimal string; at most `split::MAX_SPLIT_ROWS` listed).
#[wasm_bindgen]
pub fn split_ipv6(input: &str, new_prefix: u8) -> Result<JsValue, JsValue> {
    let cidr = Ipv6Cidr::parse(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let result = split::split_ipv6(&cidr, new_prefix).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}
