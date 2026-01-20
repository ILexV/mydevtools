/* global document, window */

(function () {
    let cryptoWasmModulePromise = null;

    async function getCryptoWasm() {
        if (!cryptoWasmModulePromise) {
            cryptoWasmModulePromise = import('/wasm/password/password.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return cryptoWasmModulePromise;
    }

    function getElements() {
        const root = document.getElementById('password-generator-root');
        if (!root) return null;

        return {
            root,
            lengthInput: document.getElementById('pg-length'),
            lengthVal: document.getElementById('pg-length-val'),
            chkUpper: document.getElementById('pg-uppercase'),
            chkLower: document.getElementById('pg-lowercase'),
            chkNumbers: document.getElementById('pg-numbers'),
            chkSpecial: document.getElementById('pg-special'),
            specialCharsInput: document.getElementById('pg-special-chars'),
            generateBtn: document.getElementById('pg-generate-btn'),
            resultInput: document.getElementById('pg-result'),
            copyBtn: document.getElementById('pg-copy-btn'),
            historyList: document.getElementById('pg-history-list'),
            clearHistoryBtn: document.getElementById('pg-clear-history-btn')
        };
    }

    function getStrings(root) {
        return {
            copied: root.dataset.copied || 'Copied!',
            error: root.dataset.error || 'Error'
        };
    }

    async function generatePassword() {
        const els = getElements();
        if (!els) return;

        const length = parseInt(els.lengthInput.value, 10);
        const uppercase = els.chkUpper.checked;
        const lowercase = els.chkLower.checked;
        const numbers = els.chkNumbers.checked;
        const special = els.chkSpecial.checked;
        const specialChars = els.specialCharsInput.value;

        try {
            const wasm = await getCryptoWasm();
            const options = new wasm.PasswordOptions(length, uppercase, lowercase, numbers, special, specialChars);
            const password = wasm.generate_password(options);
            
            els.resultInput.value = password;
            addToHistory(password);
        } catch (err) {
            console.error(err);
            els.resultInput.value = "Error generating password";
        }
    }

    function addToHistory(password) {
        const els = getElements();
        if (!els) return;

        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <span class="history-pass">${escapeHtml(password)}</span>
            <button class="btn-icon btn-copy-history" title="Copy">📋</button>
        `;
        
        // Add to top
        els.historyList.insertBefore(item, els.historyList.firstChild);

        // Limit to 10
        while (els.historyList.children.length > 10) {
            els.historyList.removeChild(els.historyList.lastChild);
        }
    }

    function escapeHtml(text) {
        return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function bindDelegatedHandlersOnce() {
        if (window.__passwordGeneratorDelegatedHandlersBound === true) return;
        window.__passwordGeneratorDelegatedHandlersBound = true;

        document.addEventListener('input', (ev) => {
            if (ev.target.id === 'pg-length') {
                const val = document.getElementById('pg-length-val');
                if (val) val.textContent = ev.target.value;
            }
        });

        document.addEventListener('click', async (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;

            const genBtn = target.closest('#pg-generate-btn');
            if (genBtn) {
                ev.preventDefault();
                await generatePassword();
                return;
            }

            const copyBtn = target.closest('#pg-copy-btn');
            if (copyBtn) {
                ev.preventDefault();
                const els = getElements();
                if (els && els.resultInput.value) {
                    await copyToClipboard(copyBtn, els.resultInput.value);
                }
                return;
            }
            
            const historyCopyBtn = target.closest('.btn-copy-history');
            if (historyCopyBtn) {
                ev.preventDefault();
                const pass = historyCopyBtn.parentElement.querySelector('.history-pass').textContent;
                await copyToClipboard(historyCopyBtn, pass);
                return;
            }

            const clearHistoryBtn = target.closest('#pg-clear-history-btn');
            if (clearHistoryBtn) {
                ev.preventDefault();
                const els = getElements();
                if (els) els.historyList.innerHTML = '';
                return;
            }
        });
    }

    async function copyToClipboard(button, text) {
        try {
            await navigator.clipboard.writeText(text);
            const original = button.textContent;
            // If button has icon, we might need to handle it differently, but here we assume text or unicode icon
            button.classList.add('copied-state');
            // button.textContent = 'Copied!'; // Optional: change text if needed
            
            setTimeout(() => {
                button.classList.remove('copied-state');
                // button.textContent = original;
            }, 1000);
        } catch (err) {
            console.error('Failed to copy', err);
        }
    }

    const initializedRoots = new WeakSet();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;

        initializedRoots.add(els.root);
        // generatePassword(); // Optional: generate on first load
    }

    bindDelegatedHandlersOnce();
    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }

})();
