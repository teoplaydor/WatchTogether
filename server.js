const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 30000
});

app.use(express.static(path.join(__dirname, 'public')));

// Keep-alive endpoint
app.get('/ping', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));

// ==================== ROOMS ====================

const ROOM_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const EMPTY_ROOM_TTL = 60 * 60 * 1000;     // 1 hour after last user leaves
const MAX_CHAT_HISTORY = 500;

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function createRoom(hostSocket, nickname, avatar) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocket.id,
    users: new Map(),
    playlist: [],
    currentIndex: -1,
    playbackState: {
      playing: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      playbackRate: 1
    },
    messages: [],
    createdAt: Date.now(),
    emptyAt: null
  };
  room.users.set(hostSocket.id, {
    id: hostSocket.id, nickname, avatar, joinedAt: Date.now(),
    currentTime: 0, playing: false, lastPing: Date.now(),
    hasAudio: false, hasVideo: false
  });
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

function getUserList(room) {
  return Array.from(room.users.values()).map(u => ({
    id: u.id,
    nickname: u.nickname,
    avatar: u.avatar,
    isHost: u.id === room.hostId,
    currentTime: u.currentTime || 0,
    playing: u.playing || false,
    lastPing: u.lastPing || 0,
    hasAudio: u.hasAudio || false,
    hasVideo: u.hasVideo || false
  }));
}

function getCurrentVideo(room) {
  if (room.currentIndex >= 0 && room.currentIndex < room.playlist.length) {
    return room.playlist[room.currentIndex];
  }
  return null;
}

function getEstimatedTime(room) {
  const ps = room.playbackState;
  if (!ps.playing) return ps.currentTime;
  return ps.currentTime + (Date.now() - ps.lastUpdate) / 1000 * ps.playbackRate;
}

function saveMessage(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > MAX_CHAT_HISTORY) {
    room.messages = room.messages.slice(-MAX_CHAT_HISTORY);
  }
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('room-deleted', { reason: 'Комната закрыта' });
  // Disconnect all sockets from the room
  io.in(code).socketsLeave(code);
  rooms.delete(code);
  console.log(`[ROOM] Room ${code} deleted`);
}

