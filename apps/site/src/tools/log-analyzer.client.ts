import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { createExplorerTable, type ExplorerColumn, type ExplorerTable } from "@/scripts/explorer-table";
import { saveWorkerStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { localizeResourceError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import {
  LOG_ANALYZER_LIMITS,
  LOG_SEVERITIES,
  type LogAnalysis,
  type LogFilter,
  type LogPreset,
  type LogSeverity,
} from "@/tools/log-analyzer";
import type { LogSessionSummary } from "@/tools/log-analyzer-protocol";
import { createLogAnalyzerWorker, type LogAnalyzerWorkerClient } from "@/tools/log-analyzer-worker-client";

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
  TimelineEmpty: string;
  TimelineBucket: string;
  ErrorsEmpty: string;
  MessagesEmpty: string;
  TableEmpty: string;
  TableLoading: string;
  RowLabel: string;
  InspectorEmpty: string;
  InspectorLine: string;
  InspectorTruncated: string;
  AggregateLimitWarning: string;
  ErrorEmpty: string;
  ErrorUtf8: string;
  ErrorLineTooLarge: string;
  ErrorRecordLimit: string;
  ErrorFilterTooLarge: string;
  ErrorWorker: string;
  ErrorSession: string;
  ErrorGeneric: string;
  ErrorSave: string;
  ErrorFallbackTooLarge: string;
  MemoryExhausted: string;
  InvalidFormat: string;
  CorruptInput: string;
  TableTime: string;
  TableSeverity: string;
  TableSource: string;
  TableCorrelation: string;
  TableMessage: string;
  SeverityTrace: string;
  SeverityDebug: string;
  SeverityInfo: string;
  SeverityWarn: string;
  SeverityError: string;
  SeverityFatal: string;
  SeverityUnknown: string;
  PresetSerilog: string;
  PresetNginxAccess: string;
  PresetNginxError: string;
  PresetJsonl: string;
  PresetText: string;
}

const KNOWN_ERROR_CODES: Readonly<Record<string, true>> = {
  empty: true,
  "invalid-utf8": true,
  "line-too-large": true,
  "record-limit": true,
  "filter-too-large": true,
  "session-missing": true,
};

const COLUMNS: readonly ExplorerColumn[] = [
  { key: "time", label: "" },
  { key: "severity", label: "" },
  { key: "source", label: "" },
  { key: "correlation", label: "" },
  { key: "message", label: "" },
];

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-log-strings]")
    ?? document.querySelector<HTMLScriptElement>("[data-log-strings]");
  if (!element) return null;
  try {
    return JSON.parse(element.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-log-tool]");
  if (!root || root.dataset.initialized) return;
  const parsedStrings = readStrings(root);
  if (!parsedStrings) return;

  const zoneElement = root.querySelector<HTMLElement>("[data-log-dropzone]");
  const fileInputElement = root.querySelector<HTMLInputElement>("[data-log-file]");
  const presetElement = root.querySelector<HTMLSelectElement>("[data-log-preset]");
  const clearButtonElement = root.querySelector<HTMLButtonElement>("[data-log-clear]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-log-cancel]");
  const progressBlock = root.querySelector<HTMLElement>("[data-log-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-log-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-log-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-log-progress-label]");
  const status = root.querySelector<HTMLElement>("[data-log-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-log-error]");
  const outputElement = root.querySelector<HTMLElement>("[data-log-output]");
  const loadedElement = root.querySelector<HTMLElement>("[data-log-loaded]");
  const summaryElement = root.querySelector<HTMLElement>("[data-log-summary]");
  const fromInput = root.querySelector<HTMLInputElement>("[data-log-from]");
  const toInput = root.querySelector<HTMLInputElement>("[data-log-to]");
  const sourceInput = root.querySelector<HTMLInputElement>("[data-log-source]");
  const correlationInput = root.querySelector<HTMLInputElement>("[data-log-correlation]");
  const searchInput = root.querySelector<HTMLInputElement>("[data-log-search]");
  const severityInputs = Array.from(root.querySelectorAll<HTMLInputElement>("[data-log-severity]"));
  const applyFilterButton = root.querySelector<HTMLButtonElement>("[data-log-apply-filter]");
  const clearFilterButton = root.querySelector<HTMLButtonElement>("[data-log-clear-filter]");
  const countsHost = root.querySelector<HTMLElement>("[data-log-counts]");
  const chartHost = root.querySelector<HTMLElement>("[data-log-chart]");
  const chartEmpty = root.querySelector<HTMLElement>("[data-log-chart-empty]");
  const errorsHost = root.querySelector<HTMLOListElement>("[data-log-errors]");
  const messagesHost = root.querySelector<HTMLOListElement>("[data-log-messages]");
  const aggregateWarning = root.querySelector<HTMLElement>("[data-log-aggregate-warning]");
  const tableHostElement = root.querySelector<HTMLElement>("[data-log-table]");
  const inspectorEmpty = root.querySelector<HTMLElement>("[data-log-inspector-empty]");
  const inspectorLine = root.querySelector<HTMLElement>("[data-log-inspector-line]");
  const inspector = root.querySelector<HTMLPreElement>("[data-log-inspector]");
  const inspectorNote = root.querySelector<HTMLElement>("[data-log-inspector-note]");
  const downloadButton = root.querySelector<HTMLButtonElement>("[data-log-download]");
  if (!zoneElement || !fileInputElement || !presetElement || !clearButtonElement || !outputElement || !loadedElement || !tableHostElement) return;
  const strings: Strings = parsedStrings;
  const zone = zoneElement;
  const fileInput = fileInputElement;
  const preset = presetElement;
  const clearButton = clearButtonElement;
  const output = outputElement;
  const loaded = loadedElement;
  const tableHost = tableHostElement;
  root.dataset.initialized = "true";

  let api: LogAnalyzerWorkerClient = createLogAnalyzerWorker();
  let currentFile: File | null = null;
  let summary: LogSessionSummary | null = null;
  let table: ExplorerTable | null = null;
  let activeAbort: AbortController | null = null;
  let activeOperation: ToolOperation | null = null;
  let generation = 0;
  let inspectGeneration = 0;
  let busy = false;
  const numberFormat = new Intl.NumberFormat(strings.Lang);
  const timeFormat = new Intl.DateTimeFormat(strings.Lang, { dateStyle: "short", timeStyle: "medium" });
  const severityLabels: Record<LogSeverity, string> = {
    trace: strings.SeverityTrace,
    debug: strings.SeverityDebug,
    info: strings.SeverityInfo,
    warn: strings.SeverityWarn,
    error: strings.SeverityError,
    fatal: strings.SeverityFatal,
    unknown: strings.SeverityUnknown,
  };
  COLUMNS[0].label = strings.TableTime;
  COLUMNS[1].label = strings.TableSeverity;
  COLUMNS[2].label = strings.TableSource;
  COLUMNS[3].label = strings.TableCorrelation;
  COLUMNS[4].label = strings.TableMessage;

  function showStatus(message: string): void {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function hideError(): void {
    if (errorBox) errorBox.hidden = true;
  }

  function errorCode(error: unknown): string {
    if (error instanceof Error && KNOWN_ERROR_CODES[error.message]) return error.message;
    if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
    return "unknown";
  }

  function localizedError(error: unknown): string {
    switch (errorCode(error)) {
      case "empty": return strings.ErrorEmpty;
      case "invalid-utf8": return strings.ErrorUtf8;
      case "line-too-large": return strings.ErrorLineTooLarge;
      case "record-limit": return strings.ErrorRecordLimit;
      case "filter-too-large": return strings.ErrorFilterTooLarge;
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
    const speed = info.elapsedMs > 0 ? info.processed / (info.elapsedMs / 1000) : 0;
    if (progressLabel) {
      progressLabel.textContent = formatString(
        strings.ProgressStats,
        formatBytes(info.processed),
        formatBytes(info.total),
        formatBytes(speed),
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
    if (applyFilterButton) applyFilterButton.disabled = next;
    if (clearFilterButton) clearFilterButton.disabled = next;
    if (downloadButton) downloadButton.disabled = next;
  }

  function presetLabel(value: string): string {
    switch (value) {
      case "serilog": return strings.PresetSerilog;
      case "nginx-access": return strings.PresetNginxAccess;
      case "nginx-error": return strings.PresetNginxError;
      case "jsonl": return strings.PresetJsonl;
      default: return strings.PresetText;
    }
  }

  function updateSummary(): void {
    if (!summary || !summaryElement) return;
    const details = formatString(
      strings.SummaryPattern,
      numberFormat.format(summary.rowCount),
      numberFormat.format(summary.analysis.malformedCount),
      formatBytes(summary.fileSize),
      presetLabel(summary.preset),
    );
    const filtered = summary.rowCount === summary.unfilteredRowCount
      ? ""
      : ` · ${formatString(strings.FilteredSummary, numberFormat.format(summary.rowCount), numberFormat.format(summary.unfilteredRowCount))}`;
    summaryElement.textContent = `${summary.fileName} · ${details}${filtered}`;
  }

  function renderRanking(host: HTMLOListElement | null, values: LogAnalysis["topMessages"], empty: string): void {
    if (!host) return;
    host.replaceChildren();
    if (values.length === 0) {
      const item = document.createElement("li");
      item.textContent = empty;
      host.append(item);
      return;
    }
    for (const value of values) {
      const item = document.createElement("li");
      const label = document.createElement("code");
      label.textContent = value.value;
      label.title = value.value;
      const count = document.createElement("strong");
      count.textContent = numberFormat.format(value.count);
      item.append(label, count);
      host.append(item);
    }
  }

  function renderAnalysis(analysis: LogAnalysis): void {
    if (countsHost) {
      countsHost.replaceChildren();
      for (const severity of LOG_SEVERITIES) {
        const card = document.createElement("div");
        card.className = "log-count";
        const label = document.createElement("span");
        label.className = "log-count-label";
        label.textContent = severityLabels[severity];
        const value = document.createElement("strong");
        value.className = "log-count-value";
        value.textContent = numberFormat.format(analysis.severityCounts[severity]);
        card.append(label, value);
        countsHost.append(card);
      }
    }
    if (chartHost) {
      chartHost.replaceChildren();
      const maximum = Math.max(0, ...analysis.temporal.map((bucket) => bucket.count));
      for (const bucket of analysis.temporal) {
        const label = formatString(
          strings.TimelineBucket,
          timeFormat.format(bucket.from),
          timeFormat.format(bucket.to),
          numberFormat.format(bucket.count),
        );
        const bar = document.createElement("span");
        bar.className = "log-bar";
        bar.setAttribute("role", "listitem");
        bar.setAttribute("aria-label", label);
        bar.title = label;
        bar.style.setProperty("--log-height", `${maximum > 0 ? Math.max(2, bucket.count / maximum * 100) : 2}%`);
        chartHost.append(bar);
      }
      chartHost.hidden = analysis.temporal.length === 0;
    }
    if (chartEmpty) chartEmpty.hidden = analysis.temporal.length > 0;
    renderRanking(errorsHost, analysis.errorTypes, strings.ErrorsEmpty);
    renderRanking(messagesHost, analysis.topMessages, strings.MessagesEmpty);
    if (aggregateWarning) aggregateWarning.hidden = !analysis.aggregateLimitReached;
  }

  function resetInspector(): void {
    inspectGeneration++;
    if (inspector) {
      inspector.textContent = "";
      inspector.hidden = true;
    }
    if (inspectorEmpty) inspectorEmpty.hidden = false;
    if (inspectorLine) inspectorLine.hidden = true;
    if (inspectorNote) inspectorNote.hidden = true;
  }

  function clearResultDom(): void {
    summary = null;
    table?.destroy();
    table = null;
    tableHost.replaceChildren();
    loaded.hidden = true;
    syncEmptyState(output, true);
    if (summaryElement) summaryElement.textContent = "";
    countsHost?.replaceChildren();
    chartHost?.replaceChildren();
    errorsHost?.replaceChildren();
    messagesHost?.replaceChildren();
    resetInspector();
  }

  async function inspect(index: number): Promise<void> {
    if (!summary || !inspector) return;
    const token = ++inspectGeneration;
    try {
      const result = await api.inspect(summary.sessionId, index);
      if (token !== inspectGeneration || !summary) return;
      inspector.textContent = result.raw;
      inspector.hidden = false;
      if (inspectorEmpty) inspectorEmpty.hidden = true;
      if (inspectorLine) {
        inspectorLine.textContent = formatString(strings.InspectorLine, numberFormat.format(result.line));
        inspectorLine.hidden = false;
      }
      if (inspectorNote) inspectorNote.hidden = !result.truncated;
    } catch (error) {
      if (errorCode(error) !== "aborted") invalidateResult(error);
    }
  }

  function createTable(): void {
    table?.destroy();
    if (!summary) return;
    table = createExplorerTable({
      host: tableHost,
      columns: COLUMNS,
      readRows(start, count) {
        const current = summary;
        if (!current) return Promise.resolve([]);
        return api.read(current.sessionId, start, count).then((records) => records.map((record) => [
          record.timestamp,
          severityLabels[record.severity],
          record.source,
          record.correlationId,
          record.message,
        ]));
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
    activeAbort = null;
    activeOperation = null;
    api.terminate();
    api = createLogAnalyzerWorker();
    currentFile = null;
    clearResultDom();
    setDropzoneHasFile(zone, false);
    setBusy(false);
    hideError();
    showStatus(readyMessage);
  }

  function invalidateResult(error: unknown): void {
    generation++;
    activeAbort = null;
    activeOperation = null;
    api.terminate();
    api = createLogAnalyzerWorker();
    clearResultDom();
    setBusy(false);
    showError(error);
  }

  async function openFile(file: File, explicit = false): Promise<void> {
    const token = ++generation;
    activeAbort?.abort();
    api.terminate();
    api = createLogAnalyzerWorker();
    clearResultDom();
    currentFile = file;
    setDropzoneHasFile(zone, true);
    hideError();
    setBusy(true, strings.StatusOpening);
    const controller = new AbortController();
    activeAbort = controller;
    const operation = explicit && file.size > 0 ? startToolOperation("log-analyzer") : null;
    activeOperation = operation;
    try {
      const result = await api.open(file, preset.value as LogPreset, controller.signal, updateProgress);
      if (token !== generation) return;
      summary = result;
      activeAbort = null;
      loaded.hidden = false;
      syncEmptyState(output, false);
      updateSummary();
      renderAnalysis(result.analysis);
      resetInspector();
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
        const code = errorCode(error);
        operation?.fail(
          code === "worker-failed" ? "wasm_unavailable"
            : code === "invalid-utf8" ? "unsupported_format"
              : code === "unknown" ? "processing_error" : "invalid_input",
        );
        if (activeOperation === operation) activeOperation = null;
      }
    }
  }

  function parseDate(input: HTMLInputElement | null): number | null {
    if (!input?.value) return null;
    const value = new Date(input.value).getTime();
    return Number.isFinite(value) ? value : Number.NaN;
  }

  function currentFilter(): LogFilter | null {
    const selected = severityInputs.filter((input) => input.checked).map((input) => input.value as LogSeverity);
    const severities = selected;
    const filter: LogFilter = {
      from: parseDate(fromInput),
      to: parseDate(toInput),
      severities,
      source: sourceInput?.value ?? "",
      correlationId: correlationInput?.value ?? "",
      search: searchInput?.value ?? "",
    };
    const empty = filter.from === null && filter.to === null && filter.severities.length === LOG_SEVERITIES.length
      && filter.source.length === 0 && filter.correlationId.length === 0 && filter.search.length === 0;
    return empty ? null : filter;
  }

  async function applyFilter(): Promise<void> {
    if (!summary || busy) return;
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    setBusy(true, strings.StatusFiltering);
    try {
      const result = await api.filter(summary.sessionId, currentFilter(), controller.signal, updateProgress);
      if (token !== generation || !summary) return;
      summary.rowCount = result.rowCount;
      summary.analysis = result.analysis;
      activeAbort = null;
      updateSummary();
      renderAnalysis(result.analysis);
      resetInspector();
      table?.setRowCount(result.rowCount);
      table?.refresh();
      setBusy(false);
      showStatus(strings.StatusDone);
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") resetSession(strings.StatusCanceled);
      else if (errorCode(error) === "filter-too-large" || Number.isNaN(parseDate(fromInput)) || Number.isNaN(parseDate(toInput))) showError({ code: "filter-too-large" });
      else invalidateResult(error);
    }
  }

  function clearFilters(): void {
    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";
    if (sourceInput) sourceInput.value = "";
    if (correlationInput) correlationInput.value = "";
    if (searchInput) searchInput.value = "";
    for (const input of severityInputs) input.checked = true;
    void applyFilter();
  }

  async function download(): Promise<void> {
    if (!summary || busy) return;
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    setBusy(true, strings.StatusExporting);
    const stem = summary.fileName.replace(/\.[^.]+$/u, "") || "log";
    const sessionId = summary.sessionId;
    try {
      await saveWorkerStreamedFile({
        suggestedName: `${stem}-filtered.log`,
        mimeType: "text/plain;charset=utf-8",
        extensions: ["log", "txt", "jsonl", "ndjson"],
        fallbackMaxBytes: LOG_ANALYZER_LIMITS.maxExportFallbackBytes,
        signal: controller.signal,
      }, (stream, workerSignal) => api.exportResult(sessionId, stream, workerSignal, updateProgress));
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
  preset.addEventListener("change", () => {
    if (currentFile) void openFile(currentFile);
  });
  applyFilterButton?.addEventListener("click", () => void applyFilter());
  clearFilterButton?.addEventListener("click", clearFilters);
  for (const input of [sourceInput, correlationInput, searchInput]) {
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void applyFilter();
    });
  }
  downloadButton?.addEventListener("click", () => void download());

  resetSession();
}

init();
