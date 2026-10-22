import { formatBytes, formatMs, formatString } from "@/lib/format";
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { createExplorerTable, type ExplorerTable } from "@/scripts/explorer-table";
import { loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { saveStreamedFile, saveWorkerStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { classifyWorkerError } from "@/scripts/wasm/worker-protocol";
import {
  quoteSqliteIdentifier,
  SQLITE_LIMITS,
  type SqliteDatabaseInfo,
  type SqliteExportFormat,
  type SqliteObject,
  type SqliteObjectDetail,
  type SqliteResultSummary,
} from "@/tools/sqlite-explorer-engine";
import {
  decodeSqliteError,
  parseSqliteExplorerSettings,
  SQLITE_EXPLORER_STORAGE_KEY,
  SQLITE_EXPORT_MIME,
  type SqliteExplorerSettings,
} from "@/tools/sqlite-explorer-protocol";
import { createSqliteExplorerWorker, type SqliteExplorerWorkerClient } from "@/tools/sqlite-explorer-worker-client";

interface Strings {
  Lang: string;
  Phrases?: Record<string, string>;
  EditorLabel: string;
  StatusReady: string;
  StatusOpening: string;
  StatusOpened: string;
  StatusRunning: string;
  StatusComplete: string;
  StatusCanceled: string;
  StatusExporting: string;
  StatusExported: string;
  StatusDownloaded: string;
  ProgressElapsed: string;
  ProgressRows: string;
  ResultSummary: string;
  ResultTruncated: string;
  ChangesSummary: string;
  TableEmpty: string;
  TableLoading: string;
  RowLabel: string;
  TypeTable: string;
  TypeView: string;
  TypeIndex: string;
  TypeTrigger: string;
  IndexOn: string;
  ModeReadOnly: string;
  ModeWritable: string;
  InfoPagesValue: string;
  StructureColumns: string;
  StructureIndexes: string;
  StructureForeignKeys: string;
  StructureSql: string;
  ColumnName: string;
  ColumnType: string;
  ColumnNotNull: string;
  ColumnDefault: string;
  ColumnPrimaryKey: string;
  IndexUnique: string;
  ReopenConfirm: string;
  ErrorFormat: string;
  ErrorCorrupt: string;
  ErrorTooLarge: string;
  ErrorReadOnly: string;
  ErrorSql: string;
  ErrorMemory: string;
  ErrorExport: string;
  ErrorEngine: string;
  ErrorGeneric: string;
}

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-sqlx-strings]");
  if (!element?.textContent) return null;
  try { return JSON.parse(element.textContent) as Strings; } catch { return null; }
}

function loadSettings(): SqliteExplorerSettings {
  try {
    const raw = localStorage.getItem(SQLITE_EXPLORER_STORAGE_KEY);
    return parseSqliteExplorerSettings(raw ? JSON.parse(raw) as unknown : null);
  } catch {
    return parseSqliteExplorerSettings(null);
  }
}

