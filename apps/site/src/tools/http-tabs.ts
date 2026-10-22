import type { HttpSavedRequest, HttpWorkspace } from "./http-workspace.ts";

/**
 * Open request tabs of the HTTP client (Postman-style tab strip): order kept in
 * `workspace.openIds`, the open request is always a tab, and a tab shows an
 * unsaved mark while its request differs from what storage last confirmed.
 */
export function openTabIds(workspace: HttpWorkspace, currentId: string): string[] {
  const existing = new Set(workspace.requests.map((request) => request.id));
  const ids = [...new Set(workspace.openIds ?? [])].filter((id) => existing.has(id));
  if (!ids.includes(currentId)) ids.push(currentId);
  return ids;
}

/** Opens `id` right after `afterId` (the tab that was active), or at the end. */
export function withOpenTab(ids: readonly string[], id: string, afterId: string | null): string[] {
  if (ids.includes(id)) return [...ids];
  const at = afterId === null ? -1 : ids.indexOf(afterId);
  return at < 0 ? [...ids, id] : [...ids.slice(0, at + 1), id, ...ids.slice(at + 1)];
}

/** The tab to show after closing `id`: the one to its right, else to its left. */
export function tabAfterClose(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

const DEFAULTS: Partial<HttpSavedRequest> = {
  bodyMode: "raw", urlencoded: [], formdata: [], binary: null, graphql: { query: "", variables: "" }, auth: { type: "inherit" },
  scripts: { pre: "", test: "" }, examples: [],
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => [key, stable((value as Record<string, unknown>)[key])]));
}

/** Content of a request for the unsaved mark: key order and omitted defaults do not count. */
export function requestFingerprint(request: HttpSavedRequest): string {
  const { folderId: _folder, ...content } = request;
  const filled: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, value] of Object.entries(content)) if (value !== undefined) filled[key] = value;
  return JSON.stringify(stable(filled));
}
