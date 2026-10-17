import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbEhWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbMvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { ByteSink } from "@/scripts/stream-save";
import { tableToIPC } from "apache-arrow";
import { arrowIpcToParquet, parquetToArrowIpc } from "@/tools/parquet-codec";
import { jsonToTabular } from "@/tools/json-tabular-codec";

export type DataFormat = "csv" | "json" | "jsonl" | "parquet";
export type DataEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1251" | "windows-1252" | "iso-8859-1";
export type ProjectionCast = "VARCHAR" | "BIGINT" | "DOUBLE" | "DECIMAL" | "BOOLEAN" | "DATE" | "TIMESTAMP";
export type ExportFormat = "csv" | "json" | "jsonl" | "parquet";

export interface DataColumn {
  name: string;
  type: string;
}

export interface TableInfo {
  name: string;
  sourceName: string;
  format: DataFormat;
  fileSize: number;
  rowCount: number;
  columns: DataColumn[];
}

export interface QuerySummary {
  id: string;
  columns: DataColumn[];
  rowCount: number;
  truncated: boolean;
  maxRows: number | null;
  elapsedMs: number;
}

export interface QueryPage {
  queryId: string;
  offset: number;
  rows: (string | null)[][];
}

export interface EngineProgress {
  phase: "loading" | "importing" | "querying" | "exporting";
  processed: number;
  total: number;
  elapsedMs: number;
}

export interface CsvImportOptions {
  delimiter?: "," | ";" | "\t" | "|";
  header?: boolean;
  /** Keep every CSV field as source text; useful before explicit converter casts. */
  allVarchar?: boolean;
  encoding?: DataEncoding;
}

export interface LoadTableOptions {
  tableName: string;
  format?: DataFormat;
  csv?: CsvImportOptions;
}

export interface QueryOptions {
  /** Omit/null for the complete result; pass a positive bound for previews. */
  maxRows?: number | null;
}

export interface ProjectionColumn {
  source: string;
  alias?: string;
  cast?: ProjectionCast;
  /** Used only when cast is DECIMAL. */
  decimalPrecision?: number;
  /** Used only when cast is DECIMAL. */
  decimalScale?: number;
}

export interface DataExportOptions {
  format: ExportFormat;
  delimiter?: "," | ";" | "\t" | "|";
  header?: boolean;
  sink?: ByteSink;
}

export interface DataExportResult {
  blob: Blob | null;
  bytes: number;
  rows: number;
  format: ExportFormat;
  /** Parquet is encoded in a separate worker as one bounded buffer; text formats stream by row pages. */
  buffered: boolean;
}

export interface WasmLoadProgress {
  component: "duckdb" | "parquet";
  loaded: number;
  total: number;
}

export interface LocalDataEngineOptions {
  onWasmLoad?: (progress: WasmLoadProgress) => void;
  memoryLimitMiB?: number;
  maxInputBytes?: number;
  maxTextExportBytes?: number;
  maxParquetExportBytes?: number;
}

export interface LocalDataEngine {
  loadTable(
    file: File,
    options: LoadTableOptions,
    signal?: AbortSignal,
    onProgress?: (progress: EngineProgress) => void,
  ): Promise<TableInfo>;
  inspectTable(tableName: string): Promise<TableInfo>;
  query(
    sql: string,
    options?: QueryOptions,
    signal?: AbortSignal,
    onProgress?: (progress: EngineProgress) => void,
  ): Promise<QuerySummary>;
  getPage(queryId: string, options: { offset: number; limit: number }): Promise<QueryPage>;
  exportResult(
    queryId: string,
    options: DataExportOptions,
    signal?: AbortSignal,
    onProgress?: (progress: EngineProgress) => void,
  ): Promise<DataExportResult>;
  dropTable(tableName: string): Promise<void>;
  cancel(): Promise<boolean>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export const supportedDataEncodings: readonly DataEncoding[] = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1251",
  "windows-1252",
  "iso-8859-1",
];

