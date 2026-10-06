/**
 * Build-time renderer of the Open Graph / Twitter share cards (social preview
 * PNG, 1200×630) in the Prism identity: dark canvas, category-coloured monogram
 * tile, localized tool name + tagline, spectrum hairline, MyDevTools wordmark.
 *
 * Text is converted to vector outlines with fontkitten from the self-hosted
 * @fontsource-variable WOFF2 files, and the SVG is rasterized by sharp (both
 * already used by astro itself). No system fonts, no network, deterministic.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { create, type Font } from "fontkitten";
import sharp from "sharp";
import {
  OG_HEIGHT as H,
  OG_WIDTH as W,
  parseDarkTokens,
  wrapText,
} from "./layout.ts";

type Family = "display" | "body" | "mono";

/** Unicode subsets loaded per family, in fallback order. */
const SUBSETS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext"] as const;
const FAMILY_PKG: Record<Family, string> = {
  display: "manrope",
  body: "inter",
  mono: "jetbrains-mono",
};

const req = createRequire(join(process.cwd(), "package.json"));

/** Raw WOFF2 bytes of one fontsource subset (`files/` is not in the package exports). */
function fontFile(pkg: string, subset: string): Buffer | null {
  const dir = dirname(req.resolve(`@fontsource-variable/${pkg}/LICENSE`));
  try {
    return readFileSync(join(dir, "files", `${pkg}-${subset}-wght-normal.woff2`));
  } catch {
    return null;
  }
}

/** Per-font hook that applies the weight's gvar deltas to one glyph (idempotent). */
const varyGlyph = new WeakMap<Font, (id: number) => void>();

/**
 * Instance of a variable WOFF2 font at weight `wght` (bold titles from the
 * self-hosted variable files). fontkitten can't do this itself: `getVariation()`
 * re-reads the WOFF2 stream as plain TTF, and the WOFF2 glyf decoder skips gvar
 * deltas (and crashes on composites with a processor set). So the WOFF2 class is
 * built with variation coords, glyf is decoded with the processor hidden, and
 * deltas are applied per glyph on first use by `varyGlyph` — mirroring
 * fontkitten's TTF `_decodeSimple`/`_decodeComposite` variation step.
 */
function weighted(bytes: Buffer, wght: number): Font {
  const probe = create(bytes) as any;
  const Stream = probe.stream.constructor;
  const coords = probe.fvar.axis.map((a: any) =>
    a.axisTag.trim() === "wght" ? Math.max(a.minValue, Math.min(a.maxValue, wght)) : a.defaultValue,
  );
  const font = new probe.constructor(new Stream(bytes), coords);
  let proto = Object.getPrototypeOf(font);
  while (proto && !Object.getOwnPropertyDescriptor(proto, "_variationProcessor")) proto = Object.getPrototypeOf(proto);
  const getProcessor = Object.getOwnPropertyDescriptor(proto, "_variationProcessor")!.get!;
  Object.defineProperty(font, "_variationProcessor", { value: null, configurable: true });
  font.getGlyph(0); // decodes the transformed glyf table without deltas
  const processor = getProcessor.call(font);
  // Keep the processor for HVAR advance-width adjustments.
  Object.defineProperty(font, "_variationProcessor", { value: processor });

  const table: any[] = font._transformedGlyphs ?? [];
  const Point = table.find((g) => g?.points?.length)?.points[0].constructor;
  const done = new Set<number>();
  const vary = (id: number): void => {
    const g = table[id];
    if (!processor || !Point || !g || done.has(id)) return;
    done.add(id);
    const metrics = font.hmtx.metrics;
    const advance = metrics.get(Math.min(id, metrics.length - 1))?.advance ?? 0;
    const phantom = () => [new Point(false, true, 0, 0), new Point(false, true, advance, 0), new Point(false, true, 0, 0), new Point(false, true, 0, 0)];
    if (g.numberOfContours > 0) {
      const points = [...g.points, ...phantom()];
      processor.transformPoints(id, points);
      g.phantomPoints = points.slice(-4);
    } else if (g.numberOfContours < 0) {
      for (const c of g.components) vary(c.glyphID);
      const points = [...g.components.map((c: any) => new Point(true, true, c.dx, c.dy)), ...phantom()];
      processor.transformPoints(id, points);
      g.phantomPoints = points.splice(-4, 4);
      points.forEach((pt: any, i: number) => {
        g.components[i].dx = pt.x;
        g.components[i].dy = pt.y;
      });
    }
  };
  varyGlyph.set(font, vary);
  return font as Font;
}

const chains = new Map<string, Font[]>();

