#!/usr/bin/env node
/**
 * build-sw.mjs — generate dist/sw.js for the MyDevTools PWA.
 *
 * Run AFTER `astro build`, from apps/site/ (cwd = apps/site):
 *   node build-sw.mjs
 *
 * Walks dist/, builds a precache manifest (static root files, the offline
 * page, locale home pages, all non-_astro images, and every _astro asset
 * referenced by the precached HTML), injects it into scripts/sw-template.js,
 * and writes dist/sw.js. Idempotent, deterministic, no dependencies.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES = ["en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"];
const IMG_EXT = new Set([".png", ".svg", ".ico", ".webp"]);

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const DIST = resolve(ROOT, "dist");

// 1. Verify dist exists.
if (!existsSync(DIST)) {
  console.error(`build-sw: dist not found at ${DIST} — run \`astro build\` first.`);
  process.exit(1);
}

// 2. Read `base` from astro.config.mjs via regex (no Astro import); default /mydevtools/.
let base = "/mydevtools/";
try {
  const cfg = await readFile(resolve(ROOT, "astro.config.mjs"), "utf8");
  const m = cfg.match(/base\s*:\s*["']([^"']+)["']/);
  if (m && m[1]) base = m[1];
} catch {
  /* fall back to default */
}
// Normalize to leading + trailing slash.
if (!base.startsWith("/")) base = "/" + base;
if (!base.endsWith("/")) base = base + "/";

/** Convert a dist-relative platform path to a posix path (URL-safe). */
function toPosix(p) {
  return p.split(sep).join("/");
}

/** Absolute path for a dist-relative posix path. */
function distAbs(posixRel) {
  return join(DIST, ...posixRel.split("/"));
}

// 3. Build the set of dist-relative posix precache paths.
const precachePaths = new Set();

/** Add a dist-relative posix path if its file exists. */
async function addIfExists(posixRel) {
  try {
    const s = await stat(distAbs(posixRel));
    if (s.isFile()) precachePaths.add(posixRel);
  } catch {
    /* missing file — skip gracefully */
  }
}

/** Walk a directory recursively, yielding absolute file paths. */
async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs);
    } else if (entry.isFile()) {
      yield abs;
    }
  }
}

// Explicit root files.
await addIfExists("manifest.webmanifest");
await addIfExists("offline/index.html");
for (const l of LOCALES) await addIfExists(`${l}/index.html`);

// All non-_astro images anywhere in dist.
for await (const abs of walk(DIST)) {
  const rel = toPosix(abs.slice(DIST.length + 1)); // dist-relative posix
  if (rel.startsWith("_astro/")) continue;
  const dot = rel.lastIndexOf(".");
  if (dot === -1) continue;
  if (IMG_EXT.has(rel.slice(dot).toLowerCase())) precachePaths.add(rel);
}

// 3b. Parse precached HTML files for _astro asset references.
const REF_RE = /(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Resolve a possibly-relative/absolute ref to a dist-relative posix _astro path. */
function resolveAstroRef(rawValue, htmlDirPosix) {
  if (!rawValue) return null;
  let v = rawValue.split("#")[0].split("?")[0];
  if (!v.includes("_astro/")) return null;

  if (v.startsWith(base)) {
    // Absolute base-prefixed: /mydevtools/_astro/x → _astro/x
    v = v.slice(base.length);
  } else if (v.startsWith("/")) {
    // Absolute without/with base: slice from the _astro/ segment.
    v = v.slice(v.indexOf("_astro/"));
  } else {
    // Relative (./ , ../ , or bare): resolve against the HTML file's dir.
    v = posixResolve(htmlDirPosix, v);
    const idx = v.indexOf("_astro/");
    if (idx === -1) return null;
    v = v.slice(idx);
  }
  return v.startsWith("_astro/") ? v : null;
}

function posixResolve(dir, rel) {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

for (const rel of [...precachePaths]) {
  if (!rel.endsWith(".html")) continue;
  const html = await readFile(distAbs(rel), "utf8").catch(() => "");
  if (!html) continue;
  const htmlDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(html)) !== null) {
    const ref = resolveAstroRef(m[1] || m[2], htmlDir);
    if (ref) await addIfExists(ref);
  }
}

// 3c. Build entries (sorted by URL) and compute revisions + total bytes.
const sortedPaths = [...precachePaths].sort();
const entries = [];
let totalBytes = 0;
for (const rel of sortedPaths) {
  const bytes = await readFile(distAbs(rel));
  totalBytes += bytes.length;
  const revision = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
  entries.push({ url: base + rel, revision });
}

// 4. OFFLINE_URL = base + "offline/". Ensure it is itself precache-matchable
//    (the SW's navigation fallback serves it from PRECACHE). If the offline
//    page exists, add its trailing-slash navigation URL alongside the file URL.
const OFFLINE_URL = base + "offline/";
if (precachePaths.has("offline/index.html")) {
  const bytes = await readFile(distAbs("offline/index.html"));
  const revision = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
  entries.push({ url: OFFLINE_URL, revision });
}

// Deterministic version over the sorted manifest.
entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
const CACHE_VERSION = createHash("sha1").update(JSON.stringify(entries)).digest("hex").slice(0, 8);

// 5. Inject placeholders into the template and write dist/sw.js.
const template = await readFile(resolve(ROOT, "scripts", "sw-template.js"), "utf8");
const sw = template
  .split("__PRECACHE_MANIFEST__").join(JSON.stringify(entries))
  .split("__CACHE_VERSION__").join(JSON.stringify(CACHE_VERSION))
  .split("__OFFLINE_URL__").join(JSON.stringify(OFFLINE_URL));

// Guard: no placeholder may survive.
const leftover = sw.match(/__[A-Z_]+__/);
if (leftover) {
  console.error(`build-sw: unreplaced placeholder in sw.js: ${leftover[0]}`);
  process.exit(1);
}

await writeFile(resolve(DIST, "sw.js"), sw, "utf8");

const swBytes = Buffer.byteLength(sw, "utf8");
console.log(
  `build-sw: precached ${entries.length} files (${totalBytes} bytes), ` +
    `wrote dist/sw.js (${swBytes} bytes), version ${CACHE_VERSION}, base ${base}`
);
