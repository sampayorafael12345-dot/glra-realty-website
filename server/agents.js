// =============================================================================
// AGENT WORKSPACE — API + daily reminder engine
// =============================================================================
// The server side of public/agent.html, built from the "GLRA Agent System"
// workbook (GPS goal math, action checklists, lead journal, pipeline) plus the
// owner's asks: calendar, notifications, email, and client birthdays on leads.
//
// Access model, in one line: every /api/agent/* route requires a signed-in
// account whose role is 'agent' OR 'admin' (the broker has full access and can
// use the workspace as her own) and only ever reads/writes records where
// { account: req.user.sub } — nobody sees anyone else's data, and an agent has
// zero admin permissions so the admin portal rejects them entirely. Admin-side
// routes (/api/admin/agents*) are strictly requireAdmin — employees never.
//
// Registered from server.js:
//   const { registerAgentRoutes, startAgentTick } = require('./server/agents');
//   registerAgentRoutes(app, { sendEmail, esc, handleValidation });
//   startAgentTick({ sendEmail, esc });
// =============================================================================
const crypto = require('crypto');
const { body } = require('express-validator');
const {
  Account, Inquiry,
  AgentProfile, AgentAction, AgentLead, AgentEvent, AgentNotification,
  AGENT_LEAD_STAGES
} = require('./db');
const { verifyToken, requireAdmin, logAudit } = require('./auth');
const { getEmailHeader, getEmailFooter } = require('./email-templates');

const SITE_URL = 'https://glrarealty.com';

// ── ACTION DEFINITIONS ───────────────────────────────────────
// Verbatim from the workbook's Actions sheet (12 daily, 8 weekly, 8 monthly).
// ids are stable — quantities in AgentAction docs are keyed by them.
const ACTION_DEFS = {
  daily: [
    { id: 'd1',  text: '[Seller] Post a \u2018looking for sellers\u2019 flyer on FB / IG / TikTok' },
    { id: 'd2',  text: '[Seller] Engage on posts of people wanting to sell' },
    { id: 'd3',  text: '[Seller] Call a friend / acquaintance who may be selling' },
    { id: 'd4',  text: '[Seller] Talk to a co-agent about a possible listing' },
    { id: 'd5',  text: '[Seller] Email / message a previous seller lead' },
    { id: 'd6',  text: '[Seller] Ask a past client for a seller referral' },
    { id: 'd7',  text: '[Buyer] Post a featured listing on Marketplace / Lamudi / Carousell' },
    { id: 'd8',  text: '[Buyer] Engage on posts of people looking to buy / rent' },
    { id: 'd9',  text: '[Buyer] Call names from the buyer masterlist' },
    { id: 'd10', text: '[Buyer] Reply to all inquiries within the hour' },
    { id: 'd11', text: '[Buyer] Send a matching listing to a warm buyer' },
    { id: 'd12', text: '[Buyer] Follow up buyers who viewed but haven\u2019t decided' }
  ],
  weekly: [
    { id: 'w1', text: 'Launch 1 SELLER-focused FB / Command campaign' },
    { id: 'w2', text: 'Launch 1 BUYER-focused FB / Command campaign' },
    { id: 'w3', text: 'Send a circle-touch message to the farming list' },
    { id: 'w4', text: 'Review & refresh ALL active listings' },
    { id: 'w5', text: 'Plan next week\u2019s content calendar' },
    { id: 'w6', text: 'Review the pipeline & advance stalled deals' },
    { id: 'w7', text: 'Send a weekly market update to the database' },
    { id: 'w8', text: 'Prepare 1 listing presentation' }
  ],
  monthly: [
    { id: 'm1', text: 'Host 1 open house' },
    { id: 'm2', text: 'Review budget & P&L vs GPS targets' },
    { id: 'm3', text: 'Send value content to the FULL database (36-touch batch)' },
    { id: 'm4', text: 'Publish 1 monthly success-story reel' },
    { id: 'm5', text: 'Prospect expired / withdrawn listings' },
    { id: 'm6', text: 'Ask for referrals from recent closings' },
    { id: 'm7', text: 'Update the masterlist / database tagging' },
    { id: 'm8', text: 'Meet the broker for coaching & review' }
  ]
};
const ALL_ACTION_IDS = new Set(
  [...ACTION_DEFS.daily, ...ACTION_DEFS.weekly, ...ACTION_DEFS.monthly].map(a => a.id)
);

