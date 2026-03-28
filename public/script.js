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
    // Keep sound ON by default for normal track playback.
    videoPlayer.muted = false;
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
    // Keep sound ON by default for normal track playback.
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

            // Re-sync video when admin logs in to make sure they have the right state to control
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
            // Cancel any pending auto-transition
            if (transitionTimeoutId) {
                clearTimeout(transitionTimeoutId);
                transitionTimeoutId = null;
            }
            isTransitioningVideo = false;

            currentVideoUrl = url;
            currentPlaylistItem = itemDiv;
            socket.emit('set_video', { url, audioTrack: trackIndex });

            // Update local admin player immediately
            isSettingState = true;
            ignoreNextSeek = true;
            checkSignalState(url);
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
                return; // start with the first valid link
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

// Player Event Listeners for Admin -> Server
videoPlayer.addEventListener('play', () => {
    if (audioPlayer) audioPlayer.play();
    if (isAdmin && !isSettingState) {
        socket.emit('play', videoPlayer.currentTime);
    }
});

videoPlayer.addEventListener('pause', () => {
    if (audioPlayer) audioPlayer.pause();
    // Do not broadcast pause if the video has naturally ended or is unloading to avoid interrupting sequential playback
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
        const url = currentVideoUrl || videoPlayer.getAttribute('src').replace('/stream?url=', ''); // Fallback for guest if needed, but guest doesn't seek natively
        const decodedUrl = decodeURIComponent(url);
        // To avoid re-fetching on minor sync drift, only update if difference is noticeable. But this is the native 'seeked' event.
        // It's fired when admin scrubs the bar or guest receives a big sync update.
        syncAudioTrack(decodedUrl, currentTrack, videoPlayer.currentTime, !videoPlayer.paused);
    }
    if (isAdmin && !isSettingState) {
        if (ignoreNextSeek) {
            ignoreNextSeek = false;
            if (videoPlayer.currentTime < 1) return; // Ignore the initial seek to 0 when loading a new video
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

    // Find the currently playing item in the playlist
    const items = Array.from(playlistContainer.querySelectorAll('.playlist-item'));

    let currentIndex = items.indexOf(currentPlaylistItem);

    // Fallback logic if the exact item ref was lost
    if (currentIndex === -1) {
        for (let i = 0; i < items.length; i++) {
            const inputUrl = items[i].querySelector('.video-url').value.trim();
            if (inputUrl === currentVideoUrl) {
                currentIndex = i;
                break;
            }
        }
    }

    // If there is a next item, run it
    if (currentIndex !== -1 && currentIndex + 1 < items.length) {
        const nextItem = items[currentIndex + 1];
        const nextRunBtn = nextItem.querySelector('.run-video-btn');
        if (nextRunBtn) {
            isTransitioningVideo = true;

            // Clear the server state immediately to show NO SIGNAL for 2 minutes
            socket.emit('full_refresh');

            // Wait 2 minutes (120000 ms) before triggering the next video
            transitionTimeoutId = setTimeout(() => {
                console.log('Clicking next run button after 2 minute delay');
                nextRunBtn.click();

                // Allow some time for the new video to start playing before we allow another 'ended' event
                setTimeout(() => {
                    isTransitioningVideo = false;
                }, 2000);

                transitionTimeoutId = null;
            }, 120000);
        }
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
    checkSignalState(state.videoUrl);
    if (state.videoUrl === '') {
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        currentVideoUrl = '';
        syncAudioTrack('', 0, 0, false);
        return;
    }

    const proxyUrl = '/stream?url=' + encodeURIComponent(state.videoUrl);
    const currentSrcAttr = videoPlayer.getAttribute('src');
    const currentAbsoluteSrc = videoPlayer.src;
    const srcMismatch =
        currentSrcAttr !== proxyUrl &&
        (!currentAbsoluteSrc || !currentAbsoluteSrc.endsWith(proxyUrl));
    const shouldReloadSource = state.videoUrl !== '' && (state.videoUrl !== currentVideoUrl || srcMismatch);

    if (shouldReloadSource) {
        currentVideoUrl = state.videoUrl;
        videoPlayer.src = proxyUrl;
        videoPlayer.setAttribute('src', proxyUrl);

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
                    guestPlayBtn.classList.remove('hidden');
                }
            });
        }
        ensureGuestAudioPlayback();
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
        checkSignalState(state.videoUrl);
        if (state.videoUrl === '') {
            videoPlayer.removeAttribute('src');
            videoPlayer.load();
            currentVideoUrl = '';
            syncAudioTrack('', 0, 0, false);
            return;
        }
        const currentSrc = videoPlayer.getAttribute('src');
        const currentAbsoluteSrc = videoPlayer.src;
        const proxyUrl = '/stream?url=' + encodeURIComponent(state.videoUrl);
        if (proxyUrl !== currentSrc && (!currentAbsoluteSrc || !currentAbsoluteSrc.endsWith(proxyUrl)) && state.videoUrl !== '') {
            isSettingState = true;
            videoPlayer.src = proxyUrl;
            currentVideoUrl = state.videoUrl;

            // Try to update an input if one exists with this URL, or just let it be.
            const inputs = document.querySelectorAll('.video-url');
            if (inputs.length > 0 && inputs[0].value === '') {
                inputs[0].value = state.videoUrl;
            }

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
    const url = typeof data === 'string' ? data : data.url;
    const trackIndex = typeof data === 'object' && data.audioTrack !== undefined ? data.audioTrack : 0;

    if (isAdmin && currentVideoUrl !== url) {
        // Another admin changed the video or auto-transition fired, update this admin's player!
        currentVideoUrl = url;
        isSettingState = true;
        ignoreNextSeek = true;
        checkSignalState(url);
        videoPlayer.src = '/stream?url=' + encodeURIComponent(url);
        videoPlayer.currentTime = 0;
        syncAudioTrack(url, trackIndex, 0, true);
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) playPromise.catch(e => console.log(e));
        setTimeout(() => isSettingState = false, 100);
    } else if (!isAdmin) {
        currentVideoUrl = url;
        checkSignalState(url);
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
                guestPlayBtn.classList.remove('hidden');
            });
        }
    }
});

