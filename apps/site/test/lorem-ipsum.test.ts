import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateLorem,
  clampCount,
  CLASSIC_START,
  LOREM_WORDS,
  MAX_COUNT,
  type LoremOptions,
} from "../src/tools/lorem-ipsum.ts";

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const base: LoremOptions = { type: "paragraphs", count: 5, format: "plain", startClassic: false, wrapParagraphs: true };
const gen = (o: Partial<LoremOptions>, seed = 1) => generateLorem({ ...base, rng: seeded(seed), ...o });
const sentencesOf = (text: string) => text.match(/[^.]+\./g) ?? [];

test("clampCount: 0/negative → 1, huge → 1000, non-finite → 5, floor", () => {
  assert.equal(clampCount(0), 1);
  assert.equal(clampCount(-3), 1);
  assert.equal(clampCount(2.9), 2);
  assert.equal(clampCount(1e12), MAX_COUNT);
  assert.equal(clampCount(NaN), 5);
  assert.equal(clampCount(Infinity), 5);
});

test("deterministic with an injected rng; differs across seeds", () => {
  assert.equal(gen({}, 42).text, gen({}, 42).text);
  assert.notEqual(gen({}, 42).text, gen({}, 43).text);
});

test("words: exact count, only pool words, single line", () => {
  for (const n of [1, 7, 100, 1000]) {
    const r = gen({ type: "words", count: n });
    const words = r.text.split(" ");
    assert.equal(words.length, n);
    assert.equal(r.words, n);
    for (const w of words) assert.ok(LOREM_WORDS.includes(w), w);
    assert.ok(!r.text.includes("\n"));
  }
});

test("words + classic: starts with the canonical words (legacy comma quirk kept)", () => {
  const r = gen({ type: "words", count: 5, startClassic: true });
  assert.equal(r.text, "lorem ipsum dolor sit amet");
  const long = gen({ type: "words", count: 30, startClassic: true });
  assert.ok(long.text.startsWith("lorem ipsum dolor sit amet consectetur adipiscing elit, sed do"));
  assert.equal(long.words, 30);
});

test("sentences: count, capitalized, 5–15 words each", () => {
  const r = gen({ type: "sentences", count: 50 });
  const s = sentencesOf(r.text);
  assert.equal(s.length, 50);
  for (const sentence of s) {
    const t = sentence.trim();
    assert.match(t, /^[A-Z][a-z ]+\.$/);
    const n = t.slice(0, -1).split(" ").length;
    assert.ok(n >= 5 && n <= 15, String(n));
  }
});

test("sentences + classic: first sentence is canonical, total count kept", () => {
  const r = gen({ type: "sentences", count: 3, startClassic: true });
  assert.ok(r.text.startsWith(CLASSIC_START + " "));
  assert.equal(gen({ type: "sentences", count: 1, startClassic: true }).text, CLASSIC_START);
});

test("paragraphs: blank-line separated, 3–7 sentences each", () => {
  const r = gen({ type: "paragraphs", count: 20 });
  const paras = r.text.split("\n\n");
  assert.equal(paras.length, 20);
  for (const p of paras) {
    const n = sentencesOf(p).length;
    assert.ok(n >= 3 && n <= 7, String(n));
  }
});

test("paragraphs + classic: first paragraph begins canonically", () => {
  const paras = gen({ count: 2, startClassic: true }).text.split("\n\n");
  assert.equal(paras.length, 2);
  assert.ok(paras[0].startsWith(CLASSIC_START + " "));
});

test("HTML wrapping only for html + paragraphs + wrap", () => {
  const html = gen({ count: 3, format: "html", wrapParagraphs: true }).text;
  assert.match(html, /^<p>[^<]+<\/p>\n\n<p>[^<]+<\/p>\n\n<p>[^<]+<\/p>$/);
  assert.ok(!gen({ count: 3, format: "html", wrapParagraphs: false }).text.includes("<p>"));
  assert.ok(!gen({ count: 3, format: "markdown" }).text.includes("<p>"));
  assert.ok(!gen({ type: "sentences", count: 3, format: "html" }).text.includes("<p>"));
});

test("stats: words/chars match the text", () => {
  const r = gen({ count: 4 });
  assert.equal(r.chars, r.text.length);
  assert.equal(r.words, r.text.split(/\s+/).filter(Boolean).length);
});

test("count edge cases: 0 → 1 item, huge is capped (no freeze)", () => {
  assert.equal(gen({ type: "paragraphs", count: 0 }).text.split("\n\n").length, 1);
  assert.equal(gen({ type: "words", count: 0 }).words, 1);
  const t0 = Date.now();
  const huge = gen({ type: "paragraphs", count: 1e9 });
  assert.equal(huge.text.split("\n\n").length, MAX_COUNT);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(gen({ type: "words", count: NaN }).words, 5);
});
