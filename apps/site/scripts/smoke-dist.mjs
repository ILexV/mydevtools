// Static dist smoke test: verifies built artifacts exist and contain the
// expected content. Run AFTER `astro build` (+ build-sw). No server needed —
// reads `dist/` directly, so it's fast and zero-dependency.
//
// Invoked by `npm run test:smoke` and the `npm run verify` chain.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DIST = new URL("../dist/", import.meta.url);
const present = existsSync(DIST);
const skip = present ? false : "no dist — run `npm run build` first";
const has = (p) => existsSync(new URL(p, DIST));
const read = (p) => readFileSync(new URL(p, DIST), "utf8");

const LANGS = ["en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"];

test("dist: every locale home + offline + 404 + manifest + sw + icons", { skip }, () => {
  for (const lang of LANGS) assert.ok(has(`${lang}/index.html`), `home ${lang}`);
  assert.ok(has("en/hash-calculator/index.html"), "tool route");
  assert.ok(has("offline/index.html"), "offline page");
  assert.ok(has("404.html"), "404 page");
  assert.ok(has("manifest.webmanifest"), "manifest");
  assert.ok(has("sw.js"), "service worker");
  assert.ok(has("icons/icon-192.png"), "icon 192");
  assert.ok(has("icons/icon-512.png"), "icon 512");
});

test("manifest: valid, base-aware, has 192 + 512 icons", { skip }, () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.start_url, "/mydevtools/?source=pwa");
  assert.equal(m.scope, "/mydevtools/");
  assert.ok(m.icons.length >= 2, ">= 2 icons");
  assert.ok(m.icons.some((i) => i.sizes === "192x192"), "has 192");
  assert.ok(m.icons.some((i) => i.sizes === "512x512"), "has 512");
});

test("sw.js: no leftover placeholders, versioned precache, base-prefixed", { skip }, () => {
  const sw = read("sw.js");
  assert.ok(!sw.includes("__PRECACHE_MANIFEST__"), "no PRECACHE placeholder");
  assert.ok(!sw.includes("__CACHE_VERSION__"), "no VERSION placeholder");
  assert.ok(!sw.includes("__OFFLINE_URL__"), "no OFFLINE placeholder");
  assert.ok(sw.includes("mdt-sw-precache-"), "versioned precache cache name");
  assert.ok(sw.includes("/mydevtools/"), "base-prefixed precache URLs");
});

test("JSON-LD: WebSite on home, SoftwareApplication on tool", { skip }, () => {
  const home = read("en/index.html");
  const tool = read("en/hash-calculator/index.html");
  assert.match(home, /application\/ld\+json/);
  assert.match(home, /"WebSite"/);
  assert.match(tool, /application\/ld\+json/);
  assert.match(tool, /"SoftwareApplication"/);
});

test("offline page: fallback copy present", { skip }, () => {
  assert.match(read("offline/index.html"), /offline/i);
});
