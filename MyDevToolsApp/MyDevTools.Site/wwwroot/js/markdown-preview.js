(function() {
    'use strict';

    function init() {
        const root = document.getElementById('markdown-preview-root');
        if (!root) return;

        const input = document.getElementById('markdown-input');
        const output = document.getElementById('markdown-output');
        const errorDiv = document.getElementById('markdown-error');

        // Check if elements exist
        if (!input || !output || !errorDiv) return;

        // Toolbar buttons
        const boldBtn = document.getElementById('md-bold');
        const italicBtn = document.getElementById('md-italic');
        const headingBtn = document.getElementById('md-heading');
        const linkBtn = document.getElementById('md-link');
        const imageBtn = document.getElementById('md-image');
        const codeBtn = document.getElementById('md-code');
        const listBtn = document.getElementById('md-list');
        const clearBtn = document.getElementById('md-clear');

        // Action buttons
        const copyHtmlBtn = document.getElementById('md-copy-html');
        const copyMdBtn = document.getElementById('md-copy-md');
        const downloadBtn = document.getElementById('md-download');

        // Configure marked options for parsing
        const markedOptions = {
            breaks: true,
            gfm: true,
            headerIds: true,
            mangle: false
        };

        // Default markdown content
        const defaultMarkdown = '# Welcome to Markdown Preview\n\n' +
'## Features\n\n' +
'- **Live preview** as you type\n' +
'- Support for **GitHub Flavored Markdown** (GFM)\n' +
'- Code syntax highlighting\n' +
'- Tables, lists, and more\n\n' +
'### Example Code Block\n\n' +
'```javascript\n' +
'function greet(name) {\n' +
'    console.log(`Hello, ${name}!`);\n' +
'}\n' +
'```\n\n' +
'### Example Table\n\n' +
'| Feature | Supported |\n' +
'|---------|-----------|\\n' +
'| Headers | ✅ |\n' +
'| Lists   | ✅ |\n' +
'| Links   | ✅ |\n' +
'| Images  | ✅ |\n\n' +
'### Example Link\n\n' +
'[Visit MyDevTools](https://mydevtools.app)\n\n' +
'---\n\n' +
'*Start typing in the editor to see your markdown rendered!*';

        // Initialize with default content only if empty
        if (!input.value) {
            input.value = defaultMarkdown;
        }

        function renderMarkdown() {
            try {
                const markdown = input.value;
                if (typeof marked !== 'undefined') {
                    output.innerHTML = marked.parse(markdown, markedOptions);
                } else {
                    output.innerHTML = '<p style="color: red;">Marked.js library failed to load. Please refresh the page.</p>';
                }
                hideError();
            } catch (error) {
                showError('Error rendering markdown: ' + error.message);
            }
        }

        function insertAtCursor(before, after) {
            after = after || '';
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const selectedText = input.value.substring(start, end);
            const newText = before + selectedText + after;
            
            input.value = input.value.substring(0, start) + newText + input.value.substring(end);
            
            // Set cursor position
            const newCursorPos = start + before.length + selectedText.length;
            input.setSelectionRange(newCursorPos, newCursorPos);
            input.focus();
            renderMarkdown();
        }

        function insertAtLine(prefix) {
            const start = input.selectionStart;
            const lines = input.value.split('\n');
            let currentPos = 0;
            let lineIndex = 0;

            // Find current line
            for (let i = 0; i < lines.length; i++) {
                if (currentPos + lines[i].length >= start) {
                    lineIndex = i;
                    break;
                }
                currentPos += lines[i].length + 1; // +1 for newline
            }

            // Insert prefix at beginning of line
            lines[lineIndex] = prefix + lines[lineIndex];
            input.value = lines.join('\n');
            
            const newCursorPos = start + prefix.length;
            input.setSelectionRange(newCursorPos, newCursorPos);
            input.focus();
            renderMarkdown();
        }

        function showError(message) {
            errorDiv.textContent = message;
            errorDiv.style.display = '';
        }

        function hideError() {
            errorDiv.style.display = 'none';
        }

        async function copyToClipboard(text, button) {
            try {
                await navigator.clipboard.writeText(text);
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                setTimeout(function() { button.textContent = originalText; }, 2000);
            } catch (err) {
                showError('Failed to copy to clipboard');
            }
        }

        function downloadAsHTML() {
            const htmlContent = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'    <title>Markdown Preview</title>\n' +
'    <style>\n' +
'        body {\n' +
'            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\n' +
'            line-height: 1.6;\n' +
'            max-width: 800px;\n' +
'            margin: 2rem auto;\n' +
'            padding: 0 1rem;\n' +
'            color: #333;\n' +
'        }\n' +
'        code {\n' +
'            background: #f4f4f4;\n' +
'            padding: 0.2em 0.4em;\n' +
'            border-radius: 3px;\n' +
'            font-family: "Courier New", monospace;\n' +
'        }\n' +
'        pre {\n' +
'            background: #f4f4f4;\n' +
'            padding: 1rem;\n' +
'            border-radius: 5px;\n' +
'            overflow-x: auto;\n' +
'        }\n' +
'        pre code {\n' +
'            background: none;\n' +
'            padding: 0;\n' +
'        }\n' +
'        table {\n' +
'            border-collapse: collapse;\n' +
'            width: 100%;\n' +
'            margin: 1rem 0;\n' +
'        }\n' +
'        th, td {\n' +
'            border: 1px solid #ddd;\n' +
'            padding: 0.5rem;\n' +
'            text-align: left;\n' +
'        }\n' +
'        th {\n' +
'            background: #f4f4f4;\n' +
'        }\n' +
'        blockquote {\n' +
'            border-left: 4px solid #ddd;\n' +
'            padding-left: 1rem;\n' +
'            margin-left: 0;\n' +
'            color: #666;\n' +
'        }\n' +
'        img {\n' +
'            max-width: 100%;\n' +
'        }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
output.innerHTML +
'\n</body>\n' +
'</html>';

            const blob = new Blob([htmlContent], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'markdown-preview.html';
            a.click();
            URL.revokeObjectURL(url);
        }

        // Event listeners - use onclick to avoid duplicates with Blazor navigation
        input.oninput = renderMarkdown;

        if (boldBtn) boldBtn.onclick = function() { insertAtCursor('**', '**'); };
        if (italicBtn) italicBtn.onclick = function() { insertAtCursor('*', '*'); };
        if (headingBtn) headingBtn.onclick = function() { insertAtLine('## '); };
        if (linkBtn) linkBtn.onclick = function() { insertAtCursor('[', '](url)'); };
        if (imageBtn) imageBtn.onclick = function() { insertAtCursor('![alt text](', ')'); };
        if (codeBtn) codeBtn.onclick = function() { insertAtCursor('`', '`'); };
        if (listBtn) listBtn.onclick = function() { insertAtLine('- '); };

        if (clearBtn) clearBtn.onclick = function() {
            input.value = '';
            renderMarkdown();
        };

        if (copyHtmlBtn) copyHtmlBtn.onclick = function() {
            copyToClipboard(output.innerHTML, copyHtmlBtn);
        };

        if (copyMdBtn) copyMdBtn.onclick = function() {
            copyToClipboard(input.value, copyMdBtn);
        };

        if (downloadBtn) downloadBtn.onclick = downloadAsHTML;

        // Initial render
        renderMarkdown();
    }

    // Handle Blazor enhanced navigation
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    window.addEventListener('pageshow', init);
})();
