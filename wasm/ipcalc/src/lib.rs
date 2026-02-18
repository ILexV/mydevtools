mod ipv4;

use crate::ipv4::Ipv4Cidr;
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
