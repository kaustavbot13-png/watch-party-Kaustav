const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
// Fallback to system ffprobe/ffmpeg if installer fails (e.g. SIGSEGV on some systems)
try {
  const { execSync } = require('child_process');
  const sysFfprobe = execSync('which ffprobe').toString().trim();
  if (sysFfprobe) ffmpeg.setFfprobePath(sysFfprobe);
  else ffmpeg.setFfprobePath(ffprobePath);

  const sysFfmpeg = execSync('which ffmpeg').toString().trim();
  if (sysFfmpeg) ffmpeg.setFfmpegPath(sysFfmpeg);
} catch (e) {
  ffmpeg.setFfprobePath(ffprobePath);
}
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

    const contentType = response.headers['content-type'] || '';
    const contentDisposition = response.headers['content-disposition'] || '';
    const urlLower = videoUrl.toLowerCase();

    if (contentType.includes('matroska') || contentType.includes('mkv') ||
        contentDisposition.toLowerCase().includes('.mkv') ||
        urlLower.includes('.mkv')) {
      // Browsers often support the underlying codecs of an MKV file (like H.264 or HEVC)
      // but reject the MKV container itself. We can use FFmpeg to repackage the container
      // to Matroska with a more browser-friendly mime type, or just change the container to MP4.
      // Since MP4 requires specific moov atom placement for streaming, we use fragmented MP4.
      headers['Content-Type'] = 'video/mp4';
      delete headers['Content-Length']; // Length is unknown during remux
      res.writeHead(response.status, headers);

      const command = ffmpeg(response.data)
        .outputOptions([
            '-c copy',     // Copy video and audio codecs (no transcoding, low CPU)
            '-movflags frag_keyframe+empty_moov', // Required to stream MP4 without a seekable output
            '-f mp4'       // Output as MP4 container
        ])
        .on('error', (err) => {
            console.error('FFmpeg remux error:', err.message);
            // Ignore socket closed errors, only log actual failures
            if (!err.message.includes('Output stream closed')) {
                if (!res.headersSent) res.status(500).send("Error streaming remuxed video.");
            }
        });

      command.pipe(res, { end: true });

      req.on('close', () => {
        command.kill('SIGKILL');
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      });
    } else {
      res.writeHead(response.status, headers);
      response.data.pipe(res);

      req.on('close', () => {
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      });
    }
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).send(error.message);
    } else {
      res.status(500).send("Error fetching video stream.");
    }
  }
});

app.get('/audio_stream', (req, res) => {
  const videoUrl = req.query.url;
  const track = req.query.track || '1';
  const start = req.query.start || '0';

  if (!videoUrl) {
    return res.status(400).send("No video URL provided.");
  }

  res.setHeader('Content-Type', 'audio/webm');

  const command = ffmpeg(videoUrl)
    .inputOptions([
        '-ss ' + start
    ])
    .outputOptions([
        '-map 0:a:' + track,
        '-c:a aac',
        '-b:a 128k',
        '-f adts'
    ])
    .on('error', (err) => {
        console.error('FFmpeg audio stream error:', err.message);
        if (!res.headersSent) {
            res.status(500).send("Error streaming audio.");
        }
    });

  command.pipe(res);

  req.on('close', () => {
      command.kill('SIGKILL');
  });
});

let activeBrowser = null;
let activeStream = null;
let activePassThroughs = new Set();
let isBrowserStarting = false;

function broadcastToClients(chunk) {
    for (const pt of activePassThroughs) {
        try { pt.write(chunk); } catch (e) {}
    }
}

app.get('/browser-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("No URL provided.");

  res.setHeader('Content-Type', 'video/mp4');

  if (activeBrowser && !isBrowserStarting) {
      if (playerState.videoUrl !== url) {
      } else {
          activePassThroughs.add(res);
          req.on('close', () => activePassThroughs.delete(res));
          return;
      }
  }

  let retries = 0;
  while (isBrowserStarting && retries < 10) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries++;
  }
  if (activeBrowser) {
      activePassThroughs.add(res);
      req.on('close', () => activePassThroughs.delete(res));
      return;
  }
  if (isBrowserStarting) {
      return res.status(500).send("Browser starting failed.");
  }

  isBrowserStarting = true;

  try {
    if (activeBrowser) {
      if (activeStream) activeStream.destroy();
      await activeBrowser.close();
      activeBrowser = null;
      activeStream = null;
      for (const pt of activePassThroughs) pt.end();
      activePassThroughs.clear();
    }

    activePassThroughs.add(res);

    req.on('close', () => {
        activePassThroughs.delete(res);
    });

    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      defaultViewport: {
        width: 1280,
        height: 720,
      },
      headless: false,
      ignoreDefaultArgs: ['--mute-audio', '--hide-scrollbars'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });

    activeBrowser = browser;

    const page = await browser.newPage();
    await page.goto(url);

    await new Promise(r => setTimeout(r, 2000));

    const passThrough = new PassThrough();
    activeStream = passThrough;

    // We stream MP4 to passThrough
    const recorder = new PuppeteerScreenRecorder(page, {
      followNewTab: false,
      fps: 25,
      videoFrame: { width: 1280, height: 720 },
      recordDurationLimit: 3600
    });

    await recorder.startStream(passThrough);

    passThrough.on('data', (chunk) => {
        broadcastToClients(chunk);
    });

    passThrough.on('end', () => {
        for (const pt of activePassThroughs) pt.end();
        activePassThroughs.clear();
    });

    // Override cleanup to also stop recorder
    const origClose = req.on.bind(req);
    req.on('close', async () => {
        try { await recorder.stop(); } catch(e){}
    });

    isBrowserStarting = false;

  } catch (err) {
    isBrowserStarting = false;
    console.error("Browser stream error:", err);
    if (!res.headersSent) {
      res.status(500).send("Error streaming browser.");
    }
    for (const pt of activePassThroughs) pt.end();
    activePassThroughs.clear();
  }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123';

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

  socket.on('full_refresh', () => {
    if (!socket.isAdmin) return;
    playerState.videoUrl = '';
    playerState.audioTrack = 0;
    playerState.isPlaying = false;
    playerState.currentTime = 0;
    playerState.updatedAt = Date.now();
    io.emit('sync_state', playerState);
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
