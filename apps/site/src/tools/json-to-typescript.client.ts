/**
 * JSON to TypeScript client: dual CodeMirror 6 editors (JSON input, read-only
 * TS output) via the lazy editor kit; conversion by `jsonToTypeScript`
 * (`json-to-typescript.ts`). Live conversion on input (debounced) and on
 * option change; copy, download (`types.ts`), clear; invalid JSON becomes an
 * exact-position editor diagnostic (`locateJsonError`) — silent while typing,
 * announced on Convert / Ctrl-Enter; Esc→Tab leaves the editors. Workbench empty
 * states: input overlay + "Load example" (only on click), output placeholder.
 */
import { downloadText, loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { bindLoadExample, copyWithFeedback, revealOutput, syncEmptyState } from "@/scripts/tool-ui";
import { locateJsonError } from "@/tools/json-diagnostics";
import { jsonToTypeScript, type ConvertOptions } from "@/tools/json-to-typescript";
import { presentDiagnostic, shiftDiagnostic, type DiagnosticStrings } from "@/tools/parse-diagnostics";

interface Strings {
  errorInvalidJson: string;
  copied: string;
  copyFailed?: string;
  inputLabel: string;
  outputLabel: string;
  phrases?: Record<string, string>;
  /** `Diag_*` templates (`diagnosticStrings`). */
  diag: DiagnosticStrings;
}

const LIVE_DELAY_MS = 250;

/** "Load example" sample: an API-style payload with nesting, arrays, nulls and mixed types. */
const EXAMPLE = `{
  "id": 1024,
  "email": "ada@example.com",
  "active": true,
  "roles": ["admin", "editor"],
  "profile": { "displayName": "Ada", "avatarUrl": null, "locale": "en-GB" },
  "orders": [
    { "orderId": "A-17", "total": 42.5, "items": [{ "sku": "KB-01", "qty": 2 }] },
    { "orderId": "A-18", "total": 9.99, "items": [], "coupon": "WELCOME" }
  ]
}`;

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
  // Unknown-location fallback reads "Invalid JSON. Please check your input. (…)".
  const diagStrings: DiagnosticStrings = { ...strings.diag, SyntaxNoLocation: strings.errorInvalidJson };

  const copyBtn = root.querySelector<HTMLButtonElement>("[data-jts-copy]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-jts-clear]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-jts-download]");
  const rootNameInput = root.querySelector<HTMLInputElement>("[data-jts-root-name]");
  const exportChk = root.querySelector<HTMLInputElement>("[data-jts-export]");
  const optionalChk = root.querySelector<HTMLInputElement>("[data-jts-optional]");
  const useTypeChk = root.querySelector<HTMLInputElement>("[data-jts-use-type]");
  const errorBox = root.querySelector<HTMLElement>("[data-jts-error]");
  const emptyInputHost = root.querySelector<HTMLElement>("[data-jts-input-host]");
  const outputPanel = root.querySelector<HTMLElement>("[data-jts-output-panel]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-jts-example]");

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
        // Live conversion re-checks 250 ms after typing: keep the panel (faded) meanwhile.
        diagnostics: errorBox ? { box: errorBox, goToLabel: strings.diag.GoTo ?? "", keepPanelOnEdit: true } : undefined,
        onSubmit: () => doConvert(true),
        onChange: () => {
          syncInput();
          scheduleConvert();
        },
      }),
      kit.createEditor(outputEl, {
        language: "typescript",
        label: strings.outputLabel,
        phrases: strings.phrases,
        hintId: "jts-editor-hint",
        readOnly: true,
        onChange: () => syncOutput(),
      }),
    ]);
  } catch (err) {
    console.error("JSON to TypeScript: failed to load the editor", err);
    return;
  }

  /** Input overlay follows the JSON document (typing, example, Clear). */
  function syncInput() {
    if (emptyInputHost) syncEmptyState(emptyInputHost, inputEditor.getValue() === "");
  }
  /** Output placeholder until interfaces exist; Copy/Download need them. */
  function syncOutput() {
    const empty = outputEditor.getValue() === "";
    if (outputPanel) syncEmptyState(outputPanel, empty);
    if (copyBtn) copyBtn.disabled = empty;
    if (downloadBtn) downloadBtn.disabled = empty;
  }
  syncInput();
  syncOutput();
  if (exampleBtn) {
    bindLoadExample(exampleBtn, () => {
      inputEditor.setValue(EXAMPLE);
      doConvert(); // show the result right away instead of after the debounce
    }, inputEditor.view.contentDOM);
  }

  function getOpts(): ConvertOptions {
    return {
      rootName: rootNameInput?.value.trim() || "Root",
      exportKw: exportChk?.checked ?? false,
      optional: optionalChk?.checked ?? true,
      useType: useTypeChk?.checked ?? false,
    };
  }

  let liveTimer: number | undefined;
  /** `announce`: explicit Convert / Ctrl-Enter only — live checks while typing stay silent. */
  function doConvert(announce = false) {
    window.clearTimeout(liveTimer);
    const value = inputEditor.getValue();
    const src = value.trim();
    if (!src) {
      inputEditor.setDiagnostic(null);
      outputEditor.setValue("");
      return;
    }
    try {
      outputEditor.setValue(jsonToTypeScript(src, getOpts()));
      inputEditor.setDiagnostic(null);
    } catch (e) {
      outputEditor.setValue("");
      const found = locateJsonError(src);
      const diag = found
        ? shiftDiagnostic(found, value.length - value.trimStart().length)
        : { messageKey: "Syntax", from: null, to: null, detail: e instanceof Error ? e.message : String(e) };
      inputEditor.setDiagnostic(presentDiagnostic(diagStrings, diag, value), { announce });
    }
  }
  function scheduleConvert() {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => doConvert(), LIVE_DELAY_MS);
  }

  convertBtn.addEventListener("click", () => {
    doConvert(true);
    // Explicit Convert only (live typing never scrolls).
    if (outputEditor.getValue()) revealOutput(outputPanel);
  });
  copyBtn?.addEventListener("click", () => {
    const text = outputEditor.getValue();
    if (text) void copyWithFeedback(copyBtn, text, strings.copied, undefined, { failedLabel: strings.copyFailed });
  });
  clearBtn?.addEventListener("click", () => {
    inputEditor.setValue("");
    outputEditor.setValue("");
    inputEditor.setDiagnostic(null);
    inputEditor.focus();
  });
  downloadBtn?.addEventListener("click", () => {
    const text = outputEditor.getValue();
    if (text) downloadText(text, "types.ts", "text/plain");
  });

  for (const el of [exportChk, optionalChk, useTypeChk]) el?.addEventListener("change", () => doConvert());
  rootNameInput?.addEventListener("input", scheduleConvert);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
