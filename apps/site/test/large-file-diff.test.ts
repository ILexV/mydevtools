import assert from "node:assert/strict";
import test from "node:test";
import {
  DiffLayout,
  DiffRowKind,
  FILE_DIFF_CHUNK_BYTES,
  FILE_DIFF_CHECKPOINT_LINES,
  LineCursor,
  compareBinary,
  diffLineHashes,
  formatHunkHeader,
  indexLines,
  looksBinary,
  resolveEncoding,
  type FileDiffTextOptions,
  type LineIndex,
} from "../src/tools/large-file-diff.ts";

const encoder = new TextEncoder();
const reader = (bytes: Uint8Array) => async (start: number, end: number) => bytes.subarray(start, end);
const options = (overrides: Partial<FileDiffTextOptions> = {}): FileDiffTextOptions => ({ encoding: "auto", whitespace: "exact", ignoreEol: true, ...overrides });
const index = (bytes: Uint8Array, settings = options()) => indexLines(bytes.length, reader(bytes), settings);
const text = (value: string) => encoder.encode(value);
const sameLine = (a: LineIndex, i: number, b: LineIndex, j: number) => a.h1[i] === b.h1[j] && a.h2[i] === b.h2[j];

function utf16le(value: string, bom = true): Uint8Array {
  const out = new Uint8Array((bom ? 2 : 0) + value.length * 2);
  if (bom) out.set([0xff, 0xfe]);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out[(bom ? 2 : 0) + i * 2] = code & 0xff;
    out[(bom ? 2 : 0) + i * 2 + 1] = code >> 8;
  }
  return out;
}

