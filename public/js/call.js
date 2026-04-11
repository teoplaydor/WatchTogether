// ==================== WEBRTC CALL MODULE ====================
// WebRTC for cam/mic (same network), server relay for screen share (cross-network)

const Call = (() => {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let localStream = null;
  let screenStream = null;
  let audioEnabled = false;
  let videoEnabled = false;
  let _socket = null;
  let _initialized = false;
  const peers = new Map();

  // Screen share relay state
  let screenInterval = null;
  let screenSending = false;

  function init(socket, serverIceServers) {
    _socket = socket;
    if (serverIceServers) iceServers = serverIceServers;
    if (_initialized) return;
    _initialized = true;

    // WebRTC signaling (for cam/mic)
    socket.on('call-offer', async ({ from, offer }) => {
      if (peers.has(from)) { peers.get(from).pc.close(); peers.delete(from); }
      const pc = createPeer(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call-answer', { to: from, answer });
      } catch(e) {}
    });

    socket.on('call-answer', async ({ from, answer }) => {
      const peer = peers.get(from);
      if (peer) try { await peer.pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch(e) {}
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const peer = peers.get(from);
      if (peer && candidate) try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    });

    socket.on('user-left', ({ userId }) => removePeer(userId));

    socket.on('user-media-state', ({ userId, hasAudio, hasVideo, hasScreen }) => {
      if (userId === socket.id) return;
      // Connect for cam/mic via WebRTC
      if ((hasAudio || hasVideo) && !peers.has(userId)) callUser(userId);
      if (!hasAudio && !hasVideo) removePeer(userId);
    });

    // Screen share relay (server-relayed frames)
    socket.on('screen-started', ({ nickname }) => {
      App.toast(`${nickname} делится экраном`, 'info');
      showScreenView(true);
    });
    socket.on('screen-frame', (data) => {
      const img = document.getElementById('screen-share-img');
      if (img) {
        const blob = new Blob([data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const oldUrl = img._blobUrl;
        img._blobUrl = url;
        img.onload = () => { if (oldUrl) URL.revokeObjectURL(oldUrl); };
        img.src = url;
      }
    });
    socket.on('screen-stopped', () => {
      showScreenView(false);
    });

    socket.on('call-peers', (peerIds) => {
      peerIds.forEach(id => { if (id !== socket.id && !peers.has(id)) callUser(id); });
    });

    document.getElementById('mic-btn')?.addEventListener('click', () => toggleAudio());
    document.getElementById('cam-btn')?.addEventListener('click', () => toggleVideo());

    socket.emit('request-call-peers');
  }

  // ==================== Screen Share View ====================

  function showScreenView(show) {
    let container = document.getElementById('screen-share-container');
    if (show) {
      if (!container) {
        container = document.createElement('div');
        container.id = 'screen-share-container';
        container.className = 'screen-share-container';
        container.innerHTML = '<img id="screen-share-img" class="screen-share-img">';
        document.getElementById('video-container').appendChild(container);
      }
      container.style.display = 'flex';
    } else {
      if (container) container.style.display = 'none';
    }
  }

  // ==================== Screen Share (server relay) ====================

  async function startScreenShare() {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: { ideal: 1280 } },
      audio: false
    });
    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
      document.getElementById('screen-btn')?.classList.remove('active');
    };

    const video = document.createElement('video');
    video.srcObject = screenStream;
    video.muted = true;
    video.play();
    await new Promise(r => video.onplaying = r);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    _socket?.emit('screen-start');
    _socket?.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: true });
    screenSending = false;

    screenInterval = setInterval(() => {
      if (!screenStream?.active) { stopScreenShare(); return; }
      if (screenSending) return; // backpressure

      const maxW = 960;
      let w = video.videoWidth, h = video.videoHeight;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);

      canvas.toBlob(blob => {
        if (!blob || !_socket) return;
        screenSending = true;
        blob.arrayBuffer().then(buf => {
          _socket.volatile.emit('screen-frame', buf);
          screenSending = false;
        });
      }, 'image/jpeg', 0.55);
    }, 50); // ~20fps target, backpressure drops to what network can handle

    renderCallGrid();
  }

  function stopScreenShare() {
    if (screenInterval) { clearInterval(screenInterval); screenInterval = null; }
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    _socket?.emit('screen-stop');
    _socket?.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: false });
    renderCallGrid();
  }

  // ==================== WebRTC (cam/mic only) ====================

  function createPeer(peerId) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = e => { if (e.candidate) _socket.emit('ice-candidate', { to: peerId, candidate: e.candidate }); };
    pc.ontrack = e => {
      const peer = peers.get(peerId);
      if (!peer) return;
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
      renderCallGrid();
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') removePeer(peerId);
    };
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    peers.set(peerId, { pc, stream: null });
    return pc;
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) { peer.pc.close(); peers.delete(peerId); renderCallGrid(); }
  }

  async function callUser(peerId) {
    if (peers.has(peerId)) return;
    const pc = createPeer(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      _socket.emit('call-offer', { to: peerId, offer });
    } catch(e) {}
  }

  async function startMedia(audio, video) {
    try {
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      if (!audio && !video) return true;
      localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
      return true;
    } catch(e) { App.toast('Нет доступа к камере/микрофону', 'error'); return false; }
  }

  async function toggleAudio() {
    audioEnabled = !audioEnabled;
    if (!await startMedia(audioEnabled, videoEnabled) && audioEnabled) { audioEnabled = false; return; }
    updateBtn('mic-btn', audioEnabled);
    _socket.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: !!screenStream });
    reconnectPeers();
  }

  async function toggleVideo() {
    videoEnabled = !videoEnabled;
    if (!await startMedia(audioEnabled, videoEnabled) && videoEnabled) { videoEnabled = false; return; }
    updateBtn('cam-btn', videoEnabled);
    _socket.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: !!screenStream });
    reconnectPeers();
    renderCallGrid();
  }

  function reconnectPeers() {
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();
    setTimeout(() => _socket?.emit('request-call-peers'), 300);
  }

  function connectToRoom(users) {
    if (!audioEnabled && !videoEnabled) return;
    users.forEach(u => { if (u.id !== _socket?.id && !peers.has(u.id)) callUser(u.id); });
  }

  function updateBtn(id, active) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', active);
  }

  function renderCallGrid() {
    const grid = document.getElementById('call-grid');
    if (!grid) return;
    grid.innerHTML = '';
    if (localStream && videoEnabled) grid.appendChild(createVideoEl('Вы', localStream, true));
    for (const [, peer] of peers) {
      if (peer.stream && peer.stream.getTracks().length > 0) {
        grid.appendChild(createVideoEl('', peer.stream, false));
      }
    }
    grid.classList.toggle('has-streams', grid.children.length > 0);
  }

  function createVideoEl(label, stream, muted) {
    const w = document.createElement('div'); w.className = 'call-video-item';
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = muted;
    v.srcObject = stream;
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    w.appendChild(v);
    if (label) { const l = document.createElement('span'); l.className = 'call-video-label'; l.textContent = label; w.appendChild(l); }
    return w;
  }

  function destroy() {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    stopScreenShare();
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();
    audioEnabled = false; videoEnabled = false;
    updateBtn('mic-btn', false); updateBtn('cam-btn', false); updateBtn('screen-btn', false);
    renderCallGrid();
  }

  return { init, connectToRoom, startScreenShare, stopScreenShare, destroy, renderCallGrid };
})();
