/**
 * JWT Encoder client controller. Live-signs on every input/change (legacy
 * parity — no sign button): validates header/payload JSON inline (must be
 * JSON objects), forces the selected algorithm into the header for signing,
 * and writes the token to the read-only output. Segments come from
 * `buildSigningInput` (order-preserving); the HMAC from WASM `jwt_sign_input`.
 */
import { jwtSignInput } from "@/scripts/wasm/crypto-client";
import { copyWithFeedback, syncEmptyState, withPreparing } from "@/scripts/tool-ui";
import { buildSigningInput, jsonObjectProblem, type JwtHmacAlg } from "@/tools/jwt";

interface Strings {
  copied: string;
  copyFailed: string;
  invalidJson: string;
  mustBeObject: string;
  encodeFailed: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
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
  const outputPanel = root.querySelector<HTMLElement>("[data-jwte-output-panel]");

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
  const encodeErr: HTMLElement = encodeError;
  const headerErr: HTMLElement = headerError;
  const payloadErr: HTMLElement = payloadError;

  /** Monotonic guard so rapid typing can't apply a stale token out of order. */
  let signSeq = 0;

  function setFieldError(area: HTMLTextAreaElement, errEl: HTMLElement, message: string | null) {
    errEl.textContent = message ?? "";
    errEl.hidden = message === null;
    if (message === null) area.removeAttribute("aria-invalid");
    else area.setAttribute("aria-invalid", "true");
  }

  function setEncodeError(message: string | null) {
    encodeErr.textContent = message ?? "";
    encodeErr.hidden = message === null;
  }

  function clearToken() {
    outputArea.value = "";
    copyButton.disabled = true;
    if (outputPanel) syncEmptyState(outputPanel, true);
  }

  async function generateToken() {
    const seq = ++signSeq;
    const alg = algSelect.value as JwtHmacAlg;
    const built = buildSigningInput(headerArea.value, payloadArea.value, alg);

    // Report both fields independently (a header error must not hide a payload one).
    const messageFor = (r: "json" | "object" | null) =>
      r === "json" ? strings.invalidJson : r === "object" ? strings.mustBeObject : null;
    setFieldError(headerArea, headerErr, messageFor(jsonObjectProblem(headerArea.value)));
    setFieldError(payloadArea, payloadErr, messageFor(jsonObjectProblem(payloadArea.value)));

    if (!built.ok) {
      clearToken();
      setEncodeError(null);
      return;
    }

    try {
      const signature = await withPreparing("cryptography", jwtSignInput(built.input, secretArea.value, alg), {
        host: outputPanel,
        label: strings.preparing,
      });
      if (seq !== signSeq) return;
      outputArea.value = `${built.input}.${signature}`;
      setEncodeError(null);
      copyButton.disabled = false;
      if (outputPanel) syncEmptyState(outputPanel, false);
    } catch (err) {
      if (seq !== signSeq) return;
      clearToken();
      const msg = err instanceof Error ? err.message : String(err);
      setEncodeError(strings.encodeFailed.replace("{msg}", msg));
    }
  }

  headerArea.addEventListener("input", () => void generateToken());
  payloadArea.addEventListener("input", () => void generateToken());
  secretArea.addEventListener("input", () => void generateToken());
  algSelect.addEventListener("change", () => void generateToken());

  copyButton.addEventListener("click", async () => {
    if (!outputArea.value) return;
    const ok = await copyWithFeedback(copyButton, outputArea.value, strings.copied);
    if (!ok) setEncodeError(strings.copyFailed);
  });

  // Initial token from the prefilled header/payload (legacy init parity).
  void generateToken();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
