import type { Database, Sqlite3Static, SqlValue } from "@sqlite.org/sqlite-wasm";

/** Bounds for the in-browser SQLite explorer: file size, preview cells, captured and materialized result rows. */
export const SQLITE_LIMITS = {
  maxDatabaseBytes: 512 * 1024 * 1024,
  maxSqlChars: 1024 * 1024,
  cellPreviewChars: 512,
  blobPreviewBytes: 32,
  maxCapturedRows: 10_000,
  maxResultRows: 1_000_000,
  maxPageRows: 500,
} as const;

const SQLITE_HEADER = "SQLite format 3\u0000";
const RESULT_TABLE = "temp._mdt_result";

export type SqliteObjectType = "table" | "view" | "index" | "trigger";
export type SqliteExportFormat = "csv" | "json" | "jsonl" | "sql";

export interface SqliteObject {
  type: SqliteObjectType;
  name: string;
  table: string;
}

export interface SqliteDatabaseInfo {
  fileName: string;
  fileSize: number;
  pageSize: number;
  pageCount: number;
  freePages: number;
  encoding: string;
  userVersion: number;
  applicationId: number;
  /** The file was saved in WAL mode; a separate -wal file is not read. */
  wal: boolean;
  writable: boolean;
  sqliteVersion: string;
}

export interface SqliteColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: number;
  hidden: boolean;
}

export interface SqliteIndexInfo {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
}

export interface SqliteForeignKey {
  table: string;
  from: string;
  to: string | null;
}

export interface SqliteObjectDetail extends SqliteObject {
  sql: string | null;
  columns: SqliteColumnInfo[];
  indexes: SqliteIndexInfo[];
  foreignKeys: SqliteForeignKey[];
}

export type SqliteResultSource = "table" | "query" | "changes";

export interface SqliteResultSummary {
  source: SqliteResultSource;
  /** Table or view name for a browsed object; empty for query results. */
  name: string;
  columns: string[];
  rowCount: number;
  truncated: boolean;
  statements: number;
  changes: number;
  elapsedMs: number;
}

export class SqliteExplorerError extends Error {
  readonly code: "not-sqlite" | "corrupt" | "file-too-large" | "sql-too-large" | "readonly" | "no-database" | "unknown-object" | "sql";
  constructor(code: SqliteExplorerError["code"], message: string) {
    super(message);
    this.name = "SqliteExplorerError";
    this.code = code;
  }
}

/** Double-quote an SQLite identifier (table, column, index name). */
export function quoteSqliteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

