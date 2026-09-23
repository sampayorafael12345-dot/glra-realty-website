/* a11y.js — keyboard and screen-reader upgrades, applied to every page.

   Purely additive. It finds what is already in the markup and gives it the
   semantics it was missing; it never rewrites content and never moves anything,
   so it cannot shift layout. Everything here is idempotent and guarded, so a
   page that does not have a given control simply skips that block.

   What it fixes, and why each one mattered:

   1. SKIP LINK. The stylesheet has carried a fully designed `.skip-to-content`
      rule for months and no page ever contained the link. A keyboard visitor
      on properties.html had to tab through the whole nav plus both dropdown
      menus — 30-odd stops — before reaching the first listing.

   2. DIV-AS-BUTTON. The mobile menu button, its close button and the logo are
      `<div onclick=...>`. A div is not focusable and announces as nothing, so
      with a keyboard, or with VoiceOver, the menu could not be opened at all.

   3. NAV DROPDOWNS. `Tools` and `Guides` are `<a>` with no href and their menus
      open on `:hover` only. That is 26 links — every calculator on the site —
      that no keyboard could reach. They now toggle on click and on Enter/Space,
      close on Escape, and still open on hover for the mouse.

   4. MOBILE OVERLAY. Escape now closes it, focus moves into it when it opens
      and returns to the button that opened it, and Tab is trapped inside while
      it is up. Without the trap, tabbing inside an open menu walked invisibly
      down the page behind it.

   5. DECORATIVE ICONS. ~1,600 Font Awesome `<i>` elements sit next to visible
      text. Each one is an empty element a screen reader may still stop on;
      aria-hidden takes them out of the tree.
*/
(function () {
  'use strict';
  if (window.__glraA11y) return;
  window.__glraA11y = true;

  function isActivate(e) { return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar'; }
  function isEscape(e) { return e.key === 'Escape' || e.key === 'Esc'; }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* Give a clickable non-button the semantics of a button: a role, a place in
     the tab order, a name, and Enter/Space activation. The element keeps its
     own inline onclick — el.click() dispatches a real click, which fires it. */
  function asButton(el, label) {
    if (!el || el.dataset.glraBtn) return;
    var tag = el.tagName;
    if (tag !== 'BUTTON' && tag !== 'A') {
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    }
    if (label && !el.getAttribute('aria-label') && !el.textContent.trim()) {
      el.setAttribute('aria-label', label);
    }
    el.dataset.glraBtn = '1';
    el.addEventListener('keydown', function (e) {
      if (!isActivate(e)) return;
      e.preventDefault();          // Space would otherwise scroll the page
      el.click();
    });
  }

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),' +
                  'select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
  }

  function closeAllDropdowns(except) {
    Array.prototype.forEach.call(document.querySelectorAll('.nav-dropdown.ab-open'), function (o) {
      if (o === except) return;
      o.classList.remove('ab-open');
      var t = o.firstElementChild;
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }

  ready(function () {

    /* 1. Skip link ---------------------------------------------------- */
    (function () {
      if (document.querySelector('.skip-to-content')) return;
      // Prefer a main that is actually on screen: agent.html carries two, and
      // the sign-in one is display:none the moment you are signed in.
      function visible(el) { return el && (el.offsetWidth > 0 || el.offsetHeight > 0); }
      var byId = document.getElementById('main');
      var mains = Array.prototype.slice.call(document.querySelectorAll('main'));
      var target = (visible(byId) && byId) ||
                   mains.filter(visible)[0] ||
                   byId || mains[0] || document.querySelector('footer');
      if (!target) return;
      if (!target.id) target.id = 'main';
      // -1 so the link can move focus there without adding a tab stop of its own.
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      var a = document.createElement('a');
      a.className = 'skip-to-content';
      a.href = '#' + target.id;
      a.textContent = 'Skip to main content';
      a.addEventListener('click', function () {
        // Some browsers scroll to the anchor without focusing it.
        setTimeout(function () { target.focus(); }, 0);
      });
      document.body.insertBefore(a, document.body.firstChild);
    })();

    /* 2. Clickable divs ----------------------------------------------- */
    // The home page's navbar is its own markup and calls the opener
    // .ab-nav-mobile-btn; every other page uses .mobile-menu-btn.
    var opener = document.querySelector('.mobile-menu-btn:not([style*="display:none"])');
    if (!opener || !(opener.offsetWidth || opener.offsetHeight)) {
      opener = document.querySelector('.ab-nav-mobile-btn') || opener;
    }
    asButton(opener, 'Open menu');
    asButton(document.querySelector('.mobile-overlay .close-menu'), 'Close menu');
    asButton(document.querySelector('nav.navbar .logo'), 'GLRA Realty, home');
    Array.prototype.forEach.call(
      document.querySelectorAll('[onclick]:not(a):not(button):not(input):not(select):not(textarea)'),
      function (el) { asButton(el, null); }
    );

    /* 3. Nav dropdowns ------------------------------------------------- */
    Array.prototype.forEach.call(document.querySelectorAll('.nav-dropdown'), function (dd, i) {
      var menu = dd.querySelector('.nav-dropdown-menu');
      var trigger = dd.firstElementChild;
      if (!menu || !trigger || trigger === menu) return;
      if (trigger.hasAttribute('href')) return;   // a real link, leave it alone
      if (!menu.id) menu.id = 'glra-navmenu-' + i;

      trigger.setAttribute('role', 'button');
      trigger.setAttribute('tabindex', '0');
      trigger.setAttribute('aria-haspopup', 'true');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', menu.id);

      function setOpen(open) {
        dd.classList.toggle('ab-open', open);
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      }

      trigger.addEventListener('click', function (e) {
        e.preventDefault();
        var open = !dd.classList.contains('ab-open');
        closeAllDropdowns(dd);
        setOpen(open);
      });
      trigger.addEventListener('keydown', function (e) {
        if (isActivate(e)) { e.preventDefault(); trigger.click(); return; }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          closeAllDropdowns(dd);
          setOpen(true);
          var first = menu.querySelector('a[href]');
          if (first) first.focus();
        }
      });
      // Escape anywhere in the group closes it and hands focus back.
      dd.addEventListener('keydown', function (e) {
        if (!isEscape(e)) return;
        if (!dd.classList.contains('ab-open')) return;
        e.stopPropagation();
        setOpen(false);
        trigger.focus();
      });
      // Tabbing out of the last item closes it, so the menu never lingers.
      dd.addEventListener('focusout', function () {
        setTimeout(function () {
          if (!dd.contains(document.activeElement)) setOpen(false);
        }, 0);
      });
    });
    document.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.nav-dropdown')) return;
      closeAllDropdowns(null);
    });

    /* 4. Mobile overlay: escape, focus move, focus return, focus trap --- */
    (function () {
      var overlay = document.getElementById('mobileOverlay');
      // Whichever of the two openers this page actually shows.
      var candidates = document.querySelectorAll('.mobile-menu-btn,.ab-nav-mobile-btn');
      var opener = null;
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].offsetWidth || candidates[i].offsetHeight) { opener = candidates[i]; break; }
      }
      if (!opener) opener = candidates[0] || null;
      if (!overlay) return;
      if (opener) {
        opener.setAttribute('aria-expanded', 'false');
        opener.setAttribute('aria-controls', 'mobileOverlay');
      }
      var lastFocus = null;

      // index.html opens the overlay with .show; every other page uses
      // .active, and the stylesheet also recognises .open. Watching all three
      // means this works with whichever one the page happens to call.
      var OPEN_CLASSES = ['active', 'show', 'open'];
      function isOpen() {
        for (var i = 0; i < OPEN_CLASSES.length; i++) {
          if (overlay.classList.contains(OPEN_CLASSES[i])) return true;
        }
        return false;
      }
      function forceClose() {
        for (var i = 0; i < OPEN_CLASSES.length; i++) overlay.classList.remove(OPEN_CLASSES[i]);
      }

      // openMobileMenu()/closeMobileMenu() live in main.js and in inline page
      // scripts. Watching the class means this works with every one of them
      // without patching any.
      new MutationObserver(function () {
        var open = isOpen();
        if (opener) opener.setAttribute('aria-expanded', open ? 'true' : 'false');
        overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
        // A hidden menu must not be reachable with Tab either.
        overlay.inert = !open;
        if (open) {
          lastFocus = document.activeElement;
          var f = focusables(overlay);
          if (f.length) f[0].focus();
        } else if (lastFocus && document.contains(lastFocus)) {
          lastFocus.focus();
          lastFocus = null;
        }
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });

      overlay.setAttribute('aria-hidden', isOpen() ? 'false' : 'true');
      overlay.inert = !isOpen();

      document.addEventListener('keydown', function (e) {
        if (!isOpen()) return;
        if (isEscape(e)) {
          e.preventDefault();
          if (typeof window.closeMobileMenu === 'function') window.closeMobileMenu();
          else forceClose();
          return;
        }
        if (e.key !== 'Tab') return;
        var f = focusables(overlay);
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    })();

    /* 5. aria-current on the link for the page we are on ---------------- */
    (function () {
      var path = (location.pathname.replace(/\/$/, '') || '/');
      Array.prototype.forEach.call(
        document.querySelectorAll('nav a[href], .mobile-overlay-links a[href]'),
        function (a) {
          var href = a.getAttribute('href') || '';
          if (!href || href.charAt(0) === '#') return;
          if (href.replace(/\/$/, '') === path) a.setAttribute('aria-current', 'page');
        }
      );
    })();

    /* 6. Decorative icons out of the accessibility tree ------------------ */
    function hideIcons(root) {
      Array.prototype.forEach.call(
        (root || document).querySelectorAll('i[class*="fa-"],span[class*="fa-"]'),
        function (el) {
          if (el.textContent.trim()) return;      // not an icon-font glyph
          if (el.hasAttribute('aria-hidden')) return;
          el.setAttribute('aria-hidden', 'true');
        }
      );
    }
    hideIcons(document);

    // Most of this site's icons arrive after load — listing cards, the chat
    // widget, the floating buttons. Debounced so a burst of inserted cards
    // costs one pass, not one per card.
    if (window.MutationObserver) {
      var pending = 0;
      new MutationObserver(function () {
        if (pending) return;
        pending = setTimeout(function () { pending = 0; hideIcons(document); }, 250);
      }).observe(document.body, { childList: true, subtree: true });
    }
  });
})();
