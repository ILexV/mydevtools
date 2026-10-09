import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDiscoveredColumns,
  JSON_EXPLORER_LIMITS,
  JsonExplorerError,
  JsonlLineDecoder,
  normalizePointers,
  parseJsonLossless,
  projectedCells,
  projectedJson,
  recordMatches,
  resolveJsonPointer,
  treeChildren,
} from "../src/tools/json-explorer-core.ts";

const utf8 = new TextEncoder();

test("JSONL decoder preserves UTF-8 split boundaries, BOM, CRLF and final line", () => {
  const source = "\ufeff{\"name\":\"雪🦊\"}\r\n{\"id\":9007199254740993}\nnull";
  const bytes = utf8.encode(source);
  const fox = bytes.indexOf(0xf0);
  const decoder = new JsonlLineDecoder(1024);
  const lines = [
    ...decoder.push(bytes.subarray(0, fox + 1)),
    ...decoder.push(bytes.subarray(fox + 1, fox + 3)),
    ...decoder.push(bytes.subarray(fox + 3)),
    ...decoder.finish(bytes.length),
  ];
  assert.deepEqual(lines.map((line) => line.text), ['{"name":"雪🦊"}', '{"id":9007199254740993}', "null"]);
  assert.deepEqual(lines.map((line) => line.physicalLine), [1, 2, 3]);
  assert.equal(lines[0].byteOffset, 0);
  assert.equal(lines[2].nextOffset, bytes.length);
});

test("JSONL decoder keeps physical blank lines and enforces record bytes", () => {
  const decoder = new JsonlLineDecoder(4);
  const lines = decoder.push(utf8.encode("\n{}\n"));
  assert.deepEqual(lines.map((line) => [line.physicalLine, line.text]), [[1, ""], [2, "{}"]]);
  assert.throws(() => new JsonlLineDecoder(3).push(utf8.encode("1234")), (error) => error instanceof JsonExplorerError && error.code === "record-limit");
});

test("JSONL decoder treats a split CRLF terminator consistently with one chunk", () => {
  const split = new JsonlLineDecoder(4);
  assert.deepEqual(split.push(utf8.encode("1234\r")), []);
  assert.deepEqual(split.push(utf8.encode("\n")).map((line) => line.text), ["1234"]);
  const notTerminator = new JsonlLineDecoder(4);
  notTerminator.push(utf8.encode("1234\r"));
  assert.throws(() => notTerminator.push(utf8.encode("x")), (error) => error instanceof JsonExplorerError && error.code === "record-limit");
});

test("JSONL decoder strips only the file-leading BOM", () => {
  const bytes = utf8.encode("\ufeff1\n\ufeff2\n");
  const decoder = new JsonlLineDecoder(32);
  const lines = decoder.push(bytes);
  assert.deepEqual(lines.map((line) => line.text), ["1", "\ufeff2"]);
  assert.doesNotThrow(() => parseJsonLossless(lines[0].text));
  assert.throws(() => parseJsonLossless(lines[1].text), JsonExplorerError);
});

test("lossless parser and projection preserve numeric lexemes", () => {
  const source = '{"id":9007199254740993,"decimal":1.0,"exp":1e3,"nested":{"a/b":-0}}';
  const root = parseJsonLossless(source);
  assert.equal(projectedJson(root, source, ["/id", "/decimal", "/exp", "/nested/a~1b"]),
    '{"/id":9007199254740993,"/decimal":1.0,"/exp":1e3,"/nested/a~1b":-0}');
  assert.equal(resolveJsonPointer(root, "/nested/a~1b")?.kind, "number");
});

test("JSON Pointer projection is unambiguous and missing values are explicit", () => {
  const source = '{"a/b":{"~key":"value"},"empty":null}';
  const root = parseJsonLossless(source);
  assert.deepEqual(normalizePointers("/a~1b/~0key\n/empty\n/a~1b/~0key"), ["/a~1b/~0key", "/empty"]);
  assert.equal(projectedJson(root, source, ["/a~1b/~0key", "/missing"]), '{"/a~1b/~0key":"value","/missing":null}');
  assert.deepEqual(projectedCells(root, source, ["/a~1b/~0key", "/missing"]), ["value", ""]);
  assert.throws(() => normalizePointers("not/a/pointer"), JsonExplorerError);
});

