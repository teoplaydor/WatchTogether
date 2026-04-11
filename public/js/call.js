// ==================== WEBRTC CALL MODULE ====================

const Call = (() => {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let localStream = null;
  let screenStream = null;
  let audioEnabled = false;
  let videoEnabled = false;
  let _socket = null;
  let _initialized = false;
  const peers = new Map();

  function init(socket, serverIceServers) {
    _socket = socket;
    if (serverIceServers) iceServers = serverIceServers;

    // Prevent duplicate listeners on reconnect
    if (_initialized) return;
    _initialized = true;

    socket.on('call-offer', async ({ from, offer }) => {
      console.log('[CALL] Got offer from', from);
      // Always reset peer on incoming offer to avoid m-line conflicts
      if (peers.has(from)) { peers.get(from).pc.close(); peers.delete(from); }
      const pc = createPeer(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call-answer', { to: from, answer });
        console.log('[CALL] Sent answer to', from);
      } catch(e) { console.error('[CALL] offer error', e); }
    });

    socket.on('call-answer', async ({ from, answer }) => {
      const peer = peers.get(from);
      if (peer) {
        try { await peer.pc.setRemoteDescription(new RTCSessionDescription(answer)); }
        catch(e) { console.error('[CALL] answer error', e); }
      }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const peer = peers.get(from);
      if (peer && candidate) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
      }
    });

    socket.on('user-left', ({ userId }) => removePeer(userId));

    socket.on('user-media-state', ({ userId, hasAudio, hasVideo, hasScreen }) => {
      if (userId === socket.id) return;
      if ((hasAudio || hasVideo || hasScreen) && !peers.has(userId)) {
        callUser(userId);
      }
      if (!hasAudio && !hasVideo && !hasScreen) {
        removePeer(userId);
      }
    });

    socket.on('screen-started', ({ nickname }) => {
      App.toast(`${nickname} делится экраном`, 'info');
    });
    socket.on('screen-stopped', ({ userId }) => {
      removePeer(userId);
      renderCallGrid();
    });

    socket.on('call-peers', (peerIds) => {
      console.log('[CALL] Got peers list:', peerIds.length);
      peerIds.forEach(id => {
        if (id !== socket.id && !peers.has(id)) callUser(id);
      });
    });

    document.getElementById('mic-btn')?.addEventListener('click', () => toggleAudio());
    document.getElementById('cam-btn')?.addEventListener('click', () => toggleVideo());

    // Check for existing media peers
    socket.emit('request-call-peers');
  }

  function createPeer(peerId) {
    const pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (e) => {
      if (e.candidate) _socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      console.log('[CALL] Got track from', peerId, e.track.kind);
      const peer = peers.get(peerId);
      if (!peer) return;
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
      renderCallGrid();
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[CALL] ICE:', peerId.slice(-4), pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.log('[CALL] Connection failed, retrying...');
        removePeer(peerId);
        setTimeout(() => callUser(peerId), 2000);
      }
    };

    // Add all our active tracks
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    if (screenStream) screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));

    peers.set(peerId, { pc, stream: null });
    return pc;
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) { peer.pc.close(); peers.delete(peerId); renderCallGrid(); }
  }

  async function callUser(peerId) {
    // If peer already exists with a connection, don't duplicate
    if (peers.has(peerId)) return;
    console.log('[CALL] Calling', peerId.slice(-4));
    const pc = createPeer(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      _socket.emit('call-offer', { to: peerId, offer });
    } catch(e) { console.error('[CALL] callUser error', e); }
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
    reconnectPeers();
    renderCallGrid();
  }

  function stopScreenShare() {
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    _socket?.emit('screen-stop');
    _socket?.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled, hasScreen: false });
    reconnectPeers();
    renderCallGrid();
  }

  function reconnectPeers() {
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();
    _socket?.emit('request-call-peers');
  }

  function connectToRoom(users) {
    if (!audioEnabled && !videoEnabled && !screenStream) return;
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
    if (screenStream) grid.appendChild(createVideoEl('Ваш экран', screenStream, true));
    for (const [, peer] of peers) {
      if (peer.stream && peer.stream.getTracks().length > 0) {
        grid.appendChild(createVideoEl('', peer.stream, false));
      }
    }
    grid.classList.toggle('has-streams', grid.children.length > 0);
  }

  function createVideoEl(label, stream, muted) {
    const w = document.createElement('div');
    w.className = 'call-video-item';
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = muted;
    v.srcObject = stream;
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    w.appendChild(v);
    if (label) {
      const l = document.createElement('span');
      l.className = 'call-video-label'; l.textContent = label;
      w.appendChild(l);
    }
    return w;
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

  return { init, connectToRoom, startScreenShare, stopScreenShare, destroy, renderCallGrid };
})();
