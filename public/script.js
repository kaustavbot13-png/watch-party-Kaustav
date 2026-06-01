const socket = io();

// DOM Elements
const loginSection = document.getElementById('admin-login-section');
const passwordInput = document.getElementById('admin-password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const secretLoginTrigger = document.getElementById('secret-login-trigger');

const adminControls = document.getElementById('admin-controls');
const playlistContainer = document.getElementById('playlist-container');
const addLinkBtn = document.getElementById('add-link-btn');
const submitPlaylistBtn = document.getElementById('submit-playlist-btn');

const videoPlayer = document.getElementById('video-player');
const playerOverlay = document.getElementById('player-overlay');
const roleStatus = document.getElementById('role-status');
const noSignalScreen = document.getElementById('no-signal-screen');
const watermark = document.getElementById('watermark');
const guestPlayBtn = document.getElementById('guest-play-btn');
const fullRefreshBtn = document.getElementById('full-refresh-btn');
const safeExitBtn = document.getElementById('safe-exit-btn');

// State
let isAdmin = false;
let isSettingState = false;
let audioPlayer = null;
let currentTrack = 0;
let currentVideoUrl = '';
let currentPlaylistItem = null;
let ignoreNextSeek = false;
let transitionTimeoutId = null;
let isPageUnloading = false;
let currentBlobUrl = null;

// Removed loadVideoAsBlob to enable native streaming and fix duration issues.

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
        if (isPlaying && !videoPlayer.paused && videoPlayer.readyState >= 3) {
            const playPromise = audioPlayer.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => console.log("Audio autoplay prevented", e));
            }
        }
    }
    currentTrack = track;
}

function ensureGuestAudioPlayback() {
    if (isAdmin) return;

    if (currentTrack > 0) {
        if (audioPlayer) {
            audioPlayer.muted = false;
            audioPlayer.volume = videoPlayer.volume;
            const audioPromise = audioPlayer.play();
            if (audioPromise !== undefined) {
                audioPromise.catch(e => console.log("Guest audio play blocked", e));
            }
        }
    } else {
        videoPlayer.muted = false;
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => console.log("Guest video play blocked", e));
        }
    }
}

// Helpers
function checkSignalState(url) {
    if (!url || url === '') {
        noSignalScreen.classList.remove('hidden');
        watermark.classList.add('hidden');
    } else {
        noSignalScreen.classList.add('hidden');
        watermark.classList.remove('hidden');
    }
}

function setGuestMode() {
    isAdmin = false;
    videoPlayer.removeAttribute('controls');
    playerOverlay.classList.remove('admin-mode');
    roleStatus.textContent = 'Viewing as: Guest';
    loginSection.classList.add('hidden');
    adminControls.classList.add('hidden');
    videoPlayer.muted = false;
}

function getLoadedStreamUrl() {
    const candidates = [videoPlayer.getAttribute('src'), videoPlayer.src].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const parsed = new URL(candidate, window.location.origin);
            const proxiedUrl = parsed.searchParams.get('url');
            if (proxiedUrl) {
                return proxiedUrl;
            }
        } catch (e) {
            // Ignore parsing errors
        }
    }
    return '';
}

function normalizeComparableUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
        return new URL(rawUrl).toString();
    } catch (e) {
        return String(rawUrl).trim();
    }
}

if (secretLoginTrigger) {
    secretLoginTrigger.addEventListener('click', () => {
        if (!isAdmin) {
            loginSection.classList.toggle('hidden');
        }
    });
}

function setAdminMode() {
    isAdmin = true;
    videoPlayer.setAttribute('controls', 'true');
    playerOverlay.classList.add('admin-mode');
    roleStatus.textContent = 'Viewing as: Admin';
    loginSection.classList.add('hidden');
    adminControls.classList.remove('hidden');
    videoPlayer.muted = false;
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
            socket.emit('sync_request');
        } else {
            loginError.textContent = response.message || 'Login failed';
        }
    });
});

