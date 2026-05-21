// =============================================================================
// CHATBOT
// =============================================================================
// The on-site AI assistant. Routes POST /api/chat. Picks Gemini first
// (or Groq if PRIMARY_LLM=groq), falls back to the other provider on quota
// errors, and assembles a property-aware system prompt from live inventory.
//
// USAGE (from server.js):
//   const { registerChatbot, invalidateChatListingsCache } = require('./server/chatbot');
//   registerChatbot(app, { handleValidation });
//   // Then anywhere a property is written:
//   invalidateChatListingsCache();
// =============================================================================
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const { Property } = require('./db');

// ── LLM PROVIDER HELPERS ─────────────────────────────────────
// Each takes the same { apiKey, systemPrompt, history, message } and returns
// { text, finish, provider } on success or throws an Error with .status (HTTP
// code) and .body (error response text) on failure.

// Google Gemini (generativelanguage.googleapis.com)
async function callGemini({ apiKey, systemPrompt, history, message }) {
  const contents = [];
  for (const turn of history || []) {
    if (!turn || !turn.role || !turn.text) continue;
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.text).slice(0, 4000) }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.6, maxOutputTokens: 1024, topP: 0.9 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  if (/^gemini-2\.5/.test(model)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  let r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Auto-retry once without thinkingConfig if 2.5 rejected it
  if (!r.ok && body.generationConfig.thinkingConfig) {
    delete body.generationConfig.thinkingConfig;
    r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    const err = new Error(`Gemini ${r.status}: ${errText.slice(0, 300)}`);
    err.status = r.status; err.body = errText;
    throw err;
  }
  const data = await r.json();
  const cand = data?.candidates?.[0];
  return {
    provider: 'gemini',
    text: cand?.content?.parts?.[0]?.text,
    finish: cand?.finishReason,
  };
}

// Groq (OpenAI-compatible chat completions). Same prompt, different shape.
// Free tier ≈ 30 RPM / 14,400 RPD — 3× Gemini's free quota and no card required.
async function callGroq({ apiKey, systemPrompt, history, message }) {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const turn of history || []) {
    if (!turn || !turn.role || !turn.text) continue;
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: String(turn.text).slice(0, 4000),
    });
  }
  messages.push({ role: 'user', content: message });

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.6,
      max_tokens: 1024,
      top_p: 0.9,
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    const err = new Error(`Groq ${r.status}: ${errText.slice(0, 300)}`);
    err.status = r.status; err.body = errText;
    throw err;
  }
  const data = await r.json();
  const choice = data?.choices?.[0];
  return {
    provider: 'groq',
    text: choice?.message?.content,
    finish: choice?.finish_reason, // 'stop' | 'length' | 'content_filter' …
  };
}

// ── RATE LIMITER ─────────────────────────────────────────────
// Looser than publicWriteLimiter so the chat feels responsive, but still tight
// enough to prevent abuse / runaway API spend.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many messages. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── LISTINGS CACHE ──────────────────────────────────────────
// Re-pulling every chat message would slam Mongo. We cache the full available-
// listings set in memory for 60 s. Admin saves invalidate it via the exported
// invalidateChatListingsCache().
const CHAT_LISTING_TTL_MS = 60 * 1000;
const CHAT_LISTING_LIMIT  = 80;
let _chatListingCache = { at: 0, items: [] };

function invalidateChatListingsCache() {
  _chatListingCache.at = 0;
  try { chatReplyCacheClear(); } catch (_) { /* defined below */ }
}

// ── REPLY CACHE ─────────────────────────────────────────────
// Gemini free-tier caps at 10 requests/minute. When several users (or one user
// clicking starter chips) hit the same canned question, we serve the cached
// response instead of burning quota. Cache is per-question text only (no
// history) so it's deterministic and easy to reason about.
const CHAT_REPLY_TTL_MS = 5 * 60 * 1000;
const CHAT_REPLY_MAX = 200;
const _chatReplyCache = new Map();

