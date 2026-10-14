// =============================================================================
// META GRAPH CLIENT — shared by server/meta.js and server/social.js
// =============================================================================
// Moved out of meta.js (Oct 2026) so the lead/insights/inbox module and the
// GLRA Social page manager use one Graph client: the same retries, backoff,
// usage-limit pause, appsecret_proof and token scrubbing.
//
//   metaGet / metaGetAll   read (retries rate-limit and temporary errors)
//   metaWrite              POST / DELETE, used ONLY by server/social.js for
//                          approved publishing and moderation. A write is
//                          retried only when Meta refused it for rate limits
//                          (it was not carried out); a 5xx or a network error
//                          is NOT retried, because the post may already exist.
//   pageToken / pageTokenFor  a Page's own token, derived from the system-user
//                          token and kept in memory only (never stored).
//   logMeta / scrub        MetaLog writer; tokens never reach the log.
//
// Nothing in this file creates, edits or pauses ads or touches a budget.
// =============================================================================
'use strict';
const crypto = require('crypto');
const { MetaLog } = require('./db');

const env = k => String(process.env[k] || '').trim();
const flag = k => /^(1|true|yes|on)$/i.test(env(k));
const PAGE_ID = () => (env('META_PAGE_ID').match(/^\d{1,30}$/) || [''])[0];
// A base-URL override exists only for the local test kits (scripts/test-meta.js
// and scripts/test-social.js point it at a stub server). It is honoured only
// for a localhost address, so a stray value in production can never send a
// token anywhere but Meta.
function localOverride(name) {
  const v = env(name).replace(/\/+$/, '');
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v) ? v : '';
}
const graphBase = () => (localOverride('META_GRAPH_BASE') || 'https://graph.facebook.com') + '/' + (/^v\d+\.\d+$/.test(env('META_GRAPH_VERSION')) ? env('META_GRAPH_VERSION') : 'v24.0');
const telegramBase = () => localOverride('TELEGRAM_API_BASE') || 'https://api.telegram.org';
const retryBase = () => Math.max(20, Math.min(10000, Number(env('META_RETRY_BASE_MS')) || 1000));
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  for (const t of _pageToks.values()) if (t.token && t.token.length >= 6) out = out.split(t.token).join('[hidden]');
  return out;
}

// Every error and warning lands in MetaLog (kept 90 days, shown in the Meta tab).
function logMeta(level, area, message, x) {
  const m = scrub(message).slice(0, 1000);
  (level === 'error' ? console.error : console.log)('[meta] ' + area + ': ' + m);
  return MetaLog.create({ level, area, message: m, code: String((x && x.code) || '').slice(0, 40), path: scrub((x && x.path) || '').slice(0, 300) }).catch(() => {});
}

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
// For the Social page: "slowed down by Meta" instead of a failure.
function usageState() { const now = Date.now(); return { paused: _pauseUntil > now, pauseUntil: _pauseUntil > now ? new Date(_pauseUntil) : null, slowed: _slowUntil > now }; }

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

// POST or DELETE (social.js only, after an approval). Parameters go in the
// form body, never the address. Retried only on Meta's throttling codes, which
// mean the request was refused rather than carried out.
async function metaWrite(method, path, params, opts) {
  const o = opts || {};
  const m = method === 'DELETE' ? 'DELETE' : 'POST';
  const token = o.token || env('META_SYSTEM_TOKEN');
  const p = String(path || '').replace(/^\/+/, '');
  if (!token) throw new MetaError('META_SYSTEM_TOKEN is not set', { code: 'no_token', path: p });
  if (!/^[A-Za-z0-9_./]+$/.test(p)) throw new MetaError('Bad Graph path', { code: 'bad_path', path: p.slice(0, 80) });
  if (_pauseUntil > Date.now() && !o.urgent) throw new MetaError('Slowed down by Meta: its usage limit was reached, so this waits until ' + new Date(_pauseUntil).toISOString(), { code: 'usage_pause', path: p });
  const tries = Math.max(1, Math.min(4, o.tries || 3));
  let last = null;
  for (let i = 0; i < tries; i++) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    form.set('access_token', token);
    if (env('META_APP_SECRET')) form.set('appsecret_proof', appsecretProof(token));
    let res = null, body = null;
    try {
      res = await fetch(graphBase() + '/' + p, { method: m, headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(o.timeoutMs || 60000) });
      noteUsage(res.headers);
      body = await res.json().catch(() => null);
    } catch (e) {
      last = new MetaError('Network error (the request may or may not have reached Meta): ' + scrub(e.message), { code: 'network', path: p, retryable: false, unknown: true });
    }
    if (res) {
      if (res.ok && body && !body.error) return body;
      const er = (body && body.error) || {};
      const code = Number(er.code) || 0;
      last = new MetaError(scrub(er.error_user_msg || er.message || ('HTTP ' + res.status)), {
        code: code || res.status, subcode: er.error_subcode || '', status: res.status, path: p,
        retryable: isRetryCode(code), unknown: res.status >= 500
      });
    }
    if (!last.retryable || i === tries - 1) break;
    const wait = Math.min(60000, retryBase() * 2 ** i) + Math.floor(Math.random() * retryBase());
    logMeta('warn', o.area || 'social', `Graph ${m} error ${last.code} on ${p}: ${last.message} (refused, not carried out; try ${i + 1} of ${tries}, again in ${Math.round(wait / 100) / 10}s)`, last);
    await sleep(wait);
  }
  if (!o.quiet) logMeta('error', o.area || 'social', `Graph ${m} error ${last.code} on ${p}: ${last.message}`, last);
  throw last;
}

// A Page's own token, derived from the system-user token and kept in memory
// (6 hours). With no Page id, or if Meta will not give one, the system token.
const _pageToks = new Map();
async function pageTokenFor(pageId, opts) {
  const id = String(pageId || '');
  const hit = _pageToks.get(id);
  if (hit && hit.token && Date.now() - hit.at < 6 * 3600e3) return hit.token;
  if (!/^\d{1,30}$/.test(id)) return env('META_SYSTEM_TOKEN');
  try {
    const d = await metaGet(id, { fields: 'access_token' }, { area: (opts && opts.area) || 'token', tries: 2, urgent: true });
    if (d && typeof d.access_token === 'string' && d.access_token) { _pageToks.set(id, { token: d.access_token, at: Date.now() }); return d.access_token; }
  } catch (e) { /* logged by metaGet; the system token can still read most things */ }
  if (opts && opts.strict) throw new MetaError(`No Page token for ${id}: is the Page assigned to the system user?`, { code: 'no_page_token', path: id });
  return env('META_SYSTEM_TOKEN');
}
function pageToken() { return pageTokenFor(PAGE_ID()); }
function forgetPageToken(pageId) { _pageToks.delete(String(pageId || '')); }

// Accounts that are "us" (any connected Page or Instagram account), so a reply
// the Page itself wrote is never taken for a customer. Filled by social.js
// after it discovers each Page's Instagram account.
const _ownIds = new Set();
function addOwnIds(ids) { for (const i of ids || []) if (/^\d{1,40}$/.test(String(i))) _ownIds.add(String(i)); }
function isOwnId(id) { return _ownIds.has(String(id || '')); }

module.exports = {
  env, flag, PAGE_ID, localOverride, graphBase, telegramBase, retryBase, sleep, clean, scrub, logMeta,
  MetaError, isRetryCode, appsecretProof, metaGet, metaGetAll, metaWrite, pageToken, pageTokenFor, forgetPageToken,
  usageState, addOwnIds, isOwnId
};
