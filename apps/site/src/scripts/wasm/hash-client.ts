/**
 * Hash client (main thread). Routes text + file hashing through a single
 * reusable Web Worker so the UI never blocks (Stage 7 / Gate 7). Owns the
 * worker lifecycle, correlates jobs by id, terminates aborted/failed workers,
 * and normalizes worker errors into typed `WasmError`.
 *
 * Network: the wasm module loads only when this client is first used, i.e. only
 * on the hash tool page — never on the home page.
 */
import type { WorkerRequest, WorkerResponse, HashResult } from "./worker-protocol";
import { WasmError } from "./worker-protocol";

let worker: Worker | null = null;
let nextId = 1;
let cancelActive: (() => void) | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/hash.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function discardWorker(w: Worker): void {
  w.terminate();
  if (worker === w) worker = null;
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
  if (opts.signal?.aborted) return Promise.reject(new WasmError("aborted", "Aborted"));
  // A worker has one active job; superseding it must not share mutable WASM state.
  cancelActive?.();
  let w: Worker;
  try {
    w = getWorker();
  } catch (error) {
    return Promise.reject(new WasmError("worker-failed", error instanceof Error ? error.message : String(error)));
  }
  const id = nextId++;
  const { onProgress, signal } = opts;
  const { promise, resolve, reject } = Promise.withResolvers<HashResult[]>();

  function fail(error: WasmError): void {
    cleanup();
    discardWorker(w);
    reject(error);
  }
  const onMsg = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === "progress") {
      onProgress?.({ processed: m.processed, total: m.total, elapsedMs: m.elapsedMs });
    } else if (m.type === "result") {
      cleanup();
      resolve(m.hashes);
    } else if (m.type === "error") {
      fail(new WasmError(m.code, m.message));
    }
  };
  const onAbort = () => fail(new WasmError("aborted", "Aborted"));
  const onError = (ev: ErrorEvent) => fail(new WasmError("worker-failed", ev.message || "Hash worker failed"));
  const onMessageError = () => fail(new WasmError("worker-failed", "Hash worker message could not be decoded"));
  function cleanup(): void {
    w.removeEventListener("message", onMsg);
    w.removeEventListener("error", onError);
    w.removeEventListener("messageerror", onMessageError);
    signal?.removeEventListener("abort", onAbort);
    if (cancelActive === onAbort) cancelActive = null;
  }

  cancelActive = onAbort;
  signal?.addEventListener("abort", onAbort, { once: true });
  w.addEventListener("message", onMsg);
  w.addEventListener("error", onError);
  w.addEventListener("messageerror", onMessageError);
  try {
    w.postMessage({ type: "start", id, ...payload } satisfies WorkerRequest);
  } catch (error) {
    fail(new WasmError("worker-failed", error instanceof Error ? error.message : String(error)));
  }
  return promise;
}

export function hashText(algorithms: string[], text: string, opts: RunOptions = {}): Promise<HashResult[]> {
  return dispatch({ algorithms, text }, opts);
}

export function hashFile(
  file: File,
  algorithms: string[],
  opts: RunOptions = {},
): Promise<HashResult[]> {
  return dispatch({ algorithms, file }, opts);
}
