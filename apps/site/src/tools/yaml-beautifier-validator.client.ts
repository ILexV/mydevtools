/**
 * YAML Beautifier/Validator client controller. CodeMirror 6 editors (lazy
 * editor kit, `@codemirror/lang-yaml` highlight + folding). Format/validate run through the structured-data WASM
 * client (loaded on first use); errors show the localized "invalid" label
 * plus the parser detail; status badge valid/invalid; paste/copy/clear.
 * Workbench empty states: input overlay + "Load example" (only on click),
 * compact output placeholder until there is a result.
 */
import { loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import { bindLoadExample, copyWithFeedback, syncEmptyState } from "@/scripts/tool-ui";

interface Strings {
  inputLabel: string;
  outputLabel: string;
  valid: string;
  invalid: string;
  copied: string;
  copyFailed?: string;
  phrases?: Record<string, string>;
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

  function showError(detail: string | null) {
    inputEl?.classList.toggle("is-error", detail !== null);
    if (!errorBox) return;
    errorBox.textContent = detail === null ? "" : detail ? `${strings.invalid}: ${detail}` : strings.invalid;
    errorBox.hidden = detail === null;
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
    btn?.setAttribute("aria-busy", "true");
    try {
      await action(await sdClient(), yaml);
      showError(null);
    } catch (e) {
      outputEditor.setValue("");
      showError(message(e));
      showStatus("invalid");
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
