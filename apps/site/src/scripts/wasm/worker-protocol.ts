/**
 * Shared message protocol for WASM Web Workers (Stage 7).
 *
 * One job at a time per worker. `id` correlates requests to responses.
 * Cancel/error terminates the worker before another job can use its state. No
 * `SharedArrayBuffer` — GitHub Pages can't set COOP/COEP, so we pass the `File`
 * (structured-cloneable) and let the worker read chunks itself.
 */
export type ResourceErrorCode = "memory-exhausted" | "invalid-format" | "corrupt-input";

export type WasmErrorCode =
  | "invalid-algorithm"
  | "init-failed"
  | "worker-failed"
  | "aborted"
  | "input-too-large"
  | ResourceErrorCode
  | "unknown";

export interface HashResult {
  /** Normalized algorithm id. */
  id: string;
  /** Lowercase hex digest. */
  hex: string;
}

/** Main thread → worker. */
export interface WorkerRequest {
  type: "start";
  id: number;
  algorithms: string[];
  text?: string;
  file?: File;
}

/** Worker → main thread. */
export type WorkerResponse =
  | { type: "progress"; id: number; processed: number; total: number; elapsedMs: number }
  | { id: number; ok: true; hashes: HashResult[] }
  | { id: number; ok: false; message: string; code: WasmErrorCode };

/** Typed error surfaced to UI code; localized by callers via the tool namespace. */
export class WasmError extends Error {
  readonly code: WasmErrorCode;
  constructor(code: WasmErrorCode, message: string) {
    super(message);
    this.name = "WasmError";
    this.code = code;
  }
}

export interface ClassifiedWorkerError {
  code: WasmErrorCode;
  message: string;
}

export interface ResourceErrorMessages {
  memoryExhausted: string;
  invalidFormat: string;
  corruptInput: string;
}

const MEMORY_ERROR = /(?:out of memory|memory (?:allocation|limit)|alloc(?:ation)? failed|could not allocate|cannot allocate|array buffer allocation failed|invalid typed array length)/iu;

/** Classify only resource failures with reliable runtime evidence; callers supply any format-specific fallback. */
export function classifyWorkerError(error: unknown, fallback: WasmErrorCode = "unknown"): ClassifiedWorkerError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "AbortError") return { code: "aborted", message };
  if (MEMORY_ERROR.test(message)) return { code: "memory-exhausted", message };
  if (error instanceof WasmError) return { code: error.code, message };
  return { code: fallback, message };
}

/** Convert an arbitrary worker/runtime failure into the shared typed error without losing resource evidence. */
export function toWasmError(error: unknown, fallback: WasmErrorCode, fallbackMessage: string): WasmError {
  const classified = classifyWorkerError(error, fallback);
  return new WasmError(classified.code, classified.message || fallbackMessage);
}

/** Resolve shared resource errors without exposing low-level worker/runtime text. */
export function localizeResourceError(error: unknown, messages: ResourceErrorMessages): string | null {
  const { code } = classifyWorkerError(error);
  if (code === "memory-exhausted") return messages.memoryExhausted;
  if (code === "invalid-format") return messages.invalidFormat;
  if (code === "corrupt-input") return messages.corruptInput;
  return null;
}

export interface WorkerByteWriter {
  /** Transfers one chunk and resolves only after the receiver has written it. */
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

/**
 * Worker-side half of the export byte stream. Each chunk waits for a receiver
 * acknowledgement, bounding queued output to one transferred chunk.
 */
export function createWorkerByteWriter(port: MessagePort): WorkerByteWriter {
  let closed = false;
  let pending: PromiseWithResolvers<void> | null = null;
  let streamError: Error | null = null;

  function fail(message: string): Error {
    if (streamError) return streamError;
    streamError = new Error(message);
    streamError.name = "AbortError";
    closed = true;
    pending?.reject(streamError);
    pending = null;
    try { port.close(); } catch { /* The receiver may already have closed its port. */ }
    return streamError;
  }

  port.onmessage = (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type === "ready") {
      pending?.resolve();
      pending = null;
      return;
    }
    if (event.data?.type === "abort") fail("Export destination was aborted");
  };
  port.onmessageerror = () => { fail("Export destination response could not be decoded"); };
  port.start();

  return {
    async write(bytes) {
      if (streamError) throw streamError;
      if (closed) throw new Error("Export destination is closed");
      if (pending) throw new Error("The previous export chunk is still pending");
      pending = Promise.withResolvers<void>();
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer as ArrayBuffer
        : bytes.slice().buffer as ArrayBuffer;
      try {
        port.postMessage({ type: "chunk", bytes: buffer }, [buffer]);
      } catch {
        throw fail("Export chunk could not be sent");
      }
      await pending.promise;
    },
    close() {
      if (streamError) throw streamError;
      if (closed) return;
      if (pending) throw new Error("The final export chunk is still pending");
      closed = true;
      try {
        port.postMessage({ type: "end" });
      } finally {
        port.close();
      }
    },
  };
}
