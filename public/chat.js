/* GLRA Realty — Brutalist AI chatbot widget
   Single-file: injects CSS, HTML, and behavior. Talks to /api/chat.
   Loaded on every page. Idempotent. Persists conversation across page navigations
   via sessionStorage so navigating between pages doesn't lose context.

   Server response shape (see /api/chat in server.js):
     { reply: string,
       properties: [{id,title,location,price,priceLabel,bedrooms,bathrooms,sqm,image,url,...}],
       search: { url, label } | null,
       suggestions: string[] }
*/
(function () {
  if (window.__glraChatLoaded) return;
  window.__glraChatLoaded = true;

  // ── 1. STYLES ─────────────────────────────────────────────────
  // High-specificity selectors + !important required to beat the brutalist-theme.css
  // global "button { ... !important }" rule on inner pages.
  var css = `
button.glra-chat-fab{
  position:fixed !important;left:14px !important;bottom:74px !important;z-index:1100 !important;
  width:58px !important;height:58px !important;
  border:0 !important;border-radius:0 !important;cursor:pointer !important;
  background:#ff3d00 !important;color:#fff !important;
  font-size:22px !important;letter-spacing:0 !important;text-transform:none !important;
  padding:0 !important;box-sizing:border-box !important;
  display:flex !important;align-items:center !important;justify-content:center !important;
  box-shadow:4px 4px 0 #0a0a0a !important;
  transition:transform .15s,background .15s !important;
  font-family:'Inter','Segoe UI',sans-serif !important;
}
button.glra-chat-fab:hover{
  background:#0a0a0a !important;color:#fff !important;
  transform:translate(-2px,-2px) !important;
  box-shadow:6px 6px 0 #ff3d00 !important;
}
button.glra-chat-fab svg{width:30px;height:30px;display:block;pointer-events:none}
button.glra-chat-fab .glra-chat-pulse{
  position:absolute;top:-3px;right:-3px;width:10px;height:10px;background:#fff;
  border:1px solid #0a0a0a;animation:glraChatPulse 1.5s infinite;
}
@keyframes glraChatPulse{0%,100%{opacity:1}50%{opacity:.4}}
@media(max-width:768px){
  button.glra-chat-fab{left:14px !important;bottom:68px !important;width:52px !important;height:52px !important}
  button.glra-chat-fab svg{width:26px;height:26px}
}

.glra-chat-panel{
  position:fixed;left:14px;bottom:84px;width:430px;max-width:calc(100vw - 28px);
  height:640px;max-height:calc(100vh - 110px);
  background:#f1eee9;color:#0a0a0a;border:2px solid #0a0a0a;
  z-index:1101;display:none;flex-direction:column;
  font-family:'Inter','Segoe UI',sans-serif;
  box-shadow:8px 8px 0 #0a0a0a;
}
.glra-chat-panel.open{display:flex;animation:glraChatIn .18s ease}
@keyframes glraChatIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media(max-width:560px){
  .glra-chat-panel{left:8px;right:8px;bottom:8px;width:auto;max-width:none;height:88vh;max-height:none}
}
body.dark-mode .glra-chat-panel{background:#0e0e0c;color:#f1eee9;border-color:#3a3a36;box-shadow:8px 8px 0 #ff3d00}

.glra-chat-head{
  background:#0a0a0a;color:#f1eee9;padding:14px 16px;
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  border-bottom:2px solid #0a0a0a;
}
.glra-chat-head .glra-chat-title{
  font-family:'Inter',sans-serif;font-size:14px;font-weight:900;
  letter-spacing:-.3px;text-transform:uppercase;display:flex;align-items:center;gap:10px;
}
.glra-chat-head .glra-chat-title small{
  display:block;font-family:'JetBrains Mono',monospace;
  font-size:9px;letter-spacing:1.5px;color:rgba(241,238,233,.6);
  font-weight:600;margin-top:2px;text-transform:uppercase;
}
.glra-chat-head .glra-live{display:inline-block;width:8px;height:8px;background:#ff3d00;animation:glraChatPulse 1.5s infinite}
.glra-chat-head .glra-chat-actions{display:flex;align-items:center;gap:4px}
button.glra-chat-iconbtn,button.glra-chat-close{
  background:transparent !important;border:0 !important;color:#f1eee9 !important;
  font-size:18px !important;cursor:pointer !important;padding:4px 8px !important;
  line-height:1 !important;font-family:inherit !important;
  letter-spacing:0 !important;text-transform:none !important;
  box-shadow:none !important;border-radius:0 !important;width:auto !important;height:auto !important;
}
button.glra-chat-iconbtn:hover,button.glra-chat-close:hover{color:#ff3d00 !important;background:transparent !important}
button.glra-chat-close{font-size:22px !important}

.glra-chat-body{
  flex:1 1 auto;overflow-y:auto;padding:16px 16px 8px;
  display:flex;flex-direction:column;gap:12px;
  scrollbar-width:thin;scrollbar-color:#ff3d00 transparent;
}
.glra-chat-body::-webkit-scrollbar{width:5px}
.glra-chat-body::-webkit-scrollbar-thumb{background:#ff3d00}

.glra-msg{
  max-width:88%;padding:11px 14px;font-size:13.5px;line-height:1.5;
  border:1px solid #0a0a0a;border-radius:0;word-wrap:break-word;
}
.glra-msg.user{align-self:flex-end;background:#ff3d00;color:#fff;border-color:#ff3d00}
.glra-msg.bot{align-self:flex-start;background:#fff;color:#0a0a0a}
body.dark-mode .glra-msg.bot{background:#1a1a17;color:#f1eee9;border-color:#3a3a36}
.glra-msg.bot a{color:#ff3d00;text-decoration:underline;font-weight:600}
.glra-msg.bot strong{font-weight:700}
.glra-msg.bot ul,.glra-msg.bot ol{margin:6px 0 6px 18px}
.glra-msg.bot p{margin:0 0 6px 0}
.glra-msg.bot p:last-child{margin-bottom:0}

/* Property cards rendered under bot messages */
.glra-cards{align-self:stretch;display:flex;flex-direction:column;gap:8px;margin-top:-4px}
a.glra-card{
  display:flex !important;gap:10px;padding:8px;
  background:#fff;color:#0a0a0a !important;border:1px solid #0a0a0a;
  text-decoration:none !important;transition:.15s;align-items:stretch;
}
body.dark-mode a.glra-card{background:#1a1a17;color:#f1eee9 !important;border-color:#3a3a36}
a.glra-card:hover{box-shadow:4px 4px 0 #ff3d00;transform:translate(-2px,-2px)}
a.glra-card .glra-card-img{
  flex:0 0 84px;width:84px;height:84px;object-fit:cover;background:#ddd;
  border-right:1px solid rgba(0,0,0,.08);
}
a.glra-card .glra-card-img-fallback{
  flex:0 0 84px;width:84px;height:84px;background:#0a0a0a;color:#ff3d00;
  display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;
  font-size:9px;letter-spacing:1.5px;
}
a.glra-card .glra-card-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px}
a.glra-card .glra-card-title{
  font-family:'Inter',sans-serif;font-size:12.5px;font-weight:800;
  letter-spacing:-.2px;text-transform:uppercase;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
a.glra-card .glra-card-loc{
  font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:1px;
  color:#666;text-transform:uppercase;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
body.dark-mode a.glra-card .glra-card-loc{color:#9a9a96}
a.glra-card .glra-card-meta{
  display:flex;gap:10px;align-items:center;margin-top:2px;
  font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.5px;
}
a.glra-card .glra-card-price{color:#ff3d00;font-weight:900;font-size:11.5px}
a.glra-card .glra-card-spec{color:#666}
body.dark-mode a.glra-card .glra-card-spec{color:#9a9a96}

/* "Browse all" CTA button */
a.glra-search-cta{
  align-self:stretch;display:flex !important;align-items:center;justify-content:space-between;
  padding:10px 14px;
  background:#ff3d00 !important;color:#fff !important;text-decoration:none !important;
  font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;
  letter-spacing:1.5px;text-transform:uppercase;border:1px solid #ff3d00;
  transition:.15s;
}
a.glra-search-cta:hover{background:#0a0a0a !important;border-color:#0a0a0a;transform:translate(-2px,-2px);box-shadow:4px 4px 0 #ff3d00}
a.glra-search-cta .arr{font-size:14px}

/* Quick contact bar — always-visible "Talk to Catherine" channels */
.glra-contact-bar{
  display:flex;gap:6px;padding:8px 16px 0;
}
.glra-contact-bar a{
  flex:1 1 auto;display:flex;align-items:center;justify-content:center;gap:6px;
  padding:8px 6px;text-decoration:none !important;
  background:transparent;color:#0a0a0a !important;border:1px solid #0a0a0a;
  font-family:'JetBrains Mono',monospace;font-size:9.5px;font-weight:700;
  letter-spacing:1px;text-transform:uppercase;transition:.15s;
}
body.dark-mode .glra-contact-bar a{color:#f1eee9 !important;border-color:#3a3a36}
.glra-contact-bar a:hover{background:#ff3d00;color:#fff !important;border-color:#ff3d00}

.glra-typing{
  align-self:flex-start;background:#fff;border:1px solid #0a0a0a;
  padding:12px 14px;display:flex;gap:4px;align-items:center;
}
body.dark-mode .glra-typing{background:#1a1a17;border-color:#3a3a36}
.glra-typing span{
  width:6px;height:6px;background:#ff3d00;border-radius:50%;
  animation:glraTypeBounce 1.2s infinite;
}
.glra-typing span:nth-child(2){animation-delay:.15s}
.glra-typing span:nth-child(3){animation-delay:.3s}
@keyframes glraTypeBounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}

.glra-chat-suggest{
  display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;
  border-top:1px solid rgba(0,0,0,.08);
}
body.dark-mode .glra-chat-suggest{border-top-color:rgba(241,238,233,.1)}
button.glra-chat-suggest-btn{
  background:transparent !important;border:1px solid #0a0a0a !important;color:#0a0a0a !important;
  font-family:'JetBrains Mono',monospace !important;font-size:10px !important;
  font-weight:700 !important;letter-spacing:1px !important;text-transform:uppercase !important;
  padding:6px 10px !important;cursor:pointer !important;border-radius:0 !important;
  transition:.15s !important;width:auto !important;height:auto !important;
  box-shadow:none !important;
}
body.dark-mode button.glra-chat-suggest-btn{border-color:#3a3a36 !important;color:#f1eee9 !important}
button.glra-chat-suggest-btn:hover{background:#ff3d00 !important;color:#fff !important;border-color:#ff3d00 !important}

.glra-chat-form{display:flex;gap:0;border-top:2px solid #0a0a0a}
body.dark-mode .glra-chat-form{border-top-color:#3a3a36}
input.glra-chat-input{
  flex:1 1 auto;background:#f1eee9 !important;color:#0a0a0a !important;
  border:0 !important;padding:14px 16px !important;font-family:'Inter',sans-serif !important;
  font-size:14px !important;font-weight:500 !important;outline:none !important;
  text-transform:none !important;letter-spacing:normal !important;
}
body.dark-mode input.glra-chat-input{background:#0e0e0c !important;color:#f1eee9 !important}
input.glra-chat-input::placeholder{color:#6a6a6a !important;font-weight:600 !important;text-transform:none !important;letter-spacing:normal !important}
input.glra-chat-input:focus{background:#e8e4dd !important}
body.dark-mode input.glra-chat-input:focus{background:#1a1a17 !important}
button.glra-chat-send{
  background:#0a0a0a !important;color:#f1eee9 !important;border:0 !important;
  padding:0 18px !important;cursor:pointer !important;
  font-family:'JetBrains Mono',monospace !important;font-size:11px !important;
  font-weight:700 !important;letter-spacing:1.5px !important;text-transform:uppercase !important;
  transition:.15s !important;width:auto !important;height:auto !important;
  box-shadow:none !important;border-radius:0 !important;
}
button.glra-chat-send:hover:not(:disabled){background:#ff3d00 !important}
button.glra-chat-send:disabled{opacity:.5 !important;cursor:not-allowed !important}

@media print{button.glra-chat-fab,.glra-chat-panel{display:none !important}}
`;
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── 2. PERSISTENCE ────────────────────────────────────────────
  // Conversation now stored as full "turn" objects, not just text — so we can
  // re-render attached property cards / search CTAs on rehydration.
  var STORAGE_KEY  = 'glraChatTurns_v2';
  var OPEN_KEY     = 'glraChatOpen';
  var GREETED_KEY  = 'glraChatGreeted';
  var MAX_PERSISTED_TURNS = 30;

  function loadTurns() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveTurns(t) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(t.slice(-MAX_PERSISTED_TURNS))); } catch (e) {}
  }

  // ── 3. SVG bot icon ───────────────────────────────────────────
  var BOT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">'
    + '<rect x="4" y="7" width="16" height="12" rx="0"/>'
    + '<line x1="12" y1="3" x2="12" y2="7"/>'
    + '<circle cx="12" cy="2.5" r="1" fill="currentColor"/>'
    + '<circle cx="9" cy="12" r="1.5" fill="currentColor"/>'
    + '<circle cx="15" cy="12" r="1.5" fill="currentColor"/>'
    + '<line x1="9" y1="16" x2="15" y2="16"/>'
    + '<line x1="2" y1="13" x2="4" y2="13"/>'
    + '<line x1="20" y1="13" x2="22" y2="13"/>'
    + '</svg>';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    // Build the FAB
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'glra-chat-fab';
    fab.setAttribute('aria-label', 'Open chat with GLRA assistant');
    fab.innerHTML = '<span class="glra-chat-pulse"></span>' + BOT_SVG;
    document.body.appendChild(fab);

    // Build the panel
    var panel = document.createElement('div');
    panel.className = 'glra-chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat with GLRA assistant');
    panel.innerHTML =
      '<div class="glra-chat-head">' +
        '<div class="glra-chat-title">' +
          '<span class="glra-live"></span>' +
          '<span>GLRA Assistant<small>// Powered by AI · Backed by Catherine</small></span>' +
        '</div>' +
        '<div class="glra-chat-actions">' +
          '<button class="glra-chat-iconbtn" type="button" id="glraChatClear" aria-label="Clear conversation" title="Clear conversation">⟲</button>' +
          '<button class="glra-chat-close" type="button" aria-label="Close chat">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="glra-contact-bar">' +
        '<a href="https://m.me/glrarealty" target="_blank" rel="noopener" title="Messenger">💬 Messenger</a>' +
        '<a href="https://wa.me/639171774572" target="_blank" rel="noopener" title="WhatsApp">📱 WhatsApp</a>' +
        '<a href="tel:+639171774572" title="Call">📞 Call</a>' +
      '</div>' +
      '<div class="glra-chat-body" id="glraChatBody"></div>' +
      '<div class="glra-chat-suggest" id="glraChatSuggest"></div>' +
      '<form class="glra-chat-form" id="glraChatForm">' +
        '<input class="glra-chat-input" id="glraChatInput" type="text" placeholder="Ask anything about Philippine real estate…" maxlength="1500" autocomplete="off" />' +
        '<button type="submit" class="glra-chat-send" id="glraChatSend">Send</button>' +
      '</form>';
    document.body.appendChild(panel);

    // ── 4. STATE & BEHAVIOR ──────────────────────────────────────
    var bodyEl  = panel.querySelector('#glraChatBody');
    var sug     = panel.querySelector('#glraChatSuggest');
    var form    = panel.querySelector('#glraChatForm');
    var input   = panel.querySelector('#glraChatInput');
    var sendBtn = panel.querySelector('#glraChatSend');
    var closeBtn= panel.querySelector('.glra-chat-close');
    var clearBtn= panel.querySelector('#glraChatClear');
    var turns   = loadTurns(); // [{role, text, properties?, search?}]

    function escapeHtml(s) {
      var div = document.createElement('div');
      div.textContent = s == null ? '' : String(s);
      return div.innerHTML;
    }

    function formatBot(text) {
      var html = escapeHtml(text);
      html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, function (_, label, url) {
        return '<a href="' + url + '" target="_self">' + label + '</a>';
      });
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/(^|<br>)\s*[-*]\s+([^<\n]+)/g, '$1• $2');
      html = html.replace(/\n/g, '<br>');
      return html;
    }

    function renderProperty(card) {
      var img = card.image
        ? '<img class="glra-card-img" loading="lazy" src="' + escapeHtml(card.image) + '" alt="">'
        : '<div class="glra-card-img-fallback">' + escapeHtml((card.propertyType || 'GLRA').slice(0, 4).toUpperCase()) + '</div>';
      return '<a class="glra-card" href="' + escapeHtml(card.url) + '" target="_self">' +
        img +
        '<div class="glra-card-body">' +
          '<div class="glra-card-title">' + escapeHtml(card.title) + '</div>' +
          '<div class="glra-card-loc">' + escapeHtml(card.location) + '</div>' +
          '<div class="glra-card-meta">' +
            '<span class="glra-card-price">' + escapeHtml(card.priceLabel) + '</span>' +
            '<span class="glra-card-spec">' + (card.bedrooms || 0) + 'BR · ' + (card.bathrooms || 0) + 'BA · ' + (card.sqm || 0) + 'sqm</span>' +
          '</div>' +
        '</div>' +
      '</a>';
    }

    function renderTurn(t) {
      // Bot message bubble
      if (t.role === 'assistant') {
        var msg = document.createElement('div');
        msg.className = 'glra-msg bot';
        msg.innerHTML = formatBot(t.text);
        bodyEl.appendChild(msg);

        // Property cards
        if (t.properties && t.properties.length) {
          var cards = document.createElement('div');
          cards.className = 'glra-cards';
          cards.innerHTML = t.properties.map(renderProperty).join('');
          bodyEl.appendChild(cards);
        }

        // Search CTA
        if (t.search && t.search.url) {
          var cta = document.createElement('a');
          cta.className = 'glra-search-cta';
          cta.href = t.search.url;
          cta.target = '_self';
          cta.innerHTML = '<span>' + escapeHtml(t.search.label || 'Browse all matches') + '</span><span class="arr">→</span>';
          bodyEl.appendChild(cta);
        }
      } else {
        var u = document.createElement('div');
        u.className = 'glra-msg user';
        u.textContent = t.text;
        bodyEl.appendChild(u);
      }
    }

    function rerender() {
      bodyEl.innerHTML = '';
      turns.forEach(renderTurn);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function pushTurn(turn) {
      turns.push(turn);
      saveTurns(turns);
      renderTurn(turn);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function addTyping() {
      var t = document.createElement('div');
      t.className = 'glra-typing';
      t.id = 'glraChatTyping';
      t.innerHTML = '<span></span><span></span><span></span>';
      bodyEl.appendChild(t);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
    function removeTyping() {
      var t = document.getElementById('glraChatTyping');
      if (t) t.remove();
    }

    var DEFAULT_SUGGESTIONS = [
      'Properties in Makati',
      'Condos for lease in BGC',
      'Closing costs estimate',
      'How much can I afford?'
    ];
    function renderSuggest(list) {
      sug.innerHTML = '';
      var items = (list && list.length) ? list : DEFAULT_SUGGESTIONS;
      items.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'glra-chat-suggest-btn';
        b.textContent = s;
        b.addEventListener('click', function () {
          input.value = s;
          form.dispatchEvent(new Event('submit', { cancelable: true }));
        });
        sug.appendChild(b);
      });
      sug.style.display = items.length ? 'flex' : 'none';
    }

    function greet() {
      var greet = {
        role: 'assistant',
        text: "Kumusta! I'm Catherine's AI assistant for **GLRA Realty**.\n\nAsk me about properties, closing costs, or the buying process. Try things like *\"3BR condo in Makati under 30M\"* — I'll surface real listings and link you to a filtered search.",
      };
      pushTurn(greet);
      renderSuggest(DEFAULT_SUGGESTIONS);
      try { sessionStorage.setItem(GREETED_KEY, '1'); } catch (e) {}
    }

    function open() {
      panel.classList.add('open');
      fab.style.display = 'none';
      try { sessionStorage.setItem(OPEN_KEY, '1'); } catch (e) {}
      if (turns.length === 0) {
        if (sessionStorage.getItem(GREETED_KEY) !== '1') greet();
        else renderSuggest(DEFAULT_SUGGESTIONS);
      } else {
        rerender();
        // Reuse the most recent assistant suggestions if they exist.
        var last = [].concat(turns).reverse().find(function (t) { return t.role === 'assistant' && t.suggestions; });
        renderSuggest(last ? last.suggestions : DEFAULT_SUGGESTIONS);
      }
      setTimeout(function () { input.focus(); }, 100);
    }
    function close() {
      panel.classList.remove('open');
      fab.style.display = 'flex';
      try { sessionStorage.setItem(OPEN_KEY, '0'); } catch (e) {}
    }
    function clearConversation() {
      turns = [];
      saveTurns(turns);
      try { sessionStorage.removeItem(GREETED_KEY); } catch (e) {}
      bodyEl.innerHTML = '';
      greet();
    }

    fab.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    clearBtn.addEventListener('click', clearConversation);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });

    try {
      if (sessionStorage.getItem(OPEN_KEY) === '1') setTimeout(open, 50);
    } catch (e) {}

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var msg = (input.value || '').trim();
      if (!msg) return;

      sug.innerHTML = '';
      pushTurn({ role: 'user', text: msg });
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;
      addTyping();

      // Send last 12 plain {role,text} turns (strip card data — server doesn't need it).
      var sendHistory = turns.slice(0, -1).slice(-12).map(function (t) {
        return { role: t.role, text: t.text };
      });

      try {
        var r = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, history: sendHistory })
        });
        removeTyping();
        var data = await r.json().catch(function () { return {}; });
        if (r.ok && data.reply) {
          pushTurn({
            role: 'assistant',
            text: data.reply,
            properties: Array.isArray(data.properties) ? data.properties : null,
            search: data.search || null,
            suggestions: Array.isArray(data.suggestions) ? data.suggestions : null,
          });
          renderSuggest(data.suggestions);
        } else {
          var err = (data && data.error) || "Hmm, I couldn't reach the server. Please try again, or message Catherine directly: [m.me/glrarealty](https://m.me/glrarealty)";
          pushTurn({ role: 'assistant', text: err });
          renderSuggest(DEFAULT_SUGGESTIONS);
        }
      } catch (e) {
        removeTyping();
        pushTurn({ role: 'assistant', text: "Network error. Please try again, or message Catherine directly: [m.me/glrarealty](https://m.me/glrarealty)" });
        renderSuggest(DEFAULT_SUGGESTIONS);
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    });
  });
})();
