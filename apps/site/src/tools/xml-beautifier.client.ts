/**
 * XML Beautifier client controller. CodeMirror 5 via `ensureCodeMirror()`
 * with a custom 'simplexml' mode + fold helper defined inline (legacy never
 * vendored an xml mode — parity); formatting via `formatXml` (DOMParser +
 * pure serializer in `xml-format.ts`). Open/save, drop a file onto the
 * editor, copy/clear, Ctrl/Cmd-Enter format, Esc→Tab leaves the editor.
 *
 * PRIVACY: legacy persisted the input text to localStorage on every change
 * (`xml-beautifier-input`). That is intentionally NOT ported — user data
 * never leaves the page. Only the indent / compact-mode settings are kept.
 */
import {
  bindEditorFileDrop,
  downloadText,
  ensureCodeMirror,
  getCodeMirror,
  makeEditorAccessible,
  refreshOnThemeChange,
  type CmEditor,
} from "@/scripts/codemirror-loader";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { formatXml, XmlParseError } from "@/tools/xml-format";

/** Minimal typed surface of the vendored CodeMirror 5 global (no shipped types). */
interface CodeMirrorPos {
  line: number;
  ch: number;
}

interface CodeMirrorStream {
  skipTo(target: string): boolean;
  match(pattern: string | RegExp): boolean;
  skipToEnd(): void;
  next(): string | undefined;
  eatWhile(match: RegExp): string;
}

interface SimpleXmlState {
  inTag: boolean;
  inComment: boolean;
  inCdata: boolean;
  inProcessing: boolean;
}

interface CodeMirrorStatic {
  (element: HTMLElement, options: Record<string, unknown>): CmEditor;
  modes: Record<string, unknown>;
  defineMode(name: string, factory: () => { startState: () => SimpleXmlState; token: (stream: CodeMirrorStream, state: SimpleXmlState) => string | null }): void;
  defineMIME(mime: string, mode: string): void;
  registerHelper(type: string, name: string, helper: unknown): void;
  Pos(line: number, ch: number): CodeMirrorPos;
  fold: Record<string, unknown>;
}

