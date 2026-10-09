/**
 * PDF to Text client controller. PDFs picked via file dialog or drag-drop
 * (`bindDropzone`) are appended to a batch list (legacy parity: multi-file;
 * non-PDF entries are rejected with a localized message). "Extract Text"
 * runs every pending file through the pdf WASM module (`extractText`) with a
 * per-row spinner and a batch progress bar. Extraction runs in the pdf Web
 * Worker (page stays responsive); Cancel aborts the current file
 * (terminates the worker) and stops the batch. Each finished row
 * gets a download link for `<name>.txt` (legacy filename pattern). A
 * corrupted or password-protected PDF gets an error badge and a localized
 * message naming the file; the rest of the batch still runs. Already
 * extracted files are skipped on re-extract (legacy parity); object URLs are
 * revoked on remove. After a run the result panel shows the batch summary
 * (files · pages · characters), a preview of one file's text (first ~2,000
 * characters, picker when several), Copy / Download TXT, is revealed on
 * mobile (`revealOutput`) and the summary is announced politely.
 */
import { extractText } from "@/scripts/wasm/pdf-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { announce, bindDropzone, copyWithFeedback, revealOutput, withPreparing } from "@/scripts/tool-ui";
import { formatBytes, formatPlural, formatString, progressPercent } from "@/lib/format";
import { classifyPdfError, countExtractedPages, isPdfFile, previewText, textFileName } from "@/tools/pdf-files";
import { appendMeta, badge, buildFileRow, downloadLink, iconButton, PDF_ICONS, spinner } from "@/tools/pdf-file-ui";

interface Strings {
  colSize: string;
  ready: string;
  extract: string;
  processing: string;
  downloadTxt: string;
  removeFile: string;
  errorNotPdf: string;
  errorInvalidPdf: string;
  errorEncrypted: string;
  errorExtraction: string;
  error: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
  processingFailed: string;
  lang: string;
  previewTruncated: string;
  previewEmpty: string;
  summaryFiles: string;
  summaryPages: string;
  summaryChars: string;
  resultAnnounce: string;
  copied: string;
  /** Plural variants (`summaryFiles_one`, `summaryChars_few`, …). */
  [key: string]: string | undefined;
}

interface PdfItem {
  file: File;
  url: string | null;
  /** Extracted text (kept for the preview / Copy); null until extracted. */
  text: string | null;
  processing: boolean;
  error: string | null;
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-pdft-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const zone = root.querySelector<HTMLElement>("[data-pdft-dropzone]");
  const input = root.querySelector<HTMLInputElement>("[data-pdft-file]");
  const listEl = root.querySelector<HTMLElement>("[data-pdft-list]");
  const itemsEl = root.querySelector<HTMLUListElement>("[data-pdft-items]");
  const extractEl = root.querySelector<HTMLButtonElement>("[data-pdft-extract]");
  const extractLabel = root.querySelector<HTMLElement>("[data-pdft-extract-label]");
  const progress = root.querySelector<HTMLElement>("[data-pdft-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-pdft-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-pdft-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-pdft-progress-label]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-pdft-cancel]");
  const errorBox = root.querySelector<HTMLElement>("[data-pdft-error]");
  const resultEl = root.querySelector<HTMLElement>("[data-pdft-result]");
  const summaryEl = root.querySelector<HTMLElement>("[data-pdft-summary]");
  const summaryFilesEl = root.querySelector<HTMLElement>("[data-pdft-summary-files]");
  const pickEl = root.querySelector<HTMLElement>("[data-pdft-preview-pick]");
  const pickSelect = root.querySelector<HTMLSelectElement>("[data-pdft-preview-file]");
  const previewEl = root.querySelector<HTMLTextAreaElement>("[data-pdft-preview]");
  const previewNote = root.querySelector<HTMLElement>("[data-pdft-preview-note]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-pdft-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-pdft-download]");
  if (!zone || !input || !listEl || !itemsEl || !extractEl) return;
  const extract: HTMLButtonElement = extractEl;
  root.dataset.initialized = "true";

