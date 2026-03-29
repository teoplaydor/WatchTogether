// ==================== VIDEO PLAYER MODULE ====================

const Player = (() => {
  let currentType = null; // 'youtube', 'iframe', 'html5'
  let ytPlayer = null;
  let ytReady = false;
  let ytApiLoaded = false;
  let onReadyCallback = null;
  let suppressEvents = false;

  const elements = {
    wrapper: () => document.getElementById('player-wrapper'),
    placeholder: () => document.getElementById('video-placeholder'),
    ytPlayer: () => document.getElementById('youtube-player'),
    iframePlayer: () => document.getElementById('iframe-player'),
    html5Player: () => document.getElementById('html5-player'),
  };

  // ---- URL Parsing ----

  function parseVideoUrl(url) {
    url = url.trim();

    // YouTube
    let match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (match) return { platform: 'youtube', id: match[1], title: `YouTube: ${match[1]}`, url };

    // VK Video
    match = url.match(/vk\.com\/video(-?\d+_\d+)/);
    if (match) return { platform: 'vk', id: match[1], title: `VK Video: ${match[1]}`, url };

    match = url.match(/vk\.com\/.*[?&]z=video(-?\d+_\d+)/);
    if (match) return { platform: 'vk', id: match[1], title: `VK Video: ${match[1]}`, url };

    // VK clip
    match = url.match(/vk\.com\/clip(-?\d+_\d+)/);
    if (match) return { platform: 'vk', id: match[1], title: `VK Clip: ${match[1]}`, url };

    // Rutube
    match = url.match(/rutube\.ru\/video\/([a-f0-9]+)/);
    if (match) return { platform: 'rutube', id: match[1], title: `Rutube: ${match[1].slice(0, 8)}...`, url };

    // Direct video URL
    if (/\.(mp4|webm|m3u8|ogg)(\?|$)/i.test(url)) {
      return { platform: 'direct', id: url, title: decodeURIComponent(url.split('/').pop().split('?')[0]), url };
    }

    // Try as generic embed
    if (url.startsWith('http')) {
      return { platform: 'embed', id: url, title: url.split('/').slice(2, 3).join(''), url };
    }

    return null;
  }

  // ---- YouTube API ----

  function loadYouTubeAPI() {
    if (ytApiLoaded) return;
    ytApiLoaded = true;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  window.onYouTubeIframeAPIReady = () => {
    ytReady = true;
    if (onReadyCallback) { onReadyCallback(); onReadyCallback = null; }
  };

  function initYouTubePlayer(videoId, onStateChange) {
    const container = elements.ytPlayer();
    if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }

    ytPlayer = new YT.Player(container.id, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        fs: 1,
        playsinline: 1
      },
      events: {
        onStateChange: (e) => {
          if (!suppressEvents && onStateChange) onStateChange(e);
        },
        onReady: () => {
          document.getElementById('youtube-player').style.display = 'block';
        }
      }
    });
  }

  // ---- Load Video ----

  function load(video, onStateChange) {
    const wrapper = elements.wrapper();
    const placeholder = elements.placeholder();
    const iframeEl = elements.iframePlayer();
    const html5El = elements.html5Player();

    // Reset
    wrapper.classList.remove('hidden');
    placeholder.style.display = 'none';
    iframeEl.style.display = 'none';
    html5El.style.display = 'none';
    const ytEl = document.getElementById('youtube-player');
    if (ytEl) ytEl.style.display = 'none';
    if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }

    // Re-create YT container if destroyed
    if (!document.getElementById('youtube-player')) {
      const div = document.createElement('div');
      div.id = 'youtube-player';
      wrapper.insertBefore(div, wrapper.firstChild);
    }

    const parsed = parseVideoUrl(video.url);
    if (!parsed) return;

    currentType = parsed.platform;

    switch (parsed.platform) {
      case 'youtube':
        if (!ytReady) {
          loadYouTubeAPI();
          onReadyCallback = () => initYouTubePlayer(parsed.id, onStateChange);
        } else {
          initYouTubePlayer(parsed.id, onStateChange);
        }
        break;

      case 'vk':
        const vkId = parsed.id.replace('-', '-');
        const [oid, vid] = vkId.split('_');
        iframeEl.src = `https://vk.com/video_ext.php?oid=${oid}&id=${vid}&hd=2`;
        iframeEl.style.display = 'block';
        currentType = 'iframe';
        break;

      case 'rutube':
        iframeEl.src = `https://rutube.ru/play/embed/${parsed.id}`;
        iframeEl.style.display = 'block';
        currentType = 'iframe';
        break;

      case 'direct':
        html5El.src = video.url;
        html5El.style.display = 'block';
        currentType = 'html5';
        setupHtml5Events(html5El, onStateChange);
        break;

      case 'embed':
        iframeEl.src = video.url;
        iframeEl.style.display = 'block';
        currentType = 'iframe';
        break;
    }
  }

  function setupHtml5Events(el, onStateChange) {
    if (!onStateChange) return;
    el.onplay = () => { if (!suppressEvents) onStateChange({ data: 1 }); };
    el.onpause = () => { if (!suppressEvents) onStateChange({ data: 2 }); };
    el.onseeked = () => { if (!suppressEvents) onStateChange({ data: 'seeked' }); };
  }

  // ---- Controls ----

  function play() {
    suppressEvents = true;
    if (currentType === 'youtube' && ytPlayer?.playVideo) ytPlayer.playVideo();
    else if (currentType === 'html5') elements.html5Player().play().catch(() => {});
    setTimeout(() => { suppressEvents = false; }, 300);
  }

  function pause() {
    suppressEvents = true;
    if (currentType === 'youtube' && ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
    else if (currentType === 'html5') elements.html5Player().pause();
    setTimeout(() => { suppressEvents = false; }, 300);
  }

  function seekTo(time) {
    suppressEvents = true;
    if (currentType === 'youtube' && ytPlayer?.seekTo) ytPlayer.seekTo(time, true);
    else if (currentType === 'html5') elements.html5Player().currentTime = time;
    setTimeout(() => { suppressEvents = false; }, 500);
  }

  function getCurrentTime() {
    if (currentType === 'youtube' && ytPlayer?.getCurrentTime) return ytPlayer.getCurrentTime();
    if (currentType === 'html5') return elements.html5Player().currentTime;
    return 0;
  }

  function isPlaying() {
    if (currentType === 'youtube' && ytPlayer?.getPlayerState) return ytPlayer.getPlayerState() === 1;
    if (currentType === 'html5') return !elements.html5Player().paused;
    return false;
  }

  function setRate(rate) {
    if (currentType === 'youtube' && ytPlayer?.setPlaybackRate) ytPlayer.setPlaybackRate(rate);
    else if (currentType === 'html5') elements.html5Player().playbackRate = rate;
  }

  function unload() {
    if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
    const iframeEl = elements.iframePlayer();
    const html5El = elements.html5Player();
    iframeEl.src = '';
    iframeEl.style.display = 'none';
    html5El.src = '';
    html5El.style.display = 'none';
    const ytEl = document.getElementById('youtube-player');
    if (ytEl) ytEl.style.display = 'none';
    elements.wrapper().classList.add('hidden');
    elements.placeholder().style.display = '';
    currentType = null;
  }

  return {
    parseVideoUrl,
    load,
    play,
    pause,
    seekTo,
    getCurrentTime,
    isPlaying,
    setRate,
    unload,
    getType: () => currentType,
    loadYouTubeAPI
  };
})();
