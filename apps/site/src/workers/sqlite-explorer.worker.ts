/// <reference lib="webworker" />
import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";
import { classifyWorkerError, createWorkerByteWriter, toWasmError } from "@/scripts/wasm/worker-protocol";
import { encodeCsvRow } from "@/tools/explorer-delimited";
import {
  csvSqliteCell,
  jsonSqliteCell,
  quoteSqliteIdentifier,
  sqlLiteralSqliteCell,
  SqliteExplorerEngine,
  SqliteExplorerError,
  SQLITE_LIMITS,
  type SqliteExportFormat,
} from "@/tools/sqlite-explorer-engine";
import {
  encodeSqliteError,
  type SqliteExplorerRequest,
  type SqliteExplorerSuccess,
  type SqliteExplorerWorkerMessage,
} from "@/tools/sqlite-explorer-protocol";

const EXPORT_PART_CHARS = 256 * 1024;
const PROGRESS_ROWS = 5_000;

// Only the in-memory database is used: skip the OPFS/kvvfs VFS probes and their console warnings.
(globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
  warn: () => {},
  disable: { vfs: { opfs: true, "opfs-vfs": true, "opfs-sahpool": true, "opfs-wl": true, kvvfs: true } },
};

let engineReady: Promise<SqliteExplorerEngine> | null = null;
let resultRowCount = 0;

function engine(): Promise<SqliteExplorerEngine> {
  engineReady ??= (sqlite3InitModule as unknown as (options: object) => Promise<Sqlite3Static>)({
    locateFile: () => wasmUrl,
    print: () => {},
    printErr: () => {},
  }).then(
    (sqlite3) => new SqliteExplorerEngine(sqlite3),
    (error: unknown) => { throw toWasmError(error, "init-failed", "SQLite could not be loaded"); },
  );
  return engineReady;
}

function post(message: SqliteExplorerWorkerMessage, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

async function exportResult(id: number, current: SqliteExplorerEngine, format: SqliteExportFormat, stream: MessagePort): Promise<SqliteExplorerSuccess> {
  const columns = current.columns();
  const writer = createWorkerByteWriter(stream);
  const encoder = new TextEncoder();
  const started = performance.now();
  let pending = "";
  let rows = 0;
  const flush = async () => {
    if (!pending) return;
    const bytes = encoder.encode(pending);
    pending = "";
    await writer.write(bytes);
  };

  const insertPrefix = `INSERT INTO ${quoteSqliteIdentifier(current.resultName())} (${columns.map(quoteSqliteIdentifier).join(", ")}) VALUES (`;
  if (format === "csv") pending += `${encodeCsvRow(columns, false)}\r\n`;
  if (format === "json") pending += "[";
  for (const row of current.iterateRows()) {
    if (format === "csv") {
      pending += `${encodeCsvRow(row.map(csvSqliteCell), false)}\r\n`;
    } else if (format === "sql") {
      pending += `${insertPrefix}${row.map(sqlLiteralSqliteCell).join(", ")});\n`;
    } else {
      const properties = row.map((value, index) => `${JSON.stringify(columns[index])}:${JSON.stringify(jsonSqliteCell(value))}`);
      const object = `{${properties.join(",")}}`;
      pending += format === "json" ? `${rows === 0 ? "\n" : ",\n"}${object}` : `${object}\n`;
    }
    rows++;
    if (rows % PROGRESS_ROWS === 0) post({ id, type: "progress", processed: rows, total: resultRowCount, elapsedMs: performance.now() - started });
    if (pending.length >= EXPORT_PART_CHARS) await flush();
  }
  if (format === "json") pending += rows === 0 ? "]\n" : "\n]\n";
  await flush();
  writer.close();
  return { kind: "export", rowCount: rows };
}

async function handle(id: number, request: SqliteExplorerRequest): Promise<void> {
  try {
    const current = await engine();
    let result: SqliteExplorerSuccess;
    const transfer: Transferable[] = [];
    switch (request.type) {
      case "open": {
        if (request.file.size > SQLITE_LIMITS.maxDatabaseBytes) throw new SqliteExplorerError("file-too-large", "");
        const bytes = new Uint8Array(await request.file.arrayBuffer());
        resultRowCount = 0;
        result = { kind: "open", ...current.open(bytes, request.file.name, request.writable) };
        break;
      }
      case "detail":
        result = { kind: "detail", detail: current.detail(request.name) };
        break;
      case "browse":
      case "run": {
        const summary = request.type === "browse" ? current.browse(request.name) : current.run(request.sql);
        resultRowCount = summary.rowCount;
        result = { kind: "result", summary, objects: current.objects() };
        break;
      }
      case "read":
        result = { kind: "read", start: request.start, rows: current.readRows(request.start, request.count) };
        break;
      case "export":
        result = await exportResult(id, current, request.format, request.stream);
        break;
      case "download": {
        const bytes = current.exportDatabase();
        transfer.push(bytes.buffer);
        result = { kind: "download", bytes };
        break;
      }
    }
    post({ id, ok: true, ...result }, transfer);
  } catch (error) {
    if (error instanceof SqliteExplorerError) {
      post({ id, ok: false, code: "unknown", message: encodeSqliteError(error.code, error.message) });
      return;
    }
    const classified = classifyWorkerError(error, "unknown");
    post({ id, ok: false, code: classified.code, message: classified.message });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<SqliteExplorerRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as SqliteExplorerRequest));
});

export {};
