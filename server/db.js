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
  priceUpdatedAt: { type: Date, default: null },
  // How many times the public detail view was opened (browsing signal for the admin).
  views: { type: Number, default: 0 }
});

// Every public page load runs find({status:'available'}).sort({createdAt:-1}) —
// this is that exact query, so it stays fast as the listing count grows instead
// of scanning the whole collection and sorting in memory.
propertySchema.index({ status: 1, createdAt: -1 });

// ── INQUIRIES ───────────────────────────────────────────────
const inquirySchema = new mongoose.Schema({
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  message: { type: String, default: '' },
  propertyId: { type: String, default: null },
  propertyTitle: { type: String, default: null },
  handled: { type: Boolean, default: false },
  handledAt: { type: Date, default: null },
  handledBy: { type: String, default: '' },
  // Agent routing: set when an admin hands this inquiry to an agent. The
  // inquiry itself stays in the admin list; a copy becomes an AgentLead.
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
  assignedToName: { type: String, default: '' },
  assignedAt: { type: Date, default: null },
  assignedBy: { type: String, default: '' },
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
  isActive: { type: Boolean, default: true },
  // Anonymous browser ids (see calcUsageSchema) that have been tied to this
  // person by them entering this email on that browser. One human can have
  // several — phone, laptop, work machine — so it's a set, not a single value.
  vids: { type: [String], default: [] }
});

// Look up "which subscriber owns this browser id" on every calculator ping.
subscriberSchema.index({ vids: 1 });

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

  ownerRole: { type: String, default: '', maxlength: 60 },

  // Ticked but not attached — "I have this, I will send it later".
  documentsReady: { type: [String], default: [] },

  // Actually uploaded. These are titles and government IDs, so they go to
  // Cloudinary as `authenticated` rather than public like the property
  // photos do: no URL is stored and none is ever sent to the browser.
  // Retrieval goes through an admin-only route that mints a signed link
  // valid for five minutes. Guessing the public_id gets you nothing.
  documents: [{
    label:        { type: String, default: '', maxlength: 120 },
    publicId:     { type: String, default: '', maxlength: 300 },
    resourceType: { type: String, default: 'image', maxlength: 20 },
    format:       { type: String, default: '', maxlength: 12 },
    name:         { type: String, default: '', maxlength: 200 },
    bytes:        { type: Number, default: 0 },
    uploadedAt:   { type: Date, default: Date.now }
  }],

  // Lease listings only.
  leaseTerms: {
    term:          { type: String, default: '', maxlength: 40 },
    availableFrom: { type: String, default: '', maxlength: 20 },
    depositMonths: { type: Number, default: 0 },
    advanceMonths: { type: Number, default: 0 },
    furnishing:    { type: String, default: '', maxlength: 40 },
    dues:          { type: String, default: '', maxlength: 40 },
    pets:          { type: String, default: '', maxlength: 40 },
    utilities:     { type: String, default: '', maxlength: 120 }
  },

  // ── Authority record ──────────────────────────────────────────
  // These tick boxes are NOT an Authority to Sell. Under Civil Code art.
  // 1874 a sale of land through an agent whose authority is not in
  // writing is void, and art. 1358(3) requires a notarised instrument
  // for the power to sell; RA 8792 recognises e-signatures but excludes
  // anything needing notarisation. What is stored here is evidence that
  // the owner represented ownership and permitted advertising, on a
  // given date, from a given address — which is what it is actually
  // good for. The signed paper is tracked separately by the admin.
  authorityType:  { type: String, default: '', maxlength: 30 },
  commissionNote: { type: String, default: '', maxlength: 60 },
  acknowledgements: {
    isOwnerOrAuthorised:                 { type: Boolean, default: false },
    marketingAuthorised:                 { type: Boolean, default: false },
    understandsWrittenAuthorityRequired: { type: Boolean, default: false },
    privacyConsent:                      { type: Boolean, default: false },
    acceptedAt: { type: Date, default: null },
    acceptedIp: { type: String, default: '' }
  },
  signedAuthorityReceived: { type: Boolean, default: false },
  signedAuthorityNote:     { type: String, default: '', maxlength: 300 },

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

