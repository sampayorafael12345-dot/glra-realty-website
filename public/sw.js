// Service Worker for GLRA Realty
// Strategy:
//   - /admin.html, /agent.html and /api/: NOT TOUCHED. Authenticated pages and
//     authenticated data. See isPassThrough().
//   - HTML pages: NETWORK-FIRST (so updates show without Ctrl+F5)
//   - Static assets (images, manifest, fonts): CACHE-FIRST (fast)
const CACHE_VERSION = 'glra-cache-v148';
// Photos live in a cache of their own, capped (Oct 2026): they used to pile up
// without limit, one copy per listing photo a visitor ever scrolled past.
const IMG_CACHE = CACHE_VERSION + '-img';
const IMG_MAX = 150;              // newest photos kept; the oldest go first
const MAX_BYTES = 1024 * 1024;    // a file over 1 MB is never stored on the device
// Only what every page shows. The full-size logo.png and hero-logo.png are for
// search engines and link previews (no page displays them), favicon.ico.png is
// for the dashboards, and the agent photo is on two pages: precaching them cost
// every first visit ~280 KB for nothing. The runtime cache below still keeps
// any of them once a page actually uses it.
const STATIC_ASSETS = [
  '/img/logo-384.png',
  '/img/hero-logo-384.png',
  '/img/favicon-64.png',
  '/manifest.json'
];

const UA = (self.navigator && self.navigator.userAgent) || '';
const IS_WEBKIT = /iphone|ipad|ipod/i.test(UA) || (/safari/i.test(UA) && !/chrome|chromium|crios|android|edg/i.test(UA));

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
      Promise.all(names.map(n => (n !== CACHE_VERSION && n !== IMG_CACHE) ? caches.delete(n) : null))
    ).then(() => self.clients.claim())
  );
});

// The two dashboards are authenticated app shells and /api/ is the data layer
// behind them. Neither belongs in a cache on the device, and neither should ever
// be answered with the fallback below. Returning true here takes the request out
// of the service worker entirely: the browser fetches it normally.
function isPassThrough(url){
  // Compared in lower case and decoded: "/API/admin/..." or "/%61pi/..." reach
  // the same server routes and must not be cached either.
  let p = url.pathname;
  try { p = decodeURIComponent(p); } catch (_) {}
  p = p.toLowerCase();
  if (/^\/(admin|agent|social|social-approve)\.html$/.test(p)) return true;
  // Pages whose address carries a private key (unsubscribe, confirm, alerts)
  // are never stored on the device.
  if (/^\/(unsubscribe|confirm-subscription|alerts\.html)\b/.test(p)) return true;
  // Listing and hero photographs are served from /api/ but are immutable bytes,
  // so they stay on the cache-first path below.
  if (p.startsWith('/api/property-image/')) return false;
  if (p.startsWith('/api/hero-image/')) return false;
  return p.startsWith('/api/');
}
// A response the server marked private or no-store is never kept.
function storable(res){
  const cc = (res.headers.get('Cache-Control') || '').toLowerCase();
  return !/no-store|private/.test(cc);
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
  // Other sites (Cloudinary photos, map tiles, CDN libraries) are never cached
  // here (see res.type below), and a fetch() made from inside the worker is
  // held to the page's connect-src, which does not list them. Routing them
  // through the worker broke every photo and map on phones once the CSP was
  // enforced. Let the browser load them directly under img-src/script-src.
  if (url.origin !== self.location.origin) return;
  if (isPassThrough(url)) return;
  // A partial-content request (Range) must never be answered from a stored
  // whole copy; let the browser ask the server itself.
  if (req.headers.has('range')) return;
  // Every browser on an iPhone or iPad is WebKit, and so is desktop Safari.
  // WebKit refuses some answers a service worker gives to a page navigation
  // (a redirected response, a stale shell), and then the page never finishes
  // loading. Pages therefore go straight to the network there. Images, styles
  // and scripts still use the cache below.
  if (IS_WEBKIT && isHTMLRequest(req)) return;

  // NETWORK-FIRST for HTML — always try fresh, fall back to cache when offline
  if (isHTMLRequest(req)) {
    // One stored copy per page, whatever its ?query: every search used to be
    // kept as its own full copy. The page reads the query itself.
    const pageKey = url.origin + url.pathname;
    // A slow server must not leave a blank page when a saved copy exists: after
    // 5 s the saved copy is shown while the real request carries on and refreshes
    // the store for next time.
    const live = fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic' && storable(res)) {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(pageKey, clone)).catch(()=>{});
      }
      return res;
    });
    live.catch(() => {});   // a late failure after the 5 s fallback is not an error
    const slow = new Promise(resolve => setTimeout(() => resolve(null), 5000));
    event.respondWith(
      Promise.race([live, slow]).then(first => first || caches.match(pageKey).then(c => c || live))
        .then(res => {
          // A server error: the last good copy is better than an error page.
          if (res && res.status >= 500) return caches.match(pageKey).then(r => r || res);
          return res;
        })
        .catch(() => caches.match(pageKey).then(r => {
          if (r) return r;
          // Only ever stand the home page in for a page the visitor navigated
          // to. Handing it to anything else turns a plain network error into a
          // parse error a long way from its cause, and on a phone it reads as
          // "the site redirected me to the home page".
          if (req.mode === 'navigate' && url.origin === self.location.origin) {
            // The home page is stored under "/" when it was visited as the site's root.
            return caches.match('/index.html').then(h => h || caches.match(self.location.origin + '/'));
          }
          return Response.error();
        }))
    );
    return;
  }

  // CACHE-FIRST for everything else (images, fonts, etc.)
  const image = isImage(req, url);
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic' || !storable(res)) return res;
        const len = parseInt(res.headers.get('Content-Length') || '', 10);
        if (len > MAX_BYTES) return res;
        const clone = res.clone();
        event.waitUntil(keep(image ? IMG_CACHE : CACHE_VERSION, req, clone, !len, image));
        return res;
      });
    })
  );
});

function isImage(req, url){
  if (req.destination === 'image') return true;
  return /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i.test(url.pathname) ||
    url.pathname.startsWith('/api/property-image/') || url.pathname.startsWith('/api/hero-image/');
}
// Stores one response. With no Content-Length (a compressed or streamed reply)
// the size is only known once the body is read, so it is read first and
// dropped if it turns out to be over the limit. Photos are then trimmed to the
// newest IMG_MAX (cache.keys() lists them oldest first).
async function keep(name, req, res, sizeUnknown, image){
  try {
    if (sizeUnknown) {
      const body = await res.blob();
      if (body.size > MAX_BYTES) return;
      res = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    const c = await caches.open(name);
    await c.put(req, res);
    if (image) {
      const keys = await c.keys();
      for (let i = 0; i < keys.length - IMG_MAX; i++) await c.delete(keys[i]);
    }
  } catch (_) {}
}
