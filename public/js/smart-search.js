/* ============================================
   GLRA Realty: smart search
   Reads a plain-language query such as
     "2BR condo in BGC under 15M"
     "lot for sale tagaytay"
     "studio for rent makatti 30k a month"
   into structured filters plus leftover place/name words, and matches
   listings with typo tolerance. Used by index.html and properties.html.
     glraSmartParse(text)        -> query object (with .labels for chips)
     glraSmartMatch(listing, q)  -> true/false
   Only reads data already in the page; nothing is sent anywhere.
   ============================================ */
(function () {
  'use strict';

  var STOP = {};
  ('in at near around a an the with for and or of to na sa ng php peso pesos price priced budget ' +
   'looking look want need find show me my i please property properties listing listings ' +
   'unit units city metro philippines ph some any cheap affordable nice good').split(' ')
    .forEach(function (w) { STOP[w] = 1; });

  // Places people abbreviate; each maps to phrases found in listing locations.
  var ALIAS = {
    bgc: ['bgc', 'bonifacio global city', 'fort bonifacio', 'bonifacio'],
    fort: ['fort bonifacio', 'bgc', 'bonifacio global city'],
    qc: ['quezon city'],
    moa: ['mall of asia', 'moa', 'bay area'],
    bf: ['bf homes', 'bf resort', 'bf '],
    mandaluyong: ['mandaluyong', 'ortigas'],
    ortigas: ['ortigas'],
    alabang: ['alabang', 'muntinlupa', 'filinvest'],
    nuvali: ['nuvali', 'sta rosa'],
    rockwell: ['rockwell'],
    mckinley: ['mckinley']
  };

  // Multi-word types first, then single words. key -> test on a listing's base type.
  var TYPE_PHRASES = [
    [/\bhouse\s*(?:and|&|n)\s*lot\b|\bh\s*&\s*l\b/, 'house'],
    [/\bcommercial\s+lot\b/, 'commercial lot'],
    [/\bresidential\s+lot\b/, 'residential lot'],
    [/\b(?:agricultural|agri|farm)\s+lot\b|\bfarm\s*land\b|\bfarm\b/, 'agricultural lot'],
    [/\b(?:commercial|office|retail)\s+(?:space|unit)s?\b|\boffices?\b|\bshops?\b/, 'commercial space'],
    [/\btown\s*houses?\b|\btown\s*homes?\b/, 'townhouse'],
    [/\bcondos?\b|\bcondominiums?\b|\bapartments?\b|\bflats?\b/, 'condominium'],
    [/\bhouses?\b|\bbungalows?\b|\bvillas?\b/, 'house'],
    [/\blots?\b|\blands?\b/, 'lot']
  ];
  var TYPE_LABEL = {
    'house': 'House and Lot', 'commercial lot': 'Commercial Lot', 'residential lot': 'Residential Lot',
    'agricultural lot': 'Agricultural Lot', 'commercial space': 'Commercial Space', 'townhouse': 'Townhouse',
    'condominium': 'Condominium', 'lot': 'Lot'
  };

  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/\bsanta\b/g, 'sta').replace(/\bsanto\b/g, 'sto')
      .replace(/[^a-z0-9ñ&\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function baseType(t) { return String(t || '').trim().split(/\s+-\s+/)[0].trim().toLowerCase(); }

  // The title is checked too: some listings carry the wrong type field
  // ("COMMERCIAL SPACE FOR LEASE - A.C.T. TOWER" is filed as a Condominium).
  var TITLE_TYPE = {
    'commercial space': /\b(?:commercial|office|retail)\s+(?:space|unit)|\boffice\b/,
    'townhouse': /\btown\s*house/,
    'lot': /\blot\b(?![\s-]*(?:area|size))/,
    'commercial lot': /\bcommercial\s+lot\b/,
    'residential lot': /\bresidential\s+lot\b/,
    'agricultural lot': /\b(?:agricultural|farm)\b/
  };
  function typeFits(p, key) {
    var tt = TITLE_TYPE[key], title = String(p.title || '').toLowerCase();
    if (tt && tt.test(title) && !(key === 'lot' && /house/.test(title))) return true;
    var b = baseType(p.propertyType);
    if (key === 'lot') return /\blot\b/.test(b) && !/house/.test(b);
    if (key === 'house') return /house/.test(b) && !/town/.test(b);
    return b === key || b.indexOf(key) === 0;
  }

  // "15m", "15 million", "p15,000,000", "30k", "1.2b" -> pesos (or NaN)
  var AMOUNT = '(?:₱|php|p)?\\s*(\\d+(?:[.,]\\d+)*)\\s*(k|thousand|m|mil|million|b|bn|billion)?\\b';
  function toPesos(num, unit) {
    var n = parseFloat(String(num).replace(/,/g, ''));
    if (isNaN(n)) return NaN;
    var u = (unit || '').toLowerCase();
    if (u === 'k' || u === 'thousand') n *= 1e3;
    else if (u === 'm' || u === 'mil' || u === 'million') n *= 1e6;
    else if (u === 'b' || u === 'bn' || u === 'billion') n *= 1e9;
    return n;
  }
  function shortPeso(n) {
    if (n >= 1e9) return '₱' + +(n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '₱' + +(n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '₱' + +(n / 1e3).toFixed(1) + 'K';
    return '₱' + n;
  }

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function glraSmartParse(text) {
    var raw = String(text || '');
    var s = ' ' + raw.toLowerCase().replace(/[“”"]/g, ' ').replace(/\bquezon\s+city\b/g, 'qc') + ' ';
    var q = { raw: raw.trim(), tokens: [], phrase: '', labels: [], structured: false };
    function eat(re, fn) {
      s = s.replace(re, function () { fn.apply(null, arguments); return ' '; });
    }

    // Monthly rent wording implies a lease search.
    if (/\b(?:per|a|\/)\s*(?:month|mo)\b|\bmonthly\b|\/mo\b|\/month\b/.test(s)) q.monthly = true;
    s = s.replace(/\b(?:per|a)\s+(?:month|mo)\b|\bmonthly\b|\/\s*(?:month|mo)\b/g, ' ');

    // Ranges: "10-15m", "10m to 15m", "between 10 and 15 million"
    eat(new RegExp('(?:between\\s+)?' + AMOUNT + '\\s*(?:-|to|and)\\s*' + AMOUNT, 'i'), function (m, a1, u1, a2, u2) {
      var unit = u2 || u1;
      var lo = toPesos(a1, u1 || unit), hi = toPesos(a2, u2 || unit);
      if (!(u1 || u2) && Math.max(lo, hi) < 1000) { q._noRange = m; return; }
      if (lo > hi) { var t = lo; lo = hi; hi = t; }
      q.min = lo; q.max = hi;
    });
    if (q._noRange) { s = ' ' + q._noRange + ' ' + s; delete q._noRange; }
    eat(new RegExp('\\b(?:under|below|less\\s+than|max(?:imum)?|up\\s+to|within|not\\s+more\\s+than|budget\\s+of|<)\\s*' + AMOUNT, 'i'), function (m, a, u) {
      var v = toPesos(a, u); if (v >= 1000 || u) q.max = v;
    });
    eat(new RegExp('\\b(?:over|above|more\\s+than|min(?:imum)?|at\\s+least|from|starting(?:\\s+at)?|>)\\s*' + AMOUNT, 'i'), function (m, a, u) {
      var v = toPesos(a, u); if (v >= 1000 || u) q.min = v;
    });

    // Rooms and sizes
    eat(/\b(\d+)\s*-?\s*(?:br|bed(?:room)?s?|bdrms?|bhk|rooms?)\b/, function (m, n) { q.beds = +n; });
    eat(/\bstudios?\b/, function () { q.studio = true; });
    eat(/\b(\d+)\s*-?\s*(?:ba|baths?|bathrooms?|t\s*&\s*b|tnb|toilets?|cr)\b/, function (m, n) { q.baths = +n; });
    eat(/\b(\d+(?:\.\d+)?)\s*(?:sqm|sq\.?\s*m\.?|m2|square\s*met(?:er|re)s?)\b/, function (m, n) { q.minArea = +n; });
    eat(/\b(?:with\s+)?(\d+)?\s*(?:parking|car\s*park|garage)(?:\s*slots?)?\b/, function (m, n) { q.parking = n ? +n : 1; });

    // Bare amount with a unit ("condo 15m") reads as a budget ceiling.
    eat(new RegExp('(?:^|\\s)(?:₱|php|p)?\\s*(\\d+(?:[.,]\\d+)*)\\s*(k|m|mil|million|b|bn|billion)\\b', 'i'), function (m, a, u) {
      if (q.max === undefined) q.max = toPesos(a, u);
    });

    // Sale or lease
    eat(/\b(?:for\s+sale|buy(?:ing)?|purchase|selling|sale)\b/, function () { q.category = 'sale'; });
    eat(/\b(?:for\s+(?:rent|lease)|rent(?:ing|al)?s?|leas(?:e|ing))\b/, function () { q.category = 'lease'; });
    if (!q.category && q.monthly) q.category = 'lease';

    // Property type
    for (var i = 0; i < TYPE_PHRASES.length && !q.type; i++) {
      (function (pair) {
        if (pair[0].test(s)) { q.type = pair[1]; s = s.replace(pair[0], ' '); }
      })(TYPE_PHRASES[i]);
    }

    // Whatever is left: places and building names.
    var words = norm(s).split(' ').filter(function (w) { return w && !STOP[w]; });
    q.tokens = words;
    q.phrase = words.join(' ');
    q.structured = ['beds', 'baths', 'studio', 'min', 'max', 'minArea', 'parking', 'category', 'type']
      .some(function (k) { return q[k] !== undefined; });

    // Human-readable chips, in reading order.
    if (q.category) q.labels.push(q.category === 'sale' ? 'For sale' : 'For rent');
    if (q.studio) q.labels.push('Studio');
    if (q.beds) q.labels.push(q.beds + '+ bedroom' + (q.beds > 1 ? 's' : ''));
    if (q.baths) q.labels.push(q.baths + '+ bath' + (q.baths > 1 ? 's' : ''));
    if (q.type) q.labels.push(TYPE_LABEL[q.type]);
    var per = q.category === 'lease' ? '/mo' : '';
    if (q.min !== undefined && q.max !== undefined) q.labels.push(shortPeso(q.min) + ' to ' + shortPeso(q.max) + per);
    else if (q.max !== undefined) q.labels.push('Under ' + shortPeso(q.max) + per);
    else if (q.min !== undefined) q.labels.push('Over ' + shortPeso(q.min) + per);
    if (q.minArea) q.labels.push(q.minArea + '+ sqm');
    if (q.parking) q.labels.push('Parking');
    if (words.length) {
      var shown = words.join(' ');
      if (/\bquezon\s+city\b/i.test(raw)) shown = shown.replace(/\bqc\b/, 'Quezon City');
      q.labels.push('"' + shown + '"');
    }
    return q;
  }

  // Words from every listing, for typo correction ("makatti" -> "makati").
  var vocabCache = { key: null, words: [] };
  function vocab(listings) {
    var key = listings ? listings.length : 0;
    if (vocabCache.key === key && vocabCache.words.length) return vocabCache.words;
    var set = {};
    (listings || []).forEach(function (p) {
      norm((p.title || '') + ' ' + (p.location || '') + ' ' + (p.mapLocation || '') + ' ' + (p.propertyType || ''))
        .split(' ').forEach(function (w) { if (w.length >= 4) set[w] = 1; });
    });
    vocabCache = { key: key, words: Object.keys(set) };
    placeSet = set;
    return vocabCache.words;
  }
  function correct(token, listings) {
    if (token.length < 4 || /\d/.test(token)) return token;
    var max = token.length >= 7 ? 2 : 1, best = token, bestD = max + 1;
    var words = vocab(listings);
    for (var i = 0; i < words.length; i++) {
      if (words[i] === token) return token;
      var d = lev(token, words[i], max);
      if (d < bestD) { bestD = d; best = words[i]; }
    }
    return bestD <= max ? best : token;
  }

  function tokenIn(token, hay, desc) {
    var phrases = ALIAS[token] || [token];
    for (var i = 0; i < phrases.length; i++) {
      var ph = phrases[i];
      if (ph.length <= 3) { if ((' ' + hay + ' ').indexOf(' ' + ph + ' ') !== -1) return true; }
      else if (hay.indexOf(ph) !== -1) return true;
    }
    return token.length >= 4 && !isPlaceWord(token) && desc.indexOf(token) !== -1;
  }
  var placeSet = null;
  function isPlaceWord(t) { return !!(placeSet && placeSet[t]) || !!ALIAS[t]; }

  function glraSmartMatch(p, q, listings) {
    if (!q) return true;
    var beds = Number(p.bedrooms) || 0, baths = Number(p.bathrooms) || 0;
    if (q.studio && !(beds <= 1 && typeFits(p, 'condominium'))) return false;
    if (q.beds && beds < q.beds) return false;
    if (q.baths && baths < q.baths) return false;
    if (q.type && !typeFits(p, q.type)) return false;
    if (q.minArea && Math.max(Number(p.sqm) || 0, Number(p.landArea) || 0) < q.minArea) return false;
    if (q.parking && (Number(p.parking) || 0) < q.parking) return false;
    var lt = String(p.listingType || '').toUpperCase();
    var sale = lt === 'FOR SALE' || lt === 'SALE AND LEASE', lease = lt === 'FOR LEASE' || lt === 'SALE AND LEASE';
    if (q.category === 'sale' && !sale) return false;
    if (q.category === 'lease' && !lease) return false;
    if (q.min !== undefined || q.max !== undefined) {
      var saleP = Number(p.price) || 0, rentP = Number(p.monthlyRental) || Number(p.price) || 0;
      var cat = q.category, top = Math.max(q.min || 0, q.max || 0);
      if (!cat && top >= 1e6) cat = 'sale';
      else if (!cat && top > 0 && top <= 3e5) cat = 'lease';
      if (cat === 'sale' && !sale) return false;
      if (cat === 'lease' && !lease) return false;
      var cands = cat === 'sale' ? [saleP] : cat === 'lease' ? [rentP]
        : (lt === 'SALE AND LEASE' ? [saleP, rentP] : [lease ? rentP : saleP]);
      var fits = cands.some(function (v) {
        return v > 0 && !(q.min !== undefined && v < q.min) && !(q.max !== undefined && v > q.max);
      });
      if (!fits) return false;
    }
    if (!q.tokens.length) return true;
    vocab(listings);
    var hay = norm((p.title || '') + ' ' + (p.location || '') + ' ' + (p.mapLocation || '') + ' ' + (p.propertyType || ''));
    if (q.phrase && hay.indexOf(q.phrase) !== -1) return true;
    var desc = norm(p.description || '');
    for (var i = 0; i < q.tokens.length; i++) {
      var t = q.tokens[i];
      if (tokenIn(t, hay, desc)) continue;
      var c = correct(t, listings);
      if (c !== t && tokenIn(c, hay, desc)) continue;
      return false;
    }
    return true;
  }

  // Chips under a search box: "Showing: For sale · 2+ bedrooms · BGC".
  function glraSmartChips(input, q) {
    if (!input) return;
    var box = document.getElementById(input.id + 'Understood');
    if (!box) {
      box = document.createElement('div');
      box.id = input.id + 'Understood';
      box.className = 'glra-sq';
      box.setAttribute('aria-live', 'polite');
      var host = input.closest('.search-box, .search-input-wrapper, .search-bar, form') || input.parentElement;
      host.parentElement.insertBefore(box, host.nextSibling);
    }
    if (!q || !q.structured) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = '';
    var lead = document.createElement('span');
    lead.className = 'glra-sq-lead';
    lead.textContent = 'Searching for';
    box.appendChild(lead);
    q.labels.forEach(function (l) {
      var c = document.createElement('span');
      c.className = 'glra-sq-chip';
      c.textContent = l;
      box.appendChild(c);
    });
  }

  if (!document.getElementById('glraSqStyle')) {
    var st = document.createElement('style');
    st.id = 'glraSqStyle';
    st.textContent =
      '.glra-sq{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 0;font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase}' +
      '.glra-sq[hidden]{display:none}' +
      '.glra-sq-lead{color:#8a857c;font-weight:700;margin-right:2px}' +
      '.glra-sq-chip{background:#0a0a0a;color:#f1eee9;border:1px solid #f1eee9;padding:4px 8px;font-weight:700;text-transform:none;letter-spacing:.3px}' +
      'body.dark-mode .glra-sq-chip{background:#f1eee9;color:#0a0a0a;border-color:#0a0a0a}';
    (document.head || document.documentElement).appendChild(st);
  }

  window.glraSmartParse = glraSmartParse;
  window.glraSmartMatch = glraSmartMatch;
  window.glraSmartChips = glraSmartChips;
})();
