/* global document, window, Blob, URL, FileReader, Uint8Array */

(function () {
    const rootState = new WeakMap();
    let pdfWasmModule = null;
    let wasmInitPromise = null;

    async function ensureWasm() {
        if (!wasmInitPromise) {
            wasmInitPromise = import('/wasm/pdf/pdf.js?v=' + Date.now()).then(async (m) => {
                await m.default();
                pdfWasmModule = m;
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
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function getElements(root) {
        if (!root) return null;
        return {
            root,
            fileInput: root.querySelector('#pdf-text-input'),
            fileListContainer: root.querySelector('.file-list-container'),
            fileList: root.querySelector('.file-list'),
            extractBtn: root.querySelector('#pdf-extract-btn'),
            errorAlert: root.querySelector('#pdf-error'),
            errorText: root.querySelector('#pdf-error-text')
        };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            processing: root.dataset.processing || 'Extracting...',
            done: root.dataset.done || 'Done!',
            download: root.dataset.download || 'Download TXT'
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

    function escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function renderFileList(root) {
        const els = getElements(root);
        const state = getState(root);
        if (!els || !els.fileList) return;

        els.fileList.innerHTML = '';
        if (state.files.length === 0) {
            els.fileListContainer.classList.add('hidden');
            return;
        }

        els.fileListContainer.classList.remove('hidden');

        state.files.forEach((item, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <th class="w-12">${index + 1}</th>
                <td class="max-w-0 w-full">
                    <div class="truncate font-medium" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
                </td>
                <td class="text-sm opacity-70 whitespace-nowrap text-right px-4">${formatBytes(item.file.size)}</td>
                <td class="status text-sm whitespace-nowrap px-4 text-center">
                    ${item.url ? `
                        <a href="${item.url}" download="${item.file.name.replace(/\.pdf$/i, '')}.txt" class="btn btn-success btn-sm btn-circle text-white" title="${getStrings(root).download}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                        </a>
                    ` : 'Ready'}
                </td>
                <td class="w-12 text-center">
                    <button type="button" class="btn btn-ghost btn-xs btn-circle text-error remove-file-btn" data-index="${index}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </td>
            `;
            els.fileList.appendChild(tr);
        });
    }

    async function handleExtract(root) {
        const els = getElements(root);
        const state = getState(root);
        const strings = getStrings(root);

        if (!els || state.files.length === 0) return;

        els.extractBtn.disabled = true;
        const originalBtnText = els.extractBtn.innerHTML;
        els.extractBtn.innerHTML = `<span class="loading loading-spinner"></span> ${strings.processing}`;
        els.errorAlert.classList.add('hidden');

        try {
            const wasm = await ensureWasm();
            
            for (let i = 0; i < state.files.length; i++) {
                const item = state.files[i];
                if (item.url) continue; // Skip already extracted

                // Update status in table for current file
                const rows = els.fileList.querySelectorAll('tr');
                if (rows[i]) {
                    const statusCell = rows[i].querySelector('.status');
                    statusCell.innerHTML = `<span class="loading loading-spinner loading-xs"></span>`;
                }

                const buffer = await item.file.arrayBuffer();
                const text = wasm.extract_text(new Uint8Array(buffer));
                
                const blob = new Blob([text], { type: 'text/plain' });
                item.url = URL.createObjectURL(blob);
            }

            renderFileList(root);

        } catch (err) {
            console.error(err);
            els.errorText.textContent = err.message || strings.error;
            els.errorAlert.classList.remove('hidden');
        } finally {
            els.extractBtn.disabled = false;
            els.extractBtn.innerHTML = originalBtnText;
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__pdfToTextDelegatedHandlersBound) return;
        window.__pdfToTextDelegatedHandlersBound = true;

        const getRoot = (target) => target.closest('#pdf-to-text-root');

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            const root = getRoot(target);
            if (!root) return;

            const extractBtn = target.closest('#pdf-extract-btn');
            if (extractBtn) {
                ev.preventDefault();
                if (!extractBtn.disabled) {
                    handleExtract(root);
                }
                return;
            }

            const removeBtn = target.closest('.remove-file-btn');
            if (removeBtn) {
                ev.preventDefault();
                const index = parseInt(removeBtn.dataset.index);
                const state = getState(root);
                if (!isNaN(index) && state.files[index]) {
                    if (state.files[index].url) {
                        URL.revokeObjectURL(state.files[index].url);
                    }
                    state.files.splice(index, 1);
                    renderFileList(root);
                }
                return;
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            const root = getRoot(target);
            if (!root) return;

            if (target.matches('#pdf-text-input')) {
                if (target.files && target.files.length > 0) {
                    const state = getState(root);
                    const newFiles = Array.from(target.files).map(f => ({ file: f }));
                    state.files = [...state.files, ...newFiles];
                    target.value = ''; // Reset
                    renderFileList(root);
                }
            }
        });
        
        document.addEventListener('dragover', (ev) => {
             const dropZone = ev.target.closest('.upload-box');
             if (dropZone) {
                 ev.preventDefault();
                 dropZone.classList.add('opacity-70');
             }
        });
        
        document.addEventListener('dragleave', (ev) => {
             const dropZone = ev.target.closest('.upload-box');
             if (dropZone) {
                 dropZone.classList.remove('opacity-70');
             }
        });
        
        document.addEventListener('drop', (ev) => {
             const dropZone = ev.target.closest('.upload-box');
             if (dropZone) {
                 ev.preventDefault();
                 dropZone.classList.remove('opacity-70');
                 const root = getRoot(ev.target);
                 if (root && ev.dataTransfer.files.length > 0) {
                     const state = getState(root);
                     const newFiles = Array.from(ev.dataTransfer.files)
                        .filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
                        .map(f => ({ file: f }));
                     
                     if (newFiles.length > 0) {
                        state.files = [...state.files, ...newFiles];
                        renderFileList(root);
                     }
                 }
             }
        });
    }

    function initIfPresent() {
        if (window.__pdfToTextDelegatedHandlersBound) return;
        bindDelegatedHandlersOnce();
        
        if (document.getElementById('pdf-to-text-root')) {
            ensureWasm();
        }
    }

    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }

})();
