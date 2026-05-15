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

// ============ TASKS (Monday-style internal task board) ============
// Generic across businesses (real estate / law firm / etc.) — `category` and
// `reference` are free-form so the same board can hold listing follow-ups,
// case milestones, marketing TODOs, anything.
const taskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: '', maxlength: 5000 },
  category: { type: String, default: '', trim: true, maxlength: 60, index: true },
  status: {
    type: String,
    enum: ['todo', 'in_progress', 'stuck', 'done'],
    default: 'todo',
    index: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Account', index: true }],
  dueDate: { type: Date, default: null },
  reference: { type: String, default: '', trim: true, maxlength: 200 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  completedAt: { type: Date, default: null },
  updates: [{
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    authorName: { type: String, default: '' },
    authorEmail: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 2000 },
    createdAt: { type: Date, default: Date.now }
  }],
  attachments: [{
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    filename: { type: String, default: '' },
    size: { type: Number, default: 0 },
    resourceType: { type: String, default: 'image' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
    uploadedByName: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// ============ PROPERTY SUBMISSIONS (public listing form) ============
// Owners fill out a public form to list their property. Each submission stays
// in this collection (separate from the live `properties` collection) until an
// admin reviews and clicks "Import" — which copies the data into a real Property.
const propertySubmissionSchema = new mongoose.Schema({
  // Submitter contact info
  submitterName: { type: String, required: true, trim: true, maxlength: 100 },
  submitterEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
  submitterPhone: { type: String, default: '', trim: true, maxlength: 30 },
  submitterMessage: { type: String, default: '', maxlength: 1000 },

  // Property details (mirrors Property schema)
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: '', maxlength: 5000 },
  location: { type: String, required: true, trim: true, maxlength: 200 },
  mapLocation: { type: String, default: '', trim: true, maxlength: 200 },
  propertyType: { type: String, default: 'Condominium', maxlength: 60 },
  listingType: { type: String, default: 'FOR SALE', maxlength: 30 },
  price: { type: Number, default: 0 },
  monthlyRental: { type: Number, default: 0 },
  bedrooms: { type: Number, default: 0 },
  bathrooms: { type: Number, default: 0 },
  sqm: { type: Number, default: 0 },
  landArea: { type: Number, default: 0 },
  parking: { type: Number, default: 0 },
  developer: { type: String, default: '', maxlength: 120 },
  mainImage: { type: String, default: '' },
  gallery: { type: [String], default: [] },

  // Workflow / admin fields
  status: { type: String, enum: ['pending','imported','rejected'], default: 'pending', index: true },
  importedPropertyId: { type: String, default: null },
  reviewedBy: { type: String, default: '' },
  reviewedAt: { type: Date, default: null },
  adminNotes: { type: String, default: '', maxlength: 2000 },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' }
}, { timestamps: true });

// ============ PERMISSIONS ============
// Master list of every granular permission key in the system.
const PERMISSION_KEYS = [
  'properties_create',
  'properties_edit',
  'properties_delete',
  'properties_upload_image',
  'inquiries_delete',
  'subscribers_delete',
  'hero_upload',
  'hero_edit',
  'hero_delete',
  'accounts_manage',  // create/edit/delete staff accounts — admin role always has this regardless
  'audit_view',
  'tasks_view',     // see the tasks tab at all
  'tasks_create',   // create new tasks and assign them
  'tasks_edit',     // reassign / change due-date / edit any task (assignees can always change status of their own)
  'tasks_delete',   // permanently delete tasks (managers only)
  'submissions_view',    // see the property-submissions tab
  'submissions_import',  // convert a submission into a live Property listing
  'submissions_delete'   // permanently delete a submission
];

// Sensible defaults per role.
function defaultPermissionsForRole(role) {
  if (role === 'admin') {
    // Admins start with everything on; the role itself bypasses checks anyway.
    const all = {};
    PERMISSION_KEYS.forEach(k => { all[k] = true; });
    return all;
  }
  // Employees default: can manage properties (the most common day-to-day task) but not delete or manage hero/accounts.
  // Tasks: by default they can see the board and post comments on their own tasks; only managers create/edit/delete.
  return {
    properties_create: true,
    properties_edit: true,
    properties_delete: false,
    properties_upload_image: true,
    inquiries_delete: false,
    subscribers_delete: false,
    hero_upload: false,
    hero_edit: false,
    hero_delete: false,
    accounts_manage: false,
    audit_view: false,
    tasks_view: true,
    tasks_create: false,
    tasks_edit: false,
    tasks_delete: false,
    submissions_view: true,
    submissions_import: false,
    submissions_delete: false
  };
}

// Account schema with bcrypt hashing + granular permissions
const accountSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: '' },
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
  permissions: { type: mongoose.Schema.Types.Mixed, default: () => defaultPermissionsForRole('employee') },
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
const Task = mongoose.model('Task', taskSchema);
const PropertySubmission = mongoose.model('PropertySubmission', propertySubmissionSchema);

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

// Granular permission middleware. Usage: requirePermission('properties_delete')
// Admins bypass the check (they always have everything).
// For employees, looks up the live account record so permission changes take effect
// immediately without forcing them to log out.
function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'admin') return next();
    try {
      const account = await Account.findById(req.user.sub).select('permissions isActive role').lean();
      if (!account || account.isActive === false) {
        return res.status(403).json({ error: 'Account is inactive' });
      }
      if (account.role === 'admin') return next();
      const granted = account.permissions && account.permissions[key] === true;
      if (!granted) {
        return res.status(403).json({ error: `You don't have permission to perform this action (${key}).` });
      }
      next();
    } catch (e) {
      console.error('Permission check error:', e);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
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
        role: 'admin',
        permissions: defaultPermissionsForRole('admin')
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

// ============ CHATBOT (Gemini proxy) ============
// Dedicated rate limiter — looser than publicWriteLimiter so the chat feels responsive,
// but still tight enough to prevent abuse / runaway API spend.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  max: 20,                    // 20 messages / IP / minute
  message: { error: 'Too many messages. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Listings cache for the chatbot ─────────────────────────────
// Re-pulling every chat message would slam Mongo. We cache the full
// available-listings set in memory for 60 s. Admin saves invalidate it
// (see invalidateChatListingsCache() — call it after Property writes).
const CHAT_LISTING_TTL_MS = 60 * 1000;
const CHAT_LISTING_LIMIT  = 80;     // Hard cap so the prompt never blows up.
let _chatListingCache = { at: 0, items: [] };

function invalidateChatListingsCache() { _chatListingCache.at = 0; }

async function getAllAvailableListingsCached() {
  const now = Date.now();
  if (now - _chatListingCache.at < CHAT_LISTING_TTL_MS && _chatListingCache.items.length) {
    return _chatListingCache.items;
  }
  try {
    const items = await Property.find({ status: 'available' })
      .sort({ featured: -1, createdAt: -1 })
      .limit(CHAT_LISTING_LIMIT)
      .select('_id title location price monthlyRental listingType bedrooms bathrooms sqm propertyType featured developer')
      .lean();
    _chatListingCache = { at: now, items };
    return items;
  } catch (e) {
    return _chatListingCache.items || [];
  }
}

// Lightweight keyword scorer. Pulls obvious intents out of the user's message
// (location, property type, listing type, BR count, budget) and ranks listings
// so the most relevant ones get included in the prompt — without needing a
// full vector store. Cheap, deterministic, no extra dependencies.
const KNOWN_LOCATIONS = [
  'makati','bgc','taguig','fort','bonifacio','alabang','muntinlupa','manila','quezon','qc',
  'ortigas','pasig','mandaluyong','san juan','rockwell','salcedo','legazpi','legaspi',
  'poblacion','greenhills','eastwood','newport','parañaque','paranaque','las piñas','laspinas',
  'pasay','marikina','antipolo','tagaytay','cavite','laguna','bulacan','nuvali','sucat',
  'mckinley','uptown','arca','filinvest','ayala','century city','proscenium','one shangri',
  'shangri-la','solaire','okada','clark','subic','baguio','batangas','nasugbu','laiya'
];
const KNOWN_TYPES = ['condo','condominium','house','townhouse','lot','apartment','studio','penthouse','duplex','loft','villa','office','commercial'];

function scoreListings(message, listings) {
  const m = (message || '').toLowerCase();

  const wantedLocs = KNOWN_LOCATIONS.filter(loc => m.includes(loc));
  const wantedTypes = KNOWN_TYPES.filter(t => m.includes(t));
  const wantsLease = /\b(rent|rental|lease|leasing|monthly)\b/.test(m);
  const wantsSale  = /\b(buy|buying|purchase|sale|for sale)\b/.test(m);

  // Bedroom request, e.g. "3br", "3 bedroom", "3-bedroom"
  const brMatch = m.match(/(\d+)\s*-?\s*(?:br|bed|bedroom)/);
  const wantedBR = brMatch ? parseInt(brMatch[1], 10) : null;

  // Budget: "under 10m", "below 50k", "around 5 million", "30000/mo"
  // Roughly: number followed by m/million/k/thousand.
  let budget = null;
  const bMatch = m.match(/(\d[\d,.]*)\s*(m|mil|million|k|thousand)?/);
  if (bMatch) {
    const raw = parseFloat(bMatch[1].replace(/,/g, ''));
    const unit = (bMatch[2] || '').toLowerCase();
    if (!isNaN(raw)) {
      if (unit === 'm' || unit === 'mil' || unit === 'million') budget = raw * 1_000_000;
      else if (unit === 'k' || unit === 'thousand') budget = raw * 1_000;
      else if (raw >= 1000) budget = raw;
    }
  }

  function scoreOne(p) {
    let s = 0;
    const loc = (p.location || '').toLowerCase();
    const title = (p.title || '').toLowerCase();
    const type = (p.propertyType || '').toLowerCase();
    const lt = (p.listingType || '').toUpperCase();
    const isLease = lt.includes('LEASE') || lt.includes('RENT');

    for (const w of wantedLocs) if (loc.includes(w) || title.includes(w)) s += 10;
    for (const t of wantedTypes) if (type.includes(t) || title.includes(t)) s += 4;
    if (wantsLease && isLease) s += 6;
    if (wantsSale && !isLease) s += 6;
    if (wantedBR !== null && p.bedrooms === wantedBR) s += 4;

    if (budget) {
      const price = isLease ? (p.monthlyRental || p.price || 0) : (p.price || 0);
      if (price > 0) {
        if (isLease && price <= budget * 1.25) s += 4;
        if (!isLease && price <= budget * 1.15) s += 4;
      }
    }
    if (p.featured) s += 1;
    return s;
  }

  const scored = listings.map(p => ({ p, s: scoreOne(p) }));
  scored.sort((a, b) => b.s - a.s);
  return scored;
}

function fmtListing(p, i) {
  const lt = (p.listingType || '').toUpperCase();
  const isLease = lt.includes('LEASE') || lt.includes('RENT');
  const price = isLease
    ? `₱${Number(p.monthlyRental || p.price || 0).toLocaleString()}/mo`
    : `₱${Number(p.price || 0).toLocaleString()}`;
  const dev = p.developer ? `, ${p.developer}` : '';
  return `${i + 1}. ${p.title} — ${p.location} — ${price} — ${p.bedrooms || 0}BR/${p.bathrooms || 0}BA/${p.sqm || 0}sqm (${p.propertyType || 'Property'}${dev}, ${isLease ? 'For Lease' : 'For Sale'})`;
}

// Static "site map" the bot can always reference. Update here when pages change.
const SITE_MAP = `
SITE MAP & SERVICES (route the user to the right page):
- /properties.html   → Browse all listings (use filters: location, type, BR, price)
- /list-property.html → Owner wants to LIST/SELL/LEASE their property (lead form)
- /about.html        → About Catherine SB Sampayo (PRC #0026736, 10+ yrs)
- /testimonials.html → Client reviews
- /blog.html         → Journal / market updates
- /guide.html        → Buying & documentation guide (CCT/TCT, deeds, taxes)
- /neighborhoods.html → Area overview (BGC, Makati, Alabang, etc.)
- /living-in-bgc.html, /living-in-makati.html, /living-in-alabang.html → Neighborhood deep dives

CALCULATORS & TOOLS:
- /affordability.html → "How much can I afford?" (income → max price)
- /amortization.html  → Monthly mortgage payment + amortization schedule
- /calculator.html    → Closing fees / total cash to close (CGT 6%, DST 1.5%, transfer, registration, BIR FMV using Sec 6E NIRC)
- /cost-of-ownership.html → Recurring annual costs (assoc dues, RPT, insurance)
- /rental-yield.html  → Gross & net rental yield calculator
- /zonal.html         → BIR Zonal Value lookup (NCR + key provinces)
- /ercf.html          → Estimated Registration & Closing Fees (LRA, BIR, RD)

SERVICES OFFERED:
- Buy-side brokerage (residential & commercial, NCR + key provinces)
- Seller representation / pocket listings
- Lease / rental matching
- Pre-selling project sourcing (major developers)
- Document review & coordination (deeds, BIR, RD, HOA)

CONTACT CATHERINE DIRECTLY:
- Messenger: m.me/glrarealty
- Phone / Viber / WhatsApp: +63 917 177 4572
- Office: Manila, Philippines
- Use the "List property →" button (top nav) for sellers/lessors
- Use the in-page "Schedule a viewing" form for specific listings

KEY FACTS ABOUT GLRA REALTY:
- Founded by Catherine SB Sampayo, PRC-licensed broker (10+ years experience).
- Boutique brokerage — Catherine personally handles every client (no junior agents passing leads around).
- Specializes in NCR (Metro Manila): BGC, Makati, Alabang, Ortigas, Rockwell, etc.
- Also handles Cavite, Laguna, Tagaytay, Batangas resort properties.
- Works with both local buyers and OFW / foreign-married buyers (foreigners can own condos up to 40% of the building).
`;

app.post('/api/chat',
  chatLimiter,
  body('message').isString().trim().isLength({ min: 1, max: 1500 }),
  body('history').optional().isArray({ max: 20 }),
  handleValidation,
  async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error('GEMINI_API_KEY not set');
        return res.status(503).json({ error: 'Chat is not configured' });
      }

      const { message, history = [] } = req.body;

      // ── Build live property context ──────────────────────────────
      // 1) Pull the full available-listings set (cached 60s).
      // 2) Score them against the user's message (location/type/BR/budget).
      // 3) Always include featured + top relevance + a compact summary so the
      //    bot can answer "do you have anything in Makati?" honestly.
      let listingContext = '';
      try {
        const allListings = await getAllAvailableListingsCached();

        if (allListings.length) {
          // Always-include set: every featured listing.
          const featuredSet = allListings.filter(p => p.featured).slice(0, 12);

          // Relevance set: scored against the user's most recent message.
          const scored = scoreListings(message, allListings);
          const relevant = scored.filter(x => x.s > 0).slice(0, 12).map(x => x.p);

          // Merge (relevant first, then featured, dedupe by _id), cap 18.
          const seen = new Set();
          const merged = [];
          for (const p of [...relevant, ...featuredSet]) {
            const key = String(p._id);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(p);
            if (merged.length >= 18) break;
          }

          // Compact location index — lets the bot honestly say "yes, we have N in
          // Makati" or "no, nothing in Quezon City right now" without listing them all.
          const locCounts = {};
          for (const p of allListings) {
            const loc = (p.location || 'Unknown').split(',')[0].trim();
            locCounts[loc] = (locCounts[loc] || 0) + 1;
          }
          const locIndex = Object.entries(locCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([loc, n]) => `${loc} (${n})`)
            .join(', ');

          const totalSale  = allListings.filter(p => !((p.listingType||'').toUpperCase().includes('LEASE'))).length;
          const totalLease = allListings.length - totalSale;

          listingContext = `

LIVE INVENTORY SNAPSHOT (do NOT invent listings — only reference what's below):
- Total available: ${allListings.length} (${totalSale} for sale, ${totalLease} for lease)
- By area: ${locIndex}

MOST RELEVANT LISTINGS for this query (link the user to /properties.html to browse all):
${merged.map(fmtListing).join('\n')}

If the user asks about an area not in the "By area" list above, say honestly that there's nothing currently listed there, and offer to have Catherine source one (m.me/glrarealty).`;
        } else {
          listingContext = `

LIVE INVENTORY SNAPSHOT: no listings are currently published. Direct the user to message Catherine at m.me/glrarealty so she can source matches.`;
        }
      } catch (e) {
        console.error('Chat listing context error:', e?.message);
      }

      const systemPrompt = `You are the helpful AI assistant for GLRA Realty (glrarealty.com), a boutique real-estate brokerage in Manila, Philippines, run by Catherine SB Sampayo (PRC-licensed broker, 10+ years experience, established 2014).

YOUR ROLE:
- Answer questions about Philippine real estate: buying, selling, leasing, taxes, financing, neighborhoods, documentation.
- Help users find properties from the LIVE INVENTORY below, understand the buying process, and calculate costs.
- When recommending properties, only use ones from the LIVE INVENTORY SNAPSHOT.
- ALWAYS append a /properties.html SEARCH LINK at the end of any property-related answer (see "PROPERTY SEARCH LINKS" below) — this acts like a smart search and navigates the user to a pre-filtered listings page.
- Recommend the user contact Catherine for personalized advice and viewings (Messenger: m.me/glrarealty, phone/Viber/WhatsApp: +63 917 177 4572).
- Route the user to the right page using the SITE MAP below — link tools when relevant (affordability, closing fees, amortization, rental yield, BIR zonal, ERCF).

PROPERTY SEARCH LINKS (treat /properties.html like a search engine — every property answer should end with one of these):
Format: [Browse all <description>](/properties.html?<params>)
Supported params (combine as needed, URL-encode spaces as %20):
- search=<text>           → searches title + location (e.g. "Makati", "BGC", "Rockwell")
- propertyType=<type>     → exact value: Condominium | House and Lot | Townhouse | Commercial Lot | Residential Lot
- category=<cat>          → FOR%20SALE | FOR%20LEASE | featured
- bedrooms=<n>            → minimum BR (1, 2, 3, 4, 5)
- baths=<n>               → minimum BA
- minPrice=<peso>         → minimum (digits only, no commas)
- maxPrice=<peso>         → maximum (digits only, no commas)

EXAMPLES:
- User: "properties in Makati"
  → "Yes, we have N listings in Makati right now: ... [Browse all Makati properties](/properties.html?search=Makati)"
- User: "3BR condo for lease in BGC under 100k"
  → "Here are 3BR condos for lease in BGC: ... [See all 3BR condos for lease in BGC](/properties.html?search=BGC&propertyType=Condominium&category=FOR%20LEASE&bedrooms=3&maxPrice=100000)"
- User: "houses for sale under 20M"
  → "[Browse houses for sale under ₱20M](/properties.html?propertyType=House%20and%20Lot&category=FOR%20SALE&maxPrice=20000000)"

ANSWERING "DO YOU HAVE PROPERTIES IN <AREA>?":
- Check the "By area" list in LIVE INVENTORY. If the area appears, say yes, show 1-3 matching listings from MOST RELEVANT LISTINGS, then end with the search link.
- If the area is NOT in the inventory, be honest: "We don't have anything currently published in <area>, but Catherine can source one — message her at m.me/glrarealty." Still include the search link so the user can browse what IS available.

CONSTRAINTS:
- Be CONCISE — 2-4 short sentences typically, plus a bullet list of properties when relevant. Don't lecture.
- Use Filipino/Taglish naturally if the user does, but default to clear English.
- NEVER invent listings, prices, developers, or facts. Only reference listings from LIVE INVENTORY.
- NEVER claim to be human. If pressed: "I'm an AI assistant — Catherine handles the real conversations."
- For complex/legal questions, redirect to Catherine.
- Use peso symbol ₱ for prices. Use local terminology (CCT, TCT, BIR zonal value, CGT, DST, RPT, etc.) when accurate.
- Format with short paragraphs and bullets when helpful. No long essays.

TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}.
${SITE_MAP}${listingContext}`;

      // Convert history to Gemini's conversation format
      const contents = [];
      for (const turn of history) {
        if (!turn || !turn.role || !turn.text) continue;
        contents.push({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(turn.text).slice(0, 4000) }]
        });
      }
      contents.push({ role: 'user', parts: [{ text: message }] });

      // Model: gemini-2.5-flash is the current free-tier flash model on v1beta.
      // (gemini-1.5-flash-latest was deprecated/removed → 404.)
      // Override via env var GEMINI_MODEL if you want to swap models without redeploying code.
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 600,
            topP: 0.9,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
          ],
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text().catch(() => '');
        console.error('Gemini API error', geminiRes.status, errText.slice(0, 300));
        return res.status(502).json({ error: 'Chat service is having trouble. Please try again.' });
      }

      const data = await geminiRes.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      const finish = candidate?.finishReason;

      let finalReply;
      if (typeof text === 'string' && text.trim()) {
        finalReply = text.trim();
      } else if (finish === 'SAFETY') {
        finalReply = "Sorry, I can't help with that. Try a property or buying-process question, or message Catherine directly at m.me/glrarealty.";
      } else {
        finalReply = "I didn't catch that. Could you rephrase, or message Catherine directly at m.me/glrarealty?";
      }

      res.json({ reply: finalReply });
    } catch (err) {
      console.error('Chat error:', err);
      res.status(500).json({ error: 'Chat service error' });
    }
  }
);

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

