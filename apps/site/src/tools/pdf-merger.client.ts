/**
 * PDF Merger client controller. PDFs picked via file dialog (multiple),
 * drag-drop, or the "add files" button; every pick is appended to the list
 * (merge order = list order; no dedup, no reorder — legacy parity). Rows
 * show index/name/size/status with a per-file remove button; clear-all
 * empties the list. Non-PDF picks are rejected with a localized message
 * (valid files in the same pick are still added — legacy drop parity).
 * Merge is enabled with ≥2 files and runs `mergePdfs` on the file buffers
 * in list order. On success the merge button hides until the list changes
 * (legacy parity), row statuses flip to the success string, and the result
 * shows the merged size with a `merged.pdf` download (legacy filename).
 * The result object URL is revoked on replace and on clear/list mutation.
 * WASM errors surface their message (legacy parity).
 */
import { mergePdfs } from "@/scripts/wasm/pdf-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  statusReady: string;
  removeFile: string;
  merge: string;
  merging: string;
  success: string;
  minFilesHint: string;
  errorNotPdf: string;
  errorMerge: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-pdfm-strings]");
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

const REMOVE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12" /></svg>';

function init() {
  const root = document.querySelector<HTMLElement>("[data-pdfm-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const dropZone = root.querySelector<HTMLElement>("[data-pdfm-dropzone]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-pdfm-file]");
  const chooseBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-choose]");
  const listSection = root.querySelector<HTMLElement>("[data-pdfm-list]");
  const itemsEl = root.querySelector<HTMLUListElement>("[data-pdfm-items]");
  const hintEl = root.querySelector<HTMLElement>("[data-pdfm-hint]");
  const addBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-add]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-clear]");
  const mergeBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-merge]");
  const mergeLabel = root.querySelector<HTMLElement>("[data-pdfm-merge-label]");
  const resultSection = root.querySelector<HTMLElement>("[data-pdfm-result]");
  const resultSizeEl = root.querySelector<HTMLElement>("[data-pdfm-result-size]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-download]");
  const errorBox = root.querySelector<HTMLElement>("[data-pdfm-error]");

  if (
    !dropZone || !fileInput || !listSection || !itemsEl ||
    !mergeBtn || !resultSection || !downloadBtn
  ) return;
  const zone: HTMLElement = dropZone;
  const input: HTMLInputElement = fileInput;
  const listEl: HTMLElement = listSection;
  const items: HTMLUListElement = itemsEl;
  const merge: HTMLButtonElement = mergeBtn;
  const resultEl: HTMLElement = resultSection;
  const download: HTMLButtonElement = downloadBtn;

  let files: File[] = [];
  let resultUrl: string | null = null;
  let merging = false;

  function isPdf(file: File): boolean {
    return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  }

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
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  function updateMergeState() {
    merge.disabled = merging || files.length < 2;
    merge.title = files.length < 2 ? strings.minFilesHint : "";
    if (hintEl) hintEl.hidden = files.length >= 2;
  }

  function renderList() {
    items.replaceChildren();
    listEl.hidden = files.length === 0;

    files.forEach((file, index) => {
      const li = document.createElement("li");
      li.className = "pdfm-row";

      const idx = document.createElement("span");
      idx.className = "pdfm-col-index";
      idx.textContent = String(index + 1);

      const name = document.createElement("span");
      name.className = "pdfm-name";
      name.textContent = file.name;
      name.title = file.name;

      const size = document.createElement("span");
      size.className = "pdfm-size";
      size.textContent = formatBytes(file.size);

      const status = document.createElement("span");
      status.className = "pdfm-status";
      status.dataset.pdfmStatus = "";
      status.textContent = strings.statusReady;

      const action = document.createElement("span");
      action.className = "pdfm-col-action";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pdfm-remove";
      remove.dataset.pdfmRemove = String(index);
      remove.setAttribute("aria-label", strings.removeFile);
      remove.title = strings.removeFile;
      remove.innerHTML = REMOVE_ICON;
      action.appendChild(remove);

      li.append(idx, name, size, status, action);
      items.appendChild(li);
    });

    // Legacy parity: any list change restores the merge button, hides the
    // previous result, and resets row statuses (rows are rebuilt as Ready).
    merge.hidden = false;
    hideResult();
    updateMergeState();
  }

  function addFiles(picked: FileList | File[]) {
    const incoming = Array.from(picked);
    if (incoming.length === 0) return;
    const valid = incoming.filter(isPdf);
    if (valid.length < incoming.length) {
      showError(strings.errorNotPdf);
    } else {
      clearError();
    }
    if (valid.length === 0) return;
    files = [...files, ...valid];
    renderList();
  }

  function clearAll() {
    if (merging) return;
    files = [];
    input.value = "";
    clearError();
    renderList();
  }

  async function handleMerge() {
    if (files.length < 2 || merging) return;

    merging = true;
    merge.disabled = true;
    if (mergeLabel) mergeLabel.textContent = strings.merging;
    clearError();
    hideResult();

    try {
      const buffers = await Promise.all(
        files.map(async (file) => new Uint8Array(await file.arrayBuffer())),
      );
      const merged = await mergePdfs(buffers);

      const blob = new Blob([merged.slice()], { type: "application/pdf" });
      resultUrl = URL.createObjectURL(blob);
      if (resultSizeEl) resultSizeEl.textContent = formatBytes(blob.size);
      resultEl.hidden = false;

      // Legacy parity: hide the merge button after success; it returns when
      // the file list changes (renderList).
      merge.hidden = true;

      items.querySelectorAll<HTMLElement>("[data-pdfm-status]").forEach((el) => {
        el.textContent = strings.success;
        el.classList.add("pdfm-status-done");
      });
    } catch (e) {
      const message =
        e instanceof WasmError || e instanceof Error ? e.message : strings.errorMerge;
      showError(message || strings.errorMerge);
    } finally {
      merging = false;
      if (mergeLabel) mergeLabel.textContent = strings.merge;
      updateMergeState();
    }
  }

  function pickFiles() {
    if (!merging) input.click();
  }

  // Clicking the zone (but not a button inside it) opens the file dialog.
  zone.addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.closest("button")) return;
    pickFiles();
  });
  chooseBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    pickFiles();
  });
  addBtn?.addEventListener("click", () => {
    pickFiles();
  });

  input.addEventListener("change", () => {
    if (input.files && input.files.length > 0) addFiles(input.files);
    // Reset so re-picking the same files fires change again (legacy parity).
    input.value = "";
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("pdfm-dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("pdfm-dragover");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("pdfm-dragover");
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  items.addEventListener("click", (e) => {
    const btn =
      e.target instanceof Element
        ? e.target.closest<HTMLButtonElement>("[data-pdfm-remove]")
        : null;
    if (!btn || merging) return;
    const index = Number.parseInt(btn.dataset.pdfmRemove ?? "", 10);
    if (Number.isNaN(index) || !files[index]) return;
    files.splice(index, 1);
    clearError();
    renderList();
  });

  clearBtn?.addEventListener("click", () => {
    clearAll();
  });

  merge.addEventListener("click", () => {
    void handleMerge();
  });

  download.addEventListener("click", () => {
    if (!resultUrl) return;
    const a = document.createElement("a");
    a.href = resultUrl;
    a.download = "merged.pdf";
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