interface Strings {
  copied: string;
  errorInvalidXml: string;
  inputLabel: string;
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

/** Custom 'simplexml' mode + fold helper — verbatim port of the legacy definition. */
function defineSimpleXmlMode(CodeMirror: CodeMirrorStatic): void {
  if (CodeMirror.modes.simplexml) return;

  CodeMirror.defineMode("simplexml", function () {
    function startState(): SimpleXmlState {
      return {
        inTag: false,
        inComment: false,
        inCdata: false,
        inProcessing: false,
      };
    }

    function token(stream: CodeMirrorStream, state: SimpleXmlState): string | null {
      if (state.inComment) {
        if (stream.skipTo("-->")) {
          stream.match("-->");
          state.inComment = false;
        } else {
          stream.skipToEnd();
        }
        return "comment";
      }

      if (state.inCdata) {
        if (stream.skipTo("]]>")) {
          stream.match("]]>");
          state.inCdata = false;
        } else {
          stream.skipToEnd();
        }
        return "atom";
      }

      if (state.inProcessing) {
        if (stream.skipTo("?>")) {
          stream.match("?>");
          state.inProcessing = false;
        } else {
          stream.skipToEnd();
        }
        return "meta";
      }

      if (state.inTag) {
        if (stream.match(/^\s*\/?>/)) {
          state.inTag = false;
          return "tag";
        }

        if (stream.match(/^\s+[\w:-]+/)) {
          return "attribute";
        }

        if (stream.match(/^\s*=\s*/)) {
          return null;
        }

        if (stream.match(/^\s*"(?:[^"\\]|\\.)*"/)) {
          return "string";
        }

        if (stream.match(/^\s*'(?:[^'\\]|\\.)*'/)) {
          return "string";
        }

        stream.next();
        return null;
      }

      if (stream.match("<!--")) {
        state.inComment = true;
        return "comment";
      }

      if (stream.match("<![CDATA[")) {
        state.inCdata = true;
        return "atom";
      }

      if (stream.match("<?")) {
        state.inProcessing = true;
        return "meta";
      }

      if (stream.match("</")) {
        state.inTag = true;
        return "tag";
      }

      if (stream.match("<")) {
        state.inTag = true;
        return "tag";
      }

      stream.eatWhile(/[^<]/);
      return null;
    }

    return {
      startState: startState,
      token: token,
    };
  });

  CodeMirror.defineMIME("application/xml", "simplexml");

  const openTagRegex = /<([A-Za-z_][\w:.-]*)(?=\s|>|\/)/g;
  const closeTagRegex = /<\/([A-Za-z_][\w:.-]*)\s*>/g;

  function findOpeningTag(line: string) {
    let match;
    while ((match = openTagRegex.exec(line)) !== null) {
      const isClosing = line.slice(match.index - 1, match.index + 2) === "</";
      const isSelfClosing = /\/\s*>/.test(line.slice(match.index));
      if (!isClosing && !isSelfClosing) {
        return { name: match[1], ch: match.index };
      }
    }
    return null;
  }

  function countTagOccurrences(line: string, tagName: string) {
    let openCount = 0;
    let closeCount = 0;

    const openRegex = new RegExp(`<${tagName}(?=\\s|>|\\/)`, "g");
    const closeRegex = new RegExp(`</${tagName}\\s*>`, "g");
    const selfClosingRegex = new RegExp(`<${tagName}(?:\\s[^>]*)?\\s/>`, "g");

    openCount += (line.match(openRegex) || []).length;
    closeCount += (line.match(closeRegex) || []).length;
    const selfClosingCount = (line.match(selfClosingRegex) || []).length;
    openCount -= selfClosingCount;

    return { openCount, closeCount };
  }

  function xmlFoldHelper(cm: { getLine(n: number): string | undefined; lineCount(): number }, start: CodeMirrorPos) {
    const startLine = start.line;
    const lineText = cm.getLine(startLine);
    if (!lineText) return null;

    openTagRegex.lastIndex = 0;
    const opening = findOpeningTag(lineText);
    if (!opening) return null;

    const tagName = opening.name;
    let depth = 0;
    let foundStart = false;

    for (let line = startLine; line < cm.lineCount(); line += 1) {
      const text = cm.getLine(line);
      if (!text) continue;

      const counts = countTagOccurrences(text, tagName);
      if (line === startLine) {
        depth += 1;
        foundStart = true;
      } else if (foundStart) {
        depth += counts.openCount;
      }

      depth -= counts.closeCount;

      if (foundStart && depth === 0) {
        closeTagRegex.lastIndex = 0;
        const closeMatch = closeTagRegex.exec(text);
        const closeCh = closeMatch ? closeMatch.index : text.length;
        return {
          from: CodeMirror.Pos(startLine, opening.ch),
          to: CodeMirror.Pos(line, closeCh),
        };
      }
    }

    return null;
  }

  CodeMirror.registerHelper("fold", "simplexml", xmlFoldHelper);
  CodeMirror.fold.simplexml = xmlFoldHelper;
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

  try {
    await ensureCodeMirror();
  } catch (err) {
    console.error("XML Beautifier: failed to load CodeMirror", err);
    return;
  }
  const CodeMirror = getCodeMirror<CodeMirrorStatic>();
  if (!CodeMirror) return;

  defineSimpleXmlMode(CodeMirror);

  const editor = CodeMirror(editorHost, {
    mode: { name: "simplexml" },
    lineNumbers: true,
    lineWrapping: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 4,
    tabSize: 4,
    theme: "default",
    foldGutter: true,
    foldOptions: {
      rangeFinder: CodeMirror.fold.simplexml,
    },
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  });
  makeEditorAccessible(editor, strings.inputLabel, "xml-editor-hint");
  refreshOnThemeChange([editor]);

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
      if (!compact) {
        const unit = indentValue === "\t" ? 4 : indentValue;
        editor.setOption("indentWithTabs", indentValue === "\t");
        editor.setOption("indentUnit", unit);
        editor.setOption("tabSize", unit);
      }
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
    void copyWithFeedback(copyBtn, editor.getValue(), strings.copied);
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

  // Legacy also bound Ctrl/Cmd-K to clear; that chord is the site-wide command
  // palette (captured on window), so only the format shortcut remains.
  editor.setOption("extraKeys", {
    "Ctrl-Enter": formatAction,
    "Cmd-Enter": formatAction,
  });

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
