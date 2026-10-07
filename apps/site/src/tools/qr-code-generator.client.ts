/**
 * QR Code Generator client controller — live preview. Any change (content,
 * colours, style, error correction, size, logo) regenerates the PNG after a
 * 200 ms trailing debounce, deferred while an IME composition is open. A
 * latest-request gate drops out-of-order results; while updating, the old
 * image stays with an "Updating…" chip and downloads are disabled. Empty
 * input clears preview + downloads; capacity errors replace stale success.
 * Advice (never a scan guarantee): luminance contrast + low/inverted warning,
 * pixels-per-module warning, logo → high EC + real-device testing.
 * SVG download only for square style without a logo (legacy parity).
 */
import { qrPng, qrSvg } from "@/scripts/wasm/qrcode-client";
import {
  announce,
  bindDropzone,
  bindEmptyState,
  bindLoadExample,
  setDropzoneHasFile,
  setFieldValue,
  withPreparing,
} from "@/scripts/tool-ui";
import { formatString } from "@/lib/format";
import {
  QR_MIN_PX_PER_MODULE,
  assessQrContrast,
  classifyGenerateError,
  createLatestGate,
  isDecodableImageType,
  normalizeHexColor,
  pixelsPerModule,
  svgModuleGeometry,
} from "@/tools/qr-code";

/** Language-neutral example payload for "Load example" (inserted only on click). */
const EXAMPLE = "https://example.com/";
/** Trailing debounce before a live regeneration. */
const DEBOUNCE_MS = 200;
/** Quiet period after a settled generation before the polite "ready" announcement. */
const ANNOUNCE_SETTLE_MS = 700;

