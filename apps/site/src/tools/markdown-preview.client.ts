/**
 * Markdown Preview client. Split-view editor: renders the textarea's markdown
 * into the preview pane with `marked` (vendored `lib/marked.min.js`, loaded on
 * demand, base-path aware). Legacy parity: marked options { breaks, gfm,
 * headerIds, mangle } (v11 ignores the removed headerIds/mangle — defaults
 * match), no debounce, formatting inserts,
 * two-way proportional sync scroll, copy HTML/markdown (width-stable copy
 * feedback), download standalone .html. The editor starts empty (empty state);
 * the localized sample loads only via "Load example". Deviation: the
 * marked output is sanitized (`markdown-sanitize.ts`) before insertion, so
 * raw HTML/`javascript:` links in the markdown cannot execute. Preview headings
 * are demoted one level (`demoteHeadings`) so the page keeps a single h1;
 * Copy HTML / Download export the sanitized HTML with the original levels.
 */
import { demoteHeadings, sanitizeHtml } from "@/tools/markdown-sanitize";
import { bindEmptyState, bindLoadExample, copyWithFeedback, setFieldValue, syncEmptyState } from "@/scripts/tool-ui";

interface MarkedGlobal {
  parse(src: string, options?: Record<string, unknown>): string;
}

declare global {
  interface Window {
    marked?: MarkedGlobal;
  }
}

interface Strings {
  copied: string;
  copyFailed: string;
  renderError: string;
  markedLoadFailed: string;
  /** Localized sample document (locale `ExampleMarkdown`). */
  example: string;
}

/** Legacy marked options, ported verbatim. */
const MARKED_OPTIONS = { breaks: true, gfm: true, headerIds: true, mangle: false };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

let markedLoading: Promise<void> | null = null;

