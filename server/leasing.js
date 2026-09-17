// =============================================================================
// LEASING — rent roll, tenant ledger, reminders, statements
// =============================================================================
// The server side of the admin "Leasing" tab. One Lease document carries the
// whole life of a rental (see leaseSchema in ./db.js). Nothing about money is
// stored as a running total: the rent schedule, what has been paid against it,
// the balance and the overdue list are all recomputed from the terms plus the
// payment list on every read (computeLease). Correct a payment and every
// figure downstream corrects itself.
//
// What lives here:
//   * pure money math (schedule / FIFO allocation / summary) — exported under
//     _test so it can be verified without a database
//   * the /api/admin/leases* routes (permission-gated: leasing_view / _manage)
//   * tenant + owner emails, with PDF statements and receipts attached
//   * the reminder engine (startLeasingTick): rent-due reminders, overdue
//     notices, lease-expiry alerts and a daily digest for the broker
//   * a secret ICS calendar feed so due dates land on the broker's phone
//
// Registered from server.js:
//   const { registerLeasingRoutes, startLeasingTick } = require('./server/leasing');
//   registerLeasingRoutes(app, { sendEmail, esc, uploadAttachment, cloudinary });
//   startLeasingTick({ sendEmail, esc });
// =============================================================================
const crypto = require('crypto');
const fs = require('fs');
const { Lease, Setting, Counter, Property, Inquiry, LEASE_STAGES } = require('./db');
const { verifyToken, requireAdmin, requirePermission, logAudit } = require('./auth');
const { getEmailHeader, getEmailFooter } = require('./email-templates');
const pdf = require('./lease-pdf');

const SITE_URL = 'https://glrarealty.com';
const BROKER_INBOX = 'glrarealty@gmail.com';

// ── STAGES ───────────────────────────────────────────────────
// The kanban columns. Order matters: the "Next" button walks LEASE_FLOW.
const STAGE_META = {
  prospect:    { label: 'Prospect',    color: '#64748b' },
  viewing:     { label: 'Viewing',     color: '#3b82f6' },
  application: { label: 'Application', color: '#8b5cf6' },
  contract:    { label: 'Contract',    color: '#f59e0b' },
  active:      { label: 'Active',      color: '#10b981' },
  renewal:     { label: 'Renewal',     color: '#d97706' },
  ended:       { label: 'Ended',       color: '#475569' },
  on_hold:     { label: 'On hold',     color: '#ef4444' }
};
const LEASE_FLOW = ['prospect', 'viewing', 'application', 'contract', 'active', 'renewal', 'ended'];
const LIVE_STAGES = ['active', 'renewal'];   // rent is being collected

