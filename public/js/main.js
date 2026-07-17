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
// Swap `<img src>` between /img/logo.png (black) and /img/hero-logo.png (white) on
// every navbar/brand mark. Covers img[data-logo-auto] for opt-in elements
// plus the common navbar selectors so inner pages don't need markup changes.
function syncLogos() {
  const dark = document.body.classList.contains('dark-mode');
  document.querySelectorAll('img[data-logo-auto], .ab-brand img, .navbar .logo img, .ab-mast img').forEach(img => {
    img.src = dark ? '/img/hero-logo.png' : '/img/logo.png';
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
  localStorage.setItem('darkMode', isDark);
  syncDarkModePre();
  const btn = document.getElementById('floatingDarkModeToggle') || document.getElementById('dmBtn');
  if (btn) btn.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
  syncLogos();
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
  });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    syncDarkModePre();
    const btn = document.getElementById('floatingDarkModeToggle') || document.getElementById('dmBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-moon"></i>';
    syncLogos();
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

// ── HTML escape helper (used by pages that render dynamic text) ──
function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Back-to-top button visibility on scroll ──────────────
window.addEventListener('scroll', () => {
  const b = document.getElementById('backToTop');
  if (b) b.classList[window.scrollY > 120 ? 'add' : 'remove']('show');
});

// ── Mobile FAB toggle for floating buttons ───────────────
// On mobile, all the contact buttons (call, WhatsApp, Viber, etc.) are hidden by
// default and a single FAB appears at the bottom. Tapping it reveals the rest
// with a staggered animation. Desktop is unaffected (CSS @media handles that).
//
// JS-injected styles (!important) are needed because the inline <style> block
// in index.html overrides the styles.css mobile-hide rule on specificity.
(function setupFabToggle() {
  // 1) Inject CSS so we always win on specificity & load order.
  if (!document.getElementById('glraFabToggleStyle')) {
    const css = `
@media(max-width:768px){
  .floating-buttons{position:fixed !important;bottom:18px !important;right:18px !important;gap:8px !important;z-index:1000 !important}
  .floating-buttons > *{display:none !important}
  .floating-buttons > .fab-toggle{display:flex !important}
  .floating-buttons.expanded > *{display:flex !important;animation:glraFabIn .15s ease both}
  .floating-buttons .fab-toggle{
    width:48px !important;height:48px !important;font-size:18px !important;
    box-sizing:border-box !important;padding:0 !important;
    align-items:center !important;justify-content:center !important;
    border:0 !important;border-radius:0 !important;cursor:pointer !important;
    background:#ff3d00 !important;color:#fff !important;
    box-shadow:3px 3px 0 #0a0a0a !important;
  }
  .floating-buttons .fab-toggle.is-open{background:#0a0a0a !important;color:#fff !important;box-shadow:3px 3px 0 #ff3d00 !important}
  .floating-buttons .fab-toggle i{pointer-events:none !important}
}
@keyframes glraFabIn{from{opacity:0;transform:translateY(8px) scale(.9)}to{opacity:1;transform:none}}
`;
    const s = document.createElement('style');
    s.id = 'glraFabToggleStyle';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function init() {
    document.querySelectorAll('.floating-buttons').forEach(container => {
      if (container.querySelector('.fab-toggle')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floating-btn fab-toggle';
      btn.setAttribute('aria-label', 'Open contact options');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<i class="fas fa-comment-dots"></i>';

      // Use a handler that stops propagation so the document "tap-outside-to-close"
      // listener can't fire on the same click and immediately un-toggle.
      const toggle = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const isOpen = container.classList.toggle('expanded');
        btn.classList.toggle('is-open', isOpen);
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        btn.setAttribute('aria-label', isOpen ? 'Close contact options' : 'Open contact options');
        btn.innerHTML = isOpen
          ? '<i class="fas fa-times"></i>'
          : '<i class="fas fa-comment-dots"></i>';
      };
      btn.addEventListener('click', toggle);
      // iOS occasionally swallows the first click on dynamically-injected
      // elements — touchend covers that path.
      btn.addEventListener('touchend', (e) => {
        // only act on a tap (no drag), and not on multi-touch
        if (e.changedTouches && e.changedTouches.length === 1) toggle(e);
      });

      container.appendChild(btn);
    });

    // Tap outside to close (mobile only)
    document.addEventListener('click', e => {
      document.querySelectorAll('.floating-buttons.expanded').forEach(c => {
        if (!c.contains(e.target)) {
          c.classList.remove('expanded');
          const t = c.querySelector('.fab-toggle');
          if (t) {
            t.classList.remove('is-open');
            t.setAttribute('aria-expanded', 'false');
            t.setAttribute('aria-label', 'Open contact options');
            t.innerHTML = '<i class="fas fa-comment-dots"></i>';
          }
        }
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

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
  const h1 = document.querySelector('.print-only-header h1');
  out.title = (h1 ? h1.textContent : (document.title || 'Report')).trim();

  // Inputs — the user's entries (all calculators wrap fields in .input-group;
  // the loan-comparison panels use .field)
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
  const logo = await glraLoadLogo('/img/logo.png', 320);
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
      sp.style.width = ((h.scrollTop / max) * 100) + '%';
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
      var candidates = document.querySelectorAll(
        'section, .blog-card, .prop-card, .resource-card, .value-card, .testimonial-card, ' +
        '.neighborhood-card, .about-intro, .values-bg, .stats-section, .calculator-container'
      );
      if (!candidates.length) return;
      candidates.forEach(function(el){
        /* Skip elements managed by index.html's own observer */
        if (el.classList.contains('reveal') || el.classList.contains('neighborhoods-marquee')) return;
        el.classList.add('gl-reveal');
      });
      var io = new IntersectionObserver(function(entries){
        entries.forEach(function(e){
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
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
      el.textContent = (decimals ? '0.' + '0'.repeat(decimals) : '0') + rest;
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
    }, { threshold: 0.5 });
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
    var keyboardEvents = ['Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter',' ','Escape'];
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
        e.preventDefault();
        document.body.classList.add('gl-leaving');
        setTimeout(function(){ window.location.href = href; }, 220);
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
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src='https://www.clarity.ms/tag/'+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, 'clarity', 'script', CLARITY_ID);
  })();

  /* 2) WhatsApp pre-filled greeting -------------------------------------- */
  ready(function(){
    var msg = encodeURIComponent("Hi GLRA Realty! I'm interested in your properties and would like to know more.");
    document.querySelectorAll('a.btn-whatsapp[href*="wa.me"]').forEach(function(a){
      if (a.href.indexOf('text=') !== -1) return; /* already has a message */
      a.href = a.href.split('?')[0] + '?text=' + msg;
    });
  });

  /* 3) Larger-text accessibility toggle ---------------------------------- */
  if (!document.getElementById('glraTextSizeStyle')) {
    var css =
      'html.glra-large-text{zoom:1.15}' +
      '.floating-buttons .btn-textsize{background:#0a0a0a !important;color:#fff !important;font-weight:800 !important;' +
      'font-family:Inter,system-ui,sans-serif !important;font-size:15px !important;letter-spacing:.5px !important}' +
      'html.glra-large-text .floating-buttons .btn-textsize{background:#ff3d00 !important;color:#fff !important}';
    var s = document.createElement('style');
    s.id = 'glraTextSizeStyle';
    s.textContent = css;
    document.head.appendChild(s);
  }
  /* Apply saved preference right away (before paint where possible). */
  try {
    if (localStorage.getItem('glraLargeText') === '1') document.documentElement.classList.add('glra-large-text');
  } catch(e){}
  window.glraToggleTextSize = function(){
    var on = document.documentElement.classList.toggle('glra-large-text');
    try { localStorage.setItem('glraLargeText', on ? '1' : '0'); } catch(e){}
    if (typeof showToast === 'function') showToast(on ? 'Larger text turned on' : 'Larger text turned off');
  };
  /* Inject an "A+" button into every floating-buttons cluster, before the dark-mode button. */
  ready(function(){
    document.querySelectorAll('.floating-buttons').forEach(function(container){
      if (container.querySelector('.btn-textsize')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floating-btn btn-textsize';
      btn.setAttribute('aria-label', 'Toggle larger text');
      btn.setAttribute('title', 'Larger text');
      btn.textContent = 'A+';
      btn.addEventListener('click', window.glraToggleTextSize);
      var dm = container.querySelector('.btn-darkmode');
      if (dm) container.insertBefore(btn, dm);
      else container.appendChild(btn);
    });
  });
})();
/* OUTREACH-V4-END */
