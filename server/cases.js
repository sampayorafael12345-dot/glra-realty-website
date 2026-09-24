// =============================================================================
// CASES — law-firm matter management
// =============================================================================
// The server side of the admin "Cases" tab, which replaced Notarial in
// September 2026. One Case document (see caseSchema in ./db.js) carries a
// matter from the intake interview to the entry of judgment.
//
// Two rules shape everything here:
//
//  1. Money is never stored as a running total. What the client owes, what has
//     been received and the balance are recomputed from the charge list plus
//     the payment list on every read (computeCase). Correct one entry and
//     every figure downstream corrects itself. Same discipline as leasing.
//
//  2. Dates are the product. A law practice is destroyed by a missed period,
//     not by a bad argument, so the prescriptive date, the court's deadlines
//     and the hearing calendar are first-class: computed, colour-coded,
//     emailed ahead of time, and pushed to the lawyer's phone calendar.
//
// The deadline presets below carry the rule they come from. They are a
// starting point that fills in a date, NOT legal advice — the UI says so, and
// every date stays editable. Periods change (the 2019 Amendments moved the
// answer from 15 to 30 days; the 2022 Expedited Rules rewrote first-level
// practice), so the citation matters more than the number.
//
// Registered from server.js:
//   const { registerCaseRoutes, startCasesTick } = require('./server/cases');
//   registerCaseRoutes(app, { sendEmail, esc, uploadAttachment, cloudinary });
//   startCasesTick({ sendEmail, esc });
// =============================================================================
const crypto = require('crypto');
const fs = require('fs');
const { Case, Setting, Counter, CASE_STAGES } = require('./db');
const { verifyToken, requireAdmin, requirePermission, logAudit } = require('./auth');
const { getEmailHeader, getEmailFooter } = require('./email-templates');
const pdf = require('./case-pdf');

const FIRM_INBOX = 'glrarealty@gmail.com';

// ── STAGES ───────────────────────────────────────────────────
// One vocabulary that fits civil, criminal, labour and administrative work,
// because a small firm runs all of them off a single board.
const STAGE_META = {
  intake:       { label: 'Intake',        color: '#64748b', hint: 'Engaged. Conflict check and facts.' },
  pre_filing:   { label: 'Pre-filing',    color: '#8b5cf6', hint: 'Demand letter, barangay, drafting.' },
  filed:        { label: 'Filed',         color: '#3b82f6', hint: 'Filed and pending. Summons, answer, prelim investigation.' },
  pre_trial:    { label: 'Pre-trial',     color: '#0ea5e9', hint: 'Pre-trial, mediation, JDR.' },
  trial:        { label: 'Trial',         color: '#f59e0b', hint: 'Hearings and presentation of evidence.' },
  decision:     { label: 'For decision',  color: '#d97706', hint: 'Submitted for decision or promulgation.' },
  post_judgment:{ label: 'Post-judgment', color: '#10b981', hint: 'Appeal, reconsideration, execution.' },
  closed:       { label: 'Closed',        color: '#475569', hint: 'Terminated, settled or fully executed.' },
  on_hold:      { label: 'On hold',       color: '#ef4444', hint: 'Dormant. Client unresponsive or archived.' }
};
const CASE_FLOW = ['intake', 'pre_filing', 'filed', 'pre_trial', 'trial', 'decision', 'post_judgment', 'closed'];
const OPEN_STAGES = ['intake', 'pre_filing', 'filed', 'pre_trial', 'trial', 'decision', 'post_judgment'];

// ── REFERENCE DATA ───────────────────────────────────────────
// Shipped to the browser so the dropdowns are the same everywhere and a typo
// cannot create a second spelling of the same court.
const COURTS = [
  'Supreme Court',
  'Court of Appeals',
  'Sandiganbayan',
  'Court of Tax Appeals',
  'Regional Trial Court (RTC)',
  'RTC - Family Court',
  'RTC - Special Commercial Court',
  'RTC - Environmental Court',
  'RTC - Drugs Court',
  'Metropolitan Trial Court (MeTC)',
  'Municipal Trial Court in Cities (MTCC)',
  'Municipal Trial Court (MTC)',
  'Municipal Circuit Trial Court (MCTC)',
  "Shari'a District Court",
  "Shari'a Circuit Court",
  'Office of the City/Provincial Prosecutor',
  'Department of Justice',
  'Office of the Ombudsman',
  'NLRC',
  'DOLE Regional Office',
  'NCMB',
  'DHSUD / HSAC',
  'Securities and Exchange Commission',
  'DARAB',
  'Bureau of Internal Revenue',
  'Land Registration Authority',
  'Civil Service Commission',
  'Barangay (Lupong Tagapamayapa)',
  'Arbitration / Mediation',
  'Other'
];

const CASE_TYPES = [
  { key: 'civil',        label: 'Civil' },
  { key: 'criminal',     label: 'Criminal' },
  { key: 'labor',        label: 'Labour' },
  { key: 'family',       label: 'Family' },
  { key: 'special_proc', label: 'Special proceedings' },
  { key: 'land',         label: 'Land / registration' },
  { key: 'corporate',    label: 'Corporate / commercial' },
  { key: 'admin',        label: 'Administrative' },
  { key: 'tax',          label: 'Tax' },
  { key: 'appeal',       label: 'Appeal' },
  { key: 'other',        label: 'Other' }
];

// Suggestions only. The field is free text, because the nature of an action is
// whatever the pleading actually says.
const NATURES = {
  civil:        ['Sum of Money', 'Collection of Sum of Money', 'Breach of Contract', 'Damages', 'Specific Performance',
                 'Unlawful Detainer (Ejectment)', 'Forcible Entry', 'Quieting of Title', 'Recovery of Possession (Accion Publiciana)',
                 'Reconveyance', 'Partition', 'Annulment of Deed', 'Foreclosure of Mortgage', 'Replevin',
                 'Small Claims', 'Injunction', 'Consignation', 'Interpleader'],
  criminal:     ['Estafa (Art. 315)', 'Qualified Theft', 'Theft', 'BP 22 (Bouncing Checks)', 'Violation of RA 9262 (VAWC)',
                 'Physical Injuries', 'Grave Threats', 'Grave Oral Defamation', 'Libel / Cyber Libel', 'Falsification',
                 'Violation of RA 9165 (Drugs)', 'Reckless Imprudence', 'Homicide', 'Murder', 'Rape', 'Frustrated Homicide',
                 'Malicious Mischief', 'Trespass to Dwelling', 'Robbery', 'Carnapping'],
  labor:        ['Illegal Dismissal', 'Money Claims', 'Non-payment of Wages / Benefits', 'Constructive Dismissal',
                 'Illegal Suspension', 'Regularization', 'Unfair Labour Practice', 'SEnA Request for Assistance',
                 'Claim for Separation Pay', '13th Month Pay Claim'],
  family:       ['Declaration of Nullity of Marriage (Art. 36)', 'Annulment of Marriage', 'Legal Separation',
                 'Petition for Support', 'Custody of Minors', 'Adoption', 'Recognition of Foreign Divorce',
                 'Protection Order (RA 9262)', 'Petition for Guardianship'],
  special_proc: ['Settlement of Estate (Intestate)', 'Probate of Will (Testate)', 'Petition for Letters of Administration',
                 'Correction of Entries (RA 9048 / Rule 108)', 'Change of Name', 'Petition for Declaration of Presumptive Death',
                 'Habeas Corpus', 'Escheat', 'Judicial Partition of Estate'],
  land:         ['Original Registration of Title', 'Petition for Reconstitution of Title', 'Cancellation of Adverse Claim',
                 'Cancellation of Lis Pendens', 'Petition for Issuance of Owner’s Duplicate', 'Land Dispute (DARAB)',
                 'Expropriation', 'Easement / Right of Way'],
  corporate:    ['Intra-corporate Dispute', 'Corporate Rehabilitation', 'Involuntary Insolvency', 'Dissolution',
                 'Injunction against Corporate Act', 'SEC Compliance Matter', 'Trademark Infringement', 'Copyright Infringement'],
  admin:        ['Administrative Complaint', 'Ombudsman Complaint', 'Civil Service Case', 'Licence / Permit Dispute',
                 'HSAC / DHSUD Complaint', 'Barangay Conciliation'],
  tax:          ['Protest of Assessment', 'Claim for Refund', 'Petition for Review (CTA)', 'Local Tax Assessment'],
  appeal:       ['Appeal to RTC', 'Petition for Review (Rule 42)', 'Petition for Review (Rule 43)',
                 'Petition for Review on Certiorari (Rule 45)', 'Petition for Certiorari (Rule 65)', 'Ordinary Appeal (Rule 41)'],
  other:        ['Legal Opinion', 'Contract Review', 'Document Preparation', 'Notarial', 'Corporate Retainer', 'Demand Letter']
};

const CLIENT_ROLES = ['Plaintiff', 'Defendant', 'Complainant', 'Respondent', 'Accused', 'Private Complainant',
                      'Petitioner', 'Oppositor', 'Appellant', 'Appellee', 'Third-party Claimant',
                      'Intervenor', 'Movant', 'Heir', 'Applicant', 'Counsel of Record'];

