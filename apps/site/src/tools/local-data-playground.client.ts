import { formatBytes, formatMs, formatString } from "@/lib/format";
import { createExplorerTable, type ExplorerTable } from "@/scripts/explorer-table";
import { loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { saveStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import {
  createLocalDataEngine,
  DATA_ENGINE_LIMITS,
  quoteIdentifier,
  type DataEncoding,
  type DataFormat,
  type EngineProgress,
  type LocalDataEngine,
  type QuerySummary,
  type TableInfo,
} from "@/tools/data-engine";

interface Strings {
  Lang: string;
  Phrases?: Record<string, string>;
  EditorLabel: string;
  StatusReady: string;
  StatusLoadingEngine: string;
  StatusImporting: string;
  StatusImported: string;
  StatusRunning: string;
  StatusComplete: string;
  StatusCanceled: string;
  StatusRestarted: string;
  StatusExporting: string;
  StatusExported: string;
  ProgressPattern: string;
  TableSummary: string;
  ResultSummary: string;
  ResultTruncated: string;
  TableEmpty: string;
  TableLoading: string;
  RowLabel: string;
  NoTables: string;
  RemoveTable: string;
  ErrorFile: string;
  ErrorFormat: string;
  ErrorTableName: string;
  ErrorImport: string;
  ErrorJson: string;
  ErrorSql: string;
  ErrorRestricted: string;
  ErrorMemory: string;
  ErrorExport: string;
  ErrorCanceled: string;
  ErrorGeneric: string;
  ExampleSelect: string;
  ExampleWhere: string;
  ExampleGroup: string;
  ExampleJoin: string;
}

const MIME_BY_FORMAT: Record<string, string> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
  jsonl: "application/x-ndjson;charset=utf-8",
  parquet: "application/vnd.apache.parquet",
};

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-local-data-strings]");
  if (!element?.textContent) return null;
  try { return JSON.parse(element.textContent) as Strings; } catch { return null; }
}

function inferredFormat(file: File): DataFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv";
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "jsonl";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".parquet")) return "parquet";
  return null;
}

function tableNameFromFile(file: File): string {
  const withoutExtension = file.name.replace(/\.(?:csv|tsv|json|jsonl|ndjson|parquet)$/i, "");
  const normalized = withoutExtension.normalize("NFKC").replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
  return (normalized || "data").slice(0, 128);
}

