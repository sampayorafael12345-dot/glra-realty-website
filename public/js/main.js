/* ============================================
   GLRA Realty — Shared JavaScript
   Loaded by every page for common behavior:
   loader hide, dark mode, mobile menu, toast,
   back-to-top, service worker registration.
   ============================================ */

// ── Service worker (offline + caching) ────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── Loader: hide as soon as the page is ready ─────────────
(function hideLoaderWhenReady() {
  function hide() {
    const l = document.getElementById('loader');
    if (l) {
      l.classList.add('hide');
      setTimeout(() => l.style.display = 'none', 500);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hide);
  } else {
    hide();
  }
  // Failsafe: never show loader longer than 1 second
  setTimeout(hide, 1000);
})();

// ── Dark mode toggle ──────────────────────────────────────
// Repoint each logo image's source between /img/logo-384.png (black) and
// /img/hero-logo-384.png (white) on every navbar/brand mark. Covers
// img[data-logo-auto] for opt-in elements plus the common navbar selectors
// so inner pages don't need markup changes.
function syncLogos() {
  const dark = document.body.classList.contains('dark-mode');
  document.querySelectorAll('img[data-logo-auto], .ab-brand img, .navbar .logo img, .ab-mast img').forEach(img => {
    img.src = dark ? '/img/hero-logo-384.png' : '/img/logo-384.png';
  });
}
// Keep the early-theme `html.dark-mode-pre` class in sync with the body
// mode flag — otherwise toggling dark→light leaves dark-mode-pre stuck on
// <html>, and its `body{color:#f1eee9}` rule makes light-mode text invisible.
function syncDarkModePre() {
  document.documentElement.classList.toggle('dark-mode-pre', document.body.classList.contains('dark-mode'));
}
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  try { localStorage.setItem('darkMode', isDark); } catch (e) {}
  syncDarkModePre();
  const btn = document.getElementById('floatingDarkModeToggle') || document.getElementById('dmBtn');
  if (btn) btn.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
  syncLogos();
  glraSyncThemeToggles();
}

// Every dark-mode control on the page (the nav icon, the mobile-menu row, and
// the legacy floating button where one still exists) shows the same state.
// The icon names the mode you would switch TO: a moon in light mode, a sun in
// dark. aria-pressed carries the actual state for screen readers.
function glraSyncThemeToggles() {
  if (!document.body) return;
  const isDark = document.body.classList.contains('dark-mode');
  document.querySelectorAll('.glra-theme-toggle, .glra-theme-row').forEach(b => {
    b.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    const i = b.querySelector('i');
    if (i) i.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    const st = b.querySelector('.glra-theme-row-state');
    if (st) st.textContent = isDark ? 'On' : 'Off';
  });
}

// Migrate legacy '1'/'0' values written by an older inline script
try {
  const legacy = localStorage.getItem('darkMode');
  if (legacy === '1') localStorage.setItem('darkMode', 'true');
  else if (legacy === '0') localStorage.setItem('darkMode', 'false');
} catch (e) {}

// Apply saved dark mode preference on load
if (localStorage.getItem('darkMode') === 'true') {
  document.body.classList.add('dark-mode');
  document.addEventListener('DOMContentLoaded', () => {
    syncDarkModePre();
    const btn = document.getElementById('floatingDarkModeToggle') || document.getElementById('dmBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-sun"></i>';
    syncLogos();
    glraSyncThemeToggles();
  });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    syncDarkModePre();
    const btn = document.getElementById('floatingDarkModeToggle') || document.getElementById('dmBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-moon"></i>';
    syncLogos();
    glraSyncThemeToggles();
  });
}

// ── Mobile menu open/close ────────────────────────────────
function openMobileMenu() {
  const o = document.getElementById('mobileOverlay');
  if (o) o.classList.add('active');
  document.body.style.overflow = 'hidden';
}
function closeMobileMenu() {
  const o = document.getElementById('mobileOverlay');
  if (o) o.classList.remove('active');
  document.body.style.overflow = '';
}