// Helper to attach events to a playlist item
function attachPlaylistItemEvents(itemDiv) {
    const loadBtn = itemDiv.querySelector('.load-video-btn');
    const urlInput = itemDiv.querySelector('.video-url');
    const trackGroup = itemDiv.querySelector('.track-selection-group');
    const trackSelector = itemDiv.querySelector('.audio-track-selector');
    const runBtn = itemDiv.querySelector('.run-video-btn');
    const removeBtn = itemDiv.querySelector('.remove-link-btn');

    loadBtn.addEventListener('click', () => {
        if (!isAdmin) return;
        const url = urlInput.value.trim();
        if (url) {
            loadBtn.disabled = true;
            loadBtn.textContent = 'Fetching...';

            socket.emit('fetch_audio_tracks', url, (response) => {
                loadBtn.disabled = false;
                loadBtn.textContent = 'Load';

                if (response.success && response.tracks && response.tracks.length > 0) {
                    trackSelector.innerHTML = '';
                    response.tracks.forEach(track => {
                        const option = document.createElement('option');
                        option.value = track.id;
                        option.textContent = track.language || `Track ${track.id + 1}`;
                        if (track.title) option.textContent += ` (${track.title})`;
                        trackSelector.appendChild(option);
                    });
                } else {
                    trackSelector.innerHTML = '<option value="0">Default Track</option>';
                }
                trackGroup.classList.remove('hidden');
            });
        }
    });

    runBtn.addEventListener('click', () => {
        if (!isAdmin) return;
        const url = urlInput.value.trim();
        const trackIndex = parseInt(trackSelector.value) || 0;

        if (url) {
            if (transitionTimeoutId) {
                clearTimeout(transitionTimeoutId);
                transitionTimeoutId = null;
            }
            isTransitioningVideo = false;

            currentVideoUrl = url;
            currentPlaylistItem = itemDiv;
            socket.emit('set_video', { url, audioTrack: trackIndex });

            isSettingState = true;
            ignoreNextSeek = true;
            checkSignalState(url);
            
            const streamUrl = '/stream?url=' + encodeURIComponent(url);
            videoPlayer.src = streamUrl;
            videoPlayer.currentTime = 0;
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
                playPromise.catch(e => console.log("Autoplay prevented or unsupported format:", e));
            }
            setTimeout(() => isSettingState = false, 100);
            return;
        }
    });

    removeBtn.addEventListener('click', () => {
        itemDiv.remove();
    });
}

// Attach events to the initial playlist item
const initialItems = playlistContainer.querySelectorAll('.playlist-item');
initialItems.forEach(attachPlaylistItemEvents);

// Admin Control Logic
addLinkBtn.addEventListener('click', () => {
    if (!isAdmin) return;

    const newItemDiv = document.createElement('div');
    newItemDiv.className = 'playlist-item';
    newItemDiv.innerHTML = `
        <div class="control-group">
            <input type="text" class="video-url" placeholder="Direct Video URL (e.g., .mp4, .webm)">
            <button class="load-video-btn">Load</button>
            <button class="remove-link-btn" style="background-color: #ff5252;">Remove</button>
        </div>
        <div class="control-group track-selection-group hidden" style="margin-top: 10px;">
            <select class="audio-track-selector">
                <option value="0">Default Track</option>
            </select>
            <button class="run-video-btn">Run</button>
        </div>
    `;
    playlistContainer.appendChild(newItemDiv);
    attachPlaylistItemEvents(newItemDiv);
});

submitPlaylistBtn.addEventListener('click', () => {
    if (!isAdmin) return;

    const items = Array.from(playlistContainer.querySelectorAll('.playlist-item'));
    for (const item of items) {
        const urlInput = item.querySelector('.video-url');
        const url = urlInput.value.trim();

        if (url) {
            const runBtn = item.querySelector('.run-video-btn');
            if (runBtn) {
                runBtn.click();
                return;
            }
        }
    }
});

if (fullRefreshBtn) {
    fullRefreshBtn.addEventListener('click', () => {
        if (!isAdmin) return;
        socket.emit('full_refresh');
    });
}

if (safeExitBtn) {
    safeExitBtn.addEventListener('click', () => {
        if (transitionTimeoutId) {
            clearTimeout(transitionTimeoutId);
            transitionTimeoutId = null;
        }
        isTransitioningVideo = false;
        socket.emit('admin_logout');
        setGuestMode();
        socket.emit('sync_request');
        setTimeout(() => {
            bypassAutoplay();
        }, 150);
    });
}

// Player Event Listeners for Admin -> Server
videoPlayer.addEventListener('play', () => {
    if (audioPlayer) audioPlayer.play();
    if (isAdmin && !isSettingState) {
        socket.emit('play', videoPlayer.currentTime);
    }
});

videoPlayer.addEventListener('pause', () => {
    if (audioPlayer) audioPlayer.pause();
    if (isAdmin && !isSettingState && !videoPlayer.ended && videoPlayer.readyState > 0 && !isPageUnloading) {
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
        if (currentTrack > 0 && !videoPlayer.muted) {
            videoPlayer.muted = true;
        }
    }
});

setInterval(() => {
    if (currentTrack > 0 && !videoPlayer.muted) {
        videoPlayer.muted = true;
    }
}, 500);

