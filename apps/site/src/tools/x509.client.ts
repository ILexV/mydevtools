/**
 * X.509 client controller. Generate self-signed certs / CSRs and parse PEM or
 * Base64-DER certificates and PKCS#10 CSRs (subject, key, SANs, extensions,
 * self-signature check) via the main-thread `crypto-client` WASM helpers.
 * Legacy parity: Ed25519 by default (legacy passed algorithm id 1 = Ed25519),
 * pretty-JSON output, copy/download, download names
 * certificate.pem / request.csr.pem / x509.json.
 * Fixes vs. legacy: the subject accepts a full DN (`CN=…,O=…,C=…`) instead of
 * stuffing the whole string into the CN; "Validity (days)" is honoured
 * (legacy certs were valid 1975–4096); errors are localized and kept apart
 * from certificate warnings; Subject Alternative Names (DNS / IP / e-mail,
 * validated by parseSanList) go into the certificate / CSR extensionRequest —
 * the CN is not copied into the SANs automatically, an empty list only warns.
 */
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import {
  x509Parse,
  x509ParseCsr,
  x509Warnings,
  x509SelfSignedEx,
  x509CsrEx,
  bytesToHex,
  X509_ALG,
} from "@/scripts/wasm/crypto-client";
import {
  bindEmptyState,
  bindLoadExample,
  copyWithFeedback,
  revealOutput,
  setFieldValue,
  syncEmptyState,
  withPreparing,
} from "@/scripts/tool-ui";
import { base64ToBytes, derBase64ToPem, isCsrPem, parseSanList, parseValidityDays, prettyJson, type SanList } from "@/tools/x509-helpers";

interface Strings {
  copy: string;
  copied: string;
  copyFailed: string;
  download: string;
  warningsTitle: string;
  invalidFormat: string;
  errorValidityDays: string;
  errorInvalidSubject: string;
  errorInvalidSan: string;
  warningNoSan: string;
  error: string;
  warningCsrSignature: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-x509-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-x509-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const subject = root.querySelector<HTMLInputElement>("[data-x509-subject]");
  const algorithm = root.querySelector<HTMLSelectElement>("[data-x509-algorithm]");
  const validity = root.querySelector<HTMLInputElement>("[data-x509-validity]");
  const san = root.querySelector<HTMLTextAreaElement>("[data-x509-san]");
  const generateSelfSignedBtn = root.querySelector<HTMLButtonElement>("[data-x509-generate-selfsigned]");
  const generateCsrBtn = root.querySelector<HTMLButtonElement>("[data-x509-generate-csr]");
  const parseInput = root.querySelector<HTMLTextAreaElement>("[data-x509-parse-input]");
  const parseBtn = root.querySelector<HTMLButtonElement>("[data-x509-parse]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-x509-output]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-x509-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-x509-download]");
  const warnings = root.querySelector<HTMLElement>("[data-x509-warnings]");
  const errorEl = root.querySelector<HTMLElement>("[data-x509-error]");
  const outputPanel = root.querySelector<HTMLElement>("[data-x509-output-panel]");
  const parseHost = root.querySelector<HTMLElement>("[data-x509-parse-host]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-x509-example]");

  if (!subject || !validity || !san || !parseInput || !output || !warnings || !errorEl) return;
  const sanArea: HTMLTextAreaElement = san;
  const subjectInput: HTMLInputElement = subject;
  const validityInput: HTMLInputElement = validity;
  const parseArea: HTMLTextAreaElement = parseInput;
  const outputArea: HTMLTextAreaElement = output;
  const warningsPanel: HTMLElement = warnings;
  const errorBox: HTMLElement = errorEl;

  let lastDownloadName: string | null = null;

  function labelled(box: HTMLElement, title: string, text: string) {
    box.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = `${title}:`;
    box.append(strong, ` ${text}`);
    box.hidden = false;
  }

  function setWarnings(list: string[]) {
    if (!list || list.length === 0) {
      warningsPanel.hidden = true;
      warningsPanel.textContent = "";
      return;
    }
    labelled(warningsPanel, strings.warningsTitle, list.join("; "));
  }

  function setError(message: string) {
    labelled(errorBox, strings.error, message);
  }

  function clearMessages() {
    setWarnings([]);
    errorBox.hidden = true;
    errorBox.textContent = "";
    for (const el of [subjectInput, validityInput, sanArea, parseArea]) el.removeAttribute("aria-invalid");
  }

