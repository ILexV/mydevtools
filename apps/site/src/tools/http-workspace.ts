const STORAGE_KEY = "mdt.http-workspace.v1";

export interface HttpSavedRow {
  name: string;
  value: string;
  enabled: boolean;
}

export interface HttpSavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  params: HttpSavedRow[];
  headers: HttpSavedRow[];
  body: string;
  bodyFormat: "text" | "json" | "html" | "xml";
  timeoutMs: number;
  followRedirects: boolean;
}

export interface HttpWorkspace {
  v: 1;
  selectedId: string;
  requests: HttpSavedRequest[];
}

function isRows(value: unknown): value is HttpSavedRow[] {
  return Array.isArray(value) && value.every((row: unknown) => typeof row === "object" && row !== null
    && "name" in row && typeof row.name === "string" && "value" in row && typeof row.value === "string"
    && "enabled" in row && typeof row.enabled === "boolean");
}

function isWorkspace(value: unknown): value is HttpWorkspace {
  if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1
    || !("selectedId" in value) || typeof value.selectedId !== "string"
    || !("requests" in value) || !Array.isArray(value.requests) || !value.requests.length) return false;
  const ids = new Set<string>();
  for (const request of value.requests) {
    if (typeof request !== "object" || request === null || typeof request.id !== "string" || !request.id || ids.has(request.id)
      || typeof request.name !== "string" || typeof request.url !== "string" || typeof request.body !== "string"
      || typeof request.method !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method)
      || typeof request.bodyFormat !== "string" || !["text", "json", "html", "xml"].includes(request.bodyFormat)
      || typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs)
      || typeof request.followRedirects !== "boolean" || !isRows(request.params) || !isRows(request.headers)) return false;
    ids.add(request.id);
  }
  return ids.has(value.selectedId);
}

/** Invalid or inaccessible data is reported, never silently replaced on load. */
export function loadHttpWorkspace(): { workspace: HttpWorkspace | null; error: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { workspace: null, error: false };
    const value: unknown = JSON.parse(raw);
    return isWorkspace(value) ? { workspace: value, error: false } : { workspace: null, error: true };
  } catch {
    return { workspace: null, error: true };
  }
}

/** A single atomic write retains the previous workspace if quota is exhausted. */
export function saveHttpWorkspace(workspace: HttpWorkspace): boolean {
  try {
    if (!isWorkspace(workspace)) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    return true;
  } catch {
    return false;
  }
}