// ── DATE HELPERS ─────────────────────────────────────────────
// Every date in a lease is a calendar day, never a moment. They are stored as
// UTC midnight (what `new Date('2026-09-15')` gives) and handled here as
// 'YYYY-MM-DD' keys, so a server in UTC and a browser in Manila agree.
const pad2 = n => String(n).padStart(2, '0');
function dk(d) {
  if (!d) return '';
  if (typeof d === 'string') return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : dk(new Date(d));
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return '';
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
}
function parts(key) { const [y, m, d] = key.split('-').map(Number); return { y, m, d }; }
function fromParts(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }   // m is 1-based
function addDays(key, n) {
  const { y, m, d } = parts(key);
  return dk(new Date(Date.UTC(y, m - 1, d + n)));
}
// Same day-of-month N months later, clamped to the shorter month (Jan 31 + 1 → Feb 28).
function addMonths(key, n) {
  const { y, m, d } = parts(key);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return fromParts(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}
function diffDays(a, b) {   // b - a in whole days
  const pa = parts(a), pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}
function manilaNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function manilaToday() { return dk(manilaNow()); }
function manilaHour() { return manilaNow().getUTCHours(); }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDate(key) { if (!key) return ''; const { y, m, d } = parts(key); return `${MONTHS[m - 1]} ${d}, ${y}`; }
function fmtMonth(ym) { if (!ym) return ''; const [y, m] = ym.split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function peso(n) {
  const v = round2(n);
  const opts = Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return (v < 0 ? '-' : '') + '\u20B1' + Math.abs(v).toLocaleString('en-PH', opts);
}

// ── MONEY MATH (pure) ────────────────────────────────────────
// The rent schedule: one line per month of the term.
//   * period 0 is due on the start date itself (the move-in payment)
//   * every later period is due on `dueDay` of the month that period starts in
//   * escalation applies from month 13, compounding yearly
function schedule(lease) {
  const start = dk(lease.startDate);
  const rent = round2(lease.monthlyRent);
  if (!start || rent <= 0) return [];
  let term = parseInt(lease.termMonths, 10) || 0;
  const end = dk(lease.endDate);
  if (!term && end) {
    const a = parts(start), b = parts(end);
    term = (b.y - a.y) * 12 + (b.m - a.m) + (b.d >= a.d ? 1 : 0);
  }
  term = Math.max(1, Math.min(term || 12, 360));
  const dueDay = Math.min(31, Math.max(1, parseInt(lease.dueDay, 10) || 1));
  const esc = Math.max(0, Number(lease.escalationPct) || 0);
  const rows = [];
  for (let i = 0; i < term; i++) {
    const pStart = addMonths(start, i);
    const pEnd = addDays(addMonths(start, i + 1), -1);
    const { y, m } = parts(pStart);
    const due = i === 0 ? start : fromParts(y, m, Math.min(dueDay, daysInMonth(y, m)));
    const amount = round2(rent * Math.pow(1 + esc / 100, Math.floor(i / 12)));
    rows.push({ i, month: `${y}-${pad2(m)}`, start: pStart, end: pEnd, due, amount,
      label: `${MONTHS[m - 1]} ${y}` });
  }
  return rows;
}

// FIFO allocation. Every peso that is not a deposit is poured into the oldest
// unpaid line first (rent lines and one-off charges together, by due date).
// The deposit is money HELD for the tenant, never income against rent, so it
// is tracked on its own.
function computeLease(lease, today) {
  today = today || manilaToday();
  const sched = schedule(lease);
  const grace = Math.max(0, parseInt(lease.graceDays, 10) || 0);
  const pays = Array.isArray(lease.payments) ? lease.payments : [];
  const charges = Array.isArray(lease.charges) ? lease.charges : [];

  const credits = { rent: 0, deposit: 0, advance: 0, total: 0 };
  pays.forEach(p => {
    const a = round2(p.amount);
    credits.total += a;
    if (p.kind === 'deposit') credits.deposit += a;
    else { credits.rent += a; if (p.kind === 'advance') credits.advance += a; }
  });

  const debits = [
    ...sched.map(r => ({ type: 'rent', ref: r.month, due: r.due, amount: r.amount, label: `Rent · ${r.label}`, row: r })),
    ...charges.map(c => ({ type: 'charge', ref: String(c._id || ''), due: dk(c.date) || today, amount: round2(c.amount), label: c.label || c.kind || 'Charge', kind: c.kind, row: c }))
  ].sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : (a.type === 'rent' ? -1 : 1));

  let pool = round2(credits.rent);
  let dueToDate = 0, overdueAmount = 0, overdueCount = 0, dueNowAmount = 0, oldestOverdueDays = 0;
  let remainingContract = 0, contractValue = 0, lateFeeSuggested = 0;
  debits.forEach(d => {
    const paid = Math.min(pool, d.amount);
    pool = round2(pool - paid);
    d.paid = round2(paid);
    d.remaining = round2(d.amount - paid);
    const isPaid = d.remaining <= 0.005;
    const daysLate = diffDays(d.due, today);
    d.daysLate = Math.max(0, daysLate);
    if (isPaid) d.status = 'paid';
    else if (d.due > today) d.status = 'upcoming';
    else if (daysLate > grace) d.status = 'overdue';
    else d.status = paid > 0 ? 'partial' : 'due';
    if (d.due <= today) dueToDate += d.amount;
    if (d.status === 'overdue') {
      overdueAmount += d.remaining; overdueCount++;
      oldestOverdueDays = Math.max(oldestOverdueDays, daysLate);
      if (lease.lateFeeType === 'percent') lateFeeSuggested += round2(d.amount * (Number(lease.lateFeeValue) || 0) / 100);
      else if (lease.lateFeeType === 'fixed') lateFeeSuggested += Number(lease.lateFeeValue) || 0;
    }
    if (d.status === 'due' || d.status === 'partial') dueNowAmount += d.remaining;
    if (d.type === 'rent') {
      contractValue += d.amount;
      if (d.due > today) remainingContract += d.remaining;
    }
  });
  const creditBalance = pool; // paid ahead of the schedule

  const rentRows = debits.filter(d => d.type === 'rent').map(d => ({ ...d.row, paid: d.paid, remaining: d.remaining, status: d.status, daysLate: d.daysLate }));
  const chargeRows = debits.filter(d => d.type === 'charge').map(d => ({
    id: d.ref, date: d.due, label: d.label, kind: d.kind, amount: d.amount, paid: d.paid, remaining: d.remaining, status: d.status, note: d.row.note || ''
  }));
  const nextRent = rentRows.find(r => r.status !== 'paid') || null;

  // Deposit account: required vs held vs settled at move-out.
  const depRequired = round2(lease.depositAmount);
  const deductions = (lease.depositDeductions || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const refunded = round2(lease.depositRefunded);
  const held = round2(credits.deposit - deductions - refunded);
  let depStatus = 'none';
  if (depRequired > 0 || credits.deposit > 0) {
    if (credits.deposit <= 0) depStatus = 'unpaid';
    else if (credits.deposit + 0.005 < depRequired) depStatus = 'partial';
    else if (refunded > 0 || deductions >= credits.deposit - 0.005) depStatus = 'settled';
    else depStatus = 'held';
  }

  const advRequired = round2(lease.advanceAmount);
  const brokerFee = brokerFeeOf(lease);
  const end = dk(lease.endDate) || (sched.length ? sched[sched.length - 1].end : '');
  const daysToEnd = end ? diffDays(today, end) : null;
  const balance = round2(dueToDate - credits.rent);   // >0 owed, <0 paid ahead

  return {
    today,
    schedule: rentRows,
    charges: chargeRows,
    credits: { rent: round2(credits.rent), deposit: round2(credits.deposit), advance: round2(credits.advance), total: round2(credits.total) },
    dueToDate: round2(dueToDate),
    balance,
    creditBalance: round2(creditBalance),
    overdueAmount: round2(overdueAmount), overdueCount, oldestOverdueDays,
    dueNowAmount: round2(dueNowAmount),
    nextDue: nextRent ? { month: nextRent.month, label: nextRent.label, due: nextRent.due, amount: nextRent.amount, remaining: nextRent.remaining, status: nextRent.status, daysLate: nextRent.daysLate } : null,
    remainingContract: round2(remainingContract),
    contractValue: round2(contractValue),
    deposit: { required: depRequired, paid: round2(credits.deposit), deductions: round2(deductions), refunded, held, status: depStatus },
    advance: { required: advRequired, paid: round2(credits.advance) },
    moveInCashOut: round2(depRequired + advRequired + (lease.brokerFeePaidBy === 'tenant' ? brokerFee : lease.brokerFeePaidBy === 'both' ? brokerFee / 2 : 0)),
    brokerFee,
    lateFeeSuggested: round2(lateFeeSuggested),
    daysToEnd,
    endsSoon: daysToEnd !== null && daysToEnd >= 0 && daysToEnd <= 60,
    expired: daysToEnd !== null && daysToEnd < 0,
    termMonths: sched.length,
    start: dk(lease.startDate), end
  };
}

function brokerFeeOf(lease) {
  const rent = round2(lease.monthlyRent), v = Number(lease.brokerFeeValue) || 0;
  switch (lease.brokerFeeType) {
    case 'one_month': return rent;
    case 'percent': return round2(rent * (parseInt(lease.termMonths, 10) || 12) * v / 100);
    case 'fixed': return round2(v);
    default: return 0;
  }
}

// The rent roll: every lease that has a rent line falling in `month`, with
// what was expected, what came in, and where it stands. Charges dated in the
// month ride along so association dues and utilities are not forgotten.
function rentRoll(leases, month, today) {
  today = today || manilaToday();
  const rows = [];
  leases.forEach(l => {
    if (['prospect', 'viewing', 'application', 'on_hold'].includes(l.stage)) return;
    const c = computeLease(l, today);
    const line = c.schedule.find(r => r.month === month);
    const monthCharges = c.charges.filter(ch => ch.date && ch.date.slice(0, 7) === month);
    if (!line && !monthCharges.length) return;
    const chargesAmt = monthCharges.reduce((s, x) => s + x.amount, 0);
    const chargesPaid = monthCharges.reduce((s, x) => s + x.paid, 0);
    rows.push({
      leaseId: String(l._id), stage: l.stage,
      tenantName: l.tenantName, propertyTitle: l.propertyTitle, unit: l.unit,
      ownerName: l.ownerName, managedByGLRA: !!l.managedByGLRA, managementFeePct: Number(l.managementFeePct) || 0,
      due: line ? line.due : '', rent: line ? line.amount : 0, rentPaid: line ? line.paid : 0,
      status: line ? line.status : (chargesPaid + 0.005 >= chargesAmt ? 'paid' : 'due'),
      charges: round2(chargesAmt), chargesPaid: round2(chargesPaid),
      expected: round2((line ? line.amount : 0) + chargesAmt),
      collected: round2((line ? line.paid : 0) + chargesPaid),
      balanceToDate: c.balance, daysLate: line ? line.daysLate : 0
    });
  });
  rows.sort((a, b) => (a.due || '9') < (b.due || '9') ? -1 : 1);
  const totals = rows.reduce((t, r) => {
    t.expected += r.expected; t.collected += r.collected;
    if (r.status === 'overdue') { t.overdue += r.expected - r.collected; t.overdueCount++; }
    if (r.managedByGLRA) { t.managedCollected += r.rentPaid; t.managementFees += round2(r.rentPaid * r.managementFeePct / 100); }
    return t;
  }, { expected: 0, collected: 0, overdue: 0, overdueCount: 0, managedCollected: 0, managementFees: 0 });
  totals.outstanding = round2(totals.expected - totals.collected);
  totals.rate = totals.expected > 0 ? Math.round(totals.collected / totals.expected * 100) : 0;
  Object.keys(totals).forEach(k => { totals[k] = round2(totals[k]); });
  totals.rate = Math.round(totals.rate);
  totals.overdueCount = Math.round(totals.overdueCount);
  return { month, rows, totals };
}

// ── SETTINGS ─────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  reminderDays: 3,          // rent-due reminder N days before the due date
  overdueNotice: true,      // overdue notice once the grace period lapses
  expiryDays: [60, 30, 7],  // lease-ending alerts to the broker
  digestEnabled: true,      // one morning email to the broker when anything needs attention
  digestHour: 8,            // Manila hour
  notifyEmail: BROKER_INBOX,
  paymentInstructions: '',  // free text shown in tenant reminders (bank / GCash details)
  defaultDueDay: 5, defaultGraceDays: 5, defaultDepositMonths: 2, defaultAdvanceMonths: 1,
  calToken: '', lastDigestKey: ''
};
async function getSettings() {
  const doc = await Setting.findOne({ key: 'leasing' }).lean();
  return { ...DEFAULT_SETTINGS, ...((doc && doc.value) || {}) };
}
async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await Setting.findOneAndUpdate({ key: 'leasing' }, { value: next, updatedAt: new Date() }, { upsert: true });
  return next;
}
function publicSettings(s) { const { calToken, lastDigestKey, ...rest } = s; return { ...rest, hasCalToken: !!calToken, calFeedPath: calToken ? `/api/leasing-cal/${calToken}` : null }; }

