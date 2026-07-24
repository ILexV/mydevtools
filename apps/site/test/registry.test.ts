import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCALES,
  LOCALE_CODES,
  DEFAULT_LOCALE,
  isLocaleCode,
  getLocale,
} from "../src/registry/locales.ts";
import {
  CATEGORIES,
  CATEGORY_IDS,
  isCategoryId,
  getCategory,
} from "../src/registry/categories.ts";
import {
  TOOLS,
  TOOL_COUNT,
  toolNamespace,
  getTool,
  toolsByCategory,
  allLocalizedRoutes,
} from "../src/registry/tools.ts";
import { lintRegistry } from "../src/registry/validate.ts";

// ── locales ────────────────────────────────────────────────────────────────
test("locales: 10 supported, unique codes, default en", () => {
  assert.equal(LOCALES.length, 10);
  assert.equal(DEFAULT_LOCALE, "en");
  const codes = LOCALES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, "locale codes unique");
  assert.ok(codes.includes("en"));
  assert.deepEqual([...LOCALE_CODES], codes);
});

test("locales: every entry has required metadata", () => {
  for (const l of LOCALES) {
    assert.ok(l.nativeName, `${l.code} nativeName`);
    assert.ok(l.englishName, `${l.code} englishName`);
    assert.ok(l.bcp47, `${l.code} bcp47`);
    assert.ok(l.ogLocale, `${l.code} ogLocale`);
    assert.ok(l.dir === "ltr" || l.dir === "rtl", `${l.code} dir`);
  }
});

test("isLocaleCode / getLocale", () => {
  assert.equal(isLocaleCode("en"), true);
  assert.equal(isLocaleCode("xx"), false);
  assert.equal(getLocale("ru")?.nativeName, "Русский");
  assert.equal(getLocale("xx"), undefined);
});

// ── categories ─────────────────────────────────────────────────────────────
test("categories: 13, unique ids + orders", () => {
  assert.equal(CATEGORIES.length, 13);
  const ids = CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "category ids unique");
  const orders = CATEGORIES.map((c) => c.order);
  assert.equal(new Set(orders).size, orders.length, "category orders unique");
});

test("isCategoryId / getCategory", () => {
  assert.equal(isCategoryId("encoding"), true);
  assert.equal(isCategoryId("nope"), false);
  assert.ok(getCategory("pdf"));
  assert.equal(getCategory("nope"), undefined);
});

// ── tools ──────────────────────────────────────────────────────────────────
test("tools: 39, unique slugs, non-empty", () => {
  assert.equal(TOOL_COUNT, 39);
  assert.equal(TOOLS.length, 39);
  const slugs = TOOLS.map((t) => t.slug);
  assert.equal(new Set(slugs).size, slugs.length, "tool slugs unique");
  for (const t of TOOLS) assert.ok(t.slug, "slug non-empty");
});

test("tools: every tool has a known category", () => {
  for (const t of TOOLS) {
    assert.ok(isCategoryId(t.category), `${t.slug} → bad category ${t.category}`);
  }
});

test("toolNamespace / getTool / toolsByCategory / allLocalizedRoutes", () => {
  assert.equal(toolNamespace("hash-calculator"), "tools/hash-calculator");
  assert.ok(getTool("hash-calculator"));
  assert.equal(getTool("nope"), undefined);
  assert.ok(toolsByCategory("encoding").length >= 1);

  const routes = allLocalizedRoutes(LOCALE_CODES);
  assert.equal(routes.length, 39 * 10, "39 tools × 10 locales");
  assert.ok(routes.every((r) => isLocaleCode(r.lang) && getTool(r.slug)));
});

// ── registry self-consistency (validate.ts) ────────────────────────────────
test("lintRegistry: healthy registry → no issues", () => {
  assert.deepEqual(lintRegistry(), []);
});

test("lintRegistry: flags locale-count mismatch", () => {
  const issues = lintRegistry(["en", "ru"]); // only 2 passed → must flag the 10-locale invariant
  assert.ok(issues.some((i) => i.message.includes("expected 10 locales")));
});
