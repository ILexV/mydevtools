/* global document, window, Blob, URL, FileReader, Uint8Array */

(function () {
    const rootState = new WeakMap();
    let pdfWasmModule = null;
    let wasmInitPromise = null;

    async function ensureWasm() {
        if (!wasmInitPromise) {
            wasmInitPromise = import('/wasm/pdf/pdf.js').then(async (m) => {
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
            fileInput: root.querySelector('#pdf-input-files'),
            fileListContainer: root.querySelector('.file-list-container'),
            fileList: root.querySelector('.file-list'),
            mergeBtn: root.querySelector('#pdf-merge-btn'),
            downloadBtn: root.querySelector('#pdf-download-btn'),
            errorAlert: root.querySelector('#pdf-error'),
            errorText: root.querySelector('#pdf-error-text')
        };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            processing: root.dataset.processing || 'Merging...',
            done: root.dataset.done || 'Merged!'
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
                <th>${index + 1}</th>
                <td><div class="truncate max-w-[200px]" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div></td>
                <td class="text-sm opacity-70">${formatBytes(item.file.size)}</td>
                <td class="status text-sm">Ready</td>
                <td>
                    <button type="button" class="btn btn-ghost btn-xs btn-circle text-error remove-file-btn" data-index="${index}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </td>
            `;
            els.fileList.appendChild(tr);
        });
        
        // Hide download button if it was shown from previous merge
        els.downloadBtn.classList.add('hidden');
        els.mergeBtn.classList.remove('hidden');
    }

    async function handleMerge(root) {
        const els = getElements(root);
        const state = getState(root);
        const strings = getStrings(root);

        if (!els || state.files.length === 0) return;

        els.mergeBtn.disabled = true;
        const originalBtnText = els.mergeBtn.innerHTML;
        els.mergeBtn.innerHTML = `<span class="loading loading-spinner"></span> ${strings.processing}`;
        els.errorAlert.classList.add('hidden');
        
        // Hide download button during processing
        els.downloadBtn.classList.add('hidden');

        try {
            const wasm = await ensureWasm();
            
            // Read all files
            const fileBuffers = await Promise.all(state.files.map(async (item) => {
                const buffer = await item.file.arrayBuffer();
                return new Uint8Array(buffer);
            }));

            // Process
            const mergedPdf = wasm.merge_pdfs(fileBuffers);
            
            const blob = new Blob([mergedPdf], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            
            // Setup download
            els.downloadBtn.href = url;
            els.downloadBtn.classList.remove('hidden');
            els.mergeBtn.classList.add('hidden'); // Hide merge button after success to encourage download or reset?
            // Actually, keep merge button hidden, show download. 
            // If user adds more files, merge button comes back (handled in renderFileList).
            
            // Update status in table
            const statusCells = els.fileList.querySelectorAll('.status');
            statusCells.forEach(cell => cell.innerHTML = `<span class="text-success">${strings.done}</span>`);

        } catch (err) {
            console.error(err);
            els.errorText.textContent = err.message || strings.error;
            els.errorAlert.classList.remove('hidden');
            els.mergeBtn.disabled = false;
            els.mergeBtn.innerHTML = originalBtnText;
        } finally {
            if (els.downloadBtn.classList.contains('hidden')) {
                 // If failed, re-enable merge button
                 els.mergeBtn.disabled = false;
                 els.mergeBtn.innerHTML = originalBtnText;
            } else {
                // Success state
                els.mergeBtn.innerHTML = originalBtnText;
                els.mergeBtn.disabled = false;
            }
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__pdfMergerDelegatedHandlersBound) return;
        window.__pdfMergerDelegatedHandlersBound = true;

        const getRoot = (target) => target.closest('#pdf-merger-root');

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            const root = getRoot(target);
            if (!root) return;

            // Merge button
            const mergeBtn = target.closest('#pdf-merge-btn');
            if (mergeBtn) {
                ev.preventDefault();
                if (!mergeBtn.disabled) {
                    handleMerge(root);
                }
                return;
            }

            // Remove file button
            const removeBtn = target.closest('.remove-file-btn');
            if (removeBtn) {
                ev.preventDefault();
                const index = parseInt(removeBtn.dataset.index);
                const state = getState(root);
                if (!isNaN(index) && state.files[index]) {
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

            if (target.matches('#pdf-input-files')) {
                if (target.files && target.files.length > 0) {
                    const state = getState(root);
                    const newFiles = Array.from(target.files).map(f => ({ file: f }));
                    state.files = [...state.files, ...newFiles];
                    target.value = ''; // Reset
                    renderFileList(root);
                }
            }
        });
        
        // Drag and drop visual feedback (optional but good)
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
                     // Filter PDFs
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
        if (window.__pdfMergerDelegatedHandlersBound) return;
        bindDelegatedHandlersOnce();
        
        // Preload WASM if on page
        if (document.getElementById('pdf-merger-root')) {
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