app.delete('/api/admin/subscribers/:id', verifyToken, requirePermission('subscribers_delete'), async (req, res) => {
  try {
    const sub = await Subscriber.findByIdAndDelete(req.params.id);
    if (sub) await logAudit(req, 'DELETE', 'Subscriber', req.params.id, sub.email, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

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
        const userHtml = `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;background:#f8fafc">
            <div style="background:#0d1b2a;color:#fff;padding:24px;text-align:center">
              <h2 style="margin:0;font-family:Georgia,serif;color:#c8a96e">GLRA Realty</h2>
              <p style="margin:6px 0 0;font-size:13px;opacity:.7">Submission received</p>
            </div>
            <div style="background:#fff;padding:24px;border:1px solid #e2e8f0">
              <p>Hi ${safeName},</p>
              <p>Thank you for submitting <strong>${safeTitle}</strong> to GLRA Realty. Our team will review your listing within 1–2 business days and reach out to you at this email.</p>
              <p>If you have additional details or photos, simply reply to this email.</p>
              <p style="margin-top:18px">— The GLRA Realty team</p>
            </div>
          </div>`;
        await sendEmail(b.submitterEmail, 'We received your property listing — GLRA Realty', userHtml);
      } catch (e) { console.error('Submitter confirmation email error:', e.message); }

      // Notification email to admin
      try {
        const safeName = (b.submitterName || '').replace(/[<>]/g, '');
        const safeTitle = (b.title || '').replace(/[<>]/g, '');
        const safeLoc = (b.location || '').replace(/[<>]/g, '');
        const safeEmail = (b.submitterEmail || '').replace(/[<>]/g, '');
        const safePhone = (b.submitterPhone || '').replace(/[<>]/g, '');
        const adminHtml = `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px">
            <h2 style="color:#0d1b2a;border-bottom:2px solid #c8a96e;padding-bottom:8px">New Property Submission</h2>
            <p><strong>${safeTitle}</strong> · ${safeLoc}</p>
            <p>Listing type: <strong>${(b.listingType||'').replace(/[<>]/g,'')}</strong> · Property type: ${(b.propertyType||'').replace(/[<>]/g,'')}</p>
            <p>Price: ₱${(parseFloat(b.price)||0).toLocaleString()} · Rental: ₱${(parseFloat(b.monthlyRental)||0).toLocaleString()}/mo</p>
            <hr>
            <p>Submitted by: <strong>${safeName}</strong></p>
            <p>Email: ${safeEmail}</p>
            <p>Phone: ${safePhone || '—'}</p>
            <p style="margin-top:20px">Open the admin dashboard → Submissions tab to review and import.</p>
          </div>`;
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

// ============ STATIC + SITEMAP ============
app.get('/sitemap.xml', (req, res) => {
  const sitemapPath = path.join(__dirname, 'sitemap.xml');
  if (fs.existsSync(sitemapPath)) {
    res.sendFile(sitemapPath);
  } else {
    res.status(404).send('Sitemap not found');
  }
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
  ║   Allowed origins: ${(allowedOrigins.join(', ') || '(any)').padEnd(43).slice(0, 43)}║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
});
