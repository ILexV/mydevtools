import { createExplorerTable, type ExplorerColumn } from "@/scripts/explorer-table";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { JSON_EXPLORER_LIMITS, type JsonExplorerDiagnostic, type JsonViewFilter, type TreeChild } from "@/tools/json-explorer-core";
import type { JsonInputFormat, JsonExportCursor, OpenJsonResult } from "@/tools/json-explorer-protocol";
import { createJsonExplorerWorkerClient, JsonExplorerClientError } from "@/tools/json-explorer-worker-client";

interface Strings {
  loadingRows: string; emptyRows: string; rowLabel: string; statusReady: string; statusOpening: string; statusFiltering: string;
  statusDone: string; statusCanceled: string; statusExporting: string; statusExported: string; stats: string; progressStats: string;
  selectedMeta: string; exportTooLarge: string; fileRequired: string; columnsTruncated: string; loadMore: string; processingFailed: string;
  errorInvalidJson: string; errorMalformedJsonl: string; errorEmptyJson: string; errorInvalidUtf8: string; errorDepthLimit: string;
  errorRecordLimit: string; errorOrdinaryLimit: string; errorFieldLimit: string; errorInvalidPath: string; errorSessionMissing: string;
  errorRowRange: string; errorTreeUnavailable: string;
}

class LocalizedUiError extends Error {}

const STORAGE = {
  format: "mdt.tools.json-explorer.format.v1",
  ordinary: "mdt.tools.json-explorer.ordinary-limit.v1",
  record: "mdt.tools.json-explorer.record-limit.v1",
  depth: "mdt.tools.json-explorer.depth-limit.v1",
} as const;

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([^}]+)\}/gu, (whole, key: string) => key in values ? String(values[key]) : whole);
}

function readStrings(root: HTMLElement): Strings | null {
  const island = document.querySelector<HTMLScriptElement>("[data-json-explorer-strings]");
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as Strings;
  } catch {
    root.dataset.initialized = "error";
    return null;
  }
}

