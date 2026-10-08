/**
 * Encoding file client (main thread). Wraps `encoding.worker.ts` for file
 * encode/decode with progress + AbortSignal cancel. Released after every job,
 * including success, so a large encoding cannot retain its WASM heap.
 */
import type { EncodingOptions } from "./encoding-client";
import type { EncodingWorkerRequest, EncodingWorkerResponse } from "./encoding-file-protocol";
import { WasmError } from "./worker-protocol";

let worker: Worker | null = null;
let nextId = 1;
let cancelActive: (() => void) | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/encoding.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function discardWorker(w: Worker): void {
  w.terminate();
  if (worker === w) worker = null;
}

export interface EncodingFileResult {
  /** Encoded output (encode direction). */
  text: string;
  /** Decoded bytes (decode direction), if applicable. */
  bytes?: Uint8Array;
}

export interface EncodingRunOptions {
  onProgress?: (info: { processed: number; total: number; elapsedMs: number }) => void;
  signal?: AbortSignal;
}

function dispatch(
  direction: "encode" | "decode",
  options: EncodingOptions,
  file: File,
  opts: EncodingRunOptions = {},
): Promise<EncodingFileResult> {
  if (opts.signal?.aborted) return Promise.reject(new WasmError("aborted", "Aborted"));
  cancelActive?.();
  let w: Worker;
  try {
    w = getWorker();
  } catch (error) {
    return Promise.reject(new WasmError("worker-failed", error instanceof Error ? error.message : String(error)));
  }
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<EncodingFileResult>();

  function fail(error: WasmError): void {
    cleanup();
    discardWorker(w);
    reject(error);
  }
  const onMsg = (ev: MessageEvent<EncodingWorkerResponse>) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === "progress") {
      opts.onProgress?.({ processed: m.processed, total: m.total, elapsedMs: m.elapsedMs });
    } else if (m.type === "result") {
      cleanup();
      discardWorker(w);
      resolve({ text: m.text, bytes: m.bytes });
    } else if (m.type === "error") {
      fail(new WasmError(m.code, m.message));
    }
  };
  const onAbort = () => fail(new WasmError("aborted", "Aborted"));
  const onError = (ev: ErrorEvent) => fail(new WasmError("worker-failed", ev.message || "Encoding worker failed"));
  const onMessageError = () => fail(new WasmError("worker-failed", "Encoding worker message could not be decoded"));
  function cleanup(): void {
    w.removeEventListener("message", onMsg);
    w.removeEventListener("error", onError);
    w.removeEventListener("messageerror", onMessageError);
    opts.signal?.removeEventListener("abort", onAbort);
    if (cancelActive === onAbort) cancelActive = null;
  }

  cancelActive = onAbort;
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  w.addEventListener("message", onMsg);
  w.addEventListener("error", onError);
  w.addEventListener("messageerror", onMessageError);
  try {
    w.postMessage({ type: "start", id, direction, options, file } satisfies EncodingWorkerRequest);
  } catch (error) {
    fail(new WasmError("worker-failed", error instanceof Error ? error.message : String(error)));
  }
  return promise;
}

export function encodeFile(options: EncodingOptions, file: File, opts: EncodingRunOptions = {}) {
  return dispatch("encode", options, file, opts);
}

export function decodeFile(options: EncodingOptions, file: File, opts: EncodingRunOptions = {}) {
  return dispatch("decode", options, file, opts);
}
