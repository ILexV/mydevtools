let inputEditor, outputEditor;
let wasmModulePromise = null;

async function getWasm() {
    if (!wasmModulePromise) {
        wasmModulePromise = import('/wasm/structured_data/structured_data.js').then(async (m) => {
            await m.default();
            return m;
        });
    }
    return wasmModulePromise;
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('enhancedload', init);

function init() {
    const root = document.getElementById('yaml-beautifier-validator-root');
    if (!root) return;

    // Initialize CodeMirror editors if not already initialized
    const inputElement = document.getElementById('yaml-input');
    const outputElement = document.getElementById('yaml-output');
    
    if (!inputElement || !outputElement) return;

    // Clear previous instances if any (for enhanced nav)
    inputElement.innerHTML = '';
    outputElement.innerHTML = '';

    inputEditor = CodeMirror(inputElement, {
        mode: 'yaml',
        theme: 'default',
        lineNumbers: true,
        autoCloseBrackets: true,
        matchBrackets: true,
        indentUnit: 2,
        tabSize: 2,
        lineWrapping: true,
        viewportMargin: Infinity
    });

    outputEditor = CodeMirror(outputElement, {
        mode: 'yaml',
        theme: 'default',
        lineNumbers: true,
        readOnly: true,
        lineWrapping: true,
        viewportMargin: Infinity
    });

    // Event delegation for buttons
    document.addEventListener('click', handleButtonClick);
}

async function handleButtonClick(e) {
    const target = e.target;
    
    // Format Button
    const formatBtn = target.closest('#format-yaml-btn');
    if (formatBtn) {
        await formatYaml();
        return;
    }

    // Validate Button
    const validateBtn = target.closest('#validate-yaml-btn');
    if (validateBtn) {
        await validateYaml();
        return;
    }

    // Clear Button
    const clearBtn = target.closest('#clear-yaml-btn');
    if (clearBtn) {
        clearEditors();
        return;
    }

    // Copy Button
    const copyBtn = target.closest('#copy-yaml-btn');
    if (copyBtn) {
        copyOutput(copyBtn);
        return;
    }

    // Paste Button
    const pasteBtn = target.closest('#paste-yaml-btn');
    if (pasteBtn) {
        await pasteInput();
        return;
    }
}

async function formatYaml() {
    const root = document.getElementById('yaml-beautifier-validator-root');
    const errorDiv = document.getElementById('yaml-error');
    if (!inputEditor || !root || !errorDiv) return;

    const yaml = inputEditor.getValue().trim();
    if (!yaml) return;

    try {
        const wasm = await getWasm();
        const result = wasm.yaml_format(yaml);
        outputEditor.setValue(result);
        showError(null); // Hide error
    } catch (e) {
        outputEditor.setValue('');
        showError(e.message || 'Error formatting YAML');
    }
}

async function validateYaml() {
    const root = document.getElementById('yaml-beautifier-validator-root');
    const errorDiv = document.getElementById('yaml-error');
    if (!inputEditor || !root || !errorDiv) return;

    const yaml = inputEditor.getValue().trim();
    if (!yaml) return;

    try {
        const wasm = await getWasm();
        // Assuming validate returns nothing on success and throws on error
        // Or it might return a boolean/string. Based on previous code:
        // wasm.yaml_validate(yaml); -> throws if invalid
        
        try {
             wasm.yaml_validate(yaml);
             outputEditor.setValue(root.dataset.valid || 'YAML is valid');
             showError(null);
        } catch (validationError) {
             throw validationError;
        }

    } catch (e) {
        outputEditor.setValue('');
        showError(e.message || 'YAML validation failed');
    }
}

function clearEditors() {
    if (inputEditor) inputEditor.setValue('');
    if (outputEditor) outputEditor.setValue('');
    showError(null);
}

function showError(message) {
    const errorDiv = document.getElementById('yaml-error');
    if (!errorDiv) return;
    
    if (message) {
        errorDiv.querySelector('.error-text').textContent = message;
        errorDiv.style.display = 'flex';
        errorDiv.classList.remove('hidden');
    } else {
        errorDiv.style.display = 'none';
        errorDiv.classList.add('hidden');
    }
}

async function copyOutput(btn) {
    if (!outputEditor) return;
    const text = outputEditor.getValue();
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
        console.error('Failed to copy:', err);
    }
}

async function pasteInput() {
    if (!inputEditor) return;
    try {
        const text = await navigator.clipboard.readText();
        inputEditor.setValue(text);
    } catch (err) {
        console.error('Failed to paste:', err);
    }
}
