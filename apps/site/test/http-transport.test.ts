import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentProxy, certificateFor, formatPhaseMs, hostMatches, proxyBypass, proxyUrlError, timingPhases, transportFields,
} from "../src/tools/http-transport-options.ts";
import { parseCurl } from "../src/tools/http-curl.ts";
import { codeRequest, generateCode } from "../src/tools/http-codegen.ts";
import { exportPostman, importPostman, POSTMAN_SCHEMA } from "../src/tools/http-postman.ts";
import { requestFingerprint } from "../src/tools/http-tabs.ts";
import { parseHttpWorkspace, type HttpProxySettings, type HttpSavedRequest, type HttpWorkspace } from "../src/tools/http-workspace.ts";
import type { LocalHttpResponse } from "../src/scripts/local-agent.ts";

const proxy = (overrides: Partial<HttpProxySettings> = {}): HttpProxySettings =>
  ({ enabled: true, url: "http://proxy.corp:3128", username: "", password: "", bypass: "", ...overrides });

test("proxy URL accepts only http://host:port", () => {
  assert.equal(proxyUrlError("http://proxy.corp:3128"), null);
  assert.equal(proxyUrlError(" http://10.0.0.1:8080/ "), null);
  assert.equal(proxyUrlError("https://proxy.corp:3128"), "scheme");
  assert.equal(proxyUrlError("socks5://proxy.corp:1080"), "scheme");
  assert.equal(proxyUrlError("http://user:pw@proxy.corp:3128"), "host");
  assert.equal(proxyUrlError("proxy.corp:3128"), "scheme");
  assert.equal(proxyUrlError("not a url"), "host");
  assert.equal(proxyUrlError("http://proxy.corp:3128/pac"), "path");
});

test("proxy for the agent: off, invalid and empty send none; bypass is split and lowercased", () => {
  assert.equal(agentProxy(undefined), undefined);
  assert.equal(agentProxy(proxy({ enabled: false })), undefined);
  assert.equal(agentProxy(proxy({ url: "  " })), undefined);
  assert.equal(agentProxy(proxy({ url: "https://p:1" })), undefined);
  assert.deepEqual(agentProxy(proxy()), { url: "http://proxy.corp:3128" });
  assert.deepEqual(agentProxy(proxy({ username: "u", password: "p", bypass: "LocalHost, *.Corp.example  10.0.0.5,,localhost" })), {
    url: "http://proxy.corp:3128", username: "u", password: "p", bypass: ["localhost", "*.corp.example", "10.0.0.5"],
  });
  assert.deepEqual(proxyBypass(""), []);
});

test("only non-default transport fields are sent, so older agents keep working", () => {
  assert.deepEqual(transportFields({}, undefined), {});
  assert.deepEqual(transportFields({ verifyTls: true, httpVersion: "auto" }, proxy({ enabled: false })), {});
  assert.deepEqual(transportFields({ verifyTls: false, httpVersion: "http2" }, proxy()), {
    verifyTls: false, httpVersion: "http2", proxy: { url: "http://proxy.corp:3128" },
  });
});

const response = (overrides: Partial<LocalHttpResponse>): LocalHttpResponse =>
  ({ status: 200, statusText: "OK", url: "", headers: [], bodyBase64: "", elapsedMs: 0, ...overrides });

test("timing phases in order; the uncovered rest is redirects and agent work", () => {
  assert.equal(timingPhases(response({})), null);
  const https = timingPhases(response({ elapsedMs: 130,
    timings: { dnsMs: 4.2, connectMs: 10, tlsMs: 20.5, firstByteMs: 60, downloadMs: 5.3 } }));
  assert.deepEqual(https?.map((entry) => entry.phase), ["dns", "connect", "tls", "firstByte", "download", "other"]);
  assert.equal(Math.round(https!.at(-1)!.ms), 30);
  const http = timingPhases(response({ elapsedMs: 15, timings: { dnsMs: 0, connectMs: 1, tlsMs: null, firstByteMs: 13, downloadMs: 1 } }));
  assert.deepEqual(http?.map((entry) => entry.phase), ["dns", "connect", "firstByte", "download"]);
  assert.equal(formatPhaseMs(4.25), "4.3 ms");
  assert.equal(formatPhaseMs(0), "0.0 ms");
  assert.equal(formatPhaseMs(1234.6), "1235 ms");
});

