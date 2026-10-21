import { signAwsV4 } from "./http-aws-sigv4.ts";
import { encodeQueryComponent, hasSecretPlaceholder, resolveVariables, type VariableScope } from "./http-variables.ts";
import type { HttpAuth, HttpSavedRequest, HttpWorkspace } from "./http-workspace.ts";

/**
 * HTTP client request assembly: `{{var}}` substitution, folder-inherited Auth
 * (Basic, Bearer, API key, OAuth 2.0 client credentials, AWS SigV4) and the
 * default Content-Type. `{{secret:name}}` stays for the agent to substitute.
 */
export type ConcreteAuth = Exclude<HttpAuth, { type: "inherit" }>;

export type AuthSource = { kind: "request" } | { kind: "folder"; id: string } | { kind: "default" };

/** The auth a request actually uses: its own, else the nearest folder's, else none. */
export function effectiveAuth(
  workspace: HttpWorkspace, request: Pick<HttpSavedRequest, "auth" | "folderId">,
): { auth: ConcreteAuth; source: AuthSource } {
  if (request.auth && request.auth.type !== "inherit") return { auth: request.auth, source: { kind: "request" } };
  const seen = new Set<string>();
  let folderId = request.folderId;
  while (folderId !== null && !seen.has(folderId)) {
    seen.add(folderId);
    const folder = workspace.folders.find((entry) => entry.id === folderId);
    if (!folder) break;
    if (folder.auth && folder.auth.type !== "inherit") return { auth: folder.auth, source: { kind: "folder", id: folder.id } };
    folderId = folder.parentId;
  }
  return { auth: { type: "none" }, source: { kind: "default" } };
}

export type BuildErrorCode = "url" | "headers" | "auth_incomplete" | "aws_secret" | "oauth_token";

export class HttpBuildError extends Error {
  readonly code: BuildErrorCode;
  constructor(code: BuildErrorCode, message?: string) {
    super(message || code);
    this.code = code;
  }
}

export interface Header {
  name: string;
  value: string;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

/** `Authorization: Basic …` built here, or by the agent when a part is a `{{secret:…}}`. */
export function basicAuthorization(username: string, password: string): { header: Header } | { agent: BasicCredentials } {
  if (hasSecretPlaceholder(username) || hasSecretPlaceholder(password)) return { agent: { username, password } };
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { header: { name: "Authorization", value: `Basic ${btoa(binary)}` } };
}

export interface OAuthClientConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  clientAuth: "header" | "body";
}

export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  /** Epoch ms; null when the server gave no `expires_in`. */
  expiresAt: number | null;
}

/** OAuth 2.0 client credentials token request (RFC 6749 §4.4), form-encoded with placeholders kept. */
export function oauthTokenRequest(config: OAuthClientConfig): {
  url: string; headers: Header[]; body: string; basicAuth?: BasicCredentials;
} {
  const form: [string, string][] = [["grant_type", "client_credentials"]];
  if (config.scope.trim()) form.push(["scope", config.scope.trim()]);
  const headers: Header[] = [
    { name: "Content-Type", value: "application/x-www-form-urlencoded" },
    { name: "Accept", value: "application/json" },
  ];
  let basicAuth: BasicCredentials | undefined;
  if (config.clientAuth === "body") {
    form.push(["client_id", config.clientId], ["client_secret", config.clientSecret]);
  } else {
    const basic = basicAuthorization(config.clientId, config.clientSecret);
    if ("header" in basic) headers.push(basic.header);
    else basicAuth = basic.agent;
  }
  const body = form.map(([key, value]) => `${key}=${encodeQueryComponent(value)}`).join("&");
  return { url: config.tokenUrl, headers, body, ...(basicAuth ? { basicAuth } : {}) };
}

/** Reads a token response; an OAuth error body becomes the message. */
export function parseOAuthToken(status: number, text: string, now = Date.now()): OAuthToken {
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Reported below with the status.
  }
  const record = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
  if (status < 200 || status >= 300 || typeof record.access_token !== "string" || !record.access_token) {
    const detail = [record.error, record.error_description].filter((part) => typeof part === "string" && part).join(": ");
    throw new HttpBuildError("oauth_token", `HTTP ${status}${detail ? ` · ${detail}` : ""}`);
  }
  const tokenType = typeof record.token_type === "string" && record.token_type && record.token_type.toLowerCase() !== "bearer"
    ? record.token_type : "Bearer";
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in
    : typeof record.expires_in === "string" ? Number(record.expires_in) : NaN;
  return {
    accessToken: record.access_token,
    tokenType,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
  };
}

/** Same config, same cached token. */
export function oauthCacheKey(config: OAuthClientConfig): string {
  return JSON.stringify([config.tokenUrl, config.clientId, config.clientSecret, config.scope, config.clientAuth]);
}

/** A token within 30 s of expiry is fetched again. */
export function oauthTokenValid(token: OAuthToken | undefined, now = Date.now()): token is OAuthToken {
  return token !== undefined && (token.expiresAt === null || token.expiresAt - 30_000 > now);
}

