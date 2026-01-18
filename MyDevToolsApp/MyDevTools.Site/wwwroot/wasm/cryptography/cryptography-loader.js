let cryptographyWasmPromise = null;

export async function getCryptographyWasm() {
    if (!cryptographyWasmPromise) {
        cryptographyWasmPromise = import('/wasm/cryptography/cryptography.js').then(async (m) => {
            await m.default();
            return m;
        });
    }
    return cryptographyWasmPromise;
}
