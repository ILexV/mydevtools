import assert from "node:assert/strict";
import test from "node:test";
import {
  ArchiveError,
  TarReader,
  checkBombRatio,
  crc32,
  detectArchive,
  innerStreamName,
  readZipDirectory,
  sanitizeEntryPath,
  tarEnd,
  tarHeader,
  tarPadding,
  uniquePath,
  zipCentralHeader,
  zipDataDescriptor,
  zipDataStart,
  zipEnd,
  zipLocalHeader,
  type ArchiveEntry,
  type ZipWriteEntry,
} from "../src/tools/archive-format.ts";

const encoder = new TextEncoder();
const reader = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.subarray(offset, offset + length);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A stored ZIP written with the tool's own writer. */
function storedZip(files: readonly [string, string][], prefix = new Uint8Array(0), forceZip64 = false): Uint8Array {
  const parts: Uint8Array[] = [prefix];
  const central: Uint8Array[] = [];
  let offset = prefix.length;
  for (const [name, body] of files) {
    const data = encoder.encode(body);
    const entry: ZipWriteEntry = {
      name: encoder.encode(name), mtime: Date.UTC(2026, 9, 23, 6, 0, 0), method: 0, zip64: forceZip64,
      offset: offset - prefix.length, crc: crc32(data), packed: data.length, size: data.length,
    };
    for (const part of [zipLocalHeader(entry), data, zipDataDescriptor(entry)]) { parts.push(part); offset += part.length; }
    central.push(zipCentralHeader(entry));
  }
  const dirOffset = offset - prefix.length;
  const dir = concat(central);
  parts.push(dir, zipEnd(central.length, dirOffset, dir.length));
  return concat(parts);
}

async function tarEntries(bytes: Uint8Array, chunk: number, wanted = false) {
  const entries: ArchiveEntry[] = [];
  const data = new Map<number, string>();
  const ended: number[] = [];
  const tar = new TarReader({
    entry(item, index) { entries.push(item); data.set(index, ""); return wanted; },
    data(part, index) { data.set(index, data.get(index) + new TextDecoder().decode(part)); },
    end(index) { ended.push(index); },
  });
  for (let i = 0; i < bytes.length; i += chunk) await tar.push(bytes.subarray(i, i + chunk));
  tar.finish();
  return { entries, data, ended, tar };
}

test("archive paths: traversal, absolute and control names are unsafe; Windows-hostile names are renamed", () => {
  assert.deepEqual(sanitizeEntryPath("docs/readme.md"), { path: "docs/readme.md", issue: null });
  assert.deepEqual(sanitizeEntryPath("./a//b/./c.txt"), { path: "a/b/c.txt", issue: null });
  assert.equal(sanitizeEntryPath("../evil.sh").issue, "traversal");
  assert.equal(sanitizeEntryPath("a/../../etc/passwd").issue, "traversal");
  assert.equal(sanitizeEntryPath("a\\..\\..\\win.ini").issue, "traversal");
  assert.equal(sanitizeEntryPath("/etc/passwd").issue, "absolute");
  assert.equal(sanitizeEntryPath("C:\\Windows\\system.ini").issue, "absolute");
  assert.equal(sanitizeEntryPath("c:relative").issue, "absolute");
  assert.equal(sanitizeEntryPath("\\\\server\\share\\x").issue, "absolute");
  assert.equal(sanitizeEntryPath("bad\u0000name").issue, "control");
  assert.equal(sanitizeEntryPath("line\nbreak").issue, "control");
  assert.equal(sanitizeEntryPath("").issue, "empty");
  assert.equal(sanitizeEntryPath(`${"x".repeat(256)}.txt`).issue, "too-long");
  assert.equal(sanitizeEntryPath(Array.from({ length: 65 }, () => "d").join("/")).issue, "too-long");
  assert.deepEqual(sanitizeEntryPath("q<1>?.txt"), { path: "q_1__.txt", issue: "renamed" });
  assert.deepEqual(sanitizeEntryPath("dir/CON.txt"), { path: "dir/_CON.txt", issue: "renamed" });
  assert.deepEqual(sanitizeEntryPath("trailing. /x"), { path: "trailing/x", issue: "renamed" });
  assert.deepEqual(sanitizeEntryPath("Привет/мир.txt"), { path: "Привет/мир.txt", issue: null });
});

test("archive paths: duplicates get a numbered name, case-insensitively", () => {
  const used = new Set<string>();
  assert.equal(uniquePath("a/Report.txt", used), "a/Report.txt");
  assert.equal(uniquePath("a/report.TXT", used), "a/report (2).TXT");
  assert.equal(uniquePath("a/Report.txt", used), "a/Report (3).txt");
  assert.equal(uniquePath("noext", used), "noext");
  assert.equal(uniquePath("noext", used), "noext (2)");
});

