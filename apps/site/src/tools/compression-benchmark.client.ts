/**
 * Compression benchmark page controller. Every codec and level runs in its own fresh worker
 * (so the WASM memory figure belongs to that run); the results table grows as runs finish.
 * The file and the results stay on this page and are not written to storage.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import { bindDropzone, setDropzoneHasFile, syncEmptyState } from "@/scripts/tool-ui";
import { saveStreamedFile, saveWorkerStreamedFile, StreamSaveError } from "@/scripts/stream-save";
import { createJobWorker, type JobProgress, type JobWorker } from "@/scripts/wasm/job-worker";
import { localizeResourceError } from "@/scripts/wasm/worker-protocol";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import {
  BENCH_CODECS,
  LevelListError,
  codecExtension,
  compressionRatio,
  parseLevels,
  resultsCsv,
  savedShare,
  throughput,
  type BenchCodec,
  type BenchResult,
} from "@/tools/compression-benchmark";
import type { BenchRequest, BenchSuccess } from "@/workers/compression-benchmark.worker";

type Strings = Record<string, string> & { Lang: string };

/** Fallback cap when the browser has no native save picker. */
const FALLBACK_MAX_BYTES = 512 * 1024 * 1024;
const CODEC_KEYS: Readonly<Record<BenchCodec, string>> = { gzip: "CodecGzip", brotli: "CodecBrotli", zstd: "CodecZstd", "gzip-native": "CodecGzipNative" };

function spawn(): JobWorker<BenchRequest, BenchSuccess> {
  return createJobWorker<BenchRequest, BenchSuccess>(
    () => new Worker(new URL("../workers/compression-benchmark.worker.ts", import.meta.url), { type: "module" }),
  );
}

