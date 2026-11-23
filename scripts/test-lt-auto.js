#!/usr/bin/env node
// =============================================================================
// Tests for the Land Title inbox automation (server/lt-auto.js + social.js)
// =============================================================================
//   node scripts/test-lt-auto.js            the rule engine only (no server)
//   node scripts/test-lt-auto.js --stack    also the wiring, against a RUNNING
//                                           local stack. Meta is never contacted:
//                                           a stub Graph API runs on STUB_PORT.
// Start the stack like the GLRA Social one (see scripts/test-social.js) plus
//   LT_PAGE_ID=1001 LT_AUTO_SEND=1
// Options (env): BASE (http://localhost:4320), STUB_PORT (4099), STACK_URI.
// =============================================================================
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const LT = require(path.join(ROOT, 'server', 'lt-auto.js'));

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '  (' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) + ')' : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 8000); let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch (e) { /* again */ } await sleep(150); } return v; }

// ══ PART 1: THE RULES ═════════════════════════════════════════
// Plays a conversation: each inbound message, marking every send as sent.
function play(msgs, start) {
  let st = start || null; const trail = []; let t = Date.now();
  for (const m of msgs) {
    const ev = typeof m === 'string' ? { text: m } : m;
    if (ev.human) { st = { ...LT.fresh(), ...(st || {}), humanAt: new Date(t).toISOString() }; continue; }
    if (ev.wait) { t += ev.wait; continue; }
    const r = LT.decide(st, ev, t);
    st = r.state; for (const id of r.sends) st.sent[id] = new Date(t).toISOString();
    trail.push({ sends: r.sends, rule: r.rule });
    t += 1000;
  }
  return { st, trail, last: trail[trail.length - 1] };
}
function engine() {
  // buttons fit Messenger's limits
  const allQ = Object.values(LT.SCRIPTS).flatMap(s => s.quick || []);
  check('every button title is 20 characters or fewer', allQ.every(q => q.title.length <= 20), allQ.filter(q => q.title.length > 20).map(q => q.title));
  check('no script has more than 13 buttons', Object.values(LT.SCRIPTS).every(s => (s.quick || []).length <= 13));
  check('every script is under 2000 characters', Object.values(LT.SCRIPTS).every(s => s.text.length < 2000));
  check('the first message says it is automated', /automated/.test(LT.SCRIPTS.welcome.text) && /automated/i.test(LT.SCRIPTS.comment_pm.text));
  check('no script promises a price beyond the confirmed lines', Object.entries(LT.SCRIPTS).every(([id, s]) => id === 'price' || !/₱|30,?000|50,?000|6%/.test(s.text)));

  let c = play([{ text: 'Get started', payload: 'GET_STARTED' }]);
  check('Get started -> welcome menu, group F', c.last.sends.join() === 'welcome' && c.st.group === 'F' && c.st.step === 'menu', c);
  c = play([{ text: 'Get started' }, { text: 'Get started' }]);
  check('Get started twice -> welcome only once', c.trail[1].sends.length === 0, c.trail);

  c = play(['Get started', { text: 'Mana / namatayan', payload: 'LT_CASE_ESTATE' }, { text: 'Quezon', payload: 'LT_LOC_QUEZON' }, { text: 'May titulo', payload: 'LT_PAP_TITLE' }, { text: 'Sa magulang', payload: 'LT_OWN_PARENTS' }, { text: '2018 o pagkatapos', payload: 'LT_DIED_2018' }]);
  check('full button path: loc -> papers -> owner -> died -> close', c.trail.map(x => x.sends.join()).join('|') === 'welcome|ask_loc|ask_papers|ask_owner|ask_died|close', c.trail);
  check('full path ends in group A, step done', c.st.group === 'A' && c.st.step === 'done' && c.st.a.died === '2018+', c.st);
  check('closing message lists what was recorded', /mana, Quezon, may titulo, nakapangalan sa magulang/.test(LT.render('close', c.st).text), LT.render('close', c.st).text);

  c = play(['Get started', 'Mana / namatayan', 'Laguna', 'Tax declaration lang', 'Sa lolo o lola', 'Bago 1998']);
  check('same path with button titles only (10-minute check has no payload)', c.st.group === 'A' && c.st.a.case === 'estate' && c.st.a.loc === 'laguna' && c.st.a.papers === 'taxdec' && c.st.a.owner === 'grand' && c.st.a.died === 'before1998', c.st);
  c = play(['hello po', '2', 'Dasmarinas Cavite po', 'titulo po', 'sa nagbenta pa po']);
  check('typed numbers and words work: sale has no death question', c.st.a.case === 'sale' && c.st.a.loc === 'cavite' && c.st.a.owner === 'seller' && c.st.step === 'done' && c.st.group === 'A', c);

  c = play(['Magkano po magpa transfer ng titulo?']);
  check('"magkano" -> confirmed price line then where is the land, group B', c.last.sends.join() === 'price,ask_loc' && c.st.group === 'B', c);
  c = play(['hm', 'mgkno po']);
  check('price line goes out once only', c.trail[0].sends.includes('price') && !c.trail[1].sends.includes('price'), c.trail);
  c = play(['Saan po ang office nyo?']);
  check('office question -> office script only, group E', c.last.sends.join() === 'office' && c.st.group === 'E', c);
  c = play(['location?', 'location po', { wait: 25 * 3600e3 }, 'address nyo po']);
  check('office: not repeated the same day, allowed the next day', c.trail[1].sends.length === 0 && c.trail[2].sends.join() === 'office', c.trail);
  c = play(['San miguel bulacan po ang lupa, magkano?']);
  check('"San Miguel" is not read as "saan"; Bulacan is outside the area -> D, handed to staff', !c.last.sends.includes('office') && c.last.sends.includes('outside') && c.st.group === 'D' && c.st.step === 'handoff', c);
  c = play(['paano po', { text: 'Ibang probinsya', payload: 'LT_LOC_OTHER' }, 'Naga, Camarines Sur']);
  check('other province -> asked which -> outside', c.trail[1].sends.join() === 'ask_loc_other' && c.st.group === 'D', c);
  c = play(['paano po magpatitulo', 'Brgy. Malabanban']);
  check('an unknown place is kept for staff, not called outside', c.st.a.loc === 'unknown' && c.st.a.locText === 'Brgy. Malabanban' && c.last.sends.join() === 'ask_papers', c);
  c = play(['Quezon City po ang lupa namin, mana sa magulang']);
  check('"Quezon City" is Metro Manila, not Quezon province', c.st.a.loc === 'ncr' && c.st.a.case === 'estate' && c.st.a.owner === 'parents', c.st);

  c = play(['Inagaw po ng kapitbahay ang lupa namin at pinatituluhan sa pangalan nila']);
  check('dispute -> lawyer script, group C, no process questions', c.last.sends.join() === 'lawyer' && c.st.group === 'C' && c.st.step === 'handoff', c);
  c = play(['Ayaw pumirma ng isang kapatid ko', 'ano po gagawin']);
  check('after the lawyer hand-off the automation stays silent', c.trail[1].sends.length === 0, c.trail);
  c = play(['gusto ko sana kaso wala akong pera, magkano po']);
  check('"kaso" meaning "but" is not a dispute', c.st.a.case !== 'dispute', c.st);

  c = play(['Get started', 'asdf qwer', 'zzz ano daw']);
  check('not understood: menu once more, then staff. Never a loop', c.trail[1].sends.join() === 'unclear' && c.trail[2].sends.join() === 'handoff' && c.st.step === 'handoff', c.trail);
  c = play(['Get started', 'asdf', 'zzz', 'hello?', 'uy', 'sagot naman']);
  check('after the hand-off nothing more is sent, whatever they type', c.trail.slice(3).every(x => x.sends.length === 0), c.trail);
  c = play(['pa compute po', 'ang haba po kasi ng kwento namin eh, matagal na pong panahon yun at marami nang nangyari sa pamilya', 'basta po ganun talaga ang buong nangyari sa amin noon pa, hindi ko na po alam ang gagawin']);
  check('question not answered twice -> staff', c.trail[1].sends.length === 0 && c.trail[2].sends.join() === 'handoff', c.trail);
  c = play(['hello po', 'salamat po', 'ok po']);
  check('thanks / ok never triggers a reply', c.trail[1].sends.length === 0 && c.trail[2].sends.length === 0, c.trail);

  c = play(['Get started', { human: true }, 'magkano po', 'mana po sa lolo']);
  check('staff answered by hand: quiet for 12 hours, still sorted', c.trail[1].sends.length === 0 && c.trail[2].sends.length === 0 && c.st.group === 'B' && /quiet/.test(c.last.rule), c);
  c = play(['Get started', { human: true }, { wait: 13 * 3600e3 }, 'magkano po']);
  check('13 hours after the staff reply the automation answers again', c.last.sends.includes('price'), c.last);

  c = play(['Earn $500 daily crypto investment opportunity click here bit.ly/x']);
  check('spam -> nothing sent, group F', c.last.sends.length === 0 && c.st.group === 'F' && c.st.flag === 'spam', c);
  c = play(['di naman kayo nagrereply']);
  check('complaint about no reply is flagged red', c.st.flag === 'complaint', c.st);
  const all = play(['Get started', 'magkano', 'ano requirements', 'gaano katagal', 'nasa abroad ako', 'pwede hulugan', 'saan office', '1', 'Lucena', 'May titulo', 'Sa magulang', 'Hindi ko alam']);
  const everySent = all.trail.flatMap(x => x.sends);
  check('no script is ever sent twice to one person', new Set(everySent).size === everySent.length, everySent);
  check('at most 3 messages for one inbound message', all.trail.every(x => x.sends.length <= 3), all.trail.map(x => x.sends.length));

  // comments
  const cm = (text, prev, isReply) => LT.decideComment(prev || null, { text, isReply: !!isReply });
  let k = cm('Hm po?');
  check('comment "hm po" -> one private message with the menu', k.sends.join() === 'comment_pm' && k.state.group === 'B', k);
  k.state.sent.comment_pm = new Date().toISOString();
  check('a second comment in the same thread -> no second private message', cm('magkano nga po', k.state, true).sends.length === 0);
  k = cm('Saan po office nyo');
  check('comment asking the office -> private message with the address', k.sends.join() === 'comment_pm_office' && k.state.group === 'E', k);
  k = cm('Kinamkam po ng pinsan ko ang lupa ng tatay ko');
  check('dispute comment -> lawyer private message, group C', k.sends.join() === 'comment_pm_lawyer' && k.state.group === 'C', k);
  k = cm('Di rin naman sila namamansin dito');
  check('"hindi kayo namamansin" comment -> sorry message + red flag', k.sends.join() === 'comment_pm_sorry' && k.state.flag === 'complaint', k);
  k = cm('Mahal yan.');
  check('chatter comment -> nothing, group F', k.sends.length === 0 && !k.hide && k.state.group === 'F', k);
  k = cm('Pumunta kayo sa DAR sa Tacloban hahaha');
  check('chatter that names a place stays F, not "outside"', k.sends.length === 0 && k.state.group === 'F', k);
  k = cm('Earn $500 daily, click here t.me/abc');
  check('spam comment -> hide, no message', k.hide && k.sends.length === 0, k);
  k = cm('magkano', { ...LT.fresh(), humanAt: new Date().toISOString() });
  check('the Page already replied under the comment -> nothing', k.sends.length === 0, k);

  check('Facebook\'s own auto-replies and our scripts are not counted as staff', LT.notHuman('Thanks for messaging us. We try to be as responsive as possible.') && LT.notHuman(LT.SCRIPTS.welcome.text) && LT.notHuman(LT.render('close', all.st).text) && !LT.notHuman('Hello po, saan po ang property?'));
  check('script approval is tied to the exact wording', LT.scriptHash('welcome') !== LT.scriptHash('unclear') && /^[a-f0-9]{16}$/.test(LT.scriptHash('welcome')));
}

