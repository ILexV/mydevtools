/**
 * X.509 tool helpers (pure, unit-tested in test/crypto-tools.test.ts):
 * Base64-DER ↔ PEM armor for parsing pasted certificates, CSR detection,
 * pretty-printing
 * the WASM JSON summary, validating the "Validity (days)" field
 * (whole days 1–36500, mirrors X509_MAX_VALIDITY_DAYS in wasm/cryptography)
 * and parsing the Subject Alternative Name list (parseSanList).
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

/** Subject Alternative Names split by type for the WASM generator; `invalid` holds rejected entries verbatim. */
export interface SanList {
  dns: string[];
  ip: string[];
  email: string[];
  invalid: string[];
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;

/** Strict dotted-quad IPv4 (no leading zeros, octets 0–255). */
function isIpv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/** IPv6 → normalized compressed form via the WHATWG URL parser, or null (zone ids rejected). */
function normalizeIpv6(text: string): string | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text) || !text.includes(":")) return null;
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * Hostname → lower-case A-label form (IDN → punycode) if it is a valid DNS name
 * for a certificate: LDH labels of 1–63 chars, ≤ 253 total, optional leading
 * `*.` wildcard (not on a bare TLD), no all-numeric last label. Else null.
 */
function normalizeDnsName(text: string, allowWildcard: boolean): string | null {
  let name = text.replace(/\.$/, "");
  const wildcard = allowWildcard && name.startsWith("*.");
  if (wildcard) name = name.slice(2);
  if (!name) return null;
  if (/[^\x00-\x7f]/.test(name)) {
    try {
      name = new URL(`http://${name}/`).hostname;
    } catch {
      return null;
    }
  }
  name = name.toLowerCase();
  const labels = name.split(".");
  if (name.length > 253 || !labels.every((l) => DNS_LABEL.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  if (wildcard && labels.length < 2) return null;
  return wildcard ? `*.${name}` : name;
}

/**
 * Parse the SAN field: entries separated by new lines, commas, semicolons or
 * spaces. Each entry is an IPv4/IPv6 address, an e-mail address (contains
 * `@`) or a DNS name (`*.` wildcard allowed); an optional `DNS:` / `IP:` /
 * `email:` prefix (as printed by the parser and OpenSSL) forces the type.
 * Duplicates are dropped; rejected entries are returned in `invalid`.
 */
export function parseSanList(text: string): SanList {
  const out: SanList = { dns: [], ip: [], email: [], invalid: [] };
  const seen = new Set<string>();
  const add = (list: string[], value: string) => {
    const key = `${list === out.ip ? "ip" : list === out.email ? "email" : "dns"}:${value.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      list.push(value);
    }
  };
  for (const raw of text.split(/[\s,;]+/)) {
    if (!raw) continue;
    const prefixed = /^(dns|ip|email|rfc822):(.*)$/i.exec(raw);
    const type = prefixed ? prefixed[1].toLowerCase() : null;
    const value = prefixed ? prefixed[2] : raw;
    if (type === "ip" || (!type && (isIpv4(value) || /^[\d.]+$/.test(value) || value.includes(":")))) {
      const v6 = normalizeIpv6(value);
      if (isIpv4(value)) add(out.ip, value);
      else if (v6 !== null) add(out.ip, v6);
      else out.invalid.push(raw);
    } else if (type === "email" || type === "rfc822" || (!type && value.includes("@"))) {
      const at = value.lastIndexOf("@");
      const domain = at > 0 ? normalizeDnsName(value.slice(at + 1), false) : null;
      const local = value.slice(0, at);
      if (domain !== null && EMAIL_LOCAL.test(local) && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")) {
        add(out.email, `${local}@${domain}`);
      } else out.invalid.push(raw);
    } else {
      const dns = normalizeDnsName(value, true);
      if (dns !== null) add(out.dns, dns);
      else out.invalid.push(raw);
    }
  }
  return out;
}
