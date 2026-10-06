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
  assert.equal(buildRustPattern("a.b", ["g", "u"]), "(?u)a.b");
  assert.equal(buildRustPattern("a.b", ["g", "i", "m", "s", "u"]), "(?imsu)a.b");
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
