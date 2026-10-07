/**
 * Image Compressor client controller. Image picked via the drop zone
 * (`bindDropzone`: drag-drop, zone click, keyboard-reachable file button);
 * compressed by the image-tools WASM worker (`compressImage`, cancellable via
 * AbortController). Quality slider (1-100, default 80) is passed through
 * as-is (legacy parity); for WebP output the browser's lossy encoder applies
 * it, and when the browser can't encode WebP the worker falls back to
 * lossless WASM WebP and a note says quality wasn't applied. Output format "original" maps from the source MIME
 * type (jpeg → jpeg, png → png, anything else → webp — legacy parity).
 * Result leads with the size change as a headline ("−N %", "+N %" when the
 * output grew) over original → compressed sizes,
 * and downloaded as `<name>_min.<ext>` (jpeg → jpg — legacy parity).
 * A before/after ImageCompare slider (`bindImageCompare`) shows source vs.
 * result; it is reset (and old object URLs revoked) on new file/result/clear.
 * A file that can't be decoded gets a localized "not a supported image or
 * damaged" error (no raw decoder text) and its thumbnail falls back to the
 * generic image icon instead of the browser's broken-image glyph.
 */
import { compressImage } from "@/scripts/wasm/image-tools-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, revealOutput, setDropzoneHasFile, startPreparing } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import { bindImageCompare } from "@/scripts/image-compare";
import {
  compressedName,
  formatSizeChange,
  isDecodableImage,
  isImageDecodeError,
  isImageFile,
  mimeFor,
  resolveCompressFormat,
  savingsPercent,
} from "@/tools/image-tools";
import { showImageError } from "@/tools/image-error-ui";

interface Strings {
  compress: string;
  compressing: string;
  done: string;
  errorNotImage: string;
  errorUnsupported: string;
  errorCompression: string;
  errorDamaged: string;
  webpLosslessNote: string;
  preparing: string;
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
  const thumbIcon = q<HTMLElement>("[data-imgc-thumb-icon]");
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
  const compareEl = q<HTMLElement>("[data-imgc-compare]");
  const originalSizeEl = q<HTMLElement>("[data-imgc-original-size]");
  const compressedSizeEl = q<HTMLElement>("[data-imgc-compressed-size]");
  const downloadBtn = q<HTMLButtonElement>("[data-imgc-download]");
  const webpNote = q<HTMLElement>("[data-imgc-webp-note]");
  if (
    !zone || !input || !selectedEl || !preview || !qualityRange || !formatSel ||
    !compressBtn || !progressEl || !errorBox || !resultEl || !compareEl || !downloadBtn
  ) return;
  root.dataset.initialized = "true";
  // Headline already shows both sizes and the change: comparison adds dimensions.
  const compare = bindImageCompare(compareEl, { originalDims: true, resultDims: true });

  let currentFile: File | null = null;
  let previewUrl: string | null = null;
  let resultUrl: string | null = null;
  let resultName: string | null = null;
  let job: AbortController | null = null;

  function showError(msg: string, detail?: string) {
    showImageError(errorBox!, msg, detail);
  }
  /** Thumbnail ↔ generic icon (undecodable file or no file). */
  function showThumb(on: boolean) {
    preview!.hidden = !on;
    if (thumbIcon) thumbIcon.hidden = on;
  }
  function clearError() {
    errorBox!.hidden = true;
    errorBox!.textContent = "";
  }

  function hideResult() {
    resultEl!.hidden = true;
    if (webpNote) webpNote.hidden = true;
    compare.reset();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    resultName = null;
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
    showThumb(true);
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
    showThumb(true);
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
    // First run loads the image-tools WASM in the worker: "Preparing…" if slow.
    const prepared = startPreparing("image_tools", {
      host: compressBtn!.closest<HTMLElement>(".ds-action-row"),
      label: strings!.preparing,
    });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { bytes: resultBytes, webpLossy } = await compressImage(bytes, targetFormat, quality, ctrl.signal);
      prepared();
      if (ctrl.signal.aborted || currentFile !== file) return;

      const blob = new Blob([resultBytes as BlobPart], { type: mimeFor(targetFormat) });
      resultUrl = URL.createObjectURL(blob);
      if (originalSizeEl) originalSizeEl.textContent = formatBytes(file.size, 2);
      if (compressedSizeEl) compressedSizeEl.textContent = formatBytes(blob.size, 2);

      // Headline: "−N %" when smaller, "+N %" when the output grew.
      if (badgeEl) {
        badgeEl.textContent = formatSizeChange(file.size, blob.size);
        badgeEl.classList.toggle("is-smaller", savingsPercent(file.size, blob.size) > 0);
      }
      if (webpNote) webpNote.hidden = !(targetFormat === "webp" && !webpLossy);
      resultName = compressedName(file.name, targetFormat);
      // Decode both images before revealing, so the panel doesn't jump.
      if (previewUrl) await compare.show({ url: previewUrl, size: file.size }, { url: resultUrl, size: blob.size });
      if (ctrl.signal.aborted || currentFile !== file) return;
      resultEl!.hidden = false;
      revealOutput(resultEl);
    } catch (e) {
      if (e instanceof WasmError && e.code === "aborted") return;
      const detail = e instanceof Error ? e.message : "";
      // Undecodable input: plain localized message, raw decoder text dropped.
      if (isImageDecodeError(detail)) showError(strings!.errorDamaged);
      else showError(strings!.errorCompression, detail);
    } finally {
      prepared();
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

  // Broken/undecodable file: generic icon instead of the broken-image glyph + spilled alt text.
  preview.addEventListener("error", () => {
    if (preview.getAttribute("src")) showThumb(false);
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
