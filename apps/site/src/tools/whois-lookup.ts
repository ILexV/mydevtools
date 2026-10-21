/**
 * WHOIS lookup settings and the text report. The timeout is a setting.
 * The query, the server and the reply are not stored.
 */
import type { WhoisLookupResult } from "@/scripts/local-agent";

export const WHOIS_LOOKUP_STORAGE_KEY = "mdt.whois-lookup.v1";
export const WHOIS_TIMEOUT_MIN = 200;
export const WHOIS_TIMEOUT_MAX = 10_000;
export const WHOIS_TIMEOUT_DEFAULT = 5_000;

export interface WhoisLookupSettings {
  v: 1;
  timeoutMs: number;
}

export function defaultWhoisLookupSettings(): WhoisLookupSettings {
  return { v: 1, timeoutMs: WHOIS_TIMEOUT_DEFAULT };
}

/** Keeps a timeout inside 200..=10000 ms. A saved query, server or reply is dropped. */
export function parseWhoisLookupSettings(value: unknown): WhoisLookupSettings {
  if (!value || typeof value !== "object") return defaultWhoisLookupSettings();
  const timeoutMs = (value as { timeoutMs?: unknown }).timeoutMs;
  if (!isWhoisTimeout(timeoutMs)) return defaultWhoisLookupSettings();
  return { v: 1, timeoutMs };
}

export function isWhoisTimeout(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= WHOIS_TIMEOUT_MIN
    && value <= WHOIS_TIMEOUT_MAX;
}

/** One plain-text result: the query line, then the WHOIS reply when there is one. */
export function formatWhoisText(result: WhoisLookupResult): string {
  const head = `${result.query} ${result.server} ${result.port} ${result.status} ${result.address} ${result.elapsedMs} ${result.truncated}`;
  return result.text ? `${head}\n${result.text}` : head;
}

const REFERRAL_LINE = /^\s*(?:refer|whois|registrar whois server|referralserver)\s*:\s*(\S+)\s*$/im;

/**
 * Next WHOIS server named inside a reply (`refer:` at IANA, `Registrar WHOIS Server:`
 * at registries, `ReferralServer: whois://…` at RIRs; rwhois and other ports are not port 43). Offered as a one-click follow-up;
 * the agent never opens that second connection on its own. Null when absent or the same server.
 */
export function whoisReferral(text: string, currentServer: string): string | null {
  const match = REFERRAL_LINE.exec(text);
  if (!match) return null;
  const host = match[1].replace(/^whois:\/\//i, "").replace(/\/+$/, "").replace(/:43$/, "").toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (host === currentServer.trim().toLowerCase()) return null;
  return host;
}
