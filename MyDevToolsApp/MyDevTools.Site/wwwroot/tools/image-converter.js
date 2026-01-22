/* global document, window, URL, Blob */

(function () {
    let wasmModulePromise = null;

    async function getWasmModule() {
        if (!wasmModulePromise) {
            wasmModulePromise = import('/wasm/image_tools/image_tools.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return wasmModulePromise;
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function getElements() {
        const root = document.getElementById('image-converter-root');
        if (!root) return null;

        const inputFile = document.getElementById('ic-input-file');
        const formatSelect = document.getElementById('ic-format-select');
        const convertBtn = document.getElementById('ic-convert-btn');
        const outputSection = document.getElementById('ic-output-section');
        const previewContainer = document.getElementById('ic-preview-container');
        const downloadBtn = document.getElementById('ic-download-btn');
        const errorEl = document.getElementById('ic-error');
        
        // New elements
        const qualityContainer = document.getElementById('ic-quality-container');
        const qualityInput = document.getElementById('ic-quality');
        const qualityValue = document.getElementById('ic-quality-value');
        const outputSize = document.getElementById('ic-output-size');

        if (!inputFile || !formatSelect || !convertBtn || !outputSection || !previewContainer || !downloadBtn || !errorEl) {
            return null;
        }

        return { 
            root, inputFile, formatSelect, convertBtn, outputSection, previewContainer, downloadBtn, errorEl,
            qualityContainer, qualityInput, qualityValue, outputSize
        };
    }

    function getStrings(root) {
        return {
            processing: root.dataset.loading || 'Processing...',
            error: root.dataset.error || 'Error',
            convert: document.querySelector('#ic-convert-btn')?.textContent || 'Convert'
        };
    }

    function showError(els, message) {
        els.errorEl.textContent = message;
        els.errorEl.hidden = false;
        els.outputSection.hidden = true;
    }

    function clearError(els) {
        els.errorEl.textContent = '';
        els.errorEl.hidden = true;
    }

    let currentObjectUrl = null;

    async function handleConvert() {
        const els = getElements();
        if (!els) return;

        const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
        if (!file) {
            showError(els, 'Please select an image file first.');
            return;
        }

        const targetFormat = els.formatSelect.value;
        const quality = parseInt(els.qualityInput ? els.qualityInput.value : '90', 10);
        const strings = getStrings(els.root);

        clearError(els);
        els.convertBtn.disabled = true;
        const originalBtnText = els.convertBtn.textContent;
        els.convertBtn.textContent = strings.processing;
        els.outputSection.hidden = true;

        try {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);

            const wasm = await getWasmModule();
            
            // Call WASM function
            // fn convert_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String>
            const resultBytes = wasm.convert_image(bytes, targetFormat, quality);

            // Create Blob and ObjectURL
            let mimeType = `image/${targetFormat}`;
            if (targetFormat === 'jpg' || targetFormat === 'jpeg') mimeType = 'image/jpeg';
            if (targetFormat === 'ico') mimeType = 'image/x-icon';

            const blob = new Blob([resultBytes], { type: mimeType });

            if (currentObjectUrl) {
                URL.revokeObjectURL(currentObjectUrl);
            }
            currentObjectUrl = URL.createObjectURL(blob);

            // Display result
            els.previewContainer.innerHTML = '';
            const img = document.createElement('img');
            img.src = currentObjectUrl;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '400px';
            img.style.border = '1px solid #ccc';
            els.previewContainer.appendChild(img);

            // Update output size
            if (els.outputSize) {
                els.outputSize.textContent = formatBytes(blob.size);
            }

            // Setup download button
            const originalName = file.name;
            const lastDot = originalName.lastIndexOf('.');
            const nameWithoutExt = lastDot !== -1 ? originalName.substring(0, lastDot) : originalName;
            const newFilename = `${nameWithoutExt}.${targetFormat === 'jpeg' ? 'jpg' : targetFormat}`;

            els.downloadBtn.dataset.downloadUrl = currentObjectUrl;
            els.downloadBtn.dataset.filename = newFilename;

            els.outputSection.hidden = false;

        } catch (err) {
            console.error(err);
            showError(els, typeof err === 'string' ? err : (err.message || 'Conversion failed.'));
        } finally {
            els.convertBtn.disabled = false;
            els.convertBtn.textContent = originalBtnText;
        }
    }

    function handleDownload(btn) {
        const url = btn.dataset.downloadUrl;
        const filename = btn.dataset.filename;
        if (!url || !filename) return;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function updateQualityVisibility(els) {
        if (!els.qualityContainer || !els.formatSelect) return;
        const fmt = els.formatSelect.value;
        const supportsQuality = (fmt === 'jpeg' || fmt === 'jpg' || fmt === 'webp');
        els.qualityContainer.hidden = !supportsQuality;
    }

    function bindDelegatedHandlersOnce() {
        if (window.__imageConverterDelegatedHandlersBound) return;
        window.__imageConverterDelegatedHandlersBound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;

            const convertBtn = target.closest('#ic-convert-btn');
            if (convertBtn) {
                ev.preventDefault();
                void handleConvert();
                return;
            }

            const downloadBtn = target.closest('#ic-download-btn');
            if (downloadBtn) {
                ev.preventDefault();
                handleDownload(downloadBtn);
                return;
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            // File Input
            if (target.id === 'ic-input-file') {
                const file = target.files && target.files.length > 0 ? target.files[0] : null;
                if (file) {
                    els.convertBtn.disabled = false;
                    clearError(els);
                    els.outputSection.hidden = true;
                } else {
                    els.convertBtn.disabled = true;
                }
            }

            // Format Select
            if (target.id === 'ic-format-select') {
                updateQualityVisibility(els);
            }
        });

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            if (target.id === 'ic-quality') {
                const els = getElements();
                if (els && els.qualityValue) {
                    els.qualityValue.textContent = target.value;
                }
            }
        });
    }

    bindDelegatedHandlersOnce();

    // Initial check for visibility on load/navigate
    const els = getElements();
    if (els) {
        updateQualityVisibility(els);
    }

})();