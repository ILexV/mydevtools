import type { LocalHttpRequest, LocalHttpResponse } from "../scripts/local-agent.ts";
import type { HttpProxySettings, HttpSavedRequest } from "./http-workspace.ts";

/**
 * Transport settings of the HTTP client sent to the agent: certificate
 * verification and HTTP version per request, the workspace proxy, and the
 * timed phases (DNS, TCP, TLS, waiting, download) of the reply.
 */
export const HTTP_OPTIONS_FEATURE = "http.options";

export type ProxyError = "scheme" | "host" | "path";

/** `http://host:port` only: credentials go in their own fields, https proxies are not supported. */
export function proxyUrlError(value: string): ProxyError | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "host";
  }
  if (url.protocol !== "http:") return "scheme";
  if (!url.hostname || url.username || url.password) return "host";
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return "path";
  return null;
}

/** Bypass patterns from the comma or space separated field, lowercased. */
export function proxyBypass(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/u).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

/** The proxy for the agent, or none while it is off, empty or invalid. */
export function agentProxy(settings: HttpProxySettings | undefined): LocalHttpRequest["proxy"] {
  if (!settings?.enabled || !settings.url.trim() || proxyUrlError(settings.url)) return undefined;
  const bypass = proxyBypass(settings.bypass);
  return {
    url: settings.url.trim(),
    ...(settings.username || settings.password ? { username: settings.username, password: settings.password } : {}),
    ...(bypass.length ? { bypass } : {}),
  };
}

/** Only fields that differ from the agent defaults, so older agents still take default requests. */
export function transportFields(
  request: Pick<HttpSavedRequest, "verifyTls" | "httpVersion">, proxy: HttpProxySettings | undefined,
): Pick<LocalHttpRequest, "verifyTls" | "httpVersion" | "proxy"> {
  const agent = agentProxy(proxy);
  return {
    ...(request.verifyTls === false ? { verifyTls: false } : {}),
    ...(request.httpVersion && request.httpVersion !== "auto" ? { httpVersion: request.httpVersion } : {}),
    ...(agent ? { proxy: agent } : {}),
  };
}

export type TimingPhase = "dns" | "connect" | "tls" | "firstByte" | "download" | "other";

/**
 * Phases in order with their share of the total. `other` is what the phases do
 * not cover: earlier redirect hops and the agent's own work.
 */
export function timingPhases(response: LocalHttpResponse): { phase: TimingPhase; ms: number }[] | null {
  const timings = response.timings;
  if (!timings) return null;
  const phases: { phase: TimingPhase; ms: number }[] = [
    { phase: "dns", ms: timings.dnsMs },
    { phase: "connect", ms: timings.connectMs },
    ...(timings.tlsMs === null ? [] : [{ phase: "tls" as const, ms: timings.tlsMs }]),
    { phase: "firstByte", ms: timings.firstByteMs },
    { phase: "download", ms: timings.downloadMs },
  ];
  const covered = phases.reduce((sum, entry) => sum + entry.ms, 0);
  const other = Math.max(0, response.elapsedMs - covered);
  if (other >= 0.5) phases.push({ phase: "other", ms: other });
  return phases;
}

/** `12.3 ms` under 100 ms, whole milliseconds above. */
export function formatPhaseMs(ms: number): string {
  return ms < 100 ? `${(Math.round(ms * 10) / 10).toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export const HTTP_CLIENT_CERTIFICATES_FEATURE = "http.client_certificates";

/** The agent's host rule: the exact host, or `*.domain` for its subdomains only. */
export function hostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith("*.")) return pattern === host;
  const domain = pattern.slice(2);
  return host.length > domain.length + 1 && host.endsWith(`.${domain}`);
}

/** The first certificate (by name) whose hosts cover the URL, as Postman picks one per host. */
export function certificateFor(url: string, certificates: readonly { name: string; hosts: readonly string[] }[]): string | undefined {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    host = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return [...certificates].sort((left, right) => left.name.localeCompare(right.name))
    .find((certificate) => certificate.hosts.some((pattern) => hostMatches(pattern, host)))?.name;
}
