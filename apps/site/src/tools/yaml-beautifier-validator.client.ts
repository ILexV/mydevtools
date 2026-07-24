/**
 * YAML Beautifier/Validator client controller. CodeMirror 5 editors via the
 * legacy vendored build (`ensureCodeMirror`); `mode:'yaml'` is kept verbatim
 * from legacy — no yaml mode file was ever vendored, so CodeMirror no-ops to
 * plain text (parity). Format/validate run through the structured-data WASM
 * client; errors surface as the WASM message in the error box (legacy parity).
 */
import { ensureCodeMirror } from "@/scripts/codemirror-loader";
import { yamlFormat, yamlValidate } from "@/scripts/wasm/structured-data-client";

interface Strings {
  valid: string;
  invalid: string;
  copied: string;
}

interface CodeMirrorEditor {
  getValue(): string;
  setValue(value: string): void;
}
type CodeMirrorFactory = (el: HTMLElement, options: Record<string, unknown>) => CodeMirrorEditor;

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-yaml-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

async function init() {
  const root = document.querySelector<HTMLElement>("[data-yaml-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const inputEl = root.querySelector<HTMLElement>("[data-yaml-input]");
  const outputEl = root.querySelector<HTMLElement>("[data-yaml-output]");
  const formatBtn = root.querySelector<HTMLButtonElement>("[data-yaml-format]");
  const validateBtn = root.querySelector<HTMLButtonElement>("[data-yaml-validate]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-yaml-clear]");
  const pasteBtn = root.querySelector<HTMLButtonElement>("[data-yaml-paste]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-yaml-copy]");
  const status = root.querySelector<HTMLElement>("[data-yaml-status]");
  const errorBox = root.querySelector<HTMLElement>("[data-yaml-error]");
  if (!inputEl || !outputEl) return;
  const inputHost: HTMLElement = inputEl;
  const outputHost: HTMLElement = outputEl;

  // Idempotency: CodeMirror presence means already initialized.
  if (root.querySelector(".CodeMirror")) return;

  await ensureCodeMirror();
  const CM = window.CodeMirror as CodeMirrorFactory | undefined;
  if (!CM) return;

  const inputEditor = CM(inputHost, {
    mode: "yaml",
    theme: "default",
    lineNumbers: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: true,
    viewportMargin: Infinity,
  });

  const outputEditor = CM(outputHost, {
    mode: "yaml",
    theme: "default",
    lineNumbers: true,
    readOnly: true,
    lineWrapping: true,
    viewportMargin: Infinity,
  });

  function showError(msg: string) {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }
  function showStatus(kind: "valid" | "invalid" | null) {
    if (!status) return;
    if (!kind) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    status.textContent = kind === "valid" ? strings.valid : strings.invalid;
    status.classList.toggle("is-valid", kind === "valid");
    status.classList.toggle("is-invalid", kind === "invalid");
  }

  formatBtn?.addEventListener("click", async () => {
    const yaml = inputEditor.getValue().trim();
    if (!yaml) return;
    try {
      const result = await yamlFormat(yaml);
      outputEditor.setValue(result);
      clearError();
      showStatus(null);
    } catch (e) {
      outputEditor.setValue("");
      showError(e instanceof Error ? e.message : String(e));
    }
  });

  validateBtn?.addEventListener("click", async () => {
    const yaml = inputEditor.getValue().trim();
    if (!yaml) return;
    try {
      await yamlValidate(yaml);
      outputEditor.setValue(strings.valid);
      clearError();
      showStatus("valid");
    } catch (e) {
      outputEditor.setValue("");
      showError(e instanceof Error ? e.message : String(e));
      showStatus("invalid");
    }
  });

  clearBtn?.addEventListener("click", () => {
    inputEditor.setValue("");
    outputEditor.setValue("");
    clearError();
    showStatus(null);
  });

  pasteBtn?.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      inputEditor.setValue(text);
    } catch {
      /* clipboard unavailable */
    }
  });

  copyBtn?.addEventListener("click", async () => {
    const text = outputEditor.getValue();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (copyBtn) {
        const orig = copyBtn.textContent;
        copyBtn.textContent = strings.copied;
        setTimeout(() => {
          copyBtn.textContent = orig;
        }, 1200);
      }
    } catch {
      /* clipboard unavailable */
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
