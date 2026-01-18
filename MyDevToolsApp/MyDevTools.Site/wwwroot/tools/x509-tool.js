/* global document, window */

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
            cryptoWasmPromise = import('/wasm/cryptography/cryptography-loader.js').then((m) => m.getCryptographyWasm());
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

        const subject = document.getElementById('x509-subject');
        const validity = document.getElementById('x509-validity');
        const generateSelfSigned = document.getElementById('x509-generate-selfsigned');
        const generateCsr = document.getElementById('x509-generate-csr');
        const parseInput = document.getElementById('x509-parse-input');
        const parseBtn = document.getElementById('x509-parse-btn');
        const output = document.getElementById('x509-output');
        const copyBtn = document.getElementById('x509-copy');
        const downloadBtn = document.getElementById('x509-download');
        const warnings = document.getElementById('x509-warnings');

        if (!subject || !validity || !generateSelfSigned || !generateCsr || !parseInput || !parseBtn || !output || !copyBtn || !downloadBtn || !warnings) {
            return null;
        }

        return {
            root,
            subject,
            validity,
            generateSelfSigned,
            generateCsr,
            parseInput,
            parseBtn,
            output,
            copyBtn,
            downloadBtn,
            warnings
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
            els.warnings.hidden = true;
            els.warnings.textContent = '';
            return;
        }
        els.warnings.hidden = false;
        els.warnings.innerHTML = `<strong>${strings.warningsTitle}:</strong> ${warnings.map(escapeHtml).join('; ')}`;
    }

    function setError(els, message) {
        els.warnings.hidden = false;
        els.warnings.innerHTML = `<strong>Error:</strong> ${escapeHtml(message)}`;
    }

    function copyOutput(els, strings) {
        const original = els.copyBtn.textContent;
        navigator.clipboard.writeText(els.output.value || '').then(() => {
            els.copyBtn.textContent = strings.copied;
            setTimeout(() => {
                els.copyBtn.textContent = original;
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

        try {
            const wasm = await getCryptoWasm();
            ensureFunctions(wasm, ['x509_self_signed_pem']);

            const subject = (els.subject.value || '').trim();
            const outputs = wasm.x509_self_signed_pem(1, subject || null, [], []);
            const cert = outputs[0] || '';
            const key = outputs[1] || '';
            els.output.value = `${cert}\n${key}`.trim();
            setWarnings(els, [], strings);

            const state = getState(els.root);
            state.lastDownloadName = 'certificate.pem';
        } catch (err) {
            setError(els, err?.message || String(err));
        }
    }

    async function generateCsrAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);

        try {
            const wasm = await getCryptoWasm();
            ensureFunctions(wasm, ['x509_csr_pem']);

            const subject = (els.subject.value || '').trim();
            const outputs = wasm.x509_csr_pem(1, subject || null, [], []);
            const csr = outputs[0] || '';
            const key = outputs[1] || '';
            els.output.value = `${csr}\n${key}`.trim();
            setWarnings(els, [], strings);

            const state = getState(els.root);
            state.lastDownloadName = 'request.csr.pem';
        } catch (err) {
            setError(els, err?.message || String(err));
        }
    }

    async function parseAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);

        try {
            const wasm = await getCryptoWasm();
            ensureFunctions(wasm, ['x509_parse_pem', 'x509_parse_der', 'x509_warnings_pem', 'x509_warnings_der']);
            const input = (els.parseInput.value || '').trim();
            if (!input) return;

            const now = Math.floor(Date.now() / 1000);
            if (input.includes('BEGIN')) {
                const json = wasm.x509_parse_pem(input);
                els.output.value = prettyJson(json);
                const warnings = wasm.x509_warnings_pem(input, now);
                setWarnings(els, warnings, strings);
            } else {
                const bytes = base64ToBytes(input);
                const json = wasm.x509_parse_der(bytes);
                els.output.value = prettyJson(json);
                const warnings = wasm.x509_warnings_der(bytes, now);
                setWarnings(els, warnings, strings);
            }

            const state = getState(els.root);
            state.lastDownloadName = 'x509.json';
        } catch (err) {
            setError(els, err?.message || String(err));
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_x509_bound) return;
        window.__mydevtools_x509_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'x509-generate-selfsigned') return void generateSelfSignedAction();
            if (target.id === 'x509-generate-csr') return void generateCsrAction();
            if (target.id === 'x509-parse-btn') return void parseAction();
            if (target.id === 'x509-copy') {
                const els = getElements();
                if (!els) return;
                return void copyOutput(els, getStrings(els.root));
            }
            if (target.id === 'x509-download') {
                const els = getElements();
                if (!els) return;
                return void downloadOutput(els);
            }
        });
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);
        setWarnings(els, [], getStrings(els.root));
    }

    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }
})();
