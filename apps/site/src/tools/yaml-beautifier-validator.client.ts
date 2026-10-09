/**
 * YAML Beautifier/Validator client controller. CodeMirror 6 editors (lazy
 * editor kit, `@codemirror/lang-yaml` highlight + folding). Format/validate run through the structured-data WASM
 * client (loaded on first use); parse errors become an input-editor
 * diagnostic at the yaml-rust marker (`yamlDiagnostic`: localized reason,
 * line/column, Go to error); status badge valid/invalid; paste/copy/clear.
 * Workbench empty states: input overlay + "Load example" (only on click),
 * compact output placeholder until there is a result.
 */
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { bindLoadExample, copyWithFeedback, revealOutput, syncEmptyState, withPreparing } from "@/scripts/tool-ui";
import { presentDiagnostic, type DiagnosticStrings } from "@/tools/parse-diagnostics";
import { yamlDiagnostic } from "@/tools/yaml-diagnostics";

interface Strings {
  inputLabel: string;
  outputLabel: string;
  valid: string;
  invalid: string;
  copied: string;
  copyFailed?: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
  phrases?: Record<string, string>;
  /** `Diag_*` templates (`diagnosticStrings`). */
  diag: DiagnosticStrings;
}

/** "Load example" sample: messy but valid YAML (uneven indent, flow list, anchor/alias). */
const EXAMPLE = `version: 3
services:
    web:
        image: "nginx:1.27"
        ports: [ "8080:80",  "8443:443" ]
        environment: &env
          TZ:   UTC
          LOG_LEVEL: info
    worker:
      image: example/worker:2.1
      environment: *env
      deploy: { replicas: 2 }
`;

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-yaml-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

// WASM is imported lazily so the page doesn't fetch it until the first action.
type SdClient = typeof import("@/scripts/wasm/structured-data-client");
let clientPromise: Promise<SdClient> | null = null;
function sdClient(): Promise<SdClient> {
  clientPromise ??= import("@/scripts/wasm/structured-data-client").catch((e) => {
    clientPromise = null;
    throw e;
  });
  return clientPromise;
}

