#!/usr/bin/env node
// =============================================================================
// Local test kit for GLRA Social (server/social.js, social.html)
// =============================================================================
// Runs against a RUNNING local stack. Meta is never contacted: this script
// starts a stub of the Graph API (and of the AI service) on STUB_PORT, and the
// local server must be pointed at it. Start the stack with:
//
//   SOCIAL_ENABLED=1 META_LEADS_ENABLED=1 META_INSIGHTS_ENABLED=1 META_INBOX_ENABLED=1
//   META_APP_ID=111 META_APP_SECRET=test META_VERIFY_TOKEN=test META_SYSTEM_TOKEN=sys-test-token
//   META_PAGE_ID=1000 META_PAGE_IDS=1000,1001,1002 META_IG_USER_ID=2000 META_AD_ACCOUNT_ID=act_3000
//   META_RETRY_BASE_MS=100 META_GRAPH_BASE=http://127.0.0.1:4099 TELEGRAM_API_BASE=http://127.0.0.1:4099
//   SOCIAL_LLM_BASE=http://127.0.0.1:4099 SOCIAL_TICK_DELAY_MS=600000
//
// then:  node scripts/test-social.js          (everything on)
//        node scripts/test-social.js --off    (stack started WITHOUT SOCIAL_ENABLED: every route 404)
//
// It signs in by minting JWTs with the local stack's JWT_SECRET (no login
// calls, so the 5-per-15-minutes sign-in limit is untouched) and reads / moves
// a few clock times straight in the stack's database (STACK_URI, default: the
// file D:/GLRA/glra-dev-tools/stack-<port>.uri), e.g. to make a scheduled post
// due without waiting.
// Options (env): BASE (http://localhost:4180), STUB_PORT (4099), JWT_SECRET,
// MAIL_DIR (D:/GLRA/glra-dev-tools/mail-real).
// =============================================================================
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));

const BASE = process.env.BASE || 'http://localhost:4180';
const PORT = (BASE.match(/:(\d+)$/) || [])[1] || '4180';
const STUB_PORT = Number(process.env.STUB_PORT || 4099);
const SECRET = 'test';
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-test-secret-1234567890';
const MAIL_DIR = process.env.MAIL_DIR || 'D:/GLRA/glra-dev-tools/mail-real';
const OFF = process.argv.includes('--off');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + String(detail).slice(0, 220) + ')' : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 8000); let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch (e) { /* again */ } await sleep(200); } return v; }

