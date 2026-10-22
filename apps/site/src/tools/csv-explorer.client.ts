import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { createExplorerTable, type ExplorerColumn, type ExplorerTable } from "@/scripts/explorer-table";
import { saveWorkerStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { localizeResourceError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { CSV_MAX_EXPORT_BYTES, type CsvFilter, type CsvFilterOperator } from "@/tools/csv-explorer";
import {
  CSV_EXPORT_MIME,
  decodeCsvConversionError,
  type CsvDelimiterOption,
  type CsvEncodingOption,
  type CsvExportFormat,
  type CsvExportSource,
  type CsvSessionSummary,
  type CsvSort,
  type CsvSortDirection,
} from "@/tools/csv-explorer-protocol";
import { CSV_COLUMN_TYPES, type CsvColumnType, type CsvGroupOrder, type CsvInvalidPolicy } from "@/tools/csv-explorer-types";
import { createCsvExplorerWorker, type CsvExplorerWorkerClient } from "@/tools/csv-explorer-worker-client";

interface Strings {
  Lang: string;
  DropChange: string;
  ProgressStats: string;
  StatusOpening: string;
  StatusFiltering: string;
  StatusExporting: string;
  StatusReady: string;
  StatusDone: string;
  StatusCanceled: string;
  SummaryPattern: string;
  FilteredSummary: string;
  HeaderWarning: string;
  NoColumns: string;
  TableEmpty: string;
  TableLoading: string;
  RowLabel: string;
  InspectorEmpty: string;
  InspectorRow: string;
  InspectorTruncated: string;
  RawWarning: string;
  ErrorEmpty: string;
  ErrorEncoding: string;
  ErrorMalformed: string;
  ErrorFieldTooLarge: string;
  ErrorRecordTooLarge: string;
  ErrorTooManyColumns: string;
  ErrorWorker: string;
  ErrorSession: string;
  ErrorGeneric: string;
  ErrorSave: string;
  ErrorFallbackTooLarge: string;
  MemoryExhausted: string;
  InvalidFormat: string;
  CorruptInput: string;
  DelimiterComma: string;
  DelimiterSemicolon: string;
  DelimiterTab: string;
  DelimiterPipe: string;
  SortNone: string;
  SortAsc: string;
  SortDesc: string;
  SortedSummary: string;
  StatusSorting: string;
  TypeText: string;
  TypeInteger: string;
  TypeNumber: string;
  TypeBoolean: string;
  StatusDetected: string;
  GroupNone: string;
  ValueNone: string;
  StatusGrouping: string;
  GroupSummary: string;
  NullValue: string;
  ErrorConversion: string;
  ErrorSortTooLarge: string;
  ErrorTooManyGroups: string;
  ErrorValueRange: string;
}

const CSV_ERROR_MESSAGES: Readonly<Record<string, true>> = {
  "field-too-large": true,
  "record-too-large": true,
  "too-many-columns": true,
  "invalid-encoding": true,
  "malformed-csv": true,
  "session-missing": true,
  "sort-too-large": true,
  "too-many-groups": true,
  "value-out-of-range": true,
};

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-csv-strings]")
    ?? document.querySelector<HTMLScriptElement>("[data-csv-strings]");
  if (!element) return null;
  try {
    return JSON.parse(element.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-csv-tool]");
  if (!root || root.dataset.initialized) return;
  const parsedStrings = readStrings(root);
  if (!parsedStrings) return;
  const strings: Strings = parsedStrings;

  const zoneElement = root.querySelector<HTMLElement>("[data-csv-dropzone]");
  const fileInputElement = root.querySelector<HTMLInputElement>("[data-csv-file]");
  const delimiterElement = root.querySelector<HTMLSelectElement>("[data-csv-delimiter]");
  const encodingElement = root.querySelector<HTMLSelectElement>("[data-csv-encoding]");
  const headerElement = root.querySelector<HTMLInputElement>("[data-csv-header]");
  const clearButtonElement = root.querySelector<HTMLButtonElement>("[data-csv-clear]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-csv-cancel]");
  const progressBlock = root.querySelector<HTMLElement>("[data-csv-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-csv-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-csv-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-csv-progress-label]");
  const status = root.querySelector<HTMLElement>("[data-csv-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-csv-error]");
  const outputElement = root.querySelector<HTMLElement>("[data-csv-output]");
  const loadedElement = root.querySelector<HTMLElement>("[data-csv-loaded]");
  const summaryElement = root.querySelector<HTMLElement>("[data-csv-summary]");
  const headerWarning = root.querySelector<HTMLElement>("[data-csv-header-warning]");
  const filterQuery = root.querySelector<HTMLInputElement>("[data-csv-filter-query]");
  const filterOperator = root.querySelector<HTMLSelectElement>("[data-csv-filter-operator]");
  const caseSensitive = root.querySelector<HTMLInputElement>("[data-csv-case-sensitive]");
  const filterColumns = root.querySelector<HTMLElement>("[data-csv-filter-columns]");
  const applyFilterButton = root.querySelector<HTMLButtonElement>("[data-csv-apply-filter]");
  const clearFilterButton = root.querySelector<HTMLButtonElement>("[data-csv-clear-filter]");
  const visibleColumns = root.querySelector<HTMLElement>("[data-csv-visible-columns]");
  const selectAllButton = root.querySelector<HTMLButtonElement>("[data-csv-columns-all]");
  const selectNoneButton = root.querySelector<HTMLButtonElement>("[data-csv-columns-none]");
  const tableHostElement = root.querySelector<HTMLElement>("[data-csv-table]");
  const inspectorEmpty = root.querySelector<HTMLElement>("[data-csv-inspector-empty]");
  const inspectorRow = root.querySelector<HTMLElement>("[data-csv-inspector-row]");
  const inspector = root.querySelector<HTMLDListElement>("[data-csv-inspector]");
  const inspectorNote = root.querySelector<HTMLElement>("[data-csv-inspector-note]");
  const exportFormat = root.querySelector<HTMLSelectElement>("[data-csv-export-format]");
  const exportHeader = root.querySelector<HTMLInputElement>("[data-csv-export-header]");
  const exportProtect = root.querySelector<HTMLInputElement>("[data-csv-export-protect]");
  const exportBom = root.querySelector<HTMLInputElement>("[data-csv-export-bom]");
  const rawWarning = root.querySelector<HTMLElement>("[data-csv-raw-warning]");
  const downloadButton = root.querySelector<HTMLButtonElement>("[data-csv-download]");
  const exportSource = root.querySelector<HTMLSelectElement>("[data-csv-export-source]");
  const typeList = root.querySelector<HTMLElement>("[data-csv-type-list]");
  const invalidPolicy = root.querySelector<HTMLSelectElement>("[data-csv-invalid]");
  const detectButton = root.querySelector<HTMLButtonElement>("[data-csv-detect-types]");
  const sortColumn = root.querySelector<HTMLSelectElement>("[data-csv-sort-column]");
  const sortDirection = root.querySelector<HTMLSelectElement>("[data-csv-sort-direction]");
  const applySortButton = root.querySelector<HTMLButtonElement>("[data-csv-apply-sort]");
  const groupColumn = root.querySelector<HTMLSelectElement>("[data-csv-group-column]");
  const valueColumn = root.querySelector<HTMLSelectElement>("[data-csv-value-column]");
  const groupOrder = root.querySelector<HTMLSelectElement>("[data-csv-group-order]");
  const applyGroupButton = root.querySelector<HTMLButtonElement>("[data-csv-apply-group]");
  const groupResult = root.querySelector<HTMLElement>("[data-csv-group-result]");
  const groupSummary = root.querySelector<HTMLElement>("[data-csv-group-summary]");
  const groupTableHost = root.querySelector<HTMLElement>("[data-csv-group-table]");
  if (!zoneElement || !fileInputElement || !delimiterElement || !encodingElement || !headerElement || !clearButtonElement || !outputElement || !loadedElement || !tableHostElement) return;
  const zone = zoneElement;
  const fileInput = fileInputElement;
  const delimiter = delimiterElement;
  const encoding = encodingElement;
  const header = headerElement;
  const clearButton = clearButtonElement;
  const output = outputElement;
  const loaded = loadedElement;
  const tableHost = tableHostElement;
  root.dataset.initialized = "true";

  let api: CsvExplorerWorkerClient = createCsvExplorerWorker();
  let currentFile: File | null = null;
  let summary: CsvSessionSummary | null = null;
  let table: ExplorerTable | null = null;
  let activeAbort: AbortController | null = null;
  let generation = 0;
  let inspectGeneration = 0;
  let busy = false;
  let activeOperation: ToolOperation | null = null;
  /** The sort the worker view currently has; re-applied after a filter or type change. */
  let activeSort: CsvSort | null = null;
  let groupTable: ExplorerTable | null = null;
  let columnTypes: CsvColumnType[] = [];

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
    if (error instanceof Error && CSV_ERROR_MESSAGES[error.message]) return error.message;
    if (error instanceof Error && decodeCsvConversionError(error.message)) return "conversion-failed";
    if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
    return "unknown";
  }

  function localizedError(error: unknown): string {
    switch (errorCode(error)) {
      case "invalid-encoding": return strings.ErrorEncoding;
      case "malformed-csv": return strings.ErrorMalformed;
      case "field-too-large": return strings.ErrorFieldTooLarge;
      case "record-too-large": return strings.ErrorRecordTooLarge;
      case "too-many-columns": return strings.ErrorTooManyColumns;
      case "session-missing": return strings.ErrorSession;
      case "sort-too-large": return strings.ErrorSortTooLarge;
      case "too-many-groups": return strings.ErrorTooManyGroups;
      case "value-out-of-range": return strings.ErrorValueRange;
      case "conversion-failed": {
        const detail = decodeCsvConversionError((error as Error).message)!;
        const column = summary?.columns[detail.column];
        return formatString(
          strings.ErrorConversion,
          detail.value,
          column?.label ?? String(detail.column + 1),
          numberFormat.format(detail.row + 1),
          typeLabel(columnTypes[detail.column] ?? "text"),
        );
      }
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

  /** Conversion and limit errors leave the file session usable. */
  function recoverable(error: unknown): boolean {
    const code = errorCode(error);
    return code === "conversion-failed" || code === "sort-too-large" || code === "too-many-groups" || code === "value-out-of-range";
  }

  function typeLabel(type: CsvColumnType): string {
    switch (type) {
      case "integer": return strings.TypeInteger;
      case "number": return strings.TypeNumber;
      case "boolean": return strings.TypeBoolean;
      default: return strings.TypeText;
    }
  }

  function showError(error: unknown): void {
    if (!errorBox) return;
    const message = localizedError(error);
    errorBox.textContent = message;
    errorBox.hidden = false;
    if (status) status.hidden = true;
  }

  function updateProgress(info: { processed: number; total: number; elapsedMs: number }): void {
    const percent = progressPercent(info.processed, info.total);
    if (progressFill) progressFill.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    const perSecond = info.elapsedMs > 0 ? info.processed / (info.elapsedMs / 1000) : 0;
    if (progressLabel) {
      progressLabel.textContent = formatString(
        strings.ProgressStats,
        formatBytes(info.processed),
        formatBytes(info.total),
        formatBytes(perSecond),
        formatMs(info.elapsedMs),
      );
    }
  }

  function setBusy(next: boolean, message?: string): void {
    busy = next;
    if (progressBlock) progressBlock.hidden = !next;
    if (next) {
      if (progressFill) progressFill.style.width = "0%";
      progressBar?.setAttribute("aria-valuenow", "0");
      if (progressLabel) progressLabel.textContent = "";
      if (message) showStatus(message);
    }
    for (const control of [applyFilterButton, clearFilterButton, applySortButton, applyGroupButton, detectButton, invalidPolicy]) {
      if (control) control.disabled = next;
    }
    typeList?.querySelectorAll<HTMLSelectElement>("select").forEach((select) => { select.disabled = next; });
    syncDownloadButton();
  }

  function exportingGroups(): boolean {
    return exportSource?.value === "groups";
  }

  function syncDownloadButton(): void {
    if (!downloadButton) return;
    downloadButton.disabled = busy || (!exportingGroups() && selectedColumnIndices().length === 0);
  }

  function delimiterLabel(value: string): string {
    if (value === ",") return strings.DelimiterComma;
    if (value === ";") return strings.DelimiterSemicolon;
    if (value === "\t") return strings.DelimiterTab;
    return strings.DelimiterPipe;
  }

  function selectedColumnIndices(): number[] {
    if (!visibleColumns) return [];
    return Array.from(visibleColumns.querySelectorAll<HTMLInputElement>("input[data-column]:checked"))
      .map((input) => Number(input.dataset.column));
  }

  function selectedFilterIndices(): number[] {
    if (!filterColumns) return [];
    return Array.from(filterColumns.querySelectorAll<HTMLInputElement>("input[data-column]:checked"))
      .map((input) => Number(input.dataset.column));
  }

  function renderColumnChecks(host: HTMLElement | null, prefix: string): void {
    if (!host) return;
    host.replaceChildren();
    if (!summary) return;
    for (const column of summary.columns) {
      const label = document.createElement("label");
      label.className = "ds-check-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "ds-check";
      input.checked = true;
      input.dataset.column = String(column.index);
      input.name = `${prefix}-${column.index}`;
      const text = document.createElement("span");
      text.textContent = column.label;
      label.append(input, text);
      host.append(label);
    }
  }

  function updateSummary(): void {
    if (!summary || !summaryElement) return;
    const details = formatString(
      strings.SummaryPattern,
      numberFormat.format(summary.rowCount),
      numberFormat.format(summary.columns.length),
      formatBytes(summary.fileSize),
      delimiterLabel(summary.delimiter),
      summary.encoding.toUpperCase(),
    );
    const filtered = summary.rowCount === summary.unfilteredRowCount
      ? ""
      : ` · ${formatString(strings.FilteredSummary, numberFormat.format(summary.rowCount), numberFormat.format(summary.unfilteredRowCount))}`;
    const sortedColumn = activeSort ? summary.columns[activeSort.column] : null;
    const sorted = activeSort && sortedColumn
      ? ` · ${formatString(strings.SortedSummary, sortedColumn.label, activeSort.direction === "desc" ? strings.SortDesc : strings.SortAsc)}`
      : "";
    summaryElement.textContent = `${summary.fileName} · ${details}${filtered}${sorted}`;
  }

  function tableColumns(indices: readonly number[]): ExplorerColumn[] {
    if (!summary) return [];
    return indices.map((index) => ({ key: summary!.columns[index].key, label: summary!.columns[index].label }));
  }

  function fillColumnSelect(select: HTMLSelectElement | null, noneLabel: string): void {
    if (!select) return;
    select.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = noneLabel;
    select.append(none);
    for (const column of summary?.columns ?? []) {
      const option = document.createElement("option");
      option.value = String(column.index);
      option.textContent = column.label;
      select.append(option);
    }
  }

  function renderTypeList(): void {
    if (!typeList) return;
    typeList.replaceChildren();
    for (const column of summary?.columns ?? []) {
      const row = document.createElement("label");
      row.className = "csv-type-row";
      const name = document.createElement("span");
      name.className = "csv-type-name";
      name.textContent = column.label;
      name.title = column.label;
      const select = document.createElement("select");
      select.className = "ds-field-select";
      select.dataset.column = String(column.index);
      select.name = `csv-type-${column.index}`;
      for (const type of CSV_COLUMN_TYPES) {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = typeLabel(type);
        select.append(option);
      }
      select.value = columnTypes[column.index] ?? "text";
      row.append(name, select);
      typeList.append(row);
    }
  }

  function renderAnalysisControls(): void {
    fillColumnSelect(sortColumn, strings.SortNone);
    fillColumnSelect(groupColumn, strings.GroupNone);
    fillColumnSelect(valueColumn, strings.ValueNone);
    renderTypeList();
  }

  function selectedColumn(select: HTMLSelectElement | null): number | null {
    return select && select.value !== "" ? Number(select.value) : null;
  }

  function clearGroupResult(): void {
    groupTable?.destroy();
    groupTable = null;
    groupTableHost?.replaceChildren();
    if (groupResult) groupResult.hidden = true;
    if (groupSummary) groupSummary.textContent = "";
    const option = exportSource?.querySelector<HTMLOptionElement>('option[value="groups"]');
    if (option) option.disabled = true;
    if (exportSource) exportSource.value = "rows";
    syncExportControls();
  }

  function syncProjection(): void {
    if (!summary || !table) return;
    const indices = selectedColumnIndices();
    syncDownloadButton();
    if (indices.length === 0) {
      table.setColumns([]);
      table.setRowCount(0);
      showError({ code: "no-columns" });
      if (errorBox) errorBox.textContent = strings.NoColumns;
      return;
    }
    hideError();
    table.setColumns(tableColumns(indices));
    table.setRowCount(summary.rowCount);
  }

  function resetInspector(): void {
    inspectGeneration++;
    inspector?.replaceChildren();
    if (inspector) inspector.hidden = true;
    if (inspectorEmpty) {
      inspectorEmpty.textContent = strings.InspectorEmpty;
      inspectorEmpty.hidden = false;
    }
    if (inspectorRow) inspectorRow.hidden = true;
    if (inspectorNote) inspectorNote.hidden = true;
  }

  function clearResultDom(): void {
    summary = null;
    activeSort = null;
    columnTypes = [];
    clearGroupResult();
    table?.destroy();
    table = null;
    tableHost.replaceChildren();
    loaded.hidden = true;
    syncEmptyState(output, true);
    renderColumnChecks(filterColumns, "csv-filter");
    renderColumnChecks(visibleColumns, "csv-visible");
    renderAnalysisControls();
    if (invalidPolicy) invalidPolicy.value = "error";
    if (filterQuery) filterQuery.value = "";
    if (summaryElement) summaryElement.textContent = "";
    if (headerWarning) {
      headerWarning.textContent = "";
      headerWarning.hidden = true;
    }
    resetInspector();
  }

  async function inspect(index: number): Promise<void> {
    if (!summary || !inspector) return;
    const token = ++inspectGeneration;
    try {
      const values = await api.inspect(summary.sessionId, index);
      if (token !== inspectGeneration || !summary) return;
      inspector.replaceChildren();
      for (let column = 0; column < summary.columns.length; column++) {
        const term = document.createElement("dt");
        term.textContent = summary.columns[column].label;
        const definition = document.createElement("dd");
        definition.textContent = values[column] ?? "";
        inspector.append(term, definition);
      }
      inspector.hidden = false;
      if (inspectorEmpty) inspectorEmpty.hidden = true;
      if (inspectorRow) {
        inspectorRow.textContent = formatString(strings.InspectorRow, numberFormat.format(index + 1));
        inspectorRow.hidden = false;
      }
      if (inspectorNote) inspectorNote.hidden = true;
    } catch (error) {
      if (errorCode(error) !== "aborted") invalidateResult(error);
    }
  }

  function createTable(): void {
    table?.destroy();
    if (!summary) return;
    table = createExplorerTable({
      host: tableHost,
      columns: tableColumns(selectedColumnIndices()),
      readRows(start, count) {
        const current = summary;
        const columns = selectedColumnIndices();
        if (!current || columns.length === 0) return Promise.resolve([]);
        return api.read(current.sessionId, start, count, columns);
      },
      onError(error) {
        if (errorCode(error) !== "aborted") invalidateResult(error);
      },
      emptyLabel: strings.TableEmpty,
      loadingLabel: strings.TableLoading,
      rowLabel: (index) => formatString(strings.RowLabel, numberFormat.format(index + 1)),
      onRowClick: (index) => void inspect(index),
    });
    table.setRowCount(summary.rowCount);
  }

  function resetSession(readyMessage = strings.StatusReady): void {
    generation++;
    activeAbort?.abort();
    activeOperation = null;
    activeAbort = null;
    api.terminate();
    api = createCsvExplorerWorker();
    currentFile = null;
    clearResultDom();
    setDropzoneHasFile(zone, false);
    setBusy(false);
    hideError();
    showStatus(readyMessage);
  }

  function invalidateResult(error: unknown): void {
    generation++;
    activeOperation = null;
    activeAbort = null;
    api.terminate();
    api = createCsvExplorerWorker();
    clearResultDom();
    setBusy(false);
    showError(error);
  }

  async function openFile(file: File, explicit = false): Promise<void> {
    const token = ++generation;
    activeAbort?.abort();
    api.terminate();
    api = createCsvExplorerWorker();
    clearResultDom();
    currentFile = file;
    setDropzoneHasFile(zone, true);
    hideError();
    setBusy(true, strings.StatusOpening);
    const controller = new AbortController();
    activeAbort = controller;
    const operation = explicit && file.size > 0 ? startToolOperation("csv-explorer") : null;
    activeOperation = operation;
    try {
      const result = await api.open(file, {
        delimiter: delimiter.value as CsvDelimiterOption,
        encoding: encoding.value as CsvEncodingOption,
        header: header.checked,
      }, controller.signal, updateProgress);
      if (token !== generation) return;
      summary = result;
      activeAbort = null;
      columnTypes = result.columns.map(() => "text");
      renderColumnChecks(filterColumns, "csv-filter");
      renderColumnChecks(visibleColumns, "csv-visible");
      renderAnalysisControls();
      loaded.hidden = false;
      syncEmptyState(output, false);
      if (headerWarning) {
        const adjusted = result.blankHeaderCount > 0 || result.duplicateHeaderCount > 0;
        headerWarning.textContent = adjusted
          ? formatString(strings.HeaderWarning, result.blankHeaderCount, result.duplicateHeaderCount)
          : "";
        headerWarning.hidden = !adjusted;
      }
      resetInspector();
      updateSummary();
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
      } else {
        invalidateResult(file.size === 0 ? { code: "empty" } : error);
        if (file.size === 0 && errorBox) errorBox.textContent = strings.ErrorEmpty;
        const code = errorCode(error);
        operation?.fail(
          code === "worker-failed" ? "wasm_unavailable"
            : code === "invalid-encoding" ? "unsupported_format"
              : code === "unknown" ? "processing_error" : "invalid_input",
        );
        if (activeOperation === operation) activeOperation = null;
      }
    }
  }

  async function applyFilter(): Promise<void> {
    if (!summary || busy || !filterQuery || !filterOperator) return;
    const columns = selectedFilterIndices();
    if (columns.length === 0) {
      showError({ code: "no-columns" });
      if (errorBox) errorBox.textContent = strings.NoColumns;
      return;
    }
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    setBusy(true, strings.StatusFiltering);
    const filter: CsvFilter | null = filterQuery.value.length === 0 ? null : {
      operator: filterOperator.value as CsvFilterOperator,
      query: filterQuery.value,
      columns,
      caseSensitive: caseSensitive?.checked ?? false,
    };
    try {
      const rowCount = await api.filter(summary.sessionId, filter, controller.signal, updateProgress);
      if (token !== generation || !summary) return;
      summary.rowCount = rowCount;
      clearGroupResult();
      if (activeSort) {
        const sort = activeSort;
        activeSort = null;
        showStatus(strings.StatusSorting);
        await api.sort(summary.sessionId, sort, controller.signal, updateProgress);
        if (token !== generation || !summary) return;
        activeSort = sort;
      }
      activeAbort = null;
      resetInspector();
      updateSummary();
      table?.setRowCount(selectedColumnIndices().length > 0 ? rowCount : 0);
      table?.refresh();
      setBusy(false);
      showStatus(strings.StatusDone);
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") resetSession(strings.StatusCanceled);
      else if (recoverable(error)) {
        refreshRows();
        showError(error);
      } else invalidateResult(error);
    }
  }

  function refreshRows(): void {
    resetInspector();
    updateSummary();
    table?.setRowCount(summary && selectedColumnIndices().length > 0 ? summary.rowCount : 0);
    table?.refresh();
  }

  /** Run one long session job with progress, cancel and the shared error handling. */
  async function runJob(message: string, job: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (!summary || busy) return;
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    setBusy(true, message);
    try {
      await job(controller.signal);
      if (token !== generation || !summary) return;
      activeAbort = null;
      setBusy(false);
      showStatus(strings.StatusDone);
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") resetSession(strings.StatusCanceled);
      else if (recoverable(error)) {
        refreshRows();
        showError(error);
      } else invalidateResult(error);
    }
  }

  function applySort(): Promise<void> {
    const column = selectedColumn(sortColumn);
    const sort: CsvSort | null = column === null ? null : { column, direction: (sortDirection?.value ?? "asc") as CsvSortDirection };
    return runJob(strings.StatusSorting, async (signal) => {
      const current = summary!;
      activeSort = null;
      await api.sort(current.sessionId, sort, signal, updateProgress);
      activeSort = sort;
      refreshRows();
    });
  }

  /** Types reset sort and group results in the worker; an active sort is rebuilt. */
  function applyTypes(): Promise<void> {
    return runJob(activeSort ? strings.StatusSorting : strings.StatusDone, async (signal) => {
      const current = summary!;
      await api.setTypes(current.sessionId, columnTypes, (invalidPolicy?.value ?? "error") as CsvInvalidPolicy);
      clearGroupResult();
      const sort = activeSort;
      activeSort = null;
      if (sort) {
        await api.sort(current.sessionId, sort, signal, updateProgress);
        activeSort = sort;
      }
      refreshRows();
    });
  }

  async function detectTypes(): Promise<void> {
    if (!summary || busy) return;
    try {
      columnTypes = await api.detectTypes(summary.sessionId);
      renderTypeList();
      await applyTypes();
      if (!errorBox || errorBox.hidden) showStatus(strings.StatusDetected);
    } catch (error) {
      if (errorCode(error) !== "aborted") invalidateResult(error);
    }
  }

  function applyGroup(): Promise<void> {
    return runJob(strings.StatusGrouping, async (signal) => {
      const current = summary!;
      clearGroupResult();
      const result = await api.aggregate(current.sessionId, {
        groupColumn: selectedColumn(groupColumn),
        valueColumn: selectedColumn(valueColumn),
        order: (groupOrder?.value ?? "key") as CsvGroupOrder,
      }, signal, updateProgress);
      if (!groupTableHost || !groupResult) return;
      groupResult.hidden = false;
      if (groupSummary) {
        groupSummary.textContent = formatString(strings.GroupSummary, numberFormat.format(result.groupCount), numberFormat.format(result.inputRows));
      }
      groupTable = createExplorerTable({
        host: groupTableHost,
        columns: result.columns.map((label, index) => ({ key: `g${index}`, label })),
        readRows: async (start, count) => {
          const rows = await api.readGroups(current.sessionId, start, count);
          return rows.map((row) => row.map((cell) => cell ?? strings.NullValue));
        },
        onError(error) {
          if (errorCode(error) !== "aborted") invalidateResult(error);
        },
        emptyLabel: strings.TableEmpty,
        loadingLabel: strings.TableLoading,
        rowLabel: (index) => formatString(strings.RowLabel, numberFormat.format(index + 1)),
      });
      groupTable.setRowCount(result.groupCount);
      const option = exportSource?.querySelector<HTMLOptionElement>('option[value="groups"]');
      if (option) option.disabled = false;
    });
  }

  function syncExportControls(): void {
    if (!exportFormat || !exportHeader || !exportProtect || !exportBom) return;
    const csv = exportFormat.value === "csv";
    exportHeader.disabled = !csv;
    exportProtect.disabled = !csv;
    exportBom.disabled = !csv;
    const bomRow = exportBom.closest<HTMLElement>("label");
    if (bomRow) bomRow.hidden = !csv;
    if (rawWarning) rawWarning.hidden = !csv || exportProtect.checked;
    syncDownloadButton();
  }

  async function download(): Promise<void> {
    if (!summary || busy || !exportFormat || !exportHeader || !exportProtect || !exportBom) return;
    const source: CsvExportSource = exportingGroups() ? "groups" : "rows";
    const columns = source === "groups" ? [] : selectedColumnIndices();
    if (source === "rows" && columns.length === 0) {
      showError({ code: "no-columns" });
      if (errorBox) errorBox.textContent = strings.NoColumns;
      return;
    }
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    setBusy(true, strings.StatusExporting);
    const format = exportFormat.value as CsvExportFormat;
    const stem = summary.fileName.replace(/\.[^.]+$/u, "") || "export";
    const sessionId = summary.sessionId;
    try {
      await saveWorkerStreamedFile({
        suggestedName: `${stem}-${source === "groups" ? "groups" : "filtered"}.${format}`,
        mimeType: CSV_EXPORT_MIME[format],
        extensions: [format],
        fallbackMaxBytes: CSV_MAX_EXPORT_BYTES,
        signal: controller.signal,
      }, (stream, workerSignal) => api.exportResult(sessionId, {
        format,
        source,
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
        if (recoverable(error)) refreshRows();
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
  for (const control of [delimiter, encoding, header]) {
    control.addEventListener("change", () => {
      if (currentFile) void openFile(currentFile);
    });
  }
  applyFilterButton?.addEventListener("click", () => void applyFilter());
  clearFilterButton?.addEventListener("click", () => {
    if (filterQuery) filterQuery.value = "";
    void applyFilter();
  });
  filterQuery?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void applyFilter();
  });
  visibleColumns?.addEventListener("change", syncProjection);
  selectAllButton?.addEventListener("click", () => {
    visibleColumns?.querySelectorAll<HTMLInputElement>("input[data-column]").forEach((input) => { input.checked = true; });
    syncProjection();
  });
  selectNoneButton?.addEventListener("click", () => {
    visibleColumns?.querySelectorAll<HTMLInputElement>("input[data-column]").forEach((input) => { input.checked = false; });
    syncProjection();
  });
  exportFormat?.addEventListener("change", syncExportControls);
  exportSource?.addEventListener("change", syncDownloadButton);
  applySortButton?.addEventListener("click", () => void applySort());
  applyGroupButton?.addEventListener("click", () => void applyGroup());
  detectButton?.addEventListener("click", () => void detectTypes());
  invalidPolicy?.addEventListener("change", () => void applyTypes());
  typeList?.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.dataset.column) return;
    columnTypes[Number(select.dataset.column)] = select.value as CsvColumnType;
    void applyTypes();
  });
  exportProtect?.addEventListener("change", () => {
    if (rawWarning) rawWarning.hidden = exportFormat?.value !== "csv" || exportProtect.checked;
  });
  downloadButton?.addEventListener("click", () => void download());

  resetSession();
}

init();
