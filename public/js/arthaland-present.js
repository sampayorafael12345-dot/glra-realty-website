/* ══════════════════════════════════════════════════════════════════════
   ARTHALAND — PRESENTATION MODE
   Shared by sondris / eluria / liv / una / lucima.

   Lets the page be driven like a deck: a slide rail down the left edge
   showing which section you are on, and arrow keys / space / a clicker
   to move between them. Scrolling still works exactly as before — this
   only adds a way to step through it deliberately in front of a client.

   Everything here is progressive enhancement. If the script fails to
   load the pages behave exactly as they did before.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Section ids across all five pages -> the words to show in the rail.
  // Any id not listed falls back to a title-cased version of itself, so a
  // new section still appears rather than silently going missing.
  var LABELS = {
    top: 'Overview',
    about: 'The building',
    ascent: 'The ascent',
    arrival: 'The arrival',
    aday: 'A day here',
    model: 'Model unit',
    built: 'Built',
    design: 'Design',
    service: 'Service',
    deliverables: 'What you get',
    towers: 'The towers',
    residences: 'Residences',
    gallery: 'Gallery',
    address: 'Location',
    enquire: 'Enquire'
  };

  var main = document.querySelector('main');
  if (!main) return;

  // The hero is a <header>, the rest are <section>s. Both carry an id.
  var sections = Array.prototype.filter.call(
    main.querySelectorAll('header[id], section[id]'),
    function (el) { return el.id && el.offsetParent !== null; }
  );
  if (sections.length < 3) return;   // not a property page

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function labelFor(el) {
    if (el.dataset.nav) return el.dataset.nav;
    if (LABELS[el.id]) return LABELS[el.id];
    return el.id.charAt(0).toUpperCase() + el.id.slice(1).replace(/-/g, ' ');
  }

  // ── The rail ──────────────────────────────────────────────────────
  var rail = document.createElement('ul');
  rail.className = 'pres-rail';
  rail.setAttribute('aria-label', 'Sections of this page');

  var dots = sections.map(function (sec, i) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pres-dot';
    b.setAttribute('aria-label', 'Go to ' + labelFor(sec));
    var s = document.createElement('span');
    s.textContent = labelFor(sec);
    b.appendChild(s);
    b.addEventListener('click', function () { goTo(i); });
    li.appendChild(b);
    rail.appendChild(li);
    return b;
  });
  document.body.appendChild(rail);
  requestAnimationFrame(function () { rail.classList.add('ready'); });

  // ── Where are we? ─────────────────────────────────────────────────
  // The probe line sits just under the sticky navbar rather than at the
  // middle of the viewport, for two reasons: it matches where goTo()
  // parks a section, and a midpoint probe mis-reports any section
  // shorter than half a screen (#enquire is 396px) by pointing at
  // whatever follows it. An IntersectionObserver is no good here either
  // — the scroll set pieces are 520vh and several are on screen at once.
  //
  // `current` starts at -1, not 0: the paint below only runs when the
  // index changes, so seeding it at 0 would leave the rail unmarked on
  // load.
  var current = -1;
  function computeCurrent() {
    var probe = window.scrollY + navOffset() + 120;
    var idx = 0;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= probe) idx = i;
    }
    // The last section can be too short to ever reach the probe line, so
    // hitting the bottom of the document always means the final one.
    var docH = document.documentElement.scrollHeight;
    if (window.scrollY + window.innerHeight >= docH - 4) idx = sections.length - 1;

    if (idx !== current) {
      current = idx;
      for (var j = 0; j < dots.length; j++) {
        dots[j].setAttribute('aria-current', j === idx ? 'true' : 'false');
      }
    }
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { computeCurrent(); ticking = false; });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  computeCurrent();

  // ── Moving between sections ───────────────────────────────────────
  // The shell puts a sticky navbar over the top of the page, so land a
  // little below the section's own top or its first line hides under it.
  function navOffset() {
    var nav = document.getElementById('navbar');
    return nav ? nav.getBoundingClientRect().height : 0;
  }

  function goTo(i) {
    i = Math.max(0, Math.min(sections.length - 1, i));
    var y = sections[i].offsetTop - (i === 0 ? 0 : navOffset());
    window.scrollTo({ top: Math.max(0, y), behavior: reduce ? 'auto' : 'smooth' });
  }

  function next() { goTo(current + 1); }
  function prev() { goTo(current - 1); }

  // ── Keys ──────────────────────────────────────────────────────────
  // Presentation remotes send PageUp / PageDown, so those matter as much
  // as the arrows. Never hijack a key while the visitor is typing.
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable ||
              /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName))) return;

    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': case 'PageDown':
        e.preventDefault(); next(); break;
      case ' ':
        e.preventDefault(); (e.shiftKey ? prev : next)(); break;
      case 'ArrowUp': case 'ArrowLeft': case 'PageUp':
        e.preventDefault(); prev(); break;
      case 'Home':
        e.preventDefault(); goTo(0); break;
      case 'End':
        e.preventDefault(); goTo(sections.length - 1); break;
      default: return;
    }
    hideHint();
  });

  // ── One-time hint ─────────────────────────────────────────────────
  var hint = document.createElement('div');
  hint.className = 'pres-hint';
  hint.innerHTML = '<b>&larr;</b><b>&rarr;</b> or scroll to move through';
  document.body.appendChild(hint);

  var hintTimer = null;
  function hideHint() {
    hint.classList.remove('show');
    clearTimeout(hintTimer);
  }
  setTimeout(function () {
    if (window.scrollY < 40) {
      hint.classList.add('show');
      hintTimer = setTimeout(hideHint, 5200);
    }
  }, 1600);
  window.addEventListener('scroll', function () {
    if (window.scrollY > 200) hideHint();
  }, { passive: true, once: false });
})();
