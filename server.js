const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'abd123abd';

// Global state
let playerState = {
  videoUrl: '',
  isPlaying: false,
  currentTime: 0,
  updatedAt: Date.now()
};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Send current state to newly connected client
  socket.emit('init_state', playerState);

  socket.on('admin_login', (password, callback) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admins');
      socket.isAdmin = true;
      console.log('Admin logged in:', socket.id);
      callback({ success: true });
    } else {
      callback({ success: false, message: 'Invalid password' });
    }
  });

  // Admin controls
  socket.on('set_video', (url) => {
    if (!socket.isAdmin) return;
    playerState.videoUrl = url;
    playerState.isPlaying = true;
    playerState.currentTime = 0;
    playerState.updatedAt = Date.now();
    io.emit('video_changed', url);
  });

  socket.on('play', (currentTime) => {
    if (!socket.isAdmin) return;
    playerState.isPlaying = true;
    playerState.currentTime = currentTime;
    playerState.updatedAt = Date.now();
    socket.broadcast.emit('play', currentTime);
  });

  socket.on('pause', (currentTime) => {
    if (!socket.isAdmin) return;
    playerState.isPlaying = false;
    playerState.currentTime = currentTime;
    playerState.updatedAt = Date.now();
    socket.broadcast.emit('pause', currentTime);
  });

  socket.on('seek', (currentTime) => {
    if (!socket.isAdmin) return;
    playerState.currentTime = currentTime;
    playerState.updatedAt = Date.now();
    socket.broadcast.emit('seek', currentTime);
  });

  socket.on('sync_request', () => {
    // Calculate expected current time if playing
    let time = playerState.currentTime;
    if (playerState.isPlaying) {
      time += (Date.now() - playerState.updatedAt) / 1000;
    }
    socket.emit('sync_state', { ...playerState, currentTime: time });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
