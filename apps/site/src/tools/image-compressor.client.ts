/**
 * Image Compressor client controller. Image picked via the drop zone
 * (`bindDropzone`: drag-drop, zone click, keyboard-reachable file button);
 * compressed by the image-tools WASM worker (`compressImage`, cancellable via
 * AbortController). Quality slider (1-100, default 80) is passed through
 * as-is (legacy parity). Output format "original" maps from the source MIME
 * type (jpeg → jpeg, png → png, anything else → webp — legacy parity).
 * Result is previewed with an original → compressed size comparison and a
 * "Done! -N%" savings badge (shown only when savings > 0, legacy parity),
 * and downloaded as `<name>_min.<ext>` (jpeg → jpg — legacy parity).
 */
import { compressImage } from "@/scripts/wasm/image-tools-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, setDropzoneHasFile } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import {
  compressedName,
  isDecodableImage,
  isImageFile,
  mimeFor,
  resolveCompressFormat,
  savingsPercent,
} from "@/tools/image-tools";

interface Strings {
  compress: string;
  compressing: string;
  done: string;
  errorNotImage: string;
  errorUnsupported: string;
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-imgc-tool]");
  if (!root || root.dataset.initialized) return;
  const strings = readStrings();
  if (!strings) return;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);

  const zone = q<HTMLElement>("[data-imgc-dropzone]");
  const input = q<HTMLInputElement>("[data-imgc-file]");
  const selectedEl = q<HTMLElement>("[data-imgc-selected]");
  const preview = q<HTMLImageElement>("[data-imgc-preview]");
  const nameEl = q<HTMLElement>("[data-imgc-filename]");
  const sizeEl = q<HTMLElement>("[data-imgc-filesize]");
  const clearBtn = q<HTMLButtonElement>("[data-imgc-clear]");
  const qualityRange = q<HTMLInputElement>("[data-imgc-quality]");
  const qualityValue = q<HTMLElement>("[data-imgc-quality-value]");
  const formatSel = q<HTMLSelectElement>("[data-imgc-format]");
  const compressBtn = q<HTMLButtonElement>("[data-imgc-compress]");
  const compressLabel = q<HTMLElement>("[data-imgc-compress-label]");
  const progressEl = q<HTMLElement>("[data-imgc-progress]");
  const cancelBtn = q<HTMLButtonElement>("[data-imgc-cancel]");
  const errorBox = q<HTMLElement>("[data-imgc-error]");
  const resultEl = q<HTMLElement>("[data-imgc-result]");
  const badgeEl = q<HTMLElement>("[data-imgc-badge]");
  const output = q<HTMLImageElement>("[data-imgc-output]");
  const originalSizeEl = q<HTMLElement>("[data-imgc-original-size]");
  const compressedSizeEl = q<HTMLElement>("[data-imgc-compressed-size]");
  const downloadBtn = q<HTMLButtonElement>("[data-imgc-download]");
  if (
    !zone || !input || !selectedEl || !preview || !qualityRange || !formatSel ||
    !compressBtn || !progressEl || !errorBox || !resultEl || !output || !downloadBtn
  ) return;
  root.dataset.initialized = "true";

  let currentFile: File | null = null;
  let previewUrl: string | null = null;
  let resultUrl: string | null = null;
  let resultName: string | null = null;
  let job: AbortController | null = null;

  function showError(msg: string) {
    errorBox!.textContent = msg;
    errorBox!.hidden = false;
  }
  function clearError() {
    errorBox!.hidden = true;
    errorBox!.textContent = "";
  }

  function hideResult() {
    resultEl!.hidden = true;
    if (badgeEl) badgeEl.hidden = true;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    resultName = null;
    output!.removeAttribute("src");
  }

  function setBusy(busy: boolean) {
    compressBtn!.disabled = busy || !currentFile;
    compressBtn!.setAttribute("aria-busy", String(busy));
    if (compressLabel) compressLabel.textContent = busy ? strings!.compressing : strings!.compress;
    progressEl!.hidden = !busy;
    zone!.setAttribute("aria-disabled", String(busy));
    input!.disabled = busy;
    if (clearBtn) clearBtn.disabled = busy;
  }

  function clearSelection() {
    job?.abort();
    currentFile = null;
    input!.value = "";
    selectedEl!.hidden = true;
    setDropzoneHasFile(zone!, false);
    if (nameEl) nameEl.textContent = "";
    if (sizeEl) sizeEl.textContent = "";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    preview!.removeAttribute("src");
    compressBtn!.disabled = true;
  }

  function handleFiles(files: File[]) {
    const file = files[0];
    if (!file || job) return;
    clearError();
    hideResult();
    if (!isDecodableImage(file)) {
      clearSelection();
      showError(isImageFile(file) ? strings!.errorUnsupported : strings!.errorNotImage);
      return;
    }
    currentFile = file;
    selectedEl!.hidden = false;
    setDropzoneHasFile(zone!, true);
    if (nameEl) {
      nameEl.textContent = file.name;
      nameEl.title = file.name;
    }
    if (sizeEl) sizeEl.textContent = formatBytes(file.size, 2);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview!.src = previewUrl;
    compressBtn!.disabled = false;
  }

  async function handleCompress() {
    if (!currentFile || job) return;
    const file = currentFile;
    const quality = Number.parseInt(qualityRange!.value || "80", 10);
    const targetFormat = resolveCompressFormat(formatSel!.value, file.type);

    clearError();
    hideResult();
    const ctrl = new AbortController();
    job = ctrl;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const resultBytes = await compressImage(bytes, targetFormat, quality, ctrl.signal);
      if (ctrl.signal.aborted || currentFile !== file) return;

      const blob = new Blob([resultBytes as BlobPart], { type: mimeFor(targetFormat) });
      resultUrl = URL.createObjectURL(blob);
      output!.src = resultUrl;
      if (originalSizeEl) originalSizeEl.textContent = formatBytes(file.size, 2);
      if (compressedSizeEl) compressedSizeEl.textContent = formatBytes(blob.size, 2);

      // Legacy parity: "Done! -N%" badge, only when savings are positive.
      const savedPct = savingsPercent(file.size, blob.size);
      if (badgeEl) {
        badgeEl.textContent = `${strings!.done} -${savedPct}%`;
        badgeEl.hidden = savedPct <= 0;
      }
      resultName = compressedName(file.name, targetFormat);
      resultEl!.hidden = false;
    } catch (e) {
      if (e instanceof WasmError && e.code === "aborted") return;
      const detail = e instanceof Error ? e.message : "";
      showError(detail ? `${strings!.errorCompression} ${detail}` : strings!.errorCompression);
    } finally {
      if (job === ctrl) job = null;
      setBusy(false);
    }
  }

  bindDropzone(zone, input, handleFiles);

  // Show the source dimensions once the preview has decoded.
  preview.addEventListener("load", () => {
    if (!currentFile || !sizeEl || !preview.naturalWidth) return;
    sizeEl.textContent = `${formatBytes(currentFile.size, 2)} · ${preview.naturalWidth}×${preview.naturalHeight}`;
  });

  clearBtn?.addEventListener("click", () => {
    clearSelection();
    hideResult();
    clearError();
  });
  cancelBtn?.addEventListener("click", () => job?.abort());

  qualityRange.addEventListener("input", () => {
    if (qualityValue) qualityValue.textContent = `${qualityRange.value}%`;
  });

  compressBtn.addEventListener("click", () => void handleCompress());

  downloadBtn.addEventListener("click", () => {
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
