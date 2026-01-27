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
        const root = document.getElementById('jwt-encoder-root');
        if (!root) return null;

        return {
            root,
            headerInput: document.getElementById('jwt-header-input'),
            payloadInput: document.getElementById('jwt-payload-input'),
            secretInput: document.getElementById('jwt-secret-input'),
            algorithmSelect: document.getElementById('jwt-algorithm-select'),
            encodedOutput: document.getElementById('jwt-encoded-output'),
            copyBtn: document.getElementById('copy-jwt-btn'),
            headerError: document.getElementById('jwt-header-error'),
            payloadError: document.getElementById('jwt-payload-error'),
            encodeError: document.getElementById('jwt-encode-error'),
            encodeErrorText: document.getElementById('jwt-encode-error-text')
        };
    }

    function getStrings(root) {
        return {
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!'
        };
    }

    function validateAndFormatJSON(text, errorElement) {
        try {
            const obj = JSON.parse(text);
            const formatted = JSON.stringify(obj, null, 2);
            errorElement.classList.add('hidden');
            errorElement.style.display = 'none';
            return formatted;
        } catch (err) {
            errorElement.textContent = 'Invalid JSON: ' + err.message;
            errorElement.classList.remove('hidden');
            errorElement.style.display = 'flex';
            throw err;
        }
    }

    async function generateToken(els) {
        if (!els) return;

        try {
            // Only validate JSON, don't reformat inputs to avoid cursor jumps
            const headerText = els.headerInput.value;
            const payloadText = els.payloadInput.value;
            
            // Validate (throws if invalid)
            JSON.parse(headerText);
            els.headerError.classList.add('hidden');
            
            JSON.parse(payloadText);
            els.payloadError.classList.add('hidden');
            
            const secret = els.secretInput.value;
            const alg = els.algorithmSelect.value;

            // Ensure header has correct alg (we parse and re-stringify only for the signing operation)
            const headerObj = JSON.parse(headerText);
            headerObj.alg = alg;
            const updatedHeader = JSON.stringify(headerObj);

            const wasm = await getCryptoWasm();
            // ensureFunctions(wasm, ['jwt_sign']); // Assumed present

            const token = wasm.jwt_sign(updatedHeader, payloadText, secret, alg);
            
            els.encodedOutput.value = token;
            if (els.encodeError) els.encodeError.classList.add('hidden');
            els.copyBtn.disabled = false;

        } catch (err) {
            console.error("Encoding failed:", err);
            els.encodedOutput.value = '';
            els.copyBtn.disabled = true;
            
            // If it's not a JSON parsing error we just handled (by checking input validity), show generic error
            // Check if parsing failed
            try { JSON.parse(els.headerInput.value); } catch { 
                els.headerError.textContent = 'Invalid JSON';
                els.headerError.classList.remove('hidden');
                return; 
            }
            try { JSON.parse(els.payloadInput.value); } catch { 
                els.payloadError.textContent = 'Invalid JSON';
                els.payloadError.classList.remove('hidden');
                return; 
            }

            if (els.encodeError) {
                if (els.encodeErrorText) els.encodeErrorText.textContent = 'Failed to generate JWT: ' + (err.message || err);
                els.encodeError.classList.remove('hidden');
                els.encodeError.style.display = 'flex';
            }
        }
    }

    async function copyToClipboard(btn, strings) {
        const els = getElements();
        if (!els || !els.encodedOutput.value) return;
        const text = els.encodedOutput.value;

        try {
            await navigator.clipboard.writeText(text);
            
            const originalInner = btn.innerHTML;
            const originalClass = btn.className;
            
            btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 mr-1 text-success">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                ${strings.copied}
            `;
            btn.classList.add('text-success');
            
            setTimeout(() => {
                btn.innerHTML = originalInner;
                btn.className = originalClass;
            }, 1500);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_jwtencoder_bound) return;
        window.__mydevtools_jwtencoder_bound = true;

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            if (target === els.headerInput || 
                target === els.payloadInput || 
                target === els.secretInput) {
                generateToken(els);
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            if (target === els.algorithmSelect) {
                generateToken(els);
            }
        });

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            const copyBtn = target.closest('#copy-jwt-btn');
            if (copyBtn) {
                ev.preventDefault();
                const els = getElements();
                if (!els) return;
                const strings = getStrings(els.root);
                copyToClipboard(copyBtn, strings);
            }
        });
    }

    function init() {
        const els = getElements();
        if (!els || initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);

        generateToken(els);
    }

    bindDelegatedHandlersOnce();
    
    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
