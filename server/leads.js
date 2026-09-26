// =============================================================================
// LEADS — one record per person, every touch in one place
// =============================================================================
// The server side of the admin "Leads" tab. A lead is a PERSON: their website
// enquiries, valuation requests, owner submissions, saved searches, price
// alerts, wishlist saves and newsletter sign-up are all folded into one
// document (matched on email, then on mobile number), with the staff's own
// calls, messages and notes kept alongside.
//
// What lives here:
//   * ingestLead(): called by server.js wherever a form arrives. Never throws.
//   * backfillLeads(): one-time import of everything collected before the tab
//     existed (guarded by a Setting, so it runs once).
//   * scoring: how likely this person is to transact soon, 0-100
//   * listing matches for a lead, and the "email these listings" sender
//   * the /api/admin/leads* routes (leads_view / leads_manage / leads_delete)
//   * the lead tick: a nudge when a new lead has waited too long for a reply,
//     and one morning digest.
//
// Registered from server.js:
//   const { registerLeadRoutes, startLeadsTick, ingestLead, backfillLeads } = require('./server/leads');
// =============================================================================
const { Lead, ListingView, CalcUsage, Property, Inquiry, PropertySubmission, SavedSearch, PriceAlert, Wishlist,
  Subscriber, Setting, Account, AgentLead, AgentNotification, LEAD_STAGES, LEAD_TYPES } = require('./db');
const { verifyToken, requirePermission, logAudit } = require('./auth');
const { getEmailHeader, getEmailFooter } = require('./email-templates');
const { applyWebsiteCover } = require('./cover');

const SITE_URL = 'https://glrarealty.com';
const BROKER_INBOX = 'glrarealty@gmail.com';
const MAX_SOURCES = 60;
const MAX_ACTIVITIES = 400;