const HEARING_PURPOSES = ['Arraignment', 'Pre-trial', 'Preliminary Conference', 'Court-Annexed Mediation',
  'Judicial Dispute Resolution (JDR)', 'Presentation of Plaintiff’s Evidence', 'Presentation of Defence Evidence',
  'Presentation of Prosecution Evidence', 'Cross-examination', 'Hearing on Motion', 'Clarificatory Hearing',
  'Preliminary Investigation', 'Mandatory Conference', 'Promulgation of Judgment', 'Ocular Inspection',
  'Ex-parte Presentation of Evidence', 'Bail Hearing', 'Continuation of Trial'];

const FEE_ARRANGEMENTS = [
  { key: 'acceptance_appearance', label: 'Acceptance + appearance fee' },
  { key: 'retainer',              label: 'Monthly retainer' },
  { key: 'hourly',                label: 'Hourly' },
  { key: 'fixed',                 label: 'Fixed / package fee' },
  { key: 'contingency',           label: 'Contingency (% of recovery)' },
  { key: 'pro_bono',              label: 'Pro bono' }
];

const CHARGE_KINDS = [
  { key: 'acceptance',   label: 'Acceptance fee' },
  { key: 'appearance',   label: 'Appearance fee' },
  { key: 'professional', label: 'Professional fee' },
  { key: 'retainer',     label: 'Retainer' },
  { key: 'filing_fee',   label: 'Filing / docket fee' },
  { key: 'sheriff',      label: 'Sheriff / service fee' },
  { key: 'transcript',   label: 'Transcript (TSN)' },
  { key: 'notarial',     label: 'Notarial' },
  { key: 'travel',       label: 'Travel / per diem' },
  { key: 'publication',  label: 'Publication' },
  { key: 'expert',       label: 'Expert / commissioner' },
  { key: 'misc',         label: 'Miscellaneous' }
];

// Deadline presets. `days` counts CALENDAR days from the trigger date.
// Each one names its source so it can be checked rather than trusted.
const DEADLINE_RULES = [
  { key: 'answer_ordinary',  label: 'Answer (ordinary civil action)', days: 30, from: 'service of summons',
    rule: 'Rule 11 §1, as amended by the 2019 Amendments (A.M. 19-10-20-SC)', critical: true },
  { key: 'answer_summary',   label: 'Answer (summary procedure / ejectment)', days: 30, from: 'service of summons',
    rule: '2022 Rules on Expedited Procedures in the First Level Courts (A.M. 08-8-7-SC)', critical: true },
  { key: 'response_small',   label: 'Response (small claims)', days: 10, from: 'receipt of summons',
    rule: 'A.M. 08-8-7-SC — non-extendible', critical: true },
  { key: 'answer_counter',   label: 'Answer to counterclaim / cross-claim', days: 20, from: 'service',
    rule: 'Rule 11 §4', critical: true },
  { key: 'reply',            label: 'Reply', days: 15, from: 'service of the answer',
    rule: 'Rule 11 §6', critical: false },
  { key: 'pretrial_brief',   label: 'Pre-trial brief', days: -3, from: 'the pre-trial date',
    rule: 'Rule 18 §6 — at least 3 calendar days BEFORE pre-trial', critical: true },
  { key: 'judicial_aff',     label: 'Judicial affidavits', days: -5, from: 'the hearing date',
    rule: 'Judicial Affidavit Rule §2 — at least 5 days BEFORE', critical: true },
  { key: 'mr_new_trial',     label: 'Motion for reconsideration / new trial', days: 15, from: 'notice of the judgment',
    rule: 'Rule 37 §1', critical: true },
  { key: 'notice_appeal',    label: 'Notice of appeal', days: 15, from: 'notice of the judgment',
    rule: 'Rule 41 §3', critical: true },
  { key: 'rule42',           label: 'Petition for review (Rule 42, RTC → CA)', days: 15, from: 'notice of the decision',
    rule: 'Rule 42 §1', critical: true },
  { key: 'rule43',           label: 'Petition for review (Rule 43, quasi-judicial → CA)', days: 15, from: 'notice of the decision',
    rule: 'Rule 43 §4', critical: true },
  { key: 'rule45',           label: 'Petition for review on certiorari (Rule 45 → SC)', days: 15, from: 'notice of the decision',
    rule: 'Rule 45 §2', critical: true },
  { key: 'rule65',           label: 'Petition for certiorari (Rule 65)', days: 60, from: 'notice of the ruling',
    rule: 'Rule 65 §4', critical: true },
  { key: 'counter_affidavit',label: 'Counter-affidavit (preliminary investigation)', days: 10, from: 'receipt of the subpoena',
    rule: 'Rule 112 §3(b)', critical: true },
  { key: 'doj_petition',     label: 'Petition for review to the DOJ', days: 15, from: 'receipt of the resolution',
    rule: 'DOJ rules on appeal', critical: true },
  { key: 'nlrc_appeal',      label: 'Appeal to the NLRC (from the Labour Arbiter)', days: 10, from: 'receipt of the decision',
    rule: 'Labour Code Art. 229 — calendar days', critical: true },
  { key: 'nlrc_mr',          label: 'Motion for reconsideration (NLRC)', days: 10, from: 'receipt of the decision',
    rule: '2011 NLRC Rules of Procedure', critical: true },
  { key: 'position_paper',   label: 'Position paper', days: 10, from: 'the mandatory conference',
    rule: 'set by the Labour Arbiter — confirm the order', critical: true },
  { key: 'custom',           label: 'Other (set the date yourself)', days: 0, from: '', rule: '', critical: false }
];

