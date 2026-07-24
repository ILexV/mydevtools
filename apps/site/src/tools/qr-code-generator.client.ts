/**
 * QR Code Generator client controller. Generate-on-click (legacy parity: no
 * live regenerate). PNG preview + PNG download always; SVG download only for
 * square style without a logo. Color picker ↔ hex text sync, style button
 * group, logo drop zone with preview + clear. Errors are localized via the
 * strings island; WASM error messages are surfaced verbatim (legacy parity).
 */
import { qrPng, qrSvg } from "@/scripts/wasm/qrcode-client";

interface Strings {
  generate: string;
  generating: string;
  errorEmptyContent: string;
  errorInvalidImage: string;
  errorGenerateFailed: string;
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-qrg-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const contentEl = root.querySelector<HTMLTextAreaElement>("[data-qrg-content]");
  const fgEl = root.querySelector<HTMLInputElement>("[data-qrg-fg]");
  const fgTextEl = root.querySelector<HTMLInputElement>("[data-qrg-fg-text]");
  const bgEl = root.querySelector<HTMLInputElement>("[data-qrg-bg]");
  const bgTextEl = root.querySelector<HTMLInputElement>("[data-qrg-bg-text]");
  const styleBtns = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-qrg-style]"));
  const ecEl = root.querySelector<HTMLSelectElement>("[data-qrg-ec]");
  const sizeEl = root.querySelector<HTMLSelectElement>("[data-qrg-size]");
  const dropEl = root.querySelector<HTMLElement>("[data-qrg-logodrop]");
  const logoInputEl = root.querySelector<HTMLInputElement>("[data-qrg-logo]");
  const logoClearEl = root.querySelector<HTMLButtonElement>("[data-qrg-logo-clear]");
  const logoEmptyEl = root.querySelector<HTMLElement>("[data-qrg-logo-empty]");
  const logoSelectedEl = root.querySelector<HTMLElement>("[data-qrg-logo-selected]");
  const logoPreviewEl = root.querySelector<HTMLImageElement>("[data-qrg-logo-preview]");
  const logoChooseEl = root.querySelector<HTMLButtonElement>("[data-qrg-logo-choose]");
  const logoChangeEl = root.querySelector<HTMLButtonElement>("[data-qrg-logo-change]");
  const generateBtn = root.querySelector<HTMLButtonElement>("[data-qrg-generate]");
  const generateLabelEl = root.querySelector<HTMLElement>("[data-qrg-generate-label]");
  const placeholderEl = root.querySelector<HTMLElement>("[data-qrg-placeholder]");
  const previewImgEl = root.querySelector<HTMLImageElement>("[data-qrg-preview]");
  const loadingEl = root.querySelector<HTMLElement>("[data-qrg-loading]");
  const downloadPngEl = root.querySelector<HTMLAnchorElement>("[data-qrg-download-png]");
  const downloadSvgEl = root.querySelector<HTMLAnchorElement>("[data-qrg-download-svg]");
  const errorEl = root.querySelector<HTMLElement>("[data-qrg-error]");

  if (
    !contentEl || !fgEl || !fgTextEl || !bgEl || !bgTextEl || !ecEl || !sizeEl ||
    !dropEl || !logoInputEl || !logoClearEl || !logoEmptyEl || !logoSelectedEl || !logoPreviewEl ||
    !generateBtn || !generateLabelEl || !placeholderEl || !previewImgEl || !loadingEl ||
    !downloadPngEl || !downloadSvgEl
  ) return;

  const content: HTMLTextAreaElement = contentEl;
  const fgColor: HTMLInputElement = fgEl;
  const fgColorText: HTMLInputElement = fgTextEl;
  const bgColor: HTMLInputElement = bgEl;
  const bgColorText: HTMLInputElement = bgTextEl;
  const ecLevel: HTMLSelectElement = ecEl;
  const size: HTMLSelectElement = sizeEl;
  const drop: HTMLElement = dropEl;
  const logoInput: HTMLInputElement = logoInputEl;
  const logoClear: HTMLButtonElement = logoClearEl;
  const logoEmpty: HTMLElement = logoEmptyEl;
  const logoSelected: HTMLElement = logoSelectedEl;
  const logoPreview: HTMLImageElement = logoPreviewEl;
  const generate: HTMLButtonElement = generateBtn;
  const generateLabel: HTMLElement = generateLabelEl;
  const placeholder: HTMLElement = placeholderEl;
  const previewImg: HTMLImageElement = previewImgEl;
  const loading: HTMLElement = loadingEl;
  const downloadPng: HTMLAnchorElement = downloadPngEl;
  const downloadSvg: HTMLAnchorElement = downloadSvgEl;

  let logoBytes: Uint8Array | null = null;
  let logoPreviewUrl: string | null = null;
  let currentStyle = "square";
  let currentPngUrl: string | null = null;
  let currentSvgUrl: string | null = null;

  function showError(msg: string) {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
  }

  function clearError() {
    if (errorEl) errorEl.hidden = true;
  }

  function syncColorInputs(colorInput: HTMLInputElement, textInput: HTMLInputElement) {
    colorInput.addEventListener("input", () => {
      textInput.value = colorInput.value.toUpperCase();
    });
    textInput.addEventListener("input", () => {
      const val = textInput.value.trim();
      if (/^#?[0-9A-Fa-f]{6}$/.test(val)) {
        colorInput.value = val.startsWith("#") ? val : `#${val}`;
      }
    });
  }
  syncColorInputs(fgColor, fgColorText);
  syncColorInputs(bgColor, bgColorText);

  for (const btn of styleBtns) {
    btn.addEventListener("click", () => {
      for (const b of styleBtns) b.classList.remove("qrg-active");
      btn.classList.add("qrg-active");
      currentStyle = btn.dataset.style ?? "square";
    });
  }

  function showLogoSelection(file: File) {
    logoEmpty.hidden = true;
    logoSelected.hidden = false;
    if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl);
    logoPreviewUrl = URL.createObjectURL(file);
    logoPreview.src = logoPreviewUrl;
    logoClear.hidden = false;
  }

  function removeLogo() {
    logoBytes = null;
    logoInput.value = "";
    logoEmpty.hidden = false;
    logoSelected.hidden = true;
    if (logoPreviewUrl) {
      URL.revokeObjectURL(logoPreviewUrl);
      logoPreviewUrl = null;
    }
    logoPreview.removeAttribute("src");
    logoClear.hidden = true;
  }

  async function handleLogoFile(file: File) {
    clearError();
    if (!file.type.match("image.*")) {
      // Legacy parity: keep any previously set logo, just flag the error.
      logoInput.value = "";
      showError(strings.errorInvalidImage);
      return;
    }
    logoBytes = new Uint8Array(await file.arrayBuffer());
    showLogoSelection(file);
    // Allow re-selecting the same file: selection state no longer depends on
    // input.files, so the value can be reset immediately.
    logoInput.value = "";
  }

  drop.addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.closest("button")) return;
    logoInput.click();
  });
  logoChooseEl?.addEventListener("click", (e) => {
    e.stopPropagation();
    logoInput.click();
  });
  logoChangeEl?.addEventListener("click", (e) => {
    e.stopPropagation();
    logoInput.click();
  });
  logoInput.addEventListener("change", () => {
    const file = logoInput.files?.[0];
    if (file) {
      void handleLogoFile(file);
    } else {
      removeLogo();
    }
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("qrg-dragover");
  });
  drop.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && drop.contains(e.relatedTarget)) return;
    drop.classList.remove("qrg-dragover");
  });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("qrg-dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleLogoFile(file);
  });
  logoClear.addEventListener("click", (e) => {
    e.stopPropagation();
    removeLogo();
    clearError();
  });

  async function generateQrCode() {
    const value = content.value.trim();
    if (!value) {
      showError(strings.errorEmptyContent);
      return;
    }

    generate.disabled = true;
    generateLabel.textContent = strings.generating;
    loading.hidden = false;
    clearError();

    try {
      const pngBytes = await qrPng(value, {
        size: parseInt(size.value, 10),
        fgColor: fgColor.value,
        bgColor: bgColor.value,
        ecLevel: ecLevel.value,
        style: currentStyle,
        logoData: logoBytes,
      });

      const pngBlob = new Blob([pngBytes.slice()], { type: "image/png" });
      if (currentPngUrl) URL.revokeObjectURL(currentPngUrl);
      currentPngUrl = URL.createObjectURL(pngBlob);

      placeholder.hidden = true;
      previewImg.hidden = false;
      previewImg.src = currentPngUrl;

      downloadPng.href = currentPngUrl;
      downloadPng.download = "qrcode.png";
      downloadPng.hidden = false;

      // SVG only for the simple case: no logo and square style (legacy parity).
      if (!logoBytes && currentStyle === "square") {
        try {
          const svgString = await qrSvg(value, fgColor.value, bgColor.value, ecLevel.value);
          const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
          if (currentSvgUrl) URL.revokeObjectURL(currentSvgUrl);
          currentSvgUrl = URL.createObjectURL(svgBlob);
          downloadSvg.href = currentSvgUrl;
          downloadSvg.download = "qrcode.svg";
          downloadSvg.hidden = false;
        } catch {
          downloadSvg.hidden = true;
        }
      } else {
        downloadSvg.hidden = true;
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : strings.errorGenerateFailed);
    } finally {
      generate.disabled = false;
      generateLabel.textContent = strings.generate;
      loading.hidden = true;
    }
  }

  generate.addEventListener("click", () => {
    void generateQrCode();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
