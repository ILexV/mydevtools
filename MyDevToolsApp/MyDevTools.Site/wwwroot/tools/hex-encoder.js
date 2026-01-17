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
        // IMPORTANT: don't permanently wipe the output UI.
        // We replace the section temporarily, but keep the original markup so we can restore it.
        if (!outputSection.dataset.originalHtml) {
            outputSection.dataset.originalHtml = outputSection.innerHTML;
        }
        outputSection.innerHTML = `
            <div class="file-progress">
                <div class="file-progress-header">
                    <div class="file-progress-title">${escapeHtml(strings.fileProgressTitle)}</div>
                    <button class="btn btn-secondary btn-small" id="hex-cancel-btn">${escapeHtml(strings.cancel)}</button>
                </div>
                <div class="file-progress-meta">${escapeHtml(file.name)} • ${formatBytes(file.size)}</div>
                <progress id="hex-file-progress-bar" value="0" max="100"></progress>
                <div id="hex-file-progress-stats" class="file-progress-stats"></div>
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

    function isSeparator(ch) {
        return ch === ':' || ch === '-';
    }

    function isHexDigit(ch) {
        const c = ch.charCodeAt(0);
        return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    }

    function hexValue(ch) {
        const c = ch.charCodeAt(0);
        if (c >= 48 && c <= 57) return c - 48;
        if (c >= 65 && c <= 70) return c - 65 + 10;
        if (c >= 97 && c <= 102) return c - 97 + 10;
        return -1;
    }

    function makeHexLut(upper) {
        const digits = upper ? '0123456789ABCDEF' : '0123456789abcdef';
        const lut = new Array(256);
        for (let i = 0; i < 256; i++) {
            lut[i] = digits[(i >> 4) & 0x0f] + digits[i & 0x0f];
        }
        return lut;
    }

    async function bytesToHex(bytes, upper) {
        const wasm = await getEncodingWasm();
        return wasm.hex_encode(bytes, upper);
    }

    function encodeAsciiLike(str, maxCodePoint, errorLabel) {
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) {
            const codeUnit = str.charCodeAt(i);
            if (codeUnit > maxCodePoint) {
                return { ok: false, error: { index: i, message: `${errorLabel} at position ${i}` } };
            }
            bytes[i] = codeUnit & 0xff;
        }
        return { ok: true, bytes };
    }

    async function encodeTextToBytes(text, charset) {
        try {
            const wasm = await getEncodingWasm();
            const bytes = wasm.encode_text_to_bytes(text, charset);
            return { ok: true, bytes: new Uint8Array(bytes) };
        } catch (err) {
            const msg = err?.message || String(err);
            const indexMatch = msg.match(/position (\d+)/);
            const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;
            return { ok: false, error: { index, message: msg } };
        }
    }

    function decodeUtf8Strict(bytes) {
        let out = '';
        let i = 0;
        while (i < bytes.length) {
            const b0 = bytes[i];
            if (b0 <= 0x7f) {
                out += String.fromCharCode(b0);
                i += 1;
                continue;
            }

            if (b0 >= 0xc2 && b0 <= 0xdf) {
                if (i + 1 >= bytes.length) return { ok: false, error: { byteIndex: i, message: 'Truncated UTF-8 sequence' } };
                const b1 = bytes[i + 1];
                if ((b1 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 1, message: 'Invalid UTF-8 continuation byte' } };
                const cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
                out += String.fromCharCode(cp);
                i += 2;
                continue;
            }

            if (b0 >= 0xe0 && b0 <= 0xef) {
                if (i + 2 >= bytes.length) return { ok: false, error: { byteIndex: i, message: 'Truncated UTF-8 sequence' } };
                const b1 = bytes[i + 1];
                const b2 = bytes[i + 2];
                if ((b1 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 1, message: 'Invalid UTF-8 continuation byte' } };
                if ((b2 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 2, message: 'Invalid UTF-8 continuation byte' } };
                if (b0 === 0xe0 && b1 < 0xa0) return { ok: false, error: { byteIndex: i, message: 'Overlong UTF-8 sequence' } };
                if (b0 === 0xed && b1 >= 0xa0) return { ok: false, error: { byteIndex: i, message: 'UTF-8 surrogate code point' } };
                const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
                out += String.fromCharCode(cp);
                i += 3;
                continue;
            }

            if (b0 >= 0xf0 && b0 <= 0xf4) {
                if (i + 3 >= bytes.length) return { ok: false, error: { byteIndex: i, message: 'Truncated UTF-8 sequence' } };
                const b1 = bytes[i + 1];
                const b2 = bytes[i + 2];
                const b3 = bytes[i + 3];
                if ((b1 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 1, message: 'Invalid UTF-8 continuation byte' } };
                if ((b2 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 2, message: 'Invalid UTF-8 continuation byte' } };
                if ((b3 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 3, message: 'Invalid UTF-8 continuation byte' } };
                if (b0 === 0xf0 && b1 < 0x90) return { ok: false, error: { byteIndex: i, message: 'Overlong UTF-8 sequence' } };
                if (b0 === 0xf4 && b1 > 0x8f) return { ok: false, error: { byteIndex: i, message: 'UTF-8 code point out of range' } };

                let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
                cp -= 0x10000;
                out += String.fromCharCode(0xd800 + ((cp >> 10) & 0x3ff), 0xdc00 + (cp & 0x3ff));
                i += 4;
                continue;
            }

            return { ok: false, error: { byteIndex: i, message: 'Invalid UTF-8 leading byte' } };
        }

        return { ok: true, text: out };
    }

    async function decodeBytesToText(bytes, charset) {
        try {
            const wasm = await getEncodingWasm();
            const text = wasm.decode_bytes_to_text(bytes, charset);
            return { ok: true, text };
        } catch (err) {
            const msg = err?.message || String(err);
            const byteIndexMatch = msg.match(/byte (\d+)/i) || msg.match(/position (\d+)/);
            const byteIndex = byteIndexMatch ? parseInt(byteIndexMatch[1], 10) : 0;
            return { ok: false, error: { byteIndex, message: msg } };
        }
    }

    async function parseHexToBytes(input, options) {
        try {
            const wasm = await getEncodingWasm();
            const bytes = wasm.hex_decode(input, options.ignoreWhitespace, options.allowSeparators, options.allow0x);
            return { ok: true, bytes: new Uint8Array(bytes) };
        } catch (err) {
            const msg = err?.message || String(err);
            const indexMatch = msg.match(/position (\d+)/);
            const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;
            return { ok: false, error: { index, message: msg } };
        }
    }

    async function encodeFileToHex(file, upper, outputMode, onProgress, signal) {
        const wasm = await getEncodingWasm();
        const chunkSize = 1024 * 1024; // 1 MiB
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        const parts = [];

        // For preview in textarea: limit to first N chars to keep DOM responsive.
        const previewCharLimit = 200_000;
        let preview = '';
        let previewTruncated = false;

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            const bytes = new Uint8Array(buf);

            const s = wasm.hex_encode(bytes, upper);

            if (outputMode === 'full') {
                parts.push(s);
            } else {
                // preview
                if (!previewTruncated) {
                    const remaining = previewCharLimit - preview.length;
                    if (remaining > 0) {
                        preview += s.slice(0, remaining);
                        if (s.length > remaining) previewTruncated = true;
                    } else {
                        previewTruncated = true;
                    }
                }
                parts.push(s); // still keep full content for download
            }

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs, preview, previewTruncated });

            await new Promise(requestAnimationFrame);
        }

        return { text: outputMode === 'full' ? parts.join('') : (previewTruncated ? (preview + '\n…(preview truncated, use Download for full output)') : preview), blob: new Blob(parts, { type: 'text/plain' }) };
    }

    async function decodeHexFileToBytes(file, options, onProgress, signal) {
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
                    const decoded = wasm.hex_decode(accumulatedText, options.ignoreWhitespace, options.allowSeparators, options.allow0x);
                    outChunks.push(new Uint8Array(decoded));
                    accumulatedText = '';
                } catch (err) {
                    const msg = err?.message || String(err);
                    const indexMatch = msg.match(/position (\d+)/);
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
                const decoded = wasm.hex_decode(accumulatedText, options.ignoreWhitespace, options.allowSeparators, options.allow0x);
                outChunks.push(new Uint8Array(decoded));
            } catch (err) {
                const msg = err?.message || String(err);
                const indexMatch = msg.match(/position (\d+)/);
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
        const root = document.getElementById('hex-encoder-root');
        if (!root) return null;

        const inputText = document.getElementById('hex-input-text');
        const inputFile = document.getElementById('hex-input-file');
        const output = document.getElementById('hex-output');
        const outputSection = document.getElementById('hex-output-section');

        const charset = document.getElementById('hex-charset');
        const hexCase = document.getElementById('hex-case');
        const ignoreWs = document.getElementById('hex-ignore-whitespace');
        const allowSep = document.getElementById('hex-allow-separators');
        const allow0x = document.getElementById('hex-allow-0x');
        const outputMode = document.getElementById('hex-output-mode');

        const encodeBtn = document.getElementById('hex-encode-btn');
        const decodeBtn = document.getElementById('hex-decode-btn');
        const swapBtn = document.getElementById('hex-swap-btn');
        const clearBtn = document.getElementById('hex-clear-btn');
        const copyBtn = document.getElementById('hex-copy-btn');
        const downloadBtn = document.getElementById('hex-download-btn');
        const errorEl = document.getElementById('hex-error');

        if (!inputText || !inputFile || !output || !outputSection || !charset || !hexCase || !ignoreWs || !allowSep || !allow0x || !outputMode || !encodeBtn || !decodeBtn || !swapBtn || !clearBtn || !copyBtn || !downloadBtn || !errorEl) {
            return null;
        }

        return { root, inputText, inputFile, output, outputSection, charset, hexCase, ignoreWs, allowSep, allow0x, outputMode, encodeBtn, decodeBtn, swapBtn, clearBtn, copyBtn, downloadBtn, errorEl };
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
        const upper = String(els.hexCase.value || 'lower') === 'upper';
        const outputMode = String(els.outputMode.value || 'preview');

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('hex-file-progress-bar');
                const progressStats = document.getElementById('hex-file-progress-stats');

                let result;
                try {
                    result = await encodeFileToHex(
                        file,
                        upper,
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
                    // Always restore the output UI (success/error/cancel).
                    restoreOutputSection(els.outputSection);
                }

                const els2 = getElements();
                if (!els2) return;
                els2.output.value = result.text;
                setLastDownload(els2.root, result.blob, `${file.name}.hex`);
            } else {
                const text = els.inputText.value || '';
                const enc = await encodeTextToBytes(text, charset);
                if (!enc.ok) {
                    setError(els, enc.error.message, enc.error.index);
                    return;
                }

                const out = await bytesToHex(enc.bytes, upper);
                els.output.value = out;
                setLastDownload(els.root, new Blob([out], { type: 'text/plain' }), 'text.hex');
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

        const options = {
            ignoreWhitespace: !!els.ignoreWs.checked,
            allowSeparators: !!els.allowSep.checked,
            allow0x: !!els.allow0x.checked
        };

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('hex-file-progress-bar');
                const progressStats = document.getElementById('hex-file-progress-stats');

                let decoded;
                try {
                    decoded = await decodeHexFileToBytes(
                        file,
                        options,
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
                        setError(els2, decoded.error.message, null);
                    }
                    return;
                }

                const els2 = getElements();
                if (!els2) return;
                els2.output.value = `Decoded ${file.name} → ${file.name}.bin`;
                setLastDownload(els2.root, decoded.blob, `${file.name}.bin`);
            } else {
                const input = els.inputText.value || '';
                const parsed = await parseHexToBytes(input, options);
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
        if (window.__mydevtools_hex_encoder_bound) return;
        window.__mydevtools_hex_encoder_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'hex-encode-btn') return void encodeAction();
            if (target.id === 'hex-decode-btn') return void decodeAction();
            if (target.id === 'hex-swap-btn') return void swapAction();
            if (target.id === 'hex-clear-btn') return void clearAction();
            if (target.id === 'hex-copy-btn') return void copyOutputAction();
            if (target.id === 'hex-download-btn') return void downloadAction();
            if (target.id === 'hex-cancel-btn') {
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
            if (target.id !== 'hex-input-file') return;

            const els = getElements();
            if (!els) return;

            const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
            if (file) {
                // Mirror HashCalculator behavior: selecting a file clears text.
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