// ── Toast notifications ───────────────────────────────────
function showToast(message, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' err' : '');
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Instant navigation ───────────────────────────────────
// When a visitor hovers or starts pressing a link, the browser fetches that
// page in the background, so the click lands on an already-downloaded
// document. Lives here rather than in brutalist-shell.js because the home page
// does not load the shell — main.js is on all 32 public pages and, correctly,
// not on admin.html.
//
// `prefetch`, not `prerender`, on purpose: it warms the cache without running
// the target page's scripts, so it cannot fire duplicate analytics or side
// effects. The server also ignores requests carrying Sec-Purpose: prefetch,
// so the visitor counter stays honest either way.
(function () {
  if (!(HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'))) return;
  if (document.querySelector('script[type="speculationrules"]')) return;   // never twice
  var spec = document.createElement('script');
  spec.type = 'speculationrules';
  spec.textContent = JSON.stringify({
    prefetch: [{
      source: 'document',
      where: {
        and: [
          { href_matches: '/*' },                              // same-origin only
          { not: { href_matches: '/admin*' } },                // never the portal
          { not: { href_matches: '/api/*' } },
          { not: { selector_matches: '[download]' } },
          { not: { selector_matches: '[target="_blank"]' } }
        ]
      },
      eagerness: 'moderate'    // on hover / pointerdown, not on sight
    }]
  });
  document.head.appendChild(spec);
})();

// ── HTML escape helper (used by pages that render dynamic text) ──
// Escapes quotes too: pages put the result inside attributes (alt="...", data-*).
function escapeHtml(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Sized photo URL: ask Cloudinary for a card-sized copy ──
// Listing photos are stored as .../image/upload/f_auto,q_auto/v123/... and
// cards used to download the full original. c_limit never enlarges.
function glraImgSize(url, w) {
  var u = String(url || '');
  var m = u.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(?:f_auto,q_auto\/)?(v\d+\/.*)$/);
  return m ? m[1] + 'f_auto,q_auto,c_limit,w_' + (w | 0) + '/' + m[2] : u;
}
if (typeof window !== 'undefined') window.glraImgSize = glraImgSize;

/* TITLE-HELPER-START */
// ── Display title: calm down an ALL-CAPS listing title ─────────────────────
// "MONARCH PARKSUITES (PASAY CITY)" -> "Monarch Parksuites, Pasay City".
// server.js implements the SAME spec for the /property/ pages, so the two
// must stay in step: change one, change the other. Titles already written in
// mixed case are returned as typed (after emoji and dash clean-up).
// The \p{...} patterns are built with new RegExp inside a try, never as
// literals: an older browser that cannot parse them would otherwise throw a
// SyntaxError that takes the whole of main.js down with it.
var glraDisplayTitle = (function () {
  var RX = {};
  try {
    RX.pict = new RegExp('\\p{Extended_Pictographic}', 'gu');
    RX.letter = new RegExp('\\p{L}', 'gu');
    RX.upper = new RegExp('\\p{Lu}', 'gu');
    RX.mc = new RegExp('^MC\\p{L}{2}', 'u');
  } catch (e) {
    RX.pict = /[☀-➿]|[\uD83C-\uD83E][\uDC00-\uDFFF]/g;
    RX.letter = /[A-Za-zÀ-ɏ]/g;
    RX.upper = /[A-ZÀ-Þ]/g;
    RX.mc = /^MC[A-Za-zÀ-ɏ]{2}/;
  }
  var KEEP = {};
  ('BGC CBD SM SMDC DMCI RLC MRT LRT NCR QC UP BPI BDO RFO HOA LEED MOA BF ' +
   'II III IV VI VII VIII IX XI XII').split(' ').forEach(function (k) { KEEP[k] = 1; });
  var SMALL = {};
  'a an and at by for in of on or the to along near with de del'.split(' ')
    .forEach(function (k) { SMALL[k] = 1; });
  var ABBR = { 'BRGY.': 'Brgy.', 'STA.': 'Sta.', 'STO.': 'Sto.', 'ST.': 'St.',
               'AVE.': 'Ave.', 'BLVD': 'Blvd', 'BLVD.': 'Blvd.' };
  var INITIALISM = /^([A-Z]\.){2,}$/;

  function cap(p) { return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); }
  function count(s, rx) { var m = s.match(rx); return m ? m.length : 0; }

  function part(p, first) {
    if (!p) return p;
    var U = p.toUpperCase();
    if (KEEP[U]) return U;
    if (/^\d+BR$/.test(p)) return p;
    if (U === 'SQM') return 'sqm';
    if (RX.mc.test(U)) return 'Mc' + cap(p.slice(2));
    if (SMALL[p.toLowerCase()] && !first) return p.toLowerCase();
    return cap(p);
  }

  function word(w, first) {
    var lead = (w.match(/^\(+/) || [''])[0];
    var rest = w.slice(lead.length);
    var trail = rest.match(/[,.)(]*$/)[0];
    var core = rest.slice(0, rest.length - trail.length);
    var dots = trail.match(/^\.*/)[0];
    var after = trail.slice(dots.length);
    var dotted = core + dots;
    var out;
    if (lead) first = true;
    if (INITIALISM.test(dotted)) out = dotted;
    else if (ABBR[dotted.toUpperCase()]) out = ABBR[dotted.toUpperCase()];
    else if (core.toUpperCase() === 'PAG-IBIG') out = 'Pag-IBIG' + dots;
    else {
      out = core.split('-').map(function (p, i) { return part(p, first && i === 0); }).join('-') + dots;
    }
    return lead + out + after;
  }

  return function (raw) {
    var s = String(raw || '');
    s = s.replace(RX.pict, '').replace(/️/g, '');
    s = s.replace(/ [—–-] /g, ' - ');
    s = s.replace(/\s+/g, ' ').trim();
    var letters = count(s, RX.letter);
    if (!letters || count(s, RX.upper) / letters < 0.7) return s;
    var words = s.split(' ');
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var prev = i > 0 ? words[i - 1] : null;
      var first = i === 0 || prev === '-' || prev === '(';
      out.push(word(words[i], first));
    }
    s = out.join(' ');
    return s.replace(/ \(([^()]+)\)$/, ', $1');
  };
})();
if (typeof window !== 'undefined') window.glraDisplayTitle = glraDisplayTitle;
/* TITLE-HELPER-END */

/* SITE-SHELL-START */
/* ============================================
   SITE SHELL: one contact button, theme toggles in the nav, back-to-top,
   image loading polish, view transitions.

   The CSS for all of it is injected from here rather than kept in
   styles.css, because the /property/ listing pages that server.js builds
   load main.js but NOT styles.css or brutalist-theme.css. Keeping it here
   is the only way one set of rules reaches all four stylesheet worlds
   (index.html, the inner pages, and both server templates).

   Every declaration that a page-level rule could fight carries !important
   and an id or doubled selector: brutalist-theme.css styles every <button>
   with !important, and index.html's inline sheet loads after this one.
   Colours are literals on purpose: --ab-paper and --ab-ink swap between
   light and dark mode, and the listing pages do not define them at all.
   ============================================ */
(function glraShellStyles() {
  if (typeof document === 'undefined' || document.getElementById('glraShellStyle')) return;
  var css = [
    /* ── Contact button + panel ── */
    '#glraContact{--gc-paper:#f1eee9;--gc-paper2:#e8e4dd;--gc-ink:#0a0a0a;--gc-line:#0a0a0a;--gc-gray:#5f5b55;--gc-hot-btn:#df3500;--gc-hot-text:#c02e00;--gc-shadow:#0a0a0a;--gc-fab-shadow:#0a0a0a;',
    '  position:fixed;right:18px;bottom:calc(var(--glra-dock,0px) + 18px);z-index:1000;font-family:"Inter","Segoe UI",system-ui,sans-serif;line-height:1.3}',
    'body.dark-mode #glraContact{--gc-paper:#0e0e0c;--gc-paper2:#1a1a17;--gc-ink:#f1eee9;--gc-line:#3a3a36;--gc-gray:#9a9082;--gc-hot-text:#ff3d00;--gc-shadow:#ff3d00;--gc-fab-shadow:rgba(241,238,233,.85)}',
    'html.glra-chat-open #glraContact,html.glra-pgbar-on #glraContact{display:none !important}',
    '#glraContact *{box-sizing:border-box}',
    /* the FAB */
    '#glraContact #glraContactFab{display:inline-flex !important;align-items:center !important;justify-content:center !important;gap:10px !important;',
    '  height:52px !important;min-width:52px !important;width:auto !important;padding:0 18px 0 16px !important;margin:0 !important;',
    '  background:var(--gc-hot-btn) !important;color:#fff !important;border:2px solid #0a0a0a !important;border-radius:0 !important;',
    '  box-shadow:4px 4px 0 var(--gc-fab-shadow) !important;cursor:pointer !important;text-decoration:none !important;',
    '  font-family:"JetBrains Mono",ui-monospace,monospace !important;font-size:11px !important;font-weight:700 !important;letter-spacing:2px !important;text-transform:uppercase !important;line-height:1 !important;',
    '  transform:none;transition:transform 170ms cubic-bezier(.23,1,.32,1),box-shadow 170ms cubic-bezier(.23,1,.32,1),background-color 170ms ease !important;',
    '  touch-action:manipulation;-webkit-tap-highlight-color:transparent;view-transition-name:glra-contact}',
    '#glraContact #glraContactFab i{font-size:16px !important;width:18px;text-align:center;pointer-events:none}',
    '#glraContact #glraContactFab .glra-contact-fab-lbl{pointer-events:none}',
    '#glraContact.is-open #glraContactFab{background:#0a0a0a !important;color:#fff !important}',
    'body.dark-mode #glraContact.is-open #glraContactFab{background:#f1eee9 !important;color:#0a0a0a !important;box-shadow:4px 4px 0 #ff3d00 !important}',
    '@media (hover:hover) and (pointer:fine){',
    '  #glraContact #glraContactFab:hover{transform:translate3d(-2px,-2px,0) !important;box-shadow:6px 6px 0 var(--gc-fab-shadow) !important}',
    '}',
    '#glraContact #glraContactFab:active{transform:translate3d(2px,2px,0) !important;box-shadow:1px 1px 0 var(--gc-fab-shadow) !important}',
    '#glraContact #glraContactFab:focus-visible,#glraContact .glra-contact-row:focus-visible,#glraContact .glra-contact-close:focus-visible{outline:3px solid #ff3d00 !important;outline-offset:3px !important}',
    /* the panel (desktop: popover above the button) */
    '#glraContact .glra-contact-panel{position:absolute;right:0;bottom:calc(100% + 14px);width:330px;max-width:calc(100vw - 36px);max-height:calc(100vh - 150px);overflow:auto;',
    '  background:var(--gc-paper);color:var(--gc-ink);border:2px solid var(--gc-line);box-shadow:6px 6px 0 var(--gc-shadow);',
    '  opacity:0;transform:translate3d(0,8px,0);transform-origin:100% 100%;transition:opacity 200ms cubic-bezier(.2,.7,.2,1),transform 200ms cubic-bezier(.2,.7,.2,1);overscroll-behavior:contain}',
    'body.dark-mode #glraContact .glra-contact-panel{border-color:#3a3a36}',
    '#glraContact .glra-contact-panel[hidden]{display:none !important}',
    '#glraContact.is-open .glra-contact-panel{opacity:1;transform:none}',
    '#glraContact .glra-contact-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px 12px;border-bottom:2px solid var(--gc-line)}',
    '#glraContact .glra-contact-eyebrow{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--gc-hot-text);margin-bottom:5px}',
    '#glraContact .glra-contact-title{font-family:"Inter","Segoe UI",sans-serif;font-size:19px;font-weight:900;letter-spacing:-.5px;text-transform:uppercase;line-height:1;color:var(--gc-ink)}',
    '#glraContact .glra-contact-sub{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--gc-gray);margin-top:6px}',
    '#glraContact .glra-contact-close{display:none !important;flex:0 0 44px !important;width:44px !important;height:44px !important;min-height:44px !important;padding:0 !important;margin:-6px -8px 0 0 !important;',
    '  align-items:center !important;justify-content:center !important;background:transparent !important;color:var(--gc-ink) !important;border:2px solid var(--gc-line) !important;',
    '  box-shadow:none !important;font-size:16px !important;letter-spacing:0 !important;cursor:pointer !important;transform:none !important}',
    '#glraContact .glra-contact-list{display:flex;flex-direction:column}',
    '#glraContact .glra-contact-row{display:flex !important;align-items:center !important;gap:12px !important;width:100% !important;min-height:52px !important;height:auto !important;',
    '  padding:8px 14px 8px 12px !important;margin:0 !important;background:transparent !important;color:var(--gc-ink) !important;',
    '  border:0 !important;border-top:1px solid var(--gc-line) !important;border-radius:0 !important;box-shadow:none !important;',
    '  font-family:"Inter","Segoe UI",sans-serif !important;font-size:14px !important;font-weight:700 !important;letter-spacing:-.1px !important;text-transform:none !important;',
    '  text-align:left !important;text-decoration:none !important;cursor:pointer !important;transform:none !important;',
    '  transition:background-color 170ms ease,color 170ms ease !important;touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
    '#glraContact .glra-contact-list > .glra-contact-row:first-child{border-top:0 !important}',
    '#glraContact .glra-contact-row[hidden]{display:none !important}',
    '#glraContact .glra-contact-ico{flex:0 0 34px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--gc-line);font-size:15px;color:var(--gc-ink);background:transparent;transition:background-color 170ms ease,color 170ms ease,border-color 170ms ease}',
    '#glraContact .glra-contact-row.is-primary .glra-contact-ico{background:var(--gc-hot-btn);border-color:var(--gc-hot-btn);color:#fff}',
    '#glraContact .glra-contact-lbl{flex:1 1 auto;min-width:0}',
    '#glraContact .glra-contact-meta{flex:0 0 auto;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:var(--gc-gray);transition:color 170ms ease}',
    '#glraContact .glra-contact-go{flex:0 0 auto;font-size:14px;line-height:1;opacity:.55;transition:transform 170ms cubic-bezier(.23,1,.32,1),opacity 170ms ease}',
    '#glraContact .glra-contact-row.is-ai{border-top:2px solid var(--gc-line) !important}',
    '#glraContact .glra-contact-row.is-ai .glra-contact-ico{background:var(--gc-ink);border-color:var(--gc-ink);color:var(--gc-paper)}',
    '#glraContact .glra-contact-row:hover,#glraContact .glra-contact-row:focus-visible{background:var(--gc-ink) !important;color:var(--gc-paper) !important}',
    '#glraContact .glra-contact-row:hover .glra-contact-ico,#glraContact .glra-contact-row:focus-visible .glra-contact-ico{border-color:var(--gc-paper);color:var(--gc-paper)}',
    '#glraContact .glra-contact-row.is-primary:hover .glra-contact-ico,#glraContact .glra-contact-row.is-ai:hover .glra-contact-ico{border-color:var(--gc-paper)}',
    '#glraContact .glra-contact-row:hover .glra-contact-meta,#glraContact .glra-contact-row:focus-visible .glra-contact-meta{color:var(--gc-paper)}',
    '#glraContact .glra-contact-row:hover .glra-contact-go{transform:translate3d(3px,0,0);opacity:1}',
    '#glraContact .glra-contact-row:focus-visible{outline-offset:-3px !important}',
    '#glraContact .glra-contact-scrim{display:none}',
    /* phones: a bottom sheet */
    '@media (max-width:600px){',
    '  #glraContact{right:14px;bottom:calc(var(--glra-dock,0px) + 14px + env(safe-area-inset-bottom,0px))}',
    '  #glraContact #glraContactFab{width:56px !important;height:56px !important;min-width:56px !important;padding:0 !important;gap:0 !important}',
    '  #glraContact #glraContactFab i{font-size:20px !important;width:auto}',
    '  #glraContact #glraContactFab .glra-contact-fab-lbl{position:absolute !important;width:1px !important;height:1px !important;overflow:hidden !important;clip:rect(0,0,0,0) !important;white-space:nowrap !important}',
    '  #glraContact .glra-contact-scrim{display:block;position:fixed;inset:0;background:rgba(10,10,10,.5);opacity:0;transition:opacity 240ms ease;z-index:0}',
    '  #glraContact .glra-contact-scrim[hidden]{display:none}',
    '  #glraContact.is-open .glra-contact-scrim{opacity:1}',
    '  #glraContact .glra-contact-panel{position:fixed;left:0;right:0;bottom:0;width:auto;max-width:none;max-height:86vh;z-index:1;',
    '    border-width:2px 0 0;box-shadow:0 -6px 0 rgba(10,10,10,.08);padding-bottom:env(safe-area-inset-bottom,0px);transform:translate3d(0,100%,0);opacity:1;',
    '    transition:transform 280ms cubic-bezier(.2,.7,.2,1)}',
    '  #glraContact.is-open .glra-contact-panel{transform:none}',
    '  #glraContact .glra-contact-head{padding:16px 16px 14px}',
    '  #glraContact .glra-contact-close{display:inline-flex !important}',
    '  #glraContact .glra-contact-row{min-height:56px !important;padding:10px 16px !important;font-size:16px !important}',
    '}',
    'html.glra-sheet-open,html.glra-sheet-open body{overflow:hidden !important}',

    /* ── Back to top: after two screens, stacked above the contact button ── */
    'html body #backToTop.back-to-top{position:fixed !important;left:auto !important;top:auto !important;right:18px !important;',
    '  bottom:calc(var(--glra-dock,0px) + 18px + 52px + 12px) !important;width:44px !important;height:44px !important;min-width:44px !important;min-height:44px !important;',
    '  display:flex !important;align-items:center !important;justify-content:center !important;padding:0 !important;',
    '  background:#f1eee9 !important;color:#0a0a0a !important;border:2px solid #0a0a0a !important;border-radius:0 !important;box-shadow:3px 3px 0 #0a0a0a !important;',
    '  font-size:14px !important;text-decoration:none !important;z-index:999 !important;',
    '  opacity:0 !important;visibility:hidden !important;pointer-events:none !important;transform:translate3d(0,10px,0) !important;',
    '  transition:opacity 240ms ease,transform 240ms cubic-bezier(.2,.7,.2,1),visibility 0s linear 240ms,background-color 170ms ease,color 170ms ease !important}',
    'body.dark-mode #backToTop.back-to-top{background:#0e0e0c !important;color:#f1eee9 !important;border-color:#f1eee9 !important;box-shadow:3px 3px 0 #ff3d00 !important}',
    'html body #backToTop.back-to-top.glra-btt-on{opacity:1 !important;visibility:visible !important;pointer-events:auto !important;transform:none !important;transition-delay:0s !important}',
    'html.glra-contact-open body #backToTop.back-to-top,html.glra-chat-open body #backToTop.back-to-top{opacity:0 !important;visibility:hidden !important;pointer-events:none !important}',
    'html.glra-pgbar-on body #backToTop.back-to-top{bottom:calc(var(--glra-dock,0px) + 14px) !important}',
    '@media (hover:hover) and (pointer:fine){html body #backToTop.back-to-top.glra-btt-on:hover{background:#0a0a0a !important;color:#fff !important}',
    '  body.dark-mode #backToTop.back-to-top.glra-btt-on:hover{background:#f1eee9 !important;color:#0a0a0a !important}}',
    '@media (max-width:600px){html body #backToTop.back-to-top{right:20px !important;bottom:calc(var(--glra-dock,0px) + 14px + 56px + 12px + env(safe-area-inset-bottom,0px)) !important}}',
    /* toasts clear the button */
    'html body .toast{bottom:calc(var(--glra-dock,0px) + 90px) !important}',
    '@media (max-width:600px){html body .toast{bottom:calc(var(--glra-dock,0px) + 86px) !important;max-width:calc(100vw - 32px)}}',

    /* ── Theme toggle in the navigation ── */
    'html body button.glra-theme-toggle{display:inline-flex !important;align-items:center !important;justify-content:center !important;align-self:stretch !important;',
    '  width:48px !important;min-width:48px !important;min-height:42px !important;height:auto !important;padding:0 !important;margin:0 !important;',
    '  background:transparent !important;color:var(--ab-ink,var(--ink,#0a0a0a)) !important;',
    '  border:0 !important;border-left:1px solid var(--ab-line,var(--line,#0a0a0a)) !important;border-radius:0 !important;box-shadow:none !important;',
    '  font-size:15px !important;letter-spacing:0 !important;text-transform:none !important;cursor:pointer !important;transform:none !important;',
    '  transition:background-color 170ms ease,color 170ms ease !important}',
    'html body button.glra-theme-toggle i{pointer-events:none;transition:transform 400ms cubic-bezier(.2,.7,.2,1)}',
    'html body button.glra-theme-toggle:hover{background:var(--ab-ink,var(--ink,#0a0a0a)) !important;color:var(--ab-paper,var(--paper,#f1eee9)) !important}',
    'html body button.glra-theme-toggle:hover i{transform:rotate(-20deg)}',
    'html body button.glra-theme-toggle:focus-visible{outline:3px solid #ff3d00 !important;outline-offset:-3px !important}',
    /* the listing page nav is two boxed links, so the toggle is boxed to match */
    'html body button.glra-theme-toggle.is-boxed{align-self:center !important;width:44px !important;min-width:44px !important;height:44px !important;min-height:44px !important;',
    '  margin:0 10px 0 auto !important;border:2px solid var(--line,#0a0a0a) !important;color:var(--ink,#0a0a0a) !important}',
    'html body button.glra-theme-toggle.is-boxed:hover{background:var(--ink,#0a0a0a) !important;color:var(--paper,#f1eee9) !important}',
    '@media (max-width:980px){html body .nav-links > button.glra-theme-toggle,html body .ab-nav-links > button.glra-theme-toggle{display:none !important}}',
    /* the row at the top of the mobile menu (the menu is always an ink panel) */
    'html body .mobile-overlay button.glra-theme-row{display:flex !important;align-items:center !important;gap:12px !important;width:100% !important;min-height:52px !important;height:auto !important;',
    '  margin:0 0 6px !important;padding:12px 14px !important;background:transparent !important;color:#f1eee9 !important;',
    '  border:1px solid rgba(241,238,233,.3) !important;border-radius:0 !important;box-shadow:none !important;cursor:pointer !important;transform:none !important;',
    '  font-family:"JetBrains Mono",ui-monospace,monospace !important;font-size:12px !important;font-weight:700 !important;letter-spacing:2px !important;text-transform:uppercase !important;text-align:left !important;',
    '  transition:background-color 170ms ease,border-color 170ms ease !important}',
    'html body .mobile-overlay button.glra-theme-row i{font-size:15px;width:18px;text-align:center;color:#ff3d00}',
    'html body .mobile-overlay button.glra-theme-row .glra-theme-row-lbl{flex:1 1 auto}',
    'html body .mobile-overlay button.glra-theme-row .glra-theme-row-state{padding:4px 8px;border:1px solid rgba(241,238,233,.45);font-size:10px;letter-spacing:1.5px;color:#f1eee9}',
    'html body .mobile-overlay button.glra-theme-row[aria-pressed="true"] .glra-theme-row-state{background:#ff3d00;border-color:#ff3d00;color:#0a0a0a}',
    'html body .mobile-overlay button.glra-theme-row:hover{border-color:#ff3d00 !important;background:rgba(241,238,233,.06) !important}',
    'html body .mobile-overlay button.glra-theme-row:focus-visible{outline:3px solid #ff3d00 !important;outline-offset:2px !important}',

    /* ── Image loading: tinted shimmer, then a fade ── */
    'html body .glra-ph.glra-ph{background-color:#e8e4dd !important;background-image:linear-gradient(100deg,rgba(255,255,255,0) 30%,rgba(255,255,255,.5) 50%,rgba(255,255,255,0) 70%) !important;',
    /* transition:none - styles.css eases every background-color over .35s
       (for the dark-mode switch), which would fade a black box INTO the tint */
    '  background-size:220% 100% !important;background-repeat:no-repeat !important;animation:glraShimmer 1.6s ease-in-out infinite;transition:none !important}',
    'body.dark-mode .glra-ph.glra-ph{background-color:#1a1a17 !important;background-image:linear-gradient(100deg,rgba(241,238,233,0) 30%,rgba(241,238,233,.07) 50%,rgba(241,238,233,0) 70%) !important}',
    '@keyframes glraShimmer{from{background-position:130% 0}to{background-position:-130% 0}}',
    'html body img.glra-img-wait{opacity:0 !important}',
    'html body img.glra-img-in{animation:glraImgIn 300ms cubic-bezier(.2,.7,.2,1) both}',
    '@keyframes glraImgIn{from{opacity:0}to{opacity:1}}',

    /* ── Motion safety ── */
    '@media (prefers-reduced-motion:reduce){',
    '  #glraContact,#glraContact *,#backToTop,html body button.glra-theme-toggle,html body button.glra-theme-toggle i{transition:none !important;animation:none !important}',
    '  html body #backToTop.back-to-top{transform:none !important}',
    '  html body .glra-ph.glra-ph{animation:none !important;background-image:none !important}',
    '  html body img.glra-img-in{animation:none !important}',
    '}',
    '@media print{#glraContact,#backToTop,.glra-theme-toggle,.glra-theme-row{display:none !important}}',
    /* the old stack stays in the DOM (inline scripts may look for its
       dark-mode button) but is never shown */
    'html body .floating-buttons.glra-legacy-fab{display:none !important}'
  ].join('\n');
  var s = document.createElement('style');
  s.id = 'glraShellStyle';
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
})();

(function glraShell() {
  if (typeof document === 'undefined') return;
  var PATH = (location.pathname || '').toLowerCase();
  if (PATH.indexOf('/admin') === 0 || PATH.indexOf('/agent') === 0) return;

  var html = document.documentElement;
  var mqRM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var mqSheet = window.matchMedia ? window.matchMedia('(max-width: 600px)') : { matches: false };
  function RM() { return !!mqRM.matches; }
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  // Next animation frame, or ~120ms later if frames are not being produced
  // (a background tab): whichever comes first, and only once.
  function frame(fn) {
    var done = false;
    var run = function () { if (!done) { done = true; fn(); } };
    requestAnimationFrame(run);
    setTimeout(run, 120);
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /* ── 1. THEME TOGGLES ─────────────────────────────────────────────────
     Moved out of the floating stack into the navigation. Idempotent:
     brutalist-shell.js rebuilds the inner pages' nav and mobile menu after
     this first runs, so it calls this again once it has. */
  // The Arthaland presentation pages are dark by design and hide the toggle.
  var NO_TOGGLE = ['data-arth', 'data-eluria', 'data-liv', 'data-lucima', 'data-sondris', 'data-una', 'data-no-theme-toggle'];
  function themeAllowed() {
    for (var i = 0; i < NO_TOGGLE.length; i++) if (html.hasAttribute(NO_TOGGLE[i])) return false;
    return typeof window.toggleDarkMode === 'function';
  }
  function onThemeClick(e) {
    e.preventDefault();
    window.toggleDarkMode();
  }
  function makeToggle(cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'glra-theme-toggle' + (cls ? ' ' + cls : '');
    b.setAttribute('aria-label', 'Dark mode');
    b.setAttribute('title', 'Dark mode');
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<i class="fas fa-moon" aria-hidden="true"></i>';
    b.addEventListener('click', onThemeClick);
    return b;
  }
  window.glraMountThemeToggles = function () {
    if (!document.body || !themeAllowed()) return;
    // Desktop nav: before the orange call-to-action at the end of the links.
    var bars = document.querySelectorAll('nav.navbar:not([aria-hidden="true"]) .nav-links, .ab-nav-links');
    Array.prototype.forEach.call(bars, function (links) {
      if (links.querySelector('.glra-theme-toggle')) return;
      var cta = links.querySelector(':scope > .contact-btn-nav, :scope > a.cta, :scope > .ab-nav-mobile-btn');
      links.insertBefore(makeToggle(''), cta || null);
    });
    // The listing pages built by server.js have a two-link nav of their own.
    var pg = document.querySelector('.pg-nav');
    if (pg && !pg.querySelector('.glra-theme-toggle')) {
      pg.insertBefore(makeToggle('is-boxed'), pg.querySelector('.pg-back'));
    }
    // Mobile menu: a labelled row at the very top, above the first section.
    var ov = document.querySelector('#mobileOverlay .mobile-overlay-links, .mobile-overlay .mobile-overlay-links');
    if (ov && !ov.querySelector('.glra-theme-row')) {
      var r = document.createElement('button');
      r.type = 'button';
      r.className = 'glra-theme-row';
      r.setAttribute('aria-pressed', 'false');
      r.innerHTML = '<i class="fas fa-moon" aria-hidden="true"></i><span class="glra-theme-row-lbl">Dark mode</span><span class="glra-theme-row-state">Off</span>';
      r.addEventListener('click', onThemeClick);
      ov.insertBefore(r, ov.firstChild);
    }
    glraSyncThemeToggles();
  };
  ready(window.glraMountThemeToggles);
  window.addEventListener('load', window.glraMountThemeToggles);

  /* ── 1b. TOOLS MENU: one list for every page ───────────────────────────
     The home page's nav (index.html), the inner pages' nav (brutalist-shell.js)
     and both phone menus each kept their own copy, so the home page showed 11
     of the 19 tools. The nav HTML keeps its plain links for crawlers; this
     swaps them for the grouped four-column menu (groups as on tools.html). */
  var GLRA_TOOL_GROUPS = [
    ['For buyers', 'fa-house', [
      ['/affordability.html', 'Affordability'],
      ['/amortization.html', 'Home loan calculator'],
      ['/pagibig-loanable.html', 'Pag-IBIG loanable amount'],
      ['/pre-selling.html', 'Pre-selling payment schedule'],
      ['/savings-goal.html', 'Savings planner'],
      ['/cost-of-ownership.html', 'True cost of ownership']]],
    ['For sellers & owners', 'fa-tags', [
      ['/valuation.html', 'What’s my property worth?'],
      ['/calculator.html', 'Closing fees & net proceeds'],
      ['/estate-tax.html', 'Estate tax'],
      ['/principal-residence.html', 'Principal residence exemption'],
      ['/bir-deadlines.html', 'BIR deadlines']]],
    ['For investors', 'fa-chart-line', [
      ['/rental-yield.html', 'Rental yield & ROI'],
      ['/rent-vs-buy.html', 'Rent vs buy'],
      ['/rental-income-tax.html', 'Rental income tax'],
      ['/lease-escalation.html', 'Lease escalation']]],
    ['Reference', 'fa-book-open', [
      ['/zonal.html', 'BIR zonal value lookup'],
      ['/property-tax.html', 'Real property tax (amilyar)'],
      ['/ercf.html', 'Registration fee (ERCF)'],
      ['/vat-exemption.html', 'VAT exemption check']]]
  ];
  var MEGA_CSS =
    '.glra-mega-host{position:static !important}' +
    '.glra-mega-anchor{position:relative !important}' +
    'html body .glra-mega{display:none !important;position:absolute !important;top:100% !important;right:0 !important;left:auto !important;' +
    'width:min(980px,calc(100vw - 32px)) !important;min-width:0 !important;max-height:calc(100vh - 140px);overflow:auto;' +
    'grid-template-columns:repeat(4,minmax(0,1fr)) !important;gap:0 !important;padding:0 !important;' +
    'background:var(--ab-paper,#f1eee9) !important;border:2px solid var(--ab-line,#0a0a0a) !important;box-shadow:6px 6px 0 var(--ab-line,#0a0a0a) !important;z-index:1200 !important;flex-direction:row !important}' +
    'html body .glra-mega::before{content:"";position:absolute;left:0;right:0;top:-26px;height:26px}' +
    'html body .glra-mega-host:hover > .glra-mega,html body .glra-mega-host.ab-open > .glra-mega,html body .glra-mega-host:focus-within > .glra-mega{display:grid !important}' +
    '.glra-mega-col{padding:20px 20px 18px;border-right:1px solid var(--ab-line,#0a0a0a);min-width:0}' +
    '.glra-mega-col:nth-child(4){border-right:0}' +
    '.glra-mega-h{display:flex;align-items:center;gap:8px;font:700 10.5px/1.2 "JetBrains Mono",monospace;letter-spacing:1.6px;text-transform:uppercase;color:var(--ab-hot-text,#c02e00);margin:0 0 12px;padding-bottom:10px;border-bottom:2px solid var(--ab-line,#0a0a0a)}' +
    'html body .glra-mega .glra-mega-col a{display:block !important;padding:8px 0 !important;border:0 !important;background:none !important;color:var(--ab-ink,#0a0a0a) !important;' +
    'font:600 13.5px/1.35 Inter,system-ui,sans-serif !important;letter-spacing:0 !important;text-transform:none !important;white-space:normal !important;height:auto !important}' +
    'html body .glra-mega .glra-mega-col a:hover,html body .glra-mega .glra-mega-col a:focus-visible{color:var(--ab-hot-text,#c02e00) !important;text-decoration:underline !important;text-underline-offset:3px}' +
    'html body .glra-mega .glra-mega-col a.is-here{color:var(--ab-hot-text,#c02e00) !important}' +
    '.glra-mega-foot{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-top:2px solid var(--ab-line,#0a0a0a);background:var(--ab-paper-2,#e8e4dd)}' +
    '.glra-mega-foot span{font-size:13px;color:var(--ab-ink,#0a0a0a);font-family:Inter,system-ui,sans-serif}' +
    'html body .glra-mega .glra-mega-foot a{display:inline-flex !important;align-items:center !important;gap:8px !important;padding:10px 16px !important;border:0 !important;background:#df3500 !important;color:#fff !important;' +
    'font:700 11px/1 "JetBrains Mono",monospace !important;letter-spacing:1.4px !important;text-transform:uppercase !important;height:auto !important}' +
    'html body .glra-mega .glra-mega-foot a:hover{background:#0a0a0a !important}' +
    '@media(max-width:1100px){html body .glra-mega{grid-template-columns:repeat(2,minmax(0,1fr)) !important}.glra-mega-col:nth-child(2){border-right:0}.glra-mega-col:nth-child(-n+2){border-bottom:1px solid var(--ab-line,#0a0a0a)}}' +
    '.mo-sub{font:700 9.5px/1 "JetBrains Mono",monospace;letter-spacing:1.6px;text-transform:uppercase;color:rgba(241,238,233,.55);padding:14px 4px 4px}';
  function toolsMenuHtml(here) {
    function link(t) {
      return '<a href="' + t[0] + '"' + (t[0] === here ? ' class="is-here" aria-current="page"' : '') + '>' + escapeHtml(t[1]) + '</a>';
    }
    return GLRA_TOOL_GROUPS.map(function (g) {
      return '<div class="glra-mega-col"><p class="glra-mega-h"><i class="fas ' + g[1] + '" aria-hidden="true"></i>' + escapeHtml(g[0]) + '</p>' + g[2].map(link).join('') + '</div>';
    }).join('') +
      '<div class="glra-mega-foot"><span>19 free calculators and lookups, built for Philippine property.</span><a href="/tools.html">See all tools <i class="fas fa-arrow-right" aria-hidden="true"></i></a></div>';
  }
  window.glraBuildToolsMenu = function () {
    if (!document.body) return;
    if (!document.getElementById('glraMegaCss')) {
      var st = document.createElement('style');
      st.id = 'glraMegaCss';
      st.textContent = MEGA_CSS;
      document.head.appendChild(st);
    }
    var here = location.pathname.replace(/\/$/, '') || '/';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-dropdown, .ab-nav-dropdown'), function (dd) {
      var trigger = dd.firstElementChild;
      var menu = dd.querySelector('.nav-dropdown-menu, .ab-nav-dropdown-menu');
      if (!trigger || !menu || !/^\s*tools/i.test(trigger.textContent || '')) return;
      if (menu.classList.contains('glra-mega')) return;
      menu.classList.add('glra-mega');
      menu.innerHTML = toolsMenuHtml(here);
      dd.classList.add('glra-mega-host');
      /* The menu hangs from the whole link row, so it lines up with the
         right edge of the nav instead of spilling off the screen. */
      if (dd.parentElement) dd.parentElement.classList.add('glra-mega-anchor');
    });
    /* Phone menu: every tool, under the same four headings. */
    Array.prototype.forEach.call(document.querySelectorAll('.mobile-overlay-links .mo-label'), function (lbl) {
      if (!/tools/i.test(lbl.textContent || '') || lbl.getAttribute('data-glra-tools')) return;
      lbl.setAttribute('data-glra-tools', '1');
      var n = lbl.nextElementSibling;
      while (n && !n.classList.contains('mo-label')) { var next = n.nextElementSibling; if (n.tagName === 'A') n.remove(); n = next; }
      var html = '<a href="/tools.html" onclick="closeMobileMenu()">All tools &amp; calculators</a>' +
        GLRA_TOOL_GROUPS.map(function (g) {
          return '<div class="mo-sub">' + escapeHtml(g[0]) + '</div>' + g[2].map(function (t) {
            return '<a href="' + t[0] + '" onclick="closeMobileMenu()"' + (t[0] === here ? ' class="gl-active"' : '') + '>' + escapeHtml(t[1]) + '</a>';
          }).join('');
        }).join('');
      lbl.insertAdjacentHTML('afterend', html);
    });
  };
  ready(window.glraBuildToolsMenu);
  window.addEventListener('load', window.glraBuildToolsMenu);

  /* ── 2. DOCK: bottom bars the floating controls must clear ─────────────
     .pg-bar is the listing page's phone contact bar; it replaces the
     contact button outright. .compare-bar (properties.html) only lifts it. */
  var dockQueued = false;
  function measureDock() {
    dockQueued = false;
    var h = 0, pgOn = false;
    var pg = document.querySelector('.pg-bar');
    if (pg && visible(pg)) { pgOn = true; h = Math.max(h, pg.getBoundingClientRect().height); }
    // Desktop listing pages: the sticky price card already carries the contact
    // buttons, so the floating one would be a duplicate.
    var side = document.querySelector('.pg-side');
    if (side && visible(side)) pgOn = true;
    var cb = document.querySelector('.compare-bar');
    if (cb && visible(cb)) h = Math.max(h, cb.getBoundingClientRect().height);
    html.style.setProperty('--glra-dock', Math.round(h) + 'px');
    html.classList.toggle('glra-pgbar-on', pgOn);
    if (pgOn && contact && contact.isOpen()) contact.close(false);
  }
  function queueDock() { if (!dockQueued) { dockQueued = true; frame(measureDock); } }

  /* ── 3. ONE CONTACT BUTTON ────────────────────────────────────────────
     Replaces the six-button stack (call, WhatsApp, Viber, Messenger,
     Instagram, dark mode) and the chatbot's own bottom-left launcher with a
     single button and a labelled panel. The rows reuse the page's own link
     hrefs; channels a page was missing are filled in with the same hrefs
     every other page uses, so the panel is identical everywhere. */
  var CANON = {
    call: { href: 'tel:+639171774572' },
    whatsapp: { href: 'https://wa.me/639171774572', blank: true },
    viber: { href: 'viber://chat?number=%2B639171774572' },
    messenger: { href: 'https://m.me/glrarealty', blank: true },
    instagram: { href: 'https://instagram.com/glra_realty', blank: true }
  };
  var ORDER = ['call', 'whatsapp', 'viber', 'messenger', 'instagram'];
  var ICON = { call: 'fas fa-phone-alt', whatsapp: 'fab fa-whatsapp', viber: 'fab fa-viber', messenger: 'fab fa-facebook-messenger', instagram: 'fab fa-instagram' };

  function phoneLabel(href) {
    var d = String(href).replace(/\D/g, '');
    if (d.indexOf('63') === 0 && d.length === 12) d = '0' + d.slice(2);
    return d.length === 11 ? d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7) : d;
  }
  function kindOf(a) {
    var c = ' ' + (a.className || '') + ' ', h = a.getAttribute('href') || '';
    if (/ btn-call /.test(c) || h.indexOf('tel:') === 0) return 'call';
    if (/ btn-whatsapp /.test(c) || h.indexOf('wa.me') !== -1) return 'whatsapp';
    if (/ btn-viber /.test(c) || h.indexOf('viber:') === 0) return 'viber';
    if (/ btn-messenger /.test(c) || h.indexOf('m.me') !== -1) return 'messenger';
    if (/ btn-instagram /.test(c) || h.indexOf('instagram.com') !== -1) return 'instagram';
    return null;
  }

  var contact = null;

  function buildContact() {
    var legacy = document.querySelector('.floating-buttons');
    if (!legacy || document.getElementById('glraContact')) return;

    // Collect the page's own links.
    var links = {};
    Array.prototype.forEach.call(legacy.querySelectorAll('a[href]'), function (a) {
      var k = kindOf(a);
      if (k && !links[k]) links[k] = { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') };
    });
    // A listing page's bar carries a WhatsApp message that names the listing.
    var pgWa = document.querySelector('.pg-bar a[href*="wa.me"]');
    if (pgWa) links.whatsapp = { href: pgWa.getAttribute('href'), target: '_blank', rel: 'noopener' };

    legacy.classList.add('glra-legacy-fab');
    legacy.setAttribute('hidden', '');
    legacy.setAttribute('aria-hidden', 'true');

    var root = document.createElement('div');
    root.id = 'glraContact';
    root.className = 'glra-contact';

    var scrim = document.createElement('div');
    scrim.className = 'glra-contact-scrim';
    scrim.hidden = true;

    var panel = document.createElement('div');
    panel.id = 'glraContactPanel';
    panel.className = 'glra-contact-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'glraContactTitle');
    panel.hidden = true;
    panel.innerHTML =
      '<div class="glra-contact-head">' +
        '<div><div class="glra-contact-eyebrow">// Contact</div>' +
        '<div class="glra-contact-title" id="glraContactTitle">Talk to Catherine</div>' +
        '<div class="glra-contact-sub">Licensed real estate broker</div></div>' +
        '<button type="button" class="glra-contact-close" aria-label="Close contact options"><i class="fas fa-times" aria-hidden="true"></i></button>' +
      '</div>' +
      '<div class="glra-contact-list"></div>';
    var list = panel.querySelector('.glra-contact-list');

    ORDER.forEach(function (k) {
      var l = links[k] || { href: CANON[k].href, target: CANON[k].blank ? '_blank' : null, rel: CANON[k].blank ? 'noopener' : null };
      var a = document.createElement('a');
      a.className = 'glra-contact-row' + (k === 'call' ? ' is-primary' : '');
      a.href = l.href;
      if (l.target) a.target = l.target;
      if (l.rel) a.rel = l.rel;
      if (k === 'whatsapp') a.setAttribute('data-glra-wa', '');
      var label, meta;
      if (k === 'call') { label = 'Call ' + phoneLabel(l.href); meta = ''; }
      else if (k === 'whatsapp') { label = 'WhatsApp'; meta = 'Message'; }
      else if (k === 'viber') { label = 'Viber'; meta = 'Message'; }
      else if (k === 'messenger') { label = 'Messenger'; meta = 'Facebook'; }
      else { label = 'Instagram'; meta = '@' + (String(l.href).split('instagram.com/')[1] || 'glra_realty').replace(/[/?#].*$/, ''); }
      a.innerHTML = '<span class="glra-contact-ico"><i class="' + ICON[k] + '" aria-hidden="true"></i></span>' +
        '<span class="glra-contact-lbl">' + label + '</span>' +
        (meta ? '<span class="glra-contact-meta">' + meta + '</span>' : '') +
        '<span class="glra-contact-go" aria-hidden="true">&rarr;</span>';
      if (l.target === '_blank') a.setAttribute('aria-label', label + ' (opens in a new tab)');
      list.appendChild(a);
    });

    var ai = document.createElement('button');
    ai.type = 'button';
    ai.className = 'glra-contact-row is-ai';
    ai.innerHTML = '<span class="glra-contact-ico"><i class="fas fa-robot" aria-hidden="true"></i></span>' +
      '<span class="glra-contact-lbl">Ask our assistant</span><span class="glra-contact-meta">AI</span>' +
      '<span class="glra-contact-go" aria-hidden="true">&rarr;</span>';
    list.appendChild(ai);

    var fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'glraContactFab';
    fab.className = 'glra-contact-fab';
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'glraContactPanel');
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-label', 'Contact us');
    fab.innerHTML = '<i class="fas fa-comment-dots" aria-hidden="true"></i><span class="glra-contact-fab-lbl">Contact</span>';

    root.appendChild(scrim);
    root.appendChild(fab);
    root.appendChild(panel);
    // Directly after the old stack, so the tab order is unchanged.
    legacy.parentNode.insertBefore(root, legacy.nextSibling);

    var open = false, sheet = false, hideTimer = 0;
    var closeBtn = panel.querySelector('.glra-contact-close');

    function focusables() {
      return Array.prototype.filter.call(panel.querySelectorAll('a[href],button:not([disabled])'), function (el) {
        return !el.hidden && (el.offsetWidth || el.offsetHeight);
      });
    }
    function setOpen(v) {
      open = v;
      root.classList.toggle('is-open', v);
      html.classList.toggle('glra-contact-open', v);
      html.classList.toggle('glra-sheet-open', v && sheet);
      fab.setAttribute('aria-expanded', v ? 'true' : 'false');
      fab.setAttribute('aria-label', v ? 'Close contact options' : 'Contact us');
      fab.innerHTML = v
        ? '<i class="fas fa-times" aria-hidden="true"></i><span class="glra-contact-fab-lbl">Close</span>'
        : '<i class="fas fa-comment-dots" aria-hidden="true"></i><span class="glra-contact-fab-lbl">Contact</span>';
    }
    function doOpen() {
      if (open) return;
      clearTimeout(hideTimer);
      sheet = !!mqSheet.matches;
      ai.hidden = typeof window.glraOpenChat !== 'function';
      if (sheet) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
      panel.hidden = false;
      scrim.hidden = !sheet;
      void panel.offsetWidth;            // commit the closed state so the entrance can run
      setOpen(true);
      var firstRow = panel.querySelector('.glra-contact-row:not([hidden])');
      if (firstRow) firstRow.focus({ preventScroll: true });
    }
    function doClose(returnFocus) {
      if (!open) return;
      setOpen(false);
      var done = function () { panel.hidden = true; scrim.hidden = true; };
      if (RM()) done(); else hideTimer = setTimeout(done, sheet ? 300 : 220);
      if (returnFocus) fab.focus({ preventScroll: true });
    }
    contact = { isOpen: function () { return open; }, close: doClose, open: doOpen, fab: fab };

    fab.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (open) doClose(true); else doOpen();
    });
    closeBtn.addEventListener('click', function () { doClose(true); });
    scrim.addEventListener('click', function () { doClose(true); });
    list.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a.glra-contact-row');
      if (a) setTimeout(function () { doClose(false); }, 0);
    });
    ai.addEventListener('click', function () {
      doClose(false);
      if (typeof window.glraOpenChat === 'function') window.glraOpenChat({ returnFocus: fab });
    });
    document.addEventListener('click', function (e) {
      if (open && !root.contains(e.target)) doClose(false);
    });
    document.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); doClose(true); return; }
      if (e.key === 'Tab' && sheet) {
        var f = focusables(); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    // A non-modal popover on desktop: tabbing away from it closes it.
    root.addEventListener('focusout', function (e) {
      if (!open || sheet) return;
      var to = e.relatedTarget;
      if (to && !root.contains(to)) doClose(false);
    });
    var onBreak = function () { if (open) doClose(false); };
    if (mqSheet.addEventListener) mqSheet.addEventListener('change', onBreak);
    else if (mqSheet.addListener) mqSheet.addListener(onBreak);
  }

  /* ── 4. BACK TO TOP ───────────────────────────────────────────────────
     Appears after two screen heights, never earlier, and sits above the
     contact button so the two can never overlap. The page's own `.show`
     toggles are left alone; the CSS above keys on .glra-btt-on only. */
  function setupBackToTop() {
    var b = document.getElementById('backToTop');
    if (!b) return;
    // Reads two cached numbers and flips one class: cheap enough to run on
    // every scroll event without a frame throttle.
    function update() {
      b.classList.toggle('glra-btt-on', window.scrollY > window.innerHeight * 2);
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
    b.addEventListener('click', function (e) {
      if (e.defaultPrevented) return;        // index.html scrolls it itself
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: RM() ? 'auto' : 'smooth' });
      if (e.detail === 0) {                  // keyboard: land focus at the top too
        var skip = document.querySelector('.skip-to-content');
        if (skip) skip.focus({ preventScroll: true });
      }
    });
  }

  ready(function () {
    buildContact();
    setupBackToTop();
    measureDock();
    window.addEventListener('resize', queueDock, { passive: true });
    var cb = document.querySelector('.compare-bar');
    if (cb && window.MutationObserver) {
      new MutationObserver(queueDock).observe(cb, { attributes: true, attributeFilter: ['class', 'style'] });
    }
  });

  /* ── 5. IMAGE LOADING POLISH ──────────────────────────────────────────
     While a content image loads, its box shows a tinted shimmer instead of
     an empty (often black) rectangle; once decoded it fades in over 300ms.
     - Already-loaded images are left completely alone.
     - Where the image fills its parent (every listing card), the shimmer
       goes on the parent and the image fades in over it: a true cross-fade.
     - Where it does not, the image paints the shimmer as its own background.
     - An image with no box yet gets no placeholder at all (inventing one
       would shift the layout); it just fades in.
     - index.html and properties.html lazy-load with a data: placeholder
       in src and the real URL in data-src; those count as still loading.
     Logos, icons, small images and the chat widget are skipped. */
  var MIN = 64;
  var SKIP_IN = '#loader, .loader, .glra-chat-panel, #glraContact, .navbar, .ab-nav, .pg-nav, .ar-nav, .logo, .ab-brand, footer, .print-only-header';
  function isPlaceholder(img) {
    var ds = img.getAttribute('data-src');
    return !!ds && img.getAttribute('src') !== ds;
  }
  function excluded(img) {
    if (img.hasAttribute('data-no-fade') || img.hasAttribute('data-logo-auto')) return true;
    var src = (img.getAttribute('src') || '') + ' ' + (img.getAttribute('data-src') || '');
    if (/logo|favicon|icon-\d|\.svg(\?|$)/i.test(src)) return true;
    if (img.closest && img.closest(SKIP_IN)) return true;
    var aw = parseInt(img.getAttribute('width'), 10), ah = parseInt(img.getAttribute('height'), 10);
    if (aw && ah && aw < MIN && ah < MIN) return true;
    var w = img.offsetWidth, h = img.offsetHeight;
    if (w && w < MIN) return true;
    if (w && h && h < 48) return true;
    return false;
  }
  function settle(img, host) {
    img.classList.remove('glra-img-wait', 'glra-ph');
    var clean = function () {
      img.classList.remove('glra-img-in');
      if (host) { host.classList.remove('glra-ph'); host.__glraHost = 0; }
    };
    if (RM() || !img.__glraFade) { clean(); return; }
    img.classList.add('glra-img-in');
    img.addEventListener('animationend', clean, { once: true });
    setTimeout(clean, 450);                // in case animations are suppressed
  }
  function prep(img) {
    if (img.__glraImg) return;
    img.__glraImg = 1;
    if (excluded(img)) return;
    var pending = isPlaceholder(img) || !img.complete;
    if (!pending) {                        // loaded (or already failed): leave it alone,
      img.classList.remove('glra-img-wait', 'glra-ph', 'glra-img-in');   // bar classes a
      var pp = img.parentElement;          // carousel clone may have copied from its original
      if (pp && !pp.__glraHost) pp.classList.remove('glra-ph');
      return;
    }
    var host = null, w = img.offsetWidth, h = img.offsetHeight;
    if (w >= MIN && h >= 48) {
      var p = img.parentElement;
      if (p && p !== document.body && Math.abs(p.clientWidth - w) <= 4 && Math.abs(p.clientHeight - h) <= 4) {
        host = p;
        host.__glraHost = 1;
        host.classList.add('glra-ph');
        img.classList.add('glra-img-wait');
        img.__glraFade = 1;
      } else {
        img.classList.add('glra-ph');      // shimmer on the image's own box
        img.__glraFade = 1;
      }
    } else {
      img.classList.add('glra-img-wait');  // no box to hold a placeholder
      img.__glraFade = 1;
    }
    var onLoad = function () {
      if (isPlaceholder(img)) return;      // the data: stand-in, not the photo
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onErr);
      settle(img, host);
    };
    var onErr = function () {
      if (isPlaceholder(img)) return;
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onErr);
      img.__glraFade = 0;
      settle(img, host);
    };
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onErr);
    // Finished between the check above and now? Settle straight away.
    if (!isPlaceholder(img) && img.complete) onLoad();
  }
  var queue = [], qPending = false;
  function flush() {
    qPending = false;
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) if (q[i].isConnected) prep(q[i]);
  }
  function enqueue(img) {
    if (img.__glraImg) return;
    queue.push(img);
    if (!qPending) { qPending = true; frame(flush); }
  }
  ready(function () {
    Array.prototype.forEach.call(document.images, enqueue);
    if (!window.MutationObserver) return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'IMG') enqueue(n);
          else if (n.getElementsByTagName) {
            var imgs = n.getElementsByTagName('img');
            for (var k = 0; k < imgs.length; k++) enqueue(imgs[k]);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  /* ── 6. VIEW TRANSITIONS ──────────────────────────────────────────────
     styles.css opts every page into cross-document view transitions (a
     quick root cross-fade). On the way to a listing page, the photo the
     visitor clicked is named `glra-hero`, and the listing page gives its
     main photo the same name, so the one morphs into the other. Names must
     be unique when the old page is captured, so any other element carrying
     it (a listing page's own hero, when going listing to listing) is
     cleared first. Browsers without support just navigate. */
  var HERO = 'glra-hero';
  var lastClick = null, named = [];
  document.addEventListener('click', function (e) { lastClick = { el: e.target, t: Date.now() }; }, true);

  function propId(url) {
    try {
      var m = new URL(url, location.href).pathname.match(/^\/property\/([^\/?#]+)/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  function inView(el) {
    var r = el.getBoundingClientRect();
    return r.width >= 80 && r.height >= 60 && r.bottom > 0 && r.right > 0 &&
           r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
  }
  function bestImg(scope) {
    var best = null, area = 0;
    Array.prototype.forEach.call(scope.querySelectorAll('img'), function (img) {
      if (/logo/i.test(img.getAttribute('src') || '') || !inView(img)) return;
      var r = img.getBoundingClientRect(), a = r.width * r.height;
      if (a > area) { area = a; best = img; }
    });
    return best;
  }
  function otherIds(scope, id) {
    return Array.prototype.some.call(scope.querySelectorAll('a[href*="/property/"]'), function (a) {
      var o = propId(a.getAttribute('href'));
      return o && o !== id;
    });
  }
  // The clicked element's nearest container that holds a photo and does not
  // also hold links to OTHER listings (which would mean we had climbed into
  // the whole grid). Falls back to any card linking to the same listing.
  function heroFor(id) {
    if (lastClick && Date.now() - lastClick.t < 8000 && lastClick.el && lastClick.el.isConnected) {
      var el = lastClick.el.nodeType === 1 ? lastClick.el : lastClick.el.parentElement;
      for (var d = 0; el && d < 7 && el !== document.body; d++, el = el.parentElement) {
        if (otherIds(el, id)) break;
        var img = bestImg(el);
        if (img) return img;
      }
    }
    var links = document.querySelectorAll('a[href*="/property/' + id + '"]');
    for (var i = 0; i < links.length; i++) {
      var card = links[i].closest('.prop-card, .pg-rel, .ar-card, article, li') || links[i];
      var im = bestImg(card);
      if (im) return im;
    }
    return null;
  }
  function clearHero() {
    named.forEach(function (el) { el.style.viewTransitionName = ''; });
    named = [];
  }
  function nameHero(img) {
    clearHero();
    // Anything else already carrying the name (the listing page's own hero).
    Array.prototype.forEach.call(document.querySelectorAll('img, [id*="Hero"], [class*="hero"]'), function (el) {
      if (el !== img && getComputedStyle(el).viewTransitionName === HERO) {
        el.style.viewTransitionName = 'none';
        named.push(el);
      }
    });
    img.style.viewTransitionName = HERO;
    named.push(img);
  }
  window.addEventListener('pageswap', function (e) {
    if (!e.viewTransition) return;
    var to = e.activation && e.activation.entry && e.activation.entry.url;
    var id = to && propId(to);
    if (!id || id === propId(location.href)) return;
    var img = heroFor(id);
    if (img) nameHero(img);
  });
  // Coming BACK from a listing, name the matching card's photo so the listing
  // photo morphs back into it. Best effort: cards rendered later than the
  // first frame (fetched listings on a fresh load) simply cross-fade.
  window.addEventListener('pagereveal', function (e) {
    if (!e.viewTransition) return;
    var act = window.navigation && window.navigation.activation;
    var from = act && act.from && act.from.url;
    var id = from && propId(from);
    if (id && id !== propId(location.href)) {
      var links = document.querySelectorAll('a[href*="/property/' + id + '"]');
      for (var i = 0; i < links.length; i++) {
        var card = links[i].closest('.prop-card, .pg-rel, .ar-card, article, li') || links[i];
        var im = bestImg(card);
        if (im) { nameHero(im); break; }
      }
    }
    e.viewTransition.finished.then(clearHero, clearHero);
  });
  // A page restored from the back/forward cache must not keep a stale name.
  window.addEventListener('pageshow', function (e) { if (e.persisted) clearHero(); });
})();
/* SITE-SHELL-END */

// ── Email-gated clean PDF DOWNLOAD (shared by all calculators) ──
// Usage: <button onclick="glraOpenPrintGate('Affordability Calculator')">Download PDF</button>
// Asks for an email (lead capture), then generates a real, clean, always-light
// PDF FILE and downloads it — works on phones (a true file, not a print dialog).
// Falls back to the browser print dialog only if the PDF library can't load.

// Lazy-load jsPDF (only when the user actually downloads).
let _glraJsPDFPromise = null;
function glraLoadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (_glraJsPDFPromise) return _glraJsPDFPromise;
  _glraJsPDFPromise = new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = resolve;
    s.onerror = function () { _glraJsPDFPromise = null; reject(new Error('jspdf-load-failed')); };
    document.head.appendChild(s);
  });
  return _glraJsPDFPromise;
}

// jsPDF's built-in fonts can't render ₱ or fancy dashes — swap for safe text.
function glraPdfText(s) {
  return String(s == null ? '' : s)
    .replace(/₱/g, 'PHP ')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, ' ')
    .trim();
}

