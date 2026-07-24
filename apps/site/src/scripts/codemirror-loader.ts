/**
 * CodeMirror 5 loader. The structured-data tools (json/xml/yaml beautifiers,
 * json-to-typescript) reuse the legacy vendored CodeMirror build from
 * `public/lib/codemirror/` (copied from the Blazor site — parity, zero npm
 * deps). Assets load on demand, sequentially (modes/addons depend on the
 * core global), only when a tool page first needs an editor.
 *
 * Base-path aware: works under `base=/mydevtools/` in production.
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
