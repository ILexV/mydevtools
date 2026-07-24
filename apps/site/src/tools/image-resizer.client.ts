/**
 * Image Resizer client controller. Image picked via file dialog, drag-drop,
 * or the change/clear buttons; original dimensions are read with an
 * `Image` probe, the aspect-ratio lock auto-computes the opposite
 * dimension on input (legacy parity: only when locked and the edited value
 * is > 0), and `resizeImage` (image-tools WASM) produces the result.
 * Output format is guessed from the source extension (jpg→jpeg, unknown→png).
 * Download name: `<base>_<w>x<h>.<ext>` (jpeg→jpg). Object URLs are revoked
 * on replace/clear.
 */
import { resizeImage } from "@/scripts/wasm/image-tools-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  resize: string;
  resizing: string;
  errorNotImage: string;
  errorLoadImage: string;
  errorInvalidDimensions: string;
  errorResizeFailed: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-imgr-strings]");
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
  const root = document.querySelector<HTMLElement>("[data-imgr-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const errorBox = root.querySelector<HTMLElement>("[data-imgr-error]");
  const dropZone = root.querySelector<HTMLElement>("[data-imgr-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-imgr-file]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-imgr-clear]");
  const emptyState = root.querySelector<HTMLElement>("[data-imgr-empty]");
  const selectedState = root.querySelector<HTMLElement>("[data-imgr-selected]");
  const chooseBtn = root.querySelector<HTMLButtonElement>("[data-imgr-choose]");
  const changeBtn = root.querySelector<HTMLButtonElement>("[data-imgr-change]");
  const previewImg = root.querySelector<HTMLImageElement>("[data-imgr-preview]");
  const nameEl = root.querySelector<HTMLElement>("[data-imgr-filename]");
  const sizeEl = root.querySelector<HTMLElement>("[data-imgr-filesize]");
  const settingsPanel = root.querySelector<HTMLElement>("[data-imgr-settings]");
  const originalInfo = root.querySelector<HTMLElement>("[data-imgr-original-info]");
  const widthInput = root.querySelector<HTMLInputElement>("[data-imgr-width]");
  const heightInput = root.querySelector<HTMLInputElement>("[data-imgr-height]");
  const lockRatio = root.querySelector<HTMLInputElement>("[data-imgr-lock-ratio]");
  const formatSelect = root.querySelector<HTMLSelectElement>("[data-imgr-format]");
  const resizeBtn = root.querySelector<HTMLButtonElement>("[data-imgr-resize]");
  const resizeLabel = root.querySelector<HTMLElement>("[data-imgr-resize-label]");
  const outputSection = root.querySelector<HTMLElement>("[data-imgr-output]");
  const resultImg = root.querySelector<HTMLImageElement>("[data-imgr-result-preview]");
  const outputInfo = root.querySelector<HTMLElement>("[data-imgr-output-info]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-imgr-download]");

  if (
    !errorBox || !dropZone || !fileInput || !emptyState || !selectedState ||
    !previewImg || !settingsPanel || !widthInput || !heightInput || !lockRatio ||
    !formatSelect || !resizeBtn || !outputSection || !resultImg || !downloadBtn
  ) return;
  const errEl: HTMLElement = errorBox;
  const zone: HTMLElement = dropZone;
  const input: HTMLInputElement = fileInput;
  const emptyEl: HTMLElement = emptyState;
  const selectedEl: HTMLElement = selectedState;
  const preview: HTMLImageElement = previewImg;
  const settingsEl: HTMLElement = settingsPanel;
  const widthEl: HTMLInputElement = widthInput;
  const heightEl: HTMLInputElement = heightInput;
  const lockEl: HTMLInputElement = lockRatio;
  const formatEl: HTMLSelectElement = formatSelect;
  const actionBtn: HTMLButtonElement = resizeBtn;
  const outputEl: HTMLElement = outputSection;
  const resultPreview: HTMLImageElement = resultImg;
  const dlBtn: HTMLButtonElement = downloadBtn;

  let currentFile: File | null = null;
  let originalWidth = 0;
  let originalHeight = 0;
  let previewUrl: string | null = null;
  let resultUrl: string | null = null;
  let resizing = false;

  function showError(msg: string) {
    errEl.textContent = msg;
    errEl.hidden = false;
    outputEl.hidden = true;
  }
  function clearError() {
    errEl.hidden = true;
  }

  function hideOutput() {
    outputEl.hidden = true;
    resultPreview.removeAttribute("src");
    if (outputInfo) outputInfo.textContent = "";
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  function clearSelection() {
    input.value = "";
    currentFile = null;
    originalWidth = 0;
    originalHeight = 0;
    emptyEl.hidden = false;
    selectedEl.hidden = true;
    settingsEl.hidden = true;
    widthEl.value = "";
    heightEl.value = "";
    if (nameEl) nameEl.textContent = "";
    if (sizeEl) sizeEl.textContent = "";
    if (originalInfo) originalInfo.textContent = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    preview.removeAttribute("src");
    if (clearBtn) clearBtn.hidden = true;
    actionBtn.disabled = true;
    hideOutput();
  }

  function handleFile(file: File) {
    clearError();
    hideOutput();

    if (!file.type.startsWith("image/")) {
      clearSelection();
      showError(strings.errorNotImage);
      return;
    }

    currentFile = file;
    actionBtn.disabled = true;

    // Show selection (FileDropZone parity: preview + file info + clear).
    emptyEl.hidden = true;
    selectedEl.hidden = false;
    settingsEl.hidden = false;
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = formatBytes(file.size);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    if (clearBtn) clearBtn.hidden = false;
    // Allow re-selecting the same file: selection state no longer depends on
    // input.files, so the value can be reset immediately.
    input.value = "";

    // Probe original dimensions via a temporary object URL (legacy parity).
    const probe = new Image();
    const probeUrl = URL.createObjectURL(file);
    probe.onload = () => {
      if (currentFile !== file) {
        URL.revokeObjectURL(probeUrl);
        return;
      }
      originalWidth = probe.width;
      originalHeight = probe.height;
      URL.revokeObjectURL(probeUrl);

      widthEl.value = String(originalWidth);
      heightEl.value = String(originalHeight);
      if (originalInfo) {
        originalInfo.textContent = `${file.name} (${originalWidth}x${originalHeight}, ${formatBytes(file.size)})`;
      }

      // Guess output format from the source extension (legacy parity).
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
        formatEl.value = ext === "jpg" ? "jpeg" : ext;
      } else {
        formatEl.value = "png";
      }

      actionBtn.disabled = false;
    };
    probe.onerror = () => {
      URL.revokeObjectURL(probeUrl);
      if (currentFile === file) showError(strings.errorLoadImage);
    };
    probe.src = probeUrl;
  }

  // Aspect-ratio lock: editing one dimension recomputes the other from the
  // original ratio (legacy parity: only when locked, dims known, value > 0).
  function handleDimensionInput(changed: "width" | "height") {
    if (!lockEl.checked || originalWidth === 0 || originalHeight === 0) return;
    const w = parseInt(widthEl.value, 10) || 0;
    const h = parseInt(heightEl.value, 10) || 0;
    const ratio = originalWidth / originalHeight;
    if (changed === "width" && w > 0) {
      heightEl.value = String(Math.round(w / ratio));
    } else if (changed === "height" && h > 0) {
      widthEl.value = String(Math.round(h * ratio));
    }
  }

  async function performResize() {
    if (!currentFile || resizing) return;
    const file: File = currentFile;

    const width = parseInt(widthEl.value, 10);
    const height = parseInt(heightEl.value, 10);
    const format = formatEl.value;

    if (!width || !height) {
      showError(strings.errorInvalidDimensions);
      return;
    }

    resizing = true;
    actionBtn.disabled = true;
    if (resizeLabel) resizeLabel.textContent = strings.resizing;
    clearError();

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const resultBytes = await resizeImage(bytes, width, height, format);

      const mimeType = format === "jpeg" || format === "jpg" ? "image/jpeg" : `image/${format}`;
      const blob = new Blob([resultBytes.slice()], { type: mimeType });

      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      resultPreview.src = resultUrl;

      if (outputInfo) {
        outputInfo.textContent = `${width}x${height}, ${formatBytes(blob.size)}`;
      }

      // Download name: `<base>_<w>x<h>.<ext>` (jpeg→jpg), legacy parity.
      const originalName = file.name;
      const dotIdx = originalName.lastIndexOf(".");
      const base = dotIdx !== -1 ? originalName.substring(0, dotIdx) : originalName;
      const ext = format === "jpeg" ? "jpg" : format;
      dlBtn.onclick = () => {
        if (!resultUrl) return;
        const a = document.createElement("a");
        a.href = resultUrl;
        a.download = `${base}_${width}x${height}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };

      outputEl.hidden = false;
    } catch (e) {
      console.error(e);
      showError(e instanceof WasmError && e.message ? `${strings.errorResizeFailed} ${e.message}` : strings.errorResizeFailed);
    } finally {
      resizing = false;
      actionBtn.disabled = false;
      if (resizeLabel) resizeLabel.textContent = strings.resize;
    }
  }

  function pickFile() {
    if (!resizing) input.click();
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
    if (file) handleFile(file);
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("imgr-dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("imgr-dragover");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("imgr-dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSelection();
    clearError();
  });

  widthEl.addEventListener("input", () => handleDimensionInput("width"));
  heightEl.addEventListener("input", () => handleDimensionInput("height"));

  actionBtn.addEventListener("click", () => {
    void performResize();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
