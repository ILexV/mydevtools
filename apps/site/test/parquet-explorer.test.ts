import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";
import type { AsyncBuffer } from "hyparquet";
import {
  PARQUET_MAX_COLUMNS,
  formatParquetCell,
  hasParquetMagic,
  parquetJsonValue,
  parquetTypeLabel,
  uniqueColumnLabels,
} from "../src/tools/parquet-explorer.ts";
import { exportParquet, openParquet, readParquetRows } from "../src/tools/parquet-explorer-io.ts";

const BIG_INT = 9007199254740993n;

function sampleColumns() {
  return [
    { name: "name", data: ["Ada", null, "=1+1"], type: "STRING" as const, nullable: true },
    { name: "id", data: [BIG_INT, 1n, 0n], type: "INT64" as const },
    { name: "ok", data: [true, false, true], type: "BOOLEAN" as const },
    { name: "amount", data: [1.5, null, 2], type: "DOUBLE" as const, nullable: true },
    { name: "when", data: [new Date("2020-01-02T03:04:05.000Z"), null, new Date("2024-05-06T07:08:09.000Z")], type: "TIMESTAMP" as const, nullable: true },
    { name: "raw", data: [new Uint8Array([0x0a, 0xff]), null, new Uint8Array([1])], type: "BYTE_ARRAY" as const, nullable: true },
  ];
}

function writeSample(codec: "UNCOMPRESSED" | "SNAPPY" | "GZIP" | "BROTLI") {
  return parquetWriteBuffer({
    columnData: sampleColumns(),
    codec,
    compressors: {
      GZIP: (input: Uint8Array) => gzipSync(input),
      BROTLI: (input: Uint8Array) => brotliCompressSync(input),
    },
    rowGroupSize: 2,
  });
}

test("parquet labels keep logical types and disambiguate duplicate names", () => {
  assert.equal(parquetTypeLabel({ physical: "BYTE_ARRAY", logical: "UTF8" }), "STRING");
  assert.equal(parquetTypeLabel({ physical: "INT64", logical: "TIMESTAMP_MILLIS" }), "TIMESTAMP_MILLIS");
  assert.equal(parquetTypeLabel({ logical: "DECIMAL", precision: 10, scale: 2 }), "DECIMAL(10,2)");
  assert.equal(parquetTypeLabel({ logical: "INTEGER", bitWidth: 64, signed: false }), "UINT64");
  const labels = uniqueColumnLabels(["id", "", "id"]);
  assert.deepEqual(labels.labels, ["id", "Column 2", "id (2)"]);
  assert.equal(labels.duplicateCount, 1);
});

test("parquet cell text keeps int64 spelling, timestamps, nulls and hex", () => {
  assert.equal(formatParquetCell(BIG_INT).text, "9007199254740993");
  assert.equal(formatParquetCell(null).text, "");
  assert.equal(formatParquetCell(false).text, "false");
  assert.equal(formatParquetCell(new Date("2020-01-02T03:04:05.000Z")).text, "2020-01-02T03:04:05.000Z");
  assert.equal(formatParquetCell(new Uint8Array([0x0a, 0xff])).text, "0aff");
  assert.equal(parquetJsonValue(BIG_INT), "9007199254740993");
  assert.equal(parquetJsonValue(null), null);
  const clipped = formatParquetCell("abcdef", 3);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.text, "abc…");
});

test("parquet magic accepts PAR1 at both ends and rejects other bytes", () => {
  const mark = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
  assert.equal(hasParquetMagic(mark, mark), true);
  assert.equal(hasParquetMagic(new Uint8Array([1, 2, 3, 4]), mark), false);
});

for (const codec of ["UNCOMPRESSED", "SNAPPY", "GZIP", "BROTLI"] as const) {
  test(`parquet ${codec} footer exposes schema, row groups and a column window`, async () => {
    const file = writeSample(codec);
    const summary = await openParquet(file);
    assert.equal(summary.rows, 3);
    assert.equal(summary.rowGroupCount, 2);
    assert.equal(summary.rowGroups.length, 2);
    assert.ok(summary.rowGroupBytes > 0);
    assert.equal(summary.columns.map((column) => column.typeLabel).join(","), "STRING,INT64,BOOLEAN,DOUBLE,TIMESTAMP_MILLIS,BYTE_ARRAY");
    assert.equal(summary.columns[0].codecs[0], codec);
    const rows = await readParquetRows(file, summary, 0, 2, [0, 1], 80);
    assert.deepEqual(rows, [
      ["Ada", "9007199254740993"],
      ["", "1"],
    ]);
    const binary = await readParquetRows(file, summary, 0, 1, [5], 80);
    assert.deepEqual(binary, [["0aff"]]);
    const exported = await exportParquet(file, summary, {
      columns: [0, 1],
      format: "jsonl",
      includeHeader: false,
      protectFormulas: true,
      bom: false,
    });
    const first = JSON.parse(new TextDecoder().decode(exported.bytes).split("\n")[0]) as { name: string; id: string };
    assert.equal(first.name, "Ada");
    assert.equal(first.id, "9007199254740993");
    assert.equal(exported.rowCount, 3);
  });
}

test("parquet csv export protects formula cells and stops at the byte cap", async () => {
  const file = writeSample("UNCOMPRESSED");
  const summary = await openParquet(file);
  const exported = await exportParquet(file, summary, {
    columns: [0],
    format: "csv",
    includeHeader: true,
    protectFormulas: true,
    bom: true,
  });
  assert.deepEqual([...exported.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(exported.bytes);
  assert.ok(text.includes("'=1+1"));
  await assert.rejects(
    exportParquet(file, summary, {
      columns: [0, 1, 2, 3, 4, 5],
      format: "csv",
      includeHeader: true,
      protectFormulas: true,
      bom: false,
      maxBytes: 16,
    }),
    (error: unknown) => error instanceof Error && error.message.includes("512") || (error as { code?: string }).code === "export-too-large",
  );
});

test("parquet open rejects an empty buffer, a non-parquet file and too many columns", async () => {
  const empty: AsyncBuffer = { byteLength: 0, slice: () => new ArrayBuffer(0) };
  await assert.rejects(openParquet(empty), (error: { code?: string }) => error.code === "empty");
  await assert.rejects(openParquet(new Uint8Array([1, 2, 3, 4]).buffer), (error: { code?: string }) => error.code === "invalid");
  const wide = parquetWriteBuffer({
    columnData: Array.from({ length: PARQUET_MAX_COLUMNS + 1 }, (_, index) => ({
      name: `c${index}`,
      data: [index],
      type: "INT32" as const,
    })),
    codec: "UNCOMPRESSED",
  });
  await assert.rejects(openParquet(wide), (error: { code?: string }) => error.code === "too-many-columns");
});
