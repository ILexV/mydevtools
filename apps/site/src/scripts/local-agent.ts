const AGENT_BASE_URL = "http://127.0.0.1:48732";
const PROTOCOL_VERSION = 1;
const SESSION_STORAGE_KEY = "mdt.local-agent.session.v1";
const SESSION_STORAGE_VERSION = 1;


export type LocalAgentCapability = "http.request" | "icmp.trace" | "dns.lookup" | "tcp.connect" | "tls.inspect" | "whois.lookup" | "asn.lookup"
  | "vault.data" | "vault.secrets" | "sse.stream" | "websocket.connect";

const CAPABILITY_ORDER: readonly LocalAgentCapability[] = [
  "http.request",
  "icmp.trace",
  "dns.lookup",
  "tcp.connect",
  "tls.inspect",
  "whois.lookup",
  "asn.lookup",
  "vault.data",
  "vault.secrets",
  "sse.stream",
  "websocket.connect",
];

/**
 * Capabilities to request when any network tool pairs: every capability the running
 * agent advertises that this site knows, plus the one this tool needs. One pairing
 * code in any window then unlocks HTTP, path trace, DNS, TCP, TLS, WHOIS and ASN.
 * A grant the agent no longer advertises is dropped. `pair()` itself adds nothing.
 */
export function mergeCapabilities(
  advertised: readonly string[],
  needed: LocalAgentCapability,
): LocalAgentCapability[] {
  const advertisedSet = new Set(advertised);
  return CAPABILITY_ORDER.filter((capability) => capability === needed || advertisedSet.has(capability));
}

export interface LocalAgentInfo {
  protocolVersion: number;
  /** Optional protocol parts, such as `http.options`; missing on older agents. */
  features?: string[];
  version: string;
  capabilities: LocalAgentCapability[];
  privateNetworkAllowed: boolean;
  /** Missing on agents without the encrypted vault. */
  vaultAvailable?: boolean;
  limits: {
    maxRequestBodyBytes: number;
    maxResponseBodyBytes: number;
    maxTimeoutMs: number;
  };
}

export interface LocalAgentHeader {
  name: string;
  value: string;
}

export interface LocalHttpRequest {
  id: string;
  method: string;
  url: string;
  headers: LocalAgentHeader[];
  bodyBase64: string;
  timeoutMs: number;
  followRedirects: boolean;
  /** Basic credentials the agent encodes after substituting `{{secret:name}}` (vault agents only). */
  basicAuth?: { username: string; password: string };
  /** `http.options` agents only, like `httpVersion` and `proxy`; omitted means on. */
  verifyTls?: boolean;
  httpVersion?: "auto" | "http1" | "http2";
  proxy?: { url: string; username?: string; password?: string; bypass?: string[] };
  /** Vault client certificate by name (`http.client_certificates`, needs `vault.secrets`). */
  clientCertificate?: string;
  /** The cookie jar (`http.cookies`): picked per hop by the agent; absent leaves cookies to the headers. */
  cookies?: LocalHttpCookie[];
  /** `sse.stream`: leave a 2xx `text/event-stream` reply open for `sseStream()` instead of reading it whole. */
  streamEvents?: boolean;
}