// ══ PART 2: THE WIRING (local stack, stub Graph API) ══════════
const BASE = process.env.BASE || 'http://localhost:4320';
const PORT = (BASE.match(/:(\d+)$/) || [])[1] || '4320';
const STUB_PORT = Number(process.env.STUB_PORT || 4099);
const SECRET = 'test';
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-test-secret-1234567890';
const LTP = '1001';
const stub = { calls: [], n: 500, failFor: '' };
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
const A = (method, p, token, body) => req(method, '/api/admin/social' + p, { token, body });
function deliver(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return req('POST', '/api/meta/webhook', { raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex') } });
}
let seq = 0;
const mid = () => 'm_lt_' + Date.now() + '_' + (++seq);
const msg = (user, text, extra, page) => deliver({ object: 'page', entry: [{ id: page || LTP, time: Date.now(), messaging: [{ sender: { id: user }, recipient: { id: page || LTP }, timestamp: Date.now(), message: { mid: mid(), text, ...(extra || {}) } }] }] });
const tap = (user, payload, title) => deliver({ object: 'page', entry: [{ id: LTP, time: Date.now(), messaging: [{ sender: { id: user }, recipient: { id: LTP }, timestamp: Date.now(), postback: { mid: mid(), title: title || 'Get started', payload } }] }] });
const echo = (user, text, appId) => deliver({ object: 'page', entry: [{ id: LTP, time: Date.now(), messaging: [{ sender: { id: LTP }, recipient: { id: user }, timestamp: Date.now(), message: { mid: mid(), text, is_echo: true, app_id: appId || 999 } }] }] });
let cseq = 7000;
const comment = (text, from, page) => { const id = (page || LTP) + '_' + (++cseq); return deliver({ object: 'page', entry: [{ id: page || LTP, time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: (page || LTP) + '_1', parent_id: (page || LTP) + '_1', message: text, from: { id: from || '7' + cseq, name: 'Test Commenter' }, created_time: Math.floor(Date.now() / 1000) } }] }] }).then(() => id); };
function startStub() {
  return new Promise(resolve => {
    const srv = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', c => { body += c; });
      rq.on('end', () => {
        const u = new URL(rq.url, 'http://x');
        const send = (st, j) => { rs.writeHead(st, { 'content-type': 'application/json' }); rs.end(JSON.stringify(j)); };
        const m = /^\/v\d+\.\d+\/(.*)$/.exec(u.pathname);
        if (!m) return send(200, { ok: true, result: [] });
        const q = {};
        u.searchParams.forEach((v, k) => { q[k] = v; });
        if (body) new URLSearchParams(body).forEach((v, k) => { q[k] = v; });
        stub.calls.push({ method: rq.method, path: m[1], q });
        const [a, b] = m[1].split('/');
        if (rq.method === 'POST' && b === 'messages') {
          const rcp = JSON.parse(q.recipient || '{}');
          if (stub.failFor && rcp.id === stub.failFor) return send(400, { error: { message: '(#10) This message is sent outside of allowed window.', code: 10, error_subcode: 2018278 } });
          return send(200, { recipient_id: rcp.id || '99' + (++stub.n), message_id: 'm_out_' + (++stub.n) });
        }
        if (rq.method === 'POST') return send(200, { success: true, id: a + '_' + (++stub.n) });
        if (a === 'debug_token') return send(200, { data: { is_valid: true, expires_at: 0, type: 'PAGE', app_id: '111', scopes: [] } });
        if (q.fields === 'access_token') return send(200, { id: a, access_token: 'page-tok-' + a });
        if (/first_name/.test(q.fields || '')) return send(200, { first_name: 'Juan', last_name: 'Dela Cruz ' + a });
        if (/instagram_business_account/.test(q.fields || '')) return send(200, { id: a, name: a === LTP ? 'GLRA Land Title Documentation and Allied Services' : 'Page ' + a });
        return send(200, { data: [] });
      });
    });
    srv.listen(STUB_PORT, '127.0.0.1', () => resolve(srv));
  });
}
const sentTo = () => stub.calls.filter(c => c.method === 'POST' && /\/messages$/.test(c.path));

