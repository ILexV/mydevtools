/**
 * Color Converter client. Picker ↔ manual input (hex/rgb/hsl/cmyk, auto-detected
 * by `parseColor`) → formats list + tint/shade swatches (click copies HEX) +
 * preview; separate WCAG contrast checker whose fg/bg change only through their
 * pickers, Swap or the explicit "use converted colour" buttons (converting never
 * overwrites the pair). Alpha input is blended only onto the opaque background.
 * All math in `color.ts`; DOM built with ds-* classes.
 */
import {
  parseColor,
  parseHex,
  toHex,
  toRgbString,
  toHslString,
  toCmykString,
  tintsAndShades,
  compositeOver,
  formatRatio,
  wcag,
  type RGB,
} from "@/tools/color";
import { copyWithFeedback, prepareCopyButton, revealOutput } from "@/scripts/tool-ui";

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
  pairCaption: string;
  alphaNote: string;
  swatchShade: string;
  swatchTint: string;
  swatchOriginal: string;
}

const fill = (tpl: string, params: Record<string, string>): string =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m);

const SVG_NS = "http://www.w3.org/2000/svg";
/** Pass/Fail glyph (check / cross) so the WCAG verdict never relies on colour alone. */
function verdictIcon(ok: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 20 20", width: "14", height: "14", fill: "none", stroke: "currentColor",
    "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ok ? "m4 10.5 4 4 8-9" : "M5 5l10 10M15 5 5 15");
  svg.append(path);
  return svg;
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
  const toolRoot: HTMLElement = root;
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
  const alphaNoteEl = root.querySelector<HTMLElement>("[data-color-alpha-note]");
  const pairEl = root.querySelector<HTMLElement>("[data-color-pair]");
  const useFgBtn = root.querySelector<HTMLButtonElement>("[data-color-use-fg]");
  const useBgBtn = root.querySelector<HTMLButtonElement>("[data-color-use-bg]");
  const swapBtn = root.querySelector<HTMLButtonElement>("[data-color-swap]");
  /** Last converted colour (opaque rgb + separate alpha) for the "use converted" buttons. */
  let current: { rgb: RGB; alpha: number } = { rgb: parseHex(DEFAULT_HEX)!, alpha: 1 };

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

  /** Nine swatch buttons (shades → original → tints); each copies its HEX via the kit copy faces. */
  function renderShades(rgb: RGB): void {
    if (!shadesEl) return;
    shadesEl.replaceChildren(
      ...tintsAndShades(rgb).map((sw) => {
        const hex = sw.hex.toUpperCase();
        const name =
          sw.kind === "base"
            ? strings.swatchOriginal
            : fill(sw.kind === "tint" ? strings.swatchTint : strings.swatchShade, { pct: String(sw.pct) });
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = sw.kind === "base" ? "color-swatch is-base" : "color-swatch";
        btn.dataset.swatch = sw.hex;
        btn.setAttribute("aria-label", `${strings.copy} ${name} ${hex}`);
        const chip = document.createElement("span");
        chip.className = "color-swatch-chip";
        chip.style.background = sw.hex;
        // Pre-built faces (idle label, done, fail): prepareCopyButton fills done/fail only.
        const faces = document.createElement("span");
        faces.className = "ds-copy-faces";
        faces.dataset.iconOnly = "false";
        const idle = document.createElement("span");
        idle.className = "ds-copy-face ds-copy-face-idle";
        const nameEl = document.createElement("span");
        nameEl.className = "color-swatch-name";
        nameEl.textContent = name;
        const hexEl = document.createElement("span");
        hexEl.className = "color-swatch-hex";
        hexEl.textContent = hex;
        idle.append(nameEl, hexEl);
        const done = document.createElement("span");
        done.className = "ds-copy-face ds-copy-face-done";
        const failFace = document.createElement("span");
        failFace.className = "ds-copy-face ds-copy-face-fail";
        faces.append(idle, done, failFace);
        btn.append(chip, faces);
        prepareCopyButton(btn, strings.copied);
        return btn;
      }),
    );
  }

  /** Alpha < 1: say it is not in the outputs and how the contrast buttons treat it. */
  function renderAlphaNote(alpha: number): void {
    if (!alphaNoteEl) return;
    const show = alpha < 1;
    alphaNoteEl.hidden = !show;
    alphaNoteEl.textContent = show ? fill(strings.alphaNote, { alpha: String(Math.round(alpha * 1000) / 1000) }) : "";
  }

  function apply(rgb: RGB, alpha = 1): void {
    const hex = toHex(rgb);
    current = { rgb, alpha };
    if (picker) picker.value = hex;
    if (swatchEl) swatchEl.style.background = hex;
    renderFormats(rgb, hex);
    renderShades(rgb);
    renderAlphaNote(alpha);
    for (const chip of toolRoot.querySelectorAll<HTMLElement>("[data-color-use-chip]")) chip.style.background = hex;
    setInvalid(false);
    showError("");
  }

  /** Live typing: update on valid input, flag invalid without an alert. */
  function onType(): void {
    if (!input) return;
    const parsed = parseColor(input.value);
    if (parsed) apply(parsed.rgb, parsed.alpha);
    else setInvalid(input.value.trim().length > 0);
  }

  /** Explicit convert (button / Enter): invalid or empty → visible error. */
  function convert(): void {
    if (!input) return;
    const parsed = parseColor(input.value);
    if (parsed) {
      apply(parsed.rgb, parsed.alpha);
      // Explicit Convert / Enter: bring the converted formats into view on phones.
      revealOutput(formatsEl?.closest<HTMLElement>(".ds-card"));
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

  shadesEl?.addEventListener("click", async (e) => {
    const sw = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-swatch]");
    const hex = sw?.dataset.swatch;
    if (!sw || !hex) return;
    const ok = await copyWithFeedback(sw, hex.toUpperCase(), strings.copied);
    if (!ok) showError(strings.copyFailed);
  });

  function renderContrast(): void {
    if (!fg || !bg) return;
    const f = parseHex(fg.value);
    const b = parseHex(bg.value);
    if (!f || !b) return;
    const r = wcag(f, b);
    // Verdicts use the unrounded ratio; formatRatio never shows a failure as "4.50".
    if (ratioEl) ratioEl.textContent = `${formatRatio(r.ratio)}:1`;
    if (pairEl) pairEl.textContent = fill(strings.pairCaption, { fg: fg.value.toUpperCase(), bg: bg.value.toUpperCase() });
    if (wcagEl) {
      const items: [string, boolean][] = [
        [strings.aaNormal, r.aaNormal],
        [strings.aaaNormal, r.aaaNormal],
        [strings.aaLarge, r.aaLarge],
        [strings.aaaLarge, r.aaaLarge],
      ];
      // Labelled results beside the preview (never inside it): level left, icon + Pass/Fail right.
      wcagEl.replaceChildren(
        ...items.map(([label, ok]) => {
          const li = document.createElement("li");
          const level = document.createElement("span");
          level.className = "wcag-level";
          level.textContent = label;
          const status = document.createElement("span");
          status.className = `ds-status ${ok ? "is-success" : "is-error"}`;
          status.append(verdictIcon(ok), ok ? strings.pass : strings.fail);
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

  swapBtn?.addEventListener("click", () => {
    if (!fg || !bg) return;
    [fg.value, bg.value] = [bg.value, fg.value];
    renderContrast();
  });
  // Explicit, one side only. Translucent colour as text: blend onto the opaque
  // background picker (the only known backdrop); as background it is used opaque.
  useFgBtn?.addEventListener("click", () => {
    if (!fg || !bg) return;
    const backdrop = parseHex(bg.value);
    const rgb = current.alpha < 1 && backdrop ? compositeOver(current.rgb, current.alpha, backdrop) : current.rgb;
    fg.value = toHex(rgb);
    renderContrast();
  });
  useBgBtn?.addEventListener("click", () => {
    if (!bg) return;
    bg.value = toHex(current.rgb);
    renderContrast();
  });

  const initial = parseColor(input?.value || DEFAULT_HEX) ?? parseColor(DEFAULT_HEX)!;
  apply(initial.rgb, initial.alpha);
  renderContrast();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
