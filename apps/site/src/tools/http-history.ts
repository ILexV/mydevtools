import type { HttpSavedRequest } from "./http-workspace.ts";

/**
 * History of sent HTTP client requests (opt-in). An entry keeps the request as
 * written — `{{vars}}` and `{{secret:…}}` unresolved — and the outcome: status,
 * time and size, never the response body. Stored where the workspace lives.
 */
export const HTTP_HISTORY_DOCUMENT = "http-history";
export const HTTP_HISTORY_STORAGE_KEY = "mdt.http-history.v1";
export const HTTP_HISTORY_ENABLED_KEY = "mdt.http-history.enabled.v1";
export const HISTORY_MAX_ENTRIES = 100;
/** Keeps the vault document (1.5 MiB) and localStorage comfortable. */
export const HISTORY_MAX_BYTES = 1024 * 1024;
/** Larger bodies are left out of the entry; the request itself is still listed. */
export const HISTORY_MAX_BODY_CHARS = 64 * 1024;

export type HistoryRequest = Omit<HttpSavedRequest, "id" | "folderId">;

export interface HttpHistoryEntry {
  id: string;
  /** Epoch ms of sending. */
  at: number;
  request: HistoryRequest;
  /** HTTP status, or null when the agent reported an error code instead. */
  status: number | null;
  error?: string;
  elapsedMs?: number;
  sizeBytes?: number;
  /** The body was too large to keep. */
  bodyDropped?: boolean;
}

export interface HttpHistory {
  v: 1;
  entries: HttpHistoryEntry[];
}

export function historyEntry(
  request: HttpSavedRequest,
  outcome: { status: number | null; error?: string; elapsedMs?: number; sizeBytes?: number },
  id: string,
  at = Date.now(),
): HttpHistoryEntry {
  const { id: _id, folderId: _folder, ...copy } = structuredClone(request);
  let bodyDropped = false;
  const body = copy.bodyMode ?? "raw";
  if ((body === "raw" && copy.body.length > HISTORY_MAX_BODY_CHARS)
    || (body === "graphql" && (copy.graphql?.query.length ?? 0) + (copy.graphql?.variables.length ?? 0) > HISTORY_MAX_BODY_CHARS)) {
    bodyDropped = true;
    copy.body = "";
    if (copy.graphql) copy.graphql = { query: "", variables: "" };
  }
  return { id, at, request: copy, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.elapsedMs !== undefined ? { elapsedMs: outcome.elapsedMs } : {}),
    ...(outcome.sizeBytes !== undefined ? { sizeBytes: outcome.sizeBytes } : {}),
    ...(bodyDropped ? { bodyDropped } : {}) };
}

/** Newest first, at most 100 entries and 1 MiB of JSON; the oldest go first. */
export function addHistoryEntry(entries: readonly HttpHistoryEntry[], entry: HttpHistoryEntry): HttpHistoryEntry[] {
  const next = [entry, ...entries].slice(0, HISTORY_MAX_ENTRIES);
  let size = JSON.stringify({ v: 1, entries: next }).length;
  while (next.length > 1 && size > HISTORY_MAX_BYTES) size -= JSON.stringify(next.pop()).length + 1;
  return next;
}

