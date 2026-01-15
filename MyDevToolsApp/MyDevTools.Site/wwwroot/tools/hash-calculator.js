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

    async function hashFileSha256WithProgress(file, onProgress, signal) {
        const wasm = await getHashWasm();
        const hasher = new wasm.Hasher('sha256');

        const chunkSize = 1024 * 1024; // 1 MiB
        let processed = 0;
        const total = file.size;
        const start = performance.now();

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            hasher.update(new Uint8Array(buf));
            processed += chunk.size;

            const elapsedMs = performance.now() - start;
            onProgress({ processed, total, elapsedMs });

            // Yield to keep UI responsive.
            await new Promise(requestAnimationFrame);
        }

        return hasher.finalize();
    }

    async function computeHashTextViaWebCrypto(algorithm, data) {
        // Map algorithm names to SubtleCrypto format
        const algoMap = {
            'MD5': null, // MD5 is not supported in SubtleCrypto
            'SHA-1': 'SHA-1',
            'SHA-256': 'SHA-256',
            'SHA-512': 'SHA-512'
        };

        const cryptoAlgo = algoMap[algorithm];

        if (!cryptoAlgo) {
            return { algorithm: algorithm, value: 'MD5 will be calculated via WASM' };
        }

        const hashBuffer = await crypto.subtle.digest(cryptoAlgo, data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        return { algorithm: algorithm, value: hashHex };
    }

    function displayResults(outputSection, copyLabel, results) {
        outputSection.innerHTML = results.map(result => `
            <div class="hash-result">
                <div class="hash-label">${escapeHtml(result.algorithm)}</div>
                <div class="hash-value-container">
                    <input type="text" readonly value="${escapeHtml(result.value)}" class="hash-value" />
                    <button class="btn-copy" data-copy-value="${escapeHtml(result.value)}">${escapeHtml(copyLabel)}</button>
                </div>
            </div>
        `).join('');
    }

    function bindCopyButtons(outputSection, copiedLabel) {
        outputSection.querySelectorAll('button.btn-copy[data-copy-value]').forEach(btn => {
            if (btn.dataset.bound === '1') return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', async () => {
                const text = btn.dataset.copyValue || '';
                await navigator.clipboard.writeText(text);
                const original = btn.textContent;
                btn.textContent = copiedLabel;
                setTimeout(() => {
                    btn.textContent = original;
                }, 2000);
            });
        });
    }

    function init() {
        const root = document.getElementById('hash-calculator-root');
        if (!root) return;

        const inputText = document.getElementById('input-text');
        const inputFile = document.getElementById('input-file');
        const calculateBtn = document.getElementById('calculate-btn');
        const clearBtn = document.getElementById('clear-btn');
        const outputSection = document.getElementById('output-section');

        if (!calculateBtn || !clearBtn || !inputText || !outputSection || !inputFile) return;
        if (calculateBtn.dataset.bound === '1') return;
        calculateBtn.dataset.bound = '1';
        clearBtn.dataset.bound = '1';

        const strings = {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error',
            calculate: root.dataset.calculate || 'Calculate',
            fileProgressTitle: root.dataset.fileProgressTitle || 'Hashing file...',
            cancel: root.dataset.cancel || 'Cancel',
            copy: root.dataset.copy || 'Copy',
            copied: root.dataset.copied || 'Copied!',
            canceled: root.dataset.canceled || 'Canceled'
        };

        let abortController = null;

        calculateBtn.addEventListener('click', async function () {
            const file = inputFile.files && inputFile.files.length > 0 ? inputFile.files[0] : null;
            const text = inputText.value.trim();

            if (!file && !text) return;

            calculateBtn.disabled = true;
            calculateBtn.textContent = strings.loading;

            try {
                if (file) {
                    abortController = new AbortController();

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

                    const cancelBtn = document.getElementById('cancel-btn');
                    if (cancelBtn) {
                        cancelBtn.addEventListener('click', () => abortController.abort());
                    }

                    const progressBar = document.getElementById('file-progress-bar');
                    const progressStats = document.getElementById('file-progress-stats');

                    const hex = await hashFileSha256WithProgress(
                        file,
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

                    displayResults(outputSection, strings.copy, [
                        { algorithm: 'SHA-256', value: hex }
                    ]);
                    bindCopyButtons(outputSection, strings.copied);
                } else {
                    // Text path (WebCrypto)
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

                    const encoder = new TextEncoder();
                    const data = encoder.encode(text);

                    const results = await Promise.all([
                        computeHashTextViaWebCrypto('MD5', data),
                        computeHashTextViaWebCrypto('SHA-1', data),
                        computeHashTextViaWebCrypto('SHA-256', data),
                        computeHashTextViaWebCrypto('SHA-512', data)
                    ]);

                    displayResults(outputSection, strings.copy, results);
                    bindCopyButtons(outputSection, strings.copied);
                }
            } catch (err) {
                const isAbort = err && (err.name === 'AbortError');
                displayResults(outputSection, strings.copy, [
                    { algorithm: strings.error, value: isAbort ? strings.canceled : (err?.message || String(err)) }
                ]);
            } finally {
                abortController = null;
                calculateBtn.disabled = false;
                calculateBtn.textContent = strings.calculate;
            }
        });

        clearBtn.addEventListener('click', function () {
            inputText.value = '';
            inputFile.value = '';
            outputSection.innerHTML = '';

            if (abortController) {
                abortController.abort();
                abortController = null;
            }
        });

        // Back-compat: if something calls window.copyToClipboard
        window.copyToClipboard = function (button, text) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = button.textContent;
                button.textContent = strings.copied;
                setTimeout(() => {
                    button.textContent = originalText;
                }, 2000);
            });
        };
    }

    // Initial load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Blazor SSR enhanced navigation
    window.addEventListener('enhancedload', init);
    document.addEventListener('enhancedload', init);
    window.addEventListener('pageshow', init);
})();
