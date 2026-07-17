#!/usr/bin/env node
/**
 * Locale validator (Stage 5) — replaces the legacy .NET LocalizationValidator.
 * Run: `npm run validate:i18n -w @mydevtools/site`.
 *
 * Checks (exits nonzero on any error):
 *  1. Every JSON file parses.
 *  2. Every locale has the SAME namespace set as `en` (the canonical locale):
 *     shared (common/home/categories) + tools/<slug>.
 *  3. Shared namespaces have the SAME key set across all locales.
 *  4. No empty string values anywhere.
 *  5. Warnings (non-fatal): tool Title/Description left in English for non-en.
 *
 * The expected namespace set is derived from the `en/` directory (source of
 * truth), NOT from the TS registry — so this script has no TypeScript build
 * dependency and runs anywhere Node does.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const LOCALES_DIR = fileURLToPath(new URL("../src/i18n/locales/", import.meta.url));
const CANONICAL = "en";

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  errors++;
}
function warn(msg) {
  console.warn(`  ⚠ ${msg}`);
  warnings++;
}

async function readJson(file) {
  try {
    const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch (e) {
    fail(`${file}: ${e.message}`);
    return null;
  }
}

/** Collect namespace paths relative to a locale dir, e.g. ["common", "tools/base64-encoder"]. */
async function namespaceSet(localeDir) {
  const out = new Set();
  for (const entry of await readdir(localeDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      out.add(entry.name.slice(0, -5));
    } else if (entry.isDirectory()) {
      const sub = join(localeDir, entry.name);
      for (const subEntry of await readdir(sub, { withFileTypes: true })) {
        if (subEntry.isFile() && subEntry.name.endsWith(".json")) {
          out.add(`${entry.name}/${subEntry.name.slice(0, -5)}`);
        }
      }
    }
  }
  return out;
}

function findEmpty(obj, path, file) {
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (v === "") fail(`${file}: empty value at ${p}`);
    else if (v && typeof v === "object") findEmpty(v, p, file);
  }
}

const locales = (await readdir(LOCALES_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (!locales.includes(CANONICAL)) {
  console.error(`Canonical locale "${CANONICAL}" missing from ${LOCALES_DIR}`);
  process.exit(1);
}

// Canonical namespace + shared-namespace key sets from en.
const canonicalNs = await namespaceSet(join(LOCALES_DIR, CANONICAL));
const sharedNs = [...canonicalNs].filter((ns) => !ns.startsWith("tools/"));
const canonicalKeys = {};
for (const ns of sharedNs) {
  const data = await readJson(join(LOCALES_DIR, CANONICAL, `${ns}.json`));
  if (data) canonicalKeys[ns] = new Set(Object.keys(data));
}
const enToolTitles = {};
for (const ns of canonicalNs) {
  if (!ns.startsWith("tools/")) continue;
  const data = await readJson(join(LOCALES_DIR, CANONICAL, `${ns}.json`));
  if (data) enToolTitles[ns] = { Title: data.Title, Description: data.Description };
}

console.log(`Locales: ${locales.join(", ")} (${canonicalNs.size} namespaces in ${CANONICAL})`);

for (const locale of locales) {
  const dir = join(LOCALES_DIR, locale);
  const ns = await namespaceSet(dir);

  // Missing / extra namespaces vs canonical.
  for (const missing of canonicalNs) {
    if (!ns.has(missing)) fail(`${locale}: missing namespace ${missing}.json`);
  }
  for (const extra of ns) {
    if (!canonicalNs.has(extra)) fail(`${locale}: extra namespace ${extra}.json (not in ${CANONICAL})`);
  }

  // Shared-namespace key parity + empty values, every namespace.
  for (const name of ns) {
    const file = join(dir, ...name.split("/")) + ".json";
    const data = await readJson(file);
    if (!data) continue;
    findEmpty(data, "", `${locale}/${name}`);
    if (sharedNs.includes(name) && canonicalKeys[name]) {
      const keys = new Set(Object.keys(data));
      for (const k of canonicalKeys[name]) {
        if (!keys.has(k)) fail(`${locale}/${name}: missing key "${k}"`);
      }
      for (const k of keys) {
        if (!canonicalKeys[name].has(k)) fail(`${locale}/${name}: extra key "${k}"`);
      }
    }
    // Untranslated tool title/description (warning only).
    if (locale !== CANONICAL && name.startsWith("tools/") && enToolTitles[name]) {
      if (data.Title && data.Title === enToolTitles[name].Title) {
        warn(`${locale}/${name}: Title unchanged from English`);
      }
    }
  }
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
