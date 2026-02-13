/* global document, window */

(function () {
    const initializedRoots = new WeakSet();

    // Named HTML entities map (most common)
    const namedEntities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#x27;': "'",
        '&#x60;': '`',
        '&#39;': "'",
        '&nbsp;': '\u00A0',
        '&copy;': '\u00A9',
        '&reg;': '\u00AE',
        '&trade;': '\u2122',
        '&mdash;': '\u2014',
        '&ndash;': '\u2013',
        '&hellip;': '\u2026',
        '&ldquo;': '\u201C',
        '&rdquo;': '\u201D',
        '&lsquo;': '\u2018',
        '&rsquo;': '\u2019',
        '&bull;': '\u2022',
        '&middot;': '\u00B7',
        '&times;': '\u00D7',
        '&divide;': '\u00F7',
        '&plusmn;': '\u00B1',
        '&frac14;': '\u00BC',
        '&frac12;': '\u00BD',
        '&frac34;': '\u00BE',
        '&deg;': '\u00B0',
        '&euro;': '\u20AC',
        '&pound;': '\u00A3',
        '&yen;': '\u00A5',
        '&cent;': '\u00A2'
    };

    // Reverse map for encoding
    const reverseNamedEntities = {};
    for (const [entity, char] of Object.entries(namedEntities)) {
        reverseNamedEntities[char] = entity;
    }

    function getElements() {
        const root = document.getElementById('html-entity-encoder-root');
        if (!root) return null;

        const input = document.getElementById('html-input');
        const output = document.getElementById('html-output');
        const mode = document.getElementById('html-mode');
        const format = document.getElementById('html-format');
        const encodeBtn = document.getElementById('html-encode-btn');
        const decodeBtn = document.getElementById('html-decode-btn');
        const swapBtn = document.getElementById('html-swap-btn');
        const clearBtn = document.getElementById('html-clear-btn');
        const copyBtn = document.getElementById('html-copy-btn');
        const errorEl = document.getElementById('html-error');

        if (!input || !output || !mode || !format || !encodeBtn || !decodeBtn || !swapBtn || !clearBtn || !copyBtn || !errorEl) {
            return null;
        }

        return { root, input, output, mode, format, encodeBtn, decodeBtn, swapBtn, clearBtn, copyBtn, errorEl };
    }

    function setError(els, message) {
        els.errorEl.hidden = !message;
        els.errorEl.textContent = message || '';
        if (message) {
            els.errorEl.style.display = '';
        } else {
            els.errorEl.style.display = 'none';
        }
    }

    function clearError(els) {
        setError(els, '');
    }

    // Encode text to HTML entities
    function encodeHtml(text, mode, format) {
        let result = '';
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const code = char.charCodeAt(0);
            
            // Always encode these special characters
            const specialChars = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": format === 'named' ? '&#x27;' : (format === 'decimal' ? '&#39;' : '&#x27;')
            };
            
            if (specialChars[char] && (mode === 'all' || mode === 'specialchars')) {
                result += specialChars[char];
            } else if (mode === 'nonascii' && code > 127) {
                // Non-ASCII characters only
                if (format === 'named' && reverseNamedEntities[char]) {
                    result += reverseNamedEntities[char];
                } else if (format === 'decimal') {
                    result += `&#${code};`;
                } else {
                    // hex
                    result += `&#x${code.toString(16).toUpperCase()};`;
                }
            } else if (mode === 'all' && code > 127) {
                // All non-ASCII in 'all' mode
                if (format === 'named' && reverseNamedEntities[char]) {
                    result += reverseNamedEntities[char];
                } else if (format === 'decimal') {
                    result += `&#${code};`;
                } else {
                    // hex
                    result += `&#x${code.toString(16).toUpperCase()};`;
                }
            } else {
                // Keep as is
                result += char;
            }
        }
        
        return result;
    }

    // Decode HTML entities to text
    function decodeHtml(text) {
        let result = text;
        
        // Decode numeric entities (hex) - &#xHH;
        result = result.replace(/&#x([0-9a-fA-F]+);/g, function(match, hex) {
            const code = parseInt(hex, 16);
            return String.fromCharCode(code);
        });
        
        // Decode numeric entities (decimal) - &#DDD;
        result = result.replace(/&#(\d+);/g, function(match, dec) {
            const code = parseInt(dec, 10);
            return String.fromCharCode(code);
        });
        
        // Decode named entities
        for (const [entity, char] of Object.entries(namedEntities)) {
            result = result.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), char);
        }
        
        return result;
    }

    function encodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const text = els.input.value || '';
        const mode = String(els.mode.value || 'specialchars');
        const format = String(els.format.value || 'named');

        try {
            const result = encodeHtml(text, mode, format);
            els.output.value = result;
        } catch (error) {
            setError(els, error.message || 'Encoding error');
        }
    }

    function decodeAction() {
        const els = getElements();
        if (!els) return;
        clearError(els);

        const text = els.input.value || '';

        try {
            const result = decodeHtml(text);
            els.output.value = result;
        } catch (error) {
            setError(els, error.message || 'Decoding error');
        }
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
        if (window.__mydevtools_html_entity_encoder_bound) return;
        window.__mydevtools_html_entity_encoder_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;
            const btn = (id) => target.closest(`#${id}`);

            if (btn('html-encode-btn')) return void encodeAction();
            if (btn('html-decode-btn')) return void decodeAction();
            if (btn('html-swap-btn')) return void swapAction();
            if (btn('html-clear-btn')) return void clearAction();
            if (btn('html-copy-btn')) return void copyOutputAction();
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
