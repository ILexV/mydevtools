/* global document, window */

(function () {
    const initialized = new WeakSet();

    function formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        const digits = unitIndex === 0 ? 0 : 2;
        return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    function init(root) {
        const scope = root || document;
        
        // Handle old FileDropInput components with [data-file-drop]
        const zones = scope.querySelectorAll('[data-file-drop]');
        if (zones && zones.length > 0) {
            zones.forEach((zone) => {
                if (initialized.has(zone)) return;
                initialized.add(zone);

                const input = zone.querySelector('input[type="file"]');
                const empty = zone.querySelector('.file-drop-empty');
                const selected = zone.querySelector('.file-drop-selected');
                const nameEl = zone.querySelector('.file-drop-selected-name');
                const sizeEl = zone.querySelector('.file-drop-selected-size');
                const chooseBtn = zone.querySelector('.file-drop-button');
                const changeBtn = zone.querySelector('.file-drop-change');

                if (!input || !empty || !selected || !nameEl || !sizeEl) return;

                function updateUi() {
                    const file = input.files && input.files.length > 0 ? input.files[0] : null;
                    if (file) {
                        nameEl.textContent = file.name || '';
                        sizeEl.textContent = formatBytes(file.size || 0);
                        empty.setAttribute('hidden', '');
                        selected.removeAttribute('hidden');
                        zone.classList.add('has-file');
                    } else {
                        nameEl.textContent = '';
                        sizeEl.textContent = '';
                        selected.setAttribute('hidden', '');
                        empty.removeAttribute('hidden');
                        zone.classList.remove('has-file');
                    }
                }

                function openDialog() {
                    input.click();
                }

                chooseBtn?.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    openDialog();
                });

                changeBtn?.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    openDialog();
                });

                zone.addEventListener('click', (ev) => {
                    const target = ev.target;
                    if (target === input || (target instanceof HTMLElement && target.closest('button'))) return;
                    openDialog();
                });

                zone.addEventListener('dragover', (ev) => {
                    ev.preventDefault();
                    zone.classList.add('is-dragging');
                });

                zone.addEventListener('dragleave', (ev) => {
                    if (ev.relatedTarget && zone.contains(ev.relatedTarget)) return;
                    zone.classList.remove('is-dragging');
                });

                zone.addEventListener('drop', (ev) => {
                    ev.preventDefault();
                    zone.classList.remove('is-dragging');
                    const files = ev.dataTransfer?.files;
                    if (!files || files.length === 0) return;
                    const file = files[0];
                    try {
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        input.files = dt.files;
                    } catch {
                        // Fallback: if DataTransfer is not supported, just ignore.
                    }
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    updateUi();
                });

                input.addEventListener('change', updateUi);

                updateUi();
            });
        }

        // Handle new FileDropZone components
        const dropZones = scope.querySelectorAll('[id$="-zone"], [id^="drop-zone"]');
        if (dropZones && dropZones.length > 0) {
            dropZones.forEach((dropZone) => {
                // Skip if already initialized or if it's an old-style drop zone
                if (initialized.has(dropZone) || dropZone.hasAttribute('data-file-drop')) return;
                
                // Check if this drop zone has a hidden file input inside
                const input = dropZone.querySelector('input[type="file"].hidden');
                if (!input) return;

                initialized.add(dropZone);

                // Get UI elements
                const emptyState = dropZone.querySelector('.file-drop-empty');
                const selectedState = dropZone.querySelector('.file-drop-selected');
                const nameEl = dropZone.querySelector('.file-drop-name');
                const sizeEl = dropZone.querySelector('.file-drop-size');
                const previewImg = dropZone.querySelector('.file-drop-preview');
                const clearBtn = dropZone.querySelector('.file-drop-clear-btn');
                const chooseBtn = dropZone.querySelector('.file-drop-choose-btn');
                const changeBtn = dropZone.querySelector('.file-drop-change-btn');

                // Update UI based on file selection
                function updateUI() {
                    const file = input.files && input.files.length > 0 ? input.files[0] : null;
                    
                    if (file) {
                        // File selected - update UI
                        dropZone.setAttribute('data-has-file', 'true');
                        
                        // Only hide empty state if we have a selected state to show
                        if (emptyState && selectedState) {
                            emptyState.classList.add('hidden');
                            selectedState.classList.remove('hidden');
                        }
                        
                        // Update file info
                        if (nameEl) nameEl.textContent = file.name || '';
                        if (sizeEl) sizeEl.textContent = formatBytes(file.size || 0);
                        
                        // Update preview for images
                        if (previewImg && file.type.startsWith('image/')) {
                            const reader = new FileReader();
                            reader.onload = (e) => {
                                previewImg.src = e.target.result;
                                previewImg.style.display = 'block';
                            };
                            reader.readAsDataURL(file);
                        } else if (previewImg) {
                            previewImg.style.display = 'none';
                        }
                        
                        // Show clear button
                        if (clearBtn) {
                            clearBtn.classList.remove('opacity-0', 'pointer-events-none');
                            clearBtn.classList.add('opacity-100');
                        }
                    } else {
                        // No file - reset UI
                        dropZone.setAttribute('data-has-file', 'false');
                        
                        // Only show empty state if we have both states
                        if (emptyState && selectedState) {
                            emptyState.classList.remove('hidden');
                            selectedState.classList.add('hidden');
                        }
                        
                        if (nameEl) nameEl.textContent = '';
                        if (sizeEl) sizeEl.textContent = '';
                        if (previewImg) {
                            previewImg.src = '';
                            previewImg.style.display = 'none';
                        }
                        
                        // Hide clear button
                        if (clearBtn) {
                            clearBtn.classList.add('opacity-0', 'pointer-events-none');
                            clearBtn.classList.remove('opacity-100');
                        }
                    }
                }

                // Clear file handler
                if (clearBtn) {
                    clearBtn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        input.value = '';
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        updateUI();
                    });
                }

                // Choose file button handler
                if (chooseBtn) {
                    chooseBtn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        input.click();
                    });
                }

                // Change file button handler
                if (changeBtn) {
                    changeBtn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        input.click();
                    });
                }

                // Click handler - trigger file input when clicking on drop zone (but not on buttons)
                dropZone.addEventListener('click', (ev) => {
                    const target = ev.target;
                    // Don't trigger if clicking on the input itself or a button
                    if (target === input) return;
                    if (target instanceof HTMLElement && target.closest('button')) {
                        // Button handlers are defined above, don't do anything here
                        return;
                    }
                    // Click anywhere else in the drop zone - open file dialog
                    input.click();
                });

                // Drag and drop handlers
                dropZone.addEventListener('dragover', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    dropZone.classList.add('border-blue-500', 'bg-blue-50');
                    dropZone.classList.remove('border-gray-300');
                });

                dropZone.addEventListener('dragleave', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    // Only remove highlight if we're leaving the drop zone entirely
                    if (ev.relatedTarget && dropZone.contains(ev.relatedTarget)) return;
                    dropZone.classList.remove('border-blue-500', 'bg-blue-50');
                    dropZone.classList.add('border-gray-300');
                });

                dropZone.addEventListener('drop', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    
                    dropZone.classList.remove('border-blue-500', 'bg-blue-50');
                    dropZone.classList.add('border-gray-300');

                    const files = ev.dataTransfer?.files;
                    if (files && files.length > 0) {
                        try {
                            const dataTransfer = new DataTransfer();
                            
                            // Add files based on multiple attribute
                            if (input.hasAttribute('multiple')) {
                                // Add all dropped files
                                for (let i = 0; i < files.length; i++) {
                                    dataTransfer.items.add(files[i]);
                                }
                            } else {
                                // Add only the first file
                                dataTransfer.items.add(files[0]);
                            }
                            
                            input.files = dataTransfer.files;
                        } catch {
                            // Fallback for older browsers
                        }
                        
                        // Trigger change event
                        const changeEvent = new Event('change', { bubbles: true });
                        input.dispatchEvent(changeEvent);
                        updateUI();
                    }
                });

                // Listen for file input changes
                input.addEventListener('change', updateUI);

                // Initialize UI
                updateUI();
            });
        }
    }

    function initAll() {
        init(document);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

    try {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                    init(document);
                    break;
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }

    document.addEventListener('blazor:enhancedload', initAll);
})();
