/**
 * Hex viewer pure helpers: dump rows, offset and needle parsing, search across
 * a chunk boundary, Shannon entropy and the export range cap.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_BYTES_PER_ROW,
  HEX_ENTROPY_BLOCK_BYTES,
  HEX_ENTROPY_MAX_BLOCKS,
  HEX_EXPORT_MAX_BYTES,
  HEX_MAX_NEEDLE_BYTES,
  HexViewerError,
  describeProbe,
  entropyBlocks,
  entropyIsSampled,
  formatAscii,
  formatHexBytes,
  formatHexRows,
  formatUtf8,
  hexRowCount,
  parseExportRange,
  parseNeedle,
  parseOffset,
  scanEntropy,
  searchBytes,
  shannonEntropy,
} from "../src/tools/hex-viewer.ts";

function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function reader(data: Uint8Array): (start: number, end: number) => Uint8Array {
  return (start, end) => data.subarray(start, end);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HexViewerError);
    return error.code;
  }
  assert.fail("expected HexViewerError");
}

test("hex rows: 16-byte grouping, ASCII dots and split UTF-8", () => {
  assert.equal(hexRowCount(0), 0);
  assert.equal(hexRowCount(1), 1);
  assert.equal(hexRowCount(HEX_BYTES_PER_ROW), 1);
  assert.equal(hexRowCount(HEX_BYTES_PER_ROW + 1), 2);

  const row = bytes([0x00, 0x41, 0x0a, 0xff, 0x20, 0x7e, 0x7f, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a]);
  assert.equal(
    formatHexBytes(row),
    "00 41 0a ff 20 7e 7f 42  43 44 45 46 47 48 49 4a",
  );
  assert.equal(formatAscii(row), ".A.. ~.BCDEFGHIJ");
  assert.equal(formatAscii(bytes([0x41, 0x00, 0x7e])), "A.~");
  assert.equal(formatHexBytes(bytes([0x0a, 0xff])).trimEnd(), "0a ff");

  const emoji = bytes([0x41, 0xf0, 0x9f, 0x98, 0x80]);
  assert.equal(formatUtf8(emoji), "A😀");
  assert.equal(formatUtf8(bytes([0xf0, 0x9f])), "..");
  assert.equal(formatUtf8(bytes([0xd0, 0xaf])), "Я");
  assert.equal(formatAscii(bytes([0xd0, 0xaf])), "..");

  const rows = formatHexRows(emoji, 2, 256);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], "00000020");
  assert.equal(rows[0][2], "A....");
  assert.equal(rows[0][3], "A😀");
});

test("parseOffset accepts decimal and 0x hex inside the file", () => {
  assert.equal(parseOffset("0", 10), 0);
  assert.equal(parseOffset(" 15 ", 16), 15);
  assert.equal(parseOffset("0x1a", 32), 26);
  assert.equal(parseOffset("0X0F", 16), 15);
  assert.equal(codeOf(() => parseOffset("", 10)), "invalid-offset");
  assert.equal(codeOf(() => parseOffset("nope", 10)), "invalid-offset");
  assert.equal(codeOf(() => parseOffset("-1", 10)), "invalid-offset");
  assert.equal(codeOf(() => parseOffset("10", 10)), "invalid-offset");
  assert.equal(codeOf(() => parseOffset("0", 0)), "invalid-offset");
  assert.equal(codeOf(() => parseOffset("0x", 10)), "invalid-offset");
});

test("parseNeedle: text UTF-8, hex separators and the length cap", () => {
  assert.deepEqual([...parseNeedle("A", "text")], [0x41]);
  assert.deepEqual([...parseNeedle("Я", "text")], [0xd0, 0xaf]);
  assert.deepEqual([...parseNeedle("0a ff", "hex")], [0x0a, 0xff]);
  assert.deepEqual([...parseNeedle("0x0aff", "hex")], [0x0a, 0xff]);
  assert.deepEqual([...parseNeedle("aa:bb-cc", "hex")], [0xaa, 0xbb, 0xcc]);
  assert.equal(codeOf(() => parseNeedle("", "text")), "invalid-needle");
  assert.equal(codeOf(() => parseNeedle("abc", "hex")), "invalid-needle");
  assert.equal(codeOf(() => parseNeedle("zz", "hex")), "invalid-needle");
  assert.equal(codeOf(() => parseNeedle("A".repeat(HEX_MAX_NEEDLE_BYTES + 1), "text")), "needle-too-long");
  assert.equal(parseNeedle("aa".repeat(HEX_MAX_NEEDLE_BYTES), "hex").length, HEX_MAX_NEEDLE_BYTES);
});

test("searchBytes finds a needle that crosses a chunk boundary once", async () => {
  const data = new Uint8Array(24);
  data.set([1, 2, 3, 4], 0);
  data.set([1, 2, 3, 4], 6);
  data.set([1, 2, 3, 4], 14);
  const hit = await searchBytes(data.length, bytes([1, 2, 3, 4]), reader(data), { chunkBytes: 8 });
  assert.deepEqual(hit.offsets, [0, 6, 14]);
  assert.equal(hit.capped, false);

  const overlapping = await searchBytes(4, bytes([0xaa, 0xaa]), reader(bytes([0xaa, 0xaa, 0xaa, 0xaa])), { chunkBytes: 3 });
  assert.deepEqual(overlapping.offsets, [0, 1, 2]);

  const zeros = bytes(Array.from({ length: 10 }, () => 0));
  const capped = await searchBytes(zeros.length, bytes([0]), reader(zeros), { chunkBytes: 4, maxMatches: 3 });
  assert.deepEqual(capped.offsets, [0, 1, 2]);
  assert.equal(capped.capped, true);

  const absent = await searchBytes(data.length, bytes([7, 7, 7]), reader(data), { chunkBytes: 8 });
  assert.deepEqual(absent.offsets, []);
  assert.equal(absent.capped, false);
});

test("entropy is 0 for zeros, 8 for a uniform byte, and samples large files", async () => {
  assert.equal(shannonEntropy(new Uint8Array(100)), 0);
  const uniform = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.ok(Math.abs(shannonEntropy(uniform) - 8) < 1e-9);

  const zeros = await scanEntropy(100, reader(new Uint8Array(100)));
  assert.equal(zeros.samples.length, 1);
  assert.equal(zeros.average, 0);
  assert.equal(zeros.sampled, false);

  const full = await scanEntropy(uniform.length, reader(uniform));
  assert.ok(Math.abs(full.average - 8) < 1e-9);

  const covered = HEX_ENTROPY_BLOCK_BYTES * HEX_ENTROPY_MAX_BLOCKS;
  assert.equal(entropyIsSampled(covered), false);
  assert.equal(entropyBlocks(covered).length, HEX_ENTROPY_MAX_BLOCKS);
  assert.equal(entropyIsSampled(covered + 1), true);
  const sampled = entropyBlocks(covered + 1);
  assert.equal(sampled.length, HEX_ENTROPY_MAX_BLOCKS);
  assert.equal(sampled[0].start, 0);
  assert.equal(sampled[sampled.length - 1].start + sampled[sampled.length - 1].length, covered + 1);
});

test("describeProbe uses magic bytes, then a text probe, then unknown", () => {
  const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(describeProbe(png).label, "PNG");
  assert.equal(describeProbe(png).kind, "image");
  assert.equal(describeProbe(new TextEncoder().encode("hello")).kind, "text");
  assert.equal(describeProbe(bytes([0xff, 0xfe, 0x00, 0x41])).kind, "unknown");
});

test("export range is inclusive and stops at 256 MiB", () => {
  assert.deepEqual(parseExportRange("0", "0", 4), { start: 0, end: 0 });
  assert.deepEqual(parseExportRange("0x10", "0x1f", 64), { start: 16, end: 31 });
  assert.equal(codeOf(() => parseExportRange("8", "7", 20)), "range-invalid");
  assert.equal(codeOf(() => parseExportRange("0", "20", 20)), "invalid-offset");
  const fileSize = HEX_EXPORT_MAX_BYTES + 2;
  assert.deepEqual(parseExportRange("0", String(HEX_EXPORT_MAX_BYTES - 1), fileSize), {
    start: 0,
    end: HEX_EXPORT_MAX_BYTES - 1,
  });
  assert.equal(codeOf(() => parseExportRange("0", String(HEX_EXPORT_MAX_BYTES), fileSize)), "range-too-large");
});