interface Strings {
  updating: string;
  announceReady: string;
  contrastValue: string;
  contrastLow: string;
  contrastInverted: string;
  moduleSizeSmall: string;
  errorInvalidImage: string;
  errorGenerateFailed: string;
  errorTooLong: string;
  errorInvalidColor: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-qrg-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

/** Add/remove one id token in an element's aria-describedby list (warnings ↔ controls). */
function toggleDescribedBy(el: Element, id: string, on: boolean) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((t) => t && t !== id);
  if (on) ids.push(id);
  if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
  else el.removeAttribute("aria-describedby");
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-qrg-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  root.dataset.initialized = "true";
  const strings: Strings = raw;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);

  const content = q<HTMLTextAreaElement>("[data-qrg-content]");
  const contentHost = q<HTMLElement>("[data-qrg-content-host]");
  const exampleBtn = q<HTMLButtonElement>("[data-qrg-example]");
  const fgColor = q<HTMLInputElement>("[data-qrg-fg]");
  const fgColorText = q<HTMLInputElement>("[data-qrg-fg-text]");
  const bgColor = q<HTMLInputElement>("[data-qrg-bg]");
  const bgColorText = q<HTMLInputElement>("[data-qrg-bg-text]");
  const contrastEl = q<HTMLElement>("[data-qrg-contrast]");
  const contrastWarn = q<HTMLElement>("[data-qrg-contrast-warn]");
  const styleBtns = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-qrg-style]"));
  const ecLevel = q<HTMLSelectElement>("[data-qrg-ec]");
  const size = q<HTMLSelectElement>("[data-qrg-size]");
  const sizeHint = q<HTMLElement>("[data-qrg-size-hint]");
  const drop = q<HTMLElement>("[data-qrg-logodrop]");
  const logoInput = q<HTMLInputElement>("[data-qrg-logo]");
  const logoClear = q<HTMLButtonElement>("[data-qrg-logo-clear]");
  const logoSelected = q<HTMLElement>("[data-qrg-logo-selected]");
  const logoPreview = q<HTMLImageElement>("[data-qrg-logo-preview]");
  const logoAdvice = q<HTMLElement>("[data-qrg-logo-advice]");
  const previewBox = q<HTMLElement>("[data-qrg-preview-box]");
  const placeholder = q<HTMLElement>("[data-qrg-placeholder]");
  const previewImg = q<HTMLImageElement>("[data-qrg-preview]");
  const loading = q<HTMLElement>("[data-qrg-loading]");
  const downloadPng = q<HTMLAnchorElement>("[data-qrg-download-png]");
  const downloadSvg = q<HTMLAnchorElement>("[data-qrg-download-svg]");
  const errorEl = q<HTMLElement>("[data-qrg-error]");

  if (
    !content || !fgColor || !fgColorText || !bgColor || !bgColorText || !contrastEl || !contrastWarn ||
    !ecLevel || !size || !sizeHint || !drop || !logoInput || !logoClear || !logoSelected || !logoPreview ||
    !logoAdvice || !previewBox || !placeholder || !previewImg || !loading || !downloadPng || !downloadSvg || !errorEl
  ) return;

  const lang = document.documentElement.lang || "en";
  const ratioFormat = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const gate = createLatestGate();
  /** Matrix width (modules) per error level + content — repaint-only changes skip re-deriving it. */
  const moduleCache = new Map<string, number>();

  let logoBytes: Uint8Array | null = null;
  let logoPreviewUrl: string | null = null;
  let currentStyle = "square";
  let currentPngUrl: string | null = null;
  let currentSvgUrl: string | null = null;
  let hasImage = false;
  let lastModules: number | null = null;
  let composing = false;
  let debounceTimer = 0;
  let announceTimer = 0;
  /** Announce "ready" on the first image after empty/error, and after option changes — not per keystroke. */
  let announcedReady = false;
  let optionChanged = false;

  function showError(msg: string) {
    if (errorEl!.hidden || errorEl!.textContent !== msg) errorEl!.textContent = msg;
    errorEl!.hidden = false;
    toggleDescribedBy(content!, errorEl!.id, true);
  }
  function clearError() {
    errorEl!.hidden = true;
    errorEl!.textContent = "";
    toggleDescribedBy(content!, errorEl!.id, false);
  }

  /** Downloads stay visible but inert (aria-disabled, no href) until the image matches the inputs. */
  function setDownloadsCurrent(current: boolean) {
    for (const [a, url] of [[downloadPng!, currentPngUrl], [downloadSvg!, currentSvgUrl]] as const) {
      if (current && url) {
        a.href = url;
        a.removeAttribute("aria-disabled");
      } else {
        a.removeAttribute("href");
        a.setAttribute("aria-disabled", "true");
      }
    }
  }

  /** Empty input / failed generation: drop the image, downloads and their object URLs. */
  function clearPreview() {
    if (currentPngUrl) URL.revokeObjectURL(currentPngUrl);
    if (currentSvgUrl) URL.revokeObjectURL(currentSvgUrl);
    currentPngUrl = currentSvgUrl = null;
    previewImg!.removeAttribute("src");
    previewImg!.hidden = true;
    placeholder!.hidden = false;
    previewBox!.classList.remove("is-stale");
    loading!.hidden = true;
    downloadPng!.hidden = true;
    downloadSvg!.hidden = true;
    setDownloadsCurrent(false);
    hasImage = false;
    announcedReady = false;
    updateModuleHint(null);
  }

  /** Pixels-per-module warning for the selected raster size (needs the matrix width). */
  function updateModuleHint(modules: number | null) {
    lastModules = modules;
    const px = modules ? pixelsPerModule(parseInt(size!.value, 10), modules) : 0;
    const warn = modules !== null && px > 0 && px < QR_MIN_PX_PER_MODULE;
    sizeHint!.textContent = warn ? formatString(strings.moduleSizeSmall, px) : "";
    sizeHint!.hidden = !warn;
    toggleDescribedBy(size!, sizeHint!.id, warn);
  }

  /** Contrast line + low/inverted warning under the colour controls. */
  function updateContrast() {
    const c = assessQrContrast(fgColorText!.value, bgColorText!.value);
    contrastEl!.textContent = c ? formatString(strings.contrastValue, ratioFormat.format(c.display)) : "";
    contrastEl!.hidden = !c;
    const level = c?.level ?? "ok";
    contrastWarn!.textContent = level === "inverted" ? strings.contrastInverted : level === "low" ? strings.contrastLow : "";
    contrastWarn!.hidden = level === "ok";
    contrastWarn!.classList.toggle("is-strong", level === "inverted");
    for (const el of [fgColor!, fgColorText!, bgColor!, bgColorText!]) {
      toggleDescribedBy(el, contrastEl!.id, !!c);
      toggleDescribedBy(el, contrastWarn!.id, level !== "ok");
    }
  }

  /** Two-way sync picker ↔ hex field; an invalid hex is flagged, not applied. */
  function syncColorInputs(picker: HTMLInputElement, text: HTMLInputElement, hint: HTMLElement | null) {
    const setInvalid = (invalid: boolean) => {
      if (invalid) text.setAttribute("aria-invalid", "true");
      else text.removeAttribute("aria-invalid");
      if (hint) {
        hint.textContent = invalid ? strings.errorInvalidColor : "";
        hint.hidden = !invalid;
        if (hint.id) toggleDescribedBy(text, hint.id, invalid);
      }
    };
    picker.addEventListener("input", () => {
      text.value = picker.value.toUpperCase();
      setInvalid(false);
      updateContrast();
      schedule(true);
    });
    text.addEventListener("input", () => {
      const hex = normalizeHexColor(text.value);
      if (hex) picker.value = hex.toLowerCase();
      // Don't flag while the user is still typing a short value.
      setInvalid(!hex && text.value.trim().replace(/^#/, "").length >= 6);
      updateContrast();
      schedule(true);
    });
    text.addEventListener("change", () => {
      const hex = normalizeHexColor(text.value);
      if (hex) text.value = hex;
      setInvalid(!hex);
    });
  }
  const fgHint = root.querySelector<HTMLElement>("[data-qrg-fg-hint]");
  const bgHint = root.querySelector<HTMLElement>("[data-qrg-bg-hint]");
  // Field.astro renders hintProps' class as a second (ignored) class attribute: apply the tone here.
  fgHint?.classList.add("ds-hint-error");
  bgHint?.classList.add("ds-hint-error");
  sizeHint.classList.add("qrg-warn");
  if (fgHint) fgHint.id = "qrg-fg-hint";
  if (bgHint) bgHint.id = "qrg-bg-hint";
  syncColorInputs(fgColor, fgColorText, fgHint);
  syncColorInputs(bgColor, bgColorText, bgHint);

  for (const btn of styleBtns) {
    btn.addEventListener("click", () => {
      for (const b of styleBtns) b.setAttribute("aria-pressed", String(b === btn));
      if (currentStyle === (btn.dataset.style ?? "square")) return;
      currentStyle = btn.dataset.style ?? "square";
      schedule(true);
    });
  }

  /** Logo present → advice (high EC + real-device testing), linked to the logo and EC controls. */
  function syncLogoAdvice() {
    const on = logoBytes !== null;
    logoAdvice!.hidden = !on;
    toggleDescribedBy(logoInput!, logoAdvice!.id, on);
    toggleDescribedBy(ecLevel!, logoAdvice!.id, on);
  }

  function removeLogo() {
    logoBytes = null;
    logoInput!.value = "";
    logoSelected!.hidden = true;
    setDropzoneHasFile(drop!, false);
    if (logoPreviewUrl) {
      URL.revokeObjectURL(logoPreviewUrl);
      logoPreviewUrl = null;
    }
    logoPreview!.removeAttribute("src");
    syncLogoAdvice();
  }

  async function handleLogoFile(file: File) {
    clearError();
    // Only formats the WASM decoder supports (png/jpeg/webp): a GIF/SVG logo
    // would preview fine but silently be dropped from the QR code.
    if (!isDecodableImageType(file.type)) {
      // Legacy parity: keep any previously set logo, just flag the error.
      showError(strings.errorInvalidImage);
      return;
    }
    try {
      logoBytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      showError(strings.errorInvalidImage);
      return;
    }
    if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl);
    logoPreviewUrl = URL.createObjectURL(file);
    logoPreview!.src = logoPreviewUrl;
    logoSelected!.hidden = false;
    setDropzoneHasFile(drop!, true);
    syncLogoAdvice();
    schedule(true);
  }

  bindDropzone(drop, logoInput, (files) => {
    if (files[0]) void handleLogoFile(files[0]);
  });
  logoClear.addEventListener("click", (e) => {
    e.stopPropagation();
    removeLogo();
    clearError();
    schedule(true);
  });

  /** Inputs changed: mark the shown image stale and (re)start the trailing debounce. */
  function schedule(isOption = false) {
    if (isOption) optionChanged = true;
    window.clearTimeout(announceTimer);
    if (composing) return;
    if (hasImage) {
      previewBox!.classList.add("is-stale");
      loading!.hidden = false;
      setDownloadsCurrent(false);
    }
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void regenerate(), DEBOUNCE_MS);
  }

  function scheduleAnnounce() {
    if (announcedReady && !optionChanged) return;
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      announce(strings.announceReady);
      announcedReady = true;
      optionChanged = false;
    }, ANNOUNCE_SETTLE_MS);
  }

  /** One live regeneration: validate, render PNG (+ SVG / matrix width), commit only if still the latest request. */
  async function regenerate() {
    const value = content!.value.trim();
    if (!value) {
      gate.invalidate();
      clearPreview();
      clearError();
      return;
    }
    const fg = normalizeHexColor(fgColorText!.value);
    const bg = normalizeHexColor(bgColorText!.value);
    if (!fg || !bg) {
      // Keep the dimmed previous image (downloads stay off); the field hint explains.
      gate.invalidate();
      loading!.hidden = true;
      return;
    }

    const id = gate.begin();
    const ec = ecLevel!.value;
    const style = currentStyle;
    const logo = logoBytes;
    const sizePx = parseInt(size!.value, 10);
    const wantSvg = !logo && style === "square";
    const cacheKey = `${ec}\u0000${value}`;

    try {
      const pngBytes = await withPreparing(
        "qrcode",
        qrPng(value, { size: sizePx, fgColor: fg, bgColor: bg, ecLevel: ec, style, logoData: logo }),
        { host: previewBox!.closest<HTMLElement>(".ds-card"), label: strings.preparing },
      );
      if (!gate.isCurrent(id)) return;

      let modules = moduleCache.get(cacheKey) ?? null;
      let svg: string | null = null;
      if (wantSvg || modules === null) {
        try {
          svg = await qrSvg(value, fg, bg, ec);
        } catch {
          /* PNG is still available */
        }
        if (!gate.isCurrent(id)) return;
        if (svg && modules === null) {
          modules = svgModuleGeometry(svg)?.modules ?? null;
          if (modules !== null) {
            if (moduleCache.size > 64) moduleCache.clear();
            moduleCache.set(cacheKey, modules);
          }
        }
      }

      // Commit: swap object URLs (release the replaced ones once the new image is decoded).
      const oldPng = currentPngUrl;
      const oldSvg = currentSvgUrl;
      currentPngUrl = URL.createObjectURL(new Blob([pngBytes.slice()], { type: "image/png" }));
      currentSvgUrl = wantSvg && svg ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) : null;
      previewImg!.src = currentPngUrl;
      previewImg!.hidden = false;
      placeholder!.hidden = true;
      void previewImg!.decode().catch(() => undefined).finally(() => {
        if (oldPng) URL.revokeObjectURL(oldPng);
      });
      if (oldSvg) URL.revokeObjectURL(oldSvg);

      downloadPng!.download = "qrcode.png";
      downloadPng!.hidden = false;
      downloadSvg!.download = "qrcode.svg";
      downloadSvg!.hidden = !currentSvgUrl;
      setDownloadsCurrent(true);
      previewBox!.classList.remove("is-stale");
      loading!.hidden = true;
      hasImage = true;
      clearError();
      updateModuleHint(modules);
      scheduleAnnounce();
    } catch (e) {
      if (!gate.isCurrent(id)) return;
      // A capacity (or other) error replaces the stale success: no outdated code to download.
      clearPreview();
      const kind = classifyGenerateError(e instanceof Error ? e.message : String(e));
      showError(
        kind === "tooLong" ? strings.errorTooLong
          : kind === "invalidColor" ? strings.errorInvalidColor
          : strings.errorGenerateFailed,
      );
    }
  }

  if (contentHost) bindEmptyState(contentHost, content);
  if (exampleBtn) bindLoadExample(exampleBtn, () => setFieldValue(content, EXAMPLE));

  // Live preview; IME: wait for compositionend instead of encoding half-composed text.
  content.addEventListener("input", (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    schedule();
  });
  content.addEventListener("compositionstart", () => {
    composing = true;
    window.clearTimeout(debounceTimer);
  });
  content.addEventListener("compositionend", () => {
    composing = false;
    schedule();
  });
  ecLevel.addEventListener("change", () => schedule(true));
  size.addEventListener("change", () => {
    // Density is known for the current content: warn right away, before the new raster arrives.
    updateModuleHint(lastModules);
    schedule(true);
  });

  updateContrast();
  syncLogoAdvice();
  // Back/forward navigation may restore a value without an input event.
  if (content.value.trim()) schedule();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
