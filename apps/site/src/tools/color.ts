/**
 * Color conversions + WCAG contrast. Pure math, no DOM: hex/rgb/hsl/cmyk
 * round-trips with alpha detection, alpha compositing onto an opaque
 * backdrop, linear-light tint/shade palette and AA/AAA contrast checking.
 */

export interface RGB { r: number; g: number; b: number; }
export interface HSL { h: number; s: number; l: number; }
export interface CMYK { c: number; m: number; y: number; k: number; }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function clampByte(v: number): number {
  return clamp(Math.round(v), 0, 255);
}

export function parseHex(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, "");
  let r: number, g: number, b: number;
  if (/^[0-9a-fA-F]{6}$/.test(m)) {
    r = parseInt(m.slice(0, 2), 16); g = parseInt(m.slice(2, 4), 16); b = parseInt(m.slice(4, 6), 16);
  } else if (/^[0-9a-fA-F]{3}$/.test(m)) {
    r = parseInt(m[0] + m[0], 16); g = parseInt(m[1] + m[1], 16); b = parseInt(m[2] + m[2], 16);
  } else {
    return null;
  }
  return { r, g, b };
}

export function toHex({ r, g, b }: RGB): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function toRgbString({ r, g, b }: RGB): string {
  return `rgb(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)})`;
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;
  if (sn === 0) {
    const v = ln * 255;
    return { r: v, g: v, b: v };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: hue(hn + 1 / 3) * 255, g: hue(hn) * 255, b: hue(hn - 1 / 3) * 255 };
}