// ── INPUT SANITISER ──────────────────────────────────────────
// Only known fields pass through, each clamped to its type. Unknown keys and
// the ledger arrays (payments, charges, files, notes, emailLog) are ignored:
// those have their own routes so a stale edit form can never wipe a ledger.
function sanitizeLeaseBody(b, opts = {}) {
  const out = {};
  const str = (k, n) => { if (b[k] !== undefined) out[k] = String(b[k] == null ? '' : b[k]).trim().slice(0, n); };
  const num = (k, min, max) => { if (b[k] === undefined || b[k] === null || b[k] === '') { if (b[k] === '' ) out[k] = 0; return; } const n = Number(String(b[k]).replace(/,/g, '')); if (!isNaN(n)) out[k] = Math.min(max, Math.max(min, n)); };
  const int = (k, min, max) => { if (b[k] === undefined || b[k] === null || b[k] === '') return; const n = parseInt(b[k], 10); if (!isNaN(n)) out[k] = Math.min(max, Math.max(min, n)); };
  const bool = k => { if (b[k] !== undefined) out[k] = b[k] === true || b[k] === 'true' || b[k] === 1 || b[k] === '1' || b[k] === 'on'; };
  const date = k => { if (b[k] === undefined) return; if (b[k] === '' || b[k] === null) { out[k] = null; return; } const key = dk(b[k]); if (key) out[k] = new Date(key + 'T00:00:00Z'); };
  const oneOf = (k, list) => { if (b[k] !== undefined && list.includes(b[k])) out[k] = b[k]; };
  const email = k => { if (b[k] !== undefined) out[k] = String(b[k] || '').trim().toLowerCase().slice(0, 120); };

  if (b.propertyId !== undefined) out.propertyId = /^[a-f0-9]{24}$/i.test(String(b.propertyId || '')) ? b.propertyId : null;
  str('propertyTitle', 200); str('unit', 80); str('address', 300); str('propertyType', 60);
  oneOf('furnished', ['', 'unfurnished', 'semi', 'full']); int('parkingSlots', 0, 20); bool('hideListingWhileActive');
  str('ownerName', 200); str('ownerPhone', 50); str('ownerPhone2', 50); email('ownerEmail'); str('ownerAddress', 300);
  str('ownerCivilStatus', 40); str('ownerSpouse', 200); str('ownerIdType', 60); str('ownerIdNo', 60);
  str('ownerTin', 40); str('ownerRep', 200); str('ownerRepPhone', 50); str('ownerRemittance', 400);
  bool('managedByGLRA'); num('managementFeePct', 0, 100);
  str('tenantName', 200); str('tenantPhone', 50); str('tenantPhone2', 50); email('tenantEmail'); str('tenantAddress', 300);
  str('tenantIdType', 60); str('tenantIdNo', 60); str('tenantOccupation', 120); str('tenantCompany', 120);
  str('tenantTin', 40); str('tenantNationality', 60); str('tenantCivilStatus', 40); str('tenantSpouse', 200);
  str('tenantWorkAddress', 300);
  int('occupants', 0, 99); str('emergencyName', 200); str('emergencyPhone', 50);
  str('emergencyRelation', 60); str('emergencyAddress', 300);
  date('startDate'); date('endDate'); int('termMonths', 1, 360); num('monthlyRent', 0, 1e9);
  int('dueDay', 1, 31); int('graceDays', 0, 60); num('escalationPct', 0, 100);
  num('depositMonths', 0, 24); num('depositAmount', 0, 1e9); num('advanceMonths', 0, 24); num('advanceAmount', 0, 1e9);
  oneOf('lateFeeType', ['none', 'percent', 'fixed']); num('lateFeeValue', 0, 1e7);
  oneOf('duesPaidBy', ['', 'tenant', 'owner']); str('utilitiesIncluded', 200); str('inclusions', 500); bool('petsAllowed');
  date('viewingAt');
  oneOf('brokerFeeType', ['one_month', 'percent', 'fixed', 'none']); num('brokerFeeValue', 0, 1e9);
  oneOf('brokerFeePaidBy', ['owner', 'tenant', 'both']); num('brokerFeeCollected', 0, 1e9);
  date('moveInDate'); date('moveOutDate'); if (b.moveInNotes !== undefined) out.moveInNotes = String(b.moveInNotes || '').slice(0, 3000);
  if (Array.isArray(b.depositDeductions)) {
    out.depositDeductions = b.depositDeductions.slice(0, 50)
      .map(x => ({ label: String((x && x.label) || '').trim().slice(0, 200), amount: Math.max(0, Number(x && x.amount) || 0) }))
      .filter(x => x.label || x.amount);
  }
  num('depositRefunded', 0, 1e9); date('depositRefundDate');
  oneOf('renewalDecision', ['', 'undecided', 'renew', 'vacate']);
  bool('autoEmails'); if (b.remarks !== undefined) out.remarks = String(b.remarks || '').slice(0, 5000);
  if (opts.allowStage && typeof b.stage === 'string' && LEASE_STAGES.includes(b.stage)) out.stage = b.stage;
  return out;
}

// Fill the figures a person would otherwise type twice: end date from start +
// term, deposit/advance amounts from months × rent. Only fills blanks.
function deriveTerms(doc) {
  const start = dk(doc.startDate);
  if (start && doc.termMonths && !doc.endDate) doc.endDate = new Date(addDays(addMonths(start, doc.termMonths), -1) + 'T00:00:00Z');
  const rent = round2(doc.monthlyRent);
  if (rent > 0) {
    if (!doc.depositAmount && doc.depositMonths > 0) doc.depositAmount = round2(rent * doc.depositMonths);
    if (!doc.advanceAmount && doc.advanceMonths > 0) doc.advanceAmount = round2(rent * doc.advanceMonths);
  }
}

function leaseLabel(l) {
  const who = l.tenantName || 'No tenant yet';
  const what = [l.propertyTitle, l.unit].filter(Boolean).join(' · ');
  return what ? `${who} — ${what}` : who;
}
function withComputed(l, today) { return { ...l, computed: computeLease(l, today) }; }
function addNote(doc, kind, text, byName) {
  doc.notes.push({ at: new Date(), byName: byName || '', kind, text: String(text || '').slice(0, 2000) });
  if (doc.notes.length > 500) doc.notes = doc.notes.slice(-500);
}