// ── TITLING CASES (land-title transfer / processing jobs) ───
// Tracks each title-transfer engagement through the PH government workflow.
// Mirrors GLRA's "ACTIVE ACCOUNTS" sheet: client + property details, the
// mode of acquisition, dated milestones as the title moves agency-to-agency
// (BIR → Treasurer → Registry of Deeds → Assessor's), and a full liquidation
// (money received vs. disbursed) per case. `status` is the current stage.
const titlingPaymentSchema = new mongoose.Schema({
  date:   { type: Date, default: null },
  label:  { type: String, default: '', trim: true, maxlength: 200 },  // e.g. "1st deposit", "balance"
  amount: { type: Number, default: 0 }
}, { _id: false });

const titlingExpenseSchema = new mongoose.Schema({
  date:     { type: Date, default: null },
  category: { type: String, default: '', trim: true, maxlength: 120 }, // CGT, DST, Transfer Tax, RD fee…
  payee:    { type: String, default: '', trim: true, maxlength: 200 }, // BIR, Treasurer's Office, RD…
  amount:   { type: Number, default: 0 }
}, { _id: false });

const titlingCaseSchema = new mongoose.Schema({
  branch:           { type: String, default: '', trim: true, maxlength: 80 },  // Lucena / Manila / etc.
  clientName:       { type: String, required: true, trim: true, maxlength: 200 },
  clientPhone:      { type: String, default: '', trim: true, maxlength: 50 },
  clientEmail:      { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },
  titleNumber:      { type: String, default: '', trim: true, maxlength: 100 },   // original TCT/CCT/OCT no.
  taxDecNo:         { type: String, default: '', trim: true, maxlength: 100 },   // original tax dec no.
  propertyLocation: { type: String, default: '', trim: true, maxlength: 300 },
  propertyType:     { type: String, default: '', trim: true, maxlength: 60 },
  serviceType:      { type: String, default: 'Transfer of Title', trim: true, maxlength: 80 }, // TRANSACTION
  modeOfAcquisition:{ type: String, default: '', trim: true, maxlength: 100 },   // DOAS / EJS / Donation…
  status: {
    type: String,
    enum: ['documents', 'bir', 'transfer_tax', 'registry', 'tax_dec', 'completed', 'on_hold', 'lra'],
    default: 'documents',
    index: true
  },
  // ── Dated milestones as the title moves through the agencies ──
  dateEndorsed:        { type: Date, default: null },  // endorsed to GLRA
  dateFiledBIR:        { type: Date, default: null },
  dateCarReceived:     { type: Date, default: null },
  carNo:               { type: String, default: '', trim: true, maxlength: 100 },
  dateTransferTax:     { type: Date, default: null },  // transfer tax paid (Treasurer's Office)
  dateFiledRD:         { type: Date, default: null },
  epebNo:              { type: String, default: '', trim: true, maxlength: 100 },
  dateTitleTransferred:{ type: Date, default: null },
  transferredTitleNo:  { type: String, default: '', trim: true, maxlength: 100 },
  dateFiledAO:         { type: Date, default: null },  // filed to Assessor's Office
  transferredTaxDecNo: { type: String, default: '', trim: true, maxlength: 100 },
  lacking:     { type: String, default: '', maxlength: 2000 },   // what's still missing/pending
  documents:   { type: [String], default: [] },   // names of documents already collected
  // ── Liquidation ──
  payments:    { type: [titlingPaymentSchema], default: [] },  // money received from client
  expenses:    { type: [titlingExpenseSchema], default: [] },  // disbursements paid out
  serviceFee:  { type: Number, default: 0 },       // your professional fee
  govFees:     { type: Number, default: 0 },       // legacy total gov fees (kept for old records)
  amountPaid:  { type: Number, default: 0 },       // legacy total received (kept for old records)
  targetDate:  { type: Date, default: null },
  notes:       { type: String, default: '', maxlength: 5000 },  // REMARKS GLRA
  createdBy:     { type: String, default: '' },
  createdByName: { type: String, default: '' }
}, { timestamps: true });

