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
        const root = document.getElementById('hmac-calculator-root');
        if (!root) return null;

        return {
            root,
            keyInput: document.getElementById('hmac-key-input'),
            messageInput: document.getElementById('hmac-message-input'),
            algorithmSelect: document.getElementById('hmac-algorithm-select'),
            output: document.getElementById('hmac-output'),
            copyBtn: document.getElementById('copy-hmac-btn'),
            errorDiv: document.getElementById('hmac-error')
        };
    }

    function getStrings(root) {
        return {
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!'
        };
    }

    function arrayToHex(array) {
        return Array.from(array)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    async function calculateHmac(els) {
        if (!els) return;

        try {
            const key = new TextEncoder().encode(els.keyInput.value);
            const message = new TextEncoder().encode(els.messageInput.value);
            const algorithm = els.algorithmSelect.value;

            if (key.length === 0 || message.length === 0) {
                els.output.value = '';
                els.copyBtn.style.display = 'none';
                return;
            }

            const wasm = await getCryptoWasm();

            let result;
            if (algorithm === 'sha256') {
                result = wasm.hmac_sha256(key, message);
            } else if (algorithm === 'sha512') {
                result = wasm.hmac_sha512(key, message);
            } else {
                throw new Error('Unsupported algorithm');
            }

            const hex = arrayToHex(result);
            els.output.value = hex;
            els.errorDiv.style.display = 'none';
            els.copyBtn.style.display = '';

        } catch (err) {
            console.error("HMAC calculation failed:", err);
            els.output.value = '';
            els.copyBtn.style.display = 'none';
            els.errorDiv.textContent = 'Error: ' + err.message;
            els.errorDiv.style.display = '';
        }
    }

    async function copyToClipboard(text, btn, strings) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
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

            setTimeout(() => {
                btn.textContent = originalText;
            }, 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
            const originalText = btn.textContent;
            btn.textContent = 'Failed!';
            setTimeout(() => {
                btn.textContent = originalText;
            }, 2000);
        }
    }

    function clearAll(els) {
        if (!els) return;
        els.keyInput.value = '';
        els.messageInput.value = '';
        els.output.value = '';
        els.copyBtn.style.display = 'none';
        els.errorDiv.style.display = 'none';
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_hmaccalculator_bound) return;
        window.__mydevtools_hmaccalculator_bound = true;

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            if (target === els.keyInput || target === els.messageInput) {
                calculateHmac(els);
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            if (target === els.algorithmSelect) {
                calculateHmac(els);
            }
        });

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            const calculateBtn = target.closest('#calculate-hmac-btn');
            if (calculateBtn) {
                ev.preventDefault();
                const els = getElements();
                calculateHmac(els);
                return;
            }

            const clearBtn = target.closest('#clear-hmac-btn');
            if (clearBtn) {
                ev.preventDefault();
                const els = getElements();
                clearAll(els);
                return;
            }

            const copyBtn = target.closest('#copy-hmac-btn');
            if (copyBtn) {
                ev.preventDefault();
                const els = getElements();
                if (!els || !els.output.value) return;
                const strings = getStrings(els.root);
                copyToClipboard(els.output.value, els.copyBtn, strings);
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
        // No initial calculation needed
    }

    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch { }

})();