const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

// Generate TURN credentials using static auth (HMAC-SHA1)
const TURN_SECRET = 'openrelayprojectsecret';
function getTurnCredentials() {
  const unixTime = Math.floor(Date.now() / 1000) + 86400; // 24h validity
  const username = `${unixTime}:watchtogether`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.write(username);
  hmac.end();
  const password = hmac.read().toString('base64');
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:staticauth.openrelay.metered.ca:80', username, credential: password },
      { urls: 'turn:staticauth.openrelay.metered.ca:443', username, credential: password },
      { urls: 'turn:staticauth.openrelay.metered.ca:443?transport=tcp', username, credential: password },
    ]
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 30000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/ping', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));

// ==================== ROOMS ====================

const ROOM_MAX_AGE = 24 * 60 * 60 * 1000;
const EMPTY_ROOM_TTL = 60 * 60 * 1000;
const MAX_CHAT_HISTORY = 500;
const MAX_WATCH_HISTORY = 50;

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function createRoom(hostSocket, nickname, avatar, password) {
  const code = generateRoomCode();
  const room = {
    code,
    password: password || null,
    hostId: hostSocket.id,
    users: new Map(),
    kicked: new Set(),
    playlist: [],
    currentIndex: -1,
    playbackState: { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 },
    messages: [],
    watchHistory: [],
    polls: new Map(),
    createdAt: Date.now(),
    emptyAt: null
  };
  room.users.set(hostSocket.id, {
    id: hostSocket.id, nickname, avatar, joinedAt: Date.now(),
    currentTime: 0, playing: false, lastPing: Date.now(),
    hasAudio: false, hasVideo: false, hasScreen: false, isMuted: false
  });
  rooms.set(code, room);
  return room;
}

function getRoom(code) { return rooms.get(code?.toUpperCase()); }

function getUserList(room) {
  return Array.from(room.users.values()).map(u => ({
    id: u.id, nickname: u.nickname, avatar: u.avatar,
    isHost: u.id === room.hostId,
    currentTime: u.currentTime || 0, playing: u.playing || false,
    lastPing: u.lastPing || 0,
    hasAudio: u.hasAudio || false, hasVideo: u.hasVideo || false,
    hasScreen: u.hasScreen || false, isMuted: u.isMuted || false
  }));
}

function getCurrentVideo(room) {
  return (room.currentIndex >= 0 && room.currentIndex < room.playlist.length) ? room.playlist[room.currentIndex] : null;
}

function getEstimatedTime(room) {
  const ps = room.playbackState;
  return ps.playing ? ps.currentTime + (Date.now() - ps.lastUpdate) / 1000 * ps.playbackRate : ps.currentTime;
}

function saveMessage(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > MAX_CHAT_HISTORY) room.messages = room.messages.slice(-MAX_CHAT_HISTORY);
}

function addToWatchHistory(room, video) {
  room.watchHistory.push({ title: video.title, platform: video.platform, url: video.url, watchedAt: Date.now(), addedBy: video.addedBy });
  if (room.watchHistory.length > MAX_WATCH_HISTORY) room.watchHistory.shift();
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('room-deleted', { reason: 'Комната закрыта' });
  io.in(code).socketsLeave(code);
  rooms.delete(code);
}

