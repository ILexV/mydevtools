/**
 * HMAC Calculator client controller. Drives the `HmacCalculator.astro`
 * shell, calling the main-thread `crypto-client` (one-shot WASM ops).
 * Live recalculation on input/change: text key, hex output, SHA-256/SHA-512.
 * A key is required; an empty message is a valid HMAC input (RFC 2104) and
 * is computed (legacy showed nothing). Copy appears only with output.
 *
 * Loads only on the HMAC tool page (the component imports this script), so
 * the WASM module is fetched only there. SSR-safe: no-ops when the shell is
 * absent.
 */
import { hmacCompute, type HmacAlgorithm } from "@/scripts/wasm/crypto-client";
import {
  bindEmptyState,
  bindLoadExample,
  copyWithFeedback,
  revealOutput,
  setFieldValue,
  syncEmptyState,
  withPreparing,
} from "@/scripts/tool-ui";

/** Synthetic "Load example" pair: a throwaway demo key and a webhook-like JSON body. */
const EXAMPLE_KEY = "demo-secret-key-not-for-production";
const EXAMPLE_MESSAGE = '{"event":"order.created","id":1042,"amount":"19.99"}';

interface Strings {
  copy: string;
  copied: string;
  copyFailed: string;
  error: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
}

function readStrings(): Strings | null {
  const island = document.querySelector<HTMLScriptElement>("[data-hmac-strings]");
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-hmac-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const key = root.querySelector<HTMLTextAreaElement>("[data-hmac-key]");
  const message = root.querySelector<HTMLTextAreaElement>("[data-hmac-message]");
  const algorithm = root.querySelector<HTMLSelectElement>("[data-hmac-algorithm]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-hmac-output]");
  const calculateBtn = root.querySelector<HTMLButtonElement>("[data-hmac-calculate]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-hmac-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-hmac-copy]");
  const errorBox = root.querySelector<HTMLElement>("[data-hmac-error]");
  const outputPanel = root.querySelector<HTMLElement>("[data-hmac-output-panel]");
  const messageHost = root.querySelector<HTMLElement>("[data-hmac-message-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-hmac-example]");

  if (!key || !message || !output) return;
  const keyArea: HTMLTextAreaElement = key;
  const messageArea: HTMLTextAreaElement = message;
  const outputArea: HTMLTextAreaElement = output;

  function showError(msg: string) {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
  }

  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  /** Copy shows only with a result; the output panel's empty state otherwise. */
  function setCopyVisible(visible: boolean) {
    if (copyBtn) copyBtn.hidden = !visible;
    if (outputPanel) syncEmptyState(outputPanel, !visible);
  }

  const syncMessage = messageHost ? bindEmptyState(messageHost, messageArea) : () => {};
  if (exampleBtn) {
    bindLoadExample(exampleBtn, () => {
      keyArea.value = EXAMPLE_KEY;
      setFieldValue(messageArea, EXAMPLE_MESSAGE);
    });
  }

  // Live recalc fires per keystroke; only the newest run may write output.
  let runId = 0;

  /** Returns true when a fresh result was written (for the explicit Calculate reveal). */
  async function calculate(): Promise<boolean> {
    const run = ++runId;
    const keyVal = keyArea.value;
    const msgVal = messageArea.value;

    // No key yet → nothing to show. The message may be empty: HMAC(key, "") is valid.
    if (!keyVal) {
      clearError();
      outputArea.value = "";
      setCopyVisible(false);
      return false;
    }

    try {
      const alg = (algorithm?.value ?? "sha256") as HmacAlgorithm;
      const hex = await withPreparing("cryptography", hmacCompute(alg, keyVal, msgVal, "text", "hex"), {
        host: calculateBtn?.closest<HTMLElement>(".ds-action-row") ?? outputPanel,
        label: strings.preparing,
      });
      if (run !== runId) return false;
      outputArea.value = hex;
      clearError();
      setCopyVisible(true);
      return true;
    } catch (e) {
      if (run !== runId) return false;
      outputArea.value = "";
      setCopyVisible(false);
      showError(e instanceof Error ? e.message : strings.error);
      return false;
    }
  }

  keyArea.addEventListener("input", calculate);
  messageArea.addEventListener("input", calculate);
  algorithm?.addEventListener("change", calculate);
  calculateBtn?.addEventListener("click", async () => {
    if (await calculate()) revealOutput(outputPanel);
  });

  clearBtn?.addEventListener("click", () => {
    runId++;
    keyArea.value = "";
    messageArea.value = "";
    syncMessage();
    outputArea.value = "";
    setCopyVisible(false);
    clearError();
    keyArea.focus();
  });

  copyBtn?.addEventListener("click", () => {
    if (!copyBtn || !outputArea.value) return;
    void copyWithFeedback(copyBtn, outputArea.value, strings.copied, undefined, { failedLabel: strings.copyFailed });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
