import type { HttpSavedRow, HttpWorkspace } from "./http-workspace.ts";

/**
 * Postman-style `{{name}}` variables for the HTTP client. Scopes from weakest
 * to strongest: globals, folders from the root down to the request's folder
 * (collection variables), then the active environment. `{{secret:name}}` is
 * not a variable: it is left for the agent to substitute.
 */
export type VariableScope = Map<string, string>;

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const MAX_DEPTH = 8;

function addRows(scope: VariableScope, rows: readonly HttpSavedRow[] | undefined): void {
  for (const row of rows ?? []) {
    const name = row.name.trim();
    if (row.enabled && name) scope.set(name, row.value);
  }
}

/** Folder ids from the root down to `folderId`; a broken parent chain stops early. */
export function folderChain(workspace: HttpWorkspace, folderId: string | null): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    const folder = workspace.folders.find((entry) => entry.id === current);
    if (!folder) break;
    seen.add(current);
    chain.unshift(current);
    current = folder.parentId;
  }
  return chain;
}

/** Variables visible to a request in `folderId` with the workspace's active environment. */
export function collectVariables(workspace: HttpWorkspace, folderId: string | null): VariableScope {
  const scope: VariableScope = new Map();
  addRows(scope, workspace.globals);
  for (const id of folderChain(workspace, folderId)) {
    addRows(scope, workspace.folders.find((folder) => folder.id === id)?.variables);
  }
  const environment = workspace.environments?.find((entry) => entry.id === workspace.activeEnvironmentId);
  addRows(scope, environment?.variables);
  return scope;
}

/** Built-in `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}` and `{{$randomInt}}` (0–1000). */
function dynamicValue(name: string, now: () => Date): string | null {
  switch (name) {
    case "$guid": return crypto.randomUUID();
    case "$timestamp": return String(Math.floor(now().getTime() / 1000));
    case "$isoTimestamp": return now().toISOString();
    case "$randomInt": return String(Math.floor(Math.random() * 1001));
    default: return null;
  }
}

export interface ResolveOptions {
  /** Names that stayed as `{{name}}`, collected across calls. */
  unresolved?: Set<string>;
  now?: () => Date;
}

/**
 * Replaces `{{name}}` with its value; a value may refer to other variables.
 * Unknown names and reference cycles stay literal and are reported in `unresolved`.
 */
export function resolveVariables(text: string, scope: VariableScope, options: ResolveOptions = {}): string {
  const now = options.now ?? (() => new Date());
  const expand = (input: string, depth: number, stack: readonly string[]): string =>
    input.replace(PLACEHOLDER, (match, raw: string) => {
      const name = raw.trim();
      if (name.startsWith("secret:")) return match;
      const dynamic = name.startsWith("$") ? dynamicValue(name, now) : null;
      if (dynamic !== null) return dynamic;
      const value = scope.get(name);
      if (value === undefined || depth >= MAX_DEPTH || stack.includes(name)) {
        options.unresolved?.add(name);
        return match;
      }
      return expand(value, depth + 1, [...stack, name]);
    });
  return expand(text, 0, []);
}

/** Variable names a text refers to, without `{{secret:…}}` placeholders. */
export function variableNames(text: string): string[] {
  const names: string[] = [];
  for (const [, raw] of text.matchAll(PLACEHOLDER)) {
    const name = raw!.trim();
    if (!name.startsWith("secret:") && !names.includes(name)) names.push(name);
  }
  return names;
}

/** True when the text holds a `{{secret:name}}` placeholder for the agent. */
export function hasSecretPlaceholder(text: string): boolean {
  return /\{\{\s*secret:[^{}]+\}\}/.test(text);
}

/**
 * Percent-encodes a query component but keeps `{{…}}` placeholders literal, so
 * editing the params table does not turn `{{token}}` into `%7B%7Btoken%7D%7D`.
 */
export function encodeQueryComponent(text: string): string {
  let output = "";
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    output += encodeURIComponent(text.slice(last, match.index));
    output += match[0];
    last = match.index! + match[0].length;
  }
  return output + encodeURIComponent(text.slice(last));
}
