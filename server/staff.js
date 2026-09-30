// =============================================================================
// STAFF DESK — the admin "Staff" tab
// =============================================================================
// Built on the ordinary Task collection, so every task handed out here also
// shows on the Tasks tab. What this file adds:
//   * a scorecard per staff member (progress, on-time rate, streak, points)
//   * the staff member's day: time in / out, what they are doing right now,
//     the plan for the day and the end-of-day report the boss reads
//   * task kinds with checklists, proof of work (the Facebook post link...),
//     a review step (done -> the boss checks it -> approved or sent back)
//   * repeating tasks (daily / weekdays / weekly / monthly)
//   * suggestions: leads waiting for a reply, follow-ups due, unanswered
//     inquiries, owner submissions to upload, listings not posted lately
//   * the posting board: every live listing x every channel (Facebook page,
//     groups, portals, Authority to Sell), each post with its link as proof
//   * daily targets (posts, lead contacts, tasks, active time) and the work
//     log: one timeline of everything a staff member did in a day, with gaps
//   * messages from the boss that the staff member has to acknowledge
//
// Permissions: staff use tasks_view (their own desk); handing out, checking
// and reading everyone's desk needs tasks_create.
// =============================================================================
const mongoose = require('mongoose');
const { Task, StaffDay, StaffPosting, StaffMessage, AuditLog, Setting, Account, Lead, Inquiry, PropertySubmission, Property } = require('./db');
const { verifyToken, requirePermission, logAudit } = require('./auth');

const KINDS = ['lead', 'followup', 'email', 'facebook', 'social', 'portal', 'upload', 'photos',
  'listing_fix', 'inconsistency', 'stale', 'owner_call', 'viewing', 'docs', 'errand', 'research', 'content', 'admin', 'other'];
const STATES = ['working', 'break', 'field', 'meeting', 'lunch', 'off'];
const RECUR = ['', 'daily', 'weekdays', 'weekly', 'monthly'];

