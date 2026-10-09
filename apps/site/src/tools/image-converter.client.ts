/**
 * Image Converter client controller. Image picked via the drop zone
 * (`bindDropzone`); converted by the image-tools WASM worker (`convertImage`,
 * cancellable via AbortController). Quality slider (1-100, default 90) is
 * only shown for lossy targets (jpeg/webp — legacy parity). WebP uses the
 * browser's lossy encoder; without one the worker falls back to lossless
 * WASM WebP and a note says quality wasn't applied. Result is
 * previewed with its byte size (formats the browser can't display, e.g.
 * TIFF/TGA, hide the preview) and downloaded under the original name with the
 * new extension (jpeg → jpg). A before/after ImageCompare slider
 * (`bindImageCompare`) shows source vs. result; reset on new file/result/clear.
 * Undecodable input gets a localized "not a supported image or damaged"
 * error (no raw decoder text); a thumbnail the browser can't show (TIFF,
 * TGA, damaged file) falls back to the generic image icon.
 */
import { convertImage } from "@/scripts/wasm/image-tools-client";
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, revealOutput, setDropzoneHasFile, withPreparing } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import { bindImageCompare } from "@/scripts/image-compare";
import { convertedName, isDecodableImage, isImageDecodeError, isImageFile, mimeFor } from "@/tools/image-tools";
import { showImageError } from "@/tools/image-error-ui";

interface Strings {
  convert: string;
  processing: string;
  errorNotImage: string;
  errorUnsupported: string;
  errorConversion: string;
  errorDamaged: string;
  webpLosslessNote: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-imgv-tool]");
  if (!root || root.dataset.initialized) return;
  const strings = readStrings();
  if (!strings) return;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);

  const zone = q<HTMLElement>("[data-imgv-dropzone]");
  const input = q<HTMLInputElement>("[data-imgv-file]");
  const selectedEl = q<HTMLElement>("[data-imgv-selected]");
  const preview = q<HTMLImageElement>("[data-imgv-preview]");
  const thumbIcon = q<HTMLElement>("[data-imgv-thumb-icon]");
  const nameEl = q<HTMLElement>("[data-imgv-filename]");
  const sizeEl = q<HTMLElement>("[data-imgv-filesize]");
  const clearBtn = q<HTMLButtonElement>("[data-imgv-clear]");
  const qualityRange = q<HTMLInputElement>("[data-imgv-quality]");
  const qualityValue = q<HTMLElement>("[data-imgv-quality-value]");
  const qualityBox = q<HTMLElement>("[data-imgv-quality-container]");
  const formatSel = q<HTMLSelectElement>("[data-imgv-format]");
  const actionBtn = q<HTMLButtonElement>("[data-imgv-convert]");
  const actionLabel = q<HTMLElement>("[data-imgv-convert-label]");
  const progressEl = q<HTMLElement>("[data-imgv-progress]");
  const cancelBtn = q<HTMLButtonElement>("[data-imgv-cancel]");
  const errorBox = q<HTMLElement>("[data-imgv-error]");
  const resultEl = q<HTMLElement>("[data-imgv-result]");
  const compareEl = q<HTMLElement>("[data-imgv-compare]");
  const outputSizeEl = q<HTMLElement>("[data-imgv-output-size]");
  const downloadBtn = q<HTMLButtonElement>("[data-imgv-download]");
  const webpNote = q<HTMLElement>("[data-imgv-webp-note]");
  if (
    !zone || !input || !selectedEl || !preview || !qualityRange || !formatSel ||
    !actionBtn || !progressEl || !errorBox || !resultEl || !compareEl || !downloadBtn
  ) return;
  root.dataset.initialized = "true";
  // Headline shows the output size; the comparison adds dimensions, the
  // original size and the signed change.
  const compare = bindImageCompare(compareEl, { originalDims: true, originalSize: true, resultDims: true, change: true });

  let currentFile: File | null = null;
  let previewUrl: string | null = null;
  let resultUrl: string | null = null;
  let resultName: string | null = null;
  let job: AbortController | null = null;

  function showError(msg: string, detail?: string) {
    showImageError(errorBox!, msg, detail);
  }
  /** Thumbnail ↔ generic icon (format the browser can't display, damaged file). */
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
    actionBtn!.disabled = busy || !currentFile;
    actionBtn!.setAttribute("aria-busy", String(busy));
    if (actionLabel) actionLabel.textContent = busy ? strings!.processing : strings!.convert;
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
    actionBtn!.disabled = true;
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
    actionBtn!.disabled = false;
  }

  function updateQualityVisibility() {
    const fmt = formatSel!.value;
    if (qualityBox) qualityBox.hidden = !(fmt === "jpeg" || fmt === "webp");
  }

  async function handleConvert() {
    if (!currentFile || job) return;
    const file = currentFile;
    const targetFormat = formatSel!.value;
    // The slider is only shown for jpeg/webp; a value left below 90 from an
    // earlier jpeg run must not silently palette-quantize "PNG (Lossless)".
    const quality = targetFormat === "jpeg" || targetFormat === "webp" ? Number.parseInt(qualityRange!.value || "90", 10) : 100;

    clearError();
    hideResult();
    const operation = startToolOperation("image-converter");
    const ctrl = new AbortController();
    job = ctrl;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { bytes: resultBytes, webpLossy } = await withPreparing(
        "image_tools",
        convertImage(bytes, targetFormat, quality, ctrl.signal),
        { host: actionBtn!.closest<HTMLElement>(".ds-action-row"), label: strings!.preparing },
      );
      if (ctrl.signal.aborted || currentFile !== file) return;

      const blob = new Blob([resultBytes as BlobPart], { type: mimeFor(targetFormat) });
      resultUrl = URL.createObjectURL(blob);
      if (outputSizeEl) outputSizeEl.textContent = formatBytes(blob.size, 2);
      if (webpNote) webpNote.hidden = !(targetFormat === "webp" && !webpLossy);
      resultName = convertedName(file.name, targetFormat);
      // Decode before revealing; a result the browser can't display (TIFF,
      // TGA) keeps the comparison hidden, an undisplayable source shows result only.
      await compare.show(previewUrl ? { url: previewUrl, size: file.size } : null, { url: resultUrl, size: blob.size });
      if (ctrl.signal.aborted || currentFile !== file) return;
      resultEl!.hidden = false;
      revealOutput(resultEl);
      operation.complete();
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof WasmError && e.code === "aborted")) return;
      operation.fail();
      const detail = e instanceof Error ? e.message : "";
      // Undecodable input: plain localized message, raw decoder text dropped.
      if (isImageDecodeError(detail)) showError(strings!.errorDamaged);
      else showError(strings!.errorConversion, detail);
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

  // TIFF/TGA (and some ICO) can't be displayed by browsers: show the generic
  // icon instead of a broken image.
  preview.addEventListener("error", () => {
    if (preview.getAttribute("src")) showThumb(false);
  });

  qualityRange.addEventListener("input", () => {
    if (qualityValue) qualityValue.textContent = qualityRange.value;
  });
  formatSel.addEventListener("change", updateQualityVisibility);
  updateQualityVisibility();

  actionBtn.addEventListener("click", () => void handleConvert());

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
