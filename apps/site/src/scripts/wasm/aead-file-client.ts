/**
 * AEAD file crypto client (main thread). Runs Argon2id key derivation and
 * chunked (1 MiB) streaming encrypt/decrypt in `aead-file.worker` so the
 * ~1 s KDF never freezes the page. New files are MDT3; legacy MDT2 is still
 * decrypted; decryption tries several password candidates (as typed, then
 * trimmed — the old site trimmed). Progress arrives per chunk; aborting the
 * signal terminates the worker and rejects with a DOMException "AbortError"
 * (the next call spawns a fresh worker).
 *
 * Network: worker + cryptography wasm load only on the first run.
 */
import { WasmError } from "@/scripts/wasm/worker-protocol";
import type { AeadAlgorithm, AeadFailure, AeadWorkerRequest, AeadWorkerResponse } from "@/scripts/wasm/aead-file-protocol";

export type { AeadAlgorithm, AeadFailure } from "@/scripts/wasm/aead-file-protocol";

export class AeadError extends WasmError {
  readonly failure: AeadFailure;
  constructor(failure: AeadFailure, message: string) {
    super("unknown", message);
    this.name = "AeadError";
    this.failure = failure;
  }
}

export interface AeadProgress {
  processed: number;
  total: number;
  elapsedMs: number;
}

export interface AeadRunOptions {
  onProgress?: (info: AeadProgress) => void;
  signal?: AbortSignal;
}

export interface AeadEncryptResult {
  blob: Blob;
  headerHex: string;
}

export interface AeadDecryptResult {
  blob: Blob;
  headerHex: string;
  /** Container format: 2 = legacy MDT2 (cannot detect a cut at a chunk boundary), 3 = MDT3. */
  format: 2 | 3;
  /** Index of the password candidate that authenticated the first chunk. */
  passwordIndex: number;
}

type ResultMessage = Extract<AeadWorkerResponse, { type: "result" }>;
type ErrorMessage = Extract<AeadWorkerResponse, { type: "error" }>;
type Job = AeadWorkerRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

interface PendingJob {
  resolve(value: ResultMessage): void;
  reject(reason: unknown): void;
  options: AeadRunOptions;
  onAbort(): void;
}

interface WorkerState {
  worker: Worker;
  pending: Map<number, PendingJob>;
  closed: boolean;
  onMessage: (event: MessageEvent<AeadWorkerResponse>) => void;
  onError: (event: ErrorEvent) => void;
  onMessageError: () => void;
}

let active: WorkerState | null = null;
let nextId = 1;

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : typeof error === "string" && error ? error : fallback;
}

function detach(state: WorkerState): void {
  state.worker.removeEventListener("message", state.onMessage);
  state.worker.removeEventListener("error", state.onError);
  state.worker.removeEventListener("messageerror", state.onMessageError);
}

function release(state: WorkerState): void {
  if (state.closed) return;
  state.closed = true;
  if (active === state) active = null;
  detach(state);
  try {
    state.worker.terminate();
  } catch {
    // Pending promises are settled independently below; termination is best-effort.
  }
}

function cleanupJob(state: WorkerState, id: number, pending: PendingJob): void {
  state.pending.delete(id);
  pending.options.signal?.removeEventListener("abort", pending.onAbort);
}

function failState(state: WorkerState, error: unknown): void {
  if (state.closed) return;
  const pendingJobs = [...state.pending.values()];
  state.pending.clear();
  for (const pending of pendingJobs) {
    pending.options.signal?.removeEventListener("abort", pending.onAbort);
  }
  release(state);
  for (const pending of pendingJobs) pending.reject(error);
}

function finishJob(state: WorkerState, id: number, pending: PendingJob, message: ResultMessage | ErrorMessage): void {
  cleanupJob(state, id, pending);
  // AEAD's Argon2 allocation is intentionally one-shot. Once no request is
  // using this worker, terminate it to release its large WASM memory; the
  // structured-cloned result Blob remains owned by the main thread.
  if (state.pending.size === 0) release(state);
  if (message.type === "result") {
    pending.resolve(message);
  } else if (message.code) {
    pending.reject(new WasmError(message.code, message.message));
  } else {
    pending.reject(new AeadError(message.failure, message.message));
  }
}

