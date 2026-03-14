const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfprobePath(ffprobePath);
const axios = require('axios');

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

app.get('/stream', async (req, res) => {
  const videoUrl = req.query.url;
  const range = req.headers.range;

  if (!videoUrl) {
    return res.status(400).send("No video URL provided.");
  }

  try {
    const options = {
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      headers: {}
    };

    if (range) {
      options.headers['Range'] = range;
    }

    const response = await axios(options);

    // Forward the necessary headers
    const headers = {
      'Content-Length': response.headers['content-length'],
      'Content-Type': response.headers['content-type'],
      'Accept-Ranges': 'bytes',
    };

    if (response.headers['content-range']) {
      headers['Content-Range'] = response.headers['content-range'];
    }

    res.writeHead(response.status, headers);
    response.data.pipe(res);
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).send(error.message);
    } else {
      res.status(500).send("Error fetching video stream.");
    }
  }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'EDh2ZaQx6TeU@j';

// Global state
let playerState = {
  videoUrl: '',
  audioTrack: 0,
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
  socket.on('fetch_audio_tracks', (url, callback) => {
    if (!socket.isAdmin) return callback({ success: false, message: 'Unauthorized' });

    ffmpeg.ffprobe(url, (err, metadata) => {
      if (err) {
        console.error('Error fetching tracks:', err.message);
        return callback({ success: false, message: 'Could not fetch metadata' });
      }

      const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
      const tracks = audioStreams.map((stream, index) => ({
        id: index,
        index: stream.index,
        language: stream.tags && stream.tags.language ? stream.tags.language : `Track ${index + 1}`,
        title: stream.tags && stream.tags.title ? stream.tags.title : null
      }));

      callback({ success: true, tracks });
    });
  });

  socket.on('set_video', (data) => {
    if (!socket.isAdmin) return;
    const url = typeof data === 'string' ? data : data.url;
    const track = typeof data === 'object' && data.audioTrack !== undefined ? data.audioTrack : 0;

    playerState.videoUrl = url;
    playerState.audioTrack = track;
    playerState.isPlaying = true;
    playerState.currentTime = 0;
    playerState.updatedAt = Date.now();

    io.emit('video_changed', { url, audioTrack: track });
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

  socket.on('admin_time_update', (currentTime) => {
    if (!socket.isAdmin) return;
    playerState.currentTime = currentTime;
    playerState.updatedAt = Date.now();
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