test("cURL -k, --http1.1 and --http2 map to request settings and back", () => {
  assert.deepEqual([parseCurl("curl -k https://a.example").fields.verifyTls, parseCurl("curl https://a.example").fields.verifyTls], [false, undefined]);
  assert.equal(parseCurl("curl --http1.1 https://a.example").fields.httpVersion, "http1");
  assert.equal(parseCurl("curl --http2-prior-knowledge https://a.example").fields.httpVersion, "http2");
  const built = { method: "GET", url: "https://a.example/", headers: [], bodySpec: { kind: "none" as const } };
  const snippet = generateCode("curl", codeRequest(built, 30000, false, { verifyTls: false, httpVersion: "http2" }));
  assert.match(snippet, /\n {2}-k \\/u);
  assert.match(snippet, /\n {2}--http2 \\/u);
  assert.match(generateCode("python", codeRequest(built, 30000, false, { verifyTls: false })), /verify=False/u);
  assert.doesNotMatch(generateCode("curl", codeRequest(built, 30000, false, { verifyTls: true, httpVersion: "auto" })), /-k|--http/u);
});

const request = (overrides: Partial<HttpSavedRequest>): HttpSavedRequest => ({
  id: "r1", folderId: null, name: "R", method: "GET", url: "https://a.example", params: [], headers: [], body: "",
  bodyFormat: "text", timeoutMs: 30000, followRedirects: true, ...overrides,
});

test("Postman strictSSL and protocolVersion round trip through protocolProfileBehavior", () => {
  const imported = importPostman({
    info: { name: "C", schema: POSTMAN_SCHEMA },
    item: [{ name: "R", protocolProfileBehavior: { strictSSL: false, protocolVersion: "http1" }, request: { method: "GET", url: "https://a.example" } }],
  }, null, (() => { let n = 0; return () => `id${++n}`; })(), "C");
  assert.equal(imported.requests[0]!.verifyTls, false);
  assert.equal(imported.requests[0]!.httpVersion, "http1");
  const workspace: HttpWorkspace = { v: 1, selectedId: "r1", requests: [request({ verifyTls: false, httpVersion: "http2", followRedirects: false })],
    folders: [], selectedFolderId: null, sidebarWidth: 240 };
  const exported = exportPostman(workspace, null, "All", "x") as { item: { protocolProfileBehavior?: unknown }[] };
  assert.deepEqual(exported.item[0]!.protocolProfileBehavior, { followRedirects: false, strictSSL: false, protocolVersion: "http2" });
  workspace.requests[0] = request({});
  const plain = exportPostman(workspace, null, "All", "x") as { item: { protocolProfileBehavior?: unknown }[] };
  assert.equal(plain.item[0]!.protocolProfileBehavior, undefined);
});

test("workspace keeps request transport settings and the proxy; defaults leave no unsaved mark", () => {
  const workspace: HttpWorkspace = { v: 1, selectedId: "r1", requests: [request({ verifyTls: false, httpVersion: "http2" })],
    folders: [], selectedFolderId: null, sidebarWidth: 240, proxy: proxy({ bypass: "localhost" }) };
  assert.deepEqual(parseHttpWorkspace(structuredClone(workspace)), workspace);
  assert.equal(parseHttpWorkspace({ ...workspace, requests: [request({ httpVersion: "http3" as never })] }), null);
  assert.equal(parseHttpWorkspace({ ...workspace, proxy: { enabled: "yes" } }), null);
  assert.equal(requestFingerprint(request({})), requestFingerprint(request({ verifyTls: true, httpVersion: "auto" })));
  assert.notEqual(requestFingerprint(request({})), requestFingerprint(request({ verifyTls: false })));
});

test("client certificate host rules match the agent's", () => {
  assert.equal(hostMatches("api.example.com", "api.example.com"), true);
  assert.equal(hostMatches("api.example.com", "www.example.com"), false);
  assert.equal(hostMatches("*.example.com", "a.b.example.com"), true);
  assert.equal(hostMatches("*.example.com", "example.com"), false);
  assert.equal(hostMatches("*.example.com", "badexample.com"), false);
});

test("the first certificate by name covering an https URL is picked", () => {
  const certificates = [
    { name: "zeta", hosts: ["*.corp.local"] },
    { name: "alpha", hosts: ["api.corp.local"] },
    { name: "beta", hosts: ["other.example"] },
  ];
  assert.equal(certificateFor("https://api.corp.local/v1", certificates), "alpha");
  assert.equal(certificateFor("https://web.corp.local/", certificates), "zeta");
  assert.equal(certificateFor("https://API.Corp.Local:8443/", certificates), "alpha");
  assert.equal(certificateFor("http://api.corp.local/", certificates), undefined);
  assert.equal(certificateFor("https://nowhere.example/", certificates), undefined);
  assert.equal(certificateFor("not a url", certificates), undefined);
  assert.equal(certificateFor("https://api.corp.local/", []), undefined);
});
