import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBase,
  joinBase,
  localizedPathFor,
  absoluteUrlFor,
} from "../src/lib/urlPath.ts";

test("normalizeBase: ensures leading + trailing slash", () => {
  assert.equal(normalizeBase("mydevtools"), "/mydevtools/");
  assert.equal(normalizeBase("/mydevtools"), "/mydevtools/");
  assert.equal(normalizeBase("/mydevtools/"), "/mydevtools/");
  assert.equal(normalizeBase("/"), "/");
});

test("joinBase: leading-slash agnostic", () => {
  assert.equal(joinBase("/mydevtools/", "icons/x.png"), "/mydevtools/icons/x.png");
  assert.equal(joinBase("/mydevtools/", "/icons/x.png"), "/mydevtools/icons/x.png");
  assert.equal(joinBase("/mydevtools/", "sw.js"), "/mydevtools/sw.js");
});

test("localizedPathFor: locale home + tool path", () => {
  assert.equal(localizedPathFor("/mydevtools/", "en"), "/mydevtools/en/");
  assert.equal(localizedPathFor("/mydevtools/", "ru", "hash-calculator"), "/mydevtools/ru/hash-calculator/");
  // stray slashes on the tool path are collapsed
  assert.equal(localizedPathFor("/mydevtools/", "es", "/a/b/"), "/mydevtools/es/a/b/");
});

test("absoluteUrlFor: resolves against origin without re-adding base", () => {
  assert.equal(absoluteUrlFor("https://ilexv.github.io", "/mydevtools/en/"), "https://ilexv.github.io/mydevtools/en/");
  assert.equal(absoluteUrlFor("https://ilexv.github.io/", "/mydevtools/en/x/"), "https://ilexv.github.io/mydevtools/en/x/");
});
