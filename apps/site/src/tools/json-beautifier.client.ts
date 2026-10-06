/**
 * JSON Beautifier client controller. CodeMirror 5 editor (`ensureCodeMirror`,
 * vendored legacy build) + `formatJson` (indent 2/4/tab, sort keys, compact,
 * exact number preservation). Open/save .json, drop a file onto the editor,
 * copy/clear, Ctrl/Cmd-Enter format, Esc→Tab leaves the editor.
 *
 * PRIVACY: legacy persisted the input text to localStorage; that is
 * intentionally NOT ported. Only the formatting settings persist.
 */
import {
  bindEditorFileDrop,
  downloadText,
  ensureCodeMirror,
  getCodeMirror,
  makeEditorAccessible,
  refreshOnThemeChange,
} from "@/scripts/codemirror-loader";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { formatJson } from "@/tools/json-format";

interface Strings {
  errorInvalidJson: string;
  copied: string;
  inputLabel: string;
}

const KEYS = {
  indent: "json-beautifier-indent",
  sort: "json-beautifier-sort-keys",
  compact: "json-beautifier-compact-mode",
};

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-json-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

async function init() {
  const root = document.querySelector<HTMLElement>("[data-json-tool]");
  if (!root || root.dataset.initialized === "true") return;
  const strings = readStrings();
  const host = root.querySelector<HTMLElement>("[data-json-editor]");
  const formatBtn = root.querySelector<HTMLButtonElement>("[data-json-format]");
  if (!strings || !host || !formatBtn) return;
  root.dataset.initialized = "true";
  const str: Strings = strings;
  const editorHost: HTMLElement = host;

  const clearBtn = root.querySelector<HTMLButtonElement>("[data-json-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-json-copy]");
  const indentSelect = root.querySelector<HTMLSelectElement>("[data-json-indent]");
  const sortKeys = root.querySelector<HTMLInputElement>("[data-json-sort]");
  const compact = root.querySelector<HTMLInputElement>("[data-json-compact]");
  const saveBtn = root.querySelector<HTMLButtonElement>("[data-json-save]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-json-file]");
  const errorBox = root.querySelector<HTMLElement>("[data-json-error]");

  try {
    await ensureCodeMirror();
  } catch (err) {
    console.error("JSON Beautifier: failed to load CodeMirror:", err);
    return;
  }
  const CM = getCodeMirror();
  if (!CM) return;

  const editor = CM(editorHost, {
    mode: { name: "javascript", json: true },
    lineNumbers: true,
    lineWrapping: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 4,
    tabSize: 4,
    theme: "default",
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  });
  makeEditorAccessible(editor, str.inputLabel, "json-editor-hint");
  refreshOnThemeChange([editor]);

  // Restore saved settings (input text persistence intentionally dropped — privacy).
  const savedIndent = storageGet(KEYS.indent);
  if (savedIndent && indentSelect && [...indentSelect.options].some((o) => o.value === savedIndent)) {
    indentSelect.value = savedIndent;
  }
  if (sortKeys) sortKeys.checked = storageGet(KEYS.sort) === "true";
  if (compact) compact.checked = storageGet(KEYS.compact) === "true";

  function setError(message: string) {
    editorHost.classList.toggle("is-error", Boolean(message));
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = !message;
    }
  }

  function formatAction() {
    const input = editor.getValue().trim();
    if (!input) {
      setError("");
      return;
    }
    const indent = indentSelect?.value ?? "4";
    try {
      const formatted = formatJson(input, { indent, sortKeys: Boolean(sortKeys?.checked), compact: Boolean(compact?.checked) });
      editor.setValue(formatted);
      // Keep CodeMirror's own indentation in line with the chosen style.
      if (!compact?.checked) {
        const unit = indent === "tab" ? 4 : Number.parseInt(indent, 10) || 4;
        editor.setOption("indentWithTabs", indent === "tab");
        editor.setOption("indentUnit", unit);
        editor.setOption("tabSize", unit);
      }
      setError("");
    } catch (e) {
      const detail = e instanceof Error && e.message ? ` (${e.message})` : "";
      setError(str.errorInvalidJson + detail);
    }
  }

  function clearAll() {
    editor.setValue("");
    setError("");
    editor.focus();
  }

  async function loadFile(file: File) {
    try {
      editor.setValue(await file.text());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  formatBtn.addEventListener("click", formatAction);
  clearBtn?.addEventListener("click", clearAll);
  copyBtn?.addEventListener("click", () => {
    void copyWithFeedback(copyBtn, editor.getValue(), str.copied);
  });
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
    fileInput.value = ""; // re-selecting the same file fires change again
  });
  saveBtn?.addEventListener("click", () => downloadText(editor.getValue(), "formatted.json", "application/json"));

  // Auto-format on settings change (legacy parity; settings persist, input does not).
  indentSelect?.addEventListener("change", () => {
    storageSet(KEYS.indent, indentSelect.value);
    if (editor.getValue().trim()) formatAction();
  });
  sortKeys?.addEventListener("change", () => {
    storageSet(KEYS.sort, String(sortKeys.checked));
    if (editor.getValue().trim()) formatAction();
  });
  compact?.addEventListener("change", () => {
    storageSet(KEYS.compact, String(compact.checked));
    if (editor.getValue().trim()) formatAction();
  });

  // Legacy also bound Ctrl/Cmd-K to clear; that chord is the site-wide command
  // palette (captured on window), so only the format shortcut remains.
  editor.setOption("extraKeys", {
    "Ctrl-Enter": formatAction,
    "Cmd-Enter": formatAction,
  });

  bindEditorFileDrop(
    editorHost,
    (f) => f.type === "application/json" || f.name.toLowerCase().endsWith(".json"),
    (f) => void loadFile(f),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
