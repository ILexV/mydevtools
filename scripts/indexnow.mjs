#!/usr/bin/env node
/**
 * IndexNow: tell Bing, Yandex, Seznam, Naver, Yep… which pages changed, so they
 * recrawl in days instead of weeks (Google does not use IndexNow).
 *
 * Key: `apps/site/public/<32-hex>.txt` containing the key itself (served at the
 * site root). Host: `dist/CNAME`. URLs: the sitemap's <loc> list.
 *
 * Change detection: each sitemap page's HTML in the new dist is compared with
 * the copy on origin/gh-pages, ignoring hashed `/_astro/` asset names, so a CSS
 * rebuild alone doesn't resubmit all 400 pages. Used by deploy-pages.mjs after
 * a push; standalone:
 *   node scripts/indexnow.mjs            → dry run: list changed URLs
 *   node scripts/indexnow.mjs --submit   → submit changed URLs
 *   node scripts/indexnow.mjs --all --submit → submit every sitemap URL
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "apps", "site", "dist");
const ENDPOINT = "https://api.indexnow.org/indexnow";

/** IndexNow key + host + sitemap URLs of the built dist. */
export function readSite(distDir = dist) {
  const keyFile = readdirSync(distDir).find(
    (f) => /^[0-9a-f]{32}\.txt$/.test(f) && readFileSync(join(distDir, f), "utf8").trim() === f.slice(0, 32),
  );
  if (!keyFile) throw new Error("no IndexNow key file (<32-hex>.txt) in dist");
  const host = readFileSync(join(distDir, "CNAME"), "utf8").trim();
  const urls = [...readFileSync(join(distDir, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return { key: keyFile.slice(0, 32), host, urls };
}

/** dist-relative HTML file of a sitemap URL: https://host/ru/x/ → ru/x/index.html */
const htmlPath = (url) => `${new URL(url).pathname.replace(/^\/+/, "")}index.html`;

// Hashed asset names change on every style/script rebuild; page text doesn't.
const normalize = (html) => html.replace(/\/_astro\/[^"'\s)]+/g, "/_astro/*");

/** Sitemap URLs whose HTML differs from origin/gh-pages (all of them if it's unreachable). */
export function changedUrls(urls, distDir = dist) {
  const fetched = spawnSync("git", ["fetch", "-q", "origin", "gh-pages"], { cwd: root, stdio: "ignore" });
  if (fetched.status !== 0) return urls;
  const paths = urls.map(htmlPath);
  // One `cat-file --batch` for all pages instead of 400 `git show` spawns.
  const batch = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: paths.map((p) => `FETCH_HEAD:${p}`).join("\n") + "\n",
    maxBuffer: 1 << 30,
  });
  if (batch.status !== 0) return urls;
  const buf = batch.stdout;
  const previous = new Map();
  let at = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString();
    at = nl + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    previous.set(p, buf.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return urls.filter((url) => {
    const p = htmlPath(url);
    const before = previous.get(p);
    return before === undefined || normalize(before) !== normalize(readFileSync(join(distDir, p), "utf8"));
  });
}

/**
 * Submit URLs once the key file is live (search engines verify it when they
 * process the batch). Waits up to ~3 min for GitHub Pages to publish it.
 */
export async function submit({ key, host, urls }) {
  if (!urls.length) return { status: "skipped", count: 0 };
  const keyLocation = `https://${host}/${key}.txt`;
  for (let i = 0; i < 36; i++) {
    const res = await fetch(`${keyLocation}?t=${Date.now()}`).catch(() => null);
    if (res?.ok && (await res.text()).trim() === key) break;
    if (i === 35) throw new Error(`key file not live: ${keyLocation}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const body = JSON.stringify({ host, key, keyLocation, urlList: urls.slice(0, 10000) });
  // A new key answers 403 SiteVerificationNotCompleted until the engine has
  // fetched it: retry for up to ~5 min instead of failing the first deploy.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body });
    // 200 OK / 202 Accepted (key validation pending) are both success.
    if (res.status === 200 || res.status === 202) return { status: res.status, count: urls.length };
    const text = (await res.text()).slice(0, 300);
    if (res.status !== 403 || !text.includes("SiteVerificationNotCompleted") || attempt >= 10) {
      throw new Error(`IndexNow HTTP ${res.status}: ${text}`);
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(join(dist, "sitemap.xml"))) {
    console.error("✘ no dist — run `npm run build:pages` first");
    process.exit(1);
  }
  const site = readSite();
  const urls = process.argv.includes("--all") ? site.urls : changedUrls(site.urls);
  console.log(`IndexNow: ${urls.length}/${site.urls.length} URLs for ${site.host}`);
  for (const u of urls.slice(0, 20)) console.log(`  ${u}`);
  if (urls.length > 20) console.log(`  … +${urls.length - 20}`);
  if (process.argv.includes("--submit")) {
    const r = await submit({ ...site, urls });
    console.log(`✓ submitted ${r.count} (HTTP ${r.status})`);
  }
}
