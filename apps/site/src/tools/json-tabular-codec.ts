export interface JsonTabularColumn {
  name: string;
  kind: "number" | "boolean" | "text" | "null";
  sqlType: string;
}

export interface JsonTabularResult {
  bytes: Uint8Array;
  nullToken: string;
  columns: JsonTabularColumn[];
}

interface CodecResponse extends Partial<JsonTabularResult> {
  id: number;
  error?: string;
}

let sequence = 0;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Convert JSON records to a lossless tabular CSV representation off the main thread. */
export function jsonToTabular(bytes: Uint8Array, format: "json" | "jsonl", signal?: AbortSignal): Promise<JsonTabularResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  const worker = new Worker(new URL("./json-tabular-codec.worker.ts", import.meta.url), { type: "module" });
  const id = ++sequence;
  return new Promise<JsonTabularResult>((resolve, reject) => {
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
      reject(new Error(event.message || "json-worker-failed"));
    }, { once: true });
    worker.addEventListener("message", (event: MessageEvent<CodecResponse>) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.bytes && event.data.nullToken && event.data.columns) {
        resolve({ bytes: event.data.bytes, nullToken: event.data.nullToken, columns: event.data.columns });
      } else reject(new Error("json-worker-invalid-response"));
    });
    worker.postMessage({ id, bytes, format }, [bytes.buffer as ArrayBuffer]);
  });
}
