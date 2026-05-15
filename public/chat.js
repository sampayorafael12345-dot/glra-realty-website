/* GLRA Realty — Brutalist AI chatbot widget
   Single-file: injects CSS, HTML, and behavior. Talks to /api/chat (Gemini proxy).
   Loaded on every page. Idempotent. ~7KB compressed.
*/
(function () {
  if (window.__glraChatLoaded) return;
  window.__glraChatLoaded = true;

  // ── 1. STYLES (injected once) ────────────────────────────────────────────
  var css = `
/* FAB lives on the LEFT side, above the back-to-top button.
   The right side is reserved for the existing contact stack
   (call/WhatsApp/Viber/Messenger/Instagram/dark-mode + mobile FAB toggle). */
.glra-chat-fab{
  position:fixed;left:14px;bottom:74px;z-index:1100;
  width:54px;height:54px;border:0;border-radius:0;cursor:pointer;
  background:#ff3d00;color:#fff;font-size:20px;
  display:flex;align-items:center;justify-content:center;
  box-shadow:4px 4px 0 #0a0a0a;transition:transform .15s,background .15s;
  font-family:inherit;
}
.glra-chat-fab:hover{background:#0a0a0a;transform:translate(-2px,-2px);box-shadow:6px 6px 0 #ff3d00}
.glra-chat-fab .glra-chat-pulse{
  position:absolute;top:-3px;right:-3px;width:10px;height:10px;background:#fff;
  border:1px solid #0a0a0a;animation:glraChatPulse 1.5s infinite;
}
@keyframes glraChatPulse{0%,100%{opacity:1}50%{opacity:.4}}
@media(max-width:768px){.glra-chat-fab{left:14px;bottom:68px;width:48px;height:48px;font-size:17px}}

.glra-chat-panel{
  position:fixed;left:14px;bottom:74px;width:380px;max-width:calc(100vw - 28px);
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
.glra-chat-close{
  background:transparent;border:0;color:#f1eee9;font-size:20px;
  cursor:pointer;padding:4px 8px;line-height:1;font-family:inherit;
}
.glra-chat-close:hover{color:#ff3d00}

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
.glra-chat-suggest button{
  background:transparent;border:1px solid #0a0a0a;color:#0a0a0a;
  font-family:'JetBrains Mono',monospace;font-size:10px;
  font-weight:700;letter-spacing:1px;text-transform:uppercase;
  padding:6px 10px;cursor:pointer;border-radius:0;transition:.15s;
}
body.dark-mode .glra-chat-suggest button{border-color:#3a3a36;color:#f1eee9}
.glra-chat-suggest button:hover{background:#ff3d00;color:#fff;border-color:#ff3d00}

.glra-chat-form{
  display:flex;gap:0;border-top:2px solid #0a0a0a;
}
body.dark-mode .glra-chat-form{border-top-color:#3a3a36}
.glra-chat-input{
  flex:1 1 auto;background:#f1eee9;color:#0a0a0a;
  border:0;padding:14px 16px;font-family:'Inter',sans-serif;
  font-size:14px;font-weight:500;outline:none;
}
body.dark-mode .glra-chat-input{background:#0e0e0c;color:#f1eee9}
.glra-chat-input::placeholder{color:#6a6a6a;font-weight:600}
.glra-chat-input:focus{background:#e8e4dd}
body.dark-mode .glra-chat-input:focus{background:#1a1a17}
.glra-chat-send{
  background:#0a0a0a;color:#f1eee9;border:0;padding:0 18px;cursor:pointer;
  font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;
  letter-spacing:1.5px;text-transform:uppercase;transition:.15s;
}
.glra-chat-send:hover:not(:disabled){background:#ff3d00}
.glra-chat-send:disabled{opacity:.5;cursor:not-allowed}

@media print{.glra-chat-fab,.glra-chat-panel{display:none !important}}
`;

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── 2. HTML (injected once) ─────────────────────────────────────────────
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'glra-chat-fab';
    fab.setAttribute('aria-label', 'Open chat with GLRA assistant');
    fab.innerHTML = '<span class="glra-chat-pulse"></span><i class="fas fa-comments"></i>';
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
        <button class="glra-chat-close" type="button" aria-label="Close chat">×</button>
      </div>
      <div class="glra-chat-body" id="glraChatBody"></div>
      <div class="glra-chat-suggest" id="glraChatSuggest"></div>
      <form class="glra-chat-form" id="glraChatForm">
        <input class="glra-chat-input" id="glraChatInput" type="text" placeholder="Ask anything about Philippine real estate…" maxlength="1500" autocomplete="off" />
        <button type="submit" class="glra-chat-send" id="glraChatSend">Send</button>
      </form>
    `;
    document.body.appendChild(panel);

    // ── 3. STATE & BEHAVIOR ──────────────────────────────────────────────
    var body    = panel.querySelector('#glraChatBody');
    var sug     = panel.querySelector('#glraChatSuggest');
    var form    = panel.querySelector('#glraChatForm');
    var input   = panel.querySelector('#glraChatInput');
    var sendBtn = panel.querySelector('#glraChatSend');
    var closeBtn= panel.querySelector('.glra-chat-close');
    var history = []; // [{role:'user'|'assistant', text:''}]

    function escapeHtml(s) {
      var div = document.createElement('div');
      div.textContent = s == null ? '' : String(s);
      return div.innerHTML;
    }
    // Light Markdown-ish formatter: **bold**, *italic*, [text](url), \n -> <br>, lists
    function formatBot(text) {
      var html = escapeHtml(text);
      // Auto-link bare URLs
      html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      // Inline links [text](url)
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // Bold
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      // Bullets (lines starting with - or *)
      html = html.replace(/(^|<br>)\s*[-*]\s+([^<\n]+)/g, '$1• $2');
      // Newlines
      html = html.replace(/\n/g, '<br>');
      return html;
    }

    function addMsg(role, text) {
      var el = document.createElement('div');
      el.className = 'glra-msg ' + role;
      el.innerHTML = role === 'bot' ? formatBot(text) : escapeHtml(text);
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
    }

    function addTyping() {
      var t = document.createElement('div');
      t.className = 'glra-typing';
      t.id = 'glraChatTyping';
      t.innerHTML = '<span></span><span></span><span></span>';
      body.appendChild(t);
      body.scrollTop = body.scrollHeight;
    }
    function removeTyping() {
      var t = document.getElementById('glraChatTyping');
      if (t) t.remove();
    }

    var SUGGESTIONS = [
      'What can I afford?',
      'Closing costs estimate',
      "Foreigner buying — what's allowed?",
      'Show me featured listings',
      'How long does buying take?'
    ];
    function renderSuggest() {
      sug.innerHTML = '';
      SUGGESTIONS.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = s;
        b.addEventListener('click', function () {
          input.value = s;
          form.dispatchEvent(new Event('submit', { cancelable: true }));
        });
        sug.appendChild(b);
      });
    }

    function greet() {
      addMsg('bot', "Kumusta! I'm Catherine's AI assistant for **GLRA Realty**. I can help with property questions, calculator estimates, the buying process, or finding listings. What can I help with today?");
      renderSuggest();
    }

    function open() {
      panel.classList.add('open');
      fab.style.display = 'none';
      if (history.length === 0) greet();
      setTimeout(function () { input.focus(); }, 100);
    }
    function close() {
      panel.classList.remove('open');
      fab.style.display = 'flex';
    }
    fab.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var msg = (input.value || '').trim();
      if (!msg) return;
      // Hide suggestions after first message
      sug.style.display = 'none';
      addMsg('user', msg);
      history.push({ role: 'user', text: msg });
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;
      addTyping();
      try {
        var r = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, history: history.slice(-12, -1) })
        });
        removeTyping();
        var data = await r.json().catch(function () { return {}; });
        if (r.ok && data.reply) {
          addMsg('bot', data.reply);
          history.push({ role: 'assistant', text: data.reply });
        } else {
          var err = (data && data.error) || 'Hmm, I couldn\'t reach the server. Please try again, or message Catherine directly: [m.me/glrarealty](https://m.me/glrarealty)';
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
