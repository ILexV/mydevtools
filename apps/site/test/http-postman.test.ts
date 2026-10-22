import { test } from "node:test";
import assert from "node:assert/strict";
import { exportPostman, importPostman, PostmanError, POSTMAN_SCHEMA } from "../src/tools/http-postman.ts";
import { parseHttpWorkspace, type HttpSavedFolder, type HttpWorkspace } from "../src/tools/http-workspace.ts";

const root = (result: { folders: HttpSavedFolder[] }) => result.folders.find((folder) => folder.parentId === null)!;

const ids = () => {
  let next = 0;
  return () => `id${++next}`;
};

const collection = {
  info: { _postman_id: "x", name: "Shop API", schema: POSTMAN_SCHEMA },
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
  variable: [{ key: "baseUrl", value: "https://shop.example.com" }],
  event: [{ listen: "prerequest", script: { exec: ["pm.environment.set('a', 1)"] } }],
  item: [
    {
      name: "Orders",
      auth: { type: "basic", basic: { username: "u", password: "{{secret:pw}}" } },
      item: [
        {
          name: "Create order",
          event: [{ listen: "test", script: { exec: ["pm.test('ok')"] } }],
          request: {
            method: "POST",
            header: [{ key: "X-Trace", value: "1" }, { key: "X-Off", value: "0", disabled: true }],
            url: { raw: "{{baseUrl}}/orders?expand=items", host: ["{{baseUrl}}"], path: ["orders"],
              query: [{ key: "expand", value: "items" }, { key: "debug", value: "1", disabled: true }] },
            body: { mode: "raw", raw: "{\"sku\":\"{{sku}}\"}", options: { raw: { language: "json" } } },
          },
        },
        {
          name: "Upload",
          protocolProfileBehavior: { followRedirects: false },
          request: { method: "PUT", url: "{{baseUrl}}/upload",
            body: { mode: "formdata", formdata: [{ key: "note", value: "hi", type: "text" }, { key: "pic", type: "file", src: "/home/me/pic.png" }] } },
        },
      ],
    },
    { name: "GraphQL", request: { method: "POST", url: "{{baseUrl}}/graphql", auth: { type: "noauth" },
      body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: "{\"a\":1}" } } } },
    { name: "Digest", request: { method: "GET", url: "https://e.com", auth: { type: "digest", digest: [] } } },
    { name: "Code flow", request: { method: "COPY", url: "https://e.com",
      auth: { type: "oauth2", oauth2: [{ key: "grant_type", value: "authorization_code" }] } } },
    { name: "Client credentials", request: { method: "GET", url: "https://e.com", auth: { type: "oauth2", oauth2: [
      { key: "grant_type", value: "client_credentials" }, { key: "accessTokenUrl", value: "https://auth/token" },
      { key: "clientId", value: "cid" }, { key: "clientSecret", value: "{{secret:cs}}" }, { key: "client_authentication", value: "body" }] } } },
    { name: "Binary", request: { method: "POST", url: "https://e.com/bin", body: { mode: "file", file: { src: "dump.bin" } } } },
    { name: "Chained", event: [{ listen: "prerequest", script: { exec: "pm.sendRequest('https://x', () => {})" } }],
      request: { method: "GET", url: "https://e.com" } },
  ],
};

