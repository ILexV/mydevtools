import test from "node:test";
import assert from "node:assert/strict";
import { loadHttpWorkspace, saveHttpWorkspace, type HttpWorkspace } from "../src/tools/http-workspace.ts";

test("HTTP workspace preserves drafts, disabled duplicate rows and selected request across reload", () => {
  let stored: string | null = null;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  } });
  try {
    const workspace: HttpWorkspace = { v: 1, selectedId: "second", folders: [], selectedFolderId: null, sidebarWidth: 240,
      requests: ["first", "second"].map(id => ({
      id, folderId: null, name: id, method: "POST", url: "https://example.com/?a=%20#part",
      params: [{ name: "a", value: " ", enabled: true }, { name: "a", value: "disabled", enabled: false }],
      headers: [{ name: "Authorization", value: "Bearer secret", enabled: true }],
      body: '{"n":12345678901234567890}', bodyFormat: "json", timeoutMs: 15000, followRedirects: true,
    })) };
    assert.deepEqual(loadHttpWorkspace(), { workspace: null, error: false });
    assert.equal(saveHttpWorkspace(workspace), true);
    assert.deepEqual(loadHttpWorkspace(), { workspace, error: false });
    const { folders, selectedFolderId, sidebarWidth, ...flat } = workspace;
    stored = JSON.stringify({ ...flat, requests: flat.requests.map(({ folderId, ...request }) => request) });
    const legacy = stored;
    assert.deepEqual(loadHttpWorkspace(), { workspace, error: false });
    assert.equal(stored, legacy, "loading migration does not overwrite the original");
    workspace.folders = [
      { id: "api", name: "API", parentId: null, expanded: true },
      { id: "users", name: "Users", parentId: "api", expanded: false },
    ];
    workspace.selectedFolderId = "users";
    workspace.requests[1]!.folderId = "users";
    workspace.sidebarWidth = 360;
    assert.equal(saveHttpWorkspace(workspace), true);
    assert.deepEqual(loadHttpWorkspace(), { workspace, error: false });
    for (const invalid of [
      { ...workspace, folders: [...workspace.folders, workspace.folders[0]] },
      { ...workspace, folders: workspace.folders.map(folder => ({ ...folder, parentId: "users" })) },
      { ...workspace, folders: workspace.folders.map(folder => ({ ...folder, parentId: "missing" })) },
      { ...workspace, selectedFolderId: "missing" },
      { ...workspace, requests: workspace.requests.map(request => ({ ...request, folderId: "missing" })) },
      { ...workspace, sidebarWidth: 100 },
      { ...workspace, sidebarWidth: 1000 },
    ]) {
      stored = JSON.stringify(invalid);
      assert.deepEqual(loadHttpWorkspace(), { workspace: null, error: true });
      assert.equal(saveHttpWorkspace(invalid as HttpWorkspace), false);
    }
    assert.equal(saveHttpWorkspace(workspace), true);
    const old = stored;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: () => stored, setItem: () => { throw new Error("quota"); },
    } });
    workspace.requests[1]!.body = "unsaved";
    assert.equal(saveHttpWorkspace(workspace), false);
    assert.equal(stored, old);
    for (const bad of ["{", '{"v":2}', JSON.stringify({ ...workspace, selectedId: "missing" }),
      JSON.stringify({ ...workspace, requests: [workspace.requests[0], workspace.requests[0]] }),
      JSON.stringify({ ...workspace, requests: [{ ...workspace.requests[1], headers: [{ name: "x", value: "y" }] }] })]) {
      stored = bad;
      assert.deepEqual(loadHttpWorkspace(), { workspace: null, error: true });
      assert.equal(stored, bad);
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    assert.deepEqual(loadHttpWorkspace(), { workspace: null, error: true });
    assert.equal(saveHttpWorkspace(workspace), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
