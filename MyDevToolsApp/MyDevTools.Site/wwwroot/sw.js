// Service Worker for MyDevTools PWA
const CACHE_VERSION = 'v1.0.0-1772192950846';
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
    '/android-chrome-192x192.png',
    '/android-chrome-512x512.png',
    '/hero_logo.webp',
    '/manifest.json'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            // .then(() => self.skipWaiting()) // Don't skip waiting automatically!
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

// Fetch event - Cache First, fallback to Network
// This is faster for navigation and offline support
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

    // Network-first strategy for HTML pages to ensure fresh content
    // Cache-first strategy for static assets (CSS, JS, Images, Fonts)
    const isHtml = request.headers.get('accept')?.includes('text/html');
    
    if (isHtml) {
        // Stale-While-Revalidate for HTML
        // Return cached version immediately if available, then update cache in background
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(request).then((cachedResponse) => {
                    const fetchPromise = fetch(request)
                        .then((networkResponse) => {
                            // Update cache with new version
                            if (networkResponse.ok) {
                                cache.put(request, networkResponse.clone());
                            }
                            return networkResponse;
                        })
                        .catch(() => {
                            // If network fails and no cache, return offline page
                            if (!cachedResponse) {
                                return createOfflineResponse();
                            }
                        });

                    // Return cached response immediately if available
                    // If not, wait for network
                    return cachedResponse || fetchPromise;
                });
            })
        );
    } else {
        // Cache-First for static assets
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    return fetch(request).then((networkResponse) => {
                        if (networkResponse.ok) {
                            cache.put(request, networkResponse.clone());
                        }
                        return networkResponse;
                    });
                });
            })
        );
    }
});

function createOfflineResponse() {
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
