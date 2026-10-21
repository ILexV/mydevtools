const STORAGE_KEY = "mdt.http-workspace.v1";
/** Where the workspace lives. Only the setting is kept here, never request data. */
const LOCATION_KEY = "mdt.http-workspace.location.v1";

export const HTTP_WORKSPACE_STORAGE_KEY = STORAGE_KEY;
export const HTTP_WORKSPACE_LOCATION_KEY = LOCATION_KEY;
export type HttpWorkspaceLocation = "browser" | "agent";

export interface HttpSavedRow {
  name: string;
  value: string;
  enabled: boolean;
}

/**
 * Request or folder authorization (Postman-style Auth tab). `inherit` takes the
 * nearest folder's auth; the root resolves to none. Fields accept `{{var}}`.
 */
export type HttpAuth =
  | { type: "inherit" }
  | { type: "none" }
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string }
  | { type: "apikey"; key: string; value: string; in: "header" | "query" }
  | { type: "oauth2"; tokenUrl: string; clientId: string; clientSecret: string; scope: string; clientAuth: "header" | "body" }
  | { type: "awsv4"; accessKey: string; secretKey: string; sessionToken: string; region: string; service: string };

export type HttpAuthType = HttpAuth["type"];

/** Named set of `{{var}}` values; the active one overrides folder and global variables. */
export interface HttpEnvironment {
  id: string;
  name: string;
  variables: HttpSavedRow[];
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
  /** Missing means inherit from the folder. */
  auth?: HttpAuth;
}

export interface HttpSavedFolder {
  id: string;
  name: string;
  parentId: string | null;
  expanded: boolean;
  /** Missing means inherit from the parent folder. */
  auth?: HttpAuth;
  /** Collection-level variables for requests inside this folder; nearer folders win. */
  variables?: HttpSavedRow[];
}

export interface HttpWorkspace {
  v: 1;
  selectedId: string;
  requests: HttpSavedRequest[];
  folders: HttpSavedFolder[];
  selectedFolderId: string | null;
  sidebarWidth: number;
  environments?: HttpEnvironment[];
  activeEnvironmentId?: string | null;
  globals?: HttpSavedRow[];
}

const STRING_FIELDS: Record<Exclude<HttpAuthType, "inherit" | "none">, readonly string[]> = {
  basic: ["username", "password"],
  bearer: ["token"],
  apikey: ["key", "value"],
  oauth2: ["tokenUrl", "clientId", "clientSecret", "scope"],
  awsv4: ["accessKey", "secretKey", "sessionToken", "region", "service"],
};

export function isHttpAuth(value: unknown): value is HttpAuth {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return false;
  if (value.type === "inherit" || value.type === "none") return true;
  const fields = STRING_FIELDS[value.type as keyof typeof STRING_FIELDS];
  if (!fields) return false;
  const record = value as Record<string, unknown>;
  if (!fields.every((field) => typeof record[field] === "string")) return false;
  if (value.type === "apikey") return record.in === "header" || record.in === "query";
  if (value.type === "oauth2") return record.clientAuth === "header" || record.clientAuth === "body";
  return true;
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
      || typeof folder.expanded !== "boolean"
      || ("auth" in folder && !isHttpAuth(folder.auth))
      || ("variables" in folder && !isRows(folder.variables))) return false;
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
      || typeof request.followRedirects !== "boolean" || !isRows(request.params) || !isRows(request.headers)
      || ("auth" in request && !isHttpAuth(request.auth))) return false;
    ids.add(request.id);
  }
  if ("globals" in value && !isRows(value.globals)) return false;
  const environmentIds = new Set<string>();
  if ("environments" in value) {
    if (!Array.isArray(value.environments)) return false;
    for (const environment of value.environments) {
      if (typeof environment !== "object" || environment === null || typeof environment.id !== "string" || !environment.id
        || environmentIds.has(environment.id) || typeof environment.name !== "string" || !isRows(environment.variables)) return false;
      environmentIds.add(environment.id);
    }
  }
  if ("activeEnvironmentId" in value && value.activeEnvironmentId !== null
    && (typeof value.activeEnvironmentId !== "string" || !environmentIds.has(value.activeEnvironmentId))) return false;
  return ids.has(value.selectedId);
}

/** Validates a workspace from any store; the deployed flat shape is upgraded in memory. */
export function parseHttpWorkspace(input: unknown): HttpWorkspace | null {
  let value = input;
  if (typeof value === "object" && value !== null && "v" in value && value.v === 1
    && !("folders" in value) && !("selectedFolderId" in value) && !("sidebarWidth" in value)
    && "requests" in value && Array.isArray(value.requests)) {
    value = { ...value, folders: [], selectedFolderId: null, sidebarWidth: 240,
      requests: value.requests.map((request: unknown) => typeof request === "object" && request !== null
        ? { ...request, folderId: null } : request) };
  }
  return isWorkspace(value) ? value : null;
}

export function isHttpWorkspace(value: unknown): value is HttpWorkspace {
  return isWorkspace(value);
}

