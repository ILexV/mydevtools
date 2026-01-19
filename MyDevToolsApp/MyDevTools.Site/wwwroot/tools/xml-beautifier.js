/* global document, CodeMirror */

(function () {
    const initializedRoots = new WeakSet();

    function initXmlBeautifier(root) {
        if (initializedRoots.has(root)) return;

        if (typeof CodeMirror === 'undefined') {
            console.log('XML Beautifier: CodeMirror not loaded yet, waiting...');
            setTimeout(() => initXmlBeautifier(root), 100);
            return;
        }

        initializedRoots.add(root);

        const editorElement = root.querySelector('#xml-editor');
        const formatBtn = root.querySelector('#xml-format-btn');
        const clearBtn = root.querySelector('#xml-clear-btn');
        const copyBtn = root.querySelector('#xml-copy-btn');
        const indentSelect = root.querySelector('#xml-indent-select');
        const compactModeCheckbox = root.querySelector('#xml-compact-mode');

        const errorInvalidXml = root.getAttribute('data-error-invalid-xml') || 'Invalid XML. Please check your input.';
        const copiedText = root.getAttribute('data-copied') || 'Copied!';
        const copyButtonText = root.getAttribute('data-copy-button') || 'Copy';
        const placeholder = root.getAttribute('data-input-placeholder') || 'Paste your XML here...';

        if (!editorElement || !formatBtn || typeof CodeMirror === 'undefined') {
            console.error('XML Beautifier: Required elements or CodeMirror not found');
            return;
        }

        const editor = CodeMirror(editorElement, {
            mode: 'text/plain',
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

        editor.setSize(null, '600px');

        function updateEditorTheme() {
            editor.refresh();
        }

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

        updateEditorTheme();

        function formatXmlString(input, indentValue, compactMode) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(input, 'application/xml');
            const parseError = doc.getElementsByTagName('parsererror');
            if (parseError && parseError.length > 0) {
                throw new Error('Invalid XML');
            }

            const declarationMatch = input.match(/^\s*(<\?xml[^>]+\?>)/i);
            const declaration = declarationMatch ? declarationMatch[1].trim() : null;

            if (compactMode) {
                const parts = [];
                if (declaration) {
                    parts.push(declaration);
                }
                if (doc.doctype) {
                    parts.push(formatDoctype(doc.doctype));
                }
                const rootElement = doc.documentElement;
                if (rootElement) {
                    parts.push(serializeCompactNode(rootElement));
                }
                return parts.join('\n');
            }

            const indentUnit = indentValue === '\t' ? '\t' : ' '.repeat(indentValue);
            const lines = [];

            if (declaration) {
                lines.push(declaration);
            }

            if (doc.doctype) {
                lines.push(formatDoctype(doc.doctype));
            }

            const rootElement = doc.documentElement;
            if (rootElement) {
                serializeNode(rootElement, 0, lines, indentUnit);
            }

            return lines.join('\n');
        }

        function formatDoctype(doctype) {
            if (!doctype) return '';
            let id = '';
            if (doctype.publicId) {
                id += ` PUBLIC "${doctype.publicId}"`;
                if (doctype.systemId) {
                    id += ` "${doctype.systemId}"`;
                }
            } else if (doctype.systemId) {
                id += ` SYSTEM "${doctype.systemId}"`;
            }
            return `<!DOCTYPE ${doctype.name}${id}>`;
        }

        function isIgnorableWhitespace(node) {
            return node.nodeType === 3 && !node.nodeValue.trim();
        }

        function escapeText(value) {
            return value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        function escapeAttribute(value) {
            return value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');
        }

        function serializeNode(node, depth, lines, indentUnit) {
            const indent = indentUnit.repeat(depth);

            switch (node.nodeType) {
                case 1: { // ELEMENT_NODE
                    const attributes = Array.from(node.attributes || []).map(attr => {
                        return `${attr.name}="${escapeAttribute(attr.value)}"`;
                    }).join(' ');

                    const name = node.nodeName;
                    const openTag = attributes ? `<${name} ${attributes}>` : `<${name}>`;
                    const children = Array.from(node.childNodes || []).filter(child => !isIgnorableWhitespace(child));

                    if (children.length === 0) {
                        lines.push(indent + (attributes ? `<${name} ${attributes}/>` : `<${name}/>`));
                        return;
                    }

                    if (children.length === 1 && children[0].nodeType === 3) {
                        const text = escapeText(children[0].nodeValue.trim());
                        lines.push(indent + openTag + text + `</${name}>`);
                        return;
                    }

                    lines.push(indent + openTag);
                    children.forEach(child => serializeNode(child, depth + 1, lines, indentUnit));
                    lines.push(indent + `</${name}>`);
                    return;
                }
                case 3: { // TEXT_NODE
                    const text = node.nodeValue.trim();
                    if (text) {
                        lines.push(indent + escapeText(text));
                    }
                    return;
                }
                case 4: { // CDATA_SECTION_NODE
                    lines.push(indent + `<![CDATA[${node.nodeValue}]]>`);
                    return;
                }
                case 8: { // COMMENT_NODE
                    lines.push(indent + `<!--${node.nodeValue}-->`);
                    return;
                }
                case 7: { // PROCESSING_INSTRUCTION_NODE
                    lines.push(indent + `<?${node.target} ${node.data}?>`);
                    return;
                }
                default:
                    return;
            }
        }

        function serializeCompactNode(node) {
            switch (node.nodeType) {
                case 1: { // ELEMENT_NODE
                    const attributes = Array.from(node.attributes || []).map(attr => {
                        return `${attr.name}="${escapeAttribute(attr.value)}"`;
                    }).join(' ');

                    const name = node.nodeName;
                    const openTag = attributes ? `<${name} ${attributes}>` : `<${name}>`;
                    const children = Array.from(node.childNodes || []).filter(child => !isIgnorableWhitespace(child));

                    if (children.length === 0) {
                        return attributes ? `<${name} ${attributes}/>` : `<${name}/>`;
                    }

                    const inner = children.map(child => serializeCompactNode(child)).join('');
                    return openTag + inner + `</${name}>`;
                }
                case 3: { // TEXT_NODE
                    return escapeText(node.nodeValue);
                }
                case 4: { // CDATA_SECTION_NODE
                    return `<![CDATA[${node.nodeValue}]]>`;
                }
                case 8: { // COMMENT_NODE
                    return `<!--${node.nodeValue}-->`;
                }
                case 7: { // PROCESSING_INSTRUCTION_NODE
                    return `<?${node.target} ${node.data}?>`;
                }
                default:
                    return '';
            }
        }

        function formatXml() {
            const input = editor.getValue().trim();
            if (!input) {
                return;
            }

            try {
                const indentValue = indentSelect?.value === 'tab' ? '\t' : parseInt(indentSelect?.value || '4');
                const formatted = formatXmlString(input, indentValue, compactModeCheckbox?.checked);

                editor.setValue(formatted);

                if (!compactModeCheckbox?.checked) {
                    if (indentValue === '\t') {
                        editor.setOption('indentWithTabs', true);
                    } else {
                        editor.setOption('indentWithTabs', false);
                        editor.setOption('indentUnit', indentValue);
                        editor.setOption('tabSize', indentValue);
                    }
                }

                editorElement.classList.remove('xml-error');
            } catch (e) {
                editorElement.classList.add('xml-error');
                console.error('XML Error:', e.message);
                showNotification(errorInvalidXml, 'error');
            }
        }

        function clearAll() {
            editor.setValue('');
            editorElement.classList.remove('xml-error');
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
            const notification = document.createElement('div');
            notification.className = `xml-notification xml-notification-${type}`;
            notification.textContent = message;

            const editorWrapper = editor.getWrapperElement();
            editorWrapper.parentElement.insertBefore(notification, editorWrapper);

            setTimeout(() => {
                notification.remove();
            }, 3000);
        }

        formatBtn.addEventListener('click', formatXml);
        clearBtn?.addEventListener('click', clearAll);
        copyBtn?.addEventListener('click', copyToClipboard);

        indentSelect?.addEventListener('change', () => {
            const value = editor.getValue().trim();
            if (value) {
                formatXml();
            }
        });
        compactModeCheckbox?.addEventListener('change', () => {
            const value = editor.getValue().trim();
            if (value) {
                formatXml();
            }
        });

        editor.setOption('extraKeys', {
            'Ctrl-Enter': formatXml,
            'Cmd-Enter': formatXml,
            'Ctrl-K': clearAll,
            'Cmd-K': clearAll
        });
    }

    function observeTools() {
        const observer = new MutationObserver(() => {
            document.querySelectorAll('#xml-beautifier-root').forEach(root => {
                initXmlBeautifier(root);
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        document.querySelectorAll('#xml-beautifier-root').forEach(root => {
            initXmlBeautifier(root);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeTools);
    } else {
        observeTools();
    }
})();
