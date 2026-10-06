/**
 * Text Diff Viewer client. Builds a unified diff from the two inputs with
 * vendored jsdiff (global `Diff`) and renders it with vendored diff2html-ui
 * (global `Diff2HtmlUI`). Both are loaded on demand from `public/lib`,
 * base-path aware, sequentially in legacy order (jsdiff → diff2html-ui),
 * with the load promise cached. View modes: side-by-side (default) /
 * line-by-line. Loading a file fills its side and auto-compares once both
 * sides have content. Dark theme toggles diff2html's `d2h-dark-color-scheme`
 * class (the vendored CSS ships dark variables behind that class).
 * Workbench empty states: each side shows a hint + "Load example" (fills both
 * sides with localized sample text, on click only); the result panel shows a
 * compact placeholder until there is a diff or a status message.
 */
import { bindEmptyState, bindLoadExample, revealOutput, setFieldValue, syncEmptyState } from "@/scripts/tool-ui";

declare global {
  interface Window {
    Diff?: {
      createTwoFilesPatch(
        oldFileName: string,
        newFileName: string,
        oldStr: string,
        newStr: string,
        oldHeader?: string,
        newHeader?: string,
        options?: { context?: number; maxEditLength?: number },
      ): string;
    };
    Diff2HtmlUI?: new (
      element: HTMLElement,
      diffString: string,
      configuration: Record<string, unknown>,
    ) => {
      draw(): void;
      highlightCode(): void;
    };
  }
}

interface Strings {
  loading: string;
  errorEmpty: string;
  errorLibLoad: string;
  noDifferences: string;
  fileReadError: string;
  diffTooBig: string;
  exampleOriginal?: string;
  exampleModified?: string;
  /** "{0} added" / "{0} removed" — screen-reader text for the headline counts. */
  linesAdded?: string;
  linesRemoved?: string;
}

/** Added / removed line counts of a unified diff (file headers `+++`/`---` excluded). */
function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * Line-edit budget for jsdiff (Myers is O(N·D) on the main thread: 5k lines
 * with 1.7k edits froze the tab for ~13 s). Equal to diff2html's
 * `diffMaxChanges`, which would refuse to draw a bigger diff anyway.
 */
const MAX_LINE_EDITS = 1000;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CSS_HREF = `${BASE}/lib/diff2html.min.css`;
const JS_SOURCES = [`${BASE}/lib/jsdiff.min.js`, `${BASE}/lib/diff2html-ui.min.js`];

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-diff-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function loadStyleOnce(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(src: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) {
    if (existing.dataset.loaded === "true") {
      resolve();
      return promise;
    }
    existing.addEventListener("load", () => resolve(), { once: true });
    existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    return promise;
  }
  const script = document.createElement("script");
  script.src = src;
  script.async = false;
  script.addEventListener("load", () => {
    script.dataset.loaded = "true";
    resolve();
  }, { once: true });
  script.addEventListener("error", () => {
    // Drop the failed tag so a later retry injects a fresh one instead of
    // waiting forever on a script that will never fire `load`.
    script.remove();
    reject(new Error(`Failed to load ${src}`));
  }, { once: true });
  document.body.appendChild(script);
  return promise;
}

let loading: Promise<void> | null = null;

