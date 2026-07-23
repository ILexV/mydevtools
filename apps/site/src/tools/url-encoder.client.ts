/**
 * URL Encoder / Decoder client controller. Drives the `UrlEncoder.astro`
 * shell, calling the main-thread `encoding-client` (one-shot WASM ops).
 * Text-only: encode/decode act on the shared textarea via separate buttons
 * (legacy parity — no file input, no download).
 *
 * Loads only on the URL tool page (the component imports this script), so the
 * WASM module is fetched only there. SSR-safe: no-ops when the shell is absent.
 */
import { encodeText, decodeText } from "@/scripts/wasm/encoding-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  copy: string;
  copied: string;
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

/** Pull a character/byte index out of a WASM error message, if present. */
function errorIndex(message: string): number | null {
  const match = message.match(/position (\d+)/) || message.match(/index (\d+)/) || message.match(/byte (\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-url-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-url-input]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-url-output]");
  const mode = root.querySelector<HTMLSelectElement>("[data-url-mode]");
  const charset = root.querySelector<HTMLSelectElement>("[data-url-charset]");
  const encodeBtn = root.querySelector<HTMLButtonElement>("[data-url-encode]");
  const decodeBtn = root.querySelector<HTMLButtonElement>("[data-url-decode]");
  const swapBtn = root.querySelector<HTMLButtonElement>("[data-url-swap]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-url-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-url-copy]");
  const errorBox = root.querySelector<HTMLElement>("[data-url-error]");

  function showError(message: string, index: number | null) {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    if (input && index !== null && index >= 0) {
      try {
        input.focus();
        input.setSelectionRange(index, Math.min(index + 1, input.value.length));
      } catch {
        /* selection unsupported */
      }
    }
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  function setBusy(busy: boolean) {
    if (encodeBtn) encodeBtn.disabled = busy;
    if (decodeBtn) decodeBtn.disabled = busy;
  }

  function handleFailure(e: unknown) {
    if (e instanceof WasmError && e.code === "aborted") {
      clearError(); // cancellation is not an error to surface
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    showError(`${strings.error}: ${message}`, errorIndex(message));
  }

  async function handleEncode() {
    if (!input || !output) return;
    clearError();
    setBusy(true);
    try {
      output.value = await encodeText(
        { format: "url", mode: mode?.value || "component", charset: charset?.value || "utf-8" },
        input.value || "",
      );
    } catch (e) {
      handleFailure(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDecode() {
    if (!input || !output) return;
    clearError();
    setBusy(true);
    try {
      output.value = await decodeText(
        { format: "url", mode: mode?.value || "component", charset: charset?.value || "utf-8" },
        input.value || "",
      );
    } catch (e) {
      handleFailure(e);
    } finally {
      setBusy(false);
    }
  }

  encodeBtn?.addEventListener("click", handleEncode);
  decodeBtn?.addEventListener("click", handleDecode);

  swapBtn?.addEventListener("click", () => {
    if (!input || !output) return;
    clearError();
    const a = input.value;
    input.value = output.value;
    output.value = a;
  });

  clearBtn?.addEventListener("click", () => {
    if (input) input.value = "";
    if (output) output.value = "";
    clearError();
  });

  copyBtn?.addEventListener("click", async () => {
    if (!output || !copyBtn) return;
    try {
      await navigator.clipboard.writeText(output.value || "");
      const orig = copyBtn.textContent;
      copyBtn.textContent = strings.copied;
      setTimeout(() => { copyBtn.textContent = orig; }, 1200);
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
