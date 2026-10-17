/**
 * Encoding file client (main thread). Wraps `encoding.worker.ts` for file
 * encode/decode with progress + AbortSignal cancel. Released after every job,
 * including success, so a large encoding cannot retain its WASM heap.
 */
import type { EncodingOptions } from "./encoding-client";
import type { EncodingWorkerRequest, EncodingWorkerResponse } from "./encoding-file-protocol";
import { createJobWorker, type JobWorker } from "./job-worker";
import { WasmError } from "./worker-protocol";

type EncodingJobRequest = Omit<EncodingWorkerRequest, "id">;
type EncodingJobSuccess = Extract<EncodingWorkerResponse, { ok: true }>;
let active: JobWorker<EncodingJobRequest, EncodingJobSuccess> | null = null;

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

async function dispatch(
  direction: "encode" | "decode",
  options: EncodingOptions,
  file: File,
  opts: EncodingRunOptions = {},
): Promise<EncodingFileResult> {
  if (opts.signal?.aborted) throw new WasmError("aborted", "Aborted");
  active?.terminate();
  const job = createJobWorker<EncodingJobRequest, EncodingJobSuccess>(
    () => new Worker(new URL("../../workers/encoding.worker.ts", import.meta.url), { type: "module" }),
  );
  active = job;
  try {
    const result = await job.run(
      { type: "start", direction, options, file },
      [],
      opts.signal,
      opts.onProgress,
    );
    return { text: result.text, bytes: result.bytes };
  } finally {
    job.terminate();
    if (active === job) active = null;
  }
}

export function encodeFile(options: EncodingOptions, file: File, opts: EncodingRunOptions = {}) {
  return dispatch("encode", options, file, opts);
}

export function decodeFile(options: EncodingOptions, file: File, opts: EncodingRunOptions = {}) {
  return dispatch("decode", options, file, opts);
}
