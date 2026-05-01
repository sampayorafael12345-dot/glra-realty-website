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
