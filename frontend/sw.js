/* ==========================================================================
   GASTERUS V3 - SERVICE WORKER (Simplified)
   Untuk PWA: Offline caching dasar
   ========================================================================== */

const CACHE_NAME = 'gasterus-v3-cache-v16';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/member.html',
  '/register.html',
  '/deposit.html',
  '/withdraw.html',
  '/bet-history.html',
  '/market-play.html',
  '/number-history.html',
  '/promotion.html',
  '/casino.html',
  '/privacy.html',
  '/referral.html',
  '/rules.html',
  '/terms.html',
  '/responsible-play.html',
  '/favicon.svg',
  '/manifest.json',
  '/robots.txt',
  '/sitemap.xml',
  '/css/mobile-blue.css',
  '/assets/qris-barcode.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never cache application code or the service worker itself
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/member/') || url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/') || url.pathname === '/sw.js') {
    e.respondWith(fetch(request).catch(() => new Response('Offline', { status: 503 })));
    return;
  }

  // HTML pages: network first
  if (request.destination === 'document' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            try {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
            } catch (_) {}
          }
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // Static assets: cache first
  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((r) => {
        if (r && r.status === 200) {
          try {
            const copy = r.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
          } catch (_) {}
        }
        return r;
      }).catch(() => new Response('', { status: 404 }));
    })
  );
});
