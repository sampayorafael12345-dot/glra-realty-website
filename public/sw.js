// Service Worker for GLRA Realty
// Strategy:
//   - HTML pages: NETWORK-FIRST (so updates show without Ctrl+F5)
//   - Static assets (images, manifest, fonts): CACHE-FIRST (fast)
const CACHE_VERSION = 'glra-cache-v70';
const STATIC_ASSETS = [
  '/img/logo.png',
  '/img/hero-logo.png',
  '/img/favicon.ico.png',
  '/img/agent-photo.jpg',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.map(n => n !== CACHE_VERSION ? caches.delete(n) : null))
    ).then(() => self.clients.claim())
  );
});

function isHTMLRequest(req){
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  const url = new URL(req.url);
  return url.pathname.endsWith('.html') || url.pathname === '/' || !url.pathname.includes('.');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // NETWORK-FIRST for HTML — always try fresh, fall back to cache when offline
  if (isHTMLRequest(req)) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, clone)).catch(()=>{});
          }
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // CACHE-FIRST for everything else (images, fonts, etc.)
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, clone)).catch(()=>{});
        return res;
      });
    })
  );
});
