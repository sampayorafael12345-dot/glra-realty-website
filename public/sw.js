// Service Worker for GLRA Realty
// Strategy:
//   - /admin.html, /agent.html and /api/: NOT TOUCHED. Authenticated pages and
//     authenticated data. See isPassThrough().
//   - HTML pages: NETWORK-FIRST (so updates show without Ctrl+F5)
//   - Static assets (images, manifest, fonts): CACHE-FIRST (fast)
const CACHE_VERSION = 'glra-cache-v117';
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

// The two dashboards are authenticated app shells and /api/ is the data layer
// behind them. Neither belongs in a cache on the device, and neither should ever
// be answered with the fallback below. Returning true here takes the request out
// of the service worker entirely: the browser fetches it normally.
function isPassThrough(url){
  if (/^\/(admin|agent)\.html$/i.test(url.pathname)) return true;
  // Listing and hero photographs are served from /api/ but are immutable bytes,
  // so they stay on the cache-first path below.
  if (url.pathname.startsWith('/api/property-image/')) return false;
  if (url.pathname.startsWith('/api/hero-image/')) return false;
  return url.pathname.startsWith('/api/');
}

function isHTMLRequest(req){
  if (req.mode === 'navigate') return true;
  const url = new URL(req.url);
  // Listing photos stored in the database are served from this route. They have
  // no file extension, so the extension-less check below would treat them as
  // pages and re-fetch them every time — they're immutable images, so let them
  // fall through to the cache-first branch.
  if (url.pathname.startsWith('/api/property-image/')) return false;
  // Same for the home page's hero photographs, which are served from the
  // database through /api/hero-image/<id>. Immutable, so cache-first.
  if (url.pathname.startsWith('/api/hero-image/')) return false;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  return url.pathname.endsWith('.html') || url.pathname === '/' || !url.pathname.includes('.');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin === self.location.origin && isPassThrough(url)) return;

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
        .catch(() => caches.match(req).then(r => {
          if (r) return r;
          // Only ever stand the home page in for a page the visitor navigated
          // to. Handing it to anything else turns a plain network error into a
          // parse error a long way from its cause, and on a phone it reads as
          // "the site redirected me to the home page".
          if (req.mode === 'navigate' && url.origin === self.location.origin) {
            return caches.match('/index.html');
          }
          return Response.error();
        }))
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
