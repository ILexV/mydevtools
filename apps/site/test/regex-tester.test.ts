import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHighlightHtml,
  buildRustPattern,
  escapeHtml,
  parseSavedPatterns,
  truncateText,
} from "../src/tools/regex-tester-core.ts";

test("buildRustPattern: drops JS-only g, inlines the rest in checkbox order", () => {
  assert.equal(buildRustPattern("a.b", ["g", "u"]), "a.b"); // u: Unicode is always on
  assert.equal(buildRustPattern("a.b", ["g", "i", "m", "s", "u"]), "(?ims)a.b");
  assert.equal(buildRustPattern("a.b", ["g"]), "a.b");
  assert.equal(buildRustPattern("a.b", []), "a.b");
  assert.equal(buildRustPattern("x", ["y", "<script>"]), "x"); // unknown flags ignored
});

test("escapeHtml: escapes all HTML-significant characters", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#039;b&#039;)&quot;&gt;&amp;");
});

test("buildHighlightHtml: wraps spans, escapes text around and inside marks", () => {
  assert.equal(
    buildHighlightHtml("a<b>c", [{ start: 1, end: 4 }]),
    'a<mark class="rx-mark">&lt;b&gt;</mark>c',
  );
});

test("buildHighlightHtml: UTF-16 spans line up on Cyrillic and emoji", () => {
  const text = "Привет 😀 мир";
  const start = text.indexOf("мир");
  const html = buildHighlightHtml(text, [{ start: 7, end: 9 }, { start, end: start + 3 }]);
  assert.equal(html, 'Привет <mark class="rx-mark">😀</mark> <mark class="rx-mark">мир</mark>');
});

test("buildHighlightHtml: skips overlapping, reversed, out-of-range and empty spans", () => {
  const html = buildHighlightHtml("abcdef", [
    { start: 0, end: 2 },
    { start: 1, end: 3 }, // overlaps previous
    { start: 4, end: 3 }, // reversed
    { start: 3, end: 3 }, // empty match (e.g. `x*`)
    { start: 5, end: 99 }, // beyond text
  ]);
  assert.equal(html, '<mark class="rx-mark">ab</mark>cdef');
});

test("buildHighlightHtml: trailing newline gets a filler line (scroll height parity)", () => {
  assert.equal(buildHighlightHtml("a\n", []), "a\n<br>&nbsp;");
  assert.equal(buildHighlightHtml("", []), "");
});

test("parseSavedPatterns: legacy shape round-trips; corrupt data never throws", () => {
  const legacy = JSON.stringify([
    { name: "Email", pattern: "\\w+@\\w+", sample: "a@b", flags: ["g", "u"] },
    { name: "No sample", pattern: "x" },
  ]);
  assert.deepEqual(parseSavedPatterns(legacy), [
    { name: "Email", pattern: "\\w+@\\w+", sample: "a@b", flags: ["g", "u"] },
    { name: "No sample", pattern: "x" },
  ]);
  assert.deepEqual(parseSavedPatterns(null), []);
  assert.deepEqual(parseSavedPatterns(""), []);
  assert.deepEqual(parseSavedPatterns("{not json"), []);
  assert.deepEqual(parseSavedPatterns('{"name":"x"}'), []);
  assert.deepEqual(
    parseSavedPatterns(JSON.stringify([null, 1, "s", { name: 1, pattern: "x" }, { name: "ok", pattern: "y", flags: ["i", 5], sample: 3 }])),
    [{ name: "ok", pattern: "y", flags: ["i"] }],
  );
});

test("truncateText: cuts by code points (no broken surrogate pairs)", () => {
  assert.equal(truncateText("abc", 5), "abc");
  assert.equal(truncateText("😀😀😀", 2), "😀😀…");
  assert.equal(truncateText("x".repeat(150)).length, 101);
});

