/**
 * JSON Beautifier client controller. CodeMirror 6 editor (lazy kit via
 * `loadEditorKit`) + `formatJson` (indent 2/4/tab, sort keys, compact,
 * exact number preservation). Open/save .json, drop a file onto the editor,
 * copy/clear, Ctrl/Cmd-Enter format, Esc→Tab leaves the editor. Invalid
 * JSON: `locateJsonError` finds the exact token + reason, shown as an editor
 * diagnostic ("Trailing comma — line 3, column 17" + Go to error).
 *
 * PRIVACY: legacy persisted the input text to localStorage; that is
 * intentionally NOT ported. Only the formatting settings persist.
 * Empty editor shows a hint + "Load example" overlay (sample inserted only on click).
 */
import { bindEditorFileDrop, downloadText, loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { bindLoadExample, copyWithFeedback, syncEmptyState } from "@/scripts/tool-ui";
import { locateJsonError } from "@/tools/json-diagnostics";
import { formatJson } from "@/tools/json-format";
import { presentDiagnostic, shiftDiagnostic, type DiagnosticStrings } from "@/tools/parse-diagnostics";

interface Strings {
  errorInvalidJson: string;
  copied: string;
  copyFailed?: string;
  inputLabel: string;
  phrases?: Record<string, string>;
  /** `Diag_*` templates (`diagnosticStrings`). */
  diag: DiagnosticStrings;
}

/** "Load example" sample: compact, unsorted JSON so Format / Sort keys visibly change it. */
const EXAMPLE =
  '{"name":"mydevtools","version":"2.4.0","private":true,"scripts":{"dev":"astro dev","build":"astro build"},' +
  '"engines":{"node":">=22"},"keywords":["json","formatter",42,null],"limits":{"maxBytes":1048576,"ratio":0.75}}';

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
  // Unknown-location fallback reads "Invalid JSON. Please check your input. (…)".
  const diagStrings: DiagnosticStrings = { ...str.diag, SyntaxNoLocation: str.errorInvalidJson };
  const editorHost: HTMLElement = host;

  const clearBtn = root.querySelector<HTMLButtonElement>("[data-json-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-json-copy]");
  const indentSelect = root.querySelector<HTMLSelectElement>("[data-json-indent]");
  const sortKeys = root.querySelector<HTMLInputElement>("[data-json-sort]");
  const compact = root.querySelector<HTMLInputElement>("[data-json-compact]");
  const saveBtn = root.querySelector<HTMLButtonElement>("[data-json-save]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-json-file]");
  const errorBox = root.querySelector<HTMLElement>("[data-json-error]");
  const emptyHost = root.querySelector<HTMLElement>("[data-json-editor-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-json-example]");

  let editor: MdtEditor;
  try {
    const kit = await loadEditorKit();
    editor = await kit.createEditor(editorHost, {
      language: "json",
      label: str.inputLabel,
      phrases: str.phrases,
      hintId: "json-editor-hint",
      indent: 4,
      diagnostics: errorBox ? { box: errorBox, goToLabel: str.diag.GoTo ?? "" } : undefined,
      onSubmit: () => formatAction(true),
      onChange: () => syncEmpty(),
    });
  } catch (err) {
    console.error("JSON Beautifier: failed to load the editor:", err);
    return;
  }

  /** Empty-state overlay follows the document (typing, Open, drop, Clear). */
  function syncEmpty() {
    if (emptyHost) syncEmptyState(emptyHost, editor.getValue() === "");
  }
  syncEmpty();
  if (exampleBtn) bindLoadExample(exampleBtn, () => editor.setValue(EXAMPLE), editor.view.contentDOM);

  // Restore saved settings (input text persistence intentionally dropped — privacy).
  const savedIndent = storageGet(KEYS.indent);
  if (savedIndent && indentSelect && [...indentSelect.options].some((o) => o.value === savedIndent)) {
    indentSelect.value = savedIndent;
  }
  if (sortKeys) sortKeys.checked = storageGet(KEYS.sort) === "true";
  if (compact) compact.checked = storageGet(KEYS.compact) === "true";

  /** Non-parse failures (file read): message without a location. */
  function setError(message: string) {
    editor.setDiagnostic(message ? { message, from: null, to: null } : null);
  }

  /** `announce`: only explicit Format / Ctrl-Enter reads the error out (not settings auto-format). */
  function formatAction(announce = false) {
    const value = editor.getValue();
    const input = value.trim();
    if (!input) {
      setError("");
      return;
    }
    const indent = indentSelect?.value ?? "4";
    try {
      const formatted = formatJson(input, { indent, sortKeys: Boolean(sortKeys?.checked), compact: Boolean(compact?.checked) });
      editor.setValue(formatted);
      // Keep the editor's own indentation in line with the chosen style.
      if (!compact?.checked) editor.setIndent(indent === "tab" ? "tab" : Number.parseInt(indent, 10) || 4);
      setError("");
    } catch (e) {
      // Position from our own scanner (engine messages differ per browser); offsets
      // are into the trimmed text, shifted back to the document.
      const found = locateJsonError(input);
      const diag = found
        ? shiftDiagnostic(found, value.length - value.trimStart().length)
        : { messageKey: "Syntax", from: null, to: null, detail: e instanceof Error ? e.message : String(e) };
      editor.setDiagnostic(presentDiagnostic(diagStrings, diag, value), { announce });
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

  formatBtn.addEventListener("click", () => formatAction(true));
  clearBtn?.addEventListener("click", clearAll);
  copyBtn?.addEventListener("click", () => {
    void copyWithFeedback(copyBtn, editor.getValue(), str.copied, undefined, { failedLabel: str.copyFailed });
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

  // Ctrl/Cmd-Enter formats (onSubmit). Legacy also bound Ctrl/Cmd-K to clear;
  // that chord is the site-wide command palette, so it is not bound here.

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