test("archive detection: magic numbers, TAR checksum and extensions", () => {
  const block = tarHeader("a.txt", 3, 0).subarray(0, 512);
  assert.deepEqual(detectArchive(encoder.encode("PK\u0003\u0004rest"), "x.bin"), { kind: "zip" });
  assert.deepEqual(detectArchive(new Uint8Array([0x1f, 0x8b, 8, 0]), "x"), { kind: "stream", codec: "gzip" });
  assert.deepEqual(detectArchive(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]), "x"), { kind: "stream", codec: "zstd" });
  assert.deepEqual(detectArchive(block, "x"), { kind: "tar" });
  assert.deepEqual(detectArchive(encoder.encode("BZh91AY"), "x.bz2"), { kind: "unsupported", format: "bzip2" });
  assert.deepEqual(detectArchive(encoder.encode("Rar!\u001a\u0007\u0000"), "x.rar"), { kind: "unsupported", format: "RAR" });
  assert.deepEqual(detectArchive(encoder.encode("brotli??"), "page.js.br"), { kind: "stream", codec: "brotli" });
  assert.deepEqual(detectArchive(encoder.encode("MZ stub"), "setup.exe"), { kind: "zip" });
  assert.deepEqual(detectArchive(encoder.encode("plain text"), "notes.txt"), { kind: "unsupported", format: "" });
  assert.equal(innerStreamName("logs.tgz", "gzip"), "logs.tar");
  assert.equal(innerStreamName("data.json.gz", "gzip"), "data.json");
  assert.equal(innerStreamName("dump.sql.zst", "zstd"), "dump.sql");
  assert.equal(innerStreamName("app.js.br", "brotli"), "app.js");
  assert.equal(innerStreamName("weird", "gzip"), "weird.out");
});

test("zip: the writer's archive lists back with names, sizes, CRCs and data offsets", async () => {
  const zip = storedZip([["a.txt", "hello\n"], ["папка/кот.txt", "unicode\n"], ["dir/", ""]]);
  const { entries, zip64 } = await readZipDirectory(zip.length, reader(zip));
  assert.equal(zip64, false);
  assert.deepEqual(entries.map((e) => [e.name, e.kind, e.size, e.packed, e.method, e.encrypted, e.overlap]), [
    ["a.txt", "file", 6, 6, 0, false, false],
    ["папка/кот.txt", "file", 8, 8, 0, false, false],
    ["dir/", "dir", 0, 0, 0, false, false],
  ]);
  assert.equal(entries[0].crc, crc32(encoder.encode("hello\n")));
  const start = await zipDataStart(entries[1], reader(zip));
  assert.equal(new TextDecoder().decode(zip.subarray(start, start + 8)), "unicode\n");
});

test("zip: a self-extracting stub before the archive shifts every offset", async () => {
  const stub = encoder.encode("MZ".padEnd(1000, "\u0000"));
  const zip = storedZip([["a.txt", "abc"], ["b.txt", "defg"]], stub);
  const { entries } = await readZipDirectory(zip.length, reader(zip));
  const start = await zipDataStart(entries[1], reader(zip));
  assert.equal(new TextDecoder().decode(zip.subarray(start, start + 4)), "defg");
});

test("zip: ZIP64 records for many entries and forced ZIP64 entries", async () => {
  const files = Array.from({ length: 70_000 }, (_, i) => [`f/${i}.txt`, i % 1000 === 0 ? "x" : ""] as [string, string]);
  const zip = storedZip(files, new Uint8Array(0), true);
  const { entries, zip64 } = await readZipDirectory(zip.length, reader(zip));
  assert.equal(zip64, true);
  assert.equal(entries.length, 70_000);
  assert.equal(entries[69_999].name, "f/69999.txt");
  assert.equal(entries[1000].size, 1);
  const start = await zipDataStart(entries[1000], reader(zip));
  assert.equal(zip[start], 0x78);
});

test("zip: entries sharing one local header are flagged as overlapping and refused", async () => {
  const zip = storedZip([["a.txt", "aaaa"], ["b.txt", "bbbb"]]);
  const { entries } = await readZipDirectory(zip.length, reader(zip));
  // Rewrite b's central offset to point at a's local header, the overlapping-bomb trick.
  const dirStart = zip.length - 22 - entries.reduce((sum, e) => sum + 46 + encoder.encode(e.name).length, 0);
  const view = new DataView(zip.buffer, zip.byteOffset);
  const second = dirStart + 46 + encoder.encode("a.txt").length;
  view.setUint32(second + 42, 0, true);
  const again = await readZipDirectory(zip.length, reader(zip));
  assert.equal(again.entries[0].overlap, true);
  assert.equal(again.entries[1].overlap, true);
  await assert.rejects(zipDataStart(again.entries[1], reader(zip)), (error: unknown) => error instanceof ArchiveError && error.code === "overlap");
});

