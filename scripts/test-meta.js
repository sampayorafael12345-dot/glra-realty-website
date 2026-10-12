#!/usr/bin/env node
// =============================================================================
// Local test kit for server/meta.js (Facebook / Instagram)
// =============================================================================
// Sends signed fake webhooks to a RUNNING local server and checks what lands
// in the Leads tab, the Meta tab and the error log. Meta itself is never
// contacted: this script starts a small stub of the Graph API and of
// Telegram on STUB_PORT, and the local server is pointed at it.
//
// It starts no website itself. Start the local stack first, with these set:
//
//   META_LEADS_ENABLED=1 META_INSIGHTS_ENABLED=1 META_INBOX_ENABLED=1
//   META_APP_ID=111 META_APP_SECRET=test META_VERIFY_TOKEN=test
//   META_SYSTEM_TOKEN=sys-test-token META_PAGE_ID=1000 META_IG_USER_ID=2000
//   META_AD_ACCOUNT_ID=act_3000 META_RETRY_BASE_MS=100
//   META_GRAPH_BASE=http://127.0.0.1:4099 TELEGRAM_API_BASE=http://127.0.0.1:4099
//   TELEGRAM_BOT_TOKEN=12345:test-bot-token-abcdefghijklmnopqrstu TELEGRAM_CHAT_ID=999
//
// then:   node scripts/test-meta.js            (everything ON)
//         node scripts/test-meta.js --off      (stack started with no META_* switches: every route must be 404)
//
// Options (env): BASE (default http://localhost:4013), STUB_PORT (4099),
// ADMIN_EMAIL / ADMIN_PASSWORD (the local test admin), MAIL_DIR (where the
// local stack writes emails, default D:/GLRA/glra-dev-tools/mail-real).
// The sign-in limit is 5 per 15 minutes: one run signs in twice.
// =============================================================================
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:4013';
const STUB_PORT = Number(process.env.STUB_PORT || 4099);
const SECRET = 'test', VERIFY = 'test', SYS = 'sys-test-token', PAGE_TOK = 'page-test-token';
const PAGE = '1000', IG = '2000', ACT = '3000';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@glrarealty.com', password: process.env.ADMIN_PASSWORD || 'Test-Admin-Pass-2026!' };
const MAIL_DIR = process.env.MAIL_DIR || 'D:/GLRA/glra-dev-tools/mail-real';
const OFF = process.argv.includes('--off');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 10000); let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch (e) { /* keep waiting */ } await sleep(250); } return v; }

// ── HTTP helpers ──
async function req(method, url, { body, token, headers, raw } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.authorization = 'Bearer ' + token;
  let data = raw;
  if (body !== undefined && raw === undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(BASE + url, { method, headers: h, body: data });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, text, json };
}
const sign = buf => 'sha256=' + crypto.createHmac('sha256', SECRET).update(buf).digest('hex');
function deliver(payload, sig) {
  const raw = Buffer.from(JSON.stringify(payload));
  const headers = { 'content-type': 'application/json' };
  if (sig !== null) headers['x-hub-signature-256'] = sig === undefined ? sign(raw) : sig;
  return req('POST', '/api/meta/webhook', { raw, headers });
}
const leadgen = id => ({ object: 'page', entry: [{ id: PAGE, time: Math.floor(Date.now() / 1000), changes: [{ field: 'leadgen', value: { leadgen_id: id, page_id: PAGE, form_id: '5000', ad_id: '8000', created_time: Math.floor(Date.now() / 1000) } }] }] });

