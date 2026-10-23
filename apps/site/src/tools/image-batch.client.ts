/**
 * Batch Image Processor controller. Files are added via the drop zone (more
 * can be added later; duplicates by name+size+mtime are skipped, files the
 * WASM decoder can't read are rejected up front). Run validates max
 * width/height, then a worker pool (`createImageWorkerPool`, size from
 * `batchPoolSize`) processes the queue in parallel: decode once, fit inside
 * the box, encode. Each row of the report fills in as its file finishes;
 * totals (saved %, wall time, MB/s, MP/s) follow. Cancel aborts every worker
 * and keeps finished rows. Results: per-file download, stored ZIP of all,
 * CSV report. Workers are terminated after each batch to free WASM memory.
 */
import { createImageWorkerPool, type ImageWorkerPool } from "@/scripts/wasm/image-tools-client";
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { localizeResourceError, WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, revealOutput, setDropzoneHasFile, startPreparing, syncEmptyState } from "@/scripts/tool-ui";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { storedZip } from "@/tools/archive-format";
import { downloadLink, iconButton, PDF_ICONS } from "@/tools/pdf-file-ui";
import { formatSizeChange, isDecodableImage, isImageDecodeError, mimeFor, savingsPercent } from "@/tools/image-tools";
import {
  batchOutputName,
  batchPoolSize,
  isSameFormat,
  keepsOriginal,
  parseMaxSide,
  reportCsv,
  resolveBatchFormat,
  summarize,
  type BatchRow,
  type BatchStatus,
} from "@/tools/image-batch";

type Strings = Record<string, string>;

interface Item {
  file: File;
  row: BatchRow;
  tr: HTMLTableRowElement;
  bytes: Uint8Array | null;
  url: string | null;
}

