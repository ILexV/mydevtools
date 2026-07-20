/**
 * Color Converter client. Drives picker/hex input → formats + shades + WCAG
 * contrast. Keeps picker and hex in sync; all conversions via `color.ts`.
 */
import {
  parseHex,
  toHex,
  toRgbString,
  toHslString,
  toCmykString,
  shades,
  wcag,
  type RGB,
} from "@/tools/color";

interface Strings {
  copy: string;
  copied: string;
  aaNormal: string;
  aaLarge: string;
  aaaNormal: string;
  aaaLarge: string;
  pass: string;
  fail: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-color-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-color-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const picker = root.querySelector<HTMLInputElement>("[data-color-picker]");
  const hexInput = root.querySelector<HTMLInputElement>("[data-color-hex]");
  const formatsEl = root.querySelector<HTMLElement>("[data-color-formats]");
  const shadesEl = root.querySelector<HTMLElement>("[data-color-shades]");
  const fg = root.querySelector<HTMLInputElement>("[data-color-fg]");
  const bg = root.querySelector<HTMLInputElement>("[data-color-bg]");
  const ratioEl = root.querySelector<HTMLElement>("[data-color-ratio]");
  const wcagEl = root.querySelector<HTMLElement>("[data-color-wcag]");
  const previewEl = root.querySelector<HTMLElement>("[data-color-preview]");

  function syncFrom(rgb: RGB) {
    const hex = toHex(rgb);
    if (picker) picker.value = hex;
    if (formatsEl) {
      const rows: [string, string][] = [
        ["HEX", hex],
        ["RGB", toRgbString(rgb)],
        ["HSL", toHslString(rgb)],
        ["CMYK", toCmykString(rgb)],
      ];
      formatsEl.innerHTML = rows
        .map(
          ([name, val]) =>
            `<div class="format-row"><span class="format-name">${name}</span>` +
            `<span class="format-val">${val}</span>` +
            `<button type="button" class="ghost-btn copy-btn" data-copy="${val}">${strings!.copy}</button></div>`,
        )
        .join("");
    }
    if (shadesEl) {
      shadesEl.innerHTML = shades(rgb)
        .map((sh) => `<button type="button" class="swatch" style="background:${sh.hex}" data-swatch="${sh.hex}" title="${sh.hex}"><span>${sh.l}</span></button>`)
        .join("");
    }
  }

  function setHex(hex: string): boolean {
    const rgb = parseHex(hex);
    if (!rgb) return false;
    if (hexInput) hexInput.value = hex;
    syncFrom(rgb);
    return true;
  }

  picker?.addEventListener("input", () => {
    if (hexInput) hexInput.value = picker.value;
    const rgb = parseHex(picker.value);
    if (rgb) syncFrom(rgb);
  });

  hexInput?.addEventListener("input", () => {
    const rgb = parseHex(hexInput.value);
    if (rgb) {
      if (picker) picker.value = toHex(rgb);
      syncFrom(rgb);
    }
  });

  formatsEl?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement)?.closest?.("[data-copy]") as HTMLButtonElement | null;
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.getAttribute("data-copy") || "");
      const orig = btn.textContent;
      btn.textContent = strings.copied;
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  shadesEl?.addEventListener("click", (e) => {
    const sw = (e.target as HTMLElement)?.closest?.("[data-swatch]") as HTMLElement | null;
    if (sw) setHex(sw.getAttribute("data-swatch") || "");
  });

  function renderContrast() {
    if (!fg || !bg) return;
    const f = parseHex(fg.value);
    const b = parseHex(bg.value);
    if (!f || !b) return;
    const r = wcag(f, b);
    if (ratioEl) ratioEl.textContent = `${r.ratio.toFixed(2)}:1`;
    if (wcagEl) {
      const items: [string, boolean][] = [
        [strings.aaNormal, r.aaNormal],
        [strings.aaLarge, r.aaLarge],
        [strings.aaaNormal, r.aaaNormal],
        [strings.aaaLarge, r.aaaLarge],
      ];
      wcagEl.innerHTML = items
        .map(
          ([label, ok]) =>
            `<span class="badge ${ok ? "pass" : "fail"}">${label}: ${ok ? strings.pass : strings.fail}</span>`,
        )
        .join("");
    }
    if (previewEl) {
      previewEl.style.background = bg.value;
      previewEl.style.color = fg.value;
    }
  }

  fg?.addEventListener("input", renderContrast);
  bg?.addEventListener("input", renderContrast);

  const initial = parseHex(picker?.value ?? "#2f6df0");
  if (initial) syncFrom(initial);
  renderContrast();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
