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
            // Updated path to ensure correct loading
            cryptoWasmPromise = import('/wasm/cryptography/cryptography.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return cryptoWasmPromise;
    }

    function getElements() {
        const root = document.getElementById('aead-root');
        if (!root) return null;

        return {
            root,
            inputFile: document.getElementById('aead-input-file'),
            inputFileName: document.getElementById('aead-input-file-name'),
            decryptFile: document.getElementById('aead-decrypt-file'),
            decryptFileName: document.getElementById('aead-decrypt-file-name'),
            algorithm: document.getElementById('aead-algorithm'),
            password: document.getElementById('aead-password'),
            encryptBtn: document.getElementById('aead-encrypt-btn'),
            decryptBtn: document.getElementById('aead-decrypt-btn'),
            header: document.getElementById('aead-header'),
            output: document.getElementById('aead-output'),
            downloadBtn: document.getElementById('aead-download'),
            warnings: document.getElementById('aead-warnings'),
            warningsText: document.getElementById('aead-warnings-text'),
            outputSection: document.getElementById('aead-output-section')
        };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            fileProgressTitle: root.dataset.fileProgressTitle || 'Processing file...',
            cancel: root.dataset.cancel || 'Cancel',
            download: root.dataset.download || 'Download',
            warningsTitle: root.dataset.warningsTitle || 'Warnings'
        };
    }

    function formatBytes(bytes) {
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
        // Save original content if not saved (to restore later if needed, though we might just replace back)
        // Here we prepend or replace a specific div
        
        let progressContainer = document.getElementById('aead-progress-container');
        if (!progressContainer) {
            progressContainer = document.createElement('div');
            progressContainer.id = 'aead-progress-container';
            progressContainer.className = 'w-full mb-4 bg-base-200 rounded-lg p-4';
            outputSection.insertBefore(progressContainer, outputSection.firstChild);
        }

        progressContainer.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <span class="font-bold">${escapeHtml(strings.fileProgressTitle)}</span>
                <button class="btn btn-xs btn-ghost text-error" id="aead-cancel-btn">${escapeHtml(strings.cancel)}</button>
            </div>
            <div class="text-xs opacity-70 mb-2">${escapeHtml(file.name)} • ${formatBytes(file.size)}</div>
            <progress id="aead-file-progress-bar" class="progress progress-primary w-full" value="0" max="100"></progress>
            <div id="aead-file-progress-stats" class="text-xs text-right mt-1 font-mono opacity-70"></div>
        `;
        
        progressContainer.style.display = 'block';
    }

    function hideFileProgress() {
        const container = document.getElementById('aead-progress-container');
        if (container) container.style.display = 'none';
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

    function setError(els, message) {
        if (!els.warnings || !els.warningsText) return;
        els.warnings.classList.remove('hidden');
        els.warnings.style.display = 'flex';
        els.warningsText.textContent = message;
        hideFileProgress();
    }

    function clearError(els) {
        if (!els.warnings) return;
        els.warnings.classList.add('hidden');
        els.warnings.style.display = 'none';
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
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function getAlgorithmId(value) {
        if (value === 'aes-256-gcm') return 1;
        if (value === 'chacha20-poly1305') return 2;
        if (value === 'xchacha20-poly1305') return 3;
        return 1;
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

    async function encryptAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        clearError(els);

        const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
        if (!file) return setError(els, 'Select a file to encrypt');
        const password = (els.password.value || '').trim();
        if (!password) return setError(els, 'Password is required');

        const wasm = await getCryptoWasm();
        
        // Disable buttons
        els.encryptBtn.disabled = true;
        els.downloadBtn.disabled = true;

        abortController = new AbortController();
        renderFileProgress(els.outputSection, strings, file);

        try {
            const algorithmId = getAlgorithmId(els.algorithm.value);
            const chunkSize = 1024 * 1024; // 1MB chunks
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
                counter += 1n; // BigInt increment
                
                updateProgress(processed, total, performance.now() - start);
                
                // Allow UI update
                await new Promise(requestAnimationFrame);
            }

            const outBlob = new Blob(chunks, { type: 'application/octet-stream' });
            const outName = `${file.name}.aead`;
            const state = getState(els.root);
            state.lastBlob = outBlob;
            state.lastName = outName;

            hideFileProgress();
            
            // Update UI
            els.header.value = toHex(new Uint8Array(header));
            els.output.value = `${outName} • ${formatBytes(outBlob.size)}`;
            els.downloadBtn.disabled = false;

        } catch (err) {
            hideFileProgress();
            if (err?.name === 'AbortError') {
                setError(els, 'Operation canceled');
            } else {
                console.error(err);
                setError(els, err?.message || String(err));
            }
        } finally {
            els.encryptBtn.disabled = false;
        }
    }

    async function decryptAction() {
        const els = getElements();
        if (!els) return;
        const strings = getStrings(els.root);
        clearError(els);

        const file = els.decryptFile.files && els.decryptFile.files.length > 0 ? els.decryptFile.files[0] : null;
        if (!file) return setError(els, 'Select a file to decrypt');
        const password = (els.password.value || '').trim();
        if (!password) return setError(els, 'Password is required');

        const wasm = await getCryptoWasm();
        
        els.decryptBtn.disabled = true;
        els.downloadBtn.disabled = true;

        abortController = new AbortController();
        renderFileProgress(els.outputSection, strings, file);

        try {
            // Read first chunk to get header info
            const headerPreview = new Uint8Array(await file.slice(0, 128).arrayBuffer());
            // aead_stream_header_info returns [algoId, kdfId, saltLen, noncePrefixLen, chunkSize, headerLen]
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
            const total = file.size - headerLen; // approximate payload size
            const start = performance.now();

            while (offset < file.size) {
                if (abortController?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                
                // Chunk size in file = plaintext_chunk + tag
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

            hideFileProgress();
            
            els.header.value = toHex(new Uint8Array(headerBytes));
            els.output.value = `${outName} • ${formatBytes(outBlob.size)}`;
            els.downloadBtn.disabled = false;

        } catch (err) {
            hideFileProgress();
            if (err?.name === 'AbortError') {
                setError(els, 'Operation canceled');
            } else {
                console.error(err);
                setError(els, err?.message || String(err));
            }
        } finally {
            els.decryptBtn.disabled = false;
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_aead_bound) return;
        window.__mydevtools_aead_bound = true;

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            if (target.id === 'aead-input-file') {
                const els = getElements();
                if (els) updateFileName(target, els.inputFileName);
            }
            if (target.id === 'aead-decrypt-file') {
                const els = getElements();
                if (els) updateFileName(target, els.decryptFileName);
            }
        });

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            const encryptBtn = target.closest('#aead-encrypt-btn');
            if (encryptBtn) {
                ev.preventDefault();
                encryptAction();
                return;
            }

            const decryptBtn = target.closest('#aead-decrypt-btn');
            if (decryptBtn) {
                ev.preventDefault();
                decryptAction();
                return;
            }

            const downloadBtn = target.closest('#aead-download');
            if (downloadBtn) {
                ev.preventDefault();
                const els = getElements();
                if (els && !downloadBtn.disabled) downloadOutput(els);
                return;
            }

            const cancelBtn = target.closest('#aead-cancel-btn');
            if (cancelBtn) {
                ev.preventDefault();
                if (abortController) abortController.abort();
                return;
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