const pad2 = n => String(n).padStart(2, '0');
// Manila has no daylight saving: UTC+8 all year.
function manilaDay(d) {
  const m = new Date((d ? new Date(d).getTime() : Date.now()) + 8 * 3600e3);
  return `${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}-${pad2(m.getUTCDate())}`;
}
// Start of a Manila day (as a real instant).
function dayStart(dayStr) { return new Date(dayStr + 'T00:00:00+08:00'); }
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max); }
function cleanUrl(u) { const s = clean(u, 500); return /^https?:\/\//i.test(s) ? s : ''; }

async function managerCheck(req) {
  if (req.user.role === 'admin') return true;
  const a = await Account.findById(req.user.sub).select('role permissions').lean();
  if (!a) return false;
  if (a.role === 'admin') return true;
  return !!(a.permissions && a.permissions.tasks_create === true);
}

// ── SCORECARD ────────────────────────────────────────────────
// Everything is worked out from the tasks themselves, so there is nothing to
// keep in step.
function scorecard(tasks, days) {
  const now = Date.now();
  const today = manilaDay();
  const t0 = dayStart(today).getTime();
  const weekAgo = t0 - 6 * 864e5, monthAgo = t0 - 29 * 864e5;
  const s = { open: 0, todo: 0, in_progress: 0, stuck: 0, overdue: 0, dueToday: 0, submitted: 0, returned: 0,
    doneToday: 0, doneWeek: 0, doneMonth: 0, pointsToday: 0, pointsWeek: 0, pointsMonth: 0,
    onTime: 0, late: 0, onTimeRate: null, avgHours: null, daily: [], byKind: {}, streak: 0, todayPct: 0 };
  const perDay = {};
  const hours = [];
  for (const t of tasks) {
    const pts = Number(t.points) || 1;
    if (t.status !== 'done') {
      s.open++; s[t.status] = (s[t.status] || 0) + 1;
      if (t.review === 'returned') s.returned++;
      if (t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (manilaDay(t.dueDate) < today) s.overdue++;
        else if (manilaDay(t.dueDate) === today) s.dueToday++;
        void due;
      }
      continue;
    }
    if (t.review === 'submitted') s.submitted++;
    const c = t.completedAt ? new Date(t.completedAt).getTime() : 0;
    if (!c) continue;
    const d = manilaDay(c);
    perDay[d] = (perDay[d] || 0) + 1;
    if (c >= t0) { s.doneToday++; s.pointsToday += pts; }
    if (c >= weekAgo) { s.doneWeek++; s.pointsWeek += pts; }
    if (c >= monthAgo) {
      s.doneMonth++; s.pointsMonth += pts;
      const k = t.kind || 'other';
      s.byKind[k] = (s.byKind[k] || 0) + 1;
      if (t.dueDate) { if (d <= manilaDay(t.dueDate)) s.onTime++; else s.late++; }
      const from = new Date(t.startedAt || t.createdAt).getTime();
      if (from && c > from) hours.push((c - from) / 3600e3);
    }
  }
  if (s.onTime + s.late) s.onTimeRate = Math.round(100 * s.onTime / (s.onTime + s.late));
  if (hours.length) { hours.sort((a, b) => a - b); s.avgHours = Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10; }
  // 14 days of finished tasks, oldest first.
  for (let i = 13; i >= 0; i--) {
    const d = manilaDay(t0 - i * 864e5 + 12 * 3600e3);
    s.daily.push({ day: d, done: perDay[d] || 0 });
  }
  // Streak: working days in a row with something finished or a time-in.
  // Sundays do not break it; today does not break it until it is over.
  const worked = new Set(Object.keys(perDay));
  (days || []).forEach(x => { if (x.checkIn) worked.add(x.day); });
  for (let i = 0; i < 120; i++) {
    const inst = t0 - i * 864e5 + 12 * 3600e3;
    const d = manilaDay(inst);
    const dow = new Date(inst + 8 * 3600e3).getUTCDay();
    if (worked.has(d)) { s.streak++; continue; }
    if (i === 0 || dow === 0) continue;
    break;
  }
  const todayTotal = s.doneToday + s.dueToday + s.overdue;
  s.todayPct = todayTotal ? Math.round(100 * s.doneToday / todayTotal) : (s.open ? 0 : 100);
  void now;
  return s;
}

function presence(lastSeen) {
  if (!lastSeen) return 'offline';
  const m = (Date.now() - new Date(lastSeen).getTime()) / 60000;
  return m < 3 ? 'online' : m < 15 ? 'idle' : 'offline';
}

const TASK_FIELDS = 'title description kind status priority dueDate assignedTo createdBy completedAt startedAt checklist propertyId issueKey link proofUrl proofNote recurrence review reviewNote reviewedAt botCheck points category reference updates createdAt updatedAt';

async function tasksFor(accountId, sinceDays) {
  const since = new Date(Date.now() - (sinceDays || 60) * 864e5);
  return Task.find({ assignedTo: accountId, $or: [{ status: { $ne: 'done' } }, { completedAt: { $gte: since } }, { review: 'submitted' }] })
    .select(TASK_FIELDS).populate('createdBy', 'name email').sort({ dueDate: 1, createdAt: 1 }).limit(800).lean();
}

// Next due date for a repeating task, counted from the old due date (or now
// if it was already overdue, so a late finish does not stack up a backlog).
// Posting kinds are only done with a link that proves it (the post itself).
const PROOF_KINDS = ['facebook', 'social', 'portal', 'upload'];
function hasProofLink(task) { return /^https?:\/\/\S+/i.test(String(task.proofUrl || '')); }

// The next copy of a repeating task. Called from every way a task can be
// finished (the desk's Done, the boss's approve, the Tasks board), so a
// routine never silently stops. Returns the new task, or null.
async function spawnNextTask(task) {
  if (!task || !task.recurrence || task.spawnedNext) return null;
  const spawned = await Task.create({
    title: task.title, description: task.description, category: task.category, kind: task.kind,
    priority: task.priority, assignedTo: task.assignedTo, createdBy: task.createdBy,
    dueDate: nextDue(task.dueDate, task.recurrence), checklist: (task.checklist || []).map(c => ({ text: c.text })),
    propertyId: task.propertyId, link: task.link, reference: task.reference,
    recurrence: task.recurrence, points: task.points
  });
  await Task.updateOne({ _id: task._id }, { $set: { spawnedNext: spawned._id } });
  task.spawnedNext = spawned._id;
  return spawned;
}

// Worked out on Manila dates: a "weekdays" task never lands on a Saturday or
// Sunday in Manila (the UTC day used to be checked, then the time moved), and
// a monthly task due on the 31st moves to the last day of a shorter month
// instead of drifting into the next one.
function nextDue(from, rule) {
  const OFF = 8 * 3600e3;
  const m = new Date(Math.max(from ? new Date(from).getTime() : 0, Date.now()) + OFF);   // Manila wall clock in the UTC fields
  const keep = from ? new Date(new Date(from).getTime() + OFF) : null;
  if (rule === 'daily') m.setUTCDate(m.getUTCDate() + 1);
  else if (rule === 'weekdays') { do { m.setUTCDate(m.getUTCDate() + 1); } while ([0, 6].includes(m.getUTCDay())); }
  else if (rule === 'weekly') m.setUTCDate(m.getUTCDate() + 7);
  else if (rule === 'monthly') {
    const day = keep ? keep.getUTCDate() : m.getUTCDate();
    const target = m.getUTCMonth() + 1;
    const last = new Date(Date.UTC(m.getUTCFullYear(), target + 1, 0)).getUTCDate();
    m.setUTCDate(1); m.setUTCMonth(target); m.setUTCDate(Math.min(day, last));
  }
  // Keep the time of day it was originally due.
  if (keep) m.setUTCHours(keep.getUTCHours(), keep.getUTCMinutes(), 0, 0);
  return new Date(m.getTime() - OFF);
}

// ── SETTINGS: posting channels and daily targets ─────────────
// The channel keys follow the columns of the GLRA Management System sheet
// (SM, SM 2, LC, ATS). Labels can be renamed on the Posting board.
// every = days before a post counts as due again (0 = never).
const DEFAULT_CHANNELS = [
  { key: 'SM',  col: 'SM',   label: 'Facebook page',     every: 14 },
  { key: 'SM2', col: 'SM 2', label: 'Facebook groups',   every: 7 },
  { key: 'LC',  col: 'LC',   label: 'Listing portal',    every: 30 },
  { key: 'ATS', col: 'ATS',  label: 'Authority to Sell', every: 0 }
];
const DEFAULT_TARGETS = { posts: 5, contacts: 10, tasks: 5, activeMin: 300 };
async function getConfig() {
  const doc = await Setting.findOne({ key: 'staff_config' }).lean();
  const v = (doc && doc.value) || {};
  const channels = Array.isArray(v.channels) && v.channels.length ? v.channels : DEFAULT_CHANNELS;
  return { channels, targets: v.targets || {} };
}
function targetsFor(cfg, id) { return { ...DEFAULT_TARGETS, ...((cfg.targets || {})[String(id)] || {}) }; }

const CONTACT_TYPES = ['call', 'whatsapp', 'viber', 'sms', 'email', 'meeting', 'viewing', 'listings_sent'];
// What one person got done between two instants.
async function countsFor(acc, from, to) {
  const email = String(acc.email || '').toLowerCase();
  const [posts, tasks, leadAgg, inq, actions] = await Promise.all([
    StaffPosting.countDocuments({ by: acc._id, source: { $ne: 'excel' }, postedAt: { $gte: from, $lt: to } }),
    Task.countDocuments({ assignedTo: acc._id, status: 'done', review: { $ne: 'returned' }, completedAt: { $gte: from, $lt: to } }),
    Lead.aggregate([
      { $match: { 'activities.by': email, 'activities.at': { $gte: from, $lt: to } } },
      { $unwind: '$activities' },
      { $match: { 'activities.by': email, 'activities.at': { $gte: from, $lt: to }, 'activities.type': { $in: CONTACT_TYPES } } },
      { $count: 'n' }
    ]),
    AuditLog.countDocuments({ actor: email, action: 'INQUIRY_HANDLED', timestamp: { $gte: from, $lt: to } }),
    AuditLog.countDocuments({ actor: email, action: { $nin: ['LOGIN', 'LOGOUT', 'TIME_IN', 'TIME_OUT'] }, timestamp: { $gte: from, $lt: to } })
  ]);
  return { posts, tasks, contacts: ((leadAgg[0] && leadAgg[0].n) || 0) + inq, actions };
}
async function lastActionAt(acc) {
  const email = String(acc.email || '').toLowerCase();
  const [a, l] = await Promise.all([
    AuditLog.findOne({ actor: email, action: { $nin: ['LOGIN', 'LOGOUT', 'TIME_IN', 'TIME_OUT'] } }).sort({ timestamp: -1 }).select('timestamp').lean(),
    Lead.aggregate([
      { $match: { 'activities.by': email } }, { $unwind: '$activities' }, { $match: { 'activities.by': email } },
      { $group: { _id: null, at: { $max: '$activities.at' } } }
    ])
  ]);
  const t = Math.max(a ? +new Date(a.timestamp) : 0, l[0] && l[0].at ? +new Date(l[0].at) : 0);
  return t ? new Date(t) : null;
}
// Today and the last 7 days, plus the targets, for the scorecard.
async function progressFor(acc, cfg, todayDoc) {
  const today = manilaDay();
  const t0 = dayStart(today), t1 = new Date(t0.getTime() + 864e5), w0 = new Date(t0.getTime() - 6 * 864e5);
  const [d, w, last] = await Promise.all([countsFor(acc, t0, t1), countsFor(acc, w0, t1), lastActionAt(acc)]);
  d.activeMin = (todayDoc && todayDoc.activeMin) || 0;
  return { today: d, week: w, targets: targetsFor(cfg, acc._id), lastActionAt: last };
}

// Everyone the boss can hand work to: active employees (not agents, who
// have their own workspace, and not pending sign-ups).
async function staffList() {
  return Account.find({ role: 'employee', isActive: { $ne: false }, status: { $ne: 'pending' } })
    .select('name email role lastSeen lastLogin').sort({ name: 1 }).lean();
}

// Hand out tasks (the Staff tab and the cloud supervisor). A task with an
// issueKey that is still open is not given out twice.
async function createStaffTasks(list, createdBy) {
  const created = [], skipped = [];
  for (const t of list) {
    const title = clean(t.title, 200);
    if (!title) { skipped.push({ title: '', why: 'No title' }); continue; }
    const issueKey = clean(t.issueKey, 120);
    if (issueKey) {
      const dup = await Task.findOne({ issueKey, $or: [{ status: { $ne: 'done' } }, { review: 'submitted' }] }).select('_id').lean();
      if (dup) { skipped.push({ title, why: 'Already given out' }); continue; }
    }
    const asked = (Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo]).filter(id => mongoose.isValidObjectId(id));
    // Only active, approved staff can be given work; a task given to nobody
    // (or to an agent or a pending sign-up) would sit where no one sees it.
    const assignedTo = asked.length ? (await Account.find({ _id: { $in: asked }, isActive: { $ne: false }, status: { $ne: 'pending' }, role: { $in: ['employee', 'admin'] } }).select('_id').lean()).map(a => a._id) : [];
    if (!assignedTo.length) { skipped.push({ title, why: 'Pick who does it (an active staff member)' }); continue; }
    const task = await Task.create({
      title,
      description: clean(t.description, 5000),
      category: clean(t.category || 'Staff', 60),
      kind: KINDS.includes(t.kind) ? t.kind : 'other',
      priority: ['low', 'medium', 'high', 'critical'].includes(t.priority) ? t.priority : 'medium',
      assignedTo,
      dueDate: t.dueDate && !isNaN(new Date(t.dueDate)) ? new Date(t.dueDate) : null,
      checklist: (Array.isArray(t.checklist) ? t.checklist : []).map(x => clean(typeof x === 'string' ? x : x && x.text, 300)).filter(Boolean).slice(0, 30).map(text => ({ text })),
      propertyId: mongoose.isValidObjectId(t.propertyId) ? t.propertyId : null,
      issueKey,
      // A web address or a page on this site; never javascript: or data:.
      link: /^(https?:\/\/|\/(?!\/))/i.test(clean(t.link, 500)) ? clean(t.link, 500) : '',
      reference: clean(t.reference, 200),
      recurrence: RECUR.includes(t.recurrence) ? t.recurrence : '',
      points: Math.max(0, Math.min(20, parseInt(t.points, 10) || 1)),
      createdBy
    });
    created.push(task);
  }
  return { created, skipped };
}

