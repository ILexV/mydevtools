/// <reference lib="webworker" />
/**
 * Hash Web Worker. Imports the wasm-bindgen glue directly (the worker is its
 * own bundle), hashes files or UTF-8 text in 1 MiB chunks through `Hasher`,
 * and posts progress/result/error. The client terminates the worker on
 * cancellation or error, including during synchronous WASM calls.
 *
 * No SharedArrayBuffer; the `File` arrives via structured clone.
 */
import init, { Hasher } from "@/generated/wasm/hash/hash.js";
import type { WorkerRequest, WorkerResponse, HashResult, WasmErrorCode } from "@/scripts/wasm/worker-protocol";

const CHUNK_SIZE = 1024 * 1024; // 1 MiB

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function post(msg: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

async function hashBlob(file: Blob, algorithms: string[], id: number): Promise<HashResult[]> {
  const hashers = algorithms.map((alg) => ({ alg, h: new Hasher(alg) }));
  const total = file.size;
  let processed = 0;
  const start = performance.now();
  post({ type: "progress", id, processed, total, elapsedMs: 0 });

  while (processed < total) {
    const end = Math.min(processed + CHUNK_SIZE, total);
    const buf = await file.slice(processed, end).arrayBuffer();
    const bytes = new Uint8Array(buf);
    for (const { h } of hashers) h.update(bytes);
    processed += bytes.byteLength;
    post({ type: "progress", id, processed, total, elapsedMs: performance.now() - start });
  }
  return hashers.map(({ alg, h }) => ({ id: h.algorithm() ?? alg, hex: h.finalize() }));
}

self.addEventListener("message", async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const { id, algorithms } = req;
  try {
    await ensureReady();
    // Convert text once, inside the worker; every algorithm consumes the same bytes.
    const hashes = await hashBlob(req.file ?? new Blob([req.text ?? ""]), algorithms, id);
    post({ type: "result", id, hashes });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code: WasmErrorCode = /algorithm/i.test(message) ? "invalid-algorithm" : "unknown";
    post({ type: "error", id, code, message });
  }
});

export {}; // module
