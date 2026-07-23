/**
 * HMAC Calculator client controller. Drives the `HmacCalculator.astro`
 * shell, calling the main-thread `crypto-client` (one-shot WASM ops).
 * Live recalculation on input/change (legacy parity): text key, hex output,
 * SHA-256/SHA-512. Copy button appears only when output is non-empty.
 *
 * Loads only on the HMAC tool page (the component imports this script), so
 * the WASM module is fetched only there. SSR-safe: no-ops when the shell is
 * absent.
 */
import { hmacCompute, type HmacAlgorithm } from "@/scripts/wasm/crypto-client";

interface Strings {
  copy: string;
  copied: string;
  error: string;
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

  function setCopyVisible(visible: boolean) {
    if (copyBtn) copyBtn.hidden = !visible;
  }

  async function calculate() {
    const keyVal = keyArea.value;
    const msgVal = messageArea.value;

    // Legacy: silently clear output until both inputs are present.
    if (!keyVal || !msgVal) {
      outputArea.value = "";
      setCopyVisible(false);
      return;
    }

    try {
      const alg = (algorithm?.value ?? "sha256") as HmacAlgorithm;
      const hex = await hmacCompute(alg, keyVal, msgVal, "text", "hex");
      outputArea.value = hex;
      clearError();
      setCopyVisible(true);
    } catch (e) {
      outputArea.value = "";
      setCopyVisible(false);
      showError(e instanceof Error ? e.message : strings.error);
    }
  }

  keyArea.addEventListener("input", calculate);
  messageArea.addEventListener("input", calculate);
  algorithm?.addEventListener("change", calculate);
  calculateBtn?.addEventListener("click", calculate);

  clearBtn?.addEventListener("click", () => {
    keyArea.value = "";
    messageArea.value = "";
    outputArea.value = "";
    setCopyVisible(false);
    clearError();
  });

  copyBtn?.addEventListener("click", async () => {
    const btn = copyBtn;
    if (!btn || !outputArea.value) return;
    try {
      await navigator.clipboard.writeText(outputArea.value);
      const original = btn.textContent;
      btn.textContent = strings.copied;
      setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