// Everything one person did on one Manila day, in order, with the gaps.
async function buildActivity(accId, dayIn) {
  const acc = await Account.findById(accId).select('name email').lean();
  if (!acc) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dayIn || '')) ? String(dayIn) : manilaDay();
  const from = dayStart(day), to = new Date(from.getTime() + 864e5);
  const email = String(acc.email || '').toLowerCase();
  const [sd, audits, posts, leads, cfg] = await Promise.all([
    StaffDay.findOne({ account: accId, day }).lean(),
    AuditLog.find({ actor: email, timestamp: { $gte: from, $lt: to } }).select('action target targetTitle timestamp').sort({ timestamp: 1 }).limit(600).lean(),
    StaffPosting.find({ by: accId, postedAt: { $gte: from, $lt: to } }).populate('property', 'title').lean(),
    Lead.find({ 'activities.by': email, 'activities.at': { $gte: from, $lt: to } }).select('name emails activities').limit(300).lean(),
    getConfig()
  ]);
  const ev = [];
  const STATE_TXT = { working: 'Back to work', break: 'Short break', lunch: 'Lunch', field: 'Out on field work', meeting: 'In a meeting', off: 'Timed out' };
  if (sd && sd.checkIn) ev.push({ at: sd.checkIn, kind: 'in', text: 'Timed in' });
  ((sd && sd.stateLog) || []).forEach(x => { if (x.state !== 'off' && !(x.state === 'working' && sd.checkIn && Math.abs(new Date(x.at) - new Date(sd.checkIn)) < 5000)) ev.push({ at: x.at, kind: 'state', state: x.state, text: (STATE_TXT[x.state] || x.state) + (x.note ? ': ' + x.note : '') }); });
  if (sd && sd.checkOut) ev.push({ at: sd.checkOut, kind: 'out', text: 'Timed out' });
  const VERB = { CREATE: 'Added', UPDATE: 'Edited', DELETE: 'Deleted', UPLOAD: 'Uploaded', IMPORT: 'Imported', LOGIN: 'Signed in', LOGOUT: 'Signed out',
    INQUIRY_HANDLED: 'Answered an enquiry', INQUIRY_REOPENED: 'Reopened an enquiry', TASK_SUBMIT: 'Finished task', TASK_STUCK: 'Stuck on task',
    TASK_APPROVE: 'Approved task', TASK_RETURN: 'Sent back task', MERGE_LEAD: 'Merged leads', EMAIL: 'Emailed', STAFF_ACK: 'Answered a message',
    TIME_IN: '', TIME_OUT: '', POSTED: '' };
  audits.forEach(a => {
    const v = VERB[a.action];
    if (v === '') return;   // shown from their own records above/below
    const tgt = a.target && !/^(Session|Task|Inquiry|StaffMessage)$/.test(a.target) ? a.target.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() + ' ' : '';
    ev.push({ at: a.timestamp, kind: a.action.startsWith('TASK_') ? 'task' : /^LOG(IN|OUT)$/.test(a.action) ? 'session' : 'edit',
      text: `${v || a.action.toLowerCase().replace(/_/g, ' ')} ${tgt}${a.targetTitle ? '· ' + a.targetTitle : ''}`.replace(/\s+/g, ' ').trim() });
  });
  const chName = k => (cfg.channels.find(c => c.key === k) || {}).label || k;
  posts.forEach(p => { if (p.source !== 'excel') ev.push({ at: p.postedAt, kind: 'post', text: `Posted on ${chName(p.channel)} · ${(p.property && p.property.title) || 'a listing'}`, url: p.url }); });
  const LEAD_VERB = { call: 'Called', whatsapp: 'WhatsApp to', viber: 'Viber to', sms: 'Texted', email: 'Emailed', meeting: 'Met', viewing: 'Viewing with', listings_sent: 'Sent listings to', note: 'Note on', stage: 'Moved', assign: 'Assigned' };
  leads.forEach(l => (l.activities || []).forEach(x => {
    if (x.by !== email || !x.at || x.at < from || x.at >= to || x.type === 'system') return;
    const who = l.name || (l.emails && l.emails[0]) || 'a lead';
    ev.push({ at: x.at, kind: CONTACT_TYPES.includes(x.type) ? 'contact' : 'lead',
      text: `${LEAD_VERB[x.type] || x.type} ${who}${x.outcome ? ' (' + x.outcome + ')' : ''}${x.type === 'note' && x.text ? ': ' + x.text.slice(0, 120) : ''}` });
  }));
  ev.sort((a, b) => new Date(a.at) - new Date(b.at));
  // Gaps: an hour or more while timed in with nothing recorded, not counting
  // time under a break / lunch / field work / meeting status.
  const gaps = [];
  if (sd && sd.checkIn) {
    const start = +new Date(sd.checkIn);
    const end = sd.checkOut ? +new Date(sd.checkOut) : Math.min(Date.now(), +to);
    const log = (sd.stateLog || []).map(x => ({ s: x.state, a: +new Date(x.at) })).sort((a, b) => a.a - b.a);
    const away = log.map((x, i) => ({ s: x.s, a: x.a, b: log[i + 1] ? log[i + 1].a : end })).filter(x => ['break', 'lunch', 'field', 'meeting'].includes(x.s));
    const marks = ev.filter(e => e.kind !== 'state' && e.kind !== 'session').map(e => +new Date(e.at)).filter(t => t > start && t <= end).sort((a, b) => a - b);
    marks.push(end);
    let prev = start;
    marks.forEach(t => {
      let gap = t - prev;
      away.forEach(w => { gap -= Math.max(0, Math.min(t, w.b) - Math.max(prev, w.a)); });
      if (gap >= 60 * 60e3) gaps.push({ from: new Date(prev), to: new Date(t), min: Math.round(gap / 60e3) });
      prev = Math.max(prev, t);
    });
  }
  const counts = await countsFor(acc, from, to);
  counts.activeMin = (sd && sd.activeMin) || 0;
  return { day, account: { _id: acc._id, name: acc.name || acc.email }, staffDay: sd, events: ev, gaps, counts,
    activeByHour: (sd && sd.activeByHour) || {}, targets: targetsFor(cfg, accId) };
}

