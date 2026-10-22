import type { LocalHttpResponse } from "../scripts/local-agent.ts";
import { effectiveAuth, type BuildInput, type BuiltRequest } from "./http-auth.ts";
import { isTextContentType, textDecoderFor } from "./http-response.ts";
import type {
  ScriptEvent, ScriptJob, ScriptLog, ScriptOutcome, ScriptRequest, ScriptTestResult, VariableOp,
} from "./http-script-runtime.ts";
import { collectVariables, folderChain } from "./http-variables.ts";
import type { HttpSavedRequest, HttpSavedRow, HttpWorkspace } from "./http-workspace.ts";

/**
 * One request run of the HTTP client, shared by Send and the Collection Runner:
 * pre-request scripts (folders from the root, then the request), variable
 * changes written back to the workspace, build, send, then test scripts.
 */
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/** Larger text bodies reach scripts cut to this many characters. */
export const SCRIPT_BODY_LIMIT = 8 * 1024 * 1024;

const enabledRows = (rows: readonly HttpSavedRow[] | undefined): [string, string][] =>
  (rows ?? []).filter((row) => row.enabled && row.name.trim()).map((row) => [row.name.trim(), row.value]);

/** Non-empty scripts of one event in run order, labelled for error messages. */
export function scriptChain(workspace: HttpWorkspace, request: HttpSavedRequest, event: ScriptEvent): { label: string; code: string }[] {
  const key = event === "prerequest" ? "pre" : "test";
  const chain: { label: string; code: string }[] = [];
  for (const id of folderChain(workspace, request.folderId)) {
    const folder = workspace.folders.find((entry) => entry.id === id)!;
    if (folder.scripts?.[key].trim()) chain.push({ label: folder.name, code: folder.scripts[key] });
  }
  if (request.scripts?.[key].trim()) chain.push({ label: request.name || request.url, code: request.scripts[key] });
  return chain;
}

/**
 * Variable names the request's scripts (and its folders') assign with a literal
 * name, such as `pm.environment.set("token", …)`: they are not reported as unset.
 */
