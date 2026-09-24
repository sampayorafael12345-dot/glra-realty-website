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
  // Which way the unit's main windows face (N, NE, E, SE, S, SW, W, NW, or
  // blank). Optional; the listing page's sun path explains what it means.
  facing: { type: String, default: '' },
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
  views: { type: Number, default: 0 },
  // Freshness for the admin "Listing health" check. editedAt: last save from
  // the edit form. reviewedAt: staff pressed "Still available". Both are
  // system fields (never taken from a form body).
  editedAt: { type: Date, default: null },
  reviewedAt: { type: Date, default: null },
  // SYSTEM fields, written only by the location worker in server.js (never by
  // a form: stripPrivilegedPropertyFields drops them from every admin write).
  // geo: where OpenStreetMap's Nominatim puts this listing's location text.
  //   q is the exact text that was looked up, so a changed address is noticed;
  //   rank is Nominatim's place_rank (16 = a whole city, 26+ = a street), used
  //   to keep "what's nearby" off listings only known to the nearest city.
  geo: {
    lat: { type: Number },
    lng: { type: Number },
    q: { type: String },
    status: { type: String },   // 'ok' | 'none' | 'error'
    rank: { type: Number },
    tries: { type: Number },
    at: { type: Date }
  },
  // Closest train stations, malls, hospitals and schools (OpenStreetMap via
  // Overpass), up to three of each, straight-line metres from geo.
  nearby: {
    at: { type: Date },
    items: [{ _id: false, cat: String, name: String, dist: Number, lat: Number, lng: Number }],
    // Everyday places counted within 500 m and 1 km, for the lifestyle
    // score: { grocery: [n500, n1000], dining, park, health, transit, school }.
    life: { type: mongoose.Schema.Types.Mixed, default: undefined }
  }
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

// ── SAVED SEARCHES (Property Finder email alerts) ──────────
// A visitor saves the filters they used on /properties.html and gets ONE
// email when new listings matching them go live. Double opt-in: nothing is
// sent (and they are not added to Subscriber) until they click the
// confirmation link. `token` is the only key the public ever holds; it opens
// the confirm / manage / unsubscribe page and must never be sent to staff
// screens. `sentPropertyIds` starts as a baseline of everything that already
// matched at sign-up, so only genuinely new listings are ever emailed.
const savedSearchSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  criteria: {
    category:     { type: String, enum: ['', 'FOR SALE', 'FOR LEASE'], default: '' },
    q:            { type: String, default: '', maxlength: 80 },
    propertyType: { type: String, default: '' },
    minBeds:      { type: Number, default: 0 },
    minBaths:     { type: Number, default: 0 },
    minPrice:     { type: Number, default: 0 },
    maxPrice:     { type: Number, default: 0 },
    // A circle drawn on the properties page map: centre and radius in metres.
    area: {
      type: new mongoose.Schema({ lat: Number, lng: Number, r: Number }, { _id: false }),
      default: null
    }
  },
  summary:         { type: String, default: '' },
  token:           { type: String, required: true, unique: true },
  confirmed:       { type: Boolean, default: false },
  confirmedAt:     { type: Date, default: null },
  active:          { type: Boolean, default: true },
  sentPropertyIds: { type: [String], default: [] },
  emailsSent:      { type: Number, default: 0 },
  lastSentAt:      { type: Date, default: null },
  vid:             { type: String, default: '' },
  confirmSentAt:   { type: Date, default: null },
  createdAt:       { type: Date, default: Date.now }
});
savedSearchSchema.index({ confirmed: 1, active: 1 });
savedSearchSchema.index({ email: 1 });

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
  // The Notarial tab was replaced by Cases in September 2026. The two keys are
  // kept so existing staff accounts keep loading, but nothing reads them now.
  'notarial_view',
  'notarial_manage',
  'cases_view',          // see the Cases tab (a law-firm matter is privileged)
  'cases_manage',        // open / edit cases, log hearings, record fees
  'leasing_view',        // see the Leasing tab (leases, rent roll, statements)
  'leasing_manage'       // add / edit leases, record payments, send tenant emails
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
    notarial_manage: false,
    // Case files are covered by lawyer-client confidentiality, so a new staff
    // account starts with no access at all and an admin grants it deliberately.
    cases_view: false,
    cases_manage: false,
    leasing_view: false,
    leasing_manage: false
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

