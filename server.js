// Load environment variables FIRST
require('dotenv').config();

const express = require('express');
// Shared with the browser: public/js/description.js is also loaded by the
// modals on properties.html and index.html, so a listing's description reads
// identically wherever it is shown.
const glraCleanDescription = require('./public/js/description.js');
const crypto = require('crypto');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const brevo = require('@getbrevo/brevo');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const { body, validationResult } = require('express-validator');

const app = express();

// ============ FAIL FAST ON MISSING REQUIRED ENV VARS ============
// Accept either MONGODB_URL or MONGODB_URI (both names are common conventions).
const MONGODB_CONNECTION = process.env.MONGODB_URL || process.env.MONGODB_URI;
const missing = [];
if (!MONGODB_CONNECTION) missing.push('MONGODB_URL (or MONGODB_URI)');
if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
if (missing.length) {
  console.error(`\n❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('Set these in your Render dashboard (Environment tab) or in a local .env file.\n');
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET must be at least 32 characters. Generate one with:');
  console.error('   node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

// A promise nobody awaited (a failed email, a Cloudinary hiccup) must not take
// the whole site down. Log it and keep serving; Render restarts the process
// only on a genuine crash.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
});
// An uncaught exception means the process is in a state nobody reasoned
// about — a half-written response, a released connection, a listener that
// never bound. Carrying on serves visitors from a broken process; the site
// looks up while nothing works. Log it, then exit so Render starts a fresh
// one. (Proved in testing: a port clash was swallowed here and the process
// stayed "alive" for minutes with no listener attached.)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
  setTimeout(() => process.exit(1), 250).unref();
});

// ============ HTML ESCAPE HELPER (used in email templates) ============
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============ BREVO EMAIL CONFIGURATION ============
let brevoApiInstance = null;

function initBrevo() {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log('⚠️ BREVO_API_KEY not set. Email sending will be disabled.');
    return false;
  }

  let defaultClient = brevo.ApiClient.instance;
  let apiKeyAuth = defaultClient.authentications['api-key'];
  apiKeyAuth.apiKey = apiKey;
  brevoApiInstance = new brevo.TransactionalEmailsApi();
  console.log('✅ Brevo email service initialized');
  return true;
}

// replyTo is optional and only used by the Agent Workspace, where an agent
// emails their own client: the client's reply has to reach that agent, not the
// shared inbox. Everything else leaves it off and keeps the default below.
// attachments is optional too: [{ name, content }] where content is a Buffer
// or a base64 string. The leasing module uses it for PDF statements/receipts.
async function sendEmail(to, subject, htmlContent, fromName = 'GLRA Realty', replyTo = null, attachments = null) {
  if (!brevoApiInstance) {
    const initialized = initBrevo();
    if (!initialized) {
      console.error('❌ Brevo not configured. Cannot send email to:', to);
      return { success: false, error: 'Email service not configured' };
    }
  }

  try {
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.sender = { email: 'hello@glrarealty.com', name: fromName };
    // Replies route to Catherine's gmail instead of the no-reply hello@ address
    // so she sees every customer reply in her primary inbox.
    sendSmtpEmail.replyTo = (replyTo && replyTo.email)
      ? { email: replyTo.email, name: replyTo.name || fromName }
      : { email: 'glrarealty@gmail.com', name: 'GLRA Realty' };
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    if (Array.isArray(attachments) && attachments.length) {
      sendSmtpEmail.attachment = attachments
        .filter(a => a && a.name && a.content)
        .map(a => ({ name: String(a.name).slice(0, 120), content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content) }));
    }

    const response = await brevoApiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Email sent to ${to}: ${subject}`);
    return { success: true, data: response };
  } catch (error) {
    console.error('Email send failed:', error.response?.body || error.message);
    return { success: false, error };
  }
}

initBrevo();

// ============ CLOUDINARY CONFIGURATION ============
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn('⚠️ Cloudinary credentials missing. Image uploads will fail.');
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============ SECURITY MIDDLEWARE ============

// Trust the first proxy (needed for correct req.ip behind Render/Heroku/etc.)
app.set('trust proxy', 1);

// Helmet — sensible default security headers.
// CSP is configured separately below rather than here, so keep it off in the
// base call. Everything else (HSTS, X-Frame-Options, nosniff, ...) stays on.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Nothing on this site uses the camera, microphone, geolocation or payment
// APIs, so switch them off for the page and anything it embeds. Costs nothing
// and stops an injected script from even asking the visitor for permission.
app.use((req, res, next) => {
  res.set('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()');
  next();
});

// ── CONTENT SECURITY POLICY ─────────────────────────────────
// Split in two on purpose.
//
// 1. ENFORCED: only directives that cannot plausibly break this site. None of
//    the pages use <object>/<embed>, none set a <base> tag, and no <form> has
//    an external action, so locking those down costs nothing and shuts off
//    clickjacking, base-tag hijacking and form exfiltration today.
//
// 2. REPORT-ONLY: the full policy, including script/style/img sources. The
//    pages are full of inline <script> and style="" so this still needs
//    'unsafe-inline' to be useful, but it does stop a successful injection
//    from loading or phoning home to an attacker-controlled domain. It runs in
//    report-only first so a missed origin shows up as a console warning instead
//    of a blank page. Once the console is clean across every page, move these
//    directives into CSP_ENFORCED.
const CSP_BASELINE = {
  'frame-ancestors': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"]
};

app.use(helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    // This policy deliberately restricts only the four directives above; it is
    // not trying to control where resources load from (that is the report-only
    // policy's job). Helmet refuses a policy with no default-src unless you say
    // so explicitly, hence the alarming-looking constant.
    'default-src': helmet.contentSecurityPolicy.dangerouslyDisableDefaultSrc,
    ...CSP_BASELINE
  }
}));

app.use(helmet.contentSecurityPolicy({
  useDefaults: false,
  reportOnly: true,
  directives: {
    'default-src': ["'self'"],
    // cdn.jsdelivr.net = Swiper (home page hero slider).
    // clarity.ms = Microsoft Clarity, loaded by js/main.js on every public page
    // (NOT on admin.html, which main.js skips). Clarity bootstraps from
    // www.clarity.ms/tag/<id> but the tag then pulls its real payload from
    // scripts.clarity.ms and beacons to b.clarity.ms / c.bing.com — all four
    // hosts have to be listed or the console fills with violations and the
    // policy can never be promoted out of report-only.
    'script-src': ["'self'", "'unsafe-inline'",
      'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com',
      'https://*.clarity.ms'],
    'style-src': ["'self'", "'unsafe-inline'",
      'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
    // Listing photos come from Cloudinary; data:/blob: cover inline SVG
    // placeholders and the admin's local image previews before upload.
    'img-src': ["'self'", 'data:', 'blob:',
      'https://res.cloudinary.com', 'https://images.unsplash.com',
      'https://*.clarity.ms', 'https://c.bing.com',
      'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],  // properties.html map view
    // Clarity's beacon host is region-sharded — a.clarity.ms through
    // z.clarity.ms. The live page uses n.clarity.ms, which was on none of the
    // three lists above, so every visit logged a violation and the policy
    // could never be promoted out of report-only. Naming them one at a time
    // cannot work; a visitor in Singapore gets a different letter.
    // The currency switcher on properties.html fetches live exchange rates from
    // jsDelivr, with a Cloudflare Pages mirror as its documented fallback.
    // Neither was listed, so enforcing this policy today would have silently
    // frozen every price in USD/AED/SGD at whatever the fallback rate is. This
    // is exactly what report-only is for, and exactly why it was worth
    // inventorying every external host in the codebase before promoting it.
    'connect-src': ["'self'", 'https://*.clarity.ms', 'https://api.cloudinary.com',
      'https://cdn.jsdelivr.net', 'https://latest.currency-api.pages.dev',
      // Flood hazard layer (js/glra-maps.js): UP NOAH PMTiles on Hugging Face,
      // which answers with a redirect to its CDN.
      'https://huggingface.co', 'https://*.hf.co',
      // 3D view (js/glra-maps.js): OpenFreeMap's style, tiles, fonts and icons.
      'https://tiles.openfreemap.org'],
    'frame-src': ["'self'", 'https://www.google.com'],  // property-page map embed
    'media-src': ["'self'"],
    // Without this, manifest-src falls back to default-src. That happens to be
    // 'self' and so happens to work - but the day this policy is enforced is
    // not the day to find out by having every home-screen icon stop working.
    'manifest-src': ["'self'"],
    // 'self': the service worker. blob:: the 3D map's tile workers, which
    // MapLibre builds from its own bundle.
    'worker-src': ["'self'", 'blob:'],
    ...CSP_BASELINE
  }
}));

// CORS — strict allowlist
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// If ALLOWED_ORIGINS is not configured, fall back to this site's own origin
// rather than to "*". The previous behaviour treated an empty allowlist as
// "allow everything" while still sending credentials — so forgetting to set
// one env var silently opened the API to every website on the internet.
const DEFAULT_ORIGINS = [
  'https://glrarealty.com', 'https://www.glrarealty.com'
];
const corsAllowlist = allowedOrigins.length ? allowedOrigins : DEFAULT_ORIGINS;
if (!allowedOrigins.length) {
  console.warn('⚠️ ALLOWED_ORIGINS not set — defaulting CORS to ' + corsAllowlist.join(', '));
}

app.use(cors({
  origin: function (origin, callback) {
    // No Origin header = same-origin navigation, curl, or a server-to-server
    // call. Browsers always send Origin on cross-site requests, so this is safe.
    if (!origin) return callback(null, true);
    if (corsAllowlist.includes(origin)) return callback(null, true);
    // localhost on any port, for local development only.
    if (process.env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// Gzip every response (HTML, JSON, CSS, JS) — big win for the property list API
app.use(compression());

// Body limits — sane defaults; multer handles large file uploads separately
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Body-parser failures are the client's fault, not a server fault. Answer them
// honestly (413 too large / 400 malformed) so a browser or a script gets a
// usable message instead of a 500 that looks like the site fell over.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request is too large. Maximum 1 MB.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }
  return next(err);
});

// Strip MongoDB operator keys ($ne, $gt, etc.) from req.body, req.query, req.params
app.use(mongoSanitize());

// ── RETIRED PAGES ───────────────────────────────────────────
// Permanent (301) redirects for pages that were merged into another page, so
// old links, bookmarks and Google's index carry over to the new home. These
// must sit BEFORE express.static and the page-view counter below: the counter
// would otherwise log the dead URL as a view and then the destination again.
// Sept 2026: the Pag-IBIG vs Bank comparison became the #compare section of
// amortization.html (the old file is kept outside public/ in _removed-pages).
app.get(['/loan-comparison.html', '/loan-comparison'], (req, res) => {
  res.redirect(301, '/amortization.html#compare');
});
// Browsers and Google ask for /favicon.ico on their own; it never existed, so
// every visit logged a 404. Point it at the real icon.
app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.redirect(301, '/img/favicon-64.png');
});

// ── SITE TRAFFIC COUNTER ────────────────────────────────────
// Counts real public HTML page views (not assets, not /api, not the /admin
// dashboard) into a per-day tally the admin dashboard reads back. Runs BEFORE
// express.static so navigations are observed. Privacy-preserving: no IP, cookie,
// or personal data is stored — just an anonymous daily page-view count. It never
// blocks or breaks a page load (fully fire-and-forget).

// Whitelist of countable page slugs, read once at boot from the real files in
// public/. Counting an arbitrary req.path would let anyone inflate the stats
// document to any size just by requesting /aaa, /aab, /aac...
const COUNTABLE_PAGES = (() => {
  const set = new Set(['home', 'property-detail']);
  try {
    fs.readdirSync(path.join(__dirname, 'public'))
      .filter(f => f.endsWith('.html') && f !== 'admin.html' && f !== '404.html')
      .forEach(f => set.add(f.replace(/\.html$/, '')));
  } catch (e) { /* fall back to the two defaults */ }
  return set;
})();

function pageSlug(p) {
  if (p === '/' || p === '/index.html') return 'home';
  if (p.startsWith('/property/')) return 'property-detail';
  const slug = p.replace(/^\//, '').replace(/\.html$/, '');
  return COUNTABLE_PAGES.has(slug) ? slug : null;
}

// Referrer bucketed to a coarse source, never the full URL — "google" tells
// Catherine what she needs; the exact query string does not, and storing it
// would turn a plain counter into personal data.
function refSlug(referer, host) {
  if (!referer) return 'direct';
  let h;
  try { h = new URL(referer).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (e) { return 'other'; }
  if (!h || h === String(host || '').toLowerCase().replace(/^www\./, '')) return 'direct';
  if (h.includes('google')) return 'google';
  if (h.includes('facebook') || h === 'm.me' || h.includes('messenger')) return 'facebook';
  if (h.includes('instagram')) return 'instagram';
  if (h.includes('bing')) return 'bing';
  if (h.includes('tiktok')) return 'tiktok';
  if (h.includes('youtube')) return 'youtube';
  if (h.includes('linkedin')) return 'linkedin';
  if (h.includes('lamudi') || h.includes('dotproperty') || h.includes('carousell')) return 'listing-portal';
  return 'other';
}

app.use((req, res, next) => {
  try {
    if (req.method === 'GET') {
      const p = req.path;
      const accept = req.headers['accept'] || '';
      const isPage = (p === '/' || p.endsWith('.html') || p.startsWith('/property/'));
      const isPublic = !p.startsWith('/api') && !p.startsWith('/admin');
      // A speculative prefetch is the browser guessing, not a person reading.
      // Counting it would quietly inflate every number on the dashboard.
      const speculative = /prefetch|prerender/i.test(req.headers['sec-purpose'] || req.headers['purpose'] || '');
      if (isPage && isPublic && !speculative && accept.includes('text/html')) {
        const now = new Date();
        const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const inc = { views: 1 };
        const slug = pageSlug(p);
        if (slug) inc['pages.' + slug] = 1;
        inc['refs.' + refSlug(req.headers.referer, req.headers.host)] = 1;
        require('./server/db').SiteStat.updateOne({ day }, { $inc: inc }, { upsert: true }).catch(() => {});
      }
    }
  } catch (e) { /* analytics must never break a page load */ }
  next();
});

// sitemap.xml MUST be matched before express.static. An old static
// public/sitemap.xml left in the repo would otherwise shadow the dynamic route
// below forever — which is exactly what happened: the served sitemap was frozen
// at its April dates and contained no /property/ listing URLs at all.
app.get('/sitemap.xml', (req, res, next) => buildSitemap(req, res, next));

// THE HOME PAGE, SERVED WITH ITS LISTINGS ALREADY IN IT. The static file
// used to open on a stock photo, ask /api/properties for the listings, and
// only then swap in a real photo: the largest thing on the page appeared after
// 8.4 s on Lighthouse's phone test. Now the first featured listing's cover is
// in the markup (and preloaded), the listing count is printed, and the list
// itself rides along in the page, so the browser draws the real page at once.
// Any failure falls through to the plain static file, which still works.
const _pageTpl = {};
function pageTemplate(name) {
  const file = path.join(__dirname, 'public', name);
  const st = fs.statSync(file);
  const c = _pageTpl[name];
  if (!c || c.mtime !== st.mtimeMs) _pageTpl[name] = { mtime: st.mtimeMs, html: fs.readFileSync(file, 'utf8') };
  return _pageTpl[name].html;
}
function heroPhotoUrl(u, w) {
  if (typeof u !== 'string' || u.indexOf('res.cloudinary.com') === -1) return u;
  u = u.replace('/upload/f_auto,q_auto/', '/upload/');
  if (/\/upload\/[a-z]{1,2}_/.test(u)) return u;
  return u.replace('/upload/', `/upload/f_auto,q_auto,c_limit,w_${w}/`);
}
// The Properties page gets the same treatment: the list rides along.
app.get('/properties.html', async (req, res, next) => {
  try {
    const body = await publicListBody();
    const html = pageTemplate('properties.html').replace('<!--GLRA_LIST-->',
      '<script>window.__GLRA_LIST=' + body.replace(/</g, '\\u003c') + ';</script>');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (e) {
    next();
  }
});
app.get(['/', '/index.html'], async (req, res, next) => {
  try {
    const body = await publicListBody();
    const list = (_publicListCache.list || JSON.parse(body)).filter(p => p.status === 'available');
    let html = pageTemplate('index.html');
    // Same pick as populateHeroFromListings() in index.html, so the photo the
    // server sends is the one the slider keeps.
    const withImg = list.filter(p => p.mainImage);
    const hero = (withImg.filter(p => p.featured)[0] || withImg[0]);
    const heroUrl = hero ? heroPhotoUrl(hero.mainImage, 1400) : '';
    if (heroUrl) {
      html = html.replace(/<div class="swiper-slide is-on" data-glra-first-slide[^>]*><\/div>/,
        `<div class="swiper-slide is-on" data-glra-first-slide style="background-image:url('${esc(heroUrl)}')"></div>`);
      html = html.replace('</title>', `</title>\n<link rel="preload" as="image" href="${esc(heroUrl)}" fetchpriority="high">`);
    }
    const n = String(list.length);
    html = html.replace('<span id="topCount">24</span> <span id="topCountWord">listings</span>',
      `<span id="topCount">${n}</span> <span id="topCountWord">${list.length === 1 ? 'listing' : 'listings'}</span>`);
    html = html.replace('<span id="statProperties">0</span>', `<span id="statProperties">${n}</span>`);
    // JSON inside a <script>: "<" is escaped so no listing text can close it.
    const inline = '<script>window.__GLRA_LIST=' + body.replace(/</g, '\\u003c') + ';</script>';
    html = html.replace('<!--GLRA_LIST-->', inline);
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (e) {
    next();
  }
});

app.use(express.static('public', {
  // HTML is the one thing that must never be held: admin edits and new
  // listings have to show up on the next load without a hard refresh.
  // Everything else (css, js, img, manifest) is safe to keep for a week —
  // the service worker's CACHE_VERSION is what retires an old asset.
  setHeaders(res, path) {
    if (/\.html?$/i.test(path)) {
      res.setHeader('Cache-Control', 'no-cache');
      // The two private portals say noindex in their <head> already; saying it
      // in the header too means the instruction survives a fetch that never
      // parses the HTML.
      if (/(admin|agent)\.html$/i.test(path)) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      } else if (!/404\.html$/i.test(path)) {
        // max-image-preview:large is the important one on a property site: it
        // is what lets Google put a full-width photograph next to the result
        // instead of a thumbnail. max-snippet:-1 lifts the cap on the
        // description length. Set once here so every page - including any
        // added later - inherits it.
        res.setHeader('X-Robots-Tag',
          'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
      }
    } else if (/manifest\.json$/i.test(path) || /\.webmanifest$/i.test(path)) {
      // The registered type for a web app manifest. Browsers accept
      // application/json today, but the icon and the launch URL for an app
      // someone has put on their home screen is not a good place to be
      // relying on leniency.
      res.setHeader('Content-Type', 'application/manifest+json; charset=UTF-8');
    } else if (/\.(css|js)$/i.test(path)) {
      // These are requested with ?v=<CACHE_VERSION> now, so a changed file
      // arrives under a new URL and a cached one can never be stale. That
      // makes it safe - and correct - to cache them hard. It also fixes the
      // real problem the version stamp was added for: before this, a css
      // change took up to a week to reach a returning visitor, because the
      // browser's own copy sat underneath the service worker and won.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// ============ RATE LIMITERS ============
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Forgot/reset password — public endpoints. Tight limit so nobody can spam
// reset emails or brute-force reset tokens.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: { error: 'Too many password reset attempts. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Self-service account signups — public endpoint, keep it tight so nobody
// floods the approval queue. 5 signup attempts per IP per hour.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many signup attempts. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Calculator-usage pings are fire-and-forget and fire far more often than form
// posts (once per tool per visit), so they get their own looser bucket instead
// of eating into the 30-per-10-min budget that real form submissions need.
const trackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limit for public property-submission endpoints.
// 5 submissions per IP per hour, 25 image uploads per IP per hour.
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions from this address. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const submissionUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 25,
  message: { error: 'Too many image uploads. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Bulk email — protects Brevo quota. Authenticated route, but still throttled
// per-IP to avoid runaway loops if the UI is buggy or a token leaks.
const bulkEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  message: { error: 'Too many bulk-email batches. Wait a bit and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============ UPLOADS ============
// Everything uploaded here is on its way to Cloudinary and is deleted the
// moment that finishes. It must NOT be staged inside public/ — express.static
// serves that whole folder, so for the length of the round trip an owner's
// land title sat at a public URL. The OS temp directory is off the web root.
const uploadsDir = path.join(os.tmpdir(), 'glra-uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Strict mime whitelist — NO svg (XSS risk)
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const safeExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + safeExt);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WEBP, or GIF images are allowed'));
    }
  }
});

// Task attachments accept the document types brokers + lawyers actually use.
const ALLOWED_TASK_ATTACHMENT_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  // iPhone camera format; Cloudinary converts it for viewing.
  'image/heic', 'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
]);
// Photos are stored at most 2400 px on the long side, as a JPEG compressed by
// Cloudinary ("quality auto:good"), even when a browser could not shrink them
// first (an iPhone HEIC, an old phone). PDFs and office files are untouched.
function shrinkOnUpload(mime) {
  return /^image\/(jpeg|pjpeg|png|webp|heic|heif)$/i.test(String(mime || ''))
    ? { transformation: [{ width: 2400, height: 2400, crop: 'limit' }, { quality: 'auto:good' }], format: 'jpg' }
    : {};
}
const uploadAttachment = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TASK_ATTACHMENT_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed. Use images, PDF, Word, Excel, or text files.'));
    }
  }
});

// ============ MONGOOSE ============
const MONGODB_URI = MONGODB_CONNECTION;

// Schemas + compiled models live in ./server/db.js — see that file for all data shapes.
const db = require('./server/db');
const { applyWebsiteCover } = require('./server/cover');
const {
  Property, Inquiry, HeroImage, Subscriber, PriceAlert, SavedSearch, Wishlist,
  AlertLog, AuditLog, Account, Task, PropertySubmission, ScheduledEmail,
  TitlingCase, NotarialJob, CashEntry, SiteStat, CalcUsage, ListingView,
  PERMISSION_KEYS, defaultPermissionsForRole
} = db;


// ============ CONNECT TO MONGODB ============
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
  .then(async () => {
    console.log('✅ MongoDB connected successfully!');
    await seedDefaultAdmin();
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected! Reconnecting...');
  setTimeout(() => mongoose.connect(MONGODB_URI), 5000);
});

// ============ AUTH + AUDIT ============
// Token signing/verifying, permission middleware, audit-log writer, and the
// one-time admin seeder all live in ./server/auth.js.
const {
  signToken, verifyToken, requireAdmin, requirePermission,
  logAudit, seedDefaultAdmin
} = require('./server/auth');

// ── FIELD AGENTS ARE NOT OFFICE STAFF ──────────────────────
// Agents sign in through agent.html, but the sign-in route is the shared
// /api/admin/login, so an agent walks away holding the same kind of token an
// employee holds. Every /api/admin route protected by verifyToken alone
// therefore answered them — the whole customer list, every listing's
// commission, the staff directory. Their own API is /api/agent/*; agent.html
// never calls an authenticated /api/admin route, so shutting the door here
// costs them nothing.
//
// Placed before the admin routes are declared, and it deliberately does NOT
// cover the four unauthenticated ones (login, signup, forgot/reset password)
// which agents do use — those carry no token, so `req.user` is unset and this
// middleware passes them straight through.
app.use('/api/admin', (req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return next();
  let role;
  try { role = jwt.verify(auth.slice(7), JWT_SECRET).role; } catch (e) { return next(); }
  if (role === 'agent') {
    return res.status(403).json({ error: 'This is the office dashboard. Please use your Agent Workspace at /agent.html.' });
  }
  next();
});

// ============ EMAIL TEMPLATES ============
// Email header/footer (used by every transactional message) live in
// server/email-templates.js. Edit there once → every email rebrands at the
// same time.
const { getEmailHeader, getEmailFooter } = require('./server/email-templates');

// ============ VALIDATION HELPER ============
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid input', details: errors.array() });
  }
  next();
}

// ============ PUBLIC ROUTES ============

// Fields the public site is allowed to see. This is a WHITELIST on purpose:
// a new internal field added to the schema later stays private by default
// instead of silently appearing in the public API. Deliberately excluded:
// commission / fixedAmount / totalCommission (the brokerage's own economics)
// and notes (free text that holds the owner's name, email and mobile on any
// listing imported from a "List your property" submission). Also excluded:
// developer, because the Excel importer maps its "Developer / Owner" column
// into it and two live listings carried the OWNER's surname there; and
// pricePerSqm, which the same import filled with commission rates ("0.05").
// Every page works out price per sqm itself from price and area.
const PUBLIC_PROPERTY_FIELDS = [
  '_id', 'title', 'location', 'price', 'monthlyRental', 'bedrooms', 'bathrooms',
  'sqm', 'landArea', 'description', 'mainImage', 'gallery', 'featured', 'status',
  'listingType', 'propertyType', 'parking', 'parkingPrice', 'additionalParkingStatus',
  'mapLocation', 'previousPrice', 'priceUpdatedAt',
  'views', 'createdAt', 'facing', 'coverImage', 'floorPlan', 'webSummary',
  // Reduced by publicGeo() to a rounded {lat, lng}; the lookup text, status
  // and timestamps never leave the server.
  'geo'
].join(' ');

// ── THE PUBLIC LISTINGS FEED ────────────────────────────────
// Every visitor to the home page and the properties page waits on this before
// a single card can be drawn, and it is the same answer for all of them.
// Timed against production: a bare DB ping costs 0.43s, this costs 1.73s - so
// about 1.3 seconds per visitor goes on re-running a query whose result has
// not changed. Holding the finished JSON for a minute removes that for
// everyone but the first caller.
//
// The string is cached, not the array: re-serialising 150 KB of JSON on every
// request is itself part of the cost. Invalidated the moment a listing is
// created, edited, deleted, bulk-imported or brought in from a submission -
// the same five places that already refresh the chatbot's copy - so Catherine
// never has to wait out a timer to see her own edit.
const PUBLIC_LIST_TTL_MS = 60 * 1000;
let _publicListCache = { at: 0, body: null };
function invalidatePublicListingsCache() { _publicListCache = { at: 0, body: null, list: null }; }
async function publicListBody() {
  if (_publicListCache.body && Date.now() - _publicListCache.at < PUBLIC_LIST_TTL_MS) return _publicListCache.body;
  const properties = await Property.find({ status: 'available' })
    .select(PUBLIC_PROPERTY_FIELDS).sort({ createdAt: -1 }).lean();
  properties.forEach(optimizePropertyImages);
  _publicListCache = { at: Date.now(), body: JSON.stringify(properties), list: properties };
  return _publicListCache.body;
}

app.get('/api/properties', async (req, res) => {
  try {
    const body = await publicListBody();
    // A minute of freshness for the browser too: repeat views and back-
    // navigation never reach Render at all.
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.type('application/json').send(body);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Serves a listing photo that lives in the database as a base64 data: URI as a
// real image response. Immutable + long-lived: the bytes for a given property
// image never change, so browsers and the service worker cache it after one hit.
const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
app.get('/api/property-image/:id/:key', async (req, res) => {
  try {
    const p = await Property.findById(req.params.id, { mainImage: 1, gallery: 1 }).lean();
    if (!p) return res.status(404).end();
    const key = req.params.key;
    const raw = key === 'main' ? p.mainImage : (p.gallery || [])[Number(key)];
    const m = isDataUri(raw) && raw.match(/^data:([\w.+/-]+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    // Served as an image or not at all. The type used to be whatever the
    // stored data: string claimed, so a "photo" saved as text/html became a
    // page running on glrarealty.com.
    if (!SAFE_IMAGE_TYPES.has(m[1].toLowerCase())) return res.status(404).end();
    const buf = Buffer.from(m[2], 'base64');
    res.set('Content-Type', m[1].toLowerCase());
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Length', String(buf.length));
    return res.end(buf);
  } catch (err) {
    return res.status(404).end();
  }
});

// Single property as JSON (handy for clients / future use).
app.get('/api/properties/:id', async (req, res) => {
  try {
    const p = await Property.findById(req.params.id).select(PUBLIC_PROPERTY_FIELDS).lean();
    // Same visibility rule as the /property/:id page: a listing that is sold,
    // reserved or hidden behind an active lease is not served publicly.
    if (!p || p.status !== 'available') return res.status(404).json({ error: 'Not found' });
    res.json(optimizePropertyImages(p));
  } catch (err) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

// View counter — fired by the public site when someone opens a property's
// details. Pure browsing signal for the admin dashboard; fire-and-forget.
// Its own looser bucket: it fires once per listing opened, and sharing the
// 30-per-10-minutes form budget meant a buyer who browsed 30 listings got a
// 429 on the enquiry they then sent.
app.post('/api/properties/:id/view', trackLimiter, async (req, res) => {
  try {
    await Property.updateOne({ _id: req.params.id }, { $inc: { views: 1 } });
    res.status(204).end();
  } catch (err) {
    res.status(204).end(); // never bother the visitor about this
  }
});

// ── SEO: per-listing pages + dynamic sitemap ──────────────────
const SITE_URL = 'https://glrarealty.com';

// XML-safe text for sitemap entries — an & or < in a listing title would
// otherwise make the whole sitemap unparseable to Google.
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function absUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return SITE_URL + (u.startsWith('/') ? '' : '/') + u;
}

// Rewrite a Cloudinary delivery URL to auto-pick the best format (WebP/AVIF)
// and auto-tune quality — large bandwidth savings, especially on mobile, with
// no quality loss the eye will notice. Non-Cloudinary URLs pass through
// untouched, and we never double-apply (guard on existing f_/q_ transform).
function optimizeCloudinary(u) {
  if (typeof u !== 'string' || u.indexOf('res.cloudinary.com') === -1) return u;
  if (u.indexOf('/upload/f_') !== -1 || u.indexOf('/upload/q_') !== -1) return u;
  return u.replace('/upload/', '/upload/f_auto,q_auto/');
}
// A small cropped copy for thumbnails and cards. Non-Cloudinary URLs, and
// ones that already carry a transformation, pass through unchanged.
function cloudinaryThumb(u, w, h) {
  if (typeof u !== 'string' || u.indexOf('res.cloudinary.com') === -1) return u;
  // The plain format/quality step some stored URLs already carry is replaced;
  // any other existing transformation is someone's deliberate crop, so kept.
  u = u.replace('/upload/f_auto,q_auto/', '/upload/');
  if (/\/upload\/[a-z]{1,2}_/.test(u)) return u;
  return u.replace('/upload/', `/upload/f_auto,q_auto,c_fill,g_auto,w_${w || 184},h_${h || 140}/`);
}
function optimizePropertyImages(p) {
  if (!p) return p;
  publicGeo(p);
  // Inline photos are swapped for their /api/property-image/<id>/<index> URL
  // first: that index is the photo's place in the stored gallery, so it has to
  // be taken before applyWebsiteCover reorders anything.
  externalizeInlineImages(p);
  applyWebsiteCover(p);
  if (p.mainImage) p.mainImage = optimizeCloudinary(p.mainImage);
  if (Array.isArray(p.gallery)) p.gallery = p.gallery.map(optimizeCloudinary);
  if (p.floorPlan) p.floorPlan = optimizeCloudinary(p.floorPlan);
  return p;
}


// Some listings have their photo stored in the database as a base64 "data:"
// URI instead of a hosted URL. Those blobs were being inlined into every JSON
// response: one 3 MB photo made up 98% of the entire /api/properties payload,
// so every visitor downloaded megabytes of text before a single card appeared.
// They also can't be used as an og:image or a sitemap image (a data: URI is not
// a fetchable URL). Swap them for a real image endpoint — the JSON stays small
// and the browser loads the photo as a normal, cacheable, parallel request.
function isDataUri(v) { return typeof v === 'string' && v.startsWith('data:'); }

// Stock photography is not a photo of the listing. Six listings carried the
// same Unsplash dining-room picture as their cover, three of them bare
// agricultural lots, on a site that promises every property is photographed in
// person. Left out everywhere, so the page shows its own placeholder instead.
const STOCK_PHOTO_HOSTS = /^https?:\/\/(images\.unsplash\.com|plus\.unsplash\.com|images\.pexels\.com|cdn\.pixabay\.com)\//i;
function isStockPhoto(v) { return typeof v === 'string' && STOCK_PHOTO_HOSTS.test(v); }

function externalizeInlineImages(p) {
  if (!p || !p._id) return p;
  if (isStockPhoto(p.mainImage)) p.mainImage = '';
  if (Array.isArray(p.gallery)) p.gallery = p.gallery.filter(g => !isStockPhoto(g));
  const id = String(p._id);
  if (isDataUri(p.mainImage)) p.mainImage = `/api/property-image/${id}/main`;
  if (Array.isArray(p.gallery)) {
    p.gallery = p.gallery.map((g, i) => isDataUri(g) ? `/api/property-image/${id}/${i}` : g);
  }
  return p;
}

// Photographs published on the static marketing pages, read once at boot so
// the sitemap can point Google Images at them. The five Arthaland development
// pages carry between twelve and twenty photographs each and not one of them
// was discoverable: an <img> inside a page Google has to render is far weaker
// than an <image:loc> in the sitemap. Capped at six per page - the sitemap is
// a map, not a gallery.
const PAGE_IMAGES = (() => {
  const map = {};
  try {
    const dir = path.join(__dirname, 'public');
    fs.readdirSync(dir).filter(f => f.endsWith('.html') && !['admin.html', 'agent.html', '404.html'].includes(f))
      .forEach(f => {
        const html = fs.readFileSync(path.join(dir, f), 'utf8');
        const seen = new Set();
        const re = /<img\b[^>]*\bsrc="(\/img\/[^"]+\.(?:jpe?g|png|webp))"/gi;
        let m;
        while ((m = re.exec(html)) && seen.size < 6) seen.add(m[1]);
        // The Arthaland pages build their gallery from a JS array of names, so
        // the <img> scan above only sees the first one or two. Pick up the
        // literal paths in the source as well.
        const re2 = /['"](\/img\/arthaland\/[a-z0-9\-]+\/[^'"]+\.(?:jpe?g|png|webp))['"]/gi;
        while ((m = re2.exec(html)) && seen.size < 6) seen.add(m[1]);
        if (seen.size) map['/' + f] = [...seen];
      });
  } catch (e) { /* a sitemap without images is still a valid sitemap */ }
  return map;
})();


// ══ AREA PAGES ══════════════════════════════════════════════
// "Condos for sale in Makati" is a search; "what Makati is like to live in" is
// a different one, and the neighbourhood guides only answer the second. These
// answer the first, out of the live inventory, so they are never out of date.
//
// Matching runs against the WHOLE location string. Splitting on the first comma
// does not work here: `location` is free text a broker types, and its first
// segment is as often a street, a building or a plus code as it is a city.
const AREAS = [
  // "rockwell center", not "rockwell": Rockwell is also a developer, and
  // "THE ARTON BY ROCKWELL" (Aurora Blvd, Quezon City) was filed under Makati.
  ['makati',      'Makati',                 /\b(makati|legaspi village|salcedo village|rockwell center|poblacion)\b/i, 'living-in-makati.html'],
  ['bgc',         'Bonifacio Global City',  /\b(bgc|bonifacio global|forbestown|mckinley|fort bonifacio|uptown bonifacio)\b/i, 'living-in-bgc.html'],
  ['taguig',      'Taguig',                 /\btaguig\b/i, 'living-in-bgc.html'],
  ['quezon-city', 'Quezon City',            /\b(quezon city|vertis north|eastwood|katipunan|cubao|diliman|novaliches|pasong putik)\b/i, ''],
  ['manila',      'Manila',                 /\b(manila city|city of manila|ermita|malate|sampaloc|binondo|intramuros|paco|santa cruz)\b/i, ''],
  ['mandaluyong', 'Mandaluyong',            /\b(mandaluyong|wack wack|greenfield district)\b/i, ''],
  ['pasig',       'Pasig',                  /\b(pasig|oranbo|caniogan|kapitolyo|ortigas east|ortigas center)\b/i, ''],
  ['pasay',       'Pasay',                  /\b(pasay|mall of asia|\bmoa\b|bay area)\b/i, ''],
  ['alabang',     'Alabang and Muntinlupa', /\b(alabang|muntinlupa|filinvest city)\b/i, 'living-in-alabang.html'],
  ['paranaque',   'Paranaque',              /\b(para\u00f1aque|paranaque|bf homes|better living|sucat)\b/i, ''],
  // Not inside a hyphenated road name: a lot on the "Rosario-San Juan-
  // Candelaria Road" in Quezon province is not in San Juan, Metro Manila.
  ['san-juan',    'San Juan',               /(?<!-)\bsan juan\b(?!-)/i, ''],
  ['las-pinas',   'Las Pinas',              /\b(las pi\u00f1as|las pinas|bf international)\b/i, ''],
  ['cebu',        'Cebu',                   /\bcebu\b/i, ''],
  ['tagaytay',    'Tagaytay',               /\btagaytay\b/i, ''],
  ['cavite',      'Cavite',                 /\b(cavite|dasmari\u00f1as|dasmarinas|imus|bacoor|silang)\b/i, ''],
  ['laguna',      'Laguna',                 /\b(laguna|sta\.? rosa|santa rosa|bi\u00f1an|binan|calamba|los ba\u00f1os)\b/i, ''],
  ['rizal',       'Rizal',                  /\b(rizal|antipolo|taytay|cainta|angono)\b/i, ''],
  ['bulacan',     'Bulacan',                /\b(bulacan|malolos|meycauayan|san jose del monte)\b/i, ''],
  ['batangas',    'Batangas',               /\b(batangas|lipa|nasugbu|talisay)\b/i, ''],
  ['quezon-prov', 'Quezon Province',        /\b(tayabas|candelaria|lucena)\b/i, ''],
  ['bataan',      'Bataan',                 /\b(bataan|mariveles|balanga)\b/i, ''],
  ['boracay',     'Boracay',                /\bboracay\b/i, '']
];
const AREA_BY_SLUG = new Map(AREAS.map(a => [a[0], a]));
const METRO_AREA_SLUGS = new Set(['makati', 'bgc', 'taguig', 'quezon-city', 'manila', 'mandaluyong',
  'pasig', 'pasay', 'alabang', 'paranaque', 'san-juan', 'las-pinas']);

// A page needs real inventory behind it. One listing is a thin page, and thin
// pages cost more than they earn.
const AREA_MIN_LISTINGS = 3;
const AREA_TTL_MS = 5 * 60 * 1000;
let _areaCache = { at: 0, counts: null };

function areaHaystack(p) {
  return ((p.location || '') + ' ' + (p.title || '')).toLowerCase();
}

async function areaListings(area) {
  const rows = await Property.find({ status: 'available' })
    .select(PUBLIC_PROPERTY_FIELDS).sort({ createdAt: -1 }).lean();
  const mine = rows.filter(p => area[2].test(areaHaystack(p)));
  mine.forEach(optimizePropertyImages);
  return mine;
}

// How many listings each area has right now, for the sitemap and for the
// cross-links at the foot of every area page. Cached: it is one query used by
// every one of these pages.
async function areaCounts() {
  if (_areaCache.counts && Date.now() - _areaCache.at < AREA_TTL_MS) return _areaCache.counts;
  const counts = {};
  try {
    const rows = await Property.find({ status: 'available' })
      .select('location title').lean();
    AREAS.forEach(a => {
      counts[a[0]] = rows.filter(p => a[2].test(areaHaystack(p))).length;
    });
    _areaCache = { at: Date.now(), counts };
  } catch (e) { return _areaCache.counts || {}; }
  return counts;
}
function invalidateAreaCache() { _areaCache = { at: 0, counts: null }; }

// The areas that currently have a page, for the chips on properties.html.
// Served from the server so there is one list of areas, not two.
app.get('/api/areas', async (req, res) => {
  try {
    const counts = await areaCounts();
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json(AREAS
      .filter(a => (counts[a[0]] || 0) >= AREA_MIN_LISTINGS)
      .map(a => ({ slug: a[0], name: a[1], count: counts[a[0]] })));
  } catch (e) { res.json([]); }
});

app.get('/properties/:slug', async (req, res, next) => {
  const area = AREA_BY_SLUG.get(String(req.params.slug || '').toLowerCase());
  if (!area) return next();
  try {
    const rows = await areaListings(area);
    // Below the threshold there is no page. A 302 rather than a 404: the
    // listings genuinely are on the main list, and an area that is quiet this
    // month may have six listings next month.
    if (rows.length < AREA_MIN_LISTINGS) return res.redirect(302, '/properties.html');
    const counts = await areaCounts();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.send(buildAreaPageHtml(area, rows, counts));
  } catch (err) {
    console.error('area page error:', err.message);
    return res.redirect(302, '/properties.html');
  }
});

function peso(n) { return '\u20b1' + Number(n || 0).toLocaleString('en-PH'); }

function buildAreaPageHtml(area, rows, counts) {
  const [slug, name, , guide] = area;
  const canonical = `${SITE_URL}/properties/${slug}`;
  const forSale = rows.filter(p => !/LEASE$/i.test(String(p.listingType || '')) || /SALE/i.test(String(p.listingType || '')));
  const sale = rows.filter(p => /SALE/i.test(String(p.listingType || '')));
  const lease = rows.filter(p => /LEASE/i.test(String(p.listingType || '')));
  const salePrices = sale.map(p => p.price).filter(n => n > 0).sort((a, b) => a - b);
  const leasePrices = lease.map(p => p.monthlyRental || p.price).filter(n => n > 0).sort((a, b) => a - b);
  const kinds = [...new Set(rows.map(p => String(p.propertyType || '').trim()).filter(Boolean))];

  // The opening sentence is written from the real numbers rather than being a
  // template with a place name dropped into it.
  const bits = [];
  if (sale.length) {
    bits.push(salePrices.length
      ? `${sale.length} ${sale.length === 1 ? 'property' : 'properties'} for sale from ${peso(salePrices[0])} to ${peso(salePrices[salePrices.length - 1])}`
      : `${sale.length} for sale`);
  }
  if (lease.length) {
    bits.push(leasePrices.length
      ? `${lease.length} for lease from ${peso(leasePrices[0])} a month`
      : `${lease.length} for lease`);
  }
  const summary = `GLRA Realty currently has ${bits.join(' and ')} in ${name}.`
    + (kinds.length ? ` Mostly ${kinds.slice(0, 3).join(', ').toLowerCase()}.` : '');

  const metaDesc = `${sale.length + lease.length} properties for sale and lease in ${name}, Philippines`
    + (salePrices.length ? `, from ${peso(salePrices[0])}` : '')
    + `. Handled directly by a PRC-licensed broker.`;

  const card = p => {
    const isLease = /LEASE/i.test(String(p.listingType || '')) && !/SALE/i.test(String(p.listingType || ''));
    const amount = isLease ? (p.monthlyRental || p.price) : (p.price || p.monthlyRental);
    const img = p.mainImage ? absUrl(cloudinaryThumb(p.mainImage, 640, 400)) : '';
    const specs = [p.bedrooms ? p.bedrooms + ' BR' : '', p.bathrooms ? p.bathrooms + ' BA' : '',
                   p.sqm ? p.sqm + ' sqm' : ''].filter(Boolean).join(' \u00b7 ');
    return `<a class="ar-card" href="/property/${String(p._id)}">
      ${img ? `<img src="${esc(img)}" alt="${esc(p.title || 'Property')}" loading="lazy" width="320" height="200">`
        : `<span class="ar-noph" aria-hidden="true">${esc(String(p.propertyType || 'Property').trim())}<small>Photos on request</small></span>`}
      <span class="ar-badge">${esc(String(p.listingType || 'FOR SALE').toUpperCase())}</span>
      <span class="ar-t">${esc(p.title || 'Property')}</span>
      <span class="ar-l">${esc(p.location || '')}</span>
      ${specs ? `<span class="ar-s">${esc(specs)}</span>` : ''}
      <span class="ar-p">${amount ? esc(peso(amount) + (isLease ? '/mo' : '')) : 'Price on request'}</span>
    </a>`;
  };

  const others = AREAS.filter(a => a[0] !== slug && (counts[a[0]] || 0) >= AREA_MIN_LISTINGS)
    .map(a => `<a href="/properties/${a[0]}">${esc(a[1])} <b>${counts[a[0]]}</b></a>`).join('');

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': canonical,
        url: canonical,
        name: `Property for sale and lease in ${name}`,
        description: metaDesc,
        inLanguage: 'en-PH',
        isPartOf: { '@id': SITE_URL + '/#organization' },
        about: { '@type': 'Place', name: name + ', Philippines' }
      },
      {
        '@type': 'ItemList',
        numberOfItems: rows.length,
        itemListElement: rows.slice(0, 30).map((p, i) => ({
          '@type': 'ListItem', position: i + 1,
          url: `${SITE_URL}/property/${String(p._id)}`,
          name: p.title || 'Property'
        }))
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
          { '@type': 'ListItem', position: 2, name: 'Properties', item: SITE_URL + '/properties.html' },
          { '@type': 'ListItem', position: 3, name: name, item: canonical }
        ]
      }
    ]
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<script>(function(){try{if(localStorage.getItem('darkMode')==='true')document.documentElement.classList.add('dark-mode-pre')}catch(e){}})();</script>
<title>Property for Sale &amp; Lease in ${esc(name)} | GLRA Realty</title>
<meta name="description" content="${esc(metaDesc)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="Property for Sale &amp; Lease in ${esc(name)} | GLRA Realty">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="${esc(rows[0] && rows[0].mainImage ? absUrl(optimizeCloudinary(rows[0].mainImage)) : SITE_URL + '/img/social-card.png')}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/img/favicon-64.png">
<link rel="apple-touch-icon" sizes="180x180" href="/img/icon-180.png">
<link rel="preconnect" href="https://res.cloudinary.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"></noscript>
<style>i.fas,i.far,i.fab,i.fa,i.fa-solid,i.fa-regular,i.fa-brands{display:inline-block;min-width:1em}</style>
<script type="application/ld+json">${jsonld}</script>
<style>
:root{--paper:#f1eee9;--paper2:#e8e4dd;--ink:#0a0a0a;--gray:#5f5b55;--line:#0a0a0a;--hot:#ff3d00;--hot-text:#c02e00;--hot-btn:#df3500;--glra-max:1400px;--glra-gut:40px;--glra-pad:max(var(--glra-gut),calc((100% - var(--glra-max)) / 2));}
@media(max-width:980px){:root{--glra-gut:24px}}@media(max-width:560px){:root{--glra-gut:24px}}
body.dark-mode{--paper:#0e0e0c;--paper2:#1a1a17;--ink:#f1eee9;--gray:#9a9082;--line:#3a3a36;--hot-text:#ff3d00;--hot-btn:#df3500}
html.dark-mode-pre,html.dark-mode-pre body{background:#0e0e0c;color:#f1eee9}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:var(--paper);color:var(--ink)}
body{font-family:'Inter',system-ui,sans-serif;line-height:1.5;font-weight:500}
img{display:block;max-width:100%}
a{color:inherit;text-decoration:none}
.ar-nav{display:flex;align-items:center;justify-content:space-between;padding:16px var(--glra-pad);border-bottom:2px solid var(--line);background:var(--paper)}
.ar-nav img{height:50px;width:auto}
.ar-back{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border:2px solid var(--line);padding:9px 16px}
.ar-back:hover{background:var(--hot);color:#fff;border-color:var(--hot)}
.ar-wrap{max-width:calc(var(--glra-max) + 2 * var(--glra-gut));margin:0 auto;padding:26px var(--glra-gut) 60px}
.ar-crumbs{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);margin-bottom:16px;display:flex;flex-wrap:wrap;gap:6px}
.ar-crumbs a:hover{color:var(--hot-text)}
h1{font-size:clamp(30px,5.4vw,50px);font-weight:900;letter-spacing:-1.8px;text-transform:uppercase;line-height:1.02;margin-bottom:12px}
.ar-sum{font-size:17px;color:var(--gray);max-width:70ch;margin-bottom:8px}
.ar-guide{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.5px;margin-bottom:26px}
.ar-guide a{border-bottom:2px solid var(--hot)}
.ar-label{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--gray);border-bottom:2px solid var(--line);padding-bottom:8px;margin:34px 0 16px}
.ar-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
.ar-card{display:block;border:2px solid var(--line);background:var(--paper2);padding-bottom:14px;position:relative}
.ar-card:hover{border-color:var(--hot)}
.ar-card img{width:100%;height:190px;object-fit:cover;border-bottom:2px solid var(--line);margin-bottom:12px}
.ar-noph{display:flex;flex-direction:column;justify-content:flex-end;gap:4px;height:190px;padding:16px;margin-bottom:12px;border-bottom:2px solid var(--line);background:var(--paper);font-weight:800;font-size:17px;line-height:1.2}
.ar-noph small{font-family:'JetBrains Mono',monospace;font-weight:500;font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gray)}
.ar-badge{position:absolute;top:10px;left:10px;background:var(--hot);color:#fff;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1.4px;font-weight:700;padding:5px 9px}
.ar-t{display:block;padding:0 14px;font-size:15px;font-weight:800;line-height:1.25;letter-spacing:-.2px;margin-bottom:5px}
.ar-l{display:block;padding:0 14px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);margin-bottom:7px}
.ar-s{display:block;padding:0 14px;font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--gray);margin-bottom:7px}
.ar-p{display:block;padding:0 14px;font-size:17px;font-weight:900;color:var(--hot-text);letter-spacing:-.4px}
.ar-others{display:flex;flex-wrap:wrap;gap:9px;margin-top:10px}
.ar-others a{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.6px;text-transform:uppercase;border:2px solid var(--line);padding:8px 13px}
.ar-others a:hover{border-color:var(--hot);color:var(--hot-text)}
.ar-others b{color:var(--hot-text)}
.ar-cta{border:2px solid var(--line);background:var(--paper2);padding:24px;margin-top:38px}
.ar-cta h2{font-size:22px;font-weight:900;letter-spacing:-.6px;text-transform:uppercase;margin-bottom:8px}
.ar-cta p{color:var(--gray);margin-bottom:14px;max-width:62ch}
.ar-cta a{display:inline-block;background:var(--hot-btn);color:#fff;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;padding:13px 22px}
/* a11y.js inserts this link on every page; the rule it needs lives in
   styles.css, which this template does not load. Without it the link is just
   visible text at the top of the page. */
.skip-to-content{position:fixed;top:-100px;left:8px;background:#0a0a0a;color:#fff;border:2px solid var(--hot);padding:14px 22px;z-index:2147483647;font-weight:700;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;font-family:'JetBrains Mono',monospace;transition:top .25s cubic-bezier(.2,.7,.2,1)}
.skip-to-content:focus{top:8px;outline:2px solid var(--hot);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.skip-to-content{transition:none}}
/* main.js injects these and only sizes them below 768px; the desktop sizing is
   in styles.css, which this template does not load either. */
.floating-buttons{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:1000}
.floating-buttons > *{width:44px;height:44px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;border:2px solid var(--line);background:var(--ink);color:var(--paper);font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;border-radius:0}
.floating-buttons > *:hover{background:var(--hot-btn);color:#fff;border-color:var(--hot-btn)}
:is(a,button,input,textarea,select,[tabindex]):focus-visible{outline:3px solid var(--hot);outline-offset:2px}
/* 24x24 CSS px is the WCAG 2.2 AA floor for any pointer, not just touch. */
.ar-crumbs a,.ar-others a{display:inline-block;min-height:24px;line-height:24px}
.ar-foot{border-top:2px solid var(--line);padding:22px 24px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1px;color:var(--gray)}
/* A pointer target under 24x24 fails WCAG 2.2 AA, and 44 is the comfortable
   size on a phone. This page's nav is two links and nothing else. */
@media(max-width:768px){
  .ar-nav a,.ar-crumbs a,.ar-cta a{min-height:44px;display:inline-flex;align-items:center}
  .ar-others a{min-height:44px;display:inline-flex;align-items:center}
}
/* Matches viewport-fit=cover, or the nav sits under the notch in landscape. */
@supports(padding:max(0px)){
  .ar-nav{padding-left:max(var(--glra-pad),env(safe-area-inset-left));padding-right:max(var(--glra-pad),env(safe-area-inset-right))}
}
@media(max-width:560px){.ar-wrap{padding:20px var(--glra-gut) 46px}.ar-nav{padding:14px var(--glra-gut)}}
</style>
</head>
<body>
<nav class="ar-nav">
  <a href="/" aria-label="GLRA Realty home"><img src="/img/logo-384.png" alt="GLRA Realty" width="384" height="384" data-logo-auto></a>
  <a href="/properties.html" class="ar-back">\u2190 All listings</a>
</nav>
<main class="ar-wrap" id="main" tabindex="-1">
  <nav class="ar-crumbs" aria-label="Breadcrumb">
    <a href="/">Home</a> <span>/</span> <a href="/properties.html">Properties</a> <span>/</span> <span aria-current="page">${esc(name)}</span>
  </nav>
  <h1>Property in ${esc(name)}</h1>
  <p class="ar-sum">${esc(summary)}</p>
  ${guide ? `<p class="ar-guide">Thinking about the area itself? Read the <a href="/${guide}">${esc(name)} neighbourhood guide</a>.</p>` : '<div style="height:18px"></div>'}

  ${sale.length ? `<div class="ar-label">For sale in ${esc(name)} (${sale.length})</div>
  <div class="ar-grid">${sale.map(card).join('')}</div>` : ''}

  ${lease.length ? `<div class="ar-label">For lease in ${esc(name)} (${lease.length})</div>
  <div class="ar-grid">${lease.map(card).join('')}</div>` : ''}

  ${others ? `<div class="ar-label">Other areas</div><div class="ar-others">${others}</div>` : ''}

  <div class="ar-cta">
    <h2>Not seeing it?</h2>
    <p>Not everything is listed publicly, and some owners ask us to keep a unit off the website. Tell Catherine what you are after in ${esc(name)} and she will check what is actually available.</p>
    <a href="/#contact">Ask about ${esc(name)} \u2192</a>
  </div>
</main>
<footer class="ar-foot">
  GLRA REALTY &middot; <a href="tel:+639171774572">+63 917 177 4572</a> &middot; <a href="mailto:glrarealty@gmail.com">glrarealty@gmail.com</a>
</footer>
<script>(function(){try{if(localStorage.getItem('darkMode')==='true')document.body.classList.add('dark-mode')}catch(e){}})();</script>
<script src="/js/a11y.js?v=116" defer></script>
</body>
</html>`;
}



// ── DISPLAY TITLE ───────────────────────────────────────────
// Listing titles are typed in capitals ("MONARCH PARKSUITES (PASAY CITY)"),
// which reads as shouting in a heading and in a Google result. This turns an
// all-caps title into title case for DISPLAY ONLY; the stored title is left
// alone and is still what matching, enquiries and URLs use. The same rules are
// implemented in public/js/main.js (window.glraDisplayTitle) so the browse
// pages and these server-rendered pages print identical names.
const DT_KEEP_UPPER = new Set(['BGC', 'CBD', 'SM', 'SMDC', 'DMCI', 'RLC', 'MRT', 'LRT', 'NCR', 'QC', 'UP', 'BPI', 'BDO',
  'RFO', 'HOA', 'LEED', 'MOA', 'BF', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII']);
const DT_ABBR = { 'BRGY.': 'Brgy.', 'STA.': 'Sta.', 'STO.': 'Sto.', 'ST.': 'St.', 'AVE.': 'Ave.', 'BLVD': 'Blvd', 'BLVD.': 'Blvd.' };
const DT_SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'along', 'near', 'with', 'de', 'del']);
function glraDisplayTitle(raw) {
  let s = String(raw || '')
    .replace(/\p{Extended_Pictographic}/gu, '').replace(/\uFE0F/g, '')
    .replace(/\s+[\u2014\u2013-]\s+/g, ' - ')
    .replace(/\s+/g, ' ').trim();
  const letters = s.match(/\p{L}/gu) || [];
  const upper = s.match(/\p{Lu}/gu) || [];
  if (!letters.length || upper.length / letters.length < 0.7) return s;

  const part = (w, first) => {
    if (!w) return w;
    const up = w.toUpperCase();
    if (/^([A-Z]\.){2,}$/.test(w)) return w;
    if (DT_KEEP_UPPER.has(up)) return up;
    if (/^\d+BR$/.test(w)) return w;
    if (up === 'SQM') return 'sqm';
    if (DT_ABBR[up]) return DT_ABBR[up];
    if (/^MC\p{L}{2,}/u.test(up)) return 'Mc' + up.charAt(2) + w.slice(3).toLowerCase();
    const low = w.toLowerCase();
    if (!first && DT_SMALL.has(low)) return low;
    return low.charAt(0).toUpperCase() + low.slice(1);
  };
  let nextFirst = true;
  const out = s.split(' ').map(word => {
    if (word === '-') { nextFirst = true; return word; }
    const m = word.match(/^(\(*)(.*?)([,.)(]*)$/);
    const pre = m[1];
    let core = m[2], suf = m[3];
    const first = nextFirst || !!pre;
    nextFirst = false;
    if (!core) return word;
    // A trailing full stop may belong to the word itself: "ST.", "A.C.T.".
    if (suf.charAt(0) === '.') {
      const dotted = core + '.';
      if (/^([A-Z]\.){2,}$/.test(dotted)) return pre + dotted + suf.slice(1);
      if (DT_ABBR[dotted.toUpperCase()]) return pre + DT_ABBR[dotted.toUpperCase()] + suf.slice(1);
    }
    if (core.toUpperCase() === 'PAG-IBIG') return pre + 'Pag-IBIG' + suf;
    core = core.split('-').map((pt, i) => part(pt, first && i === 0)).join('-');
    return pre + core + suf;
  }).join(' ');
  return out.replace(/ \(([^()]+)\)$/, ', $1');
}

// Build a fully server-rendered, SEO-rich detail page for one property.
// Crawlers and social-share scrapers get real <title>, meta description,
// Open Graph image, and JSON-LD; humans get a styled page with an inquiry form.
// ── Lifestyle score (listing page) ─────────────────────────────────────────
// Six everyday needs, each scored 0 to 100 from what OpenStreetMap has around
// the listing: counts within 500 m and 1 km (nearby.life) and the nearest
// station, hospital and school (nearby.items, within 2 km). A guide for
// comparing listings on this site, and the page says so.
const LIFE_AXES = [
  ['transit', 'Transit', 'fa-train-subway'],
  ['grocery', 'Groceries', 'fa-basket-shopping'],
  ['dining', 'Dining', 'fa-utensils'],
  ['park', 'Parks', 'fa-tree'],
  ['health', 'Health', 'fa-kit-medical'],
  ['school', 'Schools', 'fa-graduation-cap']
];
function lifeScores(nearby) {
  const life = nearby && nearby.life;
  if (!life || typeof life !== 'object') return null;
  const items = Array.isArray(nearby.items) ? nearby.items : [];
  const nearest = cat => items.filter(x => x.cat === cat && Number.isFinite(x.dist)).sort((a, b) => a.dist - b.dist)[0] || null;
  const ring = (k, a, b) => {
    const c = Array.isArray(life[k]) ? life[k] : [0, 0];
    const n5 = Number(c[0]) || 0, n10 = Math.max(n5, Number(c[1]) || 0);
    return { n5, n10, s: Math.min(100, a * n5 + b * (n10 - n5)) };
  };
  const byDist = (d, steps) => { for (const [m, v] of steps) if (d <= m) return v; return 0; };
  const fmt = m => m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km';
  const out = {};
  const rail = nearest('rail'), tr = ring('transit', 14, 3);
  const railS = rail ? byDist(rail.dist, [[500, 100], [1000, 80], [1500, 62], [2000, 45]]) : 0;
  out.transit = { s: Math.max(railS, Math.min(70, tr.s)), note: rail ? `${rail.name}, ${fmt(rail.dist)}` : (tr.n10 ? `${tr.n10} bus or transport stops within 1 km` : 'No station or mapped stop within reach') };
  const g = ring('grocery', 20, 5);
  out.grocery = { s: g.s, note: g.n10 ? `${g.n10} supermarkets, groceries or markets within 1 km` : 'None mapped within 1 km' };
  const d = ring('dining', 5, 1.5);
  out.dining = { s: d.s, note: d.n10 ? `${d.n10} restaurants and cafes within 1 km` : 'None mapped within 1 km' };
  const pk = ring('park', 35, 12);
  out.park = { s: pk.s, note: pk.n10 ? `${pk.n10} parks or playgrounds within 1 km` : 'None mapped within 1 km' };
  const h = ring('health', 20, 6), hosp = nearest('hospital');
  const hospS = hosp ? byDist(hosp.dist, [[1000, 30], [2000, 15]]) : 0;
  out.health = { s: Math.min(100, h.s + hospS), note: hosp ? `${hosp.name}, ${fmt(hosp.dist)}` + (h.n10 ? `; ${h.n10} clinics and pharmacies within 1 km` : '') : (h.n10 ? `${h.n10} clinics and pharmacies within 1 km` : 'None mapped within 1 km') };
  const sc = ring('school', 30, 10), sch = nearest('school');
  const schS = sch ? byDist(sch.dist, [[500, 100], [1000, 80], [2000, 55]]) : 0;
  out.school = { s: Math.max(schS, sc.s), note: sch ? `${sch.name}, ${fmt(sch.dist)}` : (sc.n10 ? `${sc.n10} schools within 1 km` : 'None mapped within 1 km') };
  LIFE_AXES.forEach(([k]) => { out[k].s = Math.round(out[k].s); });
  out.total = Math.round(LIFE_AXES.reduce((a, [k]) => a + out[k].s, 0) / LIFE_AXES.length);
  return out;
}
function lifeHtml(nearby, esc) {
  const L = lifeScores(nearby);
  if (!L) return '';
  const band = L.total >= 80 ? 'Nearly everything within walking distance'
    : L.total >= 60 ? 'Most daily errands on foot'
    : L.total >= 40 ? 'Some errands on foot'
    : 'Most errands need a ride';
  const R = 88, cx = 110, cy = 110, n = LIFE_AXES.length;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n;
    return [(cx + r * Math.cos(a)).toFixed(1), (cy + r * Math.sin(a)).toFixed(1)];
  };
  const rings = [0.25, 0.5, 0.75, 1].map(f => `<polygon class="pg-life-grid" points="${LIFE_AXES.map((_, i) => pt(i, R * f).join(',')).join(' ')}"/>`).join('');
  const spokes = LIFE_AXES.map((_, i) => { const [x, y] = pt(i, R); return `<line class="pg-life-grid" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`; }).join('');
  const shape = `<polygon class="pg-life-shape" points="${LIFE_AXES.map(([k], i) => pt(i, Math.max(4, R * L[k].s / 100)).join(',')).join(' ')}"/>`;
  const labels = LIFE_AXES.map(([k, lbl], i) => {
    const [x, y] = pt(i, R + 20);
    const anchor = Math.abs(x - cx) < 5 ? 'middle' : (x > cx ? 'start' : 'end');
    return `<text x="${x}" y="${Number(y) + 4}" text-anchor="${anchor}">${esc(lbl)}</text>`;
  }).join('');
  return `
      <div class="pg-life">
        <div class="pg-life-head">
          <div class="pg-life-score"><b>${L.total}</b><span>/ 100</span></div>
          <div><h3>Lifestyle score</h3><p>${esc(band)}</p></div>
        </div>
        <div class="pg-life-body">
          <svg class="pg-life-radar" viewBox="-60 -8 340 236" aria-hidden="true" focusable="false">${rings}${spokes}${shape}${labels}</svg>
          <ul class="pg-life-list">${LIFE_AXES.map(([k, lbl, icon]) => `
            <li><i class="fas ${icon}" aria-hidden="true"></i><span><b>${esc(lbl)}</b><small>${esc(L[k].note)}</small></span><em><span class="pg-life-bar"><span style="width:${L[k].s}%"></span></span>${L[k].s}</em></li>`).join('')}
          </ul>
        </div>
        <p class="pg-near-note">Worked out from OpenStreetMap: places within 500 m and 1 km (about a 6- and 12-minute walk), and stations, hospitals and schools within 2 km. A guide for comparing listings, not an official rating. Newer and provincial areas are often under-mapped, so they can score lower than they deserve.</p>
      </div>`;
}

// ── Natural hazards (listing page) ─────────────────────────────────────────
// Levels from server/hazard.js, put into words. UP NOAH's flood depths: low
// is up to 0.5 m, medium 0.5 to 1.5 m, high over 1.5 m. Storm surge levels
// are PAGASA's advisories by storm tide height.
const HZ_WORD = ['None mapped', 'Low', 'Medium', 'High'];
const SURGE_TIDE = ['', '2 to 3 m', '3 to 4 m', '4 to 5 m', 'over 5 m'];
function hazardHtml(p, lat, lng, esc) {
  const h = p.hazard && p.hazard.v ? p.hazard : null;
  const street = Number(p.geo && p.geo.rank) >= 26;
  const condo = /condo|apartment|studio|office/i.test(String(p.propertyType || ''));
  const report = `https://ulap-reports.georisk.gov.ph/api/reports/hazard-assessments/${lng}/${lat}`;
  const links = `
      <div class="pg-hz-links">
        <a class="pg-map-btn" href="${esc(report)}" target="_blank" rel="noopener"><i class="far fa-file-pdf" aria-hidden="true"></i> Official hazard report (PHIVOLCS)</a>
        <a class="pg-map-btn" href="https://hazardhunter.georisk.gov.ph/" target="_blank" rel="noopener"><i class="fas fa-magnifying-glass-location" aria-hidden="true"></i> Check the exact address</a>
      </div>`;
  if (!h) {
    return `
    <section class="pg-hz" aria-labelledby="pgHzH">
      <h2 class="pg-section-label" id="pgHzH">Natural hazards</h2>
      <p class="pg-hz-lead">The flood, storm surge and landslide check for this listing is still running. The government's own report for this spot is ready now.</p>
      ${links}
    </section>`;
  }
  const chip = (lv, txt) => `<span class="pg-hz-chip pg-hz-${lv}">${esc(txt)}</span>`;
  const rows = [];
  // Flood: the deepest level mapped in any of the three rain scenarios (the
  // maps are modelled separately and do not always nest), and how often.
  const fMax = Math.max(h.f5 || 0, h.f25 || 0, h.f100 || 0);
  let floodNote;
  if (!fMax) floodNote = 'Outside the flood areas mapped for even a once-in-100-years rain.';
  else if (h.f5) floodNote = 'Floods even in the heavy rain that comes about once every 5 years.';
  else if (h.f25) floodNote = 'Dry in a 5-year rain; floods in a once-in-25-years rain.';
  else floodNote = 'Dry in 5- and 25-year rains; floods only in a once-in-100-years rain.';
  const depth = ['', 'up to 0.5 m', '0.5 to 1.5 m', 'over 1.5 m'][fMax] || '';
  rows.push(['fa-water', 'Flooding', chip(fMax, fMax ? HZ_WORD[fMax] + ', ' + depth : 'None mapped'), floodNote]);
  // Storm surge: the lower the advisory level that reaches it, the higher the risk.
  const ssLv = h.ss ? Math.max(1, 4 - h.ss) : 0;
  rows.push(['fa-house-flood-water', 'Storm surge', chip(ssLv, h.ss ? 'Level ' + h.ss + ' surge' : 'None mapped'),
    h.ss ? `Reached when PAGASA warns of a Level ${h.ss} storm surge (a storm tide of ${SURGE_TIDE[h.ss]})${h.ss === 1 ? ', the lowest warning level' : ''}.` : 'Not reached by any of the four storm surge warning levels.']);
  rows.push(['fa-hill-rockslide', 'Landslide', chip(h.ls, HZ_WORD[h.ls] || 'None mapped'),
    h.ls ? `In an area mapped with ${HZ_WORD[h.ls].toLowerCase()} landslide susceptibility.` : 'Not in a mapped landslide area.']);
  if (h.df) rows.push(['fa-mountain', 'Debris flow', chip(h.df, HZ_WORD[h.df]), 'In a mapped path of mud and debris flows from nearby slopes.']);
  const clear = !fMax && !h.ss && !h.ls && !h.df;
  const worst = Math.max(fMax, ssLv, h.ls || 0, h.df || 0);
  const lead = clear ? 'No flood, storm surge or landslide hazard is mapped at this spot.'
    : worst >= 3 ? 'This spot is in a high-hazard area on at least one of the government hazard maps. Read the details before you decide.'
    : 'This spot is on at least one of the government hazard maps. Read the details before you decide.';
  return `
    <section class="pg-hz" aria-labelledby="pgHzH">
      <h2 class="pg-section-label" id="pgHzH">Natural hazards</h2>
      <p class="pg-hz-lead">${esc(lead)}</p>
      <ul class="pg-hz-list">${rows.map(([ic, lbl, c, note]) => `
        <li><i class="fas ${ic}" aria-hidden="true"></i><span><b>${esc(lbl)}</b><small>${esc(note)}</small></span>${c}</li>`).join('')}
      </ul>
      ${links}
      <p class="pg-near-note">${street ? 'Checked at the map pin, which is placed from the street address.' : 'Checked at the map pin, which marks the neighbourhood, not the exact building: use the buttons above for the exact address.'}${condo && fMax ? ' Upper floors stay dry; the street, lobby and parking are what flood.' : ''} Flood, storm surge and landslide maps: <a href="https://noah.up.edu.ph" target="_blank" rel="noopener">UP NOAH</a> (ODbL), via BetterGov.ph. Maps are a guide, not a guarantee.</p>
    </section>`;
}

// ── How big is it? (listing page) ──────────────────────────────────────────
// The floor area (or the lot) drawn to scale next to something everyone has
// stood beside: a parking slot (2.5 x 5 m) for units, a basketball court
// (28 x 15 m) for houses and lots.
function sizeHtml(p, esc) {
  const typeTxt = String(p.propertyType || '').trim();
  const noLot = /^(condominium|apartment|office|commercial space|studio)/i.test(typeTxt);
  const floor = Number(p.sqm) || 0, lot = noLot ? 0 : (Number(p.landArea) || 0);
  const isLot = /lot/i.test(typeTxt) && !/house/i.test(typeTxt);
  const area = isLot && lot ? lot : (floor || (noLot ? Number(p.landArea) || 0 : lot));
  if (!(area >= 8 && area <= 2000000)) return '';
  const what = isLot || (!floor && lot) ? 'lot' : 'floor area';
  const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 1 : 0 });
  const big = area > 250;
  const ref = big ? { w: 28, h: 15, a: 420, name: 'basketball court', plural: 'basketball courts' } : { w: 2.5, h: 5, a: 12.5, name: 'parking slot', plural: 'parking slots' };
  const n = area / ref.a;
  const side = Math.sqrt(area);
  // Everything in metres, scaled to fit a 300 x 170 box.
  const refsShown = big ? 1 : Math.min(8, Math.max(1, Math.round(n)));
  const refRowW = big ? ref.w : refsShown * ref.w + (refsShown - 1) * 0.5;
  const worldW = side + 3 + refRowW, worldH = Math.max(side, ref.h);
  const k = Math.min(300 / worldW, 170 / worldH);
  const sq = side * k, gap = 3 * k;
  const y0 = 10 + (worldH * k - sq);
  let refs = '';
  for (let i = 0; i < refsShown; i++) {
    const x = 10 + sq + gap + i * (ref.w + 0.5) * k, w = ref.w * k, hh = ref.h * k, y = 10 + worldH * k - hh;
    refs += big
      ? `<rect class="pg-sz-ref" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}"/><line class="pg-sz-refl" x1="${(x + w / 2).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + w / 2).toFixed(1)}" y2="${(y + hh).toFixed(1)}"/><circle class="pg-sz-refl" cx="${(x + w / 2).toFixed(1)}" cy="${(y + hh / 2).toFixed(1)}" r="${(1.8 * k).toFixed(1)}"/>`
      : `<rect class="pg-sz-ref" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}"/>`;
  }
  const W = Math.ceil(20 + worldW * k), H = Math.ceil(20 + worldH * k);
  const say = n >= 1.5 ? `about ${fmt(n)} ${ref.plural}` : n >= 0.75 ? `about one ${ref.name}` : `about ${Math.round(n * 100)}% of a ${ref.name}`;
  const room = `${side.toFixed(1)} m by ${side.toFixed(1)} m`;
  return `
  <section class="pg-sz" aria-labelledby="pgSzH">
    <h2 class="pg-section-label" id="pgSzH">How big is it?</h2>
    <div class="pg-sz-body">
      <svg class="pg-sz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${fmt(area)} square metres drawn to scale beside ${big ? 'a basketball court' : 'parking slots'}`)}">
        <rect class="pg-sz-unit" x="10" y="${y0.toFixed(1)}" width="${sq.toFixed(1)}" height="${sq.toFixed(1)}"/>
        ${refs}
      </svg>
      <div class="pg-sz-txt">
        <p><b>${esc(fmt(area))} sqm</b> of ${esc(what)} is ${esc(say)}, or a square ${esc(room)}.</p>
        <ul>
          <li><i class="pg-sz-key pg-sz-key-u" aria-hidden="true"></i>This ${what === 'lot' ? 'lot' : 'home'}, drawn as a square</li>
          <li><i class="pg-sz-key pg-sz-key-r" aria-hidden="true"></i>${big ? 'A basketball court, 28 x 15 m' : 'Parking slots, 2.5 x 5 m each'}</li>
        </ul>
        <p class="pg-near-note">Drawn to scale. The real shape and layout will differ; ask for the floor plan.</p>
      </div>
    </div>
  </section>`;
}

// ── How the asking price compares (listing page) ──────────────────────────
// Price per square metre against the other live listings of the same kind,
// in the same city, on the same side (sale or lease). Floor area, or lot area
// for lots. Asking prices on this site only, and the page says so.
function compGroup(x) {
  const t = String(x.propertyType || '').toLowerCase();
  if (/house|townhouse|villa|duplex/.test(t)) return 'house';
  if (/\blot\b|land|farm|agricultural/.test(t)) return 'lot';
  if (/commercial|office|retail|warehouse|building|space/.test(t)) return 'commercial';
  return 'condo';
}
const COMP_WORDS = { condo: ['condominium', 'condominiums'], house: ['house', 'houses'], lot: ['lot', 'lots'], commercial: ['commercial space', 'commercial spaces'] };
function compSells(x) { const t = String(x.listingType || '').toUpperCase(); return t === 'FOR SALE' || t === 'SALE AND LEASE'; }
function compPsqm(x, sale) {
  const price = sale ? (Number(x.price) || 0) : (Number(x.monthlyRental) || Number(x.price) || 0);
  const area = compGroup(x) === 'lot' ? (Number(x.landArea) || Number(x.sqm) || 0) : (Number(x.sqm) || Number(x.landArea) || 0);
  return price > 0 && area > 0 ? price / area : 0;
}
function compCity(x) {
  const a = AREAS.find(ar => ar[2].test(areaHaystack(x)));
  return a ? [a[0], a[1]] : null;
}
async function findPriceComparables(p) {
  try {
    const sale = compSells(p), city = compCity(p), grp = compGroup(p);
    const mine = compPsqm(p, sale);
    if (!city || !mine) return null;
    const rows = await Property.find({ status: 'available', _id: { $ne: p._id } })
      .select('title location price monthlyRental sqm landArea propertyType listingType').lean();
    const others = rows.filter(r => (sale ? compSells(r) : String(r.listingType || '').toUpperCase() !== 'FOR SALE') &&
      compGroup(r) === grp && (compCity(r) || [])[0] === city[0])
      .map(r => compPsqm(r, sale)).filter(v => v > 0);
    if (others.length < 3) return null;
    return { sale, city: city[1], grp, mine, others };
  } catch (e) { return null; }
}
function priceStripHtml(c, esc) {
  if (!c) return '';
  const all = c.others.concat([c.mine]).sort((a, b) => a - b);
  const sorted = c.others.slice().sort((a, b) => a - b);
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const lo = all[0], hi = all[all.length - 1];
  const useLog = hi / lo > 3;
  const pos = v => {
    if (hi === lo) return 50;
    const f = useLog ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo);
    return (3 + f * 94).toFixed(1);
  };
  const money = v => v >= 1e6 ? '₱' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : v >= 1e4 ? '₱' + Math.round(v / 1e3).toLocaleString('en-US') + 'k' : '₱' + Math.round(v).toLocaleString('en-US');
  const unit = c.sale ? '/sqm' : '/sqm a month';
  const diff = (c.mine - mid) / mid;
  const words = COMP_WORDS[c.grp] || ['listing', 'listings'];
  const kind = `${c.others.length} other ${words[1]} ${c.sale ? 'for sale' : 'for lease'} in ${c.city}`;
  const rel = Math.abs(diff) < 0.05 ? `About the same as the typical asking price for the ${kind} on GLRA.`
    : `${Math.round(Math.abs(diff) * 100)}% ${diff < 0 ? 'below' : 'above'} the typical asking price for the ${kind} on GLRA.`;
  const exact = '₱' + Math.round(c.mine).toLocaleString('en-US');
  return `
    <section class="pg-cmp" aria-labelledby="pgCmpH">
      <h2 class="pg-section-label" id="pgCmpH">How the price compares</h2>
      <p class="pg-cmp-lead"><b>${esc(exact)} per sqm${c.sale ? '' : ' a month'}.</b> ${esc(rel)}</p>
      <div class="pg-cmp-strip" aria-hidden="true">
        <span class="pg-cmp-axis"></span>
        ${sorted.map(v => `<span class="pg-cmp-dot" style="left:${pos(v)}%" title="${esc(money(v) + unit)}"></span>`).join('')}
        <span class="pg-cmp-mid" style="left:${pos(mid)}%"><em>Typical ${esc(money(mid))}</em></span>
        <span class="pg-cmp-dot is-me" style="left:${pos(c.mine)}%"><em>This listing</em></span>
      </div>
      <div class="pg-cmp-scale" aria-hidden="true"><span>${esc(money(lo) + unit)}</span><span>${esc(money(hi) + unit)}</span></div>
      <p class="pg-near-note">Each dot is one live listing. Asking prices, not what homes sold for; per square metre of ${c.grp === 'lot' ? 'lot' : 'floor'} area. Typical means the middle of the others.</p>
    </section>`;
}

function buildPropertyPageHtml(p, related, comps) {
  const id = String(p._id);
  // Turn any base64 photo into a real image URL first, so the og:image, the
  // gallery and the <img> tags below all point at something fetchable rather
  // than embedding megabytes of base64 in the HTML.
  externalizeInlineImages(p);
  applyWebsiteCover(p);
  // What people read is the display title (title case, no emoji); the stored
  // title still goes with the enquiry so it matches the listing in the admin.
  const rawTitle = p.title || 'Property';
  const title = glraDisplayTitle(rawTitle) || 'Property';
  const loc = p.location || '';
  const lt = String(p.listingType || 'FOR SALE').toUpperCase();
  const isLease = lt === 'FOR LEASE' || lt === 'SALE AND LEASE';
  const saleP = p.price || 0, leaseP = p.monthlyRental || 0;
  // For structured data, prefer the sale price on dual listings.
  const priceNum = (lt === 'SALE AND LEASE') ? (saleP || leaseP) : (isLease ? (leaseP || saleP) : saleP);
  let priceText;
  if (lt === 'SALE AND LEASE' && saleP && leaseP) {
    priceText = '₱' + Number(saleP).toLocaleString('en-PH') + '  ·  ₱' + Number(leaseP).toLocaleString('en-PH') + '/month';
  } else {
    priceText = priceNum ? ('₱' + Number(priceNum).toLocaleString('en-PH') + (isLease ? '/month' : '')) : 'Price on request';
  }
  const rawImg = p.mainImage || (p.gallery || [])[0] || '/img/social-card.png';
  const ogIsCloudinary = /res\.cloudinary\.com/.test(rawImg);
  // Social-card image: for Cloudinary, build a properly-sized 1200x630 JPEG crop so
  // Facebook / Messenger / Viber render a reliable large preview. The full-res
  // original (often a big portrait phone photo) is frequently rejected by scrapers.
  const ogImg = absUrl(ogIsCloudinary
    ? rawImg.replace('/upload/', '/upload/c_fill,g_auto,w_1200,h_630,f_jpg,q_auto/')
    : rawImg);
  // Sized copies for the hero: a phone downloads a 640px photo, not the
  // original upload (often a 2000px PNG flyer).
  const cldWidth = (u, w) => {
    if (typeof u !== 'string' || u.indexOf('res.cloudinary.com') === -1) return u;
    u = u.replace('/upload/f_auto,q_auto/', '/upload/');
    if (/\/upload\/[a-z]{1,2}_/.test(u)) return u;
    return u.replace('/upload/', `/upload/f_auto,q_auto,c_limit,w_${w}/`);
  };
  const heroIsCld = /res\.cloudinary\.com/.test(rawImg);
  const heroImg = absUrl(heroIsCld ? cldWidth(rawImg, 1200) : optimizeCloudinary(rawImg));
  const heroSrcset = heroIsCld ? [640, 960, 1200, 1600].map(w => `${absUrl(cldWidth(rawImg, w))} ${w}w`).join(', ') : '';
  const heroSizes = '(min-width: 1180px) 760px, (min-width: 1024px) calc(100vw - 420px), calc(100vw - 32px)';
  const canonical = `${SITE_URL}/property/${id}`;
  // Cleaned first: Google was being handed the emoji and hashtags as the
  // search snippet for every listing.
  const descBase = (String(p.webSummary || '').trim() || glraCleanDescription(p.description)).replace(/\s+/g, ' ').trim();
  const metaDesc = (`${title}${loc ? ' in ' + loc : ''} — ${priceText}. ${descBase}`).slice(0, 160).trim();
  // Descriptions are written as Facebook posts and imported as typed, so they
  // arrive with emoji on every line, the broker's own contact block, a markdown
  // mail link that renders as raw text, and a tail of hashtags. Cleaned at
  // render time rather than in the database, so the next import cannot bring it
  // back — which is what kept happening.
  const descDisplay = glraCleanDescription(p.description);
  const gallery = (p.gallery || []).filter(Boolean);
  // Written for the website by Catherine in the admin; leads the page when set.
  const webSummary = String(p.webSummary || '').trim();
  const floorPlanUrl = /^https:\/\/res\.cloudinary\.com\//.test(p.floorPlan || '') ? p.floorPlan : '';
  const floorPlanHtml = floorPlanUrl ? `<section class="pg-plan" aria-labelledby="pgPlanH">
    <h2 class="pg-section-label" id="pgPlanH">Floor plan</h2>
    <a href="${esc(absUrl(cldWidth(floorPlanUrl, 2000)))}" target="_blank" rel="noopener"><img src="${esc(absUrl(cldWidth(floorPlanUrl, 1200)))}" alt="Floor plan of ${esc(title)}" loading="lazy" decoding="async"></a>
    <p>Tap the plan to open it full size. Plans come from the developer; the unit as built may differ slightly.</p>
  </section>` : '';

  // Which area page, if any, this listing belongs under. Needed by both the
  // structured data and the visible breadcrumb below.
  const ownArea = AREAS.find(a => a[2].test(((p.location || '') + ' ' + (p.title || '')).toLowerCase()));

  // The listing, the home itself, and the offer, as one connected graph.
  // `Product` alone said nothing about floor area, bedrooms or where it is,
  // all of which are printed on the page a few lines below.
  // The cover photograph first, then the gallery, de-duplicated. Building this
  // from `gallery` alone left the best photo on the listing out of the markup
  // entirely, because mainImage is held separately from the gallery array.
  const galleryAbs = [...new Set([rawImg, ...gallery].filter(Boolean))]
    .slice(0, 8).map(g => absUrl(optimizeCloudinary(g)));
  const residence = {
    // Matched on the words: no listing is typed plain "Lot", so every vacant
    // lot, farm and office used to be described to Google as an "Apartment".
    '@type': /house|townhouse/i.test(p.propertyType || '') ? 'SingleFamilyResidence'
      : /^\s*(condominium|apartment|studio)/i.test(p.propertyType || '') ? 'Apartment' : 'Place',
    '@id': canonical + '#home',
    name: title,
    address: {
      '@type': 'PostalAddress',
      addressLocality: loc || 'Metro Manila',
      // Every listing used to claim Metro Manila, Boracay and Batangas included.
      ...(ownArea ? { addressRegion: METRO_AREA_SLUGS.has(ownArea[0]) ? 'Metro Manila' : ownArea[1] } : {}),
      addressCountry: 'PH'
    }
  };
  if (p.sqm) residence.floorSize = { '@type': 'QuantitativeValue', value: Number(p.sqm), unitCode: 'MTK' };
  // A lot listing has no floor size, so without this Google sees no area at all.
  if (p.landArea) {
    var _noLot = /^(condominium|apartment|office|commercial space|studio)/i.test(String(p.propertyType || '').trim());
    var _area = { '@type': 'QuantitativeValue', value: Number(p.landArea), unitCode: 'MTK' };
    if (_noLot) { if (!residence.floorSize) residence.floorSize = _area; }
    else residence.lotSize = _area;
  }
  if (p.bedrooms) residence.numberOfRooms = Number(p.bedrooms);
  if (p.bathrooms) residence.numberOfBathroomsTotal = Number(p.bathrooms);
  // Found to at least district level by the location worker. Rounded to about
  // 100 m, the same precision the public API gives.
  const geoOk = !!(p.geo && p.geo.status === 'ok' && Number.isFinite(p.geo.lat) && Number.isFinite(p.geo.lng) && p.geo.rank >= NEARBY_MIN_RANK);
  if (geoOk) residence.geo = { '@type': 'GeoCoordinates', latitude: Number(p.geo.lat.toFixed(3)), longitude: Number(p.geo.lng.toFixed(3)) };
  if (galleryAbs.length || ogImg) residence.photo = galleryAbs.length ? galleryAbs : [ogImg];

  const offerBase = { '@type': 'Offer', priceCurrency: 'PHP', availability: 'https://schema.org/InStock',
    url: canonical, seller: { '@type': 'RealEstateAgent', name: 'GLRA Realty', url: SITE_URL } };
  const offersList = [];
  const forSale = lt === 'FOR SALE' || lt === 'SALE AND LEASE';
  const rentNum = lt === 'SALE AND LEASE' ? leaseP : (leaseP || saleP);
  if (forSale && saleP > 0) {
    offersList.push({ ...offerBase, price: Number(saleP), businessFunction: 'http://purl.org/goodrelations/v1#Sell' });
  }
  if (isLease && rentNum > 0) {
    offersList.push({ ...offerBase, price: Number(rentNum), businessFunction: 'http://purl.org/goodrelations/v1#LeaseOut',
      priceSpecification: { '@type': 'UnitPriceSpecification', price: Number(rentNum), priceCurrency: 'PHP', unitCode: 'MON' } });
  }

  const listedOn = new Date(p.createdAt || Date.now()).toISOString();
  const updatedOn = new Date(p.priceUpdatedAt || p.createdAt || Date.now()).toISOString();

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'RealEstateListing',
        '@id': canonical,
        url: canonical,
        name: title,
        description: metaDesc,
        image: galleryAbs.length ? galleryAbs : [ogImg],
        datePosted: listedOn,
        dateModified: updatedOn,
        inLanguage: 'en-PH',
        mainEntity: { '@id': canonical + '#home' },
        provider: { '@type': 'RealEstateAgent', name: 'GLRA Realty', url: SITE_URL },
        // One offer per deal on the table. A sale-and-lease listing used to send
        // one "lease" offer carrying the SALE price, so Google was told the
        // Arton rents for P8,500,000; a listing with no price sent an offer of
        // 0. Now a sale offer, a monthly lease offer, both, or none.
        ...(offersList.length ? { offers: offersList.length === 1 ? offersList[0] : offersList } : {})
      },
      residence,
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
          { '@type': 'ListItem', position: 2, name: 'Properties', item: SITE_URL + '/properties.html' },
          ...(ownArea
            ? [{ '@type': 'ListItem', position: 3, name: ownArea[1], item: SITE_URL + '/properties/' + ownArea[0] }]
            : loc ? [{ '@type': 'ListItem', position: 3, name: loc, item: SITE_URL + '/properties.html?search=' + encodeURIComponent(loc) }] : []),
          { '@type': 'ListItem', position: loc ? 4 : 3, name: title, item: canonical }
        ]
      }
    ]
  }).replace(/</g, '\\u003c');

  // The visible trail. Google will only draw a breadcrumb in the result if it
  // can see one, and a person two clicks deep from a Facebook share needs a
  // way back up that is not the browser's back button.
// If this listing sits in one of the areas that has its own page, the
  // breadcrumb points there rather than at a search query: a better
  // destination for a reader, and what makes the area pages reachable without
  // JavaScript from every listing in that area.
  const areaCrumb = ownArea
    ? `<a href="/properties/${ownArea[0]}">${esc(ownArea[1])}</a>`
    : (loc ? `<a href="/properties.html?search=${encodeURIComponent(loc)}">${esc(loc)}</a>` : '');
  const crumbHtml = `<nav class="pg-crumbs" aria-label="Breadcrumb">
    <a href="/">Home</a> <span>/</span>
    <a href="/properties.html">Properties</a>${areaCrumb ? ` <span>/</span>
    ${areaCrumb}` : ''}
    <span>/</span> <span aria-current="page">${esc(title)}</span>
  </nav>`;

  // Real links to other listings. Without these every listing page is an
  // island: the cards that link to them on properties.html only exist after
  // that page's JavaScript runs, and not every crawler runs it.
  const rel = Array.isArray(related) ? related : [];
  const relatedHtml = rel.length ? `
  <div class="pg-section-label">More listings you may like</div>
  <div class="pg-related">
    ${rel.map(r => {
      const rLease = String(r.listingType || '').toUpperCase() === 'FOR LEASE';
      const rPrice = rLease ? (r.monthlyRental || r.price || 0) : (r.price || 0);
      const rTxt = rPrice ? ('₱' + Number(rPrice).toLocaleString('en-PH') + (rLease ? '/mo' : '')) : 'Price on request';
      const rImg = r.mainImage && !isStockPhoto(r.mainImage) ? absUrl(cloudinaryThumb(r.mainImage, 400, 280)) : '';
      const rTitle = glraDisplayTitle(r.title) || 'Property';
      return `<a class="pg-rel" href="/property/${String(r._id)}">
        ${rImg ? `<img src="${esc(rImg)}" alt="${esc(rTitle)}" loading="lazy" width="200" height="140">`
          : `<span class="pg-rel-noph" aria-hidden="true">${esc(String(r.propertyType || 'Property').trim())}<small>Photos on request</small></span>`}
        <span class="pg-rel-t">${esc(rTitle)}</span>
        <span class="pg-rel-l">${esc(r.location || '')}</span>
        <span class="pg-rel-p">${esc(rTxt)}</span>
      </a>`;
    }).join('')}
  </div>` : '';

  // A price cut is a selling point. It used to show only as a card badge for
  // 30 days; on the listing page it now stays for as long as the lower price.
  // Consumer Act Art. 111(a): a former price may be quoted only if it was
  // actually asked for at least four weeks. Victoria Place was cut 8 days in.
  const heldFourWeeks = p.priceUpdatedAt && p.createdAt && (new Date(p.priceUpdatedAt) - new Date(p.createdAt)) >= 28 * 864e5;
  const reducedHtml = (heldFourWeeks && Number(p.previousPrice) > Number(saleP) && Number(saleP) > 0 && lt !== 'FOR LEASE')
    ? `<div class="pg-reduced">Reduced from ₱${Number(p.previousPrice).toLocaleString('en-PH')}${p.priceUpdatedAt ? ' on ' + new Date(p.priceUpdatedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', day: 'numeric', month: 'long', year: 'numeric' }) : ''}</div>`
    : '';

  // "BELLAGIO TOWER 3 | 2BR For Sale in BGC, P24M | GLRA Realty". The old
  // title was the name plus the whole raw address (up to 165 characters) and
  // never said sale or rent, bedrooms, place or price: the words people type.
  const shortPeso = n => n >= 1e6 ? '₱' + (Math.round(n / 1e4) / 100).toString() + 'M' : '₱' + Number(n).toLocaleString('en-PH');
  const dealWord = lt === 'SALE AND LEASE' ? 'For Sale or Rent' : isLease ? 'For Rent' : 'For Sale';
  const where = ownArea ? ownArea[1] : String(loc).split(',')[0].trim();
  const rooms = Number(p.bedrooms) > 0 ? `${p.bedrooms}BR ` : '';
  const pricePart = saleP > 0 && lt !== 'FOR LEASE' ? shortPeso(saleP) : (leaseP || saleP) > 0 ? shortPeso(leaseP || saleP) + '/mo' : '';
  const seoTitle = `${title.replace(/\s+/g, ' ').trim()} | ${rooms}${dealWord}${where ? ' in ' + where : ''}${pricePart ? ', ' + pricePart : ''} | GLRA Realty`;

  const waHref = 'https://wa.me/639171774572?text=' + encodeURIComponent(
    `Hi Catherine, I'm interested in ${title.replace(/\s+/g, ' ').trim()}${priceText && priceText !== 'Price on request' ? ' (' + priceText.replace(/\s+/g, ' ') + ')' : ''}. ${canonical}`);

  const specRows = [['Type', String(p.propertyType || '—').trim()]]
    .concat(p.bedrooms ? [['Bedrooms', p.bedrooms]] : [])
    .concat(p.bathrooms ? [['Bathrooms', p.bathrooms]] : [])
    .concat(p.sqm ? [['Floor area', p.sqm + ' sqm']] : [])
    // A vacant lot, a farm or a house-and-lot: the lot is the material number,
    // and for the lots it is the only one there is.
    // A condominium unit, an apartment, an office or a commercial space inside
    // a building has no lot. Where one of those carries a land area it is the
    // floor area in the wrong box, so it is labelled plainly rather than wrongly.
    .concat(p.landArea ? [[/^(condominium|apartment|office|commercial space|studio)/i.test(String(p.propertyType || '').trim()) ? 'Floor area' : 'Lot area',
                           Number(p.landArea).toLocaleString('en-US') + ' sqm']] : [])
    .concat(p.parking ? [['Parking', p.parking]] : []);
  const specsHtml = `<div class="pg-specs">${specRows.map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join('')}</div>`;

  // ── Price, the way a buyer reads it. A sale-and-lease listing shows both,
  // the sale price first; a lease shows the monthly rent.
  const peso = n => '\u20b1' + Number(n).toLocaleString('en-PH');
  const priceParts = []; // [amount, suffix, label]
  if (lt === 'SALE AND LEASE') {
    if (saleP > 0) priceParts.push([peso(saleP), '', 'For sale']);
    if (leaseP > 0) priceParts.push([peso(leaseP), '/month', 'For rent']);
  } else if (isLease) {
    if ((leaseP || saleP) > 0) priceParts.push([peso(leaseP || saleP), '/month', 'Monthly rent']);
  } else if (saleP > 0) {
    priceParts.push([peso(saleP), '', 'Selling price']);
  }
  const headPriceHtml = priceParts.length
    ? `<div class="pg-price">${esc(priceParts[0][0])}${priceParts[0][1] ? `<small>${esc(priceParts[0][1])}</small>` : ''}</div>` +
      (priceParts[1] ? `<div class="pg-price-alt">or ${esc(priceParts[1][0] + priceParts[1][1])} to rent</div>` : '')
    : '<div class="pg-price">Price on request</div>';

  // ── The facts people decide on, as one line under the title.
  const typeTxt = String(p.propertyType || '').trim();
  const noLot = /^(condominium|apartment|office|commercial space|studio)/i.test(typeTxt);
  const fmtSqm = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const nBed = Number(p.bedrooms) || 0, nBath = Number(p.bathrooms) || 0;
  const nSqm = Number(p.sqm) || 0, nLot = Number(p.landArea) || 0;
  const keyFacts = [];
  if (nBed > 0) keyFacts.push(['fa-bed', nBed + (nBed === 1 ? ' Bedroom' : ' Bedrooms')]);
  else if (/studio/i.test(typeTxt)) keyFacts.push(['fa-bed', 'Studio']);
  if (nBath > 0) keyFacts.push(['fa-bath', nBath + (nBath === 1 ? ' Bath' : ' Baths')]);
  if (nSqm > 0) keyFacts.push(['fa-ruler-combined', fmtSqm(nSqm) + ' sqm' + (nLot > 0 && !noLot ? ' floor' : '')]);
  if (nLot > 0 && !noLot) keyFacts.push(['fa-vector-square', fmtSqm(nLot) + ' sqm lot']);
  else if (nLot > 0 && !(nSqm > 0)) keyFacts.push(['fa-ruler-combined', fmtSqm(nLot) + ' sqm']);
  if (typeTxt) keyFacts.push([/house|town/i.test(typeTxt) ? 'fa-house' : /lot/i.test(typeTxt) ? 'fa-map' : 'fa-building', typeTxt]);
  const factsHtml = keyFacts.length
    ? `<ul class="pg-facts">${keyFacts.map(([ic, t]) => `<li><i class="fas ${ic}" aria-hidden="true"></i>${esc(t)}</li>`).join('')}</ul>`
    : '';

  // ── Photos. The cover first, then the gallery, each once. Clicking any of
  // them opens the full-screen viewer (/js/gallery.js); without JavaScript the
  // links still open the photo itself.
  const photos = [...new Set([p.mainImage, ...gallery].filter(Boolean))];
  const nPhotos = photos.length;
  // Safe inside url('...') in a style attribute whatever the URL holds.
  const cssUrl = u => String(u).replace(/["'()\\\s<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  const heroHtml = nPhotos
    ? `<a class="pg-hero" href="${esc(absUrl(optimizeCloudinary(photos[0])))}" data-pg-photo="0" style="--pg-bg:url('${esc(cssUrl(absUrl(cloudinaryThumb(photos[0], 48, 36))))}')" aria-label="${esc(nPhotos > 1 ? `Open the photo gallery, ${nPhotos} photos` : 'Open the photo full screen')}">
      <img id="pgHero" class="pg-hero-img" src="${esc(heroImg)}"${heroSrcset ? ` srcset="${esc(heroSrcset)}" sizes="${heroSizes}"` : ''} alt="${esc(title)}" fetchpriority="high" style="view-transition-name:glra-hero">
      <span class="pg-hero-count" aria-hidden="true"><i class="far fa-images"></i>${nPhotos > 1 ? `${nPhotos} photos` : 'View photo'}</span>
    </a>`
    : `<div class="pg-hero pg-hero-none">
      <img id="pgHero" class="pg-hero-img" src="${esc(heroImg)}" alt="" style="view-transition-name:glra-hero">
      <span class="pg-hero-count">Photos on request</span>
    </div>`;
  // Small 2x-sharp crops (12 KB, not the full photo each). On a desktop the
  // strip is one row of eight; the eighth says how many more there are.
  const thumbsHtml = nPhotos > 1
    ? `<div class="pg-thumbs">${photos.map((g, i) => `<a class="pg-thumb" href="${esc(absUrl(optimizeCloudinary(g)))}" data-pg-photo="${i}" aria-label="Photo ${i + 1} of ${nPhotos}"${i === 7 && nPhotos > 8 ? ` data-more="+${nPhotos - 7}"` : ''}><img src="${esc(absUrl(cloudinaryThumb(g)))}" alt="" loading="lazy" width="92" height="70"></a>`).join('')}</div>`
    : '';
  const photosJson = JSON.stringify(photos.map(g => absUrl(g))).replace(/</g, '\\u003c');

  // ── What's nearby, from the location worker. Only printed when the listing
  // was placed to at least district level; distances from the middle of a
  // city would be made up.
  const fmtDist = m => m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km';
  const nearItems = geoOk && p.nearby && Array.isArray(p.nearby.items) ? p.nearby.items.filter(x => x && x.name && Number.isFinite(x.dist)) : [];
  // The neighbourhood map (js/glra-maps.js) centres on the same 3-decimal
  // position the public API gives out (about 100 m, approximate on purpose);
  // the places around it are public and keep their own positions.
  const nbLat = geoOk ? Number(p.geo.lat.toFixed(3)) : null;
  const nbLng = geoOk ? Number(p.geo.lng.toFixed(3)) : null;
  const nbPoints = nearItems.filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng))
    .map(x => ({ cat: x.cat, name: x.name, dist: x.dist, lat: x.lat, lng: x.lng }));
  const facing = /^(N|NE|E|SE|S|SW|W|NW)$/.test(String(p.facing || '')) ? p.facing : '';
  const nbMapHtml = geoOk ? `
      <div class="pg-map-tools">
        <button type="button" class="pg-map-btn" id="pgTravelBtn" aria-pressed="false"><i class="fas fa-car" aria-hidden="true"></i> Travel time</button>
        <button type="button" class="pg-map-btn" id="pgRailBtn" aria-pressed="false"><i class="fas fa-train-subway" aria-hidden="true"></i> Trains</button>
        <button type="button" class="pg-map-btn" id="pgSunBtn" aria-pressed="false"><i class="fas fa-sun" aria-hidden="true"></i> Sun path</button>
        <button type="button" class="pg-map-btn" id="pg3dBtn"><i class="fas fa-cube" aria-hidden="true"></i> 3D view</button>
        <button type="button" class="pg-map-btn" id="pgFloodBtn" aria-pressed="false"><i class="fas fa-water" aria-hidden="true"></i> Flood &amp; hazards</button>
        <button type="button" class="pg-map-btn" id="pgFaultBtn" aria-pressed="false"><i class="fas fa-house-crack" aria-hidden="true"></i> Fault lines</button>
        <button type="button" class="pg-map-btn" id="pgQuakeBtn" aria-pressed="false"><i class="fas fa-wave-square" aria-hidden="true"></i> Earthquakes</button>
        <a class="pg-map-btn" href="https://www.google.com/maps/@?api=1&amp;map_action=pano&amp;viewpoint=${nbLat},${nbLng}" target="_blank" rel="noopener"><i class="fas fa-street-view" aria-hidden="true"></i> Street View</a>
      </div>
      <div class="pg-near-map" id="pgNearMap" role="region" aria-label="Map of the neighbourhood" data-lat="${nbLat}" data-lng="${nbLng}" data-facing="${esc(facing)}" data-title="${esc(glraDisplayTitle ? glraDisplayTitle(p.title) : (p.title || ''))}" data-points="${esc(JSON.stringify(nbPoints))}"></div>` : '';
  const nearbyHtml = geoOk ? `
    <section class="pg-near" aria-labelledby="pgNearH">
      <h2 class="pg-section-label" id="pgNearH">${nearItems.length ? "The neighbourhood" : "On the map"}</h2>
      ${nbMapHtml}
      ${nearItems.length ? `<div class="pg-near-grid">${NEARBY_CATS.map(([cat, label, icon]) => {
        const list = nearItems.filter(x => x.cat === cat);
        return list.length ? `
        <div class="pg-near-cat">
          <h3><i class="fas ${icon}" aria-hidden="true"></i>${esc(label)}</h3>
          <ul>${list.map(x => `<li><span>${esc(x.name)}</span><b>${esc(fmtDist(x.dist))}</b></li>`).join('')}</ul>
        </div>` : '';
      }).join('')}
      </div>` : ''}
      <p class="pg-near-note">The pin marks the approximate area, not the exact unit. Distances are straight-line. Data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.</p>
      ${lifeHtml(p.nearby, esc)}
    </section>` : '';
  const cmpHtml = priceStripHtml(comps, esc);
  const hzHtml = geoOk ? hazardHtml(p, nbLat, nbLng, esc) : '';
  const szHtml = sizeHtml(p, esc);

  const mapsQ = String(p.mapLocation || loc || '').replace(/\s+/g, ' ').trim();
  const locHtml = loc
    ? (mapsQ
      ? `<a class="pg-loc" href="https://www.google.com/maps/search/?api=1&amp;query=${esc(encodeURIComponent(mapsQ))}" target="_blank" rel="noopener"><i class="fas fa-map-marker-alt" aria-hidden="true"></i><span>${esc(loc)}</span><span class="pg-loc-map">Map</span></a>`
      : `<div class="pg-loc"><i class="fas fa-map-marker-alt" aria-hidden="true"></i><span>${esc(loc)}</span></div>`)
    : '';

  // ── Desktop: the price and every way to reach Catherine stay beside the
  // photos while the page scrolls. Phones keep the bottom bar instead.
  const sideHtml = `<aside class="pg-side" aria-label="Price and contact">
    <div class="pg-card">
      <span class="pg-card-deal">${esc(lt)}</span>
      ${priceParts.length
        ? priceParts.map(([amt, suf, label]) => `<div class="pg-card-row"><span class="pg-card-lbl">${esc(label)}</span><span class="pg-card-price">${esc(amt)}${suf ? `<small>${esc(suf)}</small>` : ''}</span></div>`).join('')
        : '<div class="pg-card-row"><span class="pg-card-lbl">Price</span><span class="pg-card-price">On request</span></div>'}
      ${reducedHtml}
      ${factsHtml}
      <div class="pg-agent"><img src="/img/catherine-144.jpg" width="48" height="48" alt="" loading="lazy" decoding="async"><div><b>Catherine SB Sampayo</b><span>PRC-licensed broker &middot; Makati</span></div></div>
      <div class="pg-card-actions">
        <a class="pg-btn pg-btn-wa" href="${esc(waHref)}" target="_blank" rel="noopener"><i class="fab fa-whatsapp" aria-hidden="true"></i>WhatsApp Catherine</a>
        <div class="pg-btn-pair">
          <a class="pg-btn" href="tel:+639171774572"><i class="fas fa-phone-alt" aria-hidden="true"></i>Call</a>
          <a class="pg-btn" href="viber://chat?number=%2B639171774572"><i class="fab fa-viber" aria-hidden="true"></i>Viber</a>
        </div>
        <a class="pg-btn pg-btn-ink" href="#inquire" data-pg-book><i class="far fa-calendar-check" aria-hidden="true"></i>Book a viewing</a>
        <button class="pg-btn pg-btn-ghost" type="button" data-pg-share><i class="fas fa-share-nodes" aria-hidden="true"></i><span aria-live="polite">Share this listing</span></button>
        <a class="pg-btn pg-btn-ghost" href="/property/${esc(id)}/brochure"><i class="far fa-file-pdf" aria-hidden="true"></i>Download brochure</a>
      </div>
      <p class="pg-card-note">GLRA Realty &middot; +63 917 177 4572</p>
    </div>
  </aside>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<script>(function(){try{if(localStorage.getItem('darkMode')==='true')document.documentElement.classList.add('dark-mode-pre')}catch(e){}})();</script>
<title>${esc(seoTitle)}</title>
<meta name="description" content="${esc(metaDesc)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(seoTitle)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="${esc(ogImg)}">${ogIsCloudinary ? `
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">` : ''}
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(seoTitle)}">
<meta name="twitter:description" content="${esc(metaDesc)}">
<meta name="twitter:image" content="${esc(ogImg)}">
<link rel="icon" type="image/png" href="/img/favicon-64.png">
<link rel="apple-touch-icon" sizes="180x180" href="/img/icon-180.png">
<link rel="preconnect" href="https://res.cloudinary.com" crossorigin>
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preload" as="image" href="${esc(heroImg)}"${heroSrcset ? ` imagesrcset="${esc(heroSrcset)}" imagesizes="${heroSizes}"` : ''} fetchpriority="high">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"></noscript>
<style>i.fas,i.far,i.fab,i.fa,i.fa-solid,i.fa-regular,i.fa-brands{display:inline-block;min-width:1em}</style>
<script type="application/ld+json">${jsonld}</script>
<style>
:root{--paper:#f1eee9;--paper2:#e8e4dd;--ink:#0a0a0a;--gray:#656565;--line:#0a0a0a;--hot:#ff3d00;--hot-text:#c02e00;--hot-btn:#df3500;--shadow:#0a0a0a;--glra-max:1400px;--glra-gut:40px;--glra-pad:max(var(--glra-gut),calc((100% - var(--glra-max)) / 2));}
@media(max-width:980px){:root{--glra-gut:24px}}@media(max-width:560px){:root{--glra-gut:24px}}
body.dark-mode{--paper:#0e0e0c;--paper2:#1a1a17;--ink:#f1eee9;--gray:#9a9082;--line:#3a3a36;--hot-text:#ff3d00;--hot-btn:#df3500;--shadow:#3a3a36}
/* Opening a listing from the browse page is a cross-document view transition:
   the card photo carries view-transition-name glra-hero and so does the photo
   here. Off for anyone who asks for less motion. */
@view-transition{navigation:auto}
@media(prefers-reduced-motion:reduce){
  @view-transition{navigation:none}
  ::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}
}
@media(prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
html.dark-mode-pre,html.dark-mode-pre body{background:#0e0e0c;color:#f1eee9}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:var(--paper);color:var(--ink)}
body{font-family:'Inter',system-ui,sans-serif;line-height:1.5;font-weight:500}
img{display:block;max-width:100%}
a{color:inherit;text-decoration:none}
.pg-nav{display:flex;align-items:center;justify-content:space-between;padding:16px var(--glra-pad);border-bottom:2px solid var(--line);background:var(--paper)}
.pg-nav img{height:50px;width:auto}
.pg-back{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border:2px solid var(--line);padding:9px 16px}
.pg-back:hover{background:var(--hot);color:#fff;border-color:var(--hot)}
/* Same 1400px column as the rest of the site (brutalist-theme.css, ONE COLUMN). */
.pg-wrap{max-width:calc(var(--glra-max) + 2 * var(--glra-gut));margin:0 auto;padding:26px var(--glra-gut) 60px}
.pg-badge{display:inline-block;background:var(--hot-btn);color:#fff;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:700;padding:6px 12px;margin-bottom:14px}
.pg-head{margin-bottom:20px}
/* Title case now (see glraDisplayTitle), so no forced capitals. */
.pg-title{font-size:clamp(28px,3.6vw,44px);font-weight:900;letter-spacing:-1.2px;line-height:1.06;margin-bottom:10px;overflow-wrap:break-word}
.pg-loc{display:block;width:fit-content;max-width:100%;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:1.2px;line-height:1.7;text-transform:uppercase;color:var(--gray);margin-bottom:14px}
.pg-loc i{color:var(--hot-text);margin-right:7px}
.pg-loc-map{margin-left:10px;white-space:nowrap;font-weight:700;color:var(--ink);border-bottom:2px solid var(--hot)}
a.pg-loc:hover .pg-loc-map{color:var(--hot-text)}
.pg-keyline{display:flex;flex-direction:column;align-items:flex-start;gap:10px}
.pg-price{font-size:34px;font-weight:900;color:var(--hot-text);letter-spacing:-1px;line-height:1.1}
.pg-price small{font-size:.5em;font-weight:800;letter-spacing:0;margin-left:3px;color:var(--gray)}
.pg-price-alt{font-size:15px;font-weight:800;margin-top:-6px}
.pg-reduced{font-size:13px;font-weight:700;letter-spacing:.2px}
.pg-facts{list-style:none;display:flex;flex-wrap:wrap;gap:8px}
.pg-facts li{display:inline-flex;align-items:center;gap:8px;border:2px solid var(--line);background:var(--paper);padding:7px 11px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.8px;text-transform:uppercase;font-weight:700;line-height:1.2}
.pg-facts i{color:var(--hot-text);font-size:12px}
/* Photo frames hold their size before the photo arrives, tinted, so nothing
   below them moves. Portrait flyers sit on a blurred copy of themselves. */
.pg-gal{margin-bottom:26px}
.pg-hero{position:relative;display:block;aspect-ratio:4/3;background:var(--paper2);border:2px solid var(--line);overflow:hidden;isolation:isolate}
.pg-hero::before{content:'';position:absolute;inset:-30px;background:var(--pg-bg,none) center/cover no-repeat;filter:blur(26px) saturate(1.1);opacity:.55;z-index:-1}
.pg-hero-img{position:relative;display:block;width:100%;height:100%;object-fit:contain}
a.pg-hero{cursor:zoom-in}
.pg-hero-count{position:absolute;right:12px;bottom:12px;display:inline-flex;align-items:center;gap:8px;background:#0a0a0a;color:#f1eee9;border:2px solid #f1eee9;padding:8px 12px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;box-shadow:3px 3px 0 #0a0a0a}
a.pg-hero:hover .pg-hero-count,a.pg-hero:focus-visible .pg-hero-count{background:var(--hot-btn);border-color:var(--hot-btn);color:#fff}
.pg-hero-none .pg-hero-img{object-fit:contain;padding:12%}
.pg-thumbs{display:flex;gap:8px;margin-top:10px;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;padding:2px 2px 6px;scrollbar-width:thin}
.pg-thumb{position:relative;display:block;flex:0 0 92px;height:70px;border:2px solid var(--line);background:var(--paper2);scroll-snap-align:start}
.pg-thumb img{width:100%;height:100%;object-fit:cover}
.pg-thumb:hover{border-color:var(--hot)}
.pg-privacy{font-size:12px;line-height:1.5;margin:12px 0 0;opacity:.8}.pg-privacy a{color:inherit}
.pg-bar{display:none}
.pg-grid{display:block}
.pg-side{display:none}
@media(min-width:1024px){
  .pg-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:40px;align-items:start}
  .pg-side{display:block;position:sticky;top:24px}
  /* The card carries the price and facts on a desktop. */
  .pg-head .pg-keyline{display:none}
  .pg-hero{aspect-ratio:3/2}
  .pg-thumbs{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));overflow:visible;padding:0}
  .pg-thumb{flex:none;height:auto;aspect-ratio:4/3}
  .pg-thumb:nth-child(n+9){display:none}
  .pg-thumb[data-more]::after{content:attr(data-more);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,10,10,.62);color:#fff;font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;letter-spacing:1px}
}
.pg-card{border:2px solid var(--line);background:var(--paper2);padding:22px;box-shadow:6px 6px 0 var(--shadow)}
.pg-card-deal{display:inline-block;background:var(--ink);color:var(--paper);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:2px;font-weight:700;padding:5px 10px;margin-bottom:14px}
.pg-card-row{display:flex;flex-direction:column;gap:2px;padding-bottom:12px;margin-bottom:12px;border-bottom:2px solid var(--line)}
.pg-card-lbl{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1.8px;text-transform:uppercase;color:var(--gray);font-weight:700}
.pg-card-price{font-size:28px;font-weight:900;color:var(--hot-text);letter-spacing:-.8px;line-height:1.15;overflow-wrap:anywhere}
.pg-card-price small{font-size:14px;font-weight:800;color:var(--gray);margin-left:3px;letter-spacing:0}
.pg-card .pg-reduced{margin:-2px 0 12px}
.pg-card .pg-facts{margin:4px 0 18px}
.pg-card-actions{display:flex;flex-direction:column;gap:10px}
.pg-btn-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pg-btn{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;min-height:48px;padding:12px 14px;border:2px solid var(--ink);border-radius:0;background:var(--paper);color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:1.3px;text-transform:uppercase;font-weight:700;text-align:center;cursor:pointer;box-shadow:3px 3px 0 var(--shadow);transition:transform .12s ease,box-shadow .12s ease,background-color .12s ease,color .12s ease}
.pg-btn i{font-size:15px}
.pg-btn:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--shadow)}
.pg-btn:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--shadow)}
.pg-btn-wa{background:var(--hot-btn);border-color:var(--hot-btn);color:#fff}
.pg-btn-ink{background:var(--ink);color:var(--paper)}
.pg-btn-ghost{background:transparent;box-shadow:none;border-color:var(--line)}
.pg-btn-ghost:hover,.pg-btn-ghost:active{transform:none;box-shadow:none;border-color:var(--hot);color:var(--hot-text)}
.pg-agent{display:flex;align-items:center;gap:12px;padding:12px 0 14px;margin-bottom:4px;border-top:1px solid var(--line)}
.pg-agent img{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none}
.pg-agent b{display:block;font-size:14px;line-height:1.3}
.pg-agent span{display:block;font-size:12.5px;color:var(--gray);line-height:1.4}
.pg-summary{font-size:17px;line-height:1.7;margin:0 0 20px;max-width:68ch}
.pg-more{margin-bottom:36px}
.pg-more summary{cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:10px 0;color:var(--ink)}
.pg-more .pg-desc{margin:10px 0 0}
.pg-plan{margin-bottom:36px}
.pg-plan img{display:block;width:100%;max-width:760px;height:auto;background:#fff;border:1px solid var(--line)}
.pg-plan p{font-size:13px;color:var(--gray);margin:8px 0 0}
.pg-card-note{margin-top:14px;font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);text-align:center}
#inquire{scroll-margin-top:20px}
.pg-near{margin-bottom:36px}
.pg-near-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.pg-near-cat{border:2px solid var(--line);background:var(--paper);padding:14px 16px;min-width:0}
.pg-near-cat h3{display:flex;align-items:center;gap:9px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;margin-bottom:6px}
.pg-near-cat h3 i{color:var(--hot-text);width:16px;text-align:center;font-size:13px}
.pg-near-cat ul{list-style:none}
.pg-near-cat li{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:8px 0;border-top:1px solid var(--paper2)}
body.dark-mode .pg-near-cat li{border-top-color:var(--line)}
.pg-near-cat li:first-child{border-top:0}
.pg-near-cat li span{font-size:14px;font-weight:600;line-height:1.35;min-width:0;overflow-wrap:anywhere}
.pg-near-cat li b{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;white-space:nowrap}
.pg-near-note{margin-top:10px;font-size:12px;color:var(--gray)}
.pg-map-tools{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.pg-map-btn{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:0 11px;background:var(--paper);color:var(--ink);border:2px solid var(--line);font:700 11px/1 'JetBrains Mono',monospace;letter-spacing:1.2px;text-transform:uppercase;cursor:pointer;text-decoration:none}
.pg-map-btn:hover{background:#ff3d00;border-color:#ff3d00;color:#fff}
.pg-map-btn[aria-pressed="true"]{background:#1f5fbf;border-color:#1f5fbf;color:#fff}
.pg-map-btn:focus-visible{outline:3px solid #ff3d00;outline-offset:2px}
.pg-near-map{height:380px;border:2px solid var(--line);background:var(--paper2);margin-bottom:12px;position:relative;z-index:0}
@media(max-width:600px){.pg-near-map{height:300px}}
.pg-map-btn[hidden]{display:none}
.pg-map-btn[disabled]{opacity:.7;cursor:progress}
.pg-life{border:2px solid var(--line);background:var(--paper);padding:18px 20px;margin-top:16px}
.pg-life-head{display:flex;align-items:center;gap:16px;margin-bottom:6px}
.pg-life-score{display:flex;align-items:baseline;gap:4px;background:#0a0a0a;color:#f1eee9;padding:10px 14px;flex:0 0 auto}
body.dark-mode .pg-life-score{background:#f1eee9;color:#0a0a0a}
.pg-life-score b{font-size:40px;font-weight:900;letter-spacing:-1.5px;line-height:1}
.pg-life-score span{font:700 11px/1 'JetBrains Mono',monospace;opacity:.7}
.pg-life-head h3{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;font-weight:700;margin-bottom:4px}
.pg-life-head p{font-size:17px;font-weight:700;line-height:1.25}
.pg-life-body{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:10px 24px;align-items:center}
@media(max-width:700px){.pg-life-body{grid-template-columns:1fr}.pg-life-radar{max-width:300px;margin:0 auto}}
.pg-life-radar{width:100%;height:auto;display:block;overflow:visible}
.pg-life-radar .pg-life-grid{fill:none;stroke:var(--line);stroke-width:1;opacity:.35}
.pg-life-radar .pg-life-shape{fill:rgba(255,61,0,.22);stroke:#ff3d00;stroke-width:2.5;stroke-linejoin:round}
.pg-life-radar text{font:700 10.5px 'JetBrains Mono',monospace;fill:var(--ink);letter-spacing:.5px;text-transform:uppercase}
.pg-life-list{list-style:none;margin:0}
.pg-life-list li{display:grid;grid-template-columns:18px 1fr auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--paper2)}
body.dark-mode .pg-life-list li{border-top-color:var(--line)}
.pg-life-list li:first-child{border-top:0}
.pg-life-list i{color:var(--hot-text);text-align:center}
.pg-life-list span b{display:block;font-size:14px}
.pg-life-list small{display:block;font-size:12px;color:var(--gray);line-height:1.35;overflow-wrap:anywhere}
.pg-life-list em{display:flex;align-items:center;gap:8px;font:700 13px/1 'JetBrains Mono',monospace;font-style:normal;min-width:92px;justify-content:flex-end}
.pg-life-bar{display:block;width:56px;height:6px;background:var(--paper2)}
body.dark-mode .pg-life-bar{background:var(--line)}
.pg-life-bar span{display:block;height:100%;background:#ff3d00}
.pg-hz{margin-bottom:36px}
.pg-hz-lead{font-size:16px;font-weight:700;line-height:1.4;margin-bottom:10px;max-width:70ch}
.pg-hz-list{list-style:none;margin:0 0 12px;border:2px solid var(--line);background:var(--paper);padding:4px 16px}
.pg-hz-list li{display:grid;grid-template-columns:20px 1fr auto;gap:12px;align-items:center;padding:11px 0;border-top:1px solid var(--paper2)}
body.dark-mode .pg-hz-list li{border-top-color:var(--line)}
.pg-hz-list li:first-child{border-top:0}
.pg-hz-list i{color:var(--hot-text);text-align:center}
.pg-hz-list span b{display:block;font-size:14px}
.pg-hz-list small{display:block;font-size:12.5px;color:var(--gray);line-height:1.4}
.pg-hz-chip{display:inline-block;padding:6px 9px;font:700 10.5px/1.2 'JetBrains Mono',monospace;letter-spacing:.8px;text-transform:uppercase;color:#fff;white-space:nowrap;text-align:center}
.pg-hz-0{background:#0f7a55}.pg-hz-1{background:#8a5a00}.pg-hz-2{background:#b8420b}.pg-hz-3{background:#b0122c}
@media(max-width:560px){.pg-hz-list li{grid-template-columns:18px 1fr}.pg-hz-list .pg-hz-chip{grid-column:2;justify-self:start;white-space:normal}}
.pg-hz-links{display:flex;flex-wrap:wrap;gap:6px}
.pg-sz{margin:4px 0 26px}
.pg-sz-body{display:grid;grid-template-columns:minmax(200px,340px) 1fr;gap:12px 24px;align-items:center;border:2px solid var(--line);background:var(--paper);padding:16px 18px}
@media(max-width:700px){.pg-sz-body{grid-template-columns:1fr}}
.pg-sz-svg{width:100%;height:auto;max-height:220px;display:block}
.pg-sz-unit{fill:rgba(255,61,0,.22);stroke:#ff3d00;stroke-width:2.5}
.pg-sz-ref{fill:rgba(31,95,191,.12);stroke:#1f5fbf;stroke-width:1.5}
.pg-sz-refl{fill:none;stroke:#1f5fbf;stroke-width:1.2}
.pg-sz-txt p{font-size:15px;line-height:1.5}
.pg-sz-txt ul{list-style:none;margin:8px 0 0}
.pg-sz-txt li{display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0}
.pg-sz-key{display:inline-block;width:14px;height:14px;flex:0 0 14px}
.pg-sz-key-u{background:rgba(255,61,0,.22);border:2px solid #ff3d00}
.pg-sz-key-r{background:rgba(31,95,191,.12);border:2px solid #1f5fbf}
.pg-cmp{margin-bottom:36px}
.pg-cmp-lead{font-size:15px;line-height:1.5;margin-bottom:26px;max-width:78ch}
.pg-cmp-strip{position:relative;height:46px;margin:0 6px}
.pg-cmp-axis{position:absolute;left:0;right:0;top:22px;height:2px;background:var(--line)}
.pg-cmp-dot{position:absolute;top:16px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--paper);border:2px solid var(--ink);opacity:.75}
.pg-cmp-dot.is-me{top:12px;width:22px;height:22px;margin-left:-11px;background:#ff3d00;border-color:#0a0a0a;opacity:1;z-index:2}
.pg-cmp-dot em,.pg-cmp-mid em{position:absolute;left:50%;transform:translateX(-50%);white-space:nowrap;font:700 10px/1 'JetBrains Mono',monospace;letter-spacing:1px;text-transform:uppercase;font-style:normal}
.pg-cmp-dot.is-me em{bottom:calc(100% + 6px);color:var(--hot-text)}
.pg-cmp-mid{position:absolute;top:8px;height:30px;width:0;border-left:2px dashed var(--gray)}
.pg-cmp-mid em{top:calc(100% + 6px);color:var(--gray)}
.pg-cmp-scale{display:flex;justify-content:space-between;font:700 10.5px/1 'JetBrains Mono',monospace;color:var(--gray);margin-top:22px;letter-spacing:.5px}
.pg-near-map .leaflet-tile-pane{filter:grayscale(.85) contrast(1.04) brightness(1.03)}
body.dark-mode .pg-near-map .leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) grayscale(.9) brightness(.82) contrast(.92)}
.pg-near-map .leaflet-bar a{border-radius:0}
.pg-near-note a{text-decoration:underline}
h2.pg-section-label{font-weight:700}
@media(prefers-reduced-motion:reduce){.pg-btn{transition:none}.pg-btn:hover,.pg-btn:active{transform:none}}
@media(max-width:1023px){
  .pg-bar{display:grid;grid-template-columns:repeat(4,1fr);position:fixed;left:0;right:0;bottom:0;z-index:1050;
    background:var(--paper);border-top:2px solid var(--ink);padding-bottom:env(safe-area-inset-bottom)}
  .pg-bar a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:58px;
    color:var(--ink);text-decoration:none;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;border-left:1px solid var(--line)}
  .pg-bar a:first-child{border-left:0}
  .pg-bar i{font-size:18px}
  .pg-bar .pg-bar-hot{background:var(--hot-btn);color:#fff}
  body{padding-bottom:calc(64px + env(safe-area-inset-bottom))}
  .floating-buttons{display:none !important}
}
.pg-specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:26px}
.pg-brochure{display:inline-flex;align-items:center;gap:8px;margin:-10px 0 26px;padding:11px 14px;border:2px solid var(--ink,#0a0a0a);color:inherit;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.pg-brochure:hover,.pg-brochure:focus-visible{background:#ff3d00;border-color:#ff3d00;color:#fff}
@media(min-width:1024px){.pg-brochure{display:none}}
.pg-specs div{border:2px solid var(--line);padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);min-width:0}
.pg-specs b{display:block;font-family:'Inter',sans-serif;font-size:18px;font-weight:800;margin-top:6px;letter-spacing:-.3px;color:var(--ink);text-transform:none;overflow-wrap:break-word}
.pg-section-label{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--gray);border-bottom:2px solid var(--line);padding-bottom:8px;margin-bottom:14px}
.pg-desc{font-size:16px;line-height:1.7;white-space:pre-wrap;margin-bottom:36px;max-width:78ch}
.pg-crumbs{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);margin-bottom:16px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pg-crumbs a{border-bottom:1px solid transparent;display:inline-flex;align-items:center;min-height:24px}
.pg-crumbs a:hover{color:var(--hot-text);border-bottom-color:var(--hot)}
.pg-crumbs span[aria-current]{color:var(--ink);font-weight:700;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-related{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;margin-bottom:40px}
.pg-rel{display:block;border:2px solid var(--line);background:var(--paper2);padding:0 0 12px}
.pg-rel:hover{border-color:var(--hot)}
.pg-rel img{width:100%;height:140px;object-fit:cover;border-bottom:2px solid var(--line);margin-bottom:10px;background:var(--paper2)}
.pg-rel-noph{display:flex;flex-direction:column;justify-content:flex-end;gap:3px;height:140px;padding:12px;margin-bottom:10px;border-bottom:2px solid var(--line);background:var(--paper);font-weight:800;font-size:14px;line-height:1.2}
.pg-rel-noph small{font-family:'JetBrains Mono',monospace;font-weight:500;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:var(--gray)}
.pg-rel-t{display:block;padding:0 12px;font-size:14px;font-weight:800;line-height:1.25;letter-spacing:-.2px;margin-bottom:4px}
.pg-rel-l{display:block;padding:0 12px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);margin-bottom:6px}
.pg-rel-p{display:block;padding:0 12px;font-size:15px;font-weight:900;color:var(--hot-text);letter-spacing:-.3px}
.pg-form{border:2px solid var(--line);padding:26px;background:var(--paper2)}
.pg-form h2{font-size:24px;font-weight:900;text-transform:uppercase;letter-spacing:-.5px;margin-bottom:16px}
.pg-form input,.pg-form textarea{width:100%;padding:14px 16px;border:2px solid var(--line);background:var(--paper);color:var(--ink);font-family:'Inter',sans-serif;font-size:14px;margin-bottom:12px}
.pg-form textarea{min-height:110px;resize:vertical}
.pg-consent{display:flex;align-items:flex-start;gap:10px;margin:0 0 14px;font-size:13.5px;line-height:1.45;cursor:pointer}
.pg-form .pg-consent input{width:20px;height:20px;min-height:0;padding:0;margin:0;flex:0 0 20px;accent-color:#ff3d00}
.pg-form button{background:var(--ink);color:var(--paper);border:0;padding:16px 28px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;cursor:pointer}
.pg-form button:hover{background:var(--hot-btn);color:#fff}
/* a11y.js inserts this link on every page; the rule it needs lives in
   styles.css, which this template does not load. Without it the link is just
   visible text at the top of the page. */
.skip-to-content{position:fixed;top:-100px;left:8px;background:#0a0a0a;color:#fff;border:2px solid var(--hot);padding:14px 22px;z-index:2147483647;font-weight:700;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;font-family:'JetBrains Mono',monospace;transition:top .25s cubic-bezier(.2,.7,.2,1)}
.skip-to-content:focus{top:8px;outline:2px solid var(--hot);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.skip-to-content{transition:none}}
/* main.js injects these and only sizes them below 768px; the desktop sizing is
   in styles.css, which this template does not load either. */
.floating-buttons{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:1000}
.floating-buttons > *{width:44px;height:44px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;border:2px solid var(--line);background:var(--ink);color:var(--paper);font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;border-radius:0}
.floating-buttons > *:hover{background:var(--hot-btn);color:#fff;border-color:var(--hot-btn)}
:is(a,button,input,textarea,select,[tabindex]):focus-visible{outline:3px solid var(--hot);outline-offset:2px}
.pg-foot{background:#0a0a0a;color:#f1eee9;text-align:center;padding:28px 20px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;line-height:1.9}
@media(max-width:768px){
  .pg-form input,.pg-form textarea,.pg-form select,.pg-form button{font-size:16px}
  .pg-nav a,.pg-form button{min-height:44px;display:inline-flex;align-items:center;justify-content:center}
}
@supports(padding:max(0px)){
  .pg-nav{padding-left:max(var(--glra-pad),env(safe-area-inset-left));padding-right:max(var(--glra-pad),env(safe-area-inset-right))}
}
.pg-lbl{display:block;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gray);margin:14px 0 6px}
.pg-opt{text-transform:none;letter-spacing:0}
.pg-foot{--hot-text:#ff3d00}
.pg-foot a{color:var(--hot-text)}
@media(max-width:600px){.pg-wrap{padding:18px var(--glra-gut) 46px}.pg-title{font-size:27px;letter-spacing:-.8px}.pg-price{font-size:26px}.pg-crumbs{margin-bottom:12px}}
</style>
</head>
<body>
<nav class="pg-nav">
  <a href="/" aria-label="GLRA Realty home"><img src="/img/logo-384.png" alt="GLRA Realty" width="384" height="384" data-logo-auto></a>
  <a href="/properties.html" class="pg-back">← All listings</a>
</nav>
<main class="pg-wrap" id="main" tabindex="-1">
  ${crumbHtml}
  <header class="pg-head">
    <span class="pg-badge">${esc(lt)}</span>
    <h1 class="pg-title">${esc(title)}</h1>
    ${locHtml}
    <div class="pg-keyline">
      ${headPriceHtml}${reducedHtml}
      ${factsHtml}
    </div>
  </header>
  <div class="pg-grid">
  <div class="pg-main">
  <div class="pg-gal">
    ${heroHtml}
    ${thumbsHtml}
  </div>
  <div class="pg-section-label">Details</div>
  ${specsHtml}
  ${szHtml}
  <a class="pg-brochure" href="/property/${esc(id)}/brochure"><i class="far fa-file-pdf" aria-hidden="true"></i>Download the brochure (PDF)</a>
  ${floorPlanHtml}
  ${webSummary
    ? `<div class="pg-section-label">About this home</div><p class="pg-summary">${esc(webSummary)}</p>${descDisplay ? `<details class="pg-more"><summary>Full details</summary><div class="pg-desc">${esc(descDisplay)}</div></details>` : ''}`
    : (descDisplay ? `<div class="pg-section-label">Description</div><div class="pg-desc">${esc(descDisplay)}</div>` : '')}
  ${cmpHtml}
  ${nearbyHtml}
  ${hzHtml}
  <div class="pg-form" id="inquire">
    <h2>Inquire about this property</h2>
    <form id="pgForm" onsubmit="return pgSubmit(event)">
      <label class="pg-lbl" for="pgName">Full name</label><input type="text" id="pgName" name="name" autocomplete="name" placeholder="Full name" required>
      <label class="pg-lbl" for="pgEmail">Email address</label><input type="email" id="pgEmail" name="email" autocomplete="email" placeholder="Email address" required>
      <label class="pg-lbl" for="pgPhone">Phone number <span class="pg-opt">(optional)</span></label><input type="tel" id="pgPhone" name="phone" autocomplete="tel" placeholder="Phone number">
      <label class="pg-lbl" for="pgMsg">Your message</label><textarea id="pgMsg" name="message" placeholder="Your message">I'm interested in ${esc(title)}${loc ? ' (' + esc(loc) + ')' : ''}. Please send me more details.</textarea>
      <label class="pg-consent" for="pgMkt"><input type="checkbox" id="pgMkt" name="marketing"><span>Also email me similar listings. I can stop them any time.</span></label>
      <button type="submit">Send inquiry →</button>
      <p class="pg-privacy">Catherine will use these details to answer you about this property, and to send similar listings only if you ticked the box. <a href="/privacy.html">How we handle your data</a>.</p>
    </form>
    <div id="pgResult" style="margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:12px"></div>
  </div>
  </div>
  ${sideHtml}
  </div>
  ${relatedHtml}
</main>
<footer class="pg-foot">
  GLRA REALTY &middot; <a href="tel:+639171774572">+63 917 177 4572</a> &middot; <a href="mailto:glrarealty@gmail.com">glrarealty@gmail.com</a> &middot; <a href="https://glrarealty.com">glrarealty.com</a>
</footer>
<!-- On a phone the enquiry form is several screens down and the only other
     way to reach Catherine was one button hiding a menu. This bar stays in
     reach; its WhatsApp message names this listing and links to it. -->
<nav class="pg-bar" aria-label="Contact about this property">
  <a href="tel:+639171774572"><i class="fas fa-phone-alt" aria-hidden="true"></i><span>Call</span></a>
  <a href="${esc(waHref)}" target="_blank" rel="noopener"><i class="fab fa-whatsapp" aria-hidden="true"></i><span>WhatsApp</span></a>
  <a href="viber://chat?number=%2B639171774572"><i class="fab fa-viber" aria-hidden="true"></i><span>Viber</span></a>
  <a href="#inquire" class="pg-bar-hot"><i class="far fa-envelope" aria-hidden="true"></i><span>Inquire</span></a>
</nav>
<div class="floating-buttons">
  <a href="tel:+639171774572" class="floating-btn btn-call" aria-label="Call us"><i class="fas fa-phone-alt"></i></a>
  <a href="https://wa.me/639171774572" class="floating-btn btn-whatsapp" target="_blank" rel="noopener" aria-label="WhatsApp"><i class="fab fa-whatsapp"></i></a>
  <a href="viber://chat?number=%2B639171774572" class="floating-btn btn-viber" aria-label="Viber"><i class="fab fa-viber"></i></a>
  <button class="floating-btn btn-darkmode" id="floatingDarkModeToggle" onclick="toggleDarkMode()" aria-label="Toggle dark mode"><i class="fas fa-moon"></i></button>
</div>
<script type="application/json" id="pgPhotos">${photosJson}</script>
<script>
(function(){
  var photos = [];
  try { photos = JSON.parse(document.getElementById('pgPhotos').textContent) || []; } catch (e) {}
  var title = ${JSON.stringify(title).replace(/</g, '\\u003c')};
  var url = ${JSON.stringify(canonical)};
  function share(btn){
    if (navigator.share) { navigator.share({ title: title, url: url }).catch(function(){}); return; }
    var sp = btn.querySelector('span'), orig = sp ? sp.textContent : '';
    function say(t){ if (!sp) return; sp.textContent = t; setTimeout(function(){ sp.textContent = orig; }, 2400); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function(){ say('Link copied'); }, function(){ say('Copy the address bar link'); });
    } else { say('Copy the address bar link'); }
  }
  document.addEventListener('click', function(e){
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var ph = t.closest('[data-pg-photo]');
    // Ctrl/cmd/shift-click and middle-click still open the photo itself.
    if (ph && photos.length && window.GLRAGallery && !(e.ctrlKey || e.metaKey || e.shiftKey || e.button)) {
      e.preventDefault();
      window.GLRAGallery.open(photos, Number(ph.getAttribute('data-pg-photo')) || 0, { title: title, returnFocus: ph });
      return;
    }
    if (t.closest('[data-pg-book]')) {
      var m = document.getElementById('pgMsg');
      if (m && m.value === m.defaultValue) m.value = 'I would like to book a viewing of ' + title + '. Which days and times are available?';
      setTimeout(function(){ var n = document.getElementById('pgName'); if (n) { try { n.focus({ preventScroll: true }); } catch (_) { n.focus(); } } }, 400);
      return;
    }
    var sh = t.closest('[data-pg-share]');
    if (sh) { e.preventDefault(); share(sh); }
  });
})();
async function pgSubmit(e){
  e.preventDefault();
  var btn = e.target.querySelector('button');
  var result = document.getElementById('pgResult');
  var payload = {
    name: document.getElementById('pgName').value.trim(),
    email: document.getElementById('pgEmail').value.trim(),
    phone: document.getElementById('pgPhone').value.trim(),
    message: document.getElementById('pgMsg').value.trim() || ('Inquiry about ' + ${JSON.stringify(title).replace(/</g, '\\u003c')}),
    propertyId: ${JSON.stringify(id)},
    propertyTitle: ${JSON.stringify(rawTitle).replace(/</g, '\\u003c')},
    marketing: !!(document.getElementById('pgMkt') && document.getElementById('pgMkt').checked)
  };
  if(!payload.name || !payload.email){ result.style.color='#ff3d00'; result.textContent='Please enter your name and email.'; return false; }
  btn.disabled = true; var orig = btn.textContent; btn.textContent = 'Sending...';
  try {
    var r = await fetch('/api/inquiries', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    var d = await r.json().catch(function(){ return {}; });
    if(r.ok && d.success){ result.style.color='#10b981'; result.textContent='Thank you! We received your inquiry and will respond within 24 hours.'; e.target.reset(); }
    else { result.style.color='#ff3d00'; result.textContent=(d.error||'Something went wrong. Please call us instead.'); }
  } catch(_){ result.style.color='#ff3d00'; result.textContent='Network error. Please call or message us.'; }
  finally { btn.disabled=false; btn.textContent=orig; }
  return false;
}
</script>
<script src="/js/main.js?v=120"></script>
<script src="/js/a11y.js?v=116" defer></script>
<script src="/js/gallery.js?v=116" defer></script>
${geoOk ? '<script src="/js/glra-maps.js?v=117" defer></script>' : ''}
</body>
</html>`;
}

// ── Printable brochure: /property/:id/brochure ───────────────────────────
// One A4 page per listing that Catherine can hand out at a viewing or send on
// Viber: photos, price, facts, what's nearby, contact details and a QR code
// back to the listing. It is plain HTML with print styles, so "Save as PDF"
// in any phone or desktop browser produces the PDF; no PDF engine needed.
function buildBrochureHtml(p) {
  externalizeInlineImages(p);
  applyWebsiteCover(p);
  const id = String(p._id);
  const title = glraDisplayTitle(p.title || 'Property') || 'Property';
  const loc = String(p.location || '').trim();
  const lt = String(p.listingType || 'FOR SALE').toUpperCase();
  const isLease = lt === 'FOR LEASE' || lt === 'SALE AND LEASE';
  const saleP = Number(p.price) || 0, leaseP = Number(p.monthlyRental) || 0;
  const pesoTxt = n => '₱' + Number(n).toLocaleString('en-PH');
  const prices = [];
  if (lt === 'SALE AND LEASE') {
    if (saleP > 0) prices.push(['For sale', pesoTxt(saleP), '']);
    if (leaseP > 0) prices.push(['For rent', pesoTxt(leaseP), '/month']);
  } else if (isLease) {
    if ((leaseP || saleP) > 0) prices.push(['Monthly rent', pesoTxt(leaseP || saleP), '/month']);
  } else if (saleP > 0) {
    prices.push(['Selling price', pesoTxt(saleP), '']);
  }
  const typeTxt = String(p.propertyType || '').trim();
  const noLot = /^(condominium|apartment|office|commercial space|studio)/i.test(typeTxt);
  const fmtSqm = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' sqm';
  const facts = [];
  if (typeTxt) facts.push(['Type', typeTxt]);
  if (Number(p.bedrooms) > 0) facts.push(['Bedrooms', String(p.bedrooms)]);
  if (Number(p.bathrooms) > 0) facts.push(['Bathrooms', String(p.bathrooms)]);
  if (Number(p.sqm) > 0) facts.push(['Floor area', fmtSqm(p.sqm)]);
  if (Number(p.landArea) > 0) facts.push([noLot ? 'Floor area' : 'Lot area', fmtSqm(p.landArea)]);
  if (Number(p.parking) > 0) facts.push(['Parking', String(p.parking)]);
  if (Number(saleP) > 0 && lt !== 'FOR LEASE') {
    const basis = noLot ? (Number(p.sqm) || Number(p.landArea) || 0) : (Number(p.landArea) || Number(p.sqm) || 0);
    if (basis > 0) facts.push(['Price per sqm', pesoTxt(Math.round(saleP / basis))]);
  }

  const photos = [...new Set([p.mainImage, ...(p.gallery || [])].filter(Boolean))].filter(u => !isStockPhoto(u));
  const cldSized = (u, t) => {
    if (typeof u !== 'string' || u.indexOf('res.cloudinary.com') === -1) return absUrl(u);
    u = u.replace('/upload/f_auto,q_auto/', '/upload/');
    if (/\/upload\/[a-z]{1,2}_/.test(u)) return u;
    return u.replace('/upload/', `/upload/${t}/`);
  };
  const hero = photos[0] ? cldSized(photos[0], 'f_auto,q_auto,c_limit,w_1400') : '';
  const extra = photos.slice(1, 5).map(u => cldSized(u, 'f_auto,q_auto,c_fill,g_auto,w_480,h_360'));

  // Brochure copy: no emoji or bullet glyphs, no line that just repeats the
  // title, and short enough to keep the page to one sheet of A4.
  const titleHead = String(p.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 20);
  let desc = glraCleanDescription(p.description)
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{2022}\u{25AA}\u{25CF}]/gu, '')
    .split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(l => l && !(titleHead && l.toLowerCase().replace(/[^a-z0-9 ]/g, '').includes(titleHead)))
    // Facebook-style posts put every fact on its own short line; run them
    // together so the text takes a paragraph, not half the page.
    .map(l => l.replace(/[:\s]+$/, '')).join(' · ').replace(/\s+/g, ' ').trim();
  if (desc.length > 520) desc = desc.slice(0, 520).replace(/\s+\S*$/, '').replace(/[\s·,;:]+$/, '') + '...';

  const geoOk = !!(p.geo && p.geo.status === 'ok' && p.geo.rank >= NEARBY_MIN_RANK);
  const near = geoOk && p.nearby && Array.isArray(p.nearby.items) ? p.nearby.items.filter(x => x && x.name && Number.isFinite(x.dist)) : [];
  const fmtDist = m => m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km';
  const nearHtml = near.length ? `<section class="b-near"><h2>What's nearby</h2><div class="b-near-grid">${NEARBY_CATS.map(([cat, label]) => {
    const list = near.filter(x => x.cat === cat).slice(0, 3);
    return list.length ? `<div><h3>${esc(label)}</h3><ul>${list.map(x => `<li><span>${esc(x.name)}</span><b>${esc(fmtDist(x.dist))}</b></li>`).join('')}</ul></div>` : '';
  }).join('')}</div><p class="b-fine">Straight-line distances, approximate. Map data &copy; OpenStreetMap contributors.</p></section>` : '';

  const url = `${SITE_URL}/property/${id}`;
  const printed = new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', day: 'numeric', month: 'long', year: 'numeric' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} - Brochure | GLRA Realty</title>
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/png" href="/img/favicon-64.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#d9d5ce;color:#0a0a0a;font-family:Inter,system-ui,sans-serif;font-size:12px;line-height:1.45}
.b-bar{position:sticky;top:0;z-index:5;display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;padding:12px 16px;background:#0a0a0a;color:#f1eee9;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase}
.b-bar a,.b-bar button{font:inherit;color:#0a0a0a;background:#f1eee9;border:2px solid #f1eee9;padding:10px 16px;cursor:pointer;text-decoration:none;font-weight:700}
.b-bar button{background:#ff3d00;border-color:#ff3d00;color:#fff}
.b-bar a:focus-visible,.b-bar button:focus-visible{outline:3px solid #ff3d00;outline-offset:2px}
.b-page{width:210mm;min-height:297mm;margin:20px auto;background:#fff;padding:12mm 12mm 10mm;box-shadow:6px 6px 0 #0a0a0a;display:flex;flex-direction:column}
.b-head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #0a0a0a;padding-bottom:8px}
.b-head img{height:30px;width:auto}
.b-head span{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#555}
.b-deal{display:inline-block;margin:12px 0 6px;background:#ff3d00;color:#fff;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:4px 8px}
h1{font-size:25px;font-weight:900;letter-spacing:-.6px;line-height:1.1}
.b-loc{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#555;margin-top:5px}
.b-hero{margin-top:10px;height:80mm;background:#e8e4dd;border:2px solid #0a0a0a;overflow:hidden}
.b-hero img{width:100%;height:100%;object-fit:cover;display:block}
.b-thumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px}
.b-thumbs img{width:100%;height:23mm;object-fit:cover;display:block;border:1px solid #0a0a0a;background:#e8e4dd}
.b-mid{display:grid;grid-template-columns:1.05fr 1fr;gap:14px;margin-top:12px}
.b-price{border:2px solid #0a0a0a;padding:10px 12px}
.b-price div+div{margin-top:6px;padding-top:6px;border-top:1px solid #ddd}
.b-price small{display:block;font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:1.5px;text-transform:uppercase;color:#555}
.b-price b{font-size:22px;font-weight:900;letter-spacing:-.5px;color:#c02e00}
.b-price b em{font-style:normal;font-size:12px;color:#555;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:10px}
td{padding:4px 0;border-bottom:1px solid #e5e2dc;font-size:11px}
td:first-child{font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:1px;text-transform:uppercase;color:#555;width:42%}
td:last-child{font-weight:700;text-align:right}
.b-desc h2,.b-near h2{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:5px}
.b-desc p{font-size:10px;line-height:1.45;color:#222}
.b-near{margin-top:12px;border-top:2px solid #0a0a0a;padding-top:8px}
.b-near-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.b-near h3{font-size:10px;font-weight:800;margin-bottom:3px}
.b-near li{list-style:none;display:flex;justify-content:space-between;gap:6px;font-size:9.5px;padding:2px 0;border-bottom:1px dotted #ccc}
.b-near li b{white-space:nowrap}
.b-fine{font-size:8px;color:#777;margin-top:5px}
.b-foot{margin-top:auto;padding-top:10px;border-top:3px solid #0a0a0a;display:flex;justify-content:space-between;align-items:center;gap:14px}
.b-contact b{display:block;font-size:14px;font-weight:900}
.b-contact span{display:block;font-size:10.5px}
.b-contact .b-fine{margin-top:6px}
.b-qr{display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;text-align:right;color:#555}
#bQr{width:26mm;height:26mm;display:flex;align-items:center;justify-content:center}
#bQr img,#bQr canvas{width:26mm!important;height:26mm!important}
@media screen and (max-width:820px){
  body{background:#fff}
  .b-page{width:auto;min-height:0;margin:0;box-shadow:none;padding:16px}
  .b-hero{height:56vw}
  .b-thumbs img{height:18vw}
  .b-mid{grid-template-columns:1fr}
  .b-near-grid{grid-template-columns:1fr 1fr}
  .b-foot{flex-direction:column;align-items:flex-start}
  .b-qr{text-align:left}
}
@page{size:A4;margin:0}
@media print{
  body{background:#fff}
  .b-bar{display:none}
  .b-page{margin:0;box-shadow:none;width:210mm;min-height:297mm}
  .b-near,.b-foot,.b-mid{break-inside:avoid}
}
</style>
</head>
<body>
<div class="b-bar"><a href="/property/${esc(id)}">Back to the listing</a><button type="button" id="bPrint">Save as PDF / Print</button></div>
<main class="b-page">
  <header class="b-head"><img src="/img/logo-384.png" alt="GLRA Realty" width="384" height="384"><span>Licensed Real Estate Broker &middot; Metro Manila &amp; Luzon</span></header>
  <span class="b-deal">${esc(lt === 'SALE AND LEASE' ? 'For sale or lease' : isLease ? 'For lease' : 'For sale')}</span>
  <h1>${esc(title)}</h1>
  ${loc ? `<div class="b-loc">${esc(loc)}</div>` : ''}
  ${hero ? `<div class="b-hero"><img src="${esc(hero)}" alt="${esc(title)}"></div>` : ''}
  ${extra.length ? `<div class="b-thumbs">${extra.map(u => `<img src="${esc(u)}" alt="">`).join('')}</div>` : ''}
  <div class="b-mid">
    <div>
      <div class="b-price">${prices.length ? prices.map(([l, a, s]) => `<div><small>${esc(l)}</small><b>${esc(a)}${s ? `<em>${esc(s)}</em>` : ''}</b></div>`).join('') : '<div><small>Price</small><b>On request</b></div>'}</div>
      ${facts.length ? `<table>${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
    </div>
    ${desc ? `<div class="b-desc"><h2>About this property</h2><p>${esc(desc)}</p></div>` : '<div></div>'}
  </div>
  ${nearHtml}
  <footer class="b-foot">
    <div class="b-contact">
      <b>Catherine SB Sampayo</b>
      <span>GLRA Realty &middot; Licensed Real Estate Broker</span>
      <span>0917 177 4572 &middot; glrarealty@gmail.com</span>
      <span>17F, 252 Sen. Gil J. Puyat Ave., Makati</span>
      <p class="b-fine">Prices, availability and details are subject to change without notice. Printed ${esc(printed)}.</p>
    </div>
    <div class="b-qr"><span>Scan for photos<br>and the latest price</span><div id="bQr" data-url="${esc(url)}"></div></div>
  </footer>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
(function(){
  var box=document.getElementById('bQr');
  try{ new QRCode(box,{text:box.getAttribute('data-url'),width:256,height:256,correctLevel:QRCode.CorrectLevel.M}); }
  catch(e){ box.textContent=box.getAttribute('data-url').replace(/^https?:\\/\\//,''); box.style.fontSize='8px'; }
  document.getElementById('bPrint').addEventListener('click',function(){ window.print(); });
})();
</script>
</body>
</html>`;
}

app.get('/property/:id/brochure', async (req, res) => {
  try {
    const p = /^[a-f0-9]{24}$/i.test(req.params.id)
      ? await Property.findById(req.params.id).select(PUBLIC_PROPERTY_FIELDS + ' nearby hazard').lean()
      : null;
    if (!p || p.status !== 'available') return res.redirect(302, '/property/' + encodeURIComponent(req.params.id));
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.send(buildBrochureHtml(p));
  } catch (err) {
    return res.redirect(302, '/properties.html');
  }
});

app.get('/property/:id', async (req, res) => {
  try {
    // Same whitelist the public API uses: the commission and the owner's
    // contact details in `notes` have no business being loaded into a page
    // renderer, even one that does not print them.
    const p = /^[a-f0-9]{24}$/i.test(req.params.id)
      ? await Property.findById(req.params.id).select(PUBLIC_PROPERTY_FIELDS + ' nearby hazard').lean()
      : null;
    // A 302 to the listings page looked to Google like a disguised "not
    // found" it had to keep re-checking. Gone (410) for a listing that existed
    // and is no longer available, not found (404) for an id that never did,
    // and a page that sends the person on to what IS available.
    if (!p || p.status !== 'available') {
      res.status(p ? 410 : 404).set('Content-Type', 'text/html; charset=utf-8');
      return res.send(listingGoneHtml(p));
    }
    // Neighbours to link to. Preference order: same area, then same kind of
    // property, then simply the newest - so the block is never empty and a
    // crawler always has somewhere to go from here.
    const [related, comps] = await Promise.all([findRelatedListings(p), findPriceComparables(p)]);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPropertyPageHtml(p, related, comps));
  } catch (err) {
    return res.redirect(302, '/properties.html');
  }
});

function listingGoneHtml(p) {
  const area = p ? AREAS.find(a => a[2].test(areaHaystack(p))) : null;
  const t = p ? (p.title || 'This listing') : 'This listing';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>No longer available | GLRA Realty</title><meta name="robots" content="noindex, follow">
<link rel="icon" href="/favicon.ico">
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f1eee9;color:#0a0a0a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
main{max-width:520px}h1{font-size:30px;line-height:1.15;margin:0 0 12px;font-weight:900;letter-spacing:-.5px}p{font-size:16px;line-height:1.6;margin:0 0 22px}
a.b{display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:13px 20px;font-weight:700;margin:0 8px 10px 0}a.o{background:#c02e00}
@media(prefers-color-scheme:dark){body{background:#0e0e0c;color:#f1eee9}a.b{background:#f1eee9;color:#0a0a0a}a.o{background:#df3500;color:#fff}}</style></head>
<body><main><h1>${esc(t)} is no longer on the market.</h1>
<p>It has been sold, leased or taken off the website. Catherine often knows of similar units that are not listed online.</p>
${area ? `<a class="b o" href="/properties/${area[0]}">More in ${esc(area[1])}</a>` : ''}<a class="b" href="/properties.html">See all listings</a><a class="b" href="/#contact">Ask Catherine</a>
</main></body></html>`;
}

// Up to six other available listings worth linking to from a listing page.
// Cheap: one indexed query, a small projection, and the result is only used to
// print six anchors.
const RELATED_FIELDS = '_id title location price monthlyRental listingType mainImage gallery coverImage propertyType';
async function findRelatedListings(p) {
  // Scored, not just "same area first": a P7M condo should suggest other
  // condos in its price range, not a P400M lot that happens to share a city.
  const id = String(p._id);
  const lt = x => String(x.listingType || '').toUpperCase();
  const sells = x => lt(x) === 'FOR SALE' || lt(x) === 'SALE AND LEASE';
  const rents = x => lt(x) === 'FOR LEASE' || lt(x) === 'SALE AND LEASE';
  const base = x => String(x.propertyType || '').trim().split(/\s+-\s+/)[0].trim().toLowerCase();
  const areaOf = x => String(x.location || '').split(/[,\-]/)[0].trim().toLowerCase();
  const priceOf = (x, sale) => sale ? (Number(x.price) || 0) : (Number(x.monthlyRental) || Number(x.price) || 0);
  const mySale = sells(p), myArea = areaOf(p), myType = base(p);
  const myPrice = priceOf(p, mySale), myBeds = Number(p.bedrooms) || 0;
  let out = [];
  try {
    const rows = await Property.find({ status: 'available', _id: { $ne: p._id } })
      .select(RELATED_FIELDS + ' bedrooms createdAt').lean();
    out = rows.map(r => {
      let score = 0;
      if (mySale ? sells(r) : rents(r)) score += 3;
      if (myType && base(r) === myType) score += 3;
      if (myArea.length >= 3 && areaOf(r) === myArea) score += 3;
      const rp = priceOf(r, mySale);
      if (myPrice > 0 && rp > 0) {
        const ratio = rp / myPrice;
        if (ratio >= 0.65 && ratio <= 1.35) score += 2;
        else if (ratio >= 0.4 && ratio <= 1.6) score += 1;
      }
      if (myBeds > 0 && (Number(r.bedrooms) || 0) === myBeds) score += 1;
      return { r, score, t: new Date(r.createdAt || 0).getTime() };
    })
      .filter(x => String(x.r._id) !== id)
      .sort((a, b) => b.score - a.score || b.t - a.t)
      .slice(0, 6)
      .map(x => { delete x.r.bedrooms; delete x.r.createdAt; return x.r; });
  } catch (e) { /* a listing page must render even if this query fails */ }
  out.forEach(optimizePropertyImages);
  return out;
}

// Dynamic sitemap — always fresh. Lists the fixed marketing pages plus a URL
// for every available listing so Google discovers new properties quickly.
// Registered near the top of the file (before express.static) so no leftover
// static sitemap.xml can shadow it.
async function buildSitemap(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Bump when the marketing pages themselves get a real content change.
    // Stamping every page with "today" on every crawl makes Google distrust
    // lastmod entirely, so only genuinely-changing pages get today's date.
    const STATIC_LASTMOD = '2026-07-25';
    const staticPages = [
      ['/', 'daily', '1.0'], ['/properties.html', 'daily', '0.9'],
      ['/list-property.html', 'monthly', '0.8'], ['/about.html', 'monthly', '0.7'],
      ['/tools.html', 'monthly', '0.8'], ['/valuation.html', 'monthly', '0.8'],
      ['/calculator.html', 'monthly', '0.6'], ['/affordability.html', 'monthly', '0.6'],
      ['/amortization.html', 'monthly', '0.6'], ['/rental-yield.html', 'monthly', '0.6'],
      ['/rent-vs-buy.html', 'monthly', '0.6'],
      ['/estate-tax.html', 'monthly', '0.6'], ['/savings-goal.html', 'monthly', '0.6'],
      ['/zonal.html', 'monthly', '0.6'], ['/ercf.html', 'monthly', '0.6'],
      ['/cost-of-ownership.html', 'monthly', '0.6'], ['/guide.html', 'monthly', '0.6'],
      // Added Sept 2026: the three calculators a Philippine broker is asked about
      // that the site could not answer. A notch above the other tools because
      // each targets a high-volume search of its own.
      ['/pre-selling.html', 'monthly', '0.75'], ['/property-tax.html', 'monthly', '0.75'],
      ['/bir-deadlines.html', 'monthly', '0.75'],
      // Added Sept 2026: five more, filling the gaps the plan identified.
      // Each answers a question a broker is asked in person every week and
      // which no Philippine property site answers properly.
      ['/pagibig-loanable.html', 'monthly', '0.75'],
      ['/vat-exemption.html', 'monthly', '0.75'],
      ['/rental-income-tax.html', 'monthly', '0.75'],
      ['/lease-escalation.html', 'monthly', '0.75'],
      ['/principal-residence.html', 'monthly', '0.75'],
      ['/blog.html', 'weekly', '0.6'], ['/testimonials.html', 'monthly', '0.6'],
      ['/neighborhoods.html', 'monthly', '0.6'], ['/living-in-makati.html', 'monthly', '0.5'],
      ['/living-in-bgc.html', 'monthly', '0.5'], ['/living-in-alabang.html', 'monthly', '0.5'],
      ['/privacy.html', 'yearly', '0.3'],
      // Arthaland showcase: the hub plus one page per development. High priority
      // because these are the deepest, most linkable pages on the site and each
      // targets a distinct high-intent search ("Sondris Makati", "Liv Katipunan").
      ['/arthaland.html', 'monthly', '0.9'],
      ['/sondris.html', 'monthly', '0.8'], ['/eluria.html', 'monthly', '0.8'],
      ['/liv.html', 'monthly', '0.8'], ['/una.html', 'monthly', '0.8'],
      ['/lucima.html', 'monthly', '0.8']
    ];
    const props = await Property.find({ status: 'available' },
      { _id: 1, createdAt: 1, priceUpdatedAt: 1, title: 1, mainImage: 1, gallery: 1, coverImage: 1, location: 1 })
      .sort({ createdAt: -1 }).limit(5000).lean();
    // A base64 photo is not a fetchable image URL — without this it would be
    // pasted into <image:loc> and balloon the sitemap to megabytes.
    props.forEach(pr => applyWebsiteCover(externalizeInlineImages(pr)));

    // Area pages, but only the ones that currently clear the minimum. An area
    // that drops to two listings stops being a page and stops being in here,
    // rather than sitting in the sitemap redirecting.
    const counts = await areaCounts();
    AREAS.forEach(a => {
      if ((counts[a[0]] || 0) >= AREA_MIN_LISTINGS) {
        staticPages.push(['/properties/' + a[0], 'daily', '0.85']);
      }
    });

    // The listing index genuinely changes whenever inventory does.
    const feedPages = new Set(['/', '/properties.html']);
    const urls = staticPages.map(([loc, freq, pri]) => {
      const key = loc === '/' ? '/index.html' : loc;
      const imgs = (PAGE_IMAGES[key] || [])
        .map(u => `<image:image><image:loc>${escapeXml(absUrl(u))}</image:loc></image:image>`).join('');
      const fresh = feedPages.has(loc) || loc.startsWith('/properties/');
      return `  <url><loc>${SITE_URL}${loc}</loc><lastmod>${fresh ? today : STATIC_LASTMOD}</lastmod><changefreq>${freq}</changefreq><priority>${pri}</priority>${imgs}</url>`;
    });

    props.forEach(pr => {
      const lm = new Date(pr.priceUpdatedAt || pr.createdAt || Date.now()).toISOString().slice(0, 10);
      // Image entry: gets listing photos indexed in Google Images, which is a
      // real discovery channel for property searches.
      // Every photograph on the listing, not just the cover. A buyer
      // searching Google Images for "2br condo bgc balcony" is looking at
      // photograph six, not photograph one. Capped at six per listing.
      let img = '';
      const shots = [pr.mainImage, ...(pr.gallery || [])].filter(g => g && !isStockPhoto(g)).slice(0, 6);
      const caption = escapeXml([pr.title, pr.location].filter(Boolean).join(' - ') || 'Property');
      img = shots.map(sh =>
        `<image:image><image:loc>${escapeXml(absUrl(optimizeCloudinary(sh)))}</image:loc><image:title>${caption}</image:title></image:image>`
      ).join('');
      urls.push(`  <url><loc>${SITE_URL}/property/${pr._id}</loc><lastmod>${lm}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>${img}</url>`);
    });

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>`);
  } catch (err) {
    console.error('sitemap error:', err);
    res.status(500).send('');
  }
}

// A hero photograph kept in the database as a base64 "data:" string is served
// here as a real image instead of being pasted into the JSON. See
// externalizeHeroImage below for why that matters so much on this particular
// endpoint. Immutable caching is safe: the id changes when the picture does.
app.get('/api/hero-image/:id', async (req, res) => {
  try {
    const h = await HeroImage.findById(req.params.id, { url: 1 }).lean();
    const m = h && isDataUri(h.url) && h.url.match(/^data:([\w.+/-]+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    // Served as an image or not at all. The type used to be whatever the
    // stored data: string claimed, so a "photo" saved as text/html became a
    // page running on glrarealty.com.
    if (!SAFE_IMAGE_TYPES.has(m[1].toLowerCase())) return res.status(404).end();
    const buf = Buffer.from(m[2], 'base64');
    res.set('Content-Type', m[1].toLowerCase());
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Length', String(buf.length));
    return res.end(buf);
  } catch (err) {
    return res.status(404).end();
  }
});

// The home page asks for this before it can draw anything above the fold, so
// it is the most performance-sensitive request on the whole site. With the
// photographs inline it answered 2.5 MB and took three and a half seconds.
// Handing back a short URL makes the JSON a few hundred bytes, lets the
// browser fetch the four pictures in parallel, and - the part that compounds -
// lets it cache them, so a returning visitor downloads none of it again.
function externalizeHeroImage(h) {
  if (h && h._id && isDataUri(h.url)) h.url = `/api/hero-image/${String(h._id)}`;
  return h;
}

app.get('/api/hero-images', async (req, res) => {
  try {
    const images = await HeroImage.find().sort({ order: 1 }).lean();
    images.forEach(i => {
      externalizeHeroImage(i);
      if (i.url) i.url = optimizeCloudinary(i.url);
    });
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/inquiries',
  publicWriteLimiter,
  body('name').isString().trim().isLength({ min: 1, max: 200 }),
  body('email').isEmail().normalizeEmail(),
  body('message').isString().trim().isLength({ min: 1, max: 5000 }),
  body('phone').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 50 }),
  body('propertyId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 100 }),
  body('propertyTitle').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 300 }),
  body('vid').optional().isString().trim().isLength({ max: 64 }),
  body('marketing').optional().isBoolean(),
  body('src').optional().isObject(),
  handleValidation,
  async (req, res) => {
    try {
      const { name, email, phone = '', message, propertyId = null, vid } = req.body;
      // The title is looked up, not taken from the form: it goes into emails,
      // and a typed-in "title" was a way to put any text in front of anyone.
      let listing = null;
      if (propertyId && /^[a-f0-9]{24}$/i.test(String(propertyId))) {
        listing = await Property.findById(propertyId).select('title location price monthlyRental listingType').lean().catch(() => null);
      }
      const propertyTitle = listing ? listing.title : (req.body.propertyTitle ? String(req.body.propertyTitle).slice(0, 120) : null);
      const inquiry = new Inquiry({ name, email, phone, message, propertyId, propertyTitle });
      await inquiry.save();
      console.log('📧 New inquiry from:', name);
      const inqKind = classifyInquiry(message, propertyTitle);
      await ingestLead({
        kind: inqKind, refId: inquiry._id, name, email, phone, message, propertyId, propertyTitle, vid,
        type: inqKind === 'valuation' ? 'seller' : (listing && String(listing.listingType || '').toUpperCase() === 'FOR LEASE' ? 'renter' : undefined),
        hints: inqKind === 'valuation' ? { deal: 'sell' } : hintsFromListing(listing),
        attrib: req.body.src,
        consent: req.body.marketing === true ? 'Ticked "send me similar listings" on the enquiry form' : ''
      });

      // The valuation tool posts here, so this is a real identity signal.
      await stitchCalcIdentity(vid, email);

      // Confirmation email to user
      const userEmailHtml = getEmailHeader() + `
        <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">Dear ${esc(name)},</h2>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Thank you for reaching out to GLRA Realty. We have received your inquiry and our team will respond within 24 hours.</p>

        ${listing ? `<div style="background-color: #e8e4dd; border-left: 3px solid #ff3d00; padding: 18px 20px; margin: 25px 0; border-radius:0;">
          <p style="margin: 0; color: #0a0a0a; font-size: 14px;"><strong>Property:</strong> <a href="${SITE_URL}/property/${String(listing._id)}" style="color: #0a0a0a;">${esc(listing.title)}</a></p>
        </div>` : ''}

        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">We look forward to assisting you with your real estate needs.</p>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      // The visitor's own message is no longer repeated back: this goes to
      // whatever address was typed in, so echoing the text let anyone use
      // GLRA's mail account to deliver their words to a stranger.
      await sendEmail(email, 'Thank you for contacting GLRA Realty', userEmailHtml);

      // Admin notification
      // A Philippine mobile in any common form -> a wa.me link Catherine can tap.
      const digits = String(phone || '').replace(/[^\d]/g, '');
      const intl = /^09\d{9}$/.test(digits) ? '63' + digits.slice(1) : /^639\d{9}$/.test(digits) ? digits : /^9\d{9}$/.test(digits) ? '63' + digits : '';
      const waLink = intl ? `https://wa.me/${intl}` : '';
      const adminEmailHtml = getEmailHeader() + `
        <h2 style="color: #ff3d00; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 20px; margin: 0 0 15px 0;">New Inquiry Received</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Name</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(name)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Email</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(email)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Phone</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(phone) || 'Not provided'}</td></tr>
          ${listing ? `<tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;"><a href="${SITE_URL}/property/${String(listing._id)}" style="color: #0a0a0a;">${esc(listing.title)}</a></td></tr>` : (propertyTitle ? `<tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(propertyTitle)} (as typed)</td></tr>` : '')}
          ${waLink ? `<tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">WhatsApp</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;"><a href="${waLink}" style="color: #0a0a0a;">Message ${esc(name)} on WhatsApp</a></td></tr>` : ''}
          <tr><td style="padding: 8px 0; font-weight: 600; vertical-align: top;">Message</td><td style="padding: 8px 0;">${esc(message)}</td></tr>
        </table>
        <p><a href="https://glrarealty.com/admin.html" style="background-color: #ff3d00; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius:0; display: inline-block;">View in Admin Dashboard</a></p>
      ` + getEmailFooter();
      // Reply goes straight to the buyer, not back to this inbox, and the
      // subject says who and what so the inbox list alone is enough to triage.
      const isViewing = /^\s*\[?\s*(viewing request|schedule a viewing)/i.test(message) || /preferred (date|time)/i.test(message);
      const subj = `${isViewing ? 'Viewing request' : 'New inquiry'}: ${listing ? listing.title : 'General'} - ${name}`.replace(/\s+/g, ' ').slice(0, 140);
      await sendEmail('glrarealty@gmail.com', subj, adminEmailHtml, 'GLRA Realty', { email, name });

      res.json({ success: true });
    } catch (err) {
      console.error('Inquiry error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

app.get('/api/health', async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'ok',
    mongodb: states[dbState] || 'unknown',
    timestamp: new Date().toISOString()
  });
});
// ============ CHATBOT ============
// All chatbot logic (Gemini + Groq, scoring, action builders, /api/chat
// route) lives in ./server/chatbot.js. server.js just registers the route
// and re-exports invalidateChatListingsCache so other handlers can call it
// after property writes.
const { registerChatbot, invalidateChatListingsCache } = require('./server/chatbot');
const { hazardAt, HAZARD_VERSION } = require('./server/hazard');
registerChatbot(app, { handleValidation });

// ============ AGENT WORKSPACE ============
// The whole agent system (GPS, actions, lead journal, pipeline, calendar,
// notifications, morning-agenda emails) lives in ./server/agents.js — routes
// under /api/agent/* (agents only) and /api/admin/agents* (broker view).
const { registerAgentRoutes, startAgentTick } = require('./server/agents');
registerAgentRoutes(app, { sendEmail, esc, handleValidation });
startAgentTick({ sendEmail, esc });

// ============ LEASING ============
// Rent roll, tenant ledgers, statements/receipts as PDF, reminder emails and
// the broker's calendar feed all live in ./server/leasing.js — routes under
// /api/admin/leases* (leasing_view / leasing_manage) plus the public ICS feed.
// ============ LEADS ============
// One record per person across every form on the site, scored and worked in
// the admin "Leads" tab. ingestLead() is called by each form handler below.
const { registerLeadRoutes, startLeadsTick, ingestLead, stitchLeadVid, classifyInquiry, hintsFromListing, hintsFromCriteria } = require('./server/leads');
registerLeadRoutes(app, { sendEmail, esc, handleValidation });
startLeadsTick({ sendEmail, esc });

const { registerLeasingRoutes, startLeasingTick } = require('./server/leasing');
registerLeasingRoutes(app, { sendEmail, esc, uploadAttachment, cloudinary });
startLeasingTick({ sendEmail, esc });

// The law firm's matters — routes under /api/admin/cases* (cases_view /
// cases_manage) plus the token-only court-diary ICS feed. This replaced the
// Notarial tab in September 2026; the notarial records themselves are still in
// the database and still served by the /api/admin/notarial* routes below.
const { registerCaseRoutes, startCasesTick } = require('./server/cases');
registerCaseRoutes(app, { sendEmail, esc, uploadAttachment, cloudinary });
startCasesTick({ sendEmail, esc });



// ============ SUBSCRIPTION ROUTES ============

app.post('/api/subscribe',
  publicWriteLimiter,
  body('email').isEmail().normalizeEmail(),
  body('name').optional().isString().trim().isLength({ max: 200 }),
  body('source').optional().isString().trim().isLength({ max: 100 }),
  body('vid').optional().isString().trim().isLength({ max: 64 }),
  handleValidation,
  async (req, res) => {
    try {
      const { email, name, source, vid } = req.body;
      {
        const quietSrc = ['calculator_pdf', 'calculator_print', 'guide_print'].includes(source);
        ingestLead({ kind: 'newsletter', email, name, vid, label: quietSrc ? 'Downloaded a calculator report' : 'Newsletter sign-up',
          consent: quietSrc ? '' : 'Signed up for the newsletter' }).catch(() => {});
      }

      let existing = await Subscriber.findOne({ email });
      let isNew = false;

      if (existing) {
        if (name) existing.name = name;
        if (source) existing.source = source;
        existing.isActive = true;
        await existing.save();
      } else {
        await Subscriber.create({
          email,
          name: name || '',
          source: source || 'footer',
          preferences: { priceDrops: true }
        });
        isNew = true;

        // Skip the "Welcome" newsletter email for people who only asked for a
        // PDF/printout from a calculator or the guide — they get their document,
        // not a welcome message. ('calculator_pdf' is what the live PDF gate in
        // js/main.js sends; the other two are legacy print sources.)
        const quietSources = ['calculator_pdf', 'calculator_print', 'guide_print'];
        if (!quietSources.includes(source)) {
          const welcomeHtml = getEmailHeader() + `
            <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">Welcome to GLRA Realty</h2>
            <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Dear ${esc(name) || 'Valued Subscriber'},</p>
            <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Thank you for subscribing to our newsletter. You will now receive updates on new property listings, price drops, and real estate market insights.</p>
            <div style="background-color: #e8e4dd; padding: 15px 20px; margin: 25px 0; border-radius:0;">
              <p style="margin: 0 0 5px 0; font-weight: 600; color: #0a0a0a;">What to expect:</p>
              <p style="margin: 0; color: #0a0a0a; font-size: 13px;">New property listings • Price drop alerts • Real estate guides • Market updates</p>
            </div>
            <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">We're honored to be part of your real estate journey.</p>
            <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
          ` + getEmailFooter();
          await sendEmail(email, 'Welcome to GLRA Realty', welcomeHtml);
        }
      }

      if (isNew) {
        const adminSubHtml = getEmailHeader() + `
          <h2 style="color: #ff3d00; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 20px; margin: 0 0 15px 0;">New Subscriber</h2>
          <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Email</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(email)}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Name</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(name) || 'Not provided'}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: 600;">Source</td><td style="padding: 8px 0;">${esc(source) || 'footer'}</td></tr>
          </table>
        ` + getEmailFooter();
        await sendEmail('glrarealty@gmail.com', 'New Subscriber - GLRA Realty', adminSubHtml);
      }

      // Tie this browser's calculator history to the email they just gave us.
      await stitchCalcIdentity(vid, email);

      // Generic response — does NOT reveal whether the email already existed (prevents enumeration)
      res.json({ success: true, message: 'Subscription confirmed.' });
    } catch (err) {
      console.error('Subscribe error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

app.post('/api/unsubscribe',
  publicWriteLimiter,
  body('email').isEmail().normalizeEmail(),
  handleValidation,
  async (req, res) => {
    try {
      await Subscriber.findOneAndUpdate({ email: req.body.email }, { isActive: false });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ============ CALCULATOR / TOOL USAGE TRACKING ============

// Turn an anonymous browser id into a named person.
//
// Called whenever a visitor hands over an email ANYWHERE (PDF gate, newsletter,
// wishlist, price alert, valuation enquiry). Two things happen:
//   1. every calculator row this browser logged while still anonymous is
//      back-filled with the email — so you see what they did BEFORE signing up;
//   2. the browser id is remembered on the Subscriber, so future pings from the
//      same browser are attributed instantly without another back-fill.
//
// Deliberately swallows its own errors: attribution is a nice-to-have and must
// never turn a successful signup into a 500 for the visitor.
async function stitchCalcIdentity(vid, email) {
  if (!vid || !email || typeof vid !== 'string') return;
  try {
    await CalcUsage.updateMany({ vid, email: null }, { $set: { email } });
    await Subscriber.updateOne({ email }, { $addToSet: { vids: vid } });
    await stitchLeadVid(vid, email);
  } catch (err) {
    console.error('Calc identity stitch failed:', err.message);
  }
}

// Records one genuine calculator engagement. The browser only sends this after
// the visitor actually changed an input, so it counts real use rather than
// drive-by page views.
app.post('/api/track/calculator',
  trackLimiter,
  body('vid').isString().trim().isLength({ min: 8, max: 64 }),
  body('calc').isString().trim().isLength({ min: 1, max: 60 }),
  body('label').optional().isString().trim().isLength({ max: 120 }),
  handleValidation,
  async (req, res) => {
    try {
      const { vid, calc, label = '' } = req.body;

      // Already a known browser? Attribute on the spot.
      const known = await Subscriber.findOne({ vids: vid }).select('email').lean();

      const now = new Date();
      const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

      await CalcUsage.create({
        vid,
        email: known ? known.email : null,
        calc,
        label,
        day
      });

      res.json({ success: true });
    } catch (err) {
      console.error('Calc track error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// One listing page opened by one browser. Sent by js/main.js only when the
// visitor has not switched tracking off on the privacy page. Anonymous: it
// names a random browser id, and only counts towards a lead once that same
// browser gives an email in a form.
app.post('/api/track/view',
  trackLimiter,
  body('vid').isString().trim().matches(/^[a-z0-9]{8,64}$/i),
  body('pid').isString().trim().matches(/^[a-f0-9]{24}$/i),
  handleValidation,
  async (req, res) => {
    try {
      const { vid, pid } = req.body;
      // One row per browser per listing per hour is plenty.
      const recent = await ListingView.exists({ vid, propertyId: pid, at: { $gt: new Date(Date.now() - 3600e3) } });
      if (!recent) await ListingView.create({ vid, propertyId: pid });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ============ WISHLIST ROUTES ============

app.post('/api/wishlist',
  publicWriteLimiter,
  body('email').isEmail().normalizeEmail(),
  body('propertyId').isString().trim().isLength({ min: 1, max: 100 }),
  body('propertyTitle').optional().isString().trim().isLength({ max: 300 }),
  body('propertyPrice').optional().isNumeric(),
  body('propertyLocation').optional().isString().trim().isLength({ max: 300 }),
  body('propertyImage').optional().isString().trim().isLength({ max: 1000 }),
  body('vid').optional().isString().trim().isLength({ max: 64 }),
  handleValidation,
  async (req, res) => {
    try {
      const { email, propertyId, propertyTitle = '', propertyPrice = 0, propertyLocation = '', propertyImage = '', vid } = req.body;

      const existing = await Wishlist.findOne({ email, propertyId });
      if (existing) {
        await stitchCalcIdentity(vid, email);
        return res.json({ success: true, message: 'Already saved to wishlist' });
      }

      const wishlistItem = new Wishlist({ email, propertyId, propertyTitle, propertyPrice, propertyLocation, propertyImage });
      await wishlistItem.save();
      ingestLead({ kind: 'wishlist', refId: wishlistItem._id, email, propertyId, propertyTitle, vid,
        hints: /^[a-f0-9]{24}$/i.test(String(propertyId)) ? hintsFromListing(await Property.findById(propertyId).lean().catch(() => null)) : null }).catch(() => {});

      const existingSubscriber = await Subscriber.findOne({ email });
      if (!existingSubscriber) {
        await Subscriber.create({ email, source: 'wishlist', preferences: { priceDrops: true } });
      }
      // Must run AFTER the Subscriber exists, otherwise the browser id has no
      // row to attach to and future pings from this browser stay anonymous.
      await stitchCalcIdentity(vid, email);

      const userWishlistHtml = getEmailHeader() + `
        <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">Property Saved to Wishlist</h2>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">You have successfully saved the following property to your wishlist:</p>
        <div style="background-color: #e8e4dd; border-left: 3px solid #ff3d00; padding: 18px 20px; margin: 25px 0; border-radius:0;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #0a0a0a;">${esc(propertyTitle)}</p>
          <p style="margin: 0 0 5px 0; color: #0a0a0a; font-size: 13px;">📍 ${esc(propertyLocation)}</p>
          <p style="margin: 0; color: #ff3d00; font-weight: 600; font-size: 16px;">₱${Number(propertyPrice).toLocaleString()}</p>
        </div>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">You can view all your saved properties in the <a href="https://glrarealty.com/properties.html" style="color: #ff3d00;">properties page</a>.</p>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      await sendEmail(email, `Saved to Wishlist: ${propertyTitle}`, userWishlistHtml);

      const adminWishlistHtml = getEmailHeader() + `
        <h2 style="color: #ff3d00; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 20px; margin: 0 0 15px 0;">New Wishlist Item</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Customer</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(email)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(propertyTitle)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Location</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(propertyLocation)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 600;">Price</td><td style="padding: 8px 0;">₱${Number(propertyPrice).toLocaleString()}</td></tr>
        </table>
      ` + getEmailFooter();
      await sendEmail('glrarealty@gmail.com', `Wishlist Alert: ${propertyTitle}`, adminWishlistHtml);

      res.json({ success: true, message: 'Property saved to wishlist!' });
    } catch (err) {
      console.error('Wishlist error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Reading a wishlist back, and deleting from it, USED TO BE public routes
// keyed on the email address alone. There is no login on the public site, so
// anyone who knew (or guessed) a customer's address could read the complete
// list of properties that person had saved, or quietly delete it. A wishlist
// is a behavioural profile of a named individual - personal information under
// the Data Privacy Act, and exactly what a rival brokerage would like to have.
//
// Nothing has ever called them: the public pages only POST to /api/wishlist,
// and the dashboard reads the whole table through the authenticated
// /api/admin/wishlist. Admin-only: field agents sign in with a staff token, and
// verifyToken alone let them read or empty any customer's list. If a "my saved properties"
// page is ever built for visitors it needs a one-time emailed link, not a
// bare address in the URL.
app.get('/api/wishlist/:email', verifyToken, requireAdmin, async (req, res) => {
  try {
    const email = String(req.params.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    const wishlist = await Wishlist.find({ email }).sort({ addedAt: -1 });
    res.json(wishlist);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/wishlist/:email/:propertyId', verifyToken, requireAdmin, async (req, res) => {
  try {
    const email = String(req.params.email).toLowerCase();
    const propertyId = String(req.params.propertyId);
    await Wishlist.findOneAndDelete({ email, propertyId });
    await logAudit(req, 'DELETE', 'Wishlist', propertyId, email, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PRICE ALERT ROUTES ============

app.post('/api/price-alert',
  publicWriteLimiter,
  body('email').isEmail().normalizeEmail(),
  body('propertyId').isString().trim().isLength({ min: 1, max: 100 }),
  body('propertyTitle').optional().isString().trim().isLength({ max: 300 }),
  body('propertyPrice').optional().isNumeric(),
  body('vid').optional().isString().trim().isLength({ max: 64 }),
  handleValidation,
  async (req, res) => {
    try {
      const { email, propertyId, propertyTitle = '', propertyPrice = 0, vid } = req.body;

      const existing = await PriceAlert.findOne({ email, propertyId });
      if (existing) {
        await stitchCalcIdentity(vid, email);
        return res.json({ success: true, message: 'Already subscribed to price alerts for this property' });
      }

      const alert = new PriceAlert({ email, propertyId, propertyTitle, propertyPrice });
      await alert.save();
      ingestLead({ kind: 'price_alert', refId: alert._id, email, propertyId, propertyTitle, vid,
        hints: /^[a-f0-9]{24}$/i.test(String(propertyId)) ? hintsFromListing(await Property.findById(propertyId).lean().catch(() => null)) : null }).catch(() => {});

      const existingSubscriber = await Subscriber.findOne({ email });
      if (!existingSubscriber) {
        await Subscriber.create({ email, source: 'price_alert', preferences: { priceDrops: true } });
      }
      await stitchCalcIdentity(vid, email);

      const userAlertHtml = getEmailHeader() + `
        <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">Price Alert Confirmation</h2>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">You have successfully set a price alert for the following property:</p>
        <div style="background-color: #e8e4dd; border-left: 3px solid #ff3d00; padding: 18px 20px; margin: 25px 0; border-radius:0;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #0a0a0a;">${esc(propertyTitle)}</p>
          <p style="margin: 0; color: #ff3d00; font-weight: 600; font-size: 16px;">Current Price: ₱${Number(propertyPrice).toLocaleString()}</p>
        </div>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">You will receive an email notification immediately if the price drops.</p>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      await sendEmail(email, `Price Alert Set: ${propertyTitle}`, userAlertHtml);

      const adminAlertHtml = getEmailHeader() + `
        <h2 style="color: #ff3d00; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 20px; margin: 0 0 15px 0;">New Price Alert Request</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Customer</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(email)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(propertyTitle)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 600;">Current Price</td><td style="padding: 8px 0;">₱${Number(propertyPrice).toLocaleString()}</td></tr>
        </table>
      ` + getEmailFooter();
      await sendEmail('glrarealty@gmail.com', `Price Alert Request: ${propertyTitle}`, adminAlertHtml);

      res.json({ success: true, message: 'You will be notified when price drops!' });
    } catch (err) {
      console.error('Price alert error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// "How many people are waiting for this listing to drop?" is a question only
// a rival brokerage asks, and this answered it for any listing, to anyone, by
// id. No page on the site calls it; the dashboard has its own
// /api/admin/price-alerts. Admin-only (agents hold staff tokens too), and countDocuments instead of
// pulling every matching row back just to measure the array.
app.get('/api/price-alert/check/:propertyId', verifyToken, requireAdmin, async (req, res) => {
  try {
    const propertyId = String(req.params.propertyId);
    const count = await PriceAlert.countDocuments({ propertyId, isNotified: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PROPERTY FINDER (saved-search email alerts) ============
// A visitor on /properties.html saves the filters they are using and is
// emailed once whenever NEW listings matching them go live.
//
// Double opt-in on purpose: the sign-up form only creates an unconfirmed
// search and sends a confirmation link. Without that step anyone could type a
// stranger's address and have us email them. Nothing else is sent, and the
// address is not added to Subscriber, until the link is clicked.
//
// The confirmation link opens /alerts.html, which confirms with a POST. It is
// never a bare GET, because corporate mail scanners fetch every GET link in an
// email and would "confirm" on the person's behalf.
//
// savedSearchMatches() MUST stay in step with applyFilters() in
// public/properties.html. If the page's filter changes, change this too, or
// people will be emailed listings the page would not have shown them (or
// never be emailed ones it would).

const SAVED_SEARCH_TOKEN_RE = /^[a-f0-9]{64}$/;
const SAVED_SEARCH_MAX_PER_EMAIL = 10;
const SAVED_SEARCH_EMAIL_CARDS = 6;
// Wait this long after the last listing edit before sweeping, so one staff
// editing session (and a fixed typo or a swapped photo) becomes ONE email.
// Overridable only so the test harness does not have to wait ten minutes.
const SAVED_SEARCH_DEBOUNCE_MS = Number(process.env.SAVED_SEARCH_DEBOUNCE_MS) || 10 * 60 * 1000;
const SAVED_SEARCH_SAFETY_MS = 60 * 60 * 1000;

function ssIsForLease(p) {
  const t = String((p && p.listingType) || '').toUpperCase();
  return t === 'FOR LEASE' || t === 'SALE AND LEASE';
}
function ssIsForSale(p) {
  const t = String((p && p.listingType) || '').toUpperCase();
  return t === 'FOR SALE' || t === 'SALE AND LEASE';
}
// Property types are typed by hand: "Condominium", "Condominium " and
// "Condominium - Studio" all mean a condo. Identical to glraBaseType() in
// public/properties.html; keep the two in step.
function glraBaseType(t) {
  return String(t || '').trim().split(/\s+-\s+/)[0].trim().toLowerCase();
}
// Which price a range is tested against. A SALE AND LEASE listing has two, and
// used to be tested on its rent alone, so a buyer's P10M-P30M range never found
// a P28M condo that was also offered for rent. Now: the sale price on a sale
// search, the rent on a lease search, and either one when no side is chosen.
// Identical to glraPriceFits() in public/properties.html and index.html.
function glraPriceFits(p, cat, mn, mx) {
  const t = String((p && p.listingType) || '').toUpperCase();
  const sale = Number(p.price) || 0, rent = Number(p.monthlyRental) || Number(p.price) || 0;
  let c;
  if (cat === 'FOR SALE') c = [sale];
  else if (cat === 'FOR LEASE') c = [rent];
  else c = t === 'SALE AND LEASE' ? [sale, rent] : [ssIsForLease(p) ? rent : sale];
  return c.some(v => !(mn > 0 && v < mn) && !(mx > 0 && v > mx));
}

// Cleans whatever the browser sent into the stored shape. The route validates
// first; this is the second line of defence and the single place defaults live.
function normalizeSavedSearchCriteria(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const num = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
  };
  const cat = String(r.category || '').toUpperCase().trim();
  return {
    category: (cat === 'FOR SALE' || cat === 'FOR LEASE') ? cat : '',
    // Lower-cased and trimmed exactly as the page does before comparing.
    q: String(r.q || '').toLowerCase().trim().slice(0, 80),
    propertyType: String(r.propertyType || '').trim().slice(0, 60),
    minBeds: Math.floor(num(r.minBeds, 20)),
    minBaths: Math.floor(num(r.minBaths, 20)),
    minPrice: num(r.minPrice, 1e12),
    maxPrice: num(r.maxPrice, 1e12),
    area: normalizeSavedSearchArea(r.area)
  };
}

// A circle drawn on the properties page map. Same limits the page applies:
// the Philippines, 100 m to 60 km. Rounded like the page's own URL (4 dp).
function normalizeSavedSearchArea(a) {
  if (!a || typeof a !== 'object') return null;
  const lat = Number(a.lat), lng = Number(a.lng), r = Number(a.r);
  if (!(lat >= 4 && lat <= 22 && lng >= 116 && lng <= 127.5 && r >= 100)) return null;
  return { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)), r: Math.round(Math.min(r, 60000)) };
}

function savedSearchHasCriteria(c) {
  return !!(c && (c.category || c.q || c.propertyType || c.minBeds > 0 ||
    c.minBaths > 0 || c.minPrice > 0 || c.maxPrice > 0 || c.area));
}

// One listing against one saved search. Pure: no DB, no dates, no side effects.
// Mirrors applyFilters() in properties.html rule for rule, including its quirk
// that a listing with no bedroom count at all is not excluded by a bedroom
// filter (undefined < 3 is false in JavaScript on both sides).
function savedSearchMatches(p, c) {
  if (!p || p.status !== 'available') return false;
  c = c || {};
  const q = String(c.q || '').toLowerCase().trim();
  if (q && !String(p.title || '').toLowerCase().includes(q) &&
      !String(p.location || '').toLowerCase().includes(q)) return false;
  if (c.propertyType && glraBaseType(p.propertyType) !== glraBaseType(c.propertyType)) return false;
  const minBeds = Number(c.minBeds) || 0;
  if (minBeds && p.bedrooms < minBeds) return false;
  const minBaths = Number(c.minBaths) || 0;
  if (minBaths && p.bathrooms < minBaths) return false;
  const minPrice = Number(c.minPrice) || 0, maxPrice = Number(c.maxPrice) || 0;
  if (!glraPriceFits(p, c.category, minPrice, maxPrice)) return false;
  if (c.category === 'FOR SALE' && !ssIsForSale(p)) return false;
  if (c.category === 'FOR LEASE' && !ssIsForLease(p)) return false;
  // Inside the drawn circle, measured from the same rounded position the page
  // uses (glraInArea), so the email and the map agree.
  if (c.area) {
    const g = p.geo;
    if (!g || g.status !== 'ok' || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return false;
    if (metresBetween(c.area.lat, c.area.lng, Number(g.lat.toFixed(3)), Number(g.lng.toFixed(3))) > c.area.r) return false;
  }
  return true;
}

// "3+ bedroom House and Lot for sale in 'alabang', ₱10,000,000 to ₱30,000,000"
function describeSavedSearch(raw) {
  const c = normalizeSavedSearchCriteria(raw);
  const lease = c.category === 'FOR LEASE';
  let s = '';
  if (c.minBeds > 0) s += `${c.minBeds}+ bedroom `;
  s += c.propertyType || (c.minBeds > 0 ? 'property' : 'Any property');
  if (c.minBaths > 0) s += ` with ${c.minBaths}+ bathroom${c.minBaths === 1 ? '' : 's'}`;
  if (c.category === 'FOR SALE') s += ' for sale';
  else if (lease) s += ' for lease';
  if (c.q) s += ` in '${c.q}'`;
  const peso = n => '₱' + Math.round(n).toLocaleString('en-US') + (lease ? '/month' : '');
  if (c.minPrice > 0 && c.maxPrice > 0) s += `, ${peso(c.minPrice)} to ${peso(c.maxPrice)}`;
  else if (c.minPrice > 0) s += `, from ${peso(c.minPrice)}`;
  else if (c.maxPrice > 0) s += `, up to ${peso(c.maxPrice)}`;
  if (c.area) s += `, inside the ${savedSearchKm(c.area.r)} km circle drawn on the map`;
  return s;
}
function savedSearchKm(r) { const km = r / 1000; return km < 10 ? km.toFixed(1) : String(Math.round(km)); }

// The same search, opened on the properties page (initFromUrl reads these).
function savedSearchBrowseUrl(raw) {
  const c = normalizeSavedSearchCriteria(raw);
  const p = new URLSearchParams();
  if (c.q) p.set('search', c.q);
  if (c.propertyType) p.set('propertyType', c.propertyType);
  if (c.minBeds > 0) p.set('bedrooms', String(c.minBeds));
  if (c.minBaths > 0) p.set('baths', String(c.minBaths));
  if (c.minPrice > 0) p.set('minPrice', String(Math.round(c.minPrice)));
  if (c.maxPrice > 0) p.set('maxPrice', String(Math.round(c.maxPrice)));
  if (c.category) p.set('category', c.category);
  if (c.area) p.set('area', [c.area.lat.toFixed(4), c.area.lng.toFixed(4), c.area.r].join(','));
  if (c.area) p.set('view', 'map');
  const qs = p.toString();
  return `${SITE_URL}/properties.html${qs ? '?' + qs : ''}`;
}

function maskEmail(e) {
  const parts = String(e || '').split('@');
  if (parts.length !== 2 || !parts[1]) return '***';
  return (parts[0] ? parts[0][0] : '') + '***@' + parts[1];
}

// Every available listing, with only the fields matching and the email need.
// An aggregation rather than find().select() so the two legacy listings whose
// photo is a multi-megabyte base64 data: URI never leave the database: the
// photo is passed through only when it is a real http(s) URL, which is also
// the only kind an email client can load.
async function loadSavedSearchListings() {
  return Property.aggregate([
    { $match: { status: 'available' } },
    { $sort: { createdAt: -1 } },
    { $project: {
      title: 1, location: 1, price: 1, monthlyRental: 1, bedrooms: 1, bathrooms: 1,
      propertyType: 1, listingType: 1, sqm: 1, landArea: 1, status: 1, createdAt: 1,
      'geo.lat': 1, 'geo.lng': 1, 'geo.status': 1,
      mainImage: { $cond: [
        { $eq: [{ $substrCP: [{ $ifNull: ['$mainImage', ''] }, 0, 4] }, 'http'] },
        '$mainImage', ''
      ] },
      // First hosted gallery photo only: enough for applyWebsiteCover to lead
      // with a clean photo instead of the flyer.
      gallery: { $slice: [{ $filter: {
        input: { $ifNull: ['$gallery', []] },
        cond: { $eq: [{ $substrCP: ['$$this', 0, 4] }, 'http'] }
      } }, 1] },
      coverImage: 1
    } }
  ]).then(rows => rows.map(applyWebsiteCover));
}

function ssPeso(n) { return '₱' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

function savedSearchPriceText(p) {
  const t = String(p.listingType || '').toUpperCase();
  const sale = Number(p.price) || 0, rent = Number(p.monthlyRental) || 0;
  if (t === 'SALE AND LEASE') {
    const parts = [];
    if (sale > 0) parts.push(ssPeso(sale));
    if (rent > 0) parts.push(ssPeso(rent) + '/month');
    return parts.length ? parts.join(' or ') : 'Price on request';
  }
  if (t === 'FOR LEASE') {
    const v = rent || sale;
    return v > 0 ? ssPeso(v) + '/month' : 'Price on request';
  }
  return sale > 0 ? ssPeso(sale) : 'Price on request';
}

function savedSearchSpecsText(p) {
  const bits = [];
  if (Number(p.bedrooms) > 0) bits.push(`${p.bedrooms} BR`);
  if (Number(p.bathrooms) > 0) bits.push(`${p.bathrooms} TB`);
  const sqm = Number(p.sqm) || 0, lot = Number(p.landArea) || 0;
  if (sqm > 0) bits.push(`${sqm.toLocaleString('en-US')} sqm`);
  else if (lot > 0) bits.push(`${lot.toLocaleString('en-US')} sqm lot`);
  if (p.propertyType) bits.push(p.propertyType);
  return bits.join(' · ');
}

function oneLine(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max || 120); }

// Shared paragraph + button styles, matching the price-alert emails.
const SS_P = 'color: #0a0a0a; line-height: 1.6; font-size: 14px;';
const SS_BTN = 'background-color: #ff3d00; color: #ffffff; padding: 12px 22px; text-decoration: none; border-radius:0; display: inline-block; font-weight: 600; font-size: 14px;';
const SS_BOX = 'background-color: #e8e4dd; border-left: 3px solid #ff3d00; padding: 18px 20px; margin: 22px 0; border-radius:0;';

function buildSavedSearchConfirmEmail(search, currentMatches) {
  const confirmUrl = `${SITE_URL}/alerts.html?confirm=${search.token}`;
  const browseUrl = savedSearchBrowseUrl(search.criteria);
  const matchLine = currentMatches === 1
    ? '1 listing matches right now.'
    : `${currentMatches} listings match right now.`;
  const html = getEmailHeader() + `
    <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">Confirm your property alert</h2>
    <p style="${SS_P}">You asked us to email you when a new listing matches this search:</p>
    <div style="${SS_BOX}">
      <p style="margin: 0; font-weight: 600; color: #0a0a0a;">${esc(search.summary)}</p>
    </div>
    <p style="${SS_P}">Please confirm it is you. Until you do, we will not send you anything else.</p>
    <p style="margin: 22px 0;"><a href="${esc(confirmUrl)}" style="${SS_BTN}">Confirm my alert</a></p>
    <p style="${SS_P}">${esc(matchLine)} <a href="${esc(browseUrl)}" style="color: #ff3d00;">See them on our website</a>. We will only email you about listings that go live after today.</p>
    <p style="color: #6a6a6a; line-height: 1.6; font-size: 12px;">If you did not ask for this, ignore this email and you will not hear from us again.</p>
  ` + getEmailFooter();
  return { subject: 'Confirm your GLRA property alert', html };
}

function buildSavedSearchAlertEmail(search, listings) {
  const shown = listings.slice(0, SAVED_SEARCH_EMAIL_CARDS);
  const extra = listings.length - shown.length;
  const manageUrl = `${SITE_URL}/alerts.html?t=${search.token}`;
  const browseUrl = savedSearchBrowseUrl(search.criteria);
  const n = listings.length;
  const cards = shown.map(p => {
    const url = `${SITE_URL}/property/${String(p._id)}`;
    const img = (typeof p.mainImage === 'string' && /^https?:\/\//i.test(p.mainImage)) ? p.mainImage : '';
    const specs = savedSearchSpecsText(p);
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; margin: 0 0 18px 0; border: 2px solid #0a0a0a;">
      ${img ? `<tr><td style="padding: 0;"><a href="${esc(url)}"><img src="${esc(img)}" alt="${esc(oneLine(p.title))}" width="540" style="display: block; width: 100%; max-width: 540px; height: auto; border: 0;"></a></td></tr>` : ''}
      <tr><td style="background-color: #e8e4dd; border-left: 3px solid #ff3d00; padding: 16px 18px;">
        <p style="margin: 0 0 6px 0; font-weight: 700; font-size: 16px;"><a href="${esc(url)}" style="color: #0a0a0a; text-decoration: none;">${esc(oneLine(p.title, 160))}</a></p>
        ${p.location ? `<p style="margin: 0 0 6px 0; color: #0a0a0a; font-size: 13px;">${esc(oneLine(p.location, 200))}</p>` : ''}
        ${specs ? `<p style="margin: 0 0 8px 0; color: #4a4a4a; font-size: 13px;">${esc(specs)}</p>` : ''}
        <p style="margin: 0 0 12px 0; color: #ff3d00; font-weight: 700; font-size: 17px;">${esc(savedSearchPriceText(p))}</p>
        <a href="${esc(url)}" style="background-color: #0a0a0a; color: #ffffff; padding: 9px 16px; text-decoration: none; border-radius:0; display: inline-block; font-size: 13px; font-weight: 600;">View listing</a>
      </td></tr>
    </table>`;
  }).join('');

  const subject = n === 1
    ? `New match for your search: ${oneLine(shown[0].title, 100) || 'a new listing'}`
    : `${n} new matches for your search`;
  const heading = n === 1 ? 'A new listing matches your search' : `${n} new listings match your search`;

  const html = getEmailHeader() + `
    <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">${esc(heading)}</h2>
    <p style="${SS_P}">${n === 1 ? 'This just went live' : 'These just went live'} and ${n === 1 ? 'matches' : 'match'} what you asked for:</p>
    <div style="${SS_BOX}">
      <p style="margin: 0; font-weight: 600; color: #0a0a0a;">${esc(search.summary)}</p>
    </div>
    ${cards}
    ${extra > 0 ? `<p style="${SS_P}">And ${extra} more. <a href="${esc(browseUrl)}" style="color: #ff3d00;">See every match</a>.</p>` : `<p style="${SS_P}"><a href="${esc(browseUrl)}" style="color: #ff3d00;">See every listing that matches your search</a>.</p>`}
    <p style="${SS_P}">Want to see one in person? Reply to this email and Catherine will set up a viewing.</p>
    <p style="color: #6a6a6a; line-height: 1.6; font-size: 12px; margin-top: 22px;">You are getting this because you saved this search on glrarealty.com. <a href="${esc(manageUrl)}" style="color: #0a0a0a;">Manage or stop these alerts</a></p>
  ` + getEmailFooter();
  return { subject, html };
}

// ── The trigger engine ─────────────────────────────────────
// Loads every available listing once, then for each confirmed, active search
// finds the matches it has not been sent yet. Everything it finds is recorded
// as sent (even beyond the six shown in the email), so nobody is ever emailed
// the same listing twice. A failed send records nothing, so the next sweep
// retries it. Never throws: a broken sweep must not take the site down.
let sweepRunning = false;
async function runSavedSearchSweep() {
  if (sweepRunning) return { skipped: 'already running' };
  if (mongoose.connection.readyState !== 1) return { skipped: 'database not connected' };
  sweepRunning = true;
  const started = Date.now();
  const stats = { searches: 0, emailed: 0, failed: 0, listingsSent: 0 };
  try {
    if (!brevoApiInstance && !initBrevo()) {
      // Same as the scheduled-email worker: without Brevo nothing can be sent,
      // and recording listings as "sent" would lose them for good.
      console.warn('Saved-search sweep skipped: Brevo not configured');
      return { skipped: 'email not configured' };
    }
    const [listings, searches] = await Promise.all([
      loadSavedSearchListings(),
      SavedSearch.find({ confirmed: true, active: true }).lean()
    ]);
    stats.searches = searches.length;
    for (const s of searches) {
      try {
        const sent = new Set(s.sentPropertyIds || []);
        const fresh = listings.filter(p => !sent.has(String(p._id)) && savedSearchMatches(p, s.criteria));
        if (!fresh.length) continue;
        const { subject, html } = buildSavedSearchAlertEmail(s, fresh);
        const r = await sendEmail(s.email, subject, html);
        if (!r || !r.success) { stats.failed++; continue; }
        await SavedSearch.updateOne(
          { _id: s._id },
          {
            $addToSet: { sentPropertyIds: { $each: fresh.map(p => String(p._id)) } },
            $inc: { emailsSent: 1 },
            $set: { lastSentAt: new Date() }
          }
        );
        stats.emailed++;
        stats.listingsSent += fresh.length;
      } catch (e) {
        stats.failed++;
        console.error('Saved-search sweep: one search failed:', e.message);
      }
    }
    console.log(`Saved-search sweep: ${stats.searches} active searches, ${stats.emailed} emailed (${stats.listingsSent} listings), ${stats.failed} failed, ${Date.now() - started}ms`);
    return stats;
  } catch (err) {
    console.error('Saved-search sweep error:', err.message);
    return { ...stats, error: err.message };
  } finally {
    sweepRunning = false;
  }
}

// Called after a listing is created or edited. Every call pushes the sweep
// back, so a burst of edits produces one sweep ten minutes after the last one.
let savedSearchSweepTimer = null;
function scheduleSavedSearchSweep() {
  try {
    if (savedSearchSweepTimer) clearTimeout(savedSearchSweepTimer);
    savedSearchSweepTimer = setTimeout(() => {
      savedSearchSweepTimer = null;
      runSavedSearchSweep().catch(e => console.error('Saved-search sweep error:', e.message));
    }, SAVED_SEARCH_DEBOUNCE_MS);
    savedSearchSweepTimer.unref();
  } catch (e) {
    console.error('scheduleSavedSearchSweep error:', e.message);
  }
}

// ══ LOCATION: WHERE EACH LISTING IS, AND WHAT IS NEAR IT ═════════════
// A background worker gives every active listing a map position (OpenStreetMap
// Nominatim) and a short list of the nearest train stations, malls, hospitals
// and schools (OpenStreetMap Overpass). The browse page's map reads the
// position from /api/properties; the listing page prints "What's nearby".
//
// Ground rules, all deliberate:
//  - Only a listing's own location text is ever sent out. Never anything
//    about a visitor, and never from inside a request: nothing here blocks or
//    slows a page.
//  - Both services are free and run on donated servers. Nominatim's policy is
//    at most one request a second with an identifying User-Agent; this keeps
//    1.2 s between requests and 3 s between Overpass queries, one at a time,
//    and stops a pass after repeated failures instead of hammering.
//  - Results are written with a plain $set: no updatedAt, no price history, no
//    price alerts, no saved-search sweep, no audit entry. It is not an edit.
//  - A lookup that found nothing ('none') is not repeated until the location
//    text changes; one that failed ('error') is retried with a growing wait.
//  - GEO_DISABLED=1 turns the whole thing off.
const GEO_DISABLED = process.env.GEO_DISABLED === '1';
const GEO_UA = 'GLRA Realty website (https://glrarealty.com; glrarealty@gmail.com)';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// OVERPASS_URL may point at another public instance if the main one is busy.
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const NOMINATIM_GAP_MS = 1200;
const OVERPASS_GAP_MS = 3000;
const NEARBY_RADIUS_M = 2000;
// Nominatim place_rank: 16 is a whole city, 18-20 a district or barangay, 26
// and up a street or building. Distances measured from the middle of a city
// would be fiction, so "what's nearby" needs at least a district.
const NEARBY_MIN_RANK = 18;
const NEARBY_MAX_AGE_MS = 90 * 864e5;
const GEO_DAILY_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_FILE = path.join(os.tmpdir(), 'glra-geo-cache.json');
const GEO_LOCK_FILE = path.join(os.tmpdir(), 'glra-geo.lock');
const GEO_CACHE_TTL_MS = 30 * 864e5;

// The text a listing is looked up by, and the key that notices it changed.
function geoQueryFor(p) {
  const base = String((p && (String(p.mapLocation || '').trim() || p.location)) || '').replace(/\s+/g, ' ').trim();
  return base ? base + ', Philippines' : '';
}

// What is actually sent: the same text tidied into something a geocoder can
// match. Brokers type Google plus codes, the Filipino "Pilipinas", building
// names in brackets, "corner X" / "near Y" directions and bare postcodes.
function geoLookupText(q) {
  const parts = String(q)
    .replace(/\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/gi, ' ')
    .replace(/[()\u30fb|;]/g, ',')
    .replace(/\s+[\u2014\u2013-]\s+/g, ',')
    .replace(/\bPilipinas\b/gi, 'Philippines')
    .replace(/\bKalakhang Maynila\b/gi, 'Metro Manila')
    .replace(/\b(brgy|bgy|barangay)\b\.?/gi, ' ')
    .split(',')
    .map(s => s.replace(/\s+(via|near|corner|cor\.?|beside|behind|across)\s.*$/i, '').replace(/\s+/g, ' ').trim())
    .filter(s => s && !/^\d+$/.test(s) && !/^(via|near|corner|cor\.?|beside|behind|across)\b/i.test(s) && !/^philippines$/i.test(s));
  const seen = new Set();
  const uniq = parts.filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return uniq.length ? uniq.join(', ') + ', Philippines' : '';
}
// The one retry: the first comma part is most often a building or unit
// nobody has mapped, so drop it; a single-part text keeps only its last word
// group (usually the city).
function geoSimplify(text) {
  const parts = String(text).split(',').map(s => s.trim()).filter(s => s && !/^philippines$/i.test(s));
  if (parts.length >= 2) return parts.slice(1).join(', ') + ', Philippines';
  return '';
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const _geoLast = { n: 0, o: 0 };
let _overpassGap = OVERPASS_GAP_MS;
async function geoThrottle(kind, gap) {
  const wait = _geoLast[kind] + gap - Date.now();
  if (wait > 0) await sleepMs(wait);
  _geoLast[kind] = Date.now();
}
async function geoFetch(url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally { clearTimeout(t); }
}

// A small answer cache on local disk. It saves the free services from a
// repeat question after a restart (and every local test stack from re-asking
// all 64 listings); production keeps its answers in the database regardless.
function geoCacheRead() {
  try { return JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function geoCacheGet(key) {
  const c = geoCacheRead()[key];
  return c && Date.now() - c.t < GEO_CACHE_TTL_MS ? c.v : undefined;
}
function geoCachePut(key, v) {
  try {
    const c = geoCacheRead();
    c[key] = { t: Date.now(), v };
    const tmp = GEO_CACHE_FILE + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, GEO_CACHE_FILE);
  } catch (e) { /* a cache that cannot be written is only a slower cache */ }
}
// One worker per machine: two processes on one host (a restart overlap, or
// several local test servers) would otherwise double the request rate.
function geoLockAcquire() {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(GEO_LOCK_FILE, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') return true; // no usable temp dir: just run
      try {
        const st = fs.statSync(GEO_LOCK_FILE);
        const holder = Number(fs.readFileSync(GEO_LOCK_FILE, 'utf8'));
        let alive = false;
        try { if (holder && holder !== process.pid) { process.kill(holder, 0); alive = true; } } catch (e3) { alive = e3.code === 'EPERM'; }
        if (alive && Date.now() - st.mtimeMs < 10 * 60 * 1000) return false;
        fs.unlinkSync(GEO_LOCK_FILE);
      } catch (e2) { /* raced with another process; try once more */ }
    }
  }
  return false;
}
function geoLockTouch() { try { const n = new Date(); fs.utimesSync(GEO_LOCK_FILE, n, n); } catch (e) {} }
function geoLockRelease() {
  try { if (fs.readFileSync(GEO_LOCK_FILE, 'utf8') === String(process.pid)) fs.unlinkSync(GEO_LOCK_FILE); } catch (e) {}
}

// How far to trust a hit. Nominatim answers a place name with the best-scoring
// thing that carries it, and in testing "Lucena City" came back as a railway
// platform, "Mariveles Bataan" as a university and "Fairview, Quezon City" as
// a car dealer: all in the right town, none of them the listing. Areas and
// roads are taken at their word; a named point only when every word of its
// name is in what was asked for (so "Monarch Parksuites" is the building).
// Anything else counts as town level: fine for a map pin, not for distances.
const GEO_STOPWORDS = new Set(['the', 'of', 'and', 'de', 'del', 'ng', 'sa']);
function geoWords(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1 && !GEO_STOPWORDS.has(w));
}
function geoHitRank(a, text) {
  const rank = Number(a.place_rank) || 0;
  const cat = String(a.category || ''), type = String(a.type || ''), at = String(a.addresstype || '');
  const TOWN = Math.min(rank, 16);
  if (cat === 'place' || cat === 'boundary' || cat === 'landuse') return rank;
  if (cat === 'highway' && at === 'road') return rank;
  if (/^(railway|public_transport|aeroway)$/.test(cat) || /^(bus_stop|motorway_junction|platform|stop|station)$/.test(type)) return TOWN;
  const nameW = geoWords(a.name);
  if (!nameW.length) return rank; // an address match: a building found by its number
  const asked = new Set(geoWords(text));
  return nameW.every(w => asked.has(w)) ? rank : TOWN;
}

// null = looked and found nothing; throws = could not ask.
async function nominatimLookup(text) {
  const key = 'n2:' + text;
  const hit = geoCacheGet(key);
  if (hit !== undefined) return hit;
  await geoThrottle('n', NOMINATIM_GAP_MS);
  let r;
  try {
    r = await geoFetch(`${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=ph&q=${encodeURIComponent(text)}`,
      { headers: { 'User-Agent': GEO_UA, 'Accept': 'application/json', 'Accept-Language': 'en' } }, 20000);
  } finally { _geoLast.n = Date.now(); }
  if (!r.ok) { const err = new Error('Nominatim HTTP ' + r.status); err.status = r.status; throw err; }
  const arr = await r.json();
  const a = Array.isArray(arr) ? arr[0] : null;
  const lat = a ? Number(a.lat) : NaN, lng = a ? Number(a.lon) : NaN;
  // Inside the Philippines' bounding box, or it is not an answer.
  const out = (Number.isFinite(lat) && Number.isFinite(lng) && lat > 4 && lat < 22 && lng > 116 && lng < 127.5)
    ? { lat, lng, rank: geoHitRank(a, text) } : null;
  geoCachePut(key, out);
  return out;
}

async function geocodeQuery(q) {
  const first = geoLookupText(q);
  if (!first) return { status: 'none' };
  const tries = [first];
  const simpler = geoSimplify(first);
  if (simpler && simpler !== first) tries.push(simpler);
  for (const t of tries) {
    const hit = await nominatimLookup(t);
    if (hit) return { status: 'ok', ...hit };
  }
  return { status: 'none' };
}

const NEARBY_CATS = [
  ['rail', 'Train stations', 'fa-train-subway'],
  ['mall', 'Malls', 'fa-bag-shopping'],
  ['hospital', 'Hospitals', 'fa-hospital'],
  ['school', 'Schools & universities', 'fa-graduation-cap']
];
function metresBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Mapped but not carrying passengers as of September 2026: the Metro Manila
// Subway and the North-South Commuter Railway are being built, MRT-7 is not
// open, and the PNR's Metro Manila service was suspended in 2024 for the NSCR
// works. OpenStreetMap already has their stations, and "Bonifacio Global City
// station, 1.1 km" would read as a working train. Revisit as each line opens.
const NOT_RUNNING_RAIL = /metro manila subway|\bmmsp\b|north[\s-]*south commuter|\bnscr\b|mrt[\s-]*(line\s*)?7\b|\bpnr\b|philippine national railways/i;
function nearbyCategory(tags) {
  if (tags.construction || tags.proposed || tags.disused || tags.abandoned || tags['disused:railway'] || tags['abandoned:railway']) return '';
  if (tags.railway === 'station') {
    // LRT-1 and MRT-3 are mapped as station=light_rail. LRT-2 is mapped as
    // station=subway although it runs (this used to drop every LRT-2 station,
    // Katipunan included); everything else mapped station=subway (the Subway,
    // MRT-7, the North Triangle Common Station) is still being built.
    const text = [tags.network, tags.operator, tags.line, tags['name:en'], tags.name].filter(Boolean).join(' ');
    if ((tags.station === 'subway' || tags.subway === 'yes') && !/LRT[\s-]*(Line\s*)?2\b|light rail transit authority|\bLRTA\b/i.test(text)) return '';
    return NOT_RUNNING_RAIL.test(text) ? '' : 'rail';
  }
  if (tags.shop === 'mall') return 'mall';
  if (tags.amenity === 'hospital') return 'hospital';
  if (/^(school|university|college)$/.test(tags.amenity || '')) return 'school';
  return '';
}
// The lifestyle score counts everyday places within 500 m and 1 km (about a
// 6- and a 12-minute walk). Overpass answers each with a bare count, so the
// query stays small even in the middle of Makati.
const LIFE_SETS = [
  ['grocery', '(nwr.sh["shop"~"^(supermarket|convenience|greengrocer)$"];nwr.am["amenity"="marketplace"];)'],
  ['dining', 'nwr.am["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]'],
  ['park', 'nwr.le["leisure"~"^(park|playground|nature_reserve)$"]'],
  ['health', 'nwr.am["amenity"~"^(pharmacy|clinic|doctors|dentist|hospital)$"]'],
  ['transit', '(node.bs;nwr.am["amenity"="bus_station"];nwr.rs;)'],
  ['school', 'nwr.am["amenity"~"^(school|kindergarten|university|college)$"]']
];
// One pass over the 1 km around the listing per tag key, then each category
// is picked out of those sets and counted twice: inside 500 m, then all of
// the 1 km. The answer is twelve count elements, in this order.
function lifeQuery(lat, lng) {
  const P = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  return `nwr["amenity"](around:1000,${P})->.am;nwr["shop"](around:1000,${P})->.sh;nwr["leisure"](around:1000,${P})->.le;` +
    `node["highway"="bus_stop"](around:1000,${P})->.bs;nwr["railway"="station"](around:1000,${P})->.rs;` +
    LIFE_SETS.map(([, set]) => `${set}->.s;nwr.s(around:500,${P});out count;.s out count;`).join('');
}
async function overpassNearby(lat, lng) {
  const key = `o5:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = geoCacheGet(key);
  if (cached !== undefined) return cached;
  const a = `(around:${NEARBY_RADIUS_M},${lat.toFixed(6)},${lng.toFixed(6)})`;
  const lifeQ = lifeQuery(lat, lng);
  const query = `[out:json][timeout:30];(nwr["railway"="station"]${a};nwr["shop"="mall"]${a};` +
    `nwr["amenity"="hospital"]${a};nwr["amenity"="school"]${a};nwr["amenity"="university"]${a};nwr["amenity"="college"]${a};);out center tags;` + lifeQ;
  // Overpass shares two query slots per address and frees one only after a
  // cool-down that grows with how long the last query ran, so the gap grows
  // with the work; a busy answer (429/504) gets one patient retry.
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    await geoThrottle('o', _overpassGap);
    const t0 = Date.now();
    try {
      r = await geoFetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'User-Agent': GEO_UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: 'data=' + encodeURIComponent(query)
      }, 40000);
    } finally {
      _geoLast.o = Date.now();
      // Measured: a 10 s query here left its slot cooling for about 60 s,
      // and there are two slots, so about three times the run time apart.
      _overpassGap = Math.max(OVERPASS_GAP_MS, Math.min(90000, 3 * (Date.now() - t0)));
    }
    if (r.status !== 429 && r.status !== 504) break;
    if (attempt === 0) await sleepMs(45000);
  }
  if (!r.ok) { const err = new Error('Overpass HTTP ' + r.status); err.status = r.status; throw err; }
  const data = await r.json();
  if (data && data.remark && /runtime error|timed out/i.test(data.remark)) throw new Error('Overpass: ' + data.remark.slice(0, 120));
  const best = {};
  const counts = (data.elements || []).filter(el => el.type === 'count').map(el => Number(el.tags && el.tags.total) || 0);
  const life = {};
  if (counts.length === LIFE_SETS.length * 2) LIFE_SETS.forEach(([k], i) => { life[k] = [counts[2 * i], Math.max(counts[2 * i], counts[2 * i + 1])]; });
  (data.elements || []).forEach(el => {
    if (el.type === 'count') return;
    const tags = el.tags || {};
    const cat = nearbyCategory(tags);
    const name = String(tags['name:en'] || tags.name || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const eLat = el.lat != null ? el.lat : el.center && el.center.lat;
    const eLng = el.lon != null ? el.lon : el.center && el.center.lon;
    if (!cat || !name || !Number.isFinite(eLat) || !Number.isFinite(eLng)) return;
    const dist = Math.round(metresBetween(lat, lng, eLat, eLng));
    // One entry per place: a station is often mapped once per line or platform.
    const k = cat + '|' + name.toLowerCase().replace(/\b(station|stn)\b/g, '').replace(/[^a-z0-9]+/g, '');
    // lat/lng (about 1 m) put the place on the listing page's neighbourhood map.
    if (!best[k] || best[k].dist > dist) best[k] = { cat, name, dist, lat: Number(eLat.toFixed(5)), lng: Number(eLng.toFixed(5)) };
  });
  const items = [];
  NEARBY_CATS.forEach(([cat]) => {
    Object.values(best).filter(x => x.cat === cat).sort((x, y) => x.dist - y.dist).slice(0, 3).forEach(x => items.push(x));
  });
  const out = { items, life: Object.keys(life).length ? life : null };
  geoCachePut(key, out);
  return out;
}

function geoNeedsLookup(p, q, now) {
  const g = p.geo || {};
  if (!g.status || g.q !== q) return true;
  if (g.status === 'error') {
    const wait = Math.min(GEO_DAILY_MS, 15 * 60 * 1000 * Math.pow(2, Math.max(0, (g.tries || 1) - 1)));
    return !g.at || now - new Date(g.at).getTime() >= wait;
  }
  return false; // 'ok' and 'none' stand until the location text changes
}
function nearbyNeeded(p, geo, now) {
  if (!geo || geo.status !== 'ok' || !(geo.rank >= NEARBY_MIN_RANK)) return false;
  const n = p.nearby;
  if (!n || !n.at) return true;
  // Lists saved before places carried a position: fetch again for the map.
  if (Array.isArray(n.items) && n.items.length && !Number.isFinite(n.items[0].lat)) return true;
  // Saved before the lifestyle counts (and before LRT-2 stations counted).
  if (!n.life) return true;
  const at = new Date(n.at).getTime();
  if (geo.at && at < new Date(geo.at).getTime()) return true;
  return now - at > NEARBY_MAX_AGE_MS;
}

let geoRunning = false, geoRerun = false, geoTimer = null;
const _nearbyBackoff = new Map(); // listing id -> { until, n } after an Overpass failure
const _hazardBackoff = new Map(); // the same, for the hazard lookups

// Flood, storm surge and landslide levels (server/hazard.js) are looked up
// once per position, and again only when the position moves or the lookup
// itself changes (HAZARD_VERSION).
function hazardNeeded(p, geo) {
  if (!geo || geo.status !== 'ok' || !(geo.rank >= NEARBY_MIN_RANK)) return false;
  const h = p.hazard;
  if (!h || h.v !== HAZARD_VERSION || !h.at) return true;
  return !!(geo.at && new Date(h.at).getTime() < new Date(geo.at).getTime());
}

async function runGeoPass() {
  if (GEO_DISABLED) return null;
  if (geoRunning) { geoRerun = true; return null; }
  if (mongoose.connection.readyState !== 1) { scheduleGeoPass(60 * 1000); return null; }
  if (!geoLockAcquire()) { scheduleGeoPass(10 * 60 * 1000); return null; }
  geoRunning = true;
  const started = Date.now();
  const stats = { listings: 0, looked: 0, ok: 0, none: 0, error: 0, nearby: 0, nearbyFailed: 0, hazard: 0, hazardFailed: 0 };
  let geoFails = 0, nearbyFails = 0, hazardFails = 0;
  try {
    const rows = await Property.find({ status: 'available' }).select('_id mapLocation location geo nearby hazard').lean();
    stats.listings = rows.length;
    // Two rounds: every position first (about a second each), so the map is
    // complete within minutes; then the slower nearby lists.
    const placed = [];
    for (const p of rows) {
      const now = Date.now();
      const q = geoQueryFor(p);
      if (!q) continue;
      let geo = p.geo;
      if (geoFails < 3 && geoNeedsLookup(p, q, now)) {
        stats.looked++;
        let next;
        try {
          next = { ...(await geocodeQuery(q)), q, at: new Date(), tries: 0 };
          geoFails = 0;
        } catch (e) {
          geoFails++;
          const prevTries = p.geo && p.geo.q === q && p.geo.status === 'error' ? (p.geo.tries || 0) : 0;
          next = { status: 'error', q, at: new Date(), tries: prevTries + 1 };
          console.warn('Geo lookup failed:', e.message);
          // Refused outright (blocked or rate limited): stop asking for now.
          if (e.status === 403 || e.status === 429) geoFails = 3;
        }
        stats[next.status]++;
        await Property.updateOne({ _id: p._id }, { $set: { geo: next }, $unset: { nearby: 1, hazard: 1 } });
        invalidatePublicListingsCache();
        geo = next;
        p.nearby = null;
        p.hazard = null;
        geoLockTouch();
      }
      placed.push([p, geo]);
    }
    for (const [p, geo] of placed) {
      const now = Date.now();
      const id = String(p._id);
      const bo = _nearbyBackoff.get(id);
      if (nearbyFails < 3 && nearbyNeeded(p, geo, now) && !(bo && bo.until > now)) {
        try {
          const { items, life } = await overpassNearby(geo.lat, geo.lng);
          await Property.updateOne({ _id: p._id }, { $set: { nearby: { at: new Date(), items, life: life || undefined } } });
          invalidatePublicListingsCache();
          _nearbyBackoff.delete(id);
          stats.nearby++;
          nearbyFails = 0;
        } catch (e) {
          nearbyFails++;
          stats.nearbyFailed++;
          const n = (bo ? bo.n : 0) + 1;
          _nearbyBackoff.set(id, { n, until: Date.now() + Math.min(GEO_DAILY_MS, 15 * 60 * 1000 * Math.pow(2, n - 1)) });
          console.warn('Nearby lookup failed:', e.message);
          if (e.status === 403 || e.status === 429) nearbyFails = 3;
        }
        geoLockTouch();
      }
    }
    // Third round: natural hazards. Each listing is ten small reads from the
    // hazard maps, a few seconds in all.
    for (const [p, geo] of placed) {
      if (hazardFails >= 3 || !hazardNeeded(p, geo)) continue;
      const id = String(p._id), now = Date.now();
      const bo = _hazardBackoff.get(id);
      if (bo && bo.until > now) continue;
      try {
        const hz = await hazardAt(geo.lat, geo.lng);
        await Property.updateOne({ _id: p._id }, { $set: { hazard: hz } });
        _hazardBackoff.delete(id);
        stats.hazard++;
        hazardFails = 0;
      } catch (e) {
        hazardFails++;
        stats.hazardFailed++;
        const n = (bo ? bo.n : 0) + 1;
        _hazardBackoff.set(id, { n, until: Date.now() + Math.min(GEO_DAILY_MS, 15 * 60 * 1000 * Math.pow(2, n - 1)) });
        console.warn('Hazard lookup failed:', e.message);
      }
      geoLockTouch();
    }
    if (geoFails >= 3 || nearbyFails >= 3 || hazardFails >= 3) scheduleGeoPass(30 * 60 * 1000);
  } catch (e) {
    console.error('Geo pass error:', e.message);
  } finally {
    geoRunning = false;
    geoLockRelease();
    if (stats.looked || stats.nearby || stats.nearbyFailed || stats.hazard || stats.hazardFailed) {
      console.log(`Geo pass: ${stats.listings} listings, ${stats.looked} looked up (${stats.ok} ok, ${stats.none} not found, ${stats.error} failed), ${stats.nearby} nearby lists (${stats.nearbyFailed} failed), ${stats.hazard} hazard checks (${stats.hazardFailed} failed), ${Date.now() - started}ms`);
    }
    if (geoRerun) { geoRerun = false; scheduleGeoPass(30 * 1000); }
  }
  return stats;
}

// Called when a listing is created or edited; a burst of edits is one pass.
function scheduleGeoPass(delayMs) {
  if (GEO_DISABLED) return;
  try {
    if (geoTimer) clearTimeout(geoTimer);
    geoTimer = setTimeout(() => {
      geoTimer = null;
      runGeoPass().catch(e => console.error('Geo pass error:', e.message));
    }, delayMs == null ? 30 * 1000 : delayMs);
    geoTimer.unref();
  } catch (e) {
    console.error('scheduleGeoPass error:', e.message);
  }
}
if (!GEO_DISABLED) {
  scheduleGeoPass(60 * 1000);
  setInterval(() => scheduleGeoPass(1000), GEO_DAILY_MS).unref();
}

// What the public API may say about a listing's position: rounded to three
// decimals (about 100 m, approximate on purpose) and only when it was found.
// `approx` marks a position known only to the nearest city or town.
function publicGeo(p) {
  if (!p) return p;
  const g = p.geo;
  if (g && g.status === 'ok' && Number.isFinite(g.lat) && Number.isFinite(g.lng)) {
    p.geo = { lat: Number(g.lat.toFixed(3)), lng: Number(g.lng.toFixed(3)) };
    if (!(g.rank >= NEARBY_MIN_RANK)) p.geo.approx = true;
  } else {
    delete p.geo;
  }
  delete p.nearby;
  delete p.hazard;
  return p;
}

// ── Travel-time areas for the listing page map (js/glra-maps.js) ──────────
// The free Valhalla server run by FOSSGIS on OpenStreetMap data. Only a live
// listing's own public position may be asked about, so this cannot be used
// as a free routing proxy, and each answer is kept for 30 days: a listing
// costs Valhalla two questions a month at most (car and on foot).
const ISO_URL = 'https://valhalla1.openstreetmap.de/isochrone';
const ISO_TTL_MS = 30 * 24 * 3600 * 1000;
const _isoMem = new Map();
let _isoChain = Promise.resolve(), _isoLast = 0;
let _isoPoints = { at: 0, set: null };
async function isoAllowedPoints() {
  if (_isoPoints.set && Date.now() - _isoPoints.at < 10 * 60 * 1000) return _isoPoints.set;
  const rows = await Property.find({ status: 'available', 'geo.status': 'ok' }).select('geo').lean();
  const set = new Set(rows.filter(r => r.geo && Number.isFinite(r.geo.lat) && Number.isFinite(r.geo.lng))
    .map(r => r.geo.lat.toFixed(3) + ',' + r.geo.lng.toFixed(3)));
  _isoPoints = { at: Date.now(), set };
  return set;
}
function isoAsk(lat, lng, mode) {
  // One question at a time, at least two seconds apart.
  const run = _isoChain.then(async () => {
    const wait = 2000 - (Date.now() - _isoLast);
    if (wait > 0) await sleepMs(wait);
    _isoLast = Date.now();
    const q = { locations: [{ lat, lon: lng }], costing: mode, contours: [{ time: 15 }, { time: 30 }, { time: 45 }], polygons: true, denoise: 0.3, generalize: 60 };
    const r = await geoFetch(ISO_URL + '?json=' + encodeURIComponent(JSON.stringify(q)), { headers: { 'User-Agent': GEO_UA, 'Accept': 'application/json' } }, 30000);
    if (!r.ok) throw new Error('Valhalla HTTP ' + r.status);
    const d = await r.json();
    return {
      type: 'FeatureCollection',
      features: (d.features || []).filter(f => f && f.geometry && /Polygon/.test(f.geometry.type))
        .map(f => ({ type: 'Feature', properties: { contour: Number(f.properties && f.properties.contour) || 0 }, geometry: f.geometry }))
    };
  });
  _isoChain = run.catch(() => {});
  return run;
}
// The commute finder on the browse page asks from a workplace or school the
// visitor picks, not from a listing. Those points are rounded the same way
// and cached the same way, but each visitor gets a small hourly budget so
// the free routing server is never used as a general-purpose service.
const commuteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many travel-time searches. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});
function isoCommuteGate(req, res, next) {
  if (req.query.from !== 'place') return next();
  // Answers already cached cost the routing server nothing: only fresh
  // questions count against the hourly budget.
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const mode = req.query.mode === 'pedestrian' ? 'pedestrian' : 'auto';
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const key = 'iso1:' + mode + ':' + lat.toFixed(3) + ',' + lng.toFixed(3);
    const hit = _isoMem.get(key);
    if (hit && Date.now() - hit.t <= ISO_TTL_MS) return next();
  }
  return commuteLimiter(req, res, next);
}
app.get('/api/isochrone', trackLimiter, isoCommuteGate, async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const mode = req.query.mode === 'pedestrian' ? 'pedestrian' : 'auto';
  if (!(lat >= 4 && lat <= 22 && lng >= 116 && lng <= 127.5)) return res.status(400).json({ error: 'Bad position' });
  const pt = lat.toFixed(3) + ',' + lng.toFixed(3);
  try {
    if (req.query.from !== 'place') {
      const allowed = await isoAllowedPoints();
      if (!allowed.has(pt)) return res.status(404).json({ error: 'Travel times are only available for live listings.' });
    }
    const key = 'iso1:' + mode + ':' + pt;
    let hit = _isoMem.get(key);
    if (!hit || Date.now() - hit.t > ISO_TTL_MS) {
      const disk = geoCacheGet(key);
      if (disk !== undefined) hit = { t: Date.now(), v: disk };
      else {
        const v = await isoAsk(Number(lat.toFixed(3)), Number(lng.toFixed(3)), mode);
        geoCachePut(key, v);
        hit = { t: Date.now(), v };
      }
      if (_isoMem.size > 400) _isoMem.clear();
      _isoMem.set(key, hit);
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(hit.v);
  } catch (e) {
    res.status(502).json({ error: 'The travel-time service did not answer. Please try again later.' });
  }
});

// ── Place search for the commute finder (properties.html) ─────────────────
// Nominatim, Philippines only, at most five answers, cached for 30 days and
// sharing the location worker's one-question-a-second pace.
const geocodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  message: { error: 'Too many place searches. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const _placeMem = new Map();
app.get('/api/place-search', trackLimiter, async (req, res) => {
  const q = String(req.query.q || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (q.length < 3) return res.status(400).json({ error: 'Type at least three letters.' });
  const key = 'ps1:' + q.toLowerCase();
  try {
    let hit = _placeMem.get(key);
    if (!hit) {
      const disk = geoCacheGet(key);
      if (disk !== undefined) hit = disk;
    }
    if (!hit) {
      // Only questions that reach Nominatim count against the budget.
      const allowed = await new Promise(resolve => {
        Promise.resolve(geocodeLimiter(req, res, () => resolve(true))).then(() => resolve(!res.headersSent), () => resolve(false));
      });
      if (!allowed || res.headersSent) return;
      await geoThrottle('n', NOMINATIM_GAP_MS);
      let r;
      try {
        r = await geoFetch(`${NOMINATIM_URL}?format=jsonv2&limit=5&countrycodes=ph&viewbox=120.85,14.85,121.25,14.30&q=${encodeURIComponent(q)}`,
          { headers: { 'User-Agent': GEO_UA, 'Accept': 'application/json', 'Accept-Language': 'en' } }, 20000);
      } finally { _geoLast.n = Date.now(); }
      if (!r.ok) throw new Error('Nominatim HTTP ' + r.status);
      const arr = await r.json();
      hit = (Array.isArray(arr) ? arr : []).map(a => ({
        name: String(a.name || '').slice(0, 80),
        label: String(a.display_name || '').split(',').slice(0, 4).join(',').slice(0, 140),
        lat: Number(Number(a.lat).toFixed(4)), lng: Number(Number(a.lon).toFixed(4))
      })).filter(x => x.lat > 4 && x.lat < 22 && x.lng > 116 && x.lng < 127.5);
      geoCachePut(key, hit);
    }
    if (_placeMem.size > 500) _placeMem.clear();
    _placeMem.set(key, hit);
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ results: hit });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'The place search did not answer. Please try again later.' });
  }
});

// ── Earthquake history for the listing page map ──────────────────────────
// The US Geological Survey's catalogue: every magnitude 4.5 and stronger
// within 100 km since 1976. Asked only for a live listing's public position,
// kept for a week (a new strong quake nearby shows up within days).
const QUAKE_TTL_MS = 7 * 864e5;
const _quakeMem = new Map();
let _quakeChain = Promise.resolve();
app.get('/api/quakes', trackLimiter, async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!(lat >= 4 && lat <= 22 && lng >= 116 && lng <= 127.5)) return res.status(400).json({ error: 'Bad position' });
  const pt = lat.toFixed(3) + ',' + lng.toFixed(3);
  try {
    const allowed = await isoAllowedPoints();
    if (!allowed.has(pt)) return res.status(404).json({ error: 'Only available for live listings.' });
    let hit = _quakeMem.get(pt);
    if (!hit || Date.now() - hit.t > QUAKE_TTL_MS) {
      const run = _quakeChain.then(async () => {
        const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=magnitude&limit=600'
          + `&latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&maxradiuskm=100&minmagnitude=4.5&starttime=1976-01-01`;
        const r = await geoFetch(url, { headers: { 'User-Agent': GEO_UA, 'Accept': 'application/json' } }, 30000);
        if (!r.ok) throw new Error('USGS HTTP ' + r.status);
        const d = await r.json();
        return (d.features || []).map(f => {
          const c = f.geometry && f.geometry.coordinates || [], pr = f.properties || {};
          return [Number(Number(c[1]).toFixed(3)), Number(Number(c[0]).toFixed(3)), Number(pr.mag), Math.round(Number(c[2]) || 0), Number(pr.time) || 0];
        }).filter(q => Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2]));
      });
      _quakeChain = run.catch(() => {});
      hit = { t: Date.now(), v: await run };
      if (_quakeMem.size > 300) _quakeMem.clear();
      _quakeMem.set(pt, hit);
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ quakes: hit.v });
  } catch (e) {
    res.status(502).json({ error: 'The earthquake catalogue did not answer. Please try again later.' });
  }
});

// Safety net for listings that change some other way (a lease ending and the
// listing going back on the market, a restart that lost a pending timer).
// First run two minutes after boot so the database has time to connect.
setTimeout(() => {
  runSavedSearchSweep().catch(() => {});
  setInterval(() => { runSavedSearchSweep().catch(() => {}); }, SAVED_SEARCH_SAFETY_MS).unref();
}, 2 * 60 * 1000).unref();

// 1. Save a search (unconfirmed) and send the confirmation link.
app.post('/api/saved-search',
  publicWriteLimiter,
  body('email').isEmail().normalizeEmail(),
  body('criteria').optional().isObject(),
  body('criteria.category').optional({ values: 'falsy' }).isIn(['FOR SALE', 'FOR LEASE']),
  body('criteria.q').optional({ values: 'null' }).isString().trim().isLength({ max: 80 }),
  body('criteria.propertyType').optional({ values: 'null' }).isString().trim().isLength({ max: 60 }),
  body('criteria.minBeds').optional({ values: 'falsy' }).isInt({ min: 0, max: 20 }).toInt(),
  body('criteria.minBaths').optional({ values: 'falsy' }).isInt({ min: 0, max: 20 }).toInt(),
  body('criteria.minPrice').optional({ values: 'falsy' }).isFloat({ min: 0, max: 1e12 }).toFloat(),
  body('criteria.maxPrice').optional({ values: 'falsy' }).isFloat({ min: 0, max: 1e12 }).toFloat(),
  body('criteria.area').optional({ values: 'null' }).isObject(),
  body('criteria.area.lat').optional().isFloat({ min: 4, max: 22 }).toFloat(),
  body('criteria.area.lng').optional().isFloat({ min: 116, max: 127.5 }).toFloat(),
  body('criteria.area.r').optional().isFloat({ min: 100, max: 60000 }).toFloat(),
  body('vid').optional().isString().trim().isLength({ max: 64 }),
  handleValidation,
  async (req, res) => {
    try {
      const email = String(req.body.email).toLowerCase();
      const vid = typeof req.body.vid === 'string' ? req.body.vid : '';
      const criteria = normalizeSavedSearchCriteria(req.body.criteria);
      if (!savedSearchHasCriteria(criteria)) {
        return res.status(400).json({ error: 'Pick at least one filter first, such as a location, a property type or a price range.' });
      }
      if (criteria.minPrice > 0 && criteria.maxPrice > 0 && criteria.minPrice > criteria.maxPrice) {
        return res.status(400).json({ error: 'The minimum price is higher than the maximum price.' });
      }

      const listings = await loadSavedSearchListings();
      const matching = listings.filter(p => savedSearchMatches(p, criteria));
      const currentMatches = matching.length;

      // The same search already on file for this address?
      const same = await SavedSearch.findOne({
        email, active: true,
        'criteria.category': criteria.category,
        'criteria.q': criteria.q,
        'criteria.propertyType': criteria.propertyType,
        'criteria.minBeds': criteria.minBeds,
        'criteria.minBaths': criteria.minBaths,
        'criteria.minPrice': criteria.minPrice,
        'criteria.maxPrice': criteria.maxPrice,
        'criteria.area': criteria.area
      });
      if (same && same.confirmed) {
        return res.json({
          success: true, alreadyActive: true, emailSent: false, currentMatches,
          message: 'You already have this alert. We will email you when a new match goes live.'
        });
      }
      if (same) {
        // One confirmation email per quarter hour, however often the form is
        // sent: otherwise this is a way to fill a stranger's inbox.
        if (same.confirmSentAt && Date.now() - new Date(same.confirmSentAt).getTime() < 15 * 60 * 1000) {
          return res.json({
            success: true, resent: false, emailSent: false, currentMatches,
            message: 'We already sent you a confirmation link a few minutes ago. Please check your inbox and spam folder.'
          });
        }
        await SavedSearch.updateOne({ _id: same._id }, { $set: { confirmSentAt: new Date() } });
        const { subject, html } = buildSavedSearchConfirmEmail(same, currentMatches);
        const r = await sendEmail(email, subject, html);
        const ok = !!(r && r.success);
        return res.json({
          success: true, resent: true, emailSent: ok, currentMatches,
          message: ok
            ? 'We sent the confirmation link again. Please check your inbox.'
            : 'Your search is saved, but we could not send the confirmation email just now. Please try again in a few minutes.'
        });
      }

      // Unconfirmed searches cost the address owner an email each, so only a
      // few may wait for confirmation at once.
      const pending = await SavedSearch.countDocuments({ email, active: true, confirmed: false });
      if (pending >= 3) {
        return res.status(400).json({
          error: 'Please confirm the alerts already waiting in your inbox before adding another.'
        });
      }
      const activeCount = await SavedSearch.countDocuments({ email, active: true });
      if (activeCount >= SAVED_SEARCH_MAX_PER_EMAIL) {
        return res.status(400).json({
          error: `This email already has ${SAVED_SEARCH_MAX_PER_EMAIL} active alerts. Stop one using the link at the bottom of any alert email, then try again.`
        });
      }

      const search = await SavedSearch.create({
        email,
        criteria,
        summary: describeSavedSearch(criteria),
        token: crypto.randomBytes(32).toString('hex'),
        // Baseline: everything that matches today counts as already seen, so
        // the first alert is only ever about a genuinely new listing.
        sentPropertyIds: matching.map(p => String(p._id)),
        vid: vid.slice(0, 64),
        confirmSentAt: new Date()
      });

      const { subject, html } = buildSavedSearchConfirmEmail(search, currentMatches);
      const r = await sendEmail(email, subject, html);
      const ok = !!(r && r.success);
      res.json({
        success: true, emailSent: ok, currentMatches,
        message: ok
          ? 'Check your inbox to confirm.'
          : 'Your search is saved, but we could not send the confirmation email just now. Please try again in a few minutes.'
      });
    } catch (err) {
      console.error('Saved search error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// 2. Confirm (called by alerts.html). Idempotent: a second click just answers.
app.post('/api/saved-search/:token/confirm', publicWriteLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!SAVED_SEARCH_TOKEN_RE.test(token)) return res.status(400).json({ error: 'This link is not valid.' });

    // Atomic: only the request that actually flips it runs the first-time work,
    // so a double click never sends Catherine two lead emails. A search that
    // was stopped before it was ever confirmed stays stopped.
    const flipped = await SavedSearch.findOneAndUpdate(
      { token, confirmed: false, active: true },
      { $set: { confirmed: true, confirmedAt: new Date() } },
      { new: true }
    );
    const search = flipped || await SavedSearch.findOne({ token });
    if (!search) return res.status(404).json({ error: 'We could not find this alert. It may have been removed.' });

    if (flipped) {
      const email = search.email;
      try {
        await Subscriber.updateOne(
          { email },
          { $setOnInsert: { email, source: 'saved_search', preferences: { priceDrops: true } } },
          { upsert: true }
        );
      } catch (e) {
        // A duplicate-key race means the subscriber already exists: fine.
        if (e.code !== 11000) console.error('Saved search subscriber upsert failed:', e.message);
      }
      await ingestLead({ kind: 'saved_search', refId: search._id, email, vid: search.vid, label: 'Saved a search: ' + (search.summary || ''),
        hints: hintsFromCriteria(search.criteria), consent: 'Confirmed a Property Finder email alert' });
      // Tie this browser's calculator history to the address only now that the
      // owner of the address has proved it is theirs.
      await stitchCalcIdentity(search.vid, email);

      let currentMatches = 0;
      try {
        const listings = await loadSavedSearchListings();
        currentMatches = listings.filter(p => savedSearchMatches(p, search.criteria)).length;
      } catch (e) { /* the lead email still goes out without the count */ }

      const c = search.criteria || {};
      const who = c.category === 'FOR LEASE' ? 'A tenant' : c.category === 'FOR SALE' ? 'A buyer' : 'A client';
      const when = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'short' });
      const row = 'padding: 8px 0; border-bottom: 1px solid #e8e8e0;';
      const leadHtml = getEmailHeader() + `
        <h2 style="color: #ff3d00; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 20px; margin: 0 0 15px 0;">New Property Finder lead</h2>
        <p style="${SS_P}">${who} is looking for:</p>
        <div style="${SS_BOX}">
          <p style="margin: 0; font-weight: 600; color: #0a0a0a;">${esc(search.summary)}</p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
          <tr><td style="${row} font-weight: 600; width: 140px;">Email</td><td style="${row}"><a href="mailto:${esc(email)}" style="color: #0a0a0a;">${esc(email)}</a></td></tr>
          <tr><td style="${row} font-weight: 600;">Matches right now</td><td style="${row}">${currentMatches}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 600;">Confirmed</td><td style="padding: 8px 0;">${esc(when)}</td></tr>
        </table>
        <p style="margin: 20px 0;"><a href="${esc(savedSearchBrowseUrl(c))}" style="${SS_BTN}">See the current matches</a></p>
        <p style="${SS_P}">They will be emailed automatically when a new listing matches. A quick personal note from you now is usually the best follow-up.</p>
      ` + getEmailFooter();
      sendEmail('glrarealty@gmail.com', `Property Finder lead: ${oneLine(search.summary, 110)}`, leadHtml)
        .catch(e => console.error('Saved search lead email failed:', e.message));
    }

    // Masked like the manage view: a forwarded link should not hand the address on.
    res.json({ success: true, summary: search.summary, email: maskEmail(search.email), confirmed: !!search.confirmed, active: !!search.active });
  } catch (err) {
    console.error('Saved search confirm error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. What the manage page shows. Never the full address, never other searches.
app.get('/api/saved-search/:token', trackLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!SAVED_SEARCH_TOKEN_RE.test(token)) return res.status(400).json({ error: 'This link is not valid.' });
    const s = await SavedSearch.findOne({ token }).select('email criteria summary confirmed active emailsSent').lean();
    if (!s) return res.status(404).json({ error: 'We could not find this alert. It may have been removed.' });
    res.set('Cache-Control', 'no-store');
    res.json({
      summary: s.summary,
      criteria: s.criteria,
      emailMasked: maskEmail(s.email),
      confirmed: !!s.confirmed,
      active: !!s.active,
      emailsSent: s.emailsSent || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 4. Stop. Idempotent.
app.post('/api/saved-search/:token/unsubscribe', publicWriteLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!SAVED_SEARCH_TOKEN_RE.test(token)) return res.status(400).json({ error: 'This link is not valid.' });
    const s = await SavedSearch.findOneAndUpdate({ token }, { $set: { active: false } }, { new: true })
      .select('summary active').lean();
    if (!s) return res.status(404).json({ error: 'We could not find this alert. It may have been removed.' });
    res.json({ success: true, summary: s.summary, active: false });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN LOGIN ============

app.post('/api/admin/login',
  loginLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 1, max: 200 }),
  handleValidation,
  async (req, res) => {
    const { email, password } = req.body;
    try {
      const account = await Account.findOne({ email, isActive: true });
      if (!account) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const ok = await account.comparePassword(password);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // Self-service signups sit in the approval queue until an admin lets them in.
      if (account.status === 'pending') {
        return res.status(403).json({ error: 'Your account is waiting for admin approval. You\'ll be able to sign in once it\'s approved.' });
      }

      // ── Login alert (admin accounts only) ─────────────────────────────
      // If this ip+device combo isn't in the account's recent login history,
      // email the account owner. First-ever login just seeds the history.
      if (account.role === 'admin') {
        try {
          const ip = req.ip || req.connection?.remoteAddress || '';
          const ua = String(req.headers['user-agent'] || '').slice(0, 300);
          const history = Array.isArray(account.loginHistory) ? account.loginHistory : [];
          const known = history.some(h => h.ip === ip && h.ua === ua);
          const firstLogin = history.length === 0;
          account.loginHistory = [{ ip, ua, at: new Date() }, ...history.filter(h => !(h.ip === ip && h.ua === ua))].slice(0, 10);
          if (!known && !firstLogin) {
            const when = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'short' });
            sendEmail(account.email, '🔐 New sign-in to your GLRA admin account',
              getEmailHeader() + `
              <h2 style="color:#0a1628;">New Sign-In Detected</h2>
              <p>Your GLRA admin account (<strong>${account.email}</strong>) was just used to sign in from a device or location we haven't seen recently:</p>
              <table style="font-size:14px;line-height:1.8">
                <tr><td style="padding-right:12px;color:#666">When:</td><td><strong>${when}</strong> (Philippine time)</td></tr>
                <!-- The User-Agent is attacker-controlled input; escape it so a
                     crafted header cannot inject markup into this alert email. -->
                <tr><td style="padding-right:12px;color:#666">IP address:</td><td><strong>${esc(ip) || 'unknown'}</strong></td></tr>
                <tr><td style="padding-right:12px;color:#666">Device:</td><td>${esc(ua) || 'unknown'}</td></tr>
              </table>
              <p style="margin-top:16px"><strong>Was this you?</strong> If yes, you can ignore this email. If not, reset your password immediately using the "Forgot password" link on the admin sign-in page.</p>
            ` + getEmailFooter()).catch(err => console.error('Login alert email failed:', err.message));
          }
        } catch (e) { console.error('Login alert error:', e.message); }
      }

      account.lastLogin = new Date();
      await account.save();

      const token = signToken(account);
      // Log audit (synthetically pass user via req.user)
      req.user = { email: account.email, name: account.name, role: account.role };
      await logAudit(req, 'LOGIN', 'Session', '', '', null);

      // Compute effective permissions: admins always get all, everyone else gets
      // their stored object layered over their ROLE's defaults so any permission
      // key added AFTER the account was created falls back to its sensible
      // default instead of reading as undefined/false. (Agents' defaults are
      // all-false — their access is the /api/agent/* routes, not permissions.)
      const effectivePerms = account.role === 'admin'
        ? defaultPermissionsForRole('admin')
        : { ...defaultPermissionsForRole(account.role), ...(account.permissions || {}) };

      res.json({
        success: true,
        token,
        role: account.role,
        name: account.name,
        email: account.email,
        id: account._id,
        permissions: effectivePerms
      });
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ============ EMPLOYEE SELF-SIGNUP (public, rate-limited) ============
// Creates an account in 'pending' status with ZERO permissions. The account
// cannot log in until an admin approves it from the Accounts tab (choosing
// role + permissions at that moment). Role is always forced to 'employee' —
// nobody can sign themselves up as an admin.
app.post('/api/admin/signup',
  signupLimiter,
  body('name').isString().trim().isLength({ min: 2, max: 200 }).withMessage('Please enter your full name'),
  body('email').isEmail().normalizeEmail().withMessage('Please enter a valid email'),
  body('password').isString().isLength({ min: 8, max: 200 }).withMessage('Password must be at least 8 characters'),
  // Where the request came from: 'agent' when it's the Agent Workspace signup.
  // Informational only — the account is still created as a zero-permission
  // pending employee; the admin picks the real role on the approval screen.
  body('requestedRole').optional().isIn(['employee', 'agent']),
  handleValidation,
  async (req, res) => {
    const { name, email, password } = req.body;
    const requestedRole = req.body.requestedRole === 'agent' ? 'agent' : 'employee';
    try {
      const existing = await Account.findOne({ email }).lean();
      if (existing) {
        // Don't leak whether the account is pending/active — same message either way.
        return res.status(400).json({ error: 'An account with this email already exists. If you just signed up, please wait for admin approval.' });
      }
      // Zero permissions until approval — the admin picks them on the approval screen.
      const noPerms = {};
      PERMISSION_KEYS.forEach(k => { noPerms[k] = false; });
      const account = await Account.create({
        email, password, name,
        role: 'employee',
        requestedRole,
        status: 'pending',
        permissions: noPerms
      });
      req.user = { email: account.email, name: account.name, role: 'employee' };
      await logAudit(req, 'SIGNUP', 'Account', account._id, email, { status: 'pending', requestedRole });

      // Best-effort heads-up to the admin inbox — signup still succeeds if email fails.
      try {
        await sendEmail('glrarealty@gmail.com', `New ${requestedRole === 'agent' ? 'AGENT' : 'account'} request: ${name}`,
          getEmailHeader() + `
          <h2 style="color:#0a1628;">New ${requestedRole === 'agent' ? 'Agent' : 'Account'} Request</h2>
          <!-- esc(): name is free text from a public, unauthenticated signup form.
               Unescaped it renders as HTML in the admin's inbox, which is a
               ready-made phishing surface (a fake "Approve" link). -->
          <p><strong>${esc(name)}</strong> (${esc(email)}) has requested access to the ${requestedRole === 'agent' ? 'GLRA <strong>Agent Workspace</strong>' : 'GLRA admin portal'}.</p>
          <p>They cannot log in until you approve them. Open the <strong>Admin Portal → Accounts</strong> tab to approve or decline${requestedRole === 'agent' ? ' — choose the <strong>Agent</strong> role when approving' : ', and to choose exactly what they can access'}.</p>
        ` + getEmailFooter());
      } catch (e) { console.error('Signup notification email failed:', e.message); }

      res.json({ success: true, message: 'Request sent! You\'ll be able to sign in once the admin approves your account.' });
    } catch (e) {
      if (e.code === 11000) return res.status(400).json({ error: 'An account with this email already exists.' });
      console.error('Signup error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ============ FORGOT / RESET PASSWORD (public, rate-limited) ============
// Standard token flow: we email a one-time link containing a random token,
// store only its SHA-256 hash, and expire it after 30 minutes. The response
// is identical whether or not the email exists (no account probing).
app.post('/api/admin/forgot-password',
  resetLimiter,
  body('email').isEmail().normalizeEmail(),
  handleValidation,
  async (req, res) => {
    const generic = { success: true, message: 'If that email has an account, a reset link is on its way. Check your inbox (and spam folder).' };
    try {
      const account = await Account.findOne({ email: req.body.email, isActive: true });
      if (!account || account.status === 'pending') return res.json(generic);

      const token = crypto.randomBytes(32).toString('hex');
      account.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
      account.resetTokenExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
      await account.save();

      const link = `${SITE_URL}/admin.html?reset=${token}`;
      try {
        await sendEmail(account.email, 'Reset your GLRA admin password',
          getEmailHeader() + `
          <h2 style="color:#0a1628;">Password Reset</h2>
          <p>Hi ${account.name || 'there'},</p>
          <p>Someone (hopefully you) asked to reset the password for <strong>${account.email}</strong> on the GLRA admin portal.</p>
          <p style="margin:24px 0"><a href="${link}" style="background-color:#ff3d00;color:#ffffff;padding:12px 24px;text-decoration:none;display:inline-block;font-weight:600">Choose a New Password</a></p>
          <p style="font-size:13px;color:#666">This link works for <strong>30 minutes</strong> and can be used once. If you didn't ask for this, you can safely ignore this email — your password stays the same.</p>
        ` + getEmailFooter());
      } catch (e) { console.error('Reset email failed:', e.message); }

      req.user = { email: account.email, name: account.name, role: account.role };
      await logAudit(req, 'PASSWORD_RESET_REQUEST', 'Account', account._id, account.email, null);
      res.json(generic);
    } catch (e) {
      console.error('Forgot-password error:', e);
      res.json(generic); // stay generic even on server error
    }
  }
);

app.post('/api/admin/reset-password',
  resetLimiter,
  body('token').isString().isLength({ min: 32, max: 128 }),
  body('password').isString().isLength({ min: 8, max: 200 }),
  handleValidation,
  async (req, res) => {
    try {
      const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
      const account = await Account.findOne({ resetTokenHash: tokenHash, resetTokenExpires: { $gt: new Date() } });
      if (!account) {
        return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one from the sign-in page.' });
      }
      account.password = req.body.password; // hashed by the pre-save hook
      account.resetTokenHash = null;
      account.resetTokenExpires = null;
      await account.save();

      req.user = { email: account.email, name: account.name, role: account.role };
      await logAudit(req, 'PASSWORD_RESET', 'Account', account._id, account.email, null);

      // Heads-up email so the owner knows the password changed (best-effort).
      try {
        await sendEmail(account.email, 'Your GLRA admin password was changed',
          getEmailHeader() + `
          <h2 style="color:#0a1628;">Password Changed</h2>
          <p>The password for <strong>${account.email}</strong> was just changed using a reset link.</p>
          <p>If this wasn't you, contact your administrator immediately.</p>
        ` + getEmailFooter());
      } catch (e) { console.error('Reset confirmation email failed:', e.message); }

      res.json({ success: true, message: 'Password updated! You can now sign in with your new password.' });
    } catch (e) {
      console.error('Reset-password error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ============ PROTECTED ADMIN ROUTES ============
// All routes below require a valid JWT.

app.get('/api/admin/me', verifyToken, async (req, res) => {
  try {
    const account = await Account.findById(req.user.sub).select('email name role permissions isActive status').lean();
    if (!account || account.isActive === false || account.status === 'pending') {
      return res.status(401).json({ error: 'Account inactive' });
    }
    const effectivePerms = account.role === 'admin'
      ? defaultPermissionsForRole('admin')
      : { ...defaultPermissionsForRole('employee'), ...(account.permissions || {}) };
    res.json({
      id: String(account._id),
      email: account.email,
      name: account.name,
      role: account.role,
      permissions: effectivePerms
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/logout', verifyToken, async (req, res) => {
  await logAudit(req, 'LOGOUT', 'Session', '', '', null);
  res.json({ success: true });
});

app.get('/api/admin/accounts', verifyToken, requireAdmin, async (req, res) => {
  try {
    // resetTokenHash / resetTokenExpires are password-reset plumbing and
    // loginHistory is a list of colleagues' IP addresses and devices. None of
    // the three is shown anywhere in the dashboard, so none should leave the
    // server.
    const accounts = await Account.find({},
      { password: 0, resetTokenHash: 0, resetTokenExpires: 0, loginHistory: 0 })
      .sort({ createdAt: 1 });
    res.json(accounts);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Helper: take a raw permissions object from the request and only keep known keys (boolean coerced).
function sanitizePermissions(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  PERMISSION_KEYS.forEach(k => {
    if (k in input) out[k] = input[k] === true;
  });
  return out;
}

app.post('/api/admin/accounts',
  verifyToken, requireAdmin,
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 8, max: 200 }),
  body('name').optional().isString().trim().isLength({ max: 200 }),
  body('role').optional().isIn(['admin', 'employee']),
  body('permissions').optional().isObject(),
  handleValidation,
  async (req, res) => {
    const { email, password, name, role, permissions } = req.body;
    try {
      const finalRole = role || 'employee';
      // Merge defaults with whatever the admin specified (admin's choices win)
      const finalPerms = { ...defaultPermissionsForRole(finalRole), ...sanitizePermissions(permissions) };
      const account = await Account.create({
        email, password,
        name: name || email.split('@')[0],
        role: finalRole,
        permissions: finalPerms
      });
      await logAudit(req, 'CREATE', 'Account', account._id, email, { role: finalRole, permissions: finalPerms });
      res.json({ success: true, account: { email: account.email, name: account.name, role: account.role, permissions: account.permissions, _id: account._id } });
    } catch (e) {
      if (e.code === 11000) return res.status(400).json({ error: 'Email already exists' });
      res.status(500).json({ error: 'Server error' });
    }
  }
);

app.put('/api/admin/accounts/:id',
  verifyToken, requireAdmin,
  body('email').optional().isEmail().normalizeEmail(),
  body('password').optional().isString().isLength({ min: 8, max: 200 }),
  body('name').optional().isString().trim().isLength({ max: 200 }),
  body('role').optional().isIn(['admin', 'employee']),
  body('isActive').optional().isBoolean(),
  body('permissions').optional().isObject(),
  handleValidation,
  async (req, res) => {
    const { email, password, name, role, isActive, permissions } = req.body;
    try {
      const before = await Account.findById(req.params.id, { password: 0 });
      if (!before) return res.status(404).json({ error: 'Account not found' });

      const update = {};
      if (email) update.email = email;
      if (password) update.password = password; // hashed by pre-update hook
      if (name) update.name = name;
      if (role) update.role = role;
      if (isActive !== undefined) update.isActive = isActive;
      if (permissions) {
        // Merge: keep current values for any keys not in the request
        update.permissions = { ...(before.permissions || defaultPermissionsForRole(before.role)), ...sanitizePermissions(permissions) };
      }

      const account = await Account.findByIdAndUpdate(req.params.id, update, { new: true, select: '-password' });
      await logAudit(req, 'UPDATE', 'Account', req.params.id, account.email, {
        before,
        after: { ...update, password: password ? '[REDACTED]' : undefined }
      });
      res.json({ success: true, account });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
  }
);

app.delete('/api/admin/accounts/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const account = await Account.findByIdAndDelete(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await logAudit(req, 'DELETE', 'Account', req.params.id, account.email, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── SIGNUP APPROVAL ────────────────────────────────────────
// Approve a pending signup: admin chooses role + exact permissions here.
app.post('/api/admin/accounts/:id/approve',
  verifyToken, requireAdmin,
  body('role').optional().isIn(['admin', 'employee', 'agent']),
  body('permissions').optional().isObject(),
  handleValidation,
  async (req, res) => {
    try {
      const account = await Account.findById(req.params.id);
      if (!account) return res.status(404).json({ error: 'Account not found' });
      if (account.status !== 'pending') return res.status(400).json({ error: 'This account is not pending approval.' });

      const finalRole = req.body.role || 'employee';
      // What the admin ticked on the approval screen wins; anything they left out falls back to role defaults.
      const finalPerms = { ...defaultPermissionsForRole(finalRole), ...sanitizePermissions(req.body.permissions) };
      account.role = finalRole;
      account.permissions = finalPerms;
      account.status = 'active';
      account.isActive = true;
      await account.save();

      await logAudit(req, 'APPROVE', 'Account', account._id, account.email, { role: finalRole, permissions: finalPerms });

      // Tell them they're in (best-effort) — agents get pointed at their own door.
      try {
        const isAgent = finalRole === 'agent';
        await sendEmail(account.email, `Your GLRA ${isAgent ? 'Agent Workspace' : 'admin'} account has been approved`,
          getEmailHeader() + `
          <h2 style="color:#0a1628;">You're In! 🎉</h2>
          <p>Hi ${account.name || 'there'},</p>
          <p>Your account request has been <strong>approved</strong>. You can now sign in with the email and password you registered with.</p>
          ${isAgent ? `<p><a href="https://glrarealty.com/agent.html" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:12px 24px;text-decoration:none;font-weight:600">Open the Agent Workspace</a></p>` : ''}
        ` + getEmailFooter());
      } catch (e) { console.error('Approval email failed:', e.message); }

      res.json({ success: true, account: { _id: account._id, email: account.email, name: account.name, role: account.role, status: account.status, permissions: account.permissions } });
    } catch (e) {
      console.error('Approve error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Decline a pending signup: removes the request entirely (they can sign up again).
app.post('/api/admin/accounts/:id/decline', verifyToken, requireAdmin, async (req, res) => {
  try {
    const account = await Account.findOne({ _id: req.params.id, status: 'pending' });
    if (!account) return res.status(404).json({ error: 'Pending account not found' });
    await Account.deleteOne({ _id: account._id });
    await logAudit(req, 'DECLINE', 'Account', req.params.id, account.email, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── FULL DATA BACKUP (admin only) ──────────────────────────
// Returns every collection as JSON in one response. The admin UI turns this
// into a multi-sheet Excel file and/or saves the raw JSON. Passwords and
// reset tokens are never included.
app.get('/api/admin/backup', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [
      properties, inquiries, heroImages, subscribers, priceAlerts, savedSearches, wishlists,
      accounts, tasks, submissions, scheduledEmails, titlingCases, notarialJobs,
      cashEntries, auditLogs, alertLogs
    ] = await Promise.all([
      Property.find().lean(),
      Inquiry.find().lean(),
      HeroImage.find().lean(),
      Subscriber.find().lean(),
      PriceAlert.find().lean(),
      // The token is the visitor's key to their manage/unsubscribe page, so it
      // is left out like the password reset tokens are.
      SavedSearch.find().select('-token').lean(),
      Wishlist.find().lean(),
      Account.find().select('-password -resetTokenHash -resetTokenExpires').lean(),
      Task.find().lean(),
      PropertySubmission.find().lean(),
      ScheduledEmail.find().lean(),
      TitlingCase.find().lean(),
      NotarialJob.find().lean(),
      CashEntry.find().lean(),
      AuditLog.find().sort({ timestamp: -1 }).limit(5000).lean(),
      AlertLog.find().sort({ createdAt: -1 }).limit(5000).lean()
    ]);
    const collections = {
      properties, inquiries, heroImages, subscribers, priceAlerts, savedSearches, wishlists,
      accounts, tasks, submissions, scheduledEmails, titlingCases, notarialJobs,
      cashEntries, auditLogs, alertLogs
    };
    const counts = {};
    let total = 0;
    Object.entries(collections).forEach(([k, v]) => { counts[k] = v.length; total += v.length; });
    await logAudit(req, 'BACKUP', 'System', '', `${total} records across ${Object.keys(collections).length} collections`, counts);
    res.json({ generatedAt: new Date().toISOString(), site: SITE_URL, counts, collections });
  } catch (e) {
    console.error('Backup error:', e);
    res.status(500).json({ error: 'Backup failed' });
  }
});

app.get('/api/admin/audit-log', verifyToken, requirePermission('audit_view'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(limit);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Quick stats for the audit dashboard
app.get('/api/admin/audit-stats', verifyToken, requirePermission('audit_view'), async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOf7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [todayCount, weekCount, totalCount, byUser, byAction] = await Promise.all([
      AuditLog.countDocuments({ timestamp: { $gte: startOfToday } }),
      AuditLog.countDocuments({ timestamp: { $gte: startOf7d } }),
      AuditLog.countDocuments(),
      AuditLog.aggregate([
        { $match: { timestamp: { $gte: startOf7d } } },
        { $group: { _id: { actor: '$actor', actorName: '$actorName', actorRole: '$actorRole' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      AuditLog.aggregate([
        { $match: { timestamp: { $gte: startOf7d } } },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    res.json({ todayCount, weekCount, totalCount, byUser, byAction });
  } catch (e) {
    console.error('Audit stats error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/stats', verifyToken, async (req, res) => {
  try {
    const totalProperties = await Property.countDocuments();
    const availableProperties = await Property.countDocuments({ status: 'available' });
    const totalInquiries = await Inquiry.countDocuments();
    const heroImages = await HeroImage.countDocuments();
    const subscribers = await Subscriber.countDocuments({ isActive: true });
    const activeAlerts = await PriceAlert.countDocuments({ isNotified: false });
    const wishlistCount = await Wishlist.countDocuments();

    res.json({ totalProperties, availableProperties, totalInquiries, heroImages, subscribers, activeAlerts, wishlistCount });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DASHBOARD ANALYTICS: website visitors (self-hosted counter) ──
// Admin-level insight — gated behind dashboard_analytics (admins always pass).
// Returns a 30-day daily page-view series plus today + all-time totals.
app.get('/api/admin/analytics', verifyToken, requirePermission('dashboard_analytics'), async (req, res) => {
  try {
    const now = new Date();
    const dayStr = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); days.push(dayStr(d)); }
    const rows = await SiteStat.find({ day: { $in: days } }).lean();
    const map = {};
    rows.forEach(r => { map[r.day] = r.views || 0; });
    const series = days.map(day => ({ day, views: map[day] || 0 }));
    const today = map[dayStr(now)] || 0;
    const totalAgg = await SiteStat.aggregate([{ $group: { _id: null, total: { $sum: '$views' } } }]);
    const total = (totalAgg[0] && totalAgg[0].total) || 0;

    // Roll the per-day page/referrer maps up across the same 30-day window.
    // .lean() hands these back as plain objects rather than Mongoose Maps.
    const rollUp = field => {
      const acc = {};
      rows.forEach(r => {
        const m = r[field] || {};
        Object.keys(m).forEach(k => { acc[k] = (acc[k] || 0) + (m[k] || 0); });
      });
      return Object.entries(acc)
        .sort((a, b) => b[1] - a[1])
        .map(([key, views]) => ({ key, views }));
    };
    const topPages = rollUp('pages').slice(0, 12);
    const topRefs = rollUp('refs').slice(0, 8);

    res.json({ series, today, total, topPages, topRefs });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DASHBOARD ANALYTICS: team activity / who's online ──
// Returns non-pending accounts with lastSeen/lastLogin so the dashboard can show
// online / idle / offline. Gated behind dashboard_analytics (admins always pass).
app.get('/api/admin/presence', verifyToken, requirePermission('dashboard_analytics'), async (req, res) => {
  try {
    const accounts = await Account.find({ status: { $ne: 'pending' } })
      .select('name email role lastSeen lastLogin isActive')
      .sort({ name: 1 })
      .lean();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Each subscriber comes back with their calculator history attached:
//   calcUsage — [{ calc, label, count, last }] sorted most-used first
//   calcTotal — total engagements across every tool
//   calcLast  — when they last touched any calculator
// Rows stay empty for people who signed up before tracking existed, or who
// have never opened a calculator on a browser we've tied to their email.
app.get('/api/admin/subscribers', verifyToken, async (req, res) => {
  try {
    const subscribers = await Subscriber.find().sort({ subscribedAt: -1 }).lean();

    const usage = await CalcUsage.aggregate([
      { $match: { email: { $ne: null } } },
      { $group: {
          _id:   { email: '$email', calc: '$calc' },
          label: { $last: '$label' },
          count: { $sum: 1 },
          last:  { $max: '$createdAt' }
      } }
    ]);

    const byEmail = {};
    usage.forEach(u => {
      const list = byEmail[u._id.email] || (byEmail[u._id.email] = []);
      list.push({ calc: u._id.calc, label: u.label || u._id.calc, count: u.count, last: u.last });
    });

    subscribers.forEach(s => {
      const list = (byEmail[s.email] || []).sort((a, b) => b.count - a.count);
      s.calcUsage = list;
      s.calcTotal = list.reduce((n, x) => n + x.count, 0);
      s.calcLast  = list.length ? new Date(Math.max.apply(null, list.map(x => new Date(x.last)))) : null;
      // The raw browser ids are an internal join key — no reason to ship them to the client.
      delete s.vids;
    });

    res.json(subscribers);
  } catch (err) {
    console.error('Subscribers load error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Site-wide calculator usage — includes anonymous visitors, so this is useful
// from day one even before anyone has been matched to an email.
app.get('/api/admin/calculator-stats', verifyToken, async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [totals, recent, identified] = await Promise.all([
      CalcUsage.aggregate([
        { $group: {
            _id: '$calc',
            label: { $last: '$label' },
            count: { $sum: 1 },
            people: { $addToSet: '$vid' },
            last: { $max: '$createdAt' }
        } },
        { $project: { calc: '$_id', label: 1, count: 1, last: 1, people: { $size: '$people' }, _id: 0 } },
        { $sort: { count: -1 } }
      ]),
      CalcUsage.countDocuments({ createdAt: { $gte: since } }),
      CalcUsage.countDocuments({ email: { $ne: null } })
    ]);

    const total = totals.reduce((n, t) => n + t.count, 0);
    res.json({ totals, total, last30: recent, identified, anonymous: total - identified });
  } catch (err) {
    console.error('Calc stats error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/price-alerts', verifyToken, async (req, res) => {
  try {
    const alerts = await PriceAlert.find().sort({ createdAt: -1 });
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Property Finder saved searches, newest first. Without the token: that is
// the visitor's own key and staff never need it.
app.get('/api/admin/saved-searches', verifyToken, async (req, res) => {
  try {
    const searches = await SavedSearch.find().select('-token').sort({ createdAt: -1 }).lean();
    res.json(searches);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/wishlist', verifyToken, async (req, res) => {
  try {
    const wishlist = await Wishlist.find().sort({ addedAt: -1 });
    res.json(wishlist);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/alert-logs', verifyToken, async (req, res) => {
  try {
    const logs = await AlertLog.find().sort({ sentAt: -1 }).limit(50);
    res.json(logs);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Fields on a listing that belong to the brokerage rather than to whoever is
// signed in: what GLRA earns on the deal, and the free-text `notes` box, which
// on any listing imported from a "List your property" submission holds the
// owner's name, mobile number and email address.
const OWNER_ONLY_PROPERTY_FIELDS = ['commission', 'fixedAmount', 'totalCommission', 'notes'];

app.get('/api/admin/all-properties', verifyToken, async (req, res) => {
  try {
    const q = Property.find().sort({ createdAt: -1 });
    if (req.user.role !== 'admin') OWNER_ONLY_PROPERTY_FIELDS.forEach(f => q.select('-' + f));
    const properties = await q;
    res.json(properties);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/inquiries', verifyToken, async (req, res) => {
  try {
    const inquiries = await Inquiry.find().sort({ createdAt: -1 });
    res.json(inquiries);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Mark an inquiry handled / not-handled. Any logged-in staff member can do this
// (it's a workflow flag, not a destructive action). Body: { handled: true|false }.
app.patch('/api/admin/inquiries/:id', verifyToken, async (req, res) => {
  try {
    const handled = !!(req.body && req.body.handled);
    const update = handled
      ? { handled: true, handledAt: new Date(), handledBy: req.user?.name || req.user?.email || '' }
      : { handled: false, handledAt: null, handledBy: '' };
    const inquiry = await Inquiry.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!inquiry) return res.status(404).json({ error: 'Not found' });
    await logAudit(req, handled ? 'INQUIRY_HANDLED' : 'INQUIRY_REOPENED', 'Inquiry', req.params.id, inquiry.email, null);
    res.json({ success: true, handled: inquiry.handled });
  } catch (err) {
    console.error('update inquiry error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// A mongoose ValidationError or CastError is the person's typing, not the
// server falling over: "10,5M" in the price box, a required field left blank.
// Answer with the field that is wrong so the dashboard can say which one.
function schemaProblem(err) {
  if (!err) return null;
  if (err.name === 'CastError') {
    return `"${err.value}" is not a valid ${err.kind === 'Number' ? 'number' : err.kind} for ${err.path}.`;
  }
  if (err.name === 'ValidationError') {
    const parts = Object.values(err.errors || {}).map(e =>
      e.name === 'CastError'
        ? `${e.path} must be a ${e.kind === 'Number' ? 'number' : e.kind}`
        : (e.message || `${e.path} is invalid`));
    return parts.length ? parts.join('; ') : 'Some fields are invalid.';
  }
  return null;
}

// Fields a listing form may set. The brokerage's economics (commission and
// its totals) are admin-only to read, so they are admin-only to write too, and
// nobody sets views, createdAt or the price history by hand.
const ADMIN_ONLY_PROPERTY_FIELDS = ['commission', 'fixedAmount', 'totalCommission'];
// geo and nearby belong to the location worker. The edit form round-trips the
// whole listing, so without this every save would write back a stale copy.
const SYSTEM_PROPERTY_FIELDS = ['_id', '__v', 'views', 'createdAt', 'previousPrice', 'priceUpdatedAt', 'geo', 'nearby', 'hazard', 'editedAt', 'reviewedAt'];
function stripPrivilegedPropertyFields(body, req) {
  const out = { ...(body && typeof body === 'object' ? body : {}) };
  SYSTEM_PROPERTY_FIELDS.forEach(k => delete out[k]);
  if (!(req.user && req.user.role === 'admin')) ADMIN_ONLY_PROPERTY_FIELDS.forEach(k => delete out[k]);
  if (typeof out.propertyType === 'string') out.propertyType = out.propertyType.trim();
  if (out.facing !== undefined) out.facing = /^(N|NE|E|SE|S|SW|W|NW)$/.test(String(out.facing)) ? String(out.facing) : '';
  // Photo links only: these end up in <img src> and og:image on public pages.
  ['coverImage', 'floorPlan'].forEach(k => {
    if (out[k] !== undefined) out[k] = /^https:\/\/res\.cloudinary\.com\//.test(String(out[k])) ? String(out[k]).slice(0, 2000) : '';
  });
  if (out.webSummary !== undefined) out.webSummary = String(out.webSummary || '').trim().slice(0, 1200);
  return out;
}

app.post('/api/admin/properties', verifyToken, requirePermission('properties_create'), async (req, res) => {
  try {
    const property = new Property(stripPrivilegedPropertyFields(req.body, req));
    await property.save();
    await logAudit(req, 'CREATE', 'Property', property._id, property.title, null);
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
    scheduleSavedSearchSweep();
    scheduleGeoPass();
    res.json(property);
  } catch (err) {
    const why = schemaProblem(err);
    if (why) return res.status(400).json({ error: why });
    console.error('Add property error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/properties/:id', verifyToken, requirePermission('properties_edit'), async (req, res) => {
  try {
    const oldProperty = await Property.findById(req.params.id);
    if (!oldProperty) return res.status(404).json({ error: 'Property not found' });
    const updatedData = stripPrivilegedPropertyFields(req.body, req);
    updatedData.editedAt = new Date();

    // A price must be a real non-negative number. A blank box or "10.5M" used
    // to arrive as 0 or 10.5 and was treated as a price DROP: every watcher was
    // emailed "New Price: P0" and then never alerted again.
    if (updatedData.price !== undefined) {
      const n = Number(updatedData.price);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'The price must be a number (no letters or peso signs).' });
      updatedData.price = n;
    }
    let dropAlerts = null;
    if (updatedData.price !== undefined && updatedData.price > 0 && updatedData.price < oldProperty.price) {
      updatedData.previousPrice = oldProperty.price;
      updatedData.priceUpdatedAt = new Date();
      console.log(`💰 Price drop: ${oldProperty.title}: ₱${oldProperty.price.toLocaleString()} → ₱${updatedData.price.toLocaleString()}`);

      // Everyone watching at a price above the new one: a watcher alerted at an
      // earlier drop is alerted again at the next one, instead of never.
      const alerts = await PriceAlert.find({ propertyId: req.params.id, propertyPrice: { $gt: updatedData.price } });
      if (alerts.length > 0) dropAlerts = async () => {
        for (const alert of alerts) {
          const priceDropHtml = getEmailHeader() + `
            <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">Price Drop Alert</h2>
            <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
            <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Good news! The price has dropped for a property you are watching:</p>
            <div style="background-color: #e8e4dd; border-left: 3px solid #ff3d00; padding: 18px 20px; margin: 25px 0; border-radius:0;">
              <p style="margin: 0 0 8px 0; font-weight: 600; color: #0a0a0a;">${esc(oldProperty.title)}</p>
              <p style="margin: 0 0 5px 0; color: #0a0a0a; font-size: 13px;">📍 ${esc(oldProperty.location)}</p>
              <p style="margin: 0 0 5px 0; color: #6a6a6a; font-size: 14px; text-decoration: line-through;">Previous Price: ₱${oldProperty.price.toLocaleString()}</p>
              <p style="margin: 0; color: #10b981; font-weight: 700; font-size: 18px;">New Price: ₱${Number(updatedData.price).toLocaleString()}</p>
              <p style="margin: 10px 0 0 0; color: #0a0a0a; font-size: 13px;">Savings: ₱${(oldProperty.price - Number(updatedData.price)).toLocaleString()}</p>
            </div>
            <p><a href="https://glrarealty.com/properties.html?property=${encodeURIComponent(req.params.id)}" style="background-color: #ff3d00; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius:0; display: inline-block;">View Property Details</a></p>
            <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
          ` + getEmailFooter();
          const sent = await sendEmail(alert.email, `Price Drop Alert: ${oldProperty.title}`, priceDropHtml);
          if (!sent || !sent.success) continue;

          alert.isNotified = true;
          alert.notifiedAt = new Date();
          alert.propertyPrice = Number(updatedData.price);
          await alert.save();
        }

        await AlertLog.create({
          type: 'price_drop',
          propertyId: req.params.id,
          propertyTitle: oldProperty.title,
          oldPrice: oldProperty.price,
          newPrice: updatedData.price,
          sentTo: alerts.length
        });
      };
    }

    const property = await Property.findByIdAndUpdate(req.params.id, updatedData, { new: true });
    // Only now that the new price is actually saved, and without holding up
    // the save: one Brevo round trip per watcher used to happen in the request.
    if (dropAlerts) dropAlerts().catch(e => console.error('Price-drop alerts failed:', e.message));
    await logAudit(req, 'UPDATE', 'Property', req.params.id, property.title, null);
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
    scheduleSavedSearchSweep();
    scheduleGeoPass();
    res.json(property);
  } catch (err) {
    const why = schemaProblem(err);
    if (why) return res.status(400).json({ error: why });
    console.error('Error updating property:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// "Still available": staff confirm an old listing is still on the market
// without editing it, which clears it from the dashboard's stale list.
app.post('/api/admin/properties/:id/reviewed', verifyToken, requirePermission('properties_edit'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Property not found' });
    const property = await Property.findByIdAndUpdate(req.params.id, { $set: { reviewedAt: new Date() } }, { new: true, projection: { title: 1, reviewedAt: 1 } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    await logAudit(req, 'UPDATE', 'Property', req.params.id, property.title, { reviewedAt: 'confirmed still available' });
    res.json({ success: true, reviewedAt: property.reviewedAt });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/properties/:id', verifyToken, requirePermission('properties_delete'), async (req, res) => {
  try {
    const property = await Property.findByIdAndDelete(req.params.id);
    if (property) await logAudit(req, 'DELETE', 'Property', req.params.id, property.title, null);
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/inquiries/:id', verifyToken, requirePermission('inquiries_delete'), async (req, res) => {
  try {
    const inquiry = await Inquiry.findByIdAndDelete(req.params.id);
    if (inquiry) await logAudit(req, 'DELETE', 'Inquiry', req.params.id, inquiry.email, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── TITLING CASES (land-title transfer / processing tracker) ──
const TITLING_STATUSES = ['documents', 'bir', 'transfer_tax', 'registry', 'tax_dec', 'completed', 'on_hold', 'lra'];

// Validate + clamp an incoming titling payload. Only known fields pass through.
function sanitizeTitlingBody(b) {
  const out = {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  // optional date: '' / null clears it, a valid date sets it, anything else is ignored
  const setDate = (k) => {
    if (b[k] === undefined) return;
    if (b[k] === '' || b[k] === null) { out[k] = null; return; }
    const d = new Date(b[k]); if (!isNaN(d.getTime())) out[k] = d;
  };
  if (b.branch !== undefined) out.branch = str(b.branch, 80);
  if (b.clientName !== undefined) out.clientName = str(b.clientName, 200);
  if (b.clientPhone !== undefined) out.clientPhone = str(b.clientPhone, 50);
  if (b.clientEmail !== undefined) out.clientEmail = str(b.clientEmail, 120).toLowerCase();
  if (b.titleNumber !== undefined) out.titleNumber = str(b.titleNumber, 100);
  if (b.taxDecNo !== undefined) out.taxDecNo = str(b.taxDecNo, 100);
  if (b.propertyLocation !== undefined) out.propertyLocation = str(b.propertyLocation, 300);
  if (b.propertyType !== undefined) out.propertyType = str(b.propertyType, 60);
  if (b.serviceType !== undefined) out.serviceType = str(b.serviceType, 80);
  if (b.modeOfAcquisition !== undefined) out.modeOfAcquisition = str(b.modeOfAcquisition, 100);
  if (typeof b.status === 'string' && TITLING_STATUSES.includes(b.status)) out.status = b.status;
  // milestone reference numbers
  if (b.carNo !== undefined) out.carNo = str(b.carNo, 100);
  if (b.epebNo !== undefined) out.epebNo = str(b.epebNo, 100);
  if (b.transferredTitleNo !== undefined) out.transferredTitleNo = str(b.transferredTitleNo, 100);
  if (b.transferredTaxDecNo !== undefined) out.transferredTaxDecNo = str(b.transferredTaxDecNo, 100);
  // milestone dates
  ['dateEndorsed', 'dateFiledBIR', 'dateCarReceived', 'dateTransferTax', 'dateFiledRD',
   'dateTitleTransferred', 'dateFiledAO', 'targetDate'].forEach(setDate);
  if (b.lacking !== undefined) out.lacking = String(b.lacking || '').slice(0, 2000);
  if (Array.isArray(b.documents)) {
    out.documents = b.documents.filter(d => typeof d === 'string').map(d => d.slice(0, 120)).slice(0, 40);
  }
  // liquidation line items
  if (Array.isArray(b.payments)) {
    out.payments = b.payments.slice(0, 100).map(p => {
      const row = { label: str(p && p.label, 200), amount: Math.max(0, Number(p && p.amount) || 0), date: null };
      if (p && p.date) { const d = new Date(p.date); if (!isNaN(d.getTime())) row.date = d; }
      return row;
    }).filter(p => p.label || p.amount || p.date);
  }
  if (Array.isArray(b.expenses)) {
    out.expenses = b.expenses.slice(0, 200).map(e => {
      const row = { category: str(e && e.category, 120), payee: str(e && e.payee, 200), amount: Math.max(0, Number(e && e.amount) || 0), date: null };
      if (e && e.date) { const d = new Date(e.date); if (!isNaN(d.getTime())) row.date = d; }
      return row;
    }).filter(e => e.category || e.payee || e.amount || e.date);
  }
  ['serviceFee', 'govFees', 'amountPaid'].forEach(k => {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '') {
      const n = Number(b[k]);
      if (!isNaN(n) && n >= 0) out[k] = n;
    }
  });
  if (b.notes !== undefined) out.notes = String(b.notes || '').slice(0, 5000);
  return out;
}

app.get('/api/admin/titling', verifyToken, requirePermission('titling_view'), async (req, res) => {
  try {
    const cases = await TitlingCase.find().sort({ createdAt: -1 }).lean();
    res.json(cases);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/titling', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const data = sanitizeTitlingBody(req.body || {});
    if (!data.clientName) return res.status(400).json({ error: 'Client name is required' });
    data.createdBy = req.user?.email || '';
    data.createdByName = req.user?.name || '';
    const doc = await TitlingCase.create(data);
    await logAudit(req, 'CREATE', 'TitlingCase', String(doc._id), doc.clientName, null);
    res.json(doc);
  } catch (err) { console.error('titling create error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/titling/:id', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const data = sanitizeTitlingBody(req.body || {});
    if (data.clientName !== undefined && !data.clientName) return res.status(400).json({ error: 'Client name is required' });
    const doc = await TitlingCase.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    await logAudit(req, 'UPDATE', 'TitlingCase', String(doc._id), doc.clientName, null);
    res.json(doc);
  } catch (err) { console.error('titling update error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/titling/:id', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const doc = await TitlingCase.findByIdAndDelete(req.params.id);
    if (doc) await logAudit(req, 'DELETE', 'TitlingCase', String(doc._id), doc.clientName, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Bulk import (from the broker's ACTIVE ACCOUNTS spreadsheet). Skips exact
// duplicates (same client + title no. + location) so re-importing is safe.
app.post('/api/admin/titling/bulk', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected an array' });
    let added = 0, skipped = 0;
    for (const raw of items) {
      const data = sanitizeTitlingBody(raw || {});
      if (!data.clientName) { skipped++; continue; }
      const existing = await TitlingCase.findOne({
        clientName: data.clientName,
        titleNumber: data.titleNumber || '',
        propertyLocation: data.propertyLocation || ''
      });
      if (existing) { skipped++; continue; }
      data.createdBy = req.user?.email || '';
      data.createdByName = req.user?.name || '';
      await TitlingCase.create(data);
      added++;
    }
    await logAudit(req, 'BULK_CREATE', 'TitlingCase', '', `${added} added`, null);
    res.json({ success: true, added, skipped });
  } catch (err) { console.error('titling bulk error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ── NOTARIAL JOBS (Lucena notarial business — documents & clients) ──
function sanitizeNotarialBody(b) {
  const out = {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  if (b.clientName !== undefined) out.clientName = str(b.clientName, 200);
  if (b.clientPhone !== undefined) out.clientPhone = str(b.clientPhone, 50);
  if (b.clientEmail !== undefined) out.clientEmail = str(b.clientEmail, 120).toLowerCase();
  if (b.clientType !== undefined) { const allowed = ['', 'walkin', 'retainer', 'monthly_billing']; out.clientType = allowed.includes(b.clientType) ? b.clientType : ''; }
  if (b.account !== undefined) out.account = str(b.account, 200);
  if (b.status !== undefined) out.status = str(b.status, 40);
  if (b.documentType !== undefined) out.documentType = str(b.documentType, 120);
  if (b.documentTypeOther !== undefined) out.documentTypeOther = str(b.documentTypeOther, 120);
  if (b.docNo !== undefined) out.docNo = str(b.docNo, 40);
  if (b.pageNo !== undefined) out.pageNo = str(b.pageNo, 40);
  if (b.bookNo !== undefined) out.bookNo = str(b.bookNo, 40);
  if (b.series !== undefined) out.series = str(b.series, 12);
  if (b.notaryName !== undefined) out.notaryName = str(b.notaryName, 200);
  if (b.notes !== undefined) out.notes = String(b.notes || '').slice(0, 5000);
  if (b.dateNotarized !== undefined) {
    if (b.dateNotarized === '' || b.dateNotarized === null) out.dateNotarized = null;
    else { const d = new Date(b.dateNotarized); if (!isNaN(d.getTime())) out.dateNotarized = d; }
  }
  if (b.copies !== undefined) { const n = parseInt(b.copies, 10); if (!isNaN(n) && n >= 0) out.copies = n; }
  if (b.fee !== undefined && b.fee !== null && b.fee !== '') { const n = Number(b.fee); if (!isNaN(n) && n >= 0) out.fee = n; }
  if (Array.isArray(b.payments)) {
    out.payments = b.payments.slice(0, 100).map(p => {
      const row = { amount: Math.max(0, Number(p && p.amount) || 0), mode: str(p && p.mode, 40) || 'Cash', label: str(p && p.label, 200), date: null };
      if (p && p.date) { const d = new Date(p.date); if (!isNaN(d.getTime())) row.date = d; }
      return row;
    }).filter(p => p.amount || p.label || p.date);
  }
  return out;
}

app.get('/api/admin/notarial', verifyToken, requirePermission('notarial_view'), async (req, res) => {
  try {
    const jobs = await NotarialJob.find().sort({ createdAt: -1 }).lean();
    res.json(jobs);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/notarial', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const data = sanitizeNotarialBody(req.body || {});
    if (!data.clientName) return res.status(400).json({ error: 'Client name is required' });
    data.createdBy = req.user?.email || '';
    data.createdByName = req.user?.name || '';
    const doc = await NotarialJob.create(data);
    await logAudit(req, 'CREATE', 'NotarialJob', String(doc._id), doc.clientName, null);
    res.json(doc);
  } catch (err) { console.error('notarial create error:', err); res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/admin/notarial/:id', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const data = sanitizeNotarialBody(req.body || {});
    if (data.clientName !== undefined && !data.clientName) return res.status(400).json({ error: 'Client name is required' });
    const doc = await NotarialJob.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    await logAudit(req, 'UPDATE', 'NotarialJob', String(doc._id), doc.clientName, null);
    res.json(doc);
  } catch (err) { console.error('notarial update error:', err); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/admin/notarial/:id', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const doc = await NotarialJob.findByIdAndDelete(req.params.id);
    if (doc) await logAudit(req, 'DELETE', 'NotarialJob', String(doc._id), doc.clientName, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Bulk stage change / mark-as-paid for several notarial jobs at once (the employee's
// "mark as paid nang hindi iisa-isahin" request — pick many, settle them in one click).
// markPaid moves each to the "paid" stage AND records a settling payment for any balance.
app.post('/api/admin/notarial/bulk-status', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const { ids, status, markPaid } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No records selected' });
    const stage = status ? String(status).slice(0, 40) : null;
    let updated = 0;
    for (const id of ids.slice(0, 500)) {
      const job = await NotarialJob.findById(id);
      if (!job) continue;
      if (markPaid) {
        job.status = 'paid';
        const fee = Number(job.fee) || 0;
        const paid = (job.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
        const bal = fee - paid;
        if (fee > 0 && bal > 0.005) job.payments.push({ date: new Date(), amount: bal, mode: 'Bank transfer', label: 'Settled (bulk)' });
      } else if (stage) {
        job.status = stage;
      }
      await job.save();
      updated++;
    }
    await logAudit(req, 'BULK_UPDATE', 'NotarialJob', '', `${updated} updated`, markPaid ? { markPaid: true } : { status: stage });
    res.json({ success: true, updated });
  } catch (err) { console.error('notarial bulk error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ── NOTARIAL CASH LEDGER (liquidation: supply requests, client funds, receipts) ──
const CASH_KINDS = ['request', 'fund_in', 'fund_out', 'receipt'];
const CASH_STATUSES = ['requested', 'released', 'liquidated', 'done'];
function sanitizeCashBody(b) {
  const out = {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  if (typeof b.kind === 'string' && CASH_KINDS.includes(b.kind)) out.kind = b.kind;
  if (b.person !== undefined) out.person = str(b.person, 200);
  if (b.purpose !== undefined) out.purpose = str(b.purpose, 300);
  if (b.mode !== undefined) out.mode = str(b.mode, 40) || 'Cash';
  if (b.note !== undefined) out.note = String(b.note || '').slice(0, 2000);
  if (typeof b.status === 'string' && CASH_STATUSES.includes(b.status)) out.status = b.status;
  if (b.date !== undefined) {
    if (b.date === '' || b.date === null) out.date = null;
    else { const d = new Date(b.date); if (!isNaN(d.getTime())) out.date = d; }
  }
  ['amount', 'spent'].forEach(k => {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '') { const n = Number(b[k]); if (!isNaN(n) && n >= 0) out[k] = n; }
  });
  if (b.titlingId !== undefined) {
    out.titlingId = (typeof b.titlingId === 'string' && /^[a-f\d]{24}$/i.test(b.titlingId)) ? b.titlingId : null;
  }
  return out;
}

app.get('/api/admin/cash', verifyToken, requirePermission('notarial_view'), async (req, res) => {
  try {
    const list = await CashEntry.find({ business: 'notarial' }).sort({ date: -1, createdAt: -1 }).lean();
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/cash', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const data = sanitizeCashBody(req.body || {});
    if (!data.kind) return res.status(400).json({ error: 'Entry type is required' });
    data.business = 'notarial';
    data.createdBy = req.user?.email || '';
    data.createdByName = req.user?.name || '';
    const doc = await CashEntry.create(data);
    await logAudit(req, 'CREATE', 'CashEntry', String(doc._id), data.kind, null);
    res.json(doc);
  } catch (err) { console.error('cash create error:', err); res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/admin/cash/:id', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const data = sanitizeCashBody(req.body || {});
    const doc = await CashEntry.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    await logAudit(req, 'UPDATE', 'CashEntry', String(doc._id), doc.kind, null);
    res.json(doc);
  } catch (err) { console.error('cash update error:', err); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/admin/cash/:id', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const doc = await CashEntry.findById(req.params.id);
    if (doc) {
      for (const p of (doc.proof || [])) {
        try { await cloudinary.uploader.destroy(p.publicId, { resource_type: p.resourceType || 'image' }); } catch {}
      }
      await doc.deleteOne();
      await logAudit(req, 'DELETE', 'CashEntry', String(doc._id), doc.kind, null);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
// Attach a proof image/PDF — uploaded to Cloudinary, only the link is stored.
app.post('/api/admin/cash/:id/proof', verifyToken, requirePermission('notarial_manage'), uploadAttachment.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const entry = await CashEntry.findById(req.params.id);
    if (!entry) {
      if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Not found' });
    }
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'glra_realty/notarial', resource_type: 'auto' });
    if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
    entry.proof.push({
      url: result.secure_url, publicId: result.public_id, filename: req.file.originalname || '',
      size: result.bytes || 0, resourceType: result.resource_type || 'image',
      uploadedByName: req.user.name || req.user.email || '', uploadedAt: new Date()
    });
    await entry.save();
    await logAudit(req, 'UPLOAD', 'CashEntryProof', String(entry._id), req.file.originalname || '', { size: result.bytes });
    res.json(entry);
  } catch (err) {
    console.error('cash proof upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Upload failed' });
  }
});
app.delete('/api/admin/cash/:id/proof/:proofId', verifyToken, requirePermission('notarial_manage'), async (req, res) => {
  try {
    const entry = await CashEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const p = entry.proof.id(req.params.proofId);
    if (!p) return res.status(404).json({ error: 'Proof not found' });
    try { await cloudinary.uploader.destroy(p.publicId, { resource_type: p.resourceType || 'image' }); } catch {}
    p.deleteOne();
    await entry.save();
    res.json(entry);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── TITLING CASH LEDGER (liquidation + money requests; mirrors the notarial ledger) ──
// Business-wide CashEntry with business:'titling'. Entries optionally link to a
// specific job via titlingId (set when added from inside a titling job). Gated
// by the titling permissions so access can be granted independently of notarial.
app.get('/api/admin/titling-cash', verifyToken, requirePermission('titling_view'), async (req, res) => {
  try {
    const q = { business: 'titling' };
    if (req.query.titlingId) q.titlingId = req.query.titlingId;
    const list = await CashEntry.find(q).sort({ date: -1, createdAt: -1 }).lean();
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/titling-cash', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const data = sanitizeCashBody(req.body || {});
    if (!data.kind) return res.status(400).json({ error: 'Entry type is required' });
    data.business = 'titling';
    data.createdBy = req.user?.email || '';
    data.createdByName = req.user?.name || '';
    const doc = await CashEntry.create(data);
    await logAudit(req, 'CREATE', 'CashEntry', String(doc._id), 'titling ' + data.kind, null);
    res.json(doc);
  } catch (err) { console.error('titling cash create error:', err); res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/admin/titling-cash/:id', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const data = sanitizeCashBody(req.body || {});
    const doc = await CashEntry.findOneAndUpdate({ _id: req.params.id, business: 'titling' }, data, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/admin/titling-cash/:id', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const doc = await CashEntry.findOne({ _id: req.params.id, business: 'titling' });
    if (doc) {
      for (const p of (doc.proof || [])) {
        try { await cloudinary.uploader.destroy(p.publicId, { resource_type: p.resourceType || 'image' }); } catch {}
      }
      await doc.deleteOne();
      await logAudit(req, 'DELETE', 'CashEntry', String(doc._id), 'titling', null);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/titling-cash/:id/proof', verifyToken, requirePermission('titling_manage'), uploadAttachment.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const entry = await CashEntry.findOne({ _id: req.params.id, business: 'titling' });
    if (!entry) {
      if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Not found' });
    }
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'glra_realty/titling', resource_type: 'auto', ...shrinkOnUpload(req.file.mimetype) });
    if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
    entry.proof.push({
      url: result.secure_url, publicId: result.public_id, filename: req.file.originalname || '',
      size: result.bytes || 0, resourceType: result.resource_type || 'image',
      uploadedByName: req.user.name || req.user.email || '', uploadedAt: new Date()
    });
    await entry.save();
    res.json(entry);
  } catch (err) {
    console.error('titling cash proof upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Upload failed' });
  }
});
app.delete('/api/admin/titling-cash/:id/proof/:proofId', verifyToken, requirePermission('titling_manage'), async (req, res) => {
  try {
    const entry = await CashEntry.findOne({ _id: req.params.id, business: 'titling' });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const p = entry.proof.id(req.params.proofId);
    if (!p) return res.status(404).json({ error: 'Proof not found' });
    try { await cloudinary.uploader.destroy(p.publicId, { resource_type: p.resourceType || 'image' }); } catch {}
    p.deleteOne();
    await entry.save();
    res.json(entry);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/subscribers/:id', verifyToken, requirePermission('subscribers_delete'), async (req, res) => {
  try {
    const sub = await Subscriber.findByIdAndDelete(req.params.id);
    if (sub) await logAudit(req, 'DELETE', 'Subscriber', req.params.id, sub.email, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============ BULK EMAIL ============
// Returns a deduplicated list of subscribers + inquiries (with email) so the
// admin UI can let the user pick recipients without exposing the full models.
app.get('/api/admin/contact-list', verifyToken, requirePermission('bulkmail_send'), async (req, res) => {
  try {
    const subscribersRaw = await Subscriber.find({ isActive: { $ne: false } })
      .select('email name source subscribedAt')
      .sort({ subscribedAt: -1 })
      .lean();

    const seenSubs = new Set();
    const subscribers = [];
    for (const s of subscribersRaw) {
      const e = String(s.email || '').toLowerCase().trim();
      if (!e || seenSubs.has(e)) continue;
      seenSubs.add(e);
      subscribers.push({ email: s.email, name: s.name || '', source: s.source || '', subscribedAt: s.subscribedAt });
    }

    const inquiriesRaw = await Inquiry.find({ email: { $ne: '' } })
      .select('email name propertyTitle createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // Dedupe by email — keep the most recent record.
    const seenInq = new Set();
    const inquiries = [];
    for (const i of inquiriesRaw) {
      const e = String(i.email || '').toLowerCase().trim();
      if (!e || seenInq.has(e) || seenSubs.has(e)) continue;
      seenInq.add(e);
      inquiries.push({ email: i.email, name: i.name || '', propertyTitle: i.propertyTitle || '', createdAt: i.createdAt });
    }

    res.json({ subscribers, inquiries });
  } catch (err) {
    console.error('contact-list error:', err);
    res.status(500).json({ error: 'Failed to load contact list' });
  }
});

// ── Shared helpers for bulk-email (used by immediate send + scheduled worker)
const BULK_EMAIL_RX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Validate, lowercase, dedupe a raw recipients array. Returns { clean: string[] }.
function cleanBulkRecipients(recipients) {
  const seen = new Set();
  const clean = [];
  for (const r of (recipients || [])) {
    const e = String(typeof r === 'string' ? r : (r?.email || '')).trim().toLowerCase();
    if (!e || !BULK_EMAIL_RX.test(e) || seen.has(e)) continue;
    seen.add(e);
    clean.push(e);
  }
  return clean;
}

// Concurrency-limited Brevo dispatch. Returns { sent, failed, errors }.
async function dispatchBulkEmail({ clean, subject, fromName, html, concurrency = 5 }) {
  let sent = 0, failed = 0;
  const errors = [];
  let cursor = 0;
  async function worker() {
    while (cursor < clean.length) {
      const idx = cursor++;
      const to = clean[idx];
      try {
        const r = await sendEmail(to, subject, html, fromName);
        if (r && r.success) sent++;
        else { failed++; errors.push({ to, error: String(r?.error?.message || r?.error || 'unknown') }); }
      } catch (e) {
        failed++;
        errors.push({ to, error: e.message });
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, clean.length) }, () => worker());
  await Promise.all(workers);
  return { sent, failed, errors };
}

// Send a single email body to many recipients. Validates + dedupes server-side
// (never trust the client list), throttles concurrency so Brevo doesn't choke,
// and writes an audit log entry summarising the batch.
app.post('/api/admin/bulk-email',
  bulkEmailLimiter,
  verifyToken,
  requirePermission('bulkmail_send'),
  async (req, res) => {
    try {
      const { recipients, subject, fromName, html, isTest } = req.body || {};
      if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'No recipients provided' });
      if (!subject || typeof subject !== 'string') return res.status(400).json({ error: 'Subject is required' });
      if (!html || typeof html !== 'string') return res.status(400).json({ error: 'Email body is required' });

      const HARD_MAX = isTest ? 5 : 1000;
      if (recipients.length > HARD_MAX) return res.status(400).json({ error: `Maximum ${HARD_MAX} recipients per batch` });

      const clean = cleanBulkRecipients(recipients);
      if (!clean.length) return res.status(400).json({ error: 'No valid email addresses found' });
      if (!brevoApiInstance && !initBrevo()) return res.status(503).json({ error: 'Email service is not configured (BREVO_API_KEY missing).' });

      const safeFrom = String(fromName || 'GLRA Realty').slice(0, 80);
      const safeSubject = subject.slice(0, 200);

      const { sent, failed, errors } = await dispatchBulkEmail({ clean, subject: safeSubject, fromName: safeFrom, html });

      await logAudit(req, 'BULK_EMAIL', 'BulkEmail', '', safeSubject, {
        recipients: clean.length,
        sent,
        failed,
        isTest: !!isTest
      });

      res.json({ success: true, total: clean.length, sent, failed, errors: errors.slice(0, 10) });
    } catch (err) {
      console.error('bulk-email error:', err);
      res.status(500).json({ error: 'Bulk email failed' });
    }
  }
);

// ── SCHEDULED BULK EMAILS ─────────────────────────────────────
// Create a scheduled campaign — same payload as /api/admin/bulk-email plus a
// `sendAt` ISO timestamp. The background worker (below) actually sends it.
app.post('/api/admin/scheduled-emails',
  bulkEmailLimiter,
  verifyToken,
  requirePermission('bulkmail_send'),
  async (req, res) => {
    try {
      const { recipients, subject, fromName, html, sendAt } = req.body || {};
      if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'No recipients provided' });
      if (!subject || typeof subject !== 'string') return res.status(400).json({ error: 'Subject is required' });
      if (!html || typeof html !== 'string') return res.status(400).json({ error: 'Email body is required' });
      if (recipients.length > 1000) return res.status(400).json({ error: 'Maximum 1000 recipients per batch' });

      const sendAtDate = new Date(sendAt);
      if (!sendAt || isNaN(sendAtDate.getTime())) return res.status(400).json({ error: 'sendAt must be a valid date/time' });
      // Must be at least 1 minute in the future; cap at 1 year out.
      const now = Date.now();
      if (sendAtDate.getTime() < now + 60 * 1000) return res.status(400).json({ error: 'sendAt must be at least 1 minute from now' });
      if (sendAtDate.getTime() > now + 365 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'sendAt cannot be more than 1 year in the future' });

      const clean = cleanBulkRecipients(recipients);
      if (!clean.length) return res.status(400).json({ error: 'No valid email addresses found' });

      const doc = await ScheduledEmail.create({
        recipients: clean,
        subject: subject.slice(0, 200),
        fromName: String(fromName || 'GLRA Realty').slice(0, 80),
        html,
        sendAt: sendAtDate,
        status: 'pending',
        createdBy: req.user?.email || '',
        createdByName: req.user?.name || ''
      });

      await logAudit(req, 'SCHEDULE_EMAIL', 'ScheduledEmail', String(doc._id), doc.subject, {
        recipients: clean.length,
        sendAt: sendAtDate.toISOString()
      });

      res.json({ success: true, id: doc._id, sendAt: sendAtDate, recipients: clean.length });
    } catch (err) {
      console.error('schedule-email error:', err);
      res.status(500).json({ error: 'Failed to schedule email' });
    }
  }
);

// List scheduled emails — newest sendAt first. Strips the heavy `html` field.
app.get('/api/admin/scheduled-emails',
  verifyToken,
  requirePermission('bulkmail_send'),
  async (req, res) => {
    try {
      const docs = await ScheduledEmail.find({}, { html: 0 })
        .sort({ sendAt: 1 })
        .limit(200)
        .lean();
      const rows = docs.map(d => ({
        _id: d._id,
        subject: d.subject,
        fromName: d.fromName,
        recipientCount: (d.recipients || []).length,
        sendAt: d.sendAt,
        status: d.status,
        sentAt: d.sentAt,
        createdAt: d.createdAt,
        createdBy: d.createdBy,
        createdByName: d.createdByName,
        result: d.result
      }));
      res.json({ scheduled: rows });
    } catch (err) {
      console.error('list scheduled-emails error:', err);
      res.status(500).json({ error: 'Failed to load scheduled emails' });
    }
  }
);

// Cancel a still-pending scheduled email. Sent / failed campaigns can't be cancelled.
app.delete('/api/admin/scheduled-emails/:id',
  verifyToken,
  requirePermission('bulkmail_send'),
  async (req, res) => {
    try {
      const doc = await ScheduledEmail.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });
      if (doc.status !== 'pending') return res.status(400).json({ error: `Cannot cancel — already ${doc.status}` });
      doc.status = 'cancelled';
      await doc.save();
      await logAudit(req, 'CANCEL_SCHEDULED_EMAIL', 'ScheduledEmail', String(doc._id), doc.subject, {});
      res.json({ success: true });
    } catch (err) {
      console.error('cancel scheduled-email error:', err);
      res.status(500).json({ error: 'Failed to cancel' });
    }
  }
);

// Resend a cancelled / failed / already-sent campaign without rebuilding it.
// Creates a NEW pending entry (so the original stays in the history) with
// sendAt = now, which the background worker picks up on its next tick.
app.post('/api/admin/scheduled-emails/:id/resend',
  bulkEmailLimiter,
  verifyToken,
  requirePermission('bulkmail_send'),
  async (req, res) => {
    try {
      const orig = await ScheduledEmail.findById(req.params.id);
      if (!orig) return res.status(404).json({ error: 'Not found' });
      if (orig.status === 'pending' || orig.status === 'sending') {
        return res.status(400).json({ error: `This campaign is still ${orig.status} — nothing to resend yet.` });
      }
      if (!orig.recipients || !orig.recipients.length) {
        return res.status(400).json({ error: 'Original campaign has no saved recipients to resend.' });
      }

      const doc = await ScheduledEmail.create({
        recipients: orig.recipients,
        subject: orig.subject,
        fromName: orig.fromName,
        html: orig.html,
        sendAt: new Date(), // due immediately — worker dispatches on next tick (≤60s)
        status: 'pending',
        createdBy: req.user?.email || '',
        createdByName: req.user?.name || ''
      });

      await logAudit(req, 'RESEND_SCHEDULED_EMAIL', 'ScheduledEmail', String(doc._id), doc.subject, {
        resentFrom: String(orig._id),
        recipients: orig.recipients.length
      });

      res.json({ success: true, id: doc._id, recipients: orig.recipients.length });
    } catch (err) {
      console.error('resend scheduled-email error:', err);
      res.status(500).json({ error: 'Failed to resend' });
    }
  }
);

// Background worker — every minute, find pending emails whose sendAt has passed
// and dispatch them. Uses findOneAndUpdate with status check so two server
// processes (if you ever scale out) can't double-send the same campaign.
async function processDueScheduledEmails() {
  if (mongoose.connection.readyState !== 1) return; // wait for DB connection
  try {
    while (true) {
      // Atomically claim one due pending email by flipping status to 'sending'.
      const due = await ScheduledEmail.findOneAndUpdate(
        { status: 'pending', sendAt: { $lte: new Date() } },
        { $set: { status: 'sending' } },
        { sort: { sendAt: 1 }, new: true }
      );
      if (!due) return;

      console.log(`📧 Dispatching scheduled email ${due._id} → ${due.recipients.length} recipients (subj: "${due.subject}")`);

      if (!brevoApiInstance && !initBrevo()) {
        // Brevo not configured — kick back to pending so we retry next tick.
        due.status = 'pending';
        await due.save();
        console.warn('Skipping scheduled email — Brevo not configured');
        return;
      }

      try {
        const { sent, failed, errors } = await dispatchBulkEmail({
          clean: due.recipients,
          subject: due.subject,
          fromName: due.fromName,
          html: due.html
        });
        due.status = (failed === due.recipients.length) ? 'failed' : 'sent';
        due.sentAt = new Date();
        due.result = { total: due.recipients.length, sent, failed, errors: errors.slice(0, 10) };
        await due.save();
        console.log(`📧 Scheduled email ${due._id} done: ${sent} sent / ${failed} failed`);
      } catch (e) {
        due.status = 'failed';
        due.sentAt = new Date();
        due.result = { total: due.recipients.length, sent: 0, failed: due.recipients.length, errors: [{ error: e.message }] };
        await due.save();
        console.error(`Scheduled email ${due._id} failed:`, e.message);
      }
    }
  } catch (err) {
    console.error('processDueScheduledEmails error:', err.message);
  }
}

// Run every 60 seconds. First tick after 30s so the DB has time to connect.
setTimeout(() => {
  processDueScheduledEmails();
  setInterval(processDueScheduledEmails, 60 * 1000);
}, 30 * 1000);

app.post('/api/admin/properties/bulk', verifyToken, requirePermission('properties_create'), async (req, res) => {
  try {
    const properties = req.body;
    if (!Array.isArray(properties)) return res.status(400).json({ error: 'Expected an array' });
    let added = 0;
    for (const prop of properties) {
      const existing = await Property.findOne({ title: prop.title, location: prop.location });
      if (!existing) {
        const clean = { ...(prop && typeof prop === 'object' ? prop : {}) };
        delete clean.geo; delete clean.nearby; delete clean.hazard; // written only by the location worker
        await new Property(clean).save();
        added++;
      }
    }
    await logAudit(req, 'BULK_CREATE', 'Property', '', `${added} added`, null);
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
    scheduleSavedSearchSweep();
    scheduleGeoPass();
    res.json({ success: true, added });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Property image upload — gated by properties_upload_image permission
app.post('/api/admin/upload-property-image', verifyToken, requirePermission('properties_upload_image'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'glra_realty/properties',
      // 2400 px on the long side: a listing's lead photo is shown up to about
      // 1,400 px wide, twice that on a sharp laptop screen. The old 1200x800
      // cap made every cover soft on desktop. The admin already shrinks each
      // photo to 2400 px on the device before it uploads.
      transformation: [{ width: 2400, height: 2400, crop: 'limit' }, { quality: 'auto:good' }]
    });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    await logAudit(req, 'UPLOAD', 'PropertyImage', '', req.file.originalname || '', { url: result.secure_url, sizeBytes: result.bytes });
    res.json({ url: result.secure_url, size: result.bytes });
  } catch (err) {
    console.error('Upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Hero images
app.get('/api/admin/hero-images', verifyToken, async (req, res) => {
  try {
    // .lean() + the same swap, or the Hero tab downloads 2.5 MB of base64
    // every time Catherine opens it, just to draw four thumbnails.
    const images = await HeroImage.find().sort({ order: 1 }).lean();
    images.forEach(externalizeHeroImage);
    res.json(images);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/hero-images/upload', verifyToken, requirePermission('hero_upload'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'glra_realty/hero',
      transformation: [{ width: 1920, height: 1080, crop: 'fill' }, { quality: 'auto' }]
    });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    const count = await HeroImage.countDocuments();
    const newImage = new HeroImage({ url: result.secure_url, order: count });
    await newImage.save();
    await logAudit(req, 'CREATE', 'HeroImage', newImage._id, '', null);
    res.json(newImage);
  } catch (err) {
    console.error('Hero upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/admin/hero-images/reorder', verifyToken, requirePermission('hero_edit'), async (req, res) => {
  try {
    const { images } = req.body;
    if (!Array.isArray(images)) return res.status(400).json({ error: 'Expected images array' });
    for (const img of images) {
      await HeroImage.findByIdAndUpdate(img._id, { order: img.order });
    }
    await logAudit(req, 'REORDER', 'HeroImage', '', `${images.length} images`, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/hero-images/:id/default', verifyToken, requirePermission('hero_edit'), async (req, res) => {
  try {
    const images = await HeroImage.find().sort({ order: 1 });
    let newOrder = 0;
    for (const img of images) {
      if (img._id.toString() === req.params.id) {
        img.order = 0;
      } else {
        img.order = newOrder + 1;
        newOrder++;
      }
      await img.save();
    }
    await logAudit(req, 'SET_DEFAULT', 'HeroImage', req.params.id, '', null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/hero-images/:id', verifyToken, requirePermission('hero_delete'), async (req, res) => {
  try {
    await HeroImage.findByIdAndDelete(req.params.id);
    await logAudit(req, 'DELETE', 'HeroImage', req.params.id, '', null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============ TASKS (Monday-style internal task board) ============
// Visibility: admins see all; employees only see tasks where they are assigned or were the creator.
async function buildTaskVisibilityFilter(user) {
  if (user && user.role === 'admin') return {};
  // Re-check live account in case role changed since token issue
  const account = await Account.findById(user.sub).select('role').lean();
  if (account && account.role === 'admin') return {};
  return {
    $or: [
      { assignedTo: user.sub },
      { createdBy: user.sub }
    ]
  };
}

// List tasks (visibility-filtered, with optional filters)
app.get('/api/admin/tasks', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const { status, assignee, category, search } = req.query;
    const filter = { ...visibility };
    if (status && ['todo','in_progress','stuck','done'].includes(status)) filter.status = status;
    if (assignee && mongoose.isValidObjectId(assignee)) filter.assignedTo = assignee;
    if (category) filter.category = category;
    if (search) {
      const safe = String(search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: safe, $options: 'i' };
      filter.$and = [{ $or: [{ title: rx }, { description: rx }, { reference: rx }] }];
    }
    const tasks = await Task.find(filter)
      .populate('assignedTo', 'name email role')
      .populate('createdBy', 'name email')
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    res.json(tasks);
  } catch (err) {
    console.error('Tasks list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Stats for the dashboard cards (open / overdue / by status / by assignee)
app.get('/api/admin/tasks-stats', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const all = await Task.find(visibility).select('status assignedTo dueDate').lean();
    const now = new Date();
    const counts = { total: all.length, todo: 0, in_progress: 0, stuck: 0, done: 0, overdue: 0 };
    const byAssignee = {};
    all.forEach(t => {
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (t.status !== 'done' && t.dueDate && new Date(t.dueDate) < now) counts.overdue++;
      (t.assignedTo || []).forEach(aid => {
        const k = aid.toString();
        if (!byAssignee[k]) byAssignee[k] = { todo: 0, in_progress: 0, stuck: 0, done: 0 };
        byAssignee[k][t.status] = (byAssignee[k][t.status] || 0) + 1;
      });
    });
    res.json({ ...counts, byAssignee });
  } catch (err) {
    console.error('Tasks stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Distinct categories — for autocomplete
app.get('/api/admin/tasks-categories', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const cats = await Task.distinct('category', visibility);
    res.json(cats.filter(c => c && c.trim()).sort());
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Active employees — for the assignee dropdown
app.get('/api/admin/tasks-assignees', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const accounts = await Account.find({ isActive: true }).select('email name role').sort({ name: 1 }).lean();
    res.json(accounts);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Get a single task (visibility-checked)
app.get('/api/admin/tasks/:id', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const task = await Task.findOne({ _id: req.params.id, ...visibility })
      .populate('assignedTo', 'name email role')
      .populate('createdBy', 'name email')
      .lean();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Create — requires tasks_create
app.post('/api/admin/tasks', verifyToken, requirePermission('tasks_create'), async (req, res) => {
  try {
    const { title, description, category, status, priority, assignedTo, dueDate, reference } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    const task = await Task.create({
      title: String(title).trim(),
      description: description ? String(description) : '',
      category: category ? String(category).trim() : '',
      status: ['todo','in_progress','stuck','done'].includes(status) ? status : 'todo',
      priority: ['low','medium','high','critical'].includes(priority) ? priority : 'medium',
      assignedTo: Array.isArray(assignedTo) ? assignedTo.filter(id => mongoose.isValidObjectId(id)) : [],
      dueDate: dueDate ? new Date(dueDate) : null,
      reference: reference ? String(reference).trim() : '',
      createdBy: req.user.sub
    });
    await logAudit(req, 'CREATE', 'Task', task._id, task.title, null);
    res.json(task);
  } catch (err) {
    console.error('Task create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update — visibility-checked. Assignees + creator can change status/description/comments.
// Reassigning, changing due date, or editing other people's tasks requires tasks_edit.
app.put('/api/admin/tasks/:id', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const existing = await Task.findOne({ _id: req.params.id, ...visibility });
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const account = await Account.findById(req.user.sub).select('role permissions').lean();
    const isAdmin = req.user.role === 'admin' || (account && account.role === 'admin');
    const hasEdit = isAdmin || (account && account.permissions && account.permissions.tasks_edit === true);
    const isParticipant = existing.createdBy.toString() === req.user.sub
      || (existing.assignedTo || []).some(a => a.toString() === req.user.sub);
    if (!hasEdit && !isParticipant) {
      return res.status(403).json({ error: 'You cannot edit this task' });
    }

    const allowed = ['title','description','category','status','priority','assignedTo','dueDate','reference'];
    const update = {};
    allowed.forEach(k => {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    });
    if (update.status && !['todo','in_progress','stuck','done'].includes(update.status)) delete update.status;
    if (update.priority && !['low','medium','high','critical'].includes(update.priority)) delete update.priority;
    // Non-managers cannot reassign or rename
    if (!hasEdit) {
      delete update.assignedTo;
      delete update.title;
      delete update.dueDate;
      delete update.reference;
      delete update.category;
    }
    if (update.assignedTo) {
      update.assignedTo = Array.isArray(update.assignedTo)
        ? update.assignedTo.filter(id => mongoose.isValidObjectId(id))
        : [];
    }
    if (update.dueDate !== undefined) {
      update.dueDate = update.dueDate ? new Date(update.dueDate) : null;
    }
    if (update.title) update.title = String(update.title).trim().slice(0, 200);
    if (update.description !== undefined) update.description = String(update.description).slice(0, 5000);
    if (update.category) update.category = String(update.category).trim().slice(0, 60);
    if (update.reference) update.reference = String(update.reference).trim().slice(0, 200);
    // Auto-manage completedAt
    if (update.status === 'done' && existing.status !== 'done') update.completedAt = new Date();
    else if (update.status && update.status !== 'done' && existing.status === 'done') update.completedAt = null;

    const task = await Task.findByIdAndUpdate(req.params.id, update, { new: true });
    await logAudit(req, 'UPDATE', 'Task', task._id, task.title, update);
    res.json(task);
  } catch (err) {
    console.error('Task update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete — requires tasks_delete. Cleans Cloudinary attachments.
app.delete('/api/admin/tasks/:id', verifyToken, requirePermission('tasks_delete'), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    for (const att of (task.attachments || [])) {
      try { await cloudinary.uploader.destroy(att.publicId, { resource_type: att.resourceType || 'image' }); } catch {}
    }
    await Task.findByIdAndDelete(req.params.id);
    await logAudit(req, 'DELETE', 'Task', req.params.id, task.title, null);
    res.json({ success: true });
  } catch (err) {
    console.error('Task delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add an update / comment to a task
app.post('/api/admin/tasks/:id/updates', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const task = await Task.findOne({ _id: req.params.id, ...visibility });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { text } = req.body;
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'Update text is required' });
    task.updates.push({
      author: req.user.sub,
      authorName: req.user.name || '',
      authorEmail: req.user.email || '',
      text: String(text).trim().slice(0, 2000),
      createdAt: new Date()
    });
    await task.save();
    await logAudit(req, 'COMMENT', 'Task', task._id, task.title, { text: String(text).trim().slice(0, 200) });
    res.json(task);
  } catch (err) {
    console.error('Task comment error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a comment (own comment, or admin)
app.delete('/api/admin/tasks/:id/updates/:updateId', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const task = await Task.findOne({ _id: req.params.id, ...visibility });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const upd = task.updates.id(req.params.updateId);
    if (!upd) return res.status(404).json({ error: 'Update not found' });
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && upd.author.toString() !== req.user.sub) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    upd.deleteOne();
    await task.save();
    res.json(task);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Upload an attachment (PDF, Word, image, etc.)
app.post('/api/admin/tasks/:id/attachments', verifyToken, requirePermission('tasks_view'), uploadAttachment.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const visibility = await buildTaskVisibilityFilter(req.user);
    const task = await Task.findOne({ _id: req.params.id, ...visibility });
    if (!task) {
      if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Task not found' });
    }
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'glra_realty/tasks',
      resource_type: 'auto',
      ...shrinkOnUpload(req.file.mimetype)
    });
    if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
    task.attachments.push({
      url: result.secure_url,
      publicId: result.public_id,
      filename: req.file.originalname || '',
      size: result.bytes || 0,
      resourceType: result.resource_type || 'image',
      uploadedBy: req.user.sub,
      uploadedByName: req.user.name || req.user.email || '',
      uploadedAt: new Date()
    });
    await task.save();
    await logAudit(req, 'UPLOAD', 'TaskAttachment', task._id, req.file.originalname || '', { size: result.bytes });
    res.json(task);
  } catch (err) {
    console.error('Task upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Per-task activity log — pulls from existing AuditLog filtered to this Task.
// Visibility-checked so employees see history of tasks they participate in.
app.get('/api/admin/tasks/:id/activity', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const task = await Task.findOne({ _id: req.params.id, ...visibility }).select('_id').lean();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const logs = await AuditLog.find({
      target: { $in: ['Task', 'TaskAttachment'] },
      targetId: req.params.id
    }).sort({ timestamp: -1 }).limit(200).lean();
    res.json(logs);
  } catch (err) {
    console.error('Task activity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Duplicate a task — creates a new task with copied fields. Requires tasks_create.
app.post('/api/admin/tasks/:id/duplicate', verifyToken, requirePermission('tasks_create'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const src = await Task.findOne({ _id: req.params.id, ...visibility }).lean();
    if (!src) return res.status(404).json({ error: 'Task not found' });
    const copy = await Task.create({
      title: (src.title || 'Untitled') + ' (copy)',
      description: src.description || '',
      category: src.category || '',
      status: 'todo',
      priority: src.priority || 'medium',
      assignedTo: Array.isArray(src.assignedTo) ? src.assignedTo : [],
      dueDate: null,
      reference: src.reference || '',
      createdBy: req.user.sub
    });
    await logAudit(req, 'CREATE', 'Task', copy._id, copy.title, { duplicatedFrom: src._id });
    res.json(copy);
  } catch (err) {
    console.error('Task duplicate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove an attachment
app.delete('/api/admin/tasks/:id/attachments/:attId', verifyToken, requirePermission('tasks_view'), async (req, res) => {
  try {
    const visibility = await buildTaskVisibilityFilter(req.user);
    const task = await Task.findOne({ _id: req.params.id, ...visibility });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const att = task.attachments.id(req.params.attId);
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    try { await cloudinary.uploader.destroy(att.publicId, { resource_type: att.resourceType || 'image' }); } catch {}
    att.deleteOne();
    await task.save();
    res.json(task);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============ PROPERTY SUBMISSIONS (public listing form) ============
// Public: image upload (rate-limited, no auth). Goes to a separate Cloudinary
// folder so we can sweep orphans later without touching live property images.
app.post('/api/property-submissions/upload-image',
  submissionUploadLimiter,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No image file provided' });
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: 'glra_realty/submissions',
        transformation: [{ width: 1600, height: 1200, crop: 'limit' }, { quality: 'auto' }]
      });
      if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      res.json({ url: result.secure_url, size: result.bytes });
    } catch (err) {
      console.error('Submission upload error:', err);
      if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

// Public: submit the property listing form
/* Owner documents — titles, tax declarations, IDs.
   Narrower than the task-attachment filter on purpose: a title copy is a
   PDF or a photograph, and there is no reason to accept Word or Excel
   here. Nothing lands in public/uploads for longer than the round trip. */
const ALLOWED_DOC_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const uploadOwnerDoc = multer({
  storage: storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOC_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Upload a PDF or a photo (JPG, PNG, WEBP) of the document.'));
  }
});

app.post('/api/property-submissions/upload-document',
  submissionUploadLimiter,
  uploadOwnerDoc.single('document'),
  async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
      if (!req.file) return res.status(400).json({ error: 'No document provided' });
      // `authenticated` is the whole point: unlike the property photos,
      // the resulting URL cannot be opened by anyone who happens to have
      // it. Every view is a signed, expiring link minted for an admin.
      const result = await cloudinary.uploader.upload(tmp, {
        folder: 'glra_realty/submission_docs',
        resource_type: 'auto',
        ...shrinkOnUpload(req.file && req.file.mimetype),
        type: 'authenticated'
      });
      if (tmp && fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch {}
      res.json({
        publicId: result.public_id,
        resourceType: result.resource_type,
        format: result.format || '',
        bytes: result.bytes,
        name: String(req.file.originalname || '').slice(0, 200)
      });
    } catch (err) {
      console.error('Owner document upload error:', err.message);
      if (tmp && fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch {}
      res.status(500).json({ error: 'Upload failed. Please try again.' });
    }
  }
);

function isSubmittedPhotoUrl(u) {
  return typeof u === 'string' && u.length <= 500 &&
    /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]+\/image\/upload\/[^\s"'<>`\\]+$/.test(u);
}

app.post('/api/property-submissions',
  submissionLimiter,
  [
    body('submitterName').trim().notEmpty().isLength({ max: 100 }).withMessage('Your name is required'),
    body('submitterEmail').trim().isEmail().normalizeEmail().withMessage('A valid email is required'),
    body('submitterPhone').optional({ checkFalsy: true }).isLength({ max: 30 }),
    body('title').trim().notEmpty().isLength({ max: 200 }).withMessage('Property title is required'),
    body('location').trim().notEmpty().isLength({ max: 200 }).withMessage('Location is required'),
    body('listingType').trim().isIn(['FOR SALE', 'FOR LEASE', 'SALE AND LEASE']).withMessage('Invalid listing type'),
    body('propertyType').trim().isLength({ max: 60 }),
    body('description').optional({ checkFalsy: true }).isLength({ max: 5000 }),
    // Photos must be what this form's own upload button produces: a Cloudinary
    // image URL. isURL() alone let quote marks and javascript: through, and a
    // crafted "photo" ran code in the dashboard of whoever opened the submission.
    body('mainImage').optional({ checkFalsy: true }).custom(isSubmittedPhotoUrl).withMessage('Invalid photo'),
    body('gallery').optional({ checkFalsy: true }).isArray({ max: 20 }),
    body('gallery.*').custom(isSubmittedPhotoUrl).withMessage('Invalid photo')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const b = req.body || {};
      // Reject submissions that don't include at least one image — gives admin
      // some signal that the submitter is serious.
      if (!b.mainImage && (!Array.isArray(b.gallery) || b.gallery.length === 0)) {
        return res.status(400).json({ error: 'Please upload at least one photo of the property.' });
      }
      // The four acknowledgements are what let us advertise at all, so a
      // submission without them is refused here as well as in the browser
      // — client-side validation is a courtesy, not a control.
      const ack = b.acknowledgements || {};
      if (!ack.isOwnerOrAuthorised || !ack.marketingAuthorised ||
          !ack.understandsWrittenAuthorityRequired || !ack.privacyConsent) {
        return res.status(400).json({
          error: 'Please tick all four boxes under Authority & consent before submitting.'
        });
      }

      const ALLOWED_DOCS = 24;      // keeps a crafted payload from growing the doc
      const leaseIn = b.leaseTerms && typeof b.leaseTerms === 'object' ? b.leaseTerms : {};

      const sub = await PropertySubmission.create({
        submitterName: b.submitterName,
        submitterEmail: b.submitterEmail,
        submitterPhone: b.submitterPhone || '',
        submitterMessage: b.submitterMessage || '',
        title: b.title,
        description: b.description || '',
        location: b.location,
        mapLocation: b.mapLocation || '',
        propertyType: b.propertyType || 'Condominium',
        listingType: b.listingType || 'FOR SALE',
        price: parseFloat(b.price) || 0,
        monthlyRental: parseFloat(b.monthlyRental) || 0,
        bedrooms: parseInt(b.bedrooms) || 0,
        bathrooms: parseInt(b.bathrooms) || 0,
        sqm: parseFloat(b.sqm) || 0,
        landArea: parseFloat(b.landArea) || 0,
        parking: parseInt(b.parking) || 0,
        developer: b.developer || '',
        mainImage: b.mainImage || (Array.isArray(b.gallery) && b.gallery[0]) || '',
        gallery: Array.isArray(b.gallery) ? b.gallery.slice(0, 20) : [],

        ownerRole: String(b.ownerRole || '').slice(0, 60),
        documentsReady: Array.isArray(b.documentsReady)
          ? b.documentsReady.slice(0, ALLOWED_DOCS).map(d => String(d).slice(0, 120))
          : [],
        // Rebuilt field by field rather than trusting the posted shape —
        // this array ends up naming Cloudinary assets, so nothing the
        // browser sends is copied through verbatim.
        documents: Array.isArray(b.documents)
          ? b.documents.slice(0, ALLOWED_DOCS).map(d => ({
              label:        String(d.label || '').slice(0, 120),
              publicId:     String(d.publicId || '').slice(0, 300),
              resourceType: ['image','raw','video'].includes(d.resourceType) ? d.resourceType : 'image',
              format:       String(d.format || '').replace(/[^a-z0-9]/gi, '').slice(0, 12),
              name:         String(d.name || '').slice(0, 200),
              bytes:        parseInt(d.bytes) || 0,
              uploadedAt:   new Date()
            })).filter(d => d.publicId)
          : [],
        leaseTerms: {
          term:          String(leaseIn.term || '').slice(0, 40),
          availableFrom: String(leaseIn.availableFrom || '').slice(0, 20),
          depositMonths: parseInt(leaseIn.depositMonths) || 0,
          advanceMonths: parseInt(leaseIn.advanceMonths) || 0,
          furnishing:    String(leaseIn.furnishing || '').slice(0, 40),
          dues:          String(leaseIn.dues || '').slice(0, 40),
          pets:          String(leaseIn.pets || '').slice(0, 40),
          utilities:     String(leaseIn.utilities || '').slice(0, 120)
        },
        authorityType:  String(b.authorityType || '').slice(0, 30),
        commissionNote: String(b.commissionNote || '').slice(0, 60),
        acknowledgements: {
          isOwnerOrAuthorised: true,
          marketingAuthorised: true,
          understandsWrittenAuthorityRequired: true,
          privacyConsent: true,
          // Stamped server-side on purpose. A timestamp the submitter's
          // browser supplied would be worth nothing as a record.
          acceptedAt: new Date(),
          acceptedIp: req.ip || req.connection?.remoteAddress || ''
        },

        ip: req.ip || req.connection?.remoteAddress || '',
        userAgent: req.headers?.['user-agent'] || ''
      });

      // Confirmation email to the submitter
      try {
        const safeName = (b.submitterName || '').replace(/[<>]/g, '');
        const safeTitle = (b.title || '').replace(/[<>]/g, '');
        const userHtml = getEmailHeader() + `
          <p style="margin:0 0 14px">Hi ${safeName},</p>
          <p style="margin:0 0 14px">Thank you for submitting <strong style="color:#ff3d00">${safeTitle}</strong> to GLRA Realty. Our team will review your listing within 1–2 business days and reach out to you at this email.</p>
          <p style="margin:0 0 14px">If you have additional details or photos, simply reply to this email.</p>
        ` + getEmailFooter();
        await sendEmail(b.submitterEmail, 'We received your property listing — GLRA Realty', userHtml);
      } catch (e) { console.error('Submitter confirmation email error:', e.message); }

      // Notification email to admin
      try {
        const safeName = (b.submitterName || '').replace(/[<>]/g, '');
        const safeTitle = (b.title || '').replace(/[<>]/g, '');
        const safeLoc = (b.location || '').replace(/[<>]/g, '');
        const safeEmail = (b.submitterEmail || '').replace(/[<>]/g, '');
        const safePhone = (b.submitterPhone || '').replace(/[<>]/g, '');
        const adminHtml = getEmailHeader() + `
          <h2 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:18px;font-weight:900;letter-spacing:-.5px;text-transform:uppercase;color:#0a0a0a;margin:0 0 12px;padding-bottom:10px;border-bottom:2px solid #ff3d00">New Property Submission</h2>
          <p style="margin:0 0 8px;font-size:16px"><strong>${safeTitle}</strong> · ${safeLoc}</p>
          <p style="margin:0 0 8px">Listing type: <strong>${(b.listingType||'').replace(/[<>]/g,'')}</strong> · Property type: ${(b.propertyType||'').replace(/[<>]/g,'')}</p>
          <p style="margin:0 0 14px">Price: ₱${(parseFloat(b.price)||0).toLocaleString()} · Rental: ₱${(parseFloat(b.monthlyRental)||0).toLocaleString()}/mo</p>
          <div style="border-top:1px solid #0a0a0a;padding-top:14px;margin-top:14px">
            <p style="margin:0 0 6px">Submitted by: <strong>${safeName}</strong></p>
            <p style="margin:0 0 6px">Email: <a href="mailto:${safeEmail}" style="color:#ff3d00">${safeEmail}</a></p>
            <p style="margin:0 0 6px">Phone: ${safePhone || '—'}</p>
            <p style="margin:0 0 6px">Role: ${esc(sub.ownerRole || '—')}</p>
          </div>
          <div style="border-top:1px solid #0a0a0a;padding-top:14px;margin-top:14px">
            <p style="margin:0 0 6px"><strong>Documents the owner says they hold</strong></p>
            <p style="margin:0 0 10px;font-size:13px;line-height:1.7">${
              sub.documentsReady.length
                ? sub.documentsReady.map(d => esc(d)).join('<br>')
                : '<em style="color:#b91c1c">None ticked — chase these before doing any work.</em>'
            }</p>
            <p style="margin:0 0 6px">Authority sought: <strong>${esc(sub.authorityType || 'not decided')}</strong>${
              sub.commissionNote ? ' · commission: ' + esc(sub.commissionNote) : ''}</p>
            <p style="margin:0;font-size:13px;color:#6a6a6a">Owner ticked all four acknowledgements at ${
              sub.acknowledgements.acceptedAt.toISOString()} from ${esc(sub.acknowledgements.acceptedIp || 'unknown')}.
              <strong style="color:#b91c1c">This is not an Authority to Sell</strong> — get the signed document before marketing.</p>
          </div>${ sub.leaseTerms && sub.leaseTerms.term ? `
          <div style="border-top:1px solid #0a0a0a;padding-top:14px;margin-top:14px">
            <p style="margin:0 0 6px"><strong>Lease terms</strong></p>
            <p style="margin:0;font-size:13px;line-height:1.7">
              Term: ${esc(sub.leaseTerms.term)} · Deposit: ${sub.leaseTerms.depositMonths} mo ·
              Advance: ${sub.leaseTerms.advanceMonths} mo<br>
              ${esc(sub.leaseTerms.furnishing)} · Dues ${esc(sub.leaseTerms.dues.toLowerCase())} ·
              Pets: ${esc(sub.leaseTerms.pets.toLowerCase())}
              ${sub.leaseTerms.availableFrom ? '<br>Available from ' + esc(sub.leaseTerms.availableFrom) : ''}
              ${sub.leaseTerms.utilities ? '<br>' + esc(sub.leaseTerms.utilities) : ''}
            </p>
          </div>` : '' }
          <p style="margin:18px 0 0;font-family:'Courier New',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#6a6a6a">Open the admin dashboard → Submissions tab to review and import.</p>
        ` + getEmailFooter();
        await sendEmail('glrarealty@gmail.com', `New Listing Submission: ${safeTitle}`, adminHtml);
      } catch (e) { console.error('Admin notification email error:', e.message); }

      ingestLead({ kind: 'submission', refId: sub._id, name: b.submitterName, email: b.submitterEmail, phone: b.submitterPhone,
        message: b.submitterMessage, propertyTitle: b.title, type: /LEASE/i.test(b.listingType || '') ? 'landlord' : 'seller',
        hints: { deal: /LEASE/i.test(b.listingType || '') ? 'lease_out' : 'sell', areas: [String(b.location || '').split(',').slice(-2).join(',').trim().slice(0, 40)].filter(Boolean) },
        attrib: b.src }).catch(() => {});
      res.json({ success: true, id: sub._id });
    } catch (err) {
      console.error('Submission create error:', err);
      res.status(500).json({ error: 'Could not save submission. Please try again.' });
    }
  }
);

// Admin: list all submissions (filter by status, search)
app.get('/api/admin/property-submissions', verifyToken, requirePermission('submissions_view'), async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};
    if (status && ['pending','imported','rejected'].includes(status)) filter.status = status;
    if (search) {
      const safe = String(search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: safe, $options: 'i' };
      filter.$or = [
        { title: rx }, { location: rx }, { submitterName: rx }, { submitterEmail: rx }
      ];
    }
    const subs = await PropertySubmission.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    res.json(subs);
  } catch (err) {
    console.error('Submissions list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: stats (badge count etc.)
app.get('/api/admin/property-submissions-stats', verifyToken, requirePermission('submissions_view'), async (req, res) => {
  try {
    const [pending, imported, rejected, total] = await Promise.all([
      PropertySubmission.countDocuments({ status: 'pending' }),
      PropertySubmission.countDocuments({ status: 'imported' }),
      PropertySubmission.countDocuments({ status: 'rejected' }),
      PropertySubmission.countDocuments({})
    ]);
    res.json({ pending, imported, rejected, total });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Admin: get a single submission
app.get('/api/admin/property-submissions/:id', verifyToken, requirePermission('submissions_view'), async (req, res) => {
  try {
    const sub = await PropertySubmission.findById(req.params.id).lean();
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    // Strip the Cloudinary ids before this leaves the server. The panel
    // only ever needs the name and size to draw the row; the id is what
    // a signed link is minted from, and it has no business in the DOM.
    if (Array.isArray(sub.documents)) {
      sub.documents = sub.documents.map((d, i) => ({
        idx: i, label: d.label, name: d.name, bytes: d.bytes, uploadedAt: d.uploadedAt
      }));
    }
    res.json(sub);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* Admin: open one uploaded document.
   Mints a Cloudinary signed URL good for five minutes and redirects to
   it. Nothing durable is handed out, so a link pasted into a chat or
   left in a browser history is dead within the hour. */
app.get('/api/admin/property-submissions/:id/document/:idx',
  verifyToken, requirePermission('submissions_view'), async (req, res) => {
  try {
    const sub = await PropertySubmission.findById(req.params.id).lean();
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    const idx = parseInt(req.params.idx, 10);
    const doc = Array.isArray(sub.documents) ? sub.documents[idx] : null;
    if (!doc || !doc.publicId) return res.status(404).json({ error: 'Document not found' });

    const url = cloudinary.utils.private_download_url(doc.publicId, doc.format, {
      resource_type: doc.resourceType || 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 300
    });
    // Returned as JSON rather than a 302. The dashboard authenticates with
    // a bearer token, which a plain <a href> cannot carry, and putting the
    // token in a query string to work around that would write it into
    // server logs and browser history.
    res.json({ url, name: doc.name, expiresInSeconds: 300 });
  } catch (err) {
    console.error('Document fetch error:', err.message);
    res.status(500).json({ error: 'Could not open the document' });
  }
});

// Admin: update notes / status (without importing — e.g. mark rejected, save notes)
app.put('/api/admin/property-submissions/:id', verifyToken, requirePermission('submissions_view'), async (req, res) => {
  try {
    const allowed = ['adminNotes', 'status'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (update.status && !['pending','imported','rejected'].includes(update.status)) delete update.status;
    if (update.status && update.status !== 'pending') {
      update.reviewedBy = req.user.email || '';
      update.reviewedAt = new Date();
    }
    const sub = await PropertySubmission.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    await logAudit(req, 'UPDATE', 'PropertySubmission', sub._id, sub.title, update);
    res.json(sub);
  } catch (err) {
    console.error('Submission update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: IMPORT submission → create a live Property listing
// This is the one-click "no manual re-typing" button.
app.post('/api/admin/property-submissions/:id/import', verifyToken, requirePermission('submissions_import'), async (req, res) => {
  try {
    const sub = await PropertySubmission.findById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    if (sub.status === 'imported' && sub.importedPropertyId) {
      return res.status(409).json({ error: 'This submission has already been imported.' });
    }
    // Optional overrides admin can pass when importing (e.g. "save as featured", correct title)
    const o = req.body || {};
    const property = await Property.create({
      title: (o.title || sub.title || '').trim(),
      location: (o.location || sub.location || '').trim(),
      mapLocation: o.mapLocation !== undefined ? o.mapLocation : (sub.mapLocation || ''),
      description: o.description !== undefined ? o.description : (sub.description || ''),
      propertyType: o.propertyType || sub.propertyType || 'Condominium',
      listingType: o.listingType || sub.listingType || 'FOR SALE',
      price: o.price !== undefined ? Number(o.price) : (sub.price || 0),
      monthlyRental: o.monthlyRental !== undefined ? Number(o.monthlyRental) : (sub.monthlyRental || 0),
      bedrooms: o.bedrooms !== undefined ? Number(o.bedrooms) : (sub.bedrooms || 0),
      bathrooms: o.bathrooms !== undefined ? Number(o.bathrooms) : (sub.bathrooms || 0),
      sqm: o.sqm !== undefined ? Number(o.sqm) : (sub.sqm || 0),
      landArea: o.landArea !== undefined ? Number(o.landArea) : (sub.landArea || 0),
      parking: o.parking !== undefined ? Number(o.parking) : (sub.parking || 0),
      developer: o.developer !== undefined ? o.developer : (sub.developer || ''),
      mainImage: sub.mainImage || '',
      gallery: Array.isArray(sub.gallery) ? sub.gallery : [],
      featured: !!o.featured,
      status: 'available',
      notes: `Imported from submission by ${sub.submitterName} <${sub.submitterEmail}>${sub.submitterPhone ? ' / ' + sub.submitterPhone : ''}.${sub.submitterMessage ? ' Message: ' + sub.submitterMessage : ''}`
    });
    sub.status = 'imported';
    sub.importedPropertyId = property._id.toString();
    sub.reviewedBy = req.user.email || '';
    sub.reviewedAt = new Date();
    await sub.save();
    await logAudit(req, 'IMPORT', 'PropertySubmission', sub._id, sub.title, { propertyId: property._id });
    await logAudit(req, 'CREATE', 'Property', property._id, property.title, { source: 'submission', submissionId: sub._id });
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
    scheduleSavedSearchSweep();
    scheduleGeoPass();
    res.json({ success: true, propertyId: property._id, submission: sub });
  } catch (err) {
    console.error('Submission import error:', err);
    res.status(500).json({ error: 'Could not import submission. Please try again.' });
  }
});

// Admin: delete submission (also removes Cloudinary images that aren't shared with a live Property)
app.delete('/api/admin/property-submissions/:id', verifyToken, requirePermission('submissions_delete'), async (req, res) => {
  try {
    const sub = await PropertySubmission.findById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    // Best-effort cleanup: only delete images from Cloudinary if this submission
    // was NOT yet imported. Once imported, the live Property uses the same URLs.
    if (sub.status !== 'imported') {
      const all = [sub.mainImage, ...(sub.gallery || [])].filter(Boolean);
      for (const url of all) {
        try {
          // Extract public_id from a Cloudinary URL — works for the standard format.
          const m = url.match(/\/glra_realty\/submissions\/([^/.]+)/);
          if (m) await cloudinary.uploader.destroy('glra_realty/submissions/' + m[1]);
        } catch {}
      }
    }
    await PropertySubmission.findByIdAndDelete(req.params.id);
    await logAudit(req, 'DELETE', 'PropertySubmission', req.params.id, sub.title, null);
    res.json({ success: true });
  } catch (err) {
    console.error('Submission delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// sitemap.xml is generated by buildSitemap() and registered before
// express.static — see the top of this file.

// ============ 404 ============
// Anything that reached this point matched no route and no static file.
// Without this, Express replies with a bare "Cannot GET /whatever" in plain
// text, which looks broken and advertises the framework. Registered after all
// routes but before the error handler.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const accept = req.headers.accept || '';
  if (req.method === 'GET' && accept.includes('text/html')) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
  res.status(404).type('txt').send('Not found');
});

// ============ ERROR HANDLER ============
// Catches multer errors and other middleware errors
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (err.message && (err.message.includes('CORS') || err.message.includes('Only JPEG'))) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Server error' });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║              🏠 GLRA REALTY WEBSITE IS READY!                ║
  ╠═══════════════════════════════════════════════════════════════╣
  ║   Listening on port ${String(PORT).padEnd(42)}║
  ║   Env: ${String(process.env.NODE_ENV || 'development').padEnd(55)}║
  ║   Allowed origins: ${corsAllowlist.join(', ').padEnd(43).slice(0, 43)}║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Nothing in the app requires server.js; this only lets a test script that
// loads it in-process reach the Property Finder engine directly.
module.exports._displayTitle = glraDisplayTitle;
module.exports._savedSearchTest = {
  savedSearchMatches, describeSavedSearch, normalizeSavedSearchCriteria,
  runSavedSearchSweep, buildSavedSearchAlertEmail
};
