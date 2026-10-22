import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentCookieStore, applyCookieChanges, cookieError, groupCookiesByDomain, HTTP_COOKIES_DOCUMENT, MAX_COOKIES, MAX_JAR_BYTES,
  normalizeCookieDomain, parseCookies, removeCookieDomain, saveCookie, type HttpCookie,
} from "../src/tools/http-cookies.ts";
import type { VaultDocumentClient } from "../src/tools/http-vault-document.ts";
import { exportPostman, importPostman, POSTMAN_SCHEMA } from "../src/tools/http-postman.ts";
import { requestFingerprint } from "../src/tools/http-tabs.ts";
import { parseHttpWorkspace, type HttpSavedRequest, type HttpWorkspace } from "../src/tools/http-workspace.ts";

const NOW = 1_760_000_000;
const cookie = (name: string, overrides: Partial<HttpCookie> = {}): HttpCookie =>
  ({ name, value: "v", domain: "example.com", path: "/", ...overrides });

test("agent changes upsert by name, domain and path; a past expiry deletes", () => {
  const jar = [cookie("sid", { value: "old" }), cookie("sid", { path: "/api" }), cookie("theme")];
  const next = applyCookieChanges(jar, [
    cookie("sid", { value: "new", httpOnly: true, hostOnly: false, secure: false }),
    cookie("theme", { expires: 0 }),
    cookie("fresh", { expires: NOW + 60, sameSite: "Lax" }),
    cookie("ghost", { expires: 0 }),
    cookie("bad name"),
  ], NOW);
  assert.deepEqual(next, [
    { name: "sid", value: "new", domain: "example.com", path: "/", httpOnly: true },
    cookie("sid", { path: "/api" }),
    cookie("fresh", { expires: NOW + 60, sameSite: "Lax" }),
  ]);
  // Expired cookies already in the jar are dropped on the next change.
  assert.deepEqual(applyCookieChanges([cookie("old", { expires: NOW - 1 })], [], NOW), []);
});

test("the jar keeps the agent's limits by dropping the oldest", () => {
  const full = Array.from({ length: MAX_COOKIES }, (_, index) => cookie(`c${index}`));
  const next = applyCookieChanges(full, [cookie("last")], NOW);
  assert.equal(next.length, MAX_COOKIES);
  assert.equal(next[0]!.name, "c1");
  assert.equal(next.at(-1)!.name, "last");
  const big = Array.from({ length: 70 }, (_, index) => cookie(`b${index}`, { value: "x".repeat(4000) }));
  const trimmed = applyCookieChanges([], big, NOW);
  assert.ok(trimmed.length < 70);
  assert.ok(trimmed.reduce((sum, entry) => sum + entry.name.length + entry.value.length + entry.domain.length + entry.path.length, 0) <= MAX_JAR_BYTES);
  assert.equal(trimmed.at(-1)!.name, "b69");
});

test("cookie validation matches the agent and domains are normalized as typed", () => {
  assert.equal(cookieError(cookie("sid")), null);
  assert.equal(cookieError(cookie("")), "name");
  assert.equal(cookieError(cookie("a=b")), "name");
  assert.equal(cookieError(cookie("кука")), "name");
  assert.equal(cookieError(cookie("a", { value: "x;y" })), "value");
  assert.equal(cookieError(cookie("a", { value: "line\nbreak" })), "value");
  assert.equal(cookieError(cookie("a", { value: "пробел и юникод" })), null);
  assert.equal(cookieError(cookie("a", { domain: ".example.com" })), "domain");
  assert.equal(cookieError(cookie("a", { domain: "Example.com" })), "domain");
  assert.equal(cookieError(cookie("a", { path: "api" })), "path");
  assert.equal(cookieError(cookie("a", { value: "x".repeat(4096) })), "size");
  assert.equal(normalizeCookieDomain("  .Example.COM "), "example.com");
  assert.equal(normalizeCookieDomain("https://API.example.com:8443/path"), "api.example.com");
  assert.equal(normalizeCookieDomain("localhost:3000"), "localhost");
  assert.equal(normalizeCookieDomain("[::1]"), "::1");
  assert.equal(normalizeCookieDomain("[::1]:8080"), "::1");
  assert.equal(normalizeCookieDomain("http://[::1]:8080/"), "::1");
  assert.equal(normalizeCookieDomain("::1"), "::1");
  assert.equal(cookieError(cookie("a", { domain: "::1" })), null);
});