// ── LEASING ─────────────────────────────────────────────────
// One document per lease (or prospective lease). The whole life of a rental
// lives here: who owns it, who rents it, the terms, every peso that came in,
// the documents, the email trail. Money math (schedule, balance, overdue) is
// NOT stored — it is recomputed from `payments` + the terms on every read by

// ── LAW FIRM: CASES ─────────────────────────────────────────
// One Case document is the whole life of a legal matter, from the intake
// interview to the entry of judgment. It replaced the Notarial tab in the
// admin (the notarial records above are kept but no longer shown).
//
// Design rule, same as leasing: money is never stored as a running total.
// The fees owed, the payments received and the balance are all recomputed on
// every read from the charge list plus the payment list, so correcting one
// entry corrects every figure that depends on it.
//
// The stages are written to fit civil, criminal, labour and administrative
// matters with one vocabulary, because a small firm runs all of them off one
// board:
//   intake       - engaged, conflict check, no filing yet
//   pre_filing   - demand letter, barangay conciliation, drafting the pleading
//   filed        - filed and pending (summons / answer / preliminary investigation)
//   pre_trial    - pre-trial, court-annexed mediation, JDR
//   trial        - hearings and presentation of evidence
//   decision     - submitted for decision / awaiting promulgation
//   post_judgment- appeal, motion for reconsideration, execution
//   closed       - terminated, withdrawn, settled or fully executed
//   on_hold      - archived / dormant / client unresponsive
const CASE_STAGES = ['intake', 'pre_filing', 'filed', 'pre_trial', 'trial',
                     'decision', 'post_judgment', 'closed', 'on_hold'];

// A court date. `purpose` is free text so it can hold anything from
// "Arraignment" to "Presentation of defence evidence, 3rd witness".
const caseHearingSchema = new mongoose.Schema({
  date:      { type: Date, default: null },
  time:      { type: String, default: '', trim: true, maxlength: 20 },   // "08:30 AM"
  purpose:   { type: String, default: '', trim: true, maxlength: 300 },
  venue:     { type: String, default: '', trim: true, maxlength: 300 },
  appearedBy:{ type: String, default: '', trim: true, maxlength: 200 },  // which lawyer went
  result:    { type: String, default: '', trim: true, maxlength: 2000 }, // what happened
  reset:     { type: Boolean, default: false },                          // hearing was reset/cancelled
  billed:    { type: Boolean, default: false },                          // appearance fee already charged
  notified:  { type: Boolean, default: false }                           // client was reminded
}, { timestamps: true });

// A dated obligation. `rule` records WHY the date is what it is, which is the
// part a lawyer needs when a deadline is questioned months later.
const caseDeadlineSchema = new mongoose.Schema({
  title:     { type: String, required: true, trim: true, maxlength: 300 },
  dueDate:   { type: Date, default: null },
  rule:      { type: String, default: '', trim: true, maxlength: 300 },  // "Answer - 30 calendar days from service of summons"
  critical:  { type: Boolean, default: false },   // missing it kills the case
  done:      { type: Boolean, default: false },
  doneDate:  { type: Date, default: null },
  doneBy:    { type: String, default: '', trim: true, maxlength: 200 },
  notes:     { type: String, default: '', maxlength: 2000 }
}, { timestamps: true });

// Anything filed with, or received from, the court or the other side.
const caseFilingSchema = new mongoose.Schema({
  title:     { type: String, required: true, trim: true, maxlength: 300 },
  direction: { type: String, enum: ['filed', 'received'], default: 'filed' },
  date:      { type: Date, default: null },
  mode:      { type: String, default: '', trim: true, maxlength: 60 },   // Personal / Registered mail / E-filing / Courier
  by:        { type: String, default: '', trim: true, maxlength: 200 },
  notes:     { type: String, default: '', maxlength: 3000 }
}, { timestamps: true });

