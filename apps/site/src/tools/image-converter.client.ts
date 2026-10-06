/**
 * Image Converter client controller. Image picked via the drop zone
 * (`bindDropzone`); converted by the image-tools WASM worker (`convertImage`,
 * cancellable via AbortController). Quality slider (1-100, default 90) is
 * only shown for lossy targets (jpeg/webp — legacy parity). WebP uses the
 * browser's lossy encoder; without one the worker falls back to lossless
 * WASM WebP and a note says quality wasn't applied. Result is
 * previewed with its byte size (formats the browser can't display, e.g.
 * TIFF/TGA, hide the preview) and downloaded under the original name with the
 * new extension (jpeg → jpg).
 */
import { convertImage } from "@/scripts/wasm/image-tools-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, setDropzoneHasFile } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import { convertedName, isDecodableImage, isImageFile, mimeFor } from "@/tools/image-tools";

interface Strings {
  convert: string;
  processing: string;
  errorNotImage: string;
  errorUnsupported: string;
  errorConversion: string;
  webpLosslessNote: string;
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
  const outputWrap = q<HTMLElement>("[data-imgv-output-wrap]");
  const output = q<HTMLImageElement>("[data-imgv-output]");
  const outputSizeEl = q<HTMLElement>("[data-imgv-output-size]");
  const downloadBtn = q<HTMLButtonElement>("[data-imgv-download]");
  const webpNote = q<HTMLElement>("[data-imgv-webp-note]");
  if (
    !zone || !input || !selectedEl || !preview || !qualityRange || !formatSel ||
    !actionBtn || !progressEl || !errorBox || !resultEl || !output || !downloadBtn
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
    if (webpNote) webpNote.hidden = true;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    resultName = null;
    output!.removeAttribute("src");
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
    preview!.hidden = false;
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
    const ctrl = new AbortController();
    job = ctrl;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { bytes: resultBytes, webpLossy } = await convertImage(bytes, targetFormat, quality, ctrl.signal);
      if (ctrl.signal.aborted || currentFile !== file) return;

      const blob = new Blob([resultBytes as BlobPart], { type: mimeFor(targetFormat) });
      resultUrl = URL.createObjectURL(blob);
      if (outputWrap) outputWrap.hidden = false;
      output!.src = resultUrl;
      if (outputSizeEl) outputSizeEl.textContent = formatBytes(blob.size, 2);
      if (webpNote) webpNote.hidden = !(targetFormat === "webp" && !webpLossy);
      resultName = convertedName(file.name, targetFormat);
      resultEl!.hidden = false;
    } catch (e) {
      if (e instanceof WasmError && e.code === "aborted") return;
      const detail = e instanceof Error ? e.message : "";
      showError(detail ? `${strings!.errorConversion} ${detail}` : strings!.errorConversion);
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

  // TIFF/TGA (and some ICO) can't be displayed by browsers: hide the preview
  // instead of showing a broken image.
  preview.addEventListener("error", () => {
    if (preview.getAttribute("src")) preview.hidden = true;
  });
  output.addEventListener("error", () => {
    if (output.getAttribute("src") && outputWrap) outputWrap.hidden = true;
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
