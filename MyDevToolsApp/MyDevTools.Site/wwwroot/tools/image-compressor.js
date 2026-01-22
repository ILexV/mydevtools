/* global document, window, Blob, URL, FileReader, Uint8Array */

// IIFE to avoid polluting global scope (except for what matches MyDevTools pattern)
(function () {
  const rootState = new WeakMap();

  // Store WASM module here
  let wasmModule = null;
  let wasmInitPromise = null;

  // Helper to dynamically load WASM module
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

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function getElements(root) {
    if (!root) return null;
    return {
      root,
      fileInput: root.querySelector('#fileInput'),
      fileList: root.querySelector('.file-list'),
      qualitySlider: root.querySelector('#quality'),
      qualityValue: root.querySelector('#quality-value'),
      formatSelect: root.querySelector('#format'),
      compressBtn: root.querySelector('#compressBtn'),
      downloadAllBtn: root.querySelector('#downloadAllBtn')
    };
  }

  function getStrings(root) {
    return {
      compressing: root.dataset.compressing || 'Compressing...',
      processing: root.dataset.processing || 'Processing...',
      done: root.dataset.done || 'Done!',
      error: root.dataset.error || 'Error',
      download: root.dataset.download || 'Download'
    };
  }

  function getState(root) {
    let state = rootState.get(root);
    if (!state) {
      state = { files: [] };
      rootState.set(root, state);
    }
    return state;
  }

  function handleFileSelect(root, files) {
    const els = getElements(root);
    if (!els || !files.length) return;

    if (els.fileList.classList.contains('hidden')) {
      els.fileList.classList.remove('hidden');
      els.compressBtn.classList.remove('hidden');
    }

    const state = getState(root);

    Array.from(files).forEach(file => {
      if (!file.type.match('image.*')) return;

      const fileId = Math.random().toString(36).substr(2, 9);
      state.files.push({ id: fileId, file: file, processed: null });

      const item = document.createElement('div');
      item.className = 'file-item p-4 bg-white dark:bg-gray-800 rounded-lg flex items-center justify-between mb-2 shadow-sm border border-gray-100 dark:border-gray-700';
      item.id = `file-${fileId}`;

      const reader = new FileReader();
      reader.onload = (e) => {
        const img = item.querySelector('.thumbnail');
        if (img) img.src = e.target.result;
      };
      reader.readAsDataURL(file);

      item.innerHTML = `
                <div class="flex items-center gap-4">
                    <img class="thumbnail w-12 h-12 object-cover rounded bg-gray-200 dark:bg-gray-700" src="" />
                    <div class="min-w-0">
                        <div class="font-medium text-sm truncate max-w-[150px] sm:max-w-[200px] text-gray-700 dark:text-gray-200">${file.name}</div>
                        <div class="text-xs text-gray-500 dark:text-gray-400">${formatSize(file.size)}</div>
                    </div>
                </div>
                <div class="status text-sm text-gray-500 dark:text-gray-400">Ready</div>
            `;

      els.fileList.appendChild(item);
    });
  }

  function bindDelegatedHandlersOnce() {
    if (window.__imageCompressorDelegatedHandlersBound) return;
    window.__imageCompressorDelegatedHandlersBound = true;
    console.log('[ImageCompressor] Handlers bound');

    const getRoot = (target) => target.closest('#image-compressor-root');

    document.addEventListener('click', async (e) => {
      const root = getRoot(e.target);
      if (!root) return;

      // UPLOAD BOX CLICK
      if (e.target.closest('.upload-box')) {
        if (e.target.matches('input[type="file"]')) return;

        const fileInput = root.querySelector('#fileInput');
        if (fileInput) fileInput.click();
        return;
      }

      // COMPRESS BUTTON
      if (e.target.closest('#compressBtn')) {
        const btn = e.target.closest('#compressBtn');
        const els = getElements(root);
        const strings = getStrings(root);
        const state = getState(root);

        if (btn.disabled) return;

        if (!wasmModule) await ensureWasm();

        const quality = parseInt(els.qualitySlider ? els.qualitySlider.value : 80);
        const format = els.formatSelect ? els.formatSelect.value : 'original';

        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = strings.compressing;

        for (const item of state.files) {
          const uiItem = document.getElementById(`file-${item.id}`);
          if (!uiItem) continue;

          const statusDiv = uiItem.querySelector('.status');
          statusDiv.textContent = strings.processing;

          try {
            const arrayBuffer = await item.file.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);

            let targetFormat = format;
            if (targetFormat === 'original') {
              const type = item.file.type.split('/')[1];
              targetFormat = type === 'jpeg' ? 'jpeg' : (type === 'png' ? 'png' : 'webp');
              if (!['jpeg', 'jpg', 'png', 'webp'].includes(targetFormat)) targetFormat = 'jpeg';
            }
            if (targetFormat === 'jpg') targetFormat = 'jpeg';

            const resultBytes = wasmModule.compress_image(bytes, targetFormat, quality);

            const mimeType = `image/${targetFormat === 'jpeg' ? 'jpeg' : targetFormat}`;
            const blob = new Blob([resultBytes], { type: mimeType });

            const dotIndex = item.file.name.lastIndexOf('.');
            const baseName = dotIndex !== -1 ? item.file.name.substring(0, dotIndex) : item.file.name;
            const ext = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
            const newName = `${baseName}_min.${ext}`;

            item.processed = { blob: blob, name: newName };

            const savedPerc = Math.round((1 - (blob.size / item.file.size)) * 100);
            statusDiv.innerHTML = `
                            <span class="text-green-600 dark:text-green-400 font-bold">${strings.done}</span> 
                            <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">${formatSize(blob.size)} (${savedPerc > 0 ? '-' : ''}${savedPerc}%)</span>
                            <a href="${URL.createObjectURL(blob)}" download="${item.processed.name}" class="ml-4 text-blue-600 dark:text-blue-400 hover:underline font-medium">${strings.download}</a>
                        `;
          } catch (err) {
            console.error(err);
            statusDiv.innerHTML = `<span class="text-red-500 dark:text-red-400 font-bold">${strings.error}</span>`;
          }
        }

        btn.disabled = false;
        btn.textContent = originalText;
        if (els.downloadAllBtn) els.downloadAllBtn.classList.remove('hidden');
      }
    });

    document.addEventListener('change', (e) => {
      const root = getRoot(e.target);
      if (!root) return;

      if (e.target.matches('#fileInput')) {
        handleFileSelect(root, e.target.files);
        e.target.value = '';
      }
    });

    document.addEventListener('input', (e) => {
      const root = getRoot(e.target);
      if (!root) return;

      if (e.target.matches('#quality')) {
        const val = root.querySelector('#quality-value');
        if (val) val.textContent = `${e.target.value}%`;
      }
    });

    document.addEventListener('dragover', (e) => {
      const dropZone = e.target.closest('.upload-box');
      if (dropZone) {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      }
    });

    document.addEventListener('dragleave', (e) => {
      const dropZone = e.target.closest('.upload-box');
      if (dropZone) {
        dropZone.classList.remove('drag-over');
      }
    });

    document.addEventListener('drop', (e) => {
      const dropZone = e.target.closest('.upload-box');
      if (dropZone) {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        handleFileSelect(getRoot(e.target), e.dataTransfer.files);
      }
    });
  }

  function initIfPresent() {
    if (window.__imageCompressorDelegatedHandlersBound) return;

    // Try to find the root. If not in DOM, we can still bind document handlers?
    // Actually, since we bind to document, we can bind ONCE globally regardless of whether the tool is open.
    // BUT we should only do it if we are on a page where this script is loaded.

    bindDelegatedHandlersOnce();

    // Eagerly load WASM if the tool root is present
    if (document.getElementById('image-compressor-root')) {
      ensureWasm();
    }
  }

  initIfPresent();

  // Auto-init for enhanced nav
  try {
    const observer = new MutationObserver(() => initIfPresent());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch { }

  // Backup exposed init
  window.initImageCompressor = function () {
    initIfPresent();
  };

})();