// Pull label/value pairs from the calculator's inputs + results (works across
// all the calculators since they share these class names).
function glraCollectReport() {
  const out = { title: '', bottomTitle: document.title, inputs: [], results: [] };
  // .print-title is the current markup; the h1 fallback covers any page whose
  // letterhead hasn't been migrated yet.
  const hd = document.querySelector('.print-only-header .print-title, .print-only-header h1');
  out.title = (hd ? hd.textContent : (document.title || 'Report')).trim();

  // Inputs — the user's entries (all calculators wrap fields in .input-group;
  // the Pag-IBIG vs bank panels on amortization.html use .field)
  document.querySelectorAll('.input-group, .loan-panel .field').forEach(function (g) {
    if (g.offsetParent === null) return; // skip fields hidden by the page (inactive modes, N/A fields)
    const labelEl = g.querySelector('label');
    const ctrl = g.querySelector('input, select');
    if (!labelEl || !ctrl || ctrl.type === 'hidden') return;
    let val = ctrl.tagName === 'SELECT'
      ? ((ctrl.options[ctrl.selectedIndex] || {}).text || ctrl.value)
      : ctrl.value;
    val = (val == null ? '' : String(val)).trim();
    let label = labelEl.textContent.replace(/\s+/g, ' ').trim();
    if (label.length > 60) label = label.slice(0, 59) + '...';
    if (label && val) out.inputs.push([label, val]);
  });

  const seen = {};
  function add(label, value) {
    label = (label || '').replace(/\s+/g, ' ').trim();
    value = (value || '').replace(/\s+/g, ' ').trim();
    if (!label || !value) return;
    const k = label + '=' + value;
    if (seen[k]) return; seen[k] = 1;
    out.results.push([label, value]);
  }
  function pull(box) {
    const l = box.querySelector('.label, .tax-name, .summary-label, .lbl, .t');
    const v = box.querySelector('.value, .amount, .rate, .tax-amount, .amt, .n, .txt');
    if (l && v) add(l.textContent, v.textContent);
  }
  // Headline / summary boxes — some hold several .result-item children.
  document.querySelectorAll(
    '.result-headline, .result-summary, .headline-total, .yield-headline, .tax-total, ' +
    '.range-bar, .result-mini, .metric-mini, .metric, .summary-card, .desired-result, ' +
    '.est-headline, .est-mid, .verdict, .vs-card, .result-block .big, .winner-banner'
  ).forEach(function (box) {
    if (box.offsetParent === null) return; // skip result boxes hidden by the page
    const items = box.querySelectorAll('.result-item');
    if (items.length) { items.forEach(pull); return; }
    pull(box);
  });
  // Breakdown rows (.breakdown-row/.rrow are the newer tool pages' k/v rows)
  document.querySelectorAll('.fee-row, .cost-row, .amort-row, .rental-row, .breakdown-row, .rrow').forEach(function (el) {
    if (el.offsetParent === null) return; // skip rows hidden by the page
    const l = el.querySelector('.fee-label, .cost-label, .label, .k'), v = el.querySelector('.fee-value, .cost-value, .value, .v');
    if (l && v) add(l.textContent, v.textContent);
  });
  // Breakdown / component tables (registration-fee components, cost-of-ownership rows)
  document.querySelectorAll('.breakdown-table tbody tr, .factors-table tbody tr, .brackets-table tbody tr').forEach(function (tr) {
    const cells = tr.querySelectorAll('td');
    if (cells.length >= 2) add(cells[0].textContent, cells[cells.length - 1].textContent);
  });
  return out;
}

