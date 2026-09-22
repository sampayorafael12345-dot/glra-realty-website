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
      'https://*.clarity.ms', 'https://c.bing.com'],
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
      'https://cdn.jsdelivr.net', 'https://latest.currency-api.pages.dev'],
    'frame-src': ["'self'", 'https://www.google.com'],  // property-page map embed
    'media-src': ["'self'"],
    // Without this, manifest-src falls back to default-src. That happens to be
    // 'self' and so happens to work - but the day this policy is enforced is
    // not the day to find out by having every home-screen icon stop working.
    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],                            // service worker
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
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
]);
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
const {
  Property, Inquiry, HeroImage, Subscriber, PriceAlert, Wishlist,
  AlertLog, AuditLog, Account, Task, PropertySubmission, ScheduledEmail,
  TitlingCase, NotarialJob, CashEntry, SiteStat, CalcUsage,
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
// listing imported from a "List your property" submission).
const PUBLIC_PROPERTY_FIELDS = [
  '_id', 'title', 'location', 'price', 'monthlyRental', 'bedrooms', 'bathrooms',
  'sqm', 'landArea', 'description', 'mainImage', 'gallery', 'featured', 'status',
  'listingType', 'propertyType', 'parking', 'parkingPrice', 'additionalParkingStatus',
  'mapLocation', 'pricePerSqm', 'developer', 'previousPrice', 'priceUpdatedAt',
  'views', 'createdAt'
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
function invalidatePublicListingsCache() { _publicListCache = { at: 0, body: null }; }

app.get('/api/properties', async (req, res) => {
  try {
    if (_publicListCache.body && Date.now() - _publicListCache.at < PUBLIC_LIST_TTL_MS) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      return res.type('application/json').send(_publicListCache.body);
    }
    const properties = await Property.find({ status: 'available' })
      .select(PUBLIC_PROPERTY_FIELDS).sort({ createdAt: -1 }).lean();
    properties.forEach(optimizePropertyImages);
    _publicListCache = { at: Date.now(), body: JSON.stringify(properties) };
    // A minute of freshness for the browser too: repeat views and back-
    // navigation never reach Render at all.
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.type('application/json').send(_publicListCache.body);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Serves a listing photo that lives in the database as a base64 data: URI as a
// real image response. Immutable + long-lived: the bytes for a given property
// image never change, so browsers and the service worker cache it after one hit.
app.get('/api/property-image/:id/:key', async (req, res) => {
  try {
    const p = await Property.findById(req.params.id, { mainImage: 1, gallery: 1 }).lean();
    if (!p) return res.status(404).end();
    const key = req.params.key;
    const raw = key === 'main' ? p.mainImage : (p.gallery || [])[Number(key)];
    const m = isDataUri(raw) && raw.match(/^data:([\w.+/-]+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    const buf = Buffer.from(m[2], 'base64');
    res.set('Content-Type', m[1]);
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
app.post('/api/properties/:id/view', publicWriteLimiter, async (req, res) => {
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
function optimizePropertyImages(p) {
  if (!p) return p;
  if (p.mainImage) p.mainImage = optimizeCloudinary(p.mainImage);
  if (Array.isArray(p.gallery)) p.gallery = p.gallery.map(optimizeCloudinary);
  return externalizeInlineImages(p);
}

// Some listings have their photo stored in the database as a base64 "data:"
// URI instead of a hosted URL. Those blobs were being inlined into every JSON
// response: one 3 MB photo made up 98% of the entire /api/properties payload,
// so every visitor downloaded megabytes of text before a single card appeared.
// They also can't be used as an og:image or a sitemap image (a data: URI is not
// a fetchable URL). Swap them for a real image endpoint — the JSON stays small
// and the browser loads the photo as a normal, cacheable, parallel request.
function isDataUri(v) { return typeof v === 'string' && v.startsWith('data:'); }

function externalizeInlineImages(p) {
  if (!p || !p._id) return p;
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
  ['makati',      'Makati',                 /\b(makati|legaspi village|salcedo village|rockwell|poblacion)\b/i, 'living-in-makati.html'],
  ['bgc',         'Bonifacio Global City',  /\b(bgc|bonifacio global|forbestown|mckinley|fort bonifacio|uptown bonifacio)\b/i, 'living-in-bgc.html'],
  ['taguig',      'Taguig',                 /\btaguig\b/i, 'living-in-bgc.html'],
  ['quezon-city', 'Quezon City',            /\b(quezon city|vertis north|eastwood|katipunan|cubao|diliman|novaliches|pasong putik)\b/i, ''],
  ['manila',      'Manila',                 /\b(manila city|city of manila|ermita|malate|sampaloc|binondo|intramuros|paco|santa cruz)\b/i, ''],
  ['mandaluyong', 'Mandaluyong',            /\b(mandaluyong|wack wack|greenfield district)\b/i, ''],
  ['pasig',       'Pasig',                  /\b(pasig|oranbo|caniogan|kapitolyo|ortigas east|ortigas center)\b/i, ''],
  ['pasay',       'Pasay',                  /\b(pasay|mall of asia|\bmoa\b|bay area)\b/i, ''],
  ['alabang',     'Alabang and Muntinlupa', /\b(alabang|muntinlupa|filinvest city)\b/i, 'living-in-alabang.html'],
  ['paranaque',   'Paranaque',              /\b(para\u00f1aque|paranaque|bf homes|better living|sucat)\b/i, ''],
  ['san-juan',    'San Juan',               /\bsan juan\b/i, ''],
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
    const img = p.mainImage ? absUrl(optimizeCloudinary(p.mainImage)) : '/img/social-card.png';
    const specs = [p.bedrooms ? p.bedrooms + ' BR' : '', p.bathrooms ? p.bathrooms + ' BA' : '',
                   p.sqm ? p.sqm + ' sqm' : ''].filter(Boolean).join(' \u00b7 ');
    return `<a class="ar-card" href="/property/${String(p._id)}">
      <img src="${esc(img)}" alt="${esc(p.title || 'Property')}" loading="lazy" width="320" height="200">
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
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<script type="application/ld+json">${jsonld}</script>
<style>
:root{--paper:#f1eee9;--paper2:#e8e4dd;--ink:#0a0a0a;--gray:#5f5b55;--line:#0a0a0a;--hot:#ff3d00;--hot-text:#c02e00;--hot-btn:#df3500}
body.dark-mode{--paper:#0e0e0c;--paper2:#1a1a17;--ink:#f1eee9;--gray:#9a9082;--line:#3a3a36;--hot-text:#ff3d00;--hot-btn:#df3500}
html.dark-mode-pre,html.dark-mode-pre body{background:#0e0e0c;color:#f1eee9}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:var(--paper);color:var(--ink)}
body{font-family:'Inter',system-ui,sans-serif;line-height:1.5;font-weight:500}
img{display:block;max-width:100%}
a{color:inherit;text-decoration:none}
.ar-nav{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:2px solid var(--line);background:var(--paper)}
.ar-nav img{height:50px;width:auto}
.ar-back{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border:2px solid var(--line);padding:9px 16px}
.ar-back:hover{background:var(--hot);color:#fff;border-color:var(--hot)}
.ar-wrap{max-width:1180px;margin:0 auto;padding:26px 24px 60px}
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
  .ar-nav{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}
}
@media(max-width:560px){.ar-wrap{padding:20px 16px 46px}.ar-nav{padding:14px 16px}}
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
<script src="/js/a11y.js?v=100" defer></script>
</body>
</html>`;
}



// Build a fully server-rendered, SEO-rich detail page for one property.
// Crawlers and social-share scrapers get real <title>, meta description,
// Open Graph image, and JSON-LD; humans get a styled page with an inquiry form.
function buildPropertyPageHtml(p, related) {
  const id = String(p._id);
  // Turn any base64 photo into a real image URL first, so the og:image, the
  // gallery and the <img> tags below all point at something fetchable rather
  // than embedding megabytes of base64 in the HTML.
  externalizeInlineImages(p);
  const title = p.title || 'Property';
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
  const heroImg = absUrl(optimizeCloudinary(rawImg)); // optimized (WebP/AVIF) for fast on-page display
  const canonical = `${SITE_URL}/property/${id}`;
  // Cleaned first: Google was being handed the emoji and hashtags as the
  // search snippet for every listing.
  const descBase = glraCleanDescription(p.description).replace(/\s+/g, ' ').trim();
  const metaDesc = (`${title}${loc ? ' in ' + loc : ''} — ${priceText}. ${descBase}`).slice(0, 160).trim();
  // Descriptions are written as Facebook posts and imported as typed, so they
  // arrive with emoji on every line, the broker's own contact block, a markdown
  // mail link that renders as raw text, and a tail of hashtags. Cleaned at
  // render time rather than in the database, so the next import cannot bring it
  // back — which is what kept happening.
  const descDisplay = glraCleanDescription(p.description);
  const gallery = (p.gallery || []).filter(Boolean);

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
    '@type': p.propertyType === 'House and Lot' ? 'SingleFamilyResidence'
      : p.propertyType === 'Lot' ? 'Place' : 'Apartment',
    '@id': canonical + '#home',
    name: title,
    address: {
      '@type': 'PostalAddress',
      addressLocality: loc || 'Metro Manila',
      addressRegion: 'Metro Manila',
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
  if (galleryAbs.length || ogImg) residence.photo = galleryAbs.length ? galleryAbs : [ogImg];

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
        offers: {
          '@type': 'Offer',
          price: Number(priceNum) || 0,
          priceCurrency: 'PHP',
          availability: 'https://schema.org/InStock',
          businessFunction: isLease
            ? 'http://purl.org/goodrelations/v1#LeaseOut'
            : 'http://purl.org/goodrelations/v1#Sell',
          url: canonical,
          seller: { '@type': 'RealEstateAgent', name: 'GLRA Realty', url: SITE_URL }
        }
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
      const rLease = String(r.listingType || '').toUpperCase().includes('LEASE');
      const rPrice = rLease ? (r.monthlyRental || r.price || 0) : (r.price || 0);
      const rTxt = rPrice ? ('₱' + Number(rPrice).toLocaleString('en-PH') + (rLease ? '/mo' : '')) : 'Price on request';
      const rImg = r.mainImage ? absUrl(optimizeCloudinary(r.mainImage)) : '/img/social-card.png';
      return `<a class="pg-rel" href="/property/${String(r._id)}">
        <img src="${esc(rImg)}" alt="${esc(r.title || 'Property')}" loading="lazy" width="200" height="140">
        <span class="pg-rel-t">${esc(r.title || 'Property')}</span>
        <span class="pg-rel-l">${esc(r.location || '')}</span>
        <span class="pg-rel-p">${esc(rTxt)}</span>
      </a>`;
    }).join('')}
  </div>` : '';

  const specRows = [['Type', p.propertyType || '—']]
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
  const thumbsHtml = gallery.length
    ? `<div class="pg-thumbs">${gallery.map(g => `<img src="${esc(absUrl(optimizeCloudinary(g)))}" alt="${esc(title)}" loading="lazy" onclick="pgSwap(this.src)">`).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<script>(function(){try{if(localStorage.getItem('darkMode')==='true')document.documentElement.classList.add('dark-mode-pre')}catch(e){}})();</script>
<title>${esc(title)}${loc ? ' — ' + esc(loc) : ''} | GLRA Realty</title>
<meta name="description" content="${esc(metaDesc)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)} | GLRA Realty">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="${esc(ogImg)}">${ogIsCloudinary ? `
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">` : ''}
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)} | GLRA Realty">
<meta name="twitter:description" content="${esc(metaDesc)}">
<meta name="twitter:image" content="${esc(ogImg)}">
<link rel="icon" type="image/png" href="/img/favicon-64.png">
<link rel="apple-touch-icon" sizes="180x180" href="/img/icon-180.png">
<link rel="preconnect" href="https://res.cloudinary.com" crossorigin>
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preload" as="image" href="${esc(heroImg)}" fetchpriority="high">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<script type="application/ld+json">${jsonld}</script>
<style>
:root{--paper:#f1eee9;--paper2:#e8e4dd;--ink:#0a0a0a;--gray:#656565;--line:#0a0a0a;--hot:#ff3d00;--hot-text:#c02e00;--hot-btn:#df3500}
body.dark-mode{--paper:#0e0e0c;--paper2:#1a1a17;--ink:#f1eee9;--gray:#9a9082;--line:#3a3a36;--hot-text:#ff3d00;--hot-btn:#df3500}
html.dark-mode-pre,html.dark-mode-pre body{background:#0e0e0c;color:#f1eee9}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:var(--paper);color:var(--ink)}
body{font-family:'Inter',system-ui,sans-serif;line-height:1.5;font-weight:500}
img{display:block;max-width:100%}
a{color:inherit;text-decoration:none}
.pg-nav{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:2px solid var(--line);background:var(--paper)}
.pg-nav img{height:50px;width:auto}
.pg-back{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border:2px solid var(--line);padding:9px 16px}
.pg-back:hover{background:var(--hot);color:#fff;border-color:var(--hot)}
.pg-wrap{max-width:1100px;margin:0 auto;padding:30px 24px 60px}
.pg-badge{display:inline-block;background:var(--hot-btn);color:#fff;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:700;padding:6px 12px;margin-bottom:14px}
.pg-title{font-size:38px;font-weight:900;letter-spacing:-1.5px;text-transform:uppercase;line-height:1.05;margin-bottom:8px}
.pg-loc{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gray);margin-bottom:18px}
.pg-hero-img{width:100%;height:auto;border:2px solid var(--line);margin-bottom:14px}
.pg-thumbs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}
.pg-thumbs img{width:92px;height:70px;object-fit:cover;border:2px solid var(--line);cursor:pointer}
.pg-thumbs img:hover{border-color:var(--hot)}
.pg-price{font-size:34px;font-weight:900;color:var(--hot-text);letter-spacing:-1px;margin:6px 0 18px}
.pg-specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:26px}
.pg-specs div{border:2px solid var(--line);padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);min-width:0}
.pg-specs b{display:block;font-family:'Inter',sans-serif;font-size:18px;font-weight:800;margin-top:6px;letter-spacing:-.3px;color:var(--ink);text-transform:none;overflow-wrap:break-word}
.pg-section-label{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--gray);border-bottom:2px solid var(--line);padding-bottom:8px;margin-bottom:14px}
.pg-desc{font-size:16px;line-height:1.7;white-space:pre-wrap;margin-bottom:36px}
.pg-crumbs{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);margin-bottom:16px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pg-crumbs a{border-bottom:1px solid transparent;display:inline-flex;align-items:center;min-height:24px}
.pg-crumbs a:hover{color:var(--hot-text);border-bottom-color:var(--hot)}
.pg-crumbs span[aria-current]{color:var(--ink);font-weight:700;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-related{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;margin-bottom:40px}
.pg-rel{display:block;border:2px solid var(--line);background:var(--paper2);padding:0 0 12px}
.pg-rel:hover{border-color:var(--hot)}
.pg-rel img{width:100%;height:140px;object-fit:cover;border-bottom:2px solid var(--line);margin-bottom:10px}
.pg-rel-t{display:block;padding:0 12px;font-size:14px;font-weight:800;line-height:1.25;letter-spacing:-.2px;margin-bottom:4px}
.pg-rel-l{display:block;padding:0 12px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);margin-bottom:6px}
.pg-rel-p{display:block;padding:0 12px;font-size:15px;font-weight:900;color:var(--hot-text);letter-spacing:-.3px}
.pg-form{border:2px solid var(--line);padding:26px;background:var(--paper2)}
.pg-form h2{font-size:24px;font-weight:900;text-transform:uppercase;letter-spacing:-.5px;margin-bottom:16px}
.pg-form input,.pg-form textarea{width:100%;padding:14px 16px;border:2px solid var(--line);background:var(--paper);color:var(--ink);font-family:'Inter',sans-serif;font-size:14px;margin-bottom:12px}
.pg-form textarea{min-height:110px;resize:vertical}
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
  .pg-nav{padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right))}
}
.pg-lbl{display:block;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gray);margin:14px 0 6px}
.pg-opt{text-transform:none;letter-spacing:0}
.pg-foot{--hot-text:#ff3d00}
.pg-foot a{color:var(--hot-text)}
@media(max-width:600px){.pg-title{font-size:27px}.pg-price{font-size:26px}}
</style>
</head>
<body>
<nav class="pg-nav">
  <a href="/" aria-label="GLRA Realty home"><img src="/img/logo-384.png" alt="GLRA Realty" width="384" height="384" data-logo-auto></a>
  <a href="/properties.html" class="pg-back">← All listings</a>
</nav>
<main class="pg-wrap" id="main" tabindex="-1">
  ${crumbHtml}
  <span class="pg-badge">${esc(lt)}</span>
  <h1 class="pg-title">${esc(title)}</h1>
  <div class="pg-loc"><i class="fas fa-map-marker-alt"></i> ${esc(loc)}</div>
  <img id="pgHero" class="pg-hero-img" src="${esc(heroImg)}" alt="${esc(title)}">
  ${thumbsHtml}
  <div class="pg-price">${esc(priceText)}</div>
  ${specsHtml}
  ${descDisplay ? `<div class="pg-section-label">Description</div><div class="pg-desc">${esc(descDisplay)}</div>` : ''}
  <div class="pg-form">
    <h2>Inquire about this property</h2>
    <form id="pgForm" onsubmit="return pgSubmit(event)">
      <label class="pg-lbl" for="pgName">Full name</label><input type="text" id="pgName" name="name" autocomplete="name" placeholder="Full name" required>
      <label class="pg-lbl" for="pgEmail">Email address</label><input type="email" id="pgEmail" name="email" autocomplete="email" placeholder="Email address" required>
      <label class="pg-lbl" for="pgPhone">Phone number <span class="pg-opt">(optional)</span></label><input type="tel" id="pgPhone" name="phone" autocomplete="tel" placeholder="Phone number">
      <label class="pg-lbl" for="pgMsg">Your message</label><textarea id="pgMsg" name="message" placeholder="Your message">I'm interested in ${esc(title)}${loc ? ' (' + esc(loc) + ')' : ''}. Please send me more details.</textarea>
      <button type="submit">Send inquiry →</button>
    </form>
    <div id="pgResult" style="margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:12px"></div>
  </div>
  ${relatedHtml}
</main>
<footer class="pg-foot">
  GLRA REALTY &middot; <a href="tel:+639171774572">+63 917 177 4572</a> &middot; <a href="mailto:glrarealty@gmail.com">glrarealty@gmail.com</a> &middot; <a href="https://glrarealty.com">glrarealty.com</a>
</footer>
<div class="floating-buttons">
  <a href="tel:+639171774572" class="floating-btn btn-call" aria-label="Call us"><i class="fas fa-phone-alt"></i></a>
  <a href="https://wa.me/639171774572" class="floating-btn btn-whatsapp" target="_blank" rel="noopener" aria-label="WhatsApp"><i class="fab fa-whatsapp"></i></a>
  <a href="viber://chat?number=%2B639171774572" class="floating-btn btn-viber" aria-label="Viber"><i class="fab fa-viber"></i></a>
  <button class="floating-btn btn-darkmode" id="floatingDarkModeToggle" onclick="toggleDarkMode()" aria-label="Toggle dark mode"><i class="fas fa-moon"></i></button>
</div>
<script>
function pgSwap(src){ var h=document.getElementById('pgHero'); if(h) h.src=src; }
async function pgSubmit(e){
  e.preventDefault();
  var btn = e.target.querySelector('button');
  var result = document.getElementById('pgResult');
  var payload = {
    name: document.getElementById('pgName').value.trim(),
    email: document.getElementById('pgEmail').value.trim(),
    phone: document.getElementById('pgPhone').value.trim(),
    message: document.getElementById('pgMsg').value.trim() || ('Inquiry about ' + ${JSON.stringify(title)}),
    propertyId: ${JSON.stringify(id)},
    propertyTitle: ${JSON.stringify(title)}
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
<script src="/js/main.js"></script>
<script src="/js/a11y.js?v=100" defer></script>
</body>
</html>`;
}

app.get('/property/:id', async (req, res) => {
  try {
    // Same whitelist the public API uses: the commission and the owner's
    // contact details in `notes` have no business being loaded into a page
    // renderer, even one that does not print them.
    const p = await Property.findById(req.params.id).select(PUBLIC_PROPERTY_FIELDS).lean();
    if (!p || p.status !== 'available') return res.redirect(302, '/properties.html');
    // Neighbours to link to. Preference order: same area, then same kind of
    // property, then simply the newest - so the block is never empty and a
    // crawler always has somewhere to go from here.
    const related = await findRelatedListings(p);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPropertyPageHtml(p, related));
  } catch (err) {
    return res.redirect(302, '/properties.html');
  }
});

// Up to six other available listings worth linking to from a listing page.
// Cheap: one indexed query, a small projection, and the result is only used to
// print six anchors.
const RELATED_FIELDS = '_id title location price monthlyRental listingType mainImage propertyType';
async function findRelatedListings(p) {
  const id = p._id;
  const out = [];
  const seen = new Set([String(id)]);
  const push = rows => rows.forEach(r => {
    if (out.length >= 6 || seen.has(String(r._id))) return;
    seen.add(String(r._id)); out.push(r);
  });
  // The first word or two of a location is the area name ("Makati City, Metro
  // Manila" -> "Makati"). A prefix match keeps it to one index range.
  const area = String(p.location || '').split(/[,\-]/)[0].trim();
  try {
    if (area.length >= 3) {
      push(await Property.find({
        status: 'available', _id: { $ne: id },
        location: new RegExp('^' + area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }).select(RELATED_FIELDS).sort({ createdAt: -1 }).limit(6).lean());
    }
    if (out.length < 6 && p.propertyType) {
      push(await Property.find({ status: 'available', _id: { $ne: id }, propertyType: p.propertyType })
        .select(RELATED_FIELDS).sort({ createdAt: -1 }).limit(6).lean());
    }
    if (out.length < 6) {
      push(await Property.find({ status: 'available', _id: { $ne: id } })
        .select(RELATED_FIELDS).sort({ createdAt: -1 }).limit(6).lean());
    }
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
      ['/rent-vs-buy.html', 'monthly', '0.6'], ['/loan-comparison.html', 'monthly', '0.6'],
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
      { _id: 1, createdAt: 1, priceUpdatedAt: 1, title: 1, mainImage: 1, gallery: 1, location: 1 })
      .sort({ createdAt: -1 }).limit(5000).lean();
    // A base64 photo is not a fetchable image URL — without this it would be
    // pasted into <image:loc> and balloon the sitemap to megabytes.
    props.forEach(externalizeInlineImages);

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
      const shots = [pr.mainImage, ...(pr.gallery || [])].filter(Boolean).slice(0, 6);
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
    const buf = Buffer.from(m[2], 'base64');
    res.set('Content-Type', m[1]);
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
  handleValidation,
  async (req, res) => {
    try {
      const { name, email, phone = '', message, propertyId = null, propertyTitle = null, vid } = req.body;
      const inquiry = new Inquiry({ name, email, phone, message, propertyId, propertyTitle });
      await inquiry.save();
      console.log('📧 New inquiry from:', name);

      // The valuation tool posts here, so this is a real identity signal.
      await stitchCalcIdentity(vid, email);

      // Confirmation email to user
      const userEmailHtml = getEmailHeader() + `
        <h2 style="color: #0a0a0a; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 22px; margin: 0 0 8px 0;">Dear ${esc(name)},</h2>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">Thank you for reaching out to GLRA Realty. We have received your inquiry and our team will respond within 24 hours.</p>

        <div style="background-color: #e8e4dd; border-left: 3px solid #ff3d00; padding: 18px 20px; margin: 25px 0; border-radius:0;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #0a0a0a;">Your Message:</p>
          <p style="margin: 0; color: #0a0a0a; font-size: 14px; line-height: 1.5;">${esc(message)}</p>
          ${propertyTitle ? `<p style="margin: 12px 0 0 0; color: #0a0a0a; font-size: 13px;"><strong>Property of Interest:</strong> ${esc(propertyTitle)}</p>` : ''}
        </div>

        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px;">We look forward to assisting you with your real estate needs.</p>
        <p style="color: #0a0a0a; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      await sendEmail(email, 'Thank you for contacting GLRA Realty', userEmailHtml);

      // Admin notification
      const adminEmailHtml = getEmailHeader() + `
        <h2 style="color: #ff3d00; font-family: Inter,Helvetica,Arial,sans-serif; font-size: 20px; margin: 0 0 15px 0;">New Inquiry Received</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Name</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(name)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Email</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(email)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Phone</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(phone) || 'Not provided'}</td></tr>
          ${propertyTitle ? `<tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(propertyTitle)}</td></tr>` : ''}
          <tr><td style="padding: 8px 0; font-weight: 600; vertical-align: top;">Message</td><td style="padding: 8px 0;">${esc(message)}</td></tr>
        </table>
        <p><a href="https://glrarealty.com/admin.html" style="background-color: #ff3d00; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius:0; display: inline-block;">View in Admin Dashboard</a></p>
      ` + getEmailFooter();
      await sendEmail('glrarealty@gmail.com', 'New Property Inquiry - GLRA Realty', adminEmailHtml);

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
// /api/admin/wishlist. They are staff-only now. If a "my saved properties"
// page is ever built for visitors it needs a one-time emailed link, not a
// bare address in the URL.
app.get('/api/wishlist/:email', verifyToken, async (req, res) => {
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

app.delete('/api/wishlist/:email/:propertyId', verifyToken, async (req, res) => {
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
// /api/admin/price-alerts. Staff-only now, and countDocuments instead of
// pulling every matching row back just to measure the array.
app.get('/api/price-alert/check/:propertyId', verifyToken, async (req, res) => {
  try {
    const propertyId = String(req.params.propertyId);
    const count = await PriceAlert.countDocuments({ propertyId, isNotified: false });
    res.json({ count });
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
      properties, inquiries, heroImages, subscribers, priceAlerts, wishlists,
      accounts, tasks, submissions, scheduledEmails, titlingCases, notarialJobs,
      cashEntries, auditLogs, alertLogs
    ] = await Promise.all([
      Property.find().lean(),
      Inquiry.find().lean(),
      HeroImage.find().lean(),
      Subscriber.find().lean(),
      PriceAlert.find().lean(),
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
      properties, inquiries, heroImages, subscribers, priceAlerts, wishlists,
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

app.post('/api/admin/properties', verifyToken, requirePermission('properties_create'), async (req, res) => {
  try {
    const property = new Property(req.body);
    await property.save();
    await logAudit(req, 'CREATE', 'Property', property._id, property.title, null);
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
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
    const updatedData = req.body;

    if (oldProperty.price !== updatedData.price && updatedData.price < oldProperty.price) {
      updatedData.previousPrice = oldProperty.price;
      updatedData.priceUpdatedAt = new Date();
      console.log(`💰 Price drop: ${oldProperty.title}: ₱${oldProperty.price.toLocaleString()} → ₱${updatedData.price.toLocaleString()}`);

      const alerts = await PriceAlert.find({ propertyId: req.params.id, isNotified: false });
      if (alerts.length > 0) {
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
          await sendEmail(alert.email, `Price Drop Alert: ${oldProperty.title}`, priceDropHtml);

          alert.isNotified = true;
          alert.notifiedAt = new Date();
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
      }
    }

    const property = await Property.findByIdAndUpdate(req.params.id, updatedData, { new: true });
    await logAudit(req, 'UPDATE', 'Property', req.params.id, property.title, null);
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
    res.json(property);
  } catch (err) {
    const why = schemaProblem(err);
    if (why) return res.status(400).json({ error: why });
    console.error('Error updating property:', err);
    res.status(500).json({ error: 'Server error' });
  }
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
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'glra_realty/titling', resource_type: 'auto' });
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
        await new Property(prop).save();
        added++;
      }
    }
    await logAudit(req, 'BULK_CREATE', 'Property', '', `${added} added`, null);
    invalidateChatListingsCache();
    invalidatePublicListingsCache();
    invalidateAreaCache();
    res.json({ success: true, added });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Property image upload — gated by properties_upload_image permission
app.post('/api/admin/upload-property-image', verifyToken, requirePermission('properties_upload_image'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'glra_realty/properties',
      transformation: [{ width: 1200, height: 800, crop: 'limit' }, { quality: 'auto' }]
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
      resource_type: 'auto'
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
    body('mainImage').optional({ checkFalsy: true }).isURL(),
    body('gallery').optional({ checkFalsy: true }).isArray({ max: 20 })
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
