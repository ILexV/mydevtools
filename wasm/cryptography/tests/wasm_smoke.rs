#![cfg(feature = "wasm-test")]

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test;

#[cfg(target_arch = "wasm32")]
wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen_test]
fn wasm_version_smoke() {
    let version = mydevtools_cryptography::version();
    assert!(version.contains("mydevtools_cryptography@"));
}
