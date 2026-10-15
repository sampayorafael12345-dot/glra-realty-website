/* =============================================================================
   GLRA SOCIAL - the page (social.html)
   Signs in with the admin's own token (localStorage glra_admin_token), so there
   is no second password. Every rule that matters (who may publish, send, hide,
   delete) is enforced by the server; the buttons here only follow it.
   ========================================================================== */
(function () {
  'use strict';
  var TOKEN_KEY = 'glra_admin_token';
  var API = '/api/admin/social';
  var TZ = 'Asia/Manila';
  var S = { me: null, pages: [], page: '', tab: 'overview', badge: { pending: 0, unanswered: 0 }, templates: null };
  var C = null;            // the composer
  var CAL = { view: 'month', cursor: new Date(), data: null };
  var IB = { kind: '', status: 'open', tag: '', mine: false, key: '', threads: [], summary: null };
  var INS = { days: 30, from: '', to: '' };
  var TABS = [
    ['overview', 'Overview', 'fa-house'], ['compose', 'Compose', 'fa-pen-to-square'], ['calendar', 'Calendar', 'fa-calendar-days'],
    ['approvals', 'Approvals', 'fa-circle-check'], ['inbox', 'Inbox', 'fa-inbox'], ['insights', 'Insights', 'fa-chart-line'],
    ['library', 'Library', 'fa-photo-film'], ['activity', 'Activity', 'fa-clock-rotate-left'], ['settings', 'Settings', 'fa-sliders']
  ];
  var KIND = { fb_comment: ['Facebook comment', 'fab fa-facebook', 'fb'], ig_comment: ['Instagram comment', 'fab fa-instagram', 'ig'], messenger: ['Messenger', 'fab fa-facebook-messenger', 'fb'], ig_dm: ['Instagram message', 'fab fa-instagram', 'ig'] };
  var STATUS = { draft: ['Draft', ''], pending: ['Waiting for approval', 'warn'], changes: ['Sent back', 'bad'], approved: ['Approved', 'info'], publishing: ['Publishing', 'info'], scheduled: ['Scheduled', 'info'],
    published: ['Published', 'ok'], partial: ['Partly published', 'warn'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', ''], waiting: ['Waiting', 'info'], container: ['Instagram is processing', 'info'] };

  // ── helpers ─────────────────────────────────────────────────
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function n(v, d) { if (v == null || v === '' || isNaN(v)) return '–'; return Number(v).toLocaleString('en-US', { maximumFractionDigits: d == null ? 1 : d }); }
  function compact(v) { if (v == null || isNaN(v)) return '–'; v = Number(v); return Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : n(v, 0); }
  function peso(v) { return v == null ? '–' : '₱' + Number(v).toLocaleString('en-US', { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function fmt(d, o) { if (!d) return ''; var x = new Date(d); if (isNaN(x)) return ''; return x.toLocaleString('en-PH', Object.assign({ timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, o || {})); }
  function dayKey(d) { var x = new Date(d); return isNaN(x) ? '' : x.toLocaleDateString('en-CA', { timeZone: TZ }); }
  function timeOnly(d) { return new Date(d).toLocaleTimeString('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase(); }
  function ago(min) { if (min == null) return ''; if (min < 1) return 'now'; if (min < 60) return Math.round(min) + 'm'; if (min < 48 * 60) return Math.round(min / 60) + 'h'; return Math.round(min / 1440) + 'd'; }
  function manilaLocal(d) { var x = new Date(d.getTime() + 8 * 3600e3); return x.toISOString().slice(0, 16); }
  function todayKey() { return dayKey(new Date()); }
  function addDays(k, nn) { var d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + nn); return d.toISOString().slice(0, 10); }
  // No id at all (no Page connected yet) reads "Your Page", never "Page undefined".
  function pageOf(id) { if (id == null || id === '') return { id: '', name: 'Your Page', color: '#999', placeholder: true }; for (var i = 0; i < S.pages.length; i++) if (S.pages[i].id === String(id)) return S.pages[i]; return { id: id, name: 'Page ' + id, color: '#999' }; }
  function initials(s) { return String(s || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?'; }
  // A picture that does not load (an expired Meta CDN link) falls back to the initials;
  // any other broken image just leaves its grey tile.
  document.addEventListener('error', function (e) {
    var t = e.target; if (!t || t.tagName !== 'IMG') return;
    if (t.hasAttribute('data-i')) { var s = document.createElement('span'); s.className = t.className; s.textContent = t.getAttribute('data-i'); s.style.background = t.getAttribute('data-c') || '#888'; t.replaceWith(s); }
    else t.style.visibility = 'hidden';
  }, true);
  function avatar(p, cls) { return p && p.picture ? '<img class="so-avatar ' + (cls || '') + '" src="' + esc(p.picture) + '" alt="" data-i="' + esc(initials(p.name)) + '" data-c="' + esc(p.color || '#888') + '">' : '<span class="so-avatar ' + (cls || '') + '" style="background:' + esc((p && p.color) || '#888') + '">' + esc(initials(p && p.name)) + '</span>'; }
  function pill(text, kind, icon) { return '<span class="so-pill ' + (kind || '') + '">' + (icon ? '<i class="' + icon + '"></i>' : '') + esc(text) + '</span>'; }
  function statusPill(s) { var x = STATUS[s] || [s, '']; return pill(x[0], x[1]); }
  function netIcon(net) { return '<span class="so-net ' + net + '" title="' + (net === 'ig' ? 'Instagram' : 'Facebook') + '"><i class="fab fa-' + (net === 'ig' ? 'instagram' : 'facebook-f') + '"></i></span>'; }
  function hashtags(s) { return (String(s || '').match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length; }
  function can(k) { return !!(S.me && S.me.perms && S.me.perms[k]); }
  function empty(icon, text) { return '<div class="so-empty"><i class="fas ' + icon + '"></i>' + text + '</div>'; }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }

  function toast(msg, bad) {
    var box = $('#toast'), d = document.createElement('div');
    if (bad) d.className = 'bad';
    d.textContent = msg; box.appendChild(d);
    setTimeout(function () { d.remove(); }, bad ? 6500 : 3500);
  }
  function api(path, opt) {
    opt = opt || {};
    var h = { authorization: 'Bearer ' + token() };
    var body = opt.body;
    if (body && !(body instanceof FormData)) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
    return fetch(path.charAt(0) === '/' && path.indexOf('/api/') === 0 ? path : API + path, { method: opt.method || 'GET', headers: h, body: body }).then(function (r) {
      // Sliding sign-in: in its last 2 hours the server hands back a fresh
      // token, shared with the admin tab through the same storage key.
      var fresh = r.headers.get('X-Renewed-Token');
      if (fresh && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(fresh)) { try { localStorage.setItem(TOKEN_KEY, fresh); } catch (e) {} }
      var ct = r.headers.get('content-type') || '';
      return (ct.indexOf('json') >= 0 ? r.json() : r.blob()).then(function (j) {
        if (r.status === 401) { signedOut('Your sign-in has ended. Sign in again on the admin.'); throw new Error('Signed out'); }
        if (!r.ok) { var e = new Error((j && j.error) || ('Error ' + r.status)); e.status = r.status; e.data = j; throw e; }
        return j;
      });
    });
  }
  function fail(e) { if (e && e.message !== 'Signed out') toast(e.message || 'Something went wrong', true); }
  function download(path, name) {
    api(path).then(function (blob) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }).catch(fail);
  }

  // ── modal ──
  function modal(title, body, foot, wide) {
    closeModal();
    var s = document.createElement('div');
    s.className = 'so-scrim'; s.id = 'scrim';
    s.innerHTML = '<div class="so-modal' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="so-modal-h"><h2>' + esc(title) + '</h2><button class="so-iconbtn" data-act="closeModal" aria-label="Close"><i class="fas fa-xmark"></i></button></div><div class="so-modal-b">' + body + '</div>' + (foot ? '<div class="so-modal-f">' + foot + '</div>' : '') + '</div>';
    s.addEventListener('mousedown', function (e) { if (e.target === s) closeModal(); });
    document.body.appendChild(s);
    document.body.style.overflow = 'hidden';
    var f = s.querySelector('input,textarea,select,button:not([data-act=closeModal])'); if (f && window.innerWidth > 700) setTimeout(function () { f.focus(); }, 30);
    return s;
  }
  function closeModal() { var s = $('#scrim'); if (s) s.remove(); document.body.style.overflow = ''; }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  // ── look switch (shared with the admin) ──
  function setLook(l) { try { localStorage.setItem('glra.admin.look', l); } catch (e) {} document.documentElement.setAttribute('data-glra-look', l); syncLook(); }
  function setMode(dark) { try { localStorage.setItem('darkMode', String(dark)); } catch (e) {} document.documentElement.setAttribute('data-glra-mode', dark ? 'dark' : 'light'); syncLook(); }
  function syncLook() {
    var l = document.documentElement.getAttribute('data-glra-look'), d = document.documentElement.getAttribute('data-glra-mode') === 'dark';
    $$('[data-look]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-look') === l)); });
    $('#modeBtn').innerHTML = '<i class="fas fa-' + (d ? 'sun' : 'moon') + '"></i>';
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.content = d ? (l === 'bold' ? '#0e0e10' : '#140d09') : (l === 'bold' ? '#f4f4f1' : '#f6f1ec');
  }
  $$('[data-look]').forEach(function (b) { b.addEventListener('click', function () { setLook(b.getAttribute('data-look')); }); });
  $('#modeBtn').addEventListener('click', function () { setMode(document.documentElement.getAttribute('data-glra-mode') !== 'dark'); });
  window.addEventListener('storage', function (e) { if (e.key === 'glra.admin.look' || e.key === 'darkMode') { var l = localStorage.getItem('glra.admin.look'); document.documentElement.setAttribute('data-glra-look', l === 'bold' ? 'bold' : 'glass'); document.documentElement.setAttribute('data-glra-mode', localStorage.getItem('darkMode') === 'true' ? 'dark' : 'light'); syncLook(); } });
  syncLook();

  // ── boot ──
  function signedOut(msg) {
    $('#tabs').innerHTML = '';
    $('#view').innerHTML = '<div class="so-center"><div class="so-card"><h2 style="justify-content:center"><i class="fas fa-lock"></i> Sign in first</h2><p class="so-muted">' + esc(msg || 'GLRA Social uses your admin sign-in. Sign in on the admin, then come back here.') + '</p><a class="so-btn pri" href="/admin.html">Open the admin sign-in</a></div></div>';
  }
  function noAccess(msg, icon) {
    $('#tabs').innerHTML = '';
    $('#view').innerHTML = '<div class="so-center"><div class="so-card"><h2 style="justify-content:center"><i class="fas ' + (icon || 'fa-user-lock') + '"></i> ' + esc(msg[0]) + '</h2><p class="so-muted">' + esc(msg[1]) + '</p><a class="so-btn" href="/admin.html">Back to the admin</a></div></div>';
  }
  function boot() {
    if (!token()) return signedOut();
    api('/me').then(function (me) {
      S.me = me; S.pages = me.pages || [];
      try { S.page = localStorage.getItem('glra.social.page') || ''; } catch (e) {}
      if (S.page && !S.pages.some(function (p) { return p.id === S.page; })) S.page = '';
      $('#whoami').textContent = me.user.name || me.user.email;
      $('#pageSel').innerHTML = '<option value="">All Pages</option>' + S.pages.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === S.page ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('');
      renderTabs(); route(); refreshBadge();
      setInterval(refreshBadge, 60000);
    }).catch(function (e) {
      if (e.status === 404) return noAccess(['GLRA Social is switched off', 'An admin turns it on with SOCIAL_ENABLED=1 in Render.'], 'fa-power-off');
      if (e.status === 403) return noAccess(['No access yet', 'Ask an admin to tick "View GLRA Social" for your account in Accounts.']);
      if (e.message !== 'Signed out') noAccess(['Could not load', e.message], 'fa-triangle-exclamation');
    });
  }
  $('#pageSel').addEventListener('change', function () { S.page = this.value; try { localStorage.setItem('glra.social.page', S.page); } catch (e) {} route(true); });
  function refreshBadge() { api('/badge').then(function (b) { S.badge = b; renderTabs(); }).catch(function () {}); }
  function renderTabs() {
    $('#tabs').innerHTML = TABS.map(function (t) {
      var c = t[0] === 'approvals' ? S.badge.pending : t[0] === 'inbox' ? S.badge.unanswered : 0;
      return '<button class="so-tab" role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '"><i class="fas ' + t[2] + '"></i>' + t[1] + (c ? '<span class="so-count">' + c + '</span>' : '') + (t[0] === 'overview' && S.badge.tokenProblem ? '<span class="so-count" title="A connection needs attention">!</span>' : '') + '</button>';
    }).join('');
    var a = $('.so-tab[aria-selected=true]'); if (a && a.scrollIntoView && window.innerWidth < 760) a.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  function route(keep) {
    var h = (location.hash || '').replace('#', '').split('/')[0];
    S.tab = TABS.some(function (t) { return t[0] === h; }) ? h : 'overview';
    renderTabs();
    var fn = VIEWS[S.tab];
    if (!keep) window.scrollTo(0, 0);
    fn();
  }
  window.addEventListener('hashchange', function () { route(); });
  function go(tab) { if (location.hash === '#' + tab) route(); else location.hash = tab; }
  function setView(html) { $('#view').innerHTML = html; }
  function loading() { setView('<div class="so-center" style="min-height:40vh"><div class="so-spin" role="status" aria-label="Loading"></div></div>'); }
  function head(title, sub, right) { return '<div class="so-head"><div><h1 class="so-h1">' + title + '</h1>' + (sub ? '<p class="so-sub">' + sub + '</p>' : '') + '</div>' + (right ? '<div class="so-btns">' + right + '</div>' : '') + '</div>'; }

  // ── event delegation ──
  var ACT = {}, INP = {};
  document.addEventListener('click', function (e) { var el = e.target.closest('[data-act]'); if (!el || el.disabled) return; var f = ACT[el.getAttribute('data-act')]; if (f) { e.preventDefault(); f(el, e); } });
  document.addEventListener('input', function (e) { var el = e.target.closest('[data-in]'); if (el && INP[el.getAttribute('data-in')]) INP[el.getAttribute('data-in')](el, e); });
  document.addEventListener('change', function (e) { var el = e.target.closest('[data-ch]'); if (el && INP[el.getAttribute('data-ch')]) INP[el.getAttribute('data-ch')](el, e); });
  ACT.tab = function (el) { go(el.getAttribute('data-tab')); };
  ACT.closeModal = closeModal;
  ACT.go = function (el) { go(el.getAttribute('data-to')); };

  var VIEWS = {};

  // ══ OVERVIEW ══════════════════════════════════════════════════
  VIEWS.overview = function () {
    loading();
    Promise.all([api('/me'), api('/posts?status=pending,approved,scheduled,publishing,failed&limit=40'), api('/inbox/summary')]).then(function (r) {
      S.me = r[0]; S.pages = r[0].pages;
      var me = r[0], posts = r[1].posts, ib = r[2];
      var tok = me.tokens, banners = '';
      if (tok && tok.system && !tok.system.ok) banners += '<div class="so-banner bad"><i class="fas fa-triangle-exclamation"></i><div><b>The Meta connection needs attention.</b> ' + esc(tok.system.problem) + '</div></div>';
      Object.keys((tok && tok.pages) || {}).forEach(function (id) { var t = tok.pages[id]; if (!t.ok) banners += '<div class="so-banner bad"><i class="fas fa-plug-circle-xmark"></i><div><b>' + esc(pageOf(id).name) + ':</b> ' + esc(t.problem) + '</div></div>'; });
      if (me.usage && (me.usage.paused || me.usage.slowed)) banners += '<div class="so-banner warn"><i class="fas fa-gauge-high"></i><div><b>Slowed down by Meta.</b> The Pages are near Meta\'s call limit, so GLRA Social is pacing itself' + (me.usage.pauseUntil ? ' until ' + esc(fmt(me.usage.pauseUntil)) : '') + '. Nothing is lost.</div></div>';
      if (!tok) banners += '<div class="so-banner info"><i class="fas fa-circle-info"></i><div><b>Not checked yet.</b> The Pages and tokens are checked once a day.' + (can('approve') ? ' Press "Check Pages now" to do it straight away.' : '') + '</div></div>';
      var missing = tok && tok.system && tok.system.missing || [];
      var up = posts.filter(function (p) { return ['scheduled', 'approved', 'publishing'].indexOf(p.status) >= 0; }).sort(function (a, b) { return new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0); }).slice(0, 6);
      var failed = posts.filter(function (p) { return p.status === 'failed' || p.status === 'partial'; });
      var waitingTotal = ib.pages.reduce(function (a, p) { return a + p.waiting; }, 0), lateTotal = ib.pages.reduce(function (a, p) { return a + p.unanswered; }, 0);
      var html = head('Good ' + (new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }) < 12 ? 'morning' : 'day') + ', ' + esc((me.user.name || '').split(' ')[0] || 'there'),
        S.pages.length + ' Page' + (S.pages.length === 1 ? '' : 's') + ' connected · ' + (can('approve') ? 'you can approve and publish' : can('draft') ? 'you write drafts; an approver publishes them' : 'view only'),
        (can('approve') ? '<button class="so-btn" data-act="checkPages"><i class="fas fa-rotate"></i>Check Pages now</button>' : '') + (can('draft') ? '<button class="so-btn pri" data-act="go" data-to="compose"><i class="fas fa-pen"></i>New post</button>' : ''));
      html += banners;
      html += '<div class="so-grid so-g4" style="margin-bottom:16px">' +
        kpi('Waiting for approval', S.badge.pending || 0, '<a href="#approvals">Open approvals</a>', true) +
        kpi('Waiting for a reply', waitingTotal, lateTotal ? '<span class="d down">' + lateTotal + ' over ' + ib.unansweredHours + ' h</span>' : '<span class="d up">none overdue</span>') +
        kpi('Scheduled', up.length, up[0] ? 'next ' + esc(fmt(up[0].scheduledAt || up[0].approvedAt)) : 'nothing queued') +
        kpi('Failed', failed.length, failed.length ? '<a href="#calendar">see why</a>' : 'all clear') + '</div>';
      html += '<div class="so-grid so-pages">' + S.pages.map(function (p) { return pageCard(p, tok, me.inboxStatus || {}, ib.pages.filter(function (x) { return x.pageId === p.id; })[0]); }).join('') + '</div>';
      html += '<div class="so-grid so-g2" style="margin-top:16px">';
      html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-calendar-check"></i>Coming up</h2><a class="so-btn sm" href="#calendar">Calendar</a></div>' + (up.length ? '<div class="so-list">' + up.map(postRow).join('') + '</div>' : empty('fa-calendar', 'Nothing scheduled yet.')) + '</div>';
      html += '<div class="so-card"><h2><i class="fas fa-link"></i>Connect another Page</h2><ol class="so-small" style="margin:0;padding-left:18px;line-height:1.7">' +
        '<li>Business Settings → System users → <b>glra-integration</b> → Assign assets: add the Page (Full control) and its Instagram account.</li>' +
        '<li>Add the Page id to <b>META_PAGE_IDS</b> in Render (comma separated) and redeploy.</li>' +
        '<li>Here: <b>Check Pages now</b>, then <b>Connect to webhook</b> on the new Page card.</li></ol>' +
        '<p class="so-small so-muted" style="margin:10px 0 0">Webhook address: <code>' + esc(me.webhookUrl) + '</code>. Fields: Page <code>feed</code>, <code>messages</code>; Instagram <code>comments</code>, <code>messages</code>.</p>' +
        (missing.length ? '<hr class="so-hr"><h3><i class="fas fa-key"></i>Permissions the token does not have yet</h3><div class="so-col so-small">' + missing.map(function (m) { return '<div class="so-between"><code>' + esc(m.scope) + '</code><span class="so-muted">' + esc(m.for) + '</span></div>'; }).join('') + '</div><p class="so-tiny so-muted">Regenerate the system user token with these ticked (some need App Review first).</p>' : '') + '</div>';
      html += '</div>';
      setView(html);
    }).catch(fail);
  };
  function kpi(l, v, d, hero) { return '<div class="so-kpi' + (hero ? ' hero' : '') + '"><div class="l">' + esc(l) + '</div><div class="v">' + v + '</div><div class="d so-small">' + (d || '') + '</div></div>'; }
  function pageCard(p, tok, inboxStatus, ib) {
    var t = tok && tok.pages && tok.pages[p.id];
    var tline = !t ? pill('Not checked yet', '', 'fas fa-circle-question') : t.ok ? pill('Connected', 'ok', 'fas fa-circle-check') : pill('Needs attention', 'bad', 'fas fa-triangle-exclamation');
    var surf = ['messenger', 'fb_comment', 'ig_dm', 'ig_comment'].filter(function (k) { return inboxStatus[p.id + '.' + k]; }).map(function (k) {
      var s = inboxStatus[p.id + '.' + k];
      return '<div class="so-stat"><span>' + KIND[k][0] + 's</span><b>' + (s.ok ? pill('Reading', 'ok') : '<span class="so-pill warn" title="' + esc(s.message) + '">' + (/permission|review|\(#10\)|\(#200\)/i.test(s.message || '') ? 'Waits for App Review' : 'Error') + '</span>') + '</b></div>';
    }).join('');
    return '<div class="so-card so-pagecard"><div class="so-row" style="flex-wrap:nowrap">' + avatar(p) + '<div style="min-width:0;flex:1"><div style="font-weight:800;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.name) + '</div><div class="so-row so-small so-muted"><span class="so-dot" style="background:' + esc(p.color) + '"></span>Page ' + esc(p.id) + '</div></div>' + tline + '</div>' +
      (t && !t.ok ? '<div class="so-banner bad" style="margin:0"><i class="fas fa-circle-exclamation"></i><div class="so-small">' + esc(t.problem) + '</div></div>' : '') +
      '<div><div class="so-stat"><span>' + netIcon('fb') + ' Facebook followers</span><b>' + compact(p.followers) + '</b></div>' +
      '<div class="so-stat"><span>' + netIcon('ig') + ' Instagram</span><b>' + (p.igId ? '@' + esc(p.igUsername || p.igId) + ' · ' + compact(p.igFollowers) : '<span class="so-muted">not linked</span>') + '</b></div>' +
      (ib ? '<div class="so-stat"><span>Waiting for a reply</span><b>' + ib.waiting + (ib.unanswered ? ' <span class="so-pill bad">' + ib.unanswered + ' overdue</span>' : '') + '</b></div>' : '') + surf + '</div>' +
      (p.discoverError ? '<p class="so-small" style="color:var(--lk-bad);margin:0">' + esc(p.discoverError) + '</p>' : '') +
      (can('admin') ? '<div class="so-bar"><button class="so-btn sm full" data-act="subscribe" data-id="' + esc(p.id) + '"><i class="fas fa-plug"></i>Connect to webhook</button></div>' : '') + '</div>';
  }
  function postRow(p) {
    var pages = uniq(p.targets.map(function (t) { return t.pageId; }));
    return '<div class="so-li" role="button" tabindex="0" data-act="openPost" data-id="' + p._id + '" style="cursor:pointer">' + (p.media[0] ? mediaThumb(p.media[0]) : '<span class="so-thumb" style="display:flex;align-items:center;justify-content:center"><i class="fas fa-align-left so-muted"></i></span>') +
      '<div style="flex:1;min-width:0"><div class="t">' + esc(p.title || p.caption || '(no text)') + '</div><div class="so-row so-small so-muted" style="margin-top:4px">' + statusPill(p.status) + uniq(p.targets.map(function (t) { return t.network; })).map(netIcon).join('') +
      pages.map(function (id) { return '<span style="display:inline-flex;align-items:center;gap:5px;min-width:0"><span class="so-dot" style="background:' + esc(pageOf(id).color) + '"></span>' + esc(pageOf(id).name) + '</span>'; }).join('') + '</div>' +
      '<div class="so-small so-muted" style="margin-top:2px">' + (p.scheduledAt ? '<i class="far fa-clock"></i> ' + esc(fmt(p.scheduledAt)) : 'As soon as approved') + (p.leads && p.leads.total ? ' · <b style="color:var(--lk-accent-text)">' + p.leads.total + ' lead' + (p.leads.total > 1 ? 's' : '') + '</b>' : '') + '</div></div></div>';
  }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function mediaThumb(m, cls) { return m.type === 'video' ? '<video class="so-thumb ' + (cls || '') + '" src="' + esc(m.url) + '#t=0.5" muted preload="metadata"></video>' : '<img class="so-thumb ' + (cls || '') + '" src="' + esc(m.url) + '" alt="" loading="lazy">'; }
  ACT.checkPages = function (el) { el.disabled = true; api('/pages/refresh', { method: 'POST' }).then(function () { toast('Pages and tokens checked'); refreshBadge(); VIEWS.overview(); }).catch(fail).then(function () { el.disabled = false; }); };
  ACT.subscribe = function (el) { el.disabled = true; api('/pages/' + el.getAttribute('data-id') + '/subscribe', { method: 'POST' }).then(function (r) { toast('Connected: ' + r.fields.join(', ')); }).catch(fail).then(function () { el.disabled = false; }); };

  // ══ COMPOSE ═══════════════════════════════════════════════════
  function newCompose() {
    var sel = {};
    (S.page ? [pageOf(S.page)] : S.pages.slice(0, 1)).forEach(function (p) { sel['fb:' + p.id] = true; });
    return { id: null, status: 'draft', title: '', caption: '', capFb: '', capIg: '', split: false, perPage: null, usePerPage: false, link: '', media: [], sel: sel, when: 'now', at: '', propertyId: '', origin: 'compose', fill: null,
      previewNet: 'fb', previewPage: '', check: null, slots: null, ai: false };
  }
  function targetsOf() {
    return Object.keys(C.sel).filter(function (k) { return C.sel[k]; }).map(function (k) {
      var net = k.split(':')[0], pid = k.split(':')[1], cap = '';
      if (C.usePerPage && C.perPage && C.perPage[pid]) cap = C.perPage[pid][net] || '';
      else if (C.split && net === 'ig') cap = C.capIg;
      return { network: net, pageId: pid, caption: cap };
    });
  }
  function payload(action) {
    return { title: C.title, caption: C.split ? C.capFb : C.caption, link: C.link, media: C.media, targets: targetsOf(), scheduledAt: C.when === 'at' ? C.at : null, propertyId: C.propertyId, origin: C.origin, action: action };
  }
  function textFor(net, pid) {
    if (C.usePerPage && C.perPage && C.perPage[pid]) return C.perPage[pid][net] || '';
    if (C.split) return net === 'ig' ? C.capIg : C.capFb;
    return C.caption;
  }
  VIEWS.compose = function () {
    if (!can('draft')) return setView(head('Compose') + '<div class="so-card">' + empty('fa-lock', 'Your account can view GLRA Social but not write posts. Ask an admin for "Write social drafts".') + '</div>');
    if (!C) C = newCompose();
    renderCompose();
    loadSlots();
  };
  function renderCompose() {
    var L = S.me.limits;
    var editing = C.id ? '<span class="so-pill info">Editing ' + esc((STATUS[C.status] || [C.status])[0].toLowerCase()) + ' post</span>' : '';
    var html = head('Compose ' + editing, 'Write once, post to any of the Pages and their Instagram accounts. Everything waits for approval' + (can('approve') ? ' (you can approve it straight away)' : '') + '.',
      '<button class="so-btn" data-act="cNew"><i class="fas fa-file"></i>Start over</button>');
    html += '<div class="so-compose"><div class="so-col" style="gap:16px">';
    // targets
    html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-bullseye"></i>Post to</h2><span class="so-small so-muted">' + targetsOf().length + ' selected</span></div><div class="so-targets">' + S.pages.map(function (p) {
      return '<div class="so-target">' + avatar(p, 'xs') + '<span class="n">' + esc(p.name) + '</span>' +
        '<button class="so-chip" data-act="cSel" data-k="fb:' + p.id + '" aria-pressed="' + !!C.sel['fb:' + p.id] + '"><i class="fab fa-facebook"></i>Facebook</button>' +
        '<button class="so-chip" data-act="cSel" data-k="ig:' + p.id + '" aria-pressed="' + !!C.sel['ig:' + p.id] + '"' + (p.igId ? '' : ' disabled title="No Instagram account linked"') + '><i class="fab fa-instagram"></i>' + (p.igUsername ? '@' + esc(p.igUsername) : 'Instagram') + '</button></div>';
    }).join('') + '</div></div>';
    // start from
    html += '<div class="so-card"><h2><i class="fas fa-wand-magic-sparkles"></i>Start from</h2><div class="so-bar" style="justify-content:start">' +
      '<button class="so-btn" data-act="cListing"><i class="fas fa-building"></i>Post a listing</button>' +
      '<button class="so-btn" data-act="cTemplate"><i class="fas fa-file-lines"></i>Template</button>' +
      '<button class="so-btn' + (C.ai ? ' ink' : '') + '" data-act="cAi"><i class="fas fa-robot"></i>Write with AI</button></div>' +
      (C.ai ? aiPanel() : '') + (C.propertyId ? '<div class="so-banner info" style="margin:12px 0 0"><i class="fas fa-building"></i><div class="so-small">From the listing <b>' + esc(C.title) + '</b>. Links to the website get tracking tags per Page and network when published, so leads from this post show here.</div></div>' : '') + '</div>';
    // caption
    var cap = C.split ? '' : capField('caption', 'Caption', C.caption, 'both');
    var split = C.split ? capField('capFb', 'Facebook text', C.capFb, 'fb') + capField('capIg', 'Instagram caption', C.capIg, 'ig') : '';
    html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-align-left"></i>Text</h2><label class="so-check so-small"><input type="checkbox" data-ch="cSplit"' + (C.split ? ' checked' : '') + '> Different text for Facebook and Instagram</label></div>' +
      '<div class="so-col">' + cap + split +
      (C.perPage ? '<label class="so-check so-small"><input type="checkbox" data-ch="cPerPage"' + (C.usePerPage ? ' checked' : '') + '> Use each Page\'s own sign-off from "Post a listing"</label>' : '') +
      '<div class="so-row"><select data-ch="cHashSet" aria-label="Add a hashtag set" style="max-width:260px"><option value="">+ Hashtag set…</option></select><span class="so-tiny so-muted">Placeholders: {property} {price} {area} {link} {page}</span></div>' +
      '<label class="so-field"><span>Internal label (only you see this)</span><input type="text" data-in="cTitle" value="' + esc(C.title) + '" maxlength="200" placeholder="e.g. Sondris open house, week 42"></label></div></div>';
    // media
    html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-images"></i>Photos or video</h2><span class="so-small so-muted">' + C.media.length + ' / ' + L.media + '</span></div><div class="so-media">' +
      C.media.map(function (m, i) {
        var bad = m.type === 'image' && m.width && m.height && (m.width / m.height < 0.795 || m.width / m.height > 1.915);
        return '<div class="so-mi">' + (m.type === 'video' ? '<video src="' + esc(m.url) + '#t=0.5" muted preload="metadata"></video>' : '<img src="' + esc(m.url) + '" alt="">') +
          (bad ? '<span class="badge so-pill warn" title="Instagram takes 4:5 to 1.91:1">IG crop</span>' : '') + '<span class="num">' + (i + 1) + '</span>' +
          '<div class="tools">' + (i ? '<button data-act="cMove" data-i="' + i + '" aria-label="Move earlier"><i class="fas fa-arrow-left"></i></button>' : '') + '<button data-act="cDrop" data-i="' + i + '" aria-label="Remove"><i class="fas fa-xmark"></i></button></div></div>';
      }).join('') +
      (C.media.length < L.media ? (S.me.cloudinary ? '<label class="so-add"><i class="fas fa-upload"></i>Upload<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" data-ch="cUpload" class="so-sr"></label>' : '') +
        '<button class="so-add" data-act="cLibrary"><i class="fas fa-photo-film"></i>From library</button><button class="so-add" data-act="cUrl"><i class="fas fa-link"></i>Paste a link</button>' : '') + '</div>' +
      '<p class="so-tiny so-muted" style="margin:10px 0 0">Up to 10 photos, or one video. Instagram needs a photo or video, takes 4:5 to 1.91:1 (Cloudinary photos are cropped to fit) and only public links.</p></div>';
    // link
    html += '<div class="so-card"><h2><i class="fas fa-link"></i>Link <span class="so-pill">Facebook only</span></h2><label class="so-field"><span class="so-sr">Link</span><input type="url" data-in="cLink" value="' + esc(C.link) + '" placeholder="https://glrarealty.com/property/…"></label></div>';
    // when
    html += '<div class="so-card"><h2><i class="far fa-clock"></i>When</h2><div class="so-seg" role="group" aria-label="When"><button data-act="cWhen" data-v="now" aria-pressed="' + (C.when === 'now') + '">As soon as approved</button><button data-act="cWhen" data-v="at" aria-pressed="' + (C.when === 'at') + '">Schedule</button></div>' +
      (C.when === 'at' ? '<div class="so-col" style="margin-top:12px"><label class="so-field"><span>Date and time (Manila)</span><input type="datetime-local" data-in="cAt" value="' + esc(C.at) + '" min="' + esc(manilaLocal(new Date(Date.now() + 11 * 60e3))) + '"></label>' +
        '<div><div class="so-label" style="margin-bottom:6px"><i class="fas fa-fire"></i> Best times' + (C.slots ? ' <span class="so-tiny so-muted">(' + esc(C.slots.basis) + ')</span>' : '') + '</div><div class="so-slots">' + (C.slots ? C.slots.slots.map(function (s) { return '<button class="so-chip" data-act="cSlot" data-v="' + esc(s.local) + '" aria-pressed="' + (C.at === s.local) + '">' + esc(s.label) + ' · ' + esc(fmt(s.at, { weekday: undefined, hour: undefined, minute: undefined })) + '</button>'; }).join('') : '<span class="so-small so-muted">Loading…</span>') + '</div></div>' +
        '<p class="so-tiny so-muted" style="margin:0">Facebook posts use Facebook\'s own scheduler (10 minutes to 75 days ahead), so they go out even if our server sleeps. Instagram posts are published by GLRA Social at the time.</p></div>' : '') + '</div>';
    // check + actions
    html += '<div class="so-card"><h2><i class="fas fa-list-check"></i>Check</h2><div class="so-issues" id="cIssues">' + issuesHtml() + '</div><hr class="so-hr"><div class="so-bar">' +
      '<button class="so-btn" data-act="cSave" data-v="save"><i class="far fa-floppy-disk"></i>Save draft</button>' +
      '<button class="so-btn ' + (can('approve') ? '' : 'pri') + '" data-act="cSave" data-v="submit"><i class="fas fa-paper-plane"></i>Submit for approval</button>' +
      (can('approve') ? '<button class="so-btn pri full" data-act="cSave" data-v="approve"><i class="fas fa-circle-check"></i>' + (C.when === 'at' ? 'Approve &amp; schedule' : 'Approve &amp; publish') + '</button>' : '') + '</div></div>';
    html += '</div><div class="so-sticky" id="cPreviewBox">' + previewHtml() + '</div></div>';
    setView(html);
    fillHashSets();
    check();
  }
  function counterInner(val, net) {
    var t = String(val || ''), L = S.me.limits, chars = t.length, tags = hashtags(t), ig = net !== 'fb';
    return '<span' + (ig && chars > L.igCaption ? ' class="over"' : '') + '><b>' + chars + '</b>' + (ig ? ' / ' + L.igCaption : '') + ' characters</span>' +
      (ig ? '<span' + (tags > L.igHashtags ? ' class="over"' : '') + '><b>' + tags + '</b> / ' + L.igHashtags + ' hashtags' + (net === 'both' ? ' (Instagram)' : '') + '</span>' : '') +
      (net !== 'ig' ? '<span>Facebook folds after ~480</span>' : '');
  }
  function capField(key, label, val, net) {
    return '<label class="so-field"><span>' + label + '</span><textarea data-in="cCap" data-k="' + key + '" rows="' + (key === 'caption' ? 7 : 6) + '" placeholder="What\'s new? A listing, an open house, a tip…">' + esc(val || '') + '</textarea>' +
      '<div class="so-counter" data-counter="' + key + '">' + counterInner(val, net) + '</div></label>';
  }
  function aiPanel() {
    if (!S.me.ai) return '<div class="so-banner info" style="margin:12px 0 0"><i class="fas fa-robot"></i><div class="so-small">AI writing is not set up. It uses the same keys as the website chat: add <code>GEMINI_API_KEY</code> or <code>GROQ_API_KEY</code> in Render.</div></div>';
    var tones = { professional: 'Professional', warm_taglish: 'Warm Taglish', luxury: 'Luxury', short: 'Short' };
    return '<div class="so-well" style="margin-top:12px"><div class="so-col"><div class="so-seg" role="group" aria-label="Tone">' + S.me.tones.map(function (t) { return '<button data-act="cTone" data-v="' + t + '" aria-pressed="' + ((C.tone || 'professional') === t) + '">' + (tones[t] || t) + '</button>'; }).join('') + '</div>' +
      '<label class="so-field"><span>What is it about?</span><textarea data-in="cBrief" rows="3" placeholder="e.g. Open house this Saturday 10am-4pm at Sondris, 2BR units, free parking">' + esc(C.brief || '') + '</textarea></label>' +
      '<div class="so-between"><span class="so-tiny so-muted">' + (C.propertyId ? 'Uses the listing\'s facts. ' : '') + 'The AI only writes a draft here: you edit it, and it still needs approval.</span><button class="so-btn pri sm" data-act="cAiGo"><i class="fas fa-wand-magic-sparkles"></i>Write</button></div></div></div>';
  }
  function issuesHtml() {
    var c = C.check;
    if (!c) return '<div class="so-muted"><i class="fas fa-spinner fa-spin"></i>Checking…</div>';
    if (!c.errors.length && !c.warnings.length) return '<div class="k"><i class="fas fa-circle-check"></i>Ready. Nothing will stop this from publishing.</div>';
    return c.errors.map(function (e) { return '<div class="e"><i class="fas fa-circle-xmark"></i><span>' + esc(e) + '</span></div>'; }).join('') + c.warnings.map(function (w) { return '<div class="w"><i class="fas fa-triangle-exclamation"></i><span>' + esc(w) + '</span></div>'; }).join('');
  }
  var check = debounce(function () {
    if (!C) return;
    api('/posts/check', { method: 'POST', body: payload() }).then(function (r) { C.check = r; var b = $('#cIssues'); if (b) b.innerHTML = issuesHtml(); }).catch(function () {});
  }, 450);
  function refreshPreview() { var b = $('#cPreviewBox'); if (b) b.innerHTML = previewHtml(); }
  function linkify(t) { return esc(t).replace(/(^|\s)(#[\p{L}\p{N}_]+)/gu, '$1<span class="ht">$2</span>'); }
  function previewHtml() {
    var tg = targetsOf();
    var pid = C.previewPage && tg.some(function (t) { return t.pageId === C.previewPage; }) ? C.previewPage : (tg[0] ? tg[0].pageId : (S.pages[0] || {}).id);
    var p = pageOf(pid), net = C.previewNet;
    var text = textFor(net, pid).replace(/\{page\}/g, p.name);
    var pages = uniq(tg.map(function (t) { return t.pageId; }));
    var bar = (p.placeholder ? '<p class="so-small so-muted" style="margin:0 0 8px"><i class="fas fa-circle-info"></i> Connect a Page first (Overview, "Connect another Page"). Until then the preview shows a stand-in name.</p>' : '') + '<div class="so-between" style="margin-bottom:10px"><div class="so-seg" role="group" aria-label="Preview"><button data-act="cPrev" data-v="fb" aria-pressed="' + (net === 'fb') + '"><i class="fab fa-facebook"></i> Feed</button><button data-act="cPrev" data-v="ig" aria-pressed="' + (net === 'ig') + '"><i class="fab fa-instagram"></i> Instagram</button></div>' +
      (pages.length > 1 ? '<select data-ch="cPrevPage" aria-label="Preview which Page" style="max-width:170px">' + pages.map(function (id) { return '<option value="' + id + '"' + (id === pid ? ' selected' : '') + '>' + esc(pageOf(id).name) + '</option>'; }).join('') + '</select>' : '') + '</div>';
    var now = new Date().toLocaleTimeString('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/i, '');
    var screen;
    if (net === 'fb') {
      var limit = 480, shown = text.length > limit ? text.slice(0, text.lastIndexOf(' ', limit) > 300 ? text.lastIndexOf(' ', limit) : limit) : text;
      var media = C.media, grid = '';
      if (media.length === 1) grid = '<div class="so-fb-grid">' + (media[0].type === 'video' ? '<video src="' + esc(media[0].url) + '#t=0.5" muted style="aspect-ratio:4/5"></video>' : '<img src="' + esc(media[0].url) + '" alt="" style="max-height:420px">') + '</div>';
      else if (media.length > 1) {
        var four = media.slice(0, 4);
        grid = '<div class="so-fb-grid" style="grid-template-columns:1fr 1fr;grid-auto-rows:150px">' + four.map(function (m, i) { return '<div class="' + (i === 3 && media.length > 4 ? 'more-n' : '') + '"' + (media.length === 3 && i === 0 ? ' style="grid-row:span 2"' : '') + '><img src="' + esc(m.url) + '" alt="">' + (i === 3 && media.length > 4 ? '<span>+' + (media.length - 4) + '</span>' : '') + '</div>'; }).join('') + '</div>';
      } else if (C.link) grid = '<div class="so-fb-link"><div class="d">' + esc((C.link.match(/^https?:\/\/([^/]+)/) || [])[1] || '') + '</div><div class="h">' + esc(C.title || 'Link preview') + '</div></div>';
      screen = '<div class="so-fb-head">' + (p.picture ? '<img class="av" src="' + esc(p.picture) + '" alt="" data-i="' + esc(initials(p.name)) + '" data-c="' + esc(p.color) + '">' : '<span class="av" style="background:' + esc(p.color) + '">' + esc(initials(p.name)) + '</span>') + '<div><div class="nm">' + esc(p.name) + '</div><div class="tm">' + (C.when === 'at' && C.at ? esc(fmt(C.at + ':00+08:00')) : 'Just now') + ' · <i class="fas fa-earth-asia"></i></div></div></div>' +
        (text ? '<div class="so-fb-text">' + linkify(shown) + (shown.length < text.length ? '<span class="more">… See more</span>' : '') + '</div>' : (!C.media.length && !C.link ? '<div class="so-fb-text" style="color:#8a8d91">Your post appears here as you write it.</div>' : '')) + grid +
        '<div class="so-fb-actions"><span><i class="far fa-thumbs-up"></i> Like</span><span><i class="far fa-comment"></i> Comment</span><span><i class="fas fa-share"></i> Share</span></div>';
    } else {
      var user = p.igUsername || 'instagram';
      var m0 = C.media[0];
      var cut = 125, capShown = text.length > cut ? text.slice(0, cut) : text;
      screen = '<div class="so-ig-head"><span class="av">' + (p.igPicture ? '<img src="' + esc(p.igPicture) + '" alt="">' : '<span>' + esc(initials(p.name)) + '</span>') + '</span><b style="font-size:13.5px">' + esc(user) + '</b></div>' +
        (m0 ? '<div class="so-ig-media">' + (m0.type === 'video' ? '<video src="' + esc(m0.url) + '#t=0.5" muted></video>' : '<img src="' + esc(m0.url) + '" alt="">') + (C.media.length > 1 ? '<span class="so-ig-count">1/' + C.media.length + '</span>' : '') + '</div>' + (C.media.length > 1 ? '<div class="so-ig-dots">' + C.media.slice(0, 8).map(function () { return '<i></i>'; }).join('') + '</div>' : '')
          : '<div class="so-ig-none"><i class="far fa-image" style="font-size:30px"></i>Instagram needs a photo or a video.<br>Text-only and link posts are not possible there.</div>') +
        '<div class="so-ig-actions"><i class="far fa-heart"></i><i class="far fa-comment"></i><i class="far fa-paper-plane"></i><span style="flex:1"></span><i class="far fa-bookmark"></i></div>' +
        '<div class="so-ig-cap"><b>' + esc(user) + '</b> ' + linkify(capShown) + (capShown.length < text.length ? '<span class="more">… more</span>' : '') + '</div>';
    }
    return '<div class="so-card">' + bar + '<div class="so-phone"><div class="so-screen"><div class="so-notch"><span>' + esc(now) + '</span><span><i class="fas fa-signal"></i> <i class="fas fa-wifi"></i> <i class="fas fa-battery-full"></i></span></div>' + screen + '</div></div>' +
      '<p class="so-tiny so-muted" style="text-align:center;margin:10px 0 0">How it looks in the feed: Facebook folds long text after about 480 characters, Instagram after 125.</p></div>';
  }
  function loadSlots() {
    var pid = (targetsOf()[0] || {}).pageId || S.page || '';
    api('/insights/heatmap?pageId=' + encodeURIComponent(pid)).then(function (r) { if (!C) return; C.slots = r; if (C.when === 'at' && S.tab === 'compose') renderCompose(); }).catch(function () {});
  }
  ACT.cNew = function () { C = newCompose(); renderCompose(); loadSlots(); };
  ACT.cSel = function (el) { var k = el.getAttribute('data-k'); C.sel[k] = !C.sel[k]; el.setAttribute('aria-pressed', String(!!C.sel[k])); var h = el.closest('.so-card').querySelector('.so-card-head span'); if (h) h.textContent = targetsOf().length + ' selected'; refreshPreview(); check(); };
  ACT.cWhen = function (el) { C.when = el.getAttribute('data-v'); if (C.when === 'at' && !C.at && C.slots && C.slots.slots[0]) C.at = C.slots.slots[0].local; renderCompose(); };
  ACT.cSlot = function (el) { C.at = el.getAttribute('data-v'); renderCompose(); };
  ACT.cPrev = function (el) { C.previewNet = el.getAttribute('data-v'); refreshPreview(); };
  INP.cPrevPage = function (el) { C.previewPage = el.value; refreshPreview(); };
  INP.cCap = function (el) {
    var k = el.getAttribute('data-k'); C[k] = el.value;
    if (C.usePerPage) { C.usePerPage = false; var cb = $('[data-ch=cPerPage]'); if (cb) cb.checked = false; }
    var box = $('[data-counter="' + k + '"]'); if (box) box.innerHTML = counterInner(el.value, k === 'capFb' ? 'fb' : k === 'capIg' ? 'ig' : 'both');
    refreshPreview(); check();
  };
  INP.cTitle = function (el) { C.title = el.value; };
  INP.cLink = function (el) { C.link = el.value.trim(); refreshPreview(); check(); };
  INP.cAt = function (el) { C.at = el.value; refreshPreview(); check(); };
  INP.cBrief = function (el) { C.brief = el.value; };
  INP.cSplit = function (el) { C.split = el.checked; if (C.split) { if (!C.capFb) C.capFb = C.caption; if (!C.capIg) C.capIg = C.caption; } else if (!C.caption) C.caption = C.capFb; C.usePerPage = false; renderCompose(); };
  INP.cPerPage = function (el) { C.usePerPage = el.checked; refreshPreview(); check(); };
  ACT.cTone = function (el) { C.tone = el.getAttribute('data-v'); $$('[data-act=cTone]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === el)); }); };
  ACT.cAi = function () { C.ai = !C.ai; renderCompose(); };
  ACT.cAiGo = function (el) {
    el.disabled = true; el.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Writing…';
    var pid = (targetsOf()[0] || {}).pageId || '';
    api('/ai/caption', { method: 'POST', body: { brief: C.brief || '', tone: C.tone || 'professional', propertyId: C.propertyId, pageId: pid } }).then(function (r) {
      var ig = r.instagram; if (r.hashtags && r.hashtags.length && hashtags(ig) === 0) ig = ig + '\n\n' + r.hashtags.join(' ');
      C.split = true; C.capFb = r.facebook; C.capIg = ig; C.usePerPage = false; C.ai = false;
      toast('Draft written. Read it and edit before you submit.');
      renderCompose();
    }).catch(function (e) { fail(e); el.disabled = false; el.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i>Write'; });
  };
  ACT.cMove = function (el) { var i = +el.getAttribute('data-i'); var m = C.media.splice(i, 1)[0]; C.media.splice(i - 1, 0, m); renderCompose(); };
  ACT.cDrop = function (el) { C.media.splice(+el.getAttribute('data-i'), 1); renderCompose(); };
  INP.cUpload = function (el) {
    var f = el.files && el.files[0]; if (!f) return;
    var fd = new FormData(); fd.append('file', f);
    toast('Uploading ' + f.name + '…');
    api('/media/upload', { method: 'POST', body: fd }).then(function (r) { C.media.push({ url: r.media.url, type: r.media.type, width: r.media.width, height: r.media.height, publicId: r.media.publicId, mediaId: r.media._id }); renderCompose(); toast('Uploaded'); }).catch(fail);
  };
  function measure(url) { return new Promise(function (res) { var i = new Image(); i.onload = function () { res({ width: i.naturalWidth, height: i.naturalHeight }); }; i.onerror = function () { res({ width: 0, height: 0 }); }; i.src = url; setTimeout(function () { res({ width: 0, height: 0 }); }, 8000); }); }
  ACT.cUrl = function () {
    modal('Add a photo or video by link', '<label class="so-field"><span>Public https link</span><input type="url" id="uUrl" placeholder="https://res.cloudinary.com/…"></label><label class="so-check so-small" style="margin-top:10px"><input type="checkbox" id="uVid"> It is a video (MP4)</label><p class="so-tiny so-muted">It is also saved in the media library.</p>',
      '<div class="so-bar"><button class="so-btn" data-act="closeModal">Cancel</button><button class="so-btn pri" data-act="cUrlGo">Add</button></div>');
  };
  ACT.cUrlGo = function () {
    var url = $('#uUrl').value.trim(), vid = $('#uVid').checked;
    (vid ? Promise.resolve({ width: 0, height: 0 }) : measure(url)).then(function (d) {
      return api('/media/url', { method: 'POST', body: { url: url, type: vid ? 'video' : 'image', width: d.width, height: d.height } });
    }).then(function (r) { C.media.push({ url: r.media.url, type: r.media.type, width: r.media.width, height: r.media.height, mediaId: r.media._id }); closeModal(); renderCompose(); }).catch(fail);
  };
  ACT.cLibrary = function () {
    api('/media').then(function (r) {
      if (!r.media.length) return modal('Media library', empty('fa-photo-film', 'Nothing in the library yet. Upload a photo or paste a link first.'));
      modal('Choose from the library', '<div class="so-media">' + r.media.map(function (m) { return '<button class="so-mi" data-act="cPick" data-m="' + esc(JSON.stringify({ url: m.url, type: m.type, width: m.width, height: m.height, mediaId: m._id })) + '" style="border:0;padding:0;cursor:pointer">' + (m.type === 'video' ? '<video src="' + esc(m.url) + '#t=0.5" muted></video>' : '<img src="' + esc(m.url) + '" alt="">') + (m.ig && !m.ig.ok ? '<span class="badge so-pill warn">IG crop</span>' : '') + '</button>'; }).join('') + '</div>', '', true);
    }).catch(fail);
  };
  ACT.cPick = function (el) { if (C.media.length >= S.me.limits.media) return toast('At most 10.', true); C.media.push(JSON.parse(el.getAttribute('data-m'))); el.style.outline = '3px solid var(--lk-accent)'; el.disabled = true; renderComposeKeepModal(); };
  function renderComposeKeepModal() { var s = $('#scrim'); if (s) s.remove(); renderCompose(); if (s) document.body.appendChild(s); }
  ACT.cTemplate = function () {
    loadTemplates().then(function (t) {
      var list = t.filter(function (x) { return x.kind === 'caption'; });
      modal('Caption templates', list.length ? '<div class="so-list">' + list.map(function (x) { return '<div class="so-li"><div style="flex:1;min-width:0"><div class="t">' + esc(x.name) + (x.pageId ? ' <span class="so-pill">' + esc(pageOf(x.pageId).name) + '</span>' : '') + '</div><div class="so-small so-muted" style="white-space:pre-wrap">' + esc(x.text.slice(0, 220)) + '</div></div><button class="so-btn sm" data-act="cUseTpl" data-id="' + x._id + '">Use</button></div>'; }).join('') + '</div>' : empty('fa-file-lines', 'No caption templates yet. Add them in Settings.'));
    }).catch(fail);
  };
  function fillPh(text) {
    var f = C.fill || {}, pg = pageOf((targetsOf()[0] || {}).pageId || S.page || (S.pages[0] || {}).id);
    return String(text).replace(/\{(property|price|area|link|page)\}/g, function (m, k) { return k === 'page' ? pg.name : (f[k] || m); });
  }
  ACT.cUseTpl = function (el) {
    var t = S.templates.filter(function (x) { return x._id === el.getAttribute('data-id'); })[0];
    var txt = fillPh(t.text);
    if (C.split) { C.capFb = (C.capFb ? C.capFb + '\n\n' : '') + txt; C.capIg = (C.capIg ? C.capIg + '\n\n' : '') + txt; } else C.caption = (C.caption ? C.caption + '\n\n' : '') + txt;
    C.usePerPage = false; closeModal(); renderCompose();
  };
  function loadTemplates(force) { if (S.templates && !force) return Promise.resolve(S.templates); return api('/templates').then(function (r) { S.templates = r.templates; return r.templates; }); }
  function fillHashSets() {
    loadTemplates().then(function (t) {
      var s = $('[data-ch=cHashSet]'); if (!s) return;
      s.innerHTML = '<option value="">+ Hashtag set…</option>' + t.filter(function (x) { return x.kind === 'hashtags'; }).map(function (x) { return '<option value="' + x._id + '">' + esc(x.name) + ' (' + hashtags(x.text) + ')' + (x.pageId ? ' · ' + esc(pageOf(x.pageId).name) : '') + '</option>'; }).join('');
    }).catch(function () {});
  }
  INP.cHashSet = function (el) {
    var t = (S.templates || []).filter(function (x) { return x._id === el.value; })[0]; if (!t) return;
    if (C.split) C.capIg = (C.capIg.trim() + '\n\n' + t.text).trim(); else C.caption = (C.caption.trim() + '\n\n' + t.text).trim();
    C.usePerPage = false; renderCompose();
  };
  ACT.cListing = function () {
    modal('Post a listing', '<label class="so-field"><span>Search the live listings</span><input type="search" id="lsQ" data-in="lsSearch" placeholder="Title or area, e.g. Makati"></label><div id="lsList" class="so-list" style="margin-top:10px"><div class="so-spin"></div></div>', '', true);
    searchListings('');
  };
  var searchListings = debounce(function (q) {
    api('/listings?q=' + encodeURIComponent(q)).then(function (r) {
      var b = $('#lsList'); if (!b) return;
      b.innerHTML = r.listings.length ? r.listings.map(function (l) { return '<div class="so-li">' + (l.thumb ? '<img class="so-thumb" src="' + esc(l.thumb) + '" alt="" loading="lazy">' : '<span class="so-thumb"></span>') + '<div style="flex:1;min-width:0"><div class="t">' + esc(l.title) + '</div><div class="so-small so-muted">' + esc([l.location, l.price, l.photos + ' photos'].filter(Boolean).join(' · ')) + '</div></div><button class="so-btn sm pri" data-act="lsPick" data-id="' + l.id + '">Use</button></div>'; }).join('') : empty('fa-building', 'No live listing matches.');
    }).catch(fail);
  }, 300);
  INP.lsSearch = function (el) { searchListings(el.value); };
  ACT.lsPick = function (el) {
    el.disabled = true;
    var ids = uniq(targetsOf().map(function (t) { return t.pageId; }));
    api('/listings/' + el.getAttribute('data-id') + '/studio?pageId=' + encodeURIComponent(ids.join(','))).then(function (s) {
      C.propertyId = s.propertyId; C.title = s.title; C.media = s.media; C.link = s.link; C.split = true; C.capFb = s.captionFb; C.capIg = s.captionIg; C.perPage = s.perPage; C.usePerPage = true; C.origin = 'listing'; C.fill = s.fill;
      if (!targetsOf().length) S.pages.forEach(function (p) { C.sel['fb:' + p.id] = true; });
      targetsOf().forEach(function (t) { var p = pageOf(t.pageId); if (p.igId) C.sel['ig:' + p.id] = true; });
      closeModal(); renderCompose();
      Promise.all(C.media.map(function (m) { return measure(m.url).then(function (d) { m.width = d.width; m.height = d.height; }); })).then(function () { if (S.tab === 'compose') { renderCompose(); } });
      toast('Carousel, captions, hashtags and a tracked link are ready to edit.');
    }).catch(fail);
  };
  ACT.cSave = function (el) {
    var action = el.getAttribute('data-v');
    var body = payload(action === 'save' ? 'save' : action);
    $$('[data-act=cSave]').forEach(function (b) { b.disabled = true; });
    api(C.id ? '/posts/' + C.id : '/posts', { method: C.id ? 'PUT' : 'POST', body: body }).then(function (r) {
      var p = r.post;
      if (action === 'approve') toast(p.status === 'published' ? 'Published' : p.status === 'scheduled' ? 'Approved and scheduled' : 'Approved: ' + (STATUS[p.status] || [p.status])[0]);
      else if (action === 'submit') toast('Sent for approval');
      else { toast('Draft saved'); C.id = p._id; C.status = p.status; }
      if (action !== 'save') { C = null; refreshBadge(); go(action === 'approve' ? 'calendar' : 'approvals'); return; }
      renderCompose();
    }).catch(function (e) { fail(e); $$('[data-act=cSave]').forEach(function (b) { b.disabled = false; }); if (e.data && e.data.post) { C.id = e.data.post._id; C.status = e.data.post.status; } });
  };
  function editPost(p) {
    var sel = {}; p.targets.forEach(function (t) { sel[t.network + ':' + t.pageId] = true; });
    var igT = p.targets.filter(function (t) { return t.network === 'ig' && t.caption; })[0];
    C = newCompose();
    Object.assign(C, { id: p._id, status: p.status, title: p.title, caption: p.caption, capFb: p.caption, capIg: igT ? igT.caption : p.caption, split: !!igT, link: p.link, media: p.media, sel: sel,
      when: p.scheduledAt ? 'at' : 'now', at: p.scheduledAt ? manilaLocal(new Date(p.scheduledAt)) : '', propertyId: p.propertyId, origin: p.origin });
    closeModal(); go('compose');
  }

  // ══ POST DETAIL (calendar, approvals) ═════════════════════════
  ACT.openPost = function (el) { openPost(el.getAttribute('data-id')); };
  function openPost(id) {
    api('/posts/' + id).then(function (r) {
      var p = r.post, a = can('approve');
      var body = '<div class="so-row" style="margin-bottom:12px">' + statusPill(p.status) + (p.scheduledAt ? '<span class="so-small so-muted"><i class="far fa-clock"></i> ' + esc(fmt(p.scheduledAt)) + '</span>' : '') + (p.origin && p.origin !== 'compose' ? pill(p.origin.replace('_', ' ')) : '') + (p.leads.total ? pill(p.leads.total + ' lead' + (p.leads.total > 1 ? 's' : ''), 'hot', 'fas fa-bullseye') : '') + '</div>' +
        (p.reviewNote && p.status === 'changes' ? '<div class="so-banner warn"><i class="fas fa-reply"></i><div><b>Sent back:</b> ' + esc(p.reviewNote) + '</div></div>' : '') +
        (p.media.length ? '<div class="so-media" style="margin-bottom:12px">' + p.media.map(function (m) { return '<div class="so-mi">' + (m.type === 'video' ? '<video src="' + esc(m.url) + '#t=0.5" controls muted></video>' : '<img src="' + esc(m.url) + '" alt="">') + '</div>'; }).join('') + '</div>' : '') +
        '<div class="so-well so-small" style="white-space:pre-wrap;max-height:220px;overflow:auto">' + esc(p.caption || '(no text)') + '</div>' + (p.link ? '<p class="so-small"><i class="fas fa-link"></i> ' + esc(p.link) + '</p>' : '') +
        '<h3 style="margin:16px 0 8px">Where</h3><div class="so-tablewrap"><table class="so-table cards"><thead><tr><th>Page</th><th>Network</th><th>Status</th><th>Result</th></tr></thead><tbody>' + p.targets.map(function (t) {
          return '<tr><td data-l="Page">' + esc(t.pageName) + '</td><td data-l="Network">' + netIcon(t.network) + '</td><td data-l="Status">' + statusPill(t.status) + '</td><td data-l="Result" class="full">' +
            (t.permalink ? '<a href="' + esc(t.permalink) + '" target="_blank" rel="noopener">Open post <i class="fas fa-arrow-up-right-from-square"></i></a>' : '') + (t.metaId ? ' <span class="so-tiny so-muted">id ' + esc(t.metaId) + '</span>' : '') +
            (t.error ? '<div style="color:var(--lk-bad)" class="so-small">' + esc(t.error) + (t.unknown ? ' <b>(may have reached Meta: check the Page before retrying)</b>' : '') + '</div>' : '') +
            (a && t.status === 'published' && t.network === 'fb' ? ' <button class="so-btn xs bad" data-act="pDelRemote" data-id="' + p._id + '" data-t="' + t._id + '"><i class="fas fa-trash"></i>Delete from Facebook</button>' : '') +
            (p.leads.byPage && p.leads.byPage[t.pageId] ? ' <span class="so-pill hot">' + p.leads.byPage[t.pageId] + ' lead(s)</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (r.check && r.check.errors.length && ['draft', 'pending', 'changes'].indexOf(p.status) >= 0 ? '<div class="so-issues" style="margin-top:12px">' + r.check.errors.map(function (e) { return '<div class="e"><i class="fas fa-circle-xmark"></i>' + esc(e) + '</div>'; }).join('') + '</div>' : '') +
        '<h3 style="margin:16px 0 8px">History</h3><div class="so-small so-col" style="gap:4px">' + p.history.slice().reverse().map(function (h) { return '<div><span class="so-muted">' + esc(fmt(h.at)) + '</span> · ' + esc(h.by) + ': ' + esc(h.action) + (h.note ? ' (' + esc(h.note) + ')' : '') + '</div>'; }).join('') +
        '<div><span class="so-muted">Made by</span> ' + esc((p.createdBy || {}).name || '') + ((p.createdBy || {}).via === 'review_key' ? ' ' + pill('review key', 'info') : '') + (p.approvedBy && p.approvedBy.name ? ' · <span class="so-muted">approved by</span> ' + esc(p.approvedBy.name) + (p.approvedBy.via === 'email_link' ? ' (email link)' : '') : '') + '</div></div>';
      var btns = [];
      if (['draft', 'changes', 'pending'].indexOf(p.status) >= 0 && can('draft')) btns.push('<button class="so-btn" data-act="pEdit" data-id="' + p._id + '"><i class="fas fa-pen"></i>Edit</button>');
      if (can('draft')) btns.push('<button class="so-btn" data-act="pDup" data-id="' + p._id + '"><i class="far fa-copy"></i>Duplicate</button>');
      if (['draft', 'changes'].indexOf(p.status) >= 0 && can('draft')) btns.push('<button class="so-btn pri" data-act="pSubmit" data-id="' + p._id + '"><i class="fas fa-paper-plane"></i>Submit</button>');
      if (p.targets.some(function (t) { return t.status === 'failed'; }) && can('draft')) btns.push('<button class="so-btn" data-act="pRetry" data-id="' + p._id + '"><i class="fas fa-rotate-right"></i>Retry (needs approval)</button>');
      if (a && p.status === 'pending') { btns.push('<button class="so-btn bad" data-act="pReject" data-id="' + p._id + '"><i class="fas fa-reply"></i>Send back</button>'); btns.push('<button class="so-btn pri" data-act="pApprove" data-id="' + p._id + '" data-rev="' + esc(p.rev || '') + '"><i class="fas fa-circle-check"></i>Approve</button>'); }
      if (a && p.targets.some(function (t) { return t.status === 'scheduled' || t.status === 'waiting'; })) btns.push('<button class="so-btn bad" data-act="pCancel" data-id="' + p._id + '"><i class="fas fa-ban"></i>Cancel</button>');
      if (['draft', 'changes', 'pending', 'failed', 'cancelled'].indexOf(p.status) >= 0 && can('draft') && !p.targets.some(function (t) { return t.metaId && t.status !== 'cancelled'; })) btns.push('<button class="so-btn bad" data-act="pDiscard" data-id="' + p._id + '"><i class="far fa-trash-can"></i>Discard</button>');
      modal(p.title || 'Post', body, btns.length ? '<div class="so-bar">' + btns.join('') + '</div>' : '', true);
      S.lastPost = p;
    }).catch(fail);
  }
  function after(msg, el) { return function () { toast(msg); closeModal(); refreshBadge(); route(true); }; }
  ACT.pEdit = function () { editPost(S.lastPost); };
  ACT.pDup = function (el) { api('/posts/' + el.getAttribute('data-id') + '/duplicate', { method: 'POST' }).then(function (r) { editPost(r.post); toast('Copied into the composer'); }).catch(fail); };
  ACT.pSubmit = function (el) { api('/posts/' + el.getAttribute('data-id') + '/submit', { method: 'POST' }).then(after('Sent for approval')).catch(fail); };
  ACT.pRetry = function (el) { api('/posts/' + el.getAttribute('data-id') + '/retry', { method: 'POST' }).then(function (r) { if (r.warning) toast(r.warning, true); after('Back in Approvals')(); }).catch(fail); };
  // rev = the version on screen: if the post was edited since, the server refuses
  // and the view reloads so the approver reads the new words first.
  ACT.pApprove = function (el) { el.disabled = true; api('/posts/' + el.getAttribute('data-id') + '/approve', { method: 'POST', body: { rev: el.getAttribute('data-rev') || '' } }).then(function (r) { (r.warnings || []).forEach(function (w) { toast(w); }); after(r.post.status === 'published' ? 'Published' : r.post.status === 'scheduled' ? 'Approved and scheduled' : r.post.status === 'failed' ? 'Approved, but Meta refused it: see the post' : 'Approved')(); }).catch(function (e) { fail(e); if (e && e.data && e.data.changed) { route(true); return; } el.disabled = false; }); };
  ACT.pReject = function (el) {
    var id = el.getAttribute('data-id');
    modal('Send back with a note', '<label class="so-field"><span>What should change?</span><textarea id="rjNote" rows="4" placeholder="e.g. Use the photo of the living room first; price is 12.5M now"></textarea></label>', '<div class="so-bar"><button class="so-btn" data-act="closeModal">Cancel</button><button class="so-btn pri" data-act="pRejectGo" data-id="' + id + '">Send back</button></div>');
  };
  ACT.pRejectGo = function (el) { api('/posts/' + el.getAttribute('data-id') + '/reject', { method: 'POST', body: { note: $('#rjNote').value } }).then(after('Sent back to the author')).catch(fail); };
  ACT.pCancel = function (el) { if (!confirm('Cancel this post? A Facebook scheduled post is removed from Facebook\'s schedule.')) return; api('/posts/' + el.getAttribute('data-id') + '/cancel', { method: 'POST' }).then(after('Cancelled')).catch(fail); };
  ACT.pDiscard = function (el) { if (!confirm('Discard this post? It was never published, so nothing changes on the Pages.')) return; api('/posts/' + el.getAttribute('data-id'), { method: 'DELETE' }).then(after('Discarded')).catch(fail); };
  ACT.pDelRemote = function (el) { if (!confirm('Delete this post from Facebook? This cannot be undone.')) return; api('/posts/' + el.getAttribute('data-id') + '/delete-remote', { method: 'POST', body: { targetId: el.getAttribute('data-t') } }).then(after('Deleted from Facebook')).catch(fail); };

  // ══ CALENDAR ══════════════════════════════════════════════════
  VIEWS.calendar = function () {
    var phone = window.innerWidth < 760;
    var cur = CAL.cursor, y = Number(dayKey(cur).slice(0, 4)), m = Number(dayKey(cur).slice(5, 7));
    var from, to, title;
    if (CAL.view === 'week') {
      var wd = new Date(dayKey(cur) + 'T12:00:00Z').getUTCDay();
      from = addDays(dayKey(cur), -wd); to = addDays(from, 6);
      title = 'Week of ' + new Date(from + 'T12:00:00Z').toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    } else {
      var first = y + '-' + String(m).padStart(2, '0') + '-01';
      var fwd = new Date(first + 'T12:00:00Z').getUTCDay();
      from = addDays(first, -fwd); to = addDays(from, 41);
      title = new Date(first + 'T12:00:00Z').toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    var html = head('Calendar', 'Scheduled, published and failed posts, coloured by Page. Click one for its result and links.',
      '<div class="so-seg" role="group" aria-label="View"><button data-act="calView" data-v="month" aria-pressed="' + (CAL.view === 'month') + '">Month</button><button data-act="calView" data-v="week" aria-pressed="' + (CAL.view === 'week') + '">Week</button></div>' +
      '<button class="so-iconbtn" data-act="calMove" data-v="-1" aria-label="Earlier"><i class="fas fa-chevron-left"></i></button><button class="so-iconbtn" data-act="calMove" data-v="0">Today</button><button class="so-iconbtn" data-act="calMove" data-v="1" aria-label="Later"><i class="fas fa-chevron-right"></i></button>');
    html += '<div class="so-between" style="margin:0 0 10px"><h2 style="margin:0;font-size:17px">' + esc(title) + '</h2><div class="so-legend">' + S.pages.map(function (p) { return '<span class="so-pill"><span class="so-dot" style="background:' + esc(p.color) + '"></span>' + esc(p.name) + '</span>'; }).join('') + '</div></div>';
    html += '<div id="calBody"><div class="so-spin"></div></div>';
    html += '<div class="so-grid so-g2" style="margin-top:16px"><div class="so-card" id="recBox"><div class="so-spin"></div></div><div class="so-card" id="bulkBox">' + bulkHtml() + '</div></div>';
    setView(html);
    api('/calendar?from=' + from + 'T00:00&to=' + to + 'T23:59&pageId=' + encodeURIComponent(S.page)).then(function (r) {
      var byDay = {};
      r.items.forEach(function (it) { var k = dayKey(it.when); (byDay[k] = byDay[k] || []).push(it); });
      Object.keys(byDay).forEach(function (k) { byDay[k].sort(function (a, b) { return new Date(a.when) - new Date(b.when); }); });
      var ev = function (it) {
        var c = pageOf(it.pages[0]).color, icon = it.status === 'published' ? 'fa-check' : it.status === 'failed' || it.status === 'partial' ? 'fa-xmark' : it.status === 'pending' ? 'fa-hourglass-half' : it.status === 'draft' || it.status === 'changes' ? 'fa-pen' : 'fa-clock';
        return '<button class="so-ev ' + (it.status === 'failed' || it.status === 'partial' ? 'failed ' : '') + (it.kind === 'external' ? 'external' : '') + '" style="--c:' + esc(c) + '" ' + (it.kind === 'external' ? 'data-act="extOpen" data-link="' + esc(it.link || '') + '"' : 'data-act="openPost" data-id="' + it.id + '"') + ' title="' + esc((STATUS[it.status] || [it.status])[0] + ': ' + it.title) + '"><i class="fas ' + icon + '"></i><span class="tm">' + esc(timeOnly(it.when)) + '</span><span>' + esc(it.title) + '</span></button>';
      };
      var body;
      if (phone) {
        var keys = Object.keys(byDay).filter(function (k) { return k >= from && k <= to; }).sort();
        body = '<div class="so-card so-agenda">' + (keys.length ? keys.map(function (k) { return '<div class="day">' + esc(new Date(k + 'T12:00:00Z').toLocaleDateString('en-PH', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })) + (k === todayKey() ? ' · today' : '') + '</div><div class="so-col" style="gap:6px">' + byDay[k].map(ev).join('') + '</div>'; }).join('') : empty('fa-calendar', 'Nothing in this ' + CAL.view + '.')) + '</div>';
      } else {
        var cells = '', days = CAL.view === 'week' ? 7 : 42;
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (d) { cells += '<div class="dh">' + d + '</div>'; });
        for (var i = 0; i < days; i++) {
          var k = addDays(from, i), out = CAL.view === 'month' && Number(k.slice(5, 7)) !== m, list = byDay[k] || [];
          var max = CAL.view === 'week' ? 60 : 4;
          cells += '<div class="dc' + (out ? ' out' : '') + (k === todayKey() ? ' today' : '') + '"><span class="dn">' + Number(k.slice(8)) + '</span>' + list.slice(0, max).map(ev).join('') + (list.length > max ? '<button class="so-chip" style="padding:2px 8px;font-size:11px" data-act="calDay" data-d="' + k + '">+' + (list.length - max) + ' more</button>' : '') + '</div>';
        }
        body = '<div class="so-cal' + (CAL.view === 'week' ? ' week' : '') + '">' + cells + '</div>';
      }
      $('#calBody').innerHTML = body;
    }).catch(fail);
    loadRecurring();
  };
  ACT.calDay = function (el) { CAL.view = 'week'; CAL.cursor = new Date(el.getAttribute('data-d') + 'T04:00:00Z'); VIEWS.calendar(); };
  ACT.calView = function (el) { CAL.view = el.getAttribute('data-v'); VIEWS.calendar(); };
  ACT.calMove = function (el) {
    var v = +el.getAttribute('data-v');
    if (!v) CAL.cursor = new Date();
    else if (CAL.view === 'week') CAL.cursor = new Date(CAL.cursor.getTime() + v * 7 * 864e5);
    else { var k = dayKey(CAL.cursor), y = +k.slice(0, 4), mo = +k.slice(5, 7) - 1 + v; CAL.cursor = new Date(Date.UTC(y + Math.floor(mo / 12), ((mo % 12) + 12) % 12, 15, 4)); }
    VIEWS.calendar();
  };
  ACT.extOpen = function (el) { var l = el.getAttribute('data-link'); if (l) window.open(l, '_blank', 'noopener'); else toast('Published outside GLRA Social'); };

  // recurring
  var WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function loadRecurring() {
    api('/recurring').then(function (r) {
      var b = $('#recBox'); if (!b) return;
      S.rules = r.rules;
      b.innerHTML = '<div class="so-card-head"><h2><i class="fas fa-repeat"></i>Recurring posts</h2>' + (can('draft') ? '<button class="so-btn sm" data-act="recNew"><i class="fas fa-plus"></i>New</button>' : '') + '</div>' +
        '<p class="so-small so-muted" style="margin:-4px 0 10px">Each one makes a post a couple of days ahead that waits for approval like any other.</p>' +
        (r.rules.length ? '<div class="so-list">' + r.rules.map(function (x) {
          return '<div class="so-li"><span class="so-avatar sm" style="background:' + (x.mode === 'listing' ? 'var(--lk-accent)' : 'rgb(var(--lk-tint) / .2)') + ';color:var(--lk-on-accent)"><i class="fas ' + (x.mode === 'listing' ? 'fa-building' : 'fa-repeat') + '"></i></span><div style="flex:1;min-width:0"><div class="t">' + esc(x.name) + '</div><div class="so-small so-muted">Every ' + WD[x.weekday] + ' ' + esc(x.time) + ' · ' + uniq(x.targets.map(function (t) { return pageOf(t.pageId).name; })).map(esc).join(', ') + '</div><div class="so-small">' + (x.active ? 'Next: ' + esc(fmt(x.next)) : pill('Paused')) + '</div></div>' +
            (can('draft') ? '<div class="so-btns"><button class="so-btn xs" data-act="recRun" data-id="' + x._id + '" title="Make the next one now">Run now</button><button class="so-btn xs" data-act="recEdit" data-id="' + x._id + '" aria-label="Edit"><i class="fas fa-pen"></i></button></div>' : '') + '</div>';
        }).join('') + '</div>' : empty('fa-repeat', 'No recurring posts. "Listing of the week" picks a different live listing each week.'));
    }).catch(fail);
  }
  function recForm(x) {
    x = x || { name: 'Listing of the week', mode: 'listing', weekday: 3, time: '19:00', leadDays: 2, caption: '', targets: S.pages.map(function (p) { return { network: 'fb', pageId: p.id }; }), active: true };
    var sel = {}; x.targets.forEach(function (t) { sel[t.network + ':' + t.pageId] = true; });
    S.recSel = sel; S.recEdit = x._id || null;
    modal(x._id ? 'Edit recurring post' : 'New recurring post', '<div class="so-col">' +
      '<label class="so-field"><span>Name</span><input type="text" id="rName" value="' + esc(x.name) + '"></label>' +
      '<div class="so-seg" role="group" aria-label="Kind"><button data-act="rMode" data-v="listing" aria-pressed="' + (x.mode === 'listing') + '">Listing of the week</button><button data-act="rMode" data-v="text" aria-pressed="' + (x.mode !== 'listing') + '">Same text each time</button></div>' +
      '<div class="so-grid so-g2"><label class="so-field"><span>Every</span><select id="rWd">' + WD.map(function (d, i) { return '<option value="' + i + '"' + (i === x.weekday ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></label><label class="so-field"><span>At (Manila)</span><input type="time" id="rTime" value="' + esc(x.time) + '"></label></div>' +
      '<div><div class="so-label" style="margin-bottom:6px">Post to</div><div class="so-targets">' + S.pages.map(function (p) { return '<div class="so-target"><span class="n">' + esc(p.name) + '</span><button class="so-chip" data-act="rSel" data-k="fb:' + p.id + '" aria-pressed="' + !!sel['fb:' + p.id] + '"><i class="fab fa-facebook"></i>Facebook</button><button class="so-chip" data-act="rSel" data-k="ig:' + p.id + '" aria-pressed="' + !!sel['ig:' + p.id] + '"' + (p.igId ? '' : ' disabled') + '><i class="fab fa-instagram"></i>Instagram</button></div>'; }).join('') + '</div></div>' +
      '<label class="so-field"><span id="rCapL">' + (x.mode === 'listing' ? 'Caption template (optional: blank uses the listing\'s own caption; {property} {price} {area} {link})' : 'Caption') + '</span><textarea id="rCap" rows="5">' + esc(x.caption) + '</textarea></label>' +
      '<label class="so-field"><span>Make the draft this many days before</span><input type="number" id="rLead" min="1" max="6" value="' + (x.leadDays || 2) + '"></label>' +
      '<label class="so-check"><input type="checkbox" id="rActive"' + (x.active !== false ? ' checked' : '') + '> Active</label></div>',
      '<div class="so-bar">' + (x._id ? '<button class="so-btn bad" data-act="recDel" data-id="' + x._id + '">Delete</button>' : '') + '<button class="so-btn" data-act="closeModal">Cancel</button><button class="so-btn pri" data-act="recSave">Save</button></div>');
    S.recMode = x.mode === 'listing' ? 'listing' : 'text';
  }
  ACT.recNew = function () { recForm(null); };
  ACT.recEdit = function (el) { recForm(S.rules.filter(function (r) { return r._id === el.getAttribute('data-id'); })[0]); };
  ACT.rMode = function (el) { S.recMode = el.getAttribute('data-v'); $$('[data-act=rMode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === el)); }); $('#rCapL').textContent = S.recMode === 'listing' ? 'Caption template (optional: blank uses the listing\'s own caption; {property} {price} {area} {link})' : 'Caption'; };
  ACT.rSel = function (el) { var k = el.getAttribute('data-k'); S.recSel[k] = !S.recSel[k]; el.setAttribute('aria-pressed', String(!!S.recSel[k])); };
  ACT.recSave = function () {
    var body = { name: $('#rName').value, mode: S.recMode, weekday: +$('#rWd').value, time: $('#rTime').value, caption: $('#rCap').value, leadDays: +$('#rLead').value, active: $('#rActive').checked,
      targets: Object.keys(S.recSel).filter(function (k) { return S.recSel[k]; }).map(function (k) { return { network: k.split(':')[0], pageId: k.split(':')[1] }; }) };
    api(S.recEdit ? '/recurring/' + S.recEdit : '/recurring', { method: S.recEdit ? 'PUT' : 'POST', body: body }).then(function () { closeModal(); toast('Saved'); loadRecurring(); }).catch(fail);
  };
  ACT.recDel = function (el) { if (!confirm('Delete this recurring post? Posts it already made stay.')) return; api('/recurring/' + el.getAttribute('data-id'), { method: 'DELETE' }).then(function () { closeModal(); loadRecurring(); }).catch(fail); };
  ACT.recRun = function (el) { el.disabled = true; api('/recurring/' + el.getAttribute('data-id') + '/run', { method: 'POST' }).then(function () { toast('Made the next post: it waits in Approvals'); refreshBadge(); VIEWS.calendar(); }).catch(function (e) { fail(e); el.disabled = false; }); };

  // bulk CSV
  var SAMPLE = 'date,time,pages,networks,caption,media,link\n' + addDays(todayKey(), 3) + ',19:00,all,fb;ig,"Open house this Saturday! Message us to reserve a slot.",https://res.cloudinary.com/demo/image/upload/sample.jpg,\n' + addDays(todayKey(), 5) + ',12:00,GLRA Realty,fb,"Pag-IBIG tip: the loan cap is now 10M. Ask us how it changes your budget.",,https://glrarealty.com/pagibig-loanable.html\n';
  function bulkHtml() {
    return '<div class="so-card-head"><h2><i class="fas fa-file-csv"></i>Bulk schedule from a CSV</h2><button class="so-btn sm" data-act="bulkSample"><i class="fas fa-download"></i>Sample</button></div>' +
      '<p class="so-small so-muted" style="margin:-4px 0 10px">Columns: date, time, pages (names, ids or "all"), networks (fb;ig), caption, media (links separated by ;), link. Up to 200 rows. Every row waits for approval; approve the whole batch with one click.</p>' +
      (can('draft') ? '<label class="so-field"><span class="so-sr">CSV</span><textarea id="bulkCsv" rows="5" placeholder="Paste the CSV here, or choose a file"></textarea></label><div class="so-bar" style="margin-top:10px"><label class="so-btn"><i class="fas fa-folder-open"></i>Choose file<input type="file" accept=".csv,text/csv" class="so-sr" data-ch="bulkFile"></label><button class="so-btn pri" data-act="bulkPreview">Check rows</button></div><div id="bulkOut"></div>' : '');
  }
  ACT.bulkSample = function () { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([SAMPLE], { type: 'text/csv' })); a.download = 'glra-social-bulk-sample.csv'; a.click(); };
  INP.bulkFile = function (el) { var f = el.files[0]; if (!f) return; f.text().then(function (t) { $('#bulkCsv').value = t; ACT.bulkPreview(); }); };
  ACT.bulkPreview = function () {
    api('/bulk', { method: 'POST', body: { csv: $('#bulkCsv').value } }).then(function (r) {
      var bad = r.preview.filter(function (p) { return p.problems.length; }).length;
      $('#bulkOut').innerHTML = '<div class="so-tablewrap" style="margin-top:12px"><table class="so-table cards"><thead><tr><th>Row</th><th>When</th><th>Where</th><th>Text</th><th>Check</th></tr></thead><tbody>' + r.preview.map(function (p) {
        return '<tr><td data-l="Row">' + p.row + '</td><td data-l="When">' + esc(fmt(p.when)) + '</td><td data-l="Where">' + p.targets.map(function (t) { return netIcon(t.network) + ' ' + esc(pageOf(t.pageId).name); }).join('<br>') + '</td><td data-l="Text" class="full">' + esc(p.caption.slice(0, 90)) + '</td><td data-l="Check">' + (p.problems.length ? '<span style="color:var(--lk-bad)">' + esc(p.problems.join('; ')) + '</span>' : pill('OK', 'ok')) + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="so-bar" style="margin-top:10px"><button class="so-btn pri full" data-act="bulkGo"' + (bad ? ' disabled' : '') + '>' + (bad ? 'Fix ' + bad + ' row(s) first' : 'Create ' + r.preview.length + ' posts for approval') + '</button></div>';
    }).catch(fail);
  };
  ACT.bulkGo = function (el) { el.disabled = true; api('/bulk', { method: 'POST', body: { csv: $('#bulkCsv').value, commit: true } }).then(function (r) { toast(r.created + ' posts wait for approval'); refreshBadge(); go('approvals'); }).catch(function (e) { fail(e); el.disabled = false; }); };

  // ══ APPROVALS ═════════════════════════════════════════════════
  VIEWS.approvals = function () {
    loading();
    Promise.all([api('/approvals'), api('/posts?status=changes&limit=30')]).then(function (r) {
      var A = r[0], back = r[1].posts, a = can('approve');
      // The versions shown here: a batch approval sends them back, so a post
      // edited after this list loaded is refused rather than approved unseen.
      S.approvalRevs = {}; (A.posts || []).forEach(function (p) { S.approvalRevs[p._id] = p.rev || ''; });
      var html = head('Approvals', a ? 'Nothing goes out until you approve it. Approving publishes now or at the scheduled time.' : 'These wait for an approver. You can still edit your own.',
        a && A.batches.length ? A.batches.map(function (b) { return '<button class="so-btn pri" data-act="batchGo" data-id="' + esc(b.id) + '"><i class="fas fa-check-double"></i>Approve all ' + b.n + ' (' + (b.id.indexOf('csv') === 0 ? 'CSV' : 'recurring') + ')</button>'; }).join('') : '');
      html += '<div class="so-grid so-g2"><div class="so-col"><div class="so-card"><div class="so-card-head"><h2><i class="fas fa-newspaper"></i>Posts</h2>' + pill(A.posts.length + ' waiting', A.posts.length ? 'warn' : '') + '</div>' +
        (A.posts.length ? '<div class="so-list">' + A.posts.map(function (p) {
          return '<div class="so-li">' + (p.media[0] ? mediaThumb(p.media[0], 'lg') : '<span class="so-thumb lg" style="display:flex;align-items:center;justify-content:center"><i class="fas fa-align-left so-muted"></i></span>') + '<div style="flex:1;min-width:0"><div class="t">' + esc(p.title || p.caption || '(no text)') + '</div>' +
            '<div class="so-small so-muted" style="margin:3px 0">' + uniq(p.targets.map(function (t) { return t.network; })).map(netIcon).join(' ') + ' ' + uniq(p.targets.map(function (t) { return t.pageName; })).map(esc).join(', ') + '</div>' +
            '<div class="so-small">' + (p.scheduledAt ? '<i class="far fa-clock"></i> ' + esc(fmt(p.scheduledAt)) : 'Publishes when approved') + ' · by ' + esc((p.createdBy || {}).name || '') + ((p.createdBy || {}).via === 'review_key' ? ' ' + pill('Claude', 'info') : '') + '</div>' +
            (p.check && p.check.errors.length ? '<div class="so-small" style="color:var(--lk-bad);margin-top:4px"><i class="fas fa-circle-xmark"></i> ' + esc(p.check.errors[0]) + '</div>' : '') +
            '<div class="so-btns" style="margin-top:8px"><button class="so-btn xs" data-act="openPost" data-id="' + p._id + '">Open</button>' + (a ? '<button class="so-btn xs bad" data-act="pReject" data-id="' + p._id + '">Send back</button><button class="so-btn xs pri" data-act="pApprove" data-id="' + p._id + '" data-rev="' + esc(p.rev || '') + '"' + (p.check && p.check.errors.length ? ' disabled title="Fix the problem first"' : '') + '>Approve</button>' : '') + '</div></div></div>';
        }).join('') + '</div>' : empty('fa-circle-check', 'No posts waiting.')) + '</div>' +
        (back.length ? '<div class="so-card"><h2><i class="fas fa-reply"></i>Sent back for changes</h2><div class="so-list">' + back.map(postRow).join('') + '</div></div>' : '') + '</div>';
      html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-comments"></i>Replies and moderation</h2>' + pill(A.actions.length + ' waiting', A.actions.length ? 'warn' : '') + '</div>' +
        (A.actions.length ? '<div class="so-list">' + A.actions.map(function (x) {
          var k = KIND[x.thread.kind] || ['', 'fas fa-comment'];
          return '<div class="so-li"><span class="so-net ' + (k[2] || 'fb') + '"><i class="' + k[1] + '"></i></span><div style="flex:1;min-width:0"><div class="t">' + esc(x.kind === 'reply' ? 'Reply to ' + (x.thread.name || 'someone') : x.kind[0].toUpperCase() + x.kind.slice(1) + ' a comment by ' + (x.item ? x.item.fromName : '')) + '</div>' +
            (x.item ? '<div class="so-small so-muted">"' + esc((x.item.text || '').slice(0, 140)) + '"</div>' : '') + (x.text ? '<div class="so-well so-small" style="margin-top:6px;white-space:pre-wrap">' + esc(x.text) + '</div>' : '') +
            '<div class="so-small so-muted" style="margin-top:4px">' + esc(pageOf(x.pageId).name) + ' · by ' + esc(x.createdBy.name) + (x.createdBy.via === 'review_key' ? ' ' + pill('Claude', 'info') : '') + (x.thread.window && !x.thread.window.open ? ' · <span style="color:var(--lk-bad)">24-hour window closed</span>' : '') + '</div>' +
            (a ? '<div class="so-btns" style="margin-top:8px"><button class="so-btn xs bad" data-act="aReject" data-id="' + x._id + '">Don\'t send</button><button class="so-btn xs pri" data-act="aApprove" data-id="' + x._id + '"' + (x.thread.window && !x.thread.window.open ? ' disabled' : '') + '>' + (x.kind === 'reply' ? 'Approve &amp; send' : 'Approve') + '</button></div>' : '') + '</div></div>';
        }).join('') + '</div>' : empty('fa-comments', 'No replies or moderation waiting.')) + '</div></div>';
      setView(html);
    }).catch(fail);
  };
  ACT.batchGo = function (el) { if (!confirm('Approve every post in this batch? Each is checked and published or scheduled.')) return; el.disabled = true; api('/posts/approve-batch', { method: 'POST', body: { batchId: el.getAttribute('data-id'), revs: S.approvalRevs || {} } }).then(function (r) { var ok = r.results.filter(function (x) { return x.ok; }).length; toast('Approved ' + ok + ' of ' + r.results.length + (ok < r.results.length ? ': open the rest to see why' : '')); refreshBadge(); VIEWS.approvals(); }).catch(fail); };
  ACT.aApprove = function (el) { el.disabled = true; api('/actions/' + el.getAttribute('data-id') + '/approve', { method: 'POST' }).then(function () { toast('Done'); refreshBadge(); route(true); }).catch(function (e) { fail(e); route(true); }); };
  ACT.aReject = function (el) { api('/actions/' + el.getAttribute('data-id') + '/reject', { method: 'POST', body: {} }).then(function () { toast('Not sent'); refreshBadge(); route(true); }).catch(fail); };

  // ══ INBOX ═════════════════════════════════════════════════════
  VIEWS.inbox = function () {
    var html = head('Inbox', 'Facebook and Instagram comments and messages for ' + (S.page ? esc(pageOf(S.page).name) : 'all Pages') + '. Replies, hiding and deleting go through approval.',
      can('approve') ? '<button class="so-btn" data-act="ibSync"><i class="fas fa-rotate"></i>Check now</button>' : '');
    html += '<div id="ibSum" class="so-grid so-pages" style="margin-bottom:14px"></div>';
    html += '<div class="so-card" style="padding:12px;margin-bottom:14px"><div class="so-row so-filters">' +
      '<div class="so-seg" role="group" aria-label="Status">' + [['open', 'Open'], ['unanswered', 'Waiting reply'], ['done', 'Done'], ['all', 'All']].map(function (s) { return '<button data-act="ibStatus" data-v="' + s[0] + '" aria-pressed="' + (IB.status === s[0]) + '">' + s[1] + '</button>'; }).join('') + '</div>' +
      '<select data-ch="ibKind" aria-label="Kind" style="max-width:200px"><option value="">Everything</option>' + Object.keys(KIND).map(function (k) { return '<option value="' + k + '"' + (IB.kind === k ? ' selected' : '') + '>' + KIND[k][0] + 's</option>'; }).join('') + '</select>' +
      '<select data-ch="ibTag" aria-label="Tag" style="max-width:170px"><option value="">Any tag</option>' + S.me.tags.map(function (t) { return '<option value="' + t + '"' + (IB.tag === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>' +
      '<label class="so-check so-small"><input type="checkbox" data-ch="ibMine"' + (IB.mine ? ' checked' : '') + '> Assigned to me</label></div></div>';
    html += '<div class="so-inbox' + (IB.key ? ' open' : '') + '" id="ibWrap"><div class="so-card so-threads" id="ibList"><div class="so-spin"></div></div><div class="so-card so-thread" id="ibThread">' + empty('fa-comments', 'Choose a conversation.') + '</div></div>';
    setView(html);
    api('/inbox/summary').then(function (r) {
      var b = $('#ibSum'); if (!b) return;
      b.innerHTML = r.pages.filter(function (p) { return !S.page || p.pageId === S.page; }).map(function (p) {
        return '<div class="so-kpi"><div class="l"><span class="so-dot" style="background:' + esc(p.color) + '"></span> ' + esc(p.name) + '</div><div class="v">' + p.waiting + ' <span class="so-small so-muted" style="font-weight:600">waiting</span></div><div class="d so-small">' +
          (p.unanswered ? '<span class="down">' + p.unanswered + ' over ' + r.unansweredHours + ' h</span>' : '<span class="up">none overdue</span>') + (p.oldestMin != null ? ' · oldest ' + ago(p.oldestMin) : '') + (p.speed.medianMin != null ? ' · median reply ' + ago(p.speed.medianMin) : '') + '</div></div>';
      }).join('');
    }).catch(function () {});
    loadThreads();
  };
  function loadThreads() {
    var q = '?status=' + IB.status + '&pageId=' + encodeURIComponent(S.page) + '&kind=' + IB.kind + '&tag=' + IB.tag + (IB.mine ? '&assigned=me' : '');
    api('/inbox' + q).then(function (r) {
      IB.threads = r.threads; IB.hours = r.unansweredHours;
      var b = $('#ibList'); if (!b) return;
      b.innerHTML = r.threads.length ? r.threads.map(function (t) {
        var k = KIND[t.kind] || ['', 'fas fa-comment', 'fb'];
        var sla = t.waiting ? '<span class="so-sla ' + (t.unanswered ? 'bad' : t.ageMin > 60 ? 'warn' : 'ok') + '">' + ago(t.ageMin) + '</span>' : '';
        var tags = uniq((t.tags || []).concat(t.autoTags || [])).slice(0, 3);
        return '<button class="so-th" data-act="ibOpen" data-k="' + esc(t.key) + '" aria-current="' + (t.key === IB.key) + '"><span class="so-net ' + k[2] + '"><i class="' + k[1] + '"></i></span><span class="bd"><span class="nm"><span>' + esc(t.name || 'Someone') + '</span>' + (t.sentiment === 'negative' ? '<i class="fas fa-face-frown" style="color:var(--lk-bad)" title="Sounds unhappy"></i>' : '') + '</span><span class="sn" style="display:block">' + esc(t.snippet || '') + '</span>' +
          '<span class="so-row" style="gap:4px;margin-top:4px">' + tags.map(function (x) { return '<span class="so-pill ' + (x === 'spam' ? 'bad' : x === 'price' || x === 'viewing' ? 'hot' : '') + '">' + esc(x) + '</span>'; }).join('') + (t.assignedTo && t.assignedTo.name ? '<span class="so-pill info"><i class="fas fa-user"></i>' + esc(t.assignedTo.name.split(' ')[0]) + '</span>' : '') + (t.pending ? '<span class="so-pill warn">' + t.pending + ' waiting approval</span>' : '') + '</span></span>' +
          '<span class="meta"><span class="so-tiny so-muted">' + esc(fmt(t.lastAt, { weekday: undefined, hour: undefined, minute: undefined })) + '</span>' + sla + (!S.page ? '<span class="so-dot" style="background:' + esc(pageOf(t.pageId).color) + '" title="' + esc(pageOf(t.pageId).name) + '"></span>' : '') + '</span></button>';
      }).join('') : empty('fa-inbox', IB.status === 'unanswered' ? 'Nobody is waiting for a reply.' : 'Nothing here. New comments and messages arrive through the webhook, and a check runs every 10 minutes.');
      if (!IB.key && window.innerWidth > 980 && r.threads.length) { IB.key = r.threads[0].key; var first = document.querySelector('.so-th'); if (first) first.setAttribute('aria-current', 'true'); }
      if (IB.key) openThread(IB.key);
    }).catch(fail);
  }
  ACT.ibStatus = function (el) { IB.status = el.getAttribute('data-v'); IB.key = ''; VIEWS.inbox(); };
  INP.ibKind = function (el) { IB.kind = el.value; IB.key = ''; loadThreads(); };
  INP.ibTag = function (el) { IB.tag = el.value; IB.key = ''; loadThreads(); };
  INP.ibMine = function (el) { IB.mine = el.checked; IB.key = ''; loadThreads(); };
  ACT.ibSync = function (el) { el.disabled = true; api('/inbox/sync', { method: 'POST' }).then(function (r) { toast(r.added + ' new'); VIEWS.inbox(); }).catch(fail).then(function () { el.disabled = false; }); };
  ACT.ibOpen = function (el) { IB.key = el.getAttribute('data-k'); $$('.so-th').forEach(function (b) { b.setAttribute('aria-current', String(b === el)); }); $('#ibWrap').classList.add('open'); openThread(IB.key); };
  ACT.ibBack = function () { IB.key = ''; $('#ibWrap').classList.remove('open'); };
  function openThread(key) {
    var box = $('#ibThread'); if (!box) return;
    box.innerHTML = '<div class="so-spin"></div>';
    Promise.all([api('/inbox/thread?key=' + encodeURIComponent(key)), loadTemplates(), can('draft') ? (S.staff ? Promise.resolve({ staff: S.staff }) : api('/staff')) : Promise.resolve({ staff: [] })]).then(function (r) {
      var d = r[0], th = d.thread, staff = r[2].staff; S.staff = staff; IB.cur = d;
      var k = KIND[th.kind] || ['', 'fas fa-comment', 'fb'], isMsg = th.kind === 'messenger' || th.kind === 'ig_dm', w = th.window;
      var tags = th.tags || [];
      var html = '<div class="so-between" style="margin-bottom:10px;flex-wrap:wrap"><div class="so-row" style="min-width:0;flex-wrap:nowrap"><button class="so-iconbtn" data-act="ibBack" aria-label="Back to the list" style="' + (window.innerWidth > 980 ? 'display:none' : '') + '"><i class="fas fa-arrow-left"></i></button><span class="so-net ' + k[2] + '"><i class="' + k[1] + '"></i></span><div style="min-width:0"><div style="font-weight:800;font-size:15px">' + esc(th.name || 'Someone') + '</div><div class="so-small so-muted">' + esc(k[0]) + ' · ' + esc(pageOf(th.pageId).name) + '</div></div></div>' +
        '<div class="so-btns">' + (d.lead ? '<a class="so-btn sm" href="/admin.html#leads" target="_blank" rel="noopener"><i class="fas fa-bullseye"></i>Lead: ' + esc(d.lead.stage) + '</a>' : '') + (th.link ? '<a class="so-btn sm" href="' + esc(th.link) + '" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i>Open in Meta</a>' : '') + '</div></div>';
      if (can('draft')) html += '<div class="so-row" style="margin-bottom:12px">' + S.me.tags.map(function (t) { return '<button class="so-chip" data-act="ibTagT" data-v="' + t + '" aria-pressed="' + (tags.indexOf(t) >= 0) + '">' + t + ((th.autoTags || []).indexOf(t) >= 0 && tags.indexOf(t) < 0 ? ' <i class="fas fa-wand-magic-sparkles" title="Suggested"></i>' : '') + '</button>'; }).join('') +
        '<select data-ch="ibAssign" aria-label="Assign to" style="max-width:180px"><option value="">Unassigned</option>' + staff.map(function (s) { return '<option value="' + s.id + '"' + (th.assignedTo && th.assignedTo.id === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select>' +
        '<button class="so-btn sm" data-act="ibDone">' + (th.status === 'done' ? '<i class="fas fa-rotate-left"></i>Reopen' : '<i class="fas fa-check"></i>Mark done') + '</button></div>';
      if (th.waiting) html += '<div class="so-banner ' + (th.unanswered ? 'bad' : 'info') + '"><i class="far fa-clock"></i><div class="so-small">Waiting for a reply for <b>' + ago((Date.now() - new Date(th.lastInboundAt)) / 60000) + '</b>' + (th.unanswered ? ' (over the ' + IB.hours + '-hour target)' : '') + '. ' + (th.sentiment === 'negative' ? 'The last message sounds unhappy.' : '') + '</div></div>';
      html += '<div class="so-msgs" id="ibMsgs">' + d.items.map(function (it) {
        var reply = !isMsg && it.parentId;
        return '<div class="so-msg' + (it.own ? ' own' : '') + (it.hidden ? ' hidden' : '') + (it.deleted ? ' deleted' : '') + (reply ? ' reply' : '') + '"><div class="bb">' + esc(it.text || '') + '</div><div class="ft"><span>' + esc(it.own ? pageOf(th.pageId).name : it.fromName || '') + ' · ' + esc(fmt(it.at)) + '</span>' + (it.hidden ? pill('hidden', 'warn') : '') + (it.deleted ? pill('deleted', 'bad') : '') +
          (!isMsg && !it.deleted && can('draft') ? (!it.own ? '<button data-act="ibItem" data-k="reply" data-id="' + it._id + '">Reply</button><button data-act="ibItem" data-k="' + (it.hidden ? 'unhide' : 'hide') + '" data-id="' + it._id + '">' + (it.hidden ? 'Unhide' : 'Hide') + '</button>' : '') + '<button data-act="ibItem" data-k="delete" data-id="' + it._id + '">Delete</button>' : '') + '</div></div>';
      }).join('') + '</div>';
      var pend = d.actions.filter(function (a) { return a.status === 'pending'; });
      if (pend.length) html += '<div class="so-well so-small" style="margin-top:10px"><b><i class="fas fa-hourglass-half"></i> Waiting for approval:</b> ' + pend.map(function (a) { return esc(a.kind === 'reply' ? '"' + a.text.slice(0, 80) + '"' : a.kind); }).join(', ') + '</div>';
      var failed = d.actions.filter(function (a) { return a.status === 'failed'; }).slice(0, 2);
      failed.forEach(function (a) { html += '<div class="so-banner bad" style="margin:10px 0 0"><i class="fas fa-circle-xmark"></i><div class="so-small">' + esc(a.kind) + ' failed: ' + esc(a.error) + '</div></div>'; });
      if (can('draft')) {
        var closed = isMsg && w && !w.open;
        html += '<hr class="so-hr"><div class="so-col" id="ibCompose">' + (closed ? '<div class="so-banner warn" style="margin:0"><i class="fas fa-lock"></i><div class="so-small"><b>Reply closed.</b> ' + esc(w.why) + '</div></div>' :
          (isMsg && w && w.open ? '<div class="so-tiny so-muted"><i class="far fa-clock"></i> You can reply until ' + esc(fmt(w.closesAt)) + ' (24 hours after their last message).</div>' : '<div class="so-tiny so-muted" id="ibTarget">' + (S.ibItem ? 'Replying to a comment' : 'Replying to the first comment in this thread') + '</div>') +
          '<div class="so-row"><select data-ch="ibSaved" aria-label="Saved reply" style="max-width:240px"><option value="">Saved replies…</option>' + r[1].filter(function (x) { return x.kind === 'reply' && (!x.pageId || x.pageId === th.pageId); }).map(function (x) { return '<option value="' + x._id + '">' + esc(x.name) + '</option>'; }).join('') + '</select>' +
          '<button class="so-btn sm" data-act="ibSuggest"><i class="fas fa-robot"></i>Suggest a reply</button></div>' +
          '<label class="so-field"><span class="so-sr">Reply</span><textarea id="ibText" rows="3" placeholder="Write a reply…"></textarea></label>' +
          '<div class="so-bar"><button class="so-btn" data-act="ibSend" data-v="draft"><i class="fas fa-hourglass-half"></i>Save for approval</button>' + (can('approve') ? '<button class="so-btn pri" data-act="ibSend" data-v="now"><i class="fas fa-paper-plane"></i>Send now</button>' : '') + '</div>') + '</div>';
      }
      box.innerHTML = html;
      S.ibItem = null;
      var m = $('#ibMsgs'); if (m) m.scrollTop = m.scrollHeight;
    }).catch(fail);
  }
  ACT.ibTagT = function (el) {
    var th = IB.cur.thread, t = el.getAttribute('data-v'), tags = (th.tags || []).slice(), i = tags.indexOf(t);
    if (i >= 0) tags.splice(i, 1); else tags.push(t);
    api('/inbox/thread', { method: 'PATCH', body: { key: th.key, tags: tags } }).then(function () { th.tags = tags; el.setAttribute('aria-pressed', String(i < 0)); }).catch(fail);
  };
  INP.ibAssign = function (el) { api('/inbox/thread', { method: 'PATCH', body: { key: IB.cur.thread.key, assignTo: el.value || '' } }).then(function () { toast(el.value ? 'Assigned' : 'Unassigned'); loadThreads(); }).catch(fail); };
  ACT.ibDone = function () { var th = IB.cur.thread; api('/inbox/thread', { method: 'PATCH', body: { key: th.key, status: th.status === 'done' ? 'open' : 'done' } }).then(function () { toast(th.status === 'done' ? 'Reopened' : 'Marked done'); IB.key = th.status === 'done' ? th.key : ''; loadThreads(); if (!IB.key) { $('#ibWrap').classList.remove('open'); $('#ibThread').innerHTML = empty('fa-comments', 'Choose a conversation.'); } }).catch(fail); };
  INP.ibSaved = function (el) { var t = (S.templates || []).filter(function (x) { return x._id === el.value; })[0]; if (t) { var ta = $('#ibText'); ta.value = (ta.value ? ta.value + ' ' : '') + t.text; ta.focus(); } el.value = ''; };
  ACT.ibSuggest = function (el) {
    el.disabled = true; el.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Thinking…';
    api('/ai/reply', { method: 'POST', body: { threadKey: IB.cur.thread.key, tone: 'warm_taglish' } }).then(function (r) { $('#ibText').value = r.text; toast('Suggestion added: edit it before saving.'); }).catch(fail).then(function () { el.disabled = false; el.innerHTML = '<i class="fas fa-robot"></i>Suggest a reply'; });
  };
  ACT.ibItem = function (el) {
    var k = el.getAttribute('data-k'), id = el.getAttribute('data-id');
    if (k === 'reply') { S.ibItem = id; var t = $('#ibTarget'); if (t) t.textContent = 'Replying to this comment'; var ta = $('#ibText'); if (ta) ta.focus(); return; }
    var word = { hide: 'Hide', unhide: 'Unhide', delete: 'Delete' }[k];
    var body = '<p>' + word + ' this comment on ' + esc(pageOf(IB.cur.thread.pageId).name) + '?' + (k === 'delete' ? ' Deleting cannot be undone.' : k === 'hide' ? ' The person and their friends still see it; nobody else does.' : '') + '</p>';
    modal(word + ' comment', body, '<div class="so-bar"><button class="so-btn" data-act="closeModal">Cancel</button><button class="so-btn" data-act="ibDo" data-k="' + k + '" data-id="' + id + '" data-now="0">Ask for approval</button>' + (can('approve') ? '<button class="so-btn ' + (k === 'delete' ? 'bad' : 'pri') + '" data-act="ibDo" data-k="' + k + '" data-id="' + id + '" data-now="1">' + word + ' now</button>' : '') + '</div>');
  };
  ACT.ibDo = function (el) {
    var now = el.getAttribute('data-now') === '1';
    api('/inbox/actions', { method: 'POST', body: { itemId: el.getAttribute('data-id'), threadKey: IB.cur.thread.key, kind: el.getAttribute('data-k'), sendNow: now } }).then(function () { closeModal(); toast(now ? 'Done' : 'Waiting for approval'); refreshBadge(); openThread(IB.cur.thread.key); }).catch(fail);
  };
  ACT.ibSend = function (el) {
    var text = $('#ibText').value.trim(), now = el.getAttribute('data-v') === 'now';
    if (!text) return toast('Write the reply first', true);
    el.disabled = true;
    api('/inbox/actions', { method: 'POST', body: { threadKey: IB.cur.thread.key, itemId: S.ibItem || '', kind: 'reply', text: text, sendNow: now } }).then(function () { toast(now ? 'Sent' : 'Saved: waiting for approval'); refreshBadge(); loadThreads(); }).catch(function (e) { fail(e); el.disabled = false; });
  };

  // ══ INSIGHTS ══════════════════════════════════════════════════
  function insRange() { var to = addDays(todayKey(), -1); return INS.days ? { from: addDays(to, -(INS.days - 1)), to: to } : { from: INS.from || addDays(to, -29), to: INS.to || to }; }
  function spark(series, color) {
    var v = (series || []).map(function (x) { return x[1]; }).filter(function (x) { return x != null; });
    if (v.length < 2) return '';
    var max = Math.max.apply(null, v), min = Math.min.apply(null, v), W = 120, H = 30, step = W / (v.length - 1);
    var pts = v.map(function (x, i) { return (i * step).toFixed(1) + ',' + (H - 2 - (max === min ? H / 2 : (x - min) / (max - min) * (H - 4))).toFixed(1); }).join(' ');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + esc(color) + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
  }
  function tile(t, color) {
    if (t.status === 'retired') return '<div class="so-kpi retired"><div class="l">' + esc(t.label) + '</div><div class="v">Retired by Meta</div><div class="d so-tiny so-muted">Meta no longer offers this figure; the others are unaffected.</div></div>';
    var ch = t.change != null && t.change !== 0 ? '<span class="d ' + (t.change > 0 ? 'up' : 'down') + '">' + (t.change > 0 ? '+' : '') + n(t.change, 0) + '</span>' : '';
    return '<div class="so-kpi"><div class="l" title="' + esc(t.statusMsg || '') + '">' + esc(t.label) + (t.status === 'error' ? ' <i class="fas fa-triangle-exclamation" style="color:var(--lk-warn)"></i>' : '') + '</div><div class="v">' + compact(t.value) + '</div>' + ch + spark(t.series, color) + '</div>';
  }
  VIEWS.insights = function () {
    var R = insRange();
    var html = head('Insights', 'Meta\'s figures (they lag 1 to 2 days; daily reach added up counts a person once per day) with the leads that came through each post\'s link.',
      '<div class="so-seg" role="group" aria-label="Range">' + [7, 30, 90].map(function (d) { return '<button data-act="insDays" data-v="' + d + '" aria-pressed="' + (INS.days === d) + '">' + d + ' days</button>'; }).join('') + '</div>' +
      '<button class="so-btn sm" data-act="insCsv"><i class="fas fa-file-csv"></i>CSV</button><button class="so-btn sm" data-act="insPdf"><i class="far fa-file-pdf"></i>PDF</button>' +
      (can('approve') ? '<button class="so-btn sm" data-act="insRefresh"><i class="fas fa-rotate"></i>Refresh</button><button class="so-btn sm" data-act="insSend"><i class="far fa-envelope"></i>Email report</button>' : ''));
    html += '<div id="insBody"><div class="so-spin"></div></div>';
    setView(html);
    Promise.all([api('/insights?from=' + R.from + '&to=' + R.to + '&pageId=' + encodeURIComponent(S.page)), api('/insights/heatmap?pageId=' + encodeURIComponent(S.page)), api('/insights/ads?from=' + R.from + '&to=' + R.to).catch(function (e) { return { error: e.message, configured: true }; })]).then(function (r) {
      var d = r[0], hm = r[1], ads = r[2];
      var b = '<p class="so-small so-muted" style="margin:-6px 0 14px">' + esc(R.from) + ' to ' + esc(R.to) + (d.lastSnapshotAt ? ' · figures read ' + esc(fmt(d.lastSnapshotAt)) : ' · not read yet: an approver can press Refresh') + '</p>';
      var totalLeads = d.pages.reduce(function (a, p) { return a + p.leads; }, 0);
      b += '<div class="so-grid so-g4" style="margin-bottom:16px">' + kpi('Leads from posts', totalLeads, 'people who arrived through a post link', true) +
        kpi('Median first reply', d.replySpeed.medianMin == null ? '–' : ago(d.replySpeed.medianMin), d.replySpeed.answered + ' of ' + d.replySpeed.threads + ' conversations answered') +
        kpi('Posts', d.pages.reduce(function (a, p) { return a + p.posts.count; }, 0), 'Facebook and Instagram, in range') +
        kpi('Pages', d.pages.length, S.page ? 'one Page shown' : 'all Pages') + '</div>';
      d.pages.forEach(function (p) {
        b += '<div class="so-card" style="margin-bottom:16px"><div class="so-card-head"><h2><span class="so-dot" style="background:' + esc(p.page.color) + '"></span>' + esc(p.page.name) + '</h2><div class="so-row">' + pill(p.leads + ' lead' + (p.leads === 1 ? '' : 's') + ' from posts', p.leads ? 'hot' : '', 'fas fa-bullseye') + pill(p.posts.fb + ' FB · ' + p.posts.ig + ' IG posts') + '</div></div>';
        b += '<div class="so-label" style="margin:0 0 8px">' + netIcon('fb') + ' Facebook</div><div class="so-grid so-g3" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">' + (p.tiles.fb || []).map(function (t) { return tile(t, p.page.color); }).join('') + '</div>';
        if (p.tiles.ig) b += '<div class="so-label" style="margin:14px 0 8px">' + netIcon('ig') + ' Instagram @' + esc(p.page.igUsername) + '</div><div class="so-grid so-g3" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">' + p.tiles.ig.map(function (t) { return tile(t, p.page.color); }).join('') + '</div>';
        b += '<div class="so-grid so-g2" style="margin-top:14px"><div><h3><i class="fas fa-trophy"></i>Top posts</h3>' + (p.top.length ? '<div class="so-list">' + p.top.map(statRow).join('') + '</div>' : empty('fa-chart-simple', 'No posts in this range yet.')) + '</div>' +
          '<div><h3><i class="fas fa-arrow-trend-down"></i>Weakest posts</h3>' + (p.bottom.length ? '<div class="so-list">' + p.bottom.map(statRow).join('') + '</div>' : empty('fa-chart-simple', 'Needs more than 5 posts to compare.')) + '</div></div></div>';
      });
      // best time
      var maxv = 0; hm.grid.forEach(function (r) { r.forEach(function (v) { if (v != null && v > maxv) maxv = v; }); });
      b += '<div class="so-grid so-g2"><div class="so-card"><div class="so-card-head"><h2><i class="fas fa-fire"></i>Best time to post</h2><span class="so-tiny so-muted">' + hm.posts + ' posts · Manila time</span></div><div class="so-heat">';
      b += '<span></span>'; for (var h = 0; h < 24; h++) b += '<span class="hl">' + (h % 3 === 0 ? (h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p') : '') + '</span>';
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (dn, wd) { b += '<span class="rl">' + dn + '</span>'; for (var hh = 0; hh < 24; hh++) { var v = hm.grid[wd][hh]; b += '<span class="c" title="' + dn + ' ' + hh + ':00 · ' + (hm.counts[wd][hh] || 0) + ' post(s)' + (v != null ? ' · score ' + v : '') + '"' + (v != null ? ' style="background:color-mix(in srgb,var(--lk-accent) ' + Math.round(25 + 75 * v / (maxv || 1)) + '%,transparent)"' : '') + '></span>'; } });
      b += '</div><p class="so-small" style="margin:12px 0 6px"><b>Next best slots:</b></p><div class="so-slots">' + hm.slots.map(function (s) { return '<span class="so-chip" aria-pressed="false">' + esc(s.label) + ' · ' + esc(fmt(s.at, { weekday: undefined, hour: undefined, minute: undefined })) + '</span>'; }).join('') + '</div><p class="so-tiny so-muted">Based on ' + esc(hm.basis) + '. Each Page is scored against its own usual engagement.</p></div>';
      // ads
      b += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-rectangle-ad"></i>Ads</h2>' + pill('Read only', 'info', 'fas fa-lock') + '</div>' + (!ads.configured ? empty('fa-rectangle-ad', 'No ad account connected (META_AD_ACCOUNT_ID).') : ads.error ? '<div class="so-banner warn"><i class="fas fa-triangle-exclamation"></i><div class="so-small">' + esc(ads.error) + '</div></div>' :
        (ads.campaigns.length ? '<div class="so-grid so-g3" style="margin-bottom:12px">' + kpi('Spend', peso(ads.totals.spend)) + kpi('Leads (Meta)', n(ads.totals.leads, 0)) + kpi('Per lead', peso(ads.totals.cpl)) + '</div><div class="so-tablewrap"><table class="so-table cards"><thead><tr><th>Campaign</th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">Leads</th><th class="num">Per lead</th></tr></thead><tbody>' +
          ads.campaigns.map(function (c) { return '<tr><td data-l="Campaign" class="full"><b>' + esc(c.name) + '</b></td><td class="num" data-l="Spend">' + peso(c.spend) + '</td><td class="num" data-l="Clicks">' + n(c.clicks, 0) + '</td><td class="num" data-l="Leads">' + n(c.leads, 0) + '</td><td class="num" data-l="Per lead">' + peso(c.cpl) + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty('fa-rectangle-ad', 'No ad spend in this range.'))) +
        '<p class="so-tiny so-muted" style="margin:10px 0 0">GLRA Social never creates, edits or pauses ads, and never changes a budget.</p></div></div>';
      $('#insBody').innerHTML = b;
    }).catch(fail);
  };
  function statRow(s) {
    return '<div class="so-li">' + (s.thumb ? '<img class="so-thumb" src="' + esc(s.thumb) + '" alt="" loading="lazy">' : '<span class="so-thumb" style="display:flex;align-items:center;justify-content:center"><i class="fas fa-align-left so-muted"></i></span>') + '<div style="flex:1;min-width:0"><div class="t">' + esc(s.text || '(no text)') + '</div>' +
      '<div class="so-small so-muted">' + netIcon(s.network) + ' ' + esc(fmt(s.at, { hour: undefined, minute: undefined })) + ' · ' + n(s.engagement, 0) + ' engagement' + (s.reach != null ? ' · ' + compact(s.reach) + ' reached' : '') + '</div>' +
      '<div class="so-row" style="gap:6px;margin-top:3px">' + (s.leads ? pill(s.leads + ' lead' + (s.leads > 1 ? 's' : ''), 'hot', 'fas fa-bullseye') : '') + (s.permalink ? '<a class="so-small" href="' + esc(s.permalink) + '" target="_blank" rel="noopener">Open <i class="fas fa-arrow-up-right-from-square"></i></a>' : '') + '</div></div></div>';
  }
  ACT.insDays = function (el) { INS.days = +el.getAttribute('data-v'); VIEWS.insights(); };
  ACT.insCsv = function () { var R = insRange(); download('/insights.csv?from=' + R.from + '&to=' + R.to, 'glra-social-insights-' + R.from + '-to-' + R.to + '.csv'); };
  ACT.insPdf = function () { var R = insRange(); toast('Building the PDF…'); download('/report.pdf?from=' + R.from + '&to=' + R.to, 'glra-social-report-' + R.from + '-to-' + R.to + '.pdf'); };
  ACT.insRefresh = function (el) { el.disabled = true; toast('Reading the numbers from Meta…'); api('/insights/refresh', { method: 'POST' }).then(function (r) { toast('Read ' + r.rows + ' days and ' + r.posts + ' posts' + (r.errors.length ? ' (' + r.errors.length + ' figure(s) not available)' : '')); VIEWS.insights(); }).catch(fail).then(function () { el.disabled = false; }); };
  ACT.insSend = function (el) { el.disabled = true; api('/report/send', { method: 'POST' }).then(function (r) { toast('Report emailed to ' + r.recipients.join(', ')); }).catch(fail).then(function () { el.disabled = false; }); };

  // ══ LIBRARY ═══════════════════════════════════════════════════
  VIEWS.library = function () {
    loading();
    Promise.all([api('/media'), loadTemplates(true)]).then(function (r) {
      var media = r[0].media, sets = r[1].filter(function (t) { return t.kind === 'hashtags'; });
      var html = head('Library', 'Photos and videos for social posts, and hashtag sets. Instagram limits: 4:5 to 1.91:1 photos, 2,200 characters, 30 hashtags.',
        can('draft') ? (r[0].cloudinary ? '<label class="so-btn pri"><i class="fas fa-upload"></i>Upload<input type="file" class="so-sr" accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" data-ch="libUpload"></label>' : '') + '<button class="so-btn' + (r[0].cloudinary ? '' : ' pri') + '" data-act="cUrl"><i class="fas fa-link"></i>Add a link</button>' : '');
      if (!r[0].cloudinary) html += '<div class="so-banner info"><i class="fas fa-cloud"></i><div class="so-small">Cloudinary is not configured on this server, so uploads are off. Links to public https files still work.</div></div>';
      html += '<div class="so-card" style="margin-bottom:16px"><div class="so-card-head"><h2><i class="fas fa-photo-film"></i>Media</h2><span class="so-small so-muted">' + media.length + (media.length === 1 ? ' item' : ' items') + '</span></div>' + (media.length ? '<div class="so-grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">' + media.map(function (m) {
        var ig = m.ig || {};
        return '<div class="so-well" style="padding:8px"><div class="so-mi" style="aspect-ratio:1">' + (m.type === 'video' ? '<video src="' + esc(m.url) + '#t=0.5" muted preload="metadata"></video>' : '<img src="' + esc(m.url) + '" alt="" loading="lazy">') + '</div>' +
          '<div class="so-small" style="margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(m.name) + '">' + esc(m.name || 'untitled') + '</div><div class="so-tiny so-muted">' + (m.width ? m.width + '×' + m.height : (m.type === 'video' ? 'video' : 'size unknown')) + '</div>' +
          '<div style="margin:6px 0">' + (m.type === 'video' ? pill('Reels: 9:16 best', 'info') : !ig.known ? pill('Ratio unknown', '') : ig.ok ? pill('Instagram-ready', 'ok', 'fas fa-check') : pill(ig.fixUrl ? 'Crops for IG' : 'Not IG-ready', ig.fixUrl ? 'warn' : 'bad')) + '</div>' +
          (ig.fixUrl ? '<a class="so-tiny" href="' + esc(ig.fixUrl) + '" target="_blank" rel="noopener">See the ' + esc(ig.ar === '4:5' ? '4:5' : '1.91:1') + ' crop</a>' : '') +
          '<div class="so-bar" style="margin-top:6px;grid-template-columns:1fr 1fr;grid-auto-flow:row;justify-content:stretch">' + (can('draft') ? '<button class="so-btn xs" data-act="libUse" data-m="' + esc(JSON.stringify({ url: m.url, type: m.type, width: m.width, height: m.height, mediaId: m._id })) + '">Use</button><button class="so-btn xs bad" data-act="libDel" data-id="' + m._id + '">Remove</button>' : '') + '</div></div>';
      }).join('') + '</div>' : empty('fa-photo-film', 'Nothing here yet. Uploads from the composer land here too.')) + '</div>';
      html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-hashtag"></i>Hashtag sets</h2>' + (can('draft') ? '<button class="so-btn sm" data-act="tplNew" data-k="hashtags"><i class="fas fa-plus"></i>New set</button>' : '') + '</div>' + tplList(sets, 'hashtags') + '</div>';
      setView(html);
    }).catch(fail);
  };
  INP.libUpload = function (el) { var f = el.files[0]; if (!f) return; var fd = new FormData(); fd.append('file', f); toast('Uploading…'); api('/media/upload', { method: 'POST', body: fd }).then(function () { toast('Uploaded'); VIEWS.library(); }).catch(fail); };
  ACT.libUse = function (el) { if (!C) C = newCompose(); if (C.media.length >= 10) return toast('At most 10', true); C.media.push(JSON.parse(el.getAttribute('data-m'))); go('compose'); };
  ACT.libDel = function (el) { if (!confirm('Remove it from the library? Posts already using it are not affected.')) return; api('/media/' + el.getAttribute('data-id'), { method: 'DELETE' }).then(function () { VIEWS.library(); }).catch(fail); };
  // the composer's "Paste a link" also serves the library: refresh after
  var _cUrlGo = ACT.cUrlGo;
  ACT.cUrlGo = function () { if (S.tab === 'library') { var url = $('#uUrl').value.trim(), vid = $('#uVid').checked; (vid ? Promise.resolve({ width: 0, height: 0 }) : measure(url)).then(function (d) { return api('/media/url', { method: 'POST', body: { url: url, type: vid ? 'video' : 'image', width: d.width, height: d.height } }); }).then(function () { closeModal(); VIEWS.library(); }).catch(fail); } else _cUrlGo(); };

  // templates (shared by Library and Settings)
  function tplList(list, kind) {
    if (!list.length) return empty(kind === 'hashtags' ? 'fa-hashtag' : kind === 'reply' ? 'fa-comment-dots' : 'fa-file-lines', kind === 'hashtags' ? 'No hashtag sets yet.' : kind === 'reply' ? 'No saved replies yet: add answers to the questions people ask most (price, viewing, requirements, location).' : 'No caption templates yet.');
    return '<div class="so-list">' + list.map(function (t) {
      return '<div class="so-li"><div style="flex:1;min-width:0"><div class="t">' + esc(t.name) + ' ' + (t.pageId ? pill(pageOf(t.pageId).name) : '') + (t.topic ? pill(t.topic, 'info') : '') + (kind === 'hashtags' ? pill(hashtags(t.text) + ' / 30', hashtags(t.text) > 30 ? 'bad' : '') : '') + '</div><div class="so-small so-muted" style="white-space:pre-wrap;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">' + esc(t.text) + '</div></div>' +
        (can('draft') ? '<div class="so-btns"><button class="so-btn xs" data-act="tplEdit" data-id="' + t._id + '" aria-label="Edit"><i class="fas fa-pen"></i></button><button class="so-btn xs bad" data-act="tplDel" data-id="' + t._id + '" aria-label="Delete"><i class="far fa-trash-can"></i></button></div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function tplForm(t, kind) {
    t = t || { kind: kind, name: '', text: '', pageId: '', topic: '' };
    var names = { caption: 'caption template', reply: 'saved reply', hashtags: 'hashtag set' };
    modal((t._id ? 'Edit ' : 'New ') + names[t.kind], '<div class="so-col"><label class="so-field"><span>Name</span><input type="text" id="tName" value="' + esc(t.name) + '" maxlength="120" placeholder="' + (t.kind === 'reply' ? 'e.g. Price question' : t.kind === 'hashtags' ? 'e.g. Makati condos' : 'e.g. Open house') + '"></label>' +
      '<div class="so-grid so-g2"><label class="so-field"><span>Page</span><select id="tPage"><option value="">Every Page</option>' + S.pages.map(function (p) { return '<option value="' + p.id + '"' + (p.id === t.pageId ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select></label><label class="so-field"><span>Topic (optional)</span><input type="text" id="tTopic" value="' + esc(t.topic) + '" maxlength="60"></label></div>' +
      '<label class="so-field"><span>' + (t.kind === 'hashtags' ? 'Hashtags (at most 30)' : 'Text') + '</span><textarea id="tText" rows="6" data-in="tCount">' + esc(t.text) + '</textarea></label><div class="so-counter" id="tCounter"></div>' +
      (t.kind === 'caption' ? '<p class="so-tiny so-muted">Placeholders filled in the composer: {property} {price} {area} {link} {page}</p>' : '') + '</div>',
      '<div class="so-bar"><button class="so-btn" data-act="closeModal">Cancel</button><button class="so-btn pri" data-act="tplSave">Save</button></div>');
    S.tplEdit = t; INP.tCount($('#tText'));
  }
  INP.tCount = function (el) { var c = $('#tCounter'); if (c) c.innerHTML = '<span><b>' + el.value.length + '</b> characters</span><span' + (hashtags(el.value) > 30 ? ' class="over"' : '') + '><b>' + hashtags(el.value) + '</b> / 30 hashtags</span>'; };
  ACT.tplNew = function (el) { tplForm(null, el.getAttribute('data-k')); };
  ACT.tplEdit = function (el) { tplForm(S.templates.filter(function (t) { return t._id === el.getAttribute('data-id'); })[0]); };
  ACT.tplSave = function () {
    var t = S.tplEdit, body = { kind: t.kind, name: $('#tName').value, text: $('#tText').value, pageId: $('#tPage').value, topic: $('#tTopic').value };
    api(t._id ? '/templates/' + t._id : '/templates', { method: t._id ? 'PUT' : 'POST', body: body }).then(function () { closeModal(); toast('Saved'); S.templates = null; route(true); }).catch(fail);
  };
  ACT.tplDel = function (el) { if (!confirm('Delete it?')) return; api('/templates/' + el.getAttribute('data-id'), { method: 'DELETE' }).then(function () { S.templates = null; route(true); }).catch(fail); };

  // ══ ACTIVITY ══════════════════════════════════════════════════
  var LOGF = { action: '', who: '' };
  VIEWS.activity = function () {
    var html = head('Activity', 'Everything GLRA Social did: who, what, which Page, when and Meta\'s id. Approvals and deletions are also in the admin Audit Log.',
      '<button class="so-btn sm" data-act="logCsv"><i class="fas fa-file-csv"></i>Export CSV</button>');
    html += '<div class="so-card" style="padding:12px;margin-bottom:14px"><div class="so-row so-filters"><select data-ch="logAction" aria-label="Action" style="max-width:220px" id="logAction"><option value="">Every action</option></select><input type="search" data-in="logWho" aria-label="Who" placeholder="Who…" value="' + esc(LOGF.who) + '" style="max-width:220px"></div></div><div id="logBody"><div class="so-spin"></div></div>';
    setView(html);
    loadLog();
  };
  var loadLog = debounce(function () {
    api('/log?limit=300&action=' + encodeURIComponent(LOGF.action) + '&who=' + encodeURIComponent(LOGF.who) + '&pageId=' + encodeURIComponent(S.page)).then(function (r) {
      var s = $('#logAction'); if (s && s.options.length <= 1) s.innerHTML = '<option value="">Every action</option>' + r.actions.sort().map(function (a) { return '<option' + (a === LOGF.action ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('');
      var b = $('#logBody'); if (!b) return;
      b.innerHTML = r.log.length ? '<div class="so-card" style="padding:0;overflow:hidden"><div class="so-tablewrap" style="border:0;border-radius:0"><table class="so-table cards"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Page</th><th>What</th><th>Meta id</th></tr></thead><tbody>' + r.log.map(function (l) {
        return '<tr><td data-l="When" style="white-space:nowrap">' + esc(fmt(l.at)) + '</td><td data-l="Who">' + esc(l.actorName || l.actor) + (l.via !== 'user' ? ' ' + pill(l.via.replace('_', ' '), l.via === 'review_key' ? 'info' : '') : '') + '</td><td data-l="Action">' + pill(l.action.replace(/_/g, ' '), !l.ok ? 'bad' : /published|approved|replied/.test(l.action) ? 'ok' : /deleted|hidden|rejected/.test(l.action) ? 'warn' : '') + '</td><td data-l="Page">' + (l.pageId ? esc(pageOf(l.pageId).name) + (l.network ? ' ' + netIcon(l.network) : '') : '') + '</td><td data-l="What" class="full">' + esc(l.summary) + '</td><td data-l="Meta id" class="so-tiny">' + esc(l.metaId) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' : '<div class="so-card">' + empty('fa-clock-rotate-left', 'Nothing logged yet.') + '</div>';
    }).catch(fail);
  }, 250);
  INP.logAction = function (el) { LOGF.action = el.value; loadLog(); };
  INP.logWho = function (el) { LOGF.who = el.value; loadLog(); };
  ACT.logCsv = function () { download('/log.csv?action=' + encodeURIComponent(LOGF.action) + '&who=' + encodeURIComponent(LOGF.who) + '&pageId=' + encodeURIComponent(S.page), 'glra-social-activity.csv'); };

  // ══ SETTINGS ══════════════════════════════════════════════════
  VIEWS.settings = function () {
    loading();
    Promise.all([api('/me'), loadTemplates(true), can('admin') ? api('/review-key') : Promise.resolve(null)]).then(function (r) {
      S.me = r[0]; var st = r[0].settings, tpl = r[1], key = r[2], a = can('approve');
      var html = head('Settings', 'Templates and saved replies for everyone; the rest for approvers.');
      html += '<div class="so-grid so-g2"><div class="so-col" style="gap:16px">';
      html += '<div class="so-card"><h2><i class="fas fa-sliders"></i>General</h2><div class="so-col">' +
        '<label class="so-field"><span>Flag a conversation as unanswered after (hours)</span><input type="number" id="sHours" min="1" max="168" value="' + st.unansweredHours + '"' + (a ? '' : ' disabled') + '></label>' +
        '<label class="so-check"><input type="checkbox" id="sMail"' + (st.approvalEmails ? ' checked' : '') + (a ? '' : ' disabled') + '> Email approvers a one-time approve link when something waits</label>' +
        '<label class="so-check"><input type="checkbox" id="sWeekly"' + (st.weeklyEmail ? ' checked' : '') + (a ? '' : ' disabled') + '> Weekly report every Monday 8 am (email + PDF)</label>' +
        (a ? '<label class="so-field"><span>Weekly report goes to (blank = the leads notification address)</span><input type="text" id="sTo" value="' + esc((st.reportEmails || []).join(', ')) + '" placeholder="name@example.com, other@example.com"></label><div class="so-bar"><button class="so-btn pri" data-act="setSave">Save</button></div>' : '<p class="so-small so-muted">Only an approver can change these.</p>') + '</div></div>';
      html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-file-lines"></i>Caption templates</h2>' + (can('draft') ? '<button class="so-btn sm" data-act="tplNew" data-k="caption"><i class="fas fa-plus"></i>New</button>' : '') + '</div>' + tplList(tpl.filter(function (t) { return t.kind === 'caption'; }), 'caption') + '</div>';
      html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-comment-dots"></i>Saved replies</h2>' + (can('draft') ? '<button class="so-btn sm" data-act="tplNew" data-k="reply"><i class="fas fa-plus"></i>New</button>' : '') + '</div>' + tplList(tpl.filter(function (t) { return t.kind === 'reply'; }), 'reply') + '</div>';
      html += '</div><div class="so-col" style="gap:16px">';
      if (key) {
        html += '<div class="so-card"><div class="so-card-head"><h2><i class="fas fa-robot"></i>Claude review key</h2>' + (key.enabled ? pill('Active · ends ' + key.keyHint, 'ok') : pill('No key', '')) + '</div>' +
          '<p class="so-small">Lets Claude read posts, insights and a <b>masked</b> copy of comments and messages (names as initials, phone numbers and emails removed) for an honest review, and add drafts that wait for your approval. It can never publish, send, hide, delete or touch ads. Every call is in Activity.</p>' +
          '<div class="so-small so-muted">' + (key.madeAt ? 'Made ' + esc(fmt(key.madeAt)) + ' · ' : '') + (key.lastUsedAt ? 'last used ' + esc(fmt(key.lastUsedAt)) : 'never used') + ' · ' + key.calls + ' calls logged</div>' +
          '<div id="keyShow"></div><div class="so-bar" style="margin-top:12px">' + (key.enabled ? '<button class="so-btn bad" data-act="keyRevoke"><i class="fas fa-ban"></i>Revoke</button>' : '') + '<button class="so-btn pri" data-act="keyMake"><i class="fas fa-key"></i>' + (key.enabled ? 'Replace key' : 'Make a key') + '</button></div>' +
          '<details style="margin-top:12px"><summary class="so-small" style="cursor:pointer">What it can call</summary><div class="so-small so-col" style="gap:3px;margin-top:8px">' + key.endpoints.map(function (e) { return '<code>' + esc(e) + '</code>'; }).join('') + '<span class="so-muted">Header: x-glra-review-key</span></div></details></div>';
      }
      html += '<div class="so-card"><h2><i class="fas fa-user-shield"></i>Who can do what</h2><div class="so-small so-col" style="gap:8px">' +
        '<div class="so-between"><span><b>View GLRA Social</b> (social_view)</span>' + pill(can('view') ? 'you have it' : 'no', can('view') ? 'ok' : '') + '</div>' +
        '<div class="so-between"><span><b>Write social drafts</b> (social_draft)</span>' + pill(can('draft') ? 'you have it' : 'no', can('draft') ? 'ok' : '') + '</div>' +
        '<div class="so-between"><span><b>Approve and publish</b> (social_approve)</span>' + pill(can('approve') ? 'you have it' : 'no', can('approve') ? 'ok' : '') + '</div>' +
        '<p class="so-muted" style="margin:4px 0 0">Set per person in the admin\'s Accounts screen. Publishing, sending, hiding and deleting are refused by the server without social_approve.</p></div></div>';
      html += '<div class="so-card"><h2><i class="fas fa-circle-info"></i>What Meta does not allow</h2><ul class="so-small" style="margin:0;padding-left:18px;line-height:1.7"><li>Instagram: no text-only or link posts, captions cannot be edited after publishing, about 50 API posts a day.</li><li>Facebook: scheduling 10 minutes to 75 days ahead; no posting to Groups or personal profiles; no boosting.</li><li>Messages: a Page cannot start a conversation and can reply only within 24 hours of the person\'s last message.</li><li>Comments: you can hide or delete someone\'s comment, not edit it.</li></ul></div>';
      html += '</div></div>';
      setView(html);
    }).catch(fail);
  };
  ACT.setSave = function () {
    api('/settings', { method: 'PUT', body: { unansweredHours: +$('#sHours').value, approvalEmails: $('#sMail').checked, weeklyEmail: $('#sWeekly').checked, reportEmails: $('#sTo').value } }).then(function () { toast('Saved'); }).catch(fail);
  };
  ACT.keyMake = function () {
    if (!confirm('Make a new review key? Any older key stops working at once.')) return;
    api('/review-key', { method: 'POST' }).then(function (r) {
      $('#keyShow').innerHTML = '<div class="so-banner warn" style="margin:12px 0 0"><i class="fas fa-key"></i><div class="so-small"><b>Copy it now: it is shown only once.</b><br><code style="word-break:break-all">' + esc(r.key) + '</code><div class="so-bar" style="margin-top:8px;justify-content:start"><button class="so-btn sm" data-act="keyCopy" data-k="' + esc(r.key) + '">Copy</button></div></div></div>';
    }).catch(fail);
  };
  ACT.keyCopy = function (el) { navigator.clipboard.writeText(el.getAttribute('data-k')).then(function () { toast('Copied'); }); };
  ACT.keyRevoke = function () { if (!confirm('Revoke the review key? Claude loses access at once.')) return; api('/review-key', { method: 'DELETE' }).then(function () { toast('Revoked'); VIEWS.settings(); }).catch(fail); };

  boot();
})();
