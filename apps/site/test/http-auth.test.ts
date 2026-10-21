import { test } from "node:test";
import assert from "node:assert/strict";
import { signAwsV4 } from "../src/tools/http-aws-sigv4.ts";
import {
  basicAuthorization,
  buildHttpRequest,
  effectiveAuth,
  HttpBuildError,
  oauthTokenRequest,
  oauthTokenValid,
  parseOAuthToken,
  type BuildInput,
} from "../src/tools/http-auth.ts";
import {
  collectVariables,
  encodeQueryComponent,
  resolveVariables,
  variableNames,
} from "../src/tools/http-variables.ts";
import { isHttpWorkspace, parseHttpWorkspace, type HttpSavedRequest, type HttpWorkspace } from "../src/tools/http-workspace.ts";

function request(id: string, folderId: string | null, extra: Partial<HttpSavedRequest> = {}): HttpSavedRequest {
  return { id, folderId, name: id, method: "GET", url: "https://example.com/", params: [], headers: [], body: "",
    bodyFormat: "text", timeoutMs: 30000, followRedirects: false, ...extra };
}

function workspace(): HttpWorkspace {
  return {
    v: 1, selectedId: "r", selectedFolderId: null, sidebarWidth: 240,
    folders: [
      { id: "api", name: "API", parentId: null, expanded: true,
        auth: { type: "bearer", token: "{{token}}" },
        variables: [{ name: "baseUrl", value: "https://api.example.com", enabled: true }, { name: "path", value: "v1", enabled: true }] },
      { id: "users", name: "Users", parentId: "api", expanded: true, auth: { type: "inherit" },
        variables: [{ name: "path", value: "v2", enabled: true }, { name: "off", value: "x", enabled: false }] },
    ],
    requests: [request("r", "users")],
    globals: [{ name: "baseUrl", value: "https://global.example.com", enabled: true }, { name: "token", value: "g-token", enabled: true }],
    environments: [{ id: "prod", name: "Prod", variables: [{ name: "token", value: "prod-token", enabled: true }] }],
    activeEnvironmentId: "prod",
  };
}

test("variables: environment beats nearer folders, folders beat globals", () => {
  const scope = collectVariables(workspace(), "users");
  assert.equal(scope.get("baseUrl"), "https://api.example.com");
  assert.equal(scope.get("path"), "v2");
  assert.equal(scope.get("token"), "prod-token");
  assert.equal(scope.has("off"), false);
  assert.equal(collectVariables({ ...workspace(), activeEnvironmentId: null }, null).get("token"), "g-token");
});

test("variables resolve nested values and leave unknowns, cycles and secrets literal", () => {
  const scope = new Map([["host", "{{scheme}}://api"], ["scheme", "https"], ["a", "{{b}}"], ["b", "{{a}}"]]);
  const unresolved = new Set<string>();
  assert.equal(resolveVariables("{{ host }}/{{missing}}/{{secret:TOKEN}}", scope, { unresolved }),
    "https://api/{{missing}}/{{secret:TOKEN}}");
  assert.equal(resolveVariables("{{a}}", scope, { unresolved }), "{{a}}");
  assert.deepEqual([...unresolved].sort(), ["a", "missing"]);
  const now = () => new Date("2026-10-21T10:00:00Z");
  assert.equal(resolveVariables("{{$timestamp}} {{$isoTimestamp}}", scope, { now }), "1792576800 2026-10-21T10:00:00.000Z");
  assert.match(resolveVariables("{{$guid}}", scope), /^[0-9a-f-]{36}$/);
  assert.deepEqual(variableNames("{{a}} {{secret:x}} {{ a }} {{b}}"), ["a", "b"]);
  assert.equal(encodeQueryComponent("a b&{{token}}"), "a%20b%26{{token}}");
});

