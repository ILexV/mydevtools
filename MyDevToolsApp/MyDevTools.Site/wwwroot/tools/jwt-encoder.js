/* global document, window, navigator */

(function () {
    const initializedRoots = new WeakSet();

    let cryptoWasmPromise = null;

    async function getCryptoWasm() {
        if (!cryptoWasmPromise) {
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
            encodeError: document.getElementById('jwt-encode-error')
        };
    }

    function getStrings(root) {
        return {
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!'
        };
    }

    // Validate and format JSON
    function validateAndFormatJSON(text, errorElement) {
        try {
            const obj = JSON.parse(text);
            const formatted = JSON.stringify(obj, null, 2);
            errorElement.hidden = true;
            return formatted;
        } catch (err) {
            errorElement.textContent = 'Invalid JSON: ' + err.message;
            errorElement.hidden = false;
            throw err;
        }
    }

    // Generate JWT token
    async function generateToken(els) {
        if (!els) return;

        try {
            // Validate inputs
            const headerText = validateAndFormatJSON(els.headerInput.value, els.headerError);
            const payloadText = validateAndFormatJSON(els.payloadInput.value, els.payloadError);
            
            const secret = els.secretInput.value;
            const alg = els.algorithmSelect.value;

            // Update header with selected algorithm
            const headerObj = JSON.parse(headerText);
            headerObj.alg = alg;
            const updatedHeader = JSON.stringify(headerObj, null, 2);
            els.headerInput.value = updatedHeader;

            const wasm = await getCryptoWasm();
            ensureFunctions(wasm, ['jwt_sign']);

            const token = wasm.jwt_sign(updatedHeader, payloadText, secret, alg);
            
            els.encodedOutput.value = token;
            els.encodeError.hidden = true;
            els.copyBtn.disabled = false;

        } catch (err) {
            console.error("Encoding failed:", err);
            els.encodedOutput.value = '';
            els.copyBtn.disabled = true;
            if (!els.headerError.hidden || !els.payloadError.hidden) {
                // JSON errors already shown
                return;
            }
            els.encodeError.textContent = 'Failed to generate JWT: ' + err;
            els.encodeError.hidden = false;
        }
    }

    // Copy to clipboard
    async function copyToClipboard(text, btn, strings) {
        try {
            // Modern clipboard API (requires HTTPS or localhost)
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // Fallback for HTTP or older browsers
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.left = '-999999px';
                textarea.style.top = '-999999px';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                
                try {
                    document.execCommand('copy');
                } finally {
                    document.body.removeChild(textarea);
                }
            }
            
            const originalText = btn.textContent;
            btn.textContent = strings.copied;
            btn.classList.add('btn-success');
            btn.classList.remove('btn-primary');
            
            setTimeout(() => {
                btn.textContent = originalText;
                btn.classList.remove('btn-success');
                btn.classList.add('btn-primary');
            }, 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
            // Show error briefly
            const originalText = btn.textContent;
            btn.textContent = 'Failed!';
            setTimeout(() => {
                btn.textContent = originalText;
            }, 2000);
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_jwtencoder_bound) return;
        window.__mydevtools_jwtencoder_bound = true;

        // Handle input changes
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

        // Handle algorithm selection
        document.addEventListener('change', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            if (target === els.algorithmSelect) {
                generateToken(els);
            }
        });

        // Handle copy button
        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            // Use closest to handle clicks on button text/children
            const copyBtn = target.closest('#copy-jwt-btn');
            if (copyBtn) {
                ev.preventDefault();
                const els = getElements();
                if (!els) return;
                const strings = getStrings(els.root);
                copyToClipboard(els.encodedOutput.value, els.copyBtn, strings);
                return;
            }
        });
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);

        // Generate initial token
        generateToken(els);
    }

    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch { }

})();
