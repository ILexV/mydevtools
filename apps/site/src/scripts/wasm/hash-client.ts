/**
 * Hash client (main thread). Routes text + file hashing through a single
 * reusable Web Worker so the UI never blocks (Stage 7 / Gate 7). Owns the
 * worker lifecycle, correlates jobs by id, terminates aborted/failed workers,
 * and normalizes worker errors into typed `WasmError`.
 *
 * Network: the wasm module loads only when this client is first used, i.e. only
 * on the hash tool page — never on the home page.
 */
import { createJobWorker } from "./job-worker.ts";
import { WasmError, type WorkerRequest, type WorkerResponse, type HashResult } from "./worker-protocol.ts";

type HashJobRequest = Omit<WorkerRequest, "id">;
type HashJobSuccess = Extract<WorkerResponse, { ok: true }>;
const jobs = createJobWorker<HashJobRequest, HashJobSuccess>(
  () => new Worker(new URL("../../workers/hash.worker.ts", import.meta.url), { type: "module" }),
);
let activeRun = 0;

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

async function dispatch(payload: StartPayload, opts: RunOptions = {}): Promise<HashResult[]> {
  if (opts.signal?.aborted) throw new WasmError("aborted", "Aborted");
  const run = ++activeRun;
  if (run > 1) jobs.terminate();
  try {
    const result = await jobs.run(
      { type: "start", ...payload },
      [],
      opts.signal,
      opts.onProgress,
    );
    return result.hashes;
  } catch (error) {
    jobs.terminate();
    throw error;
  } finally {
    if (activeRun === run) activeRun = 0;
  }
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
