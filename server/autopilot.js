// =============================================================================
// AUTOPILOT — does the routine part of the lead desk without a person
// =============================================================================
// What it does (every 5 minutes, Setting `autopilot`, kill switch in admin):
//   1. First reply: a lead who asked a question and has an email gets an answer
//      a few minutes later (listing they asked about + matches + the questions
//      a broker would ask). Logged on the lead as an email by "GLRA Autopilot".
//   2. Follow-ups: up to two polite nudges (day 3, day 10) if the person never
//      wrote back. Never to anyone who unsubscribed, withdrew consent, is on
//      the "Never email" list, or whom a human has contacted since.
//   3. Hand-off: leads it cannot answer alone (phone only, Messenger, valuation
//      or owner submissions, hot leads) are listed for Catherine in the report.
//   4. Daily report at 18:00 Manila: what it sent, what needs a human, and the
//      health of the listings (photos, price, age, duplicates).
// It never posts to Facebook groups or portals (no API) and never edits prices.
// =============================================================================
const { Lead, Property, Subscriber, Setting } = require('./db');
const { getEmailHeader, getEmailFooter } = require('./email-templates');
const { applyWebsiteCover } = require('./cover');
const { findListingsLite } = require('./listing-lite');
const leadsMod = require('./leads');
const crypto = require('crypto');

const SITE_URL = 'https://glrarealty.com';
const BROKER_INBOX = 'glrarealty@gmail.com';
const BOT = 'GLRA Autopilot';
const DEFAULTS = { enabled: true, replyAfterMin: 5, followUpDays: [3, 10], maxFollowUps: 2, reportHour: 18, senderName: 'Catherine', reportEmail: '' };

const manilaHour = (at) => new Date((at || Date.now()) + 8 * 3600e3).getUTCHours();
const manilaDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const peso = n => '₱' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

async function getSettings() {
  const d = await Setting.findOne({ key: 'autopilot' }).lean();
  const v = (d && d.value) || {};
  const s = { ...DEFAULTS, ...v };
  s.followUpDays = (Array.isArray(s.followUpDays) ? s.followUpDays : DEFAULTS.followUpDays).map(Number).filter(n => n > 0 && n < 90).slice(0, 4);
  return s;
}
async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await Setting.updateOne({ key: 'autopilot' }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
  return next;
}

function unsubUrl(email) {
  const e = String(email || '').toLowerCase().trim();
  const secret = process.env.LINK_SECRET || process.env.JWT_SECRET || '';
  const t = crypto.createHmac('sha256', secret).update('unsub:' + e).digest('hex').slice(0, 32);
  return `${SITE_URL}/unsubscribe?e=${encodeURIComponent(e)}&t=${t}`;
}

// ── who may be emailed ───────────────────────────────────────
async function excludedSet() {
  const d = await Setting.findOne({ key: 'bulkmail_exclude' }).lean();
  const arr = d && d.value && Array.isArray(d.value.emails) ? d.value.emails : [];
  return new Set(arr.map(x => String(x && x.email || x).toLowerCase()));
}
function emailable(lead) {
  const to = (lead.emails || [])[0];
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return '';
  if (/@glrarealty\.com$/i.test(to) || to.toLowerCase() === BROKER_INBOX) return '';
  if (lead.consent && lead.consent.marketing === false && /^Withdrawn/i.test(lead.consent.how || '')) return '';
  return to;
}
async function blockedFor(to, excl) {
  if (excl.has(to)) return true;
  return !!(await Subscriber.exists({ email: to, $or: [{ isActive: false }] }));
}