// Work the system already knows needs doing.
async function buildSuggestions() {
  const out = [];
  const endToday = new Date(dayStart(manilaDay()).getTime() + 864e5);
  const openKeys = new Set((await Task.find({ issueKey: { $ne: '' }, $or: [{ status: { $ne: 'done' } }, { review: 'submitted' }] }).select('issueKey').lean()).map(t => t.issueKey));
  const push = s => { if (!openKeys.has(s.issueKey)) out.push(s); };

  const leadName = l => l.name || (l.emails && l.emails[0]) || (l.phones && l.phones[0]) || 'a lead';
  // Only people who actually ASKED something (an enquiry, viewing or
  // valuation request) and have not been answered since. Newsletter sign-ups,
  // imported lists and manual adds used to fill this list and hide the
  // real enquiries. Same rule as the Leads tab's "waiting" badge.
  const waiting = await Lead.find({ archived: { $ne: true }, stage: { $nin: ['won', 'lost'] }, lastAskAt: { $ne: null, $gte: new Date(Date.now() - 60 * 864e5) },
    $expr: { $or: [{ $eq: [{ $ifNull: ['$lastContactAt', null] }, null] }, { $lt: ['$lastContactAt', '$lastAskAt'] }] } })
    .select('name emails phones type lastAskAt').sort({ lastAskAt: 1 }).limit(40).lean();
  waiting.forEach(l => push({
    group: 'Leads waiting for a reply', kind: 'lead', priority: 'high', issueKey: `lead:${l._id}:reply`,
    title: `Reply to ${leadName(l)} (${l.type})`, link: `/admin.html#leads`,
    description: `Asked us ${new Date(l.lastAskAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} and nobody has answered since. Open the Leads tab, find this person, call or message, and log it.`,
    since: l.lastAskAt
  }));

  const fu = await Lead.find({ archived: { $ne: true }, stage: { $nin: ['won', 'lost'] }, nextFollowUp: { $ne: null, $lt: endToday } })
    .select('name emails phones nextFollowUp followUpNote').sort({ nextFollowUp: 1 }).limit(40).lean();
  fu.forEach(l => push({
    group: 'Follow-ups due', kind: 'followup', priority: 'medium', issueKey: `lead:${l._id}:fu:${manilaDay(l.nextFollowUp)}`,
    title: `Follow up ${leadName(l)}`, link: `/admin.html#leads`, dueDate: l.nextFollowUp,
    description: l.followUpNote ? `Note: ${l.followUpNote}` : 'Follow-up date reached.', since: l.nextFollowUp
  }));

  const inq = await Inquiry.find({ handled: { $ne: true } }).select('name email propertyTitle createdAt').sort({ createdAt: 1 }).limit(40).lean();
  inq.forEach(q => push({
    group: 'Website enquiries not answered', kind: 'email', priority: 'high', issueKey: `inq:${q._id}`,
    title: `Answer ${q.name || q.email || 'an enquiry'}${q.propertyTitle ? ' about ' + q.propertyTitle : ''}`,
    description: 'Reply by email or phone, then mark it handled in the Inquiries tab.', since: q.createdAt
  }));

  const subs = await PropertySubmission.find({ status: 'pending' }).select('title submitterName createdAt').sort({ createdAt: 1 }).limit(30).lean();
  subs.forEach(s => push({
    group: 'Owner submissions to check and upload', kind: 'upload', priority: 'medium', issueKey: `sub:${s._id}`,
    title: `Check and upload "${s.title}"`, description: `Sent by ${s.submitterName || 'an owner'}. Review it in the Submissions tab.`, since: s.createdAt
  }));

  // Listings nobody has posted on Facebook in the last 30 days.
  const posted = new Set((await Task.find({ kind: 'facebook', propertyId: { $ne: null }, $or: [{ completedAt: { $gte: new Date(Date.now() - 30 * 864e5) } }, { status: { $ne: 'done' } }] })
    .select('propertyId').lean()).map(t => String(t.propertyId)));
  const avail = await Property.find({ status: 'available' }).select('title location listingType createdAt views').sort({ createdAt: -1 }).limit(200).lean();
  avail.filter(p => !posted.has(String(p._id))).slice(0, 12).forEach(p => push({
    group: 'Listings not posted on Facebook in 30 days', kind: 'facebook', priority: 'low', issueKey: `fb:${p._id}:${manilaDay().slice(0, 7)}`,
    title: `Post on Facebook: ${p.title}`, propertyId: p._id, link: `https://glrarealty.com/property/${p._id}`,
    description: `${p.listingType || ''} · ${p.location || ''}`, since: p.createdAt
  }));

  return out;
}

