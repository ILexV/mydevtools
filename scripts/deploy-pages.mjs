#!/usr/bin/env node
/**
 * Publish `apps/site/dist` to the `gh-pages` branch.
 *
 * Strategy: copy dist into an ISOLATED temp git repo, commit it there, then
 * force-push HEAD to origin:gh-pages. The main working tree and branches are
 * never touched. No `gh-pages` npm dependency — pure git.
 *
 *   node scripts/deploy-pages.mjs            → DRY RUN (verify artifact, no push)
 *   node scripts/deploy-pages.mjs --push     → actually publish to origin:gh-pages
 *
 * GitHub Pages must be configured: Settings → Pages → Source = branch `gh-pages`
 * → root `/`. The site is then served at https://<user>.github.io/<repo>/,
 * matching `base: "/mydevtools/"` in astro.config.mjs.
 *
 * The push authenticates through your normal git credential helper (token /
 * SSH). This script stores no secrets.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "apps", "site", "dist");
const push = process.argv.includes("--push");

// ── 1. Verify the built artifact is complete ────────────────────────────────
const must = (p, label) => {
  if (!existsSync(join(dist, p))) {
    console.error(`✘ dist missing ${label}: ${p}`);
    console.error("  Run `npm run build:pages` first.");
    process.exit(1);
  }
};
must("index.html", "root index");
must("manifest.webmanifest", "manifest");
must("sw.js", "service worker");
must("offline/index.html", "offline page");
must("404.html", "404 page");
must("icons/icon-512.png", "icon");
// Without this GitHub Pages runs Jekyll, which skips `_astro/` → all CSS/JS 404.
must(".nojekyll", "Jekyll bypass marker");
const LANGS = ["en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"];
const missingLangs = LANGS.filter((l) => !existsSync(join(dist, l, "index.html")));
if (missingLangs.length) {
  console.error(`✘ Missing locale homes: ${missingLangs.join(", ")}`);
  process.exit(1);
}

// ── 2. Resolve origin ───────────────────────────────────────────────────────
const origin = spawnSync("git", ["remote", "get-url", "origin"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
if (!origin) {
  console.error("✘ no `origin` git remote");
  process.exit(1);
}

// ── 3. Build the deploy commit in an isolated temp repo ─────────────────────
const tmp = join(tmpdir(), `mdt-ghpages-${Date.now()}`);
rmSync(tmp, { recursive: true, force: true });
cpSync(dist, tmp, { recursive: true });

const git = (args, opts = {}) =>
  spawnSync("git", args, { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
git(["init", "-q"]);
git(["config", "user.name", "mydevtools-deploy"]);
git(["config", "user.email", "deploy@mydevtools.local"]);
git(["config", "commit.gpgsign", "false"]);
git(["add", "-A"]);
const stamp = new Date().toISOString();
const commit = git(["commit", "-q", "-m", `Deploy MyDevTools ${stamp}`]);
if (commit.status !== 0) {
  console.error("✘ deploy commit failed:\n", commit.stderr);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// ── 4. Summary ──────────────────────────────────────────────────────────────
const countFiles = (d) => {
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    n += e.isDirectory() ? countFiles(join(d, e.name)) : 1;
  }
  return n;
};
const fileCount = countFiles(tmp);
const precache = (readFileSync(join(tmp, "sw.js"), "utf8").match(/"url":"/g) || []).length;
const head = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
console.log(`✓ Deploy artifact ready`);
console.log(`  files:     ${fileCount}`);
console.log(`  sw precache: ${precache} entries`);
console.log(`  commit:    ${head}  (${stamp})`);
console.log(`  target:    ${origin}  →  gh-pages (root /)`);

if (!push) {
  console.log("\nDRY RUN — nothing was pushed.");
  console.log("To publish:  npm run deploy:pages -- --push");
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

// ── 5. Force-push to gh-pages ───────────────────────────────────────────────
console.log("\nPushing HEAD → origin:gh-pages (force)…");
const pushed = spawnSync("git", ["push", "--force", origin, "HEAD:gh-pages"], {
  cwd: tmp,
  stdio: "inherit",
});
rmSync(tmp, { recursive: true, force: true });
if (pushed.status !== 0) {
  console.error("✘ push failed (check credentials / network).");
  process.exit(1);
}
console.log("\n✓ Published to gh-pages. GitHub Pages updates within ~1 min.");
console.log("  Verify: Settings → Pages → branch `gh-pages` / root, then open the Pages URL.");
