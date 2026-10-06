/**
 * Date Converter client. Wires input/type/format selects + custom-format field
 * to live conversion, current-time fill, copy, and error display. All parsing
 * and formatting delegates to `dates.ts`.
 */
import { parse, format, type InputType, type OutputFormat } from "@/tools/dates";
import {
  bindEmptyState,
  bindLoadExample,
  copyWithFeedback,
  revealOutput,
  setFieldValue,
  syncEmptyState,
} from "@/scripts/tool-ui";

/** Language-neutral example: 2023-11-14T22:13:20Z as Unix seconds (auto-detected). */
const EXAMPLE = "1700000000";

interface Strings {
  lang: string;
  copied: string;
  copyFailed: string;
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
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "1";
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
  const inputHost = root.querySelector<HTMLElement>("[data-date-input-host]");
  const outputPanel = root.querySelector<HTMLElement>("[data-date-output-panel]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-date-example]");
  const syncInput = inputHost && input ? bindEmptyState(inputHost, input) : () => {};

  /** Write the result and collapse/expand the output panel's empty state. */
  function setOutput(text: string): void {
    if (output) output.value = text;
    if (outputPanel) syncEmptyState(outputPanel, text === "");
  }

  function toggleCustom(): void {
    if (!customWrap || !outputFormat) return;
    customWrap.hidden = outputFormat.value !== "custom";
  }

  function showError(msg: string): void {
    if (!errorEl) return;
    errorEl.hidden = !msg;
    errorEl.textContent = msg;
  }

  function convert(): void {
    if (!input || !inputType || !outputFormat || !output) return;
    toggleCustom();
    const val = input.value;
    if (!val.trim()) {
      setOutput("");
      showError("");
      input.removeAttribute("aria-invalid");
      return;
    }
    const date = parse(val, inputType.value as InputType);
    if (!date || Number.isNaN(date.getTime())) {
      showError(strings.errorInvalid);
      input.setAttribute("aria-invalid", "true");
      setOutput("");
      return;
    }
    showError("");
    input.removeAttribute("aria-invalid");
    const custom = customInput ? customInput.value : "";
    setOutput(format(date, outputFormat.value as OutputFormat, custom, strings.lang) ?? "");
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
    syncInput();
    convert();
  }

  async function copy(): Promise<void> {
    if (!output || !copyBtn) return;
    const text = output.value;
    if (!text) return;
    if (!(await copyWithFeedback(copyBtn, text, strings.copied))) showError(strings.copyFailed);
  }

  if (exampleBtn && input) bindLoadExample(exampleBtn, () => setFieldValue(input, EXAMPLE));
  /** Explicit Convert / Now: bring a fresh result into view on phones (never on typing). */
  const revealIfFilled = () => {
    if (output?.value) revealOutput(outputPanel);
  };
  convertBtn?.addEventListener("click", () => {
    convert();
    revealIfFilled();
  });
  nowBtn?.addEventListener("click", () => {
    currentTime();
    revealIfFilled();
  });
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
