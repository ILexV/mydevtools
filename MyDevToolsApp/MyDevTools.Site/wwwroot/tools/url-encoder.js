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

    async function encodeTextToBytes(text, charset) {
        try {
            const wasm = await getEncodingWasm();
            if (typeof wasm.encode_text_to_bytes !== 'function') {
                return { ok: false, error: { index: 0, message: 'WASM module not built. Please rebuild the encoding module.' } };
            }
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

    async function encodeUrlBytes(bytes, mode) {
        const wasm = await getEncodingWasm();
        if (typeof wasm.url_encode !== 'function') {
            throw new Error('WASM module not built. Please rebuild the encoding module.');
        }
        return wasm.url_encode(bytes, mode);
    }

    async function decodeUrlToBytes(input, mode) {
        try {
            const wasm = await getEncodingWasm();
            if (typeof wasm.url_decode !== 'function') {
                return { ok: false, error: { index: 0, message: 'WASM module not built. Please rebuild the encoding module.' } };
            }
            const bytes = wasm.url_decode(input, mode);
            return { ok: true, bytes: new Uint8Array(bytes) };
        } catch (err) {
            const msg = err?.message || String(err);
            const indexMatch = msg.match(/position (\d+)/) || msg.match(/index (\d+)/);
            const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;
            return { ok: false, error: { index, message: msg } };
        }
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

    async function encodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const text = els.input.value || '';
        const mode = String(els.mode.value || 'component');
        const charset = String(els.charset.value || 'utf-8');

        const enc = await encodeTextToBytes(text, charset);
        if (!enc.ok) {
            setError(els, enc.error.message, enc.error.index);
            return;
        }

        const out = await encodeUrlBytes(enc.bytes, mode);
        els.output.value = out;
    }

    async function decodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const input = els.input.value || '';
        const mode = String(els.mode.value || 'component');
        const charset = String(els.charset.value || 'utf-8');

        const decoded = await decodeUrlToBytes(input, mode);
        if (!decoded.ok) {
            setError(els, decoded.error.message, decoded.error.index);
            return;
        }

        const text = await decodeBytesToText(decoded.bytes, charset);
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