// ── NOTARIAL BUSINESS (Lucena) ──────────────────────────────
// Tracks each notarized document for a client: the official register entry
// (Doc/Page/Book/Series), the fee, and each payment received (with the mode
// of payment) so we can see who paid partially vs. in full.
const notarialPaymentSchema = new mongoose.Schema({
  date:   { type: Date, default: null },
  amount: { type: Number, default: 0 },
  mode:   { type: String, default: 'Cash', trim: true, maxlength: 40 },  // Cash / GCash / Bank / Check
  label:  { type: String, default: '', trim: true, maxlength: 200 }      // e.g. "downpayment", "balance"
}, { _id: false });

const notarialJobSchema = new mongoose.Schema({
  clientName:    { type: String, required: true, trim: true, maxlength: 200 },
  clientPhone:   { type: String, default: '', trim: true, maxlength: 50 },
  clientEmail:   { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },
  // Client classification (from the notarial workflow spec): walk-in, retainer, or
  // monthly-billing. `account` names the retainer/billing company (e.g. RCBC, City Savings).
  clientType:    { type: String, enum: ['', 'walkin', 'retainer', 'monthly_billing'], default: '' },
  account:       { type: String, default: '', trim: true, maxlength: 200 },
  // Workflow stage for the kanban board (received → notarized → released → billed → paid, + on_hold)
  status:        { type: String, default: 'received', trim: true, maxlength: 40 },
  documentType:  { type: String, default: '', trim: true, maxlength: 120 }, // Deed of Sale, Affidavit, SPA…
  documentTypeOther: { type: String, default: '', trim: true, maxlength: 120 }, // filled when documentType = "Other"
  // official notarial register entry
  docNo:         { type: String, default: '', trim: true, maxlength: 40 },
  pageNo:        { type: String, default: '', trim: true, maxlength: 40 },
  bookNo:        { type: String, default: '', trim: true, maxlength: 40 },
  series:        { type: String, default: '', trim: true, maxlength: 12 },  // year, e.g. "2026"
  dateNotarized: { type: Date, default: null },
  copies:        { type: Number, default: 1 },
  notaryName:    { type: String, default: '', trim: true, maxlength: 200 }, // commissioned notary public
  fee:           { type: Number, default: 0 },
  payments:      { type: [notarialPaymentSchema], default: [] },
  notes:         { type: String, default: '', maxlength: 5000 },
  createdBy:     { type: String, default: '' },
  createdByName: { type: String, default: '' }
}, { timestamps: true });

// ── NOTARIAL CASH LEDGER / LIQUIDATION ──────────────────────
// One row per money movement: a supply/cash request, client funds held
// (money in / money out), or money received. Proof images & PDFs live in
// Cloudinary; only the link (url + publicId) is stored here — never the file.
const cashProofSchema = new mongoose.Schema({
  url:           { type: String, required: true },
  publicId:      { type: String, required: true },
  filename:      { type: String, default: '' },
  size:          { type: Number, default: 0 },
  resourceType:  { type: String, default: 'image' },
  uploadedByName:{ type: String, default: '' },
  uploadedAt:    { type: Date, default: Date.now }
});