// ── MANILA TIME ──────────────────────────────────────────────
// The Philippines is UTC+8 with no daylight saving, so "Manila now" is just a
// fixed shift; reading the shifted date with getUTC* gives Manila wall-clock.
function manilaNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function pad2(n) { return String(n).padStart(2, '0'); }
function dayKeyOf(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function monthKeyOf(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; }
// ISO-8601 week (Monday-based) — matches the workbook's "this week".
function weekKeyOf(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // nearest Thursday decides the year
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((t - firstThu) / (7 * 24 * 3600 * 1000));
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}
function currentKeys() {
  const now = manilaNow();
  return { daily: dayKeyOf(now), weekly: weekKeyOf(now), monthly: monthKeyOf(now) };
}
// Start-of-period instants (real UTC Dates) for counting "leads this week" etc.
function manilaPeriodStarts() {
  const now = manilaNow();
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const shift = 8 * 3600 * 1000;
  const dayStart = new Date(Date.UTC(y, m, d) - shift);
  const monday = new Date(Date.UTC(y, m, d - ((now.getUTCDay() + 6) % 7)) - shift);
  const monthStart = new Date(Date.UTC(y, m, 1) - shift);
  const yearStart = new Date(Date.UTC(y, 0, 1) - shift);
  return { dayStart, monday, monthStart, yearStart };
}
// Calendar-date string of a stored date-only value (they're saved as UTC midnight).
function utcDateKey(d) { return d ? new Date(d).toISOString().slice(0, 10) : null; }

// ── GPS MATH — replicates the workbook exactly ───────────────
function computeGPS(p) {
  const c = p.conv || {};
  const safe = v => (Number(v) > 0 ? Number(v) : 1);
  const perPeriod = yearly => ({
    yearly,
    monthly: yearly / safe(p.workDaysYear) * safe(p.workDaysMonth),
    weekly: yearly / safe(p.workDaysYear) * safe(p.workDaysWeek),
    daily: yearly / safe(p.workDaysYear)
  });
  const deals = safe(p.annualGCI) / safe(p.avgCommission);
  const sellerSold = deals;
  const sellerTaken = sellerSold / safe(c.sellerTakenToSold);
  const sellerAppts = sellerTaken / safe(c.sellerApptToTaken);
  const sellerContacts = sellerAppts / safe(c.sellerContactToAppt);
  const sellerLeads = sellerContacts / safe(c.sellerLeadToContact);
  const buyerClosed = deals;
  const buyerViewings = buyerClosed / safe(c.buyerViewingToClose);
  const buyerContacts = buyerViewings / safe(c.buyerContactToViewing);
  const buyerLeads = buyerContacts / safe(c.buyerLeadToContact);
  return {
    gci: perPeriod(safe(p.annualGCI)),
    seller: {
      sold: perPeriod(sellerSold), taken: perPeriod(sellerTaken),
      appointments: perPeriod(sellerAppts), contacts: perPeriod(sellerContacts), leads: perPeriod(sellerLeads)
    },
    buyer: {
      closed: perPeriod(buyerClosed), viewings: perPeriod(buyerViewings),
      contacts: perPeriod(buyerContacts), leads: perPeriod(buyerLeads)
    },
    targets: {
      leadsYearly: sellerLeads + buyerLeads,
      salesYearly: sellerSold + buyerClosed
    }
  };
}

async function getOrCreateProfile(accountId) {
  let profile = await AgentProfile.findOne({ account: accountId });
  if (!profile) profile = await AgentProfile.create({ account: accountId });
  return profile;
}

// Agents AND admins pass (the broker has full access to the workspace and can
// use it as her own — her records are scoped to her account like anyone's).
// Employees are refused. verifyToken already re-reads the stored role, so a
// demoted/deactivated account loses access within its cache window.
function requireAgentRole(req, res, next) {
  if (!req.user || (req.user.role !== 'agent' && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'This area is for agent accounts.' });
  }
  next();
}

// ── ICS (phone calendar feed) helpers ────────────────────────
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n').slice(0, 180);
}
function icsDate(d) { return utcDateKey(d).replace(/-/g, ''); }
// Manila wall-clock 'YYYY-MM-DD' + 'HH:MM' → UTC timestamp string for DTSTART.
function icsUtcStamp(dateStr, timeStr) {
  const [h, mi] = (timeStr || '09:00').split(':').map(Number);
  const [y, mo, da] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, mo - 1, da, h, mi) - 8 * 3600 * 1000);
  return utc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function vevent({ uid, allDay, dateStr, timeStr, rruleYearly, summary, description }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}@glrarealty.com`, `DTSTAMP:${icsUtcStamp(utcDateKey(new Date()), '00:00')}`];
  if (allDay) lines.push(`DTSTART;VALUE=DATE:${dateStr.replace(/-/g, '')}`);
  else lines.push(`DTSTART:${icsUtcStamp(dateStr, timeStr)}`, 'DURATION:PT1H');
  if (rruleYearly) lines.push('RRULE:FREQ=YEARLY');
  lines.push(`SUMMARY:${icsEscape(summary)}`);
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}
// Next occurrence (as 'YYYY-MM-DD') of a recurring month-day, starting today (Manila).
function nextOccurrence(monthDayDate) {
  const src = new Date(monthDayDate);
  const now = manilaNow();
  let y = now.getUTCFullYear();
  const mk = d => `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const todayMD = mk(now), srcMD = mk(src);
  if (srcMD < todayMD) y += 1;
  // 29 Feb on a non-leap year celebrates on 28 Feb.
  let mo = src.getUTCMonth() + 1, da = src.getUTCDate();
  if (mo === 2 && da === 29 && (y % 4 !== 0 || (y % 100 === 0 && y % 400 !== 0))) da = 28;
  return `${y}-${pad2(mo)}-${pad2(da)}`;
}