/** Ensures the global `marked` is available (cached, already-loaded safe). */
function ensureMarked(): Promise<void> {
  if (window.marked) return Promise.resolve();
  if (!markedLoading) {
    markedLoading = new Promise<void>((resolve, reject) => {
      const src = `${BASE}/lib/marked.min.js`;
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "true") {
          resolve();
          return;
        }
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.addEventListener("load", () => {
        script.dataset.loaded = "true";
        resolve();
      }, { once: true });
      script.addEventListener("error", () => {
        // Drop the failed tag so a retry injects a fresh one (no stuck promise).
        script.remove();
        reject(new Error(`Failed to load ${src}`));
      }, { once: true });
      document.body.appendChild(script);
    }).catch((err: unknown) => {
      markedLoading = null;
      throw err;
    });
  }
  return markedLoading;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-md-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-md-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const inputEl = root.querySelector<HTMLTextAreaElement>("[data-md-input]");
  const outputEl = root.querySelector<HTMLElement>("[data-md-output]");
  const errorEl = root.querySelector<HTMLElement>("[data-md-error]");
  if (!inputEl || !outputEl || !errorEl) return;
  const input: HTMLTextAreaElement = inputEl;
  const output: HTMLElement = outputEl;
  const errorDiv: HTMLElement = errorEl;

  const syncToggle = root.querySelector<HTMLInputElement>("[data-md-sync-scroll]");
  const inputHost = root.querySelector<HTMLElement>("[data-md-input-host]");
  const outputPanel = root.querySelector<HTMLElement>("[data-md-output-panel]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-md-example]");
  const syncInput = inputHost ? bindEmptyState(inputHost, input) : () => {};

  /** Sanitized HTML with original heading levels — what Copy HTML / Download export. */
  let exportHtml = "";

  function renderMarkdown(): void {
    // Empty editor → compact preview placeholder; programmatic writes resync the editor too.
    syncInput();
    if (outputPanel) syncEmptyState(outputPanel, input.value === "");
    try {
      if (window.marked) {
        const fragment = sanitizeHtml(window.marked.parse(input.value, MARKED_OPTIONS));
        const holder = document.createElement("div");
        holder.append(fragment.cloneNode(true));
        exportHtml = holder.innerHTML;
        demoteHeadings(fragment);
        output.replaceChildren(fragment);
      } else {
        exportHtml = "";
        output.textContent = "";
        const p = document.createElement("p");
        p.className = "md-lib-error";
        p.textContent = strings.markedLoadFailed;
        output.appendChild(p);
      }
      errorDiv.hidden = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorDiv.textContent = strings.renderError.replace("{message}", message);
      errorDiv.hidden = false;
    }
  }

  function insertAtCursor(before: string, after = ""): void {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selectedText = input.value.substring(start, end);
    const newText = before + selectedText + after;

    input.value = input.value.substring(0, start) + newText + input.value.substring(end);

    const newCursorPos = start + before.length + selectedText.length;
    input.setSelectionRange(newCursorPos, newCursorPos);
    input.focus();
    renderMarkdown();
  }

  function insertAtLine(prefix: string): void {
    const start = input.selectionStart;
    const lines = input.value.split("\n");
    let currentPos = 0;
    let lineIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (currentPos + line.length >= start) {
        lineIndex = i;
        break;
      }
      currentPos += line.length + 1; // +1 for newline
    }

    lines[lineIndex] = prefix + (lines[lineIndex] ?? "");
    input.value = lines.join("\n");

    const newCursorPos = start + prefix.length;
    input.setSelectionRange(newCursorPos, newCursorPos);
    input.focus();
    renderMarkdown();
  }

  async function copyToClipboard(text: string, button: HTMLButtonElement): Promise<void> {
    if (await copyWithFeedback(button, text, strings.copied)) return;
    errorDiv.textContent = strings.copyFailed;
    errorDiv.hidden = false;
  }

  /** Legacy download: standalone HTML document with inline print styles. */
  function downloadAsHTML(): void {
    const htmlContent =
      '<!DOCTYPE html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '    <meta charset="UTF-8">\n' +
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '    <title>Markdown Preview</title>\n' +
      '    <style>\n' +
      '        body {\n' +
      '            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\n' +
      '            line-height: 1.6;\n' +
      '            max-width: 800px;\n' +
      '            margin: 2rem auto;\n' +
      '            padding: 0 1rem;\n' +
      '            color: #333;\n' +
      '        }\n' +
      '        code {\n' +
      '            background: #f4f4f4;\n' +
      '            padding: 0.2em 0.4em;\n' +
      '            border-radius: 3px;\n' +
      '            font-family: "Courier New", monospace;\n' +
      '        }\n' +
      '        pre {\n' +
      '            background: #f4f4f4;\n' +
      '            padding: 1rem;\n' +
      '            border-radius: 5px;\n' +
      '            overflow-x: auto;\n' +
      '        }\n' +
      '        pre code {\n' +
      '            background: none;\n' +
      '            padding: 0;\n' +
      '        }\n' +
      '        table {\n' +
      '            border-collapse: collapse;\n' +
      '            width: 100%;\n' +
      '            margin: 1rem 0;\n' +
      '        }\n' +
      '        th, td {\n' +
      '            border: 1px solid #ddd;\n' +
      '            padding: 0.5rem;\n' +
      '            text-align: left;\n' +
      '        }\n' +
      '        th {\n' +
      '            background: #f4f4f4;\n' +
      '        }\n' +
      '        blockquote {\n' +
      '            border-left: 4px solid #ddd;\n' +
      '            padding-left: 1rem;\n' +
      '            margin-left: 0;\n' +
      '            color: #666;\n' +
      '        }\n' +
      '        img {\n' +
      '            max-width: 100%;\n' +
      '        }\n' +
      '    </style>\n' +
      '</head>\n' +
      '<body>\n' +
      exportHtml +
      '\n</body>\n' +
      '</html>';

    const blob = new Blob([htmlContent], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "markdown-preview.html";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Live preview — legacy has no debounce. If marked failed to load earlier
  // (offline/flaky network), retry on the next edit instead of staying broken.
  input.addEventListener("input", () => {
    if (window.marked) renderMarkdown();
    else void ensureMarked().catch(() => undefined).finally(renderMarkdown);
  });

  // Toolbar inserts (legacy mappings).
  const INSERT_HANDLERS: Record<string, () => void> = {
    bold: () => insertAtCursor("**", "**"),
    italic: () => insertAtCursor("*", "*"),
    heading: () => insertAtLine("## "),
    link: () => insertAtCursor("[", "](url)"),
    image: () => insertAtCursor("![alt text](", ")"),
    code: () => insertAtCursor("`", "`"),
    list: () => insertAtLine("- "),
  };
  root.querySelectorAll<HTMLButtonElement>("[data-md-insert]").forEach((btn) => {
    const kind = btn.dataset.mdInsert ?? "";
    const handler = INSERT_HANDLERS[kind];
    if (handler) btn.addEventListener("click", handler);
  });

  const clearBtn = root.querySelector<HTMLButtonElement>("[data-md-clear]");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      input.value = "";
      renderMarkdown();
    });
  }

  const copyHtmlBtn = root.querySelector<HTMLButtonElement>("[data-md-copy-html]");
  if (copyHtmlBtn) {
    copyHtmlBtn.addEventListener("click", () => {
      void copyToClipboard(exportHtml, copyHtmlBtn);
    });
  }

  const copyMdBtn = root.querySelector<HTMLButtonElement>("[data-md-copy-md]");
  if (copyMdBtn) {
    copyMdBtn.addEventListener("click", () => {
      void copyToClipboard(input.value, copyMdBtn);
    });
  }

  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-md-download]");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", downloadAsHTML);
  }

  // Two-way proportional sync scroll (legacy logic, re-entrancy guards).
  let isSyncingLeft = false;
  let isSyncingRight = false;

  input.addEventListener("scroll", () => {
    if (!syncToggle || !syncToggle.checked) return;
    if (isSyncingLeft) return;
    isSyncingRight = true;
    const inputRange = input.scrollHeight - input.clientHeight;
    const percentage = inputRange > 0 ? input.scrollTop / inputRange : 0;
    output.scrollTop = percentage * (output.scrollHeight - output.clientHeight);
    requestAnimationFrame(() => {
      isSyncingRight = false;
    });
  });

  output.addEventListener("scroll", () => {
    if (!syncToggle || !syncToggle.checked) return;
    if (isSyncingRight) return;
    isSyncingLeft = true;
    const outputRange = output.scrollHeight - output.clientHeight;
    const percentage = outputRange > 0 ? output.scrollTop / outputRange : 0;
    input.scrollTop = percentage * (input.scrollHeight - input.clientHeight);
    requestAnimationFrame(() => {
      isSyncingLeft = false;
    });
  });

  // Sample document only on explicit request (never preloaded silently).
  if (exampleBtn) bindLoadExample(exampleBtn, () => setFieldValue(input, strings.example));

  // Load marked on demand, then initial render.
  void ensureMarked()
    .catch(() => {
      /* renderMarkdown surfaces the load failure in the preview pane */
    })
    .finally(() => {
      renderMarkdown();
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