// ==================== CLEANUP ====================

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // Delete rooms older than 24 hours
    if (now - room.createdAt > ROOM_MAX_AGE) {
      deleteRoom(code);
      continue;
    }
    // Delete empty rooms after 1 hour
    if (room.users.size === 0 && room.emptyAt && now - room.emptyAt > EMPTY_ROOM_TTL) {
      rooms.delete(code);
      console.log(`[ROOM] Room ${code} deleted (empty for 1 hour)`);
    }
  }
}, 30000);

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  let currentRoom = null;

  // Create room
  socket.on('create-room', ({ nickname, avatar }, callback) => {
    if (currentRoom) leaveRoom(socket);
    const room = createRoom(socket, nickname, avatar);
    currentRoom = room.code;
    socket.join(room.code);
    callback({
      success: true,
      roomCode: room.code,
      isHost: true,
      users: getUserList(room),
      playlist: room.playlist,
      currentIndex: room.currentIndex,
      playbackState: room.playbackState,
      messages: room.messages
    });
    console.log(`[ROOM] ${nickname} created room ${room.code}`);
  });

  // Join room
  socket.on('join-room', ({ code, nickname, avatar }, callback) => {
    const room = getRoom(code);
    if (!room) return callback({ success: false, error: 'Комната не найдена' });
    if (currentRoom) leaveRoom(socket);

    room.users.set(socket.id, {
      id: socket.id, nickname, avatar, joinedAt: Date.now(),
      currentTime: 0, playing: false, lastPing: Date.now(),
      hasAudio: false, hasVideo: false
    });
    room.emptyAt = null;
    if (!room.hostId || !room.users.has(room.hostId)) {
      room.hostId = socket.id;
    }
    currentRoom = room.code;
    socket.join(room.code);

    const users = getUserList(room);
    socket.to(room.code).emit('user-joined', {
      user: { id: socket.id, nickname, avatar, isHost: false },
      users
    });

    const sysMsg = { type: 'system', text: `${nickname} присоединился`, timestamp: Date.now() };
    saveMessage(room, sysMsg);
    socket.to(room.code).emit('chat-message', sysMsg);

    callback({
      success: true,
      roomCode: room.code,
      isHost: socket.id === room.hostId,
      users,
      playlist: room.playlist,
      currentIndex: room.currentIndex,
      playbackState: { ...room.playbackState, currentTime: getEstimatedTime(room) },
      currentVideo: getCurrentVideo(room),
      messages: room.messages
    });
    console.log(`[ROOM] ${nickname} joined room ${room.code}`);
  });

  // Chat message
  socket.on('chat-message', ({ text }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;

    const msg = {
      type: 'user',
      userId: socket.id,
      nickname: user.nickname,
      avatar: user.avatar,
      text,
      timestamp: Date.now()
    };
    saveMessage(room, msg);
    io.to(room.code).emit('chat-message', msg);
  });

  // Typing indicator
  socket.on('typing', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    socket.to(room.code).emit('user-typing', { nickname: user.nickname });
  });

  // ==================== USER STATUS ====================

  socket.on('user-status', ({ currentTime, playing }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.currentTime = currentTime || 0;
    user.playing = playing || false;
    user.lastPing = Date.now();
  });

  // Broadcast all user statuses every 3 seconds
  // (handled via client requesting it, see 'request-status')
  socket.on('request-status', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    socket.emit('room-status', { users: getUserList(room), serverTime: Date.now() });
  });

  // ==================== PLAYLIST ====================

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
      const newVideo = getCurrentVideo(room);
      room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
      io.to(room.code).emit('video-changed', { video: newVideo, index: room.currentIndex, playbackState: room.playbackState });
    }

    io.to(room.code).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
  });

  socket.on('play-video-at', ({ index }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    if (index < 0 || index >= room.playlist.length) return;

    room.currentIndex = index;
    room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
    io.to(room.code).emit('video-changed', {
      video: room.playlist[index],
      index,
      playbackState: room.playbackState
    });
  });

  // ==================== PLAYBACK SYNC ====================

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

  // ==================== REACTIONS ====================

  socket.on('reaction', ({ emoji }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    io.to(room.code).emit('reaction', { emoji, nickname: user?.nickname });
  });

  // ==================== PLAYLIST NAV ====================

  socket.on('next-video', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    if (room.currentIndex < room.playlist.length - 1) {
      room.currentIndex++;
      room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
      io.to(room.code).emit('video-changed', {
        video: room.playlist[room.currentIndex],
        index: room.currentIndex,
        playbackState: room.playbackState
      });
    }
  });

  socket.on('prev-video', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    if (room.currentIndex > 0) {
      room.currentIndex--;
      room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
      io.to(room.code).emit('video-changed', {
        video: room.playlist[room.currentIndex],
        index: room.currentIndex,
        playbackState: room.playbackState
      });
    }
  });

  // ==================== HOST CONTROLS ====================

  socket.on('transfer-host', ({ userId }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    if (!room.users.has(userId)) return;
    room.hostId = userId;
    const users = getUserList(room);
    io.to(room.code).emit('host-changed', { newHostId: userId, users });
    const newHost = room.users.get(userId);
    const sysMsg = { type: 'system', text: `${newHost.nickname} теперь хост`, timestamp: Date.now() };
    saveMessage(room, sysMsg);
    io.to(room.code).emit('chat-message', sysMsg);
  });

  socket.on('delete-room', () => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    deleteRoom(room.code);
    currentRoom = null;
  });

  // ==================== WEBRTC SIGNALING ====================

  socket.on('call-offer', ({ to, offer }) => {
    io.to(to).emit('call-offer', { from: socket.id, offer });
  });

  socket.on('call-answer', ({ to, answer }) => {
    io.to(to).emit('call-answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('request-call-peers', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const peerIds = [];
    for (const [id, u] of room.users) {
      if (id !== socket.id && (u.hasAudio || u.hasVideo)) {
        peerIds.push(id);
      }
    }
    socket.emit('call-peers', peerIds);
  });

  socket.on('media-state', ({ hasAudio, hasVideo }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.hasAudio = hasAudio;
    user.hasVideo = hasVideo;
    socket.to(room.code).emit('user-media-state', {
      userId: socket.id, hasAudio, hasVideo,
      users: getUserList(room)
    });
  });

  // ==================== LEAVE / DISCONNECT ====================

  function leaveRoom(sock) {
    const room = getRoom(currentRoom);
    if (!room) { currentRoom = null; return; }

    const user = room.users.get(sock.id);
    room.users.delete(sock.id);
    sock.leave(room.code);

    if (room.users.size === 0) {
      room.emptyAt = Date.now();
      console.log(`[ROOM] Room ${room.code} is now empty, will delete in 1 hour if no one rejoins`);
    } else {
      if (room.hostId === sock.id) {
        const firstUser = room.users.values().next().value;
        room.hostId = firstUser.id;
        const sysMsg = { type: 'system', text: `${firstUser.nickname} теперь хост`, timestamp: Date.now() };
        saveMessage(room, sysMsg);
        io.to(room.code).emit('chat-message', sysMsg);
      }
      const users = getUserList(room);
      io.to(room.code).emit('user-left', { userId: sock.id, users, newHostId: room.hostId });
      if (user) {
        const sysMsg = { type: 'system', text: `${user.nickname} вышел`, timestamp: Date.now() };
        saveMessage(room, sysMsg);
        io.to(room.code).emit('chat-message', sysMsg);
      }
    }
    currentRoom = null;
  }

  socket.on('leave-room', () => leaveRoom(socket));
  socket.on('disconnect', () => {
    if (currentRoom) leaveRoom(socket);
  });
});

// ==================== START ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] WatchTogether v2.0 running on port ${PORT}`);

  // Self-ping every 10 minutes to prevent Render free tier sleep
  // Only when there are active rooms
  setInterval(() => {
    if (rooms.size > 0) {
      const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      fetch(`${url}/ping`).catch(() => {});
      console.log(`[KEEPALIVE] Pinged self, ${rooms.size} active rooms`);
    }
  }, 10 * 60 * 1000);
});
