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
import { hashText, hashFile } from "@/scripts/wasm/hash-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { HASH_ALGORITHMS, DEFAULT_HASH_ALGORITHMS } from "@/tools/hash-algorithms";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import { matchingDigests, parseExpectedHash } from "@/tools/hash-compare";
import {
  bindEmptyState,
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
  calculate: string;
  cancel: string;
  clear: string;
  copy: string;
  copied: string;
  algorithmsSelected: string;
  selectAtLeastOne: string;
  fileProgress: string;
  preparing?: string;
  expectedErrorWhitespace: string;
  expectedErrorNonHex: string;
  compareMatches: string;
  compareNoMatch: string;
  comparePending: string;
  compareStale: string;
  rowMatches: string;
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

function loadStoredAlgos(): Set<string> | null {
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
    const valid = new Set(HASH_ALGORITHMS.map((a) => a.id));
    const filtered = arr.filter((s): s is string => typeof s === "string" && valid.has(s));
    return filtered.length > 0 ? new Set(filtered) : null;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-hash-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const textarea = root.querySelector<HTMLTextAreaElement>("[data-hash-textarea]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-hash-file]");
  const fileName = root.querySelector<HTMLElement>("[data-hash-filename]");
  const algoSearch = root.querySelector<HTMLInputElement>("[data-hash-algo-search]");
  const algoList = root.querySelector<HTMLElement>("[data-hash-algo-list]");
  const algoCount = root.querySelector<HTMLElement>("[data-hash-algo-count]");
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
  const syncInput = inputHost && textarea ? bindEmptyState(inputHost, textarea) : () => {};
  if (exampleBtn && textarea) bindLoadExample(exampleBtn, () => setFieldValue(textarea, EXAMPLE));

  let currentFile: File | null = null;
  let abortController: AbortController | null = null;
  /** Digests of the last finished calculation (selected algorithms at that time). */
  let cachedDigests: { id: string; hex: string }[] | null = null;
  /** Source or algorithms changed since `cachedDigests` were computed. */
  let digestsStale = false;
  /** A calculation is running: no "press Calculate" prompt meanwhile. */
  let calculating = false;
  let announceTimer: number | undefined;
  let lastAnnounced = "";
  const labelById = new Map(HASH_ALGORITHMS.map((a) => [a.id, a.label] as const));
  const listFmt = new Intl.ListFormat(document.documentElement.lang || undefined, { type: "conjunction" });

  const algoCheckboxes = () =>
    Array.from(root!.querySelectorAll<HTMLInputElement>("[data-hash-algo]"));

  function selectedAlgos(): string[] {
    return algoCheckboxes()
      .filter((c) => c.checked)
      .map((c) => c.value);
  }

  function updateCount() {
    if (algoCount) {
      const n = selectedAlgos().length;
      // Locale strings are a bare word ("Selected") — append the count unless
      // a translation carries its own {n}/%n placeholder.
      const tpl = strings!.algorithmsSelected;
      algoCount.textContent = /\{n\}|%n/.test(tpl)
        ? tpl.replace("{n}", String(n)).replace("%n", String(n))
        : tpl ? `${tpl}: ${n}` : `${n}`;
    }
  }

  function setSelected(set: Set<string>) {
    for (const c of algoCheckboxes()) {
      c.checked = set.has(c.value);
    }
    updateCount();
    saveSelection();
    invalidateDigests();
  }

  function saveSelection() {
    try {
      localStorage.setItem(ALGO_STORAGE, JSON.stringify(selectedAlgos()));
    } catch {
      /* ignore */
    }
  }

  // Restore saved selection, else defaults.
  const stored = loadStoredAlgos();
  setSelected(stored ?? new Set(DEFAULT_HASH_ALGORITHMS));

  // Algorithm checkbox toggle.
  algoList?.addEventListener("change", (e) => {
    const cb = (e.target as HTMLElement)?.closest?.("[data-hash-algo]") as HTMLInputElement | null;
    if (cb) {
      updateCount();
      saveSelection();
      invalidateDigests();
    }
  });

  // Search filter.
  algoSearch?.addEventListener("input", () => {
    const q = algoSearch.value.trim().toLowerCase();
    algoList?.querySelectorAll<HTMLElement>(".algo-item").forEach((item) => {
      const label = item.querySelector("span")?.textContent?.toLowerCase() ?? "";
      item.style.display = label.includes(q) ? "" : "none";
    });
  });

  resetBtn?.addEventListener("click", () => setSelected(new Set(DEFAULT_HASH_ALGORITHMS)));

  // File input.
  fileInput?.addEventListener("change", () => {
    currentFile = fileInput.files?.[0] ?? null;
    if (fileName) fileName.textContent = currentFile ? `${currentFile.name} (${formatBytes(currentFile.size)})` : "";
    invalidateDigests();
  });
  textarea?.addEventListener("input", () => invalidateDigests());

  function showError(msg: string) {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  // Result rows use the shared `.ds-result-*` classes (global, so they style
  // this runtime DOM — Astro scoped styles would not reach it).
  function renderResults(hashes: { id: string; hex: string }[]) {
    if (!results) return;
    results.replaceChildren(
      ...hashes.map((h) => {
        const row = document.createElement("div");
        row.className = "ds-result-row";
        row.dataset.hashId = h.id;
        const key = document.createElement("span");
        key.className = "ds-result-key hash-row-key";
        const algo = document.createElement("span");
        algo.textContent = labelById.get(h.id) ?? h.id;
        const badge = document.createElement("span");
        badge.className = "ds-badge ds-badge-success hash-match-badge";
        badge.hidden = true;
        badge.innerHTML = ICON_MATCH;
        badge.append(strings.rowMatches);
        key.append(algo, badge);
        const hex = document.createElement("span");
        hex.className = "ds-result-value";
        hex.textContent = h.hex;
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "ds-btn ds-btn-small ds-btn-ghost";
        copy.dataset.copy = h.hex;
        copy.textContent = strings.copy;
        copy.setAttribute("aria-label", `${strings.copy} ${algo.textContent}`);
        prepareCopyButton(copy, strings.copied);
        row.append(key, hex, copy);
        return row;
      }),
    );
    if (output) syncEmptyState(output, hashes.length === 0);
  }

  function clearResults() {
    results?.replaceChildren();
    if (output) syncEmptyState(output, true);
    cachedDigests = null;
    digestsStale = false;
    renderComparison();
  }

  /** Source/algorithm edit: prior matches no longer describe the input. */
  function invalidateDigests() {
    if (!cachedDigests || digestsStale) return;
    digestsStale = true;
    renderComparison();
  }

  function setSummary(text: string, icon: string, success: boolean) {
    if (!compareSummary) return;
    compareSummary.hidden = !text;
    compareSummary.classList.toggle("is-success", success);
    compareSummary.innerHTML = icon;
    compareSummary.append(text);
  }

  /** Announce the settled comparison once (debounced; repeated text is skipped). */
  function announce(text: string) {
    if (announceTimer !== undefined) window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      if (!compareLive || text === lastAnnounced) return;
      lastAnnounced = text;
      if (text) setLiveText(compareLive, text);
    }, 700);
  }

  /**
   * Compare the expected hash with the cached digests and paint the result:
   * row tint + badge on matches, summary line, input validation error. Cheap —
   * runs on every keystroke in the expected field, never rehashes.
   */
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

    const usable = parsed.kind === "ok" && cachedDigests !== null && !digestsStale;
    const matches = usable && cachedDigests ? new Set(matchingDigests(parsed.hex, cachedDigests)) : new Set<string>();
    results?.querySelectorAll<HTMLElement>(".ds-result-row").forEach((row) => {
      const hit = matches.has(row.dataset.hashId ?? "");
      row.classList.toggle("is-match", hit);
      const badge = row.querySelector<HTMLElement>(".hash-match-badge");
      if (badge) badge.hidden = !hit;
    });

    let summary = "";
    let icon = "";
    if (parsed.kind === "ok") {
      if (!cachedDigests) summary = calculating ? "" : strings.comparePending;
      else if (digestsStale) summary = strings.compareStale;
      else if (matches.size > 0) {
        const names = (cachedDigests ?? []).filter((d) => matches.has(d.id)).map((d) => labelById.get(d.id) ?? d.id);
        summary = formatString(strings.compareMatches, listFmt.format(names));
        icon = ICON_MATCH;
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

  function setBusy(busy: boolean) {
    if (calcBtn) {
      calcBtn.disabled = busy;
      calcBtn.setAttribute("aria-busy", String(busy));
    }
    if (cancelBtn) cancelBtn.hidden = !busy;
    calculating = busy;
  }

  function setProgress(pct: number) {
    if (progressFill) progressFill.style.width = `${pct}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  async function handleCalculate() {
    clearError();
    const algos = selectedAlgos();
    if (algos.length === 0) {
      showError(strings.selectAtLeastOne);
      return;
    }
    setBusy(true); // before clearResults(): no "press Calculate" prompt while hashing
    clearResults();

    abortController = new AbortController();
    // First run loads the hash WASM in the worker: "Preparing…" next to Calculate if slow.
    const prepared = startPreparing("hash", {
      host: calcBtn?.closest<HTMLElement>(".ds-action-row"),
      label: strings.preparing,
    });
    try {
      let hashes;
      if (currentFile) {
        if (progress) progress.hidden = false;
        hashes = await hashFile(currentFile, algos, {
          signal: abortController.signal,
          onProgress: ({ processed, total, elapsedMs }) => {
            prepared();
            setProgress(progressPercent(processed, total));
            if (progressLabel) {
              progressLabel.textContent = `${strings.fileProgress}: ${formatBytes(processed)} / ${formatBytes(total)} · ${formatMs(elapsedMs)}`;
            }
          },
        });
      } else {
        const text = textarea?.value ?? "";
        hashes = await hashText(algos, text);
      }
      prepared();
      renderResults(hashes);
      cachedDigests = hashes;
      digestsStale = false;
      renderComparison();
      revealOutput(output);
    } catch (e) {
      if (e instanceof WasmError && e.code === "aborted") {
        clearError(); // cancellation is not an error to surface
      } else {
        showError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      prepared();
      if (progress) {
        progress.hidden = true;
        setProgress(0);
      }
      setBusy(false);
      abortController = null;
      renderComparison(); // settle the summary (e.g. back to "press Calculate" after cancel/error)
    }
  }

  calcBtn?.addEventListener("click", handleCalculate);
  cancelBtn?.addEventListener("click", () => abortController?.abort());

  clearBtn?.addEventListener("click", () => {
    if (textarea) textarea.value = "";
    syncInput();
    if (fileInput) fileInput.value = "";
    currentFile = null;
    if (fileName) fileName.textContent = "";
    clearResults();
    clearError();
    textarea?.focus();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
