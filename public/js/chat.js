// ==================== CHAT MODULE ====================

const Chat = (() => {
  const EMOJI_LIST = [
    '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤩',
    '😏', '🤔', '🤨', '😤', '😡', '🤯', '😱', '😭',
    '💀', '👻', '🤡', '😈', '👍', '👎', '👏', '🙌',
    '🔥', '❤️', '💔', '💯', '✨', '🎉', '🎊', '🎯',
    '🤝', '✌️', '🤙', '💪', '🫡', '🫠', '🥳', '🤗',
    '😴', '🥱', '🤮', '💩', '🐸', '🦊', '🐱', '🐶'
  ];

  let messagesContainer;
  let chatInput;
  let typingIndicator;
  let typingTimeout;
  let lastTypingSent = 0;

  function init() {
    messagesContainer = document.getElementById('chat-messages');
    chatInput = document.getElementById('chat-input');
    typingIndicator = document.getElementById('typing-indicator');

    initEmojiPicker();

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    chatInput.addEventListener('input', () => {
      const now = Date.now();
      if (now - lastTypingSent > 2000) {
        App.socket?.emit('typing');
        lastTypingSent = now;
      }
    });

    document.getElementById('send-btn').addEventListener('click', sendMessage);
  }

  function initEmojiPicker() {
    const grid = document.querySelector('.emoji-grid');
    const picker = document.getElementById('emoji-picker');
    const toggleBtn = document.getElementById('emoji-toggle-btn');

    EMOJI_LIST.forEach(emoji => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        chatInput.value += emoji;
        chatInput.focus();
      });
      grid.appendChild(btn);
    });

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      picker.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target) && e.target !== toggleBtn) {
        picker.classList.add('hidden');
      }
    });
  }

  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    App.socket?.emit('chat-message', { text });
    chatInput.value = '';
    chatInput.focus();
  }

  function addMessage(msg) {
    const div = document.createElement('div');

    if (msg.type === 'system') {
      div.className = 'chat-msg chat-msg-system';
      div.textContent = msg.text;
    } else {
      const isSelf = msg.userId === App.socket?.id;
      div.className = `chat-msg chat-msg-user${isSelf ? ' chat-msg-self' : ''}`;
      const time = new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      div.innerHTML = `
        <div class="msg-header">
          <span class="msg-avatar">${msg.avatar || '👤'}</span>
          <span class="msg-nickname">${escapeHtml(msg.nickname)}</span>
          <span class="msg-time">${time}</span>
        </div>
        <div class="msg-text">${escapeHtml(msg.text)}</div>
      `;
    }

    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Limit messages
    while (messagesContainer.children.length > 300) {
      messagesContainer.removeChild(messagesContainer.firstChild);
    }
  }

  function showTyping(nickname) {
    typingIndicator.textContent = `${nickname} печатает...`;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      typingIndicator.textContent = '';
    }, 3000);
  }

  function clear() {
    if (messagesContainer) messagesContainer.innerHTML = '';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return { init, addMessage, showTyping, clear };
})();
