import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonToTypeScript, toSafeKey, toTypeName } from "../src/tools/json-to-typescript.ts";

const base = { rootName: "Root", exportKw: false, optional: true, useType: false };
const conv = (json: unknown, o: Partial<typeof base> = {}) =>
  jsonToTypeScript(typeof json === "string" ? json : JSON.stringify(json), { ...base, ...o });

test("object with primitives, nested object and arrays (legacy layout)", () => {
  const out = conv({ id: 1, name: "a", ok: true, tags: ["x"], owner: { login: "l", site: null }, list: [] });
  assert.equal(
    out,
    [
      "interface RootOwner {\n  login: string;\n  site?: null;\n}",
      "interface Root {\n  id: number;\n  name: string;\n  ok: boolean;\n  tags: string[];\n  owner: RootOwner;\n  list: unknown[];\n}",
    ].join("\n\n"),
  );
});

test("options: export keyword, type alias, optional off, root name", () => {
  const out = conv({ a: null, b: { c: 1 } }, { exportKw: true, useType: true, optional: false, rootName: "api response" });
  assert.equal(
    out,
    "export type ApiResponseB = {\n  c: number;\n};\n\nexport type ApiResponse = {\n  a: null;\n  b: ApiResponseB;\n};",
  );
});

test("array of objects merges into one item interface; missing keys become optional", () => {
  const out = conv([{ id: 1, name: "a" }, { id: 2, extra: true }]);
  assert.equal(
    out,
    "interface RootItem {\n  id: number;\n  name?: string;\n  extra?: boolean;\n}\n\ntype Root = RootItem[];",
  );
});

test("mixed arrays become union element types", () => {
  assert.equal(conv({ v: [1, "a", null] }), "interface Root {\n  v: (number | string | null)[];\n}");
  assert.equal(conv({ v: [[1, 2], [3]] }), "interface Root {\n  v: number[][];\n}");
  assert.equal(conv([1, "x"]), "type Root = (number | string)[];");
  assert.equal(conv({ v: [{ a: 1 }, 2] }), "interface RootVItem {\n  a: number;\n}\n\ninterface Root {\n  v: (number | RootVItem)[];\n}");
});

test("root arrays: empty, primitives, nulls (legacy emitted a missing RootItem for [null])", () => {
  assert.equal(conv([]), "type Root = unknown[];");
  assert.equal(conv([null]), "type Root = null[];");
  assert.equal(conv(["a", "b"]), "type Root = string[];");
});

test("primitive roots", () => {
  assert.equal(conv("42"), "type Root = number;");
  assert.equal(conv('"s"'), "type Root = string;");
  assert.equal(conv("null"), "type Root = null;");
  assert.equal(conv("{}"), "interface Root {}");
});

test("name collisions: every referenced interface is emitted (legacy dropped Name2)", () => {
  // Two different shapes that produce the same generated name `RootAB`.
  const out = conv({ a: { b: { x: 1 } }, aB: { y: "s" } });
  assert.match(out, /interface RootAB \{\n {2}x: number;\n\}/);
  assert.match(out, /interface RootAB2 \{\n {2}y: string;\n\}/);
  assert.match(out, /aB: RootAB2;/);
  // Identical shapes under the same name are reused, not duplicated.
  const same = conv({ a: { b: { x: 1 } }, aB: { x: 2 } });
  assert.equal(same.match(/interface RootAB\b/g)?.length, 1);
  assert.doesNotMatch(same, /RootAB2/);
  // Every type referenced in the output is declared.
  const declared = new Set([...out.matchAll(/interface (\w+)/g)].map((m) => m[1]));
  for (const [, ref] of out.matchAll(/: (Root\w*)/g)) assert.ok(declared.has(ref), ref);
});

test("keys: quoting with escapes, Unicode, emoji", () => {
  const out = conv({ "first-name": 1, 'say "hi"': 2, "back\\slash": 3, имя: "Ёж", "🦔": true, $ok: 1, _x: 2, "1a": 3 });
  assert.match(out, /\n {2}"first-name": number;/);
  assert.match(out, /\n {2}"say \\"hi\\"": number;/);
  assert.match(out, /\n {2}"back\\\\slash": number;/);
  assert.match(out, /\n {2}"имя": string;/);
  assert.match(out, /\n {2}"🦔": boolean;/);
  assert.match(out, /\n {2}\$ok: number;/);
  assert.match(out, /\n {2}_x: number;/);
  assert.match(out, /\n {2}"1a": number;/);
});

test("type names are always valid identifiers", () => {
  assert.equal(toTypeName("my-root"), "MyRoot");
  assert.equal(toTypeName("user_profile.data"), "UserProfileData");
  assert.equal(toTypeName("1st"), "_1st");
  assert.equal(toTypeName("a@b#c"), "Abc");
  assert.equal(toTypeName("🦔"), "");
  assert.equal(toTypeName("имя"), "Имя");
  assert.match(conv({ "🦔": { a: 1 }, "1x": { b: 2 } }), /interface Root🦔|interface Root1x/);
  const names = [...conv({ "🦔": { a: 1 }, "1x": { b: 2 }, "a b": { c: 3 } }).matchAll(/interface (\S+)/g)].map((m) => m[1]);
  for (const n of names) assert.match(n, /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u, n);
  assert.equal(conv({ a: 1 }, { rootName: "123" }).split("\n")[0], "interface _123 {");
  assert.equal(conv({ a: 1 }, { rootName: "!!!" }).split("\n")[0], "interface Root {");
  assert.equal(toSafeKey("ok_1"), "ok_1");
  assert.equal(toSafeKey("a-b"), '"a-b"');
});

test("deep nesting and invalid JSON", () => {
  let v: unknown = 1;
  for (let i = 0; i < 200; i++) v = { n: v };
  const out = conv(v);
  assert.equal(out.match(/^interface /gm)?.length, 200);
  assert.throws(() => conv("{bad"), SyntaxError);
  assert.throws(() => conv(""), SyntaxError);
});
