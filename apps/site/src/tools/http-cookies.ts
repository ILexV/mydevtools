import type { LocalHttpCookie } from "../scripts/local-agent.ts";
import { RevisionedVaultDocument, type VaultDocumentClient } from "./http-vault-document.ts";

/**
 * Cookie jar of the HTTP client (Postman's Cookies). The page owns the jar and
 * sends it with each request; the agent picks cookies per hop by domain, path
 * and Secure (RFC 6265) and returns the `Set-Cookie` changes. The jar lives in
 * page memory; «Keep cookies» (off by default) stores it where the workspace lives.
 */
export const HTTP_COOKIES_FEATURE = "http.cookies";
export const HTTP_COOKIES_DOCUMENT = "http-cookies";
export const HTTP_COOKIES_STORAGE_KEY = "mdt.http-cookies.v1";
export const HTTP_COOKIES_PERSIST_KEY = "mdt.http-cookies.persist.v1";
/** The agent's limits: count, name plus value, and the whole jar. */
export const MAX_COOKIES = 300;
export const MAX_COOKIE_BYTES = 4096;
export const MAX_JAR_BYTES = 256 * 1024;

export type HttpCookie = LocalHttpCookie;

export type CookieError = "name" | "value" | "domain" | "path" | "size";

const NAME_SEPARATORS = new Set([..."()<>@,;:\\\"/[]?={}"]);
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).byteLength;
const cookieBytes = (cookie: HttpCookie): number => bytes(cookie.name) + bytes(cookie.value) + bytes(cookie.domain) + bytes(cookie.path);

/** What the agent would refuse, so the dialog says it before sending. */
export function cookieError(cookie: HttpCookie): CookieError | null {
  if (!cookie.name || [...cookie.name].some((ch) => ch <= " " || ch > "~" || NAME_SEPARATORS.has(ch))) return "name";
  // The agent's rule: no control characters (C0, DEL, C1) and no `;`.
  const unsafe = /[\u0000-\u001f\u007f-\u009f;]/u;
  if (unsafe.test(cookie.value)) return "value";
  if (!cookie.domain || cookie.domain.length > 253 || cookie.domain !== cookie.domain.toLowerCase()
    || cookie.domain.startsWith(".") || /[\s/;[\]]/u.test(cookie.domain)) return "domain";
  if (!cookie.path.startsWith("/") || bytes(cookie.path) > 1024 || unsafe.test(cookie.path)) return "path";
  if (bytes(cookie.name) + bytes(cookie.value) > MAX_COOKIE_BYTES) return "size";
  return null;
}

/** Domain as typed: lowercase, no leading dot, no scheme or port. */
export function normalizeCookieDomain(text: string): string {
  let domain = text.trim().toLowerCase();
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//u.test(domain)) domain = new URL(domain).hostname;
  } catch {
    // Left as typed; cookieError reports it.
  }
  // An IPv6 address is kept whole (the agent stores it without brackets); a single colon is a port.
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/u.exec(domain);
  if (bracketed) return bracketed[1]!;
  if (domain.split(":").length === 2) domain = domain.replace(/:\d+$/u, "");
  return domain.replace(/^\.+/u, "");
}

export const sameCookie = (left: HttpCookie, right: HttpCookie): boolean =>
  left.name === right.name && left.domain === right.domain && left.path === right.path;

