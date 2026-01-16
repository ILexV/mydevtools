/* global document, window */

(function () {
    const initializedRoots = new WeakSet();

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
                    <button class="btn btn-secondary btn-small" id="b58-cancel-btn">${escapeHtml(strings.cancel)}</button>
                </div>
                <div class="file-progress-meta">${escapeHtml(file.name)} • ${formatBytes(file.size)}</div>
                <progress id="b58-file-progress-bar" value="0" max="100"></progress>
                <div id="b58-file-progress-stats" class="file-progress-stats"></div>
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

    function encodeTextToBytes(text, charset) {
        switch (charset) {
            case 'utf-8':
                return { ok: true, bytes: new TextEncoder().encode(text) };
            case 'utf-16le': {
                const bytes = new Uint8Array(text.length * 2);
                for (let i = 0; i < text.length; i++) {
                    const cu = text.charCodeAt(i);
                    bytes[i * 2] = cu & 0xff;
                    bytes[i * 2 + 1] = (cu >> 8) & 0xff;
                }
                return { ok: true, bytes };
            }
            case 'utf-16be': {
                const bytes = new Uint8Array(text.length * 2);
                for (let i = 0; i < text.length; i++) {
                    const cu = text.charCodeAt(i);
                    bytes[i * 2] = (cu >> 8) & 0xff;
                    bytes[i * 2 + 1] = cu & 0xff;
                }
                return { ok: true, bytes };
            }
            case 'ascii':
                return encodeAsciiLike(text, 0x7f, 'Non-ASCII character');
            case 'latin1':
                return encodeAsciiLike(text, 0xff, 'Character not representable in Latin-1');
            default:
                return { ok: false, error: { index: 0, message: `Unsupported charset: ${charset}` } };
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

    function decodeBytesToText(bytes, charset) {
        switch (charset) {
            case 'utf-8':
                return decodeUtf8Strict(bytes);
            case 'utf-16le': {
                if (bytes.length % 2 !== 0) return { ok: false, error: { byteIndex: bytes.length - 1, message: 'Odd number of bytes for UTF-16LE' } };
                let out = '';
                for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
                return { ok: true, text: out };
            }
            case 'utf-16be': {
                if (bytes.length % 2 !== 0) return { ok: false, error: { byteIndex: bytes.length - 1, message: 'Odd number of bytes for UTF-16BE' } };
                let out = '';
                for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
                return { ok: true, text: out };
            }
            case 'ascii': {
                for (let i = 0; i < bytes.length; i++) {
                    if (bytes[i] > 0x7f) return { ok: false, error: { byteIndex: i, message: 'Byte not representable in ASCII' } };
                }
                return { ok: true, text: String.fromCharCode(...bytes) };
            }
            case 'latin1':
                return { ok: true, text: String.fromCharCode(...bytes) };
            default:
                return { ok: false, error: { byteIndex: 0, message: `Unsupported charset: ${charset}` } };
        }
    }

    function getAlphabet(name) {
        switch (name) {
            case 'flickr':
                return '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
            case 'ripple':
                return 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdefghijkmnpqtuvAxyz';
            case 'bitcoin':
            default:
                return '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        }
    }

    function makeDecodeMap(alphabet) {
        const map = new Int16Array(128);
        map.fill(-1);
        for (let i = 0; i < alphabet.length; i++) {
            const code = alphabet.charCodeAt(i);
            if (code <= 127) map[code] = i;
        }
        return map;
    }

    function createEncodeState(alphabet) {
        return {
            alphabet,
            leadingZeros: 0,
            seenNonZero: false,
            // base58 digits, little-endian (least significant digit first)
            digits: []
        };
    }

    function updateEncodeState(state, bytes) {
        const digits = state.digits;
        for (let bi = 0; bi < bytes.length; bi++) {
            const b = bytes[bi];
            if (!state.seenNonZero) {
                if (b === 0) {
                    state.leadingZeros++;
                    continue;
                }
                state.seenNonZero = true;
            }

            let carry = b;
            for (let di = 0; di < digits.length; di++) {
                carry += digits[di] * 256;
                digits[di] = carry % 58;
                carry = (carry / 58) | 0;
            }
            while (carry > 0) {
                digits.push(carry % 58);
                carry = (carry / 58) | 0;
            }
        }
    }

    function finalizeEncode(state) {
        const { alphabet, leadingZeros, digits } = state;
        if (leadingZeros === 0 && digits.length === 0) return '';

        const parts = [];
        if (leadingZeros > 0) parts.push(alphabet[0].repeat(leadingZeros));

        const chunkSize = 1_000_000;
        let chunk = '';
        for (let i = digits.length - 1; i >= 0; i--) {
            chunk += alphabet[digits[i]];
            if (chunk.length >= chunkSize) {
                parts.push(chunk);
                chunk = '';
            }
        }
        if (chunk.length > 0) parts.push(chunk);
        return parts.join('');
    }

    function decodeBase58ToBytes(input, alphabetName, allowWhitespace) {
        const alphabet = getAlphabet(alphabetName);
        const map = makeDecodeMap(alphabet);
        const zeroChar = alphabet[0];

        // base256 bytes, little-endian
        const bytes = [];
        let leadingZeros = 0;
        let started = false;

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (isWhitespace(ch)) {
                if (allowWhitespace) continue;
                return { ok: false, error: { index: i, message: `Whitespace not allowed at position ${i}` } };
            }

            if (!started) {
                if (ch === zeroChar) {
                    leadingZeros++;
                    continue;
                }
                started = true;
            }

            const code = ch.charCodeAt(0);
            const v = code <= 127 ? map[code] : -1;
            if (v < 0) {
                return { ok: false, error: { index: i, message: `Invalid Base58 character '${ch}' at position ${i}` } };
            }

            let carry = v;
            for (let bi = 0; bi < bytes.length; bi++) {
                carry += bytes[bi] * 58;
                bytes[bi] = carry & 0xff;
                carry >>= 8;
            }
            while (carry > 0) {
                bytes.push(carry & 0xff);
                carry >>= 8;
            }
        }

        const out = new Uint8Array(leadingZeros + bytes.length);
        for (let i = 0; i < leadingZeros; i++) out[i] = 0;
        for (let i = 0; i < bytes.length; i++) out[leadingZeros + i] = bytes[bytes.length - 1 - i];
        return { ok: true, bytes: out };
    }

    async function encodeFileToBase58(file, alphabetName, outputMode, onProgress, signal) {
        const alphabet = getAlphabet(alphabetName);
        const state = createEncodeState(alphabet);

        const chunkSize = 1024 * 1024;
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            updateEncodeState(state, new Uint8Array(buf));

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs });
            await new Promise(requestAnimationFrame);
        }

        const fullText = finalizeEncode(state);
        const previewCharLimit = 200_000;
        const preview = fullText.length > previewCharLimit
            ? (fullText.slice(0, previewCharLimit) + '\n…(preview truncated, use Download for full output)')
            : fullText;

        return {
            text: outputMode === 'full' ? fullText : preview,
            blob: new Blob([fullText], { type: 'text/plain' })
        };
    }

    async function decodeBase58FileToBytes(file, alphabetName, allowWhitespace, onProgress, signal) {
        const alphabet = getAlphabet(alphabetName);
        const map = makeDecodeMap(alphabet);
        const zeroChar = alphabet[0];

        const chunkSize = 1024 * 1024;
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        const decoder = new TextDecoder('latin1');

        // base256 bytes, little-endian
        const bytes = [];
        let leadingZeros = 0;
        let started = false;
        let fileCharOffset = 0; // absolute char offset in decoded text stream

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            const text = decoder.decode(new Uint8Array(buf), { stream: true });

            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                const absoluteIndex = fileCharOffset;
                fileCharOffset++;

                if (isWhitespace(ch)) {
                    if (allowWhitespace) continue;
                    return { ok: false, error: { index: absoluteIndex, message: 'Whitespace not allowed' } };
                }

                if (!started) {
                    if (ch === zeroChar) {
                        leadingZeros++;
                        continue;
                    }
                    started = true;
                }

                const code = ch.charCodeAt(0);
                const v = code <= 127 ? map[code] : -1;
                if (v < 0) {
                    return { ok: false, error: { index: absoluteIndex, message: `Invalid Base58 character '${ch}'` } };
                }

                let carry = v;
                for (let bi = 0; bi < bytes.length; bi++) {
                    carry += bytes[bi] * 58;
                    bytes[bi] = carry & 0xff;
                    carry >>= 8;
                }
                while (carry > 0) {
                    bytes.push(carry & 0xff);
                    carry >>= 8;
                }
            }

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs });
            await new Promise(requestAnimationFrame);
        }

        const out = new Uint8Array(leadingZeros + bytes.length);
        for (let i = 0; i < leadingZeros; i++) out[i] = 0;
        for (let i = 0; i < bytes.length; i++) out[leadingZeros + i] = bytes[bytes.length - 1 - i];
        return { ok: true, blob: new Blob([out], { type: 'application/octet-stream' }) };
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
        const root = document.getElementById('base58-encoder-root');
        if (!root) return null;

        const inputText = document.getElementById('b58-input-text');
        const inputFile = document.getElementById('b58-input-file');
        const output = document.getElementById('b58-output');
        const outputSection = document.getElementById('b58-output-section');

        const charset = document.getElementById('b58-charset');
        const alphabet = document.getElementById('b58-alphabet');
        const allowWs = document.getElementById('b58-allow-whitespace');
        const outputMode = document.getElementById('b58-output-mode');

        const encodeBtn = document.getElementById('b58-encode-btn');
        const decodeBtn = document.getElementById('b58-decode-btn');
        const swapBtn = document.getElementById('b58-swap-btn');
        const clearBtn = document.getElementById('b58-clear-btn');
        const copyBtn = document.getElementById('b58-copy-btn');
        const downloadBtn = document.getElementById('b58-download-btn');
        const errorEl = document.getElementById('b58-error');

        if (!inputText || !inputFile || !output || !outputSection || !charset || !alphabet || !allowWs || !outputMode || !encodeBtn || !decodeBtn || !swapBtn || !clearBtn || !copyBtn || !downloadBtn || !errorEl) {
            return null;
        }

        return { root, inputText, inputFile, output, outputSection, charset, alphabet, allowWs, outputMode, encodeBtn, decodeBtn, swapBtn, clearBtn, copyBtn, downloadBtn, errorEl };
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
        const alphabetName = String(els.alphabet.value || 'bitcoin');
        const outputMode = String(els.outputMode.value || 'preview');

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('b58-file-progress-bar');
                const progressStats = document.getElementById('b58-file-progress-stats');

                let result;
                try {
                    result = await encodeFileToBase58(
                        file,
                        alphabetName,
                        outputMode,
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

                const els2 = getElements();
                if (!els2) return;
                els2.output.value = result.text;
                setLastDownload(els2.root, result.blob, `${file.name}.b58`);
            } else {
                const text = els.inputText.value || '';
                const enc = encodeTextToBytes(text, charset);
                if (!enc.ok) {
                    setError(els, enc.error.message, enc.error.index);
                    return;
                }

                const alphabet = getAlphabet(alphabetName);
                const st = createEncodeState(alphabet);
                updateEncodeState(st, enc.bytes);
                const out = finalizeEncode(st);
                els.output.value = out;
                setLastDownload(els.root, new Blob([out], { type: 'text/plain' }), 'text.b58');
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
        const alphabetName = String(els.alphabet.value || 'bitcoin');
        const allowWhitespace = !!els.allowWs.checked;

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('b58-file-progress-bar');
                const progressStats = document.getElementById('b58-file-progress-stats');

                let decoded;
                try {
                    decoded = await decodeBase58FileToBytes(
                        file,
                        alphabetName,
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
                const parsed = decodeBase58ToBytes(input, alphabetName, allowWhitespace);
                if (!parsed.ok) {
                    setError(els, parsed.error.message, parsed.error.index);
                    return;
                }

                const text = decodeBytesToText(parsed.bytes, charset);
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
        if (window.__mydevtools_base58_encoder_bound) return;
        window.__mydevtools_base58_encoder_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'b58-encode-btn') return void encodeAction();
            if (target.id === 'b58-decode-btn') return void decodeAction();
            if (target.id === 'b58-swap-btn') return void swapAction();
            if (target.id === 'b58-clear-btn') return void clearAction();
            if (target.id === 'b58-copy-btn') return void copyOutputAction();
            if (target.id === 'b58-download-btn') return void downloadAction();
            if (target.id === 'b58-cancel-btn') {
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
            if (target.id !== 'b58-input-file') return;

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
