const AGENT_BASE_URL = "http://127.0.0.1:48732";
const PROTOCOL_VERSION = 1;
const SESSION_STORAGE_KEY = "mdt.local-agent.session.v1";
const SESSION_STORAGE_VERSION = 1;


export type LocalAgentCapability = "http.request";

export interface LocalAgentInfo {
  protocolVersion: number;
  version: string;
  capabilities: LocalAgentCapability[];
  privateNetworkAllowed: boolean;
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
}

export interface LocalHttpResponse {
  status: number;
  statusText: string;
  url: string;
  headers: LocalAgentHeader[];
  bodyBase64: string;
  elapsedMs: number;
}

interface PairResponse {
  token: string;
  capabilities: LocalAgentCapability[];
  expiresAt: string;
}
interface StoredSession {
  v: typeof SESSION_STORAGE_VERSION;
  token: string;
  expiresAt: string;
}

export type LocalAgentStorageState = "unknown" | "available" | "unavailable";


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
    this.#writeStoredSession({ v: SESSION_STORAGE_VERSION, token: paired.token, expiresAt: paired.expiresAt });
    return info;
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

  async cancel(id: string): Promise<void> {
    await this.#authorized<void>("/v1/http/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  clear(): void {
    this.#token = null;
    this.#expiresAt = null;
    this.#info = null;
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
