// =============================================================================
// META — Facebook / Instagram lead ads, insights and the Page inbox
// =============================================================================
// Three parts, each behind its own switch in Render's environment settings
// (all OFF by default; while a switch is off its routes answer 404 and its
// timers never start):
//
//   META_LEADS_ENABLED=1     Lead Ads: Meta's webhook calls /api/meta/webhook
//                            for every form filled in; the lead is fetched from
//                            the Graph API and added to the Leads tab (one
//                            person, deduplicated by email then phone). An
//                            email and a Telegram message go out at once. An
//                            hourly "bulk read" of every lead form catches any
//                            lead the webhook missed.
//   META_INSIGHTS_ENABLED=1  A daily snapshot (about 6 am Manila) of the Page,
//                            Instagram and ad-account numbers into MetaDaily,
//                            the admin Meta tab, and a Monday 8 am summary email.
//   META_INBOX_ENABLED=1     Messenger messages, Instagram messages and comments
//                            on Facebook / Instagram posts become lead touches;
//                            the Page's own reply counts as contact and stops
//                            the reply clock.
//
// READ-ONLY towards Meta. There is deliberately no function here that creates,
// edits or pauses an ad, a campaign or an ad set, or touches a budget. The
// only requests that write anything are:
//   * subscribePage(): POST /{page-id}/subscribed_apps, which tells Meta to
//     send this Page's events to our webhook (an admin presses a button);
//   * telegramSend(): a message to the office's own Telegram chat.
//
// Tokens never reach the logs: everything written to MetaLog or the console
// goes through scrub(). Routes: /api/meta/webhook (Meta only, signed) and
// /api/admin/meta/* (signed-in, meta_view; actions are admin-only).
// =============================================================================
'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Setting, Lead, MetaEvent, MetaLog, MetaDaily } = require('./db');
const { verifyToken, requirePermission, requireAdmin, logAudit } = require('./auth');
const { getEmailHeader, getEmailFooter } = require('./email-templates');
const { ingestLead, getLeadSettings, pushActivity, isWaiting } = require('./leads');

const SITE_URL = 'https://glrarealty.com';
const STATE_KEY = 'meta_state';   // written by the code: token status, last runs, metric status, top posts
const PREFS_KEY = 'meta';         // chosen by the admin: Telegram detail level
const META_KINDS = ['meta_lead', 'messenger', 'fb_comment', 'ig_dm', 'ig_comment'];
const LEAD_FIELDS = 'id,field_data,created_time,ad_id,ad_name,adset_name,campaign_id,campaign_name,form_id,platform,is_organic';
// A lead form is a request about one ad, not permission to send listings. Marketing
// consent is recorded only when the form asked for it and the person said yes.
const LEAD_CONSENT = 'Ticked yes to updates on a Meta Lead Ad form (privacy policy linked on the form)';

// ── SETTINGS FROM THE ENVIRONMENT (read on every use) ─────────
const env = k => String(process.env[k] || '').trim();
const flag = k => /^(1|true|yes|on)$/i.test(env(k));
const LEADS_ON = () => flag('META_LEADS_ENABLED');
const INSIGHTS_ON = () => flag('META_INSIGHTS_ENABLED');
const INBOX_ON = () => flag('META_INBOX_ENABLED');
const anyOn = () => LEADS_ON() || INSIGHTS_ON() || INBOX_ON();
const webhookOn = () => LEADS_ON() || INBOX_ON();
const PAGE_ID = () => (env('META_PAGE_ID').match(/^\d{1,30}$/) || [''])[0];
const IG_ID = () => (env('META_IG_USER_ID').match(/^\d{1,30}$/) || [''])[0];
const AD_ACCOUNT = () => (env('META_AD_ACCOUNT_ID').replace(/^act_/, '').match(/^\d{1,30}$/) || [''])[0];
// A base-URL override exists only for the local test kit (scripts/test-meta.js
// points it at a stub server). It is honoured only for a localhost address, so
// a stray value in production can never send a token anywhere but Meta.
function localOverride(name) {
  const v = env(name).replace(/\/+$/, '');
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v) ? v : '';
}
const graphBase = () => (localOverride('META_GRAPH_BASE') || 'https://graph.facebook.com') + '/' + (/^v\d+\.\d+$/.test(env('META_GRAPH_VERSION')) ? env('META_GRAPH_VERSION') : 'v24.0');
const telegramBase = () => localOverride('TELEGRAM_API_BASE') || 'https://api.telegram.org';
const retryBase = () => Math.max(20, Math.min(10000, Number(env('META_RETRY_BASE_MS')) || 1000));

