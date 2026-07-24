/**
 * PDF to Text client controller. PDFs picked via file dialog or drag-drop are
 * appended to a batch list (legacy parity: multi-file, non-PDF entries are
 * rejected with a localized message). "Extract Text" runs every pending file
 * through the pdf WASM module (`extractText`); each row's status flows
 * Ready → spinner → per-file download link for `<name>.txt` (legacy filename
 * pattern: source name minus `.pdf` + `.txt`). Rows can be removed
 * individually; their object URLs are revoked. A WASM failure aborts the
 * batch, surfaces the error message (localized fallback), and restores the
 * failed row to Ready. Already-extracted files are skipped on re-extract
 * (legacy parity).
 */
import { extractText } from "@/scripts/wasm/pdf-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  extract: string;
  processing: string;
  ready: string;
  downloadTxt: string;
  removeFile: string;
  errorNotPdf: string;
  errorExtraction: string;
}

interface PdfItem {
  file: File;
  url: string | null;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-pdft-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

/** Legacy parity: '0 B', 1024-based units, 2-decimal parseFloat trimming. */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

const DOWNLOAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>';
const REMOVE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12" /></svg>';

function init() {
  const root = document.querySelector<HTMLElement>("[data-pdft-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const dropZone = root.querySelector<HTMLElement>("[data-pdft-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-pdft-file]");
  const chooseBtn = root.querySelector<HTMLButtonElement>("[data-pdft-choose]");
  const filesSection = root.querySelector<HTMLElement>("[data-pdft-files]");
  const listBody = root.querySelector<HTMLTableSectionElement>("[data-pdft-list]");
  const extractBtn = root.querySelector<HTMLButtonElement>("[data-pdft-extract]");
  const extractLabel = root.querySelector<HTMLElement>("[data-pdft-extract-label]");
  const errorBox = root.querySelector<HTMLElement>("[data-pdft-error]");

  if (!dropZone || !fileInput || !filesSection || !listBody || !extractBtn) return;
  const zone: HTMLElement = dropZone;
  const input: HTMLInputElement = fileInput;
  const section: HTMLElement = filesSection;
  const tbody: HTMLTableSectionElement = listBody;
  const extract: HTMLButtonElement = extractBtn;

  const files: PdfItem[] = [];
  let extracting = false;

  function showError(msg: string) {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  function buildStatusCell(item: PdfItem): HTMLTableCellElement {
    const td = document.createElement("td");
    td.className = "pdft-cell-status";
    td.dataset.pdftStatus = "";
    if (item.url) {
      const a = document.createElement("a");
      a.className = "pdft-download";
      a.href = item.url;
      // Legacy filename pattern: source name minus `.pdf` + `.txt`.
      a.download = `${item.file.name.replace(/\.pdf$/i, "")}.txt`;
      a.title = strings.downloadTxt;
      a.setAttribute("aria-label", strings.downloadTxt);
      a.innerHTML = DOWNLOAD_SVG;
      td.appendChild(a);
    } else {
      const span = document.createElement("span");
      span.className = "pdft-ready";
      span.textContent = strings.ready;
      td.appendChild(span);
    }
    return td;
  }

  function buildRow(item: PdfItem, index: number): HTMLTableRowElement {
    const tr = document.createElement("tr");

    const tdIndex = document.createElement("td");
    tdIndex.className = "pdft-cell-index";
    tdIndex.textContent = String(index + 1);
    tr.appendChild(tdIndex);

    const tdName = document.createElement("td");
    tdName.className = "pdft-cell-name";
    const name = document.createElement("span");
    name.className = "pdft-name";
    name.title = item.file.name;
    name.textContent = item.file.name;
    tdName.appendChild(name);
    tr.appendChild(tdName);

    const tdSize = document.createElement("td");
    tdSize.className = "pdft-cell-size";
    tdSize.textContent = formatBytes(item.file.size);
    tr.appendChild(tdSize);

    tr.appendChild(buildStatusCell(item));

    const tdRemove = document.createElement("td");
    tdRemove.className = "pdft-cell-remove";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "pdft-remove";
    removeBtn.dataset.pdftRemove = "";
    removeBtn.dataset.index = String(index);
    removeBtn.title = strings.removeFile;
    removeBtn.setAttribute("aria-label", strings.removeFile);
    removeBtn.innerHTML = REMOVE_SVG;
    tdRemove.appendChild(removeBtn);
    tr.appendChild(tdRemove);

    return tr;
  }

  function renderList() {
    tbody.replaceChildren();
    const has = files.length > 0;
    section.hidden = !has;
    extract.disabled = !has || extracting;
    files.forEach((item, i) => tbody.appendChild(buildRow(item, i)));
  }

  function statusCellAt(index: number): HTMLElement | null {
    const row = tbody.children[index];
    return row ? row.querySelector<HTMLElement>("[data-pdft-status]") : null;
  }

  function setRowBusy(index: number) {
    const cell = statusCellAt(index);
    if (!cell) return;
    const spinner = document.createElement("span");
    spinner.className = "pdft-spinner";
    spinner.setAttribute("aria-hidden", "true");
    cell.replaceChildren(spinner);
  }

  function setRowDone(index: number) {
    const cell = statusCellAt(index);
    const item = files[index];
    if (!cell || !item) return;
    cell.replaceWith(buildStatusCell(item));
  }

  function setRemoveEnabled(enabled: boolean) {
    tbody
      .querySelectorAll<HTMLButtonElement>("[data-pdft-remove]")
      .forEach((btn) => {
        btn.disabled = !enabled;
      });
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    // Legacy parity: non-PDF entries are rejected (type or extension).
    const valid = incoming.filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (valid.length < incoming.length) {
      showError(strings.errorNotPdf);
    } else {
      clearError();
    }
    if (valid.length === 0) return;
    for (const file of valid) files.push({ file, url: null });
    renderList();
  }

  async function handleExtract() {
    if (extracting || files.length === 0) return;
    extracting = true;
    extract.disabled = true;
    if (extractLabel) extractLabel.textContent = strings.processing;
    clearError();
    setRemoveEnabled(false);

    try {
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        if (!item || item.url) continue; // Legacy parity: skip already extracted.
        setRowBusy(i);
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const text = await extractText(bytes);
        const blob = new Blob([text], { type: "text/plain" });
        item.url = URL.createObjectURL(blob);
        setRowDone(i);
      }
    } catch (e) {
      const message =
        e instanceof WasmError || e instanceof Error ? e.message : "";
      showError(message || strings.errorExtraction);
    } finally {
      extracting = false;
      if (extractLabel) extractLabel.textContent = strings.extract;
      // Re-render: restores "Ready" on any failed/unprocessed row.
      renderList();
      setRemoveEnabled(true);
    }
  }

  function pickFile() {
    if (!extracting) input.click();
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
      addFiles(input.files);
      // Allow re-selecting the same files later.
      input.value = "";
    }
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("pdft-dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("pdft-dragover");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("pdft-dragover");
    const dropped = e.dataTransfer?.files;
    if (dropped && dropped.length > 0) addFiles(dropped);
  });

  extract.addEventListener("click", () => {
    void handleExtract();
  });

  tbody.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const removeBtn = target.closest<HTMLButtonElement>("[data-pdft-remove]");
    if (!removeBtn || extracting) return;
    const index = Number.parseInt(removeBtn.dataset.index || "", 10);
    const item = files[index];
    if (Number.isNaN(index) || !item) return;
    if (item.url) URL.revokeObjectURL(item.url);
    files.splice(index, 1);
    renderList();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
