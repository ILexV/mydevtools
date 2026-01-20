/* global document, CodeMirror */

(function () {
    function initXmlBeautifier(root) {
        // STATELESS CHECK: logic moved from WeakSet to DOM inspection.
        if (root.querySelector('.CodeMirror')) return;

        if (typeof CodeMirror === 'undefined') {
            console.log('XML Beautifier: CodeMirror not loaded yet, waiting...');
            setTimeout(() => initXmlBeautifier(root), 100);
            return;
        }

        if (!CodeMirror.modes.simplexml) {
            CodeMirror.defineMode('simplexml', function () {
                function startState() {
                    return {
                        inTag: false,
                        inComment: false,
                        inCdata: false,
                        inProcessing: false
                    };
                }

                function token(stream, state) {
                    if (state.inComment) {
                        if (stream.skipTo('-->')) {
                            stream.match('-->');
                            state.inComment = false;
                        } else {
                            stream.skipToEnd();
                        }
                        return 'comment';
                    }

                    if (state.inCdata) {
                        if (stream.skipTo(']]>')) {
                            stream.match(']]>');
                            state.inCdata = false;
                        } else {
                            stream.skipToEnd();
                        }
                        return 'atom';
                    }

                    if (state.inProcessing) {
                        if (stream.skipTo('?>')) {
                            stream.match('?>');
                            state.inProcessing = false;
                        } else {
                            stream.skipToEnd();
                        }
                        return 'meta';
                    }

                    if (state.inTag) {
                        if (stream.match(/^\s*\/?>/)) {
                            state.inTag = false;
                            return 'tag';
                        }

                        if (stream.match(/^\s+[\w:-]+/)) {
                            return 'attribute';
                        }

                        if (stream.match(/^\s*=\s*/)) {
                            return null;
                        }

                        if (stream.match(/^\s*"(?:[^"\\]|\\.)*"/)) {
                            return 'string';
                        }

                        if (stream.match(/^\s*'(?:[^'\\]|\\.)*'/)) {
                            return 'string';
                        }

                        stream.next();
                        return null;
                    }

                    if (stream.match('<!--')) {
                        state.inComment = true;
                        return 'comment';
                    }

                    if (stream.match('<![CDATA[')) {
                        state.inCdata = true;
                        return 'atom';
                    }

                    if (stream.match('<?')) {
                        state.inProcessing = true;
                        return 'meta';
                    }

                    if (stream.match('</')) {
                        state.inTag = true;
                        return 'tag';
                    }

                    if (stream.match('<')) {
                        state.inTag = true;
                        return 'tag';
                    }

                    stream.eatWhile(/[^<]/);
                    return null;
                }

                return {
                    startState: startState,
                    token: token
                };
            });

            CodeMirror.defineMIME('application/xml', 'simplexml');

            const openTagRegex = /<([A-Za-z_][\w:.-]*)(?=\s|>|\/)/g;
            const closeTagRegex = /<\/([A-Za-z_][\w:.-]*)\s*>/g;

            function findOpeningTag(line) {
                let match;
                while ((match = openTagRegex.exec(line)) !== null) {
                    const isClosing = line.slice(match.index - 1, match.index + 2) === '</';
                    const isSelfClosing = /\/\s*>/.test(line.slice(match.index));
                    if (!isClosing && !isSelfClosing) {
                        return { name: match[1], ch: match.index };
                    }
                }
                return null;
            }

            function countTagOccurrences(line, tagName) {
                let openCount = 0;
                let closeCount = 0;

                const openRegex = new RegExp(`<${tagName}(?=\\s|>|\\/)`, 'g');
                const closeRegex = new RegExp(`</${tagName}\\s*>`, 'g');
                const selfClosingRegex = new RegExp(`<${tagName}(?:\\s[^>]*)?\\s*/>`, 'g');

                openCount += (line.match(openRegex) || []).length;
                closeCount += (line.match(closeRegex) || []).length;
                const selfClosingCount = (line.match(selfClosingRegex) || []).length;
                openCount -= selfClosingCount;

                return { openCount, closeCount };
            }

            function xmlFoldHelper(cm, start) {
                const startLine = start.line;
                const lineText = cm.getLine(startLine);
                if (!lineText) return null;

                openTagRegex.lastIndex = 0;
                const opening = findOpeningTag(lineText);
                if (!opening) return null;

                const tagName = opening.name;
                let depth = 0;
                let foundStart = false;

                for (let line = startLine; line < cm.lineCount(); line += 1) {
                    const text = cm.getLine(line);
                    if (!text) continue;

                    const counts = countTagOccurrences(text, tagName);
                    if (line === startLine) {
                        depth += 1;
                        foundStart = true;
                    } else if (foundStart) {
                        depth += counts.openCount;
                    }

                    depth -= counts.closeCount;

                    if (foundStart && depth === 0) {
                        closeTagRegex.lastIndex = 0;
                        const closeMatch = closeTagRegex.exec(text);
                        const closeCh = closeMatch ? closeMatch.index : text.length;
                        return {
                            from: CodeMirror.Pos(startLine, opening.ch),
                            to: CodeMirror.Pos(line, closeCh)
                        };
                    }
                }

                return null;
            }

            CodeMirror.registerHelper('fold', 'simplexml', xmlFoldHelper);
            CodeMirror.fold.simplexml = xmlFoldHelper;
        }

        const editorElement = root.querySelector('#xml-editor');
        const formatBtn = root.querySelector('#xml-format-btn');
        // ... (other element queries happen here, but we check critical ones below)

        // FAIL-SAFE: Do not mark as initialized if critical elements are missing.
        // This allows the observer to try again when Blazor finishes rendering content.
        if (!editorElement || !formatBtn) {
            // console.warn('XML Beautifier: Required elements not found yet, retrying...');
            return;
        }

        // We no longer use initializedRoots.add(root);
        // The presence of the CodeMirror DOM elements acts as our "initialized" flag.

        const clearBtn = root.querySelector('#xml-clear-btn');
        const copyBtn = root.querySelector('#xml-copy-btn');
        const indentSelect = root.querySelector('#xml-indent-select');
        const compactModeCheckbox = root.querySelector('#xml-compact-mode');
        const openFileBtn = root.querySelector('#xml-open-file-btn');
        const saveFileBtn = root.querySelector('#xml-save-file-btn');
        const fileInput = root.querySelector('#xml-file-input');

        const errorInvalidXml = root.getAttribute('data-error-invalid-xml') || 'Invalid XML. Please check your input.';
        const copiedText = root.getAttribute('data-copied') || 'Copied!';
        const copyButtonText = root.getAttribute('data-copy-button') || 'Copy';
        const placeholder = root.getAttribute('data-input-placeholder') || 'Paste your XML here...';

        const editor = CodeMirror(editorElement, {
            mode: { name: 'simplexml' },
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
            foldOptions: {
                rangeFinder: CodeMirror.fold.simplexml
            },
            gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"]
        });

        editor.setSize(null, '600px');

        // Load saved XML from localStorage
        const savedXml = localStorage.getItem('xml-beautifier-input');
        if (savedXml) {
            editor.setValue(savedXml);
        }

        // Load saved settings
        const savedIndent = localStorage.getItem('xml-beautifier-indent');
        if (savedIndent && indentSelect) {
            indentSelect.value = savedIndent;
        }
        const savedCompactMode = localStorage.getItem('xml-beautifier-compact-mode');
        if (savedCompactMode && compactModeCheckbox) {
            compactModeCheckbox.checked = savedCompactMode === 'true';
        }

        // Save to localStorage on change
        editor.on('change', () => {
            localStorage.setItem('xml-beautifier-input', editor.getValue());
        });

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

        function openFile() {
            fileInput.click();
        }

        function handleFileSelect(event) {
            const file = event.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    editor.setValue(e.target.result);
                };
                reader.readAsText(file);
            }
        }

        function saveFile() {
            const text = editor.getValue();
            const blob = new Blob([text], { type: 'application/xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'formatted.xml';
            a.click();
            URL.revokeObjectURL(url);
        }

        formatBtn.addEventListener('click', formatXml);
        clearBtn?.addEventListener('click', clearAll);
        copyBtn?.addEventListener('click', copyToClipboard);
        openFileBtn?.addEventListener('click', openFile);
        fileInput?.addEventListener('change', handleFileSelect);
        saveFileBtn?.addEventListener('click', saveFile);

        indentSelect?.addEventListener('change', () => {
            localStorage.setItem('xml-beautifier-indent', indentSelect.value);
            const value = editor.getValue().trim();
            if (value) {
                formatXml();
            }
        });
        compactModeCheckbox?.addEventListener('change', () => {
            localStorage.setItem('xml-beautifier-compact-mode', compactModeCheckbox.checked);
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

        // Drag and drop
        editorElement.addEventListener('dragover', (e) => {
            e.preventDefault();
            editorElement.classList.add('drag-over');
        });
        editorElement.addEventListener('dragleave', (e) => {
            e.preventDefault();
            editorElement.classList.remove('drag-over');
        });
        editorElement.addEventListener('drop', (e) => {
            e.preventDefault();
            editorElement.classList.remove('drag-over');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                if (file.type === 'application/xml' || file.name.endsWith('.xml')) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        editor.setValue(e.target.result);
                    };
                    reader.readAsText(file);
                }
            }
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
