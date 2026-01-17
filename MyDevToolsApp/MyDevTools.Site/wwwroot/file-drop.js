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
        const zones = scope.querySelectorAll('[data-file-drop]');
        if (!zones || zones.length === 0) return;

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
