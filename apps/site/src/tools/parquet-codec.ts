interface CodecResponse {
  id: number;
  bytes?: Uint8Array;
  loading?: CodecLoadProgress;
  error?: string;
}
export interface CodecLoadProgress {
  loaded: number;
  total: number;
}


let sequence = 0;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function runCodec(operation: "decode" | "encode", bytes: Uint8Array, signal?: AbortSignal, onLoad?: (progress: CodecLoadProgress) => void): Promise<Uint8Array> {
  if (signal?.aborted) return Promise.reject(abortError());
  const worker = new Worker(new URL("./parquet-codec.worker.ts", import.meta.url), { type: "module" });
  const id = ++sequence;
  return new Promise<Uint8Array>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("error", (event) => {
      finish();
      reject(new Error(event.message || "parquet-worker-failed"));
    }, { once: true });
    worker.addEventListener("message", (event: MessageEvent<CodecResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.loading) {
        onLoad?.(event.data.loading);
        return;
      }
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.bytes) resolve(event.data.bytes);
      else reject(new Error("parquet-worker-invalid-response"));
    });
    worker.postMessage({ id, operation, bytes }, [bytes.buffer]);
  });
}

/** Decode a complete local Parquet file into an Arrow IPC stream off the main thread. */
export function parquetToArrowIpc(bytes: Uint8Array, signal?: AbortSignal, onLoad?: (progress: CodecLoadProgress) => void): Promise<Uint8Array> {
  return runCodec("decode", bytes, signal, onLoad);
}

/** Encode an Arrow IPC stream as buffered Parquet off the main thread. */
export function arrowIpcToParquet(bytes: Uint8Array, signal?: AbortSignal, onLoad?: (progress: CodecLoadProgress) => void): Promise<Uint8Array> {
  return runCodec("encode", bytes, signal, onLoad);
}
