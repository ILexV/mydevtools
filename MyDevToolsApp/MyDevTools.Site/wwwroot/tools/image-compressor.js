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
      fileListContainer: root.querySelector('.file-list-container'),
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

    if (els.fileListContainer && els.fileListContainer.classList.contains('hidden')) {
      els.fileListContainer.classList.remove('hidden');
      els.compressBtn.classList.remove('hidden');
    }

    const state = getState(root);

    Array.from(files).forEach(file => {
      if (!file.type.match('image.*')) return;

      const fileId = Math.random().toString(36).substr(2, 9);
      state.files.push({ id: fileId, file: file, processed: null });

      const item = document.createElement('tr');
      item.id = `file-${fileId}`;

      item.innerHTML = `
        <td>
            <div class="avatar">
                <div class="w-12 h-12 mask mask-squircle bg-base-300">
                    <img class="thumbnail" src="" alt="preview" />
                </div>
            </div>
        </td>
        <td>
            <div class="font-bold truncate max-w-[200px]" title="${file.name}">${file.name}</div>
        </td>
        <td class="text-sm opacity-70">${formatSize(file.size)}</td>
        <td class="status text-sm">Ready</td>
        <td class="action"></td>
      `;

      const reader = new FileReader();
      reader.onload = (e) => {
        const img = item.querySelector('.thumbnail');
        if (img) img.src = e.target.result;
      };
      reader.readAsDataURL(file);

      els.fileList.appendChild(item);
    });
  }

  function bindDelegatedHandlersOnce() {
    if (window.__imageCompressorDelegatedHandlersBound) return;
    window.__imageCompressorDelegatedHandlersBound = true;

    const getRoot = (target) => target.closest('#image-compressor-root');

    document.addEventListener('click', async (e) => {
      const root = getRoot(e.target);
      if (!root) return;

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
            const actionTd = uiItem.querySelector('.action');
            
            // Update status cell
            statusDiv.innerHTML = `
                <div class="flex flex-col">
                    <span class="badge badge-success gap-2">
                        ${strings.done} 
                        ${savedPerc > 0 ? `<span class="font-bold">-${savedPerc}%</span>` : ''}
                    </span>
                    <span class="text-xs opacity-70 mt-1">${formatSize(blob.size)}</span>
                </div>
            `;
            
            // Update action cell with download button
            if (actionTd) {
                actionTd.innerHTML = `
                    <a href="${URL.createObjectURL(blob)}" download="${item.processed.name}" class="btn btn-sm btn-ghost">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    </a>
                `;
            }
          } catch (err) {
            console.error(err);
            statusDiv.innerHTML = `<span class="text-red-500 dark:text-red-400 font-bold">${strings.error}</span>`;
          }
        }

        btn.disabled = false;
        btn.textContent = originalText;
        if (els.downloadAllBtn) els.downloadAllBtn.classList.remove('hidden');
      }

      // DOWNLOAD ALL BUTTON
      if (e.target.closest('#downloadAllBtn')) {
        const els = getElements(root);
        const state = getState(root);
        const strings = getStrings(root);

        const processedFiles = state.files.filter(f => f.processed);
        if (processedFiles.length === 0) return;

        const btn = e.target.closest('#downloadAllBtn');
        const originalText = btn.textContent;
        btn.textContent = strings.processing;
        btn.disabled = true;

        try {
          if (!window.JSZip) {
            await new Promise((resolve, reject) => {
              const script = document.createElement('script');
              script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
              script.onload = resolve;
              script.onerror = reject;
              document.head.appendChild(script);
            });
          }

          const zip = new window.JSZip();
          processedFiles.forEach(item => {
            zip.file(item.processed.name, item.processed.blob);
          });

          const content = await zip.generateAsync({ type: 'blob' });
          const zipName = `compressed_images_${new Date().toISOString().slice(0, 10)}.zip`;

          const link = document.createElement('a');
          link.href = URL.createObjectURL(content);
          link.download = zipName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(link.href);

        } catch (err) {
          console.error('Zip generation failed:', err);
          alert('Failed to generate zip archive.');
        } finally {
          btn.textContent = originalText;
          btn.disabled = false;
        }
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
    bindDelegatedHandlersOnce();
    if (document.getElementById('image-compressor-root')) {
      ensureWasm();
    }
  }

  initIfPresent();

  try {
    const observer = new MutationObserver(() => initIfPresent());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch { }

  window.initImageCompressor = function () {
    initIfPresent();
  };

})();
