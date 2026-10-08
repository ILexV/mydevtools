import { execFileSync } from "node:child_process";

/**
 * Sitemap lastmod from git history: the date a page's own content last changed
 * (tool shell/controller/helpers + its locale JSON; for a locale home, its
 * home.json + the home route + the tool registry). Honest per-page dates, not
 * the build date, so search engines keep trusting lastmod. Build-time only.
 * No git (tarball checkout) → no lastmod rather than a made-up one.
 */
let fileDates: Map<string, string> | null = null;

/** Latest commit date (YYYY-MM-DD) per file under the site, newest first wins. */
function gitFileDates(): Map<string, string> {
  if (fileDates) return fileDates;
  fileDates = new Map();
  try {
    // --relative: paths relative to the cwd (apps/site, where astro build runs).
    const out = execFileSync(
      "git",
      ["log", "--format=@%cs", "--name-only", "--relative", "--", "src/tools", "src/i18n/locales", "src/pages/[lang]", "src/registry"],
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] },
    );
    let date = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("@")) date = line.slice(1);
      else if (line && !fileDates.has(line)) fileDates.set(line, date);
    }
  } catch {
    // Not a git checkout: sitemap omits lastmod.
  }
  return fileDates;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function latest(match: (file: string) => boolean): string | undefined {
  let best: string | undefined;
  for (const [file, date] of gitFileDates()) if (match(file) && (!best || date > best)) best = date;
  return best;
}

/** Last content change of a tool page: `HashCalculator.astro`, `hash-calculator.client.ts`, … + its locale JSON. */
export function toolLastmod(lang: string, slug: string): string | undefined {
  const key = squash(slug);
  const localeFile = `src/i18n/locales/${lang}/tools/${slug}.json`;
  return latest(
    (file) =>
      file === localeFile ||
      (file.startsWith("src/tools/") && squash(file.slice("src/tools/".length)).startsWith(key)),
  );
}

/** Last content change of a locale home: its home.json, the home route and the tool registry. */
export function homeLastmod(lang: string): string | undefined {
  const files = new Set([`src/i18n/locales/${lang}/home.json`, "src/pages/[lang]/index.astro", "src/registry/tools.ts"]);
  return latest((file) => files.has(file));
}
