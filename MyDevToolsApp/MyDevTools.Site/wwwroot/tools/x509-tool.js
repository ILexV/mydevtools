/* global document, window, BigInt */

(function () {
    const initializedRoots = new WeakSet();
    const rootState = new WeakMap();

    function getState(root) {
        let state = rootState.get(root);
        if (!state) {
            state = { lastDownloadName: null };
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
        const root = document.getElementById('x509-root');
        if (!root) return null;

        return {
            root,
            subject: document.getElementById('x509-subject'),
            validity: document.getElementById('x509-validity'),
            generateSelfSigned: document.getElementById('x509-generate-selfsigned'),
            generateCsr: document.getElementById('x509-generate-csr'),
            parseInput: document.getElementById('x509-parse-input'),
            parseBtn: document.getElementById('x509-parse-btn'),
            output: document.getElementById('x509-output'),
            copyBtn: document.getElementById('x509-copy'),
            downloadBtn: document.getElementById('x509-download'),
            warnings: document.getElementById('x509-warnings'),
            warningsText: document.getElementById('x509-warnings-text')
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

    function escapeHtml(text) {
        return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function setWarnings(els, warnings, strings) {
        if (!warnings || warnings.length === 0) {
            if (els.warnings) {
                els.warnings.classList.add('hidden');
                els.warnings.style.display = 'none';
            }
            if (els.warningsText) els.warningsText.textContent = '';
            return;
        }
        if (els.warnings) {
            els.warnings.classList.remove('hidden');
            els.warnings.style.display = 'flex';
        }
        if (els.warningsText) {
            els.warningsText.innerHTML = `<strong>${strings.warningsTitle}:</strong> ${warnings.map(escapeHtml).join('; ')}`;
        }
    }

    function setError(els, message) {
        if (els.warnings) {
            els.warnings.classList.remove('hidden');
            els.warnings.style.display = 'flex';
        }
        if (els.warningsText) {
            els.warningsText.innerHTML = `<strong>Error:</strong> ${escapeHtml(message)}`;
        }
    }

    function copyOutput(els, strings) {
        const original = els.copyBtn.innerHTML;
        const originalClass = els.copyBtn.className;
        
        navigator.clipboard.writeText(els.output.value || '').then(() => {
            els.copyBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 mr-1 text-success">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                ${strings.copied}
            `;
            els.copyBtn.classList.add('text-success');
            
            setTimeout(() => {
                els.copyBtn.innerHTML = original;
                els.copyBtn.className = originalClass;
            }, 1200);
        });
    }

    function downloadOutput(els) {
        const state = getState(els.root);
        if (!els.output.value) return;
        const blob = new Blob([els.output.value], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.lastDownloadName || 'x509.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function prettyJson(jsonText) {
        try {
            const parsed = JSON.parse(jsonText);
            return JSON.stringify(parsed, null, 2);
        } catch {
            return jsonText;
        }
    }

    function base64ToBytes(text) {
        const normalized = text.replace(/\s+/g, '');
        const binary = atob(normalized);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }

    async function generateSelfSignedAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        setWarnings(els, [], strings);

        try {
            const wasm = await getCryptoWasm();
            const subject = (els.subject.value || '').trim();
            const outputs = wasm.x509_self_signed_pem(1, subject || null, [], []);
            
            const cert = outputs[0] || '';
            const key = outputs[1] || '';
            els.output.value = `${cert}\n${key}`.trim();
            
            const state = getState(els.root);
            state.lastDownloadName = 'certificate.pem';
        } catch (err) {
            console.error(err);
            setError(els, err?.message || String(err));
        }
    }

    async function generateCsrAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        setWarnings(els, [], strings);

        try {
            const wasm = await getCryptoWasm();
            
            const subject = (els.subject.value || '').trim();
            const outputs = wasm.x509_csr_pem(1, subject || null, [], []);
            
            const csr = outputs[0] || '';
            const key = outputs[1] || '';
            els.output.value = `${csr}\n${key}`.trim();
            
            const state = getState(els.root);
            state.lastDownloadName = 'request.csr.pem';
        } catch (err) {
            console.error(err);
            setError(els, err?.message || String(err));
        }
    }

    async function parseAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        setWarnings(els, [], strings);

        try {
            const wasm = await getCryptoWasm();
            const input = (els.parseInput.value || '').trim();
            if (!input) return;

            const now = Math.floor(Date.now() / 1000);
            const nowBigInt = BigInt(now);

            if (input.includes('BEGIN')) {
                const json = wasm.x509_parse_pem(input);
                els.output.value = prettyJson(json);
                const warnings = wasm.x509_warnings_pem(input, nowBigInt);
                setWarnings(els, warnings, strings);
            } else {
                try {
                    const bytes = base64ToBytes(input);
                    const json = wasm.x509_parse_der(bytes);
                    els.output.value = prettyJson(json);
                    const warnings = wasm.x509_warnings_der(bytes, nowBigInt);
                    setWarnings(els, warnings, strings);
                } catch (e) {
                    throw new Error("Invalid format. Paste PEM or Base64 DER.");
                }
            }

            const state = getState(els.root);
            state.lastDownloadName = 'x509.json';
        } catch (err) {
            console.error(err);
            setError(els, err?.message || String(err));
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_x509_bound) return;
        window.__mydevtools_x509_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            const generateSelfBtn = target.closest('#x509-generate-selfsigned');
            if (generateSelfBtn) return void generateSelfSignedAction();

            const generateCsrBtn = target.closest('#x509-generate-csr');
            if (generateCsrBtn) return void generateCsrAction();

            const parseBtn = target.closest('#x509-parse-btn');
            if (parseBtn) return void parseAction();

            const copyBtn = target.closest('#x509-copy');
            if (copyBtn) {
                const els = getElements();
                if (!els) return;
                return void copyOutput(els, getStrings(els.root));
            }

            const downloadBtn = target.closest('#x509-download');
            if (downloadBtn) {
                const els = getElements();
                if (!els) return;
                return void downloadOutput(els);
            }
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
