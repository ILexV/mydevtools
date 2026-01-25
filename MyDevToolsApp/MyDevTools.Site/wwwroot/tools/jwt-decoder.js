/* global document, window, navigator */

(function () {
    const initializedRoots = new WeakSet();

    let cryptoWasmPromise = null;

    async function getCryptoWasm() {
        if (!cryptoWasmPromise) {
            // Lazy load the WASM module
            cryptoWasmPromise = import('/wasm/cryptography/cryptography-loader.js').then((m) => m.getCryptographyWasm());
        }
        return cryptoWasmPromise;
    }

    function ensureFunctions(wasm, names) {
        for (const name of names) {
            if (typeof wasm[name] !== 'function') {
                throw new Error('WASM function missing: ' + name);
            }
        }
    }

    function getElements() {
        const root = document.getElementById('jwt-decoder-root');
        if (!root) return null;

        return {
            root,
            encoded: document.getElementById('jwt-encoded'),
            encodedError: document.getElementById('jwt-encoded-error'),
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

    // Helper to extract alg from header JSON safely
    function getAlgFromHeader(headerText) {
        try {
            const obj = JSON.parse(headerText);
            return obj.alg || 'HS256';
        } catch {
            return 'HS256'; // Default
        }
    }

    // Update the UI with decode/verify results
    async function updateAll(els) {
        if (!els) return;
        const strings = getStrings(els.root);
        const encoded = els.encoded.value.trim();
        const secret = els.secret.value; // May be empty

        if (!encoded) {
            els.encodedError.hidden = true;
            els.header.value = '';
            els.payload.value = '';
            els.signatureStatus.hidden = true;
            return;
        }

        try {
            const wasm = await getCryptoWasm();
            ensureFunctions(wasm, ['jwt_decode', 'jwt_verify']);

            // 1. Decode
            let decodedJson = '';
            try {
                decodedJson = wasm.jwt_decode(encoded);
                els.encodedError.hidden = true;
            } catch (err) {
                els.encodedError.textContent = err;
                els.encodedError.hidden = false;
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

            els.signatureStatus.hidden = false;
            els.signatureStatus.className = 'jwt-signature-status ' + (verified ? 'verified' : 'invalid');
            els.signatureStatus.innerHTML = verified
                ? `<span class="icon">✓</span> ${strings.signatureVerified}`
                : `<span class="icon">✕</span> ${strings.signatureInvalid}`;

        } catch (err) {
            console.error(err);
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_jwtdecoder_bound) return;
        window.__mydevtools_jwtdecoder_bound = true;

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            // If Encoded or Secret changed -> Decode & Verify
            if (target === els.encoded || target === els.secret) {
                updateAll(els);
            }
        });
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);

        // Initial update if there is content (e.g. preserved state)
        if (els.encoded.value) {
            updateAll(els);
        }
    }

    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch { }

})();