socket.on('play', (currentTime) => {
    if (isAdmin && Math.abs(videoPlayer.currentTime - currentTime) > 3) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) playPromise.catch(e => console.log(e));
        setTimeout(() => isSettingState = false, 100);
    } else if (!isAdmin) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => {
                console.log("Autoplay prevented:", e);
                autoplayBlocked = true;
                roleStatus.textContent = "Tap video to play (Autoplay blocked)";
                guestPlayBtn.classList.remove('hidden');
            });
        }
        setTimeout(() => isSettingState = false, 100);
    }
});

socket.on('pause', (currentTime) => {
    if (isAdmin && Math.abs(videoPlayer.currentTime - currentTime) > 3) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        videoPlayer.pause();
        setTimeout(() => isSettingState = false, 100);
    } else if (!isAdmin) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        videoPlayer.pause();
        setTimeout(() => isSettingState = false, 100);
    }
});

socket.on('seek', (currentTime) => {
    if (isAdmin && Math.abs(videoPlayer.currentTime - currentTime) > 3) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        setTimeout(() => isSettingState = false, 100);
    } else if (!isAdmin) {
        isSettingState = true;
        videoPlayer.currentTime = currentTime;
        setTimeout(() => isSettingState = false, 100);
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
                // Sync to make sure time is right
                socket.emit('sync_request');
            }).catch(err => {
                console.log("Still blocked", err);
            });
        }
    }
}

// Prevent non-admins from clicking to pause if native controls appear somehow
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
        // Admin continually pushes their exact playback time to prevent drift, but only if video has actually loaded and is playing (readyState >= 3 prevents pushing 0 repeatedly during transition buffering)
        socket.emit('admin_time_update', videoPlayer.currentTime);
    }
}, 2000);