// ══ STUB GRAPH API + TELEGRAM ══════════════════════════════════
const now = Date.now();
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, '+0000');
const LEADS = {
  9001: { platform: 'fb', name: 'Juan Dela Cruz', email: 'juan.meta.test@example.com', phone: '0917 123 4567', prop: 'Sondris 2BR Pasig', optIn: 'Yes' },
  9002: { platform: 'fb', name: 'Juan D. Cruz', email: 'other.juan@example.com', phone: '+63 917 123 4567', prop: 'Liv Tower' },
  9003: { platform: 'ig', name: 'Ana Reyes', email: 'ana.ig.test@example.com', phone: '09181112222', prop: 'Una Lot' },
  613613: { platform: 'fb', name: 'Retry Person', email: 'retry.person@example.com', phone: '09190000613', prop: 'Eluria' },
  777: { platform: 'fb', name: 'Missed By Webhook', email: 'missed.webhook@example.com', phone: '09170000777', prop: 'Makati condo' }
};
function leadJson(id) {
  const L = LEADS[id];
  return { id: String(id), created_time: iso(now - 60000), ad_id: '8000', ad_name: 'Sondris Carousel Oct', adset_name: 'Pasig 25-45', campaign_id: '7001', campaign_name: 'Sondris Leads Oct 2026',
    form_id: '5000', platform: L.platform, is_organic: false,
    field_data: [{ name: 'full_name', values: [L.name] }, { name: 'email', values: [L.email] }, { name: 'phone_number', values: [L.phone] },
      { name: 'which_property_are_you_interested_in?', values: [L.prop] }, { name: 'when_do_you_plan_to_buy?', values: ['Within 3 months'] }]
      .concat(L.optIn ? [{ name: 'send_me_similar_listings_and_updates?', values: [L.optIn] }] : []) };
}
const stub = { calls: [], telegram: [], proofBad: [], tokens: new Set(), hits613: 0, subscribed: null };
const days = n => { const out = []; for (let i = n; i >= 1; i--) out.push(new Date(now - i * 864e5)); return out; };
const endTime = d => iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 7));
const dayStr = d => d.toISOString().slice(0, 10);
function series(base, wobble, grow) { return days(30).map((d, i) => ({ value: Math.round(base + (grow || 0) * i + Math.sin(i / 2.3) * wobble), end_time: endTime(d) })); }