export const cookieExpired = (cookie: HttpCookie, now: number): boolean => cookie.expires !== undefined && cookie.expires <= now;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Only the fields that differ from the defaults, the shape the agent and storage take. */
export function compactCookie(cookie: HttpCookie): HttpCookie {
  return {
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    ...(cookie.hostOnly ? { hostOnly: true } : {}),
    ...(cookie.secure ? { secure: true } : {}),
    ...(cookie.httpOnly ? { httpOnly: true } : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
  };
}

export function parseCookies(input: unknown): HttpCookie[] | null {
  const list = typeof input === "object" && input !== null && (input as { v?: unknown }).v === 1
    ? (input as { cookies?: unknown }).cookies : undefined;
  if (!Array.isArray(list) || list.length > MAX_COOKIES) return null;
  const cookies: HttpCookie[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return null;
    const value = entry as Record<string, unknown>;
    if (typeof value.name !== "string" || typeof value.value !== "string" || typeof value.domain !== "string" || typeof value.path !== "string") return null;
    for (const flag of ["hostOnly", "secure", "httpOnly"] as const) if (flag in value && typeof value[flag] !== "boolean") return null;
    if ("sameSite" in value && !["Strict", "Lax", "None"].includes(value.sameSite as string)) return null;
    if ("expires" in value && !Number.isSafeInteger(value.expires)) return null;
    const cookie = compactCookie(value as unknown as HttpCookie);
    if (cookieError(cookie)) return null;
    cookies.push(cookie);
  }
  return cookies;
}

/**
 * Upserts a change, deletes it when its expiry passed (the agent reports a
 * deletion that way) and keeps the agent's limits by dropping the oldest.
 */
export function applyCookieChanges(jar: readonly HttpCookie[], changes: readonly HttpCookie[], now: number): HttpCookie[] {
  let next = jar.filter((cookie) => !cookieExpired(cookie, now));
  for (const change of changes) {
    const index = next.findIndex((cookie) => sameCookie(cookie, change));
    if (cookieExpired(change, now)) {
      if (index >= 0) next.splice(index, 1);
      continue;
    }
    if (cookieError(change)) continue;
    if (index >= 0) next[index] = compactCookie(change);
    else next.push(compactCookie(change));
  }
  let total = next.reduce((sum, cookie) => sum + cookieBytes(cookie), 0);
  while (next.length > MAX_COOKIES || total > MAX_JAR_BYTES) {
    total -= cookieBytes(next[0]!);
    next = next.slice(1);
  }
  return next;
}

export const removeCookie = (jar: readonly HttpCookie[], target: HttpCookie): HttpCookie[] =>
  jar.filter((cookie) => !sameCookie(cookie, target));

export const removeCookieDomain = (jar: readonly HttpCookie[], domain: string): HttpCookie[] =>
  jar.filter((cookie) => cookie.domain !== domain);

/** Saves an edit; a changed name, domain or path replaces the edited cookie. */
export function saveCookie(jar: readonly HttpCookie[], cookie: HttpCookie, replacing: HttpCookie | null, now: number): HttpCookie[] {
  const base = replacing ? removeCookie(jar, replacing) : [...jar];
  return applyCookieChanges(base, [cookie], now);
}

/** Domains alphabetically with their cookies by path, then name. */
export function groupCookiesByDomain(jar: readonly HttpCookie[]): { domain: string; cookies: HttpCookie[] }[] {
  const groups = new Map<string, HttpCookie[]>();
  for (const cookie of jar) groups.set(cookie.domain, [...groups.get(cookie.domain) ?? [], cookie]);
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([domain, cookies]) => ({
    domain,
    cookies: cookies.sort((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name)),
  }));
}

/** Where kept cookies live: this browser, or the agent vault next to the workspace. */
export interface CookieStore {
  load(): Promise<HttpCookie[]>;
  update(change: (jar: HttpCookie[]) => HttpCookie[]): Promise<HttpCookie[]>;
  clear(): Promise<void>;
}

const serialize = (cookies: HttpCookie[]): unknown => ({ v: 1, cookies });

export class LocalCookieStore implements CookieStore {
  async load(): Promise<HttpCookie[]> {
    const raw = localStorage.getItem(HTTP_COOKIES_STORAGE_KEY);
    if (raw === null) return [];
    const cookies = parseCookies(JSON.parse(raw));
    if (!cookies) throw new Error("cookies_corrupt");
    return cookies;
  }

  async update(change: (jar: HttpCookie[]) => HttpCookie[]): Promise<HttpCookie[]> {
    const cookies = change(await this.load());
    if (cookies.length) localStorage.setItem(HTTP_COOKIES_STORAGE_KEY, JSON.stringify(serialize(cookies)));
    else localStorage.removeItem(HTTP_COOKIES_STORAGE_KEY);
    return cookies;
  }

  async clear(): Promise<void> {
    localStorage.removeItem(HTTP_COOKIES_STORAGE_KEY);
  }
}

export class AgentCookieStore implements CookieStore {
  #document: RevisionedVaultDocument<HttpCookie[]>;

  constructor(client: VaultDocumentClient) {
    this.#document = new RevisionedVaultDocument(client, HTTP_COOKIES_DOCUMENT, parseCookies, () => []);
  }

  load(): Promise<HttpCookie[]> {
    return this.#document.load();
  }

  update(change: (jar: HttpCookie[]) => HttpCookie[]): Promise<HttpCookie[]> {
    return this.#document.update(change, serialize);
  }

  clear(): Promise<void> {
    return this.#document.remove();
  }
}
