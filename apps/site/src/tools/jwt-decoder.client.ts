/**
 * JWT Decoder client controller. Live-decodes the token on input in TS
 * (`decodeJwt`: original claim order, pretty-printed) into the two output
 * areas, shows the algorithm badge and exp/nbf/iat claims, and
 * verifies the signature with `jwtVerify` on every input/secret change.
 * Status: verified / invalid / unsigned (`alg: none`) / unsupported alg /
 * "enter a secret" when the secret is empty (instead of a bare "invalid").
 * Also renders the colourized token-parts preview (collapsible) and the
 * temporal status of exp/nbf/iat, refreshed on a timer (1 s near a boundary,
 * 60 s otherwise, paused while the tab is hidden) WITHOUT re-verifying the
 * signature; only status transitions are announced.
 */
import { jwtVerify } from "@/scripts/wasm/crypto-client";
import {
  bindEmptyState,
  bindLoadExample,
  setFieldValue,
  setLiveText,
  syncEmptyState,
  withPreparing,
} from "@/scripts/tool-ui";
import { algFromHeader, classifyAlg, decodeJwt, normalizeToken } from "@/tools/jwt";
import {
  nextRefreshDelay,
  readTemporalClaims,
  relativeParts,
  temporalReport,
  type TemporalClaim,
  type TemporalClaimName,
  type TemporalStatus,
  type TemporalWarning,
} from "@/tools/jwt-time";
import { formatString } from "@/lib/format";

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
  previewExpand: string;
  previewCollapse: string;
  timeStatus: Record<TemporalStatus, string>;
  timeStatusAnnounce: string;
  claimLabels: Record<TemporalClaimName, string>;
  claimErrorType: string;
  claimErrorRange: string;
  warnNbfAfterExp: string;
  warnIatAfterExp: string;
  warnIatInFuture: string;
  warnMilliseconds: string;
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

const ICON_CLOCK =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';
const ICON_ALERT =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>';

