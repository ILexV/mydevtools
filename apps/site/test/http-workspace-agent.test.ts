import test from "node:test";
import assert from "node:assert/strict";
import { LocalAgentError, type VaultDocument } from "../src/scripts/local-agent.ts";
import { AgentWorkspaceStore, HTTP_WORKSPACE_DOCUMENT } from "../src/tools/http-workspace-agent.ts";
import {
  appendHttpWorkspace,
  mergeHttpWorkspaceConflict,
  sameHttpWorkspaceContent,
  type HttpSavedRequest,
  type HttpWorkspace,
} from "../src/tools/http-workspace.ts";

function request(id: string, folderId: string | null = null, body = ""): HttpSavedRequest {
  return { id, folderId, name: id, method: "GET", url: `https://example.com/${id}`, params: [], headers: [],
    body, bodyFormat: "text", timeoutMs: 30000, followRedirects: false };
}

function workspace(requests: HttpSavedRequest[], folders: HttpWorkspace["folders"] = []): HttpWorkspace {
  return { v: 1, selectedId: requests[0]!.id, requests, folders, selectedFolderId: null, sidebarWidth: 240 };
}

/** In-memory vault with the agent's revision rules. */
function fakeVault() {
  const state: { document: VaultDocument | null; writes: number; fail: unknown } = { document: null, writes: 0, fail: null };
  return {
    state,
    async listDocuments() {
      return state.document ? [{ name: state.document.name, revision: state.document.revision, updatedAt: state.document.updatedAt }] : [];
    },
    async readDocument(name: string) {
      assert.equal(name, HTTP_WORKSPACE_DOCUMENT);
      return state.document ? structuredClone(state.document) : null;
    },
    async writeDocument(name: string, baseRevision: number, data: unknown) {
      assert.equal(name, HTTP_WORKSPACE_DOCUMENT);
      state.writes++;
      if (state.fail) throw state.fail;
      const current = state.document?.revision ?? 0;
      if (current !== baseRevision) throw new LocalAgentError("revision_conflict", 409);
      state.document = { name, revision: current + 1, updatedAt: "2026-10-21T00:00:00Z", data: structuredClone(data) };
      return current + 1;
    },
  };
}

test("browser workspace is appended under its own folder with fresh ids", () => {
  const agent = workspace([request("a")]);
  const browser = workspace([request("a"), request("b", "f1")], [{ id: "f1", name: "API", parentId: null, expanded: false }]);
  let counter = 0;
  const merged = appendHttpWorkspace(agent, browser, "From the browser", () => `new-${++counter}`);
  assert.equal(merged.requests.length, 3);
  assert.equal(new Set(merged.requests.map((item) => item.id)).size, 3, "ids never collide");
  const root = merged.folders.find((folder) => folder.name === "From the browser")!;
  assert.equal(root.parentId, null);
  const api = merged.folders.find((folder) => folder.name === "API")!;
  assert.equal(api.parentId, root.id);
  assert.equal(merged.requests.find((item) => item.url.endsWith("/b"))!.folderId, api.id);
  assert.equal(merged.requests.filter((item) => item.url.endsWith("/a"))[1]!.folderId, root.id);
  assert.equal(agent.requests.length, 1, "inputs are not mutated");
  assert.equal(sameHttpWorkspaceContent(agent, { ...agent, selectedId: "x", sidebarWidth: 300 }), true);
  assert.equal(sameHttpWorkspaceContent(agent, browser), false);
});

test("a lost revision race keeps the other window's tree and this window's open request", () => {
  const remote = workspace([request("a", null, "remote"), request("c")], []);
  const local = workspace([request("a", "gone", "local edit"), request("b")]);
  const merged = mergeHttpWorkspaceConflict(remote, local, "a");
  assert.deepEqual(merged.requests.map((item) => [item.id, item.body]), [["a", "local edit"], ["c", ""]]);
  assert.equal(merged.requests[0]!.folderId, null, "a folder the other window removed falls back to the root");
  assert.equal(merged.selectedId, "a");
  const added = mergeHttpWorkspaceConflict(remote, local, "b");
  assert.deepEqual(added.requests.map((item) => item.id), ["a", "c", "b"]);
});

test("agent store saves over revisions, reports conflicts with the remote copy and retries failures", async () => {
  const vault = fakeVault();
  const first = new AgentWorkspaceStore(vault);
  const second = new AgentWorkspaceStore(vault);
  assert.deepEqual(await first.load(), { workspace: null, revision: 0 });
  assert.deepEqual(await first.flush(), { kind: "idle" });

  first.queue(workspace([request("a")]));
  assert.deepEqual(await first.flush(), { kind: "saved", revision: 1 });
  assert.equal((await second.load()).revision, 1);
  second.queue(workspace([request("b")]));
  assert.deepEqual(await second.flush(), { kind: "saved", revision: 2 });

  first.queue(workspace([request("stale")]));
  const conflict = await first.flush();
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind === "conflict") {
    assert.equal(conflict.revision, 2);
    assert.equal(conflict.remote.requests[0]!.id, "b");
  }
  assert.equal(first.hasPending, false, "the controller requeues a merged copy");
  assert.equal(first.revision, 2);

  vault.state.fail = new LocalAgentError("agent_unavailable");
  first.queue(workspace([request("offline")]));
  const failed = await first.flush();
  assert.equal(failed.kind, "error");
  assert.equal(first.hasPending, true, "a failed save stays queued");
  vault.state.fail = null;
  assert.deepEqual(await first.flush(), { kind: "saved", revision: 3 });
  assert.equal((vault.state.document!.data as HttpWorkspace).requests[0]!.id, "offline");

  // Saves are serialized: the second flush waits for the first and sends nothing new.
  first.queue(workspace([request("one")]));
  const [one, two] = await Promise.all([first.flush(), first.flush()]);
  assert.deepEqual([one.kind, two.kind], ["saved", "idle"]);

  // A save too large for keepalive is left queued for the next visit.
  first.queue(workspace([request("big", null, "x".repeat(70 * 1024))]));
  assert.deepEqual(await first.flush({ keepalive: true }), { kind: "idle" });
  assert.equal(first.hasPending, true);

  vault.state.document = { name: HTTP_WORKSPACE_DOCUMENT, revision: 9, updatedAt: "", data: { v: 2 } };
  await assert.rejects(new AgentWorkspaceStore(vault).load(), (error: unknown) =>
    error instanceof LocalAgentError && error.code === "vault_corrupt");
});
