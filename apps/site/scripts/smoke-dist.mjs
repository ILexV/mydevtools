// Static dist smoke test: verifies built artifacts exist and contain the
// expected content. Run AFTER `astro build` (+ build-sw). No server needed —
// reads `dist/` directly, so it's fast and zero-dependency.
//
// Invoked by `npm run test:smoke` and the `npm run verify` chain.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  assert.equal(read("CNAME").trim(), "mydevtools.app", "custom domain CNAME");
  const key = readdirSync(DIST).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  assert.ok(key && read(key).trim() === key.slice(0, 32), "IndexNow key file");
});

test("custom domain: assets, canonical and sitemap use the mydevtools.app root", { skip }, () => {
  const html = read("ru/index.html");
  assert.match(html, /href="\/_astro\/[^"]+\.css"/, "root-relative stylesheet");
  assert.ok(!html.includes("/mydevtools/"), "no stale /mydevtools/ subpath");
  assert.ok(html.includes('rel="canonical" href="https://mydevtools.app/ru/"'), "canonical on custom domain");
  assert.ok(read("sitemap.xml").includes("<loc>https://mydevtools.app/en/</loc>"), "sitemap on custom domain");
});

test("manifest: valid, base-aware, has 192 + 512 icons", { skip }, () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.start_url, "/?source=pwa");
  assert.equal(m.scope, "/");
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
  assert.ok(sw.includes('"/offline/"'), "root-based offline URL");
  assert.ok(!sw.includes("/mydevtools/"), "no stale GitHub Pages subpath");
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

test("og:image: tool page card is a 1200×630 PNG ≤ 80 KB, not precached", { skip }, () => {
  const ogPath = (html) => {
    const m = html.match(/<meta property="og:image" content="https:\/\/mydevtools\.app\/([^"]+)"/);
    assert.ok(m, "og:image meta with an absolute mydevtools.app URL");
    return m[1];
  };
  const rel = ogPath(read("ru/hash-calculator/index.html"));
  assert.equal(rel, "og/ru/hash-calculator.png");
  // CJK/Devanagari locales get their own cards (build-only Noto fonts).
  assert.equal(ogPath(read("ja/hash-calculator/index.html")), "og/ja/hash-calculator.png");
  assert.ok(has("og/en/home.png"), "home card");
  assert.ok(has("og/hi/home.png"), "Devanagari home card");
  const png = readFileSync(new URL(rel, DIST));
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG", "PNG signature");
  assert.equal(png.readUInt32BE(16), 1200, "width");
  assert.equal(png.readUInt32BE(20), 630, "height");
  assert.ok(png.length <= 80 * 1024, `card size ${png.length} B ≤ 80 KB`);
  assert.ok(!read("sw.js").includes("/og/"), "share cards are not precached");
});