test("applyGlobalFlag: without g only the first match is kept", async () => {
  const { applyGlobalFlag } = await import("../src/tools/regex-tester-core.ts");
  const m = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
  assert.deepEqual(applyGlobalFlag(m, true), m);
  assert.deepEqual(applyGlobalFlag(m, false), [{ start: 0, end: 1 }]);
  assert.deepEqual(applyGlobalFlag([], false), []);
});

test("buildHighlightHtml: capture groups get hue fills, unmatched/empty groups add no marks", async () => {
  const { buildHighlightHtml: hl } = await import("../src/tools/regex-tester-core.ts");
  // `(\d+)-(x)?(y*)` on "12-" : group 2 unmatched, group 3 empty.
  const html = hl("12-", [{
    start: 0, end: 3,
    captures: [
      { index: 1, matched: true, text: "12", start: 0, end: 2 },
      { index: 2, matched: false },
      { index: 3, matched: true, text: "", start: 3, end: 3 },
    ],
  }]);
  assert.equal(html, '<mark class="rx-mark rx-cap rx-c0">12</mark><mark class="rx-mark">-</mark>');
});

test("buildHighlightHtml: nested groups — inner fill, outer underline, selected group wins", async () => {
  const { buildHighlightHtml: hl } = await import("../src/tools/regex-tester-core.ts");
  // `(a(b)c)` on "abc": group 1 = 0..3, group 2 = 1..2.
  const m = {
    start: 0, end: 3,
    captures: [
      { index: 1, matched: true, text: "abc", start: 0, end: 3 },
      { index: 2, matched: true, text: "b", start: 1, end: 2 },
    ],
  };
  assert.equal(
    hl("abc", [m]),
    '<mark class="rx-mark rx-cap rx-c0">a</mark><mark class="rx-mark rx-cap rx-c1 rx-u0">b</mark><mark class="rx-mark rx-cap rx-c0">c</mark>',
  );
  // Selecting the outer group: it takes the fill everywhere, inner becomes underline.
  assert.equal(
    hl("abc", [m], { selected: 1 }),
    '<mark class="rx-mark rx-cap rx-c0 is-sel">a</mark><mark class="rx-mark rx-cap rx-c0 rx-u1 is-sel">b</mark><mark class="rx-mark rx-cap rx-c0 is-sel">c</mark>',
  );
  // Selecting another group dims this one.
  assert.match(hl("abc", [m], { selected: 3 }), /rx-c1 rx-u0 is-dim/);
});

test("buildHighlightHtml: capture spans on Cyrillic + emoji (UTF-16) and the capture budget", async () => {
  const { buildHighlightHtml: hl } = await import("../src/tools/regex-tester-core.ts");
  const text = "😀 мир";
  const start = text.indexOf("мир"); // 3: the emoji is 2 UTF-16 units
  const m = { start, end: start + 3, captures: [{ index: 1, name: "w", matched: true, text: "ми", start, end: start + 2 }] };
  assert.equal(hl(text, [m]), '😀 <mark class="rx-mark rx-cap rx-c0">ми</mark><mark class="rx-mark">р</mark>');
  assert.equal(hl(text, [m], { captureLimit: 0 }), '😀 <mark class="rx-mark">мир</mark>');
});

test("captureHue / captureLabel / captureState", async () => {
  const { captureHue, captureLabel, captureState } = await import("../src/tools/regex-tester-core.ts");
  assert.deepEqual([1, 2, 6, 7, 13].map(captureHue), [0, 1, 5, 0, 0]);
  assert.equal(captureLabel(2, "year"), "2 · year");
  assert.equal(captureLabel(3, null), "3");
  assert.equal(captureState({ index: 1, matched: false }), "unmatched");
  assert.equal(captureState({ index: 1, matched: true, text: "", start: 4, end: 4 }), "empty");
  assert.equal(captureState({ index: 1, matched: true, text: "a", start: 4, end: 5 }), "value");
});