const cashEntrySchema = new mongoose.Schema({
  business: { type: String, default: 'notarial', index: true },   // 'notarial' | 'titling'
  titlingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TitlingCase', default: null, index: true },
  // request = cash request for supplies; fund_in/fund_out = client money held;
  // receipt = money received (income)
  kind:     { type: String, enum: ['request', 'fund_in', 'fund_out', 'receipt'], required: true, index: true },
  date:     { type: Date, default: null },
  person:   { type: String, default: '', trim: true, maxlength: 200 },   // client/person involved
  purpose:  { type: String, default: '', trim: true, maxlength: 300 },
  amount:   { type: Number, default: 0 },
  mode:     { type: String, default: 'Cash', trim: true, maxlength: 40 }, // Cash/GCash/Bank/Check
  status:   { type: String, enum: ['requested', 'released', 'liquidated', 'done'], default: 'done' },
  spent:    { type: Number, default: 0 },   // actual amount spent (request liquidation)
  proof:    { type: [cashProofSchema], default: [] },
  note:     { type: String, default: '', maxlength: 2000 },
  createdBy:     { type: String, default: '' },
  createdByName: { type: String, default: '' }
}, { timestamps: true });

// ── SITE TRAFFIC (self-hosted visitor counter) ──────────────
// One document per calendar day (YYYY-MM-DD). A middleware bumps `views` on
// each public HTML page load. No IPs, cookies, or personal data are stored —
// just a daily page-view tally that surfaces inside the admin dashboard.
const siteStatSchema = new mongoose.Schema({
  day:   { type: String, required: true, unique: true, index: true }, // 'YYYY-MM-DD' (server local time)
  views: { type: Number, default: 0 },
  // Per-page and per-referrer tallies for the same day, e.g.
  //   pages: { home: 412, arthaland: 88, 'property-detail': 260 }
  //   refs:  { google: 300, facebook: 45, direct: 155 }
  // Keys are sanitised slugs from a fixed whitelist, never raw request input —
  // an attacker requesting /aaa, /aab, ... could otherwise grow this document
  // without limit. Still no IP, cookie or per-person data: these are plain
  // counters, which is what keeps the site free of a consent banner.
  pages: { type: Map, of: Number, default: () => ({}) },
  refs:  { type: Map, of: Number, default: () => ({}) }
});

// ── CALCULATOR / TOOL USAGE ─────────────────────────────────
// One document per genuine calculator engagement — the visitor actually typed
// into or changed a field, not merely loaded the page (every calculator runs
// recalc() once on load, so page views would massively overcount).
//
// `vid` is a random id generated in the browser and kept in localStorage. It is
// NOT derived from IP, fingerprint, or anything personal — on its own it names
// nobody. `email` starts null and is filled in later: the moment the visitor
// enters their email anywhere on the site, every past row from that browser is
// back-filled (see stitchCalcIdentity in server.js). That's what makes
// "what did this subscriber do BEFORE they signed up" answerable.
const calcUsageSchema = new mongoose.Schema({
  vid:   { type: String, required: true },
  email: { type: String, default: null },
  calc:  { type: String, required: true },          // stable slug, e.g. 'affordability'
  label: { type: String, default: '' },             // human label, e.g. 'Affordability Calculator'
  day:   { type: String, default: '' },             // 'YYYY-MM-DD' (server local time)
  createdAt: { type: Date, default: Date.now }
});

// The three real access paths: back-fill by browser, per-subscriber breakdown,
// and the 30-day aggregate trend.
calcUsageSchema.index({ vid: 1 });
calcUsageSchema.index({ email: 1, calc: 1 });
calcUsageSchema.index({ createdAt: -1 });

// ============================================================================
// PERMISSIONS
// ============================================================================
// Master list of every granular permission key in the system.
const PERMISSION_KEYS = [
  'dashboard_view',        // see the main dashboard landing page at all
  'dashboard_analytics',   // see website visitors + team activity (admin-level insight)
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
  'bulkmail_send',       // compose + send bulk emails from the admin (admins always have this)
  'titling_view',        // see the Titling tab
  'titling_manage',      // add / edit / delete titling jobs
  'notarial_view',       // see the Notarial tab
  'notarial_manage'      // add / edit / delete notarial records + cash ledger
  // NOTE: the Agents tab has no permission key on purpose — it is strictly
  // admin-role-only (requireAdmin on the server, .admin-only in the UI).
];

