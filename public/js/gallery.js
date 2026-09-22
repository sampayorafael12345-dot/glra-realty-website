/* GLRA full-screen photo viewer. No dependencies.
 *
 *   window.GLRAGallery.open(images, startIndex, opts)
 *     images      array of URL strings or {src, alt}
 *     startIndex  number (clamped)
 *     opts        { title?: string, returnFocus?: Element }
 *   window.GLRAGallery.close()
 *
 * Swipe, pinch-zoom, double-tap / double-click zoom with pan, keyboard
 * (Left/Right, Home/End, Esc), thumbnail strip, focus trap and focus return.
 * Every URL goes into the DOM through element properties, never through
 * innerHTML, so a URL containing quotes cannot break out of anything.
 */
(function () {
  'use strict';
  if (window.GLRAGallery) return;

  var GAP = 24;           // px between slides while swiping
  var MAX_ZOOM = 4;
  var DOUBLE_ZOOM = 2.5;

  var CSS = [
    '.glg-root{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#0a0a0a;color:#f1eee9;',
    'font-family:Inter,system-ui,-apple-system,sans-serif;height:100vh;height:100dvh;',
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);',
    'opacity:0;transition:opacity .18s ease;-webkit-tap-highlight-color:transparent;overscroll-behavior:contain}',
    '.glg-root.glg-in{opacity:1}',
    '.glg-root:focus{outline:none}',
    '.glg-root *{box-sizing:border-box}',
    '.glg-top{display:flex;align-items:center;gap:12px;padding:10px 12px;flex:0 0 auto;min-height:64px}',
    '.glg-count{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;letter-spacing:2px;font-weight:700;',
    'border:2px solid rgba(241,238,233,.35);padding:8px 12px;white-space:nowrap}',
    '.glg-title{flex:1 1 auto;min-width:0;font-weight:800;font-size:15px;letter-spacing:-.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.glg-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;flex:0 0 auto;',
    'margin:0;padding:0;border:2px solid rgba(241,238,233,.35);border-radius:0;background:#0a0a0a;color:#f1eee9;cursor:pointer;',
    'font:700 12px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:1px;transition:background-color .15s,border-color .15s}',
    '.glg-btn:hover{background:#df3500;border-color:#df3500;color:#fff}',
    '.glg-btn:focus-visible{outline:3px solid #ff3d00;outline-offset:2px}',
    '.glg-btn[aria-pressed="true"]{background:#f1eee9;color:#0a0a0a;border-color:#f1eee9}',
    '.glg-btn svg{width:20px;height:20px;display:block;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:square}',
    '.glg-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}',
    '.glg-stage.glg-zoomed{cursor:move}',
    '.glg-track{position:absolute;inset:0;will-change:transform}',
    '.glg-track.glg-anim{transition:transform .32s cubic-bezier(.2,.7,.2,1)}',
    '.glg-slide{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:4px 8px}',
    '.glg-slide img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;transform-origin:50% 50%;',
    '-webkit-user-drag:none;user-select:none;pointer-events:auto;opacity:1;transition:opacity .2s ease;background:#1a1a17}',
    '.glg-slide img.glg-zanim{transition:transform .25s cubic-bezier(.2,.7,.2,1),opacity .2s ease}',
    '.glg-slide.glg-loading img{opacity:0}',
    '.glg-slide .glg-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-family:"JetBrains Mono",ui-monospace,monospace;',
    'font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(241,238,233,.6);display:none;text-align:center;pointer-events:none}',
    '.glg-slide.glg-loading .glg-msg{display:block}',
    '.glg-slide.glg-failed img{display:none}',
    '.glg-slide.glg-failed .glg-msg{display:block;border:2px solid rgba(241,238,233,.25);padding:28px 30px;background:#1a1a17;color:rgba(241,238,233,.75)}',
    '.glg-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:48px;height:64px}',
    '.glg-prev{left:10px}.glg-next{right:10px}',
    '.glg-single .glg-nav,.glg-single .glg-thumbs{display:none}',
    '.glg-foot{flex:0 0 auto;padding:8px 12px 12px}',
    '.glg-cap{font-size:13px;line-height:1.4;color:rgba(241,238,233,.8);text-align:center;min-height:18px;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.glg-thumbs{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;padding:2px;justify-content:safe center;overscroll-behavior:contain}',
    '.glg-thumb{flex:0 0 auto;width:80px;height:60px;padding:0;margin:0;border:2px solid transparent;background:#1a1a17;cursor:pointer;opacity:.55;border-radius:0;transition:opacity .15s,border-color .15s}',
    '.glg-thumb:hover{opacity:.9}',
    '.glg-thumb[aria-current="true"]{opacity:1;border-color:#ff3d00}',
    '.glg-thumb:focus-visible{outline:3px solid #ff3d00;outline-offset:1px}',
    '.glg-thumb img{display:block;width:100%;height:100%;object-fit:cover}',
    '.glg-thumb.glg-tfail img{visibility:hidden}',
    '@media (max-height:520px){.glg-thumbs{display:none}.glg-top{min-height:52px;padding:4px 10px}.glg-foot{padding:4px 10px 6px}}',
    '@media (max-width:600px){.glg-nav{width:40px;height:52px;background:rgba(10,10,10,.6)}.glg-prev{left:4px}.glg-next{right:4px}',
    '.glg-title{font-size:13px}.glg-thumb{width:64px;height:48px}.glg-zoombtn{display:none}}',
    '@media (hover:none){.glg-btn:hover{background:#0a0a0a;border-color:rgba(241,238,233,.35);color:#f1eee9}}',
    '@media (prefers-reduced-motion:reduce){.glg-root,.glg-track.glg-anim,.glg-slide img,.glg-slide img.glg-zanim,.glg-btn,.glg-thumb{transition:none}}'
  ].join('');

  function svg(path) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    return s;
  }
  var ICON_CLOSE = 'M5 5l14 14M19 5L5 19';
  var ICON_PREV = 'M15 4l-8 8 8 8';
  var ICON_NEXT = 'M9 4l8 8-8 8';
  var ICON_ZOOM = 'M10.5 4a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6';

  function injectCss() {
    if (document.getElementById('glg-css')) return;
    var st = document.createElement('style');
    st.id = 'glg-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // Cloudinary sizing. A plain f_auto,q_auto/ step some stored URLs already
  // carry is replaced; any other transformation is a deliberate crop and kept.
  var CLD = /^https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//i;
  function cld(u, t) {
    if (!CLD.test(u)) return u;
    u = u.replace('/upload/f_auto,q_auto/', '/upload/');
    if (/\/upload\/[a-z]{1,2}_/.test(u)) return u;
    return u.replace('/upload/', '/upload/' + t + '/');
  }
  function bigUrl(u) { return cld(u, 'f_auto,q_auto,c_limit,w_1800'); }
  function thumbUrl(u) { return cld(u, 'f_auto,q_auto,c_fill,w_160,h_120'); }

  function normalise(images) {
    var out = [];
    (Array.isArray(images) ? images : []).forEach(function (it) {
      var src = typeof it === 'string' ? it : (it && typeof it.src === 'string' ? it.src : '');
      src = src.trim();
      if (!src) return;
      out.push({ src: src, alt: (it && typeof it === 'object' && typeof it.alt === 'string') ? it.alt : '' });
    });
    return out;
  }

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function button(cls, label, icon) {
    var b = el('button', 'glg-btn ' + cls, { type: 'button', 'aria-label': label });
    if (icon) b.appendChild(svg(icon));
    return b;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  var S = null; // the open gallery's state; null while closed

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function wrap(i) { var n = S.items.length; return ((i % n) + n) % n; }

  // ── slides ───────────────────────────────────────────────
  function makeSlide() {
    var s = el('div', 'glg-slide');
    var img = el('img', '', { draggable: 'false', decoding: 'async' });
    var msg = el('div', 'glg-msg');
    s.appendChild(img); s.appendChild(msg);
    var slide = { el: s, img: img, msg: msg, idx: -1, token: 0 };
    img.addEventListener('load', function () {
      if (img.dataset.tok !== String(slide.token)) return;
      s.classList.remove('glg-loading');
    });
    img.addEventListener('error', function () {
      if (img.dataset.tok !== String(slide.token)) return;
      s.classList.remove('glg-loading');
      s.classList.add('glg-failed');
      msg.textContent = 'Photo unavailable';
    });
    return slide;
  }
  function fillSlide(slide, idx) {
    if (slide.idx === idx && slide.img.getAttribute('src')) return;
    slide.idx = idx;
    slide.token++;
    var it = S.items[idx];
    slide.el.classList.remove('glg-failed');
    slide.el.classList.add('glg-loading');
    slide.msg.textContent = 'Loading';
    slide.img.style.transform = '';
    slide.img.dataset.tok = String(slide.token);
    slide.img.alt = it.alt || ((S.title ? S.title + ', ' : '') + 'photo ' + (idx + 1) + ' of ' + S.items.length);
    slide.img.src = bigUrl(it.src);
    if (slide.img.complete && slide.img.naturalWidth) slide.el.classList.remove('glg-loading');
  }
  function placeSlides() {
    for (var k = 0; k < 3; k++) {
      S.slides[k].el.style.transform = 'translateX(calc(' + (k - 1) + ' * (100% + ' + GAP + 'px)))';
      S.slides[k].el.setAttribute('aria-hidden', k === 1 ? 'false' : 'true');
    }
  }
  function renderAround(idx) {
    var n = S.items.length;
    fillSlide(S.slides[1], idx);
    if (n > 1) {
      fillSlide(S.slides[0], wrap(idx - 1));
      fillSlide(S.slides[2], wrap(idx + 1));
      if (n > 3) { var pre = new Image(); pre.decoding = 'async'; pre.src = bigUrl(S.items[wrap(idx + 2)].src); }
    }
    S.slides[0].el.style.visibility = n > 1 ? '' : 'hidden';
    S.slides[2].el.style.visibility = n > 1 ? '' : 'hidden';
    placeSlides();
  }

  function updateChrome() {
    var n = S.items.length;
    S.count.textContent = (S.index + 1) + ' / ' + n;
    var it = S.items[S.index];
    S.cap.textContent = it.alt && it.alt !== S.title ? it.alt : '';
    S.cap.style.display = S.cap.textContent ? '' : 'none';
    if (S.thumbs.length) {
      S.thumbs.forEach(function (t, i) {
        if (i === S.index) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current');
      });
      var t = S.thumbs[S.index], strip = S.strip;
      if (t && strip.scrollWidth > strip.clientWidth) {
        var left = t.offsetLeft - (strip.clientWidth - t.offsetWidth) / 2;
        try { strip.scrollTo({ left: left, behavior: S.rm ? 'auto' : 'smooth' }); } catch (e) { strip.scrollLeft = left; }
      }
    }
  }

  // ── zoom ─────────────────────────────────────────────────
  function curImg() { return S.slides[1].img; }
  function applyZoom(anim) {
    var img = curImg();
    img.classList.toggle('glg-zanim', !!anim && !S.rm);
    img.style.transform = S.z.s === 1 && !S.z.x && !S.z.y ? '' :
      'translate(' + S.z.x + 'px,' + S.z.y + 'px) scale(' + S.z.s + ')';
    S.stage.classList.toggle('glg-zoomed', S.z.s > 1);
    S.zoomBtn.setAttribute('aria-pressed', S.z.s > 1 ? 'true' : 'false');
  }
  function clampPan() {
    var img = curImg();
    var w = img.offsetWidth * S.z.s, h = img.offsetHeight * S.z.s;
    var W = S.stage.clientWidth, H = S.stage.clientHeight;
    var mx = Math.max(0, (w - W) / 2), my = Math.max(0, (h - H) / 2);
    S.z.x = clamp(S.z.x, -mx, mx);
    S.z.y = clamp(S.z.y, -my, my);
  }
  // Point relative to the stage centre, which is also the image's centre at rest.
  function rel(cx, cy) {
    var r = S.stage.getBoundingClientRect();
    return { x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2) };
  }
  function zoomTo(s, px, py, anim) {
    var s0 = S.z.s;
    s = clamp(s, 1, MAX_ZOOM);
    if (s === 1) { S.z = { s: 1, x: 0, y: 0 }; applyZoom(anim); return; }
    var ux = (px - S.z.x) / s0, uy = (py - S.z.y) / s0;
    S.z.s = s; S.z.x = px - s * ux; S.z.y = py - s * uy;
    clampPan(); applyZoom(anim);
  }
  function resetZoom(anim) {
    if (S.z.s === 1 && !S.z.x && !S.z.y) return;
    S.z = { s: 1, x: 0, y: 0 }; applyZoom(anim);
  }
  function toggleZoomAt(cx, cy) {
    if (S.slides[1].el.classList.contains('glg-failed')) return;
    if (S.z.s > 1) { resetZoom(true); return; }
    var p = rel(cx, cy);
    zoomTo(DOUBLE_ZOOM, p.x, p.y, true);
  }

  // ── navigation ───────────────────────────────────────────
  function go(delta) {
    if (!S || S.items.length < 2 || S.busy) return;
    resetZoom(false);
    var track = S.track;
    var finish = function (e) {
      // transitionend bubbles: a photo fading in must not end the slide early.
      if (e && e.type === 'transitionend' && (e.target !== track || e.propertyName !== 'transform')) return;
      if (!S || !S.busy && !S.rm) return;
      clearTimeout(S.animTimer);
      track.removeEventListener('transitionend', finish);
      track.classList.remove('glg-anim');
      if (delta > 0) S.slides.push(S.slides.shift()); else S.slides.unshift(S.slides.pop());
      S.index = wrap(S.index + delta);
      track.style.transform = '';
      renderAround(S.index);
      updateChrome();
      S.busy = false;
    };
    if (S.rm) { finish(); return; }
    S.busy = true;
    track.classList.add('glg-anim');
    // Force the starting position to be committed before the transition.
    void track.offsetWidth;
    track.style.transform = 'translateX(calc(' + (delta > 0 ? -1 : 1) + ' * (100% + ' + GAP + 'px)))';
    track.addEventListener('transitionend', finish);
    S.animTimer = setTimeout(finish, 450);
  }
  function jump(idx) {
    if (!S) return;
    idx = clamp(idx | 0, 0, S.items.length - 1);
    if (idx === S.index) return;
    resetZoom(false);
    S.index = idx;
    // Reuse a slide that already holds the target so it does not reload.
    for (var k = 0; k < 3; k++) {
      if (S.slides[k].idx === idx && k !== 1) { var t = S.slides[1]; S.slides[1] = S.slides[k]; S.slides[k] = t; break; }
    }
    renderAround(idx);
    updateChrome();
  }
  function snapBack() {
    var track = S.track;
    if (S.rm) { track.style.transform = ''; return; }
    track.classList.add('glg-anim');
    track.style.transform = '';
    setTimeout(function () { track.classList.remove('glg-anim'); }, 340);
  }

  // ── pointer input: swipe, pan, pinch, double-tap ────────
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest && e.target.closest('.glg-btn')) return;
    var P = S.ptrs;
    P[e.pointerId] = { x: e.clientX, y: e.clientY };
    try { S.stage.setPointerCapture(e.pointerId); } catch (err) {}
    var ids = Object.keys(P);
    if (ids.length === 2) {
      var a = P[ids[0]], b = P[ids[1]];
      var mid = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
      S.g = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: S.z.s, ux: (mid.x - S.z.x) / S.z.s, uy: (mid.y - S.z.y) / S.z.s };
      S.track.style.transform = '';
      S.root.style.backgroundColor = '';
      S.stage.style.transform = '';
    } else if (ids.length === 1) {
      S.g = { mode: S.z.s > 1 ? 'pan' : 'swipe', x0: e.clientX, y0: e.clientY, t0: Date.now(), zx: S.z.x, zy: S.z.y, axis: '', moved: false, type: e.pointerType, onImg: e.target === curImg() };
    }
  }
  function onMove(e) {
    var P = S.ptrs;
    if (!P[e.pointerId] || !S.g) return;
    P[e.pointerId] = { x: e.clientX, y: e.clientY };
    var g = S.g;
    if (g.mode === 'pinch') {
      var ids = Object.keys(P);
      if (ids.length < 2) return;
      var a = P[ids[0]], b = P[ids[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      var mid = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
      var s = clamp(g.s0 * d / g.d0, 1, MAX_ZOOM);
      S.z.s = s; S.z.x = mid.x - s * g.ux; S.z.y = mid.y - s * g.uy;
      clampPan(); applyZoom(false);
      return;
    }
    var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (g.mode === 'pan') {
      S.z.x = g.zx + dx; S.z.y = g.zy + dy; clampPan(); applyZoom(false);
      return;
    }
    if (!g.axis && g.moved) g.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    if (g.axis === 'x') {
      var single = S.items.length < 2;
      S.track.style.transform = 'translateX(' + (single ? dx * 0.3 : dx) + 'px)';
    } else if (g.axis === 'y' && dy > 0) {
      // Pull down to close: the photo follows the finger and the backdrop fades.
      S.stage.style.transform = 'translateY(' + dy + 'px)';
      S.root.style.backgroundColor = 'rgba(10,10,10,' + Math.max(0.35, 1 - dy / 500) + ')';
    }
  }
  function onUp(e) {
    var P = S.ptrs;
    if (!P[e.pointerId]) return;
    delete P[e.pointerId];
    var g = S.g;
    if (!g) return;
    if (g.mode === 'pinch') {
      if (Object.keys(P).length === 0) {
        S.g = null;
        if (S.z.s < 1.05) resetZoom(true);
      } else {
        // One finger left on the glass: carry on as a pan from here.
        var id = Object.keys(P)[0];
        S.g = { mode: 'pan', x0: P[id].x, y0: P[id].y, zx: S.z.x, zy: S.z.y, moved: true, t0: Date.now() };
      }
      return;
    }
    S.g = null;
    var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    var dt = Math.max(1, Date.now() - g.t0);
    if (g.mode === 'swipe') {
      if (g.axis === 'x') {
        var W = S.stage.clientWidth;
        var fast = Math.abs(dx) / dt > 0.5 && Math.abs(dx) > 30;
        if (S.items.length > 1 && (Math.abs(dx) > Math.min(90, W * 0.18) || fast)) go(dx < 0 ? 1 : -1);
        else snapBack();
        return;
      }
      if (g.axis === 'y') {
        S.stage.style.transform = '';
        S.root.style.backgroundColor = '';
        if (dy > 110 || (dy > 50 && dy / dt > 0.6)) close();
        return;
      }
    }
    if (!g.moved && e.type === 'pointerup') tap(e, g);
  }
  function tap(e, g) {
    // Mouse users get the native dblclick event; touch and pen need it by hand.
    if (g.type === 'mouse') {
      if (!g.onImg && S.z.s === 1) { clearTimeout(S.tapTimer); S.tapTimer = setTimeout(function () { if (S) close(); }, 260); }
      return;
    }
    var now = Date.now(), last = S.lastTap;
    if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
      S.lastTap = null;
      toggleZoomAt(e.clientX, e.clientY);
    } else {
      S.lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
  function onDbl(e) {
    clearTimeout(S.tapTimer);
    if (e.target.closest && e.target.closest('.glg-btn')) return;
    e.preventDefault();
    toggleZoomAt(e.clientX, e.clientY);
  }
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      var p = rel(e.clientX, e.clientY);
      zoomTo(S.z.s * Math.exp(-e.deltaY / 200), p.x, p.y, false);
    } else if (S.z.s > 1) {
      S.z.x -= e.deltaX; S.z.y -= e.deltaY; clampPan(); applyZoom(false);
    }
  }

  // ── keyboard + focus trap ────────────────────────────────
  function focusables() {
    return Array.prototype.filter.call(
      S.root.querySelectorAll('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])'),
      function (n) { return n.offsetParent !== null || n === document.activeElement; });
  }
  function onKey(e) {
    if (!S) return;
    var k = e.key;
    if (k === 'Escape' || k === 'Esc') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (k === 'ArrowRight') { e.preventDefault(); go(1); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
    if (k === 'Home') { e.preventDefault(); jump(0); return; }
    if (k === 'End') { e.preventDefault(); jump(S.items.length - 1); return; }
    if (k === '+' || k === '=') { e.preventDefault(); zoomTo(S.z.s * 1.5, 0, 0, true); return; }
    if (k === '-' || k === '_') { e.preventDefault(); zoomTo(S.z.s / 1.5, 0, 0, true); return; }
    if (k === 'Tab') {
      var f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || a === S.root || !S.root.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !S.root.contains(a))) { e.preventDefault(); first.focus(); }
    }
  }
  function onFocusIn(e) {
    if (S && !S.root.contains(e.target)) { try { S.root.focus(); } catch (err) {} }
  }
  function onResize() {
    if (!S) return;
    resetZoom(false);
    S.track.style.transform = '';
  }

  // ── open / close ─────────────────────────────────────────
  function open(images, startIndex, opts) {
    var items = normalise(images);
    if (!items.length) return;
    if (S) close(true);
    opts = opts || {};
    injectCss();

    var title = typeof opts.title === 'string' ? opts.title.trim() : '';
    var root = el('div', 'glg-root', { role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
      'aria-label': title ? 'Photos: ' + title : 'Photo gallery' });
    if (items.length < 2) root.classList.add('glg-single');

    var top = el('div', 'glg-top');
    var count = el('div', 'glg-count', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    var ttl = el('div', 'glg-title');
    ttl.textContent = title;
    var zoomBtn = button('glg-zoombtn', 'Zoom', ICON_ZOOM);
    zoomBtn.setAttribute('aria-pressed', 'false');
    var closeBtn = button('glg-close', 'Close photos', ICON_CLOSE);
    top.appendChild(count); top.appendChild(ttl); top.appendChild(zoomBtn); top.appendChild(closeBtn);

    var stage = el('div', 'glg-stage');
    var track = el('div', 'glg-track');
    stage.appendChild(track);
    var prev = button('glg-nav glg-prev', 'Previous photo', ICON_PREV);
    var next = button('glg-nav glg-next', 'Next photo', ICON_NEXT);
    stage.appendChild(prev); stage.appendChild(next);

    var foot = el('div', 'glg-foot');
    var cap = el('div', 'glg-cap');
    foot.appendChild(cap);
    var strip = el('div', 'glg-thumbs', { role: 'group', 'aria-label': 'Choose a photo' });
    var thumbs = [];
    if (items.length > 1) {
      items.forEach(function (it, i) {
        var b = el('button', 'glg-thumb', { type: 'button', 'aria-label': 'Photo ' + (i + 1) + ' of ' + items.length });
        var im = el('img', '', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
        im.addEventListener('error', function () { b.classList.add('glg-tfail'); });
        im.src = thumbUrl(it.src);
        b.appendChild(im);
        b.addEventListener('click', function () { jump(i); });
        strip.appendChild(b);
        thumbs.push(b);
      });
      foot.appendChild(strip);
    }

    root.appendChild(top); root.appendChild(stage); root.appendChild(foot);

    S = {
      items: items, title: title, root: root, stage: stage, track: track, count: count, cap: cap,
      strip: strip, thumbs: thumbs, zoomBtn: zoomBtn, slides: [makeSlide(), makeSlide(), makeSlide()],
      index: clamp(Number(startIndex) | 0, 0, items.length - 1), z: { s: 1, x: 0, y: 0 },
      ptrs: {}, g: null, busy: false, rm: reducedMotion(), lastTap: null,
      returnFocus: opts.returnFocus && opts.returnFocus.focus ? opts.returnFocus : document.activeElement,
      inerted: [], lock: null
    };
    S.slides.forEach(function (s) { track.appendChild(s.el); });

    prev.addEventListener('click', function () { go(-1); });
    next.addEventListener('click', function () { go(1); });
    closeBtn.addEventListener('click', function () { close(); });
    zoomBtn.addEventListener('click', function () {
      if (S.z.s > 1) resetZoom(true); else zoomTo(DOUBLE_ZOOM, 0, 0, true);
    });
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('dblclick', onDbl);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dragstart', function (e) { e.preventDefault(); });

    // Scroll lock that survives iOS: fix the body in place and restore after.
    var de = document.documentElement, body = document.body;
    var sbw = window.innerWidth - de.clientWidth;
    S.lock = { y: window.scrollY || window.pageYOffset || 0, htmlOv: de.style.overflow, bodyOv: body.style.overflow, bodyPr: body.style.paddingRight };
    de.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    if (sbw > 0) body.style.paddingRight = sbw + 'px';

    body.appendChild(root);
    // Everything else on the page is taken out of reach while the viewer is up.
    Array.prototype.forEach.call(body.children, function (n) {
      if (n === root || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
      if (n.hasAttribute('inert') || n.getAttribute('aria-hidden') === 'true') return;
      n.setAttribute('inert', ''); n.setAttribute('aria-hidden', 'true');
      S.inerted.push(n);
    });

    renderAround(S.index);
    updateChrome();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('resize', onResize);
    var show = function () { if (S && S.root === root) root.classList.add('glg-in'); };
    requestAnimationFrame(show);
    setTimeout(show, 60); // rAF does not run in a background tab
    try { root.focus({ preventScroll: true }); } catch (e) { root.focus(); }
  }

  function close(silent) {
    if (!S) return;
    var st = S;
    S = null;
    clearTimeout(st.animTimer); clearTimeout(st.tapTimer);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('resize', onResize);
    st.inerted.forEach(function (n) { n.removeAttribute('inert'); n.removeAttribute('aria-hidden'); });
    if (st.root.parentNode) st.root.parentNode.removeChild(st.root);
    var de = document.documentElement, body = document.body;
    de.style.overflow = st.lock.htmlOv;
    body.style.overflow = st.lock.bodyOv;
    body.style.paddingRight = st.lock.bodyPr;
    if (Math.abs((window.scrollY || 0) - st.lock.y) > 1) window.scrollTo(0, st.lock.y);
    if (!silent && st.returnFocus && document.contains(st.returnFocus)) {
      try { st.returnFocus.focus({ preventScroll: true }); } catch (e) { try { st.returnFocus.focus(); } catch (e2) {} }
    }
  }

  window.GLRAGallery = { open: open, close: function () { close(); } };
})();
