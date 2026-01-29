/* global document, window, Blob, URL, FileReader, Uint8Array */

(function () {
    let wasmModule = null;
    let wasmInitPromise = null;
    let logoBytes = null;
    let currentStyle = 'square';
    let currentPngUrl = null;
    let currentSvgUrl = null;

    async function ensureWasm() {
        if (!wasmInitPromise) {
            wasmInitPromise = import('/wasm/qrcode/qrcode.js').then(async (m) => {
                await m.default();
                wasmModule = m;
                return m;
            });
        }
        return wasmInitPromise;
    }

    function getElements() {
        const root = document.getElementById('qr-generator-root');
        if (!root) return null;

        return {
            root,
            content: document.getElementById('qr-content'),
            fgColor: document.getElementById('qr-fg-color'),
            fgColorText: document.getElementById('qr-fg-color-text'),
            bgColor: document.getElementById('qr-bg-color'),
            bgColorText: document.getElementById('qr-bg-color-text'),
            ecLevel: document.getElementById('qr-ec-level'),
            size: document.getElementById('qr-size'),
            generateBtn: document.getElementById('qr-generate-btn'),
            previewContainer: document.getElementById('qr-preview-container'),
            previewPlaceholder: document.getElementById('qr-preview-placeholder'),
            previewImg: document.getElementById('qr-preview-img'),
            loadingOverlay: document.getElementById('qr-loading-overlay'),
            downloadPng: document.getElementById('qr-download-png'),
            downloadSvg: document.getElementById('qr-download-svg'),
            errorEl: document.getElementById('qr-error'),
            errorText: document.getElementById('qr-error-text'),
            logoInput: document.getElementById('qr-logo-input')
        };
    }

    function showError(els, msg) {
        if (!els.errorEl || !els.errorText) return;
        els.errorText.textContent = msg;
        els.errorEl.classList.remove('hidden');
        els.errorEl.style.display = 'flex';
    }

    function clearError(els) {
        if (!els.errorEl) return;
        els.errorEl.classList.add('hidden');
        els.errorEl.style.display = 'none';
    }

    function syncColorInputs(colorInput, textInput) {
        colorInput.addEventListener('input', () => {
            textInput.value = colorInput.value.toUpperCase();
        });
        textInput.addEventListener('input', () => {
            const val = textInput.value.trim();
            if (/^#?[0-9A-Fa-f]{6}$/.test(val)) {
                colorInput.value = val.startsWith('#') ? val : '#' + val;
            }
        });
    }

    async function handleLogoFile(file) {
        if (!file) return;

        if (!file.type.match('image.*')) {
            const els = getElements();
            if (els) showError(els, 'Please select a valid image file');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            logoBytes = new Uint8Array(e.target.result);
        };
        reader.readAsArrayBuffer(file);
    }

    function removeLogo() {
        logoBytes = null;
        const els = getElements();
        // FileDropZone input clearing is handled by the component's internal logic usually, 
        // but we ensure our state is cleared.
    }

    async function generateQrCode() {
        const els = getElements();
        if (!els) return;

        const content = els.content.value.trim();
        if (!content) {
            showError(els, 'Please enter content to encode');
            return;
        }

        const generateText = els.generateBtn.dataset.generate || 'Generate';
        const generatingText = els.generateBtn.dataset.generating || 'Generating...';

        els.generateBtn.disabled = true;
        els.generateBtn.textContent = generatingText;
        els.loadingOverlay.classList.remove('hidden');
        clearError(els);

        try {
            await ensureWasm();

            const size = parseInt(els.size.value);
            const fgColor = els.fgColor.value;
            const bgColor = els.bgColor.value;
            const ecLevel = els.ecLevel.value;

            // Generate PNG
            const pngBytes = wasmModule.generate_qr_png(
                content,
                size,
                fgColor,
                bgColor,
                ecLevel,
                currentStyle,
                logoBytes ? Array.from(logoBytes) : null
            );

            const pngBlob = new Blob([pngBytes], { type: 'image/png' });

            if (currentPngUrl) URL.revokeObjectURL(currentPngUrl);
            currentPngUrl = URL.createObjectURL(pngBlob);

            // Show preview
            els.previewPlaceholder.classList.add('hidden');
            els.previewImg.classList.remove('hidden');
            els.previewImg.src = currentPngUrl;

            // Setup PNG download
            els.downloadPng.href = currentPngUrl;
            els.downloadPng.download = 'qrcode.png';
            els.downloadPng.classList.remove('hidden');
            els.downloadPng.style.display = 'flex';

            // Generate SVG (only for simple case without logo)
            if (!logoBytes && currentStyle === 'square') {
                try {
                    const svgString = wasmModule.generate_qr_svg(content, fgColor, bgColor, ecLevel);
                    const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
                    
                    if (currentSvgUrl) URL.revokeObjectURL(currentSvgUrl);
                    currentSvgUrl = URL.createObjectURL(svgBlob);
                    
                    els.downloadSvg.href = currentSvgUrl;
                    els.downloadSvg.download = 'qrcode.svg';
                    els.downloadSvg.classList.remove('hidden');
                    els.downloadSvg.style.display = 'flex';
                } catch {
                    els.downloadSvg.classList.add('hidden');
                }
            } else {
                els.downloadSvg.classList.add('hidden');
                els.downloadSvg.style.display = 'none';
            }

        } catch (err) {
            console.error('QR generation error:', err);
            showError(els, typeof err === 'string' ? err : 'Failed to generate QR code');
        } finally {
            els.generateBtn.disabled = false;
            els.generateBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6 mr-2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z" />
                </svg>
                ${generateText}`;
            els.loadingOverlay.classList.add('hidden');
        }
    }

    function init() {
        if (window.__qrGeneratorBound) return;
        window.__qrGeneratorBound = true;

        document.addEventListener('click', (e) => {
            // Style buttons
            const styleBtn = e.target.closest('.qr-style-btn');
            if (styleBtn) {
                document.querySelectorAll('.qr-style-btn').forEach(btn => {
                    btn.classList.remove('btn-active');
                });
                styleBtn.classList.add('btn-active');
                currentStyle = styleBtn.dataset.style;
            }

            // Generate button
            const genBtn = e.target.closest('#qr-generate-btn');
            if (genBtn) {
                e.preventDefault();
                generateQrCode();
            }
        });

        // Logo file input
        document.addEventListener('change', (e) => {
            if (e.target.id === 'qr-logo-input') {
                if (e.target.files && e.target.files[0]) {
                    handleLogoFile(e.target.files[0]);
                } else {
                    removeLogo();
                }
            }
        });

        // Color sync
        const els = getElements();
        if (els) {
            syncColorInputs(els.fgColor, els.fgColorText);
            syncColorInputs(els.bgColor, els.bgColorText);
        }
    }

    // Initialize
    init();

    // Observer for Blazor navigation
    const observer = new MutationObserver(() => {
        // Re-run color sync logic if elements re-appear
        const els = getElements();
        if (els && !els.fgColor.hasAttribute('data-synced')) {
            syncColorInputs(els.fgColor, els.fgColorText);
            syncColorInputs(els.bgColor, els.bgColorText);
            els.fgColor.setAttribute('data-synced', 'true');
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