// Sensible defaults per role.
function defaultPermissionsForRole(role) {
  if (role === 'admin') {
    // Admins start with everything on; the role itself bypasses checks anyway.
    const all = {};
    PERMISSION_KEYS.forEach(k => { all[k] = true; });
    return all;
  }
  if (role === 'agent') {
    // Agents live in the Agent Workspace (agent.html), never the admin portal.
    // Every admin permission is off — their access comes from role checks on
    // the /api/agent/* routes, which are scoped to their own records only.
    const none = {};
    PERMISSION_KEYS.forEach(k => { none[k] = false; });
    return none;
  }
  // Employees default: can manage properties (the most common day-to-day task) but not delete or manage hero/accounts.
  // Tasks: by default they can see the board and post comments on their own tasks; only managers create/edit/delete.
  return {
    dashboard_view: true,        // staff see the basic dashboard...
    dashboard_analytics: false,  // ...but NOT website visitors / who's-online (admin-only by default)
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
    bulkmail_send: false,
    titling_view: false,
    titling_manage: false,
    notarial_view: false,
    notarial_manage: false
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
  role: { type: String, enum: ['admin', 'employee', 'agent'], default: 'employee' },
  // What the person asked to be when they signed up ('agent' from agent.html,
  // 'employee' from the admin portal). Purely informational — the real role is
  // chosen by the admin on the approval screen; nobody self-selects a role.
  requestedRole: { type: String, enum: ['employee', 'agent'], default: 'employee' },
  permissions: { type: mongoose.Schema.Types.Mixed, default: () => defaultPermissionsForRole('employee') },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: null },
  // Updated (throttled) on every authenticated admin API call so the dashboard
  // can show who's currently online / recently active.
  lastSeen: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  // Approval workflow: self-service signups start as 'pending' and cannot log in
  // until an admin approves them (choosing their permissions at that moment).
  // Admin-created accounts and all pre-existing accounts are 'active'.
  status: { type: String, enum: ['pending', 'active'], default: 'active' },
  // Forgot-password flow: we store only the SHA-256 HASH of the reset token
  // (never the token itself) so a database leak can't be used to reset passwords.
  resetTokenHash: { type: String, default: null },
  resetTokenExpires: { type: Date, default: null },
  // Login-alert history (admins only): last few { ip, ua, at } combos we've seen.
  // A sign-in from an ip+device not in this list triggers an alert email.
  loginHistory: { type: [{ ip: String, ua: String, at: Date }], default: [], _id: false }
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
// AGENT SYSTEM (from "GLRA Agent System" workbook — GPS, Actions, Leads,
// Pipeline). One record set per agent account; agents only ever see their own.
// ============================================================================

// A checklist line the agent wrote themselves. _id:false — the 'id' field is
// the key the AgentAction entries map is stored under.
const agentCustomActionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  text: { type: String, required: true }
}, { _id: false });

