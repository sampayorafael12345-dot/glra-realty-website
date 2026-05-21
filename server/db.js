// =============================================================================
// DATABASE LAYER
// =============================================================================
// All Mongoose schemas + compiled models + the permissions table live here.
// The rest of the app imports models from this single file so there's exactly
// one place to look when you need to know the data shape.
// =============================================================================
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ── PROPERTIES ──────────────────────────────────────────────
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

// ── INQUIRIES ───────────────────────────────────────────────
const inquirySchema = new mongoose.Schema({
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  message: { type: String, default: '' },
  propertyId: { type: String, default: null },
  propertyTitle: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

// ── HERO IMAGES ─────────────────────────────────────────────
const heroImageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// ── SUBSCRIBERS ─────────────────────────────────────────────
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

// ── PRICE ALERTS ────────────────────────────────────────────
const priceAlertSchema = new mongoose.Schema({
  email: { type: String, required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, default: '' },
  propertyPrice: { type: Number, default: 0 },
  notifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  isNotified: { type: Boolean, default: false }
});

// ── WISHLIST ────────────────────────────────────────────────
const wishlistSchema = new mongoose.Schema({
  email: { type: String, required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, default: '' },
  propertyPrice: { type: Number, default: 0 },
  propertyLocation: { type: String, default: '' },
  propertyImage: { type: String, default: '' },
  addedAt: { type: Date, default: Date.now }
});

// ── ALERT LOG (record of price-drop emails sent) ───────────
const alertLogSchema = new mongoose.Schema({
  type: { type: String, enum: ['price_drop'], required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, required: true },
  oldPrice: { type: Number, default: 0 },
  newPrice: { type: Number, default: 0 },
  sentTo: { type: Number, default: 0 },
  sentAt: { type: Date, default: Date.now }
});

// ── AUDIT LOG (admin-action history) ────────────────────────
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

// ── TASKS (Monday-style internal task board) ────────────────
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

// ── PROPERTY SUBMISSIONS (public listing form) ─────────────
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

// ── SCHEDULED BULK-EMAIL ────────────────────────────────────
// Created when the admin schedules a campaign for later. A background worker
// in server.js wakes up every minute, finds entries with status 'pending' and
// sendAt <= now, dispatches them, then marks 'sent'.
const scheduledEmailSchema = new mongoose.Schema({
  recipients: { type: [String], default: [] },           // already validated + deduped
  subject:    { type: String, required: true, maxlength: 300 },
  fromName:   { type: String, default: 'GLRA Realty', maxlength: 80 },
  html:       { type: String, required: true },          // pre-rendered HTML
  sendAt:     { type: Date, required: true, index: true },
  status:     { type: String, enum: ['pending','sending','sent','failed','cancelled'], default: 'pending', index: true },
  createdBy:     { type: String, default: '' },
  createdByName: { type: String, default: '' },
  sentAt:     { type: Date, default: null },
  result:     { type: mongoose.Schema.Types.Mixed, default: null }   // { total, sent, failed, errors }
}, { timestamps: true });

// ============================================================================
// PERMISSIONS
// ============================================================================
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
  'submissions_delete',  // permanently delete a submission
  'bulkmail_send'        // compose + send bulk emails from the admin (admins always have this)
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
    submissions_delete: false,
    bulkmail_send: false
  };
}

// ── ACCOUNT (staff login) ───────────────────────────────────
// bcrypt hashing happens automatically in pre('save') and pre('findOneAndUpdate')
// hooks, so any code that does `account.save()` or `Account.findOneAndUpdate()`
// can pass a plain-text password and it'll be hashed before it hits Mongo.
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

// ============================================================================
// COMPILED MODELS
// ============================================================================
const Property          = mongoose.model('Property',          propertySchema);
const Inquiry           = mongoose.model('Inquiry',           inquirySchema);
const HeroImage         = mongoose.model('HeroImage',         heroImageSchema);
const Subscriber        = mongoose.model('Subscriber',        subscriberSchema);
const PriceAlert        = mongoose.model('PriceAlert',        priceAlertSchema);
const Wishlist          = mongoose.model('Wishlist',          wishlistSchema);
const AlertLog          = mongoose.model('AlertLog',          alertLogSchema);
const AuditLog          = mongoose.model('AuditLog',          auditLogSchema);
const Account           = mongoose.model('Account',           accountSchema);
const Task              = mongoose.model('Task',              taskSchema);
const PropertySubmission = mongoose.model('PropertySubmission', propertySubmissionSchema);
const ScheduledEmail    = mongoose.model('ScheduledEmail',    scheduledEmailSchema);

module.exports = {
  // models
  Property,
  Inquiry,
  HeroImage,
  Subscriber,
  PriceAlert,
  Wishlist,
  AlertLog,
  AuditLog,
  Account,
  Task,
  PropertySubmission,
  ScheduledEmail,
  // permissions
  PERMISSION_KEYS,
  defaultPermissionsForRole
};
