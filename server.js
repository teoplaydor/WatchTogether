const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

// ==================== ROOMS ====================

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
    createdAt: Date.now()
  };
  room.users.set(hostSocket.id, { id: hostSocket.id, nickname, avatar, joinedAt: Date.now() });
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
    isHost: u.id === room.hostId
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

// ==================== CLEANUP ====================

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.users.size === 0 && now - room.createdAt > 60000) {
      rooms.delete(code);
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
      playbackState: room.playbackState
    });
    console.log(`[ROOM] ${nickname} created room ${room.code}`);
  });

  // Join room
  socket.on('join-room', ({ code, nickname, avatar }, callback) => {
    const room = getRoom(code);
    if (!room) return callback({ success: false, error: 'Комната не найдена' });
    if (currentRoom) leaveRoom(socket);

    room.users.set(socket.id, { id: socket.id, nickname, avatar, joinedAt: Date.now() });
    currentRoom = room.code;
    socket.join(room.code);

    const users = getUserList(room);
    socket.to(room.code).emit('user-joined', {
      user: { id: socket.id, nickname, avatar, isHost: false },
      users
    });
    socket.to(room.code).emit('chat-message', {
      type: 'system',
      text: `${nickname} присоединился`,
      timestamp: Date.now()
    });

    callback({
      success: true,
      roomCode: room.code,
      isHost: socket.id === room.hostId,
      users,
      playlist: room.playlist,
      currentIndex: room.currentIndex,
      playbackState: { ...room.playbackState, currentTime: getEstimatedTime(room) },
      currentVideo: getCurrentVideo(room)
    });
    console.log(`[ROOM] ${nickname} joined room ${room.code}`);
  });

  // Chat message
  socket.on('chat-message', ({ text }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;

    io.to(room.code).emit('chat-message', {
      type: 'user',
      userId: socket.id,
      nickname: user.nickname,
      avatar: user.avatar,
      text,
      timestamp: Date.now()
    });
  });

  // Typing indicator
  socket.on('typing', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    socket.to(room.code).emit('user-typing', { nickname: user.nickname });
  });

  // Add video to playlist
  socket.on('add-video', ({ url, title, platform }, callback) => {
    const room = getRoom(currentRoom);
    if (!room) return;

    const video = { id: uuidv4(), url, title, platform, addedBy: room.users.get(socket.id)?.nickname };
    room.playlist.push(video);
    io.to(room.code).emit('playlist-updated', { playlist: room.playlist });
    io.to(room.code).emit('chat-message', {
      type: 'system',
      text: `${video.addedBy} добавил: ${title}`,
      timestamp: Date.now()
    });

    if (room.currentIndex === -1) {
      room.currentIndex = 0;
      room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
      io.to(room.code).emit('video-changed', { video, index: 0, playbackState: room.playbackState });
    }

    callback?.({ success: true });
  });

  // Remove video from playlist
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

  // Play video from playlist
  socket.on('play-video-at', ({ index }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    if (index < 0 || index >= room.playlist.length) return;

    room.currentIndex = index;
    room.playbackState = { playing: false, currentTime: 0, lastUpdate: Date.now(), playbackRate: 1 };
    io.to(room.code).emit('video-changed', {
      video: room.playlist[index],
      index,
      playbackState: room.playbackState
    });
  });

  // Playback sync events
  socket.on('sync-play', ({ currentTime }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    room.playbackState = { ...room.playbackState, playing: true, currentTime, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-play', { currentTime });
  });

  socket.on('sync-pause', ({ currentTime }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    room.playbackState = { ...room.playbackState, playing: false, currentTime, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-pause', { currentTime });
  });

  socket.on('sync-seek', ({ currentTime }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    room.playbackState = { ...room.playbackState, currentTime, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-seek', { currentTime });
  });

  socket.on('sync-rate', ({ rate }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    room.playbackState.playbackRate = rate;
    socket.to(room.code).emit('sync-rate', { rate });
  });

  // Periodic sync check from host
  socket.on('sync-state', ({ currentTime, playing }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    room.playbackState = { ...room.playbackState, currentTime, playing, lastUpdate: Date.now() };
    socket.to(room.code).emit('sync-state', { currentTime, playing });
  });

  // Reaction
  socket.on('reaction', ({ emoji }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    io.to(room.code).emit('reaction', { emoji, nickname: user?.nickname });
  });

  // Next/Prev video
  socket.on('next-video', () => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
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
    if (!room || socket.id !== room.hostId) return;
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

  // Transfer host
  socket.on('transfer-host', ({ userId }) => {
    const room = getRoom(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    if (!room.users.has(userId)) return;
    room.hostId = userId;
    const users = getUserList(room);
    io.to(room.code).emit('host-changed', { newHostId: userId, users });
    const newHost = room.users.get(userId);
    io.to(room.code).emit('chat-message', {
      type: 'system',
      text: `${newHost.nickname} теперь хост`,
      timestamp: Date.now()
    });
  });

  // Leave room
  function leaveRoom(sock) {
    const room = getRoom(currentRoom);
    if (!room) { currentRoom = null; return; }

    const user = room.users.get(sock.id);
    room.users.delete(sock.id);
    sock.leave(room.code);

    if (room.users.size === 0) {
      rooms.delete(room.code);
      console.log(`[ROOM] Room ${room.code} deleted (empty)`);
    } else {
      if (room.hostId === sock.id) {
        const firstUser = room.users.values().next().value;
        room.hostId = firstUser.id;
        io.to(room.code).emit('chat-message', {
          type: 'system',
          text: `${firstUser.nickname} теперь хост`,
          timestamp: Date.now()
        });
      }
      const users = getUserList(room);
      io.to(room.code).emit('user-left', { userId: sock.id, users, newHostId: room.hostId });
      if (user) {
        io.to(room.code).emit('chat-message', {
          type: 'system',
          text: `${user.nickname} вышел`,
          timestamp: Date.now()
        });
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
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         🎬 WatchTogether v1.0           ║
  ║                                          ║
  ║  Сервер запущен: http://localhost:${PORT}    ║
  ║                                          ║
  ║  Для доступа по сети используйте         ║
  ║  ваш локальный IP адрес                  ║
  ╚══════════════════════════════════════════╝
  `);
});