// ── AGENT PROFILE — GPS inputs (the workbook's yellow cells) ──
const agentProfileSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, unique: true },
  goalStatement: { type: String, default: 'Become a consistent professional producer' },
  // Own-profile details the agent maintains. The name and email live on the
  // Account (they are the sign-in identity); these are the extras.
  contactNo: { type: String, default: '' },
  licenseNo: { type: String, default: '' },
  annualGCI: { type: Number, default: 2400000 },
  avgCommission: { type: Number, default: 150000 },
  workDaysWeek: { type: Number, default: 5 },
  workDaysMonth: { type: Number, default: 22 },
  workDaysYear: { type: Number, default: 250 },
  // Conversion rates, stored as fractions (0.5 = 50%), exactly like the workbook.
  conv: {
    sellerTakenToSold: { type: Number, default: 0.5 },
    sellerApptToTaken: { type: Number, default: 0.8 },
    sellerContactToAppt: { type: Number, default: 0.3 },
    sellerLeadToContact: { type: Number, default: 0.5 },
    buyerViewingToClose: { type: Number, default: 0.3 },
    buyerContactToViewing: { type: Number, default: 0.7 },
    buyerLeadToContact: { type: Number, default: 0.1 }
  },
  // Secret for the phone-calendar feed URL. Knowing the URL = seeing the
  // calendar, so it's a long random token the agent can regenerate any time.
  calToken: { type: String, default: null },
  // 'YYYY-MM-DD' (Manila) of the last morning-agenda email, so the daily
  // reminder tick sends at most one per day per agent.
  lastDigestKey: { type: String, default: null },
  // 'YYYY-MM-DD' (Manila) of the last evening "unfinished actions" nudge —
  // same guard, separate key, so morning and evening never block each other.
  lastNudgeKey: { type: String, default: null },
  // The agent's own checklist edits. customActions are lines they added
  // themselves; hiddenActions are workbook lines they switched off. Custom ids
  // are minted server-side as 'x<hex>' so they can never collide with the
  // workbook's d1-d12 / w1-w8 / m1-m8.
  customActions: {
    daily: { type: [agentCustomActionSchema], default: () => [] },
    weekly: { type: [agentCustomActionSchema], default: () => [] },
    monthly: { type: [agentCustomActionSchema], default: () => [] }
  },
  hiddenActions: { type: [String], default: () => [] },
  // Reworded workbook lines: { actionId: text }. Only lines the agent actually
  // changed are stored, so a future wording fix in ACTION_DEFS still reaches
  // everyone who left that line alone.
  renamedActions: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // How many times an action has to be done in its period: { actionId: n }.
  // Absent means once. This is the TARGET and nothing else — the tally of what
  // was actually done lives in AgentAction.entries and only moves when the
  // agent taps DONE, so setting a target can never mark anything complete.
  actionTargets: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Which automatic emails this agent wants. Both on by default; the workspace
  // has a switch for each.
  emailPrefs: {
    morningDigest: { type: Boolean, default: true },
    actionNudge: { type: Boolean, default: true }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ── AGENT ACTIONS — one doc per agent per period ──
// periodKey examples: daily '2026-08-17', weekly '2026-W34', monthly '2026-08'
// (all computed in Asia/Manila). A new period simply means a new key, so
// checklists "reset" automatically and history is kept for free.
const agentActionSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  periodType: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
  periodKey: { type: String, required: true },
  // { actionId: qtyDone } — action definitions live in server/agents.js
  entries: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  updatedAt: { type: Date, default: Date.now }
});
agentActionSchema.index({ account: 1, periodType: 1, periodKey: 1 }, { unique: true });

