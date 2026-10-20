const STORAGE_KEY = "mdt.http-workspace.v1";

export interface HttpSavedRow {
  name: string;
  value: string;
  enabled: boolean;
}

export interface HttpSavedRequest {
  id: string;
  folderId: string | null;
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

export interface HttpSavedFolder {
  id: string;
  name: string;
  parentId: string | null;
  expanded: boolean;
}

export interface HttpWorkspace {
  v: 1;
  selectedId: string;
  requests: HttpSavedRequest[];
  folders: HttpSavedFolder[];
  selectedFolderId: string | null;
  sidebarWidth: number;
}

function isRows(value: unknown): value is HttpSavedRow[] {
  return Array.isArray(value) && value.every((row: unknown) => typeof row === "object" && row !== null
    && "name" in row && typeof row.name === "string" && "value" in row && typeof row.value === "string"
    && "enabled" in row && typeof row.enabled === "boolean");
}

function isWorkspace(value: unknown): value is HttpWorkspace {
  if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1
    || !("selectedId" in value) || typeof value.selectedId !== "string"
    || !("requests" in value) || !Array.isArray(value.requests) || !value.requests.length
    || !("folders" in value) || !Array.isArray(value.folders)
    || !("selectedFolderId" in value)
    || !("sidebarWidth" in value) || typeof value.sidebarWidth !== "number"
    || !Number.isFinite(value.sidebarWidth) || value.sidebarWidth < 192 || value.sidebarWidth > 480) return false;
  const parents = new Map<string, string | null>();
  for (const folder of value.folders) {
    if (typeof folder !== "object" || folder === null || typeof folder.id !== "string" || !folder.id
      || parents.has(folder.id) || typeof folder.name !== "string" || !folder.name.trim()
      || (folder.parentId !== null && typeof folder.parentId !== "string")
      || typeof folder.expanded !== "boolean") return false;
    parents.set(folder.id, folder.parentId);
  }
  const checked = new Set<string>();
  for (const id of parents.keys()) {
    const chain = new Set<string>();
    let current: string | null = id;
    while (current !== null && !checked.has(current)) {
      if (!parents.has(current) || chain.has(current)) return false;
      chain.add(current);
      current = parents.get(current)!;
    }
    for (const entry of chain) checked.add(entry);
  }
  if (value.selectedFolderId !== null
    && (typeof value.selectedFolderId !== "string" || !parents.has(value.selectedFolderId))) return false;
  const ids = new Set<string>();
  for (const request of value.requests) {
    if (typeof request !== "object" || request === null || typeof request.id !== "string" || !request.id || ids.has(request.id)
      || (request.folderId !== null && (typeof request.folderId !== "string" || !parents.has(request.folderId)))
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
    let value: unknown = JSON.parse(raw);
    // Upgrade the deployed flat workspace in memory; loading never writes storage.
    if (typeof value === "object" && value !== null && "v" in value && value.v === 1
      && !("folders" in value) && !("selectedFolderId" in value) && !("sidebarWidth" in value)
      && "requests" in value && Array.isArray(value.requests)) {
      value = { ...value, folders: [], selectedFolderId: null, sidebarWidth: 240,
        requests: value.requests.map((request: unknown) => typeof request === "object" && request !== null
          ? { ...request, folderId: null } : request) };
    }
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