  function setOutput(text: string, downloadName: string | null) {
    outputArea.value = text;
    lastDownloadName = downloadName;
    if (copyBtn) copyBtn.disabled = !text;
    if (downloadBtn) downloadBtn.disabled = !text;
    if (outputPanel) syncEmptyState(outputPanel, !text);
  }

  /** Map WASM generation errors to localized text (raw detail kept after a dash). */
  function generationError(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    setOutput("", null); // no stale certificate behind a generation error
    if (message.startsWith("invalid subject")) {
      subjectInput.setAttribute("aria-invalid", "true");
      setError(`${strings.errorInvalidSubject} — ${message.replace(/^invalid subject:\s*/, "")}`);
    } else if (message.startsWith("invalid san")) {
      sanArea.setAttribute("aria-invalid", "true");
      setError(fillSanError(message.replace(/^invalid san:\s*/, "")));
    } else if (message.startsWith("invalid validity")) {
      validityInput.setAttribute("aria-invalid", "true");
      setError(strings.errorValidityDays);
    } else {
      setError(message);
    }
  }

  function fillSanError(entries: string): string {
    return strings.errorInvalidSan.replace("{entries}", () => entries);
  }

  /** Validated SAN list, or null after showing a localized error for rejected entries. */
  function readSans(): SanList | null {
    const sans = parseSanList(sanArea.value);
    if (sans.invalid.length > 0) {
      setOutput("", null); // invalid SANs: drop the previous result, disable Copy/Download
      sanArea.setAttribute("aria-invalid", "true");
      setError(fillSanError(sans.invalid.join(", ")));
      sanArea.focus();
      return null;
    }
    return sans;
  }

  /** Non-blocking hint: without SANs, browsers/TLS clients reject the name. */
  function warnIfNoSans(sans: SanList) {
    if (sans.dns.length + sans.ip.length + sans.email.length === 0) setWarnings([strings.warningNoSan]);
  }

  function selectedAlgorithm(): number {
    const value = Number(algorithm?.value);
    return Object.values(X509_ALG).includes(value as 1 | 2 | 3) ? value : X509_ALG.ed25519;
  }

  /** Thrown by `guard` when a newer Generate / Parse run superseded this one. */
  const STALE = Symbol("stale-x509-run");
  /** Id of the latest Generate / Parse run; only that run may write output, errors or warnings. */
  let latestRun = 0;
  const actionButtons = [generateSelfSignedBtn, generateCsrBtn, parseBtn].filter((b): b is HTMLButtonElement => !!b);

  /**
   * Latest-request gate + busy state for Generate / Parse (they share the output).
   * The action gets `guard(promise)`: it rejects with STALE once a newer run has
   * started, so an in-flight result can never overwrite a newer error or result.
   * All action buttons are disabled (and the clicked one `aria-busy`) meanwhile.
   */
  async function withBusy(
    btn: HTMLButtonElement | null,
    action: (guard: <T>(p: Promise<T>) => Promise<T>) => Promise<void>,
  ) {
    const run = ++latestRun;
    const live = () => run === latestRun;
    const guard = <T,>(p: Promise<T>): Promise<T> =>
      p.then(
        (v) => {
          if (!live()) throw STALE;
          return v;
        },
        (e: unknown) => {
          throw live() ? e : STALE;
        },
      );
    clearMessages();
    btn?.setAttribute("aria-busy", "true");
    for (const b of actionButtons) b.disabled = true;
    try {
      await withPreparing("cryptography", action(guard), {
        host: btn?.closest<HTMLElement>(".ds-action-row") ?? outputPanel,
        label: strings.preparing,
      });
      // Explicit Generate / Parse: bring a fresh result into view on phones.
      if (live() && outputArea.value) revealOutput(outputPanel);
    } catch (e) {
      if (e !== STALE) throw e;
    } finally {
      btn?.removeAttribute("aria-busy");
      if (live()) for (const b of actionButtons) b.disabled = false;
    }
  }

