(function () {
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
        
        // Buttons can be retrieved dynamically
        
        return { root, inputText };
    }

    async function convertCase(caseType) {
        const els = getElements();
        if (!els || !els.inputText) return;

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

    async function handleCopy(btn) {
        const els = getElements();
        if (!els || !els.inputText) return;

        const text = els.inputText.value;
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            
            // Visual feedback
            const originalContent = btn.innerHTML;
            const originalClass = btn.className;
            
            btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 mr-1 text-success">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                Copied!
            `;
            btn.classList.add('text-success');
            
            setTimeout(() => {
                btn.innerHTML = originalContent;
                btn.className = originalClass;
            }, 2000);

        } catch (err) {
            console.error('Copy error:', err);
        }
    }

    function handleClear() {
        const els = getElements();
        if (!els || !els.inputText) return;
        els.inputText.value = '';
    }

    function handleButtonClick(ev) {
        const target = ev.target;
        if (!target) return;

        // Conversion Buttons
        const actionBtn = target.closest('button[data-case-type]');
        if (actionBtn) {
            ev.preventDefault();
            const caseType = actionBtn.dataset.caseType;
            void convertCase(caseType);
            return;
        }

        // Copy Button
        const copyBtn = target.closest('#tcc-copy-btn');
        if (copyBtn) {
            ev.preventDefault();
            void handleCopy(copyBtn);
            return;
        }

        // Clear Button
        const clearBtn = target.closest('#tcc-clear-btn');
        if (clearBtn) {
            ev.preventDefault();
            handleClear();
            return;
        }
    }

    function init() {
        // Remove existing listener to prevent duplicates if init is called multiple times
        document.removeEventListener('click', handleButtonClick);
        document.addEventListener('click', handleButtonClick);
    }

    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