/** Badge tone + icon per temporal status (text always carries the state too). */
const TIME_BADGE: Record<TemporalStatus, { tone: string; icon: string }> = {
  invalid: { tone: "ds-badge-danger", icon: ICON_ALERT },
  expired: { tone: "ds-badge-danger", icon: ICON_INVALID },
  "not-yet-valid": { tone: "ds-badge-warning", icon: ICON_CLOCK },
  "expires-soon": { tone: "ds-badge-warning", icon: ICON_ALERT },
  valid: { tone: "ds-badge-success", icon: ICON_CLOCK },
  unbounded: { tone: "", icon: ICON_CLOCK },
};

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
  const sigWrap = root.querySelector<HTMLElement>("[data-jwtd-sig]");
  const preview = root.querySelector<HTMLElement>("[data-jwtd-preview]");
  const previewToken = root.querySelector<HTMLElement>("[data-jwtd-preview-token]");
  const previewToggle = root.querySelector<HTMLButtonElement>("[data-jwtd-preview-toggle]");
  const timeBox = root.querySelector<HTMLElement>("[data-jwtd-time]");
  const timeBadge = root.querySelector<HTMLElement>("[data-jwtd-time-status]");
  const timeLive = root.querySelector<HTMLElement>("[data-jwtd-time-live]");
  const diagList = root.querySelector<HTMLElement>("[data-jwtd-diag]");
  if (!encoded || !header || !payload || !secret || !status || !algBadge || !errorBox || !claims) return;

  const encodedArea: HTMLTextAreaElement = encoded;
  const headerArea: HTMLTextAreaElement = header;
  const payloadArea: HTMLTextAreaElement = payload;
  const secretArea: HTMLTextAreaElement = secret;
  const statusBox: HTMLElement = status;
  const algEl: HTMLElement = algBadge;
  const errorEl: HTMLElement = errorBox;
  const claimsList: HTMLElement = claims;
  const lang = document.documentElement.lang || undefined;
  // Absolute date with the zone ("timeStyle: long" adds e.g. "GMT+6").
  const dateFmt = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "long" });
  const relFmt = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });

  let runId = 0;
  /** Temporal claims of the current token (null = no time section). */
  let currentClaims: TemporalClaim[] | null = null;
  let tickTimer: number | undefined;
  let announceTimer: number | undefined;
  let lastAnnounced: TemporalStatus | null = null;
  let previewExpanded = false;

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
    if (sigWrap) sigWrap.hidden = true;
    renderPreview("");
    setTimeClaims(null);
  }

  function showStatus(kind: StatusKind, message: string, icon = "") {
    if (sigWrap) sigWrap.hidden = false;
    statusBox.hidden = false;
    statusBox.className = `ds-alert ds-alert-${kind} jwtd-status`;
    statusBox.innerHTML = icon;
    const span = document.createElement("span");
    span.textContent = message;
    statusBox.appendChild(span);
  }

  /** Colourized read-only copy of the token: header.payload.signature spans + neutral dots. */
  function renderPreview(token: string) {
    if (!preview || !previewToken) return;
    if (!token) {
      preview.hidden = true;
      previewToken.replaceChildren();
      return;
    }
    const parts = token.split(".");
    const nodes: Node[] = [];
    const names = ["header", "payload", "signature"];
    parts.forEach((part, i) => {
      if (i > 0) {
        const dot = document.createElement("span");
        dot.className = "jwtd-dot";
        dot.textContent = ".";
        nodes.push(dot);
      }
      const span = document.createElement("span");
      const name = names[i];
      if (name) span.dataset.part = name; // extra (JWE) segments stay neutral
      span.textContent = part;
      nodes.push(span);
    });
    previewToken.replaceChildren(...nodes);
    preview.hidden = false;
    syncPreviewToggle();
  }

  /** Show the expand control only when the collapsed preview actually overflows 3 lines. */
  function syncPreviewToggle() {
    if (!previewToken || !previewToggle || !preview || preview.hidden) return;
    previewToken.classList.toggle("is-collapsed", !previewExpanded);
    const overflows = previewExpanded || previewToken.scrollHeight > previewToken.clientHeight + 1;
    previewToggle.hidden = !overflows;
    previewToggle.setAttribute("aria-expanded", String(previewExpanded));
    previewToggle.textContent = previewExpanded ? strings.previewCollapse : strings.previewExpand;
  }

  function formatDate(seconds: number): string {
    try {
      return dateFmt.format(new Date(seconds * 1000));
    } catch {
      return String(seconds);
    }
  }

  function formatRelative(seconds: number, nowSeconds: number): string {
    const { value, unit } = relativeParts(seconds - nowSeconds);
    return relFmt.format(value, unit);
  }

  function warningText(w: TemporalWarning): string {
    switch (w.code) {
      case "nbf-after-exp":
        return strings.warnNbfAfterExp;
      case "iat-after-exp":
        return strings.warnIatAfterExp;
      case "iat-in-future":
        return strings.warnIatInFuture;
      case "milliseconds":
        return formatString(strings.warnMilliseconds, w.claim);
    }
  }

  function stopTicking() {
    if (tickTimer !== undefined) window.clearTimeout(tickTimer);
    tickTimer = undefined;
  }

  /** Re-render only the time block on a timer; never touches decoding or the signature check. */
  function scheduleTick() {
    stopTicking();
    if (!currentClaims || currentClaims.length === 0 || document.hidden) return;
    tickTimer = window.setTimeout(() => {
      renderTime();
      scheduleTick();
    }, nextRefreshDelay(currentClaims, Date.now() / 1000));
  }

  /** Announce a settled status change once (debounced so typing doesn't chatter). */
  function announceStatus(status: TemporalStatus | null) {
    if (announceTimer !== undefined) window.clearTimeout(announceTimer);
    if (status === null) {
      lastAnnounced = null;
      return;
    }
    announceTimer = window.setTimeout(() => {
      if (status === lastAnnounced || !timeLive) return;
      lastAnnounced = status;
      setLiveText(timeLive, formatString(strings.timeStatusAnnounce, strings.timeStatus[status]));
    }, 600);
  }

  function setTimeClaims(claims: TemporalClaim[] | null) {
    currentClaims = claims;
    renderTime();
    scheduleTick();
  }

  /** Status badge, exp/nbf/iat rows (absolute date + zone, relative time) and diagnostics. */
  function renderTime() {
    if (!timeBox || !timeBadge || !diagList) return;
    const claims = currentClaims;
    if (!claims) {
      timeBox.hidden = true;
      claimsList.replaceChildren();
      diagList.replaceChildren();
      announceStatus(null);
      return;
    }
    const now = Date.now() / 1000;
    const report = temporalReport(claims, now);
    const badge = TIME_BADGE[report.status];
    timeBadge.className = `ds-badge jwtd-time-badge ${badge.tone}`.trim();
    timeBadge.innerHTML = badge.icon;
    const label = document.createElement("span");
    label.textContent = strings.timeStatus[report.status];
    timeBadge.appendChild(label);

    claimsList.replaceChildren(
      ...claims.map((c) => {
        const li = document.createElement("li");
        li.className = "ds-result-row jwtd-claim";
        const key = document.createElement("span");
        key.className = "ds-result-key jwtd-claim-key";
        const code = document.createElement("code");
        code.textContent = c.claim;
        const name = document.createElement("span");
        name.className = "jwtd-claim-name";
        name.textContent = strings.claimLabels[c.claim];
        key.append(code, name);
        const value = document.createElement("span");
        value.className = "ds-result-value";
        const rel = document.createElement("span");
        rel.className = "ds-status jwtd-claim-rel";
        if (c.seconds === null) {
          value.textContent = c.raw;
          const err = document.createElement("span");
          err.className = "jwtd-claim-error";
          err.textContent = c.problem === "range" ? strings.claimErrorRange : strings.claimErrorType;
          value.appendChild(err);
        } else {
          value.textContent = formatDate(c.seconds);
          rel.textContent = formatRelative(c.seconds, now);
          if (c.claim === "exp" && (report.status === "expired" || report.status === "expires-soon")) {
            rel.classList.add(report.status === "expired" ? "is-error" : "is-warning");
          } else if (c.claim === "nbf" && report.status === "not-yet-valid") {
            rel.classList.add("is-warning");
          }
        }
        li.append(key, value, rel);
        return li;
      }),
    );
    claimsList.hidden = claims.length === 0;
    diagList.replaceChildren(
      ...report.warnings.map((w) => {
        const li = document.createElement("li");
        li.textContent = warningText(w);
        return li;
      }),
    );
    diagList.hidden = report.warnings.length === 0;
    timeBox.hidden = false;
    announceStatus(report.status);
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
    renderPreview(token);
    setTimeClaims(readTemporalClaims(payloadJson));

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

  previewToggle?.addEventListener("click", () => {
    previewExpanded = !previewExpanded;
    syncPreviewToggle();
  });
  // Wrapping depends on the panel width: re-check whether 3 lines overflow.
  if (previewToken && "ResizeObserver" in window) {
    new ResizeObserver(() => syncPreviewToggle()).observe(previewToken);
  }
  // Pause the time refresh while the tab is hidden; recompute on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTicking();
    } else {
      renderTime();
      scheduleTick();
    }
  });

  if (encodedArea.value) void updateAll();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