// ── SMALL HELPERS ─────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad2 = n => String(n).padStart(2, '0');
function manilaDay(d) { const x = new Date((d ? new Date(d).getTime() : Date.now()) + 8 * 3600e3); return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`; }
function manilaHour() { return new Date(Date.now() + 8 * 3600e3).getUTCHours(); }
function manilaWeekday() { return new Date(Date.now() + 8 * 3600e3).getUTCDay(); }
function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
// Meta writes times as 2026-10-12T03:14:15+0000; make the offset one every engine reads.
function metaTime(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number' || /^\d+$/.test(String(t))) { const n = Number(t); return new Date(n < 1e12 ? n * 1000 : n); }
  const d = new Date(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isNaN(d) ? null : d;
}
// Insights values end at the close of the day they count, so the day is the one before end_time.
function endDay(endTime) { const d = metaTime(endTime); return d ? new Date(d.getTime() - 864e5).toISOString().slice(0, 10) : ''; }
const num = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

// Removes anything that could be a token before text is logged or stored.
function scrub(s) {
  let out = String(s == null ? '' : s)
    .replace(/(access_token|appsecret_proof|input_token)=[^&\s"']+/gi, '$1=[hidden]')
    .replace(/\bEA[A-Za-z0-9]{20,}/g, '[token]')
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[token]')
    .replace(/\b\d{5,}\|[A-Za-z0-9_-]{16,}/g, '[app-token]');
  for (const k of ['META_SYSTEM_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'TELEGRAM_BOT_TOKEN']) {
    const v = env(k);
    if (v.length >= 6) out = out.split(v).join('[hidden]');
  }
  return out;
}

// Every error and warning lands in MetaLog (kept 90 days, shown in the Meta tab).
function logMeta(level, area, message, x) {
  const m = scrub(message).slice(0, 1000);
  (level === 'error' ? console.error : console.log)('[meta] ' + area + ': ' + m);
  return MetaLog.create({ level, area, message: m, code: String((x && x.code) || '').slice(0, 40), path: scrub((x && x.path) || '').slice(0, 300) }).catch(() => {});
}

async function getState() { const d = await Setting.findOne({ key: STATE_KEY }).lean(); return (d && d.value) || {}; }
async function patchState(patch) {
  const set = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) set['value.' + k] = v;
  await Setting.updateOne({ key: STATE_KEY }, { $set: set }, { upsert: true });
}
async function getPrefs() { const d = await Setting.findOne({ key: PREFS_KEY }).lean(); return { telegramDetails: false, ...((d && d.value) || {}) }; }

// One job at a time for everything that writes leads: two deliveries about the
// same person arriving together must not each create a new lead.
let _chain = Promise.resolve();
function enqueue(fn) { const p = _chain.then(fn); _chain = p.catch(() => {}); return p; }

// ══ GRAPH API CLIENT (read-only) ══════════════════════════════
class MetaError extends Error {
  constructor(message, o) { super(message); Object.assign(this, { code: '', path: '', retryable: false }, o || {}); }
}
// Rate-limit and temporary errors worth another try (Meta's own list), plus any HTTP 5xx.
const RETRY_CODES = new Set([4, 17, 32, 613]);
const isRetryCode = c => RETRY_CODES.has(c) || (c >= 80000 && c <= 80014);
function appsecretProof(token) { return crypto.createHmac('sha256', env('META_APP_SECRET')).update(token).digest('hex'); }

// Meta reports how close we are to its limits in response headers. Near the
// top we slow down; at the top we stop non-urgent calls until it says so.
let _slowUntil = 0, _pauseUntil = 0, _usageWarnAt = 0;
function noteUsage(h) {
  const pct = []; let regainMin = 0;
  const read = name => { try { return JSON.parse(h.get(name) || 'null'); } catch (e) { return null; } };
  const app = read('x-app-usage');
  if (app) pct.push(app.call_count, app.total_cputime, app.total_time);
  const acct = read('x-ad-account-usage');
  if (acct) pct.push(acct.acc_id_util_pct);
  const buc = read('x-business-use-case-usage');
  if (buc && typeof buc === 'object') {
    for (const arr of Object.values(buc)) for (const u of [].concat(arr || [])) {
      if (!u) continue;
      pct.push(u.call_count, u.total_cputime, u.total_time);
      regainMin = Math.max(regainMin, Number(u.estimated_time_to_regain_access) || 0);
    }
  }
  const top = Math.max(0, ...pct.map(Number).filter(n => isFinite(n)));
  if (regainMin > 0) _pauseUntil = Date.now() + Math.min(regainMin, 120) * 60e3;
  else if (top >= 95) _pauseUntil = Date.now() + 5 * 60e3;
  else if (top >= 75) _slowUntil = Date.now() + 60e3;
  if (top >= 75 && Date.now() - _usageWarnAt > 10 * 60e3) { _usageWarnAt = Date.now(); logMeta('warn', 'graph', `Meta usage at ${Math.round(top)}% of its limit; slowing down`); }
}

// GET one Graph object or edge. Retries rate-limit / temporary errors up to 4
// times with exponential backoff and jitter; every failure is logged.
// opts: token, area, tries, quiet (no error log), urgent (ignore a usage pause), noProof.
async function metaGet(path, params, opts) {
  const o = opts || {};
  const token = o.token || env('META_SYSTEM_TOKEN');
  const p = String(path || '').replace(/^\/+/, '');
  if (!token) throw new MetaError('META_SYSTEM_TOKEN is not set', { code: 'no_token', path: p });
  if (!/^[A-Za-z0-9_./]+$/.test(p)) throw new MetaError('Bad Graph path', { code: 'bad_path', path: p.slice(0, 80) });
  if (_pauseUntil > Date.now() && !o.urgent) {
    const e = new MetaError(`Paused until ${new Date(_pauseUntil).toISOString()}: Meta usage limit reached`, { code: 'usage_pause', path: p });
    if (!o.quiet) logMeta('warn', o.area || 'graph', e.message, e);
    throw e;
  }
  const tries = Math.max(1, Math.min(4, o.tries || 4));
  let last = null;
  for (let i = 0; i < tries; i++) {
    if (_slowUntil > Date.now()) await sleep(1500);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    qs.set('access_token', token);
    if (!o.noProof && env('META_APP_SECRET')) qs.set('appsecret_proof', appsecretProof(token));
    let res = null, body = null;
    try {
      res = await fetch(graphBase() + '/' + p + '?' + qs.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs || 20000) });
      noteUsage(res.headers);
      body = await res.json().catch(() => null);
    } catch (e) {
      last = new MetaError('Network error: ' + scrub(e.message), { code: 'network', path: p, retryable: true });
    }
    if (res) {
      if (res.ok && body && !body.error) return body;
      const er = (body && body.error) || {};
      const code = Number(er.code) || 0;
      last = new MetaError(scrub(er.message || ('HTTP ' + res.status)), {
        code: code || res.status, subcode: er.error_subcode || '', status: res.status, path: p,
        retryable: res.status >= 500 || isRetryCode(code) || er.is_transient === true
      });
    }
    if (!last.retryable || i === tries - 1) break;
    const wait = Math.min(60000, retryBase() * 2 ** i) + Math.floor(Math.random() * retryBase());
    logMeta('warn', o.area || 'graph', `Graph error ${last.code} on ${p}: ${last.message} (try ${i + 1} of ${tries}, again in ${Math.round(wait / 100) / 10}s)`, last);
    await sleep(wait);
  }
  if (!o.quiet) logMeta('error', o.area || 'graph', `Graph error ${last.code} on ${p}: ${last.message}`, last);
  throw last;
}
// Follows the "after" cursor for edges that page (forms, leads, posts, ad rows).
async function metaGetAll(path, params, opts, maxPages) {
  const out = [];
  let after;
  for (let i = 0; i < (maxPages || 10); i++) {
    const d = await metaGet(path, { ...params, after }, opts);
    if (Array.isArray(d.data)) out.push(...d.data);
    after = d.paging && d.paging.cursors && d.paging.cursors.after;
    if (!after || !(d.paging && d.paging.next)) break;
  }
  return out;
}

// The Page's own token, derived from the system-user token and kept in memory.
let _pageTok = { token: '', at: 0 };
async function pageToken() {
  if (_pageTok.token && Date.now() - _pageTok.at < 6 * 3600e3) return _pageTok.token;
  if (!PAGE_ID()) return env('META_SYSTEM_TOKEN');
  try {
    const d = await metaGet(PAGE_ID(), { fields: 'access_token' }, { area: 'token', tries: 2, urgent: true });
    if (d && typeof d.access_token === 'string' && d.access_token) { _pageTok = { token: d.access_token, at: Date.now() }; return d.access_token; }
  } catch (e) { /* logged by metaGet; the system token can still read most things */ }
  return env('META_SYSTEM_TOKEN');
}

// THE ONLY GRAPH WRITE: ask Meta to send this Page's events to our webhook.
// Pressed by an admin in the Meta tab after the app is set up.
async function subscribePage() {
  if (!PAGE_ID()) throw new MetaError('META_PAGE_ID is not set', { code: 'no_page' });
  const fields = [LEADS_ON() && 'leadgen', INBOX_ON() && 'messages', INBOX_ON() && 'message_echoes', INBOX_ON() && 'feed'].filter(Boolean);
  const tok = await pageToken();
  const qs = new URLSearchParams({ subscribed_fields: fields.join(','), access_token: tok });
  if (env('META_APP_SECRET')) qs.set('appsecret_proof', appsecretProof(tok));
  let j = null, status = 0;
  try {
    const r = await fetch(`${graphBase()}/${PAGE_ID()}/subscribed_apps?${qs}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
    status = r.status;
    j = await r.json().catch(() => null);
  } catch (e) { j = { error: { message: e.message } }; }
  if (!j || !j.success) {
    const msg = 'Subscribing the Page to webhooks failed: ' + scrub((j && j.error && j.error.message) || ('HTTP ' + status));
    logMeta('error', 'webhook', msg);
    throw new MetaError(msg, { code: (j && j.error && j.error.code) || status });
  }
  logMeta('info', 'webhook', 'Page subscribed to webhook fields: ' + fields.join(', '));
  return { fields };
}

