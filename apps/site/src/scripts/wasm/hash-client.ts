/**
 * Hash client (main thread). Routes text + file hashing through a single
 * reusable Web Worker so the UI never blocks (Stage 7 / Gate 7). Owns the
 * worker lifecycle, correlates jobs by id, wires AbortSignal → cancel, and
 * normalizes worker errors into typed `WasmError`.
 *
 * Network: the wasm module loads only when this client is first used, i.e. only
 * on the hash tool page — never on the home page.
 */
import type { WorkerRequest, WorkerResponse, HashResult } from "./worker-protocol";
import { WasmError } from "./worker-protocol";

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/hash.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

export interface ProgressInfo {
  processed: number;
  total: number;
  elapsedMs: number;
}

interface RunOptions {
  onProgress?: (info: ProgressInfo) => void;
  signal?: AbortSignal;
}

interface StartPayload {
  algorithms: string[];
  text?: string;
  file?: File;
}

function dispatch(payload: StartPayload, opts: RunOptions = {}): Promise<HashResult[]> {
  const w = getWorker();
  const id = nextId++;
  const { onProgress, signal } = opts;
  const { promise, resolve, reject } = Promise.withResolvers<HashResult[]>();

  const onMsg = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === "progress") {
      onProgress?.({ processed: m.processed, total: m.total, elapsedMs: m.elapsedMs });
    } else if (m.type === "result") {
      cleanup();
      resolve(m.hashes);
    } else if (m.type === "error") {
      cleanup();
      reject(new WasmError(m.code, m.message));
    }
  };
  const onAbort = () => {
    w.postMessage({ type: "cancel", id } satisfies WorkerRequest);
    cleanup();
    reject(new WasmError("aborted", "Aborted"));
  };
  function cleanup() {
    w.removeEventListener("message", onMsg);
    signal?.removeEventListener("abort", onAbort);
  }

  signal?.addEventListener("abort", onAbort);
  w.addEventListener("message", onMsg);
  w.postMessage({ type: "start", id, ...payload } satisfies WorkerRequest);
  return promise;
}

export function hashText(algorithms: string[], text: string): Promise<HashResult[]> {
  return dispatch({ algorithms, text });
}

export function hashFile(
  file: File,
  algorithms: string[],
  opts: RunOptions = {},
): Promise<HashResult[]> {
  return dispatch({ algorithms, file }, opts);
}
