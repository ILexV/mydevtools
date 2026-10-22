import { copyWithFeedback, prepareCopyButton } from "@/scripts/tool-ui";
import { CODE_LANGUAGES, type CodeLanguage } from "@/tools/http-codegen";
import { bindDialogClose } from "@/tools/http-scope-dialogs";

/** Remembered snippet language of the «Code» window; a setting, not request data. */
const LANGUAGE_KEY = "mdt.http-code-language.v1";

/**
 * «Import cURL» window of the HTTP client tree. `onImport` creates the request
 * and returns an error text to show, or null when the window can close.
 */
export function bindImportDialog(dialog: HTMLDialogElement, onImport: (command: string) => string | null): {
  open(trigger: HTMLElement): void;
} {
  const form = dialog.querySelector<HTMLFormElement>("[data-http-import-form]")!;
  const text = dialog.querySelector<HTMLTextAreaElement>("[data-http-import-text]")!;
  const error = dialog.querySelector<HTMLElement>("[data-http-import-error]")!;
  const remember = bindDialogClose(dialog, dialog.querySelector<HTMLButtonElement>("[data-http-import-close]")!);
  const hideError = (): void => {
    error.hidden = true;
    error.textContent = "";
  };
  text.addEventListener("input", hideError);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = onImport(text.value);
    if (message) {
      error.textContent = message;
      error.hidden = false;
      text.focus();
      return;
    }
    text.value = "";
    dialog.close();
  });
  return {
    open(trigger) {
      if (dialog.open) return;
      remember(trigger);
      hideError();
      dialog.showModal();
      text.focus();
    },
  };
}

/**
 * «Code» window: the open request as cURL, fetch, Python requests or HTTPie.
 * `generate` resolves the request and throws a localized message on failure.
 */
export function bindCodeDialog(
  dialog: HTMLDialogElement,
  copiedLabel: string,
  generate: (language: CodeLanguage) => Promise<string>,
): { open(trigger: HTMLElement): void } {
  const language = dialog.querySelector<HTMLSelectElement>("[data-http-code-language]")!;
  const output = dialog.querySelector<HTMLElement>("[data-http-code-output]")!;
  const error = dialog.querySelector<HTMLElement>("[data-http-code-error]")!;
  const copy = dialog.querySelector<HTMLButtonElement>("[data-http-code-copy]")!;
  const remember = bindDialogClose(dialog, dialog.querySelector<HTMLButtonElement>("[data-http-code-close]")!);
  prepareCopyButton(copy, copiedLabel, null);
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved && (CODE_LANGUAGES as readonly string[]).includes(saved)) language.value = saved;
  } catch {
    // Storage may be unavailable; cURL stays the default.
  }
  let revision = 0;

  async function render(): Promise<void> {
    const current = ++revision;
    try {
      const code = await generate(language.value as CodeLanguage);
      if (current !== revision) return;
      output.textContent = code;
      error.hidden = true;
      copy.disabled = false;
    } catch (failure) {
      if (current !== revision) return;
      output.textContent = "";
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
      copy.disabled = true;
    }
  }

  language.addEventListener("change", () => {
    try {
      localStorage.setItem(LANGUAGE_KEY, language.value);
    } catch {
      // Not remembered without storage.
    }
    void render();
  });
  copy.addEventListener("click", () => { void copyWithFeedback(copy, output.textContent ?? "", copiedLabel); });
  dialog.addEventListener("close", () => { revision++; });
  return {
    open(trigger) {
      if (dialog.open) return;
      remember(trigger);
      output.textContent = "";
      error.hidden = true;
      dialog.showModal();
      language.focus();
      void render();
    },
  };
}
