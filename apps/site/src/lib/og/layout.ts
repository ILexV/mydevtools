/**
 * Pure helpers for the per-tool Open Graph / Twitter social images
 * (share preview cards, 1200×630 PNG). No fonts, no Vite, no I/O — unit-tested
 * in `test/og.test.ts`; the renderer (`render.ts`) and `Seo.astro` build on them.
 */
import type { LocaleCode } from "../../registry/locales.ts";

/** Social card size recommended by Open Graph / X (Twitter) `summary_large_image`. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Pseudo-slug of the home page card (never a tool slug). */
export const OG_HOME_SLUG = "home";

/**
 * Locales whose script the bundled fonts cover (Inter/Manrope latin + cyrillic).
 * zh/ja/ko/hi would need a multi-MB CJK/Devanagari font, so their pages reuse
 * the English card instead of shipping tofu boxes.
 */
export const OG_LOCALES: readonly LocaleCode[] = ["en", "ru", "es", "de", "pt", "fr"];

/** Locale whose card a page uses: itself if its script is renderable, else English. */
export function ogLocaleFor(lang: LocaleCode): LocaleCode {
  return OG_LOCALES.includes(lang) ? lang : "en";
}

/** Base-relative path of a card image, e.g. `og/ru/hash-calculator.png`. */
export function ogImagePath(lang: LocaleCode, slug: string): string {
  return `og/${ogLocaleFor(lang)}/${slug}.png`;
}

/**
 * Short tagline for the card: the first sentence of a tool/home description
 * (descriptions are 1–3 sentences; the first says what the tool does).
 */
export function firstSentence(text: string): string {
  const clean = text.replace(/[ \t\r\n]+/g, " ").trim();
  // ≥24 chars before the stop so "e.g." / "z. B." early in a sentence don't cut it.
  const m = clean.match(/^.{24,}?[.!?](?=\s|$)/);
  return (m ? m[0] : clean).trim();
}

/**
 * Parse the dark-theme `--mdt-*` colour tokens (surfaces, text, `cat-<id>` hues)
 * from global.css, so the card colours stay the single Prism source of truth
 * (no copied hexes). Keys drop the `--mdt-` prefix: `surface`, `cat-pdf`, …
 */
export function parseDarkTokens(css: string): Record<string, string> {
  const block = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
  if (!block) throw new Error("og: dark token block not found in global.css");
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/--mdt-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

/**
 * Greedy word wrap into at most `maxLines` lines no wider than `maxWidth`
 * (width from the injected `measure`). Overflow is cut with an ellipsis on the
 * last line; a single over-long word is kept whole (callers shrink the size).
 */
export function wrapText(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  // Break only at ordinary spaces: no-break spaces (U+00A0/202F) keep words together.
  const words = text.split(/[ \t\r\n]+/).filter(Boolean);
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = words[i++];
    while (i < words.length && measure(`${line} ${words[i]}`) <= maxWidth) line += ` ${words[i++]}`;
    lines.push(line);
  }
  const truncated = i < words.length;
  if (truncated) {
    let last = lines[lines.length - 1];
    while (last.includes(" ") && measure(`${last}…`) > maxWidth) last = last.slice(0, last.lastIndexOf(" "));
    lines[lines.length - 1] = `${last.replace(/[\s,;:.–—-]+$/, "")}…`;
  }
  return { lines, truncated };
}
