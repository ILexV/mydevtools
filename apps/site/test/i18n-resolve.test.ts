import { test } from "node:test";
import assert from "node:assert/strict";
import { lookup, interpolate, translate } from "../src/i18n/resolve.ts";

const msgs = {
  en: { common: { Hello: "Hello {name}", nested: { a: "deep" }, count: 5 } },
  ru: { common: { Hello: "Привет {name}" } },
};

test("lookup: dotted path, missing, non-string leaf", () => {
  assert.equal(lookup(msgs.en.common, "Hello"), "Hello {name}");
  assert.equal(lookup(msgs.en.common, "nested.a"), "deep");
  assert.equal(lookup(msgs.en.common, "missing"), undefined);
  assert.equal(lookup(msgs.en.common, "count"), undefined, "non-string leaf is not a value");
  assert.equal(lookup(undefined, "x"), undefined);
});

test("interpolate: {name} placeholders, unknown left intact", () => {
  assert.equal(interpolate("Hi {name}", { name: "X" }), "Hi X");
  assert.equal(interpolate("{a}{b}", { a: 1, b: 2 }), "12");
  assert.equal(interpolate("{x}", {}), "{x}");
  assert.equal(interpolate("no placeholders"), "no placeholders");
  assert.equal(interpolate("plain", undefined), "plain");
});

test("translate: lang → fallback → raw key chain", () => {
  // exact language hit + interpolation
  assert.equal(translate(msgs, "ru", "en", "common", "Hello", { params: { name: "X" } }), "Привет X");
  // missing lang → fallback (en)
  assert.equal(translate(msgs, "de", "en", "common", "Hello", { params: { name: "Y" } }), "Hello Y");
  // both missing → raw key returned
  assert.equal(translate(msgs, "de", "fr", "common", "Nope"), "Nope");
  // lang === fallback: no double-lookup, template left intact without params
  assert.equal(translate(msgs, "en", "en", "common", "Hello"), "Hello {name}");
});