function init(): void {
  const rootElement = document.querySelector<HTMLElement>("[data-local-data-tool]");
  if (!rootElement || rootElement.dataset.initialized === "true") return;
  const root = rootElement;
  const parsedStrings = readStrings(root);
  if (!parsedStrings) return;
  const strings: Strings = parsedStrings;
  root.dataset.initialized = "true";
  const fileInput = root.querySelector<HTMLInputElement>("[data-local-data-file]")!;
  const dropzone = root.querySelector<HTMLElement>("[data-local-data-dropzone]")!;
  const tableNameInput = root.querySelector<HTMLInputElement>("[data-local-data-table-name]")!;
  const formatSelect = root.querySelector<HTMLSelectElement>("[data-local-data-format]")!;
  const delimiterSelect = root.querySelector<HTMLSelectElement>("[data-local-data-delimiter]");
  const encodingSelect = root.querySelector<HTMLSelectElement>("[data-local-data-encoding]");
  const headerInput = root.querySelector<HTMLInputElement>("[data-local-data-header]");
  const importButton = root.querySelector<HTMLButtonElement>("[data-local-data-import]")!;
  const restartButton = root.querySelector<HTMLButtonElement>("[data-local-data-restart]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-local-data-cancel]");
  const progress = root.querySelector<HTMLElement>("[data-local-data-progress]");
  const progressLabel = root.querySelector<HTMLElement>("[data-local-data-progress-label]");
  const status = root.querySelector<HTMLElement>("[data-local-data-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-local-data-error]");
  const tablesList = root.querySelector<HTMLUListElement>("[data-local-data-tables]")!;
  const tablesEmpty = root.querySelector<HTMLElement>("[data-local-data-tables-empty]");
  const editorHost = root.querySelector<HTMLElement>("[data-local-data-editor]")!;
  const runButton = root.querySelector<HTMLButtonElement>("[data-local-data-run]")!;
  const output = root.querySelector<HTMLElement>("[data-local-data-output]")!;
  const results = root.querySelector<HTMLElement>("[data-local-data-results]")!;
  const summaryElement = root.querySelector<HTMLElement>("[data-local-data-summary]");
  const tableHost = root.querySelector<HTMLElement>("[data-local-data-table]")!;
  const exportFormat = root.querySelector<HTMLSelectElement>("[data-local-data-export-format]");
  const exportDelimiter = root.querySelector<HTMLSelectElement>("[data-local-data-export-delimiter]");
  const exportHeader = root.querySelector<HTMLInputElement>("[data-local-data-export-header]");
  const exportButton = root.querySelector<HTMLButtonElement>("[data-local-data-export]");

  const numberFormat = new Intl.NumberFormat(strings.Lang);
  const tables = new Map<string, TableInfo>();
  let selectedFile: File | null = null;
  let editor: MdtEditor | null = null;
  let engine: LocalDataEngine;
  let table: ExplorerTable | null = null;
  let query: QuerySummary | null = null;
  let activeAbort: AbortController | null = null;
  let busy = false;

  function showStatus(message: string): void {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function showError(message: string): void {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
    if (status) status.hidden = true;
  }

  function clearError(): void {
    if (errorBox) errorBox.hidden = true;
  }

  function localizedError(error: unknown, fallback: string): string {
    if (error instanceof StreamSaveError && error.code === "aborted") return strings.ErrorCanceled;
    if (error instanceof DOMException && error.name === "AbortError") return strings.ErrorCanceled;
    const message = error instanceof Error ? error.message : String(error);
    if (/unsupported-format/.test(message)) return strings.ErrorFormat;
    if (/invalid-table-name|Catalog Error.*Table/.test(message)) return strings.ErrorTableName;
    if (/json-tabular-unsupported/.test(message)) return strings.ErrorJson;
    if (/select-only|single-statement|external-access-blocked/.test(message)) return strings.ErrorRestricted;
    if (/Out of Memory|memory|file-too-large|transcode-too-large|row-count-too-large/i.test(message)) return strings.ErrorMemory;
    if (/Parser Error|Binder Error|Catalog Error|Invalid Input Error|Conversion Error/.test(message)) return `${strings.ErrorSql} ${message}`;
    return fallback;
  }

  function setBusy(next: boolean, label = ""): void {
    busy = next;
    if (progress) progress.hidden = !next;
    fileInput.disabled = next;
    importButton.disabled = next || !selectedFile;
    runButton.disabled = next || tables.size === 0 || !editor?.getValue().trim();
    if (restartButton) restartButton.disabled = next;
    if (exportButton) exportButton.disabled = next || !query;
    if (progressLabel) progressLabel.textContent = label;
  }

  function updateProgress(info: EngineProgress): void {
    if (!progressLabel) return;
    const processed = info.total ? `${numberFormat.format(info.processed)} / ${numberFormat.format(info.total)}` : numberFormat.format(info.processed);
    progressLabel.textContent = formatString(strings.ProgressPattern, processed, formatMs(info.elapsedMs));
  }

  function resetResult(): void {
    query = null;
    table?.destroy();
    table = null;
    results.hidden = true;
    syncEmptyState(output, true);
    if (summaryElement) summaryElement.textContent = "";
    if (exportButton) exportButton.disabled = true;
  }

  function syncCsvOptions(): void {
    const selected = formatSelect.value === "auto" ? (selectedFile ? inferredFormat(selectedFile) : null) : formatSelect.value;
    const csv = selected === "csv";
    for (const element of root.querySelectorAll<HTMLElement>("[data-local-data-csv-option]")) element.hidden = !csv;
  }

  function syncExportOptions(): void {
    const csv = exportFormat?.value === "csv";
    for (const element of root.querySelectorAll<HTMLElement>("[data-local-data-export-csv]")) element.hidden = !csv;
  }

  function renderTables(): void {
    tablesList.replaceChildren();
    for (const info of tables.values()) {
      const item = document.createElement("li");
      const description = document.createElement("div");
      const name = document.createElement("code");
      name.textContent = info.name;
      const detail = document.createElement("small");
      detail.textContent = formatString(strings.TableSummary, numberFormat.format(info.rowCount), numberFormat.format(info.columns.length), formatBytes(info.fileSize));
      description.append(name, detail);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ds-btn ds-btn-small ds-btn-ghost";
      remove.textContent = "×";
      remove.setAttribute("aria-label", formatString(strings.RemoveTable, info.name));
      remove.addEventListener("click", () => {
        void engine.dropTable(info.name).then(() => {
          tables.delete(info.name);
          renderTables();
          resetResult();
          if (tables.size === 0) editor?.setValue("");
        }).catch((error: unknown) => showError(localizedError(error, strings.ErrorGeneric)));
      });
      item.append(description, remove);
      tablesList.append(item);
    }
    if (tablesEmpty) tablesEmpty.hidden = tables.size !== 0;
    runButton.disabled = busy || tables.size === 0 || !editor?.getValue().trim();
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-local-data-example]")) {
      button.disabled = tables.size < (button.dataset.localDataExample === "join" ? 2 : 1);
    }
  }

  engine = createLocalDataEngine({
    onWasmLoad(load) {
      showStatus(strings.StatusLoadingEngine);
      if (progressLabel && load.total > 0) progressLabel.textContent = `${formatBytes(load.loaded)} / ${formatBytes(load.total)}`;
    },
  });

  function chooseFile(file: File): void {
    selectedFile = file;
    tableNameInput.value = tableNameFromFile(file);
    if (delimiterSelect) delimiterSelect.value = file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    setDropzoneHasFile(dropzone, true);
    importButton.disabled = busy;
    clearError();
    syncCsvOptions();
  }

  bindDropzone(dropzone, fileInput, (files) => {
    const file = files[0];
    if (file) chooseFile(file);
  });

  async function importFile(): Promise<void> {
    if (!selectedFile || busy) return;
    const name = tableNameInput.value.trim();
    if (!name) { showError(strings.ErrorTableName); return; }
    const selectedFormat = formatSelect.value === "auto" ? inferredFormat(selectedFile) : formatSelect.value as DataFormat;
    if (!selectedFormat) { showError(strings.ErrorFormat); return; }
    activeAbort = new AbortController();
    clearError();
    setBusy(true, strings.StatusImporting);
    showStatus(strings.StatusImporting);
    try {
      const info = await engine.loadTable(selectedFile, {
        tableName: name,
        format: selectedFormat,
        csv: selectedFormat === "csv" ? {
          delimiter: (delimiterSelect?.value || ",") as "," | ";" | "\t" | "|",
          header: headerInput?.checked ?? true,
          encoding: (encodingSelect?.value || "utf-8") as DataEncoding,
        } : undefined,
      }, activeAbort.signal, updateProgress);
      tables.set(info.name, info);
      renderTables();
      editor?.setValue(`SELECT *\nFROM ${quoteIdentifier(info.name)}\nLIMIT 100;`);
      showStatus(formatString(strings.StatusImported, info.name));
      selectedFile = null;
      fileInput.value = "";
      setDropzoneHasFile(dropzone, false);
      importButton.disabled = true;
    } catch (error) {
      if (activeAbort.signal.aborted) showStatus(strings.StatusCanceled);
      else showError(localizedError(error, strings.ErrorImport));
    } finally {
      activeAbort = null;
      setBusy(false);
    }
  }

  function insertExample(kind: string): void {
    const imported = [...tables.values()];
    const first = imported[0];
    if (!first || !editor) return;
    const tableName = quoteIdentifier(first.name);
    const column = quoteIdentifier(first.columns[0]?.name || "column0");
    let sql = `SELECT *\nFROM ${tableName}\nLIMIT 100;`;
    if (kind === "where") sql = `SELECT *\nFROM ${tableName}\nWHERE ${column} IS NOT NULL\nLIMIT 100;`;
    if (kind === "group") sql = `SELECT ${column}, COUNT(*) AS row_count\nFROM ${tableName}\nGROUP BY ${column}\nORDER BY row_count DESC\nLIMIT 100;`;
    if (kind === "join" && imported[1]) {
      const second = imported[1];
      const rightColumn = quoteIdentifier(second.columns[0]?.name || "column0");
      sql = `SELECT a.*, b.*\nFROM ${tableName} AS a\nJOIN ${quoteIdentifier(second.name)} AS b\n  ON a.${column} = b.${rightColumn}\nLIMIT 100;`;
    }
    editor.setValue(sql);
    editor.focus();
  }

  async function runQuery(): Promise<void> {
    if (!editor || busy || tables.size === 0) return;
    const sql = editor.getValue().trim();
    if (!sql) { showError(strings.ErrorSql); return; }
    activeAbort = new AbortController();
    clearError();
    resetResult();
    setBusy(true, strings.StatusRunning);
    showStatus(strings.StatusRunning);
    try {
      query = await engine.query(sql, { maxRows: DATA_ENGINE_LIMITS.defaultQueryRows }, activeAbort.signal, updateProgress);
      table = createExplorerTable({
        host: tableHost,
        columns: query.columns.map((column) => ({ key: column.name, label: `${column.name} · ${column.type}` })),
        readRows: async (start, count) => (await engine.getPage(query!.id, { offset: start, limit: count })).rows.map((row) => row.map((cell) => cell ?? "NULL")),
        onError: (error) => showError(localizedError(error, strings.ErrorGeneric)),
        emptyLabel: strings.TableEmpty,
        loadingLabel: strings.TableLoading,
        rowLabel: (index) => formatString(strings.RowLabel, numberFormat.format(index + 1)),
      });
      table.setRowCount(query.rowCount);
      results.hidden = false;
      syncEmptyState(output, false);
      if (summaryElement) {
        const base = formatString(strings.ResultSummary, numberFormat.format(query.rowCount), numberFormat.format(query.columns.length), formatMs(query.elapsedMs));
        summaryElement.textContent = query.truncated ? `${base} ${formatString(strings.ResultTruncated, numberFormat.format(query.maxRows ?? query.rowCount))}` : base;
      }
      showStatus(strings.StatusComplete);
    } catch (error) {
      if (activeAbort.signal.aborted) showStatus(strings.StatusCanceled);
      else showError(localizedError(error, strings.ErrorSql));
    } finally {
      activeAbort = null;
      setBusy(false);
    }
  }

  async function exportQuery(): Promise<void> {
    if (!query || busy || !exportFormat) return;
    activeAbort = new AbortController();
    const format = exportFormat.value as "csv" | "json" | "jsonl" | "parquet";
    clearError();
    setBusy(true, strings.StatusExporting);
    showStatus(strings.StatusExporting);
    try {
      const result = await saveStreamedFile({
        suggestedName: `query-result.${format}`,
        mimeType: MIME_BY_FORMAT[format],
        extensions: [format],
        fallbackMaxBytes: format === "parquet" ? DATA_ENGINE_LIMITS.maxParquetExportBytes : DATA_ENGINE_LIMITS.maxTextExportBytes,
        signal: activeAbort.signal,
      }, (sink) => engine.exportResult(query!.id, {
        format,
        delimiter: (exportDelimiter?.value || ",") as "," | ";" | "\t" | "|",
        header: exportHeader?.checked ?? true,
        sink,
      }, activeAbort!.signal, updateProgress));
      showStatus(formatString(strings.StatusExported, formatBytes(result.bytesWritten)));
    } catch (error) {
      if (activeAbort.signal.aborted || (error instanceof StreamSaveError && error.code === "aborted")) showStatus(strings.StatusCanceled);
      else showError(localizedError(error, strings.ErrorExport));
    } finally {
      activeAbort = null;
      setBusy(false);
    }
  }

  async function restart(): Promise<void> {
    if (busy) return;
    clearError();
    resetResult();
    await engine.restart();
    tables.clear();
    renderTables();
    editor?.setValue("");
    selectedFile = null;
    fileInput.value = "";
    setDropzoneHasFile(dropzone, false);
    showStatus(strings.StatusRestarted);
  }

  void loadEditorKit().then((kit) => kit.createEditor(editorHost, {
    language: "sql",
    label: strings.EditorLabel,
    hintId: "ldp-editor-hint",
    phrases: strings.Phrases,
    onSubmit: () => { void runQuery(); },
    onChange: () => { runButton.disabled = busy || tables.size === 0 || !editor?.getValue().trim(); },
  })).then((created) => {
    editor = created;
    showStatus(strings.StatusReady);
    renderTables();
  }).catch((error: unknown) => showError(localizedError(error, strings.ErrorGeneric)));

  fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) chooseFile(file); });
  formatSelect.addEventListener("change", syncCsvOptions);
  importButton.addEventListener("click", () => { void importFile(); });
  runButton.addEventListener("click", () => { void runQuery(); });
  exportButton?.addEventListener("click", () => { void exportQuery(); });
  exportFormat?.addEventListener("change", syncExportOptions);
  restartButton?.addEventListener("click", () => { void restart(); });
  cancelButton?.addEventListener("click", () => {
    activeAbort?.abort();
    void engine.cancel().then(() => {
      tables.clear();
      resetResult();
      renderTables();
      editor?.setValue("");
    });
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-local-data-example]")) {
    button.addEventListener("click", () => insertExample(button.dataset.localDataExample || "select"));
  }
  syncCsvOptions();
  syncExportOptions();
  showStatus(strings.StatusReady);

  const dispose = () => { activeAbort?.abort(); void engine.dispose(); };
  document.addEventListener("astro:before-swap", dispose, { once: true });
  window.addEventListener("pagehide", dispose, { once: true });
}

init();
document.addEventListener("astro:page-load", init);
