// Load environment variables FIRST
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const brevo = require('@getbrevo/brevo');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
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

async function sendEmail(to, subject, htmlContent, fromName = 'GLRA Realty') {
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
    sendSmtpEmail.replyTo = { email: 'glrarealty@gmail.com', name: 'GLRA Realty' };
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;

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

// Helmet — sensible default security headers
app.use(helmet({
  contentSecurityPolicy: false, // disabled because static pages use inline scripts/styles; revisit later
  crossOriginEmbedderPolicy: false,
}));

// CORS — strict allowlist
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow same-origin / no-origin requests (curl, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// Body limits — sane defaults; multer handles large file uploads separately
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Strip MongoDB operator keys ($ne, $gt, etc.) from req.body, req.query, req.params
app.use(mongoSanitize());

app.use(express.static('public'));

// ============ RATE LIMITERS ============
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
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
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Strict mime whitelist — NO svg (XSS risk)
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/');
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
  TitlingCase,
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

app.get('/api/properties', async (req, res) => {
  try {
    const properties = await Property.find({ status: 'available' }).sort({ createdAt: -1 }).lean();
    properties.forEach(optimizePropertyImages);
    res.json(properties);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Single property as JSON (handy for clients / future use).
app.get('/api/properties/:id', async (req, res) => {
  try {
    const p = await Property.findById(req.params.id).lean();
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(optimizePropertyImages(p));
  } catch (err) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

// ── SEO: per-listing pages + dynamic sitemap ──────────────────
const SITE_URL = 'https://glrarealty.com';
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
  return p;
}

// Build a fully server-rendered, SEO-rich detail page for one property.
// Crawlers and social-share scrapers get real <title>, meta description,
// Open Graph image, and JSON-LD; humans get a styled page with an inquiry form.
function buildPropertyPageHtml(p) {
  const id = String(p._id);
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
  const descBase = String(p.description || '').replace(/\s+/g, ' ').trim();
  const metaDesc = (`${title}${loc ? ' in ' + loc : ''} — ${priceText}. ${descBase}`).slice(0, 160).trim();
  // Display version of the description: keep original line breaks AND put each
  // emoji-bulleted feature on its own line so long listings read as a tidy list.
  const descDisplay = String(p.description || '').trim()
    .replace(/[ \t]*(🔹|🔸|◆|●|•)[ \t]*/gu, '\n$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const gallery = (p.gallery || []).filter(Boolean);

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: title,
    description: metaDesc,
    image: ogImg,
    category: p.propertyType || 'Real Estate',
    url: canonical,
    offers: {
      '@type': 'Offer',
      price: Number(priceNum) || 0,
      priceCurrency: 'PHP',
      availability: 'https://schema.org/InStock',
      url: canonical
    }
  }).replace(/</g, '\\u003c');

  const specRows = [['Type', p.propertyType || '—']]
    .concat(p.bedrooms ? [['Bedrooms', p.bedrooms]] : [])
    .concat(p.bathrooms ? [['Bathrooms', p.bathrooms]] : [])
    .concat(p.sqm ? [['Floor area', p.sqm + ' sqm']] : [])
    .concat(p.parking ? [['Parking', p.parking]] : []);
  const specsHtml = `<div class="pg-specs">${specRows.map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join('')}</div>`;
  const thumbsHtml = gallery.length
    ? `<div class="pg-thumbs">${gallery.map(g => `<img src="${esc(absUrl(optimizeCloudinary(g)))}" alt="${esc(title)}" loading="lazy" onclick="pgSwap(this.src)">`).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script>(function(){try{if(localStorage.getItem('darkMode')==='true')document.documentElement.classList.add('dark-mode-pre')}catch(e){}})();</script>
<title>${esc(title)}${loc ? ' — ' + esc(loc) : ''} | GLRA Realty</title>
<meta name="description" content="${esc(metaDesc)}">
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
<link rel="apple-touch-icon" href="/img/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<script type="application/ld+json">${jsonld}</script>
<style>
:root{--paper:#f1eee9;--paper2:#e8e4dd;--ink:#0a0a0a;--gray:#6a6a6a;--line:#0a0a0a;--hot:#ff3d00}
body.dark-mode{--paper:#0e0e0c;--paper2:#1a1a17;--ink:#f1eee9;--gray:#9a9082;--line:#3a3a36}
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
.pg-badge{display:inline-block;background:var(--hot);color:#fff;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:700;padding:6px 12px;margin-bottom:14px}
.pg-title{font-size:38px;font-weight:900;letter-spacing:-1.5px;text-transform:uppercase;line-height:1.05;margin-bottom:8px}
.pg-loc{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gray);margin-bottom:18px}
.pg-hero-img{width:100%;height:auto;border:2px solid var(--line);margin-bottom:14px}
.pg-thumbs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}
.pg-thumbs img{width:92px;height:70px;object-fit:cover;border:2px solid var(--line);cursor:pointer}
.pg-thumbs img:hover{border-color:var(--hot)}
.pg-price{font-size:34px;font-weight:900;color:var(--hot);letter-spacing:-1px;margin:6px 0 18px}
.pg-specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:26px}
.pg-specs div{border:2px solid var(--line);padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gray);min-width:0}
.pg-specs b{display:block;font-family:'Inter',sans-serif;font-size:18px;font-weight:800;margin-top:6px;letter-spacing:-.3px;color:var(--ink);text-transform:none;overflow-wrap:break-word}
.pg-section-label{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--gray);border-bottom:2px solid var(--line);padding-bottom:8px;margin-bottom:14px}
.pg-desc{font-size:16px;line-height:1.7;white-space:pre-wrap;margin-bottom:36px}
.pg-form{border:2px solid var(--line);padding:26px;background:var(--paper2)}
.pg-form h2{font-size:24px;font-weight:900;text-transform:uppercase;letter-spacing:-.5px;margin-bottom:16px}
.pg-form input,.pg-form textarea{width:100%;padding:14px 16px;border:2px solid var(--line);background:var(--paper);color:var(--ink);font-family:'Inter',sans-serif;font-size:14px;margin-bottom:12px}
.pg-form textarea{min-height:110px;resize:vertical}
.pg-form button{background:var(--ink);color:var(--paper);border:0;padding:16px 28px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;cursor:pointer}
.pg-form button:hover{background:var(--hot);color:#fff}
.pg-foot{background:#0a0a0a;color:#f1eee9;text-align:center;padding:28px 20px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;line-height:1.9}
.pg-foot a{color:var(--hot)}
@media(max-width:600px){.pg-title{font-size:27px}.pg-price{font-size:26px}}
</style>
</head>
<body>
<nav class="pg-nav">
  <a href="/" aria-label="GLRA Realty home"><img src="/img/logo.png" alt="GLRA Realty" data-logo-auto></a>
  <a href="/properties.html" class="pg-back">← All listings</a>
</nav>
<div class="pg-wrap">
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
      <input type="text" id="pgName" placeholder="Full name" required>
      <input type="email" id="pgEmail" placeholder="Email address" required>
      <input type="tel" id="pgPhone" placeholder="Phone number">
      <textarea id="pgMsg" placeholder="Your message">I'm interested in ${esc(title)}${loc ? ' (' + esc(loc) + ')' : ''}. Please send me more details.</textarea>
      <button type="submit">Send inquiry →</button>
    </form>
    <div id="pgResult" style="margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:12px"></div>
  </div>
</div>
<div class="pg-foot">
  GLRA REALTY &middot; <a href="tel:+639171774572">+63 917 177 4572</a> &middot; <a href="mailto:glrarealty@gmail.com">glrarealty@gmail.com</a> &middot; <a href="https://glrarealty.com">glrarealty.com</a>
</div>
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
</body>
</html>`;
}

app.get('/property/:id', async (req, res) => {
  try {
    const p = await Property.findById(req.params.id);
    if (!p || p.status !== 'available') return res.redirect(302, '/properties.html');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPropertyPageHtml(p));
  } catch (err) {
    return res.redirect(302, '/properties.html');
  }
});

// Dynamic sitemap — always fresh. Lists the fixed marketing pages plus a URL
// for every available listing so Google discovers new properties quickly.
app.get('/sitemap.xml', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const staticPages = [
      ['/', 'daily', '1.0'], ['/properties.html', 'daily', '0.9'],
      ['/list-property.html', 'monthly', '0.8'], ['/about.html', 'monthly', '0.7'],
      ['/calculator.html', 'monthly', '0.6'], ['/affordability.html', 'monthly', '0.6'],
      ['/amortization.html', 'monthly', '0.6'], ['/rental-yield.html', 'monthly', '0.6'],
      ['/zonal.html', 'monthly', '0.6'], ['/ercf.html', 'monthly', '0.6'],
      ['/cost-of-ownership.html', 'monthly', '0.6'], ['/guide.html', 'monthly', '0.6'],
      ['/blog.html', 'weekly', '0.6'], ['/testimonials.html', 'monthly', '0.6'],
      ['/neighborhoods.html', 'monthly', '0.6'], ['/living-in-makati.html', 'monthly', '0.5'],
      ['/living-in-bgc.html', 'monthly', '0.5'], ['/living-in-alabang.html', 'monthly', '0.5']
    ];
    const props = await Property.find({ status: 'available' }, { _id: 1, createdAt: 1, priceUpdatedAt: 1 })
      .sort({ createdAt: -1 }).limit(5000).lean();
    const urls = staticPages.map(([loc, freq, pri]) =>
      `  <url><loc>${SITE_URL}${loc}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`);
    props.forEach(pr => {
      const lm = new Date(pr.priceUpdatedAt || pr.createdAt || Date.now()).toISOString().slice(0, 10);
      urls.push(`  <url><loc>${SITE_URL}/property/${pr._id}</loc><lastmod>${lm}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
    });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
  } catch (err) {
    console.error('sitemap error:', err);
    res.status(500).send('');
  }
});

app.get('/api/hero-images', async (req, res) => {
  try {
    const images = await HeroImage.find().sort({ order: 1 }).lean();
    images.forEach(i => { if (i.url) i.url = optimizeCloudinary(i.url); });
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
  handleValidation,
  async (req, res) => {
    try {
      const { name, email, phone = '', message, propertyId = null, propertyTitle = null } = req.body;
      const inquiry = new Inquiry({ name, email, phone, message, propertyId, propertyTitle });
      await inquiry.save();
      console.log('📧 New inquiry from:', name);

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



// ============ SUBSCRIPTION ROUTES ============

app.post('/api/subscribe',
  publicWriteLimiter,
  body('email').isEmail().normalizeEmail(),
  body('name').optional().isString().trim().isLength({ max: 200 }),
  body('source').optional().isString().trim().isLength({ max: 100 }),
  handleValidation,
  async (req, res) => {
    try {
      const { email, name, source } = req.body;

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

// ============ WISHLIST ROUTES ============

app.post('/api/wishlist',
  publicWriteLimiter,
  body('email').isEmail().normalizeEmail(),
  body('propertyId').isString().trim().isLength({ min: 1, max: 100 }),
  body('propertyTitle').optional().isString().trim().isLength({ max: 300 }),
  body('propertyPrice').optional().isNumeric(),
  body('propertyLocation').optional().isString().trim().isLength({ max: 300 }),
  body('propertyImage').optional().isString().trim().isLength({ max: 1000 }),
  handleValidation,
  async (req, res) => {
    try {
      const { email, propertyId, propertyTitle = '', propertyPrice = 0, propertyLocation = '', propertyImage = '' } = req.body;

      const existing = await Wishlist.findOne({ email, propertyId });
      if (existing) {
        return res.json({ success: true, message: 'Already saved to wishlist' });
      }

      const wishlistItem = new Wishlist({ email, propertyId, propertyTitle, propertyPrice, propertyLocation, propertyImage });
      await wishlistItem.save();

      const existingSubscriber = await Subscriber.findOne({ email });
      if (!existingSubscriber) {
        await Subscriber.create({ email, source: 'wishlist', preferences: { priceDrops: true } });
      }

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

app.get('/api/wishlist/:email', async (req, res) => {
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

app.delete('/api/wishlist/:email/:propertyId', async (req, res) => {
  try {
    const email = String(req.params.email).toLowerCase();
    const propertyId = String(req.params.propertyId);
    await Wishlist.findOneAndDelete({ email, propertyId });
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
  handleValidation,
  async (req, res) => {
    try {
      const { email, propertyId, propertyTitle = '', propertyPrice = 0 } = req.body;

      const existing = await PriceAlert.findOne({ email, propertyId });
      if (existing) {
        return res.json({ success: true, message: 'Already subscribed to price alerts for this property' });
      }

      const alert = new PriceAlert({ email, propertyId, propertyTitle, propertyPrice });
      await alert.save();

      const existingSubscriber = await Subscriber.findOne({ email });
      if (!existingSubscriber) {
        await Subscriber.create({ email, source: 'price_alert', preferences: { priceDrops: true } });
      }

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

app.get('/api/price-alert/check/:propertyId', async (req, res) => {
  try {
    const propertyId = String(req.params.propertyId);
    const alerts = await PriceAlert.find({ propertyId, isNotified: false });
    res.json({ count: alerts.length });
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
      account.lastLogin = new Date();
      await account.save();

      const token = signToken(account);
      // Log audit (synthetically pass user via req.user)
      req.user = { email: account.email, name: account.name, role: account.role };
      await logAudit(req, 'LOGIN', 'Session', '', '', null);

      // Compute effective permissions: admins always get all, employees get their stored object
      const effectivePerms = account.role === 'admin'
        ? defaultPermissionsForRole('admin')
        : (account.permissions || defaultPermissionsForRole('employee'));

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

// ============ PROTECTED ADMIN ROUTES ============
// All routes below require a valid JWT.

app.get('/api/admin/me', verifyToken, async (req, res) => {
  try {
    const account = await Account.findById(req.user.sub).select('email name role permissions isActive').lean();
    if (!account || account.isActive === false) {
      return res.status(401).json({ error: 'Account inactive' });
    }
    const effectivePerms = account.role === 'admin'
      ? defaultPermissionsForRole('admin')
      : (account.permissions || defaultPermissionsForRole('employee'));
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

app.get('/api/admin/accounts', verifyToken, async (req, res) => {
  try {
    const accounts = await Account.find({}, { password: 0 }).sort({ createdAt: 1 });
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

app.get('/api/admin/subscribers', verifyToken, async (req, res) => {
  try {
    const subscribers = await Subscriber.find().sort({ subscribedAt: -1 });
    res.json(subscribers);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
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

app.get('/api/admin/all-properties', verifyToken, async (req, res) => {
  try {
    const properties = await Property.find().sort({ createdAt: -1 });
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

app.post('/api/admin/properties', verifyToken, requirePermission('properties_create'), async (req, res) => {
  try {
    const property = new Property(req.body);
    await property.save();
    await logAudit(req, 'CREATE', 'Property', property._id, property.title, null);
    invalidateChatListingsCache();
    res.json(property);
  } catch (err) {
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
    res.json(property);
  } catch (err) {
    console.error('Error updating property:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/properties/:id', verifyToken, requirePermission('properties_delete'), async (req, res) => {
  try {
    const property = await Property.findByIdAndDelete(req.params.id);
    if (property) await logAudit(req, 'DELETE', 'Property', req.params.id, property.title, null);
    invalidateChatListingsCache();
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
    const images = await HeroImage.find().sort({ order: 1 });
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
          </div>
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
    res.json(sub);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
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

// sitemap.xml is now served by express.static('public') — no custom route needed.

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
  ║   Allowed origins: ${(allowedOrigins.join(', ') || '(any)').padEnd(43).slice(0, 43)}║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
});
