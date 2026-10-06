/**
 * URL Encoder / Decoder client controller. Drives the `UrlEncoder.astro`
 * shell, calling the main-thread `encoding-client` (one-shot WASM ops).
 * Text-only: encode/decode act on the shared textarea via separate buttons
 * (legacy parity — no file input, no download). Errors are localized; a
 * charset error selects the offending character.
 *
 * Loads only on the URL tool page (the component imports this script), so the
 * WASM module is fetched only there. SSR-safe: no-ops when the shell is absent.
 * Workbench empty states: input overlay + "Load example", output placeholder.
 */
import { formatBytes, formatString } from "@/lib/format";
import { bindEmptyState, bindLoadExample, copyWithFeedback, setFieldValue, syncEmptyState } from "@/scripts/tool-ui";
import { decodeToBytes, bytesToText, encodeBytes, textToBytes, type EncodingOptions } from "@/scripts/wasm/encoding-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { classifyEncodingError } from "@/tools/encoding-ui";

/** "Load example" sample: a URL with a query, non-ASCII text and a fragment. */
const EXAMPLE = "https://example.com/search?q=café & crème&page=2#résumé";

interface Strings {
  copied: string;
  copyFailed?: string;
  statsOutput: string;
  errNotRepresentable: string;
  errNotText: string;
  errInvalidPercent: string;
  errCopyFailed: string;
  error: string;
}

function readStrings(): Strings | null {
  const island = document.querySelector<HTMLScriptElement>("[data-url-strings]");
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-url-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-url-input]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-url-output]");
  const errorBox = root.querySelector<HTMLElement>("[data-url-error]");
  if (!input || !output || !errorBox) return;
  root.dataset.initialized = "true";
  const inputArea: HTMLTextAreaElement = input;
  const outputArea: HTMLTextAreaElement = output;
  const errorArea: HTMLElement = errorBox;
  const mode = root.querySelector<HTMLSelectElement>("[data-url-mode]");
  const charset = root.querySelector<HTMLSelectElement>("[data-url-charset]");
  const encodeBtn = root.querySelector<HTMLButtonElement>("[data-url-encode]");
  const decodeBtn = root.querySelector<HTMLButtonElement>("[data-url-decode]");
  const swapBtn = root.querySelector<HTMLButtonElement>("[data-url-swap]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-url-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-url-copy]");
  const stats = root.querySelector<HTMLElement>("[data-url-stats]");
  const lang = document.documentElement.lang || "en";
  const inputHost = root.querySelector<HTMLElement>("[data-url-input-host]");
  const outputPanel = root.querySelector<HTMLElement>("[data-url-output-panel]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-url-example]");
  const syncInput = inputHost ? bindEmptyState(inputHost, inputArea) : () => {};
  if (exampleBtn) bindLoadExample(exampleBtn, () => setFieldValue(inputArea, EXAMPLE));

  /** Write the result and toggle the output placeholder / Copy availability. */
  function setOutput(text: string) {
    outputArea.value = text;
    if (outputPanel) syncEmptyState(outputPanel, text === "");
    if (copyBtn) copyBtn.disabled = text === "";
  }

  function options(): EncodingOptions {
    return { format: "url", mode: mode?.value || "component", charset: charset?.value || "utf-8" };
  }

  function showError(message: string) {
    errorArea.textContent = message;
    errorArea.hidden = false;
  }
  function clearError() {
    errorArea.hidden = true;
    errorArea.textContent = "";
    inputArea.removeAttribute("aria-invalid");
  }
  function setStats(chars: number | null, bytes = 0) {
    if (stats) stats.textContent = chars === null ? "" : formatString(strings.statsOutput, chars.toLocaleString(lang), formatBytes(bytes));
  }

  function handleFailure(e: unknown) {
    if (e instanceof WasmError && e.code === "aborted") {
      clearError();
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const { key, position } = classifyEncodingError(message);
    setOutput("");
    setStats(null);
    inputArea.setAttribute("aria-invalid", "true");
    if (key === "Error_NotRepresentable") {
      showError(formatString(strings.errNotRepresentable, (position ?? 0) + 1));
      if (position !== undefined) {
        try {
          inputArea.focus();
          inputArea.setSelectionRange(position, Math.min(position + 1, inputArea.value.length));
        } catch {
          /* selection unsupported */
        }
      }
    } else if (key === "Error_NotText") {
      showError(strings.errNotText);
    } else {
      showError(strings.errInvalidPercent);
    }
  }

  async function run(direction: "encode" | "decode", trigger: HTMLButtonElement | null) {
    clearError();
    for (const b of [encodeBtn, decodeBtn]) if (b) b.disabled = true;
    trigger?.setAttribute("aria-busy", "true");
    try {
      const opts = options();
      if (direction === "encode") {
        const bytes = await textToBytes(inputArea.value, opts.charset);
        const out = await encodeBytes(opts, bytes);
        setOutput(out);
        setStats(out.length, bytes.length);
      } else {
        const bytes = await decodeToBytes(opts, inputArea.value);
        setOutput(await bytesToText(bytes, opts.charset));
        setStats(inputArea.value.length, bytes.length);
      }
    } catch (e) {
      handleFailure(e);
    } finally {
      for (const b of [encodeBtn, decodeBtn]) if (b) b.disabled = false;
      trigger?.removeAttribute("aria-busy");
    }
  }

  encodeBtn?.addEventListener("click", () => run("encode", encodeBtn));
  decodeBtn?.addEventListener("click", () => run("decode", decodeBtn));
  inputArea.addEventListener("input", () => inputArea.removeAttribute("aria-invalid"));

  swapBtn?.addEventListener("click", () => {
    clearError();
    const a = inputArea.value;
    inputArea.value = outputArea.value;
    syncInput();
    setOutput(a);
    setStats(null);
  });

  clearBtn?.addEventListener("click", () => {
    inputArea.value = "";
    syncInput();
    setOutput("");
    setStats(null);
    clearError();
    inputArea.focus();
  });

  copyBtn?.addEventListener("click", async () => {
    const ok = await copyWithFeedback(copyBtn, outputArea.value, strings.copied, undefined, {
      failedLabel: strings.copyFailed,
    });
    if (!ok) showError(strings.errCopyFailed);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
