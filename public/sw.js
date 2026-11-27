// Service worker for install/offline support.
//
// The site is private (Netlify login protected), so responses can be login
// redirects or 401s. Strategy:
//  - Never precache at install time (the visitor may not be signed in yet).
//  - Page navigations: network first, fall back to the cached shell offline.
//  - Hashed build assets (/assets/*): cache first (they are immutable).
//  - Everything else same-origin: network first, cache fallback.
//  - Only cache successful, non-redirected, same-origin responses.
const CACHE = 'price-history-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function cacheable(res) {
  return res && res.ok && res.type === 'basic' && !res.redirected;
}

async function networkFirst(request, cacheKey) {
  try {
    const res = await fetch(request);
    if (cacheable(res)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(cacheKey || request, copy));
    }
    return res;
  } catch (err) {
    const cached = await caches.match(cacheKey || request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (cacheable(res)) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Let the browser handle cross-origin requests and Netlify's own endpoints
  // (including the login flow) without interference.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.netlify/')) return;

  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request, '/'));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(cacheFirst(request));
    return;
  }

  e.respondWith(networkFirst(request));
});