  generateSelfSignedBtn?.addEventListener("click", () =>
    void withBusy(generateSelfSignedBtn, async (guard) => {
      const days = parseValidityDays(validityInput.value);
      if (days === null) {
        setOutput("", null); // invalid validity: drop the previous result, disable Copy/Download
        validityInput.setAttribute("aria-invalid", "true");
        setError(strings.errorValidityDays);
        validityInput.focus();
        return;
      }
      const sans = readSans();
      if (!sans) return;
      const operation = startToolOperation("x509");
      try {
        const { certificate, privateKey } = await guard(
          x509SelfSignedEx(selectedAlgorithm(), subjectInput.value, days, sans.dns, sans.ip, sans.email),
        );
        setOutput(`${certificate}\n${privateKey}`.trim(), "certificate.pem");
        warnIfNoSans(sans);
        operation.complete();
      } catch (e) {
        if (e === STALE) return;
        operation.fail();
        generationError(e);
      }
    }),
  );

  generateCsrBtn?.addEventListener("click", () =>
    void withBusy(generateCsrBtn, async (guard) => {
      const sans = readSans();
      if (!sans) return;
      const operation = startToolOperation("x509");
      try {
        const { csr, privateKey } = await guard(x509CsrEx(selectedAlgorithm(), subjectInput.value, sans.dns, sans.ip, sans.email));
        setOutput(`${csr}\n${privateKey}`.trim(), "request.csr.pem");
        warnIfNoSans(sans);
        operation.complete();
      } catch (e) {
        if (e === STALE) return;
        operation.fail();
        generationError(e);
      }
    }),
  );

  parseBtn?.addEventListener("click", () =>
    void withBusy(parseBtn, async (guard) => {
      const input = parseArea.value.trim();
      if (!input) return;
      const operation = startToolOperation("x509");
      let signatureFailed = false;
      /** CSR summary + a warning when its self-signature does not verify. */
      const showCsr = (json: string) => {
        setOutput(prettyJson(json), "csr.json");
        try {
          if (JSON.parse(json).signatureValid === false) {
            signatureFailed = true;
            setWarnings([strings.warningCsrSignature]);
          }
        } catch {
          /* summary is always JSON; ignore */
        }
      };
      try {
        if (isCsrPem(input)) {
          showCsr(await guard(x509ParseCsr(input)));
        } else if (input.includes("BEGIN")) {
          setOutput(prettyJson(await guard(x509Parse(input))), "x509.json");
          setWarnings(await guard(x509Warnings(input)));
        } else {
          const hexDer = bytesToHex(base64ToBytes(input));
          let certJson: string | null = null;
          try {
            certJson = await guard(x509Parse(hexDer));
          } catch (e) {
            if (e === STALE) throw e;
            // Not a certificate: Base64 DER may be a CSR.
            showCsr(await guard(x509ParseCsr(hexDer)));
          }
          if (certJson !== null) {
            setOutput(prettyJson(certJson), "x509.json");
            try {
              setWarnings(await guard(x509Warnings(derBase64ToPem(input))));
            } catch {
              /* warnings are best-effort for DER input */
            }
          }
        }
        if (signatureFailed) operation.fail();
        else operation.complete();
      } catch (e) {
        if (e === STALE) return;
        operation.fail();
        // Malformed PEM/Base64/DER: one localized message instead of raw parser codes.
        // Drop the previous result too, so Copy/Download can't export a stale certificate.
        setOutput("", null);
        parseArea.setAttribute("aria-invalid", "true");
        setError(strings.invalidFormat);
      }
    }),
  );

  copyBtn?.addEventListener("click", () => {
    if (outputArea.value) void copyWithFeedback(copyBtn, outputArea.value, strings.copied, undefined, { failedLabel: strings.copyFailed });
  });

  if (parseHost) bindEmptyState(parseHost, parseArea);
  // "Load example": a freshly generated throwaway certificate (never a stored
  // key/cert) — Ed25519, CN=example.com, SAN example.com, 365 days.
  if (exampleBtn) {
    bindLoadExample(exampleBtn, async () => {
      try {
        const { certificate } = await x509SelfSignedEx(
          X509_ALG.ed25519,
          "CN=example.com,O=Example",
          365,
          ["example.com", "www.example.com"],
          [],
          [],
        );
        setFieldValue(parseArea, certificate.trim());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  downloadBtn?.addEventListener("click", () => {
    if (!outputArea.value) return;
    const blob = new Blob([outputArea.value], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = lastDownloadName || "x509.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  subjectInput.addEventListener("input", () => subjectInput.removeAttribute("aria-invalid"));
  validityInput.addEventListener("input", () => validityInput.removeAttribute("aria-invalid"));
  sanArea.addEventListener("input", () => sanArea.removeAttribute("aria-invalid"));
  parseArea.addEventListener("input", () => parseArea.removeAttribute("aria-invalid"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
