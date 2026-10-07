import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countPatchLines,
  detectEol,
  endsWithNewline,
  eolLabel,
  groupChangeBlocks,
  intraLineBudget,
  nearestBlock,
} from "../src/tools/text-diff-core.ts";

const PATCH = [
  "===================================================================",
  "--- Original",
  "+++ Modified",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  "+c",
  " d",
].join("\n");

test("countPatchLines: skips file headers", () => {
  assert.deepEqual(countPatchLines(PATCH), { added: 2, removed: 1 });
  assert.deepEqual(countPatchLines(""), { added: 0, removed: 0 });
});

test("intraLineBudget: long lines fall back per line, huge totals switch it off", () => {
  assert.deepEqual(intraLineBudget(PATCH), { highlightMax: 2000, longLines: false, overBudget: false });
  const long = `${PATCH}\n-${"x".repeat(2001)}`;
  assert.deepEqual(intraLineBudget(long), { highlightMax: 2000, longLines: true, overBudget: false });
  const huge = `${PATCH}\n-${"x".repeat(150)}\n+${"y".repeat(150)}`;
  assert.deepEqual(intraLineBudget(huge, 2000, 200), { highlightMax: 0, longLines: false, overBudget: true });
});

test("detectEol / eolLabel / endsWithNewline", () => {
  assert.equal(detectEol("a"), "none");
  assert.equal(detectEol("a\nb\n"), "LF");
  assert.equal(detectEol("a\r\nb\r\n"), "CRLF");
  assert.equal(detectEol("a\rb"), "CR");
  assert.equal(detectEol("a\r\nb\n"), "mixed");
  assert.equal(eolLabel("mixed", "a\r\nb\n"), "CRLF + LF");
  assert.equal(eolLabel("LF", "a\n"), "LF");
  assert.equal(endsWithNewline("a\n"), true);
  assert.equal(endsWithNewline("a\r\n"), true);
  assert.equal(endsWithNewline("a"), false);
  assert.equal(endsWithNewline(""), false);
});

test("groupChangeBlocks: consecutive changed rows form one block", () => {
  assert.deepEqual(groupChangeBlocks(["info", "context", "del", "ins", "context", "both", "context", "ins"]), [
    { first: 2, last: 3, hasDel: true, hasIns: true },
    { first: 5, last: 5, hasDel: true, hasIns: true },
    { first: 7, last: 7, hasDel: false, hasIns: true },
  ]);
  assert.deepEqual(groupChangeBlocks(["context", "info"]), []);
  // A hunk header between two changes splits them.
  assert.equal(groupChangeBlocks(["del", "info", "del"]).length, 2);
});

test("nearestBlock: inside wins, otherwise the closest edge", () => {
  const ext = [{ top: 10, bottom: 20 }, { top: 100, bottom: 140 }];
  assert.equal(nearestBlock(ext, 15), 0);
  assert.equal(nearestBlock(ext, 50), 0);
  assert.equal(nearestBlock(ext, 70), 1);
  assert.equal(nearestBlock(ext, 999), 1);
  assert.equal(nearestBlock([], 5), -1);
});
