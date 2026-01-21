/* global document, window, navigator */

(function () {
    const initializedRoots = new WeakSet();

    function getElements() {
        const root = document.getElementById('date-converter-root');
        if (!root) return null;

        return {
            root,
            input: document.getElementById('date-input'),
            inputType: document.getElementById('date-input-type'),
            output: document.getElementById('date-output'),
            outputFormat: document.getElementById('date-output-format'),
            customFmtContainer: document.getElementById('date-custom-fmt-container'),
            customFmtInput: document.getElementById('date-output-custom-fmt'),
            convertBtn: document.getElementById('date-convert-btn'),
            nowBtn: document.getElementById('date-now-btn'),
            copyBtn: document.getElementById('date-copy-btn'),
            error: document.getElementById('date-error')
        };
    }

    function setError(els, msg) {
        if (!els.error) return;
        els.error.textContent = msg;
        els.error.hidden = !msg;
    }

    function parseInput(value, type) {
        value = value.trim();
        if (!value) return null;

        if (type === 'auto') {
            // Try to detect Unix timestamp (digits only)
            if (/^\d{1,14}$/.test(value)) {
                // If length is small (~10 digits), assume seconds, else milliseconds
                const num = Number(value);
                if (value.length <= 11) {
                    return new Date(num * 1000);
                }
                return new Date(num);
            }
            return new Date(value);
        } else if (type === 'unix-sec') {
            return new Date(Number(value) * 1000);
        } else if (type === 'unix-ms') {
            return new Date(Number(value));
        } else if (type === 'iso') {
            return new Date(value);
        }
        return new Date(value);
    }

    function formatCustomDate(date, fmt) {
        const pad = (n, width = 2) => String(n).padStart(width, '0');
        const yyyy = date.getFullYear();
        const MM = pad(date.getMonth() + 1);
        const dd = pad(date.getDate());
        const HH = pad(date.getHours());
        const mm = pad(date.getMinutes());
        const ss = pad(date.getSeconds());
        const SSS = pad(date.getMilliseconds(), 3);

        return fmt
            .replace('yyyy', yyyy)
            .replace('MM', MM)
            .replace('dd', dd)
            .replace('HH', HH)
            .replace('mm', mm)
            .replace('ss', ss)
            .replace('SSS', SSS);
    }

    function formatOutput(date, format, customFmt) {
        if (isNaN(date.getTime())) return null;

        switch (format) {
            case 'iso':
                return date.toISOString();
            case 'euro':
                return formatCustomDate(date, 'dd.MM.yyyy HH:mm:ss');
            case 'custom':
                return formatCustomDate(date, customFmt || 'dd.MM.yyyy');
            case 'utc':
                return date.toUTCString();
            case 'local':
                return date.toString();
            case 'rfc':
                return date.toUTCString();
            case 'unix-sec':
                return Math.floor(date.getTime() / 1000).toString();
            case 'unix-ms':
                return date.getTime().toString();
            default:
                return date.toISOString();
        }
    }

    function toggleCustomFormatVisibility(els) {
        const isCustom = els.outputFormat.value === 'custom';
        if (els.customFmtContainer) {
            els.customFmtContainer.hidden = !isCustom;
        }
    }

    function convertAction() {
        const els = getElements();
        if (!els) return;

        toggleCustomFormatVisibility(els);

        const val = els.input.value;
        const type = els.inputType.value;
        const format = els.outputFormat.value;
        const customFmt = els.customFmtInput ? els.customFmtInput.value : '';

        if (!val.trim()) {
            els.output.value = '';
            setError(els, '');
            return;
        }

        const date = parseInput(val, type);

        if (!date || isNaN(date.getTime())) {
            const invalidMsg = els.root.dataset.errorInvalid || 'Invalid Date';
            setError(els, invalidMsg);
            els.output.value = '';
            return;
        }

        setError(els, '');
        els.output.value = formatOutput(date, format, customFmt);
    }

    function currentTimeAction() {
        const els = getElements();
        if (!els) return;

        const now = new Date();
        const type = els.inputType.value;

        if (type === 'unix-sec' || type === 'auto') {
            els.input.value = Math.floor(now.getTime() / 1000);
        } else if (type === 'unix-ms') {
            els.input.value = now.getTime();
        } else {
            els.input.value = now.toISOString();
        }

        convertAction();
    }

    function copyAction() {
        const els = getElements();
        if (!els) return;

        const text = els.output.value;
        if (!text) return;

        navigator.clipboard.writeText(text).then(() => {
            const original = els.copyBtn.textContent;
            els.copyBtn.textContent = els.root.dataset.copied || 'Copied!';
            setTimeout(() => {
                els.copyBtn.textContent = original;
            }, 1500);
        });
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_date_converter_bound) return;
        window.__mydevtools_date_converter_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'date-convert-btn') return convertAction();
            if (target.id === 'date-now-btn') return currentTimeAction();
            if (target.id === 'date-copy-btn') return copyAction();
        });

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            if (target.id === 'date-output-custom-fmt') {
                if (document.getElementById('date-convert-btn')) {
                    convertAction();
                }
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            if (target.id === 'date-input-type' || target.id === 'date-output-format') {
                if (document.getElementById('date-convert-btn')) {
                    convertAction();
                }
            }
        });
    }

    function init() {
        const els = getElements();
        if (!els || initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);
    }

    bindDelegatedHandlersOnce();
    init();

    try {
        const observer = new MutationObserver(() => init());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }
})();