function storageValue(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function saveStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* settings persistence is optional */ }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-json-explorer]");
  if (!root || root.dataset.initialized) return;
  const loadedStrings = readStrings(root);
  if (!loadedStrings) return;
  const strings: Strings = loadedStrings;
  root.dataset.initialized = "true";

  const find = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector);
  const required = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`JSON Explorer is missing required element: ${selector}`);
    return element;
  };
  const drop = required<HTMLElement>("[data-json-explorer-drop]");
  const fileInput = required<HTMLInputElement>("[data-json-explorer-file]");
  const fileName = find<HTMLElement>("[data-json-explorer-file-name]");
  const format = required<HTMLSelectElement>("[data-json-explorer-format]");
  const ordinaryLimit = required<HTMLSelectElement>("[data-json-explorer-ordinary-limit]");
  const recordLimit = required<HTMLSelectElement>("[data-json-explorer-record-limit]");
  const depthLimit = required<HTMLSelectElement>("[data-json-explorer-depth-limit]");
  const processButton = required<HTMLButtonElement>("[data-json-explorer-process]");
  const cancelButton = find<HTMLButtonElement>("[data-json-explorer-cancel]");
  const clearButton = find<HTMLButtonElement>("[data-json-explorer-clear]");
  const progress = find<HTMLElement>("[data-json-explorer-progress]");
  const progressBar = find<HTMLElement>("[data-json-explorer-progress-bar]");
  const progressFill = find<HTMLElement>("[data-json-explorer-progress-fill]");
  const progressLabel = find<HTMLElement>("[data-json-explorer-progress-label]");
  const errorBox = find<HTMLElement>("[data-json-explorer-error]");
  const statusBox = find<HTMLElement>("[data-json-explorer-status]");
  const output = required<HTMLElement>("[data-json-explorer-output]");
  const stats = find<HTMLElement>("[data-json-explorer-stats]");
  const tableHost = required<HTMLElement>("[data-json-explorer-table]");
  const search = find<HTMLInputElement>("[data-json-explorer-search]");
  const scope = find<HTMLSelectElement>("[data-json-explorer-scope]");
  const fieldPath = find<HTMLInputElement>("[data-json-explorer-field-path]");
  const fieldValue = find<HTMLInputElement>("[data-json-explorer-field-value]");
  const caseSensitive = find<HTMLInputElement>("[data-json-explorer-case]");
  const projection = find<HTMLTextAreaElement>("[data-json-explorer-projection]");
  const applyButton = find<HTMLButtonElement>("[data-json-explorer-apply]");
  const resetButton = find<HTMLButtonElement>("[data-json-explorer-reset]");
  const columnWarning = find<HTMLElement>("[data-json-explorer-column-warning]");
  const selectedEmpty = find<HTMLElement>("[data-json-explorer-selected-empty]");
  const selectedMeta = find<HTMLElement>("[data-json-explorer-selected-meta]");
  const selected = find<HTMLElement>("[data-json-explorer-selected]");
  const treeSection = find<HTMLElement>("[data-json-explorer-tree-section]");
  const treeEmpty = find<HTMLElement>("[data-json-explorer-tree-empty]");
  const treeHost = find<HTMLElement>("[data-json-explorer-tree]");
  const formulaProtection = find<HTMLInputElement>("[data-json-explorer-formula]");
  const exportJsonl = find<HTMLButtonElement>("[data-json-explorer-export-jsonl]");
  const exportCsv = find<HTMLButtonElement>("[data-json-explorer-export-csv]");

  for (const [select, key] of [[format, STORAGE.format], [ordinaryLimit, STORAGE.ordinary], [recordLimit, STORAGE.record], [depthLimit, STORAGE.depth]] as const) {
    const stored = storageValue(key);
    if (stored && [...select.options].some((option) => option.value === stored)) select.value = stored;
    select.addEventListener("change", () => saveStorage(key, select.value));
  }

  let file: File | null = null;
  let worker = createJsonExplorerWorkerClient();
  let generation = 0;
  let viewRevision = 0;
  let selectionRevision = 0;
  const treeLoads = new WeakSet<HTMLUListElement>();
  let ready = false;
  let busy = false;
  let sourceRows = 0;
  let viewRows = 0;
  let openedFormat: "json" | "jsonl" | null = null;
  let columns: ExplorerColumn[] = [];

  const table = createExplorerTable({
    host: tableHost,
    columns,
    emptyLabel: strings.emptyRows,
    loadingLabel: strings.loadingRows,
    rowLabel: (index) => formatTemplate(strings.rowLabel, { row: index + 1 }),
    onError: (error) => showError(error),
    readRows: async (start, count) => {
      if (!ready) return [];
      const runGeneration = generation;
      const result = await worker.readRows({ start, count });
      return runGeneration === generation ? result.rows : [];
    },
    onRowClick: (index) => void inspect(index),
  });

  function diagnosticMessage(diagnostic: JsonExplorerDiagnostic): string {
    const templates: Record<JsonExplorerDiagnostic["code"], string> = {
      "invalid-json": strings.errorInvalidJson,
      "malformed-jsonl": strings.errorMalformedJsonl,
      "empty-json": strings.errorEmptyJson,
      "invalid-utf8": strings.errorInvalidUtf8,
      "depth-limit": strings.errorDepthLimit,
      "record-limit": strings.errorRecordLimit,
      "ordinary-limit": strings.errorOrdinaryLimit,
      "field-limit": strings.errorFieldLimit,
      "invalid-path": strings.errorInvalidPath,
      "session-missing": strings.errorSessionMissing,
      "row-range": strings.errorRowRange,
      "tree-unavailable": strings.errorTreeUnavailable,
    };
    return formatTemplate(templates[diagnostic.code], {
      line: diagnostic.line ?? 1,
      column: diagnostic.column ?? 1,
      limit: humanBytes(diagnostic.limitBytes ?? 0),
      depth: diagnostic.maxDepth ?? JSON_EXPLORER_LIMITS.maxDepth,
      fields: diagnostic.maxFields ?? JSON_EXPLORER_LIMITS.detectedColumns,
      row: diagnostic.row ?? 1,
    });
  }

  function showError(error: unknown): void {
    let message: string;
    if (typeof error === "string") message = error;
    else if (error instanceof LocalizedUiError) message = error.message;
    else if (error instanceof JsonExplorerClientError) message = diagnosticMessage(error.diagnostic);
    else message = strings.processingFailed;
    showStatus("");
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
  }

  function clearError(): void {
    if (!errorBox) return;
    errorBox.textContent = "";
    errorBox.hidden = true;
  }

  function showStatus(message: string): void {
    if (!statusBox) return;
    statusBox.textContent = message;
    statusBox.hidden = !message;
  }

  function humanBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = bytes / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && value >= 1024; index++) {
      value /= 1024;
      unit = units[index];
    }
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
  }

  function setBusy(value: boolean): void {
    busy = value;
    processButton.disabled = value || !file;
    if (applyButton) applyButton.disabled = value || !ready;
    if (exportJsonl) exportJsonl.disabled = value || !ready;
    if (exportCsv) exportCsv.disabled = value || !ready;
    cancelButton?.toggleAttribute("hidden", !value);
    fileInput.disabled = value;
    drop.setAttribute("aria-disabled", String(value));
  }

  function updateProgress(processed: number, total: number, elapsedMs: number): void {
    if (!progress || !progressBar || !progressFill || !progressLabel) return;
    progress.hidden = false;
    const percent = total > 0 ? Math.min(100, processed / total * 100) : 0;
    progressFill.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
    const seconds = elapsedMs / 1000;
    const throughput = seconds > 0 ? processed / seconds : 0;
    const eta = throughput > 0 && total > processed ? (total - processed) / throughput : 0;
    progressLabel.textContent = formatTemplate(strings.progressStats, {
      processed: humanBytes(processed), total: humanBytes(total), elapsed: seconds.toFixed(1), throughput: `${humanBytes(throughput)}/s`, eta: eta.toFixed(1),
    });
  }

  function hideProgress(): void {
    if (progress) progress.hidden = true;
  }

  function clearInspector(): void {
    selectionRevision++;
    if (selected) { selected.textContent = ""; selected.hidden = true; }
    if (selectedMeta) { selectedMeta.textContent = ""; selectedMeta.hidden = true; }
    if (selectedEmpty) selectedEmpty.hidden = false;
  }

  function invalidateSession(message = ""): void {
    generation++;
    viewRevision++;
    worker.terminate();
    worker = createJsonExplorerWorkerClient();
    ready = false;
    openedFormat = null;
    sourceRows = 0;
    viewRows = 0;
    columns = [];
    table.setColumns([]);
    table.setRowCount(0);
    clearInspector();
    if (treeHost) treeHost.replaceChildren();
    if (treeSection) treeSection.hidden = true;
    if (output) syncEmptyState(output, true);
    hideProgress();
    setBusy(false);
    if (message) showStatus(message);
  }

  function updateResult(result: OpenJsonResult): void {
    sourceRows = result.sourceRows;
    viewRows = result.viewRows;
    openedFormat = result.format;
    columns = result.columns;
    table.setColumns(columns);
    table.setRowCount(viewRows);
    if (stats) stats.textContent = formatTemplate(strings.stats, {
      rows: new Intl.NumberFormat().format(sourceRows), results: new Intl.NumberFormat().format(viewRows), size: humanBytes(result.fileBytes), format: result.format.toUpperCase(),
    });
    if (columnWarning) {
      columnWarning.textContent = strings.columnsTruncated;
      columnWarning.hidden = !result.columnsTruncated;
    }
    syncEmptyState(output, false);
    clearInspector();
    if (treeSection) treeSection.hidden = result.format !== "json";
    if (result.format === "json" && treeHost) void renderTreeRoot();
  }

  async function openFile(): Promise<void> {
    if (!file || busy) {
      if (!file) showError(strings.fileRequired);
      return;
    }
    clearError();
    invalidateSession();
    const runGeneration = generation;
    setBusy(true);
    showStatus(strings.statusOpening);
    try {
      const result = await worker.open({
        file,
        format: format.value as JsonInputFormat,
        settings: {
          ordinaryJsonBytes: Number(ordinaryLimit.value), recordBytes: Number(recordLimit.value), maxDepth: Number(depthLimit.value),
        },
      }, { onProgress: ({ processed, total, elapsedMs }) => updateProgress(processed, total, elapsedMs) });
      if (runGeneration !== generation) return;
      ready = true;
      updateResult(result);
      showStatus(formatTemplate(strings.statusDone, { rows: new Intl.NumberFormat().format(result.sourceRows) }));
    } catch (error) {
      if (runGeneration !== generation) return;
      showError(error);
      invalidateSession();
    } finally {
      if (runGeneration === generation) {
        hideProgress();
        setBusy(false);
      }
    }
  }

  function currentFilter(): JsonViewFilter {
    return {
      query: search?.value ?? "",
      scope: (scope?.value as JsonViewFilter["scope"]) ?? "both",
      fieldPath: fieldPath?.value ?? "",
      fieldValue: fieldValue?.value ?? "",
      caseSensitive: caseSensitive?.checked ?? false,
    };
  }

  async function applyView(): Promise<void> {
    if (!ready || busy) return;
    clearError();
    const runGeneration = generation;
    viewRevision++;
    setBusy(true);
    table.setRowCount(0);
    clearInspector();
    showStatus(strings.statusFiltering);
    try {
      const result = await worker.applyView({
        filter: currentFilter(), projection: (projection?.value ?? "").split(/\r?\n/u),
      }, { onProgress: ({ processed, total, elapsedMs }) => updateProgress(processed, total, elapsedMs) });
      if (runGeneration !== generation) return;
      viewRows = result.viewRows;
      columns = result.columns;
      table.setColumns(columns);
      table.setRowCount(viewRows);
      if (stats && file && openedFormat) stats.textContent = formatTemplate(strings.stats, {
        rows: new Intl.NumberFormat().format(sourceRows), results: new Intl.NumberFormat().format(viewRows), size: humanBytes(file.size), format: openedFormat.toUpperCase(),
      });
      showStatus(formatTemplate(strings.statusDone, { rows: new Intl.NumberFormat().format(viewRows) }));
    } catch (error) {
      if (runGeneration !== generation) return;
      showError(error);
      if (!(error instanceof JsonExplorerClientError)) invalidateSession();
    } finally {
      if (runGeneration === generation) { hideProgress(); setBusy(false); }
    }
  }

  async function inspect(index: number): Promise<void> {
    if (!ready || busy) return;
    const runGeneration = generation;
    const runViewRevision = viewRevision;
    const runSelectionRevision = ++selectionRevision;
    try {
      const result = await worker.inspectRow({ index });
      if (runGeneration !== generation || runViewRevision !== viewRevision || runSelectionRevision !== selectionRevision) return;
      if (selected) { selected.textContent = result.json; selected.hidden = false; }
      if (selectedEmpty) selectedEmpty.hidden = true;
      if (selectedMeta) {
        selectedMeta.textContent = formatTemplate(strings.selectedMeta, { row: index + 1, source: result.sourceIndex + 1, line: result.physicalLine ?? "—" });
        selectedMeta.hidden = false;
      }
    } catch (error) {
      if (runGeneration === generation && runViewRevision === viewRevision && runSelectionRevision === selectionRevision) showError(error);
    }
  }

  function treeItem(child: TreeChild, runGeneration: number): HTMLLIElement {
    const item = document.createElement("li");
    const text = `${child.label}`;
    if (child.childCount === 0) {
      const row = document.createElement("div");
      row.textContent = text;
      const type = document.createElement("span");
      type.className = "json-tree-type";
      type.textContent = child.kind;
      const preview = document.createElement("span");
      preview.className = "json-tree-preview";
      preview.textContent = child.preview;
      row.append(type, preview);
      item.append(row);
      return item;
    }
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = text;
    const type = document.createElement("span");
    type.className = "json-tree-type";
    type.textContent = `${child.kind} (${child.childCount})`;
    summary.append(type);
    const list = document.createElement("ul");
    details.append(summary, list);
    details.addEventListener("toggle", () => {
      if (!details.open || details.dataset.loaded || details.dataset.loading) return;
      details.dataset.loading = "true";
      void loadTreePage(child.pointer, list, 0, runGeneration).then((loaded) => {
        if (loaded) details.dataset.loaded = "true";
      }).finally(() => delete details.dataset.loading);
    });
    item.append(details);
    return item;
  }

  async function loadTreePage(pointer: string, list: HTMLUListElement, start: number, runGeneration: number): Promise<boolean> {
    if (treeLoads.has(list)) return false;
    treeLoads.add(list);
    try {
      const result = await worker.readTree({ pointer, start, count: JSON_EXPLORER_LIMITS.treePageSize });
      if (runGeneration !== generation) return false;
      const oldMore = list.querySelector(":scope > li[data-tree-more]");
      oldMore?.remove();
      for (const child of result.children) list.append(treeItem(child, runGeneration));
      const next = start + result.children.length;
      if (next < result.total) {
        const holder = document.createElement("li");
        holder.dataset.treeMore = "";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ds-btn ds-btn-small";
        button.textContent = strings.loadMore;
        button.addEventListener("click", () => {
          if (button.disabled) return;
          button.disabled = true;
          void loadTreePage(pointer, list, next, runGeneration).then((loaded) => {
            if (!loaded && button.isConnected) button.disabled = false;
          });
        });
        holder.append(button);
        list.append(holder);
      }
      return true;
    } catch (error) {
      if (runGeneration === generation) showError(error);
      return false;
    } finally {
      treeLoads.delete(list);
    }
  }

  async function renderTreeRoot(): Promise<void> {
    if (!treeHost || !ready) return;
    const runGeneration = generation;
    treeHost.replaceChildren();
    const list = document.createElement("ul");
    treeHost.append(list);
    await loadTreePage("", list, 0, runGeneration);
    if (treeEmpty) treeEmpty.hidden = list.children.length > 0;
  }

  async function exportResult(kind: "jsonl" | "csv"): Promise<void> {
    if (!ready || busy) return;
    clearError();
    const runGeneration = generation;
    setBusy(true);
    showStatus(strings.statusExporting);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let exportedRows = 0;
    let cursor: JsonExportCursor | null = null;
    try {
      do {
        const result = await worker.exportChunk({
          format: kind, cursor, maxBytes: JSON_EXPLORER_LIMITS.exportChunkBytes, protectFormulas: formulaProtection?.checked ?? true,
        });
        if (runGeneration !== generation) return;
        total += result.bytes.byteLength;
        if (total > JSON_EXPLORER_LIMITS.exportBytes) throw new LocalizedUiError(strings.exportTooLarge);
        chunks.push(result.bytes);
        exportedRows += result.emittedRows;
        cursor = result.cursor;
        showStatus(formatTemplate(strings.statusExporting, { rows: new Intl.NumberFormat().format(exportedRows), size: humanBytes(total) }));
      } while (cursor);
      const blob = new Blob(chunks as unknown as BlobPart[], { type: kind === "csv" ? "text/csv;charset=utf-8" : "application/x-ndjson;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `json-explorer-filtered.${kind}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus(formatTemplate(strings.statusExported, { rows: new Intl.NumberFormat().format(exportedRows), size: humanBytes(total) }));
    } catch (error) {
      if (runGeneration === generation) {
        showError(error);
        if (!(error instanceof JsonExplorerClientError) && !(error instanceof LocalizedUiError)) invalidateSession();
      }
    } finally {
      if (runGeneration === generation) { hideProgress(); setBusy(false); }
    }
  }

  function chooseFile(files: File[]): void {
    const chosen = files[0];
    if (!chosen) return;
    file = chosen;
    if (fileName) { fileName.textContent = `${chosen.name} · ${humanBytes(chosen.size)}`; fileName.hidden = false; }
    setDropzoneHasFile(drop, true);
    processButton.disabled = false;
    clearError();
    showStatus(strings.statusReady);
    void openFile();
  }

  bindDropzone(drop, fileInput, chooseFile);
  processButton.addEventListener("click", () => void openFile());
  cancelButton?.addEventListener("click", () => invalidateSession(strings.statusCanceled));
  clearButton?.addEventListener("click", () => {
    invalidateSession();
    file = null;
    fileInput.value = "";
    if (fileName) { fileName.textContent = ""; fileName.hidden = true; }
    setDropzoneHasFile(drop, false);
    processButton.disabled = true;
    clearError();
    showStatus("");
  });
  applyButton?.addEventListener("click", () => void applyView());
  resetButton?.addEventListener("click", () => {
    if (search) search.value = "";
    if (scope) scope.value = "both";
    if (fieldPath) fieldPath.value = "";
    if (fieldValue) fieldValue.value = "";
    if (caseSensitive) caseSensitive.checked = false;
    if (projection) projection.value = "";
    void applyView();
  });
  for (const input of [search, fieldPath, fieldValue]) input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void applyView(); }
  });
  exportJsonl?.addEventListener("click", () => void exportResult("jsonl"));
  exportCsv?.addEventListener("click", () => void exportResult("csv"));
  showStatus("");
  setBusy(false);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
