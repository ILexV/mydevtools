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
                    <button class="btn btn-secondary btn-small" id="b32-cancel-btn">${escapeHtml(strings.cancel)}</button>
                </div>
                <div class="file-progress-meta">${escapeHtml(file.name)} • ${formatBytes(file.size)}</div>
                <progress id="b32-file-progress-bar" value="0" max="100"></progress>
                <div id="b32-file-progress-stats" class="file-progress-stats"></div>
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
            case 'crockford':
                return '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
            case 'zbase32':
                return 'ybndrfg8ejkmcpqxot1uwisza345h769';
            case 'rfc4648':
            default:
                return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        }
    }

    function makeDecodeMap(alphabet, caseMode) {
        // ASCII only map
        const map = new Int16Array(128);
        map.fill(-1);

        for (let i = 0; i < alphabet.length; i++) {
            const ch = alphabet[i];
            const code = ch.charCodeAt(0);
            if (code <= 127) map[code] = i;

            // case handling for letters
            const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
            if (!isLetter) continue;

            const upper = ch.toUpperCase();
            const lower = ch.toLowerCase();

            if (caseMode === 'upper') {
                const uc = upper.charCodeAt(0);
                if (uc <= 127) map[uc] = i;
            } else if (caseMode === 'lower') {
                const lc = lower.charCodeAt(0);
                if (lc <= 127) map[lc] = i;
            } else {
                const uc = upper.charCodeAt(0);
                const lc = lower.charCodeAt(0);
                if (uc <= 127) map[uc] = i;
                if (lc <= 127) map[lc] = i;
            }
        }

        // Crockford commonly accepts O->0, I/L->1
        if (alphabet === '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
            map['O'.charCodeAt(0)] = 0;
            map['o'.charCodeAt(0)] = 0;
            map['I'.charCodeAt(0)] = 1;
            map['i'.charCodeAt(0)] = 1;
            map['L'.charCodeAt(0)] = 1;
            map['l'.charCodeAt(0)] = 1;
        }

        return map;
    }

    function encodeBytesToBase32(bytes, alphabetName, paddingMode) {
        const alphabet = getAlphabet(alphabetName);
        let out = '';
        let buffer = 0;
        let bits = 0;

        for (let i = 0; i < bytes.length; i++) {
            buffer = (buffer << 8) | bytes[i];
            bits += 8;
            while (bits >= 5) {
                const idx = (buffer >> (bits - 5)) & 31;
                out += alphabet[idx];
                bits -= 5;
                buffer &= (1 << bits) - 1;
            }
        }

        if (bits > 0) {
            const idx = (buffer << (5 - bits)) & 31;
            out += alphabet[idx];
            bits = 0;
            buffer = 0;
        }

        if (paddingMode !== 'none') {
            const mod = out.length % 8;
            if (mod !== 0) out += '='.repeat(8 - mod);
        }

        return out;
    }

    function validateAndTrimPadding(text, paddingMode) {
        // returns { ok:true, dataText, padCount, totalChars } (total includes padding)
        const totalChars = text.length;

        let firstPad = text.indexOf('=');
        if (firstPad === -1) {
            if (paddingMode === 'required') {
                if (totalChars % 8 !== 0) return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 length (padding required)' } };
            } else {
                const rem = totalChars % 8;
                if (rem === 1 || rem === 3 || rem === 6) return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 length' } };
            }
            return { ok: true, dataText: text, padCount: 0, totalChars };
        }

        if (paddingMode === 'none') {
            return { ok: false, error: { index: firstPad, message: "Padding '=' is not allowed" } };
        }

        // must be only trailing
        for (let i = firstPad; i < text.length; i++) {
            if (text[i] !== '=') return { ok: false, error: { index: i, message: 'Invalid Base32 padding' } };
        }

        if (totalChars % 8 !== 0) {
            return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 length (padding)' } };
        }

        const padCount = totalChars - firstPad;
        if (![0, 1, 3, 4, 6].includes(padCount)) {
            return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 padding length' } };
        }

        const dataChars = totalChars - padCount;
        const mod = dataChars % 8;
        const expectedMod = (padCount === 6) ? 2 : (padCount === 4) ? 4 : (padCount === 3) ? 5 : (padCount === 1) ? 7 : 0;
        if (mod !== expectedMod) {
            return { ok: false, error: { index: firstPad, message: 'Invalid Base32 padding' } };
        }

        return { ok: true, dataText: text.slice(0, firstPad), padCount, totalChars };
    }

    function normalizeInputForDecode(input, allowWhitespace) {
        if (allowWhitespace) {
            let out = '';
            for (let i = 0; i < input.length; i++) {
                const ch = input[i];
                if (isWhitespace(ch)) continue;
                out += ch;
            }
            return { ok: true, text: out };
        }

        for (let i = 0; i < input.length; i++) {
            if (isWhitespace(input[i])) {
                return { ok: false, error: { index: i, message: `Whitespace not allowed at position ${i}` } };
            }
        }
        return { ok: true, text: input };
    }

    function decodeBase32ToBytes(input, alphabetName, paddingMode, caseMode, allowWhitespace) {
        const norm = normalizeInputForDecode(input, allowWhitespace);
        if (!norm.ok) return norm;

        const text = norm.text;
        const alphabet = getAlphabet(alphabetName);
        const map = makeDecodeMap(alphabet, caseMode);

        const pad = validateAndTrimPadding(text, paddingMode);
        if (!pad.ok) return pad;

        const dataText = pad.dataText;

        let out = [];
        let buffer = 0;
        let bits = 0;

        for (let i = 0; i < dataText.length; i++) {
            const ch = dataText[i];
            const code = ch.charCodeAt(0);
            const v = code <= 127 ? map[code] : -1;
            if (v < 0) {
                return { ok: false, error: { index: i, message: `Invalid Base32 character '${ch}' at position ${i}` } };
            }

            buffer = (buffer << 5) | v;
            bits += 5;
            while (bits >= 8) {
                bits -= 8;
                out.push((buffer >> bits) & 0xff);
                buffer &= (1 << bits) - 1;
            }
        }

        if (bits > 0) {
            // remaining bits must be zero
            if ((buffer & ((1 << bits) - 1)) !== 0) {
                return { ok: false, error: { index: dataText.length - 1, message: 'Invalid Base32 trailing bits' } };
            }
        }

        return { ok: true, bytes: new Uint8Array(out) };
    }

    async function encodeFileToBase32(file, alphabetName, paddingMode, outputMode, onProgress, signal) {
        const chunkSize = 1024 * 1024; // 1 MiB
        const total = file.size;
        let processed = 0;
        const start = performance.now();

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

            const fullLen = bytes.length - (bytes.length % 5);
            const toEncode = bytes.subarray(0, fullLen);
            const tailLen = bytes.length - fullLen;
            if (tailLen > 0) carry = bytes.subarray(fullLen);

            // For full blocks, never emit '='.
            const encoded = encodeBytesToBase32(toEncode, alphabetName, 'none');
            pushString(encoded);

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs, preview, previewTruncated });

            await new Promise(requestAnimationFrame);
        }

        if (carry.length > 0) {
            const tailEncoded = encodeBytesToBase32(carry, alphabetName, paddingMode === 'none' ? 'none' : 'required');
            // If padding optional, we emit padded for best compatibility.
            pushString(tailEncoded);
        }

        const fullText = parts.join('');
        const text = outputMode === 'full'
            ? fullText
            : (previewTruncated ? (preview + '\n…(preview truncated, use Download for full output)') : preview);

        return { text, blob: new Blob([fullText], { type: 'text/plain' }) };
    }

    async function decodeBase32FileToBytes(file, alphabetName, paddingMode, caseMode, allowWhitespace, onProgress, signal) {
        const chunkSize = 1024 * 1024; // 1 MiB
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        const alphabet = getAlphabet(alphabetName);
        const map = makeDecodeMap(alphabet, caseMode);
        const decoder = new TextDecoder('latin1');

        let buffer = 0;
        let bits = 0;

        let totalChars = 0; // non-whitespace chars including '='
        let dataChars = 0;  // before '='
        let padCount = 0;
        let sawPadding = false;

        const outChunks = [];
        let outChunk = new Uint8Array(1024 * 1024);
        let outPos = 0;

        function pushByte(b) {
            if (outPos >= outChunk.length) {
                outChunks.push(outChunk.subarray(0, outPos));
                outChunk = new Uint8Array(1024 * 1024);
                outPos = 0;
            }
            outChunk[outPos++] = b;
        }

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const text = decoder.decode(bytes, { stream: true });

            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                if (isWhitespace(ch)) {
                    if (!allowWhitespace) {
                        return { ok: false, error: { index: totalChars, message: 'Whitespace not allowed' } };
                    }
                    continue;
                }

                totalChars++;

                if (ch === '=') {
                    if (paddingMode === 'none') {
                        return { ok: false, error: { index: totalChars - 1, message: "Padding '=' is not allowed" } };
                    }
                    sawPadding = true;
                    padCount++;
                    if (padCount > 6) {
                        return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 padding' } };
                    }
                    continue;
                }

                if (sawPadding) {
                    return { ok: false, error: { index: totalChars - 1, message: 'Data after padding' } };
                }

                dataChars++;
                const code = ch.charCodeAt(0);
                const v = code <= 127 ? map[code] : -1;
                if (v < 0) {
                    return { ok: false, error: { index: totalChars - 1, message: `Invalid Base32 character '${ch}'` } };
                }

                buffer = (buffer << 5) | v;
                bits += 5;
                while (bits >= 8) {
                    bits -= 8;
                    pushByte((buffer >> bits) & 0xff);
                    buffer &= (1 << bits) - 1;
                }
            }

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs });
            await new Promise(requestAnimationFrame);
        }

        // validate padding/length
        if (padCount > 0) {
            if (paddingMode === 'none') {
                return { ok: false, error: { index: totalChars - 1, message: "Padding '=' is not allowed" } };
            }
            if (totalChars % 8 !== 0) {
                return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 length (padding)' } };
            }
            if (![1, 3, 4, 6].includes(padCount)) {
                return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 padding length' } };
            }
            const mod = dataChars % 8;
            const expectedMod = (padCount === 6) ? 2 : (padCount === 4) ? 4 : (padCount === 3) ? 5 : 7;
            if (mod !== expectedMod) {
                return { ok: false, error: { index: totalChars - padCount, message: 'Invalid Base32 padding' } };
            }
        } else {
            if (paddingMode === 'required') {
                if (totalChars % 8 !== 0) {
                    return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 length (padding required)' } };
                }
            } else {
                const rem = totalChars % 8;
                if (rem === 1 || rem === 3 || rem === 6) {
                    return { ok: false, error: { index: totalChars - 1, message: 'Invalid Base32 length' } };
                }
            }
        }

        if (bits > 0) {
            if ((buffer & ((1 << bits) - 1)) !== 0) {
                return { ok: false, error: { index: Math.max(0, totalChars - 1), message: 'Invalid Base32 trailing bits' } };
            }
        }

        if (outPos > 0) outChunks.push(outChunk.subarray(0, outPos));
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
        const root = document.getElementById('base32-encoder-root');
        if (!root) return null;

        const inputText = document.getElementById('b32-input-text');
        const inputFile = document.getElementById('b32-input-file');
        const output = document.getElementById('b32-output');
        const outputSection = document.getElementById('b32-output-section');

        const charset = document.getElementById('b32-charset');
        const alphabet = document.getElementById('b32-alphabet');
        const padding = document.getElementById('b32-padding');
        const caseMode = document.getElementById('b32-case');
        const allowWs = document.getElementById('b32-allow-whitespace');
        const outputMode = document.getElementById('b32-output-mode');

        const encodeBtn = document.getElementById('b32-encode-btn');
        const decodeBtn = document.getElementById('b32-decode-btn');
        const swapBtn = document.getElementById('b32-swap-btn');
        const clearBtn = document.getElementById('b32-clear-btn');
        const copyBtn = document.getElementById('b32-copy-btn');
        const downloadBtn = document.getElementById('b32-download-btn');
        const errorEl = document.getElementById('b32-error');

        if (!inputText || !inputFile || !output || !outputSection || !charset || !alphabet || !padding || !caseMode || !allowWs || !outputMode || !encodeBtn || !decodeBtn || !swapBtn || !clearBtn || !copyBtn || !downloadBtn || !errorEl) {
            return null;
        }

        return { root, inputText, inputFile, output, outputSection, charset, alphabet, padding, caseMode, allowWs, outputMode, encodeBtn, decodeBtn, swapBtn, clearBtn, copyBtn, downloadBtn, errorEl };
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
        const alphabetName = String(els.alphabet.value || 'rfc4648');
        const paddingMode = String(els.padding.value || 'required');
        const outputMode = String(els.outputMode.value || 'preview');

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('b32-file-progress-bar');
                const progressStats = document.getElementById('b32-file-progress-stats');

                let result;
                try {
                    result = await encodeFileToBase32(
                        file,
                        alphabetName,
                        paddingMode,
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
                setLastDownload(els2.root, result.blob, `${file.name}.b32`);
            } else {
                const text = els.inputText.value || '';
                const enc = encodeTextToBytes(text, charset);
                if (!enc.ok) {
                    setError(els, enc.error.message, enc.error.index);
                    return;
                }

                const out = encodeBytesToBase32(enc.bytes, alphabetName, paddingMode);
                els.output.value = out;
                setLastDownload(els.root, new Blob([out], { type: 'text/plain' }), 'text.b32');
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
        const alphabetName = String(els.alphabet.value || 'rfc4648');
        const paddingMode = String(els.padding.value || 'required');
        const caseMode = String(els.caseMode.value || 'auto');
        const allowWhitespace = !!els.allowWs.checked;

        els.encodeBtn.disabled = true;
        els.decodeBtn.disabled = true;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('b32-file-progress-bar');
                const progressStats = document.getElementById('b32-file-progress-stats');

                let decoded;
                try {
                    decoded = await decodeBase32FileToBytes(
                        file,
                        alphabetName,
                        paddingMode,
                        caseMode,
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
                const parsed = decodeBase32ToBytes(input, alphabetName, paddingMode, caseMode, allowWhitespace);
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
        if (window.__mydevtools_base32_encoder_bound) return;
        window.__mydevtools_base32_encoder_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'b32-encode-btn') return void encodeAction();
            if (target.id === 'b32-decode-btn') return void decodeAction();
            if (target.id === 'b32-swap-btn') return void swapAction();
            if (target.id === 'b32-clear-btn') return void clearAction();
            if (target.id === 'b32-copy-btn') return void copyOutputAction();
            if (target.id === 'b32-download-btn') return void downloadAction();
            if (target.id === 'b32-cancel-btn') {
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
            if (target.id !== 'b32-input-file') return;

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
