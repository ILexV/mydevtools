/* global document, window */

(function () {
    const initializedRoots = new WeakSet();

    // WASM module lazy loading
    let encodingWasmModulePromise = null;

    async function getEncodingWasm() {
        if (!encodingWasmModulePromise) {
            encodingWasmModulePromise = import('/wasm/encoding/encoding.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return encodingWasmModulePromise;
    }

    function escapeHtml(text) {
        return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
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

    function renderFileProgress(outputSection, strings, file) {
        if (!outputSection.dataset.originalHtml) {
            outputSection.dataset.originalHtml = outputSection.innerHTML;
        }
        outputSection.innerHTML = `
            <div class="file-progress">
                <div class="file-progress-header">
                    <div class="file-progress-title">${escapeHtml(strings.fileProgressTitle)}</div>
                    <button class="btn btn-secondary btn-small" id="b64-cancel-btn">${escapeHtml(strings.cancel)}</button>
                </div>
                <div class="file-progress-meta">${escapeHtml(file.name)} • ${formatBytes(file.size)}</div>
                <progress id="b64-file-progress-bar" value="0" max="100"></progress>
                <div id="b64-file-progress-stats" class="file-progress-stats"></div>
            </div>
        `;
    }

    function restoreOutputSection(outputSection) {
        const html = outputSection?.dataset?.originalHtml;
        if (typeof html === 'string' && html.length > 0) {
            outputSection.innerHTML = html;
        }
    }

    function isWhitespace(ch) {
        return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
    }

    async function encodeTextToBytes(text, charset) {
        try {
            const wasm = await getEncodingWasm();
            if (typeof wasm.encode_text_to_bytes !== 'function') {
                return { ok: false, error: { index: 0, message: 'WASM module not built. Please rebuild the encoding module: cd wasm && .\\build.ps1 -Configuration Release -Domains @(\'encoding\')' } };
            }
            const bytes = wasm.encode_text_to_bytes(text, charset);
            return { ok: true, bytes: new Uint8Array(bytes) };
        } catch (err) {
            const msg = err?.message || String(err);
            // Try to extract index from error message if possible
            const indexMatch = msg.match(/position (\d+)/);
            const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;
            return { ok: false, error: { index, message: msg } };
        }
    }

    async function decodeBytesToText(bytes, charset) {
        try {
            const wasm = await getEncodingWasm();
            if (typeof wasm.decode_bytes_to_text !== 'function') {
                return { ok: false, error: { byteIndex: 0, message: 'WASM module not built. Please rebuild the encoding module: cd wasm && .\\build.ps1 -Configuration Release -Domains @(\'encoding\')' } };
            }
            const text = wasm.decode_bytes_to_text(bytes, charset);
            return { ok: true, text };
        } catch (err) {
            const msg = err?.message || String(err);
            // Try to extract byteIndex from error message if possible
            const byteIndexMatch = msg.match(/byte (\d+)/i) || msg.match(/position (\d+)/);
            const byteIndex = byteIndexMatch ? parseInt(byteIndexMatch[1], 10) : 0;
            return { ok: false, error: { byteIndex, message: msg } };
        }
    }

    async function encodeBytesToBase64(bytes, alphabetName, paddingMode, lineWrap) {
        const wasm = await getEncodingWasm();
        if (typeof wasm.base64_encode !== 'function') {
            throw new Error('WASM module not built. Please rebuild the encoding module: cd wasm && .\\build.ps1 -Configuration Release -Domains @(\'encoding\')');
        }
        const wrapAt = lineWrap === 76 ? 76 : null;
        return wasm.base64_encode(bytes, alphabetName, paddingMode, wrapAt);
    }

    async function decodeBase64ToBytes(input, alphabetName, paddingMode, allowWhitespace) {
        try {
            const wasm = await getEncodingWasm();
            if (typeof wasm.base64_decode !== 'function') {
                return { ok: false, error: { index: 0, message: 'WASM module not built. Please rebuild the encoding module: cd wasm && .\\build.ps1 -Configuration Release -Domains @(\'encoding\')' } };
            }
            const bytes = wasm.base64_decode(input, alphabetName, paddingMode, allowWhitespace);
            return { ok: true, bytes: new Uint8Array(bytes) };
        } catch (err) {
            const msg = err?.message || String(err);
            // Try to extract index from error message if possible
            const indexMatch = msg.match(/position (\d+)/) || msg.match(/index (\d+)/);
            const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;
            return { ok: false, error: { index, message: msg } };
        }
    }

    async function encodeFileToBase64(file, alphabetName, paddingMode, lineWrap, outputMode, onProgress, signal) {
        const wasm = await getEncodingWasm();
        const chunkSize = 1024 * 1024; // 1 MiB
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        const wrapAt = lineWrap === 76 ? 76 : null;

        const parts = [];
        const previewCharLimit = 200_000;
        let preview = '';
        let previewTruncated = false;

        let carry = new Uint8Array(0);

        function pushString(s) {
            if (!s) return;
            parts.push(s);

            if (outputMode !== 'full' && !previewTruncated) {
                const remaining = previewCharLimit - preview.length;
                if (remaining > 0) {
                    preview += s.slice(0, remaining);
                    if (s.length > remaining) previewTruncated = true;
                } else {
                    previewTruncated = true;
                }
            }
        }

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            let bytes = new Uint8Array(buf);

            if (carry.length > 0) {
                const merged = new Uint8Array(carry.length + bytes.length);
                merged.set(carry, 0);
                merged.set(bytes, carry.length);
                bytes = merged;
                carry = new Uint8Array(0);
            }

            const fullLen = bytes.length - (bytes.length % 3);
            const toEncode = bytes.subarray(0, fullLen);
            const tailLen = bytes.length - fullLen;
            if (tailLen > 0) carry = bytes.subarray(fullLen);

            const encoded = wasm.base64_encode(toEncode, alphabetName, 'required', wrapAt);
            pushString(encoded);

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs, preview, previewTruncated });

            await new Promise(requestAnimationFrame);
        }

        // final carry 1-2 bytes
        if (carry.length > 0) {
            const tailEncoded = wasm.base64_encode(carry, alphabetName, paddingMode === 'none' ? 'none' : 'required', wrapAt);
            pushString(tailEncoded);
        }

        // If wrap is on, remove trailing newline.
        if (wrapAt && wrapAt > 0 && parts.length > 0) {
            const last = parts[parts.length - 1];
            if (typeof last === 'string' && last.endsWith('\n')) {
                parts[parts.length - 1] = last.slice(0, -1);
            }
        }

        const fullText = parts.join('');
        const text = outputMode === 'full'
            ? fullText
            : (previewTruncated ? (preview + '\n…(preview truncated, use Download for full output)') : preview);

        return { text, blob: new Blob([fullText], { type: 'text/plain' }) };
    }

    async function decodeBase64FileToBytes(file, alphabetName, paddingMode, allowWhitespace, onProgress, signal) {
        const wasm = await getEncodingWasm();
        const chunkSize = 1024 * 1024; // 1 MiB
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        const decoder = new TextDecoder('latin1');
        let accumulatedText = '';

        const outChunks = [];

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const text = decoder.decode(bytes, { stream: true });
            accumulatedText += text;

            // Process in reasonable chunks to avoid memory issues
            if (accumulatedText.length > 10 * 1024 * 1024) { // 10MB chunks
                try {
                    const decoded = wasm.base64_decode(accumulatedText, alphabetName, paddingMode, allowWhitespace);
                    outChunks.push(new Uint8Array(decoded));
                    accumulatedText = '';
                } catch (err) {
                    const msg = err?.message || String(err);
                    const indexMatch = msg.match(/position (\d+)/) || msg.match(/index (\d+)/);
                    const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;
                    return { ok: false, error: { index, message: msg } };
                }
            }

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs });
            await new Promise(requestAnimationFrame);
        }

        // Process remaining text
        if (accumulatedText.length > 0) {
            try {
                const decoded = wasm.base64_decode(accumulatedText, alphabetName, paddingMode, allowWhitespace);
                outChunks.push(new Uint8Array(decoded));
            } catch (err) {
                const msg = err?.message || String(err);
                const indexMatch = msg.match(/position (\d+)/) || msg.match(/index (\d+)/);
                const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;
                return { ok: false, error: { index, message: msg } };
            }
        }

        const blob = new Blob(outChunks, { type: 'application/octet-stream' });
        return { ok: true, blob };
    }

    const stateByRoot = new WeakMap();

    function getState(root) {
        let state = stateByRoot.get(root);
        if (!state) {
            state = { lastDownload: null, lastDownloadName: null };
            stateByRoot.set(root, state);
        }
        return state;
    }

    function getElements() {
        const root = document.getElementById('base64-encoder-root');
        if (!root) return null;

        const inputText = document.getElementById('b64-input-text');
        const inputFile = document.getElementById('b64-input-file');
        const output = document.getElementById('b64-output');
        const outputSection = document.getElementById('b64-output-section');

        const charset = document.getElementById('b64-charset');
        const alphabet = document.getElementById('b64-alphabet');
        const padding = document.getElementById('b64-padding');
        const wrap = document.getElementById('b64-wrap');
        const allowWs = document.getElementById('b64-allow-whitespace');
        const outputMode = document.getElementById('b64-output-mode');

        const encodeBtn = document.getElementById('b64-encode-btn');
        const decodeBtn = document.getElementById('b64-decode-btn');
        const swapBtn = document.getElementById('b64-swap-btn');
        const clearBtn = document.getElementById('b64-clear-btn');
        const copyBtn = document.getElementById('b64-copy-btn');
        const downloadBtn = document.getElementById('b64-download-btn');
        const errorEl = document.getElementById('b64-error');

        if (!inputText || !inputFile || !output || !outputSection || !charset || !alphabet || !padding || !wrap || !allowWs || !outputMode || !encodeBtn || !decodeBtn || !swapBtn || !clearBtn || !copyBtn || !downloadBtn || !errorEl) {
            return null;
        }

        return { root, inputText, inputFile, output, outputSection, charset, alphabet, padding, wrap, allowWs, outputMode, encodeBtn, decodeBtn, swapBtn, clearBtn, copyBtn, downloadBtn, errorEl };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            fileProgressTitle: root.dataset.fileProgressTitle || 'Processing file...',
            cancel: root.dataset.cancel || 'Cancel',
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!'
        };
    }

    function setError(els, message, index) {
        els.errorEl.hidden = !message;
        els.errorEl.textContent = message || '';
        if (typeof index === 'number' && index >= 0) {
            try {
                els.inputText.focus();
                els.inputText.setSelectionRange(index, Math.min(index + 1, els.inputText.value.length));
            } catch {
                // ignore
            }
        }
    }

    function clearError(els) {
        setError(els, '', null);
    }

    function setLastDownload(root, blob, name) {
        const state = getState(root);
        state.lastDownload = blob;
        state.lastDownloadName = name;
    }

    function downloadBlob(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    let abortController = null;

    async function encodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const strings = getStrings(els.root);
        const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
        const charset = String(els.charset.value || 'utf-8');
        const alphabetName = String(els.alphabet.value || 'standard');
        const paddingMode = String(els.padding.value || 'required');
        const wrap = String(els.wrap.value || 'none') === '76' ? 76 : 0;
        const outputMode = String(els.outputMode.value || 'preview');

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('b64-file-progress-bar');
                const progressStats = document.getElementById('b64-file-progress-stats');

                let result;
                try {
                    result = await encodeFileToBase64(
                        file,
                        alphabetName,
                        paddingMode,
                        wrap,
                        outputMode,
                        ({ processed, total, elapsedMs, preview, previewTruncated }) => {
                            const pct = total > 0 ? (processed / total) * 100 : 0;
                            const elapsedSec = elapsedMs / 1000;
                            const speed = elapsedSec > 0 ? processed / elapsedSec : 0;
                            const etaSec = speed > 0 ? (total - processed) / speed : Infinity;

                            if (progressBar) progressBar.value = pct;
                            if (progressStats) {
                                progressStats.textContent = `${pct.toFixed(1)}% • ${formatBytes(processed)} / ${formatBytes(total)} • ${formatBytes(speed)}/s • ETA ${formatDuration(etaSec)}`;
                            }
                        },
                        abortController.signal
                    );
                } finally {
                    restoreOutputSection(els.outputSection);
                }

                const els2 = getElements();
                if (!els2) return;
                els2.output.value = result.text;
                setLastDownload(els2.root, result.blob, `${file.name}.b64`);
            } else {
                const text = els.inputText.value || '';
                const enc = await encodeTextToBytes(text, charset);
                if (!enc.ok) {
                    setError(els, enc.error.message, enc.error.index);
                    return;
                }

                const out = await encodeBytesToBase64(enc.bytes, alphabetName, paddingMode, wrap);
                els.output.value = out;
                setLastDownload(els.root, new Blob([out], { type: 'text/plain' }), 'text.b64');
            }
        } catch (err) {
            const isAbort = err && err.name === 'AbortError';
            setError(els, isAbort ? 'Canceled' : (err?.message || String(err)), null);
        } finally {
            abortController = null;
            const els3 = getElements();
            if (els3) {
                els3.encodeBtn.disabled = false;
                els3.decodeBtn.disabled = false;
            }
        }
    }

    async function decodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const strings = getStrings(els.root);
        const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
        const charset = String(els.charset.value || 'utf-8');
        const alphabetName = String(els.alphabet.value || 'standard');
        const paddingMode = String(els.padding.value || 'required');
        const allowWhitespace = !!els.allowWs.checked;

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('b64-file-progress-bar');
                const progressStats = document.getElementById('b64-file-progress-stats');

                let decoded;
                try {
                    decoded = await decodeBase64FileToBytes(
                        file,
                        alphabetName,
                        paddingMode,
                        allowWhitespace,
                        ({ processed, total, elapsedMs }) => {
                            const pct = total > 0 ? (processed / total) * 100 : 0;
                            const elapsedSec = elapsedMs / 1000;
                            const speed = elapsedSec > 0 ? processed / elapsedSec : 0;
                            const etaSec = speed > 0 ? (total - processed) / speed : Infinity;

                            if (progressBar) progressBar.value = pct;
                            if (progressStats) {
                                progressStats.textContent = `${pct.toFixed(1)}% • ${formatBytes(processed)} / ${formatBytes(total)} • ${formatBytes(speed)}/s • ETA ${formatDuration(etaSec)}`;
                            }
                        },
                        abortController.signal
                    );
                } finally {
                    restoreOutputSection(els.outputSection);
                }

                if (!decoded.ok) {
                    const els2 = getElements();
                    if (els2) {
                        els2.output.value = '';
                        setError(els2, `${decoded.error.message} (index ${decoded.error.index})`, null);
                    }
                    return;
                }

                const els2 = getElements();
                if (!els2) return;
                els2.output.value = `Decoded ${file.name} → ${file.name}.bin`;
                setLastDownload(els2.root, decoded.blob, `${file.name}.bin`);
            } else {
                const input = els.inputText.value || '';
                const parsed = await decodeBase64ToBytes(input, alphabetName, paddingMode, allowWhitespace);
                if (!parsed.ok) {
                    setError(els, parsed.error.message, parsed.error.index);
                    return;
                }

                const text = await decodeBytesToText(parsed.bytes, charset);
                if (!text.ok) {
                    setError(els, `${text.error.message} (byte ${text.error.byteIndex})`, null);
                    return;
                }

                els.output.value = text.text;
                setLastDownload(els.root, new Blob([parsed.bytes], { type: 'application/octet-stream' }), 'decoded.bin');
            }
        } catch (err) {
            const isAbort = err && err.name === 'AbortError';
            setError(els, isAbort ? 'Canceled' : (err?.message || String(err)), null);
        } finally {
            abortController = null;
            const els3 = getElements();
            if (els3) {
                els3.encodeBtn.disabled = false;
                els3.decodeBtn.disabled = false;
            }
        }
    }

    function swapAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);
        const a = els.inputText.value;
        els.inputText.value = els.output.value;
        els.output.value = a;
    }

    function clearAction() {
        const els = getElements();
        if (!els) return;
        els.inputText.value = '';
        els.output.value = '';
        els.inputFile.value = '';
        els.inputFile.dispatchEvent(new Event('change', { bubbles: true }));
        clearError(els);
        setLastDownload(els.root, null, null);
    }

    function copyOutputAction() {
        const els = getElements();
        if (!els) return;

        const copiedLabel = els.root.dataset.copied || 'Copied!';
        const original = els.copyBtn.textContent;

        navigator.clipboard.writeText(els.output.value || '').then(() => {
            els.copyBtn.textContent = copiedLabel;
            setTimeout(() => {
                els.copyBtn.textContent = original;
            }, 1200);
        });
    }

    function downloadAction() {
        const els = getElements();
        if (!els) return;
        const state = getState(els.root);
        if (!state.lastDownload || !state.lastDownloadName) return;
        downloadBlob(state.lastDownload, state.lastDownloadName);
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_base64_encoder_bound) return;
        window.__mydevtools_base64_encoder_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            // Allow HTMLElement and SVGElement (buttons might contain SVGs)
            if (!(target instanceof Element)) return;

            const btn = (id) => target.closest(`#${id}`);

            if (btn('b64-encode-btn')) return void encodeAction();
            if (btn('b64-decode-btn')) return void decodeAction();
            if (btn('b64-swap-btn')) return void swapAction();
            if (btn('b64-clear-btn')) return void clearAction();
            if (btn('b64-copy-btn')) return void copyOutputAction();
            if (btn('b64-download-btn')) return void downloadAction();
            if (btn('b64-cancel-btn')) {
                try {
                    abortController?.abort();
                } catch {
                    // ignore
                }
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.id !== 'b64-input-file') return;

            const els = getElements();
            if (!els) return;

            const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
            if (file) {
                els.inputText.value = '';
                els.output.value = '';
                clearError(els);
            }
        });
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);
        clearError(els);
    }

    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }
})();
