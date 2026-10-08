/**
 * Hash Calculator client controller. Drives the `HashCalculator.astro` shell,
 * calling the worker-backed `hash-client` so hashing never blocks the UI.
 *
 * Loads ONLY on the hash tool page (the component imports this script), so the
 * WASM module is fetched only there (Stage 7 Gate 7 — network check). SSR-safe:
 * no-ops when the shell is absent.
 *
 * Checksum verification: the optional "Expected hash" is compared against the
 * cached digests of the last calculation (selected algorithms only, never
 * rehashed). Editing the source text/file or the algorithm selection marks the
 * cache stale, which clears match marks until the next result arrives.
 */
import { hashText, hashFile, type ProgressInfo } from "@/scripts/wasm/hash-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { HASH_ALGORITHMS, DEFAULT_HASH_ALGORITHMS } from "@/tools/hash-algorithms";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { matchingDigests, parseExpectedHash } from "@/tools/hash-compare";
import { formatDuration } from "@/tools/aead-file-helpers";
import { exportHashResults, HASH_EXPORT_TYPES, type HashExportFormat, type HashResultGroup } from "@/tools/hash-results";
import { appendMeta, badge, buildFileRow, iconButton, PDF_ICONS, spinner } from "@/tools/pdf-file-ui";
import { downloadText } from "@/scripts/codemirror-loader";
import {
  bindEmptyState,
  bindDropzone,
  bindLoadExample,
  copyWithFeedback,
  prepareCopyButton,
  revealOutput,
  setFieldValue,
  setLiveText,
  startPreparing,
  syncEmptyState,
} from "@/scripts/tool-ui";

const ALGO_STORAGE = "mdt.tools.hash-calculator.algos.v1";
const LEGACY_ALGO_STORAGE = "mydevtools.tools.hash-calculator.selectedAlgorithms.v1";
/** "Load example" input: the classic pangram test vector (well-known MD5/SHA digests). */
const EXAMPLE = "The quick brown fox jumps over the lazy dog";

interface Strings {
  copy: string;
  copied: string;
  algorithmsSelected: string;
  selectAtLeastOne: string;
  preparing?: string;
  expectedErrorWhitespace: string;
  expectedErrorNonHex: string;
  compareMatches: string;
  compareNoMatch: string;
  comparePending: string;
  compareStale: string;
  rowMatches: string;
  selectedFiles: string;
  removeFile: string;
  textResult: string;
  statusReady: string;
  statusHashing: string;
  statusDone: string;
  statusCanceled: string;
  statusError: string;
  processingError: string;
  progressStats: string;
  resultStats: string;
}

const ICON_MATCH =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16" stroke-width="2.25" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>';
const ICON_MISMATCH =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';