videoPlayer.addEventListener('seeked', () => {
    if (audioPlayer) {
        const url = currentVideoUrl || videoPlayer.getAttribute('src').replace('/stream?url=', '');
        const decodedUrl = decodeURIComponent(url);
        syncAudioTrack(decodedUrl, currentTrack, videoPlayer.currentTime, !videoPlayer.paused);
    }
    if (isAdmin && !isSettingState) {
        if (ignoreNextSeek) {
            ignoreNextSeek = false;
            if (videoPlayer.currentTime < 1) return;
        }
        socket.emit('seek', videoPlayer.currentTime);
    }
});

let isTransitioningVideo = false;

videoPlayer.addEventListener('ended', () => {
    if (!isAdmin) return;

    if (isTransitioningVideo) {
        console.log('Ignoring ended event during transition.');
        return;
    }

    console.log('Video ended event fired.');

    const items = Array.from(playlistContainer.querySelectorAll('.playlist-item'));

    let currentIndex = items.indexOf(currentPlaylistItem);

    if (currentIndex === -1) {
        for (let i = 0; i < items.length; i++) {
            const inputUrl = items[i].querySelector('.video-url').value.trim();
            if (inputUrl === currentVideoUrl) {
                currentIndex = i;
                break;
            }
        }
    }

    if (currentIndex !== -1 && currentIndex + 1 < items.length) {
        const nextItem = items[currentIndex + 1];
        const nextRunBtn = nextItem.querySelector('.run-video-btn');
        if (nextRunBtn) {
            isTransitioningVideo = true;
            transitionTimeoutId = setTimeout(() => {
                nextRunBtn.click();
                isTransitioningVideo = false;
            }, 500);
        }
    }
});

