import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHex,
  parseColor,
  toHex,
  toRgbString,
  toHslString,
  toCmykString,
  rgbToHsl,
  hslToRgb,
  rgbToCmyk,
  cmykToRgb,
  contrastRatio,
  wcag,
  shades,
  type RGB,
} from "../src/tools/color.ts";

const round = (c: RGB): RGB => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });

test("parseHex: 6/3 digits, optional #, case-insensitive, whitespace", () => {
  assert.deepEqual(parseHex("#3b82f6"), { r: 59, g: 130, b: 246 });
  assert.deepEqual(parseHex("3B82F6"), { r: 59, g: 130, b: 246 });
  assert.deepEqual(parseHex("  #fff "), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex("#09c"), { r: 0, g: 153, b: 204 });
});

test("parseHex: invalid input → null", () => {
  for (const bad of ["", "#", "#12", "#1234", "#12345", "#1234567", "#ggg", "zzzzzz", "#3b82f6ff", "😀"]) {
    assert.equal(parseHex(bad), null, bad);
  }
});

test("toHex / toRgbString clamp and round channels", () => {
  assert.equal(toHex({ r: 59, g: 130, b: 246 }), "#3b82f6");
  assert.equal(toHex({ r: -5, g: 300, b: 127.6 }), "#00ff80");
  assert.equal(toRgbString({ r: 255.4, g: 0, b: -1 }), "rgb(255, 0, 0)");
});

test("known vectors: legacy hint example #3b82f6", () => {
  const rgb = parseHex("#3b82f6")!;
  assert.equal(toRgbString(rgb), "rgb(59, 130, 246)");
  assert.equal(toHslString(rgb), "hsl(217, 91%, 60%)");
  assert.equal(toCmykString(rgb), "cmyk(76%, 47%, 0%, 4%)");
});

test("primaries/greys: rgb ↔ hsl ↔ cmyk", () => {
  const cases: [string, string, string][] = [
    ["#ff0000", "hsl(0, 100%, 50%)", "cmyk(0%, 100%, 100%, 0%)"],
    ["#00ff00", "hsl(120, 100%, 50%)", "cmyk(100%, 0%, 100%, 0%)"],
    ["#0000ff", "hsl(240, 100%, 50%)", "cmyk(100%, 100%, 0%, 0%)"],
    ["#000000", "hsl(0, 0%, 0%)", "cmyk(0%, 0%, 0%, 100%)"],
    ["#ffffff", "hsl(0, 0%, 100%)", "cmyk(0%, 0%, 0%, 0%)"],
    ["#808080", "hsl(0, 0%, 50%)", "cmyk(0%, 0%, 0%, 50%)"],
    ["#ff00ff", "hsl(300, 100%, 50%)", "cmyk(0%, 100%, 0%, 0%)"],
  ];
  for (const [hex, hsl, cmyk] of cases) {
    const rgb = parseHex(hex)!;
    assert.equal(toHslString(rgb), hsl, hex);
    assert.equal(toCmykString(rgb), cmyk, hex);
    const back = round(hslToRgb(rgbToHsl(rgb)));
    assert.equal(toHex(back), hex, `${hex} hsl round-trip`);
    assert.equal(toHex(cmykToRgb(rgbToCmyk(rgb))), hex, `${hex} cmyk round-trip`);
  }
});

test("round-trip hex → rgb → hsl → rgb stays within rounding error for a colour grid", () => {
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const back = round(hslToRgb(rgbToHsl({ r, g, b })));
    // Integer-percent HSL quantises to ~1.3 % lightness → ≤ 4 per channel.
    assert.ok(Math.abs(back.r - r) <= 4 && Math.abs(back.g - g) <= 4 && Math.abs(back.b - b) <= 4, `${r},${g},${b} → ${JSON.stringify(back)}`);
    const cm = cmykToRgb(rgbToCmyk({ r, g, b }));
    assert.ok(Math.abs(cm.r - r) <= 3 && Math.abs(cm.g - g) <= 3 && Math.abs(cm.b - b) <= 3, `cmyk ${r},${g},${b}`);
  }
});

test("hslToRgb: hue wraps (360 = 0, negative), s/l clamped", () => {
  assert.equal(toHex(hslToRgb({ h: 360, s: 100, l: 50 })), "#ff0000");
  assert.equal(toHex(hslToRgb({ h: -120, s: 100, l: 50 })), "#0000ff");
  assert.equal(toHex(hslToRgb({ h: 0, s: 150, l: 120 })), "#ffffff");
});