/** Fallback chain of subset fonts for a family/weight; mono falls back to Inter (arrows, ±). */
function chain(family: Family, wght: number): Font[] {
  const key = `${family}:${wght}`;
  let fonts = chains.get(key);
  if (!fonts) {
    const pkgs = family === "mono" ? [FAMILY_PKG.mono, FAMILY_PKG.body] : [FAMILY_PKG[family]];
    fonts = [];
    for (const pkg of pkgs) {
      for (const subset of SUBSETS) {
        const bytes = fontFile(pkg, subset);
        if (bytes) fonts.push(weighted(bytes, wght));
      }
    }
    chains.set(key, fonts);
  }
  return fonts;
}

/** Thrown when no bundled font has a glyph (caller falls back to English text). */
export class MissingGlyphError extends Error {}

interface TextStyle {
  family: Family;
  weight: number;
  size: number;
  /** Letter spacing in em. */
  tracking?: number;
}

/** Arrows missing from every fontsource subset (monograms "→QR", "m↔ft"): drawn as strokes. */
const SYNTH_ARROWS = new Set([0x2190, 0x2192, 0x2194]);

/** Typographic characters outside the subsets, drawn with their plain look-alike. */
const SUBSTITUTES: Record<number, number> = { 0x2011: 0x2d, 0x2010: 0x2d, 0x202f: 0x20, 0x2009: 0x20 };

interface Shaped {
  glyphs: ({ font: Font; id: number; x: number } | { arrow: number; x: number; w: number })[];
  width: number;
}

/** One-to-one char → glyph layout (no kerning/shaping; fine for Latin/Cyrillic). */
function shape(text: string, style: TextStyle): Shaped {
  const fonts = chain(style.family, style.weight);
  const track = (style.tracking ?? 0) * style.size;
  const glyphs: Shaped["glyphs"] = [];
  let x = 0;
  for (const ch of text) {
    let cp = ch.codePointAt(0)!;
    let font = fonts.find((f) => f.hasGlyphForCodePoint(cp));
    if (!font && SUBSTITUTES[cp] !== undefined) {
      cp = SUBSTITUTES[cp];
      font = fonts.find((f) => f.hasGlyphForCodePoint(cp));
    }
    if (!font && SYNTH_ARROWS.has(cp)) {
      const w = measure("0", style);
      glyphs.push({ arrow: cp, x, w });
      x += w + track;
      continue;
    }
    if (!font) throw new MissingGlyphError(`og: no glyph for U+${cp.toString(16)} in "${text}"`);
    const glyph = font.glyphForCodePoint(cp);
    varyGlyph.get(font)?.(glyph.id);
    const scale = style.size / font.unitsPerEm;
    glyphs.push({ font, id: glyph.id, x });
    x += glyph.advanceWidth * scale + track;
  }
  return { glyphs, width: Math.max(0, x - track) };
}

