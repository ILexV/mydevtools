/* global document, window */

(function () {
    const initializedRoots = new WeakSet();
    const rootState = new WeakMap();
    let abortController = null;

    function getState(root) {
        let state = rootState.get(root);
        if (!state) {
            state = { lastBlob: null, lastName: null };
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
        const root = document.getElementById('aead-root');
        if (!root) return null;

        const inputFile = document.getElementById('aead-input-file');
        const decryptFile = document.getElementById('aead-decrypt-file');
        const algorithm = document.getElementById('aead-algorithm');
        const password = document.getElementById('aead-password');
        const encryptBtn = document.getElementById('aead-encrypt-btn');
        const decryptBtn = document.getElementById('aead-decrypt-btn');
        const header = document.getElementById('aead-header');
        const output = document.getElementById('aead-output');
        const copyBtn = document.getElementById('aead-copy');
        const downloadBtn = document.getElementById('aead-download');
        const warnings = document.getElementById('aead-warnings');
        const outputSection = output?.closest('.output-section');

        if (!inputFile || !decryptFile || !algorithm || !password || !encryptBtn || !decryptBtn || !header || !output || !copyBtn || !downloadBtn || !warnings || !outputSection) {
            return null;
        }

        return {
            root,
            inputFile,
            decryptFile,
            algorithm,
            password,
            encryptBtn,
            decryptBtn,
            header,
            output,
            copyBtn,
            downloadBtn,
            warnings,
            outputSection
        };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            fileProgressTitle: root.dataset.fileProgressTitle || 'Processing file...',
            cancel: root.dataset.cancel || 'Cancel',
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!',
            download: root.dataset.download || 'Download',
            warningsTitle: root.dataset.warningsTitle || 'Warnings'
        };
    }

    function formatBytes(bytes) {
        if (window.MyDevToolsFile?.formatBytes) return window.MyDevToolsFile.formatBytes(bytes);
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        const digits = unitIndex === 0 ? 0 : 2;
        return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    function formatDuration(seconds) {
        if (window.MyDevToolsFile?.formatDuration) return window.MyDevToolsFile.formatDuration(seconds);
        if (!isFinite(seconds) || seconds < 0) return '--:--';
        const s = Math.floor(seconds % 60);
        const m = Math.floor((seconds / 60) % 60);
        const h = Math.floor(seconds / 3600);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function escapeHtml(text) {
        return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function renderFileProgress(outputSection, strings, file) {
        if (!outputSection.dataset.originalHtml) {
            outputSection.dataset.originalHtml = outputSection.innerHTML;
        }
        outputSection.innerHTML = `
            <div class="file-progress">
                <div class="file-progress-header">
                    <div class="file-progress-title">${escapeHtml(strings.fileProgressTitle)}</div>
                    <button class="btn btn-secondary btn-small" id="aead-cancel-btn">${escapeHtml(strings.cancel)}</button>
                </div>
                <div class="file-progress-meta">${escapeHtml(file.name)} • ${formatBytes(file.size)}</div>
                <progress id="aead-file-progress-bar" value="0" max="100"></progress>
                <div id="aead-file-progress-stats" class="file-progress-stats"></div>
            </div>
        `;
    }

    function restoreOutputSection(outputSection) {
        const html = outputSection?.dataset?.originalHtml;
        if (typeof html === 'string' && html.length > 0) {
            outputSection.innerHTML = html;
        }
    }

    function updateProgress(processed, total, elapsedMs) {
        const progressEl = document.getElementById('aead-file-progress-bar');
        const statsEl = document.getElementById('aead-file-progress-stats');
        if (!progressEl || !statsEl) return;
        const percent = total === 0 ? 0 : Math.min(100, Math.round((processed / total) * 100));
        const seconds = elapsedMs / 1000;
        const speed = seconds > 0 ? processed / seconds : 0;
        const remaining = speed > 0 ? (total - processed) / speed : 0;

        progressEl.value = percent;
        statsEl.textContent = `${formatBytes(processed)} / ${formatBytes(total)} • ${formatBytes(speed)}/s • ETA ${formatDuration(remaining)}`;
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
        if (!state.lastBlob || !state.lastName) return;
        const url = URL.createObjectURL(state.lastBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.lastName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function toHex(bytes) {
        let out = '';
        for (const b of bytes) {
            out += b.toString(16).padStart(2, '0');
        }
        return out;
    }

    function getAlgorithmId(value) {
        if (value === 'aes-256-gcm') return 1;
        if (value === 'chacha20-poly1305') return 2;
        if (value === 'xchacha20-poly1305') return 3;
        return 1;
    }

    async function encryptAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);

        const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
        if (!file) return setError(els, 'Select a file to encrypt');
        const password = (els.password.value || '').trim();
        if (!password) return setError(els, 'Password is required');

        const wasm = await getCryptoWasm();
        try {
            ensureFunctions(wasm, [
                'aead_stream_header_pack',
                'aead_stream_derive_key_from_header',
                'aead_stream_encrypt_chunk'
            ]);
        } catch (err) {
            return setError(els, err?.message || String(err));
        }

        abortController = new AbortController();
        renderFileProgress(els.outputSection, strings, file);

        try {
            const algorithmId = getAlgorithmId(els.algorithm.value);
            const chunkSize = 1024 * 1024;
            const kdfId = 1; // Argon2id
            const salt = new Uint8Array(16);
            crypto.getRandomValues(salt);
            const noncePrefix = new Uint8Array(algorithmId === 3 ? 16 : 4);
            crypto.getRandomValues(noncePrefix);

            const header = wasm.aead_stream_header_pack(algorithmId, kdfId, salt, noncePrefix, chunkSize);
            const passwordBytes = new TextEncoder().encode(password);
            const key = wasm.aead_stream_derive_key_from_header(header, passwordBytes, 64 * 1024, 3, 1);

            const chunks = [header];
            let processed = 0;
            let counter = 0n;
            const total = file.size;
            const start = performance.now();

            while (processed < total) {
                if (abortController?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                const slice = file.slice(processed, Math.min(processed + chunkSize, total));
                const buf = await slice.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const ciphertext = wasm.aead_stream_encrypt_chunk(algorithmId, key, noncePrefix, counter, bytes, new Uint8Array());
                chunks.push(ciphertext);
                processed += slice.size;
                counter += 1n;
                updateProgress(processed, total, performance.now() - start);
                await new Promise(requestAnimationFrame);
            }

            const outBlob = new Blob(chunks, { type: 'application/octet-stream' });
            const outName = `${file.name}.aead`;
            const state = getState(els.root);
            state.lastBlob = outBlob;
            state.lastName = outName;

            restoreOutputSection(els.outputSection);
            const refreshed = getElements();
            if (refreshed) {
                refreshed.header.value = toHex(new Uint8Array(header));
                refreshed.output.value = `${outName} • ${formatBytes(outBlob.size)}`;
                setWarnings(refreshed, [], strings);
            }
        } catch (err) {
            restoreOutputSection(els.outputSection);
            const refreshed = getElements();
            if (refreshed) {
                if (err?.name === 'AbortError') {
                    setError(refreshed, 'Canceled');
                } else {
                    setError(refreshed, err?.message || String(err));
                }
            }
        }
    }

    async function decryptAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);

        const file = els.decryptFile.files && els.decryptFile.files.length > 0 ? els.decryptFile.files[0] : null;
        if (!file) return setError(els, 'Select a file to decrypt');
        const password = (els.password.value || '').trim();
        if (!password) return setError(els, 'Password is required');

        const wasm = await getCryptoWasm();
        try {
            ensureFunctions(wasm, [
                'aead_stream_header_info',
                'aead_stream_extract_nonce_prefix',
                'aead_stream_derive_key_from_header',
                'aead_stream_decrypt_chunk'
            ]);
        } catch (err) {
            return setError(els, err?.message || String(err));
        }

        abortController = new AbortController();
        renderFileProgress(els.outputSection, strings, file);

        try {
            const headerPreview = new Uint8Array(await file.slice(0, 128).arrayBuffer());
            const info = wasm.aead_stream_header_info(headerPreview);
            const algorithmId = info[0];
            const chunkSize = info[4];
            const headerLen = info[5];

            const headerBytes = new Uint8Array(await file.slice(0, headerLen).arrayBuffer());
            const noncePrefix = wasm.aead_stream_extract_nonce_prefix(headerBytes);
            const passwordBytes = new TextEncoder().encode(password);
            const key = wasm.aead_stream_derive_key_from_header(headerBytes, passwordBytes, 64 * 1024, 3, 1);

            const chunks = [];
            let offset = headerLen;
            let counter = 0n;
            const tagLen = 16;
            const total = file.size - headerLen;
            const start = performance.now();

            while (offset < file.size) {
                if (abortController?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                const slice = file.slice(offset, Math.min(offset + chunkSize + tagLen, file.size));
                const buf = await slice.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const plaintext = wasm.aead_stream_decrypt_chunk(algorithmId, key, noncePrefix, counter, bytes, new Uint8Array());
                chunks.push(plaintext);
                offset += bytes.length;
                counter += 1n;
                updateProgress(offset - headerLen, total, performance.now() - start);
                await new Promise(requestAnimationFrame);
            }

            const outBlob = new Blob(chunks, { type: 'application/octet-stream' });
            const outName = file.name.endsWith('.aead') ? file.name.slice(0, -5) : `${file.name}.dec`;
            const state = getState(els.root);
            state.lastBlob = outBlob;
            state.lastName = outName;

            restoreOutputSection(els.outputSection);
            const refreshed = getElements();
            if (refreshed) {
                refreshed.header.value = toHex(new Uint8Array(headerBytes));
                refreshed.output.value = `${outName} • ${formatBytes(outBlob.size)}`;
                setWarnings(refreshed, [], strings);
            }
        } catch (err) {
            restoreOutputSection(els.outputSection);
            const refreshed = getElements();
            if (refreshed) {
                if (err?.name === 'AbortError') {
                    setError(refreshed, 'Canceled');
                } else {
                    setError(refreshed, err?.message || String(err));
                }
            }
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_aead_bound) return;
        window.__mydevtools_aead_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'aead-encrypt-btn') return void encryptAction();
            if (target.id === 'aead-decrypt-btn') return void decryptAction();
            if (target.id === 'aead-copy') {
                const els = getElements();
                if (!els) return;
                return void copyOutput(els, getStrings(els.root));
            }
            if (target.id === 'aead-download') {
                const els = getElements();
                if (!els) return;
                return void downloadOutput(els);
            }
            if (target.id === 'aead-cancel-btn') {
                try {
                    abortController?.abort();
                } catch {
                    // ignore
                }
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
