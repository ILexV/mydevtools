/**
 * X.509 client controller. Generate self-signed certs / CSRs and parse PEM or
 * Base64-DER input via the main-thread `crypto-client` WASM helpers.
 * Legacy parity: algorithm fixed to ecdsa-p256 (1), no SAN inputs, pretty-JSON
 * output, warnings panel doubles as error panel, 1200ms copy label swap,
 * download names certificate.pem / request.csr.pem / x509.json.
 */
import { x509Parse, x509Warnings, x509SelfSigned, x509Csr, bytesToHex } from "@/scripts/wasm/crypto-client";

interface Strings {
  copy: string;
  copied: string;
  download: string;
  warningsTitle: string;
  invalidFormat: string;
}

const ECDSA_P256 = 1;

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-x509-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prettyJson(jsonText: string): string {
  try {
    return JSON.stringify(JSON.parse(jsonText), null, 2);
  } catch {
    return jsonText;
  }
}

function base64ToBytes(text: string): Uint8Array {
  const normalized = text.replace(/\s+/g, "");
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Wrap Base64-DER into PEM armor so the PEM warnings helper can read it. */
function derBase64ToPem(base64: string): string {
  const normalized = base64.replace(/\s+/g, "");
  const lines: string[] = [];
  for (let i = 0; i < normalized.length; i += 64) {
    lines.push(normalized.slice(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-x509-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const subject = root.querySelector<HTMLInputElement>("[data-x509-subject]");
  const generateSelfSignedBtn = root.querySelector<HTMLButtonElement>("[data-x509-generate-selfsigned]");
  const generateCsrBtn = root.querySelector<HTMLButtonElement>("[data-x509-generate-csr]");
  const parseInput = root.querySelector<HTMLTextAreaElement>("[data-x509-parse-input]");
  const parseBtn = root.querySelector<HTMLButtonElement>("[data-x509-parse]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-x509-output]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-x509-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-x509-download]");
  const warnings = root.querySelector<HTMLElement>("[data-x509-warnings]");
  const warningsText = root.querySelector<HTMLElement>("[data-x509-warnings-text]");

  if (!subject || !parseInput || !output || !warnings || !warningsText) return;
  const subjectInput: HTMLInputElement = subject;
  const parseArea: HTMLTextAreaElement = parseInput;
  const outputArea: HTMLTextAreaElement = output;
  const warningsPanel: HTMLElement = warnings;
  const warningsLabel: HTMLElement = warningsText;

  let lastDownloadName: string | null = null;

  function setWarnings(list: string[]) {
    if (!list || list.length === 0) {
      warningsPanel.hidden = true;
      warningsLabel.textContent = "";
      return;
    }
    warningsPanel.hidden = false;
    warningsLabel.innerHTML = `<strong>${escapeHtml(strings.warningsTitle)}:</strong> ${list.map(escapeHtml).join("; ")}`;
  }

  function setError(message: string) {
    warningsPanel.hidden = false;
    warningsLabel.innerHTML = `<strong>Error:</strong> ${escapeHtml(message)}`;
  }

  generateSelfSignedBtn?.addEventListener("click", async () => {
    setWarnings([]);
    try {
      const { certificate, privateKey } = await x509SelfSigned(ECDSA_P256, subjectInput.value.trim(), [], []);
      outputArea.value = `${certificate}\n${privateKey}`.trim();
      lastDownloadName = "certificate.pem";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  generateCsrBtn?.addEventListener("click", async () => {
    setWarnings([]);
    try {
      const { csr, privateKey } = await x509Csr(ECDSA_P256, subjectInput.value.trim(), [], []);
      outputArea.value = `${csr}\n${privateKey}`.trim();
      lastDownloadName = "request.csr.pem";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  parseBtn?.addEventListener("click", async () => {
    setWarnings([]);
    try {
      const input = parseArea.value.trim();
      if (!input) return;

      if (input.includes("BEGIN")) {
        outputArea.value = prettyJson(await x509Parse(input));
        setWarnings(await x509Warnings(input));
      } else {
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(input);
        } catch {
          throw new Error(strings.invalidFormat);
        }
        outputArea.value = prettyJson(await x509Parse(bytesToHex(bytes)));
        try {
          setWarnings(await x509Warnings(derBase64ToPem(input)));
        } catch {
          /* warnings are best-effort for DER input */
        }
      }
      lastDownloadName = "x509.json";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(outputArea.value || "");
      if (copyBtn) {
        const orig = copyBtn.textContent;
        copyBtn.textContent = strings.copied;
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      }
    } catch {
      /* clipboard unavailable */
    }
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
    URL.revokeObjectURL(url);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
