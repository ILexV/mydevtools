/**
 * Image Compressor client controller. Image picked via file dialog, drag-drop,
 * or the change/clear buttons; compressed by the image-tools WASM module
 * (`compressImage`). Quality slider (1-100, default 80) is passed through
 * as-is (legacy parity). Output format "original" maps from the source MIME
 * type (jpeg → jpeg, png → png, anything else → webp — legacy parity).
 * Result is previewed with an original → compressed size comparison and a
 * "Done! -N%" savings badge (shown only when savings > 0, legacy parity),
 * and downloaded as `<name>_min.<ext>` (jpeg → jpg — legacy parity).
 * WASM/compression errors surface their message (legacy parity).
 */
import { compressImage } from "@/scripts/wasm/image-tools-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  compress: string;
  compressing: string;
  done: string;
  errorNotImage: string;
  errorCompression: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-imgc-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-imgc-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const dropZone = root.querySelector<HTMLElement>("[data-imgc-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-imgc-file]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-imgc-clear]");
  const emptyState = root.querySelector<HTMLElement>("[data-imgc-empty]");
  const selectedState = root.querySelector<HTMLElement>("[data-imgc-selected]");
  const chooseBtn = root.querySelector<HTMLButtonElement>("[data-imgc-choose]");
  const changeBtn = root.querySelector<HTMLButtonElement>("[data-imgc-change]");
  const previewImg = root.querySelector<HTMLImageElement>("[data-imgc-preview]");
  const nameEl = root.querySelector<HTMLElement>("[data-imgc-filename]");
  const sizeEl = root.querySelector<HTMLElement>("[data-imgc-filesize]");
  const qualityInput = root.querySelector<HTMLInputElement>("[data-imgc-quality]");
  const qualityValue = root.querySelector<HTMLElement>("[data-imgc-quality-value]");
  const formatSelect = root.querySelector<HTMLSelectElement>("[data-imgc-format]");
  const compressBtn = root.querySelector<HTMLButtonElement>("[data-imgc-compress]");
  const compressLabel = root.querySelector<HTMLElement>("[data-imgc-compress-label]");
  const resultSection = root.querySelector<HTMLElement>("[data-imgc-result]");
  const badgeEl = root.querySelector<HTMLElement>("[data-imgc-badge]");
  const outputImg = root.querySelector<HTMLImageElement>("[data-imgc-output]");
  const originalSizeEl = root.querySelector<HTMLElement>("[data-imgc-original-size]");
  const compressedSizeEl = root.querySelector<HTMLElement>("[data-imgc-compressed-size]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-imgc-download]");
  const errorBox = root.querySelector<HTMLElement>("[data-imgc-error]");

  if (
    !dropZone || !fileInput || !emptyState || !selectedState || !previewImg ||
    !qualityInput || !formatSelect || !compressBtn || !resultSection ||
    !outputImg || !downloadBtn
  ) return;
  const zone: HTMLElement = dropZone;
  const input: HTMLInputElement = fileInput;
  const emptyEl: HTMLElement = emptyState;
  const selectedEl: HTMLElement = selectedState;
  const preview: HTMLImageElement = previewImg;
  const qualityRange: HTMLInputElement = qualityInput;
  const formatSel: HTMLSelectElement = formatSelect;
  const compress: HTMLButtonElement = compressBtn;
  const resultEl: HTMLElement = resultSection;
  const output: HTMLImageElement = outputImg;
  const download: HTMLButtonElement = downloadBtn;

  let currentFile: File | null = null;
  let previewUrl: string | null = null;
  let resultUrl: string | null = null;
  let resultName: string | null = null;
  let compressing = false;

  function showError(msg: string) {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  function hideResult() {
    resultEl.hidden = true;
    if (badgeEl) badgeEl.hidden = true;
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
    resultName = null;
    output.removeAttribute("src");
  }

  function showSelection(file: File) {
    emptyEl.hidden = true;
    selectedEl.hidden = false;
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = formatBytes(file.size);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    if (clearBtn) clearBtn.hidden = false;
  }

  function clearSelection() {
    currentFile = null;
    input.value = "";
    emptyEl.hidden = false;
    selectedEl.hidden = true;
    if (nameEl) nameEl.textContent = "";
    if (sizeEl) sizeEl.textContent = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    preview.removeAttribute("src");
    if (clearBtn) clearBtn.hidden = true;
    compress.disabled = true;
  }

  async function handleFile(file: File) {
    clearError();
    hideResult();

    if (!file.type.startsWith("image/")) {
      clearSelection();
      showError(strings.errorNotImage);
      return;
    }

    currentFile = file;
    showSelection(file);
    compress.disabled = false;
    // Allow re-selecting the same file: the selection UI no longer depends on
    // input.files, so the value can be reset immediately.
    input.value = "";
  }

  async function handleCompress() {
    if (!currentFile || compressing) return;
    const file: File = currentFile;
    const quality = Number.parseInt(qualityRange.value || "80", 10);

    let targetFormat = formatSel.value;
    if (targetFormat === "original") {
      // Legacy parity: jpeg → jpeg, png → png, anything else → webp.
      const type = file.type.split("/")[1];
      targetFormat = type === "jpeg" ? "jpeg" : type === "png" ? "png" : "webp";
    }

    clearError();
    compressing = true;
    compress.disabled = true;
    if (compressLabel) compressLabel.textContent = strings.compressing;
    hideResult();

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const resultBytes = await compressImage(bytes, targetFormat, quality);

      const blob = new Blob([resultBytes.slice()], { type: `image/${targetFormat}` });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);

      output.src = resultUrl;
      if (originalSizeEl) originalSizeEl.textContent = formatBytes(file.size);
      if (compressedSizeEl) compressedSizeEl.textContent = formatBytes(blob.size);

      // Legacy parity: "Done! -N%" badge, only when savings are positive.
      const savedPct = Math.round((1 - blob.size / file.size) * 100);
      if (badgeEl) {
        if (savedPct > 0) {
          badgeEl.textContent = `${strings.done} -${savedPct}%`;
          badgeEl.hidden = false;
        } else {
          badgeEl.hidden = true;
        }
      }

      const dotIndex = file.name.lastIndexOf(".");
      const base = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
      resultName = `${base}_min.${targetFormat === "jpeg" ? "jpg" : targetFormat}`;

      resultEl.hidden = false;
    } catch (e) {
      const message =
        e instanceof WasmError || e instanceof Error ? e.message : strings.errorCompression;
      showError(message || strings.errorCompression);
    } finally {
      compressing = false;
      compress.disabled = false;
      if (compressLabel) compressLabel.textContent = strings.compress;
    }
  }

  function pickFile() {
    if (!compressing) input.click();
  }

  // Clicking the zone (but not a button inside it) opens the file dialog.
  zone.addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.closest("button")) return;
    pickFile();
  });
  chooseBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    pickFile();
  });
  changeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    pickFile();
  });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void handleFile(file);
  });

  // Show the source dimensions once the preview has decoded.
  preview.addEventListener("load", () => {
    if (!currentFile || !sizeEl || !preview.naturalWidth) return;
    sizeEl.textContent = `${formatBytes(currentFile.size)} · ${preview.naturalWidth}×${preview.naturalHeight}`;
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("imgc-dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("imgc-dragover");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("imgc-dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSelection();
    hideResult();
    clearError();
  });

  qualityRange.addEventListener("input", () => {
    if (qualityValue) qualityValue.textContent = `${qualityRange.value}%`;
  });

  compress.addEventListener("click", () => {
    void handleCompress();
  });

  download.addEventListener("click", () => {
    if (!resultUrl || !resultName) return;
    const a = document.createElement("a");
    a.href = resultUrl;
    a.download = resultName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
