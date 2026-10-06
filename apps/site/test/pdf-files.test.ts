import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPdfFile,
  compressedFileName,
  textFileName,
  savingsPercent,
  moveItem,
  classifyPdfError,
} from "../src/tools/pdf-files.ts";

test("isPdfFile: MIME type or .pdf extension (case-insensitive)", () => {
  assert.equal(isPdfFile({ name: "a.pdf", type: "" }), true);
  assert.equal(isPdfFile({ name: "REPORT.PDF", type: "" }), true);
  assert.equal(isPdfFile({ name: "scan", type: "application/pdf" }), true);
  assert.equal(isPdfFile({ name: "photo.png", type: "image/png" }), false);
  assert.equal(isPdfFile({ name: "notes.pdf.txt", type: "text/plain" }), false);
  assert.equal(isPdfFile({ name: "", type: "" }), false);
});

test("compressedFileName / textFileName: legacy download names", () => {
  assert.equal(compressedFileName("doc.pdf"), "compressed_doc.pdf");
  assert.equal(textFileName("doc.pdf"), "doc.txt");
  assert.equal(textFileName("Doc.PDF"), "Doc.txt");
  assert.equal(textFileName("archive.pdf.pdf"), "archive.pdf.txt");
  assert.equal(textFileName("no-extension"), "no-extension.txt");
  assert.equal(textFileName("Отчёт 2026 📄.pdf"), "Отчёт 2026 📄.txt");
});

test("savingsPercent: rounded, negative when output grows, 0 for empty input", () => {
  // parity-fixtures.md: 649 → 588 B = 9 %
  assert.equal(savingsPercent(649, 588), 9);
  assert.equal(savingsPercent(100, 100), 0);
  assert.equal(savingsPercent(100, 125), -25);
  assert.equal(savingsPercent(100, 0), 100);
  assert.equal(savingsPercent(0, 10), 0);
});

test("moveItem: moves, clamps target, ignores invalid source, never mutates", () => {
  const src = ["a", "b", "c", "d"];
  assert.deepEqual(moveItem(src, 0, 1), ["b", "a", "c", "d"]);
  assert.deepEqual(moveItem(src, 3, 2), ["a", "b", "d", "c"]);
  assert.deepEqual(moveItem(src, 1, -5), ["b", "a", "c", "d"]);
  assert.deepEqual(moveItem(src, 1, 99), ["a", "c", "d", "b"]);
  assert.deepEqual(moveItem(src, 7, 0), src);
  assert.deepEqual(src, ["a", "b", "c", "d"]);
});

test("classifyPdfError: maps pdf crate messages to kinds + merge index", () => {
  assert.deepEqual(classifyPdfError("PDF is encrypted (password protected)"), { kind: "encrypted", index: null });
  assert.deepEqual(classifyPdfError("PDF 2: PDF is encrypted (password protected)"), { kind: "encrypted", index: 2 });
  assert.deepEqual(classifyPdfError("Failed to load PDF: Header"), { kind: "invalid", index: null });
  assert.deepEqual(classifyPdfError("PDF 0: Failed to load PDF: Xref"), { kind: "invalid", index: 0 });
  assert.deepEqual(classifyPdfError("Failed to save PDF: Io"), { kind: "other", index: null });
  assert.deepEqual(classifyPdfError(""), { kind: "other", index: null });
});
