/* global window, document */

(function () {
    if (window.MyDevToolsFile) return;

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

    async function readFileInChunks(file, options) {
        const chunkSize = options?.chunkSize ?? 1024 * 1024;
        const onChunk = options?.onChunk;
        const onProgress = options?.onProgress;
        const signal = options?.signal;
        const total = file.size;
        let processed = 0;
        const start = performance.now();

        while (processed < total) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = file.slice(processed, Math.min(processed + chunkSize, total));
            const buf = await chunk.arrayBuffer();
            const bytes = new Uint8Array(buf);
            if (onChunk) await onChunk(bytes, { offset: processed, total });

            processed += chunk.size;
            if (onProgress) {
                const elapsedMs = performance.now() - start;
                onProgress({ processed, total, elapsedMs });
            }

            await new Promise(requestAnimationFrame);
        }
    }

    window.MyDevToolsFile = {
        formatBytes,
        formatDuration,
        readFileInChunks
    };
})();
