/* global document */

(function () {
    const initializedRoots = new WeakSet();

    function initJsonBeautifier(root) {
        if (initializedRoots.has(root)) return;
        initializedRoots.add(root);

        const inputTextarea = root.querySelector('#input-json');
        const outputPre = root.querySelector('#output-json');
        const outputContainer = root.querySelector('#output-container');
        const formatBtn = root.querySelector('#format-btn');
        const clearBtn = root.querySelector('#clear-btn');
        const copyBtn = root.querySelector('#copy-btn');
        const indentSelect = root.querySelector('#indent-select');
        const sortKeysCheckbox = root.querySelector('#sort-keys');
        const compactModeCheckbox = root.querySelector('#compact-mode');
        const lineNumbersCheckbox = root.querySelector('#line-numbers');
        const collapsibleCheckbox = root.querySelector('#collapsible');

        const errorInvalidJson = root.getAttribute('data-error-invalid-json') || 'Invalid JSON. Please check your input.';
        const copiedText = root.getAttribute('data-copied') || 'Copied!';
        const copyButtonText = root.getAttribute('data-copy-button') || 'Copy';

        if (!inputTextarea || !outputPre || !formatBtn) {
            console.error('JSON Beautifier: Required elements not found');
            return;
        }

        function formatJSON() {
            const input = inputTextarea.value.trim();
            if (!input) {
                outputPre.textContent = '';
                outputContainer?.classList.remove('line-numbers');
                return;
            }

            try {
                const parsed = JSON.parse(input);
                const replacer = sortKeysCheckbox?.checked ? ((key, value) => {
                    if (value && typeof value === 'object' && !Array.isArray(value)) {
                        const sorted = {};
                        Object.keys(value).sort().forEach(k => sorted[k] = value[k]);
                        return sorted;
                    }
                    return value;
                }) : null;
                
                const space = compactModeCheckbox?.checked ? 0 : (indentSelect?.value === '\\t' ? '\t' : parseInt(indentSelect?.value || '4'));
                const formatted = JSON.stringify(parsed, replacer, space);
                outputPre.textContent = formatted;
                updateOutput();
            } catch (e) {
                outputPre.textContent = errorInvalidJson;
                outputContainer?.classList.remove('line-numbers');
            }
        }

        function updateOutput() {
            if (!outputContainer) return;
            
            if (lineNumbersCheckbox?.checked) {
                outputContainer.classList.add('line-numbers');
            } else {
                outputContainer.classList.remove('line-numbers');
            }
            // Collapsible functionality can be implemented here if needed
        }

        function clearAll() {
            if (inputTextarea) inputTextarea.value = '';
            if (outputPre) outputPre.textContent = '';
            outputContainer?.classList.remove('line-numbers');
        }

        function copyToClipboard() {
            if (!outputPre || !copyBtn) return;
            
            navigator.clipboard.writeText(outputPre.textContent).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = copiedText;
                setTimeout(() => {
                    copyBtn.textContent = originalText || copyButtonText;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy:', err);
            });
        }

        // Event listeners
        formatBtn.addEventListener('click', formatJSON);
        clearBtn?.addEventListener('click', clearAll);
        copyBtn?.addEventListener('click', copyToClipboard);
        indentSelect?.addEventListener('change', formatJSON);
        sortKeysCheckbox?.addEventListener('change', formatJSON);
        compactModeCheckbox?.addEventListener('change', formatJSON);
        lineNumbersCheckbox?.addEventListener('change', updateOutput);
        collapsibleCheckbox?.addEventListener('change', updateOutput);

        // Auto format on input change
        inputTextarea.addEventListener('input', formatJSON);
    }

    function observeTools() {
        const observer = new MutationObserver(() => {
            document.querySelectorAll('#json-beautifier-root').forEach(root => {
                initJsonBeautifier(root);
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Initial check
        document.querySelectorAll('#json-beautifier-root').forEach(root => {
            initJsonBeautifier(root);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeTools);
    } else {
        observeTools();
    }
})();
