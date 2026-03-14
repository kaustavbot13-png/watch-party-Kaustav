const socket = io();

// DOM Elements
const loginSection = document.getElementById('admin-login-section');
const passwordInput = document.getElementById('admin-password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const adminControls = document.getElementById('admin-controls');
const videoUrlInput = document.getElementById('video-url');
const loadVideoBtn = document.getElementById('load-video-btn');
const trackSelectionGroup = document.getElementById('track-selection-group');
const audioTrackSelector = document.getElementById('audio-track-selector');
const runVideoBtn = document.getElementById('run-video-btn');

const videoPlayer = document.getElementById('video-player');
const playerOverlay = document.getElementById('player-overlay');
const roleStatus = document.getElementById('role-status');

// State
let isAdmin = false;
let isSettingState = false;
let audioPlayer = null;
let currentTrack = 0;

function syncAudioTrack(url, track, startTime, isPlaying) {
    if (track == 0 || !url) {
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.removeAttribute('src');
            audioPlayer = null;
        }
        videoPlayer.muted = false;
    } else {
        videoPlayer.muted = true;
        if (!audioPlayer) {
            audioPlayer = new Audio();
        }
        audioPlayer.src = '/audio_stream?url=' + encodeURIComponent(url) + '&track=' + track + '&start=' + startTime;
        // Let the videoPlayer's 'playing' event handle the audioPlayer.play()
        // This ensures the audio doesn't start before the video does,
        // avoiding desync if video takes longer to buffer.
        if (isPlaying && !videoPlayer.paused && videoPlayer.readyState >= 3) {
            const playPromise = audioPlayer.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => console.log("Audio autoplay prevented", e));
            }
        }
    }
    currentTrack = track;
}

// Helpers
function setGuestMode() {
    isAdmin = false;
    videoPlayer.removeAttribute('controls');
    playerOverlay.classList.remove('admin-mode');
    roleStatus.textContent = 'Viewing as: Guest';
    loginSection.classList.remove('hidden');
    adminControls.classList.add('hidden');
}

function setAdminMode() {
    isAdmin = true;
    videoPlayer.setAttribute('controls', 'true');
    playerOverlay.classList.add('admin-mode');
    roleStatus.textContent = 'Viewing as: Admin';
    loginSection.classList.add('hidden');
    adminControls.classList.remove('hidden');
}

// Initial mode
setGuestMode();

// Login Logic
loginBtn.addEventListener('click', () => {
    const password = passwordInput.value;
    if (!password) return;

    socket.emit('admin_login', password, (response) => {
        if (response.success) {
            setAdminMode();
            loginError.textContent = '';

            // Re-sync video when admin logs in to make sure they have the right state to control
            socket.emit('sync_request');
        } else {
            loginError.textContent = response.message || 'Login failed';
        }
    });
});

// Admin Control Logic
loadVideoBtn.addEventListener('click', () => {
    if (!isAdmin) return;
    const url = videoUrlInput.value.trim();
    if (url) {
        loadVideoBtn.disabled = true;
        loadVideoBtn.textContent = 'Fetching Tracks...';

        socket.emit('fetch_audio_tracks', url, (response) => {
            loadVideoBtn.disabled = false;
            loadVideoBtn.textContent = 'Load Video';

            if (response.success && response.tracks && response.tracks.length > 0) {
                audioTrackSelector.innerHTML = '';
                response.tracks.forEach(track => {
                    const option = document.createElement('option');
                    option.value = track.id;
                    option.textContent = track.language || `Track ${track.id + 1}`;
                    if (track.title) option.textContent += ` (${track.title})`;
                    audioTrackSelector.appendChild(option);
                });
            } else {
                audioTrackSelector.innerHTML = '<option value="0">Default Track</option>';
            }
            trackSelectionGroup.classList.remove('hidden');
        });
    }
});

runVideoBtn.addEventListener('click', () => {
    if (!isAdmin) return;
    const url = videoUrlInput.value.trim();
    const trackIndex = parseInt(audioTrackSelector.value) || 0;

    if (url) {
        socket.emit('set_video', { url, audioTrack: trackIndex });

        // Update local admin player immediately
        isSettingState = true;
        videoPlayer.src = '/stream?url=' + encodeURIComponent(url);
        videoPlayer.currentTime = 0;
        syncAudioTrack(url, trackIndex, 0, true);

        // Wait for metadata to load to apply audio track if possible
        videoPlayer.onloadedmetadata = () => {
             if (videoPlayer.audioTracks && videoPlayer.audioTracks.length > 0) {
                 for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                     videoPlayer.audioTracks[i].enabled = (i === trackIndex);
                 }
             }
        };

        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => console.log("Autoplay prevented or unsupported format:", e));
        }
        setTimeout(() => isSettingState = false, 100);
    }
});

