import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  breakUnits,
  firstSentence,
  OG_LOCALES,
  ogImagePath,
  parseDarkTokens,
  wrapText,
} from "../src/lib/og/layout.ts";
import { LOCALE_CODES } from "../src/registry/locales.ts";
import { CATEGORIES } from "../src/registry/categories.ts";
import { MissingGlyphError, measure } from "../src/lib/og/render.ts";

const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");

test("og: dark tokens cover the card surface/text and every category hue", () => {
  const tk = parseDarkTokens(css);
  for (const key of ["surface", "text", "text-muted", "text-faint", "border", "accent"]) {
    assert.match(tk[key] ?? "", /^#[0-9a-f]{3,8}$/, key);
  }
  for (const c of CATEGORIES) assert.match(tk[`cat-${c.id}`] ?? "", /^#[0-9a-f]{6}$/, c.id);
});

test("og: every locale, CJK/Devanagari included, gets its own card", () => {
  assert.deepEqual([...OG_LOCALES], [...LOCALE_CODES]);
  assert.equal(ogImagePath("ja", "hash-calculator"), "og/ja/hash-calculator.png");
  assert.equal(ogImagePath("hi", "home"), "og/hi/home.png");
  assert.equal(ogImagePath("fr", "home"), "og/fr/home.png");
});

test("og: tagline is the first sentence, abbreviations don't cut it short", () => {
  assert.equal(firstSentence("Hash text or a file with MD5 and SHA. Runs locally."), "Hash text or a file with MD5 and SHA.");
  assert.equal(firstSentence("Convert units, e.g. px to rem, instantly. More."), "Convert units, e.g. px to rem, instantly.");
  assert.equal(firstSentence("No stop here"), "No stop here");
  // Full-width stops and the danda end a sentence with no following space.
  assert.equal(firstSentence("从大写、小写字母生成随机密码。使用浏览器的安全随机数。"), "从大写、小写字母生成随机密码。");
  assert.equal(firstSentence("पासवर्ड बनाएँ — ब्राउज़र से। दूसरा वाक्य।"), "पासवर्ड बनाएँ — ब्राउज़र से।");
});

test("og: CJK line breaking keeps kinsoku punctuation attached; Korean/Hindi break at spaces", () => {
  const ja = breakUnits("大文字・小文字から、パスワードを生成。", "ja");
  assert.equal(ja.map((u) => u.text).join(""), "大文字・小文字から、パスワードを生成。");
  for (const u of ja) assert.doesNotMatch(u.text, /^[、。・]/, `unit starts with closing mark: ${u.text}`);
  assert.ok(ja.length > 3, "Japanese gets break opportunities without spaces");
  assert.deepEqual(breakUnits("JSON 포맷터", "ko").map((u) => u.text), ["JSON", "포맷터"]);
  assert.deepEqual(breakUnits("पासवर्ड जनरेटर", "hi").map((u) => u.text), ["पासवर्ड", "जनरेटर"]);
  const zh = wrapText("密码生成器密码生成器", (s) => [...s].length, 5, 3, "zh");
  assert.ok(zh.lines.length >= 2 && zh.lines.every((l) => [...l].length <= 5), zh.lines.join("|"));
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

test("og: zh/ja/ko/hi text renders from build-only Noto fonts; missing glyphs fail loudly", () => {
  const style = { family: "display", weight: 800, size: 64 } as const;
  for (const [script, text] of [["sc", "密码生成器"], ["jp", "パスワード生成"], ["kr", "비밀번호 생성기"], ["devanagari", "पासवर्ड जनरेटर"]] as const) {
    assert.ok(measure(text, { ...style, script }) > 64 * 3, script);
  }
  // HarfBuzz shaping: the conjunct क्ष is narrower than its three code points drawn separately.
  const deva = { ...style, script: "devanagari" } as const;
  assert.ok(measure("क्ष", deva) < measure("क", deva) + measure("ष", deva), "Devanagari conjunct is shaped");
  // Without a script fallback, Han has no glyph: an error, not an English card.
  assert.throws(() => measure("密码", style), MissingGlyphError);
});