// Load + downscale an image to a PNG data URL for embedding in the PDF.
function glraLoadLogo(src, maxPx) {
  return new Promise(function (resolve) {
    const img = new Image();
    img.onload = function () {
      try {
        const sc = Math.min(maxPx / img.width, maxPx / img.height, 1);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * sc));
        c.height = Math.max(1, Math.round(img.height * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({ dataURL: c.toDataURL('image/png'), w: c.width, h: c.height });
      } catch (e) { resolve(null); }
    };
    img.onerror = function () { resolve(null); };
    img.src = src;
  });
}

async function glraBuildAndSavePDF(label, dataOverride) {
  const data = dataOverride || glraCollectReport();
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const Hh = doc.internal.pageSize.getHeight();
  const M = 48;
  let y = 50;

  // Letterhead — company logo centered, then tagline + contact.
  const logo = await glraLoadLogo('/img/logo-384.png', 320);
  if (logo) {
    const dispH = 96, dispW = dispH * (logo.w / logo.h);
    doc.addImage(logo.dataURL, 'PNG', (W - dispW) / 2, y, dispW, dispH);
    y += dispH + 8;
  } else {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.setTextColor(10, 10, 10);
    doc.text('GLRA REALTY', W / 2, y + 24, { align: 'center' });
    y += 42;
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110, 110, 110);
  doc.text('Licensed Real Estate Broker  -  Metro Manila & Luzon, Philippines', W / 2, y, { align: 'center' });
  doc.text('glrarealty.com     0917 177 4572     glrarealty@gmail.com', W / 2, y + 13, { align: 'center' });
  y += 26;
  doc.setDrawColor(255, 61, 0); doc.setLineWidth(2.5); doc.line(M, y, W - M, y);
  y += 30;

  // Report title + date. When data.bottomTitle is set the title is moved to the
  // FOOTER (closing-fees PDF), so only the date sits up here under the letterhead.
  if (data.bottomTitle) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(110, 110, 110);
    doc.text('Generated ' + new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }), M, y);
    y += 26;
  } else {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(10, 10, 10);
    doc.text(glraPdfText(data.title || label || 'Report'), M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(110, 110, 110);
    doc.text('Generated ' + new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }), M, y + 16);
    y += 40;
  }

  function section(heading, rows) {
    if (!rows || !rows.length) return;
    if (y > Hh - 130) { doc.addPage(); y = 58; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(255, 61, 0);
    doc.text(glraPdfText(heading).toUpperCase(), M, y); y += 8;
    doc.setDrawColor(10, 10, 10); doc.setLineWidth(0.8); doc.line(M, y, W - M, y); y += 18;
    rows.forEach(function (pair) {
      if (y > Hh - 70) { doc.addPage(); y = 58; }
      var value = glraPdfText(pair[1]);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(10, 10, 10);
      doc.text(value, W - M, y, { align: 'right' });
      var vw = doc.getTextWidth(value);
      // Wrap long labels (e.g. the city lists) so they never collide with the value.
      doc.setFont('helvetica', 'normal'); doc.setTextColor(90, 90, 90);
      var lines = doc.splitTextToSize(glraPdfText(pair[0]), Math.max(60, (W - 2 * M) - vw - 16));
      doc.text(lines, M, y);
      y += Math.max(19, lines.length * 13 + 5);
    });
    y += 16;
  }
  if (Array.isArray(data.sections) && data.sections.length) {
    data.sections.forEach(function (s) { section(s.heading, s.rows); });
  } else {
    section('Your Information', data.inputs);
    section('Results', data.results);
  }

  // Footer — optional document-title line at the very bottom, then the disclaimer.
  if (data.bottomTitle) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(10, 10, 10);
    doc.text(glraPdfText(data.bottomTitle), W / 2, Hh - 48, { align: 'center' });
  }
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
  doc.text('Estimates only - please verify with your broker or bank before deciding. Generated from glrarealty.com.',
    M, Hh - 34, { maxWidth: W - 2 * M });

  const fname = 'GLRA Realty - ' + String(label || 'Report').replace(/[^\w \-]/g, '') + '.pdf';
  doc.save(fname);
}

