// ==================== WEBRTC CALL MODULE ====================

const Call = (() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  let localStream = null;
  let audioEnabled = false;
  let videoEnabled = false;
  const peers = new Map(); // peerId -> { pc: RTCPeerConnection, stream: MediaStream }

  function init(socket) {
    socket.on('call-offer', async ({ from, offer }) => {
      const pc = getOrCreatePeer(from, socket);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call-answer', { to: from, answer });
    });

    socket.on('call-answer', async ({ from, answer }) => {
      const peer = peers.get(from);
      if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
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

    // Buttons
    document.getElementById('mic-btn')?.addEventListener('click', () => toggleAudio(socket));
    document.getElementById('cam-btn')?.addEventListener('click', () => toggleVideo(socket));
  }

  function getOrCreatePeer(peerId, socket) {
    if (peers.has(peerId)) return peers.get(peerId).pc;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      const peer = peers.get(peerId);
      if (peer) peer.stream = e.streams[0];
      renderCallGrid();
    };

    // Add local tracks if we have them
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
      }
      if (!audio && !video) {
        localStream = null;
        return;
      }
      localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
      return true;
    } catch(e) {
      App.toast('Нет доступа к камере/микрофону', 'error');
      return false;
    }
  }

  async function toggleAudio(socket) {
    audioEnabled = !audioEnabled;
    const ok = await startMedia(audioEnabled, videoEnabled);
    if (ok === false && audioEnabled) { audioEnabled = false; return; }
    updateBtn('mic-btn', audioEnabled);
    broadcastMediaState(socket);
    reconnectAllPeers(socket);
  }

  async function toggleVideo(socket) {
    videoEnabled = !videoEnabled;
    const ok = await startMedia(audioEnabled, videoEnabled);
    if (ok === false && videoEnabled) { videoEnabled = false; return; }
    updateBtn('cam-btn', videoEnabled);
    broadcastMediaState(socket);
    reconnectAllPeers(socket);
    renderCallGrid();
  }

  function updateBtn(id, active) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', active);
  }

  function broadcastMediaState(socket) {
    socket.emit('media-state', { hasAudio: audioEnabled, hasVideo: videoEnabled });
  }

  async function reconnectAllPeers(socket) {
    // Re-add tracks to all existing peers and renegotiate
    for (const [peerId, peer] of peers) {
      const senders = peer.pc.getSenders();
      // Remove old tracks
      senders.forEach(s => { try { peer.pc.removeTrack(s); } catch(e) {} });
      // Add new tracks
      if (localStream) {
        localStream.getTracks().forEach(track => peer.pc.addTrack(track, localStream));
      }
      // Renegotiate
      try {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        socket.emit('call-offer', { to: peerId, offer });
      } catch(e) {}
    }
  }

  // Call a specific user (initiate connection)
  async function callUser(peerId, socket) {
    const pc = getOrCreatePeer(peerId, socket);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call-offer', { to: peerId, offer });
    } catch(e) {}
  }

  // Connect to all users in the room
  function connectToRoom(users, socket) {
    const myId = socket.id;
    users.forEach(u => {
      if (u.id !== myId && (audioEnabled || videoEnabled)) {
        callUser(u.id, socket);
      }
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

    // Remote videos
    for (const [peerId, peer] of peers) {
      if (peer.stream) {
        const hasVideo = peer.stream.getVideoTracks().length > 0;
        if (hasVideo || peer.stream.getAudioTracks().length > 0) {
          const el = createVideoEl('', peer.stream, false);
          grid.appendChild(el);
        }
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
    wrapper.appendChild(video);
    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'call-video-label';
      lbl.textContent = label;
      wrapper.appendChild(lbl);
    }
    return wrapper;
  }

  function destroy() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    for (const [, peer] of peers) {
      peer.pc.close();
    }
    peers.clear();
    audioEnabled = false;
    videoEnabled = false;
    updateBtn('mic-btn', false);
    updateBtn('cam-btn', false);
    renderCallGrid();
  }

  return { init, connectToRoom, destroy, renderCallGrid };
})();
