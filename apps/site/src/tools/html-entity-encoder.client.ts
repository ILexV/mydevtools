/**
 * HTML Entity Encoder/Decoder client. Wires input/output, mode + format
 * selects, and encode/decode/swap/clear/copy actions. All transforms via
 * `entities.ts`; pure JS, no network, no WASM. Workbench empty states: input
 * overlay with "Load example" (only on click) and a compact output placeholder.
 */
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import {
  bindEmptyState,
  bindLoadExample,
  copyWithFeedback,
  revealOutput,
  setFieldValue,
  setLiveText,
  syncEmptyState,
} from "@/scripts/tool-ui";
import { formatBytes, formatString } from "@/lib/format";
import { encodeHtml, decodeHtml, type EntityMode, type EntityFormat } from "@/tools/entities";

/** "Load example" sample: markup with quotes, ampersand and non-ASCII (language-neutral). */
const EXAMPLE = '<a href="/menu?item=café&size=L" title="Tom & Jerry\'s">5 € — “crème brûlée” 🍮</a>';

interface Strings {
  copied: string;
  copyFailed?: string;
  errCopyFailed: string;
  /** Shared encoder stats: "Characters: {0} · Size: {1}" (entity text chars · plain text UTF-8 size). */
  outputSummary: string;
  lang: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-ent-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-ent-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-ent-input]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-ent-output]");
  const modeSel = root.querySelector<HTMLSelectElement>("[data-ent-mode]");
  const formatSel = root.querySelector<HTMLSelectElement>("[data-ent-format]");
  const errorBox = root.querySelector<HTMLElement>("[data-ent-error]");
  const summary = root.querySelector<HTMLElement>("[data-ent-summary]");
  if (!input || !output) return;
  root.dataset.initialized = "true";

  const clearError = () => {
    if (errorBox) errorBox.hidden = true;
  };
  const inputHost = root.querySelector<HTMLElement>("[data-ent-input-host]");
  const outputPanel = root.querySelector<HTMLElement>("[data-ent-output-panel]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-ent-example]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-ent-copy]");
  const syncInput = inputHost ? bindEmptyState(inputHost, input) : () => {};
  if (exampleBtn) bindLoadExample(exampleBtn, () => setFieldValue(input, EXAMPLE));

  /** Which box holds the plain (decoded) text: encode → input, decode → output; swap flips it. */
  let plainSide: "input" | "output" = "input";

  // Announce each result (the readonly textarea's value change is silent) and
  // toggle the output placeholder / Copy availability. Stats match the other
  // encoders: entity-text character count · plain-text UTF-8 size.
  const announce = () => {
    if (outputPanel) syncEmptyState(outputPanel, output.value === "");
    if (copyBtn) copyBtn.disabled = output.value === "";
    if (!summary) return;
    const [encoded, plain] = plainSide === "input" ? [output.value, input.value] : [input.value, output.value];
    const n = Array.from(encoded).length;
    const size = formatBytes(new TextEncoder().encode(plain).length);
    setLiveText(summary, output.value ? formatString(strings.outputSummary, n.toLocaleString(strings.lang), size) : "");
  };

  root.querySelector<HTMLButtonElement>("[data-ent-encode]")?.addEventListener("click", () => {
    clearError();
    const mode = (modeSel?.value ?? "specialchars") as EntityMode;
    const format = (formatSel?.value ?? "named") as EntityFormat;
    const operation = startToolOperation("html-entity-encoder");
    try {
      output.value = encodeHtml(input.value, mode, format);
      plainSide = "input";
      announce();
      revealOutput(outputPanel);
      operation.complete();
    } catch (error) {
      operation.fail();
      throw error;
    }
  });

  root.querySelector<HTMLButtonElement>("[data-ent-decode]")?.addEventListener("click", () => {
    clearError();
    const operation = startToolOperation("html-entity-encoder");
    try {
      output.value = decodeHtml(input.value);
      plainSide = "output";
      announce();
      revealOutput(outputPanel);
      operation.complete();
    } catch (error) {
      operation.fail();
      throw error;
    }
  });

  root.querySelector<HTMLButtonElement>("[data-ent-swap]")?.addEventListener("click", () => {
    clearError();
    const prev = input.value;
    input.value = output.value;
    output.value = prev;
    plainSide = plainSide === "input" ? "output" : "input";
    syncInput();
    announce();
  });

  root.querySelector<HTMLButtonElement>("[data-ent-clear]")?.addEventListener("click", () => {
    clearError();
    input.value = "";
    output.value = "";
    syncInput();
    announce();
    input.focus();
  });

  copyBtn?.addEventListener("click", async () => {
    const ok = await copyWithFeedback(copyBtn, output.value, strings.copied, undefined, {
      failedLabel: strings.copyFailed,
    });
    if (!ok && errorBox) {
      errorBox.textContent = strings.errCopyFailed;
      errorBox.hidden = false;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