async function req(method, url, { body, token, headers, raw } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.authorization = 'Bearer ' + token;
  let data = raw;
  if (body !== undefined && raw === undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(BASE + url, { method, headers: h, body: data });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
  return { status: r.status, text: buf.toString('utf8'), buf, json, headers: r.headers };
}
const A = (method, p, token, body) => req(method, '/api/admin/social' + p, { token, body });
const sign = buf => 'sha256=' + crypto.createHmac('sha256', SECRET).update(buf).digest('hex');
function deliver(payload, sig) {
  const raw = Buffer.from(JSON.stringify(payload));
  const headers = { 'content-type': 'application/json' };
  if (sig !== null) headers['x-hub-signature-256'] = sig === undefined ? sign(raw) : sig;
  return req('POST', '/api/meta/webhook', { raw, headers });
}

// ══ STUB GRAPH API + AI ═══════════════════════════════════════
const now = Date.now();
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, '+0000');
const PAGES = { 1000: { name: 'GLRA Realty', ig: '2000', igu: 'glrarealty' }, 1001: { name: 'GLRA Land Title Documentation and Allied Services', ig: '2001', igu: 'glralandtitle' }, 1002: { name: 'Kate Sampayo, Realtor', ig: '', igu: '' } };
const stub = { calls: [], proofBad: [], n: 100, fail613: 0, failPerm: true, containers: {}, llm: [] };
const days = k => { const out = []; for (let i = k; i >= 1; i--) out.push(new Date(now - i * 864e5)); return out; };
const endTime = d => iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 7));
const series = (base, wob, grow) => days(30).map((d, i) => ({ value: Math.round(base + (grow || 0) * i + Math.sin(i / 2.3) * wob), end_time: endTime(d) }));
const nid = () => String(++stub.n);
function graph(method, p, q) {
  const parts = p.split('/').filter(Boolean);
  const [a, b] = parts;
  const P = PAGES[a];
  if (method === 'POST') {
    if (P && b === 'subscribed_apps') return [200, { success: true }];
    if (P && b === 'feed') {
      const msg = q.message || '';
      if (/FAIL613ONCE/.test(msg) && stub.fail613++ === 0) return [400, { error: { message: '(#613) Calls to this api have exceeded the rate limit.', code: 613 } }];
      if (/FAILPERM/.test(msg) && stub.failPerm) return [400, { error: { message: '(#200) The user hasn\'t authorized the application to perform this action', code: 200 } }];
      return [200, { id: a + '_' + nid() }];
    }
    if (P && b === 'photos') { const id = nid(); return [200, q.published === 'false' && !q.scheduled_publish_time ? { id } : { id, post_id: a + '_' + id }]; }
    if (P && b === 'videos') return [200, { id: nid() }];
    if (P && b === 'messages') return [200, { recipient_id: JSON.parse(q.recipient || '{}').id, message_id: 'm_out_' + nid() }];
    if (/^200\d$/.test(a) && b === 'media') { const id = 'c' + nid(); stub.containers[id] = { video: /VIDEO|REELS/.test(q.media_type || '') || (q.media_type === 'CAROUSEL' && false), polls: 0 }; return [200, { id }]; }
    if (/^200\d$/.test(a) && b === 'media_publish') return [200, { id: '1789' + nid() }];
    if (/^\d+_[\d_]+$/.test(a) && b === 'comments') return [200, { id: a.split('_')[0] + '_' + nid() }];
    if (/^\d+$/.test(a) && b === 'replies') return [200, { id: '1795' + nid() }];
    if (/^[\d_]+$/.test(a) && !b && (q.is_hidden !== undefined || q.hide !== undefined)) return [200, { success: true }];
    return [400, { error: { message: 'Unexpected POST ' + p, code: 100 } }];
  }
  if (method === 'DELETE') return /^[\d_]+$/.test(a) && !b ? [200, { success: true }] : [400, { error: { message: 'Unexpected DELETE', code: 100 } }];
  // GET
  if (a === 'debug_token') return [200, { data: { is_valid: true, expires_at: 0, type: 'PAGE', app_id: '111', scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'pages_read_user_content', 'pages_messaging', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_messages', 'instagram_manage_insights', 'read_insights', 'leads_retrieval', 'pages_manage_metadata', 'ads_read', 'business_management'] } }];
  if (P && !b) {
    const f = q.fields || '';
    if (f === 'access_token') return [200, { id: a, access_token: 'page-tok-' + a }];
    if (/instagram_business_account/.test(f)) return [200, { id: a, name: P.name, followers_count: 4000 + Number(a), picture: { data: { url: 'https://scontent.xx.fbcdn.net/p' + a + '.jpg' } }, ...(P.ig ? { instagram_business_account: { id: P.ig, username: P.igu, followers_count: 3000 } } : {}) }];
    return [200, { id: a, followers_count: 4825, fan_count: 4700 }];
  }
  if (P && b === 'insights') {
    const m = q.metric;
    if (m === 'page_daily_follows_unique') return [400, { error: { message: '(#100) The value must be a valid insights metric', code: 100 } }];
    const map = { page_follows: series(4600, 3, 7.5), page_total_media_view_unique: series(2100, 600), page_media_view: series(5200, 1500), page_post_engagements: series(180, 70) };
    return map[m] ? [200, { data: [{ name: m, values: map[m] }] }] : [400, { error: { message: 'Unknown metric', code: 100 } }];
  }
  if (P && b === 'published_posts') return [200, { data: [
    { id: a + '_1', message: 'Sondris 2BR with a river view. Price list on request.', created_time: iso(now - 3 * 864e5), permalink_url: 'https://www.facebook.com/' + a + '_1', full_picture: 'https://scontent.xx.fbcdn.net/1.jpg', shares: { count: 12 }, reactions: { summary: { total_count: 240 } }, comments: { summary: { total_count: 31 } } },
    { id: a + '_2', message: 'Open house this Saturday at Liv.', created_time: iso(now - 9 * 864e5), permalink_url: 'https://www.facebook.com/' + a + '_2', shares: { count: 3 }, reactions: { summary: { total_count: 88 } }, comments: { summary: { total_count: 9 } } }] }];
  if (/^\d+_\d+$/.test(a) && b === 'insights') return [200, { data: [{ name: q.metric, values: [{ value: q.metric === 'post_media_view' ? 5000 : 3200 }] }] }];
  if (/^\d+_\d+$/.test(a) && !b) return [200, { id: a, is_published: true, permalink_url: '/' + a.replace('_', '/posts/') }];
  if (P && b === 'conversations') {
    const ig = q.platform === 'instagram';
    if (ig && a === '1001') return [400, { error: { message: '(#10) Application does not have permission for this action', code: 10 } }];
    const user = ig ? '8802' : '7201', own = ig ? P.ig : a;
    return [200, { data: [{ id: 't_' + a + (ig ? 'i' : 'm'), updated_time: iso(now - 3600e3), messages: { data: [
      { id: 'm_sync_' + a + (ig ? 'i' : 'm') + '_2', message: 'Thanks, we will send it.', from: { id: own, name: P.name }, created_time: iso(now - 3000e3) },
      { id: 'm_sync_' + a + (ig ? 'i' : 'm') + '_1', message: 'Hi, is parking included?', from: { id: user, name: 'Sync Person' }, created_time: iso(now - 3600e3) }] } }] }];
  }
  if (P && b === 'feed') return [200, { data: [{ id: a + '_1', permalink_url: 'https://www.facebook.com/' + a + '_1', comments: { data: [{ id: a + '_1_501', message: 'Magkano po ito?', from: { id: '7301', name: 'Feed Commenter' }, created_time: iso(now - 7200e3), is_hidden: false,
    comments: { data: [{ id: a + '_1_502', message: 'Sent you a message po', from: { id: a, name: P.name }, created_time: iso(now - 7000e3) }] } }] } }] }];
  if (/^200\d$/.test(a) && b === 'media') {
    if (/comments.limit/.test(q.fields || '')) {
      if (a === '2001') return [400, { error: { message: '(#10) Requires instagram_manage_comments', code: 10 } }];
      return [200, { data: [{ id: '91', permalink: 'https://www.instagram.com/p/AAA/', comments: { data: [{ id: '17900501', text: 'Available pa?', username: 'ig.buyer', from: { id: '9902', username: 'ig.buyer' }, timestamp: iso(now - 5000e3), hidden: false }] } }] }];
    }
    return [200, { data: [{ id: a + '91', caption: 'Golden hour at Sondris.', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/91.jpg', permalink: 'https://www.instagram.com/p/AAA/', timestamp: iso(now - 2 * 864e5), like_count: 320, comments_count: 18 },
      { id: a + '92', caption: 'A day at Liv (reel).', media_type: 'VIDEO', thumbnail_url: 'https://scontent.cdninstagram.com/92.jpg', permalink: 'https://www.instagram.com/p/BBB/', timestamp: iso(now - 6 * 864e5 + (a === '2001' ? 3600e3 : 0)), like_count: 512, comments_count: 40 }] }];
  }
  if (/^200\d$/.test(a) && b === 'insights') {
    if (q.metric_type === 'total_value') return [200, { data: [{ name: q.metric, total_value: { value: 400 } }] }];
    const map = { reach: series(1500, 400), follower_count: series(14, 6) };
    return map[q.metric] ? [200, { data: [{ name: q.metric, values: map[q.metric] }] }] : [400, { error: { message: 'Unknown metric', code: 100 } }];
  }
  if (/^200\d$/.test(a) && !b) return [200, { id: a, followers_count: 3120 }];
  if (/^200\d9[12]$/.test(a) && b === 'insights') return [200, { data: [{ name: 'reach', values: [{ value: 6100 }] }, { name: 'views', values: [{ value: 9000 }] }, { name: 'saved', values: [{ value: 44 }] }, { name: 'shares', values: [{ value: 12 }] }] }];
  if (/^c\d+$/.test(a)) { const c = stub.containers[a] || {}; c.polls = (c.polls || 0) + 1; return [200, { status_code: c.video && c.polls < 2 ? 'IN_PROGRESS' : 'FINISHED' }]; }
  if (/^1789\d+$/.test(a)) return [200, { id: a, permalink: 'https://www.instagram.com/p/' + a + '/' }];
  if (a === 'act_3000' && b === 'insights') return [200, { data: [
    { campaign_id: '7001', campaign_name: 'Sondris Leads Oct 2026', spend: '3500.50', impressions: '90000', clicks: '1200', actions: [{ action_type: 'lead', value: '25' }, { action_type: 'onsite_conversion.lead_grouped', value: '25' }] },
    { campaign_id: '7002', campaign_name: 'Liv Awareness', spend: '1500', impressions: '150000', clicks: '600', actions: [{ action_type: 'link_click', value: '40' }] }] }];
  if (a === '7101' && !b) return [200, { first_name: 'Maria', last_name: 'Santos' }];
  if (/^\d+$/.test(a) && !b) return [200, { first_name: 'Juan', last_name: 'Cruz', name: 'Juan Cruz' }];
  return [404, { error: { message: 'Stub has no answer for ' + p, code: 803 } }];
}
function llm(body) {
  const sys = (body.messages || [])[0] || {}, user = (body.messages || [])[1] || {};
  stub.llm.push({ system: sys.content, user: user.content });
  if (/AIFAIL/.test(user.content || '')) return [500, { error: 'boom' }];
  if (/write social media posts/.test(sys.content || '')) return [200, { choices: [{ message: { content: 'Here you go:\n{"facebook":"FB draft: Sondris 2BR, message us.","instagram":"IG draft: Sondris 2BR. Link in bio.","hashtags":["#Sondris","#Pasig"]}' } }] }];
  return [200, { choices: [{ message: { content: 'Hello po! Yes, parking is included. When would you like to view?' } }] }];
}
function startStub() {
  return new Promise(resolve => {
    const srv = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', c => { body += c; });
      rq.on('end', () => {
        const u = new URL(rq.url, 'http://x');
        const send = (st, j) => { rs.writeHead(st, { 'content-type': 'application/json', 'x-app-usage': JSON.stringify({ call_count: 3, total_cputime: 2, total_time: 2 }) }); rs.end(JSON.stringify(j)); };
        if (u.pathname === '/v1/chat/completions') { const [st, j] = llm(JSON.parse(body || '{}')); return send(st, j); }
        if (/^\/bot/.test(u.pathname)) return send(200, { ok: true, result: [] });
        const m = /^\/v\d+\.\d+\/(.*)$/.exec(u.pathname);
        if (!m) return send(404, { error: { message: 'no version' } });
        const q = {};
        u.searchParams.forEach((v, k) => { q[k] = v; });
        if (body && /x-www-form-urlencoded/.test(rq.headers['content-type'] || '')) new URLSearchParams(body).forEach((v, k) => { q[k] = v; });
        const tok = q.access_token || '';
        if (m[1] !== 'debug_token' && q.appsecret_proof !== crypto.createHmac('sha256', SECRET).update(tok).digest('hex')) stub.proofBad.push(rq.method + ' ' + m[1]);
        stub.calls.push({ method: rq.method, path: m[1], q, token: tok, inBody: !!body && /access_token=/.test(body), inUrl: u.searchParams.has('access_token') });
        const [st, j] = graph(rq.method, m[1], q);
        send(st, j);
      });
    });
    srv.listen(STUB_PORT, '127.0.0.1', () => resolve(srv));
  });
}
const callsTo = (method, re) => stub.calls.filter(c => c.method === method && re.test(c.path));

// ══ OFF MODE ══════════════════════════════════════════════════
async function offMode() {
  const routes = [['GET', '/api/admin/social/me'], ['GET', '/api/admin/social/posts'], ['POST', '/api/admin/social/posts'], ['POST', '/api/admin/social/posts/x/approve'], ['GET', '/api/admin/social/inbox'],
    ['GET', '/api/admin/social/insights'], ['GET', '/api/admin/social/log'], ['POST', '/api/admin/social/review-key'], ['GET', '/api/social/review/summary'], ['POST', '/api/social/review/drafts'],
    ['POST', '/api/social/link/view'], ['POST', '/api/social/link/decide'], ['GET', '/api/admin/social/badge']];
  for (const [m, u] of routes) {
    const r = await req(m, u, m === 'GET' ? {} : { body: {} });
    check(`switched off: ${m} ${u} -> 404`, r.status === 404, 'got ' + r.status);
  }
}

// ══ ON MODE ═══════════════════════════════════════════════════
async function onMode() {
  const srv = await startStub();
  const uriFile = `D:/GLRA/glra-dev-tools/stack-${PORT}.uri`;
  await mongoose.connect(process.env.STACK_URI || fs.readFileSync(uriFile, 'utf8').trim());
  const db = mongoose.connection.db;
  const startedAt = Date.now() - 1000;
  const newMail = () => (fs.existsSync(MAIL_DIR) ? fs.readdirSync(MAIL_DIR) : []).map(f => path.join(MAIL_DIR, f)).filter(f => fs.statSync(f).mtimeMs >= startedAt).sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs).map(f => fs.readFileSync(f, 'utf8'));
  const mint = a => jwt.sign({ sub: String(a._id), email: a.email, role: a.role, name: a.name, tv: a.tokenVersion || 0 }, JWT_SECRET, { expiresIn: '2h' });
  const oidOf = s => new mongoose.Types.ObjectId(String(s));
  try {
    const adminAcc = await db.collection('accounts').findOne({ role: 'admin' });
    const admin = mint(adminAcc);
    // People: a viewer, a staff drafter, an approver who is not an admin, an employee with nothing.
    const mk = async (tag, perms) => {
      const email = `social.${tag}.${Date.now()}@example.com`;
      const r = await req('POST', '/api/admin/accounts', { token: admin, body: { email, password: 'Social-Test-Pass-2026!', name: 'Test ' + tag[0].toUpperCase() + tag.slice(1), role: 'employee', permissions: perms } });
      const acc = await db.collection('accounts').findOne({ email });
      return { token: mint(acc), id: String(acc._id), email, created: r.json && r.json.account };
    };
    const nobody = await mk('nobody', {});
    check('new employee has no GLRA Social permission by default', nobody.created && nobody.created.permissions.social_view === false && nobody.created.permissions.social_draft === false && nobody.created.permissions.social_approve === false);
    const viewer = await mk('viewer', { social_view: true });
    const staff = await mk('staff', { social_view: true, social_draft: true });
    const cath = await mk('approver', { social_view: true, social_draft: true, social_approve: true });

    // ── 1. permissions ──
    let r = await A('GET', '/me');
    check('no sign-in -> 401', r.status === 401, r.status);
    r = await A('GET', '/me', nobody.token);
    check('employee without social_view -> 403', r.status === 403, r.status);
    r = await A('GET', '/me', viewer.token);
    check('viewer -> 200, perms view only', r.status === 200 && r.json.perms.view && !r.json.perms.draft && !r.json.perms.approve);
    r = await A('POST', '/posts', viewer.token, { caption: 'x', targets: [{ network: 'fb', pageId: '1000' }] });
    check('viewer cannot write a draft -> 403', r.status === 403, r.status);

    // ── 2. Pages, tokens, webhook subscription ──
    r = await A('POST', '/pages/refresh', staff.token);
    check('staff cannot re-check Pages (approve only) -> 403', r.status === 403, r.status);
    r = await A('POST', '/pages/refresh', admin);
    const pg = r.json && r.json.pages;
    check('pages discovered: 3 Pages with names', r.status === 200 && pg.length === 3 && pg[2].name === 'Kate Sampayo, Realtor', JSON.stringify(pg && pg.map(p => p.name)));
    check('Instagram discovered per Page (2000, 2001; none for Kate)', pg && pg[0].igId === '2000' && pg[1].igId === '2001' && !pg[2].igId && pg[0].igUsername === 'glrarealty');
    check('token check per Page: all valid', r.json && r.json.tokens.system.ok && Object.values(r.json.tokens.pages).every(t => t.ok) && Object.keys(r.json.tokens.pages).length === 3);
    check('each Page used its own Page token', ['1000', '1001', '1002'].every(id => stub.calls.some(c => c.path === id && c.token === 'page-tok-' + id)));
    r = await A('POST', '/pages/1001/subscribe', cath.token);
    check('webhook subscribe is admin-only (approver who is not admin -> 403)', r.status === 403, r.status);
    r = await A('POST', '/pages/1001/subscribe', admin);
    const sub = callsTo('POST', /^1001\/subscribed_apps$/).pop();
    check('webhook subscribe: feed, messages, echoes and leadgen kept', r.status === 200 && sub && sub.q.subscribed_fields === 'feed,messages,message_echoes,leadgen', sub && sub.q.subscribed_fields);
    check('writes send the token in the form body, not the address', sub && sub.inBody && !sub.inUrl);

    // ── 3. validation ──
    const chk = async (body, strict) => (await A('POST', '/posts/check', staff.token, { ...body, strict })).json;
    let c = await chk({ caption: 'Just text', targets: [{ network: 'ig', pageId: '1000' }] });
    check('Instagram text-only refused with a clear message', c.errors.some(e => /Instagram does not take text-only or link posts/.test(e)), c.errors[0]);
    c = await chk({ caption: 'x'.repeat(2201), media: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }], targets: [{ network: 'ig', pageId: '1000' }] });
    check('Instagram caption over 2200 refused', c.errors.some(e => /2200/.test(e)));
    c = await chk({ caption: Array.from({ length: 31 }, (_, i) => '#tag' + i).join(' '), media: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }], targets: [{ network: 'ig', pageId: '1000' }] });
    check('more than 30 hashtags refused', c.errors.some(e => /31 hashtags/.test(e)));
    c = await chk({ caption: 'x', media: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }], targets: [{ network: 'ig', pageId: '1002' }] });
    check('Instagram on a Page without a linked account refused', c.errors.some(e => /no linked Instagram/.test(e)));
    c = await chk({ caption: 'x', media: [{ url: 'https://x.com/a.mp4', type: 'video' }, { url: 'https://x.com/b.jpg' }], targets: [{ network: 'fb', pageId: '1000' }] });
    check('photos and a video together refused', c.errors.some(e => /not both/.test(e)));
    c = await chk({ caption: 'x', media: [{ url: 'http://insecure.example/a.jpg' }], targets: [{ network: 'fb', pageId: '1000' }] });
    check('non-https media refused', c.errors.some(e => /https/.test(e)));
    c = await chk({ caption: 'x', scheduledAt: new Date(Date.now() + 76 * 864e5).toISOString(), targets: [{ network: 'fb', pageId: '1000' }] });
    check('more than 75 days ahead refused', c.errors.some(e => /75 days/.test(e)));
    c = await chk({ caption: 'x', scheduledAt: new Date(Date.now() + 5 * 60e3).toISOString(), targets: [{ network: 'fb', pageId: '1000' }] }, true);
    check('Facebook schedule under 10 minutes refused at approval', c.errors.some(e => /10 minutes/.test(e)));
    c = await chk({ caption: 'x', media: [{ url: 'https://res.cloudinary.com/demo/image/upload/tall.jpg', width: 1000, height: 2000 }], targets: [{ network: 'ig', pageId: '1000' }] });
    check('too-tall Cloudinary photo: warning that it will be cropped, not an error', !c.errors.length && c.warnings.some(w => /cropped/.test(w)));
    c = await chk({ caption: 'x', media: [{ url: 'https://example.com/tall.jpg', width: 1000, height: 2000 }], targets: [{ network: 'ig', pageId: '1000' }] });
    check('too-tall photo elsewhere: an error', c.errors.some(e => /Too tall/.test(e)));

    // ── 4. staff draft -> waiting; staff can never publish ──
    const mailBefore = newMail().length;
    r = await A('POST', '/posts', staff.token, { title: 'Staff FB post', caption: 'Hello from the office', targets: [{ network: 'fb', pageId: '1000' }], action: 'submit' });
    const p1 = r.json && r.json.post;
    check('staff draft submitted -> waiting for approval', r.status === 200 && p1.status === 'pending', r.status + ' ' + (p1 && p1.status));
    r = await A('POST', `/posts/${p1._id}/approve`, staff.token);
    check('staff approve -> 403 (server-side)', r.status === 403, r.status);
    r = await A('POST', '/posts', staff.token, { caption: 'Sneaky', targets: [{ network: 'fb', pageId: '1000' }], action: 'approve' });
    check('staff "approve & publish" from the composer -> 403, post stays waiting', r.status === 403 && r.json.post && r.json.post.status === 'pending', r.status);
    r = await A('POST', '/posts/approve-batch', staff.token, { ids: [p1._id] });
    check('staff approve-batch -> 403', r.status === 403);
    r = await A('POST', `/posts/${p1._id}/cancel`, staff.token);
    check('staff cancel -> 403', r.status === 403);
    r = await A('POST', `/posts/${p1._id}/reject`, staff.token, { note: 'x' });
    check('staff send-back -> 403', r.status === 403);
    check('nothing reached Meta from the staff attempts', !callsTo('POST', /^1000\/feed$/).length);
    const appMail = await until(() => { const m = newMail().slice(mailBefore).filter(h => /social-approve\.html#t=/.test(h)); return m.length >= 2 ? m : null; });
    check('approvers emailed a one-time approve link (admin + approver)', appMail && appMail.length >= 2, appMail ? appMail.length + ' emails' : 'none');

    // ── 5. approve: Facebook now ──
    r = await A('POST', `/posts/${p1._id}/approve`, admin);
    let feed = callsTo('POST', /^1000\/feed$/).pop();
    check('admin approves -> published on Facebook', r.status === 200 && r.json.post.status === 'published' && r.json.post.targets[0].metaId.startsWith('1000_'), r.json && (r.json.post ? r.json.post.status : r.json.error));
    check('Facebook post used the Page token and the text', feed && feed.token === 'page-tok-1000' && feed.q.message === 'Hello from the office' && !feed.q.scheduled_publish_time);
    check('permalink stored', r.json.post.targets[0].permalink.startsWith('https://www.facebook.com/'));
    r = await A('POST', `/posts/${p1._id}/approve`, admin);
    check('second approve of the same post -> 409 (no double publish)', r.status === 409 && callsTo('POST', /^1000\/feed$/).length === 1, r.status);
    let audit = await db.collection('auditlogs').findOne({ action: 'SOCIAL_APPROVE', targetId: p1._id });
    check('approval written to the admin Audit Log', !!audit);

    // an approver who is not an admin
    r = await A('POST', '/posts', staff.token, { caption: 'For Catherine', targets: [{ network: 'fb', pageId: '1002' }], action: 'submit' });
    r = await A('POST', `/posts/${r.json.post._id}/approve`, cath.token);
    check('employee given social_approve can approve -> published', r.status === 200 && r.json.post.status === 'published');

    // ── 6. Facebook native scheduling, photos, carousel, video, link + UTM ──
    const in20 = new Date(Date.now() + 20 * 60e3).toISOString();
    r = await A('POST', '/posts', admin, { caption: 'Scheduled photo', media: [{ url: 'https://res.cloudinary.com/demo/image/upload/one.jpg', width: 1200, height: 1200 }], targets: [{ network: 'fb', pageId: '1000' }], scheduledAt: in20, action: 'approve' });
    const ph = callsTo('POST', /^1000\/photos$/).pop();
    const pSched = r.json.post;
    check('FB scheduled photo -> Facebook\'s own scheduler (published=false + scheduled_publish_time)', r.status === 200 && pSched.status === 'scheduled' && ph && ph.q.published === 'false' && Math.abs(Number(ph.q.scheduled_publish_time) * 1000 - new Date(in20).getTime()) < 2000, r.json && (r.json.error || pSched.status));
    await db.collection('socialposts').updateOne({ _id: oidOf(pSched._id) }, { $set: { scheduledAt: new Date(Date.now() - 5 * 60e3) } });
    await A('POST', '/run-publisher', admin);
    r = await A('GET', '/posts/' + pSched._id, admin);
    check('after its time, the scheduled FB post is confirmed published', r.json.post.status === 'published' && !!r.json.post.targets[0].permalink, r.json.post.status);

    r = await A('POST', '/posts', admin, { caption: 'Three photos', media: ['a', 'b', 'c'].map(x => ({ url: `https://res.cloudinary.com/demo/image/upload/${x}.jpg` })), targets: [{ network: 'fb', pageId: '1001' }], action: 'approve' });
    const unpub = callsTo('POST', /^1001\/photos$/).filter(x => x.q.published === 'false');
    feed = callsTo('POST', /^1001\/feed$/).pop();
    check('FB carousel: 3 unpublished photos, then one post with attached_media', r.json.post.status === 'published' && unpub.length === 3 && feed && JSON.parse(feed.q.attached_media).length === 3);
    r = await A('POST', '/posts', admin, { caption: 'A video', media: [{ url: 'https://res.cloudinary.com/demo/video/upload/v.mp4', type: 'video' }], targets: [{ network: 'fb', pageId: '1000' }], action: 'approve' });
    const vid = callsTo('POST', /^1000\/videos$/).pop();
    check('FB video -> /videos with file_url and description', r.json.post.status === 'published' && vid && vid.q.file_url.endsWith('v.mp4') && vid.q.description === 'A video');
    r = await A('POST', '/posts', admin, { caption: 'Read more at https://glrarealty.com/tools.html', link: 'https://glrarealty.com/property/abc', targets: [{ network: 'fb', pageId: '1000' }], action: 'approve' });
    const pLink = r.json.post;
    feed = callsTo('POST', /^1000\/feed$/).pop();
    check('link post: the website link carries UTM tags naming the post and Page', feed && feed.q.link.includes('utm_source=facebook') && feed.q.link.includes('utm_content=sp-' + pLink._id + '-1000') && feed.q.message.includes('utm_campaign=social'), feed && feed.q.link);
    r = await A('POST', '/posts', admin, { caption: 'Outside link https://example.com/x', link: 'https://example.com/y', targets: [{ network: 'fb', pageId: '1000' }], action: 'approve' });
    feed = callsTo('POST', /^1000\/feed$/).pop();
    check('links to other sites are left alone', feed.q.link === 'https://example.com/y' && feed.q.message === 'Outside link https://example.com/x');

    // ── 7. Instagram: now, scheduled (our clock), video container, crop ──
    r = await A('POST', '/posts', admin, { caption: 'IG now #Sondris', media: [{ url: 'https://res.cloudinary.com/demo/image/upload/tall.jpg', width: 1000, height: 2000 }], targets: [{ network: 'ig', pageId: '1000' }], action: 'approve' });
    let cont = callsTo('POST', /^2000\/media$/).pop();
    check('IG photo now -> container + media_publish -> published with permalink', r.json.post.status === 'published' && callsTo('POST', /^2000\/media_publish$/).length === 1 && /instagram\.com/.test(r.json.post.targets[0].permalink), r.json.post && r.json.post.status);
    check('IG photo URL: cropped to 4:5 and converted to JPEG by Cloudinary', cont && /c_fill,g_auto,ar_4:5/.test(cont.q.image_url) && /f_jpg/.test(cont.q.image_url), cont && cont.q.image_url);
    r = await A('POST', '/posts', admin, { caption: 'IG later', media: [{ url: 'https://res.cloudinary.com/demo/image/upload/sq.jpg', width: 1080, height: 1080 }], targets: [{ network: 'ig', pageId: '1001' }, { network: 'fb', pageId: '1001' }], scheduledAt: in20, action: 'approve' });
    const pIg = r.json.post;
    const igT = pIg.targets.find(t => t.network === 'ig');
    check('IG scheduled -> waits for our clock (no Instagram call yet); FB part natively scheduled', igT.status === 'waiting' && !callsTo('POST', /^2001\//).length && pIg.targets.find(t => t.network === 'fb').status === 'scheduled', igT.status);
    await A('POST', '/run-publisher', admin);
    check('the clock does not publish before the time', !callsTo('POST', /^2001\//).length);
    await db.collection('socialposts').updateOne({ _id: oidOf(pIg._id) }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
    await A('POST', '/run-publisher', admin);
    r = await A('GET', '/posts/' + pIg._id, admin);
    check('at its time the clock publishes the Instagram part', r.json.post.targets.find(t => t.network === 'ig').status === 'published' && callsTo('POST', /^2001\/media_publish$/).length === 1);
    await A('POST', '/run-publisher', admin);
    check('running the clock again publishes nothing twice', callsTo('POST', /^2001\/media_publish$/).length === 1);
    r = await A('POST', '/posts', admin, { caption: 'IG reel', media: [{ url: 'https://res.cloudinary.com/demo/video/upload/r.mp4', type: 'video' }], targets: [{ network: 'ig', pageId: '1000' }], action: 'approve' });
    const pReel = r.json.post;
    check('IG video -> container processing first', pReel.targets[0].status === 'container' && callsTo('POST', /^2000\/media$/).pop().q.media_type === 'REELS', pReel.targets[0].status);
    await A('POST', '/run-publisher', admin);
    r = await A('GET', '/posts/' + pReel._id, admin);
    check('still processing at the next minute -> keeps waiting', r.json.post.targets[0].status === 'container', r.json.post.targets[0].status);
    await A('POST', '/run-publisher', admin);
    r = await A('GET', '/posts/' + pReel._id, admin);
    check('when Meta finishes processing, the clock publishes the reel', r.json.post.status === 'published', r.json.post.status);
    r = await A('POST', '/posts', admin, { caption: 'IG carousel', media: ['p', 'q'].map(x => ({ url: `https://res.cloudinary.com/demo/image/upload/${x}.jpg` })), targets: [{ network: 'ig', pageId: '1000' }], action: 'approve' });
    cont = callsTo('POST', /^2000\/media$/).slice(-3);
    check('IG carousel: 2 child containers + CAROUSEL container', r.json.post.status === 'published' && cont[0].q.is_carousel_item === 'true' && cont[2].q.media_type === 'CAROUSEL' && cont[2].q.children.split(',').length === 2);

    // ── 8. retries, failures, retry-needs-approval, cancel, delete ──
    const before613 = callsTo('POST', /^1000\/feed$/).length;
    r = await A('POST', '/posts', admin, { caption: 'Rate limited FAIL613ONCE', targets: [{ network: 'fb', pageId: '1000' }], action: 'approve' });
    check('Meta 613 (rate limit) on publish -> backed off, retried, published once', r.json.post.status === 'published' && callsTo('POST', /^1000\/feed$/).length === before613 + 2, callsTo('POST', /^1000\/feed$/).length - before613 + ' calls');
    r = await A('POST', '/posts', admin, { caption: 'No permission FAILPERM', targets: [{ network: 'fb', pageId: '1000' }], action: 'approve' });
    const pFail = r.json.post;
    check('a refused publish -> failed with Meta\'s reason', pFail.status === 'failed' && /authorized/.test(pFail.targets[0].error), pFail.targets[0].error);
    r = await A('POST', `/posts/${pFail._id}/retry`, staff.token);
    check('retry by staff -> back to waiting for approval (not published)', r.status === 200 && r.json.post.status === 'pending');
    stub.failPerm = false;
    r = await A('POST', `/posts/${pFail._id}/approve`, admin);
    check('approved retry publishes', r.json.post.status === 'published');
    r = await A('POST', '/posts', admin, { caption: 'To cancel', targets: [{ network: 'fb', pageId: '1002' }], scheduledAt: in20, action: 'approve' });
    const pCancel = r.json.post;
    r = await A('POST', `/posts/${pCancel._id}/cancel`, admin);
    check('cancel a FB scheduled post -> DELETE on Facebook, cancelled', r.json.post.status === 'cancelled' && callsTo('DELETE', new RegExp('^' + pCancel.targets[0].metaId + '$')).length === 1);
    r = await A('POST', `/posts/${pReel._id}/delete-remote`, admin, { targetId: pReel.targets[0]._id });
    check('delete an Instagram post -> refused with an explanation', r.status === 400 && /Instagram app/.test(r.json.error));
    r = await A('GET', '/posts/' + p1._id, admin);
    r = await A('POST', `/posts/${p1._id}/delete-remote`, staff.token, { targetId: r.json.post.targets[0]._id });
    check('staff delete-remote -> 403', r.status === 403);
    r = await A('GET', '/posts/' + p1._id, admin);
    const metaId1 = r.json.post.targets[0].metaId;
    r = await A('POST', `/posts/${p1._id}/delete-remote`, admin, { targetId: r.json.post.targets[0]._id });
    check('admin deletes a published FB post -> DELETE + Audit Log', r.status === 200 && callsTo('DELETE', new RegExp('^' + metaId1 + '$')).length === 1 && !!(await db.collection('auditlogs').findOne({ action: 'SOCIAL_DELETE_POST' })));
    r = await A('POST', '/posts', staff.token, { caption: 'mine', targets: [{ network: 'fb', pageId: '1000' }] });
    const own = r.json.post;
    r = await A('PUT', '/posts/' + own._id, cath.token, { caption: 'edited by approver', targets: [{ network: 'fb', pageId: '1000' }] });
    check('approver can edit a staff draft', r.status === 200 && r.json.post.caption === 'edited by approver');
    r = await A('POST', '/posts', admin, { caption: 'admin draft', targets: [{ network: 'fb', pageId: '1000' }] });
    const adm = r.json.post;
    r = await A('PUT', '/posts/' + adm._id, staff.token, { caption: 'hijack', targets: [{ network: 'fb', pageId: '1000' }] });
    check('staff cannot edit someone else\'s post', r.status === 403);
    r = await A('POST', `/posts/${adm._id}/duplicate`, staff.token);
    check('duplicate makes a new draft', r.status === 200 && r.json.post.status === 'draft' && r.json.post._id !== adm._id);
    r = await A('DELETE', '/posts/' + own._id, staff.token);
    check('discard own draft', r.status === 200);
    r = await A('POST', `/posts/${p1._id}/approve`, admin);
    check('a published post cannot be approved again', r.status === 409);

    // ── 9. templates, hashtag sets, listing studio, AI ──
    r = await A('POST', '/templates', staff.token, { kind: 'hashtags', name: 'Too many', text: Array.from({ length: 31 }, (_, i) => '#t' + i).join(' ') });
    check('hashtag set over 30 refused', r.status === 400);
    r = await A('POST', '/templates', staff.token, { kind: 'hashtags', name: 'Makati', text: '#Makati #CondoForSale #GLRARealty' });
    check('hashtag set saved', r.status === 200);
    r = await A('POST', '/templates', staff.token, { kind: 'reply', name: 'Price question', text: 'Hi! The price list is in your inbox.' });
    const tplReply = r.json.template;
    r = await A('POST', '/templates', staff.token, { kind: 'caption', name: 'Open house', text: 'Open house at {property} ({area}) this weekend: {link}' });
    check('caption template + saved reply saved', r.status === 200 && !!tplReply);
    r = await A('DELETE', '/templates/' + tplReply._id, viewer.token);
    check('viewer cannot delete templates', r.status === 403);
    r = await A('GET', '/listings', staff.token);
    const lst = r.json.listings.find(l => l.photos >= 3) || r.json.listings[0];
    check('live listings for "Post a listing"', r.status === 200 && r.json.listings.length > 10);
    r = await A('GET', `/listings/${lst.id}/studio?pageId=1000,1002`, staff.token);
    const st = r.json;
    check('studio: carousel of the listing photos (max 8), link to the listing', st.media.length >= 1 && st.media.length <= 8 && st.link.endsWith('/property/' + lst.id));
    check('studio: a Facebook and an Instagram caption per Page, hashtags, Kate signs as Kate', st.perPage['1000'].fb.includes(st.link) && /#GLRARealty/.test(st.perPage['1000'].ig) && st.perPage['1000'].ig.length <= 2200 && /Kate Sampayo/.test(st.perPage['1002'].fb) && st.perPage['1002'].hashtags.includes('#KateSampayoRealtor'));
    r = await A('POST', '/ai/caption', staff.token, { brief: 'open house Saturday', tone: 'warm_taglish', propertyId: lst.id, pageId: '1000' });
    check('AI caption: Facebook + Instagram versions + hashtags, draft only', r.status === 200 && /FB draft/.test(r.json.facebook) && /IG draft/.test(r.json.instagram) && r.json.hashtags.includes('#Sondris') && r.json.draftOnly === true, r.json && (r.json.error || r.json.facebook));
    check('AI got the listing facts and the tone', stub.llm.some(x => x.user.includes(lst.title) && /Taglish/.test(x.user)));
    check('AI wrote nothing to the posts', !(await db.collection('socialposts').findOne({ caption: /FB draft/ })));
    r = await A('POST', '/ai/caption', staff.token, { brief: 'AIFAIL please' });
    check('AI service failure -> a clear error, nothing else', r.status === 502 && /AI/.test(r.json.error));
    r = await A('POST', '/ai/caption', viewer.token, { brief: 'x' });
    check('viewer cannot use AI writing (draft permission)', r.status === 403);

    // ── 10. media library ──
    r = await A('POST', '/media/url', staff.token, { url: 'http://insecure.example/a.jpg' });
    check('media link must be https', r.status === 400);
    r = await A('POST', '/media/url', staff.token, { url: 'https://res.cloudinary.com/demo/image/upload/wide.jpg', width: 3000, height: 1000 });
    check('media registered, too wide for IG -> crop suggestion', r.status === 200 && r.json.media.ig.ok === false && /ar_191:100/.test(r.json.media.ig.fixUrl));
    const fd = new FormData(); fd.append('file', new Blob([Buffer.from('ffd8ffe000', 'hex')], { type: 'image/jpeg' }), 'x.jpg');
    const up = await fetch(BASE + '/api/admin/social/media/upload', { method: 'POST', headers: { authorization: 'Bearer ' + staff.token }, body: fd });
    check('upload without Cloudinary configured -> 503 with an explanation', up.status === 503);

    // ── 11. CSV bulk + approve the batch in one click ──
    const day = new Date(Date.now() + 3 * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
    const badCsv = `date,time,pages,networks,caption,media,link\n${day},19:00,GLRA Realty,ig,"text only",,\n`;
    r = await A('POST', '/bulk', staff.token, { csv: badCsv });
    check('CSV preview flags an Instagram text-only row', r.status === 200 && r.json.preview[0].problems.some(p => /Instagram/.test(p)));
    r = await A('POST', '/bulk', staff.token, { csv: badCsv, commit: true });
    check('CSV with a bad row is not imported', r.status === 400);
    const goodCsv = `date,time,pages,networks,caption,media,link\n${day},19:00,all,fb,"Week tip one",,\n${day},20:00,Kate,fb,"Week tip two",,https://glrarealty.com/tools.html\n`;
    r = await A('POST', '/bulk', staff.token, { csv: goodCsv, commit: true });
    const batch = r.json.batchId;
    check('CSV imported: 2 rows -> 2 posts waiting (row 1 = 3 Pages)', r.status === 200 && r.json.created === 2);
    r = await A('GET', '/approvals', admin);
    check('Approvals lists the batch', r.json.batches.some(b => b.id === batch && b.n === 2));
    r = await A('POST', '/posts/approve-batch', staff.token, { batchId: batch });
    check('staff cannot approve a batch', r.status === 403);
    r = await A('POST', '/posts/approve-batch', admin, { batchId: batch });
    check('one click approves the whole batch -> scheduled on Facebook', r.status === 200 && r.json.results.length === 2 && r.json.results.every(x => x.ok && x.status === 'scheduled'), JSON.stringify(r.json.results));

    // ── 12. recurring ──
    r = await A('POST', '/recurring', staff.token, { name: 'Listing of the week', mode: 'listing', weekday: (new Date(Date.now() + 8 * 3600e3).getUTCDay() + 2) % 7, time: '19:00', targets: [{ network: 'fb', pageId: '1000' }, { network: 'ig', pageId: '1000' }] });
    const rule = r.json.rule;
    check('recurring rule saved', r.status === 200 && rule.mode === 'listing');
    r = await A('POST', `/recurring/${rule._id}/run`, staff.token);
    const rp = r.json.post;
    check('recurring run makes a post WAITING FOR APPROVAL with a listing carousel', r.status === 200 && rp.status === 'pending' && rp.origin === 'recurring' && rp.media.length >= 1 && !!rp.propertyId && rp.scheduledAt);
    r = await A('POST', `/recurring/${rule._id}/run`, staff.token);
    check('the same week is not drafted twice', r.status === 409);

    // ── 13. inbox: webhooks ──
    r = await deliver({ object: 'page', entry: [] }, 'sha256=' + 'b'.repeat(64));
    check('webhook with a bad signature -> 403', r.status === 403);
    const T = Date.now();
    await deliver({ object: 'page', entry: [{ id: '1001', time: T, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: '1001_9_601', post_id: '1001_9', parent_id: '1001_9', from: { id: '7401', name: 'Comment Person' }, message: 'How much is this? Call me 0917 555 1234 or mail me at buyer@example.com', created_time: Math.floor(T / 1000) } }] }] });
    await deliver({ object: 'instagram', entry: [{ id: '2000', time: T, changes: [{ field: 'comments', value: { id: '17900777', text: 'Pwede po bang tripping sa Saturday? email me viewer@example.com', from: { id: '9903', username: 'ig.viewer' }, media: { id: '91' } } }] }] });
    await deliver({ object: 'page', entry: [{ id: '1002', time: T, messaging: [{ sender: { id: '7101' }, recipient: { id: '1002' }, timestamp: T, message: { mid: 'm_k1', text: 'Hi Kate, is the BGC unit still available? My number is +63 917 222 3333' } }] }] });
    const old = T - 25 * 3600e3;
    await deliver({ object: 'page', entry: [{ id: '1000', time: old, messaging: [{ sender: { id: '7102' }, recipient: { id: '1000' }, timestamp: old, message: { mid: 'm_old1', text: 'Old question from yesterday' } }] }] });
    const th = await until(async () => { const x = (await A('GET', '/inbox?status=all', admin)).json.threads; return x.length >= 4 ? x : null; });
    const thC = th && th.find(t => t.key === 'c:1001_9_601'), thI = th && th.find(t => t.key === 'c:17900777'), thM = th && th.find(t => t.key === 'messenger:1002:7101'), thOld = th && th.find(t => t.key === 'messenger:1000:7102');
    check('FB comment on the second Page lands in the inbox (Page 1001)', thC && thC.pageId === '1001' && thC.name === 'Comment Person');
    check('auto-tags: price question; Tagalog viewing request', thC && thC.autoTags.includes('price') && thI && thI.autoTags.includes('viewing'), thC && thC.autoTags.join(','));
    check('Instagram comment routed to the Page that owns the account', thI && thI.pageId === '1000' && thI.kind === 'ig_comment');
    check('Messenger message on Kate\'s Page, name from the profile', thM && thM.pageId === '1002' && thM.name === 'Maria Santos' && thM.window.open === true);
    const lead = await until(() => db.collection('leads').findOne({ metaIds: 'fb:7101' }));
    check('the same message also reached Leads (meta.js inbox kept working)', !!lead);
    await deliver({ object: 'page', entry: [{ id: '1001', time: T + 5000, messaging: [{ sender: { id: '1001' }, recipient: { id: '7501' }, timestamp: T + 5000, message: { mid: 'm_own1', text: 'Hello from the Land Title Page' } }] }] });
    await sleep(1200);
    check('a message sent by a second Page (no echo flag) is not mistaken for a customer', !(await db.collection('leads').findOne({ metaIds: 'fb:1001' })) && !!(await db.collection('socialitems').findOne({ metaId: 'm_own1', own: true })));
    r = await A('GET', '/inbox/thread?key=' + encodeURIComponent('c:1001_9_601'), viewer.token);
    check('viewer can read a thread', r.status === 200 && r.json.items.length === 1);

    // ── 14. inbox actions: approval-gated ──
    r = await A('POST', '/inbox/actions', staff.token, { threadKey: thM.key, kind: 'reply', text: 'Yes po, available. When can you view?' });
    const act1 = r.json.action;
    check('staff reply -> waits for approval, nothing sent', r.status === 200 && r.json.waiting && !callsTo('POST', /\/messages$/).length);
    r = await A('POST', '/inbox/actions', staff.token, { threadKey: thM.key, kind: 'reply', text: 'now!', sendNow: true });
    check('staff "send now" -> 403', r.status === 403 && !callsTo('POST', /\/messages$/).length);
    r = await A('POST', `/actions/${act1._id}/approve`, staff.token);
    check('staff approving a reply -> 403', r.status === 403);
    r = await A('POST', `/actions/${act1._id}/approve`, admin);
    const msg = callsTo('POST', /^1002\/messages$/).pop();
    check('approved reply sent through the Page with messaging_type RESPONSE', r.status === 200 && msg && JSON.parse(msg.q.recipient).id === '7101' && msg.q.messaging_type === 'RESPONSE' && JSON.parse(msg.q.message).text.startsWith('Yes po') && msg.token === 'page-tok-1002');
    r = await A('GET', '/inbox/thread?key=' + encodeURIComponent(thM.key), admin);
    check('the reply shows in the thread and the thread is answered', r.json.items.some(i => i.own) && r.json.thread.waiting === false);
    r = await A('POST', '/inbox/actions', admin, { threadKey: thOld.key, kind: 'reply', text: 'Sorry for the delay' });
    check('24-hour window: reply to a 25-hour-old message refused, with the reason', r.status === 400 && /24 hours/.test(r.json.error));
    r = await A('POST', '/inbox/actions', staff.token, { threadKey: thM.key, kind: 'reply', text: 'Follow-up' });
    const act2 = r.json.action;
    await db.collection('socialthreads').updateOne({ key: thM.key }, { $set: { lastInboundAt: new Date(Date.now() - 25 * 3600e3) } });
    r = await A('POST', `/actions/${act2._id}/approve`, admin);
    check('window closed between draft and approval -> not sent', r.status === 502 && /24 hours/.test(r.json.error) && callsTo('POST', /^1002\/messages$/).length === 1);
    r = await A('GET', '/inbox/thread?key=' + encodeURIComponent('c:1001_9_601'), admin);
    const cItem = r.json.items[0];
    r = await A('POST', '/inbox/actions', admin, { itemId: cItem._id, threadKey: 'c:1001_9_601', kind: 'reply', text: 'Sent you a message po!', sendNow: true });
    check('approver comment reply -> POST {comment}/comments', r.status === 200 && callsTo('POST', /^1001_9_601\/comments$/).length === 1);
    r = await A('POST', '/inbox/actions', staff.token, { itemId: cItem._id, kind: 'hide' });
    const hideAct = r.json.action;
    check('staff hide -> waits for approval', r.status === 200 && !callsTo('POST', /^1001_9_601$/).length);
    r = await A('POST', `/actions/${hideAct._id}/approve`, admin);
    const hid = callsTo('POST', /^1001_9_601$/).pop();
    check('approved hide -> is_hidden=true on Facebook', r.status === 200 && hid && hid.q.is_hidden === 'true');
    r = await A('GET', '/inbox/thread?key=c:17900777', admin);
    const igItem = r.json.items[0];
    await A('POST', '/inbox/actions', admin, { itemId: igItem._id, kind: 'hide', sendNow: true });
    check('Instagram hide uses hide=true', callsTo('POST', /^17900777$/).pop().q.hide === 'true');
    await A('POST', '/inbox/actions', admin, { itemId: igItem._id, kind: 'reply', text: 'Yes po!', sendNow: true });
    check('Instagram comment reply -> /replies', callsTo('POST', /^17900777\/replies$/).length === 1);
    r = await A('POST', '/inbox/actions', staff.token, { itemId: cItem._id, kind: 'delete' });
    const delAct = r.json.action;
    r = await A('POST', `/actions/${delAct._id}/reject`, admin, { note: 'keep it' });
    check('approver can decline an action; nothing deleted', r.status === 200 && !callsTo('DELETE', /^1001_9_601$/).length);
    r = await A('POST', '/inbox/actions', admin, { itemId: cItem._id, kind: 'delete', sendNow: true });
    check('approved delete -> DELETE + Audit Log', r.status === 200 && callsTo('DELETE', /^1001_9_601$/).length === 1 && !!(await db.collection('auditlogs').findOne({ action: 'SOCIAL_DELETE_COMMENT' })));
    r = await A('POST', '/inbox/actions', admin, { threadKey: thM.key, kind: 'hide' });
    check('messages cannot be hidden -> 400', r.status === 400);
    r = await A('PATCH', '/inbox/thread', staff.token, { key: thC.key, tags: ['price', 'viewing', 'bogus'], assignTo: staff.id });
    check('tags + assignment saved (unknown tags dropped)', r.status === 200 && r.json.thread.tags.join(',') === 'price,viewing' && r.json.thread.assignedTo.id === staff.id);
    r = await A('GET', '/inbox?assigned=me&status=all', staff.token);
    check('"assigned to me" filter', r.json.threads.length === 1 && r.json.threads[0].key === thC.key);
    r = await A('POST', '/ai/reply', staff.token, { threadKey: thM.key });
    check('Suggest a reply -> draft text only, nothing sent', r.status === 200 && /parking/.test(r.json.text) && callsTo('POST', /^1002\/messages$/).length === 1);
    check('the AI never saw the customer\'s phone or email', !stub.llm.some(x => /0917 555 1234|buyer@example\.com/.test(x.user)));

    // ── 15. unanswered + summary + sync ──
    await A('PUT', '/settings', admin, { unansweredHours: 1 });
    r = await A('GET', '/inbox?status=all', admin);
    check('unanswered flag after N hours (old message)', r.json.threads.find(t => t.key === thOld.key).unanswered === true && r.json.threads.find(t => t.key === thI.key).unanswered === false);
    r = await A('GET', '/badge', staff.token);
    check('badge: waiting approvals + unanswered', r.json.pending >= 1 && r.json.unanswered >= 1, JSON.stringify(r.json));
    r = await A('POST', '/inbox/sync', staff.token);
    check('inbox check by hand is approver-only', r.status === 403);
    r = await A('POST', '/inbox/sync', admin);
    check('10-minute check pulls conversations and comments the webhook missed', r.status === 200 && r.json.added >= 8, 'added ' + (r.json && r.json.added));
    check('a surface waiting for App Review is marked on its own', r.json.status['1001.ig_dm'].ok === false && r.json.status['1001.ig_comment'].ok === false && r.json.status['1000.ig_comment'].ok === true && r.json.status['1001.fb_comment'].ok === true);
    const synced = await db.collection('socialthreads').findOne({ key: 'c:1000_1_501' });
    check('synced comment thread: the Page reply counts as answered', synced && synced.firstReplyAt && synced.name === 'Feed Commenter');
    r = await A('POST', '/inbox/sync', admin);
    check('a second check adds nothing', r.json.added === 0);
    r = await A('GET', '/inbox/summary', viewer.token);
    check('unanswered dashboard per Page', r.status === 200 && r.json.pages.length === 3 && r.json.pages.every(p => typeof p.waiting === 'number'));

    // ── 16. insights, best time, ads (read-only), leads per post, CSV, PDF ──
    await db.collection('leads').insertOne({ name: 'Post Lead', emails: ['post.lead@example.com'], phones: [], metaIds: [], sources: [{ kind: 'inquiry', at: new Date(), attrib: { src: 'facebook', med: 'social', cmp: 'social', cnt: `sp-${pLink._id}-1000` } }],
      firstTouch: { src: 'facebook', med: 'social', cmp: 'social', cnt: `sp-${pLink._id}-1000`, at: new Date() }, activities: [], stage: 'new', createdAt: new Date(), updatedAt: new Date() });
    await db.collection('socialposts').updateOne({ _id: oidOf(pLink._id) }, { $set: { 'targets.0.metaId': '1000_1' } });
    r = await A('POST', '/insights/refresh', staff.token);
    check('insights refresh is approver-only', r.status === 403);
    r = await A('POST', '/insights/refresh', admin);
    check('insights snapshot per Page + posts read', r.status === 200 && r.json.rows > 60 && r.json.posts >= 8, 'rows ' + r.json.rows + ', posts ' + r.json.posts);
    const yday = new Date(Date.now() + 8 * 3600e3 - 864e5).toISOString().slice(0, 10), from = new Date(Date.now() + 8 * 3600e3 - 30 * 864e5).toISOString().slice(0, 10);
    r = await A('GET', `/insights?from=${from}&to=${yday}`, viewer.token);
    const g = r.json.pages.find(p => p.page.id === '1000');
    const tl = (s, k) => (g.tiles[s] || []).find(t => t.key === k) || {};
    check('per-Page tiles: Facebook reach and Instagram reach', tl('fb', 'page_total_media_view_unique').value > 10000 && tl('ig', 'reach').value > 10000);
    check('a retired metric marks only its own tile', tl('fb', 'page_daily_follows_unique').status === 'retired' && tl('fb', 'page_media_view').status === 'ok');
    check('no Instagram tiles for the Page without Instagram', !r.json.pages.find(p => p.page.id === '1002').tiles.ig);
    check('leads from posts: the post linked to the lead shows it', g.leads === 1 && g.top.some(x => x.metaId === '1000_1' && x.leads === 1));
    r = await A('GET', '/posts?limit=300', admin);
    check('the post itself shows "1 lead"', r.json.posts.find(p => p._id === pLink._id).leads.total === 1);
    r = await A('GET', '/insights/heatmap', viewer.token);
    check('best-time heatmap: 7x24 grid and 3 next slots', r.json.grid.length === 7 && r.json.grid[0].length === 24 && r.json.slots.length === 3 && r.json.slots.every(s => new Date(s.at) > new Date()));
    r = await A('GET', `/insights/ads?from=${from}&to=${yday}`, viewer.token);
    check('ads: campaign spend, leads (not double counted), cost per lead', r.json.campaigns[0].name === 'Sondris Leads Oct 2026' && r.json.campaigns[0].leads === 25 && r.json.totals.cpl === 200.02, JSON.stringify(r.json.totals));
    r = await req('GET', `/api/admin/social/insights.csv?from=${from}&to=${yday}`, { token: viewer.token });
    check('insights CSV export', r.status === 200 && /^\uFEFFdate,page,surface/.test(r.text) && /GLRA Realty/.test(r.text));
    r = await req('GET', `/api/admin/social/report.pdf?from=${from}&to=${yday}`, { token: viewer.token });
    check('report PDF', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF' && r.buf.length > 3000, r.buf.length + ' bytes');
    const mb = newMail().length;
    r = await A('POST', '/report/send', admin);
    const wk = await until(() => newMail().slice(mb).find(h => /Your Pages last week/.test(h)));
    check('weekly report email: per Page, leads, next-week tips', r.status === 200 && wk && /What to do next week/.test(wk) && /GLRA Land Title/.test(wk));
    r = await A('GET', '/calendar', viewer.token);
    check('calendar: our posts plus posts made outside GLRA Social', r.json.items.some(i => i.kind === 'post' && i.status === 'scheduled') && r.json.items.some(i => i.kind === 'external'));

    // ── 17. approve by email link ──
    r = await A('POST', '/posts', staff.token, { caption: 'Approve me by email', targets: [{ network: 'fb', pageId: '1000' }], action: 'submit' });
    const pMail = r.json.post;
    const linkMail = await until(() => newMail().find(h => h.includes('Approve me by email') && /social-approve\.html#t=/.test(h)));
    const tok = linkMail && (linkMail.match(/#t=([A-Za-z0-9_-]+)/) || [])[1];
    r = await req('POST', '/api/social/link/view', { body: { t: tok } });
    check('email link opens the post without signing in', r.status === 200 && r.json.kind === 'post' && r.json.post._id === pMail._id);
    r = await req('POST', '/api/social/link/view', { body: { t: 'x'.repeat(30) } });
    check('a made-up link -> refused', r.status === 404);
    r = await req('POST', '/api/social/link/decide', { body: { t: tok, decision: 'approve' } });
    check('approve from the email -> published, logged as email link', r.status === 200 && r.json.status === 'published' && !!(await db.collection('sociallogs').findOne({ via: 'email_link', action: 'approved' })));
    r = await req('POST', '/api/social/link/decide', { body: { t: tok, decision: 'approve' } });
    check('the link works once', r.status === 410);
    r = await A('POST', '/posts', staff.token, { caption: 'Expired link post', targets: [{ network: 'fb', pageId: '1000' }], action: 'submit' });
    const pExp = r.json.post;
    const expMail = await until(() => newMail().find(h => h.includes('Expired link post')));
    const tok2 = (expMail.match(/#t=([A-Za-z0-9_-]+)/) || [])[1];
    await db.collection('sociallinktokens').updateMany({ ref: pExp._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    r = await req('POST', '/api/social/link/decide', { body: { t: tok2, decision: 'approve' } });
    check('an expired link -> refused, post still waiting', r.status === 410 && (await A('GET', '/posts/' + pExp._id, admin)).json.post.status === 'pending');
    r = await A('POST', '/posts', staff.token, { caption: 'Revoked approver post', targets: [{ network: 'fb', pageId: '1000' }], action: 'submit' });
    const revMails = await until(() => { const m = newMail().filter(h => h.includes('Revoked approver post')); return m.length >= 2 ? m : null; });
    const cathTok = await db.collection('sociallinktokens').find({ ref: r.json.post._id, accountId: cath.id }).toArray();
    await req('PUT', '/api/admin/accounts/' + cath.id, { token: admin, body: { permissions: { social_approve: false } } });
    const cathMail = revMails && revMails.map(h => (h.match(/#t=([A-Za-z0-9_-]+)/) || [])[1]).find(t => cathTok.some(x => x.hash === crypto.createHash('sha256').update(t).digest('hex')));
    r = await req('POST', '/api/social/link/decide', { body: { t: cathMail, decision: 'approve' } });
    check('a link stops working when its approver loses social_approve', r.status === 403, r.status);

    // ── 18. Claude review key ──
    r = await req('GET', '/api/social/review/summary');
    check('review feed without a key -> 401', r.status === 401);
    r = await A('POST', '/review-key', cath.token);
    check('only an admin makes the review key', r.status === 403);
    r = await A('POST', '/review-key', admin);
    const key = r.json.key;
    check('review key made (shown once, only the hash stored)', /^glra_sr_[a-f0-9]{64}$/.test(key) && !JSON.stringify(await db.collection('settings').findOne({ key: 'social_review_key' })).includes(key));
    const K = { 'x-glra-review-key': key };
    r = await req('GET', '/api/social/review/summary?days=30', { headers: K });
    check('review summary: Pages, insights, rhythm, reply speed, ads, best time', r.status === 200 && r.json.pages.length === 3 && r.json.insights.length === 3 && r.json.rhythm.length === 3 && r.json.ads.campaigns.length === 2 && r.json.bestTime.slots.length === 3);
    r = await req('GET', '/api/social/review/posts?days=90', { headers: K });
    check('review posts: published posts with engagement', r.status === 200 && r.json.published.length >= 4 && r.json.published.some(p => p.reach != null));
    r = await req('GET', '/api/social/review/inbox?days=30', { headers: K });
    const blob = JSON.stringify(r.json);
    check('review inbox: names masked to initials, no phone numbers or emails, no raw ids', r.status === 200 && /"C\. P\."/.test(blob) && !/Comment Person|Maria Santos|917 222 3333|viewer@example\.com|ig\.viewer|7401|7101/.test(blob) && /\[phone\]/.test(blob) && /\[email\]/.test(blob), JSON.stringify([/"C\. P\."/.test(blob), blob.match(/.{40}(Comment Person|Maria Santos|917 222 3333|viewer@example\.com|ig\.viewer|7401|7101).{20}/), /\[phone\]/.test(blob), /\[email\]/.test(blob)]));
    const ref = r.json.threads.find(t => t.kind === 'ig_comment').ref;
    r = await req('POST', '/api/social/review/drafts', { headers: K, body: { caption: 'Draft from Claude: 3 tips for first-time buyers', targets: [{ network: 'fb', pageId: '1000' }] } });
    const cd = r.json;
    const cdoc = await db.collection('socialposts').findOne({ _id: oidOf(cd.id) });
    check('review key draft -> WAITING FOR APPROVAL, made by the review key', r.status === 200 && cd.status === 'pending' && cdoc.createdBy.via === 'review_key' && cdoc.origin === 'review_key');
    r = await req('POST', '/api/social/review/reply-drafts', { headers: K, body: { threadRef: ref, text: 'Thank you! We will send the details.' } });
    check('review key reply draft -> waits for approval, nothing sent', r.status === 200 && r.json.status === 'pending' && callsTo('POST', /^1002\/messages$/).length === 1);
    for (const [m, u] of [['POST', '/api/social/review/approve'], ['POST', '/api/social/review/publish'], ['POST', `/api/social/review/posts/${cd.id}/approve`], ['DELETE', '/api/social/review/posts'], ['POST', '/api/social/review/hide']]) {
      r = await req(m, u, { headers: K, body: {} });
      check(`review key cannot ${m} ${u.replace('/api/social/review', '')} -> 404`, r.status === 404, r.status);
    }
    r = await req('POST', `/api/admin/social/posts/${cd.id}/approve`, { headers: K, body: {} });
    check('review key on the admin approve route -> 401', r.status === 401);
    check('the review key\'s draft is still waiting', (await db.collection('socialposts').findOne({ _id: oidOf(cd.id) })).status === 'pending');
    const rvCalls = await db.collection('sociallogs').countDocuments({ via: 'review_key' });
    check('every review-key call is in the activity log', rvCalls >= 6, rvCalls + ' rows');
    r = await A('DELETE', '/review-key', admin);
    r = await req('GET', '/api/social/review/summary', { headers: K });
    check('revoked key -> 401', r.status === 401);

    // ── 19. activity log, settings, security sweep ──
    r = await A('GET', '/log?limit=1000', viewer.token);
    const acts = new Set(r.json.log.map(l => l.action));
    check('activity log: drafted, submitted, approved, rejected, published, scheduled, failed, replied, hidden, deleted, cancelled', ['drafted', 'submitted', 'approved', 'rejected', 'published', 'scheduled', 'failed', 'replied', 'hidden', 'deleted', 'cancelled'].every(a => acts.has(a)), [...acts].join(','));
    check('log rows carry who, Page and Meta id', r.json.log.some(l => l.action === 'published' && l.pageId && l.metaId && l.actor));
    r = await A('GET', '/log?action=deleted', admin);
    check('activity filter by action', r.json.log.length >= 2 && r.json.log.every(l => l.action === 'deleted'));
    r = await req('GET', '/api/admin/social/log.csv', { token: viewer.token });
    check('activity CSV export', r.status === 200 && /when \(UTC\),who,via,action/.test(r.text));
    r = await A('PUT', '/settings', staff.token, { unansweredHours: 9 });
    check('settings are approver-only', r.status === 403);
    check('every Graph call carried a correct appsecret_proof', stub.proofBad.length === 0, stub.proofBad.slice(0, 4).join(', '));
    check('no write to any ads / campaign / ad set / budget endpoint', !stub.calls.some(c => c.method !== 'GET' && /act_|campaign|adset|budget|\/ads\b/.test(c.path)));
    check('the only DELETEs were a comment, a scheduled post and a published post', callsTo('DELETE', /./).length === 3);
    const logs = JSON.stringify(await db.collection('sociallogs').find().toArray()) + JSON.stringify(await db.collection('metalogs').find().toArray());
    check('no token in the activity log or the Meta log', !/sys-test-token|page-tok-|glra_sr_/.test(logs));
    r = await req('GET', '/social.html');
    check('social.html served noindex, no-cache', r.status === 200 && /noindex/.test(r.headers.get('x-robots-tag') || '') && /no-cache/.test(r.headers.get('cache-control') || ''));
    r = await req('GET', '/api/health');
    check('server healthy at the end', r.status === 200);
  } finally {
    srv.close();
    await mongoose.disconnect().catch(() => {});
  }
}

(async () => {
  try {
    const h = await fetch(BASE + '/api/health').then(r => r.status).catch(() => 0);
    if (h !== 200) throw new Error('No local server answering at ' + BASE + ' (start the local stack first)');
    if (OFF) await offMode(); else await onMode();
  } catch (e) {
    check('test run finished without crashing', false, e.stack || e.message);
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
