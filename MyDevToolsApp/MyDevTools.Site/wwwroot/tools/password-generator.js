/* global document, window, navigator, localStorage */

(function () {
    let cryptoWasmModulePromise = null;
    const initializedRoots = new WeakSet();
    const SETTINGS_KEY = 'mydevtools.tools.password-generator.settings.v1';

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
            historyEmpty: document.getElementById('pg-history-empty'),
            clearHistoryBtn: document.getElementById('pg-clear-history-btn')
        };
    }

    function getStrings(root) {
        return {
            copied: root.dataset.copied || 'Copied!'
        };
    }

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
        saveSettings();
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

        els.historyEmpty.classList.add('hidden');

        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="font-mono text-base break-all align-middle py-2 history-pass">${escapeHtml(password)}</td>
            <td class="text-right align-top py-2 w-12">
                <button class="btn btn-ghost btn-xs btn-copy-history" title="Copy">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
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

    async function copyToClipboard(button, text, copiedText) {
        try {
            await navigator.clipboard.writeText(text);
            
            const originalContent = button.innerHTML;
            const originalClass = button.className; // Save full class list
            
            // Temporary Success State
            button.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 text-success">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
            `;
            if (copiedText) {
                button.innerHTML += `<span class="ml-2 text-success">${copiedText}</span>`;
            }
            
            // We don't remove existing classes, just add success visual if needed, 
            // but innerHTML replacement usually handles the visual cue.
            
            setTimeout(() => {
                button.innerHTML = originalContent;
                button.className = originalClass;
            }, 1000);
        } catch (err) {
            console.error('Failed to copy', err);
        }
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
                    await copyToClipboard(copyBtn, els.resultInput.value, getStrings(els.root).copied);
                }
                return;
            }
            
            const historyCopyBtn = target.closest('.btn-copy-history');
            if (historyCopyBtn) {
                ev.preventDefault();
                const tr = historyCopyBtn.closest('tr');
                if (tr) {
                    const passEl = tr.querySelector('.history-pass');
                    if (passEl) {
                        await copyToClipboard(historyCopyBtn, passEl.textContent, null); // No text for small button
                    }
                }
                return;
            }

            const clearHistoryBtn = target.closest('#pg-clear-history-btn');
            if (clearHistoryBtn) {
                ev.preventDefault();
                const els = getElements();
                if (els) {
                    els.historyList.innerHTML = '';
                    els.historyEmpty.classList.remove('hidden');
                }
                return;
            }
        });
    }

    function init() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;

        initializedRoots.add(els.root);
        loadSettings();
        
        // Generate initial password if empty
        if (!els.resultInput.value) {
            generatePassword();
        }
    }

    bindDelegatedHandlersOnce();
    
    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