function readStrings(root: HTMLElement): Strings | null {
  const element = root.parentElement?.querySelector<HTMLScriptElement>("[data-bench-strings]");
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-bench-tool]");
  if (!root || root.dataset.initialized) return;
  const parsed = readStrings(root);
  if (!parsed) return;
  const strings: Strings = parsed;
  const $ = <T extends HTMLElement>(hook: string) => root.querySelector<T>(`[data-bench-${hook}]`);
  const zone = $("dropzone");
  const input = $<HTMLInputElement>("file");
  const nameEl = $("name");
  const sampleSelect = $<HTMLSelectElement>("sample");
  const verifyInput = $<HTMLInputElement>("verify");
  const runButton = $<HTMLButtonElement>("run");
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
  const rowsEl = $("rows");
  const csvButton = $<HTMLButtonElement>("csv");
  if (!zone || !input || !sampleSelect || !verifyInput || !runButton || !output || !loaded || !rowsEl || !csvButton) return;
  root.dataset.initialized = "true";
  const numberFormat = new Intl.NumberFormat(strings.Lang, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const percentFormat = new Intl.NumberFormat(strings.Lang, { style: "percent", maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const integerFormat = new Intl.NumberFormat(strings.Lang);
  const codecInputs = new Map<BenchCodec, { enabled: HTMLInputElement; levels: HTMLInputElement | null }>();
  for (const codec of BENCH_CODECS) {
    const enabled = root.querySelector<HTMLInputElement>(`[data-bench-codec="${codec}"]`);
    if (enabled) codecInputs.set(codec, { enabled, levels: root.querySelector<HTMLInputElement>(`[data-bench-levels="${codec}"]`) });
  }

  let file: File | null = null;
  let results: BenchResult[] = [];
  let busy = false;
  let generation = 0;
  let activeAbort: AbortController | null = null;
  let activeWorker: JobWorker<BenchRequest, BenchSuccess> | null = null;
  let activeOperation: ToolOperation | null = null;

  function showStatus(message: string): void {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function hideError(): void {
    if (errorBox) errorBox.hidden = true;
  }

  function isAbort(error: unknown): boolean {
    if (error instanceof StreamSaveError) return error.code === "aborted";
    return typeof error === "object" && error !== null && "code" in error && error.code === "aborted";
  }

  function showError(error: unknown): void {
    if (!errorBox) return;
    const message = error instanceof Error ? error.message : "";
    errorBox.textContent = message === "no-file" ? strings.ErrorNoFile
      : message === "no-runs" ? strings.ErrorNoRuns
      : error instanceof LevelListError ? formatString(strings.ErrorLevels, strings[CODEC_KEYS[error.codec]])
      : /^(corrupt|truncated|checksum):/u.test(message) ? strings.ErrorCorrupt
      : localizeResourceError(error, { memoryExhausted: strings.MemoryExhausted, invalidFormat: strings.InvalidFormat, corruptInput: strings.CorruptInput })
        ?? (typeof error === "object" && error !== null && "code" in error && error.code === "worker-failed" ? strings.ErrorWorker : strings.ErrorGeneric);
    errorBox.hidden = false;
    if (status) status.hidden = true;
  }

  function setProgress(info: JobProgress, label: string): void {
    const percent = progressPercent(info.processed, info.total);
    if (progressFill) progressFill.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    if (progressLabel) progressLabel.textContent = label;
  }

  function syncActions(): void {
    runButton!.disabled = busy || !file;
    csvButton!.disabled = busy || results.length === 0;
    sampleSelect!.disabled = busy;
    verifyInput!.disabled = busy;
    for (const { enabled, levels } of codecInputs.values()) {
      enabled.disabled = busy;
      if (levels) levels.disabled = busy || !enabled.checked;
    }
    for (const button of rowsEl!.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
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

  function stopWorker(): void {
    generation++;
    activeAbort?.abort();
    activeAbort = null;
    activeWorker?.terminate();
    activeWorker = null;
  }

  function clearResults(): void {
    results = [];
    rowsEl!.replaceChildren();
    notesEl?.replaceChildren();
    if (summaryEl) summaryEl.textContent = "";
    loaded!.hidden = true;
    syncEmptyState(output!, true);
  }

  function codecLabel(codec: BenchCodec): string {
    return strings[CODEC_KEYS[codec]];
  }

  function speed(bytes: number, ms: number | null): string {
    return ms === null ? "—" : `${formatBytes(throughput(bytes, ms))}/s`;
  }

  /** Re-renders the table; the best ratio and the fastest compression are highlighted. */
  function renderTable(): void {
    const bestRatio = Math.max(0, ...results.map(compressionRatio));
    const bestSpeed = Math.max(0, ...results.map((r) => throughput(r.inputBytes, r.compressMs)));
    rowsEl!.replaceChildren(...results.map((result, index) => {
      const row = document.createElement("tr");
      const ratio = compressionRatio(result);
      if (results.length > 1 && ratio === bestRatio) row.classList.add("is-best-ratio");
      if (results.length > 1 && throughput(result.inputBytes, result.compressMs) === bestSpeed) row.classList.add("is-best-speed");
      const cells = [
        codecLabel(result.codec),
        result.codec === "gzip-native" ? "—" : String(result.level),
        formatBytes(result.outputBytes),
        `${numberFormat.format(ratio)}×`,
        percentFormat.format(savedShare(result)),
        formatMs(result.compressMs),
        speed(result.inputBytes, result.compressMs),
        result.decompressMs === null ? "—" : formatMs(result.decompressMs),
        speed(result.inputBytes, result.decompressMs),
        result.compressMemory === null ? "—" : `${formatBytes(result.compressMemory)}${result.decompressMemory === null ? "" : ` / ${formatBytes(result.decompressMemory)}`}`,
        result.verified === null ? strings.NotChecked : result.verified ? strings.Verified : strings.VerifyFailed,
      ];
      for (const [i, text] of cells.entries()) {
        const cell = document.createElement("td");
        cell.textContent = text;
        if (i === 3 && bestRatio > 0) {
          const bar = document.createElement("span");
          bar.className = "cb-bar";
          bar.style.width = `${Math.max(4, (ratio / bestRatio) * 100)}%`;
          cell.append(bar);
        }
        if (i === 10 && result.verified === false) cell.classList.add("is-failed");
        row.append(cell);
      }
      const action = document.createElement("td");
      const save = document.createElement("button");
      save.type = "button";
      save.className = "ds-btn ds-btn-small";
      save.textContent = strings.Save;
      save.setAttribute("aria-label", formatString(strings.SaveLabel, codecLabel(result.codec), result.codec === "gzip-native" ? "" : String(result.level)).trim());
      save.disabled = busy;
      save.addEventListener("click", () => void saveCompressed(results[index]));
      action.append(save);
      row.append(action);
      return row;
    }));
    notesEl?.replaceChildren();
    if (results.length > 1) {
      const smallest = results.find((r) => compressionRatio(r) === bestRatio)!;
      const fastest = results.find((r) => throughput(r.inputBytes, r.compressMs) === bestSpeed)!;
      for (const [key, r] of [["BestRatio", smallest], ["BestSpeed", fastest]] as const) {
        const item = document.createElement("li");
        item.textContent = formatString(strings[key], `${codecLabel(r.codec)}${r.codec === "gzip-native" ? "" : ` ${r.level}`}`,
          `${numberFormat.format(compressionRatio(r))}×`, speed(r.inputBytes, r.compressMs));
        notesEl?.append(item);
      }
    }
    csvButton!.disabled = busy || results.length === 0;
  }

  function plannedRuns(): { codec: BenchCodec; level: number }[] {
    const runs: { codec: BenchCodec; level: number }[] = [];
    for (const [codec, { enabled, levels }] of codecInputs) {
      if (!enabled.checked) continue;
      for (const level of parseLevels(codec, levels?.value ?? "")) runs.push({ codec, level });
    }
    return runs;
  }

  async function runBenchmark(): Promise<void> {
    if (busy) return;
    hideError();
    if (!file) {
      showError(new Error("no-file"));
      return;
    }
    let runs: { codec: BenchCodec; level: number }[];
    try {
      runs = plannedRuns();
    } catch (error) {
      showError(error);
      return;
    }
    if (runs.length === 0) {
      showError(new Error("no-runs"));
      return;
    }
    stopWorker();
    clearResults();
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    const operation = startToolOperation("compression-benchmark");
    activeOperation = operation;
    const sampleBytes = Number(sampleSelect!.value) * 1024 * 1024;
    const verify = verifyInput!.checked;
    const source = file;
    setBusy(true, strings.StatusRunning);
    loaded!.hidden = false;
    syncEmptyState(output!, false);
    if (summaryEl) summaryEl.textContent = formatString(strings.SampleLine, formatBytes(Math.min(source.size, sampleBytes)), source.name);
    try {
      for (const [i, run] of runs.entries()) {
        const label = (phase: string, info: JobProgress) => formatString(strings.ProgressRun, integerFormat.format(i + 1), integerFormat.format(runs.length),
          `${codecLabel(run.codec)}${run.codec === "gzip-native" ? "" : ` ${run.level}`}`, phase, formatBytes(info.processed), formatBytes(info.total));
        // A fresh worker per measurement: its WASM heap starts empty.
        activeWorker = spawn();
        const compressed = await activeWorker.run({ type: "compress", file: source, codec: run.codec, level: run.level, sampleBytes, keep: verify }, [], controller.signal,
          (info) => { if (token === generation) setProgress(info, label("↓", info)); });
        activeWorker.terminate();
        if (compressed.kind !== "compress") throw new Error("Unexpected response");
        let decompressMs: number | null = null;
        let decompressMemory: number | null = null;
        let verified: boolean | null = null;
        if (verify) {
          activeWorker = spawn();
          const restored = await activeWorker.run({ type: "decompress", codec: run.codec, chunks: compressed.chunks }, compressed.chunks, controller.signal,
            (info) => { if (token === generation) setProgress(info, label("↑", info)); });
          activeWorker.terminate();
          if (restored.kind !== "decompress") throw new Error("Unexpected response");
          decompressMs = restored.ms;
          decompressMemory = restored.memory;
          verified = restored.bytes === compressed.inputBytes && restored.crc === compressed.crc;
        }
        activeWorker = null;
        if (token !== generation) return;
        results.push({
          codec: run.codec, level: run.level, inputBytes: compressed.inputBytes, outputBytes: compressed.outputBytes,
          compressMs: compressed.ms, decompressMs, compressMemory: compressed.memory, decompressMemory, verified,
        });
        renderTable();
      }
      activeAbort = null;
      setBusy(false);
      renderTable();
      showStatus(strings.StatusDone);
      operation.complete();
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      activeWorker?.terminate();
      activeWorker = null;
      setBusy(false);
      renderTable();
      if (isAbort(error)) {
        showStatus(strings.StatusCanceled);
        operation.cancel();
      } else {
        showError(error);
        operation.fail("processing_error");
      }
    } finally {
      if (activeOperation === operation) activeOperation = null;
    }
  }

  async function saveCompressed(result: BenchResult | undefined): Promise<void> {
    if (busy || !file || !result) return;
    hideError();
    const token = generation;
    const controller = new AbortController();
    activeAbort = controller;
    const source = file;
    setBusy(true, strings.StatusSaving);
    try {
      activeWorker = spawn();
      const worker = activeWorker;
      const ext = codecExtension(result.codec);
      const saved = await saveWorkerStreamedFile({
        suggestedName: `${source.name}.${ext}`,
        mimeType: result.codec === "zstd" ? "application/zstd" : result.codec === "brotli" ? "application/x-brotli" : "application/gzip",
        extensions: [ext],
        fallbackMaxBytes: FALLBACK_MAX_BYTES,
        signal: controller.signal,
      }, (stream, workerSignal) => worker.run({ type: "save", file: source, codec: result.codec, level: result.level, stream }, [stream], workerSignal,
        (info) => setProgress(info, formatString(strings.ProgressRun, "1", "1", `${codecLabel(result.codec)}${result.codec === "gzip-native" ? "" : ` ${result.level}`}`, "↓", formatBytes(info.processed), formatBytes(info.total)))));
      if (token !== generation) return;
      activeAbort = null;
      worker.terminate();
      activeWorker = null;
      setBusy(false);
      const value = saved.value;
      showStatus(formatString(strings.StatusSaved, formatBytes(value.kind === "save" ? value.outputBytes : saved.bytesWritten)));
    } catch (error) {
      if (token !== generation) return;
      activeAbort = null;
      activeWorker?.terminate();
      activeWorker = null;
      setBusy(false);
      if (isAbort(error)) showStatus(strings.StatusCanceled);
      else showError(error);
    }
  }

  async function downloadCsv(): Promise<void> {
    if (busy || results.length === 0) return;
    const bytes = new TextEncoder().encode(resultsCsv(results));
    try {
      await saveStreamedFile({
        suggestedName: `${(file?.name ?? "data").replace(/\.[^.]+$/u, "")}-compression.csv`,
        mimeType: "text/csv;charset=utf-8",
        extensions: ["csv"],
        fallbackMaxBytes: FALLBACK_MAX_BYTES,
      }, async (sink) => { await sink.write(bytes); });
    } catch (error) {
      if (!isAbort(error)) showError(error);
    }
  }

  function chooseFile(next: File | undefined): void {
    if (!next) return;
    if (busy) {
      activeOperation?.cancel();
      activeOperation = null;
    }
    stopWorker();
    setBusy(false);
    file = next;
    setDropzoneHasFile(zone!, true);
    if (nameEl) {
      nameEl.textContent = `${next.name} · ${formatBytes(next.size)}`;
      nameEl.hidden = false;
    }
    clearResults();
    hideError();
    syncActions();
    void runBenchmark();
  }

  bindDropzone(zone, input, (files) => chooseFile(files[0]));
  runButton.addEventListener("click", () => void runBenchmark());
  csvButton.addEventListener("click", () => void downloadCsv());
  for (const { enabled } of codecInputs.values()) enabled.addEventListener("change", syncActions);
  clearButton?.addEventListener("click", () => {
    stopWorker();
    clearResults();
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
  cancelButton?.addEventListener("click", () => {
    if (!busy) return;
    activeOperation?.cancel();
    activeAbort?.abort();
  });
  syncActions();
  showStatus(strings.StatusReady);
}

init();
