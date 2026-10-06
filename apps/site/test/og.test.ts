import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  firstSentence,
  ogImagePath,
  ogLocaleFor,
  parseDarkTokens,
  wrapText,
} from "../src/lib/og/layout.ts";
import { CATEGORIES } from "../src/registry/categories.ts";
import { measure } from "../src/lib/og/render.ts";

const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");

test("og: dark tokens cover the card surface/text and every category hue", () => {
  const tk = parseDarkTokens(css);
  for (const key of ["surface", "text", "text-muted", "text-faint", "border", "accent"]) {
    assert.match(tk[key] ?? "", /^#[0-9a-f]{3,8}$/, key);
  }
  for (const c of CATEGORIES) assert.match(tk[`cat-${c.id}`] ?? "", /^#[0-9a-f]{6}$/, c.id);
});

test("og: CJK/Devanagari locales reuse the English card", () => {
  assert.equal(ogLocaleFor("ru"), "ru");
  assert.equal(ogLocaleFor("de"), "de");
  for (const lang of ["zh", "ja", "ko", "hi"] as const) assert.equal(ogLocaleFor(lang), "en");
  assert.equal(ogImagePath("ja", "hash-calculator"), "og/en/hash-calculator.png");
  assert.equal(ogImagePath("fr", "home"), "og/fr/home.png");
});

test("og: tagline is the first sentence, abbreviations don't cut it short", () => {
  assert.equal(firstSentence("Hash text or a file with MD5 and SHA. Runs locally."), "Hash text or a file with MD5 and SHA.");
  assert.equal(firstSentence("Convert units, e.g. px to rem, instantly. More."), "Convert units, e.g. px to rem, instantly.");
  assert.equal(firstSentence("No stop here"), "No stop here");
});

test("og: wrapText fills lines greedily and ellipsizes overflow", () => {
  const measureChars = (s: string) => s.length;
  assert.deepEqual(wrapText("aa bb cc", measureChars, 5, 2), { lines: ["aa bb", "cc"], truncated: false });
  const cut = wrapText("aa bb cc dd ee", measureChars, 5, 2);
  assert.equal(cut.truncated, true);
  assert.equal(cut.lines.length, 2);
  assert.ok(cut.lines[1].endsWith("…"));
  // No-break space keeps "33 more" together.
  assert.deepEqual(wrapText("x 33 more", measureChars, 4, 3).lines, ["x", "33 more"]);
});

test("og: variable-font weights apply (bold title is wider than light)", () => {
  const light = measure("Hash Calculator", { family: "display", weight: 300, size: 72 });
  const bold = measure("Hash Calculator", { family: "display", weight: 800, size: 72 });
  assert.ok(bold > light * 1.03, `bold ${bold} vs light ${light}`);
  // Cyrillic and Latin-ext come from the bundled subsets, not system fonts.
  assert.ok(measure("Калькулятор Größe", { family: "body", weight: 400, size: 30 }) > 0);
});