/** A jar cookie as the agent takes and returns it; `expires` is Unix seconds, absent for a session cookie. */
export interface LocalHttpCookie {
  name: string;
  value: string;
  /** Lowercase, without a leading dot. */
  domain: string;
  path: string;
  /** Only `domain` itself, not its subdomains. */
  hostOnly?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

/** Phases of the last connection in milliseconds; `tlsMs` is null for http. */
export interface LocalHttpTimings {
  dnsMs: number;
  connectMs: number;
  tlsMs: number | null;
  firstByteMs: number;
  downloadMs: number;
}

export interface LocalHttpResponse {
  status: number;
  statusText: string;
  url: string;
  headers: LocalAgentHeader[];
  bodyBase64: string;
  elapsedMs: number;
  /** The rest comes from `http.options` agents. */
  httpVersion?: string;
  remoteAddress?: string;
  timings?: LocalHttpTimings;
  redirects?: number;
  tls?: { protocol: string; cipher: string; verified: boolean } | null;
  /** Set by the page: the client certificate it asked the agent to present. */
  clientCertificate?: string;
  /** Jar changes from `Set-Cookie` of every hop when the request sent a jar; a past expiry deletes. */
  cookies?: LocalHttpCookie[];
  /** `sse`: an event stream left unread (`sse.stream`); `sseStream()` with the request id reads it. */
  stream?: "sse";
}

/** One line of `sseStream()`: an event, then `end` or `error`. */
export type LocalSseLine =
  | { type: "event"; event: string; data: string; id?: string; retry?: number }
  | { type: "end" }
  | { type: "error"; code: string };

/** `websocket.connect`: the handshake takes `timeoutMs`; the open connection has no limit. */
export interface LocalWebSocketRequest {
  id: string;
  url: string;
  headers: LocalAgentHeader[];
  protocols?: string[];
  timeoutMs: number;
  verifyTls?: boolean;
  proxy?: LocalHttpRequest["proxy"];
  clientCertificate?: string;
}

/** One line of `connectWebSocket()`: `open` or `rejected` first, then messages and `close` or `error`. */
export type LocalWebSocketLine =
  | {
    type: "open";
    status: number;
    headers: LocalAgentHeader[];
    protocol: string | null;
    remoteAddress: string;
    tls: { protocol: string; cipher: string; verified: boolean } | null;
  }
  | { type: "rejected"; status: number; headers: LocalAgentHeader[]; bodyBase64: string }
  | { type: "message"; kind: "text"; data: string }
  | { type: "message"; kind: "binary"; dataBase64: string }
  | { type: "close"; code: number; reason: string; initiator: "server" | "client" | "agent" }
  | { type: "error"; code: string };

interface PairResponse {
  token: string;
  capabilities: LocalAgentCapability[];
  expiresAt: string;
}
interface StoredSession {
  v: typeof SESSION_STORAGE_VERSION;
  token: string;
  expiresAt: string;
  /** Missing on records saved before path tracing: those sessions are HTTP-only. */
  capabilities: LocalAgentCapability[];
}

export interface TraceHopSnapshot {
  hop: number;
  address: string | null;
  name: string | null;
  sent: number;
  received: number;
  lossPercent: number;
  lastMs: number | null;
  bestMs: number | null;
  avgMs: number | null;
  worstMs: number | null;
  /** Sample standard deviation of reply RTTs, tenths of a millisecond. Null before two replies. */
  stdevMs: number | null;
  /** Average jitter of consecutive reply RTTs, tenths of a millisecond. Null before two replies. */
  jitterMs: number | null;
  status: string | null;
}

export interface TraceSnapshot {
  id: string;
  state: "tracing" | "stopping" | "idle";
  target: string;
  targetInput: string;
  /** Bound local source. Null when the operating system chose, or the agent is older. */
  sourceAddress: string | null;
  sourceInterface: string | null;
  hops: TraceHopSnapshot[];
}

export interface TraceStartRequest {
  id: string;
  target: string;
  intervalMs: number;
  payloadBytes: number;
  maxHops: number;
  timeoutMs: number;
  resolveNames: boolean;
  /** Both fields together select a listed local address. Omit both for automatic. */
  sourceAddress?: string;
  sourceInterface?: string;
}

/** One DNS answer from the computer's resolver. `preference` is set for MX. */
export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  data: string;
  preference: number | null;
}

/** Result of one `dns.lookup` query. The name and answers are not stored. */
export interface DnsLookupResult {
  name: string;
  type: string;
  status: "noerror" | "nodata" | "nxdomain";
  records: DnsRecord[];
}

export interface DnsLookupRequest {
  name: string;
  type: string;
}

/** One TCP handshake. The host, the port and the result are not stored. */
export interface TcpConnectResult {
  host: string;
  port: number;
  address: string;
  status: "open" | "refused" | "timeout" | "unreachable";
  elapsedMs: number;
}

export interface TcpConnectRequest {
  host: string;
  port: number;
  timeoutMs: number;
}

/** One certificate from a live handshake. Dates are UTC. A pasted PEM is not this type. */
export interface TlsCertificate {
  subject: string;
  issuer: string;
  notBefore: string | null;
  notAfter: string | null;
  sha256: string;
}

/** One TLS handshake. The host, the port and the chain are not stored. */
export interface TlsInspectResult {
  host: string;
  port: number;
  address: string;
  status: "ok" | "refused" | "timeout" | "unreachable" | "handshake_failed";
  elapsedMs: number;
  protocol: string | null;
  cipher: string | null;
  trusted: boolean | null;
  certificates: TlsCertificate[];
}

export interface TlsInspectRequest {
  host: string;
  port: number;
  timeoutMs: number;
}

/** One WHOIS reply from TCP port 43. `text` is empty unless `status` is `ok`. */
export interface WhoisLookupResult {
  query: string;
  server: string;
  port: number;
  address: string;
  status: "ok" | "refused" | "timeout" | "unreachable";
  elapsedMs: number;
  truncated: boolean;
  text: string;
}

export interface WhoisLookupRequest {
  query: string;
  server: string;
  timeoutMs: number;
}

/** One longest-prefix answer from the agent's local prefix table. */
export interface AsnLookupResult {
  query: string;
  address: string;
  prefix: string | null;
  asn: number | null;
  name: string;
  status: "found" | "reserved" | "not_found";
  covers: boolean;
}

export interface AsnLookupRequest {
  query: string;
}

/** One address from `GET /v1/icmp/interfaces`. Scope ids stay on the agent. */
export interface LocalInterface {
  name: string;
  address: string;
}

