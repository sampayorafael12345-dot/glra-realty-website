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
//
// Permissions: staff use tasks_view (their own desk); handing out, checking
// and reading everyone's desk needs tasks_create.
// =============================================================================
const mongoose = require('mongoose');
const { Task, StaffDay, Account, Lead, Inquiry, PropertySubmission, Property } = require('./db');
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

const TASK_FIELDS = 'title description kind status priority dueDate assignedTo createdBy completedAt startedAt checklist propertyId issueKey link proofUrl proofNote recurrence review reviewNote reviewedAt points category reference updates createdAt updatedAt';

async function tasksFor(accountId, sinceDays) {
  const since = new Date(Date.now() - (sinceDays || 60) * 864e5);
  return Task.find({ assignedTo: accountId, $or: [{ status: { $ne: 'done' } }, { completedAt: { $gte: since } }, { review: 'submitted' }] })
    .select(TASK_FIELDS).populate('createdBy', 'name email').sort({ dueDate: 1, createdAt: 1 }).limit(800).lean();
}

// Next due date for a repeating task, counted from the old due date (or now
// if it was already overdue, so a late finish does not stack up a backlog).
function nextDue(from, rule) {
  const base = new Date(Math.max(from ? new Date(from).getTime() : 0, Date.now()));
  const d = new Date(base);
  if (rule === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (rule === 'weekdays') { do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(new Date(d.getTime() + 8 * 3600e3).getUTCDay())); }
  else if (rule === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (rule === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  // Keep the time of day it was originally due.
  if (from) { const f = new Date(from); d.setUTCHours(f.getUTCHours(), f.getUTCMinutes(), 0, 0); }
  return d;
}

function registerStaffRoutes(app) {
  const view = [verifyToken, requirePermission('tasks_view')];
  const manage = [verifyToken, requirePermission('tasks_create')];

  // Everyone the boss can hand work to: active employees (not agents, who
  // have their own workspace, and not pending sign-ups).
  async function staffList() {
    return Account.find({ role: 'employee', isActive: { $ne: false }, status: { $ne: 'pending' } })
      .select('name email role lastSeen lastLogin').sort({ name: 1 }).lean();
  }

  // ── The boss's view ──
  app.get('/api/admin/staff/overview', ...manage, async (req, res) => {
    try {
      const staff = await staffList();
      const today = manilaDay();
      const since = manilaDay(Date.now() - 120 * 864e5);
      const out = [];
      for (const a of staff) {
        const [tasks, days] = await Promise.all([
          tasksFor(a._id, 60),
          StaffDay.find({ account: a._id, day: { $gte: since } }).sort({ day: -1 }).lean()
        ]);
        const td = days.find(d => d.day === today) || null;
        out.push({
          _id: a._id, name: a.name || a.email.split('@')[0], email: a.email,
          lastSeen: a.lastSeen, presence: presence(a.lastSeen),
          today: td, recentDays: days.slice(0, 14),
          stats: scorecard(tasks, days),
          tasks
        });
      }
      const reviewQueue = await Task.find({ review: 'submitted' })
        .select(TASK_FIELDS).populate('assignedTo', 'name email').sort({ completedAt: 1 }).limit(100).lean();
      res.json({ today, staff: out, reviewQueue });
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
      res.json({ today, me, day: days.find(d => d.day === today) || null, recentDays: days.slice(0, 14), stats: scorecard(tasks, days), tasks });
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
      const doc = await StaffDay.findOneAndUpdate({ account: req.user.sub, day }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
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
      const created = [], skipped = [];
      for (const t of list) {
        const title = clean(t.title, 200);
        if (!title) { skipped.push({ title: '', why: 'No title' }); continue; }
        const issueKey = clean(t.issueKey, 120);
        if (issueKey) {
          const dup = await Task.findOne({ issueKey, $or: [{ status: { $ne: 'done' } }, { review: 'submitted' }] }).select('_id').lean();
          if (dup) { skipped.push({ title, why: 'Already given out' }); continue; }
        }
        const assignedTo = (Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo]).filter(id => mongoose.isValidObjectId(id));
        const task = await Task.create({
          title,
          description: clean(t.description, 5000),
          category: clean(t.category || 'Staff', 60),
          kind: KINDS.includes(t.kind) ? t.kind : 'other',
          priority: ['low', 'medium', 'high', 'critical'].includes(t.priority) ? t.priority : 'medium',
          assignedTo,
          dueDate: t.dueDate ? new Date(t.dueDate) : null,
          checklist: (Array.isArray(t.checklist) ? t.checklist : []).map(x => clean(typeof x === 'string' ? x : x && x.text, 300)).filter(Boolean).slice(0, 30).map(text => ({ text })),
          propertyId: mongoose.isValidObjectId(t.propertyId) ? t.propertyId : null,
          issueKey,
          link: clean(t.link, 500),
          reference: clean(t.reference, 200),
          recurrence: RECUR.includes(t.recurrence) ? t.recurrence : '',
          points: Math.max(0, Math.min(20, parseInt(t.points, 10) || 1)),
          createdBy: req.user.sub
        });
        created.push(task);
      }
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

      switch (b.action) {
        case 'start':
          task.status = 'in_progress'; if (!task.startedAt) task.startedAt = now;
          if (task.review === 'returned') task.review = '';
          break;
        case 'check': {
          const i = parseInt(b.idx, 10);
          if (!task.checklist[i]) return res.status(400).json({ error: 'No such step' });
          task.checklist[i].done = !!b.done; task.checklist[i].doneAt = b.done ? now : null;
          if (b.done && task.status === 'todo') { task.status = 'in_progress'; if (!task.startedAt) task.startedAt = now; }
          break;
        }
        case 'stuck':
          task.status = 'stuck';
          note('Stuck: ' + (clean(b.reason, 1500) || 'no reason given'));
          break;
        case 'comment':
          if (!clean(b.text, 2000)) return res.status(400).json({ error: 'Write something' });
          note(b.text);
          break;
        case 'submit': {
          task.status = 'done'; task.completedAt = now;
          if (!task.startedAt) task.startedAt = now;
          task.proofUrl = cleanUrl(b.proofUrl) || task.proofUrl;
          task.proofNote = clean(b.proofNote, 1000);
          // A manager finishing their own task does not need to check it.
          task.review = (mgr && req.user.role === 'admin') ? 'approved' : 'submitted';
          if (task.review === 'approved') task.reviewedAt = now;
          note('Marked done' + (task.proofNote ? ': ' + task.proofNote : '') + (task.proofUrl ? ` (${task.proofUrl})` : ''));
          if (task.recurrence) {
            spawned = await Task.create({
              title: task.title, description: task.description, category: task.category, kind: task.kind,
              priority: task.priority, assignedTo: task.assignedTo, createdBy: task.createdBy,
              dueDate: nextDue(task.dueDate, task.recurrence), checklist: task.checklist.map(c => ({ text: c.text })),
              propertyId: task.propertyId, link: task.link, reference: task.reference,
              recurrence: task.recurrence, points: task.points
            });
          }
          break;
        }
        case 'approve':
          if (!mgr) return res.status(403).json({ error: 'Only the boss can approve' });
          task.review = 'approved'; task.reviewedAt = now; task.reviewNote = clean(b.note, 1000);
          if (task.status !== 'done') { task.status = 'done'; task.completedAt = now; }
          note('Checked and approved' + (task.reviewNote ? ': ' + task.reviewNote : ''));
          break;
        case 'return':
          if (!mgr) return res.status(403).json({ error: 'Only the boss can send a task back' });
          task.review = 'returned'; task.reviewedAt = now; task.reviewNote = clean(b.note, 1000) || 'Please look at this again';
          task.status = 'todo'; task.completedAt = null;
          note('Sent back: ' + task.reviewNote);
          break;
        case 'reopen':
          task.status = 'todo'; task.completedAt = null; task.review = '';
          break;
        case 'snooze': {
          if (!mgr) return res.status(403).json({ error: 'Only the boss can move a due date' });
          task.dueDate = b.dueDate ? new Date(b.dueDate) : null;
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

  // ── Suggestions: work the system already knows needs doing ──
  app.get('/api/admin/staff/suggestions', ...manage, async (req, res) => {
    try {
      const out = [];
      const endToday = new Date(dayStart(manilaDay()).getTime() + 864e5);
      const openKeys = new Set((await Task.find({ issueKey: { $ne: '' }, $or: [{ status: { $ne: 'done' } }, { review: 'submitted' }] }).select('issueKey').lean()).map(t => t.issueKey));
      const push = s => { if (!openKeys.has(s.issueKey)) out.push(s); };

      const leadName = l => l.name || (l.emails && l.emails[0]) || (l.phones && l.phones[0]) || 'a lead';
      const waiting = await Lead.find({ archived: { $ne: true }, stage: { $nin: ['won', 'lost'] }, firstInboundAt: { $ne: null }, firstResponseAt: null })
        .select('name emails phones type firstInboundAt').sort({ firstInboundAt: 1 }).limit(40).lean();
      waiting.forEach(l => push({
        group: 'Leads waiting for a first reply', kind: 'lead', priority: 'high', issueKey: `lead:${l._id}:reply`,
        title: `Reply to ${leadName(l)} (${l.type})`, link: `/admin.html#leads`,
        description: `Came in ${new Date(l.firstInboundAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} and nobody has answered yet. Open the Leads tab, find this person, call or message, and log it.`,
        since: l.firstInboundAt
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

      res.json(out);
    } catch (err) { console.error('staff suggestions', err); res.status(500).json({ error: 'Server error' }); }
  });
}

module.exports = { registerStaffRoutes, manilaDay, scorecard, nextDue, KINDS };
