// ==================== WEBRTC CALL MODULE ====================

const Call = (() => {
  // ICE servers are provided by the server (includes TURN with HMAC credentials)
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  let localStream = null;
  let screenStream = null;
  let audioEnabled = false;
  let videoEnabled = false;
  let _socket = null;
  const peers = new Map(); // peerId -> { pc, stream }

  function init(socket, serverIceServers) {
    _socket = socket;
    if (serverIceServers) iceServers = serverIceServers;

    socket.on('call-offer', async ({ from, offer }) => {
      // Reset existing peer to avoid m-line conflicts
      if (peers.has(from)) { peers.get(from).pc.close(); peers.delete(from); }
      const pc = getOrCreatePeer(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call-answer', { to: from, answer });
      } catch(e) { console.warn('call-offer error', e); }
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

    // When another user enables media — connect to receive
    socket.on('user-media-state', ({ userId, hasAudio, hasVideo, hasScreen }) => {
      if (userId === socket.id) return;
      if ((hasAudio || hasVideo || hasScreen) && !peers.has(userId)) {
        callUser(userId);
      }
      if (!hasAudio && !hasVideo && !hasScreen) {
        removePeer(userId);
      }
    });

    // Screen share events
    socket.on('screen-started', ({ nickname }) => {
      App.toast(`${nickname} делится экраном`, 'info');
    });
    socket.on('screen-stopped', ({ userId }) => {
      removePeer(userId);
      renderCallGrid();
    });

    document.getElementById('mic-btn')?.addEventListener('click', () => toggleAudio());
    document.getElementById('cam-btn')?.addEventListener('click', () => toggleVideo());

    // Request peers on init
    socket.emit('request-call-peers');
  }

  function getOrCreatePeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId).pc;

    const pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (e) => {
      if (e.candidate) _socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      const peer = peers.get(peerId);
      if (!peer) return;
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
      renderCallGrid();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') removePeer(peerId);
    };

    // Add all local tracks
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    if (screenStream) screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));

    peers.set(peerId, { pc, stream: null });
    return pc;
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) { peer.pc.close(); peers.delete(peerId); renderCallGrid(); }
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
    const ok = await startMedia(audioEnabled, videoEnabled);
    if (!ok && audioEnabled) { audioEnabled = false; return; }
    updateBtn('mic-btn', audioEnabled);
    _socket.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: !!screenStream });
    await reconnectPeers();
  }

  async function toggleVideo() {
    videoEnabled = !videoEnabled;
    const ok = await startMedia(audioEnabled, videoEnabled);
    if (!ok && videoEnabled) { videoEnabled = false; return; }
    updateBtn('cam-btn', videoEnabled);
    _socket.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: !!screenStream });
    await reconnectPeers();
    renderCallGrid();
  }

  // ---- Screen share via WebRTC (60fps native) ----
  async function startScreenShare() {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true
    });
    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
      document.getElementById('screen-btn')?.classList.remove('active');
    };
    _socket?.emit('screen-start');
    _socket?.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: true });
    await reconnectPeers();
    renderCallGrid();
  }

  function stopScreenShare() {
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    _socket?.emit('screen-stop');
    _socket?.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: false });
    reconnectPeers();
    renderCallGrid();
  }

  // Close all peers and reconnect with current tracks
  async function reconnectPeers() {
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();
    _socket?.emit('request-call-peers');
  }

  function handleCallPeers(peerIds) {
    peerIds.forEach(id => {
      if (id !== _socket?.id && !peers.has(id)) callUser(id);
    });
  }

  async function callUser(peerId) {
    const pc = getOrCreatePeer(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      _socket.emit('call-offer', { to: peerId, offer });
    } catch(e) { console.warn('callUser error', e); }
  }

  function connectToRoom(users) {
    if (!audioEnabled && !videoEnabled && !screenStream) return;
    users.forEach(u => { if (u.id !== _socket?.id) callUser(u.id); });
  }

  function updateBtn(id, active) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', active);
  }

  // Render video grid
  function renderCallGrid() {
    const grid = document.getElementById('call-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Local camera
    if (localStream && videoEnabled) {
      grid.appendChild(createVideoEl('Вы', localStream, true));
    }
    // Local screen (preview)
    if (screenStream) {
      grid.appendChild(createVideoEl('Ваш экран', screenStream, true));
    }
    // Remote streams
    for (const [, peer] of peers) {
      if (peer.stream && peer.stream.getTracks().length > 0) {
        grid.appendChild(createVideoEl('', peer.stream, false));
      }
    }
    grid.classList.toggle('has-streams', grid.children.length > 0);
  }

  function createVideoEl(label, stream, muted) {
    const wrapper = document.createElement('div');
    wrapper.className = 'call-video-item';
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = muted;
    video.srcObject = stream;
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    wrapper.appendChild(video);
    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'call-video-label'; lbl.textContent = label;
      wrapper.appendChild(lbl);
    }
    return wrapper;
  }

  function destroy() {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();
    audioEnabled = false; videoEnabled = false;
    updateBtn('mic-btn', false); updateBtn('cam-btn', false); updateBtn('screen-btn', false);
    renderCallGrid();
  }

  return { init, connectToRoom, handleCallPeers, startScreenShare, stopScreenShare, destroy, renderCallGrid };
})();
