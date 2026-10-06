/**
 * JWT Decoder client controller. Live-decodes the token on input in TS
 * (`decodeJwt`: original claim order, pretty-printed) into the two output
 * areas, shows the algorithm badge and exp/nbf/iat claims, and
 * verifies the signature with `jwtVerify` on every input/secret change.
 * Status: verified / invalid / unsigned (`alg: none`) / unsupported alg /
 * "enter a secret" when the secret is empty (instead of a bare "invalid").
 */
import { jwtVerify } from "@/scripts/wasm/crypto-client";
import { bindEmptyState, bindLoadExample, setFieldValue, syncEmptyState, withPreparing } from "@/scripts/tool-ui";
import { algFromHeader, classifyAlg, decodeJwt, normalizeToken, timeClaims } from "@/tools/jwt";

interface Strings {
  signatureVerified: string;
  signatureInvalid: string;
  invalidToken: string;
  enterSecret: string;
  unsignedToken: string;
  unsupportedAlgorithm: string;
  claimExpired: string;
  claimExpiresAt: string;
  claimNotBefore: string;
  claimValidFrom: string;
  claimIssuedAt: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
}

/**
 * "Load example": a synthetic HS256 demo token (sub "user-1234", exp 2100-01-01)
 * signed with the throwaway secret below, so the example also shows "verified".
 */
const EXAMPLE_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJ1c2VyLTEyMzQiLCJuYW1lIjoiRGVtbyBVc2VyIiwicm9sZSI6InZpZXdlciIsImlhdCI6MTc2NzIyNTYwMCwiZXhwIjo0MTAyNDQ0ODAwfQ." +
  "rV5714Mls37YtVABZFdQ9O195iuMAnR8bn6ugUIBl2g";
const EXAMPLE_SECRET = "demo-secret-not-for-production";

type StatusKind = "success" | "error" | "warning" | "neutral";

const ICON_VALID =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="20" height="20" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';
const ICON_INVALID =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="20" height="20" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';

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
  const claims = root.querySelector<HTMLElement>("[data-jwtd-claims]");
  const outputPanel = root.querySelector<HTMLElement>("[data-jwtd-output]");
  const inputHost = root.querySelector<HTMLElement>("[data-jwtd-input-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-jwtd-example]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-jwtd-clear]");
  if (!encoded || !header || !payload || !secret || !status || !algBadge || !errorBox || !claims) return;

  const encodedArea: HTMLTextAreaElement = encoded;
  const headerArea: HTMLTextAreaElement = header;
  const payloadArea: HTMLTextAreaElement = payload;
  const secretArea: HTMLTextAreaElement = secret;
  const statusBox: HTMLElement = status;
  const algEl: HTMLElement = algBadge;
  const errorEl: HTMLElement = errorBox;
  const claimsList: HTMLElement = claims;
  const dateFmt = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });

  let runId = 0;

  function setError(message: string | null) {
    errorEl.textContent = message ?? "";
    errorEl.hidden = message === null;
    if (message === null) encodedArea.removeAttribute("aria-invalid");
    else encodedArea.setAttribute("aria-invalid", "true");
  }

  function clearOutputs() {
    headerArea.value = "";
    payloadArea.value = "";
    algEl.textContent = "";
    if (outputPanel) syncEmptyState(outputPanel, true);
    statusBox.hidden = true;
    statusBox.innerHTML = "";
    claimsList.hidden = true;
    claimsList.replaceChildren();
  }

  function showStatus(kind: StatusKind, message: string, icon = "") {
    statusBox.hidden = false;
    statusBox.className = `ds-alert ds-alert-${kind} jwtd-status`;
    statusBox.innerHTML = icon;
    const span = document.createElement("span");
    span.textContent = message;
    statusBox.appendChild(span);
  }

  function renderClaims(payloadJson: string) {
    const items = timeClaims(payloadJson, Date.now() / 1000);
    claimsList.replaceChildren(
      ...items.map((c) => {
        const li = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = c.claim;
        const text = document.createElement("span");
        let date: string;
        try {
          date = dateFmt.format(new Date(c.seconds * 1000));
        } catch {
          date = String(c.seconds); // out of Date range
        }
        const template =
          c.claim === "exp"
            ? c.problem ? strings.claimExpired : strings.claimExpiresAt
            : c.claim === "nbf"
              ? c.problem ? strings.claimNotBefore : strings.claimValidFrom
              : strings.claimIssuedAt;
        text.textContent = template.replace("{date}", date);
        text.className = `ds-status${c.problem ? " is-error" : ""}`;
        li.append(code, text);
        return li;
      }),
    );
    claimsList.hidden = items.length === 0;
  }

  async function updateAll() {
    const id = ++runId;
    const token = normalizeToken(encodedArea.value);

    if (!token) {
      setError(null);
      clearOutputs();
      return;
    }

    // Decoded in TS rather than WASM `jwt_decode`, which re-sorted keys alphabetically.
    const decoded = decodeJwt(token);
    if (!decoded.ok) {
      setError(strings.invalidToken.replace("{message}", decoded.error));
      clearOutputs();
      return;
    }
    setError(null);
    const headerJson = decoded.header;
    const payloadJson = decoded.payload;

    headerArea.value = headerJson;
    payloadArea.value = payloadJson;
    if (outputPanel) syncEmptyState(outputPanel, false);
    renderClaims(payloadJson);

    const alg = algFromHeader(headerJson) ?? "HS256";
    algEl.textContent = alg;
    const kind = classifyAlg(alg);

    if (kind === "none") {
      showStatus("warning", strings.unsignedToken, ICON_INVALID);
      return;
    }
    if (kind === "unsupported") {
      showStatus("warning", strings.unsupportedAlgorithm.replace("{alg}", alg));
      return;
    }
    if (!secretArea.value) {
      showStatus("neutral", strings.enterSecret);
      return;
    }

    let verified = false;
    try {
      verified = await withPreparing("cryptography", jwtVerify(token, secretArea.value, alg), {
        host: outputPanel,
        label: strings.preparing,
      });
    } catch {
      verified = false; // malformed signature segment / bad PEM → not verified
    }
    if (id !== runId) return;
    showStatus(
      verified ? "success" : "error",
      verified ? strings.signatureVerified : strings.signatureInvalid,
      verified ? ICON_VALID : ICON_INVALID,
    );
  }

  encodedArea.addEventListener("input", () => void updateAll());
  const syncInput = inputHost ? bindEmptyState(inputHost, encodedArea) : () => {};
  if (exampleBtn) {
    bindLoadExample(exampleBtn, () => {
      secretArea.value = EXAMPLE_SECRET;
      setFieldValue(encodedArea, EXAMPLE_TOKEN);
    });
  }
  clearBtn?.addEventListener("click", () => {
    encodedArea.value = "";
    syncInput();
    void updateAll();
    encodedArea.focus();
  });
  secretArea.addEventListener("input", () => void updateAll());

  if (encodedArea.value) void updateAll();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
