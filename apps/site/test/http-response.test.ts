import { test } from "node:test";
import assert from "node:assert/strict";
import { formatResponseJson } from "../src/tools/http-response.ts";

test("formatResponseJson preserves duplicate keys and exact scalar tokens", () => {
  const source = ' { "dup" : 90071992547409931234567890, "dup" : -0.00e+09, "escaped" : "\\u0061\\/\\b", "order" : true } ';
  assert.equal(formatResponseJson(source), `{
  "dup": 90071992547409931234567890,
  "dup": -0.00e+09,
  "escaped": "\\u0061\\/\\b",
  "order": true
}`);
});

test("formatResponseJson rejects invalid and incomplete JSON", () => {
  for (const source of [
    "",
    "   ",
    "{",
    '{"a":',
    '{"a":1,}',
    "[1,]",
    "[01]",
    "1.",
    "1e+",
    '"unterminated',
    '"bad\\xescape"',
    '"raw\nnewline"',
    "true false",
  ]) {
    assert.equal(formatResponseJson(source), null, JSON.stringify(source));
  }
});

test("formatResponseJson treats punctuation inside strings as content", () => {
  const source = '{"punctuation":"{ [ ] } , :","quote":"\\\"[,]\\\"","url":"https:\\/\\/example.test\\/a?x=1,y=2"}';
  assert.equal(formatResponseJson(source), `{
  "punctuation": "{ [ ] } , :",
  "quote": "\\\"[,]\\\"",
  "url": "https:\\/\\/example.test\\/a?x=1,y=2"
}`);
});

test("formatResponseJson formats empty containers and root scalars", () => {
  assert.equal(formatResponseJson('{ "emptyObject": { }, "emptyArray": [ ], "nested": [ {}, [] ] }'), `{
  "emptyObject": {},
  "emptyArray": [],
  "nested": [
    {},
    []
  ]
}`);
  assert.equal(formatResponseJson("  null\r\n"), "null");
  assert.equal(formatResponseJson(' "text" '), '"text"');
});

test("formatResponseJson bounds nesting at 64 containers", () => {
  const atLimit = "[".repeat(64) + "0" + "]".repeat(64);
  const beyondLimit = `[${atLimit}]`;
  assert.notEqual(formatResponseJson(atLimit), null);
  assert.equal(formatResponseJson(beyondLimit), null);
});

test("formatResponseJson bounds pretty output at 2 MiB characters", () => {
  const exactCount = 419_430;
  const exactSource = `[${"0,".repeat(exactCount - 1)}0]`;
  const exactOutput = formatResponseJson(exactSource);
  assert.equal(exactOutput?.length, 2 * 1024 * 1024);

  const overCount = exactCount + 1;
  const overSource = `[${"0,".repeat(overCount - 1)}0]`;
  assert.equal(formatResponseJson(overSource), null);
});
