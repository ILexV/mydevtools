import assert from "node:assert/strict";
import test from "node:test";
import { parquetReadObjects } from "hyparquet";
import { createCsvParquetStream } from "../src/tools/csv-explorer-parquet.ts";
import { decodeCsvConversionError, encodeCsvConversionError } from "../src/tools/csv-explorer-protocol.ts";
import {
  CsvAggregator,
  CsvConversionError,
  compareCsvTypedValues,
  convertCsvCell,
  convertCsvCellOrThrow,
  csvTypedJson,
  csvTypedText,
  detectCsvColumnType,
} from "../src/tools/csv-explorer-types.ts";

test("cells convert strictly to integer, number and boolean", () => {
  assert.equal(convertCsvCell(" 007 ", "integer"), 7n);
  assert.equal(convertCsvCell("9223372036854775807", "integer"), 9223372036854775807n);
  assert.equal(convertCsvCell("9223372036854775808", "integer"), undefined);
  assert.equal(convertCsvCell("1.5", "integer"), undefined);
  assert.equal(convertCsvCell("", "integer"), null);
  assert.equal(convertCsvCell("  ", "number"), null);
  assert.equal(convertCsvCell("-1.25e2", "number"), -125);
  assert.equal(convertCsvCell(".5", "number"), 0.5);
  assert.equal(convertCsvCell("1e400", "number"), undefined);
  assert.equal(convertCsvCell("1,5", "number"), undefined);
  assert.equal(Object.is(convertCsvCell("-0", "number"), 0), true);
  assert.equal(convertCsvCell("Yes", "boolean"), true);
  assert.equal(convertCsvCell("0", "boolean"), false);
  assert.equal(convertCsvCell("maybe", "boolean"), undefined);
  assert.equal(convertCsvCell("", "text"), "");
  assert.equal(convertCsvCell(" a ", "text"), " a ");
  assert.equal(convertCsvCellOrThrow("x", "integer", "null", 1, 2), null);
  assert.throws(() => convertCsvCellOrThrow("x", "integer", "error", 1, 2), (error: unknown) =>
    error instanceof CsvConversionError && error.column === 1 && error.row === 2 && error.value === "x");
  assert.deepEqual(decodeCsvConversionError(encodeCsvConversionError(3, 41, "abc")), { column: 3, row: 41, value: "abc" });
  assert.equal(decodeCsvConversionError("malformed-csv"), null);
});

test("type detection keeps codes with leading zeros as text", () => {
  assert.equal(detectCsvColumnType(["1", "-20", "", "3"]), "integer");
  assert.equal(detectCsvColumnType(["1", "2.5"]), "number");
  assert.equal(detectCsvColumnType(["007", "8"]), "text");
  assert.equal(detectCsvColumnType(["true", "No"]), "boolean");
  assert.equal(detectCsvColumnType(["0", "1"]), "integer");
  assert.equal(detectCsvColumnType(["", " "]), "text");
  assert.equal(detectCsvColumnType(["a", "1"]), "text");
});

test("typed values compare and serialize exactly", () => {
  assert.ok(compareCsvTypedValues(2n, 10n) < 0);
  assert.ok(compareCsvTypedValues("b", "a") > 0);
  assert.ok(compareCsvTypedValues(false, true) < 0);
  assert.equal(csvTypedJson(9007199254740993n), "9007199254740993");
  assert.equal(csvTypedJson(null), "null");
  assert.equal(csvTypedJson("a\"b"), "\"a\\\"b\"");
  assert.equal(csvTypedText(true), "true");
  assert.equal(csvTypedText(null), "");
});

test("aggregator groups with exact integer sums, null groups last and count order", () => {
  const aggregator = new CsvAggregator({ groupColumn: 0, valueColumn: 1, order: "key" }, "text", "integer");
  for (const [group, value] of [["b", 9007199254740993n], ["a", 1n], ["b", 2n], [null, 5n], ["a", null]] as const) {
    aggregator.add(group, value);
  }
  const result = aggregator.finish("team", "amount");
  assert.deepEqual(result.columns, ["team", "count", "count(amount)", "sum(amount)", "avg(amount)", "min(amount)", "max(amount)"]);
  assert.deepEqual(result.types, ["text", "integer", "integer", "integer", "number", "integer", "integer"]);
  assert.deepEqual(result.rows, [
    ["a", 2n, 1n, 1n, 1, 1n, 1n],
    ["b", 2n, 2n, 9007199254740995n, Number(9007199254740995n) / 2, 2n, 9007199254740993n],
    [null, 1n, 1n, 5n, 5, 5n, 5n],
  ]);

  const byCount = new CsvAggregator({ groupColumn: 0, valueColumn: null, order: "count" }, "text", "text");
  for (const group of ["x", "y", "y", "z", "y", "z"]) byCount.add(group, null);
  assert.deepEqual(byCount.finish("k", null).rows, [["y", 3n], ["z", 2n], ["x", 1n]]);

  const floats = new CsvAggregator({ groupColumn: null, valueColumn: 0, order: "key" }, "text", "number");
  for (let index = 0; index < 10; index++) floats.add(null, 0.1);
  const [total] = floats.finish(null, "v").rows;
  assert.equal(total[2], 1);

  const empty = new CsvAggregator({ groupColumn: null, valueColumn: 0, order: "key" }, "text", "text").finish(null, "v");
  assert.deepEqual(empty.columns, ["count", "count(v)", "min(v)", "max(v)"]);
  assert.deepEqual(empty.rows, [[0n, 0n, null, null]]);
});

test("Parquet stream writes typed nullable columns across row groups", async () => {
  const parts: Uint8Array[] = [];
  const stream = createCsvParquetStream([
    { name: "id", type: "integer" },
    { name: "price", type: "number" },
    { name: "ok", type: "boolean" },
    { name: "name", type: "text" },
  ], async (bytes) => { parts.push(bytes); });
  const total = 70_000;
  for (let index = 0; index < total; index++) {
    stream.add([index === 1 ? null : BigInt(index) + 9007199254740000n, index / 4, index % 3 === 0 ? null : index % 2 === 0, `n${index}`]);
    await stream.flushIfFull();
  }
  await stream.finish();
  assert.ok(parts.length >= 2, "row groups are streamed in several parts");
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const rows = await parquetReadObjects({ file: bytes.buffer });
  assert.equal(rows.length, total);
  assert.deepEqual(rows[0], { id: 9007199254740000n, price: 0, ok: null, name: "n0" });
  assert.deepEqual(rows[1], { id: null, price: 0.25, ok: false, name: "n1" });
  assert.deepEqual(rows[69_999], { id: 9007199254809999n, price: 69_999 / 4, ok: null, name: "n69999" });
  await assert.rejects(async () => {
    const overflow = createCsvParquetStream([{ name: "s", type: "integer" }], async () => {});
    overflow.add([2n ** 64n]);
  }, /value-out-of-range/);
});
