/**
 * X.509 client controller. Generate self-signed certs / CSRs and parse PEM or
 * Base64-DER certificates and PKCS#10 CSRs (subject, key, SANs, extensions,
 * self-signature check) via the main-thread `crypto-client` WASM helpers.
 * Legacy parity: Ed25519 by default (legacy passed algorithm id 1 = Ed25519),
 * no SAN inputs, pretty-JSON output, copy/download, download names
 * certificate.pem / request.csr.pem / x509.json.
 * Fixes vs. legacy: the subject accepts a full DN (`CN=…,O=…,C=…`) instead of
 * stuffing the whole string into the CN; "Validity (days)" is honoured
 * (legacy certs were valid 1975–4096); errors are localized and kept apart
 * from certificate warnings.
 */
import {
  x509Parse,
  x509ParseCsr,
  x509Warnings,
  x509SelfSignedEx,
  x509CsrEx,
  bytesToHex,
  X509_ALG,
} from "@/scripts/wasm/crypto-client";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { base64ToBytes, derBase64ToPem, isCsrPem, parseValidityDays, prettyJson } from "@/tools/x509-helpers";

interface Strings {
  copy: string;
  copied: string;
  download: string;
  warningsTitle: string;
  invalidFormat: string;
  errorValidityDays: string;
  errorInvalidSubject: string;
  error: string;
  warningCsrSignature: string;
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
  const generateSelfSignedBtn = root.querySelector<HTMLButtonElement>("[data-x509-generate-selfsigned]");
  const generateCsrBtn = root.querySelector<HTMLButtonElement>("[data-x509-generate-csr]");
  const parseInput = root.querySelector<HTMLTextAreaElement>("[data-x509-parse-input]");
  const parseBtn = root.querySelector<HTMLButtonElement>("[data-x509-parse]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-x509-output]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-x509-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-x509-download]");
  const warnings = root.querySelector<HTMLElement>("[data-x509-warnings]");
  const errorEl = root.querySelector<HTMLElement>("[data-x509-error]");

  if (!subject || !validity || !parseInput || !output || !warnings || !errorEl) return;
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
    for (const el of [subjectInput, validityInput, parseArea]) el.removeAttribute("aria-invalid");
  }

  function setOutput(text: string, downloadName: string | null) {
    outputArea.value = text;
    lastDownloadName = downloadName;
    if (copyBtn) copyBtn.disabled = !text;
    if (downloadBtn) downloadBtn.disabled = !text;
  }

  /** Map WASM generation errors to localized text (raw detail kept after a dash). */
  function generationError(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("invalid subject")) {
      subjectInput.setAttribute("aria-invalid", "true");
      setError(`${strings.errorInvalidSubject} — ${message.replace(/^invalid subject:\s*/, "")}`);
    } else if (message.startsWith("invalid validity")) {
      validityInput.setAttribute("aria-invalid", "true");
      setError(strings.errorValidityDays);
    } else {
      setError(message);
    }
  }

  function selectedAlgorithm(): number {
    const value = Number(algorithm?.value);
    return Object.values(X509_ALG).includes(value as 1 | 2 | 3) ? value : X509_ALG.ed25519;
  }

  async function withBusy(btn: HTMLButtonElement | null, action: () => Promise<void>) {
    clearMessages();
    btn?.setAttribute("aria-busy", "true");
    try {
      await action();
    } finally {
      btn?.removeAttribute("aria-busy");
    }
  }

  generateSelfSignedBtn?.addEventListener("click", () =>
    void withBusy(generateSelfSignedBtn, async () => {
      const days = parseValidityDays(validityInput.value);
      if (days === null) {
        validityInput.setAttribute("aria-invalid", "true");
        setError(strings.errorValidityDays);
        validityInput.focus();
        return;
      }
      try {
        const { certificate, privateKey } = await x509SelfSignedEx(selectedAlgorithm(), subjectInput.value, days);
        setOutput(`${certificate}\n${privateKey}`.trim(), "certificate.pem");
      } catch (e) {
        generationError(e);
      }
    }),
  );

  generateCsrBtn?.addEventListener("click", () =>
    void withBusy(generateCsrBtn, async () => {
      try {
        const { csr, privateKey } = await x509CsrEx(selectedAlgorithm(), subjectInput.value);
        setOutput(`${csr}\n${privateKey}`.trim(), "request.csr.pem");
      } catch (e) {
        generationError(e);
      }
    }),
  );

  parseBtn?.addEventListener("click", () =>
    void withBusy(parseBtn, async () => {
      const input = parseArea.value.trim();
      if (!input) return;
      /** CSR summary + a warning when its self-signature does not verify. */
      const showCsr = (json: string) => {
        setOutput(prettyJson(json), "csr.json");
        try {
          if (JSON.parse(json).signatureValid === false) setWarnings([strings.warningCsrSignature]);
        } catch {
          /* summary is always JSON; ignore */
        }
      };
      try {
        if (isCsrPem(input)) {
          showCsr(await x509ParseCsr(input));
        } else if (input.includes("BEGIN")) {
          setOutput(prettyJson(await x509Parse(input)), "x509.json");
          setWarnings(await x509Warnings(input));
        } else {
          const hexDer = bytesToHex(base64ToBytes(input));
          let certJson: string | null = null;
          try {
            certJson = await x509Parse(hexDer);
          } catch {
            // Not a certificate: Base64 DER may be a CSR.
            showCsr(await x509ParseCsr(hexDer));
          }
          if (certJson !== null) {
            setOutput(prettyJson(certJson), "x509.json");
            try {
              setWarnings(await x509Warnings(derBase64ToPem(input)));
            } catch {
              /* warnings are best-effort for DER input */
            }
          }
        }
      } catch {
        // Malformed PEM/Base64/DER: one localized message instead of raw parser codes.
        parseArea.setAttribute("aria-invalid", "true");
        setError(strings.invalidFormat);
      }
    }),
  );

  copyBtn?.addEventListener("click", () => {
    if (outputArea.value) void copyWithFeedback(copyBtn, outputArea.value, strings.copied);
  });

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
  parseArea.addEventListener("input", () => parseArea.removeAttribute("aria-invalid"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