/** True when the first bytes carry the SQLite 3 file header; encrypted or foreign files fail it. */
export function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false;
  for (let index = 0; index < SQLITE_HEADER.length; index++) {
    if (bytes[index] !== SQLITE_HEADER.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * The in-memory VFS cannot open a WAL-mode file, so header bytes 18/19 are switched to
 * the rollback journal in the copy. Returns whether the file was in WAL mode.
 */
export function clearWalMode(bytes: Uint8Array): boolean {
  const wal = bytes[18] === 2 || bytes[19] === 2;
  if (wal) {
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return wal;
}

/** Text encoding from header offset 56 (the WASM build omits PRAGMA encoding). */
export function sqliteHeaderEncoding(bytes: Uint8Array): string {
  const code = bytes.length >= 60 ? ((bytes[56] << 24) | (bytes[57] << 16) | (bytes[58] << 8) | bytes[59]) >>> 0 : 0;
  if (code === 2) return "UTF-16le";
  if (code === 3) return "UTF-16be";
  return "UTF-8";
}

function hex(bytes: Uint8Array, limit = bytes.length): string {
  let out = "";
  const end = Math.min(limit, bytes.length);
  for (let index = 0; index < end; index++) out += bytes[index].toString(16).padStart(2, "0");
  return out;
}

function asBytes(value: Uint8Array | Int8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function isBlob(value: SqlValue): value is Uint8Array | Int8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof Int8Array || value instanceof ArrayBuffer;
}

/** Table-cell text: NULL marker, numbers as-is, BLOBs as a short x'…' hex prefix with size, long text cut. */
export function previewSqliteCell(value: SqlValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (isBlob(value)) {
    const bytes = asBytes(value);
    const more = bytes.length > SQLITE_LIMITS.blobPreviewBytes ? "…" : "";
    return `x'${hex(bytes, SQLITE_LIMITS.blobPreviewBytes)}${more}' (${bytes.length} B)`;
  }
  if (value.length <= SQLITE_LIMITS.cellPreviewChars) return value;
  const last = value.charCodeAt(SQLITE_LIMITS.cellPreviewChars - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? SQLITE_LIMITS.cellPreviewChars - 1 : SQLITE_LIMITS.cellPreviewChars;
  return `${value.slice(0, end)}…`;
}

/** CSV field text: NULL becomes empty, BLOB becomes lowercase hex. */
export function csvSqliteCell(value: SqlValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (isBlob(value)) return hex(asBytes(value));
  return value;
}

/** JSON value: unsafe 64-bit integers become strings, BLOB becomes hex, non-finite floats become null. */
export function jsonSqliteCell(value: SqlValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (isBlob(value)) return hex(asBytes(value));
  return value;
}

/** SQL literal for INSERT export: '' escaping, X'…' blobs, infinities as 9e999. */
export function sqlLiteralSqliteCell(value: SqlValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NULL";
    if (!Number.isFinite(value)) return value > 0 ? "9e999" : "-9e999";
    return String(value);
  }
  if (isBlob(value)) return `X'${hex(asBytes(value))}'`;
  return `'${value.replaceAll("'", "''")}'`;
}

/** Strip leading comments and whitespace to see the statement keyword. */
export function leadingSqlKeyword(sql: string): string {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n");
      rest = newline < 0 ? "" : rest.slice(newline + 1);
    } else if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/", 2);
      rest = close < 0 ? "" : rest.slice(close + 2);
    } else {
      break;
    }
  }
  return /^[A-Za-z]+/.exec(rest)?.[0].toUpperCase() ?? "";
}

type ResultState =
  | { kind: "none" }
  | { kind: "table"; name: string }
  | { kind: "temp" }
  | { kind: "rows"; rows: SqlValue[][] };

/**
 * One opened database copy in WebAssembly memory. The original file is never written:
 * a read-only copy by default, or a writable in-memory copy that can be downloaded.
 */
export class SqliteExplorerEngine {
  private readonly sqlite3: Sqlite3Static;
  private db: Database | null = null;
  private info: SqliteDatabaseInfo | null = null;
  private result: ResultState = { kind: "none" };
  private resultColumns: string[] = [];
  private resultRows = 0;

  constructor(sqlite3: Sqlite3Static) {
    this.sqlite3 = sqlite3;
  }

  /** Copy `bytes` into WebAssembly memory and open it; the caller's buffer may be reused afterwards. */
  open(bytes: Uint8Array, fileName: string, writable: boolean): { info: SqliteDatabaseInfo; objects: SqliteObject[] } {
    if (bytes.length > SQLITE_LIMITS.maxDatabaseBytes) throw new SqliteExplorerError("file-too-large", "file-too-large");
    if (!hasSqliteHeader(bytes)) throw new SqliteExplorerError("not-sqlite", "not-sqlite");
    this.close();
    const { capi, wasm, oo1 } = this.sqlite3;
    const fileSize = bytes.length;
    const encoding = sqliteHeaderEncoding(bytes);
    const wal = clearWalMode(bytes);
    const db = new oo1.DB();
    try {
      const pointer = wasm.allocFromTypedArray(bytes);
      const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | (writable ? capi.SQLITE_DESERIALIZE_RESIZEABLE : capi.SQLITE_DESERIALIZE_READONLY);
      db.checkRc(capi.sqlite3_deserialize(db, "main", pointer, bytes.length, bytes.length, flags));
      // Reading the schema surfaces "file is not a database" and corruption right away.
      db.selectValue("SELECT count(*) FROM main.sqlite_schema");
    } catch (error) {
      db.close();
      const message = error instanceof Error ? error.message : String(error);
      if (/SQLITE_NOTADB|SQLITE_CORRUPT/u.test(message)) throw new SqliteExplorerError("corrupt", message);
      throw error;
    }
    this.db = db;
    const pragma = (name: string) => Number(db.selectValue(`PRAGMA main.${name}`) ?? 0);
    this.info = {
      fileName,
      fileSize,
      pageSize: pragma("page_size"),
      pageCount: pragma("page_count"),
      freePages: pragma("freelist_count"),
      encoding,
      userVersion: pragma("user_version"),
      applicationId: pragma("application_id"),
      wal,
      writable,
      sqliteVersion: capi.sqlite3_libversion(),
    };
    return { info: this.info, objects: this.objects() };
  }

