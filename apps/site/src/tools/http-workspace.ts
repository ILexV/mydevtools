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

/** Body kinds of the Body tab, named after Postman's modes; a save without one is raw. */
export type HttpBodyMode = "none" | "raw" | "urlencoded" | "formdata" | "binary" | "graphql";

/**
 * A file picked for a form-data field or a binary body. Only this description is
 * saved: the bytes stay in page memory and must be chosen again after a reload.
 */
export interface HttpFileRef {
  id: string;
  name: string;
  size: number;
  type: string;
}

/** form-data field: text, or a file (null until one is picked). */
export interface HttpFormDataRow extends HttpSavedRow {
  kind: "text" | "file";
  file?: HttpFileRef | null;
}

/** Postman-style scripts: `pre` runs before sending, `test` after the response. */
export interface HttpScripts {
  pre: string;
  test: string;
}

/** A saved response (Postman "example"): text bodies only, to keep the workspace small. */
export interface HttpExample {
  id: string;
  name: string;
  /** Epoch ms. */
  savedAt: number;
  status: number;
  statusText: string;
  headers: { name: string; value: string }[];
  body: string;
}

/** Longer example bodies are not saved. */
export const HTTP_EXAMPLE_MAX_CHARS = 256 * 1024;
export const HTTP_EXAMPLES_PER_REQUEST = 20;

/** Postman's per-request "HTTP version" setting; `auto` negotiates h2 or HTTP/1.1. */
export type HttpVersionChoice = "auto" | "http1" | "http2";
export const HTTP_VERSION_CHOICES: readonly HttpVersionChoice[] = ["auto", "http1", "http2"];

/**
 * Workspace-wide HTTP proxy the agent connects through (`http://host:port`).
 * `bypass` is a comma list of hosts and `*.domain` patterns sent directly.
 */
export interface HttpProxySettings {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  bypass: string;
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
  /** Missing means raw (`body` with `bodyFormat`); the other modes keep their own fields. */
  bodyMode?: HttpBodyMode;
  urlencoded?: HttpSavedRow[];
  formdata?: HttpFormDataRow[];
  binary?: HttpFileRef | null;
  graphql?: { query: string; variables: string };
  scripts?: HttpScripts;
  examples?: HttpExample[];
  /** Missing means on: the agent checks the server certificate. */
  verifyTls?: boolean;
  /** Missing means auto. */
  httpVersion?: HttpVersionChoice;
  /** Missing means on: the request sends and updates the cookie jar. */
  useCookies?: boolean;
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
  /** Run for every request inside, root folders first. */
  scripts?: HttpScripts;
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
  /** Open request tabs in order; ids that no longer exist are ignored. */
  openIds?: string[];
  proxy?: HttpProxySettings;
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

function isScripts(value: unknown): value is HttpScripts {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).pre === "string"
    && typeof (value as Record<string, unknown>).test === "string";
}

function isExample(value: unknown): value is HttpExample {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && !!record.id && typeof record.name === "string" && typeof record.body === "string"
    && typeof record.savedAt === "number" && Number.isFinite(record.savedAt)
    && typeof record.status === "number" && Number.isInteger(record.status) && typeof record.statusText === "string"
    && Array.isArray(record.headers) && record.headers.every((header: unknown) => typeof header === "object" && header !== null
      && typeof (header as Record<string, unknown>).name === "string" && typeof (header as Record<string, unknown>).value === "string");
}

function isFileRef(value: unknown): value is HttpFileRef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && !!record.id && typeof record.name === "string" && typeof record.type === "string"
    && typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0;
}

const BODY_MODES: readonly string[] = ["none", "raw", "urlencoded", "formdata", "binary", "graphql"];

function hasValidBody(request: Record<string, unknown>): boolean {
  if ("bodyMode" in request && (typeof request.bodyMode !== "string" || !BODY_MODES.includes(request.bodyMode))) return false;
  if ("urlencoded" in request && !isRows(request.urlencoded)) return false;
  if ("formdata" in request && !(isRows(request.formdata) && request.formdata.every((row) => {
    const field = row as unknown as Record<string, unknown>;
    return (field.kind === "text" || field.kind === "file")
      && (!("file" in field) || field.file === null || isFileRef(field.file));
  }))) return false;
  if ("binary" in request && request.binary !== null && !isFileRef(request.binary)) return false;
  if ("graphql" in request) {
    const graphql = request.graphql as Record<string, unknown> | null;
    if (typeof graphql !== "object" || graphql === null
      || typeof graphql.query !== "string" || typeof graphql.variables !== "string") return false;
  }
  return true;
}

function isProxy(value: unknown): value is HttpProxySettings {
  if (typeof value !== "object" || value === null) return false;
  const proxy = value as Record<string, unknown>;
  return typeof proxy.enabled === "boolean"
    && ["url", "username", "password", "bypass"].every((key) => typeof proxy[key] === "string");
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
      || ("variables" in folder && !isRows(folder.variables))
      || ("scripts" in folder && !isScripts(folder.scripts))) return false;
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
      || ("auth" in request && !isHttpAuth(request.auth)) || !hasValidBody(request)
      || ("scripts" in request && !isScripts(request.scripts))
      || ("examples" in request && !(Array.isArray(request.examples) && request.examples.every(isExample)))
      || ("verifyTls" in request && typeof request.verifyTls !== "boolean")
      || ("useCookies" in request && typeof request.useCookies !== "boolean")
      || ("httpVersion" in request && !HTTP_VERSION_CHOICES.includes(request.httpVersion))) return false;
    ids.add(request.id);
  }
  if ("globals" in value && !isRows(value.globals)) return false;
  if ("proxy" in value && !isProxy(value.proxy)) return false;
  if ("openIds" in value && !(Array.isArray(value.openIds) && value.openIds.every((id: unknown) => typeof id === "string"))) return false;
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
  return JSON.stringify([left.requests, left.folders, left.environments ?? [], left.globals ?? [], left.proxy ?? null])
    === JSON.stringify([right.requests, right.folders, right.environments ?? [], right.globals ?? [], right.proxy ?? null]);
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
  // Tabs are this window's layout, not shared content.
  if (local.openIds) result.openIds = [...local.openIds];
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
