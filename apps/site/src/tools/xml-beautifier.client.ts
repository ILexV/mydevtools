/**
 * XML Beautifier client controller. Pure-JS DOMParser + custom serializer
 * (ported verbatim from legacy xml-beautifier.js) with CodeMirror 5 via
 * `ensureCodeMirror()` and a custom 'simplexml' mode + fold helper defined
 * inline (legacy never vendored an xml mode — parity).
 *
 * PRIVACY: legacy persisted the input text to localStorage on every change
 * (`xml-beautifier-input`). That is intentionally NOT ported — user data
 * never leaves the page. Only the indent / compact-mode settings are kept.
 */
import { ensureCodeMirror } from "@/scripts/codemirror-loader";

/** Minimal typed surface of the vendored CodeMirror 5 global (no shipped types). */
interface CodeMirrorPos {
  line: number;
  ch: number;
}

interface CodeMirrorEditor {
  getValue(): string;
  setValue(value: string): void;
  setOption(name: string, value: unknown): void;
  setSize(width: number | string | null, height: number | string | null): void;
  refresh(): void;
  getWrapperElement(): HTMLElement;
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
  (element: HTMLElement, options: Record<string, unknown>): CodeMirrorEditor;
  modes: Record<string, unknown>;
  defineMode(name: string, factory: () => { startState: () => SimpleXmlState; token: (stream: CodeMirrorStream, state: SimpleXmlState) => string | null }): void;
  defineMIME(mime: string, mode: string): void;
  registerHelper(type: string, name: string, helper: unknown): void;
  Pos(line: number, ch: number): CodeMirrorPos;
  fold: Record<string, unknown>;
}

