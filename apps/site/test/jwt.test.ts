import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  algFromHeader,
  base64UrlEncode,
  buildSigningInput,
  classifyAlg,
  jsonObjectProblem,
  normalizeToken,
  timeClaims,
} from "../src/tools/jwt.ts";

// jwt.io reference token (HS256, secret "your-256-bit-secret").
const JWT_IO =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

const hmac = (alg: string, key: string, data: string) =>
  createHmac(`sha${alg.slice(2)}`, key).update(data).digest("base64url");

test("buildSigningInput: encoder defaults reproduce the jwt.io signing input + signature", () => {
  const r = buildSigningInput(
    '{"alg":"HS256","typ":"JWT"}',
    '{"sub":"1234567890","name":"John Doe","iat":1516239022}',
    "HS256",
  );
  assert.ok(r.ok);
  const [h, p, sig] = JWT_IO.split(".");
  assert.equal(r.input, `${h}.${p}`);
  // Same HMAC the WASM computes (jwt_sign_input, Rust test pins the same vector).
  assert.equal(hmac("HS256", "your-256-bit-secret", r.input), sig);
});

test("buildSigningInput: claim order, extra header fields and pretty input are preserved/compacted", () => {
  const r = buildSigningInput('{\n  "typ": "JWT",\n  "kid": "key-1",\n  "alg": "HS256"\n}', '{ "z": 1, "a": [1, 2] }', "HS512");
  assert.ok(r.ok);
  assert.equal(r.header, '{"typ":"JWT","kid":"key-1","alg":"HS512"}');
  assert.equal(r.payload, '{"z":1,"a":[1,2]}');
});

test("buildSigningInput: alg is prepended when the header has none", () => {
  const r = buildSigningInput('{"typ":"JWT"}', "{}", "HS384");
  assert.ok(r.ok);
  assert.equal(r.header, '{"alg":"HS384","typ":"JWT"}');
});

test("buildSigningInput: invalid JSON / non-object header or payload are rejected", () => {
  assert.deepEqual(buildSigningInput("{", "{}", "HS256"), { ok: false, field: "header", reason: "json" });
  assert.deepEqual(buildSigningInput("null", "{}", "HS256"), { ok: false, field: "header", reason: "object" });
  assert.deepEqual(buildSigningInput("[]", "{}", "HS256"), { ok: false, field: "header", reason: "object" });
  assert.deepEqual(buildSigningInput("{}", "123", "HS256"), { ok: false, field: "payload", reason: "object" });
  assert.deepEqual(buildSigningInput("{}", "", "HS256"), { ok: false, field: "payload", reason: "json" });
  assert.equal(jsonObjectProblem('"str"'), "object");
  assert.equal(jsonObjectProblem("{}"), null);
});

test("base64UrlEncode: UTF-8, URL-safe alphabet, no padding", () => {
  assert.equal(base64UrlEncode('{"name":"Jöhn 😀"}'), Buffer.from('{"name":"Jöhn 😀"}').toString("base64url"));
  assert.equal(base64UrlEncode("ÿþ"), "w7_Dvg"); // '_' and no '='
  assert.equal(base64UrlEncode(""), "");
});

test("normalizeToken: strips Bearer prefix, whitespace and line breaks", () => {
  assert.equal(normalizeToken(`  Bearer ${JWT_IO.slice(0, 20)}\n${JWT_IO.slice(20)}  `), JWT_IO);
  assert.equal(normalizeToken("   "), "");
});

test("classifyAlg / algFromHeader", () => {
  assert.equal(classifyAlg("HS256"), "hmac");
  assert.equal(classifyAlg("RS512"), "rsa");
  assert.equal(classifyAlg("none"), "none");
  assert.equal(classifyAlg("NONE"), "none");
  assert.equal(classifyAlg("ES256"), "unsupported");
  assert.equal(classifyAlg("HS1024"), "unsupported");
  assert.equal(algFromHeader('{"alg":"RS256"}'), "RS256");
  assert.equal(algFromHeader('{"alg":""}'), null);
  assert.equal(algFromHeader("null"), null);
  assert.equal(algFromHeader("garbage"), null);
});

test("timeClaims: expired exp, future nbf, iat never flagged; junk ignored", () => {
  const now = 1_700_000_000;
  const claims = timeClaims(JSON.stringify({ iat: now - 10, nbf: now + 60, exp: now - 1, sub: "x" }), now);
  assert.deepEqual(claims, [
    { claim: "exp", seconds: now - 1, problem: true },
    { claim: "nbf", seconds: now + 60, problem: true },
    { claim: "iat", seconds: now - 10, problem: false },
  ]);
  assert.deepEqual(timeClaims(JSON.stringify({ exp: now + 3600, nbf: now }), now), [
    { claim: "exp", seconds: now + 3600, problem: false },
    { claim: "nbf", seconds: now, problem: false },
  ]);
  assert.deepEqual(timeClaims(JSON.stringify({ exp: "tomorrow", iat: null }), now), []);
  assert.deepEqual(timeClaims('"string payload"', now), []);
  assert.deepEqual(timeClaims("not json", now), []);
});
