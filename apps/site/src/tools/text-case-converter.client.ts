/**
 * Text Case Converter client. Wires each case button to apply its transform
 * in-place to the textarea. Clear empties; Copy writes to clipboard with
 * transient `.is-copied` feedback (localized error if the Clipboard API is
 * unavailable). All transforms come from `text-case.ts` (pure JS).
 * Empty textarea shows a hint + "Load example" (localized sample, on click only).
 */
import { convertCase, type CaseType } from "@/tools/text-case";
import { bindEmptyState, bindLoadExample, copyWithFeedback, setFieldValue } from "@/scripts/tool-ui";

interface Strings {
  copied: string;
  copyFailed: string;
  copyFailedShort?: string;
  example?: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-tcc-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-tcc-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const textarea = root.querySelector<HTMLTextAreaElement>("[data-tcc-textarea]");
  if (!textarea) return;
  const input = textarea;
  const errorEl = root.querySelector<HTMLElement>("[data-tcc-error]");
  const inputHost = root.querySelector<HTMLElement>("[data-tcc-input-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-tcc-example]");
  const syncInput = inputHost ? bindEmptyState(inputHost, input) : () => {};
  if (exampleBtn && strings.example) {
    const sample = strings.example;
    bindLoadExample(exampleBtn, () => setFieldValue(input, sample));
  }
  const showError = (message: string | null) => {
    if (!errorEl) return;
    errorEl.textContent = message ?? "";
    errorEl.hidden = message === null;
  };

  root.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const caseBtn = target.closest<HTMLButtonElement>("[data-tcc-case]");
    if (caseBtn) {
      e.preventDefault();
      const type = caseBtn.dataset.tccCase as CaseType;
      input.value = convertCase(input.value, type);
      showError(null);
      return;
    }
    if (target.closest("[data-tcc-clear]")) {
      e.preventDefault();
      input.value = "";
      syncInput();
      showError(null);
      input.focus();
      return;
    }
    const copyBtn = target.closest<HTMLButtonElement>("[data-tcc-copy]");
    if (copyBtn) {
      e.preventDefault();
      void copyWithFeedback(copyBtn, input.value, strings.copied, undefined, {
        failedLabel: strings.copyFailedShort,
      }).then((ok) => {
        showError(ok ? null : strings.copyFailed);
      });
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