/** One-shot path MTU search. `found` carries `mtu`; a loss stays `inconclusive`. */
export interface PathMtuSnapshot {
  target: string;
  targetInput: string;
  status: "found" | "below_minimum" | "inconclusive";
  mtu: number | null;
  payloadBytes: number | null;
  atCeiling: boolean;
  minimumMtu: number | null;
  /** Bound local source. Null when the operating system chose, or the agent is older. */
  sourceAddress: string | null;
  sourceInterface: string | null;
}

export interface PathMtuRequest {
  target: string;
  timeoutMs: number;
  /** Both fields together select a listed local address. Omit both for automatic. */
  sourceAddress?: string;
  sourceInterface?: string;
}

export type LocalAgentStorageState = "unknown" | "available" | "unavailable";

/** One encrypted document in the agent vault. `revision` guards concurrent saves. */
export interface VaultDocument {
  name: string;
  revision: number;
  updatedAt: string;
  data: unknown;
}

export interface VaultDocumentInfo {
  name: string;
  revision: number;
  updatedAt: string;
}

/** A secret as a page sees it: the value never leaves the agent. */
export interface VaultSecretInfo {
  name: string;
  hosts: string[];
  updatedAt: string;
}

function asVaultDocumentInfo(value: unknown): VaultDocumentInfo {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.updatedAt !== "string") {
    throw new LocalAgentError("invalid_response");
  }
  return { name: value.name, revision: value.revision, updatedAt: value.updatedAt };
}

/** A client certificate in the agent vault; the key is never returned. */
export interface VaultCertificateInfo {
  name: string;
  hosts: string[];
  subject: string;
  notAfter: string | null;
  updatedAt: string;
}

function asVaultCertificateInfo(value: unknown): VaultCertificateInfo {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.updatedAt !== "string" || typeof value.subject !== "string"
    || !(value.notAfter === null || value.notAfter === undefined || typeof value.notAfter === "string")
    || !Array.isArray(value.hosts) || !value.hosts.every((host) => typeof host === "string")) {
    throw new LocalAgentError("invalid_response");
  }
  return { name: value.name, hosts: value.hosts as string[], subject: value.subject, notAfter: (value.notAfter as string | undefined) ?? null,
    updatedAt: value.updatedAt };
}

function asVaultSecretInfo(value: unknown): VaultSecretInfo {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.updatedAt !== "string"
    || !Array.isArray(value.hosts) || !value.hosts.every((host) => typeof host === "string")) {
    throw new LocalAgentError("invalid_response");
  }
  return { name: value.name, hosts: value.hosts as string[], updatedAt: value.updatedAt };
}


export class LocalAgentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 0, message?: string) {
    super(message || code);
    this.name = "LocalAgentError";
    this.code = code;
    this.status = status;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function responseError(response: Response): Promise<LocalAgentError> {
  let code = response.status === 401 ? "unauthorized" : "network_error";
  let message: string | undefined;
  try {
    const payload: unknown = await response.json();
    if (isObject(payload) && isObject(payload.error)) {
      if (typeof payload.error.code === "string") code = payload.error.code;
      if (typeof payload.error.message === "string") message = payload.error.message;
    }
  } catch {
    // The UI maps the stable code; an invalid error body must not expose HTML.
  }
  return new LocalAgentError(code, response.status, message);
}

async function jsonRequest<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${AGENT_BASE_URL}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json", ...init.headers },
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LocalAgentError("agent_unavailable");
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LocalAgentError("invalid_response", response.status);
  }
}

/**
 * Browser client for the versioned local companion protocol. The origin-bound,
 * time-limited session token is persisted; the one-time pairing code is not.
 */
export class LocalAgentClient {
  #token: string | null = null;
  #info: LocalAgentInfo | null = null;
  #expiresAt: string | null = null;
  #capabilities: LocalAgentCapability[] = [];
  #storageState: LocalAgentStorageState = "unknown";
  #persisted = false;

  get connected(): boolean {
    this.#clearIfExpired();
    return this.#token !== null;
  }

  get info(): LocalAgentInfo | null {
    return this.#info;
  }

  get expiresAt(): string | null {
    this.#clearIfExpired();
    return this.#expiresAt;
  }

  get storageState(): LocalAgentStorageState {
    return this.#storageState;
  }
  get persisted(): boolean {
    return this.#persisted;
  }

