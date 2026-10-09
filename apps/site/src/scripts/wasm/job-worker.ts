/**
 * Correlated job runner for reusable Web Workers. Successful workers stay
 * alive for consumers that keep worker-side sessions; cancellation or an
 * infrastructure failure terminates that exact instance and settles every
 * job posted to it.
 */
import { WasmError, type WasmErrorCode } from "./worker-protocol.ts";

export interface JobProgress {
  processed: number;
  total: number;
  elapsedMs: number;
}

interface JobProgressResponse extends JobProgress {
  id: number;
  type: "progress";
}

/** Worker reply shape: progress, a success payload, or a typed error. */
export type JobResponse<T> =
  | ({ id: number; ok: true } & T)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | JobProgressResponse;

export interface JobWorker<Req, Res> {
  /** Post `req` (an `id` is added) and resolve with the success reply. */
  run(
    req: Req,
    transfer?: Transferable[],
    signal?: AbortSignal,
    onProgress?: (info: JobProgress) => void,
  ): Promise<Res>;
  /** Terminate the current worker and reject all of its outstanding jobs. */
  terminate(): void;
}

interface PendingJob<Res> {
  resolve(value: Res): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  onAbort(): void;
  onProgress?: (info: JobProgress) => void;
}

interface WorkerState<Res> {
  worker: Worker;
  pending: Map<number, PendingJob<Res>>;
  closed: boolean;
  onMessage: (event: MessageEvent<JobResponse<Res>>) => void;
  onError: (event: ErrorEvent) => void;
  onMessageError: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : typeof error === "string" && error ? error : fallback;
}

function isProgressResponse<T>(message: JobResponse<T>): message is JobProgressResponse {
  return (
    "type" in message &&
    message.type === "progress" &&
    "processed" in message &&
    typeof message.processed === "number" &&
    "total" in message &&
    typeof message.total === "number" &&
    "elapsedMs" in message &&
    typeof message.elapsedMs === "number"
  );
}

export function createJobWorker<Req extends object, Res extends object>(spawn: () => Worker): JobWorker<Req, Res> {
  let active: WorkerState<Res> | null = null;
  let nextId = 1;

  function cleanupJob(state: WorkerState<Res>, id: number, pending: PendingJob<Res>): void {
    state.pending.delete(id);
    pending.signal?.removeEventListener("abort", pending.onAbort);
  }

  function detach(state: WorkerState<Res>): void {
    state.worker.removeEventListener("message", state.onMessage);
    state.worker.removeEventListener("error", state.onError);
    state.worker.removeEventListener("messageerror", state.onMessageError);
  }

  function discard(state: WorkerState<Res>, error: WasmError): void {
    if (state.closed) return;
    state.closed = true;
    if (active === state) active = null;
    detach(state);
    try {
      state.worker.terminate();
    } catch {
      // Promise settlement and listener cleanup still must complete.
    }
    const jobs = [...state.pending.values()];
    state.pending.clear();
    for (const pending of jobs) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
  }

  function spawnState(): WorkerState<Res> {
    let instance: Worker;
    try {
      instance = spawn();
    } catch (error) {
      throw new WasmError("worker-failed", errorMessage(error, "Worker could not be started"));
    }

    function onMessage(event: MessageEvent<JobResponse<Res>>): void {
      const message = event.data;
      if (!message || typeof message.id !== "number") return;
      const pending = state.pending.get(message.id);
      if (!pending) return;

      if (isProgressResponse(message)) {
        pending.onProgress?.({
          processed: message.processed,
          total: message.total,
          elapsedMs: message.elapsedMs,
        });
        return;
      }
      if ("ok" in message && message.ok) {
        cleanupJob(state, message.id, pending);
        pending.resolve(message as unknown as Res);
        return;
      }
      if ("ok" in message && !message.ok) {
        const error = new WasmError(message.code ?? "unknown", message.message);
        if (message.code === "worker-failed" || message.code === "init-failed") {
          discard(state, error);
        } else {
          cleanupJob(state, message.id, pending);
          pending.reject(error);
        }
        return;
      }
      discard(state, new WasmError("worker-failed", "Worker returned an invalid response"));
    }
    function onError(event: ErrorEvent): void {
      discard(state, new WasmError("worker-failed", event.message || "Worker failed"));
    }
    function onMessageError(): void {
      discard(state, new WasmError("worker-failed", "Worker response could not be decoded"));
    }

    const state: WorkerState<Res> = {
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
      instance.terminate();
      throw new WasmError("worker-failed", errorMessage(error, "Worker could not be started"));
    }
    return state;
  }

  function run(
    req: Req,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
    onProgress?: (info: JobProgress) => void,
  ): Promise<Res> {
    if (signal?.aborted) return Promise.reject(new WasmError("aborted", "Aborted"));

    let state = active;
    if (!state) {
      try {
        state = spawnState();
        active = state;
      } catch (error) {
        return Promise.reject(
          error instanceof WasmError
            ? error
            : new WasmError("worker-failed", errorMessage(error, "Worker could not be started")),
        );
      }
    }
    const current = state;
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Res>();
    const onAbort = () => discard(current, new WasmError("aborted", "Aborted"));
    const pending: PendingJob<Res> = { resolve, reject, signal, onAbort, onProgress };
    current.pending.set(id, pending);
    signal?.addEventListener("abort", onAbort, { once: true });

    // Cover an abort racing with listener installation without posting work to
    // an instance that has already been discarded.
    if (signal?.aborted) {
      onAbort();
      return promise;
    }

    try {
      current.worker.postMessage({ ...req, id }, transfer);
    } catch (error) {
      discard(current, new WasmError("worker-failed", errorMessage(error, "Worker request could not be sent")));
    }
    return promise;
  }

  function terminate(): void {
    if (active) discard(active, new WasmError("aborted", "Aborted"));
  }

  return { run, terminate };
}

/** Copy bytes into a standalone ArrayBuffer that can be transferred safely. */
export function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
