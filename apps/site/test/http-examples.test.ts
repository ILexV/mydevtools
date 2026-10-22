import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFromResponse, responseFromExample } from "../src/tools/http-examples.ts";
import { exportPostman, importPostman } from "../src/tools/http-postman.ts";
import { HTTP_EXAMPLE_MAX_CHARS, parseHttpWorkspace, type HttpExample, type HttpWorkspace } from "../src/tools/http-workspace.ts";

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const response = (body: string, type = "application/json; charset=utf-8", status = 200) => ({
  status, statusText: status === 200 ? "OK" : "Not Found", url: "https://e.com/x", elapsedMs: 9,
  headers: [{ name: "Content-Type", value: type }], bodyBase64: base64(body),
});

test("text responses become examples with unique names; binary, large and extra ones are refused", () => {
  const first = exampleFromResponse(response("{\"ru\":\"да\"}"), [], "e1", 1000) as HttpExample;
  assert.deepEqual(first, { id: "e1", name: "200 OK", savedAt: 1000, status: 200, statusText: "OK",
    headers: [{ name: "Content-Type", value: "application/json; charset=utf-8" }], body: "{\"ru\":\"да\"}" });
  const second = exampleFromResponse(response("{}"), [first], "e2") as HttpExample;
  assert.equal(second.name, "200 OK (2)");
  assert.deepEqual(exampleFromResponse(response("\u0000", "image/png"), [], "x"), { error: "binary" });
  assert.deepEqual(exampleFromResponse(response("a".repeat(HTTP_EXAMPLE_MAX_CHARS + 1), "text/plain"), [], "x"), { error: "size" });
  assert.deepEqual(exampleFromResponse(response("{}"), Array.from({ length: 20 }, () => first), "x"), { error: "limit" });

  const shown = responseFromExample({ ...first, headers: [{ name: "content-type", value: "text/plain; charset=windows-1251" }] });
  assert.equal(Buffer.from(shown.bodyBase64, "base64").toString("utf8"), "{\"ru\":\"да\"}");
  assert.equal(shown.headers[0]!.value, "text/plain; charset=utf-8");
});

test("examples are validated in the workspace and carried through Postman import and export", () => {
  const example = exampleFromResponse(response("{\"id\":1}", "application/json", 404), [], "e1", 5) as HttpExample;
  const workspace: HttpWorkspace = { v: 1, selectedId: "r1", selectedFolderId: null, sidebarWidth: 240, folders: [],
    requests: [{ id: "r1", folderId: null, name: "Get", method: "GET", url: "https://e.com/x", params: [], headers: [], body: "",
      bodyFormat: "text", timeoutMs: 1000, followRedirects: true, examples: [example] }] };
  assert.notEqual(parseHttpWorkspace(structuredClone(workspace)), null);
  assert.equal(parseHttpWorkspace({ ...structuredClone(workspace), requests: [{ ...workspace.requests[0]!, examples: [{ id: "x" }] }] }), null);

  const exported = exportPostman(workspace, null, "C", "id") as { item: { response: Record<string, unknown>[] }[] };
  assert.deepEqual(exported.item[0]!.response[0], { name: "404 Not Found", status: "Not Found", code: 404, _postman_previewlanguage: "json",
    header: [{ key: "Content-Type", value: "application/json" }], cookie: [], body: "{\"id\":1}" });
  let next = 0;
  const back = importPostman(JSON.parse(JSON.stringify(exported)), null, () => `n${++next}`, "C");
  const { id: _id, savedAt: _saved, ...rest } = back.requests[0]!.examples![0]!;
  const { id: _origin, savedAt: _when, ...expected } = example;
  assert.deepEqual(rest, expected);
});
