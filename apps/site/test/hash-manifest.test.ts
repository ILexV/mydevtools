import { test } from "node:test";
import assert from "node:assert/strict";
import { algoFromManifestName, algorithmsToSelect, baseName, parseManifest, verifyManifest, type ManifestGroup } from "../src/tools/hash-manifest.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const M = "c".repeat(32);

test("hash-manifest: parses GNU, binary-mode, escaped and BSD lines", () => {
  const text = [
    "# release 1.2.3",
    `${A.toUpperCase()}  app-linux.tar.gz`,
    `${B} *dist/app-windows.zip`,
    `\\${M}  dir\\\\odd\\nname.txt`,
    `SHA512 (app.dmg) = ${"d".repeat(128)}`,
    `BLAKE3 (x.bin) = ${A}`,
    "",
    "garbage line",
  ].join("\r\n");
  const m = parseManifest(text);
  assert.deepEqual(m.invalidLines, [8]);
  assert.deepEqual(m.entries.map((e) => [e.line, e.path, e.hex.length, e.algo]), [
    [2, "app-linux.tar.gz", 64, null],
    [3, "dist/app-windows.zip", 64, null],
    [4, "dir\\odd\nname.txt", 32, null],
    [5, "app.dmg", 128, "sha512"],
    [6, "x.bin", 64, "blake3"],
  ]);
  assert.equal(m.entries[0].hex, A);
});

test("hash-manifest: algorithm from manifest name applies only to matching lengths", () => {
  assert.equal(algoFromManifestName("SHA256SUMS"), "sha256");
  assert.equal(algoFromManifestName("app-1.0.tar.gz.sha512"), "sha512");
  assert.equal(algoFromManifestName("CHECKSUMS.md5"), "md5");
  assert.equal(algoFromManifestName("B3SUMS"), "blake3");
  assert.equal(algoFromManifestName("checksums.txt"), null);
  const m = parseManifest(`${A}  a.bin\n${M}  b.bin`, "SHA256SUMS");
  assert.deepEqual(m.entries.map((e) => e.algo), ["sha256", null]);
});

test("hash-manifest: algorithmsToSelect adds named or common algorithms only when needed", () => {
  const m = parseManifest(`${A}  a.bin\nSHA1 (b.bin) = ${"e".repeat(40)}`);
  assert.deepEqual(algorithmsToSelect(m, ["md5"]), ["sha256", "sha1"]);
  assert.deepEqual(algorithmsToSelect(m, ["blake3", "sha1"]), []);
});

test("hash-manifest: baseName strips directories and ./", () => {
  assert.equal(baseName("./dist/a.zip"), "a.zip");
  assert.equal(baseName("C:\\out\\b.iso"), "b.iso");
  assert.equal(baseName("c.txt"), "c.txt");
});

test("hash-manifest: verifyManifest reports ok, failed, missing, pending, no-algorithm and unlisted", () => {
  const m = parseManifest([
    `${A}  dist/ok.bin`,
    `${A}  bad.bin`,
    `${A}  absent.bin`,
    `${A}  busy.bin`,
    `SHA512 (noalgo.bin) = ${"d".repeat(128)}`,
    `${A}  CASE.BIN`,
  ].join("\n"));
  const done = (name: string, hex: string): ManifestGroup => ({ source: "file", name, status: "done", hashes: [{ id: "md5", hex: M }, { id: "sha256", hex }] });
  const groups: ManifestGroup[] = [
    done("ok.bin", A),
    done("bad.bin", B),
    { source: "file", name: "busy.bin", status: "hashing", hashes: [] },
    done("noalgo.bin", A),
    done("case.bin", A),
    done("extra.bin", A),
  ];
  const r = verifyManifest(m, groups);
  assert.deepEqual(r.rows.map((x) => [x.status, x.groupIndex, x.algo]), [
    ["ok", 0, "sha256"],
    ["failed", 1, "sha256"],
    ["missing", null, null],
    ["pending", 2, null],
    ["no-algorithm", 3, "sha512"],
    ["ok", 4, "sha256"],
  ]);
  assert.deepEqual(r.unlisted, [5]);
  assert.deepEqual(r.counts, { ok: 2, failed: 1, missing: 1, pending: 1, error: 0, "no-algorithm": 1 });
});
