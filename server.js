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
const REQUIRED_ENV = ['MONGODB_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('Create a .env file based on .env.example before starting the server.\n');
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

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many chat requests. Slow down.' },
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

// ============ MONGOOSE ============
const MONGODB_URI = process.env.MONGODB_URL;

const propertySchema = new mongoose.Schema({
  title: { type: String, default: '' },
  location: { type: String, default: '' },
  price: { type: Number, default: 0 },
  monthlyRental: { type: Number, default: 0 },
  bedrooms: { type: Number, default: 0 },
  bathrooms: { type: Number, default: 0 },
  sqm: { type: Number, default: 0 },
  landArea: { type: Number, default: 0 },
  description: { type: String, default: '' },
  mainImage: { type: String, default: '' },
  gallery: { type: [String], default: [] },
  featured: { type: Boolean, default: false },
  status: { type: String, default: 'available' },
  listingType: { type: String, default: 'FOR SALE' },
  propertyType: { type: String, default: 'Condominium' },
  parking: { type: Number, default: 0 },
  mapLocation: { type: String, default: '' },
  pricePerSqm: { type: String, default: '' },
  commission: { type: Number, default: 0 },
  fixedAmount: { type: Number, default: 0 },
  totalCommission: { type: Number, default: 0 },
  parkingPrice: { type: Number, default: 0 },
  additionalParkingStatus: { type: String, default: '' },
  developer: { type: String, default: '' },
  notes: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  previousPrice: { type: Number, default: 0 },
  priceUpdatedAt: { type: Date, default: null }
});

const inquirySchema = new mongoose.Schema({
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  message: { type: String, default: '' },
  propertyId: { type: String, default: null },
  propertyTitle: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

const heroImageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  source: { type: String, default: 'footer' },
  preferences: {
    priceDrops: { type: Boolean, default: true }
  },
  subscribedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }
});

const priceAlertSchema = new mongoose.Schema({
  email: { type: String, required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, default: '' },
  propertyPrice: { type: Number, default: 0 },
  notifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  isNotified: { type: Boolean, default: false }
});

const wishlistSchema = new mongoose.Schema({
  email: { type: String, required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, default: '' },
  propertyPrice: { type: Number, default: 0 },
  propertyLocation: { type: String, default: '' },
  propertyImage: { type: String, default: '' },
  addedAt: { type: Date, default: Date.now }
});

const alertLogSchema = new mongoose.Schema({
  type: { type: String, enum: ['price_drop'], required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, required: true },
  oldPrice: { type: Number, default: 0 },
  newPrice: { type: Number, default: 0 },
  sentTo: { type: Number, default: 0 },
  sentAt: { type: Date, default: Date.now }
});

const auditLogSchema = new mongoose.Schema({
  actor: { type: String, required: true },
  actorName: { type: String, default: '' },
  actorRole: { type: String, default: 'employee' },
  action: { type: String, required: true },
  target: { type: String, default: '' },
  targetId: { type: String, default: '' },
  targetTitle: { type: String, default: '' },
  changes: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now }
});

// Account schema with bcrypt hashing
const accountSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: '' },
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: null },
  isActive: { type: Boolean, default: true }
});

// Hash password before saving (only when modified)
accountSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Hash password on findOneAndUpdate too
accountSchema.pre('findOneAndUpdate', async function (next) {
  const update = this.getUpdate();
  if (update && update.password) {
    const salt = await bcrypt.genSalt(12);
    update.password = await bcrypt.hash(update.password, salt);
  }
  next();
});

accountSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

const Property = mongoose.model('Property', propertySchema);
const Inquiry = mongoose.model('Inquiry', inquirySchema);
const HeroImage = mongoose.model('HeroImage', heroImageSchema);
const Subscriber = mongoose.model('Subscriber', subscriberSchema);
const PriceAlert = mongoose.model('PriceAlert', priceAlertSchema);
const Wishlist = mongoose.model('Wishlist', wishlistSchema);
const AlertLog = mongoose.model('AlertLog', alertLogSchema);
const AuditLog = mongoose.model('AuditLog', auditLogSchema);
const Account = mongoose.model('Account', accountSchema);

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