interface Strings {
  copied: string;
  copyButton: string;
  errorInvalidXml: string;
  inputPlaceholder: string;
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

function formatDoctype(doctype: DocumentType | null): string {
  if (!doctype) return "";
  let id = "";
  if (doctype.publicId) {
    id += ` PUBLIC "${doctype.publicId}"`;
    if (doctype.systemId) {
      id += ` "${doctype.systemId}"`;
    }
  } else if (doctype.systemId) {
    id += ` SYSTEM "${doctype.systemId}"`;
  }
  return `<!DOCTYPE ${doctype.name}${id}>`;
}

function isIgnorableWhitespace(node: ChildNode): boolean {
  return node.nodeType === 3 && !(node.nodeValue || "").trim();
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function serializeNode(node: ChildNode, depth: number, lines: string[], indentUnit: string): void {
  const indent = indentUnit.repeat(depth);

  switch (node.nodeType) {
    case 1: {
      // ELEMENT_NODE
      const el = node as Element;
      const attributes = Array.from(el.attributes || [])
        .map((attr) => `${attr.name}="${escapeAttribute(attr.value)}"`)
        .join(" ");

      const name = el.nodeName;
      const openTag = attributes ? `<${name} ${attributes}>` : `<${name}>`;
      const children = Array.from(el.childNodes || []).filter((child) => !isIgnorableWhitespace(child));

      if (children.length === 0) {
        lines.push(indent + (attributes ? `<${name} ${attributes}/>` : `<${name}/>`));
        return;
      }

      if (children.length === 1 && children[0].nodeType === 3) {
        const text = escapeText((children[0].nodeValue || "").trim());
        lines.push(indent + openTag + text + `</${name}>`);
        return;
      }

      lines.push(indent + openTag);
      children.forEach((child) => serializeNode(child, depth + 1, lines, indentUnit));
      lines.push(indent + `</${name}>`);
      return;
    }
    case 3: {
      // TEXT_NODE
      const text = (node.nodeValue || "").trim();
      if (text) {
        lines.push(indent + escapeText(text));
      }
      return;
    }
    case 4: {
      // CDATA_SECTION_NODE
      lines.push(indent + `<![CDATA[${node.nodeValue ?? ""}]]>`);
      return;
    }
    case 8: {
      // COMMENT_NODE
      lines.push(indent + `<!--${node.nodeValue ?? ""}-->`);
      return;
    }
    case 7: {
      // PROCESSING_INSTRUCTION_NODE
      const pi = node as ProcessingInstruction;
      lines.push(indent + `<?${pi.target} ${pi.data}?>`);
      return;
    }
    default:
      return;
  }
}

function serializeCompactNode(node: ChildNode): string {
  switch (node.nodeType) {
    case 1: {
      // ELEMENT_NODE
      const el = node as Element;
      const attributes = Array.from(el.attributes || [])
        .map((attr) => `${attr.name}="${escapeAttribute(attr.value)}"`)
        .join(" ");

      const name = el.nodeName;
      const openTag = attributes ? `<${name} ${attributes}>` : `<${name}>`;
      const children = Array.from(el.childNodes || []).filter((child) => !isIgnorableWhitespace(child));

      if (children.length === 0) {
        return attributes ? `<${name} ${attributes}/>` : `<${name}/>`;
      }

      const inner = children.map((child) => serializeCompactNode(child)).join("");
      return openTag + inner + `</${name}>`;
    }
    case 3: {
      // TEXT_NODE
      return escapeText(node.nodeValue ?? "");
    }
    case 4: {
      // CDATA_SECTION_NODE
      return `<![CDATA[${node.nodeValue ?? ""}]]>`;
    }
    case 8: {
      // COMMENT_NODE
      return `<!--${node.nodeValue ?? ""}-->`;
    }
    case 7: {
      // PROCESSING_INSTRUCTION_NODE
      const pi = node as ProcessingInstruction;
      return `<?${pi.target} ${pi.data}?>`;
    }
    default:
      return "";
  }
}

function formatXmlString(input: string, indentValue: number | string, compactMode: boolean): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(input, "application/xml");
  const parseError = doc.getElementsByTagName("parsererror");
  if (parseError && parseError.length > 0) {
    throw new Error("Invalid XML");
  }

  const declarationMatch = input.match(/^\s*(<\?xml[^>]+\?>)/i);
  const declaration = declarationMatch ? declarationMatch[1].trim() : null;

  if (compactMode) {
    const parts: string[] = [];
    if (declaration) {
      parts.push(declaration);
    }
    if (doc.doctype) {
      parts.push(formatDoctype(doc.doctype));
    }
    const rootElement = doc.documentElement;
    if (rootElement) {
      parts.push(serializeCompactNode(rootElement));
    }
    return parts.join("\n");
  }

  const indentUnit = indentValue === "\t" ? "\t" : " ".repeat(indentValue as number);
  const lines: string[] = [];

  if (declaration) {
    lines.push(declaration);
  }

  if (doc.doctype) {
    lines.push(formatDoctype(doc.doctype));
  }

  const rootElement = doc.documentElement;
  if (rootElement) {
    serializeNode(rootElement, 0, lines, indentUnit);
  }

  return lines.join("\n");
}

async function init(): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-xml-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const editorEl = root.querySelector<HTMLElement>("[data-xml-editor]");
  const formatBtn = root.querySelector<HTMLButtonElement>("[data-xml-format]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-xml-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-xml-copy]");
  const indentSelect = root.querySelector<HTMLSelectElement>("[data-xml-indent]");
  const compactModeCheckbox = root.querySelector<HTMLInputElement>("[data-xml-compact]");
  const openFileBtn = root.querySelector<HTMLButtonElement>("[data-xml-open]");
  const saveFileBtn = root.querySelector<HTMLButtonElement>("[data-xml-save]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-xml-file]");

  if (!editorEl || !formatBtn) return;
  const editorContainer: HTMLElement = editorEl;

  try {
    await ensureCodeMirror();
  } catch (err) {
    console.error("XML Beautifier: failed to load CodeMirror", err);
    return;
  }
  // Vendored CodeMirror 5 global — no shipped types, runtime-checked by the loader.
  const CodeMirror = window.CodeMirror as unknown as CodeMirrorStatic | undefined;
  if (!CodeMirror) return;

  defineSimpleXmlMode(CodeMirror);

  // Exact CodeMirror options from legacy (placeholder is a no-op without the
  // display/placeholder addon — kept for parity).
  const editor = CodeMirror(editorContainer, {
    mode: { name: "simplexml" },
    lineNumbers: true,
    lineWrapping: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 4,
    tabSize: 4,
    theme: "default",
    placeholder: strings.inputPlaceholder,
    viewportMargin: Infinity,
    foldGutter: true,
    foldOptions: {
      rangeFinder: CodeMirror.fold.simplexml,
    },
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  });

  editor.setSize(null, "600px");

