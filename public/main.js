// ============ GEMINI AI CHATBOT WIDGET ============
(function() {
  if (document.getElementById('glra-chatbot-root')) return;

  const chatRoot = document.createElement('div');
  chatRoot.id = 'glra-chatbot-root';
  chatRoot.innerHTML = `
    <div id="glra-chat-toggle" class="glra-chat-toggle">
      <i class="fas fa-comment-dots"></i>
    </div>
    <div id="glra-chat-window" class="glra-chat-window" style="display:none;">
      <div class="glra-chat-header">
        <span><i class="fas fa-robot"></i> GLRA AI Assistant</span>
        <button id="glra-chat-close" class="glra-chat-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="glra-chat-messages" id="glra-chat-messages">
        <div class="glra-chat-message bot">Hello! I'm Catherine's AI assistant. Ask me anything about buying, selling, or leasing property in the Philippines.</div>
      </div>
      <div class="glra-chat-input-area">
        <textarea id="glra-chat-input" placeholder="Type your question..." rows="1"></textarea>
        <button id="glra-chat-send"><i class="fas fa-paper-plane"></i></button>
      </div>
      <div class="glra-chat-footer">Powered by Gemini AI</div>
    </div>
  `;
  document.body.appendChild(chatRoot);

  const style = document.createElement('style');
  style.textContent = `
    #glra-chatbot-root {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 10000;
      font-family: 'DM Sans', sans-serif;
    }
    .glra-chat-toggle {
      width: 56px;
      height: 56px;
      background: var(--gold, #c8a96e);
      color: #fff;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 6px 16px rgba(0,0,0,0.2);
      transition: 0.2s;
      font-size: 24px;
    }
    .glra-chat-toggle:hover {
      transform: scale(1.05);
      background: var(--gold-dark, #a8894e);
    }
    .glra-chat-window {
      position: absolute;
      bottom: 70px;
      right: 0;
      width: 360px;
      max-width: 85vw;
      height: 480px;
      background: var(--card-bg, #fff);
      border: 1px solid var(--border-color, #e2e8f0);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0,0,0,0.2);
      font-size: 14px;
    }
    body.dark-mode .glra-chat-window {
      background: #1a2840;
      border-color: #2a3f58;
    }
    .glra-chat-header {
      background: var(--navy, #0d1b2a);
      color: #fff;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      border-bottom: 1px solid rgba(200,169,110,0.2);
    }
    .glra-chat-header span i {
      margin-right: 8px;
      color: var(--gold);
    }
    .glra-chat-close {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      font-size: 16px;
      padding: 4px;
      opacity: 0.7;
    }
    .glra-chat-close:hover {
      opacity: 1;
    }
    .glra-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .glra-chat-message {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 16px;
      line-height: 1.4;
      word-wrap: break-word;
    }
    .glra-chat-message.bot {
      background: var(--gray-light, #f0f2f5);
      color: var(--text-color, #1a2332);
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .glra-chat-message.user {
      background: var(--gold, #c8a96e);
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    body.dark-mode .glra-chat-message.bot {
      background: #0a1520;
      color: #e8edf2;
    }
    .glra-chat-input-area {
      display: flex;
      border-top: 1px solid var(--border-color, #e2e8f0);
      padding: 10px;
      gap: 8px;
      background: inherit;
    }
    .glra-chat-input-area textarea {
      flex: 1;
      border: 1px solid var(--border-color, #e2e8f0);
      border-radius: 24px;
      padding: 8px 14px;
      resize: none;
      font-family: inherit;
      font-size: 13px;
      background: var(--card-bg, #fff);
      color: var(--text-color, #1a2332);
      outline: none;
    }
    .glra-chat-input-area textarea:focus {
      border-color: var(--gold);
    }
    .glra-chat-input-area button {
      background: var(--gold, #c8a96e);
      border: none;
      border-radius: 50%;
      width: 36px;
      height: 36px;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: 0.2s;
    }
    .glra-chat-input-area button:hover {
      background: var(--gold-dark, #a8894e);
    }
    .glra-chat-footer {
      font-size: 10px;
      text-align: center;
      padding: 6px;
      color: var(--gray, #7f8c8d);
      border-top: 1px solid var(--border-color, #e2e8f0);
    }
    @media (max-width: 560px) {
      .glra-chat-window { width: calc(100vw - 32px); right: 0; bottom: 70px; height: 500px; }
    }
  `;
  document.head.appendChild(style);

  const toggleBtn = document.getElementById('glra-chat-toggle');
  const chatWindow = document.getElementById('glra-chat-window');
  const closeBtn = document.getElementById('glra-chat-close');
  const sendBtn = document.getElementById('glra-chat-send');
  const inputField = document.getElementById('glra-chat-input');
  const messagesContainer = document.getElementById('glra-chat-messages');

  function addMessage(text, isUser) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `glra-chat-message ${isUser ? 'user' : 'bot'}`;
    msgDiv.textContent = text;
    messagesContainer.appendChild(msgDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  let typingIndicator = null;
  function showTyping() {
    if (typingIndicator) return;
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'glra-chat-message bot';
    typingIndicator.innerHTML = '<i class="fas fa-ellipsis-h"></i> Typing...';
    messagesContainer.appendChild(typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  function hideTyping() {
    if (typingIndicator) {
      typingIndicator.remove();
      typingIndicator = null;
    }
  }

  async function sendMessage() {
    const msg = inputField.value.trim();
    if (!msg) return;
    addMessage(msg, true);
    inputField.value = '';
    inputField.style.height = 'auto';
    showTyping();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
      });
      const data = await response.json();
      hideTyping();
      if (data.reply) {
        addMessage(data.reply, false);
      } else {
        addMessage('Sorry, I could not process that request. Please try again later.', false);
      }
    } catch (err) {
      hideTyping();
      addMessage('Network error. Please check your connection.', false);
    }
  }

  toggleBtn.addEventListener('click', () => {
    chatWindow.style.display = 'flex';
    inputField.focus();
  });
  closeBtn.addEventListener('click', () => {
    chatWindow.style.display = 'none';
  });
  sendBtn.addEventListener('click', sendMessage);
  inputField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputField.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
})();
