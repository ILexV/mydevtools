/**
 * Archive explorer page controller. The archive stays on this device: a worker lists it, the
 * table reads only the rows on screen, and extraction or a new archive streams to the chosen
 * destination. Files, names and selections are not written to storage.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { createExplorerTable, type ExplorerTable } from "@/scripts/explorer-table";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { saveWorkerStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { localizeResourceError } from "@/scripts/wasm/worker-protocol";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { ZIP_METHOD_NAMES } from "@/tools/archive-format";
import type { ArchiveCreateFormat, ArchiveRow, ArchiveSummary, ExtractSummary, ExtractTarget, SelectionSummary } from "@/tools/archive-explorer-protocol";
import { createArchiveWorker, type ArchiveWorkerClient } from "@/tools/archive-explorer-worker-client";

type Strings = Record<string, string> & { Lang: string };

/** Fallback cap when the browser has no native save picker. */
const FALLBACK_MAX_BYTES = 512 * 1024 * 1024;
const CREATE_LEVELS: Readonly<Record<ArchiveCreateFormat, [number, number, number]>> = {
  zip: [0, 9, 6],
  tar: [0, 0, 0],
  "tar.gz": [1, 9, 6],
  "tar.zst": [1, 19, 3],
};

/** Worker and page error codes with their message keys. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  "unsupported-format": "ErrorUnsupportedFormat",
  corrupt: "ErrorCorrupt",
  truncated: "ErrorTruncated",
  "too-many-entries": "ErrorTooManyEntries",
  overlap: "ErrorOverlap",
  bomb: "ErrorBomb",
  "size-mismatch": "ErrorSizeMismatch",
  checksum: "ErrorChecksum",
  "too-large": "ErrorTooLarge",
  "need-one": "ErrorNeedOne",
  "need-selection": "ErrorNeedSelection",
  "session-missing": "ErrorWorker",
  folder: "ErrorFolder",
  "fallback-too-large": "ErrorFallbackTooLarge",
};

interface DirectoryPicker {
  (options?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
}

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-archive-strings]");
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-archive-tool]");
  if (!root || root.dataset.initialized) return;
  const parsed = readStrings(root);
  if (!parsed) return;
  const strings: Strings = parsed;
  const $ = <T extends HTMLElement>(hook: string) => root.querySelector<T>(`[data-archive-${hook}]`);
  const zone = $("dropzone");
  const input = $<HTMLInputElement>("file");
  const nameEl = $("name");
  const clearButton = $<HTMLButtonElement>("clear");
  const cancelButton = $<HTMLButtonElement>("cancel");
  const progressBlock = $("progress");
  const progressBar = $("progress-bar");
  const progressFill = $("progress-fill");
  const progressLabel = $("progress-label");
  const status = $("status");
  const errorBox = $("error");
  const output = $("output");
  const loaded = $("loaded");
  const summaryEl = $("summary");
  const notesEl = $("notes");
  const filterInput = $<HTMLInputElement>("filter");
  const selectAll = $<HTMLButtonElement>("select-all");
  const selectFiltered = $<HTMLButtonElement>("select-filtered");
  const selectNone = $<HTMLButtonElement>("select-none");
  const selectionEl = $("selection");
  const tableHost = $("table");
  const extractFolder = $<HTMLButtonElement>("extract-folder");
  const extractZip = $<HTMLButtonElement>("extract-zip");
  const extractFile = $<HTMLButtonElement>("extract-file");
  const extractResult = $("extract-result");
  const createZone = $("create-dropzone");
  const createInput = $<HTMLInputElement>("create-files");
  const createFolder = $<HTMLInputElement>("create-folder");
  const createList = $("create-list");
  const createFormat = $<HTMLSelectElement>("create-format");
  const createLevel = $<HTMLInputElement>("create-level");
  const createLevelHint = $("create-level-hint");
  const createButton = $<HTMLButtonElement>("create");
  const createClear = $<HTMLButtonElement>("create-clear");
  if (
    !zone || !input || !output || !loaded || !tableHost || !filterInput || !extractZip || !extractFile || !createZone
    || !createInput || !createFormat || !createLevel || !createButton
  ) return;
  root.dataset.initialized = "true";
  const numberFormat = new Intl.NumberFormat(strings.Lang);
  const dateFormat = new Intl.DateTimeFormat(strings.Lang, { dateStyle: "short", timeStyle: "short" });
  const directoryPicker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (extractFolder) extractFolder.hidden = typeof directoryPicker !== "function";

  let api: ArchiveWorkerClient = createArchiveWorker();
  let file: File | null = null;
  let summary: ArchiveSummary | null = null;
  let table: ExplorerTable | null = null;
  let selectedFiles = 0;
  let selectedTotal = 0;
  let selectedName = "";
  let createFiles: { file: File; path: string }[] = [];
  let busy = false;
  let generation = 0;
  let activeAbort: AbortController | null = null;
  let activeOperation: ToolOperation | null = null;
  let filterTimer = 0;

  const format = (value: number) => numberFormat.format(value);

  function showStatus(message: string): void {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function hideError(): void {
    if (errorBox) errorBox.hidden = true;
  }

  /** Worker errors arrive as `code` or `code:detail` in the message. */
  function errorCode(error: unknown): string {
    if (error instanceof StreamSaveError) return error.code === "aborted" ? "aborted" : error.code === "fallback-too-large" ? "fallback-too-large" : "storage";
    const code = (error instanceof Error ? error.message : "").split(":")[0];
    if (ERROR_KEYS[code]) return code;
    if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
    return "unknown";
  }

  function localizedError(error: unknown): string {
    const code = errorCode(error);
    if (code === "unsupported-format") {
      const detail = error instanceof Error ? error.message.split(":")[1] ?? "" : "";
      return detail ? formatString(strings.ErrorUnsupportedNamed, detail) : strings.ErrorUnsupportedFormat;
    }
    if (ERROR_KEYS[code]) return strings[ERROR_KEYS[code]];
    if (code === "worker-failed" || code === "unknown") return strings.ErrorWorker;
    return localizeResourceError(error, {
      memoryExhausted: strings.MemoryExhausted,
      invalidFormat: strings.InvalidFormat,
      corruptInput: strings.CorruptInput,
    }) ?? strings.ErrorGeneric;
  }

  function showError(error: unknown): void {
    if (!errorBox) return;
    errorBox.textContent = localizedError(error);
    errorBox.hidden = false;
    if (status) status.hidden = true;
  }

  function updateProgress(info: { processed: number; total: number; elapsedMs: number }): void {
    const percent = progressPercent(info.processed, info.total);
    if (progressFill) progressFill.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    if (!progressLabel) return;
    const perSecond = info.elapsedMs > 0 ? info.processed / (info.elapsedMs / 1000) : 0;
    progressLabel.textContent = formatString(strings.ProgressBytes, formatBytes(info.processed), formatBytes(info.total), formatBytes(perSecond), formatMs(info.elapsedMs));
  }

  function syncActions(): void {
    const open = !busy && !!summary;
    for (const button of [selectAll, selectFiltered, selectNone]) if (button) button.disabled = !open;
    filterInput!.disabled = !open;
    if (extractFolder) extractFolder.disabled = !open || selectedTotal === 0;
    extractZip!.disabled = !open || selectedFiles === 0;
    extractFile!.disabled = !open || selectedFiles !== 1;
    const [min, max] = CREATE_LEVELS[createFormat!.value as ArchiveCreateFormat];
    createLevel!.disabled = busy || min === max;
    createButton!.disabled = busy || createFiles.length === 0;
    createFormat!.disabled = busy;
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
    summary = null;
    selectedFiles = 0;
    selectedTotal = 0;
    loaded!.hidden = true;
    syncEmptyState(output!, true);
    if (summaryEl) summaryEl.textContent = "";
    notesEl?.replaceChildren();
    filterInput!.value = "";
    if (extractResult) extractResult.hidden = true;
  }

  function resetWorker(): void {
    generation++;
    activeAbort?.abort();
    activeAbort = null;
    api.terminate();
    api = createArchiveWorker();
  }

  function formatLabel(next: ArchiveSummary): string {
    const codec = next.codec ? { gzip: "gzip", zstd: "Zstandard", brotli: "Brotli" }[next.codec] : "";
    if (next.container === "zip") return strings.FormatZip;
    if (next.single) return formatString(strings.FormatSingle, codec);
    if (next.codec) return formatString(strings.FormatCompressedTar, codec);
    return strings.FormatTar;
  }

  function renderSummary(next: ArchiveSummary): void {
    if (summaryEl) {
      summaryEl.textContent = next.single
        ? formatString(strings.SummaryStream, formatLabel(next), formatBytes(file?.size ?? 0))
        : formatString(strings.SummaryLine, formatLabel(next), format(next.entries), format(next.files), format(next.dirs), formatBytes(next.totalSize));
    }
    notesEl?.replaceChildren();
    const note = (text: string, warning = false) => {
      const item = document.createElement("li");
      item.textContent = text;
      if (warning) item.classList.add("is-warning");
      notesEl?.append(item);
    };
    if (next.unsafe) note(formatString(strings.NoteUnsafe, format(next.unsafe)), true);
    if (next.overlap) note(formatString(strings.NoteOverlap, format(next.overlap)), true);
    if (next.suspicious) note(formatString(strings.NoteSuspicious, format(next.suspicious)), true);
    if (next.encrypted) note(formatString(strings.NoteEncrypted, format(next.encrypted)), true);
    if (next.unsupported) note(formatString(strings.NoteUnsupported, format(next.unsupported)), true);
    if (next.renamed) note(formatString(strings.NoteRenamed, format(next.renamed)));
    if (next.links) note(formatString(strings.NoteLinks, format(next.links)));
    if (next.zip64) note(strings.NoteZip64);
    if (next.comment.trim()) note(formatString(strings.NoteComment, next.comment.trim().slice(0, 500)));
  }

  function renderSelection(next: SelectionSummary): void {
    selectedFiles = next.selectedFiles;
    selectedName = next.firstFile;
    selectedTotal = next.selected;
    if (selectionEl) {
      selectionEl.textContent = next.selected === 0
        ? strings.SelectionNone
        : formatString(strings.SelectionLine, format(next.selectedFiles), formatBytes(next.selectedBytes), format(next.selected));
    }
    syncActions();
  }

  function rowNotes(row: ArchiveRow): string {
    const notes: string[] = [];
    if (row.issue) {
      const key = { absolute: "IssueAbsolute", traversal: "IssueTraversal", control: "IssueControl", "too-long": "IssueTooLong", empty: "IssueEmpty", renamed: "IssueRenamed" }[row.issue];
      notes.push(strings[key]);
    }
    if (row.kind === "symlink") notes.push(`${strings.KindSymlink} → ${row.link}`);
    else if (row.kind === "hardlink") notes.push(`${strings.KindHardlink} → ${row.link}`);
    else if (row.kind === "other") notes.push(strings.KindOther);
    if (row.encrypted) notes.push(strings.FlagEncrypted);
    if (row.unsupported) notes.push(strings.FlagUnsupported);
    if (row.overlap) notes.push(strings.FlagOverlap);
    return notes.join(" · ");
  }

  function rowClass(row: readonly string[]): string | undefined {
    const classes = [row[7] === "1" ? "ax-row-selected" : "", row[8] === "1" ? "ax-row-unsafe" : "", row[9] === "1" ? "ax-row-dir" : ""].filter(Boolean);
    return classes.length ? classes.join(" ") : undefined;
  }

  function renderTable(sessionId: number, count: number): void {
    table?.destroy();
    table = createExplorerTable({
      host: tableHost!,
      columns: [
        { key: "select", label: strings.ColumnSelect },
        { key: "name", label: strings.ColumnName },
        { key: "size", label: strings.ColumnSize },
        { key: "packed", label: strings.ColumnPacked },
        { key: "modified", label: strings.ColumnModified },
        { key: "method", label: strings.ColumnMethod },
        { key: "notes", label: strings.ColumnNotes },
      ],
      readRows: async (start, rowCount) => {
        const window = await api.rows(sessionId, start, rowCount);
        return window.map((row) => [
          row.selected ? "☑" : "☐",
          row.kind === "dir" ? `${row.name.replace(/\/$/u, "")}/` : row.name,
          row.kind === "dir" ? strings.KindDir : row.size >= 0 ? formatBytes(row.size) : strings.Unknown,
          row.packed >= 0 && row.kind === "file" ? formatBytes(row.packed) : "",
          Number.isFinite(row.mtime) ? dateFormat.format(row.mtime) : "",
          row.method >= 0 ? ZIP_METHOD_NAMES[row.method] ?? `#${row.method}` : "",
          rowNotes(row),
          row.selected ? "1" : "0",
          row.issue && row.issue !== "renamed" || row.overlap || row.encrypted ? "1" : "0",
          row.kind === "dir" ? "1" : "0",
        ]);
      },
      rowClass,
      onRowClick: (index) => void toggleRow(sessionId, index),
      onError(error) {
        if (errorCode(error) !== "aborted") showError(error);
      },
      emptyLabel: strings.TableEmpty,
      loadingLabel: strings.TableLoading,
      rowLabel: (index) => formatString(strings.RowLabel, format(index + 1)),
    });
    table.setRowCount(count);
    tableHost!.style.setProperty("--ds-explorer-template", "var(--ds-explorer-row-track) 3ch minmax(20rem, 1fr) 7rem 7rem 12rem 6.5rem minmax(14rem, 0.6fr)");
    tableHost!.style.setProperty("--ds-explorer-width", "calc(var(--ds-explorer-row-track) + 3ch + 20rem + 32.5rem + 14rem)");
  }

  async function toggleRow(sessionId: number, index: number): Promise<void> {
    if (busy || summary?.sessionId !== sessionId) return;
    try {
      renderSelection(await api.select(sessionId, "toggle", index));
      table?.refresh();
    } catch (error) {
      showError(error);
    }
  }

  async function selectAction(action: "all" | "none" | "filtered"): Promise<void> {
    if (busy || !summary) return;
    try {
      renderSelection(await api.select(summary.sessionId, action));
      table?.refresh();
    } catch (error) {
      showError(error);
    }
  }

  async function applyFilter(): Promise<void> {
    if (!summary) return;
    const sessionId = summary.sessionId;
    try {
      const count = await api.filter(sessionId, filterInput!.value);
      if (summary?.sessionId !== sessionId) return;
      renderTable(sessionId, count);
    } catch (error) {
      showError(error);
    }
  }

  function failReason(error: unknown): "invalid_input" | "processing_error" | "unsupported_format" {
    if (errorCode(error) === "unsupported-format") return "unsupported_format";
    return ["corrupt", "truncated", "too-many-entries", "overlap", "bomb", "size-mismatch", "checksum", "too-large"].includes(errorCode(error))
      ? "invalid_input" : "processing_error";
  }

  async function openArchive(next: File): Promise<void> {
    resetWorker();
    clearResult();
    hideError();
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    const operation = startToolOperation("archive-explorer");
    activeOperation = operation;
    setBusy(true, strings.StatusOpening);
    try {
      const opened = await api.open(next, controller.signal, (info) => { if (token === generation) updateProgress(info); });
      if (token !== generation) return;
      activeAbort = null;
      summary = opened;
      setBusy(false);
      loaded!.hidden = false;
      syncEmptyState(output!, false);
      renderSummary(opened);
      renderSelection({ selected: 0, selectedFiles: 0, selectedBytes: 0, firstFile: "" });
      renderTable(opened.sessionId, opened.entries);
      // A single compressed file is the only entry: select it so it can be saved at once.
      if (opened.single) await selectAction("all");
      showStatus(formatString(strings.StatusOpened, format(opened.entries)));
      operation.complete();
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        resetWorker();
        showStatus(strings.StatusCanceled);
        operation.cancel();
      } else {
        showError(error);
        operation.fail(failReason(error));
      }
    } finally {
      if (activeOperation === operation) activeOperation = null;
    }
  }

  function renderExtractResult(result: ExtractSummary): void {
    if (!extractResult) return;
    const skipped = result.skippedUnsafe + result.skippedLinks + result.skippedEncrypted + result.skippedUnsupported + result.failed;
    let text = formatString(strings.ExtractedLine, format(result.written), formatBytes(result.bytes), format(result.renamed));
    if (skipped) {
      text += ` ${formatString(strings.SkippedLine, format(result.skippedUnsafe), format(result.skippedLinks), format(result.skippedEncrypted + result.skippedUnsupported), format(result.failed))}`;
    }
    extractResult.textContent = text;
    extractResult.hidden = false;
  }

  async function runExtract(target: ExtractTarget): Promise<void> {
    if (busy || !summary || !file) return;
    const sessionId = summary.sessionId;
    let directory: FileSystemDirectoryHandle | undefined;
    if (target === "folder") {
      try {
        directory = await directoryPicker!({ mode: "readwrite", id: "archive-explorer" });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) showError(new Error("folder"));
        return;
      }
    }
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    if (extractResult) extractResult.hidden = true;
    setBusy(true, strings.StatusExtracting);
    try {
      let result: ExtractSummary;
      if (directory) {
        result = await api.extract(sessionId, target, { directory }, controller.signal, updateProgress);
      } else {
        const stem = file.name.replace(/\.(tar\.)?[^.]+$/u, "") || "archive";
        const saved = await saveWorkerStreamedFile({
          suggestedName: target === "file" ? selectedName || "file" : `${stem}-selected.zip`,
          mimeType: target === "file" ? "application/octet-stream" : "application/zip",
          extensions: target === "file" ? undefined : ["zip"],
          fallbackMaxBytes: FALLBACK_MAX_BYTES,
          signal: controller.signal,
        }, (stream, workerSignal) => api.extract(sessionId, target, { stream }, workerSignal, updateProgress));
        result = saved.value;
      }
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      renderExtractResult(result);
      showStatus(strings.StatusExtracted);
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        if (error instanceof StreamSaveError && !controller.signal.aborted) {
          showStatus(strings.StatusCanceled);
          return;
        }
        // Cancel terminated the worker; open the same archive again.
        if (file) void openArchive(file);
        showStatus(strings.StatusCanceled);
      } else {
        showError(error);
      }
    }
  }

  // ---------------------------------------------------------------- create

  function syncCreateLevel(): void {
    const [min, max, fallback] = CREATE_LEVELS[createFormat!.value as ArchiveCreateFormat];
    createLevel!.min = String(min);
    createLevel!.max = String(max);
    const value = Number(createLevel!.value);
    if (!Number.isFinite(value) || value < min || value > max) createLevel!.value = String(fallback);
    if (createLevelHint) {
      createLevelHint.textContent = min === max ? strings.LevelStore : `${min}–${max}${createFormat!.value === "zip" ? ` · 0 = ${strings.LevelStore}` : ""}`;
    }
    syncActions();
  }

  function renderCreateList(): void {
    if (!createList) return;
    const bytes = createFiles.reduce((sum, item) => sum + item.file.size, 0);
    createList.textContent = createFiles.length === 0 ? strings.CreateNone : formatString(strings.CreateFilesLine, format(createFiles.length), formatBytes(bytes));
    setDropzoneHasFile(createZone!, createFiles.length > 0);
    syncActions();
  }

  function addCreateFiles(files: readonly File[]): void {
    for (const item of files) createFiles.push({ file: item, path: item.webkitRelativePath || item.name });
    renderCreateList();
  }

  async function runCreate(): Promise<void> {
    if (busy || createFiles.length === 0) return;
    const formatValue = createFormat!.value as ArchiveCreateFormat;
    const [min, max, fallback] = CREATE_LEVELS[formatValue];
    const raw = Number(createLevel!.value);
    const level = Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.round(raw))) : fallback;
    const firstFolder = createFiles[0].path.includes("/") ? createFiles[0].path.split("/")[0] : "";
    const stem = firstFolder || (createFiles.length === 1 ? createFiles[0].file.name.replace(/\.[^.]+$/u, "") : "archive");
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    const operation = startToolOperation("archive-explorer");
    activeOperation = operation;
    setBusy(true, strings.StatusCreating);
    try {
      const saved = await saveWorkerStreamedFile({
        suggestedName: `${stem}.${formatValue}`,
        mimeType: formatValue === "zip" ? "application/zip" : formatValue === "tar" ? "application/x-tar" : formatValue === "tar.gz" ? "application/gzip" : "application/zstd",
        extensions: [formatValue.split(".").pop()!],
        fallbackMaxBytes: FALLBACK_MAX_BYTES,
        signal: controller.signal,
      }, (stream, workerSignal) => api.create(createFiles.map((item) => item.file), createFiles.map((item) => item.path), formatValue, level, stream, workerSignal, updateProgress));
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      const { entries, inputBytes, outputBytes } = saved.value;
      showStatus(`${strings.StatusCreated} ${formatString(strings.CreatedLine, format(entries), formatBytes(inputBytes), formatBytes(outputBytes))}`);
      operation.complete();
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        operation.cancel();
        if (!(error instanceof StreamSaveError && !controller.signal.aborted)) {
          // Cancel terminated the worker, which also dropped an opened archive.
          resetWorker();
          clearResult();
          if (file) void openArchive(file);
        }
        showStatus(strings.StatusCanceled);
      } else {
        showError(error);
        operation.fail(failReason(error));
      }
    } finally {
      if (activeOperation === operation) activeOperation = null;
    }
  }

  function chooseArchive(next: File | undefined): void {
    if (!next) return;
    if (busy) {
      activeOperation?.cancel();
      activeOperation = null;
    }
    file = next;
    setDropzoneHasFile(zone!, true);
    if (nameEl) {
      nameEl.textContent = `${next.name} · ${formatBytes(next.size)}`;
      nameEl.hidden = false;
    }
    void openArchive(next);
  }

  bindDropzone(zone, input, (files) => chooseArchive(files[0]));
  bindDropzone(createZone, createInput, (files) => addCreateFiles(files));
  createFolder?.addEventListener("change", () => {
    addCreateFiles([...(createFolder.files ?? [])]);
    createFolder.value = "";
  });
  clearButton?.addEventListener("click", () => {
    resetWorker();
    clearResult();
    file = null;
    input.value = "";
    setDropzoneHasFile(zone, false);
    if (nameEl) {
      nameEl.textContent = "";
      nameEl.hidden = true;
    }
    setBusy(false);
    hideError();
    showStatus(strings.StatusReady);
  });
  createClear?.addEventListener("click", () => {
    createFiles = [];
    createInput.value = "";
    renderCreateList();
  });
  cancelButton?.addEventListener("click", () => {
    if (!busy) return;
    activeOperation?.cancel();
    activeAbort?.abort();
  });
  filterInput.addEventListener("input", () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void applyFilter(), 200);
  });
  selectAll?.addEventListener("click", () => void selectAction("all"));
  selectFiltered?.addEventListener("click", () => void selectAction("filtered"));
  selectNone?.addEventListener("click", () => void selectAction("none"));
  extractFolder?.addEventListener("click", () => void runExtract("folder"));
  extractZip.addEventListener("click", () => void runExtract("zip"));
  extractFile.addEventListener("click", () => void runExtract("file"));
  createFormat.addEventListener("change", syncCreateLevel);
  createButton.addEventListener("click", () => void runCreate());
  syncCreateLevel();
  renderCreateList();
  showStatus(strings.StatusReady);
}

init();
