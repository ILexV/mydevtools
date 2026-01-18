import { getCryptographyWasm } from '/wasm/cryptography/cryptography-loader.js';

export async function getVersion() {
    const wasm = await getCryptographyWasm();
    return wasm.version();
}