// ── AGENT LEAD — the Lead Journal ──
const AGENT_LEAD_STAGES = ['Inquiry', 'Follow-up', 'Ocular Visitation', 'Negotiation', 'Signing of Contract', 'Closing', 'Unsuccessful'];
// One step in a lead's own pipeline: stamped every time its stage changes.
const agentStageStepSchema = new mongoose.Schema({
  stage: { type: String, required: true },
  at: { type: Date, default: Date.now }
}, { _id: false });
// One email the agent sent this client from the workspace. Subject and time
// only — the body is not kept, so the record stays small and the client's
// message isn't duplicated in two places.
const agentEmailLogSchema = new mongoose.Schema({
  to: { type: String, default: '' },
  subject: { type: String, default: '' },
  at: { type: Date, default: Date.now }
}, { _id: false });
const agentLeadSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  date: { type: Date, default: Date.now },
  name: { type: String, required: true, trim: true },
  contactNo: { type: String, default: '' },
  email: { type: String, default: '' },
  // Client's birthday — per the owner's instruction. Feeds the calendar and
  // the "greet them today" reminder. Personal data: visible only to the
  // owning agent and the broker.
  birthday: { type: Date, default: null },
  // Owner / Buyer / Tenant / Broker / Agent, or whatever the agent typed into
  // the "Other" box. Free text rather than an enum precisely so a category
  // nobody thought of does not need a code change to record.
  category: { type: String, default: 'Buyer', trim: true, maxlength: 60 },
  propertyInterest: { type: String, default: '' },
  source: { type: String, default: '' },
  actionToTake: { type: String, default: '' },
  // Kept for leads recorded before co-broking became a category. Nothing writes
  // it any more; it is still read so an old value never silently disappears.
  brokerAgent: { type: String, default: '' },
  stage: { type: String, enum: AGENT_LEAD_STAGES, default: 'Inquiry' },
  // This lead's own pipeline: every stage it has passed through, in order.
  stageHistory: { type: [agentStageStepSchema], default: () => [] },
  reasonLost: { type: String, default: '' },
  nextFollowUp: { type: Date, default: null },
  closingDate: { type: Date, default: null },
  // What the agent actually earned on this deal, entered once it reaches
  // Closing. Summed on the GPS page against the desired annual GCI so the goal
  // always reads as "still to earn". The goal itself is never overwritten.
  commissionEarned: { type: Number, default: 0, min: 0 },
  remarks: { type: String, default: '' },
  // Emails the agent sent this client from the workspace (newest last, capped).
  emailLog: { type: [agentEmailLogSchema], default: () => [] },
  // Set when the lead came from a website inquiry an admin assigned over:
  // { inquiryId, by, at }
  assignedFrom: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ── AGENT EVENT — manual calendar entries (viewings, appointments) ──
const agentEventSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  title: { type: String, required: true, trim: true },
  date: { type: Date, required: true },
  time: { type: String, default: '' }, // 'HH:MM' 24h, optional
  type: { type: String, enum: ['viewing', 'appointment', 'other'], default: 'other' },
  leadName: { type: String, default: '' },
  notes: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

// ── AGENT NOTIFICATION — the workspace bell ──
// dedupeKey (e.g. 'fu:<leadId>:2026-08-17', 'bd:<leadId>:2026') makes the
// daily tick idempotent: re-running it can never double-post a reminder.
const agentNotificationSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  dedupeKey: { type: String, required: true },
  type: { type: String, default: 'info' }, // followup | birthday | anniversary | lead | info
  message: { type: String, required: true },
  leadId: { type: String, default: null },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
agentNotificationSchema.index({ account: 1, dedupeKey: 1 }, { unique: true });

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
const TitlingCase       = mongoose.model('TitlingCase',       titlingCaseSchema);
const NotarialJob       = mongoose.model('NotarialJob',       notarialJobSchema);
const CashEntry         = mongoose.model('CashEntry',         cashEntrySchema);
const SiteStat          = mongoose.model('SiteStat',          siteStatSchema);
const CalcUsage         = mongoose.model('CalcUsage',         calcUsageSchema);
const AgentProfile      = mongoose.model('AgentProfile',      agentProfileSchema);
const AgentAction       = mongoose.model('AgentAction',       agentActionSchema);
const AgentLead         = mongoose.model('AgentLead',         agentLeadSchema);
const AgentEvent        = mongoose.model('AgentEvent',        agentEventSchema);
const AgentNotification = mongoose.model('AgentNotification', agentNotificationSchema);

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
  TitlingCase,
  NotarialJob,
  CashEntry,
  SiteStat,
  CalcUsage,
  AgentProfile,
  AgentAction,
  AgentLead,
  AgentEvent,
  AgentNotification,
  AGENT_LEAD_STAGES,
  // permissions
  PERMISSION_KEYS,
  defaultPermissionsForRole
};