test("stored jars are validated; edits replace the edited cookie; domains group and delete", () => {
  assert.deepEqual(parseCookies({ v: 1, cookies: [cookie("a", { secure: false, expires: NOW })] }), [cookie("a", { expires: NOW })]);
  assert.equal(parseCookies({ v: 1, cookies: [cookie("a", { domain: ".x" })] }), null);
  assert.equal(parseCookies({ v: 1, cookies: [{ ...cookie("a"), sameSite: "lax" }] }), null);
  assert.equal(parseCookies({ v: 1, cookies: [{ ...cookie("a"), expires: 1.5 }] }), null);
  assert.equal(parseCookies({ v: 2, cookies: [] }), null);
  assert.equal(parseCookies([]), null);

  const jar = [cookie("a"), cookie("b", { domain: "api.example.com" }), cookie("c", { path: "/x" })];
  const renamed = saveCookie(jar, cookie("a2", { value: "w" }), jar[0]!, NOW);
  assert.deepEqual(renamed.map((entry) => entry.name), ["b", "c", "a2"]);
  assert.deepEqual(groupCookiesByDomain(renamed).map((group) => [group.domain, group.cookies.map((entry) => entry.name)]),
    [["api.example.com", ["b"]], ["example.com", ["a2", "c"]]]);
  assert.deepEqual(removeCookieDomain(renamed, "example.com").map((entry) => entry.name), ["b"]);
});

class FakeVault implements VaultDocumentClient {
  data: unknown = null;
  revision = 0;
  interfere = false;

  async listDocuments() {
    return this.revision ? [{ name: HTTP_COOKIES_DOCUMENT }] : [];
  }

  async readDocument(name: string) {
    assert.equal(name, HTTP_COOKIES_DOCUMENT);
    return this.revision ? { revision: this.revision, data: structuredClone(this.data) } : null;
  }

  async writeDocument(_name: string, baseRevision: number, data: unknown) {
    if (this.interfere) {
      this.interfere = false;
      this.data = { v: 1, cookies: [...parseCookies(this.data) ?? [], cookie("other")] };
      this.revision++;
    }
    if (baseRevision !== this.revision) throw Object.assign(new Error("conflict"), { code: "revision_conflict" });
    this.data = structuredClone(data);
    return ++this.revision;
  }

  async deleteDocument(_name: string, baseRevision: number) {
    if (baseRevision !== this.revision) throw Object.assign(new Error("conflict"), { code: "revision_conflict" });
    this.data = null;
    this.revision = 0;
  }
}

test("cookies in the agent vault merge with another window's write and clear", async () => {
  const vault = new FakeVault();
  const store = new AgentCookieStore(vault);
  assert.deepEqual(await store.load(), []);
  await store.update((jar) => applyCookieChanges(jar, [cookie("first")], NOW));
  vault.interfere = true;
  const saved = await store.update((jar) => applyCookieChanges(jar, [cookie("second")], NOW));
  assert.deepEqual(saved.map((entry) => entry.name), ["first", "other", "second"]);
  await store.clear();
  assert.equal(vault.revision, 0);
  assert.deepEqual(await store.load(), []);
  await store.clear();
  await store.update(() => [cookie("again")]);
  vault.data = { v: 1, cookies: "broken" };
  await assert.rejects(store.load(), /http-cookies_corrupt/u);
});

const request = (overrides: Partial<HttpSavedRequest>): HttpSavedRequest => ({
  id: "r1", folderId: null, name: "R", method: "GET", url: "https://a.example", params: [], headers: [], body: "",
  bodyFormat: "text", timeoutMs: 30000, followRedirects: true, ...overrides,
});

test("turning the jar off for a request survives the workspace and Postman disableCookies", () => {
  const workspace: HttpWorkspace = { v: 1, selectedId: "r1", requests: [request({ useCookies: false })],
    folders: [], selectedFolderId: null, sidebarWidth: 240 };
  assert.deepEqual(parseHttpWorkspace(structuredClone(workspace)), workspace);
  assert.equal(parseHttpWorkspace({ ...workspace, requests: [request({ useCookies: "no" as never })] }), null);
  assert.equal(requestFingerprint(request({})), requestFingerprint(request({ useCookies: true })));
  assert.notEqual(requestFingerprint(request({})), requestFingerprint(request({ useCookies: false })));
  const exported = exportPostman(workspace, null, "All", "x") as { item: { protocolProfileBehavior?: unknown }[] };
  assert.deepEqual(exported.item[0]!.protocolProfileBehavior, { disableCookies: true });
  const imported = importPostman({
    info: { name: "C", schema: POSTMAN_SCHEMA },
    item: [{ name: "R", protocolProfileBehavior: { disableCookies: true }, request: { method: "GET", url: "https://a.example" } }],
  }, null, (() => { let n = 0; return () => `id${++n}`; })(), "C");
  assert.equal(imported.requests[0]!.useCookies, false);
});
