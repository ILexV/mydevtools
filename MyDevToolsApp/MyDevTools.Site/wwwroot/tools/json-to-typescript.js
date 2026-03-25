/* global document, CodeMirror */

(function () {
    'use strict';

    // ─── JSON → TypeScript Conversion Engine ─────────────────────────────────

    function inferType(value, name, interfaces, opts) {
        if (value === null || value === undefined) {
            return 'null';
        }

        if (Array.isArray(value)) {
            if (value.length === 0) return 'unknown[]';
            const elementTypes = value.map((item) =>
                inferType(item, toPascalCase(name) + 'Item', interfaces, opts)
            );
            const uniqueTypes = [...new Set(elementTypes)];
            const elementType = uniqueTypes.length === 1
                ? uniqueTypes[0]
                : '(' + uniqueTypes.join(' | ') + ')';
            return elementType + '[]';
        }

        if (typeof value === 'object') {
            return buildInterface(value, name, interfaces, opts);
        }

        if (typeof value === 'string') return 'string';
        if (typeof value === 'number') return 'number';
        if (typeof value === 'boolean') return 'boolean';

        return 'unknown';
    }

    function buildInterface(obj, name, interfaces, opts) {
        const safeName = toPascalCase(name) || 'Root';

        const lines = [];
        for (const [key, val] of Object.entries(obj)) {
            const propName = toSafeKey(key);
            const isNullish = val === null || val === undefined;
            const optional = opts.optional && isNullish ? '?' : '';
            const subTypeName = toPascalCase(safeName) + toPascalCase(key);
            const tsType = inferType(val, subTypeName, interfaces, opts);
            lines.push(`  ${propName}${optional}: ${tsType};`);
        }

        const expKw = opts.exportKw ? 'export ' : '';
        let definition;
        if (opts.useType) {
            definition = `${expKw}type ${safeName} = {\n${lines.join('\n')}\n};`;
        } else {
            definition = `${expKw}interface ${safeName} {\n${lines.join('\n')}\n}`;
        }

        let finalName = safeName;
        if (interfaces.has(finalName)) {
            if (interfaces.get(finalName) !== definition) {
                let i = 2;
                while (interfaces.has(finalName + i)) i++;
                finalName = finalName + i;
                if (opts.useType) {
                    definition = `${expKw}type ${finalName} = {\n${lines.join('\n')}\n};`;
                } else {
                    definition = `${expKw}interface ${finalName} {\n${lines.join('\n')}\n}`;
                }
            }
        } else {
            interfaces.set(finalName, definition);
        }

        return finalName;
    }

    function toPascalCase(str) {
        if (!str) return '';
        return str
            .replace(/[-_\s.]+(.)/g, (_, c) => c.toUpperCase())
            .replace(/^(.)/, (_, c) => c.toUpperCase());
    }

    function toSafeKey(key) {
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key;
        return `"${key.replace(/"/g, '\\"')}"`;
    }

    function jsonToTypeScript(jsonStr, opts) {
        const parsed = JSON.parse(jsonStr);
        const interfaces = new Map();
        const rootName = toPascalCase(opts.rootName || 'Root') || 'Root';

        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            buildInterface(parsed, rootName, interfaces, opts);
        } else if (Array.isArray(parsed)) {
            if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
                buildInterface(parsed[0], rootName + 'Item', interfaces, opts);
            }
            const expKw = opts.exportKw ? 'export ' : '';
            const itemType = parsed.length > 0
                ? (typeof parsed[0] === 'object' ? rootName + 'Item' : typeof parsed[0])
                : 'unknown';
            interfaces.set(rootName, `${expKw}type ${rootName} = ${itemType}[];`);
        } else {
            const expKw = opts.exportKw ? 'export ' : '';
            const tsType = inferType(parsed, rootName, interfaces, opts);
            interfaces.set(rootName, `${expKw}type ${rootName} = ${tsType};`);
        }

        return [...interfaces.values()].join('\n\n');
    }

    // ─── UI Logic ─────────────────────────────────────────────────────────────

    function initJsonToTypeScript(root) {
        // Idempotency: CodeMirror presence means already initialized
        if (root.querySelector('.CodeMirror')) return;

        // Wait for CodeMirror to load
        if (typeof CodeMirror === 'undefined') {
            setTimeout(() => initJsonToTypeScript(root), 100);
            return;
        }

        const inputEl      = root.querySelector('#jtt-input');
        const outputEl     = root.querySelector('#jtt-output');
        const convertBtn   = root.querySelector('#jtt-convert-btn');
        const copyBtn      = root.querySelector('#jtt-copy-btn');
        const clearBtn     = root.querySelector('#jtt-clear-btn');
        const downloadBtn  = root.querySelector('#jtt-download-btn');
        const rootNameInput = root.querySelector('#jtt-root-name');
        const exportChk    = root.querySelector('#jtt-export');
        const optionalChk  = root.querySelector('#jtt-optional');
        const useTypeChk   = root.querySelector('#jtt-use-type');
        const errorBox     = root.querySelector('#jtt-error');
        const errorText    = root.querySelector('#jtt-error-text');

        if (!inputEl || !outputEl || !convertBtn) return;

        const strings = {
            errorInvalidJson: root.getAttribute('data-error-invalid-json') || 'Invalid JSON',
            copied:           root.getAttribute('data-copied')             || 'Copied!',
            copyButton:       root.getAttribute('data-copy-button')        || 'Copy',
            inputPlaceholder: root.getAttribute('data-input-placeholder')  || 'Paste your JSON here...',
            outputPlaceholder: root.getAttribute('data-output-placeholder') || 'TypeScript interfaces will appear here...',
        };

        // ── Input editor (JSON, editable) ──────────────────────────────────
        const inputEditor = CodeMirror(inputEl, {
            mode: { name: 'javascript', json: true },
            lineNumbers: true,
            lineWrapping: true,
            autoCloseBrackets: true,
            matchBrackets: true,
            indentUnit: 2,
            tabSize: 2,
            theme: 'default',
            placeholder: strings.inputPlaceholder,
            viewportMargin: Infinity,
            foldGutter: true,
            gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
        });
        inputEditor.setSize(null, '700px');

        // ── Output editor (TypeScript, read-only) ──────────────────────────
        const outputEditor = CodeMirror(outputEl, {
            mode: { name: 'javascript', typescript: true },
            lineNumbers: true,
            lineWrapping: true,
            readOnly: true,
            theme: 'default',
            placeholder: strings.outputPlaceholder,
            viewportMargin: Infinity,
            foldGutter: true,
            gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
        });
        outputEditor.setSize(null, '700px');

        // ── Theme sync ─────────────────────────────────────────────────────
        function updateTheme() {
            inputEditor.refresh();
            outputEditor.refresh();
        }
        const themeObserver = new MutationObserver((mutations) => {
            mutations.forEach((m) => {
                if (m.type === 'attributes' && m.attributeName === 'data-theme') updateTheme();
            });
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        updateTheme();

        // ── Helpers ────────────────────────────────────────────────────────
        function getOpts() {
            return {
                rootName: (rootNameInput ? rootNameInput.value.trim() : '') || 'Root',
                exportKw: exportChk  ? exportChk.checked  : false,
                optional: optionalChk ? optionalChk.checked : true,
                useType:  useTypeChk  ? useTypeChk.checked  : false,
            };
        }

        function showError(msg) {
            if (errorBox && errorText) {
                errorText.textContent = msg;
                errorBox.classList.remove('hidden');
            }
            inputEditor.getWrapperElement().classList.add('json-error');
        }

        function clearError() {
            if (errorBox) errorBox.classList.add('hidden');
            inputEditor.getWrapperElement().classList.remove('json-error');
        }

        function doConvert() {
            clearError();
            const src = inputEditor.getValue().trim();
            if (!src) { outputEditor.setValue(''); return; }

            try {
                const result = jsonToTypeScript(src, getOpts());
                outputEditor.setValue(result);
            } catch (e) {
                outputEditor.setValue('');
                showError(strings.errorInvalidJson + (e.message ? ': ' + e.message : ''));
            }
        }

        function doCopy() {
            const text = outputEditor.getValue();
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => {
                if (!copyBtn) return;
                const originalHTML = copyBtn.innerHTML;
                copyBtn.textContent = strings.copied;
                setTimeout(() => { copyBtn.innerHTML = originalHTML; }, 2000);
            }).catch(() => {});
        }

        function doClear() {
            inputEditor.setValue('');
            outputEditor.setValue('');
            clearError();
        }

        function doDownload() {
            const text = outputEditor.getValue();
            if (!text) return;
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'types.ts';
            a.click();
            URL.revokeObjectURL(url);
        }

        // ── Event wiring ───────────────────────────────────────────────────
        convertBtn.onclick = doConvert;
        copyBtn    && (copyBtn.onclick    = doCopy);
        clearBtn   && (clearBtn.onclick   = doClear);
        downloadBtn && (downloadBtn.onclick = doDownload);

        // Live conversion on input change
        inputEditor.on('change', doConvert);

        // Re-convert when options change
        [exportChk, optionalChk, useTypeChk].forEach(el => {
            if (el) el.onchange = doConvert;
        });
        if (rootNameInput) rootNameInput.oninput = doConvert;
    }

    // ─── Observer (Blazor SSR navigation support) ─────────────────────────────

    function observeTools() {
        const selector = '#json-to-typescript-root';

        function tryInit() {
            document.querySelectorAll(selector).forEach(root => {
                initJsonToTypeScript(root);
            });
        }

        const observer = new MutationObserver(tryInit);
        observer.observe(document.body, { childList: true, subtree: true });

        tryInit();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeTools);
    } else {
        observeTools();
    }
})();
