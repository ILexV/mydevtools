/**
 * HTML Entity Encoder/Decoder client. Wires input/output, mode + format
 * selects, and encode/decode/swap/clear/copy actions. All transforms via
 * `entities.ts`; pure JS, no network, no WASM.
 */
import { copyWithFeedback, setLiveText } from "@/scripts/tool-ui";
import { formatString } from "@/lib/format";
import { encodeHtml, decodeHtml, type EntityMode, type EntityFormat } from "@/tools/entities";

interface Strings {
  copied: string;
  errCopyFailed: string;
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
  // Announce each result (the readonly textarea's value change is silent).
  const announce = () => {
    if (!summary) return;
    const n = Array.from(output.value).length;
    setLiveText(summary, output.value ? formatString(strings.outputSummary, n.toLocaleString(strings.lang)) : "");
  };

  root.querySelector<HTMLButtonElement>("[data-ent-encode]")?.addEventListener("click", () => {
    clearError();
    const mode = (modeSel?.value ?? "specialchars") as EntityMode;
    const format = (formatSel?.value ?? "named") as EntityFormat;
    output.value = encodeHtml(input.value, mode, format);
    announce();
  });

  root.querySelector<HTMLButtonElement>("[data-ent-decode]")?.addEventListener("click", () => {
    clearError();
    output.value = decodeHtml(input.value);
    announce();
  });

  root.querySelector<HTMLButtonElement>("[data-ent-swap]")?.addEventListener("click", () => {
    clearError();
    const prev = input.value;
    input.value = output.value;
    output.value = prev;
    announce();
  });

  root.querySelector<HTMLButtonElement>("[data-ent-clear]")?.addEventListener("click", () => {
    clearError();
    input.value = "";
    output.value = "";
    announce();
  });

  const copyBtn = root.querySelector<HTMLButtonElement>("[data-ent-copy]");
  copyBtn?.addEventListener("click", async () => {
    const ok = await copyWithFeedback(copyBtn, output.value, strings.copied);
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
