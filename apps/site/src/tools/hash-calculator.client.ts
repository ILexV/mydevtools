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

const ALGO_STORAGE = "mdt.tools.hash-calculator.algos.v1";

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
    const raw = localStorage.getItem(ALGO_STORAGE);
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

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
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
  const progressFill = root.querySelector<HTMLElement>("[data-hash-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-hash-progress-label]");
  const errorBox = root.querySelector<HTMLElement>("[data-hash-error]");
  const results = root.querySelector<HTMLElement>("[data-hash-results]");

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
      algoCount.textContent = strings!.algorithmsSelected.replace("{n}", String(n)).replace("%n", String(n)) || `${n}`;
    }
  }

  function setSelected(set: Set<string>) {
    for (const c of algoCheckboxes()) {
      c.checked = set.has(c.value);
      c.closest(".algo-item")?.classList.toggle("checked", c.checked);
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
      cb.closest(".algo-item")?.classList.toggle("checked", cb.checked);
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

  function renderResults(hashes: { id: string; hex: string }[]) {
    if (!results) return;
    const labelById = new Map(HASH_ALGORITHMS.map((a) => [a.id, a.label] as const));
    results.innerHTML = hashes
      .map(
        (h) =>
          `<div class="result-row"><span class="result-algo">${labelById.get(h.id) ?? h.id}</span>` +
          `<span class="result-hex">${h.hex}</span>` +
          `<button type="button" class="ghost-btn copy-btn" data-copy="${h.hex}">${strings!.copy}</button></div>`,
      )
      .join("");
    results.hidden = false;
  }

  results?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement)?.closest?.("[data-copy]") as HTMLButtonElement | null;
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.getAttribute("data-copy") || "");
      const orig = btn.textContent;
      btn.textContent = strings!.copied;
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  function setBusy(busy: boolean) {
    if (calcBtn) calcBtn.disabled = busy;
    if (cancelBtn) cancelBtn.hidden = !busy;
  }

  async function handleCalculate() {
    clearError();
    const algos = selectedAlgos();
    if (algos.length === 0) {
      showError(strings.selectAtLeastOne);
      return;
    }
    if (results) { results.hidden = true; results.innerHTML = ""; }

    setBusy(true);
    abortController = new AbortController();
    try {
      let hashes;
      if (currentFile) {
        if (progress) progress.hidden = false;
        hashes = await hashFile(currentFile, algos, {
          signal: abortController.signal,
          onProgress: ({ processed, total, elapsedMs }) => {
            const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
            if (progressFill) progressFill.style.width = `${pct}%`;
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
        if (progressFill) progressFill.style.width = "0%";
      }
      setBusy(false);
      abortController = null;
    }
  }

  calcBtn?.addEventListener("click", handleCalculate);
  cancelBtn?.addEventListener("click", () => abortController?.abort());

  clearBtn?.addEventListener("click", () => {
    if (textarea) textarea.value = "";
    if (fileInput) fileInput.value = "";
    currentFile = null;
    if (fileName) fileName.textContent = "";
    if (results) { results.hidden = true; results.innerHTML = ""; }
    clearError();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