async function nextReceiptNo() {
  const year = manilaToday().slice(0, 4);
  const c = await Counter.findOneAndUpdate({ key: `lease_receipt_${year}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `AR-${year}-${String(c.seq).padStart(4, '0')}`;
}

// ── EMAILS ───────────────────────────────────────────────────
// Every tenant/owner message is built here so the wording stays consistent
// whether a person clicks Send or the reminder engine fires it at 8am.
function emailShell(esc, title, bodyHtml) {
  return getEmailHeader() + `<h2 style="color:#0a1628;margin:0 0 14px;font-size:22px">${esc(title)}</h2>${bodyHtml}` + getEmailFooter();
}
function factsTable(esc, rows) {
  return `<table cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.7;border-collapse:collapse;margin:14px 0">${rows.filter(r => r[1] !== '' && r[1] != null).map(r => `<tr><td style="padding:3px 16px 3px 0;color:#666;white-space:nowrap;vertical-align:top">${esc(r[0])}</td><td style="padding:3px 0;font-weight:600">${esc(String(r[1]))}</td></tr>`).join('')}</table>`;
}
function unitLine(l) { return [l.propertyTitle, l.unit, l.address].filter(Boolean).join(', '); }

function buildEmail(kind, { lease, computed, settings, payment, esc, subject, message }) {
  const l = lease, c = computed;
  const first = (l.tenantName || '').split(' ')[0] || 'there';
  const pay = settings.paymentInstructions ? `<div style="margin:16px 0;padding:12px 14px;border:2px solid #0a0a0a;background:#fff;font-size:13px;line-height:1.7"><div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:700;color:#ff3d00;margin-bottom:6px">How to pay</div>${esc(settings.paymentInstructions).replace(/\n/g, '<br>')}</div>` : '';
  const closing = `<p style="font-size:14px;color:#333">Questions? Just reply to this email.</p>`;
  switch (kind) {
    case 'reminder': {
      const n = c.nextDue;
      return {
        subject: `Rent reminder: ${peso(n ? n.remaining : l.monthlyRent)} due ${n ? fmtDate(n.due) : ''} — ${l.propertyTitle || 'your unit'}`,
        html: emailShell(esc, `Hi ${first}, a friendly reminder`, `
          <p style="font-size:15px">Your rent for <strong>${esc(n ? n.label : '')}</strong> is coming up.</p>
          ${factsTable(esc, [['Unit', unitLine(l)], ['Amount due', peso(n ? n.remaining : l.monthlyRent)], ['Due date', n ? fmtDate(n.due) : ''], ['Grace period', l.graceDays ? `${l.graceDays} days` : '']])}
          ${pay}${closing}`)
      };
    }
    case 'overdue': {
      const over = c.schedule.filter(r => r.status === 'overdue');
      const amt = c.overdueAmount;
      return {
        subject: `Overdue rent: ${peso(amt)} — ${l.propertyTitle || 'your unit'}`,
        html: emailShell(esc, `Hi ${first}, your rent is past due`, `
          <p style="font-size:15px">Our records show the following rent has not been received:</p>
          ${factsTable(esc, over.map(r => [r.label, `${peso(r.remaining)} · due ${fmtDate(r.due)} · ${r.daysLate} days late`]))}
          <p style="font-size:15px"><strong>Total overdue: ${peso(amt)}</strong>${c.lateFeeSuggested ? ` (late charges per your contract may apply: ${peso(c.lateFeeSuggested)})` : ''}</p>
          <p style="font-size:14px;color:#333">If you have already paid, please reply with the date and reference number so we can update your ledger.</p>
          ${pay}`)
      };
    }
    case 'receipt': {
      const p = payment;
      return {
        subject: `Receipt ${p.receiptNo || ''} — ${peso(p.amount)} received`,
        html: emailShell(esc, `Payment received, thank you ${first}`, `
          ${factsTable(esc, [['Receipt no.', p.receiptNo || ''], ['Amount', peso(p.amount)], ['Date', fmtDate(dk(p.date))], ['For', kindLabel(p.kind) + (p.forPeriod ? ` · ${fmtMonth(p.forPeriod)}` : '')], ['Mode', p.mode || ''], ['Reference', p.reference || ''], ['Unit', unitLine(l)]])}
          <p style="font-size:14px;color:#333">Your official acknowledgement receipt is attached as a PDF.</p>
          ${c.balance > 0 ? `<p style="font-size:14px">Remaining balance on your account: <strong>${peso(c.balance)}</strong>.</p>` : c.balance < 0 ? `<p style="font-size:14px">Your account is paid ahead by <strong>${peso(-c.balance)}</strong>.</p>` : `<p style="font-size:14px">Your account is fully up to date.</p>`}`)
      };
    }
    case 'statement':
      return {
        subject: `Statement of account — ${l.propertyTitle || 'your lease'} (${fmtDate(c.today)})`,
        html: emailShell(esc, `Hi ${first}, here is your statement`, `
          <p style="font-size:15px">Attached is your statement of account as of ${fmtDate(c.today)}.</p>
          ${factsTable(esc, [['Unit', unitLine(l)], ['Balance', c.balance > 0 ? `${peso(c.balance)} due` : c.balance < 0 ? `${peso(-c.balance)} credit` : 'Fully paid'], ['Next payment', c.nextDue ? `${peso(c.nextDue.remaining)} on ${fmtDate(c.nextDue.due)}` : 'None'], ['Security deposit held', peso(c.deposit.held)]])}
          ${pay}${closing}`)
      };
    case 'renewal': {
      const end = fmtDate(c.end);
      return {
        subject: `Your lease ends on ${end} — renew or move out?`,
        html: emailShell(esc, `Hi ${first}, your lease is ending soon`, `
          <p style="font-size:15px">Your lease for <strong>${esc(unitLine(l))}</strong> ends on <strong>${end}</strong>${c.daysToEnd != null ? ` (${c.daysToEnd} days from now)` : ''}.</p>
          <p style="font-size:15px">Please let us know whether you would like to <strong>renew</strong> or <strong>move out</strong> at the end of the term. A reply at least 30 days before the end date gives everyone time to prepare.</p>
          ${l.escalationPct ? `<p style="font-size:14px;color:#333">Per your contract, rent adjusts by ${l.escalationPct}% on renewal.</p>` : ''}
          ${closing}`)
      };
    }
    case 'welcome':
      return {
        subject: `Welcome to ${l.propertyTitle || 'your new home'} — lease summary`,
        html: emailShell(esc, `Welcome, ${first}!`, `
          <p style="font-size:15px">Here is a summary of your lease for easy reference.</p>
          ${factsTable(esc, [['Unit', unitLine(l)], ['Term', `${fmtDate(c.start)} to ${fmtDate(c.end)} (${c.termMonths} months)`], ['Monthly rent', peso(l.monthlyRent)], ['Rent due', l.dueDay ? `every ${ordinal(l.dueDay)} of the month` : ''], ['Security deposit', peso(l.depositAmount)], ['Advance rent', peso(l.advanceAmount)], ['Association dues', l.duesPaidBy ? `paid by ${l.duesPaidBy}` : ''], ['Utilities included', l.utilitiesIncluded || ''], ['Inclusions', l.inclusions || '']])}
          ${pay}${closing}`)
      };
    case 'owner_statement':
      return {
        subject: `Owner statement — ${l.propertyTitle || 'your property'} (${fmtDate(c.today)})`,
        html: emailShell(esc, `Dear ${(l.ownerName || 'Owner').split(' ')[0]},`, `
          <p style="font-size:15px">Attached is the statement for your property <strong>${esc(unitLine(l))}</strong> as of ${fmtDate(c.today)}.</p>
          ${factsTable(esc, [['Tenant', l.tenantName], ['Monthly rent', peso(l.monthlyRent)], ['Rent collected to date', peso(c.credits.rent)], ['Tenant balance', c.balance > 0 ? `${peso(c.balance)} outstanding` : 'Up to date'], ['Lease ends', fmtDate(c.end)]])}
          ${closing}`)
      };
    case 'custom':
    default:
      return {
        subject: (subject || `A message from GLRA Realty about ${l.propertyTitle || 'your lease'}`).slice(0, 200),
        html: emailShell(esc, subject || 'A message from GLRA Realty', `<div style="font-size:15px;line-height:1.7;white-space:pre-wrap">${esc(message || '')}</div>`)
      };
  }
}
function kindLabel(k) { return ({ rent: 'Rent', advance: 'Advance rent', deposit: 'Security deposit', dues: 'Association dues', utilities: 'Utilities', penalty: 'Penalty / late fee', other: 'Other' })[k] || 'Payment'; }
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// ── ICS CALENDAR ─────────────────────────────────────────────
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function vevent({ uid, dateStr, summary, description }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VEVENT', `UID:${uid}@glrarealty.com`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateStr.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(dateStr, 1).replace(/-/g, '')}`,
    `SUMMARY:${icsEscape(summary)}`, description ? `DESCRIPTION:${icsEscape(description)}` : null, 'END:VEVENT'].filter(Boolean).join('\r\n');
}

// =============================================================================
// ROUTES
// =============================================================================
function registerLeasingRoutes(app, { sendEmail, esc, uploadAttachment, cloudinary }) {
  const view = [verifyToken, requirePermission('leasing_view')];
  const manage = [verifyToken, requirePermission('leasing_manage')];
  const byName = req => (req.user && (req.user.name || req.user.email)) || '';
  const findLease = async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) { res.status(404).json({ error: 'Lease not found' }); return null; }
    const doc = await Lease.findById(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Lease not found' }); return null; }
    return doc;
  };
  const sendPdf = (res, buf, filename, download) => {
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/[^a-z0-9._-]/gi, '_')}"`);
    res.set('Cache-Control', 'private, no-store');
    res.send(buf);
  };

  // ── list + rent roll + settings ──
  app.get('/api/admin/leases', ...view, async (req, res) => {
    try {
      const today = manilaToday();
      const [leases, settings] = await Promise.all([Lease.find().sort({ updatedAt: -1 }).lean(), getSettings()]);
      res.json({ today, stages: STAGE_META, flow: LEASE_FLOW, settings: publicSettings(settings), leases: leases.map(l => withComputed(l, today)) });
    } catch (err) { console.error('leases list error:', err); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/admin/leases/rent-roll', ...view, async (req, res) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : manilaToday().slice(0, 7);
      const leases = await Lease.find({ stage: { $nin: ['prospect', 'viewing', 'application', 'on_hold'] } }).lean();
      res.json(rentRoll(leases, month));
    } catch (err) { console.error('rent roll error:', err); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/admin/leases/rent-roll.pdf', ...view, async (req, res) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : manilaToday().slice(0, 7);
      const leases = await Lease.find({ stage: { $nin: ['prospect', 'viewing', 'application', 'on_hold'] } }).lean();
      const roll = rentRoll(leases, month);
      const buf = await pdf.rentRollPdf(roll, { fmtMonth, fmtDate, peso });
      sendPdf(res, buf, `GLRA-rent-roll-${month}.pdf`, req.query.download === '1');
    } catch (err) { console.error('rent roll pdf error:', err); res.status(500).json({ error: 'Could not build the PDF' }); }
  });

  app.get('/api/admin/leasing/settings', ...view, async (req, res) => {
    try { res.json(publicSettings(await getSettings())); }
    catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.put('/api/admin/leasing/settings', ...manage, async (req, res) => {
    try {
      const b = req.body || {}, patch = {};
      const int = (k, min, max) => { if (b[k] !== undefined) { const n = parseInt(b[k], 10); if (!isNaN(n)) patch[k] = Math.min(max, Math.max(min, n)); } };
      const bool = k => { if (b[k] !== undefined) patch[k] = b[k] === true || b[k] === 'true'; };
      int('reminderDays', 0, 30); bool('overdueNotice'); bool('digestEnabled'); int('digestHour', 5, 20);
      int('defaultDueDay', 1, 31); int('defaultGraceDays', 0, 60); int('defaultDepositMonths', 0, 24); int('defaultAdvanceMonths', 0, 24);
      if (Array.isArray(b.expiryDays)) patch.expiryDays = [...new Set(b.expiryDays.map(x => parseInt(x, 10)).filter(n => n > 0 && n <= 365))].sort((x, y) => y - x).slice(0, 6);
      if (b.notifyEmail !== undefined) { const e = String(b.notifyEmail || '').trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) patch.notifyEmail = e; }
      if (b.paymentInstructions !== undefined) patch.paymentInstructions = String(b.paymentInstructions || '').slice(0, 1500);
      const next = await saveSettings(patch);
      await logAudit(req, 'UPDATE', 'LeasingSettings', 'leasing', 'Leasing settings', patch);
      res.json(publicSettings(next));
    } catch (err) { console.error('leasing settings error:', err); res.status(500).json({ error: 'Server error' }); }
  });

  // The calendar feed token is the whole secret, so only an admin may mint
  // one, and minting a new one silently disconnects any phone using the old.
  app.post('/api/admin/leasing/calendar-token', verifyToken, requireAdmin, async (req, res) => {
    try {
      const calToken = crypto.randomBytes(24).toString('hex');
      await saveSettings({ calToken });
      await logAudit(req, 'UPDATE', 'LeasingSettings', 'leasing', 'Calendar feed regenerated', null);
      res.json({ success: true, calFeedPath: `/api/leasing-cal/${calToken}` });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/leasing-cal/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').replace(/\.ics$/i, '');
      if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).send('Not found');
      const settings = await getSettings();
      if (!settings.calToken || settings.calToken !== token) return res.status(404).send('Not found');
      const today = manilaToday();
      const leases = await Lease.find({ stage: { $nin: ['ended'] } }).lean();
      const evs = [];
      leases.forEach(l => {
        const who = l.tenantName || 'Prospect';
        const unit = [l.propertyTitle, l.unit].filter(Boolean).join(' ');
        if (l.viewingAt && dk(l.viewingAt) >= addDays(today, -7)) evs.push(vevent({ uid: `lv-${l._id}`, dateStr: dk(l.viewingAt), summary: `Viewing: ${who} · ${unit}`, description: 'GLRA Leasing' }));
        if (!LIVE_STAGES.includes(l.stage) && l.stage !== 'contract') return;
        const c = computeLease(l, today);
        c.schedule.forEach(r => {
          if (r.status === 'paid' || r.due < addDays(today, -31) || r.due > addMonths(today, 12)) return;
          evs.push(vevent({ uid: `rent-${l._id}-${r.month}`, dateStr: r.due, summary: `Rent due: ${who} · ${peso(r.remaining)}`, description: `${unit}\n${r.label} rent` }));
        });
        if (c.end && c.end >= addDays(today, -31)) evs.push(vevent({ uid: `end-${l._id}`, dateStr: c.end, summary: `Lease ends: ${who} · ${unit}`, description: 'Renewal or turnover' }));
        if (l.moveInDate && dk(l.moveInDate) >= today) evs.push(vevent({ uid: `in-${l._id}`, dateStr: dk(l.moveInDate), summary: `Move-in: ${who} · ${unit}` }));
      });
      const cal = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GLRA Realty//Leasing//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'X-WR-CALNAME:GLRA Leasing', 'X-WR-TIMEZONE:Asia/Manila', ...evs, 'END:VCALENDAR', ''].join('\r\n');
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Cache-Control', 'private, max-age=900');
      res.send(cal);
    } catch (err) { console.error('leasing-cal error:', err); res.status(500).send('Server error'); }
  });

  // ── create ──
  app.post('/api/admin/leases', ...manage, async (req, res) => {
    try {
      const data = sanitizeLeaseBody(req.body || {}, { allowStage: true });
      if (!data.tenantName && !data.propertyTitle) return res.status(400).json({ error: 'Give the lease a tenant name or a property' });
      deriveTerms(data);
      data.createdBy = req.user?.email || ''; data.createdByName = byName(req);
      data.stageHistory = [{ stage: data.stage || 'prospect', at: new Date(), byName: byName(req) }];
      const doc = await Lease.create(data);
      addNote(doc, 'system', `Lease created (${STAGE_META[doc.stage].label})`, byName(req));
      await doc.save();
      await logAudit(req, 'CREATE', 'Lease', String(doc._id), leaseLabel(doc), null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('lease create error:', err); res.status(500).json({ error: 'Server error' }); }
  });

  // A website inquiry on a rental becomes a Prospect card in one click.
  app.post('/api/admin/leases/from-inquiry/:inquiryId', ...manage, async (req, res) => {
    try {
      if (!/^[a-f0-9]{24}$/i.test(req.params.inquiryId)) return res.status(404).json({ error: 'Inquiry not found' });
      const inq = await Inquiry.findById(req.params.inquiryId).lean();
      if (!inq) return res.status(404).json({ error: 'Inquiry not found' });
      const existing = await Lease.findOne({ source: `inquiry:${inq._id}` }).lean();
      if (existing) return res.json({ existing: true, lease: withComputed(existing) });
      const data = { stage: 'prospect', tenantName: String(inq.name || '').slice(0, 200), tenantEmail: String(inq.email || '').toLowerCase().slice(0, 120), tenantPhone: String(inq.phone || '').slice(0, 50), source: `inquiry:${inq._id}` };
      if (inq.propertyId && /^[a-f0-9]{24}$/i.test(String(inq.propertyId))) {
        const p = await Property.findById(inq.propertyId).lean();
        if (p) { data.propertyId = p._id; data.propertyTitle = p.title || inq.propertyTitle || ''; data.address = p.location || ''; data.propertyType = p.propertyType || ''; data.monthlyRent = Number(p.monthlyRental) || 0; data.parkingSlots = Number(p.parking) || 0; }
      }
      if (!data.propertyTitle && inq.propertyTitle) data.propertyTitle = String(inq.propertyTitle).slice(0, 200);
      const settings = await getSettings();
      data.dueDay = settings.defaultDueDay; data.graceDays = settings.defaultGraceDays; data.depositMonths = settings.defaultDepositMonths; data.advanceMonths = settings.defaultAdvanceMonths;
      deriveTerms(data);
      data.createdBy = req.user?.email || ''; data.createdByName = byName(req);
      data.stageHistory = [{ stage: 'prospect', at: new Date(), byName: byName(req) }];
      const doc = await Lease.create(data);
      addNote(doc, 'system', `Created from website inquiry (${fmtDate(dk(inq.createdAt))}): ${String(inq.message || '').slice(0, 800)}`, byName(req));
      await doc.save();
      await logAudit(req, 'CREATE', 'Lease', String(doc._id), leaseLabel(doc), { fromInquiry: String(inq._id) });
      res.json({ lease: withComputed(doc.toObject()) });
    } catch (err) { console.error('lease from inquiry error:', err); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/admin/leases/:id', ...view, async (req, res) => {
    try { const doc = await findLease(req, res); if (!doc) return; res.json(withComputed(doc.toObject())); }
    catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.put('/api/admin/leases/:id', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const data = sanitizeLeaseBody(req.body || {});
      if (data.tenantName !== undefined && !data.tenantName && !(data.propertyTitle ?? doc.propertyTitle)) return res.status(400).json({ error: 'Give the lease a tenant name or a property' });
      Object.assign(doc, data);
      deriveTerms(doc);
      await doc.save();
      await logAudit(req, 'UPDATE', 'Lease', String(doc._id), leaseLabel(doc), null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('lease update error:', err); res.status(500).json({ error: 'Server error' }); }
  });

  // Deleting a lease erases a ledger, so it is admin-only even for people who
  // can otherwise manage leasing.
  app.delete('/api/admin/leases/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const doc = await Lease.findByIdAndDelete(req.params.id);
      if (doc) await logAudit(req, 'DELETE', 'Lease', String(doc._id), leaseLabel(doc), null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── stage moves (board drag + Next button) ──
  app.post('/api/admin/leases/:id/stage', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const stage = String(req.body?.stage || '');
      if (!LEASE_STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
      if (doc.stage === stage) return res.json(withComputed(doc.toObject()));
      const from = doc.stage;
      doc.stage = stage;
      doc.stageHistory.push({ stage, at: new Date(), byName: byName(req) });
      const today = manilaToday();
      if (stage === 'active' && !doc.moveInDate) doc.moveInDate = new Date((dk(doc.startDate) || today) + 'T00:00:00Z');
      if (stage === 'ended' && !doc.moveOutDate) doc.moveOutDate = new Date(today + 'T00:00:00Z');
      let listingNote = '';
      if (stage === 'active' && doc.propertyId && doc.hideListingWhileActive) {
        const r = await Property.updateOne({ _id: doc.propertyId, status: 'available' }, { $set: { status: 'sold' } });
        if (r.modifiedCount) listingNote = ' · listing hidden from the website';
      }
      addNote(doc, 'stage', `Moved ${STAGE_META[from].label} → ${STAGE_META[stage].label}${listingNote}`, byName(req));
      await doc.save();
      await logAudit(req, 'UPDATE', 'Lease', String(doc._id), leaseLabel(doc), { stage: [from, stage] });
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('lease stage error:', err); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/leases/:id/relist', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      if (!doc.propertyId) return res.status(400).json({ error: 'This lease is not linked to a website listing' });
      await Property.updateOne({ _id: doc.propertyId }, { $set: { status: 'available' } });
      addNote(doc, 'system', 'Listing put back on the website', byName(req));
      await doc.save();
      await logAudit(req, 'UPDATE', 'Property', String(doc.propertyId), doc.propertyTitle, { status: 'available', reason: 'relist after lease' });
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── payments ──
  function paymentFrom(b) {
    const out = {};
    const key = dk(b.date); out.date = key ? new Date(key + 'T00:00:00Z') : new Date(manilaToday() + 'T00:00:00Z');
    out.amount = round2(Math.max(0, Number(String(b.amount ?? 0).replace(/,/g, '')) || 0));
    out.kind = ['rent', 'advance', 'deposit', 'dues', 'utilities', 'penalty', 'other'].includes(b.kind) ? b.kind : 'rent';
    out.mode = String(b.mode || 'Cash').trim().slice(0, 40) || 'Cash';
    out.reference = String(b.reference || '').trim().slice(0, 120);
    out.forPeriod = /^\d{4}-\d{2}$/.test(String(b.forPeriod || '')) ? b.forPeriod : '';
    out.note = String(b.note || '').slice(0, 500);
    return out;
  }
  app.post('/api/admin/leases/:id/payments', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const p = paymentFrom(req.body || {});
      if (p.amount <= 0) return res.status(400).json({ error: 'Enter the amount received' });
      p.receiptNo = await nextReceiptNo();
      p.recordedByName = byName(req);
      doc.payments.push(p);
      const saved = doc.payments[doc.payments.length - 1];
      addNote(doc, 'payment', `${p.receiptNo}: ${peso(p.amount)} received (${kindLabel(p.kind)}${p.forPeriod ? ', ' + fmtMonth(p.forPeriod) : ''}) via ${p.mode}`, byName(req));
      await doc.save();
      await logAudit(req, 'CREATE', 'LeasePayment', String(saved._id), `${leaseLabel(doc)} · ${p.receiptNo}`, { amount: p.amount, kind: p.kind });
      res.json({ lease: withComputed(doc.toObject()), paymentId: String(saved._id), receiptNo: p.receiptNo });
    } catch (err) { console.error('lease payment error:', err); res.status(500).json({ error: 'Server error' }); }
  });
  app.put('/api/admin/leases/:id/payments/:pid', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const p = doc.payments.id(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Payment not found' });
      const upd = paymentFrom({ ...p.toObject(), ...(req.body || {}) });
      if (upd.amount <= 0) return res.status(400).json({ error: 'Enter the amount received' });
      Object.assign(p, upd);   // receiptNo never changes
      addNote(doc, 'payment', `${p.receiptNo} corrected: now ${peso(p.amount)} (${kindLabel(p.kind)}) via ${p.mode}`, byName(req));
      await doc.save();
      await logAudit(req, 'UPDATE', 'LeasePayment', String(p._id), `${leaseLabel(doc)} · ${p.receiptNo}`, { amount: p.amount });
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('lease payment edit error:', err); res.status(500).json({ error: 'Server error' }); }
  });
  app.delete('/api/admin/leases/:id/payments/:pid', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const p = doc.payments.id(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Payment not found' });
      const label = `${p.receiptNo} (${peso(p.amount)})`;
      doc.payments.pull(p._id);
      doc.files = doc.files.filter(f => f.paymentId !== String(p._id));
      addNote(doc, 'payment', `Payment ${label} removed`, byName(req));
      await doc.save();
      await logAudit(req, 'DELETE', 'LeasePayment', req.params.pid, `${leaseLabel(doc)} · ${label}`, null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── one-off charges (dues, utilities, repairs, penalties) ──
  app.post('/api/admin/leases/:id/charges', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const b = req.body || {};
      const key = dk(b.date) || manilaToday();
      const c = { date: new Date(key + 'T00:00:00Z'), label: String(b.label || '').trim().slice(0, 200), kind: ['dues', 'utilities', 'penalty', 'repair', 'other'].includes(b.kind) ? b.kind : 'other', amount: round2(Math.max(0, Number(String(b.amount ?? 0).replace(/,/g, '')) || 0)), note: String(b.note || '').slice(0, 500) };
      if (!c.label) return res.status(400).json({ error: 'Describe the charge' });
      if (c.amount <= 0) return res.status(400).json({ error: 'Enter the charge amount' });
      doc.charges.push(c);
      addNote(doc, 'system', `Charge added: ${c.label} ${peso(c.amount)}`, byName(req));
      await doc.save();
      await logAudit(req, 'CREATE', 'LeaseCharge', String(doc._id), `${leaseLabel(doc)} · ${c.label}`, { amount: c.amount });
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.delete('/api/admin/leases/:id/charges/:cid', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const c = doc.charges.id(req.params.cid);
      if (!c) return res.status(404).json({ error: 'Charge not found' });
      addNote(doc, 'system', `Charge removed: ${c.label} ${peso(c.amount)}`, byName(req));
      doc.charges.pull(c._id);
      await doc.save();
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── notes ──
  app.post('/api/admin/leases/:id/notes', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Write something first' });
      addNote(doc, 'note', text, byName(req));
      await doc.save();
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── files: contract, IDs, proof of payment (authenticated Cloudinary) ──
  app.post('/api/admin/leases/:id/files', ...manage, uploadAttachment.single('file'), async (req, res) => {
    const tmp = req.file && req.file.path;
    const cleanup = () => { if (tmp && fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch {} };
    try {
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      const doc = await Lease.findById(req.params.id);
      if (!doc) { cleanup(); return res.status(404).json({ error: 'Lease not found' }); }
      const result = await cloudinary.uploader.upload(tmp, { folder: 'glra_realty/leases', resource_type: 'auto', type: 'authenticated' });
      cleanup();
      const paymentId = String(req.body?.paymentId || '');
      doc.files.push({
        publicId: result.public_id, resourceType: result.resource_type || 'image', format: result.format || '', bytes: result.bytes || 0,
        name: String(req.file.originalname || '').slice(0, 200), label: String(req.body?.label || '').trim().slice(0, 120) || (paymentId ? 'Proof of payment' : 'Document'),
        paymentId: /^[a-f0-9]{24}$/i.test(paymentId) ? paymentId : '', uploadedByName: byName(req), uploadedAt: new Date()
      });
      await doc.save();
      await logAudit(req, 'UPLOAD', 'LeaseFile', String(doc._id), `${leaseLabel(doc)} · ${req.file.originalname || ''}`, { size: result.bytes });
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('lease file upload error:', err.message); cleanup(); res.status(500).json({ error: 'Upload failed' }); }
  });
  // Signed, five-minute link — same reasoning as the owner-intake documents:
  // a bearer token cannot ride on a plain <a href>, so the page asks for a
  // link and opens it immediately.
  app.get('/api/admin/leases/:id/files/:fid/link', ...view, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const f = doc.files.id(req.params.fid);
      if (!f) return res.status(404).json({ error: 'File not found' });
      const url = cloudinary.utils.private_download_url(f.publicId, f.format, { resource_type: f.resourceType || 'image', type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 300 });
      res.json({ url, name: f.name, expiresInSeconds: 300 });
    } catch (err) { console.error('lease file link error:', err.message); res.status(500).json({ error: 'Could not open the file' }); }
  });
  app.delete('/api/admin/leases/:id/files/:fid', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const f = doc.files.id(req.params.fid);
      if (!f) return res.status(404).json({ error: 'File not found' });
      try { await cloudinary.uploader.destroy(f.publicId, { resource_type: f.resourceType === 'raw' ? 'raw' : f.resourceType === 'video' ? 'video' : 'image', type: 'authenticated' }); } catch (e) { console.warn('cloudinary destroy failed:', e.message); }
      const name = f.name; doc.files.pull(f._id);
      await doc.save();
      await logAudit(req, 'DELETE', 'LeaseFile', req.params.fid, `${leaseLabel(doc)} · ${name}`, null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── PDFs ──
  app.get('/api/admin/leases/:id/pdf', ...view, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const mode = ['tenant', 'owner', 'full'].includes(req.query.mode) ? req.query.mode : 'full';
      const l = doc.toObject(); const c = computeLease(l);
      const buf = await pdf.leasePdf(l, c, mode, { fmtDate, fmtMonth, peso, kindLabel, stageLabel: s => STAGE_META[s]?.label || s, ordinal });
      const who = (mode === 'owner' ? l.ownerName : l.tenantName) || 'lease';
      sendPdf(res, buf, `GLRA-${mode === 'tenant' ? 'statement' : mode === 'owner' ? 'owner-statement' : 'lease-profile'}-${who}.pdf`, req.query.download === '1');
    } catch (err) { console.error('lease pdf error:', err); res.status(500).json({ error: 'Could not build the PDF' }); }
  });
  app.get('/api/admin/leases/:id/receipt/:pid', ...view, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const p = doc.payments.id(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Payment not found' });
      const l = doc.toObject(); const c = computeLease(l);
      const buf = await pdf.receiptPdf(l, p.toObject(), c, { fmtDate, fmtMonth, peso, kindLabel });
      sendPdf(res, buf, `GLRA-receipt-${p.receiptNo || p._id}.pdf`, req.query.download === '1');
    } catch (err) { console.error('receipt pdf error:', err); res.status(500).json({ error: 'Could not build the PDF' }); }
  });

  // ── emails ──
  app.post('/api/admin/leases/:id/email', ...manage, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const b = req.body || {};
      const kind = String(b.kind || 'custom');
      const to = b.to === 'owner' ? 'owner' : 'tenant';
      const address = to === 'owner' ? doc.ownerEmail : doc.tenantEmail;
      if (!address) return res.status(400).json({ error: `No ${to} email on this lease yet` });
      const l = doc.toObject(); const c = computeLease(l); const settings = await getSettings();
      let payment = null;
      if (kind === 'receipt') { payment = doc.payments.id(String(b.paymentId || '')); if (!payment) return res.status(400).json({ error: 'Pick the payment the receipt is for' }); payment = payment.toObject(); }
      const mail = buildEmail(kind, { lease: l, computed: c, settings, payment, esc, subject: b.subject, message: b.message });
      const attachments = [];
      const attach = b.attach === true || b.attach === 'true';
      const helpers = { fmtDate, fmtMonth, peso, kindLabel, stageLabel: s => STAGE_META[s]?.label || s, ordinal };
      if (kind === 'receipt') attachments.push({ name: `GLRA-receipt-${payment.receiptNo || 'payment'}.pdf`, content: await pdf.receiptPdf(l, payment, c, helpers) });
      else if (kind === 'statement' || (attach && to === 'tenant')) attachments.push({ name: `GLRA-statement-${(l.tenantName || 'tenant').replace(/\s+/g, '-')}.pdf`, content: await pdf.leasePdf(l, c, 'tenant', helpers) });
      else if (kind === 'owner_statement' || (attach && to === 'owner')) attachments.push({ name: `GLRA-owner-statement-${(l.ownerName || 'owner').replace(/\s+/g, '-')}.pdf`, content: await pdf.leasePdf(l, c, 'owner', helpers) });
      const r = await sendEmail(address, mail.subject, mail.html, 'GLRA Realty', null, attachments);
      if (!r || !r.success) return res.status(502).json({ error: 'The email service could not send this message. Check that Brevo is configured on the server.' });
      doc.emailLog.push({ at: new Date(), to: address, kind, subject: mail.subject, auto: false, byName: byName(req) });
      addNote(doc, 'email', `Emailed ${to} (${address}): ${mail.subject}`, byName(req));
      await doc.save();
      await logAudit(req, 'EMAIL', 'Lease', String(doc._id), `${leaseLabel(doc)} · ${kind}`, { to: address });
      res.json({ success: true, lease: withComputed(doc.toObject()) });
    } catch (err) { console.error('lease email error:', err); res.status(500).json({ error: 'Server error' }); }
  });
  // Preview what an email will say before it goes out.
  app.post('/api/admin/leases/:id/email-preview', ...view, async (req, res) => {
    try {
      const doc = await findLease(req, res); if (!doc) return;
      const b = req.body || {}; const l = doc.toObject(); const c = computeLease(l); const settings = await getSettings();
      let payment = null;
      if (b.kind === 'receipt') { const p = doc.payments.id(String(b.paymentId || '')); payment = p ? p.toObject() : { amount: 0, kind: 'rent', receiptNo: '' }; }
      const mail = buildEmail(String(b.kind || 'custom'), { lease: l, computed: c, settings, payment, esc, subject: b.subject, message: b.message });
      res.json({ subject: mail.subject, html: mail.html });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
}

// =============================================================================
// REMINDER ENGINE
// =============================================================================
// Runs every 30 minutes. Everything is idempotent: each reminder has a key in
// lease.reminderKeys and is sent at most once, so a restart mid-day can never
// double-email a tenant. Tenant-facing mail only goes out 08:00-20:00 Manila.
function startLeasingTick({ sendEmail, esc }) {
  async function tick() {
    try {
      const hour = manilaHour();
      if (hour < 7 || hour >= 21) return;
      const today = manilaToday();
      const settings = await getSettings();
      const leases = await Lease.find({ stage: { $in: [...LIVE_STAGES, 'contract'] } });
      const digest = { overdue: [], dueSoon: [], expiring: [], depositsUnpaid: [] };

      for (const doc of leases) {
        try {
          const c = computeLease(doc.toObject(), today);
          const keys = doc.reminderKeys || {};
          let touched = false;
          const mark = k => { keys[k] = today; touched = true; };
          const send = async (kind, extra) => {
            const mail = buildEmail(kind, { lease: doc.toObject(), computed: c, settings, esc, ...extra });
            const r = await sendEmail(doc.tenantEmail, mail.subject, mail.html);
            if (r && r.success) {
              doc.emailLog.push({ at: new Date(), to: doc.tenantEmail, kind, subject: mail.subject, auto: true, byName: 'Reminder engine' });
              addNote(doc, 'email', `Automatic ${kind} email sent to ${doc.tenantEmail}`, 'Reminder engine');
              touched = true;
            }
            return r && r.success;
          };
          const tenantMail = doc.autoEmails !== false && !!doc.tenantEmail && hour >= 8 && hour < 20;

          if (LIVE_STAGES.includes(doc.stage)) {
            // Rent-due reminder, N days ahead.
            const ahead = addDays(today, settings.reminderDays);
            const soon = c.schedule.find(r => r.due === ahead && r.status === 'upcoming');
            if (soon) {
              digest.dueSoon.push({ doc, row: soon });
              const k = `rd:${soon.month}`;
              if (tenantMail && !keys[k] && settings.reminderDays > 0) {
                c.nextDue = { ...soon };
                if (await send('reminder')) mark(k); else mark(k + ':failed');
              }
            }
            // Overdue notice once the grace period lapses, one follow-up a week later.
            const overdueRows = c.schedule.filter(r => r.status === 'overdue');
            if (overdueRows.length) {
              digest.overdue.push({ doc, c });
              if (settings.overdueNotice && tenantMail) {
                const oldest = overdueRows[0];
                const k1 = `od:${oldest.month}`, k2 = `od2:${oldest.month}`;
                if (!keys[k1]) { if (await send('overdue')) mark(k1); else mark(k1 + ':failed'); }
                else if (!keys[k2] && diffDays(keys[k1], today) >= 7) { if (await send('overdue')) mark(k2); else mark(k2 + ':failed'); }
              }
            }
            // Lease ending: alert the broker at each threshold, once.
            if (c.daysToEnd !== null && c.daysToEnd >= 0) {
              const hit = (settings.expiryDays || []).find(n => c.daysToEnd <= n && !keys[`ex:${n}`]);
              if (hit !== undefined) {
                digest.expiring.push({ doc, c, threshold: hit });
                mark(`ex:${hit}`);
              } else if (c.daysToEnd <= Math.max(...(settings.expiryDays || [60]))) digest.expiring.push({ doc, c, threshold: null });
            }
          }
          if (doc.stage === 'contract' && c.deposit.status === 'unpaid' && c.deposit.required > 0) digest.depositsUnpaid.push({ doc, c });

          if (touched) { doc.reminderKeys = keys; doc.markModified('reminderKeys'); await doc.save(); }
        } catch (e) { console.error(`leasing tick failed for lease ${doc._id}:`, e.message); }
      }

      // Morning digest for the broker — only when something needs a decision.
      if (settings.digestEnabled && hour >= settings.digestHour && settings.lastDigestKey !== today) {
        const items = digest.overdue.length + digest.expiring.length + digest.depositsUnpaid.length + digest.dueSoon.length;
        if (items && settings.notifyEmail) {
          const li = arr => `<ul style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.7">${arr.map(s => `<li>${s}</li>`).join('')}</ul>`;
          const h = t => `<h3 style="margin:16px 0 4px;font-size:15px;color:#0a1628">${t}</h3>`;
          const link = `<p style="margin-top:20px"><a href="${SITE_URL}/admin.html" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:12px 24px;text-decoration:none;font-weight:600">Open Leasing</a></p>`;
          let body = `<p style="font-size:15px;color:#333">Here is where the rentals stand this morning (${fmtDate(today)}).</p>`;
          if (digest.overdue.length) body += h(`Overdue rent (${digest.overdue.length})`) + li(digest.overdue.map(({ doc, c }) => `${esc(leaseLabel(doc))}: <strong>${peso(c.overdueAmount)}</strong>, ${c.oldestOverdueDays} days late`));
          if (digest.dueSoon.length) body += h(`Due in ${settings.reminderDays} days`) + li(digest.dueSoon.map(({ doc, row }) => `${esc(leaseLabel(doc))}: ${peso(row.remaining)} on ${fmtDate(row.due)}`));
          if (digest.expiring.length) body += h('Leases ending soon') + li(digest.expiring.map(({ doc, c }) => `${esc(leaseLabel(doc))}: ends ${fmtDate(c.end)} (${c.daysToEnd} days)${doc.renewalDecision ? ` · tenant: ${doc.renewalDecision}` : ' · no renewal decision yet'}`));
          if (digest.depositsUnpaid.length) body += h('Contracts waiting for the deposit') + li(digest.depositsUnpaid.map(({ doc, c }) => `${esc(leaseLabel(doc))}: ${peso(c.deposit.required)} deposit not yet received`));
          sendEmail(settings.notifyEmail, `Leasing this morning: ${digest.overdue.length} overdue · ${digest.expiring.length} ending soon`,
            emailShell(esc, 'Good morning, here is the rent roll', body + link)).catch(err => console.error('leasing digest failed:', err.message));
        }
        await saveSettings({ lastDigestKey: today });
      }
    } catch (e) { console.error('leasing tick error:', e.message); }
  }
  setTimeout(() => { tick(); setInterval(tick, 30 * 60 * 1000); }, 60 * 1000);
}

module.exports = {
  registerLeasingRoutes,
  startLeasingTick,
  computeLease,
  STAGE_META,
  _test: { dk, addDays, addMonths, diffDays, schedule, computeLease, rentRoll, sanitizeLeaseBody, deriveTerms, brokerFeeOf, peso, fmtDate, fmtMonth, buildEmail, DEFAULT_SETTINGS }
};
