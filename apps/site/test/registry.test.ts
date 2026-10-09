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
  toolNamespace,
  getTool,
  toolsByCategory,
  allLocalizedRoutes,
} from "../src/registry/tools.ts";
import { lintRegistry } from "../src/registry/validate.ts";
import { relatedSlugs, CATEGORY_NEIGHBOURS, RELATED_COUNT } from "../src/registry/related.ts";

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

test("tools: every tool has a known category", () => {
  for (const t of TOOLS) {
    assert.ok(isCategoryId(t.category), `${t.slug} → bad category ${t.category}`);
  }
});

// Monograms tell sibling cards apart in the catalog tile: short, unique, no emoji.
test("tools: every tool has a unique short monogram without emoji", () => {
  const seen = new Set<string>();
  for (const tool of TOOLS) {
    const len = [...tool.monogram].length;
    assert.ok(len >= 1 && len <= 4, `${tool.slug} monogram length ${len}`);
    assert.ok(!/\p{Emoji_Presentation}/u.test(tool.monogram), `${tool.slug} monogram has emoji`);
    assert.ok(!seen.has(tool.monogram), `${tool.slug} monogram "${tool.monogram}" duplicated`);
    seen.add(tool.monogram);
  }
});

test("toolNamespace / getTool / toolsByCategory / allLocalizedRoutes", () => {
  assert.equal(toolNamespace("hash-calculator"), "tools/hash-calculator");
  assert.ok(getTool("hash-calculator"));
  assert.equal(getTool("nope"), undefined);
  assert.ok(toolsByCategory("encoding").length >= 1);

  const routes = allLocalizedRoutes(LOCALE_CODES);
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

// ── related tools (related.ts → catalog.relatedTools) ──────────────────────
test("relatedSlugs: every tool gets 3–4 known tools, never itself, no duplicates", () => {
  assert.ok(RELATED_COUNT >= 3 && RELATED_COUNT <= 4);
  for (const tool of TOOLS) {
    const rel = relatedSlugs(tool.slug);
    assert.ok(rel.length >= 3 && rel.length <= 4, `${tool.slug}: ${rel.length} related`);
    assert.ok(!rel.includes(tool.slug), `${tool.slug} lists itself`);
    assert.equal(new Set(rel).size, rel.length, `${tool.slug} has duplicates`);
    assert.ok(rel.every((s) => getTool(s)), `${tool.slug} lists an unknown slug`);
  }
});

test("relatedSlugs: same category first, then neighbouring categories", () => {
  for (const tool of TOOLS) {
    const cats = relatedSlugs(tool.slug).map((s) => getTool(s)!.category);
    const firstOther = cats.findIndex((c) => c !== tool.category);
    if (firstOther === -1) continue;
    assert.ok(cats.slice(firstOther).every((c) => c !== tool.category), `${tool.slug}: siblings not first`);
    const siblings = toolsByCategory(tool.category).length - 1;
    assert.equal(firstOther, Math.min(siblings, RELATED_COUNT), `${tool.slug}: siblings missing`);
    assert.ok(
      cats.slice(firstOther).every((c) => CATEGORY_NEIGHBOURS[tool.category].includes(c)),
      `${tool.slug}: fill outside neighbouring categories`,
    );
  }
  assert.deepEqual(relatedSlugs("password-generator").slice(0, 1), ["hash-calculator"]);
});

test("relatedSlugs: deterministic, respects limit, unknown slug → []", () => {
  for (const tool of TOOLS) assert.deepEqual(relatedSlugs(tool.slug), relatedSlugs(tool.slug));
  assert.equal(relatedSlugs("json-beautifier", 2).length, 2);
  assert.deepEqual(relatedSlugs("no-such-tool"), []);
  assert.deepEqual(relatedSlugs("json-beautifier", 0), []);
});

test("CATEGORY_NEIGHBOURS: every category mapped, no self-reference, known ids", () => {
  for (const id of CATEGORY_IDS) {
    const n = CATEGORY_NEIGHBOURS[id];
    assert.ok(n && n.length > 0, `${id} has neighbours`);
    assert.ok(!n.includes(id), `${id} lists itself`);
    assert.ok(n.every((c) => isCategoryId(c)), `${id} has unknown neighbour`);
  }
});
