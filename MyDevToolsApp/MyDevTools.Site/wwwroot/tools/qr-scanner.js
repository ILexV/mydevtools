
(function () {
  // Prevent double initialization
  if (window.__qrScannerInitialized) return;
  window.__qrScannerInitialized = true;

  const initializedRoots = new WeakSet();
  let wasmModule = null;

  async function loadWasm() {
    if (wasmModule) return wasmModule;
    try {
      // Import the WASM module
      wasmModule = await import('/wasm/qrcode/qrcode.js');
      await wasmModule.default();
      return wasmModule;
    } catch (err) {
      console.error("Failed to load WASM:", err);
      return null;
    }
  }

  function initTool(root) {
    if (!root || initializedRoots.has(root)) return;
    initializedRoots.add(root);

    const dropZone = root.querySelector('#drop-zone');
    const fileInput = root.querySelector('#file-input');
    const resultSection = root.querySelector('#result-section');
    const resultText = root.querySelector('#result-text');
    const errorMessage = root.querySelector('#error-message');
    const copyBtn = root.querySelector('#copy-btn');
    const linkAction = root.querySelector('#link-action');
    const openLinkBtn = root.querySelector('#open-link-btn');

    // Drag and drop handlers
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');

      if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
        fileInput.value = ''; // Reset
      }
    });

    // Copy button
    copyBtn.addEventListener('click', () => {
      if (resultText.value) {
        navigator.clipboard.writeText(resultText.value);
        // Simple feedback could be added here
      }
    });

    async function handleFile(file) {
      // Reset UI
      errorMessage.classList.add('hidden');
      resultSection.classList.add('hidden');
      linkAction.classList.add('hidden');

      if (!file.type.startsWith('image/')) {
        showError("Please upload an image file.");
        return;
      }

      try {
        const wasm = await loadWasm();
        if (!wasm) {
          showError("Failed to load scanner component.");
          return;
        }

        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        try {
          const text = wasm.decode_qr(bytes);
          showResult(text);
        } catch (qrError) {
          console.warn("QR Decode Error:", qrError);
          showError("No QR code found in the image. Please try another image.");
        }

      } catch (err) {
        console.error(err);
        showError("Error processing image.");
      }
    }

    function showResult(text) {
      resultText.value = text;
      resultSection.classList.remove('hidden');

      // URL Detection (simple regex)
      if (/^https?:\/\//i.test(text)) {
        linkAction.classList.remove('hidden');
        openLinkBtn.href = text;
      }
    }

    function showError(msg) {
      errorMessage.textContent = msg;
      errorMessage.classList.remove('hidden');
    }
  }

  // Initialize on load and DOM changes
  const observer = new MutationObserver((mutations) => {
    const root = document.getElementById('qr-scanner-tool-root');
    if (root) initTool(root);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial check
  const root = document.getElementById('qr-scanner-tool-root');
  if (root) initTool(root);

})();
