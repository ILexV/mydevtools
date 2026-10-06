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
type Job = AeadWorkerRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/aead-file.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function killWorker(): void {
  worker?.terminate();
  worker = null;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function runJob(job: Job, opts: AeadRunOptions): Promise<ResultMessage> {
  if (opts.signal?.aborted) return Promise.reject(abortError());
  const w = getWorker();
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<ResultMessage>();

  const onMsg = (ev: MessageEvent<AeadWorkerResponse>) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === "progress") {
      opts.onProgress?.({ processed: m.processed, total: m.total, elapsedMs: m.elapsedMs });
      return;
    }
    cleanup();
    if (m.type === "result") resolve(m);
    else reject(new AeadError(m.failure, m.message));
  };
  const onError = (ev: ErrorEvent) => {
    // Worker crashed (e.g. WASM out-of-memory trap): drop it for the next job.
    cleanup();
    killWorker();
    reject(new AeadError("crypto", ev.message || "Worker error"));
  };
  const onAbort = () => {
    // Argon2id/chunk calls are synchronous WASM: terminate to stop immediately.
    cleanup();
    killWorker();
    reject(abortError());
  };
  function cleanup() {
    w.removeEventListener("message", onMsg);
    w.removeEventListener("error", onError);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  w.addEventListener("message", onMsg);
  w.addEventListener("error", onError);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  w.postMessage({ ...job, id } as AeadWorkerRequest);
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
