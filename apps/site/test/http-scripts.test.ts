import { test } from "node:test";
import assert from "node:assert/strict";
import { runHttpScripts, type ScriptJob, type ScriptOutcome } from "../src/tools/http-script-runtime.ts";
import { applyVariableOps, runHttpRequest, scriptAssignedNames, scriptChain, type RunDeps } from "../src/tools/http-run.ts";
import { parseHttpWorkspace, type HttpSavedRequest, type HttpWorkspace } from "../src/tools/http-workspace.ts";

function job(code: string, extra: Partial<ScriptJob> = {}): ScriptJob {
  return {
    event: "test", scripts: [{ label: "request", code }], globals: [["g", "1"]], collection: [["base", "https://api.test"]],
    environment: [["token", "abc"]], environmentName: "Dev", locals: [], iterationData: [],
    info: { requestName: "Get user", requestId: "r1", iteration: 0, iterationCount: 1 },
    request: { name: "Get user", method: "GET", url: "{{base}}/users?id=1", headers: [{ name: "Accept", value: "*/*" }], body: "" },
    response: { code: 200, status: "OK", headers: [{ name: "Content-Type", value: "application/json" }],
      body: JSON.stringify({ id: 7, name: "Ann", tags: ["a", "b"], nested: { ok: true } }), responseTime: 12, responseSize: 64 },
    ...extra,
  };
}

const statuses = (outcome: ScriptOutcome) => outcome.tests.map((entry) => `${entry.status}:${entry.name}`);

test("pm.test with pm.expect and pm.response.to records pass and fail with chai-like messages", async () => {
  const outcome = await runHttpScripts(job(`
    pm.test("status", () => pm.response.to.have.status(200));
    pm.test("ok + header", () => { pm.response.to.be.ok; pm.response.to.have.header("content-type", "application/json"); });
    pm.test("json", () => {
      const data = pm.response.json();
      pm.expect(data.id).to.equal(7);
      pm.expect(data).to.have.property("name", "Ann");
      pm.expect(data.tags).to.be.an("array").that.includes("b").and.has.lengthOf(2);
      pm.expect(data).to.deep.include({ nested: { ok: true } });
      pm.expect(data.tags).to.have.members(["b", "a"]);
      pm.expect(data).to.have.all.keys("id", "name", "tags", "nested");
      pm.expect(data).to.have.nested.property("nested.ok", true);
      pm.expect(data.name).to.match(/^A/).and.not.be.empty;
      pm.expect(pm.response.responseTime).to.be.below(100);
      pm.expect(data.tags).to.have.length.above(1);
      pm.expect(() => { throw new TypeError("boom"); }).to.throw(TypeError, "boom");
      pm.response.to.have.jsonBody("nested.ok", true);
    });
    pm.test("fails", () => pm.expect(pm.response.code).to.eql(404));
    pm.test("not", () => pm.response.to.not.be.ok);
    pm.test("message", () => pm.expect(1, "custom").to.be.a("string"));
    pm.test.skip("later");
    tests["legacy"] = responseCode.code === 200;
  `));
  assert.equal(outcome.error, null);
  assert.deepEqual(statuses(outcome), ["pass:status", "pass:ok + header", "pass:json", "fail:fails", "fail:not", "fail:message", "skip:later", "pass:legacy"]);
  assert.equal(outcome.tests[3]!.error, "AssertionError: expected 200 to deeply equal 404");
  assert.equal(outcome.tests[4]!.error, "AssertionError: expected response code to not be 200");
  assert.equal(outcome.tests[5]!.error, "AssertionError: custom: expected 1 to be a string");
});