// ── Force LIGHT mode for any printout (Ctrl/Cmd+P AND our fallback print) ──
// Drops dark mode while printing so the sheet is always black-on-white, then
// restores it afterwards. (We deliberately do NOT touch document.title — blanking
// it makes Chrome stamp the page URL at the top of the page instead.)
(function () {
  if (typeof window === 'undefined') return;
  let saved = null;
  window.addEventListener('beforeprint', function () {
    const html = document.documentElement, body = document.body;
    saved = {
      dark: body.classList.contains('dark-mode'),
      darkPre: html.classList.contains('dark-mode-pre')
    };
    body.classList.remove('dark-mode');
    html.classList.remove('dark-mode-pre');
  });
  window.addEventListener('afterprint', function () {
    if (!saved) return;
    if (saved.dark) document.body.classList.add('dark-mode');
    if (saved.darkPre) document.documentElement.classList.add('dark-mode-pre');
    saved = null;
  });
})();

// Browser print — fallback only (if the PDF library can't load). The handler
// above already blanks the title + forces light for the printout.
function glraPrintFallback() {
  setTimeout(function () { window.print(); }, 150);
}

// Optional page-supplied collector — lets a page (e.g. calculator.html) feed its
// own inputs/results into the PDF instead of the generic auto-collector.
let _glraCollectOverride = null;
window.glraOpenPrintGate = function (label, collectFn) {
  let modal = document.getElementById('glraPrintGate');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'glraPrintGate';
    modal.className = 'glra-print-gate';
    modal.innerHTML = `
      <div class="glra-print-gate-card" role="dialog" aria-modal="true">
        <button class="glra-print-gate-close" type="button" aria-label="Close">&times;</button>
        <i class="fas fa-file-pdf"></i>
        <h3>Download Your PDF</h3>
        <p>Enter your email and we'll prepare a clean PDF copy of your results to download.</p>
        <input type="email" placeholder="Your email address" autocomplete="email" />
        <button class="glra-print-gate-submit" type="button">Download PDF</button>
        <p class="glra-print-gate-fine">We'll occasionally send new listings &amp; market insights. Unsubscribe anytime.</p>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector('input');
    const submit = modal.querySelector('.glra-print-gate-submit');
    const closeBtn = modal.querySelector('.glra-print-gate-close');
    const close = () => modal.classList.remove('show');
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit.click(); });
    submit.addEventListener('click', async () => {
      const email = (input.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (typeof showToast === 'function') showToast('Please enter a valid email address', true);
        return;
      }
      const orig = submit.innerHTML;
      submit.disabled = true;
      submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing...';
      // Lead capture — best-effort, never blocks the download.
      try {
        await fetch('/api/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, source: 'calculator_pdf' })
        });
      } catch (_) {}
      const lbl = modal.dataset.label || '';
      try {
        await glraLoadJsPDF();
        const customData = (typeof _glraCollectOverride === 'function') ? _glraCollectOverride() : null;
        await glraBuildAndSavePDF(lbl, customData);
        close();
        if (typeof showToast === 'function') showToast('Your PDF is downloading');
      } catch (e) {
        close();
        glraPrintFallback(lbl); // PDF library unavailable → clean light print
      } finally {
        submit.disabled = false;
        submit.innerHTML = orig;
      }
    });
  }
  modal.dataset.label = label || '';
  _glraCollectOverride = (typeof collectFn === 'function') ? collectFn : null;
  modal.querySelector('input').value = '';
  modal.classList.add('show');
  setTimeout(() => modal.querySelector('input').focus(), 50);
};

/* ============================================
   CALCULATOR / TOOL USAGE TRACKING
   ============================================
   Answers "which calculators does this subscriber actually use, and how often"
   inside the admin Subscribers tab.

   How it works, in short:
     1. Each browser gets a random id ("vid") in localStorage. On its own it
        names nobody — it is not built from IP, cookies, or fingerprinting.
     2. When someone genuinely USES a calculator (changes an input — not merely
        loads the page) we log one row against that vid.
     3. The moment they enter their email anywhere on the site, the server ties
        every past row from that browser to them. That is why the admin can show
        what a subscriber did BEFORE they ever signed up.

   Visitors can opt out entirely with:  localStorage.glra_no_track = '1'
   Everything here is best-effort and silent: tracking must never break a page.
   ============================================ */
/* CALC-TRACKING-START */
(function glraCalcTracking() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // filename -> [stable slug, human label]. Labels match the PDF-gate names so
  // the admin reads the same words the visitor saw.
  var TOOLS = {
    'affordability.html':     ['affordability',     'Affordability Calculator'],
    'amortization.html':      ['amortization',      'Home Loan Calculator'],
    'calculator.html':        ['closing-fees',      'Sales Closing Fees Calculator'],
    'cost-of-ownership.html': ['cost-of-ownership', 'Cost of Ownership Calculator'],
    'ercf.html':              ['ercf',              'Registration Fee Calculator'],
    'estate-tax.html':        ['estate-tax',        'Estate Tax Estimate'],
    'rent-vs-buy.html':       ['rent-vs-buy',       'Rent vs Buy'],
    'rental-yield.html':      ['rental-yield',      'Rental Yield Calculator'],
    'savings-goal.html':      ['savings-goal',      'Down Payment Savings Plan'],
    'valuation.html':         ['valuation',         'Property Valuation Estimate'],
    'zonal.html':             ['zonal',             'Zonal Value Lookup'],
    'guide.html':             ['guide',             'Real Estate Documentation Guide']
  };

  function optedOut() {
    try { return window.localStorage.getItem('glra_no_track') === '1'; } catch (_) { return true; }
  }

  // Returns this browser's id, creating one on first use. null = do not track.
  function vid() {
    if (optedOut()) return null;
    try {
      var v = window.localStorage.getItem('glra_vid');
      if (!v) {
        v = (window.crypto && window.crypto.randomUUID)
          ? window.crypto.randomUUID().replace(/-/g, '')
          : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
        window.localStorage.setItem('glra_vid', v);
      }
      return v;
    } catch (_) { return null; }   // Safari private mode / storage disabled
  }
  window.glraVid = vid;

  // ── Attach the browser id to every email-capture POST ────────────────────
  // Wrapping fetch here means the newsletter form, wishlist, price alert, PDF
  // gate and valuation enquiry all stitch identity without each page having to
  // know this feature exists. Strictly limited to our own capture endpoints.
  var IDENTITY_PATHS = ['/api/subscribe', '/api/wishlist', '/api/price-alert', '/api/inquiries', '/api/saved-search'];
  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        var isPost = init && init.method && String(init.method).toUpperCase() === 'POST';
        var matches = IDENTITY_PATHS.some(function (p) { return url.indexOf(p) !== -1; });
        if (isPost && matches && typeof init.body === 'string') {
          var v = vid();
          if (v) {
            var payload = JSON.parse(init.body);
            if (payload && typeof payload === 'object' && !payload.vid) {
              payload.vid = v;
              init = Object.assign({}, init, { body: JSON.stringify(payload) });
            }
          }
        }
      } catch (_) { /* never block the real request */ }
      // Where this visitor first came from, on the two forms that create a
      // lead, so the Leads tab can say which channel is bringing clients.
      try {
        var u2 = (typeof input === 'string') ? input : (input && input.url) || '';
        var post2 = init && init.method && String(init.method).toUpperCase() === 'POST';
        if (post2 && typeof init.body === 'string' && /\/api\/(inquiries|property-submissions)(\?|$)/.test(u2)) {
          var s2 = readSrc();
          if (s2) {
            var p2 = JSON.parse(init.body);
            if (p2 && typeof p2 === 'object' && !p2.src) {
              p2.src = { src: s2.src || '', med: s2.med || '', cmp: s2.cmp || '', ref: s2.ref || '', land: s2.land || '' };
              init = Object.assign({}, init, { body: JSON.stringify(p2) });
            }
          }
        }
      } catch (_) { /* never block the real request */ }
      return nativeFetch.call(this, input, init);
    };
  }

  // ── First touch: how this browser first reached the site ────────────────
  // Only the channel (utm tags, or the referring site's name) and the landing
  // page; kept 90 days on this device and sent only with a form the visitor
  // chooses to submit. Nothing is stored when tracking is switched off.
  function readSrc() {
    try {
      var j = JSON.parse(window.localStorage.getItem('glra_src') || 'null');
      if (j && Date.now() - j.at < 90 * 864e5) return j;
    } catch (_) {}
    return null;
  }
  (function captureSrc() {
    if (optedOut()) return;
    try {
      var here = new URL(window.location.href), qp = here.searchParams;
      var ref = '';
      try { ref = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (_) {}
      if (ref && ref === window.location.hostname.replace(/^www\./, '')) ref = '';
      var src = qp.get('utm_source') || (qp.get('fbclid') ? 'facebook' : qp.get('gclid') ? 'google' : '');
      if (!src && !ref) return;
      if (readSrc()) return;
      window.localStorage.setItem('glra_src', JSON.stringify({
        src: String(src).slice(0, 60),
        med: String(qp.get('utm_medium') || (qp.get('gclid') ? 'cpc' : qp.get('fbclid') ? 'social' : ref ? 'referral' : '')).slice(0, 60),
        cmp: String(qp.get('utm_campaign') || '').slice(0, 80),
        ref: ref.slice(0, 80),
        land: here.pathname.slice(0, 160),
        at: Date.now()
      }));
    } catch (_) {}
  })();

  // ── Listing pages opened ─────────────────────────────────────────────────
  // Anonymous (a random browser id), counted after a few seconds on the page,
  // and only tied to a person if this browser later sends a form with an email.
  (function listingView() {
    var m = window.location.pathname.match(/^\/property\/([a-f0-9]{24})\/?$/i);
    if (!m) return;
    setTimeout(function () {
      var v = vid();
      if (!v) return;
      var body = JSON.stringify({ vid: v, pid: m[1] });
      try {
        if (navigator.sendBeacon) navigator.sendBeacon('/api/track/view', new Blob([body], { type: 'application/json' }));
        else fetch('/api/track/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
      } catch (_) {}
    }, 4000);
  })();

  // ── Log one engagement per calculator visit ──────────────────────────────
  var file = (window.location.pathname.split('/').pop() || '').toLowerCase().split('?')[0];
  if (file && file.indexOf('.') === -1) file += '.html';
  var tool = TOOLS[file || 'index.html'];
  if (!tool) return;

  var fired = false, timer = null;

  function ping() {
    if (fired) return;
    var v = vid();
    if (!v) return;
    fired = true;
    var body = JSON.stringify({ vid: v, calc: tool[0], label: tool[1] });
    try {
      // sendBeacon survives the visitor navigating away mid-request.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track/calculator', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/track/calculator', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: body, keepalive: true
      }).catch(function () {});
    } catch (_) {}
  }

  // Every calculator re-runs on load, so a page view proves nothing. A real
  // edit to a field does. Debounced so typing "5,000,000" counts once, and
  // capture-phase so it still sees events that stop propagation.
  function onEngage(e) {
    if (fired || !e.isTrusted) return;
    var t = e.target;
    if (!t || !t.tagName) return;
    var tag = t.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return;
    // The PDF email gate is a lead form, not calculator use.
    if (t.closest && t.closest('.glra-print-gate')) return;
    clearTimeout(timer);
    timer = setTimeout(ping, 1200);
  }

  document.addEventListener('input', onEngage, true);
  document.addEventListener('change', onEngage, true);
})();
/* CALC-TRACKING-END */

/* ============================================
   DRAMATIC PASS V2 — interactive helpers
   Applied to all pages via main.js.
   Removable: delete from the START marker to END marker.
   ============================================ */
/* DRAMATIC-V2-HELPERS-START */
(function glraDramaticV2(){
  if (typeof document === 'undefined') return;

  var RM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var IS_HOVER = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function ready(fn){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* 1) Scroll progress bar — inject once, then track scroll */
  ready(function(){
    if (!document.getElementById('scrollProgress')) {
      var sp = document.createElement('div');
      sp.id = 'scrollProgress';
      sp.className = 'scroll-progress';
      sp.setAttribute('aria-hidden', 'true');
      document.body.insertAdjacentElement('afterbegin', sp);
    }
    var sp = document.getElementById('scrollProgress');
    var ticking = false;
    var update = function(){
      var h = document.documentElement;
      var max = (h.scrollHeight - h.clientHeight) || 1;
      /* scaleX instead of width: animating width forces a layout pass on
         every scroll frame, which is the worst place to pay for one.
         The bar is full-width in CSS and scaled from its left edge. */
      sp.style.transform = 'scaleX(' + Math.min(h.scrollTop / max, 1) + ')';
      ticking = false;
    };
    window.addEventListener('scroll', function(){
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  });

  /* 2) Navbar — auto-add .scrolled past 50px (idempotent with index.html's own listener) */
  ready(function(){
    var navbar = document.querySelector('.navbar');
    if (!navbar) return;
    var ticking = false;
    var update = function(){
      navbar.classList[window.scrollY > 50 ? 'add' : 'remove']('scrolled');
      ticking = false;
    };
    window.addEventListener('scroll', function(){
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  });

  /* 3) Scroll reveal — auto-apply to common content elements */
  if (!RM) {
    ready(function(){
      if (!('IntersectionObserver' in window)) return;

      var CARD_SEL = '.blog-card, .prop-card, .resource-card, .value-card, ' +
                     '.testimonial-card, .neighborhood-card';
      var BLOCK_SEL = 'section, .about-intro, .values-bg, .stats-section, .calculator-container';

      function mark(el){
        /* Skip elements managed by index.html's own observer */
        if (el.classList.contains('reveal') || el.classList.contains('neighborhoods-marquee')) return;
        /* index.html reveals whole <section>s via its own `.reveal` class.
           Anything sitting inside an already-revealing ancestor must not
           fade a second time — the same pixels would cross-fade twice. */
        if (el.parentElement && el.parentElement.closest('.reveal, .gl-reveal')) return;
        el.classList.add('gl-reveal');
      }

      /* Cards animate individually so a grid can stagger. A section that
         holds cards is left alone — revealing both would fade the same
         pixels twice and read as a double exposure. */
      var cards = document.querySelectorAll(CARD_SEL);
      cards.forEach(mark);
      document.querySelectorAll(BLOCK_SEL).forEach(function(el){
        if (el.querySelector(CARD_SEL)) return;
        mark(el);
      });

      if (!document.querySelector('.gl-reveal')) return;

      var io = new IntersectionObserver(function(entries){
        /* Stagger within the batch that crossed the threshold together,
           so a grid cascades but a lone section never waits its turn.
           Capped at 6 steps: a 30-card grid should not crawl in. */
        var arriving = entries.filter(function(e){ return e.isIntersecting; });
        arriving.forEach(function(e, i){
          var el = e.target;
          var delay = Math.min(i, 6) * 55;
          if (delay) el.style.setProperty('--ab-d', delay + 'ms');
          el.classList.add('in');
          io.unobserve(el);
          /* Drop the animation classes once the entrance has finished.
             `.gl-reveal` carries an !important transition for opacity and
             transform; left in place it outranks the card's own hover
             transition, so hovering a revealed card would ease over 520ms
             and its shadow would not animate at all. The end state of
             `.gl-reveal.in` is identical to the element's natural style,
             so removing both classes is visually inert. */
          window.setTimeout(function(){
            el.classList.remove('gl-reveal', 'in');
            el.style.removeProperty('--ab-d');
          }, delay + 700);
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
      document.querySelectorAll('.gl-reveal').forEach(function(el){ io.observe(el); });
      /* Safety net — reveal anything still hidden after 4s */
      setTimeout(function(){
        document.querySelectorAll('.gl-reveal:not(.in)').forEach(function(el){ el.classList.add('in'); });
      }, 4000);
    });
  }

  /* 4) Animated number counters in trust-strip and stat-numbers */
  ready(function(){
    if (!('IntersectionObserver' in window)) return;
    var items = document.querySelectorAll('.trust-label, .stat-number');
    items.forEach(function(el){
      if (el.children.length > 0) return; /* skip nested-content labels */
      var text = el.textContent.trim();
      var m = text.match(/^([\d.]+)/);
      if (!m) return;
      var target = parseFloat(m[1]);
      var decimals = (m[1].split('.')[1] || '').length;
      var rest = text.slice(m[0].length);
      el.dataset.glTarget = target;
      el.dataset.glDecimals = decimals;
      el.dataset.glRest = rest;
      /* The real figure stays in the page until the count-up starts. Zeroing
         it here meant Google, screen readers and anyone who never scrolled
         that far read "0+ Years" and "0+ Clients". */
    });
    var observer = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (!e.isIntersecting) return;
        var el = e.target;
        var target = parseFloat(el.dataset.glTarget);
        var decimals = parseInt(el.dataset.glDecimals);
        var rest = el.dataset.glRest || '';
        var duration = RM ? 0 : 1800;
        if (duration === 0) {
          el.textContent = target.toFixed(decimals) + rest;
        } else {
          var start = performance.now();
          var tick = function(now){
            var t = Math.min((now - start) / duration, 1);
            var eased = 1 - Math.pow(1 - t, 3);
            el.textContent = (eased * target).toFixed(decimals) + rest;
            if (t < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
        observer.unobserve(el);
      });
    /* threshold 0: the count starts the moment the first pixel shows, so the
       real figure is never visibly swapped for a 0 mid-screen. */
    }, { threshold: 0 });
    document.querySelectorAll('[data-gl-target]').forEach(function(el){ observer.observe(el); });
  });

  /* 5) Cursor follower — REMOVED per user request (was distracting) */


  /* 6) Magnetic primary buttons — subtle pull toward cursor (desktop) */
  if (IS_HOVER && !RM) {
    ready(function(){
      var buttons = document.querySelectorAll(
        '.cta-btn, .submit-btn, .search-btn-main, .hero-cta, .broker-btn-primary, .print-btn'
      );
      buttons.forEach(function(btn){
        if (btn.classList.contains('gl-magnetic')) return;
        btn.classList.add('gl-magnetic');
        var raf = null;
        btn.addEventListener('mousemove', function(e){
          var rect = btn.getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          var dx = (e.clientX - cx) * 0.18;
          var dy = (e.clientY - cy) * 0.18;
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(function(){
            btn.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          });
        });
        btn.addEventListener('mouseleave', function(){
          if (raf) cancelAnimationFrame(raf);
          btn.style.transform = '';
        });
      });
    });
  }
})();
/* DRAMATIC-V2-HELPERS-END */

/* ============================================
   USABILITY PASS V3 — interactive helpers
   Stunning + user-friendly. Removable: delete from
   START to END marker.
   ============================================ */
/* USABILITY-V3-HELPERS-START */
(function glraUsabilityV3(){
  if (typeof document === 'undefined') return;

  function ready(fn){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* 1) Skip-to-content link — inject if missing, target <main> or first <section> */
  ready(function(){
    if (document.querySelector('.skip-to-content')) return;
    var main = document.querySelector('main') || document.querySelector('section') || document.querySelector('.page-hero');
    if (!main) return;
    if (!main.id) main.id = 'main-content';
    var link = document.createElement('a');
    link.className = 'skip-to-content';
    link.href = '#' + main.id;
    link.textContent = 'Skip to content';
    document.body.insertAdjacentElement('afterbegin', link);
  });

  /* 2) Active nav state — flag the current page in nav links */
  ready(function(){
    var path = location.pathname.toLowerCase();
    var pathFile = path.split('/').pop() || '';
    var atRoot = (path === '/' || pathFile === '' || pathFile === 'index.html');

    function matches(href){
      if (!href) return false;
      try {
        var url = new URL(href, location.origin);
        if (url.origin !== location.origin) return false;
        var hp = url.pathname.toLowerCase();
        var hf = hp.split('/').pop() || '';
        if (atRoot) return (hp === '/' || hf === '' || hf === 'index.html');
        return hf === pathFile;
      } catch(_){ return false; }
    }

    document.querySelectorAll('.nav-links > a, .nav-links > .nav-dropdown > a, .nav-dropdown-menu a, .mobile-overlay-links a').forEach(function(a){
      if (matches(a.getAttribute('href'))) {
        a.classList.add('gl-active');
        var dd = a.closest('.nav-dropdown');
        if (dd) dd.classList.add('gl-active');
      }
    });
  });

  /* 3) Skeleton loaders — pre-fill known property containers so users don't see a blank gap */
  ready(function(){
    var ids = ['featured-list','sale-list','lease-list','properties-grid','properties-list'];
    var skeletonHtml = '<div class="prop-card-skeleton"></div>';
    ids.forEach(function(id){
      var c = document.getElementById(id);
      if (!c || c.children.length > 0) return;
      var html = '';
      for (var i = 0; i < 6; i++) html += skeletonHtml;
      c.innerHTML = html;
    });
  });

  /* 4) Keyboard-only focus rings — only show outline when user is tabbing */
  (function(){
    // Keys that MOVE focus. Escape, Enter and Space were in here too, and
    // that is what put an orange ring around a property card after a plain
    // mouse click: you click the card, the pop-up opens, you press Escape to
    // dismiss it, Escape flips the page into keyboard mode, focus returns to
    // the card, and the ring lights up on something you never tabbed to.
    // Escape dismisses, Enter and Space activate what is already focused --
    // none of the three navigates, so none of them should turn the rings on.
    var keyboardEvents = ['Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
    document.addEventListener('keydown', function(e){
      if (keyboardEvents.indexOf(e.key) !== -1) document.body.classList.add('gl-keyboard');
    });
    document.addEventListener('mousedown', function(){
      document.body.classList.remove('gl-keyboard');
    });
    document.addEventListener('touchstart', function(){
      document.body.classList.remove('gl-keyboard');
    }, { passive: true });
  })();

  /* 5) Page transition fade — fade out on internal navigation */
  (function(){
    var RM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (RM) return;
    /* Where the browser does cross-document view transitions (styles.css
       opts in with @view-transition), it cross-fades the pages itself and
       morphs the listing photo. Fading the body to 0 here as well would hand
       it a blank page as the "old" snapshot, so the two effects would fight.
       This fade is now only the fallback for browsers without them. */
    if (window.CSSViewTransitionRule) return;
    document.addEventListener('click', function(e){
      var a = e.target.closest('a[href]');
      if (!a) return;
      if (e.defaultPrevented) return;
      if (e.button !== 0) return; /* ignore right-click, middle-click */
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; /* let modifier-clicks open in new tab etc. */
      if (a.target && a.target !== '_self') return;
      var href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') ||
          href.startsWith('javascript:') || href.startsWith('viber:') || href.startsWith('whatsapp:')) return;
      try {
        var url = new URL(href, location.origin);
        if (url.origin !== location.origin) return;
        if (url.pathname === location.pathname && url.hash) return; /* in-page anchor */
        if (a.hasAttribute('download')) return;
        /* The fade used to hold every click for 220ms before navigating. Now
           the browser starts fetching at once and the fade runs meanwhile; the
           timer only undoes it if the navigation never happens. */
        document.body.classList.add('gl-leaving');
        setTimeout(function(){ document.body.classList.remove('gl-leaving'); }, 2500);
      } catch(_){}
    });
    /* Reset on back/forward navigation */
    window.addEventListener('pageshow', function(e){
      if (e.persisted) document.body.classList.remove('gl-leaving');
    });
  })();

  /* 6) Image blur-up — when lazy images load, remove blur smoothly */
  ready(function(){
    if (!('MutationObserver' in window)) return;
    function clearBlur(img){
      if (img.complete && img.naturalWidth > 0) {
        img.classList.remove('lazy');
      } else {
        img.addEventListener('load', function(){ img.classList.remove('lazy'); }, { once: true });
        img.addEventListener('error', function(){ img.classList.remove('lazy'); }, { once: true });
      }
    }
    document.querySelectorAll('img.lazy').forEach(clearBlur);
    var mo = new MutationObserver(function(muts){
      muts.forEach(function(m){
        m.addedNodes.forEach(function(n){
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('img.lazy')) clearBlur(n);
          if (n.querySelectorAll) n.querySelectorAll('img.lazy').forEach(clearBlur);
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
})();
/* USABILITY-V3-HELPERS-END */

/* ============================================
   OUTREACH + ACCESSIBILITY PASS V4
   - Microsoft Clarity analytics (skips /admin)
   - WhatsApp pre-filled greeting
   - Larger-text accessibility toggle for older visitors
   Removable: delete from START to END marker.
   ============================================ */
/* OUTREACH-V4-START */
(function glraOutreachV4(){
  if (typeof document === 'undefined') return;

  function ready(fn){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* 1) Microsoft Clarity analytics --------------------------------------
     PASTE your Clarity project ID below. Get it free at clarity.microsoft.com
     → create a project for glrarealty.com → Settings → Overview → copy the ID
     (looks like "abcd1234ef"). Until you paste it, analytics stays OFF so
     nothing breaks. It never runs on the /admin dashboard. */
  var CLARITY_ID = 'wyui9wgsdd';
  (function loadClarity(){
    if (!CLARITY_ID || CLARITY_ID === 'PASTE_YOUR_CLARITY_ID_HERE') return;
    if (location.pathname.toLowerCase().indexOf('/admin') === 0) return;
    /* privacy.html offers a "Turn tracking off" switch that writes
       glra_no_track. The calculator tracking below already respects it;
       Clarity did not, so someone who used the switch was still being
       session-recorded. Honour it here too, and fail closed if localStorage
       cannot be read at all. */
    try { if (window.localStorage.getItem('glra_no_track') === '1') return; }
    catch (e) { return; }
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src='https://www.clarity.ms/tag/'+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, 'clarity', 'script', CLARITY_ID);
  })();

  /* 2) WhatsApp pre-filled greeting -------------------------------------- */
  ready(function(){
    var msg = encodeURIComponent("Hi GLRA Realty! I'm interested in your properties and would like to know more.");
    document.querySelectorAll('a.btn-whatsapp[href*="wa.me"], a[data-glra-wa][href*="wa.me"]').forEach(function(a){
      if (a.href.indexOf('text=') !== -1) return; /* already has a message */
      a.href = a.href.split('?')[0] + '?text=' + msg;
    });
  });

  /* 3) The "A+" larger-text button was removed (Sept 2026): phones and
     browsers already zoom, and it crowded the contact buttons. Forget the
     old setting so nobody is left with a saved preference. */
  try { localStorage.removeItem('glraLargeText'); } catch(e){}
})();
/* OUTREACH-V4-END */

/* RECENTLY-VIEWED-START */
/* ── Recently viewed ──────────────────────────────────────────────────────
   Remembers the last listings a visitor opened (a listing page, or a pop-up
   on the home or browse page) in THIS browser only, and shows them as a small
   strip on the home and browse pages. Nothing is sent to the server; "Clear"
   forgets them. */
(function () {
  'use strict';
  var KEY = 'glraRecent', MAX = 12;
  function read() {
    try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return /^[a-f0-9]{24}$/i.test(x); }) : []; }
    catch (e) { return []; }
  }
  function write(a) { try { localStorage.setItem(KEY, JSON.stringify(a.slice(0, MAX))); } catch (e) {} }
  function remember(id) {
    id = String(id || '');
    if (!/^[a-f0-9]{24}$/i.test(id)) return;
    var a = read().filter(function (x) { return x !== id; });
    a.unshift(id); write(a);
  }
  window.glraRememberViewed = remember;

  var m = location.pathname.match(/^\/property\/([a-f0-9]{24})\/?$/i);
  if (m) remember(m[1]);

  function listings() {
    try { if (typeof cachedProperties !== 'undefined' && Array.isArray(cachedProperties) && cachedProperties.length) return cachedProperties; } catch (e) {}
    return null;
  }
  function shortPrice(p) {
    var lt = String(p.listingType || '').toUpperCase();
    var lease = lt === 'FOR LEASE';
    var n = lease ? (Number(p.monthlyRental) || Number(p.price) || 0) : (Number(p.price) || Number(p.monthlyRental) || 0);
    if (!(n > 0)) return 'Price on request';
    var t = n >= 1e6 ? '₱' + (Math.round(n / 1e4) / 100) + 'M' : n >= 1e3 ? '₱' + Math.round(n / 1e3) + 'K' : '₱' + n;
    return lease ? t + '/mo' : t;
  }
  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s) : String(s || ''); }
  function title(t) { return typeof window.glraDisplayTitle === 'function' ? window.glraDisplayTitle(t) : t; }
  function size(u) { return typeof window.glraImgSize === 'function' ? window.glraImgSize(u, 320) : u; }

  function render() {
    var all = listings(); if (!all) return false;
    // Browse page: above the results block (which is a list/map grid, so the
    // strip must not become one of its cells). Home page: after Featured.
    var list = document.getElementById('property-list');
    var anchor = list ? (document.getElementById('resultsLayout') || list) : document.getElementById('featured');
    if (!anchor) return true;
    var byId = {}; all.forEach(function (p) { byId[p._id] = p; });
    var items = read().map(function (id) { return byId[id]; }).filter(Boolean).slice(0, 8);
    var box = document.getElementById('glraRecent');
    if (items.length < 1) { if (box) box.remove(); return true; }
    if (!box) {
      box = document.createElement('section');
      box.id = 'glraRecent';
      box.className = 'glra-recent';
      box.setAttribute('aria-labelledby', 'glraRecentH');
      if (anchor.id === 'featured') anchor.parentNode.insertBefore(box, anchor.nextSibling);
      else anchor.parentNode.insertBefore(box, anchor);
    }
    box.innerHTML = '<div class="glra-recent-head"><h2 id="glraRecentH">Recently viewed</h2>' +
      '<button type="button" class="glra-recent-clear">Clear</button></div><ul class="glra-recent-list">' +
      items.map(function (p) {
        return '<li><a href="/property/' + esc(p._id) + '" data-id="' + esc(p._id) + '">' +
          '<span class="glra-recent-img">' + (p.mainImage ? '<img src="' + esc(size(p.mainImage)) + '" alt="" loading="lazy" decoding="async">' : '') + '</span>' +
          '<span class="glra-recent-t">' + esc(title(p.title)) + '</span>' +
          '<span class="glra-recent-p">' + esc(shortPrice(p)) + '</span></a></li>';
      }).join('') + '</ul>';
    box.querySelector('.glra-recent-clear').addEventListener('click', function () {
      write([]); box.remove();
    });
    box.querySelectorAll('a[data-id]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (typeof window.openDetail === 'function' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault(); window.openDetail(a.getAttribute('data-id'));
        }
      });
    });
    return true;
  }

  function start() {
    // Wrap the pop-up opener so pop-up views count too.
    if (typeof window.openDetail === 'function' && !window.openDetail.__glraRecent) {
      var orig = window.openDetail;
      window.openDetail = function (id) { remember(id); return orig.apply(this, arguments); };
      window.openDetail.__glraRecent = true;
    }
    var tries = 0;
    (function wait() {
      if (render() || ++tries > 40) return;
      setTimeout(wait, 400);
    })();
  }
  if (!/^\/(?:index\.html)?$|^\/properties\.html$/.test(location.pathname)) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  if (!document.getElementById('glraRecentStyle')) {
    var st = document.createElement('style');
    st.id = 'glraRecentStyle';
    st.textContent =
      '.glra-recent{max-width:none;margin:0 0 22px;padding:0 var(--glra-pad,5%)}' +
      '#featured+.glra-recent{margin-top:10px}' +
      '.glra-recent-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}' +
      '.glra-recent-head h2{font-family:"JetBrains Mono",monospace!important;font-size:11px!important;font-weight:700!important;letter-spacing:2px!important;text-transform:uppercase!important;margin:0!important;color:inherit}' +
      'html body .glra-recent-clear{font-family:"JetBrains Mono",monospace!important;font-size:10px!important;letter-spacing:1px!important;text-transform:uppercase!important;background:transparent!important;color:inherit!important;border:1px solid currentColor!important;padding:5px 9px!important;cursor:pointer;box-shadow:none!important}' +
      '.glra-recent-list{list-style:none;margin:0;padding:0 0 6px;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,170px);gap:12px;overflow-x:auto;scroll-snap-type:x mandatory}' +
      '.glra-recent-list li{scroll-snap-align:start}' +
      '.glra-recent-list a{display:block;color:inherit;text-decoration:none;border:2px solid #0a0a0a;background:#fff;height:100%}' +
      'body.dark-mode .glra-recent-list a{border-color:#f1eee9;background:#151513}' +
      '.glra-recent-list a:hover,.glra-recent-list a:focus-visible{box-shadow:4px 4px 0 #ff3d00}' +
      '.glra-recent-img{display:block;aspect-ratio:4/3;background:#e8e4dd;overflow:hidden}' +
      '.glra-recent-img img{width:100%;height:100%;object-fit:cover;display:block}' +
      '.glra-recent-t{display:block;padding:8px 9px 2px;font-size:12px;font-weight:700;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '.glra-recent-p{display:block;padding:0 9px 9px;font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:700;color:#c02e00}' +
      'body.dark-mode .glra-recent-p{color:#ff6a3d}';
    (document.head || document.documentElement).appendChild(st);
  }
})();
/* RECENTLY-VIEWED-END */
