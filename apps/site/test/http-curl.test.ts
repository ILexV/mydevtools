import { test } from "node:test";
import assert from "node:assert/strict";
import { CurlParseError, looksLikeCurl, parseCurl } from "../src/tools/http-curl.ts";
import { codeRequest, generateCode, shellQuote, type CodeRequest } from "../src/tools/http-codegen.ts";
import { buildHttpRequest } from "../src/tools/http-auth.ts";

const fails = (command: string, code: string) =>
  assert.throws(() => parseCurl(command), (error: unknown) => error instanceof CurlParseError && error.code === code);

test("Chrome «Copy as cURL (bash)» with $'…' body", () => {
  const { fields, ignored } = parseCurl(`curl 'https://api.example.com/v1/items?page=2&q=a%20b' \\
  -H 'accept: application/json' \\
  -H 'content-type: application/json' \\
  -H 'content-length: 99' \\
  --data-raw $'{"name":"it\\'s","n":1,"u":"\\u00e9\\n"}' \\
  --compressed`);
  assert.equal(fields.method, "POST");
  assert.equal(fields.url, "https://api.example.com/v1/items?page=2&q=a%20b");
  assert.deepEqual(fields.params.map((row) => [row.name, row.value]), [["page", "2"], ["q", "a b"]]);
  assert.deepEqual(fields.headers.map((row) => row.name), ["accept", "content-type"]);
  assert.equal(fields.bodyMode, "raw");
  assert.equal(fields.bodyFormat, "json");
  assert.equal(fields.body, "{\"name\":\"it's\",\"n\":1,\"u\":\"é\n\"}");
  assert.deepEqual(ignored, []);
});

test("Chrome «Copy as cURL (cmd)» with ^ escapes", () => {
  const { fields } = parseCurl(`curl ^"https://api.example.com/x?a=1^&b=2^" ^
  -H ^"accept: */*^" ^
  -H ^"content-type: application/json^" ^
  --data-raw ^"^{^\\^"a^\\^":^\\^"x y^\\^"^}^"`);
  assert.equal(fields.url, "https://api.example.com/x?a=1&b=2");
  assert.deepEqual(fields.headers.map((row) => `${row.name}: ${row.value}`), ["accept: */*", "content-type: application/json"]);
  assert.equal(fields.body, "{\"a\":\"x y\"}");
});

test("short options, form data in pairs, auth, timeout and options the client cannot honour", () => {
  const { fields, ignored } = parseCurl("curl -sSL -XPUT -u 'bob:pa:ss' -m 5 example.com/a -d 'a=1' -d 'b=x%20y+z' -k --proxy http://p:1 -X TRACE");
  assert.equal(fields.method, "PUT");
  assert.equal(fields.url, "http://example.com/a");
  assert.equal(fields.bodyMode, "urlencoded");
  assert.deepEqual(fields.urlencoded?.map((row) => [row.name, row.value]), [["a", "1"], ["b", "x y z"]]);
  assert.deepEqual(fields.auth, { type: "basic", username: "bob", password: "pa:ss" });
  assert.equal(fields.timeoutMs, 5000);
  assert.equal(fields.followRedirects, true);
  assert.deepEqual(ignored, ["-k", "--proxy", "-X TRACE"]);
});

test("multipart fields, files to pick again and a dropped boundary header", () => {
  const { fields, files } = parseCurl(`curl -F 'name=John' -F 'pic=@"/tmp/a b.png";type=image/png' --form-string 'raw=@x' \
    -H 'Content-Type: multipart/form-data; boundary=x' https://e.com/up`);
  assert.equal(fields.method, "POST");
  assert.equal(fields.bodyMode, "formdata");
  assert.deepEqual(fields.formdata?.map((row) => [row.name, row.kind, row.value]), [["name", "text", "John"], ["pic", "file", ""], ["raw", "text", "@x"]]);
  assert.deepEqual(files, ["/tmp/a b.png"]);
  assert.deepEqual(fields.headers, []);
});

test("-G moves data into the query; --json and binary uploads", () => {
  const get = parseCurl("curl -G https://e.com/s -d q=1 --data-urlencode 'w=a b&c'").fields;
  assert.equal(get.method, "GET");
  assert.equal(get.url, "https://e.com/s?q=1&w=a%20b%26c");
  assert.equal(get.bodyMode, "none");

  const json = parseCurl("curl --json '{\"a\":1}' https://e.com").fields;
  assert.deepEqual(json.headers.map((row) => `${row.name}: ${row.value}`), ["Content-Type: application/json", "Accept: application/json"]);
  assert.equal(json.bodyMode, "raw");
  assert.equal(json.bodyFormat, "json");

  const binary = parseCurl("curl --data-binary @dump.bin https://e.com -H 'Content-Type: application/octet-stream'");
  assert.equal(binary.fields.bodyMode, "binary");
  assert.deepEqual(binary.files, ["dump.bin"]);
  const upload = parseCurl("curl -T report.pdf https://e.com/r");
  assert.equal(upload.fields.method, "PUT");
  assert.deepEqual(upload.files, ["report.pdf"]);

  const text = parseCurl("curl -d 'hello world' https://e.com").fields;
  assert.equal(text.bodyMode, "raw");
  assert.equal(text.body, "hello world");
  assert.equal(parseCurl("curl -I https://e.com").fields.method, "HEAD");
});

