/**
 * Color Converter client. Picker ↔ manual input (hex/rgb/hsl/cmyk, auto-detected
 * by `parseColor`) → formats list + shades + preview; separate WCAG contrast
 * checker. Live update while typing; Convert/Enter surfaces the localized
 * "invalid colour" error. All math in `color.ts`; DOM built with ds-* classes.
 */
import {
  parseColor,
  parseHex,
  toHex,
  toRgbString,
  toHslString,
  toCmykString,
  shades,
  wcag,
  type RGB,
} from "@/tools/color";
import { copyWithFeedback, prepareCopyButton } from "@/scripts/tool-ui";

interface Strings {
  copy: string;
  copied: string;
  copyFailed: string;
  invalidColor: string;
  aaNormal: string;
  aaLarge: string;
  aaaNormal: string;
  aaaLarge: string;
  pass: string;
  fail: string;
}

const DEFAULT_HEX = "#3b82f6";

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-color-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-color-tool]");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "1";
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const picker = root.querySelector<HTMLInputElement>("[data-color-picker]");
  const input = root.querySelector<HTMLInputElement>("[data-color-hex]");
  const convertBtn = root.querySelector<HTMLButtonElement>("[data-color-convert]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-color-clear]");
  const errorEl = root.querySelector<HTMLElement>("[data-color-error]");
  const swatchEl = root.querySelector<HTMLElement>("[data-color-swatch]");
  const formatsEl = root.querySelector<HTMLElement>("[data-color-formats]");
  const shadesEl = root.querySelector<HTMLElement>("[data-color-shades]");
  const fg = root.querySelector<HTMLInputElement>("[data-color-fg]");
  const bg = root.querySelector<HTMLInputElement>("[data-color-bg]");
  const ratioEl = root.querySelector<HTMLElement>("[data-color-ratio]");
  const wcagEl = root.querySelector<HTMLElement>("[data-color-wcag]");
  const previewEl = root.querySelector<HTMLElement>("[data-color-preview]");
  const ratioCopyBtn = root.querySelector<HTMLButtonElement>("[data-color-ratio-copy]");

  function showError(msg: string): void {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.hidden = !msg;
    }
  }

  function setInvalid(invalid: boolean): void {
    if (!input) return;
    if (invalid) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function renderFormats(rgb: RGB, hex: string): void {
    if (!formatsEl) return;
    const rows: [string, string][] = [
      ["HEX", hex.toUpperCase()],
      ["RGB", toRgbString(rgb)],
      ["HSL", toHslString(rgb)],
      ["CMYK", toCmykString(rgb)],
    ];
    formatsEl.replaceChildren(
      ...rows.map(([name, val]) => {
        const row = document.createElement("div");
        row.className = "ds-result-row";
        const key = document.createElement("span");
        key.className = "ds-result-key";
        key.textContent = name;
        const value = document.createElement("span");
        value.className = "ds-result-value";
        value.textContent = val;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ds-btn ds-btn-small ds-btn-ghost";
        btn.dataset.copy = val;
        btn.textContent = strings.copy;
        btn.setAttribute("aria-label", `${strings.copy} ${name}`);
        prepareCopyButton(btn, strings.copied);
        row.append(key, value, btn);
        return row;
      }),
    );
  }

  function renderShades(rgb: RGB, hex: string): void {
    if (!shadesEl) return;
    shadesEl.replaceChildren(
      ...shades(rgb).map((sh) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "color-swatch";
        btn.dataset.swatch = sh.hex;
        btn.setAttribute("aria-pressed", String(sh.hex === hex));
        btn.setAttribute("aria-label", `${sh.hex.toUpperCase()} (L ${sh.l}%)`);
        const chip = document.createElement("span");
        chip.className = "color-swatch-chip";
        chip.style.background = sh.hex;
        const label = document.createElement("span");
        label.className = "color-swatch-label";
        const code = document.createElement("span");
        code.textContent = sh.hex.toUpperCase();
        const l = document.createElement("span");
        l.textContent = `${sh.l}%`;
        label.append(code, l);
        btn.append(chip, label);
        return btn;
      }),
    );
  }

  function apply(rgb: RGB): void {
    const hex = toHex(rgb);
    if (picker) picker.value = hex;
    if (swatchEl) swatchEl.style.background = hex;
    renderFormats(rgb, hex);
    renderShades(rgb, hex);
    setInvalid(false);
    showError("");
  }

  /** Live typing: update on valid input, flag invalid without an alert. */
  function onType(): void {
    if (!input) return;
    const parsed = parseColor(input.value);
    if (parsed) apply(parsed.rgb);
    else setInvalid(input.value.trim().length > 0);
  }

  /** Explicit convert (button / Enter): invalid or empty → visible error. */
  function convert(): void {
    if (!input) return;
    const parsed = parseColor(input.value);
    if (parsed) {
      apply(parsed.rgb);
    } else {
      setInvalid(true);
      showError(strings.invalidColor);
    }
  }

  picker?.addEventListener("input", () => {
    const rgb = parseHex(picker.value);
    if (!rgb) return;
    if (input) input.value = picker.value;
    apply(rgb);
  });
  input?.addEventListener("input", onType);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      convert();
    }
  });
  convertBtn?.addEventListener("click", convert);
  clearBtn?.addEventListener("click", () => {
    if (input) {
      input.value = "";
      input.focus();
    }
    apply(parseHex(DEFAULT_HEX)!);
  });

  formatsEl?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
    if (!btn) return;
    const ok = await copyWithFeedback(btn, btn.dataset.copy ?? "", strings.copied);
    if (!ok) showError(strings.copyFailed);
  });

  shadesEl?.addEventListener("click", (e) => {
    const sw = (e.target as HTMLElement).closest<HTMLElement>("[data-swatch]");
    const hex = sw?.dataset.swatch;
    const rgb = hex ? parseHex(hex) : null;
    if (!hex || !rgb) return;
    if (input) input.value = hex;
    apply(rgb);
    shadesEl.querySelector<HTMLElement>(`[data-swatch="${hex}"]`)?.focus();
  });

  function renderContrast(): void {
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
      // Quiet labelled grid under the headline ratio: level on the left, ✓ Pass / ✗ Fail right.
      wcagEl.replaceChildren(
        ...items.map(([label, ok]) => {
          const li = document.createElement("li");
          const level = document.createElement("span");
          level.className = "wcag-level";
          level.textContent = label;
          const status = document.createElement("span");
          status.className = `ds-status ${ok ? "is-success" : "is-error"}`;
          status.textContent = `${ok ? "✓" : "✗"} ${ok ? strings.pass : strings.fail}`;
          li.append(level, status);
          return li;
        }),
      );
    }
    if (previewEl) {
      previewEl.style.background = bg.value;
      previewEl.style.color = fg.value;
    }
  }

  ratioCopyBtn?.addEventListener("click", async () => {
    const text = ratioEl?.textContent ?? "";
    if (!text || text === "—") return;
    const ok = await copyWithFeedback(ratioCopyBtn, text, strings.copied);
    if (!ok) showError(strings.copyFailed);
  });

  fg?.addEventListener("input", renderContrast);
  bg?.addEventListener("input", renderContrast);

  const initial = parseColor(input?.value || DEFAULT_HEX) ?? parseColor(DEFAULT_HEX)!;
  apply(initial.rgb);
  renderContrast();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
