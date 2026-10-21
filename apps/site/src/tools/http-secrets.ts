/**
 * Secrets window helpers: the same name, value and host rules the local agent
 * enforces for `{{secret:name}}`, checked on the page so mistakes get a
 * localized hint before the request. The agent's check stays authoritative.
 */

/** Same limits as `MAX_SECRET_HOSTS` and `MAX_SECRET_VALUE_BYTES` in the agent vault. */
export const MAX_SECRET_HOSTS = 16;
export const MAX_SECRET_VALUE_BYTES = 8 * 1024;

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOMAIN = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Placeholder text to put into a URL, header value or body. */
export function secretPlaceholder(name: string): string {
  return `{{secret:${name}}}`;
}

/** Non-empty, at most 8 KiB of UTF-8 and no control characters (a value must not break a header line). */
export function isSecretValue(value: string): boolean {
  return value.length > 0
    && new TextEncoder().encode(value).length <= MAX_SECRET_VALUE_BYTES
    && !/\p{Cc}/u.test(value);
}

/**
 * Parses the hosts field: comma, space or newline separated, lowercased and
 * deduplicated. Null when empty, over the limit, or an entry has a scheme,
 * port, path, userinfo, or a wildcard that is not `*.domain.tld`.
 */
export function parseSecretHosts(text: string): string[] | null {
  const hosts: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const host = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (!(IPV6.test(host) || (DOMAIN.test(host) && (!host.startsWith("*.") || host.slice(2).includes("."))))) {
      return null;
    }
    if (host.startsWith("*.") && /^[0-9.]+$/.test(host.slice(2))) return null;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts.length > 0 && hosts.length <= MAX_SECRET_HOSTS ? hosts : null;
}

/** Host of the open request's URL, offered as the default for a new secret. */
export function suggestedSecretHost(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : "";
  } catch {
    return "";
  }
}
