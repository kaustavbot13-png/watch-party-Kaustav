const ffmpeg = require('fluent-ffmpeg');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfprobePath(ffprobePath);

ffmpeg.ffprobe("https://bot2-g3xn.onrender.com/dl/69b6d8c4ac53c74f0756f06c", (err, metadata) => {
  if (err) {
    console.error(err);
  } else {
    console.log("Codec details:");
    metadata.streams.forEach(s => console.log(s.codec_type, s.codec_name));
  }
});
