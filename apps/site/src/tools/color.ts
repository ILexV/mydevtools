/**
 * Color conversions + WCAG contrast. Pure math, no DOM. Mirrors the legacy
 * color-converter behavior: hex/rgb/hsl/cmyk round-trips, shades palette,
 * and AA/AAA contrast checking.
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

/** Shades stepping lightness from current hue/sat. */
export function shades(c: RGB, steps = 9): { l: number; hex: string }[] {
  const { h, s } = rgbToHsl(c);
  const out: { l: number; hex: string }[] = [];
  for (let i = 0; i < steps; i++) {
    const l = Math.round((i * 100) / (steps - 1));
    out.push({ l, hex: toHex(hslToRgb({ h, s, l })) });
  }
  return out;
}