test("zip: a damaged end record or a cut directory is reported", async () => {
  await assert.rejects(readZipDirectory(10, reader(encoder.encode("not an zip"))), (error: unknown) => error instanceof ArchiveError && error.code === "corrupt");
  const zip = storedZip([["a.txt", "abc"]]);
  const cut = zip.subarray(30);
  await assert.rejects(readZipDirectory(cut.length, reader(cut)), (error: unknown) => error instanceof ArchiveError);
});

test("tar: writer output reads back with long, nested and Unicode names in any chunking", async () => {
  const files: [string, string][] = [
    ["a.txt", "hello\n"],
    [`dir/${"q".repeat(120)}.txt`, "long name\n"],
    ["Ünï/кот.txt", "unicode\n"],
    [`${"x/".repeat(60)}f`, "deep\n"],
    [`${"p".repeat(90)}/${"n".repeat(90)}`, "prefix split\n"],
    ["empty.bin", ""],
  ];
  const parts: Uint8Array[] = [];
  let written = 0;
  for (const [name, body] of files) {
    const data = encoder.encode(body);
    for (const part of [tarHeader(name, data.length, Date.UTC(2026, 0, 2)), data, tarPadding(data.length)]) { parts.push(part); written += part.length; }
  }
  parts.push(tarEnd(written));
  const tar = concat(parts);
  assert.equal(tar.length % 10240, 0);
  for (const chunk of [1, 511, 512, 4096, tar.length]) {
    const { entries, data, ended, tar: reader } = await tarEntries(tar, chunk, true);
    assert.deepEqual(entries.map((e) => e.name), files.map(([name]) => name));
    assert.deepEqual([...data.values()], files.map(([, body]) => body));
    assert.deepEqual(ended, files.map((_, i) => i));
    assert.equal(entries[0].mtime, Date.UTC(2026, 0, 2));
    assert.equal(reader.ended, true);
  }
});

test("tar: GNU long names, links, base-256 sizes and a bad checksum", async () => {
  const block = (name: string, type: string, size: number, link = "") => {
    const header = tarHeader(name, size, 0).slice(0, 512);
    header[156] = type.charCodeAt(0);
    header.set(encoder.encode(link), 157);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\u0000 `), 148);
    return header;
  };
  const longName = `${"L".repeat(150)}.txt`;
  const longData = encoder.encode(`${longName}\u0000`);
  const tar = concat([
    block("././@LongLink", "L", longData.length), longData, tarPadding(longData.length),
    block("ignored", "0", 2), encoder.encode("hi"), tarPadding(2),
    block("link", "2", 0, "target.txt"),
    block("hard", "1", 0, "a.txt"),
    new Uint8Array(1024),
  ]);
  const { entries, data } = await tarEntries(tar, 100, true);
  assert.deepEqual(entries.map((e) => [e.name, e.kind, e.link]), [[longName, "file", ""], ["link", "symlink", "target.txt"], ["hard", "hardlink", "a.txt"]]);
  assert.equal(data.get(0), "hi");

  const big = tarHeader("huge.bin", 9 * 1024 ** 3, 0);
  const { entries: bigEntries } = await tarEntries(concat([big, new Uint8Array(0)]), 512).catch(() => ({ entries: [] as ArchiveEntry[] }));
  // The data is missing, so finish() throws; parse the headers alone instead.
  const headers: ArchiveEntry[] = [];
  const reader = new TarReader({ entry(item) { headers.push(item); return false; } });
  await reader.push(big);
  assert.equal(headers[0].size, 9 * 1024 ** 3);
  assert.equal(bigEntries.length, 0);
  assert.throws(() => reader.finish(), (error: unknown) => error instanceof ArchiveError && error.code === "truncated");

  const broken = tarHeader("a.txt", 0, 0).slice(0, 512);
  broken[0] = 0x62;
  await assert.rejects(new TarReader({ entry: () => false }).push(broken), (error: unknown) => error instanceof ArchiveError && error.code === "corrupt");
});

test("archive limits: the bomb ratio applies only past the minimum output", () => {
  assert.doesNotThrow(() => checkBombRatio(60 * 1024 * 1024, 1));
  assert.doesNotThrow(() => checkBombRatio(100 * 1024 * 1024, 1024 * 1024));
  assert.throws(() => checkBombRatio(100 * 1024 * 1024, 1024), (error: unknown) => error instanceof ArchiveError && error.code === "bomb");
  assert.throws(() => checkBombRatio(65 * 1024 ** 3, 64 * 1024 ** 3), (error: unknown) => error instanceof ArchiveError && error.code === "too-large");
});
