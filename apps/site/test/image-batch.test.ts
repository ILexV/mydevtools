import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchOutputName,
  batchPoolSize,
  isSameFormat,
  keepsOriginal,
  parseMaxSide,
  reportCsv,
  resolveBatchFormat,
  summarize,
  type BatchRow,
} from "../src/tools/image-batch.ts";

test("image-batch: keep-original format follows MIME, then extension, else PNG", () => {
  assert.equal(resolveBatchFormat("original", { type: "image/jpeg", name: "a.jpg" }), "jpeg");
  assert.equal(resolveBatchFormat("original", { type: "image/x-ms-bmp", name: "a.bmp" }), "bmp");
  assert.equal(resolveBatchFormat("original", { type: "", name: "scan.TIF" }), "tiff");
  assert.equal(resolveBatchFormat("original", { type: "image/x-icon", name: "favicon.ico" }), "png");
  assert.equal(resolveBatchFormat("original", { type: "", name: "sprite.tga" }), "png");
  assert.equal(resolveBatchFormat("webp", { type: "image/png", name: "a.png" }), "webp");
  assert.ok(isSameFormat({ type: "image/png", name: "a.png" }, "png"));
  assert.ok(!isSameFormat({ type: "image/png", name: "a.png" }, "webp"));
});

test("image-batch: output names are unique case-insensitively and use .jpg", () => {
  const used = new Set<string>();
  assert.equal(batchOutputName("Photo.PNG", "jpeg", used), "Photo.jpg");
  assert.equal(batchOutputName("photo.jpeg", "jpeg", used), "photo (2).jpg");
  assert.equal(batchOutputName("photo.webp", "jpeg", used), "photo (3).jpg");
  assert.equal(batchOutputName(".hidden", "png", used), ".hidden.png");
  assert.equal(batchOutputName("noext", "webp", used), "noext.webp");
});

test("image-batch: max side accepts empty (no limit) and 1…16384 only", () => {
  assert.equal(parseMaxSide(""), 0);
  assert.equal(parseMaxSide(" 1920 "), 1920);
  assert.equal(parseMaxSide("16384"), 16384);
  for (const bad of ["0", "16385", "-5", "12.5", "1e3", "abc"]) assert.equal(parseMaxSide(bad), null, bad);
});

test("image-batch: original is kept only for a same-format, unresized, not-smaller result", () => {
  const base = { keepIfLarger: true, inputBytes: 100, outputBytes: 120, sameFormat: true, resized: false };
  assert.ok(keepsOriginal(base));
  assert.ok(keepsOriginal({ ...base, outputBytes: 100 }));
  assert.ok(!keepsOriginal({ ...base, outputBytes: 99 }));
  assert.ok(!keepsOriginal({ ...base, keepIfLarger: false }));
  assert.ok(!keepsOriginal({ ...base, sameFormat: false }));
  assert.ok(!keepsOriginal({ ...base, resized: true }));
});

const row = (over: Partial<BatchRow>): BatchRow => ({
  name: "a.png", inputBytes: 1_000_000, outputName: "a.png", outputBytes: 400_000,
  sourceWidth: 2000, sourceHeight: 1000, width: 1000, height: 500, ms: 250, status: "done", ...over,
});

test("image-batch: summary totals, savings and throughput skip failed rows", () => {
  const s = summarize([
    row({}),
    row({ name: "b.jpg", status: "kept", outputBytes: 1_000_000 }),
    row({ name: "c.gif", status: "failed", outputBytes: 0, sourceWidth: 0, sourceHeight: 0 }),
  ], 2000);
  assert.equal(s.processed, 2);
  assert.equal(s.kept, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.inputBytes, 2_000_000);
  assert.equal(s.outputBytes, 1_400_000);
  assert.equal(s.savedPercent, 30);
  assert.equal(s.bytesPerSecond, 1_000_000);
  assert.equal(s.megapixelsPerSecond, 2);
  assert.equal(summarize([], 0).bytesPerSecond, 0);
});

test("image-batch: CSV quotes names and neutralizes formulas", () => {
  const csv = reportCsv([
    row({ name: 'a,"b".png', outputName: 'a,"b".png' }),
    row({ name: "=cmd.png", status: "failed", error: "Not an image" }),
  ]).trim().split("\n");
  assert.equal(csv[0].split(",")[0], "file");
  assert.equal(csv[1], '"a,""b"".png",done,1000000,"a,""b"".png",400000,60,2000,1000,1000,500,250,');
  assert.equal(csv[2], "'=cmd.png,failed,1000000,,,,2000,1000,,,250,Not an image");
});

test("image-batch: pool size from cores and memory", () => {
  assert.equal(batchPoolSize(8, 8), 3);
  assert.equal(batchPoolSize(4, undefined), 2);
  assert.equal(batchPoolSize(1, undefined), 1);
  assert.equal(batchPoolSize(16, 4), 1);
  assert.equal(batchPoolSize(undefined, undefined), 1);
});
