import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addHistoryEntry, AgentHistoryBackend, groupHistoryByDay, historyEntry, HISTORY_MAX_BODY_CHARS, HISTORY_MAX_ENTRIES,
  HISTORY_MAX_BYTES, HTTP_HISTORY_DOCUMENT, mergeHistory, parseHistory, type HistoryVaultClient, type HttpHistoryEntry,
} from "../src/tools/http-history.ts";
import type { HttpSavedRequest } from "../src/tools/http-workspace.ts";

const request: HttpSavedRequest = {
  id: "r1", folderId: "f1", name: "Get user", method: "GET", url: "{{base}}/users/{{id}}", params: [],
  headers: [{ name: "Authorization", value: "Bearer {{secret:token}}", enabled: true }], body: "", bodyFormat: "text",
  timeoutMs: 30000, followRedirects: true,
};

const entry = (id: string, at: number, extra: Partial<HttpSavedRequest> = {}): HttpHistoryEntry =>
  historyEntry({ ...request, ...extra }, { status: 200, elapsedMs: 12, sizeBytes: 34 }, id, at);

test("an entry keeps the request as written, without its tree place", () => {
  const made = entry("h1", 1000);
  assert.equal(made.request.url, "{{base}}/users/{{id}}");
  assert.equal(made.request.headers[0]!.value, "Bearer {{secret:token}}");
  assert.equal("id" in made.request, false);
  assert.equal("folderId" in made.request, false);
  assert.deepEqual([made.status, made.elapsedMs, made.sizeBytes, made.bodyDropped], [200, 12, 34, undefined]);
  const failed = historyEntry(request, { status: null, error: "timeout" }, "h2", 1);
  assert.deepEqual([failed.status, failed.error, "elapsedMs" in failed], [null, "timeout", false]);
});

test("large raw and GraphQL bodies are left out and marked", () => {
  const big = "x".repeat(HISTORY_MAX_BODY_CHARS + 1);
  const raw = entry("h1", 1, { method: "POST", body: big });
  assert.deepEqual([raw.request.body, raw.bodyDropped], ["", true]);
  const graphql = entry("h2", 1, { bodyMode: "graphql", graphql: { query: big, variables: "" } });
  assert.deepEqual([graphql.request.graphql, graphql.bodyDropped], [{ query: "", variables: "" }, true]);
  assert.equal(entry("h3", 1, { body: "small" }).request.body, "small");
});

test("entries go newest first, capped by count and by size", () => {
  let list: HttpHistoryEntry[] = [];
  for (let index = 0; index < HISTORY_MAX_ENTRIES + 5; index++) list = addHistoryEntry(list, entry(`h${index}`, index));
  assert.equal(list.length, HISTORY_MAX_ENTRIES);
  assert.equal(list[0]!.id, `h${HISTORY_MAX_ENTRIES + 4}`);
  assert.equal(list.at(-1)!.id, "h5");

  const body = "y".repeat(HISTORY_MAX_BODY_CHARS - 10);
  let heavy: HttpHistoryEntry[] = [];
  for (let index = 0; index < 40; index++) heavy = addHistoryEntry(heavy, entry(`b${index}`, index, { body }));
  assert.ok(JSON.stringify({ v: 1, entries: heavy }).length <= HISTORY_MAX_BYTES);
  assert.ok(heavy.length < 40);
  assert.equal(heavy[0]!.id, "b39");
});

test("merging drops duplicates and sorts by time; parsing drops broken entries", () => {
  const merged = mergeHistory([entry("a", 3), entry("b", 1)], [entry("b", 1), entry("c", 2)]);
  assert.deepEqual(merged.map((item) => item.id), ["a", "c", "b"]);

  const parsed = parseHistory(JSON.parse(JSON.stringify({ v: 1, entries: [entry("ok", 1), { id: "bad", at: "x" }, null] })));
  assert.deepEqual(parsed?.map((item) => item.id), ["ok"]);
  assert.equal(parseHistory({ v: 2, entries: [] }), null);
  assert.equal(parseHistory([]), null);
});

test("entries are grouped by local calendar day", () => {
  const day = (date: number, hour: number) => new Date(2026, 9, date, hour).getTime();
  const groups = groupHistoryByDay([entry("a", day(22, 18)), entry("b", day(22, 1)), entry("c", day(21, 23))]);
  assert.deepEqual(groups.map((group) => [group.day, group.entries.map((item) => item.id)]),
    [["2026-10-22", ["a", "b"]], ["2026-10-21", ["c"]]]);
});

class FakeVault implements HistoryVaultClient {
  data: unknown = null;
  revision = 0;
  /** Writes made by "another window" right before ours. */
  interfere = 0;
  reads = 0;

  async listDocuments() {
    return this.revision ? [{ name: HTTP_HISTORY_DOCUMENT }] : [];
  }

  async readDocument(name: string) {
    assert.equal(name, HTTP_HISTORY_DOCUMENT);
    this.reads++;
    return this.revision ? { revision: this.revision, data: structuredClone(this.data) } : null;
  }

  async writeDocument(_name: string, baseRevision: number, data: unknown) {
    if (this.interfere > 0) {
      this.interfere--;
      const current = parseHistory(this.data) ?? [];
      this.data = { v: 1, entries: addHistoryEntry(current, entry(`other${this.revision}`, 50 + this.revision)) };
      this.revision++;
    }
    if (baseRevision !== this.revision) throw Object.assign(new Error("conflict"), { code: "revision_conflict" });
    this.data = structuredClone(data);
    return ++this.revision;
  }
}

test("the agent backend re-reads and reapplies the change after another window's write", async () => {
  const vault = new FakeVault();
  const backend = new AgentHistoryBackend(vault);
  assert.deepEqual(await backend.load(), []);
  assert.equal(vault.reads, 0);

  await backend.update((list) => addHistoryEntry(list, entry("first", 1)));
  vault.interfere = 1;
  const saved = await backend.update((list) => addHistoryEntry(list, entry("second", 100)));
  assert.deepEqual(saved.map((item) => item.id), ["second", "other1", "first"]);
  assert.deepEqual((await backend.load()).map((item) => item.id), ["second", "other1", "first"]);

  // Parallel updates are chained, so neither is lost.
  await Promise.all([backend.update((list) => addHistoryEntry(list, entry("p1", 200))),
    backend.update((list) => addHistoryEntry(list, entry("p2", 201)))]);
  assert.deepEqual((await backend.load()).slice(0, 2).map((item) => item.id), ["p2", "p1"]);

  vault.interfere = 3;
  await assert.rejects(backend.update((list) => list), (error: unknown) => (error as { code?: string }).code === "revision_conflict");
  // A failed update does not block the next one.
  assert.ok((await backend.update((list) => list)).length > 0);
});