test("imports a v2.1 collection as one folder with its tree, auth, variables and body modes", () => {
  const result = importPostman(structuredClone(collection), null, ids(), "Collection");
  const root = result.folders[0]!;
  assert.equal(root.name, "Shop API");
  assert.equal(root.parentId, null);
  assert.deepEqual(root.auth, { type: "bearer", token: "{{token}}" });
  assert.deepEqual(root.variables, [{ name: "baseUrl", value: "https://shop.example.com", enabled: true }]);
  const orders = result.folders[1]!;
  assert.equal(orders.parentId, root.id);
  assert.deepEqual(orders.auth, { type: "basic", username: "u", password: "{{secret:pw}}" });

  const byName = new Map(result.requests.map((request) => [request.name, request]));
  const create = byName.get("Create order")!;
  assert.equal(create.folderId, orders.id);
  assert.equal(create.url, "{{baseUrl}}/orders?expand=items");
  assert.deepEqual(create.params.map((row) => [row.name, row.enabled]), [["expand", true], ["debug", false]]);
  assert.deepEqual(create.headers.map((row) => [row.name, row.enabled]), [["X-Trace", true], ["X-Off", false]]);
  assert.equal(create.bodyMode, "raw");
  assert.equal(create.bodyFormat, "json");
  assert.equal(create.auth, undefined);
  assert.equal(create.followRedirects, true);

  const upload = byName.get("Upload")!;
  assert.equal(upload.followRedirects, false);
  assert.deepEqual(upload.formdata?.map((row) => [row.name, row.kind]), [["note", "text"], ["pic", "file"]]);
  assert.deepEqual(byName.get("GraphQL")!.graphql, { query: "{ me { id } }", variables: "{\"a\":1}" });
  assert.deepEqual(byName.get("GraphQL")!.auth, { type: "none" });
  assert.deepEqual(byName.get("Digest")!.auth, { type: "none" });
  assert.equal(byName.get("Code flow")!.method, "GET");
  assert.deepEqual(byName.get("Client credentials")!.auth, { type: "oauth2", tokenUrl: "https://auth/token", clientId: "cid",
    clientSecret: "{{secret:cs}}", scope: "", clientAuth: "body" });
  assert.equal(byName.get("Binary")!.bodyMode, "binary");

  assert.deepEqual(root.scripts, { pre: "pm.environment.set('a', 1)", test: "" });
  assert.deepEqual(create.scripts, { pre: "", test: "pm.test('ok')" });
  assert.deepEqual(byName.get("Chained")!.scripts, { pre: "pm.sendRequest('https://x', () => {})", test: "" });
  assert.equal(result.scripts, 1);
  assert.deepEqual(result.unsupported.sort(), ["COPY", "OAuth 2.0 authorization_code", "digest"]);
  assert.deepEqual(result.files, ["/home/me/pic.png", "dump.bin"]);

  const workspace: HttpWorkspace = { v: 1, selectedId: result.requests[0]!.id, selectedFolderId: null, sidebarWidth: 240,
    folders: result.folders, requests: result.requests };
  assert.notEqual(parseHttpWorkspace(JSON.parse(JSON.stringify(workspace))), null);
});

test("Postman environment files become environments; other JSON is refused", () => {
  const environment = importPostman({ name: "Prod", _postman_variable_scope: "environment",
    values: [{ key: "baseUrl", value: "https://prod", enabled: true }, { key: "off", value: "1", enabled: false }] }, null, ids(), "Env");
  assert.deepEqual(environment.environments, [{ id: "id1", name: "Prod", variables: [
    { name: "baseUrl", value: "https://prod", enabled: true }, { name: "off", value: "1", enabled: false }] }]);
  const refuses = (input: unknown, code: string) => assert.throws(() => importPostman(input, null, ids(), "C"),
    (error: unknown) => error instanceof PostmanError && error.code === code);
  refuses({ id: "v1", name: "Old", order: [], requests: [] }, "version");
  refuses({ info: { name: "x", schema: "https://schema.getpostman.com/json/collection/v3.0.0/" }, item: [] }, "version");
  refuses([1, 2], "format");
  refuses({ hello: "world" }, "format");
});

test("an exported folder imports back with the same requests and inherited auth and variables", () => {
  const source = importPostman(structuredClone(collection), null, ids(), "Collection");
  const workspace: HttpWorkspace = { v: 1, selectedId: source.requests[0]!.id, selectedFolderId: null, sidebarWidth: 240,
    folders: source.folders, requests: source.requests, globals: [{ name: "g", value: "1", enabled: true }] };
  const orders = source.folders[1]!;
  const exported = exportPostman(workspace, orders.id, orders.name, "export-id");
  assert.equal((exported.info as { schema: string }).schema, POSTMAN_SCHEMA);
  // Collection variables of the parent come along; globals do not.
  assert.deepEqual(exported.variable, [{ key: "baseUrl", value: "https://shop.example.com" }]);

  const back = importPostman(JSON.parse(JSON.stringify(exported)), null, ids(), "C");
  assert.deepEqual(back.folders[0]!.auth, orders.auth);
  // Scripts of the folders above become the collection's scripts.
  assert.deepEqual(back.folders[0]!.scripts, root(source).scripts);
  const strip = (requests: typeof source.requests) => requests.map(({ id, folderId, ...rest }) => rest);
  assert.deepEqual(strip(back.requests), strip(source.requests.filter((request) => request.folderId === orders.id)));

  const whole = exportPostman(workspace, null, "All", "all-id");
  const again = importPostman(JSON.parse(JSON.stringify(whole)), null, ids(), "C");
  assert.deepEqual(strip(again.requests), strip(source.requests));
  assert.equal(again.folders.length, source.folders.length + 1);
  assert.equal(whole.variable, undefined);
});
