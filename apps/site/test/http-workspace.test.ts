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
    const workspace: HttpWorkspace = { v: 1, selectedId: "second", requests: ["first", "second"].map(id => ({
      id, name: id, method: "POST", url: "https://example.com/?a=%20#part",
      params: [{ name: "a", value: " ", enabled: true }, { name: "a", value: "disabled", enabled: false }],
      headers: [{ name: "Authorization", value: "Bearer secret", enabled: true }],
      body: '{"n":12345678901234567890}', bodyFormat: "json", timeoutMs: 15000, followRedirects: true,
    })) };
    assert.deepEqual(loadHttpWorkspace(), { workspace: null, error: false });
    assert.equal(saveHttpWorkspace(workspace), true);
    assert.deepEqual(loadHttpWorkspace(), { workspace, error: false });
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