export function scriptAssignedNames(workspace: HttpWorkspace, request: HttpSavedRequest): Set<string> {
  const names = new Set<string>();
  for (const event of ["prerequest", "test"] as const) {
    for (const { code } of scriptChain(workspace, request, event)) {
      for (const match of code.matchAll(/\.set(?:EnvironmentVariable|GlobalVariable)?\(\s*(['"`])([^'"`$]+)\1/gu)) names.add(match[2]!.trim());
    }
  }
  return names;
}

/** True when the request or a folder above it has a script for either event. */
export function hasScripts(workspace: HttpWorkspace, request: HttpSavedRequest): boolean {
  return scriptChain(workspace, request, "prerequest").length > 0 || scriptChain(workspace, request, "test").length > 0;
}

/** The variable stores a script sees: globals, folder variables merged from the root, the active environment. */
export function scriptVariables(workspace: HttpWorkspace, folderId: string | null): Pick<ScriptJob, "globals" | "collection" | "environment" | "environmentName"> {
  const collection = new Map<string, string>();
  for (const id of folderChain(workspace, folderId)) {
    for (const [name, value] of enabledRows(workspace.folders.find((folder) => folder.id === id)?.variables)) collection.set(name, value);
  }
  const environment = workspace.environments?.find((entry) => entry.id === workspace.activeEnvironmentId);
  return {
    globals: enabledRows(workspace.globals),
    collection: [...collection],
    environment: environment ? enabledRows(environment.variables) : null,
    environmentName: environment?.name ?? "",
  };
}

function setRow(rows: HttpSavedRow[], name: string, value: string): void {
  const row = rows.find((entry) => entry.name.trim() === name);
  if (row) {
    row.value = value;
    row.enabled = true;
  } else {
    rows.push({ name, value, enabled: true });
  }
}

const removeRows = (rows: HttpSavedRow[], name: string): HttpSavedRow[] => rows.filter((row) => row.name.trim() !== name);

/**
 * Writes `pm.environment`, `pm.globals` and `pm.collectionVariables` changes into
 * the workspace. A collection variable goes to the nearest folder that defines it,
 * else to the request's root folder; a request outside folders has none.
 */
export function applyVariableOps(workspace: HttpWorkspace, folderId: string | null, ops: readonly VariableOp[]): { changed: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let changed = false;
  const chain = folderChain(workspace, folderId).map((id) => workspace.folders.find((folder) => folder.id === id)!);
  const environment = workspace.environments?.find((entry) => entry.id === workspace.activeEnvironmentId);
  for (const op of ops) {
    if (op.scope === "environment") {
      if (!environment) continue;
      environment.variables = op.op === "clear" ? [] : op.op === "unset" ? removeRows(environment.variables, op.name) : environment.variables;
      if (op.op === "set") setRow(environment.variables, op.name, op.value);
    } else if (op.scope === "globals") {
      const globals = workspace.globals ?? [];
      workspace.globals = op.op === "clear" ? [] : op.op === "unset" ? removeRows(globals, op.name) : globals;
      if (op.op === "set") setRow(workspace.globals, op.name, op.value);
    } else {
      if (!chain.length) {
        warnings.push(`pm.collectionVariables: the request is not in a folder, ${op.op === "clear" ? "clear" : `"${op.name}"`} is not saved`);
        continue;
      }
      if (op.op === "set") {
        const owner = [...chain].reverse().find((folder) => folder.variables?.some((row) => row.enabled && row.name.trim() === op.name)) ?? chain[0]!;
        owner.variables ??= [];
        setRow(owner.variables, op.name, op.value);
      } else if (op.op === "unset") {
        for (const folder of chain) if (folder.variables) folder.variables = removeRows(folder.variables, op.name);
      } else {
        chain[0]!.variables = [];
      }
    }
    changed = true;
  }
  return { changed, warnings };
}

/** What scripts see of a saved request: enabled headers, and the body only in raw mode. */
export function scriptRequest(request: HttpSavedRequest): ScriptRequest {
  return {
    name: request.name,
    method: request.method,
    url: request.url,
    headers: request.headers.filter((row) => row.enabled && (row.name || row.value)).map(({ name, value }) => ({ name, value })),
    body: (request.bodyMode ?? "raw") === "raw" ? request.body : null,
  };
}

/** The request as a pre-request script left it; an unknown method keeps the original. */
export function applyScriptRequest(request: HttpSavedRequest, changed: ScriptRequest): HttpSavedRequest {
  const method = changed.method.toUpperCase();
  return {
    ...request,
    method: METHODS.includes(method) ? method : request.method,
    url: changed.url,
    headers: changed.headers.map(({ name, value }) => ({ name, value, enabled: true })),
    ...(changed.body !== null && (request.bodyMode ?? "raw") === "raw" ? { body: changed.body } : {}),
  };
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The builder input for a saved request with a variable scope. */
export function buildInputFor(workspace: HttpWorkspace, request: HttpSavedRequest, scope: Map<string, string>): BuildInput {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers.filter((row) => row.enabled && (row.name || row.value)).map(({ name, value }) => ({ name, value })),
    body: request.body,
    bodyFormat: request.bodyFormat,
    bodyMode: request.bodyMode,
    urlencoded: request.urlencoded,
    formdata: request.formdata,
    binary: request.binary,
    graphql: request.graphql,
    auth: effectiveAuth(workspace, request).auth,
    scope,
  };
}

export interface RunDeps {
  runScripts(job: ScriptJob): Promise<ScriptOutcome>;
  /** Adds file and token access to the input and builds it. */
  build(input: BuildInput): Promise<BuiltRequest>;
  send(built: BuiltRequest, request: HttpSavedRequest): Promise<LocalHttpResponse>;
}

export interface RunOptions {
  iteration?: number;
  iterationCount?: number;
  iterationData?: [string, unknown][];
}

export interface RequestRun {
  /** The request as sent, after pre-request changes. */
  request: HttpSavedRequest;
  built: BuiltRequest | null;
  response: LocalHttpResponse | null;
  tests: ScriptTestResult[];
  logs: ScriptLog[];
  scriptError: { event: ScriptEvent; script: string; message: string } | null;
  /** `pm.execution.skipRequest()` was called. */
  skipped: boolean;
  nextRequest?: string | null;
  /** Variables were written to the workspace; the caller saves it. */
  variablesChanged: boolean;
}

const dataText = (value: unknown): string => typeof value === "string" ? value
  : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");

/**
 * Runs one request. Build and send errors are thrown as they are; a script error
 * is returned (a pre-request one stops before sending, like Postman).
 */
export async function runHttpRequest(
  workspace: HttpWorkspace, saved: HttpSavedRequest, deps: RunDeps, options: RunOptions = {},
): Promise<RequestRun> {
  const run: RequestRun = { request: saved, built: null, response: null, tests: [], logs: [], scriptError: null, skipped: false, variablesChanged: false };
  let locals: [string, string][] = [];
  const job = (event: ScriptEvent, scripts: ScriptJob["scripts"], request: HttpSavedRequest): ScriptJob => ({
    event, scripts, ...scriptVariables(workspace, request.folderId), locals,
    iterationData: options.iterationData ?? [],
    info: { requestName: request.name, requestId: request.id, iteration: options.iteration ?? 0, iterationCount: options.iterationCount ?? 1 },
    request: scriptRequest(request),
  });
  const absorb = (event: ScriptEvent, outcome: ScriptOutcome): void => {
    run.logs.push(...outcome.logs);
    run.tests.push(...outcome.tests);
    locals = outcome.locals;
    if (outcome.nextRequest !== undefined) run.nextRequest = outcome.nextRequest;
    const applied = applyVariableOps(workspace, saved.folderId, outcome.ops);
    run.variablesChanged ||= applied.changed;
    run.logs.push(...applied.warnings.map((text) => ({ level: "warn" as const, text })));
    if (outcome.error) run.scriptError = { event, ...outcome.error };
  };

  const pre = scriptChain(workspace, saved, "prerequest");
  if (pre.length) {
    const outcome = await deps.runScripts(job("prerequest", pre, saved));
    absorb("prerequest", outcome);
    if (run.scriptError) return run;
    run.request = applyScriptRequest(saved, outcome.request);
    if (outcome.skipRequest) {
      run.skipped = true;
      return run;
    }
  }

  const scope = collectVariables(workspace, saved.folderId);
  for (const [name, value] of options.iterationData ?? []) scope.set(name, dataText(value));
  for (const [name, value] of locals) scope.set(name, value);
  run.built = await deps.build(buildInputFor(workspace, run.request, scope));
  run.response = await deps.send(run.built, run.request);

  const tests = scriptChain(workspace, saved, "test");
  if (tests.length) {
    const response = run.response;
    const bytes = base64Bytes(response.bodyBase64);
    const type = response.headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
    const text = isTextContentType(type) || !type ? textDecoderFor(type).decode(bytes.subarray(0, SCRIPT_BODY_LIMIT)) : "";
    absorb("test", await deps.runScripts({
      ...job("test", tests, run.request),
      response: { code: response.status, status: response.statusText, headers: response.headers, body: text,
        responseTime: response.elapsedMs, responseSize: bytes.byteLength },
    }));
  }
  return run;
}
