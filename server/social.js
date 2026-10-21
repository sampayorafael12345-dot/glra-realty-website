// =============================================================================
// GLRA SOCIAL — a private Facebook / Instagram Page manager (social.html)
// =============================================================================
// Rafael's three Pages (GLRA Realty, GLRA Land Title Documentation and Allied
// Services, Kate Sampayo, Realtor) and their linked Instagram accounts, through
// Meta's official Graph API only.
//
// SWITCH: SOCIAL_ENABLED=1 in Render. While it is off every route here answers
// 404 and no timer starts. META_PAGE_IDS = the Page ids, comma separated (falls
// back to META_PAGE_ID). The Instagram account of each Page is discovered from
// the Page (instagram_business_account). Tokens: META_SYSTEM_TOKEN only; each
// Page's own token is fetched from Meta when needed and kept in memory.
//
// STAFF DRAFT, AN APPROVER PUBLISHES. Enforced here, on the server:
//   social_view     open the page (read everything)
//   social_draft    write posts / replies / templates: they stop at "waiting
//                   for approval"
//   social_approve  the ONLY permission that can publish, schedule, send a
//                   reply, hide, unhide or delete. Every approval and every
//                   deletion is also written to the admin Audit Log.
// The Claude review key (module 6) reads a masked feed and can only create
// drafts that wait for approval; it can never publish, send, hide or delete.
//
// ADS ARE READ-ONLY. There is no code anywhere in this file that creates,
// edits or pauses an ad, a campaign or an ad set, or changes a budget.
//
// Modules: 1 Pages + token health, 2 publishing / calendar / approvals /
// templates / listing studio / recurring / CSV bulk, 3 inbox, 4 insights /
// best time / weekly report, 5 activity log (SocialLog), 6 review key.
// =============================================================================
'use strict';
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const mongoose = require('mongoose');
const db = require('./db');
const { Setting, Account, Lead, Property, SocialPost, SocialTemplate, SocialItem, SocialThread, SocialAction, SocialLog,
  SocialMedia, SocialRecurring, SocialDaily, SocialPostStat, SocialLinkToken, defaultPermissionsForRole } = db;
const { verifyToken, requirePermission, requireAdmin, logAudit, loadAccountState } = require('./auth');
const { getEmailHeader, getEmailFooter } = require('./email-templates');
const { pushActivity, getLeadSettings } = require('./leads');
const { applyWebsiteCover } = require('./cover');
// Listing reads go through listing-lite so a base64 photo never leaves Atlas.
const { findListingsLite, findListingLiteById } = require('./listing-lite');
const G = require('./meta-graph');
const { env, flag, scrub, logMeta, metaGet, metaGetAll, metaWrite, pageTokenFor, MetaError, clean } = G;
const AI = require('./social-ai');

const SITE_URL = 'https://glrarealty.com';
const STATE_KEY = 'social_state';
const SETTINGS_KEY = 'social_settings';
const REVIEW_KEY = 'social_review_key';
const SOCIAL_ON = () => flag('SOCIAL_ENABLED');
const INBOX_ON = () => flag('META_INBOX_ENABLED');
const LEADS_ON = () => flag('META_LEADS_ENABLED');
const AD_ACCOUNT = () => (env('META_AD_ACCOUNT_ID').replace(/^act_/, '').match(/^\d{1,30}$/) || [''])[0];
const IG_CAPTION_MAX = 2200, IG_HASHTAG_MAX = 30, FB_CAPTION_MAX = 5000, MAX_MEDIA = 10;
const FB_MIN_AHEAD = 10 * 60e3, MAX_AHEAD = 75 * 864e5;
const PAGE_COLORS = ['#f59a5b', '#7c9cff', '#5ee69a', '#ff8a94', '#c4b5fd', '#ffbe3d'];
const KINDS = ['fb_comment', 'ig_comment', 'messenger', 'ig_dm'];
const TAGS = ['price', 'viewing', 'seller', 'spam', 'documents', 'other'];

// The Pages, in the order set in META_PAGE_IDS.
function pageIds() {
  const list = env('META_PAGE_IDS').split(/[\s,;]+/).filter(x => /^\d{1,30}$/.test(x));
  if (!list.length && /^\d{1,30}$/.test(env('META_PAGE_ID'))) list.push(env('META_PAGE_ID'));
  return [...new Set(list)].slice(0, 10);
}

// ── SMALL HELPERS ─────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
function manilaParts(d) { const x = new Date((d ? new Date(d).getTime() : Date.now()) + 8 * 3600e3); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), min: x.getUTCMinutes(), wd: x.getUTCDay() }; }
function manilaDay(d) { const p = manilaParts(d); return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`; }
function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const num = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);
const idOk = v => /^[0-9_]{1,80}$/.test(String(v == null ? '' : v));
const oid = v => mongoose.isValidObjectId(String(v || '')) && /^[a-f0-9]{24}$/i.test(String(v));
function metaTime(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number' || /^\d+$/.test(String(t))) { const n = Number(t); return new Date(n < 1e12 ? n * 1000 : n); }
  const d = new Date(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isNaN(d) ? null : d;
}
function endDay(endTime) { const d = metaTime(endTime); return d ? new Date(d.getTime() - 864e5).toISOString().slice(0, 10) : ''; }
// "2026-10-20T19:00" typed in the composer is Manila time; a full ISO time is taken as given.
function parseWhen(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) d = new Date(s + '+08:00');
  else d = new Date(s);
  return isNaN(d) ? undefined : d;
}
const httpsUrl = u => /^https:\/\/[^\s"'<>]{4,990}$/.test(String(u || ''));
const hashtagsIn = s => (String(s || '').match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const peso = n => '₱' + Math.round(Number(n) || 0).toLocaleString('en-US');
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; }
function toCsv(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

async function getSetting(key, dflt) { const d = await Setting.findOne({ key }).lean(); return { ...(dflt || {}), ...((d && d.value) || {}) }; }
async function patchSetting(key, patch) {
  const set = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) set['value.' + k] = v;
  await Setting.updateOne({ key }, { $set: set }, { upsert: true });
}
const getState = () => getSetting(STATE_KEY, {});
const patchState = p => patchSetting(STATE_KEY, p);
const DEFAULT_SETTINGS = { unansweredHours: 4, approvalEmails: true, weeklyEmail: true, reportEmails: [] };
const getSettings = () => getSetting(SETTINGS_KEY, DEFAULT_SETTINGS);

let _deps = { sendEmail: async () => ({ success: false }), esc: s => String(s), cloudinary: null };

// ══ ACTIVITY LOG (module 5) ════════════════════════════════════
function actorOf(req, via) {
  const u = (req && req.user) || {};
  return { id: String(u.sub || ''), name: String(u.name || u.email || ''), email: String(u.email || ''), via: via || u.via || 'user' };
}
const SYSTEM_ACTOR = { id: '', name: 'GLRA Social', email: 'system', via: 'system' };
const REVIEW_ACTOR = { id: '', name: 'Claude (review key)', email: 'claude-review-key', via: 'review_key' };
function slog(actor, action, f) {
  const a = actor || SYSTEM_ACTOR;
  return SocialLog.create({ actor: a.email || '', actorName: a.name || '', via: a.via || 'user', action, pageId: (f && f.pageId) || '', network: (f && f.network) || '',
    target: (f && f.target) || '', targetId: String((f && f.targetId) || ''), metaId: String((f && f.metaId) || ''), summary: scrub((f && f.summary) || '').slice(0, 500), ok: !(f && f.ok === false) }).catch(() => {});
}
// logAudit wants a request; approvals from an emailed link have none.
function auditReq(actor, req) {
  if (req && req.user) return req;
  return { user: { email: actor.email, name: actor.name, role: actor.role || 'approver' }, ip: (req && req.ip) || '', headers: (req && req.headers) || {} };
}

// ══ PERMISSIONS ════════════════════════════════════════════════
// Same rule as requirePermission (admins have everything; a key never set
// follows the role default), for deciding inside a handler.
// The account's CURRENT state decides, even for an admin: a deactivated admin
// used to keep every permission here because the role alone short-circuited,
// so their emailed approval links went on working for 72 hours.
async function permsOf(userId, role) {
  const none = { view: false, draft: false, approve: false, admin: false };
  if (!mongoose.isValidObjectId(String(userId || ''))) return role === 'admin' ? { view: true, draft: true, approve: true, admin: true } : none;
  const st = await loadAccountState(String(userId || ''));
  if (!st.exists || !st.isActive || st.status === 'pending') return none;
  if (st.role === 'admin') return { view: true, draft: true, approve: true, admin: true };
  const own = st.permissions || {};
  const dflt = defaultPermissionsForRole(st.role || 'employee');
  const has = k => (own[k] === undefined ? dflt[k] === true : own[k] === true);
  return { view: has('social_view'), draft: has('social_draft'), approve: has('social_approve'), admin: false };
}

// ══ MODULE 1: PAGES AND TOKENS ═════════════════════════════════
// Everything known about each Page (no tokens): name, picture, Instagram
// account, followers, token health. Kept in the social_state setting.
async function pagesState() {
  const st = await getState();
  const known = st.pages || {};
  return pageIds().map((id, i) => ({ id, color: PAGE_COLORS[i % PAGE_COLORS.length], name: (known[id] && known[id].name) || 'Page ' + id, ...(known[id] || {}), id }));
}
async function pageById(id) { return (await pagesState()).find(p => p.id === String(id)) || null; }

async function discoverPages() {
  const out = {};
  const st = await getState();
  for (const id of pageIds()) {
    const prev = (st.pages || {})[id] || {};
    try {
      const tok = await pageTokenFor(id, { area: 'social' });
      const d = await metaGet(id, { fields: 'name,picture{url},followers_count,fan_count,instagram_business_account{id,username,followers_count,profile_picture_url}' }, { token: tok, area: 'social', tries: 2 });
      const ig = d.instagram_business_account || null;
      out[id] = { ...prev, name: clean(d.name, 120) || prev.name || '', picture: httpsUrl(d.picture && d.picture.data && d.picture.data.url) ? d.picture.data.url : '',
        followers: num(d.followers_count) !== null ? num(d.followers_count) : num(d.fan_count),
        igId: ig && idOk(ig.id) ? String(ig.id) : '', igUsername: ig ? clean(ig.username, 60) : '', igFollowers: ig ? num(ig.followers_count) : null,
        igPicture: ig && httpsUrl(ig.profile_picture_url) ? ig.profile_picture_url : '', discoveredAt: new Date(), discoverError: '' };
      if (!out[id].igId) out[id].igNote = 'No Instagram account is linked to this Page (or the token cannot see it).';
    } catch (e) {
      out[id] = { ...prev, discoverError: scrub(e.message).slice(0, 200), discoveredAt: new Date() };
    }
    G.addOwnIds([id, out[id].igId]);
  }
  await patchState({ pages: out });
  return out;
}

const SOCIAL_SCOPES = {
  pages_show_list: 'see the Pages', pages_read_engagement: 'read posts and numbers', pages_manage_posts: 'publish to Facebook',
  pages_manage_engagement: 'reply / hide / delete Facebook comments', pages_read_user_content: 'read Facebook comments',
  pages_messaging: 'Messenger replies', instagram_basic: 'see Instagram', instagram_content_publish: 'publish to Instagram',
  instagram_manage_comments: 'Instagram comments', instagram_manage_messages: 'Instagram messages', instagram_manage_insights: 'Instagram insights',
  read_insights: 'Facebook insights'
};
// Daily: the system token's scopes once, then each Page's own token.
async function checkTokens(notify) {
  const appId = env('META_APP_ID'), sec = env('META_APP_SECRET'), sys = env('META_SYSTEM_TOKEN');
  const result = { checkedAt: new Date(), system: null, pages: {} };
  const debug = async tok => (await metaGet('debug_token', { input_token: tok }, { token: `${appId}|${sec}`, noProof: true, area: 'social', tries: 2, urgent: true })).data || {};
  if (!sys) result.system = { ok: false, problem: 'META_SYSTEM_TOKEN is not set in Render.' };
  else if (!appId || !sec) result.system = { ok: false, problem: 'META_APP_ID and META_APP_SECRET must both be set before the tokens can be checked.' };
  else {
    try {
      const d = await debug(sys);
      const scopes = Array.isArray(d.scopes) ? d.scopes.map(String) : [];
      const missing = Object.keys(SOCIAL_SCOPES).filter(s => !scopes.includes(s));
      const exp = Number(d.expires_at) || 0, days = exp ? (exp * 1000 - Date.now()) / 864e5 : null;
      let problem = '';
      if (!d.is_valid) problem = 'The Meta system token is no longer valid. Generate a new one in Business Settings and put it in Render as META_SYSTEM_TOKEN.';
      else if (days !== null && days < 7) problem = `The Meta system token expires in ${Math.max(0, Math.floor(days))} day(s).`;
      result.system = { ok: !problem, problem, scopes, missing: missing.map(s => ({ scope: s, for: SOCIAL_SCOPES[s] })), neverExpires: !!d.is_valid && !exp, expiresAt: exp ? new Date(exp * 1000) : null };
    } catch (e) { result.system = { ok: false, problem: 'The token could not be checked: ' + scrub(e.message).slice(0, 200) }; }
  }
  for (const id of pageIds()) {
    let s;
    try {
      G.forgetPageToken(id);
      const tok = await pageTokenFor(id, { strict: true, area: 'social' });
      const d = appId && sec ? await debug(tok) : { is_valid: true };
      const exp = Number(d.expires_at) || 0, days = exp ? (exp * 1000 - Date.now()) / 864e5 : null;
      s = !d.is_valid ? { ok: false, problem: 'This Page\'s token is not valid. Check that the Page is assigned to the system user (Full control).' }
        : days !== null && days < 7 ? { ok: false, problem: `This Page's token expires in ${Math.max(0, Math.floor(days))} day(s).` }
          : { ok: true, problem: '' };
    } catch (e) { s = { ok: false, problem: scrub(e.message).slice(0, 200) }; }
    result.pages[id] = { ...s, checkedAt: new Date() };
  }
  const st = await getState();
  const problems = [result.system && !result.system.ok ? result.system.problem : '', ...Object.entries(result.pages).filter(([, v]) => !v.ok).map(([k, v]) => `Page ${((st.pages || {})[k] || {}).name || k}: ${v.problem}`)].filter(Boolean);
  const patch = { tokens: result, tokenCheckedDay: manilaDay() };
  if (problems.length) {
    slog(SYSTEM_ACTOR, 'token_warning', { target: 'token', summary: problems.join(' | '), ok: false });
    const key = sha(problems.join('|').replace(/\d+ day/g, 'N day')).slice(0, 16);
    if (notify && st.tokenAlertKey !== key) {
      const { sendEmail, esc } = _deps;
      const to = (await getLeadSettings()).notifyEmail;
      const r = await sendEmail(to, 'GLRA Social: a Facebook / Instagram connection needs attention', getEmailHeader() + `
        <h2 style="color:#c02e00;font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 10px">A Page connection needs attention</h2>
        <ul style="font-size:14px;line-height:1.6">${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
        <p style="font-size:13px;color:#555">Until it is fixed, posts to that Page cannot be published and its inbox and numbers stop updating. You get this email once per problem.</p>
        <p><a href="${SITE_URL}/social.html" style="display:inline-block;background:#0a0a0a;color:#fff;padding:11px 20px;text-decoration:none;font-weight:600">Open GLRA Social</a></p>` + getEmailFooter()).catch(() => null);
      if (r && r.success) patch.tokenAlertKey = key;
    }
  } else if (st.tokenAlertKey) patch.tokenAlertKey = '';
  await patchState(patch);
  return result;
}

// Ask Meta to send each Page's comments and messages to our webhook. Keeps
// leadgen when the lead-ads switch is on (subscribing replaces the field list).
async function subscribePageFields(pageId) {
  const fields = ['feed', 'messages', 'message_echoes', ...(LEADS_ON() ? ['leadgen'] : [])];
  const tok = await pageTokenFor(pageId, { strict: true, area: 'social' });
  const j = await metaWrite('POST', `${pageId}/subscribed_apps`, { subscribed_fields: fields.join(',') }, { token: tok, area: 'social' });
  if (!j || !j.success) throw new MetaError('Meta did not confirm the subscription', { code: 'no_success' });
  return { fields };
}

