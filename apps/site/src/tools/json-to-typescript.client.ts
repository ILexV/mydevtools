/**
 * JSON to TypeScript client: dual CodeMirror 6 editors (JSON input, read-only
 * TS output) via the lazy editor kit; conversion by `jsonToTypeScript`
 * (`json-to-typescript.ts`). Live conversion on input (debounced) and on
 * option change; copy, download (`types.ts`), clear; localized invalid-JSON
 * error with the parser detail; Esc→Tab leaves the editors.
 */
import { downloadText, loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { jsonToTypeScript, type ConvertOptions } from "@/tools/json-to-typescript";

interface Strings {
  errorInvalidJson: string;
  copied: string;
  inputLabel: string;
  outputLabel: string;
  phrases?: Record<string, string>;
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

  let inputEditor: MdtEditor;
  let outputEditor: MdtEditor;
  try {
    const kit = await loadEditorKit();
    [inputEditor, outputEditor] = await Promise.all([
      kit.createEditor(inputEl, {
        language: "json",
        label: strings.inputLabel,
        phrases: strings.phrases,
        hintId: "jts-editor-hint",
        indent: 2,
        onSubmit: () => doConvert(),
        onChange: () => scheduleConvert(),
      }),
      kit.createEditor(outputEl, {
        language: "typescript",
        label: strings.outputLabel,
        phrases: strings.phrases,
        hintId: "jts-editor-hint",
        readOnly: true,
      }),
    ]);
  } catch (err) {
    console.error("JSON to TypeScript: failed to load the editor", err);
    return;
  }

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
  function scheduleConvert() {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(doConvert, LIVE_DELAY_MS);
  }

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

  for (const el of [exportChk, optionalChk, useTypeChk]) el?.addEventListener("change", doConvert);
  rootNameInput?.addEventListener("input", scheduleConvert);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