function saveSettings(settings: SqliteExplorerSettings): void {
  try { localStorage.setItem(SQLITE_EXPLORER_STORAGE_KEY, JSON.stringify(settings)); } catch { /* Settings are optional. */ }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Download file name for the modified copy: `<name>-edited.<ext>`. */
function editedFileName(name: string): string {
  const match = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/u.exec(name);
  const base = match?.[1] || "database";
  return `${base}-edited${match?.[2] ?? ".sqlite"}`;
}

function init(): void {
  const rootElement = document.querySelector<HTMLElement>("[data-sqlx-tool]");
  if (!rootElement || rootElement.dataset.initialized === "true") return;
  const root = rootElement;
  const parsedStrings = readStrings(root);
  if (!parsedStrings) return;
  const strings: Strings = parsedStrings;
  root.dataset.initialized = "true";
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const fileInput = query<HTMLInputElement>("[data-sqlx-file]");
  const dropzone = query<HTMLElement>("[data-sqlx-dropzone]");
  const writableInput = query<HTMLInputElement>("[data-sqlx-writable]");
  const progress = query<HTMLElement>("[data-sqlx-progress]");
  const progressLabel = query<HTMLElement>("[data-sqlx-progress-label]");
  const cancelButton = query<HTMLButtonElement>("[data-sqlx-cancel]");
  const status = query<HTMLElement>("[data-sqlx-status]");
  const errorBox = query<HTMLElement>("[data-sqlx-error]");
  const infoList = query<HTMLElement>("[data-sqlx-info]");
  const walNote = query<HTMLElement>("[data-sqlx-wal]");
  const objectList = query<HTMLUListElement>("[data-sqlx-objects]");
  const objectsEmpty = query<HTMLElement>("[data-sqlx-objects-empty]");
  const editorHost = query<HTMLElement>("[data-sqlx-editor]");
  const runButton = query<HTMLButtonElement>("[data-sqlx-run]");
  const output = query<HTMLElement>("[data-sqlx-output]");
  const results = query<HTMLElement>("[data-sqlx-results]");
  const structure = query<HTMLDetailsElement>("[data-sqlx-structure]");
  const structureTitle = query<HTMLElement>("[data-sqlx-structure-title]");
  const structureBody = query<HTMLElement>("[data-sqlx-structure-body]");
  const summaryElement = query<HTMLElement>("[data-sqlx-summary]");
  const tableHost = query<HTMLElement>("[data-sqlx-table]");
  const exportSection = query<HTMLElement>("[data-sqlx-export-section]");
  const exportFormat = query<HTMLSelectElement>("[data-sqlx-export-format]");
  const exportButton = query<HTMLButtonElement>("[data-sqlx-export]");
  const downloadPanel = query<HTMLElement>("[data-sqlx-download-panel]");
  const downloadButton = query<HTMLButtonElement>("[data-sqlx-download]");

  const numberFormat = new Intl.NumberFormat(strings.Lang);
  const settings = loadSettings();
  exportFormat.value = settings.exportFormat;
  let worker: SqliteExplorerWorkerClient = createSqliteExplorerWorker();
  let file: File | null = null;
  let info: SqliteDatabaseInfo | null = null;
  let objects: SqliteObject[] = [];
  let selected = "";
  let summary: SqliteResultSummary | null = null;
  let table: ExplorerTable | null = null;
  let editor: MdtEditor | null = null;
  let activeAbort: AbortController | null = null;
  let busy = false;
  let dirty = false;
  let timer = 0;

  function showStatus(message: string): void {
    status.textContent = message;
    status.hidden = false;
  }

  function showError(message: string): void {
    errorBox.textContent = message;
    errorBox.hidden = false;
    status.hidden = true;
  }

  function clearError(): void {
    errorBox.hidden = true;
  }

  function localizedError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : String(error);
    const engineError = decodeSqliteError(message);
    if (engineError) {
      if (engineError.code === "not-sqlite") return strings.ErrorFormat;
      if (engineError.code === "corrupt") return strings.ErrorCorrupt;
      if (engineError.code === "file-too-large") return formatString(strings.ErrorTooLarge, formatBytes(SQLITE_LIMITS.maxDatabaseBytes));
      if (engineError.code === "readonly") return strings.ErrorReadOnly;
      if (engineError.code === "sql" || engineError.code === "sql-too-large") return `${strings.ErrorSql} ${engineError.detail}`.trim();
      return fallback;
    }
    const { code } = classifyWorkerError(error);
    if (code === "memory-exhausted") return strings.ErrorMemory;
    if (code === "init-failed" || code === "worker-failed") return strings.ErrorEngine;
    return fallback;
  }

  /** Analytics failure category for an open or run error. */
  function failureReason(error: unknown): Parameters<ToolOperation["fail"]>[0] {
    const message = error instanceof Error ? error.message : String(error);
    const engineError = decodeSqliteError(message);
    if (engineError?.code === "not-sqlite" || engineError?.code === "corrupt") return "unsupported_format";
    if (engineError) return engineError.code === "no-database" ? "processing_error" : "invalid_input";
    const { code } = classifyWorkerError(error);
    return code === "init-failed" || code === "worker-failed" ? "wasm_unavailable" : "processing_error";
  }

  function syncControls(): void {
    const open = info !== null;
    fileInput.disabled = busy;
    writableInput.disabled = busy;
    runButton.disabled = busy || !open || !editor?.getValue().trim();
    exportButton.disabled = busy || !summary || summary.source === "changes";
    downloadButton.disabled = busy || !open;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-sqlx-example]")) {
      const needsTable = button.dataset.sqlxExample === "select";
      button.disabled = busy || !open || (needsTable && !objects.some((item) => item.type === "table"));
    }
    for (const button of objectList.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  }

  function startBusy(label: string): AbortController {
    activeAbort = new AbortController();
    busy = true;
    progress.hidden = false;
    clearError();
    showStatus(label);
    const started = performance.now();
    progressLabel.textContent = label;
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      progressLabel.textContent = formatString(strings.ProgressElapsed, label, formatMs(performance.now() - started));
    }, 250);
    syncControls();
    return activeAbort;
  }

  function endBusy(): void {
    window.clearInterval(timer);
    activeAbort = null;
    busy = false;
    progress.hidden = true;
    syncControls();
  }

  function resetResult(): void {
    summary = null;
    table?.destroy();
    table = null;
    results.hidden = true;
    structure.hidden = true;
    summaryElement.textContent = "";
    syncEmptyState(output, true);
  }

  function typeLabel(item: SqliteObject): string {
    if (item.type === "table") return strings.TypeTable;
    if (item.type === "view") return strings.TypeView;
    if (item.type === "index") return strings.TypeIndex;
    return strings.TypeTrigger;
  }

  function renderObjects(): void {
    objectList.replaceChildren();
    for (const item of objects) {
      const entry = element("li");
      const button = element("button", undefined, "sqlx-object");
      button.type = "button";
      button.dataset.name = item.name;
      button.classList.toggle("is-active", item.name === selected);
      button.setAttribute("aria-pressed", String(item.name === selected));
      const kind = element("span", typeLabel(item), "ds-badge");
      const name = element("span", item.name, "sqlx-object-name");
      button.append(kind, name);
      if ((item.type === "index" || item.type === "trigger") && item.table) {
        button.append(element("span", formatString(strings.IndexOn, item.table), "sqlx-object-meta"));
      }
      button.addEventListener("click", () => { void selectObject(item); });
      entry.append(button);
      objectList.append(entry);
    }
    objectsEmpty.hidden = objects.length !== 0 || info === null;
    syncControls();
  }

  function renderInfo(): void {
    infoList.hidden = info === null;
    walNote.hidden = !info?.wal;
    downloadPanel.hidden = !info?.writable;
    if (!info) return;
    query<HTMLElement>("[data-sqlx-info-file]").textContent = `${info.fileName} · ${formatBytes(info.fileSize)}`;
    query<HTMLElement>("[data-sqlx-info-mode]").textContent = info.writable ? strings.ModeWritable : strings.ModeReadOnly;
    query<HTMLElement>("[data-sqlx-info-pages]").textContent = formatString(strings.InfoPagesValue, numberFormat.format(info.pageCount), formatBytes(info.pageSize), numberFormat.format(info.freePages));
    query<HTMLElement>("[data-sqlx-info-encoding]").textContent = info.encoding;
    query<HTMLElement>("[data-sqlx-info-version]").textContent = `${info.userVersion}${info.applicationId ? ` · application_id ${info.applicationId}` : ""}`;
    query<HTMLElement>("[data-sqlx-info-engine]").textContent = `SQLite ${info.sqliteVersion}`;
  }

  function renderStructure(detail: SqliteObjectDetail | null): void {
    structure.hidden = detail === null;
    structureBody.replaceChildren();
    if (!detail) return;
    structureTitle.textContent = `${typeLabel(detail)} ${detail.name}`;
    if (detail.columns.length) {
      structureBody.append(element("h4", strings.StructureColumns));
      const wrap = element("div", undefined, "sqlx-columns-wrap");
      const grid = element("table");
      const head = element("tr");
      for (const label of [strings.ColumnName, strings.ColumnType, strings.ColumnNotNull, strings.ColumnDefault, strings.ColumnPrimaryKey]) {
        const cell = element("th", label);
        cell.scope = "col";
        head.append(cell);
      }
      grid.append(element("thead"));
      grid.tHead!.append(head);
      const body = element("tbody");
      for (const column of detail.columns) {
        const row = element("tr");
        row.append(
          element("td", column.name),
          element("td", column.type || "—"),
          element("td", column.notNull ? "✓" : ""),
          element("td", column.defaultValue ?? ""),
          element("td", column.primaryKey ? String(column.primaryKey) : ""),
        );
        body.append(row);
      }
      grid.append(body);
      wrap.append(grid);
      structureBody.append(wrap);
    }
    if (detail.indexes.length) {
      structureBody.append(element("h4", strings.StructureIndexes));
      const list = element("ul");
      for (const index of detail.indexes) {
        list.append(element("li", `${index.name} (${index.columns.join(", ")})${index.unique ? ` · ${strings.IndexUnique}` : ""}`));
      }
      structureBody.append(list);
    }
    if (detail.foreignKeys.length) {
      structureBody.append(element("h4", strings.StructureForeignKeys));
      const list = element("ul");
      for (const key of detail.foreignKeys) list.append(element("li", `${key.from} → ${key.table}(${key.to ?? "rowid"})`));
      structureBody.append(list);
    }
    if (detail.sql) {
      structureBody.append(element("h4", strings.StructureSql));
      structureBody.append(element("pre", detail.sql, "ds-code-block"));
    }
  }

  function showResult(next: SqliteResultSummary): void {
    summary = next;
    table?.destroy();
    table = null;
    results.hidden = false;
    syncEmptyState(output, false);
    const elapsed = formatMs(next.elapsedMs);
    if (next.source === "changes") {
      summaryElement.textContent = formatString(strings.ChangesSummary, numberFormat.format(next.statements), numberFormat.format(next.changes), elapsed);
      tableHost.replaceChildren();
    } else {
      const base = formatString(strings.ResultSummary, numberFormat.format(next.rowCount), numberFormat.format(next.columns.length), elapsed);
      summaryElement.textContent = next.truncated ? `${base} ${formatString(strings.ResultTruncated, numberFormat.format(next.rowCount))}` : base;
      table = createExplorerTable({
        host: tableHost,
        columns: next.columns.map((name, index) => ({ key: `${index}:${name}`, label: name })),
        readRows: (start, count) => worker.read(start, count),
        onError: (error) => showError(localizedError(error, strings.ErrorGeneric)),
        emptyLabel: strings.TableEmpty,
        loadingLabel: strings.TableLoading,
        rowLabel: (index) => formatString(strings.RowLabel, numberFormat.format(index + 1)),
      });
      table.setRowCount(next.rowCount);
    }
    exportSection.hidden = next.source === "changes";
    syncControls();
  }

  /** After a cancel or a crashed worker the copy is gone: start a fresh worker and reopen the file. */
  async function recover(message: string): Promise<void> {
    worker.terminate();
    worker = createSqliteExplorerWorker();
    resetResult();
    if (!file) return;
    try {
      const opened = await worker.open(file, writableInput.checked);
      info = opened.info;
      objects = opened.objects;
      selected = "";
      dirty = false;
      renderInfo();
      renderObjects();
      showStatus(message);
    } catch (error) {
      info = null;
      objects = [];
      renderInfo();
      renderObjects();
      showError(localizedError(error, strings.ErrorGeneric));
    }
  }

  async function openFile(next: File, explicit: boolean): Promise<void> {
    if (busy) return;
    if (dirty && !window.confirm(strings.ReopenConfirm)) {
      writableInput.checked = info?.writable ?? writableInput.checked;
      return;
    }
    const abort = startBusy(strings.StatusOpening);
    const operation = explicit && next.size > 0 ? startToolOperation("sqlite-explorer") : null;
    resetResult();
    try {
      const opened = await worker.open(next, writableInput.checked, abort.signal);
      file = next;
      info = opened.info;
      objects = opened.objects;
      selected = "";
      dirty = false;
      setDropzoneHasFile(dropzone, true);
      renderInfo();
      renderObjects();
      const tables = objects.filter((item) => item.type === "table").length;
      const views = objects.filter((item) => item.type === "view").length;
      showStatus(formatString(strings.StatusOpened, next.name, numberFormat.format(tables), numberFormat.format(views)));
      const first = objects.find((item) => item.type === "table");
      if (editor && !editor.getValue().trim() && first) editor.setValue(`SELECT *\nFROM ${quoteSqliteIdentifier(first.name)}\nLIMIT 100;`);
      operation?.complete();
    } catch (error) {
      if (abort.signal.aborted) {
        operation?.cancel();
        endBusy();
        await recover(strings.StatusCanceled);
        return;
      }
      file = null;
      info = null;
      objects = [];
      renderInfo();
      renderObjects();
      setDropzoneHasFile(dropzone, false);
      showError(localizedError(error, strings.ErrorGeneric));
      operation?.fail(failureReason(error));
    } finally {
      if (busy) endBusy();
    }
  }

  async function selectObject(item: SqliteObject): Promise<void> {
    if (busy) return;
    selected = item.name;
    renderObjects();
    clearError();
    try {
      const detail = await worker.detail(item.name);
      if (item.type === "table" || item.type === "view") {
        const abort = startBusy(strings.StatusRunning);
        try {
          const browsed = await worker.browse(item.name, abort.signal);
          objects = browsed.objects;
          showResult(browsed.summary);
          showStatus(strings.StatusComplete);
        } catch (error) {
          if (abort.signal.aborted) {
            endBusy();
            await recover(strings.StatusCanceled);
            return;
          }
          throw error;
        } finally {
          if (busy) endBusy();
        }
      } else {
        resetResult();
        results.hidden = false;
        syncEmptyState(output, false);
        exportSection.hidden = true;
        tableHost.replaceChildren();
      }
      renderStructure(detail);
      structure.open = item.type !== "table" && item.type !== "view";
    } catch (error) {
      showError(localizedError(error, strings.ErrorGeneric));
    }
  }

  async function runSql(): Promise<void> {
    if (!editor || busy || !info) return;
    const sql = editor.getValue();
    if (!sql.trim()) return;
    const abort = startBusy(strings.StatusRunning);
    const operation = startToolOperation("sqlite-explorer");
    resetResult();
    try {
      const ran = await worker.run(sql, abort.signal);
      objects = ran.objects;
      // Any script on a writable copy may have changed it (DDL is not counted in changes).
      dirty = dirty || info.writable;
      if (selected && !objects.some((item) => item.name === selected)) selected = "";
      renderObjects();
      showResult(ran.summary);
      showStatus(strings.StatusComplete);
      operation.complete();
    } catch (error) {
      if (abort.signal.aborted) {
        operation.cancel();
        endBusy();
        await recover(strings.StatusCanceled);
        return;
      }
      showError(localizedError(error, strings.ErrorSql));
      operation.fail(failureReason(error));
      if (classifyWorkerError(error).code !== "unknown") {
        endBusy();
        await recover(strings.ErrorEngine);
        showError(localizedError(error, strings.ErrorSql));
      }
    } finally {
      if (busy) endBusy();
    }
  }

  async function exportResult(): Promise<void> {
    if (!summary || busy) return;
    const format = exportFormat.value as SqliteExportFormat;
    const name = summary.source === "table" ? summary.name : "query-result";
    const abort = startBusy(strings.StatusExporting);
    try {
      const saved = await saveWorkerStreamedFile({
        suggestedName: `${name.replace(/[\\/:*?"<>|]+/gu, "_") || "result"}.${format}`,
        mimeType: SQLITE_EXPORT_MIME[format],
        extensions: [format],
        fallbackMaxBytes: 256 * 1024 * 1024,
        signal: abort.signal,
      }, (port, signal) => worker.exportResult(format, port, signal, (info) => {
        progressLabel.textContent = formatString(strings.ProgressRows, numberFormat.format(info.processed), numberFormat.format(info.total));
      }));
      showStatus(formatString(strings.StatusExported, numberFormat.format(saved.value), formatBytes(saved.bytesWritten)));
    } catch (error) {
      if (abort.signal.aborted || (error instanceof StreamSaveError && error.code === "aborted")) {
        endBusy();
        if (abort.signal.aborted) await recover(strings.StatusCanceled);
        else showStatus(strings.StatusCanceled);
        return;
      }
      showError(localizedError(error, strings.ErrorExport));
    } finally {
      if (busy) endBusy();
    }
  }

  async function downloadDatabase(): Promise<void> {
    if (!info || !file || busy) return;
    const abort = startBusy(strings.StatusExporting);
    try {
      const bytes = await worker.download(abort.signal);
      const saved = await saveStreamedFile({
        suggestedName: editedFileName(file.name),
        mimeType: "application/vnd.sqlite3",
        extensions: [file.name.split(".").pop() || "sqlite"],
        fallbackMaxBytes: Math.max(bytes.length, 1),
        signal: abort.signal,
      }, (sink) => sink.write(bytes));
      dirty = false;
      showStatus(formatString(strings.StatusDownloaded, formatBytes(saved.bytesWritten)));
    } catch (error) {
      if (abort.signal.aborted || (error instanceof StreamSaveError && error.code === "aborted")) {
        endBusy();
        showStatus(strings.StatusCanceled);
        return;
      }
      showError(localizedError(error, strings.ErrorExport));
    } finally {
      if (busy) endBusy();
    }
  }

  function insertExample(kind: string): void {
    if (!editor) return;
    const first = objects.find((item) => item.type === "table");
    let sql = first ? `SELECT *\nFROM ${quoteSqliteIdentifier(first.name)}\nLIMIT 100;` : "";
    if (kind === "counts") {
      const tables = objects.filter((item) => item.type === "table").slice(0, 50);
      sql = tables.length
        ? `${tables.map((item) => `SELECT '${item.name.replaceAll("'", "''")}' AS table_name, count(*) AS row_count FROM ${quoteSqliteIdentifier(item.name)}`).join("\nUNION ALL\n")}\nORDER BY row_count DESC;`
        : "SELECT name FROM sqlite_schema WHERE type = 'table';";
    }
    if (kind === "schema") sql = "SELECT type, name, tbl_name, sql\nFROM sqlite_schema\nORDER BY type, name;";
    if (kind === "integrity") sql = "PRAGMA integrity_check;";
    editor.setValue(sql);
    editor.focus();
  }

  bindDropzone(dropzone, fileInput, (files) => {
    const next = files[0];
    if (next) void openFile(next, true);
  });
  fileInput.addEventListener("change", () => {
    const next = fileInput.files?.[0];
    if (next) void openFile(next, true);
  });
  writableInput.addEventListener("change", () => {
    if (file && !busy) void openFile(file, false);
  });
  runButton.addEventListener("click", () => { void runSql(); });
  exportButton.addEventListener("click", () => { void exportResult(); });
  downloadButton.addEventListener("click", () => { void downloadDatabase(); });
  exportFormat.addEventListener("change", () => {
    settings.exportFormat = exportFormat.value as SqliteExportFormat;
    saveSettings(settings);
  });
  cancelButton.addEventListener("click", () => { activeAbort?.abort(); });
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-sqlx-example]")) {
    button.addEventListener("click", () => insertExample(button.dataset.sqlxExample || "select"));
  }

  void loadEditorKit().then((kit) => kit.createEditor(editorHost, {
    language: "sql",
    label: strings.EditorLabel,
    hintId: "sqlx-editor-hint",
    phrases: strings.Phrases,
    onSubmit: () => { void runSql(); },
    onChange: () => syncControls(),
  })).then((created) => {
    editor = created;
    syncControls();
  }).catch((error: unknown) => showError(localizedError(error, strings.ErrorGeneric)));

  showStatus(strings.StatusReady);
  syncControls();

  const dispose = () => { activeAbort?.abort(); window.clearInterval(timer); worker.terminate(); };
  document.addEventListener("astro:before-swap", dispose, { once: true });
  window.addEventListener("pagehide", dispose, { once: true });
}

init();
document.addEventListener("astro:page-load", init);
