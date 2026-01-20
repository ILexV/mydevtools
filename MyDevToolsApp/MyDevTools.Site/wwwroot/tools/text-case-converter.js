/* global document, window */

(function () {
    const initializedRoots = new WeakSet();
    let wasmModulePromise = null;

    async function getWasm() {
        if (!wasmModulePromise) {
            wasmModulePromise = import('/wasm/text_tools/text_tools.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return wasmModulePromise;
    }

    function getElements() {
        const root = document.getElementById('text-case-converter-root');
        if (!root) return null;

        const inputText = document.getElementById('tcc-input-text');
        const copyBtn = document.getElementById('tcc-copy-btn');
        const clearBtn = document.getElementById('tcc-clear-btn');

        if (!inputText) return null;

        return { root, inputText, copyBtn, clearBtn };
    }

    function getStrings(root) {
        return {
            copied: root.dataset.copied || 'Copied!',
            error: root.dataset.error || 'Error'
        };
    }

    async function convertCase(caseType) {
        const els = getElements();
        if (!els) return;

        const text = els.inputText.value;
        if (!text) return;

        try {
            const wasm = await getWasm();
            const result = wasm.convert_text_case(text, caseType);
            els.inputText.value = result;
        } catch (err) {
            console.error('Case conversion error:', err);
        }
    }

    async function handleCopy() {
        const els = getElements();
        if (!els || !els.copyBtn) return;

        const text = els.inputText.value;
        if (!text) return;

        const strings = getStrings(els.root);
        try {
            await navigator.clipboard.writeText(text);
            const original = els.copyBtn.innerHTML;
            els.copyBtn.textContent = strings.copied;
            setTimeout(() => {
                els.copyBtn.innerHTML = original;
            }, 2000);
        } catch (err) {
            console.error('Copy error:', err);
        }
    }

    function handleClear() {
        const els = getElements();
        if (!els) return;
        els.inputText.value = '';
    }

    function bindHandlers() {
        if (window.__textCaseConverterHandlersBound) return;
        window.__textCaseConverterHandlersBound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;

            const actionBtn = target.closest('button[data-case-type]');
            if (actionBtn) {
                ev.preventDefault();
                const caseType = actionBtn.dataset.caseType;
                void convertCase(caseType);
                return;
            }

            if (target.closest('#tcc-copy-btn')) {
                ev.preventDefault();
                void handleCopy();
                return;
            }

            if (target.closest('#tcc-clear-btn')) {
                ev.preventDefault();
                handleClear();
                return;
            }
        });
    }

    bindHandlers();

    function init() {
        const els = getElements();
        if (!els || initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);
    }

    init();

    document.addEventListener('blazor:enhancedload', init);

    // Re-init on navigation (fallback)
    try {
        const observer = new MutationObserver(() => init());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch { /* ignore */ }
})();