test("variables: scopes, precedence, replaceIn and the ops sent back", async () => {
  const outcome = await runHttpScripts(job(`
    pm.environment.set("token", "new");
    pm.globals.unset("g");
    pm.collectionVariables.set("count", 3);
    pm.variables.set("local", "L");
    pm.environment.set("obj", { a: 1 });
    console.log(pm.variables.get("token"), pm.variables.replaceIn("{{base}}/{{local}}"), pm.globals.has("g"), pm.iterationData.get("row"));
    postman.setEnvironmentVariable("legacy", "yes");
  `, { iterationData: [["row", 5], ["token", "fromData"]] }));
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.ops, [
    { scope: "environment", op: "set", name: "token", value: "new" },
    { scope: "globals", op: "unset", name: "g" },
    { scope: "collection", op: "set", name: "count", value: "3" },
    { scope: "environment", op: "set", name: "obj", value: "{\"a\":1}" },
    { scope: "environment", op: "set", name: "legacy", value: "yes" },
  ]);
  // Data beats the environment; locals beat both.
  assert.deepEqual(outcome.logs, [{ level: "log", text: "fromData https://api.test/L false 5" }]);
  assert.deepEqual(outcome.locals, [["local", "L"]]);

  const noEnvironment = await runHttpScripts(job(`pm.environment.set("x", 1);`, { environment: null }));
  assert.deepEqual(noEnvironment.ops, []);
  assert.equal(noEnvironment.logs[0]!.level, "warn");
});

test("pre-request scripts change the request; errors stop the chain; skip and next request are reported", async () => {
  const pre = await runHttpScripts(job(`
    pm.request.headers.add({ key: "X-Trace", value: "{{$guid}}" });
    pm.request.headers.upsert({ key: "accept", value: "application/json" });
    pm.request.url.query.upsert("id", "2");
    pm.request.url.query.add("debug", "1");
    pm.request.method = "post";
    pm.request.body.raw = '{"a":1}';
    pm.execution.setNextRequest("Login");
  `, { event: "prerequest", response: undefined }));
  assert.equal(pre.error, null);
  assert.deepEqual(pre.request.headers, [{ name: "Accept", value: "application/json" }, { name: "X-Trace", value: "{{$guid}}" }]);
  assert.equal(pre.request.url, "{{base}}/users?id=2&debug=1");
  assert.equal(pre.request.method, "POST");
  assert.equal(pre.request.body, "{\"a\":1}");
  assert.equal(pre.nextRequest, "Login");

  const failed = await runHttpScripts({ ...job(""), scripts: [
    { label: "Folder", code: "pm.globals.set('a', 1); undefinedFunction();" },
    { label: "request", code: "pm.globals.set('b', 2);" },
  ] });
  assert.deepEqual(failed.error, { script: "Folder", message: "ReferenceError: undefinedFunction is not defined" });
  assert.deepEqual(failed.ops.map((op) => op.op === "set" && op.name), ["a"]);

  const skipped = await runHttpScripts(job("pm.execution.skipRequest();", { event: "prerequest", response: undefined }));
  assert.equal(skipped.skipRequest, true);
  const blocked = await runHttpScripts(job("require('lodash');"));
  assert.match(blocked.error!.message, /require is not supported/);
});

test("async tests, done callbacks and timers are awaited", async () => {
  const outcome = await runHttpScripts(job(`
    pm.test("async", async () => { await new Promise((resolve) => setTimeout(resolve, 5)); pm.expect(1).to.equal(2); });
    pm.test("done", (done) => { setTimeout(() => { pm.expect(true).to.be.true; done(); }, 5); });
    setTimeout(() => pm.environment.set("late", "1"), 10);
  `));
  assert.deepEqual(statuses(outcome), ["fail:async", "pass:done"]);
  assert.deepEqual(outcome.ops, [{ scope: "environment", op: "set", name: "late", value: "1" }]);
});

const request = (extra: Partial<HttpSavedRequest> = {}): HttpSavedRequest => ({
  id: "r1", folderId: "child", name: "Get", method: "GET", url: "{{base}}/x", params: [], headers: [], body: "", bodyFormat: "text",
  timeoutMs: 1000, followRedirects: false, ...extra,
});

