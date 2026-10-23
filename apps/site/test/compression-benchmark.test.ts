import assert from "node:assert/strict";
import test from "node:test";
import {
  LevelListError,
  codecExtension,
  compressionRatio,
  parseLevels,
  resultsCsv,
  savedShare,
  throughput,
  type BenchResult,
} from "../src/tools/compression-benchmark.ts";

test("compression benchmark: level lists accept commas, spaces and ranges within the codec range", () => {
  assert.deepEqual(parseLevels("gzip", "9, 1 6"), [1, 6, 9]);
  assert.deepEqual(parseLevels("zstd", "3-5,19, 4"), [3, 4, 5, 19]);
  assert.deepEqual(parseLevels("brotli", "0–2"), [0, 1, 2]);
  assert.deepEqual(parseLevels("gzip-native", "anything"), [0]);
  for (const [codec, text] of [["gzip", "10"], ["zstd", "0"], ["brotli", "a"], ["gzip", ""], ["zstd", "5-3"], ["zstd", "1-13"]] as const) {
    assert.throws(() => parseLevels(codec, text), (error: unknown) => error instanceof LevelListError && error.codec === codec, `${codec} ${text}`);
  }
});

test("compression benchmark: ratio, saving, throughput and the CSV", () => {
  const result: BenchResult = {
    codec: "zstd", level: 3, inputBytes: 16 * 1024 * 1024, outputBytes: 2 * 1024 * 1024, compressMs: 500,
    decompressMs: 100, compressMemory: 9 * 1024 * 1024, decompressMemory: 1024 * 1024, verified: true,
  };
  assert.equal(compressionRatio(result), 8);
  assert.equal(savedShare(result), 0.875);
  assert.equal(throughput(result.inputBytes, result.compressMs), 32 * 1024 * 1024);
  assert.equal(compressionRatio({ inputBytes: 10, outputBytes: 0 }), 0);
  assert.equal(savedShare({ inputBytes: 10, outputBytes: 12 }) < 0, true);
  assert.equal(codecExtension("brotli"), "br");
  assert.equal(codecExtension("gzip-native"), "gz");
  const native: BenchResult = { ...result, codec: "gzip-native", level: 0, decompressMs: null, compressMemory: null, decompressMemory: null, verified: null };
  const lines = resultsCsv([result, native]).trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "zstd,3,16777216,2097152,8.0000,87.50,500.0,33554432,100.0,167772160,9437184,1048576,true");
  assert.equal(lines[2], "gzip-native,,16777216,2097152,8.0000,87.50,500.0,33554432,,,,,");
});
