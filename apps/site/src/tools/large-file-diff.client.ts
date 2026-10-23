/**
 * Large file diff page controller. Both files stay on this device: a worker hashes their lines
 * (or compares their bytes), the table reads only the rows on screen, and the report is streamed
 * to the destination. Files, options and results are not written to storage.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { createExplorerTable, type ExplorerTable } from "@/scripts/explorer-table";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { saveWorkerStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { localizeResourceError } from "@/scripts/wasm/worker-protocol";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { FILE_DIFF_MAX_CONTEXT, formatHexOffset, type WhitespaceMode } from "@/tools/large-file-diff";
import type { FileDiffCompareResult, FileDiffMode, FileDiffSideSummary } from "@/tools/large-file-diff-protocol";
import { createFileDiffWorker, type FileDiffWorkerClient } from "@/tools/large-file-diff-worker-client";

interface Strings {
  Lang: string;
  ProgressBytes: string;
  ProgressRows: string;
  StatusReady: string;
  StatusIndexing: string;
  StatusMatching: string;
  StatusComparingBytes: string;
  StatusDone: string;
  StatusCanceled: string;
  StatusExporting: string;
  StatusExported: string;
  SummaryText: string;
  SummaryIdentical: string;
  SummaryIdenticalBinary: string;
  SummaryBinary: string;
  SummaryRangesCapped: string;
  FileLine: string;
  BinaryFileLine: string;
  EolLf: string;
  EolCrlf: string;
  EolMixed: string;
  EolNone: string;
  Approximate: string;
  ChangePosition: string;
  ColumnA: string;
  ColumnB: string;
  ColumnMark: string;
  ColumnText: string;
  ColumnOffset: string;
  ColumnLength: string;
  ColumnBytesA: string;
  ColumnBytesB: string;
  TableEmpty: string;
  TableLoading: string;
  RowLabel: string;
  NoNewlineMarker: string;
  ExportHintText: string;
  ExportHintBinary: string;
  ErrorNeedBoth: string;
  ErrorTooManyLines: string;
  ErrorLineTooLong: string;
  ErrorEncoding: string;
  ErrorWorker: string;
  ErrorGeneric: string;
  MemoryExhausted: string;
  InvalidFormat: string;
  CorruptInput: string;
}

/** Worker error codes that arrive as the error message. */
const ERROR_MESSAGES: Readonly<Record<string, true>> = {
  "need-both": true,
  "too-many-lines": true,
  "line-too-long": true,
  invalid: true,
  "session-missing": true,
  aborted: true,
  "worker-failed": true,
  unknown: true,
};

