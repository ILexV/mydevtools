import { test } from "node:test";
import assert from "node:assert/strict";
import { formatString, formatPlural, pluralSuffix } from "../src/lib/format.ts";

test("formatString: positional {0}/{1} replacement", () => {
  assert.equal(formatString("Decoded {0} → {1}", "a.bin", "b.bin"), "Decoded a.bin → b.bin");
  assert.equal(formatString("limit {0}", 42), "limit 42");
});

test("formatString: unknown indices stay intact, extra values ignored", () => {
  assert.equal(formatString("{0} {1} {2}", "a", "b"), "a b {2}");
  assert.equal(formatString("{0}", "a", "b"), "a");
});

test("pluralSuffix: en one/other, ru one/few/many", () => {
  assert.equal(pluralSuffix("en", 1), "one");
  assert.equal(pluralSuffix("en", 2), "other");
  assert.equal(pluralSuffix("ru", 1), "one");
  assert.equal(pluralSuffix("ru", 21), "one");
  assert.equal(pluralSuffix("ru", 2), "few");
  assert.equal(pluralSuffix("ru", 5), "many");
});

test("formatPlural: picks the locale variant and interpolates n as {0}", () => {
  const ru = {
    everyMin: "Каждые {0} минут",
    everyMin_one: "Каждые {0} минуту",
    everyMin_few: "Каждые {0} минуты",
    everyMin_many: "Каждые {0} минут",
  };
  assert.equal(formatPlural(ru, "everyMin", 1, "ru"), "Каждые 1 минуту");
  assert.equal(formatPlural(ru, "everyMin", 3, "ru"), "Каждые 3 минуты");
  assert.equal(formatPlural(ru, "everyMin", 5, "ru"), "Каждые 5 минут");
  assert.equal(formatPlural(ru, "everyMin", 21, "ru"), "Каждые 21 минуту");
});

test("formatPlural: falls back to base key, then to the raw key", () => {
  const en = { everyMin: "Every {0} minutes" };
  assert.equal(formatPlural(en, "everyMin", 1, "en"), "Every 1 minutes");
  assert.equal(formatPlural(en, "missing", 3, "en"), "missing");
  // Non-string values (arrays in islands) never crash the lookup.
  assert.equal(formatPlural({ x: ["a", "b"] }, "x", 2, "en"), "x");
});