// =============================================================================
// ROUTES
// =============================================================================
function registerAgentRoutes(app, { sendEmail, esc, handleValidation }) {

  // ── ME: profile + computed GPS + badge counts ──
  app.get('/api/agent/me', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const [profile, account, unread] = await Promise.all([
        getOrCreateProfile(req.user.sub),
        Account.findById(req.user.sub).select('name email createdAt').lean(),
        AgentNotification.countDocuments({ account: req.user.sub, read: false })
      ]);
      res.json({
        name: account?.name || '', email: account?.email || '',
        role: req.user.role,
        profile, gps: computeGPS(profile), unread,
        calFeedPath: profile.calToken ? `/api/agent-cal/${profile.calToken}` : null,
        stages: AGENT_LEAD_STAGES
      });
    } catch (e) { console.error('agent/me error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── GPS: update the yellow cells ──
  app.put('/api/agent/gps',
    verifyToken, requireAgentRole,
    body('annualGCI').optional().isFloat({ min: 1, max: 1e10 }),
    body('avgCommission').optional().isFloat({ min: 1, max: 1e9 }),
    body('workDaysWeek').optional().isFloat({ min: 1, max: 7 }),
    body('workDaysMonth').optional().isFloat({ min: 1, max: 31 }),
    body('workDaysYear').optional().isFloat({ min: 1, max: 366 }),
    body('goalStatement').optional().isString().isLength({ max: 300 }),
    body('conv').optional().isObject(),
    handleValidation,
    async (req, res) => {
      try {
        const profile = await getOrCreateProfile(req.user.sub);
        ['annualGCI', 'avgCommission', 'workDaysWeek', 'workDaysMonth', 'workDaysYear'].forEach(k => {
          if (req.body[k] !== undefined) profile[k] = Number(req.body[k]);
        });
        if (req.body.goalStatement !== undefined) profile.goalStatement = String(req.body.goalStatement).trim();
        if (req.body.conv) {
          Object.keys(profile.conv.toObject ? profile.conv.toObject() : profile.conv).forEach(k => {
            const v = Number(req.body.conv[k]);
            if (Number.isFinite(v) && v >= 0.01 && v <= 1) profile.conv[k] = v;
          });
        }
        profile.updatedAt = new Date();
        await profile.save();
        res.json({ success: true, profile, gps: computeGPS(profile) });
      } catch (e) { console.error('agent/gps error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── ACTIONS: current period checklists ──
  app.get('/api/agent/actions', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const keys = currentKeys();
      const docs = await AgentAction.find({
        account: req.user.sub,
        $or: [
          { periodType: 'daily', periodKey: keys.daily },
          { periodType: 'weekly', periodKey: keys.weekly },
          { periodType: 'monthly', periodKey: keys.monthly }
        ]
      }).lean();
      const byType = t => docs.find(d => d.periodType === t)?.entries || {};
      res.json({
        defs: ACTION_DEFS, keys,
        entries: { daily: byType('daily'), weekly: byType('weekly'), monthly: byType('monthly') }
      });
    } catch (e) { console.error('agent/actions error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/agent/actions',
    verifyToken, requireAgentRole,
    body('periodType').isIn(['daily', 'weekly', 'monthly']),
    body('actionId').isString(),
    body('qty').isInt({ min: 0, max: 999 }),
    handleValidation,
    async (req, res) => {
      try {
        const { periodType, actionId, qty } = req.body;
        if (!ALL_ACTION_IDS.has(actionId)) return res.status(400).json({ error: 'Unknown action' });
        const periodKey = currentKeys()[periodType];
        await AgentAction.updateOne(
          { account: req.user.sub, periodType, periodKey },
          { $set: { [`entries.${actionId}`]: Number(qty), updatedAt: new Date() } },
          { upsert: true }
        );
        res.json({ success: true, periodKey });
      } catch (e) { console.error('agent/actions save error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── ACCOMPLISHMENT REPORT ──
  app.get('/api/agent/report', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const keys = currentKeys();
      const { dayStart, monday, monthStart, yearStart } = manilaPeriodStarts();
      const [profile, actionDocs, leadAgg, closedThisYear] = await Promise.all([
        getOrCreateProfile(req.user.sub),
        AgentAction.find({
          account: req.user.sub,
          $or: [
            { periodType: 'daily', periodKey: keys.daily },
            { periodType: 'weekly', periodKey: keys.weekly },
            { periodType: 'monthly', periodKey: keys.monthly }
          ]
        }).lean(),
        AgentLead.aggregate([
          { $match: { account: profileAccountId(req) } },
          { $group: {
            _id: '$category',
            today: { $sum: { $cond: [{ $gte: ['$createdAt', dayStart] }, 1, 0] } },
            week: { $sum: { $cond: [{ $gte: ['$createdAt', monday] }, 1, 0] } },
            month: { $sum: { $cond: [{ $gte: ['$createdAt', monthStart] }, 1, 0] } },
            year: { $sum: { $cond: [{ $gte: ['$createdAt', yearStart] }, 1, 0] } }
          } }
        ]),
        AgentLead.countDocuments({
          account: req.user.sub, stage: 'Closing',
          $or: [{ closingDate: { $gte: yearStart } }, { closingDate: null, updatedAt: { $gte: yearStart } }]
        })
      ]);
      const gps = computeGPS(profile);
      const score = (type, defs) => {
        const entries = actionDocs.find(d => d.periodType === type)?.entries || {};
        const done = defs.filter(a => Number(entries[a.id]) > 0).length;
        const qty = defs.reduce((s, a) => s + (Number(entries[a.id]) || 0), 0);
        return { done, total: defs.length, qty, score: defs.length ? done / defs.length : 0 };
      };
      const cats = { Owner: {}, Buyer: {}, Tenant: {} };
      leadAgg.forEach(g => { cats[g._id] = { today: g.today, week: g.week, month: g.month, year: g.year }; });
      const sum = f => ['Owner', 'Buyer', 'Tenant'].reduce((s, c) => s + (cats[c][f] || 0), 0);
      res.json({
        actions: {
          daily: score('daily', ACTION_DEFS.daily),
          weekly: score('weekly', ACTION_DEFS.weekly),
          monthly: score('monthly', ACTION_DEFS.monthly)
        },
        leads: {
          byCategory: cats,
          totals: { today: sum('today'), week: sum('week'), month: sum('month'), year: sum('year') },
          targetYearly: gps.targets.leadsYearly,
          targetDaily: gps.targets.leadsYearly / (profile.workDaysYear || 250)
        },
        sales: { closedThisYear, targetYearly: gps.targets.salesYearly }
      });
    } catch (e) { console.error('agent/report error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── LEAD JOURNAL ──
  // Factory, not a shared array: validator chains are mutable objects, so the
  // POST (name required) and PUT (everything optional) routes each need their
  // own fresh set.
  const makeLeadValidators = requireName => [
    requireName
      ? body('name').isString().trim().isLength({ min: 1, max: 200 }).withMessage('Client name is required')
      : body('name').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('contactNo').optional().isString().isLength({ max: 60 }),
    body('email').optional({ values: 'falsy' }).isString().isLength({ max: 200 }),
    body('birthday').optional({ values: 'falsy' }).isISO8601(),
    body('category').optional().isIn(['Owner', 'Buyer', 'Tenant']),
    body('propertyInterest').optional().isString().isLength({ max: 300 }),
    body('source').optional().isString().isLength({ max: 120 }),
    body('actionToTake').optional().isString().isLength({ max: 300 }),
    body('stage').optional().isIn(AGENT_LEAD_STAGES),
    body('reasonLost').optional().isString().isLength({ max: 300 }),
    body('nextFollowUp').optional({ values: 'falsy' }).isISO8601(),
    body('closingDate').optional({ values: 'falsy' }).isISO8601(),
    body('remarks').optional().isString().isLength({ max: 1000 })
  ];
  const LEAD_FIELDS = ['name', 'contactNo', 'email', 'category', 'propertyInterest', 'source', 'actionToTake', 'stage', 'reasonLost', 'remarks'];
  const LEAD_DATE_FIELDS = ['birthday', 'nextFollowUp', 'closingDate'];
  function applyLeadBody(doc, bodyIn) {
    LEAD_FIELDS.forEach(k => { if (bodyIn[k] !== undefined) doc[k] = String(bodyIn[k]).trim(); });
    LEAD_DATE_FIELDS.forEach(k => {
      if (bodyIn[k] === undefined) return;
      doc[k] = bodyIn[k] ? new Date(String(bodyIn[k]).slice(0, 10)) : null;
    });
  }

  app.get('/api/agent/leads', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const leads = await AgentLead.find({ account: req.user.sub }).sort({ createdAt: -1 }).limit(1000).lean();
      res.json({ leads, stages: AGENT_LEAD_STAGES });
    } catch (e) { console.error('agent/leads error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/agent/leads', verifyToken, requireAgentRole, ...makeLeadValidators(true), handleValidation, async (req, res) => {
    try {
      const doc = new AgentLead({ account: req.user.sub });
      applyLeadBody(doc, req.body);
      await doc.save();
      res.json({ success: true, lead: doc });
    } catch (e) { console.error('agent/leads create error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.put('/api/agent/leads/:id', verifyToken, requireAgentRole, ...makeLeadValidators(false), handleValidation, async (req, res) => {
    try {
      const doc = await AgentLead.findOne({ _id: req.params.id, account: req.user.sub });
      if (!doc) return res.status(404).json({ error: 'Lead not found' });
      applyLeadBody(doc, req.body);
      doc.updatedAt = new Date();
      await doc.save();
      res.json({ success: true, lead: doc });
    } catch (e) { console.error('agent/leads update error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.delete('/api/agent/leads/:id', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const r = await AgentLead.deleteOne({ _id: req.params.id, account: req.user.sub });
      if (!r.deletedCount) return res.status(404).json({ error: 'Lead not found' });
      res.json({ success: true });
    } catch (e) { console.error('agent/leads delete error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── PIPELINE — read live from the journal, like the workbook ──
  app.get('/api/agent/pipeline', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const leads = await AgentLead.find({ account: req.user.sub })
        .select('name category stage actionToTake nextFollowUp closingDate').sort({ updatedAt: -1 }).limit(1000).lean();
      const byStage = {};
      AGENT_LEAD_STAGES.forEach(s => { byStage[s] = []; });
      leads.forEach(l => { (byStage[l.stage] || (byStage[l.stage] = [])).push(l); });
      const active = AGENT_LEAD_STAGES.slice(0, 5).reduce((s, st) => s + byStage[st].length, 0);
      const closed = byStage['Closing'].length, lost = byStage['Unsuccessful'].length;
      const anniversaries = leads.filter(l => l.closingDate).map(l => ({
        _id: l._id, name: l.name, closingDate: l.closingDate, next: nextOccurrence(l.closingDate)
      })).sort((a, b) => a.next < b.next ? -1 : 1);
      res.json({
        stages: AGENT_LEAD_STAGES, byStage,
        metrics: { active, closed, lost, successRate: (closed + lost) ? closed / (closed + lost) : 0 },
        anniversaries
      });
    } catch (e) { console.error('agent/pipeline error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── EVENTS (manual calendar entries) ──
  app.post('/api/agent/events',
    verifyToken, requireAgentRole,
    body('title').isString().trim().isLength({ min: 1, max: 200 }),
    body('date').isISO8601(),
    body('time').optional({ values: 'falsy' }).matches(/^\d{2}:\d{2}$/),
    body('type').optional().isIn(['viewing', 'appointment', 'other']),
    body('leadName').optional().isString().isLength({ max: 200 }),
    body('notes').optional().isString().isLength({ max: 500 }),
    handleValidation,
    async (req, res) => {
      try {
        const doc = await AgentEvent.create({
          account: req.user.sub,
          title: req.body.title.trim(),
          date: new Date(String(req.body.date).slice(0, 10)),
          time: req.body.time || '',
          type: req.body.type || 'other',
          leadName: (req.body.leadName || '').trim(),
          notes: (req.body.notes || '').trim()
        });
        res.json({ success: true, event: doc });
      } catch (e) { console.error('agent/events create error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  app.delete('/api/agent/events/:id', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const r = await AgentEvent.deleteOne({ _id: req.params.id, account: req.user.sub });
      if (!r.deletedCount) return res.status(404).json({ error: 'Event not found' });
      res.json({ success: true });
    } catch (e) { console.error('agent/events delete error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── CALENDAR — one month, all sources merged ──
  app.get('/api/agent/calendar', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const m = String(req.query.month || monthKeyOf(manilaNow()));
      if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ error: 'month must be YYYY-MM' });
      const [yy, mm] = m.split('-').map(Number);
      const mStart = new Date(Date.UTC(yy, mm - 1, 1));
      const mEnd = new Date(Date.UTC(yy, mm, 1));
      const [leads, events] = await Promise.all([
        AgentLead.find({ account: req.user.sub }).select('name birthday nextFollowUp closingDate stage').lean(),
        AgentEvent.find({ account: req.user.sub, date: { $gte: mStart, $lt: mEnd } }).lean()
      ]);
      const items = [];
      leads.forEach(l => {
        if (l.nextFollowUp) {
          const k = utcDateKey(l.nextFollowUp);
          if (k >= `${m}-01` && k < utcDateKey(mEnd)) {
            items.push({ day: Number(k.slice(8, 10)), kind: 'followup', label: `Follow up: ${l.name}`, leadId: l._id });
          }
        }
        if (l.birthday) {
          const b = new Date(l.birthday);
          if (b.getUTCMonth() + 1 === mm) {
            const yrs = yy - b.getUTCFullYear();
            items.push({ day: Math.min(b.getUTCDate(), 28 + (mm === 2 ? 0 : 3)), kind: 'birthday', label: `Birthday: ${l.name}${yrs > 0 && yrs < 120 ? ` (${yrs})` : ''}`, leadId: l._id });
          }
        }
        if (l.closingDate) {
          const cdate = new Date(l.closingDate);
          if (cdate.getUTCMonth() + 1 === mm && cdate.getUTCFullYear() < yy) {
            items.push({ day: cdate.getUTCDate(), kind: 'anniversary', label: `Closing anniversary: ${l.name}`, leadId: l._id });
          }
        }
      });
      events.forEach(ev => {
        items.push({ day: new Date(ev.date).getUTCDate(), kind: ev.type === 'viewing' ? 'viewing' : 'event', label: ev.title + (ev.time ? ` · ${ev.time}` : ''), eventId: ev._id });
      });
      items.sort((a, b) => a.day - b.day);
      res.json({ month: m, items, today: dayKeyOf(manilaNow()) });
    } catch (e) { console.error('agent/calendar error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── NOTIFICATIONS ──
  app.get('/api/agent/notifications', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const list = await AgentNotification.find({ account: req.user.sub }).sort({ createdAt: -1 }).limit(50).lean();
      const unread = list.filter(n => !n.read).length;
      res.json({ notifications: list, unread });
    } catch (e) { console.error('agent/notifications error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/agent/notifications/read', verifyToken, requireAgentRole, async (req, res) => {
    try {
      await AgentNotification.updateMany({ account: req.user.sub, read: false }, { $set: { read: true } });
      res.json({ success: true });
    } catch (e) { console.error('agent/notifications read error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── PHONE CALENDAR: token mint + public ICS feed ──
  app.post('/api/agent/cal-token', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const profile = await getOrCreateProfile(req.user.sub);
      profile.calToken = crypto.randomBytes(24).toString('hex');
      profile.updatedAt = new Date();
      await profile.save();
      res.json({ success: true, calFeedPath: `/api/agent-cal/${profile.calToken}` });
    } catch (e) { console.error('agent/cal-token error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/agent-cal/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').replace(/\.ics$/i, '');
      if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).send('Not found');
      const profile = await AgentProfile.findOne({ calToken: token }).lean();
      if (!profile) return res.status(404).send('Not found');
      const [account, leads, events] = await Promise.all([
        Account.findById(profile.account).select('name').lean(),
        AgentLead.find({ account: profile.account }).select('name birthday nextFollowUp closingDate stage').lean(),
        AgentEvent.find({ account: profile.account, date: { $gte: new Date(Date.now() - 30 * 86400e3) } }).lean()
      ]);
      const evs = [];
      const today = dayKeyOf(manilaNow());
      leads.forEach(l => {
        const fu = utcDateKey(l.nextFollowUp);
        if (fu && fu >= today && !['Closing', 'Unsuccessful'].includes(l.stage)) {
          evs.push(vevent({ uid: `fu-${l._id}-${fu}`, allDay: true, dateStr: fu, summary: `Follow up: ${l.name}`, description: 'GLRA Agent Workspace follow-up' }));
        }
        if (l.birthday) {
          evs.push(vevent({ uid: `bd-${l._id}`, allDay: true, dateStr: nextOccurrence(l.birthday), rruleYearly: true, summary: `Birthday: ${l.name}`, description: 'Send a birthday greeting' }));
        }
        if (l.closingDate && utcDateKey(l.closingDate) < today) {
          evs.push(vevent({ uid: `an-${l._id}`, allDay: true, dateStr: nextOccurrence(l.closingDate), rruleYearly: true, summary: `Closing anniversary: ${l.name}`, description: 'Reconnect with a past client' }));
        }
      });
      events.forEach(ev => {
        evs.push(vevent({
          uid: `ev-${ev._id}`, allDay: !ev.time, dateStr: utcDateKey(ev.date), timeStr: ev.time,
          summary: ev.title, description: [ev.leadName, ev.notes].filter(Boolean).join(' — ')
        }));
      });
      const cal = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GLRA Realty//Agent Workspace//EN',
        'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        `X-WR-CALNAME:GLRA \u2014 ${icsEscape(account?.name || 'Agent')}`,
        'X-WR-TIMEZONE:Asia/Manila',
        ...evs, 'END:VCALENDAR', ''
      ].join('\r\n');
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Cache-Control', 'private, max-age=900');
      res.send(cal);
    } catch (e) { console.error('agent-cal feed error:', e); res.status(500).send('Server error'); }
  });

  // ═══════════════════════════════════════════════════════════
  // ADMIN SIDE — the broker's window into the team
  // ═══════════════════════════════════════════════════════════
  app.get('/api/admin/agents', verifyToken, requireAdmin, async (req, res) => {
    try {
      const agents = await Account.find({ role: 'agent' })
        .select('name email isActive status lastSeen lastLogin createdAt').lean();
      const ids = agents.map(a => a._id);
      const keys = currentKeys();
      const [profiles, leadAgg, todaysActions] = await Promise.all([
        AgentProfile.find({ account: { $in: ids } }).lean(),
        AgentLead.aggregate([
          { $match: { account: { $in: ids } } },
          { $group: {
            _id: '$account', total: { $sum: 1 },
            active: { $sum: { $cond: [{ $in: ['$stage', AGENT_LEAD_STAGES.slice(0, 5)] }, 1, 0] } },
            closed: { $sum: { $cond: [{ $eq: ['$stage', 'Closing'] }, 1, 0] } }
          } }
        ]),
        AgentAction.find({ account: { $in: ids }, periodType: 'daily', periodKey: keys.daily }).lean()
      ]);
      const pById = {}, lById = {}, aById = {};
      profiles.forEach(p => { pById[String(p.account)] = p; });
      leadAgg.forEach(g => { lById[String(g._id)] = g; });
      todaysActions.forEach(d => {
        const done = ACTION_DEFS.daily.filter(a => Number(d.entries?.[a.id]) > 0).length;
        aById[String(d.account)] = { done, total: ACTION_DEFS.daily.length };
      });
      res.json({
        agents: agents.map(a => {
          const id = String(a._id);
          return {
            ...a,
            annualGCI: pById[id]?.annualGCI ?? null,
            leads: lById[id] || { total: 0, active: 0, closed: 0 },
            actionsToday: aById[id] || { done: 0, total: ACTION_DEFS.daily.length }
          };
        })
      });
    } catch (e) { console.error('admin/agents error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/admin/agents/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const account = await Account.findOne({ _id: req.params.id, role: 'agent' })
        .select('name email isActive status lastSeen lastLogin createdAt').lean();
      if (!account) return res.status(404).json({ error: 'Agent not found' });
      const profile = await AgentProfile.findOne({ account: account._id }) || await AgentProfile.create({ account: account._id });
      const leads = await AgentLead.find({ account: account._id }).sort({ updatedAt: -1 }).limit(100).lean();
      const byStage = {};
      AGENT_LEAD_STAGES.forEach(s => { byStage[s] = 0; });
      leads.forEach(l => { byStage[l.stage] = (byStage[l.stage] || 0) + 1; });
      res.json({ account, profile, gps: computeGPS(profile), leads, byStage, stages: AGENT_LEAD_STAGES });
    } catch (e) { console.error('admin/agents detail error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Hand a website inquiry to an agent: copies it into their Lead Journal,
  // pings their bell, and emails them. The inquiry stays in the admin list
  // with an "assigned" stamp.
  app.post('/api/admin/inquiries/:id/assign',
    verifyToken, requireAdmin,
    body('agentId').isString().isLength({ min: 8, max: 64 }),
    handleValidation,
    async (req, res) => {
      try {
        const [inquiry, agent] = await Promise.all([
          Inquiry.findById(req.params.id),
          Account.findOne({ _id: req.body.agentId, role: 'agent', isActive: true, status: 'active' }).select('name email').lean()
        ]);
        if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });
        if (!agent) return res.status(400).json({ error: 'That account is not an active agent.' });

        const lead = await AgentLead.create({
          account: agent._id,
          name: inquiry.name || 'Website inquirer',
          contactNo: inquiry.phone || '',
          email: inquiry.email || '',
          category: 'Buyer',
          propertyInterest: inquiry.propertyTitle || '',
          source: 'Website',
          actionToTake: 'Reply to inquiry within the hour',
          stage: 'Inquiry',
          nextFollowUp: new Date(dayKeyOf(manilaNow())),
          remarks: (inquiry.message || '').slice(0, 900),
          assignedFrom: { inquiryId: String(inquiry._id), by: req.user.email, at: new Date() }
        });
        inquiry.assignedTo = agent._id;
        inquiry.assignedToName = agent.name || agent.email;
        inquiry.assignedAt = new Date();
        inquiry.assignedBy = req.user.email;
        await inquiry.save();

        try {
          await AgentNotification.create({
            account: agent._id,
            dedupeKey: `as:${inquiry._id}:${lead._id}`,
            type: 'lead',
            message: `New website lead assigned to you: ${lead.name}${lead.propertyInterest ? ` \u2014 ${lead.propertyInterest}` : ''}`,
            leadId: String(lead._id)
          });
        } catch (e) { if (e.code !== 11000) console.error('assign notification error:', e.message); }

        sendEmail(agent.email, 'New lead assigned to you \u2014 GLRA',
          getEmailHeader() + `
          <h2 style="color:#0a1628;">A website lead was just assigned to you</h2>
          <table style="font-size:14px;line-height:1.9">
            <tr><td style="padding-right:12px;color:#666">Client:</td><td><strong>${esc(lead.name)}</strong></td></tr>
            ${lead.contactNo ? `<tr><td style="padding-right:12px;color:#666">Contact:</td><td>${esc(lead.contactNo)}</td></tr>` : ''}
            ${lead.email ? `<tr><td style="padding-right:12px;color:#666">Email:</td><td>${esc(lead.email)}</td></tr>` : ''}
            ${lead.propertyInterest ? `<tr><td style="padding-right:12px;color:#666">Interested in:</td><td>${esc(lead.propertyInterest)}</td></tr>` : ''}
          </table>
          ${lead.remarks ? `<p style="background:#f6f4ef;padding:12px 16px;font-size:14px">\u201C${esc(lead.remarks)}\u201D</p>` : ''}
          <p><strong>Reply within the hour</strong> \u2014 it's already in your Lead Journal.</p>
          <p><a href="${SITE_URL}/agent.html" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:12px 24px;text-decoration:none;font-weight:600">Open my workspace</a></p>
        ` + getEmailFooter()).catch(err => console.error('assign email failed:', err.message));

        await logAudit(req, 'ASSIGN_LEAD', 'Inquiry', String(inquiry._id), lead.name, { agent: agent.email });
        res.json({ success: true, lead, assignedToName: inquiry.assignedToName });
      } catch (e) { console.error('assign inquiry error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // req.user.sub as an ObjectId for aggregation $match (strings don't match).
  function profileAccountId(req) {
    const mongoose = require('mongoose');
    return new mongoose.Types.ObjectId(String(req.user.sub));
  }
}

// =============================================================================
// DAILY REMINDER TICK — the "notifications + email" the owner asked for
// =============================================================================
// Every 10 minutes; from 07:00 Manila onward it processes each active agent
// once per day: writes bell notifications (deduped) for today's follow-ups,
// client birthdays, and closing anniversaries, then sends ONE morning-agenda
// email if there's anything to say. lastDigestKey guarantees once-per-day.
function startAgentTick({ sendEmail, esc }) {
  async function tick() {
    try {
      const now = manilaNow();
      if (now.getUTCHours() < 7) return;
      const todayKey = dayKeyOf(now);
      const todayMD = todayKey.slice(5);
      // Admins are included: the broker can use the workspace herself. The
      // has-profile check keeps it to accounts that actually opened it.
      const agents = await Account.find({ role: { $in: ['agent', 'admin'] }, isActive: true, status: 'active' }).select('name email').lean();
      for (const agent of agents) {
        try {
          const profile = await AgentProfile.findOne({ account: agent._id });
          if (!profile || profile.lastDigestKey === todayKey) continue;

          const leads = await AgentLead.find({ account: agent._id })
            .select('name birthday nextFollowUp closingDate stage').lean();
          const followups = [], birthdays = [], anniversaries = [];
          leads.forEach(l => {
            const fu = utcDateKey(l.nextFollowUp);
            if (fu && fu <= todayKey && !['Closing', 'Unsuccessful'].includes(l.stage)) {
              followups.push({ lead: l, overdue: fu < todayKey });
            }
            if (l.birthday && utcDateKey(l.birthday).slice(5) === todayMD) birthdays.push(l);
            if (l.closingDate && utcDateKey(l.closingDate).slice(5) === todayMD && utcDateKey(l.closingDate) < todayKey) anniversaries.push(l);
          });
          const events = await AgentEvent.find({ account: agent._id, date: new Date(todayKey) }).lean();

          const notify = async (dedupeKey, type, message, leadId) => {
            try {
              await AgentNotification.create({ account: agent._id, dedupeKey, type, message, leadId: leadId ? String(leadId) : null });
            } catch (e) { if (e.code !== 11000) throw e; } // duplicate = already notified
          };
          for (const f of followups) await notify(`fu:${f.lead._id}:${todayKey}`, 'followup', `${f.overdue ? 'Overdue follow-up' : 'Follow up today'}: ${f.lead.name}`, f.lead._id);
          for (const b of birthdays) await notify(`bd:${b._id}:${todayKey.slice(0, 4)}`, 'birthday', `Birthday today: ${b.name} \u2014 send a greeting!`, b._id);
          for (const a of anniversaries) await notify(`an:${a._id}:${todayKey.slice(0, 4)}`, 'anniversary', `Closing anniversary today: ${a.name} \u2014 a great day to reconnect`, a._id);

          const total = followups.length + birthdays.length + anniversaries.length + events.length;
          if (total > 0 && agent.email) {
            const li = arr => arr.map(s => `<li style="margin:4px 0">${s}</li>`).join('');
            sendEmail(agent.email, `Your GLRA agenda \u2014 ${todayKey}`,
              getEmailHeader() + `
              <h2 style="color:#0a1628;">Good morning, ${esc(agent.name || 'Agent')}!</h2>
              <p>Here's what's on your plate today:</p>
              ${followups.length ? `<h3 style="margin-bottom:4px">Follow-ups (${followups.length})</h3><ul>${li(followups.map(f => `${esc(f.lead.name)}${f.overdue ? ' <span style="color:#c0392b">(overdue)</span>' : ''}`))}</ul>` : ''}
              ${birthdays.length ? `<h3 style="margin-bottom:4px">Client birthdays</h3><ul>${li(birthdays.map(b => esc(b.name)))}</ul>` : ''}
              ${anniversaries.length ? `<h3 style="margin-bottom:4px">Closing anniversaries</h3><ul>${li(anniversaries.map(a => esc(a.name)))}</ul>` : ''}
              ${events.length ? `<h3 style="margin-bottom:4px">Scheduled</h3><ul>${li(events.map(ev => `${esc(ev.title)}${ev.time ? ` \u00B7 ${esc(ev.time)}` : ''}`))}</ul>` : ''}
              <p style="margin-top:16px"><a href="${SITE_URL}/agent.html" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:12px 24px;text-decoration:none;font-weight:600">Open my workspace</a></p>
            ` + getEmailFooter()).catch(err => console.error('agenda email failed:', err.message));
          }
          profile.lastDigestKey = todayKey;
          await profile.save();
        } catch (e) { console.error(`agent tick failed for ${agent.email}:`, e.message); }
      }
    } catch (e) { console.error('agent tick error:', e.message); }
  }
  // First run 45s after boot (lets Mongo connect), then every 10 minutes.
  setTimeout(() => { tick(); setInterval(tick, 10 * 60 * 1000); }, 45 * 1000);
}

module.exports = {
  registerAgentRoutes, startAgentTick, ACTION_DEFS,
  // Exported so the math and date logic can be verified without booting the
  // server (see the workbook: GPS!C15..C30 are the reference values).
  _test: { computeGPS, weekKeyOf, dayKeyOf, monthKeyOf, nextOccurrence, icsEscape, icsUtcStamp }
};
