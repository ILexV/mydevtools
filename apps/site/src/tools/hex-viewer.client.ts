/**
 * Hex viewer page controller. Visible rows come from File.slice on this
 * thread. Signature search and block entropy run in a worker. The file,
 * offsets and samples are not written to storage.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { createExplorerTable, type ExplorerTable } from "@/scripts/explorer-table";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import {
  HEX_BYTES_PER_ROW,
  HEX_MAX_MATCHES,
  HEX_PROBE_BYTES,
  describeProbe,
  formatHexBytes,
  formatHexRows,
  formatOffset,
  hexRowCount,
  offsetWidth,
  parseExportRange,
  parseNeedle,
  parseOffset,
} from "@/tools/hex-viewer";
import { createHexViewerWorker, type HexViewerWorkerClient } from "@/tools/hex-viewer-worker-client";

interface Strings {
  Lang: string;
  ProgressBytes: string;
  StatusOpening: string;
  StatusSearching: string;
  StatusEntropy: string;
  StatusReady: string;
  StatusDone: string;
  StatusOpenCanceled: string;
  StatusScanCanceled: string;
  StatusNoMatches: string;
  StatusMatches: string;
  StatusMatchesCapped: string;
  StatusJumped: string;
  StatusExported: string;
  SummaryPattern: string;
  HeaderBytes: string;
  KindText: string;
  KindUnknown: string;
  TableEmpty: string;
  TableLoading: string;
  RowLabel: string;
  ColumnOffset: string;
  ColumnHex: string;
  ColumnAscii: string;
  ColumnUtf8: string;
  EntropyAverage: string;
  EntropySampled: string;
  EntropyExact: string;
  ErrorEmpty: string;
  ErrorOffset: string;
  ErrorNeedle: string;
  ErrorNeedleLong: string;
  ErrorRange: string;
  ErrorRangeLarge: string;
  ErrorWorker: string;
  ErrorGeneric: string;
}

const ERROR_MESSAGES: Readonly<Record<string, true>> = {
  empty: true,
  "invalid-offset": true,
  "invalid-needle": true,
  "needle-too-long": true,
  "range-invalid": true,
  "range-too-large": true,
  aborted: true,
  "worker-failed": true,
  unknown: true,
};

interface OpenedFile {
  file: File;
  label: string;
  width: number;
}

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-hex-strings]");
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-hex-tool]");
  if (!root || root.dataset.initialized) return;
  const parsed = readStrings(root);
  if (!parsed) return;
  const strings: Strings = parsed;
  const zoneElement = root.querySelector<HTMLElement>("[data-hex-dropzone]");
  const fileInputElement = root.querySelector<HTMLInputElement>("[data-hex-file]");
  const clearButton = root.querySelector<HTMLButtonElement>("[data-hex-clear]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-hex-cancel]");
  const progressBlock = root.querySelector<HTMLElement>("[data-hex-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-hex-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-hex-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-hex-progress-label]");
  const status = root.querySelector<HTMLElement>("[data-hex-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-hex-error]");
  const outputElement = root.querySelector<HTMLElement>("[data-hex-output]");
  const loadedElement = root.querySelector<HTMLElement>("[data-hex-loaded]");
  const summaryEl = root.querySelector<HTMLElement>("[data-hex-summary]");
  const headerEl = root.querySelector<HTMLElement>("[data-hex-header]");
  const offsetInputElement = root.querySelector<HTMLInputElement>("[data-hex-offset]");
  const offsetButtonElement = root.querySelector<HTMLButtonElement>("[data-hex-goto]");
  const tableHostElement = root.querySelector<HTMLElement>("[data-hex-table]");
  const searchModeElement = root.querySelector<HTMLSelectElement>("[data-hex-search-mode]");
  const searchInputElement = root.querySelector<HTMLInputElement>("[data-hex-search]");
  const searchButtonElement = root.querySelector<HTMLButtonElement>("[data-hex-search-button]");
  const matchesHostElement = root.querySelector<HTMLElement>("[data-hex-matches]");
  const matchesNote = root.querySelector<HTMLElement>("[data-hex-matches-note]");
  const entropyButtonElement = root.querySelector<HTMLButtonElement>("[data-hex-entropy-button]");
  const entropyAverage = root.querySelector<HTMLElement>("[data-hex-entropy-average]");
  const entropyNote = root.querySelector<HTMLElement>("[data-hex-entropy-note]");
  const entropyBarsElement = root.querySelector<HTMLElement>("[data-hex-entropy]");
  const exportStartElement = root.querySelector<HTMLInputElement>("[data-hex-export-start]");
  const exportEndElement = root.querySelector<HTMLInputElement>("[data-hex-export-end]");
  const downloadButtonElement = root.querySelector<HTMLButtonElement>("[data-hex-download]");
  if (
    !zoneElement || !fileInputElement || !clearButton || !outputElement || !loadedElement
    || !offsetInputElement || !offsetButtonElement || !tableHostElement
    || !searchModeElement || !searchInputElement || !searchButtonElement || !matchesHostElement
    || !entropyButtonElement || !entropyBarsElement
    || !exportStartElement || !exportEndElement || !downloadButtonElement
  ) return;

  const zone = zoneElement;
  const fileInput = fileInputElement;
  const output = outputElement;
  const loaded = loadedElement;
  const offsetInput = offsetInputElement;
  const offsetButton = offsetButtonElement;
  const tableHost = tableHostElement;
  const searchMode = searchModeElement;
  const searchInput = searchInputElement;
  const searchButton = searchButtonElement;
  const matchesHost = matchesHostElement;
  const entropyButton = entropyButtonElement;
  const entropyBars = entropyBarsElement;
  const exportStart = exportStartElement;
  const exportEnd = exportEndElement;
  const downloadButton = downloadButtonElement;
  root.dataset.initialized = "true";

  let api: HexViewerWorkerClient = createHexViewerWorker();
  let current: OpenedFile | null = null;
  let table: ExplorerTable | null = null;
  let busy = false;
  let generation = 0;
  let activeAbort: AbortController | null = null;
  let activeOperation: ToolOperation | null = null;
  const numberFormat = new Intl.NumberFormat(strings.Lang);
  const entropyFormat = new Intl.NumberFormat(strings.Lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    if (typeof error === "object" && error !== null && "code" in error && ERROR_MESSAGES[String(error.code)]) {
      return String(error.code);
    }
    return "unknown";
  }

  function localizedError(error: unknown): string {
    switch (errorCode(error)) {
      case "empty": return strings.ErrorEmpty;
      case "invalid-offset": return strings.ErrorOffset;
      case "invalid-needle": return strings.ErrorNeedle;
      case "needle-too-long": return strings.ErrorNeedleLong;
      case "range-invalid": return strings.ErrorRange;
      case "range-too-large": return strings.ErrorRangeLarge;
      case "worker-failed":
      case "unknown": return strings.ErrorWorker;
      default: return strings.ErrorGeneric;
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
    const perSecond = info.elapsedMs > 0 ? info.processed / (info.elapsedMs / 1000) : 0;
    progressLabel.textContent = formatString(
      strings.ProgressBytes,
      formatBytes(info.processed),
      formatBytes(info.total),
      formatBytes(perSecond),
      formatMs(info.elapsedMs),
    );
  }

  function syncActions(): void {
    const enabled = current !== null && !busy;
    offsetInput.disabled = !enabled;
    offsetButton.disabled = !enabled;
    searchMode.disabled = !enabled;
    searchInput.disabled = !enabled;
    searchButton.disabled = !enabled;
    entropyButton.disabled = !enabled;
    exportStart.disabled = !enabled;
    exportEnd.disabled = !enabled;
    downloadButton.disabled = !enabled;
  }

  function setBusy(next: boolean, message?: string, showProgress = false): void {
    busy = next;
    if (progressBlock) progressBlock.hidden = !next || !showProgress;
    fileInput.disabled = next;
    zone.setAttribute("aria-disabled", next ? "true" : "false");
    if (next && showProgress) {
      if (progressFill) progressFill.style.width = "0%";
      progressBar?.setAttribute("aria-valuenow", "0");
      if (progressLabel) progressLabel.textContent = "";
    }
    if (message) showStatus(message);
    syncActions();
  }

  function clearScanResults(): void {
    matchesHost.replaceChildren();
    if (matchesNote) {
      matchesNote.textContent = "";
      matchesNote.hidden = true;
    }
    if (entropyAverage) {
      entropyAverage.textContent = "";
      entropyAverage.hidden = true;
    }
    if (entropyNote) {
      entropyNote.textContent = "";
      entropyNote.hidden = true;
    }
    entropyBars.replaceChildren();
    entropyBars.hidden = true;
  }

  function clearView(): void {
    current = null;
    table?.destroy();
    table = null;
    loaded.hidden = true;
    syncEmptyState(output, true);
    if (summaryEl) summaryEl.textContent = "";
    if (headerEl) headerEl.textContent = "";
    clearScanResults();
    exportStart.value = "";
    exportEnd.value = "";
    offsetInput.value = "";
  }

  function resetSession(message = strings.StatusReady): void {
    generation++;
    activeAbort?.abort();
    activeOperation = null;
    activeAbort = null;
    api.terminate();
    api = createHexViewerWorker();
    clearView();
    setDropzoneHasFile(zone, false);
    fileInput.value = "";
    setBusy(false);
    hideError();
    showStatus(message);
  }

  function renderSummary(opened: OpenedFile, header: Uint8Array): void {
    if (summaryEl) {
      summaryEl.textContent = formatString(
        strings.SummaryPattern,
        opened.file.name || "file",
        formatBytes(opened.file.size),
        opened.label,
        numberFormat.format(hexRowCount(opened.file.size)),
      );
    }
    if (headerEl) {
      const preview = header.length > HEX_BYTES_PER_ROW ? header.subarray(0, HEX_BYTES_PER_ROW) : header;
      headerEl.textContent = formatString(strings.HeaderBytes, formatHexBytes(preview).trimEnd());
    }
  }

  function createTable(opened: OpenedFile): void {
    table?.destroy();
    table = createExplorerTable({
      host: tableHost,
      columns: [
        { key: "offset", label: strings.ColumnOffset },
        { key: "hex", label: strings.ColumnHex },
        { key: "ascii", label: strings.ColumnAscii },
        { key: "utf8", label: strings.ColumnUtf8 },
      ],
      emptyLabel: strings.TableEmpty,
      loadingLabel: strings.TableLoading,
      rowLabel: (index) => formatString(strings.RowLabel, formatOffset(index * HEX_BYTES_PER_ROW, opened.width)),
      async readRows(start, count) {
        const byteStart = start * HEX_BYTES_PER_ROW;
        const byteEnd = Math.min(opened.file.size, (start + count) * HEX_BYTES_PER_ROW);
        if (byteEnd <= byteStart) return [];
        const bytes = new Uint8Array(await opened.file.slice(byteStart, byteEnd).arrayBuffer());
        return formatHexRows(bytes, start, opened.file.size);
      },
      onError(error) {
        showError(error);
      },
    });
    // The shared table sizes every column equally. A 16-byte hex row needs the wide track.
    tableHost.style.setProperty(
      "--ds-explorer-template",
      "4.5rem minmax(7.5rem, 0.7fr) minmax(26rem, 2.6fr) minmax(9.5rem, 1fr) minmax(9.5rem, 1.2fr)",
    );
    tableHost.style.setProperty("--ds-explorer-width", "58rem");
    table.setRowCount(hexRowCount(opened.file.size));
  }

  function jumpToOffset(offset: number): void {
    if (!current || !table) return;
    table.scrollToRow(Math.floor(offset / HEX_BYTES_PER_ROW));
    showStatus(formatString(strings.StatusJumped, formatOffset(offset, current.width)));
  }

  function jump(): void {
    if (!current || busy) return;
    try {
      const offset = parseOffset(offsetInput.value, current.file.size);
      hideError();
      jumpToOffset(offset);
    } catch (error) {
      showError(error);
    }
  }

  async function openFile(file: File, explicit = false): Promise<void> {
    const token = ++generation;
    activeAbort?.abort();
    api.terminate();
    api = createHexViewerWorker();
    clearView();
    setDropzoneHasFile(zone, true);
    hideError();
    if (file.size === 0) {
      setBusy(false);
      showError(new Error("empty"));
      return;
    }
    setBusy(true, strings.StatusOpening, false);
    const controller = new AbortController();
    activeAbort = controller;
    const operation = explicit ? startToolOperation("hex-viewer") : null;
    activeOperation = operation;
    try {
      const probe = new Uint8Array(await file.slice(0, HEX_PROBE_BYTES).arrayBuffer());
      if (token !== generation) return;
      if (controller.signal.aborted) {
        resetSession(strings.StatusOpenCanceled);
        return;
      }
      const described = describeProbe(probe);
      const opened: OpenedFile = {
        file,
        label: described.label ?? (described.kind === "text" ? strings.KindText : strings.KindUnknown),
        width: offsetWidth(file.size),
      };
      current = opened;
      loaded.hidden = false;
      syncEmptyState(output, false);
      renderSummary(opened, probe);
      createTable(opened);
      exportStart.value = "0";
      exportEnd.value = String(Math.min(file.size - 1, 4095));
      activeAbort = null;
      setBusy(false);
      showStatus(strings.StatusDone);
      operation?.complete();
      if (activeOperation === operation) activeOperation = null;
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") {
        resetSession(strings.StatusOpenCanceled);
        return;
      }
      showError(error);
      const code = errorCode(error);
      operation?.fail(code === "worker-failed" || code === "unknown" ? "processing_error" : "invalid_input");
      if (activeOperation === operation) activeOperation = null;
    }
  }

  async function runSearch(): Promise<void> {
    if (!current || busy) return;
    const opened = current;
    let needle: Uint8Array;
    try {
      needle = parseNeedle(searchInput.value, searchMode.value === "hex" ? "hex" : "text");
    } catch (error) {
      showError(error);
      return;
    }
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    clearScanResults();
    setBusy(true, strings.StatusSearching, true);
    try {
      const result = await api.search(opened.file, needle, controller.signal, updateProgress);
      if (token !== generation) return;
      activeAbort = null;
      matchesHost.replaceChildren();
      for (const offset of result.offsets) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ds-btn ds-btn-small ds-btn-ghost hx-match";
        button.textContent = formatOffset(offset, opened.width);
        button.addEventListener("click", () => {
          hideError();
          jumpToOffset(offset);
        });
        matchesHost.append(button);
      }
      const matchStatus = result.offsets.length === 0
        ? strings.StatusNoMatches
        : result.capped
          ? formatString(strings.StatusMatchesCapped, numberFormat.format(result.offsets.length), numberFormat.format(HEX_MAX_MATCHES))
          : formatString(strings.StatusMatches, numberFormat.format(result.offsets.length));
      if (matchesNote) {
        matchesNote.hidden = false;
        matchesNote.textContent = matchStatus;
      }
      setBusy(false);
      showStatus(matchStatus);
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") showStatus(strings.StatusScanCanceled);
      else showError(error);
    }
  }

  async function runEntropy(): Promise<void> {
    if (!current || busy) return;
    const opened = current;
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    hideError();
    setBusy(true, strings.StatusEntropy, true);
    try {
      const result = await api.entropy(opened.file, controller.signal, updateProgress);
      if (token !== generation) return;
      activeAbort = null;
      entropyBars.replaceChildren();
      for (const sample of result.samples) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "hx-entropy-bar";
        const ratio = Math.max(0, Math.min(1, sample.entropy / 8));
        button.style.height = `${Math.max(8, ratio * 100)}%`;
        const label = `${formatOffset(sample.start, opened.width)} · ${entropyFormat.format(sample.entropy)}`;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", () => {
          hideError();
          jumpToOffset(sample.start);
        });
        entropyBars.append(button);
      }
      entropyBars.hidden = result.samples.length === 0;
      if (entropyAverage) {
        entropyAverage.hidden = false;
        entropyAverage.textContent = formatString(strings.EntropyAverage, entropyFormat.format(result.average));
      }
      if (entropyNote) {
        entropyNote.hidden = false;
        entropyNote.textContent = result.sampled ? strings.EntropySampled : strings.EntropyExact;
      }
      setBusy(false);
      showStatus(formatString(strings.EntropyAverage, entropyFormat.format(result.average)));
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      setBusy(false);
      if (errorCode(error) === "aborted") showStatus(strings.StatusScanCanceled);
      else showError(error);
    }
  }

  function downloadRange(): void {
    if (!current || busy) return;
    try {
      const range = parseExportRange(exportStart.value, exportEnd.value, current.file.size);
      hideError();
      const blob = current.file.slice(range.start, range.end + 1, "application/octet-stream");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stem = current.file.name.replace(/\.[^.]+$/u, "") || "bytes";
      link.href = url;
      link.download = `${stem}-${range.start.toString(16)}-${range.end.toString(16)}.bin`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus(strings.StatusExported);
    } catch (error) {
      showError(error);
    }
  }

  bindDropzone(zone, fileInput, (files) => void openFile(files[0], true));
  clearButton.addEventListener("click", () => resetSession());
  cancelButton?.addEventListener("click", () => {
    if (!busy) return;
    activeOperation?.cancel();
    activeAbort?.abort();
  });
  offsetButton.addEventListener("click", jump);
  offsetInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jump();
    }
  });
  searchButton.addEventListener("click", () => void runSearch());
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runSearch();
    }
  });
  entropyButton.addEventListener("click", () => void runEntropy());
  downloadButton.addEventListener("click", downloadRange);
  syncActions();
  showStatus(strings.StatusReady);
}

init();
