// =============================================================================
// CLOUD SUPERVISOR — the API a scheduled Claude agent uses to run the staff desk
// =============================================================================
// Rafael (30 Sept 2026) set up a cloud agent that, every working day:
//   * 8 am: checks everything the staff member did the working day before,
//     verifies the proof, writes a report that is emailed to the bosses, and
//     tells the staff member what was good and what must be fixed
//   * 9 am: hands out the day's tasks
// The agent signs in with one key (header x-glra-bot-key), made in the Staff
// tab by an admin and shown once. Only its SHA-256 is stored. The key can
// read the staff desk, hand out tasks, send desk messages, mark its check on
// a finished task and file reports: nothing else in the dashboard.
// =============================================================================
const crypto = require('crypto');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { Setting, Task, DeletedTask, StaffDay, StaffPosting, StaffMessage, StaffReport, Property, Account, AuditLog, Lead } = require('./db');
const rules = require('./staff-rules');
const { verifyToken, requireAdmin, logAudit } = require('./auth');
const staff = require('./staff');

const KEY_SETTING = 'staff_bot';
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const isEmail = e => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(String(e || ''));

async function botSettings() {
  const d = await Setting.findOne({ key: KEY_SETTING }).lean();
  return (d && d.value) || {};
}
async function saveBotSettings(patch) {
  const cur = await botSettings();
  await Setting.findOneAndUpdate({ key: KEY_SETTING }, { $set: { value: { ...cur, ...patch }, updatedAt: new Date() } }, { upsert: true });
}

// The working day before `day` (Mon -> Fri). Manila days, YYYY-MM-DD.
function prevWorkday(day) {
  const d = new Date(day + 'T12:00:00+08:00');
  do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(new Date(d.getTime() + 8 * 3600e3).getUTCDay()));
  return staff.manilaDay(d);
}

// Working days from `a` to `b` (Manila days); negative if b is before a.
function workdaysBetween(a, b) {
  if (a === b) return 0;
  const sign = b > a ? 1 : -1;
  let n = 0;
  const d = new Date(a + 'T12:00:00+08:00');
  for (let i = 0; i < 400; i++) {
    d.setUTCDate(d.getUTCDate() + sign);
    const k = staff.manilaDay(d);
    if (rules.isWorkday(d)) n += sign;
    if (k === b) return n;
  }
  return n;
}

