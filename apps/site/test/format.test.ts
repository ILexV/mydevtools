import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatString,
  formatPlural,
  pluralSuffix,
  formatBytes,
  formatMs,
  progressPercent,
} from "../src/lib/format.ts";

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

test("formatBytes: default precision (1 digit, 2 from GB)", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.00 GB");
  assert.equal(formatBytes(2 * 1024 ** 4), "2.00 TB");
});

test("formatBytes: fixed precision and invalid input", () => {
  assert.equal(formatBytes(1536, 2), "1.50 KB");
  assert.equal(formatBytes(500, 2), "500 B");
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
});

test("formatMs: ms below a second, seconds above", () => {
  assert.equal(formatMs(0), "0 ms");
  assert.equal(formatMs(849.6), "850 ms");
  assert.equal(formatMs(1250), "1.25 s");
  assert.equal(formatMs(-5), "0 ms");
});

test("progressPercent: clamps and handles empty totals", () => {
  assert.equal(progressPercent(50, 200), 25);
  assert.equal(progressPercent(300, 200), 100);
  assert.equal(progressPercent(-1, 200), 0);
  assert.equal(progressPercent(10, 0), 0);
  assert.equal(progressPercent(Number.NaN, 10), 0);
});