  /**
   * Capabilities granted to the saved browser session. An older record without
   * the field is HTTP-only. Read this before `pair()`: pairing clears storage.
   */
  get capabilities(): readonly LocalAgentCapability[] {
    if (this.#token || this.#capabilities.length > 0) return this.#capabilities;
    return this.#readStoredSession()?.capabilities ?? [];
  }


  async inspect(signal?: AbortSignal): Promise<LocalAgentInfo> {
    const info = await jsonRequest<LocalAgentInfo>("/v1/info", { method: "GET", signal });
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new LocalAgentError("incompatible_protocol");
    this.#info = info;
    return info;
  }
  async restore(): Promise<LocalAgentInfo | null> {
    this.#token = null;
    this.#expiresAt = null;
    this.#info = null;
    this.#capabilities = [];
    this.#persisted = false;

    const stored = this.#readStoredSession();
    if (!stored) return null;
    if (Date.parse(stored.expiresAt) <= Date.now()) {
      this.clear();
      return null;
    }

    // /v1/info is the only non-destructive inspection route. The first
    // authorized operation detects a session lost because the agent restarted.
    const info = await this.inspect();
    if (Date.parse(stored.expiresAt) <= Date.now()) {
      this.clear();
      return null;
    }
    this.#token = stored.token;
    this.#expiresAt = stored.expiresAt;
    this.#capabilities = stored.capabilities;
    this.#persisted = true;
    return info;
  }


  async pair(
    code: string,
    capabilities: readonly LocalAgentCapability[],
    signal?: AbortSignal,
  ): Promise<LocalAgentInfo> {
    this.clear();
    const info = await this.inspect(signal);
    if (!Array.isArray(info.capabilities) || capabilities.some((capability) => !info.capabilities.includes(capability))) {
      throw new LocalAgentError("unsupported_capability");
    }
    const paired = await jsonRequest<PairResponse>("/v1/pair", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, capabilities }),
    });
    if (!Array.isArray(paired.capabilities) || capabilities.some((capability) => !paired.capabilities.includes(capability))) {
      throw new LocalAgentError("unsupported_capability");
    }
    const expiresAt = Date.parse(paired.expiresAt);
    if (
      typeof paired.token !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(paired.token)
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()
    ) {
      throw new LocalAgentError("invalid_response");
    }
    this.#token = paired.token;
    this.#expiresAt = paired.expiresAt;
    this.#capabilities = normalizeCapabilities(paired.capabilities, false);
    this.#writeStoredSession({
      v: SESSION_STORAGE_VERSION,
      token: paired.token,
      expiresAt: paired.expiresAt,
      capabilities: this.#capabilities,
    });
    return info;
  }

  /**
   * Pairs a new code while keeping the saved session if pairing fails.
   * Path tracing uses this so a wrong code does not drop an HTTP grant.
   * `pair()` still clears storage before the request; this puts that record back.
   */
  async pairKeepingSession(
    code: string,
    capabilities: readonly LocalAgentCapability[],
    signal?: AbortSignal,
  ): Promise<LocalAgentInfo> {
    const saved = this.#readStoredSessionRaw();
    try {
      return await this.pair(code, capabilities, signal);
    } catch (error) {
      if (!this.connected && saved) {
        try {
          if (localStorage.getItem(SESSION_STORAGE_KEY) === null) {
            localStorage.setItem(SESSION_STORAGE_KEY, saved);
          }
          await this.restore();
        } catch {
          // The pairing error is the one the page should show.
        }
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const token = this.#token;
    this.clear();
    if (!token) return;
    try {
      await jsonRequest<void>("/v1/session", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      // An expired session is already revoked; other failures must reach the UI.
      if (!(error instanceof LocalAgentError && error.code === "unauthorized")) throw error;
    }
  }

  async request(request: LocalHttpRequest, signal?: AbortSignal): Promise<LocalHttpResponse> {
    return await this.#authorized<LocalHttpResponse>("/v1/http/request", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  /** Reads a parked event stream until it ends; aborting the signal closes it. */
  async sseStream(id: string, onLine: (line: LocalSseLine) => void, signal?: AbortSignal): Promise<void> {
    await this.#stream("/v1/sse/stream", { id }, onLine as (line: unknown) => void, signal);
  }

  /** Opens a WebSocket and reports it line by line until it closes; aborting the signal drops it. */
  async connectWebSocket(
    request: LocalWebSocketRequest,
    onLine: (line: LocalWebSocketLine) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#stream("/v1/ws/connect", request, onLine as (line: unknown) => void, signal);
  }

  /** Sends one text or binary message on an open WebSocket. */
  async sendWebSocket(id: string, message: { text: string } | { binaryBase64: string }): Promise<void> {
    await this.#authorized<void>("/v1/ws/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...message }),
    });
  }

  /** Starts the closing handshake; the `close` line arrives on the connection's stream. */
  async closeWebSocket(id: string, code?: number, reason?: string): Promise<void> {
    await this.#authorized<void>("/v1/ws/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) }),
    });
  }

  async cancel(id: string): Promise<void> {
    await this.#authorized<void>("/v1/http/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  /** Starts a continuous ICMP path trace. The returned snapshot is the empty initial table. */
  async startTrace(request: TraceStartRequest, signal?: AbortSignal): Promise<TraceSnapshot> {
    return asTraceSnapshot(await this.#authorized<unknown>("/v1/icmp/trace", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
  }

  async traceSnapshot(id: string, signal?: AbortSignal): Promise<TraceSnapshot> {
    return asTraceSnapshot(await this.#authorized<unknown>("/v1/icmp/snapshot", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }));
  }

  async cancelTrace(id: string): Promise<void> {
    await this.#authorized<void>("/v1/icmp/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  /**
   * Local unicast addresses on this computer. Does not take an ICMP slot.
   * The list is not a scan and not an ARP table.
   */
  async listInterfaces(signal?: AbortSignal): Promise<LocalInterface[]> {
    return asInterfaceList(await this.#authorized<unknown>("/v1/icmp/interfaces", {
      method: "GET",
      signal,
    }));
  }

  /**
   * One query to this computer's DNS resolver. Requires `dns.lookup`.
   * The name is not sent to a MyDevTools server and not looked up over DoH.
   */
  async lookupDns(request: DnsLookupRequest, signal?: AbortSignal): Promise<DnsLookupResult> {
    return asDnsLookup(await this.#authorized<unknown>("/v1/dns/lookup", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
  }

  /**
   * One TCP handshake to one host and one port. Requires `tcp.connect`.
   * The socket is closed without sending data. A port range is not a request.
   */
  async connectTcp(request: TcpConnectRequest, signal?: AbortSignal): Promise<TcpConnectResult> {
    return asTcpConnect(await this.#authorized<unknown>("/v1/tcp/connect", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
  }

  /**
   * One TLS handshake to one host and one port. Requires `tls.inspect`.
   * The socket closes without application data. A pasted PEM is not sent.
   */
  async inspectTls(request: TlsInspectRequest, signal?: AbortSignal): Promise<TlsInspectResult> {
    return asTlsInspect(await this.#authorized<unknown>("/v1/tls/inspect", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
  }

  /**
   * One WHOIS query on TCP port 43. Requires `whois.lookup`.
   * The agent does not follow a referral to another server.
   */
  async lookupWhois(request: WhoisLookupRequest, signal?: AbortSignal): Promise<WhoisLookupResult> {
    return asWhoisLookup(await this.#authorized<unknown>("/v1/whois/lookup", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
  }

  /**
   * One address or one CIDR in the local prefix table. Requires `asn.lookup`.
   * The agent does not call a geo-IP API and does not resolve a hostname.
   */
  async lookupAsn(request: AsnLookupRequest, signal?: AbortSignal): Promise<AsnLookupResult> {
    return asAsnLookup(await this.#authorized<unknown>("/v1/asn/lookup", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
  }

  /** Path MTU on `icmp.trace`. Same Don't Fragment echoes; the agent picks the size. */
  async findPathMtu(request: PathMtuRequest, signal?: AbortSignal): Promise<PathMtuSnapshot> {
    return asPathMtu(await this.#authorized<unknown>("/v1/icmp/mtu", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
  }

  /** Names and revisions of this origin's vault documents. Requires `vault.data`. */
  async listDocuments(signal?: AbortSignal): Promise<VaultDocumentInfo[]> {
    const value = await this.#authorized<unknown>("/v1/vault/documents", { method: "GET", signal });
    if (!isObject(value) || !Array.isArray(value.documents)) throw new LocalAgentError("invalid_response");
    return value.documents.map(asVaultDocumentInfo);
  }

  /** One document, or null when the vault has none under this name. */
  async readDocument(name: string, signal?: AbortSignal): Promise<VaultDocument | null> {
    let value: unknown;
    try {
      value = await this.#authorized<unknown>("/v1/vault/document/read", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch (error) {
      if (error instanceof LocalAgentError && error.code === "not_found") return null;
      throw error;
    }
    const info = asVaultDocumentInfo(value);
    return { ...info, data: (value as Record<string, unknown>).data };
  }

  /**
   * Saves over `baseRevision` (0 creates) and returns the new revision. A stale
   * base fails with `revision_conflict`. `keepalive` lets a small save outlive pagehide.
   */
  async writeDocument(
    name: string,
    baseRevision: number,
    data: unknown,
    options: { signal?: AbortSignal; keepalive?: boolean } = {},
  ): Promise<number> {
    const value = await this.#authorized<unknown>("/v1/vault/document/write", {
      method: "POST",
      signal: options.signal,
      keepalive: options.keepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, baseRevision, data }),
    });
    if (!isObject(value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision)) {
      throw new LocalAgentError("invalid_response");
    }
    return value.revision;
  }

  async deleteDocument(name: string, baseRevision: number): Promise<void> {
    await this.#authorized<void>("/v1/vault/document/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, baseRevision }),
    });
  }

  /** Secret names and hosts without values. Requires `vault.secrets`. */
  async listSecrets(signal?: AbortSignal): Promise<VaultSecretInfo[]> {
    const value = await this.#authorized<unknown>("/v1/vault/secrets", { method: "GET", signal });
    if (!isObject(value) || !Array.isArray(value.secrets)) throw new LocalAgentError("invalid_response");
    return value.secrets.map(asVaultSecretInfo);
  }

  /**
   * Stores a write-only secret for `{{secret:name}}`. Omit `value` to change
   * only the hosts the agent may send it to.
   */
  async writeSecret(name: string, hosts: readonly string[], value?: string): Promise<void> {
    await this.#authorized<void>("/v1/vault/secret/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value === undefined ? { name, hosts } : { name, value, hosts }),
    });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.#authorized<void>("/v1/vault/secret/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  /** Client certificate names, hosts, subjects and expiry. Requires `vault.secrets`. */
  async listCertificates(signal?: AbortSignal): Promise<VaultCertificateInfo[]> {
    const value = await this.#authorized<unknown>("/v1/vault/certificates", { method: "GET", signal });
    if (!isObject(value) || !Array.isArray(value.certificates)) throw new LocalAgentError("invalid_response");
    return value.certificates.map(asVaultCertificateInfo);
  }

  /** Stores a certificate chain and its unencrypted key (PEM); omit `pems` to change only the hosts. */
  async writeCertificate(name: string, hosts: readonly string[], pems?: { certificatePem: string; keyPem: string }): Promise<void> {
    await this.#authorized<void>("/v1/vault/certificate/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, hosts, ...pems }),
    });
  }

  async deleteCertificate(name: string): Promise<void> {
    await this.#authorized<void>("/v1/vault/certificate/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  clear(): void {
    this.#token = null;
    this.#expiresAt = null;
    this.#info = null;
    this.#capabilities = [];
    this.#persisted = false;
    this.#removeStoredSession();
  }

  async #authorized<T>(path: string, init: RequestInit): Promise<T> {
    this.#clearIfExpired();
    if (!this.#token) throw new LocalAgentError("unauthorized");
    try {
      return await jsonRequest<T>(path, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.#token}` },
      });
    } catch (error) {
      if (error instanceof LocalAgentError && error.code === "unauthorized") this.clear();
      throw error;
    }
  }

  /** POSTs JSON and hands each NDJSON line of the reply to `onLine` while it arrives. */
  async #stream(path: string, body: unknown, onLine: (line: unknown) => void, signal?: AbortSignal): Promise<void> {
    this.#clearIfExpired();
    if (!this.#token) throw new LocalAgentError("unauthorized");
    let response: Response;
    try {
      response = await fetch(`${AGENT_BASE_URL}${path}`, {
        method: "POST",
        signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json", Authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new LocalAgentError("agent_unavailable");
    }
    if (!response.ok) {
      const error = await responseError(response);
      if (error.code === "unauthorized") this.clear();
      throw error;
    }
    if (!response.body) throw new LocalAgentError("invalid_response", response.status);
    await readNdjson(response.body, onLine);
  }

  #readStoredSessionRaw(): string | null {
    try {
      return localStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  #readStoredSession(): StoredSession | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(SESSION_STORAGE_KEY);
      this.#storageState = "available";
    } catch {
      this.#storageState = "unavailable";
      return null;
    }
    if (raw === null) return null;

    try {
      const value: unknown = JSON.parse(raw);
      if (
        !isObject(value)
        || value.v !== SESSION_STORAGE_VERSION
        || typeof value.token !== "string"
        || !/^[A-Za-z0-9_-]{43}$/.test(value.token)
        || typeof value.expiresAt !== "string"
        || !Number.isFinite(Date.parse(value.expiresAt))
      ) {
        this.#removeStoredSession();
        return null;
      }
      return {
        v: SESSION_STORAGE_VERSION,
        token: value.token,
        expiresAt: value.expiresAt,
        capabilities: normalizeCapabilities(value.capabilities, !Object.hasOwn(value, "capabilities")),
      };
    } catch {
      this.#removeStoredSession();
      return null;
    }
  }

  #writeStoredSession(session: StoredSession): void {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      this.#storageState = "available";
      this.#persisted = true;
    } catch {
      this.#storageState = "unavailable";
      this.#persisted = false;
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // Storage is blocked; the live session remains usable in memory.
      }
    }
  }

  #removeStoredSession(): void {
    this.#persisted = false;
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      if (this.#storageState === "unknown") this.#storageState = "available";
    } catch {
      this.#storageState = "unavailable";
    }
  }

  #clearIfExpired(): void {
    if (this.#expiresAt !== null && Date.parse(this.#expiresAt) <= Date.now()) this.clear();
  }
}

