/**
 * Hash Calculator client controller. Drives the `HashCalculator.astro` shell,
 * calling the worker-backed `hash-client` so hashing never blocks the UI.
 *
 * Loads ONLY on the hash tool page (the component imports this script), so the
 * WASM module is fetched only there (Stage 7 Gate 7 — network check). SSR-safe:
 * no-ops when the shell is absent.
 */
import { hashText, hashFile } from "@/scripts/wasm/hash-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { HASH_ALGORITHMS, DEFAULT_HASH_ALGORITHMS } from "@/tools/hash-algorithms";
import { formatBytes, formatMs, progressPercent } from "@/lib/format";
import {
  bindEmptyState,
  bindLoadExample,
  copyWithFeedback,
  prepareCopyButton,
  setFieldValue,
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
}

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
  const syncInput = inputHost && textarea ? bindEmptyState(inputHost, textarea) : () => {};
  if (exampleBtn && textarea) bindLoadExample(exampleBtn, () => setFieldValue(textarea, EXAMPLE));

  let currentFile: File | null = null;
  let abortController: AbortController | null = null;

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
  });

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
    const labelById = new Map(HASH_ALGORITHMS.map((a) => [a.id, a.label] as const));
    results.replaceChildren(
      ...hashes.map((h) => {
        const row = document.createElement("div");
        row.className = "ds-result-row";
        const algo = document.createElement("span");
        algo.className = "ds-result-key";
        algo.textContent = labelById.get(h.id) ?? h.id;
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
        row.append(algo, hex, copy);
        return row;
      }),
    );
    if (output) syncEmptyState(output, hashes.length === 0);
  }

  function clearResults() {
    results?.replaceChildren();
    if (output) syncEmptyState(output, true);
  }

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
    clearResults();

    setBusy(true);
    abortController = new AbortController();
    try {
      let hashes;
      if (currentFile) {
        if (progress) progress.hidden = false;
        hashes = await hashFile(currentFile, algos, {
          signal: abortController.signal,
          onProgress: ({ processed, total, elapsedMs }) => {
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
      renderResults(hashes);
    } catch (e) {
      if (e instanceof WasmError && e.code === "aborted") {
        clearError(); // cancellation is not an error to surface
      } else {
        showError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (progress) {
        progress.hidden = true;
        setProgress(0);
      }
      setBusy(false);
      abortController = null;
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
