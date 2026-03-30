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
      // Always auto-join when URL has room code (use saved or generate nickname)
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
    });

    socket.on('disconnect', () => {
      status.classList.add('visible');
    });

    socket.on('reconnect', () => {
      status.classList.remove('visible');
      if (roomCode) {
        toast('Переподключение...', 'info');
      }
    });

    // Room events
    socket.on('user-joined', ({ user, users: u }) => { users = u; renderUsers(); });
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
        if (res.success) {
          enterRoom(res);
        } else {
          toast(res.error || 'Ошибка создания комнаты', 'error');
        }
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
      if (res.success) {
        enterRoom(res);
      } else {
        toast(res.error || 'Не удалось войти', 'error');
      }
    });
  }

  // ==================== ROOM ====================

  function enterRoom(data) {
    roomCode = data.roomCode;
    isHost = data.isHost;
    users = data.users;
    playlist = data.playlist || [];
    currentIndex = data.currentIndex ?? -1;

    // Update URL with room code
    window.history.replaceState({}, '', `?room=${roomCode}`);

    // Switch screen
    document.getElementById('lobby').classList.remove('active');
    document.getElementById('room').classList.add('active');

    // Show room code
    document.getElementById('room-code-display').textContent = roomCode;

    // Share box
    document.getElementById('share-code').textContent = roomCode;
    document.getElementById('copy-code-btn').onclick = () => {
      const shareUrl = `${window.location.origin}?room=${roomCode}`;
      const shareText = `Заходи смотреть вместе!\n${shareUrl}`;
      navigator.clipboard?.writeText(shareText).then(() => toast('Ссылка скопирована!', 'success'));
    };

    // Render
    renderUsers();
    renderPlaylist();

    // Load current video if any
    if (data.currentVideo) {
      Player.load(data.currentVideo, Sync.onPlayerStateChange);
      if (data.playbackState) {
        setTimeout(() => {
          if (data.playbackState.currentTime > 0) Player.seekTo(data.playbackState.currentTime);
          if (data.playbackState.playing) Player.play();
        }, 1500);
      }
    }

    // Show video area on mobile by default
    showMobilePanel('video');

    Chat.addMessage({ type: 'system', text: `Вы вошли в комнату ${roomCode}` });
    toast(`Комната: ${roomCode}`, 'success');
  }

  function initRoomEvents() {
    // Leave
    document.getElementById('leave-btn').addEventListener('click', leaveRoom);

    // Copy room code
    document.getElementById('room-code-display').addEventListener('click', () => {
      const shareUrl = `${window.location.origin}?room=${roomCode}`;
      navigator.clipboard?.writeText(shareUrl).then(() => toast('Ссылка скопирована!', 'success'));
    });

    // Add video
    document.getElementById('add-video-btn').addEventListener('click', addVideo);
    document.getElementById('video-url-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addVideo();
    });

    // Reactions
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('reaction', { emoji: btn.dataset.emoji });
      });
    });

    // Sidebar tabs
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabName}`));
      });
    });

    // Header buttons
    document.getElementById('toggle-users-btn').addEventListener('click', () => {
      switchSidebarTab('users');
    });
    document.getElementById('toggle-playlist-btn').addEventListener('click', () => {
      switchSidebarTab('playlist');
    });

    // Fullscreen & PiP
    document.getElementById('fullscreen-btn')?.addEventListener('click', toggleFullscreen);
    document.getElementById('pip-btn')?.addEventListener('click', togglePiP);

    // Mobile nav
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showMobilePanel(btn.dataset.panel);
      });
    });
  }

  function toggleFullscreen() {
    const container = document.getElementById('video-container');
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {});
    }
  }

  function togglePiP() {
    // Try HTML5 video PiP first
    const html5 = document.getElementById('html5-player');
    if (html5 && html5.src && !html5.paused !== undefined) {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      } else {
        html5.requestPictureInPicture().catch(() => {});
      }
      return;
    }

    // For YouTube iframe — use Document PiP API (Chrome 116+)
    if ('documentPictureInPicture' in window) {
      openDocumentPiP();
      return;
    }

    // Fallback: try to grab video from YouTube iframe
    try {
      const iframe = document.getElementById('youtube-player');
      if (iframe?.tagName === 'IFRAME') {
        // Can't access cross-origin iframe video, use Document PiP
        toast('PiP: нажми правой кнопкой на видео → Картинка в картинке', 'info');
      }
    } catch(e) {}
  }

  async function openDocumentPiP() {
    try {
      const container = document.getElementById('video-container');
      const pipWindow = await documentPictureInPicture.requestWindow({
        width: 480,
        height: 270
      });

      // Copy styles
      const styles = document.querySelectorAll('link[rel="stylesheet"], style');
      styles.forEach(s => pipWindow.document.head.appendChild(s.cloneNode(true)));

      // Add base styles for PiP window
      const style = pipWindow.document.createElement('style');
      style.textContent = 'body { margin: 0; background: #000; overflow: hidden; } .video-container { position: fixed; inset: 0; border-radius: 0; }';
      pipWindow.document.head.appendChild(style);

      // Move video container to PiP
      const playerWrapper = document.getElementById('player-wrapper');
      const chatOverlay = document.getElementById('chat-overlay');
      const reactionsOverlay = document.getElementById('reactions-overlay');

      const pipContainer = pipWindow.document.createElement('div');
      pipContainer.className = 'video-container';
      pipContainer.id = 'video-container';
      pipContainer.appendChild(playerWrapper);
      pipContainer.appendChild(chatOverlay);
      pipContainer.appendChild(reactionsOverlay);
      pipWindow.document.body.appendChild(pipContainer);

      // On PiP close — move elements back
      pipWindow.addEventListener('pagehide', () => {
        const origContainer = document.getElementById('video-container');
        if (origContainer) {
          origContainer.insertBefore(reactionsOverlay, origContainer.querySelector('.video-overlay-btns'));
          origContainer.insertBefore(chatOverlay, reactionsOverlay);
          origContainer.insertBefore(playerWrapper, chatOverlay);
        }
      });
    } catch(e) {
      toast('PiP недоступен в этом браузере', 'info');
    }
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
      const tabMap = { chat: 'chat', playlist: 'playlist', users: 'users' };
      switchSidebarTab(tabMap[panel] || 'chat');
    }
  }

  function leaveRoom() {
    socket.emit('leave-room');
    Player.unload();
    Chat.clear();
    roomCode = null;
    isHost = false;
    users = [];
    playlist = [];
    currentIndex = -1;

    // Clear URL
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

    socket.emit('add-video', {
      url: parsed.url,
      title: parsed.title,
      platform: parsed.platform
    }, (res) => {
      if (res?.success) input.value = '';
    });
  }

  // ==================== RENDER ====================

  function renderUsers() {
    const count = document.getElementById('users-count').querySelector('span');
    count.textContent = users.length;

    const container = document.getElementById('users-list');
    container.innerHTML = '';
    users.forEach(user => {
      const div = document.createElement('div');
      div.className = 'user-item';
      const isMe = user.id === myId;
      let badges = '';
      if (user.isHost) badges += '<span class="user-item-badge badge-host">хост</span> ';
      if (isMe) badges += '<span class="user-item-badge badge-you">вы</span>';

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
        </div>
        ${actions}
      `;
      container.appendChild(div);
    });

    container.querySelectorAll('[data-action="transfer-host"]').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('transfer-host', { userId: btn.dataset.userId });
      });
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
      btn.addEventListener('click', () => {
        socket.emit('remove-video', { videoId: btn.dataset.id });
      });
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
