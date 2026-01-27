/* global document, window, navigator */

(function () {
    const initializedRoots = new WeakSet();

    let cryptoWasmPromise = null;

    async function getCryptoWasm() {
        if (!cryptoWasmPromise) {
            cryptoWasmPromise = import('/wasm/cryptography/cryptography.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return cryptoWasmPromise;
    }

    function getElements() {
        const root = document.getElementById('jwt-decoder-root');
        if (!root) return null;

        return {
            root,
            encoded: document.getElementById('jwt-encoded'),
            encodedError: document.getElementById('jwt-encoded-error'),
            encodedErrorText: document.getElementById('jwt-encoded-error-text'),
            header: document.getElementById('jwt-header'),
            payload: document.getElementById('jwt-payload'),
            secret: document.getElementById('jwt-secret'),
            signatureStatus: document.getElementById('jwt-signature-status'),
            algorithmDisplay: document.getElementById('jwt-algorithm-value')
        };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            signatureVerified: root.dataset.signatureVerified || 'Verified',
            signatureInvalid: root.dataset.signatureInvalid || 'Invalid Signature'
        };
    }

    function getAlgFromHeader(headerText) {
        try {
            const obj = JSON.parse(headerText);
            return obj.alg || 'HS256';
        } catch {
            return 'HS256';
        }
    }

    async function updateAll(els) {
        if (!els) return;
        const strings = getStrings(els.root);
        const encoded = els.encoded.value.trim();
        const secret = els.secret.value;

        if (!encoded) {
            if (els.encodedError) els.encodedError.classList.add('hidden');
            els.header.value = '';
            els.payload.value = '';
            els.signatureStatus.classList.add('hidden');
            els.algorithmDisplay.textContent = 'ALG';
            return;
        }

        try {
            const wasm = await getCryptoWasm();
            
            // 1. Decode
            let decodedJson = '';
            try {
                decodedJson = wasm.jwt_decode(encoded);
                if (els.encodedError) els.encodedError.classList.add('hidden');
            } catch (err) {
                if (els.encodedError) {
                    els.encodedError.classList.remove('hidden');
                    if (els.encodedErrorText) els.encodedErrorText.textContent = err;
                }
                // Clear outputs on error
                els.header.value = '';
                els.payload.value = '';
                els.signatureStatus.classList.add('hidden');
                return;
            }

            const decodedObj = JSON.parse(decodedJson);

            // Update decoded sections
            els.header.value = decodedObj.header;
            els.payload.value = decodedObj.payload;

            // Update Alg display
            const alg = getAlgFromHeader(decodedObj.header);
            if (els.algorithmDisplay) els.algorithmDisplay.textContent = alg;

            // 2. Verify signature
            let verified = false;
            try {
                verified = wasm.jwt_verify(encoded, secret, alg);
            } catch (e) {
                console.error("Verify error:", e);
                verified = false;
            }

            els.signatureStatus.classList.remove('hidden');
            
            // Reset classes
            els.signatureStatus.classList.remove('bg-success/10', 'text-success', 'border-success', 'bg-error/10', 'text-error', 'border-error');
            
            if (verified) {
                els.signatureStatus.classList.add('bg-success/10', 'text-success', 'border', 'border-success/20');
                els.signatureStatus.innerHTML = `
                    <div class="flex items-center justify-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-6 h-6">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                        <span>${strings.signatureVerified}</span>
                    </div>`;
            } else {
                els.signatureStatus.classList.add('bg-error/10', 'text-error', 'border', 'border-error/20');
                els.signatureStatus.innerHTML = `
                    <div class="flex items-center justify-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-6 h-6">
                            <path stroke-linecap="round" stroke-linejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                        <span>${strings.signatureInvalid}</span>
                    </div>`;
            }

        } catch (err) {
            console.error(err);
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_jwtdecoder_bound) return;
        window.__mydevtools_jwtdecoder_bound = true;

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            // Decode on input for encoded text or secret
            if (target.id === 'jwt-encoded' || target.id === 'jwt-secret') {
                const els = getElements();
                if (els) updateAll(els);
            }
        });
    }

    function init() {
        const els = getElements();
        if (!els || initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);

        if (els.encoded.value) {
            updateAll(els);
        }
    }

    bindDelegatedHandlersOnce();
    
    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