export const DATA_ENGINE_LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024 * 1024,
  maxTranscodedInputBytes: 128 * 1024 * 1024,
  memoryLimitMiB: 512,
  defaultQueryRows: 100_000,
  maxQueryRows: 1_000_000,
  maxPageRows: 500,
  maxTextExportBytes: 512 * 1024 * 1024,
  maxParquetExportBytes: 512 * 1024 * 1024,
});

// Both bundles are single-threaded; older WASM engines can use the MVP build.
const BUNDLE = Reflect.has(WebAssembly, "Exception")
  ? { mainModule: duckdbEhWasm, mainWorker: duckdbEhWorker }
  : { mainModule: duckdbMvpWasm, mainWorker: duckdbMvpWorker };
const textEncoder = new TextEncoder();
const SAFE_CASTS: Record<ProjectionCast, true> = {
  VARCHAR: true,
  BIGINT: true,
  DOUBLE: true,
  DECIMAL: true,
  BOOLEAN: true,
  DATE: true,
  TIMESTAMP: true,
};
const BLOCKED_SQL = /\b(?:attach|detach|install|load|copy|import|export|call|pragma|create|drop|alter|truncate|insert|update|delete|merge|vacuum)\b|(?:\b|"|`)(?:read_csv|read_csv_auto|read_json|read_json_auto|read_parquet|read_blob|read_text|parquet_scan|csv_scan|glob)(?:\b|"|`)\s*\(/i;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function quoteIdentifier(identifier: string): string {
  if (!identifier || identifier.includes("\0")) throw new Error("invalid-table-name");
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("invalid-value");
  return `'${value.replaceAll("'", "''")}'`;
}

function decimalType(column: ProjectionColumn): string {
  if (column.cast !== "DECIMAL") return column.cast ?? "";
  const precision = column.decimalPrecision ?? 38;
  const scale = column.decimalScale ?? 18;
  if (!Number.isInteger(precision) || precision < 1 || precision > 38 || !Number.isInteger(scale) || scale < 0 || scale > precision) {
    throw new Error("invalid-decimal");
  }
  return `DECIMAL(${precision},${scale})`;
}

/** Build a projection with quoted names and strict CAST semantics (never TRY_CAST). */
export function buildProjectionQuery(tableName: string, columns: readonly ProjectionColumn[]): string {
  if (columns.length === 0) throw new Error("no-columns");
  const projection = columns.map((column) => {
    if (column.cast && !SAFE_CASTS[column.cast]) throw new Error("invalid-cast");
    let expression = quoteIdentifier(column.source);
    if (column.cast) expression = `CAST(${expression} AS ${decimalType(column)})`;
    return `${expression} AS ${quoteIdentifier(column.alias || column.source)}`;
  });
  return `SELECT ${projection.join(", ")} FROM ${quoteIdentifier(tableName)}`;
}

function maskedSql(sql: string): string {
  let result = "";
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (state === "normal") {
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "-" && next === "-") { state = "line"; index++; }
      else if (char === "/" && next === "*") { state = "block"; index++; }
      else result += char;
      continue;
    }
    if (state === "line") {
      if (char === "\n") { state = "normal"; result += "\n"; }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "normal"; index++; }
      continue;
    }
    const quote = state === "single" ? "'" : '"';
    if (char === quote && next === quote) { index++; continue; }
    if (char === quote) state = "normal";
  }
  if (state === "single" || state === "double" || state === "block") throw new Error("invalid-sql");
  return result;
}

/** Only local, read-only SELECT/WITH statements are accepted. */
export function assertLocalSelect(sql: string): string {
  const normalized = sql.trim().replace(/;\s*$/, "").trim();
  if (!normalized) throw new Error("empty-sql");
  const masked = maskedSql(normalized);
  if (!/^\s*(?:select|with)\b/i.test(masked)) throw new Error("select-only");
  if (masked.includes(";")) throw new Error("single-statement-only");
  if (BLOCKED_SQL.test(masked) || BLOCKED_SQL.test(normalized)) throw new Error("external-access-blocked");
  return normalized;
}

