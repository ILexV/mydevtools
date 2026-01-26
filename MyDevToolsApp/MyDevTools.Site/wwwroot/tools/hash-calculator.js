/* global document, window */

(function () {
    function escapeHtml(text) {
        return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

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

    function formatDuration(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '--:--';
        const s = Math.floor(seconds % 60);
        const m = Math.floor((seconds / 60) % 60);
        const h = Math.floor(seconds / 3600);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    const DEFAULT_SELECTED_ALGORITHM_IDS = ['md5', 'sha1', 'sha256'];
    const STORAGE_KEY_SELECTED_ALGOS = 'mydevtools.tools.hash-calculator.selectedAlgorithms.v1';

    // const initializedRoots = new WeakSet();
    const rootStates = new WeakMap();

    function getState(root) {
        let state = rootStates.get(root);
        if (!state) {
            state = {
                algorithms: [],
                algoById: new Map(),
                selectedIds: [],
                search: ''
            };
            rootStates.set(root, state);
        }
        return state;
    }

    function tryReadAlgorithmsFromDom() {
        const script = document.getElementById('hash-algorithms-data');
        if (!script) return null;

        try {
            const text = script.textContent || '';
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) return null;

            return parsed
                .filter((x) => x && typeof x.id === 'string' && typeof x.label === 'string')
                .map((x) => ({ id: String(x.id), label: String(x.label) }));
        } catch {
            return null;
        }
    }

    function loadSelectedAlgorithmIds(validIdsSet) {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_SELECTED_ALGOS);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;
            const filtered = parsed.filter((x) => typeof x === 'string' && validIdsSet.has(x));
            return filtered;
        } catch {
            return null;
        }
    }

    function saveSelectedAlgorithmIds(ids) {
        try {
            localStorage.setItem(STORAGE_KEY_SELECTED_ALGOS, JSON.stringify(ids));
        } catch {
            // ignore
        }
    }

    let hashWasmModulePromise = null;

    async function getHashWasm() {
        if (!hashWasmModulePromise) {
            hashWasmModulePromise = import('/wasm/hash/hash.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return hashWasmModulePromise;
    }

    async function hashFileWithProgress(file, algorithmIds, onProgress, signal) {
        const wasm = await getHashWasm();
        const hashers = algorithmIds.map((id) => ({ id, hasher: new wasm.Hasher(id) }));

        const chunkSize = 1024 * 1024; // 1 MiB
        let processed = 0;
        const total = file.size;
        const start = performance.now();

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            const bytes = new Uint8Array(buf);
            for (const h of hashers) {
                h.hasher.update(bytes);
            }
            processed += chunk.size;

            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs });

            // Yield to keep UI responsive.
            await new Promise(requestAnimationFrame);
        }

        return hashers.map(({ id, hasher }) => ({ id, hex: hasher.finalize() }));
    }

    async function computeHashBytes(algorithmId, data) {
        const wasm = await getHashWasm();
        return wasm.hash_bytes(algorithmId, data);
    }

    function displayResults(outputSection, copyLabel, results) {
        if (!results || results.length === 0) {
            outputSection.innerHTML = '';
            return;
        }

        const table = `
            <div class="overflow-x-auto border border-base-300 rounded-lg">
                <table class="table table-zebra table-sm w-full">
                    <thead>
                        <tr class="bg-base-200">
                            <th class="w-32">Algorithm</th>
                            <th>Hash</th>
                            <th class="w-20 text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${results.map(result => `
                            <tr>
                                <td class="font-bold whitespace-nowrap align-top py-2">${escapeHtml(result.algorithm)}</td>
                                <td class="font-mono text-xs break-all align-middle py-2">${escapeHtml(result.value)}</td>
                                <td class="text-right align-top py-2">
                                    <button class="btn btn-ghost btn-xs btn-copy" data-copy-value="${escapeHtml(result.value)}" title="${escapeHtml(copyLabel)}">
                                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m2 4h6a2 2 0 012 2v6a2 2 0 01-2 2h-6a2 2 0 01-2-2v-6a2 2 0 012-2z" />
                                        </svg>
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
        outputSection.innerHTML = table;
    }

    function clearOutput(outputSection) {
        if (!outputSection) return;
        if (!outputSection.innerHTML) return;
        outputSection.innerHTML = '';
    }

    let abortController = null;

    function getElements() {
        const root = document.getElementById('hash-calculator-root');
        if (!root) return null;

        const inputText = document.getElementById('input-text');
        const inputFile = document.getElementById('input-file');
        const calculateBtn = document.getElementById('calculate-btn');
        const clearBtn = document.getElementById('clear-btn');
        const outputSection = document.getElementById('output-section');

        if (!calculateBtn || !clearBtn || !inputText || !outputSection || !inputFile) return null;

        return { root, inputText, inputFile, calculateBtn, clearBtn, outputSection };
    }

    function getStrings(root) {
        return {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            calculate: root.dataset.calculate || 'Calculate',
            fileProgressTitle: root.dataset.fileProgressTitle || 'Hashing file...',
            cancel: root.dataset.cancel || 'Cancel',
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!',
            canceled: root.dataset.canceled || 'Canceled',
            algorithmsTitle: root.dataset.algorithmsTitle || 'Algorithms',
            algorithmsSelected: root.dataset.algorithmsSelected || 'Selected',
            algorithmsAvailable: root.dataset.algorithmsAvailable || 'Available',
            algorithmsSearch: root.dataset.algorithmsSearch || 'Search algorithms...',
            algorithmsReset: root.dataset.algorithmsReset || 'Reset to defaults',
            algorithmsSelectOne: root.dataset.algorithmsSelectOne || 'Select at least one algorithm.'
        };
    }

    function buildAlgorithmsState(root) {
        const state = getState(root);
        if (state.algorithms.length > 0) return state;

        const algorithms = tryReadAlgorithmsFromDom() || [];
        state.algorithms = algorithms;
        state.algoById = new Map(algorithms.map((a) => [a.id, a]));

        if (algorithms.length === 0) {
            // If the page didn't provide the algorithm list yet, don't clobber stored settings.
            return state;
        }

        const validIds = new Set(algorithms.map((a) => a.id));
        const stored = loadSelectedAlgorithmIds(validIds);
        const initial = stored && stored.length > 0
            ? stored
            : DEFAULT_SELECTED_ALGORITHM_IDS.filter((id) => validIds.has(id));

        state.selectedIds = initial;
        if (!stored) saveSelectedAlgorithmIds(initial);

        return state;
    }

    function getSelectedAlgorithms(root) {
        const state = buildAlgorithmsState(root);
        return state.selectedIds
            .map((id) => state.algoById.get(id))
            .filter(Boolean);
    }

    function renderAlgorithmPicker(root) {
        const els = getElements();
        if (!els) return;

        const strings = getStrings(root);
        const state = buildAlgorithmsState(root);

        const titleEl = document.getElementById('hash-algo-title');
        const selectedCountEl = document.getElementById('hash-algo-selected-count');
        const availableCountEl = document.getElementById('hash-algo-available-count');
        const resetBtn = document.getElementById('hash-algo-reset-btn');
        const searchInput = document.getElementById('hash-algo-search');
        const selectedTitle = document.getElementById('hash-algo-selected-title');
        const availableTitle = document.getElementById('hash-algo-available-title');
        const selectedList = document.getElementById('hash-algo-selected-list');
        const availableList = document.getElementById('hash-algo-available-list');

        if (!titleEl || !selectedCountEl || !resetBtn || !searchInput || !selectedTitle || !availableTitle || !selectedList || !availableList) {
            return;
        }

        titleEl.textContent = strings.algorithmsTitle;
        selectedTitle.textContent = strings.algorithmsSelected;
        availableTitle.textContent = strings.algorithmsAvailable;
        resetBtn.textContent = strings.algorithmsReset;
        searchInput.placeholder = strings.algorithmsSearch;
        if (typeof searchInput.value === 'string' && state.search && searchInput.value !== state.search) {
            searchInput.value = state.search;
        }

        const query = (state.search || '').trim().toLowerCase();
        const matches = (algo) => {
            if (!query) return true;
            return algo.label.toLowerCase().includes(query) || algo.id.toLowerCase().includes(query);
        };

        const selectedSet = new Set(state.selectedIds);
        const selected = state.selectedIds
            .map((id) => state.algoById.get(id))
            .filter(Boolean)
            .filter(matches)
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

        const available = state.algorithms
            .filter((a) => !selectedSet.has(a.id))
            .filter(matches)
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

        selectedCountEl.textContent = state.selectedIds.length;
        if (availableCountEl) {
            // Show total available count (ignoring search) to be consistent with selected count
            availableCountEl.textContent = state.algorithms.length - state.selectedIds.length;
        }

        selectedList.innerHTML = '';
        availableList.innerHTML = '';

        function addItem(container, algo, checked) {
            const row = document.createElement('div');
            row.className = 'algo-item flex items-center space-x-2 py-0 min-h-[24px] hover:bg-base-300 rounded px-1 transition-colors cursor-pointer';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = checked;
            input.dataset.algorithmId = algo.id;
            input.id = `hash-algo-${algo.id}`;

            const label = document.createElement('label');
            label.htmlFor = input.id;
            label.textContent = algo.label;

            row.appendChild(input);
            row.appendChild(label);
            container.appendChild(row);
        }

        if (selected.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'algo-empty';
            empty.textContent = '—';
            selectedList.appendChild(empty);
        } else {
            for (const algo of selected) addItem(selectedList, algo, true);
        }

        if (available.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'algo-empty';
            empty.textContent = '—';
            availableList.appendChild(empty);
        } else {
            for (const algo of available) addItem(availableList, algo, false);
        }
    }

    function renderTextSkeleton(outputSection) {
        outputSection.innerHTML = `
            <div class="loading-skeleton">
                <div class="skeleton-header"></div>
                <div class="skeleton-content">
                    <div class="skeleton-line"></div>
                    <div class="skeleton-line"></div>
                    <div class="skeleton-line short"></div>
                </div>
            </div>
        `;
    }

    function renderFileProgress(outputSection, strings, file) {
        outputSection.innerHTML = `
            <div class="file-progress">
                <div class="file-progress-header">
                    <div class="file-progress-title">${escapeHtml(strings.fileProgressTitle)}</div>
                    <button class="btn btn-secondary btn-small" id="cancel-btn">${escapeHtml(strings.cancel)}</button>
                </div>
                <div class="file-progress-meta">${escapeHtml(file.name)} • ${formatBytes(file.size)}</div>
                <progress id="file-progress-bar" value="0" max="100"></progress>
                <div id="file-progress-stats" class="file-progress-stats"></div>
            </div>
        `;
    }

    async function handleCalculate() {
        const els = getElements();
        if (!els) return;

        const strings = getStrings(els.root);
        const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
        const text = els.inputText.value.trim();

        const selectedAlgorithms = getSelectedAlgorithms(els.root);
        if (!selectedAlgorithms || selectedAlgorithms.length === 0) {
            displayResults(els.outputSection, strings.copy, [
                { algorithm: strings.error, value: strings.algorithmsSelectOne }
            ]);
            return;
        }

        if (!file && !text) return;

        els.calculateBtn.disabled = true;
        els.calculateBtn.textContent = strings.loading;

        try {
            if (file) {
                abortController = new AbortController();
                renderFileProgress(els.outputSection, strings, file);

                const progressBar = document.getElementById('file-progress-bar');
                const progressStats = document.getElementById('file-progress-stats');

                const results = await hashFileWithProgress(
                    file,
                    selectedAlgorithms.map((a) => a.id),
                    ({ processed, total, elapsedMs }) => {
                        const pct = total > 0 ? (processed / total) * 100 : 0;
                        const elapsedSec = elapsedMs / 1000;
                        const speed = elapsedSec > 0 ? processed / elapsedSec : 0;
                        const etaSec = speed > 0 ? (total - processed) / speed : Infinity;

                        if (progressBar) progressBar.value = pct;
                        if (progressStats) {
                            progressStats.textContent = `${pct.toFixed(1)}% • ${formatBytes(processed)} / ${formatBytes(total)} • ${formatBytes(speed)}/s • ETA ${formatDuration(etaSec)}`;
                        }
                    },
                    abortController.signal
                );

                const state = buildAlgorithmsState(els.root);
                const labelMap = state.algoById;

                displayResults(
                    els.outputSection,
                    strings.copy,
                    results.map(r => ({ algorithm: (labelMap.get(r.id)?.label) || r.id, value: r.hex }))
                );
            } else {
                renderTextSkeleton(els.outputSection);

                const encoder = new TextEncoder();
                const data = encoder.encode(text);

                const results = await Promise.all(
                    selectedAlgorithms.map(async (algo) => ({
                        algorithm: algo.label,
                        value: await computeHashBytes(algo.id, data)
                    }))
                );

                displayResults(els.outputSection, strings.copy, results);
            }
        } catch (err) {
            const strings2 = getStrings(els.root);
            const isAbort = err && (err.name === 'AbortError');
            displayResults(els.outputSection, strings2.copy, [
                { algorithm: strings2.error, value: isAbort ? strings2.canceled : (err?.message || String(err)) }
            ]);
        } finally {
            abortController = null;
            els.calculateBtn.disabled = false;
            els.calculateBtn.textContent = strings.calculate;
        }
    }

    function handleClear() {
        const els = getElements();
        if (!els) return;

        els.inputText.value = '';
        els.inputFile.value = '';
        els.inputFile.dispatchEvent(new Event('change', { bubbles: true }));
        els.outputSection.innerHTML = '';

        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    }

    async function handleCopyButton(button) {
        const els = getElements();
        if (!els) return;

        const strings = getStrings(els.root);
        const text = button.dataset.copyValue || '';
        try {
            await navigator.clipboard.writeText(text);
            const original = button.textContent;
            button.textContent = strings.copied;
            setTimeout(() => {
                button.textContent = original;
            }, 2000);
        } catch {
            // ignore
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__hashCalculatorDelegatedHandlersBound === true) return;
        window.__hashCalculatorDelegatedHandlersBound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;

            const calcBtn = target.closest('#calculate-btn');
            if (calcBtn) {
                ev.preventDefault();
                void handleCalculate();
                return;
            }

            const clearBtn = target.closest('#clear-btn');
            if (clearBtn) {
                ev.preventDefault();
                handleClear();
                return;
            }

            const cancelBtn = target.closest('#cancel-btn');
            if (cancelBtn) {
                ev.preventDefault();
                if (abortController) abortController.abort();
                return;
            }

            const copyBtn = target.closest('button.btn-copy[data-copy-value]');
            if (copyBtn) {
                ev.preventDefault();
                void handleCopyButton(copyBtn);
                return;
            }

            const resetBtn = target.closest('#hash-algo-reset-btn');
            if (resetBtn) {
                ev.preventDefault();
                const els = getElements();
                if (!els) return;

                const state = buildAlgorithmsState(els.root);
                const validIds = new Set(state.algorithms.map((a) => a.id));
                state.selectedIds = DEFAULT_SELECTED_ALGORITHM_IDS.filter((id) => validIds.has(id));
                saveSelectedAlgorithmIds(state.selectedIds);
                renderAlgorithmPicker(els.root);

                const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
                const text = els.inputText.value.trim();
                if (!file && text) {
                    void handleCalculate();
                }
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLInputElement)) return;
            const algoId = target.dataset.algorithmId;
            if (!algoId) return;

            const els = getElements();
            if (!els) return;
            const state = buildAlgorithmsState(els.root);

            if (target.checked) {
                if (!state.selectedIds.includes(algoId)) {
                    state.selectedIds.push(algoId);
                }
            } else {
                state.selectedIds = state.selectedIds.filter((x) => x !== algoId);
            }

            saveSelectedAlgorithmIds(state.selectedIds);
            renderAlgorithmPicker(els.root);

            const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
            const text = els.inputText.value.trim();
            if (!file && text) {
                void handleCalculate();
            }
        });

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            const els = getElements();
            if (!els) return;

            // Algorithm search
            if (target instanceof HTMLInputElement && target.id === 'hash-algo-search') {
                const state = buildAlgorithmsState(els.root);
                state.search = target.value || '';
                renderAlgorithmPicker(els.root);
                return;
            }

            // Text input: if user types, clear file selection
            if (target instanceof HTMLTextAreaElement && target.id === 'input-text') {
                // Always clear stale results on edit.
                clearOutput(els.outputSection);

                const text = (target.value || '').trim();
                if (text.length > 0 && els.inputFile.value) {
                    els.inputFile.value = '';
                    els.inputFile.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });

        document.addEventListener('change', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.id !== 'input-file') return;

            const els = getElements();
            if (!els) return;

            const file = els.inputFile.files && els.inputFile.files.length > 0 ? els.inputFile.files[0] : null;
            if (file) {
                els.inputText.value = '';
                clearOutput(els.outputSection);
            }
        });

        // Back-compat: if something calls window.copyToClipboard
        window.copyToClipboard = function (button, text) {
            navigator.clipboard.writeText(text).then(() => {
                const els = getElements();
                const strings = els ? getStrings(els.root) : { copied: 'Copied!' };
                const originalText = button.textContent;
                button.textContent = strings.copied;
                setTimeout(() => {
                    button.textContent = originalText;
                }, 2000);
            });
        };
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;

        // STATELESS CHECK: if the algorithm list (checkboxes) is already rendered,
        // assume we are initialized and do not need to re-render.
        // This handles Blazor recycling the container.
        const existingItems = els.root.querySelectorAll('.algo-item');
        if (existingItems.length > 0) return;

        // initializedRoots.add(els.root);
        buildAlgorithmsState(els.root);
        renderAlgorithmPicker(els.root);
    }

    initIfPresent();

    // Ensure the algorithm picker also initializes after enhanced navigation.
    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }
})();
