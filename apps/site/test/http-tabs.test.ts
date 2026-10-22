import { test } from "node:test";
import assert from "node:assert/strict";
import { openTabIds, requestFingerprint, tabAfterClose, withOpenTab } from "../src/tools/http-tabs.ts";
import { mergeHttpWorkspaceConflict, parseHttpWorkspace, type HttpSavedRequest, type HttpWorkspace } from "../src/tools/http-workspace.ts";

const request = (id: string, extra: Partial<HttpSavedRequest> = {}): HttpSavedRequest => ({
  id, folderId: null, name: id, method: "GET", url: "", params: [], headers: [], body: "", bodyFormat: "text",
  timeoutMs: 30000, followRedirects: false, ...extra,
});
const workspace = (openIds?: string[]): HttpWorkspace => ({
  v: 1, selectedId: "a", selectedFolderId: null, sidebarWidth: 240, folders: [],
  requests: [request("a"), request("b"), request("c")], ...(openIds ? { openIds } : {}),
});

test("open tabs drop deleted requests and always include the open one", () => {
  assert.deepEqual(openTabIds(workspace(), "a"), ["a"]);
  assert.deepEqual(openTabIds(workspace(["c", "gone", "c", "b"]), "a"), ["c", "b", "a"]);
});

test("a new tab opens next to the active one; closing picks the right neighbour, then the left", () => {
  assert.deepEqual(withOpenTab(["a", "b"], "c", "a"), ["a", "c", "b"]);
  assert.deepEqual(withOpenTab(["a", "b"], "c", null), ["a", "b", "c"]);
  assert.deepEqual(withOpenTab(["a", "b"], "b", "a"), ["a", "b"]);
  assert.equal(tabAfterClose(["a", "b", "c"], "b"), "c");
  assert.equal(tabAfterClose(["a", "b", "c"], "c"), "b");
  assert.equal(tabAfterClose(["a"], "a"), null);
});

test("the unsaved mark ignores key order, omitted defaults and the folder", () => {
  const saved = request("a", { url: "https://e.com" });
  const captured: HttpSavedRequest = { bodyMode: "raw", urlencoded: [], formdata: [], binary: null,
    graphql: { query: "", variables: "" }, auth: { type: "inherit" }, ...saved };
  captured.folderId = "f";
  assert.equal(requestFingerprint(captured), requestFingerprint(saved));
  assert.notEqual(requestFingerprint({ ...saved, url: "https://e.com/x" }), requestFingerprint(saved));
  assert.notEqual(requestFingerprint({ ...saved, bodyMode: "none" }), requestFingerprint(saved));
});

test("tabs are saved and validated, and a conflict merge keeps this window's tabs", () => {
  assert.notEqual(parseHttpWorkspace(workspace(["a", "b"])), null);
  assert.equal(parseHttpWorkspace({ ...workspace(), openIds: [1] }), null);
  const merged = mergeHttpWorkspaceConflict(workspace(["c"]), workspace(["a", "b"]), "a");
  assert.deepEqual(merged.openIds, ["a", "b"]);
});