// ══ TELEGRAM ══════════════════════════════════════════════════
async function telegramSend(text) {
  const tok = env('TELEGRAM_BOT_TOKEN'), chat = env('TELEGRAM_CHAT_ID');
  if (!tok || !chat) return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set' };
  try {
    const r = await fetch(`${telegramBase()}/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) {
      const msg = 'Telegram message failed: ' + scrub((j && j.description) || ('HTTP ' + r.status));
      logMeta('error', 'telegram', msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    const msg = 'Telegram message failed: ' + scrub(e.message);
    logMeta('error', 'telegram', msg);
    return { ok: false, error: msg };
  }
}
// Chats that have written to the bot recently, so the admin can find the chat id.
async function telegramChats() {
  const tok = env('TELEGRAM_BOT_TOKEN');
  if (!tok) return { error: 'Set TELEGRAM_BOT_TOKEN first, then send your bot any message.' };
  try {
    const r = await fetch(`${telegramBase()}/bot${tok}/getUpdates`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) return { error: 'Telegram said: ' + scrub((j && j.description) || ('HTTP ' + r.status)) };
    const seen = new Map();
    for (const u of j.result || []) {
      const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
      if (c && c.id != null) seen.set(String(c.id), { id: String(c.id), type: c.type || '', name: clean(c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '', 80) });
    }
    return { chats: [...seen.values()] };
  } catch (e) { return { error: 'Telegram could not be reached: ' + scrub(e.message) }; }
}

// ══ MODULE 1: LEAD ADS ════════════════════════════════════════
const FIELD_ROLE = { full_name: 'name', name: 'name', first_name: 'first', last_name: 'last', email: 'email', work_email: 'email',
  phone_number: 'phone', phone: 'phone', mobile_number: 'phone', work_phone_number: 'phone' };
function mapLeadFields(d) {
  const f = {}, extra = [];
  for (const x of (Array.isArray(d.field_data) ? d.field_data : []).slice(0, 40)) {
    const k = clean(x && x.name, 80).toLowerCase();
    const v = (Array.isArray(x && x.values) ? x.values : [x && x.values]).filter(y => y != null && y !== '').map(y => clean(y, 500)).join(', ').slice(0, 500);
    if (!k || !v) continue;
    if (FIELD_ROLE[k] && !f[FIELD_ROLE[k]]) f[FIELD_ROLE[k]] = v; else extra.push([k, v]);
  }
  const human = k => k.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[?:]+$/, '').replace(/^./, c => c.toUpperCase());
  const interest = extra.find(([k]) => /property|interested|service/.test(k));
  const optIn = extra.some(([k, v]) => /marketing|updates|newsletter|similar listings|consent|contact me about/.test(k) && /^(yes|true|oo|agree|i agree|opo)\b/i.test(v));
  const platform = String(d.platform || '').toLowerCase();
  const ig = platform === 'ig' || platform === 'instagram';
  const where = ig ? 'Instagram' : 'Facebook';
  return {
    id: String(d.id || ''),
    name: f.name || [f.first, f.last].filter(Boolean).join(' '),
    email: f.email || '', phone: f.phone || '',
    propertyTitle: interest ? interest[1] : '',
    message: extra.map(([k, v]) => `${human(k)}: ${v}`).join('\n').slice(0, 2000),
    where,
    label: (`${where} lead ad` + (d.ad_name ? ': ' + clean(d.ad_name, 200) : '') + (interest ? ' · ' + interest[1] : '')).slice(0, 300),
    attrib: { src: ig ? 'instagram' : 'facebook', med: d.is_organic ? 'social' : 'paid_social', cmp: clean(d.campaign_name, 100), cnt: clean(d.ad_name, 100) },
    adName: clean(d.ad_name, 200), adsetName: clean(d.adset_name, 200), campaignName: clean(d.campaign_name, 200), formId: clean(d.form_id, 40),
    optIn,
    at: metaTime(d.created_time) || new Date()
  };
}

// Adds one fetched lead to the Leads tab (once) and sends the alerts.
async function recordMetaLead(d, via) {
  const m = mapLeadFields(d || {});
  if (!/^\d{1,40}$/.test(m.id)) { logMeta('warn', 'leads', 'A lead arrived without a valid id; ignored'); return 'skipped'; }
  if (await Lead.exists({ sources: { $elemMatch: { kind: 'meta_lead', refId: m.id } } })) return 'skipped';
  const lead = await ingestLead({ kind: 'meta_lead', refId: m.id, name: m.name, email: m.email, phone: m.phone, message: m.message,
    propertyTitle: m.propertyTitle, label: m.label, attrib: m.attrib, at: m.at, consent: m.optIn ? LEAD_CONSENT : undefined });
  if (!lead) { logMeta('warn', 'leads', `Lead ${m.id} had no usable email or phone number, so it was not added`); return 'skipped'; }
  if (via === 'hourly') logMeta('info', 'leads', `Lead ${m.id} was picked up by the 10-minute check (the webhook had not delivered it)`);
  await sendLeadAlerts(lead, m, via).catch(e => logMeta('error', 'email', 'Lead alert failed: ' + e.message));
  return 'done';
}

let _deps = { sendEmail: async () => ({ success: false }), esc: s => String(s) };
async function sendLeadAlerts(lead, m, via) {
  const { sendEmail, esc } = _deps;
  const s = await getLeadSettings();
  const phone = (lead.phones || [])[0] ? '+' + lead.phones[0] : '';
  const email = (lead.emails || [])[0] || '';
  const rows = [['Name', m.name || '(not given)'], ['Mobile', phone], ['Email', email], ['Interested in', m.propertyTitle], ['Ad', m.adName],
    ['Campaign', m.campaignName], ['Where', m.where + (m.attrib.med === 'social' ? ' (organic)' : '')]].filter(r => r[1]);
  const html = getEmailHeader() + `
    <h2 style="color:#c02e00;font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 10px">New ${esc(m.where)} lead: ${esc(m.name || 'no name given')}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rows.map(r => `<tr><td style="padding:5px 10px 5px 0;color:#555;white-space:nowrap;vertical-align:top">${esc(r[0])}</td><td style="padding:5px 0;font-weight:600">${esc(r[1])}</td></tr>`).join('')}</table>
    ${m.message ? `<p style="background:#f6f4ef;padding:12px 16px;font-size:14px;white-space:pre-line">${esc(m.message)}</p>` : ''}
    <p style="font-size:14px">${lead.phones[0] ? `<a href="https://wa.me/${esc(lead.phones[0])}">WhatsApp ${esc(phone)}</a>` : ''}</p>
    <p style="font-size:13px;color:#555">Reply within five minutes if you can: lead-ad leads go cold fastest.${via === 'hourly' ? ' This one was picked up by the 10-minute check, so it may be up to ten minutes old.' : ''}</p>
    <p><a href="${SITE_URL}/admin.html#leads" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;text-decoration:none;font-weight:600">Open the Leads tab</a></p>
  ` + getEmailFooter();
  const r = await sendEmail(s.notifyEmail, `New ${m.where} lead: ${m.name || 'no name given'}`, html).catch(() => null);
  if (!r || !r.success) logMeta('error', 'email', 'The new-lead email could not be sent' + (r && r.error ? ': ' + r.error : ''));
  // Telegram carries no personal details unless the admin chose otherwise.
  const prefs = await getPrefs();
  const text = prefs.telegramDetails
    ? `New ${m.where} lead: ${m.name || 'no name'}${phone ? ' · ' + phone : ''}${m.propertyTitle ? ' · ' + m.propertyTitle : ''}\n${SITE_URL}/admin.html#leads`
    : `New ${m.where} lead: open ${SITE_URL}/admin.html#leads`;
  await telegramSend(text);
}

async function processLeadgen(leadgenId) {
  const tok = await pageToken();
  const d = await metaGet(leadgenId, { fields: LEAD_FIELDS }, { token: tok, area: 'leads', urgent: true });
  return recordMetaLead(d, 'webhook');
}

// Safety net (every 10 minutes): every lead form's leads since the last check (with a
// 15-minute overlap). Anything already in the Leads tab is skipped.
async function bulkRead(reason) {
  if (!LEADS_ON()) return { skipped: 'off' };
  if (!PAGE_ID()) return { skipped: 'META_PAGE_ID is not set' };
  const started = new Date();
  const st = await getState();
  const since = st.lastBulkReadAt ? Math.floor(new Date(st.lastBulkReadAt).getTime() / 1000) - 900 : Math.floor(started.getTime() / 1000) - 2 * 86400;
  let forms = [], found = 0, added = 0, retried = 0;
  try {
    const tok = await pageToken();
    forms = await metaGetAll(`${PAGE_ID()}/leadgen_forms`, { fields: 'id,name,status', limit: 100 }, { token: tok, area: 'leads' }, 10);
    for (const f of forms) {
      if (!/^\d{1,40}$/.test(String(f.id))) continue;
      const rows = await metaGetAll(`${f.id}/leads`, { fields: LEAD_FIELDS, limit: 100,
        filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: since }] }, { token: tok, area: 'leads' }, 20);
      for (const d of rows) { found++; if (await enqueue(() => recordMetaLead(d, 'hourly')) === 'done') added++; }
    }
  } catch (e) {
    await patchState({ lastBulkRead: { at: started, ok: false, error: scrub(e.message).slice(0, 300), reason } });
    throw e;
  }
  // A webhook lead whose fetch failed gets another go here (up to 6 tries).
  const failed = await MetaEvent.find({ field: 'leadgen', status: 'failed', tries: { $lt: 6 } }).select('key').limit(50).lean();
  for (const ev of failed) {
    const id = ev.key.slice('leadgen:'.length);
    await enqueue(() => onEvent(ev.key, 'page', 'leadgen', null, () => processLeadgen(id)));
    retried++;
  }
  await patchState({ lastBulkReadAt: started, lastBulkRead: { at: started, ok: true, forms: forms.length, found, added, retried, reason } });
  return { forms: forms.length, found, added, retried };
}

// ══ WEBHOOK EVENTS ════════════════════════════════════════════
// One row per event key. A key already done (Meta re-sent it) is skipped; a
// failed one may be claimed again.
async function onEvent(key, object, field, raw, fn) {
  let ev = null;
  try {
    ev = await MetaEvent.create({ key, object, field, raw: trimRaw(raw), status: 'working', tries: 1 });
  } catch (e) {
    if (e && e.code !== 11000) throw e;
    ev = await MetaEvent.findOneAndUpdate({ key, status: 'failed' }, { $set: { status: 'working' }, $inc: { tries: 1 } }, { new: true });
    if (!ev) return 'duplicate';
  }
  try {
    const r = await fn();
    await MetaEvent.updateOne({ _id: ev._id }, { $set: { status: r === 'skipped' ? 'skipped' : 'done', doneAt: new Date(), error: '' } });
    return r;
  } catch (e) {
    await MetaEvent.updateOne({ _id: ev._id }, { $set: { status: 'failed', error: scrub(e.message).slice(0, 500) } });
    logMeta('error', field === 'leadgen' ? 'leads' : 'inbox', `${key} could not be processed (${scrub(e.message).slice(0, 200)})${field === 'leadgen' ? '; the next check will try again' : ''}`, { code: e.code });
    return 'failed';
  }
}

