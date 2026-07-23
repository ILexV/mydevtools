/**
 * Encoding file client (main thread). Wraps `encoding.worker.ts` for file
 * encode/decode with progress + AbortSignal cancel. One reusable worker.
 */
import type { EncodingOptions } from "./encoding-client";
import type { EncodingWorkerRequest, EncodingWorkerResponse } from "./encoding-file-protocol";
import { WasmError } from "./worker-protocol";

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/encoding.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
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
  const w = getWorker();
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<EncodingFileResult>();

  const onMsg = (ev: MessageEvent<EncodingWorkerResponse>) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === "progress") {
      opts.onProgress?.({ processed: m.processed, total: m.total, elapsedMs: m.elapsedMs });
    } else if (m.type === "result") {
      cleanup();
      resolve({ text: m.text, bytes: m.bytes });
    } else if (m.type === "error") {
      cleanup();
      reject(new WasmError(m.code, m.message));
    }
  };
  const onAbort = () => {
    w.postMessage({ type: "cancel", id } satisfies EncodingWorkerRequest);
    cleanup();
    reject(new WasmError("aborted", "Aborted"));
  };
  function cleanup() {
    w.removeEventListener("message", onMsg);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  opts.signal?.addEventListener("abort", onAbort);
  w.addEventListener("message", onMsg);
  w.postMessage({ type: "start", id, direction, options, file } satisfies EncodingWorkerRequest);
  return promise;
}

export function encodeFile(options: EncodingOptions, file: File, opts: EncodingRunOptions = {}) {
  return dispatch("encode", options, file, opts);
}

export function decodeFile(options: EncodingOptions, file: File, opts: EncodingRunOptions = {}) {
  return dispatch("decode", options, file, opts);
}