  close(): void {
    this.result = { kind: "none" };
    this.resultColumns = [];
    this.resultRows = 0;
    this.db?.close();
    this.db = null;
    this.info = null;
  }

  private requireDb(): Database {
    if (!this.db) throw new SqliteExplorerError("no-database", "no-database");
    return this.db;
  }

  /** Tables, views, indexes and triggers of `main`, internal sqlite_* objects excluded. */
  objects(): SqliteObject[] {
    const rows = this.requireDb().selectArrays(
      "SELECT type, name, tbl_name FROM main.sqlite_schema WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name COLLATE NOCASE",
    );
    return rows.map(([type, name, table]) => ({ type: type as SqliteObjectType, name: String(name), table: String(table) }));
  }

  /** Structure of one schema object: CREATE SQL, columns, indexes and foreign keys. */
  detail(name: string): SqliteObjectDetail {
    const db = this.requireDb();
    const row = db.selectArray("SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE name = ?", [name]);
    if (!row) throw new SqliteExplorerError("unknown-object", name);
    const type = row[0] as SqliteObjectType;
    const detail: SqliteObjectDetail = { type, name: String(row[1]), table: String(row[2]), sql: row[3] === null ? null : String(row[3]), columns: [], indexes: [], foreignKeys: [] };
    if (type === "table" || type === "view") {
      detail.columns = db.selectArrays("SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?, 'main')", [name])
        .map(([column, declared, notNull, defaultValue, primaryKey, hidden]) => ({
          name: String(column),
          type: String(declared ?? ""),
          notNull: Number(notNull) === 1,
          defaultValue: defaultValue === null ? null : String(defaultValue),
          primaryKey: Number(primaryKey),
          hidden: Number(hidden) !== 0,
        }));
    }
    if (type === "table") {
      detail.indexes = db.selectArrays("SELECT name, \"unique\", origin, partial FROM pragma_index_list(?, 'main') ORDER BY seq", [name])
        .map(([index, unique, origin, partial]) => ({
          name: String(index),
          unique: Number(unique) === 1,
          origin: String(origin),
          partial: Number(partial) === 1,
          columns: db.selectArrays("SELECT name FROM pragma_index_info(?, 'main') ORDER BY seqno", [String(index)]).map(([column]) => column === null ? "<expr>" : String(column)),
        }));
      detail.foreignKeys = db.selectArrays("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq", [name])
        .map(([table, from, to]) => ({ table: String(table), from: String(from), to: to === null ? null : String(to) }));
    }
    return detail;
  }

  /** Make a table or view the current result; rows are paged straight from it. */
  browse(name: string): SqliteResultSummary {
    const db = this.requireDb();
    const started = performance.now();
    const type = db.selectValue("SELECT type FROM main.sqlite_schema WHERE name = ? AND type IN ('table','view')", [name]);
    if (!type) throw new SqliteExplorerError("unknown-object", name);
    const source = `main.${quoteSqliteIdentifier(name)}`;
    const statement = db.prepare(`SELECT * FROM ${source} LIMIT 0`);
    let columns: string[];
    try { columns = statement.getColumnNames(); } finally { statement.finalize(); }
    const rowCount = Number(db.selectValue(`SELECT count(*) FROM ${source}`) ?? 0);
    this.dropResultTable();
    this.result = { kind: "table", name };
    this.resultColumns = columns;
    this.resultRows = rowCount;
    return { source: "table", name, columns, rowCount, truncated: false, statements: 0, changes: 0, elapsedMs: performance.now() - started };
  }

