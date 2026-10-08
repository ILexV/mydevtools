/**
 * Shared message protocol for WASM Web Workers (Stage 7).
 *
 * One job at a time per worker. `id` correlates requests to responses.
 * Cancel/error terminates the worker before another job can use its state. No
 * `SharedArrayBuffer` — GitHub Pages can't set COOP/COEP, so we pass the `File`
 * (structured-cloneable) and let the worker read chunks itself.
 */
export type WasmErrorCode =
  | "invalid-algorithm"
  | "init-failed"
  | "worker-failed"
  | "aborted"
  | "input-too-large"
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
  | { type: "result"; id: number; hashes: HashResult[] }
  | { type: "error"; id: number; message: string; code: WasmErrorCode };

/** Typed error surfaced to UI code; localized by callers via the tool namespace. */
export class WasmError extends Error {
  readonly code: WasmErrorCode;
  constructor(code: WasmErrorCode, message: string) {
    super(message);
    this.name = "WasmError";
    this.code = code;
  }
}