function createWorkerState(): WorkerState {
  let instance: Worker;
  try {
    instance = new Worker(new URL("../../workers/aead-file.worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    throw new WasmError("worker-failed", failureMessage(error, "Crypto worker could not be started"));
  }

  function onMessage(event: MessageEvent<AeadWorkerResponse>): void {
    const message = event.data;
    if (!message || typeof message.id !== "number") return;
    const pending = state.pending.get(message.id);
    if (!pending) return;
    if (message.type === "progress") {
      pending.options.onProgress?.({
        processed: message.processed,
        total: message.total,
        elapsedMs: message.elapsedMs,
      });
      return;
    }
    if (message.type === "error" && (message.code === "worker-failed" || message.code === "init-failed")) {
      failState(state, new WasmError(message.code, message.message));
      return;
    }
    finishJob(state, message.id, pending, message);
  }
  function onError(event: ErrorEvent): void {
    failState(state, new WasmError("worker-failed", event.message || "Crypto worker failed"));
  }
  function onMessageError(): void {
    failState(state, new WasmError("worker-failed", "Crypto worker response could not be decoded"));
  }

  const state: WorkerState = {
    worker: instance,
    pending: new Map(),
    closed: false,
    onMessage,
    onError,
    onMessageError,
  };

  try {
    instance.addEventListener("message", state.onMessage);
    instance.addEventListener("error", state.onError);
    instance.addEventListener("messageerror", state.onMessageError);
  } catch (error) {
    detach(state);
    try {
      instance.terminate();
    } catch {
      // The rejected run still reports the original startup failure.
    }
    throw new WasmError("worker-failed", failureMessage(error, "Crypto worker could not be started"));
  }
  return state;
}

function runJob(job: Job, opts: AeadRunOptions): Promise<ResultMessage> {
  if (opts.signal?.aborted) return Promise.reject(abortError());
  let state = active;
  if (!state) {
    try {
      state = createWorkerState();
      active = state;
    } catch (error) {
      return Promise.reject(
        error instanceof WasmError
          ? error
          : new WasmError("worker-failed", failureMessage(error, "Crypto worker could not be started")),
      );
    }
  }
  const current = state;
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<ResultMessage>();
  const onAbort = () => failState(current, abortError());
  const pending: PendingJob = { resolve, reject, options: opts, onAbort };
  current.pending.set(id, pending);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) {
    onAbort();
    return promise;
  }
  try {
    current.worker.postMessage({ ...job, id } as AeadWorkerRequest);
  } catch (error) {
    failState(
      current,
      new WasmError("worker-failed", failureMessage(error, "Crypto worker request could not be sent")),
    );
  }
  return promise;
}

/** Encrypt a file → MDT3 `.aead` container (header + per-chunk ciphertext). */
export async function aeadEncryptFile(
  file: File,
  password: string,
  algorithm: AeadAlgorithm,
  opts: AeadRunOptions = {},
): Promise<AeadEncryptResult> {
  const res = await runJob({ op: "encrypt", file, password, algorithm }, opts);
  return { blob: res.blob, headerHex: res.headerHex };
}

/**
 * Decrypt an MDT3 or legacy MDT2 container → original bytes. `passwords` are
 * tried in order on the first chunk (each costs one Argon2id derivation);
 * the first that authenticates is used for the whole file.
 */
export async function aeadDecryptFile(
  file: File,
  passwords: string | readonly string[],
  opts: AeadRunOptions = {},
): Promise<AeadDecryptResult> {
  const candidates = typeof passwords === "string" ? [passwords] : [...passwords];
  if (candidates.length === 0) throw new AeadError("crypto", "no password");
  const res = await runJob({ op: "decrypt", file, passwords: candidates }, opts);
  return { blob: res.blob, headerHex: res.headerHex, format: res.format, passwordIndex: res.passwordIndex };
}