test("auth is inherited from the nearest folder that sets one", () => {
  const ws = workspace();
  assert.deepEqual(effectiveAuth(ws, ws.requests[0]!), { auth: { type: "bearer", token: "{{token}}" }, source: { kind: "folder", id: "api" } });
  assert.deepEqual(effectiveAuth(ws, { folderId: "users", auth: { type: "none" } }).source, { kind: "request" });
  assert.deepEqual(effectiveAuth(ws, { folderId: null }), { auth: { type: "none" }, source: { kind: "default" } });
});

const input = (extra: Partial<BuildInput>): BuildInput => ({
  method: "GET", url: "{{baseUrl}}/{{path}}", headers: [], body: "", bodyFormat: "text",
  auth: { type: "none" }, scope: collectVariables(workspace(), "users"), ...extra,
});

test("build: bearer, api key and basic replace user headers; secrets stay for the agent", async () => {
  const bearer = await buildHttpRequest(input({ auth: { type: "bearer", token: "{{token}}" },
    headers: [{ name: "authorization", value: "old" }, { name: "X-{{path}}", value: "{{nope}}" }] }));
  assert.equal(bearer.url, "https://api.example.com/v2");
  assert.deepEqual(bearer.headers, [{ name: "X-v2", value: "{{nope}}" }, { name: "Authorization", value: "Bearer prod-token" }]);
  assert.deepEqual(bearer.unresolved, ["nope"]);

  const query = await buildHttpRequest(input({ url: "{{baseUrl}}/x?a=1#top", auth: { type: "apikey", key: "api key", value: "{{secret:K}}", in: "query" } }));
  assert.equal(query.url, "https://api.example.com/x?a=1&api%20key={{secret:K}}#top");

  const plain = await buildHttpRequest(input({ auth: { type: "basic", username: "alice", password: "пароль" } }));
  assert.deepEqual(plain.headers.at(-1), { name: "Authorization", value: `Basic ${Buffer.from("alice:пароль").toString("base64")}` });
  const viaAgent = await buildHttpRequest(input({ auth: { type: "basic", username: "alice", password: "{{secret:PW}}" } }));
  assert.deepEqual(viaAgent.basicAuth, { username: "alice", password: "{{secret:PW}}" });
  assert.equal(viaAgent.headers.some((header) => header.name === "Authorization"), false);

  const json = await buildHttpRequest(input({ method: "POST", body: "{\"t\":\"{{token}}\"}", bodyFormat: "json" }));
  assert.equal(new TextDecoder().decode(json.body), "{\"t\":\"prod-token\"}");
  assert.deepEqual(json.headers, [{ name: "Content-Type", value: "application/json" }]);
});

test("build: invalid URL, header and incomplete auth are typed errors", async () => {
  const code = async (extra: Partial<BuildInput>) => {
    try {
      await buildHttpRequest(input(extra));
      return "ok";
    } catch (error) {
      return error instanceof HttpBuildError ? error.code : String(error);
    }
  };
  assert.equal(await code({ url: "{{unknown}}/x" }), "url");
  assert.equal(await code({ headers: [{ name: "Bad Name", value: "x" }] }), "headers");
  assert.equal(await code({ auth: { type: "bearer", token: "  " } }), "auth_incomplete");
  assert.equal(await code({ auth: { type: "awsv4", accessKey: "A", secretKey: "{{secret:S}}", sessionToken: "", region: "us-east-1", service: "s3" } }), "aws_secret");
  assert.equal(await code({ body: "{{secret:S}}", auth: { type: "awsv4", accessKey: "A", secretKey: "S", sessionToken: "", region: "us-east-1", service: "s3" } }), "aws_secret");
  assert.equal(await code({ auth: { type: "oauth2", tokenUrl: "https://t", clientId: "c", clientSecret: "s", scope: "", clientAuth: "header" } }), "oauth_token");
});

test("build: OAuth token goes into Authorization with its type", async () => {
  let seen = "";
  const built = await buildHttpRequest(input({
    auth: { type: "oauth2", tokenUrl: "{{baseUrl}}/token", clientId: "id", clientSecret: "{{secret:CS}}", scope: "read", clientAuth: "body" },
    oauthToken: async (config) => {
      seen = config.tokenUrl;
      return { accessToken: "abc", tokenType: "Bearer", expiresAt: null };
    },
  }));
  assert.equal(seen, "https://api.example.com/token");
  assert.deepEqual(built.headers, [{ name: "Authorization", value: "Bearer abc" }]);
});

