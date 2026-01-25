/* global document, window, Blob, URL, FileReader, Uint8Array */

(function () {
    let wasmModule = null;
    let wasmInitPromise = null;
    let logoBytes = null;

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
            downloadPng: document.getElementById('qr-download-png'),
            downloadSvg: document.getElementById('qr-download-svg'),
            errorEl: document.getElementById('qr-error'),
            logoInput: document.getElementById('qr-logo-input')
        };
    }

    let currentStyle = 'square';
    let currentPngUrl = null;
    let currentSvgBlob = null;

    function showError(els, msg) {
        els.errorEl.textContent = msg;
        els.errorEl.hidden = false;
    }

    function clearError(els) {
        els.errorEl.textContent = '';
        els.errorEl.hidden = true;
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
            if (els) showError(els, 'Please select an image file');
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
        const logoInput = document.getElementById('qr-logo-input');
        if (logoInput) logoInput.value = '';
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
            els.downloadPng.hidden = false;

            // Generate SVG (only for simple case without logo)
            if (!logoBytes && currentStyle === 'square') {
                try {
                    const svgString = wasmModule.generate_qr_svg(content, fgColor, bgColor, ecLevel);
                    currentSvgBlob = new Blob([svgString], { type: 'image/svg+xml' });
                    const svgUrl = URL.createObjectURL(currentSvgBlob);
                    els.downloadSvg.href = svgUrl;
                    els.downloadSvg.download = 'qrcode.svg';
                    els.downloadSvg.hidden = false;
                } catch {
                    els.downloadSvg.hidden = true;
                }
            } else {
                els.downloadSvg.hidden = true;
            }

        } catch (err) {
            console.error('QR generation error:', err);
            showError(els, typeof err === 'string' ? err : 'Failed to generate QR code');
        } finally {
            els.generateBtn.disabled = false;
            els.generateBtn.textContent = generateText;
        }
    }

    function init() {
        if (window.__qrGeneratorBound) return;
        window.__qrGeneratorBound = true;

        // Style button clicks
        document.addEventListener('click', (e) => {
            const styleBtn = e.target.closest('.qr-style-btn');
            if (styleBtn) {
                document.querySelectorAll('.qr-style-btn').forEach(btn => {
                    btn.classList.remove('active');
                    btn.style.backgroundColor = 'var(--bg-primary)';
                    btn.style.color = 'var(--text-primary)';
                });
                styleBtn.classList.add('active');
                styleBtn.style.backgroundColor = 'var(--accent-color)';
                styleBtn.style.color = '#fff';
                currentStyle = styleBtn.dataset.style;
            }

            // Generate button
            if (e.target.id === 'qr-generate-btn') {
                generateQrCode();
            }
        });

        // Logo file input - handle file selection and clearing
        document.addEventListener('change', (e) => {
            if (e.target.id === 'qr-logo-input') {
                if (e.target.files && e.target.files[0]) {
                    handleLogoFile(e.target.files[0]);
                } else {
                    // File was cleared
                    removeLogo();
                }
            }
        });

        // Color sync
        const els = getElements();
        if (els) {
            syncColorInputs(els.fgColor, els.fgColorText);
            syncColorInputs(els.bgColor, els.bgColorText);

            // Set initial style button state
            const activeBtn = document.querySelector('.qr-style-btn.active');
            if (activeBtn) {
                activeBtn.style.backgroundColor = 'var(--accent-color)';
                activeBtn.style.color = '#fff';
            }
        }
    }

    // Initialize
    init();

    // Observer for Blazor navigation
    const observer = new MutationObserver(() => {
        if (document.getElementById('qr-generator-root') && !window.__qrGeneratorBound) {
            init();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