function normalizeChatMessage(msg) {
  return String(msg || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s₱]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function chatReplyCacheGet(msg) {
  const key = normalizeChatMessage(msg);
  if (!key) return null;
  const hit = _chatReplyCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CHAT_REPLY_TTL_MS) {
    _chatReplyCache.delete(key);
    return null;
  }
  return hit.payload;
}
function chatReplyCacheSet(msg, payload) {
  const key = normalizeChatMessage(msg);
  if (!key) return;
  if (_chatReplyCache.size >= CHAT_REPLY_MAX) {
    const firstKey = _chatReplyCache.keys().next().value;
    if (firstKey) _chatReplyCache.delete(firstKey);
  }
  _chatReplyCache.set(key, { at: Date.now(), payload });
}
function chatReplyCacheClear() { _chatReplyCache.clear(); }

async function getAllAvailableListingsCached() {
  const now = Date.now();
  if (now - _chatListingCache.at < CHAT_LISTING_TTL_MS && _chatListingCache.items.length) {
    return _chatListingCache.items;
  }
  try {
    const items = await Property.find({ status: 'available' })
      .sort({ featured: -1, createdAt: -1 })
      .limit(CHAT_LISTING_LIMIT)
      .select('_id title location price monthlyRental listingType bedrooms bathrooms sqm propertyType featured developer mainImage')
      .lean();
    _chatListingCache = { at: now, items };
    return items;
  } catch (e) {
    return _chatListingCache.items || [];
  }
}

// ── INTENT + SCORING ────────────────────────────────────────
// Lightweight keyword scorer. Pulls obvious intents out of the user's message
// (location, property type, listing type, BR count, budget) and ranks listings
// so the most relevant ones get included in the prompt — without needing a
// full vector store. Cheap, deterministic, no extra dependencies.
const KNOWN_LOCATIONS = [
  'makati','bgc','taguig','fort','bonifacio','alabang','muntinlupa','manila','quezon','qc',
  'ortigas','pasig','mandaluyong','san juan','rockwell','salcedo','legazpi','legaspi',
  'poblacion','greenhills','eastwood','newport','parañaque','paranaque','las piñas','laspinas',
  'pasay','marikina','antipolo','tagaytay','cavite','laguna','bulacan','nuvali','sucat',
  'mckinley','uptown','arca','filinvest','ayala','century city','proscenium','one shangri',
  'shangri-la','solaire','okada','clark','subic','baguio','batangas','nasugbu','laiya'
];
const KNOWN_TYPES = ['condo','condominium','house','townhouse','lot','apartment','studio','penthouse','duplex','loft','villa','office','commercial'];

// Returns true if the user message looks like a property search of any kind.
function hasPropertyIntent(message) {
  const m = (message || '').toLowerCase();
  if (KNOWN_LOCATIONS.some(loc => m.includes(loc))) return true;
  if (KNOWN_TYPES.some(t => m.includes(t))) return true;
  if (/\b(property|properties|listing|listings|unit|units|home|homes|condo|condos)\b/.test(m)) return true;
  if (/\b(for sale|for lease|rent|rental|leasing|buying|to buy)\b/.test(m)) return true;
  if (/\b(\d+)\s*-?\s*(br|bed|bedroom)/.test(m)) return true;
  if (/\bshow me\b/.test(m) && /\b(in|at|around|near|under|below)\b/.test(m)) return true;
  if (/\b(under|below|less than|max|maximum)\s*₱?\s*\d/.test(m)) return true;
  if (/\b(sqm|square ?meters?|bedrooms?|bathrooms?|br|ba|price|cost|how much)\b/.test(m) &&
      /\b(of|for|in|at|the)\b/.test(m)) return true;
  return false;
}

const TITLE_STOPWORDS = new Set([
  'the','a','an','and','or','of','at','in','on','for','with','to','by',
  'city','residence','residences','tower','towers','condo','condos','condominium',
  'house','lot','home','homes','place','village','park','place','complex',
  'unit','units','floor','floors','property','properties','sqm','br','ba'
]);