// Player Event Listeners for Admin -> Server
videoPlayer.addEventListener('play', () => {
    if (audioPlayer) audioPlayer.play();
    if (isAdmin && !isSettingState) {
        socket.emit('play', videoPlayer.currentTime);
    }
});

videoPlayer.addEventListener('pause', () => {
    if (audioPlayer) audioPlayer.pause();
    if (isAdmin && !isSettingState) {
        socket.emit('pause', videoPlayer.currentTime);
    }
});

videoPlayer.addEventListener('waiting', () => {
    if (audioPlayer) audioPlayer.pause();
});

videoPlayer.addEventListener('playing', () => {
    if (audioPlayer) audioPlayer.play();
});

videoPlayer.addEventListener('volumechange', () => {
    if (audioPlayer) {
        audioPlayer.volume = videoPlayer.volume;
        // Aggressively prevent native video from unmuting if track > 0
        if (currentTrack > 0 && !videoPlayer.muted) {
            videoPlayer.muted = true;
        }
    }
});

// Extra safeguard to enforce muting periodically in case browser unmutes it
setInterval(() => {
    if (currentTrack > 0 && !videoPlayer.muted) {
        videoPlayer.muted = true;
    }
}, 500);

videoPlayer.addEventListener('seeked', () => {
    if (audioPlayer) {
        // Must reload the audio stream from the new start time since it's an ffmpeg stream
        const url = videoUrlInput.value.trim() || videoPlayer.getAttribute('src').replace('/stream?url=', ''); // Fallback for guest if needed, but guest doesn't seek natively
        const decodedUrl = decodeURIComponent(url);
        // To avoid re-fetching on minor sync drift, only update if difference is noticeable. But this is the native 'seeked' event.
        // It's fired when admin scrubs the bar or guest receives a big sync update.
        syncAudioTrack(decodedUrl, currentTrack, videoPlayer.currentTime, !videoPlayer.paused);
    }
    if (isAdmin && !isSettingState) {
        socket.emit('seek', videoPlayer.currentTime);
    }
});

// Handle Video Errors
videoPlayer.addEventListener('error', (e) => {
    const error = videoPlayer.error;
    let errorMessage = "Unknown Error";
    if (error) {
        switch (error.code) {
            case error.MEDIA_ERR_ABORTED:
                errorMessage = "You aborted the video playback.";
                break;
            case error.MEDIA_ERR_NETWORK:
                errorMessage = "A network error caused the video download to fail part-way. The link token might be expired.";
                break;
            case error.MEDIA_ERR_DECODE:
                errorMessage = "The video playback was aborted due to a corruption problem or because the video used features your browser did not support.";
                break;
            case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                errorMessage = "The video could not be loaded, either because the server or network failed or because the format is not supported (e.g., .mkv files are often not supported natively by browsers). Try an .mp4 link.";
                break;
            default:
                errorMessage = "An unknown error occurred.";
                break;
        }
    }

    if (isAdmin) {
        alert("Video Error: " + errorMessage);
    }
    console.error("Video Error:", errorMessage, e);
});

let autoplayBlocked = false;

// Sync Logic from Server -> Client
function updatePlayerState(state) {
    // Compare against getAttribute to avoid absolute URL mismatch
    const currentSrc = videoPlayer.getAttribute('src');
    const proxyUrl = '/stream?url=' + encodeURIComponent(state.videoUrl);

    if (proxyUrl !== currentSrc && state.videoUrl !== '') {
        videoPlayer.src = proxyUrl;

        // Setup separate audio stream if needed
        syncAudioTrack(state.videoUrl, state.audioTrack, state.currentTime, state.isPlaying);

        videoPlayer.onloadedmetadata = () => {
             if (videoPlayer.audioTracks && videoPlayer.audioTracks.length > 0) {
                 for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                     videoPlayer.audioTracks[i].enabled = (i === state.audioTrack);
                 }
             }
        };
    }

    isSettingState = true;

    // Only force time update if not seeking, to avoid interrupting buffering
    if (!videoPlayer.seeking && Math.abs(videoPlayer.currentTime - state.currentTime) > 3) {
        videoPlayer.currentTime = state.currentTime;
    }

    if (state.isPlaying) {
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => {
                console.log("Autoplay prevented or interrupted:", e);
                autoplayBlocked = true;
                if (!isAdmin) {
                    roleStatus.textContent = "Tap video to play (Autoplay blocked)";
                }
            });
        }
    } else {
        videoPlayer.pause();
    }

    // Slight delay to re-enable broadcasting after applying remote state
    setTimeout(() => {
        isSettingState = false;
    }, 100);
}

