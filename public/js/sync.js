// ==================== SYNC MODULE ====================

const Sync = (() => {
  const SYNC_THRESHOLD = 2.0; // seconds of drift before correcting

  // ---- Any user: handle local player events and broadcast ----

  function onPlayerStateChange(event) {
    if (!App.socket) return;

    const type = Player.getType();
    if (type === 'iframe') return;

    if (type === 'youtube') {
      const state = event.data;
      const time = Player.getCurrentTime();
      if (state === 1) App.socket.emit('sync-play', { currentTime: time });
      else if (state === 2) App.socket.emit('sync-pause', { currentTime: time });
    } else if (type === 'html5') {
      const time = Player.getCurrentTime();
      if (event.data === 1) App.socket.emit('sync-play', { currentTime: time });
      else if (event.data === 2) App.socket.emit('sync-pause', { currentTime: time });
      else if (event.data === 'seeked') App.socket.emit('sync-seek', { currentTime: time });
    }
  }

  // ---- Apply sync commands from OTHER users ----

  function applyPlay(currentTime) {
    const drift = Math.abs(Player.getCurrentTime() - currentTime);
    if (drift > SYNC_THRESHOLD) Player.seekTo(currentTime);
    Player.play();
  }

  function applyPause(currentTime) {
    Player.pause();
    Player.seekTo(currentTime);
  }

  function applySeek(currentTime) {
    Player.seekTo(currentTime);
  }

  function applyRate(rate) {
    Player.setRate(rate);
  }

  function applyState(currentTime, playing) {
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

  return {
    onPlayerStateChange,
    applyPlay,
    applyPause,
    applySeek,
    applyRate,
    applyState
  };
})();