/** Entries from the newer side win when both stores hold history (moving to the agent). */
export function mergeHistory(left: readonly HttpHistoryEntry[], right: readonly HttpHistoryEntry[]): HttpHistoryEntry[] {
  const seen = new Set<string>();
  const merged = [...left, ...right].filter((entry) => !seen.has(entry.id) && seen.add(entry.id)).sort((a, b) => b.at - a.at);
  return merged.reduceRight<HttpHistoryEntry[]>((result, entry) => addHistoryEntry(result, entry), []);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Invalid entries are dropped one by one; a broken document gives null. */
export function parseHistory(input: unknown): HttpHistoryEntry[] | null {
  if (!isObject(input) || input.v !== 1 || !Array.isArray(input.entries)) return null;
  return input.entries.filter((entry): entry is HttpHistoryEntry => isObject(entry) && typeof entry.id === "string"
    && typeof entry.at === "number" && Number.isFinite(entry.at) && (entry.status === null || typeof entry.status === "number")
    && isObject(entry.request) && typeof entry.request.method === "string" && typeof entry.request.url === "string"
    && Array.isArray(entry.request.params) && Array.isArray(entry.request.headers) && typeof entry.request.body === "string");
}

/** Day groups for the list, newest first; the key is the local calendar day. */
export function groupHistoryByDay(entries: readonly HttpHistoryEntry[]): { day: string; entries: HttpHistoryEntry[] }[] {
  const groups: { day: string; entries: HttpHistoryEntry[] }[] = [];
  for (const entry of entries) {
    const date = new Date(entry.at);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

export interface HistoryVaultClient {
  listDocuments(): Promise<{ name: string }[]>;
  readDocument(name: string): Promise<{ revision: number; data: unknown } | null>;
  writeDocument(name: string, baseRevision: number, data: unknown): Promise<number>;
}

/** Where history is kept: the browser, or the agent vault next to the workspace. */
export interface HistoryBackend {
  load(): Promise<HttpHistoryEntry[]>;
  /** Applies a change to the latest stored list and returns what was saved. */
  update(change: (entries: HttpHistoryEntry[]) => HttpHistoryEntry[]): Promise<HttpHistoryEntry[]>;
}

export class LocalHistoryBackend implements HistoryBackend {
  async load(): Promise<HttpHistoryEntry[]> {
    const raw = localStorage.getItem(HTTP_HISTORY_STORAGE_KEY);
    if (raw === null) return [];
    const entries = parseHistory(JSON.parse(raw));
    if (!entries) throw new Error("history_corrupt");
    return entries;
  }

  async update(change: (entries: HttpHistoryEntry[]) => HttpHistoryEntry[]): Promise<HttpHistoryEntry[]> {
    const entries = change(await this.load());
    if (entries.length) localStorage.setItem(HTTP_HISTORY_STORAGE_KEY, JSON.stringify({ v: 1, entries }));
    else localStorage.removeItem(HTTP_HISTORY_STORAGE_KEY);
    return entries;
  }
}

/** Read-modify-write over the document revision; another window's write is re-read and the change applied again. */
export class AgentHistoryBackend implements HistoryBackend {
  #client: HistoryVaultClient;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(client: HistoryVaultClient) {
    this.#client = client;
  }

  async #read(): Promise<{ entries: HttpHistoryEntry[]; revision: number }> {
    // Listing first keeps a missing document from showing up as a 404 in the console.
    const listed = (await this.#client.listDocuments()).some((info) => info.name === HTTP_HISTORY_DOCUMENT);
    const document = listed ? await this.#client.readDocument(HTTP_HISTORY_DOCUMENT) : null;
    if (!document) return { entries: [], revision: 0 };
    const entries = parseHistory(document.data);
    if (!entries) throw new Error("history_corrupt");
    return { entries, revision: document.revision };
  }

  async load(): Promise<HttpHistoryEntry[]> {
    return (await this.#read()).entries;
  }

  update(change: (entries: HttpHistoryEntry[]) => HttpHistoryEntry[]): Promise<HttpHistoryEntry[]> {
    const run = async (): Promise<HttpHistoryEntry[]> => {
      for (let attempt = 0; ; attempt++) {
        const current = await this.#read();
        const entries = change(current.entries);
        try {
          await this.#client.writeDocument(HTTP_HISTORY_DOCUMENT, current.revision, { v: 1, entries });
          return entries;
        } catch (error) {
          const conflict = typeof error === "object" && error !== null && "code" in error && error.code === "revision_conflict";
          if (!conflict || attempt >= 2) throw error;
        }
      }
    };
    const next = this.#chain.then(run);
    this.#chain = next.catch(() => undefined);
    return next;
  }
}
