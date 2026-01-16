/* global document, window */

(function () {
    const initializedRoots = new WeakSet();

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

    function bytesToHexUpper(bytes) {
        const HEX = '0123456789ABCDEF';
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            out += HEX[(b >> 4) & 0x0f] + HEX[b & 0x0f];
        }
        return out;
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
        // Returns { ok:true, text } or { ok:false, error:{ byteIndex, message } }
        let out = '';
        let i = 0;
        while (i < bytes.length) {
            const b0 = bytes[i];
            if (b0 <= 0x7f) {
                out += String.fromCharCode(b0);
                i += 1;
                continue;
            }

            // 2-byte
            if (b0 >= 0xc2 && b0 <= 0xdf) {
                if (i + 1 >= bytes.length) return { ok: false, error: { byteIndex: i, message: 'Truncated UTF-8 sequence' } };
                const b1 = bytes[i + 1];
                if ((b1 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 1, message: 'Invalid UTF-8 continuation byte' } };
                const cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
                out += String.fromCharCode(cp);
                i += 2;
                continue;
            }

            // 3-byte
            if (b0 >= 0xe0 && b0 <= 0xef) {
                if (i + 2 >= bytes.length) return { ok: false, error: { byteIndex: i, message: 'Truncated UTF-8 sequence' } };
                const b1 = bytes[i + 1];
                const b2 = bytes[i + 2];
                if ((b1 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 1, message: 'Invalid UTF-8 continuation byte' } };
                if ((b2 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 2, message: 'Invalid UTF-8 continuation byte' } };
                // overlong + surrogate checks
                if (b0 === 0xe0 && b1 < 0xa0) return { ok: false, error: { byteIndex: i, message: 'Overlong UTF-8 sequence' } };
                if (b0 === 0xed && b1 >= 0xa0) return { ok: false, error: { byteIndex: i, message: 'UTF-8 surrogate code point' } };
                const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
                out += String.fromCharCode(cp);
                i += 3;
                continue;
            }

            // 4-byte
            if (b0 >= 0xf0 && b0 <= 0xf4) {
                if (i + 3 >= bytes.length) return { ok: false, error: { byteIndex: i, message: 'Truncated UTF-8 sequence' } };
                const b1 = bytes[i + 1];
                const b2 = bytes[i + 2];
                const b3 = bytes[i + 3];
                if ((b1 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 1, message: 'Invalid UTF-8 continuation byte' } };
                if ((b2 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 2, message: 'Invalid UTF-8 continuation byte' } };
                if ((b3 & 0xc0) !== 0x80) return { ok: false, error: { byteIndex: i + 3, message: 'Invalid UTF-8 continuation byte' } };
                // overlong + max range
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
                if (bytes.length % 2 !== 0) {
                    return { ok: false, error: { byteIndex: bytes.length - 1, message: 'Odd number of bytes for UTF-16LE' } };
                }
                let out = '';
                for (let i = 0; i < bytes.length; i += 2) {
                    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
                }
                return { ok: true, text: out };
            }
            case 'utf-16be': {
                if (bytes.length % 2 !== 0) {
                    return { ok: false, error: { byteIndex: bytes.length - 1, message: 'Odd number of bytes for UTF-16BE' } };
                }
                let out = '';
                for (let i = 0; i < bytes.length; i += 2) {
                    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
                }
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

    function encodeUrlBytes(bytes, mode) {
        const isUnreservedByte = (b) =>
            (b >= 0x41 && b <= 0x5a) ||
            (b >= 0x61 && b <= 0x7a) ||
            (b >= 0x30 && b <= 0x39) ||
            b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;

        const isUriReservedByte = (b) => {
            // encodeURI-like: preserve reserved + '#'
            // ";,/?:@&=+$,#" (percent itself handled separately)
            return (
                b === 0x3b || b === 0x2c || b === 0x2f || b === 0x3f || b === 0x3a ||
                b === 0x40 || b === 0x26 || b === 0x3d || b === 0x2b || b === 0x24 ||
                b === 0x23
            );
        };

        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];

            if (mode === 'form' && b === 0x20) {
                out += '+';
                continue;
            }

            const safe = mode === 'uri'
                ? (isUnreservedByte(b) || isUriReservedByte(b))
                : isUnreservedByte(b);

            if (safe) {
                out += String.fromCharCode(b);
            } else {
                out += '%' + bytesToHexUpper(Uint8Array.of(b));
            }
        }

        return out;
    }

    function decodeUrlToBytes(input, { plusAsSpace, charsetForRawChars }) {
        const bytes = [];
        for (let i = 0; i < input.length; i++) {
            const ch = input[i];

            if (plusAsSpace && ch === '+') {
                bytes.push(0x20);
                continue;
            }

            if (ch === '%') {
                if (i + 2 >= input.length) {
                    return { ok: false, error: { index: i, message: 'Incomplete percent-encoding' } };
                }
                const a = input[i + 1];
                const b = input[i + 2];
                if (!isHexDigit(a) || !isHexDigit(b)) {
                    return { ok: false, error: { index: i, message: 'Invalid percent-encoding' } };
                }
                const byte = (hexValue(a) << 4) | hexValue(b);
                bytes.push(byte);
                i += 2;
                continue;
            }

            const code = input.charCodeAt(i);
            if (code <= 0x7f) {
                bytes.push(code);
                continue;
            }

            // Non-ASCII raw char: encode using selected charset and append bytes.
            const enc = encodeTextToBytes(ch, charsetForRawChars);
            if (!enc.ok) {
                return { ok: false, error: { index: i, message: enc.error.message } };
            }
            for (let k = 0; k < enc.bytes.length; k++) bytes.push(enc.bytes[k]);
        }

        return { ok: true, bytes: new Uint8Array(bytes) };
    }

    function getElements() {
        const root = document.getElementById('url-encoder-root');
        if (!root) return null;

        const input = document.getElementById('url-input');
        const output = document.getElementById('url-output');
        const mode = document.getElementById('url-mode');
        const charset = document.getElementById('url-charset');
        const encodeBtn = document.getElementById('url-encode-btn');
        const decodeBtn = document.getElementById('url-decode-btn');
        const swapBtn = document.getElementById('url-swap-btn');
        const clearBtn = document.getElementById('url-clear-btn');
        const copyBtn = document.getElementById('url-copy-btn');
        const errorEl = document.getElementById('url-error');

        if (!input || !output || !mode || !charset || !encodeBtn || !decodeBtn || !swapBtn || !clearBtn || !copyBtn || !errorEl) {
            return null;
        }

        return { root, input, output, mode, charset, encodeBtn, decodeBtn, swapBtn, clearBtn, copyBtn, errorEl };
    }

    function setError(els, message, index) {
        els.errorEl.hidden = !message;
        els.errorEl.textContent = message || '';
        if (typeof index === 'number' && index >= 0) {
            try {
                els.input.focus();
                els.input.setSelectionRange(index, Math.min(index + 1, els.input.value.length));
            } catch {
                // ignore
            }
        }
    }

    function clearError(els) {
        setError(els, '', null);
    }

    function encodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const text = els.input.value || '';
        const mode = String(els.mode.value || 'component');
        const charset = String(els.charset.value || 'utf-8');

        const enc = encodeTextToBytes(text, charset);
        if (!enc.ok) {
            setError(els, enc.error.message, enc.error.index);
            return;
        }

        els.output.value = encodeUrlBytes(enc.bytes, mode);
    }

    function decodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const input = els.input.value || '';
        const mode = String(els.mode.value || 'component');
        const charset = String(els.charset.value || 'utf-8');
        const plusAsSpace = mode === 'form';

        const decoded = decodeUrlToBytes(input, { plusAsSpace, charsetForRawChars: charset });
        if (!decoded.ok) {
            setError(els, decoded.error.message, decoded.error.index);
            return;
        }

        const text = decodeBytesToText(decoded.bytes, charset);
        if (!text.ok) {
            setError(els, `${text.error.message} (byte ${text.error.byteIndex})`, null);
            return;
        }

        els.output.value = text.text;
    }

    function swapAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);
        const a = els.input.value;
        els.input.value = els.output.value;
        els.output.value = a;
    }

    function clearAction() {
        const els = getElements();
        if (!els) return;
        els.input.value = '';
        els.output.value = '';
        clearError(els);
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

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_url_encoder_bound) return;
        window.__mydevtools_url_encoder_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'url-encode-btn') return void encodeAction();
            if (target.id === 'url-decode-btn') return void decodeAction();
            if (target.id === 'url-swap-btn') return void swapAction();
            if (target.id === 'url-clear-btn') return void clearAction();
            if (target.id === 'url-copy-btn') return void copyOutputAction();
        });
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);

        // Default output mirrors input action; no auto-run.
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
