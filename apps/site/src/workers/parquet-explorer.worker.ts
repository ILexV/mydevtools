/// <reference lib="webworker" />
/**
 * Parquet explorer worker. Keeps the File and reads footer, row windows and
 * exports off the main thread. Cancel terminates this worker, which drops the
 * file handle and any half-built download.
 */
import { classifyWorkerError, createWorkerByteWriter } from "@/scripts/wasm/worker-protocol";
import { ParquetExplorerError } from "@/tools/parquet-explorer";
import {
  ParquetViewReader,
  asyncBufferFromBlob,
  exportParquetStream,
  openParquetSource,
  readParquetRows,
  type ParquetFileSummary,
  type ParquetReadContext,
} from "@/tools/parquet-explorer-io";
import { aggregateParquet, buildParquetSelection, type ParquetRowSelection } from "@/tools/parquet-explorer-query";
import { csvTypedText, type CsvAggregateResult } from "@/tools/csv-explorer-types";
import type { FileMetaData } from "hyparquet";
import type { ParquetExplorerRequest, ParquetExplorerSuccess, ParquetExplorerWorkerMessage } from "@/tools/parquet-explorer-protocol";

interface Session {
  id: number;
  file: File;
  summary: ParquetFileSummary;
  metadata: FileMetaData;
  reader: ParquetViewReader;
  selection: ParquetRowSelection | null;
  aggregate: CsvAggregateResult | null;
}

const LIMIT_ERRORS = new Set(["too-many-groups"]);
const GROUP_PREVIEW_CHARS = 512;

function context(current: Session): ParquetReadContext {
  return { metadata: current.metadata, selection: current.selection, reader: current.reader, aggregate: current.aggregate };
}

function source(current: Session) {
  return { file: asyncBufferFromBlob(current.file), metadata: current.metadata };
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
  const buffer = asyncBufferFromBlob(file);
  const { summary, metadata } = await openParquetSource(buffer);
  const current: Session = {
    id: nextSessionId++,
    file,
    summary,
    metadata,
    reader: new ParquetViewReader(buffer, metadata),
    selection: null,
    aggregate: null,
  };
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
            context(current),
          ),
        };
        break;
      }
      case "filter": {
        const current = requireSession(request.sessionId);
        current.aggregate = null;
        // Build first: a rejected condition keeps the previous selection the page still shows.
        current.selection = request.filter && request.filter.conditions.length > 0
          ? await buildParquetSelection(source(current), current.summary.columns, request.filter,
            (processed, total) => progress(id, processed, total, started))
          : null;
        result = { kind: "filter", sessionId: current.id, rowCount: current.selection ? current.selection.count : current.summary.rows };
        break;
      }
      case "aggregate": {
        const current = requireSession(request.sessionId);
        current.aggregate = null;
        const aggregate = await aggregateParquet(source(current), current.summary.columns, current.selection, request.request,
          (processed, total) => progress(id, processed, total, started));
        current.aggregate = aggregate;
        result = { kind: "aggregate", sessionId: current.id, columns: aggregate.columns, groupCount: aggregate.groupCount, inputRows: aggregate.inputRows };
        break;
      }
      case "read-groups": {
        const current = requireSession(request.sessionId);
        if (!current.aggregate) throw new ParquetExplorerError("session-missing", "No group result");
        const rows = current.aggregate.rows.slice(request.start, request.start + Math.min(request.count, 500))
          .map((row) => row.map((value) => {
            if (value === null) return null;
            const text = csvTypedText(value);
            return text.length > GROUP_PREVIEW_CHARS ? `${text.slice(0, GROUP_PREVIEW_CHARS)}…` : text;
          }));
        result = { kind: "read-groups", sessionId: current.id, start: request.start, rows };
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
          context(current),
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
    if (error instanceof Error && LIMIT_ERRORS.has(error.message)) {
      post({ id, ok: false, code: "input-too-large", message: error.message });
      return;
    }
    if (error instanceof ParquetExplorerError && error.code === "filter-value") {
      post({ id, ok: false, code: "unknown", message: `filter-value:${error.message}` });
      return;
    }
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