// The raw payload is kept (30 days) for troubleshooting, unless it is huge.
function trimRaw(raw) {
  if (raw == null) return undefined;
  try { const t = JSON.stringify(raw); return t.length <= 20000 ? JSON.parse(t) : { truncated: true, size: t.length }; } catch (e) { return undefined; }
}
const idOk = v => /^[0-9_]{1,60}$/.test(String(v == null ? '' : v));
async function handleDelivery(body) {
  const obj = String((body && body.object) || '');
  const entries = Array.isArray(body && body.entry) ? body.entry.slice(0, 100) : [];
  await patchState({ lastWebhookAt: new Date() });
  // The "Test" button in the Meta dashboard sends a made-up lead (ids all 4s),
  // sometimes wrapped as { sample: {...} }. Record that it arrived; there is no
  // real lead to fetch.
  const isSample = v => v && /^4+$/.test(String(v.leadgen_id || ''));
  if (body && body.sample) {
    logMeta('info', 'webhook', `Test event from the Meta dashboard received (${clean(body.sample.field, 40) || 'unknown field'}); nothing to fetch`);
    return;
  }
  for (const e of entries) {
    for (const ch of (Array.isArray(e && e.changes) ? e.changes : []).slice(0, 200)) {
      const v = (ch && ch.value) || {};
      if (obj === 'page' && ch.field === 'leadgen') {
        if (!LEADS_ON()) continue;
        if (!idOk(v.leadgen_id)) { logMeta('warn', 'webhook', 'leadgen event without a valid leadgen_id'); continue; }
        if (isSample(v)) { logMeta('info', 'webhook', 'Test lead from the Meta dashboard received; nothing to fetch'); continue; }
        await onEvent('leadgen:' + v.leadgen_id, obj, 'leadgen', v, () => processLeadgen(String(v.leadgen_id)));
      } else if (obj === 'page' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        if (!INBOX_ON() || !idOk(v.comment_id)) continue;
        await onEvent('fbc:' + v.comment_id, obj, 'feed', v, () => processFbComment(v));
      } else if (obj === 'instagram' && ch.field === 'comments') {
        if (!INBOX_ON() || !idOk(v.id)) continue;
        await onEvent('igc:' + v.id, obj, 'comments', v, () => processIgComment(v));
      }
    }
    for (const m of (Array.isArray(e && e.messaging) ? e.messaging : []).slice(0, 200)) {
      if (!INBOX_ON() || !m || !m.message || !m.message.mid) continue;
      const mid = clean(m.message.mid, 200);
      await onEvent((obj === 'instagram' ? 'igm:' : 'fbm:') + mid, obj, 'messages', m, () => processMessage(obj, m));
    }
  }
}

