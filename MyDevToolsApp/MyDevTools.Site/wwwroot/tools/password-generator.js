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

    const SETTINGS_KEY = 'mydevtools.tools.password-generator.settings.v1';

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return;
            const settings = JSON.parse(raw);
            const els = getElements();
            if (!els) return;

            if (typeof settings.length === 'number') {
                els.lengthInput.value = settings.length;
                if (els.lengthVal) els.lengthVal.textContent = settings.length;
            }
            if (typeof settings.uppercase === 'boolean') els.chkUpper.checked = settings.uppercase;
            if (typeof settings.lowercase === 'boolean') els.chkLower.checked = settings.lowercase;
            if (typeof settings.numbers === 'boolean') els.chkNumbers.checked = settings.numbers;
            if (typeof settings.special === 'boolean') els.chkSpecial.checked = settings.special;
            if (typeof settings.specialChars === 'string') els.specialCharsInput.value = settings.specialChars;

        } catch {
            // ignore
        }
    }

    function saveSettings() {
        const els = getElements();
        if (!els) return;

        const settings = {
            length: parseInt(els.lengthInput.value, 10),
            uppercase: els.chkUpper.checked,
            lowercase: els.chkLower.checked,
            numbers: els.chkNumbers.checked,
            special: els.chkSpecial.checked,
            specialChars: els.specialCharsInput.value
        };

        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {
            // ignore
        }
    }

    async function generatePassword() {
        saveSettings(); // Save whenever we generate (state is stable)
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

        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="font-mono text-base break-all align-middle py-2 history-pass">${escapeHtml(password)}</td>
            <td class="text-right align-top py-2">
                <button class="btn btn-ghost btn-xs btn-copy-history" title="Copy">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m2 4h6a2 2 0 012 2v6a2 2 0 01-2 2h-6a2 2 0 01-2-2v-6a2 2 0 012-2z" />
                    </svg>
                </button>
            </td>
        `;
        
        // Add to top
        els.historyList.insertBefore(row, els.historyList.firstChild);

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
            const target = ev.target;
            if (target.id === 'pg-length') {
                const val = document.getElementById('pg-length-val');
                if (val) val.textContent = target.value;
                saveSettings();
            } else if (target.id === 'pg-special-chars') {
                saveSettings();
            }
        });
        
        document.addEventListener('change', (ev) => {
             const target = ev.target;
             if (['pg-uppercase', 'pg-lowercase', 'pg-numbers', 'pg-special'].includes(target.id)) {
                 saveSettings();
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
                // Find closest tr, then find .history-pass
                const tr = historyCopyBtn.closest('tr');
                if (tr) {
                    const passEl = tr.querySelector('.history-pass');
                    if (passEl) {
                        await copyToClipboard(historyCopyBtn, passEl.textContent);
                    }
                }
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
        loadSettings();
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
