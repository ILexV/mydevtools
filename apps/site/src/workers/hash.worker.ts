/// <reference lib="webworker" />
/**
 * Hash Web Worker. Imports the wasm-bindgen glue directly (the worker is its
 * own bundle), hashes files or UTF-8 text in 1 MiB chunks through `Hasher`,
 * and posts progress/result/error. The client terminates the worker on
 * cancellation or error, including during synchronous WASM calls.
 *
 * No SharedArrayBuffer; the `File` arrives via structured clone.
 */
import { readBlobChunks } from "@/scripts/blob-chunks";
import init, { Hasher } from "@/generated/wasm/hash/hash.js";
import { classifyWorkerError, type WorkerRequest, type WorkerResponse, type HashResult } from "@/scripts/wasm/worker-protocol";

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

  for await (const chunk of readBlobChunks(file, { chunkBytes: CHUNK_SIZE })) {
    for (const { h } of hashers) h.update(chunk.bytes);
    processed = chunk.end;
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
    post({ id, ok: true, hashes });
  } catch (e) {
    const classified = classifyWorkerError(e);
    const code = classified.code === "memory-exhausted"
      ? classified.code
      : /algorithm/iu.test(classified.message) ? "invalid-algorithm" : classified.code;
    post({ id, ok: false, code, message: classified.message });
  }
});

export {}; // module