/** Ensures the globals `Diff` (jsdiff) and `Diff2HtmlUI` are available. */
function ensureDiffLibs(): Promise<void> {
  if (window.Diff && window.Diff2HtmlUI) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      loadStyleOnce(CSS_HREF);
      for (const src of JS_SOURCES) await loadScript(src);
    })().catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-diff-tool]");
  if (!root) return;
  const toolRoot: HTMLElement = root;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const originalArea = root.querySelector<HTMLTextAreaElement>('[data-diff-text="original"]');
  const modifiedArea = root.querySelector<HTMLTextAreaElement>('[data-diff-text="modified"]');
  const outputArea = root.querySelector<HTMLElement>("[data-diff-output]");
  if (!originalArea || !modifiedArea || !outputArea) return;
  const originalText: HTMLTextAreaElement = originalArea;
  const modifiedText: HTMLTextAreaElement = modifiedArea;
  const outputEl: HTMLElement = outputArea;

  const statusEl = root.querySelector<HTMLElement>("[data-diff-status]");
  const errorEl = root.querySelector<HTMLElement>("[data-diff-error]");
  const originalFile = root.querySelector<HTMLInputElement>('[data-diff-file="original"]');
  const modifiedFile = root.querySelector<HTMLInputElement>('[data-diff-file="modified"]');

  const outputPanel = root.querySelector<HTMLElement>("[data-diff-output-panel]");
  const hostOf = (side: string) => toolRoot.querySelector<HTMLElement>(`[data-diff-host="${side}"]`);
  const originalHost = hostOf("original");
  const modifiedHost = hostOf("modified");
  const syncOriginal = originalHost ? bindEmptyState(originalHost, originalText) : () => {};
  const syncModified = modifiedHost ? bindEmptyState(modifiedHost, modifiedText) : () => {};
  root.querySelectorAll<HTMLButtonElement>("[data-diff-example]").forEach((btn) => {
    bindLoadExample(btn, () => {
      setFieldValue(originalText, strings.exampleOriginal ?? "");
      setFieldValue(modifiedText, strings.exampleModified ?? "");
    });
  });

  /** Result placeholder while there is neither a diff nor a status/error line. */
  function syncOutput(): void {
    if (!outputPanel) return;
    const empty = outputEl.hidden === true && (statusEl?.hidden ?? true) !== false && (errorEl?.hidden ?? true) !== false;
    syncEmptyState(outputPanel, empty);
  }

  let currentOriginal = originalText.value;
  let currentModified = modifiedText.value;

  const syncThemeClass = (): void => {
    outputEl.classList.toggle(
      "d2h-dark-color-scheme",
      document.documentElement.getAttribute("data-theme") === "dark",
    );
  };
  new MutationObserver(syncThemeClass).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  /** Info (role=status) or error (role=alert) line above the diff; null clears both. */
  function showAlert(message: string | null, kind: "info" | "error" = "info"): void {
    if (statusEl) {
      statusEl.textContent = kind === "info" ? (message ?? "") : "";
      statusEl.hidden = kind !== "info" || message === null;
    }
    if (errorEl) {
      errorEl.textContent = kind === "error" ? (message ?? "") : "";
      errorEl.hidden = kind !== "error" || message === null;
    }
    syncOutput();
  }

  const summaryEl = root.querySelector<HTMLElement>("[data-diff-summary]");
  const addedEl = root.querySelector<HTMLElement>("[data-diff-added]");
  const removedEl = root.querySelector<HTMLElement>("[data-diff-removed]");

  /** Fill one headline count: visible "+12" plus visually hidden "12 added". */
  function setCount(el: HTMLElement | null, sign: string, n: number, template: string | undefined): void {
    if (!el) return;
    const visible = document.createElement("span");
    visible.setAttribute("aria-hidden", "true");
    visible.textContent = `${sign}${n}`;
    const spoken = document.createElement("span");
    spoken.className = "visually-hidden";
    spoken.textContent = (template ?? "{0}").replace("{0}", String(n));
    el.replaceChildren(visible, spoken);
  }

  function renderSummary(patch: string | null): void {
    if (!summaryEl) return;
    summaryEl.hidden = patch === null;
    if (patch === null) return;
    const { added, removed } = countPatchLines(patch);
    setCount(addedEl, "+", added, strings.linesAdded);
    setCount(removedEl, "−", removed, strings.linesRemoved);
  }

  function hideOutput(): void {
    renderSummary(null);
    outputEl.innerHTML = "";
    outputEl.hidden = true;
    syncOutput();
  }

  async function renderDiff(): Promise<void> {
    if (!currentOriginal && !currentModified) {
      showAlert(null);
      hideOutput();
      return;
    }
    if (currentOriginal === currentModified) {
      hideOutput();
      showAlert(strings.noDifferences, "info");
      return;
    }
    showAlert(strings.loading, "info");
    try {
      await ensureDiffLibs();
    } catch {
      hideOutput();
      showAlert(strings.errorLibLoad, "error");
      return;
    }
    const DiffNs = window.Diff;
    const DiffUI = window.Diff2HtmlUI;
    if (!DiffNs || !DiffUI) {
      hideOutput();
      showAlert(strings.errorLibLoad, "error");
      return;
    }
    // Let the "Loading…" status paint before the synchronous diff blocks the thread.
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    let patch: string | undefined;
    try {
      // Over budget, jsdiff 5.1 yields no structured patch and createTwoFilesPatch throws.
      patch = DiffNs.createTwoFilesPatch("Original", "Modified", currentOriginal, currentModified, "", "", {
        maxEditLength: MAX_LINE_EDITS,
      });
    } catch {
      patch = undefined;
    }
    if (!patch) {
      hideOutput();
      showAlert(strings.diffTooBig.replace("{max}", String(MAX_LINE_EDITS)), "error");
      return;
    }
    // Legacy config; diffMax* caps are the large-diff optimization.
    const configuration = {
      drawFileList: false,
      matching: "lines",
      outputFormat: toolRoot.querySelector<HTMLInputElement>("[data-diff-mode]:checked")?.value ?? "side-by-side",
      highlight: true,
      renderNothingWhenEmpty: false,
      diffMaxChanges: MAX_LINE_EDITS,
      diffMaxLineLength: 1000,
    };
    showAlert(null);
    renderSummary(patch);
    outputEl.innerHTML = "";
    outputEl.hidden = false;
    syncOutput();
    syncThemeClass();
    const ui = new DiffUI(outputEl, patch, configuration);
    ui.draw();
    try {
      ui.highlightCode();
    } catch (e) {
      console.warn("Syntax highlighting failed", e);
    }
  }

  root.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    const loadBtn = target.closest<HTMLButtonElement>("[data-diff-load]");
    if (loadBtn) {
      e.preventDefault();
      const input = loadBtn.dataset.diffLoad === "original" ? originalFile : modifiedFile;
      input?.click();
      return;
    }

    if (target.closest("[data-diff-compare]")) {
      e.preventDefault();
      currentOriginal = originalText.value;
      currentModified = modifiedText.value;
      if (!currentOriginal && !currentModified) {
        hideOutput();
        showAlert(strings.errorEmpty, "error");
        originalText.focus();
        return;
      }
      // Explicit Compare: bring the result into view on phones once drawn.
      void renderDiff().then(() => revealOutput(outputPanel));
      return;
    }

    if (target.closest("[data-diff-clear]")) {
      e.preventDefault();
      originalText.value = "";
      modifiedText.value = "";
      currentOriginal = "";
      currentModified = "";
      if (originalFile) originalFile.value = "";
      if (modifiedFile) modifiedFile.value = "";
      syncOriginal();
      syncModified();
      hideOutput();
      showAlert(null);
      originalText.focus();
    }
  });

  root.querySelectorAll<HTMLInputElement>("[data-diff-mode]").forEach((radio) => {
    radio.addEventListener("change", () => {
      if (currentOriginal || currentModified) void renderDiff();
    });
  });

  const bindFile = (
    input: HTMLInputElement | null,
    area: HTMLTextAreaElement,
    isOriginal: boolean,
  ): void => {
    if (!input) return;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        area.value = text;
        if (isOriginal) syncOriginal();
        else syncModified();
        // Read back the field value: textarea normalizes CRLF → LF, so the
        // auto-compare matches a later manual Compare (CRLF file vs LF file
        // used to show every line as changed only on auto-compare).
        if (isOriginal) currentOriginal = area.value;
        else currentModified = area.value;
        // Auto-trigger once both sides have content (legacy parity).
        if (currentOriginal && currentModified) void renderDiff();
      };
      reader.onerror = () => {
        hideOutput();
        showAlert(strings.fileReadError, "error");
      };
      // Same file picked again must still fire `change`.
      reader.onloadend = () => {
        input.value = "";
      };
      reader.readAsText(file);
    });
  };
  bindFile(originalFile, originalText, true);
  bindFile(modifiedFile, modifiedText, false);
  syncOutput();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