// ── NORMALISING ──────────────────────────────────────────────
function normEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 160 ? s : '';
}
// Philippine mobiles in any common form become 639XXXXXXXXX, so 0917 177
// 4572, +63 917 177 4572 and 9171774572 are one number. Anything else keeps
// its digits (a landline, a foreign number) if it is long enough to mean it.
function normPhone(p) {
  const d = String(p || '').replace(/[^\d]/g, '');
  if (/^09\d{9}$/.test(d)) return '63' + d.slice(1);
  if (/^639\d{9}$/.test(d)) return d;
  if (/^9\d{9}$/.test(d)) return '63' + d;
  return d.length >= 7 && d.length <= 15 ? d : '';
}
function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max); }
function cleanAttrib(a) {
  if (!a || typeof a !== 'object') return undefined;
  const out = {};
  for (const k of ['src', 'med', 'cmp', 'ref', 'land']) {
    const v = cleanText(a[k], k === 'land' ? 200 : 100);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
const pad2 = n => String(n).padStart(2, '0');
function manilaNow() { return new Date(Date.now() + 8 * 3600e3); }
function manilaHour() { return manilaNow().getUTCHours(); }
function manilaDayKey(d) { const x = new Date((d ? new Date(d).getTime() : Date.now()) + 8 * 3600e3); return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`; }

// ── WHAT A LISTING OR A SEARCH SAYS ABOUT WHAT SOMEONE WANTS ──
function baseType(t) {
  const s = String(t || '').toLowerCase();
  if (/condo|studio|apartment|loft|penthouse/.test(s)) return 'Condominium';
  if (/town ?house/.test(s)) return 'Townhouse';
  if (/house/.test(s)) return 'House and Lot';
  if (/commercial lot|industrial/.test(s)) return 'Commercial Lot';
  if (/farm|agri/.test(s)) return 'Agricultural Lot';
  if (/lot/.test(s)) return 'Residential Lot';
  if (/office|commercial|retail|warehouse|building/.test(s)) return 'Commercial';
  return String(t || '').trim().slice(0, 40);
}
const CITY_WORDS = ['Makati', 'Taguig', 'BGC', 'Pasig', 'Ortigas', 'Mandaluyong', 'Quezon City', 'Manila', 'Pasay', 'Paranaque', 'Parañaque',
  'Muntinlupa', 'Alabang', 'Las Pinas', 'Las Piñas', 'San Juan', 'Marikina', 'Caloocan', 'Valenzuela', 'Antipolo', 'Cainta', 'Taytay',
  'Tagaytay', 'Cavite', 'Laguna', 'Santa Rosa', 'Nuvali', 'Binan', 'Biñan', 'Batangas', 'Bulacan', 'Pampanga', 'Cebu', 'Davao', 'Rizal', 'Rockwell', 'Eastwood', 'Katipunan'];
function areaOf(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  return CITY_WORDS.filter(w => t.includes(w.toLowerCase())).slice(0, 2);
}
function isLeaseListing(p) { return String(p.listingType || '').toUpperCase() === 'FOR LEASE'; }
function listingPrice(p, rent) {
  return rent ? (Number(p.monthlyRental) || (isLeaseListing(p) ? Number(p.price) : 0) || 0) : (isLeaseListing(p) ? 0 : Number(p.price) || 0);
}
function hintsFromListing(p) {
  if (!p) return {};
  const rent = isLeaseListing(p);
  const price = listingPrice(p, rent);
  return {
    deal: rent ? 'rent' : 'buy',
    budgetMax: price ? Math.round(price * 1.15) : 0,
    budgetMin: price ? Math.round(price * 0.6) : 0,
    areas: areaOf(p.location + ' ' + p.title),
    types: p.propertyType ? [baseType(p.propertyType)] : [],
    beds: Number(p.bedrooms) || 0
  };
}
function hintsFromCriteria(c) {
  if (!c) return {};
  return {
    deal: c.category === 'FOR LEASE' ? 'rent' : c.category === 'FOR SALE' ? 'buy' : '',
    budgetMin: Number(c.minPrice) || 0,
    budgetMax: Number(c.maxPrice) || 0,
    areas: c.q ? areaOf(c.q).concat(areaOf(c.q).length ? [] : [cleanText(c.q, 40)]) : [],
    types: c.propertyType ? [baseType(c.propertyType)] : [],
    beds: Number(c.minBeds) || 0
  };
}
function plainIntent(lead) { return JSON.parse(JSON.stringify((lead && lead.intent) || {})); }
// Only fills what is still blank: anything staff typed wins over a guess.
function mergeIntent(intent, h) {
  const i = intent || {};
  if (!h) return i;
  if (!i.deal && h.deal) i.deal = h.deal;
  if (!i.budgetMax && h.budgetMax) { i.budgetMax = h.budgetMax; if (!i.budgetMin && h.budgetMin) i.budgetMin = h.budgetMin; }
  const add = (k, arr, cap) => { i[k] = Array.from(new Set([...(i[k] || []), ...(arr || []).filter(Boolean)])).slice(0, cap); };
  add('areas', h.areas, 6);
  add('types', h.types, 4);
  if (!i.beds && h.beds) i.beds = h.beds;
  return i;
}

const KIND_LABEL = {
  inquiry: 'Enquiry', viewing: 'Viewing request', valuation: 'Valuation request', submission: 'Listed a property',
  saved_search: 'Saved a search', price_alert: 'Price alert', wishlist: 'Saved a listing', newsletter: 'Newsletter',
  manual: 'Added by staff', import: 'Imported'
};
// Touches that ask us something and so start the reply clock.
const REPLY_KINDS = ['inquiry', 'viewing', 'valuation', 'submission'];
// Touches that show a person actively looking right now, heaviest first.
const KIND_POINTS = { viewing: 26, valuation: 22, submission: 22, inquiry: 16, saved_search: 12, price_alert: 9, wishlist: 6, newsletter: 3, manual: 10, import: 4 };

function classifyInquiry(message, propertyTitle) {
  const m = String(message || '');
  if (/^\s*valuation request/i.test(String(propertyTitle || '')) || /valuation request/i.test(m.slice(0, 60))) return 'valuation';
  if (/^\s*\[?\s*(viewing request|schedule a viewing)/i.test(m) || /preferred (date|time)/i.test(m)) return 'viewing';
  return 'inquiry';
}

// ── SCORE ────────────────────────────────────────────────────
// Recency of their last move, how serious their touches were, what else they
// did on the site (calculators, listing pages), and whether we can reach them.
function computeScore(lead, extra) {
  const e = extra || {};
  const parts = {};
  const now = Date.now();
  if (lead.stage === 'won') return { score: 100, parts: { won: 100 } };
  if (lead.stage === 'lost') return { score: 0, parts: { lost: 0 } };
  const last = lead.lastInboundAt ? now - new Date(lead.lastInboundAt).getTime() : Infinity;
  parts.recent = last < 864e5 ? 30 : last < 3 * 864e5 ? 22 : last < 7 * 864e5 ? 15 : last < 30 * 864e5 ? 8 : last < 90 * 864e5 ? 3 : 0;
  const kinds = new Set((lead.sources || []).map(s => s.kind));
  parts.intent = Math.min(36, [...kinds].reduce((a, k) => a + (KIND_POINTS[k] || 0), 0));
  const extraTouches = Math.max(0, (lead.sources || []).length - 1);
  parts.repeat = Math.min(10, extraTouches * 4);
  parts.calculators = Math.min(12, (e.calcKinds || 0) * 3) + (e.financeCalc ? 4 : 0);
  parts.listings = Math.min(12, (e.distinctViews || 0) * 2);
  parts.reach = (lead.phones && lead.phones.length ? 8 : 0) + (lead.emails && lead.emails.length ? 2 : 0);
  const it = lead.intent || {};
  parts.ready = (it.timeline === 'now' ? 12 : it.timeline === '3m' ? 8 : it.timeline === '6m' ? 3 : 0) + (it.budgetMax ? 3 : 0) + (it.financing && it.financing !== 'unknown' ? 3 : 0);
  let total = Object.values(parts).reduce((a, b) => a + b, 0);
  if (lead.stage === 'nurture') total = Math.round(total * 0.7);
  return { score: Math.max(0, Math.min(99, Math.round(total))), parts };
}
const FINANCE_CALCS = ['affordability', 'amortization', 'closing-fees', 'cost-of-ownership', 'savings-goal', 'rent-vs-buy'];
async function engagementFor(lead) {
  const out = { calcKinds: 0, financeCalc: false, distinctViews: 0, calc: [], views: [] };
  try {
    const q = [];
    if (lead.emails && lead.emails.length) q.push({ email: { $in: lead.emails } });
    if (lead.vids && lead.vids.length) q.push({ vid: { $in: lead.vids } });
    if (q.length) {
      const rows = await CalcUsage.find({ $or: q }).sort({ createdAt: -1 }).limit(300).select('calc label createdAt').lean();
      const byCalc = {};
      rows.forEach(r => { const k = r.calc; if (!byCalc[k]) byCalc[k] = { calc: k, label: r.label || k, n: 0, last: r.createdAt }; byCalc[k].n++; });
      out.calc = Object.values(byCalc).sort((a, b) => new Date(b.last) - new Date(a.last));
      out.calcKinds = out.calc.length;
      out.financeCalc = out.calc.some(c => FINANCE_CALCS.includes(c.calc));
    }
    if (lead.vids && lead.vids.length) {
      const views = await ListingView.find({ vid: { $in: lead.vids } }).sort({ at: -1 }).limit(400).select('propertyId at').lean();
      const byP = {};
      views.forEach(v => { if (!byP[v.propertyId]) byP[v.propertyId] = { propertyId: v.propertyId, n: 0, last: v.at }; byP[v.propertyId].n++; });
      out.views = Object.values(byP).sort((a, b) => new Date(b.last) - new Date(a.last));
      out.distinctViews = out.views.length;
    }
  } catch (e) { /* scoring still works on what the lead itself holds */ }
  return out;
}
async function rescore(lead) {
  const eng = await engagementFor(lead);
  const { score, parts } = computeScore(lead, eng);
  lead.score = score;
  lead.scoreParts = parts;
  return eng;
}

// ── INGEST ───────────────────────────────────────────────────
// Everything the site collects goes through here. Finds the person by email
// first, then by mobile; creates them if new; adds the touch; re-opens a
// closed-out lead who has come back. Returns the lead, or null. Never throws.
async function ingestLead(o) {
  try {
    const email = normEmail(o.email), phone = normPhone(o.phone);
    if (!email && !phone) return null;
    const at = o.at ? new Date(o.at) : new Date();
    let lead = null;
    if (email) lead = await Lead.findOne({ emails: email });
    if (!lead && phone) lead = await Lead.findOne({ phones: phone });
    const kind = o.kind || 'inquiry';
    const src = {
      kind, refId: o.refId ? String(o.refId) : '', label: cleanText(o.label || KIND_LABEL[kind] || kind, 300),
      message: cleanText(o.message, 2000), propertyId: o.propertyId ? String(o.propertyId) : '',
      propertyTitle: cleanText(o.propertyTitle, 300), attrib: cleanAttrib(o.attrib), at
    };
    if (!lead) {
      lead = new Lead({ createdAt: at, stage: 'new', stageHistory: [{ stage: 'new', at, by: 'website' }] });
    } else if (src.refId && (lead.sources || []).some(s => s.refId === src.refId && s.kind === kind)) {
      return lead; // already recorded (backfill run twice, a double submit)
    }
    const name = cleanText(o.name, 200);
    if (name && (!lead.name || /^(website|valued|unknown)/i.test(lead.name))) lead.name = name;
    if (email && !lead.emails.includes(email)) lead.emails.push(email);
    if (phone && !lead.phones.includes(phone)) lead.phones.push(phone);
    if (o.vid && /^[a-z0-9]{8,64}$/i.test(o.vid) && !lead.vids.includes(o.vid)) lead.vids.push(o.vid);
    if (o.type && LEAD_TYPES.includes(o.type) && (lead.isNew || lead.type === 'buyer')) lead.type = o.type;
    lead.intent = mergeIntent(plainIntent(lead), o.hints);
    lead.sources.push(src);
    if (lead.sources.length > MAX_SOURCES) lead.sources = lead.sources.slice(-MAX_SOURCES);
    if (src.attrib && !lead.firstTouch) lead.firstTouch = { ...src.attrib, at };
    if (!lead.firstInboundAt || at < lead.firstInboundAt) lead.firstInboundAt = at;
    if (!lead.lastInboundAt || at > lead.lastInboundAt) lead.lastInboundAt = at;
    if (REPLY_KINDS.includes(kind) && (!lead.lastAskAt || at > lead.lastAskAt)) lead.lastAskAt = at;
    // An old enquiry marked handled was answered outside the dashboard; one
    // imported from more than 30 days ago most likely was too.
    if (o.backfill && REPLY_KINDS.includes(kind)) {
      const answered = o.handled ? (o.handledAt ? new Date(o.handledAt) : at) : (Date.now() - at.getTime() > 30 * 864e5 ? at : null);
      if (answered && (!lead.lastContactAt || answered > lead.lastContactAt)) lead.lastContactAt = answered;
    }
    if (o.consent && !lead.consent.marketing) lead.consent = { marketing: true, at, how: cleanText(o.consent, 200) };
    if (o.handled && lead.stage === 'new') { lead.stage = 'contacted'; lead.stageHistory.push({ stage: 'contacted', at, by: 'imported' }); }
    if (o.owner && !lead.ownerId) { lead.ownerId = String(o.owner.id || ''); lead.ownerName = cleanText(o.owner.name, 120); }
    // Someone we had closed out has come back to us: that is a new lead again.
    if (!o.backfill && ['lost', 'nurture'].includes(lead.stage)) {
      lead.stage = 'new';
      lead.stageHistory.push({ stage: 'new', at, by: 'came back' });
      lead.activities.push({ type: 'system', text: `Came back: ${src.label}${src.propertyTitle ? ' about ' + src.propertyTitle : ''}`, at, byName: 'Website' });
      lead.nudgedAt = null;
    }
    if (!o.backfill && lead.archived) lead.archived = false;
    await rescore(lead);
    lead.updatedAt = new Date();
    await lead.save();
    return lead;
  } catch (e) {
    console.error('Lead ingest failed:', e.message);
    return null;
  }
}

// Ties a browser id to the lead that owns this email (calculator use and
// listing views from before they gave it now count towards their score).
async function stitchLeadVid(vid, email) {
  try {
    const em = normEmail(email);
    if (!vid || !em || !/^[a-z0-9]{8,64}$/i.test(vid)) return;
    await Lead.updateOne({ emails: em }, { $addToSet: { vids: vid } });
  } catch (e) { /* not worth failing a form for */ }
}

// ── BACKFILL (once) ──────────────────────────────────────────
async function backfillLeads() {
  try {
    const flag = await Setting.findOne({ key: 'leads_backfill' }).lean();
    if (flag && flag.value && flag.value.v >= 1) return { skipped: true };
    const started = Date.now();
    let n = 0;
    const listings = new Map((await Property.find({}).select('title location listingType price monthlyRental propertyType bedrooms').lean()).map(p => [String(p._id), p]));
    const owners = new Map((await Account.find({}).select('name email').lean()).map(a => [String(a._id), a]));
    for (const i of await Inquiry.find({}).sort({ createdAt: 1 }).lean()) {
      const ow = i.assignedTo && owners.get(String(i.assignedTo));
      await ingestLead({ backfill: true, kind: classifyInquiry(i.message, i.propertyTitle), refId: i._id, at: i.createdAt, name: i.name, email: i.email, phone: i.phone,
        message: i.message, propertyId: i.propertyId, propertyTitle: i.propertyTitle, hints: hintsFromListing(listings.get(String(i.propertyId))),
        type: /^\s*valuation request/i.test(i.propertyTitle || '') ? 'seller' : undefined,
        handled: i.handled, handledAt: i.handledAt, owner: ow ? { id: ow._id, name: ow.name || ow.email } : null });
      n++;
    }
    for (const s of await PropertySubmission.find({}).sort({ createdAt: 1 }).select('submitterName submitterEmail submitterPhone submitterMessage title listingType createdAt status').lean()) {
      await ingestLead({ backfill: true, kind: 'submission', refId: s._id, at: s.createdAt, name: s.submitterName, email: s.submitterEmail, phone: s.submitterPhone,
        message: s.submitterMessage, propertyTitle: s.title, type: /LEASE/i.test(s.listingType || '') ? 'landlord' : 'seller',
        hints: { deal: /LEASE/i.test(s.listingType || '') ? 'lease_out' : 'sell' } });
      n++;
    }
    for (const s of await SavedSearch.find({ confirmed: true }).sort({ createdAt: 1 }).lean()) {
      await ingestLead({ backfill: true, kind: 'saved_search', refId: s._id, at: s.confirmedAt || s.createdAt, email: s.email, label: 'Saved a search: ' + (s.summary || ''),
        hints: hintsFromCriteria(s.criteria), vid: s.vid, consent: 'Confirmed a Property Finder email alert' });
      n++;
    }
    for (const a of await PriceAlert.find({}).sort({ createdAt: 1 }).lean()) {
      await ingestLead({ backfill: true, kind: 'price_alert', refId: a._id, at: a.createdAt, email: a.email, propertyId: a.propertyId, propertyTitle: a.propertyTitle,
        hints: hintsFromListing(listings.get(String(a.propertyId))) });
      n++;
    }
    for (const w of await Wishlist.find({}).sort({ addedAt: 1 }).lean()) {
      await ingestLead({ backfill: true, kind: 'wishlist', refId: w._id, at: w.addedAt, email: w.email, propertyId: w.propertyId, propertyTitle: w.propertyTitle,
        hints: hintsFromListing(listings.get(String(w.propertyId))) });
      n++;
    }
    for (const s of await Subscriber.find({ isActive: true }).sort({ subscribedAt: 1 }).lean()) {
      // PDF-gate addresses gave an email for a document, not for marketing.
      const quiet = ['calculator_pdf', 'calculator_print', 'guide_print'].includes(s.source);
      const lead = await ingestLead({ backfill: true, kind: 'newsletter', refId: s._id, at: s.subscribedAt, name: s.name, email: s.email, phone: s.phone,
        label: quiet ? 'Downloaded a calculator report' : 'Newsletter sign-up', consent: quiet ? '' : 'Signed up for the newsletter' });
      if (lead && s.vids && s.vids.length) await Lead.updateOne({ _id: lead._id }, { $addToSet: { vids: { $each: s.vids } } });
      n++;
    }
    await Setting.updateOne({ key: 'leads_backfill' }, { $set: { value: { v: 1, at: new Date(), records: n }, updatedAt: new Date() } }, { upsert: true });
    // Score again now that every vid is attached.
    for (const l of await Lead.find({})) { await rescore(l); await l.save(); }
    console.log(`Leads backfill: ${n} records folded into ${await Lead.countDocuments()} leads in ${Date.now() - started}ms`);
    return { records: n };
  } catch (e) {
    console.error('Leads backfill failed:', e.message);
    return { error: e.message };
  }
}

// ── SETTINGS ─────────────────────────────────────────────────
const DEFAULT_LEAD_SETTINGS = {
  notifyEmail: BROKER_INBOX,
  slaMinutes: 30,          // a new lead waiting longer than this gets a nudge
  digestHour: 8,           // morning summary, Manila time
  quietStart: 21,          // no nudges between 9 pm ...
  quietEnd: 8,             // ... and 8 am
  templates: {
    first: 'Hi {first}, this is Catherine of GLRA Realty. Thank you for your inquiry{about}. Is this a good time to talk? I can send you more photos and the full price breakdown.',
    viewing: 'Hi {first}, this is Catherine of GLRA Realty. I would be happy to arrange a viewing{about}. Which day and time work best for you this week?',
    followup: 'Hi {first}, Catherine of GLRA Realty here, just following up{about}. Are you still looking? I have a few options that may fit what you need.',
    matches: 'Hi {first}, Catherine of GLRA Realty here. I found some listings that match what you are looking for. May I send them to you?',
    seller: 'Hi {first}, this is Catherine of GLRA Realty. Thank you for thinking of us for your property{about}. When is a good time to talk about the price and the documents?'
  }
};
async function getLeadSettings() {
  const doc = await Setting.findOne({ key: 'leads' }).lean();
  const v = (doc && doc.value) || {};
  return { ...DEFAULT_LEAD_SETTINGS, ...v, templates: { ...DEFAULT_LEAD_SETTINGS.templates, ...(v.templates || {}) } };
}

// ── LISTING MATCHES ──────────────────────────────────────────
function matchListings(lead, listings, limit) {
  const it = lead.intent || {};
  const rent = it.deal === 'rent' || lead.type === 'renter';
  if (['sell', 'lease_out'].includes(it.deal) || ['seller', 'landlord'].includes(lead.type)) return [];
  const asked = new Set((lead.sources || []).map(s => s.propertyId).filter(Boolean));
  const areas = (it.areas || []).map(a => a.toLowerCase()).filter(Boolean);
  const types = (it.types || []).map(baseType);
  const out = [];
  for (const p of listings) {
    const lt = String(p.listingType || '').toUpperCase();
    if (rent ? !(lt === 'FOR LEASE' || lt === 'SALE AND LEASE') : !(lt === 'FOR SALE' || lt === 'SALE AND LEASE' || !lt)) continue;
    const price = listingPrice(p, rent);
    let score = 0; const why = [];
    if (it.budgetMax) {
      if (!price) continue;
      if (price > it.budgetMax * 1.1) continue;
      if (it.budgetMin && price < it.budgetMin * 0.7) continue;
      score += 3; why.push('in budget');
    }
    const hay = (p.location + ' ' + p.title).toLowerCase();
    if (areas.length) { if (areas.some(a => hay.includes(a))) { score += 4; why.push('area'); } else score -= 2; }
    if (types.length) { if (types.includes(baseType(p.propertyType))) { score += 2; why.push('type'); } else score -= 1; }
    if (it.beds) { if ((Number(p.bedrooms) || 0) >= it.beds) { score += 1; why.push(it.beds + '+ BR'); } else score -= 1; }
    if (score <= 0) continue;
    out.push({ _id: String(p._id), title: p.title, location: p.location, price, rent, mainImage: p.mainImage || '', score, why, asked: asked.has(String(p._id)), createdAt: p.createdAt });
  }
  return out.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit || 8);
}
let _liveCache = { at: 0, rows: null };
async function liveListings() {
  if (_liveCache.rows && Date.now() - _liveCache.at < 5 * 60e3) return _liveCache.rows;
  const rows = (await Property.find({ status: 'available' }).select('title location listingType price monthlyRental propertyType bedrooms mainImage gallery coverImage createdAt').lean()).map(applyWebsiteCover);
  _liveCache = { at: Date.now(), rows };
  return rows;
}

// Waiting for a reply: they asked us something and nobody has contacted
// them since. Any stage: a client in the middle of a viewing who sends a new
// question is waiting too.
function isWaiting(l) {
  if (!l.lastAskAt || l.archived || ['won', 'lost'].includes(l.stage)) return false;
  return !l.lastContactAt || new Date(l.lastContactAt) < new Date(l.lastAskAt);
}
// ── HELPERS FOR THE ROUTES ───────────────────────────────────
const CONTACT_TYPES = ['call', 'whatsapp', 'viber', 'sms', 'email', 'meeting', 'viewing', 'listings_sent'];
function pushActivity(lead, a) {
  lead.activities.push(a);
  if (lead.activities.length > MAX_ACTIVITIES) lead.activities = lead.activities.slice(-MAX_ACTIVITIES);
  if (CONTACT_TYPES.includes(a.type)) {
    const at = a.at || new Date();
    lead.lastContactAt = at;
    if (!lead.firstResponseAt) lead.firstResponseAt = at;
    if (lead.stage === 'new') { lead.stage = 'contacted'; lead.stageHistory.push({ stage: 'contacted', at, by: a.byName || a.by || '' }); }
    lead.nudgedAt = lead.nudgedAt || at; // no "still waiting" alert once someone has replied
  }
}
function listRow(l) {
  const src = (l.sources || [])[l.sources.length - 1] || {};
  return {
    _id: String(l._id), name: l.name, emails: l.emails, phones: l.phones, type: l.type, stage: l.stage, score: l.score,
    ownerId: l.ownerId, ownerName: l.ownerName, tags: l.tags, consent: !!(l.consent && l.consent.marketing),
    intent: l.intent, touches: (l.sources || []).length, lastKind: src.kind || '', lastLabel: src.label || '', lastProperty: src.propertyTitle || '',
    waiting: isWaiting(l), lastMessage: (src.message || '').slice(0, 160), firstSource: ((l.sources || [])[0] || {}).kind || '',
    firstTouch: l.firstTouch || null, createdAt: l.createdAt, lastInboundAt: l.lastInboundAt, lastAskAt: l.lastAskAt, firstInboundAt: l.firstInboundAt,
    firstResponseAt: l.firstResponseAt, lastContactAt: l.lastContactAt, nextFollowUp: l.nextFollowUp, followUpNote: l.followUpNote, archived: !!l.archived
  };
}
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function leadStats(leads) {
  const now = Date.now(), d30 = now - 30 * 864e5;
  const todayEnd = new Date(manilaDayKey() + 'T23:59:59+08:00').getTime();
  const open = leads.filter(l => !['won', 'lost'].includes(l.stage) && !l.archived);
  const resp = leads.filter(l => l.firstResponseAt && l.firstInboundAt && new Date(l.firstInboundAt).getTime() > d30)
    .map(l => (new Date(l.firstResponseAt) - new Date(l.firstInboundAt)) / 60000).filter(m => m >= 0);
  const bySource = {}, byStage = {}, byChannel = {};
  leads.filter(l => new Date(l.createdAt).getTime() > now - 90 * 864e5).forEach(l => {
    const k = ((l.sources || [])[0] || {}).kind || 'manual';
    bySource[k] = (bySource[k] || 0) + 1;
    const ch = l.firstTouch && (l.firstTouch.src || l.firstTouch.ref) || 'direct / unknown';
    byChannel[ch] = (byChannel[ch] || 0) + 1;
  });
  leads.forEach(l => { byStage[l.stage] = (byStage[l.stage] || 0) + 1; });
  const monthKey = manilaDayKey().slice(0, 7);
  return {
    total: leads.length,
    open: open.length,
    waiting: open.filter(isWaiting).length,
    hot: open.filter(l => l.score >= 70).length,
    due: open.filter(l => l.nextFollowUp && new Date(l.nextFollowUp).getTime() <= todayEnd).length,
    overdue: open.filter(l => l.nextFollowUp && new Date(l.nextFollowUp).getTime() < now).length,
    new30: leads.filter(l => new Date(l.createdAt).getTime() > d30).length,
    wonMonth: leads.filter(l => l.stage === 'won' && (l.stageHistory || []).some(h => h.stage === 'won' && manilaDayKey(h.at).slice(0, 7) === monthKey)).length,
    medianResponseMin: resp.length ? Math.round(median(resp)) : null,
    within5: resp.length ? Math.round(100 * resp.filter(m => m <= 5).length / resp.length) : null,
    bySource, byStage, byChannel
  };
}

// ── EMAILS ───────────────────────────────────────────────────
function peso(n) { n = Number(n) || 0; return '₱' + n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function listingsEmail(lead, props, note, esc, senderName) {
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const cards = props.map(p => {
    const rent = isLeaseListing(p) || (String(p.listingType || '').toUpperCase() === 'SALE AND LEASE' && lead.intent && lead.intent.deal === 'rent');
    const price = listingPrice(p, rent);
    const img = /^https:\/\/res\.cloudinary\.com\//.test(p.mainImage || '') ? p.mainImage.replace('/upload/', '/upload/c_fill,w_560,h_320,q_auto,f_jpg/') : '';
    return `<tr><td style="padding:0 0 18px 0">
      <a href="${SITE_URL}/property/${String(p._id)}" style="text-decoration:none;color:#0a0a0a;display:block;border:2px solid #0a0a0a">
        ${img ? `<img src="${esc(img)}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0">` : ''}
        <div style="padding:12px 14px;font-family:Inter,Helvetica,Arial,sans-serif">
          <div style="font-size:18px;font-weight:800">${price ? esc(peso(price)) + (rent ? ' / month' : '') : 'Price on request'}</div>
          <div style="font-size:14px;font-weight:600;margin-top:2px">${esc(p.title)}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${esc(p.location || '')}</div>
          <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-top:8px;color:#c02e00">View this listing &rarr;</div>
        </div></a></td></tr>`;
  }).join('');
  return getEmailHeader() + `
    <h2 style="color:#0a0a0a;font-family:Inter,Helvetica,Arial,sans-serif;font-size:22px;margin:0 0 8px 0">Hi ${esc(first)},</h2>
    <p style="color:#0a0a0a;line-height:1.6;font-size:14px">${note ? esc(note).replace(/\n/g, '<br>') : 'Here are some listings that match what you told us you are looking for.'}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:18px 0">${cards}</table>
    <p style="color:#0a0a0a;line-height:1.6;font-size:14px">Just reply to this email, or message us on WhatsApp at +63 917 177 4572, and I will arrange a viewing.</p>
    <p style="color:#0a0a0a;line-height:1.6;font-size:14px;margin-top:22px">${esc(senderName || 'Catherine')}<br><strong>GLRA Realty</strong></p>
    <p style="color:#777;font-size:11px;line-height:1.5;margin-top:22px">You are receiving this because you contacted GLRA Realty about a property. If you would rather not get listings from us, reply "stop" and we will not send any more.</p>
  ` + getEmailFooter();
}

// ── ROUTES ───────────────────────────────────────────────────
function registerLeadRoutes(app, { sendEmail, esc, handleValidation }) {
  const view = [verifyToken, requirePermission('leads_view')];
  const manage = [verifyToken, requirePermission('leads_manage')];
  const del = [verifyToken, requirePermission('leads_delete')];
  const who = req => ({ by: req.user && req.user.email || '', byName: req.user && (req.user.name || req.user.email) || '' });

  app.get('/api/admin/leads', ...view, async (req, res) => {
    try {
      const leads = await Lead.find({}).select('-activities -vids -scoreParts').sort({ lastInboundAt: -1 }).limit(5000).lean();
      res.json({ leads: leads.map(listRow), stats: leadStats(leads), stages: LEAD_STAGES, types: LEAD_TYPES });
    } catch (e) { res.status(500).json({ error: 'Could not load leads' }); }
  });

  app.get('/api/admin/leads/:id', ...view, async (req, res) => {
    try {
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      const eng = await engagementFor(lead);
      const live = await liveListings();
      const byId = new Map(live.map(p => [String(p._id), p]));
      const views = eng.views.slice(0, 20).map(v => ({ ...v, title: (byId.get(v.propertyId) || {}).title || '(no longer listed)', live: byId.has(v.propertyId) }));
      const matches = matchListings(lead.toObject(), live, 10);
      // Possible duplicates: same name with a different email/phone.
      let dupes = [];
      if (lead.name && lead.name.length >= 4) {
        const rx = new RegExp('^' + lead.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
        dupes = (await Lead.find({ _id: { $ne: lead._id }, name: rx }).select('name emails phones stage createdAt').limit(5).lean()).map(d => ({ ...d, _id: String(d._id) }));
      }
      const o = lead.toObject();
      o._id = String(o._id);
      delete o.vids;
      res.json({ lead: o, calc: eng.calc, views, matches, dupes });
    } catch (e) { res.status(500).json({ error: 'Could not load this lead' }); }
  });

  app.post('/api/admin/leads', ...manage, async (req, res) => {
    try {
      const b = req.body || {};
      if (!normEmail(b.email) && !normPhone(b.phone)) return res.status(400).json({ error: 'Give at least an email address or a mobile number.' });
      const existing = await Lead.findOne({ $or: [normEmail(b.email) ? { emails: normEmail(b.email) } : null, normPhone(b.phone) ? { phones: normPhone(b.phone) } : null].filter(Boolean) }).select('_id name').lean();
      const lead = await ingestLead({
        kind: 'manual', name: b.name, email: b.email, phone: b.phone, label: cleanText(b.source ? 'Added by staff: ' + b.source : 'Added by staff', 300),
        message: b.notes, type: LEAD_TYPES.includes(b.type) ? b.type : undefined, consent: b.consent ? cleanText(b.consentHow || 'Recorded by staff', 200) : ''
      });
      if (!lead) return res.status(500).json({ error: 'Could not save this lead' });
      if (!existing) {
        const who2 = who(req);
        lead.activities.push({ type: 'system', text: `Added by ${who2.byName}${b.source ? ' (' + cleanText(b.source, 100) + ')' : ''}`, at: new Date(), ...who2 });
        await lead.save();
      }
      await logAudit(req, existing ? 'UPDATE' : 'CREATE', 'Lead', String(lead._id), lead.name, null);
      res.json({ success: true, id: String(lead._id), merged: !!existing });
    } catch (e) { res.status(500).json({ error: 'Could not save this lead' }); }
  });

  app.patch('/api/admin/leads/:id', ...manage, async (req, res) => {
    try {
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      const b = req.body || {};
      const w = who(req);
      if (b.name !== undefined) lead.name = cleanText(b.name, 200);
      if (b.type !== undefined && LEAD_TYPES.includes(b.type)) lead.type = b.type;
      if (Array.isArray(b.emails)) lead.emails = Array.from(new Set(b.emails.map(normEmail).filter(Boolean))).slice(0, 5);
      if (Array.isArray(b.phones)) lead.phones = Array.from(new Set(b.phones.map(normPhone).filter(Boolean))).slice(0, 5);
      if (!lead.emails.length && !lead.phones.length) return res.status(400).json({ error: 'A lead needs an email address or a mobile number.' });
      if (b.intent && typeof b.intent === 'object') {
        const i = b.intent, cur = lead.intent || {};
        lead.intent = {
          deal: ['', 'buy', 'rent', 'sell', 'lease_out'].includes(i.deal) ? i.deal : cur.deal,
          budgetMin: Math.max(0, Number(i.budgetMin) || 0), budgetMax: Math.max(0, Number(i.budgetMax) || 0),
          areas: Array.isArray(i.areas) ? i.areas.map(a => cleanText(a, 40)).filter(Boolean).slice(0, 8) : cur.areas,
          types: Array.isArray(i.types) ? i.types.map(a => cleanText(a, 40)).filter(Boolean).slice(0, 6) : cur.types,
          beds: Math.max(0, Math.min(10, Number(i.beds) || 0)),
          timeline: ['', 'now', '3m', '6m', '12m', 'browsing'].includes(i.timeline) ? i.timeline : cur.timeline,
          financing: ['', 'cash', 'bank', 'pagibig', 'inhouse', 'unknown'].includes(i.financing) ? i.financing : cur.financing,
          notes: cleanText(i.notes, 2000)
        };
      }
      if (Array.isArray(b.tags)) lead.tags = Array.from(new Set(b.tags.map(t => cleanText(t, 30).toLowerCase()).filter(Boolean))).slice(0, 12);
      if (b.nextFollowUp !== undefined) {
        const d = b.nextFollowUp ? new Date(b.nextFollowUp) : null;
        lead.nextFollowUp = d && !isNaN(d) ? d : null;
        lead.followUpNote = cleanText(b.followUpNote, 300);
        if (lead.nextFollowUp) lead.activities.push({ type: 'system', text: `Follow-up set for ${lead.nextFollowUp.toISOString()}${lead.followUpNote ? ': ' + lead.followUpNote : ''}`, at: new Date(), ...w });
      }
      if (b.consent !== undefined) {
        const on = !!b.consent;
        if (on !== !!(lead.consent && lead.consent.marketing)) {
          lead.consent = on ? { marketing: true, at: new Date(), how: cleanText(b.consentHow || 'Recorded by ' + w.byName, 200) } : { marketing: false, at: new Date(), how: 'Withdrawn, recorded by ' + w.byName };
          lead.activities.push({ type: 'system', text: on ? `Marketing consent recorded: ${lead.consent.how}` : 'Marketing consent withdrawn', at: new Date(), ...w });
        }
      }
      if (b.archived !== undefined) lead.archived = !!b.archived;
      await rescore(lead);
      lead.updatedAt = new Date();
      await lead.save();
      res.json({ success: true, lead: listRow(lead.toObject()) });
    } catch (e) { res.status(500).json({ error: 'Could not update this lead' }); }
  });

  app.post('/api/admin/leads/:id/stage', ...manage, async (req, res) => {
    try {
      const stage = String((req.body || {}).stage || '');
      if (!LEAD_STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (lead.stage !== stage) {
        const w = who(req), at = new Date();
        lead.stageHistory.push({ stage, at, by: w.byName });
        lead.activities.push({ type: 'stage', text: `Stage: ${lead.stage} → ${stage}${stage === 'lost' && req.body.lostReason ? ' (' + cleanText(req.body.lostReason, 200) + ')' : ''}`, at, ...w });
        if (stage === 'lost') lead.lostReason = cleanText(req.body.lostReason, 300);
        if (['won', 'lost'].includes(stage)) lead.nextFollowUp = null;
        lead.stage = stage;
        await rescore(lead);
        lead.updatedAt = at;
        await lead.save();
      }
      res.json({ success: true, lead: listRow(lead.toObject()) });
    } catch (e) { res.status(500).json({ error: 'Could not change the stage' }); }
  });

  app.post('/api/admin/leads/:id/activity', ...manage, async (req, res) => {
    try {
      const b = req.body || {};
      const type = ['note', 'call', 'whatsapp', 'viber', 'sms', 'email', 'meeting', 'viewing'].includes(b.type) ? b.type : 'note';
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      const w = who(req);
      pushActivity(lead, { type, outcome: cleanText(b.outcome, 60), text: cleanText(b.text, 3000), at: new Date(), ...w });
      if (b.followUp) {
        const d = new Date(b.followUp);
        if (!isNaN(d)) { lead.nextFollowUp = d; lead.followUpNote = cleanText(b.followUpNote, 300); }
      } else if (b.clearFollowUp) { lead.nextFollowUp = null; lead.followUpNote = ''; }
      if (b.stage && LEAD_STAGES.includes(b.stage) && b.stage !== lead.stage) {
        lead.stageHistory.push({ stage: b.stage, at: new Date(), by: w.byName });
        lead.stage = b.stage;
      }
      await rescore(lead);
      lead.updatedAt = new Date();
      await lead.save();
      res.json({ success: true, lead: listRow(lead.toObject()) });
    } catch (e) { res.status(500).json({ error: 'Could not log this' }); }
  });

  // Assign to a staff member, or to a field agent (who then gets it in their
  // own Lead Journal, exactly like an enquiry assigned from the Inquiries tab).
  app.post('/api/admin/leads/:id/assign', ...manage, async (req, res) => {
    try {
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      const w = who(req);
      const accId = String((req.body || {}).accountId || '');
      if (!accId) {
        lead.activities.push({ type: 'assign', text: `Unassigned (was ${lead.ownerName || 'nobody'})`, at: new Date(), ...w });
        lead.ownerId = ''; lead.ownerName = '';
        await lead.save();
        return res.json({ success: true, lead: listRow(lead.toObject()) });
      }
      const acc = await Account.findOne({ _id: accId, isActive: { $ne: false }, status: { $ne: 'pending' } }).select('name email role').lean();
      if (!acc) return res.status(400).json({ error: 'That account is not active.' });
      lead.ownerId = String(acc._id); lead.ownerName = acc.name || acc.email;
      lead.activities.push({ type: 'assign', text: `Assigned to ${lead.ownerName}`, at: new Date(), ...w });
      await lead.save();
      const last = (lead.sources || [])[lead.sources.length - 1] || {};
      if (acc.role === 'agent') {
        const al = await AgentLead.create({
          account: acc._id, name: lead.name || 'Website lead', contactNo: lead.phones[0] ? '+' + lead.phones[0] : '', email: lead.emails[0] || '',
          category: { seller: 'Owner', landlord: 'Owner', renter: 'Tenant', broker: 'Broker' }[lead.type] || 'Buyer',
          propertyInterest: last.propertyTitle || '', source: 'Website', actionToTake: 'Reply within the hour', stage: 'Inquiry',
          stageHistory: [{ stage: 'Inquiry', at: new Date() }], nextFollowUp: new Date(manilaDayKey()),
          remarks: (last.message || '').slice(0, 900), assignedFrom: { leadId: String(lead._id), by: w.by, at: new Date() }
        });
        AgentNotification.create({ account: acc._id, dedupeKey: `lead:${lead._id}:${al._id}`, type: 'lead', message: `New lead assigned to you: ${al.name}${al.propertyInterest ? ' — ' + al.propertyInterest : ''}`, leadId: String(al._id) }).catch(() => {});
      }
      if (acc.email && acc.email !== w.by) {
        sendEmail(acc.email, `Lead assigned to you: ${lead.name || 'website lead'}`, getEmailHeader() + `
          <h2 style="color:#0a0a0a;font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px">${esc(w.byName)} assigned you a lead</h2>
          <p style="font-size:14px;line-height:1.7"><strong>${esc(lead.name || 'Website lead')}</strong><br>${esc(lead.phones[0] ? '+' + lead.phones[0] : '')} ${esc(lead.emails[0] || '')}</p>
          ${last.propertyTitle ? `<p style="font-size:14px">About: ${esc(last.propertyTitle)}</p>` : ''}
          ${last.message ? `<p style="background:#f6f4ef;padding:12px 16px;font-size:14px">“${esc(last.message.slice(0, 600))}”</p>` : ''}
          <p><strong>Reply within the hour.</strong> People who hear back in the first five minutes are far more likely to become clients.</p>
          <p><a href="${SITE_URL}/${acc.role === 'agent' ? 'agent.html' : 'admin.html'}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:12px 22px;text-decoration:none;font-weight:600">Open it</a></p>
        ` + getEmailFooter()).catch(() => {});
      }
      await logAudit(req, 'ASSIGN_LEAD', 'Lead', String(lead._id), lead.name, { to: acc.email });
      res.json({ success: true, lead: listRow(lead.toObject()) });
    } catch (e) { res.status(500).json({ error: 'Could not assign this lead' }); }
  });

  app.post('/api/admin/leads/:id/send-listings', ...manage, async (req, res) => {
    try {
      const b = req.body || {};
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      const to = lead.emails[0];
      if (!to) return res.status(400).json({ error: 'This lead has no email address.' });
      // Replying about homes to someone who asked us for homes is answering
      // their request. Anyone else needs a recorded marketing consent first.
      const asked = (lead.sources || []).some(s => ['inquiry', 'viewing', 'saved_search', 'price_alert', 'wishlist'].includes(s.kind));
      if (!asked && !(lead.consent && lead.consent.marketing)) return res.status(400).json({ error: 'This person has not asked us about a property and has not agreed to receive listings. Record their consent first.' });
      const ids = (Array.isArray(b.propertyIds) ? b.propertyIds : []).map(String).filter(x => /^[a-f0-9]{24}$/i.test(x)).slice(0, 8);
      if (!ids.length) return res.status(400).json({ error: 'Pick at least one listing.' });
      const props = (await Property.find({ _id: { $in: ids }, status: 'available' }).select('title location listingType price monthlyRental mainImage gallery coverImage').lean()).map(applyWebsiteCover);
      if (!props.length) return res.status(400).json({ error: 'Those listings are no longer live.' });
      const w = who(req);
      const html = listingsEmail(lead.toObject(), props, cleanText(b.note, 1500), esc, cleanText(b.senderName, 80) || 'Catherine');
      const r = await sendEmail(to, cleanText(b.subject, 140) || `${props.length === 1 ? 'A listing' : props.length + ' listings'} picked for you - GLRA Realty`, html, 'GLRA Realty', { email: BROKER_INBOX, name: 'GLRA Realty' });
      if (!r || !r.success) return res.status(502).json({ error: 'The email could not be sent. Try again in a minute.' });
      pushActivity(lead, { type: 'listings_sent', text: `Emailed ${props.length} listing${props.length === 1 ? '' : 's'}: ${props.map(p => p.title).join('; ').slice(0, 900)}`, at: new Date(), ...w });
      lead.updatedAt = new Date();
      await lead.save();
      res.json({ success: true, sent: props.length, lead: listRow(lead.toObject()) });
    } catch (e) { res.status(500).json({ error: 'Could not send the listings' }); }
  });

  app.post('/api/admin/leads/merge', ...del, async (req, res) => {
    try {
      const { keepId, mergeId } = req.body || {};
      if (!keepId || !mergeId || String(keepId) === String(mergeId)) return res.status(400).json({ error: 'Pick two different leads.' });
      const [keep, drop] = await Promise.all([Lead.findById(keepId), Lead.findById(mergeId)]);
      if (!keep || !drop) return res.status(404).json({ error: 'Lead not found' });
      keep.emails = Array.from(new Set([...keep.emails, ...drop.emails])).slice(0, 5);
      keep.phones = Array.from(new Set([...keep.phones, ...drop.phones])).slice(0, 5);
      keep.vids = Array.from(new Set([...keep.vids, ...drop.vids])).slice(0, 50);
      keep.sources = [...keep.sources, ...drop.sources].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-MAX_SOURCES);
      keep.activities = [...keep.activities, ...drop.activities].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-MAX_ACTIVITIES);
      keep.tags = Array.from(new Set([...(keep.tags || []), ...(drop.tags || [])])).slice(0, 12);
      keep.intent = mergeIntent(plainIntent(keep), plainIntent(drop));
      if (!keep.name && drop.name) keep.name = drop.name;
      if (!(keep.consent && keep.consent.marketing) && drop.consent && drop.consent.marketing) keep.consent = drop.consent;
      if (drop.firstInboundAt && (!keep.firstInboundAt || drop.firstInboundAt < keep.firstInboundAt)) keep.firstInboundAt = drop.firstInboundAt;
      if (drop.lastInboundAt && (!keep.lastInboundAt || drop.lastInboundAt > keep.lastInboundAt)) keep.lastInboundAt = drop.lastInboundAt;
      if (drop.lastAskAt && (!keep.lastAskAt || drop.lastAskAt > keep.lastAskAt)) keep.lastAskAt = drop.lastAskAt;
      if (drop.lastContactAt && (!keep.lastContactAt || drop.lastContactAt > keep.lastContactAt)) keep.lastContactAt = drop.lastContactAt;
      if (!keep.firstTouch && drop.firstTouch) keep.firstTouch = drop.firstTouch;
      if (drop.createdAt < keep.createdAt) keep.createdAt = drop.createdAt;
      const w = who(req);
      keep.activities.push({ type: 'system', text: `Merged with the duplicate record "${drop.name || drop.emails[0] || drop.phones[0]}"`, at: new Date(), ...w });
      await rescore(keep);
      await keep.save();
      await Lead.deleteOne({ _id: drop._id });
      await logAudit(req, 'MERGE_LEAD', 'Lead', String(keep._id), keep.name, { merged: String(drop._id) });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Could not merge these leads' }); }
  });

  app.delete('/api/admin/leads/:id', ...del, async (req, res) => {
    try {
      const lead = await Lead.findByIdAndDelete(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      await logAudit(req, 'DELETE', 'Lead', String(lead._id), lead.name, null);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Could not delete this lead' }); }
  });

  // CSV import from sources the office already holds consent for: Facebook
  // lead-ad downloads, a portal's enquiry export, an open-house sign-in sheet.
  app.post('/api/admin/leads/import', ...manage, async (req, res) => {
    try {
      const b = req.body || {};
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : [];
      if (!rows.length) return res.status(400).json({ error: 'No rows to import.' });
      if (!b.lawfulSource) return res.status(400).json({ error: 'Confirm where these contacts came from first.' });
      const how = cleanText(b.sourceLabel || 'Imported list', 120);
      let added = 0, updated = 0, skipped = 0;
      for (const r of rows) {
        const email = normEmail(r.email), phone = normPhone(r.phone);
        if (!email && !phone) { skipped++; continue; }
        const existed = await Lead.exists({ $or: [email ? { emails: email } : null, phone ? { phones: phone } : null].filter(Boolean) });
        const lead = await ingestLead({
          kind: 'import', name: r.name, email, phone, label: 'Imported: ' + how, message: cleanText(r.notes || r.message, 1000),
          type: LEAD_TYPES.includes(String(r.type || '').toLowerCase()) ? String(r.type).toLowerCase() : undefined,
          consent: /^(y|yes|true|1|oo)$/i.test(String(r.consent || '').trim()) ? 'Consent given via ' + how : ''
        });
        if (!lead) { skipped++; continue; }
        if (existed) updated++; else added++;
      }
      await logAudit(req, 'IMPORT', 'Lead', '', `${added} added, ${updated} updated`, { source: how });
      res.json({ success: true, added, updated, skipped });
    } catch (e) { res.status(500).json({ error: 'Import failed' }); }
  });

  app.get('/api/admin/leads-settings', ...view, async (req, res) => {
    try {
      const s = await getLeadSettings();
      const staff = await Account.find({ isActive: { $ne: false }, status: { $ne: 'pending' } }).select('name email role').sort({ name: 1 }).lean();
      res.json({ settings: s, staff: staff.map(a => ({ _id: String(a._id), name: a.name || a.email, role: a.role })) });
    } catch (e) { res.status(500).json({ error: 'Could not load settings' }); }
  });
  app.put('/api/admin/leads-settings', ...manage, async (req, res) => {
    try {
      const b = req.body || {}, cur = await getLeadSettings();
      const t = b.templates && typeof b.templates === 'object' ? b.templates : {};
      const next = {
        notifyEmail: normEmail(b.notifyEmail) || cur.notifyEmail,
        slaMinutes: Math.max(5, Math.min(1440, Number(b.slaMinutes) || cur.slaMinutes)),
        digestHour: Math.max(5, Math.min(12, Number(b.digestHour) || cur.digestHour)),
        quietStart: cur.quietStart, quietEnd: cur.quietEnd,
        templates: Object.fromEntries(Object.keys(DEFAULT_LEAD_SETTINGS.templates).map(k => [k, cleanText(t[k] != null ? t[k] : cur.templates[k], 700) || DEFAULT_LEAD_SETTINGS.templates[k]]))
      };
      await Setting.updateOne({ key: 'leads' }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
      res.json({ success: true, settings: next });
    } catch (e) { res.status(500).json({ error: 'Could not save settings' }); }
  });
}

// ── THE TICK: nudges and the morning digest ──────────────────
function startLeadsTick({ sendEmail, esc }) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const s = await getLeadSettings();
      const hour = manilaHour();
      const quiet = hour >= s.quietStart || hour < s.quietEnd;
      const now = Date.now();
      // 1. A new lead nobody has answered yet, past the target time.
      if (!quiet) {
        const cutoff = new Date(now - s.slaMinutes * 60e3);
        const waiting = await Lead.find({ stage: { $nin: ['won', 'lost'] }, nudgedAt: null, archived: { $ne: true }, lastAskAt: { $lte: cutoff, $gte: new Date(now - 3 * 864e5) },
          $expr: { $or: [{ $eq: [{ $ifNull: ['$lastContactAt', null] }, null] }, { $lt: ['$lastContactAt', '$lastAskAt'] }] } }).limit(20);
        for (const l of waiting) {
          const src = (l.sources || [])[l.sources.length - 1] || {};
          const mins = Math.round((now - new Date(l.lastAskAt).getTime()) / 60e3);
          const r = await sendEmail(s.notifyEmail, `Still waiting for a reply: ${l.name || 'website lead'} (${mins} min)`, getEmailHeader() + `
            <h2 style="color:#c02e00;font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 8px">${esc(l.name || 'A website lead')} has waited ${mins} minutes</h2>
            <p style="font-size:14px;line-height:1.6">${esc(src.label || 'Enquiry')}${src.propertyTitle ? ' about <strong>' + esc(src.propertyTitle) + '</strong>' : ''}.</p>
            ${src.message ? `<p style="background:#f6f4ef;padding:12px 16px;font-size:14px">“${esc(src.message.slice(0, 500))}”</p>` : ''}
            <p style="font-size:14px">${l.phones[0] ? `<a href="https://wa.me/${esc(l.phones[0])}">WhatsApp +${esc(l.phones[0])}</a> &middot; ` : ''}${l.emails[0] ? esc(l.emails[0]) : ''}</p>
            <p style="font-size:13px;color:#555">Leads answered in the first few minutes are many times more likely to become clients. Log the reply in the Leads tab and this reminder stops.</p>
            <p><a href="${SITE_URL}/admin.html#leads" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;text-decoration:none;font-weight:600">Open the lead</a></p>
          ` + getEmailFooter()).catch(() => null);
          l.nudgedAt = new Date();
          if (!(r && r.success)) l.activities.push({ type: 'system', text: 'Reply reminder could not be emailed', at: new Date(), byName: 'Lead reminders' });
          await l.save();
        }
      }
      // 2. The morning digest, once a day.
      const today = manilaDayKey();
      if (hour >= s.digestHour && hour < 12) {
        const flag = await Setting.findOneAndUpdate({ key: 'leads_digest', 'value.day': { $ne: today } }, { $set: { value: { day: today }, updatedAt: new Date() } }, { upsert: false, new: true });
        let first = false;
        if (flag) first = true;
        else if (!(await Setting.exists({ key: 'leads_digest' }))) { await Setting.create({ key: 'leads_digest', value: { day: today } }); first = true; }
        if (first) {
          const all = await Lead.find({ archived: { $ne: true } }).select('-activities -vids').lean();
          const open = all.filter(l => !['won', 'lost'].includes(l.stage));
          const day = 864e5;
          const fresh = all.filter(l => l.lastInboundAt && now - new Date(l.lastInboundAt).getTime() < day);
          const waiting = open.filter(isWaiting);
          const endToday = new Date(today + 'T23:59:59+08:00').getTime();
          const due = open.filter(l => l.nextFollowUp && new Date(l.nextFollowUp).getTime() <= endToday);
          const hot = open.filter(l => l.score >= 70 && !due.includes(l) && !waiting.includes(l)).sort((a, b) => b.score - a.score).slice(0, 8);
          const cold = open.filter(l => l.stage !== 'new' && (!l.lastContactAt || now - new Date(l.lastContactAt).getTime() > 21 * day) && !l.nextFollowUp).slice(0, 8);
          if (fresh.length || waiting.length || due.length || hot.length) {
            const row = l => { const src = (l.sources || [])[l.sources.length - 1] || {}; return `<tr><td style="padding:7px 0;border-bottom:1px solid #e8e8e0"><strong>${esc(l.name || l.emails[0] || '+' + l.phones[0])}</strong> <span style="color:#777;font-size:12px">score ${l.score}</span><br><span style="font-size:12px;color:#555">${esc(src.label || '')}${src.propertyTitle ? ' · ' + esc(src.propertyTitle) : ''}${l.followUpNote ? ' · ' + esc(l.followUpNote) : ''}</span></td></tr>`; };
            const block = (t, arr) => arr.length ? `<h3 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:15px;margin:18px 0 4px">${t} (${arr.length})</h3><table style="width:100%;border-collapse:collapse">${arr.slice(0, 12).map(row).join('')}</table>` : '';
            await sendEmail(s.notifyEmail, `Leads today: ${waiting.length} waiting, ${due.length} follow-ups, ${fresh.length} new`, getEmailHeader() + `
              <h2 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 6px">Good morning. Here are today's leads.</h2>
              ${block('Nobody has replied yet', waiting)}
              ${block('Follow-ups due today', due)}
              ${block('New in the last 24 hours', fresh.filter(l => !waiting.includes(l)))}
              ${block('Hottest leads', hot)}
              ${block('Going cold: no contact in three weeks', cold)}
              <p style="margin-top:22px"><a href="${SITE_URL}/admin.html#leads" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;text-decoration:none;font-weight:600">Open the Leads tab</a></p>
            ` + getEmailFooter()).catch(() => {});
          }
        }
      }
      // 3. Scores fade as time passes: refresh anything touched in the last 90 days.
      const stale = await Lead.find({ updatedAt: { $lt: new Date(now - 864e5) }, lastInboundAt: { $gt: new Date(now - 100 * 864e5) } }).limit(60);
      for (const l of stale) { await rescore(l); l.updatedAt = new Date(); await l.save(); }
    } catch (e) {
      console.error('Leads tick error:', e.message);
    } finally { running = false; }
  }
  setTimeout(() => {
    backfillLeads().then(() => tick()).catch(() => {});
    setInterval(tick, 10 * 60e3).unref();
  }, 90 * 1000).unref();
  return { tick };
}

module.exports = {
  registerLeadRoutes, startLeadsTick, ingestLead, backfillLeads, stitchLeadVid, classifyInquiry, hintsFromListing, hintsFromCriteria,
  _test: { normEmail, normPhone, computeScore, matchListings, mergeIntent, baseType, areaOf, leadStats, isWaiting }
};