async function init() {
  const root = document.querySelector<HTMLElement>("[data-yaml-tool]");
  if (!root || root.dataset.initialized === "true") return;
  const raw = readStrings();
  const inputEl = root.querySelector<HTMLElement>("[data-yaml-input]");
  const outputEl = root.querySelector<HTMLElement>("[data-yaml-output]");
  if (!raw || !inputEl || !outputEl) return;
  root.dataset.initialized = "true";
  const strings: Strings = raw;
  // Unlocated generic error reads "YAML is invalid (location unknown)" (+ the raw parser detail).
  const diagStrings: DiagnosticStrings = { ...strings.diag, SyntaxNoLocation: strings.invalid };

  const formatBtn = root.querySelector<HTMLButtonElement>("[data-yaml-format]");
  const validateBtn = root.querySelector<HTMLButtonElement>("[data-yaml-validate]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-yaml-clear]");
  const pasteBtn = root.querySelector<HTMLButtonElement>("[data-yaml-paste]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-yaml-copy]");
  const status = root.querySelector<HTMLElement>("[data-yaml-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-yaml-error]");
  const inputHost = root.querySelector<HTMLElement>("[data-yaml-input-host]");
  const outputPanel = root.querySelector<HTMLElement>("[data-yaml-output-panel]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-yaml-example]");

  let inputEditor: MdtEditor;
  let outputEditor: MdtEditor;
  try {
    const kit = await loadEditorKit();
    [inputEditor, outputEditor] = await Promise.all([
      kit.createEditor(inputEl, {
        language: "yaml",
        label: strings.inputLabel,
        phrases: strings.phrases,
        hintId: "yaml-editor-hint",
        indent: 2,
        diagnostics: errorBox ? { box: errorBox, goToLabel: strings.diag.GoTo ?? "" } : undefined,
        onSubmit: () => formatBtn?.click(),
        onChange: () => syncInput(),
      }),
      kit.createEditor(outputEl, {
        language: "yaml",
        label: strings.outputLabel,
        phrases: strings.phrases,
        readOnly: true,
        onChange: () => syncOutput(),
      }),
    ]);
  } catch (err) {
    console.error("YAML tool: failed to load the editor", err);
    return;
  }

  /** Input overlay follows the input document (typing, Paste, example, Clear). */
  function syncInput() {
    if (inputHost) syncEmptyState(inputHost, inputEditor.getValue() === "");
  }
  /** Output placeholder until there is a result; Copy needs text. */
  function syncOutput() {
    const empty = outputEditor.getValue() === "";
    if (outputPanel) syncEmptyState(outputPanel, empty);
    if (copyBtn) copyBtn.disabled = empty;
  }
  syncInput();
  syncOutput();
  if (exampleBtn) bindLoadExample(exampleBtn, () => inputEditor.setValue(EXAMPLE), inputEditor.view.contentDOM);

  /** Parser error (string from the WASM) → diagnostic on the input text that was parsed; null clears. */
  function showError(error: string | null, yaml = "") {
    if (error === null) {
      inputEditor.setDiagnostic(null);
      return;
    }
    inputEditor.setDiagnostic(presentDiagnostic(diagStrings, yamlDiagnostic(yaml, error), yaml), { announce: true });
  }
  function showStatus(kind: "valid" | "invalid" | null) {
    if (!status) return;
    status.hidden = kind === null;
    status.textContent = kind === "valid" ? strings.valid : kind === "invalid" ? strings.invalid : "";
    status.classList.toggle("ds-badge-success", kind === "valid");
    status.classList.toggle("ds-badge-danger", kind === "invalid");
  }
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function run(btn: HTMLButtonElement | null, action: (client: SdClient, yaml: string) => Promise<void>) {
    const yaml = inputEditor.getValue();
    if (!yaml.trim()) {
      showError(null);
      showStatus(null);
      outputEditor.setValue("");
      return;
    }
    const operation = startToolOperation("yaml-beautifier-validator");
    btn?.setAttribute("aria-busy", "true");
    try {
      const host = btn?.closest<HTMLElement>(".ds-action-row") ?? outputPanel;
      await withPreparing("structured_data", (async () => action(await sdClient(), yaml))(), {
        host,
        label: strings.preparing,
      });
      showError(null);
      revealOutput(outputPanel);
      if (inputEditor.getValue() === yaml) operation.complete();
    } catch (e) {
      outputEditor.setValue("");
      showStatus("invalid");
      // The input changed while WASM loaded/ran: its marker would point at the wrong text.
      if (inputEditor.getValue() === yaml) showError(message(e), yaml);
      if (inputEditor.getValue() === yaml) operation.fail();
    } finally {
      btn?.removeAttribute("aria-busy");
    }
  }

  formatBtn?.addEventListener("click", () =>
    void run(formatBtn, async (client, yaml) => {
      outputEditor.setValue(await client.yamlFormat(yaml));
      showStatus("valid");
    }),
  );

  validateBtn?.addEventListener("click", () =>
    void run(validateBtn, async (client, yaml) => {
      await client.yamlValidate(yaml);
      outputEditor.setValue(strings.valid);
      showStatus("valid");
    }),
  );

  clearBtn?.addEventListener("click", () => {
    inputEditor.setValue("");
    outputEditor.setValue("");
    showError(null);
    showStatus(null);
    inputEditor.focus();
  });

  pasteBtn?.addEventListener("click", async () => {
    try {
      inputEditor.setValue(await navigator.clipboard.readText());
      inputEditor.focus();
    } catch {
      /* clipboard read denied/unavailable — user can paste with Ctrl/Cmd-V */
    }
  });

  copyBtn?.addEventListener("click", () => {
    const text = outputEditor.getValue();
    if (text) void copyWithFeedback(copyBtn, text, strings.copied, undefined, { failedLabel: strings.copyFailed });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