test("JSON Pointer input preserves member-name whitespace", () => {
  const source = '{" name ":1,"other":2}';
  const root = parseJsonLossless(source);
  assert.deepEqual(normalizePointers("/ name \n/other"), ["/ name ", "/other"]);
  assert.equal(resolveJsonPointer(root, "/ name ")?.kind, "number");
});

test("automatic column metadata bounds names and total retained characters", () => {
  const longKey = "x".repeat(JSON_EXPLORER_LIMITS.detectedColumnNameChars + 1);
  const longSource = JSON.stringify({ [longKey]: 1 });
  const longRoot = parseJsonLossless(longSource);
  const longFound = new Set<string>();
  const longState = { truncated: false, retainedChars: 0 };
  addDiscoveredColumns(longRoot, longFound, longState);
  assert.equal(longFound.size, 0);
  assert.equal(longState.truncated, true);
  assert.equal(resolveJsonPointer(longRoot, `/${longKey}`)?.kind, "number");

  const escapedKey = "/".repeat(Math.ceil(JSON_EXPLORER_LIMITS.detectedColumnNameChars / 2));
  const escapedRoot = parseJsonLossless(JSON.stringify({ [escapedKey]: 1 }));
  const escapedFound = new Set<string>();
  const escapedState = { truncated: false, retainedChars: 0 };
  addDiscoveredColumns(escapedRoot, escapedFound, escapedState);
  assert.equal(escapedFound.size, 0);
  assert.equal(escapedState.truncated, true);

  const many = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${index}-${"k".repeat(200)}`, index]));
  const manyFound = new Set<string>();
  const manyState = { truncated: false, retainedChars: 0 };
  addDiscoveredColumns(parseJsonLossless(JSON.stringify(many)), manyFound, manyState);
  assert.ok(manyState.retainedChars <= JSON_EXPLORER_LIMITS.detectedColumnTotalChars);
  assert.equal(manyState.truncated, true);
});

test("tree pages and previews stay bounded", () => {
  const longKey = "k".repeat(1_000);
  const source = JSON.stringify({ [longKey]: "v".repeat(1_000) });
  const objectPage = treeChildren(parseJsonLossless(source), source, "", 0, 100);
  assert.equal(objectPage.children.length, 1);
  assert.equal(objectPage.children[0].label.length, JSON_EXPLORER_LIMITS.treePreviewChars);
  assert.equal(objectPage.children[0].preview.length, JSON_EXPLORER_LIMITS.treePreviewChars);

  const arraySource = JSON.stringify(Array.from({ length: 1_000 }, (_, index) => index));
  const arrayPage = treeChildren(parseJsonLossless(arraySource), arraySource, "", 995, 100);
  assert.equal(arrayPage.total, 1_000);
  assert.deepEqual(arrayPage.children.map((child) => child.label), ["995", "996", "997", "998", "999"]);
});

test("key/value scopes and field filters inspect nested values", () => {
  const source = '{"service":"billing","event":{"message":"Timeout waiting","code":504}}';
  const root = parseJsonLossless(source);
  assert.equal(recordMatches(root, source, { query: "event", scope: "keys", fieldPath: "", fieldValue: "", caseSensitive: false }), true);
  assert.equal(recordMatches(root, source, { query: "timeout", scope: "values", fieldPath: "/service", fieldValue: "BILL", caseSensitive: false }), true);
  assert.equal(recordMatches(root, source, { query: "event", scope: "values", fieldPath: "", fieldValue: "", caseSensitive: false }), false);
});

test("depth limit and malformed JSON are deterministic", () => {
  assert.throws(() => parseJsonLossless("[[[0]]]", 1), (error) => error instanceof JsonExplorerError && error.code === "depth-limit");
  for (const invalid of ["", "{", "[1,]", '{"a":01}', '"bad\\x"', "true false"]) {
    assert.throws(() => parseJsonLossless(invalid), JsonExplorerError, invalid);
  }
});