export interface BuildInput {
  method: string;
  url: string;
  headers: readonly Header[];
  body: string;
  bodyFormat: HttpSavedRequest["bodyFormat"];
  auth: ConcreteAuth;
  scope: VariableScope;
  /** Returns a token for the resolved OAuth config (cached or fetched through the agent). */
  oauthToken?: (config: OAuthClientConfig) => Promise<OAuthToken>;
  now?: () => Date;
}

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Header[];
  body: Uint8Array;
  basicAuth?: BasicCredentials;
  unresolved: string[];
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTENT_TYPES: Record<HttpSavedRequest["bodyFormat"], string> = {
  text: "text/plain; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  xml: "application/xml",
};

function withoutHeader(headers: Header[], name: string): Header[] {
  const lower = name.toLowerCase();
  return headers.filter((header) => header.name.toLowerCase() !== lower);
}

/** Resolves a request for sending: variables, then auth, then validation of URL and headers. */
export async function buildHttpRequest(input: BuildInput): Promise<BuiltRequest> {
  const unresolved = new Set<string>();
  const resolve = (text: string): string => resolveVariables(text, input.scope, { unresolved, now: input.now });
  let url = resolve(input.url.trim());
  let headers: Header[] = input.headers.map(({ name, value }) => ({ name: resolve(name).trim(), value: resolve(value) }));
  const bodyText = resolve(input.body);
  const body = new TextEncoder().encode(bodyText);
  if (body.byteLength && !headers.some(({ name }) => name.toLowerCase() === "content-type")) {
    headers.push({ name: "Content-Type", value: CONTENT_TYPES[input.bodyFormat] });
  }
  let basicAuth: BasicCredentials | undefined;
  const auth = input.auth;
  const field = (value: string, required = true): string => {
    const resolved = resolve(value).trim();
    if (required && !resolved) throw new HttpBuildError("auth_incomplete");
    return resolved;
  };
  if (auth.type === "basic") {
    const basic = basicAuthorization(field(auth.username, false), resolve(auth.password));
    headers = withoutHeader(headers, "Authorization");
    if ("header" in basic) headers.push(basic.header);
    else basicAuth = basic.agent;
  } else if (auth.type === "bearer") {
    headers = [...withoutHeader(headers, "Authorization"), { name: "Authorization", value: `Bearer ${field(auth.token)}` }];
  } else if (auth.type === "apikey") {
    const key = field(auth.key);
    const value = resolve(auth.value);
    if (auth.in === "header") {
      headers = [...withoutHeader(headers, key), { name: key, value }];
    } else {
      const hashAt = url.indexOf("#");
      const fragment = hashAt < 0 ? "" : url.slice(hashAt);
      const base = hashAt < 0 ? url : url.slice(0, hashAt);
      const pair = `${encodeQueryComponent(key)}=${encodeQueryComponent(value)}`;
      url = `${base}${base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?"}${pair}${fragment}`;
    }
  } else if (auth.type === "oauth2") {
    if (!input.oauthToken) throw new HttpBuildError("oauth_token");
    const token = await input.oauthToken({
      tokenUrl: field(auth.tokenUrl), clientId: field(auth.clientId), clientSecret: resolve(auth.clientSecret),
      scope: resolve(auth.scope), clientAuth: auth.clientAuth,
    });
    headers = [...withoutHeader(headers, "Authorization"), { name: "Authorization", value: `${token.tokenType} ${token.accessToken}` }];
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new HttpBuildError("url");
  }
  if (headers.some(({ name, value }) => !HEADER_NAME.test(name) || /[\r\n]/u.test(value))) throw new HttpBuildError("headers");

  if (auth.type === "awsv4") {
    const keys = [auth.accessKey, auth.secretKey, auth.sessionToken].map(resolve);
    // The page signs, so it must see every signed byte: an agent secret would change them after signing.
    if (keys.some(hasSecretPlaceholder) || hasSecretPlaceholder(url) || hasSecretPlaceholder(bodyText)
      || headers.some(({ value }) => hasSecretPlaceholder(value))) throw new HttpBuildError("aws_secret");
    url = parsed.href;
    const [accessKey, secretKey, sessionToken] = keys as [string, string, string];
    if (!accessKey.trim() || !secretKey.trim()) throw new HttpBuildError("auth_incomplete");
    for (const name of ["Authorization", "X-Amz-Date", "X-Amz-Security-Token", "X-Amz-Content-Sha256"]) {
      headers = withoutHeader(headers, name);
    }
    headers.push(...await signAwsV4({
      method: input.method, url: parsed, headers, body,
      accessKey: accessKey.trim(), secretKey: secretKey.trim(), sessionToken: sessionToken.trim(),
      region: field(auth.region), service: field(auth.service), now: input.now?.(),
    }));
  }
  return { method: input.method, url, headers, body, ...(basicAuth ? { basicAuth } : {}), unresolved: [...unresolved] };
}
