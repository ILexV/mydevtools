/**
 * Date Converter client. Wires input/type/format selects + custom-format field
 * to live conversion, current-time fill, copy, and error display. All parsing
 * and formatting delegates to `dates.ts`.
 */
import { parse, format, type InputType, type OutputFormat } from "@/tools/dates";

interface Strings {
  copied: string;
  errorInvalid: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-date-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-date-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-date-input]");
  const inputType = root.querySelector<HTMLSelectElement>("[data-date-input-type]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-date-output]");
  const outputFormat = root.querySelector<HTMLSelectElement>("[data-date-output-format]");
  const customWrap = root.querySelector<HTMLElement>("[data-date-custom-wrap]");
  const customInput = root.querySelector<HTMLInputElement>("[data-date-custom]");
  const convertBtn = root.querySelector<HTMLButtonElement>("[data-date-convert]");
  const nowBtn = root.querySelector<HTMLButtonElement>("[data-date-now]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-date-copy]");
  const errorEl = root.querySelector<HTMLElement>("[data-date-error]");
  const errorText = root.querySelector<HTMLElement>("[data-date-error-text]");

  function toggleCustom(): void {
    if (!customWrap || !outputFormat) return;
    customWrap.hidden = outputFormat.value !== "custom";
  }

  function showError(msg: string): void {
    if (!errorEl) return;
    errorEl.hidden = !msg;
    if (msg && errorText) errorText.textContent = msg;
  }

  function convert(): void {
    if (!input || !inputType || !outputFormat || !output) return;
    toggleCustom();
    const val = input.value;
    if (!val.trim()) {
      output.value = "";
      showError("");
      return;
    }
    const date = parse(val, inputType.value as InputType);
    if (!date || Number.isNaN(date.getTime())) {
      showError(strings.errorInvalid);
      output.value = "";
      return;
    }
    showError("");
    const custom = customInput ? customInput.value : "";
    output.value = format(date, outputFormat.value as OutputFormat, custom) ?? "";
  }

  function currentTime(): void {
    if (!input || !inputType) return;
    const now = new Date();
    const type = inputType.value as InputType;
    if (type === "unix-sec" || type === "auto") {
      input.value = Math.floor(now.getTime() / 1000).toString();
    } else if (type === "unix-ms") {
      input.value = now.getTime().toString();
    } else {
      input.value = now.toISOString();
    }
    convert();
  }

  async function copy(): Promise<void> {
    if (!output || !copyBtn) return;
    const text = output.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const orig = copyBtn.textContent;
      copyBtn.textContent = strings.copied;
      setTimeout(() => {
        copyBtn.textContent = orig;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  convertBtn?.addEventListener("click", convert);
  nowBtn?.addEventListener("click", currentTime);
  copyBtn?.addEventListener("click", () => void copy());
  input?.addEventListener("input", convert);
  customInput?.addEventListener("input", convert);
  inputType?.addEventListener("change", convert);
  outputFormat?.addEventListener("change", convert);

  convert();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
