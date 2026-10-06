import { test } from "node:test";
import assert from "node:assert/strict";
import { formatJson, jsonIndent } from "../src/tools/json-format.ts";

const opts = (o: Partial<{ indent: string; sortKeys: boolean; compact: boolean }> = {}) => ({
  indent: "4",
  sortKeys: false,
  compact: false,
  ...o,
});

test("formatJson: indent 2 / 4 / tab and compact", () => {
  const src = '{"a":1,"b":[true,null,"x"]}';
  assert.equal(formatJson(src, opts({ indent: "2" })), '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    "x"\n  ]\n}');
  assert.equal(formatJson(src, opts()), '{\n    "a": 1,\n    "b": [\n        true,\n        null,\n        "x"\n    ]\n}');
  assert.equal(formatJson(src, opts({ indent: "tab" })), '{\n\t"a": 1,\n\t"b": [\n\t\ttrue,\n\t\tnull,\n\t\t"x"\n\t]\n}');
  assert.equal(formatJson('{ "a" : 1 ,\n "b" : [ ] }', opts({ compact: true })), '{"a":1,"b":[]}');
  // Compact wins over indent; unknown indent falls back to 4.
  assert.equal(jsonIndent(opts({ compact: true, indent: "tab" })), 0);
  assert.equal(jsonIndent(opts({ indent: "7" })), 4);
});

test("formatJson: sort keys is recursive, arrays keep order", () => {
  const out = formatJson('{"b":{"z":1,"a":2},"a":[{"y":1,"x":2},3,1]}', opts({ sortKeys: true, compact: true }));
  assert.equal(out, '{"a":[{"x":2,"y":1},3,1],"b":{"a":2,"z":1}}');
});

test("formatJson: __proto__ key survives sorting and formatting", () => {
  const src = '{"z":1,"__proto__":{"polluted":true}}';
  assert.equal(formatJson(src, opts({ sortKeys: true, compact: true })), '{"__proto__":{"polluted":true},"z":1}');
  assert.equal(formatJson(src, opts({ compact: true })), src);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("formatJson: numbers are preserved exactly as written", () => {
  const src = '{"big":12345678901234567890,"f":1.0,"e":1e3,"neg":-0,"small":0.1,"id":9007199254740993}';
  const out = formatJson(src, opts({ compact: true }));
  assert.equal(out, src);
  // Also inside sorted objects and arrays.
  assert.equal(formatJson('{"b":[1.50,2],"a":123456789012345678901234567890}', opts({ sortKeys: true, compact: true })),
    '{"a":123456789012345678901234567890,"b":[1.50,2]}');
});

test("formatJson: Unicode, emoji and escapes round-trip", () => {
  const src = '{"имя":"Ёжик 🦔","ja":"日本語","esc":"line\\nbreak \\"q\\" \\\\ \\u0007","lone":"\\ud83d"}';
  const out = formatJson(src, opts({ compact: true }));
  assert.equal(out, src);
  assert.deepEqual(JSON.parse(out), JSON.parse(src));
});

test("formatJson: primitives and empty containers at the root", () => {
  assert.equal(formatJson('"text"', opts()), '"text"');
  assert.equal(formatJson(" 42 ", opts()), "42");
  assert.equal(formatJson("null", opts()), "null");
  assert.equal(formatJson("[]", opts()), "[]");
  assert.equal(formatJson("{}", opts({ sortKeys: true })), "{}");
});

test("formatJson: invalid JSON throws SyntaxError", () => {
  for (const bad of ["", "{", '{"a":}', "{'a':1}", "[1,]", '{"a":1,}', "NaN", "undefined", "// c\n{}", '{"a":1}}']) {
    assert.throws(() => formatJson(bad, opts()), SyntaxError, JSON.stringify(bad));
  }
});

test("formatJson: deep nesting and large input", () => {
  const depth = 2000;
  const deep = "[".repeat(depth) + "1" + "]".repeat(depth);
  assert.equal(formatJson(deep, opts({ compact: true })), deep);
  const big = JSON.stringify(Array.from({ length: 50000 }, (_, i) => ({ id: i, name: `item ${i}`, ok: i % 2 === 0 })));
  const pretty = formatJson(big, opts({ indent: "2" }));
  assert.equal(formatJson(pretty, opts({ compact: true })), big);
});
