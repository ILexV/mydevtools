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
        const root = document.getElementById('jwt-debugger-root');
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
                // Determine if it's just invalid format or decode error
                els.encodedError.textContent = err;
                els.encodedError.hidden = false;
                // If decode fails, we might still try to show what we can? 
                // Currently rust implementation errors out if header/payload are invalid base64.
                return;
            }

            const decodedObj = JSON.parse(decodedJson);

            // Only update if not currently focused to avoid fighting user typing?
            // Actually this is usually one-way: Encoded -> Decoded.
            // If user types in Decoded, we should update Encoded (Signing).
            // For now, let's implement Encoded clean update.
            // Check if active element is one of the decoded areas.
            if (document.activeElement !== els.header) {
                els.header.value = decodedObj.header;
            }
            if (document.activeElement !== els.payload) {
                els.payload.value = decodedObj.payload;
            }

            // Update Alg display
            const alg = getAlgFromHeader(decodedObj.header);
            if (els.algorithmDisplay) els.algorithmDisplay.textContent = alg;

            // 2. Verify (if secret provided or if alg is none?)
            // If secret is empty, we can't verify HMAC/RSA usually.
            // But if user wants to see "Invalid Signature" we should show it.
            // jwt.io shows "Signature Verified" or "Invalid Signature" always.

            let verified = false;
            try {
                // If alg is none, validation is skipped or returns true? 
                // Our Rust implementation handles HS/RS. 
                // If secret is empty for HS256, it might verify against empty secret.
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

    // Creating a token (Signing)
    async function signToken(els) {
        if (!els) return;
        const headerText = els.header.value;
        const payloadText = els.payload.value;
        const secret = els.secret.value;

        try {
            const alg = getAlgFromHeader(headerText);
            const wasm = await getCryptoWasm();
            ensureFunctions(wasm, ['jwt_sign']);

            const newToken = wasm.jwt_sign(headerText, payloadText, secret, alg);

            // Update encoded only if we are the one changing it, 
            // i.e. this function called from Header/Payload/Secret inputs.
            els.encoded.value = newToken;

            // Also re-verify to show blue status
            updateAll(els);
        } catch (err) {
            // If JSON is invalid, signature fails to generate.
            // We can show error in encoded box or console.
            console.warn("Signing failed:", err);
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_jwtdebugger_bound) return;
        window.__mydevtools_jwtdebugger_bound = true;

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            // If Encoded changed -> Decode & Verify
            if (target === els.encoded) {
                updateAll(els);
            }
            // If Header/Payload/Secret changed -> Sign (generate new token)
            else if (target === els.header || target === els.payload || target === els.secret) {
                // If secret changed, we verify existing token first?
                // jwt.io behavior: 
                // - changing secret -> re-verify current token AND re-sign (if we are in "editing" mode?).
                // Actually if I paste a token and change secret, I want to see if IT validates.
                // But if I change Payload, I want a NEW token signed with that secret.

                // Heuristic:
                // If target is Secret, we just trigger Verify of the *current* Encoded token?
                // NO, if I type a secret, I expect the tool to check if the current token matches it.
                // BUT if I am building a token, I want the computed signature to update.
                // jwt.io does both: it updates the "Signature" part of the encoded token.

                // So: Any change to Header/Payload/Secret => Re-calculate Encoded Token.
                // Wait, if I paste a token, and then type the secret, checking "Verify" means checking if the pasted token matches.
                // If I re-calculate (Sign), I replace the pasted token's signature with a new valid one.
                // Then it will always be "Verified". 
                // That defeats the purpose of "Verify this token I found".

                // Let's look at jwt.io behavior:
                // 1. Paste Token -> Decoded updates. Signature says "Invalid" (if secret empty).
                // 2. Type secret -> Signature says "Verified" (if matches). The Encoded token DOES NOT change.
                // 3. Edit Payload -> Encoded token Updates (New signature generated). Status "Verified".

                if (target === els.secret) {
                    // Just verify current token
                    updateAll(els);
                    // Wait, if I change secret, and I previously edited payload, I should re-sign?
                    // Complex state. For simpler "Debugger", likely "Verify" is priority.
                    // But if I want to "Sign", I usually edit payload.

                    // Let's stick to: editing Secret verifies current token.
                    // Editing Header/Payload updates Encoded token (re-sign).
                } else {
                    signToken(els);
                }
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
