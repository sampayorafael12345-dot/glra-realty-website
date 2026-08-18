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
// The workbook's original wording, so a rename that matches it again is simply
// dropped rather than stored forever as an "override".
const STD_ACTION_TEXT = new Map(
  [...ACTION_DEFS.daily, ...ACTION_DEFS.weekly, ...ACTION_DEFS.monthly].map(a => [a.id, a.text])
);
const PERIOD_TYPES = ['daily', 'weekly', 'monthly'];
const MAX_TARGET = 99;

// How many times one action has to be done in its period. Absent, junk or out
// of range all mean once, so a bad value can never make a line impossible.
function targetOf(profile, id) {
  const n = Math.round(Number((profile?.actionTargets || {})[id]));
  return Number.isFinite(n) && n > 1 ? Math.min(MAX_TARGET, n) : 1;
}

// The agent's *effective* checklists: the workbook's lines minus the ones they
// switched off and with any rewording they applied, plus the ones they wrote
// themselves, each carrying its target. Everything downstream — saving a
// quantity, scoring the report, the unfinished-actions nudge — reads the list
// through here, so an edited checklist stays consistent everywhere.
function effectiveActionDefs(profile) {
  const hidden = new Set(profile?.hiddenActions || []);
  const custom = profile?.customActions || {};
  const renamed = profile?.renamedActions || {};
  const out = {};
  PERIOD_TYPES.forEach(t => {
    const own = (custom[t] || []).map(a => ({ id: a.id, text: a.text, custom: true }));
    out[t] = ACTION_DEFS[t]
      .filter(a => !hidden.has(a.id))
      .map(a => ({ id: a.id, text: String(renamed[a.id] || a.text) }))
      .concat(own)
      .map(a => ({ ...a, target: targetOf(profile, a.id) }));
  });
  return out;
}
function effectiveActionIds(profile) {
  const defs = effectiveActionDefs(profile);
  return new Set(PERIOD_TYPES.flatMap(t => defs[t].map(a => a.id)));
}
// Which unfinished-action reminders the evening nudge should cover on a given
// Manila date. Daily every night. Weekly from Friday to Sunday, because the ISO
// week ends Sunday and that is the window where an unfinished weekly action can
// still be saved. Monthly in the last three days of the month.
// Pure and exported so the date arithmetic can be tested without a clock.
function nudgeScope(manilaDate) {
  const dow = manilaDate.getUTCDay(); // 0=Sun .. 6=Sat (on the shifted date)
  const daysInMonth = new Date(Date.UTC(manilaDate.getUTCFullYear(), manilaDate.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    daily: true,
    weekly: dow === 5 || dow === 6 || dow === 0,
    monthly: manilaDate.getUTCDate() > daysInMonth - 3
  };
}

// Which lines of a period are done, and which are still open. `entries` is the
// { actionId: qty } map from an AgentAction doc; `defs` carry the target. A line
// counts as done only once the tally reaches its target, so "3 calls a day"
// stays open at 2 of 3 instead of ticking itself off on the first one.
function splitActions(defs, entries) {
  const e = entries || {};
  const qty = a => Number(e[a.id]) || 0;
  const want = a => (Number(a.target) > 1 ? Math.min(MAX_TARGET, Math.round(Number(a.target))) : 1);
  const row = a => ({ id: a.id, text: a.text, qty: qty(a), target: want(a) });
  return {
    done: defs.filter(a => qty(a) >= want(a)).map(row),
    pending: defs.filter(a => qty(a) < want(a)).map(row),
    total: defs.length,
    qty: defs.reduce((s, a) => s + qty(a), 0)
  };
}

// Commission the agent has actually banked, from the amounts they entered on
// deals that reached Closing. The year bucket dates a deal by its closing date
// where there is one and falls back to when the record last moved, which is how
// the report already counts closings.
async function commissionTotals(accountId, yearStart) {
  const rows = await AgentLead.find({ account: accountId, commissionEarned: { $gt: 0 } })
    .select('commissionEarned closingDate updatedAt').lean();
  let year = 0, total = 0, dealsYear = 0;
  rows.forEach(l => {
    const amt = Number(l.commissionEarned) || 0;
    total += amt;
    const when = l.closingDate || l.updatedAt;
    if (when && new Date(when) >= yearStart) { year += amt; dealsYear += 1; }
  });
  return { year, total, deals: rows.length, dealsYear };
}

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
      const [profile, account, unread, commission] = await Promise.all([
        getOrCreateProfile(req.user.sub),
        Account.findById(req.user.sub).select('name email createdAt').lean(),
        AgentNotification.countDocuments({ account: req.user.sub, read: false }),
        commissionTotals(req.user.sub, manilaPeriodStarts().yearStart)
      ]);
      res.json({
        name: account?.name || '', email: account?.email || '',
        role: req.user.role, since: account?.createdAt || null,
        profile, gps: computeGPS(profile), unread, commission,
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
        const commission = await commissionTotals(req.user.sub, manilaPeriodStarts().yearStart);
        res.json({ success: true, profile, gps: computeGPS(profile), commission });
      } catch (e) { console.error('agent/gps error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── ACTIONS: current period checklists ──
  app.get('/api/agent/actions', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const keys = currentKeys();
      const [profile, docs] = await Promise.all([
        getOrCreateProfile(req.user.sub),
        AgentAction.find({
          account: req.user.sub,
          $or: [
            { periodType: 'daily', periodKey: keys.daily },
            { periodType: 'weekly', periodKey: keys.weekly },
            { periodType: 'monthly', periodKey: keys.monthly }
          ]
        }).lean()
      ]);
      const byType = t => docs.find(d => d.periodType === t)?.entries || {};
      res.json({
        defs: effectiveActionDefs(profile), keys,
        // The untouched workbook lists, so the workspace can offer a switched-off
        // line back without hard-coding the wording in two places.
        standard: ACTION_DEFS,
        hidden: profile.hiddenActions || [],
        entries: { daily: byType('daily'), weekly: byType('weekly'), monthly: byType('monthly') }
      });
    } catch (e) { console.error('agent/actions error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/agent/actions',
    verifyToken, requireAgentRole,
    body('periodType').isIn(PERIOD_TYPES),
    body('actionId').isString(),
    body('qty').isInt({ min: 0, max: 999 }),
    handleValidation,
    async (req, res) => {
      try {
        const { periodType, actionId, qty } = req.body;
        const profile = await getOrCreateProfile(req.user.sub);
        // Checked against this agent's own list, not just the workbook's, so
        // their custom lines save and a switched-off line cannot be logged.
        if (!effectiveActionIds(profile).has(actionId)) return res.status(400).json({ error: 'Unknown action' });
        const periodKey = currentKeys()[periodType];
        await AgentAction.updateOne(
          { account: req.user.sub, periodType, periodKey },
          { $set: { [`entries.${actionId}`]: Number(qty), updatedAt: new Date() } },
          { upsert: true }
        );
        res.json({ success: true, periodKey });
      } catch (e) { console.error('agent/actions save error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── ACTIONS: edit the checklist itself ──
  // Whole-list replace rather than add/edit/delete routes: the workspace always
  // holds the complete list, so one atomic write can't leave it half-applied.
  // Ids are minted here — a client can only reuse an id it already owns.
  app.put('/api/agent/action-list',
    verifyToken, requireAgentRole,
    body('custom').optional().isObject(),
    body('hidden').optional().isArray({ max: 40 }),
    body('renamed').optional().isObject(),
    body('targets').optional().isObject(),
    handleValidation,
    async (req, res) => {
      try {
        const profile = await getOrCreateProfile(req.user.sub);
        if (req.body.custom) {
          PERIOD_TYPES.forEach(t => {
            const incoming = req.body.custom[t];
            if (!Array.isArray(incoming)) return;
            const known = new Set((profile.customActions[t] || []).map(a => a.id));
            profile.customActions[t] = incoming.slice(0, 30).map(a => {
              const text = String((a && a.text) || '').trim().slice(0, 200);
              if (!text) return null;
              const id = (a.id && known.has(String(a.id)))
                ? String(a.id)
                : 'x' + crypto.randomBytes(4).toString('hex');
              return { id, text };
            }).filter(Boolean);
          });
        }
        if (Array.isArray(req.body.hidden)) {
          profile.hiddenActions = req.body.hidden.map(String).filter(id => ALL_ACTION_IDS.has(id));
        }
        // Rewording a workbook line. Only the ids we shipped can be renamed —
        // a custom line's text is edited through `custom` above — and text that
        // matches the workbook again is dropped rather than stored as a no-op.
        if (req.body.renamed && typeof req.body.renamed === 'object') {
          const out = {};
          Object.keys(req.body.renamed).slice(0, 80).forEach(id => {
            if (!ALL_ACTION_IDS.has(id)) return;
            const text = String(req.body.renamed[id] || '').trim().slice(0, 200);
            if (text && text !== STD_ACTION_TEXT.get(id)) out[id] = text;
          });
          profile.renamedActions = out;
          profile.markModified('renamedActions');
        }
        // Targets are read after the custom ids above are minted, so a line the
        // agent just added can carry one. A target of 1 is the default and is
        // never stored, which keeps the profile from filling up with no-ops.
        if (req.body.targets && typeof req.body.targets === 'object') {
          const known = effectiveActionIds(profile);
          const out = {};
          Object.keys(req.body.targets).slice(0, 160).forEach(id => {
            if (!known.has(id)) return;
            const n = Math.round(Number(req.body.targets[id]));
            if (Number.isFinite(n) && n > 1 && n <= MAX_TARGET) out[id] = n;
          });
          profile.actionTargets = out;
          profile.markModified('actionTargets');
        }
        profile.updatedAt = new Date();
        await profile.save();
        res.json({
          success: true, defs: effectiveActionDefs(profile),
          standard: ACTION_DEFS, hidden: profile.hiddenActions
        });
      } catch (e) { console.error('agent/action-list error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── OWN PROFILE ──
  // An agent maintains their own details. Role, status and email are NOT
  // editable here: they are the sign-in identity and the broker's decision.
  app.put('/api/agent/profile',
    verifyToken, requireAgentRole,
    body('name').optional().isString().trim().isLength({ min: 2, max: 120 }).withMessage('Enter your full name'),
    body('contactNo').optional().isString().isLength({ max: 60 }),
    body('licenseNo').optional().isString().isLength({ max: 60 }),
    body('goalStatement').optional().isString().isLength({ max: 300 }),
    handleValidation,
    async (req, res) => {
      try {
        const profile = await getOrCreateProfile(req.user.sub);
        ['contactNo', 'licenseNo', 'goalStatement'].forEach(k => {
          if (req.body[k] !== undefined) profile[k] = String(req.body[k]).trim();
        });
        profile.updatedAt = new Date();
        await profile.save();
        if (req.body.name !== undefined) {
          await Account.updateOne({ _id: req.user.sub }, { $set: { name: String(req.body.name).trim() } });
        }
        const account = await Account.findById(req.user.sub).select('name email createdAt').lean();
        res.json({
          success: true, profile,
          name: account?.name || '', email: account?.email || '', since: account?.createdAt || null
        });
      } catch (e) { console.error('agent/profile error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── EMAIL PREFERENCES ──
  app.put('/api/agent/email-prefs',
    verifyToken, requireAgentRole,
    body('morningDigest').optional().isBoolean(),
    body('actionNudge').optional().isBoolean(),
    handleValidation,
    async (req, res) => {
      try {
        const profile = await getOrCreateProfile(req.user.sub);
        ['morningDigest', 'actionNudge'].forEach(k => {
          if (req.body[k] !== undefined) profile.emailPrefs[k] = !!req.body[k];
        });
        profile.updatedAt = new Date();
        await profile.save();
        res.json({ success: true, emailPrefs: profile.emailPrefs });
      } catch (e) { console.error('agent/email-prefs error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── TEAM ROSTER — fills the broker / agent picker on a lead ──
  // Names and roles only. An agent has no business reading colleagues' emails,
  // so they are not in the response.
  app.get('/api/agent/team', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const people = await Account.find({ role: { $in: ['agent', 'admin'] }, isActive: true, status: 'active' })
        .select('name email role').lean();
      const team = people
        .map(p => ({ name: (p.name || p.email || '').trim(), role: p.role }))
        .filter(p => p.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ team });
    } catch (e) { console.error('agent/team error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ── ACCOMPLISHMENT REPORT ──
  app.get('/api/agent/report', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const keys = currentKeys();
      const { dayStart, monday, monthStart, yearStart } = manilaPeriodStarts();
      const [profile, actionDocs, leadAgg, closedThisYear, commission] = await Promise.all([
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
        }),
        commissionTotals(req.user.sub, yearStart)
      ]);
      const gps = computeGPS(profile);
      const defs = effectiveActionDefs(profile);
      // The report is filled from the Actions page and never typed twice: this
      // hands back the exact lines the agent ticked, with the counts they
      // logged, plus what is still open in the same period.
      const score = type => {
        const s = splitActions(defs[type], actionDocs.find(d => d.periodType === type)?.entries);
        return {
          done: s.done.length, total: s.total, qty: s.qty,
          score: s.total ? s.done.length / s.total : 0,
          items: s.done, pending: s.pending
        };
      };
      // Categories are free text now, so the table is built from whatever the
      // agent has actually used. The three core ones always appear, even at
      // zero, so the report doesn't change shape from one day to the next.
      const CORE_CATS = ['Owner', 'Buyer', 'Tenant'];
      const cats = {};
      CORE_CATS.forEach(c => { cats[c] = {}; });
      leadAgg.forEach(g => {
        const name = String(g._id || '').trim() || 'Uncategorised';
        cats[name] = { today: g.today, week: g.week, month: g.month, year: g.year };
      });
      const categories = CORE_CATS.concat(
        Object.keys(cats).filter(c => !CORE_CATS.includes(c)).sort((a, b) => a.localeCompare(b))
      );
      const sum = f => categories.reduce((s, c) => s + (cats[c][f] || 0), 0);
      res.json({
        periodKeys: keys,
        actions: { daily: score('daily'), weekly: score('weekly'), monthly: score('monthly') },
        leads: {
          byCategory: cats, categories,
          totals: { today: sum('today'), week: sum('week'), month: sum('month'), year: sum('year') },
          targetYearly: gps.targets.leadsYearly,
          targetDaily: gps.targets.leadsYearly / (profile.workDaysYear || 250)
        },
        sales: {
          closedThisYear, targetYearly: gps.targets.salesYearly,
          commission, gciGoal: Number(profile.annualGCI) || 0
        }
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
    // Free text: the picker offers Owner / Buyer / Tenant / Broker / Agent and
    // an "Other" box, so a category we never listed is still recordable.
    body('category').optional().isString().trim().isLength({ min: 1, max: 60 }).withMessage('Type the category'),
    body('propertyInterest').optional().isString().isLength({ max: 300 }),
    body('source').optional().isString().isLength({ max: 120 }),
    body('actionToTake').optional().isString().isLength({ max: 300 }),
    body('brokerAgent').optional().isString().isLength({ max: 160 }),
    body('stage').optional().isIn(AGENT_LEAD_STAGES),
    body('reasonLost').optional().isString().isLength({ max: 300 }),
    body('nextFollowUp').optional({ values: 'falsy' }).isISO8601(),
    body('closingDate').optional({ values: 'falsy' }).isISO8601(),
    body('commissionEarned').optional().isFloat({ min: 0, max: 1e9 }).withMessage('Enter the commission as a number'),
    body('remarks').optional().isString().isLength({ max: 1000 })
  ];
  const LEAD_FIELDS = ['name', 'contactNo', 'email', 'category', 'propertyInterest', 'source', 'actionToTake', 'brokerAgent', 'stage', 'reasonLost', 'remarks'];
  const LEAD_DATE_FIELDS = ['birthday', 'nextFollowUp', 'closingDate'];
  function applyLeadBody(doc, bodyIn) {
    const prevStage = doc.stage;
    LEAD_FIELDS.forEach(k => { if (bodyIn[k] !== undefined) doc[k] = String(bodyIn[k]).trim(); });
    LEAD_DATE_FIELDS.forEach(k => {
      if (bodyIn[k] === undefined) return;
      doc[k] = bodyIn[k] ? new Date(String(bodyIn[k]).slice(0, 10)) : null;
    });
    // Whole pesos. Anything unparseable or negative clears the amount rather
    // than writing NaN into the figure the GPS page subtracts from.
    if (bodyIn.commissionEarned !== undefined) {
      const amt = Math.round(Number(bodyIn.commissionEarned));
      doc.commissionEarned = Number.isFinite(amt) && amt > 0 ? amt : 0;
    }
    if (!String(doc.category || '').trim()) doc.category = 'Buyer';
    // The lead's own pipeline. Stamped the moment the stage changes, and once
    // when the lead is first written, so the trail is complete without anyone
    // maintaining it by hand. Capped so a lead bounced between stages for years
    // can't grow without bound.
    if (!doc.stageHistory || doc.stageHistory.length === 0 || doc.stage !== prevStage) {
      doc.stageHistory = [...(doc.stageHistory || []), { stage: doc.stage, at: new Date() }].slice(-40);
    }
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

  // ── EMAIL A CLIENT from the workspace ──
  // Goes out on GLRA letterhead from the shared sending address (the only
  // domain Brevo is authorised for), but Reply-To is the agent, so the client's
  // answer lands in that agent's own inbox. The agent also gets a copy, and the
  // lead keeps a subject-and-time trail.
  app.post('/api/agent/leads/:id/email',
    verifyToken, requireAgentRole,
    body('subject').isString().trim().isLength({ min: 2, max: 200 }).withMessage('Give the email a subject'),
    body('message').isString().trim().isLength({ min: 2, max: 4000 }).withMessage('Write a message first'),
    handleValidation,
    async (req, res) => {
      try {
        const [lead, me] = await Promise.all([
          AgentLead.findOne({ _id: req.params.id, account: req.user.sub }),
          Account.findById(req.user.sub).select('name email').lean()
        ]);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        const to = String(lead.email || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
          return res.status(400).json({ error: 'This lead has no valid email address. Add one first.' });
        }
        const subject = String(req.body.subject).trim();
        const agentName = (me?.name || '').trim() || 'Your GLRA agent';
        // Blank lines become paragraphs, single newlines become breaks, so what
        // the agent typed is what the client reads.
        const bodyHtml = String(req.body.message).trim().split(/\n{2,}/)
          .map(p => `<p style="font-size:15px;line-height:1.7;color:#333">${esc(p).replace(/\n/g, '<br>')}</p>`)
          .join('');
        const html = getEmailHeader() + bodyHtml + `
          <p style="font-size:15px;line-height:1.7;color:#333;margin-top:22px">
            ${esc(agentName)}<br>
            <span style="color:#666;font-size:13px">GLRA Realty</span>
          </p>` + getEmailFooter();

        const sent = await sendEmail(to, subject, html, `${agentName} — GLRA Realty`,
          me?.email ? { email: me.email, name: agentName } : null);
        if (sent && sent.success === false) {
          return res.status(502).json({ error: 'Email service refused the message. Try again shortly.' });
        }

        lead.emailLog = [...(lead.emailLog || []), { to, subject, at: new Date() }].slice(-30);
        lead.updatedAt = new Date();
        await lead.save();

        if (me?.email) {
          sendEmail(me.email, `Copy: ${subject}`,
            getEmailHeader() + `<p style="font-size:14px;color:#666">Your copy of the email sent to <strong>${esc(lead.name)}</strong> (${esc(to)}).</p><hr style="border:none;border-top:1px solid #e5e5e5;margin:18px 0">`
            + bodyHtml + getEmailFooter()
          ).catch(err => console.error('client-email copy failed:', err.message));
        }
        res.json({ success: true, lead });
      } catch (e) { console.error('agent/leads email error:', e); res.status(500).json({ error: 'Server error' }); }
    });

  // ── PIPELINE — read live from the journal, like the workbook ──
  app.get('/api/agent/pipeline', verifyToken, requireAgentRole, async (req, res) => {
    try {
      const leads = await AgentLead.find({ account: req.user.sub })
        .select('name category stage actionToTake brokerAgent stageHistory nextFollowUp closingDate commissionEarned updatedAt')
        .sort({ updatedAt: -1 }).limit(1000).lean();
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
        commission: await commissionTotals(req.user.sub, manilaPeriodStarts().yearStart),
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
          // This path writes the lead directly, so stamp the opening step of
          // its pipeline here too (applyLeadBody does it on every other route).
          stageHistory: [{ stage: 'Inquiry', at: new Date() }],
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
// REMINDER TICK — the "notifications + email" the owner asked for
// =============================================================================
// Runs every 10 minutes and makes two passes per agent per day:
//
//   MORNING (07:00-18:59, guarded by lastDigestKey) - today's follow-ups,
//     client birthdays, closing anniversaries, diary entries, and the daily
//     actions still to do. Bell notifications plus one agenda email.
//   AFTERNOON (15:00 onward, guarded by lastNudgeKey) - what is still
//     unfinished: daily actions every day, weekly actions Friday to Sunday as
//     the week closes, monthly actions in the last three days of the month.
//     3pm on the owner's instruction: late enough to be a fair read of the day,
//     early enough that an agent can still act on it during working hours.
//
// The morning window deliberately stays open until 18:59 even though the
// afternoon pass starts at 15:00. They overlap by design: the two passes have
// separate day-keys, so on a normal day the agenda has long since gone out, and
// the overlap only matters after a restart, where it means a late boot still
// delivers the day's birthdays instead of dropping them.
//
// Both guards are 'YYYY-MM-DD' Manila keys, so each pass fires at most once a
// day, and the bell's unique dedupeKey means a re-run can never double-post.
// Agents can switch either email off in the workspace; the bell always works.
function startAgentTick({ sendEmail, esc }) {
  const CTA = `<p style="margin-top:20px"><a href="${SITE_URL}/agent.html" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:12px 24px;text-decoration:none;font-weight:600">Open my workspace</a></p>`;
  const li = arr => arr.map(s => `<li style="margin:4px 0">${esc(s)}</li>`).join('');
  // Long checklists are trimmed in the email; the workspace has the full list.
  const listBlock = (heading, items) => `
    <h3 style="margin:18px 0 4px;font-size:15px;color:#0a1628">${esc(heading)}</h3>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.7;color:#333">
      ${li(items.slice(0, 8))}
      ${items.length > 8 ? `<li style="margin:4px 0;color:#777">and ${items.length - 8} more</li>` : ''}
    </ul>`;

  // This agent's three live checklists, each split into done / still open.
  async function actionState(accountId, profile) {
    const keys = currentKeys();
    const docs = await AgentAction.find({
      account: accountId,
      $or: [
        { periodType: 'daily', periodKey: keys.daily },
        { periodType: 'weekly', periodKey: keys.weekly },
        { periodType: 'monthly', periodKey: keys.monthly }
      ]
    }).lean();
    const defs = effectiveActionDefs(profile);
    const state = {};
    PERIOD_TYPES.forEach(t => {
      state[t] = splitActions(defs[t], docs.find(d => d.periodType === t)?.entries);
    });
    return state;
  }

  async function tick() {
    try {
      const now = manilaNow();
      const hour = now.getUTCHours();
      const isMorning = hour >= 7 && hour < 19;
      const isAfternoon = hour >= 15;
      if (!isMorning && !isAfternoon) return; // small hours: nothing to send
      const todayKey = dayKeyOf(now);
      const todayMD = todayKey.slice(5);
      // Admins are included: the broker can use the workspace herself. The
      // has-profile check keeps it to accounts that actually opened it.
      const agents = await Account.find({ role: { $in: ['agent', 'admin'] }, isActive: true, status: 'active' }).select('name email').lean();

      for (const agent of agents) {
        try {
          const profile = await AgentProfile.findOne({ account: agent._id });
          if (!profile) continue;
          const morningDue = isMorning && profile.lastDigestKey !== todayKey;
          const nudgeDue = isAfternoon && profile.lastNudgeKey !== todayKey;
          if (!morningDue && !nudgeDue) continue;

          const notify = async (dedupeKey, type, message, leadId) => {
            try {
              await AgentNotification.create({ account: agent._id, dedupeKey, type, message, leadId: leadId ? String(leadId) : null });
            } catch (e) { if (e.code !== 11000) throw e; } // duplicate = already notified
          };
          const prefs = profile.emailPrefs || {};
          const actions = await actionState(agent._id, profile);

          // ── MORNING: the agenda ──
          if (morningDue) {
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
            const openToday = actions.daily.pending;

            for (const f of followups) await notify(`fu:${f.lead._id}:${todayKey}`, 'followup', `${f.overdue ? 'Overdue follow-up' : 'Follow up today'}: ${f.lead.name}`, f.lead._id);
            for (const b of birthdays) await notify(`bd:${b._id}:${todayKey.slice(0, 4)}`, 'birthday', `Birthday today: ${b.name} — send a greeting!`, b._id);
            for (const a of anniversaries) await notify(`an:${a._id}:${todayKey.slice(0, 4)}`, 'anniversary', `Closing anniversary today: ${a.name} — a great day to reconnect`, a._id);
            // The bell carries the day's checklist too, not just the diary.
            if (openToday.length) {
              await notify(`amd:${todayKey}`, 'action', `${openToday.length} of ${actions.daily.total} daily actions to do today`);
            }

            const anything = followups.length + birthdays.length + anniversaries.length + events.length + openToday.length;
            if (anything > 0 && agent.email && prefs.morningDigest !== false) {
              sendEmail(agent.email, `Your GLRA agenda — ${todayKey}`,
                getEmailHeader() + `
                <h2 style="color:#0a1628;">Good morning, ${esc(agent.name || 'Agent')}!</h2>
                <p style="font-size:15px;color:#333">Here's what's on your plate today:</p>
                ${followups.length ? listBlock(`Follow-ups (${followups.length})`, followups.map(f => `${f.lead.name}${f.overdue ? ' (overdue)' : ''}`)) : ''}
                ${birthdays.length ? listBlock('Client birthdays', birthdays.map(b => b.name)) : ''}
                ${anniversaries.length ? listBlock('Closing anniversaries', anniversaries.map(a => a.name)) : ''}
                ${events.length ? listBlock('Scheduled', events.map(ev => `${ev.title}${ev.time ? ` · ${ev.time}` : ''}`)) : ''}
                ${openToday.length ? listBlock(`Daily actions (${openToday.length} of ${actions.daily.total} to do)`, openToday.map(a => a.text)) : ''}
                ${CTA}` + getEmailFooter()
              ).catch(err => console.error('agenda email failed:', err.message));
            }
            profile.lastDigestKey = todayKey;
          }

          // ── AFTERNOON (3pm): what is still unfinished ──
          if (nudgeDue) {
            const due = nudgeScope(now);
            const scope = [
              { type: 'daily', label: 'Daily actions', due: due.daily },
              { type: 'weekly', label: 'Weekly actions', due: due.weekly },
              { type: 'monthly', label: 'Monthly actions', due: due.monthly }
            ];
            const blocks = [];
            for (const s of scope) {
              if (!s.due) continue;
              const st = actions[s.type];
              if (!st.total || !st.pending.length) continue;
              await notify(`ev${s.type[0]}:${todayKey}`, 'action',
                `${st.pending.length} of ${st.total} ${s.label.toLowerCase()} still unfinished`);
              blocks.push(listBlock(`${s.label} — ${st.pending.length} of ${st.total} left`, st.pending.map(a => a.text)));
            }
            if (blocks.length && agent.email && prefs.actionNudge !== false) {
              sendEmail(agent.email, `Still open today — ${todayKey}`,
                getEmailHeader() + `
                <h2 style="color:#0a1628;">Still to do today, ${esc(agent.name || 'Agent')}</h2>
                <p style="font-size:15px;color:#333">These are still unticked with hours left in the day. Even one or two now keeps your numbers honest.</p>
                ${blocks.join('')}
                ${CTA}
                <p style="font-size:12px;color:#888;margin-top:18px">You can switch this reminder off under Profile in your workspace.</p>`
                + getEmailFooter()
              ).catch(err => console.error('nudge email failed:', err.message));
            }
            profile.lastNudgeKey = todayKey;
          }

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
  _test: {
    computeGPS, weekKeyOf, dayKeyOf, monthKeyOf, nextOccurrence, icsEscape, icsUtcStamp,
    effectiveActionDefs, effectiveActionIds, splitActions, nudgeScope
  }
};
