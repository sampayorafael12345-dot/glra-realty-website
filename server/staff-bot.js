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
const { Setting, Task, StaffDay, StaffPosting, StaffMessage, StaffReport, Property, Account } = require('./db');
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
        lastUsedAt: s.lastUsedAt || null, reportEmails: s.reportEmails || [], reports });
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
        const flags = [];
        doneOnDay.forEach(t => {
          if (!t.proofUrl && !t.proofNote) flags.push(`Task "${t.title}" marked done with no proof link or note`);
          const open = (t.checklist || []).filter(c => !c.done).length;
          if (open) flags.push(`Task "${t.title}" marked done with ${open} step(s) not ticked`);
        });
        postsOnDay.forEach(p => { if (reused(p.url)) flags.push(`Post link reused for another listing or channel: ${p.url}`); });
        const lateOpen = openTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date());
        out.push({
          id: String(a._id), name: a.name || a.email, email: a.email, lastSeen: a.lastSeen,
          targets: progress.targets, todaySoFar: progress.today, last7days: progress.week,
          day: activity, todayStatus: todayDoc ? { checkIn: todayDoc.checkIn, checkOut: todayDoc.checkOut, state: todayDoc.state, activeMin: todayDoc.activeMin } : null,
          tasksFinishedOnDay: doneOnDay.map(t => ({ id: String(t._id), title: t.title, kind: t.kind, completedAt: t.completedAt, dueDate: t.dueDate, proofUrl: t.proofUrl, proofNote: t.proofNote,
            steps: (t.checklist || []).map(c => ({ text: c.text, done: c.done })), review: t.review, propertyId: t.propertyId, botCheck: t.botCheck })),
          postsOnDay: postsOnDay.map(p => ({ id: String(p._id), listing: p.property && p.property.title, propertyId: p.property && String(p.property._id), channel: p.channel, url: p.url, postedAt: p.postedAt, note: p.note, reusedLink: reused(p.url) })),
          openTasks: openTasks.map(t => ({ id: String(t._id), title: t.title, kind: t.kind, status: t.status, dueDate: t.dueDate, late: !!(t.dueDate && new Date(t.dueDate) < new Date()), review: t.review, reviewNote: t.reviewNote, recurrence: t.recurrence, propertyId: t.propertyId, issueKey: t.issueKey })),
          lateTaskCount: lateOpen.length,
          messages: messages.map(m => ({ id: String(m._id), kind: m.kind, from: m.fromName, text: m.text.slice(0, 400), sentAt: m.createdAt, seenAt: m.readAt, gotItAt: m.ackAt, reply: m.reply })),
          recentDays,
          flags
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
        now: new Date(), today, checkedDay: day, workHours: 'Mon-Fri 9:00-17:00 Asia/Manila',
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
      const list = (Array.isArray(req.body.tasks) ? req.body.tasks : []).slice(0, 40).map(t => ({
        ...t, category: 'Daily plan',
        assignedTo: (Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo]).filter(id => staffIds.has(String(id))),
        // The desk's own recurring tasks are set up by the boss, not the agent.
        recurrence: ''
      })).filter(t => t.assignedTo.length);
      if (!list.length) return res.status(400).json({ error: 'No tasks for a staff member' });
      const { created, skipped } = await staff.createStaffTasks(list, admin._id);
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
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:680px">
<p style="font-size:12px;color:#777;margin:0 0 12px">GLRA Realty · Cloud supervisor</p>
${text.split('\n').map(l => {
  const e = esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  if (/^#\s/.test(l)) return `<h3 style="margin:18px 0 6px;font-size:16px">${e.replace(/^#\s/, '')}</h3>`;
  if (/^-\s/.test(l)) return `<div style="margin:2px 0 2px 14px">&bull; ${e.replace(/^-\s/, '')}</div>`;
  return l.trim() ? `<p style="margin:6px 0">${e}</p>` : '';
}).join('\n')}
<p style="margin-top:22px"><a href="https://glrarealty.com/admin.html" style="color:#de3500">Open the Staff tab</a></p></div>`;
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

module.exports = { registerStaffBot, prevWorkday };
