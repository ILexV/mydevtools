let inputEditor, outputEditor;

var wasmModulePromise = null;

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

    // Initialize CodeMirror editors
    inputEditor = CodeMirror(document.getElementById('yaml-input'), {
        mode: 'yaml',
        theme: 'default',
        lineNumbers: true,
        autoCloseBrackets: true,
        matchBrackets: true,
        indentUnit: 2,
        tabSize: 2,
    });

    outputEditor = CodeMirror(document.getElementById('yaml-output'), {
        mode: 'yaml',
        theme: 'default',
        lineNumbers: true,
        readOnly: true,
    });

    const formatBtn = document.getElementById('format-yaml-btn');
    const validateBtn = document.getElementById('validate-yaml-btn');
    const clearBtn = document.getElementById('clear-yaml-btn');
    const errorDiv = document.getElementById('yaml-error');

    formatBtn.addEventListener('click', async () => {
        const yaml = inputEditor.getValue().trim();
        if (!yaml) return;

        try {
            const wasm = await getWasm();
            const result = wasm.yaml_format(yaml);
            outputEditor.setValue(result);
            errorDiv.style.display = 'none';
        } catch (e) {
            outputEditor.setValue('');
            errorDiv.textContent = e.message || 'Error formatting YAML';
            errorDiv.style.display = 'block';
        }
    });

    validateBtn.addEventListener('click', async () => {
        const yaml = inputEditor.getValue().trim();
        if (!yaml) return;

        try {
            const wasm = await getWasm();
            wasm.yaml_validate(yaml);
            outputEditor.setValue(root.dataset.valid || 'YAML is valid');
            errorDiv.style.display = 'none';
        } catch (e) {
            outputEditor.setValue('');
            errorDiv.textContent = e.message || 'YAML validation failed';
            errorDiv.style.display = 'block';
        }
    });

    clearBtn.addEventListener('click', () => {
        inputEditor.setValue('');
        outputEditor.setValue('');
        errorDiv.style.display = 'none';
    });
}