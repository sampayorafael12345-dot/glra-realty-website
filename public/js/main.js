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
// Swap `<img src>` between /logo.png (black) and /hero-logo.png (white) on
// every navbar/brand mark. Covers img[data-logo-auto] for opt-in elements
// plus the common navbar selectors so inner pages don't need markup changes.
function syncLogos() {
  const dark = document.body.classList.contains('dark-mode');
  document.querySelectorAll('img[data-logo-auto], .ab-brand img, .navbar .logo img, .ab-mast img').forEach(img => {
    img.src = dark ? '/hero-logo.png' : '/logo.png';
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
