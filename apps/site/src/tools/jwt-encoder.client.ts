/**
 * JWT Encoder client controller. Live-signs on every input/change (legacy
 * parity — no sign button): validates header/payload JSON inline, forces the
 * selected algorithm into the header for signing, and writes the token to the
 * read-only output. Copy button swaps its label for 1200ms.
 */
import { jwtSign } from "@/scripts/wasm/crypto-client";

interface Strings {
  copy: string;
  copied: string;
  invalidJson: string;
  encodeFailed: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-jwte-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-jwte-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const headerInput = root.querySelector<HTMLTextAreaElement>("[data-jwte-header]");
  const payloadInput = root.querySelector<HTMLTextAreaElement>("[data-jwte-payload]");
  const secretInput = root.querySelector<HTMLTextAreaElement>("[data-jwte-secret]");
  const algorithmSelect = root.querySelector<HTMLSelectElement>("[data-jwte-algorithm]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-jwte-output]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-jwte-copy]");
  const headerError = root.querySelector<HTMLElement>("[data-jwte-header-error]");
  const payloadError = root.querySelector<HTMLElement>("[data-jwte-payload-error]");
  const encodeError = root.querySelector<HTMLElement>("[data-jwte-error]");

  if (
    !headerInput ||
    !payloadInput ||
    !secretInput ||
    !algorithmSelect ||
    !output ||
    !copyBtn ||
    !headerError ||
    !payloadError ||
    !encodeError
  ) {
    return;
  }
  const headerArea: HTMLTextAreaElement = headerInput;
  const payloadArea: HTMLTextAreaElement = payloadInput;
  const secretArea: HTMLTextAreaElement = secretInput;
  const algSelect: HTMLSelectElement = algorithmSelect;
  const outputArea: HTMLTextAreaElement = output;
  const copyButton: HTMLButtonElement = copyBtn;
  const headerErr: HTMLElement = headerError;
  const payloadErr: HTMLElement = payloadError;
  const encodeErr: HTMLElement = encodeError;

  /** Monotonic guard so rapid typing can't apply a stale token out of order. */
  let signSeq = 0;

  function validateJson(text: string, errEl: HTMLElement): boolean {
    try {
      JSON.parse(text);
      errEl.hidden = true;
      return true;
    } catch {
      errEl.textContent = strings.invalidJson;
      errEl.hidden = false;
      return false;
    }
  }

  async function generateToken() {
    const seq = ++signSeq;
    const headerOk = validateJson(headerArea.value, headerErr);
    const payloadOk = validateJson(payloadArea.value, payloadErr);
    if (!headerOk || !payloadOk) {
      outputArea.value = "";
      copyButton.disabled = true;
      encodeErr.hidden = true;
      return;
    }

    // Force the selected algorithm into the header for signing only — the
    // header textarea is never rewritten (legacy parity).
    const headerObj = JSON.parse(headerArea.value) as Record<string, unknown>;
    headerObj.alg = algSelect.value;
    const updatedHeader = JSON.stringify(headerObj);

    try {
      const token = await jwtSign(updatedHeader, payloadArea.value, secretArea.value, algSelect.value);
      if (seq !== signSeq) return;
      outputArea.value = token;
      encodeErr.hidden = true;
      copyButton.disabled = false;
    } catch (err) {
      if (seq !== signSeq) return;
      outputArea.value = "";
      copyButton.disabled = true;
      const msg = err instanceof Error ? err.message : String(err);
      encodeErr.textContent = strings.encodeFailed.replace("{msg}", msg);
      encodeErr.hidden = false;
    }
  }

  headerArea.addEventListener("input", () => void generateToken());
  payloadArea.addEventListener("input", () => void generateToken());
  secretArea.addEventListener("input", () => void generateToken());
  algSelect.addEventListener("change", () => void generateToken());

  copyButton.addEventListener("click", async () => {
    if (!outputArea.value) return;
    try {
      await navigator.clipboard.writeText(outputArea.value);
      const orig = copyButton.textContent;
      copyButton.textContent = strings.copied;
      setTimeout(() => {
        copyButton.textContent = orig;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  // Initial token from the prefilled header/payload (legacy init parity).
  void generateToken();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