videoPlayer.addEventListener('error', (e) => {
    let errorMessage = "An unknown error occurred.";
    if (videoPlayer.error) {
        switch (videoPlayer.error.code) {
            case videoPlayer.error.MEDIA_ERR_ABORTED:
                errorMessage = "The video playback was aborted.";
                break;
            case videoPlayer.error.MEDIA_ERR_NETWORK:
                errorMessage = "A network error occurred while fetching the video.";
                break;
            case videoPlayer.error.MEDIA_ERR_DECODE:
                errorMessage = "The video could not be decoded.";
                break;
            case videoPlayer.error.MEDIA_ERR_SRC_NOT_SUPPORTED:
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

// ===== ZERO-SEEKING STRATEGY FOR GUESTS =====
// Guests will NEVER seek automatically. They only respond to:
// 1. Play/Pause commands from admin
// 2. Video change commands from admin
// This eliminates all restart loops on proxied streams.

function updatePlayerStateGuest(state) {
    checkSignalState(state.videoUrl);
    
    if (state.videoUrl === '') {
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        currentVideoUrl = '';
        syncAudioTrack('', 0, 0, false);
        return;
    }

    const loadedUrlWithParams = videoPlayer.getAttribute('src') || '';
    const stateUrl = state.videoUrl;

    // Extract base URL and start time from current src
    let currentBaseUrl = '';
    let currentStart = 0;
    if (loadedUrlWithParams.startsWith('/stream?url=')) {
        try {
            const urlObj = new URL(window.location.origin + loadedUrlWithParams);
            currentBaseUrl = urlObj.searchParams.get('url') || '';
            currentStart = parseFloat(urlObj.searchParams.get('start')) || 0;
        } catch(e) {}
    }

    const urlChanged = normalizeComparableUrl(currentBaseUrl) !== normalizeComparableUrl(stateUrl);
    const timeDrift = Math.abs((videoPlayer.currentTime + currentStart) - state.currentTime);
    const needsSeek = timeDrift > 3.0; // Increased threshold for stability

    if (urlChanged || (needsSeek && !videoPlayer.seeking)) {
        currentVideoUrl = stateUrl;
        // Use the new 'start' parameter for seeking instead of videoPlayer.currentTime
        // this avoids browser-side seeking issues on proxied streams.
        const proxyUrl = `/stream?url=${encodeURIComponent(stateUrl)}&start=${state.currentTime}`;
        
        isSettingState = true;
        videoPlayer.src = proxyUrl;
        videoPlayer.load();
        syncAudioTrack(stateUrl, state.audioTrack, state.currentTime, state.isPlaying);
        
        videoPlayer.onloadedmetadata = () => {
            if (videoPlayer.audioTracks && videoPlayer.audioTracks.length > 0) {
                for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                    videoPlayer.audioTracks[i].enabled = (i === state.audioTrack);
                }
            }
        };
        setTimeout(() => { isSettingState = false; }, 500);
    }

    isSettingState = true;

    // Sync play/pause state
    const currentPlayState = !videoPlayer.paused;
    const desiredPlayState = state.isPlaying;

    if (currentPlayState !== desiredPlayState) {
        if (state.isPlaying) {
            if (videoPlayer.paused) {
                const playPromise = videoPlayer.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => {
                        console.log("Autoplay prevented:", e);
                        autoplayBlocked = true;
                        roleStatus.textContent = "Tap video to play (Autoplay blocked)";
                        guestPlayBtn.classList.remove('hidden');
                    });
                }
            }
        } else {
            videoPlayer.pause();
        }
    }

    if (state.isPlaying) {
        ensureGuestAudioPlayback();
    }

    setTimeout(() => {
        isSettingState = false;
    }, 100);
}

// Socket Events
socket.on('init_state', (state) => {
    if (!isAdmin) {
        updatePlayerStateGuest(state);
    }
    socket.emit('sync_request');
});

socket.on('connect', () => {
    socket.emit('sync_request');
});

socket.on('sync_state', (state) => {
    if (!isAdmin) {
        updatePlayerStateGuest(state);
    } else {
        // Admin sync logic
        checkSignalState(state.videoUrl);
        if (state.videoUrl === '') {
            videoPlayer.removeAttribute('src');
            videoPlayer.load();
            currentVideoUrl = '';
            syncAudioTrack('', 0, 0, false);
            return;
        }
        const loadedUrl = getLoadedStreamUrl();
        const proxyUrl = '/stream?url=' + encodeURIComponent(state.videoUrl);
        if (loadedUrl !== state.videoUrl && state.videoUrl !== '') {
            isSettingState = true;
            videoPlayer.src = proxyUrl;
            currentVideoUrl = state.videoUrl;

            const inputs = document.querySelectorAll('.video-url');
            if (inputs.length > 0 && inputs[0].value === '') {
                inputs[0].value = state.videoUrl;
            }

            syncAudioTrack(state.videoUrl, state.audioTrack, state.currentTime, state.isPlaying);

            if (!videoPlayer.seeking && Math.abs(videoPlayer.currentTime - state.currentTime) > 1.5) {
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
            isSettingState = true;
            if (!videoPlayer.seeking && Math.abs(videoPlayer.currentTime - state.currentTime) > 1.5) {
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
    const url = typeof data === 'string' ? data : data.url;
    const trackIndex = typeof data === 'object' && data.audioTrack !== undefined ? data.audioTrack : 0;

    if (isAdmin && normalizeComparableUrl(currentVideoUrl) !== normalizeComparableUrl(url)) {
        currentVideoUrl = url;
        isSettingState = true;
        ignoreNextSeek = true;
        checkSignalState(url);
        const streamUrl = '/stream?url=' + encodeURIComponent(url);
        videoPlayer.src = streamUrl;
        videoPlayer.currentTime = 0;
        syncAudioTrack(url, trackIndex, 0, true);
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) playPromise.catch(e => console.log(e));
        setTimeout(() => isSettingState = false, 100);
    } else {
        // For guests, we rely on the periodic sync_request to update state accurately
        socket.emit('sync_request');
    }
});

socket.on('play', (currentTime) => {
    if (isAdmin && Math.abs(videoPlayer.currentTime - currentTime) > 1.5) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) playPromise.catch(e => console.log(e));
        setTimeout(() => isSettingState = false, 100);
    } else if (!isAdmin) {
        socket.emit('sync_request');
    }
});

socket.on('pause', (currentTime) => {
    if (isAdmin && Math.abs(videoPlayer.currentTime - currentTime) > 1.5) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        videoPlayer.pause();
        setTimeout(() => isSettingState = false, 100);
    } else if (!isAdmin) {
        socket.emit('sync_request');
    }
});

socket.on('seek', (currentTime) => {
    if (isAdmin && Math.abs(videoPlayer.currentTime - currentTime) > 1.5) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        setTimeout(() => isSettingState = false, 100);
    } else if (!isAdmin) {
        socket.emit('sync_request');
    }
});

function bypassAutoplay() {
    if (!isAdmin) {
        ensureGuestAudioPlayback();
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                autoplayBlocked = false;
                roleStatus.textContent = 'Viewing as: Guest';
                guestPlayBtn.classList.add('hidden');
                socket.emit('sync_request');
            }).catch(err => {
                console.log("Still blocked", err);
            });
        }
    }
}

playerOverlay.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    bypassAutoplay();
});

if (guestPlayBtn) {
    guestPlayBtn.addEventListener('click', bypassAutoplay);
}

window.addEventListener('beforeunload', () => {
    isPageUnloading = true;
});

window.addEventListener('pagehide', () => {
    isPageUnloading = true;
});

// Sync every few seconds for guests, and update time for admins
setInterval(() => {
    if (!isAdmin && videoPlayer.getAttribute('src')) {
        socket.emit('sync_request');
    } else if (isAdmin && !videoPlayer.paused && videoPlayer.getAttribute('src') && videoPlayer.readyState >= 3) {
        socket.emit('admin_time_update', videoPlayer.currentTime);
    }
}, 2000);
