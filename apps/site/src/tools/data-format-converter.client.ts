import { bindDropzone, setDropzoneHasFile } from "@/scripts/tool-ui";
import { createExplorerTable, type ExplorerTable } from "@/scripts/explorer-table";
import { formatMs, formatString, progressPercent } from "@/lib/format";
import { saveStreamedFile } from "@/scripts/stream-save";
import type { DataEncoding, DataFormat, EngineProgress, LocalDataEngine, TableInfo } from "@/tools/data-engine";
import type * as DataEngineModule from "@/tools/data-engine";
type Delimiter = "," | ";" | "\t" | "|";

async function initConverter(): Promise<void> {
  const rootElement = document.querySelector<HTMLElement>("[data-converter-tool]");
  const island = document.querySelector<HTMLScriptElement>("[data-converter-strings]");
  if (!rootElement || !island?.textContent || rootElement.dataset.initialized) return;
  const root: HTMLElement = rootElement;
  root.dataset.initialized = "true";
  const strings = JSON.parse(island.textContent) as Record<string, string>;
  const get = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-converter-${name}]`)!;
  const input = get<HTMLInputElement>("file");
  const zone = get<HTMLElement>("dropzone");
  const status = get<HTMLElement>("status");
  const errorBox = get<HTMLElement>("error");
  const loaded = get<HTMLElement>("loaded");
  const progress = get<HTMLElement>("progress");
  const bar = get<HTMLElement>("bar");
  const fill = get<HTMLElement>("fill");
  const label = get<HTMLElement>("progress-label");
  const columnHost = get<HTMLElement>("columns");
  let file: File | null = null;
  let engine: LocalDataEngine | null = null;
  let source: TableInfo | null = null;
  let table: ExplorerTable | null = null;
  let abort: AbortController | null = null;
  let busy = false;
  let disposed = false;
  const casts = ["VARCHAR", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"] as const;
  let modulePromise: Promise<typeof DataEngineModule> | null = null;
  const typeControls: { name: string; selected: HTMLInputElement; cast: HTMLSelectElement }[] = [];
  const value = (name: string) => get<HTMLSelectElement>(name).value;
  const checked = (name: string) => get<HTMLInputElement>(name).checked;

  function show(message: string): void {
    status.textContent = message;
    status.hidden = false;
  }

  function showError(error: unknown): void {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (abort?.signal.aborted || code === "aborted" || (error instanceof DOMException && error.name === "AbortError")) {
      show(strings.Canceled);
      return;
    }
    if (error instanceof Error && /json-tabular-unsupported/.test(error.message)) {
      errorBox.textContent = strings.ErrorJson;
      errorBox.hidden = false;
      return;
    }
    errorBox.textContent = formatString(strings.Error, error instanceof Error ? error.message : String(error));
    errorBox.hidden = false;
  }

  function updateProgress(info: EngineProgress): void {
    if (disposed) return;
    const percent = progressPercent(info.processed, info.total);
    if (info.total > 0) bar.setAttribute("aria-valuenow", String(percent));
    else bar.removeAttribute("aria-valuenow");
    fill.style.width = `${percent}%`;
    label.textContent = `${info.phase === "loading" ? strings.Loading : info.phase === "importing" ? strings.Importing : strings.Converting} · ${formatString(strings.Elapsed, formatMs(info.elapsedMs))}`;
  }

  function setBusy(next: boolean): void {
    busy = next;
    progress.hidden = !next;
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select").forEach(control => {
      control.disabled = next && !control.hasAttribute("data-converter-cancel");
    });
  }

  function clearResult(): void {
    table?.destroy();
    table = null;
    source = null;
    typeControls.length = 0;
    columnHost.replaceChildren();
    loaded.hidden = true;
  }

  async function release(): Promise<void> {
    const previous = engine;
    engine = null;
    clearResult();
    await previous?.dispose();
  }

  async function run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (busy || disposed) return;
    abort = new AbortController();
    setBusy(true);
    errorBox.hidden = true;
    const started = performance.now();
    const timer = window.setInterval(() => {
      label.textContent = formatString(strings.Elapsed, formatMs(performance.now() - started));
    }, 250);
    try {
      await action(abort.signal);
    } catch (error) {
      showError(error);
      if (abort.signal.aborted) await release();
    } finally {
      window.clearInterval(timer);
      abort = null;
      if (!disposed) setBusy(false);
    }
  }

  async function getModule() {
    if (!modulePromise) {
      show(strings.Loading);
      modulePromise = import("@/tools/data-engine").catch(error => {
        modulePromise = null;
        throw error;
      });
    }
    return modulePromise;
  }

  function selectFile(files: File[]): void {
    if (busy || !files[0]) return;
    file = files[0];
    input.value = "";
    setDropzoneHasFile(zone, true);
    void release().catch(showError);
    show(file.name);
  }

  async function projection(): Promise<string> {
    if (!source) throw new Error(strings.ChooseFile);
    const { buildProjectionQuery } = await getModule();
    return buildProjectionQuery(source.name, typeControls.filter(control => control.selected.checked).map(control => ({
      source: control.name,
      ...(control.cast.value ? { cast: control.cast.value as typeof casts[number] } : {}),
    })));
  }

  async function preview(signal: AbortSignal): Promise<void> {
    const api = engine;
    if (!api || !source) return;
    table?.destroy();
    table = null;
    const sql = await projection();
    const result = await api.query(`${sql} LIMIT 200`, { maxRows: 200 }, signal);
    const page = await api.getPage(result.id, { offset: 0, limit: 200 });
    const rows = page.rows.map(row => row.map(cell => cell ?? "NULL"));
    signal.throwIfAborted();
    table = createExplorerTable({
      host: get<HTMLElement>("table"),
      columns: result.columns.map(column => ({ key: column.name, label: `${column.name} (${column.type})` })),
      readRows: async (start, count) => rows.slice(start, start + count),
      onError: showError,
      emptyLabel: strings.Empty,
      loadingLabel: strings.Loading,
      rowLabel: index => formatString(strings.Row, index + 1),
    });
    table.setRowCount(result.rowCount);
    get<HTMLElement>("preview-note").textContent = formatString(strings.PreviewNote, 200);
  }

  get<HTMLButtonElement>("open").addEventListener("click", () => void run(async signal => {
    if (!file) { show(strings.ChooseFile); return; }
    await release();
    const { createLocalDataEngine } = await getModule();
    signal.throwIfAborted();
    const loadingStarted = performance.now();
    engine = createLocalDataEngine({ onWasmLoad: info => updateProgress({
      phase: "loading", processed: info.loaded, total: info.total, elapsedMs: performance.now() - loadingStarted,
    }) });
    const format = value("input-format");
    source = await engine.loadTable(file, {
      tableName: "source_data",
      ...(format === "auto" ? {} : { format: format as DataFormat }),
      csv: {
        ...(value("delimiter") === "auto" ? {} : { delimiter: value("delimiter") as Delimiter }),
        header: checked("header"),
        allVarchar: true,
        encoding: value("encoding") as DataEncoding,
      },
    }, signal, updateProgress);
    signal.throwIfAborted();
    for (const column of source.columns) {
      const group = document.createElement("div");
      group.className = "ds-field";
      const row = document.createElement("label");
      row.className = "ds-check-row";
      const selected = document.createElement("input");
      selected.type = "checkbox";
      selected.className = "ds-check";
      selected.checked = true;
      const name = document.createElement("span");
      name.textContent = column.name;
      row.append(selected, name);
      const cast = document.createElement("select");
      cast.className = "ds-field-select";
      cast.setAttribute("aria-label", formatString(strings.ColumnType, column.name));
      cast.append(new Option(`${strings.KeepType} (${column.type})`, ""));
      for (const type of casts) cast.append(new Option(type, type));
      typeControls.push({ name: column.name, selected, cast });
      group.append(row, cast);
      columnHost.append(group);
    }
    loaded.hidden = false;
    await preview(signal);
    show(strings.Ready);
  }));

  get<HTMLButtonElement>("preview").addEventListener("click", () => void run(preview));
  get<HTMLButtonElement>("download").addEventListener("click", () => void run(async signal => {
    if (!engine || !source || !file) return;
    const api = engine;
    const format = value("output-format") as DataFormat;
    const mimeType = format === "parquet" ? "application/vnd.apache.parquet" : format === "csv" ? "text/csv" : format === "jsonl" ? "application/x-ndjson" : "application/json";
    await saveStreamedFile({
      suggestedName: `${file.name.replace(/\.[^.]+$/u, "")}-converted.${format}`,
      mimeType,
      extensions: [`.${format}`],
      fallbackMaxBytes: 256 * 1024 * 1024,
      signal,
    }, async sink => {
      const query = await api.query(await projection(), {}, signal);
      return api.exportResult(query.id, { format, delimiter: value("output-delimiter") as Delimiter, header: checked("output-header"), sink }, signal, updateProgress);
    });
    show(strings.Saved);
  }));

  get<HTMLButtonElement>("cancel").addEventListener("click", () => {
    abort?.abort();
    void engine?.cancel().catch(showError);
  });
  get<HTMLButtonElement>("clear").addEventListener("click", () => {
    if (busy) return;
    file = null;
    input.value = "";
    setDropzoneHasFile(zone, false);
    void release().catch(showError);
    status.hidden = true;
    errorBox.hidden = true;
  });
  bindDropzone(zone, input, selectFile);
  window.addEventListener("pagehide", () => {
    disposed = true;
    abort?.abort();
    void release().catch(() => undefined);
  });
  window.addEventListener("pageshow", () => { disposed = false; });
}

void initConverter();
