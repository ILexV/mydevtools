/* global document, window, Uint8Array, navigator, MutationObserver */

(function () {
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
    const errorText = root.querySelector('#error-message-text') || errorMessage; // fallback
    const copyBtn = root.querySelector('#copy-btn');
    const linkAction = root.querySelector('#link-action');
    const openLinkBtn = root.querySelector('#open-link-btn');

    // Handle File Processing
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
        if (errorText) errorText.textContent = msg;
        else errorMessage.textContent = msg;
        errorMessage.classList.remove('hidden');
        errorMessage.style.display = 'flex';
    }

    // Event Listeners
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            // Optional: visual cue
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length > 0) {
                handleFile(e.dataTransfer.files[0]);
            }
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFile(e.target.files[0]);
                // Don't clear value immediately if we want to allow re-selecting same file? 
                // Usually better to clear so change event fires again if user picks same file after error
                fileInput.value = ''; 
            }
        });
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            if (resultText.value) {
                try {
                    await navigator.clipboard.writeText(resultText.value);
                    
                    // Visual feedback
                    const originalHTML = copyBtn.innerHTML;
                    copyBtn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 text-success">
                            <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                        </svg>
                    `;
                    setTimeout(() => {
                        copyBtn.innerHTML = originalHTML;
                    }, 1500);
                } catch (e) {
                    console.error("Copy failed", e);
                }
            }
        });
    }
  }

  // Initialize on load and DOM changes
  function checkAndInit() {
      const root = document.getElementById('qr-scanner-tool-root');
      if (root) initTool(root);
  }

  document.addEventListener('DOMContentLoaded', checkAndInit);
  document.addEventListener('enhancedload', checkAndInit);

  // Fallback for dynamic updates if enhancedload doesn't catch it
  const observer = new MutationObserver(() => checkAndInit());
  observer.observe(document.body, { childList: true, subtree: true });

})();
