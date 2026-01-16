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
        return name === 'urlsafe'
            ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
            : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    }

    function makeDecodeMap(alphabet) {
        const map = new Int16Array(128);
        map.fill(-1);
        for (let i = 0; i < alphabet.length; i++) {
            map[alphabet.charCodeAt(i)] = i;
        }
        return map;
    }

    function encodeBytesToBase64(bytes, alphabetName, paddingMode, lineWrap) {
        const alphabet = getAlphabet(alphabetName);
        const wrapAt = lineWrap === 76 ? 76 : 0;
        let out = '';
        let lineLen = 0;

        function pushChar(ch) {
            out += ch;
            if (wrapAt > 0) {
                lineLen++;
                if (lineLen >= wrapAt) {
                    out += '\n';
                    lineLen = 0;
                }
            }
        }

        let i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
            pushChar(alphabet[(n >> 18) & 63]);
            pushChar(alphabet[(n >> 12) & 63]);
            pushChar(alphabet[(n >> 6) & 63]);
            pushChar(alphabet[n & 63]);
        }

        const remaining = bytes.length - i;
        if (remaining === 1) {
            const n = bytes[i] << 16;
            pushChar(alphabet[(n >> 18) & 63]);
            pushChar(alphabet[(n >> 12) & 63]);
            if (paddingMode === 'none') {
                // no '='
            } else {
                pushChar('=');
                pushChar('=');
            }
        } else if (remaining === 2) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
            pushChar(alphabet[(n >> 18) & 63]);
            pushChar(alphabet[(n >> 12) & 63]);
            pushChar(alphabet[(n >> 6) & 63]);
            if (paddingMode === 'none') {
                // no '='
            } else {
                pushChar('=');
            }
        }

        // trim trailing newline for wrapped output
        if (wrapAt > 0 && out.endsWith('\n')) out = out.slice(0, -1);
        return out;
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

    function decodeBase64ToBytes(input, alphabetName, paddingMode, allowWhitespace) {
        const norm = normalizeInputForDecode(input, allowWhitespace);
        if (!norm.ok) return norm;

        const text = norm.text;
        const alphabet = getAlphabet(alphabetName);
        const map = makeDecodeMap(alphabet);

        let effective = text;
        if (paddingMode === 'none') {
            if (effective.includes('=')) {
                return { ok: false, error: { index: effective.indexOf('='), message: "Padding '=' is not allowed" } };
            }
        }

        const len = effective.length;
        const rem = len % 4;
        if (paddingMode === 'required') {
            if (rem !== 0) return { ok: false, error: { index: len - 1, message: 'Invalid Base64 length (padding required)' } };
        }
        if (paddingMode === 'none') {
            if (rem === 1) return { ok: false, error: { index: len - 1, message: 'Invalid Base64 length' } };
        }
        if (paddingMode === 'optional') {
            if (rem === 1) return { ok: false, error: { index: len - 1, message: 'Invalid Base64 length' } };
        }

        const out = [];
        let i = 0;

        function valAt(pos) {
            const ch = effective[pos];
            if (ch === '=') return -2;
            const code = ch.charCodeAt(0);
            if (code > 127) return -1;
            return map[code];
        }

        // process full quartets
        while (i + 3 < len) {
            const v0 = valAt(i);
            const v1 = valAt(i + 1);
            const v2 = valAt(i + 2);
            const v3 = valAt(i + 3);

            if (v0 < 0) return { ok: false, error: { index: i, message: `Invalid Base64 character '${effective[i]}' at position ${i}` } };
            if (v1 < 0) return { ok: false, error: { index: i + 1, message: `Invalid Base64 character '${effective[i + 1]}' at position ${i + 1}` } };

            if (v2 === -2) {
                // xx==
                if (v3 !== -2) return { ok: false, error: { index: i + 3, message: 'Invalid Base64 padding' } };
                out.push(((v0 << 2) | (v1 >> 4)) & 0xff);
                // must be last quartet
                if (i + 4 !== len) return { ok: false, error: { index: i + 4, message: 'Data after padding' } };
                break;
            }

            if (v2 < 0) return { ok: false, error: { index: i + 2, message: `Invalid Base64 character '${effective[i + 2]}' at position ${i + 2}` } };

            if (v3 === -2) {
                // xxx=
                out.push(((v0 << 2) | (v1 >> 4)) & 0xff);
                out.push((((v1 & 0x0f) << 4) | (v2 >> 2)) & 0xff);
                if (i + 4 !== len) return { ok: false, error: { index: i + 4, message: 'Data after padding' } };
                break;
            }

            if (v3 < 0) return { ok: false, error: { index: i + 3, message: `Invalid Base64 character '${effective[i + 3]}' at position ${i + 3}` } };

            const n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
            out.push((n >> 16) & 0xff);
            out.push((n >> 8) & 0xff);
            out.push(n & 0xff);

            i += 4;
        }

        // handle non-padded tail (optional/none)
        if (i < len && paddingMode !== 'required') {
            const remaining = len - i;
            if (remaining === 2) {
                const v0 = valAt(i);
                const v1 = valAt(i + 1);
                if (v0 < 0) return { ok: false, error: { index: i, message: `Invalid Base64 character '${effective[i]}' at position ${i}` } };
                if (v1 < 0) return { ok: false, error: { index: i + 1, message: `Invalid Base64 character '${effective[i + 1]}' at position ${i + 1}` } };
                out.push(((v0 << 2) | (v1 >> 4)) & 0xff);
            } else if (remaining === 3) {
                const v0 = valAt(i);
                const v1 = valAt(i + 1);
                const v2 = valAt(i + 2);
                if (v0 < 0) return { ok: false, error: { index: i, message: `Invalid Base64 character '${effective[i]}' at position ${i}` } };
                if (v1 < 0) return { ok: false, error: { index: i + 1, message: `Invalid Base64 character '${effective[i + 1]}' at position ${i + 1}` } };
                if (v2 < 0) return { ok: false, error: { index: i + 2, message: `Invalid Base64 character '${effective[i + 2]}' at position ${i + 2}` } };
                out.push(((v0 << 2) | (v1 >> 4)) & 0xff);
                out.push((((v1 & 0x0f) << 4) | (v2 >> 2)) & 0xff);
            } else if (remaining === 1) {
                return { ok: false, error: { index: len - 1, message: 'Invalid Base64 length' } };
            }
        }

        return { ok: true, bytes: new Uint8Array(out) };
    }

    async function encodeFileToBase64(file, alphabetName, paddingMode, lineWrap, outputMode, onProgress, signal) {
        const chunkSize = 1024 * 1024; // 1 MiB
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        const alphabet = getAlphabet(alphabetName);
        const wrapAt = lineWrap === 76 ? 76 : 0;
        let lineLen = 0;

        const parts = [];
        const previewCharLimit = 200_000;
        let preview = '';
        let previewTruncated = false;

        let carry = new Uint8Array(0);

        function pushString(s) {
            if (!s) return;
            if (wrapAt > 0) {
                let out = '';
                for (let i = 0; i < s.length; i++) {
                    out += s[i];
                    lineLen++;
                    if (lineLen >= wrapAt) {
                        out += '\n';
                        lineLen = 0;
                    }
                }
                s = out;
            }

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

            const encoded = encodeBytesToBase64(toEncode, alphabetName, 'required', 0); // no wrap here
            // We applied padding always for the full part; remainder handled at end.
            // Note: no padding for full triplets anyway.
            // Now map to selected alphabet (encodeBytesToBase64 already used it) and apply wrapping via pushString.
            // Also remove any '=' from this part (none expected).
            pushString(encoded);

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs, preview, previewTruncated });

            await new Promise(requestAnimationFrame);
        }

        // final carry 1-2 bytes
        if (carry.length > 0) {
            const tailEncoded = encodeBytesToBase64(carry, alphabetName, paddingMode === 'none' ? 'none' : 'required', 0);
            // If padding is optional, we will emit padded for better compatibility.
            pushString(tailEncoded);
        }

        // If wrap is on, remove trailing newline.
        if (wrapAt > 0 && parts.length > 0) {
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
        const chunkSize = 1024 * 1024; // 1 MiB
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        const alphabet = getAlphabet(alphabetName);
        const map = makeDecodeMap(alphabet);
        const decoder = new TextDecoder('latin1');

        let quartet = []; // values 0..63 or -2 for '='
        let logicalIndex = 0; // index in filtered stream (whitespace removed)

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

        function decodeQuartet(q) {
            // q length 4
            const v0 = q[0];
            const v1 = q[1];
            const v2 = q[2];
            const v3 = q[3];

            if (v0 < 0 || v1 < 0) return { ok: false, message: 'Invalid Base64 quartet' };

            if (v2 === -2) {
                if (v3 !== -2) return { ok: false, message: 'Invalid Base64 padding' };
                pushByte(((v0 << 2) | (v1 >> 4)) & 0xff);
                return { ok: true, done: true };
            }

            if (v2 < 0) return { ok: false, message: 'Invalid Base64 quartet' };

            if (v3 === -2) {
                pushByte(((v0 << 2) | (v1 >> 4)) & 0xff);
                pushByte((((v1 & 0x0f) << 4) | (v2 >> 2)) & 0xff);
                return { ok: true, done: true };
            }

            if (v3 < 0) return { ok: false, message: 'Invalid Base64 quartet' };

            const n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
            pushByte((n >> 16) & 0xff);
            pushByte((n >> 8) & 0xff);
            pushByte(n & 0xff);
            return { ok: true, done: false };
        }

        let sawPadding = false;

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
                        return { ok: false, error: { index: logicalIndex, message: `Whitespace not allowed` } };
                    }
                    continue;
                }

                logicalIndex++;

                if (paddingMode === 'none' && ch === '=') {
                    return { ok: false, error: { index: logicalIndex - 1, message: "Padding '=' is not allowed" } };
                }

                let v;
                if (ch === '=') {
                    v = -2;
                    sawPadding = true;
                } else {
                    const code = ch.charCodeAt(0);
                    v = (code <= 127) ? map[code] : -1;
                    if (v < 0) {
                        return { ok: false, error: { index: logicalIndex - 1, message: `Invalid Base64 character '${ch}'` } };
                    }
                    if (sawPadding) {
                        return { ok: false, error: { index: logicalIndex - 1, message: 'Data after padding' } };
                    }
                }

                quartet.push(v);
                if (quartet.length === 4) {
                    const r = decodeQuartet(quartet);
                    if (!r.ok) {
                        return { ok: false, error: { index: logicalIndex - 1, message: r.message } };
                    }
                    quartet = [];
                    if (r.done) {
                        // after padding quartet, the remaining should be only whitespace
                        // we will keep scanning; any non-ws will trip sawPadding logic above.
                    }
                }
            }

            processed += chunk.size;
            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs });
            await new Promise(requestAnimationFrame);
        }

        // finalize tail for optional/no-padding
        if (quartet.length !== 0) {
            if (paddingMode === 'required') {
                return { ok: false, error: { index: logicalIndex - 1, message: 'Invalid Base64 length (padding required)' } };
            }
            if (quartet.length === 1) {
                return { ok: false, error: { index: logicalIndex - 1, message: 'Invalid Base64 length' } };
            }
            // Expand to a 4-length quartet with implied padding and decode
            while (quartet.length < 4) quartet.push(-2);
            const r = decodeQuartet(quartet);
            if (!r.ok) {
                return { ok: false, error: { index: logicalIndex - 1, message: r.message } };
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
                const enc = encodeTextToBytes(text, charset);
                if (!enc.ok) {
                    setError(els, enc.error.message, enc.error.index);
                    return;
                }

                const out = encodeBytesToBase64(enc.bytes, alphabetName, paddingMode, wrap);
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
                const parsed = decodeBase64ToBytes(input, alphabetName, paddingMode, allowWhitespace);
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
        if (window.__mydevtools_base64_encoder_bound) return;
        window.__mydevtools_base64_encoder_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'b64-encode-btn') return void encodeAction();
            if (target.id === 'b64-decode-btn') return void decodeAction();
            if (target.id === 'b64-swap-btn') return void swapAction();
            if (target.id === 'b64-clear-btn') return void clearAction();
            if (target.id === 'b64-copy-btn') return void copyOutputAction();
            if (target.id === 'b64-download-btn') return void downloadAction();
            if (target.id === 'b64-cancel-btn') {
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
