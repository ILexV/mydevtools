/**
 * PDF Compressor client controller. PDFs picked via file dialog (multiple)
 * or drag-drop (`bindDropzone`) accumulate in a list (legacy parity).
 * Non-PDF files are rejected with a localized message. "Compress PDFs"
 * processes every not-yet-compressed file sequentially via the pdf WASM
 * module (`compressPdf`) with a per-row spinner and a batch progress bar;
 * work runs in the pdf Web Worker, so the page stays responsive; Cancel
 * aborts the current file (terminates the worker) and stops the batch. Each result row shows original →
 * compressed size and a "Saved N%" badge — shown even when negative (legacy
 * parity) — and downloads as `compressed_<original name>` (legacy parity).
 * A corrupted or password-protected PDF gets an error badge and a localized
 * message naming the file; the rest of the batch still runs. A headline
 * above the list sums the batch: total "−N%" with original → compressed sizes.
 */
import { compressPdf } from "@/scripts/wasm/pdf-client";
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, revealOutput, startPreparing } from "@/scripts/tool-ui";
import { formatBytes, progressPercent } from "@/lib/format";
import { classifyPdfError, compressedFileName, isPdfFile, savingsPercent } from "@/tools/pdf-files";
import { appendMeta, badge, buildFileRow, downloadLink, iconButton, PDF_ICONS, spinner } from "@/tools/pdf-file-ui";

interface Strings {
  tableOriginalSize: string;
  tableCompressedSize: string;
  statusReady: string;
  savedPercent: string;
  compress: string;
  processing: string;
  download: string;
  removeFile: string;
  errorNotPdf: string;
  errorInvalidPdf: string;
  errorEncrypted: string;
  error: string;
  preparing: string;
  processingFailed: string;
}

interface FileItem {
  file: File;
  compressedSize: number | null;
  url: string | null;
  processing: boolean;
  error: string | null;
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-pdfc-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const zone = root.querySelector<HTMLElement>("[data-pdfc-dropzone]");
  const input = root.querySelector<HTMLInputElement>("[data-pdfc-file]");
  const listEl = root.querySelector<HTMLElement>("[data-pdfc-list]");
  const itemsEl = root.querySelector<HTMLUListElement>("[data-pdfc-items]");
  const compressEl = root.querySelector<HTMLButtonElement>("[data-pdfc-compress]");
  const compressLabel = root.querySelector<HTMLElement>("[data-pdfc-compress-label]");
  const progress = root.querySelector<HTMLElement>("[data-pdfc-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-pdfc-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-pdfc-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-pdfc-progress-label]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-pdfc-cancel]");
  const errorBox = root.querySelector<HTMLElement>("[data-pdfc-error]");
  const summaryEl = root.querySelector<HTMLElement>("[data-pdfc-summary]");
  const totalEl = root.querySelector<HTMLElement>("[data-pdfc-total]");
  const totalBeforeEl = root.querySelector<HTMLElement>("[data-pdfc-total-before]");
  const totalAfterEl = root.querySelector<HTMLElement>("[data-pdfc-total-after]");
  if (!zone || !input || !listEl || !itemsEl || !compressEl) return;
  const compress: HTMLButtonElement = compressEl;
  root.dataset.initialized = "true";

  const files: FileItem[] = [];
  let compressing = false;
  let job: AbortController | null = null;

  function showError(msg: string) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  function errorMessage(e: unknown, name: string): string {
    if (e instanceof WasmError && (e.code === "worker-failed" || e.code === "init-failed")) {
      return `${name}: ${strings.processingFailed}`;
    }
    const message = e instanceof Error ? e.message : "";
    const { kind } = classifyPdfError(message);
    if (kind === "encrypted") return strings.errorEncrypted.replace("{name}", name);
    if (kind === "invalid") return strings.errorInvalidPdf.replace("{name}", name);
    return `${name}: ${message || strings.error}`;
  }

  function setBusy(on: boolean) {
    compressing = on;
    compress.disabled = on;
    compress.setAttribute("aria-busy", String(on));
    if (compressLabel) compressLabel.textContent = on ? strings.processing : strings.compress;
    zone!.setAttribute("aria-disabled", String(on));
    input!.disabled = on;
    if (progress) progress.hidden = !on;
    if (cancelBtn) cancelBtn.disabled = false;
  }