test("encodings resolve from the BOM and binary data is detected by NUL bytes", () => {
  assert.deepEqual(resolveEncoding("auto", new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), { label: "utf-8", kind: "utf-8", bomLength: 3 });
  assert.deepEqual(resolveEncoding("auto", new Uint8Array([0xfe, 0xff, 0, 0x41])), { label: "utf-16be", kind: "utf-16be", bomLength: 2 });
  assert.equal(resolveEncoding("windows-1251", new Uint8Array([0xc0])).kind, "bytes");
  assert.throws(() => resolveEncoding("klingon", new Uint8Array(0)), /Unsupported encoding/);
  assert.equal(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.equal(looksBinary(utf16le("ab")), false);
  assert.equal(looksBinary(text("plain text")), false);
});

test("line hashes follow whitespace and line-ending options", async () => {
  const lf = await index(text("a\n  b c \nlast"));
  assert.equal(lf.lines, 3);
  assert.equal(lf.finalNewline, false);
  const crlf = await index(text("a\r\n  b c \r\nlast\n"));
  assert.equal(crlf.crlf, 2);
  assert.ok([0, 1, 2].every((line) => sameLine(lf, line, crlf, line)), "CRLF and a missing final newline are ignored");
  const strict = options({ ignoreEol: false });
  const lfStrict = await index(text("a\n  b c \nlast"), strict);
  const crlfStrict = await index(text("a\r\n  b c \r\nlast\n"), strict);
  assert.ok(!sameLine(lfStrict, 0, crlfStrict, 0));
  assert.ok(!sameLine(lfStrict, 2, crlfStrict, 2), "a missing final newline counts");

  const variants = text("  b c \n b   c\nb c\nbc\n\tb c\n");
  const exact = await index(variants);
  assert.ok(!sameLine(exact, 0, exact, 2));
  const trailing = await index(variants, options({ whitespace: "trailing" }));
  assert.ok(sameLine(trailing, 0, trailing, 0) && !sameLine(trailing, 0, trailing, 2));
  assert.ok(sameLine(trailing, 0, await index(text("  b c\n")), 0), "only trailing spaces are dropped");
  const change = await index(variants, options({ whitespace: "change" }));
  assert.ok(sameLine(change, 0, change, 1) && sameLine(change, 1, change, 2) && sameLine(change, 2, change, 4));
  assert.ok(!sameLine(change, 2, change, 3));
  const all = await index(variants, options({ whitespace: "all" }));
  assert.ok([1, 2, 3, 4].every((line) => sameLine(all, 0, all, line)));

  assert.equal((await index(new Uint8Array(0))).lines, 0);
  const blank = await index(text("\n\n"));
  assert.equal(blank.lines, 2);
  assert.equal(blank.finalNewline, true);
});

test("UTF-8 and UTF-16 hash the same text alike, across chunk boundaries", async () => {
  const line = "Привет, мир — 🙂\n";
  const repeat = Math.ceil((FILE_DIFF_CHUNK_BYTES + 100) / encoder.encode(line).length);
  const value = line.repeat(repeat);
  const utf8 = await index(text(value));
  const utf16 = await index(utf16le(value));
  assert.equal(utf8.lines, repeat);
  assert.equal(utf16.lines, repeat);
  for (let i = 0; i < repeat; i++) assert.ok(sameLine(utf8, i, utf16, i), `line ${i}`);
  const bom = await index(new Uint8Array([0xef, 0xbb, 0xbf, ...text("Привет, мир — 🙂\n")]));
  assert.ok(sameLine(bom, 0, utf8, 0), "the BOM is not part of the first line");
  const broken = await index(new Uint8Array([0x61, 0xd0, 0x0a, 0x61, 0x0a]));
  assert.equal(broken.lines, 2);
  assert.ok(!sameLine(broken, 0, broken, 1), "a cut UTF-8 sequence is not dropped");
});

/** Minimal edit distance (lines removed + added) by dynamic programming. */
function lcsDistance(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return a.length + b.length - 2 * row[b.length];
}

/** Apply the regions to A and check the result equals B line by line. */
function applyRegions(a: readonly string[], b: readonly string[], regions: ReturnType<typeof diffLineHashes>["regions"]): string[] {
  const out: string[] = [];
  let ai = 0;
  for (let r = 0; r < regions.count; r++) {
    assert.ok(regions.aStart[r] >= ai, "regions are ordered");
    while (ai < regions.aStart[r]) out.push(a[ai++]);
    for (let j = regions.bStart[r]; j < regions.bEnd[r]; j++) out.push(b[j]);
    ai = regions.aEnd[r];
  }
  while (ai < a.length) out.push(a[ai++]);
  return out;
}

async function diffLines(a: string[], b: string[]) {
  const join = (lines: string[]) => text(lines.map((line) => `${line}\n`).join(""));
  const [left, right] = await Promise.all([index(join(a)), index(join(b))]);
  return { left, right, result: diffLineHashes(left, right) };
}

test("the line diff is a valid and minimal edit on random inputs", async () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let round = 0; round < 200; round++) {
    const alphabet = 2 + Math.floor(random() * 6);
    const a = Array.from({ length: Math.floor(random() * 40) }, () => `l${Math.floor(random() * alphabet)}`);
    const b = Array.from({ length: Math.floor(random() * 40) }, () => `l${Math.floor(random() * alphabet)}`);
    const { result } = await diffLines(a, b);
    assert.deepEqual(applyRegions(a, b, result.regions), b, `round ${round}`);
    assert.equal(result.removed + result.added, lcsDistance(a, b), `round ${round} is minimal`);
    assert.equal(result.approximate, false);
  }
});

test("patience anchors keep a large file's few edits exact", async () => {
  const a = Array.from({ length: 60_000 }, (_, i) => `row ${i}`);
  const b = a.slice();
  b.splice(100, 1, "changed 100");
  b.splice(30_000, 0, "inserted", "inserted");
  b.splice(50_000, 3);
  b.push("tail");
  // Repeated lines exercise the non-unique path inside the gaps.
  for (let i = 0; i < 10; i++) b.splice(40_000, 0, "same");
  const { result } = await diffLines(a, b);
  assert.deepEqual(applyRegions(a, b, result.regions), b);
  assert.equal(result.removed, 1 + 3);
  assert.equal(result.added, 1 + 2 + 10 + 1);
  assert.equal(result.regions.count, 5);
});

