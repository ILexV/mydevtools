/**
 * YAML Beautifier/Validator client controller. CodeMirror 5 editors via the
 * legacy vendored build (`ensureCodeMirror`); `mode:'yaml'` is kept verbatim
 * from legacy — no yaml mode file was ever vendored, so CodeMirror no-ops to
 * plain text (parity). Format/validate run through the structured-data WASM
 * client (loaded on first use); errors show the localized "invalid" label
 * plus the parser detail; status badge valid/invalid; paste/copy/clear.
 */
import { ensureCodeMirror, getCodeMirror, makeEditorAccessible, refreshOnThemeChange } from "@/scripts/codemirror-loader";
import { copyWithFeedback } from "@/scripts/tool-ui";

interface Strings {
  inputLabel: string;
  outputLabel: string;
  valid: string;
  invalid: string;
  copied: string;
}

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

  try {
    await ensureCodeMirror();
  } catch (err) {
    console.error("YAML tool: failed to load CodeMirror", err);
    return;
  }
  const CM = getCodeMirror();
  if (!CM) return;

  const inputEditor = CM(inputEl, {
    mode: "yaml",
    theme: "default",
    lineNumbers: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: true,
  });
  const outputEditor = CM(outputEl, {
    mode: "yaml",
    theme: "default",
    lineNumbers: true,
    readOnly: true,
    lineWrapping: true,
  });
  makeEditorAccessible(inputEditor, strings.inputLabel, "yaml-editor-hint");
  makeEditorAccessible(outputEditor, strings.outputLabel);
  refreshOnThemeChange([inputEditor, outputEditor]);

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
    if (text) void copyWithFeedback(copyBtn, text, strings.copied);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
