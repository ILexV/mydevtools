/**
 * JSON to TypeScript client: dual CodeMirror 5 editors (JSON input, read-only
 * TS output) via the shared loader; conversion by `jsonToTypeScript`
 * (`json-to-typescript.ts`). Live conversion on input (debounced) and on
 * option change; copy, download (`types.ts`), clear; localized invalid-JSON
 * error with the parser detail; Esc→Tab leaves the editors.
 */
import {
  downloadText,
  ensureCodeMirror,
  getCodeMirror,
  makeEditorAccessible,
  refreshOnThemeChange,
} from "@/scripts/codemirror-loader";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { jsonToTypeScript, type ConvertOptions } from "@/tools/json-to-typescript";

interface Strings {
  errorInvalidJson: string;
  copied: string;
  inputLabel: string;
  outputLabel: string;
}

const LIVE_DELAY_MS = 250;

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
  if (!root || root.dataset.initialized === "true") return;
  const stringsRaw = readStrings();
  const inputEl = root.querySelector<HTMLElement>("[data-jts-input]");
  const outputEl = root.querySelector<HTMLElement>("[data-jts-output]");
  const convertBtn = root.querySelector<HTMLButtonElement>("[data-jts-convert]");
  if (!stringsRaw || !inputEl || !outputEl || !convertBtn) return;
  root.dataset.initialized = "true";
  const strings: Strings = stringsRaw;
  const inputHost: HTMLElement = inputEl;

  const copyBtn = root.querySelector<HTMLButtonElement>("[data-jts-copy]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-jts-clear]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-jts-download]");
  const rootNameInput = root.querySelector<HTMLInputElement>("[data-jts-root-name]");
  const exportChk = root.querySelector<HTMLInputElement>("[data-jts-export]");
  const optionalChk = root.querySelector<HTMLInputElement>("[data-jts-optional]");
  const useTypeChk = root.querySelector<HTMLInputElement>("[data-jts-use-type]");
  const errorBox = root.querySelector<HTMLElement>("[data-jts-error]");

  try {
    await ensureCodeMirror();
  } catch (err) {
    console.error("JSON to TypeScript: failed to load CodeMirror", err);
    return;
  }
  const CodeMirror = getCodeMirror();
  if (!CodeMirror) return;

  const inputEditor = CodeMirror(inputEl, {
    mode: { name: "javascript", json: true },
    lineNumbers: true,
    lineWrapping: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    theme: "default",
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  });
  const outputEditor = CodeMirror(outputEl, {
    mode: { name: "javascript", typescript: true },
    lineNumbers: true,
    lineWrapping: true,
    readOnly: true,
    theme: "default",
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  });
  makeEditorAccessible(inputEditor, strings.inputLabel, "jts-editor-hint");
  makeEditorAccessible(outputEditor, strings.outputLabel, "jts-editor-hint");
  refreshOnThemeChange([inputEditor, outputEditor]);

  function getOpts(): ConvertOptions {
    return {
      rootName: rootNameInput?.value.trim() || "Root",
      exportKw: exportChk?.checked ?? false,
      optional: optionalChk?.checked ?? true,
      useType: useTypeChk?.checked ?? false,
    };
  }

  function setError(message: string) {
    inputHost.classList.toggle("is-error", Boolean(message));
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = !message;
    }
  }

  let liveTimer: number | undefined;
  function doConvert() {
    window.clearTimeout(liveTimer);
    const src = inputEditor.getValue().trim();
    if (!src) {
      setError("");
      outputEditor.setValue("");
      return;
    }
    try {
      outputEditor.setValue(jsonToTypeScript(src, getOpts()));
      setError("");
    } catch (e) {
      outputEditor.setValue("");
      setError(strings.errorInvalidJson + (e instanceof Error && e.message ? ` (${e.message})` : ""));
    }
  }
  const scheduleConvert = () => {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(doConvert, LIVE_DELAY_MS);
  };

  convertBtn.addEventListener("click", doConvert);
  copyBtn?.addEventListener("click", () => {
    const text = outputEditor.getValue();
    if (text) void copyWithFeedback(copyBtn, text, strings.copied);
  });
  clearBtn?.addEventListener("click", () => {
    inputEditor.setValue("");
    outputEditor.setValue("");
    setError("");
    inputEditor.focus();
  });
  downloadBtn?.addEventListener("click", () => {
    const text = outputEditor.getValue();
    if (text) downloadText(text, "types.ts", "text/plain");
  });

  inputEditor.on("change", scheduleConvert);
  for (const el of [exportChk, optionalChk, useTypeChk]) el?.addEventListener("change", doConvert);
  rootNameInput?.addEventListener("input", scheduleConvert);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