/** Fallback cap when the browser has no native save picker. */
const FALLBACK_MAX_BYTES = 512 * 1024 * 1024;
const MARKS = ["", " ", "−", "+"];
const ROW_CLASSES = ["fd-row-header", undefined, "fd-row-removed", "fd-row-added"];

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-diff-strings]");
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-diff-tool]");
  if (!root || root.dataset.initialized) return;
  const parsed = readStrings(root);
  if (!parsed) return;
  const strings: Strings = parsed;
  const zoneA = root.querySelector<HTMLElement>("[data-diff-dropzone-a]");
  const zoneB = root.querySelector<HTMLElement>("[data-diff-dropzone-b]");
  const inputA = root.querySelector<HTMLInputElement>("[data-diff-file-a]");
  const inputB = root.querySelector<HTMLInputElement>("[data-diff-file-b]");
  const nameA = root.querySelector<HTMLElement>("[data-diff-name-a]");
  const nameB = root.querySelector<HTMLElement>("[data-diff-name-b]");
  const modeSelect = root.querySelector<HTMLSelectElement>("[data-diff-mode]");
  const encodingSelect = root.querySelector<HTMLSelectElement>("[data-diff-encoding]");
  const whitespaceSelect = root.querySelector<HTMLSelectElement>("[data-diff-whitespace]");
  const contextInput = root.querySelector<HTMLInputElement>("[data-diff-context]");
  const ignoreEol = root.querySelector<HTMLInputElement>("[data-diff-ignore-eol]");
  const compareButton = root.querySelector<HTMLButtonElement>("[data-diff-compare]");
  const clearButton = root.querySelector<HTMLButtonElement>("[data-diff-clear]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-diff-cancel]");
  const progressBlock = root.querySelector<HTMLElement>("[data-diff-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-diff-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-diff-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-diff-progress-label]");
  const status = root.querySelector<HTMLElement>("[data-diff-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-diff-error]");
  const output = root.querySelector<HTMLElement>("[data-diff-output]");
  const loaded = root.querySelector<HTMLElement>("[data-diff-loaded]");
  const summaryEl = root.querySelector<HTMLElement>("[data-diff-summary]");
  const sidesEl = root.querySelector<HTMLElement>("[data-diff-sides]");
  const noteEl = root.querySelector<HTMLElement>("[data-diff-note]");
  const navEl = root.querySelector<HTMLElement>("[data-diff-nav]");
  const prevButton = root.querySelector<HTMLButtonElement>("[data-diff-prev]");
  const nextButton = root.querySelector<HTMLButtonElement>("[data-diff-next]");
  const positionEl = root.querySelector<HTMLElement>("[data-diff-position]");
  const tableHost = root.querySelector<HTMLElement>("[data-diff-table]");
  const exportHint = root.querySelector<HTMLElement>("[data-diff-export-hint]");
  const downloadButton = root.querySelector<HTMLButtonElement>("[data-diff-download]");
  if (
    !zoneA || !zoneB || !inputA || !inputB || !modeSelect || !encodingSelect || !whitespaceSelect || !contextInput
    || !ignoreEol || !compareButton || !clearButton || !output || !loaded || !tableHost || !downloadButton
  ) return;
  root.dataset.initialized = "true";
  const numberFormat = new Intl.NumberFormat(strings.Lang);

  let api: FileDiffWorkerClient = createFileDiffWorker();
  let fileA: File | null = null;
  let fileB: File | null = null;
  let result: FileDiffCompareResult | null = null;
  let table: ExplorerTable | null = null;
  let hunks = 0;
  let currentHunk = -1;
  let busy = false;
  let generation = 0;
  let activeAbort: AbortController | null = null;
  let activeOperation: ToolOperation | null = null;
  let matching = false;

  function showStatus(message: string): void {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function hideError(): void {
    if (errorBox) errorBox.hidden = true;
  }

  function errorCode(error: unknown): string {
    if (error instanceof Error && ERROR_MESSAGES[error.message]) return error.message;
    if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
    return "unknown";
  }

  function localizedError(error: unknown): string {
    switch (errorCode(error)) {
      case "need-both": return strings.ErrorNeedBoth;
      case "too-many-lines": return strings.ErrorTooManyLines;
      case "line-too-long": return strings.ErrorLineTooLong;
      case "invalid": return strings.ErrorEncoding;
      case "session-missing":
      case "worker-failed":
      case "unknown": return strings.ErrorWorker;
      default:
        return localizeResourceError(error, {
          memoryExhausted: strings.MemoryExhausted,
          invalidFormat: strings.InvalidFormat,
          corruptInput: strings.CorruptInput,
        }) ?? strings.ErrorGeneric;
    }
  }

  function showError(error: unknown): void {
    if (!errorBox) return;
    errorBox.textContent = localizedError(error);
    errorBox.hidden = false;
    if (status) status.hidden = true;
  }

  function updateProgress(info: { processed: number; total: number; elapsedMs: number }, rows = false): void {
    const percent = progressPercent(info.processed, info.total);
    if (progressFill) progressFill.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    if (!progressLabel) return;
    if (rows) {
      progressLabel.textContent = formatString(strings.ProgressRows, numberFormat.format(info.processed), numberFormat.format(info.total), formatMs(info.elapsedMs));
      return;
    }
    const perSecond = info.elapsedMs > 0 ? info.processed / (info.elapsedMs / 1000) : 0;
    progressLabel.textContent = formatString(strings.ProgressBytes, formatBytes(info.processed), formatBytes(info.total), formatBytes(perSecond), formatMs(info.elapsedMs));
  }

  function syncActions(): void {
    compareButton!.disabled = busy || !fileA || !fileB;
    downloadButton!.disabled = busy || !result || result.identical;
    const text = result?.mode === "text" && !result.identical;
    if (prevButton) prevButton.disabled = busy || !text || currentHunk <= 0;
    if (nextButton) nextButton.disabled = busy || !text || currentHunk >= hunks - 1;
    for (const control of [modeSelect, encodingSelect, whitespaceSelect, ignoreEol]) control!.disabled = busy;
    contextInput!.disabled = busy;
  }

  function setBusy(next: boolean, message?: string): void {
    busy = next;
    if (progressBlock) progressBlock.hidden = !next;
    if (next) {
      if (progressFill) progressFill.style.width = "0%";
      progressBar?.setAttribute("aria-valuenow", "0");
      if (progressLabel) progressLabel.textContent = "";
    }
    if (message) showStatus(message);
    syncActions();
  }

  function clearResult(): void {
    table?.destroy();
    table = null;
    tableHost!.replaceChildren();
    result = null;
    hunks = 0;
    currentHunk = -1;
    loaded!.hidden = true;
    syncEmptyState(output!, true);
    if (summaryEl) summaryEl.textContent = "";
    sidesEl?.replaceChildren();
    if (noteEl) noteEl.hidden = true;
    if (positionEl) positionEl.textContent = "";
  }

  function resetWorker(): void {
    generation++;
    activeAbort?.abort();
    activeAbort = null;
    api.terminate();
    api = createFileDiffWorker();
  }

  function eolLabel(side: FileDiffSideSummary): string {
    if (side.crlf > 0 && side.lf > 0) return strings.EolMixed;
    if (side.crlf > 0) return strings.EolCrlf;
    if (side.lf > 0) return strings.EolLf;
    return strings.EolNone;
  }

  function sideLine(side: FileDiffSideSummary): string {
    return formatString(strings.FileLine, side.name, formatBytes(side.size), numberFormat.format(side.lines), side.encoding.toUpperCase(), eolLabel(side));
  }

  function renderPosition(): void {
    if (!positionEl) return;
    positionEl.textContent = currentHunk >= 0 && hunks > 0
      ? formatString(strings.ChangePosition, numberFormat.format(currentHunk + 1), numberFormat.format(hunks))
      : "";
  }

  /** Fixed track for a line-number column: every row is its own grid, so tracks must not depend on content. */
  function numberTrack(maxValue: number): string {
    return `calc(${Math.max(8, String(Math.max(1, maxValue)).length)}ch + 1rem)`;
  }

  function renderTextTable(sessionId: number, rows: number): void {
    table?.destroy();
    table = createExplorerTable({
      host: tableHost!,
      columns: [
        { key: "a", label: strings.ColumnA },
        { key: "b", label: strings.ColumnB },
        { key: "mark", label: strings.ColumnMark },
        { key: "text", label: strings.ColumnText },
      ],
      readRows: async (start, count) => {
        const window = (await api.rows(sessionId, start, count)).text ?? [];
        return window.map((row) => [
          row.a > 0 ? String(row.a) : "",
          row.b > 0 ? String(row.b) : "",
          MARKS[row.kind] ?? "",
          row.noNewline ? `${row.text}  ${strings.NoNewlineMarker}` : row.text,
          String(row.kind),
        ]);
      },
      rowClass: (row) => ROW_CLASSES[Number(row[4])],
      onError(error) {
        if (errorCode(error) !== "aborted") showError(error);
      },
      emptyLabel: strings.TableEmpty,
      loadingLabel: strings.TableLoading,
      rowLabel: (index) => formatString(strings.RowLabel, numberFormat.format(index + 1)),
    });
    table.setRowCount(rows);
    // Narrow line-number and marker tracks; the text track takes the rest.
    const lines = result?.mode === "text" ? Math.max(result.text.a.lines, result.text.b.lines) : 1;
    const track = numberTrack(lines);
    tableHost!.style.setProperty("--ds-explorer-template", `var(--ds-explorer-row-track) ${track} ${track} 3ch minmax(30rem, 1fr)`);
    tableHost!.style.setProperty("--ds-explorer-width", `calc(var(--ds-explorer-row-track) + 2 * (${track}) + 3ch + 30rem)`);
  }

  function renderBinaryTable(sessionId: number, rows: number): void {
    table?.destroy();
    table = createExplorerTable({
      host: tableHost!,
      columns: [
        { key: "offset", label: strings.ColumnOffset },
        { key: "length", label: strings.ColumnLength },
        { key: "a", label: strings.ColumnBytesA },
        { key: "b", label: strings.ColumnBytesB },
      ],
      readRows: async (start, count) => {
        const window = (await api.rows(sessionId, start, count)).binary ?? [];
        return window.map((row) => [formatHexOffset(row.offset), numberFormat.format(row.length), row.a, row.b]);
      },
      onError(error) {
        if (errorCode(error) !== "aborted") showError(error);
      },
      emptyLabel: strings.TableEmpty,
      loadingLabel: strings.TableLoading,
      rowLabel: (index) => formatString(strings.RowLabel, numberFormat.format(index + 1)),
    });
    table.setRowCount(rows);
    tableHost!.style.setProperty("--ds-explorer-template", "var(--ds-explorer-row-track) calc(12ch + 1rem) calc(14ch + 1rem) minmax(24rem, 1fr) minmax(24rem, 1fr)");
    tableHost!.style.setProperty("--ds-explorer-width", "calc(var(--ds-explorer-row-track) + 26ch + 2rem + 48rem)");
  }

  function renderResult(next: FileDiffCompareResult): void {
    result = next;
    loaded!.hidden = false;
    syncEmptyState(output!, false);
    sidesEl?.replaceChildren();
    if (noteEl) noteEl.hidden = true;
    if (next.mode === "text") {
      const { text } = next;
      hunks = text.hunks;
      currentHunk = -1;
      if (summaryEl) {
        summaryEl.textContent = next.identical
          ? strings.SummaryIdentical
          : formatString(strings.SummaryText, numberFormat.format(text.removed), numberFormat.format(text.added), numberFormat.format(text.hunks));
      }
      for (const side of [text.a, text.b]) {
        const item = document.createElement("li");
        item.textContent = sideLine(side);
        sidesEl?.append(item);
      }
      if (noteEl && text.approximate) {
        noteEl.textContent = strings.Approximate;
        noteEl.hidden = false;
      }
      if (navEl) navEl.hidden = next.identical;
      if (exportHint) exportHint.textContent = strings.ExportHintText;
      renderTextTable(next.sessionId, next.identical ? 0 : text.rows);
    } else {
      const { binary } = next;
      hunks = 0;
      currentHunk = -1;
      if (summaryEl) {
        summaryEl.textContent = next.identical
          ? strings.SummaryIdenticalBinary
          : formatString(strings.SummaryBinary, numberFormat.format(binary.rangeCount), numberFormat.format(binary.differingBytes), formatHexOffset(binary.firstDifference));
      }
      for (const [file, size] of [[fileA, binary.sizeA], [fileB, binary.sizeB]] as const) {
        const item = document.createElement("li");
        item.textContent = formatString(strings.BinaryFileLine, file?.name ?? "", formatBytes(size));
        sidesEl?.append(item);
      }
      if (noteEl && binary.rangeCount > binary.keptRanges) {
        noteEl.textContent = formatString(strings.SummaryRangesCapped, numberFormat.format(binary.keptRanges));
        noteEl.hidden = false;
      }
      if (navEl) navEl.hidden = true;
      if (exportHint) exportHint.textContent = strings.ExportHintBinary;
      renderBinaryTable(next.sessionId, binary.keptRanges);
    }
    renderPosition();
    syncActions();
  }

  function contextValue(): number {
    const value = Number(contextInput!.value);
    return Number.isFinite(value) ? Math.max(0, Math.min(FILE_DIFF_MAX_CONTEXT, Math.floor(value))) : 3;
  }

  async function runCompare(): Promise<void> {
    if (busy) return;
    if (!fileA || !fileB) {
      showError(new Error("need-both"));
      return;
    }
    resetWorker();
    clearResult();
    hideError();
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    const operation = startToolOperation("large-file-diff");
    activeOperation = operation;
    const mode = modeSelect!.value as FileDiffMode;
    matching = false;
    setBusy(true, mode === "binary" ? strings.StatusComparingBytes : strings.StatusIndexing);
    try {
      const next = await api.compare(fileA, fileB, mode, {
        encoding: encodingSelect!.value,
        whitespace: whitespaceSelect!.value as WhitespaceMode,
        ignoreEol: ignoreEol!.checked,
      }, contextValue(), controller.signal, (info) => {
        if (token !== generation) return;
        updateProgress(info);
        // Byte progress reaches the end when hashing is done; the line matching follows.
        if (mode !== "binary" && !matching && info.processed >= info.total && info.total > 0) {
          matching = true;
          showStatus(strings.StatusMatching);
        }
      });
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      renderResult(next);
      showStatus(strings.StatusDone);
      operation.complete();
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        resetWorker();
        clearResult();
        showStatus(strings.StatusCanceled);
      } else {
        showError(error);
        const code = errorCode(error);
        operation.fail(code === "too-many-lines" || code === "line-too-long" ? "invalid_input"
          : code === "invalid" ? "invalid_input" : "processing_error");
      }
    } finally {
      if (activeOperation === operation) activeOperation = null;
    }
  }

  async function relayout(): Promise<void> {
    if (busy || result?.mode !== "text" || result.identical) return;
    const sessionId = result.sessionId;
    try {
      const layout = await api.layout(sessionId, contextValue());
      if (result?.sessionId !== sessionId) return;
      hunks = layout.hunks;
      result.text.rows = layout.rows;
      result.text.hunks = layout.hunks;
      currentHunk = -1;
      renderTextTable(sessionId, layout.rows);
      if (summaryEl) summaryEl.textContent = formatString(strings.SummaryText, numberFormat.format(result.text.removed), numberFormat.format(result.text.added), numberFormat.format(layout.hunks));
      renderPosition();
      syncActions();
    } catch (error) {
      showError(error);
    }
  }

  async function goToHunk(index: number): Promise<void> {
    if (busy || result?.mode !== "text" || index < 0 || index >= hunks) return;
    try {
      const row = await api.hunkRow(result.sessionId, index);
      currentHunk = index;
      table?.scrollToRow(row);
      renderPosition();
      syncActions();
    } catch (error) {
      showError(error);
    }
  }

  async function download(): Promise<void> {
    if (busy || !result || result.identical) return;
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    const text = result.mode === "text";
    const sessionId = result.sessionId;
    const stem = (name: string) => name.replace(/\.[^.]+$/u, "") || "file";
    setBusy(true, strings.StatusExporting);
    try {
      await saveWorkerStreamedFile({
        suggestedName: `${stem(fileA?.name ?? "a")}-vs-${stem(fileB?.name ?? "b")}.${text ? "diff" : "csv"}`,
        mimeType: text ? "text/x-diff;charset=utf-8" : "text/csv;charset=utf-8",
        extensions: [text ? "diff" : "csv"],
        fallbackMaxBytes: FALLBACK_MAX_BYTES,
        signal: controller.signal,
      }, (stream, workerSignal) => api.exportReport(sessionId, stream, workerSignal, (info) => updateProgress(info, true)));
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      showStatus(strings.StatusExported);
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        if (error instanceof StreamSaveError && !controller.signal.aborted) {
          showStatus(strings.StatusCanceled);
          return;
        }
        // Cancel terminated the worker and its session; compare again with the same files.
        resetWorker();
        clearResult();
        showStatus(strings.StatusCanceled);
      } else {
        showError(error);
      }
    }
  }

  /** A new file replaces the old one even mid-run: the running comparison is canceled first. */
  function chooseFile(side: "a" | "b", file: File | undefined): void {
    if (!file) return;
    if (busy) {
      activeOperation?.cancel();
      activeOperation = null;
    }
    if (side === "a") fileA = file;
    else fileB = file;
    const zone = side === "a" ? zoneA! : zoneB!;
    const name = side === "a" ? nameA : nameB;
    setDropzoneHasFile(zone, true);
    if (name) {
      name.textContent = `${file.name} · ${formatBytes(file.size)}`;
      name.hidden = false;
    }
    resetWorker();
    setBusy(false);
    clearResult();
    hideError();
    syncActions();
    if (fileA && fileB) void runCompare();
    else showStatus(strings.StatusReady);
  }

  bindDropzone(zoneA, inputA, (files) => chooseFile("a", files[0]));
  bindDropzone(zoneB, inputB, (files) => chooseFile("b", files[0]));
  compareButton.addEventListener("click", () => void runCompare());
  clearButton.addEventListener("click", () => {
    resetWorker();
    clearResult();
    fileA = null;
    fileB = null;
    inputA!.value = "";
    inputB!.value = "";
    for (const [zone, name] of [[zoneA!, nameA], [zoneB!, nameB]] as const) {
      setDropzoneHasFile(zone, false);
      if (name) {
        name.textContent = "";
        name.hidden = true;
      }
    }
    setBusy(false);
    hideError();
    showStatus(strings.StatusReady);
  });
  cancelButton?.addEventListener("click", () => {
    if (!busy) return;
    activeOperation?.cancel();
    activeAbort?.abort();
  });
  contextInput.addEventListener("change", () => void relayout());
  prevButton?.addEventListener("click", () => void goToHunk(currentHunk - 1));
  nextButton?.addEventListener("click", () => void goToHunk(currentHunk + 1));
  downloadButton.addEventListener("click", () => void download());
  syncActions();
  showStatus(strings.StatusReady);
}

init();