function readStrings(): Strings | null {
  const island = document.querySelector<HTMLScriptElement>("[data-hash-strings]");
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function loadStoredAlgos(): Record<string, true> | null {
  try {
    let raw = localStorage.getItem(ALGO_STORAGE);
    if (!raw) {
      // One-time import from the legacy site key (favorites/recent pattern).
      const legacy = localStorage.getItem(LEGACY_ALGO_STORAGE);
      if (legacy) {
        localStorage.setItem(ALGO_STORAGE, legacy);
        raw = legacy;
      }
    }
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const valid: Record<string, true> = Object.fromEntries(HASH_ALGORITHMS.map((a) => [a.id, true]));
    const filtered = arr.filter((s): s is string => typeof s === "string" && valid[s] === true);
    return filtered.length > 0 ? Object.fromEntries(filtered.map((id) => [id, true])) : null;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-hash-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;
  root.dataset.initialized = "true";

  const textarea = root.querySelector<HTMLTextAreaElement>("[data-hash-textarea]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-hash-file]");
  const fileName = root.querySelector<HTMLElement>("[data-hash-filename]");
  const fileList = root.querySelector<HTMLElement>("[data-hash-files]");
  const algoSearch = root.querySelector<HTMLInputElement>("[data-hash-algo-search]");
  const algoList = root.querySelector<HTMLElement>("[data-hash-algo-list]");
  const algoCount = root.querySelector<HTMLElement>("[data-hash-algo-count]");
  const algoCheckboxes = Array.from(root.querySelectorAll<HTMLInputElement>("[data-hash-algo]"));
  const resetBtn = root.querySelector<HTMLButtonElement>("[data-hash-algo-reset]");
  const calcBtn = root.querySelector<HTMLButtonElement>("[data-hash-calculate]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-hash-cancel]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-hash-clear]");
  const progress = root.querySelector<HTMLElement>("[data-hash-progress]");
  const progressBar = root.querySelector<HTMLElement>("[data-hash-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-hash-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-hash-progress-label]");
  const errorBox = root.querySelector<HTMLElement>("[data-hash-error]");
  const results = root.querySelector<HTMLElement>("[data-hash-results]");
  const output = root.querySelector<HTMLElement>("[data-hash-output]");
  const inputHost = root.querySelector<HTMLElement>("[data-hash-input-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-hash-example]");
  const expectedInput = root.querySelector<HTMLInputElement>("[data-hash-expected]");
  const expectedError = root.querySelector<HTMLElement>("[data-hash-expected-error]");
  const compareSummary = root.querySelector<HTMLElement>("[data-hash-compare-summary]");
  const compareLive = root.querySelector<HTMLElement>("[data-hash-compare-live]");
  const exportBtn = root.querySelector<HTMLButtonElement>("[data-hash-export]");
  const exportFormat = root.querySelector<HTMLSelectElement>("[data-hash-export-format]");

  const currentFiles: File[] = [];
  let abortController: AbortController | null = null;
  /** Per-source result snapshots, including terminal failures and cancellation. */
  let cachedDigests: HashResultGroup[] | null = null;
  let digestsStale = false;
  let calculating = false;
  // Clear can abort and immediately start another run; old continuations must not paint it.
  let generation = 0;
  let announceTimer: number | undefined;
  let lastAnnounced = "";
  const labelById: Record<string, string> = Object.fromEntries(HASH_ALGORITHMS.map((a) => [a.id, a.label]));
  const defaultSelection: Record<string, true> = Object.fromEntries(DEFAULT_HASH_ALGORITHMS.map((id) => [id, true]));
  const listFmt = new Intl.ListFormat(document.documentElement.lang || undefined, { type: "conjunction" });

  if (inputHost && textarea) bindEmptyState(inputHost, textarea);
  if (exampleBtn && textarea) bindLoadExample(exampleBtn, () => setFieldValue(textarea, EXAMPLE));

  function syncInput() {
    if (inputHost && textarea) syncEmptyState(inputHost, textarea.value === "" && currentFiles.length === 0);
  }

  function selectedAlgos(): string[] {
    return algoCheckboxes.filter((c) => c.checked).map((c) => c.value);
  }

  function updateCount() {
    if (algoCount) {
      const n = selectedAlgos().length;
      const tpl = strings.algorithmsSelected;
      algoCount.textContent = /\{n\}|%n/.test(tpl)
        ? tpl.replace("{n}", String(n)).replace("%n", String(n))
        : tpl ? `${tpl}: ${n}` : `${n}`;
    }
  }

  function setSelected(selected: Readonly<Record<string, true>>) {
    for (const c of algoCheckboxes) c.checked = selected[c.value] === true;
    updateCount();
    saveSelection();
    invalidateDigests();
  }

  function saveSelection() {
    try {
      localStorage.setItem(ALGO_STORAGE, JSON.stringify(selectedAlgos()));
    } catch {
      /* Settings are optional; inputs and results are never persisted. */
    }
  }

  function renderFiles() {
    if (fileName) fileName.textContent = currentFiles.length ? formatString(strings.selectedFiles, currentFiles.length) : "";
    if (fileList) {
      fileList.hidden = currentFiles.length === 0;
      fileList.replaceChildren(...currentFiles.map((file, index) => {
        const { li, meta, actions } = buildFileRow(file.name, index);
        appendMeta(meta, formatBytes(file.size));
        const remove = iconButton(PDF_ICONS.close, formatString(strings.removeFile, file.name));
        remove.dataset.hashRemove = String(index);
        remove.disabled = calculating;
        actions.append(remove);
        return li;
      }));
    }
    syncInput();
  }

  fileList?.addEventListener("click", (e) => {
    const remove = (e.target as HTMLElement)?.closest?.<HTMLButtonElement>("[data-hash-remove]");
    if (!remove || calculating) return;
    currentFiles.splice(Number(remove.dataset.hashRemove), 1);
    renderFiles();
    invalidateDigests();
  });
  if (inputHost) {
    bindDropzone(inputHost, fileInput, (files) => {
      if (calculating) return;
      currentFiles.push(...files);
      renderFiles();
      invalidateDigests();
    }, { clickToOpen: false });
  }
  textarea?.addEventListener("input", () => {
    syncInput();
    invalidateDigests();
  });

  function showError(msg: string) {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
  }
  function clearError() {
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = "";
    }
  }

  // Runtime DOM uses shared ds-* visuals; update only the source that changed.
  function renderResult(group: HashResultGroup, index: number) {
    if (!results) return;
    const section = document.createElement("section");
    section.className = "ds-stack";
    section.dataset.hashGroup = String(index);
    section.dataset.hashStatus = group.status;
    const title = group.source === "file" ? group.name ?? "" : strings.textResult;
    section.setAttribute("aria-label", `#${index + 1} ${title}`);
    const head = document.createElement("div");
    head.className = "ds-file-item";
    const main = document.createElement("div");
    const name = document.createElement("div");
    name.className = "ds-file-item-name";
    name.textContent = title;
    name.title = title;
    const meta = document.createElement("div");
    meta.className = "ds-file-item-meta";
    meta.textContent = `#${index + 1}`;
    appendMeta(meta, group.bytes === null ? "—" : formatBytes(group.bytes));
    if (group.status === "done" && group.bytes !== null && group.elapsedMs > 0) {
      appendMeta(meta, formatString(strings.resultStats, formatMs(group.elapsedMs),
        formatBytes(group.bytes * 1000 / group.elapsedMs)));
    } else if (group.elapsedMs > 0) appendMeta(meta, formatMs(group.elapsedMs));
    main.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "ds-file-item-actions";
    if (group.status === "hashing") actions.append(spinner(strings.statusHashing));
    else if (group.status === "done") actions.append(badge(strings.statusDone, "success"));
    else if (group.status === "error") actions.append(badge(strings.statusError, "danger"));
    else if (group.status === "canceled") actions.append(badge(strings.statusCanceled, "warning"));
    else actions.append(badge(strings.statusReady));
    head.append(main, actions);
    section.append(head);

    if (group.error) {
      const error = document.createElement("p");
      error.className = "ds-alert ds-alert-error";
      error.textContent = group.error;
      section.append(error);
    }
    if (group.hashes.length) {
      const rows = document.createElement("div");
      rows.className = "ds-result-list";
      for (const h of group.hashes) {
        const row = document.createElement("div");
        row.className = "ds-result-row";
        row.dataset.hashId = h.id;
        row.dataset.hashSource = String(index);
        const key = document.createElement("span");
        key.className = "ds-result-key hash-row-key";
        const algo = document.createElement("span");
        algo.textContent = labelById[h.id] ?? h.id;
        const matchBadge = document.createElement("span");
        matchBadge.className = "ds-badge ds-badge-success hash-match-badge";
        matchBadge.hidden = true;
        matchBadge.innerHTML = ICON_MATCH;
        matchBadge.append(strings.rowMatches);
        key.append(algo, matchBadge);
        const hex = document.createElement("span");
        hex.className = "ds-result-value";
        hex.textContent = h.hex;
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "ds-btn ds-btn-small ds-btn-ghost";
        copy.dataset.copy = h.hex;
        copy.textContent = strings.copy;
        copy.setAttribute("aria-label", `${strings.copy} ${algo.textContent}: ${title}`);
        prepareCopyButton(copy, strings.copied);
        row.append(key, hex, copy);
        rows.append(row);
      }
      section.append(rows);
    }
    const previous = results.querySelector(`[data-hash-group="${index}"]`);
    if (previous) previous.replaceWith(section);
    else results.append(section);
    if (output) syncEmptyState(output, false);
  }

  function updateExport() {
    if (exportBtn) exportBtn.disabled = calculating || digestsStale || !cachedDigests?.length;
  }

  function clearResults() {
    results?.replaceChildren();
    if (output) syncEmptyState(output, true);
    cachedDigests = null;
    digestsStale = false;
    if (progress) progress.hidden = true;
    updateExport();
    renderComparison();
  }

  function invalidateDigests() {
    if (!cachedDigests || digestsStale) return;
    digestsStale = true;
    if (progress) progress.hidden = true;
    updateExport();
    renderComparison();
  }

  function setSummary(text: string, icon: string, success: boolean) {
    if (!compareSummary) return;
    compareSummary.hidden = !text;
    compareSummary.classList.toggle("is-success", success);
    compareSummary.innerHTML = icon;
    compareSummary.append(text);
  }

  function announce(text: string) {
    if (announceTimer !== undefined) window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      if (!compareLive || text === lastAnnounced) return;
      lastAnnounced = text;
      setLiveText(compareLive, text);
    }, 700);
  }

  // Algorithm IDs alone are not match identities: two files can have different SHA-256 digests.
  function renderComparison() {
    const parsed = parseExpectedHash(expectedInput?.value ?? "");
    const invalidMsg =
      parsed.kind === "invalid"
        ? parsed.reason === "whitespace" ? strings.expectedErrorWhitespace : strings.expectedErrorNonHex
        : "";
    if (expectedError) {
      expectedError.textContent = invalidMsg;
      expectedError.hidden = !invalidMsg;
    }
    if (invalidMsg) expectedInput?.setAttribute("aria-invalid", "true");
    else expectedInput?.removeAttribute("aria-invalid");

    const matches = new Set<string>();
    const names: string[] = [];
    if (parsed.kind === "ok" && cachedDigests && !digestsStale) {
      cachedDigests.forEach((group, index) => {
        for (const id of matchingDigests(parsed.hex, group.hashes)) {
          matches.add(`${index}:${id}`);
          const label = labelById[id] ?? id;
          names.push(group.source === "file" ? `${group.name} (${label})` : label);
        }
      });
    }
    results?.querySelectorAll<HTMLElement>(".ds-result-row").forEach((row) => {
      const hit = matches.has(`${row.dataset.hashSource}:${row.dataset.hashId}`);
      row.classList.toggle("is-match", hit);
      const matchBadge = row.querySelector<HTMLElement>(".hash-match-badge");
      if (matchBadge) matchBadge.hidden = !hit;
    });

    let summary = "";
    let icon = "";
    if (parsed.kind === "ok") {
      if (!cachedDigests) summary = calculating ? "" : strings.comparePending;
      else if (digestsStale) summary = strings.compareStale;
      else if (matches.size > 0) {
        summary = formatString(strings.compareMatches, listFmt.format(names));
        icon = ICON_MATCH;
      } else if (calculating) {
        summary = "";
      } else if (!cachedDigests.some((group) => group.status === "done")) {
        summary = strings.comparePending;
      } else {
        summary = strings.compareNoMatch;
        icon = ICON_MISMATCH;
      }
    }
    setSummary(summary, icon, matches.size > 0);
    announce(invalidMsg || summary);
  }

  expectedInput?.addEventListener("input", () => renderComparison());
  results?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest?.<HTMLButtonElement>("[data-copy]");
    if (btn) void copyWithFeedback(btn, btn.dataset.copy ?? "", strings.copied);
  });
  exportBtn?.addEventListener("click", () => {
    if (!cachedDigests || calculating || digestsStale || !exportFormat) return;
    const format = exportFormat.value as HashExportFormat;
    downloadText(exportHashResults(cachedDigests, format), `hash-results.${format}`, HASH_EXPORT_TYPES[format]);
  });

  function setBusy(busy: boolean) {
    calculating = busy;
    if (calcBtn) {
      calcBtn.disabled = busy;
      calcBtn.setAttribute("aria-busy", String(busy));
    }
    if (cancelBtn) cancelBtn.hidden = !busy;
    for (const control of [textarea, fileInput, algoSearch, resetBtn, exampleBtn, ...algoCheckboxes]) {
      if (control) control.disabled = busy;
    }
    inputHost?.setAttribute("aria-disabled", String(busy));
    fileList?.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = busy; });
    updateExport();
  }

  function updateProgress(processed: number, total: number, elapsedMs: number) {
    const percent = total === 0 ? 100 : progressPercent(processed, total);
    if (progressFill) progressFill.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    const speed = elapsedMs > 0 ? processed * 1000 / elapsedMs : 0;
    const remaining = processed >= total ? 0
      : calculating && speed > 0 ? (total - processed) / speed : Number.NaN;
    if (progressLabel) {
      progressLabel.textContent = formatString(strings.progressStats,
        formatBytes(processed), formatBytes(total), formatBytes(speed), formatMs(elapsedMs),
        formatDuration(remaining));
    }
  }

  async function handleCalculate() {
    if (calculating) return;
    clearError();
    const algos = selectedAlgos();
    if (algos.length === 0) {
      showError(strings.selectAtLeastOne);
      return;
    }
    setBusy(true);
    clearResults();
    const run = ++generation;
    const controller = new AbortController();
    abortController = controller;
    const files = currentFiles.slice();
    const text = textarea?.value ?? "";
    const groups: HashResultGroup[] = files.length
      ? files.map((file) => ({ source: "file", name: file.name, bytes: file.size, status: "ready", elapsedMs: 0, hashes: [] }))
      : [{ source: "text", name: null, bytes: null, status: "ready", elapsedMs: 0, hashes: [] }];
    cachedDigests = groups;
    groups.forEach(renderResult);
    let total = groups.reduce((sum, group) => sum + (group.bytes ?? 0), 0);
    let processedBytes = 0;
    const start = performance.now();
    if (progress) progress.hidden = false;
    if (progressBar) {
      progressBar.hidden = false;
      progressBar.classList.toggle("is-indeterminate", files.length === 0);
    }
    updateProgress(0, total, 0);
    const prepared = startPreparing("hash", {
      host: calcBtn?.closest<HTMLElement>(".ds-action-row"),
      label: strings.preparing,
    });
    try {
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        if (controller.signal.aborted) {
          group.status = "canceled";
          renderResult(group, index);
          continue;
        }
        group.status = "hashing";
        const fileStart = performance.now();
        let fileProcessed = 0;
        renderResult(group, index);
        try {
          const onProgress = (info: ProgressInfo) => {
            if (generation !== run) return;
            prepared();
            group.bytes = info.total;
            if (group.source === "text") total = info.total;
            fileProcessed = info.processed;
            progressBar?.classList.remove("is-indeterminate");
            updateProgress(processedBytes + info.processed, total, performance.now() - start);
          };
          const options = { signal: controller.signal, onProgress };
          group.hashes = files.length
            ? await hashFile(files[index], algos, options)
            : await hashText(algos, text, options);
          if (generation !== run) return;
          group.status = "done";
          fileProcessed = group.bytes ?? 0;
        } catch (error) {
          if (generation !== run) return;
          if (error instanceof WasmError && error.code === "aborted") {
            group.status = "canceled";
          } else {
            group.status = "error";
            group.error = `${strings.processingError} ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        group.elapsedMs = performance.now() - fileStart;
        processedBytes += fileProcessed;
        prepared();
        renderResult(group, index);
        renderComparison();
        updateProgress(processedBytes, total, performance.now() - start);
      }
    } finally {
      prepared();
      if (generation === run) {
        if (progressBar) progressBar.hidden = true;
        setBusy(false);
        updateProgress(processedBytes, total, performance.now() - start);
        abortController = null;
        renderComparison();
        if (!controller.signal.aborted) revealOutput(output);
      }
    }
  }

  calcBtn?.addEventListener("click", handleCalculate);
  cancelBtn?.addEventListener("click", () => abortController?.abort());
  clearBtn?.addEventListener("click", () => {
    generation++;
    abortController?.abort();
    abortController = null;
    setBusy(false);
    if (textarea) textarea.value = "";
    if (fileInput) fileInput.value = "";
    currentFiles.length = 0;
    renderFiles();
    clearResults();
    clearError();
    textarea?.focus();
  });

  algoList?.addEventListener("change", (e) => {
    const cb = (e.target as HTMLElement)?.closest?.("[data-hash-algo]");
    if (cb) {
      updateCount();
      saveSelection();
      invalidateDigests();
    }
  });
  algoSearch?.addEventListener("input", () => {
    const q = algoSearch.value.trim().toLowerCase();
    algoList?.querySelectorAll<HTMLElement>(".algo-item").forEach((item) => {
      const label = item.querySelector("span")?.textContent?.toLowerCase() ?? "";
      item.hidden = !label.includes(q);
    });
  });
  resetBtn?.addEventListener("click", () => setSelected(defaultSelection));
  setSelected(loadStoredAlgos() ?? defaultSelection);
  renderFiles();
  updateExport();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
