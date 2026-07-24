/**
 * Text Diff Viewer client. Builds a unified diff from the two inputs with
 * vendored jsdiff (global `Diff`) and renders it with vendored diff2html-ui
 * (global `Diff2HtmlUI`). Both are loaded on demand from `public/lib`,
 * base-path aware, sequentially in legacy order (jsdiff → diff2html-ui),
 * with the load promise cached. View modes: side-by-side (default) /
 * line-by-line. Loading a file fills its side and auto-compares once both
 * sides have content. Dark theme toggles diff2html's `d2h-dark-color-scheme`
 * class (the vendored CSS ships dark variables behind that class).
 */

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
}

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
  script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
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

  const originalFile = root.querySelector<HTMLInputElement>('[data-diff-file="original"]');
  const modifiedFile = root.querySelector<HTMLInputElement>('[data-diff-file="modified"]');

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

  function showAlert(message: string, kind: "info" | "error"): void {
    outputEl.hidden = false;
    outputEl.innerHTML = "";
    const div = document.createElement("div");
    div.className = `diff-alert diff-alert-${kind}`;
    div.textContent = message;
    outputEl.appendChild(div);
  }

  async function renderDiff(): Promise<void> {
    if (!currentOriginal && !currentModified) {
      outputEl.innerHTML = "";
      outputEl.hidden = true;
      return;
    }
    showAlert(strings.loading, "info");
    try {
      await ensureDiffLibs();
    } catch {
      showAlert(strings.errorLibLoad, "error");
      return;
    }
    const DiffNs = window.Diff;
    const DiffUI = window.Diff2HtmlUI;
    if (!DiffNs || !DiffUI) {
      showAlert(strings.errorLibLoad, "error");
      return;
    }
    const patch = DiffNs.createTwoFilesPatch(
      "Original",
      "Modified",
      currentOriginal,
      currentModified,
      "",
      "",
    );
    if (!patch) {
      showAlert(strings.errorLibLoad, "error");
      return;
    }
    // Legacy config; diffMax* caps are the large-diff optimization.
    const configuration = {
      drawFileList: false,
      matching: "lines",
      outputFormat: toolRoot.querySelector<HTMLInputElement>("[data-diff-mode]:checked")?.value ?? "side-by-side",
      highlight: true,
      renderNothingWhenEmpty: false,
      diffMaxChanges: 1000,
      diffMaxLineLength: 1000,
    };
    outputEl.innerHTML = "";
    outputEl.hidden = false;
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
        showAlert(strings.errorEmpty, "error");
        return;
      }
      void renderDiff();
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
      outputEl.innerHTML = "";
      outputEl.hidden = true;
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
        if (isOriginal) currentOriginal = text;
        else currentModified = text;
        // Auto-trigger once both sides have content (legacy parity).
        if (currentOriginal && currentModified) void renderDiff();
      };
      reader.readAsText(file);
    });
  };
  bindFile(originalFile, originalText, true);
  bindFile(modifiedFile, modifiedText, false);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
