/**
 * Image Converter client controller. Image picked via file dialog, drag-drop,
 * or the change/clear buttons; converted by the image-tools WASM module
 * (`convertImage`). Quality slider (1-100, default 90) is only shown for
 * lossy targets (jpeg/webp — legacy parity). Result is previewed with its
 * byte size and downloaded under the original name with the new extension
 * (jpeg → jpg). WASM/format errors surface their message (legacy parity).
 */
import { convertImage } from "@/scripts/wasm/image-tools-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  convert: string;
  processing: string;
  errorNotImage: string;
  errorConversion: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-imgv-strings]");
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
  const root = document.querySelector<HTMLElement>("[data-imgv-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const dropZone = root.querySelector<HTMLElement>("[data-imgv-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-imgv-file]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-imgv-clear]");
  const emptyState = root.querySelector<HTMLElement>("[data-imgv-empty]");
  const selectedState = root.querySelector<HTMLElement>("[data-imgv-selected]");
  const chooseBtn = root.querySelector<HTMLButtonElement>("[data-imgv-choose]");
  const changeBtn = root.querySelector<HTMLButtonElement>("[data-imgv-change]");
  const previewImg = root.querySelector<HTMLImageElement>("[data-imgv-preview]");
  const nameEl = root.querySelector<HTMLElement>("[data-imgv-filename]");
  const sizeEl = root.querySelector<HTMLElement>("[data-imgv-filesize]");
  const formatSelect = root.querySelector<HTMLSelectElement>("[data-imgv-format]");
  const qualityContainer = root.querySelector<HTMLElement>("[data-imgv-quality-container]");
  const qualityInput = root.querySelector<HTMLInputElement>("[data-imgv-quality]");
  const qualityValue = root.querySelector<HTMLElement>("[data-imgv-quality-value]");
  const convertBtn = root.querySelector<HTMLButtonElement>("[data-imgv-convert]");
  const convertLabel = root.querySelector<HTMLElement>("[data-imgv-convert-label]");
  const resultSection = root.querySelector<HTMLElement>("[data-imgv-result]");
  const outputImg = root.querySelector<HTMLImageElement>("[data-imgv-output]");
  const outputSize = root.querySelector<HTMLElement>("[data-imgv-output-size]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-imgv-download]");
  const errorBox = root.querySelector<HTMLElement>("[data-imgv-error]");

  if (
    !dropZone || !fileInput || !emptyState || !selectedState || !previewImg ||
    !formatSelect || !qualityContainer || !qualityInput || !convertBtn ||
    !resultSection || !outputImg || !downloadBtn
  ) return;
  const zone: HTMLElement = dropZone;
  const input: HTMLInputElement = fileInput;
  const emptyEl: HTMLElement = emptyState;
  const selectedEl: HTMLElement = selectedState;
  const preview: HTMLImageElement = previewImg;
  const formatSel: HTMLSelectElement = formatSelect;
  const qualityBox: HTMLElement = qualityContainer;
  const qualityRange: HTMLInputElement = qualityInput;
  const convert: HTMLButtonElement = convertBtn;
  const resultEl: HTMLElement = resultSection;
  const output: HTMLImageElement = outputImg;
  const download: HTMLButtonElement = downloadBtn;

  let currentFile: File | null = null;
  let previewUrl: string | null = null;
  let resultUrl: string | null = null;
  let resultName: string | null = null;
  let converting = false;

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
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
    resultName = null;
    output.removeAttribute("src");
  }

  function updateQualityVisibility() {
    const fmt = formatSel.value;
    qualityBox.hidden = !(fmt === "jpeg" || fmt === "jpg" || fmt === "webp");
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
    convert.disabled = true;
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
    convert.disabled = false;
    // Allow re-selecting the same file: the selection UI no longer depends on
    // input.files, so the value can be reset immediately.
    input.value = "";
  }

  async function handleConvert() {
    if (!currentFile || converting) return;
    const file: File = currentFile;
    const targetFormat = formatSel.value;
    const quality = Number.parseInt(qualityRange.value || "90", 10);

    clearError();
    converting = true;
    convert.disabled = true;
    if (convertLabel) convertLabel.textContent = strings.processing;
    hideResult();

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const resultBytes = await convertImage(bytes, targetFormat, quality);

      // MIME parity with legacy: jpeg → image/jpeg, ico → image/x-icon.
      const mime =
        targetFormat === "jpg" || targetFormat === "jpeg"
          ? "image/jpeg"
          : targetFormat === "ico"
            ? "image/x-icon"
            : `image/${targetFormat}`;
      const blob = new Blob([resultBytes.slice()], { type: mime });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);

      output.src = resultUrl;
      if (outputSize) outputSize.textContent = formatBytes(blob.size);

      const originalName = file.name;
      const lastDot = originalName.lastIndexOf(".");
      const base = lastDot !== -1 ? originalName.substring(0, lastDot) : originalName;
      resultName = `${base}.${targetFormat === "jpeg" ? "jpg" : targetFormat}`;

      resultEl.hidden = false;
    } catch (e) {
      const message =
        e instanceof WasmError || e instanceof Error ? e.message : strings.errorConversion;
      showError(message || strings.errorConversion);
    } finally {
      converting = false;
      convert.disabled = false;
      if (convertLabel) convertLabel.textContent = strings.convert;
    }
  }

  function pickFile() {
    if (!converting) input.click();
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

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("imgv-dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("imgv-dragover");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("imgv-dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSelection();
    hideResult();
    clearError();
  });

  formatSel.addEventListener("change", () => {
    updateQualityVisibility();
  });

  qualityRange.addEventListener("input", () => {
    if (qualityValue) qualityValue.textContent = qualityRange.value;
  });

  convert.addEventListener("click", () => {
    void handleConvert();
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

  updateQualityVisibility();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