// ── email bodies ─────────────────────────────────────────────
function cardsHtml(props, rent, esc) {
  return props.map(p => {
    const price = rent ? p.monthlyRental : p.price;
    const img = /^https:\/\/res\.cloudinary\.com\//.test(p.mainImage || '') ? p.mainImage.replace('/upload/', '/upload/c_fill,w_560,h_320,q_auto,f_jpg/') : '';
    return `<tr><td style="padding:0 0 16px 0"><a href="${SITE_URL}/property/${String(p._id)}" style="text-decoration:none;color:#0a0a0a;display:block;border:2px solid #0a0a0a">
      ${img ? `<img src="${esc(img)}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0">` : ''}
      <div style="padding:12px 14px;font-family:Inter,Helvetica,Arial,sans-serif"><div style="font-size:18px;font-weight:800">${price ? esc(peso(price)) + (rent ? ' / month' : '') : 'Price on request'}</div>
      <div style="font-size:14px;font-weight:600;margin-top:2px">${esc(p.title)}</div><div style="font-size:12px;color:#555;margin-top:2px">${esc(p.location || '')}</div>
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-top:8px;color:#c02e00">View this listing &rarr;</div></div></a></td></tr>`;
  }).join('');
}
function wrap(esc, first, paras, props, rent, sender, unsub) {
  return getEmailHeader() + `
    <h2 style="color:#0a0a0a;font-family:Inter,Helvetica,Arial,sans-serif;font-size:22px;margin:0 0 8px 0">Hi ${esc(first)},</h2>
    ${paras.map(t => `<p style="color:#0a0a0a;line-height:1.6;font-size:14px">${esc(t).replace(/\n/g, '<br>')}</p>`).join('')}
    ${props.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:16px 0">${cardsHtml(props, rent, esc)}</table>` : ''}
    <p style="color:#0a0a0a;line-height:1.6;font-size:14px">Just reply to this email or message us on WhatsApp at +63 917 177 4572.</p>
    <p style="color:#0a0a0a;line-height:1.6;font-size:14px;margin-top:20px">${esc(sender)}<br><strong>GLRA Realty</strong></p>
    <p style="color:#777;font-size:11px;line-height:1.5;margin-top:20px">You are receiving this because you contacted GLRA Realty. <a href="${esc(unsub)}" style="color:#777;text-decoration:underline">Unsubscribe</a> and we will not email you again.</p>
  ` + getEmailFooter();
}

// What kind of first reply fits this lead.
function replyKind(lead) {
  const last = (lead.sources || [])[(lead.sources || []).length - 1] || {};
  const it = lead.intent || {};
  const said = String(last.message || '');
  if (last.kind === 'valuation' || last.kind === 'submission' || (/(i (want|would like|plan) to (sell|lease out|rent out)|sell my|selling my|list my|rent out my|valuation|appraisal|how much is my)/i.test(said)) || ['sell', 'lease_out'].includes(it.deal) || ['seller', 'landlord'].includes(lead.type)) return 'owner';
  return last.kind === 'viewing' ? 'viewing' : 'buyer';
}

async function pickListings(lead, live, limit) {
  const out = [];
  const asked = (lead.sources || []).map(s => String(s.propertyId || '')).filter(x => /^[a-f0-9]{24}$/i.test(x));
  for (const id of asked.slice(-2).reverse()) {
    const p = live.find(x => String(x._id) === id);
    if (p) out.push(p);
  }
  for (const m of leadsMod._test.matchListings(lead, live, limit + 2)) {
    if (out.length >= limit) break;
    if (!out.some(p => String(p._id) === m._id)) { const p = live.find(x => String(x._id) === m._id); if (p) out.push(p); }
  }
  return out.slice(0, limit);
}

function firstReply(lead, kind, props, esc, s, unsub) {
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const rent = (lead.intent || {}).deal === 'rent' || lead.type === 'renter';
  const last = (lead.sources || [])[(lead.sources || []).length - 1] || {};
  const about = last.propertyTitle ? ` about ${last.propertyTitle}` : '';
  let paras, subject;
  if (kind === 'owner') {
    subject = 'Thank you for contacting GLRA Realty about your property';
    paras = [`Thank you for contacting GLRA Realty${about ? '' : ' about your property'}. We have your details and ${s.senderName} will call you personally within one working day to talk about the price and the documents.`,
      'To make that call useful, please reply with: the property address or project and unit, the title type (TCT/CCT or tax declaration), whether it is still mortgaged, and the price or rent you have in mind.'];
    return { subject, html: wrap(esc, first, paras, [], rent, s.senderName, unsub) };
  }
  if (kind === 'viewing') {
    subject = `Your viewing request${last.propertyTitle ? ': ' + last.propertyTitle : ''} - GLRA Realty`;
    paras = [`Thank you for asking to view${last.propertyTitle ? ' ' + last.propertyTitle : ' a property'}. We have your request and ${s.senderName} will confirm a schedule with you shortly.`,
      'To speed it up, reply with two or three dates and times that suit you (we are open Monday to Saturday, 9am to 6pm).'];
  } else {
    subject = `Thank you for your enquiry${last.propertyTitle ? ': ' + last.propertyTitle : ''} - GLRA Realty`;
    paras = [`Thank you for your enquiry${about}. ${s.senderName} will follow up with you personally. In the meantime, here ${props.length > 1 ? 'are listings' : 'is a listing'} you may like.`,
      'So we can send you better matches, reply with your budget, preferred area, and whether you are buying with cash, a bank loan or Pag-IBIG.'];
  }
  return { subject, html: wrap(esc, first, paras, props, rent, s.senderName, unsub) };
}
function followUpMail(lead, n, props, esc, s, unsub) {
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const rent = (lead.intent || {}).deal === 'rent' || lead.type === 'renter';
  const paras = n === 1
    ? ['Just checking in on your property enquiry. If you are still looking, I can arrange a viewing or send more options in your budget.', 'If you have already been in touch with us, please ignore this note.']
    : ['One last note from us: if your search is still on, reply with your budget and preferred area and I will send the best current options. If your plans have changed, no problem at all.', 'If you have already been in touch with us, please ignore this note.'];
  return { subject: n === 1 ? 'Still looking? - GLRA Realty' : 'A last note from GLRA Realty', html: wrap(esc, first, paras, props.slice(0, 2), rent, s.senderName, unsub) };
}

// ── the work ─────────────────────────────────────────────────
function human(a) { return a && a.byName !== BOT && ['call', 'whatsapp', 'viber', 'messenger', 'sms', 'email', 'meeting', 'viewing', 'listings_sent', 'social_reply'].includes(a.type); }

async function runOnce({ sendEmail, esc, now: nowAt }) {
  const s = await getSettings();
  const stats = { replied: 0, followed: 0, failed: 0, skipped: 0 };
  if (!s.enabled) return stats;
  const now = nowAt || Date.now();
  const hour = manilaHour(now);
  const excl = await excludedSet();
  let live = null;
  const getLive = async () => live || (live = (await findListingsLite({ status: 'available' }, ['title', 'location', 'listingType', 'price', 'monthlyRental', 'propertyType', 'bedrooms', 'createdAt'])).map(applyWebsiteCover));

  // 1. first replies
  const waiting = await Lead.find({ archived: { $ne: true }, stage: { $nin: ['won', 'lost'] },
    lastAskAt: { $lte: new Date(now - s.replyAfterMin * 60e3), $gte: new Date(now - 3 * 864e5) } }).limit(15);
  for (const l of waiting) {
    if (!leadsMod.isWaiting(l)) continue;
    if (l.autopilot && l.autopilot.askAt && new Date(l.autopilot.askAt).getTime() === new Date(l.lastAskAt).getTime()) continue;
    const to = emailable(l);
    const stamp = { askAt: l.lastAskAt, at: new Date() };
    if (!to || await blockedFor(to, excl) || !(await leadsMod._test.hasAsked(l))) { l.autopilot = { ...(l.autopilot || {}), ...stamp, skipped: true }; l.markModified('autopilot'); await l.save(); stats.skipped++; continue; }
    const kind = replyKind(l);
    const props = kind === 'owner' ? [] : await pickListings(l, await getLive(), 3);
    const m = firstReply(l, kind, props, esc, s, unsubUrl(to));
    const r = await sendEmail(to, m.subject, m.html, 'GLRA Realty', { email: BROKER_INBOX, name: 'GLRA Realty' }, null,
      { 'List-Unsubscribe': `<${unsubUrl(to)}>, <mailto:${BROKER_INBOX}?subject=Unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }).catch(() => null);
    if (r && r.success) {
      leadsMod.pushActivity(l, { type: 'email', text: `Auto-reply sent (${kind}): ${m.subject}`.slice(0, 300), at: new Date(), by: 'autopilot', byName: BOT });
      l.autopilot = { askAt: l.lastAskAt, at: new Date(), replies: ((l.autopilot && l.autopilot.replies) || 0) + 1, followUps: 0, kind };
      stats.replied++;
    } else {
      const fails = ((l.autopilot && l.autopilot.fails) || 0) + 1;
      l.autopilot = { ...(l.autopilot || {}), fails, askAt: fails >= 3 ? l.lastAskAt : (l.autopilot || {}).askAt, failedAt: new Date(), skipped: fails >= 3 };
      stats.failed++;
    }
    l.markModified('autopilot'); l.updatedAt = new Date(); await l.save();
  }

  // 2. follow-ups (daytime only)
  if (hour >= 9 && hour < 19 && s.followUpDays.length) {
    const cand = await Lead.find({ archived: { $ne: true }, stage: { $in: ['new', 'contacted'] }, 'autopilot.replies': { $gte: 1 },
      'autopilot.at': { $lte: new Date(now - s.followUpDays[0] * 864e5), $gte: new Date(now - 45 * 864e5) } }).limit(15);
    for (const l of cand) {
      const ap = l.autopilot || {};
      const n = ap.followUps || 0;
      if (n >= s.maxFollowUps || n >= s.followUpDays.length) continue;
      const lastAt = new Date(ap.lastFollowAt || ap.at).getTime();
      const due = new Date(ap.at).getTime() + s.followUpDays[n] * 864e5;
      if (now < due || now - lastAt < 2 * 864e5) continue;
      // The person wrote again or a human has been in touch since the auto-reply: leave them to the humans.
      if (l.lastInboundAt && new Date(l.lastInboundAt) > new Date(ap.at)) continue;
      if ((l.activities || []).some(a => human(a) && new Date(a.at) > new Date(ap.at))) continue;
      if (l.nextFollowUp) continue;
      const to = emailable(l);
      if (!to || await blockedFor(to, excl) || ap.kind === 'owner') continue;
      const props = await pickListings(l, await getLive(), 2);
      const m = followUpMail(l, n + 1, props, esc, s, unsubUrl(to));
      const r = await sendEmail(to, m.subject, m.html, 'GLRA Realty', { email: BROKER_INBOX, name: 'GLRA Realty' }, null,
        { 'List-Unsubscribe': `<${unsubUrl(to)}>, <mailto:${BROKER_INBOX}?subject=Unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }).catch(() => null);
      if (r && r.success) {
        leadsMod.pushActivity(l, { type: 'email', text: `Auto follow-up ${n + 1} sent`, at: new Date(), by: 'autopilot', byName: BOT });
        l.autopilot = { ...ap, followUps: n + 1, lastFollowAt: new Date() }; stats.followed++;
      } else { l.autopilot = { ...ap, lastFollowAt: new Date() }; stats.failed++; }
      l.markModified('autopilot'); await l.save();
    }
  }
  if (stats.replied || stats.followed || stats.failed) {
    const day = manilaDay();
    const cur = (await Setting.findOne({ key: 'autopilot_day' }).lean());
    const v = cur && cur.value && cur.value.day === day ? cur.value : { day, replied: 0, followed: 0, failed: 0 };
    v.replied += stats.replied; v.followed += stats.followed; v.failed += stats.failed;
    await Setting.updateOne({ key: 'autopilot_day' }, { $set: { value: v, updatedAt: new Date() } }, { upsert: true });
  }
  return stats;
}

// ── listing health ───────────────────────────────────────────
async function listingHealth() {
  const rows = await Property.find({ status: 'available' }).select('title location price monthlyRental listingType propertyType gallery createdAt editedAt reviewedAt').lean();
  const now = Date.now();
  const issues = { noPrice: [], fewPhotos: [], stale: [], dupes: [] };
  const seen = new Map();
  for (const p of rows) {
    const lt = String(p.listingType || '').toUpperCase();
    const price = lt === 'FOR LEASE' ? p.monthlyRental : p.price;
    if (!price) issues.noPrice.push(p.title);
    const need = /lot|land/i.test(p.propertyType || '') ? 3 : 5;
    const photos = Array.isArray(p.gallery) ? p.gallery.length : 0;
    if (photos < need) issues.fewPhotos.push(`${p.title} (${photos}/${need})`);
    const touched = Math.max(...[p.editedAt, p.reviewedAt, p.createdAt].map(d => d ? new Date(d).getTime() : 0));
    if (now - touched > 150 * 864e5) issues.stale.push(`${p.title} (${Math.round((now - touched) / 864e5)} d)`);
    const k = String(p.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + lt;
    if (seen.has(k)) issues.dupes.push(p.title); else seen.set(k, 1);
  }
  return { total: rows.length, ...issues };
}

async function buildReport(esc) {
  const s = await getSettings();
  const day = manilaDay();
  const d = await Setting.findOne({ key: 'autopilot_day' }).lean();
  const t = d && d.value && d.value.day === day ? d.value : { replied: 0, followed: 0, failed: 0 };
  const open = await Lead.find({ archived: { $ne: true }, stage: { $nin: ['won', 'lost'] } }).select('-activities -vids').lean();
  const needHuman = open.filter(l => {
    const ap = l.autopilot || {};
    const noEmail = !emailable(l);
    return leadsMod.isWaiting(l) && (noEmail || ap.skipped || ap.fails) || (l.score >= 70 && l.stage !== 'won');
  }).sort((a, b) => b.score - a.score).slice(0, 15);
  const h = await listingHealth();
  const li = (title, arr) => arr.length ? `<h3 style="font-size:15px;margin:16px 0 4px">${title} (${arr.length})</h3><p style="font-size:13px;line-height:1.5;margin:0">${arr.slice(0, 12).map(esc).join('<br>')}${arr.length > 12 ? `<br>and ${arr.length - 12} more` : ''}</p>` : '';
  const row = l => { const src = (l.sources || [])[l.sources.length - 1] || {}; return `${l.name || l.emails[0] || '+' + (l.phones[0] || '?')} (score ${l.score}${l.phones[0] ? ', +' + l.phones[0] : ''}${l.emails[0] ? ', ' + l.emails[0] : ''}) - ${src.label || ''}${src.propertyTitle ? ': ' + src.propertyTitle : ''}`; };
  const html = getEmailHeader() + `
    <h2 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 6px">Autopilot report, ${esc(day)}</h2>
    <p style="font-size:14px;line-height:1.6">${s.enabled ? 'Autopilot is ON.' : '<strong>Autopilot is OFF.</strong>'} Today it sent <strong>${t.replied}</strong> first replies and <strong>${t.followed}</strong> follow-ups${t.failed ? `, and <strong style="color:#c02e00">${t.failed} emails failed to send</strong> (check the email service)` : ''}.</p>
    ${li('Needs a person: reply by phone or Messenger, or a hot lead', needHuman.map(row))}
    <h3 style="font-size:15px;margin:18px 0 4px">Listing health (${h.total} live)</h3>
    ${li('No price', h.noPrice)}${li('Too few photos', h.fewPhotos)}${li('Not touched in 150+ days: confirm still available', h.stale)}${li('Possible duplicates', h.dupes)}
    ${!(h.noPrice.length || h.fewPhotos.length || h.stale.length || h.dupes.length) ? '<p style="font-size:13px">No problems found.</p>' : ''}
    <p style="font-size:12px;color:#555;margin-top:20px">Not automated: posting in Facebook groups and listing portals (they have no API), phone calls, and viewings.</p>
    <p><a href="${SITE_URL}/admin.html#leads" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;text-decoration:none;font-weight:600">Open the Leads tab</a></p>
  ` + getEmailFooter();
  return { html, subject: `Autopilot: ${t.replied} replies, ${needHuman.length} need a person, ${h.fewPhotos.length + h.noPrice.length} listing problems`, stats: t, needHuman: needHuman.length, health: h };
}

async function maybeReport({ sendEmail, esc }) {
  const s = await getSettings();
  if (!s.enabled || manilaHour() < s.reportHour || manilaHour() > 22) return;
  const day = manilaDay();
  const got = await Setting.findOneAndUpdate({ key: 'autopilot_report', 'value.day': { $ne: day } }, { $set: { value: { day }, updatedAt: new Date() } });
  if (!got) { if (await Setting.exists({ key: 'autopilot_report' })) return; await Setting.create({ key: 'autopilot_report', value: { day } }); }
  const lset = await leadsMod.getLeadSettings();
  const to = s.reportEmail || lset.notifyEmail;
  if (!to) return;
  const r = await buildReport(esc);
  await sendEmail(to, r.subject, r.html).catch(() => {});
}

function registerAutopilot(app, { sendEmail, esc }) {
  const { verifyToken, requireAdmin, logAudit } = require('./auth');
  app.get('/api/admin/autopilot', verifyToken, requireAdmin, async (req, res) => {
    try {
      const r = await buildReport(esc);
      res.json({ settings: await getSettings(), today: r.stats, needHuman: r.needHuman, health: { total: r.health.total, noPrice: r.health.noPrice.length, fewPhotos: r.health.fewPhotos.length, stale: r.health.stale.length, dupes: r.health.dupes.length } });
    } catch (e) { res.status(500).json({ error: 'Could not load autopilot' }); }
  });
  app.put('/api/admin/autopilot', verifyToken, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {}, patch = {};
      if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
      if (b.replyAfterMin != null) patch.replyAfterMin = Math.min(120, Math.max(1, Number(b.replyAfterMin) || 5));
      if (typeof b.senderName === 'string') patch.senderName = b.senderName.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Catherine';
      if (typeof b.reportEmail === 'string') patch.reportEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.reportEmail.trim()) ? b.reportEmail.trim().slice(0, 120) : '';
      const s = await saveSettings(patch);
      await logAudit(req, 'UPDATE', 'Autopilot', '', 'settings', patch);
      res.json({ success: true, settings: s });
    } catch (e) { res.status(500).json({ error: 'Could not save' }); }
  });
  app.post('/api/admin/autopilot/run', verifyToken, requireAdmin, async (req, res) => {
    try { res.json({ success: true, stats: await runOnce({ sendEmail, esc }) }); } catch (e) { res.status(500).json({ error: 'Run failed' }); }
  });
  app.post('/api/admin/autopilot/report', verifyToken, requireAdmin, async (req, res) => {
    try {
      const lset = await leadsMod.getLeadSettings();
      const to = (await getSettings()).reportEmail || lset.notifyEmail;
      const r = await buildReport(esc);
      const out = await sendEmail(to, r.subject, r.html);
      res.json({ success: !!(out && out.success), to });
    } catch (e) { res.status(500).json({ error: 'Could not send' }); }
  });
}

function startAutopilot({ sendEmail, esc }) {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await runOnce({ sendEmail, esc }); await maybeReport({ sendEmail, esc }); }
    catch (e) { console.error('Autopilot error:', e.message); } finally { running = false; }
  };
  setTimeout(() => { tick(); setInterval(tick, 5 * 60e3).unref(); }, 3 * 60e3).unref();
}

module.exports = { registerAutopilot, startAutopilot, runOnce, buildReport, listingHealth, getSettings, _test: { replyKind, emailable } };