test("layout produces unified-diff rows and headers", async () => {
  const a = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
  const b = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  const { result } = await diffLines(a, b);
  const layout = new DiffLayout(result.regions, a.length, b.length, 2);
  assert.equal(layout.hunks, 2);
  assert.equal(formatHunkHeader(layout.header(0)), "@@ -1,4 +1,4 @@");
  assert.equal(formatHunkHeader(layout.header(1)), "@@ -10,2 +10,3 @@");
  const render = Array.from({ length: layout.rows }, (_, row) => {
    const item = layout.row(row);
    if (item.kind === DiffRowKind.Header) return formatHunkHeader(layout.header(item.hunk));
    if (item.kind === DiffRowKind.Removed) return `-${a[item.a]}`;
    if (item.kind === DiffRowKind.Added) return `+${b[item.b]}`;
    assert.equal(a[item.a], b[item.b]);
    return ` ${a[item.a]}`;
  });
  assert.deepEqual(render, ["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d", "@@ -10,2 +10,3 @@", " j", " k", "+l"]);
  assert.equal(layout.hunkOfRow(7), 1);
  assert.equal(layout.hunkStartRow(1), 6);

  const merged = new DiffLayout(result.regions, a.length, b.length, 5);
  assert.equal(merged.hunks, 1);
  assert.equal(formatHunkHeader(merged.header(0)), "@@ -1,11 +1,12 @@");
  const empty = await diffLines([], ["x"]);
  assert.equal(formatHunkHeader(new DiffLayout(empty.result.regions, 0, 1, 3).header(0)), "@@ -0,0 +1 @@");
});

test("the cursor reads lines after seeks across checkpoints, CRLF and UTF-16", async () => {
  const lines = Array.from({ length: FILE_DIFF_CHECKPOINT_LINES * 3 + 5 }, (_, i) => `line ${i}${i % 7 === 0 ? "\r" : ""}`);
  const bytes = text(`${lines.join("\n")}`);
  const lineIndex = await index(bytes);
  const cursor = new LineCursor(lineIndex, reader(bytes), 97);
  const decoder = new TextDecoder();
  for (const target of [700, 3, 3, 512, 260, lines.length - 1]) {
    await cursor.seek(target);
    const line = await cursor.next(1000);
    assert.equal(decoder.decode(line!.bytes), lines[target], `line ${target}`);
  }
  assert.equal(await cursor.next(1000), null);
  await cursor.seek(10);
  const clipped = await cursor.next(3);
  assert.deepEqual([decoder.decode(clipped!.bytes), clipped!.truncated], ["lin", true]);
  assert.equal(decoder.decode((await cursor.next(100))!.bytes), "line 11");

  const wide = utf16le("first\nсекунда\nthird");
  const wideIndex = await index(wide);
  const wideCursor = new LineCursor(wideIndex, reader(wide), 5);
  const utf16 = new TextDecoder("utf-16le");
  await wideCursor.seek(1);
  assert.equal(utf16.decode((await wideCursor.next(100))!.bytes), "секунда");
  assert.equal(utf16.decode((await wideCursor.next(100))!.bytes), "third");
  const many = Array.from({ length: 600 }, (_, i) => `строка ${i}`);
  const manyBytes = utf16le(many.join("\n"));
  const manyIndex = await index(manyBytes);
  const manyCursor = new LineCursor(manyIndex, reader(manyBytes), 333);
  for (const target of [520, 257, 599]) {
    await manyCursor.seek(target);
    assert.equal(utf16.decode((await manyCursor.next(100))!.bytes), many[target], `UTF-16 line ${target}`);
  }
});

test("binary comparison lists ranges, the longer tail and stops keeping at the cap", async () => {
  const a = new Uint8Array(FILE_DIFF_CHUNK_BYTES + 10);
  const b = a.slice();
  b[5] = 1; b[6] = 1; b[9] = 1;
  b[FILE_DIFF_CHUNK_BYTES - 1] = 1; b[FILE_DIFF_CHUNK_BYTES] = 1; // one range across the block edge
  const longer = new Uint8Array(b.length + 4);
  longer.set(b);
  const result = await compareBinary(a.length, longer.length, reader(a), reader(longer));
  assert.deepEqual([...result.offsets], [5, 9, FILE_DIFF_CHUNK_BYTES - 1, a.length]);
  assert.deepEqual([...result.lengths], [2, 1, 2, 4]);
  assert.equal(result.differingBytes, 5 + 4);
  assert.equal(result.firstDifference, 5);
  assert.equal(result.identical, false);
  const same = await compareBinary(a.length, a.length, reader(a), reader(a.slice()));
  assert.equal(same.identical, true);
  assert.equal(same.firstDifference, -1);
  const capped = await compareBinary(a.length, longer.length, reader(a), reader(longer), undefined, 2);
  assert.equal(capped.rangeCount, 4);
  assert.equal(capped.offsets.length, 2);
});
