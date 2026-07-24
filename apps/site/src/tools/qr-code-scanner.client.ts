/**
 * QR Code Scanner client controller. Image picked via file dialog, drag-drop,
 * or the change/clear buttons; bytes are decoded by the qrcode WASM module
 * (`qrDecode`). URL results expose an open-link action (legacy parity:
 * /^https?:\/\//i test). Copy button swaps its label for 1200ms.
 */
import { qrDecode } from "@/scripts/wasm/qrcode-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  copy: string;
  copied: string;
  errorNotImage: string;
  errorNoQr: string;
  errorReading: string;
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
  const root = document.querySelector<HTMLElement>("[data-qrs-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const dropZone = root.querySelector<HTMLElement>("[data-qrs-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-qrs-file]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-qrs-clear]");
  const emptyState = root.querySelector<HTMLElement>("[data-qrs-empty]");
  const selectedState = root.querySelector<HTMLElement>("[data-qrs-selected]");
  const chooseBtn = root.querySelector<HTMLButtonElement>("[data-qrs-choose]");
  const changeBtn = root.querySelector<HTMLButtonElement>("[data-qrs-change]");
  const previewImg = root.querySelector<HTMLImageElement>("[data-qrs-preview]");
  const nameEl = root.querySelector<HTMLElement>("[data-qrs-filename]");
  const sizeEl = root.querySelector<HTMLElement>("[data-qrs-filesize]");
  const resultSection = root.querySelector<HTMLElement>("[data-qrs-result]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-qrs-output]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-qrs-copy]");
  const linkWrap = root.querySelector<HTMLElement>("[data-qrs-linkwrap]");
  const openLink = root.querySelector<HTMLAnchorElement>("[data-qrs-openlink]");
  const errorBox = root.querySelector<HTMLElement>("[data-qrs-error]");

  if (!dropZone || !fileInput || !emptyState || !selectedState || !previewImg || !resultSection || !output) return;
  const zone: HTMLElement = dropZone;
  const input: HTMLInputElement = fileInput;
  const emptyEl: HTMLElement = emptyState;
  const selectedEl: HTMLElement = selectedState;
  const preview: HTMLImageElement = previewImg;
  const resultEl: HTMLElement = resultSection;
  const outputArea: HTMLTextAreaElement = output;

  let previewUrl: string | null = null;
  let decoding = false;

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
    outputArea.value = "";
    if (linkWrap) linkWrap.hidden = true;
    if (openLink) openLink.removeAttribute("href");
  }

  function showResult(text: string) {
    outputArea.value = text;
    resultEl.hidden = false;
    if (/^https?:\/\//i.test(text)) {
      if (openLink) openLink.href = text;
      if (linkWrap) linkWrap.hidden = false;
    }
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
  }

  async function handleFile(file: File) {
    clearError();
    hideResult();

    if (!file.type.startsWith("image/")) {
      clearSelection();
      showError(strings.errorNotImage);
      return;
    }

    showSelection(file);
    // Allow re-selecting the same file: the selection UI no longer depends on
    // input.files, so the value can be reset immediately.
    input.value = "";

    decoding = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await qrDecode(bytes);
      showResult(text);
    } catch (e) {
      if (e instanceof WasmError) {
        showError(strings.errorNoQr);
      } else {
        showError(strings.errorReading);
      }
    } finally {
      decoding = false;
    }
  }

  function pickFile() {
    if (!decoding) input.click();
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
    zone.classList.add("qrs-dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("qrs-dragover");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("qrs-dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSelection();
    hideResult();
    clearError();
  });

  copyBtn?.addEventListener("click", async () => {
    if (!outputArea.value) return;
    try {
      await navigator.clipboard.writeText(outputArea.value);
      const orig = copyBtn.textContent;
      copyBtn.textContent = strings.copied;
      setTimeout(() => {
        copyBtn.textContent = orig;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