test("not a curl command, no URL and unclosed quotes are typed errors", () => {
  assert.equal(looksLikeCurl("  curl https://x"), true);
  assert.equal(looksLikeCurl("https://x"), false);
  fails("wget https://x", "not_curl");
  fails("curl -H 'a: b'", "no_url");
  fails("curl 'https://x", "quote");
});

const sample: CodeRequest = {
  method: "POST", url: "https://api.example.com/v1/it's?q=1",
  headers: [{ name: "Content-Type", value: "application/json" }, { name: "X-Empty", value: "" }],
  body: { kind: "text", text: "{\"name\":\"O'Neil\",\"city\":\"Омск\"}" },
  timeoutMs: 2500, followRedirects: false,
};

test("cURL snippet quotes for the shell", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(generateCode("curl", sample), [
    "curl -X POST 'https://api.example.com/v1/it'\\''s?q=1'",
    "--max-time 2.5",
    "-H 'Content-Type: application/json'",
    "-H 'X-Empty;'",
    "--data-raw '{\"name\":\"O'\\''Neil\",\"city\":\"Омск\"}'",
  ].join(" \\\n  "));
});

test("fetch, Python and HTTPie snippets", () => {
  const fetchCode = generateCode("fetch", { ...sample, basicAuth: { username: "u", password: "{{secret:pw}}" } });
  assert.match(fetchCode, /^const response = await fetch\("https:\/\/api\.example\.com\/v1\/it's\?q=1", \{\n  method: "POST",/u);
  assert.match(fetchCode, /"Authorization": "Basic " \+ btoa\("u:\{\{secret:pw\}\}"\),/u);
  assert.match(fetchCode, /redirect: "manual",\n  signal: AbortSignal\.timeout\(2500\),/u);

  const py = generateCode("python", sample);
  assert.match(py, /data = "\{\\"name\\":\\"O'Neil\\",\\"city\\":\\"Омск\\"\}"\.encode\("utf-8"\)/u);
  assert.match(py, /requests\.request\("POST", url, headers=headers, data=data, timeout=2\.5, allow_redirects=False\)/u);

  const form: CodeRequest = { ...sample, followRedirects: true, headers: [],
    body: { kind: "formdata", parts: [{ name: "a:b", value: "1" }, { name: "pic", file: { name: "p.png", type: "image/png" } }] } };
  assert.equal(generateCode("httpie", form), "http --timeout=2.5 --follow --multipart POST 'https://api.example.com/v1/it'\\''s?q=1' \\\n  'a\\:b=1' \\\n  'pic@p.png;type=image/png'");
  assert.match(generateCode("python", form), /\("pic", \("p\.png", open\("p\.png", "rb"\), "image\/png"\)\),/u);
  assert.match(generateCode("fetch", form), /^import \{ openAsBlob \} from "node:fs";/u);
  assert.match(generateCode("curl", form), /-F 'pic=@"p\.png";type=image\/png'/u);
  assert.match(generateCode("httpie", { ...sample, body: { kind: "file", name: "d.bin", type: "" } }), / < d\.bin$/u);
});

test("a generated cURL command imports back to the same request", async () => {
  for (const extra of [
    { bodyMode: "raw" as const, body: "{\"a\":\"it's {{id}}\"}", bodyFormat: "json" as const },
    { bodyMode: "urlencoded" as const, urlencoded: [{ name: "a b", value: "x&y=z", enabled: true }, { name: "n", value: "{{id}}", enabled: true }] },
    { bodyMode: "formdata" as const, formdata: [{ name: "note", value: "@not a file", enabled: true, kind: "text" as const }] },
  ]) {
    const built = await buildHttpRequest({
      method: "PATCH", url: "https://e.com/p?q={{id}}", headers: [{ name: "X-Id", value: "{{id}}" }], body: "", bodyFormat: "text",
      auth: { type: "basic", username: "u", password: "{{secret:pw}}" }, scope: new Map([["id", "7"]]), ...extra,
    });
    const command = generateCode("curl", codeRequest(built, 30000, true));
    const { fields } = parseCurl(command);
    assert.equal(fields.method, "PATCH");
    assert.equal(fields.url, "https://e.com/p?q=7");
    assert.deepEqual(fields.auth, { type: "basic", username: "u", password: "{{secret:pw}}" });
    assert.equal(fields.followRedirects, true);
    assert.equal(fields.bodyMode, extra.bodyMode);
    if (extra.bodyMode === "raw") assert.equal(fields.body, "{\"a\":\"it's 7\"}");
    if (extra.bodyMode === "urlencoded") assert.deepEqual(fields.urlencoded?.map((row) => [row.name, row.value]), [["a b", "x&y=z"], ["n", "7"]]);
    if (extra.bodyMode === "formdata") assert.deepEqual(fields.formdata?.map((row) => row.value), ["@not a file"]);
    assert.equal(fields.headers.find((row) => row.name === "X-Id")?.value, "7");
  }
});
