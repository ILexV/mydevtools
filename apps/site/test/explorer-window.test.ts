import { test } from "node:test";
import assert from "node:assert/strict";
import { explorerScrollTop, explorerWindow } from "../src/scripts/explorer-window.ts";

test("compressed scrolling reaches the final records without exceeding CSS height limits", () => {
  const window = explorerWindow(1_000_000, 400, 7_999_600);
  assert.deepEqual(window, {
    start: 999_980,
    count: 20,
    anchor: 999_990,
    offset: 7_999_200,
    trackHeight: 8_000_000,
  });
  assert.equal(window.start + window.count, 1_000_000);
  assert.equal(window.offset + window.count * 40, window.trackHeight);
});

test("an exact logical row remains reachable after compressed native scroll rounding", () => {
  const requested = 1_234_567;
  const top = explorerScrollTop(10_000_000, 400, requested);
  const nativeRoundedTop = Math.round(top * 2) / 2;
  const window = explorerWindow(10_000_000, 400, nativeRoundedTop, requested);
  assert.equal(window.anchor, requested);
  assert.equal(window.start, requested - 5);
  assert.equal(window.count, 20);
  assert.ok(requested >= window.start && requested < window.start + window.count);
});
