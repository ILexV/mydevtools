/**
 * PDF Merger client controller. PDFs picked via file dialog (multiple),
 * drag-drop (`bindDropzone`) or the "add files" button are appended to the
 * list (merge order = list order; no dedup — legacy parity). Rows show
 * index/name/size/status with move up/down and remove buttons; clear-all
 * empties the list. Non-PDF picks are rejected with a localized message
 * (valid files in the same pick are still added — legacy drop parity).
 * Merge is enabled with ≥2 files and runs `mergePdfs` on the buffers in list
 * order. On success the merge button hides until the list changes (legacy
 * parity), rows get a success badge, and the result shows the merged size
 * with a `merged.pdf` download (legacy filename). A corrupted or
 * password-protected input is named in a localized error and its row is
 * marked. The result object URL is revoked on replace and on list mutation.
 * While merging, an indeterminate progress block shows elapsed seconds and
 * a Cancel button: it aborts the job (terminates the pdf worker), the list
 * stays as it was and an info note says the merge was cancelled.
 */
import { mergePdfs } from "@/scripts/wasm/pdf-client";
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, revealOutput, withPreparing } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import { classifyPdfError, isPdfFile, moveItem } from "@/tools/pdf-files";
import { appendMeta, badge, buildFileRow, iconButton, PDF_ICONS } from "@/tools/pdf-file-ui";

