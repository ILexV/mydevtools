/**
 * XML Beautifier client controller. CodeMirror 6 (lazy editor kit,
 * `@codemirror/lang-xml` highlight + element folding); formatting via `formatXml` (DOMParser +
 * pure serializer in `xml-format.ts`). Open/save, drop a file onto the
 * editor, copy/clear, Ctrl/Cmd-Enter format, Esc→Tab leaves the editor.
 *
 * PRIVACY: legacy persisted the input text to localStorage on every change
 * (`xml-beautifier-input`). That is intentionally NOT ported — user data
 * never leaves the page. Only the indent / compact-mode settings are kept.
 * Empty editor shows a hint + "Load example" overlay (sample inserted only on click).
 */
import { bindEditorFileDrop, downloadText, loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { bindLoadExample, copyWithFeedback, syncEmptyState } from "@/scripts/tool-ui";
import { formatXml, XmlParseError } from "@/tools/xml-format";

/** "Load example" sample: unindented XML with a declaration, attributes, CDATA and a comment. */
const EXAMPLE =
  '<?xml version="1.0" encoding="UTF-8"?><catalog xmlns="urn:example:books"><!-- v2 -->' +
  '<book id="bk101" lang="en"><title>XSLT 3.0</title><price currency="EUR">44.95</price>' +
  '<tags><tag>xml</tag><tag>format</tag></tags></book><book id="bk102"><title><![CDATA[a < b && c > d]]></title>' +
  '<price currency="USD">5.95</price><available/></book></catalog>';

interface Strings {
  copied: string;
  copyFailed?: string;
  errorInvalidXml: string;
  inputLabel: string;
  phrases?: Record<string, string>;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-xml-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

async function init(): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-xml-tool]");
  if (!root || root.dataset.initialized === "true") return;
  const raw = readStrings();
  const editorEl = root.querySelector<HTMLElement>("[data-xml-editor]");
  const formatBtn = root.querySelector<HTMLButtonElement>("[data-xml-format]");
  if (!raw || !editorEl || !formatBtn) return;
  root.dataset.initialized = "true";
  const strings: Strings = raw;
  const editorHost: HTMLElement = editorEl;

  const clearBtn = root.querySelector<HTMLButtonElement>("[data-xml-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-xml-copy]");
  const indentSelect = root.querySelector<HTMLSelectElement>("[data-xml-indent]");
  const compactCheckbox = root.querySelector<HTMLInputElement>("[data-xml-compact]");
  const saveBtn = root.querySelector<HTMLButtonElement>("[data-xml-save]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-xml-file]");
  const errorBox = root.querySelector<HTMLElement>("[data-xml-error]");
  const emptyHost = root.querySelector<HTMLElement>("[data-xml-editor-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-xml-example]");

  let editor: MdtEditor;
  try {
    const kit = await loadEditorKit();
    editor = await kit.createEditor(editorHost, {
      language: "xml",
      label: strings.inputLabel,
      phrases: strings.phrases,
      hintId: "xml-editor-hint",
      indent: 4,
      onSubmit: () => formatAction(),
      onChange: () => syncEmpty(),
    });
  } catch (err) {
    console.error("XML Beautifier: failed to load the editor", err);
    return;
  }

  /** Empty-state overlay follows the document (typing, Open, drop, Clear). */
  function syncEmpty() {
    if (emptyHost) syncEmptyState(emptyHost, editor.getValue() === "");
  }
  syncEmpty();
  if (exampleBtn) bindLoadExample(exampleBtn, () => editor.setValue(EXAMPLE), editor.view.contentDOM);

  // Settings persistence (parity). Input text is intentionally NOT persisted.
  try {
    const savedIndent = localStorage.getItem("xml-beautifier-indent");
    if (savedIndent && indentSelect && [...indentSelect.options].some((o) => o.value === savedIndent)) {
      indentSelect.value = savedIndent;
    }
    if (compactCheckbox) compactCheckbox.checked = localStorage.getItem("xml-beautifier-compact-mode") === "true";
  } catch {
    /* storage unavailable */
  }

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
    const indentValue = indentSelect?.value === "tab" ? "\t" : Number.parseInt(indentSelect?.value || "4", 10) || 4;
    const compact = compactCheckbox?.checked ?? false;
    try {
      editor.setValue(formatXml(input, indentValue, compact));
      if (!compact) editor.setIndent(indentValue === "\t" ? "tab" : indentValue);
      setError("");
    } catch (e) {
      const detail = e instanceof XmlParseError && e.message ? ` (${e.message})` : "";
      setError(strings.errorInvalidXml + detail);
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

  function saveSetting(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }

  formatBtn.addEventListener("click", formatAction);
  clearBtn?.addEventListener("click", clearAll);
  copyBtn?.addEventListener("click", () => {
    void copyWithFeedback(copyBtn, editor.getValue(), strings.copied, undefined, { failedLabel: strings.copyFailed });
  });
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
    fileInput.value = "";
  });
  saveBtn?.addEventListener("click", () => downloadText(editor.getValue(), "formatted.xml", "application/xml"));

  indentSelect?.addEventListener("change", () => {
    saveSetting("xml-beautifier-indent", indentSelect.value);
    if (editor.getValue().trim()) formatAction();
  });
  compactCheckbox?.addEventListener("change", () => {
    saveSetting("xml-beautifier-compact-mode", String(compactCheckbox.checked));
    if (editor.getValue().trim()) formatAction();
  });

  // Ctrl/Cmd-Enter formats (onSubmit). Legacy also bound Ctrl/Cmd-K to clear;
  // that chord is the site-wide command palette, so it is not bound here.

  bindEditorFileDrop(
    editorHost,
    (f) => /xml/.test(f.type) || f.name.toLowerCase().endsWith(".xml"),
    (f) => void loadFile(f),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