// Socket Events
socket.on('init_state', (state) => {
    // Always request sync to get initial state correctly
    socket.emit('sync_request');
});

socket.on('sync_state', (state) => {
    if (!isAdmin) {
        updatePlayerState(state);
    } else {
        // Handle admin refresh
        const currentSrc = videoPlayer.getAttribute('src');
        const proxyUrl = '/stream?url=' + encodeURIComponent(state.videoUrl);
        if (proxyUrl !== currentSrc && state.videoUrl !== '') {
            isSettingState = true;
            videoPlayer.src = proxyUrl;
            videoUrlInput.value = state.videoUrl;

            syncAudioTrack(state.videoUrl, state.audioTrack, state.currentTime, state.isPlaying);

            if (!videoPlayer.seeking && Math.abs(videoPlayer.currentTime - state.currentTime) > 3) {
                videoPlayer.currentTime = state.currentTime;
            }

            if (state.isPlaying) {
                const playPromise = videoPlayer.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => console.log("Admin Autoplay prevented:", e));
                }
            } else {
                videoPlayer.pause();
            }
            setTimeout(() => isSettingState = false, 100);
        } else {
            // Already loaded, just sync time
            isSettingState = true;
            if (!videoPlayer.seeking && Math.abs(videoPlayer.currentTime - state.currentTime) > 3) {
                videoPlayer.currentTime = state.currentTime;
            }
            if (state.isPlaying) {
                const playPromise = videoPlayer.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => console.log("Admin Autoplay prevented:", e));
                }
            } else {
                videoPlayer.pause();
            }
            setTimeout(() => isSettingState = false, 100);
        }
    }
});

socket.on('video_changed', (data) => {
    if (!isAdmin) {
        const url = typeof data === 'string' ? data : data.url;
        const trackIndex = typeof data === 'object' && data.audioTrack !== undefined ? data.audioTrack : 0;

        videoPlayer.src = '/stream?url=' + encodeURIComponent(url);
        syncAudioTrack(url, trackIndex, 0, true);
        videoPlayer.onloadedmetadata = () => {
             if (videoPlayer.audioTracks && videoPlayer.audioTracks.length > 0) {
                 for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                     videoPlayer.audioTracks[i].enabled = (i === trackIndex);
                 }
             }
        };
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => {
                console.log("Autoplay prevented:", e);
                autoplayBlocked = true;
                roleStatus.textContent = "Tap video to play (Autoplay blocked)";
            });
        }
    }
});

socket.on('play', (currentTime) => {
    if (!isAdmin) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        if (audioPlayer && Math.abs(audioPlayer.currentTime - currentTime) > 3) {
             // For guest, play syncs might have drift, but we already have seek events for big changes.
             // We can just rely on the video's 'seeked' and 'play' events which we hooked into.
        }
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => {
                console.log("Autoplay prevented:", e);
                autoplayBlocked = true;
                roleStatus.textContent = "Tap video to play (Autoplay blocked)";
            });
        }
        setTimeout(() => isSettingState = false, 100);
    }
});

socket.on('pause', (currentTime) => {
    if (!isAdmin) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        videoPlayer.pause();
        setTimeout(() => isSettingState = false, 100);
    }
});

socket.on('seek', (currentTime) => {
    if (!isAdmin) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        setTimeout(() => isSettingState = false, 100);
    }
});

// Prevent non-admins from clicking to pause if native controls appear somehow
playerOverlay.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Allow users to tap to bypass autoplay policies
    if (autoplayBlocked && !isAdmin) {
        const playPromise = videoPlayer.play();
        if (audioPlayer && currentTrack > 0) {
            audioPlayer.play().catch(e => console.log("Audio still blocked", e));
        }
        if (playPromise !== undefined) {
            playPromise.then(() => {
                autoplayBlocked = false;
                roleStatus.textContent = 'Viewing as: Guest';
                // Sync to make sure time is right
                socket.emit('sync_request');
            }).catch(err => {
                console.log("Still blocked", err);
            });
        }
    }
});

// Sync every few seconds for guests, and update time for admins
setInterval(() => {
    if (!isAdmin && videoPlayer.getAttribute('src')) {
        socket.emit('sync_request');
    } else if (isAdmin && !videoPlayer.paused && videoPlayer.getAttribute('src')) {
        // Admin continually pushes their exact playback time to prevent drift
        socket.emit('admin_time_update', videoPlayer.currentTime);
    }
}, 2000);
