const socket = io();

// DOM Elements
const loginSection = document.getElementById('admin-login-section');
const passwordInput = document.getElementById('admin-password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const adminControls = document.getElementById('admin-controls');
const videoUrlInput = document.getElementById('video-url');
const loadVideoBtn = document.getElementById('load-video-btn');

const videoPlayer = document.getElementById('video-player');
const playerOverlay = document.getElementById('player-overlay');
const roleStatus = document.getElementById('role-status');

// State
let isAdmin = false;
let isSettingState = false;

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
        socket.emit('set_video', url);

        // Update local admin player immediately
        isSettingState = true;
        videoPlayer.src = url;
        videoPlayer.currentTime = 0;
        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => console.log("Autoplay prevented or unsupported format:", e));
        }
        setTimeout(() => isSettingState = false, 100);
    }
});

// Player Event Listeners for Admin -> Server
videoPlayer.addEventListener('play', () => {
    if (isAdmin && !isSettingState) {
        socket.emit('play', videoPlayer.currentTime);
    }
});

videoPlayer.addEventListener('pause', () => {
    if (isAdmin && !isSettingState) {
        socket.emit('pause', videoPlayer.currentTime);
    }
});

videoPlayer.addEventListener('seeked', () => {
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
    if (state.videoUrl !== currentSrc && state.videoUrl !== '') {
        videoPlayer.src = state.videoUrl;
    }

    isSettingState = true;

    if (Math.abs(videoPlayer.currentTime - state.currentTime) > 1) {
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
    if (state.videoUrl) {
        // Only request sync if there's a video playing
        socket.emit('sync_request');
    }
});

socket.on('sync_state', (state) => {
    if (!isAdmin) {
        updatePlayerState(state);
    } else {
        // Handle admin refresh
        const currentSrc = videoPlayer.getAttribute('src');
        if (state.videoUrl !== currentSrc && state.videoUrl !== '') {
            isSettingState = true;
            videoPlayer.src = state.videoUrl;
            videoUrlInput.value = state.videoUrl;

            if (Math.abs(videoPlayer.currentTime - state.currentTime) > 1) {
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
            if (Math.abs(videoPlayer.currentTime - state.currentTime) > 1) {
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

socket.on('video_changed', (url) => {
    if (!isAdmin) {
        videoPlayer.src = url;
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

// Sync every few seconds for guests just to be sure
setInterval(() => {
    if (!isAdmin && videoPlayer.getAttribute('src')) {
        socket.emit('sync_request');
    }
}, 5000);