// ============ AUTH MIDDLEWARE ============
function signToken(account) {
  return jwt.sign(
    { sub: account._id.toString(), email: account.email, role: account.role, name: account.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ============ AUDIT HELPER (uses verified JWT, not headers) ============
async function logAudit(req, action, target, targetId, targetTitle, changes) {
  try {
    const u = req.user || {};
    await AuditLog.create({
      actor: u.email || 'anonymous',
      actorName: u.name || '',
      actorRole: u.role || 'unknown',
      action,
      target,
      targetId: targetId || '',
      targetTitle: targetTitle || '',
      changes: changes || null,
      ip: req.ip || req.connection?.remoteAddress || '',
      userAgent: req.headers?.['user-agent'] || '',
      timestamp: new Date()
    });
  } catch (e) { console.error('Audit log error:', e.message); }
}

// ============ SEED DEFAULT ADMIN ACCOUNT ============
async function seedDefaultAdmin() {
  try {
    const existing = await Account.findOne({ role: 'admin' });
    if (!existing) {
      const seedEmail = process.env.ADMIN_EMAIL;
      const seedPassword = process.env.ADMIN_PASSWORD;
      if (!seedEmail || !seedPassword) {
        console.warn('⚠️ No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD not set. Skipping seed.');
        return;
      }
      await Account.create({
        email: seedEmail,
        password: seedPassword, // hashed by pre-save hook
        name: 'GLRA Admin',
        role: 'admin'
      });
      console.log(`✅ Default admin account created: ${seedEmail}`);
      console.log('⚠️  Change this password immediately after first login.');
    }
  } catch (e) { console.error('Seed error:', e.message); }
}

// ============ EMAIL TEMPLATES ============
function getEmailHeader() {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>GLRA Realty</title></head>
    <body style="margin: 0; padding: 0; background-color: #f5f5f0; font-family: Arial, sans-serif;">
      <div style="max-width: 550px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
        <div style="background-color: #1a1a2e; padding: 30px 25px; text-align: center;">
          <h1 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 28px; margin: 0; letter-spacing: 2px;">GLRA REALTY</h1>
          <p style="color: #a0a0a0; margin: 8px 0 0 0; font-size: 12px;">Licensed Real Estate Agent | Metro Manila &amp; Luzon</p>
        </div>
        <div style="padding: 35px 30px;">
  `;
}

function getEmailFooter() {
  return `
        </div>
        <div style="background-color: #f9f9f5; padding: 20px 30px; text-align: center; border-top: 1px solid #e8e8e0;">
          <p style="margin: 0 0 5px 0; color: #888888; font-size: 12px;">GLRA Realty Group</p>
          <p style="margin: 0; color: #888888; font-size: 11px;">17th Floor, 252 Senator Gil J. Puyat Avenue, Makati City, Philippines 1200</p>
          <p style="margin: 10px 0 0 0; color: #888888; font-size: 11px;">
            <a href="tel:+639171774572" style="color: #c5a059; text-decoration: none;">+63 917 177 4572</a> |
            <a href="mailto:glrarealty@gmail.com" style="color: #c5a059; text-decoration: none;">glrarealty@gmail.com</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

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
    const properties = await Property.find({ status: 'available' }).sort({ createdAt: -1 });
    res.json(properties);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/hero-images', async (req, res) => {
  try {
    const images = await HeroImage.find().sort({ order: 1 });
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
  body('phone').optional().isString().trim().isLength({ max: 50 }),
  body('propertyId').optional().isString().trim().isLength({ max: 100 }),
  body('propertyTitle').optional().isString().trim().isLength({ max: 300 }),
  handleValidation,
  async (req, res) => {
    try {
      const { name, email, phone = '', message, propertyId = null, propertyTitle = null } = req.body;
      const inquiry = new Inquiry({ name, email, phone, message, propertyId, propertyTitle });
      await inquiry.save();
      console.log('📧 New inquiry from:', name);

      // Confirmation email to user
      const userEmailHtml = getEmailHeader() + `
        <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Dear ${esc(name)},</h2>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">Thank you for reaching out to GLRA Realty. We have received your inquiry and our team will respond within 24 hours.</p>

        <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">Your Message:</p>
          <p style="margin: 0; color: #555555; font-size: 14px; line-height: 1.5;">${esc(message)}</p>
          ${propertyTitle ? `<p style="margin: 12px 0 0 0; color: #555555; font-size: 13px;"><strong>Property of Interest:</strong> ${esc(propertyTitle)}</p>` : ''}
        </div>

        <p style="color: #555555; line-height: 1.6; font-size: 14px;">We look forward to assisting you with your real estate needs.</p>
        <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      await sendEmail(email, 'Thank you for contacting GLRA Realty', userEmailHtml);

      // Admin notification
      const adminEmailHtml = getEmailHeader() + `
        <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Inquiry Received</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Name</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(name)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Email</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(email)}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Phone</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(phone) || 'Not provided'}</td></tr>
          ${propertyTitle ? `<tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${esc(propertyTitle)}</td></tr>` : ''}
          <tr><td style="padding: 8px 0; font-weight: 600; vertical-align: top;">Message</td><td style="padding: 8px 0;">${esc(message)}</td></tr>
        </table>
        <p><a href="https://glrarealty.com/admin.html" style="background-color: #c5a059; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View in Admin Dashboard</a></p>
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

        if (source !== 'calculator_print') {
          const welcomeHtml = getEmailHeader() + `
            <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Welcome to GLRA Realty</h2>
            <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear ${esc(name) || 'Valued Subscriber'},</p>
            <p style="color: #555555; line-height: 1.6; font-size: 14px;">Thank you for subscribing to our newsletter. You will now receive updates on new property listings, price drops, and real estate market insights.</p>
            <div style="background-color: #f9f9f5; padding: 15px 20px; margin: 25px 0; border-radius: 4px;">
              <p style="margin: 0 0 5px 0; font-weight: 600; color: #1a1a2e;">What to expect:</p>
              <p style="margin: 0; color: #555555; font-size: 13px;">New property listings • Price drop alerts • Real estate guides • Market updates</p>
            </div>
            <p style="color: #555555; line-height: 1.6; font-size: 14px;">We're honored to be part of your real estate journey.</p>
            <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
          ` + getEmailFooter();
          await sendEmail(email, 'Welcome to GLRA Realty', welcomeHtml);
        }
      }

      if (isNew) {
        const adminSubHtml = getEmailHeader() + `
          <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Subscriber</h2>
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
        <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Property Saved to Wishlist</h2>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">You have successfully saved the following property to your wishlist:</p>
        <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">${esc(propertyTitle)}</p>
          <p style="margin: 0 0 5px 0; color: #555555; font-size: 13px;">📍 ${esc(propertyLocation)}</p>
          <p style="margin: 0; color: #c5a059; font-weight: 600; font-size: 16px;">₱${Number(propertyPrice).toLocaleString()}</p>
        </div>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">You can view all your saved properties in the <a href="https://glrarealty.com/properties.html" style="color: #c5a059;">properties page</a>.</p>
        <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      await sendEmail(email, `Saved to Wishlist: ${propertyTitle}`, userWishlistHtml);

      const adminWishlistHtml = getEmailHeader() + `
        <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Wishlist Item</h2>
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
        <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Price Alert Confirmation</h2>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">You have successfully set a price alert for the following property:</p>
        <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">${esc(propertyTitle)}</p>
          <p style="margin: 0; color: #c5a059; font-weight: 600; font-size: 16px;">Current Price: ₱${Number(propertyPrice).toLocaleString()}</p>
        </div>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">You will receive an email notification immediately if the price drops.</p>
        <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      await sendEmail(email, `Price Alert Set: ${propertyTitle}`, userAlertHtml);

      const adminAlertHtml = getEmailHeader() + `
        <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Price Alert Request</h2>
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

      res.json({
        success: true,
        token,
        role: account.role,
        name: account.name,
        email: account.email,
        id: account._id
      });
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ============ PROTECTED ADMIN ROUTES ============
// All routes below require a valid JWT.

app.get('/api/admin/me', verifyToken, (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role });
});

app.get('/api/admin/accounts', verifyToken, async (req, res) => {
  try {
    const accounts = await Account.find({}, { password: 0 }).sort({ createdAt: 1 });
    res.json(accounts);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/accounts',
  verifyToken, requireAdmin,
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 8, max: 200 }),
  body('name').optional().isString().trim().isLength({ max: 200 }),
  body('role').optional().isIn(['admin', 'employee']),
  handleValidation,
  async (req, res) => {
    const { email, password, name, role } = req.body;
    try {
      const account = await Account.create({
        email, password,
        name: name || email.split('@')[0],
        role: role || 'employee'
      });
      await logAudit(req, 'CREATE', 'Account', account._id, email, { role });
      res.json({ success: true, account: { email: account.email, name: account.name, role: account.role, _id: account._id } });
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
  handleValidation,
  async (req, res) => {
    const { email, password, name, role, isActive } = req.body;
    try {
      const before = await Account.findById(req.params.id, { password: 0 });
      if (!before) return res.status(404).json({ error: 'Account not found' });

      const update = {};
      if (email) update.email = email;
      if (password) update.password = password; // hashed by pre-update hook
      if (name) update.name = name;
      if (role) update.role = role;
      if (isActive !== undefined) update.isActive = isActive;

      const account = await Account.findByIdAndUpdate(req.params.id, update, { new: true, select: '-password' });
      await logAudit(req, 'UPDATE', 'Account', req.params.id, account.email, { before, after: { ...update, password: password ? '[REDACTED]' : undefined } });
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

app.get('/api/admin/audit-log', verifyToken, requireAdmin, async (req, res) => {
  try {
    const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(200);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
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

app.post('/api/admin/properties', verifyToken, requireAdmin, async (req, res) => {
  try {
    const property = new Property(req.body);
    await property.save();
    await logAudit(req, 'CREATE', 'Property', property._id, property.title, null);
    res.json(property);
  } catch (err) {
    console.error('Add property error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/properties/:id', verifyToken, requireAdmin, async (req, res) => {
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
            <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Price Drop Alert</h2>
            <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
            <p style="color: #555555; line-height: 1.6; font-size: 14px;">Good news! The price has dropped for a property you are watching:</p>
            <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
              <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">${esc(oldProperty.title)}</p>
              <p style="margin: 0 0 5px 0; color: #555555; font-size: 13px;">📍 ${esc(oldProperty.location)}</p>
              <p style="margin: 0 0 5px 0; color: #888888; font-size: 14px; text-decoration: line-through;">Previous Price: ₱${oldProperty.price.toLocaleString()}</p>
              <p style="margin: 0; color: #10b981; font-weight: 700; font-size: 18px;">New Price: ₱${Number(updatedData.price).toLocaleString()}</p>
              <p style="margin: 10px 0 0 0; color: #555555; font-size: 13px;">Savings: ₱${(oldProperty.price - Number(updatedData.price)).toLocaleString()}</p>
            </div>
            <p><a href="https://glrarealty.com/properties.html?property=${encodeURIComponent(req.params.id)}" style="background-color: #c5a059; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View Property Details</a></p>
            <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
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
    res.json(property);
  } catch (err) {
    console.error('Error updating property:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/properties/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const property = await Property.findByIdAndDelete(req.params.id);
    if (property) await logAudit(req, 'DELETE', 'Property', req.params.id, property.title, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/inquiries/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const inquiry = await Inquiry.findByIdAndDelete(req.params.id);
    if (inquiry) await logAudit(req, 'DELETE', 'Inquiry', req.params.id, inquiry.email, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/subscribers/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const sub = await Subscriber.findByIdAndDelete(req.params.id);
    if (sub) await logAudit(req, 'DELETE', 'Subscriber', req.params.id, sub.email, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/properties/bulk', verifyToken, requireAdmin, async (req, res) => {
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
    res.json({ success: true, added });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Property image upload (admin only, hashed-by-token)
app.post('/api/admin/upload-property-image', verifyToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'glra_realty/properties',
      transformation: [{ width: 1200, height: 800, crop: 'limit' }, { quality: 'auto' }]
    });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
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

app.post('/api/admin/hero-images/upload', verifyToken, requireAdmin, upload.single('image'), async (req, res) => {
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

app.post('/api/admin/hero-images/reorder', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { images } = req.body;
    if (!Array.isArray(images)) return res.status(400).json({ error: 'Expected images array' });
    for (const img of images) {
      await HeroImage.findByIdAndUpdate(img._id, { order: img.order });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/hero-images/:id/default', verifyToken, requireAdmin, async (req, res) => {
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
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/hero-images/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await HeroImage.findByIdAndDelete(req.params.id);
    await logAudit(req, 'DELETE', 'HeroImage', req.params.id, '', null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============ STATIC + SITEMAP ============
app.get('/sitemap.xml', (req, res) => {
  const sitemapPath = path.join(__dirname, 'sitemap.xml');
  if (fs.existsSync(sitemapPath)) {
    res.sendFile(sitemapPath);
  } else {
    res.status(404).send('Sitemap not found');
  }
});

// ============ AI CHATBOT PROXY ============
app.post('/api/chat',
  chatLimiter,
  body('messages').optional().isArray({ max: 50 }),
  body('systemPrompt').optional().isString().isLength({ max: 5000 }),
  handleValidation,
  async (req, res) => {
    try {
      const { messages, systemPrompt } = req.body;
      const apiKey = process.env.ANTHROPIC_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error: 'AI service not configured',
          message: "I'm not available right now. Please contact us at 0917 177 4572 or message us on Messenger."
        });
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          system: systemPrompt || 'You are a helpful real estate assistant for GLRA Realty in the Philippines.',
          messages: messages || []
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('Anthropic API error:', err);
        return res.status(502).json({
          error: 'AI service error',
          message: "I'm having trouble right now. Please call us at 0917 177 4572."
        });
      }

      const data = await response.json();
      const reply = data.content?.[0]?.text || "I couldn't process that. Please contact us directly.";
      res.json({ reply });
    } catch (error) {
      console.error('Chat proxy error:', error);
      res.status(500).json({
        error: 'Server error',
        message: "Something went wrong. Please call us at 0917 177 4572."
      });
    }
  }
);

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