function scoreListings(message, listings) {
  const m = (message || '').toLowerCase();
  const wantedLocs = KNOWN_LOCATIONS.filter(loc => m.includes(loc));
  const wantedTypes = KNOWN_TYPES.filter(t => m.includes(t));
  const wantsLease = /\b(rent|rental|lease|leasing|monthly)\b/.test(m);
  const wantsSale  = /\b(buy|buying|purchase|sale|for sale)\b/.test(m);

  const msgWords = (m.match(/[a-z]+/g) || [])
    .filter(w => w.length >= 4 && !TITLE_STOPWORDS.has(w));

  const brMatch = m.match(/(\d+)\s*-?\s*(?:br|bed|bedroom)/);
  const wantedBR = brMatch ? parseInt(brMatch[1], 10) : null;

  let budget = null;
  const bMatch = m.match(/(\d[\d,.]*)\s*(m|mil|million|k|thousand)?/);
  if (bMatch) {
    const raw = parseFloat(bMatch[1].replace(/,/g, ''));
    const unit = (bMatch[2] || '').toLowerCase();
    if (!isNaN(raw)) {
      if (unit === 'm' || unit === 'mil' || unit === 'million') budget = raw * 1_000_000;
      else if (unit === 'k' || unit === 'thousand') budget = raw * 1_000;
      else if (raw >= 1000) budget = raw;
    }
  }

  function scoreOne(p) {
    let s = 0;
    const loc = (p.location || '').toLowerCase();
    const title = (p.title || '').toLowerCase();
    const type = (p.propertyType || '').toLowerCase();
    const lt = (p.listingType || '').toUpperCase();
    const isLease = lt.includes('LEASE') || lt.includes('RENT');

    for (const w of wantedLocs) if (loc.includes(w) || title.includes(w)) s += 10;
    for (const t of wantedTypes) if (type.includes(t) || title.includes(t)) s += 4;
    if (wantsLease && isLease) s += 6;
    if (wantsSale && !isLease) s += 6;
    if (wantedBR !== null && p.bedrooms === wantedBR) s += 4;

    if (msgWords.length) {
      const titleWords = title.split(/[^a-z0-9]+/).filter(Boolean);
      for (const w of msgWords) {
        if (titleWords.some(tw => tw.length >= 4 && (tw === w || tw.includes(w) || w.includes(tw)))) {
          s += 6;
          break;
        }
      }
    }

    if (budget) {
      const isSaleBudget = budget >= 1_000_000;
      const price = isLease ? (p.monthlyRental || p.price || 0) : (p.price || 0);
      if (price > 0) {
        if (isLease && !isSaleBudget && price <= budget * 1.25) s += 4;
        if (!isLease && isSaleBudget && price <= budget * 1.15) s += 4;
      }
    }
    if (p.featured) s += 0.5;
    return s;
  }

  const scored = listings.map(p => ({ p, s: scoreOne(p) }));
  scored.sort((a, b) => b.s - a.s);
  return scored;
}

function fmtListing(p, i) {
  const lt = (p.listingType || '').toUpperCase();
  const isLease = lt.includes('LEASE') || lt.includes('RENT');
  const price = isLease
    ? `₱${Number(p.monthlyRental || p.price || 0).toLocaleString()}/mo`
    : `₱${Number(p.price || 0).toLocaleString()}`;
  const dev = p.developer ? `, ${p.developer}` : '';
  return `${i + 1}. [${p.title}] — ${p.location} — ${price} — ${p.bedrooms || 0}BR / ${p.bathrooms || 0}BA / ${p.sqm || 0}sqm — ${p.propertyType || 'Property'}${dev} — ${isLease ? 'For Lease' : 'For Sale'}`;
}

