/// <reference lib="webworker" />
/**
 * Parquet explorer worker. Keeps the File and reads footer, row windows and
 * exports off the main thread. Cancel terminates this worker, which drops the
 * file handle and any half-built download.
 */
import { classifyWorkerError, createWorkerByteWriter } from "@/scripts/wasm/worker-protocol";
import { ParquetExplorerError } from "@/tools/parquet-explorer";
import { asyncBufferFromBlob, exportParquetStream, openParquet, readParquetRows, type ParquetFileSummary } from "@/tools/parquet-explorer-io";
import type { ParquetExplorerRequest, ParquetExplorerSuccess, ParquetExplorerWorkerMessage } from "@/tools/parquet-explorer-protocol";

interface Session {
  id: number;
  file: File;
  summary: ParquetFileSummary;
}

let session: Session | null = null;
let nextSessionId = 1;

function post(message: ParquetExplorerWorkerMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function progress(id: number, processed: number, total: number, started: number): void {
  post({ id, type: "progress", processed, total, elapsedMs: performance.now() - started });
}

function requireSession(id: number): Session {
  if (!session || session.id !== id) {
    throw new ParquetExplorerError("session-missing", "The Parquet session is no longer available");
  }
  return session;
}

async function open(id: number, file: File): Promise<ParquetExplorerSuccess> {
  const started = performance.now();
  progress(id, 0, Math.max(file.size, 1), started);
  const summary = await openParquet(asyncBufferFromBlob(file));
  const current: Session = { id: nextSessionId++, file, summary };
  session = current;
  progress(id, file.size, Math.max(file.size, 1), started);
  return { kind: "open", sessionId: current.id, fileName: file.name, ...summary };
}

async function handle(id: number, request: ParquetExplorerRequest): Promise<void> {
  const started = performance.now();
  try {
    let result: ParquetExplorerSuccess;
    switch (request.type) {
      case "open":
        result = await open(id, request.file);
        break;
      case "read": {
        const current = requireSession(request.sessionId);
        result = {
          kind: "read",
          sessionId: current.id,
          start: request.start,
          rows: await readParquetRows(
            asyncBufferFromBlob(current.file),
            current.summary,
            request.start,
            request.count,
            request.columns,
            request.maxChars,
          ),
        };
        break;
      }
      case "export": {
        const current = requireSession(request.sessionId);
        const writer = createWorkerByteWriter(request.stream);
        const exported = await exportParquetStream(
          asyncBufferFromBlob(current.file),
          current.summary,
          request,
          (bytes) => writer.write(bytes),
          (processed, total) => progress(id, processed, total, started),
        );
        writer.close();
        const csv = request.format === "csv";
        result = {
          kind: "export",
          sessionId: current.id,
          extension: request.format,
          mime: csv ? "text/csv;charset=utf-8" : "application/x-ndjson;charset=utf-8",
          rowCount: exported.rowCount,
        };
        break;
      }
    }
    post({ id, ok: true, ...result });
  } catch (error) {
    const parquetError = error instanceof ParquetExplorerError ? error : null;
    if (parquetError && request.type === "open") session = null;
    const limited = parquetError?.code === "too-many-columns"
      || parquetError?.code === "export-too-large"
      || parquetError?.code === "cell-too-large";
    const fallback = parquetError
      ? limited ? "input-too-large" : parquetError.code === "invalid" ? "invalid-format" : "unknown"
      : "worker-failed";
    const classified = classifyWorkerError(error, fallback);
    post({
      id,
      ok: false,
      code: classified.code,
      message: parquetError?.code ?? classified.message,
    });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<ParquetExplorerRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as ParquetExplorerRequest));
});

export {};
