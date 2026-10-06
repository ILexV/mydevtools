import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, countGraphemes, countWords, readingMinutes } from "../src/tools/word-stats.ts";

test("computeStats: empty and whitespace-only input", () => {
  assert.deepEqual(computeStats(""), { words: 0, charsSpaces: 0, charsNoSpaces: 0, lines: 0, paragraphs: 0, sentences: 0 });
  const ws = computeStats("  \n\t ");
  assert.equal(ws.words, 0);
  assert.equal(ws.sentences, 0);
  assert.equal(ws.paragraphs, 0);
  assert.equal(ws.lines, 2);
  assert.equal(ws.charsSpaces, 5);
  assert.equal(ws.charsNoSpaces, 0);
});

test("computeStats: English text with paragraphs and sentences", () => {
  const text = "Hello world. How are you?\n\nSecond paragraph here!\nNo terminator";
  const s = computeStats(text);
  assert.equal(s.words, 10);
  assert.equal(s.lines, 4);
  assert.equal(s.paragraphs, 2);
  assert.equal(s.sentences, 4); // 3 terminated + trailing unterminated
  assert.equal(s.charsSpaces, text.length);
  assert.equal(s.charsNoSpaces, text.replace(/\s/g, "").length);
});

test("computeStats: CRLF line endings count lines/paragraphs like LF", () => {
  const s = computeStats("a\r\nb\r\n\r\nc");
  assert.equal(s.lines, 4);
  assert.equal(s.paragraphs, 2);
});

test("computeStats: ellipsis and punctuation-only runs are not extra sentences", () => {
  assert.equal(computeStats("Wait... what?!").sentences, 2);
  assert.equal(computeStats("...").sentences, 0);
  assert.equal(computeStats("Hi. ... Bye.").sentences, 2);
});

test("countGraphemes: emoji, ZWJ sequences and combining marks count as one character", () => {
  assert.equal(countGraphemes("👍"), 1);
  assert.equal(countGraphemes("👨‍👩‍👧‍👦"), 1);
  assert.equal(countGraphemes("é"), 1);
  assert.equal(countGraphemes("Привет"), 6);
  assert.equal(computeStats("hi 👋🏽").charsSpaces, 4);
  assert.equal(computeStats("hi 👋🏽").charsNoSpaces, 3);
});

test("countWords: Cyrillic, Arabic (RTL), Korean use spaces; CJK runs are segmented", () => {
  assert.equal(countWords("Привет, как дела?"), 3);
  assert.equal(countWords("مرحبا بالعالم"), 2);
  assert.equal(countWords("안녕하세요 세계"), 2);
  // "私は学生です" has no spaces but several words.
  assert.ok(countWords("私は学生です") >= 3);
  assert.ok(countWords("我爱北京天安门") >= 3);
  assert.equal(countWords("hello 世界"), 2);
});

test("computeStats: CJK full stops terminate sentences", () => {
  assert.equal(computeStats("你好。世界！再见").sentences, 3);
});

test("readingMinutes: 0 for empty, at least 1, rounds (200/130 wpm)", () => {
  assert.equal(readingMinutes(0, 200), 0);
  assert.equal(readingMinutes(1, 200), 1);
  assert.equal(readingMinutes(500, 200), 3);
  assert.equal(readingMinutes(260, 130), 2);
});

test("computeStats: large input stays fast", () => {
  const big = "lorem ipsum dolor sit amet. ".repeat(40_000); // ~1.1 MB
  const t0 = performance.now();
  const s = computeStats(big);
  assert.equal(s.words, 200_000);
  assert.equal(s.sentences, 40_000);
  assert.ok(performance.now() - t0 < 3000);
});
