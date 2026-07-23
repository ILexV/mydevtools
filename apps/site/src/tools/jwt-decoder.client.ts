/**
 * JWT Decoder client controller. Live-decodes the token on input via
 * `jwtDecode` (crypto WASM), splits pretty header/payload JSON into the two
 * output areas, shows the algorithm badge from the header, and verifies the
 * signature with `jwtVerify` on every input/secret change (legacy parity:
 * verify failures and empty secrets both render "invalid").
 */
import { jwtDecode, jwtVerify } from "@/scripts/wasm/crypto-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  signatureVerified: string;
  signatureInvalid: string;
}

const ICON_VALID =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';
const ICON_INVALID =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-jwtd-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-jwtd-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const encoded = root.querySelector<HTMLTextAreaElement>("[data-jwtd-encoded]");
  const header = root.querySelector<HTMLTextAreaElement>("[data-jwtd-header]");
  const payload = root.querySelector<HTMLTextAreaElement>("[data-jwtd-payload]");
  const secret = root.querySelector<HTMLTextAreaElement>("[data-jwtd-secret]");
  const errorBox = root.querySelector<HTMLElement>("[data-jwtd-error]");
  const status = root.querySelector<HTMLElement>("[data-jwtd-status]");
  const algBadge = root.querySelector<HTMLElement>("[data-jwtd-alg]");
  if (!encoded || !header || !payload || !secret || !status || !algBadge) return;

  const encodedArea: HTMLTextAreaElement = encoded;
  const headerArea: HTMLTextAreaElement = header;
  const payloadArea: HTMLTextAreaElement = payload;
  const secretArea: HTMLTextAreaElement = secret;
  const statusBox: HTMLElement = status;
  const algEl: HTMLElement = algBadge;

  let runId = 0;

  function clearOutputs() {
    headerArea.value = "";
    payloadArea.value = "";
    algEl.textContent = "ALG";
    statusBox.hidden = true;
    statusBox.classList.remove("is-valid", "is-invalid");
    statusBox.innerHTML = "";
  }

  function algFromHeader(headerJson: string): string {
    try {
      const obj = JSON.parse(headerJson) as { alg?: unknown };
      return typeof obj.alg === "string" && obj.alg ? obj.alg : "HS256";
    } catch {
      return "HS256";
    }
  }

  function showStatus(verified: boolean) {
    statusBox.hidden = false;
    statusBox.classList.remove("is-valid", "is-invalid");
    statusBox.classList.add(verified ? "is-valid" : "is-invalid");
    statusBox.innerHTML = `${verified ? ICON_VALID : ICON_INVALID}<span>${
      verified ? strings.signatureVerified : strings.signatureInvalid
    }</span>`;
  }

  async function updateAll() {
    const id = ++runId;
    const token = encodedArea.value.trim();

    if (!token) {
      if (errorBox) errorBox.hidden = true;
      clearOutputs();
      return;
    }

    let decodedJson: string;
    try {
      decodedJson = await jwtDecode(token);
    } catch (err) {
      if (id !== runId) return;
      if (errorBox) {
        errorBox.textContent =
          err instanceof WasmError || err instanceof Error ? err.message : String(err);
        errorBox.hidden = false;
      }
      clearOutputs();
      return;
    }
    if (id !== runId) return;
    if (errorBox) errorBox.hidden = true;

    let headerJson = "";
    let payloadJson = "";
    try {
      const decoded = JSON.parse(decodedJson) as { header?: unknown; payload?: unknown };
      headerJson = typeof decoded.header === "string" ? decoded.header : "";
      payloadJson = typeof decoded.payload === "string" ? decoded.payload : "";
    } catch {
      headerJson = decodedJson;
    }

    headerArea.value = headerJson;
    payloadArea.value = payloadJson;

    const alg = algFromHeader(headerJson);
    algEl.textContent = alg;

    let verified = false;
    try {
      verified = await jwtVerify(token, secretArea.value, alg);
    } catch {
      verified = false;
    }
    if (id !== runId) return;
    showStatus(verified);
  }

  encodedArea.addEventListener("input", () => {
    void updateAll();
  });
  secretArea.addEventListener("input", () => {
    void updateAll();
  });

  if (encodedArea.value) {
    void updateAll();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
