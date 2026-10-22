import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type {
  SqliteDatabaseInfo,
  SqliteExportFormat,
  SqliteObject,
  SqliteObjectDetail,
  SqliteResultSummary,
} from "@/tools/sqlite-explorer-engine";

export const SQLITE_EXPLORER_STORAGE_KEY = "mdt.sqlite-explorer.v1";
export const SQLITE_EXPORT_FORMATS: readonly SqliteExportFormat[] = ["csv", "json", "jsonl", "sql"];

/** Persisted settings: only the export format; never SQL text, file names or data. */
export interface SqliteExplorerSettings {
  v: 1;
  exportFormat: SqliteExportFormat;
}

export function parseSqliteExplorerSettings(value: unknown): SqliteExplorerSettings {
  const format = (value as { exportFormat?: unknown } | null)?.exportFormat;
  return { v: 1, exportFormat: SQLITE_EXPORT_FORMATS.includes(format as SqliteExportFormat) ? format as SqliteExportFormat : "csv" };
}

export const SQLITE_EXPORT_MIME: Record<SqliteExportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
  jsonl: "application/x-ndjson;charset=utf-8",
  sql: "application/sql;charset=utf-8",
};

export type SqliteExplorerRequest =
  | { type: "open"; file: File; writable: boolean }
  | { type: "detail"; name: string }
  | { type: "browse"; name: string }
  | { type: "run"; sql: string }
  | { type: "read"; start: number; count: number }
  | { type: "export"; format: SqliteExportFormat; stream: MessagePort }
  | { type: "download" };

export type SqliteExplorerSuccess =
  | { kind: "open"; info: SqliteDatabaseInfo; objects: SqliteObject[] }
  | { kind: "detail"; detail: SqliteObjectDetail }
  | { kind: "result"; summary: SqliteResultSummary; objects: SqliteObject[] }
  | { kind: "read"; start: number; rows: string[][] }
  | { kind: "export"; rowCount: number }
  | { kind: "download"; bytes: Uint8Array };

export type SqliteExplorerWorkerMessage =
  | ({ id: number; ok: true } & SqliteExplorerSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };

/** Worker error text for engine errors: `sqlite:<code>:<detail>`, parsed back by the controller. */
export function encodeSqliteError(code: string, detail: string): string {
  return `sqlite:${code}:${detail}`;
}

export function decodeSqliteError(message: string): { code: string; detail: string } | null {
  const match = /^sqlite:([a-z-]+):([\s\S]*)$/u.exec(message);
  return match ? { code: match[1], detail: match[2] } : null;
}