// Server-side derivation of search params from the user's message.
// We do NOT trust the model to construct correct URLs — we build them ourselves.
function deriveSearchFromMessage(message) {
  const m = (message || '').toLowerCase();
  const params = {};
  let labelParts = [];

  const loc = KNOWN_LOCATIONS.find(l => m.includes(l));
  if (loc) {
    const display = loc.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    params.search = display;
    labelParts.push(display);
  }

  if (/\bcondo|condominium|studio|penthouse\b/.test(m)) { params.propertyType = 'Condominium'; labelParts.push('condos'); }
  else if (/\bhouse|h&l|house and lot\b/.test(m))      { params.propertyType = 'House and Lot'; labelParts.push('houses'); }
  else if (/\btownhouse|town house\b/.test(m))         { params.propertyType = 'Townhouse'; labelParts.push('townhouses'); }
  else if (/\bcommercial\b/.test(m))                   { params.propertyType = 'Commercial Lot'; labelParts.push('commercial'); }
  else if (/\blot|land|residential lot\b/.test(m))     { params.propertyType = 'Residential Lot'; labelParts.push('lots'); }

  if (/\b(rent|rental|lease|leasing|monthly|for lease)\b/.test(m)) {
    params.category = 'FOR LEASE';
    labelParts.push('for lease');
  } else if (/\b(buy|buying|purchase|for sale|sale)\b/.test(m)) {
    params.category = 'FOR SALE';
    labelParts.push('for sale');
  }

  const brMatch = m.match(/(\d+)\s*-?\s*(?:br|bed|bedroom)/);
  if (brMatch) {
    params.bedrooms = parseInt(brMatch[1], 10);
    labelParts.unshift(`${brMatch[1]}BR`);
  }

  const bMatch = m.match(/(?:under|below|max|less than|≤|<=|<)\s*₱?\s*([\d,.]+)\s*(m|mil|million|k|thousand)?/);
  if (bMatch) {
    const raw = parseFloat(bMatch[1].replace(/,/g, ''));
    const unit = (bMatch[2] || '').toLowerCase();
    let n = raw;
    if (unit === 'm' || unit === 'mil' || unit === 'million') n = raw * 1_000_000;
    else if (unit === 'k' || unit === 'thousand') n = raw * 1_000;
    if (n > 0) {
      params.maxPrice = Math.round(n);
      labelParts.push(`under ₱${Math.round(n).toLocaleString()}`);
    }
  }

  if (Object.keys(params).length === 0) return null;

  const qs = Object.entries(params).map(([k, v]) =>
    `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
  ).join('&');

  let label;
  if (labelParts.length) {
    label = `Browse all ${labelParts.join(' ')}`;
  } else {
    label = 'Browse all properties';
  }
  return { url: `/properties.html?${qs}`, label };
}

// Build a list of action buttons (CTAs) to render under the bot reply.
function buildActions(message, hasMatches, search) {
  const m = (message || '').toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (a) => {
    const k = a.url + '|' + a.label;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };

  if (/\b(closing|fees|cgt|dst|registration|transfer\s*tax|title transfer|capital gains|documentary stamp)\b/.test(m)) {
    push({ label: 'Closing fees calculator', url: '/calculator.html', kind: 'primary' });
  }
  if (/\b(afford|how much can i (?:afford|borrow|pay)|max price|budget)\b/.test(m)) {
    push({ label: 'Affordability calculator', url: '/affordability.html', kind: 'primary' });
  }
  if (/\b(amortization|monthly payment|loan payment|mortgage|installment)\b/.test(m)) {
    push({ label: 'Amortization calculator', url: '/amortization.html', kind: 'primary' });
  }
  if (/\b(rental yield|cap rate|return on investment|roi|gross yield|net yield)\b/.test(m)) {
    push({ label: 'Rental yield calculator', url: '/rental-yield.html', kind: 'primary' });
  }
  if (/\b(zonal|bir zonal|zonal value|fair market value|fmv)\b/.test(m)) {
    push({ label: 'BIR Zonal Value lookup', url: '/zonal.html', kind: 'primary' });
  }
  if (/\b(ercf|registration fee|lra|register of deeds|rd fees)\b/.test(m)) {
    push({ label: 'Registration fee estimator', url: '/ercf.html', kind: 'primary' });
  }
  if (/\b(cost of ownership|annual cost|hoa|association dues|rpt|real property tax|maintenance)\b/.test(m)) {
    push({ label: 'Cost of ownership calculator', url: '/cost-of-ownership.html', kind: 'primary' });
  }

  if (/\b(guide|process|how (do|to)|cct|tct|deed|documentation|documents needed|requirements|paperwork)\b/.test(m)) {
    push({ label: 'Buying & docs guide', url: '/guide.html', kind: 'secondary' });
  }
  if (/\b(neighborhood|neighbourhood|area|location guide|where to live|what's it like)\b/.test(m)) {
    push({ label: 'Neighborhoods overview', url: '/neighborhoods.html', kind: 'secondary' });
  }
  if (/\b(bgc|bonifacio)\b/.test(m)) push({ label: 'Living in BGC', url: '/living-in-bgc.html', kind: 'secondary' });
  if (/\b(makati)\b/.test(m))        push({ label: 'Living in Makati', url: '/living-in-makati.html', kind: 'secondary' });
  if (/\b(alabang|muntinlupa)\b/.test(m)) push({ label: 'Living in Alabang', url: '/living-in-alabang.html', kind: 'secondary' });

  if (/\b(sell|selling|list (my|a) property|i (have|own) a property|i'?m a seller|i want to lease out|rent out)\b/.test(m)) {
    push({ label: 'List your property', url: '/list-property.html', kind: 'primary' });
  }

  if (/\b(who is catherine|about (you|the broker|catherine)|credentials|prc|license)\b/.test(m)) {
    push({ label: 'About Catherine', url: '/about.html', kind: 'secondary' });
  }
  if (/\b(review|testimonial|client feedback|references)\b/.test(m)) {
    push({ label: 'Client testimonials', url: '/testimonials.html', kind: 'secondary' });
  }

  const wantsViewing = /\b(schedul|view(ing)?|tour|visit|see (the|this) (property|unit)|inspect|book(ing)?)\b/.test(m);
  const wantsContact = /\b(contact|talk to|speak (to|with)|reach|call|message|whatsapp|messenger|catherine)\b/.test(m);
  if (wantsViewing || wantsContact) {
    if (wantsViewing) {
      push({ label: 'Send inquiry / schedule', url: '/#contact-form', kind: 'primary' });
    }
    if (hasMatches && !out.find(a => a.url.startsWith('/properties.html'))) {
      push({ label: 'Browse listings', url: '/properties.html', kind: 'secondary' });
    }
    push({ label: 'Message Catherine', url: 'https://m.me/glrarealty', kind: 'contact' });
    push({ label: 'WhatsApp', url: 'https://wa.me/639171774572', kind: 'contact' });
    push({ label: 'Call now', url: 'tel:+639171774572', kind: 'contact' });
  }

  return out.slice(0, 5);
}

function buildFollowUps(message, matches, search) {
  const m = (message || '').toLowerCase();
  const out = [];
  const isPropertyQuery = matches && matches.length > 0;

  if (isPropertyQuery) {
    out.push('What are the closing costs?');
    if (search && /lease|rent/i.test(search.label || '')) {
      out.push('How does leasing work?');
    } else {
      out.push('How much can I afford?');
    }
    out.push('Schedule a viewing');
  } else if (/afford|loan|mortgage|amortization|monthly/.test(m)) {
    out.push('Show me condos in Makati');
    out.push('What are closing costs?');
    out.push('Schedule a viewing');
  } else if (/closing|fees|tax|cgt|dst|bir|zonal/.test(m)) {
    out.push('How much can I afford?');
    out.push('Show me featured listings');
    out.push('What documents do I need?');
  } else if (/foreign|expat|owner|allowed/.test(m)) {
    out.push('Show me condos in BGC');
    out.push('What documents do I need?');
    out.push('Schedule a viewing');
  } else {
    out.push('Properties in Makati');
    out.push('Closing costs estimate');
    out.push('What can I afford?');
  }
  return out.slice(0, 4);
}

function shapeListingCard(p) {
  const lt = (p.listingType || '').toUpperCase();
  const isLease = lt.includes('LEASE') || lt.includes('RENT');
  const priceNum = isLease ? (p.monthlyRental || p.price || 0) : (p.price || 0);
  return {
    id: String(p._id),
    title: p.title || 'Untitled',
    location: p.location || '',
    propertyType: p.propertyType || '',
    listingType: isLease ? 'FOR LEASE' : 'FOR SALE',
    price: priceNum,
    priceLabel: isLease
      ? `₱${Number(priceNum).toLocaleString()}/mo`
      : `₱${Number(priceNum).toLocaleString()}`,
    bedrooms: p.bedrooms || 0,
    bathrooms: p.bathrooms || 0,
    sqm: p.sqm || 0,
    image: p.mainImage || '',
    url: `/properties.html?property=${encodeURIComponent(String(p._id))}`,
  };
}

const SITE_MAP = `
SITE MAP & SERVICES (route the user to the right page):
- /properties.html   → Browse all listings (use filters: location, type, BR, price)
- /list-property.html → Owner wants to LIST/SELL/LEASE their property (lead form)
- /about.html        → About Catherine SB Sampayo (PRC #0026736, 10+ yrs)
- /testimonials.html → Client reviews
- /blog.html         → Journal / market updates
- /guide.html        → Buying & documentation guide (CCT/TCT, deeds, taxes)
- /neighborhoods.html → Area overview (BGC, Makati, Alabang, etc.)
- /living-in-bgc.html, /living-in-makati.html, /living-in-alabang.html → Neighborhood deep dives

CALCULATORS & TOOLS:
- /affordability.html → "How much can I afford?" (income → max price)
- /amortization.html  → Monthly mortgage payment + amortization schedule
- /calculator.html    → Closing fees / total cash to close (CGT 6%, DST 1.5%, transfer, registration, BIR FMV using Sec 6E NIRC)
- /cost-of-ownership.html → Recurring annual costs (assoc dues, RPT, insurance)
- /rental-yield.html  → Gross & net rental yield calculator
- /zonal.html         → BIR Zonal Value lookup (NCR + key provinces)
- /ercf.html          → Estimated Registration & Closing Fees (LRA, BIR, RD)

SERVICES OFFERED:
- Buy-side brokerage (residential & commercial, NCR + key provinces)
- Seller representation / pocket listings
- Lease / rental matching
- Pre-selling project sourcing (major developers)
- Document review & coordination (deeds, BIR, RD, HOA)

CONTACT CATHERINE DIRECTLY:
- Messenger: m.me/glrarealty
- Phone / Viber / WhatsApp: +63 917 177 4572
- Office: Manila, Philippines
- Use the "List property →" button (top nav) for sellers/lessors
- Use the in-page "Schedule a viewing" form for specific listings

KEY FACTS ABOUT GLRA REALTY:
- Founded by Catherine SB Sampayo, PRC-licensed broker (10+ years experience).
- Boutique brokerage — Catherine personally handles every client (no junior agents passing leads around).
- Specializes in NCR (Metro Manila): BGC, Makati, Alabang, Ortigas, Rockwell, etc.
- Also handles Cavite, Laguna, Tagaytay, Batangas resort properties.
- Works with both local buyers and OFW / foreign-married buyers (foreigners can own condos up to 40% of the building).
`;

// ── ROUTE REGISTRATION ───────────────────────────────────────
// Takes the Express `app` and shared middleware (handleValidation) and wires
// POST /api/chat onto it. Called once from server.js at boot.
function registerChatbot(app, { handleValidation }) {
  app.post('/api/chat',
    chatLimiter,
    body('message').isString().trim().isLength({ min: 1, max: 1500 }),
    body('history').optional().isArray({ max: 20 }),
    handleValidation,
    async (req, res) => {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey && !process.env.GROQ_API_KEY) {
          console.error('No LLM provider configured (set GEMINI_API_KEY and/or GROQ_API_KEY)');
          return res.status(503).json({ error: 'Chat is not configured' });
        }

        const { message, history = [] } = req.body;

        // Serve identical (history-less first-turn) questions from cache when possible.
        if (!history || history.length === 0) {
          const cached = chatReplyCacheGet(message);
          if (cached) return res.json(cached);
        }

        // ── Build live property context ──
        let listingContext = '';
        let topMatches = [];
        let serverSearchLink = null;
        const propertyIntent = hasPropertyIntent(message);
        try {
          const allListings = await getAllAvailableListingsCached();

          if (allListings.length) {
            const featuredSet = allListings.filter(p => p.featured).slice(0, 12);

            const RELEVANCE_THRESHOLD = 4;
            const scored = scoreListings(message, allListings);
            const relevant = scored.filter(x => x.s >= RELEVANCE_THRESHOLD).slice(0, 12).map(x => x.p);

            topMatches = propertyIntent ? relevant.slice(0, 3) : [];

            const seen = new Set();
            const merged = [];
            for (const p of [...relevant, ...featuredSet]) {
              const key = String(p._id);
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(p);
              if (merged.length >= 8) break;
            }

            const locCounts = {};
            for (const p of allListings) {
              const loc = (p.location || 'Unknown').split(',')[0].trim();
              locCounts[loc] = (locCounts[loc] || 0) + 1;
            }
            const locIndex = Object.entries(locCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([loc, n]) => `${loc} (${n})`)
              .join(', ');

            const totalSale  = allListings.filter(p => !((p.listingType||'').toUpperCase().includes('LEASE'))).length;
            const totalLease = allListings.length - totalSale;

            listingContext = `

LIVE INVENTORY SNAPSHOT (do NOT invent listings — only reference what's below):
- Total available: ${allListings.length} (${totalSale} for sale, ${totalLease} for lease)
- By area: ${locIndex}

MOST RELEVANT LISTINGS for this query:
${merged.map(fmtListing).join('\n')}

The frontend will automatically render the top 3 relevant listings as visual cards under your reply, plus a "Browse all" search button. So you do NOT need to repeat the full property details — just write a short, natural intro paragraph (1-3 sentences) like "Yes — here are some matches in Makati right now:" and the cards/button will appear below. If the user's area is not in the "By area" list, say so honestly and suggest contacting Catherine.`;
          } else {
            listingContext = `

LIVE INVENTORY SNAPSHOT: no listings are currently published. Direct the user to message Catherine at m.me/glrarealty so she can source matches.`;
          }

          if (propertyIntent) {
            serverSearchLink = deriveSearchFromMessage(message);
          }
        } catch (e) {
          console.error('Chat listing context error:', e?.message);
        }

        const systemPrompt = `You are the AI assistant for GLRA Realty (glrarealty.com), a boutique real-estate brokerage in Manila, Philippines, run by Catherine SB Sampayo (PRC-licensed broker, 10+ years experience, est. 2014).

ROLE:
- Answer questions about Philippine real estate: buying, selling, leasing, taxes, financing, neighborhoods, documentation.
- Help users find properties (from LIVE INVENTORY only — never invent), explain process, point to calculators.
- Encourage contacting Catherine for viewings/personal advice (m.me/glrarealty, +63 917 177 4572).

OUTPUT STYLE — IMPORTANT:
- Keep replies SHORT: 1-3 sentences for the intro, then optional 1-2 brief bullet points.
- The frontend AUTO-RENDERS the following under your reply (so do NOT add them yourself):
    1. Property cards (image + price + specs) for matched listings
    2. A "Browse all matches" search button
    3. Action buttons for the right page/tool (closing-fees calculator, affordability, amortization, message Catherine, schedule viewing, etc.)
- So do NOT manually list properties as a numbered list, do NOT include /properties.html URLs, and do NOT include URLs to /calculator.html, /affordability.html, /amortization.html, /rental-yield.html, /zonal.html, /ercf.html, /cost-of-ownership.html, /guide.html, /neighborhoods.html, /list-property.html, /about.html, or /testimonials.html. Those will all be rendered as buttons.
- DO mention by name when relevant ("you can use our closing fees calculator") — just don't link them, the button handles that.
- Use peso symbol ₱. Use local terms (CCT, TCT, BIR zonal, CGT, DST, RPT, ERCF) when accurate.
- Use Filipino/Taglish if the user does; default to clear English.
- NEVER claim to be human. If pressed: "I'm an AI assistant — Catherine handles the real conversations."
- For complex legal/tax questions, redirect to Catherine.

ANSWERING "DO YOU HAVE PROPERTIES IN <AREA>?":
- Check the "By area" list. If the area appears, say something like: "Yes — here's what's in <area> right now:" (the cards + Browse button render below automatically).
- If the area is NOT in the list, say honestly: "We don't have anything currently published in <area>. Catherine can source one — message her at m.me/glrarealty." (Cards may still render with closest matches.)

ANSWERING SPECIFIC QUESTIONS ABOUT A LISTED PROPERTY (e.g. "what is the sqm of the Gentry Residences?", "how many bedrooms in The Columns?", "price of San Antonio Residence?"):
- LOOK UP the listing in the "MOST RELEVANT LISTINGS" block below. Each line has the title in [brackets] followed by location, price, BR/BA/sqm, type, and category.
- If you find it, answer DIRECTLY with the facts from that line. Example: "Gentry Residences in Makati City is a 2BR / 2BA / 95sqm condominium for ₱30,000,000." Quote only the fields the user asked about — don't dump everything.
- If the property the user named is NOT in the snapshot, say honestly: "I don't have that one in my live inventory — message Catherine at m.me/glrarealty for the latest details." Do NOT invent numbers.
- NEVER say "I don't have the specific details" for a property that IS in the snapshot below. The data is right there — use it.

TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}.
${SITE_MAP}${listingContext}`;

        // ── Provider call: try Gemini, fall back to Groq on quota errors ──
        let llmResult;
        let llmError;
        const hasGemini = !!apiKey;
        const hasGroq   = !!process.env.GROQ_API_KEY;

        const primary = process.env.PRIMARY_LLM === 'groq' ? 'groq' : 'gemini';
        const order = primary === 'groq'
          ? [hasGroq && 'groq', hasGemini && 'gemini']
          : [hasGemini && 'gemini', hasGroq && 'groq'];

        for (const provider of order.filter(Boolean)) {
          try {
            if (provider === 'gemini') {
              llmResult = await callGemini({ apiKey, systemPrompt, history, message });
            } else {
              llmResult = await callGroq({ apiKey: process.env.GROQ_API_KEY, systemPrompt, history, message });
            }
            break;
          } catch (e) {
            llmError = e;
            const fallbackable = e.status === 429 || e.status === 503 ||
                                 /quota|rate|exceed|unavailable/i.test(e.message || '');
            console.warn(`[chat] ${provider} failed (${e.status || '?'}): ${(e.message || '').slice(0, 200)}` +
                         (fallbackable && order.length > 1 ? ' — falling back' : ''));
            if (!fallbackable) break;
          }
        }

        if (!llmResult) {
          const status  = llmError?.status || 502;
          const errText = llmError?.body || llmError?.message || '';
          const lower   = errText.toLowerCase();
          let userMsg = 'Chat service is having trouble. Please try again, or message Catherine directly at m.me/glrarealty.';
          if (status === 404 || lower.includes('not found')) {
            userMsg = "I can't reach my model right now (404). The site owner may need to update model env vars. In the meantime, message Catherine at m.me/glrarealty.";
          } else if (status === 403 || lower.includes('permission') || lower.includes('api key')) {
            userMsg = "My API key isn't authorized right now. Please message Catherine at m.me/glrarealty.";
          } else if (status === 429 || lower.includes('quota') || lower.includes('rate')) {
            userMsg = "I'm at my hourly limit right now. **Message Catherine directly** at [m.me/glrarealty](https://m.me/glrarealty) — she'll get back to you fast.";
          }
          return res.status(502).json({ error: userMsg });
        }

        const { text, finish } = llmResult;
        let finalReply;
        if (typeof text === 'string' && text.trim()) {
          finalReply = text.trim();
        } else if (finish === 'SAFETY') {
          finalReply = "Sorry, I can't help with that. Try a property or buying-process question, or message Catherine directly at m.me/glrarealty.";
        } else if (finish === 'MAX_TOKENS' || finish === 'length') {
          finalReply = "I have a longer answer for that — could you ask something more specific, or message Catherine directly at m.me/glrarealty?";
        } else {
          finalReply = "I didn't catch that. Could you rephrase, or message Catherine directly at m.me/glrarealty?";
        }

        // Strip any /properties.html links — frontend renders its own.
        finalReply = finalReply.replace(/\[([^\]]+)\]\(\/properties\.html[^\)]*\)\s*/g, '');
        // Strip links for any page we'll already render as an action button.
        finalReply = finalReply.replace(/\[([^\]]+)\]\((\/(?:calculator|affordability|amortization|rental-yield|zonal|ercf|cost-of-ownership|guide|neighborhoods|living-in-bgc|living-in-makati|living-in-alabang|list-property|about|testimonials)\.html[^\)]*)\)/g, '$1');

        const actions = buildActions(message, topMatches.length > 0, serverSearchLink);
        const suggestions = buildFollowUps(message, topMatches, serverSearchLink);

        const payload = {
          reply: finalReply,
          properties: topMatches.map(shapeListingCard),
          search: serverSearchLink,
          actions,
          suggestions,
        };

        if (!history || history.length === 0) {
          chatReplyCacheSet(message, payload);
        }

        res.json(payload);
      } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: 'Chat service error' });
      }
    }
  );
}

module.exports = { registerChatbot, invalidateChatListingsCache };