function registerStaffRoutes(app) {
  const view = [verifyToken, requirePermission('tasks_view')];
  const manage = [verifyToken, requirePermission('tasks_create')];

  // ── The boss's view ──
  app.get('/api/admin/staff/overview', ...manage, async (req, res) => {
    try {
      const [staff, cfg] = await Promise.all([staffList(), getConfig()]);
      const today = manilaDay();
      const since = manilaDay(Date.now() - 120 * 864e5);
      const out = [];
      for (const a of staff) {
        const [tasks, days] = await Promise.all([
          tasksFor(a._id, 60),
          StaffDay.find({ account: a._id, day: { $gte: since } }).sort({ day: -1 }).lean()
        ]);
        const td = days.find(d => d.day === today) || null;
        const [progress, unacked] = await Promise.all([
          progressFor(a, cfg, td),
          StaffMessage.countDocuments({ to: a._id, ackAt: null })
        ]);
        out.push({
          progress, unacked,
          _id: a._id, name: a.name || a.email.split('@')[0], email: a.email,
          lastSeen: a.lastSeen, presence: presence(a.lastSeen),
          today: td, recentDays: days.slice(0, 14),
          stats: scorecard(tasks, days),
          tasks
        });
      }
      const reviewQueue = await Task.find({ review: 'submitted', status: 'done' })
        .select(TASK_FIELDS).populate('assignedTo', 'name email').sort({ completedAt: 1 }).limit(100).lean();
      res.json({ today, staff: out, reviewQueue, config: cfg });
    } catch (err) { console.error('staff overview', err); res.status(500).json({ error: 'Server error' }); }
  });

  // ── The staff member's own desk ──
  app.get('/api/admin/staff/me', ...view, async (req, res) => {
    try {
      const me = await Account.findById(req.user.sub).select('name email role lastSeen').lean();
      const since = manilaDay(Date.now() - 120 * 864e5);
      const [tasks, days] = await Promise.all([
        tasksFor(req.user.sub, 30),
        StaffDay.find({ account: req.user.sub, day: { $gte: since } }).sort({ day: -1 }).lean()
      ]);
      const today = manilaDay();
      const td = days.find(d => d.day === today) || null;
      const cfg = await getConfig();
      const [progress, messages] = await Promise.all([
        progressFor(me, cfg, td),
        StaffMessage.find({ to: req.user.sub }).sort({ createdAt: -1 }).limit(60).lean()
      ]);
      // Opening the desk counts as reading what is on it.
      await StaffMessage.updateMany({ to: req.user.sub, readAt: null }, { $set: { readAt: new Date() } });
      res.json({ today, me, day: td, recentDays: days.slice(0, 14), stats: scorecard(tasks, days), tasks, progress, messages, config: cfg });
    } catch (err) { console.error('staff me', err); res.status(500).json({ error: 'Server error' }); }
  });

  // Time in / time out / status / plan / report — always for today, always your own.
  app.post('/api/admin/staff/day', ...view, async (req, res) => {
    try {
      const b = req.body || {};
      const day = manilaDay();
      const set = {};
      const now = new Date();
      if (b.action === 'in') { set.checkIn = now; set.checkOut = null; set.state = 'working'; set.stateAt = now; set.stateNote = ''; }
      if (b.action === 'out') { set.checkOut = now; set.state = 'off'; set.stateAt = now; set.stateNote = ''; }
      if (b.state !== undefined && STATES.includes(b.state)) { set.state = b.state; set.stateAt = now; set.stateNote = clean(b.stateNote, 200); }
      if (b.plan !== undefined) set.plan = clean(b.plan, 2000);
      if (b.report !== undefined) set.report = clean(b.report, 4000);
      if (b.blockers !== undefined) set.blockers = clean(b.blockers, 2000);
      if (b.mood !== undefined) set.mood = Math.max(0, Math.min(5, parseInt(b.mood, 10) || 0));
      const existing = await StaffDay.findOne({ account: req.user.sub, day }).lean();
      if (b.action === 'in' && existing && existing.checkIn) delete set.checkIn;   // first time-in of the day stands
      if (set.state && set.state !== 'off' && !(existing && existing.checkIn) && !set.checkIn) set.checkIn = now;
      const upd = { $set: set };
      if (set.state) upd.$push = { stateLog: { $each: [{ state: set.state, note: set.stateNote || '', at: now }], $slice: -60 } };
      const doc = await StaffDay.findOneAndUpdate({ account: req.user.sub, day }, upd, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
      if (b.action) await logAudit(req, b.action === 'in' ? 'TIME_IN' : 'TIME_OUT', 'StaffDay', doc._id, day, null);
      res.json(doc);
    } catch (err) { console.error('staff day', err); res.status(500).json({ error: 'Server error' }); }
  });

  // Past days: your own, or anyone's for a manager.
  app.get('/api/admin/staff/days', ...view, async (req, res) => {
    try {
      let acc = req.user.sub;
      if (req.query.account && req.query.account !== req.user.sub) {
        if (!(await managerCheck(req))) return res.status(403).json({ error: 'Not allowed' });
        if (!mongoose.isValidObjectId(req.query.account)) return res.status(400).json({ error: 'Bad account' });
        acc = req.query.account;
      }
      const n = Math.min(120, Math.max(1, parseInt(req.query.days, 10) || 30));
      const days = await StaffDay.find({ account: acc, day: { $gte: manilaDay(Date.now() - n * 864e5) } }).sort({ day: -1 }).lean();
      res.json(days);
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.put('/api/admin/staff/days/:id/note', ...manage, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const d = await StaffDay.findByIdAndUpdate(req.params.id, { $set: { bossNote: clean(req.body.note, 2000) } }, { new: true }).lean();
      if (!d) return res.status(404).json({ error: 'Not found' });
      res.json(d);
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── Hand out tasks (one or many) ──
  app.post('/api/admin/staff/tasks', ...manage, async (req, res) => {
    try {
      const list = Array.isArray(req.body.tasks) ? req.body.tasks.slice(0, 200) : [];
      if (!list.length) return res.status(400).json({ error: 'No tasks' });
      const { created, skipped } = await createStaffTasks(list, req.user.sub);
      if (created.length) await logAudit(req, 'CREATE', 'Task', created[0]._id, created.length === 1 ? created[0].title : `${created.length} staff tasks`, null);
      res.json({ created, skipped });
    } catch (err) { console.error('staff tasks', err); res.status(500).json({ error: 'Server error' }); }
  });

  // ── Work a task: start / tick / stuck / submit / approve / return / reopen ──
  app.post('/api/admin/staff/tasks/:id/act', ...view, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const task = await Task.findById(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const mgr = await managerCheck(req);
      const mine = (task.assignedTo || []).some(a => a.toString() === req.user.sub) || task.createdBy.toString() === req.user.sub;
      if (!mgr && !mine) return res.status(403).json({ error: 'Not your task' });
      const b = req.body || {};
      const now = new Date();
      const who = req.user.name || req.user.email || '';
      const note = text => task.updates.push({ author: req.user.sub, authorName: who, authorEmail: req.user.email || '', text: clean(text, 2000), createdAt: now });
      let spawned = null;

      // An approved task is closed: only the boss can change it again.
      if (task.review === 'approved' && !mgr && ['start', 'check', 'stuck', 'submit', 'reopen'].includes(b.action)) {
        return res.status(403).json({ error: 'This task was checked and approved. Ask the boss if it needs more work.' });
      }
      switch (b.action) {
        case 'start':
          task.status = 'in_progress'; if (!task.startedAt) task.startedAt = now;
          // Working on it again takes it out of the boss's "to check" list.
          if (['returned', 'submitted'].includes(task.review)) task.review = '';
          task.completedAt = null;
          break;
        case 'check': {
          const i = parseInt(b.idx, 10);
          if (!task.checklist[i]) return res.status(400).json({ error: 'No such step' });
          task.checklist[i].done = !!b.done; task.checklist[i].doneAt = b.done ? now : null;
          if (b.done && task.status === 'todo') { task.status = 'in_progress'; if (!task.startedAt) task.startedAt = now; }
          break;
        }
        case 'stuck':
          task.status = 'stuck'; task.completedAt = null;
          if (task.review === 'submitted') task.review = '';
          note('Stuck: ' + (clean(b.reason, 1500) || 'no reason given'));
          break;
        case 'comment':
          if (!clean(b.text, 2000)) return res.status(400).json({ error: 'Write something' });
          note(b.text);
          break;
        case 'submit': {
          task.proofUrl = cleanUrl(b.proofUrl) || task.proofUrl;
          // Checked here too, not only in the browser's Done box.
          if (PROOF_KINDS.includes(task.kind) && !hasProofLink(task) && req.user.role !== 'admin') {
            return res.status(400).json({ error: 'Paste the link to the post (or the listing page) to prove it is done.' });
          }
          task.status = 'done'; task.completedAt = now;
          if (!task.startedAt) task.startedAt = now;
          task.proofNote = clean(b.proofNote, 1000);
          // A manager finishing their own task does not need to check it.
          task.review = (mgr && req.user.role === 'admin') ? 'approved' : 'submitted';
          if (task.review === 'approved') task.reviewedAt = now;
          note('Marked done' + (task.proofNote ? ': ' + task.proofNote : '') + (task.proofUrl ? ` (${task.proofUrl})` : ''));
          spawned = await spawnNextTask(task);
          break;
        }
        case 'approve':
          if (!mgr) return res.status(403).json({ error: 'Only the boss can approve' });
          task.review = 'approved'; task.reviewedAt = now; task.reviewNote = clean(b.note, 1000);
          if (task.status !== 'done') { task.status = 'done'; task.completedAt = now; }
          note('Checked and approved' + (task.reviewNote ? ': ' + task.reviewNote : ''));
          spawned = await spawnNextTask(task);
          break;
        case 'return':
          if (!mgr) return res.status(403).json({ error: 'Only the boss can send a task back' });
          task.review = 'returned'; task.reviewedAt = now; task.reviewNote = clean(b.note, 1000) || 'Please look at this again';
          task.status = 'todo'; task.completedAt = null;
          note('Sent back: ' + task.reviewNote);
          break;
        case 'reopen':
          // Once the boss has approved it, only the boss can reopen it.
          if (task.review === 'approved' && !mgr) return res.status(403).json({ error: 'This task was checked and approved. Ask the boss to reopen it.' });
          task.status = 'todo'; task.completedAt = null; task.review = '';
          break;
        case 'snooze': {
          if (!mgr) return res.status(403).json({ error: 'Only the boss can move a due date' });
          task.dueDate = b.dueDate && !isNaN(new Date(b.dueDate)) ? new Date(b.dueDate) : null;
          break;
        }
        default:
          return res.status(400).json({ error: 'Unknown action' });
      }
      await task.save();
      if (['submit', 'approve', 'return', 'stuck'].includes(b.action)) await logAudit(req, 'TASK_' + b.action.toUpperCase(), 'Task', task._id, task.title, null);
      const fresh = await Task.findById(task._id).select(TASK_FIELDS).populate('createdBy', 'name email').populate('assignedTo', 'name email').lean();
      res.json({ task: fresh, spawned });
    } catch (err) { console.error('staff act', err); res.status(500).json({ error: 'Server error' }); }
  });

  // ── Active time: one ping a minute while the dashboard is on screen and
  // being used. Two open tabs still count as one minute (the 50 s check).
  app.post('/api/admin/staff/pulse', ...view, async (req, res) => {
    try {
      const now = new Date();
      const hour = String(new Date(now.getTime() + 8 * 3600e3).getUTCHours());
      const doc = await StaffDay.findOneAndUpdate(
        { account: req.user.sub, day: manilaDay(), checkIn: { $ne: null }, $or: [{ lastPulse: null }, { lastPulse: { $lt: new Date(now.getTime() - 50e3) } }] },
        { $inc: { activeMin: 1, ['activeByHour.' + hour]: 1 }, $set: { lastPulse: now } },
        { new: true, projection: { activeMin: 1 } }).lean();
      if (doc) return res.json({ ok: true, activeMin: doc.activeMin });
      const day = await StaffDay.findOne({ account: req.user.sub, day: manilaDay() }).select('checkIn').lean();
      res.json({ ok: false, timedIn: !!(day && day.checkIn) });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── Settings: posting channels and one person's daily targets ──
  app.get('/api/admin/staff/config', ...view, async (req, res) => {
    try { res.json(await getConfig()); } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.put('/api/admin/staff/config', ...manage, async (req, res) => {
    try {
      const cur = await getConfig();
      const b = req.body || {};
      const next = { channels: cur.channels, targets: { ...cur.targets } };
      if (Array.isArray(b.channels)) {
        const seen = new Set();
        next.channels = b.channels.slice(0, 12).map(c => ({
          key: clean(c && c.key, 12).toUpperCase().replace(/[^A-Z0-9]/g, ''),
          col: clean(c && c.col, 40),
          label: clean(c && c.label, 40),
          every: Math.max(0, Math.min(365, parseInt(c && c.every, 10) || 0))
        })).filter(c => c.key && c.label && !seen.has(c.key) && seen.add(c.key));
        if (!next.channels.length) return res.status(400).json({ error: 'Keep at least one channel' });
      }
      if (b.targets && mongoose.isValidObjectId(b.targets.account)) {
        const n = (v, max) => Math.max(0, Math.min(max, parseInt(v, 10) || 0));
        next.targets[String(b.targets.account)] = { posts: n(b.targets.posts, 200), contacts: n(b.targets.contacts, 500), tasks: n(b.targets.tasks, 100), activeMin: n(b.targets.activeMin, 720) };
      }
      await Setting.findOneAndUpdate({ key: 'staff_config' }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
      await logAudit(req, 'UPDATE', 'StaffSettings', '', b.targets ? 'daily targets' : 'posting channels', null);
      res.json(next);
    } catch (err) { console.error('staff config', err); res.status(500).json({ error: 'Server error' }); }
  });

  // ── Posting board ──
  app.get('/api/admin/staff/postings', ...view, async (req, res) => {
    try {
      const [cfg, postings] = await Promise.all([
        getConfig(),
        StaffPosting.find({ postedAt: { $gte: new Date(Date.now() - 400 * 864e5) } })
          .select('property channel url note postedAt source by byName').sort({ postedAt: -1 }).limit(8000).lean()
      ]);
      res.json({ channels: cfg.channels, postings });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.post('/api/admin/staff/postings', ...view, async (req, res) => {
    try {
      const b = req.body || {};
      const cfg = await getConfig();
      const ch = cfg.channels.find(c => c.key === String(b.channel || ''));
      if (!ch) return res.status(400).json({ error: 'Unknown channel' });
      if (!mongoose.isValidObjectId(b.propertyId)) return res.status(400).json({ error: 'Pick a listing' });
      const prop = await Property.findById(b.propertyId).select('title').lean();
      if (!prop) return res.status(404).json({ error: 'Listing not found' });
      const url = cleanUrl(b.url);
      if (!url) return res.status(400).json({ error: 'Paste the link to the post (it is the proof)' });
      let postedAt = b.postedAt && !isNaN(new Date(b.postedAt)) ? new Date(b.postedAt) : new Date();
      if (postedAt > new Date(Date.now() + 5 * 60e3) || postedAt < new Date(Date.now() - 60 * 864e5)) postedAt = new Date();
      const me = await Account.findById(req.user.sub).select('name email').lean();
      const doc = await StaffPosting.create({ property: prop._id, channel: ch.key, url, note: clean(b.note, 500), postedAt,
        by: req.user.sub, byName: (me && (me.name || me.email)) || '' });
      await logAudit(req, 'POSTED', 'Listing', String(prop._id), `${prop.title} · ${ch.label}`, { url });
      res.json(doc);
    } catch (err) { console.error('staff posting', err); res.status(500).json({ error: 'Server error' }); }
  });
  // Ticks copied from the GLRA Management System sheet: recorded once per
  // listing and channel, marked as from Excel (no link, so not counted as work).
  app.post('/api/admin/staff/postings/import', ...manage, async (req, res) => {
    try {
      const cfg = await getConfig();
      const keys = new Set(cfg.channels.map(c => c.key));
      const rows = (Array.isArray(req.body.rows) ? req.body.rows : []).slice(0, 2000)
        .filter(r => r && keys.has(String(r.channel)) && mongoose.isValidObjectId(r.propertyId));
      let added = 0;
      for (const r of rows) {
        if (await StaffPosting.exists({ property: r.propertyId, channel: String(r.channel) })) continue;
        if (!(await Property.exists({ _id: r.propertyId }))) continue;
        await StaffPosting.create({ property: r.propertyId, channel: String(r.channel), source: 'excel',
          note: 'Ticked in the GLRA Management System sheet', postedAt: new Date(), byName: 'Excel sheet' });
        added++;
      }
      await logAudit(req, 'IMPORT', 'StaffPosting', '', `${added} ticks from Excel`, null);
      res.json({ added });
    } catch (err) { console.error('staff posting import', err); res.status(500).json({ error: 'Server error' }); }
  });
  app.delete('/api/admin/staff/postings/:id', ...view, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const p = await StaffPosting.findById(req.params.id);
      if (!p) return res.status(404).json({ error: 'Not found' });
      const mgr = await managerCheck(req);
      // Staff may take back their own entry the same day (a wrong link); after that only the boss can.
      const own = p.by && p.by.toString() === req.user.sub && Date.now() - p.createdAt.getTime() < 864e5;
      if (!mgr && !own) return res.status(403).json({ error: "Ask Ma'am to remove it" });
      await p.deleteOne();
      await logAudit(req, 'DELETE', 'StaffPosting', req.params.id, p.channel, { url: p.url });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── Work log: everything one person did on one day, in order ──
  app.get('/api/admin/staff/activity', ...view, async (req, res) => {
    try {
      let accId = req.user.sub;
      if (req.query.account && req.query.account !== req.user.sub) {
        if (!(await managerCheck(req))) return res.status(403).json({ error: 'Not allowed' });
        if (!mongoose.isValidObjectId(req.query.account)) return res.status(400).json({ error: 'Bad account' });
        accId = req.query.account;
      }
      const out = await buildActivity(accId, req.query.day);
      if (!out) return res.status(404).json({ error: 'Not found' });
      res.json(out);
    } catch (err) { console.error('staff activity', err); res.status(500).json({ error: 'Server error' }); }
  });

  // ── Messages from the boss ──
  app.get('/api/admin/staff/messages', ...view, async (req, res) => {
    try {
      let to = req.user.sub;
      if (req.query.account && req.query.account !== req.user.sub) {
        if (!(await managerCheck(req))) return res.status(403).json({ error: 'Not allowed' });
        if (!mongoose.isValidObjectId(req.query.account)) return res.status(400).json({ error: 'Bad account' });
        to = req.query.account;
      }
      res.json(await StaffMessage.find({ to }).sort({ createdAt: -1 }).limit(200).lean());
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.post('/api/admin/staff/messages', ...manage, async (req, res) => {
    try {
      const list = Array.isArray(req.body.messages) ? req.body.messages.slice(0, 100) : [req.body];
      const me = await Account.findById(req.user.sub).select('name email').lean();
      const staffIds = new Set((await staffList()).map(a => String(a._id)));
      const made = [];
      for (const m of list) {
        const text = clean(m && m.text, 3000);
        if (!text || !staffIds.has(String(m.to))) continue;
        made.push(await StaffMessage.create({ to: m.to, from: req.user.sub, fromName: (me && (me.name || me.email)) || "Ma'am",
          kind: ['note', 'fix', 'warning', 'praise'].includes(m.kind) ? m.kind : 'note', text,
          propertyId: mongoose.isValidObjectId(m.propertyId) ? m.propertyId : null }));
      }
      if (!made.length) return res.status(400).json({ error: 'Write a message and pick who it is for' });
      await logAudit(req, 'CREATE', 'StaffMessage', made[0]._id, made.length === 1 ? made[0].text.slice(0, 80) : `${made.length} messages`, null);
      res.json({ sent: made.length, messages: made });
    } catch (err) { console.error('staff message', err); res.status(500).json({ error: 'Server error' }); }
  });
  app.post('/api/admin/staff/messages/:id/ack', ...view, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const m = await StaffMessage.findById(req.params.id);
      if (!m) return res.status(404).json({ error: 'Not found' });
      if (m.to.toString() !== req.user.sub) return res.status(403).json({ error: 'Not your message' });
      const now = new Date();
      m.ackAt = m.ackAt || now; m.readAt = m.readAt || now;
      if (req.body && req.body.reply !== undefined) m.reply = clean(req.body.reply, 1000);
      await m.save();
      await logAudit(req, 'STAFF_ACK', 'StaffMessage', m._id, m.text.slice(0, 80), m.reply ? { reply: m.reply } : null);
      res.json(m);
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });
  app.delete('/api/admin/staff/messages/:id', ...manage, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const m = await StaffMessage.findByIdAndDelete(req.params.id);
      if (!m) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── Suggestions: work the system already knows needs doing ──
  app.get('/api/admin/staff/suggestions', ...manage, async (req, res) => {
    try {
      res.json(await buildSuggestions());
    } catch (err) { console.error('staff suggestions', err); res.status(500).json({ error: 'Server error' }); }
  });
}

module.exports = { registerStaffRoutes, manilaDay, dayStart, scorecard, nextDue, spawnNextTask, PROOF_KINDS, hasProofLink, KINDS, TASK_FIELDS, getConfig, countsFor, progressFor,
  staffList, createStaffTasks, buildActivity, buildSuggestions, tasksFor };
