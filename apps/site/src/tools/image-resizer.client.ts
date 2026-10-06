/**
 * Image Resizer client controller. Image picked via the drop zone
 * (`bindDropzone`); original dimensions are read with an `Image` probe, the
 * aspect-ratio lock auto-computes the opposite dimension on input (legacy
 * parity: only when locked and the edited value is > 0), and `resizeImage`
 * (image-tools WASM worker, cancellable) produces the result. Dimensions are
 * validated before WASM (positive integers within the WASM limits — a
 * negative value would otherwise wrap to a huge u32). Output format is
 * guessed from the source extension (jpg→jpeg, unknown→png). Download name:
 * `<base>_<w>x<h>.<ext>` (jpeg→jpg). Object URLs are revoked on replace/clear.
 */
import { resizeImage } from "@/scripts/wasm/image-tools-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, setDropzoneHasFile } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import {
  guessResizeFormat,
  isDecodableImage,
  isImageFile,
  lockedDimension,
  mimeFor,
  parseResizeDimensions,
  resizedName,
} from "@/tools/image-tools";

interface Strings {
  resize: string;
  resizing: string;
  errorNotImage: string;
  errorUnsupported: string;
  errorLoadImage: string;
  errorInvalidDimensions: string;
  errorTooLarge: string;
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-imgr-tool]");
  if (!root || root.dataset.initialized) return;
  const strings = readStrings();
  if (!strings) return;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);

  const errEl = q<HTMLElement>("[data-imgr-error]");
  const zone = q<HTMLElement>("[data-imgr-dropzone]");
  const input = q<HTMLInputElement>("[data-imgr-file]");
  const clearBtn = q<HTMLButtonElement>("[data-imgr-clear]");
  const selectedEl = q<HTMLElement>("[data-imgr-selected]");
  const preview = q<HTMLImageElement>("[data-imgr-preview]");
  const nameEl = q<HTMLElement>("[data-imgr-filename]");
  const sizeEl = q<HTMLElement>("[data-imgr-filesize]");
  const settingsEl = q<HTMLElement>("[data-imgr-settings]");
  const originalInfo = q<HTMLElement>("[data-imgr-original-info]");
  const widthEl = q<HTMLInputElement>("[data-imgr-width]");
  const heightEl = q<HTMLInputElement>("[data-imgr-height]");
  const lockEl = q<HTMLInputElement>("[data-imgr-lock-ratio]");
  const formatEl = q<HTMLSelectElement>("[data-imgr-format]");
  const actionBtn = q<HTMLButtonElement>("[data-imgr-resize]");
  const resizeLabel = q<HTMLElement>("[data-imgr-resize-label]");
  const progressEl = q<HTMLElement>("[data-imgr-progress]");
  const cancelBtn = q<HTMLButtonElement>("[data-imgr-cancel]");
  const outputEl = q<HTMLElement>("[data-imgr-output]");
  const resultPreview = q<HTMLImageElement>("[data-imgr-result-preview]");
  const outputInfo = q<HTMLElement>("[data-imgr-output-info]");
  const dlBtn = q<HTMLButtonElement>("[data-imgr-download]");
  if (
    !errEl || !zone || !input || !selectedEl || !preview || !settingsEl || !widthEl ||
    !heightEl || !lockEl || !formatEl || !actionBtn || !progressEl || !outputEl ||
    !resultPreview || !dlBtn
  ) return;
  root.dataset.initialized = "true";

  let currentFile: File | null = null;
  let originalWidth = 0;
  let originalHeight = 0;
  let previewUrl: string | null = null;
  let resultUrl: string | null = null;
  let resultName: string | null = null;
  let job: AbortController | null = null;

  function showError(msg: string) {
    errEl!.textContent = msg;
    errEl!.hidden = false;
  }
  function clearError() {
    errEl!.hidden = true;
    errEl!.textContent = "";
    widthEl!.removeAttribute("aria-invalid");
    heightEl!.removeAttribute("aria-invalid");
  }

  function hideOutput() {
    outputEl!.hidden = true;
    resultPreview!.removeAttribute("src");
    if (outputInfo) outputInfo.textContent = "";
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    resultName = null;
  }

  function setBusy(busy: boolean) {
    actionBtn!.disabled = busy || !currentFile || originalWidth === 0;
    actionBtn!.setAttribute("aria-busy", String(busy));
    if (resizeLabel) resizeLabel.textContent = busy ? strings!.resizing : strings!.resize;
    progressEl!.hidden = !busy;
    zone!.setAttribute("aria-disabled", String(busy));
    input!.disabled = busy;
    if (clearBtn) clearBtn.disabled = busy;
  }

  function clearSelection() {
    job?.abort();
    input!.value = "";
    currentFile = null;
    originalWidth = 0;
    originalHeight = 0;
    selectedEl!.hidden = true;
    setDropzoneHasFile(zone!, false);
    settingsEl!.hidden = true;
    widthEl!.value = "";
    heightEl!.value = "";
    if (nameEl) nameEl.textContent = "";
    if (sizeEl) sizeEl.textContent = "";
    if (originalInfo) originalInfo.textContent = "";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    preview!.removeAttribute("src");
    actionBtn!.disabled = true;
    hideOutput();
  }

  function handleFiles(files: File[]) {
    const file = files[0];
    if (!file || job) return;
    clearError();
    hideOutput();
    if (!isDecodableImage(file)) {
      clearSelection();
      showError(isImageFile(file) ? strings!.errorUnsupported : strings!.errorNotImage);
      return;
    }

    currentFile = file;
    originalWidth = 0;
    originalHeight = 0;
    actionBtn!.disabled = true;
    selectedEl!.hidden = false;
    setDropzoneHasFile(zone!, true);
    settingsEl!.hidden = true;
    if (nameEl) {
      nameEl.textContent = file.name;
      nameEl.title = file.name;
    }
    if (sizeEl) sizeEl.textContent = formatBytes(file.size, 2);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview!.hidden = false;
    // The preview doubles as the dimension probe (legacy used a separate Image).
    preview!.src = previewUrl;
  }

  preview.addEventListener("load", () => {
    const file = currentFile;
    if (!file || !preview.naturalWidth) return;
    originalWidth = preview.naturalWidth;
    originalHeight = preview.naturalHeight;
    widthEl.value = String(originalWidth);
    heightEl.value = String(originalHeight);
    const info = `${originalWidth}×${originalHeight}, ${formatBytes(file.size, 2)}`;
    if (sizeEl) sizeEl.textContent = info;
    if (originalInfo) originalInfo.textContent = info;
    formatEl.value = guessResizeFormat(file.name);
    settingsEl.hidden = false;
    actionBtn.disabled = false;
  });
  preview.addEventListener("error", () => {
    if (!currentFile || !preview.getAttribute("src")) return;
    // The browser can't decode it (e.g. TIFF/TGA), so dimensions are unknown.
    preview.hidden = true;
    showError(strings.errorLoadImage);
  });

  // Aspect-ratio lock: editing one dimension recomputes the other from the
  // original ratio (legacy parity: only when locked, dims known, value > 0).
  function handleDimensionInput(changed: "width" | "height") {
    widthEl!.removeAttribute("aria-invalid");
    heightEl!.removeAttribute("aria-invalid");
    if (!lockEl!.checked) return;
    const edited = changed === "width" ? widthEl! : heightEl!;
    const other = changed === "width" ? heightEl! : widthEl!;
    const next = lockedDimension(changed, Number.parseInt(edited.value, 10), originalWidth, originalHeight);
    if (next !== null) other.value = String(next);
  }

  async function performResize() {
    if (!currentFile || job) return;
    const file = currentFile;
    const dims = parseResizeDimensions(widthEl!.value, heightEl!.value);
    if ("error" in dims) {
      clearError();
      showError(dims.error === "too-large" ? strings!.errorTooLarge : strings!.errorInvalidDimensions);
      widthEl!.setAttribute("aria-invalid", "true");
      heightEl!.setAttribute("aria-invalid", "true");
      hideOutput();
      return;
    }
    const { width, height } = dims;
    const format = formatEl!.value;

    clearError();
    const ctrl = new AbortController();
    job = ctrl;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const resultBytes = await resizeImage(bytes, width, height, format, ctrl.signal);
      if (ctrl.signal.aborted || currentFile !== file) return;

      const blob = new Blob([resultBytes as BlobPart], { type: mimeFor(format) });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      resultPreview!.src = resultUrl;
      if (outputInfo) outputInfo.textContent = `${width}×${height}, ${formatBytes(blob.size, 2)}`;
      resultName = resizedName(file.name, width, height, format);
      outputEl!.hidden = false;
    } catch (e) {
      if (e instanceof WasmError && e.code === "aborted") return;
      hideOutput();
      const detail = e instanceof Error ? e.message : "";
      showError(detail ? `${strings!.errorResizeFailed} ${detail}` : strings!.errorResizeFailed);
    } finally {
      if (job === ctrl) job = null;
      setBusy(false);
    }
  }

  bindDropzone(zone, input, handleFiles);

  clearBtn?.addEventListener("click", () => {
    clearSelection();
    clearError();
  });
  cancelBtn?.addEventListener("click", () => job?.abort());

  widthEl.addEventListener("input", () => handleDimensionInput("width"));
  heightEl.addEventListener("input", () => handleDimensionInput("height"));

  actionBtn.addEventListener("click", () => void performResize());

  dlBtn.addEventListener("click", () => {
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