  const files: PdfItem[] = [];
  let extracting = false;
  let job: AbortController | null = null;
  /** File shown in the result preview (Copy / Download act on it). */
  let previewItem: PdfItem | null = null;
  const num = (n: number) => n.toLocaleString(strings.lang);

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
    return `${name}: ${strings.errorExtraction}${message ? ` (${message})` : ""}`;
  }

  function setBusy(on: boolean) {
    extracting = on;
    extract.disabled = on;
    extract.setAttribute("aria-busy", String(on));
    if (extractLabel) extractLabel.textContent = on ? strings.processing : strings.extract;
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

  function render() {
    itemsEl!.replaceChildren();
    listEl!.hidden = files.length === 0;

    files.forEach((item, index) => {
      const { li, meta, actions } = buildFileRow(item.file.name, index);
      appendMeta(meta, formatBytes(item.file.size, 2), strings.colSize);

      if (item.url) {
        actions.append(downloadLink(item.url, textFileName(item.file.name), `${strings.downloadTxt}: ${item.file.name}`));
      } else if (item.processing) {
        actions.append(spinner(strings.processing));
      } else if (item.error) {
        actions.append(badge(strings.error, "danger", item.error));
      } else {
        actions.append(badge(strings.ready));
      }

      const remove = iconButton(PDF_ICONS.close, `${strings.removeFile}: ${item.file.name}`);
      remove.disabled = extracting;
      remove.addEventListener("click", () => {
        if (extracting) return;
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
    extract.disabled = extracting || !files.some((f) => !f.url);
    renderResult();
  }

  /** Extracted files of the list (result panel input), in list order. */
  function extracted(): PdfItem[] {
    return files.filter((f) => f.text !== null);
  }

  /** Batch summary parts: "2 files", "3 pages · 1,204 characters". */
  function summaryParts(done: PdfItem[]) {
    const pages = done.reduce((n, f) => n + countExtractedPages(f.text ?? ""), 0);
    const chars = done.reduce((n, f) => n + (f.text ?? "").length, 0);
    return {
      files: formatPlural(strings, "summaryFiles", done.length, strings.lang, num(done.length)),
      pages: formatPlural(strings, "summaryPages", pages, strings.lang, num(pages)),
      chars: formatPlural(strings, "summaryChars", chars, strings.lang, num(chars)),
    };
  }

  /** Result panel: summary, preview picker (2+ files) and the previewed text. */
  function renderResult() {
    if (!resultEl) return;
    const done = extracted();
    resultEl.hidden = done.length === 0;
    if (done.length === 0) {
      previewItem = null;
      return;
    }
    if (!previewItem || !done.includes(previewItem)) previewItem = done[0] ?? null;
    const parts = summaryParts(done);
    if (summaryFilesEl) summaryFilesEl.textContent = parts.files;
    if (summaryEl) summaryEl.textContent = `${parts.pages} · ${parts.chars}`;
    if (pickEl && pickSelect) {
      pickEl.hidden = done.length < 2;
      pickSelect.replaceChildren(
        ...done.map((f, i) => {
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = f.file.name;
          opt.selected = f === previewItem;
          return opt;
        }),
      );
    }
    renderPreview();
  }

  function renderPreview() {
    const text = previewItem?.text ?? "";
    const { text: shown, truncated } = previewText(text);
    if (previewEl) {
      previewEl.value = shown;
      // Fit short texts (no tall empty box), cap long ones; the user can resize.
      previewEl.rows = Math.min(14, Math.max(4, shown.split("\n").length + 1));
    }
    if (previewNote) {
      const note = text.trim() === ""
        ? strings.previewEmpty
        : truncated ? formatString(strings.previewTruncated, num(shown.length), num(text.length)) : "";
      previewNote.textContent = note;
      previewNote.hidden = note === "";
    }
    if (copyBtn) copyBtn.disabled = text === "";
  }

  function addFiles(incoming: File[]) {
    clearError();
    if (extracting) return;
    // Legacy parity: non-PDF entries are rejected (type or extension).
    const valid = incoming.filter(isPdfFile);
    if (valid.length < incoming.length) showError(strings.errorNotPdf);
    if (valid.length === 0) return;
    for (const file of valid) files.push({ file, url: null, text: null, processing: false, error: null });
    render();
  }

  async function handleExtract() {
    if (extracting) return;
    const queue = files.filter((f) => !f.url); // Legacy parity: skip already extracted.
    if (queue.length === 0) return;

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
        const text = await withPreparing("pdf", extractText(bytes, ctrl.signal), {
          host: extract.closest<HTMLElement>(".ds-action-row"),
          label: strings.preparing,
        });
        item.url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
        item.text = text;
        previewItem = item; // Preview the newest result.
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
    const finished = extracted();
    if (finished.length > 0 && resultEl && !resultEl.hidden) {
      const parts = summaryParts(finished);
      announce(formatString(strings.resultAnnounce, `${parts.files}, ${parts.pages}, ${parts.chars}`));
      revealOutput(resultEl);
    }
  }

  bindDropzone(zone, input, addFiles);
  pickSelect?.addEventListener("change", () => {
    previewItem = extracted()[Number(pickSelect.value)] ?? previewItem;
    renderPreview();
  });
  copyBtn?.addEventListener("click", () => {
    if (previewItem?.text) void copyWithFeedback(copyBtn, previewItem.text, strings.copied);
  });
  downloadBtn?.addEventListener("click", () => {
    if (!previewItem?.url) return;
    const a = document.createElement("a");
    a.href = previewItem.url;
    a.download = textFileName(previewItem.file.name);
    document.body.append(a);
    a.click();
    a.remove();
  });
  extract.addEventListener("click", () => void handleExtract());
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