/**
 * Keeps known capability ids in protocol order.
 * A missing field on an old session record means HTTP-only.
 * A present array is filtered and may be empty: do not invent `http.request`.
 */
function normalizeCapabilities(value: unknown, missingMeansHttp: boolean): LocalAgentCapability[] {
  if (!Array.isArray(value)) return missingMeansHttp ? ["http.request"] : [];
  const present = new Set(value.filter((item): item is string => typeof item === "string"));
  return CAPABILITY_ORDER.filter((capability) => present.has(capability));
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Rejects a path-MTU body the page cannot turn into a sentence. */
function asPathMtu(value: unknown): PathMtuSnapshot {
  if (!isObject(value) || typeof value.atCeiling !== "boolean") {
    throw new LocalAgentError("invalid_response");
  }
  if (value.status !== "found" && value.status !== "below_minimum" && value.status !== "inconclusive") {
    throw new LocalAgentError("invalid_response");
  }
  return {
    target: typeof value.target === "string" ? value.target : "",
    targetInput: typeof value.targetInput === "string" ? value.targetInput : "",
    status: value.status,
    mtu: asNullableCount(value.mtu),
    payloadBytes: asNullableCount(value.payloadBytes),
    atCeiling: value.atCeiling,
    minimumMtu: asNullableCount(value.minimumMtu),
    sourceAddress: asNullableString(value.sourceAddress),
    sourceInterface: asNullableString(value.sourceInterface),
  };
}

/** Keeps named unicast rows. An older agent that omits the list is rejected. */
function asInterfaceList(value: unknown): LocalInterface[] {
  if (!isObject(value) || !Array.isArray(value.interfaces)) {
    throw new LocalAgentError("invalid_response");
  }
  const interfaces: LocalInterface[] = [];
  for (const item of value.interfaces) {
    if (!isObject(item) || typeof item.name !== "string" || typeof item.address !== "string") {
      throw new LocalAgentError("invalid_response");
    }
    if (!item.name || !item.address) continue;
    interfaces.push({ name: item.name, address: item.address });
  }
  return interfaces;
}

const DNS_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "PTR"]);

