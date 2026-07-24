/**
 * JSON to TypeScript client. Pure-JS type-inference engine ported 1:1 from
 * legacy `json-to-typescript.js` (naming, nesting, arrays/unions, optional
 * detection, collisions) + dual CodeMirror 5 editors via the shared loader.
 * Live conversion on input/option change; copy (label swap), download
 * (`types.ts`), clear; localized invalid-JSON error.
 */
import { ensureCodeMirror } from "@/scripts/codemirror-loader";

interface Strings {
  errorInvalidJson: string;
  copied: string;
  copyButton: string;
  inputPlaceholder: string;
  outputPlaceholder: string;
}

interface ConvertOptions {
  rootName: string;
  exportKw: boolean;
  optional: boolean;
  useType: boolean;
}

/** Minimal surface of the vendored CodeMirror 5 editor this tool uses. */
interface CodeMirrorEditor {
  setSize(width: number | null, height: number | string | null): void;
  getValue(): string;
  setValue(value: string): void;
  on(eventName: string, handler: () => void): void;
  refresh(): void;
  getWrapperElement(): HTMLElement;
}

type CodeMirrorConstructor = (element: HTMLElement, options: Record<string, unknown>) => CodeMirrorEditor;

// ─── JSON → TypeScript conversion engine (legacy parity) ────────────────────

function inferType(value: unknown, name: string, interfaces: Map<string, string>, opts: ConvertOptions): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "unknown[]";
    const elementTypes = value.map((item: unknown) => inferType(item, toPascalCase(name) + "Item", interfaces, opts));
    const uniqueTypes = [...new Set(elementTypes)];
    const elementType = uniqueTypes.length === 1 ? uniqueTypes[0] : "(" + uniqueTypes.join(" | ") + ")";
    return elementType + "[]";
  }

  if (typeof value === "object") {
    // JSON.parse object literal — record of unknown values.
    return buildInterface(value as Record<string, unknown>, name, interfaces, opts);
  }

  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";

  return "unknown";
}

function buildInterface(
  obj: Record<string, unknown>,
  name: string,
  interfaces: Map<string, string>,
  opts: ConvertOptions,
): string {
  const safeName = toPascalCase(name) || "Root";

  const lines: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const propName = toSafeKey(key);
    const isNullish = val === null || val === undefined;
    const optional = opts.optional && isNullish ? "?" : "";
    const subTypeName = toPascalCase(safeName) + toPascalCase(key);
    const tsType = inferType(val, subTypeName, interfaces, opts);
    lines.push(`  ${propName}${optional}: ${tsType};`);
  }

  const expKw = opts.exportKw ? "export " : "";
  let definition: string;
  if (opts.useType) {
    definition = `${expKw}type ${safeName} = {\n${lines.join("\n")}\n};`;
  } else {
    definition = `${expKw}interface ${safeName} {\n${lines.join("\n")}\n}`;
  }

  let finalName = safeName;
  if (interfaces.has(finalName)) {
    if (interfaces.get(finalName) !== definition) {
      let i = 2;
      while (interfaces.has(finalName + i)) i++;
      finalName = finalName + i;
      if (opts.useType) {
        definition = `${expKw}type ${finalName} = {\n${lines.join("\n")}\n};`;
      } else {
        definition = `${expKw}interface ${finalName} {\n${lines.join("\n")}\n}`;
      }
    }
  } else {
    interfaces.set(finalName, definition);
  }

  return finalName;
}

