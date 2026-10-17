/**
 * Parquet explorer page controller: open a local file in a worker, then browse
 * a virtualized column projection. Schema, row groups and exports stay on this
 * device. File bytes and discovered schema are not written to storage.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { createExplorerTable, type ExplorerTable } from "@/scripts/explorer-table";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { saveWorkerStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { localizeResourceError } from "@/scripts/wasm/worker-protocol";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { PARQUET_INSPECT_CHARS, PARQUET_MAX_EXPORT_BYTES, PARQUET_PREVIEW_CHARS } from "@/tools/parquet-explorer";
import type { ParquetSessionSummary } from "@/tools/parquet-explorer-protocol";
import { createParquetExplorerWorker, type ParquetExplorerWorkerClient } from "@/tools/parquet-explorer-worker-client";

interface Strings {
  Lang: string;
  DropChange: string;
  ProgressBytes: string;
  ProgressRows: string;
  StatusOpening: string;
  StatusExporting: string;
  StatusReady: string;
  StatusDone: string;
  StatusCanceled: string;
  SummaryPattern: string;
  CreatedBy: string;
  DuplicateColumns: string;
  RowGroupsTruncated: string;
  MetadataTruncated: string;
  CodecUncompressed: string;
  NoColumns: string;
  TableEmpty: string;
  TableLoading: string;
  RowLabel: string;
  InspectorEmpty: string;
  InspectorRow: string;
  InspectorTruncated: string;
  RawWarning: string;
  ErrorEmpty: string;
  ErrorInvalid: string;
  ErrorTooManyColumns: string;
  ErrorExportTooLarge: string;
  ErrorCellTooLarge: string;
  ErrorCodec: string;
  ErrorWorker: string;
  ErrorSession: string;
  ErrorGeneric: string;
  ErrorSave: string;
  ErrorFallbackTooLarge: string;
  MemoryExhausted: string;
  InvalidFormat: string;
  CorruptInput: string;
  SchemaName: string;
  SchemaType: string;
  SchemaRepetition: string;
  SchemaCompression: string;
  GroupIndex: string;
  GroupRows: string;
  GroupBytes: string;
  GroupCompressed: string;
  GroupCodecs: string;
}

const ERROR_MESSAGES: Readonly<Record<string, true>> = {
  empty: true,
  invalid: true,
  "too-many-columns": true,
  "export-too-large": true,
  "cell-too-large": true,
  "unsupported-codec": true,
  "session-missing": true,
  aborted: true,
  "worker-failed": true,
  unknown: true,
};

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-parquet-strings]");
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-parquet-tool]");
  if (!root || root.dataset.initialized) return;
  const parsed = readStrings(root);
  if (!parsed) return;
  const strings: Strings = parsed;
  const zoneElement = root.querySelector<HTMLElement>("[data-parquet-dropzone]");
  const fileInputElement = root.querySelector<HTMLInputElement>("[data-parquet-file]");
  const clearButton = root.querySelector<HTMLButtonElement>("[data-parquet-clear]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-parquet-cancel]");
  const progressBlock = root.querySelector<HTMLElement>("[data-parquet-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-parquet-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-parquet-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-parquet-progress-label]");
  const status = root.querySelector<HTMLElement>("[data-parquet-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-parquet-error]");
  const outputElement = root.querySelector<HTMLElement>("[data-parquet-output]");
  const loadedElement = root.querySelector<HTMLElement>("[data-parquet-loaded]");
  const summaryEl = root.querySelector<HTMLElement>("[data-parquet-summary]");
  const createdBy = root.querySelector<HTMLElement>("[data-parquet-created-by]");
  const duplicateWarning = root.querySelector<HTMLElement>("[data-parquet-duplicates]");
  const schemaHostElement = root.querySelector<HTMLElement>("[data-parquet-schema]");
  const groupsHostElement = root.querySelector<HTMLElement>("[data-parquet-groups]");
  const groupsNote = root.querySelector<HTMLElement>("[data-parquet-groups-note]");
  const metadataHost = root.querySelector<HTMLElement>("[data-parquet-metadata]");
  const metadataNote = root.querySelector<HTMLElement>("[data-parquet-metadata-note]");
  const visibleColumnsElement = root.querySelector<HTMLElement>("[data-parquet-columns]");
  const selectAllButton = root.querySelector<HTMLButtonElement>("[data-parquet-columns-all]");
  const selectNoneButton = root.querySelector<HTMLButtonElement>("[data-parquet-columns-none]");
  const tableHostElement = root.querySelector<HTMLElement>("[data-parquet-table]");
  const inspectorEmpty = root.querySelector<HTMLElement>("[data-parquet-inspector-empty]");
  const inspectorRow = root.querySelector<HTMLElement>("[data-parquet-inspector-row]");
  const inspector = root.querySelector<HTMLDListElement>("[data-parquet-inspector]");
  const inspectorNote = root.querySelector<HTMLElement>("[data-parquet-inspector-note]");
  const exportFormat = root.querySelector<HTMLSelectElement>("[data-parquet-export-format]");
  const exportHeader = root.querySelector<HTMLInputElement>("[data-parquet-export-header]");
  const exportProtect = root.querySelector<HTMLInputElement>("[data-parquet-export-protect]");
  const exportBom = root.querySelector<HTMLInputElement>("[data-parquet-export-bom]");
  const rawWarning = root.querySelector<HTMLElement>("[data-parquet-raw-warning]");
  const downloadButton = root.querySelector<HTMLButtonElement>("[data-parquet-download]");
  if (!zoneElement || !fileInputElement || !clearButton || !outputElement || !loadedElement || !tableHostElement || !schemaHostElement || !groupsHostElement || !visibleColumnsElement) return;
  const zone = zoneElement;
  const fileInput = fileInputElement;
  const output = outputElement;
  const loaded = loadedElement;
  const tableHost = tableHostElement;
  const schemaHost = schemaHostElement;
  const groupsHost = groupsHostElement;
  const visibleColumns = visibleColumnsElement;
  root.dataset.initialized = "true";

  let api: ParquetExplorerWorkerClient = createParquetExplorerWorker();
  let summary: ParquetSessionSummary | null = null;
  let table: ExplorerTable | null = null;
  let busy = false;
  let generation = 0;
  let inspectGeneration = 0;
  let progressMode: "bytes" | "rows" = "bytes";
  let activeAbort: AbortController | null = null;
  let activeOperation: ToolOperation | null = null;
  const numberFormat = new Intl.NumberFormat(strings.Lang);

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
    if (typeof error === "object" && error !== null && "code" in error) {
      return String(error.code);
    }
    return "unknown";
  }

  function localizedError(error: unknown): string {
    switch (errorCode(error)) {
      case "empty": return strings.ErrorEmpty;
      case "invalid": return strings.ErrorInvalid;
      case "too-many-columns": return strings.ErrorTooManyColumns;
      case "export-too-large": return strings.ErrorExportTooLarge;
      case "cell-too-large": return strings.ErrorCellTooLarge;
      case "unsupported-codec": return strings.ErrorCodec;
      case "session-missing": return strings.ErrorSession;
      case "storage-failed": return strings.ErrorSave;
      case "fallback-too-large": return strings.ErrorFallbackTooLarge;
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

  function updateProgress(info: { processed: number; total: number; elapsedMs: number }): void {
    const percent = progressPercent(info.processed, info.total);
    if (progressFill) progressFill.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    if (!progressLabel) return;
    if (progressMode === "rows") {
      const perSecond = info.elapsedMs > 0 ? info.processed / (info.elapsedMs / 1000) : 0;
      progressLabel.textContent = formatString(
        strings.ProgressRows,
        numberFormat.format(info.processed),
        numberFormat.format(info.total),
        numberFormat.format(Math.round(perSecond)),
        formatMs(info.elapsedMs),
      );
      return;
    }
    const perSecond = info.elapsedMs > 0 ? info.processed / (info.elapsedMs / 1000) : 0;
    progressLabel.textContent = formatString(
      strings.ProgressBytes,
      formatBytes(info.processed),
      formatBytes(info.total),
      formatBytes(perSecond),
      formatMs(info.elapsedMs),
    );
  }

  function setBusy(next: boolean, message?: string): void {
    busy = next;
    if (progressBlock) progressBlock.hidden = !next;
    fileInput.disabled = next;
    zone.setAttribute("aria-disabled", next ? "true" : "false");
    if (next) {
      if (progressFill) progressFill.style.width = "0%";
      progressBar?.setAttribute("aria-valuenow", "0");
      if (progressLabel) progressLabel.textContent = "";
      if (message) showStatus(message);
    }
  }

  function codecLabel(codecs: readonly string[]): string {
    if (codecs.length === 0) return "—";
    return codecs.map((codec) => codec === "UNCOMPRESSED" ? strings.CodecUncompressed : codec).join(", ");
  }

  function selectedColumnIndexes(): number[] {
    return [...visibleColumns.querySelectorAll<HTMLInputElement>("input[data-column]:checked")]
      .map((input) => Number(input.dataset.column));
  }

  function renderMetaTable(host: HTMLElement, headers: readonly string[], rows: readonly (readonly string[])[]): void {
    const tableElement = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const header of headers) {
      const cell = document.createElement("th");
      cell.textContent = header;
      cell.scope = "col";
      headRow.append(cell);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const value of row) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.append(cell);
      }
      body.append(tr);
    }
    tableElement.append(head, body);
    host.replaceChildren(tableElement);
  }

  function renderColumns(): void {
    visibleColumns.replaceChildren();
    if (!summary) return;
    for (const column of summary.columns) {
      const label = document.createElement("label");
      label.className = "ds-check-row";
      const input = document.createElement("input");
      input.className = "ds-check";
      input.type = "checkbox";
      input.checked = true;
      input.dataset.column = String(column.index);
      const text = document.createElement("span");
      text.textContent = column.label;
      label.append(input, text);
      visibleColumns.append(label);
    }
  }

  function renderSummary(): void {
    if (!summary || !summaryEl) return;
    summaryEl.textContent = formatString(
      strings.SummaryPattern,
      summary.fileName || "parquet",
      numberFormat.format(summary.rows),
      numberFormat.format(summary.columns.length),
      numberFormat.format(summary.rowGroupCount),
      formatBytes(summary.fileSize),
    );
    if (createdBy) {
      createdBy.hidden = !summary.createdBy;
      createdBy.textContent = summary.createdBy ? formatString(strings.CreatedBy, summary.createdBy) : "";
    }
    if (duplicateWarning) {
      duplicateWarning.hidden = summary.duplicateColumnCount === 0;
      duplicateWarning.textContent = summary.duplicateColumnCount === 0
        ? ""
        : formatString(strings.DuplicateColumns, summary.duplicateColumnCount);
    }
    renderMetaTable(schemaHost, [strings.SchemaName, strings.SchemaType, strings.SchemaRepetition, strings.SchemaCompression], summary.columns.map((column) => [
      column.label,
      column.typeLabel,
      column.repetition,
      codecLabel(column.codecs),
    ]));
    renderMetaTable(groupsHost, [strings.GroupIndex, strings.GroupRows, strings.GroupBytes, strings.GroupCompressed, strings.GroupCodecs], summary.rowGroups.map((group) => [
      numberFormat.format(group.index),
      numberFormat.format(group.rows),
      formatBytes(group.byteSize),
      formatBytes(group.compressedSize),
      codecLabel(group.codecs),
    ]));
    if (groupsNote) {
      groupsNote.hidden = !summary.rowGroupsTruncated;
      groupsNote.textContent = summary.rowGroupsTruncated
        ? formatString(strings.RowGroupsTruncated, numberFormat.format(summary.rowGroups.length), numberFormat.format(summary.rowGroupCount))
        : "";
    }
    if (metadataHost) {
      metadataHost.replaceChildren();
      for (const pair of summary.metadata) {
        const term = document.createElement("dt");
        term.textContent = pair.key;
        const definition = document.createElement("dd");
        definition.textContent = pair.value;
        metadataHost.append(term, definition);
      }
      metadataHost.hidden = summary.metadata.length === 0;
    }
    if (metadataNote) metadataNote.hidden = !summary.metadataTruncated;
  }

  function resetInspector(): void {
    inspectGeneration++;
    if (inspector) {
      inspector.replaceChildren();
      inspector.hidden = true;
    }
    if (inspectorEmpty) inspectorEmpty.hidden = false;
    if (inspectorRow) inspectorRow.hidden = true;
    if (inspectorNote) inspectorNote.hidden = true;
  }

  function clearResultDom(): void {
    summary = null;
    table?.destroy();
    table = null;
    loaded.hidden = true;
    syncEmptyState(output, true);
    if (summaryEl) summaryEl.textContent = "";
    schemaHost.replaceChildren();
    groupsHost.replaceChildren();
    visibleColumns.replaceChildren();
    if (metadataHost) metadataHost.replaceChildren();
    resetInspector();
  }

  function createTable(): void {
    table?.destroy();
    if (!summary) return;
    const columns = selectedColumnIndexes();
    table = createExplorerTable({
      host: tableHost,
      columns: columns.map((index) => {
        const column = summary?.columns[index];
        return { key: String(index), label: column?.label ?? String(index) };
      }),
      readRows(start, count) {
        const current = summary;
        const selected = selectedColumnIndexes();
        if (!current || selected.length === 0) return Promise.resolve([]);
        return api.read(current.sessionId, start, count, selected, PARQUET_PREVIEW_CHARS);
      },
      onError(error) {
        if (errorCode(error) !== "aborted") showError(error);
      },
      emptyLabel: strings.TableEmpty,
      loadingLabel: strings.TableLoading,
      rowLabel: (index) => formatString(strings.RowLabel, numberFormat.format(index + 1)),
      onRowClick: (index) => void inspect(index),
    });
    table.setRowCount(columns.length === 0 ? 0 : summary.rows);
  }

  async function inspect(index: number): Promise<void> {
    if (!summary || !inspector) return;
    const token = ++inspectGeneration;
    const columns = summary.columns.map((column) => column.index);
    try {
      const values = await api.read(summary.sessionId, index, 1, columns, PARQUET_INSPECT_CHARS);
      if (token !== inspectGeneration || !summary) return;
      const row = values[0] ?? [];
      inspector.replaceChildren();
      let truncated = false;
      summary.columns.forEach((column, columnIndex) => {
        const term = document.createElement("dt");
        term.textContent = column.label;
        const definition = document.createElement("dd");
        const text = row[columnIndex] ?? "";
        definition.textContent = text;
        if (text.endsWith("…")) truncated = true;
        inspector.append(term, definition);
      });
      inspector.hidden = false;
      if (inspectorEmpty) inspectorEmpty.hidden = true;
      if (inspectorRow) {
        inspectorRow.textContent = formatString(strings.InspectorRow, numberFormat.format(index + 1));
        inspectorRow.hidden = false;
      }
      if (inspectorNote) inspectorNote.hidden = !truncated;
    } catch (error) {
      if (errorCode(error) !== "aborted") showError(error);
    }
  }

  function resetSession(readyMessage = strings.StatusReady): void {
    generation++;
    activeAbort?.abort();
    activeOperation = null;
    activeAbort = null;
    api.terminate();
    api = createParquetExplorerWorker();
    clearResultDom();
    setDropzoneHasFile(zone, false);
    setBusy(false);
    hideError();
    showStatus(readyMessage);
  }

  async function openFile(file: File, explicit = false): Promise<void> {
    const token = ++generation;
    activeAbort?.abort();
    api.terminate();
    api = createParquetExplorerWorker();
    clearResultDom();
    setDropzoneHasFile(zone, true);
    hideError();
    if (file.size === 0) {
      showError(new Error("empty"));
      return;
    }
    progressMode = "bytes";
    setBusy(true, strings.StatusOpening);
    const controller = new AbortController();
    activeAbort = controller;
    const operation = explicit ? startToolOperation("parquet-explorer") : null;
    activeOperation = operation;
    try {
      const result = await api.open(file, controller.signal, updateProgress);
      if (token !== generation) return;
      summary = result;
      activeAbort = null;
      loaded.hidden = false;
      syncEmptyState(output, false);
      renderColumns();
      renderSummary();
      createTable();
      setBusy(false);
      showStatus(strings.StatusDone);
      operation?.complete();
      if (activeOperation === operation) activeOperation = null;
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        resetSession(strings.StatusCanceled);
        return;
      }
      showError(error);
      const code = errorCode(error);
      operation?.fail(code === "worker-failed" || code === "unknown" ? "processing_error"
        : code === "unsupported-codec" ? "unsupported_format"
          : "invalid_input");
      if (activeOperation === operation) activeOperation = null;
    }
  }

  async function download(): Promise<void> {
    if (!summary || busy || !exportFormat || !exportHeader || !exportProtect || !exportBom) return;
    const columns = selectedColumnIndexes();
    if (columns.length === 0) {
      if (errorBox) {
        errorBox.textContent = strings.NoColumns;
        errorBox.hidden = false;
      }
      if (status) status.hidden = true;
      return;
    }
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    progressMode = "rows";
    setBusy(true, strings.StatusExporting);
    const format = exportFormat.value === "jsonl" ? "jsonl" : "csv";
    const stem = summary.fileName.replace(/\.[^.]+$/u, "") || "parquet";
    const sessionId = summary.sessionId;
    try {
      await saveWorkerStreamedFile({
        suggestedName: `${stem}.${format}`,
        mimeType: format === "csv" ? "text/csv;charset=utf-8" : "application/x-ndjson;charset=utf-8",
        extensions: [format],
        fallbackMaxBytes: PARQUET_MAX_EXPORT_BYTES,
        signal: controller.signal,
      }, (stream, workerSignal) => api.exportResult(sessionId, {
        format,
        columns,
        includeHeader: exportHeader.checked,
        protectFormulas: exportProtect.checked,
        bom: format === "csv" && exportBom.checked,
      }, stream, workerSignal, updateProgress));
      if (token !== generation || !summary) return;
      activeAbort = null;
      setBusy(false);
      showStatus(strings.StatusDone);
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        if (error instanceof StreamSaveError && !controller.signal.aborted) showStatus(strings.StatusCanceled);
        else resetSession(strings.StatusCanceled);
      } else {
        showError(error);
      }
    }
  }

  bindDropzone(zone, fileInput, (files) => void openFile(files[0], true));
  clearButton.addEventListener("click", () => resetSession());
  cancelButton?.addEventListener("click", () => {
    if (!busy) return;
    activeOperation?.cancel();
    activeAbort?.abort();
  });
  visibleColumns.addEventListener("change", () => {
    resetInspector();
    createTable();
  });
  selectAllButton?.addEventListener("click", () => {
    visibleColumns.querySelectorAll<HTMLInputElement>("input[data-column]").forEach((input) => { input.checked = true; });
    resetInspector();
    createTable();
  });
  selectNoneButton?.addEventListener("click", () => {
    visibleColumns.querySelectorAll<HTMLInputElement>("input[data-column]").forEach((input) => { input.checked = false; });
    resetInspector();
    createTable();
  });
  exportFormat?.addEventListener("change", () => {
    if (!exportHeader || !exportProtect || !exportBom) return;
    const csv = exportFormat.value !== "jsonl";
    exportHeader.disabled = !csv;
    exportProtect.disabled = !csv;
    exportBom.disabled = !csv;
    const bomRow = exportBom.closest<HTMLElement>("label");
    if (bomRow) bomRow.hidden = !csv;
    if (rawWarning) rawWarning.hidden = !csv || exportProtect.checked;
  });
  exportProtect?.addEventListener("change", () => {
    if (rawWarning) rawWarning.hidden = exportFormat?.value === "jsonl" || exportProtect.checked;
  });
  downloadButton?.addEventListener("click", () => void download());
  showStatus(strings.StatusReady);
}

init();
