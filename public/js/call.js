// ==================== WEBRTC CALL MODULE ====================

const Call = (() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ];

  let localStream = null;
  let audioEnabled = false;
  let videoEnabled = false;
  let _socket = null;
  const peers = new Map(); // peerId -> { pc: RTCPeerConnection, stream: MediaStream }

  function init(socket) {
    _socket = socket;

    socket.on('call-offer', async ({ from, offer }) => {
      // If peer exists with prior negotiation, reset it to avoid m-line conflicts
      if (peers.has(from)) {
        peers.get(from).pc.close();
        peers.delete(from);
      }
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
      if (peer) {
        try { await peer.pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch(e) {}
      }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const peer = peers.get(from);
      if (peer && candidate) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
      }
    });

    socket.on('user-left', ({ userId }) => {
      removePeer(userId);
    });

    // When another user enables their camera/mic/screen — always connect to receive their stream
    socket.on('user-media-state', ({ userId, hasAudio, hasVideo, hasScreen }) => {
      if (userId === socket.id) return;
      if ((hasAudio || hasVideo || hasScreen) && !peers.has(userId)) {
        callUser(userId);
      }
      if (!hasAudio && !hasVideo && !hasScreen) {
        removePeer(userId);
      }
    });

    // Buttons
    document.getElementById('mic-btn')?.addEventListener('click', () => toggleAudio());
    document.getElementById('cam-btn')?.addEventListener('click', () => toggleVideo());

    // On init, check if anyone already has media active
    socket.emit('request-call-peers');
  }

  function getOrCreatePeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId).pc;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) _socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      const peer = peers.get(peerId);
      if (!peer) return;
      // Create stream from individual tracks (more reliable than e.streams[0])
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
      renderCallGrid();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        removePeer(peerId);
      }
    };

    // Add local tracks (cam/mic only, screen share uses server relay)
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    peers.set(peerId, { pc, stream: null });
    return pc;
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
      peer.pc.close();
      peers.delete(peerId);
      renderCallGrid();
    }
  }

  async function startMedia(audio, video) {
    try {
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      if (!audio && !video) return true;
      localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
      return true;
    } catch(e) {
      App.toast('Нет доступа к камере/микрофону', 'error');
      return false;
    }
  }

  async function toggleAudio() {
    audioEnabled = !audioEnabled;
    const ok = await startMedia(audioEnabled, videoEnabled);
    if (!ok && audioEnabled) { audioEnabled = false; return; }
    updateBtn('mic-btn', audioEnabled);
    _socket.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled });
    await connectToAllUsers();
  }

  async function toggleVideo() {
    videoEnabled = !videoEnabled;
    const ok = await startMedia(audioEnabled, videoEnabled);
    if (!ok && videoEnabled) { videoEnabled = false; return; }
    updateBtn('cam-btn', videoEnabled);
    _socket.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled });
    await connectToAllUsers();
    renderCallGrid();
  }

  function updateBtn(id, active) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', active);
  }

  // Connect to all other users in the room
  async function connectToAllUsers() {
    if (!audioEnabled && !videoEnabled) {
      for (const [, peer] of peers) peer.pc.close();
      peers.clear();
      renderCallGrid();
      return;
    }

    // Close all existing peers and reconnect fresh with new tracks
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();

    // Request list of peers who have media active
    _socket.emit('request-call-peers');
  }

  // Called when we get the list of peers who have media active
  function handleCallPeers(peerIds) {
    // Always connect to peers with active media (to receive their stream)
    peerIds.forEach(id => {
      if (id !== _socket.id && !peers.has(id)) {
        callUser(id);
      }
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

  // Connect to specific users (called on user-joined)
  function connectToRoom(users) {
    if (!audioEnabled && !videoEnabled) return;
    users.forEach(u => {
      if (u.id !== _socket?.id) callUser(u.id);
    });
  }

  // Render video grid
  function renderCallGrid() {
    const grid = document.getElementById('call-grid');
    if (!grid) return;

    grid.innerHTML = '';

    // Local video
    if (localStream && videoEnabled) {
      const localEl = createVideoEl('Вы', localStream, true);
      grid.appendChild(localEl);
    }

    // Remote videos/audio
    for (const [peerId, peer] of peers) {
      if (peer.stream && peer.stream.getTracks().length > 0) {
        const el = createVideoEl('', peer.stream, false);
        grid.appendChild(el);
      }
    }

    grid.classList.toggle('has-streams', grid.children.length > 0);
  }

  function createVideoEl(label, stream, muted) {
    const wrapper = document.createElement('div');
    wrapper.className = 'call-video-item';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = muted;
    video.srcObject = stream;
    // Force play (autoplay can be blocked)
    video.play().catch(() => {
      // If blocked, try muted autoplay then unmute
      video.muted = true;
      video.play().catch(() => {});
    });
    wrapper.appendChild(video);
    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'call-video-label';
      lbl.textContent = label;
      wrapper.appendChild(lbl);
    }
    return wrapper;
  }

  // ---- Screen share (server relay, not WebRTC) ----
  let screenStream = null;
  let screenInterval = null;
  let screenCanvas = null;
  let screenCtx = null;

  async function startScreenShare() {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
      document.getElementById('screen-btn')?.classList.remove('active');
      _socket?.emit('screen-stop');
    };

    // Create hidden canvas for frame capture
    screenCanvas = document.createElement('canvas');
    screenCtx = screenCanvas.getContext('2d');
    const video = document.createElement('video');
    video.srcObject = screenStream;
    video.muted = true;
    video.play();

    // Wait for video to start
    await new Promise(r => video.onplaying = r);

    // Capture and send frames via Socket.IO
    _socket?.emit('screen-start');
    screenInterval = setInterval(() => {
      if (!screenStream || !screenStream.active) { stopScreenShare(); return; }
      screenCanvas.width = Math.min(video.videoWidth, 960);
      screenCanvas.height = Math.min(video.videoHeight, 960 * video.videoHeight / video.videoWidth);
      screenCtx.drawImage(video, 0, 0, screenCanvas.width, screenCanvas.height);
      const frame = screenCanvas.toDataURL('image/jpeg', 0.6);
      _socket?.emit('screen-frame', frame);
    }, 150); // ~7fps
  }

  function stopScreenShare() {
    if (screenInterval) { clearInterval(screenInterval); screenInterval = null; }
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    screenCanvas = null;
    screenCtx = null;
    _socket?.emit('screen-stop');
  }

  function destroy() {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();
    audioEnabled = false; videoEnabled = false;
    updateBtn('mic-btn', false);
    updateBtn('cam-btn', false);
    updateBtn('screen-btn', false);
    renderCallGrid();
  }

  return { init, connectToRoom, handleCallPeers, startScreenShare, stopScreenShare, destroy, renderCallGrid };
})();
