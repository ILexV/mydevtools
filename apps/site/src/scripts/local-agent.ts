const AGENT_BASE_URL = "http://127.0.0.1:48732";
const PROTOCOL_VERSION = 1;

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
 * Browser client for the versioned local companion protocol. Session tokens are
 * held only by this instance and are never written to browser storage.
 */
export class LocalAgentClient {
  #token: string | null = null;
  #info: LocalAgentInfo | null = null;
  #expiresAt: string | null = null;

  get connected(): boolean {
    return this.#token !== null;
  }

  get info(): LocalAgentInfo | null {
    return this.#info;
  }

  get expiresAt(): string | null {
    return this.#expiresAt;
  }

  async inspect(signal?: AbortSignal): Promise<LocalAgentInfo> {
    const info = await jsonRequest<LocalAgentInfo>("/v1/info", { method: "GET", signal });
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new LocalAgentError("incompatible_protocol");
    this.#info = info;
    return info;
  }

  async pair(
    code: string,
    capabilities: readonly LocalAgentCapability[],
    signal?: AbortSignal,
  ): Promise<LocalAgentInfo> {
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
    this.#token = paired.token;
    this.#expiresAt = paired.expiresAt;
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
  }

  async #authorized<T>(path: string, init: RequestInit): Promise<T> {
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