function toPascalCase(str: string): string {
  if (!str) return "";
  return str
    .replace(/[-_\s.]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

function toSafeKey(key: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key;
  return `"${key.replace(/"/g, '\\"')}"`;
}

function jsonToTypeScript(jsonStr: string, opts: ConvertOptions): string {
  const parsed: unknown = JSON.parse(jsonStr);
  const interfaces = new Map<string, string>();
  const rootName = toPascalCase(opts.rootName || "Root") || "Root";

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    // JSON object literal.
    buildInterface(parsed as Record<string, unknown>, rootName, interfaces, opts);
  } else if (Array.isArray(parsed)) {
    const first: unknown = parsed[0];
    if (parsed.length > 0 && typeof first === "object" && first !== null) {
      // JSON object literal element.
      buildInterface(first as Record<string, unknown>, rootName + "Item", interfaces, opts);
    }
    const expKw = opts.exportKw ? "export " : "";
    const itemType = parsed.length > 0 ? (typeof first === "object" ? rootName + "Item" : typeof first) : "unknown";
    interfaces.set(rootName, `${expKw}type ${rootName} = ${itemType}[];`);
  } else {
    const expKw = opts.exportKw ? "export " : "";
    const tsType = inferType(parsed, rootName, interfaces, opts);
    interfaces.set(rootName, `${expKw}type ${rootName} = ${tsType};`);
  }

  return [...interfaces.values()].join("\n\n");
}

// ─── UI logic ───────────────────────────────────────────────────────────────

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-jts-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

async function init() {
  const root = document.querySelector<HTMLElement>("[data-jts-tool]");
  if (!root) return;
  // Idempotency: a CodeMirror wrapper means already initialized.
  if (root.querySelector(".CodeMirror")) return;
  const stringsRaw = readStrings();
  if (!stringsRaw) return;
  const strings: Strings = stringsRaw;

  const inputEl = root.querySelector<HTMLElement>("[data-jts-input]");
  const outputEl = root.querySelector<HTMLElement>("[data-jts-output]");
  const convertBtn = root.querySelector<HTMLButtonElement>("[data-jts-convert]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-jts-copy]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-jts-clear]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-jts-download]");
  const rootNameInput = root.querySelector<HTMLInputElement>("[data-jts-root-name]");
  const exportChk = root.querySelector<HTMLInputElement>("[data-jts-export]");
  const optionalChk = root.querySelector<HTMLInputElement>("[data-jts-optional]");
  const useTypeChk = root.querySelector<HTMLInputElement>("[data-jts-use-type]");
  const errorBox = root.querySelector<HTMLElement>("[data-jts-error]");
  const errorText = root.querySelector<HTMLElement>("[data-jts-error-text]");

  if (!inputEl || !outputEl || !convertBtn) return;
  const inputPane: HTMLElement = inputEl;
  const outputPane: HTMLElement = outputEl;

  await ensureCodeMirror();
  // Vendored CodeMirror 5 exposes a global constructor once the loader resolves.
  const CodeMirror = window.CodeMirror as unknown as CodeMirrorConstructor | undefined;
  if (!CodeMirror) return;

  // ── Input editor (JSON, editable) — legacy options ──
  const inputEditor = CodeMirror(inputPane, {
    mode: { name: "javascript", json: true },
    lineNumbers: true,
    lineWrapping: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    theme: "default",
    placeholder: strings.inputPlaceholder,
    viewportMargin: Infinity,
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  });
  inputEditor.setSize(null, "700px");

  // ── Output editor (TypeScript, read-only) — legacy options ──
  const outputEditor = CodeMirror(outputPane, {
    mode: { name: "javascript", typescript: true },
    lineNumbers: true,
    lineWrapping: true,
    readOnly: true,
    theme: "default",
    placeholder: strings.outputPlaceholder,
    viewportMargin: Infinity,
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  });
  outputEditor.setSize(null, "700px");

  // ── Theme sync (refresh on site theme toggle) ──
  const updateTheme = () => {
    inputEditor.refresh();
    outputEditor.refresh();
  };
  const themeObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "data-theme") updateTheme();
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  updateTheme();

  // ── Helpers ──
  function getOpts(): ConvertOptions {
    return {
      rootName: (rootNameInput ? rootNameInput.value.trim() : "") || "Root",
      exportKw: exportChk ? exportChk.checked : false,
      optional: optionalChk ? optionalChk.checked : true,
      useType: useTypeChk ? useTypeChk.checked : false,
    };
  }

  function showError(msg: string) {
    if (errorBox && errorText) {
      errorText.textContent = msg;
      errorBox.hidden = false;
    }
    inputEditor.getWrapperElement().classList.add("json-error");
    inputPane.classList.add("json-error");
  }

  function clearError() {
    if (errorBox) errorBox.hidden = true;
    inputEditor.getWrapperElement().classList.remove("json-error");
    inputPane.classList.remove("json-error");
  }

  function doConvert() {
    clearError();
    const src = inputEditor.getValue().trim();
    if (!src) {
      outputEditor.setValue("");
      return;
    }

    try {
      const result = jsonToTypeScript(src, getOpts());
      outputEditor.setValue(result);
    } catch (e) {
      outputEditor.setValue("");
      showError(strings.errorInvalidJson + (e instanceof Error && e.message ? ": " + e.message : ""));
    }
  }

  function doCopy() {
    const text = outputEditor.getValue();
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        if (!copyBtn) return;
        const originalHTML = copyBtn.innerHTML;
        copyBtn.textContent = strings.copied;
        setTimeout(() => {
          copyBtn.innerHTML = originalHTML;
        }, 1200);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  }

  function doClear() {
    inputEditor.setValue("");
    outputEditor.setValue("");
    clearError();
  }

  function doDownload() {
    const text = outputEditor.getValue();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "types.ts";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Event wiring ──
  convertBtn.addEventListener("click", doConvert);
  copyBtn?.addEventListener("click", doCopy);
  clearBtn?.addEventListener("click", doClear);
  downloadBtn?.addEventListener("click", doDownload);

  // Live conversion on input change
  inputEditor.on("change", doConvert);

  // Re-convert when options change
  for (const el of [exportChk, optionalChk, useTypeChk]) {
    el?.addEventListener("change", doConvert);
  }
  rootNameInput?.addEventListener("input", doConvert);
}

function boot() {
  init().catch(() => {
    /* CodeMirror failed to load */
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
