export type StreamSaveErrorCode = "aborted" | "storage-failed" | "fallback-too-large";

export class StreamSaveError extends Error {
  readonly code: StreamSaveErrorCode;
  constructor(code: StreamSaveErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StreamSaveError";
    this.code = code;
  }
}

export interface ByteSink {
  /** The bytes are consumed before this promise resolves; awaiting it provides backpressure. */
  write(bytes: Uint8Array): Promise<void>;
}

export interface StreamSaveOptions {
  suggestedName: string;
  mimeType: string;
  extensions?: readonly string[];
  /** Maximum bytes retained by the download fallback when the picker API is unavailable. */
  fallbackMaxBytes: number;
  signal?: AbortSignal;
}

export interface StreamSaveResult<T> {
  value: T;
  bytesWritten: number;
  mode: "file-system" | "blob";
}

interface WritableDestination {
  readonly mode: "file-system" | "blob";
  readonly bytesWritten: number;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

interface PickerWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface PickerHandle {
  createWritable(): Promise<PickerWritable>;
}

type SavePicker = (options: {
  suggestedName: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<PickerHandle>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function aborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function createDestination(options: StreamSaveOptions): Promise<WritableDestination> {
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    let handle: PickerHandle;
    try {
      const extensions = options.extensions?.map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
      const pickerMime = options.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream";
      handle = await picker.call(window, {
        suggestedName: options.suggestedName,
        types: extensions?.length
          ? [{ description: options.suggestedName, accept: { [pickerMime]: extensions } }]
          : undefined,
      });
    } catch (error) {
      if (aborted(error, options.signal)) throw new StreamSaveError("aborted", "Saving was canceled", { cause: error });
      throw new StreamSaveError("storage-failed", errorMessage(error, "The destination could not be opened"), { cause: error });
    }
    if (options.signal?.aborted) throw new StreamSaveError("aborted", "Saving was canceled");

    let writable: PickerWritable;
    try {
      writable = await handle.createWritable();
    } catch (error) {
      throw new StreamSaveError("storage-failed", errorMessage(error, "The destination could not be opened"), { cause: error });
    }
    let bytesWritten = 0;
    let finished = false;
    return {
      mode: "file-system",
      get bytesWritten() { return bytesWritten; },
      async write(bytes) {
        if (finished) throw new StreamSaveError("storage-failed", "The destination is closed");
        try {
          await writable.write(bytes);
          bytesWritten += bytes.byteLength;
        } catch (error) {
          throw new StreamSaveError("storage-failed", errorMessage(error, "The destination could not be written"), { cause: error });
        }
      },
      async close() {
        if (finished) return;
        try {
          await writable.close();
          finished = true;
        } catch (error) {
          throw new StreamSaveError("storage-failed", errorMessage(error, "The destination could not be committed"), { cause: error });
        }
      },
      async abort(reason) {
        if (finished) return;
        finished = true;
        try { await writable.abort(reason); } catch { /* Preserve the original cancellation/storage error. */ }
      },
    };
  }

  const parts: BlobPart[] = [];
  let bytesWritten = 0;
  let finished = false;
  return {
    mode: "blob",
    get bytesWritten() { return bytesWritten; },
    async write(bytes) {
      if (finished) throw new StreamSaveError("storage-failed", "The destination is closed");
      if (bytesWritten + bytes.byteLength > options.fallbackMaxBytes) {
        throw new StreamSaveError("fallback-too-large", "The download exceeds the in-memory fallback limit");
      }
      parts.push(bytes.slice() as BlobPart);
      bytesWritten += bytes.byteLength;
    },
    async close() {
      if (finished) return;
      try {
        downloadBlob(new Blob(parts, { type: options.mimeType }), options.suggestedName);
        finished = true;
        parts.length = 0;
      } catch (error) {
        throw new StreamSaveError("storage-failed", errorMessage(error, "The download could not be started"), { cause: error });
      }
    },
    async abort() {
      finished = true;
      parts.length = 0;
      bytesWritten = 0;
    },
  };
}

/**
 * Save incrementally to a user-selected file, or to an explicitly bounded Blob
 * fallback. A failed or canceled producer aborts a partial picker destination.
 */
export async function saveStreamedFile<T>(
  options: StreamSaveOptions,
  produce: (sink: ByteSink) => Promise<T>,
): Promise<StreamSaveResult<T>> {
  if (!Number.isSafeInteger(options.fallbackMaxBytes) || options.fallbackMaxBytes <= 0) {
    throw new RangeError("fallbackMaxBytes must be a positive safe integer");
  }
  if (options.signal?.aborted) throw new StreamSaveError("aborted", "Saving was canceled");

  const destination = await createDestination(options);
  if (options.signal?.aborted) {
    const error = new StreamSaveError("aborted", "Saving was canceled");
    await destination.abort(error);
    throw error;
  }
  let rejectAbort: ((reason: unknown) => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(new StreamSaveError("aborted", "Saving was canceled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const value = await Promise.race([produce({ write: (bytes) => destination.write(bytes) }), abortPromise]);
    if (options.signal?.aborted) throw new StreamSaveError("aborted", "Saving was canceled");
    await destination.close();
    return { value, bytesWritten: destination.bytesWritten, mode: destination.mode };
  } catch (error) {
    await destination.abort(error);
    if (error instanceof StreamSaveError) throw error;
    if (aborted(error, options.signal)) throw new StreamSaveError("aborted", "Saving was canceled", { cause: error });
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    rejectAbort = null;
  }
}

interface WorkerChunkMessage {
  type: "chunk";
  bytes: ArrayBuffer;
}

interface WorkerEndMessage {
  type: "end";
}

/** Adapt a worker MessagePort byte stream; the callback signal terminates work on user cancellation. */
export function saveWorkerStreamedFile<T>(
  options: StreamSaveOptions,
  start: (port: MessagePort, signal: AbortSignal) => Promise<T>,
): Promise<StreamSaveResult<T>> {
  return saveStreamedFile(options, async (sink) => {
    const channel = new MessageChannel();
    const { promise: received, resolve, reject } = Promise.withResolvers<void>();
    const workerAbort = new AbortController();
    let settled = false;
    let writing = Promise.resolve();
    let chunkPending = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { channel.port1.postMessage({ type: "abort" }); } catch { /* The worker may already be gone. */ }
      reject(error);
    };
    const onAbort = () => {
      workerAbort.abort(new StreamSaveError("aborted", "Saving was canceled"));
      fail(new StreamSaveError("aborted", "Saving was canceled"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    channel.port1.onmessage = (event: MessageEvent<WorkerChunkMessage | WorkerEndMessage>) => {
      const message = event.data;
      if (settled || !message) return;
      if (message.type === "end") {
        writing.then(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, fail);
        return;
      }
      if (message.type !== "chunk" || !(message.bytes instanceof ArrayBuffer) || chunkPending) {
        fail(new StreamSaveError("storage-failed", "The worker returned an invalid stream chunk"));
        return;
      }
      chunkPending = true;
      writing = sink.write(new Uint8Array(message.bytes)).then(() => {
        chunkPending = false;
        if (!settled) channel.port1.postMessage({ type: "ready" });
      });
      writing.catch(fail);
    };
    channel.port1.onmessageerror = () => fail(new StreamSaveError("storage-failed", "The worker stream could not be decoded"));
    channel.port1.start();

    let started: Promise<T>;
    try {
      started = start(channel.port2, workerAbort.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    try {
      const [value] = await Promise.all([started, received]);
      return value;
    } catch (error) {
      if (!settled) fail(error);
      try { await started; } catch { /* The originating error is reported by the save operation. */ }
      throw error;
    } finally {
      if (!settled) fail(new StreamSaveError("storage-failed", "The worker stream ended early"));
      workerAbort.abort();
      options.signal?.removeEventListener("abort", onAbort);
      try { channel.port1.close(); } catch { /* Already closed by the receiver. */ }
      try { channel.port2.close(); } catch { /* Ownership may have transferred to the worker. */ }
    }
  });
}
