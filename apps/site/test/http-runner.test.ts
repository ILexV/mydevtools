import { test } from "node:test";
import assert from "node:assert/strict";
import { runHttpScripts } from "../src/tools/http-script-runtime.ts";
import type { RunDeps } from "../src/tools/http-run.ts";
import { parseRunnerData, runCollection, RunnerDataError, runnerRequests, type RunnerStep } from "../src/tools/http-runner.ts";
import type { HttpSavedRequest, HttpWorkspace } from "../src/tools/http-workspace.ts";

const request = (id: string, folderId: string | null, extra: Partial<HttpSavedRequest> = {}): HttpSavedRequest => ({
  id, folderId, name: id, method: "GET", url: `https://api.test/${id}`, params: [], headers: [], body: "", bodyFormat: "text",
  timeoutMs: 1000, followRedirects: false, ...extra,
});

function workspace(requests: HttpSavedRequest[]): HttpWorkspace {
  return {
    v: 1, selectedId: requests[0]!.id, selectedFolderId: null, sidebarWidth: 240,
    folders: [
      { id: "api", name: "API", parentId: null, expanded: true },
      { id: "users", name: "Users", parentId: "api", expanded: true },
      { id: "other", name: "Other", parentId: null, expanded: true },
    ],
    requests, environments: [{ id: "e", name: "E", variables: [] }], activeEnvironmentId: "e",
  };
}

function deps(log: string[], fail?: string): RunDeps {
  return {
    runScripts: runHttpScripts,
    build: async (input) => {
      if (input.url.includes(fail ?? "\u0000")) throw new Error("build failed");
      const url = input.url.replace(/\{\{(\w+)\}\}/g, (_, name: string) => input.scope.get(name) ?? "");
      return { method: input.method, url, headers: [], body: new Uint8Array(), unresolved: [], bodySpec: { kind: "none" } };
    },
    send: async (built) => {
      log.push(built.url);
      return { status: 200, statusText: "OK", url: built.url, elapsedMs: 5, bodyBase64: btoa("{}"), headers: [] };
    },
  };
}

test("requests run in tree order: subfolders first, then the folder's own", () => {
  const space = workspace([request("a", "api"), request("root", null), request("u", "users"), request("o", "other")]);
  assert.deepEqual(runnerRequests(space, "api").map((entry) => entry.id), ["u", "a"]);
  assert.deepEqual(runnerRequests(space, null).map((entry) => entry.id), ["u", "a", "o", "root"]);
});

test("CSV and JSON data files", () => {
  assert.deepEqual(parseRunnerData("﻿id,name\r\n1,\"Ann, \"\"A\"\"\"\n2,\"multi\nline\"\n\n", "data.csv"),
    [[["id", "1"], ["name", "Ann, \"A\""]], [["id", "2"], ["name", "multi\nline"]]]);
  assert.deepEqual(parseRunnerData("[{\"id\": 1, \"tags\": [\"x\"]}]", "rows.json"), [[["id", 1], ["tags", ["x"]]]]);
  const fails = (text: string, name: string, code: string) => assert.throws(() => parseRunnerData(text, name),
    (error: unknown) => error instanceof RunnerDataError && error.code === code);
  fails("[1, 2]", "x.json", "json_shape");
  fails("{oops", "x.json", "json");
  fails("a\n\"open", "x.csv", "csv");
});

test("iterations take data rows, scripts see them, and failures do not stop the run", async () => {
  const log: string[] = [];
  const space = workspace([
    request("a", "api", { url: "https://api.test/{{id}}", scripts: { pre: "", test: "pm.test('row', () => pm.expect(pm.iterationData.get('id')).to.equal('2'));" } }),
    request("b", "api", { url: "https://broken.test/" }),
  ]);
  const steps: RunnerStep[] = [];
  const summary = await runCollection(space, {
    requests: runnerRequests(space, "api"), iterations: 5, data: [[["id", "1"]], [["id", "2"]]], delayMs: 0,
    signal: new AbortController().signal, onStep: (step) => steps.push(step),
  }, deps(log, "broken"));
  assert.deepEqual(log, ["https://api.test/1", "https://api.test/2"]);
  assert.deepEqual(steps.map((step) => [step.iteration, step.request.id, step.error ? "error" : step.run?.response?.status]),
    [[0, "a", 200], [0, "b", "error"], [1, "a", 200], [1, "b", "error"]]);
  assert.deepEqual(summary.tests, { passed: 1, failed: 1, skipped: 0 });
  assert.equal(summary.errors, 2);
  assert.equal(summary.stopped, null);
});

test("setNextRequest jumps, loops are cut off, null stops; abort stops between requests", async () => {
  const log: string[] = [];
  const space = workspace([
    request("login", "api", { scripts: { pre: "", test: "const n = Number(pm.environment.get('n') || 0) + 1; pm.environment.set('n', n); if (n < 3) pm.execution.setNextRequest('login'); else postman.setNextRequest('done');" } }),
    request("skipped", "api"),
    request("done", "api", { scripts: { pre: "", test: "postman.setNextRequest(null);" } }),
  ]);
  const summary = await runCollection(space, { requests: runnerRequests(space, "api"), iterations: 3, data: [], delayMs: 0,
    signal: new AbortController().signal, onStep: () => undefined }, deps(log));
  assert.deepEqual(log.map((url) => url.split("/").pop()), ["login", "login", "login", "done"]);
  assert.equal(summary.stopped, "next_null");

  const loop = workspace([request("again", null, { scripts: { pre: "", test: "pm.execution.setNextRequest('again');" } })]);
  assert.equal((await runCollection(loop, { requests: loop.requests, iterations: 1, data: [], delayMs: 0,
    signal: new AbortController().signal, onStep: () => undefined }, deps([]))).stopped, "loop");

  const missing = await runCollection(loop, { requests: [request("x", null, { scripts: { pre: "", test: "postman.setNextRequest('nope')" } })],
    iterations: 1, data: [], delayMs: 0, signal: new AbortController().signal, onStep: () => undefined }, deps([]));
  assert.deepEqual([missing.stopped, missing.missing], ["next_missing", "nope"]);

  const controller = new AbortController();
  const many = workspace([request("one", null), request("two", null)]);
  const aborted = await runCollection(many, { requests: many.requests, iterations: 10, data: [], delayMs: 1000, signal: controller.signal,
    onStep: () => controller.abort() }, deps([]));
  assert.deepEqual([aborted.stopped, aborted.steps], ["aborted", 1]);
});
