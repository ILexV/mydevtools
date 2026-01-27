/* global document, window */

(function () {
    const initializedRoots = new WeakSet();
    const rootState = new WeakMap();

    function getState(root) {
        let state = rootState.get(root);
        if (!state) {
            state = { lastPublicName: null, lastPrivateName: null };
            rootState.set(root, state);
        }
        return state;
    }

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

    function ensureFunctions(wasm, names) {
        for (const name of names) {
            if (typeof wasm[name] !== 'function') {
                throw new Error('WASM module not built. Please rebuild cryptography.wasm.');
            }
        }
    }

    function getElements() {
        const root = document.getElementById('openssh-keys-root');
        if (!root) return null;

        return {
            root,
            algorithm: document.getElementById('openssh-algorithm'),
            keySize: document.getElementById('openssh-key-size'),
            passphrase: document.getElementById('openssh-passphrase'),
            generateBtn: document.getElementById('openssh-generate-btn'),
            importText: document.getElementById('openssh-import-text'),
            importFile: document.getElementById('openssh-import-file'),
            importFileName: document.getElementById('openssh-import-file-name'),
            importBtn: document.getElementById('openssh-import-btn'),
            convertBtn: document.getElementById('openssh-convert-btn'),
            publicKey: document.getElementById('openssh-public-key'),
            privateKey: document.getElementById('openssh-private-key'),
            publicCopy: document.getElementById('openssh-public-copy'),
            privateCopy: document.getElementById('openssh-private-copy'),
            publicDownload: document.getElementById('openssh-public-download'),
            privateDownload: document.getElementById('openssh-private-download'),
            warnings: document.getElementById('openssh-warnings'),
            warningsText: document.getElementById('openssh-warnings-text')
        };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!',
            download: root.dataset.download || 'Download',
            warningsTitle: root.dataset.warningsTitle || 'Warnings'
        };
    }

    function setWarnings(els, warnings, strings) {
        if (!warnings || warnings.length === 0) {
            els.warnings.classList.add('hidden');
            els.warnings.style.display = 'none';
            if (els.warningsText) els.warningsText.textContent = '';
            return;
        }

        els.warnings.classList.remove('hidden');
        els.warnings.style.display = 'flex';
        if (els.warningsText) els.warningsText.innerHTML = `<strong>${strings.warningsTitle}:</strong> ${warnings.map(escapeHtml).join('; ')}`;
    }

    function setError(els, message) {
        els.warnings.classList.remove('hidden');
        els.warnings.style.display = 'flex';
        if (els.warningsText) els.warningsText.innerHTML = `<strong>Error:</strong> ${escapeHtml(message)}`;
    }

    function escapeHtml(text) {
        return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function downloadText(filename, text) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function copyText(textarea, button, strings) {
        const original = button.textContent;
        navigator.clipboard.writeText(textarea.value || '').then(() => {
            button.textContent = strings.copied;
            button.classList.add('text-success');
            setTimeout(() => {
                button.textContent = original;
                button.classList.remove('text-success');
            }, 1200);
        });
    }

    function getPassphrase(els) {
        const pass = (els.passphrase.value || '').trim();
        return pass.length > 0 ? pass : undefined;
    }

    function guessInput(text) {
        const trimmed = text.trim();
        if (!trimmed) return 'empty';
        if (trimmed.startsWith('ssh-')) return 'openssh-public';
        if (trimmed.includes('BEGIN OPENSSH PRIVATE KEY')) return 'openssh-private';
        if (trimmed.includes('BEGIN PUBLIC KEY')) return 'spki-public';
        if (trimmed.includes('BEGIN PRIVATE KEY') || trimmed.includes('BEGIN ENCRYPTED PRIVATE KEY')) return 'pkcs8-private';
        return 'unknown';
    }

    async function generateAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        setWarnings(els, [], strings);

        try {
            const wasm = await getCryptoWasm();
            const passphrase = getPassphrase(els);
            const algorithm = els.algorithm.value;
            const comment = null;

            let privateKeyPem = '';
            if (algorithm === 'ed25519') {
                const keypair = wasm.ed25519_generate_keypair();
                const privateKey = keypair.slice(0, 32);
                privateKeyPem = wasm.openssh_ed25519_private_key(privateKey, comment, passphrase, undefined);
            } else if (algorithm === 'ecdsa-p256') {
                const keypair = wasm.ecdsa_p256_generate_keypair();
                const privateKey = keypair.slice(0, 32);
                privateKeyPem = wasm.openssh_ecdsa_p256_private_key(privateKey, comment, passphrase, undefined);
            } else if (algorithm === 'ecdsa-p384') {
                const keypair = wasm.ecdsa_p384_generate_keypair();
                const privateKey = keypair.slice(0, 48);
                privateKeyPem = wasm.openssh_ecdsa_p384_private_key(privateKey, comment, passphrase, undefined);
            } else if (algorithm.startsWith('rsa')) {
                const bits = parseInt(els.keySize.value, 10) || 3072;
                const pkcs8 = wasm.rsa_generate_private_key_pkcs8(bits);
                privateKeyPem = wasm.openssh_rsa_private_key_from_pkcs8(pkcs8, comment, passphrase, undefined);
            }

            const publicKeyLine = wasm.openssh_private_key_to_public_key_line(privateKeyPem, passphrase, null);
            els.privateKey.value = privateKeyPem;
            els.publicKey.value = publicKeyLine;

            const warnings = wasm.openssh_private_key_warnings(privateKeyPem, passphrase);
            setWarnings(els, warnings, strings);

            const state = getState(els.root);
            state.lastPublicName = 'id_key.pub';
            state.lastPrivateName = 'id_key';
        } catch (err) {
            console.error(err);
            setError(els, err?.message || String(err));
        }
    }

    async function readImportText(els) {
        const text = (els.importText.value || '').trim();
        if (text) return text;

        const file = els.importFile.files && els.importFile.files.length > 0 ? els.importFile.files[0] : null;
        if (!file) return '';
        return await file.text();
    }

    async function importAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        setWarnings(els, [], strings);

        try {
            const wasm = await getCryptoWasm();
            const passphrase = getPassphrase(els);
            const input = await readImportText(els);
            const kind = guessInput(input);

            if (kind === 'empty') return;

            let publicKeyLine = '';
            let privateKeyPem = '';

            if (kind === 'openssh-private') {
                privateKeyPem = input;
                publicKeyLine = wasm.openssh_private_key_to_public_key_line(input, passphrase, null);
                const warnings = wasm.openssh_private_key_warnings(input, passphrase);
                setWarnings(els, warnings, strings);
            } else if (kind === 'openssh-public') {
                publicKeyLine = input;
                const warnings = wasm.openssh_public_key_warnings(input);
                setWarnings(els, warnings, strings);
            } else if (kind === 'spki-public') {
                publicKeyLine = wasm.openssh_public_key_from_spki_pem(input, null);
                const warnings = wasm.openssh_public_key_warnings(publicKeyLine);
                setWarnings(els, warnings, strings);
            } else if (kind === 'pkcs8-private') {
                privateKeyPem = wasm.openssh_private_key_from_pkcs8_pem(input, null, passphrase, undefined);
                publicKeyLine = wasm.openssh_private_key_to_public_key_line(privateKeyPem, passphrase, null);
                const warnings = wasm.openssh_private_key_warnings(privateKeyPem, passphrase);
                setWarnings(els, warnings, strings);
            } else {
                throw new Error('Unsupported key format');
            }

            els.publicKey.value = publicKeyLine || '';
            els.privateKey.value = privateKeyPem || '';

            const state = getState(els.root);
            state.lastPublicName = 'imported.pub';
            state.lastPrivateName = 'imported.key';
        } catch (err) {
            setError(els, err?.message || String(err));
        }
    }

    async function convertAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        setWarnings(els, [], strings);

        try {
            const wasm = await getCryptoWasm();
            const passphrase = getPassphrase(els);
            const input = await readImportText(els);
            const kind = guessInput(input);
            let publicKeyLine = '';
            let privateKeyPem = '';

            if (kind === 'openssh-private') {
                privateKeyPem = wasm.openssh_private_key_to_pkcs8_pem(input, passphrase);
                publicKeyLine = wasm.openssh_private_key_to_public_key_line(input, passphrase, null);
            } else if (kind === 'openssh-public') {
                publicKeyLine = wasm.openssh_public_key_to_spki_pem(input);
            } else if (kind === 'spki-public') {
                publicKeyLine = wasm.openssh_public_key_from_spki_pem(input, null);
            } else if (kind === 'pkcs8-private') {
                privateKeyPem = wasm.openssh_private_key_from_pkcs8_pem(input, null, passphrase, undefined);
                publicKeyLine = wasm.openssh_private_key_to_public_key_line(privateKeyPem, passphrase, null);
            } else {
                throw new Error('Unsupported key format');
            }

            els.publicKey.value = publicKeyLine || '';
            els.privateKey.value = privateKeyPem || '';
            setWarnings(els, [], strings);
        } catch (err) {
            setError(els, err?.message || String(err));
        }
    }

    function downloadPublic() {
        const els = getElements();
        if (!els) return;
        const state = getState(els.root);
        if (!els.publicKey.value) return;
        downloadText(state.lastPublicName || 'id_key.pub', els.publicKey.value);
    }

    function downloadPrivate() {
        const els = getElements();
        if (!els) return;
        const state = getState(els.root);
        if (!els.privateKey.value) return;
        downloadText(state.lastPrivateName || 'id_key', els.privateKey.value);
    }

    function updateFileName(input, label) {
        if (input.files && input.files.length > 0) {
            label.textContent = input.files[0].name;
            label.classList.add('text-primary');
            label.classList.add('font-semibold');
        } else {
            label.textContent = 'Drag & drop or click to select';
            label.classList.remove('text-primary');
            label.classList.remove('font-semibold');
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_openssh_bound) return;
        window.__mydevtools_openssh_bound = true;

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            if (target.id === 'openssh-algorithm') {
                const els = getElements();
                if (els) {
                    const isRsa = target.value.startsWith('rsa');
                    els.keySize.disabled = !isRsa;
                    if (!isRsa) els.keySize.value = 'default';
                }
            }
            if (target.id === 'openssh-import-file') {
                const els = getElements();
                if (els) updateFileName(target, els.importFileName);
            }
        });

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'openssh-generate-btn') return void generateAction();
            if (target.id === 'openssh-import-btn') return void importAction();
            if (target.id === 'openssh-convert-btn') return void convertAction();
            if (target.id === 'openssh-public-copy') {
                const els = getElements();
                if (!els) return;
                return void copyText(els.publicKey, target, getStrings(els.root));
            }
            if (target.id === 'openssh-private-copy') {
                const els = getElements();
                if (!els) return;
                return void copyText(els.privateKey, target, getStrings(els.root));
            }
            if (target.id === 'openssh-public-download') return void downloadPublic();
            if (target.id === 'openssh-private-download') return void downloadPrivate();
        });
    }

    bindDelegatedHandlersOnce();

    function init() {
        const els = getElements();
        if (els && !initializedRoots.has(els.root)) {
            initializedRoots.add(els.root);
        }
    }

    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