export function toHslString(c: RGB): string {
  const { h, s, l } = rgbToHsl(c);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

export function rgbToCmyk({ r, g, b }: RGB): CMYK {
  const rn = clampByte(r) / 255, gn = clampByte(g) / 255, bn = clampByte(b) / 255;
  const k = 1 - Math.max(rn, gn, bn);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  const c = (1 - rn - k) / (1 - k);
  const m = (1 - gn - k) / (1 - k);
  const y = (1 - bn - k) / (1 - k);
  return { c: Math.round(c * 100), m: Math.round(m * 100), y: Math.round(y * 100), k: Math.round(k * 100) };
}

/** CMYK percentages (0–100) → RGB bytes, as the legacy `cmykToRgb`. */
export function cmykToRgb({ c, m, y, k }: CMYK): RGB {
  const f = (v: number): number => 1 - clamp(v, 0, 100) / 100;
  const kk = f(k);
  return { r: clampByte(255 * f(c) * kk), g: clampByte(255 * f(m) * kk), b: clampByte(255 * f(y) * kk) };
}

export type ColorFormat = "hex" | "rgb" | "hsl" | "cmyk";

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
/**
 * Function-call colour syntax: `name(a, b, c[, d])`, commas or spaces, optional
 * CSS4 `/ alpha`. The slash alpha is returned separately; a comma-style 4th
 * argument stays in `parts` for the caller to interpret.
 */
function parseArgs(input: string, names: string): { parts: string[]; slashAlpha?: string } | null {
  const m = input.match(new RegExp(String.raw`^(?:${names})\s*\(\s*([^)]*)\)$`, "i"));
  if (!m) return null;
  const slash = m[1].match(/\s*\/\s*([^,\s]+)\s*$/);
  const body = slash ? m[1].slice(0, slash.index) : m[1];
  const parts = body.split(/\s*,\s*|\s+/).filter((p) => p.length > 0);
  return { parts, slashAlpha: slash?.[1] };
}

/** Alpha component (opacity): number 0–1 or percentage 0–100%. Missing → 1, malformed → null. */
function parseAlpha(part: string | undefined): number | null {
  if (part === undefined) return 1;
  const m = part.match(new RegExp(String.raw`^(${NUM})(%?)$`));
  if (!m) return null;
  const v = Number(m[1]) / (m[2] === "%" ? 100 : 1);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/** Parse one numeric component; `pct` = value carries/accepts a trailing %. Null when malformed. */
function num(part: string | undefined, max: number, allowPct: boolean): { v: number; pct: boolean } | null {
  if (part === undefined) return null;
  const m = part.match(new RegExp(String.raw`^(${NUM})(%?)$`));
  if (!m) return null;
  const pct = m[2] === "%";
  if (pct && !allowPct) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > (pct ? 100 : max)) return null;
  return { v, pct };
}

/**
 * Parse a manual colour string in any supported notation and auto-detect its
 * format: `#rgb`/`#rrggbb` (hash optional), `rgb()/rgba()` (0–255 or %),
 * `hsl()/hsla()` (hue in degrees, s/l in %), `cmyk()` (0–100, % optional).
 * Alpha (rgba/hsla 4th argument or CSS4 `/ alpha`) is returned as `alpha`
 * (0–1, default 1) but never baked into `rgb` — outputs stay opaque and
 * blending needs an explicit opaque backdrop (see `compositeOver`).
 * Out-of-range or malformed input → null (localized "invalid colour" error).
 */
export function parseColor(input: string): { rgb: RGB; format: ColorFormat; alpha: number } | null {
  const v = input.trim();
  if (!v) return null;
  const hex = parseHex(v);
  if (hex) return { rgb: hex, format: "hex", alpha: 1 };

  const rgbArgs = parseArgs(v, "rgba?");
  if (rgbArgs) {
    const { parts } = rgbArgs;
    if (parts.length < 3 || parts.length > 4 || (parts.length === 4 && rgbArgs.slashAlpha)) return null;
    const ch = parts.slice(0, 3).map((p) => num(p, 255, true));
    const alpha = parseAlpha(parts[3] ?? rgbArgs.slashAlpha);
    if (ch.some((c) => c === null) || alpha === null) return null;
    const [r, g, b] = ch.map((c) => clampByte(c!.pct ? (c!.v * 255) / 100 : c!.v));
    return { rgb: { r, g, b }, format: "rgb", alpha };
  }

  const hslArgs = parseArgs(v, "hsla?");
  if (hslArgs) {
    const { parts } = hslArgs;
    if (parts.length < 3 || parts.length > 4 || (parts.length === 4 && hslArgs.slashAlpha)) return null;
    const h = parts[0].match(new RegExp(String.raw`^(${NUM})(?:deg)?$`, "i"));
    const s = num(parts[1], 100, true);
    const l = num(parts[2], 100, true);
    const alpha = parseAlpha(parts[3] ?? hslArgs.slashAlpha);
    if (!h || !s || !l || alpha === null) return null;
    const rgb = hslToRgb({ h: Number(h[1]), s: s.v, l: l.v });
    return { rgb: { r: clampByte(rgb.r), g: clampByte(rgb.g), b: clampByte(rgb.b) }, format: "hsl", alpha };
  }

  const cmykArgs = parseArgs(v, "cmyk");
  if (cmykArgs) {
    const { parts } = cmykArgs;
    if (parts.length !== 4 || cmykArgs.slashAlpha) return null;
    const ch = parts.map((p) => num(p, 100, true));
    if (ch.some((c) => c === null)) return null;
    const [c, m, y, k] = ch.map((x) => x!.v);
    return { rgb: cmykToRgb({ c, m, y, k }), format: "cmyk", alpha: 1 };
  }
  return null;
}

export function toCmykString(rgb: RGB): string {
  const { c, m, y, k } = rgbToCmyk(rgb);
  return `cmyk(${c}%, ${m}%, ${y}%, ${k}%)`;
}

/** Relative luminance per WCAG 2.x. */
function relativeLuminance({ r, g, b }: RGB): number {
  const ch = (n: number): number => {
    const c = clampByte(n) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(fg: RGB, bg: RGB): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface WcagResult {
  ratio: number;
  aaNormal: boolean;
  aaLarge: boolean;
  aaaNormal: boolean;
  aaaLarge: boolean;
}

/** WCAG thresholds: normal ≥4.5, large ≥3.0, AAA normal ≥7.0, AAA large ≥4.5. */
export function wcag(fg: RGB, bg: RGB): WcagResult {
  const ratio = contrastRatio(fg, bg);
  return {
    ratio,
    aaNormal: ratio >= 4.5,
    aaLarge: ratio >= 3,
    aaaNormal: ratio >= 7,
    aaaLarge: ratio >= 4.5,
  };
}

/**
 * Contrast ratio text with two decimals ("4.48") that never contradicts the
 * pass/fail verdict: if rounding would lift a failing ratio onto a WCAG
 * threshold (3, 4.5, 7 — e.g. 4.4996 → "4.50"), it truncates instead ("4.49").
 */
export function formatRatio(ratio: number): string {
  const text = ratio.toFixed(2);
  const shown = Number(text);
  if ([3, 4.5, 7].some((t) => ratio < t && shown >= t)) return (Math.floor(ratio * 100) / 100).toFixed(2);
  return text;
}

/**
 * Alpha compositing (source-over) of a translucent colour onto an opaque
 * backdrop, in gamma-encoded sRGB like browsers paint it. Used to resolve
 * rgba()/hsla() foregrounds before contrast checks — never guess a backdrop.
 */
export function compositeOver(fg: RGB, alpha: number, backdrop: RGB): RGB {
  const a = clamp(alpha, 0, 1);
  const mix = (f: number, b: number): number => clampByte(f * a + b * (1 - a));
  return { r: mix(fg.r, backdrop.r), g: mix(fg.g, backdrop.g), b: mix(fg.b, backdrop.b) };
}

/** sRGB byte → linear-light 0–1 (IEC 61966-2-1 transfer function). */
function srgbToLinear(n: number): number {
  const c = clamp(n, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear-light 0–1 → sRGB byte (unrounded). */
function linearToSrgb(v: number): number {
  const c = clamp(v, 0, 1);
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/**
 * Mix two colours in linear-light sRGB: `t` = share of `b` (0 → a, 1 → b).
 * Physically correct light mixing for tints (towards white) and shades
 * (towards black); not perceptually uniform. Returns rounded bytes.
 */
export function mixLinear(a: RGB, b: RGB, t: number): RGB {
  const k = clamp(t, 0, 1);
  const ch = (x: number, y: number): number =>
    clampByte(linearToSrgb(srgbToLinear(x) * (1 - k) + srgbToLinear(y) * k));
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b) };
}

export type SwatchKind = "shade" | "base" | "tint";
export interface PaletteSwatch { kind: SwatchKind; pct: number; hex: string; }

/**
 * Tint/shade palette, dark → light: shades (mixed with black) at the given
 * percentages descending, the original colour, then tints (mixed with white)
 * ascending. Default 20/40/60/80 % → nine swatches; mixing in linear light.
 */
export function tintsAndShades(c: RGB, steps: readonly number[] = [20, 40, 60, 80]): PaletteSwatch[] {
  const black: RGB = { r: 0, g: 0, b: 0 };
  const white: RGB = { r: 255, g: 255, b: 255 };
  const asc = [...steps].sort((x, y) => x - y);
  return [
    ...[...asc].reverse().map((pct) => ({ kind: "shade" as const, pct, hex: toHex(mixLinear(c, black, pct / 100)) })),
    { kind: "base" as const, pct: 0, hex: toHex(c) },
    ...asc.map((pct) => ({ kind: "tint" as const, pct, hex: toHex(mixLinear(c, white, pct / 100)) })),
  ];
}
