import { test } from "node:test";
import assert from "node:assert/strict";
import { convertCase } from "../src/tools/text-case.ts";

// Vectors mirror the legacy `text_tools` WASM behavior (parity-fixtures §1:
// 927 cases × 9 transforms, 0 divergences); these pin representative ones.
const cases: Array<[Parameters<typeof convertCase>[1], string, string]> = [
  ["upper", "hello world", "HELLO WORLD"],
  ["lower", "Hello World", "hello world"],
  ["title", "hello WORLD", "Hello World"],
  // Legacy quirk (pinned): a lower→upper boundary splits a word ("wORLD" → "w", "ORLD").
  ["title", "hello wORLD", "Hello W Orld"],
  ["sentence", "hello. WORLD! how? fine", "Hello. World! How? Fine"],
  ["camel", "hello world", "helloWorld"],
  ["camel", "Hello_World-again", "helloWorldAgain"],
  ["snake", "HelloWorld", "hello_world"],
  ["snake", "XMLHttpRequest", "xml_http_request"],
  ["snake", "version2Update", "version_2_update"],
  ["kebab", "Hello World  Again", "hello-world-again"],
  ["kebab", "  __leading and trailing--  ", "leading-and-trailing"],
  ["alternating", "hello world", "hElLo WoRlD"],
  ["inverse", "Hello World", "hELLO wORLD"],
];

for (const [type, input, expected] of cases) {
  test(`convertCase ${type}: ${JSON.stringify(input)}`, () => {
    assert.equal(convertCase(input, type), expected);
  });
}

test("convertCase: empty input stays empty for every transform", () => {
  for (const type of ["sentence", "lower", "upper", "title", "alternating", "inverse", "camel", "snake", "kebab"] as const) {
    assert.equal(convertCase("", type), "");
  }
});

test("convertCase: Unicode letters (Cyrillic, German ß) and emoji survive", () => {
  assert.equal(convertCase("привет мир", "upper"), "ПРИВЕТ МИР");
  assert.equal(convertCase("привет мир", "camel"), "приветМир");
  assert.equal(convertCase("straße", "upper"), "STRASSE");
  assert.equal(convertCase("Hi 👋 there", "snake"), "hi_👋_there");
  assert.equal(convertCase("Hi 👋 there", "inverse"), "hI 👋 THERE");
});

test("convertCase: newlines/tabs are preserved and reset camel word index", () => {
  assert.equal(convertCase("foo bar\nbaz qux", "camel"), "fooBar\nbazQux");
  assert.equal(convertCase("a b\tc d", "kebab"), "a-b\tc-d");
});

test("convertCase: CJK text without case is unchanged by case-only transforms", () => {
  assert.equal(convertCase("日本語テキスト", "upper"), "日本語テキスト");
  assert.equal(convertCase("日本語テキスト", "inverse"), "日本語テキスト");
});
