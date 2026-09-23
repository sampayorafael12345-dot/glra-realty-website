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
    '.glra-nb-fail{padding:24px;text-align:center;font-size:14px}' +
    /* Full screen: beats the pages' own sizing (sticky map pane, fixed heights). */
    '.glra-full{position:fixed !important;inset:0 !important;top:0 !important;left:0 !important;width:100% !important;height:100% !important;height:100dvh !important;max-height:none !important;min-height:0 !important;margin:0 !important;border:0 !important;box-shadow:none !important;z-index:2147482000 !important;background:#e8e4dd}' +
    '.glra-full #mapCanvas{height:100% !important}' +
    'body.dark-mode .glra-full{background:#1a1a17}' +
    'html.glra-full-open,html.glra-full-open body{overflow:hidden !important}' +
    '.glra-fs-ctl{border:2px solid #0a0a0a !important;border-radius:0 !important;box-shadow:3px 3px 0 #0a0a0a !important}' +
    'body.dark-mode .glra-fs-ctl{border-color:#3a3a36 !important;box-shadow:3px 3px 0 #3a3a36 !important}' +
    'html body .glra-fs-btn{display:flex !important;align-items:center !important;justify-content:center !important;width:38px !important;height:38px !important;padding:0 !important;margin:0 !important;border:0 !important;border-radius:0 !important;background:#f1eee9 !important;color:#0a0a0a !important;font-size:15px !important;cursor:pointer !important;box-shadow:none !important;transform:none !important}' +
    'body.dark-mode .glra-fs-btn{background:#0e0e0c !important;color:#f1eee9 !important}' +
    'html body .glra-fs-btn:hover{background:#ff3d00 !important;color:#fff !important}' +
    'html body .glra-fs-btn:focus-visible{outline:3px solid #ff3d00 !important;outline-offset:2px !important}' +
    '.glra-map-logo{display:block;margin:0 10px 6px 0 !important;background:rgba(241,238,233,.92);border:2px solid #0a0a0a;box-shadow:2px 2px 0 #0a0a0a;line-height:0}' +
    '.glra-map-logo img{width:74px;height:40px;object-fit:cover;object-position:50% 46%;display:block}' +
    '.glra-map-logo .glra-map-logo-d{display:none}' +
    'body.dark-mode .glra-map-logo{background:rgba(14,14,12,.9);border-color:#3a3a36;box-shadow:2px 2px 0 #3a3a36}' +
    'body.dark-mode .glra-map-logo .glra-map-logo-l{display:none}body.dark-mode .glra-map-logo .glra-map-logo-d{display:block}' +
    '@media(max-width:560px){.glra-map-logo img{width:60px;height:32px}}' +
    /* Legend rows shared by the train, fault, travel-time and sun panels. */
    '.glra-lg-row{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0 0 6px}' +
    '.glra-lg-row span{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;white-space:nowrap}' +
    '.glra-lg-line{display:inline-block;width:22px;height:0;border-top:4px solid currentColor}' +
    '.glra-lg-line.is-dash{border-top-style:dashed;border-top-width:3px}' +
    '.glra-lg-sw{display:inline-block;width:14px;height:14px;border:1px solid rgba(0,0,0,.35)}' +
    '.glra-lg-sub{font:700 9.5px/1.3 "JetBrains Mono",monospace;letter-spacing:1px;text-transform:uppercase;opacity:.75;margin:2px 0 4px}' +
    '.glra-flood-legend .glra-lg-seg{display:flex;gap:0;margin:0 0 8px;border:2px solid #0a0a0a}' +
    'body.dark-mode .glra-flood-legend .glra-lg-seg{border-color:#f1eee9}' +
    'html body .glra-flood-legend .glra-lg-seg button{flex:1 1 0 !important;min-height:30px !important;padding:0 8px !important;margin:0 !important;border:0 !important;border-radius:0 !important;background:transparent !important;color:inherit !important;font:700 10px/1 "JetBrains Mono",monospace !important;letter-spacing:1px !important;text-transform:uppercase !important;box-shadow:none !important;transform:none !important;cursor:pointer !important;display:flex !important;align-items:center !important;justify-content:center !important;gap:6px !important}' +
    'html body .glra-flood-legend .glra-lg-seg button[aria-pressed="true"]{background:#0a0a0a !important;color:#f1eee9 !important}' +
    'body.dark-mode .glra-flood-legend .glra-lg-seg button[aria-pressed="true"]{background:#f1eee9 !important;color:#0a0a0a !important}' +
    '.glra-flood-legend input[type=range]{width:100%;margin:4px 0 2px;accent-color:#ff3d00}' +
    '.glra-sun-read{font-size:12px;font-weight:600;margin:0 0 4px}' +
    /* Arthaland buildings: a labelled tower badge, not a price pin. */
    '.glra-ah-wrap{background:none;border:0}' +
    '.glra-ah{position:absolute;left:0;bottom:0;transform:translate(-50%,-6px);display:inline-flex;align-items:center;gap:6px;padding:5px 9px 5px 6px;background:#0a0a0a;color:#f1eee9;border:2px solid var(--ac,#c99a4e);box-shadow:2px 2px 0 rgba(0,0,0,.35);font:700 11px/1 Inter,system-ui,sans-serif;white-space:nowrap;cursor:pointer}' +
    '.glra-ah::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:var(--ac,#c99a4e)}' +
    '.glra-ah i{display:flex;align-items:center;justify-content:center;width:18px;height:18px;background:var(--ac,#c99a4e);color:#0a0a0a;font-size:10px}' +
    '.glra-ah-wrap:hover .glra-ah,.glra-ah-wrap:focus-visible .glra-ah{background:var(--ac,#c99a4e);color:#0a0a0a}' +
    '.glra-ah b{font-weight:700}.glra-ah-far .glra-ah{padding:3px;gap:0}.glra-ah-far .glra-ah b{display:none}' +
    '.glra-ah-far .glra-ah-wrap:hover .glra-ah b,.glra-ah-far .glra-ah-wrap:focus-visible .glra-ah b{display:inline;margin:0 4px 0 6px}' +
    '.glra-ah-wrap:focus-visible{outline:none}.glra-ah-wrap:focus-visible .glra-ah{outline:3px solid #ff3d00;outline-offset:2px}' +
    '.glra-ah-pop .leaflet-popup-content-wrapper{border-radius:0;padding:0;overflow:hidden;border:2px solid #0a0a0a;box-shadow:4px 4px 0 #0a0a0a}' +
    '.glra-ah-pop .leaflet-popup-content{margin:0;width:250px !important}' +
    '.glra-ah-card img{display:block;width:100%;height:130px;object-fit:cover}' +
    '.glra-ah-card div{padding:10px 12px 12px;font:12.5px/1.45 Inter,system-ui,sans-serif;color:#0a0a0a}' +
    '.glra-ah-card small{display:block;font:700 9.5px/1.3 "JetBrains Mono",monospace;letter-spacing:1.2px;text-transform:uppercase;color:#6b665e;margin-bottom:3px}' +
    '.glra-ah-card b{display:block;font-size:17px;line-height:1.15;margin-bottom:2px}' +
    '.glra-ah-card a{display:inline-flex;margin-top:8px;padding:7px 10px;background:#0a0a0a;color:#f1eee9 !important;text-decoration:none;font:700 10px/1 "JetBrains Mono",monospace;letter-spacing:1.2px;text-transform:uppercase}' +
    '.glra-ah-card a:hover{background:#ff3d00}' +
    /* Sun path labels. */
    '.glra-sun-lbl-wrap{background:none;border:0}' +
    '.glra-sun-lbl{position:absolute;transform:translate(-50%,-50%);font:700 10px/1 "JetBrains Mono",monospace;letter-spacing:.5px;color:#0a0a0a;background:rgba(241,238,233,.9);padding:2px 4px;white-space:nowrap}' +
    '.glra-sun-lbl.is-sun{background:#ffb300;color:#0a0a0a;border-radius:50%;width:22px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 4px rgba(255,179,0,.35)}' +
    /* 3D view overlay. */
    '.glra-3d{position:fixed;inset:0;z-index:2147482500;background:#0e0e0c;display:flex;flex-direction:column}' +
    '.glra-3d-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#0a0a0a;color:#f1eee9;font:700 11px/1.3 "JetBrains Mono",monospace;letter-spacing:1.2px;text-transform:uppercase}' +
    '.glra-3d-bar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    'html body .glra-3d-bar button{min-height:38px !important;padding:0 12px !important;margin:0 !important;background:#f1eee9 !important;color:#0a0a0a !important;border:0 !important;border-radius:0 !important;font:700 10.5px/1 "JetBrains Mono",monospace !important;letter-spacing:1.2px !important;display:inline-flex !important;align-items:center !important;gap:7px !important;box-shadow:none !important;transform:none !important}' +
    'html body .glra-3d-bar button:hover{background:#ff3d00 !important;color:#fff !important}' +
    'html body .glra-3d-bar button[aria-pressed="true"]{background:#1f5fbf !important;color:#fff !important}' +
    '.glra-3d-map{flex:1;min-height:0;position:relative}' +
    '.glra-3d-note{position:absolute;left:10px;bottom:28px;z-index:2;max-width:300px;background:rgba(241,238,233,.94);color:#0a0a0a;padding:7px 9px;font:11px/1.4 Inter,system-ui,sans-serif;border:2px solid #0a0a0a}' +
    '.glra-3d-pin{width:34px;height:34px;display:flex;align-items:center;justify-content:center;background:#ff3d00;color:#fff;border:2px solid #0a0a0a;box-shadow:2px 2px 0 #0a0a0a;font-size:14px}' +
    '.glra-3d-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#f1eee9;font:14px/1.5 Inter,system-ui,sans-serif;text-align:center;padding:24px}' +
    '@media(max-width:560px){.glra-3d-bar{padding:8px 10px;gap:6px}html body .glra-3d-bar button b{display:none}.glra-3d-note{right:10px;max-width:none}}' +
    /* Home page map: listing dots. */
    '.glra-dot-wrap{background:none;border:0}' +
    '.glra-dot{display:block;width:16px;height:16px;border-radius:50%;background:#ff3d00;border:3px solid #fff;box-shadow:0 0 0 1.5px #0a0a0a,0 2px 4px rgba(0,0,0,.35)}' +
    '.glra-dot.is-lease{background:#1f5fbf}' +
    '.glra-dot-wrap:hover .glra-dot,.glra-dot-wrap:focus-visible .glra-dot{transform:scale(1.3)}';
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
  /* Wires a <button aria-pressed> to a layer switch: toggle(map, on) returns
     a promise of the new state. The button shows "Loading" while it works. */
  function layerButton(btn, getMap, toggle, failMsg) {
    if (!btn || btn._glraLayer) return;
    btn._glraLayer = true;
    var label = btn.innerHTML;
    btn.addEventListener('click', function () {
      var map = getMap();
      if (!map) return;
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.disabled = true;
      if (on) btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> <span>Loading</span>';
      Promise.resolve().then(function () { return toggle(map, on); }).then(function (state) {
        btn.setAttribute('aria-pressed', state ? 'true' : 'false');
        btn.innerHTML = label;
      }).catch(function () {
        btn.innerHTML = label;
        btn.setAttribute('aria-pressed', 'false');
        btn.title = failMsg || 'This layer could not load. Try again later.';
      }).then(function () { btn.disabled = false; });
    });
  }
  function floodButton(btn, getMap) {
    layerButton(btn, getMap, floodToggle, 'The flood map could not load. Try again later.');
  }

  /* A bottom-left legend box, one per key per map. */
  function legend(map, key, html, show) {
    var k = '_glraLg_' + key;
    if (!map[k]) {
      var Legend = L.Control.extend({
        options: { position: 'bottomleft' },
        onAdd: function () {
          var d = L.DomUtil.create('div', 'glra-flood-legend glra-lg-' + key);
          d.innerHTML = html;
          L.DomEvent.disableClickPropagation(d);
          L.DomEvent.disableScrollPropagation(d);
          return d;
        }
      });
      map[k] = new Legend();
    }
    if (show) map[k].addTo(map); else map[k].remove();
    return map[k];
  }
  function pane(map, name, z) {
    if (!map.getPane(name)) {
      var p = map.createPane(name);
      p.style.zIndex = z;
    }
    return name;
  }
  var jsonCache = {};
  function getJson(url) {
    if (!jsonCache[url]) {
      jsonCache[url] = fetch(url, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function (e) { delete jsonCache[url]; throw e; });
    }
    return jsonCache[url];
  }

  /* ── Trains ───────────────────────────────────────────────────
     /data/rail.geojson: OpenStreetMap, extracted and simplified in Sept 2026.
     Solid: carrying passengers. Dashed: still being built. */
  var RAIL_URL = '/data/rail.geojson?v=1';
  var RAIL_LINES = {
    lrt1: ['LRT-1', '#1c9a45'], lrt2: ['LRT-2', '#7a3fb8'], mrt3: ['MRT-3', '#d99a00'],
    mrt7: ['MRT-7', '#d62d20'], subway: ['Metro Manila Subway', '#1f4fd1'], nscr: ['North-South Commuter Railway', '#0e8a7a']
  };
  var RAIL_LEGEND =
    '<div class="glra-flood-legend-t">Trains</div>' +
    '<div class="glra-lg-sub">Running</div><div class="glra-lg-row">' +
    ['lrt1', 'lrt2', 'mrt3'].map(function (k) { return '<span><i class="glra-lg-line" style="color:' + RAIL_LINES[k][1] + '"></i>' + RAIL_LINES[k][0] + '</span>'; }).join('') + '</div>' +
    '<div class="glra-lg-sub">Being built</div><div class="glra-lg-row">' +
    [['subway', 'Subway'], ['nscr', 'NSCR'], ['mrt7', 'MRT-7']].map(function (k) { return '<span><i class="glra-lg-line is-dash" style="color:' + RAIL_LINES[k[0]][1] + '"></i>' + k[1] + '</span>'; }).join('') + '</div>' +
    '<p>Dashed lines and hollow stations are not open yet; their routes and stations can still change. Source: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>.</p>';
  function railLayer(map) {
    if (map._glraRail) return Promise.resolve(map._glraRail);
    var pn = pane(map, 'glraRail', 380);
    return getJson(RAIL_URL).then(function (gj) {
      function isLine(f) { return f.properties.t === 'line'; }
      function col(f) { return (RAIL_LINES[f.properties.line] || ['', '#555'])[1]; }
      function nm(f) { return (RAIL_LINES[f.properties.line] || ['Train line'])[0]; }
      var casing = L.geoJSON(gj, {
        pane: pn, interactive: false,
        filter: function (f) { return isLine(f) && f.properties.s === 'run'; },
        style: function () { return { color: '#ffffff', weight: 8, opacity: 0.85, lineCap: 'round' }; }
      });
      var lines = L.geoJSON(gj, {
        pane: pn, filter: isLine,
        style: function (f) {
          var run = f.properties.s === 'run';
          return { color: col(f), weight: run ? 5 : 4, opacity: run ? 1 : 0.9, dashArray: run ? null : '9 7', lineCap: run ? 'round' : 'butt' };
        },
        onEachFeature: function (f, l) { l.bindTooltip(esc(nm(f)) + (f.properties.s === 'run' ? '' : ', being built'), { sticky: true }); }
      });
      var stations = L.geoJSON(gj, {
        pane: pn,
        filter: function (f) { return f.properties.t === 'stn'; },
        pointToLayer: function (f, ll) {
          var run = f.properties.s === 'run';
          return L.circleMarker(ll, { pane: pn, radius: run ? 5 : 4.5, color: col(f), weight: 3, fillColor: run ? '#ffffff' : col(f), fillOpacity: run ? 1 : 0.18 });
        },
        onEachFeature: function (f, l) {
          l.bindTooltip('<b>' + esc(f.properties.n) + '</b><br>' + esc(nm(f)) + (f.properties.s === 'run' ? ' station' : ', not open yet'), { direction: 'top', offset: [0, -4] });
        }
      });
      map._glraRail = L.layerGroup([casing, lines, stations]);
      /* Station dots only once zoomed in to district level: from further
         out they pile up into a solid bead along each line. */
      function dots() {
        var on = map.hasLayer(map._glraRail) && map.getZoom() >= 12;
        if (on && !map._glraRail.hasLayer(stations)) map._glraRail.addLayer(stations);
        if (!on && map._glraRail.hasLayer(stations)) map._glraRail.removeLayer(stations);
      }
      map.on('zoomend', dots);
      map._glraRail.on('add', function () { setTimeout(dots, 0); });
      return map._glraRail;
    });
  }
  function railToggle(map, on) {
    if (!on) {
      if (map._glraRail) map.removeLayer(map._glraRail);
      legend(map, 'rail', RAIL_LEGEND, false);
      return Promise.resolve(false);
    }
    return railLayer(map).then(function (layer) {
      layer.addTo(map);
      legend(map, 'rail', RAIL_LEGEND, true);
      return true;
    });
  }

  /* ── Active faults ────────────────────────────────────────────
     /data/faults.geojson: the Philippines catalogue of the GEM Global Active
     Faults Database (CC BY-SA 4.0), simplified. Regional-scale lines, so the
     legend says plainly that they are approximate. */
  var FAULT_URL = '/data/faults.geojson?v=1';
  var FAULT_LEGEND =
    '<div class="glra-flood-legend-t">Active faults</div>' +
    '<div class="glra-lg-row"><span><i class="glra-lg-line" style="color:#c8102e"></i>Mapped active fault</span></div>' +
    '<p>Lines are approximate and can be off by a few hundred metres. For a specific address, check PHIVOLCS data on <a href="https://hazardhunter.georisk.gov.ph/" target="_blank" rel="noopener">HazardHunterPH</a>. Source: <a href="https://github.com/GEMScienceTools/gem-global-active-faults" target="_blank" rel="noopener">GEM Global Active Faults</a> (CC BY-SA 4.0).</p>';
  function faultLayer(map) {
    if (map._glraFault) return Promise.resolve(map._glraFault);
    var pn = pane(map, 'glraFault', 370);
    return getJson(FAULT_URL).then(function (gj) {
      map._glraFault = L.geoJSON(gj, {
        pane: pn,
        style: function () { return { color: '#c8102e', weight: 3.5, opacity: 0.9 }; },
        onEachFeature: function (f, l) {
          l.bindTooltip('<b>' + esc(f.properties.n) + '</b><br>Active fault, position approximate', { sticky: true });
        },
        attribution: 'Faults: <a href="https://github.com/GEMScienceTools/gem-global-active-faults" target="_blank" rel="noopener">GEM</a> (CC BY-SA 4.0)'
      });
      return map._glraFault;
    });
  }
  function faultToggle(map, on) {
    if (!on) {
      if (map._glraFault) map.removeLayer(map._glraFault);
      legend(map, 'fault', FAULT_LEGEND, false);
      return Promise.resolve(false);
    }
    return faultLayer(map).then(function (layer) {
      layer.addTo(map);
      legend(map, 'fault', FAULT_LEGEND, true);
      return true;
    });
  }

  /* ── Arthaland's five buildings ───────────────────────────────
     Liv's position is OpenStreetMap's own outline of the site; the other four
     are placed from the street address on their pages (Rada Street; Arnaiz
     Avenue in Legazpi Village; Sevina Park; the Cardinal Rosales and Samar
     Loop corner), so they are accurate to the block, not the door. */
  var ARTHALAND = [
    { id: 'sondris', n: 'Sondris', lat: 14.5513, lng: 121.0161, c: '#c99a4e', where: 'Arnaiz Avenue, Legazpi Village, Makati', meta: '37 storeys · turnover 2030', img: '/img/arthaland/sondris/26-tower-sky@400.webp' },
    { id: 'eluria', n: 'Eluria', lat: 14.5539, lng: 121.0172, c: '#9cae94', where: 'Rada Street, Legazpi Village, Makati', meta: '31 storeys · now selling', img: '/img/arthaland/eluria/01-dusk-tower@400.webp' },
    { id: 'liv', n: 'Liv', lat: 14.6349, lng: 121.0736, c: '#6fa9b5', where: 'Katipunan Avenue, Loyola Heights, Quezon City', meta: '46 storeys · turnover 2031', img: '/img/arthaland/liv/02-tower-day@400.webp' },
    { id: 'una', n: 'Una', lat: 14.2582, lng: 121.0450, c: '#cf8567', where: 'Sevina Park, Biñan, Laguna', meta: '17 to 22 storeys · from 2026', img: '/img/arthaland/una/01-golden-hour@400.webp' },
    { id: 'lucima', n: 'Lucima', lat: 10.3157, lng: 123.9060, c: '#b9a27a', where: 'Cardinal Rosales Avenue, Cebu Business Park', meta: '37 storeys · completed', img: '/img/arthaland/lucima/01-aerial@400.webp' }
  ];
  function arthalandLayer() {
    var g = L.layerGroup();
    ARTHALAND.forEach(function (b) {
      var mk = L.marker([b.lat, b.lng], {
        icon: L.divIcon({ className: 'glra-ah-wrap', html: '<span class="glra-ah" style="--ac:' + b.c + '"><i class="fas fa-building" aria-hidden="true"></i><b>' + esc(b.n) + '</b></span>', iconSize: [0, 0], iconAnchor: [0, 0] }),
        title: b.n + ' by Arthaland, ' + b.where, keyboard: true, zIndexOffset: 700, riseOnHover: true
      });
      mk.bindPopup(
        '<div class="glra-ah-card"><img src="' + b.img + '" alt="" width="400" height="225" loading="lazy">' +
        '<div><small>Arthaland · featured developer</small><b>' + esc(b.n) + '</b>' + esc(b.meta) + '<br>' + esc(b.where) +
        '<br><a href="/' + b.id + '.html">See ' + esc(b.n) + ' &rarr;</a></div></div>',
        { className: 'glra-ah-pop', minWidth: 250, maxWidth: 250, offset: [0, -30], autoPanPadding: [24, 24] }
      );
      mk.on('add', function () { var el = mk.getElement(); if (el) { el.setAttribute('role', 'button'); el.setAttribute('aria-label', b.n + ' by Arthaland, ' + b.where); } });
      g.addLayer(mk);
    });
    return g;
  }
  function arthalandToggle(map, on) {
    if (!map._glraArtha) {
      map._glraArtha = arthalandLayer();
      /* Zoomed out, the names would pile on top of each other (Sondris and
         Eluria are 300 m apart): just the building badge until zoom 12. */
      var far = function () { map.getContainer().classList.toggle('glra-ah-far', map.getZoom() < 12); };
      map.on('zoomend', far);
      far();
    }
    if (on) map._glraArtha.addTo(map); else map.removeLayer(map._glraArtha);
    return Promise.resolve(!!on);
  }

  /* ── Sun path ─────────────────────────────────────────────────
     Sun position from the standard astronomical formulas (the same ones the
     SunCalc library uses), worked out in the visitor's browser. The diagram
     is the usual sun-path chart laid flat on the map: the circle is the
     horizon, the centre is straight overhead, so a point's distance from the
     centre shows how low the sun is in that direction. Times are Philippine
     time (UTC+8, no daylight saving) wherever the visitor is. */
  var RAD = Math.PI / 180;
  function sunPos(t, lat, lng) {
    var d = t / 864e5 - 0.5 + 2440588 - 2451545;
    var M = RAD * (357.5291 + 0.98560028 * d);
    var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var Lg = M + C + RAD * 102.9372 + Math.PI, e = RAD * 23.4397;
    var dec = Math.asin(Math.sin(e) * Math.sin(Lg));
    var ra = Math.atan2(Math.sin(Lg) * Math.cos(e), Math.cos(Lg));
    var H = RAD * (280.16 + 360.9856235 * d) + RAD * lng - ra, phi = RAD * lat;
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    var alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    return { bearing: (az / RAD + 180 + 360) % 360, alt: alt / RAD };
  }
  var PH_MS = 8 * 3600e3;
  function phMidnight(y, m, d) { return Date.UTC(y, m, d) - PH_MS; }
  function phClock(t) {
    var x = new Date(t + PH_MS), h = x.getUTCHours(), mi = x.getUTCMinutes();
    return ((h + 11) % 12 + 1) + ':' + (mi < 10 ? '0' : '') + mi + (h < 12 ? ' am' : ' pm');
  }
  /* Samples every 5 minutes while the sun is up, plus sunrise and sunset. */
  function sunDay(mid, lat, lng) {
    var pts = [], rise = null, set = null, prev = null;
    for (var t = mid; t <= mid + 864e5; t += 60000) {
      var s = sunPos(t, lat, lng);
      if (prev && prev.alt < -0.833 && s.alt >= -0.833) rise = t;
      if (prev && prev.alt >= -0.833 && s.alt < -0.833) set = t;
      if (s.alt >= 0 && (t - mid) % 300000 === 0) pts.push({ t: t, bearing: s.bearing, alt: s.alt });
      prev = s;
    }
    return { pts: pts, rise: rise, set: set };
  }
  var COMPASS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
  function compass(b) { return COMPASS[Math.round(b / 22.5) % 16]; }
  var FACING = {
    N: 'faces north: little direct sun for most of the year, so it tends to stay the coolest.',
    NE: 'faces northeast: gentle early-morning sun, then shade for the rest of the day.',
    E: 'faces east: bright morning sun and cooler afternoons.',
    SE: 'faces southeast: morning sun, with more of it from October to March.',
    S: 'faces south: sun through the middle of the day, strongest from October to March.',
    SW: 'faces southwest: afternoon sun, strongest from October to March.',
    W: 'faces west: strong afternoon sun, so rooms on that side run warmer late in the day.',
    NW: 'faces northwest: late-afternoon sun, strongest from April to August.'
  };
  function sunPath(map, lat, lng, facing) {
    var g = L.layerGroup(), ctl = null, state = {};
    var now = Date.now(), ph = new Date(now + PH_MS);
    var y = ph.getUTCFullYear(), mo = ph.getUTCMonth(), da = ph.getUTCDate();
    var today = sunDay(phMidnight(y, mo, da), lat, lng);
    var june = sunDay(phMidnight(y, 5, 21), lat, lng), dec = sunDay(phMidnight(y, 11, 21), lat, lng);
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function radiusM() {
      /* About 120 px on screen, whatever the zoom. */
      var mpp = 40075016.686 * Math.cos(lat * RAD) / Math.pow(2, map.getZoom() + 8);
      return Math.min(120, Math.max(60, map.getSize().y * 0.3)) * mpp;
    }
    function at(bearing, dist) {
      return [lat + dist * Math.cos(bearing * RAD) / 111320, lng + dist * Math.sin(bearing * RAD) / (111320 * Math.cos(lat * RAD))];
    }
    function onChart(p, R) { return at(p.bearing, R * (90 - Math.max(0, p.alt)) / 90); }
    function label(ll, text, cls) {
      return L.marker(ll, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'glra-sun-lbl-wrap', html: '<span class="glra-sun-lbl' + (cls ? ' ' + cls : '') + '">' + text + '</span>', iconSize: [0, 0] }) });
    }
    function draw() {
      g.clearLayers();
      var R = radiusM();
      /* The west side takes the hot afternoon sun all year here. */
      var wedge = [[lat, lng]];
      for (var b = 235; b <= 305; b += 5) wedge.push(at(b, R));
      g.addLayer(L.polygon(wedge, { color: '#ff3d00', weight: 0, fillColor: '#ff3d00', fillOpacity: 0.13, interactive: true }).bindTooltip('The west side takes the hot afternoon sun', { sticky: true }));
      g.addLayer(L.circle([lat, lng], { radius: R, color: '#0a0a0a', weight: 1.5, opacity: 0.6, dashArray: '4 5', fill: false, interactive: false }));
      [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(function (c) { g.addLayer(label(at(c[1], R * 1.13), c[0])); });
      [[june, '#d99a00', 'Jun 21'], [dec, '#7a3fb8', 'Dec 21']].forEach(function (s) {
        var day = s[0];
        if (!day.pts.length) return;
        g.addLayer(L.polyline(day.pts.map(function (p) { return onChart(p, R); }), { color: s[1], weight: 2, opacity: 0.85, dashArray: '5 5', interactive: false }));
        var hi = day.pts.reduce(function (a, p) { return p.alt > a.alt ? p : a; });
        g.addLayer(label(onChart(hi, R), s[2]));
      });
      if (today.pts.length) {
        g.addLayer(L.polyline(today.pts.map(function (p) { return onChart(p, R); }), { color: '#ff3d00', weight: 4, opacity: 0.95, interactive: false }));
        g.addLayer(label(at(today.pts[0].bearing, R * 1.34), 'Sunrise'));
        g.addLayer(label(at(today.pts[today.pts.length - 1].bearing, R * 1.34), 'Sunset'));
        var p = today.pts[state.i] || today.pts[0];
        var sp = onChart(p, R);
        g.addLayer(L.polyline([[lat, lng], sp], { color: '#ffb300', weight: 2, opacity: 0.9, interactive: false }));
        /* Shadows fall away from the sun, longer as it drops. */
        var shadow = Math.min(R * 0.95, R * 0.25 / Math.tan(Math.max(4, p.alt) * RAD));
        g.addLayer(L.polyline([[lat, lng], at((p.bearing + 180) % 360, shadow)], { color: '#0a0a0a', weight: 5, opacity: 0.35, lineCap: 'butt', interactive: false }));
        g.addLayer(label(sp, '<i class="fas fa-sun" aria-hidden="true"></i>', 'is-sun'));
      }
    }
    function readout() {
      var el = ctl && ctl.getContainer && ctl.getContainer().querySelector('.glra-sun-read');
      var p = today.pts[state.i];
      if (!el || !p) return;
      el.textContent = phClock(p.t) + ': sun in the ' + compass(p.bearing) + ', ' + Math.round(p.alt) + '° up';
    }
    function panel() {
      var Ctl = L.Control.extend({
        options: { position: 'bottomleft' },
        onAdd: function () {
          var d = L.DomUtil.create('div', 'glra-flood-legend glra-lg-sun');
          var n = today.pts.length;
          d.innerHTML = '<div class="glra-flood-legend-t">Sun path, today (' + da + ' ' + MONTHS[mo] + ')</div>' +
            (n ? '<p class="glra-sun-read"></p><label class="glra-sr" for="glraSunT">Time of day</label><input type="range" id="glraSunT" min="0" max="' + (n - 1) + '" step="1" value="' + state.i + '">' : '') +
            '<div class="glra-lg-row"><span><i class="glra-lg-line" style="color:#ff3d00"></i>Today</span><span><i class="glra-lg-line is-dash" style="color:#d99a00"></i>Jun 21</span><span><i class="glra-lg-line is-dash" style="color:#7a3fb8"></i>Dec 21</span></div>' +
            (today.rise && today.set ? '<p>Sunrise ' + phClock(today.rise) + ' · sunset ' + phClock(today.set) + ' (Philippine time). The closer the line runs to the pin, the higher the sun. The grey bar is the shadow.' : '<p>') +
            (FACING[facing] ? ' <b>This unit ' + FACING[facing] + '</b>' : '') + '</p>';
          L.DomEvent.disableClickPropagation(d);
          L.DomEvent.disableScrollPropagation(d);
          var r = d.querySelector('input');
          if (r) r.addEventListener('input', function () { state.i = Number(r.value) || 0; draw(); readout(); });
          return d;
        }
      });
      return new Ctl();
    }
    /* Start at the current time if the sun is up, otherwise at 3 pm. */
    (function () {
      var target = today.pts.length && now >= today.pts[0].t && now <= today.pts[today.pts.length - 1].t ? now : phMidnight(y, mo, da) + 15 * 3600e3;
      state.i = 0;
      today.pts.forEach(function (p, i) { if (Math.abs(p.t - target) < Math.abs(today.pts[state.i].t - target)) state.i = i; });
    })();
    function onZoom() { draw(); }
    return {
      on: function () {
        g.addTo(map);
        if (map.getZoom() < 15) map.setView([lat, lng], 16, { animate: !reduced() });
        else map.panTo([lat, lng], { animate: !reduced() });
        draw();
        ctl = panel().addTo(map);
        readout();
        map.on('zoomend', onZoom);
      },
      off: function () {
        map.off('zoomend', onZoom);
        g.remove();
        if (ctl) { ctl.remove(); ctl = null; }
      }
    };
  }

  /* ── Travel time ──────────────────────────────────────────────
     /api/isochrone asks the free Valhalla routing server (FOSSGIS, OSM data)
     and keeps the answer, so each listing is asked once. No live traffic. */
  var TRAVEL_COLS = { 15: '#0b3d91', 30: '#2f6fd6', 45: '#8fb6f2' };
  function travelTime(map, lat, lng) {
    var g = L.featureGroup(), ctl = null, mode = 'auto', seq = 0;
    function html() {
      return '<div class="glra-flood-legend-t">Travel time from here</div>' +
        '<div class="glra-lg-seg" role="group" aria-label="Travel by"><button type="button" data-m="auto" aria-pressed="' + (mode === 'auto') + '"><i class="fas fa-car" aria-hidden="true"></i>Car</button><button type="button" data-m="pedestrian" aria-pressed="' + (mode === 'pedestrian') + '"><i class="fas fa-person-walking" aria-hidden="true"></i>Walk</button></div>' +
        '<div class="glra-lg-row">' + [15, 30, 45].map(function (m) { return '<span><i class="glra-lg-sw" style="background:' + TRAVEL_COLS[m] + ';opacity:.7"></i>' + m + ' min</span>'; }).join('') + '</div>' +
        '<p class="glra-travel-msg">' + (mode === 'auto' ? 'Drive times assume light traffic. At rush hour in Metro Manila the same trip can take far longer.' : 'Walking at an easy pace on mapped streets and paths.') + ' Routing: <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noopener">Valhalla</a>, OpenStreetMap data.</p>';
    }
    function load() {
      var my = ++seq;
      var msg = ctl && ctl.getContainer().querySelector('.glra-travel-msg');
      if (msg) msg.textContent = 'Working out the travel times...';
      return getJson('/api/isochrone?lat=' + lat + '&lng=' + lng + '&mode=' + mode).then(function (gj) {
        if (my !== seq) return;
        g.clearLayers();
        var feats = (gj.features || []).slice().sort(function (a, b) { return b.properties.contour - a.properties.contour; });
        feats.forEach(function (f) {
          var c = TRAVEL_COLS[f.properties.contour] || '#2f6fd6';
          var fo = { 15: 0.3, 30: 0.2, 45: 0.14 }[f.properties.contour] || 0.18;
          g.addLayer(L.geoJSON(f, { pane: 'glraTravel', interactive: false, style: { color: c, weight: 2, opacity: 0.95, fillColor: c, fillOpacity: fo } }));
        });
        /* Frame the 30-minute area: the 45-minute one can reach the next
           province with no traffic, which would zoom the map right out. */
        var mid = feats.filter(function (f) { return f.properties.contour === 30; })[0] || feats[feats.length - 1];
        if (mid) map.fitBounds(L.geoJSON(mid).getBounds(), { padding: [20, 20], maxZoom: 15, animate: !reduced() });
        if (ctl) { ctl.getContainer().innerHTML = html(); wire(); }
      }).catch(function () {
        if (my !== seq) return;
        var m2 = ctl && ctl.getContainer().querySelector('.glra-travel-msg');
        if (m2) m2.textContent = 'The travel times could not load just now. Try again in a minute.';
        throw new Error('travel');
      });
    }
    function wire() {
      Array.prototype.forEach.call(ctl.getContainer().querySelectorAll('[data-m]'), function (b) {
        b.addEventListener('click', function () {
          if (mode === b.getAttribute('data-m')) return;
          mode = b.getAttribute('data-m');
          ctl.getContainer().innerHTML = html();
          wire();
          load().catch(function () {});
        });
      });
    }
    return {
      on: function () {
        pane(map, 'glraTravel', 360);
        g.addTo(map);
        var Ctl = L.Control.extend({
          options: { position: 'bottomleft' },
          onAdd: function () {
            var d = L.DomUtil.create('div', 'glra-flood-legend glra-lg-travel');
            L.DomEvent.disableClickPropagation(d);
            L.DomEvent.disableScrollPropagation(d);
            return d;
          }
        });
        ctl = new Ctl().addTo(map);
        ctl.getContainer().innerHTML = html();
        wire();
        return load();
      },
      off: function () {
        seq++;
        g.remove();
        if (ctl) { ctl.remove(); ctl = null; }
      }
    };
  }
  /* Wraps an {on, off} tool as a layerButton toggle. */
  function toolToggle(tool) {
    return function (map, on) {
      if (!on) { tool.off(); return Promise.resolve(false); }
      return Promise.resolve(tool.on()).then(function () { return true; }, function (e) { tool.off(); throw e; });
    };
  }

  /* ── 3D view ──────────────────────────────────────────────────
     MapLibre (jsDelivr, pinned with SRI) on OpenFreeMap's free "Liberty"
     style, whose buildings carry OpenStreetMap heights. Loads only when
     someone asks for it: the library is 800 KB. */
  var ML = {
    css: ['link', 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css', 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V'],
    js: ['script', 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj']
  };
  function open3d(lat, lng, title, returnFocus) {
    var box = document.createElement('div');
    box.className = 'glra-3d';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '3D view of the neighbourhood');
    box.innerHTML = '<div class="glra-3d-bar"><span>3D view' + (title ? ': ' + esc(title) : '') + '</span>' +
      '<button type="button" class="glra-3d-spin" aria-pressed="false"><i class="fas fa-rotate" aria-hidden="true"></i><b>Rotate</b></button>' +
      '<button type="button" class="glra-3d-close"><i class="fas fa-times" aria-hidden="true"></i><b>Close</b></button></div>' +
      '<div class="glra-3d-map"><div class="glra-3d-msg">Loading the 3D map...</div></div>';
    document.body.appendChild(box);
    document.documentElement.classList.add('glra-full-open');
    var map3 = null, spinning = false, raf = 0;
    function close() {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      if (map3) { try { map3.remove(); } catch (e) {} }
      box.remove();
      document.documentElement.classList.remove('glra-full-open');
      if (returnFocus && returnFocus.focus) returnFocus.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    var closeBtn = box.querySelector('.glra-3d-close'), spinBtn = box.querySelector('.glra-3d-spin');
    closeBtn.addEventListener('click', close);
    closeBtn.focus();
    function spin() {
      if (!spinning || !map3) return;
      map3.setBearing((map3.getBearing() + 0.12) % 360);
      raf = requestAnimationFrame(spin);
    }
    spinBtn.addEventListener('click', function () {
      spinning = !spinning;
      spinBtn.setAttribute('aria-pressed', spinning ? 'true' : 'false');
      cancelAnimationFrame(raf);
      if (spinning) spin();
    });
    Promise.all([loadAsset(ML.css), loadAsset(ML.js)]).then(function () {
      if (!document.body.contains(box)) return;
      var host = box.querySelector('.glra-3d-map');
      host.innerHTML = '<p class="glra-3d-note">Buildings are drawn from OpenStreetMap; some have no height on record and show flat. The orange pin marks the approximate area, not the exact building.</p>';
      map3 = new maplibregl.Map({
        container: host, style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [lng, lat], zoom: 16.4, pitch: 62, bearing: -25, maxPitch: 75,
        attributionControl: { compact: true }
      });
      map3.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      var pin = document.createElement('div');
      pin.className = 'glra-3d-pin';
      pin.innerHTML = '<i class="fas fa-house" aria-hidden="true"></i>';
      new maplibregl.Marker({ element: pin }).setLngLat([lng, lat]).addTo(map3);
      map3.on('error', function () {});
      if (!reduced()) { spinning = true; spinBtn.setAttribute('aria-pressed', 'true'); map3.once('idle', spin); }
    }).catch(function () {
      var host = box.querySelector('.glra-3d-map');
      if (host) host.innerHTML = '<div class="glra-3d-msg">The 3D map could not load. Check your connection and try again.</div>';
    });
    return { close: close };
  }
  /* WebGL is what the 3D map needs; without it the button stays hidden. */
  function has3d() {
    try { var c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl'))); } catch (e) { return false; }
  }

  /* ── Full screen ──────────────────────────────────────────────
     A fixed overlay (works on iPhones, which have no element fullscreen),
     plus the real Fullscreen API where the browser has it, so the browser
     bars go too. Esc, the button or leaving browser fullscreen all exit. */
  function fullscreenControl(map, target, position) {
    target = target || map.getContainer();
    var btn;
    function isFull() { return target.classList.contains('glra-full'); }
    function paint() {
      var on = isFull();
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen map');
      btn.title = on ? 'Exit full screen (Esc)' : 'Full screen map';
      btn.innerHTML = '<i class="fas ' + (on ? 'fa-compress' : 'fa-expand') + '" aria-hidden="true"></i>';
    }
    function set(on) {
      if (on === isFull()) return;
      target.classList.toggle('glra-full', on);
      document.documentElement.classList.toggle('glra-full-open', on);
      try {
        if (on && target.requestFullscreen && !document.fullscreenElement) target.requestFullscreen().catch(function () {});
        if (!on && document.fullscreenElement === target && document.exitFullscreen) document.exitFullscreen().catch(function () {});
      } catch (e) {}
      paint();
      setTimeout(function () { map.invalidateSize(false); }, 80);
      setTimeout(function () { map.invalidateSize(false); }, 400);
      if (typeof target._glraOnFull === 'function') target._glraOnFull(on);
    }
    var Ctl = L.Control.extend({
      options: { position: position || 'topright' },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'leaflet-bar glra-fs-ctl');
        btn = L.DomUtil.create('button', 'glra-fs-btn', d);
        btn.type = 'button';
        paint();
        L.DomEvent.disableClickPropagation(d);
        L.DomEvent.on(btn, 'click', function (e) { L.DomEvent.stop(e); set(!isFull()); });
        return d;
      }
    });
    new Ctl().addTo(map);
    document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && isFull()) set(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isFull()) set(false); });
    return { set: set, isFull: isFull };
  }

  /* ── GLRA logo on the map ─────────────────────────────────── */
  function logoControl(map) {
    var Ctl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        var a = L.DomUtil.create('a', 'glra-map-logo');
        a.href = '/';
        a.setAttribute('aria-label', 'GLRA Realty home');
        a.innerHTML = '<img class="glra-map-logo-l" src="/img/logo-384.png" alt="" width="384" height="384"><img class="glra-map-logo-d" src="/img/hero-logo-384.png" alt="" width="384" height="384">';
        L.DomEvent.disableClickPropagation(a);
        return a;
      }
    });
    return new Ctl().addTo(map);
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
      fullscreenControl(map, el, 'topleft');
      logoControl(map);
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
      function getMap() { return map; }
      floodButton(document.getElementById('pgFloodBtn'), getMap);
      layerButton(document.getElementById('pgRailBtn'), getMap, railToggle, 'The train map could not load. Try again later.');
      layerButton(document.getElementById('pgFaultBtn'), getMap, faultToggle, 'The fault map could not load. Try again later.');
      layerButton(document.getElementById('pgTravelBtn'), getMap, toolToggle(travelTime(map, lat, lng)), 'The travel times could not load. Try again later.');
      layerButton(document.getElementById('pgSunBtn'), getMap, toolToggle(sunPath(map, lat, lng, el.getAttribute('data-facing') || '')));
      var b3 = document.getElementById('pg3dBtn');
      if (b3) {
        if (!has3d()) b3.hidden = true;
        else b3.addEventListener('click', function () { open3d(lat, lng, el.getAttribute('data-title') || '', b3); });
      }
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

  /* ── Home page: every listing and the Arthaland buildings ──────
     index.html hands over its listings through GLRAMaps.homeData() once
     they arrive; the map itself loads only when it scrolls near. */
  var home = { el: null, map: null, list: null, dots: null };
  function homePeso(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return '₱' + (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return '₱' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return '₱' + Math.round(n / 1e3) + 'k';
    return n > 0 ? '₱' + n : '';
  }
  function homeLease(p) { return String(p.listingType || '').toUpperCase() === 'FOR LEASE'; }
  function homePrice(p) {
    if (homeLease(p)) { var r = Number(p.monthlyRental) || Number(p.price) || 0; return r ? homePeso(r) + '/mo' : 'Price on request'; }
    return Number(p.price) > 0 ? homePeso(p.price) : 'Price on request';
  }
  function homeTitle(p) { return (window.glraTitle ? window.glraTitle(p.title) : p.title) || 'Listing'; }
  function homeDots() {
    var m = home.map;
    if (!m || !home.list) return;
    if (home.dots) home.dots.remove();
    home.dots = L.featureGroup();
    /* Listings known only to their city share one point; fan them out a
       little so each dot can be reached. */
    var seen = {};
    home.list.forEach(function (p) {
      var g = p.geo;
      if (!g || !isFinite(g.lat) || !isFinite(g.lng)) return;
      var key = g.lat + ',' + g.lng, i = seen[key] = (seen[key] || 0) + 1;
      var la = g.lat, ln = g.lng;
      if (i > 1) {
        var a = i * 137.5 * RAD, d = 0.0011 * Math.sqrt(i - 1);
        la += d * Math.cos(a); ln += d * Math.sin(a) / Math.cos(la * RAD);
      }
      var lease = homeLease(p);
      var mk = L.marker([la, ln], {
        icon: L.divIcon({ className: 'glra-dot-wrap', html: '<span class="glra-dot' + (lease ? ' is-lease' : '') + '"></span>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        title: homeTitle(p) + ', ' + homePrice(p), keyboard: true, riseOnHover: true
      });
      var img = p.mainImage && /^https?:/.test(p.mainImage) ? (window.glraImgSize ? window.glraImgSize(p.mainImage, 480) : p.mainImage) : '';
      mk.bindPopup('<div class="glra-ah-card">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '') +
        '<div><small>' + (lease ? 'For lease' : 'For sale') + (p.geo.approx ? ' · area only' : '') + '</small><b>' + esc(homePrice(p)) + '</b>' + esc(homeTitle(p)) +
        '<br><a href="/property/' + esc(p._id) + '">View listing &rarr;</a></div></div>', { className: 'glra-ah-pop', minWidth: 250, maxWidth: 250, offset: [0, -4], autoPanPadding: [24, 24] });
      mk.bindTooltip(esc(homePrice(p)), { direction: 'top', offset: [0, -8] });
      home.dots.addLayer(mk);
    });
    home.dots.addTo(m);
    /* Open on Metro Manila and its edges, where most listings are; the
       provincial ones are a zoom-out away. */
    var all = home.dots.getLayers().map(function (l) { return l.getLatLng(); });
    var core = all.filter(function (ll) { return ll.lat > 14.25 && ll.lat < 14.85 && ll.lng > 120.9 && ll.lng < 121.25; });
    var pick = core.length >= all.length * 0.6 ? core : all;
    if (pick.length) m.fitBounds(L.latLngBounds(pick).pad(0.08), { maxZoom: 13, animate: false });
    var n = document.querySelector('[data-home-count]');
    if (n) n.textContent = String(home.dots.getLayers().length);
  }
  function homeInit(el) {
    if (home.map || !el) return;
    home.el = el;
    loadLeaflet().then(function () {
      var r = reduced();
      var m = L.map(el, { scrollWheelZoom: false, zoomAnimation: !r, fadeAnimation: !r, markerZoomAnimation: !r, minZoom: 5 }).setView([14.56, 121.03], 11);
      m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
      osm(m);
      fullscreenControl(m, el, 'topright');
      logoControl(m);
      arthalandToggle(m, true);
      m.once('focus click', function () { m.scrollWheelZoom.enable(); });
      home.map = m;
      homeDots();
      function getMap() { return m; }
      layerButton(document.getElementById('homeRailBtn'), getMap, railToggle, 'The train map could not load. Try again later.');
      var ab = document.getElementById('homeArthaBtn');
      if (ab) ab.addEventListener('click', function () {
        var on = ab.getAttribute('aria-pressed') !== 'true';
        arthalandToggle(m, on);
        ab.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) m.flyToBounds(L.latLngBounds(ARTHALAND.map(function (b) { return [b.lat, b.lng]; })).pad(0.1), { animate: !r, duration: 1.2 });
      });
      el.classList.add('is-ready');
    }).catch(function () {
      el.classList.add('is-failed');
      el.innerHTML = '<p class="glra-nb-fail">The map could not load. Check your connection and reload the page.</p>';
    });
  }
  function homeData(list) {
    home.list = (list || []).filter(function (p) { return p && p.geo; });
    homeDots();
  }
  function autoHome() {
    var el = document.getElementById('homeMap');
    if (!el) return;
    if (window.__glraHomeList) homeData(window.__glraHomeList);
    if (!('IntersectionObserver' in window)) { homeInit(el); return; }
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); homeInit(el); }
    }, { rootMargin: '500px 0px' });
    io.observe(el);
  }

  window.GLRAMaps = {
    loadLeaflet: loadLeaflet,
    loadAsset: loadAsset,
    osm: osm,
    floodToggle: floodToggle,
    floodButton: floodButton,
    layerButton: layerButton,
    railToggle: railToggle,
    faultToggle: faultToggle,
    arthalandToggle: arthalandToggle,
    ARTHALAND: ARTHALAND,
    fullscreenControl: fullscreenControl,
    logoControl: logoControl,
    streetViewUrl: streetViewUrl,
    neighbourhood: neighbourhood,
    homeData: homeData,
    homeInit: homeInit
  };
  function autoAll() { autoNeighbourhood(); autoHome(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoAll);
  else autoAll();
})();
