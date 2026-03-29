// ==================== SYNC MODULE ====================

const Sync = (() => {
  let isHost = false;
  let syncInterval = null;
  const SYNC_THRESHOLD = 2.0; // seconds of drift before correcting

  function setHost(host) {
    isHost = host;
    if (host) startSyncBroadcast();
    else stopSyncBroadcast();
  }

  // ---- Host: broadcast state periodically ----

  function startSyncBroadcast() {
    stopSyncBroadcast();
    syncInterval = setInterval(() => {
      if (!App.socket || Player.getType() === 'iframe') return;
      const currentTime = Player.getCurrentTime();
      const playing = Player.isPlaying();
      App.socket.emit('sync-state', { currentTime, playing });
    }, 2000);
  }

  function stopSyncBroadcast() {
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  }

  // ---- Host: handle local player events ----

  function onPlayerStateChange(event) {
    if (!isHost || !App.socket) return;

    const type = Player.getType();
    if (type === 'iframe') return; // Can't sync iframes precisely

    if (type === 'youtube') {
      const state = event.data;
      const time = Player.getCurrentTime();
      if (state === 1) { // playing
        App.socket.emit('sync-play', { currentTime: time });
      } else if (state === 2) { // paused
        App.socket.emit('sync-pause', { currentTime: time });
      }
    } else if (type === 'html5') {
      const time = Player.getCurrentTime();
      if (event.data === 1) App.socket.emit('sync-play', { currentTime: time });
      else if (event.data === 2) App.socket.emit('sync-pause', { currentTime: time });
      else if (event.data === 'seeked') App.socket.emit('sync-seek', { currentTime: time });
    }
  }

  // ---- Guest: apply sync commands ----

  function applyPlay(currentTime) {
    if (isHost) return;
    const drift = Math.abs(Player.getCurrentTime() - currentTime);
    if (drift > SYNC_THRESHOLD) Player.seekTo(currentTime);
    Player.play();
  }

  function applyPause(currentTime) {
    if (isHost) return;
    Player.pause();
    Player.seekTo(currentTime);
  }

  function applySeek(currentTime) {
    if (isHost) return;
    Player.seekTo(currentTime);
  }

  function applyRate(rate) {
    if (isHost) return;
    Player.setRate(rate);
  }

  function applyState(currentTime, playing) {
    if (isHost) return;
    const type = Player.getType();
    if (type === 'iframe') return;

    const localTime = Player.getCurrentTime();
    const drift = Math.abs(localTime - currentTime);

    if (drift > SYNC_THRESHOLD) {
      Player.seekTo(currentTime);
    }

    const localPlaying = Player.isPlaying();
    if (playing && !localPlaying) Player.play();
    else if (!playing && localPlaying) Player.pause();
  }

  function destroy() {
    stopSyncBroadcast();
    isHost = false;
  }

  return {
    setHost,
    onPlayerStateChange,
    applyPlay,
    applyPause,
    applySeek,
    applyRate,
    applyState,
    destroy,
    isHost: () => isHost
  };
})();