function workspace(): HttpWorkspace {
  return {
    v: 1, selectedId: "r1", selectedFolderId: null, sidebarWidth: 240,
    folders: [
      { id: "root", name: "API", parentId: null, expanded: true, variables: [{ name: "base", value: "https://a.test", enabled: true }],
        scripts: { pre: "pm.variables.set('stamp', 'S');", test: "pm.test('root', () => pm.response.to.be.ok);" } },
      { id: "child", name: "Users", parentId: "root", expanded: true, variables: [{ name: "page", value: "1", enabled: true }],
        scripts: { pre: "", test: "" } },
    ],
    requests: [request({ scripts: { pre: "pm.request.headers.add({key: 'X-Stamp', value: '{{stamp}}'}); pm.collectionVariables.set('page', '2');",
      test: "pm.test('req', () => pm.expect(pm.response.json().ok).to.be.true); pm.environment.set('seen', pm.response.code);" } })],
    environments: [{ id: "e1", name: "Dev", variables: [] }], activeEnvironmentId: "e1",
  };
}

test("script chains, variable ops and a whole run through the pipeline", async () => {
  const space = workspace();
  assert.deepEqual(scriptChain(space, space.requests[0]!, "prerequest").map((entry) => entry.label), ["API", "Get"]);
  assert.deepEqual(scriptChain(space, space.requests[0]!, "test").map((entry) => entry.label), ["API", "Get"]);
  assert.deepEqual([...scriptAssignedNames(space, space.requests[0]!)], ["stamp", "page", "seen"]);

  const deps: RunDeps = {
    runScripts: runHttpScripts,
    build: async (input) => ({ method: input.method, url: input.url.replace("{{base}}", input.scope.get("base")!), headers: input.headers.map((header) =>
      ({ name: header.name, value: header.value.replace("{{stamp}}", input.scope.get("stamp")!) })), body: new Uint8Array(), unresolved: [], bodySpec: { kind: "none" } }),
    send: async (built) => ({ status: 200, statusText: "OK", url: built.url, elapsedMs: 3, bodyBase64: btoa("{\"ok\":true}"),
      headers: [{ name: "Content-Type", value: "application/json" }] }),
  };
  const run = await runHttpRequest(space, space.requests[0]!, deps);
  assert.equal(run.scriptError, null);
  assert.equal(run.built!.url, "https://a.test/x");
  assert.deepEqual(run.built!.headers, [{ name: "X-Stamp", value: "S" }]);
  assert.deepEqual(run.tests.map((entry) => `${entry.status}:${entry.name}`), ["pass:root", "pass:req"]);
  assert.equal(run.variablesChanged, true);
  // The nearest folder that defines `page` takes the new value; the environment gets `seen`.
  assert.deepEqual(space.folders[1]!.variables, [{ name: "page", value: "2", enabled: true }]);
  assert.deepEqual(space.environments![0]!.variables, [{ name: "seen", value: "200", enabled: true }]);
  assert.notEqual(parseHttpWorkspace(JSON.parse(JSON.stringify(space))), null);

  space.folders[0]!.scripts!.pre = "throw new Error('nope')";
  const stopped = await runHttpRequest(space, space.requests[0]!, deps);
  assert.deepEqual([stopped.scriptError?.event, stopped.scriptError?.script, stopped.response], ["prerequest", "API", null]);
});

test("variable ops outside folders and without an environment", () => {
  const space = workspace();
  space.activeEnvironmentId = null;
  const result = applyVariableOps(space, null, [
    { scope: "collection", op: "set", name: "x", value: "1" },
    { scope: "environment", op: "set", name: "y", value: "1" },
    { scope: "globals", op: "set", name: "z", value: "1" },
    { scope: "globals", op: "set", name: "z", value: "2" },
  ]);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(space.globals, [{ name: "z", value: "2", enabled: true }]);
  applyVariableOps(space, "child", [{ scope: "collection", op: "set", name: "fresh", value: "v" }, { scope: "collection", op: "unset", name: "page" }]);
  assert.deepEqual(space.folders[0]!.variables!.map((row) => row.name), ["base", "fresh"]);
  assert.deepEqual(space.folders[1]!.variables, []);
});