// Billable work. Kept even for fixed-fee matters, because it is the evidence
// behind a fee if the client ever queries it or a court assesses it.
const caseTimeSchema = new mongoose.Schema({
  date:        { type: Date, default: null },
  description: { type: String, default: '', trim: true, maxlength: 500 },
  hours:       { type: Number, default: 0 },
  rate:        { type: Number, default: 0 },
  billable:    { type: Boolean, default: true },
  billed:      { type: Boolean, default: false },
  by:          { type: String, default: '', trim: true, maxlength: 200 }
}, { timestamps: true });

// What the client owes. Acceptance fee, each appearance, filing and docket
// fees advanced by the firm, transcripts, travel.
const caseChargeSchema = new mongoose.Schema({
  kind:   { type: String, default: 'professional', trim: true, maxlength: 40 },
  label:  { type: String, default: '', trim: true, maxlength: 300 },
  amount: { type: Number, default: 0 },
  date:   { type: Date, default: null },
  reimbursable: { type: Boolean, default: false },   // firm advanced it, client repays at cost
  notes:  { type: String, default: '', maxlength: 1000 }
}, { timestamps: true });

const casePaymentSchema = new mongoose.Schema({
  date:      { type: Date, default: null },
  amount:    { type: Number, default: 0 },
  mode:      { type: String, default: 'Cash', trim: true, maxlength: 40 },
  reference: { type: String, default: '', trim: true, maxlength: 120 },
  label:     { type: String, default: '', trim: true, maxlength: 200 },
  receiptNo: { type: String, default: '', trim: true, maxlength: 40 },
  notes:     { type: String, default: '', maxlength: 1000 }
}, { timestamps: true });

// Case documents live in Cloudinary as authenticated resources, exactly like
// the owner-intake papers: the bytes never sit in this database and the admin
// mints a short-lived signed link to open one. These are privileged.
const caseFileSchema = new mongoose.Schema({
  publicId:     { type: String, required: true },
  resourceType: { type: String, default: 'image' },
  format:       { type: String, default: '' },
  bytes:        { type: Number, default: 0 },
  name:         { type: String, default: '', maxlength: 200 },
  label:        { type: String, default: '', trim: true, maxlength: 200 },
  // photo / pleading / order / evidence / id / receipt / letter / other
  category:     { type: String, default: '', trim: true, maxlength: 30 },
  width:        { type: Number, default: 0 },
  height:       { type: Number, default: 0 },
  pages:        { type: Number, default: 0 },
  uploadedByName: { type: String, default: '' },
  uploadedAt:   { type: Date, default: Date.now }
});

const caseNoteSchema = new mongoose.Schema({
  body:   { type: String, default: '', maxlength: 8000 },
  byName: { type: String, default: '' },
  at:     { type: Date, default: Date.now }
}, { _id: true });

const caseHistorySchema = new mongoose.Schema({
  at:     { type: Date, default: Date.now },
  what:   { type: String, default: '', maxlength: 500 },
  byName: { type: String, default: '' }
}, { _id: false });

// A party on the other side. Stored as its own list rather than one text field
// so the conflict check can search it: before taking a new client the firm has
// to know whether that person is already an adverse party in an open matter.
const casePartySchema = new mongoose.Schema({
  name:    { type: String, default: '', trim: true, maxlength: 250 },
  role:    { type: String, default: '', trim: true, maxlength: 80 },  // Defendant / Respondent / Accused / Oppositor
  counsel: { type: String, default: '', trim: true, maxlength: 250 },
  contact: { type: String, default: '', trim: true, maxlength: 200 }
}, { _id: false });

