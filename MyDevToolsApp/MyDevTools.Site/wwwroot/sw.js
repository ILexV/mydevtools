// Service Worker for MyDevTools PWA
const CACHE_VERSION = 'v1.0.0-1771266158335';
const CACHE_NAME = `mydevtools-${CACHE_VERSION}`;

// Assets to cache on install
// Note: Language-specific pages (/{lang}/) are cached dynamically as users visit them
// This approach scales to any number of languages without updating the service worker
const STATIC_ASSETS = [
    // '/', // Removed to allow server-side redirection to language path
    '/app.css',
    '/theme.js',
    '/favorites.js',
    '/file-drop.js',
    '/pwa.js',
    '/favicon.png',
    '/favicon.ico',
    '/hero_logo.webp',
    '/manifest.json'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName.startsWith('mydevtools-') && cacheName !== CACHE_NAME) {
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => self.clients.claim())
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip chrome-extension and other non-http(s) requests
    if (!url.protocol.startsWith('http')) {
        return;
    }

    // Skip cross-origin requests (don't cache external resources)
    if (url.origin !== self.location.origin) {
        return;
    }

    // Skip root path to allow server-side redirection middleware to work
    if (url.pathname === '/' && url.search === '') {
        return;
    }

    event.respondWith(
        caches.match(request)
            .then((cachedResponse) => {
                if (cachedResponse) {
                    // Return cached response and update cache in background
                    const fetchPromise = fetch(request)
                        .then((networkResponse) => {
                            if (networkResponse && networkResponse.status === 200) {
                                const responseToCache = networkResponse.clone();
                                caches.open(CACHE_NAME).then((cache) => {
                                    cache.put(request, responseToCache);
                                });
                            }
                            return networkResponse;
                        })
                        .catch(() => {
                            // Network failed, cached version is still valid
                            return cachedResponse;
                        });

                    return cachedResponse;
                }

                // Not in cache, fetch from network
                return fetch(request)
                    .then((networkResponse) => {
                        // Cache successful responses
                        if (networkResponse && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(request, responseToCache);
                            });
                        }
                        return networkResponse;
                    })
                    .catch(() => {

                        // Return offline page for HTML requests
                        const acceptHeader = request.headers.get('accept');
                        if (acceptHeader && acceptHeader.includes('text/html')) {
                            return new Response(
                                `<!DOCTYPE html>
                <html>
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>Offline - MyDevTools</title>
                  <style>
                    body {
                      font-family: system-ui, -apple-system, sans-serif;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      min-height: 100vh;
                      margin: 0;
                      background: #1a1a2e;
                      color: #fff;
                      text-align: center;
                      padding: 20px;
                    }
                    h1 { font-size: 2rem; margin-bottom: 1rem; }
                    p { font-size: 1.1rem; opacity: 0.8; }
                  </style>
                </head>
                <body>
                  <div>
                    <h1>📡 You're Offline</h1>
                    <p>This page is not available offline.</p>
                    <p>Please check your internet connection.</p>
                  </div>
                </body>
                </html>`,
                                {
                                    headers: { 'Content-Type': 'text/html' }
                                }
                            );
                        }

                        throw error;
                    });
            })
    );
});

// Message event - handle commands from the page
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('[SW] Received SKIP_WAITING message');
        self.skipWaiting();
    }

    if (event.data && event.data.type === 'CLEAR_CACHE') {
        console.log('[SW] Clearing all caches');
        event.waitUntil(
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName.startsWith('mydevtools-')) {
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
        );
    }
});