/** Rejects a DNS body the answer table cannot render. */
function asDnsLookup(value: unknown): DnsLookupResult {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.type !== "string" || !Array.isArray(value.records)) {
    throw new LocalAgentError("invalid_response");
  }
  if (value.status !== "noerror" && value.status !== "nodata" && value.status !== "nxdomain") {
    throw new LocalAgentError("invalid_response");
  }
  if (!DNS_TYPES.has(value.type) || value.records.length > 64) {
    throw new LocalAgentError("invalid_response");
  }
  const records = value.records.map((item): DnsRecord => {
    if (!isObject(item) || typeof item.name !== "string" || typeof item.type !== "string" || typeof item.data !== "string") {
      throw new LocalAgentError("invalid_response");
    }
    if (!DNS_TYPES.has(item.type) || typeof item.ttl !== "number" || !Number.isFinite(item.ttl)) {
      throw new LocalAgentError("invalid_response");
    }
    const preference = item.preference === null || item.preference === undefined
      ? null
      : typeof item.preference === "number" && Number.isFinite(item.preference)
        ? item.preference
        : null;
    if (item.preference !== null && item.preference !== undefined && preference === null) {
      throw new LocalAgentError("invalid_response");
    }
    return { name: item.name, type: item.type, ttl: item.ttl, data: item.data, preference };
  });
  return { name: value.name, type: value.type, status: value.status, records };
}

