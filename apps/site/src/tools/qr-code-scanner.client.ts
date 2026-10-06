/**
 * QR Code Scanner client controller. Image picked via the file button, drag
 * & drop or a click on the drop zone (`bindDropzone`); bytes are decoded by the
 * qrcode WASM module (`qrDecode`). Localized errors: not an image, unsupported
 * format (crate decodes png/jpeg/webp), no QR found, read failure. URL results
 * expose an open-link action (http/https only). A newer file supersedes an
 * in-flight decode (sequence token), so a stale result never overwrites it.
 */
import { qrDecode } from "@/scripts/wasm/qrcode-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, copyWithFeedback, setDropzoneHasFile } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import { classifyDecodeError, isHttpUrl, isImageType } from "@/tools/qr-code";

interface Strings {
  copy: string;
  copied: string;
  errorNotImage: string;
  errorNoQr: string;
  errorReading: string;
  errorUnsupportedImage: string;
  errorCopy: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-qrs-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-qrs-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  root.dataset.initialized = "true";
  const strings: Strings = raw;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);

  const zone = q<HTMLElement>("[data-qrs-dropzone]");
  const input = q<HTMLInputElement>("[data-qrs-file]");
  const clearBtn = q<HTMLButtonElement>("[data-qrs-clear]");
  const selectedEl = q<HTMLElement>("[data-qrs-selected]");
  const preview = q<HTMLImageElement>("[data-qrs-preview]");
  const nameEl = q<HTMLElement>("[data-qrs-filename]");
  const sizeEl = q<HTMLElement>("[data-qrs-filesize]");
  const busyEl = q<HTMLElement>("[data-qrs-busy]");
  const resultEl = q<HTMLElement>("[data-qrs-result]");
  const outputArea = q<HTMLTextAreaElement>("[data-qrs-output]");
  const copyBtn = q<HTMLButtonElement>("[data-qrs-copy]");
  const linkWrap = q<HTMLElement>("[data-qrs-linkwrap]");
  const openLink = q<HTMLAnchorElement>("[data-qrs-openlink]");
  const errorBox = q<HTMLElement>("[data-qrs-error]");

  if (!zone || !input || !selectedEl || !preview || !resultEl || !outputArea || !errorBox) return;

  let previewUrl: string | null = null;
  let seq = 0;

  function showError(msg: string) {
    errorBox!.textContent = msg;
    errorBox!.hidden = false;
  }
  function clearError() {
    errorBox!.hidden = true;
    errorBox!.textContent = "";
  }
  function setBusy(on: boolean) {
    if (busyEl) busyEl.hidden = !on;
    zone!.setAttribute("aria-busy", String(on));
  }

  function hideResult() {
    resultEl!.hidden = true;
    outputArea!.value = "";
    if (linkWrap) linkWrap.hidden = true;
    openLink?.removeAttribute("href");
  }

  function showResult(text: string) {
    outputArea!.value = text;
    resultEl!.hidden = false;
    if (isHttpUrl(text) && openLink && linkWrap) {
      openLink.href = text;
      linkWrap.hidden = false;
    }
  }

  function showSelection(file: File) {
    selectedEl!.hidden = false;
    setDropzoneHasFile(zone!, true);
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = formatBytes(file.size, 2);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview!.src = previewUrl;
  }

  function clearSelection() {
    seq++; // drop any in-flight decode result
    setBusy(false);
    input!.value = "";
    selectedEl!.hidden = true;
    setDropzoneHasFile(zone!, false);
    if (nameEl) nameEl.textContent = "";
    if (sizeEl) sizeEl.textContent = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    preview!.removeAttribute("src");
  }

  async function handleFile(file: File) {
    clearError();
    hideResult();
    if (!isImageType(file.type)) {
      clearSelection();
      showError(strings.errorNotImage);
      return;
    }

    showSelection(file);
    const mine = ++seq;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await qrDecode(bytes);
      if (mine !== seq) return;
      showResult(text);
    } catch (e) {
      if (mine !== seq) return;
      if (e instanceof WasmError) {
        showError(classifyDecodeError(e.message) === "unsupportedImage" ? strings.errorUnsupportedImage : strings.errorNoQr);
      } else {
        showError(strings.errorReading);
      }
    } finally {
      if (mine === seq) setBusy(false);
    }
  }

  bindDropzone(zone, input, (files) => {
    if (files[0]) void handleFile(files[0]);
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSelection();
    hideResult();
    clearError();
  });

  copyBtn?.addEventListener("click", async () => {
    if (!outputArea.value) return;
    const ok = await copyWithFeedback(copyBtn, outputArea.value, strings.copied);
    if (!ok) showError(strings.errorCopy);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