  /**
   * Run a script statement by statement. The last statement that returns rows becomes the
   * result: a plain query is materialized into a temp table (capped), anything else
   * (PRAGMA, EXPLAIN, RETURNING) is captured up to a row limit.
   */
  run(sql: string): SqliteResultSummary {
    const db = this.requireDb();
    if (sql.length > SQLITE_LIMITS.maxSqlChars) throw new SqliteExplorerError("sql-too-large", "sql-too-large");
    const started = performance.now();
    const changesBefore = this.sqlite3.capi.sqlite3_total_changes(db);
    this.dropResultTable();
    this.result = { kind: "none" };
    this.resultColumns = [];
    this.resultRows = 0;
    let statements = 0;
    let truncated = false;
    let rowsFound = false;
    try {
      for (const text of this.statements(sql)) {
        statements++;
        const statement = db.prepare(text);
        let finalized = false;
        try {
          if (statement.columnCount === 0) {
            statement.step();
            continue;
          }
          const readonly = this.sqlite3.capi.sqlite3_stmt_readonly(statement) !== 0;
          const keyword = leadingSqlKeyword(text);
          if (readonly && (keyword === "SELECT" || keyword === "WITH" || keyword === "VALUES")) {
            statement.finalize();
            finalized = true;
            this.dropResultTable();
            truncated = this.materialize(text);
            rowsFound = true;
            continue;
          }
          const rows: SqlValue[][] = [];
          const columns = statement.getColumnNames();
          let more = false;
          while (statement.step()) {
            if (rows.length >= SQLITE_LIMITS.maxCapturedRows) { more = true; break; }
            rows.push(statement.get([]));
          }
          this.dropResultTable();
          this.result = { kind: "rows", rows };
          this.resultColumns = columns;
          this.resultRows = rows.length;
          truncated = more;
          rowsFound = true;
        } finally {
          if (!finalized) statement.finalize();
        }
      }
    } catch (error) {
      throw this.sqlError(error);
    }
    const changes = this.sqlite3.capi.sqlite3_total_changes(db) - changesBefore;
    return {
      source: rowsFound ? "query" : "changes",
      name: "",
      columns: this.resultColumns,
      rowCount: this.resultRows,
      truncated,
      statements,
      changes,
      elapsedMs: performance.now() - started,
    };
  }

  /** Rows `start…start+count` of the current result, formatted for the table view. */
  readRows(start: number, count: number): string[][] {
    return this.rawRows(start, Math.min(count, SQLITE_LIMITS.maxPageRows)).map((row) => row.map(previewSqliteCell));
  }

  /** Every row of the current result, raw, for export. Statements stay open between yields. */
  *iterateRows(): Generator<SqlValue[]> {
    const db = this.requireDb();
    if (this.result.kind === "rows") {
      yield* this.result.rows;
      return;
    }
    const sql = this.result.kind === "table"
      ? `SELECT * FROM main.${quoteSqliteIdentifier(this.result.name)}`
      : this.result.kind === "temp" ? `SELECT * FROM ${RESULT_TABLE} ORDER BY rowid` : "";
    if (!sql) return;
    const statement = db.prepare(sql);
    try {
      while (statement.step()) yield statement.get([]);
    } finally {
      statement.finalize();
    }
  }

  columns(): string[] {
    return this.resultColumns;
  }

  /** Name used for INSERT export: the browsed table, or `query_result`. */
  resultName(): string {
    return this.result.kind === "table" ? this.result.name : "query_result";
  }

  /** Serialize the in-memory copy, including changes, as a standalone database file. */
  exportDatabase(): Uint8Array {
    return this.sqlite3.capi.sqlite3_js_db_export(this.requireDb(), "main");
  }

