const CACHE_NAME = 'noteforge-offline-v3';

// Automatically replaced/prepended during `npm run build`
const PRECACHE_URLS = self.__PRECACHE_ASSETS || [
  '/',
  '/index.html',
  '/icon.svg',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const pathUrl of PRECACHE_URLS) {
        try {
          const response = await fetch(pathUrl, { credentials: 'include' });
          if (response && response.status === 200) {
            // Key strictly by pathname string so CORS/module requests always match
            await cache.put(pathUrl, response.clone());
          }
        } catch (err) {
          console.warn('[SW] Precache skipped:', pathUrl, err);
        }
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept cross-origin calls (Firebase Auth, App Check, Gemini API, reCAPTCHA)
  if (url.origin !== self.location.origin) return;

  // 1. HTML Document Navigations: Network first -> fallback to cached '/index.html'
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(request);
          if (networkRes && networkRes.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/index.html', networkRes.clone());
          }
          return networkRes;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            new Response('Offline cache warming up — reconnect once and reload.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' }
            })
          );
        }
      })()
    );
    return;
  }

  // 2. Same-origin static assets (/assets/*.js, /assets/*.css, /icon.svg, /manifest.webmanifest):
  // Match strictly by url.pathname so Vite's `crossorigin` module scripts ALWAYS hit cache!
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url.pathname);
      if (cached) {
        return cached;
      }

      try {
        const networkRes = await fetch(request);
        if (networkRes && networkRes.status === 200) {
          await cache.put(url.pathname, networkRes.clone());
        }
        return networkRes;
      } catch {
        return (
          (await cache.match(request, { ignoreSearch: true })) ||
          new Response('', { status: 504, statusText: 'Offline' })
        );
      }
    })()
  );
});