async function wiring() {
  const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
  const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
  const srv = await startStub();
  await mongoose.connect(process.env.STACK_URI || fs.readFileSync(`D:/GLRA/glra-dev-tools/stack-${PORT}.uri`, 'utf8').trim());
  const db = mongoose.connection.db;
  const mint = a => jwt.sign({ sub: String(a._id), email: a.email, role: a.role, name: a.name, tv: a.tokenVersion || 0 }, JWT_SECRET, { expiresIn: '2h' });
  const logs = q => db.collection('ltautologs').find(q || {}).sort({ at: 1 }).toArray();
  const thread = key => db.collection('socialthreads').findOne({ key });
  const lastLog = async user => (await logs({ threadKey: `messenger:${LTP}:${user}` })).pop();
  const waitLog = (user, n) => until(async () => (await logs({ threadKey: `messenger:${LTP}:${user}` })).length >= n, 6000);
  try {
    const adminAcc = await db.collection('accounts').findOne({ role: 'admin' });
    const admin = mint(adminAcc);
    const email = `lt.viewer.${Date.now()}@example.com`;
    await req('POST', '/api/admin/accounts', { token: admin, body: { email, password: 'Social-Test-Pass-2026!', name: 'LT Viewer', role: 'employee', permissions: { social_view: true, social_draft: true, social_approve: true } } });
    const staff = mint(await db.collection('accounts').findOne({ email }));
    await A('POST', '/pages/refresh', admin);

    // ── shadow (the default) ──
    let r = await A('GET', '/lt-auto', staff);
    check('stack: overview opens; a fresh install is in SHADOW mode', r.status === 200 && r.json.mode === 'shadow' && r.json.scripts.length === Object.keys(LT.SCRIPTS).length && r.json.scripts.every(s => !s.approved), r.json && r.json.mode);
    stub.calls.length = 0;
    await tap('7701', 'GET_STARTED');
    await waitLog('7701', 1);
    let l = await lastLog('7701');
    check('shadow: Get started tap is recorded with the welcome script', l && l.scripts.join() === 'welcome' && l.result === 'recorded' && l.mode === 'shadow', l);
    await msg('7701', 'Mana / namatayan', { quick_reply: { payload: 'LT_CASE_ESTATE' } }); await waitLog('7701', 2);
    await msg('7701', 'Lucena po'); await waitLog('7701', 3);
    await msg('7701', 'May titulo', { quick_reply: { payload: 'LT_PAP_TITLE' } }); await waitLog('7701', 4);
    await msg('7701', 'Sa magulang', { quick_reply: { payload: 'LT_OWN_PARENTS' } }); await waitLog('7701', 5);
    await msg('7701', '2018 o pagkatapos', { quick_reply: { payload: 'LT_DIED_2018' } }); await waitLog('7701', 6);
    const all = await logs({ threadKey: `messenger:${LTP}:7701` });
    check('shadow: the whole intake is recorded step by step', all.map(x => x.scripts.join()).join('|') === 'welcome|ask_loc|ask_papers|ask_owner|ask_died|close', all.map(x => x.scripts.join()));
    let th = await thread(`messenger:${LTP}:7701`);
    check('shadow: the person is sorted as a ready client (A)', th && th.lt && th.lt.group === 'A' && th.lt.a.loc === 'quezon' && th.lt.a.case === 'estate', th && th.lt);
    const c1 = await comment('Magkano po magpa transfer?');
    const c2 = await comment('Inagaw po ang lupa namin ng kapitbahay');
    const c3 = await comment('Earn $500 daily crypto click here bit.ly/zz');
    const c4 = await comment('Good info po');
    await until(async () => (await logs({ kind: 'fb_comment' })).length >= 4, 6000);
    const cl = await logs({ kind: 'fb_comment' });
    const by = id => cl.find(x => x.threadKey === 'c:' + id) || {};
    check('shadow: question comment -> would send one private message', (by(c1).scripts || []).join() === 'comment_pm', by(c1));
    check('shadow: dispute comment -> lawyer message, group C', (by(c2).scripts || []).join() === 'comment_pm_lawyer' && by(c2).group === 'C', by(c2));
    check('shadow: spam comment -> would hide, no message', by(c3).hide === true && (by(c3).scripts || []).length === 0, by(c3));
    check('shadow: chatter comment -> nothing', (by(c4).scripts || []).length === 0 && by(c4).group === 'F', by(c4));
    await msg('5501', 'magkano po', null, '1000'); await sleep(700);
    check('other Pages are not touched', (await logs({ pageId: '1000' })).length === 0 && !(await thread('messenger:1000:5501')).lt);
    await tap('7702', 'GET_STARTED'); await waitLog('7702', 1);
    await echo('7702', 'Thanks for messaging us. We try to be as responsive as possible.'); await sleep(400);
    await msg('7702', 'magkano po'); await waitLog('7702', 2);
    l = await lastLog('7702');
    check('Facebook\'s own instant reply does not silence the automation', l && l.scripts.includes('price'), l);
    await echo('7702', 'Hello po, saan po ang lupa ninyo?'); await sleep(500);
    await msg('7702', 'paano po ba'); await waitLog('7702', 3);
    l = await lastLog('7702');
    check('a staff reply makes it quiet for that person', l && l.scripts.length === 0 && /quiet/.test(l.rule), l);
    check('SHADOW MODE NEVER CONTACTED META TO SEND OR HIDE', sentTo().length === 0 && !stub.calls.some(c => c.method === 'POST' && c.q.is_hidden), stub.calls.filter(c => c.method === 'POST').map(c => c.path));

    // ── the staff view ──
    r = await A('GET', '/inbox?status=all&lt=A', staff);
    check('inbox filter by group: A shows the ready client only', r.status === 200 && r.json.threads.length === 1 && r.json.threads[0].key === `messenger:${LTP}:7701`, r.json && r.json.threads.map(t => t.key));
    r = await A('GET', '/lt-auto', staff);
    check('overview counts the groups and lists the log', r.json.counts.A === 1 && r.json.counts.C === 1 && r.json.log.length >= 10 && r.json.log[0].who !== undefined, r.json.counts);

    // ── the locks ──
    r = await A('POST', '/lt-auto/mode', staff, { mode: 'off' });
    check('only an admin can change the mode -> 403', r.status === 403, r.status);
    r = await A('POST', '/lt-auto/approve', staff, { ids: ['welcome'] });
    check('only an admin can approve scripts -> 403', r.status === 403, r.status);
    r = await A('POST', '/lt-auto/mode', admin, { mode: 'live' });
    check('live is refused while scripts are not approved', r.status === 400 && /not approved/.test(r.json.error), r.json);
    r = await A('POST', '/lt-auto/approve', admin, { ids: Object.keys(LT.SCRIPTS).filter(id => id !== 'tagal') });
    check('admin approves the scripts (all but one)', r.status === 200 && r.json.scripts.filter(s => s.approved).length === Object.keys(LT.SCRIPTS).length - 1);
    r = await A('POST', '/lt-auto/mode', admin, { mode: 'live' });
    const sendSwitch = r.json && r.json.sendSwitch;
    if (!sendSwitch) {
      check('without LT_AUTO_SEND=1 live is refused even with approved scripts', r.status === 400 && /LT_AUTO_SEND/.test(r.json.error), r.json);
    } else {
      // ── live (this local stack was started with LT_AUTO_SEND=1) ──
      check('live accepted: switch + approvals present', r.status === 200 && r.json.mode === 'live', r.json);
      check('going live wipes the shadow states (nobody is assumed to have seen a message)', !(await thread(`messenger:${LTP}:7701`)).lt);
      stub.calls.length = 0;
      await tap('7801', 'GET_STARTED'); await waitLog('7801', 1);
      let s = sentTo();
      const m0 = s[0] && JSON.parse(s[0].q.message);
      check('live: welcome is sent once, with 7 buttons, as a RESPONSE', s.length === 1 && s[0].path === LTP + '/messages' && JSON.parse(s[0].q.recipient).id === '7801' && s[0].q.messaging_type === 'RESPONSE' && m0.quick_replies.length === 7 && m0.text === LT.SCRIPTS.welcome.text, s.map(x => x.q));
      check('live: the log says sent', (await lastLog('7801')).result === 'sent');
      await echo('7801', LT.SCRIPTS.welcome.text, 111); await sleep(400);
      await msg('7801', 'Magkano?', { quick_reply: { payload: 'LT_PRICE' } }); await waitLog('7801', 2);
      s = sentTo();
      check('live: our own echo is not mistaken for staff; price + where-is-the-land go out', s.length === 3 && JSON.parse(s[1].q.message).text === LT.SCRIPTS.price.text && JSON.parse(s[2].q.message).text === LT.SCRIPTS.ask_loc.text, s.map(x => JSON.parse(x.q.message).text.slice(0, 30)));
      th = await thread(`messenger:${LTP}:7801`);
      const items = await db.collection('socialitems').find({ threadKey: th.key, own: true }).toArray();
      check('live: what was sent shows in the inbox thread', new Set(items.map(i => i.text)).size === 3 && items.filter(i => /^m_out_/.test(i.metaId)).length === 3, items.map(i => i.text.slice(0, 20)));
      await msg('7801', 'gaano katagal po?'); await waitLog('7801', 3);
      l = await lastLog('7801');
      check('live: a script that is NOT approved is held, nothing is sent', l.result === 'held' && /tagal/.test(l.error) && sentTo().length === 3, l);
      const pc = await comment('Hm po?', '7811');
      await until(async () => (await logs({ threadKey: 'c:' + pc })).length >= 1, 6000);
      s = sentTo();
      const pr = s[s.length - 1];
      check('live: a question comment gets ONE private message (recipient = the comment)', s.length === 4 && JSON.parse(pr.q.recipient).comment_id === pc && !JSON.parse(pr.q.message).quick_replies, pr && pr.q);
      await deliver({ object: 'page', entry: [{ id: LTP, time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: LTP + '_99991', post_id: LTP + '_1', parent_id: pc, message: 'magkano nga po', from: { id: '7811', name: 'Test Commenter' }, created_time: Math.floor(Date.now() / 1000) } }] }] });
      await until(async () => (await logs({ threadKey: 'c:' + pc })).length >= 2, 6000);
      check('live: a second comment in that thread gets no second private message', sentTo().length === 4);
      const sp = await comment('Earn $500 daily crypto click here bit.ly/zz', '7812');
      await until(async () => (await logs({ threadKey: 'c:' + sp })).length >= 1, 6000);
      check('live: spam is not hidden unless hiding was switched on', !stub.calls.some(c => c.method === 'POST' && c.q.is_hidden));
      stub.failFor = '7803';
      await tap('7803', 'GET_STARTED'); await waitLog('7803', 1);
      l = await lastLog('7803');
      th = await thread(`messenger:${LTP}:7803`);
      check('live: when Meta refuses, it is logged as failed and the person goes to staff', l.result === 'failed' && th.lt.step === 'handoff' && !th.lt.sent.welcome, { l, lt: th.lt });
      await msg('7803', 'hello'); await sleep(700);
      check('live: no retry storm after a failure', sentTo().filter(x => JSON.parse(x.q.recipient).id === '7803').length === 1);
      stub.failFor = '';
      r = await A('POST', '/lt-auto/mode', admin, { mode: 'shadow' });
      check('back to shadow', r.status === 200 && r.json.mode === 'shadow');
    }
    // ── off ──
    r = await A('POST', '/lt-auto/mode', admin, { mode: 'off' });
    const before = (await logs()).length; stub.calls.length = 0;
    await sleep(100);
    await msg('7901', 'magkano po'); await sleep(900);
    check('off: nothing is sorted, recorded or sent', r.json.mode === 'off' && (await logs()).length === before && sentTo().length === 0);
    r = await A('POST', '/lt-auto/mode', admin, { mode: 'shadow' });
    await msg('7902', 'pa compute po'); await waitLog('7902', 1);
    check('shadow again: recording resumes', !!(await lastLog('7902')));
    // The 20-hour reminder (the tick runs inside the server every 10 minutes;
    // here the same function runs in this process on the same database).
    process.env.LT_PAGE_ID = LTP;
    const social = require(path.join(ROOT, 'server', 'social.js'));
    await db.collection('socialthreads').updateOne({ key: `messenger:${LTP}:7902` }, { $set: { lastInboundAt: new Date(Date.now() - 21 * 3600e3) } });
    const n1 = await social._test.ltTick();
    l = await lastLog('7902');
    check('20 hours of silence -> one reminder is recorded', n1 === 1 && l.scripts.join() === 'remind', { n1, l });
    check('the reminder is never repeated', (await social._test.ltTick()) === 0);
    await db.collection('socialthreads').updateOne({ key: `messenger:${LTP}:7701` }, { $set: { lastInboundAt: new Date(Date.now() - 21 * 3600e3) } });
    check('no reminder for someone who is not mid-questions', (await social._test.ltTick()) === 0);
    const audit = await db.collection('auditlogs').find({ action: /^SOCIAL_LT_AUTO/ }).toArray();
    check('mode changes and approvals are in the admin audit log', audit.length >= 3, audit.length);
  } finally { srv.close(); await mongoose.disconnect(); }
}

(async () => {
  engine();
  if (process.argv.includes('--stack')) await wiring();
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length} of ${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
