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

  const MAX_OVERLAY_MSGS = 5;
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

  // Load chat history from server on room join
  function loadHistory(messages) {
    if (!messagesContainer || !messages?.length) return;
    messagesContainer.innerHTML = '';
    messages.forEach(msg => addMessage(msg, true));

    // Add separator
    const sep = document.createElement('div');
    sep.className = 'chat-msg-separator';
    sep.textContent = '— история чата —';
    messagesContainer.appendChild(sep);

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function addMessage(msg, isHistory) {
    const div = document.createElement('div');

    if (msg.type === 'poll') {
      div.className = 'chat-msg chat-msg-poll';
      const poll = msg.poll;
      const totalVotes = poll.options.reduce((s, o) => s + o.votes.length, 0);
      div.innerHTML = `
        <div class="poll-question">📊 ${escapeHtml(poll.question)}</div>
        <div class="poll-options">${poll.options.map((o, i) => {
          const pct = totalVotes ? Math.round(o.votes.length / totalVotes * 100) : 0;
          return `<button class="poll-option" data-poll-id="${poll.id}" data-index="${i}">
            <span class="poll-option-text">${escapeHtml(o.text)}</span>
            <span class="poll-option-bar" style="width:${pct}%"></span>
            <span class="poll-option-count">${o.votes.length} (${pct}%)</span>
          </button>`;
        }).join('')}</div>
        <div class="poll-meta">от ${escapeHtml(poll.createdBy)} · ${totalVotes} голосов</div>
      `;
      div.querySelectorAll('.poll-option').forEach(btn => {
        btn.addEventListener('click', () => {
          App.socket?.emit('vote-poll', { pollId: btn.dataset.pollId, optionIndex: parseInt(btn.dataset.index) });
        });
      });
      messagesContainer.appendChild(div);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      return;
    }

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

      // Show floating overlay only for live messages (not history)
      if (!isHistory) showChatOverlay(msg);
    }

    messagesContainer.appendChild(div);
    if (!isHistory) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    while (messagesContainer.children.length > 500) {
      messagesContainer.removeChild(messagesContainer.firstChild);
    }
  }

  function showChatOverlay(msg) {
    const overlay = document.getElementById('chat-overlay');
    if (!overlay) return;

    const el = document.createElement('div');
    el.className = 'chat-overlay-msg';
    el.innerHTML = `<span class="chat-overlay-name">${escapeHtml(msg.nickname)}</span> ${escapeHtml(msg.text)}`;
    overlay.appendChild(el);

    while (overlay.children.length > MAX_OVERLAY_MSGS) {
      overlay.removeChild(overlay.firstChild);
    }

    setTimeout(() => el.remove(), 5000);
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

  return { init, addMessage, loadHistory, showTyping, clear };
})();
