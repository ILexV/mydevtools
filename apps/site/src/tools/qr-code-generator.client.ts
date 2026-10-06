/**
 * QR Code Generator client controller. Generate-on-click (legacy parity: no
 * live regenerate). PNG preview + PNG download always; SVG download only for
 * square style without a logo. Color picker ↔ hex text sync (invalid hex →
 * aria-invalid + hint, blocks generation), `.seg` style group (aria-pressed),
 * logo drop zone (`bindDropzone`, png/jpeg/webp only) with preview + remove.
 * WASM errors are mapped to localized messages (too long / generic).
 */
import { qrPng, qrSvg } from "@/scripts/wasm/qrcode-client";
import { bindDropzone, setDropzoneHasFile } from "@/scripts/tool-ui";
import { classifyGenerateError, isDecodableImageType, normalizeHexColor } from "@/tools/qr-code";

interface Strings {
  generate: string;
  generating: string;
  errorEmptyContent: string;
  errorInvalidImage: string;
  errorGenerateFailed: string;
  errorTooLong: string;
  errorInvalidColor: string;
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
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  root.dataset.initialized = "true";
  const strings: Strings = raw;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);

  const content = q<HTMLTextAreaElement>("[data-qrg-content]");
  const fgColor = q<HTMLInputElement>("[data-qrg-fg]");
  const fgColorText = q<HTMLInputElement>("[data-qrg-fg-text]");
  const bgColor = q<HTMLInputElement>("[data-qrg-bg]");
  const bgColorText = q<HTMLInputElement>("[data-qrg-bg-text]");
  const styleBtns = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-qrg-style]"));
  const ecLevel = q<HTMLSelectElement>("[data-qrg-ec]");
  const size = q<HTMLSelectElement>("[data-qrg-size]");
  const drop = q<HTMLElement>("[data-qrg-logodrop]");
  const logoInput = q<HTMLInputElement>("[data-qrg-logo]");
  const logoClear = q<HTMLButtonElement>("[data-qrg-logo-clear]");
  const logoSelected = q<HTMLElement>("[data-qrg-logo-selected]");
  const logoPreview = q<HTMLImageElement>("[data-qrg-logo-preview]");
  const generate = q<HTMLButtonElement>("[data-qrg-generate]");
  const generateLabel = q<HTMLElement>("[data-qrg-generate-label]");
  const placeholder = q<HTMLElement>("[data-qrg-placeholder]");
  const previewImg = q<HTMLImageElement>("[data-qrg-preview]");
  const loading = q<HTMLElement>("[data-qrg-loading]");
  const downloadPng = q<HTMLAnchorElement>("[data-qrg-download-png]");
  const downloadSvg = q<HTMLAnchorElement>("[data-qrg-download-svg]");
  const errorEl = q<HTMLElement>("[data-qrg-error]");

  if (
    !content || !fgColor || !fgColorText || !bgColor || !bgColorText || !ecLevel || !size ||
    !drop || !logoInput || !logoClear || !logoSelected || !logoPreview ||
    !generate || !generateLabel || !placeholder || !previewImg || !loading ||
    !downloadPng || !downloadSvg || !errorEl
  ) return;

  let logoBytes: Uint8Array | null = null;
  let logoPreviewUrl: string | null = null;
  let currentStyle = "square";
  let currentPngUrl: string | null = null;
  let currentSvgUrl: string | null = null;

  function showError(msg: string) {
    errorEl!.textContent = msg;
    errorEl!.hidden = false;
  }
  function clearError() {
    errorEl!.hidden = true;
    errorEl!.textContent = "";
  }

  /** Two-way sync picker ↔ hex field; an invalid hex is flagged, not applied. */
  function syncColorInputs(picker: HTMLInputElement, text: HTMLInputElement, hint: HTMLElement | null) {
    const setInvalid = (invalid: boolean) => {
      if (invalid) text.setAttribute("aria-invalid", "true");
      else text.removeAttribute("aria-invalid");
      if (hint) {
        hint.textContent = invalid ? strings.errorInvalidColor : "";
        hint.hidden = !invalid;
        if (invalid && hint.id) text.setAttribute("aria-describedby", hint.id);
      }
    };
    picker.addEventListener("input", () => {
      text.value = picker.value.toUpperCase();
      setInvalid(false);
    });
    text.addEventListener("input", () => {
      const hex = normalizeHexColor(text.value);
      if (hex) picker.value = hex.toLowerCase();
      // Don't flag while the user is still typing a short value.
      setInvalid(!hex && text.value.trim().replace(/^#/, "").length >= 6);
    });
    text.addEventListener("change", () => {
      const hex = normalizeHexColor(text.value);
      if (hex) text.value = hex;
      setInvalid(!hex);
    });
  }
  const fgHint = root.querySelector<HTMLElement>("[data-qrg-fg-hint]");
  const bgHint = root.querySelector<HTMLElement>("[data-qrg-bg-hint]");
  if (fgHint) fgHint.id = "qrg-fg-hint";
  if (bgHint) bgHint.id = "qrg-bg-hint";
  syncColorInputs(fgColor, fgColorText, fgHint);
  syncColorInputs(bgColor, bgColorText, bgHint);

  for (const btn of styleBtns) {
    btn.addEventListener("click", () => {
      for (const b of styleBtns) b.setAttribute("aria-pressed", String(b === btn));
      currentStyle = btn.dataset.style ?? "square";
    });
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
  }

  bindDropzone(drop, logoInput, (files) => {
    if (files[0]) void handleLogoFile(files[0]);
  });
  logoClear.addEventListener("click", (e) => {
    e.stopPropagation();
    removeLogo();
    clearError();
  });

  async function generateQrCode() {
    const value = content!.value.trim();
    if (!value) {
      showError(strings.errorEmptyContent);
      content!.focus();
      return;
    }
    const fg = normalizeHexColor(fgColorText!.value);
    const bg = normalizeHexColor(bgColorText!.value);
    if (!fg || !bg) {
      showError(strings.errorInvalidColor);
      (fg ? bgColorText! : fgColorText!).focus();
      return;
    }

    generate!.disabled = true;
    generate!.setAttribute("aria-busy", "true");
    generateLabel!.textContent = strings.generating;
    loading!.hidden = false;
    clearError();

    try {
      const pngBytes = await qrPng(value, {
        size: parseInt(size!.value, 10),
        fgColor: fg,
        bgColor: bg,
        ecLevel: ecLevel!.value,
        style: currentStyle,
        logoData: logoBytes,
      });

      const pngBlob = new Blob([pngBytes.slice()], { type: "image/png" });
      if (currentPngUrl) URL.revokeObjectURL(currentPngUrl);
      currentPngUrl = URL.createObjectURL(pngBlob);

      placeholder!.hidden = true;
      previewImg!.hidden = false;
      previewImg!.src = currentPngUrl;

      downloadPng!.href = currentPngUrl;
      downloadPng!.download = "qrcode.png";
      downloadPng!.hidden = false;

      // SVG only for the simple case: no logo and square style (legacy parity).
      downloadSvg!.hidden = true;
      if (!logoBytes && currentStyle === "square") {
        try {
          const svgString = await qrSvg(value, fg, bg, ecLevel!.value);
          const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
          if (currentSvgUrl) URL.revokeObjectURL(currentSvgUrl);
          currentSvgUrl = URL.createObjectURL(svgBlob);
          downloadSvg!.href = currentSvgUrl;
          downloadSvg!.download = "qrcode.svg";
          downloadSvg!.hidden = false;
        } catch {
          /* PNG is still available */
        }
      }
    } catch (e) {
      const kind = classifyGenerateError(e instanceof Error ? e.message : String(e));
      showError(
        kind === "tooLong" ? strings.errorTooLong
          : kind === "invalidColor" ? strings.errorInvalidColor
          : strings.errorGenerateFailed,
      );
    } finally {
      generate!.disabled = false;
      generate!.removeAttribute("aria-busy");
      generateLabel!.textContent = strings.generate;
      loading!.hidden = true;
    }
  }

  generate.addEventListener("click", () => {
    void generateQrCode();
  });
  // Ctrl/Cmd+Enter in the content field generates (no live regenerate).
  content.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void generateQrCode();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
