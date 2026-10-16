import assert from "node:assert/strict";
import { test } from "node:test";
import { fitContentHeight } from "../src/desktop/bounds.ts";
import type { Bounds } from "../src/desktop/types.ts";

const desk = { width: 1440, height: 900 };
const compact: Bounds = { x: 360, y: 16, width: 720, height: 520 };

test("fitContentHeight grows a compact first-open frame for tall UUID-like content", () => {
  const fitted = fitContentHeight(compact, 646.2, 72, desk);

  assert.deepEqual(fitted, { x: 360, y: 16, width: 720, height: 719 });
});

test("fitContentHeight shrinks short content to the window minimum", () => {
  const fitted = fitContentHeight(compact, 132, 48, desk);

  assert.deepEqual(fitted, { x: 360, y: 16, width: 720, height: 240 });
});

test("fitContentHeight uses the available height in a constrained viewport", () => {
  const fitted = fitContentHeight(
    { x: 32, y: 16, width: 556, height: 326 },
    700,
    64,
    { width: 620, height: 390 },
  );

  assert.deepEqual(fitted, { x: 32, y: 16, width: 556, height: 358 });
});

test("fitContentHeight preserves exact horizontal geometry", () => {
  const fitted = fitContentHeight({ x: 137.25, y: 41, width: 811.5, height: 520 }, 410.1, 55.1, desk);

  assert.equal(fitted.x, 137.25);
  assert.equal(fitted.width, 811.5);
  assert.equal(fitted.height, 466);
});

test("fitContentHeight moves a bottom-edge frame only enough to retain its margin", () => {
  const fitted = fitContentHeight({ x: 240, y: 470, width: 960, height: 380 }, 540, 60, desk);

  assert.deepEqual(fitted, { x: 240, y: 284, width: 960, height: 600 });
  assert.equal(fitted.y + fitted.height, desk.height - 16);
});

test("fitContentHeight leaves bounds unchanged without valid measurements or viewport dimensions", () => {
  const invalidCases: Array<[number, number, { width: number; height: number }]> = [
    [0, 48, desk],
    [Number.NaN, 48, desk],
    [200, -1, desk],
    [200, Number.POSITIVE_INFINITY, desk],
    [200, 48, { width: 0, height: desk.height }],
    [200, 48, { width: desk.width, height: 0 }],
    [200, 48, { width: Number.NaN, height: desk.height }],
  ];

  for (const [contentHeight, chromeHeight, viewport] of invalidCases) {
    assert.strictEqual(fitContentHeight(compact, contentHeight, chromeHeight, viewport), compact);
  }
});