function graph(p, q, method) {
  const parts = p.split('/').filter(Boolean);
  const [a, b] = parts;
  if (method === 'POST') {
    if (a === PAGE && b === 'subscribed_apps') { stub.subscribed = q.get('subscribed_fields'); return [200, { success: true }]; }
    return [400, { error: { message: 'Unexpected POST', code: 100 } }];
  }
  if (a === 'debug_token') return [200, { data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER', app_id: '111',
    scopes: ['leads_retrieval', 'pages_manage_metadata', 'pages_show_list', 'pages_read_engagement', 'ads_read', 'read_insights', 'instagram_basic', 'instagram_manage_insights', 'pages_messaging', 'instagram_manage_messages', 'instagram_manage_comments', 'business_management'] } }];
  if (a === PAGE && !b) {
    if (q.get('fields') === 'access_token') return [200, { id: PAGE, access_token: PAGE_TOK }];
    return [200, { id: PAGE, followers_count: 4825, fan_count: 4700 }];
  }
  if (a === PAGE && b === 'leadgen_forms') return [200, { data: [{ id: '5000', name: 'Sondris form', status: 'ACTIVE' }] }];
  if (a === '5000' && b === 'leads') return [200, { data: [leadJson(777), leadJson(9001)] }];
  if (a === PAGE && b === 'insights') {
    const m = q.get('metric');
    if (m === 'page_daily_follows_unique') return [400, { error: { message: '(#100) The value must be a valid insights metric', type: 'OAuthException', code: 100 } }];
    const map = { page_follows: series(4600, 3, 7.5), page_total_media_view_unique: series(2100, 600), page_media_view: series(5200, 1500), page_post_engagements: series(180, 70) };
    if (!map[m]) return [400, { error: { message: 'Unknown metric', code: 100 } }];
    return [200, { data: [{ name: m, period: 'day', values: map[m] }] }];
  }
  if (a === PAGE && b === 'published_posts') return [200, { data: [
    { id: PAGE + '_1', message: 'Sondris Residences: 2BR with a view of the Pasig river. Message us for the price list.', created_time: iso(now - 3 * 864e5), permalink_url: 'https://www.facebook.com/1000_1', shares: { count: 12 }, reactions: { summary: { total_count: 240 } }, comments: { summary: { total_count: 31 } } },
    { id: PAGE + '_2', message: 'Open house this Saturday at Liv, Makati.', created_time: iso(now - 9 * 864e5), permalink_url: 'https://www.facebook.com/1000_2', shares: { count: 3 }, reactions: { summary: { total_count: 88 } }, comments: { summary: { total_count: 9 } } },
    { id: PAGE + '_3', message: 'How the Pag-IBIG housing loan cap changed this year.', created_time: iso(now - 15 * 864e5), permalink_url: 'https://www.facebook.com/1000_3', shares: { count: 41 }, reactions: { summary: { total_count: 310 } }, comments: { summary: { total_count: 57 } } }] }];
  if (/_\d$/.test(a) && b === 'insights') return [200, { data: [{ name: 'post_media_view', values: [{ value: 3000 + Number(a.slice(-1)) * 1700 }] }] }];
  if (a === IG && !b) return [200, { id: IG, followers_count: 3120, media_count: 210 }];
  if (a === IG && b === 'insights') {
    const m = q.get('metric');
    if (q.get('metric_type') === 'total_value') return [200, { data: [{ name: m, period: 'day', total_value: { value: m === 'views' ? 4000 + Math.round(Math.random() * 1500) : 300 + Math.round(Math.random() * 120) } }] }];
    const map = { reach: series(1500, 400), follower_count: series(14, 6) };
    if (!map[m]) return [400, { error: { message: 'Unknown metric', code: 100 } }];
    return [200, { data: [{ name: m, period: 'day', values: map[m] }] }];
  }
  if (a === IG && b === 'media') return [200, { data: [
    { id: '91', caption: 'Golden hour at Sondris.', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/AAA/', timestamp: iso(now - 2 * 864e5), like_count: 320, comments_count: 18 },
    { id: '92', caption: 'A day at Liv (reel).', media_type: 'VIDEO', permalink: 'https://www.instagram.com/p/BBB/', timestamp: iso(now - 6 * 864e5), like_count: 512, comments_count: 40 }] }];
  if ((a === '91' || a === '92') && b === 'insights') return [200, { data: [{ name: 'views', values: [{ value: 9000 }] }, { name: 'reach', values: [{ value: 6100 }] }] }];
  if (a === 'act_' + ACT && b === 'insights') {
    const rows = [];
    days(30).forEach((d, i) => {
      rows.push({ date_start: dayStr(d), date_stop: dayStr(d), campaign_id: '7001', campaign_name: 'Sondris Leads Oct 2026', spend: String(350 + (i % 5) * 20), impressions: String(9000 + i * 50), clicks: String(120 + i), actions: [{ action_type: 'lead', value: String(2 + (i % 3)) }, { action_type: 'onsite_conversion.lead_grouped', value: String(2 + (i % 3)) }] });
      rows.push({ date_start: dayStr(d), date_stop: dayStr(d), campaign_id: '7002', campaign_name: 'Liv Awareness', spend: String(150 + (i % 4) * 10), impressions: String(15000 + i * 80), clicks: String(60 + (i % 7)), actions: [{ action_type: 'link_click', value: '40' }] });
    });
    return [200, { data: rows }];
  }
  // A lead that fails with 613 once, then works
  if (a === '613613') { stub.hits613++; if (stub.hits613 === 1) return [400, { error: { message: '(#613) Calls to this api have exceeded the rate limit.', type: 'OAuthException', code: 613 } }]; return [200, leadJson(613613)]; }
  if (a === '666') return [400, { error: { message: "Unsupported get request. Object with ID '666' does not exist", type: 'GraphMethodException', code: 100, error_subcode: 33 } }];
  if (LEADS[a] && !b) return [200, leadJson(a)];
  // Messenger / Instagram profiles
  if (a === '7001' && !b) return [200, { first_name: 'Maria', last_name: 'Santos', id: '7001' }];
  if (a === '8801' && !b) return [200, { name: 'Lia Tan', username: 'liatan', id: '8801' }];
  return [404, { error: { message: 'Stub has no answer for ' + p, code: 803 } }];
}
function startStub() {
  return new Promise(resolve => {
    const srv = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', c => { body += c; });
      rq.on('end', () => {
        const u = new URL(rq.url, 'http://x');
        const send = (st, j) => { rs.writeHead(st, { 'content-type': 'application/json', 'x-app-usage': JSON.stringify({ call_count: 4, total_cputime: 2, total_time: 3 }) }); rs.end(JSON.stringify(j)); };
        const tg = /^\/bot([^/]+)\/(sendMessage|getUpdates)$/.exec(u.pathname);
        if (tg) {
          if (tg[2] === 'sendMessage') { try { stub.telegram.push(JSON.parse(body)); } catch (e) { stub.telegram.push({ bad: body }); } return send(200, { ok: true, result: { message_id: stub.telegram.length } }); }
          return send(200, { ok: true, result: [{ update_id: 1, message: { message_id: 1, text: 'hi', chat: { id: 999, type: 'private', first_name: 'Rafael' } } }] });
        }
        const m = /^\/v\d+\.\d+\/(.*)$/.exec(u.pathname);
        if (!m) return send(404, { error: { message: 'no version' } });
        const tok = u.searchParams.get('access_token') || '';
        stub.tokens.add(tok);
        stub.calls.push({ method: rq.method, path: m[1], metric: u.searchParams.get('metric') || '' });
        if (m[1] !== 'debug_token') {
          const want = crypto.createHmac('sha256', SECRET).update(tok).digest('hex');
          if (u.searchParams.get('appsecret_proof') !== want) stub.proofBad.push(m[1]);
        }
        const [st, j] = graph(m[1], u.searchParams, rq.method);
        send(st, j);
      });
    });
    srv.listen(STUB_PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ══ RUN ════════════════════════════════════════════════════════
async function login(email, password) {
  const r = await req('POST', '/api/admin/login', { body: { email, password } });
  if (!r.json || !r.json.token) throw new Error(`Login failed for ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.token;
}

async function offMode() {
  const routes = [['GET', '/api/meta/webhook?hub.mode=subscribe&hub.verify_token=test&hub.challenge=1'], ['POST', '/api/meta/webhook'],
    ['GET', '/api/admin/meta/status'], ['GET', '/api/admin/meta/insights'], ['GET', '/api/admin/meta/logs'], ['POST', '/api/admin/meta/snapshot'],
    ['POST', '/api/admin/meta/bulk-read'], ['POST', '/api/admin/meta/check-token'], ['POST', '/api/admin/meta/test-telegram'], ['GET', '/api/admin/meta/telegram-chats'],
    ['POST', '/api/admin/meta/subscribe-page'], ['POST', '/api/admin/meta/weekly-send'], ['PUT', '/api/admin/meta/settings']];
  for (const [m, u] of routes) {
    const r = m === 'POST' && u === '/api/meta/webhook' ? await deliver(leadgen('9001')) : await req(m, u, m === 'GET' ? {} : { body: {} });
    check(`switches off: ${m} ${u.split('?')[0]} -> 404`, r.status === 404, 'got ' + r.status);
  }
}

async function onMode() {
  const srv = await startStub();
  // The local stack numbers its emails 1.html, 2.html... from each start, so
  // "new" means written since this run began.
  const startedAt = Date.now() - 1000;
  const newMail = () => (fs.existsSync(MAIL_DIR) ? fs.readdirSync(MAIL_DIR) : []).map(f => path.join(MAIL_DIR, f))
    .filter(f => fs.statSync(f).mtimeMs >= startedAt).map(f => fs.readFileSync(f, 'utf8'));
  try {
    // 1. Verification handshake
    let r = await req('GET', '/api/meta/webhook?hub.mode=subscribe&hub.verify_token=test&hub.challenge=1158201444');
    check('handshake with the right verify token echoes the challenge', r.status === 200 && r.text === '1158201444', r.status + ' ' + r.text.slice(0, 40));
    r = await req('GET', '/api/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444');
    check('handshake with a wrong verify token -> 403', r.status === 403, 'got ' + r.status);

    // 2. Signatures
    r = await deliver(leadgen('9001'), 'sha256=' + 'a'.repeat(64));
    check('POST with a bad signature -> 403', r.status === 403, 'got ' + r.status);
    r = await deliver(leadgen('9001'), null);
    check('POST with no signature -> 403', r.status === 403, 'got ' + r.status);
    r = await deliver(leadgen('9001'), sign(Buffer.from('{"object":"page"}')));
    check('POST signed over different bytes -> 403', r.status === 403, 'got ' + r.status);

    const admin = await login(ADMIN.email, ADMIN.password);
    const leads = async () => (await req('GET', '/api/admin/leads', { token: admin })).json.leads;
    const leadOf = async email => (await leads()).find(l => (l.emails || []).includes(email));

    // 3. A good lead
    const t0 = Date.now();
    r = await deliver(leadgen('9001'));
    check('signed leadgen delivery -> 200 at once', r.status === 200 && Date.now() - t0 < 2000, r.status + ' in ' + (Date.now() - t0) + ' ms');
    let L = await until(() => leadOf('juan.meta.test@example.com'));
    check('lead created with kind meta_lead', L && L.lastKind === 'meta_lead' && L.firstSource === 'meta_lead', L ? L.lastKind : 'no lead');
    check('attribution facebook / paid_social / campaign / ad', L && L.firstTouch && L.firstTouch.src === 'facebook' && L.firstTouch.med === 'paid_social' && L.firstTouch.cmp === 'Sondris Leads Oct 2026' && L.firstTouch.cnt === 'Sondris Carousel Oct', JSON.stringify(L && L.firstTouch));
    check('property question mapped to the property', L && L.lastProperty === 'Sondris 2BR Pasig', L && L.lastProperty);
    check('new lead is waiting for a reply (reply clock running)', L && L.waiting === true);
    const d1 = L && (await req('GET', '/api/admin/leads/' + L._id, { token: admin })).json;
    const s1 = d1 && d1.lead.sources.find(s => s.refId === '9001');
    check('source keeps refId, message lines and consent note', s1 && /When do you plan to buy: Within 3 months/.test(s1.message) && d1.lead.consent && /Meta Lead Ad form/.test(d1.lead.consent.how), s1 && s1.message);
    const count1 = (await leads()).length;

    // 4. Duplicate event
    await deliver(leadgen('9001'));
    await sleep(1500);
    L = await leadOf('juan.meta.test@example.com');
    check('duplicate delivery adds nothing', L && L.touches === 1 && (await leads()).length === count1, 'touches ' + (L && L.touches));

    // 5. Same phone, different lead id and email -> same person
    await deliver(leadgen('9002'));
    L = await until(async () => { const x = await leadOf('juan.meta.test@example.com'); return x && x.touches === 2 ? x : null; });
    check('same mobile, new lead id -> merged into the same person', L && L.touches === 2 && (L.emails || []).includes('other.juan@example.com') && (await leads()).length === count1, L ? 'touches ' + L.touches + ', emails ' + L.emails.join(',') : 'not merged');

    // 6. Instagram lead
    await deliver(leadgen('9003'));
    L = await until(() => leadOf('ana.ig.test@example.com'));
    check('Instagram lead -> src instagram', L && L.firstTouch && L.firstTouch.src === 'instagram', JSON.stringify(L && L.firstTouch));
    check('lead form without an opt-in question -> no marketing consent', L && !(L.consent && L.consent.marketing), JSON.stringify(L && L.consent));

    // 7. Rate-limit error then success
    await deliver(leadgen('613613'));
    L = await until(() => leadOf('retry.person@example.com'), 15000);
    check('Graph 613 then success -> retried and the lead arrived', L && stub.hits613 >= 2, 'stub hits ' + stub.hits613);

    // 8. Permanent error
    await deliver(leadgen('666'));
    let logs = await until(async () => { const j = (await req('GET', '/api/admin/meta/logs?limit=200', { token: admin })).json; return j.logs.some(l => l.path === '666' && l.level === 'error') ? j.logs : null; });
    check('permanent Graph error -> MetaLog entry', !!logs, logs ? logs.find(l => l.path === '666').message.slice(0, 80) : 'none');
    r = await req('GET', '/api/health');
    check('server still healthy after the error', r.status === 200);
    check('613 retry logged as a warning', !!(logs && logs.some(l => l.level === 'warn' && /613/.test(l.message))));

    // 9. Email + Telegram
    const mails = await until(() => { const m = newMail().filter(h => /New Facebook lead/.test(h)); return m.length ? m : null; });
    check('new-lead email written to the mail folder', !!mails, mails ? mails.length + ' email(s)' : 'none in ' + MAIL_DIR);
    check('email carries the name, mobile and property', !!(mails && mails.some(h => /Juan Dela Cruz/.test(h) && /639171234567/.test(h) && /Sondris 2BR Pasig/.test(h))));
    const tgLead = stub.telegram.filter(t => /lead/i.test(t.text || ''));
    check('Telegram stub called for new leads', tgLead.length >= 3, tgLead.length + ' message(s)');
    const personal = /Juan|Cruz|Ana|Reyes|9171234567|0917|example\.com|Sondris/i;
    check('Telegram messages carry no personal details', tgLead.length && tgLead.every(t => !personal.test(t.text) && /admin\.html#leads/.test(t.text) && String(t.chat_id) === '999'), tgLead.map(t => t.text).join(' | ').slice(0, 160));

    // 10. Hourly safety net (bulk read)
    r = await req('POST', '/api/admin/meta/bulk-read', { token: admin, body: {} });
    check('bulk read picks up a lead the webhook missed', r.status === 200 && r.json.added === 1 && !!(await leadOf('missed.webhook@example.com')), JSON.stringify(r.json));
    r = await req('POST', '/api/admin/meta/bulk-read', { token: admin, body: {} });
    check('second bulk read adds nothing (dedup)', r.status === 200 && r.json.added === 0, JSON.stringify(r.json));

    // 11. Inbox: Messenger message, then the Page's echo
    const ts = Date.now();
    await deliver({ object: 'page', entry: [{ id: PAGE, time: ts, messaging: [{ sender: { id: '7001' }, recipient: { id: PAGE }, timestamp: ts, message: { mid: 'm_test_1', text: 'Is the Makati unit still available?' } }] }] });
    const findName = async n => (await leads()).find(l => l.name === n);
    L = await until(() => findName('Maria Santos'));
    check('Messenger message -> lead with kind messenger', L && L.lastKind === 'messenger' && L.waiting === true, L ? L.lastKind + ' waiting=' + L.waiting : 'none');
    const d2 = L && (await req('GET', '/api/admin/leads/' + L._id, { token: admin })).json;
    check('Messenger lead links back to the inbox', d2 && /business\.facebook\.com\/latest\/inbox\/messenger/.test((d2.lead.sources[0] || {}).link || ''), d2 && d2.lead.sources[0].link);
    await deliver({ object: 'page', entry: [{ id: PAGE, time: ts + 5000, messaging: [{ sender: { id: PAGE }, recipient: { id: '7001' }, timestamp: ts + 5000, message: { mid: 'm_test_2', is_echo: true, text: 'Yes it is! When can you view?' } }] }] });
    L = await until(async () => { const x = await findName('Maria Santos'); return x && !x.waiting ? x : null; });
    check('Page echo -> contact activity, no longer waiting', L && !L.waiting && L.lastContactAt && L.stage === 'contacted', L ? 'stage ' + L.stage : 'still waiting');

    // Facebook comment, then the Page's reply to it
    await deliver({ object: 'page', entry: [{ id: PAGE, time: ts, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: '1000_1_55', post_id: '1000_1', from: { id: '7002', name: 'Ben Ramos' }, message: 'How much?', created_time: Math.floor(ts / 1000) } }] }] });
    L = await until(() => findName('Ben Ramos'));
    check('Facebook comment -> lead with kind fb_comment', L && L.lastKind === 'fb_comment' && L.waiting);
    await deliver({ object: 'page', entry: [{ id: PAGE, time: ts + 9000, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: '1000_1_56', parent_id: '1000_1_55', post_id: '1000_1', from: { id: PAGE, name: 'GLRA Realty' }, message: 'Sent you a message!', created_time: Math.floor(ts / 1000) + 9 } }] }] });
    L = await until(async () => { const x = await findName('Ben Ramos'); return x && !x.waiting ? x : null; });
    check('Page reply to the comment -> no longer waiting', !!L);

    // Instagram DM
    await deliver({ object: 'instagram', entry: [{ id: IG, time: ts, messaging: [{ sender: { id: '8801' }, recipient: { id: IG }, timestamp: ts, message: { mid: 'ig_m_1', text: 'Price list please' } }] }] });
    L = await until(() => findName('Lia Tan'));
    check('Instagram DM -> lead with kind ig_dm, src instagram', L && L.lastKind === 'ig_dm' && L.firstTouch && L.firstTouch.src === 'instagram');

    // 12. Insights snapshot from the stub
    r = await req('POST', '/api/admin/meta/snapshot', { token: admin, body: {} });
    check('snapshot now -> MetaDaily rows written', r.status === 200 && r.json.rows >= 60, JSON.stringify(r.json).slice(0, 200));
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const yday = new Date(Date.now() + 8 * 3600e3 - 864e5).toISOString().slice(0, 10);
    const from = new Date(Date.now() + 8 * 3600e3 - 30 * 864e5).toISOString().slice(0, 10);
    r = await req('GET', `/api/admin/meta/insights?from=${from}&to=${yday}`, { token: admin });
    const ins = r.json || {};
    const tile = (s, k) => ((ins.tiles || {})[s] || []).find(t => t.key === k) || {};
    check('insights: daily rows for page, ig and ads', ins.daily && ['page', 'ig', 'ads'].every(s => ins.daily.some(d => d.surface === s)), ins.daily ? ins.daily.length + ' rows' : r.status);
    check('insights: reach tile has a 30-day total', tile('page', 'page_total_media_view_unique').value > 10000, String(tile('page', 'page_total_media_view_unique').value));
    check('insights: retired metric marks only its own tile', tile('page', 'page_daily_follows_unique').status === 'retired' && tile('page', 'page_media_view').status === 'ok');
    const camp = (ins.campaigns || []).find(c => c.id === '7001');
    check('campaign table: spend, leads (not double counted), cost per lead', camp && camp.leads > 0 && camp.leads < 100 && camp.cpl > 0 && ins.totals.spend > 0, camp ? `spend ${camp.spend} leads ${camp.leads} cpl ${camp.cpl}` : 'none');
    check('top posts stored', ins.topPosts && (ins.topPosts.fb || []).length === 3 && (ins.topPosts.ig || []).length === 2);
    check('snapshot did not read beyond yesterday', !ins.daily.some(d => d.date > today));

    // 13. Token check, Telegram helpers, Page subscription, weekly email
    r = await req('POST', '/api/admin/meta/check-token', { token: admin, body: {} });
    check('token check against debug_token -> ok', r.status === 200 && r.json.token.ok === true && r.json.token.neverExpires === true, JSON.stringify(r.json && r.json.token).slice(0, 160));
    r = await req('POST', '/api/admin/meta/test-telegram', { token: admin, body: {} });
    check('test Telegram -> sent', r.status === 200 && stub.telegram.some(t => /Test from the GLRA admin/.test(t.text)));
    r = await req('GET', '/api/admin/meta/telegram-chats', { token: admin });
    check('find chat id lists the chat', r.status === 200 && r.json.chats.some(c => c.id === '999'));
    r = await req('POST', '/api/admin/meta/subscribe-page', { token: admin, body: {} });
    check('connect Page to webhook -> the one allowed Graph POST', r.status === 200 && stub.subscribed === 'leadgen,messages,message_echoes,feed', stub.subscribed);
    r = await req('POST', '/api/admin/meta/weekly-send', { token: admin, body: {} });
    const weekly = await until(() => newMail().find(h => /Facebook &amp; Instagram: last week/.test(h)));
    check('weekly summary email renders and is written', r.status === 200 && !!weekly && /Cost per lead/.test(weekly));
    r = await req('PUT', '/api/admin/meta/settings', { token: admin, body: { telegramDetails: true } });
    check('Telegram detail setting saves', r.status === 200 && r.json.prefs.telegramDetails === true);
    await req('PUT', '/api/admin/meta/settings', { token: admin, body: { telegramDetails: false } });

    // 14. Status, tokens, appsecret_proof, no writes to ads
    r = await req('GET', '/api/admin/meta/status', { token: admin });
    check('status: all three switches on, leads counted', r.status === 200 && r.json.switches.leads && r.json.switches.insights && r.json.switches.inbox && r.json.leads.d7.byKind.meta_lead >= 5, JSON.stringify(r.json && r.json.leads && r.json.leads.d7.byKind));
    check('every Graph call carried a correct appsecret_proof', stub.proofBad.length === 0, stub.proofBad.slice(0, 5).join(', '));
    check('lead fetches used the Page token', stub.calls.some(c => c.path === '9001') && stub.tokens.has(PAGE_TOK));
    check('no POST to any ads / campaign / adset endpoint', !stub.calls.some(c => c.method !== 'GET' && !/subscribed_apps$/.test(c.path)));
    logs = (await req('GET', '/api/admin/meta/logs?limit=500', { token: admin })).json.logs;
    const blob = JSON.stringify(logs);
    check('no token appears in the error log', !blob.includes(SYS) && !blob.includes(PAGE_TOK) && !blob.includes('test-bot-token'));

    // 15. Permissions
    r = await req('GET', '/api/admin/meta/status');
    check('Meta tab API without sign-in -> 401', r.status === 401, 'got ' + r.status);
    const empEmail = `meta.employee.${Date.now()}@example.com`, empPass = 'Emp-Test-Pass-2026!';
    r = await req('POST', '/api/admin/accounts', { token: admin, body: { email: empEmail, password: empPass, name: 'Meta Test Employee', role: 'employee' } });
    const empId = r.json && r.json.account && r.json.account._id;
    check('test employee created (default permissions: no meta_view)', r.status === 200 && r.json.account.permissions.meta_view === false, r.status + '');
    const emp = await login(empEmail, empPass);
    r = await req('GET', '/api/admin/meta/status', { token: emp });
    check('employee without meta_view -> 403', r.status === 403, 'got ' + r.status);
    r = await req('GET', '/api/admin/meta/insights', { token: emp });
    check('employee without meta_view -> 403 on insights', r.status === 403, 'got ' + r.status);
    r = await req('PUT', '/api/admin/accounts/' + empId, { token: admin, body: { permissions: { meta_view: true } } });
    check('admin switches meta_view on for the employee', r.status === 200 && r.json.account.permissions.meta_view === true, 'got ' + r.status);
    r = await req('GET', '/api/admin/meta/status', { token: emp });
    check('employee given meta_view -> 200', r.status === 200, 'got ' + r.status);
    r = await req('POST', '/api/admin/meta/snapshot', { token: emp, body: {} });
    check('actions stay admin-only even with meta_view -> 403', r.status === 403, 'got ' + r.status);
  } finally {
    srv.close();
  }
}

(async () => {
  try {
    const h = await fetch(BASE + '/api/health').then(r => r.status).catch(() => 0);
    if (h !== 200) throw new Error('No local server answering at ' + BASE + ' (start the local stack first)');
    if (OFF) await offMode(); else await onMode();
  } catch (e) {
    check('test run finished without crashing', false, e.message);
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
