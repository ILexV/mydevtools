import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const origin = "https://mydevtools.app";
const template = readFileSync(new URL("../scripts/sw-template.js", import.meta.url), "utf8");

type FetchEvent = {
  request: Request;
  respondWith(value: Promise<Response>): void;
  waitUntil(value: Promise<unknown>): void;
};

function harness(base = "/") {
  const stores = new Map<string, Map<string, Response>>();
  const handlers = new Map<string, (event: FetchEvent | { waitUntil(value: Promise<unknown>): void }) => void>();
  let offline = false;
  const cacheApi = {
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async open(name: string) {
      let store = stores.get(name);
      if (!store) { store = new Map(); stores.set(name, store); }
      const entries = store;
      return {
        async keys() { return [...entries.keys()].map((url) => new Request(url)); },
        async match(request: Request | string) { return entries.get(typeof request === "string" ? request : request.url)?.clone(); },
        async put(request: Request | string, response: Response) { entries.set(typeof request === "string" ? request : request.url, response.clone()); },
        async delete(request: Request) { return entries.delete(request.url); },
      };
    },
  };
  const source = template.replace("__CACHE_VERSION__", '"private-cache-test"')
    .replace("__PRECACHE_MANIFEST__", "[]")
    .replace("__OFFLINE_URL__", JSON.stringify(`${base}offline/`));
  runInNewContext(source, {
    self: {
      location: { origin },
      clients: { async claim() {} },
      addEventListener(name: string, handler: (event: FetchEvent) => void) { handlers.set(name, handler as never); },
    },
    caches: cacheApi, URL, Request, Response,
    async fetch() {
      if (offline) throw new TypeError("Offline");
      return new Response("network page");
    },
  });
  return { handlers, stores, cacheApi, goOffline() { offline = true; } };
}

test("protected page, reports and Access login/logout bypass offline and asset caches", () => {
  for (const base of ["/", "/mydevtools/"]) {
    const { handlers, stores } = harness(base);
    for (const path of [
      `${base}admin/analytics`, `${base}admin/analytics/?days=30`, `${base}admin/analytics/index.html`,
      "/api/analytics/reports", "/api/analytics/reports/summary?days=7",
      "/cdn-cgi/access/logout", "/cdn-cgi/access/login",
    ]) {
      let intercepted = false;
      handlers.get("fetch")!({
        request: new Request(origin + path),
        respondWith() { intercepted = true; },
        waitUntil() {},
      });
      assert.equal(intercepted, false, `protected response intercepted: ${path}`);
    }
    assert.deepEqual([...stores.keys()], []);
  }
});

test("activation removes legacy private entries while keeping public offline pages", async () => {
  const { handlers, stores, cacheApi } = harness();
  const privatePaths = ["/admin/analytics/?days=90", "/api/analytics/reports/summary?days=30", "/cdn-cgi/access/logout"];
  for (const name of ["mdt-sw-pages", "mdt-sw-assets"]) {
    const cache = await cacheApi.open(name);
    await cache.put(origin + "/en/", new Response("public home"));
    for (const path of privatePaths) await cache.put(origin + path, new Response("private response"));
  }
  let activation: Promise<unknown> | undefined;
  handlers.get("activate")!({ waitUntil(value) { activation = value; } });
  await activation;
  for (const name of ["mdt-sw-pages", "mdt-sw-assets"]) {
    assert.deepEqual([...stores.get(name)!.keys()], [origin + "/en/"]);
    assert.equal(await stores.get(name)!.get(origin + "/en/")!.text(), "public home");
  }
});

test("normal public navigation remains available offline and no-store fetches bypass caches", async () => {
  const { handlers, stores, goOffline } = harness();
  const request = new Request(origin + "/en/");
  Object.defineProperty(request, "mode", { value: "navigate" });
  let response: Promise<Response> | undefined;
  handlers.get("fetch")!({ request, respondWith(value) { response = value; }, waitUntil() {} });
  assert.equal(await (await response)!.text(), "network page");
  assert.equal(await stores.get("mdt-sw-pages")!.get(request.url)!.clone().text(), "network page");
  goOffline();
  handlers.get("fetch")!({ request, respondWith(value) { response = value; }, waitUntil() {} });
  assert.equal(await (await response)!.text(), "network page");

  let intercepted = false;
  handlers.get("fetch")!({
    request: new Request(origin + "/en/", { cache: "no-store" }),
    respondWith() { intercepted = true; }, waitUntil() {},
  });
  assert.equal(intercepted, false);
});

test("native release downloads bypass stale cached binaries even while offline", async () => {
  for (const base of ["/", "/mydevtools/"]) {
    const { handlers, cacheApi, goOffline } = harness(base);
    const request = new Request(`${origin}${base}downloads/mydevtools-agent-windows-x64.exe?v=0.1.0`);
    Object.defineProperty(request, "mode", { value: "navigate" });
    for (const name of ["mdt-sw-pages", "mdt-sw-assets"]) {
      await (await cacheApi.open(name)).put(request, new Response("outdated executable"));
    }
    goOffline();
    let intercepted = false;
    handlers.get("fetch")!({
      request,
      respondWith() { intercepted = true; },
      waitUntil() {},
    });
    assert.equal(intercepted, false, "downloads must use the network, not an older cached release");
  }
});