const STATUS_KEYS: Record<BatchStatus, string> = {
  waiting: "StatusWaiting",
  working: "StatusWorking",
  done: "StatusDone",
  kept: "StatusKept",
  failed: "StatusFailed",
  canceled: "StatusCanceled",
};

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-ib-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-ib-tool]");
  if (!root || root.dataset.initialized) return;
  const strings = readStrings();
  if (!strings) return;
  const s = strings;
  const $ = <T extends Element = HTMLElement>(name: string) => root.querySelector<T>(`[data-ib-${name}]`);

  const zone = $("dropzone");
  const input = $<HTMLInputElement>("file");
  const metaEl = $("meta");
  const clearBtn = $<HTMLButtonElement>("clear");
  const formatSel = $<HTMLSelectElement>("format");
  const qualityRange = $<HTMLInputElement>("quality");
  const qualityValue = $("quality-value");
  const maxWidthInput = $<HTMLInputElement>("max-width");
  const maxHeightInput = $<HTMLInputElement>("max-height");
  const keepInput = $<HTMLInputElement>("keep");
  const runBtn = $<HTMLButtonElement>("run");
  const progress = $("progress");
  const progressBar = $("progress-bar");
  const progressFill = $("progress-fill");
  const progressLabel = $("progress-label");
  const cancelBtn = $<HTMLButtonElement>("cancel");
  const errorBox = $("error");
  const noteBox = $("note");
  const output = $("output");
  const loaded = $("loaded");
  const statsEl = $("stats");
  const statsNote = $("stats-note");
  const webpNote = $("webp-note");
  const actions = $("actions");
  const zipBtn = $<HTMLButtonElement>("zip");
  const csvBtn = $<HTMLButtonElement>("csv");
  const rowsEl = $<HTMLTableSectionElement>("rows");
  if (!zone || !input || !formatSel || !qualityRange || !maxWidthInput || !maxHeightInput || !keepInput || !runBtn || !output || !loaded || !rowsEl) return;
  root.dataset.initialized = "true";

  let items: Item[] = [];
  let busy = false;
  let job: AbortController | null = null;
  let pool: ImageWorkerPool | null = null;

  const stat = (name: string) => statsEl?.querySelector<HTMLElement>(`[data-ib-stat="${name}"]`) ?? null;

  function show(box: HTMLElement | null, text: string) {
    if (!box) return;
    box.textContent = text;
    box.hidden = !text;
  }

  function syncControls() {
    const has = items.length > 0;
    runBtn!.disabled = busy || !has;
    if (clearBtn) clearBtn.disabled = busy || !has;
    for (const el of [formatSel, qualityRange, maxWidthInput, maxHeightInput, keepInput, input]) el!.disabled = busy;
    zone!.setAttribute("aria-disabled", String(busy));
    setDropzoneHasFile(zone!, has);
    for (const btn of rowsEl!.querySelectorAll<HTMLButtonElement>("[data-ib-remove]")) btn.disabled = busy;
    const total = items.reduce((sum, it) => sum + it.file.size, 0);
    if (metaEl) metaEl.textContent = has ? formatString(s.QueueMeta, items.length, formatBytes(total, 2)) : "";
    loaded!.hidden = !has;
    syncEmptyState(output!, !has);
    const finished = items.some((it) => it.bytes);
    if (actions) actions.hidden = busy || !finished;
  }

  function cell(tr: HTMLTableRowElement, i: number): HTMLTableCellElement {
    return tr.cells[i];
  }

  /** Repaint one report row from its BatchRow. */
  function paint(item: Item) {
    const { row, tr } = item;
    const finished = row.status === "done" || row.status === "kept";
    const name = cell(tr, 0);
    name.replaceChildren(document.createTextNode(row.name));
    if (finished && row.outputName !== row.name) {
      const out = document.createElement("div");
      out.className = "ds-hint";
      out.textContent = `→ ${row.outputName}`;
      name.append(out);
    }
    cell(tr, 1).textContent = formatBytes(row.inputBytes, 2);
    cell(tr, 2).textContent = finished ? formatBytes(row.outputBytes, 2) : "";
    const change = cell(tr, 3);
    change.textContent = finished ? formatSizeChange(row.inputBytes, row.outputBytes) : "";
    change.className = finished && savingsPercent(row.inputBytes, row.outputBytes) > 0 ? "is-smaller" : "";
    const px = cell(tr, 4);
    px.textContent = !row.sourceWidth
      ? ""
      : finished && (row.width !== row.sourceWidth || row.height !== row.sourceHeight)
        ? `${row.sourceWidth}×${row.sourceHeight} → ${row.width}×${row.height}`
        : `${row.sourceWidth}×${row.sourceHeight}`;
    cell(tr, 5).textContent = row.ms ? formatMs(row.ms) : "";
    const status = cell(tr, 6);
    status.textContent = row.status === "failed" && row.error ? `${s[STATUS_KEYS.failed]}: ${row.error}` : s[STATUS_KEYS[row.status]];
    status.className = row.status === "failed" ? "is-failed" : row.status === "done" ? "" : "is-muted";
    const act = cell(tr, 7);
    if (finished && item.url) {
      act.replaceChildren(downloadLink(item.url, row.outputName, `${s.Download}: ${row.outputName}`));
    } else if (!act.querySelector("[data-ib-remove]")) {
      const btn = iconButton(PDF_ICONS.close, `${s.Remove}: ${row.name}`);
      btn.dataset.ibRemove = "";
      btn.disabled = busy;
      act.replaceChildren(btn);
    }
  }

  function resetResult(item: Item) {
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = null;
    item.bytes = null;
    Object.assign(item.row, { outputName: "", outputBytes: 0, width: 0, height: 0, ms: 0, status: "waiting", error: undefined });
  }

  function clearReport() {
    if (statsEl) statsEl.hidden = true;
    show(statsNote, "");
    show(webpNote, "");
    show(noteBox, "");
  }

  function addFiles(files: File[]) {
    if (busy) return;
    show(errorBox, "");
    const rejected: string[] = [];
    const known = new Set(items.map((it) => `${it.file.name}\u0000${it.file.size}\u0000${it.file.lastModified}`));
    for (const file of files) {
      if (!isDecodableImage(file)) {
        rejected.push(file.name);
        continue;
      }
      const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
      if (known.has(key)) continue;
      known.add(key);
      const tr = document.createElement("tr");
      for (let i = 0; i < 8; i++) tr.append(document.createElement("td"));
      const item: Item = {
        file,
        tr,
        bytes: null,
        url: null,
        row: {
          name: file.name, inputBytes: file.size, outputName: "", outputBytes: 0,
          sourceWidth: 0, sourceHeight: 0, width: 0, height: 0, ms: 0, status: "waiting",
        },
      };
      items.push(item);
      rowsEl!.append(tr);
      paint(item);
    }
    if (rejected.length) show(errorBox, formatString(s.ErrorNotImage, rejected.join(", ")));
    input!.value = "";
    syncControls();
  }

  async function run() {
    if (busy || items.length === 0) return;
    show(errorBox, "");
    const maxWidth = parseMaxSide(maxWidthInput!.value);
    const maxHeight = parseMaxSide(maxHeightInput!.value);
    maxWidthInput!.toggleAttribute("aria-invalid", maxWidth === null);
    maxHeightInput!.toggleAttribute("aria-invalid", maxHeight === null);
    if (maxWidth === null || maxHeight === null) {
      show(errorBox, s.ErrorMaxSize);
      (maxWidth === null ? maxWidthInput : maxHeightInput)!.focus();
      return;
    }
    const selected = formatSel!.value;
    const quality = Number.parseInt(qualityRange!.value || "80", 10);
    const keepIfLarger = keepInput!.checked;

    clearReport();
    for (const item of items) {
      resetResult(item);
      paint(item);
    }
    const operation = startToolOperation("image-batch");
    const ctrl = new AbortController();
    job = ctrl;
    busy = true;
    syncControls();
    const sizes = navigator as Navigator & { deviceMemory?: number };
    pool = createImageWorkerPool(batchPoolSize(navigator.hardwareConcurrency, sizes.deviceMemory));
    const activePool = pool;
    const totalBytes = items.reduce((sum, it) => sum + it.file.size, 0);
    let doneBytes = 0;
    let doneCount = 0;
    let lossless = false;
    const used = new Set<string>();
    const started = performance.now();
    const prepared = startPreparing("image_tools", { host: runBtn!.closest<HTMLElement>(".ds-action-row"), label: s.Preparing });
    if (progress) progress.hidden = false;
    const tick = () => {
      const elapsed = performance.now() - started;
      const percent = progressPercent(doneBytes, totalBytes);
      if (progressFill) progressFill.style.width = `${percent}%`;
      progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
      const speed = elapsed > 0 ? doneBytes / (elapsed / 1000) : 0;
      if (progressLabel) {
        progressLabel.textContent = formatString(s.ProgressLabel, doneCount, items.length, formatBytes(doneBytes, 1), formatBytes(speed, 1), formatMs(elapsed));
      }
    };
    tick();
    const timer = setInterval(tick, 500);

    const queue = [...items];
    const processOne = async (slot: number, item: Item) => {
      const { file, row } = item;
      const format = resolveBatchFormat(selected, file);
      row.status = "working";
      paint(item);
      const t0 = performance.now();
      try {
        const source = new Uint8Array(await file.arrayBuffer());
        const r = await activePool.process(slot, source, { maxWidth, maxHeight, format, quality }, ctrl.signal);
        prepared();
        const resized = r.width !== r.sourceWidth || r.height !== r.sourceHeight;
        const keep = keepsOriginal({ keepIfLarger, inputBytes: file.size, outputBytes: r.bytes.length, sameFormat: isSameFormat(file, format), resized });
        if (format === "webp" && !r.webpLossy) lossless = true;
        item.bytes = keep ? source : r.bytes;
        item.url = URL.createObjectURL(keep ? file : new Blob([r.bytes as BlobPart], { type: mimeFor(format) }));
        Object.assign(row, {
          status: keep ? "kept" : "done",
          outputName: batchOutputName(file.name, format, used),
          outputBytes: item.bytes.length,
          sourceWidth: r.sourceWidth,
          sourceHeight: r.sourceHeight,
          width: keep ? r.sourceWidth : r.width,
          height: keep ? r.sourceHeight : r.height,
        });
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof WasmError && e.code === "aborted")) {
          row.status = "canceled";
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        row.status = "failed";
        row.error = isImageDecodeError(message)
          ? s.ErrorDamaged
          : localizeResourceError(e, s as unknown as { memoryExhausted: string; invalidFormat: string; corruptInput: string }) ?? s.ErrorProcess;
      } finally {
        row.ms = performance.now() - t0;
        doneBytes += file.size;
        doneCount++;
        paint(item);
      }
    };
    const lane = async (slot: number) => {
      for (let item = queue.shift(); item && !ctrl.signal.aborted; item = queue.shift()) await processOne(slot, item);
    };
    await Promise.all(Array.from({ length: activePool.size }, (_, slot) => lane(slot)));

    clearInterval(timer);
    prepared();
    const wallMs = performance.now() - started;
    activePool.terminate();
    if (pool === activePool) pool = null;
    if (job === ctrl) job = null;
    for (const item of items) {
      if (item.row.status === "waiting" || item.row.status === "working") {
        item.row.status = "canceled";
        paint(item);
      }
    }
    busy = false;
    if (progress) progress.hidden = true;

    const sum = summarize(items.map((it) => it.row), wallMs);
    if (statsEl) {
      statsEl.hidden = sum.processed === 0;
      const set = (name: string, text: string) => {
        const el = stat(name);
        if (el) el.textContent = text;
      };
      set("images", String(sum.processed));
      set("before", formatBytes(sum.inputBytes, 2));
      set("after", formatBytes(sum.outputBytes, 2));
      set("change", formatSizeChange(sum.inputBytes, sum.outputBytes));
      stat("change")?.classList.toggle("is-smaller", sum.savedPercent > 0);
      set("time", formatMs(wallMs));
      set("speed", `${formatBytes(sum.bytesPerSecond, 1)}/s · ${sum.megapixelsPerSecond.toFixed(1)} MP/s`);
    }
    const notes = [formatString(s.Threads, activePool.size)];
    if (sum.kept) notes.push(formatString(s.SummaryKept, sum.kept));
    if (sum.failed) notes.push(formatString(s.SummaryFailed, sum.failed));
    show(statsNote, sum.processed || sum.failed ? notes.join(" · ") : "");
    show(webpNote, lossless ? s.WebpLosslessNote : "");
    if (ctrl.signal.aborted) {
      operation.cancel();
      show(noteBox, formatString(s.Canceled, sum.processed + sum.failed, items.length));
    } else if (sum.processed === 0 && sum.failed > 0) {
      operation.fail("processing_error");
    } else {
      operation.complete();
    }
    syncControls();
    revealOutput(output);
  }

  bindDropzone(zone, input, addFiles);

  rowsEl.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("[data-ib-remove]") : null;
    if (!btn || busy) return;
    const tr = btn.closest("tr");
    const index = items.findIndex((it) => it.tr === tr);
    if (index < 0) return;
    const [item] = items.splice(index, 1);
    resetResult(item);
    item.tr.remove();
    if (!items.length) clearReport();
    syncControls();
    const next = items[index] ?? items[index - 1];
    (next?.tr.querySelector<HTMLElement>("[data-ib-remove], a") ?? runBtn)?.focus();
  });

  clearBtn?.addEventListener("click", () => {
    if (busy) return;
    for (const item of items) resetResult(item);
    items = [];
    rowsEl!.replaceChildren();
    clearReport();
    show(errorBox, "");
    syncControls();
  });

  qualityRange.addEventListener("input", () => {
    if (qualityValue) qualityValue.textContent = `${qualityRange.value}%`;
  });
  for (const el of [maxWidthInput, maxHeightInput]) el.addEventListener("input", () => el.removeAttribute("aria-invalid"));

  runBtn.addEventListener("click", () => void run());
  cancelBtn?.addEventListener("click", () => job?.abort());

  zipBtn?.addEventListener("click", () => {
    const files = items.filter((it) => it.bytes).map((it) => ({ name: it.row.outputName, bytes: it.bytes! }));
    if (files.length) saveBlob(storedZip(files), "images.zip");
  });
  csvBtn?.addEventListener("click", () => {
    saveBlob(new Blob([reportCsv(items.map((it) => it.row))], { type: "text/csv;charset=utf-8" }), "image-batch-report.csv");
  });

  syncControls();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
