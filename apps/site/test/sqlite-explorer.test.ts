import assert from "node:assert/strict";
import test from "node:test";
import init from "@sqlite.org/sqlite-wasm";
import {
  clearWalMode,
  csvSqliteCell,
  hasSqliteHeader,
  sqliteHeaderEncoding,
  jsonSqliteCell,
  leadingSqlKeyword,
  previewSqliteCell,
  quoteSqliteIdentifier,
  sqlLiteralSqliteCell,
  SqliteExplorerEngine,
  SqliteExplorerError,
  SQLITE_LIMITS,
} from "../src/tools/sqlite-explorer-engine.ts";

(globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = { warn: () => {} };
const sqlite3 = await init();

function sampleDatabase(): Uint8Array {
  const db = new sqlite3.oo1.DB(":memory:");
  db.exec(`
    CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar BLOB, big INTEGER, team_id INTEGER REFERENCES teams(id));
    CREATE TABLE teams(id INTEGER PRIMARY KEY, title TEXT UNIQUE);
    CREATE INDEX people_name ON people(name);
    CREATE VIEW names AS SELECT name FROM people;
    CREATE TRIGGER people_touch AFTER INSERT ON people BEGIN SELECT 1; END;
    INSERT INTO teams VALUES (1, 'core');
    INSERT INTO people VALUES (1, 'Ann', x'00ff', 9007199254740993, 1), (2, 'Bo''b', NULL, 3, NULL);
    PRAGMA user_version = 7;
  `);
  const bytes = sqlite3.capi.sqlite3_js_db_export(db);
  db.close();
  return bytes;
}

test("header and WAL helpers", () => {
  const bytes = sampleDatabase();
  assert.equal(hasSqliteHeader(bytes), true);
  assert.equal(hasSqliteHeader(new Uint8Array(100)), false);
  const wal = new Uint8Array(bytes);
  wal[18] = 2;
  wal[19] = 2;
  assert.equal(clearWalMode(wal), true);
  assert.deepEqual([wal[18], wal[19]], [1, 1]);
  assert.equal(clearWalMode(wal), false);
  const utf16 = new Uint8Array(bytes);
  utf16[59] = 2;
  assert.equal(sqliteHeaderEncoding(utf16), "UTF-16le");
});

test("cell formatting for preview, CSV, JSON and SQL", () => {
  const blob = new Uint8Array([0, 255]);
  assert.equal(previewSqliteCell(null), "NULL");
  assert.equal(previewSqliteCell(blob), "x'00ff' (2 B)");
  assert.equal(previewSqliteCell(new Uint8Array(40)).endsWith("…' (40 B)"), true);
  assert.equal(previewSqliteCell("x".repeat(600)).length, SQLITE_LIMITS.cellPreviewChars + 1);
  assert.equal(csvSqliteCell(null), "");
  assert.equal(csvSqliteCell(blob), "00ff");
  assert.equal(jsonSqliteCell(9007199254740993n), "9007199254740993");
  assert.equal(jsonSqliteCell(3n), 3);
  assert.equal(jsonSqliteCell(Number.POSITIVE_INFINITY), null);
  assert.equal(sqlLiteralSqliteCell("Bo'b"), "'Bo''b'");
  assert.equal(sqlLiteralSqliteCell(blob), "X'00ff'");
  assert.equal(sqlLiteralSqliteCell(Number.NEGATIVE_INFINITY), "-9e999");
  assert.equal(quoteSqliteIdentifier("a\"b"), "\"a\"\"b\"");
  assert.equal(leadingSqlKeyword("-- note\n/* x */ with t as (select 1) select * from t"), "WITH");
});

test("opens a read-only copy with schema, details and table paging", () => {
  const engine = new SqliteExplorerEngine(sqlite3);
  const bytes = sampleDatabase();
  const { info, objects } = engine.open(bytes, "sample.db", false);
  assert.equal(info.fileSize, bytes.length);
  assert.equal(info.userVersion, 7);
  assert.equal(info.encoding, "UTF-8");
  assert.equal(info.writable, false);
  assert.deepEqual(objects.map((item) => `${item.type}:${item.name}`), [
    "table:people", "table:teams", "view:names", "index:people_name", "trigger:people_touch",
  ]);
  const detail = engine.detail("people");
  assert.deepEqual(detail.columns.map((column) => column.name), ["id", "name", "avatar", "big", "team_id"]);
  assert.equal(detail.columns[1].notNull, true);
  assert.deepEqual(detail.indexes.map((index) => [index.name, index.columns]), [["people_name", ["name"]]]);
  assert.deepEqual(detail.foreignKeys, [{ table: "teams", from: "team_id", to: "id" }]);
  const summary = engine.browse("people");
  assert.equal(summary.rowCount, 2);
  assert.deepEqual(engine.readRows(0, 10), [
    ["1", "Ann", "x'00ff' (2 B)", "9007199254740993", "1"],
    ["2", "Bo'b", "NULL", "3", "NULL"],
  ]);
  assert.throws(() => engine.run("DELETE FROM people"), (error: unknown) => error instanceof SqliteExplorerError && error.code === "readonly");
  assert.throws(() => engine.browse("missing"), SqliteExplorerError);
});

test("runs scripts: queries materialize, pragmas are captured, errors are SQL errors", () => {
  const engine = new SqliteExplorerEngine(sqlite3);
  engine.open(sampleDatabase(), "sample.db", false);
  const query = engine.run("-- first\nSELECT 1;\nSELECT name, big FROM people ORDER BY id DESC;");
  assert.equal(query.source, "query");
  assert.equal(query.statements, 2);
  assert.deepEqual(query.columns, ["name", "big"]);
  assert.deepEqual(engine.readRows(0, 5), [["Bo'b", "3"], ["Ann", "9007199254740993"]]);
  assert.deepEqual([...engine.iterateRows()], [["Bo'b", 3], ["Ann", 9007199254740993n]]);
  const pragma = engine.run("PRAGMA table_info(teams)");
  assert.equal(pragma.rowCount, 2);
  assert.equal(engine.readRows(1, 1)[0][1], "title");
  const empty = engine.run("SELECT * FROM people WHERE 0 -- trailing comment");
  assert.equal(empty.rowCount, 0);
  assert.throws(() => engine.run("SELEC 1"), (error: unknown) => error instanceof SqliteExplorerError && error.code === "sql" && /syntax error/.test(error.message));
  assert.throws(() => new SqliteExplorerEngine(sqlite3).open(new Uint8Array(4096), "x.db", false), (error: unknown) => error instanceof SqliteExplorerError && error.code === "not-sqlite");
});

test("a writable copy accepts changes and exports a database with them", () => {
  const engine = new SqliteExplorerEngine(sqlite3);
  engine.open(sampleDatabase(), "sample.db", true);
  const changed = engine.run("CREATE TABLE notes(t TEXT); INSERT INTO notes VALUES ('a'), ('b'); UPDATE people SET name = 'Al' WHERE id = 1;");
  assert.equal(changed.source, "changes");
  assert.equal(changed.statements, 3);
  assert.equal(changed.changes, 3);
  const returning = engine.run("INSERT INTO notes VALUES ('c') RETURNING t");
  assert.equal(returning.source, "query");
  assert.deepEqual(engine.readRows(0, 5), [["c"]]);
  const reopened = new SqliteExplorerEngine(sqlite3);
  const { objects } = reopened.open(engine.exportDatabase(), "copy.db", false);
  assert.ok(objects.some((item) => item.name === "notes"));
  reopened.run("SELECT count(*) AS n FROM notes");
  assert.deepEqual(reopened.readRows(0, 1), [["3"]]);
  assert.equal(reopened.resultName(), "query_result");
});
