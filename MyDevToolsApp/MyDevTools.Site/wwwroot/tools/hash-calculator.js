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

    async function computeHashText(algorithm, data) {
        const wasm = await getHashWasm();
        const algoMap = {
            'MD5': 'md5',
            'SHA-1': 'sha1',
            'SHA-224': 'sha224',
            'SHA-256': 'sha256',
            'SHA-384': 'sha384',
            'SHA-512': 'sha512',
            'SHA-512/224': 'sha512-224',
            'SHA-512/256': 'sha512-256',
            'SHA-3-256': 'sha3-256',
            'SHA-3-224': 'sha3-224',
            'SHA-3-384': 'sha3-384',
            'SHA-3-512': 'sha3-512',
            'BLAKE3': 'blake3',
            'BLAKE2b-512': 'blake2b-512',
            'BLAKE2s-256': 'blake2s-256',
            'RIPEMD-160': 'ripemd-160',
            'CRC32': 'crc32',
            'Adler-32': 'adler32',
            'xxh3-64': 'xxh3-64',
            'SipHash-1-3': 'siphash-1-3',
            'SipHash-2-4': 'siphash-2-4',
            'HighwayHash64': 'highwayhash64',
            'MetroHash64': 'metrohash64',
            'FxHash64': 'fxhash64',
            'FNV-1a 64': 'fnv1a64',
            'SeaHash64': 'seahash64',
        };

        const algoId = algoMap[algorithm];
        if (!algoId) return { algorithm: algorithm, value: 'Unsupported algorithm' };

        const hex = wasm.hash_bytes(algoId, data);
        return { algorithm: algorithm, value: hex };
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
            canceled: root.dataset.canceled || 'Canceled'
        };
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
                    [
                        'md5',
                        'sha1',
                        'sha224',
                        'sha256',
                        'sha384',
                        'sha512',
                        'sha512-224',
                        'sha512-256',
                        'sha3-256',
                        'sha3-224',
                        'sha3-384',
                        'sha3-512',
                        'blake3',
                        'blake2b-512',
                        'blake2s-256',
                        'ripemd-160',
                        'crc32',
                        'adler32',
                        'xxh3-64',
                        'siphash-1-3',
                        'siphash-2-4',
                        'highwayhash64',
                        'metrohash64',
                        'fxhash64',
                        'fnv1a64',
                        'seahash64'
                    ],
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

                const labelMap = {
                    md5: 'MD5',
                    sha1: 'SHA-1',
                    sha224: 'SHA-224',
                    sha256: 'SHA-256',
                    sha384: 'SHA-384',
                    sha512: 'SHA-512',
                    'sha512-224': 'SHA-512/224',
                    'sha512-256': 'SHA-512/256',
                    'sha3-256': 'SHA-3-256',
                    'sha3-224': 'SHA-3-224',
                    'sha3-384': 'SHA-3-384',
                    'sha3-512': 'SHA-3-512',
                    blake3: 'BLAKE3',
                    'blake2b-512': 'BLAKE2b-512',
                    'blake2s-256': 'BLAKE2s-256',
                    'ripemd-160': 'RIPEMD-160',
                    crc32: 'CRC32',
                    adler32: 'Adler-32',
                    'xxh3-64': 'xxh3-64',
                    'siphash-1-3': 'SipHash-1-3',
                    'siphash-2-4': 'SipHash-2-4',
                    highwayhash64: 'HighwayHash64',
                    metrohash64: 'MetroHash64',
                    fxhash64: 'FxHash64',
                    fnv1a64: 'FNV-1a 64',
                    seahash64: 'SeaHash64'
                };

                displayResults(
                    els.outputSection,
                    strings.copy,
                    results.map(r => ({ algorithm: labelMap[r.id] || r.id, value: r.hex }))
                );
            } else {
                renderTextSkeleton(els.outputSection);

                const encoder = new TextEncoder();
                const data = encoder.encode(text);

                const results = await Promise.all([
                    computeHashText('MD5', data),
                    computeHashText('SHA-1', data),
                    computeHashText('SHA-224', data),
                    computeHashText('SHA-256', data),
                    computeHashText('SHA-384', data),
                    computeHashText('SHA-512', data),
                    computeHashText('SHA-512/224', data),
                    computeHashText('SHA-512/256', data),
                    computeHashText('SHA-3-256', data),
                    computeHashText('SHA-3-224', data),
                    computeHashText('SHA-3-384', data),
                    computeHashText('SHA-3-512', data),
                    computeHashText('BLAKE3', data),
                    computeHashText('BLAKE2b-512', data),
                    computeHashText('BLAKE2s-256', data),
                    computeHashText('RIPEMD-160', data),
                    computeHashText('CRC32', data),
                    computeHashText('Adler-32', data),
                    computeHashText('xxh3-64', data),
                    computeHashText('SipHash-1-3', data),
                    computeHashText('SipHash-2-4', data),
                    computeHashText('HighwayHash64', data),
                    computeHashText('MetroHash64', data),
                    computeHashText('FxHash64', data),
                    computeHashText('FNV-1a 64', data),
                    computeHashText('SeaHash64', data)
                ]);

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
})();
