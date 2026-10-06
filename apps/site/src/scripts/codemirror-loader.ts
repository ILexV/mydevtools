/**
 * CodeMirror 5 loader. The structured-data tools (json/xml/yaml beautifiers,
 * json-to-typescript) reuse the legacy vendored CodeMirror build from
 * `public/lib/codemirror/` (copied from the Blazor site — parity, zero npm
 * deps). Assets load on demand, sequentially (modes/addons depend on the
 * core global), only when a tool page first needs an editor.
 *
 * Base-path aware: works under `base=/mydevtools/` in production.
 *
 * Also exports the shared editor helpers (typed editor surface, Esc→Tab
 * keyboard escape + screen-reader label, theme refresh, file drop onto an
 * editor, text download). Theme CSS lives in `styles/codemirror.css`.
 */

declare global {
  interface Window {
    CodeMirror?: unknown;
  }
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const STYLES = [
  "lib/codemirror/codemirror.min.css",
  "lib/codemirror/addon/fold/foldgutter.min.css",
];

const SCRIPTS = [
  "lib/codemirror/codemirror.min.js",
  "lib/codemirror/mode/javascript/javascript.min.js",
  "lib/codemirror/addon/fold/foldcode.min.js",
  "lib/codemirror/addon/fold/foldgutter.min.js",
  "lib/codemirror/addon/fold/brace-fold.min.js",
  "lib/codemirror/addon/edit/closebrackets.min.js",
  "lib/codemirror/addon/edit/matchbrackets.min.js",
];

function loadStyle(href: string): void {
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

/** Ensures the global `CodeMirror` constructor is available. */
export function ensureCodeMirror(): Promise<void> {
  if (window.CodeMirror) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      for (const href of STYLES) loadStyle(`${BASE}/${href}`);
      for (const src of SCRIPTS) await loadScript(`${BASE}/${src}`);
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

// ─── Shared editor helpers (structured-data tools) ──────────────────────────

/** Minimal CodeMirror 5 editor surface the tools use (vendored build ships no types). */
export interface CmEditor {
  getValue(): string;
  setValue(value: string): void;
  setOption(name: string, value: unknown): void;
  getOption(name: string): unknown;
  setSize(width: number | string | null, height: number | string | null): void;
  on(event: string, handler: (...args: never[]) => void): void;
  refresh(): void;
  focus(): void;
  getWrapperElement(): HTMLElement;
  getInputField(): HTMLTextAreaElement;
}

export type CmFactory = (host: HTMLElement, options: Record<string, unknown>) => CmEditor;

/** The global CodeMirror constructor once `ensureCodeMirror()` resolved, else null. */
export function getCodeMirror<T = CmFactory>(): T | null {
  return typeof window.CodeMirror === "function" ? (window.CodeMirror as T) : null;
}

/**
 * Keyboard escape hatch (WCAG 2.1.2, no keyboard trap): in an editable editor
 * Tab indents as usual, but Esc followed by Tab / Shift-Tab moves focus out.
 * Read-only editors never capture Tab. Also names the hidden input for
 * screen readers and links the visible keyboard hint.
 */
export function makeEditorAccessible(editor: CmEditor, label: string, hintId?: string): void {
  let escaped = false;
  editor.on("keydown", ((_cm: unknown, e: KeyboardEvent & { codemirrorIgnore?: boolean }) => {
    if (e.key === "Escape") {
      escaped = true;
      return;
    }
    if (e.key === "Tab" && (escaped || editor.getOption("readOnly"))) {
      // CodeMirror skips events flagged this way → browser default focus move.
      e.codemirrorIgnore = true;
    }
    escaped = false;
  }) as never);
  editor.on("blur", (() => {
    escaped = false;
  }) as never);
  const field = editor.getInputField();
  field.setAttribute("aria-label", label);
  if (hintId) field.setAttribute("aria-describedby", hintId);
  if (editor.getOption("readOnly")) field.setAttribute("aria-readonly", "true");
}

/** Re-measure editors when the site theme toggles (fonts/colors change metrics). */
export function refreshOnThemeChange(editors: CmEditor[]): void {
  new MutationObserver(() => editors.forEach((e) => e.refresh())).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

/**
 * Drop a file onto an editor host: `.is-dragover` while dragging files, the
 * first accepted file goes to `onFile`. Capture-phase listeners stop
 * CodeMirror's own drop handler from also inserting the file text; plain
 * text drags (no files) still reach the editor.
 */
export function bindEditorFileDrop(host: HTMLElement, accept: (file: File) => boolean, onFile: (file: File) => void): void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  host.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    host.classList.add("is-dragover");
  }, true);
  host.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, true);
  host.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) host.classList.remove("is-dragover");
  }, true);
  host.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    host.classList.remove("is-dragover");
    const file = Array.from(e.dataTransfer?.files ?? []).find(accept);
    if (file) onFile(file);
  }, true);
}

/** Save `text` as a download (object URL revoked after the click is handled). */
export function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