// ══ MODULE 2: POSTS ════════════════════════════════════════════
const LIVE_TARGET = ['waiting', 'scheduled', 'publishing', 'container'];
function rollup(p) {
  const st = (p.targets || []).map(t => t.status);
  if (!st.length) return p.status;
  if (st.every(s => s === 'published')) return 'published';
  if (st.every(s => s === 'cancelled')) return 'cancelled';
  if (st.some(s => LIVE_TARGET.includes(s))) return st.some(s => s === 'publishing' || s === 'container') ? 'publishing' : 'scheduled';
  const failed = st.filter(s => s === 'failed').length, pub = st.filter(s => s === 'published').length;
  if (failed && pub) return 'partial';
  if (failed) return 'failed';
  return p.status;
}
function cleanMedia(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_MEDIA).map(m => ({
    url: String((m && m.url) || '').trim().slice(0, 1000), type: (m && m.type) === 'video' ? 'video' : 'image',
    width: Math.max(0, Math.round(num(m && m.width) || 0)), height: Math.max(0, Math.round(num(m && m.height) || 0)),
    publicId: clean(m && m.publicId, 200), mediaId: oid(m && m.mediaId) ? String(m.mediaId) : ''
  })).filter(m => m.url);
}
function cleanTargets(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).slice(0, 20).map(t => ({ network: (t && t.network) === 'ig' ? 'ig' : 'fb', pageId: String((t && t.pageId) || ''), caption: clean(t && t.caption, FB_CAPTION_MAX) }))
    .filter(t => { const k = t.network + t.pageId; if (seen.has(k) || !/^\d{1,30}$/.test(t.pageId)) return false; seen.add(k); return true; });
}
// Instagram takes images from 4:5 (tall) to 1.91:1 (wide). A Cloudinary image
// outside that is cropped to the nearest edge by a Cloudinary transformation.
function igRatio(m) {
  if (!m || m.type !== 'image' || !m.width || !m.height) return { ok: true, known: false };
  const r = m.width / m.height;
  if (r >= 0.8 - 0.005 && r <= 1.91 + 0.005) return { ok: true, known: true, ratio: r };
  const ar = r < 0.8 ? '4:5' : '191:100';
  const fixUrl = cloudinaryTransform(m.url, `c_fill,g_auto,ar_${ar}`);
  return { ok: false, known: true, ratio: r, ar, fixUrl, note: `${r < 0.8 ? 'Too tall' : 'Too wide'} for Instagram (${r.toFixed(2)}:1; it takes 0.8:1 to 1.91:1).` + (fixUrl ? ' It will be cropped to ' + (r < 0.8 ? '4:5' : '1.91:1') + ' automatically.' : '') };
}
function cloudinaryTransform(url, t) {
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/.exec(String(url || ''));
  return m ? m[1] + t + '/' + m[2] : '';
}
// Instagram wants a JPEG at a public address: Cloudinary converts on the fly.
function igImageUrl(m) {
  const r = igRatio(m);
  const base = r.fixUrl || m.url;
  return cloudinaryTransform(base, 'f_jpg,q_auto:good') || base;
}
// Links to the website carry UTM tags naming the post and the Page, so a lead
// who arrives through it is credited to that post (Leads.firstTouch.cnt).
function utmFor(postId, network, pageId) { return { utm_source: network === 'ig' ? 'instagram' : 'facebook', utm_medium: 'social', utm_campaign: 'social', utm_content: `sp-${postId}-${pageId}` }; }
function tagUrl(u, postId, network, pageId) {
  try {
    const x = new URL(u);
    if (!/(^|\.)glrarealty\.com$/i.test(x.hostname)) return u;
    for (const [k, v] of Object.entries(utmFor(postId, network, pageId))) x.searchParams.set(k, v);
    return x.toString();
  } catch (e) { return u; }
}
const tagLinksInText = (text, postId, network, pageId) => String(text || '').replace(/https:\/\/(www\.)?glrarealty\.com[^\s)"'<>]*/gi, u => tagUrl(u, postId, network, pageId));

// What would stop this post from publishing. `strict` adds the time rules
// that only apply at the moment of approval.
async function validatePost(p, strict) {
  const errors = [], warnings = [];
  const pages = await pagesState();
  if (!p.targets || !p.targets.length) errors.push('Choose at least one Page or Instagram account.');
  const imgs = (p.media || []).filter(m => m.type === 'image'), vids = (p.media || []).filter(m => m.type === 'video');
  if ((p.media || []).length > MAX_MEDIA) errors.push(`At most ${MAX_MEDIA} photos or videos.`);
  if (vids.length > 1) errors.push('Only one video per post.');
  if (vids.length && imgs.length) errors.push('A post is either photos (up to 10) or one video, not both.');
  for (const m of p.media || []) if (!httpsUrl(m.url)) errors.push('Every photo and video needs a public https address (upload it to the media library).');
  if (p.link && !httpsUrl(p.link)) errors.push('The link must start with https://');
  for (const t of p.targets || []) {
    const pg = pages.find(x => x.id === t.pageId);
    if (!pg) { errors.push(`Page ${t.pageId} is not one of the connected Pages.`); continue; }
    const text = t.caption || p.caption || '';
    if (t.network === 'ig') {
      if (!pg.igId) errors.push(`${pg.name} has no linked Instagram account.`);
      if (!(p.media || []).length) errors.push(`Instagram (${pg.name}) needs a photo or a video: Instagram does not take text-only or link posts.`);
      if (text.length > IG_CAPTION_MAX) errors.push(`Instagram caption for ${pg.name} is ${text.length} characters; the limit is ${IG_CAPTION_MAX}.`);
      if (hashtagsIn(text) > IG_HASHTAG_MAX) errors.push(`Instagram caption for ${pg.name} has ${hashtagsIn(text)} hashtags; the limit is ${IG_HASHTAG_MAX}.`);
      for (const m of imgs) { const r = igRatio(m); if (!r.ok) (r.fixUrl ? warnings : errors).push(r.note); }
      if (p.link) warnings.push('Instagram does not make links in captions clickable; the link is used on Facebook only.');
    } else {
      if (!text.trim() && !(p.media || []).length && !p.link) errors.push(`The Facebook post for ${pg.name} is empty.`);
      if (text.length > FB_CAPTION_MAX) errors.push(`Facebook text for ${pg.name} is over ${FB_CAPTION_MAX} characters.`);
      if (p.link && (p.media || []).length) warnings.push('Facebook shows either a link preview or photos: with photos, the link is added to the text instead.');
    }
  }
  if (p.scheduledAt) {
    const ms = new Date(p.scheduledAt).getTime() - Date.now();
    if (ms > MAX_AHEAD) errors.push('Posts can be scheduled at most 75 days ahead.');
    if (strict) {
      if (ms <= 60e3) errors.push('The scheduled time has passed. Choose a new time, or clear it to publish as soon as it is approved.');
      else if (ms < FB_MIN_AHEAD && (p.targets || []).some(t => t.network === 'fb')) errors.push('Facebook needs a scheduled time at least 10 minutes ahead. Choose a later time, or clear it to publish now.');
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// FB: Facebook's own scheduler for scheduled posts (they publish even if this
// server sleeps). Returns { metaId, scheduled, permalink }.
async function publishFb(post, t) {
  const tok = await pageTokenFor(t.pageId, { strict: true, area: 'social' });
  const pid = String(post._id);
  let text = tagLinksInText(t.caption || post.caption || '', pid, 'fb', t.pageId);
  const link = post.link ? tagUrl(post.link, pid, 'fb', t.pageId) : '';
  const imgs = post.media.filter(m => m.type === 'image'), vid = post.media.find(m => m.type === 'video');
  const sched = post.scheduledAt && new Date(post.scheduledAt).getTime() - Date.now() >= FB_MIN_AHEAD - 60e3
    ? { published: 'false', scheduled_publish_time: Math.floor(new Date(post.scheduledAt).getTime() / 1000) } : {};
  const scheduled = !!sched.scheduled_publish_time;
  const w = (p, params) => metaWrite('POST', p, params, { token: tok, area: 'social' });
  let r, kind;
  if (vid) {
    r = await w(`${t.pageId}/videos`, { file_url: vid.url, description: text, ...sched }); kind = 'video';
  } else if (imgs.length === 1) {
    if (link && !text.includes(link)) text = (text + '\n\n' + link).trim();
    r = await w(`${t.pageId}/photos`, { url: imgs[0].url, message: text, ...sched }); kind = 'photo';
  } else if (imgs.length > 1) {
    if (link && !text.includes(link)) text = (text + '\n\n' + link).trim();
    const ids = [];
    for (const m of imgs) { const ph = await w(`${t.pageId}/photos`, { url: m.url, published: 'false', temporary: scheduled ? 'true' : undefined }); ids.push(ph.id); }
    r = await w(`${t.pageId}/feed`, { message: text, attached_media: ids.map(id => ({ media_fbid: String(id) })), ...sched }); kind = 'feed';
  } else {
    r = await w(`${t.pageId}/feed`, { message: text, link: link || undefined, ...sched }); kind = 'feed';
  }
  const metaId = String(r.post_id || r.id || '');
  let permalink = '';
  if (!scheduled && metaId) {
    try { const d = await metaGet(metaId, { fields: 'permalink_url' }, { token: tok, area: 'social', tries: 1, quiet: true }); permalink = d.permalink_url ? (String(d.permalink_url).startsWith('http') ? d.permalink_url : 'https://www.facebook.com' + d.permalink_url) : ''; } catch (e) { /* the link is a nicety */ }
  }
  return { metaId, scheduled, permalink, kind };
}

// IG: container, then media_publish. A video (or a carousel with one) is
// processed by Meta first: the per-minute tick checks and publishes it.
async function igCreateContainer(post, t, igId, tok) {
  const pid = String(post._id);
  const caption = tagLinksInText(t.caption || post.caption || '', pid, 'ig', t.pageId);
  const w = (p, params) => metaWrite('POST', p, params, { token: tok, area: 'social' });
  const media = post.media;
  if (media.length === 1 && media[0].type === 'video') return { id: (await w(`${igId}/media`, { media_type: 'REELS', video_url: media[0].url, caption, share_to_feed: 'true' })).id, needsWait: true };
  if (media.length === 1) return { id: (await w(`${igId}/media`, { image_url: igImageUrl(media[0]), caption })).id, needsWait: false };
  const kids = [];
  for (const m of media) {
    const c = m.type === 'video' ? await w(`${igId}/media`, { media_type: 'VIDEO', video_url: m.url, is_carousel_item: 'true' }) : await w(`${igId}/media`, { image_url: igImageUrl(m), is_carousel_item: 'true' });
    kids.push(c.id);
  }
  return { id: (await w(`${igId}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption })).id, needsWait: media.some(m => m.type === 'video') };
}
async function igPublishContainer(igId, containerId, tok) {
  const r = await metaWrite('POST', `${igId}/media_publish`, { creation_id: containerId }, { token: tok, area: 'social' });
  const metaId = String(r.id || '');
  let permalink = '';
  try { const d = await metaGet(metaId, { fields: 'permalink' }, { token: tok, area: 'social', tries: 1, quiet: true }); permalink = httpsUrl(d.permalink) ? d.permalink : ''; } catch (e) { /* nicety */ }
  return { metaId, permalink };
}
async function igPublishedLast24h(igId) {
  const since = new Date(Date.now() - 864e5);
  const rows = await SocialPost.aggregate([{ $unwind: '$targets' }, { $match: { 'targets.network': 'ig', 'targets.igId': igId, 'targets.status': 'published', 'targets.publishedAt': { $gte: since } } }, { $count: 'n' }]);
  return (rows[0] && rows[0].n) || 0;
}

// Claims one target (so a tick and an approval can never both publish it).
async function claimTarget(postId, targetId, from, to) {
  const r = await SocialPost.updateOne({ _id: postId, targets: { $elemMatch: { _id: targetId, status: { $in: [].concat(from) } } } }, { $set: { 'targets.$.status': to, updatedAt: new Date() } });
  return r.modifiedCount === 1;
}
async function setTarget(postId, targetId, fields) {
  const set = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(fields)) set['targets.$.' + k] = v;
  await SocialPost.updateOne({ _id: postId, 'targets._id': targetId }, { $set: set });
}
async function finishRollup(postId) {
  const p = await SocialPost.findById(postId);
  if (!p) return null;
  const s = rollup(p);
  if (s !== p.status) { p.status = s; p.updatedAt = new Date(); await p.save(); }
  return p;
}

// Runs every target of an approved post that is due now (FB: always, its
// scheduler takes over; IG: when scheduledAt has come).
async function runTargets(postId, actor) {
  let post = await SocialPost.findById(postId);
  if (!post) return null;
  const pages = await pagesState();
  for (const t of post.targets) {
    if (t.status !== 'waiting' && t.status !== 'container') continue;
    const pg = pages.find(x => x.id === t.pageId) || {};
    if (t.network === 'fb') {
      if (t.status !== 'waiting' || !(await claimTarget(post._id, t._id, 'waiting', 'publishing'))) continue;
      try {
        const r = await publishFb(post, t);
        await setTarget(post._id, t._id, { status: r.scheduled ? 'scheduled' : 'published', metaId: r.metaId, permalink: r.permalink, publishedAt: r.scheduled ? null : new Date(), error: '', unknown: false, attempts: (t.attempts || 0) + 1 });
        slog(actor, r.scheduled ? 'scheduled' : 'published', { pageId: t.pageId, network: 'fb', target: 'post', targetId: post._id, metaId: r.metaId, summary: `${r.scheduled ? 'Scheduled on Facebook for ' + new Date(post.scheduledAt).toISOString() : 'Published on Facebook'} (${pg.name || t.pageId})` });
      } catch (e) {
        await setTarget(post._id, t._id, { status: 'failed', error: scrub(e.message).slice(0, 500), unknown: !!e.unknown, attempts: (t.attempts || 0) + 1 });
        slog(actor, 'failed', { pageId: t.pageId, network: 'fb', target: 'post', targetId: post._id, summary: 'Facebook: ' + scrub(e.message).slice(0, 300), ok: false });
      }
      continue;
    }
    // Instagram
    const due = !post.scheduledAt || new Date(post.scheduledAt).getTime() <= Date.now() + 30e3;
    if (t.status === 'waiting' && !due) continue;
    const from = t.status;
    if (!(await claimTarget(post._id, t._id, from, 'publishing'))) continue;
    try {
      const igId = t.igId || pg.igId;
      if (!igId) throw new MetaError(`${pg.name || t.pageId} has no linked Instagram account`, { code: 'no_ig' });
      const tok = await pageTokenFor(t.pageId, { strict: true, area: 'social' });
      let containerId = t.containerId;
      if (from === 'waiting') {
        if (await igPublishedLast24h(igId) >= 50) throw new MetaError('Instagram allows about 50 posts per 24 hours per account through the API; this one waits for a retry.', { code: 'ig_cap' });
        const c = await igCreateContainer(post, t, igId, tok);
        containerId = String(c.id || '');
        if (c.needsWait) {
          await setTarget(post._id, t._id, { status: 'container', containerId, igId, attempts: (t.attempts || 0) + 1 });
          slog(actor, 'processing', { pageId: t.pageId, network: 'ig', target: 'post', targetId: post._id, metaId: containerId, summary: 'Instagram is processing the video; it publishes when ready' });
          continue;
        }
      } else {
        const st = await metaGet(containerId, { fields: 'status_code,status' }, { token: tok, area: 'social', tries: 2 });
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new MetaError('Instagram could not process the media: ' + clean(st.status || st.status_code, 200), { code: 'ig_container' });
        if (st.status_code !== 'FINISHED') { await setTarget(post._id, t._id, { status: 'container' }); continue; }
      }
      const r = await igPublishContainer(igId, containerId, tok);
      await setTarget(post._id, t._id, { status: 'published', metaId: r.metaId, permalink: r.permalink, containerId, igId, publishedAt: new Date(), error: '', unknown: false, attempts: (t.attempts || 0) + 1 });
      slog(actor, 'published', { pageId: t.pageId, network: 'ig', target: 'post', targetId: post._id, metaId: r.metaId, summary: `Published on Instagram (@${pg.igUsername || igId})` });
    } catch (e) {
      // Meta 9007 / 2207027: the media is not ready yet -> try again next minute.
      if (Number(e.subcode) === 2207027 || Number(e.code) === 9007) { await setTarget(post._id, t._id, { status: 'container' }); continue; }
      await setTarget(post._id, t._id, { status: 'failed', error: scrub(e.message).slice(0, 500), unknown: !!e.unknown, attempts: (t.attempts || 0) + 1 });
      slog(actor, 'failed', { pageId: t.pageId, network: 'ig', target: 'post', targetId: post._id, summary: 'Instagram: ' + scrub(e.message).slice(0, 300), ok: false });
    }
  }
  post = await finishRollup(postId);
  return post;
}

// THE approval. Only called from routes that checked social_approve (or a
// valid one-time link of an account that still has it).
// rev: the version the approver was shown (postJson's rev). When it is given
// and the post has been edited since, the approval is refused so nobody signs
// off on words they never read. The claim itself also pins the version that
// was validated here, so an edit landing mid-approval cannot slip through.
async function approvePost(postId, actor, req, rev) {
  const cur = await SocialPost.findById(postId);
  if (!cur) return { status: 404, error: 'Post not found' };
  if (cur.status !== 'pending') return { status: 409, error: `This post is "${cur.status}", not waiting for approval.` };
  if (rev !== undefined && rev !== null && rev !== '' && String(rev) !== revOf(cur)) return { status: 409, error: 'This post was changed after you opened it. Reload it, read the new version, then approve.', changed: true };
  const v = await validatePost(cur, true);
  if (v.errors.length) return { status: 400, error: v.errors[0], errors: v.errors, warnings: v.warnings };
  const pages = await pagesState();
  // Claimed: a second approve (two tabs, a link and the page) finds nothing.
  const set = { status: 'approved', approvedBy: { id: actor.id, name: actor.name, email: actor.email, via: actor.via }, approvedAt: new Date(), updatedAt: new Date() };
  const claimed = await SocialPost.findOneAndUpdate({ _id: postId, status: 'pending', updatedAt: cur.updatedAt }, { $set: set, $push: { history: { at: new Date(), by: actor.name || actor.email, action: 'approved', note: '' } } }, { new: true });
  if (!claimed) return { status: 409, error: 'Someone else has just handled or changed this post. Reload it and check again.' };
  voidPostLinks(postId).catch(() => {});
  claimed.targets.forEach(t => { t.status = 'waiting'; t.error = ''; t.unknown = false; if (t.network === 'ig') t.igId = (pages.find(x => x.id === t.pageId) || {}).igId || ''; });
  await claimed.save();
  slog(actor, 'approved', { target: 'post', targetId: postId, summary: `Approved "${(claimed.title || claimed.caption || '').slice(0, 80)}"${claimed.scheduledAt ? ' for ' + new Date(claimed.scheduledAt).toISOString() : ' (publish now)'}` });
  await logAudit(auditReq(actor, req), 'SOCIAL_APPROVE', 'SocialPost', String(postId), (claimed.title || claimed.caption || '').slice(0, 80), { via: actor.via, scheduledAt: claimed.scheduledAt, targets: claimed.targets.map(t => t.network + ':' + t.pageId) });
  const post = await runTargets(postId, actor);
  return { status: 200, post, warnings: v.warnings };
}

async function rejectPost(postId, actor, note, req) {
  const p = await SocialPost.findOneAndUpdate({ _id: postId, status: 'pending' }, { $set: { status: 'changes', reviewNote: clean(note, 1000), updatedAt: new Date() }, $push: { history: { at: new Date(), by: actor.name || actor.email, action: 'sent back', note: clean(note, 300) } } }, { new: true });
  if (!p) return { status: 409, error: 'This post is not waiting for approval.' };
  // Sent back: the other approvers' links must not approve a later version.
  voidPostLinks(postId).catch(() => {});
  slog(actor, 'rejected', { target: 'post', targetId: postId, summary: 'Sent back' + (note ? ': ' + clean(note, 200) : '') });
  await logAudit(auditReq(actor, req), 'SOCIAL_REJECT', 'SocialPost', String(postId), (p.title || p.caption || '').slice(0, 80), { note: clean(note, 200), via: actor.via });
  return { status: 200, post: p };
}

// ══ THE PER-MINUTE PUBLISHER ══════════════════════════════════
async function publisherTick() {
  // Instagram posts that are due, and videos Meta has finished processing.
  const due = await SocialPost.find({ status: { $in: ['approved', 'scheduled', 'publishing'] }, targets: { $elemMatch: { network: 'ig', status: { $in: ['waiting', 'container'] } } },
    $or: [{ scheduledAt: null }, { scheduledAt: { $lte: new Date(Date.now() + 30e3) } }, { 'targets.status': 'container' }] }).select('_id approvedBy').limit(20).lean();
  for (const p of due) await runTargets(p._id, { ...SYSTEM_ACTOR, name: 'GLRA Social (scheduled)' });
  // Facebook's own scheduler: once the time has passed, confirm it went out.
  const fb = await SocialPost.find({ scheduledAt: { $lte: new Date(Date.now() - 60e3) }, targets: { $elemMatch: { network: 'fb', status: 'scheduled' } } }).limit(20);
  for (const p of fb) {
    for (const t of p.targets.filter(x => x.network === 'fb' && x.status === 'scheduled' && x.metaId)) {
      try {
        const tok = await pageTokenFor(t.pageId, { area: 'social' });
        const isVid = p.media.some(m => m.type === 'video');
        const d = await metaGet(t.metaId, { fields: isVid ? 'published,permalink_url' : 'is_published,permalink_url' }, { token: tok, area: 'social', tries: 1, quiet: true });
        if (d.is_published === true || d.published === true) {
          t.status = 'published'; t.publishedAt = p.scheduledAt;
          t.permalink = d.permalink_url ? (String(d.permalink_url).startsWith('http') ? d.permalink_url : 'https://www.facebook.com' + d.permalink_url) : t.permalink;
          slog(SYSTEM_ACTOR, 'published', { pageId: t.pageId, network: 'fb', target: 'post', targetId: p._id, metaId: t.metaId, summary: 'Facebook published the scheduled post' });
        } else if (Date.now() - new Date(p.scheduledAt).getTime() > 6 * 3600e3) {
          t.status = 'failed'; t.error = 'Facebook has not published the scheduled post 6 hours after its time. Check the Page\'s scheduled posts.';
          slog(SYSTEM_ACTOR, 'failed', { pageId: t.pageId, network: 'fb', target: 'post', targetId: p._id, metaId: t.metaId, summary: t.error, ok: false });
        }
      } catch (e) { /* checked again next minute */ }
    }
    p.status = rollup(p); p.updatedAt = new Date();
    await p.save();
  }
}

// ══ LISTING STUDIO ════════════════════════════════════════════
const AREA_TAGS = [['bgc', '#BGC'], ['bonifacio', '#BGC'], ['makati', '#Makati'], ['taguig', '#Taguig'], ['pasig', '#Pasig'], ['ortigas', '#Ortigas'], ['mandaluyong', '#Mandaluyong'],
  ['quezon city', '#QuezonCity'], ['alabang', '#Alabang'], ['muntinlupa', '#Muntinlupa'], ['paranaque', '#Paranaque'], ['parañaque', '#Paranaque'], ['pasay', '#Pasay'], ['manila', '#Manila'],
  ['tagaytay', '#Tagaytay'], ['cavite', '#Cavite'], ['laguna', '#Laguna'], ['rockwell', '#Rockwell'], ['san juan', '#SanJuan']];
function listingHashtags(p, page) {
  const tags = ['#GLRARealty', '#RealEstatePH', '#PropertyPH'];
  const loc = String(p.location || '').toLowerCase();
  AREA_TAGS.forEach(([k, t]) => { if (loc.includes(k) && !tags.includes(t)) tags.push(t); });
  const type = String(p.propertyType || '').toLowerCase(), lease = /lease|rent/i.test(p.listingType || '');
  if (/condo/.test(type)) tags.push(lease ? '#CondoForRent' : '#CondoForSale');
  else if (/house|townhouse/.test(type)) tags.push(lease ? '#HouseForRent' : '#HouseAndLot');
  else if (/lot|land/.test(type)) tags.push('#LotForSale');
  else if (/office|commercial/.test(type)) tags.push(lease ? '#OfficeForLease' : '#CommercialProperty');
  tags.push(lease ? '#ForLease' : '#ForSale');
  if (page && /kate/i.test(page.name || '')) tags.push('#KateSampayoRealtor');
  return [...new Set(tags)].slice(0, 15);
}
function listingFacts(p) {
  const lease = /lease|rent/i.test(p.listingType || '');
  const price = lease ? (p.monthlyRental ? peso(p.monthlyRental) + ' a month' : '') : (p.price ? peso(p.price) : '');
  const bits = [p.bedrooms ? `${p.bedrooms} bedroom${p.bedrooms > 1 ? 's' : ''}` : '', p.bathrooms ? `${p.bathrooms} bath` : '', p.sqm ? `${p.sqm} sqm floor area` : '',
    p.landArea ? `${p.landArea} sqm lot` : '', p.parking ? `${p.parking} parking` : '', p.floor ? `${p.floor} floor` : ''].filter(Boolean);
  const summary = clean(p.webSummary || String(p.description || '').split(/\n\s*\n/)[0], 400);
  return { lease, price, bits, summary, area: clean(p.location, 120), type: clean(p.propertyType, 40), title: clean(p.title, 160) };
}
function studioFromListing(raw, pages) {
  const p = applyWebsiteCover({ ...raw });
  const photos = [p.mainImage, ...(p.gallery || [])].filter(u => httpsUrl(u) && !/^data:/i.test(u));
  const media = [...new Set(photos)].slice(0, 8).map(url => ({ url, type: 'image', width: 0, height: 0 }));
  const f = listingFacts(p);
  const link = `${SITE_URL}/property/${String(raw._id)}`;
  const perPage = {};
  for (const pg of pages) {
    const sign = pg.name ? `\n\n${/kate/i.test(pg.name) ? 'Message me' : 'Message us'} for a viewing. ${pg.name}` : '';
    const head = `${f.lease ? 'FOR LEASE' : 'FOR SALE'}: ${f.title}${f.area ? ' in ' + f.area : ''}`;
    const body = [f.price ? `Price: ${f.price}` : '', f.bits.length ? f.bits.join(' · ') : '', f.summary].filter(Boolean).join('\n');
    const tags = listingHashtags(p, pg);
    perPage[pg.id] = {
      fb: `${head}\n\n${body}\n\nFull details and photos: ${link}${sign}`.trim().slice(0, FB_CAPTION_MAX),
      ig: `${head}\n\n${body}\n\nLink in bio, or send us a DM for the details.${sign}\n\n${tags.join(' ')}`.trim().slice(0, IG_CAPTION_MAX),
      hashtags: tags
    };
  }
  const first = pages[0] ? perPage[pages[0].id] : { fb: '', ig: '', hashtags: [] };
  return { propertyId: String(raw._id), title: f.title, media, link, caption: first.fb, captionFb: first.fb, captionIg: first.ig, hashtags: first.hashtags, perPage,
    fill: { property: f.title, price: f.price, area: f.area, link } };
}

// ══ BEST TIME TO POST ═════════════════════════════════════════
const DEFAULT_SLOTS = [[2, 19], [4, 19], [6, 10], [0, 18], [3, 12], [1, 20]];  // Tue 7pm, Thu 7pm, Sat 10am, Sun 6pm, Wed noon, Mon 8pm
const scoreOf = s => (s.reactions || 0) + (s.comments || 0) * 2 + (s.shares || 0) * 3 + (s.saves || 0) * 2;
async function heatmap(pageId) {
  const q = { at: { $gte: new Date(Date.now() - 180 * 864e5) } };
  if (pageId) q.pageId = pageId;
  const rows = await SocialPostStat.find(q).select('pageId network at reactions comments shares saves reach').lean();
  // Each Page / network is scored against its own median, so a big Page does not drown a small one.
  const groups = {};
  rows.forEach(r => { (groups[r.pageId + r.network] = groups[r.pageId + r.network] || []).push(scoreOf(r) / Math.max(1, r.reach || 0) * (r.reach ? 1000 : 1)); });
  const med = {}; Object.entries(groups).forEach(([k, a]) => { med[k] = median(a) || 1; });
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, sum: 0 })));
  rows.forEach(r => {
    if (!r.at) return;
    const p = manilaParts(r.at);
    const v = (scoreOf(r) / Math.max(1, r.reach || 0) * (r.reach ? 1000 : 1)) / (med[r.pageId + r.network] || 1);
    grid[p.wd][p.h].n++; grid[p.wd][p.h].sum += v;
  });
  const cells = [];
  grid.forEach((row, wd) => row.forEach((c, h) => { if (c.n) cells.push({ wd, h, n: c.n, score: Math.round(c.sum / c.n * 100) / 100 }); }));
  const enough = rows.length >= 8;
  const ranked = enough ? cells.slice().sort((a, b) => b.score - a.score || b.n - a.n).map(c => [c.wd, c.h]) : DEFAULT_SLOTS;
  const slots = [];
  const now = Date.now() + 15 * 60e3;
  for (const [wd, h] of ranked) {
    for (let k = 0; k < 8 && slots.length < 6; k++) {
      const day = addDays(manilaDay(), k);
      const at = new Date(`${day}T${pad2(h)}:00:00+08:00`);
      if (manilaParts(at).wd !== wd || at.getTime() < now) continue;
      if (!slots.some(s => s.at.getTime() === at.getTime())) slots.push({ at, wd, h });
      break;
    }
    if (slots.length >= 3) break;
  }
  return { posts: rows.length, enough, grid: grid.map(r => r.map(c => c.n ? Math.round(c.sum / c.n * 100) / 100 : null)), counts: grid.map(r => r.map(c => c.n)),
    slots: slots.sort((a, b) => a.at - b.at).map(s => ({ at: s.at, local: `${manilaDay(s.at)}T${pad2(s.h)}:00`, label: `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.wd]} ${((s.h + 11) % 12) + 1}${s.h < 12 ? 'am' : 'pm'}` })),
    basis: enough ? 'your posts in the last 180 days' : 'a starting suggestion for Philippine property pages (fewer than 8 of your posts to learn from yet)' };
}

// ══ LEADS FROM SOCIAL POSTS ═══════════════════════════════════
let _leadCache = { at: 0, map: null };
async function leadsByPost() {
  if (_leadCache.map && Date.now() - _leadCache.at < 60e3) return _leadCache.map;
  const leads = await Lead.find({ $or: [{ 'firstTouch.cnt': /^sp-/ }, { 'sources.attrib.cnt': /^sp-/ }] }).select('firstTouch sources createdAt').limit(5000).lean();
  const map = {};   // `${postId}` -> { total, byPage: {pageId: n}, byNet: {fb, ig}, leads: [ids] }
  for (const l of leads) {
    const cnts = new Set([l.firstTouch && l.firstTouch.cnt, ...(l.sources || []).map(s => s.attrib && s.attrib.cnt)].filter(c => /^sp-[a-f0-9]{24}-\d+$/.test(String(c || ''))));
    for (const c of cnts) {
      const [, postId, pageId] = c.split('-');
      const m = map[postId] = map[postId] || { total: 0, byPage: {}, leadIds: [] };
      if (m.leadIds.includes(String(l._id))) continue;
      m.leadIds.push(String(l._id)); m.total++; m.byPage[pageId] = (m.byPage[pageId] || 0) + 1;
    }
  }
  _leadCache = { at: Date.now(), map };
  return map;
}

// ══ MODULE 3: INBOX ═══════════════════════════════════════════
const TAG_RULES = [
  ['price', /\b(how much|hm+|magkano|price|presyo|pricelist|price list|cost|downpayment|dp|monthly|amortization|hulog)\b/i],
  ['viewing', /\b(view|viewing|tripping|visit|site visit|schedule|available.*(sat|sun|tomorrow)|pwede.*(tingnan|bisita))\b/i],
  ['seller', /\b(sell my|selling my|ibenta|benta ko|list my|for sale ko|owner here|i have a (unit|lot|house))\b/i],
  ['documents', /\b(title|tct|cct|transfer|tax dec|requirements|documents|papeles|notar)\b/i],
  ['spam', /(crypto|bitcoin|forex|investment opportunity|click here|bit\.ly|t\.me\/|whatsapp\.com\/|earn \$|followers)/i]
];
const POS = /\b(thank|thanks|salamat|great|love|nice|beautiful|ganda|interested|perfect|amazing|ok po|sige)\b/i;
const NEG = /\b(scam|fake|bad|worst|rude|never|angry|disappointed|complain|reklamo|bastos|ang tagal|no reply|walang sagot|ignored)\b/i;
function autoTagsOf(text) { return TAG_RULES.filter(([, re]) => re.test(text || '')).map(([t]) => t); }
function sentimentOf(text) { const p = POS.test(text || ''), n = NEG.test(text || ''); return n && !p ? 'negative' : p && !n ? 'positive' : 'neutral'; }

async function pageForEntry(obj, entryId) {
  const pages = await pagesState();
  if (obj === 'instagram') return pages.find(p => p.igId && p.igId === String(entryId)) || null;
  return pages.find(p => p.id === String(entryId)) || null;
}
const ownIdsOf = pages => new Set(pages.flatMap(p => [p.id, p.igId]).filter(Boolean));

// Adds one item (once) and updates its thread. Returns true when it was new.
async function upsertItem(o) {
  if (!o.metaId || !o.threadKey) return false;
  let created = false;
  try {
    await SocialItem.create({ kind: o.kind, metaId: o.metaId, threadKey: o.threadKey, pageId: o.pageId, igId: o.igId || '', postId: o.postId || '', parentId: o.parentId || '',
      fromId: o.fromId || '', fromName: clean(o.fromName, 200), own: !!o.own, text: clean(o.text, 4000), link: o.link || '', hidden: !!o.hidden, at: o.at || new Date() });
    created = true;
  } catch (e) {
    if (e && e.code !== 11000) throw e;
    if (o.hidden !== undefined) await SocialItem.updateOne({ metaId: o.metaId }, { $set: { hidden: !!o.hidden } });
  }
  if (!created) return false;
  const th = await SocialThread.findOne({ key: o.threadKey }) || new SocialThread({ key: o.threadKey, kind: o.kind, pageId: o.pageId, igId: o.igId || '', postId: o.postId || '', link: o.link || '' });
  const at = o.at || new Date();
  if (!th.lastAt || at > th.lastAt) th.lastAt = at;
  if (o.own) {
    if (!th.lastOwnAt || at > th.lastOwnAt) th.lastOwnAt = at;
    if (th.firstInboundAt && !th.firstReplyAt && at >= th.firstInboundAt) th.firstReplyAt = at;
  } else {
    if (o.userId) th.userId = o.userId;
    if (o.fromName && !th.name) th.name = clean(o.fromName, 200);
    if (!th.lastInboundAt || at > th.lastInboundAt) { th.lastInboundAt = at; th.snippet = clean(o.text, 300); th.sentiment = sentimentOf(o.text); }
    if (!th.firstInboundAt || at < th.firstInboundAt) th.firstInboundAt = at;
    th.autoTags = [...new Set([...(th.autoTags || []), ...autoTagsOf(o.text)])];
    if (th.status === 'done' && at > (th.updatedAt || 0)) th.status = 'open';
  }
  if (o.link && !th.link) th.link = o.link;
  th.updatedAt = new Date();
  await th.save();
  return true;
}

async function personName(userId, ig, tok) {
  try { const d = await metaGet(userId, { fields: ig ? 'name,username' : 'first_name,last_name' }, { token: tok, area: 'social', tries: 1, quiet: true }); return clean(ig ? (d.name || (d.username ? '@' + d.username : '')) : [d.first_name, d.last_name].filter(Boolean).join(' '), 200); } catch (e) { return ''; }
}
const inboxUrl = (ig, pageId) => `https://business.facebook.com/latest/inbox/${ig ? 'instagram_direct' : 'messenger'}?asset_id=${pageId}`;

// Called by meta.js for every signed webhook delivery while SOCIAL_ENABLED.
async function ingestWebhook(body) {
  if (!SOCIAL_ON()) return;
  const obj = String((body && body.object) || '');
  const pages = await pagesState();
  const own = ownIdsOf(pages);
  for (const e of (Array.isArray(body && body.entry) ? body.entry : []).slice(0, 100)) {
    const pg = await pageForEntry(obj, e && e.id);
    if (!pg) continue;
    for (const ch of (Array.isArray(e.changes) ? e.changes : []).slice(0, 200)) {
      const v = (ch && ch.value) || {};
      if (obj === 'page' && ch.field === 'feed' && v.item === 'comment' && idOk(v.comment_id)) {
        const top = v.parent_id && v.parent_id !== v.post_id ? String(v.parent_id) : String(v.comment_id);
        if (v.verb === 'remove') { await SocialItem.updateOne({ metaId: String(v.comment_id) }, { $set: { deleted: true } }); continue; }
        if (v.verb === 'hide' || v.verb === 'unhide') { await SocialItem.updateOne({ metaId: String(v.comment_id) }, { $set: { hidden: v.verb === 'hide' } }); continue; }
        if (v.verb !== 'add' && v.verb !== 'edited') continue;
        const from = v.from || {};
        await upsertItem({ kind: 'fb_comment', metaId: String(v.comment_id), threadKey: 'c:' + top, pageId: pg.id, postId: idOk(v.post_id) ? String(v.post_id) : '', parentId: v.parent_id ? String(v.parent_id) : '',
          fromId: clean(from.id, 40), fromName: from.name, own: own.has(String(from.id)), text: v.message, at: metaTime(v.created_time) || new Date(),
          link: 'https://www.facebook.com/' + (idOk(v.post_id) ? v.post_id : v.comment_id) });
      } else if (obj === 'instagram' && ch.field === 'comments' && idOk(v.id)) {
        const from = v.from || {};
        const top = v.parent_id ? String(v.parent_id) : String(v.id);
        await upsertItem({ kind: 'ig_comment', metaId: String(v.id), threadKey: 'c:' + top, pageId: pg.id, igId: pg.igId, postId: v.media && idOk(v.media.id) ? String(v.media.id) : '', parentId: v.parent_id ? String(v.parent_id) : '',
          fromId: clean(from.id, 40), fromName: from.username ? '@' + clean(from.username, 100) : '', own: own.has(String(from.id)), text: v.text, at: metaTime(v.timestamp) || new Date(), link: 'https://www.instagram.com/' });
      }
    }
    for (const m of (Array.isArray(e.messaging) ? e.messaging : []).slice(0, 200)) {
      if (!m || !m.message || !m.message.mid) continue;
      const ig = obj === 'instagram';
      const sender = String((m.sender && m.sender.id) || ''), recipient = String((m.recipient && m.recipient.id) || '');
      const isOwn = !!m.message.is_echo || own.has(sender);
      const userId = isOwn ? recipient : sender;
      if (!/^\d{1,40}$/.test(userId)) continue;
      const kind = ig ? 'ig_dm' : 'messenger';
      const key = `${kind}:${pg.id}:${userId}`;
      let name = '';
      if (!isOwn && !(await SocialThread.exists({ key, name: { $nin: ['', null] } }))) name = await personName(userId, ig, await pageTokenFor(pg.id, { area: 'social' }));
      await upsertItem({ kind, metaId: clean(m.message.mid, 200), threadKey: key, pageId: pg.id, igId: ig ? pg.igId : '', fromId: isOwn ? (ig ? pg.igId : pg.id) : userId, userId: isOwn ? '' : userId,
        fromName: isOwn ? pg.name : (name || (ig ? 'Instagram user' : 'Messenger user')), own: isOwn,
        text: clean(m.message.text, 4000) || (Array.isArray(m.message.attachments) ? '[sent an attachment]' : ''), at: metaTime(m.timestamp) || new Date(), link: inboxUrl(ig, pg.id) });
      if (isOwn) await SocialThread.updateOne({ key, userId: '' }, { $set: { userId } });
    }
  }
}

// Every 10 minutes: what the webhook may have missed. Each surface is read on
// its own, so a permission still waiting for App Review only marks that one.
async function syncInbox() {
  const pages = await pagesState();
  const own = ownIdsOf(pages);
  const status = {};
  let added = 0;
  for (const pg of pages) {
    let tok;
    try { tok = await pageTokenFor(pg.id, { strict: true, area: 'social' }); } catch (e) { status[pg.id + '.token'] = { ok: false, message: scrub(e.message).slice(0, 200) }; continue; }
    const surfaces = [['messenger', false], ...(pg.igId ? [['ig_dm', true]] : [])];
    for (const [kind, ig] of surfaces) {
      try {
        const convs = await metaGetAll(`${pg.id}/conversations`, { platform: ig ? 'instagram' : undefined, fields: 'id,updated_time,messages.limit(10){id,message,from,to,created_time}', limit: 25 }, { token: tok, area: 'social', tries: 2 }, 2);
        for (const c of convs) {
          const msgs = ((c.messages && c.messages.data) || []);
          const userId = String((msgs.map(x => x.from && x.from.id).find(id => id && !own.has(String(id)))) || (((msgs[0] || {}).to || {}).data || [{}])[0].id || '');
          if (!/^\d{1,40}$/.test(userId)) continue;
          const key = `${kind}:${pg.id}:${userId}`;
          for (const x of msgs.slice().reverse()) {
            const isOwn = own.has(String(x.from && x.from.id));
            if (await upsertItem({ kind, metaId: clean(x.id, 200), threadKey: key, pageId: pg.id, igId: ig ? pg.igId : '', fromId: clean(x.from && x.from.id, 40), userId: isOwn ? '' : userId,
              fromName: isOwn ? pg.name : clean((x.from && (x.from.name || (x.from.username ? '@' + x.from.username : ''))) || '', 200), own: isOwn, text: x.message, at: metaTime(x.created_time) || new Date(), link: inboxUrl(ig, pg.id) })) added++;
          }
          await SocialThread.updateOne({ key, userId: '' }, { $set: { userId } });
        }
        status[pg.id + '.' + kind] = { ok: true };
      } catch (e) { status[pg.id + '.' + kind] = { ok: false, message: scrub(e.message).slice(0, 200) }; }
    }
    try {
      const posts = await metaGet(`${pg.id}/feed`, { fields: 'id,permalink_url,comments.limit(25){id,message,from,created_time,is_hidden,comments.limit(10){id,message,from,created_time,is_hidden}}', limit: 10 }, { token: tok, area: 'social', tries: 2 });
      for (const p of posts.data || []) {
        for (const c of (p.comments && p.comments.data) || []) {
          const link = httpsUrl(p.permalink_url) ? p.permalink_url : 'https://www.facebook.com/' + p.id;
          if (await upsertItem({ kind: 'fb_comment', metaId: String(c.id), threadKey: 'c:' + c.id, pageId: pg.id, postId: String(p.id), fromId: clean(c.from && c.from.id, 40), fromName: c.from && c.from.name,
            own: own.has(String(c.from && c.from.id)), text: c.message, hidden: !!c.is_hidden, at: metaTime(c.created_time) || new Date(), link })) added++;
          for (const r of (c.comments && c.comments.data) || []) {
            if (await upsertItem({ kind: 'fb_comment', metaId: String(r.id), threadKey: 'c:' + c.id, pageId: pg.id, postId: String(p.id), parentId: String(c.id), fromId: clean(r.from && r.from.id, 40), fromName: r.from && r.from.name,
              own: own.has(String(r.from && r.from.id)), text: r.message, hidden: !!r.is_hidden, at: metaTime(r.created_time) || new Date(), link })) added++;
          }
        }
      }
      status[pg.id + '.fb_comment'] = { ok: true };
    } catch (e) { status[pg.id + '.fb_comment'] = { ok: false, message: scrub(e.message).slice(0, 200) }; }
    if (pg.igId) {
      try {
        const media = await metaGet(`${pg.igId}/media`, { fields: 'id,permalink,comments.limit(25){id,text,username,from,timestamp,hidden,replies.limit(10){id,text,username,from,timestamp,hidden}}', limit: 10 }, { token: tok, area: 'social', tries: 2 });
        for (const m of media.data || []) {
          const link = httpsUrl(m.permalink) ? m.permalink : 'https://www.instagram.com/';
          for (const c of (m.comments && m.comments.data) || []) {
            const fromId = clean((c.from && c.from.id) || '', 40);
            if (await upsertItem({ kind: 'ig_comment', metaId: String(c.id), threadKey: 'c:' + c.id, pageId: pg.id, igId: pg.igId, postId: String(m.id), fromId, fromName: c.username ? '@' + clean(c.username, 100) : '',
              own: own.has(fromId) || (pg.igUsername && c.username === pg.igUsername), text: c.text, hidden: !!c.hidden, at: metaTime(c.timestamp) || new Date(), link })) added++;
            for (const r of (c.replies && c.replies.data) || []) {
              const rid = clean((r.from && r.from.id) || '', 40);
              if (await upsertItem({ kind: 'ig_comment', metaId: String(r.id), threadKey: 'c:' + c.id, pageId: pg.id, igId: pg.igId, postId: String(m.id), parentId: String(c.id), fromId: rid, fromName: r.username ? '@' + clean(r.username, 100) : '',
                own: own.has(rid) || (pg.igUsername && r.username === pg.igUsername), text: r.text, hidden: !!r.hidden, at: metaTime(r.timestamp) || new Date(), link })) added++;
            }
          }
        }
        status[pg.id + '.ig_comment'] = { ok: true };
      } catch (e) { status[pg.id + '.ig_comment'] = { ok: false, message: scrub(e.message).slice(0, 200) }; }
    }
  }
  await patchState({ lastInboxSyncAt: new Date(), inboxStatus: status });
  return { added, status };
}

function windowOf(th) {
  if (!['messenger', 'ig_dm'].includes(th.kind)) return null;
  if (!th.lastInboundAt) return { open: false, closesAt: null, why: 'The person has not written yet: a Page cannot start a conversation.' };
  const closesAt = new Date(new Date(th.lastInboundAt).getTime() + 24 * 3600e3);
  const open = closesAt.getTime() > Date.now();
  return { open, closesAt, why: open ? '' : 'Meta allows replies only within 24 hours of the person\'s last message. This window closed; the reply can go out if they write again. (The 7-day human-agent tag needs a separate Meta approval.)' };
}
function unanswered(th, hours) {
  return !!(th.lastInboundAt && th.status !== 'done' && (!th.lastOwnAt || new Date(th.lastOwnAt) < new Date(th.lastInboundAt)) && Date.now() - new Date(th.lastInboundAt).getTime() > hours * 3600e3);
}
function waitingReply(th) { return !!(th.lastInboundAt && th.status !== 'done' && (!th.lastOwnAt || new Date(th.lastOwnAt) < new Date(th.lastInboundAt))); }

// The Page answered from here: on the person's lead it counts as contact,
// which stops the Leads reply clock. With the Meta inbox switch on, meta.js
// already does this from the echo, so it is not done twice.
async function noteLeadReply(th, item) {
  if (INBOX_ON()) return;
  try {
    let lead = null;
    if (['messenger', 'ig_dm'].includes(th.kind) && th.userId) lead = await Lead.findOne({ metaIds: (th.kind === 'ig_dm' ? 'ig:' : 'fb:') + th.userId });
    else if (item) lead = await Lead.findOne({ sources: { $elemMatch: { kind: th.kind, refId: th.key.slice(2) } } });
    if (!lead) return;
    pushActivity(lead, { type: 'social_reply', outcome: 'Replied', text: 'Replied from GLRA Social', at: new Date(), by: 'meta', byName: 'GLRA Social' });
    lead.updatedAt = new Date();
    await lead.save();
  } catch (e) { /* the reply itself went out; the clock is a nicety */ }
}

// Carries out an approved inbox action against Meta.
async function executeAction(actionId, actor, req) {
  const a = await SocialAction.findOneAndUpdate({ _id: actionId, status: 'pending' }, { $set: { status: 'working', approvedBy: { id: actor.id, name: actor.name, email: actor.email, via: actor.via } } }, { new: true });
  if (!a) return { status: 409, error: 'This action is not waiting for approval.' };
  const fail = async (msg, unknown) => {
    await SocialAction.updateOne({ _id: a._id }, { $set: { status: 'failed', error: scrub(msg).slice(0, 500), doneAt: new Date() } });
    slog(actor, 'failed', { pageId: a.pageId, network: a.network, target: 'action', targetId: a._id, summary: `${a.kind}: ${scrub(msg).slice(0, 300)}`, ok: false });
    return { status: 502, error: msg, unknown: !!unknown };
  };
  const item = oid(a.itemId) ? await SocialItem.findById(a.itemId) : null;
  const th = await SocialThread.findOne({ key: a.threadKey });
  if (!th) return fail('The conversation is no longer in the inbox.');
  let tok;
  try { tok = await pageTokenFor(th.pageId, { strict: true, area: 'social' }); } catch (e) { return fail(e.message); }
  const pg = await pageById(th.pageId) || {};
  try {
    let r = {};
    const isMsg = ['messenger', 'ig_dm'].includes(th.kind);
    if (a.kind === 'reply') {
      if (isMsg) {
        const w = windowOf(th);
        if (!w.open) return fail(w.why);
        r = await metaWrite('POST', `${th.pageId}/messages`, { recipient: { id: th.userId }, message: { text: a.text }, messaging_type: 'RESPONSE' }, { token: tok, area: 'social' });
      } else {
        if (!item) return fail('The comment is no longer in the inbox.');
        r = await metaWrite('POST', th.kind === 'ig_comment' ? `${item.metaId}/replies` : `${item.metaId}/comments`, { message: a.text }, { token: tok, area: 'social' });
      }
      const mid = String(r.message_id || r.id || '');
      if (mid) await upsertItem({ kind: th.kind, metaId: mid, threadKey: th.key, pageId: th.pageId, igId: th.igId, postId: th.postId, parentId: item ? item.metaId : '', fromId: th.kind === 'ig_comment' || th.kind === 'ig_dm' ? pg.igId : th.pageId,
        fromName: pg.name || 'Page', own: true, text: a.text, at: new Date(), link: th.link });
      await SocialThread.updateOne({ key: th.key }, { $set: { lastOwnAt: new Date(), updatedAt: new Date() } });
      await noteLeadReply(th, item);
      await SocialAction.updateOne({ _id: a._id }, { $set: { status: 'done', metaId: mid, doneAt: new Date(), error: '' } });
      slog(actor, 'replied', { pageId: th.pageId, network: th.kind.startsWith('ig') ? 'ig' : 'fb', target: 'action', targetId: a._id, metaId: mid, summary: `Reply sent (${th.kind.replace('_', ' ')}): ${clean(a.text, 120)}` });
      await logAudit(auditReq(actor, req), 'SOCIAL_SEND', 'SocialAction', String(a._id), th.kind, { via: actor.via, metaId: mid });
      return { status: 200, metaId: mid };
    }
    if (isMsg) return fail('Messages cannot be hidden or deleted through the API; only comments can.');
    if (!item) return fail('The comment is no longer in the inbox.');
    if (a.kind === 'hide' || a.kind === 'unhide') {
      const hide = a.kind === 'hide';
      r = await metaWrite('POST', item.metaId, th.kind === 'ig_comment' ? { hide: hide ? 'true' : 'false' } : { is_hidden: hide ? 'true' : 'false' }, { token: tok, area: 'social' });
      await SocialItem.updateOne({ _id: item._id }, { $set: { hidden: hide } });
    } else if (a.kind === 'delete') {
      r = await metaWrite('DELETE', item.metaId, {}, { token: tok, area: 'social' });
      await SocialItem.updateOne({ _id: item._id }, { $set: { deleted: true } });
    }
    await SocialAction.updateOne({ _id: a._id }, { $set: { status: 'done', doneAt: new Date(), error: '' } });
    const word = { hide: 'hidden', unhide: 'unhidden', delete: 'deleted' }[a.kind];
    slog(actor, word, { pageId: th.pageId, network: th.kind.startsWith('ig') ? 'ig' : 'fb', target: 'action', targetId: a._id, metaId: item.metaId, summary: `Comment ${word}: "${clean(item.text, 100)}"` });
    await logAudit(auditReq(actor, req), a.kind === 'delete' ? 'SOCIAL_DELETE_COMMENT' : 'SOCIAL_' + a.kind.toUpperCase(), 'SocialItem', String(item._id), clean(item.text, 80), { via: actor.via, metaId: item.metaId, success: r && r.success });
    return { status: 200 };
  } catch (e) { return fail(e.message, e.unknown); }
}

async function rejectAction(actionId, actor, note, req) {
  const a = await SocialAction.findOneAndUpdate({ _id: actionId, status: 'pending' }, { $set: { status: 'rejected', note: clean(note, 600), approvedBy: { id: actor.id, name: actor.name, email: actor.email, via: actor.via }, doneAt: new Date() } }, { new: true });
  if (!a) return { status: 409, error: 'This action is not waiting for approval.' };
  slog(actor, 'rejected', { pageId: a.pageId, target: 'action', targetId: a._id, summary: `Did not approve the ${a.kind}` + (note ? ': ' + clean(note, 200) : '') });
  await logAudit(auditReq(actor, req), 'SOCIAL_REJECT', 'SocialAction', String(a._id), a.kind, { note: clean(note, 200), via: actor.via });
  return { status: 200 };
}

// Makes an inbox action that waits for approval. Checks what can already be
// checked (the 24-hour window, the kind of item).
async function createAction({ itemId, threadKey, kind, text }, actor) {
  if (!['reply', 'hide', 'unhide', 'delete'].includes(kind)) return { status: 400, error: 'Unknown action' };
  let item = null, th = null;
  if (oid(itemId)) { item = await SocialItem.findById(itemId).lean(); if (item) th = await SocialThread.findOne({ key: item.threadKey }).lean(); }
  if (!th && threadKey) th = await SocialThread.findOne({ key: String(threadKey) }).lean();
  if (!th) return { status: 404, error: 'Conversation not found' };
  const isMsg = ['messenger', 'ig_dm'].includes(th.kind);
  if (kind !== 'reply' && isMsg) return { status: 400, error: 'Messages cannot be hidden or deleted through the API; only comments can.' };
  if (kind !== 'reply' && !item) return { status: 400, error: 'Choose the comment to act on.' };
  if (item && item.own && kind !== 'delete') return { status: 400, error: 'That is the Page\'s own comment.' };
  const body = clean(text, 2000);
  if (kind === 'reply' && !body) return { status: 400, error: 'Write the reply first.' };
  if (kind === 'reply' && isMsg) { const w = windowOf(th); if (!w.open) return { status: 400, error: w.why, window: w }; }
  if (kind === 'reply' && !isMsg && !item) {
    item = await SocialItem.findOne({ threadKey: th.key, own: false }).sort({ at: 1 }).lean();
    if (!item) return { status: 400, error: 'Nothing to reply to in this thread.' };
  }
  const a = await SocialAction.create({ kind, itemId: item ? String(item._id) : '', threadKey: th.key, pageId: th.pageId, network: th.kind.startsWith('ig') ? 'ig' : 'fb', text: body,
    createdBy: { id: actor.id, name: actor.name, email: actor.email, via: actor.via } });
  slog(actor, kind === 'reply' ? 'reply_drafted' : kind + '_requested', { pageId: th.pageId, network: a.network, target: 'action', targetId: a._id, summary: kind === 'reply' ? 'Reply waiting for approval: ' + clean(body, 120) : `Asked to ${kind} a comment` });
  return { status: 200, action: a };
}

// ══ MODULE 4: INSIGHTS ════════════════════════════════════════
const FB_METRICS = [
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
const isRetired = e => e && Number(e.code) === 100 && /metric|insights/i.test(e.message || '');

async function snapshotPages(days) {
  const today = manilaDay(), since = addDays(today, -Math.max(1, Math.min(90, days || 3))), yesterday = addDays(today, -1);
  const status = {};
  const note = (k, e) => { status[k] = e ? { status: isRetired(e) ? 'retired' : 'error', message: scrub(e.message).slice(0, 200), at: new Date() } : { status: 'ok', at: new Date() }; };
  const put = {};
  const cell = (pid, s, d) => (put[`${pid}|${s}|${d}`] = put[`${pid}|${s}|${d}`] || {});
  for (const pg of await pagesState()) {
    let tok;
    try { tok = await pageTokenFor(pg.id, { strict: true, area: 'social' }); } catch (e) { note(pg.id + '.token', e); continue; }
    for (const m of FB_METRICS) {
      try {
        const d = await metaGet(`${pg.id}/insights`, { metric: m.key, period: 'day', since, until: today }, { token: tok, area: 'social', tries: 3 });
        for (const row of d.data || []) for (const v of row.values || []) { const day = endDay(v.end_time); const n = num(v.value); if (day && n !== null) cell(pg.id, 'fb', day)[m.key] = n; }
        note(`${pg.id}.fb.${m.key}`);
      } catch (e) { note(`${pg.id}.fb.${m.key}`, e); }
    }
    try {
      const d = await metaGet(pg.id, { fields: 'followers_count,fan_count' }, { token: tok, area: 'social', tries: 3 });
      const n = num(d.followers_count) !== null ? num(d.followers_count) : num(d.fan_count);
      if (n !== null) cell(pg.id, 'fb', yesterday).followers_total = n;
      note(`${pg.id}.fb.followers_total`);
    } catch (e) { note(`${pg.id}.fb.followers_total`, e); }
    if (!pg.igId) continue;
    for (const m of IG_METRICS) {
      try {
        if (m.totalValue) {
          for (let day = since; day <= yesterday; day = addDays(day, 1)) {
            const d = await metaGet(`${pg.igId}/insights`, { metric: m.key, period: 'day', metric_type: 'total_value', since: day, until: addDays(day, 1) }, { token: tok, area: 'social', tries: 3 });
            const n = num((((d.data || [])[0] || {}).total_value || {}).value);
            if (n !== null) cell(pg.id, 'ig', day)[m.key] = n;
          }
        } else {
          const d = await metaGet(`${pg.igId}/insights`, { metric: m.key, period: 'day', since, until: today }, { token: tok, area: 'social', tries: 3 });
          for (const row of d.data || []) for (const v of row.values || []) { const day = endDay(v.end_time); const n = num(v.value); if (day && n !== null) cell(pg.id, 'ig', day)[m.key] = n; }
        }
        note(`${pg.id}.ig.${m.key}`);
      } catch (e) { note(`${pg.id}.ig.${m.key}`, e); }
    }
    try {
      const d = await metaGet(pg.igId, { fields: 'followers_count' }, { token: tok, area: 'social', tries: 3 });
      if (num(d.followers_count) !== null) cell(pg.id, 'ig', yesterday).followers_total = num(d.followers_count);
      note(`${pg.id}.ig.followers_total`);
    } catch (e) { note(`${pg.id}.ig.followers_total`, e); }
  }
  let rows = 0;
  for (const [k, metrics] of Object.entries(put)) {
    const [pageId, surface, date] = k.split('|');
    const set = { updatedAt: new Date() };
    for (const [mk, mv] of Object.entries(metrics)) set['metrics.' + mk] = mv;
    await SocialDaily.updateOne({ date, pageId, surface }, { $set: set }, { upsert: true });
    rows++;
  }
  const st = await getState();
  await patchState({ metricStatus: { ...(st.metricStatus || {}), ...status }, lastSnapshotAt: new Date(), lastSnapshotDay: today, backfilled: true });
  return { rows, since, until: yesterday, errors: Object.entries(status).filter(([, s]) => s.status !== 'ok').map(([k, s]) => k + ': ' + s.status) };
}

// Every published post (made here or not) with its engagement.
async function syncPostStats() {
  const since = new Date(Date.now() - 90 * 864e5);
  let n = 0;
  const ours = new Map();
  (await SocialPost.find({ 'targets.metaId': { $ne: '' } }).select('targets').lean()).forEach(p => p.targets.forEach(t => t.metaId && ours.set(t.metaId, String(p._id))));
  for (const pg of await pagesState()) {
    let tok;
    try { tok = await pageTokenFor(pg.id, { strict: true, area: 'social' }); } catch (e) { continue; }
    try {
      const posts = await metaGetAll(`${pg.id}/published_posts`, { fields: 'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', limit: 50, since: Math.floor(since.getTime() / 1000) }, { token: tok, area: 'social' }, 3);
      for (const [i, p] of posts.entries()) {
        const row = { pageId: pg.id, network: 'fb', at: metaTime(p.created_time), text: clean(p.message, 2200), permalink: httpsUrl(p.permalink_url) ? p.permalink_url : '', thumb: httpsUrl(p.full_picture) ? p.full_picture : '',
          reactions: num(p.reactions && p.reactions.summary && p.reactions.summary.total_count) || 0, comments: num(p.comments && p.comments.summary && p.comments.summary.total_count) || 0, shares: num(p.shares && p.shares.count) || 0,
          postRef: ours.get(String(p.id)) || '', fetchedAt: new Date() };
        if (i < 20) for (const [metric, field] of [['post_total_media_view_unique', 'reach'], ['post_media_view', 'views']]) {
          try { const d = await metaGet(`${p.id}/insights`, { metric }, { token: tok, area: 'social', tries: 1, quiet: true }); row[field] = num((((d.data || [])[0] || {}).values || [{}])[0].value); } catch (e) { /* that figure stays blank */ }
        }
        row.engagement = scoreOf(row);
        await SocialPostStat.updateOne({ metaId: String(p.id) }, { $set: row }, { upsert: true }); n++;
      }
    } catch (e) { /* logged by metaGet */ }
    if (!pg.igId) continue;
    try {
      const media = await metaGetAll(`${pg.igId}/media`, { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count', limit: 50 }, { token: tok, area: 'social' }, 2);
      for (const [i, m] of media.entries()) {
        const at = metaTime(m.timestamp);
        if (at && at < since) continue;
        const thumb = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
        const row = { pageId: pg.id, network: 'ig', at, text: clean(m.caption, 2200), permalink: httpsUrl(m.permalink) ? m.permalink : '', mediaType: clean(m.media_type, 20), thumb: httpsUrl(thumb) ? thumb : '',
          reactions: num(m.like_count) || 0, comments: num(m.comments_count) || 0, postRef: ours.get(String(m.id)) || '', fetchedAt: new Date() };
        if (i < 20) {
          try {
            const d = await metaGet(`${m.id}/insights`, { metric: 'reach,views,saved,shares' }, { token: tok, area: 'social', tries: 1, quiet: true });
            for (const r of d.data || []) { const v = num(((r.values || [{}])[0] || {}).value); if (r.name === 'saved') row.saves = v || 0; else if (r.name === 'shares') row.shares = v || 0; else row[r.name] = v; }
          } catch (e) {
            for (const [metric, field] of [['reach', 'reach'], ['views', 'views'], ['saved', 'saves'], ['shares', 'shares']]) {
              try { const d = await metaGet(`${m.id}/insights`, { metric }, { token: tok, area: 'social', tries: 1, quiet: true }); row[field] = num((((d.data || [])[0] || {}).values || [{}])[0].value); } catch (e2) { /* blank */ }
            }
          }
        }
        row.engagement = scoreOf(row);
        await SocialPostStat.updateOne({ metaId: String(m.id) }, { $set: row }, { upsert: true }); n++;
      }
    } catch (e) { /* logged */ }
  }
  await patchState({ lastStatsSyncAt: new Date() });
  return { posts: n };
}

async function insightsFor(from, to, onlyPage) {
  const pages = (await pagesState()).filter(p => !onlyPage || p.id === onlyPage);
  const st = await getState();
  const ms = st.metricStatus || {};
  const rows = await SocialDaily.find({ date: { $gte: from, $lte: to }, pageId: { $in: pages.map(p => p.id) } }).sort({ date: 1 }).lean();
  const lmap = await leadsByPost();
  // Meta's daily figures stop at yesterday, but posts and leads from today count too.
  const fromD = new Date(from + 'T00:00:00+08:00'), toD = to >= addDays(manilaDay(), -1) ? new Date() : new Date(to + 'T23:59:59.999+08:00');
  const stats = await SocialPostStat.find({ pageId: { $in: pages.map(p => p.id) }, at: { $gte: fromD, $lte: toD } }).sort({ engagement: -1 }).lean();
  // Leads that arrived in the range through a post link.
  const leadRows = await Lead.find({ createdAt: { $gte: fromD, $lte: toD }, $or: [{ 'firstTouch.cnt': /^sp-/ }, { 'sources.attrib.cnt': /^sp-/ }] }).select('firstTouch sources').lean();
  const leadsPerPage = {};
  leadRows.forEach(l => {
    const seen = new Set();
    [l.firstTouch && l.firstTouch.cnt, ...(l.sources || []).map(s => s.attrib && s.attrib.cnt)].forEach(c => { const m = /^sp-[a-f0-9]{24}-(\d+)$/.exec(String(c || '')); if (m && !seen.has(m[1])) { seen.add(m[1]); leadsPerPage[m[1]] = (leadsPerPage[m[1]] || 0) + 1; } });
  });
  const out = [];
  for (const pg of pages) {
    const tiles = {};
    for (const [surface, defs] of [['fb', FB_METRICS.concat([{ key: 'followers_total', label: 'Followers (account)', agg: 'last' }])], ['ig', IG_METRICS.concat([{ key: 'followers_total', label: 'Followers', agg: 'last' }])]]) {
      if (surface === 'ig' && !pg.igId) continue;
      const mine = rows.filter(r => r.pageId === pg.id && r.surface === surface);
      tiles[surface] = defs.map(m => {
        const series = mine.map(r => [r.date, num((r.metrics || {})[m.key])]).filter(x => x[1] !== null);
        const value = !series.length ? null : m.agg === 'last' ? series[series.length - 1][1] : series.reduce((a, x) => a + x[1], 0);
        const change = m.agg === 'last' && series.length > 1 ? series[series.length - 1][1] - series[0][1] : null;
        const s = ms[`${pg.id}.${surface}.${m.key}`] || {};
        return { key: m.key, label: m.label, agg: m.agg, value: value === null ? null : Math.round(value * 100) / 100, change, series, status: s.status || '', statusMsg: s.message || '' };
      });
    }
    const mineStats = stats.filter(s => s.pageId === pg.id);
    const withLeads = s => ({ ...s, _id: undefined, leads: s.postRef && lmap[s.postRef] ? (lmap[s.postRef].byPage[pg.id] || 0) : 0 });
    out.push({ page: { id: pg.id, name: pg.name, color: pg.color, igUsername: pg.igUsername || '' }, tiles,
      posts: { count: mineStats.length, fb: mineStats.filter(s => s.network === 'fb').length, ig: mineStats.filter(s => s.network === 'ig').length },
      top: mineStats.slice(0, 5).map(withLeads), bottom: mineStats.length > 5 ? mineStats.slice(-3).reverse().map(withLeads) : [],
      leads: leadsPerPage[pg.id] || 0 });
  }
  return { from, to, pages: out, lastSnapshotAt: st.lastSnapshotAt || null, lastStatsSyncAt: st.lastStatsSyncAt || null };
}

// Ads: READ-ONLY campaign results from the connected ad account.
let _adsCache = { key: '', at: 0, data: null };
const LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped'];
function leadsFromActions(actions) { let best = 0; for (const a of Array.isArray(actions) ? actions : []) if (LEAD_ACTIONS.includes(a.action_type)) best = Math.max(best, num(a.value) || 0); return best; }
async function adsFor(from, to) {
  if (!AD_ACCOUNT()) return { configured: false, campaigns: [] };
  const key = from + to;
  if (_adsCache.key === key && Date.now() - _adsCache.at < 30 * 60e3) return _adsCache.data;
  const rows = await metaGetAll(`act_${AD_ACCOUNT()}/insights`, { level: 'campaign', fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions', time_range: { since: from, until: to }, limit: 200 }, { area: 'social' }, 5);
  const campaigns = rows.map(r => { const spend = num(r.spend) || 0, leads = leadsFromActions(r.actions); return { id: clean(r.campaign_id, 40), name: clean(r.campaign_name, 200), spend, impressions: num(r.impressions) || 0, clicks: num(r.clicks) || 0, leads, cpl: leads ? Math.round(spend / leads * 100) / 100 : null }; })
    .sort((a, b) => b.spend - a.spend);
  const spend = campaigns.reduce((a, c) => a + c.spend, 0), leads = campaigns.reduce((a, c) => a + c.leads, 0);
  const data = { configured: true, campaigns, totals: { spend: Math.round(spend * 100) / 100, leads, cpl: leads ? Math.round(spend / leads * 100) / 100 : null } };
  _adsCache = { key, at: Date.now(), data };
  return data;
}

async function replySpeed(fromD, toD, pageId) {
  const q = { firstInboundAt: { $gte: fromD, $lte: toD } };
  if (pageId) q.pageId = pageId;
  const th = await SocialThread.find(q).select('firstInboundAt firstReplyAt pageId').lean();
  const mins = th.filter(t => t.firstReplyAt).map(t => (new Date(t.firstReplyAt) - new Date(t.firstInboundAt)) / 60000).filter(m => m >= 0);
  return { threads: th.length, answered: mins.length, medianMin: mins.length ? Math.round(median(mins)) : null };
}

// ══ RECURRING POSTS ═══════════════════════════════════════════
function nextOccurrence(rule, fromMs) {
  const [hh, mm] = String(rule.time || '19:00').split(':').map(Number);
  for (let k = 0; k < 8; k++) {
    const day = addDays(manilaDay(fromMs), k);
    const at = new Date(`${day}T${pad2(hh || 0)}:${pad2(mm || 0)}:00+08:00`);
    if (manilaParts(at).wd === Number(rule.weekday) && at.getTime() > fromMs) return { day, at };
  }
  return null;
}
async function pickListing(rule) {
  const used = new Set(rule.usedListings || []);
  const props = await findListingsLite({ status: 'available' }, ['title', 'location', 'price', 'monthlyRental', 'bedrooms', 'bathrooms', 'sqm', 'landArea', 'parking', 'floor', 'listingType', 'propertyType', 'description', 'webSummary', 'createdAt'], { sort: { createdAt: -1 }, limit: 300 });
  const ok = props.filter(p => [p.mainImage, ...(p.gallery || [])].some(u => httpsUrl(u)));
  return ok.find(p => !used.has(String(p._id))) || ok[0] || null;
}
// Makes the next occurrence's post (waiting for approval). force: now, whatever the lead time.
async function runRecurring(rule, force) {
  const occ = nextOccurrence(rule, Date.now() + (force ? 11 * 60e3 : 0));
  if (!occ) return null;
  if (!force && (occ.at.getTime() - Date.now() > (rule.leadDays || 2) * 864e5 || rule.lastRunFor === occ.day)) return null;
  if (rule.lastRunFor === occ.day) return { skipped: 'already drafted for ' + occ.day };
  const pages = await pagesState();
  const targets = (rule.targets || []).filter(t => pages.some(p => p.id === t.pageId)).map(t => ({ network: t.network === 'ig' ? 'ig' : 'fb', pageId: t.pageId, caption: '' }));
  if (!targets.length) return { error: 'No connected Page is chosen in this rule.' };
  let doc = { title: `${rule.name} · ${occ.day}`, caption: rule.caption || '', media: rule.media || [], link: rule.link || '', propertyId: '' };
  if (rule.mode === 'listing') {
    const p = await pickListing(rule);
    if (!p) return { error: 'No live listing with photos to feature.' };
    const s = studioFromListing(p, pages);
    doc = { title: `${rule.name}: ${s.title}`.slice(0, 200), caption: rule.caption ? fillTemplate(rule.caption, s.fill) : s.captionFb, media: s.media, link: s.link, propertyId: s.propertyId };
    targets.forEach(t => { const v = s.perPage[t.pageId]; if (v) t.caption = t.network === 'ig' ? v.ig : (rule.caption ? '' : v.fb); });
    await SocialRecurring.updateOne({ _id: rule._id }, { $push: { usedListings: { $each: [s.propertyId], $slice: -200 } } });
  }
  const post = await SocialPost.create({ ...doc, targets: targets.map(t => ({ ...t, status: 'draft' })), status: 'pending', scheduledAt: occ.at, recurringId: String(rule._id), batchId: `rec-${rule._id}-${occ.day}`,
    origin: 'recurring', createdBy: { id: '', name: 'Recurring: ' + rule.name, email: 'system', via: 'system' }, submittedAt: new Date(), history: [{ at: new Date(), by: 'GLRA Social', action: 'made by a recurring rule', note: rule.name }] });
  await SocialRecurring.updateOne({ _id: rule._id }, { $set: { lastRunFor: occ.day } });
  slog(SYSTEM_ACTOR, 'drafted', { target: 'post', targetId: post._id, summary: `Recurring "${rule.name}" made a post for ${occ.day} (waiting for approval)` });
  notifyApprovers([post]).catch(() => {});
  return { post };
}
function fillTemplate(text, fill) { return String(text || '').replace(/\{(property|price|area|link|page)\}/g, (m, k) => (fill && fill[k]) || m); }

// ══ CSV BULK ══════════════════════════════════════════════════
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}
async function csvToPosts(text) {
  const rows = parseCsv(text).slice(0, 201);
  if (!rows.length) return { posts: [], problems: ['The file is empty.'] };
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const col = n => head.indexOf(n);
  if (col('caption') < 0 || col('date') < 0) return { posts: [], problems: ['The first row must name the columns: date, time, pages, networks, caption, media, link.'] };
  const pages = await pagesState();
  const out = [];
  for (const [i, r] of rows.slice(1).entries()) {
    const get = n => col(n) >= 0 ? String(r[col(n)] || '').trim() : '';
    const problems = [];
    const date = get('date'), time = get('time') || '19:00';
    if (!isDay(date) || !/^\d{1,2}:\d{2}$/.test(time)) problems.push('date must be YYYY-MM-DD and time HH:MM');
    const when = parseWhen(`${date}T${time.padStart(5, '0')}`);
    const pageWords = (get('pages') || 'all').split(/[;|]/).map(x => x.trim().toLowerCase()).filter(Boolean);
    const chosen = pageWords.includes('all') ? pages : pages.filter(p => pageWords.some(w => w === p.id || p.name.toLowerCase().includes(w)));
    if (!chosen.length) problems.push('no matching Page');
    const nets = (get('networks') || 'fb').split(/[;|]/).map(x => x.trim().toLowerCase()).map(x => (x === 'instagram' ? 'ig' : x === 'facebook' ? 'fb' : x)).filter(x => x === 'fb' || x === 'ig');
    const media = get('media').split(/[;|\s]+/).filter(Boolean).map(url => ({ url, type: /\.(mp4|mov|m4v)(\?|$)/i.test(url) ? 'video' : 'image', width: 0, height: 0 }));
    const targets = [];
    chosen.forEach(p => nets.forEach(n => { if (n === 'fb' || p.igId) targets.push({ network: n, pageId: p.id, caption: '' }); }));
    const doc = { title: `CSV row ${i + 2}`, caption: clean(get('caption'), FB_CAPTION_MAX), link: get('link'), media: cleanMedia(media), targets, scheduledAt: when || null };
    const v = await validatePost(doc, false);
    if (when && when.getTime() < Date.now() + FB_MIN_AHEAD) problems.push('the time is less than 10 minutes away or has passed');
    out.push({ row: i + 2, doc, problems: [...problems, ...v.errors], warnings: v.warnings });
  }
  return { posts: out, problems: [] };
}

// ══ APPROVAL EMAILS (one-time links) ══════════════════════════
async function approvers() {
  const accs = await Account.find({ isActive: { $ne: false }, status: { $ne: 'pending' }, role: { $in: ['admin', 'employee'] } }).select('email name role permissions').lean();
  return accs.filter(a => a.role === 'admin' || (a.permissions && a.permissions.social_approve === true));
}
async function makeLink(kind, ref, accountId) {
  const t = crypto.randomBytes(24).toString('base64url');
  await SocialLinkToken.create({ hash: sha(t), kind, ref: String(ref), accountId: String(accountId), expiresAt: new Date(Date.now() + 72 * 3600e3) });
  return `${SITE_URL}/social-approve.html#t=${t}`;
}
// One email per approver listing what waits, each with its own link. Batches
// (CSV, recurring) arrive as one email.
async function notifyApprovers(posts, actions) {
  const s = await getSettings();
  if (!s.approvalEmails) return { skipped: true };
  const { sendEmail, esc } = _deps;
  const list = await approvers();
  const pages = await pagesState();
  const pname = id => (pages.find(p => p.id === id) || {}).name || id;
  let sent = 0;
  for (const a of list) {
    const items = [];
    for (const p of (posts || []).slice(0, 25)) items.push({ what: `Post: ${(p.title || p.caption || '').slice(0, 90)}`, where: [...new Set(p.targets.map(t => pname(t.pageId) + (t.network === 'ig' ? ' (Instagram)' : ' (Facebook)')))].join(', '),
      when: p.scheduledAt ? new Date(p.scheduledAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : 'as soon as approved', link: await makeLink('post', p._id, a._id) });
    for (const x of (actions || []).slice(0, 25)) items.push({ what: x.kind === 'reply' ? `Reply: ${clean(x.text, 120)}` : `${x.kind[0].toUpperCase() + x.kind.slice(1)} a comment`, where: pname(x.pageId), when: 'when approved', link: await makeLink('action', x._id, a._id) });
    if (!items.length) continue;
    const html = getEmailHeader() + `
      <h2 style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:20px;margin:0 0 6px">${items.length === 1 ? 'One item waits' : items.length + ' items wait'} for your approval</h2>
      <p style="font-size:13px;color:#555;margin:0 0 14px">GLRA Social. Each button opens a page where you can read it in full, then approve or send it back. Links work once and expire in 72 hours.</p>
      ${items.map(i => `<div style="border:1px solid #e6e2da;border-radius:12px;padding:12px 14px;margin:0 0 10px">
        <div style="font-weight:700;font-size:14px">${esc(i.what)}</div>
        <div style="font-size:12.5px;color:#555;margin:4px 0 10px">${esc(i.where)} · ${esc(i.when)}</div>
        <a href="${esc(i.link)}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:9px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">Review and approve</a></div>`).join('')}
      <p style="font-size:12px;color:#777">Or open <a href="${SITE_URL}/social.html#approvals">GLRA Social, Approvals</a>.</p>` + getEmailFooter();
    const r = await sendEmail(a.email, items.length === 1 ? `Approve: ${items[0].what.slice(0, 80)}` : `${items.length} social posts and replies wait for approval`, html).catch(() => null);
    if (r && r.success) sent++;
  }
  return { sent };
}
// Outstanding one-time links are voided (marked used) when what they point at
// changes: a post edited after it was sent for approval, or an account that is
// deactivated or loses social_approve (server.js calls voidLinksForAccount).
async function voidPostLinks(postId) {
  await SocialLinkToken.updateMany({ kind: 'post', ref: String(postId), usedAt: null }, { $set: { usedAt: new Date() } });
}
async function voidLinksForAccount(accountId) {
  if (!accountId) return;
  await SocialLinkToken.updateMany({ accountId: String(accountId), usedAt: null }, { $set: { usedAt: new Date() } });
}
// The version an approver looked at: the post's updatedAt in milliseconds.
// Every edit moves it, so an approval that sends back an older rev is refused.
const revOf = p => String(p && p.updatedAt ? new Date(p.updatedAt).getTime() : 0);

async function linkLookup(t) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(t || ''))) return { error: 'This link is not valid.', status: 400 };
  const row = await SocialLinkToken.findOne({ hash: sha(t) }).lean();
  if (!row) return { error: 'This link is not valid.', status: 404 };
  if (row.usedAt) return { error: 'This link has already been used.', status: 410 };
  if (new Date(row.expiresAt) < new Date()) return { error: 'This link has expired (72 hours). Open GLRA Social to approve.', status: 410 };
  // Read fresh (not the 30 s account cache): a link must die the moment its
  // owner is deactivated, demoted or loses social_approve.
  const acc = await Account.findById(row.accountId).select('email name role permissions isActive status').lean();
  const live = acc && acc.isActive !== false && acc.status !== 'pending';
  const perms = live ? await permsOf(String(acc._id), acc.role) : {};
  if (!live || !perms.approve) return { error: 'This account can no longer approve social posts.', status: 403 };
  return { row, actor: { id: String(acc._id), name: acc.name || acc.email, email: acc.email, via: 'email_link', role: acc.role } };
}

// ══ REVIEW FEED MASKING (module 6) ════════════════════════════
// RA 10173: the review needs content, not people. Names become initials,
// handles are shortened, phone numbers and emails disappear from text.
function maskName(n) {
  const s = String(n || '').trim();
  if (!s) return '';
  if (s.startsWith('@')) return '@' + s.slice(1, 2) + '***';
  return s.split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0].toUpperCase() + '.').join(' ');
}
function maskText(t) {
  return String(t || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(\+?\d[\d\s().-]{6,}\d)/g, m => (m.replace(/\D/g, '').length >= 7 ? '[phone]' : m));
}
const maskId = id => id ? 'u_' + sha('social-review|' + id).slice(0, 10) : '';

// ══ SERIALISERS ═══════════════════════════════════════════════
function postJson(p, pages, lmap) {
  const o = p.toObject ? p.toObject() : p;
  const leads = lmap && lmap[String(o._id)];
  return { ...o, _id: String(o._id), rev: revOf(o), targets: (o.targets || []).map(t => ({ ...t, _id: String(t._id), pageName: ((pages || []).find(x => x.id === t.pageId) || {}).name || t.pageId })),
    leads: leads ? { total: leads.total, byPage: leads.byPage } : { total: 0, byPage: {} } };
}

// ══ ROUTES ════════════════════════════════════════════════════
function registerSocialRoutes(app, deps) {
  _deps = { ..._deps, ...deps };
  const gate = (req, res, next) => SOCIAL_ON() ? next() : res.status(404).json({ error: 'Not found', disabled: true });
  const view = [gate, verifyToken, requirePermission('social_view')];
  const draft = [...view, requirePermission('social_draft')];
  const approve = [...view, requirePermission('social_approve')];
  const admin = [gate, verifyToken, requireAdmin];
  const B = '/api/admin/social';
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[social]', e); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong: ' + scrub(e.message).slice(0, 160) }); } };
  const aiLimiter = rateLimit({ windowMs: 15 * 60e3, max: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: req => 'ai:' + ((req.user && req.user.sub) || req.ip), message: { error: 'Too many AI requests; wait a few minutes.' } });
  const badKeyLimiter = rateLimit({ windowMs: 15 * 60e3, max: 30, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Too many requests' } });
  const linkLimiter = rateLimit({ windowMs: 15 * 60e3, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });
  const tmpDir = path.join(os.tmpdir(), 'glra-social-up');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* multer reports it */ }
  const mediaUpload = multer({ dest: tmpDir, limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 5 },
    fileFilter: (req, f, cb) => cb(null, /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime))$/i.test(f.mimetype)) });

  // ── me / overview ──
  app.get(B + '/me', ...view, wrap(async (req, res) => {
    const perms = await permsOf(req.user.sub, req.user.role);
    const s = await getSettings();
    const st = await getState();
    const pages = await pagesState();
    res.json({ user: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role }, perms, pages, settings: { unansweredHours: s.unansweredHours, approvalEmails: s.approvalEmails, weeklyEmail: s.weeklyEmail, reportEmails: perms.approve ? s.reportEmails : [] },
      ai: AI.configured(), cloudinary: !!(env('CLOUDINARY_CLOUD_NAME') && env('CLOUDINARY_API_KEY') && env('CLOUDINARY_API_SECRET')), tones: AI.TONE_KEYS, limits: { igCaption: IG_CAPTION_MAX, igHashtags: IG_HASHTAG_MAX, fbCaption: FB_CAPTION_MAX, media: MAX_MEDIA, fbMinAheadMin: 10, maxAheadDays: 75 },
      tokens: st.tokens || null, usage: G.usageState(), inboxStatus: st.inboxStatus || {}, lastInboxSyncAt: st.lastInboxSyncAt || null, switches: { inbox: INBOX_ON(), leads: LEADS_ON(), ads: !!AD_ACCOUNT() },
      webhookUrl: SITE_URL + '/api/meta/webhook', tags: TAGS });
  }));
  app.get(B + '/badge', ...view, wrap(async (req, res) => {
    const s = await getSettings();
    const [pp, pa, ths, st] = await Promise.all([SocialPost.countDocuments({ status: 'pending' }), SocialAction.countDocuments({ status: 'pending' }),
      SocialThread.find({ status: { $ne: 'done' }, lastInboundAt: { $ne: null } }).select('lastInboundAt lastOwnAt status').lean(), getState()]);
    const tok = st.tokens;
    res.json({ pending: pp + pa, unanswered: ths.filter(t => unanswered(t, s.unansweredHours)).length, tokenProblem: !!(tok && ((tok.system && !tok.system.ok) || Object.values(tok.pages || {}).some(p => !p.ok))) });
  }));
  app.post(B + '/pages/refresh', ...approve, wrap(async (req, res) => {
    await discoverPages();
    const tokens = await checkTokens(false);
    slog(actorOf(req), 'pages_checked', { target: 'page', summary: 'Pages re-read and tokens checked' });
    res.json({ pages: await pagesState(), tokens });
  }));
  app.post(B + '/pages/:pageNum/subscribe', ...admin, wrap(async (req, res) => {
    if (!pageIds().includes(String(req.params.pageNum))) return res.status(404).json({ error: 'Not one of the connected Pages' });
    try {
      const r = await subscribePageFields(String(req.params.pageNum));
      slog(actorOf(req), 'webhook_connected', { pageId: req.params.pageNum, target: 'page', summary: 'Page connected to the webhook: ' + r.fields.join(', ') });
      await logAudit(req, 'SOCIAL_SUBSCRIBE_PAGE', 'Social', String(req.params.pageNum), 'Page webhook subscription', r);
      res.json({ success: true, ...r });
    } catch (e) { res.status(502).json({ error: scrub(e.message).slice(0, 300) }); }
  }));

  // ── posts ──
  app.get(B + '/posts', ...view, wrap(async (req, res) => {
    const q = {};
    if (req.query.status) q.status = { $in: String(req.query.status).split(',').slice(0, 10) };
    if (/^\d{1,30}$/.test(String(req.query.pageId || ''))) q['targets.pageId'] = String(req.query.pageId);
    if (req.query.batchId) q.batchId = clean(req.query.batchId, 80);
    const posts = await SocialPost.find(q).sort({ updatedAt: -1 }).limit(Math.min(300, Number(req.query.limit) || 100));
    const pages = await pagesState(); const lmap = await leadsByPost();
    res.json({ posts: posts.map(p => postJson(p, pages, lmap)) });
  }));
  app.get(B + '/posts/:id', ...view, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const v = await validatePost(p, false);
    res.json({ post: postJson(p, await pagesState(), await leadsByPost()), check: v, log: await SocialLog.find({ targetId: String(p._id) }).sort({ at: -1 }).limit(50).lean() });
  }));
  // Validation without saving (the composer's live check).
  app.post(B + '/posts/check', ...draft, wrap(async (req, res) => {
    const b = req.body || {};
    const doc = { caption: clean(b.caption, FB_CAPTION_MAX), link: clean(b.link, 1000), media: cleanMedia(b.media), targets: cleanTargets(b.targets), scheduledAt: parseWhen(b.scheduledAt) || null };
    res.json(await validatePost(doc, !!b.strict));
  }));
  async function savePost(req, res, existing) {
    const b = req.body || {};
    const actor = actorOf(req);
    const perms = await permsOf(req.user.sub, req.user.role);
    const when = parseWhen(b.scheduledAt);
    if (when === undefined) return res.status(400).json({ error: 'The scheduled time could not be read.' });
    const doc = { title: clean(b.title, 200), caption: clean(b.caption, FB_CAPTION_MAX), link: clean(b.link, 1000), media: cleanMedia(b.media), targets: cleanTargets(b.targets).map(t => ({ ...t, status: 'draft' })),
      scheduledAt: when || null, propertyId: oid(b.propertyId) ? String(b.propertyId) : '' };
    const submit = b.submit === true || b.action === 'submit' || b.action === 'approve';
    const v = await validatePost(doc, false);
    if (submit && v.errors.length) return res.status(400).json({ error: v.errors[0], errors: v.errors, warnings: v.warnings });
    let p;
    if (existing) {
      if (!['draft', 'changes', 'pending'].includes(existing.status)) return res.status(409).json({ error: `A ${existing.status} post cannot be edited. Duplicate it instead.` });
      if (!perms.approve && existing.createdBy && existing.createdBy.id && existing.createdBy.id !== actor.id) return res.status(403).json({ error: 'Only the author or an approver can edit this post.' });
      // Edited while waiting for approval: whatever the approvers were sent is
      // now out of date. The post goes back to draft (or straight back into the
      // queue when this save re-submits it), the emailed links are voided, and a
      // re-submission mails fresh links for the new words.
      const wasPending = existing.status === 'pending';
      // The atomic swap guards against an approval landing between our read and
      // this save: it only matches the version we loaded.
      const loadedAt = existing.updatedAt;
      Object.assign(existing, doc, { updatedAt: new Date() });
      existing.history.push({ at: new Date(), by: actor.name, action: wasPending ? 'edited after submission' : 'edited', note: '' });
      if (wasPending) {
        const still = await SocialPost.findOneAndUpdate({ _id: existing._id, status: 'pending', updatedAt: loadedAt }, { $set: { status: 'draft', updatedAt: existing.updatedAt } });
        if (!still) return res.status(409).json({ error: 'This post was just approved or changed by someone else. Reload it first.' });
        await voidPostLinks(existing._id);
        existing.status = 'draft'; existing.approvedAt = null;
        if (!submit) existing.history.push({ at: new Date(), by: actor.name, action: 'back to draft (changed after submission)', note: '' });
      }
      p = existing;
    } else {
      p = new SocialPost({ ...doc, origin: ['listing', 'csv', 'compose'].includes(b.origin) ? b.origin : 'compose', createdBy: actor, history: [{ at: new Date(), by: actor.name, action: 'created', note: '' }] });
    }
    if (submit && p.status !== 'pending') { p.status = 'pending'; p.submittedAt = new Date(); p.reviewNote = ''; p.history.push({ at: new Date(), by: actor.name, action: 'submitted for approval', note: '' }); }
    await p.save();
    slog(actor, existing ? 'edited' : 'drafted', { target: 'post', targetId: p._id, summary: (p.title || p.caption || '').slice(0, 120) });
    if (submit) slog(actor, 'submitted', { target: 'post', targetId: p._id, summary: 'Waiting for approval' });
    // "Approve & publish" from the composer: the same server-side approval, so only social_approve gets past here.
    if (b.action === 'approve') {
      if (!perms.approve) return res.status(403).json({ error: "You don't have permission to approve posts (social_approve). It is waiting for approval.", post: postJson(p, await pagesState()) });
      const r = await approvePost(p._id, actor, req);
      if (r.status !== 200) return res.status(r.status).json({ error: r.error, errors: r.errors, post: postJson(await SocialPost.findById(p._id), await pagesState()) });
      return res.json({ post: postJson(r.post, await pagesState()), warnings: r.warnings });
    }
    if (submit) notifyApprovers([p]).catch(() => {});
    res.json({ post: postJson(p, await pagesState()), warnings: v.warnings, errors: v.errors });
  }
  app.post(B + '/posts', ...draft, wrap((req, res) => savePost(req, res, null)));
  app.put(B + '/posts/:id', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    return savePost(req, res, p);
  }));
  app.post(B + '/posts/:id/submit', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id);
    if (!p || !['draft', 'changes'].includes(p.status)) return res.status(409).json({ error: 'Only a draft can be submitted.' });
    const v = await validatePost(p, false);
    if (v.errors.length) return res.status(400).json({ error: v.errors[0], errors: v.errors });
    p.status = 'pending'; p.submittedAt = new Date(); p.history.push({ at: new Date(), by: actorOf(req).name, action: 'submitted for approval', note: '' }); p.updatedAt = new Date();
    await p.save();
    await voidPostLinks(p._id);   // only the links mailed below are good for this version
    slog(actorOf(req), 'submitted', { target: 'post', targetId: p._id, summary: 'Waiting for approval' });
    notifyApprovers([p]).catch(() => {});
    res.json({ post: postJson(p, await pagesState()) });
  }));
  app.delete(B + '/posts/:id', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const perms = await permsOf(req.user.sub, req.user.role);
    if (!['draft', 'changes', 'pending', 'failed', 'cancelled'].includes(p.status) || p.targets.some(t => t.metaId && t.status !== 'cancelled')) return res.status(409).json({ error: 'This post is on a Page already. Use "Delete from Facebook" (approvers) instead.' });
    if (!perms.approve && p.createdBy && p.createdBy.id !== actorOf(req).id) return res.status(403).json({ error: 'Only the author or an approver can discard this post.' });
    await SocialPost.deleteOne({ _id: p._id });
    slog(actorOf(req), 'discarded', { target: 'post', targetId: p._id, summary: (p.title || p.caption || '').slice(0, 120) });
    res.json({ success: true });
  }));
  app.post(B + '/posts/:id/duplicate', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id).lean();
    if (!p) return res.status(404).json({ error: 'Not found' });
    const n = await SocialPost.create({ title: (p.title ? p.title + ' (copy)' : ''), caption: p.caption, link: p.link, media: p.media, targets: p.targets.map(t => ({ network: t.network, pageId: t.pageId, caption: t.caption, status: 'draft' })),
      propertyId: p.propertyId, origin: p.origin, createdBy: actorOf(req), history: [{ at: new Date(), by: actorOf(req).name, action: 'duplicated', note: String(p._id) }] });
    slog(actorOf(req), 'drafted', { target: 'post', targetId: n._id, summary: 'Duplicated a post' });
    res.json({ post: postJson(n, await pagesState()) });
  }));
  // Failed targets go back to "waiting for approval": a retry is approved again.
  app.post(B + '/posts/:id/retry', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id);
    if (!p || !p.targets.some(t => t.status === 'failed')) return res.status(409).json({ error: 'Nothing failed on this post.' });
    const unknown = p.targets.some(t => t.status === 'failed' && t.unknown);
    p.targets.forEach(t => { if (t.status === 'failed') { t.status = 'draft'; } });
    if (p.scheduledAt && new Date(p.scheduledAt) < new Date(Date.now() + FB_MIN_AHEAD)) p.scheduledAt = null;
    p.status = 'pending'; p.submittedAt = new Date(); p.approvedAt = null; p.updatedAt = new Date();
    p.history.push({ at: new Date(), by: actorOf(req).name, action: 'retry requested', note: '' });
    await p.save();
    await voidPostLinks(p._id);
    slog(actorOf(req), 'retry_requested', { target: 'post', targetId: p._id, summary: 'Failed targets sent back for approval' + (unknown ? ' (one may have reached Meta: check the Page first)' : '') });
    notifyApprovers([p]).catch(() => {});
    res.json({ post: postJson(p, await pagesState()), warning: unknown ? 'One of the failed attempts may have reached Meta. Check the Page before approving the retry.' : '' });
  }));
  app.post(B + '/posts/:id/approve', ...approve, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await approvePost(req.params.id, actorOf(req), req, (req.body || {}).rev);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error, errors: r.errors, changed: !!r.changed });
    res.json({ post: postJson(r.post, await pagesState()), warnings: r.warnings });
  }));
  app.post(B + '/posts/:id/reject', ...approve, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await rejectPost(req.params.id, actorOf(req), (req.body || {}).note, req);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error });
    res.json({ post: postJson(r.post, await pagesState()) });
  }));
  app.post(B + '/posts/approve-batch', ...approve, wrap(async (req, res) => {
    const b = req.body || {};
    const q = b.batchId ? { batchId: clean(b.batchId, 80), status: 'pending' } : { _id: { $in: (Array.isArray(b.ids) ? b.ids : []).filter(oid).slice(0, 200) }, status: 'pending' };
    const ids = (await SocialPost.find(q).select('_id').limit(200).lean()).map(x => x._id);
    const results = [];
    // revs: { postId: rev } as shown on screen; a post changed since is refused.
    const revs = b.revs && typeof b.revs === 'object' ? b.revs : {};
    for (const id of ids) { const r = await approvePost(id, actorOf(req), req, revs[String(id)]); results.push({ id: String(id), ok: r.status === 200, error: r.error || '', status: r.post ? r.post.status : '' }); }
    slog(actorOf(req), 'batch_approved', { target: 'post', targetId: b.batchId || '', summary: `Approved ${results.filter(r => r.ok).length} of ${results.length} in one click` });
    res.json({ results });
  }));
  // Cancel before it is out: FB scheduled posts are deleted from Facebook's scheduler.
  app.post(B + '/posts/:id/cancel', ...approve, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const errs = [];
    for (const t of p.targets) {
      if (t.status === 'waiting' || t.status === 'draft') { t.status = 'cancelled'; continue; }
      if (t.status === 'scheduled' && t.network === 'fb' && t.metaId) {
        try { await metaWrite('DELETE', t.metaId, {}, { token: await pageTokenFor(t.pageId, { strict: true, area: 'social' }), area: 'social' }); t.status = 'cancelled'; }
        catch (e) { errs.push(scrub(e.message).slice(0, 200)); }
      }
    }
    p.status = rollup(p); if (['pending', 'draft', 'changes', 'approved'].includes(p.status) && p.targets.every(t => ['cancelled', 'draft'].includes(t.status))) p.status = 'cancelled';
    p.updatedAt = new Date(); p.history.push({ at: new Date(), by: actorOf(req).name, action: 'cancelled', note: errs.join('; ') });
    await p.save();
    slog(actorOf(req), 'cancelled', { target: 'post', targetId: p._id, summary: 'Cancelled' + (errs.length ? ' (with errors: ' + errs.join('; ') + ')' : ''), ok: !errs.length });
    await logAudit(req, 'SOCIAL_CANCEL', 'SocialPost', String(p._id), (p.title || p.caption || '').slice(0, 80), { errors: errs });
    res.status(errs.length ? 502 : 200).json({ post: postJson(p, await pagesState()), errors: errs });
  }));
  app.post(B + '/posts/:id/delete-remote', ...approve, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await SocialPost.findById(req.params.id);
    const t = p && p.targets.id(String((req.body || {}).targetId || ''));
    if (!t || t.status !== 'published' || !t.metaId) return res.status(404).json({ error: 'No published post to delete.' });
    if (t.network === 'ig') return res.status(400).json({ error: "Instagram's API cannot delete a published post. Delete it in the Instagram app, then it disappears here at the next check." });
    try {
      await metaWrite('DELETE', t.metaId, {}, { token: await pageTokenFor(t.pageId, { strict: true, area: 'social' }), area: 'social' });
      t.status = 'cancelled'; t.error = 'Deleted from Facebook by ' + actorOf(req).name;
      p.status = rollup(p); p.updatedAt = new Date(); await p.save();
      await SocialPostStat.deleteOne({ metaId: t.metaId });
      slog(actorOf(req), 'deleted', { pageId: t.pageId, network: 'fb', target: 'post', targetId: p._id, metaId: t.metaId, summary: 'Deleted the post from Facebook' });
      await logAudit(req, 'SOCIAL_DELETE_POST', 'SocialPost', String(p._id), (p.title || p.caption || '').slice(0, 80), { metaId: t.metaId, pageId: t.pageId });
      res.json({ post: postJson(p, await pagesState()) });
    } catch (e) { res.status(502).json({ error: scrub(e.message).slice(0, 300) }); }
  }));

  // ── calendar ──
  app.get(B + '/calendar', ...view, wrap(async (req, res) => {
    const from = parseWhen(req.query.from) || new Date(Date.now() - 31 * 864e5), to = parseWhen(req.query.to) || new Date(Date.now() + 62 * 864e5);
    const pages = await pagesState();
    const pid = /^\d{1,30}$/.test(String(req.query.pageId || '')) ? String(req.query.pageId) : '';
    const q = { $or: [{ scheduledAt: { $gte: from, $lte: to } }, { 'targets.publishedAt': { $gte: from, $lte: to } }, { scheduledAt: null, status: { $in: ['pending', 'approved', 'publishing', 'failed', 'draft', 'changes'] }, updatedAt: { $gte: from, $lte: to } }] };
    if (pid) q['targets.pageId'] = pid;
    const posts = await SocialPost.find(q).limit(500).lean();
    const items = posts.map(p => {
      const pub = (p.targets || []).map(t => t.publishedAt).filter(Boolean).sort((a, b) => a - b)[0];
      return { id: String(p._id), kind: 'post', status: p.status, when: p.scheduledAt || pub || p.updatedAt, title: p.title || clean(p.caption, 80), pages: [...new Set((p.targets || []).map(t => t.pageId))],
        networks: [...new Set((p.targets || []).map(t => t.network))], thumb: (p.media[0] || {}).url || '', failed: (p.targets || []).filter(t => t.status === 'failed').map(t => t.error) };
    });
    const outside = await SocialPostStat.find({ postRef: '', at: { $gte: from, $lte: to }, ...(pid ? { pageId: pid } : {}) }).limit(300).lean();
    outside.forEach(s => items.push({ id: s.metaId, kind: 'external', status: 'published', when: s.at, title: clean(s.text, 80) || '(no text)', pages: [s.pageId], networks: [s.network], thumb: s.thumb, link: s.permalink }));
    res.json({ items, pages: pages.map(p => ({ id: p.id, name: p.name, color: p.color })) });
  }));

  // ── templates, saved replies, hashtag sets ──
  app.get(B + '/templates', ...view, wrap(async (req, res) => {
    const q = {}; if (['caption', 'reply', 'hashtags'].includes(req.query.kind)) q.kind = req.query.kind;
    res.json({ templates: await SocialTemplate.find(q).sort({ kind: 1, name: 1 }).limit(500).lean() });
  }));
  app.post(B + '/templates', ...draft, wrap(async (req, res) => {
    const b = req.body || {};
    if (!['caption', 'reply', 'hashtags'].includes(b.kind)) return res.status(400).json({ error: 'kind must be caption, reply or hashtags' });
    const name = clean(b.name, 120), text = clean(b.text, 5000);
    if (!name || !text) return res.status(400).json({ error: 'A name and the text are both needed.' });
    if (b.kind === 'hashtags' && hashtagsIn(text) > IG_HASHTAG_MAX) return res.status(400).json({ error: `A hashtag set can have at most ${IG_HASHTAG_MAX} hashtags (Instagram's limit).` });
    const t = await SocialTemplate.create({ kind: b.kind, name, text, pageId: /^\d{1,30}$/.test(String(b.pageId || '')) ? String(b.pageId) : '', topic: clean(b.topic, 60), createdBy: req.user.email });
    slog(actorOf(req), 'template_saved', { target: 'template', targetId: t._id, summary: `${b.kind}: ${name}` });
    res.json({ template: t });
  }));
  app.put(B + '/templates/:id', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const t = await SocialTemplate.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (b.name !== undefined) t.name = clean(b.name, 120) || t.name;
    if (b.text !== undefined) t.text = clean(b.text, 5000) || t.text;
    if (b.topic !== undefined) t.topic = clean(b.topic, 60);
    if (b.pageId !== undefined) t.pageId = /^\d{1,30}$/.test(String(b.pageId || '')) ? String(b.pageId) : '';
    if (t.kind === 'hashtags' && hashtagsIn(t.text) > IG_HASHTAG_MAX) return res.status(400).json({ error: `At most ${IG_HASHTAG_MAX} hashtags.` });
    t.updatedAt = new Date(); await t.save();
    slog(actorOf(req), 'template_saved', { target: 'template', targetId: t._id, summary: `${t.kind}: ${t.name}` });
    res.json({ template: t });
  }));
  app.delete(B + '/templates/:id', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const t = await SocialTemplate.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const perms = await permsOf(req.user.sub, req.user.role);
    if (!perms.approve && t.createdBy !== req.user.email) return res.status(403).json({ error: 'Only its author or an approver can delete it.' });
    await SocialTemplate.deleteOne({ _id: t._id });
    slog(actorOf(req), 'template_deleted', { target: 'template', targetId: t._id, summary: `${t.kind}: ${t.name}` });
    res.json({ success: true });
  }));

  // ── listings (studio) ──
  app.get(B + '/listings', ...draft, wrap(async (req, res) => {
    const q = { status: 'available' };
    const s = clean(req.query.q, 80);
    if (s) q.$or = [{ title: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { location: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    const rows = (await findListingsLite(q, ['title', 'location', 'price', 'monthlyRental', 'listingType', 'propertyType', 'createdAt'], { sort: { createdAt: -1 }, limit: 60 })).map(applyWebsiteCover);
    res.json({ listings: rows.map(p => ({ id: String(p._id), title: p.title, location: p.location, price: /lease|rent/i.test(p.listingType || '') ? (p.monthlyRental ? peso(p.monthlyRental) + '/mo' : '') : (p.price ? peso(p.price) : ''), type: p.propertyType, listingType: p.listingType,
      thumb: httpsUrl(p.mainImage) ? p.mainImage : '', photos: [p.mainImage, ...(p.gallery || [])].filter(httpsUrl).length })) });
  }));
  app.get(B + '/listings/:id/studio', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await findListingLiteById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const pages = await pagesState();
    const want = String(req.query.pageId || '').split(',').filter(Boolean);
    const chosen = pages.filter(x => !want.length || want.includes(x.id));
    res.json(studioFromListing(p, chosen.length ? chosen : pages));
  }));

  // ── AI ──
  app.post(B + '/ai/caption', ...draft, aiLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    let facts = clean(b.facts, 2500);
    if (oid(b.propertyId)) { const p = await findListingLiteById(b.propertyId); if (p) { const f = listingFacts(applyWebsiteCover({ ...p })); facts = [`Title: ${f.title}`, f.area && `Location: ${f.area}`, f.type && `Type: ${f.type}`, f.price && `Price: ${f.price}`, f.bits.join(', '), f.summary, `Link: ${SITE_URL}/property/${p._id}`].filter(Boolean).join('\n'); } }
    const pg = await pageById(b.pageId);
    try {
      const r = await AI.writeCaption({ brief: b.brief, tone: b.tone, facts, pageName: pg && pg.name });
      slog(actorOf(req), 'ai_caption', { pageId: pg ? pg.id : '', target: 'post', summary: `AI caption (${r.tone}) written as a draft` });
      res.json({ ...r, draftOnly: true });
    } catch (e) { res.status(e.code === 'no_ai' ? 503 : 502).json({ error: e.message, code: e.code || '' }); }
  }));
  app.post(B + '/ai/reply', ...draft, aiLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const th = await SocialThread.findOne({ key: String(b.threadKey || '') }).lean();
    if (!th) return res.status(404).json({ error: 'Conversation not found' });
    const items = await SocialItem.find({ threadKey: th.key, deleted: { $ne: true } }).sort({ at: 1 }).limit(30).lean();
    const saved = await SocialTemplate.find({ kind: 'reply' }).limit(20).lean();
    const pg = await pageById(th.pageId);
    try {
      const r = await AI.suggestReply({ thread: items.map(i => ({ own: i.own, text: maskText(i.text) })), savedReplies: saved, tone: b.tone, pageName: pg && pg.name });
      slog(actorOf(req), 'ai_reply', { pageId: th.pageId, target: 'thread', targetId: th.key, summary: 'AI reply suggestion (draft only)' });
      res.json({ ...r, draftOnly: true, window: windowOf(th) });
    } catch (e) { res.status(e.code === 'no_ai' ? 503 : 502).json({ error: e.message, code: e.code || '' }); }
  }));

  // ── media library ──
  app.get(B + '/media', ...view, wrap(async (req, res) => {
    const rows = await SocialMedia.find().sort({ createdAt: -1 }).limit(300).lean();
    res.json({ media: rows.map(m => ({ ...m, ig: igRatio(m) })), cloudinary: !!(env('CLOUDINARY_CLOUD_NAME') && env('CLOUDINARY_API_KEY') && env('CLOUDINARY_API_SECRET')) });
  }));
  app.post(B + '/media/upload', ...draft, (req, res, next) => mediaUpload.single('file')(req, res, err => { if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be at most 100 MB.' : 'Upload failed: ' + err.message }); next(); }), wrap(async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'Choose a JPEG, PNG, WEBP or HEIC photo, or an MP4 / MOV video.' });
    const cleanup = () => fs.promises.unlink(f.path).catch(() => {});
    const cl = _deps.cloudinary;
    if (!cl || !(env('CLOUDINARY_CLOUD_NAME') && env('CLOUDINARY_API_KEY') && env('CLOUDINARY_API_SECRET'))) { cleanup(); return res.status(503).json({ error: 'Cloudinary is not configured, so files cannot be uploaded here. Add a public https link instead.' }); }
    const isVid = /^video\//.test(f.mimetype);
    try {
      const r = await cl.uploader.upload(f.path, { folder: 'glra-social', resource_type: isVid ? 'video' : 'image', ...(isVid ? {} : { transformation: [{ width: 2400, height: 2400, crop: 'limit' }, { quality: 'auto:good' }], format: 'jpg' }) });
      const m = await SocialMedia.create({ url: r.secure_url, publicId: r.public_id, type: isVid ? 'video' : 'image', width: r.width || 0, height: r.height || 0, bytes: r.bytes || 0, format: r.format || '', name: clean(f.originalname, 200), createdBy: req.user.email });
      slog(actorOf(req), 'media_added', { target: 'media', targetId: m._id, summary: `Uploaded ${m.name} (${m.width}x${m.height})` });
      res.json({ media: { ...m.toObject(), ig: igRatio(m) } });
    } catch (e) { res.status(502).json({ error: 'Cloudinary upload failed: ' + scrub(e.message).slice(0, 200) }); }
    finally { cleanup(); }
  }));
  app.post(B + '/media/url', ...draft, wrap(async (req, res) => {
    const b = req.body || {};
    if (!httpsUrl(b.url)) return res.status(400).json({ error: 'The link must be a public https address.' });
    const exists = await SocialMedia.findOne({ url: b.url }).lean();
    if (exists) return res.json({ media: { ...exists, ig: igRatio(exists) }, existed: true });
    const m = await SocialMedia.create({ url: String(b.url).slice(0, 1000), type: b.type === 'video' ? 'video' : 'image', width: Math.round(num(b.width) || 0), height: Math.round(num(b.height) || 0), name: clean(b.name, 200) || String(b.url).split('/').pop().slice(0, 120), createdBy: req.user.email });
    slog(actorOf(req), 'media_added', { target: 'media', targetId: m._id, summary: 'Added a link: ' + m.name });
    res.json({ media: { ...m.toObject(), ig: igRatio(m) } });
  }));
  app.delete(B + '/media/:id', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const m = await SocialMedia.findById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const perms = await permsOf(req.user.sub, req.user.role);
    if (!perms.approve && m.createdBy !== req.user.email) return res.status(403).json({ error: 'Only the person who added it or an approver can remove it.' });
    await SocialMedia.deleteOne({ _id: m._id });   // the file stays on Cloudinary: posts may still use it
    slog(actorOf(req), 'media_removed', { target: 'media', targetId: m._id, summary: 'Removed from the library: ' + m.name });
    res.json({ success: true });
  }));

  // ── recurring ──
  app.get(B + '/recurring', ...view, wrap(async (req, res) => {
    const rules = await SocialRecurring.find().sort({ createdAt: -1 }).lean();
    res.json({ rules: rules.map(r => { const n = nextOccurrence(r, Date.now()); return { ...r, next: n ? n.at : null }; }) });
  }));
  async function saveRule(req, res, rule) {
    const b = req.body || {};
    const name = clean(b.name, 120);
    if (!name) return res.status(400).json({ error: 'Give the rule a name.' });
    const wd = Number(b.weekday);
    if (!(wd >= 0 && wd <= 6) || !/^\d{2}:\d{2}$/.test(String(b.time || ''))) return res.status(400).json({ error: 'Choose a weekday and a time (HH:MM).' });
    const targets = cleanTargets(b.targets).map(t => ({ network: t.network, pageId: t.pageId }));
    if (!targets.length) return res.status(400).json({ error: 'Choose at least one Page.' });
    const mode = b.mode === 'listing' ? 'listing' : 'text';
    if (mode === 'text' && !clean(b.caption, 5000)) return res.status(400).json({ error: 'Write the caption (or choose "Listing of the week").' });
    const doc = { name, mode, caption: clean(b.caption, 5000), media: cleanMedia(b.media).map(m => ({ url: m.url, type: m.type, width: m.width, height: m.height })), link: httpsUrl(b.link) ? String(b.link) : '',
      targets, weekday: wd, time: String(b.time), leadDays: Math.max(1, Math.min(6, Number(b.leadDays) || 2)), active: b.active !== false };
    const r = rule ? Object.assign(rule, doc) : new SocialRecurring({ ...doc, createdBy: req.user.email });
    await r.save();
    slog(actorOf(req), 'recurring_saved', { target: 'recurring', targetId: r._id, summary: `${name}: every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd]} ${doc.time}` });
    res.json({ rule: r });
  }
  // A drafter may change or delete only their own rules; approvers any rule.
  // (A rule drafts posts on a timer, so someone else's rule is not theirs to rewrite.)
  async function mayTouchRule(req, rule) {
    const perms = await permsOf(req.user.sub, req.user.role);
    if (perms.approve) return true;
    return !!rule.createdBy && String(rule.createdBy).toLowerCase() === String(req.user.email || '').toLowerCase();
  }
  app.post(B + '/recurring', ...draft, wrap((req, res) => saveRule(req, res, null)));
  app.put(B + '/recurring/:id', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await SocialRecurring.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (!(await mayTouchRule(req, r))) return res.status(403).json({ error: 'Only the person who made this rule, or an approver, can change it.' });
    return saveRule(req, res, r);
  }));
  app.delete(B + '/recurring/:id', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const cur = await SocialRecurring.findById(req.params.id).lean();
    if (!cur) return res.json({ success: true });
    if (!(await mayTouchRule(req, cur))) return res.status(403).json({ error: 'Only the person who made this rule, or an approver, can delete it.' });
    const r = await SocialRecurring.findByIdAndDelete(req.params.id);
    if (r) slog(actorOf(req), 'recurring_deleted', { target: 'recurring', targetId: r._id, summary: r.name });
    res.json({ success: true });
  }));
  app.post(B + '/recurring/:id/run', ...draft, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await SocialRecurring.findById(req.params.id).lean();
    if (!r) return res.status(404).json({ error: 'Not found' });
    const out = await runRecurring(r, true);
    if (!out || out.error) return res.status(400).json({ error: (out && out.error) || 'No occurrence in the next week.' });
    if (out.skipped) return res.status(409).json({ error: 'The next one (' + out.skipped.replace('already drafted for ', '') + ') is already drafted.' });
    res.json({ post: postJson(out.post, await pagesState()) });
  }));

  // ── CSV bulk ──
  app.post(B + '/bulk', ...draft, wrap(async (req, res) => {
    const b = req.body || {};
    const text = String(b.csv || '');
    if (text.length > 400000) return res.status(413).json({ error: 'The file is too big (200 rows at most).' });
    const parsed = await csvToPosts(text);
    if (parsed.problems.length) return res.status(400).json({ error: parsed.problems[0] });
    if (!b.commit) return res.json({ preview: parsed.posts.map(p => ({ row: p.row, when: p.doc.scheduledAt, targets: p.doc.targets, caption: p.doc.caption.slice(0, 200), media: p.doc.media.length, problems: p.problems, warnings: p.warnings })) });
    const bad = parsed.posts.filter(p => p.problems.length);
    if (bad.length) return res.status(400).json({ error: `Row ${bad[0].row}: ${bad[0].problems[0]}`, rows: bad.map(p => ({ row: p.row, problems: p.problems })) });
    const batchId = 'csv-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const actor = actorOf(req);
    const created = [];
    for (const p of parsed.posts) created.push(await SocialPost.create({ ...p.doc, targets: p.doc.targets.map(t => ({ ...t, status: 'draft' })), status: 'pending', submittedAt: new Date(), batchId, origin: 'csv', createdBy: actor, history: [{ at: new Date(), by: actor.name, action: 'imported from CSV', note: '' }] }));
    slog(actor, 'bulk_imported', { target: 'post', targetId: batchId, summary: `${created.length} posts from a CSV, waiting for approval` });
    notifyApprovers(created).catch(() => {});
    res.json({ batchId, created: created.length });
  }));

  // ── approvals ──
  app.get(B + '/approvals', ...view, wrap(async (req, res) => {
    const pages = await pagesState();
    const [posts, actions] = await Promise.all([SocialPost.find({ status: 'pending' }).sort({ submittedAt: 1 }).limit(200), SocialAction.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200).lean()]);
    const thKeys = [...new Set(actions.map(a => a.threadKey))];
    const threads = await SocialThread.find({ key: { $in: thKeys } }).lean();
    const itemIds = actions.map(a => a.itemId).filter(oid);
    const items = await SocialItem.find({ _id: { $in: itemIds } }).lean();
    const checks = {};
    for (const p of posts) checks[p._id] = await validatePost(p, true);
    res.json({ posts: posts.map(p => ({ ...postJson(p, pages), check: checks[p._id] })),
      actions: actions.map(a => { const th = threads.find(t => t.key === a.threadKey) || {}; const it = items.find(i => String(i._id) === a.itemId); return { ...a, _id: String(a._id), thread: { key: th.key, kind: th.kind, name: th.name, snippet: th.snippet, pageId: th.pageId, window: windowOf(th) }, item: it ? { text: it.text, fromName: it.fromName, hidden: it.hidden } : null }; }),
      batches: Object.entries(posts.reduce((m, p) => { if (p.batchId) m[p.batchId] = (m[p.batchId] || 0) + 1; return m; }, {})).map(([id, n]) => ({ id, n })) });
  }));

  // ── inbox ──
  app.get(B + '/inbox', ...view, wrap(async (req, res) => {
    const s = await getSettings();
    const q = {};
    if (/^\d{1,30}$/.test(String(req.query.pageId || ''))) q.pageId = String(req.query.pageId);
    if (KINDS.includes(req.query.kind)) q.kind = req.query.kind;
    if (TAGS.includes(req.query.tag)) q.$or = [{ tags: req.query.tag }, { autoTags: req.query.tag }];
    if (req.query.assigned === 'me') q['assignedTo.id'] = req.user.sub;
    if (req.query.status === 'done') q.status = 'done'; else if (req.query.status !== 'all') q.status = { $ne: 'done' };
    let rows = await SocialThread.find(q).sort({ lastAt: -1 }).limit(300).lean();
    if (req.query.status === 'unanswered') rows = rows.filter(t => waitingReply(t));
    const pend = await SocialAction.find({ status: 'pending', threadKey: { $in: rows.map(r => r.key) } }).select('threadKey kind').lean();
    res.json({ threads: rows.map(t => ({ ...t, _id: undefined, window: windowOf(t), waiting: waitingReply(t), unanswered: unanswered(t, s.unansweredHours),
      ageMin: t.lastInboundAt ? Math.round((Date.now() - new Date(t.lastInboundAt)) / 60000) : null, pending: pend.filter(p => p.threadKey === t.key).length })), unansweredHours: s.unansweredHours });
  }));
  app.get(B + '/inbox/summary', ...view, wrap(async (req, res) => {
    const s = await getSettings();
    const pages = await pagesState();
    const open = await SocialThread.find({ status: { $ne: 'done' } }).select('pageId kind lastInboundAt lastOwnAt status').lean();
    const since = new Date(Date.now() - 30 * 864e5);
    const out = [];
    for (const pg of pages) {
      const mine = open.filter(t => t.pageId === pg.id);
      const waiting = mine.filter(waitingReply);
      const late = mine.filter(t => unanswered(t, s.unansweredHours));
      const oldest = waiting.map(t => new Date(t.lastInboundAt).getTime()).sort((a, b) => a - b)[0];
      out.push({ pageId: pg.id, name: pg.name, color: pg.color, open: mine.length, waiting: waiting.length, unanswered: late.length, oldestMin: oldest ? Math.round((Date.now() - oldest) / 60000) : null,
        byKind: KINDS.reduce((m, k) => { m[k] = waiting.filter(t => t.kind === k).length; return m; }, {}), speed: await replySpeed(since, new Date(), pg.id) });
    }
    res.json({ pages: out, unansweredHours: s.unansweredHours });
  }));
  app.get(B + '/inbox/thread', ...view, wrap(async (req, res) => {
    const th = await SocialThread.findOne({ key: String(req.query.key || '') }).lean();
    if (!th) return res.status(404).json({ error: 'Not found' });
    const s = await getSettings();
    const [items, actions] = await Promise.all([SocialItem.find({ threadKey: th.key }).sort({ at: 1 }).limit(300).lean(), SocialAction.find({ threadKey: th.key }).sort({ createdAt: -1 }).limit(50).lean()]);
    let lead = null;
    const perms = await permsOf(req.user.sub, req.user.role);
    if (th.userId && ['messenger', 'ig_dm'].includes(th.kind)) { const l = await Lead.findOne({ metaIds: (th.kind === 'ig_dm' ? 'ig:' : 'fb:') + th.userId }).select('_id name stage').lean(); if (l) lead = { id: String(l._id), name: l.name, stage: l.stage }; }
    res.json({ thread: { ...th, window: windowOf(th), waiting: waitingReply(th), unanswered: unanswered(th, s.unansweredHours) }, items, actions, lead, perms });
  }));
  app.patch(B + '/inbox/thread', ...draft, wrap(async (req, res) => {
    const b = req.body || {};
    const th = await SocialThread.findOne({ key: String(b.key || '') });
    if (!th) return res.status(404).json({ error: 'Not found' });
    const changes = [];
    if (Array.isArray(b.tags)) { th.tags = [...new Set(b.tags.filter(t => TAGS.includes(t)))]; changes.push('tags: ' + th.tags.join(', ')); }
    if (b.status === 'done' || b.status === 'open') { th.status = b.status; changes.push('marked ' + b.status); }
    if (b.assignTo !== undefined) {
      if (!b.assignTo) { th.assignedTo = { id: '', name: '' }; changes.push('unassigned'); }
      else if (oid(b.assignTo)) { const a = await Account.findById(b.assignTo).select('name email').lean(); if (!a) return res.status(400).json({ error: 'Unknown staff member' }); th.assignedTo = { id: String(a._id), name: a.name || a.email }; changes.push('assigned to ' + th.assignedTo.name); }
    }
    th.updatedAt = new Date(); await th.save();
    slog(actorOf(req), 'thread_updated', { pageId: th.pageId, target: 'thread', targetId: th.key, summary: changes.join('; ') });
    res.json({ thread: th });
  }));
  app.get(B + '/staff', ...draft, wrap(async (req, res) => {
    const accs = await Account.find({ isActive: { $ne: false }, status: { $ne: 'pending' }, role: { $in: ['admin', 'employee'] } }).select('name email role permissions').lean();
    res.json({ staff: accs.filter(a => a.role === 'admin' || (a.permissions && a.permissions.social_view)).map(a => ({ id: String(a._id), name: a.name || a.email })) });
  }));
  // Draft an action; an approver may send it at once (still the approval path).
  app.post(B + '/inbox/actions', ...draft, wrap(async (req, res) => {
    const b = req.body || {};
    const actor = actorOf(req);
    const perms = await permsOf(req.user.sub, req.user.role);
    if (b.sendNow && !perms.approve) return res.status(403).json({ error: "You don't have permission to send, hide or delete (social_approve). Save it for approval instead." });
    const r = await createAction({ itemId: b.itemId, threadKey: b.threadKey, kind: b.kind, text: b.text }, actor);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error, window: r.window });
    if (b.sendNow) {
      const x = await executeAction(r.action._id, actor, req);
      if (x.status !== 200) return res.status(x.status).json({ error: x.error, unknown: x.unknown });
      return res.json({ done: true, metaId: x.metaId || '' });
    }
    notifyApprovers([], [r.action]).catch(() => {});
    res.json({ action: r.action, waiting: true });
  }));
  app.post(B + '/actions/:id/approve', ...approve, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const actor = actorOf(req);
    slog(actor, 'approved', { target: 'action', targetId: req.params.id, summary: 'Approved an inbox action' });
    const r = await executeAction(req.params.id, actor, req);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error, unknown: r.unknown });
    res.json({ done: true, metaId: r.metaId || '' });
  }));
  app.post(B + '/actions/:id/reject', ...approve, wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await rejectAction(req.params.id, actorOf(req), (req.body || {}).note, req);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error });
    res.json({ done: true });
  }));
  app.post(B + '/inbox/sync', ...approve, wrap(async (req, res) => {
    const r = await syncInbox();
    slog(actorOf(req), 'inbox_synced', { target: 'thread', summary: `Inbox checked by hand: ${r.added} new` });
    res.json(r);
  }));

  // ── insights ──
  const range = req => {
    const today = manilaDay();
    let to = isDay(req.query.to) ? String(req.query.to) : addDays(today, -1);
    let from = isDay(req.query.from) ? String(req.query.from) : addDays(to, -29);
    if (from > to) [from, to] = [to, from];
    if ((new Date(to) - new Date(from)) / 864e5 > 400) from = addDays(to, -399);
    return { from, to };
  };
  app.get(B + '/insights', ...view, wrap(async (req, res) => {
    const { from, to } = range(req);
    const pid = /^\d{1,30}$/.test(String(req.query.pageId || '')) ? String(req.query.pageId) : '';
    const data = await insightsFor(from, to, pid);
    data.replySpeed = await replySpeed(new Date(from + 'T00:00:00+08:00'), new Date(to + 'T23:59:59+08:00'), pid);
    res.json(data);
  }));
  app.get(B + '/insights/heatmap', ...view, wrap(async (req, res) => res.json(await heatmap(/^\d{1,30}$/.test(String(req.query.pageId || '')) ? String(req.query.pageId) : ''))));
  app.get(B + '/insights/ads', ...view, wrap(async (req, res) => {
    const { from, to } = range(req);
    try { res.json(await adsFor(from, to)); } catch (e) { res.status(502).json({ error: 'Ad results could not be read: ' + scrub(e.message).slice(0, 200), configured: true }); }
  }));
  app.post(B + '/insights/refresh', ...approve, wrap(async (req, res) => {
    const st = await getState();
    const a = await snapshotPages(st.backfilled ? 3 : 30);
    const b = await syncPostStats();
    _leadCache = { at: 0, map: null };
    slog(actorOf(req), 'insights_refreshed', { target: 'insights', summary: `${a.rows} daily rows, ${b.posts} posts read` });
    res.json({ ...a, posts: b.posts });
  }));
  app.get(B + '/insights.csv', ...view, wrap(async (req, res) => {
    const { from, to } = range(req);
    const pages = await pagesState();
    const rows = await SocialDaily.find({ date: { $gte: from, $lte: to } }).sort({ date: 1, pageId: 1 }).lean();
    const keys = [...new Set(rows.flatMap(r => Object.keys(r.metrics || {})))].sort();
    const out = [['date', 'page', 'surface', ...keys]];
    rows.forEach(r => out.push([r.date, (pages.find(p => p.id === r.pageId) || {}).name || r.pageId, r.surface === 'ig' ? 'Instagram' : 'Facebook', ...keys.map(k => (r.metrics || {})[k] ?? '')]));
    const posts = await SocialPostStat.find({ at: { $gte: new Date(from + 'T00:00:00+08:00'), $lte: new Date(to + 'T23:59:59+08:00') } }).sort({ at: 1 }).lean();
    const lmap = await leadsByPost();
    out.push([], ['post date', 'page', 'network', 'text', 'reactions/likes', 'comments', 'shares', 'saves', 'reach', 'views', 'leads', 'link']);
    posts.forEach(s => out.push([s.at ? new Date(s.at).toISOString() : '', (pages.find(p => p.id === s.pageId) || {}).name || s.pageId, s.network, clean(s.text, 300), s.reactions, s.comments, s.shares, s.saves, s.reach ?? '', s.views ?? '', s.postRef && lmap[s.postRef] ? (lmap[s.postRef].byPage[s.pageId] || 0) : 0, s.permalink]));
    slog(actorOf(req), 'exported', { target: 'insights', summary: `Insights CSV ${from} to ${to}` });
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="glra-social-insights-${from}-to-${to}.csv"`).send('﻿' + toCsv(out));
  }));
  app.get(B + '/report.pdf', ...view, wrap(async (req, res) => {
    const { from, to } = range(req);
    const data = await buildReport(from, to);
    const pdf = await require('./social-report').reportPdf(data);
    slog(actorOf(req), 'exported', { target: 'report', summary: `Report PDF ${from} to ${to}` });
    res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="glra-social-report-${from}-to-${to}.pdf"`).send(pdf);
  }));
  app.post(B + '/report/send', ...approve, wrap(async (req, res) => {
    const r = await sendWeekly(true);
    if (!r.ok) return res.status(502).json({ error: r.error || 'The report could not be emailed' });
    slog(actorOf(req), 'report_sent', { target: 'report', summary: 'Weekly report sent by hand to ' + r.recipients.join(', ') });
    res.json(r);
  }));

  // ── activity ──
  const logQuery = req => {
    const q = {};
    if (req.query.action) q.action = clean(req.query.action, 40);
    if (/^\d{1,30}$/.test(String(req.query.pageId || ''))) q.pageId = String(req.query.pageId);
    if (req.query.via) q.via = clean(req.query.via, 20);
    if (req.query.who) q.$or = [{ actor: new RegExp(clean(req.query.who, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { actorName: new RegExp(clean(req.query.who, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    const from = parseWhen(req.query.from), to = parseWhen(req.query.to);
    if (from || to) q.at = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    return q;
  };
  app.get(B + '/log', ...view, wrap(async (req, res) => {
    const rows = await SocialLog.find(logQuery(req)).sort({ at: -1 }).limit(Math.min(1000, Number(req.query.limit) || 200)).lean();
    res.json({ log: rows, actions: await SocialLog.distinct('action') });
  }));
  app.get(B + '/log.csv', ...view, wrap(async (req, res) => {
    const pages = await pagesState();
    const rows = await SocialLog.find(logQuery(req)).sort({ at: -1 }).limit(10000).lean();
    const out = [['when (UTC)', 'who', 'via', 'action', 'page', 'network', 'what', 'Meta id', 'ok']];
    rows.forEach(r => out.push([new Date(r.at).toISOString(), r.actorName || r.actor, r.via, r.action, (pages.find(p => p.id === r.pageId) || {}).name || r.pageId, r.network, r.summary, r.metaId, r.ok ? 'yes' : 'no']));
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="glra-social-activity.csv"').send('﻿' + toCsv(out));
  }));

  // ── settings ──
  app.put(B + '/settings', ...approve, wrap(async (req, res) => {
    const b = req.body || {};
    const cur = await getSettings();
    const next = {
      unansweredHours: b.unansweredHours === undefined ? cur.unansweredHours : Math.max(1, Math.min(168, Math.round(Number(b.unansweredHours) || cur.unansweredHours))),
      approvalEmails: b.approvalEmails === undefined ? cur.approvalEmails : b.approvalEmails === true,
      weeklyEmail: b.weeklyEmail === undefined ? cur.weeklyEmail : b.weeklyEmail === true,
      reportEmails: b.reportEmails === undefined ? cur.reportEmails : [...new Set((Array.isArray(b.reportEmails) ? b.reportEmails : String(b.reportEmails || '').split(/[\s,;]+/)).map(e => String(e).trim().toLowerCase()).filter(e => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(e)))].slice(0, 10)
    };
    await Setting.updateOne({ key: SETTINGS_KEY }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
    slog(actorOf(req), 'settings_saved', { target: 'settings', summary: `Unanswered after ${next.unansweredHours} h; approval emails ${next.approvalEmails ? 'on' : 'off'}; weekly report ${next.weeklyEmail ? 'on' : 'off'}` });
    await logAudit(req, 'UPDATE', 'SocialSettings', '', 'GLRA Social settings', next);
    res.json({ settings: next });
  }));
  // Admin-only: run the per-minute publisher now (troubleshooting and the test kit).
  app.post(B + '/run-publisher', ...admin, wrap(async (req, res) => { await publisherTick(); res.json({ success: true }); }));

  // ── module 6: the Claude review key ──
  app.get(B + '/review-key', ...admin, wrap(async (req, res) => {
    const s = await getSetting(REVIEW_KEY, {});
    res.json({ hasKey: !!s.keyHash, enabled: s.enabled !== false && !!s.keyHash, keyHint: s.keyHint || '', madeAt: s.madeAt || null, lastUsedAt: s.lastUsedAt || null,
      calls: await SocialLog.countDocuments({ via: 'review_key' }), endpoints: ['GET /api/social/review/summary', 'GET /api/social/review/posts', 'GET /api/social/review/insights', 'GET /api/social/review/inbox', 'POST /api/social/review/drafts', 'POST /api/social/review/reply-drafts'] });
  }));
  app.post(B + '/review-key', ...admin, wrap(async (req, res) => {
    const key = 'glra_sr_' + crypto.randomBytes(32).toString('hex');
    await Setting.updateOne({ key: REVIEW_KEY }, { $set: { value: { keyHash: sha(key), keyHint: key.slice(-4), madeAt: new Date(), enabled: true, lastUsedAt: null }, updatedAt: new Date() } }, { upsert: true });
    slog(actorOf(req), 'key_created', { target: 'key', summary: 'Claude review key made (ends ' + key.slice(-4) + ')' });
    await logAudit(req, 'CREATE', 'SocialReviewKey', '', 'Claude review key', null);
    res.json({ key });   // shown once; only the hash is kept
  }));
  app.delete(B + '/review-key', ...admin, wrap(async (req, res) => {
    await Setting.updateOne({ key: REVIEW_KEY }, { $set: { value: { keyHash: '', keyHint: '', enabled: false }, updatedAt: new Date() } }, { upsert: true });
    slog(actorOf(req), 'key_revoked', { target: 'key', summary: 'Claude review key revoked' });
    await logAudit(req, 'DELETE', 'SocialReviewKey', '', 'Claude review key', null);
    res.json({ success: true });
  }));

  async function reviewAuth(req, res, next) {
    try {
      const key = String(req.get('x-glra-review-key') || '');
      const s = await getSetting(REVIEW_KEY, {});
      if (!key || !s.keyHash || s.enabled === false) return res.status(401).json({ error: 'Bad key' });
      const a = Buffer.from(sha(key)), b = Buffer.from(String(s.keyHash));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad key' });
      req.user = { sub: '', email: REVIEW_ACTOR.email, name: REVIEW_ACTOR.name, role: 'review_key', via: 'review_key' };
      if (!s.lastUsedAt || Date.now() - new Date(s.lastUsedAt).getTime() > 60e3) patchSetting(REVIEW_KEY, { lastUsedAt: new Date() }).catch(() => {});
      // Every call is in the activity log.
      slog(REVIEW_ACTOR, req.method === 'GET' ? 'review_read' : 'review_write', { target: 'review', summary: `${req.method} ${req.path}${Object.keys(req.query || {}).length ? '?' + new URLSearchParams(req.query).toString().slice(0, 200) : ''}` });
      next();
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
  }
  const reviewLimiter = rateLimit({ windowMs: 15 * 60e3, max: 300, standardHeaders: true, legacyHeaders: false, keyGenerator: () => 'social-review', message: { error: 'Too many requests' } });
  const RV = [gate, badKeyLimiter, reviewAuth, reviewLimiter];
  const R = '/api/social/review';
  const rvRange = req => { const days = Math.max(1, Math.min(365, Number(req.query.days) || 30)); const to = addDays(manilaDay(), -1); return { from: addDays(to, -(days - 1)), to, days }; };
  app.get(R + '/summary', ...RV, wrap(async (req, res) => {
    const { from, to, days } = rvRange(req);
    const pages = await pagesState();
    const ins = await insightsFor(from, to, '');
    const fromD = new Date(from + 'T00:00:00+08:00'), toD = new Date(to + 'T23:59:59+08:00');
    const stats = await SocialPostStat.find({ at: { $gte: fromD, $lte: toD } }).lean();
    const rhythm = pages.map(pg => {
      const mine = stats.filter(s => s.pageId === pg.id);
      const byWd = [0, 0, 0, 0, 0, 0, 0], byHour = Array(24).fill(0);
      mine.forEach(s => { const p = manilaParts(s.at); byWd[p.wd]++; byHour[p.h]++; });
      return { pageId: pg.id, posts: mine.length, perWeek: Math.round(mine.length / (days / 7) * 10) / 10, byWeekday: byWd, byHour, formats: mine.reduce((m, s) => { const k = s.network + ':' + (s.mediaType || (s.thumb ? 'photo' : 'text')); m[k] = (m[k] || 0) + 1; return m; }, {}) };
    });
    const s = await getSettings();
    const open = await SocialThread.find({ status: { $ne: 'done' } }).select('pageId lastInboundAt lastOwnAt status').lean();
    let ads = null; try { ads = await adsFor(from, to); } catch (e) { ads = { error: scrub(e.message).slice(0, 120) }; }
    res.json({ range: { from, to, days }, pages: pages.map(p => ({ id: p.id, name: p.name, followers: p.followers, instagram: p.igUsername ? { username: p.igUsername, followers: p.igFollowers } : null })),
      insights: ins.pages.map(p => ({ pageId: p.page.id, tiles: p.tiles, posts: p.posts, leads: p.leads, top: p.top.map(x => ({ network: x.network, at: x.at, text: x.text, permalink: x.permalink, reactions: x.reactions, comments: x.comments, shares: x.shares, saves: x.saves, reach: x.reach, views: x.views, leads: x.leads })),
        bottom: p.bottom.map(x => ({ network: x.network, at: x.at, text: x.text, permalink: x.permalink, reactions: x.reactions, comments: x.comments, shares: x.shares, reach: x.reach })) })),
      rhythm, replySpeed: await replySpeed(fromD, toD, ''), unanswered: open.filter(t => unanswered(t, s.unansweredHours)).length, unansweredHours: s.unansweredHours, ads, bestTime: await heatmap('') });
  }));
  app.get(R + '/posts', ...RV, wrap(async (req, res) => {
    const { from, to } = rvRange(req);
    const q = { at: { $gte: new Date(from + 'T00:00:00+08:00'), $lte: new Date(to + 'T23:59:59+08:00') } };
    if (/^\d{1,30}$/.test(String(req.query.pageId || ''))) q.pageId = String(req.query.pageId);
    const stats = await SocialPostStat.find(q).sort({ at: -1 }).limit(500).lean();
    const lmap = await leadsByPost();
    const ours = await SocialPost.find({ status: { $in: ['pending', 'approved', 'scheduled', 'publishing', 'changes'] } }).select('title caption media targets status scheduledAt origin').limit(100).lean();
    res.json({ published: stats.map(s => ({ metaId: s.metaId, pageId: s.pageId, network: s.network, at: s.at, text: s.text, mediaType: s.mediaType, media: s.thumb, permalink: s.permalink,
      reactions: s.reactions, comments: s.comments, shares: s.shares, saves: s.saves, reach: s.reach, views: s.views, engagement: s.engagement, leads: s.postRef && lmap[s.postRef] ? lmap[s.postRef].byPage[s.pageId] || 0 : 0 })),
      upcoming: ours.map(p => ({ id: String(p._id), status: p.status, scheduledAt: p.scheduledAt, origin: p.origin, caption: p.caption, media: p.media.map(m => m.url), targets: p.targets.map(t => ({ network: t.network, pageId: t.pageId, caption: t.caption })) })) });
  }));
  app.get(R + '/insights', ...RV, wrap(async (req, res) => {
    const { from, to } = rvRange(req);
    const d = await insightsFor(from, to, /^\d{1,30}$/.test(String(req.query.pageId || '')) ? String(req.query.pageId) : '');
    d.pages.forEach(p => { p.top = p.top.map(x => ({ ...x, postRef: undefined })); p.bottom = p.bottom.map(x => ({ ...x, postRef: undefined })); });
    res.json(d);
  }));
  app.get(R + '/inbox', ...RV, wrap(async (req, res) => {
    const { days } = rvRange(req);
    const since = new Date(Date.now() - days * 864e5);
    const threads = await SocialThread.find({ lastAt: { $gte: since } }).sort({ lastAt: -1 }).limit(300).lean();
    const items = await SocialItem.find({ threadKey: { $in: threads.map(t => t.key) } }).sort({ at: 1 }).limit(3000).lean();
    res.json({ note: 'Names are shortened to initials, and phone numbers and emails removed (RA 10173).',
      threads: threads.map(t => ({ ref: 't_' + sha(t.key).slice(0, 12), kind: t.kind, pageId: t.pageId, person: maskName(t.name), personId: maskId(t.userId || t.key), tags: [...new Set([...(t.tags || []), ...(t.autoTags || [])])], sentiment: t.sentiment,
        firstInboundAt: t.firstInboundAt, firstReplyAt: t.firstReplyAt, replyMin: t.firstReplyAt && t.firstInboundAt ? Math.round((new Date(t.firstReplyAt) - new Date(t.firstInboundAt)) / 60000) : null, waiting: waitingReply(t),
        messages: items.filter(i => i.threadKey === t.key && !i.deleted).map(i => ({ at: i.at, from: i.own ? 'page' : maskName(i.fromName) || 'customer', text: maskText(i.text), hidden: i.hidden })) })) });
  }));
  app.post(R + '/drafts', ...RV, wrap(async (req, res) => {
    const b = req.body || {};
    const when = parseWhen(b.scheduledAt);
    if (when === undefined) return res.status(400).json({ error: 'scheduledAt could not be read' });
    const doc = { title: clean(b.title, 200) || 'Draft from Claude', caption: clean(b.caption, FB_CAPTION_MAX), link: clean(b.link, 1000), media: cleanMedia(b.media), targets: cleanTargets(b.targets).map(t => ({ ...t, status: 'draft' })), scheduledAt: when || null };
    const v = await validatePost(doc, false);
    if (v.errors.length) return res.status(400).json({ error: v.errors[0], errors: v.errors });
    // Always "waiting for approval": the key has no way to approve.
    const p = await SocialPost.create({ ...doc, status: 'pending', submittedAt: new Date(), origin: 'review_key', createdBy: REVIEW_ACTOR, history: [{ at: new Date(), by: REVIEW_ACTOR.name, action: 'drafted through the review key', note: clean(b.note, 300) }] });
    slog(REVIEW_ACTOR, 'drafted', { target: 'post', targetId: p._id, summary: 'Draft from the review key, waiting for approval: ' + clean(doc.caption, 100) });
    notifyApprovers([p]).catch(() => {});
    res.json({ id: String(p._id), status: p.status, warnings: v.warnings });
  }));
  app.post(R + '/reply-drafts', ...RV, wrap(async (req, res) => {
    const b = req.body || {};
    // The review feed only knows masked thread refs; map one back.
    let key = '';
    if (/^t_[a-f0-9]{12}$/.test(String(b.threadRef || ''))) {
      const all = await SocialThread.find({ lastAt: { $gte: new Date(Date.now() - 365 * 864e5) } }).select('key').lean();
      key = (all.find(t => 't_' + sha(t.key).slice(0, 12) === b.threadRef) || {}).key || '';
    }
    if (!key) return res.status(404).json({ error: 'Unknown threadRef' });
    const r = await createAction({ threadKey: key, kind: 'reply', text: b.text }, REVIEW_ACTOR);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error });
    notifyApprovers([], [r.action]).catch(() => {});
    res.json({ id: String(r.action._id), status: 'pending' });
  }));
  // The media library, so drafts can use uploaded videos and photos (read only).
  app.get(R + '/library', ...RV, wrap(async (req, res) => {
    const rows = await SocialMedia.find().sort({ createdAt: -1 }).limit(300).lean();
    res.json({ media: rows.map(m => ({ id: String(m._id), url: m.url, type: m.type, width: m.width, height: m.height, name: m.name, tags: m.tags, at: m.createdAt })) });
  }));
  // Rafael (19 Oct 2026) let the review key add media to the library: upload
  // only. Using a file in a post still goes through a draft and his approval.
  app.post(R + '/library', ...RV, (req, res, next) => mediaUpload.single('file')(req, res, err => { if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be at most 100 MB.' : 'Upload failed: ' + err.message }); next(); }), wrap(async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'Send one photo or MP4/MOV video as "file".' });
    const cleanup = () => fs.promises.unlink(f.path).catch(() => {});
    const cl = _deps.cloudinary;
    if (!cl || !(env('CLOUDINARY_CLOUD_NAME') && env('CLOUDINARY_API_KEY') && env('CLOUDINARY_API_SECRET'))) { cleanup(); return res.status(503).json({ error: 'Cloudinary is not configured.' }); }
    const isVid = /^video\//.test(f.mimetype);
    try {
      const name = clean(req.body && req.body.name, 200) || clean(f.originalname, 200);
      const dup = await SocialMedia.findOne({ name }).lean();
      if (dup) return res.json({ media: { id: String(dup._id), url: dup.url, type: dup.type, width: dup.width, height: dup.height, name: dup.name }, existed: true });
      const r = await cl.uploader.upload(f.path, { folder: 'glra-social', resource_type: isVid ? 'video' : 'image', ...(isVid ? {} : { transformation: [{ width: 2400, height: 2400, crop: 'limit' }, { quality: 'auto:good' }], format: 'jpg' }) });
      const m = await SocialMedia.create({ url: r.secure_url, publicId: r.public_id, type: isVid ? 'video' : 'image', width: r.width || 0, height: r.height || 0, bytes: r.bytes || 0, format: r.format || '', name, tags: ['review_key'], createdBy: REVIEW_ACTOR.email });
      slog(REVIEW_ACTOR, 'media_added', { target: 'media', targetId: m._id, summary: `Uploaded through the review key: ${m.name} (${m.width}x${m.height})` });
      res.json({ media: { id: String(m._id), url: m.url, type: m.type, width: m.width, height: m.height, name: m.name } });
    } catch (e) { res.status(502).json({ error: 'Cloudinary upload failed: ' + scrub(e.message).slice(0, 200) }); }
    finally { cleanup(); }
  }));
  // Rafael (19 Oct 2026): "you approve them... no need for me to approve them".
  // The key may approve or send back ONLY posts it drafted itself (origin
  // review_key); staff posts still need a person. Logged in Activity and the
  // admin audit log like any approval.
  const ownDraft = async id => oid(id) && await SocialPost.exists({ _id: id, origin: 'review_key' });
  app.post(R + '/approve', ...RV, wrap(async (req, res) => {
    const id = String((req.body || {}).id || '');
    if (!(await ownDraft(id))) return res.status(404).json({ error: 'Not one of the review key\'s drafts' });
    const r = await approvePost(id, REVIEW_ACTOR, req, (req.body || {}).rev);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error, errors: r.errors });
    res.json({ id, status: r.post ? r.post.status : '', warnings: r.warnings || [] });
  }));
  app.post(R + '/reject', ...RV, wrap(async (req, res) => {
    const id = String((req.body || {}).id || '');
    if (!(await ownDraft(id))) return res.status(404).json({ error: 'Not one of the review key\'s drafts' });
    const r = await rejectPost(id, REVIEW_ACTOR, (req.body || {}).note, req);
    if (r.status !== 200) return res.status(r.status).json({ error: r.error });
    res.json({ id, status: r.post.status });
  }));
  // Cancel one of the key's own posts before it goes out (21 Oct 2026, used to
  // replace graphics). Facebook scheduled posts are removed from Facebook's
  // scheduler; anything already published is left alone.
  app.post(R + '/cancel', ...RV, wrap(async (req, res) => {
    const id = String((req.body || {}).id || '');
    if (!(await ownDraft(id))) return res.status(404).json({ error: 'Not one of the review key\'s drafts' });
    const p = await SocialPost.findById(id);
    const errs = [];
    for (const t of p.targets) {
      if (['waiting', 'draft', 'container'].includes(t.status)) { t.status = 'cancelled'; continue; }
      if (t.status === 'scheduled' && t.network === 'fb' && t.metaId) {
        try { await metaWrite('DELETE', t.metaId, {}, { token: await pageTokenFor(t.pageId, { strict: true, area: 'social' }), area: 'social' }); t.status = 'cancelled'; }
        catch (e) { errs.push(scrub(e.message).slice(0, 200)); }
      }
    }
    p.status = rollup(p); if (['pending', 'draft', 'changes', 'approved', 'scheduled'].includes(p.status) && p.targets.every(t => ['cancelled', 'draft'].includes(t.status))) p.status = 'cancelled';
    p.updatedAt = new Date(); p.history.push({ at: new Date(), by: REVIEW_ACTOR.name, action: 'cancelled', note: clean((req.body || {}).note, 200) || errs.join('; ') });
    await p.save();
    slog(REVIEW_ACTOR, 'cancelled', { target: 'post', targetId: p._id, summary: 'Cancelled by the review key' + (errs.length ? ' (with errors: ' + errs.join('; ') + ')' : ''), ok: !errs.length });
    res.status(errs.length ? 502 : 200).json({ id, status: p.status, errors: errs });
  }));
  // Every post of the last N days with its status and the approver's notes, so
  // the key's author can learn from what was approved, changed or turned down.
  app.get(R + '/queue', ...RV, wrap(async (req, res) => {
    const { days } = rvRange(req);
    const since = new Date(Date.now() - days * 864e5);
    const rows = await SocialPost.find({ $or: [{ updatedAt: { $gte: since } }, { createdAt: { $gte: since } }, { scheduledAt: { $gte: since } }] }).sort({ createdAt: -1 }).limit(300)
      .select('title caption status scheduledAt origin targets history publishedAt createdAt updatedAt').lean();
    res.json({ posts: rows.map(p => ({ id: String(p._id), title: p.title, status: p.status, origin: p.origin, scheduledAt: p.scheduledAt, publishedAt: p.publishedAt, createdAt: p.createdAt,
      caption: clean(p.caption, 400), targets: (p.targets || []).map(t => ({ network: t.network, pageId: t.pageId, status: t.status, permalink: t.permalink || '' })),
      history: (p.history || []).slice(-6).map(h => ({ at: h.at, action: h.action, note: h.note || '' })) })) });
  }));
  // Anything else under the review path (approve, publish, delete...) does not exist.
  app.all(R + '/*', gate, (req, res) => res.status(404).json({ error: 'Not found' }));

  // ── one-time approval links (social-approve.html) ──
  app.post('/api/social/link/view', gate, linkLimiter, wrap(async (req, res) => {
    const L = await linkLookup((req.body || {}).t);
    if (L.error) return res.status(L.status).json({ error: L.error });
    const pages = await pagesState();
    if (L.row.kind === 'post') {
      const p = await SocialPost.findById(L.row.ref);
      if (!p) return res.status(404).json({ error: 'This post no longer exists.' });
      return res.json({ kind: 'post', approver: L.actor.name, post: postJson(p, pages), check: p.status === 'pending' ? await validatePost(p, true) : null, expiresAt: L.row.expiresAt });
    }
    const a = await SocialAction.findById(L.row.ref).lean();
    if (!a) return res.status(404).json({ error: 'This action no longer exists.' });
    const th = await SocialThread.findOne({ key: a.threadKey }).lean() || {};
    const items = await SocialItem.find({ threadKey: a.threadKey }).sort({ at: -1 }).limit(6).lean();
    res.json({ kind: 'action', approver: L.actor.name, action: { ...a, _id: String(a._id) }, thread: { kind: th.kind, name: th.name, pageName: (pages.find(p => p.id === th.pageId) || {}).name || '', window: windowOf(th) }, items: items.reverse().map(i => ({ own: i.own, fromName: i.fromName, text: i.text, at: i.at })), expiresAt: L.row.expiresAt });
  }));
  app.post('/api/social/link/decide', gate, linkLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const L = await linkLookup(b.t);
    if (L.error) return res.status(L.status).json({ error: L.error });
    if (!['approve', 'reject'].includes(b.decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
    // Used up first, so a double tap cannot act twice.
    const used = await SocialLinkToken.findOneAndUpdate({ _id: L.row._id, usedAt: null }, { $set: { usedAt: new Date() } });
    if (!used) return res.status(410).json({ error: 'This link has already been used.' });
    const r = L.row.kind === 'post'
      ? (b.decision === 'approve' ? await approvePost(L.row.ref, L.actor, req, b.rev) : await rejectPost(L.row.ref, L.actor, b.note, req))
      : (b.decision === 'approve' ? await executeAction(L.row.ref, L.actor, req) : await rejectAction(L.row.ref, L.actor, b.note, req));
    if (r.status !== 200) {
      // A refusal (a post no longer pending, a validation error) gives the link back, unless Meta was reached.
      if (r.status === 400 || r.status === 409) await SocialLinkToken.updateOne({ _id: L.row._id }, { $set: { usedAt: null } });
      return res.status(r.status).json({ error: r.error, errors: r.errors });
    }
    res.json({ done: true, decision: b.decision, status: r.post ? r.post.status : 'done' });
  }));
}

// ══ WEEKLY REPORT ═════════════════════════════════════════════
async function buildReport(from, to) {
  const ins = await insightsFor(from, to, '');
  const fromD = new Date(from + 'T00:00:00+08:00'), toD = new Date(to + 'T23:59:59+08:00');
  const speed = await replySpeed(fromD, toD, '');
  const s = await getSettings();
  const open = await SocialThread.find({ status: { $ne: 'done' } }).select('pageId lastInboundAt lastOwnAt status').lean();
  const hm = await heatmap('');
  const t = (p, sf, k) => ((p.tiles[sf] || []).find(x => x.key === k) || {});
  const pages = ins.pages.map(p => ({
    name: p.page.name, color: p.page.color, igUsername: p.page.igUsername,
    fbReach: t(p, 'fb', 'page_total_media_view_unique').value, fbFollowers: t(p, 'fb', 'followers_total').value ?? t(p, 'fb', 'page_follows').value, fbNew: t(p, 'fb', 'page_daily_follows_unique').value,
    igReach: t(p, 'ig', 'reach').value, igFollowers: t(p, 'ig', 'followers_total').value, igNew: t(p, 'ig', 'follower_count').value,
    reachSeries: (t(p, 'fb', 'page_total_media_view_unique').series || []).map(x => x[1]), posts: p.posts, leads: p.leads,
    top: p.top.slice(0, 3).map(x => ({ text: x.text, network: x.network, thumb: x.thumb, permalink: x.permalink, engagement: x.engagement, reach: x.reach, leads: x.leads })),
    unanswered: open.filter(x => x.pageId === p.page.id && unanswered(x, s.unansweredHours)).length
  }));
  // Three plain suggestions from the numbers.
  const tips = [];
  if (hm.slots.length) tips.push(`Post at your strongest times next week: ${hm.slots.map(x => x.label).join(', ')} (${hm.enough ? 'from your own results' : 'a starting suggestion until there is more data'}).`);
  const quiet = pages.filter(p => (p.posts.count || 0) < 3);
  if (quiet.length) tips.push(`${quiet.map(p => p.name).join(' and ')} had fewer than 3 posts this week. Aim for 3 to 5: a "Listing of the week" recurring post covers one.`);
  const unans = pages.reduce((a, p) => a + p.unanswered, 0);
  if (unans) tips.push(`${unans} conversation(s) waited more than ${s.unansweredHours} hours for a reply. Fast replies win buyers: clear the Inbox's Unanswered list first thing each morning.`);
  else if (speed.medianMin != null && speed.medianMin > 60) tips.push(`The median first reply took ${Math.round(speed.medianMin / 6) / 10} hours. Saved replies for price and viewing questions can bring that under an hour.`);
  const best = pages.flatMap(p => p.top.map(x => ({ ...x, page: p.name }))).sort((a, b) => (b.engagement || 0) - (a.engagement || 0))[0];
  if (best) tips.push(`Your best post was on ${best.page} (${best.network === 'ig' ? 'Instagram' : 'Facebook'}): "${clean(best.text, 70)}". Make another in the same format.`);
  if (tips.length < 3) tips.push('Use "Post a listing" for a carousel of your newest listing: carousels with the price in the first line get the most saves and enquiries.');
  return { from, to, pages, replySpeed: speed, tips: tips.slice(0, 3), leads: pages.reduce((a, p) => a + (p.leads || 0), 0), generatedAt: new Date() };
}
async function sendWeekly(force) {
  const { sendEmail } = _deps;
  const s = await getSettings();
  const to = addDays(manilaDay(), -1), from = addDays(to, -6);
  const data = await buildReport(from, to);
  const R = require('./social-report');
  const html = R.reportHtml(data, _deps.esc);
  let pdf = null;
  try { pdf = await R.reportPdf(data); } catch (e) { console.error('[social] report PDF failed:', e.message); }
  const recipients = (s.reportEmails && s.reportEmails.length) ? s.reportEmails : [(await getLeadSettings()).notifyEmail].filter(Boolean);
  let ok = 0;
  for (const r of recipients) {
    const x = await sendEmail(r, `Social last week: ${data.leads} lead(s) from your posts`, html, 'GLRA Realty', null, pdf ? [{ name: `glra-social-${from}-to-${to}.pdf`, content: pdf }] : null).catch(() => null);
    if (x && x.success) ok++;
  }
  if (!ok) return { ok: false, error: 'The email service did not accept the report' };
  if (!force) slog(SYSTEM_ACTOR, 'report_sent', { target: 'report', summary: 'Weekly report emailed to ' + recipients.join(', ') });
  return { ok: true, from, to, recipients, pdf: !!pdf };
}

// ══ THE TICK ══════════════════════════════════════════════════
// Every minute: the publisher. Every 10 minutes: inbox check and recurring
// posts. Daily: Page discovery + token check, insights after 6 am, post
// numbers every 6 hours, the Monday 8 am report. Nothing while switched off.
function startSocialTick(deps) {
  _deps = { ..._deps, ...deps };
  if (!SOCIAL_ON()) return { tick: async () => {} };
  let running = false, last10 = 0;
  // The Page / Instagram ids known from the last run count as "us" at once.
  getState().then(st => G.addOwnIds(Object.entries(st.pages || {}).flatMap(([id, p]) => [id, p && p.igId]))).catch(() => {});
  async function tick() {
    if (running || mongoose.connection.readyState !== 1) return;
    running = true;
    try {
      await publisherTick().catch(e => console.error('[social] publisher:', e.message));
      if (Date.now() - last10 >= 9.5 * 60e3) {
        last10 = Date.now();
        const day = manilaDay(), h = manilaParts().h;
        let st = await getState();
        if (st.tokenCheckedDay !== day) { await discoverPages().catch(() => {}); await checkTokens(true).catch(e => console.error('[social] tokens:', e.message)); st = await getState(); }
        await syncInbox().catch(e => console.error('[social] inbox:', e.message));
        for (const r of await SocialRecurring.find({ active: true }).lean()) await runRecurring(r, false).catch(e => console.error('[social] recurring:', e.message));
        if (h >= 6 && st.lastSnapshotDay !== day) await snapshotPages(st.backfilled ? 3 : 30).catch(e => console.error('[social] snapshot:', e.message));
        if (!st.lastStatsSyncAt || Date.now() - new Date(st.lastStatsSyncAt).getTime() > 6 * 3600e3) await syncPostStats().catch(e => console.error('[social] stats:', e.message));
        const s = await getSettings();
        if (s.weeklyEmail && manilaParts().wd === 1 && h >= 8 && h < 14 && st.lastWeeklyDay !== day) {
          const claimed = await Setting.findOneAndUpdate({ key: STATE_KEY, 'value.lastWeeklyDay': { $ne: day } }, { $set: { 'value.lastWeeklyDay': day } });
          if (claimed) await sendWeekly(false).catch(e => console.error('[social] weekly:', e.message));
        }
      }
    } catch (e) { console.error('[social] tick error:', e.message); }
    finally { running = false; }
  }
  setTimeout(() => { tick(); setInterval(tick, 60e3).unref(); }, Number(env('SOCIAL_TICK_DELAY_MS')) || 60e3).unref();
  return { tick };
}

module.exports = {
  registerSocialRoutes, startSocialTick, ingestWebhook, voidLinksForAccount,
  _test: { maskName, maskText, igRatio, parseCsv, rollup, windowOf, autoTagsOf, sentimentOf, tagUrl, heatmap, studioFromListing, nextOccurrence, publisherTick, syncInbox, discoverPages, checkTokens }
};
