/* Shared map helpers for the browse page (properties.html) and the listing
   pages server.js renders:
   - loadLeaflet(): Leaflet from cdnjs with SRI, once.
   - osm(map): OpenStreetMap tiles (the tile policy needs a Referer, so the
     site-wide no-referrer header is overridden for the tiles only).
   - floodToggle(map, on): UP NOAH 100-year flood hazard layer. PMTiles on
     Hugging Face (ODbL), read by range requests through protomaps-leaflet.
   - neighbourhood(el): the listing page map of what's nearby.
   Everything loads only when a map is actually shown. */
(function () {
  'use strict';
  var ASSETS = {
    leafletCss: ['link', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw=='],
    leafletJs: ['script', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g=='],
    protomaps: ['script', 'https://cdn.jsdelivr.net/npm/protomaps-leaflet@5.1.0/dist/protomaps-leaflet.js', 'sha512-KVJuc8RAjKfNZudBzi9HIKiMpHwkyWAXdL7J4nm5aUQWRYDTews2du44+b59Ig2twCXUWmZn1dsD19kiMG5UcA==']
  };
  var FLOOD_URL = 'https://huggingface.co/datasets/bettergovph/project-noah-hazard-maps/resolve/main/PMTiles/layers/flood_100yr.pmtiles';
  var FLOOD_COLOURS = { 1: '#8ec5ff', 2: '#2f7de1', 3: '#0b2f8a' };
  var loading = {};

  function loadAsset(a) {
    if (loading[a[1]]) return loading[a[1]];
    loading[a[1]] = new Promise(function (res, rej) {
      var el = document.createElement(a[0]);
      if (a[0] === 'link') { el.rel = 'stylesheet'; el.href = a[1]; }
      else { el.src = a[1]; el.async = false; }
      el.integrity = a[2];
      el.crossOrigin = 'anonymous';
      el.referrerPolicy = 'no-referrer';
      el.onload = function () { res(); };
      el.onerror = function () { el.remove(); delete loading[a[1]]; rej(new Error('Could not load ' + a[1])); };
      document.head.appendChild(el);
    });
    return loading[a[1]];
  }
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    return Promise.all([loadAsset(ASSETS.leafletCss), loadAsset(ASSETS.leafletJs)]);
  }
  function osm(map) {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(map);
  }
  /* The two pages have different stylesheets, so the map pieces carry their own. */
  var CSS =
    '.glra-flood-legend{background:#f1eee9;color:#0a0a0a;border:2px solid #0a0a0a;padding:9px 11px;max-width:230px;font:12px/1.4 Inter,system-ui,sans-serif;box-shadow:3px 3px 0 #0a0a0a}' +
    'body.dark-mode .glra-flood-legend{background:#0e0e0c;color:#f1eee9;border-color:#3a3a36;box-shadow:3px 3px 0 #3a3a36}' +
    '.glra-flood-legend-t{font:700 10px/1.3 "JetBrains Mono",monospace;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:6px}' +
    '.glra-flood-legend ul{list-style:none;margin:0 0 6px;padding:0}' +
    '.glra-flood-legend li{display:flex;align-items:center;gap:7px;margin:3px 0;font-size:12px}' +
    '.glra-flood-legend li i{display:inline-block;width:14px;height:14px;border:1px solid rgba(0,0,0,.35);flex:0 0 14px}' +
    '.glra-flood-legend p{margin:0;font-size:11px;line-height:1.4;opacity:.8}' +
    '.glra-flood-legend a{color:inherit;text-decoration:underline}' +
    '@media(max-width:560px){.glra-flood-legend{max-width:190px;padding:7px 9px}.glra-flood-legend p{display:none}}' +
    '.glra-nb-home-wrap,.glra-nb-poi-wrap{background:none;border:0}' +
    '.glra-nb-home{display:flex;align-items:center;justify-content:center;width:34px;height:34px;background:#ff3d00;color:#fff;border:2px solid #0a0a0a;box-shadow:2px 2px 0 #0a0a0a;font-size:14px}' +
    '.glra-nb-poi{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#0a0a0a;color:#fff;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);font-size:11px}' +
    '.glra-nb-rail{background:#6d28d9}.glra-nb-mall{background:#c2410c}.glra-nb-hospital{background:#b91c1c}.glra-nb-school{background:#15803d}' +
    '.glra-nb-fail{padding:24px;text-align:center;font-size:14px}';
  function injectCss() {
    if (document.getElementById('glraMapsCss')) return;
    var st = document.createElement('style');
    st.id = 'glraMapsCss';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  injectCss();
  function reduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Flood hazard ─────────────────────────────────────────── */
  var LEGEND_HTML =
    '<div class="glra-flood-legend-t">Flood hazard, 100-year rain</div>' +
    '<ul>' +
    '<li><i style="background:' + FLOOD_COLOURS[1] + '"></i>Low: up to 0.5 m</li>' +
    '<li><i style="background:' + FLOOD_COLOURS[2] + '"></i>Medium: 0.5 to 1.5 m</li>' +
    '<li><i style="background:' + FLOOD_COLOURS[3] + '"></i>High: over 1.5 m</li>' +
    '</ul>' +
    '<p>No colour: outside the mapped flood areas. The map shows the street, not the unit; upper floors stay dry but access can flood. Source: <a href="https://noah.up.edu.ph" target="_blank" rel="noopener">UP NOAH</a>.</p>';

  function floodLayer(map) {
    if (map._glraFlood) return map._glraFlood;
    if (!map.getPane('glraFlood')) {
      var pane = map.createPane('glraFlood');
      pane.style.zIndex = 250; /* above the base tiles (200), below pins (600) */
      pane.style.pointerEvents = 'none';
    }
    map._glraFlood = protomapsL.leafletLayer({
      url: FLOOD_URL,
      pane: 'glraFlood',
      maxDataZoom: 14,
      paintRules: [{
        dataLayer: 'flood_100yr',
        symbolizer: new protomapsL.PolygonSymbolizer({
          fill: function (z, f) { return FLOOD_COLOURS[f.props.Var] || 'rgba(0,0,0,0)'; },
          opacity: 0.55
        })
      }],
      labelRules: [],
      attribution: 'Flood hazard &copy; <a href="https://noah.up.edu.ph" target="_blank" rel="noopener">UP NOAH</a> (ODbL)'
    });
    return map._glraFlood;
  }
  function floodLegend(map, show) {
    if (!map._glraFloodLegend) {
      var Legend = L.Control.extend({
        options: { position: 'bottomleft' },
        onAdd: function () {
          var d = L.DomUtil.create('div', 'glra-flood-legend');
          d.innerHTML = LEGEND_HTML;
          L.DomEvent.disableClickPropagation(d);
          L.DomEvent.disableScrollPropagation(d);
          return d;
        }
      });
      map._glraFloodLegend = new Legend();
    }
    if (show) map._glraFloodLegend.addTo(map); else map._glraFloodLegend.remove();
  }
  /* Resolves true when the layer is on, false when switched off. */
  function floodToggle(map, on) {
    if (!on) {
      if (map._glraFlood) map.removeLayer(map._glraFlood);
      floodLegend(map, false);
      return Promise.resolve(false);
    }
    return loadAsset(ASSETS.protomaps).then(function () {
      floodLayer(map).addTo(map);
      floodLegend(map, true);
      return true;
    });
  }
  /* Wires a <button aria-pressed> to the flood layer on a map. */
  function floodButton(btn, getMap) {
    if (!btn || btn._glraFlood) return;
    btn._glraFlood = true;
    var label = btn.innerHTML;
    btn.addEventListener('click', function () {
      var map = getMap();
      if (!map) return;
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.disabled = true;
      if (on) btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading';
      floodToggle(map, on).then(function (state) {
        btn.setAttribute('aria-pressed', state ? 'true' : 'false');
        btn.innerHTML = label;
      }).catch(function () {
        btn.innerHTML = label;
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'The flood map could not load. Try again later.';
      }).then(function () { btn.disabled = false; });
    });
  }

  function streetViewUrl(lat, lng) {
    return 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
  }

  /* ── Listing page: what's nearby, on a map ──────────────────── */
  var CAT_ICON = { rail: 'fa-train-subway', mall: 'fa-bag-shopping', hospital: 'fa-hospital', school: 'fa-graduation-cap' };
  function fmtDist(m) {
    return m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km';
  }
  function neighbourhood(el) {
    if (!el || el._glraMap) return;
    var lat = Number(el.getAttribute('data-lat')), lng = Number(el.getAttribute('data-lng'));
    if (!isFinite(lat) || !isFinite(lng)) return;
    var pts = [];
    try { pts = JSON.parse(el.getAttribute('data-points') || '[]'); } catch (e) { pts = []; }
    el._glraMap = true;
    loadLeaflet().then(function () {
      var r = reduced();
      var map = L.map(el, { scrollWheelZoom: false, zoomAnimation: !r, fadeAnimation: !r, markerZoomAnimation: !r }).setView([lat, lng], 15);
      map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
      osm(map);
      var home = L.marker([lat, lng], {
        icon: L.divIcon({ className: 'glra-nb-home-wrap', html: '<span class="glra-nb-home"><i class="fas fa-house" aria-hidden="true"></i></span>', iconSize: [34, 34], iconAnchor: [17, 17] }),
        title: 'This listing (approximate)', keyboard: true, zIndexOffset: 1000
      }).addTo(map);
      home.bindTooltip('This listing (approximate location)', { direction: 'top', offset: [0, -16] });
      var bounds = [[lat, lng]];
      pts.forEach(function (p) {
        if (!isFinite(p.lat) || !isFinite(p.lng)) return;
        var mk = L.marker([p.lat, p.lng], {
          icon: L.divIcon({ className: 'glra-nb-poi-wrap', html: '<span class="glra-nb-poi glra-nb-' + esc(p.cat) + '"><i class="fas ' + (CAT_ICON[p.cat] || 'fa-location-dot') + '" aria-hidden="true"></i></span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
          title: p.name + ', ' + fmtDist(p.dist), keyboard: true
        }).addTo(map);
        mk.bindTooltip('<b>' + esc(p.name) + '</b><br>' + esc(fmtDist(p.dist)), { direction: 'top', offset: [0, -12] });
        bounds.push([p.lat, p.lng]);
      });
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16, animate: false });
      /* Scroll-wheel zoom only once the visitor has clicked into the map,
         so the page still scrolls past it. */
      map.once('focus click', function () { map.scrollWheelZoom.enable(); });
      floodButton(document.getElementById('pgFloodBtn'), function () { return map; });
      el.classList.add('is-ready');
    }).catch(function () {
      el.classList.add('is-failed');
      el.innerHTML = '<p class="glra-nb-fail">The map could not load. Check your connection and reload the page.</p>';
    });
  }
  function autoNeighbourhood() {
    var el = document.getElementById('pgNearMap');
    if (!el) return;
    if (!('IntersectionObserver' in window)) { neighbourhood(el); return; }
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); neighbourhood(el); }
    }, { rootMargin: '400px 0px' });
    io.observe(el);
  }

  window.GLRAMaps = {
    loadLeaflet: loadLeaflet,
    loadAsset: loadAsset,
    osm: osm,
    floodToggle: floodToggle,
    floodButton: floodButton,
    streetViewUrl: streetViewUrl,
    neighbourhood: neighbourhood
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoNeighbourhood);
  else autoNeighbourhood();
})();