const caseSchema = new mongoose.Schema({
  // ── identity ──
  caseRef:      { type: String, default: '', trim: true, index: true, maxlength: 40 },  // firm's own file no. "C-2026-0001"
  title:        { type: String, required: true, trim: true, maxlength: 400 },           // "People v. Dela Cruz"
  docketNumber: { type: String, default: '', trim: true, index: true, maxlength: 120 }, // the court's number
  court:        { type: String, default: '', trim: true, maxlength: 200 },
  branch:       { type: String, default: '', trim: true, maxlength: 120 },
  courtCity:    { type: String, default: '', trim: true, maxlength: 160 },
  judge:        { type: String, default: '', trim: true, maxlength: 200 },

  // ── classification ──
  caseType:     { type: String, default: '', trim: true, maxlength: 60 },   // civil / criminal / labor / family / ...
  natureOfAction: { type: String, default: '', trim: true, maxlength: 300 },// "Unlawful Detainer", "Estafa", "Illegal Dismissal"
  stage:        { type: String, default: 'intake', trim: true, maxlength: 40 },
  priority:     { type: String, enum: ['normal', 'high', 'urgent'], default: 'normal' },

  // ── our client ──
  clientName:   { type: String, required: true, trim: true, index: true, maxlength: 250 },
  clientPhone:  { type: String, default: '', trim: true, maxlength: 50 },
  clientEmail:  { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },
  clientAddress:{ type: String, default: '', trim: true, maxlength: 400 },
  clientKind:   { type: String, enum: ['', 'individual', 'company', 'government'], default: '' },
  clientRole:   { type: String, default: '', trim: true, maxlength: 80 },   // Plaintiff / Accused / Complainant...
  account:      { type: String, default: '', trim: true, maxlength: 200 },  // retainer client / referring firm

  // ── the other side ──
  adverseParties: { type: [casePartySchema], default: [] },

  // ── our team ──
  leadCounsel:  { type: String, default: '', trim: true, maxlength: 200 },
  collaborating:{ type: String, default: '', trim: true, maxlength: 300 },

  // ── key dates ──
  dateEngaged:  { type: Date, default: null },
  dateFiled:    { type: Date, default: null },
  prescriptiveDate: { type: Date, default: null },  // the last day to file. The most dangerous date in the file.
  dateClosed:   { type: Date, default: null },
  outcome:      { type: String, default: '', trim: true, maxlength: 300 },

  // ── barangay conciliation (a condition precedent for many civil suits) ──
  barangayRequired: { type: Boolean, default: false },
  barangayName: { type: String, default: '', trim: true, maxlength: 200 },
  cfaIssued:    { type: Boolean, default: false },   // Certificate to File Action in hand
  cfaDate:      { type: Date, default: null },

  // ── money ──
  feeArrangement: { type: String, default: '', trim: true, maxlength: 40 },
  acceptanceFee:  { type: Number, default: 0 },
  appearanceFee:  { type: Number, default: 0 },   // per hearing attended
  retainerAmount: { type: Number, default: 0 },   // per month, for retainer clients
  hourlyRate:     { type: Number, default: 0 },
  contingencyPct: { type: Number, default: 0 },
  charges:      { type: [caseChargeSchema],  default: [] },
  payments:     { type: [casePaymentSchema], default: [] },
  timeEntries:  { type: [caseTimeSchema],    default: [] },

  // ── the file ──
  hearings:     { type: [caseHearingSchema],  default: [] },
  deadlines:    { type: [caseDeadlineSchema], default: [] },
  filings:      { type: [caseFilingSchema],   default: [] },
  files:        { type: [caseFileSchema],     default: [] },
  notes:        { type: [caseNoteSchema],     default: [] },
  history:      { type: [caseHistorySchema],  default: [] },
  summary:      { type: String, default: '', maxlength: 8000 },   // facts of the case

  // ── conflict check (Canon III, CPRA: the firm must clear conflicts first) ──
  conflictCheckedAt:   { type: Date, default: null },
  conflictCheckedBy:   { type: String, default: '', trim: true, maxlength: 200 },
  conflictNotes:       { type: String, default: '', maxlength: 2000 },

  autoEmails:   { type: Boolean, default: true },   // hearing reminders to this client
  reminderKeys: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy:     { type: String, default: '' },
  createdByName: { type: String, default: '' }
}, { timestamps: true });

// The board groups by stage and the lists sort by the next thing that happens.
caseSchema.index({ stage: 1, updatedAt: -1 });
caseSchema.index({ clientName: 'text', title: 'text', docketNumber: 'text' });