test("parseColor: auto-detects every format from the input hint", () => {
  const hint = ["#3b82f6", "rgb(59, 130, 246)", "hsl(217, 91%, 60%)", "cmyk(76%, 47%, 0%, 4%)"];
  const formats = hint.map((h) => parseColor(h)?.format);
  assert.deepEqual(formats, ["hex", "rgb", "hsl", "cmyk"]);
  assert.deepEqual(parseColor("rgb(59, 130, 246)")!.rgb, { r: 59, g: 130, b: 246 });
  // HSL/CMYK are lossy by 1–2 units per channel.
  const hsl = parseColor("hsl(217, 91%, 60%)")!.rgb;
  assert.ok(Math.abs(hsl.r - 59) <= 2 && Math.abs(hsl.g - 130) <= 2 && Math.abs(hsl.b - 246) <= 2);
  const cmyk = parseColor("cmyk(76%, 47%, 0%, 4%)")!.rgb;
  assert.ok(Math.abs(cmyk.r - 59) <= 2 && Math.abs(cmyk.g - 130) <= 2 && Math.abs(cmyk.b - 246) <= 2);
});

test("parseColor: CSS variants (rgba, spaces, percent, / alpha, deg, case)", () => {
  assert.deepEqual(parseColor("RGBA(255,0,0,0.5)")!.rgb, { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseColor("rgb(255 128 0 / 50%)")!.rgb, { r: 255, g: 128, b: 0 });
  assert.deepEqual(parseColor("rgb(100%, 50%, 0%)")!.rgb, { r: 255, g: 128, b: 0 });
  assert.deepEqual(parseColor("hsl(120deg 100% 25%)")!.rgb, { r: 0, g: 128, b: 0 });
  assert.deepEqual(parseColor("hsla(0, 100%, 50%, .3)")!.rgb, { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseColor("cmyk(0, 100, 100, 0)")!.rgb, { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseColor("  fff ")!.rgb, { r: 255, g: 255, b: 255 });
});

test("parseColor: invalid / out-of-range → null", () => {
  for (const bad of [
    "", "   ", "red", "#12345", "rgb(256, 0, 0)", "rgb(-1, 0, 0)", "rgb(1, 2)", "rgb(1,2,3,4,5)",
    "rgb(a, b, c)", "hsl(0, 101%, 50%)", "hsl(x, 50%, 50%)", "cmyk(10%, 20%, 30%)", "cmyk(0,0,0,101)",
    "rgb(255, 0, 0", "rgb(1%%, 0, 0)", "🎨", "rgb(1e3, 0, 0)",
  ]) {
    assert.equal(parseColor(bad), null, bad);
  }
});

test("contrast/WCAG: black on white = 21, same colour = 1, thresholds", () => {
  const black = { r: 0, g: 0, b: 0 }, white = { r: 255, g: 255, b: 255 };
  assert.equal(contrastRatio(black, white), 21);
  assert.equal(contrastRatio(white, black), 21);
  assert.equal(contrastRatio(white, white), 1);
  const w = wcag(black, white);
  assert.deepEqual([w.aaNormal, w.aaLarge, w.aaaNormal, w.aaaLarge], [true, true, true, true]);
  // #777 on white ≈ 4.48 → fails AA normal, passes AA large.
  const grey = wcag(parseHex("#777777")!, white);
  assert.ok(grey.ratio > 4.4 && grey.ratio < 4.5);
  assert.deepEqual([grey.aaNormal, grey.aaLarge, grey.aaaNormal, grey.aaaLarge], [false, true, false, false]);
  // #767676 on white ≈ 4.54 — the classic minimum AA grey.
  assert.equal(wcag(parseHex("#767676")!, white).aaNormal, true);
  assert.equal(contrastRatio(parseHex("#2f6df0")!, white).toFixed(2), "4.60");
});

test("shades: 9 steps 10..90 % lightness, same hue, valid hex", () => {
  const out = shades(parseHex("#3b82f6")!);
  assert.equal(out.length, 9);
  assert.deepEqual(out.map((s) => s.l), [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  for (const s of out) {
    assert.match(s.hex, /^#[0-9a-f]{6}$/);
    if (s.l > 15 && s.l < 85) assert.ok(Math.abs(rgbToHsl(parseHex(s.hex)!).h - 217) <= 2, s.hex);
  }
  assert.equal(shades({ r: 0, g: 0, b: 0 }, 3).length, 3);
  // Achromatic stays grey.
  for (const s of shades({ r: 128, g: 128, b: 128 })) assert.equal(rgbToHsl(parseHex(s.hex)!).s, 0);
});
