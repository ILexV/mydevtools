import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlans,
  chunkPositions,
  displayRotation,
  initialPages,
  isUnchanged,
  outputNames,
  paperName,
  parseRanges,
  rotatePage,
  storedZip,
} from "../src/tools/pdf-organizer.ts";

test("pdf-organizer: rotation wraps in both directions", () => {
  const p = initialPages(1)[0];
  assert.equal(rotatePage(p, -90).rotate, 270);
  assert.equal(rotatePage(rotatePage(p, 90), 270).rotate, 0);
  assert.equal(displayRotation(270, rotatePage(p, 180)), 90);
});

test("pdf-organizer: parseRanges handles lists, open ends, reverse ranges and dashes", () => {
  assert.deepEqual(parseRanges("1-3, 5; 8-", 9), { ok: true, groups: [[0, 1, 2], [4], [7, 8]] });
  assert.deepEqual(parseRanges("-2\n3 – 1", 4), { ok: true, groups: [[0, 1], [2, 1, 0]] });
  assert.deepEqual(parseRanges("2—2", 3), { ok: true, groups: [[1]] });
  assert.deepEqual(parseRanges("1-3, 9", 5), { ok: false, token: "9" });
  assert.deepEqual(parseRanges("0", 5), { ok: false, token: "0" });
  assert.deepEqual(parseRanges("a-b", 5), { ok: false, token: "a-b" });
  assert.deepEqual(parseRanges("-", 5), { ok: false, token: "-" });
  assert.equal(parseRanges("  ", 5).ok, false);
});

test("pdf-organizer: chunkPositions splits every N pages", () => {
  assert.deepEqual(chunkPositions(5, 2), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(chunkPositions(3, 0), [[0], [1], [2]]);
});

test("pdf-organizer: buildPlans maps edited positions to source pages", () => {
  const pages = [{ source: 2, rotate: 90 }, { source: 0, rotate: 0 }];
  assert.deepEqual(buildPlans(pages, [[1, 0]]), [[{ page: 0, rotate: 0 }, { page: 2, rotate: 90 }]]);
});

test("pdf-organizer: isUnchanged only for the untouched single output", () => {
  const pages = initialPages(3);
  assert.equal(isUnchanged(pages, 3, [[0, 1, 2]]), true);
  assert.equal(isUnchanged(pages, 3, [[0, 1], [2]]), false);
  assert.equal(isUnchanged([pages[0], pages[1]], 3, [[0, 1]]), false);
  assert.equal(isUnchanged([rotatePage(pages[0], 90), pages[1], pages[2]], 3, [[0, 1, 2]]), false);
});

test("pdf-organizer: outputNames for one file and split parts", () => {
  assert.deepEqual(outputNames("report.PDF", [[0, 1]]), ["report_organized.pdf"]);
  assert.deepEqual(outputNames("r.pdf", [[0, 1, 2], [3], [0, 1, 2]]), ["r_p1-3.pdf", "r_p4.pdf", "r_p1-3_2.pdf"]);
  assert.deepEqual(outputNames(".pdf", [[0]]), ["document_organized.pdf"]);
});

test("pdf-organizer: paperName recognises common sizes in both orientations", () => {
  assert.equal(paperName(595.28, 841.89), "A4");
  assert.equal(paperName(792, 612), "Letter");
  assert.equal(paperName(500, 500), null);
});

test("pdf-organizer: storedZip is a valid archive (unzip -t)", async (t) => {
  const zip = storedZip([
    { name: "a_p1-2.pdf", bytes: new TextEncoder().encode("%PDF-1.7 first") },
    { name: "a_p3.pdf", bytes: new TextEncoder().encode("%PDF-1.7 second part") },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "pdf-org-"));
  const path = join(dir, "parts.zip");
  writeFileSync(path, new Uint8Array(await zip.arrayBuffer()));
  let out: string;
  try {
    out = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return t.skip("unzip not installed");
    throw e;
  }
  assert.match(out, /No errors detected/);
  assert.match(out, /a_p3\.pdf/);
});
