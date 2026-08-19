// NyxOS service worker — offline-first, no network calls to anywhere but same origin.
const VERSION = 'nyxos-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/reset.css',
  './css/theme.css',
  './css/os.css',
  './css/apps.css',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/os.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Best-effort precache: never fail install because a single asset 404s.
    await Promise.allSettled(CORE.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Cache-first for same-origin GETs; fall back to network and cache the result.
// A privacy OS should never leak to third parties, so cross-origin requests are
// passed through untouched (apps that lack the network permission never reach here).
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const res = await fetch(request);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(VERSION);
        cache.put(request, res.clone());
      }
      return res;
    } catch {
      // Offline and uncached: serve the shell for navigations.
      if (request.mode === 'navigate') return caches.match('./index.html');
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
