/**
 * Pure helpers for the per-tool Open Graph / Twitter social images
 * (share preview cards, 1200×630 PNG). No fonts, no Vite, no I/O — unit-tested
 * in `test/og.test.ts`; the renderer (`render.ts`) and `Seo.astro` build on them.
 */
import { LOCALE_CODES, type LocaleCode } from "../../registry/locales.ts";

/** Social card size recommended by Open Graph / X (Twitter) `summary_large_image`. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Pseudo-slug of the home page card (never a tool slug). */
export const OG_HOME_SLUG = "home";

/**
 * Locales that get their own card: all of them. Latin/Cyrillic come from the
 * self-hosted Inter/Manrope subsets, zh/ja/ko/hi from build-only Noto fonts
 * (see render.ts) — a glyph none of them has fails the build.
 */
export const OG_LOCALES: readonly LocaleCode[] = LOCALE_CODES;

/** Base-relative path of a card image, e.g. `og/ru/hash-calculator.png`. */
export function ogImagePath(lang: LocaleCode, slug: string): string {
  return `og/${lang}/${slug}.png`;
}

/**
 * Short tagline for the card: the first sentence of a tool/home description
 * (descriptions are 1–3 sentences; the first says what the tool does).
 */
export function firstSentence(text: string): string {
  const clean = text.replace(/[ \t\r\n]+/g, " ").trim();
  // ≥24 chars before a Latin stop so "e.g." / "z. B." early in a sentence don't cut it;
  // full-width CJK stops and the Devanagari danda end a sentence without a following space.
  const latin = clean.match(/^.{24,}?[.!?](?=\s|$)/)?.[0];
  const wide = clean.match(/^.{6,}?[。！？।]/)?.[0];
  const m = latin && wide ? (latin.length <= wide.length ? latin : wide) : (latin ?? wide);
  return (m ?? clean).trim();
}

/** Characters that must not start a line (CJK kinsoku: closing marks, small kana, prolonged sound). */
const NO_LINE_START = /^[、。，．・：；？！）」』】〕〉》〙〗’”ー～…‥々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ)\]},.:;!?%]/u;
/** Characters that must not end a line (opening brackets/quotes). */
const NO_LINE_END = /[（「『【〔〈《〘〖‘“(\[{]$/u;

/** A line-break unit and the separator inserted before it when it doesn't start a line. */
interface BreakUnit {
  text: string;
  sep: string;
}

/**
 * Break opportunities: spaces for space-separated scripts (Korean keeps
 * words whole, like `word-break: keep-all`; Devanagari clusters are never
 * split), dictionary words via Intl.Segmenter for Chinese/Japanese, with
 * kinsoku punctuation glued to its neighbour.
 */
export function breakUnits(text: string, lang?: string): BreakUnit[] {
  if (lang !== "zh" && lang !== "ja") {
    // Break only at ordinary spaces: no-break spaces (U+00A0/202F) keep words together.
    return text
      .split(/[ \t\r\n]+/)
      .filter(Boolean)
      .map((w, i) => ({ text: w, sep: i ? " " : "" }));
  }
  const units: BreakUnit[] = [];
  let sep = "";
  for (const { segment } of new Intl.Segmenter(lang, { granularity: "word" }).segment(text)) {
    if (/^[ \t\r\n]+$/.test(segment)) {
      sep = units.length ? " " : "";
      continue;
    }
    const prev = units[units.length - 1];
    if (prev && !sep && (NO_LINE_START.test(segment) || NO_LINE_END.test(prev.text))) prev.text += segment;
    else if (prev && sep && NO_LINE_END.test(prev.text)) prev.text += sep + segment;
    else units.push({ text: segment, sep });
    sep = "";
  }
  return units;
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
 * Greedy wrap into at most `maxLines` lines no wider than `maxWidth` (width
 * from the injected `measure`; break units from `breakUnits(text, lang)`).
 * Overflow is cut with an ellipsis on the last line; a single over-long unit
 * is kept whole (callers shrink the size).
 */
export function wrapText(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
  maxLines: number,
  lang?: string,
): { lines: string[]; truncated: boolean } {
  const units = breakUnits(text, lang);
  const lines: BreakUnit[][] = [];
  const join = (line: BreakUnit[]) => line.map((u, k) => (k ? u.sep : "") + u.text).join("");
  let i = 0;
  while (i < units.length && lines.length < maxLines) {
    const line = [units[i++]];
    while (i < units.length && measure(join([...line, units[i]])) <= maxWidth) line.push(units[i++]);
    lines.push(line);
  }
  const truncated = i < units.length;
  const out = lines.map(join);
  if (truncated) {
    const lastUnits = lines[lines.length - 1];
    while (lastUnits.length > 1 && measure(`${join(lastUnits)}…`) > maxWidth) lastUnits.pop();
    out[out.length - 1] = `${join(lastUnits).replace(/[\s,;:.–—\-、。，．：；・]+$/u, "")}…`;
  }
  return { lines: out, truncated };
}
