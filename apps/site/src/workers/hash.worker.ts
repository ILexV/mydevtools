/// <reference lib="webworker" />
/**
 * Hash Web Worker. Imports the wasm-bindgen glue directly (the worker is its
 * own bundle), reads the file in 1 MiB chunks through the streaming `Hasher`,
 * and posts progress/result/error. Cancellation is cooperative: a `cancel`
 * message for the running job sets a flag checked in the chunk loop.
 *
 * No SharedArrayBuffer; the `File` arrives via structured clone.
 */
import init, { Hasher, hash_text_utf8 } from "@/generated/wasm/hash/hash.js";
import type { WorkerRequest, WorkerResponse, HashResult, WasmErrorCode } from "@/scripts/wasm/worker-protocol";

const CHUNK_SIZE = 1024 * 1024; // 1 MiB

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

/** id of the currently running job, or null. Cancel only applies to this. */
let activeId: number | null = null;
let cancelled = false;

function post(msg: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

async function runFile(file: File, algorithms: string[], id: number): Promise<HashResult[]> {
  const hashers = algorithms.map((alg) => ({ alg, h: new Hasher(alg) }));
  const total = file.size;
  let processed = 0;
  const start = performance.now();

  while (processed < total) {
    if (cancelled) throw new WasmAbort();
    const end = Math.min(processed + CHUNK_SIZE, total);
    const buf = await file.slice(processed, end).arrayBuffer();
    const bytes = new Uint8Array(buf);
    for (const { h } of hashers) h.update(bytes);
    processed += bytes.byteLength;
    post({ type: "progress", id, processed, total, elapsedMs: performance.now() - start });
  }
  return hashers.map(({ alg, h }) => ({ id: h.algorithm() ?? alg, hex: h.finalize() }));
}

class WasmAbort {}

self.addEventListener("message", async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === "cancel") {
    if (req.id === activeId) cancelled = true;
    return;
  }

  // start
  const { id, algorithms } = req;
  activeId = id;
  cancelled = false;
  try {
    await ensureReady();
    let hashes: HashResult[];
    if (req.file) {
      hashes = await runFile(req.file, algorithms, id);
    } else {
      const text = req.text ?? "";
      hashes = algorithms.map((alg) => ({ id: alg, hex: hash_text_utf8(alg, text) }));
    }
    if (cancelled) throw new WasmAbort();
    post({ type: "result", id, hashes });
  } catch (e) {
    if (e instanceof WasmAbort) {
      post({ type: "error", id, code: "aborted" as WasmErrorCode, message: "Aborted" });
    } else {
      const message = e instanceof Error ? e.message : String(e);
      const code: WasmErrorCode = /algorithm/i.test(message) ? "invalid-algorithm" : "unknown";
      post({ type: "error", id, code, message });
    }
  } finally {
    if (activeId === id) activeId = null;
  }
});

export {}; // module