/** Invalid or inaccessible data is reported, never silently replaced on load. */
export function loadHttpWorkspace(): { workspace: HttpWorkspace | null; error: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { workspace: null, error: false };
    // Loading never writes storage, including the in-memory upgrade.
    const workspace = parseHttpWorkspace(JSON.parse(raw));
    return workspace ? { workspace, error: false } : { workspace: null, error: true };
  } catch {
    return { workspace: null, error: true };
  }
}

/** Removes the browser copy once the agent has confirmed its own. */
export function removeHttpWorkspace(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function readHttpWorkspaceLocation(): HttpWorkspaceLocation {
  try {
    return localStorage.getItem(LOCATION_KEY) === "agent" ? "agent" : "browser";
  } catch {
    return "browser";
  }
}

export function writeHttpWorkspaceLocation(location: HttpWorkspaceLocation): void {
  try {
    if (location === "agent") localStorage.setItem(LOCATION_KEY, "agent");
    else localStorage.removeItem(LOCATION_KEY);
  } catch {
    // The setting only picks the store; the agent copy stays authoritative.
  }
}

/** True when both hold the same requests and folders; view state is ignored. */
export function sameHttpWorkspaceContent(left: HttpWorkspace, right: HttpWorkspace): boolean {
  return JSON.stringify([left.requests, left.folders, left.environments ?? [], left.globals ?? []])
    === JSON.stringify([right.requests, right.folders, right.environments ?? [], right.globals ?? []]);
}

/**
 * Moving to the agent when it already holds a workspace: the browser tree is
 * appended under a new root folder with fresh ids, so nothing on either side is lost.
 */
export function appendHttpWorkspace(
  target: HttpWorkspace, source: HttpWorkspace, folderName: string, newId: () => string,
): HttpWorkspace {
  const result: HttpWorkspace = structuredClone(target);
  const folderIds = new Map<string, string>(source.folders.map((folder) => [folder.id, newId()]));
  const importRoot = newId();
  result.folders.push({ id: importRoot, name: folderName, parentId: null, expanded: true });
  for (const folder of source.folders) {
    result.folders.push({ ...structuredClone(folder), id: folderIds.get(folder.id)!,
      parentId: folder.parentId === null ? importRoot : folderIds.get(folder.parentId)! });
  }
  for (const request of source.requests) {
    result.requests.push({ ...structuredClone(request), id: newId(),
      folderId: request.folderId === null ? importRoot : folderIds.get(request.folderId)! });
  }
  // Environments come along under fresh ids; a global keeps the target's value when both define it.
  if (source.environments?.length) {
    result.environments = [...(result.environments ?? []),
      ...source.environments.map((environment) => ({ ...structuredClone(environment), id: newId() }))];
  }
  if (source.globals?.length) {
    const globals = result.globals ?? [];
    for (const row of source.globals) {
      if (!globals.some((existing) => existing.name === row.name)) globals.push(structuredClone(row));
    }
    result.globals = globals;
  }
  return result;
}

/**
 * A save lost a revision race with another window: take the other window's
 * workspace and keep only this window's open request on top of it.
 */
export function mergeHttpWorkspaceConflict(
  remote: HttpWorkspace, local: HttpWorkspace, openRequestId: string,
): HttpWorkspace {
  const result: HttpWorkspace = structuredClone(remote);
  const open = local.requests.find((request) => request.id === openRequestId);
  if (!open) return result;
  const copy = structuredClone(open);
  if (copy.folderId !== null && !result.folders.some((folder) => folder.id === copy.folderId)) copy.folderId = null;
  const index = result.requests.findIndex((request) => request.id === openRequestId);
  if (index >= 0) result.requests[index] = copy;
  else result.requests.push(copy);
  result.selectedId = openRequestId;
  return result;
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

export type HttpWorkspaceItemKind = "request" | "folder";

/** Shared eligibility for drag targets and menu destinations; never mutates state. */
export function canMoveHttpWorkspaceItem(
  workspace: HttpWorkspace, kind: HttpWorkspaceItemKind, id: string, parentId: string | null,
): boolean {
  if (parentId !== null && !workspace.folders.some(folder => folder.id === parentId)) return false;
  if (kind === "request") {
    const request = workspace.requests.find(request => request.id === id);
    return request !== undefined && request.folderId !== parentId;
  }
  const source = workspace.folders.find(folder => folder.id === id);
  if (!source || source.parentId === parentId) return false;
  let ancestor = parentId;
  let remaining = workspace.folders.length;
  while (ancestor !== null) {
    if (ancestor === id || remaining-- === 0) return false;
    const folder = workspace.folders.find(folder => folder.id === ancestor);
    if (!folder) return false;
    ancestor = folder.parentId;
  }
  return true;
}

/** Change only the item's parent; moving a folder preserves its entire subtree. */
export function moveHttpWorkspaceItem(
  workspace: HttpWorkspace, kind: HttpWorkspaceItemKind, id: string, parentId: string | null,
): boolean {
  if (!canMoveHttpWorkspaceItem(workspace, kind, id, parentId)) return false;
  if (kind === "request") workspace.requests.find(request => request.id === id)!.folderId = parentId;
  else workspace.folders.find(folder => folder.id === id)!.parentId = parentId;
  return true;
}
