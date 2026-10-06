/**
 * X.509 tool helpers (pure, unit-tested in test/crypto-tools.test.ts):
 * Base64-DER ↔ PEM armor for parsing pasted certificates, CSR detection,
 * pretty-printing
 * the WASM JSON summary, and validating the "Validity (days)" field
 * (whole days 1–36500, mirrors X509_MAX_VALIDITY_DAYS in wasm/cryptography).
 */
export const X509_MAX_VALIDITY_DAYS = 36_500;

/** Strict Base64 (whitespace ignored) → bytes; throws on any other character. */
export function base64ToBytes(text: string): Uint8Array {
  const normalized = text.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("invalid base64");
  }
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Wrap Base64-DER into CERTIFICATE PEM armor (64-char lines). */
export function derBase64ToPem(base64: string): string {
  const normalized = base64.replace(/\s+/g, "");
  const lines: string[] = [];
  for (let i = 0; i < normalized.length; i += 64) lines.push(normalized.slice(i, i + 64));
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/** Indent JSON; non-JSON text is returned unchanged. */
export function prettyJson(jsonText: string): string {
  try {
    return JSON.stringify(JSON.parse(jsonText), null, 2);
  } catch {
    return jsonText;
  }
}

/** Parse the validity field: whole number of days in 1..36500, else null. */
export function parseValidityDays(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return days >= 1 && days <= X509_MAX_VALIDITY_DAYS ? days : null;
}

/** True for PEM armor of a PKCS#10 request (`CERTIFICATE REQUEST` / legacy `NEW CERTIFICATE REQUEST`). */
export function isCsrPem(text: string): boolean {
  return /-----BEGIN (NEW )?CERTIFICATE REQUEST-----/.test(text);
}
