/**
 * MyDevTools Service Worker (build-time template).
 *
 * SCOPE
 *   The site is served from GitHub Pages under the base path /mydevtools/.
 *   This file is emitted at /mydevtools/sw.js, so its controlling scope is
 *   /mydevtools/ — it never touches other repos on github.io. Every precache
 *   URL is an absolute path prefixed with /mydevtools/ (no trailing slash for
 *   files). The trailing-slash offline URL (/mydevtools/offline/) is the one
 *   navigation entry point the fallback serves.
 *
 * STRATEGIES
 *   1. Navigations (request.mode === "navigate") — NETWORK-FIRST.
 *        Try the network; on success cache the rendered page into the runtime
 *        pages cache and return it. On failure (offline / 5xx) fall back to a
 *        cached copy of that page (runtime pages, then precache), and finally
 *        to the offline shell served from the precache.
 *   2. Same-origin static assets (CSS/JS/WASM/fonts) — STALE-WHILE-REVALIDATE.
 *        Return a cached copy immediately when available and refresh it in the
 *        background; uncached requests go to the network and are cached on
 *        success. Never throws — total failure yields the network response or
 *        a synthetic 504.
 *   3. Everything else (cross-origin, non-GET, chrome-extension:, …) — passthrough.
 *
 * UPDATE FLOW (message-driven, no auto skipWaiting)
 *   - `install` populates the new precache cache but does NOT activate, so the
 *     previous SW keeps serving until the page asks for the switch.
 *   - `activate` purges every stale `mdt-sw-*` cache (previous version's
 *     precache) and claims open clients.
 *   - A controlling page promotes the waiting worker by posting the message
 *     { data: "SKIP_WAITING" } (or { data: { type: "SKIP_WAITING" } }).
 *
 * This file is NOT runnable as-is: three build-time tokens are string-replaced
 * by build-sw.mjs before dist/sw.js is written (see the assignment block below):
 *   - CACHE_VERSION    becomes a quoted 8-char content hash, e.g. "a1b2c3d4"
 *   - PRECACHE_MANIFEST becomes a JSON array of { url, revision }
 *   - OFFLINE_URL      becomes a quoted offline URL, e.g. "/mydevtools/offline/"
 */
/* eslint-disable no-restricted-globals */

// === Replaced at build time by build-sw.mjs ===
const CACHE_VERSION = __CACHE_VERSION__;
const PRECACHE_MANIFEST = __PRECACHE_MANIFEST__;
const OFFLINE_URL = __OFFLINE_URL__;
// =============================================

const PRECACHE = "mdt-sw-precache-" + CACHE_VERSION;
const RUNTIME_PAGES = "mdt-sw-pages";
const RUNTIME_ASSETS = "mdt-sw-assets";

/** A URL string with any ?query and #hash stripped (used for cache matching). */
function cleanUrl(target) {
  try {
    const u = new URL(typeof target === "string" ? target : target.url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch (_) {
    return typeof target === "string" ? target : "";
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // cache.addAll is atomic: dedupe URLs so repeats don't confuse it.
      const urls = [...new Set(PRECACHE_MANIFEST.map((e) => e.url))];
      await cache.addAll(urls);
      // Intentionally NOT calling self.skipWaiting() — updates are
      // message-driven so a controlling page can choose when to swap over.
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PRECACHE, RUNTIME_PAGES, RUNTIME_ASSETS]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((name) => name.startsWith("mdt-sw-") && !keep.has(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data === "SKIP_WAITING" || (data && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only intercept same-origin GET requests over http(s).
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return; // malformed URL — let the browser deal with it
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return; // chrome-extension:, data:, …
  if (url.origin !== self.location.origin) return; // cross-origin passthrough

  if (request.mode === "navigate") {
    // Network-first with cache + offline fallback. Any thrown error degrades
    // to a plain network fetch so navigation never breaks.
    event.respondWith(handleNavigation(request).catch(() => fetch(request)));
  } else {
    // Stale-while-revalidate for same-origin static assets.
    event.respondWith(handleAsset(request, event).catch(() => fetch(request)));
  }
});

/** Network-first for HTML navigations, with offline-shell fallback. */
async function handleNavigation(request) {
  const pagesCache = await caches.open(RUNTIME_PAGES);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      pagesCache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    // Offline or network error → fall through the cache chain.
    let cached = await pagesCache.match(request);
    if (!cached) {
      const precache = await caches.open(PRECACHE);
      cached = (await precache.match(request)) || (await precache.match(cleanUrl(request)));
    }
    if (cached) return cached;

    // Last resort: the offline shell (stripped of query/hash) from precache.
    const precache = await caches.open(PRECACHE);
    const offline =
      (await precache.match(cleanUrl(OFFLINE_URL))) || (await precache.match(OFFLINE_URL));
    if (offline) return offline;

    throw err; // nothing to serve; outer catch degrades to fetch(request)
  }
}

/** Stale-while-revalidate for same-origin static assets. Never throws. */
async function handleAsset(request, event) {
  const assetsCache = await caches.open(RUNTIME_ASSETS);
  const precache = await caches.open(PRECACHE);
  const cached =
    (await assetsCache.match(request)) || (await precache.match(request));

  const fetchAndCache = async () => {
    try {
      const response = await fetch(request);
      // Only cache successful, same/cross-origin (basic/cors) responses.
      if (response && response.ok && (response.type === "basic" || response.type === "cors")) {
        await assetsCache.put(request, response.clone());
      }
      return response;
    } catch (_) {
      return null;
    }
  };

  if (cached) {
    // Serve stale immediately; refresh in the background.
    if (event && typeof event.waitUntil === "function") {
      event.waitUntil(fetchAndCache());
    }
    return cached;
  }

  const fresh = await fetchAndCache();
  if (fresh) return fresh;

  // Total failure (offline + uncached): synthetic 504.
  return new Response("Gateway Timeout", {
    status: 504,
    statusText: "Gateway Timeout",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