// ── DATE HELPERS ─────────────────────────────────────────────
// Every date here is a calendar day, not a moment: stored as UTC midnight and
// handled as 'YYYY-MM-DD' so a server in UTC and a browser in Manila agree.
const pad2 = n => String(n).padStart(2, '0');
function dk(d) {
  if (!d) return '';
  if (typeof d === 'string') return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : dk(new Date(d));
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return '';
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
}
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  x.setUTCDate(x.getUTCDate() + n);
  return dk(x);
}
function diffDays(a, b) {          // b - a, in whole days
  if (!a || !b) return null;
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
// The firm works Manila time; the server may not. Fixed +8, no DST in PH.
function manilaToday() {
  return dk(new Date(Date.now() + 8 * 3600 * 1000));
}
function manilaHour() {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
}
const money = v => Math.round((Number(v) || 0) * 100) / 100;
function peso(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-' : '') + '₱' + abs;
}

// ── THE CALCULATION ──────────────────────────────────────────
// Everything the UI shows about a case is derived here, from the stored lists.
// Nothing below is written back to the document.
function computeCase(c, today) {
  today = today || manilaToday();

  // ── money ──
  const charges = (c.charges || []).map(ch => ({
    id: String(ch._id || ''), kind: ch.kind || 'misc', label: ch.label || '',
    amount: money(ch.amount), date: dk(ch.date), reimbursable: !!ch.reimbursable, notes: ch.notes || ''
  })).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  const payments = (c.payments || []).map(p => ({
    id: String(p._id || ''), date: dk(p.date), amount: money(p.amount), mode: p.mode || 'Cash',
    reference: p.reference || '', label: p.label || '', receiptNo: p.receiptNo || '', notes: p.notes || ''
  })).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  const billed = money(charges.reduce((s, x) => s + x.amount, 0));
  const paid = money(payments.reduce((s, x) => s + x.amount, 0));
  const balance = money(billed - paid);
  const disbursements = money(charges.filter(x => x.reimbursable).reduce((s, x) => s + x.amount, 0));

  // ── hearings ──
  const hearings = (c.hearings || []).map(h => ({
    id: String(h._id || ''), date: dk(h.date), time: h.time || '', purpose: h.purpose || '',
    venue: h.venue || '', appearedBy: h.appearedBy || '', result: h.result || '',
    reset: !!h.reset, billed: !!h.billed, notified: !!h.notified,
    past: !!dk(h.date) && dk(h.date) < today,
    daysAway: dk(h.date) ? diffDays(today, dk(h.date)) : null
  })).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  const upcoming = hearings.filter(h => h.date && h.date >= today && !h.reset);
  const nextHearing = upcoming[0] || null;
  // The latest hearing that has been held but has nothing written down about
  // it (within 60 days): the court diary asks for it until someone records
  // what happened and when the case was reset to.
  const pendingResult = hearings.filter(h => h.past && !h.reset && !h.result && h.daysAway >= -60).slice(-1)[0] || null;
  // An appearance fee is earned by turning up, so only a past, non-reset
  // hearing counts — and only once.
  const attended = hearings.filter(h => h.past && !h.reset);
  const unbilledAppearances = attended.filter(h => !h.billed).length;
  const appearanceFee = money(c.appearanceFee);
  const unbilledAppearanceValue = money(unbilledAppearances * appearanceFee);

  // ── deadlines ──
  const deadlines = (c.deadlines || []).map(d => {
    const due = dk(d.dueDate);
    const days = due ? diffDays(today, due) : null;
    let status = 'open';
    if (d.done) status = 'done';
    else if (days === null) status = 'nodate';
    else if (days < 0) status = 'missed';
    else if (days === 0) status = 'today';
    else if (days <= 3) status = 'urgent';
    else if (days <= 7) status = 'soon';
    return {
      id: String(d._id || ''), title: d.title || '', dueDate: due, rule: d.rule || '',
      critical: !!d.critical, done: !!d.done, doneDate: dk(d.doneDate), doneBy: d.doneBy || '',
      notes: d.notes || '', daysAway: days, status
    };
  }).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  });
  const openDeadlines = deadlines.filter(d => !d.done);
  const missedDeadlines = openDeadlines.filter(d => d.status === 'missed');
  const dueSoon = openDeadlines.filter(d => ['today', 'urgent', 'soon'].includes(d.status));
  const nextDeadline = openDeadlines.find(d => d.dueDate) || null;

  // ── prescription: the last day the action can be brought ──
  const presc = dk(c.prescriptiveDate);
  let prescription = null;
  if (presc) {
    const days = diffDays(today, presc);
    prescription = {
      date: presc, daysLeft: days,
      status: days < 0 ? 'lapsed' : days <= 30 ? 'critical' : days <= 90 ? 'warning' : 'ok'
    };
  }

  // ── time ──
  const timeEntries = (c.timeEntries || []).map(t => ({
    id: String(t._id || ''), date: dk(t.date), description: t.description || '',
    hours: Number(t.hours) || 0, rate: money(t.rate), billable: t.billable !== false,
    billed: !!t.billed, by: t.by || '',
    value: money((Number(t.hours) || 0) * (money(t.rate) || money(c.hourlyRate)))
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const hoursTotal = Math.round(timeEntries.reduce((s, t) => s + t.hours, 0) * 100) / 100;
  const unbilledTime = money(timeEntries.filter(t => t.billable && !t.billed).reduce((s, t) => s + t.value, 0));

  // ── the file ──
  const filings = (c.filings || []).map(f => ({
    id: String(f._id || ''), title: f.title || '', direction: f.direction || 'filed',
    date: dk(f.date), mode: f.mode || '', by: f.by || '', notes: f.notes || ''
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const open = OPEN_STAGES.includes(c.stage);
  const engaged = dk(c.dateEngaged);
  const filed = dk(c.dateFiled);
  const ageDays = engaged ? diffDays(engaged, today) : null;
  const pendingDays = filed ? diffDays(filed, today) : null;

  // Last time anything at all happened, used to surface forgotten matters.
  const stamps = [dk(c.updatedAt), ...hearings.map(h => h.date).filter(h => h <= today),
                  ...filings.map(f => f.date), ...payments.map(p => p.date)].filter(Boolean);
  const lastActivity = stamps.sort().slice(-1)[0] || dk(c.createdAt);
  const idleDays = lastActivity ? diffDays(lastActivity, today) : null;

  const files = c.files || [];
  return {
    today, open,
    charges, payments, billed, paid, balance, disbursements,
    hearings, nextHearing, upcomingCount: upcoming.length, pendingResult,
    fileCount: files.length,
    photoCount: files.filter(f => (f.resourceType || 'image') === 'image' && !/^pdf$/i.test(f.format || '')).length,
    fileBytes: files.reduce((s, f) => s + (Number(f.bytes) || 0), 0),
    attendedCount: attended.length, unbilledAppearances, unbilledAppearanceValue,
    deadlines, openDeadlineCount: openDeadlines.length,
    missedCount: missedDeadlines.length, dueSoonCount: dueSoon.length, nextDeadline,
    criticalOpen: openDeadlines.filter(d => d.critical).length,
    prescription, timeEntries, hoursTotal, unbilledTime, filings,
    ageDays, pendingDays, lastActivity, idleDays,
    // One number the board card can colour on: how loud is this case right now.
    heat: (missedDeadlines.length * 100) + (dueSoon.length * 10) +
          (prescription && prescription.status === 'critical' ? 50 : 0) +
          (prescription && prescription.status === 'lapsed' ? 200 : 0)
  };
}

// ── SETTINGS ─────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  hearingReminderDays: 3,        // tell the client this many days ahead
  deadlineAlertDays: 7,          // tell the firm this many days ahead
  prescriptionAlertDays: 90,     // start shouting this far from prescription
  idleAlertDays: 45,             // a matter with no activity for this long
  digestEnabled: true,
  digestHour: 7,                 // Manila time — before the courts open
  notifyEmail: FIRM_INBOX,
  firmName: '',                  // blank = the page falls back to a neutral heading
  firmAddress: '',
  firmContact: '',
  clientEmailsEnabled: true,
  calToken: '',
  lastDigestKey: ''
};

async function getSettings() {
  const doc = await Setting.findOne({ key: 'cases' }).lean();
  return { ...DEFAULT_SETTINGS, ...((doc && doc.value) || {}) };
}
async function saveSettings(next) {
  await Setting.findOneAndUpdate({ key: 'cases' }, { $set: { value: next } }, { upsert: true });
  return next;
}

// ── FILE NUMBERS ─────────────────────────────────────────────
// C-2026-0001 for a case file, LO-2026-0001 for an acknowledgement receipt.
// Atomic, so two people opening a case at once cannot land on one number.
//
// The receipt series is deliberately NOT the leasing "AR-" series: the law
// office is a separate business sharing this dashboard, so it keeps its own
// receipt book. Identical numbers in two businesses would be ambiguous in the
// audit log, so the prefix differs rather than the counter alone.
//
// Counter documents key on `key`, not `_id` (see counterSchema in ./db.js).
async function nextRef(prefix, year) {
  const key = `cases_${prefix}_${year}`;
  const doc = await Counter.findOneAndUpdate(
    { key }, { $inc: { seq: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return `${prefix}-${year}-${String(doc.seq).padStart(4, '0')}`;
}

// ── SANITISER ────────────────────────────────────────────────
// Everything that can be written by the browser passes through here. The
// stage is deliberately NOT accepted on edit: it only moves through /stage,
// so the history entry and the side effects always happen.
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
const dateOrNull = v => { const k = dk(v); return k ? new Date(k + 'T00:00:00.000Z') : null; };

// Field name -> how to clean it. Anything not listed here can never be written
// by a browser, which is what keeps caseRef, history, reminderKeys and the
// conflict-check stamps out of reach.
const CASE_FIELDS = {
  title:           v => str(v, 400),
  docketNumber:    v => str(v, 120),
  court:           v => str(v, 200),
  branch:          v => str(v, 120),
  courtCity:       v => str(v, 160),
  judge:           v => str(v, 200),
  caseType:        v => str(v, 60),
  natureOfAction:  v => str(v, 300),
  priority:        v => ['normal', 'high', 'urgent'].includes(v) ? v : 'normal',
  clientName:      v => str(v, 250),
  clientPhone:     v => str(v, 50),
  clientEmail:     v => str(v, 120).toLowerCase(),
  clientAddress:   v => str(v, 400),
  clientKind:      v => ['', 'individual', 'company', 'government'].includes(v) ? v : '',
  clientRole:      v => str(v, 80),
  account:         v => str(v, 200),
  leadCounsel:     v => str(v, 200),
  collaborating:   v => str(v, 300),
  dateEngaged:     dateOrNull,
  dateFiled:       dateOrNull,
  prescriptiveDate: dateOrNull,
  dateClosed:      dateOrNull,
  outcome:         v => str(v, 300),
  barangayRequired: v => !!v,
  barangayName:    v => str(v, 200),
  cfaIssued:       v => !!v,
  cfaDate:         dateOrNull,
  feeArrangement:  v => str(v, 40),
  acceptanceFee:   num,
  appearanceFee:   num,
  retainerAmount:  num,
  hourlyRate:      num,
  contingencyPct:  num,
  summary:         v => str(v, 8000),
  conflictNotes:   v => str(v, 2000),
  autoEmails:      v => v !== false,
  adverseParties:  v => !Array.isArray(v) ? [] : v.slice(0, 20).map(p => ({
    name: str(p && p.name, 250), role: str(p && p.role, 80),
    counsel: str(p && p.counsel, 250), contact: str(p && p.contact, 200)
  })).filter(p => p.name || p.counsel)
};

// PARTIAL on purpose: only keys the caller actually sent are returned, so a
// small form that edits one field cannot blank the rest of the file. `stage`
// is accepted on create only — everywhere else it moves through /stage, which
// is what writes the history entry.
function sanitizeCaseBody(b, { allowStage = false } = {}) {
  const src = b || {};
  const out = {};
  for (const [k, clean] of Object.entries(CASE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = clean(src[k]);
  }
  if (allowStage && CASE_STAGES.includes(src.stage)) out.stage = src.stage;
  return out;
}

const byName = req => (req.user && (req.user.name || req.user.email)) || '';
const caseLabel = c => [c.caseRef, c.title].filter(Boolean).join(' \u00b7 ') || 'Case';

function withComputed(obj) {
  return { ...obj, computed: computeCase(obj) };
}

// ── EMAILS ───────────────────────────────────────────────────
// A case email goes to a client about their own matter, so it never carries
// figures from anyone else's file and never names the other side's counsel
// beyond what is already on the record.
function buildEmail(kind, c, comp, settings, extra = {}) {
  const esc = extra.esc || (x => String(x == null ? '' : x));
  const firm = settings.firmName || 'our office';
  const who = c.clientName || 'Sir/Madam';
  const matter = [c.title, c.docketNumber].filter(Boolean).join(' \u2014 ');
  const court = [c.court, c.branch && ('Branch ' + c.branch), c.courtCity].filter(Boolean).join(', ');
  const fd = k => {
    if (!k) return '';
    const [y, m, d] = k.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH',
      { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  };
  const sign = `<p style="margin:22px 0 0">Very truly yours,<br><b>${esc(firm)}</b>` +
    (settings.firmContact ? `<br>${esc(settings.firmContact)}` : '') + '</p>';

  let subject = '', body = '';
  if (kind === 'hearing') {
    const h = extra.hearing || comp.nextHearing || {};
    subject = `Hearing on ${fd(h.date)} \u2014 ${c.title || 'your case'}`;
    body = `<p>Dear ${esc(who)},</p>
      <p>This is to remind you of the setting in your case:</p>
      <table style="border-collapse:collapse;margin:14px 0">
        <tr><td style="padding:4px 14px 4px 0;color:#667"><b>Case</b></td><td style="padding:4px 0">${esc(matter)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#667"><b>Date</b></td><td style="padding:4px 0"><b>${fd(h.date)}</b>${h.time ? ' at ' + esc(h.time) : ''}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#667"><b>Purpose</b></td><td style="padding:4px 0">${esc(h.purpose || 'Hearing')}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#667"><b>Court</b></td><td style="padding:4px 0">${esc(court || 'To be advised')}</td></tr>
        ${h.venue ? `<tr><td style="padding:4px 14px 4px 0;color:#667"><b>Venue</b></td><td style="padding:4px 0">${esc(h.venue)}</td></tr>` : ''}
      </table>
      <p>Please be at the court at least thirty minutes early and bring a valid ID. If you cannot attend, tell us as soon as possible so we can inform the court.</p>`;
  } else if (kind === 'statement') {
    subject = `Statement of account \u2014 ${c.title || 'your case'}`;
    body = `<p>Dear ${esc(who)},</p>
      <p>Attached is the statement of account for ${esc(matter || 'your matter')}.</p>
      <table style="border-collapse:collapse;margin:14px 0">
        <tr><td style="padding:4px 14px 4px 0;color:#667">Total billed</td><td style="padding:4px 0;text-align:right">${peso(comp.billed)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#667">Payments received</td><td style="padding:4px 0;text-align:right">${peso(comp.paid)}</td></tr>
        <tr><td style="padding:6px 14px 4px 0;border-top:2px solid #111"><b>Balance</b></td><td style="padding:6px 0 4px;text-align:right;border-top:2px solid #111"><b>${peso(comp.balance)}</b></td></tr>
      </table>`;
  } else if (kind === 'receipt') {
    const p = extra.payment || {};
    subject = `Acknowledgement receipt ${p.receiptNo || ''} \u2014 ${c.title || ''}`.trim();
    body = `<p>Dear ${esc(who)},</p>
      <p>We acknowledge receipt of <b>${peso(p.amount)}</b> on ${fd(p.date)} for ${esc(matter || 'your matter')}.</p>
      <p>The acknowledgement receipt is attached. Your remaining balance is <b>${peso(comp.balance)}</b>.</p>`;
  } else if (kind === 'update') {
    subject = `Update on ${c.title || 'your case'}`;
    body = `<p>Dear ${esc(who)},</p><p>${esc(extra.message || '').replace(/\n/g, '<br>')}</p>`;
  } else if (kind === 'engagement') {
    subject = `We have opened your file \u2014 ${c.title || ''}`.trim();
    body = `<p>Dear ${esc(who)},</p>
      <p>We have opened a file for ${esc(matter || 'your matter')}${c.caseRef ? ` under our reference <b>${esc(c.caseRef)}</b>` : ''}.</p>
      ${c.leadCounsel ? `<p>The lawyer handling it is <b>${esc(c.leadCounsel)}</b>.</p>` : ''}
      <p>Please keep this reference when you write or call. Anything you tell us about this matter is covered by lawyer-client confidentiality.</p>`;
  } else {
    subject = str(extra.subject, 200) || `Regarding ${c.title || 'your case'}`;
    body = `<p>Dear ${esc(who)},</p><p>${esc(extra.message || '').replace(/\n/g, '<br>')}</p>`;
  }
  const html = getEmailHeader() + body + sign + getEmailFooter();
  return { subject, html };
}

// ── ICS ──────────────────────────────────────────────────────
const icsEsc = t => String(t || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
function vevent({ uid, dateStr, summary, description, alarmDays }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = addDays(dateStr, 1);
  const out = ['BEGIN:VEVENT', `UID:${uid}@glrarealty.com`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateStr.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${end.replace(/-/g, '')}`,
    `SUMMARY:${icsEsc(summary)}`];
  if (description) out.push(`DESCRIPTION:${icsEsc(description)}`);
  if (alarmDays) out.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-P${alarmDays}D`,
    `DESCRIPTION:${icsEsc(summary)}`, 'END:VALARM');
  out.push('END:VEVENT');
  return out.join('\r\n');
}

// Photos are stored at most 2400 px on the long side, as a JPEG compressed by
// Cloudinary ("quality auto:good"), even when a browser could not shrink them
// first (an iPhone HEIC, an old phone). PDFs and office files are untouched.
function shrinkOnUpload(mime) {
  return /^image\/(jpeg|pjpeg|png|webp|heic|heif)$/i.test(String(mime || ''))
    ? { transformation: [{ width: 2400, height: 2400, crop: 'limit' }, { quality: 'auto:good' }], format: 'jpg' }
    : {};
}
const FILE_CATEGORIES = ['photo', 'pleading', 'order', 'evidence', 'id', 'receipt', 'letter', 'other'];

// ── ROUTES ───────────────────────────────────────────────────
function registerCaseRoutes(app, { sendEmail, esc, uploadAttachment, cloudinary }) {
  const view = [verifyToken, requirePermission('cases_view')];
  const manage = [verifyToken, requirePermission('cases_manage')];

  async function findCase(req, res) {
    if (!/^[a-f0-9]{24}$/i.test(String(req.params.id || ''))) { res.status(400).json({ error: 'Invalid id' }); return null; }
    const doc = await Case.findById(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Case not found' }); return null; }
    return doc;
  }
  function touch(doc, what, req) {
    doc.history = doc.history || [];
    doc.history.push({ at: new Date(), what: String(what).slice(0, 500), byName: byName(req) });
    if (doc.history.length > 400) doc.history = doc.history.slice(-400);
  }

  // ── list ──
  app.get('/api/admin/cases', ...view, async (req, res) => {
    try {
      const today = manilaToday();
      const settings = await getSettings();
      const docs = await Case.find({}).sort({ updatedAt: -1 }).lean();
      const cases = docs.map(c => ({ ...c, computed: computeCase(c, today) }));
      const { calToken, ...safeSettings } = settings;
      res.json({
        today, stages: STAGE_META, flow: CASE_FLOW,
        ref: { courts: COURTS, caseTypes: CASE_TYPES, natures: NATURES, clientRoles: CLIENT_ROLES,
               hearingPurposes: HEARING_PURPOSES, feeArrangements: FEE_ARRANGEMENTS,
               chargeKinds: CHARGE_KINDS, deadlineRules: DEADLINE_RULES },
        settings: { ...safeSettings, calendarLinked: !!calToken },
        cases
      });
    } catch (err) { console.error('cases list error:', err.message); res.status(500).json({ error: 'Server error' }); }
  });

  // ── conflict check ──
  // Before taking a client the firm has to know whether that name already
  // appears on the other side of an open matter. Searches both sides.
  app.get('/api/admin/cases/conflict-check', ...view, async (req, res) => {
    try {
      const q = str(req.query.q, 120);
      if (q.length < 2) return res.json({ query: q, hits: [] });
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const docs = await Case.find({
        $or: [{ clientName: rx }, { 'adverseParties.name': rx }, { 'adverseParties.counsel': rx }, { title: rx }]
      }).select('caseRef title stage clientName clientRole adverseParties createdAt').lean();
      const hits = docs.map(c => {
        const asClient = rx.test(c.clientName || '');
        const adverse = (c.adverseParties || []).filter(p => rx.test(p.name || '') || rx.test(p.counsel || ''));
        return {
          id: String(c._id), caseRef: c.caseRef, title: c.title, stage: c.stage,
          clientName: c.clientName, clientRole: c.clientRole,
          matchedAs: asClient ? 'client' : (adverse.length ? 'adverse party' : 'case title'),
          adverse: adverse.map(p => p.name || p.counsel),
          open: OPEN_STAGES.includes(c.stage)
        };
      });
      // An existing CLIENT is a soft hit; an ADVERSE party in an open matter
      // is the one that stops a new engagement.
      hits.sort((a, b) => (b.matchedAs === 'adverse party') - (a.matchedAs === 'adverse party'));
      res.json({ query: q, hits, blocking: hits.some(h => h.matchedAs === 'adverse party' && h.open) });
    } catch (err) { console.error('conflict check error:', err.message); res.status(500).json({ error: 'Server error' }); }
  });

  // ── calendar (hearings + deadlines across every case) ──
  app.get('/api/admin/cases/calendar', ...view, async (req, res) => {
    try {
      const today = manilaToday();
      const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 60));
      const until = addDays(today, days);
      const docs = await Case.find({ stage: { $in: OPEN_STAGES } }).lean();
      const items = [];
      docs.forEach(c => {
        const comp = computeCase(c, today);
        comp.hearings.forEach(h => {
          if (!h.date || h.reset || h.date < today || h.date > until) return;
          items.push({ kind: 'hearing', date: h.date, time: h.time, title: h.purpose || 'Hearing',
            caseId: String(c._id), caseRef: c.caseRef, caseTitle: c.title,
            court: [c.court, c.branch && ('Br. ' + c.branch)].filter(Boolean).join(' '),
            client: c.clientName, daysAway: h.daysAway });
        });
        comp.deadlines.forEach(d => {
          if (d.done || !d.dueDate || d.dueDate > until) return;
          items.push({ kind: 'deadline', date: d.dueDate, title: d.title, rule: d.rule,
            critical: d.critical, status: d.status, caseId: String(c._id), caseRef: c.caseRef,
            caseTitle: c.title, client: c.clientName, daysAway: d.daysAway });
        });
        if (comp.prescription && comp.prescription.date <= until && comp.prescription.daysLeft >= -30) {
          items.push({ kind: 'prescription', date: comp.prescription.date, title: 'Prescriptive period lapses',
            critical: true, status: comp.prescription.status, caseId: String(c._id), caseRef: c.caseRef,
            caseTitle: c.title, client: c.clientName, daysAway: comp.prescription.daysLeft });
        }
      });
      items.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
      res.json({ today, until, items });
    } catch (err) { console.error('cases calendar error:', err.message); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/admin/cases/docket.pdf', ...view, async (req, res) => {
    try {
      const today = manilaToday();
      const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 30));
      const settings = await getSettings();
      const docs = await Case.find({ stage: { $in: OPEN_STAGES } }).lean();
      const rows = [];
      docs.forEach(c => {
        const comp = computeCase(c, today);
        comp.hearings.forEach(h => {
          if (!h.date || h.reset || h.date < today || h.date > addDays(today, days)) return;
          rows.push({ date: h.date, time: h.time, purpose: h.purpose, caseRef: c.caseRef, title: c.title,
            docket: c.docketNumber, court: [c.court, c.branch && ('Br. ' + c.branch)].filter(Boolean).join(' '),
            client: c.clientName, counsel: c.leadCounsel });
        });
      });
      rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
      const buf = await pdf.docketPdf({ today, days, rows }, settings);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="court-diary-${today}.pdf"`);
      res.send(buf);
    } catch (err) { console.error('docket pdf error:', err); res.status(500).json({ error: 'Could not build the diary' }); }
  });

  // ── Cloudinary storage ──
  // The account's own usage report (plan, credits, storage, bandwidth), kept
  // for ten minutes: Cloudinary limits how often the Admin API may be asked.
  let usageCache = { at: 0, body: null };
  app.get('/api/admin/cases/storage', ...view, async (req, res) => {
    try {
      const agg = await Case.aggregate([{ $unwind: '$files' },
        { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: { $ifNull: ['$files.bytes', 0] } } } }]);
      const cases = { files: agg[0] ? agg[0].n : 0, bytes: agg[0] ? agg[0].bytes : 0 };
      if (!usageCache.body || Date.now() - usageCache.at > 10 * 60 * 1000) {
        const u = await cloudinary.api.usage();
        const part = x => (x && typeof x === 'object') ? { usage: Number(x.usage) || 0, limit: Number(x.limit) || 0, pct: Number(x.used_percent) || 0, credits: Number(x.credits_usage) || 0 } : null;
        usageCache = { at: Date.now(), body: {
          plan: u.plan || '', lastUpdated: u.last_updated || '',
          credits: part(u.credits), storage: part(u.storage), bandwidth: part(u.bandwidth),
          transformations: part(u.transformations), objects: part(u.objects),
          maxImageBytes: (u.media_limits && Number(u.media_limits.image_max_size_bytes)) || 0,
          maxRawBytes: (u.media_limits && Number(u.media_limits.raw_max_size_bytes)) || 0
        } };
      }
      res.json({ ...usageCache.body, cases, checkedAt: new Date(usageCache.at).toISOString() });
    } catch (err) {
      console.error('cloudinary usage error:', err.message || err);
      res.status(502).json({ error: 'Cloudinary did not answer the usage request just now.' });
    }
  });

  // ── settings ──
  app.get('/api/admin/cases/settings', ...view, async (req, res) => {
    const s = await getSettings();
    const { calToken, ...safe } = s;
    res.json({ ...safe, calendarLinked: !!calToken });
  });
  app.put('/api/admin/cases/settings', ...manage, async (req, res) => {
    try {
      const cur = await getSettings();
      const b = req.body || {};
      const next = { ...cur,
        hearingReminderDays: Math.min(30, Math.max(0, parseInt(b.hearingReminderDays, 10) || 0)),
        deadlineAlertDays: Math.min(60, Math.max(0, parseInt(b.deadlineAlertDays, 10) || 0)),
        prescriptionAlertDays: Math.min(730, Math.max(0, parseInt(b.prescriptionAlertDays, 10) || 0)),
        idleAlertDays: Math.min(365, Math.max(0, parseInt(b.idleAlertDays, 10) || 0)),
        digestEnabled: !!b.digestEnabled,
        digestHour: Math.min(23, Math.max(0, parseInt(b.digestHour, 10) || 0)),
        notifyEmail: str(b.notifyEmail, 160) || FIRM_INBOX,
        firmName: str(b.firmName, 200),
        firmAddress: str(b.firmAddress, 400),
        firmContact: str(b.firmContact, 300),
        clientEmailsEnabled: !!b.clientEmailsEnabled
      };
      await saveSettings(next);
      await logAudit(req, 'UPDATE', 'CaseSettings', 'cases', 'Case settings updated', null);
      const { calToken, ...safe } = next;
      res.json({ ...safe, calendarLinked: !!calToken });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/cases/calendar-token', verifyToken, requireAdmin, async (req, res) => {
    try {
      const cur = await getSettings();
      const token = crypto.randomBytes(24).toString('hex');
      await saveSettings({ ...cur, calToken: token });
      await logAudit(req, 'UPDATE', 'CaseSettings', 'cases', 'Court calendar feed link regenerated', null);
      res.json({ url: `/api/cases-cal/${token}.ics` });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // Secret-URL calendar feed. No login: the 48-hex token IS the credential, so
  // it carries only what a diary needs and can be rotated from the settings.
  app.get('/api/cases-cal/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').replace(/\.ics$/i, '');
      if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).send('Not found');
      const settings = await getSettings();
      if (!settings.calToken || settings.calToken !== token) return res.status(404).send('Not found');
      const today = manilaToday();
      const docs = await Case.find({ stage: { $in: OPEN_STAGES } }).lean();
      const evs = [];
      docs.forEach(c => {
        const comp = computeCase(c, today);
        const ref = c.caseRef ? `[${c.caseRef}] ` : '';
        const where = [c.court, c.branch && ('Br. ' + c.branch), c.courtCity].filter(Boolean).join(', ');
        comp.hearings.forEach(h => {
          if (!h.date || h.reset || h.date < addDays(today, -14)) return;
          evs.push(vevent({ uid: `ch-${c._id}-${h.id}`, dateStr: h.date,
            summary: `${h.time ? h.time + ' ' : ''}${h.purpose || 'Hearing'} \u2014 ${c.title || ''}`,
            description: `${ref}${c.clientName || ''}\n${where}\n${c.docketNumber || ''}`, alarmDays: 1 }));
        });
        comp.deadlines.forEach(d => {
          if (d.done || !d.dueDate || d.dueDate < addDays(today, -7)) return;
          evs.push(vevent({ uid: `cd-${c._id}-${d.id}`, dateStr: d.dueDate,
            summary: `DEADLINE: ${d.title} \u2014 ${c.title || ''}`,
            description: `${ref}${d.rule || ''}`, alarmDays: 2 }));
        });
        if (comp.prescription && comp.prescription.daysLeft >= -7) {
          evs.push(vevent({ uid: `cp-${c._id}`, dateStr: comp.prescription.date,
            summary: `PRESCRIPTION LAPSES \u2014 ${c.title || ''}`,
            description: `${ref}Last day to file.`, alarmDays: 7 }));
        }
      });
      const cal = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GLRA//Cases//EN', 'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH', 'X-WR-CALNAME:Court diary', 'X-WR-TIMEZONE:Asia/Manila',
        ...evs, 'END:VCALENDAR', ''].join('\r\n');
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Cache-Control', 'private, max-age=900');
      res.send(cal);
    } catch (err) { console.error('cases-cal error:', err); res.status(500).send('Server error'); }
  });

  // ── create ──
  app.post('/api/admin/cases', ...manage, async (req, res) => {
    try {
      const data = sanitizeCaseBody(req.body || {}, { allowStage: true });
      if (!data.title) return res.status(400).json({ error: 'A case title is required' });
      if (!data.clientName) return res.status(400).json({ error: 'A client name is required' });
      if (!CASE_STAGES.includes(data.stage)) data.stage = 'intake';
      const year = manilaToday().slice(0, 4);
      data.caseRef = await nextRef('C', year);
      data.createdBy = String((req.user && req.user.sub) || '');
      data.createdByName = byName(req);
      data.history = [{ at: new Date(), what: 'Case opened', byName: byName(req) }];
      if (req.body && req.body.conflictCleared) {
        data.conflictCheckedAt = new Date();
        data.conflictCheckedBy = byName(req);
      }
      const doc = await Case.create(data);
      await logAudit(req, 'CREATE', 'Case', String(doc._id), caseLabel(doc), null);
      res.status(201).json(withComputed(doc.toObject()));
    } catch (err) { console.error('case create error:', err.message); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/admin/cases/:id', ...view, async (req, res) => {
    const doc = await findCase(req, res); if (!doc) return;
    res.json(withComputed(doc.toObject()));
  });

  app.put('/api/admin/cases/:id', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const data = sanitizeCaseBody(req.body || {});
      if ('title' in data && !data.title) return res.status(400).json({ error: 'A case title is required' });
      if ('clientName' in data && !data.clientName) return res.status(400).json({ error: 'A client name is required' });
      Object.assign(doc, data);
      touch(doc, 'Case details edited', req);
      await doc.save();
      await logAudit(req, 'UPDATE', 'Case', String(doc._id), caseLabel(doc), null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('case update error:', err.message); res.status(500).json({ error: 'Server error' }); }
  });

  // Deleting a case file is an admin act: the record of a client's matter
  // should not disappear because a staff account clicked the wrong row.
  app.delete('/api/admin/cases/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const label = caseLabel(doc);
      for (const f of doc.files || []) {
        try { await cloudinary.uploader.destroy(f.publicId, { resource_type: f.resourceType === 'raw' ? 'raw' : f.resourceType === 'video' ? 'video' : 'image', type: 'authenticated' }); }
        catch (e) { console.warn('cloudinary destroy failed:', e.message); }
      }
      await Case.findByIdAndDelete(doc._id);
      await logAudit(req, 'DELETE', 'Case', String(req.params.id), label, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/cases/:id/stage', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const stage = str(req.body && req.body.stage, 40);
      if (!CASE_STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
      const from = doc.stage;
      if (from === stage) return res.json(withComputed(doc.toObject()));
      doc.stage = stage;
      if (stage === 'closed' && !doc.dateClosed) doc.dateClosed = new Date(manilaToday() + 'T00:00:00.000Z');
      if (stage !== 'closed') doc.dateClosed = doc.dateClosed && stage === 'closed' ? doc.dateClosed : null;
      const lbl = k => (STAGE_META[k] && STAGE_META[k].label) || k;
      touch(doc, `Stage: ${lbl(from)} \u2192 ${lbl(stage)}`, req);
      await doc.save();
      await logAudit(req, 'UPDATE', 'Case', String(doc._id), `${caseLabel(doc)} \u00b7 ${lbl(from)} \u2192 ${lbl(stage)}`, null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/cases/:id/conflict-cleared', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      doc.conflictCheckedAt = new Date();
      doc.conflictCheckedBy = byName(req);
      doc.conflictNotes = str(req.body && req.body.notes, 2000) || doc.conflictNotes;
      touch(doc, 'Conflict check cleared', req);
      await doc.save();
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── sub-lists: a small generic helper keeps these honest and identical ──
  function subRoutes(name, field, build, label) {
    app.post(`/api/admin/cases/:id/${name}`, ...manage, async (req, res) => {
      try {
        const doc = await findCase(req, res); if (!doc) return;
        const row = build(req.body || {}, req, doc);
        if (row.error) return res.status(400).json({ error: row.error });
        doc[field].push(row);
        touch(doc, `${label} added: ${String(row.title || row.purpose || row.label || row.description || '').slice(0, 120)}`, req);
        await doc.save();
        await logAudit(req, 'CREATE', 'Case' + label, String(doc._id), caseLabel(doc), null);
        res.json(withComputed(doc.toObject()));
      } catch (err) { console.error(`${name} add error:`, err.message); res.status(500).json({ error: 'Server error' }); }
    });
    app.delete(`/api/admin/cases/:id/${name}/:sid`, ...manage, async (req, res) => {
      try {
        const doc = await findCase(req, res); if (!doc) return;
        const row = doc[field].id(req.params.sid);
        if (!row) return res.status(404).json({ error: 'Not found' });
        doc[field].pull(row._id);
        touch(doc, `${label} removed`, req);
        await doc.save();
        await logAudit(req, 'DELETE', 'Case' + label, String(doc._id), caseLabel(doc), null);
        res.json(withComputed(doc.toObject()));
      } catch (err) { res.status(500).json({ error: 'Server error' }); }
    });
  }

  subRoutes('hearings', 'hearings', b => ({
    date: dateOrNull(b.date), time: str(b.time, 20), purpose: str(b.purpose, 300),
    venue: str(b.venue, 300), appearedBy: str(b.appearedBy, 200), result: str(b.result, 2000),
    reset: !!b.reset, billed: false, notified: false
  }), 'Hearing');

  subRoutes('deadlines', 'deadlines', b => {
    const title = str(b.title, 300);
    if (!title) return { error: 'A deadline needs a title' };
    return { title, dueDate: dateOrNull(b.dueDate), rule: str(b.rule, 300),
      critical: !!b.critical, done: false, notes: str(b.notes, 2000) };
  }, 'Deadline');

  subRoutes('filings', 'filings', b => {
    const title = str(b.title, 300);
    if (!title) return { error: 'A filing needs a title' };
    return { title, direction: b.direction === 'received' ? 'received' : 'filed',
      date: dateOrNull(b.date), mode: str(b.mode, 60), by: str(b.by, 200), notes: str(b.notes, 3000) };
  }, 'Filing');

  subRoutes('charges', 'charges', b => ({
    kind: str(b.kind, 40) || 'misc', label: str(b.label, 300),
    amount: num(b.amount), date: dateOrNull(b.date) || new Date(manilaToday() + 'T00:00:00.000Z'),
    reimbursable: !!b.reimbursable, notes: str(b.notes, 1000)
  }), 'Charge');

  subRoutes('time', 'timeEntries', (b, req) => ({
    date: dateOrNull(b.date) || new Date(manilaToday() + 'T00:00:00.000Z'),
    description: str(b.description, 500), hours: num(b.hours), rate: num(b.rate),
    billable: b.billable !== false, billed: false, by: str(b.by, 200) || byName(req)
  }), 'Time entry');

  subRoutes('notes', 'notes', (b, req) => ({
    body: str(b.body, 8000), byName: byName(req), at: new Date()
  }), 'Note');

  // Hearings and deadlines also need updating in place, which the generic
  // helper deliberately does not do.
  app.put('/api/admin/cases/:id/hearings/:sid', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const h = doc.hearings.id(req.params.sid);
      if (!h) return res.status(404).json({ error: 'Hearing not found' });
      const b = req.body || {};
      if ('date' in b) h.date = dateOrNull(b.date);
      if ('time' in b) h.time = str(b.time, 20);
      if ('purpose' in b) h.purpose = str(b.purpose, 300);
      if ('venue' in b) h.venue = str(b.venue, 300);
      if ('appearedBy' in b) h.appearedBy = str(b.appearedBy, 200);
      if ('result' in b) h.result = str(b.result, 2000);
      if ('reset' in b) h.reset = !!b.reset;
      if ('billed' in b) h.billed = !!b.billed;
      touch(doc, `Hearing updated: ${h.purpose || dk(h.date)}`, req);
      await doc.save();
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.put('/api/admin/cases/:id/deadlines/:sid', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const d = doc.deadlines.id(req.params.sid);
      if (!d) return res.status(404).json({ error: 'Deadline not found' });
      const b = req.body || {};
      if ('title' in b) d.title = str(b.title, 300);
      if ('dueDate' in b) d.dueDate = dateOrNull(b.dueDate);
      if ('rule' in b) d.rule = str(b.rule, 300);
      if ('critical' in b) d.critical = !!b.critical;
      if ('notes' in b) d.notes = str(b.notes, 2000);
      if ('done' in b) {
        d.done = !!b.done;
        d.doneDate = d.done ? new Date(manilaToday() + 'T00:00:00.000Z') : null;
        d.doneBy = d.done ? byName(req) : '';
        touch(doc, `${d.done ? 'Completed' : 'Reopened'}: ${d.title}`, req);
      }
      await doc.save();
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // Turn every attended-but-unbilled hearing into an appearance-fee charge.
  app.post('/api/admin/cases/:id/bill-appearances', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const fee = num(doc.appearanceFee);
      if (fee <= 0) return res.status(400).json({ error: 'Set an appearance fee on the case first' });
      const today = manilaToday();
      let n = 0;
      (doc.hearings || []).forEach(h => {
        const key = dk(h.date);
        if (!key || key >= today || h.reset || h.billed) return;
        doc.charges.push({ kind: 'appearance', label: `Appearance \u2014 ${h.purpose || 'hearing'} (${key})`,
          amount: fee, date: h.date, reimbursable: false });
        h.billed = true; n++;
      });
      if (!n) return res.status(400).json({ error: 'No unbilled appearances' });
      touch(doc, `Billed ${n} appearance${n === 1 ? '' : 's'} at ${peso(fee)}`, req);
      await doc.save();
      await logAudit(req, 'UPDATE', 'Case', String(doc._id), `${caseLabel(doc)} \u00b7 billed ${n} appearances`, null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── payments (receipt-numbered) ──
  app.post('/api/admin/cases/:id/payments', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const b = req.body || {};
      const amount = num(b.amount);
      if (amount <= 0) return res.status(400).json({ error: 'Enter an amount' });
      const year = manilaToday().slice(0, 4);
      const receiptNo = await nextRef('LO', year);
      doc.payments.push({
        date: dateOrNull(b.date) || new Date(manilaToday() + 'T00:00:00.000Z'),
        amount, mode: str(b.mode, 40) || 'Cash', reference: str(b.reference, 120),
        label: str(b.label, 200), receiptNo, notes: str(b.notes, 1000)
      });
      touch(doc, `Payment ${peso(amount)} received (${receiptNo})`, req);
      await doc.save();
      await logAudit(req, 'CREATE', 'CasePayment', String(doc._id), `${caseLabel(doc)} \u00b7 ${peso(amount)}`, null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('case payment error:', err.message); res.status(500).json({ error: 'Server error' }); }
  });
  app.put('/api/admin/cases/:id/payments/:pid', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const p = doc.payments.id(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Payment not found' });
      const b = req.body || {};
      if ('date' in b) p.date = dateOrNull(b.date);
      if ('amount' in b) p.amount = num(b.amount);
      if ('mode' in b) p.mode = str(b.mode, 40);
      if ('reference' in b) p.reference = str(b.reference, 120);
      if ('label' in b) p.label = str(b.label, 200);
      if ('notes' in b) p.notes = str(b.notes, 1000);
      touch(doc, `Payment ${p.receiptNo || ''} corrected`, req);
      await doc.save();
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.delete('/api/admin/cases/:id/payments/:pid', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const p = doc.payments.id(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Payment not found' });
      const label = `${p.receiptNo || ''} ${peso(p.amount)}`;
      doc.payments.pull(p._id);
      touch(doc, `Payment deleted: ${label}`, req);
      await doc.save();
      await logAudit(req, 'DELETE', 'CasePayment', String(doc._id), `${caseLabel(doc)} \u00b7 ${label}`, null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── documents (privileged: authenticated Cloudinary + 5-minute links) ──
  app.post('/api/admin/cases/:id/files', ...manage, uploadAttachment.single('file'), async (req, res) => {
    const tmp = req.file && req.file.path;
    const cleanup = () => { if (tmp && fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch {} };
    try {
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      const doc = await Case.findById(req.params.id);
      if (!doc) { cleanup(); return res.status(404).json({ error: 'Case not found' }); }
      let result;
      try {
        result = await cloudinary.uploader.upload(tmp, { folder: 'glra_realty/cases', resource_type: 'auto', type: 'authenticated', ...shrinkOnUpload(req.file.mimetype) });
      } catch (e) {
        cleanup();
        const msg = String((e && (e.message || (e.error && e.error.message))) || '');
        if (/file size too large|too large/i.test(msg)) {
          return res.status(413).json({ error: 'That file is larger than the storage plan allows (10 MB a file on the free plan). Save a smaller copy, or split a long PDF, and try again.' });
        }
        throw e;
      }
      cleanup();
      const cat = String((req.body && req.body.category) || '').toLowerCase();
      const isPic = (result.resource_type || 'image') === 'image' && !/^pdf$/i.test(result.format || '');
      doc.files.push({
        publicId: result.public_id, resourceType: result.resource_type || 'image',
        format: result.format || '', bytes: result.bytes || 0,
        name: String(req.file.originalname || '').slice(0, 200),
        label: str(req.body && req.body.label, 200) || '',
        category: FILE_CATEGORIES.includes(cat) ? cat : (isPic ? 'photo' : 'other'),
        width: Number(result.width) || 0, height: Number(result.height) || 0, pages: Number(result.pages) || 0,
        uploadedByName: byName(req), uploadedAt: new Date()
      });
      touch(doc, `Document uploaded: ${req.file.originalname || ''}`, req);
      await doc.save();
      await logAudit(req, 'UPLOAD', 'CaseFile', String(doc._id), `${caseLabel(doc)} \u00b7 ${req.file.originalname || ''}`, { size: result.bytes });
      res.json(withComputed(doc.toObject()));
    } catch (err) { console.error('case file upload error:', err.message); cleanup(); res.status(500).json({ error: 'Upload failed' }); }
  });
  app.get('/api/admin/cases/:id/files/:fid/link', ...view, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const f = doc.files.id(req.params.fid);
      if (!f) return res.status(404).json({ error: 'File not found' });
      const url = cloudinary.utils.private_download_url(f.publicId, f.format,
        { resource_type: f.resourceType || 'image', type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 300 });
      res.json({ url, name: f.name, expiresInSeconds: 300 });
    } catch (err) { res.status(500).json({ error: 'Could not open the file' }); }
  });
  // Thumbnails and the full-screen preview. Photos and PDFs (page one) are
  // resized by Cloudinary from a signed URL that only the server ever sees;
  // the browser gets the picture itself, cached privately for an hour.
  app.get('/api/admin/cases/:id/files/:fid/view', ...view, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const f = doc.files.id(req.params.fid);
      if (!f) return res.status(404).json({ error: 'File not found' });
      if ((f.resourceType || 'image') !== 'image') return res.status(415).json({ error: 'No preview for this kind of file' });
      const w = Math.max(80, Math.min(2000, parseInt(req.query.w, 10) || 360));
      const small = w <= 480;
      const t = { width: w, crop: small ? 'fill' : 'limit', quality: 'auto', fetch_format: 'jpg' };
      if (small) { t.height = Math.round(w * 0.75); t.gravity = 'auto'; }
      if (/^pdf$/i.test(f.format || '')) t.page = 1;
      const url = cloudinary.url(f.publicId, { resource_type: 'image', type: 'authenticated', sign_url: true, secure: true, format: 'jpg', transformation: [t] });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      let r;
      try { r = await fetch(url, { signal: ac.signal }); } finally { clearTimeout(timer); }
      if (!r.ok) return res.status(502).json({ error: 'Preview unavailable' });
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(buf);
    } catch (err) { res.status(500).json({ error: 'Preview unavailable' }); }
  });
  app.put('/api/admin/cases/:id/files/:fid', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const f = doc.files.id(req.params.fid);
      if (!f) return res.status(404).json({ error: 'File not found' });
      const b = req.body || {};
      if (b.label !== undefined) f.label = str(b.label, 200);
      if (b.category !== undefined && FILE_CATEGORIES.includes(String(b.category))) f.category = String(b.category);
      await doc.save();
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.delete('/api/admin/cases/:id/files/:fid', ...manage, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const f = doc.files.id(req.params.fid);
      if (!f) return res.status(404).json({ error: 'File not found' });
      try { await cloudinary.uploader.destroy(f.publicId, { resource_type: f.resourceType === 'raw' ? 'raw' : f.resourceType === 'video' ? 'video' : 'image', type: 'authenticated' }); }
      catch (e) { console.warn('cloudinary destroy failed:', e.message); }
      const name = f.name;
      doc.files.pull(f._id);
      touch(doc, `Document removed: ${name}`, req);
      await doc.save();
      await logAudit(req, 'DELETE', 'CaseFile', String(doc._id), `${caseLabel(doc)} \u00b7 ${name}`, null);
      res.json(withComputed(doc.toObject()));
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── PDFs ──
  app.get('/api/admin/cases/:id/pdf', ...view, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const settings = await getSettings();
      const obj = doc.toObject();
      const comp = computeCase(obj);
      const mode = ['summary', 'statement', 'full'].includes(req.query.mode) ? req.query.mode : 'summary';
      const buf = await pdf.casePdf(obj, comp, mode, settings);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${(obj.caseRef || 'case')}-${mode}.pdf"`);
      res.send(buf);
    } catch (err) { console.error('case pdf error:', err); res.status(500).json({ error: 'Could not build the PDF' }); }
  });

  app.get('/api/admin/cases/:id/receipt/:pid', ...view, async (req, res) => {
    try {
      const doc = await findCase(req, res); if (!doc) return;
      const settings = await getSettings();
      const obj = doc.toObject();
      const comp = computeCase(obj);
      const p = comp.payments.find(x => x.id === String(req.params.pid));
      if (!p) return res.status(404).json({ error: 'Payment not found' });
      const buf = await pdf.receiptPdf(obj, p, comp, settings);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${p.receiptNo || 'receipt'}.pdf"`);
      res.send(buf);
    } catch (err) { console.error('case receipt error:', err); res.status(500).json({ error: 'Could not build the receipt' }); }
  });

  // ── email ──
  async function composeFor(req, res) {
    const doc = await findCase(req, res); if (!doc) return null;
    const settings = await getSettings();
    const obj = doc.toObject();
    const comp = computeCase(obj);
    const b = req.body || {};
    const kind = str(b.kind, 40) || 'update';
    const extra = { esc, message: str(b.message, 6000), subject: str(b.subject, 200) };
    if (kind === 'receipt') extra.payment = comp.payments.find(p => p.id === String(b.paymentId)) || comp.payments.slice(-1)[0];
    if (kind === 'hearing') extra.hearing = comp.hearings.find(h => h.id === String(b.hearingId)) || comp.nextHearing;
    const built = buildEmail(kind, obj, comp, settings, extra);
    return { doc, obj, comp, settings, kind, built, extra };
  }

  app.post('/api/admin/cases/:id/email-preview', ...view, async (req, res) => {
    try {
      const ctx = await composeFor(req, res); if (!ctx) return;
      res.json({ to: ctx.obj.clientEmail || '', subject: ctx.built.subject, html: ctx.built.html });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/cases/:id/email', ...manage, async (req, res) => {
    try {
      const ctx = await composeFor(req, res); if (!ctx) return;
      const to = str((req.body && req.body.to) || ctx.obj.clientEmail, 160);
      if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'No valid email address for this client' });
      let attachments = null;
      try {
        if (ctx.kind === 'statement') {
          const buf = await pdf.casePdf(ctx.obj, ctx.comp, 'statement', ctx.settings);
          attachments = [{ name: `statement-${ctx.obj.caseRef || 'case'}.pdf`, content: buf }];
        } else if (ctx.kind === 'receipt' && ctx.extra.payment) {
          const buf = await pdf.receiptPdf(ctx.obj, ctx.extra.payment, ctx.comp, ctx.settings);
          attachments = [{ name: `${ctx.extra.payment.receiptNo || 'receipt'}.pdf`, content: buf }];
        }
      } catch (e) { console.warn('case email attachment failed:', e.message); }
      const ok = await sendEmail(to, ctx.built.subject, ctx.built.html,
        ctx.settings.firmName || 'GLRA Realty', ctx.settings.notifyEmail || FIRM_INBOX, attachments);
      ctx.doc.history.push({ at: new Date(), what: `Email (${ctx.kind}) ${ok ? 'sent to' : 'FAILED to'} ${to}`, byName: byName(req) });
      await ctx.doc.save();
      await logAudit(req, 'EMAIL', 'Case', String(ctx.doc._id), `${caseLabel(ctx.doc)} \u00b7 ${ctx.kind} \u2192 ${to}`, null);
      if (!ok) return res.status(502).json({ error: 'The email service rejected the message' });
      res.json(withComputed(ctx.doc.toObject()));
    } catch (err) { console.error('case email error:', err.message); res.status(500).json({ error: 'Server error' }); }
  });
}

// ── REMINDER ENGINE ──────────────────────────────────────────
// Runs every 30 minutes. Three jobs:
//   * remind the client of a hearing, N days ahead, during waking hours
//   * warn the firm about a deadline or a prescriptive period closing in
//   * one digest a morning, only if something actually needs doing
// Each message is keyed in case.reminderKeys so it goes out exactly once. A
// failed send is recorded too, so a dead mailbox is not retried forever.
function startCasesTick({ sendEmail, esc }) {
  const TICK = 30 * 60 * 1000;
  async function tick() {
    try {
      const settings = await getSettings();
      const today = manilaToday();
      const hour = manilaHour();
      const docs = await Case.find({ stage: { $in: OPEN_STAGES } });

      for (const c of docs) {
        const comp = computeCase(c.toObject(), today);
        const keys = c.reminderKeys && typeof c.reminderKeys === 'object' ? { ...c.reminderKeys } : {};
        let dirty = false;

        // Hearing reminder to the client — only 8am to 8pm Manila.
        if (settings.clientEmailsEnabled && c.autoEmails && c.clientEmail && hour >= 8 && hour < 20) {
          for (const h of comp.hearings) {
            if (!h.date || h.reset || h.daysAway === null) continue;
            if (h.daysAway < 0 || h.daysAway > settings.hearingReminderDays) continue;
            const k = `h:${h.id}`;
            if (keys[k] || keys[k + ':failed']) continue;
            const built = buildEmail('hearing', c.toObject(), comp, settings, { esc, hearing: h });
            const ok = await sendEmail(c.clientEmail, built.subject, built.html,
              settings.firmName || 'GLRA Realty', settings.notifyEmail || FIRM_INBOX);
            keys[ok ? k : k + ':failed'] = today;
            dirty = true;
            const hh = c.hearings.id(h.id);
            if (hh && ok) hh.notified = true;
          }
        }

        // Deadline and prescription warnings go to the firm, any hour.
        for (const d of comp.deadlines) {
          if (d.done || !d.dueDate || d.daysAway === null) continue;
          if (d.daysAway < 0 || d.daysAway > settings.deadlineAlertDays) continue;
          const k = `d:${d.id}:${d.daysAway <= 1 ? '1' : d.daysAway <= 3 ? '3' : 'n'}`;
          if (keys[k] || keys[k + ':failed']) continue;
          const when = d.daysAway === 0 ? 'TODAY' : `in ${d.daysAway} day${d.daysAway === 1 ? '' : 's'}`;
          const html = getEmailHeader() +
            `<p><b>${esc(d.critical ? 'CRITICAL DEADLINE' : 'Deadline')} ${esc(when)}</b></p>
             <p style="font-size:17px;margin:6px 0"><b>${esc(d.title)}</b></p>
             <p>${esc(c.title || '')}${c.docketNumber ? ' \u2014 ' + esc(c.docketNumber) : ''}<br>
             ${esc(c.clientName || '')}${c.leadCounsel ? ' \u00b7 ' + esc(c.leadCounsel) : ''}</p>
             ${d.rule ? `<p style="color:#667;font-size:13px">${esc(d.rule)}</p>` : ''}
             <p>Due: <b>${esc(d.dueDate)}</b></p>` + getEmailFooter();
          const ok = await sendEmail(settings.notifyEmail || FIRM_INBOX,
            `${d.critical ? '[CRITICAL] ' : ''}${d.title} \u2014 due ${when}`, html, settings.firmName || 'GLRA Realty');
          keys[ok ? k : k + ':failed'] = today;
          dirty = true;
        }

        if (comp.prescription && comp.prescription.daysLeft >= 0 &&
            comp.prescription.daysLeft <= settings.prescriptionAlertDays) {
          const band = comp.prescription.daysLeft <= 7 ? '7' : comp.prescription.daysLeft <= 30 ? '30' : '90';
          const k = `p:${band}`;
          if (!keys[k] && !keys[k + ':failed']) {
            const html = getEmailHeader() +
              `<p><b>The prescriptive period on this matter lapses in ${comp.prescription.daysLeft} day(s).</b></p>
               <p style="font-size:17px;margin:6px 0"><b>${esc(c.title || '')}</b></p>
               <p>${esc(c.clientName || '')}${c.caseRef ? ' \u00b7 ' + esc(c.caseRef) : ''}</p>
               <p>Last day to file: <b>${esc(comp.prescription.date)}</b></p>
               <p>If the action is not brought by then it can no longer be brought at all.</p>` + getEmailFooter();
            const ok = await sendEmail(settings.notifyEmail || FIRM_INBOX,
              `[PRESCRIPTION] ${comp.prescription.daysLeft} days \u2014 ${c.title || ''}`, html, settings.firmName || 'GLRA Realty');
            keys[ok ? k : k + ':failed'] = today;
            dirty = true;
          }
        }

        if (dirty) { c.reminderKeys = keys; c.markModified('reminderKeys'); await c.save(); }
      }

      // ── one morning digest ──
      if (settings.digestEnabled && hour >= settings.digestHour && settings.lastDigestKey !== today) {
        const all = await Case.find({ stage: { $in: OPEN_STAGES } }).lean();
        const hearings = [], deadlines = [], prescriptions = [], idle = [];
        all.forEach(c => {
          const comp = computeCase(c, today);
          comp.hearings.forEach(h => {
            if (h.date >= today && h.date <= addDays(today, 7) && !h.reset)
              hearings.push({ ...h, c });
          });
          comp.deadlines.forEach(d => {
            if (!d.done && d.dueDate && d.dueDate <= addDays(today, settings.deadlineAlertDays))
              deadlines.push({ ...d, c });
          });
          if (comp.prescription && comp.prescription.daysLeft >= 0 &&
              comp.prescription.daysLeft <= settings.prescriptionAlertDays) prescriptions.push({ ...comp.prescription, c });
          if (settings.idleAlertDays && comp.idleDays !== null && comp.idleDays >= settings.idleAlertDays)
            idle.push({ days: comp.idleDays, c });
        });
        if (hearings.length || deadlines.length || prescriptions.length || idle.length) {
          hearings.sort((a, b) => a.date.localeCompare(b.date));
          deadlines.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
          const row = (l, r) => `<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;color:#667">${l}</td><td style="padding:4px 0">${r}</td></tr>`;
          const sect = (t, rows) => rows.length ? `<h3 style="margin:18px 0 6px;font-size:15px">${t}</h3><table style="border-collapse:collapse;width:100%">${rows.join('')}</table>` : '';
          const html = getEmailHeader() +
            `<p>Good morning. Here is the diary for ${today}.</p>` +
            sect('Hearings, next 7 days', hearings.map(h => row(
              `${h.date}${h.time ? ' ' + esc(h.time) : ''}`,
              `<b>${esc(h.purpose || 'Hearing')}</b> \u2014 ${esc(h.c.title || '')}<br><span style="color:#667;font-size:13px">${esc([h.c.court, h.c.branch && 'Br. ' + h.c.branch].filter(Boolean).join(' '))} \u00b7 ${esc(h.c.clientName || '')}</span>`))) +
            sect('Deadlines', deadlines.map(d => row(
              `${d.dueDate}${d.status === 'missed' ? ' <b style="color:#c00">MISSED</b>' : ''}`,
              `${d.critical ? '<b>' : ''}${esc(d.title)}${d.critical ? '</b>' : ''} \u2014 ${esc(d.c.title || '')}`))) +
            sect('Prescriptive periods closing', prescriptions.map(p => row(
              `${p.date} (${p.daysLeft}d)`, `<b>${esc(p.c.title || '')}</b> \u2014 ${esc(p.c.clientName || '')}`))) +
            sect('No activity for a while', idle.map(i => row(
              `${i.days} days`, `${esc(i.c.title || '')} \u2014 ${esc(i.c.clientName || '')}`))) +
            getEmailFooter();
          await sendEmail(settings.notifyEmail || FIRM_INBOX,
            `Court diary \u2014 ${today}`, html, settings.firmName || 'GLRA Realty');
        }
        await saveSettings({ ...settings, lastDigestKey: today });
      }
    } catch (err) { console.error('cases tick error:', err.message); }
  }
  setTimeout(tick, 45 * 1000);
  setInterval(tick, TICK);
}

module.exports = {
  registerCaseRoutes, startCasesTick,
  STAGE_META, CASE_FLOW, OPEN_STAGES, computeCase, getSettings, saveSettings,
  DEFAULT_SETTINGS, DEADLINE_RULES, COURTS, CASE_TYPES, NATURES, CLIENT_ROLES,
  HEARING_PURPOSES, FEE_ARRANGEMENTS, CHARGE_KINDS, nextRef, buildEmail,
  _test: { dk, addDays, diffDays, money, peso, manilaToday, computeCase, sanitizeCaseBody, buildEmail }
};
