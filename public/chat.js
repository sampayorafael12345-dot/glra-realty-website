/* GLRA Realty — Brutalist AI chatbot widget
   Single-file: injects CSS, HTML, and behavior. Talks to /api/chat (Gemini proxy).
   Loaded on every page. Idempotent. Persists conversation across page navigations
   via sessionStorage so navigating between pages doesn't lose context.
*/
(function () {
  if (window.__glraChatLoaded) return;
  window.__glraChatLoaded = true;

  // ── 1. STYLES ─────────────────────────────────────────────────
  // High specificity selectors (button.glra-chat-fab vs button) + !important
  // are required to beat the brutalist-theme.css global "button { ... !important }"
  // rule that would otherwise paint every chat button black.
  var css = `
button.glra-chat-fab{
  position:fixed !important;left:14px !important;bottom:74px !important;z-index:1100 !important;
  width:56px !important;height:56px !important;
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
button.glra-chat-fab svg{width:28px;height:28px;display:block;pointer-events:none}
button.glra-chat-fab .glra-chat-pulse{
  position:absolute;top:-3px;right:-3px;width:10px;height:10px;background:#fff;
  border:1px solid #0a0a0a;animation:glraChatPulse 1.5s infinite;
}
@keyframes glraChatPulse{0%,100%{opacity:1}50%{opacity:.4}}
@media(max-width:768px){
  button.glra-chat-fab{left:14px !important;bottom:68px !important;width:50px !important;height:50px !important;font-size:18px !important}
  button.glra-chat-fab svg{width:24px;height:24px}
}

.glra-chat-panel{
  position:fixed;left:14px;bottom:80px;width:380px;max-width:calc(100vw - 28px);
  height:560px;max-height:calc(100vh - 100px);
  background:#f1eee9;color:#0a0a0a;border:2px solid #0a0a0a;
  z-index:1101;display:none;flex-direction:column;
  font-family:'Inter','Segoe UI',sans-serif;
  box-shadow:8px 8px 0 #0a0a0a;
}
.glra-chat-panel.open{display:flex;animation:glraChatIn .18s ease}
@keyframes glraChatIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media(max-width:560px){
  .glra-chat-panel{left:8px;right:8px;bottom:8px;width:auto;max-width:none;height:80vh;max-height:600px}
}
body.dark-mode .glra-chat-panel{background:#0e0e0c;color:#f1eee9;border-color:#3a3a36;box-shadow:8px 8px 0 #ff3d00}

.glra-chat-head{
  background:#0a0a0a;color:#f1eee9;padding:14px 16px;
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  border-bottom:2px solid #0a0a0a;
}
.glra-chat-head .glra-chat-title{
  font-family:'Inter',sans-serif;font-size:14px;font-weight:900;
  letter-spacing:-.3px;text-transform:uppercase;display:flex;align-items:center;gap:8px;
}
.glra-chat-head .glra-chat-title small{
  display:block;font-family:'JetBrains Mono',monospace;
  font-size:9px;letter-spacing:1.5px;color:rgba(241,238,233,.6);
  font-weight:600;margin-top:2px;
}
.glra-chat-head .glra-live{display:inline-block;width:7px;height:7px;background:#ff3d00;animation:glraChatPulse 1.5s infinite}
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
  flex:1 1 auto;overflow-y:auto;padding:16px;
  display:flex;flex-direction:column;gap:10px;
  scrollbar-width:thin;scrollbar-color:#ff3d00 transparent;
}
.glra-chat-body::-webkit-scrollbar{width:5px}
.glra-chat-body::-webkit-scrollbar-thumb{background:#ff3d00}

.glra-msg{
  max-width:85%;padding:10px 13px;font-size:13.5px;line-height:1.5;
  border:1px solid #0a0a0a;border-radius:0;word-wrap:break-word;
}
.glra-msg.user{
  align-self:flex-end;background:#ff3d00;color:#fff;border-color:#ff3d00;
}
.glra-msg.bot{
  align-self:flex-start;background:#fff;color:#0a0a0a;
}
body.dark-mode .glra-msg.bot{background:#1a1a17;color:#f1eee9;border-color:#3a3a36}
.glra-msg.bot a{color:#ff3d00;text-decoration:underline;font-weight:600}
.glra-msg.bot strong{font-weight:700}
.glra-msg.bot ul,.glra-msg.bot ol{margin:6px 0 6px 18px}
.glra-msg.bot p{margin:0 0 6px 0}
.glra-msg.bot p:last-child{margin-bottom:0}

/* Inline "Browse all matches" CTA the bot can append after a property answer */
a.glra-search-cta{
  display:inline-flex;align-items:center;gap:6px;
  margin-top:8px;padding:8px 12px;
  background:#ff3d00;color:#fff !important;text-decoration:none !important;
  font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;
  letter-spacing:1.5px;text-transform:uppercase;border:1px solid #ff3d00;
}
a.glra-search-cta:hover{background:#0a0a0a;border-color:#0a0a0a}

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
  display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 10px;
}
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

.glra-chat-form{
  display:flex;gap:0;border-top:2px solid #0a0a0a;
}
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
  // sessionStorage keeps the conversation across same-tab navigations.
  // Cleared when the tab closes, which is the right scope for a chat session.
  var STORAGE_KEY  = 'glraChatHistory';
  var OPEN_KEY     = 'glraChatOpen';
  var GREETED_KEY  = 'glraChatGreeted';
  var MAX_PERSISTED_TURNS = 30;

  function loadHistory() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveHistory(h) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(h.slice(-MAX_PERSISTED_TURNS))); } catch (e) {}
  }

  // ── 3. SVG bot icon (replaces fa-comments — actually looks like a bot) ──
  var BOT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">'
    + '<rect x="4" y="7" width="16" height="12" rx="0"/>'    // body
    + '<line x1="12" y1="3" x2="12" y2="7"/>'                 // antenna stalk
    + '<circle cx="12" cy="2.5" r="1" fill="currentColor"/>'  // antenna bulb
    + '<circle cx="9" cy="12" r="1.5" fill="currentColor"/>'  // left eye
    + '<circle cx="15" cy="12" r="1.5" fill="currentColor"/>' // right eye
    + '<line x1="9" y1="16" x2="15" y2="16"/>'                // mouth
    + '<line x1="2" y1="13" x2="4" y2="13"/>'                 // left ear
    + '<line x1="20" y1="13" x2="22" y2="13"/>'               // right ear
    + '</svg>';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'glra-chat-fab';
    fab.setAttribute('aria-label', 'Open chat with GLRA assistant');
    fab.innerHTML = '<span class="glra-chat-pulse"></span>' + BOT_SVG;
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.className = 'glra-chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat with GLRA assistant');
    panel.innerHTML = `
      <div class="glra-chat-head">
        <div class="glra-chat-title">
          <span class="glra-live"></span>
          <span>GLRA Assistant<small>// Ask about properties, fees, anything</small></span>
        </div>
        <div class="glra-chat-actions">
          <button class="glra-chat-iconbtn" type="button" id="glraChatClear" aria-label="Clear conversation" title="Clear conversation">⟲</button>
          <button class="glra-chat-close" type="button" aria-label="Close chat">×</button>
        </div>
      </div>
      <div class="glra-chat-body" id="glraChatBody"></div>
      <div class="glra-chat-suggest" id="glraChatSuggest"></div>
      <form class="glra-chat-form" id="glraChatForm">
        <input class="glra-chat-input" id="glraChatInput" type="text" placeholder="Ask anything about Philippine real estate…" maxlength="1500" autocomplete="off" />
        <button type="submit" class="glra-chat-send" id="glraChatSend">Send</button>
      </form>
    `;
    document.body.appendChild(panel);

    // ── 4. STATE & BEHAVIOR ──────────────────────────────────────
    var bodyEl  = panel.querySelector('#glraChatBody');
    var sug     = panel.querySelector('#glraChatSuggest');
    var form    = panel.querySelector('#glraChatForm');
    var input   = panel.querySelector('#glraChatInput');
    var sendBtn = panel.querySelector('#glraChatSend');
    var closeBtn= panel.querySelector('.glra-chat-close');
    var clearBtn= panel.querySelector('#glraChatClear');
    var history = loadHistory(); // [{role:'user'|'assistant', text:''}]

    function escapeHtml(s) {
      var div = document.createElement('div');
      div.textContent = s == null ? '' : String(s);
      return div.innerHTML;
    }

    // Light Markdown-ish formatter: **bold**, [text](url), bullets, newlines.
    // Also auto-detects /properties.html search links and styles them as a CTA.
    function formatBot(text) {
      var html = escapeHtml(text);
      // Auto-link bare URLs
      html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      // Inline links [text](url)
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, function (_, label, url) {
        var isSearch = /^\/properties\.html(\?|$)/.test(url);
        return isSearch
          ? '<a href="' + url + '" class="glra-search-cta">→ ' + label + '</a>'
          : '<a href="' + url + '" target="_self">' + label + '</a>';
      });
      // Bold
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      // Bullets
      html = html.replace(/(^|<br>)\s*[-*]\s+([^<\n]+)/g, '$1• $2');
      // Newlines
      html = html.replace(/\n/g, '<br>');
      return html;
    }

    function addMsg(role, text, persist) {
      var el = document.createElement('div');
      el.className = 'glra-msg ' + role;
      el.innerHTML = role === 'bot' ? formatBot(text) : escapeHtml(text);
      bodyEl.appendChild(el);
      bodyEl.scrollTop = bodyEl.scrollHeight;
      if (persist !== false) {
        history.push({ role: role === 'bot' ? 'assistant' : 'user', text: text });
        saveHistory(history);
      }
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

    var SUGGESTIONS = [
      'Properties in Makati',
      'Condos for lease in BGC',
      'Closing costs estimate',
      'What can I afford?',
      'How long does buying take?'
    ];
    function renderSuggest() {
      sug.innerHTML = '';
      SUGGESTIONS.forEach(function (s) {
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
    }

    // Replay any persisted history into the panel UI so it survives navigation.
    function rehydrate() {
      bodyEl.innerHTML = '';
      if (history.length === 0) return false;
      history.forEach(function (turn) {
        var el = document.createElement('div');
        el.className = 'glra-msg ' + (turn.role === 'assistant' ? 'bot' : 'user');
        el.innerHTML = turn.role === 'assistant' ? formatBot(turn.text) : escapeHtml(turn.text);
        bodyEl.appendChild(el);
      });
      bodyEl.scrollTop = bodyEl.scrollHeight;
      sug.style.display = 'none'; // suggestions hidden once a real conversation exists
      return true;
    }

    function greet() {
      addMsg(
        'bot',
        "Kumusta! I'm Catherine's AI assistant for **GLRA Realty**. Ask me about properties (e.g. *\"3BR condo in Makati under 30M\"*), closing costs, the buying process — I'll surface matching listings and link you to the right page.",
        true
      );
      renderSuggest();
      try { sessionStorage.setItem(GREETED_KEY, '1'); } catch (e) {}
    }

    function open() {
      panel.classList.add('open');
      fab.style.display = 'none';
      try { sessionStorage.setItem(OPEN_KEY, '1'); } catch (e) {}
      var hadHistory = rehydrate();
      if (!hadHistory) {
        // First open ever this session.
        if (sessionStorage.getItem(GREETED_KEY) !== '1') greet();
        else renderSuggest();
      }
      setTimeout(function () { input.focus(); }, 100);
    }
    function close() {
      panel.classList.remove('open');
      fab.style.display = 'flex';
      try { sessionStorage.setItem(OPEN_KEY, '0'); } catch (e) {}
    }
    function clearConversation() {
      history = [];
      saveHistory(history);
      try { sessionStorage.removeItem(GREETED_KEY); } catch (e) {}
      bodyEl.innerHTML = '';
      sug.style.display = 'flex';
      greet();
    }

    fab.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    clearBtn.addEventListener('click', clearConversation);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });

    // Auto-restore: if the panel was open on the previous page, open it here too.
    try {
      if (sessionStorage.getItem(OPEN_KEY) === '1') {
        // Defer slightly so the page settles first.
        setTimeout(open, 50);
      }
    } catch (e) {}

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var msg = (input.value || '').trim();
      if (!msg) return;
      sug.style.display = 'none';
      addMsg('user', msg);
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;
      addTyping();
      try {
        // Send the most recent N turns (excluding the one we just appended).
        var sendHistory = history.slice(0, -1).slice(-12);
        var r = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, history: sendHistory })
        });
        removeTyping();
        var data = await r.json().catch(function () { return {}; });
        if (r.ok && data.reply) {
          addMsg('bot', data.reply);
        } else {
          var err = (data && data.error) || "Hmm, I couldn't reach the server. Please try again, or message Catherine directly: [m.me/glrarealty](https://m.me/glrarealty)";
          addMsg('bot', err);
        }
      } catch (e) {
        removeTyping();
        addMsg('bot', "Network error. Please try again, or message Catherine directly: [m.me/glrarealty](https://m.me/glrarealty)");
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    });
  });
})();
