import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHttpRequest, HttpBuildError, type BuildInput } from "../src/tools/http-auth.ts";
import { bodyTexts, encodeMultipart, encodeUrlencoded, graphqlPayload, hasBody } from "../src/tools/http-body.ts";
import { parseHttpWorkspace, type HttpFileRef, type HttpWorkspace } from "../src/tools/http-workspace.ts";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const file: HttpFileRef = { id: "f1", name: "logo.png", size: 3, type: "image/png" };

function input(extra: Partial<BuildInput>): BuildInput {
  return {
    method: "POST", url: "https://example.com/upload", headers: [], body: "", bodyFormat: "text",
    auth: { type: "none" }, scope: new Map([["id", "42"]]), ...extra,
  };
}

const contentType = (headers: { name: string; value: string }[]): string[] =>
  headers.filter(({ name }) => name.toLowerCase() === "content-type").map(({ value }) => value);

test("urlencoded pairs keep placeholders and percent-encode the rest", () => {
  assert.equal(encodeUrlencoded([["a b", "x&y=z"], ["token", "{{secret:api}}"], ["ru", "да"]]),
    "a%20b=x%26y%3Dz&token={{secret:api}}&ru=%D0%B4%D0%B0");
});

test("multipart body matches RFC 7578 framing and escapes quotes in names", () => {
  const bytes = encodeMultipart([
    { name: "title", value: "Привет" },
    { name: "a\"b", file: { name: "x\r\n.txt", type: "", bytes: new Uint8Array([0, 255]) } },
  ], "B");
  const expected = "--B\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nПривет\r\n"
    + "--B\r\nContent-Disposition: form-data; name=\"a%22b\"; filename=\"x%0D%0A.txt\"\r\nContent-Type: application/octet-stream\r\n\r\n";
  const head = new TextEncoder().encode(expected);
  assert.deepEqual(bytes.slice(0, head.length), head);
  assert.deepEqual([...bytes.slice(head.length, head.length + 2)], [0, 255]);
  assert.equal(decode(bytes.slice(head.length + 2)), "\r\n--B--\r\n");
});

test("GraphQL payload takes an object of variables or none", () => {
  assert.equal(graphqlPayload("{ a }", ""), "{\"query\":\"{ a }\"}");
  assert.equal(graphqlPayload("{ a }", "{\"id\": 1}"), "{\"query\":\"{ a }\",\"variables\":{\"id\":1}}");
  assert.equal(graphqlPayload("{ a }", "[1]"), null);
  assert.equal(graphqlPayload("{ a }", "{oops"), null);
});

test("each body mode sets its Content-Type; raw stays the default for old saves", async () => {
  const raw = await buildHttpRequest(input({ body: "{\"id\":{{id}}}", bodyFormat: "json" }));
  assert.equal(decode(raw.body), "{\"id\":42}");
  assert.deepEqual(contentType(raw.headers), ["application/json"]);

  const none = await buildHttpRequest(input({ bodyMode: "none", body: "ignored" }));
  assert.equal(none.body.byteLength, 0);
  assert.deepEqual(contentType(none.headers), []);

  const form = await buildHttpRequest(input({ bodyMode: "urlencoded", urlencoded: [
    { name: "id", value: "{{id}}", enabled: true }, { name: "off", value: "1", enabled: false }, { name: "", value: "x", enabled: true },
  ] }));
  assert.equal(decode(form.body), "id=42");
  assert.deepEqual(contentType(form.headers), ["application/x-www-form-urlencoded"]);

  const graphql = await buildHttpRequest(input({ bodyMode: "graphql", graphql: { query: "query($id: ID)", variables: "{\"id\": \"{{id}}\"}" } }));
  assert.deepEqual(JSON.parse(decode(graphql.body)), { query: "query($id: ID)", variables: { id: "42" } });
  assert.deepEqual(contentType(graphql.headers), ["application/json"]);
  await assert.rejects(buildHttpRequest(input({ bodyMode: "graphql", graphql: { query: "{ a }", variables: "1" } })),
    (error: unknown) => error instanceof HttpBuildError && error.code === "graphql_variables");
});

