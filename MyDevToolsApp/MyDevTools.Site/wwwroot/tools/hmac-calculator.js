/* global document, window, navigator */

(function () {
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
            errorDiv: document.getElementById('hmac-error'),
            errorText: document.getElementById('hmac-error-text')
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
            const keyVal = els.keyInput.value;
            const msgVal = els.messageInput.value;

            // Only calculate if both inputs are present
            if (!keyVal || !msgVal) {
                // Keep output empty but don't show error
                els.output.value = '';
                els.copyBtn.style.display = 'none';
                return;
            }

            const key = new TextEncoder().encode(keyVal);
            const message = new TextEncoder().encode(msgVal);
            const algorithm = els.algorithmSelect.value;

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
            els.errorDiv.classList.add('hidden');
            els.copyBtn.style.display = 'flex';

        } catch (err) {
            console.error("HMAC calculation failed:", err);
            els.output.value = '';
            els.copyBtn.style.display = 'none';
            if (els.errorText) els.errorText.textContent = err.message || 'Error occurred';
            els.errorDiv.style.display = 'flex';
            els.errorDiv.classList.remove('hidden');
        }
    }

    async function copyToClipboard(btn) {
        const els = getElements();
        if (!els || !els.output.value) return;
        const text = els.output.value;

        try {
            await navigator.clipboard.writeText(text);

            // Visual feedback
            const originalInner = btn.innerHTML;
            
            btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 text-success">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
            `;
            
            setTimeout(() => {
                btn.innerHTML = originalInner;
            }, 2000);

        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }

    function clearAll(els) {
        if (!els) return;
        els.keyInput.value = '';
        els.messageInput.value = '';
        els.output.value = '';
        els.copyBtn.style.display = 'none';
        els.errorDiv.style.display = 'none';
        els.errorDiv.classList.add('hidden');
    }

    function handleEvent(ev) {
        const target = ev.target;
        if (!target) return;

        // Calculate on Input/Change
        if (ev.type === 'input' || ev.type === 'change') {
            const els = getElements();
            // Debounce lightly if needed, but WASM is fast enough for direct input usually
            // Just check if the target is one of our inputs
            if (target.id === 'hmac-key-input' || 
                target.id === 'hmac-message-input' || 
                target.id === 'hmac-algorithm-select') {
                calculateHmac(els);
            }
            return;
        }

        // Click Handlers
        if (ev.type === 'click') {
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
                copyToClipboard(copyBtn);
                return;
            }
        }
    }

    function init() {
        // Remove old listeners to prevent duplication
        document.removeEventListener('input', handleEvent);
        document.removeEventListener('change', handleEvent);
        document.removeEventListener('click', handleEvent);

        // Add listeners
        document.addEventListener('input', handleEvent);
        document.addEventListener('change', handleEvent);
        document.addEventListener('click', handleEvent);
    }

    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