/** Stroked arrow (← → ↔) filling one monospace cell at the x-height middle. */
function arrowSvg(cp: number, x: number, w: number, baseline: number, size: number, color: string): string {
  const y = r(baseline - size * 0.36);
  const x1 = r(x + w * 0.1);
  const x2 = r(x + w * 0.9);
  const h = w * 0.3;
  let d = `M${x1} ${y}H${x2}`;
  if (cp !== 0x2190) d += `M${r(x2 - h)} ${r(y - h)}L${x2} ${y}L${r(x2 - h)} ${r(y + h)}`;
  if (cp !== 0x2192) d += `M${r(x1 + h)} ${r(y - h)}L${x1} ${y}L${r(x1 + h)} ${r(y + h)}`;
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${r(size * 0.09)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Advance width of `text` in px. */
export function measure(text: string, style: TextStyle): number {
  return shape(text, style).width;
}

const outlines = new WeakMap<Font, Map<number, string>>();

/** Cached SVG path data of a glyph in font units (titles/footers repeat across cards). */
function outline(font: Font, id: number): string {
  let cache = outlines.get(font);
  if (!cache) outlines.set(font, (cache = new Map()));
  let d = cache.get(id);
  if (d === undefined) cache.set(id, (d = font.getGlyph(id).path.toSVG()));
  return d;
}

/** SVG outline group for `text`, left/centre/right-anchored at (x, baseline). */
function textSvg(
  text: string,
  style: TextStyle,
  x: number,
  baseline: number,
  fill: string,
  anchor: "start" | "middle" | "end" = "start",
): string {
  const { glyphs, width } = shape(text, style);
  const x0 = anchor === "start" ? x : anchor === "middle" ? x - width / 2 : x - width;
  const paths = glyphs
    .map((g) => {
      if ("arrow" in g) return arrowSvg(g.arrow, x0 + g.x, g.w, baseline, style.size, fill);
      const { font, id, x: gx } = g;
      const d = outline(font, id);
      if (!d) return "";
      const s = style.size / font.unitsPerEm;
      return `<path transform="translate(${r(x0 + gx)} ${r(baseline)}) scale(${r(s, 5)} ${r(-s, 5)})" d="${d}"/>`;
    })
    .join("");
  return `<g fill="${fill}">${paths}</g>`;
}

const r = (n: number, digits = 2) => Number(n.toFixed(digits));

/** Repo files the card is built from (passed in so the caller decides how to load them). */
export interface CardAssets {
  /** Contents of src/styles/global.css — dark Prism tokens, single colour source. */
  css: string;
  /** Contents of public/icons/favicon.svg — the brand mark. */
  logoSvg: string;
}

/** Brand mark re-positioned as a nested <svg>. */
function logo(svg: string, x: number, y: number, size: number): string {
  return svg
    .replace(/<\?xml[^>]*>/, "")
    .replace(/\s(role|aria-label)="[^"]*"/g, "")
    .trim()
    .replace("<svg ", `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
}

export interface CardInput {
  /** Localized tool name (or app name for home). */
  title: string;
  /** Short tagline (first sentence of the description). */
  tagline: string;
  /** Monogram in the tile; omitted → brand logo tile (home card). */
  monogram?: string;
  /** Category id (`--mdt-cat-<id>`); omitted → brand accent. */
  category?: string;
  /** Localized category label shown top-right. */
  categoryLabel?: string;
  /** Footer left, e.g. `ilexv.github.io/mydevtools`. */
  siteLabel: string;
  /** Footer right, e.g. the localized privacy promise. */
  footnote: string;
  /** Wordmark text (AppName). */
  brand: string;
  /** Category ids in catalog order, for the spectrum hairline. */
  spectrum: readonly string[];
}

const PAD = 80;
/** Category glow radius around the tile — kept compact: a full-canvas gradient doubles PNG quantization time. */
const GLOW_R = 300;
const TILE = 184;
const TEXT_X = PAD + TILE + 56;
const TEXT_W = W - PAD - TEXT_X;

/** Fit the title into ≤2 lines, shrinking from 76px down to 52px. */
function fitTitle(title: string, max: number): { lines: string[]; style: TextStyle } {
  let style: TextStyle = { family: "display", weight: 800, size: max, tracking: -0.02 };
  for (let size = max; size >= 52; size -= 4) {
    style = { ...style, size };
    const m = (s: string) => measure(s, style);
    const { lines, truncated } = wrapText(title, m, TEXT_W, 2);
    if (!truncated && lines.every((l) => m(l) <= TEXT_W)) return { lines, style };
  }
  return { lines: wrapText(title, (s) => measure(s, style), TEXT_W, 2).lines, style };
}

/** Compose the card SVG (vector outlines only — no <text>, so no system fonts). */
export function cardSvg(input: CardInput, assets: CardAssets): string {
  const tk = parseDarkTokens(assets.css);
  const bg = tk["surface"];
  const text = tk["text"];
  const muted = tk["text-muted"];
  const faint = tk["text-faint"];
  const border = tk["border"];
  const accent = (input.category && tk[`cat-${input.category}`]) || tk["accent"];
  const hues = input.spectrum.map((id) => tk[`cat-${id}`] ?? border);
  const tileY = 196;
  const isHome = !input.monogram;

  // Title + tagline block, vertically centred on the tile.
  const { lines: titleLines, style: titleStyle } = fitTitle(input.title, isHome ? 92 : 76);
  const tagStyle: TextStyle = { family: "body", weight: 400, size: 30 };
  const tag = wrapText(input.tagline, (s) => measure(s, tagStyle), TEXT_W, 2).lines;
  const titleLead = titleStyle.size * 1.08;
  const tagLead = 42;
  const blockH = titleLines.length * titleLead + 22 + tag.length * tagLead;
  let y = tileY + TILE / 2 - blockH / 2 + titleStyle.size * 0.86;
  const parts: string[] = [];
  for (const line of titleLines) {
    parts.push(textSvg(line, titleStyle, TEXT_X, y, text));
    y += titleLead;
  }
  y += 22 - titleLead + tagLead * 0.92;
  for (const line of tag) {
    parts.push(textSvg(line, tagStyle, TEXT_X, y, muted));
    y += tagLead;
  }

  // Monogram tile (or the brand logo for the home card).
  let tile: string;
  if (isHome) {
    tile = logo(assets.logoSvg, PAD, tileY, TILE);
  } else {
    const len = [...input.monogram!].length;
    let monoStyle: TextStyle = { family: "mono", weight: 700, size: len <= 2 ? 88 : len === 3 ? 70 : 56, tracking: -0.03 };
    while (measure(input.monogram!, monoStyle) > TILE - 36) monoStyle = { ...monoStyle, size: monoStyle.size - 4 };
    tile =
      `<rect x="${PAD}" y="${tileY}" width="${TILE}" height="${TILE}" rx="40" fill="${accent}" fill-opacity="0.14" stroke="${accent}" stroke-opacity="0.55" stroke-width="2"/>` +
      textSvg(input.monogram!, monoStyle, PAD + TILE / 2, tileY + TILE / 2 + monoStyle.size * 0.36, accent, "middle");
  }

  // Header: wordmark left (tool cards), category label right.
  const header: string[] = [];
  if (!isHome) {
    header.push(logo(assets.logoSvg, PAD, 60, 48));
    header.push(textSvg(input.brand, { family: "display", weight: 700, size: 30, tracking: -0.01 }, PAD + 64, 95, text));
  }
  if (input.categoryLabel) {
    const catStyle: TextStyle = { family: "body", weight: 500, size: 24 };
    const w = measure(input.categoryLabel, catStyle);
    header.push(`<circle cx="${r(W - PAD - w - 20)}" cy="86" r="6" fill="${accent}"/>`);
    header.push(textSvg(input.categoryLabel, catStyle, W - PAD, 94, accent, "end"));
  }

  // Footer: spectrum hairline (one solid segment per category hue, catalog
  // order — the "light through a prism" identity; solid keeps the palette exact),
  // then site address + privacy footnote.
  const lineY = 540;
  const segW = (W - 2 * PAD) / Math.max(1, hues.length);
  // The tool's own category segment is drawn thicker — its "ray" of the spectrum.
  const own = input.category ? input.spectrum.indexOf(input.category) : -1;
  const spectrumSvg = hues
    .map((h, i) => {
      const thick = i === own;
      return `<rect x="${r(PAD + i * segW)}" y="${thick ? lineY - 2 : lineY}" width="${r(segW + 0.5)}" height="${thick ? 7 : 3}" fill="${h}"/>`;
    })
    .join("");
  const footStyle: TextStyle = { family: "body", weight: 400, size: 22 };
  const footer =
    spectrumSvg +
    textSvg(input.siteLabel, { family: "mono", weight: 500, size: 21 }, PAD, 590, faint) +
    textSvg(input.footnote, footStyle, W - PAD, 590, muted, "end");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<radialGradient id="glow" cx="${PAD + TILE / 2}" cy="${tileY + TILE / 2}" r="${GLOW_R}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${accent}" stop-opacity="0.24"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="${bg}"/>` +
    `<rect x="0" y="${tileY + TILE / 2 - GLOW_R}" width="${PAD + TILE / 2 + GLOW_R}" height="${GLOW_R * 2}" fill="url(#glow)"/>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="${border}"/>` +
    header.join("") +
    tile +
    parts.join("") +
    footer +
    `</svg>`
  );
}

/** Indexed 256-colour PNG, no dither: keeps cards ~35–50 KB (target ≤ 80 KB). */
const PNG_OPTIONS = { palette: true, colours: 256, dither: 0, effort: 1, compressionLevel: 9 } as const;

/** Content-addressed PNG cache: unchanged cards are not re-encoded on the next build. */
const CACHE_DIR = join(process.cwd(), "node_modules", ".cache", "mydevtools-og");

/**
 * Rasterize a card to PNG. Output is a pure function of the SVG and encoder
 * settings, so it is cached by their hash (~0.1 s of sharp work per card cold).
 */
export async function renderCard(input: CardInput, assets: CardAssets): Promise<Buffer> {
  const svg = cardSvg(input, assets);
  const key = createHash("sha1")
    .update(`${sharp.versions.vips}|${JSON.stringify(PNG_OPTIONS)}|${svg}`)
    .digest("hex");
  const file = join(CACHE_DIR, `${key}.png`);
  try {
    return await readFile(file);
  } catch {
    /* cache miss */
  }
  const png = await sharp(Buffer.from(svg)).png(PNG_OPTIONS).toBuffer();
  await mkdir(CACHE_DIR, { recursive: true })
    .then(() => writeFile(file, png))
    .catch(() => {}); // cache is best-effort
  return png;
}