const WHOIS_STATUSES = new Set(["ok", "refused", "timeout", "unreachable"]);

/** Rejects a WHOIS body the page cannot render. The port is always 43. */
function asWhoisLookup(value: unknown): WhoisLookupResult {
  if (!isObject(value) || typeof value.query !== "string" || value.query.length === 0) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.server !== "string" || value.server.length === 0 || typeof value.address !== "string") {
    throw new LocalAgentError("invalid_response");
  }
  if (value.port !== 43 || typeof value.status !== "string" || !WHOIS_STATUSES.has(value.status)) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.text !== "string" || typeof value.truncated !== "boolean") {
    throw new LocalAgentError("invalid_response");
  }
  if (value.status !== "ok" && (value.text !== "" || value.truncated)) {
    throw new LocalAgentError("invalid_response");
  }
  if (value.text.length > 64 * 1024) throw new LocalAgentError("invalid_response");
  return {
    query: value.query,
    server: value.server,
    port: 43,
    address: value.address,
    status: value.status as WhoisLookupResult["status"],
    elapsedMs: value.elapsedMs,
    truncated: value.truncated,
    text: value.text,
  };
}

const ASN_STATUSES = new Set(["found", "reserved", "not_found"]);

/** Rejects an ASN body the page cannot render. A miss has no prefix and no ASN. */
function asAsnLookup(value: unknown): AsnLookupResult {
  if (!isObject(value) || typeof value.query !== "string" || value.query.length === 0 || value.query.length > 128) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.address !== "string" || value.address.length === 0 || value.address.length > 128) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.status !== "string" || !ASN_STATUSES.has(value.status)) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.name !== "string" || value.name.length > 96 || typeof value.covers !== "boolean") {
    throw new LocalAgentError("invalid_response");
  }
  const prefix = value.prefix === null ? null : typeof value.prefix === "string" && value.prefix.length > 0 && value.prefix.length <= 128
    ? value.prefix
    : undefined;
  if (prefix === undefined) throw new LocalAgentError("invalid_response");
  const asn = value.asn === null ? null : typeof value.asn === "number" && Number.isInteger(value.asn) && value.asn >= 1 && value.asn <= 0xffffffff
    ? value.asn
    : undefined;
  if (asn === undefined) throw new LocalAgentError("invalid_response");
  if (value.status === "found") {
    if (prefix === null || asn === null) throw new LocalAgentError("invalid_response");
  } else if (prefix !== null || asn !== null || value.name !== "" || value.covers) {
    throw new LocalAgentError("invalid_response");
  }
  return {
    query: value.query,
    address: value.address,
    prefix,
    asn,
    name: value.name,
    status: value.status as AsnLookupResult["status"],
    covers: value.covers,
  };
}

