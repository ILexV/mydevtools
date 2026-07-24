/**
 * PDF Compressor client controller. PDFs picked via file dialog (multiple)
 * or drag-drop accumulate in a list (legacy parity). Non-PDF files are
 * rejected with a localized message. "Compress PDFs" processes every
 * not-yet-compressed file sequentially via the pdf WASM module
 * (`compressPdf`), showing a per-row spinner (legacy parity). Each result
 * row shows the compressed size with a "Saved N%" line — shown even when
 * the savings are negative, i.e. the "compressed" file is larger (legacy
 * parity) — and downloads as `compressed_<original name>` (legacy parity).
 * WASM errors surface their message, falling back to the common error
 * string (legacy parity).
 */
import { compressPdf } from "@/scripts/wasm/pdf-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  statusReady: string;
  savedPercent: string;
  compress: string;
  processing: string;
  download: string;
  removeFile: string;
  errorNotPdf: string;
  error: string;
}

interface FileItem {
  file: File;
  compressedSize: number | null;
  url: string | null;
  processing: boolean;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-pdfc-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

/** Legacy formatting: `parseFloat((bytes / 1024^i).toFixed(2)) + ' ' + sizes[i]`. */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

const DOWNLOAD_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>';
const REMOVE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12" /></svg>';

function init() {
  const root = document.querySelector<HTMLElement>("[data-pdfc-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const dropZone = root.querySelector<HTMLElement>("[data-pdfc-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-pdfc-file]");
  const chooseBtn = root.querySelector<HTMLButtonElement>("[data-pdfc-choose]");
  const listSection = root.querySelector<HTMLElement>("[data-pdfc-list]");
  const tbody = root.querySelector<HTMLTableSectionElement>("[data-pdfc-tbody]");
  const compressBtn = root.querySelector<HTMLButtonElement>("[data-pdfc-compress]");
  const compressLabel = root.querySelector<HTMLElement>("[data-pdfc-compress-label]");
  const errorBox = root.querySelector<HTMLElement>("[data-pdfc-error]");

  if (!dropZone || !fileInput || !listSection || !tbody || !compressBtn) return;
  const zone: HTMLElement = dropZone;
  const input: HTMLInputElement = fileInput;
  const listEl: HTMLElement = listSection;
  const body: HTMLTableSectionElement = tbody;
  const compress: HTMLButtonElement = compressBtn;

  const files: FileItem[] = [];
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

  function render() {
    body.textContent = "";
    listEl.hidden = files.length === 0;

    files.forEach((item, index) => {
      const tr = document.createElement("tr");

      const indexCell = document.createElement("th");
      indexCell.scope = "row";
      indexCell.textContent = String(index + 1);
      tr.appendChild(indexCell);

      const nameCell = document.createElement("td");
      const nameEl = document.createElement("div");
      nameEl.className = "pdfc-name";
      nameEl.title = item.file.name;
      nameEl.textContent = item.file.name;
      nameCell.appendChild(nameEl);
      tr.appendChild(nameCell);

      const origCell = document.createElement("td");
      origCell.className = "pdfc-cell-num";
      origCell.textContent = formatBytes(item.file.size);
      tr.appendChild(origCell);

      const compCell = document.createElement("td");
      compCell.className = "pdfc-cell-num";
      if (item.compressedSize !== null) {
        const wrap = document.createElement("div");
        wrap.className = "pdfc-compressed";
        const sizeEl = document.createElement("span");
        sizeEl.className = "pdfc-compressed-size";
        sizeEl.textContent = formatBytes(item.compressedSize);
        const savedEl = document.createElement("span");
        savedEl.className = "pdfc-saved";
        // Legacy parity: rounded savings %, shown even when negative.
        const savings = Math.round((1 - item.compressedSize / item.file.size) * 100);
        savedEl.textContent = strings.savedPercent.replace("{pct}", String(savings));
        wrap.appendChild(sizeEl);
        wrap.appendChild(savedEl);
        compCell.appendChild(wrap);
      } else {
        const pending = document.createElement("span");
        pending.className = "pdfc-pending";
        pending.textContent = "—";
        compCell.appendChild(pending);
      }
      tr.appendChild(compCell);

      const statusCell = document.createElement("td");
      statusCell.className = "pdfc-cell-status";
      if (item.url) {
        const a = document.createElement("a");
        a.className = "pdfc-download";
        a.href = item.url;
        // Legacy parity: `compressed_<original name>`.
        a.download = `compressed_${item.file.name}`;
        a.title = strings.download;
        a.setAttribute("aria-label", strings.download);
        a.innerHTML = DOWNLOAD_ICON;
        statusCell.appendChild(a);
      } else if (item.processing) {
        const spinner = document.createElement("span");
        spinner.className = "pdfc-spinner";
        statusCell.appendChild(spinner);
      } else {
        const ready = document.createElement("span");
        ready.className = "pdfc-ready";
        ready.textContent = strings.statusReady;
        statusCell.appendChild(ready);
      }
      tr.appendChild(statusCell);

      const removeCell = document.createElement("td");
      removeCell.className = "pdfc-cell-remove";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "pdfc-remove";
      removeBtn.title = strings.removeFile;
      removeBtn.setAttribute("aria-label", strings.removeFile);
      removeBtn.innerHTML = REMOVE_ICON;
      removeBtn.addEventListener("click", () => {
        if (item.url) URL.revokeObjectURL(item.url);
        files.splice(index, 1);
        render();
      });
      removeCell.appendChild(removeBtn);
      tr.appendChild(removeCell);

      body.appendChild(tr);
    });
  }

  function addFiles(incoming: File[]) {
    clearError();
    // Legacy acceptance filter (drop handler).
    const accepted = incoming.filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    // Legacy silently filters non-PDFs on drop; surface a localized message instead.
    if (accepted.length < incoming.length) showError(strings.errorNotPdf);
    if (accepted.length === 0) return;
    for (const file of accepted) {
      files.push({ file, compressedSize: null, url: null, processing: false });
    }
    render();
  }

  async function handleCompress() {
    if (compressing || files.length === 0) return;

    clearError();
    compressing = true;
    compress.disabled = true;
    if (compressLabel) compressLabel.textContent = strings.processing;

    try {
      for (const item of files) {
        if (item.compressedSize !== null) continue; // Legacy: skip already compressed.

        item.processing = true;
        render();

        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const compressed = await compressPdf(bytes);

        item.compressedSize = compressed.length;
        item.url = URL.createObjectURL(new Blob([compressed.slice()], { type: "application/pdf" }));
        item.processing = false;
        render();
      }
    } catch (e) {
      for (const item of files) item.processing = false;
      render();
      const message = e instanceof WasmError || e instanceof Error ? e.message : "";
      showError(message || strings.error);
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

  input.addEventListener("change", () => {
    if (input.files && input.files.length > 0) {
      addFiles(Array.from(input.files));
      // Allow re-selecting the same files.
      input.value = "";
    }
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("pdfc-dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("pdfc-dragover");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("pdfc-dragover");
    const dropped = e.dataTransfer?.files;
    if (dropped && dropped.length > 0) addFiles(Array.from(dropped));
  });

  compress.addEventListener("click", () => {
    void handleCompress();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