// server/leasing.js, so a corrected payment can never leave a stale balance.
const LEASE_STAGES = ['prospect', 'viewing', 'application', 'contract', 'active', 'renewal', 'ended', 'on_hold'];

// Files (contract, IDs, proof of payment) go to Cloudinary as `authenticated`
// resources, exactly like the owner-intake documents: only the publicId is
// stored and every view is a signed link that expires in minutes.
const leaseFileSchema = new mongoose.Schema({
  publicId:       { type: String, required: true },
  resourceType:   { type: String, default: 'image' },
  format:         { type: String, default: '' },
  bytes:          { type: Number, default: 0 },
  name:           { type: String, default: '', maxlength: 200 },   // original filename
  label:          { type: String, default: '', maxlength: 120 },   // 'Contract of Lease', 'Tenant ID', 'Proof of payment'
  paymentId:      { type: String, default: '' },                   // set when the file is proof for one payment
  uploadedByName: { type: String, default: '' },
  uploadedAt:     { type: Date, default: Date.now }
});

const leasePaymentSchema = new mongoose.Schema({
  date:      { type: Date, default: null },
  amount:    { type: Number, default: 0 },
  // rent/advance pay the rent schedule; deposit is held (never income);
  // dues/utilities/penalty/other settle one-off charges.
  kind:      { type: String, enum: ['rent', 'advance', 'deposit', 'dues', 'utilities', 'penalty', 'other'], default: 'rent' },
  mode:      { type: String, default: 'Cash', trim: true, maxlength: 40 },   // Cash / Bank transfer / GCash / Cheque
  reference: { type: String, default: '', trim: true, maxlength: 120 },     // bank ref / cheque no.
  forPeriod: { type: String, default: '', maxlength: 7 },                   // 'YYYY-MM' the payer says it covers
  note:      { type: String, default: '', maxlength: 500 },
  receiptNo: { type: String, default: '' },                                 // AR-2026-0001, minted server-side
  recordedByName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const leaseChargeSchema = new mongoose.Schema({
  date:   { type: Date, default: null },
  label:  { type: String, default: '', trim: true, maxlength: 200 },
  kind:   { type: String, enum: ['dues', 'utilities', 'penalty', 'repair', 'other'], default: 'other' },
  amount: { type: Number, default: 0 },
  note:   { type: String, default: '', maxlength: 500 },
  createdAt: { type: Date, default: Date.now }
});

const leaseNoteSchema = new mongoose.Schema({
  at:     { type: Date, default: Date.now },
  byName: { type: String, default: '' },
  kind:   { type: String, default: 'note' },   // note | stage | email | payment | system
  text:   { type: String, default: '', maxlength: 2000 }
});

const leaseEmailLogSchema = new mongoose.Schema({
  at:      { type: Date, default: Date.now },
  to:      { type: String, default: '' },
  kind:    { type: String, default: '' },
  subject: { type: String, default: '' },
  auto:    { type: Boolean, default: false },   // sent by the reminder engine, not a person
  byName:  { type: String, default: '' }
});

const leaseSchema = new mongoose.Schema({
  stage:        { type: String, enum: LEASE_STAGES, default: 'prospect', index: true },
  stageHistory: { type: [{ stage: String, at: Date, byName: String }], default: [], _id: false },
  // ── the unit ──
  propertyId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Property', default: null },
  propertyTitle: { type: String, default: '', trim: true, maxlength: 200 },
  unit:          { type: String, default: '', trim: true, maxlength: 80 },
  address:       { type: String, default: '', trim: true, maxlength: 300 },
  propertyType:  { type: String, default: '', trim: true, maxlength: 60 },
  furnished:     { type: String, enum: ['', 'unfurnished', 'semi', 'full'], default: '' },
  parkingSlots:  { type: Number, default: 0 },
  // When the lease goes Active the linked listing is hidden from the website
  // (status 'sold', which the admin labels Sold / Leased). Relisting is a
  // deliberate button on an ended lease, never automatic.
  hideListingWhileActive: { type: Boolean, default: true },
  // ── the owner (lessor) ──
  ownerName:    { type: String, default: '', trim: true, maxlength: 200 },
  ownerPhone:   { type: String, default: '', trim: true, maxlength: 50 },
  ownerPhone2:  { type: String, default: '', trim: true, maxlength: 50 },
  ownerEmail:   { type: String, default: '', trim: true, maxlength: 120 },
  ownerAddress: { type: String, default: '', trim: true, maxlength: 300 },
  // Identity as a lease contract recites it, plus the TIN the lessor needs in
  // order to declare the rental income.
  ownerCivilStatus: { type: String, default: '', trim: true, maxlength: 40 },
  ownerSpouse:  { type: String, default: '', trim: true, maxlength: 200 },
  ownerIdType:  { type: String, default: '', trim: true, maxlength: 60 },
  ownerIdNo:    { type: String, default: '', trim: true, maxlength: 60 },
  ownerTin:     { type: String, default: '', trim: true, maxlength: 40 },
  // Where an SPA holder or property manager signs instead of the owner.
  ownerRep:     { type: String, default: '', trim: true, maxlength: 200 },
  ownerRepPhone:{ type: String, default: '', trim: true, maxlength: 50 },
  // Where the owner's share is sent on a GLRA-managed unit. Admin-only: this
  // never appears on a tenant statement or on the public site.
  ownerRemittance: { type: String, default: '', trim: true, maxlength: 400 },
  managedByGLRA:    { type: Boolean, default: false },   // GLRA collects rent for the owner
  managementFeePct: { type: Number, default: 0 },        // % of collected rent kept as management fee
  // ── the tenant (lessee) ──
  tenantName:       { type: String, default: '', trim: true, maxlength: 200 },
  tenantPhone:      { type: String, default: '', trim: true, maxlength: 50 },
  tenantEmail:      { type: String, default: '', trim: true, maxlength: 120 },
  tenantPhone2:     { type: String, default: '', trim: true, maxlength: 50 },
  tenantAddress:    { type: String, default: '', trim: true, maxlength: 300 },
  tenantIdType:     { type: String, default: '', trim: true, maxlength: 60 },
  tenantIdNo:       { type: String, default: '', trim: true, maxlength: 60 },
  tenantTin:        { type: String, default: '', trim: true, maxlength: 40 },
  tenantNationality:{ type: String, default: '', trim: true, maxlength: 60 },
  tenantCivilStatus:{ type: String, default: '', trim: true, maxlength: 40 },
  tenantSpouse:     { type: String, default: '', trim: true, maxlength: 200 },
  tenantOccupation: { type: String, default: '', trim: true, maxlength: 120 },
  tenantCompany:    { type: String, default: '', trim: true, maxlength: 120 },
  tenantWorkAddress:{ type: String, default: '', trim: true, maxlength: 300 },
  occupants:        { type: Number, default: 1 },
  emergencyName:    { type: String, default: '', trim: true, maxlength: 200 },
  emergencyPhone:   { type: String, default: '', trim: true, maxlength: 50 },
  emergencyRelation:{ type: String, default: '', trim: true, maxlength: 60 },
  emergencyAddress: { type: String, default: '', trim: true, maxlength: 300 },
  // ── terms ──
  startDate:      { type: Date, default: null },
  endDate:        { type: Date, default: null },
  termMonths:     { type: Number, default: 12 },
  monthlyRent:    { type: Number, default: 0 },
  dueDay:         { type: Number, default: 5 },     // rent falls due on this day each month
  graceDays:      { type: Number, default: 5 },     // days after the due date before it counts as late
  escalationPct:  { type: Number, default: 0 },     // yearly increase applied from month 13
  depositMonths:  { type: Number, default: 2 },
  depositAmount:  { type: Number, default: 0 },
  advanceMonths:  { type: Number, default: 1 },
  advanceAmount:  { type: Number, default: 0 },
  lateFeeType:    { type: String, enum: ['none', 'percent', 'fixed'], default: 'none' },
  lateFeeValue:   { type: Number, default: 0 },
  duesPaidBy:     { type: String, enum: ['', 'tenant', 'owner'], default: 'tenant' },
  utilitiesIncluded: { type: String, default: '', trim: true, maxlength: 200 },
  inclusions:     { type: String, default: '', trim: true, maxlength: 500 },   // furniture, appliances, parking slot no.
  petsAllowed:    { type: Boolean, default: false },
  viewingAt:      { type: Date, default: null },    // prospect stage: scheduled viewing
  // ── broker economics ──
  brokerFeeType:      { type: String, enum: ['one_month', 'percent', 'fixed', 'none'], default: 'one_month' },
  brokerFeeValue:     { type: Number, default: 0 },   // % of annual rent, or the fixed amount
  brokerFeePaidBy:    { type: String, enum: ['owner', 'tenant', 'both'], default: 'owner' },
  brokerFeeCollected: { type: Number, default: 0 },
  // ── ledger ──
  payments: { type: [leasePaymentSchema], default: [] },
  charges:  { type: [leaseChargeSchema], default: [] },
  files:    { type: [leaseFileSchema], default: [] },
  notes:    { type: [leaseNoteSchema], default: [] },
  emailLog: { type: [leaseEmailLogSchema], default: [] },
  // ── move-in / move-out ──
  moveInDate:        { type: Date, default: null },
  moveOutDate:       { type: Date, default: null },
  moveInNotes:       { type: String, default: '', maxlength: 3000 },   // condition on turnover, meter readings
  depositDeductions: { type: [{ label: String, amount: Number }], default: [], _id: false },
  depositRefunded:   { type: Number, default: 0 },
  depositRefundDate: { type: Date, default: null },
  renewalDecision:   { type: String, enum: ['', 'undecided', 'renew', 'vacate'], default: '' },
  // ── automation ──
  autoEmails:   { type: Boolean, default: true },   // per-lease switch for the reminder engine
  // Dedupe map for the reminder engine, e.g. { 'rd:2026-10': '2026-10-02' }.
  // A key present means that reminder already went out; the tick never resends.
  reminderKeys: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  remarks: { type: String, default: '', maxlength: 5000 },
  source:  { type: String, default: '' },           // e.g. 'inquiry:<id>'
  createdBy:     { type: String, default: '' },
  createdByName: { type: String, default: '' }
}, { timestamps: true });
leaseSchema.index({ stage: 1, endDate: 1 });
leaseSchema.index({ tenantName: 1 });

// ── SETTINGS (key/value) ───────────────────────────────────
// Small singleton configs such as the leasing reminder preferences and the
// calendar-feed token. One doc per key; `value` is free-form JSON.
const settingSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true },
  value:     { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  updatedAt: { type: Date, default: Date.now }
});

