// IndexNow (17 Oct 2026): tells Bing, Yandex, Naver and Seznam within about a
// minute when a listing page is added, changed or removed, instead of waiting
// days for a crawl. Google does not use IndexNow; it reads the sitemap.
//
// The key is public by design: search engines check it by fetching
// https://glrarealty.com/<key>.txt. Changes are collected for 60 s and sent in
// one request. Only the live server sends (Render sets RENDER=true); local
// copies and tests never do. INDEXNOW_ENABLED=0 switches it off.
const KEY = process.env.INDEXNOW_KEY || 'f9e83251ff3b009656c0acbc2b7ac4c5';
const HOST = 'glrarealty.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

let queue = new Set();
let timer = null;

function enabled() {
  if (process.env.INDEXNOW_ENABLED === '0') return false;
  return process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';
}

// paths like '/property/<id>'; the listings page and home always ride along.
function notifyIndexNow(paths) {
  if (!enabled()) return;
  for (const p of [].concat(paths || []).concat(['/properties.html', '/'])) {
    if (typeof p === 'string' && p.startsWith('/')) queue.add('https://' + HOST + p);
  }
  if (!timer) {
    timer = setTimeout(flush, 60e3);
    if (timer.unref) timer.unref();
  }
}

async function flush() {
  timer = null;
  const urlList = [...queue].slice(0, 10000);
  queue = new Set();
  if (!urlList.length) return;
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList }),
      signal: AbortSignal.timeout(15000),
    });
    // 200 = received, 202 = received but key not yet verified (normal at first).
    console.log(`IndexNow: ${r.status} for ${urlList.length} URL(s)`);
  } catch (e) {
    console.error('IndexNow failed:', e.message);
  }
}

function registerIndexNowRoutes(app) {
  app.get('/' + KEY + '.txt', (req, res) => {
    res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(KEY);
  });
}

module.exports = { notifyIndexNow, registerIndexNowRoutes, INDEXNOW_KEY: KEY };
