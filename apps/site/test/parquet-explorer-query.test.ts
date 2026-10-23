import assert from "node:assert/strict";
import { test } from "node:test";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetMetadata } from "hyparquet";
import { exportParquet, openParquetSource, readParquetRows, ParquetViewReader } from "../src/tools/parquet-explorer-io.ts";
import { ParquetExplorerError } from "../src/tools/parquet-explorer.ts";
import {
  ParquetRowSelection,
  aggregateParquet,
  buildParquetSelection,
  compileParquetCondition,
  parquetColumnKind,
  type ParquetCondition,
} from "../src/tools/parquet-explorer-query.ts";

const ROWS = 10_000;

/** 10,000 rows in row groups of 3,000 so windows cross group boundaries. */
function writeFixture(offsetIndex: boolean) {
  const id: bigint[] = [];
  const team: (string | null)[] = [];
  const amount: (number | null)[] = [];
  const ok: boolean[] = [];
  for (let row = 0; row < ROWS; row++) {
    id.push(9007199254740000n + BigInt(row));
    team.push(row % 10 === 9 ? null : ["Red", "blue", "Green"][row % 3]);
    amount.push(row % 7 === 0 ? null : row / 4);
    ok.push(row % 2 === 0);
  }
  return parquetWriteBuffer({
    columnData: [
      { name: "id", data: id, type: "INT64" as const, offsetIndex },
      { name: "team", data: team, type: "STRING" as const, nullable: true, offsetIndex },
      { name: "amount", data: amount, type: "DOUBLE" as const, nullable: true, offsetIndex },
      { name: "ok", data: ok, type: "BOOLEAN" as const, offsetIndex },
    ],
    rowGroupSize: 3_000,
  });
}

function columns(summary: { columns: { name: string; label: string; kind: ReturnType<typeof parquetColumnKind> }[] }) {
  return summary.columns.map(({ name, label, kind }) => ({ name, label, kind }));
}

const match = (condition: Omit<ParquetCondition, "column">, kind: Parameters<typeof compileParquetCondition>[1], value: unknown, caseSensitive = false) =>
  compileParquetCondition({ column: 0, ...condition }, kind, caseSensitive)(value);

test("conditions compare numbers exactly, nulls only match empty and text folds case", () => {
  assert.equal(match({ operator: "equals", value: "9007199254740993" }, "integer", 9007199254740993n), true);
  assert.equal(match({ operator: "equals", value: "9007199254740993" }, "integer", 9007199254740992n), false);
  assert.equal(match({ operator: "gt", value: "0.1" }, "number", 0.1), false);
  assert.equal(match({ operator: "gte", value: "0.1" }, "number", 0.1), true);
  // 0.1 + 0.2 is not the decimal 0.3, so equality stays exact.
  assert.equal(match({ operator: "equals", value: "0.3" }, "number", 0.1 + 0.2), false);
  assert.equal(match({ operator: "lt", value: "1e3" }, "integer", 999), true);
  assert.equal(match({ operator: "lt", value: "5" }, "number", null), false);
  assert.equal(match({ operator: "not-equals", value: "5" }, "number", null), false);
  assert.equal(match({ operator: "empty", value: "" }, "number", null), true);
  assert.equal(match({ operator: "not-empty", value: "" }, "text", ""), false);
  assert.equal(match({ operator: "contains", value: "RE" }, "text", "Green"), true);
  assert.equal(match({ operator: "contains", value: "RE" }, "text", "Green", true), false);
  assert.equal(match({ operator: "not-contains", value: "x" }, "text", null), false);
  assert.equal(match({ operator: "equals", value: "yes" }, "boolean", true), true);
  assert.equal(match({ operator: "gte", value: "2024-01-01T00:00:00Z" }, "time", new Date("2024-06-01T00:00:00Z")), true);
  for (const [value, kind] of [["abc", "integer"], ["maybe", "boolean"], ["not a date", "time"]] as const) {
    assert.throws(() => match({ operator: "equals", value }, kind, 1), (error: unknown) =>
      error instanceof ParquetExplorerError && error.code === "filter-value");
  }
});

