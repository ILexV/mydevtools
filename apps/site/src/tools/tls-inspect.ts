/**
 * TLS inspect settings and the text report. The timeout is a setting.
 * The host, the port and the certificate chain are not stored.
 */
import type { TlsInspectResult } from "@/scripts/local-agent";

export const TLS_INSPECT_STORAGE_KEY = "mdt.tls-inspect.v1";
export const TLS_TIMEOUT_MIN = 200;
export const TLS_TIMEOUT_MAX = 10_000;
export const TLS_TIMEOUT_DEFAULT = 5_000;

export interface TlsInspectSettings {
  v: 1;
  timeoutMs: number;
}

export function defaultTlsInspectSettings(): TlsInspectSettings {
  return { v: 1, timeoutMs: TLS_TIMEOUT_DEFAULT };
}

/** Keeps a timeout inside 200..=10000 ms. A saved host, port or chain is dropped. */
export function parseTlsInspectSettings(value: unknown): TlsInspectSettings {
  if (!value || typeof value !== "object") return defaultTlsInspectSettings();
  const timeoutMs = (value as { timeoutMs?: unknown }).timeoutMs;
  if (!isTlsTimeout(timeoutMs)) return defaultTlsInspectSettings();
  return { v: 1, timeoutMs };
}

export function isTlsTimeout(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= TLS_TIMEOUT_MIN
    && value <= TLS_TIMEOUT_MAX;
}

/** Plain text of one handshake: the summary line, then one line per certificate. */
export function formatTlsText(result: TlsInspectResult): string {
  const summary = [
    result.host,
    result.port,
    result.status,
    result.address,
    result.elapsedMs,
    result.protocol ?? "",
    result.cipher ?? "",
    result.trusted === null ? "" : String(result.trusted),
  ].join(" ");
  const chain = result.certificates.map((certificate) =>
    [certificate.subject, certificate.issuer, certificate.notBefore ?? "", certificate.notAfter ?? "", certificate.sha256].join("\t"),
  );
  return [summary, ...chain].join("\n");
}