// ── COUNTERS ───────────────────────────────────────────────
// Atomic sequence numbers (receipt numbers). findOneAndUpdate + $inc is
// atomic in MongoDB, so two payments saved at the same second still get
// different numbers.
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 }
});

// ============================================================================
// COMPILED MODELS
// ============================================================================
const Property          = mongoose.model('Property',          propertySchema);
const Inquiry           = mongoose.model('Inquiry',           inquirySchema);
const HeroImage         = mongoose.model('HeroImage',         heroImageSchema);
const Subscriber        = mongoose.model('Subscriber',        subscriberSchema);
const PriceAlert        = mongoose.model('PriceAlert',        priceAlertSchema);
const SavedSearch       = mongoose.model('SavedSearch',       savedSearchSchema);
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
const Lease             = mongoose.model('Lease',             leaseSchema);
const Setting           = mongoose.model('Setting',           settingSchema);
const Counter           = mongoose.model('Counter',           counterSchema);
const Case              = mongoose.model('Case',              caseSchema);

module.exports = {
  // models
  Property,
  Inquiry,
  HeroImage,
  Subscriber,
  PriceAlert,
  SavedSearch,
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
  Lease,
  Setting,
  Counter,
  Case,
  AGENT_LEAD_STAGES,
  LEASE_STAGES,
  CASE_STAGES,
  // permissions
  PERMISSION_KEYS,
  defaultPermissionsForRole
};
