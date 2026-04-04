// ==================== MAIN APP MODULE ====================

const App = (() => {
  let socket = null;
  let roomCode = null;
  let isHost = false;
  let myId = null;
  let users = [];
  let playlist = [];
  let currentIndex = -1;
  let selectedAvatar = '😎';
  let statusInterval = null;

  const AVATARS = ['😎', '🐱', '🐶', '🦊', '🐸', '🤖', '👻', '🎃', '🐼', '🦄', '🐉', '🦋', '🌸', '🍄', '🎮', '🚀'];

  // ==================== INIT ====================

  function init() {
    initAvatarPicker();
    initLobbyEvents();
    initRoomEvents();
    Chat.init();
    loadNickname();
    connectSocket();
    checkUrlRoomCode();
  }

  function checkUrlRoomCode() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('room');
    if (code && code.length === 6) {
      document.getElementById('room-code-input').value = code.toUpperCase();
      const waitForSocket = setInterval(() => {
        if (socket?.connected) {
          clearInterval(waitForSocket);
          joinRoom();
        }
      }, 200);
      setTimeout(() => clearInterval(waitForSocket), 10000);
    }
  }

  function connectSocket() {
    const status = document.getElementById('connection-status');
    socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 50 });

    socket.on('connect', () => {
      status.classList.remove('visible');
      myId = socket.id;

      // Auto-rejoin room after reconnect
      if (roomCode) {
        const nickname = localStorage.getItem('wt-nickname') || 'Аноним';
        const avatar = localStorage.getItem('wt-avatar') || '😎';
        socket.emit('join-room', { code: roomCode, nickname, avatar }, (res) => {
          if (res.success) {
            users = res.users;
            isHost = res.isHost;
            playlist = res.playlist || [];
            currentIndex = res.currentIndex ?? -1;
            renderUsers();
            renderPlaylist();
            if (res.messages?.length) Chat.loadHistory(res.messages);
            if (res.currentVideo) {
              Player.load(res.currentVideo, Sync.onPlayerStateChange);
              if (res.playbackState?.currentTime > 0) {
                setTimeout(() => Player.seekTo(res.playbackState.currentTime), 1000);
              }
            }
            Call.init(socket);
            toast('Переподключились!', 'success');
          } else {
            toast('Комната больше не существует', 'error');
            leaveRoom();
          }
        });
      }
    });

    socket.on('disconnect', () => {
      status.classList.add('visible');
    });

    // Room events
    socket.on('user-joined', ({ user, users: u }) => {
      users = u;
      renderUsers();
      // If we have audio/video active, connect to new user
      Call.connectToRoom([user], socket);
    });
    socket.on('user-left', ({ userId, users: u, newHostId }) => {
      users = u;
      if (newHostId === myId && !isHost) {
        isHost = true;
        toast('Вы теперь хост!', 'info');
      }
      renderUsers();
    });
    socket.on('host-changed', ({ newHostId, users: u }) => {
      users = u;
      isHost = newHostId === myId;
      renderUsers();
    });

    // Room deleted
    socket.on('room-deleted', ({ reason }) => {
      toast(reason || 'Комната удалена', 'error');
      leaveRoom();
    });

    // Chat events
    socket.on('chat-message', (msg) => Chat.addMessage(msg));
    socket.on('user-typing', ({ nickname }) => Chat.showTyping(nickname));

    // Playlist events
    socket.on('playlist-updated', ({ playlist: pl, currentIndex: ci }) => {
      playlist = pl;
      if (ci !== undefined) currentIndex = ci;
      renderPlaylist();
    });

    // Video events
    socket.on('video-changed', ({ video, index, playbackState }) => {
      currentIndex = index;
      renderPlaylist();
      if (video) {
        Player.load(video, Sync.onPlayerStateChange);
        if (playbackState?.playing) {
          setTimeout(() => {
            Player.seekTo(playbackState.currentTime);
            Player.play();
          }, 1500);
        }
      } else {
        Player.unload();
      }
    });

    // Sync events
    socket.on('sync-play', ({ currentTime }) => Sync.applyPlay(currentTime));
    socket.on('sync-pause', ({ currentTime }) => Sync.applyPause(currentTime));
    socket.on('sync-seek', ({ currentTime }) => Sync.applySeek(currentTime));
    socket.on('sync-rate', ({ rate }) => Sync.applyRate(rate));
    socket.on('sync-state', ({ currentTime, playing }) => Sync.applyState(currentTime, playing));

    // User status updates
    socket.on('room-status', ({ users: u }) => {
      users = u;
      renderUsers();
      renderChatUsersBar();
    });

    // Media state
    socket.on('user-media-state', ({ users: u }) => {
      users = u;
      renderUsers();
      renderChatUsersBar();
    });

    // Call peers list (response to request-call-peers)
    socket.on('call-peers', (peerIds) => {
      Call.handleCallPeers(peerIds);
    });

    // Reactions
    socket.on('reaction', ({ emoji, nickname }) => showFloatingReaction(emoji));
  }

  // ==================== LOBBY ====================

  function initAvatarPicker() {
    const container = document.getElementById('avatar-list');
    AVATARS.forEach(emoji => {
      const div = document.createElement('div');
      div.className = 'avatar-option' + (emoji === selectedAvatar ? ' selected' : '');
      div.textContent = emoji;
      div.addEventListener('click', () => {
        container.querySelectorAll('.avatar-option').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        selectedAvatar = emoji;
      });
      container.appendChild(div);
    });
  }

  function loadNickname() {
    const saved = localStorage.getItem('wt-nickname');
    if (saved) document.getElementById('nickname-input').value = saved;
    const savedAvatar = localStorage.getItem('wt-avatar');
    if (savedAvatar) {
      selectedAvatar = savedAvatar;
      document.querySelectorAll('.avatar-option').forEach(el => {
        el.classList.toggle('selected', el.textContent === savedAvatar);
      });
    }
  }

  function getNickname() {
    let name = document.getElementById('nickname-input').value.trim();
    if (!name) name = 'Аноним' + Math.floor(Math.random() * 999);
    localStorage.setItem('wt-nickname', name);
    localStorage.setItem('wt-avatar', selectedAvatar);
    return name;
  }

  function initLobbyEvents() {
    document.getElementById('create-room-btn').addEventListener('click', () => {
      const nickname = getNickname();
      socket.emit('create-room', { nickname, avatar: selectedAvatar }, (res) => {
        if (res.success) enterRoom(res);
        else toast(res.error || 'Ошибка создания комнаты', 'error');
      });
    });

    document.getElementById('join-room-btn').addEventListener('click', joinRoom);
    document.getElementById('room-code-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom();
    });
    document.getElementById('room-code-input').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
  }

  function joinRoom() {
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (code.length !== 6) return toast('Код комнаты — 6 символов', 'error');
    const nickname = getNickname();
    socket.emit('join-room', { code, nickname, avatar: selectedAvatar }, (res) => {
      if (res.success) enterRoom(res);
      else toast(res.error || 'Не удалось войти', 'error');
    });
  }

  // ==================== ROOM ====================

  function enterRoom(data) {
    roomCode = data.roomCode;
    isHost = data.isHost;
    users = data.users;
    playlist = data.playlist || [];
    currentIndex = data.currentIndex ?? -1;

    window.history.replaceState({}, '', `?room=${roomCode}`);

    document.getElementById('lobby').classList.remove('active');
    document.getElementById('room').classList.add('active');

    document.getElementById('room-code-display').textContent = roomCode;
    document.getElementById('share-code').textContent = roomCode;
    document.getElementById('copy-code-btn').onclick = () => {
      const shareUrl = `${window.location.origin}?room=${roomCode}`;
      navigator.clipboard?.writeText(`Заходи смотреть вместе!\n${shareUrl}`).then(() => toast('Ссылка скопирована!', 'success'));
    };

    renderUsers();
    renderPlaylist();

    // Load chat history
    if (data.messages?.length) Chat.loadHistory(data.messages);
    Chat.addMessage({ type: 'system', text: `Вы вошли в комнату ${roomCode}` });

    // Load current video
    if (data.currentVideo) {
      Player.load(data.currentVideo, Sync.onPlayerStateChange);
      if (data.playbackState) {
        setTimeout(() => {
          if (data.playbackState.currentTime > 0) Player.seekTo(data.playbackState.currentTime);
          if (data.playbackState.playing) Player.play();
        }, 1500);
      }
    }

    showMobilePanel('video');

    // Init WebRTC
    Call.init(socket);

    // Start sending user status every 3 seconds
    startStatusUpdates();

    toast(`Комната: ${roomCode}`, 'success');
  }

  let keepAliveInterval = null;

  function startStatusUpdates() {
    stopStatusUpdates();
    // User status every 3s
    statusInterval = setInterval(() => {
      if (!socket?.connected || !roomCode) return;
      const currentTime = Player.getCurrentTime() || 0;
      const playing = Player.isPlaying() || false;
      socket.emit('user-status', { currentTime, playing });
      socket.emit('request-status');
    }, 3000);
    // Keep-alive ping every 5 min to prevent Render sleep
    keepAliveInterval = setInterval(() => {
      fetch('/ping').catch(() => {});
    }, 5 * 60 * 1000);
  }

  function stopStatusUpdates() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  }

  function initRoomEvents() {
    document.getElementById('leave-btn').addEventListener('click', leaveRoom);

    document.getElementById('room-code-display').addEventListener('click', () => {
      const shareUrl = `${window.location.origin}?room=${roomCode}`;
      navigator.clipboard?.writeText(shareUrl).then(() => toast('Ссылка скопирована!', 'success'));
    });

    document.getElementById('add-video-btn').addEventListener('click', addVideo);
    document.getElementById('video-url-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addVideo();
    });

    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('reaction', { emoji: btn.dataset.emoji });
      });
    });

    document.querySelectorAll('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabName}`));
      });
    });

    document.getElementById('toggle-users-btn').addEventListener('click', () => switchSidebarTab('users'));
    document.getElementById('toggle-playlist-btn').addEventListener('click', () => switchSidebarTab('playlist'));

    document.getElementById('fullscreen-btn')?.addEventListener('click', toggleFullscreen);
    document.getElementById('pip-btn')?.addEventListener('click', togglePiP);

    // Delete room button
    document.getElementById('delete-room-btn')?.addEventListener('click', () => {
      if (confirm('Закрыть комнату для всех?')) {
        socket.emit('delete-room');
      }
    });

    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showMobilePanel(btn.dataset.panel));
    });
  }

  function toggleFullscreen() {
    const container = document.getElementById('video-container');
    if (document.fullscreenElement) document.exitFullscreen();
    else container.requestFullscreen().catch(() => {});
  }

  function togglePiP() {
    const html5 = document.getElementById('html5-player');
    if (html5 && html5.src) {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else html5.requestPictureInPicture().catch(() => {});
      return;
    }
    if ('documentPictureInPicture' in window) { openDocumentPiP(); return; }
    toast('PiP: правой кнопкой на видео -> Картинка в картинке', 'info');
  }

  async function openDocumentPiP() {
    try {
      const pipWindow = await documentPictureInPicture.requestWindow({ width: 480, height: 270 });
      const styles = document.querySelectorAll('link[rel="stylesheet"], style');
      styles.forEach(s => pipWindow.document.head.appendChild(s.cloneNode(true)));
      const style = pipWindow.document.createElement('style');
      style.textContent = 'body{margin:0;background:#000;overflow:hidden}.video-container{position:fixed;inset:0;border-radius:0}';
      pipWindow.document.head.appendChild(style);
      const playerWrapper = document.getElementById('player-wrapper');
      const chatOverlay = document.getElementById('chat-overlay');
      const reactionsOverlay = document.getElementById('reactions-overlay');
      const pipContainer = pipWindow.document.createElement('div');
      pipContainer.className = 'video-container';
      pipContainer.appendChild(playerWrapper);
      pipContainer.appendChild(chatOverlay);
      pipContainer.appendChild(reactionsOverlay);
      pipWindow.document.body.appendChild(pipContainer);
      pipWindow.addEventListener('pagehide', () => {
        const orig = document.getElementById('video-container');
        if (orig) {
          orig.insertBefore(reactionsOverlay, orig.querySelector('.video-overlay-btns'));
          orig.insertBefore(chatOverlay, reactionsOverlay);
          orig.insertBefore(playerWrapper, chatOverlay);
        }
      });
    } catch(e) { toast('PiP недоступен', 'info'); }
  }

  function switchSidebarTab(tabName) {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabName}`));
  }

  function showMobilePanel(panel) {
    const sidebar = document.getElementById('sidebar');
    const videoArea = document.querySelector('.video-area');
    document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
    if (panel === 'video') {
      sidebar.classList.remove('show');
      videoArea.classList.add('show');
    } else {
      videoArea.classList.remove('show');
      sidebar.classList.add('show');
      switchSidebarTab({ chat: 'chat', playlist: 'playlist', users: 'users' }[panel] || 'chat');
    }
  }

  function leaveRoom() {
    socket.emit('leave-room');
    Player.unload();
    Chat.clear();
    Call.destroy();
    stopStatusUpdates();
    roomCode = null;
    isHost = false;
    users = [];
    playlist = [];
    currentIndex = -1;
    window.history.replaceState({}, '', '/');
    document.getElementById('room').classList.remove('active');
    document.getElementById('lobby').classList.add('active');
  }

  // ==================== VIDEO ====================

  function addVideo() {
    const input = document.getElementById('video-url-input');
    const url = input.value.trim();
    if (!url) return;
    const parsed = Player.parseVideoUrl(url);
    if (!parsed) return toast('Не удалось распознать ссылку', 'error');
    socket.emit('add-video', { url: parsed.url, title: parsed.title, platform: parsed.platform }, (res) => {
      if (res?.success) input.value = '';
    });
  }

  // ==================== RENDER ====================

  function formatTime(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function renderChatUsersBar() {
    const bar = document.getElementById('chat-users-bar');
    if (!bar) return;
    const now = Date.now();
    bar.innerHTML = users.map(u => {
      const pingAge = now - (u.lastPing || 0);
      let dotClass = 'status-online';
      if (pingAge > 15000) dotClass = 'status-offline';
      else if (pingAge > 6000) dotClass = 'status-lagging';
      const playIcon = u.playing ? '▶' : '⏸';
      const time = formatTime(u.currentTime);
      const isMe = u.id === myId;
      return `<div class="chat-user-chip${isMe ? ' is-me' : ''}" title="${u.nickname}">
        <span class="status-dot ${dotClass}"></span>
        <span class="chip-avatar">${u.avatar || '👤'}</span>
        <span class="chip-name">${escapeHtml(u.nickname)}</span>
        <span class="chip-time">${playIcon}${time}</span>
      </div>`;
    }).join('');
  }

  function renderUsers() {
    const count = document.getElementById('users-count').querySelector('span');
    count.textContent = users.length;

    const container = document.getElementById('users-list');
    container.innerHTML = '';
    const now = Date.now();

    users.forEach(user => {
      const div = document.createElement('div');
      div.className = 'user-item';
      const isMe = user.id === myId;

      // Connection status
      const pingAge = now - (user.lastPing || 0);
      let statusClass = 'status-online';
      let statusText = 'онлайн';
      if (pingAge > 15000) { statusClass = 'status-offline'; statusText = 'оффлайн'; }
      else if (pingAge > 6000) { statusClass = 'status-lagging'; statusText = 'плохая связь'; }

      // Badges
      let badges = '';
      if (user.isHost) badges += '<span class="user-item-badge badge-host">хост</span> ';
      if (isMe) badges += '<span class="user-item-badge badge-you">вы</span> ';
      if (user.hasAudio) badges += '<span class="user-item-badge badge-mic">MIC</span> ';
      if (user.hasVideo) badges += '<span class="user-item-badge badge-cam">CAM</span> ';

      // Playback info
      const playbackIcon = user.playing ? '▶' : '⏸';
      const timeStr = formatTime(user.currentTime);

      let actions = '';
      if (isHost && !isMe) {
        actions = `<div class="user-item-actions">
          <button data-action="transfer-host" data-user-id="${user.id}">Передать хоста</button>
        </div>`;
      }

      div.innerHTML = `
        <div class="user-item-avatar">${user.avatar || '👤'}</div>
        <div class="user-item-info">
          <div class="user-item-name">${escapeHtml(user.nickname)} ${badges}</div>
          <div class="user-item-status">
            <span class="status-dot ${statusClass}"></span>
            <span class="status-text">${statusText}</span>
            <span class="playback-info">${playbackIcon} ${timeStr}</span>
          </div>
        </div>
        ${actions}
      `;
      container.appendChild(div);
    });

    // Delete room button (host only)
    if (isHost) {
      const deleteBtn = document.createElement('button');
      deleteBtn.id = 'delete-room-btn';
      deleteBtn.className = 'btn btn-sm';
      deleteBtn.style.cssText = 'margin: 12px 8px; width: calc(100% - 16px); background: rgba(240,108,142,0.15); color: var(--danger); border: 1px solid rgba(240,108,142,0.3);';
      deleteBtn.textContent = 'Закрыть комнату';
      deleteBtn.addEventListener('click', () => {
        if (confirm('Закрыть комнату для всех?')) socket.emit('delete-room');
      });
      container.appendChild(deleteBtn);
    }

    // Transfer host buttons
    container.querySelectorAll('[data-action="transfer-host"]').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('transfer-host', { userId: btn.dataset.userId }));
    });
  }

  function renderPlaylist() {
    const container = document.getElementById('playlist-items');
    if (playlist.length === 0) {
      container.innerHTML = '<div class="playlist-empty">Плейлист пуст</div>';
      return;
    }
    container.innerHTML = '';
    playlist.forEach((video, idx) => {
      const div = document.createElement('div');
      div.className = 'playlist-item' + (idx === currentIndex ? ' active' : '');
      const platformClass = `platform-${video.platform || 'direct'}`;
      div.innerHTML = `
        <div class="playlist-item-num">${idx + 1}</div>
        <div class="playlist-item-info">
          <div class="playlist-item-title">${escapeHtml(video.title)}</div>
          <div class="playlist-item-meta">
            <span class="playlist-item-platform ${platformClass}">${video.platform}</span>
            <span>${escapeHtml(video.addedBy || '')}</span>
          </div>
        </div>
        ${isHost ? `<button class="playlist-item-remove" data-id="${video.id}" title="Удалить">✕</button>` : ''}
      `;
      div.addEventListener('click', (e) => {
        if (e.target.closest('.playlist-item-remove')) return;
        socket.emit('play-video-at', { index: idx });
      });
      container.appendChild(div);
    });
    container.querySelectorAll('.playlist-item-remove').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('remove-video', { videoId: btn.dataset.id }));
    });
  }

  // ==================== REACTIONS ====================

  function showFloatingReaction(emoji) {
    const overlay = document.getElementById('reactions-overlay');
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    el.textContent = emoji;
    el.style.left = (10 + Math.random() * 80) + '%';
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ==================== UTILS ====================

  function toast(message, type = 'info') {
    const container = document.getElementById('toasts');
    const div = document.createElement('div');
    div.className = `toast toast-${type}`;
    div.textContent = message;
    container.appendChild(div);
    setTimeout(() => div.remove(), 3000);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ==================== START ====================
  document.addEventListener('DOMContentLoaded', init);

  return {
    get socket() { return socket; },
    get roomCode() { return roomCode; },
    get isHost() { return isHost; },
    toast
  };
})();