interface Strings {
  colSize: string;
  statusReady: string;
  removeFile: string;
  moveUp: string;
  moveDown: string;
  merge: string;
  merging: string;
  mergeCanceled: string;
  success: string;
  minFilesHint: string;
  errorNotPdf: string;
  errorInvalidPdf: string;
  errorEncrypted: string;
  errorMerge: string;
  error: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
  processingFailed: string;
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-pdfm-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const zone = root.querySelector<HTMLElement>("[data-pdfm-dropzone]");
  const input = root.querySelector<HTMLInputElement>("[data-pdfm-file]");
  const listEl = root.querySelector<HTMLElement>("[data-pdfm-list]");
  const items = root.querySelector<HTMLOListElement>("[data-pdfm-items]");
  const hintEl = root.querySelector<HTMLElement>("[data-pdfm-hint]");
  const addBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-add]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-clear]");
  const merge = root.querySelector<HTMLButtonElement>("[data-pdfm-merge]");
  const mergeLabel = root.querySelector<HTMLElement>("[data-pdfm-merge-label]");
  const resultEl = root.querySelector<HTMLElement>("[data-pdfm-result]");
  const resultSizeEl = root.querySelector<HTMLElement>("[data-pdfm-result-size]");
  const download = root.querySelector<HTMLButtonElement>("[data-pdfm-download]");
  const errorBox = root.querySelector<HTMLElement>("[data-pdfm-error]");
  const noteBox = root.querySelector<HTMLElement>("[data-pdfm-note]");
  const progress = root.querySelector<HTMLElement>("[data-pdfm-progress]");
  const progressLabel = root.querySelector<HTMLElement>("[data-pdfm-progress-label]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-pdfm-cancel]");
  if (!zone || !input || !listEl || !items || !merge || !resultEl || !download) return;
  root.dataset.initialized = "true";

  let files: File[] = [];
  let resultUrl: string | null = null;
  let merging = false;
  let job: AbortController | null = null;
  /** Row status after the last merge attempt: all merged, or one failed index. */
  let merged = false;
  let failedIndex: number | null = null;

  function showError(msg: string) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
    if (noteBox) noteBox.hidden = true;
  }
  function showNote(msg: string) {
    if (!noteBox) return;
    noteBox.textContent = msg;
    noteBox.hidden = false;
  }

  function hideResult() {
    resultEl!.hidden = true;
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  function updateMergeState() {
    merge!.disabled = merging || files.length < 2;
    merge!.title = files.length < 2 ? strings.minFilesHint : "";
    if (hintEl) hintEl.hidden = files.length >= 2;
    if (clearBtn) clearBtn.disabled = merging;
    if (addBtn) addBtn.disabled = merging;
    zone!.setAttribute("aria-disabled", String(merging));
    input!.disabled = merging;
  }

  /** Rebuild rows. `focus` = [row index, button role] to restore keyboard focus. */
  function renderRows(focus?: [number, "up" | "down" | "remove"]) {
    items!.replaceChildren();
    listEl!.hidden = files.length === 0;

    files.forEach((file, index) => {
      const { li, meta, actions } = buildFileRow(file.name, index);
      appendMeta(meta, formatBytes(file.size, 2), strings.colSize);

      if (failedIndex === index) actions.append(badge(strings.error, "danger"));
      else if (merged) {
        // Long success sentence stays in the result alert; the row gets a
        // compact check badge (text kept for screen readers / tooltip).
        const ok = badge("", "success", strings.success);
        ok.innerHTML = PDF_ICONS.check;
        const sr = document.createElement("span");
        sr.className = "visually-hidden";
        sr.textContent = strings.success;
        ok.append(sr);
        actions.append(ok);
      }
      else actions.append(badge(strings.statusReady));

      const up = iconButton(PDF_ICONS.up, `${strings.moveUp}: ${file.name}`);
      up.dataset.pdfmMove = "up";
      up.dataset.index = String(index);
      up.disabled = merging || index === 0;
      const down = iconButton(PDF_ICONS.down, `${strings.moveDown}: ${file.name}`);
      down.dataset.pdfmMove = "down";
      down.dataset.index = String(index);
      down.disabled = merging || index === files.length - 1;
      const remove = iconButton(PDF_ICONS.close, `${strings.removeFile}: ${file.name}`);
      remove.dataset.pdfmRemove = String(index);
      remove.disabled = merging;
      actions.append(up, down, remove);
      items!.appendChild(li);
    });

    if (focus) {
      const [row, role] = focus;
      const li = items!.children[Math.min(row, files.length - 1)];
      const selector = role === "remove" ? "[data-pdfm-remove]" : `[data-pdfm-move="${role}"]`;
      let target = li?.querySelector<HTMLButtonElement>(selector) ?? null;
      if (target?.disabled) target = li?.querySelector<HTMLButtonElement>("[data-pdfm-remove]") ?? null;
      (target ?? zone!.querySelector<HTMLElement>("input"))?.focus();
    }
  }

  /** Any list change: back to "Ready", merge button returns, result hidden (legacy parity). */
  function listChanged(focus?: [number, "up" | "down" | "remove"]) {
    merged = false;
    failedIndex = null;
    merge!.hidden = false;
    hideResult();
    renderRows(focus);
    updateMergeState();
  }

  function addFiles(incoming: File[]) {
    if (merging || incoming.length === 0) return;
    const valid = incoming.filter(isPdfFile);
    if (valid.length < incoming.length) showError(strings.errorNotPdf);
    else clearError();
    if (valid.length === 0) return;
    files = [...files, ...valid];
    listChanged();
  }

  function errorMessage(e: unknown): string {
    if (e instanceof WasmError && (e.code === "worker-failed" || e.code === "init-failed")) {
      failedIndex = null;
      return strings.processingFailed;
    }
    const message = e instanceof Error ? e.message : "";
    const { kind, index } = classifyPdfError(message);
    const name = index !== null ? files[index]?.name : undefined;
    failedIndex = index;
    if (name && kind === "encrypted") return strings.errorEncrypted.replace("{name}", name);
    if (name && kind === "invalid") return strings.errorInvalidPdf.replace("{name}", name);
    return message ? `${strings.errorMerge} (${message})` : strings.errorMerge;
  }

  async function handleMerge() {
    if (files.length < 2 || merging) return;
    const operation = startToolOperation("pdf-merger");

    merging = true;
    merge!.setAttribute("aria-busy", "true");
    if (mergeLabel) mergeLabel.textContent = strings.merging;
    clearError();
    hideResult();
    merged = false;
    failedIndex = null;
    updateMergeState();
    renderRows();

    const ctrl = new AbortController();
    job = ctrl;
    const started = performance.now();
    const tick = () => {
      if (progressLabel) progressLabel.textContent = `${Math.floor((performance.now() - started) / 1000)} s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    if (cancelBtn) cancelBtn.disabled = false;
    if (progress) progress.hidden = false;

    try {
      const buffers = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
      if (ctrl.signal.aborted) throw new WasmError("aborted", "Aborted");
      const out = await withPreparing("pdf", mergePdfs(buffers, ctrl.signal), {
        host: merge!.closest<HTMLElement>(".ds-action-row"),
        label: strings.preparing,
      });
      const blob = new Blob([out.slice()], { type: "application/pdf" });
      resultUrl = URL.createObjectURL(blob);
      if (resultSizeEl) resultSizeEl.textContent = formatBytes(blob.size, 2);
      resultEl!.hidden = false;
      merged = true;
      // Legacy parity: hide the merge button after success; it returns when
      // the file list changes.
      merge!.hidden = true;
      operation.complete();
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof WasmError && e.code === "aborted")) showNote(strings.mergeCanceled);
      else {
        operation.fail();
        showError(errorMessage(e));
      }
    } finally {
      clearInterval(timer);
      if (progress) progress.hidden = true;
      job = null;
      merging = false;
      merge!.removeAttribute("aria-busy");
      if (mergeLabel) mergeLabel.textContent = strings.merge;
      updateMergeState();
      renderRows();
      if (merged) {
        download!.focus({ preventScroll: true });
        revealOutput(resultEl);
      }
      // Cancel hid its own button: return keyboard focus to Merge.
      else if (ctrl.signal.aborted) merge!.focus();
    }
  }

  bindDropzone(zone, input, addFiles);
  addBtn?.addEventListener("click", () => {
    if (!merging) input.click();
  });

  items.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("button") : null;
    if (!btn || merging) return;
    if (btn.dataset.pdfmRemove !== undefined) {
      const index = Number.parseInt(btn.dataset.pdfmRemove, 10);
      if (Number.isNaN(index) || !files[index]) return;
      files.splice(index, 1);
      clearError();
      listChanged([index, "remove"]);
      return;
    }
    const dir = btn.dataset.pdfmMove;
    const index = Number.parseInt(btn.dataset.index ?? "", 10);
    if ((dir !== "up" && dir !== "down") || Number.isNaN(index)) return;
    const to = dir === "up" ? index - 1 : index + 1;
    files = moveItem(files, index, to);
    listChanged([to, dir]);
  });

  clearBtn?.addEventListener("click", () => {
    if (merging) return;
    files = [];
    input.value = "";
    clearError();
    listChanged();
    zone.querySelector<HTMLElement>("input")?.focus();
  });

  merge.addEventListener("click", () => void handleMerge());
  cancelBtn?.addEventListener("click", () => {
    cancelBtn.disabled = true;
    job?.abort();
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