  private rawRows(start: number, count: number): SqlValue[][] {
    const db = this.requireDb();
    if (count <= 0) return [];
    if (this.result.kind === "rows") return this.result.rows.slice(start, start + count);
    if (this.result.kind === "temp") {
      return db.selectArrays(`SELECT * FROM ${RESULT_TABLE} WHERE rowid > ? AND rowid <= ? ORDER BY rowid`, [start, start + count]);
    }
    if (this.result.kind === "table") {
      return db.selectArrays(`SELECT * FROM main.${quoteSqliteIdentifier(this.result.name)} LIMIT ? OFFSET ?`, [count, start]);
    }
    return [];
  }

  /** Copy a read-only query into a temp table; true when it hit the row cap. */
  private materialize(text: string): boolean {
    const db = this.requireDb();
    const body = text.trim().replace(/;\s*$/u, "");
    db.exec(`CREATE TEMP TABLE ${RESULT_TABLE} AS SELECT * FROM (\n${body}\n) LIMIT ${SQLITE_LIMITS.maxResultRows + 1}`);
    let rows = Number(db.selectValue(`SELECT count(*) FROM ${RESULT_TABLE}`) ?? 0);
    const truncated = rows > SQLITE_LIMITS.maxResultRows;
    if (truncated) {
      db.exec(`DELETE FROM ${RESULT_TABLE} WHERE rowid > ${SQLITE_LIMITS.maxResultRows}`);
      rows = SQLITE_LIMITS.maxResultRows;
    }
    const probe = db.prepare(`SELECT * FROM ${RESULT_TABLE} LIMIT 0`);
    try { this.resultColumns = probe.getColumnNames(); } finally { probe.finalize(); }
    this.result = { kind: "temp" };
    this.resultRows = rows;
    return truncated;
  }

  private dropResultTable(): void {
    this.db?.exec(`DROP TABLE IF EXISTS ${RESULT_TABLE}`);
    if (this.result.kind === "temp") this.result = { kind: "none" };
  }

  /**
   * Split a script into statements the way sqlite3_exec does: prepare from the tail, keep
   * the statement text, finalize. Each statement is prepared only after the previous one ran,
   * so later statements may use objects created by earlier ones.
   */
  private *statements(sql: string): Generator<string> {
    const { capi, wasm } = this.sqlite3;
    const db = this.requireDb();
    const encoded = new TextEncoder().encode(sql);
    let consumed = 0;
    while (consumed < encoded.length) {
      const stack = wasm.scopedAllocPush();
      let text: string | null = null;
      try {
        const remaining = encoded.length - consumed;
        const ppStmt = wasm.scopedAlloc(8 + remaining + 1);
        const pzTail = ppStmt + 4;
        const pSql = ppStmt + 8;
        wasm.heap8u().set(encoded.subarray(consumed), pSql);
        wasm.poke8(pSql + remaining, 0);
        wasm.pokePtr(ppStmt, 0);
        wasm.pokePtr(pzTail, 0);
        db.checkRc(capi.sqlite3_prepare_v3(db, pSql, remaining, 0, ppStmt, pzTail));
        const pStmt = Number(wasm.peekPtr(ppStmt));
        const tail = Number(wasm.peekPtr(pzTail));
        const used = tail ? tail - pSql : remaining;
        if (pStmt) {
          text = capi.sqlite3_sql(pStmt);
          capi.sqlite3_finalize(pStmt);
        }
        if (used <= 0) break;
        consumed += used;
      } finally {
        wasm.scopedAllocPop(stack);
      }
      if (text !== null) yield text;
    }
  }

  private sqlError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/SQLITE_READONLY|readonly database/u.test(message)) return new SqliteExplorerError("readonly", message);
    if (error instanceof SqliteExplorerError) return error;
    if (/SQLITE_NOMEM|out of memory/iu.test(message)) return error instanceof Error ? error : new Error(message);
    return new SqliteExplorerError("sql", message.replace(/^SQLITE_[A-Z_]+: sqlite3 result code \d+: /u, ""));
  }
}
