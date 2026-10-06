/**
 * Job runner for one-shot WASM Web Workers (pdf, qrcode decode): lazily
 * spawns the worker, correlates requests/responses by `id`, and cancels a job
 * by terminating the worker (synchronous WASM can't be interrupted
 * cooperatively) — the next job spawns a fresh one. A worker crash (e.g. WASM
 * out-of-memory trap) also drops the instance. Errors become typed
 * `WasmError` ("aborted" on cancel, "unknown" otherwise).
 */
import { WasmError } from "@/scripts/wasm/worker-protocol";

/** Worker reply shape: success payload or an error message. */
export type JobResponse<T> = ({ id: number; ok: true } & T) | { id: number; ok: false; message: string };

export interface JobWorker<Req, Res> {
  /** Post `req` (an `id` is added) and resolve with the success reply. */
  run(req: Req, transfer?: Transferable[], signal?: AbortSignal): Promise<Res>;
  /** Terminate the current worker (if any). */
  terminate(): void;
}

export function createJobWorker<Req extends object, Res extends object>(spawn: () => Worker): JobWorker<Req, Res> {
  let worker: Worker | null = null;
  let nextId = 1;

  function kill(): void {
    worker?.terminate();
    worker = null;
  }

  function run(req: Req, transfer: Transferable[] = [], signal?: AbortSignal): Promise<Res> {
    if (signal?.aborted) return Promise.reject(new WasmError("aborted", "Aborted"));
    if (!worker) worker = spawn();
    const w = worker;
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Res>();

    const onMsg = (ev: MessageEvent<JobResponse<Res>>) => {
      const m = ev.data;
      if (m.id !== id) return;
      cleanup();
      if (m.ok) resolve(m as unknown as Res);
      else reject(new WasmError("unknown", m.message));
    };
    const onError = (ev: ErrorEvent) => {
      cleanup();
      kill();
      reject(new WasmError("unknown", ev.message || "Worker error"));
    };
    const onAbort = () => {
      cleanup();
      kill();
      reject(new WasmError("aborted", "Aborted"));
    };
    function cleanup() {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }

    w.addEventListener("message", onMsg);
    w.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    w.postMessage({ ...req, id }, transfer);
    return promise;
  }

  return { run, terminate: kill };
}

/** Copy bytes into a standalone ArrayBuffer that can be transferred safely. */
export function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