  // Settings persistence (parity). Input text is intentionally NOT persisted.
  let savedIndent: string | null = null;
  let savedCompactMode: string | null = null;
  try {
    savedIndent = localStorage.getItem("xml-beautifier-indent");
    savedCompactMode = localStorage.getItem("xml-beautifier-compact-mode");
  } catch {
    /* storage unavailable */
  }
  if (savedIndent && indentSelect) {
    indentSelect.value = savedIndent;
  }
  if (savedCompactMode && compactModeCheckbox) {
    compactModeCheckbox.checked = savedCompactMode === "true";
  }

  const themeObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes" && mutation.attributeName === "data-theme") {
        editor.refresh();
      }
    });
  });

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  editor.refresh();

  function formatXml() {
    const input = editor.getValue().trim();
    if (!input) {
      return;
    }

    try {
      const indentValue = indentSelect?.value === "tab" ? "\t" : parseInt(indentSelect?.value || "4", 10);
      const formatted = formatXmlString(input, indentValue, compactModeCheckbox?.checked ?? false);

      editor.setValue(formatted);

      if (!compactModeCheckbox?.checked) {
        if (indentValue === "\t") {
          editor.setOption("indentWithTabs", true);
        } else {
          editor.setOption("indentWithTabs", false);
          editor.setOption("indentUnit", indentValue);
          editor.setOption("tabSize", indentValue);
        }
      }

      editorContainer.classList.remove("xml-error");
    } catch (e) {
      editorContainer.classList.add("xml-error");
      console.error("XML Error:", (e as Error).message);
      showNotification(strings.errorInvalidXml, "error");
    }
  }

  function clearAll() {
    editor.setValue("");
    editorContainer.classList.remove("xml-error");
  }

  function copyToClipboard() {
    if (!copyBtn) return;
    const btn: HTMLButtonElement = copyBtn;

    const text = editor.getValue();
    navigator.clipboard
      .writeText(text)
      .then(() => {
        const originalText = btn.textContent;
        btn.textContent = strings.copied;
        setTimeout(() => {
          btn.textContent = originalText || strings.copyButton;
        }, 2000);
      })
      .catch((err) => {
        console.error("Failed to copy:", err);
      });
  }

  function showNotification(message: string, type = "info") {
    const notification = document.createElement("div");
    notification.className = `xml-notification xml-notification-${type}`;
    notification.textContent = message;

    const editorWrapper = editor.getWrapperElement();
    editorWrapper.parentElement?.insertBefore(notification, editorWrapper);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  function handleFileSelect(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        editor.setValue(e.target?.result as string);
      };
      reader.readAsText(file);
    }
  }

  function saveFile() {
    const text = editor.getValue();
    const blob = new Blob([text], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "formatted.xml";
    a.click();
    URL.revokeObjectURL(url);
  }

  formatBtn.addEventListener("click", formatXml);
  clearBtn?.addEventListener("click", clearAll);
  copyBtn?.addEventListener("click", copyToClipboard);
  openFileBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", handleFileSelect);
  saveFileBtn?.addEventListener("click", saveFile);

  indentSelect?.addEventListener("change", () => {
    try {
      localStorage.setItem("xml-beautifier-indent", indentSelect.value);
    } catch {
      /* storage unavailable */
    }
    const value = editor.getValue().trim();
    if (value) {
      formatXml();
    }
  });
  compactModeCheckbox?.addEventListener("change", () => {
    try {
      localStorage.setItem("xml-beautifier-compact-mode", String(compactModeCheckbox.checked));
    } catch {
      /* storage unavailable */
    }
    const value = editor.getValue().trim();
    if (value) {
      formatXml();
    }
  });

  editor.setOption("extraKeys", {
    "Ctrl-Enter": formatXml,
    "Cmd-Enter": formatXml,
    "Ctrl-K": clearAll,
    "Cmd-K": clearAll,
  });

  // Drag and drop
  editorContainer.addEventListener("dragover", (e) => {
    e.preventDefault();
    editorContainer.classList.add("drag-over");
  });
  editorContainer.addEventListener("dragleave", (e) => {
    e.preventDefault();
    editorContainer.classList.remove("drag-over");
  });
  editorContainer.addEventListener("drop", (e) => {
    e.preventDefault();
    editorContainer.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.type === "application/xml" || file.name.endsWith(".xml")) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          editor.setValue(ev.target?.result as string);
        };
        reader.readAsText(file);
      }
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
