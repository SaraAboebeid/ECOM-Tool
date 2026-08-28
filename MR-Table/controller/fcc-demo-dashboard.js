// FCC Demo Dashboard (extracted from controller.js)
// =============================================
// Handles the FCC VR Demo dashboard, playback controls, and stats.
// Exposes globals: fccDemoState, updateFCCDemoDashboard, attachFCCDemoEventListeners,
//   updateFCCDemoProgress, updateFCCDemoPlayButton, updateFCCDemoStats, formatTime
// Dependencies (resolved at call time): channel, MSG_TYPES, loadStreetViewConfig

// FCC Demo state tracking
let fccDemoState = {
    isActive: false,
    isPlaying: false,
    progress: 0,
    currentTime: 0,
    videoDuration: 20,
    pathLength: 0,
    pointCount: 0,
    stats: null
};

function updateFCCDemoDashboard() {
    const dashboardContent = document.getElementById('dashboard-content');
    const legendContent = document.getElementById('legend-content');
    const dashboardTitle = document.getElementById('dashboard-title');
    const legendTitle = document.getElementById('legend-title');
    
    if (dashboardTitle) dashboardTitle.textContent = 'FCC VR Demo';
    if (legendTitle) legendTitle.textContent = 'Video Player';
    
    // Check if FCC demo is active
    const fccBtn = document.querySelector('.control-btn[data-target="fcc-demo-btn"]');
    const isActive = fccBtn && fccBtn.classList.contains('active');
    
    if (!isActive) {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">videocam</span>
                        FCC VR Demo
                    </div>
                    <div class="info-box" style="border-left-color: #22c55e;">
                        <div class="info-title">Click to Activate</div>
                        <p class="info-text">
                            Synchronized VR flythrough with isovist visualization.
                            Click the FCC Demo button to start.
                        </p>
                    </div>
                </div>
            </div>
        `;
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Video Player</div>
                <p style="color: #6b7280; font-size: 0.9rem;">Activate FCC Demo to view video.</p>
            </div>
        `;
        return;
    }
    
    // Dashboard with controls
    dashboardContent.innerHTML = `
        <div class="dashboard-container">
            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">tune</span>
                    Playback Controls
                </div>
                
                <div class="control-row">
                    <label class="control-label">Progress</label>
                    <input type="range" id="fcc-progress" class="modern-range" min="0" max="100" step="0.1" value="${fccDemoState.progress * 100}">
                    <span id="fcc-progress-display" class="control-value">${(fccDemoState.progress * 100).toFixed(0)}%</span>
                </div>
                
                <div class="control-row">
                    <label class="control-label">Time</label>
                    <span id="fcc-time-display" class="control-value">${formatTime(fccDemoState.currentTime)} / ${formatTime(fccDemoState.videoDuration)}</span>
                </div>
                
                <div class="control-row">
                    <label class="control-label">Speed</label>
                    <input type="range" id="fcc-speed" class="modern-range" min="0.25" max="2" step="0.25" value="1">
                    <span id="fcc-speed-display" class="control-value">1x</span>
                </div>
                
                <div class="action-grid">
                    <button id="fcc-play-btn" class="modern-btn primary">
                        <span class="material-icons">${fccDemoState.isPlaying ? 'pause' : 'play_arrow'}</span>
                        ${fccDemoState.isPlaying ? 'Pause' : 'Play'}
                    </button>
                    <button id="fcc-restart-btn" class="modern-btn">
                        <span class="material-icons">replay</span> Restart
                    </button>
                </div>
            </div>
            
            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">analytics</span>
                    View Statistics
                </div>
                <div id="fcc-stats-container">
                    <div class="control-row">
                        <span class="control-label">Open View</span>
                        <span id="fcc-stat-open" class="control-value">--%</span>
                    </div>
                    <div class="control-row">
                        <span class="control-label">Trees</span>
                        <span id="fcc-stat-trees" class="control-value">--%</span>
                    </div>
                    <div class="control-row">
                        <span class="control-label">Buildings</span>
                        <span id="fcc-stat-buildings" class="control-value">--%</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Legend with video player and Street View
    legendContent.innerHTML = `
        <div class="dashboard-card">
            <div class="dashboard-section-title">
                <span class="material-icons" style="font-size: 18px;">videocam</span>
                VR Recording
            </div>
            <div style="position: relative; width: 100%; padding-top: 56.25%; background: #1a1a1a; border-radius: 8px; overflow: hidden;">
                <video id="fcc-video" 
                    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain;"
                    src="media/FCC_DTCC_VR.mp4"
                    muted>
                    Your browser does not support video playback.
                </video>
            </div>
        </div>
        
        <div class="dashboard-card" style="margin-top: 0.75rem;">
            <div class="dashboard-section-title">
                <span class="material-icons" style="font-size: 18px;">streetview</span>
                Street View (Live)
            </div>
            <div id="street-view-panel" style="width: 100%; height: 180px; background: #1a1a1a; border-radius: 8px; position: relative; overflow: hidden;">
                <img id="street-view-image" style="width: 100%; height: 100%; object-fit: cover; display: none;" />
                <div id="street-view-no-coverage" style="
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-direction: column;
                    color: #666;
                    font-size: 11px;
                    background: #1a1a1a;
                ">
                    <span style="font-size: 28px; margin-bottom: 6px;">📍</span>
                    <span style="font-size: 12px;">Play to see Street View</span>
                    <span style="font-size: 10px; color: #555;">Updates along path</span>
                </div>
                <div id="street-view-coords" style="
                    position: absolute;
                    bottom: 4px;
                    left: 4px;
                    background: rgba(0,0,0,0.7);
                    color: #888;
                    font-size: 9px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-family: monospace;
                    display: none;
                "></div>
            </div>
            <div style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                <span class="material-icons" style="font-size: 14px; color: #6b7280;">sync</span>
                <span style="font-size: 0.75rem; color: #6b7280;">Synced with path position</span>
            </div>
        </div>
    `;
    
    // Initialize Street View for FCC dashboard
    loadStreetViewConfig();
    
    // Attach event listeners
    attachFCCDemoEventListeners();
}

function attachFCCDemoEventListeners() {
    const progressSlider = document.getElementById('fcc-progress');
    const speedSlider = document.getElementById('fcc-speed');
    const playBtn = document.getElementById('fcc-play-btn');
    const restartBtn = document.getElementById('fcc-restart-btn');
    const video = document.getElementById('fcc-video');
    
    if (progressSlider) {
        progressSlider.addEventListener('input', (e) => {
            const progress = parseFloat(e.target.value) / 100;
            channel.postMessage({
                type: MSG_TYPES.FCC_DEMO_CONTROL,
                action: 'seek',
                value: progress
            });
            // Sync video
            if (video && video.duration) {
                video.currentTime = progress * video.duration;
            }
        });
    }
    
    if (speedSlider) {
        speedSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            document.getElementById('fcc-speed-display').textContent = speed + 'x';
            channel.postMessage({
                type: MSG_TYPES.FCC_DEMO_CONTROL,
                action: 'set_speed',
                value: speed
            });
            // Sync video playback rate
            if (video) {
                video.playbackRate = speed;
            }
        });
    }
    
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (fccDemoState.isPlaying) {
                channel.postMessage({ type: MSG_TYPES.FCC_DEMO_CONTROL, action: 'pause' });
                if (video) video.pause();
            } else {
                channel.postMessage({ type: MSG_TYPES.FCC_DEMO_CONTROL, action: 'play' });
                if (video) video.play();
            }
        });
    }
    
    if (restartBtn) {
        restartBtn.addEventListener('click', () => {
            channel.postMessage({
                type: MSG_TYPES.FCC_DEMO_CONTROL,
                action: 'seek',
                value: 0
            });
            if (video) {
                video.currentTime = 0;
            }
        });
    }
    
    // Get video duration when metadata loads
    if (video) {
        video.addEventListener('loadedmetadata', () => {
            fccDemoState.videoDuration = video.duration;
            channel.postMessage({
                type: MSG_TYPES.FCC_DEMO_CONTROL,
                action: 'set_video_duration',
                value: video.duration
            });
            // Update time display
            const timeDisplay = document.getElementById('fcc-time-display');
            if (timeDisplay) {
                timeDisplay.textContent = `${formatTime(fccDemoState.currentTime)} / ${formatTime(fccDemoState.videoDuration)}`;
            }
        });
    }
}

function updateFCCDemoProgress() {
    const progressSlider = document.getElementById('fcc-progress');
    const progressDisplay = document.getElementById('fcc-progress-display');
    const timeDisplay = document.getElementById('fcc-time-display');
    const video = document.getElementById('fcc-video');
    
    if (progressSlider) {
        progressSlider.value = fccDemoState.progress * 100;
    }
    if (progressDisplay) {
        progressDisplay.textContent = (fccDemoState.progress * 100).toFixed(0) + '%';
    }
    if (timeDisplay) {
        timeDisplay.textContent = `${formatTime(fccDemoState.currentTime)} / ${formatTime(fccDemoState.videoDuration)}`;
    }
    // Sync video position
    if (video && video.duration && !video.seeking) {
        const targetTime = fccDemoState.progress * video.duration;
        // Only update if difference is significant to avoid jitter
        if (Math.abs(video.currentTime - targetTime) > 0.5) {
            video.currentTime = targetTime;
        }
    }
}

function updateFCCDemoPlayButton() {
    const playBtn = document.getElementById('fcc-play-btn');
    const video = document.getElementById('fcc-video');
    
    if (playBtn) {
        playBtn.innerHTML = `
            <span class="material-icons">${fccDemoState.isPlaying ? 'pause' : 'play_arrow'}</span>
            ${fccDemoState.isPlaying ? 'Pause' : 'Play'}
        `;
    }
    
    // Sync video playback state
    if (video) {
        if (fccDemoState.isPlaying && video.paused) {
            video.play();
        } else if (!fccDemoState.isPlaying && !video.paused) {
            video.pause();
        }
    }
}

function updateFCCDemoStats() {
    const stats = fccDemoState.stats;
    if (!stats) return;
    
    const totalRays = stats.totalRays || 1;
    const openPercent = ((stats.openRays / totalRays) * 100).toFixed(1);
    const treePercent = ((stats.treeRays / totalRays) * 100).toFixed(1);
    const buildingPercent = ((stats.buildingRays / totalRays) * 100).toFixed(1);
    
    const openEl = document.getElementById('fcc-stat-open');
    const treesEl = document.getElementById('fcc-stat-trees');
    const buildingsEl = document.getElementById('fcc-stat-buildings');
    
    if (openEl) openEl.textContent = openPercent + '%';
    if (treesEl) treesEl.textContent = treePercent + '%';
    if (buildingsEl) buildingsEl.textContent = buildingPercent + '%';
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds === null) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}
