/// <reference lib="webworker" />
/**
 * Hex viewer worker. Searches a byte needle and samples Shannon entropy off
 * the UI thread. Cancel terminates this worker, which drops the in-flight
 * slice reads. The page keeps the File and does not need a new open.
 */
import { HexViewerError, scanEntropy, searchBytes } from "@/tools/hex-viewer";
import type { HexViewerRequest, HexViewerSuccess } from "@/tools/hex-viewer-protocol";
import { classifyWorkerError } from "@/scripts/wasm/worker-protocol";

function post(message: { id: number; ok: true } & HexViewerSuccess | { id: number; ok: false; message: string; code: string } | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number }): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function progress(id: number, processed: number, total: number, started: number): void {
  post({ id, type: "progress", processed, total, elapsedMs: performance.now() - started });
}

async function readSlice(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function handle(id: number, request: HexViewerRequest): Promise<void> {
  const started = performance.now();
  try {
    let result: HexViewerSuccess;
    if (request.type === "search") {
      const needle = new Uint8Array(request.needle);
      const hit = await searchBytes(request.file.size, needle, (start, end) => readSlice(request.file, start, end), {
        onProgress: (processed, total) => progress(id, processed, total, started),
      });
      result = { kind: "search", offsets: hit.offsets, capped: hit.capped };
    } else {
      const scan = await scanEntropy(request.file.size, (start, end) => readSlice(request.file, start, end), (processed, total) => {
        progress(id, processed, total, started);
      });
      result = { kind: "entropy", samples: scan.samples, average: scan.average, sampled: scan.sampled };
    }
    post({ id, ok: true, ...result });
  } catch (error) {
    const hexError = error instanceof HexViewerError ? error : null;
    const limited = hexError?.code === "needle-too-long" || hexError?.code === "range-too-large";
    const fallback = hexError ? (limited ? "input-too-large" : "unknown") : "worker-failed";
    const classified = classifyWorkerError(error, fallback);
    post({
      id,
      ok: false,
      code: classified.code,
      message: hexError?.code ?? classified.message,
    });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<HexViewerRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as HexViewerRequest));
});

export {};