test("OAuth client credentials request and token parsing", () => {
  const body = oauthTokenRequest({ tokenUrl: "https://t/token", clientId: "my app", clientSecret: "{{secret:CS}}", scope: "a b", clientAuth: "body" });
  assert.equal(body.body, "grant_type=client_credentials&scope=a%20b&client_id=my%20app&client_secret={{secret:CS}}");
  assert.equal(body.basicAuth, undefined);
  const header = oauthTokenRequest({ tokenUrl: "https://t/token", clientId: "id", clientSecret: "{{secret:CS}}", scope: "", clientAuth: "header" });
  assert.equal(header.body, "grant_type=client_credentials");
  assert.deepEqual(header.basicAuth, { username: "id", password: "{{secret:CS}}" });
  assert.deepEqual(basicAuthorization("id", "s"), { header: { name: "Authorization", value: "Basic aWQ6cw==" } });

  const token = parseOAuthToken(200, '{"access_token":"x","token_type":"bearer","expires_in":"60"}', 1000);
  assert.deepEqual(token, { accessToken: "x", tokenType: "Bearer", expiresAt: 61000 });
  assert.equal(oauthTokenValid(token, 1000), true);
  assert.equal(oauthTokenValid(token, 40000), false);
  assert.equal(oauthTokenValid({ ...token, expiresAt: null }, 1e12), true);
  assert.throws(() => parseOAuthToken(400, '{"error":"invalid_client","error_description":"bad secret"}'),
    (error: unknown) => error instanceof HttpBuildError && error.message === "HTTP 400 · invalid_client: bad secret");
  assert.throws(() => parseOAuthToken(200, "not json"), HttpBuildError);
});

test("AWS SigV4 matches the AWS test suite vectors", async () => {
  const base = { headers: [], accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: "", region: "us-east-1", service: "service", now: new Date("2015-08-30T12:36:00Z") };
  const sign = async (method: string, path: string, body = "", headers: { name: string; value: string }[] = []) =>
    (await signAwsV4({ ...base, method, headers, body: new TextEncoder().encode(body), url: new URL(`https://example.amazonaws.com${path}`) }))[0]!.value;
  assert.match(await sign("GET", "/"), /SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/);
  assert.match(await sign("GET", "/?Param2=value2&Param1=value1"), /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
  assert.match(await sign("POST", "/", "Param1=value1", [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }]),
    /SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a$/);
  const s3 = await signAwsV4({ ...base, service: "s3", sessionToken: "TOKEN", method: "GET", body: new Uint8Array(), url: new URL("https://b.s3.amazonaws.com/a b") });
  assert.deepEqual(s3.map((header) => header.name), ["Authorization", "X-Amz-Date", "X-Amz-Security-Token", "X-Amz-Content-Sha256"]);
  assert.match(s3[0]!.value, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
});

test("workspace validation accepts the new optional fields and rejects broken ones", () => {
  const ws = workspace();
  assert.equal(isHttpWorkspace(ws), true);
  assert.equal(parseHttpWorkspace(JSON.parse(JSON.stringify(ws))) !== null, true);
  assert.equal(isHttpWorkspace({ ...ws, activeEnvironmentId: "missing" }), false);
  assert.equal(isHttpWorkspace({ ...ws, environments: [{ id: "a", name: "A", variables: [] }, { id: "a", name: "B", variables: [] }], activeEnvironmentId: null }), false);
  assert.equal(isHttpWorkspace({ ...ws, requests: [request("r", "users", { auth: { type: "apikey", key: "k", value: "v", in: "cookie" } as never })] }), false);
  assert.equal(isHttpWorkspace({ ...ws, requests: [request("r", "users", { auth: { type: "magic" } as never })] }), false);
  assert.equal(isHttpWorkspace({ ...ws, globals: [{ name: "x" }] as never }), false);
});
