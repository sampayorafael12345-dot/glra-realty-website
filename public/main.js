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
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark);
  const btn = document.getElementById('floatingDarkModeToggle') || document.getElementById('dmBtn');
  if (btn) btn.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
}

// Apply saved dark mode preference on load
if (localStorage.getItem('darkMode') === 'true') {
  document.body.classList.add('dark-mode');
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('floatingDarkModeToggle') || document.getElementById('dmBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-sun"></i>';
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
(function setupFabToggle() {
  function init() {
    document.querySelectorAll('.floating-buttons').forEach(container => {
      // Idempotent — don't inject twice if main.js runs again
      if (container.querySelector('.fab-toggle')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floating-btn fab-toggle';
      btn.setAttribute('aria-label', 'Open contact options');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<i class="fas fa-comment-dots"></i>';
      btn.addEventListener('click', () => {
        const isOpen = container.classList.toggle('expanded');
        btn.classList.toggle('is-open', isOpen);
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        btn.setAttribute('aria-label', isOpen ? 'Close contact options' : 'Open contact options');
        btn.innerHTML = isOpen
          ? '<i class="fas fa-times"></i>'
          : '<i class="fas fa-comment-dots"></i>';
      });
      // Append as the LAST child so the FAB sits at the bottom of the visible stack
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

// ── Email-gated print/download (shared by all calculators) ──
// Usage: <button onclick="glraOpenPrintGate('Affordability Calculator')">Print</button>
// Requires: a `.print-only-header` div on the page for the branded print header.
window.glraOpenPrintGate = function (label) {
  let modal = document.getElementById('glraPrintGate');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'glraPrintGate';
    modal.className = 'glra-print-gate';
    modal.innerHTML = `
      <div class="glra-print-gate-card" role="dialog" aria-modal="true">
        <button class="glra-print-gate-close" type="button" aria-label="Close">&times;</button>
        <i class="fas fa-envelope"></i>
        <h3>Enter Your Email</h3>
        <p>Enter your email to continue. The print dialog will open — choose <strong>"Save as PDF"</strong> to download a copy, or pick a printer to print on paper.</p>
        <input type="email" placeholder="Your email address" autocomplete="email" />
        <button class="glra-print-gate-submit" type="button">Continue</button>
        <p class="glra-print-gate-fine">We'll keep you updated on new listings and market insights.</p>
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
      submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
      try {
        await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, source: 'calculator_print' })
        });
      } catch (_) {} // best-effort; don't block printing if subscribe fails
      submit.disabled = false;
      submit.innerHTML = orig;
      close();
      // Blank the document title briefly so the browser doesn't auto-inject it into the printed page header.
      const originalTitle = document.title;
      document.title = ' ';
      setTimeout(() => {
        window.print();
        setTimeout(() => { document.title = originalTitle; }, 500);
      }, 200);
      window.addEventListener('afterprint', () => { document.title = originalTitle; }, { once: true });
    });
  }
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

  /* 5) Cursor follower — desktop with fine pointer only */
  if (IS_HOVER && !RM) {
    ready(function(){
      if (document.querySelector('.gl-cursor')) return;
      var c = document.createElement('div');
      c.className = 'gl-cursor';
      document.body.appendChild(c);
      var mx = 0, my = 0, x = 0, y = 0;
      document.addEventListener('mousemove', function(e){
        mx = e.clientX; my = e.clientY;
        document.body.classList.add('gl-cursor-active');
      });
      document.addEventListener('mouseleave', function(){
        document.body.classList.remove('gl-cursor-active');
      });
      var loop = function(){
        x += (mx - x) * 0.18;
        y += (my - y) * 0.18;
        c.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) translate(-50%,-50%)';
        requestAnimationFrame(loop);
      };
      loop();
      var lastTarget = null;
      document.addEventListener('mouseover', function(e){
        var hov = e.target.closest('a, button, .prop-card, .resource-card, .blog-card, .value-card, .neighborhood-card, [role="button"], input, select, textarea');
        if (hov !== lastTarget) {
          c.classList.toggle('grow', !!hov);
          lastTarget = hov;
        }
      });
    });
  }

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