const TLS_STATUSES = new Set(["ok", "refused", "timeout", "unreachable", "handshake_failed"]);
const TLS_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Rejects a TLS result the page cannot render. A chain is present only after a handshake. */
function asTlsInspect(value: unknown): TlsInspectResult {
  if (!isObject(value) || typeof value.host !== "string" || typeof value.address !== "string") {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.status !== "string" || !TLS_STATUSES.has(value.status)) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
    throw new LocalAgentError("invalid_response");
  }
  if (!Array.isArray(value.certificates) || value.certificates.length > 16) {
    throw new LocalAgentError("invalid_response");
  }
  const certificates = value.certificates.map(asTlsCertificate);
  const handshake = value.status === "ok";
  const protocol = asOptionalText(value.protocol);
  const cipher = asOptionalText(value.cipher);
  const trusted = typeof value.trusted === "boolean" ? value.trusted : null;
  if (handshake) {
    if (!protocol || !cipher || trusted === null || certificates.length === 0) {
      throw new LocalAgentError("invalid_response");
    }
  } else if (protocol !== null || cipher !== null || trusted !== null || certificates.length !== 0) {
    throw new LocalAgentError("invalid_response");
  }
  return {
    host: value.host,
    port: value.port,
    address: value.address,
    status: value.status as TlsInspectResult["status"],
    elapsedMs: value.elapsedMs,
    protocol,
    cipher,
    trusted,
    certificates,
  };
}

function asTlsCertificate(value: unknown): TlsCertificate {
  if (!isObject(value) || typeof value.subject !== "string" || typeof value.issuer !== "string") {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new LocalAgentError("invalid_response");
  }
  return {
    subject: value.subject,
    issuer: value.issuer,
    notBefore: asTlsTime(value.notBefore),
    notAfter: asTlsTime(value.notAfter),
    sha256: value.sha256,
  };
}

function asTlsTime(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !TLS_TIME.test(value)) throw new LocalAgentError("invalid_response");
  return value;
}

function asOptionalText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new LocalAgentError("invalid_response");
  return value;
}

const TCP_STATUSES = new Set(["open", "refused", "timeout", "unreachable"]);

/** Rejects a TCP result the page cannot render. */
function asTcpConnect(value: unknown): TcpConnectResult {
  if (!isObject(value) || typeof value.host !== "string" || typeof value.address !== "string") {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.status !== "string" || !TCP_STATUSES.has(value.status)) {
    throw new LocalAgentError("invalid_response");
  }
  if (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
    throw new LocalAgentError("invalid_response");
  }
  return {
    host: value.host,
    port: value.port,
    address: value.address,
    status: value.status as TcpConnectResult["status"],
    elapsedMs: value.elapsedMs,
  };
}

/** Rejects a snapshot the hop table cannot render. Optional hop fields become nulls. */
function asTraceSnapshot(value: unknown): TraceSnapshot {
  if (!isObject(value) || typeof value.id !== "string" || !Array.isArray(value.hops)) {
    throw new LocalAgentError("invalid_response");
  }
  if (value.state !== "tracing" && value.state !== "stopping" && value.state !== "idle") {
    throw new LocalAgentError("invalid_response");
  }
  const hops = value.hops.map((hop): TraceHopSnapshot => {
    if (!isObject(hop)) throw new LocalAgentError("invalid_response");
    return {
      hop: asCount(hop.hop),
      address: asNullableString(hop.address),
      name: asNullableString(hop.name),
      sent: asCount(hop.sent),
      received: asCount(hop.received),
      lossPercent: asCount(hop.lossPercent),
      lastMs: asNullableCount(hop.lastMs),
      bestMs: asNullableCount(hop.bestMs),
      avgMs: asNullableCount(hop.avgMs),
      worstMs: asNullableCount(hop.worstMs),
      stdevMs: asNullableCount(hop.stdevMs),
      jitterMs: asNullableCount(hop.jitterMs),
      status: asNullableString(hop.status),
    };
  });
  return {
    id: value.id,
    state: value.state,
    target: typeof value.target === "string" ? value.target : "",
    targetInput: typeof value.targetInput === "string" ? value.targetInput : "",
    sourceAddress: asNullableString(value.sourceAddress),
    sourceInterface: asNullableString(value.sourceInterface),
    hops,
  };
}

/** Splits a byte stream into JSON lines; a broken line or connection is a `network_error`. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (line: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!text.trim()) continue;
        let line: unknown;
        try {
          line = JSON.parse(text);
        } catch {
          throw new LocalAgentError("invalid_response");
        }
        if (isObject(line) && typeof line.type === "string") onLine(line);
      }
      if (done) return;
    }
  } catch (error) {
    if (error instanceof LocalAgentError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new LocalAgentError("network_error");
  } finally {
    reader.releaseLock();
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new LocalAgentError("invalid_response");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