function detectFormat(file: File): DataFormat {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv";
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "jsonl";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".parquet")) return "parquet";
  throw new Error("unsupported-format");
}

function finiteInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function numericCell(value: unknown): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("row-count-too-large");
    return Number(value);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("invalid-row-count");
  return number;
}

function displayCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (typeof value === "object" && "toString" in value) return String(value);
  return String(value);
}

function csvCell(value: string | null, delimiter: string): string {
  if (value === null) return "";
  if (!value.includes(delimiter) && !/["\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const JSON_NUMERIC_TYPE = /^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?|REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC)/u;

function jsonCell(value: string | null, type: string): string {
  if (value === null) return "null";
  const normalizedType = type.toUpperCase();
  if (/^(?:STRUCT|MAP|UNION|LIST)\b|\[\d*\]$/u.test(normalizedType)) {
    throw new Error("json-tabular-unsupported");
  }
  if (normalizedType === "BOOLEAN" && /^(?:true|false)$/u.test(value)) return value;
  if (JSON_NUMERIC_TYPE.test(normalizedType)) {
    if (!JSON_NUMBER.test(value)) throw new Error("json-tabular-unsupported");
    return value;
  }
  return JSON.stringify(value);
}

function jsonRow(columns: readonly DataColumn[], row: readonly (string | null)[]): string {
  return `{${columns.map((column, index) => `${JSON.stringify(column.name)}:${jsonCell(row[index] ?? null, column.type)}`).join(",")}}`;
}

function mimeFor(format: ExportFormat): string {
  if (format === "csv") return "text/csv;charset=utf-8";
  if (format === "jsonl") return "application/x-ndjson;charset=utf-8";
  if (format === "json") return "application/json;charset=utf-8";
  return "application/vnd.apache.parquet";
}

interface Runtime {
  db: duckdb.AsyncDuckDB;
  connection: duckdb.AsyncDuckDBConnection;
  worker: Worker;
}

class LocalDataEngineImpl implements LocalDataEngine {
  private readonly options: Required<Omit<LocalDataEngineOptions, "onWasmLoad">> & Pick<LocalDataEngineOptions, "onWasmLoad">;
  private runtimePromise: Promise<Runtime> | null = null;
  private runtime: Runtime | null = null;
  private initializingWorker: Worker | null = null;
  private generation = 0;
  private sequence = 0;
  private activeResult: { id: string; table: string; summary: QuerySummary } | null = null;
  private readonly tables = new Map<string, { info: TableInfo }>();

  constructor(options: LocalDataEngineOptions = {}) {
    this.options = {
      onWasmLoad: options.onWasmLoad,
      memoryLimitMiB: finiteInteger(options.memoryLimitMiB ?? DATA_ENGINE_LIMITS.memoryLimitMiB, DATA_ENGINE_LIMITS.memoryLimitMiB, 128, 1024),
      maxInputBytes: finiteInteger(options.maxInputBytes ?? DATA_ENGINE_LIMITS.maxInputBytes, DATA_ENGINE_LIMITS.maxInputBytes, 1, DATA_ENGINE_LIMITS.maxInputBytes),
      maxTextExportBytes: finiteInteger(options.maxTextExportBytes ?? DATA_ENGINE_LIMITS.maxTextExportBytes, DATA_ENGINE_LIMITS.maxTextExportBytes, 1, DATA_ENGINE_LIMITS.maxTextExportBytes),
      maxParquetExportBytes: finiteInteger(options.maxParquetExportBytes ?? DATA_ENGINE_LIMITS.maxParquetExportBytes, DATA_ENGINE_LIMITS.maxParquetExportBytes, 1, DATA_ENGINE_LIMITS.maxParquetExportBytes),
    };
  }

  private async initialize(expectedGeneration: number): Promise<Runtime> {
    const bundle = BUNDLE;
    if (expectedGeneration !== this.generation) throw abortError();
    if (!bundle.mainWorker) throw new Error("duckdb-worker-unavailable");
    const worker = new Worker(bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    this.initializingWorker = worker;
    try {
      await db.instantiate(bundle.mainModule, null, (progress) => {
        this.options.onWasmLoad?.({ component: "duckdb", loaded: progress.bytesLoaded, total: progress.bytesTotal });
      });
      await db.open({
        path: ":memory:",
        maximumThreads: 1,
        useDirectIO: true,
        allowUnsignedExtensions: false,
        arrowLosslessConversion: true,
        filesystem: { allowFullHTTPReads: false, forceFullHTTPReads: false },
        query: { castBigIntToDouble: false, castDecimalToDouble: false, castTimestampToDate: false },
      });
      const connection = await db.connect();
      await connection.query(`SET memory_limit='${this.options.memoryLimitMiB}MB'`);
      await connection.query("SET autoinstall_known_extensions=false");
      await connection.query("SET autoload_known_extensions=false");
      await connection.query("SET allowed_directories=['/mdt-local']");
      await connection.query("SET enable_external_access=false");
      if (expectedGeneration !== this.generation) throw abortError();
      const runtime = { db, connection, worker };
      this.initializingWorker = null;
      this.runtime = runtime;
      return runtime;
    } catch (error) {
      if (this.initializingWorker === worker) this.initializingWorker = null;
      worker.terminate();
      throw error;
    }
  }

  private getRuntime(): Promise<Runtime> {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (!this.runtimePromise) {
      const expectedGeneration = this.generation;
      let pending: Promise<Runtime>;
      pending = this.initialize(expectedGeneration).catch((error: unknown) => {
        if (this.runtimePromise === pending) this.runtimePromise = null;
        throw error;
      });
      this.runtimePromise = pending;
    }
    return this.runtimePromise;
  }

  private async terminateRuntime(): Promise<boolean> {
    this.generation++;
    const worker = this.runtime?.worker ?? this.initializingWorker;
    this.runtime = null;
    this.runtimePromise = null;
    this.initializingWorker = null;
    this.activeResult = null;
    this.tables.clear();
    worker?.terminate();
    return Boolean(worker);
  }

  private async runCancelable<T>(
    signal: AbortSignal | undefined,
    run: (runtime: Runtime) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    let rejectAbort: (reason: DOMException) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      void this.terminateRuntime();
      rejectAbort(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const runtime = await Promise.race([this.getRuntime(), aborted]);
      const result = await Promise.race([run(runtime), aborted]);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async transcode(file: File, encoding: DataEncoding, signal: AbortSignal | undefined, onProgress: ((progress: EngineProgress) => void) | undefined, startedAt: number): Promise<Blob> {
    if (file.size > DATA_ENGINE_LIMITS.maxTranscodedInputBytes) throw new Error("transcode-too-large");
    const decoder = new TextDecoder(encoding, { fatal: true });
    const reader = file.stream().getReader();
    const chunks: Uint8Array[] = [];
    let processed = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        processed += value.byteLength;
        const text = decoder.decode(value, { stream: true });
        if (text) chunks.push(textEncoder.encode(text));
        onProgress?.({ phase: "importing", processed, total: file.size, elapsedMs: performance.now() - startedAt });
      }
      const final = decoder.decode();
      if (final) chunks.push(textEncoder.encode(final));
      return new Blob(chunks.map((chunk) => chunk.buffer as ArrayBuffer), { type: "text/csv;charset=utf-8" });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async schema(connection: duckdb.AsyncDuckDBConnection, tableName: string): Promise<DataColumn[]> {
    const table = await connection.query(`DESCRIBE SELECT * FROM ${quoteIdentifier(tableName)}`);
    const names = table.getChild("column_name");
    const types = table.getChild("column_type");
    if (!names || !types) throw new Error("schema-unavailable");
    const columns: DataColumn[] = [];
    for (let index = 0; index < table.numRows; index++) {
      columns.push({ name: String(names.get(index)), type: String(types.get(index)) });
    }
    return columns;
  }

  private async countRows(connection: duckdb.AsyncDuckDBConnection, tableName: string): Promise<number> {
    const result = await connection.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`);
    return numericCell(result.getChild("count")?.get(0));
  }

  async loadTable(file: File, options: LoadTableOptions, signal?: AbortSignal, onProgress?: (progress: EngineProgress) => void): Promise<TableInfo> {
    if (!file.size) throw new Error("empty-file");
    if (file.size > this.options.maxInputBytes) throw new Error("file-too-large");
    quoteIdentifier(options.tableName);
    const format = options.format ?? detectFormat(file);
    const encoding = options.csv?.encoding ?? "utf-8";
    if (!supportedDataEncodings.includes(encoding)) throw new Error("unsupported-encoding");
    const startedAt = performance.now();
    onProgress?.({ phase: "importing", processed: 0, total: file.size, elapsedMs: 0 });

    return this.runCancelable(signal, async ({ db, connection }) => {
      const table = quoteIdentifier(options.tableName);
      let filePath: string | null = null;
      try {
        if (format === "parquet") {
          const parquetBytes = new Uint8Array(await file.arrayBuffer());
          throwIfAborted(signal);
          const ipc = await parquetToArrowIpc(parquetBytes, signal, (progress) => this.options.onWasmLoad?.({ component: "parquet", ...progress }));
          throwIfAborted(signal);
          await connection.query(`DROP TABLE IF EXISTS ${table}`);
          await connection.insertArrowFromIPCStream(ipc, { name: options.tableName, create: true });
        } else {
          const id = ++this.sequence;
          filePath = `/mdt-local/input_${id}.csv`;
          let handle: Blob;
          let source: string;
          if (format === "csv") {
            handle = encoding !== "utf-8"
              ? await this.transcode(file, encoding, signal, onProgress, startedAt)
              : file;
            const delimiter = options.csv?.delimiter ?? (file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",");
            if (![",", ";", "\t", "|"].includes(delimiter)) throw new Error("invalid-delimiter");
            source = `read_csv(${quoteLiteral(filePath)}, delim=${quoteLiteral(delimiter)}, header=${options.csv?.header ?? true}, auto_detect=true, all_varchar=${options.csv?.allVarchar ?? false}, ignore_errors=false)`;
          } else {
            const jsonSource = encoding !== "utf-8"
              ? await this.transcode(file, encoding, signal, onProgress, startedAt)
              : file;
            const tabular = await jsonToTabular(new Uint8Array(await jsonSource.arrayBuffer()), format, signal);
            handle = new Blob([tabular.bytes.buffer as ArrayBuffer], { type: "text/csv;charset=utf-8" });
            const types = `, types={${tabular.columns.map((column) => `${quoteLiteral(column.name)}:${quoteLiteral(column.sqlType)}`).join(",")}}`;
            source = `read_csv(${quoteLiteral(filePath)}, delim=',', header=true, auto_detect=true, nullstr=${quoteLiteral(tabular.nullToken)}${types}, ignore_errors=false)`;
          }
          throwIfAborted(signal);
          await db.registerFileHandle(filePath, handle, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
          await connection.query(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${source}`);
        }
        throwIfAborted(signal);
        const columns = await this.schema(connection, options.tableName);
        const rowCount = await this.countRows(connection, options.tableName);
        const info: TableInfo = { name: options.tableName, sourceName: file.name, format, fileSize: file.size, rowCount, columns };
        this.tables.set(options.tableName, { info });
        onProgress?.({ phase: "importing", processed: file.size, total: file.size, elapsedMs: performance.now() - startedAt });
        return info;
      } finally {
        if (filePath) await db.dropFile(filePath).catch(() => null);
      }
    });
  }

  async inspectTable(tableName: string): Promise<TableInfo> {
    const known = this.tables.get(tableName)?.info;
    if (!known) throw new Error("table-not-found");
    const runtime = await this.getRuntime();
    const columns = await this.schema(runtime.connection, tableName);
    const rowCount = await this.countRows(runtime.connection, tableName);
    const info = { ...known, columns, rowCount };
    const entry = this.tables.get(tableName);
    if (entry) entry.info = info;
    return info;
  }

  async query(sql: string, options: QueryOptions = {}, signal?: AbortSignal, onProgress?: (progress: EngineProgress) => void): Promise<QuerySummary> {
    const select = assertLocalSelect(sql);
    const maxRows = options.maxRows == null
      ? null
      : finiteInteger(options.maxRows, DATA_ENGINE_LIMITS.defaultQueryRows, 1, DATA_ENGINE_LIMITS.maxQueryRows);
    const startedAt = performance.now();
    onProgress?.({ phase: "querying", processed: 0, total: maxRows ?? 0, elapsedMs: 0 });
    return this.runCancelable(signal, async ({ connection }) => {
      await connection.query("SET enable_external_access=false");
      if (this.activeResult) await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(this.activeResult.table)}`);
      this.activeResult = null;
      const sequence = ++this.sequence;
      const tableName = `__mdt_result_${sequence}`;
      const limit = maxRows === null ? "" : ` LIMIT ${maxRows + 1}`;
      await connection.query(`CREATE TEMP TABLE ${quoteIdentifier(tableName)} AS SELECT * FROM (${select}) AS __mdt_result${limit}`);
      try {
        throwIfAborted(signal);
        const actualRows = await this.countRows(connection, tableName);
        const columns = await this.schema(connection, tableName);
        const rowCount = maxRows === null ? actualRows : Math.min(maxRows, actualRows);
        const summary: QuerySummary = {
          id: `query-${sequence}`,
          columns,
          rowCount,
          truncated: maxRows !== null && actualRows > maxRows,
          maxRows,
          elapsedMs: performance.now() - startedAt,
        };
        this.activeResult = { id: summary.id, table: tableName, summary };
        onProgress?.({ phase: "querying", processed: rowCount, total: rowCount, elapsedMs: summary.elapsedMs });
        return summary;
      } catch (error) {
        await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`).catch(() => undefined);
        throw error;
      }
    });
  }

  async getPage(queryId: string, options: { offset: number; limit: number }): Promise<QueryPage> {
    const result = this.activeResult;
    if (!result || result.id !== queryId) throw new Error("query-not-found");
    const offset = finiteInteger(options.offset, 0, 0, result.summary.rowCount);
    const limit = finiteInteger(options.limit, 100, 1, DATA_ENGINE_LIMITS.maxPageRows);
    const remaining = Math.max(0, result.summary.rowCount - offset);
    const count = Math.min(limit, remaining);
    if (!count) return { queryId, offset, rows: [] };
    const runtime = await this.getRuntime();
    const projection = result.summary.columns.map((column) => `CAST(${quoteIdentifier(column.name)} AS VARCHAR) AS ${quoteIdentifier(column.name)}`).join(", ");
    const table = await runtime.connection.query(`SELECT ${projection} FROM ${quoteIdentifier(result.table)} LIMIT ${count} OFFSET ${offset}`);
    const vectors = result.summary.columns.map((column) => table.getChild(column.name));
    const rows: (string | null)[][] = [];
    for (let row = 0; row < table.numRows; row++) rows.push(vectors.map((vector) => displayCell(vector?.get(row))));
    return { queryId, offset, rows };
  }

  async exportResult(queryId: string, options: DataExportOptions, signal?: AbortSignal, onProgress?: (progress: EngineProgress) => void): Promise<DataExportResult> {
    const result = this.activeResult;
    if (!result || result.id !== queryId) throw new Error("query-not-found");
    const startedAt = performance.now();
    const chunks: ArrayBuffer[] = [];
    let bytes = 0;
    const maxBytes = options.format === "parquet" ? this.options.maxParquetExportBytes : this.options.maxTextExportBytes;
    const write = async (chunk: Uint8Array) => {
      throwIfAborted(signal);
      if (bytes + chunk.byteLength > maxBytes && (options.format === "parquet" || !options.sink)) throw new Error("export-too-large");
      bytes += chunk.byteLength;
      if (options.sink) await options.sink.write(chunk);
      else chunks.push(chunk.slice().buffer as ArrayBuffer);
    };
    onProgress?.({ phase: "exporting", processed: 0, total: result.summary.rowCount, elapsedMs: 0 });

    await this.runCancelable(signal, async ({ connection }) => {
      if (options.format === "parquet") {
        const resultTable = await connection.query(`SELECT * FROM ${quoteIdentifier(result.table)} LIMIT ${result.summary.rowCount}`);
        throwIfAborted(signal);
        const ipc = tableToIPC(resultTable, "stream");
        const data = await arrowIpcToParquet(ipc, signal, (progress) => this.options.onWasmLoad?.({ component: "parquet", ...progress }));
        if (data.byteLength > this.options.maxParquetExportBytes) throw new Error("export-too-large");
        await write(data);
        onProgress?.({ phase: "exporting", processed: result.summary.rowCount, total: result.summary.rowCount, elapsedMs: performance.now() - startedAt });
        return;
      }

      const pageSize = DATA_ENGINE_LIMITS.maxPageRows;
      if (options.format === "csv") {
        const delimiter = options.delimiter ?? ",";
        if (![",", ";", "\t", "|"].includes(delimiter)) throw new Error("invalid-delimiter");
        if (options.header ?? true) await write(textEncoder.encode(`${result.summary.columns.map((column) => csvCell(column.name, delimiter)).join(delimiter)}\r\n`));
        for (let offset = 0; offset < result.summary.rowCount; offset += pageSize) {
          throwIfAborted(signal);
          const page = await this.getPage(queryId, { offset, limit: pageSize });
          const text = page.rows.map((row) => row.map((cell) => csvCell(cell, delimiter)).join(delimiter)).join("\r\n");
          if (text) await write(textEncoder.encode(`${text}\r\n`));
          onProgress?.({ phase: "exporting", processed: Math.min(offset + page.rows.length, result.summary.rowCount), total: result.summary.rowCount, elapsedMs: performance.now() - startedAt });
        }
        return;
      }

      if (options.format === "json") await write(textEncoder.encode("["));
      let first = true;
      for (let offset = 0; offset < result.summary.rowCount; offset += pageSize) {
        throwIfAborted(signal);
        const page = await this.getPage(queryId, { offset, limit: pageSize });
        let text = "";
        for (const row of page.rows) {
          const json = jsonRow(result.summary.columns, row);
          if (options.format === "jsonl") text += `${json}\n`;
          else { text += `${first ? "" : ","}${json}`; first = false; }
        }
        if (text) await write(textEncoder.encode(text));
        onProgress?.({ phase: "exporting", processed: Math.min(offset + page.rows.length, result.summary.rowCount), total: result.summary.rowCount, elapsedMs: performance.now() - startedAt });
      }
      if (options.format === "json") await write(textEncoder.encode("]\n"));
    });

    const blob = options.sink ? null : new Blob(chunks, { type: mimeFor(options.format) });
    return { blob, bytes, rows: result.summary.rowCount, format: options.format, buffered: options.format === "parquet" };
  }

  async dropTable(tableName: string): Promise<void> {
    const entry = this.tables.get(tableName);
    if (!entry) return;
    const runtime = await this.getRuntime();
    await runtime.connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
    this.tables.delete(tableName);
  }

  cancel(): Promise<boolean> {
    return this.terminateRuntime();
  }

  async restart(): Promise<void> {
    await this.terminateRuntime();
  }

  async dispose(): Promise<void> {
    await this.terminateRuntime();
  }
}

export function createLocalDataEngine(options: LocalDataEngineOptions = {}): LocalDataEngine {
  return new LocalDataEngineImpl(options);
}