// ==================== CLEANUP ====================

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_MAX_AGE) { deleteRoom(code); continue; }
    if (room.users.size === 0 && room.emptyAt && now - room.emptyAt > EMPTY_ROOM_TTL) rooms.delete(code);
  }
}, 30000);

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  let currentRoom = null;

  // ---- Create room ----
  socket.on('create-room', ({ nickname, avatar, password }, callback) => {
    if (currentRoom) leaveRoom(socket);
    const room = createRoom(socket, nickname, avatar, password);
    currentRoom = room.code;
    socket.join(room.code);
    callback({
      success: true, roomCode: room.code, isHost: true, hasPassword: !!room.password,
      users: getUserList(room), playlist: room.playlist, currentIndex: room.currentIndex,
      playbackState: room.playbackState, messages: room.messages, watchHistory: room.watchHistory,
      ...getTurnCredentials()
    });
  });

  // ---- Join room ----
  socket.on('join-room', ({ code, nickname, avatar, password }, callback) => {
    const room = getRoom(code);
    if (!room) return callback({ success: false, error: 'Комната не найдена' });
    if (room.password && room.password !== password) return callback({ success: false, error: 'Неверный пароль', needsPassword: true });
    if (room.kicked.has(nickname.toLowerCase())) return callback({ success: false, error: 'Вы были кикнуты из этой комнаты' });
    if (currentRoom) leaveRoom(socket);

    room.users.set(socket.id, {
      id: socket.id, nickname, avatar, joinedAt: Date.now(),
      currentTime: 0, playing: false, lastPing: Date.now(),
      hasAudio: false, hasVideo: false, hasScreen: false, isMuted: false
    });
    room.emptyAt = null;
    if (!room.hostId || !room.users.has(room.hostId)) room.hostId = socket.id;
    currentRoom = room.code;
    socket.join(room.code);

    const users = getUserList(room);
    socket.to(room.code).emit('user-joined', { user: { id: socket.id, nickname, avatar, isHost: false }, users });
    const sysMsg = { type: 'system', text: `${nickname} присоединился`, timestamp: Date.now() };
    saveMessage(room, sysMsg);
    socket.to(room.code).emit('chat-message', sysMsg);

    callback({
      success: true, roomCode: room.code, isHost: socket.id === room.hostId, hasPassword: !!room.password,
      users, playlist: room.playlist, currentIndex: room.currentIndex,
      playbackState: { ...room.playbackState, currentTime: getEstimatedTime(room) },
      currentVideo: getCurrentVideo(room), messages: room.messages, watchHistory: room.watchHistory,
      ...getTurnCredentials()
    });
  });

  // ---- Chat ----
  socket.on('chat-message', ({ text }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user || user.isMuted) return;
    const msg = { type: 'user', userId: socket.id, nickname: user.nickname, avatar: user.avatar, text, timestamp: Date.now() };
    saveMessage(room, msg);
    io.to(room.code).emit('chat-message', msg);
  });

  socket.on('typing', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) socket.to(room.code).emit('user-typing', { nickname: user.nickname });
  });

  // ---- User status ----
  socket.on('user-status', ({ currentTime, playing }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.currentTime = currentTime || 0;
    user.playing = playing || false;
    user.lastPing = Date.now();
  });

  socket.on('request-status', () => {
    const room = getRoom(currentRoom);
    if (room) socket.emit('room-status', { users: getUserList(room) });
  });

  // ---- Playlist ----
  socket.on('add-video', ({ url, title, platform }, callback) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const video = { id: uuidv4(), url, title, platform, addedBy: room.users.get(socket.id)?.nickname };
    room.playlist.push(video);
    io.to(room.code).emit('playlist-updated', { playlist: room.playlist });
    const sysMsg = { type: 'system', text: `${video.addedBy} добавил: ${title}`, timestamp: Date.now() };
    saveMessage(room, sysMsg);
    io.to(room.code).emit('chat-message', sysMsg);
    if (room.currentIndex === -1) {
      room.currentIndex = 0;
      room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
      io.to(room.code).emit('video-changed', { video, index: 0, playbackState: room.playbackState });
    }
    callback?.({ success: true });
  });

  socket.on('remove-video', ({ videoId }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    const idx = room.playlist.findIndex(v => v.id === videoId);
    if (idx === -1) return;
    room.playlist.splice(idx, 1);
    if (idx < room.currentIndex) room.currentIndex--;
    else if (idx === room.currentIndex) {
      if (room.playlist.length === 0) room.currentIndex = -1;
      else if (room.currentIndex >= room.playlist.length) room.currentIndex = room.playlist.length - 1;
      room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
      io.to(room.code).emit('video-changed', { video: getCurrentVideo(room), index: room.currentIndex, playbackState: room.playbackState });
    }
    io.to(room.code).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
  });

  socket.on('reorder-playlist', ({ fromIndex, toIndex }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    if (fromIndex < 0 || fromIndex >= room.playlist.length || toIndex < 0 || toIndex >= room.playlist.length) return;
    const [item] = room.playlist.splice(fromIndex, 1);
    room.playlist.splice(toIndex, 0, item);
    // Update currentIndex
    if (room.currentIndex === fromIndex) room.currentIndex = toIndex;
    else if (fromIndex < room.currentIndex && toIndex >= room.currentIndex) room.currentIndex--;
    else if (fromIndex > room.currentIndex && toIndex <= room.currentIndex) room.currentIndex++;
    io.to(room.code).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
  });

  socket.on('play-video-at', ({ index }) => {
    const room = getRoom(currentRoom);
    if (!room || index < 0 || index >= room.playlist.length) return;
    // Save to watch history
    const prevVideo = getCurrentVideo(room);
    if (prevVideo) addToWatchHistory(room, prevVideo);
    room.currentIndex = index;
    room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
    io.to(room.code).emit('video-changed', { video: room.playlist[index], index, playbackState: room.playbackState });
  });

  // ---- Playback sync ----
  socket.on('sync-play', ({ currentTime }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    room.playbackState = { ...room.playbackState, playing: true, currentTime, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-play', { currentTime });
  });
  socket.on('sync-pause', ({ currentTime }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    room.playbackState = { ...room.playbackState, playing: false, currentTime, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-pause', { currentTime });
  });
  socket.on('sync-seek', ({ currentTime }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    room.playbackState = { ...room.playbackState, currentTime, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-seek', { currentTime });
  });
  socket.on('sync-rate', ({ rate }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    room.playbackState.playbackRate = rate;
    socket.to(room.code).emit('sync-rate', { rate });
  });
  socket.on('sync-state', ({ currentTime, playing }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    room.playbackState = { ...room.playbackState, currentTime, playing, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-state', { currentTime, playing });
  });

  // ---- Reactions ----
  socket.on('reaction', ({ emoji }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    io.to(room.code).emit('reaction', { emoji, nickname: user?.nickname });
  });

  // ---- Playlist nav ----
  socket.on('next-video', () => {
    const room = getRoom(currentRoom);
    if (!room || room.currentIndex >= room.playlist.length - 1) return;
    const prevVideo = getCurrentVideo(room);
    if (prevVideo) addToWatchHistory(room, prevVideo);
    room.currentIndex++;
    room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
    io.to(room.code).emit('video-changed', { video: room.playlist[room.currentIndex], index: room.currentIndex, playbackState: room.playbackState });
  });
  socket.on('prev-video', () => {
    const room = getRoom(currentRoom);
    if (!room || room.currentIndex <= 0) return;
    room.currentIndex--;
    room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
    io.to(room.code).emit('video-changed', { video: room.playlist[room.currentIndex], index: room.currentIndex, playbackState: room.playbackState });
  });

  // ---- Host controls ----
  socket.on('transfer-host', ({ userId }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId || !room.users.has(userId)) return;
    room.hostId = userId;
    const users = getUserList(room);
    io.to(room.code).emit('host-changed', { newHostId: userId, users });
    const sysMsg = { type: 'system', text: `${room.users.get(userId).nickname} теперь хост`, timestamp: Date.now() };
    saveMessage(room, sysMsg);
    io.to(room.code).emit('chat-message', sysMsg);
  });

  socket.on('delete-room', () => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    deleteRoom(room.code);
    currentRoom = null;
  });

  // ---- Kick / Mute ----
  socket.on('kick-user', ({ userId }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId || userId === socket.id) return;
    const target = room.users.get(userId);
    if (!target) return;
    room.kicked.add(target.nickname.toLowerCase());
    io.to(userId).emit('kicked', { reason: 'Вас кикнули из комнаты' });
    const targetSocket = io.sockets.sockets.get(userId);
    if (targetSocket) {
      room.users.delete(userId);
      targetSocket.leave(room.code);
    }
    const sysMsg = { type: 'system', text: `${target.nickname} был кикнут`, timestamp: Date.now() };
    saveMessage(room, sysMsg);
    io.to(room.code).emit('chat-message', sysMsg);
    io.to(room.code).emit('user-left', { userId, users: getUserList(room), newHostId: room.hostId });
  });

  socket.on('mute-user', ({ userId, muted }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    const target = room.users.get(userId);
    if (!target) return;
    target.isMuted = muted;
    io.to(room.code).emit('user-muted', { userId, muted, users: getUserList(room) });
    const sysMsg = { type: 'system', text: `${target.nickname} ${muted ? 'замьючен' : 'размьючен'}`, timestamp: Date.now() };
    saveMessage(room, sysMsg);
    io.to(room.code).emit('chat-message', sysMsg);
  });

  // ---- Polls ----
  socket.on('create-poll', ({ question, options }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    const pollId = uuidv4().slice(0, 8);
    const poll = {
      id: pollId, question, options: options.map(o => ({ text: o, votes: [] })),
      createdBy: user.nickname, createdAt: Date.now()
    };
    room.polls.set(pollId, poll);
    io.to(room.code).emit('poll-created', poll);
  });

  socket.on('vote-poll', ({ pollId, optionIndex }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    const poll = room.polls.get(pollId);
    if (!poll || !user) return;
    // Remove previous vote
    poll.options.forEach(o => { o.votes = o.votes.filter(v => v !== user.nickname); });
    if (optionIndex >= 0 && optionIndex < poll.options.length) {
      poll.options[optionIndex].votes.push(user.nickname);
    }
    io.to(room.code).emit('poll-updated', poll);
  });

  // ---- WebRTC signaling (calls + screen share) ----
  socket.on('call-offer', ({ to, offer }) => io.to(to).emit('call-offer', { from: socket.id, offer }));
  socket.on('call-answer', ({ to, answer }) => io.to(to).emit('call-answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('request-call-peers', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const me = room.users.get(socket.id);
    const iHaveMedia = me && (me.hasAudio || me.hasVideo || me.hasScreen);
    const peerIds = [];
    for (const [id, u] of room.users) {
      if (id === socket.id) continue;
      // If I have media: send to ALL users (they need to receive my stream)
      // If I don't: only connect to users who have media (to receive theirs)
      if (iHaveMedia || u.hasAudio || u.hasVideo || u.hasScreen) {
        peerIds.push(id);
      }
    }
    socket.emit('call-peers', peerIds);
  });

  socket.on('media-state', ({ hasAudio, hasVideo, hasScreen }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.hasAudio = hasAudio;
    user.hasVideo = hasVideo;
    user.hasScreen = hasScreen || false;
    socket.to(room.code).emit('user-media-state', { userId: socket.id, hasAudio, hasVideo, hasScreen, users: getUserList(room) });
  });

  // ---- Screen share state ----
  socket.on('screen-start', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) user.hasScreen = true;
    socket.to(room.code).emit('screen-started', { userId: socket.id, nickname: user?.nickname });
  });

  socket.on('screen-stop', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) user.hasScreen = false;
    socket.to(room.code).emit('screen-stopped', { userId: socket.id });
  });

  // ---- Leave / Disconnect ----
  function leaveRoom(sock) {
    const room = getRoom(currentRoom);
    if (!room) { currentRoom = null; return; }
    const user = room.users.get(sock.id);
    room.users.delete(sock.id);
    sock.leave(room.code);
    if (room.users.size === 0) {
      room.emptyAt = Date.now();
    } else {
      if (room.hostId === sock.id) {
        const firstUser = room.users.values().next().value;
        room.hostId = firstUser.id;
        const sysMsg = { type: 'system', text: `${firstUser.nickname} теперь хост`, timestamp: Date.now() };
        saveMessage(room, sysMsg);
        io.to(room.code).emit('chat-message', sysMsg);
      }
      io.to(room.code).emit('user-left', { userId: sock.id, users: getUserList(room), newHostId: room.hostId });
      if (user) {
        const sysMsg = { type: 'system', text: `${user.nickname} вышел`, timestamp: Date.now() };
        saveMessage(room, sysMsg);
        io.to(room.code).emit('chat-message', sysMsg);
      }
    }
    currentRoom = null;
  }

  socket.on('leave-room', () => leaveRoom(socket));
  socket.on('disconnect', () => { if (currentRoom) leaveRoom(socket); });
});

// ==================== START ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] WatchTogether v3.0 on port ${PORT}`);
  setInterval(() => {
    if (rooms.size > 0) {
      const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      fetch(`${url}/ping`).catch(() => {});
    }
  }, 10 * 60 * 1000);
});
