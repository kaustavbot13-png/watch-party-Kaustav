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
  let sysFfprobe = '';
  try { sysFfprobe = execSync('which ffprobe').toString().trim(); } catch(e) {}
  if (sysFfprobe) {
    ffmpeg.setFfprobePath(sysFfprobe);
  } else {
    ffmpeg.setFfprobePath(ffprobePath);
  }

  let sysFfmpeg = '';
  try { sysFfmpeg = execSync('which ffmpeg').toString().trim(); } catch(e) {}
  if (sysFfmpeg) {
    ffmpeg.setFfmpegPath(sysFfmpeg);
  } else {
    ffmpeg.setFfmpegPath(ffmpegPath);
  }
} catch (e) {
  ffmpeg.setFfprobePath(ffprobePath);
  ffmpeg.setFfmpegPath(ffmpegPath);
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

function isLikelyBrowserSafeType(contentType = '') {
  const type = contentType.toLowerCase();
  return (
    type.includes('video/mp4') ||
    type.includes('video/webm') ||
    type.includes('video/ogg') ||
    type.includes('video/quicktime') ||
    type.includes('application/vnd.apple.mpegurl') ||
    type.includes('application/x-mpegurl')
  );
}

function isLikelyDirectVideoUrl(url = '') {
  const lower = url.toLowerCase();
  return ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.m3u8'].some((ext) => lower.includes(ext));
}

function isLikelyHtmlPage(contentType = '') {
  return contentType.toLowerCase().includes('text/html');
}

app.get('/stream', async (req, res) => {
  const videoUrl = req.query.url;
  const startTime = req.query.start || 0;
  const clientRange = req.headers.range;

  if (!videoUrl) {
    return res.status(400).send("No video URL provided.");
  }

  try {
    let parsedUrl;
    try {
      parsedUrl = new URL(videoUrl);
    } catch (e) {
      return res.status(400).send("Invalid video URL.");
    }

    const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const referer = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    // 1. Initial check to see if we need to remux or if it's an HTML page
    let probeResponse;
    try {
      probeResponse = await axios({
        method: 'HEAD',
        url: videoUrl,
        headers: { 'User-Agent': userAgent, 'Referer': referer },
        timeout: 10000,
        maxRedirects: 10
      });
    } catch (err) {
      try {
        // Fallback to GET if HEAD fails
        probeResponse = await axios({
          method: 'GET',
          url: videoUrl,
          headers: { 'User-Agent': userAgent, 'Referer': referer, 'Range': 'bytes=0-0' },
          timeout: 10000,
          maxRedirects: 10
        });
      } catch (innerErr) {
        return res.status(500).send("Could not reach the video server: " + innerErr.message);
      }
    }

    const contentType = probeResponse.headers['content-type'] || '';
    const contentDisposition = probeResponse.headers['content-disposition'] || '';
    const urlLower = videoUrl.toLowerCase();

    if (isLikelyHtmlPage(contentType) && !isLikelyDirectVideoUrl(videoUrl)) {
      return res.status(400).send("The URL points to an HTML page, not a direct video file.");
    }

    let shouldRemux =
      contentType.includes('matroska') ||
      contentType.includes('mkv') ||
      contentDisposition.toLowerCase().includes('.mkv') ||
      urlLower.includes('.mkv') ||
      !isLikelyBrowserSafeType(contentType) ||
      startTime > 0;

    if (shouldRemux) {
      // When remuxing or seeking, we use FFmpeg to fetch and process.
      // We don't send Content-Length because the output size is unknown.
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      let response;
      let command;

      req.on('close', () => {
        if (response && response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
        if (command && typeof command.kill === 'function') {
          command.kill('SIGKILL');
        }
      });

      response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': userAgent,
          'Referer': referer
        },
        timeout: 20000,
        maxRedirects: 10
      });

      command = ffmpeg()
        .input(response.data)
        .outputOptions([
          `-ss ${startTime}`,
          '-c:v copy',
          '-c:a aac', // Transcode audio to AAC for better compatibility
          '-movflags frag_keyframe+empty_moov+faststart',
          '-f mp4'
        ])
        .on('error', (err) => {
          if (!err.message.includes('Output stream closed') && !res.headersSent) {
            console.error('FFmpeg remux error:', err.message);
          }
        });

      command.pipe(res, { end: true });
    } else {
      // Direct proxy for browser-safe formats without seeking
      const response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': userAgent,
          'Referer': referer,
          'Range': clientRange
        },
        timeout: 20000,
        maxRedirects: 10
      });

      const passThroughHeaders = {
        'Content-Type': response.headers['content-type'] || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        'Connection': 'keep-alive'
      };

      if (response.headers['content-length']) {
        passThroughHeaders['Content-Length'] = response.headers['content-length'];
      }
      if (response.headers['content-range']) {
        passThroughHeaders['Content-Range'] = response.headers['content-range'];
      }

      res.writeHead(response.status, passThroughHeaders);
      response.data.pipe(res);

      req.on('close', () => {
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      });
    }
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      res.status(504).send("Upstream video server timed out.");
    } else if (error.response) {
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

  res.setHeader('Content-Type', 'audio/aac');

  let parsedUrl;
  try {
    parsedUrl = new URL(videoUrl);
  } catch (e) {
    return res.status(400).send("Invalid video URL.");
  }

  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const referer = `${parsedUrl.protocol}//${parsedUrl.host}/`;

  let axiosStream = null;
  let audioCommand = null;

  req.on('close', () => {
    if (axiosStream && typeof axiosStream.destroy === 'function') {
      axiosStream.destroy();
    }
    if (audioCommand && typeof audioCommand.kill === 'function') {
      audioCommand.kill('SIGKILL');
    }
  });

  axios({
    method: 'GET',
    url: videoUrl,
    responseType: 'stream',
    headers: {
      'User-Agent': userAgent,
      'Referer': referer
    },
    timeout: 20000,
    maxRedirects: 10
  }).then(response => {
    axiosStream = response.data;
    audioCommand = ffmpeg()
      .input(axiosStream)
      .outputOptions([
          '-ss ' + start,
          '-map 0:a:' + track,
          '-c:a aac',
          '-b:a 128k',
          '-f adts'
      ])
      .on('error', (err) => {
          if (!err.message.includes('Output stream closed') && !res.headersSent) {
              console.error('FFmpeg audio stream error:', err.message);
          }
      });

    audioCommand.pipe(res);
  }).catch(err => {
    if (!res.headersSent) {
      res.status(500).send("Error fetching audio stream.");
    }
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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kkr58';

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

  socket.on('admin_logout', () => {
    socket.leave('admins');
    socket.isAdmin = false;
    console.log('Admin logged out:', socket.id);
  });

  // Admin controls
  socket.on('fetch_audio_tracks', async (url, callback) => {
    if (!socket.isAdmin) return callback({ success: false, message: 'Unauthorized' });

    try {
      const parsedUrl = new URL(url);
      const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const referer = `${parsedUrl.protocol}//${parsedUrl.host}/`;

      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        headers: {
          'User-Agent': userAgent,
          'Referer': referer
        },
        timeout: 15000,
        maxRedirects: 10
      });

      ffmpeg.ffprobe(response.data, (err, metadata) => {
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }

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
    } catch (e) {
      console.error('Error fetching tracks stream:', e.message);
      return callback({ success: false, message: 'Could not fetch metadata (stream error)' });
    }
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
    io.emit('sync_state', playerState);
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
      const elapsedSeconds = (Date.now() - playerState.updatedAt) / 1000;
      time += elapsedSeconds;
    }
    // Send the calculated state with accurate current time
    socket.emit('sync_state', { 
      videoUrl: playerState.videoUrl,
      audioTrack: playerState.audioTrack,
      isPlaying: playerState.isPlaying,
      currentTime: time,
      updatedAt: Date.now()
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
