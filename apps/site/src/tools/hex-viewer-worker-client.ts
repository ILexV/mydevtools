/**
 * Page-side handle for the hex viewer worker. One runner stays alive until
 * cancel, clear or a new file terminates it. The next search spawns a fresh worker.
 */
import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type { HexViewerRequest, HexViewerSuccess } from "@/tools/hex-viewer-protocol";

export interface HexViewerWorkerClient {
  search(file: File, needle: Uint8Array, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<HexViewerSuccess, { kind: "search" }>>;
  entropy(file: File, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<HexViewerSuccess, { kind: "entropy" }>>;
  terminate(): void;
}

function resultOfKind<K extends HexViewerSuccess["kind"]>(
  result: HexViewerSuccess,
  kind: K,
): Extract<HexViewerSuccess, { kind: K }> {
  if (result.kind !== kind) throw new Error(`Unexpected hex viewer response: ${result.kind}`);
  return result as Extract<HexViewerSuccess, { kind: K }>;
}

export function createHexViewerWorker(): HexViewerWorkerClient {
  const worker = createJobWorker<HexViewerRequest, HexViewerSuccess>(
    () => new Worker(new URL("../workers/hex-viewer.worker.ts", import.meta.url), { type: "module" }),
  );

  return {
    async search(file, needle, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "search", file, needle }, [], signal, onProgress), "search");
    },
    async entropy(file, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "entropy", file }, [], signal, onProgress), "entropy");
    },
    terminate() {
      worker.terminate();
    },
  };
}