test("row selection maps view positions to file rows across blocks", () => {
  const selection = new ParquetRowSelection(20_000);
  const picked = [3, 4095, 4096, 12_000, 19_999];
  for (const row of picked) selection.set(row);
  assert.equal(selection.finish(), picked.length);
  assert.deepEqual(selection.rowsForView(0, 10), picked);
  assert.deepEqual(selection.rowsForView(2, 2), [4096, 12_000]);
  assert.deepEqual(selection.rowsForView(5, 2), []);
  assert.equal(selection.hasAny(4097, 12_000), false);
  assert.equal(selection.hasAny(4097, 12_001), true);
  assert.equal(selection.hasAny(5, 4095), false);
});

for (const offsetIndex of [true, false]) {
  test(`filter, view, aggregate and export agree (${offsetIndex ? "with" : "without"} offset index)`, async () => {
    const file = writeFixture(offsetIndex);
    const { summary, metadata } = await openParquetSource(file);
    const query = columns(summary);
    assert.deepEqual(query.map((column) => column.kind), ["integer", "text", "number", "boolean"]);
    const source = { file, metadata };
    const selection = await buildParquetSelection(source, query, {
      conditions: [{ column: 1, operator: "equals", value: "red" }, { column: 2, operator: "gte", value: "1000" }],
      caseSensitive: false,
    }, undefined);
    const expected: number[] = [];
    for (let row = 0; row < ROWS; row++) {
      if (row % 3 === 0 && row % 10 !== 9 && row % 7 !== 0 && row / 4 >= 1000) expected.push(row);
    }
    assert.equal(selection.count, expected.length);
    assert.deepEqual(selection.rowsForView(0, expected.length), expected);

    const context = { metadata, selection, reader: new ParquetViewReader(file, metadata) };
    const view = await readParquetRows(file, summary, 1, 2, [0, 2], 80, context);
    assert.deepEqual(view, expected.slice(1, 3).map((row) => [String(9007199254740000n + BigInt(row)), String(row / 4)]));

    const grouped = await aggregateParquet(source, query, null, { groupColumn: 1, valueColumn: 0, order: "count" }, undefined);
    assert.deepEqual(grouped.columns.slice(0, 2), ["team", "count"]);
    assert.deepEqual(grouped.rows.map((row) => [row[0], row[1]]), [["Green", 3000n], ["Red", 3000n], ["blue", 3000n], [null, 1000n]]);
    const redIds = Array.from({ length: ROWS }, (_, row) => row).filter((row) => row % 3 === 0 && row % 10 !== 9);
    assert.equal(grouped.rows[1][3], redIds.reduce((sum, row) => sum + 9007199254740000n + BigInt(row), 0n));

    const filtered = await aggregateParquet(source, query, selection, { groupColumn: null, valueColumn: null, order: "key" }, undefined);
    assert.deepEqual(filtered.rows, [[BigInt(expected.length)]]);

    const rows = await exportParquet(file, summary, { columns: [0], format: "csv", includeHeader: true, protectFormulas: true, bom: false }, undefined, context);
    assert.equal(rows.rowCount, expected.length);
    const lines = new TextDecoder().decode(rows.bytes).trimEnd().split("\n");
    assert.equal(lines[0], "id");
    assert.equal(lines[1], String(9007199254740000n + BigInt(expected[0])));

    const groups = await exportParquet(file, summary, { source: "groups", columns: [], format: "jsonl", includeHeader: false, protectFormulas: true, bom: false },
      undefined, { ...context, aggregate: grouped });
    const first = new TextDecoder().decode(groups.bytes).split("\n")[0];
    assert.ok(first.startsWith(`{"team":"Green","count":3000,`), first);
    assert.equal(parquetMetadata(file).row_groups.length, 4);
  });
}