  function setProgress(done: number, total: number, current: string) {
    const pct = progressPercent(done, total);
    if (progressFill) progressFill.style.width = `${pct}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(pct)));
    if (progressLabel) progressLabel.textContent = current ? `${done} / ${total} · ${current}` : `${done} / ${total}`;
  }

  /** Batch headline over all compressed rows; hidden until one is done. */
  function renderSummary() {
    if (!summaryEl || !totalEl) return;
    const doneItems = files.filter((f) => f.compressedSize !== null);
    summaryEl.hidden = doneItems.length === 0;
    if (doneItems.length === 0) return;
    const before = doneItems.reduce((sum, f) => sum + f.file.size, 0);
    const after = doneItems.reduce((sum, f) => sum + (f.compressedSize ?? 0), 0);
    const pct = savingsPercent(before, after);
    totalEl.textContent = pct > 0 ? `−${pct}%` : pct < 0 ? `+${-pct}%` : "0%";
    totalEl.classList.toggle("is-smaller", pct > 0);
    if (totalBeforeEl) totalBeforeEl.textContent = formatBytes(before, 2);
    if (totalAfterEl) totalAfterEl.textContent = formatBytes(after, 2);
  }

  function render() {
    renderSummary();
    itemsEl!.replaceChildren();
    listEl!.hidden = files.length === 0;

    files.forEach((item, index) => {
      const { li, meta, actions } = buildFileRow(item.file.name, index);
      appendMeta(meta, formatBytes(item.file.size, 2), strings.tableOriginalSize);

      if (item.compressedSize !== null) {
        appendMeta(meta, formatBytes(item.compressedSize, 2), strings.tableCompressedSize);
        // Legacy parity: rounded savings %, shown even when negative.
        const pct = savingsPercent(item.file.size, item.compressedSize);
        actions.append(badge(strings.savedPercent.replace("{pct}", String(pct)), pct > 0 ? "success" : "warning"));
      }
      if (item.url) {
        actions.append(downloadLink(item.url, compressedFileName(item.file.name), `${strings.download}: ${item.file.name}`));
      } else if (item.processing) {
        actions.append(spinner(strings.processing));
      } else if (item.error) {
        actions.append(badge(strings.error, "danger", item.error));
      } else {
        actions.append(badge(strings.statusReady));
      }

      const remove = iconButton(PDF_ICONS.close, `${strings.removeFile}: ${item.file.name}`);
      remove.disabled = compressing;
      remove.addEventListener("click", () => {
        if (compressing) return;
        if (item.url) URL.revokeObjectURL(item.url);
        files.splice(files.indexOf(item), 1);
        render();
        // Keep keyboard focus in the list (or on the picker when it empties).
        const next = itemsEl!.querySelectorAll<HTMLButtonElement>(".ds-file-item-actions button")[Math.min(index, files.length - 1)];
        (next ?? zone!.querySelector<HTMLElement>("input"))?.focus();
      });
      actions.append(remove);
      itemsEl!.append(li);
    });
    compress.disabled = compressing || !files.some((f) => f.compressedSize === null);
  }

  function addFiles(incoming: File[]) {
    clearError();
    if (compressing) return;
    const accepted = incoming.filter(isPdfFile);
    // Legacy silently filters non-PDFs on drop; surface a localized message instead.
    if (accepted.length < incoming.length) showError(strings.errorNotPdf);
    if (accepted.length === 0) return;
    for (const file of accepted) {
      files.push({ file, compressedSize: null, url: null, processing: false, error: null });
    }
    render();
  }

  async function handleCompress() {
    if (compressing) return;
    const queue = files.filter((f) => f.compressedSize === null); // Legacy: skip already compressed.
    if (queue.length === 0) return;

    const operation = startToolOperation("pdf-compressor");
    clearError();
    const ctrl = new AbortController();
    job = ctrl;
    setBusy(true);
    const errors: string[] = [];
    let done = 0;
    setProgress(0, queue.length, queue[0]?.file.name ?? "");

    for (const item of queue) {
      if (ctrl.signal.aborted) break;
      if (!files.includes(item)) continue;
      item.processing = true;
      item.error = null;
      render();
      setProgress(done, queue.length, item.file.name);
      try {
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        // First file loads the pdf WASM in the worker: "Preparing…" if slow.
        const compressed = await withPdfPreparing(compressPdf(bytes, ctrl.signal));
        item.compressedSize = compressed.length;
        item.url = URL.createObjectURL(new Blob([compressed.slice()], { type: "application/pdf" }));
      } catch (e) {
        if (e instanceof WasmError && e.code === "aborted") {
          // Cancelled mid-file: the row goes back to "ready".
          item.processing = false;
          break;
        }
        item.error = errorMessage(e, item.file.name);
        errors.push(item.error);
      }
      item.processing = false;
      done++;
      setProgress(done, queue.length, "");
    }

    job = null;
    setBusy(false);
    render();
    if (errors.length > 0) showError(errors.join("\n"));
    if (summaryEl && !summaryEl.hidden) revealOutput(summaryEl);
    if (!ctrl.signal.aborted) {
      if (errors.length > 0) operation.fail();
      else operation.complete();
    }
  }

  function withPdfPreparing<T>(work: Promise<T>): Promise<T> {
    const done = startPreparing("pdf", { host: compress.closest<HTMLElement>(".ds-action-row"), label: strings.preparing });
    return work.finally(done);
  }

  bindDropzone(zone, input, addFiles);
  compress.addEventListener("click", () => void handleCompress());
  cancelBtn?.addEventListener("click", () => {
    cancelBtn.disabled = true;
    job?.abort();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