// Plain report text -> email HTML. "# " heading, "- " bullet, **bold**; all escaped.
function reportHtml(text, esc) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:680px">
<p style="font-size:12px;color:#777;margin:0 0 12px">GLRA Realty · Cloud supervisor</p>
${String(text).split('\n').map(l => {
  const e = esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  if (/^#\s/.test(l)) return `<h3 style="margin:18px 0 6px;font-size:16px">${e.replace(/^#\s/, '')}</h3>`;
  if (/^-\s/.test(l)) return `<div style="margin:2px 0 2px 14px">&bull; ${e.replace(/^-\s/, '')}</div>`;
  return l.trim() ? `<p style="margin:6px 0">${e}</p>` : '';
}).join('\n')}
<p style="margin-top:22px"><a href="https://glrarealty.com/admin.html" style="color:#de3500">Open the Staff tab</a></p></div>`;
}

function registerStaffBot(app, { sendEmail, esc }) {
  const botLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
    keyGenerator: () => 'staff-bot', message: { error: 'Too many requests' } });

  async function botAuth(req, res, next) {
    try {
      const key = String(req.get('x-glra-bot-key') || '');
      const s = await botSettings();
      if (!key || !s.keyHash || s.enabled === false) return res.status(401).json({ error: 'Bad key' });
      const a = Buffer.from(sha(key)), b = Buffer.from(String(s.keyHash));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad key' });
      req.user = { sub: '', email: 'cloud-supervisor', name: 'Cloud supervisor', role: 'bot' };
      if (!s.lastUsedAt || Date.now() - new Date(s.lastUsedAt).getTime() > 60e3) saveBotSettings({ lastUsedAt: new Date() }).catch(() => {});
      next();
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
  }
  const bot = [botLimiter, botAuth];

  // ── Admin: make / revoke the key, choose who gets the reports ──
  app.get('/api/admin/staff-bot', verifyToken, requireAdmin, async (req, res) => {
    try {
      const s = await botSettings();
      const reports = await StaffReport.find().sort({ createdAt: -1 }).limit(40).lean();
      res.json({ hasKey: !!s.keyHash, enabled: s.enabled !== false, keyMadeAt: s.keyMadeAt || null, keyHint: s.keyHint || '',
        lastUsedAt: s.lastUsedAt || null, reportEmails: s.reportEmails || [], alertsEnabled: s.alertsEnabled !== false, reports });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
  });
  app.post('/api/admin/staff-bot/key', verifyToken, requireAdmin, async (req, res) => {
    try {
      const key = 'glra_sb_' + crypto.randomBytes(32).toString('hex');
      await saveBotSettings({ keyHash: sha(key), keyHint: key.slice(-4), keyMadeAt: new Date(), enabled: true, lastUsedAt: null });
      await logAudit(req, 'CREATE', 'StaffBotKey', '', 'cloud supervisor key', null);
      // Shown this once; only the hash is kept.
      res.json({ key });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
  });
  app.delete('/api/admin/staff-bot/key', verifyToken, requireAdmin, async (req, res) => {
    try {
      await saveBotSettings({ keyHash: '', keyHint: '', enabled: false });
      await logAudit(req, 'DELETE', 'StaffBotKey', '', 'cloud supervisor key', null);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
  });
  app.put('/api/admin/staff-bot/settings', verifyToken, requireAdmin, async (req, res) => {
    try {
      // The alert emails can be switched on and off on their own.
      if (req.body && typeof req.body.alertsEnabled === 'boolean' && req.body.reportEmails === undefined) {
        await saveBotSettings({ alertsEnabled: req.body.alertsEnabled });
        await logAudit(req, 'UPDATE', 'StaffBotSettings', '', req.body.alertsEnabled ? 'alerts on' : 'alerts off', null);
        return res.json({ alertsEnabled: req.body.alertsEnabled });
      }
      const list = (Array.isArray(req.body.reportEmails) ? req.body.reportEmails : String(req.body.reportEmails || '').split(/[\s,;]+/))
        .map(e => String(e).trim().toLowerCase()).filter(isEmail);
      const reportEmails = [...new Set(list)].slice(0, 10);
      await saveBotSettings({ reportEmails });
      await logAudit(req, 'UPDATE', 'StaffBotSettings', '', 'report recipients', { reportEmails });
      res.json({ reportEmails });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
  });

  // ── The agent: one call gives it everything to check ──
  // ?day=YYYY-MM-DD | today | prev (the working day before today; default)
  app.get('/api/staff-bot/snapshot', ...bot, async (req, res) => {
    try {
      const today = staff.manilaDay();
      const q = String(req.query.day || 'prev');
      const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : q === 'today' ? today : prevWorkday(today);
      const from = staff.dayStart(day), to = new Date(from.getTime() + 864e5);
      const cfg = await staff.getConfig();
      const people = await staff.staffList();
      const allPostings = await StaffPosting.find({ source: { $ne: 'excel' }, postedAt: { $gte: new Date(Date.now() - 120 * 864e5) } })
        .select('property channel url postedAt by').lean();
      // A link used for more than one listing/channel is not proof of two posts.
      const urlUse = {};
      allPostings.forEach(p => { const k = String(p.url).split('?')[0].replace(/\/+$/, '').toLowerCase(); (urlUse[k] = urlUse[k] || new Set()).add(String(p.property) + '|' + p.channel); });
      const reused = u => { const k = String(u).split('?')[0].replace(/\/+$/, '').toLowerCase(); return urlUse[k] && urlUse[k].size > 1; };

      const out = [];
      for (const a of people) {
        const [activity, todayDoc, openTasks, doneOnDay, postsOnDay, messages, recentDays] = await Promise.all([
          staff.buildActivity(a._id, day),
          StaffDay.findOne({ account: a._id, day: today }).lean(),
          Task.find({ assignedTo: a._id, status: { $ne: 'done' } }).select(staff.TASK_FIELDS).sort({ dueDate: 1 }).limit(200).lean(),
          Task.find({ assignedTo: a._id, status: 'done', completedAt: { $gte: from, $lt: to } }).select(staff.TASK_FIELDS).lean(),
          StaffPosting.find({ by: a._id, source: { $ne: 'excel' }, postedAt: { $gte: from, $lt: to } }).populate('property', 'title').lean(),
          StaffMessage.find({ to: a._id }).sort({ createdAt: -1 }).limit(25).lean(),
          StaffDay.find({ account: a._id }).sort({ day: -1 }).limit(6).select('day checkIn checkOut plan report blockers mood bossNote activeMin').lean()
        ]);
        const progress = await staff.progressFor(a, cfg, todayDoc);
        // Oct 2026 extras: the exact time record, every audit event, deleted
        // tasks and each lead contact on the day, so the checker can verify more.
        const email = String(a.email || '').toLowerCase();
        const [dayAudit, deletedOnDay, leadsOnDay, score5] = await Promise.all([
          AuditLog.find({ timestamp: { $gte: from, $lt: to }, $or: [{ actor: email }, { action: { $in: ['TASK_DELETED', 'TASK_DUE_CHANGED', 'TASK_REOPENED'] } }] })
            .select('actor actorName action target targetId targetTitle changes timestamp').sort({ timestamp: 1 }).limit(400).lean(),
          DeletedTask.find({ deletedAt: { $gte: from, $lt: to }, $or: [{ assignedTo: a._id }, { deletedBy: String(a._id) }] }).select('-copy').lean(),
          Lead.find({ 'activities.by': email, 'activities.at': { $gte: from, $lt: to } }).select('name emails phones activities').limit(300).lean(),
          staff.dashboardFor(a, 5)
        ]);
        const contactsOnDay = [];
        leadsOnDay.forEach(l => (l.activities || []).forEach(x => {
          if (x.by !== email || !x.at || x.at < from || x.at >= to || !staff.CONTACT_TYPES.includes(x.type)) return;
          contactsOnDay.push({ leadId: String(l._id), lead: l.name || (l.emails && l.emails[0]) || 'a lead', email: (l.emails || [])[0] || '', phone: (l.phones || [])[0] || '',
            how: x.type, at: x.at, outcome: x.outcome || '', note: String(x.text || '').slice(0, 300), hasOutcome: !!(String(x.outcome || '').trim() || String(x.text || '').trim().length >= 5) });
        }));
        const flags = [];
        doneOnDay.forEach(t => {
          if (!t.proofUrl && !t.proofNote) flags.push(`Task "${t.title}" marked done with no proof link or note`);
          const open = (t.checklist || []).filter(c => !c.done).length;
          if (open) flags.push(`Task "${t.title}" marked done with ${open} step(s) not ticked`);
        });
        postsOnDay.forEach(p => { if (reused(p.url)) flags.push(`Post link reused for another listing or channel: ${p.url}`); });
        postsOnDay.forEach(p => { const c = rules.checkProofUrl(p.url, /^SM/.test(p.channel) ? 'fb' : ''); if (!c.ok && p.channel !== 'ATS') flags.push(`Post link is not a single post (${c.reason}): ${p.url}`); });
        doneOnDay.forEach(t => {
          if ((t.closeFlags || []).includes('bulk')) flags.push(`Task "${t.title}" was closed in a batch with others within minutes`);
          if ((t.closeFlags || []).includes('self_made')) flags.push(`Task "${t.title}" was made by the staff member for themselves`);
        });
        deletedOnDay.forEach(d => flags.push(`Task deleted: "${d.title}" by ${d.deletedByName || 'someone'}${d.reason ? ' (' + d.reason + ')' : ''}`));
        const tr = activity && activity.timeRecord;
        if (tr && !tr.timedIn && rules.isWorkday(staff.dayStart(day).getTime() + 12 * 3600e3)) flags.push('No time-in on this working day');
        if (tr && tr.timedIn && (tr.autoOut || tr.noReport)) flags.push(tr.autoOut ? 'No time-out: the day was closed by the system at 18:30' : 'Timed out without an end-of-day report');
        if (tr && tr.idleMin >= 60) flags.push(`${tr.idleMin} min idle while timed in (${tr.idle.map(x => x.from + '-' + x.to).join(', ')})`);
        if (tr && tr.untimedMin) flags.push(`${tr.untimedMin} min of dashboard use while NOT timed in`);
        contactsOnDay.filter(c => !c.hasOutcome).forEach(c => flags.push(`Contact with ${c.lead} (${c.how}) logged with no outcome`));
        const lateOpen = openTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date());
        out.push({
          id: String(a._id), name: a.name || a.email, email: a.email, lastSeen: a.lastSeen,
          targets: progress.targets, todaySoFar: progress.today, last7days: progress.week,
          day: activity, todayStatus: todayDoc ? { checkIn: todayDoc.checkIn, checkOut: todayDoc.checkOut, state: todayDoc.state, activeMin: todayDoc.activeMin } : null,
          tasksFinishedOnDay: doneOnDay.map(t => ({ id: String(t._id), title: t.title, kind: t.kind, completedAt: t.completedAt, dueDate: t.dueDate, proofUrl: t.proofUrl, proofNote: t.proofNote,
            steps: (t.checklist || []).map(c => ({ text: c.text, done: c.done })), review: t.review, propertyId: t.propertyId, botCheck: t.botCheck,
            proofCheck: t.proofCheck || null, proofChannel: t.proofChannel || '', screenshots: (t.proofShots || []).map(x => x.url), closeFlags: t.closeFlags || [] })),
          postsOnDay: postsOnDay.map(p => ({ id: String(p._id), listing: p.property && p.property.title, propertyId: p.property && String(p.property._id), channel: p.channel, url: p.url, postedAt: p.postedAt, note: p.note, reusedLink: reused(p.url) })),
          openTasks: openTasks.map(t => ({ id: String(t._id), title: t.title, kind: t.kind, status: t.status, dueDate: t.dueDate, late: !!(t.dueDate && new Date(t.dueDate) < new Date()), review: t.review, reviewNote: t.reviewNote, recurrence: t.recurrence, propertyId: t.propertyId, issueKey: t.issueKey,
            dueDay: t.dueDate ? staff.manilaDay(t.dueDate) : null, workdaysUntilDue: t.dueDate ? workdaysBetween(today, staff.manilaDay(t.dueDate)) : null, dueProblem: rules.dueProblem(t.dueDate) || '' })),
          lateTaskCount: lateOpen.length,
          messages: messages.map(m => ({ id: String(m._id), kind: m.kind, from: m.fromName, text: m.text.slice(0, 400), sentAt: m.createdAt, seenAt: m.readAt, gotItAt: m.ackAt, reply: m.reply })),
          recentDays,
          flags,
          // Added Oct 2026 (old fields above are unchanged):
          timeRecord: tr || null,
          contactsOnDay,
          deletedTasks: deletedOnDay.map(d => ({ id: d.taskId, title: d.title, kind: d.kind, status: d.status, dueDate: d.dueDate, deletedAt: d.deletedAt, by: d.deletedByName, reason: d.reason })),
          audit: dayAudit.filter(x => x.actor === email || (x.changes && JSON.stringify(x.changes).includes(String(a._id))) || x.action === 'TASK_DELETED')
            .map(x => ({ action: x.action, by: x.actorName || x.actor, target: x.target, targetId: x.targetId, title: x.targetTitle, at: x.timestamp, changes: x.changes })),
          score5days: { rag: score5.rag, signals: score5.signals, targets: score5.targets, actual: score5.actual, percent: score5.percent, daysWorked: score5.daysWorked, hoursWorked: score5.hoursWorked, idleMin: score5.idleMin, grades: score5.grades }
        });
      }

      // Listings, with where and when each was last posted (real posts only).
      const props = await Property.find({ status: 'available' })
        .select('title location listingType propertyType price monthlyRental sqm landArea bedrooms bathrooms gallery description createdAt editedAt reviewedAt priceUpdatedAt geo.status').lean();
      const last = {};
      allPostings.forEach(p => { const k = String(p.property) + '|' + p.channel; if (!last[k] || p.postedAt > last[k]) last[k] = p.postedAt; });
      const listings = props.map(p => ({
        id: String(p._id), title: p.title, location: p.location, listingType: p.listingType, propertyType: p.propertyType,
        price: p.price, monthlyRental: p.monthlyRental, sqm: p.sqm, landArea: p.landArea, bedrooms: p.bedrooms, bathrooms: p.bathrooms,
        photos: (p.gallery || []).length, descriptionLength: String(p.description || '').length, mapFound: p.geo && p.geo.status === 'ok',
        createdAt: p.createdAt, lastEdited: p.editedAt, lastConfirmedAvailable: p.reviewedAt,
        lastPosted: Object.fromEntries(cfg.channels.map(c => [c.key, last[String(p._id) + '|' + c.key] || null])),
        url: `https://glrarealty.com/property/${p._id}`
      }));
      const reports = await StaffReport.find().sort({ createdAt: -1 }).limit(6).select('kind day subject text createdAt').lean();
      res.json({
        now: new Date(), today, checkedDay: day, workHours: rules.WORK_TEXT,
        workHoursDetail: { days: 'Mon-Fri', start: '09:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00', timezone: 'Asia/Manila', noDueBetween: '12:01-12:59' },
        channels: cfg.channels, staff: out, waitingWork: await staff.buildSuggestions(), listings,
        previousReports: reports.map(r => ({ ...r, text: String(r.text).slice(0, 3000) }))
      });
    } catch (err) { console.error('staff bot snapshot', err); res.status(500).json({ error: 'Server error' }); }
  });

  // Hand out the day's tasks. createdBy is the first admin (a task needs a person).
  app.post('/api/staff-bot/tasks', ...bot, async (req, res) => {
    try {
      const staffIds = new Set((await staff.staffList()).map(a => String(a._id)));
      const admin = await Account.findOne({ role: 'admin' }).sort({ createdAt: 1 }).select('_id').lean();
      if (!admin) return res.status(500).json({ error: 'No admin account' });
      const today = staff.manilaDay();
      const tooFar = [];
      const list = (Array.isArray(req.body.tasks) ? req.body.tasks : []).slice(0, 40).filter(t => {
        // A daily plan is for the next two weeks at most (Oct 2026: a task due
        // 12 Oct turned up in a Friday plan).
        if (t && t.dueDate && !isNaN(new Date(t.dueDate)) && workdaysBetween(today, staff.manilaDay(t.dueDate)) > 10) { tooFar.push({ title: String(t.title || '').slice(0, 200), why: 'Due more than 10 working days away; not part of a daily plan' }); return false; }
        return true;
      }).map(t => ({
        ...t, category: 'Daily plan',
        assignedTo: (Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo]).filter(id => staffIds.has(String(id))),
        // The desk's own recurring tasks are set up by the boss, not the agent.
        recurrence: ''
      })).filter(t => t.assignedTo.length);
      if (!list.length) return res.status(400).json({ error: 'No tasks for a staff member', skipped: tooFar });
      const { created, skipped } = await staff.createStaffTasks(list, admin._id);
      skipped.push(...tooFar);
      if (created.length) await logAudit(req, 'CREATE', 'Task', created[0]._id, `${created.length} tasks from the cloud supervisor`, null);
      res.json({ created: created.map(t => ({ id: String(t._id), title: t.title })), skipped });
    } catch (err) { console.error('staff bot tasks', err); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/staff-bot/messages', ...bot, async (req, res) => {
    try {
      const staffIds = new Set((await staff.staffList()).map(a => String(a._id)));
      const made = [];
      for (const m of (Array.isArray(req.body.messages) ? req.body.messages : []).slice(0, 30)) {
        const text = clean(m && m.text, 3000);
        if (!text || !staffIds.has(String(m.to))) continue;
        made.push(await StaffMessage.create({ to: m.to, fromName: 'Cloud supervisor',
          kind: ['note', 'fix', 'warning', 'praise'].includes(m.kind) ? m.kind : 'note', text,
          propertyId: mongoose.isValidObjectId(m.propertyId) ? m.propertyId : null }));
      }
      if (!made.length) return res.status(400).json({ error: 'No message for a staff member' });
      await logAudit(req, 'CREATE', 'StaffMessage', made[0]._id, `${made.length} messages from the cloud supervisor`, null);
      res.json({ sent: made.length });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // The agent's verdict on a finished task (shown on the task card for the boss).
  app.post('/api/staff-bot/tasks/:id/check', ...bot, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const verdict = ['ok', 'problem'].includes(req.body.verdict) ? req.body.verdict : '';
      if (!verdict) return res.status(400).json({ error: 'verdict must be ok or problem' });
      const note = clean(req.body.note, 1000);
      const t = await Task.findById(req.params.id);
      if (!t) return res.status(404).json({ error: 'Not found' });
      t.botCheck = { verdict, note, at: new Date() };
      t.updates.push({ author: t.createdBy, authorName: 'Cloud supervisor', text: `Checked: ${verdict === 'ok' ? 'OK' : 'PROBLEM'}${note ? ' - ' + note : ''}`, createdAt: new Date() });
      await t.save();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // File a report; it is kept for the Staff tab and emailed to the bosses.
  // Plain text; lines starting "# " become headings, "- " bullets, **x** bold.
  app.post('/api/staff-bot/report', ...bot, async (req, res) => {
    try {
      const b = req.body || {};
      const subject = clean(b.subject, 200) || 'Staff report';
      const text = clean(b.text, 20000);
      if (!text) return res.status(400).json({ error: 'Empty report' });
      const s = await botSettings();
      const to = [...(s.reportEmails || [])];
      if (b.alsoEmailStaffId && mongoose.isValidObjectId(b.alsoEmailStaffId)) {
        const p = (await staff.staffList()).find(a => String(a._id) === String(b.alsoEmailStaffId));
        if (p && isEmail(p.email)) to.push(p.email);
      }
      const html = reportHtml(text, esc);
      const sent = [];
      for (const addr of [...new Set(to)]) {
        const r = await sendEmail(addr, subject, html, 'GLRA Cloud supervisor');
        if (r && r.success) sent.push(addr);
      }
      const rep = await StaffReport.create({ kind: ['morning', 'plan', 'evening'].includes(b.kind) ? b.kind : 'other',
        day: /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? b.day : staff.manilaDay(), subject, text, emailedTo: sent });
      res.json({ id: String(rep._id), emailedTo: sent, recipients: to.length });
    } catch (err) { console.error('staff bot report', err); res.status(500).json({ error: 'Server error' }); }
  });
}

// ── FRIDAY WEEKLY SCORE ─────────────────────────────────────
// Every Friday after 6:30 pm Manila: the week in numbers for each staff member,
// emailed to the report list and kept with the supervisor's reports. Worked
// out from the records, so it arrives even if the cloud agent did not run.
async function weeklyScoreText(mondayDay) {
  // Oct 2026: built on the same numbers as the Staff tab's dashboard, so the
  // weekly score and the daily figures agree. Only real staff accounts (the
  // ones not marked "not staff"); days and hours come from the time record
  // (lunch not paid), posts count only with a real post link.
  const { StaffReport: SR } = require('./db');
  const from = staff.dayStart(mondayDay), now = new Date();
  const days = [0, 1, 2, 3, 4].map(i => staff.manilaDay(new Date(from.getTime() + i * 864e5 + 12 * 3600e3)));
  const people = await staff.staffList();
  void SR;
  const lines = [];
  for (const a of people) {
    const d = await staff.dashboardFor(a, 5, days);
    const late = d.timeRecords.filter(r => r.late);
    const pct = k => d.percent[k] == null ? '-' : d.percent[k] + '%';
    const unacked = await StaffMessage.countDocuments({ to: a._id, ackAt: null });
    const noReport = d.timeRecords.filter(r => r.timedIn && (r.noReport || r.autoOut)).length;
    lines.push(`# ${a.name || a.email}  (${d.rag.toUpperCase()})`,
      `- Days worked: **${d.daysWorked} of ${d.days.length}**${late.length ? ` (late ${late.length}x: ${late.map(r => r.day.slice(5) + ' by ' + r.lateMin + ' min').join(', ')})` : ''}`,
      `- Hours worked (lunch not counted): **${d.hoursWorked} h**; active in the dashboard **${(d.actual.activeMin / 60).toFixed(1)} h**; idle while timed in **${(d.idleMin / 60).toFixed(1)} h**`,
      `- Posts with a real post link: **${d.actual.posts}** (target ${d.targets.posts}, ${pct('posts')})`,
      `- Leads contacted with an outcome: **${d.actual.contacts}** (target ${d.targets.contacts}, ${pct('contacts')})`,
      `- Tasks finished with proof: **${d.actual.tasks}** (target ${d.targets.tasks}, ${pct('tasks')})`,
      `- Tasks now late: **${d.lateTasks.length}**; tasks deleted: **${d.deletedTasks.length}**; messages not answered: **${unacked}**; days without time-out or report: **${noReport}**`,
      `- Leads waiting for a reply: **${d.unansweredLeads.oneToTwo + d.unansweredLeads.threePlus}** older than a working day (${d.unansweredLeads.threePlus} three days or more)`,
      d.grades.length ? `- Daily grades from the morning checks: **${d.grades.map(x => x.day.slice(5) + ' ' + x.grade).join(', ')}**` : '- No graded mornings this week yet.',
      ...(d.signals.length ? ['- Watch: ' + d.signals.map(x => x.text).join('; ')] : []),
      '');
  }
  if (!people.length) lines.push('No staff accounts to score.');
  void now;
  return { text: `Week of ${days[0]} to ${days[4]}. Work hours: ${rules.WORK_TEXT}.\n\n` + lines.join('\n'), subject: `Weekly score: ${days[0]} to ${days[4]}` };
}
function startWeeklyScore({ sendEmail, esc }) {
  const tick = async () => {
    try {
      const m = new Date(Date.now() + 8 * 3600e3);
      if (m.getUTCDay() !== 5 || m.getUTCHours() * 60 + m.getUTCMinutes() < 18 * 60 + 30) return;   // after the 18:00 end of the week
      const today = staff.manilaDay();
      const monday = staff.manilaDay(new Date(staff.dayStart(today).getTime() - 4 * 864e5 + 12 * 3600e3));
      const key = 'staff_weekly_' + monday;
      if (await Setting.exists({ key })) return;
      await Setting.create({ key, value: { at: new Date() } });   // claim first, so two instances do not both send
      const { text, subject } = await weeklyScoreText(monday);
      const s = await botSettings();
      const sent = [];
      for (const addr of s.reportEmails || []) { const r = await sendEmail(addr, subject, reportHtml(text, esc), 'GLRA Cloud supervisor'); if (r && r.success) sent.push(addr); }
      await StaffReport.create({ kind: 'weekly', day: today, subject, text, emailedTo: sent });
      console.log('Weekly staff score sent to', sent.length);
    } catch (e) { console.error('weekly score:', e.message); }
  };
  setTimeout(tick, 90e3);
  setInterval(tick, 10 * 60e3);
}

// ── THE WORKING DAY, RUN BY THE SERVER (Oct 2026) ───────────
// Every 5 minutes on working days:
//   * 12:00 someone still "working" is put on lunch; 13:00 back to working
//     (only if the server put them there).
//   * 18:30 a day nobody timed out of is closed: time-out = the last minute
//     they were active (or 18:00), marked autoOut, and noReport if there is no
//     end-of-day report. Days worked and hours are then right.
//   * Alerts to the bosses (the report list), each event once, batched into
//     one email per round: no time-in by 9:30, 2 hours with no activity while
//     timed in, a task deleted, a proof link that fails, a lead unanswered for
//     more than a working day (once a day at 10:00), no time-out or report.
// Alerts can be switched off in the Staff tab (Cloud supervisor settings).
async function claimOnce(key) {
  try { await Setting.create({ key: 'staff_alert:' + key, value: { at: new Date() } }); return true; }
  catch (e) { return false; }   // already claimed (unique key) - sent before
}
async function runWorkdayRound({ sendEmail, esc }) {
  const now = new Date();
  const c = rules.manilaClock(now);
  if (!rules.isWorkday(now)) return { skipped: 'weekend' };
  const day = c.day;
  const people = await staff.staffList();
  const ids = people.map(p => p._id);
  const alerts = [];
  // 1. Lunch on and off.
  if (c.min >= rules.WORK.lunchStart && c.min < rules.WORK.lunchEnd) {
    const sds = await StaffDay.find({ account: { $in: ids }, day, checkIn: { $ne: null }, checkOut: null, state: 'working' }).lean();
    for (const sd of sds) await StaffDay.updateOne({ _id: sd._id }, { $set: { state: 'lunch', stateAt: now, stateNote: 'Lunch (automatic)' }, $push: { stateLog: { $each: [{ state: 'lunch', note: 'automatic', at: now }], $slice: -60 } } });
  } else if (c.min >= rules.WORK.lunchEnd && c.min < rules.WORK.lunchEnd + 30) {
    const sds = await StaffDay.find({ account: { $in: ids }, day, checkOut: null, state: 'lunch', stateNote: 'Lunch (automatic)' }).lean();
    for (const sd of sds) await StaffDay.updateOne({ _id: sd._id }, { $set: { state: 'working', stateAt: now, stateNote: '' }, $push: { stateLog: { $each: [{ state: 'working', note: 'automatic', at: now }], $slice: -60 } } });
  }
  // 2. Close days nobody timed out of.
  if (c.min >= rules.WORK.end + 30) {
    const open = await StaffDay.find({ account: { $in: ids }, day, checkIn: { $ne: null }, checkOut: null }).lean();
    for (const sd of open) {
      const end18 = new Date(staff.dayStart(day).getTime() + rules.WORK.end * 60e3);
      const last = sd.lastPulse && new Date(sd.lastPulse) > new Date(sd.checkIn) ? new Date(Math.min(new Date(sd.lastPulse).getTime(), now.getTime())) : end18;
      const noReport = String(sd.report || '').replace(/[-*\s]/g, '').length < 20;
      await StaffDay.updateOne({ _id: sd._id, checkOut: null }, { $set: { checkOut: last, state: 'off', stateAt: now, autoOut: true, noReport } });
      const p = people.find(x => String(x._id) === String(sd.account));
      if (await claimOnce(`autoout:${sd.account}:${day}`)) alerts.push(`- **${(p && (p.name || p.email)) || 'Staff'}** did not time out today; the day was closed at ${rules.hm(rules.manilaClock(last).min)}${noReport ? ' and there is **no end-of-day report**' : ''}.`);
    }
  }
  // 3. No time-in by 9:30.
  if (c.min >= 9 * 60 + 30 && c.min < rules.WORK.end) {
    for (const p of people) {
      const sd = await StaffDay.findOne({ account: p._id, day }).select('checkIn').lean();
      if (!(sd && sd.checkIn) && await claimOnce(`notin:${p._id}:${day}`)) alerts.push(`- **${p.name || p.email}** has not timed in yet today (it is ${rules.hm(c.min)}).`);
    }
  }
  // 4. Two hours with nothing while timed in (lunch and away statuses excluded).
  if (rules.isWorkMinute(c.min)) {
    for (const p of people) {
      const sd = await StaffDay.findOne({ account: p._id, day, checkIn: { $ne: null }, checkOut: null }).lean();
      if (!sd || ['break', 'lunch', 'field', 'meeting'].includes(sd.state)) continue;
      const lastAct = await staff.progressFor(p, await staff.getConfig(), sd).then(x => x.lastActionAt).catch(() => null);
      const lastMs = Math.max(sd.lastPulse ? +new Date(sd.lastPulse) : 0, lastAct ? +new Date(lastAct) : 0, +new Date(sd.checkIn));
      // Lunch inside the window is not counted against them.
      const quietMin = rules.workedMinutes(new Date(lastMs), now);
      if (quietMin >= 120 && await claimOnce(`quiet:${p._id}:${day}:${Math.floor(c.min / 120)}`)) alerts.push(`- **${p.name || p.email}** has been timed in but shown no activity for **${Math.floor(quietMin / 60)} h ${quietMin % 60} min** (status: ${sd.state || 'working'}).`);
    }
  }
  // 5. Tasks deleted since the last round.
  const delSince = new Date(now.getTime() - 24 * 3600e3);
  for (const d of await DeletedTask.find({ deletedAt: { $gte: delSince } }).select('-copy').lean()) {
    if (await claimOnce(`del:${d.taskId}`)) alerts.push(`- Task **deleted**: "${d.title}" by ${d.deletedByName || 'someone'} at ${rules.hm(rules.manilaClock(d.deletedAt).min)}${d.reason ? ' — reason: ' + d.reason : ' — no reason given'}.`);
  }
  // 6. Proof that failed a check (the cloud supervisor's verdict, or the server's own).
  for (const t of await Task.find({ updatedAt: { $gte: delSince }, $or: [{ 'botCheck.verdict': 'problem' }, { 'proofCheck.ok': false }] }).select('title botCheck proofCheck proofUrl').lean()) {
    if (await claimOnce(`proof:${t._id}`)) alerts.push(`- Proof failed for "${t.title}": ${(t.botCheck && t.botCheck.verdict === 'problem' && t.botCheck.note) || (t.proofCheck && t.proofCheck.reason) || 'the link does not show the work'}${t.proofUrl ? ` (${t.proofUrl})` : ''}.`);
  }
  // 7. Leads unanswered for more than one working day (once a day, from 10:00).
  if (c.min >= 10 * 60 && await claimOnce(`leads:${day}`)) {
    const oneWorkdayAgo = new Date(staff.dayStart(prevWorkday(day)).getTime() + c.min * 60e3);
    const waiting = await Lead.find({ archived: { $ne: true }, stage: { $nin: ['won', 'lost'] }, lastAskAt: { $ne: null, $lt: oneWorkdayAgo, $gte: new Date(Date.now() - 60 * 864e5) },
      $expr: { $or: [{ $eq: [{ $ifNull: ['$lastContactAt', null] }, null] }, { $lt: ['$lastContactAt', '$lastAskAt'] }] } }).select('name emails lastAskAt').sort({ lastAskAt: 1 }).limit(20).lean();
    if (waiting.length) alerts.push(`- **${waiting.length} lead${waiting.length === 1 ? '' : 's'}** asked more than a working day ago and nobody has answered: ` + waiting.map(l => `${l.name || (l.emails && l.emails[0]) || 'a lead'} (${staff.manilaDay(l.lastAskAt).slice(5)})`).join(', ') + '.');
  }
  if (!alerts.length) return { alerts: 0 };
  const s = await botSettings();
  if (s.alertsEnabled === false) return { alerts: alerts.length, sent: 0, off: true };
  const text = `# Staff alerts · ${day} ${rules.hm(c.min)}\n` + alerts.join('\n');
  const subject = `Staff alert: ${alerts.length === 1 ? alerts[0].replace(/^- /, '').replace(/\*\*/g, '').slice(0, 90) : alerts.length + ' things need a look'}`;
  const sent = [];
  for (const addr of s.reportEmails || []) { const r = await sendEmail(addr, subject, reportHtml(text, esc), 'GLRA Staff alerts'); if (r && r.success) sent.push(addr); }
  await StaffReport.create({ kind: 'alert', day, subject, text, emailedTo: sent });
  return { alerts: alerts.length, sent: sent.length };
}
function startWorkdayRounds(deps) {
  const tick = () => runWorkdayRound(deps).catch(e => console.error('staff round:', e.message));
  setTimeout(tick, 120e3);
  setInterval(tick, 5 * 60e3);
}

module.exports = { registerStaffBot, prevWorkday, startWeeklyScore, weeklyScoreText, startWorkdayRounds, runWorkdayRound, workdaysBetween };
