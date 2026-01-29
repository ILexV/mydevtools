/* global document, window, Blob, URL, FileReader, Uint8Array, Image */

(function () {
    let wasmModule = null;
    let wasmInitPromise = null;

    async function ensureWasm() {
        if (!wasmInitPromise) {
            wasmInitPromise = import('/wasm/image_tools/image_tools.js').then(async (m) => {
                await m.default();
                wasmModule = m;
                return m;
            });
        }
        return wasmInitPromise;
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function getElements() {
        const root = document.getElementById('image-resizer-root');
        if (!root) return null;

        return {
            root,
            fileInput: document.getElementById('ir-input-file'),
            dropZone: document.getElementById('ir-drop-zone'),
            widthInput: document.getElementById('ir-width'),
            heightInput: document.getElementById('ir-height'),
            lockRatioCheckbox: document.getElementById('ir-lock-ratio'),
            resizeBtn: document.getElementById('ir-resize-btn'),
            outputSection: document.getElementById('ir-output-section'),
            previewContainer: document.getElementById('ir-preview-container'),
            downloadBtn: document.getElementById('ir-download-btn'),
            errorEl: document.getElementById('ir-error'),
            errorText: document.getElementById('ir-error-text'),
            originalInfo: document.getElementById('ir-original-info'),
            formatSelect: document.getElementById('ir-format-select'),
            settingsPanel: document.getElementById('ir-settings-panel'),
            outputInfo: document.getElementById('ir-output-info')
        };
    }

    let currentFile = null;
    let originalWidth = 0;
    let originalHeight = 0;
    let currentObjectUrl = null;

    function showError(els, msg) {
        if (!els.errorEl) return;
        if (els.errorText) els.errorText.textContent = msg;
        els.errorEl.classList.remove('hidden');
        els.errorEl.style.display = 'flex';
        els.outputSection.classList.add('hidden');
        els.outputSection.style.display = 'none';
    }

    function clearError(els) {
        if (!els.errorEl) return;
        els.errorEl.classList.add('hidden');
        els.errorEl.style.display = 'none';
    }

    async function handleFileSelect(file) {
        const els = getElements();
        if (!els || !file) return;

        if (!file.type.match('image.*')) {
            showError(els, 'Selected file is not an image.');
            return;
        }

        currentFile = file;
        clearError(els);
        els.resizeBtn.disabled = true;
        els.outputSection.classList.add('hidden');
        els.outputSection.style.display = 'none';

        if (els.settingsPanel) {
            els.settingsPanel.classList.remove('hidden');
            els.settingsPanel.style.display = 'block';
        }

        const img = new Image();
        const url = URL.createObjectURL(file);

        img.onload = () => {
            originalWidth = img.width;
            originalHeight = img.height;
            URL.revokeObjectURL(url);

            els.widthInput.value = originalWidth;
            els.heightInput.value = originalHeight;
            els.originalInfo.textContent = `${file.name} (${originalWidth}x${originalHeight}, ${formatBytes(file.size)})`;

            // Guess format
            const ext = file.name.split('.').pop().toLowerCase();
            if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
                els.formatSelect.value = ext === 'jpg' ? 'jpeg' : ext;
            } else {
                els.formatSelect.value = 'png';
            }

            els.resizeBtn.disabled = false;
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            showError(els, 'Failed to load image.');
        };

        img.src = url;
    }

    function handleResizeInput(type) {
        const els = getElements();
        if (!els || !els.lockRatioCheckbox.checked || originalWidth === 0 || originalHeight === 0) return;

        const w = parseInt(els.widthInput.value) || 0;
        const h = parseInt(els.heightInput.value) || 0;
        const ratio = originalWidth / originalHeight;

        if (type === 'width' && w > 0) {
            els.heightInput.value = Math.round(w / ratio);
        } else if (type === 'height' && h > 0) {
            els.widthInput.value = Math.round(h * ratio);
        }
    }

    async function performResize() {
        const els = getElements();
        if (!els || !currentFile) return;

        const width = parseInt(els.widthInput.value);
        const height = parseInt(els.heightInput.value);
        const format = els.formatSelect.value;
        const strings = {
            resizing: els.resizeBtn.dataset.processing || 'Resizing...',
            resize: els.resizeBtn.dataset.original || 'Resize'
        };

        if (!width || !height) {
            showError(els, 'Invalid dimensions.');
            return;
        }

        els.resizeBtn.disabled = true;
        els.resizeBtn.textContent = strings.resizing;
        clearError(els);

        try {
            await ensureWasm();

            const buffer = await currentFile.arrayBuffer();
            const bytes = new Uint8Array(buffer);

            const resultBytes = wasmModule.resize_image(bytes, width, height, format);

            const mimeType = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : `image/${format}`;
            const blob = new Blob([resultBytes], { type: mimeType });

            if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = URL.createObjectURL(blob);

            // Show Result
            els.previewContainer.innerHTML = '';
            const img = document.createElement('img');
            img.src = currentObjectUrl;
            img.className = 'max-w-full max-h-full rounded shadow-sm';
            img.style.objectFit = 'contain';
            els.previewContainer.appendChild(img);

            if (els.outputInfo) {
                els.outputInfo.textContent = `${width}x${height}, ${formatBytes(blob.size)}`;
            }

            const originalName = currentFile.name;
            const dotIdx = originalName.lastIndexOf('.');
            const base = dotIdx !== -1 ? originalName.substring(0, dotIdx) : originalName;
            const ext = format === 'jpeg' ? 'jpg' : format;

            els.downloadBtn.onclick = () => {
                const a = document.createElement('a');
                a.href = currentObjectUrl;
                a.download = `${base}_${width}x${height}.${ext}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            };

            els.outputSection.classList.remove('hidden');
            els.outputSection.style.display = 'block';

        } catch (err) {
            console.error(err);
            showError(els, typeof err === 'string' ? err : 'Resize failed.');
        } finally {
            els.resizeBtn.disabled = false;
            els.resizeBtn.textContent = strings.resize;
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__imageResizerBound) return;
        window.__imageResizerBound = true;

        document.addEventListener('change', (e) => {
            if (e.target.id === 'ir-input-file') {
                if (e.target.files && e.target.files[0]) {
                    handleFileSelect(e.target.files[0]);
                }
            }
        });

        document.addEventListener('input', (e) => {
            if (e.target.id === 'ir-width') handleResizeInput('width');
            if (e.target.id === 'ir-height') handleResizeInput('height');
        });

        document.addEventListener('click', (e) => {
            const resizeBtn = e.target.closest('#ir-resize-btn');
            if (resizeBtn) {
                e.preventDefault();
                performResize();
            }
        });

        document.addEventListener('dragover', (e) => {
            if (e.target.closest('#ir-drop-zone')) {
                e.preventDefault();
                // optional: visual feedback
            }
        });

        document.addEventListener('drop', (e) => {
            const drop = e.target.closest('#ir-drop-zone');
            if (drop) {
                e.preventDefault();
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    handleFileSelect(e.dataTransfer.files[0]);
                }
            }
        });
    }

    bindDelegatedHandlersOnce();

    function init() {
        // Initialization if needed
    }

    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
