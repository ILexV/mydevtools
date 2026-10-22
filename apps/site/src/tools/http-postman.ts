import { effectiveAuth } from "./http-auth.ts";
import { paramsFromUrl } from "./http-curl.ts";
import { collectVariables, folderChain } from "./http-variables.ts";
import type {
  HttpAuth, HttpEnvironment, HttpFormDataRow, HttpSavedFolder, HttpScripts, HttpSavedRequest, HttpSavedRow, HttpWorkspace,
} from "./http-workspace.ts";

/**
 * Postman Collection v2.1 (and v2.0) import and export for the HTTP client, plus
 * Postman environment files on import. Folders, requests, query, headers, all
 * body modes, folder auth, collection variables and pre-request/test scripts carry
 * over; examples and auth types the client lacks are reported, never guessed.
 */
export const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

export class PostmanError extends Error {
  readonly code: "format" | "version";
  constructor(code: PostmanError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface PostmanImport {
  folders: HttpSavedFolder[];
  requests: HttpSavedRequest[];
  environments: HttpEnvironment[];
  /** Items whose scripts call what the script sandbox lacks (pm.sendRequest, require, …). */
  scripts: number;
  /** Auth types, OAuth grants and methods the client does not have; replaced by none or GET. */
  unsupported: string[];
  /** Files referenced by form-data rows and binary bodies; they must be picked again. */
  files: string[];
}

type Json = Record<string, unknown>;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
/** Script features the sandbox does not provide: no network, no modules, no cookie jar. */
const UNSUPPORTED_SCRIPT = /\bpm\.(?:sendRequest|cookies|vault|visualizer|require)\b|\brequire\s*\(|\bCryptoJS\b|\bxml2Json\b|\bcheerio\b/u;

function exportEvents(scripts: HttpScripts | undefined): Json[] | undefined {
  const events = (["pre", "test"] as const).filter((key) => scripts?.[key].trim()).map((key) => ({
    listen: key === "pre" ? "prerequest" : "test", script: { type: "text/javascript", exec: scripts![key].split("\n") },
  }));
  return events.length ? events : undefined;
}

function rows(value: unknown, enabledKey: "disabled" | "enabled" = "disabled"): HttpSavedRow[] {
  return list(value).filter(isObject).map((row) => ({
    name: text(row.key), value: text(row.value),
    enabled: enabledKey === "disabled" ? row.disabled !== true : row.enabled !== false,
  })).filter((row) => row.name || row.value);
}

/** v2.1 keeps auth parameters as `[{key, value}]`, v2.0 as an object. */
function authParams(auth: Json, type: string): Map<string, string> {
  const raw = auth[type];
  const params = new Map<string, string>();
  if (Array.isArray(raw)) for (const entry of raw.filter(isObject)) params.set(text(entry.key), text(entry.value));
  else if (isObject(raw)) for (const [key, value] of Object.entries(raw)) params.set(key, text(value));
  return params;
}

function importAuth(value: unknown, unsupported: Set<string>): HttpAuth | undefined {
  if (!isObject(value)) return undefined;
  const type = text(value.type);
  const params = authParams(value, type);
  const get = (key: string): string => params.get(key) ?? "";
  switch (type) {
    case "noauth": return { type: "none" };
    case "inherit": case "": return undefined;
    case "basic": return { type: "basic", username: get("username"), password: get("password") };
    case "bearer": return { type: "bearer", token: get("token") };
    case "apikey": return { type: "apikey", key: get("key"), value: get("value"), in: get("in") === "query" ? "query" : "header" };
    case "awsv4": return { type: "awsv4", accessKey: get("accessKey"), secretKey: get("secretKey"), sessionToken: get("sessionToken"),
      region: get("region"), service: get("service") };
    case "oauth2": {
      const grant = get("grant_type") || "authorization_code";
      if (grant !== "client_credentials") {
        unsupported.add(`OAuth 2.0 ${grant}`);
        return { type: "none" };
      }
      return { type: "oauth2", tokenUrl: get("accessTokenUrl"), clientId: get("clientId"), clientSecret: get("clientSecret"),
        scope: get("scope"), clientAuth: get("client_authentication") === "body" ? "body" : "header" };
    }
    default:
      unsupported.add(type);
      return { type: "none" };
  }
}

function importUrl(value: unknown): { url: string; params: HttpSavedRow[] } {
  if (!isObject(value)) {
    const url = text(value);
    return { url, params: paramsFromUrl(url) };
  }
  let url = text(value.raw);
  if (!url) {
    const host = Array.isArray(value.host) ? value.host.map(text).join(".") : text(value.host);
    const path = Array.isArray(value.path) ? value.path.map(text).join("/") : text(value.path);
    const protocol = text(value.protocol);
    url = `${protocol ? `${protocol}://` : ""}${host}${value.port ? `:${text(value.port)}` : ""}${path ? `/${path.replace(/^\//u, "")}` : ""}`;
  }
  const query = rows(value.query);
  if (!query.length) return { url, params: paramsFromUrl(url) };
  // The query array also keeps disabled parameters that the raw URL leaves out.
  const enabled = query.filter((row) => row.enabled).map((row) => `${row.name}=${row.value}`).join("&");
  const base = url.split(/[?#]/u, 1)[0]!;
  const fragment = url.includes("#") ? url.slice(url.indexOf("#")) : "";
  return { url: `${base}${enabled ? `?${enabled}` : ""}${fragment}`, params: query };
}

function blankRequest(id: string, folderId: string | null): HttpSavedRequest {
  return { id, folderId, name: "", method: "GET", url: "", params: [], headers: [], body: "", bodyFormat: "text",
    bodyMode: "none", timeoutMs: 30000, followRedirects: false };
}

const LANGUAGES: Record<string, HttpSavedRequest["bodyFormat"]> = { json: "json", xml: "xml", html: "html", text: "text", javascript: "text" };

function importBody(request: HttpSavedRequest, value: unknown, files: string[]): void {
  if (!isObject(value) || value.disabled === true) return;
  switch (text(value.mode)) {
    case "raw": {
      request.bodyMode = "raw";
      request.body = text(value.raw);
      const options = isObject(value.options) && isObject(value.options.raw) ? value.options.raw : {};
      request.bodyFormat = LANGUAGES[text(options.language)] ?? "text";
      break;
    }
    case "urlencoded":
      request.bodyMode = "urlencoded";
      request.urlencoded = rows(value.urlencoded);
      break;
    case "formdata":
      request.bodyMode = "formdata";
      request.formdata = list(value.formdata).filter(isObject).map((row): HttpFormDataRow => {
        const enabled = row.disabled !== true;
        if (row.type === "file") {
          const sources = Array.isArray(row.src) ? row.src.map(text) : [text(row.src)];
          files.push(...sources.filter(Boolean));
          return { name: text(row.key), value: "", enabled, kind: "file", file: null };
        }
        return { name: text(row.key), value: text(row.value), enabled, kind: "text" };
      });
      break;
    case "file": {
      request.bodyMode = "binary";
      request.binary = null;
      const source = isObject(value.file) ? text(value.file.src) : "";
      if (source) files.push(source);
      break;
    }
    case "graphql": {
      const graphql = isObject(value.graphql) ? value.graphql : {};
      request.bodyMode = "graphql";
      request.graphql = { query: text(graphql.query), variables: text(graphql.variables) };
      break;
    }
  }
}

/**
 * Converts a Postman collection or environment file into workspace entries.
 * The collection becomes one folder under `parentId` holding its auth and variables.
 */
export function importPostman(input: unknown, parentId: string | null, newId: () => string, fallbackName: string): PostmanImport {
  if (!isObject(input)) throw new PostmanError("format");
  const result: PostmanImport = { folders: [], requests: [], environments: [], scripts: 0, unsupported: [], files: [] };
  if (Array.isArray(input.values) && (input._postman_variable_scope === "environment" || typeof input.name === "string") && !("item" in input)) {
    result.environments.push({ id: newId(), name: text(input.name) || fallbackName, variables: rows(input.values, "enabled") });
    return result;
  }
  const info = isObject(input.info) ? input.info : null;
  if (!info || !Array.isArray(input.item)) {
    throw new PostmanError(Array.isArray(input.requests) || Array.isArray(input.order) ? "version" : "format");
  }
  const schema = text(info.schema);
  if (schema && !/collection\/v2\.[01]/u.test(schema)) throw new PostmanError("version");
  const unsupported = new Set<string>();
  const scriptsOf = (item: Json): HttpScripts | undefined => {
    const scripts: HttpScripts = { pre: "", test: "" };
    for (const event of list(item.event).filter(isObject)) {
      const script = isObject(event.script) ? event.script : null;
      const code = (Array.isArray(script?.exec) ? script.exec.map(text) : [text(script?.exec)]).join("\n");
      if (event.listen === "prerequest") scripts.pre = code;
      else if (event.listen === "test") scripts.test = code;
    }
    if (UNSUPPORTED_SCRIPT.test(`${scripts.pre}\n${scripts.test}`)) result.scripts++;
    return scripts.pre.trim() || scripts.test.trim() ? scripts : undefined;
  };

  const folder = (item: Json, parent: string | null): string => {
    const id = newId();
    const entry: HttpSavedFolder = { id, name: text(item.name).trim() || text(info.name).trim() || fallbackName, parentId: parent, expanded: parent === parentId };
    const auth = importAuth(item.auth, unsupported);
    if (auth) entry.auth = auth;
    const variables = rows(item.variable);
    if (variables.length) entry.variables = variables;
    const scripts = scriptsOf(item);
    if (scripts) entry.scripts = scripts;
    result.folders.push(entry);
    for (const child of list(item.item).filter(isObject)) {
      if (Array.isArray(child.item)) folder(child, id);
      else request(child, id);
    }
    return id;
  };

  const request = (item: Json, folderId: string): void => {
    const source = isObject(item.request) ? item.request : { url: text(item.request) };
    const entry = blankRequest(newId(), folderId);
    entry.name = text(item.name);
    const method = text(source.method).toUpperCase() || "GET";
    if (METHODS.includes(method)) entry.method = method;
    else unsupported.add(method);
    const { url, params } = importUrl(source.url);
    entry.url = url;
    entry.params = params;
    entry.headers = rows(source.header);
    importBody(entry, source.body, result.files);
    const auth = importAuth(source.auth, unsupported);
    if (auth) entry.auth = auth;
    const behavior = isObject(item.protocolProfileBehavior) ? item.protocolProfileBehavior : {};
    // Postman follows redirects unless told otherwise.
    entry.followRedirects = behavior.followRedirects !== false;
    const scripts = scriptsOf(item);
    if (scripts) entry.scripts = scripts;
    result.requests.push(entry);
  };

  folder({ ...input, name: info.name }, parentId);
  result.unsupported = [...unsupported];
  return result;
}

const auth21 = (type: string, values: Record<string, string>): Json => ({
  type, [type]: Object.entries(values).map(([key, value]) => ({ key, value, type: "string" })),
});

function exportAuth(auth: HttpAuth | undefined): Json | undefined {
  if (!auth || auth.type === "inherit") return undefined;
  switch (auth.type) {
    case "none": return { type: "noauth" };
    case "basic": return auth21("basic", { username: auth.username, password: auth.password });
    case "bearer": return auth21("bearer", { token: auth.token });
    case "apikey": return auth21("apikey", { key: auth.key, value: auth.value, in: auth.in });
    case "oauth2": return auth21("oauth2", { grant_type: "client_credentials", accessTokenUrl: auth.tokenUrl, clientId: auth.clientId,
      clientSecret: auth.clientSecret, scope: auth.scope, client_authentication: auth.clientAuth });
    case "awsv4": return auth21("awsv4", { accessKey: auth.accessKey, secretKey: auth.secretKey, sessionToken: auth.sessionToken,
      region: auth.region, service: auth.service });
  }
}

const exportRows = (values: readonly HttpSavedRow[]): Json[] =>
  values.map((row) => ({ key: row.name, value: row.value, ...(row.enabled ? {} : { disabled: true }) }));

/** Postman's structured URL; `{{baseUrl}}` without a scheme stays the host. */
function exportUrl(raw: string, params: readonly HttpSavedRow[]): Json {
  const url: Json = { raw };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(raw);
  const rest = scheme ? raw.slice(scheme[0].length) : raw;
  const [authority = "", ...pathParts] = rest.split(/[?#]/u, 1)[0]!.split("/");
  if (scheme) url.protocol = scheme[1];
  const port = /:(\d+)$/u.exec(authority);
  url.host = (port ? authority.slice(0, port.index) : authority).split(".").filter(Boolean);
  if (port) url.port = port[1];
  if (pathParts.length) url.path = pathParts;
  if (params.length) url.query = exportRows(params);
  return url;
}

function exportBody(request: HttpSavedRequest): Json | undefined {
  switch (request.bodyMode ?? "raw") {
    case "raw": return request.body ? { mode: "raw", raw: request.body, options: { raw: { language: request.bodyFormat } } } : undefined;
    case "urlencoded": return { mode: "urlencoded", urlencoded: exportRows(request.urlencoded ?? []) };
    case "formdata": return { mode: "formdata", formdata: (request.formdata ?? []).map((row) => ({
      key: row.name, ...(row.kind === "file" ? { type: "file", src: row.file?.name ?? "" } : { value: row.value, type: "text" }),
      ...(row.enabled ? {} : { disabled: true }),
    })) };
    case "binary": return { mode: "file", file: { src: request.binary?.name ?? "" } };
    case "graphql": return { mode: "graphql", graphql: { query: request.graphql?.query ?? "", variables: request.graphql?.variables ?? "" } };
    default: return undefined;
  }
}

function exportRequest(request: HttpSavedRequest): Json {
  const body = exportBody(request);
  const auth = exportAuth(request.auth);
  const event = exportEvents(request.scripts);
  return {
    name: request.name || request.url || "Request",
    ...(event ? { event } : {}),
    ...(request.followRedirects ? {} : { protocolProfileBehavior: { followRedirects: false } }),
    request: {
      method: request.method,
      header: exportRows(request.headers),
      ...(body ? { body } : {}),
      url: exportUrl(request.url, request.params),
      ...(auth ? { auth } : {}),
    },
    response: [],
  };
}

/**
 * Exports a folder (or the whole tree with `folderId` null) as a v2.1 collection.
 * A folder that inherits gets the auth and variables of its ancestors, so its
 * requests behave the same outside this workspace. Global variables are not included.
 */
export function exportPostman(workspace: HttpWorkspace, folderId: string | null, name: string, id: string): Json {
  const items = (parent: string | null): Json[] => [
    ...workspace.folders.filter((entry) => entry.parentId === parent).map((entry) => {
      const auth = exportAuth(entry.auth);
      const event = exportEvents(entry.scripts);
      return {
        name: entry.name,
        item: items(entry.id),
        ...(auth ? { auth } : {}),
        ...(event ? { event } : {}),
        ...(entry.variables?.length ? { variable: exportRows(entry.variables) } : {}),
      };
    }),
    ...workspace.requests.filter((entry) => entry.folderId === parent).map(exportRequest),
  ];
  const collection: Json = { info: { _postman_id: id, name, schema: POSTMAN_SCHEMA }, item: items(folderId) };
  if (folderId !== null) {
    const auth = exportAuth(effectiveAuth(workspace, { folderId }).auth);
    if (auth && auth.type !== "noauth") collection.auth = auth;
    // The environment is left out on purpose: only this folder's chain of collection variables.
    const scope = collectVariables({ ...workspace, environments: [], activeEnvironmentId: null, globals: [] }, folderId);
    if (scope.size) collection.variable = [...scope].map(([key, value]) => ({ key, value }));
    // The folder's own scripts and those above it run for its requests: they become collection scripts.
    const chain = folderChain(workspace, folderId).map((chainId) => workspace.folders.find((entry) => entry.id === chainId)?.scripts);
    const joined = (key: keyof HttpScripts) => chain.map((scripts) => scripts?.[key] ?? "").filter((code) => code.trim()).join("\n");
    const event = exportEvents({ pre: joined("pre"), test: joined("test") });
    if (event) collection.event = event;
  }
  return collection;
}