test("form-data replaces a hand-set Content-Type with its boundary and reads files", async () => {
  const built = await buildHttpRequest(input({
    bodyMode: "formdata", boundary: "XYZ",
    headers: [{ name: "content-type", value: "multipart/form-data" }],
    formdata: [
      { name: "note", value: "id {{id}}", enabled: true, kind: "text" },
      { name: "logo", value: "", enabled: true, kind: "file", file },
      { name: "off", value: "", enabled: false, kind: "file", file: null },
    ],
    readFile: async (ref) => ref.id === "f1" ? new Uint8Array([1, 2, 3]) : null,
  }));
  assert.deepEqual(contentType(built.headers), ["multipart/form-data; boundary=XYZ"]);
  const text = decode(built.body);
  assert.match(text, /name="note"\r\n\r\nid 42\r\n/);
  assert.match(text, /name="logo"; filename="logo.png"\r\nContent-Type: image\/png\r\n\r\n\u0001\u0002\u0003\r\n--XYZ--\r\n$/);
  assert.doesNotMatch(text, /name="off"/);
  await assert.rejects(buildHttpRequest(input({ bodyMode: "formdata", formdata: [{ name: "pic", value: "", enabled: true, kind: "file", file: null }] })),
    (error: unknown) => error instanceof HttpBuildError && error.code === "file_unset" && error.message === "pic");
  await assert.rejects(buildHttpRequest(input({ bodyMode: "binary", binary: null })),
    (error: unknown) => error instanceof HttpBuildError && error.code === "file_unset");
});

test("binary sends the file as is; a file lost on reload is reported by name", async () => {
  const built = await buildHttpRequest(input({ bodyMode: "binary", binary: file, body: "{{id}}",
    headers: [{ name: "Content-Type", value: "application/x-custom" }],
    readFile: async () => new TextEncoder().encode("{{id}}") }));
  assert.equal(decode(built.body), "{{id}}");
  assert.deepEqual(contentType(built.headers), ["application/x-custom"]);
  await assert.rejects(buildHttpRequest(input({ bodyMode: "binary", binary: file, readFile: async () => null })),
    (error: unknown) => error instanceof HttpBuildError && error.code === "file_missing" && error.message === "logo.png");
});

test("SigV4 refuses a secret placed in a form body", async () => {
  await assert.rejects(buildHttpRequest(input({
    bodyMode: "urlencoded", urlencoded: [{ name: "k", value: "{{secret:api}}", enabled: true }],
    auth: { type: "awsv4", accessKey: "AK", secretKey: "SK", sessionToken: "", region: "us-east-1", service: "execute-api" },
  })), (error: unknown) => error instanceof HttpBuildError && error.code === "aws_secret");
});

test("body hints follow the active mode", () => {
  const fields = { body: "{{a}}", bodyFormat: "text" as const, urlencoded: [{ name: "{{b}}", value: "{{c}}", enabled: true }],
    formdata: [{ name: "{{d}}", value: "{{e}}", enabled: true, kind: "file" as const, file: null }] };
  assert.deepEqual(bodyTexts(fields), ["{{a}}"]);
  assert.deepEqual(bodyTexts({ ...fields, bodyMode: "urlencoded" }), ["{{b}}", "{{c}}"]);
  assert.deepEqual(bodyTexts({ ...fields, bodyMode: "formdata" }), ["{{d}}"]);
  assert.equal(hasBody({ ...fields, bodyMode: "none" }), false);
  assert.equal(hasBody({ ...fields, bodyMode: "binary", binary: null }), false);
  assert.equal(hasBody({ ...fields, bodyMode: "formdata" }), true);
});

test("saved body modes are validated", () => {
  const base: HttpWorkspace = {
    v: 1, selectedId: "r", selectedFolderId: null, sidebarWidth: 240, folders: [],
    requests: [{ id: "r", folderId: null, name: "", method: "POST", url: "", params: [], headers: [], body: "", bodyFormat: "text",
      timeoutMs: 30000, followRedirects: false, bodyMode: "formdata", binary: file, graphql: { query: "", variables: "" },
      formdata: [{ name: "a", value: "", enabled: true, kind: "file", file }, { name: "b", value: "1", enabled: true, kind: "text" }] }],
  };
  assert.notEqual(parseHttpWorkspace(structuredClone(base)), null);
  const broken = (patch: Record<string, unknown>) => {
    const copy = structuredClone(base) as unknown as { requests: Record<string, unknown>[] };
    Object.assign(copy.requests[0]!, patch);
    return parseHttpWorkspace(copy);
  };
  assert.equal(broken({ bodyMode: "file" }), null);
  assert.equal(broken({ formdata: [{ name: "a", value: "", enabled: true, kind: "blob" }] }), null);
  assert.equal(broken({ binary: { id: "x", name: "a" } }), null);
  assert.equal(broken({ graphql: { query: 1, variables: "" } }), null);
});