// ══ MODULE 3: PAGE INBOX ══════════════════════════════════════
const inboxLink = ig => `https://business.facebook.com/latest/inbox/${ig ? 'instagram_direct' : 'messenger'}${PAGE_ID() ? '?asset_id=' + PAGE_ID() : ''}`;
async function profileName(userId, ig) {
  try {
    const d = await metaGet(userId, { fields: ig ? 'name,username' : 'first_name,last_name' }, { token: await pageToken(), area: 'inbox', tries: 1, quiet: true });
    return clean(ig ? (d.name || (d.username ? '@' + d.username : '')) : [d.first_name, d.last_name].filter(Boolean).join(' '), 200);
  } catch (e) { return ''; }
}
// The Page answered: logged on that person's lead as a contact, which stops
// the reply clock and the "still waiting" reminder.
async function recordPageReply(query, at, text) {
  const lead = await Lead.findOne(query);
  if (!lead) return 'skipped';
  pushActivity(lead, { type: 'social_reply', outcome: 'Replied', text, at, by: 'meta', byName: 'Facebook / Instagram' });
  lead.updatedAt = new Date();
  await lead.save();
  return 'done';
}
async function processMessage(obj, m) {
  const ig = obj === 'instagram';
  const own = ig ? IG_ID() : PAGE_ID();
  const at = metaTime(m.timestamp) || new Date();
  const sender = String((m.sender && m.sender.id) || ''), recipient = String((m.recipient && m.recipient.id) || '');
  if (m.message.is_echo || (own && sender === own)) {
    if (!idOk(recipient)) return 'skipped';
    return recordPageReply({ metaIds: (ig ? 'ig:' : 'fb:') + recipient }, at, ig ? 'The Page replied on Instagram' : 'The Page replied in Messenger');
  }
  if (!/^\d{1,40}$/.test(sender)) return 'skipped';
  const name = await profileName(sender, ig);
  const text = clean(m.message.text, 2000) || (Array.isArray(m.message.attachments) ? '[sent an attachment]' : '');
  const lead = await ingestLead({ kind: ig ? 'ig_dm' : 'messenger', refId: clean(m.message.mid, 200), metaId: (ig ? 'ig:' : 'fb:') + sender,
    name: name || (ig ? 'Instagram user' : 'Messenger user'), message: text, label: ig ? 'Instagram message' : 'Messenger message',
    link: inboxLink(ig), attrib: { src: ig ? 'instagram' : 'facebook', med: 'social' }, at });
  return lead ? 'done' : 'skipped';
}
async function processFbComment(v) {
  const from = v.from || {};
  const at = metaTime(v.created_time) || new Date();
  if (PAGE_ID() && String(from.id) === PAGE_ID()) {
    if (!idOk(v.parent_id)) return 'skipped';
    return recordPageReply({ sources: { $elemMatch: { kind: 'fb_comment', refId: String(v.parent_id) } } }, at, 'The Page replied to the comment');
  }
  if (!/^\d{1,40}$/.test(String(from.id || ''))) return 'skipped';
  const lead = await ingestLead({ kind: 'fb_comment', refId: String(v.comment_id), metaId: 'fb:' + from.id, name: clean(from.name, 200) || 'Facebook user',
    message: clean(v.message, 2000), label: 'Comment on a Facebook post', link: 'https://www.facebook.com/' + (idOk(v.post_id) ? v.post_id : v.comment_id),
    attrib: { src: 'facebook', med: 'social' }, at });
  return lead ? 'done' : 'skipped';
}
async function processIgComment(v) {
  const from = v.from || {};
  const at = metaTime(v.timestamp) || new Date();
  if (IG_ID() && String(from.id) === IG_ID()) {
    if (!idOk(v.parent_id)) return 'skipped';
    return recordPageReply({ sources: { $elemMatch: { kind: 'ig_comment', refId: String(v.parent_id) } } }, at, 'The Page replied to the Instagram comment');
  }
  if (!/^\d{1,40}$/.test(String(from.id || ''))) return 'skipped';
  let link = 'https://www.instagram.com/';
  const mediaId = v.media && v.media.id;
  if (idOk(mediaId)) {
    try { const d = await metaGet(String(mediaId), { fields: 'permalink' }, { token: await pageToken(), area: 'inbox', tries: 1, quiet: true }); if (/^https:\/\//.test(d.permalink || '')) link = d.permalink; } catch (e) { /* the inbox link is good enough */ }
  }
  const lead = await ingestLead({ kind: 'ig_comment', refId: String(v.id), metaId: 'ig:' + from.id, name: from.username ? '@' + clean(from.username, 100) : 'Instagram user',
    message: clean(v.text, 2000), label: 'Comment on an Instagram post', link, attrib: { src: 'instagram', med: 'social' }, at });
  return lead ? 'done' : 'skipped';
}

// ══ MODULE 2: INSIGHTS ════════════════════════════════════════
// The metric names live here and nowhere else. Each one is fetched on its own,
// so when Meta retires a name (it did in Nov 2025 and June 2026) only that
// tile says "retired" and the rest keep working.
//   agg 'sum': daily counts added up over the range; 'last': a running total.
const PAGE_METRICS = [
  { key: 'page_follows', label: 'Followers', agg: 'last' },
  { key: 'page_daily_follows_unique', label: 'New follows', agg: 'sum' },
  { key: 'page_total_media_view_unique', label: 'Reach (daily, added up)', agg: 'sum' },
  { key: 'page_media_view', label: 'Views', agg: 'sum' },
  { key: 'page_post_engagements', label: 'Engagements', agg: 'sum' }
];
const IG_METRICS = [
  { key: 'reach', label: 'Reach (daily, added up)', agg: 'sum' },
  { key: 'views', label: 'Views', agg: 'sum', totalValue: true },
  { key: 'follower_count', label: 'New followers', agg: 'sum' },
  { key: 'accounts_engaged', label: 'Accounts engaged', agg: 'sum', totalValue: true }
];
const EXTRA_TILES = {
  page: [{ key: 'followers_total', label: 'Followers (account)', agg: 'last' }, { key: 'posts', label: 'Posts published', agg: 'sum' }],
  ig: [{ key: 'followers_total', label: 'Followers', agg: 'last' }, { key: 'posts', label: 'Posts published', agg: 'sum' }],
  ads: [{ key: 'spend', label: 'Spend (₱)', agg: 'sum' }, { key: 'impressions', label: 'Impressions', agg: 'sum' }, { key: 'clicks', label: 'Clicks', agg: 'sum' }, { key: 'leads', label: 'Leads (ads)', agg: 'sum' }]
};
const LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped'];
// The same lead can be counted under more than one action type, so take the
// largest of them rather than adding them up.
function leadsFromActions(actions) {
  let best = 0;
  for (const a of Array.isArray(actions) ? actions : []) if (LEAD_ACTIONS.includes(a.action_type)) best = Math.max(best, num(a.value) || 0);
  return best;
}
const isRetired = e => e && Number(e.code) === 100 && /metric|insights/i.test(e.message || '');

async function snapshot(days, reason) {
  if (!INSIGHTS_ON()) return { skipped: 'off' };
  const today = manilaDay();
  const since = addDays(today, -Math.max(1, Math.min(90, days || 3)));
  const yesterday = addDays(today, -1);
  const put = {};   // `${surface}|${date}` -> { metrics, campaigns }
  const cell = (surface, date) => (put[surface + '|' + date] = put[surface + '|' + date] || { metrics: {} });
  const status = {};
  const note = (sk, e) => { status[sk] = e ? { status: isRetired(e) ? 'retired' : 'error', message: scrub(e.message).slice(0, 200), at: new Date() } : { status: 'ok', at: new Date() }; };
  const topPosts = {};
  let tok = null;
  if (PAGE_ID() || IG_ID()) tok = await pageToken();

  if (PAGE_ID()) {
    for (const m of PAGE_METRICS) {
      try {
        const d = await metaGet(`${PAGE_ID()}/insights`, { metric: m.key, period: 'day', since, until: today }, { token: tok, area: 'insights', tries: 3 });
        for (const row of d.data || []) for (const v of row.values || []) { const day = endDay(v.end_time); const n = num(v.value); if (day && n !== null) cell('page', day).metrics[m.key] = n; }
        note('page.' + m.key);
      } catch (e) { note('page.' + m.key, e); }
    }
    try {
      const d = await metaGet(PAGE_ID(), { fields: 'followers_count,fan_count' }, { token: tok, area: 'insights', tries: 3 });
      const n = num(d.followers_count) !== null ? num(d.followers_count) : num(d.fan_count);
      if (n !== null) cell('page', yesterday).metrics.followers_total = n;
      note('page.followers_total');
    } catch (e) { note('page.followers_total', e); }
    try {
      const posts = await metaGetAll(`${PAGE_ID()}/published_posts`, { fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', limit: 50, since }, { token: tok, area: 'insights' }, 3);
      const perDay = {};
      const list = posts.map(p => {
        const day = manilaDay(metaTime(p.created_time) || new Date()); perDay[day] = (perDay[day] || 0) + 1;
        const reactions = num(p.reactions && p.reactions.summary && p.reactions.summary.total_count) || 0, comments = num(p.comments && p.comments.summary && p.comments.summary.total_count) || 0, shares = num(p.shares && p.shares.count) || 0;
        return { id: clean(p.id, 60), text: clean(p.message, 160), at: metaTime(p.created_time), link: /^https:\/\//.test(p.permalink_url || '') ? p.permalink_url : '', reactions, comments, shares, score: reactions + comments * 2 + shares * 3 };
      });
      for (const [day, n] of Object.entries(perDay)) if (day >= since && day <= yesterday) cell('page', day).metrics.posts = n;
      topPosts.fb = list.sort((a, b) => b.score - a.score).slice(0, 6);
      for (const p of topPosts.fb) {
        try { const d = await metaGet(`${p.id}/insights`, { metric: 'post_media_view' }, { token: tok, area: 'insights', tries: 1, quiet: true }); p.views = num((((d.data || [])[0] || {}).values || [{}])[0].value); } catch (e) { p.views = null; }
      }
      note('page.posts');
    } catch (e) { note('page.posts', e); }
  }

  if (IG_ID()) {
    for (const m of IG_METRICS) {
      try {
        if (m.totalValue) {
          // These only come as one total per request, so one request per day.
          for (let day = since; day <= yesterday; day = addDays(day, 1)) {
            const d = await metaGet(`${IG_ID()}/insights`, { metric: m.key, period: 'day', metric_type: 'total_value', since: day, until: addDays(day, 1) }, { token: tok, area: 'insights', tries: 3 });
            const n = num((((d.data || [])[0] || {}).total_value || {}).value);
            if (n !== null) cell('ig', day).metrics[m.key] = n;
          }
        } else {
          const d = await metaGet(`${IG_ID()}/insights`, { metric: m.key, period: 'day', since, until: today }, { token: tok, area: 'insights', tries: 3 });
          for (const row of d.data || []) for (const v of row.values || []) { const day = endDay(v.end_time); const n = num(v.value); if (day && n !== null) cell('ig', day).metrics[m.key] = n; }
        }
        note('ig.' + m.key);
      } catch (e) { note('ig.' + m.key, e); }
    }
    try {
      const d = await metaGet(IG_ID(), { fields: 'followers_count,media_count' }, { token: tok, area: 'insights', tries: 3 });
      if (num(d.followers_count) !== null) cell('ig', yesterday).metrics.followers_total = num(d.followers_count);
      note('ig.followers_total');
    } catch (e) { note('ig.followers_total', e); }
    try {
      const media = await metaGetAll(`${IG_ID()}/media`, { fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: 50 }, { token: tok, area: 'insights' }, 2);
      const perDay = {};
      const list = media.map(p => {
        const day = manilaDay(metaTime(p.timestamp) || new Date()); perDay[day] = (perDay[day] || 0) + 1;
        const likes = num(p.like_count) || 0, comments = num(p.comments_count) || 0;
        return { id: clean(p.id, 60), text: clean(p.caption, 160), type: clean(p.media_type, 20), at: metaTime(p.timestamp), link: /^https:\/\//.test(p.permalink || '') ? p.permalink : '', likes, comments, score: likes + comments * 2 };
      });
      for (const [day, n] of Object.entries(perDay)) if (day >= since && day <= yesterday) cell('ig', day).metrics.posts = n;
      topPosts.ig = list.filter(p => p.at && manilaDay(p.at) >= addDays(today, -30)).sort((a, b) => b.score - a.score).slice(0, 6);
      for (const p of topPosts.ig) {
        try { const d = await metaGet(`${p.id}/insights`, { metric: 'views,reach' }, { token: tok, area: 'insights', tries: 1, quiet: true }); for (const r of d.data || []) p[r.name] = num(((r.values || [{}])[0] || {}).value); } catch (e) { /* views stay blank */ }
      }
      note('ig.posts');
    } catch (e) { note('ig.posts', e); }
  }

  if (AD_ACCOUNT()) {
    try {
      const rows = await metaGetAll(`act_${AD_ACCOUNT()}/insights`, { level: 'campaign', fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,cost_per_action_type',
        time_range: { since, until: yesterday }, time_increment: 1, limit: 500 }, { area: 'insights' }, 10);
      const days = new Set();
      for (let day = since; day <= yesterday; day = addDays(day, 1)) days.add(day);
      for (const day of days) { const c = cell('ads', day); c.campaigns = []; Object.assign(c.metrics, { spend: 0, impressions: 0, clicks: 0, leads: 0 }); }
      for (const r of rows) {
        const day = String(r.date_start || '');
        if (!days.has(day)) continue;
        const c = cell('ads', day);
        const row = { id: clean(r.campaign_id, 40), name: clean(r.campaign_name, 200), spend: num(r.spend) || 0, impressions: num(r.impressions) || 0, clicks: num(r.clicks) || 0, leads: leadsFromActions(r.actions) };
        c.campaigns.push(row);
        c.metrics.spend = Math.round((c.metrics.spend + row.spend) * 100) / 100;
        c.metrics.impressions += row.impressions; c.metrics.clicks += row.clicks; c.metrics.leads += row.leads;
      }
      note('ads.campaigns');
    } catch (e) { note('ads.campaigns', e); }
  }

  let written = 0;
  for (const [k, v] of Object.entries(put)) {
    const [surface, date] = k.split('|');
    const set = { updatedAt: new Date() };
    for (const [mk, mv] of Object.entries(v.metrics)) set['metrics.' + mk] = mv;
    if (v.campaigns) set.campaigns = v.campaigns;
    await MetaDaily.updateOne({ date, surface }, { $set: set }, { upsert: true });
    written++;
  }
  const st = await getState();
  const patch = { lastSnapshotAt: new Date(), lastSnapshotDay: today, backfilled: true, metricStatus: { ...(st.metricStatus || {}), ...status } };
  if (topPosts.fb || topPosts.ig) patch.topPosts = { ...(st.topPosts || {}), ...topPosts, at: new Date() };
  await patchState(patch);
  const errors = Object.entries(status).filter(([, s]) => s.status !== 'ok').map(([k, s]) => k + ': ' + s.status);
  if (errors.length) logMeta('warn', 'insights', `Snapshot (${reason || 'daily'}) finished with ${errors.length} metric(s) not read: ${errors.join(', ')}`);
  return { since, until: yesterday, rows: written, errors };
}

// Totals for a date range from MetaDaily, with the same-length period before it.
async function aggregate(from, to) {
  const rows = await MetaDaily.find({ date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean();
  const st = await getState();
  const ms = st.metricStatus || {};
  const tiles = {};
  const defs = { page: PAGE_METRICS.concat(EXTRA_TILES.page), ig: IG_METRICS.concat(EXTRA_TILES.ig), ads: EXTRA_TILES.ads };
  for (const [surface, list] of Object.entries(defs)) {
    const mine = rows.filter(r => r.surface === surface);
    tiles[surface] = list.map(m => {
      const series = mine.map(r => [r.date, num((r.metrics || {})[m.key])]).filter(x => x[1] !== null);
      const value = !series.length ? null : m.agg === 'last' ? series[series.length - 1][1] : series.reduce((a, x) => a + x[1], 0);
      const change = m.agg === 'last' && series.length > 1 ? series[series.length - 1][1] - series[0][1] : null;
      const stKey = surface === 'ads' ? 'ads.campaigns' : surface + '.' + (m.key === 'posts' ? 'posts' : m.key);
      return { key: m.key, label: m.label, agg: m.agg, value: value === null ? null : Math.round(value * 100) / 100, change, series, status: (ms[stKey] || {}).status || '', statusMsg: (ms[stKey] || {}).message || '' };
    });
  }
  const byCamp = new Map();
  for (const r of rows.filter(x => x.surface === 'ads')) for (const c of r.campaigns || []) {
    const k = c.id || c.name;
    const cur = byCamp.get(k) || { id: c.id, name: c.name, spend: 0, impressions: 0, clicks: 0, leads: 0 };
    cur.spend += c.spend || 0; cur.impressions += c.impressions || 0; cur.clicks += c.clicks || 0; cur.leads += c.leads || 0; cur.name = c.name || cur.name;
    byCamp.set(k, cur);
  }
  const campaigns = [...byCamp.values()].map(c => ({ ...c, spend: Math.round(c.spend * 100) / 100, cpl: c.leads ? Math.round(c.spend / c.leads * 100) / 100 : null, ctr: c.impressions ? Math.round(c.clicks / c.impressions * 10000) / 100 : null }))
    .sort((a, b) => b.spend - a.spend);
  const spend = campaigns.reduce((a, c) => a + c.spend, 0), leads = campaigns.reduce((a, c) => a + c.leads, 0);
  return { from, to, tiles, campaigns, totals: { spend: Math.round(spend * 100) / 100, leads, cpl: leads ? Math.round(spend / leads * 100) / 100 : null },
    daily: rows.map(r => ({ date: r.date, surface: r.surface, metrics: r.metrics || {} })) };
}

// Leads from Facebook / Instagram in the CRM, counted (no names here: the
// people themselves are in the Leads tab, behind leads_view).
async function metaLeadStats(fromDate, toDate) {
  const s = await getLeadSettings();
  const leads = await Lead.find({ sources: { $elemMatch: { kind: { $in: META_KINDS }, at: { $gte: fromDate, $lte: toDate } } } })
    .select('sources stage archived lastAskAt lastContactAt firstInboundAt firstResponseAt').lean();
  const byKind = {}, byCampaign = {};
  let touches = 0;
  for (const l of leads) for (const src of l.sources || []) {
    if (!META_KINDS.includes(src.kind) || src.at < fromDate || src.at > toDate) continue;
    touches++;
    byKind[src.kind] = (byKind[src.kind] || 0) + 1;
    if (src.kind === 'meta_lead') { const c = (src.attrib && src.attrib.cmp) || '(no campaign)'; byCampaign[c] = (byCampaign[c] || 0) + 1; }
  }
  const resp = leads.filter(l => l.firstInboundAt && l.firstResponseAt && new Date(l.firstInboundAt) >= fromDate)
    .map(l => (new Date(l.firstResponseAt) - new Date(l.firstInboundAt)) / 60000).filter(m => m >= 0).sort((a, b) => a - b);
  const med = resp.length ? (resp.length % 2 ? resp[(resp.length - 1) / 2] : (resp[resp.length / 2 - 1] + resp[resp.length / 2]) / 2) : null;
  return { people: leads.length, touches, byKind, byCampaign, waiting: leads.filter(isWaiting).length,
    medianResponseMin: med === null ? null : Math.round(med), withinSla: resp.length ? Math.round(100 * resp.filter(m => m <= s.slaMinutes).length / resp.length) : null,
    answered: resp.length, slaMinutes: s.slaMinutes };
}

// ══ WEEKLY SUMMARY (Monday 8 am Manila) ═══════════════════════
async function weeklySummary(force) {
  const { sendEmail, esc } = _deps;
  const today = manilaDay();
  const from = addDays(today, -7), to = addDays(today, -1);
  const agg = await aggregate(from, to);
  const ls = await metaLeadStats(new Date(from + 'T00:00:00+08:00'), new Date(to + 'T23:59:59.999+08:00'));
  const st = await getState();
  const tile = (s, k) => (agg.tiles[s] || []).find(t => t.key === k) || {};
  const n = v => v == null ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const peso = v => v == null ? '–' : '₱' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = [
    ['Facebook reach', n(tile('page', 'page_total_media_view_unique').value)],
    ['Facebook followers', n(tile('page', 'followers_total').value ?? tile('page', 'page_follows').value) + (tile('page', 'page_daily_follows_unique').value != null ? ` (+${n(tile('page', 'page_daily_follows_unique').value)} new)` : '')],
    ['Facebook posts', n(tile('page', 'posts').value)],
    ['Instagram reach', n(tile('ig', 'reach').value)],
    ['Instagram followers', n(tile('ig', 'followers_total').value) + (tile('ig', 'follower_count').value != null ? ` (+${n(tile('ig', 'follower_count').value)} new)` : '')],
    ['Instagram posts', n(tile('ig', 'posts').value)],
    ['Ad spend', peso(agg.totals.spend)],
    ['Leads from ads (Meta count)', n(agg.totals.leads)],
    ['Cost per lead', peso(agg.totals.cpl)],
    ['Lead-ad forms received in the Leads tab', n(ls.byKind.meta_lead || 0)],
    ['Messages and comments', n((ls.byKind.messenger || 0) + (ls.byKind.ig_dm || 0) + (ls.byKind.fb_comment || 0) + (ls.byKind.ig_comment || 0))],
    ['Median time to first reply', ls.medianResponseMin == null ? '–' : ls.medianResponseMin < 60 ? ls.medianResponseMin + ' min' : (ls.medianResponseMin / 60).toFixed(1) + ' h'],
    [`Answered within ${ls.slaMinutes} min`, ls.withinSla == null ? '–' : ls.withinSla + '%'],
    ['Still waiting for a reply', n(ls.waiting)]
  ];
  const camps = agg.campaigns.slice(0, 8);
  const html = getEmailHeader() + `
    <h2 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 4px">Facebook &amp; Instagram: last week</h2>
    <p style="font-size:13px;color:#555;margin:0 0 14px">${esc(from)} to ${esc(to)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rows.map(r => `<tr><td style="padding:7px 0;border-bottom:1px solid #e8e8e0">${esc(r[0])}</td><td style="padding:7px 0;border-bottom:1px solid #e8e8e0;text-align:right;font-weight:700">${esc(r[1])}</td></tr>`).join('')}</table>
    ${camps.length ? `<h3 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:15px;margin:20px 0 6px">Campaigns</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><tr><th align="left" style="padding:5px 0">Campaign</th><th align="right">Spend</th><th align="right">Leads</th><th align="right">Per lead</th></tr>
    ${camps.map(c => `<tr><td style="padding:5px 0;border-top:1px solid #e8e8e0">${esc(c.name)}</td><td align="right" style="border-top:1px solid #e8e8e0">${esc(peso(c.spend))}</td><td align="right" style="border-top:1px solid #e8e8e0">${esc(n(c.leads))}</td><td align="right" style="border-top:1px solid #e8e8e0">${esc(peso(c.cpl))}</td></tr>`).join('')}</table>` : ''}
    ${st.token && st.token.ok === false ? `<p style="background:#fde8e1;padding:10px 14px;font-size:13px;color:#c02e00"><strong>Needs attention:</strong> ${esc(st.token.problem || 'The Meta token has a problem.')}</p>` : ''}
    <p style="font-size:12px;color:#777">Reach is Meta's estimate and is added up day by day, so a person reached on two days counts twice. Ad leads are Meta's count; the Leads tab count is what actually arrived here.</p>
    <p><a href="${SITE_URL}/admin.html" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;text-decoration:none;font-weight:600">Open the Meta tab</a></p>
  ` + getEmailFooter();
  const s = await getLeadSettings();
  const r = await sendEmail(s.notifyEmail, `Facebook & Instagram last week: ${n(ls.byKind.meta_lead || 0)} leads, ${peso(agg.totals.spend)} spent`, html).catch(() => null);
  if (!r || !r.success) { logMeta('error', 'email', 'The weekly Meta summary could not be emailed'); return { ok: false }; }
  if (force) logMeta('info', 'email', 'Weekly Meta summary sent by hand');
  return { ok: true, from, to };
}

// ══ TOKEN CHECK (daily) ═══════════════════════════════════════
function requiredScopes() {
  const s = new Set();
  if (LEADS_ON()) ['leads_retrieval', 'pages_manage_metadata', 'pages_show_list', 'pages_read_engagement', 'ads_read'].forEach(x => s.add(x));
  if (INSIGHTS_ON()) ['read_insights', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights', 'ads_read'].forEach(x => s.add(x));
  if (INBOX_ON()) ['pages_messaging', 'pages_manage_metadata', 'instagram_manage_messages', 'instagram_manage_comments'].forEach(x => s.add(x));
  return [...s];
}
async function checkToken(notify) {
  const tok = env('META_SYSTEM_TOKEN'), appId = env('META_APP_ID'), sec = env('META_APP_SECRET');
  let status;
  if (!tok) status = { ok: false, problem: 'META_SYSTEM_TOKEN is not set in Render.' };
  else if (!appId || !sec) status = { ok: false, problem: 'META_APP_ID and META_APP_SECRET must both be set before the token can be checked.' };
  else {
    try {
      const d = (await metaGet('debug_token', { input_token: tok }, { token: `${appId}|${sec}`, noProof: true, area: 'token', tries: 2, urgent: true })).data || {};
      const scopes = Array.isArray(d.scopes) ? d.scopes.map(String) : [];
      const missing = requiredScopes().filter(x => !scopes.includes(x));
      const exp = Number(d.expires_at) || 0;
      const days = exp ? (exp * 1000 - Date.now()) / 864e5 : null;
      let problem = '';
      if (!d.is_valid) problem = 'The Meta token is no longer valid' + (d.error && d.error.message ? ' (' + scrub(d.error.message).slice(0, 200) + ')' : '') + '. Generate a new System User token in Business Settings and put it in Render as META_SYSTEM_TOKEN.';
      else if (days !== null && days < 7) problem = `The Meta token expires in ${Math.max(0, Math.floor(days))} day(s). Generate a System User token with expiry "Never" and put it in Render.`;
      else if (missing.length) problem = 'The Meta token is missing permissions: ' + missing.join(', ') + '. Generate it again with these ticked.';
      status = { ok: !problem, valid: !!d.is_valid, expiresAt: exp ? new Date(exp * 1000) : null, neverExpires: !!d.is_valid && !exp, scopes, missing, type: clean(d.type, 20), problem };
    } catch (e) {
      status = { ok: false, problem: 'The token could not be checked: ' + scrub(e.message).slice(0, 200) };
    }
  }
  status.checkedAt = new Date();
  const st = await getState();
  const patch = { token: status, tokenCheckedDay: manilaDay() };
  if (!status.ok) {
    logMeta('error', 'token', status.problem);
    const alertKey = crypto.createHash('sha1').update(status.problem.replace(/\d+ day/, 'N day')).digest('hex').slice(0, 16);
    if (notify && st.tokenAlertKey !== alertKey) {
      const { sendEmail, esc } = _deps;
      const s = await getLeadSettings();
      const r = await sendEmail(s.notifyEmail, 'Meta connection needs attention', getEmailHeader() + `
        <h2 style="color:#c02e00;font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 10px">The Facebook / Instagram connection needs attention</h2>
        <p style="font-size:14px;line-height:1.6">${esc(status.problem)}</p>
        <p style="font-size:13px;color:#555">Until this is fixed, new Facebook leads may not reach the Leads tab and the Meta numbers stop updating. You get this email once per problem.</p>
        <p><a href="${SITE_URL}/admin.html" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;text-decoration:none;font-weight:600">Open the Meta tab</a></p>
      ` + getEmailFooter()).catch(() => null);
      if (r && r.success) patch.tokenAlertKey = alertKey;
    }
  } else if (st.tokenAlertKey) patch.tokenAlertKey = '';
  await patchState(patch);
  return status;
}

// ══ ROUTES ════════════════════════════════════════════════════
function registerMetaRoutes(app, deps) {
  _deps = { ..._deps, ...deps };
  const gate = test => (req, res, next) => test() ? next() : res.status(404).json({ error: 'Not found', disabled: true });
  const view = [gate(anyOn), verifyToken, requirePermission('meta_view')];
  const admin = [gate(anyOn), verifyToken, requireAdmin];

  // ── The webhook (called by Meta) ──
  // Only failed signatures count towards this limit, so Meta itself is never slowed.
  const badSigLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
    skipSuccessfulRequests: true, message: { error: 'Too many requests' } });
  app.get('/api/meta/webhook', gate(webhookOn), (req, res) => {
    // Read from the raw address: the sanitiser drops query keys with a dot in them (hub.mode).
    const q = new URL(req.originalUrl, 'http://x').searchParams;
    const mode = q.get('hub.mode'), given = String(q.get('hub.verify_token') || ''), challenge = String(q.get('hub.challenge') || '');
    const want = env('META_VERIFY_TOKEN');
    const a = Buffer.from(given), b = Buffer.from(want);
    if (mode === 'subscribe' && want && a.length === b.length && crypto.timingSafeEqual(a, b) && /^[A-Za-z0-9_-]{1,200}$/.test(challenge)) {
      logMeta('info', 'webhook', 'Meta verified the webhook address');
      return res.status(200).type('text/plain').send(challenge);
    }
    logMeta('warn', 'webhook', 'Webhook verification refused (wrong verify token or mode)');
    res.status(403).type('text/plain').send('Forbidden');
  });
  app.post('/api/meta/webhook', gate(webhookOn), badSigLimiter, (req, res) => {
    const secret = env('META_APP_SECRET');
    if (!secret) { logMeta('error', 'webhook', 'META_APP_SECRET is not set, so webhook deliveries cannot be checked; refused'); return res.status(503).json({ error: 'Not configured' }); }
    const sig = String(req.get('x-hub-signature-256') || '').toLowerCase();
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw) || !raw.length || !/^sha256=[a-f0-9]{64}$/.test(sig)) {
      logMeta('warn', 'webhook', 'Webhook delivery without a valid signature; refused');
      return res.status(403).json({ error: 'Bad signature' });
    }
    const want = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      logMeta('warn', 'webhook', 'Webhook delivery with a wrong signature; refused');
      return res.status(403).json({ error: 'Bad signature' });
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Bad body' }); }
    // Answer at once; Meta retries anything slow. The work happens after.
    res.status(200).json({ ok: true });
    setImmediate(() => enqueue(() => handleDelivery(body)).catch(e => logMeta('error', 'webhook', 'Webhook processing failed: ' + e.message)));
  });

  // ── The admin Meta tab ──
  app.get('/api/admin/meta/status', ...view, async (req, res) => {
    try {
      const st = await getState();
      const prefs = await getPrefs();
      const now = Date.now();
      const [d7, d30] = await Promise.all([metaLeadStats(new Date(now - 7 * 864e5), new Date(now)), metaLeadStats(new Date(now - 30 * 864e5), new Date(now))]);
      const errors24h = await MetaLog.countDocuments({ level: 'error', at: { $gte: new Date(now - 864e5) } });
      res.json({
        switches: { leads: LEADS_ON(), insights: INSIGHTS_ON(), inbox: INBOX_ON() },
        config: { appId: !!env('META_APP_ID'), appSecret: !!env('META_APP_SECRET'), verifyToken: !!env('META_VERIFY_TOKEN'), systemToken: !!env('META_SYSTEM_TOKEN'),
          pageId: !!PAGE_ID(), igUserId: !!IG_ID(), adAccount: !!AD_ACCOUNT(), telegram: !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID')),
          graphVersion: graphBase().split('/').pop() },
        token: st.token || null, lastWebhookAt: st.lastWebhookAt || null, lastBulkRead: st.lastBulkRead || null,
        lastSnapshotAt: st.lastSnapshotAt || null, metricStatus: st.metricStatus || {}, prefs, errors24h,
        leads: { d7, d30 }, webhookUrl: SITE_URL + '/api/meta/webhook'
      });
    } catch (e) { res.status(500).json({ error: 'Could not load the Meta status' }); }
  });

  app.get('/api/admin/meta/insights', gate(INSIGHTS_ON), ...view, async (req, res) => {
    try {
      const today = manilaDay();
      let to = isDay(req.query.to) ? String(req.query.to) : addDays(today, -1);
      let from = isDay(req.query.from) ? String(req.query.from) : addDays(to, -29);
      if (from > to) [from, to] = [to, from];
      const span = Math.round((new Date(to) - new Date(from)) / 864e5) + 1;
      if (span > 400) from = addDays(to, -399);
      const cur = await aggregate(from, to);
      const prev = await aggregate(addDays(from, -span), addDays(from, -1));
      for (const s of Object.keys(cur.tiles)) cur.tiles[s].forEach((t, i) => { t.prev = ((prev.tiles[s] || [])[i] || {}).value ?? null; });
      const st = await getState();
      res.json({ ...cur, prevTotals: prev.totals, topPosts: st.topPosts || {}, lastSnapshotAt: st.lastSnapshotAt || null });
    } catch (e) { res.status(500).json({ error: 'Could not load the insights' }); }
  });

  app.get('/api/admin/meta/logs', ...view, async (req, res) => {
    try {
      const q = {};
      if (['error', 'warn', 'info'].includes(req.query.level)) q.level = req.query.level;
      const logs = await MetaLog.find(q).sort({ at: -1 }).limit(Math.max(1, Math.min(500, Number(req.query.limit) || 100))).lean();
      res.json({ logs: logs.map(l => ({ at: l.at, level: l.level, area: l.area, message: l.message, code: l.code, path: l.path })) });
    } catch (e) { res.status(500).json({ error: 'Could not load the log' }); }
  });

  // ── Admin actions ──
  app.post('/api/admin/meta/snapshot', gate(INSIGHTS_ON), ...admin, async (req, res) => {
    try {
      const st = await getState();
      const r = await snapshot(st.backfilled ? 3 : 30, 'by hand');
      await logAudit(req, 'META_SNAPSHOT', 'Meta', '', 'Insights snapshot', { rows: r.rows });
      res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ error: 'The snapshot failed: ' + scrub(e.message).slice(0, 200) }); }
  });
  app.post('/api/admin/meta/bulk-read', gate(LEADS_ON), ...admin, async (req, res) => {
    try { res.json({ success: true, ...(await bulkRead('by hand')) }); }
    catch (e) { res.status(502).json({ error: 'The lead check failed: ' + scrub(e.message).slice(0, 200) }); }
  });
  app.post('/api/admin/meta/check-token', ...admin, async (req, res) => {
    try { res.json({ success: true, token: await checkToken(false) }); }
    catch (e) { res.status(500).json({ error: 'Could not check the token' }); }
  });
  app.post('/api/admin/meta/test-telegram', ...admin, async (req, res) => {
    const r = await telegramSend('Test from the GLRA admin: Telegram alerts for new Facebook and Instagram leads are working.');
    if (!r.ok) return res.status(r.skipped ? 400 : 502).json({ error: r.error || 'Telegram failed' });
    await logAudit(req, 'META_TEST_TELEGRAM', 'Meta', '', 'Telegram test', null);
    res.json({ success: true });
  });
  app.get('/api/admin/meta/telegram-chats', ...admin, async (req, res) => {
    const r = await telegramChats();
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  });
  app.post('/api/admin/meta/subscribe-page', gate(webhookOn), ...admin, async (req, res) => {
    try {
      const r = await subscribePage();
      await logAudit(req, 'META_SUBSCRIBE_PAGE', 'Meta', PAGE_ID(), 'Page webhook subscription', r);
      res.json({ success: true, ...r });
    } catch (e) { res.status(502).json({ error: scrub(e.message).slice(0, 300) }); }
  });
  app.post('/api/admin/meta/weekly-send', gate(() => INSIGHTS_ON() || LEADS_ON()), ...admin, async (req, res) => {
    try {
      const r = await weeklySummary(true);
      if (!r.ok) return res.status(502).json({ error: 'The email could not be sent' });
      res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ error: 'Could not build the summary' }); }
  });
  app.put('/api/admin/meta/settings', ...admin, async (req, res) => {
    try {
      const b = req.body || {};
      const cur = await getPrefs();
      const next = { telegramDetails: b.telegramDetails === undefined ? !!cur.telegramDetails : b.telegramDetails === true };
      await Setting.updateOne({ key: PREFS_KEY }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
      await logAudit(req, 'UPDATE', 'MetaSettings', '', 'Meta settings', next);
      res.json({ success: true, prefs: next });
    } catch (e) { res.status(500).json({ error: 'Could not save' }); }
  });
}

// ══ THE TICK ══════════════════════════════════════════════════
// Every 10 minutes: the token check once a day, the hourly lead read, the
// daily snapshot after 6 am, the Monday 8 am summary. Nothing at all runs
// while every switch is off.
function startMetaTick(deps) {
  _deps = { ..._deps, ...deps };
  if (!anyOn()) return { tick: async () => {} };
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const day = manilaDay(), hour = manilaHour();
      let st = await getState();
      if (st.tokenCheckedDay !== day) { await checkToken(true); st = await getState(); }
      if (LEADS_ON() && (!st.lastBulkReadAt || Date.now() - new Date(st.lastBulkReadAt).getTime() >= 8 * 60e3)) {
        await bulkRead('hourly').catch(e => logMeta('error', 'leads', 'Lead check failed: ' + e.message));
      }
      if (INSIGHTS_ON() && hour >= 6 && st.lastSnapshotDay !== day) {
        await snapshot(st.backfilled ? 3 : 30, 'daily').catch(e => logMeta('error', 'insights', 'Daily snapshot failed: ' + e.message));
      }
      if ((INSIGHTS_ON() || LEADS_ON()) && manilaWeekday() === 1 && hour >= 8 && hour < 14 && st.lastWeeklyDay !== day) {
        // Claimed before sending, so two server instances cannot both send it.
        const claimed = await Setting.findOneAndUpdate({ key: STATE_KEY, 'value.lastWeeklyDay': { $ne: day } }, { $set: { 'value.lastWeeklyDay': day } });
        if (claimed) await weeklySummary(false).catch(e => logMeta('error', 'email', 'Weekly summary failed: ' + e.message));
      }
    } catch (e) {
      console.error('Meta tick error:', e.message);
    } finally { running = false; }
  }
  setTimeout(() => { tick(); setInterval(tick, 10 * 60e3).unref(); }, 2 * 60e3).unref();
  return { tick };
}

module.exports = {
  registerMetaRoutes, startMetaTick,
  _test: { mapLeadFields, leadsFromActions, scrub, endDay, metaTime, aggregate, snapshot, bulkRead, checkToken, weeklySummary }
};
