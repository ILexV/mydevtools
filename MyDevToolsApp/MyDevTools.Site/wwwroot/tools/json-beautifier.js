/* global document, CodeMirror */

(function () {
    const initializedRoots = new WeakSet();

    function initJsonBeautifier(root) {
        if (initializedRoots.has(root)) return;
        
        // Check if CodeMirror is available
        if (typeof CodeMirror === 'undefined') {
            console.log('JSON Beautifier: CodeMirror not loaded yet, waiting...');
            setTimeout(() => initJsonBeautifier(root), 100);
            return;
        }
        
        initializedRoots.add(root);

        const editorElement = root.querySelector('#json-editor');
        const formatBtn = root.querySelector('#format-btn');
        const clearBtn = root.querySelector('#clear-btn');
        const copyBtn = root.querySelector('#copy-btn');
        const indentSelect = root.querySelector('#indent-select');
        const sortKeysCheckbox = root.querySelector('#sort-keys');
        const compactModeCheckbox = root.querySelector('#compact-mode');

        const errorInvalidJson = root.getAttribute('data-error-invalid-json') || 'Invalid JSON. Please check your input.';
        const copiedText = root.getAttribute('data-copied') || 'Copied!';
        const copyButtonText = root.getAttribute('data-copy-button') || 'Copy';
        const placeholder = root.getAttribute('data-input-placeholder') || 'Paste your JSON here...';

        if (!editorElement || !formatBtn || typeof CodeMirror === 'undefined') {
            console.error('JSON Beautifier: Required elements or CodeMirror not found');
            return;
        }

        // Initialize CodeMirror
        const editor = CodeMirror(editorElement, {
            mode: { name: "javascript", json: true },
            lineNumbers: true,
            lineWrapping: true,
            autoCloseBrackets: true,
            matchBrackets: true,
            indentUnit: 4,
            tabSize: 4,
            theme: 'default',
            placeholder: placeholder,
            viewportMargin: Infinity,
            foldGutter: true,
            gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"]
        });

        // Set initial height
        editor.setSize(null, '600px');

        // Load saved JSON from localStorage
        const savedJson = localStorage.getItem('json-beautifier-input');
        if (savedJson) {
            editor.setValue(savedJson);
        }

        // Load saved settings
        const savedIndent = localStorage.getItem('json-beautifier-indent');
        if (savedIndent && indentSelect) {
            indentSelect.value = savedIndent;
        }
        const savedSortKeys = localStorage.getItem('json-beautifier-sort-keys');
        if (savedSortKeys && sortKeysCheckbox) {
            sortKeysCheckbox.checked = savedSortKeys === 'true';
        }
        const savedCompactMode = localStorage.getItem('json-beautifier-compact-mode');
        if (savedCompactMode && compactModeCheckbox) {
            compactModeCheckbox.checked = savedCompactMode === 'true';
        }

        // Save to localStorage on change
        editor.on('change', () => {
            localStorage.setItem('json-beautifier-input', editor.getValue());
        });

        // Sync theme with site theme
        function updateEditorTheme() {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            // CodeMirror doesn't need theme change as we use CSS variables
            // Just refresh to apply new styles
            editor.refresh();
        }

        // Watch for theme changes
        const themeObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                    updateEditorTheme();
                }
            });
        });

        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });

        // Set initial theme
        updateEditorTheme();

        function formatJSON() {
            const input = editor.getValue().trim();
            if (!input) {
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
                
                const space = compactModeCheckbox?.checked ? 0 : (indentSelect?.value === 'tab' ? '\t' : parseInt(indentSelect?.value || '4'));
                const formatted = JSON.stringify(parsed, replacer, space);
                
                // Update editor content
                editor.setValue(formatted);
                
                // Update indent settings in CodeMirror
                if (!compactModeCheckbox?.checked) {
                    const indentValue = indentSelect?.value === 'tab' ? '\t' : parseInt(indentSelect?.value || '4');
                    if (indentValue === '\t') {
                        editor.setOption('indentWithTabs', true);
                    } else {
                        editor.setOption('indentWithTabs', false);
                        editor.setOption('indentUnit', indentValue);
                        editor.setOption('tabSize', indentValue);
                    }
                }
                
                // Clear any error styling
                editor.getWrapperElement().classList.remove('json-error');
            } catch (e) {
                // Show error indication
                editor.getWrapperElement().classList.add('json-error');
                console.error('JSON Error:', e.message);
                
                // Optionally show a notification
                showNotification(errorInvalidJson, 'error');
            }
        }

        function clearAll() {
            editor.setValue('');
            editor.getWrapperElement().classList.remove('json-error');
        }

        function copyToClipboard() {
            if (!copyBtn) return;
            
            const text = editor.getValue();
            navigator.clipboard.writeText(text).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = copiedText;
                setTimeout(() => {
                    copyBtn.textContent = originalText || copyButtonText;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy:', err);
            });
        }

        function showNotification(message, type = 'info') {
            // Create notification element
            const notification = document.createElement('div');
            notification.className = `json-notification json-notification-${type}`;
            notification.textContent = message;
            
            const editorWrapper = editor.getWrapperElement();
            editorWrapper.parentElement.insertBefore(notification, editorWrapper);
            
            // Auto remove after 3 seconds
            setTimeout(() => {
                notification.remove();
            }, 3000);
        }

        // Event listeners
        formatBtn.addEventListener('click', formatJSON);
        clearBtn?.addEventListener('click', clearAll);
        copyBtn?.addEventListener('click', copyToClipboard);
        
        // Auto-format on settings change (optional)
        indentSelect?.addEventListener('change', () => {
            localStorage.setItem('json-beautifier-indent', indentSelect.value);
            const value = editor.getValue().trim();
            if (value) {
                formatJSON();
            }
        });
        sortKeysCheckbox?.addEventListener('change', () => {
            localStorage.setItem('json-beautifier-sort-keys', sortKeysCheckbox.checked);
            const value = editor.getValue().trim();
            if (value) {
                formatJSON();
            }
        });
        compactModeCheckbox?.addEventListener('change', () => {
            localStorage.setItem('json-beautifier-compact-mode', compactModeCheckbox.checked);
            const value = editor.getValue().trim();
            if (value) {
                formatJSON();
            }
        });

        // Keyboard shortcuts
        editor.setOption('extraKeys', {
            'Ctrl-Enter': formatJSON,
            'Cmd-Enter': formatJSON,
            'Ctrl-K': clearAll,
            'Cmd-K': clearAll
        });
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
