// Controller logic for the secondary screen
// ============================================

// Message type constants - keep in sync with main.js and animation modules
const MSG_TYPES = {
    // Outgoing (controller -> main)
    CONTROL_ACTION: 'control_action',
    RESET_VIEW: 'reset_view',
    CALIBRATE_ACTION: 'calibrate_action',
    SUN_CONTROL: 'sun_control',
    CFD_CONTROL: 'cfd_control',
    ISOVIST_CONTROL: 'isovist_control',
    BIRD_CONTROL: 'bird_control',
    SLIDESHOW_CONTROL: 'slideshow_control',
    FCC_DEMO_CONTROL: 'fcc_demo_control',
    // Incoming (main -> controller)
    STATE_UPDATE: 'state_update',
    ANIMATION_STATE: 'animation_state',  // New: animation on/off state
    SLIDESHOW_UPDATE: 'slideshow_update',
    SLIDESHOW_LEGEND_HIGHLIGHT: 'slideshow_legend_highlight',
    BIRD_STATUS: 'bird_status',
    SUN_POSITION: 'sun_position',
    SUN_TIME_UPDATE: 'sun_time_update',
    CALIBRATION_DATA: 'calibration_data',
    FCC_DEMO_PROGRESS: 'fcc_demo_progress',
    FCC_DEMO_READY: 'fcc_demo_ready',
    FCC_DEMO_STATS: 'fcc_demo_stats',
    FCC_DEMO_PLAYBACK_STATE: 'fcc_demo_playback_state'
};

// Debug mode - set to false in production
const DEBUG_MODE = false;
function debugLog(...args) {
    if (DEBUG_MODE) console.log('[Controller]', ...args);
}

const channel = new BroadcastChannel('map_controller_channel');
const statusIndicator = document.getElementById('connection-status');
const statusText = document.getElementById('connection-text');
const welcomeScreen = document.getElementById('welcome-screen');

// Slideshow state tracking (declared early as it's used by updateDashboard)
let slideshowState = {
    isActive: false,
    currentIndex: 0,
    totalSlides: 0,
    metadata: null,
    slideType: null
};

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

// Animation layer tracking - tracks active animations and their order
// Animation buttons are buttons that toggle visualizations on/off
const ANIMATION_BUTTONS = [
    'cfd-simulation-btn',
    'stormwater-btn', 
    'sun-study-btn',
    'slideshow-btn',
    'grid-animation-btn',
    'isovist-btn',
    'bird-sounds-btn',
    'fcc-demo-btn',
    'street-view-btn'
];

// Function buttons are buttons that perform actions (not toggleable animations)
const FUNCTION_BUTTONS = [
    'reset-view-btn',
    'fullscreen-btn',
    'calibrate-btn',
    'credits-btn'
];

// Track active animations in order they were activated
let activeAnimations = [];

function isAnimationButton(targetId) {
    return ANIMATION_BUTTONS.includes(targetId);
}

// Called when we receive actual state from the main window
function setAnimationState(targetId, isActive) {
    if (isActive) {
        if (!activeAnimations.includes(targetId)) {
            activeAnimations.push(targetId);
        }
    } else {
        activeAnimations = activeAnimations.filter(id => id !== targetId);
    }
    syncAnimationButtonStates();
}

function syncAnimationButtonStates() {
    // Remove all existing badges first
    document.querySelectorAll('.animation-order-badge').forEach(badge => badge.remove());
    
    // Update each animation button's active state and badge
    ANIMATION_BUTTONS.forEach(targetId => {
        const btn = document.querySelector(`[data-target="${targetId}"]`);
        if (!btn) return;
        
        const isActive = activeAnimations.includes(targetId);
        const orderIndex = activeAnimations.indexOf(targetId);
        
        // Set or remove active class based on tracking
        if (isActive) {
            btn.classList.add('active');
            
            // Only show order badge if multiple animations are active
            if (activeAnimations.length > 1) {
                const badge = document.createElement('span');
                badge.className = 'animation-order-badge';
                badge.textContent = orderIndex + 1;
                btn.appendChild(badge);
            }
        } else {
            btn.classList.remove('active');
        }
    });
}

// Update connection status
// Since BroadcastChannel doesn't have a direct "connected" event for peers, 
// we'll assume connected if we can send, but we can implement a ping/pong if needed.
// For now, we'll just show it as active.
statusIndicator.classList.add('connected');
statusText.textContent = 'Connected';

// Function to show welcome screen
function showWelcome() {
    welcomeScreen.classList.remove('hidden');
    // Clear all animation tracking and sync button states
    activeAnimations = [];
    syncAnimationButtonStates();
    // Also clear function button selections
    document.querySelectorAll('.control-btn.function-btn').forEach(b => b.classList.remove('selected'));
    startTour();
}

// Make header title clickable to go home
const headerTitle = document.querySelector('header h1');
headerTitle.style.cursor = 'pointer';
headerTitle.title = 'Click to return to Welcome Screen';
headerTitle.addEventListener('click', showWelcome);

// Home button
document.getElementById('home-btn').addEventListener('click', showWelcome);

// Handle button clicks
document.querySelectorAll('.control-btn[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
        stopTour();
        const targetId = btn.dataset.target;
        const action = btn.dataset.action;
        
        // Send message to main window - the main window will respond with actual state
        channel.postMessage({
            type: MSG_TYPES.CONTROL_ACTION,
            target: targetId,
            action: action
        });

        // For function buttons, mark as selected for dashboard display
        if (!isAnimationButton(targetId)) {
            document.querySelectorAll('.control-btn.function-btn').forEach(b => {
                b.classList.remove('selected');
            });
            btn.classList.add('selected');
        }
        
        // Always update metadata and dashboard when a button is clicked
        updateMetadata(targetId);
        updateDashboard(targetId);

        // Request immediate status update for dynamic layers
        if (targetId === 'bird-sounds-btn') {
            channel.postMessage({ type: MSG_TYPES.BIRD_CONTROL, action: 'request_status' });
        } else if (targetId === 'slideshow-btn') {
            channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'request_status' });
        }
    });
});

function updateDashboard(targetId) {
    const dashboardContent = document.getElementById('dashboard-content');
    const legendContent = document.getElementById('legend-content');
    const dashboardTitle = document.getElementById('dashboard-title');
    const legendTitle = document.getElementById('legend-title');

    // Reset titles by default
    if (dashboardTitle) dashboardTitle.textContent = 'Dashboard';
    if (legendTitle) legendTitle.textContent = 'Legend';
    
    // Use dedicated slideshow dashboard function for slideshow
    if (targetId === 'slideshow-btn') {
        // If we already know the slideshow is active, show the dashboard immediately
        // This prevents overwriting the active state with "Loading..." if the state update
        // arrives before this function is called (race condition).
        if (slideshowState.isActive) {
            updateSlideshowDashboard();
            return;
        }

        // Optimistically show loading state
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">slideshow</span>
                        Slideshow
                    </div>
                    <div class="info-box" style="border-left-color: #8b5cf6;">
                        <div class="info-title">Loading...</div>
                        <p class="info-text">
                            Starting slideshow and loading media...
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <p style="color: #6b7280; font-size: 0.9rem;">Loading legend...</p>
            </div>
        `;
        
        return;
    }

    if (targetId === 'credits-btn') {
        if (dashboardTitle) dashboardTitle.textContent = 'Project Team';
        if (legendTitle) legendTitle.textContent = 'About';

        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">Contributors</div>
                    <div class="credits-grid">
                        <div class="credit-item">
                            <div class="credit-role">Principle Investigator</div>
                            <div class="credit-name">Alexander Hollberg</div>
                        </div>
                        <div class="credit-item">
                            <div class="credit-role">Development Lead</div>
                            <div class="credit-name">Sanjay Somanath</div>
                        </div>
                        <div class="credit-item">
                            <div class="credit-role">Model Design, Prototyping & Printing</div>
                            <div class="credit-name">Arvid Hall</div>
                        </div>
                        
                        <div class="credit-item">
                            <div class="credit-role">Digital Twin Cities Center</div>
                            <div class="credit-name">Anders Logg, Vasilis Nasarentin</div>
                            <div class="credit-contribution">Funding and Resources</div>
                        </div>

                        <div class="credit-item">
                            <div class="credit-role">A-Verkstad</div>
                            <div class="credit-name">Jarkko Nordlund</div>
                            <div class="credit-contribution">3D Printing expertise & facilities</div>
                        </div>

                        <div class="credit-item">
                            <div class="credit-role">Infravis</div>
                            <div class="credit-name">Fabio Latino</div>
                            <div class="credit-contribution">Funding and Resources</div>
                        </div>

                        <div class="credit-item">
                            <div class="credit-role">Detailed 3D Model</div>
                            <div class="credit-name">Sara Abouebeid</div>
                        </div>

                        <div class="credit-item">
                            <div class="credit-role">CFD Simulation</div>
                            <div class="credit-name">Franziska Hunger</div>
                        </div>

                        <div class="credit-item">
                            <div class="credit-role">Office Coordinator</div>
                            <div class="credit-name">Elisabeth Meyer</div>
                            <div class="credit-contribution">Physical Location Support</div>
                        </div>

                        <div class="credit-item">
                            <div class="credit-role">Data Sources</div>
                            <div class="credit-name">Lantmäteriet, Trafikverket</div>
                        </div>
                    </div>
                </div>
                <div class="dashboard-card">
                    <div class="dashboard-section-title">Metadata</div>
                    <div class="metadata-item">
                        <div class="metadata-label">Current View</div>
                        <div class="metadata-value">Credits</div>
                    </div>
                    <div class="metadata-item">
                        <div class="metadata-label">Active Layer</div>
                        <div class="metadata-value">None</div>
                    </div>
                    <div class="metadata-item">
                        <div class="metadata-label">Description</div>
                        <div class="metadata-value">Project team and contributors information.</div>
                    </div>
                </div>
            </div>
        `;

        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">About the Project</div>
                <p class="info-text" style="margin-bottom: 1rem;">
                    The <strong>ACE MR Studio</strong> is an interactive platform designed to bridge the gap between complex urban data and stakeholder engagement.
                </p>
                <p class="info-text">
                    We want this space to be a place to test and ask questions about complex data communication and also inspire a new form of data story telling and research.
                </p>
                <div style="margin-top: 1.5rem; display: flex; justify-content: center; align-items: center;">
                    <img src="media/chalmers_logo.png" style="height: 40px; margin-right: 20px; opacity: 0.8;">
                    <img src="media/dtcc_logo.png" style="height: 70px; opacity: 0.8;">
                </div>
            </div>
            <div class="dashboard-card">
                <div class="dashboard-section-title">Take Our Survey</div>
                <p class="info-text" style="margin-bottom: 1rem;">
                    Help us improve! Scan the QR code to share your feedback.
                </p>
                <div style="display: flex; justify-content: center; align-items: center;">
                    <img src="media/survey_qr.png" style="width: 300px; height: 300px; border-radius: 8px;">
                </div>
            </div>
        `;
        return;
    }

    if (targetId === 'calibrate-btn') {
        if (dashboardTitle) dashboardTitle.textContent = 'Calibration Controls';
        if (legendTitle) legendTitle.textContent = 'Instructions';

        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">camera</span>
                        Auto-Calibration
                    </div>
                    
                    <div class="control-row">
                        <span class="control-label">Camera</span>
                        <select id="ctrl-camera-select" class="modern-date" style="width: 150px;">
                            <option value="">Select camera...</option>
                        </select>
                    </div>
                    
                    <div id="camera-preview-container" style="width: 100%; aspect-ratio: 16/9; background: #1a1a1a; border-radius: 8px; margin: 0.75rem 0; overflow: hidden; position: relative;">
                        <canvas id="camera-preview" style="width: 100%; height: 100%; object-fit: contain;"></canvas>
                        <div id="camera-status" style="position: absolute; bottom: 8px; left: 8px; background: rgba(0,0,0,0.7); color: #888; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem;">No camera selected</div>
                    </div>
                    
                    <div class="action-grid">
                        <button id="ctrl-start-auto-calibrate" class="modern-btn primary">
                            <span class="material-icons" style="font-size: 16px;">auto_fix_high</span>
                            Start Auto-Calibrate
                        </button>
                        <button id="ctrl-stop-auto-calibrate" class="modern-btn" disabled>
                            <span class="material-icons" style="font-size: 16px;">stop</span>
                            Stop
                        </button>
                    </div>
                    
                    <div id="calibration-progress" style="margin-top: 0.75rem; padding: 0.5rem; background: #1a1a1a; border-radius: 6px; display: none;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
                            <span id="calibration-phase">Initializing...</span>
                            <span id="calibration-iteration">0/15</span>
                        </div>
                        <div style="height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
                            <div id="calibration-progress-bar" style="height: 100%; width: 0%; background: #4ade80; transition: width 0.3s;"></div>
                        </div>
                    </div>
                </div>

                <div class="dashboard-card">
                    <div class="dashboard-section-title">Manual Calibration</div>
                    
                    <div class="control-row">
                        <span class="control-label">Screen Width (cm)</span>
                        <input type="number" id="ctrl-screen-w" class="modern-date" value="111.93" step="0.1" style="width: 80px;">
                    </div>
                    <div class="control-row">
                        <span class="control-label">Screen Height (cm)</span>
                        <input type="number" id="ctrl-screen-h" class="modern-date" value="62.96" step="0.1" style="width: 80px;">
                    </div>
                    <div class="control-row">
                        <span class="control-label">Table Width (cm)</span>
                        <input type="number" id="ctrl-table-w" class="modern-date" value="100" step="0.1" style="width: 80px;">
                    </div>
                    <div class="control-row">
                        <span class="control-label">Table Height (cm)</span>
                        <input type="number" id="ctrl-table-h" class="modern-date" value="60" step="0.1" style="width: 80px;">
                    </div>

                    <div class="action-grid">
                        <button id="ctrl-show-overlay" class="modern-btn">Show Overlay</button>
                        <button id="ctrl-hide-overlay" class="modern-btn">Hide Overlay</button>
                    </div>
                    
                    <div style="margin-top: 1rem;">
                        <button id="ctrl-calibrate-fit" class="modern-btn primary" style="width: 100%;">Copy Current Calibration</button>
                    </div>
                </div>

                <div class="dashboard-card">
                    <div class="dashboard-section-title">Map Adjustment</div>
                    <div class="action-grid" style="grid-template-columns: repeat(3, 1fr);">
                        <button id="ctrl-rotate-left" class="modern-btn"><span class="material-icons">rotate_left</span></button>
                        <button id="ctrl-reset-rotation" class="modern-btn">Reset</button>
                        <button id="ctrl-rotate-right" class="modern-btn"><span class="material-icons">rotate_right</span></button>
                    </div>
                    <div class="action-grid">
                        <button id="ctrl-zoom-in" class="modern-btn"><span class="material-icons">add</span> Zoom</button>
                        <button id="ctrl-zoom-out" class="modern-btn"><span class="material-icons">remove</span> Zoom</button>
                    </div>
                    <div style="margin-top: 1rem;">
                        <button id="ctrl-lock-center" class="modern-btn" style="width: 100%;">Lock Center</button>
                    </div>
                    <div style="margin-top: 0.5rem;">
                        <button id="ctrl-toggle-table-markers" class="modern-btn" style="width: 100%;">Toggle Table Markers</button>
                    </div>
                </div>
            </div>
        `;
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Auto-Calibration</div>
                <p class="info-text">
                    1. Position a camera to view the entire table<br>
                    2. Select the camera from the dropdown<br>
                    3. Click "Start Auto-Calibrate"<br>
                    4. The system will detect projected markers and automatically adjust zoom/rotation<br>
                    5. Wait for convergence or click Stop
                </p>
            </div>
            <div class="dashboard-card">
                <div class="dashboard-section-title">Manual Calibration</div>
                <p class="info-text">
                    1. Measure your physical screen dimensions<br>
                    2. Measure your physical table dimensions<br>
                    3. Enter values in the settings<br>
                    4. Click "Show Overlay" to see the target area<br>
                    5. Adjust map zoom/rotation to fit<br>
                    6. Click "Copy Current Calibration" to save
                </p>
            </div>
        `;

        // Initialize auto-calibrator
        initAutoCalibrator();

        // Add event listeners for manual calibration
        document.getElementById('ctrl-show-overlay').addEventListener('click', () => {
            const sw = document.getElementById('ctrl-screen-w').value;
            const sh = document.getElementById('ctrl-screen-h').value;
            const tw = document.getElementById('ctrl-table-w').value;
            const th = document.getElementById('ctrl-table-h').value;
            channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'show_overlay', params: { sw, sh, tw, th } });
        });
        
        document.getElementById('ctrl-hide-overlay').addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'hide_overlay' });
        });

        document.getElementById('ctrl-calibrate-fit').addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'copy_calibration' });
        });

        document.getElementById('ctrl-zoom-in').addEventListener('click', () => channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'zoom_in' }));
        document.getElementById('ctrl-zoom-out').addEventListener('click', () => channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'zoom_out' }));
        document.getElementById('ctrl-rotate-left').addEventListener('click', () => channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'rotate_left' }));
        document.getElementById('ctrl-rotate-right').addEventListener('click', () => channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'rotate_right' }));
        document.getElementById('ctrl-reset-rotation').addEventListener('click', () => channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'reset_rotation' }));
        
        const lockBtn = document.getElementById('ctrl-lock-center');
        lockBtn.addEventListener('click', () => {
            lockBtn.classList.toggle('active');
            channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'lock_center', value: lockBtn.classList.contains('active') });
        });

        const toggleTableMarkersBtn = document.getElementById('ctrl-toggle-table-markers');
        toggleTableMarkersBtn.addEventListener('click', () => {
            toggleTableMarkersBtn.classList.toggle('active');
            channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'toggle_table_markers', value: toggleTableMarkersBtn.classList.contains('active') });
        });

        return;
    }
    
    if (targetId === 'stormwater-btn') {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">info</span>
                        Simulation Info
                    </div>
                    <div class="info-box" style="margin-bottom: 1rem; border-left-color: #0ea5e9;">
                        <div class="info-title">Methodology</div>
                        <p class="info-text">
                            Uses a <strong>D8 Flow Direction</strong> algorithm on a Digital Elevation Model (DEM). 
                            Calculates steepest descent for each cell and computes <strong>Flow Accumulation</strong>.
                            Particles spawn in high-accumulation zones to visualize drainage paths.
                        </p>
                    </div>
                    <div class="info-box" style="border-left-color: #0ea5e9;">
                        <div class="info-title">Real-world Application</div>
                        <p class="info-text">
                            Critical for <strong>urban planning</strong> and <strong>flood risk assessment</strong>. 
                            Identifies natural drainage paths and potential pooling zones to inform infrastructure design 
                            and avoid flood-prone construction.
                        </p>
                    </div>
                </div>
            </div>
        `;
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    <div class="legend-item">
                        <div class="legend-color" style="background: linear-gradient(to right, #00f, #0ff);"></div>
                        <span class="legend-label">Flow Intensity</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: rgba(0, 100, 255, 0.5); border-radius: 50%;"></div>
                        <span class="legend-label">Accumulation Pools</span>
                    </div>
                </div>
            </div>
        `;
    } else if (targetId === 'sun-study-btn') {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">tune</span>
                        Controls
                    </div>
                    
                    <div class="control-row">
                        <label class="control-label">Date</label>
                        <input type="date" id="sun-date" class="modern-date" value="${new Date().toISOString().split('T')[0]}">
                    </div>

                    <div class="control-row">
                        <label class="control-label">Time</label>
                        <input type="range" id="sun-time" class="modern-range" min="0" max="24" step="0.25" value="12">
                        <span id="time-display" class="control-value">12:00</span>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Shadow Opacity</label>
                        <input type="range" id="shadow-opacity" class="modern-range" min="0.1" max="1.0" step="0.1" value="0.8">
                    </div>

                    <div class="control-row">
                        <label class="control-label">Animation Speed</label>
                        <input type="range" id="sun-speed" class="modern-range" min="0.5" max="5" step="0.5" value="2">
                        <span id="speed-display" class="control-value">2x</span>
                    </div>

                    <div class="action-grid">
                        <button id="sun-animate-btn" class="modern-btn primary">
                            <span class="material-icons">play_arrow</span> Animate Day
                        </button>
                        <button id="false-color-btn" class="modern-btn">
                            <span class="material-icons">palette</span> False Color
                        </button>
                        <button id="toggle-trees-btn" class="modern-btn" style="grid-column: span 2;">
                            <span class="material-icons">park</span> Toggle Trees
                        </button>
                    </div>
                </div>

                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">analytics</span>
                        Analysis Data
                    </div>
                    <div class="control-row">
                        <span class="control-label">Sun Altitude</span>
                        <span id="altitude-display" class="control-value">--</span>
                    </div>
                    <div class="control-row">
                        <span class="control-label">Sun Azimuth</span>
                        <span id="azimuth-display" class="control-value">--</span>
                    </div>
                    <div class="control-row">
                        <span class="control-label">Trees Layer</span>
                        <span id="trees-status-display" class="control-value">Off</span>
                    </div>
                </div>

                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">school</span>
                        Educational Context
                    </div>
                    <div class="info-box" style="margin-bottom: 1rem;">
                        <div class="info-title">Methodology</div>
                        <p class="info-text">
                            Renders accurate shadows using <strong>Three.js</strong> based on astronomical calculations for Gothenburg's latitude. 
                            Uses <strong>SSAO</strong> (Screen Space Ambient Occlusion) for depth perception.
                        </p>
                    </div>
                    <div class="info-box">
                        <div class="info-title">Application</div>
                        <p class="info-text">
                            Used by architects to optimize <strong>natural light</strong>, design energy-efficient buildings, 
                            and ensure public spaces receive adequate sunlight (solar access analysis).
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    <div class="legend-item">
                        <div class="legend-color" style="background: rgba(0,0,0,0.5);"></div>
                        <span class="legend-label">Shadow Cast</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: linear-gradient(to right, #f5d866, #ff6626, #f23319);"></div>
                        <span class="legend-label">Sun Exposure (False Color)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #26409a;"></div>
                        <span class="legend-label">Building/Terrain Shadow</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #268040;"></div>
                        <span class="legend-label">Tree Shadow Only</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #8c268c;"></div>
                        <span class="legend-label">Combined Shadow</span>
                    </div>
                </div>
            </div>
        `;

        // Attach event listeners for Sun Study controls
        const dateInput = document.getElementById('sun-date');
        const timeInput = document.getElementById('sun-time');
        const timeDisplay = document.getElementById('time-display');
        const opacityInput = document.getElementById('shadow-opacity');
        const animateBtn = document.getElementById('sun-animate-btn');
        const speedInput = document.getElementById('sun-speed');
        const speedDisplay = document.getElementById('speed-display');
        const falseColorBtn = document.getElementById('false-color-btn');

        const sendControl = (action, value) => {
            channel.postMessage({
                type: MSG_TYPES.SUN_CONTROL,
                action: action,
                value: value
            });
        };

        dateInput.addEventListener('change', (e) => sendControl('set_date', e.target.value));
        
        timeInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const h = Math.floor(val);
            const m = Math.floor((val - h) * 60);
            timeDisplay.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
            sendControl('set_time', val);
        });

        opacityInput.addEventListener('input', (e) => sendControl('set_opacity', e.target.value));
        
        animateBtn.addEventListener('click', () => {
            animateBtn.classList.toggle('active');
            const isActive = animateBtn.classList.contains('active');
            animateBtn.innerHTML = isActive 
                ? '<span class="material-icons">pause</span> Pause' 
                : '<span class="material-icons">play_arrow</span> Animate Day';
            sendControl('toggle_animation');
        });

        speedInput.addEventListener('input', (e) => {
            speedDisplay.textContent = e.target.value + 'x';
            sendControl('set_speed', e.target.value);
        });

        falseColorBtn.addEventListener('click', () => {
            falseColorBtn.classList.toggle('active');
            sendControl('toggle_false_color');
        });

        const toggleTreesBtn = document.getElementById('toggle-trees-btn');
        if (toggleTreesBtn) {
            toggleTreesBtn.addEventListener('click', () => {
                toggleTreesBtn.classList.toggle('active');
                sendControl('toggle_trees');
            });
        }

    } else if (targetId === 'cfd-simulation-btn') {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">tune</span>
                        Wind Controls
                    </div>
                    
                    <div class="control-row">
                        <label class="control-label">Wind Speed</label>
                        <input type="range" id="wind-speed" class="modern-range" min="1" max="20" step="0.5" value="5">
                        <span id="wind-speed-display" class="control-value">5.0 m/s</span>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Direction</label>
                        <input type="range" id="wind-direction" class="modern-range" min="0" max="360" step="15" value="0">
                        <span id="wind-dir-display" class="control-value">0°</span>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Particles</label>
                        <select id="particle-count" class="modern-date" style="width: 100px;">
                            <option value="300">Low</option>
                            <option value="800" selected>Medium</option>
                            <option value="1500">High</option>
                        </select>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Particle Speed</label>
                        <input type="range" id="particle-speed" class="modern-range" min="2" max="40" step="2" value="20">
                        <span id="particle-speed-display" class="control-value">20x</span>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Viscosity</label>
                        <input type="range" id="viscosity" class="modern-range" min="0" max="1" step="0.1" value="0.5">
                    </div>

                    <div class="control-row">
                        <label class="control-label">Grid Resolution</label>
                        <select id="grid-resolution" class="modern-date" style="width: 100px;">
                            <option value="100">100 (Fast)</option>
                            <option value="150">150</option>
                            <option value="200" selected>200 (Normal)</option>
                            <option value="250">250</option>
                            <option value="300">300 (High)</option>
                        </select>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Include Trees</label>
                        <button id="toggle-trees-btn" class="modern-date" style="width: 100px; cursor: pointer; background: #2D5A27; border: 1px solid #4a9441;">
                            <span class="material-icons" style="font-size: 14px; vertical-align: middle;">park</span>
                            <span id="trees-status">On</span>
                        </button>
                    </div>
                </div>

                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">school</span>
                        Educational Context
                    </div>
                    <div class="info-box" style="margin-bottom: 1rem; border-left-color: #10b981;">
                        <div class="info-title">Methodology</div>
                        <p class="info-text">
                            Uses the <strong>Lattice Boltzmann Method (LBM)</strong>, a powerful CFD technique that simulates fluid dynamics by tracking particle distributions on a grid (D2Q9 lattice). It solves the Navier-Stokes equations in real-time.
                        </p>
                    </div>
                    <div class="info-box" style="border-left-color: #10b981;">
                        <div class="info-title">Application</div>
                        <p class="info-text">
                            Essential for <strong>wind comfort analysis</strong> in urban design. Helps architects ensure pedestrian safety, plan natural ventilation corridors, and mitigate dangerous wind tunnel effects around tall buildings.
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <div style="display: flex; flex-direction: column; gap: 1rem;">
                    
                    <div>
                        <div class="legend-label" style="margin-bottom: 0.5rem;">Wind Velocity Scale</div>
                        <div style="height: 12px; background: linear-gradient(to right, #3b82f6, #10b981, #ef4444); border-radius: 6px; margin-bottom: 0.25rem;"></div>
                        <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: #6b7280;">
                            <span>0 m/s</span>
                            <span>Moderate</span>
                            <span>High</span>
                        </div>
                    </div>

                    <div class="legend-item">
                        <div class="legend-color" style="background: #1f2937;"></div>
                        <div>
                            <span class="legend-label">Building Obstacles</span>
                            <div style="font-size: 0.75rem; color: #6b7280;">Impermeable boundaries</div>
                        </div>
                    </div>

                    <div class="legend-item">
                        <div class="legend-color" style="background: #2D5A27; border: 1px dashed #4a9441;"></div>
                        <div>
                            <span class="legend-label">Tree Canopies</span>
                            <div style="font-size: 0.75rem; color: #6b7280;">Permeable obstacles (~60% flow)</div>
                        </div>
                    </div>

                    <div class="legend-item">
                        <div class="legend-color" style="background: rgba(255,255,255,0.5); border: 1px dashed #9ca3af;"></div>
                        <div>
                            <span class="legend-label">Airflow Particles</span>
                            <div style="font-size: 0.75rem; color: #6b7280;">Tracers visualizing flow path</div>
                        </div>
                    </div>

                    <div style="border-top: 1px solid #e5e7eb; padding-top: 0.5rem; margin-top: 0.5rem;">
                        <div style="font-size: 0.8rem; color: #6b7280; display: flex; justify-content: space-between;">
                            <span>Domain Width:</span>
                            <span style="font-family: monospace;">~500m</span>
                        </div>
                        <div style="font-size: 0.8rem; color: #6b7280; display: flex; justify-content: space-between;">
                            <span>Simulation Method:</span>
                            <span style="font-family: monospace;">LBM D2Q9</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Attach event listeners
        const windSpeed = document.getElementById('wind-speed');
        const windSpeedDisplay = document.getElementById('wind-speed-display');
        const windDir = document.getElementById('wind-direction');
        const windDirDisplay = document.getElementById('wind-dir-display');
        const particleCount = document.getElementById('particle-count');
        const particleSpeed = document.getElementById('particle-speed');
        const particleSpeedDisplay = document.getElementById('particle-speed-display');
        const viscosity = document.getElementById('viscosity');
        const gridResolution = document.getElementById('grid-resolution');

        const sendCfdControl = (action, value) => {
            channel.postMessage({
                type: MSG_TYPES.CFD_CONTROL,
                action: action,
                value: value
            });
        };

        windSpeed.addEventListener('input', (e) => {
            windSpeedDisplay.textContent = parseFloat(e.target.value).toFixed(1) + ' m/s';
            sendCfdControl('set_wind_speed', e.target.value);
        });

        windDir.addEventListener('input', (e) => {
            windDirDisplay.textContent = e.target.value + '°';
            sendCfdControl('set_wind_direction', e.target.value);
        });

        particleCount.addEventListener('change', (e) => {
            sendCfdControl('set_particles', e.target.value);
        });

        particleSpeed.addEventListener('input', (e) => {
            particleSpeedDisplay.textContent = e.target.value + 'x';
            sendCfdControl('set_particle_speed', e.target.value);
        });

        viscosity.addEventListener('input', (e) => {
            sendCfdControl('set_viscosity', e.target.value);
        });

        gridResolution.addEventListener('change', (e) => {
            sendCfdControl('set_resolution', e.target.value);
        });

        // Tree toggle button
        const toggleTreesBtn = document.getElementById('toggle-trees-btn');
        const treesStatus = document.getElementById('trees-status');
        let treesEnabled = true;
        
        toggleTreesBtn.addEventListener('click', () => {
            treesEnabled = !treesEnabled;
            treesStatus.textContent = treesEnabled ? 'On' : 'Off';
            toggleTreesBtn.style.background = treesEnabled ? '#2D5A27' : '#333';
            toggleTreesBtn.style.borderColor = treesEnabled ? '#4a9441' : '#555';
            sendCfdControl('toggle_trees', treesEnabled);
        });

    } else if (targetId === 'isovist-btn') {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card" style="padding: 0; overflow: hidden;">
                    <div style="padding: 0.75rem 1rem 0.5rem; border-bottom: 1px solid #333;">
                        <div class="dashboard-section-title" style="margin: 0;">
                            <span class="material-icons" style="font-size: 18px;">streetview</span>
                            Street View (Live)
                        </div>
                    </div>
                    <div id="street-view-panel" style="width: 100%; height: 200px; background: #1a1a1a; position: relative;">
                        <img id="street-view-image" style="width: 100%; height: 100%; object-fit: cover; display: none;" />
                        <div id="street-view-no-coverage" style="
                            position: absolute;
                            top: 0; left: 0; right: 0; bottom: 0;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            flex-direction: column;
                            color: #666;
                            font-size: 12px;
                            background: #1a1a1a;
                        ">
                            <span style="font-size: 32px; margin-bottom: 8px;">📍</span>
                            <span style="font-size: 13px;">Place viewer on map</span>
                            <span style="font-size: 10px; color: #555;">Street View updates as you move</span>
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
                            display: none;
                        "></div>
                    </div>
                </div>
                
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">visibility</span>
                        Isovist Controls
                    </div>
                    
                    <div class="control-row">
                        <label class="control-label">View Radius</label>
                        <input type="range" id="isovist-radius" class="modern-range" min="50" max="500" step="10" value="200">
                        <span id="radius-display" class="control-value">200m</span>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Field of View</label>
                        <input type="range" id="isovist-fov" class="modern-range" min="30" max="180" step="5" value="120">
                        <span id="fov-display" class="control-value">120°</span>
                    </div>

                    <div class="action-grid">
                        <button id="toggle-360-btn" class="modern-btn">
                            <span class="material-icons">360</span> Toggle 360°
                        </button>
                        <button id="toggle-follow-btn" class="modern-btn active">
                            <span class="material-icons">mouse</span> Follow Cursor
                        </button>
                    </div>
                </div>

                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">school</span>
                        Educational Context
                    </div>
                    <div class="info-box" style="margin-bottom: 0.75rem; border-left-color: #2D5A27;">
                        <div class="info-title">Green View Index (GVI)</div>
                        <p class="info-text">
                            Measures the <strong>percentage of vegetation visible</strong> from a viewpoint. 
                            Higher GVF (≥30%) is linked to reduced stress and better thermal comfort.
                        </p>
                    </div>
                    <div class="info-box" style="border-left-color: #eab308;">
                        <div class="info-title">Isovist Analysis</div>
                        <p class="info-text">
                            Calculates <strong>visibility polygons</strong> by casting rays until they hit obstacles.
                            Used in urban design and CPTED analysis.
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        // Initialize Street View for isovist dashboard
        loadStreetViewConfig();
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Live Visibility</div>
                <div id="isovist-stats-container">
                    <div style="text-align: center; color: #888; padding: 1rem; font-size: 11px;">Place viewer on map...</div>
                </div>
            </div>
            <div class="dashboard-card" style="margin-top: 0.75rem;">
                <div class="dashboard-section-title">Map Legend</div>
                <div style="display: flex; flex-wrap: wrap; gap: 0.4rem 0.8rem; font-size: 10px;">
                    <div class="legend-item" style="margin: 0;">
                        <div class="legend-color" style="width: 14px; height: 14px; background: rgba(255, 255, 0, 0.3); border: 1px solid #eab308;"></div>
                        <span class="legend-label">Visible</span>
                    </div>
                    <div class="legend-item" style="margin: 0;">
                        <div class="legend-color" style="width: 10px; height: 10px; border-radius: 50%; background: #ff0000; border: 2px solid white;"></div>
                        <span class="legend-label">Viewer</span>
                    </div>
                    <div class="legend-item" style="margin: 0;">
                        <div class="legend-color" style="width: 14px; height: 2px; background: #ff0000;"></div>
                        <span class="legend-label">Direction</span>
                    </div>
                </div>
            </div>
        `;

        // Clear history when switching to isovist
        isovistHistory.data = [];
        isovistHistory.gvfHistory = [];

        // Attach event listeners
        const radiusInput = document.getElementById('isovist-radius');
        const radiusDisplay = document.getElementById('radius-display');
        const fovInput = document.getElementById('isovist-fov');
        const fovDisplay = document.getElementById('fov-display');
        const toggle360Btn = document.getElementById('toggle-360-btn');
        const toggleFollowBtn = document.getElementById('toggle-follow-btn');

        const sendIsovistControl = (action, value) => {
            channel.postMessage({
                type: MSG_TYPES.ISOVIST_CONTROL,
                action: action,
                value: value
            });
        };

        radiusInput.addEventListener('input', (e) => {
            radiusDisplay.textContent = e.target.value + 'm';
            sendIsovistControl('set_radius', e.target.value);
        });

        fovInput.addEventListener('input', (e) => {
            fovDisplay.textContent = e.target.value + '°';
            sendIsovistControl('set_fov', e.target.value);
        });

        toggle360Btn.addEventListener('click', () => {
            toggle360Btn.classList.toggle('active');
            sendIsovistControl('toggle_360');
            // Disable FOV slider if 360 is active
            if (toggle360Btn.classList.contains('active')) {
                fovInput.disabled = true;
                fovInput.parentElement.style.opacity = '0.5';
            } else {
                fovInput.disabled = false;
                fovInput.parentElement.style.opacity = '1';
            }
        });

        toggleFollowBtn.addEventListener('click', () => {
            toggleFollowBtn.classList.toggle('active');
            sendIsovistControl('toggle_follow');
        });

    } else if (targetId === 'grid-animation-btn') {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">info</span>
                        System Info
                    </div>
                    <div class="info-box" style="margin-bottom: 1rem; border-left-color: #00ffff;">
                        <div class="info-title">Physical Digital Twin</div>
                        <p class="info-text">
                            This grid projection aligns perfectly with the <strong>physical 3D printed tiles</strong> on the table. 
                            It serves as a calibration layer to ensure the digital projection matches the physical model boundaries.
                        </p>
                    </div>
                    <div class="info-box" style="border-left-color: #00ffff;">
                        <div class="info-title">Grid Structure</div>
                        <p class="info-text">
                            The table is divided into a <strong>5x3 grid</strong> of 20x20cm tiles. 
                            Each cell represents a modular section of the city model, allowing for swappable districts.
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    <div class="legend-item">
                        <div class="legend-color" style="border: 2px solid #00ffff; background: rgba(0, 255, 255, 0.1);"></div>
                        <span class="legend-label">Tile Boundary</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="width: 12px; height: 12px; border-radius: 50%; background: #00ffff; box-shadow: 0 0 5px #00ffff; margin: 6px;"></div>
                        <span class="legend-label">Calibration Node</span>
                    </div>
                </div>
            </div>
        `;

    } else if (targetId === 'bird-sounds-btn') {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card" style="padding: 0.75rem;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span class="material-icons" style="font-size: 20px; color: #84cc16;">volume_up</span>
                        <input type="range" id="bird-volume" class="modern-range" min="0" max="1" step="0.1" value="0.5" style="flex: 1;">
                        <button id="stop-sounds-btn" class="modern-btn" style="padding: 6px 10px; font-size: 0.8rem;">
                            <span class="material-icons" style="font-size: 16px;">stop</span>
                        </button>
                    </div>
                </div>

                <div id="active-birds-container">
                    <div class="dashboard-card">
                        <div class="dashboard-section-title">Active Birds</div>
                        <p style="color: #888; font-size: 0.85rem;">Listening for bird calls...</p>
                    </div>
                </div>
        `;
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Species Guide</div>
                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <div style="display: flex; gap: 10px; align-items: start;">
                        <img src="https://upload.wikimedia.org/wikipedia/commons/9/93/Luscinia_luscinia_vogelartinfo_chris_romeiks_CHR3635.jpg" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                                <span style="width: 10px; height: 10px; border-radius: 50%; background: #FFD700;"></span>
                                <span style="font-weight: bold; font-size: 0.9rem;">Thrush Nightingale</span>
                            </div>
                            <div style="font-size: 0.8rem; color: #666; line-height: 1.3;">
                                Known for its powerful and melodious song, often heard at night. It breeds in dense damp thickets.
                            </div>
                        </div>
                    </div>

                    <div style="display: flex; gap: 10px; align-items: start;">
                        <img src="https://upload.wikimedia.org/wikipedia/commons/5/53/Ficedula_hypoleuca_-Wood_of_Cree_Nature_Reserve%2C_Scotland_-male-8a.jpg" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                                <span style="width: 10px; height: 10px; border-radius: 50%; background: #00BFFF;"></span>
                                <span style="font-weight: bold; font-size: 0.9rem;">European Pied Flycatcher</span>
                            </div>
                            <div style="font-size: 0.8rem; color: #666; line-height: 1.3;">
                                A small passerine bird that breeds in most of Europe and western Asia. It is migratory, wintering in western Africa.
                            </div>
                        </div>
                    </div>

                    <div style="display: flex; gap: 10px; align-items: start;">
                        <img src="https://upload.wikimedia.org/wikipedia/commons/1/14/Hausrotschwanz_Brutpflege_2006-05-21-05.jpg" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                                <span style="width: 10px; height: 10px; border-radius: 50%; background: #FF4500;"></span>
                                <span style="font-weight: bold; font-size: 0.9rem;">Black Redstart</span>
                            </div>
                            <div style="font-size: 0.8rem; color: #666; line-height: 1.3;">
                                A small passerine bird that has adapted to live in the heart of industrial and urban centers.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Attach event listeners
        const volumeInput = document.getElementById('bird-volume');
        const stopBtn = document.getElementById('stop-sounds-btn');

        const sendBirdControl = (action, value) => {
            channel.postMessage({
                type: MSG_TYPES.BIRD_CONTROL,
                action: action,
                value: value
            });
        };

        if (volumeInput) {
            volumeInput.addEventListener('input', (e) => {
                sendBirdControl('set_volume', e.target.value);
            });
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                sendBirdControl('stop_all');
            });
        }

    } else if (targetId === 'fcc-demo-btn') {
        // FCC VR Demo dashboard with video player and timeline
        updateFCCDemoDashboard();
        
    } else if (targetId === 'street-view-btn') {
        // Street View dashboard with embedded image
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card" style="padding: 0; overflow: hidden;">
                    <div id="street-view-panel" style="width: 100%; height: 350px; background: #1a1a1a; position: relative;">
                        <img id="street-view-image" style="width: 100%; height: 100%; object-fit: cover; display: none;" />
                        <div id="street-view-no-coverage" style="
                            position: absolute;
                            top: 0; left: 0; right: 0; bottom: 0;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            flex-direction: column;
                            color: #666;
                            font-size: 14px;
                            background: #1a1a1a;
                        ">
                            <span style="font-size: 48px; margin-bottom: 12px;">📍</span>
                            <span style="font-size: 16px; margin-bottom: 4px;">Click on the map</span>
                            <span style="font-size: 12px; color: #555;">to view Street View at that location</span>
                        </div>
                        <div id="street-view-coords" style="
                            position: absolute;
                            bottom: 8px;
                            left: 8px;
                            background: rgba(0,0,0,0.7);
                            color: #888;
                            font-size: 10px;
                            padding: 4px 8px;
                            border-radius: 4px;
                            font-family: monospace;
                            z-index: 10;
                        "></div>
                        <div id="street-view-heading-controls" style="
                            position: absolute;
                            bottom: 8px;
                            right: 8px;
                            display: none;
                            gap: 4px;
                            z-index: 10;
                        ">
                            <button id="sv-rotate-left" style="background: rgba(0,0,0,0.7); border: none; color: white; padding: 8px 12px; border-radius: 4px; cursor: pointer;">◀</button>
                            <button id="sv-rotate-right" style="background: rgba(0,0,0,0.7); border: none; color: white; padding: 8px 12px; border-radius: 4px; cursor: pointer;">▶</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">How to Use</div>
                <div style="font-size: 11px; color: #ccc; line-height: 1.6;">
                    <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px;">
                        <span style="color: #3b82f6; font-weight: bold;">1.</span>
                        <span>Click the Street View button to activate</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px;">
                        <span style="color: #3b82f6; font-weight: bold;">2.</span>
                        <span>Click anywhere on the main map display</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px;">
                        <span style="color: #3b82f6; font-weight: bold;">3.</span>
                        <span>View the Street View image here</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 8px;">
                        <span style="color: #3b82f6; font-weight: bold;">4.</span>
                        <span>Use ◀ ▶ buttons to rotate view</span>
                    </div>
                </div>
            </div>
            <div class="dashboard-card" style="margin-top: 1rem;">
                <div class="info-box" style="border-left-color: #22c55e;">
                    <div class="info-title">Coverage</div>
                    <p class="info-text">
                        Street View is available along most roads in Sweden. 
                        If no imagery exists, you'll see a "No Coverage" message.
                    </p>
                </div>
            </div>
        `;
        
        // Initialize rotation controls
        initStreetViewControls();
        
    } else {
        // Default or other tools
        dashboardContent.innerHTML = '<p>Select a simulation to view details.</p>';
        legendContent.innerHTML = '<p>Select a simulation to view its legend.</p>';
    }
}

document.getElementById('reset-view-btn').addEventListener('click', () => {
    stopTour();
    channel.postMessage({
        type: MSG_TYPES.RESET_VIEW
    });
});

document.getElementById('fullscreen-btn').addEventListener('click', () => {
    stopTour();
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.log(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
    } else {
        document.exitFullscreen();
    }
});

// Listen for messages from main app
channel.onmessage = (event) => {
    const data = event.data;
    debugLog('Received:', data.type, data);
    
    if (data.type === MSG_TYPES.ANIMATION_STATE) {
        // Received actual animation state from main window - update our tracking
        setAnimationState(data.animationId, data.isActive);
    } else if (data.type === MSG_TYPES.STATE_UPDATE) {
        // Legacy state update - ignore for animation buttons now
        // We use ANIMATION_STATE for that instead
    } else if (data.type === MSG_TYPES.SLIDESHOW_UPDATE) {
        // Update slideshow state and display
        slideshowState = {
            isActive: data.isActive,
            currentIndex: data.currentIndex,
            totalSlides: data.totalSlides,
            metadata: data.metadata,
            slideType: data.slideType
        };
        // Update dashboard if slideshow is the active layer
        const slideshowBtn = document.querySelector('.control-btn[data-target="slideshow-btn"]');
        if (slideshowBtn && slideshowBtn.classList.contains('active')) {
            updateSlideshowDashboard();
        }
    } else if (data.type === MSG_TYPES.SLIDESHOW_LEGEND_HIGHLIGHT) {
        // Highlight legend item in controller to match main window animation
        highlightControllerLegendItem(data.highlightValue);
    } else if (data.type === MSG_TYPES.BIRD_STATUS) {
        updateBirdDashboard(data.activeBirds);
    } else if (data.type === MSG_TYPES.SUN_POSITION) {
        const altDisplay = document.getElementById('altitude-display');
        const azDisplay = document.getElementById('azimuth-display');
        // Only update if elements exist (i.e., Sun Study dashboard is active)
        if (altDisplay) altDisplay.textContent = data.altitude.toFixed(1);
        if (azDisplay) azDisplay.textContent = data.azimuth.toFixed(1);
    } else if (data.type === MSG_TYPES.SUN_TIME_UPDATE) {
        const timeSlider = document.getElementById('sun-time');
        const timeDisplay = document.getElementById('time-display');
        if (timeSlider && timeDisplay) {
            timeSlider.value = data.time;
            const h = Math.floor(data.time);
            const m = Math.floor((data.time - h) * 60);
            timeDisplay.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
        }
    } else if (data.type === 'trees_state') {
        // Update trees toggle button and status display
        const toggleTreesBtn = document.getElementById('toggle-trees-btn');
        const treesStatusDisplay = document.getElementById('trees-status-display');
        
        if (toggleTreesBtn) {
            if (data.visible) {
                toggleTreesBtn.classList.add('active');
            } else {
                toggleTreesBtn.classList.remove('active');
            }
        }
        
        if (treesStatusDisplay) {
            if (data.error) {
                treesStatusDisplay.textContent = 'Error';
                treesStatusDisplay.style.color = '#ef4444';
            } else if (data.loaded && data.visible) {
                treesStatusDisplay.textContent = 'On';
                treesStatusDisplay.style.color = '#22c55e';
            } else if (data.loaded) {
                treesStatusDisplay.textContent = 'Off';
                treesStatusDisplay.style.color = '#9ca3af';
            } else {
                treesStatusDisplay.textContent = 'Loading...';
                treesStatusDisplay.style.color = '#f59e0b';
            }
        }
    } else if (data.type === MSG_TYPES.CALIBRATION_DATA) {
        const calibrationText = data.text;
        navigator.clipboard.writeText(calibrationText).then(() => {
            alert('Calibration copied to clipboard!');
        }).catch(err => {
            console.error('Clipboard error:', err);
            alert('Failed to copy to clipboard. Check console for data.');
            console.log(calibrationText);
        });
    } else if (data.type === 'isovist_stats') {
        updateIsovistChart(data.data);
    } else if (data.type === 'fcc_demo_progress') {
        // Update FCC demo progress from main window
        fccDemoState.progress = data.progress;
        fccDemoState.currentTime = data.time;
        updateFCCDemoProgress();
    } else if (data.type === 'fcc_demo_ready') {
        // FCC demo is ready
        fccDemoState.pathLength = data.data.pathLength;
        fccDemoState.pointCount = data.data.pointCount;
        updateFCCDemoDashboard();
    } else if (data.type === 'fcc_demo_stats') {
        // Update FCC demo stats
        fccDemoState.stats = data.data;
        updateFCCDemoStats();
    } else if (data.type === 'fcc_demo_playback_state') {
        // Update playback state
        fccDemoState.isPlaying = data.isPlaying;
        updateFCCDemoPlayButton();
    } else if (data.type === 'street_view_position') {
        // Received position from main map - update Street View panorama
        updateStreetViewPosition(data.position, data.heading);
    } else if (data.type === 'sam_segment') {
        // Trigger segmentation as requested from main window
        const segBtn = document.getElementById('sam-segment-btn');
        if (segBtn) {
            // Simulate user click
            segBtn.click();
        } else {
            // Update status if available
            if (typeof setSamStatus === 'function') setSamStatus('No segmentation UI', false);
        }
    } else {
        // Log unknown message types for debugging new features
        debugLog('Unknown message type:', data.type);
    }
};

// Historical data for isovist stacked area chart
const isovistHistory = {
    maxPoints: 100,
    data: [],
    gvfHistory: [], // Track GVF values for rolling average
    colors: {
        'Open View': '#87CEEB',
        'Trees': '#2D5A27',
        'Bostad': '#E57373',
        'Verksamhet': '#00ACC1',
        'Samhällsfunktion': '#9C27B0',
        'Komplementbyggnad': '#FF9800',
        'Unknown': '#888888'
    },
    order: ['Unknown', 'Komplementbyggnad', 'Samhällsfunktion', 'Verksamhet', 'Bostad', 'Trees', 'Open View']
};

function updateIsovistChart(stats) {
    const container = document.getElementById('isovist-stats-container');
    if (!container) return;
    
    // Check if isovist is active
    const isovistBtn = document.querySelector('.control-btn[data-target="isovist-btn"]');
    if (!isovistBtn || !isovistBtn.classList.contains('active')) return;
    
    const totalRays = stats.totalRays || 1;
    const openRays = stats.openRays || 0;
    const treeRays = stats.treeRays || 0;
    const buildingTypeRays = stats.buildingTypeRays || {};
    
    // Calculate ray-based percentages (these will add up to 100%)
    const buildingTypes = {
        'Open View': { rays: openRays, color: '#87CEEB', percent: ((openRays / totalRays) * 100).toFixed(1) },
        'Trees': { rays: treeRays, color: '#2D5A27', percent: ((treeRays / totalRays) * 100).toFixed(1) },
        'Bostad': { rays: buildingTypeRays['Bostad'] || 0, color: '#E57373', percent: (((buildingTypeRays['Bostad'] || 0) / totalRays) * 100).toFixed(1) },
        'Verksamhet': { rays: buildingTypeRays['Verksamhet'] || 0, color: '#00ACC1', percent: (((buildingTypeRays['Verksamhet'] || 0) / totalRays) * 100).toFixed(1) },
        'Samhällsfunktion': { rays: buildingTypeRays['Samhällsfunktion'] || 0, color: '#9C27B0', percent: (((buildingTypeRays['Samhällsfunktion'] || 0) / totalRays) * 100).toFixed(1) },
        'Komplementbyggnad': { rays: buildingTypeRays['Komplementbyggnad'] || 0, color: '#FF9800', percent: (((buildingTypeRays['Komplementbyggnad'] || 0) / totalRays) * 100).toFixed(1) },
        'Unknown': { rays: buildingTypeRays['Unknown'] || 0, color: '#888888', percent: (((buildingTypeRays['Unknown'] || 0) / totalRays) * 100).toFixed(1) }
    };
    
    // Calculate GVF (Green View Factor) - percentage of view that is trees/vegetation
    // Cap at 100% to handle any floating point rounding issues
    const gvf = Math.min(100, parseFloat(buildingTypes['Trees'].percent));
    
    // Add to GVF rolling history
    isovistHistory.gvfHistory.push(gvf);
    if (isovistHistory.gvfHistory.length > isovistHistory.maxPoints) {
        isovistHistory.gvfHistory.shift();
    }
    
    // Calculate rolling average GVF
    const gvfAverage = isovistHistory.gvfHistory.length > 0 
        ? (isovistHistory.gvfHistory.reduce((a, b) => a + b, 0) / isovistHistory.gvfHistory.length).toFixed(1)
        : 0;
    
    // Determine GVF rating
    let gvfRating, gvfRatingColor, gvfRatingIcon;
    if (gvfAverage >= 30) {
        gvfRating = 'Good';
        gvfRatingColor = '#4CAF50';
        gvfRatingIcon = 'check_circle';
    } else if (gvfAverage >= 15) {
        gvfRating = 'Fair';
        gvfRatingColor = '#FF9800';
        gvfRatingIcon = 'info';
    } else {
        gvfRating = 'Poor';
        gvfRatingColor = '#f44336';
        gvfRatingIcon = 'warning';
    }
    
    // Filter out types with 0 rays (except Open View and Trees which we always show if enabled)
    const activeTypes = Object.entries(buildingTypes).filter(([type, data]) => 
        type === 'Open View' || type === 'Trees' || data.rays > 0
    );
    
    // Add to history
    isovistHistory.data.push({
        'Open View': parseFloat(buildingTypes['Open View'].percent),
        'Trees': parseFloat(buildingTypes['Trees'].percent),
        'Bostad': parseFloat(buildingTypes['Bostad'].percent),
        'Verksamhet': parseFloat(buildingTypes['Verksamhet'].percent),
        'Samhällsfunktion': parseFloat(buildingTypes['Samhällsfunktion'].percent),
        'Komplementbyggnad': parseFloat(buildingTypes['Komplementbyggnad'].percent),
        'Unknown': parseFloat(buildingTypes['Unknown'].percent)
    });
    if (isovistHistory.data.length > isovistHistory.maxPoints) {
        isovistHistory.data.shift();
    }
    
    // Build conic-gradient for pie chart
    let gradientParts = [];
    let currentAngle = 0;
    activeTypes.forEach(([type, data]) => {
        const percent = parseFloat(data.percent);
        const nextAngle = currentAngle + (percent * 3.6); // 3.6 degrees per percent
        gradientParts.push(`${data.color} ${currentAngle}deg ${nextAngle}deg`);
        currentAngle = nextAngle;
    });
    // Fill remaining with dark if not 100%
    if (currentAngle < 360) {
        gradientParts.push(`rgba(50,50,50,0.5) ${currentAngle}deg 360deg`);
    }
    const gradient = gradientParts.join(', ');
    
    let html = `
        <style>
            .isovist-pie-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 12px;
            }
            .pie-chart {
                width: 200px;
                height: 200px;
                border-radius: 50%;
                background: conic-gradient(${gradient});
                flex-shrink: 0;
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                position: relative;
            }
            .pie-chart::after {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 90px;
                height: 90px;
                background: #2a2a2a;
                border-radius: 50%;
            }
            .pie-chart-gvf {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                text-align: center;
                z-index: 1;
            }
            .gvf-value {
                font-size: 26px;
                font-weight: 700;
                color: #ffffff;
                line-height: 1;
            }
            .gvf-label {
                font-size: 10px;
                color: #2D5A27;
                text-transform: uppercase;
                letter-spacing: 1px;
                margin-top: 4px;
                font-weight: 600;
            }
            .pie-stats {
                display: flex;
                justify-content: center;
                gap: 20px;
                font-size: 12px;
                color: #ccc;
                width: 100%;
            }
            .pie-stat-item {
                text-align: center;
            }
            .pie-stat-value {
                font-weight: 700;
                font-size: 18px;
                color: #fff;
                display: block;
            }
            .pie-stat-label {
                font-size: 10px;
                color: #888;
                text-transform: uppercase;
            }
            .pie-legend {
                display: flex;
                flex-wrap: wrap;
                gap: 4px 10px;
                margin-top: 12px;
                padding-top: 10px;
                border-top: 1px solid rgba(255,255,255,0.1);
            }
            .pie-legend-item {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 10px;
                color: #aaa;
            }
            .pie-legend-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .building-legend {
                display: flex;
                flex-wrap: wrap;
                gap: 4px 8px;
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid rgba(255,255,255,0.08);
            }
            .building-legend-item {
                display: flex;
                align-items: center;
                gap: 3px;
                font-size: 9px;
                color: #777;
            }
            .building-legend-color {
                width: 10px;
                height: 10px;
                border-radius: 2px;
                flex-shrink: 0;
            }
            .history-chart-container {
                margin-top: 12px;
                padding-top: 10px;
                border-top: 1px solid rgba(255,255,255,0.1);
            }
            .history-chart-title {
                font-size: 10px;
                color: #666;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 8px;
            }
            .history-canvas {
                width: 100%;
                height: 80px;
                border-radius: 4px;
                background: rgba(0,0,0,0.2);
            }
            .gvf-average-container {
                margin-top: 10px;
                padding: 10px;
                background: rgba(0,0,0,0.2);
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .gvf-average-left {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .gvf-average-label {
                font-size: 10px;
                color: #888;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .gvf-average-value {
                font-size: 18px;
                font-weight: 700;
                color: #fff;
            }
            .gvf-rating {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 600;
            }
            .gvf-rating .material-icons {
                font-size: 14px;
            }
        </style>
        <div class="isovist-pie-container">
            <div class="pie-chart">
                <div class="pie-chart-gvf">
                    <div class="gvf-value">${gvf.toFixed(1)}%</div>
                    <div class="gvf-label">GVF</div>
                </div>
            </div>
            <div class="pie-stats">
                <div class="pie-stat-item">
                    <span class="pie-stat-value">${stats.totalBuildings || 0}</span>
                    <span class="pie-stat-label">Buildings</span>
                </div>
                <div class="pie-stat-item">
                    <span class="pie-stat-value">${stats.totalTrees || 0}</span>
                    <span class="pie-stat-label">Trees</span>
                </div>
                <div class="pie-stat-item">
                    <span class="pie-stat-value">${buildingTypes['Open View'].percent}%</span>
                    <span class="pie-stat-label">Open View</span>
                </div>
            </div>
        </div>
        <div class="pie-legend">
    `;
    
    activeTypes.forEach(([type, data]) => {
        const displayName = type === 'Samhällsfunktion' ? 'Public' : 
                           type === 'Komplementbyggnad' ? 'Outbld' :
                           type === 'Verksamhet' ? 'Comm.' :
                           type === 'Bostad' ? 'Resid.' : 
                           type === 'Open View' ? 'Open' :
                           type === 'Trees' ? 'Trees' : type;
        html += `
            <div class="pie-legend-item">
                <div class="pie-legend-dot" style="background: ${data.color};"></div>
                <span>${displayName} ${data.percent}%</span>
            </div>
        `;
    });
    
    html += `</div>
        <div class="building-legend">
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #E57373;"></div>
                <span>Residential</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #00ACC1;"></div>
                <span>Commercial</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #9C27B0;"></div>
                <span>Public</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #FF9800;"></div>
                <span>Outbuilding</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #2D5A27;"></div>
                <span>Trees</span>
            </div>
        </div>
        <div class="history-chart-container">
            <div class="history-chart-title">Visibility History</div>
            <canvas id="isovist-history-canvas" class="history-canvas"></canvas>
        </div>
        <div class="gvf-average-container">
            <div class="gvf-average-left">
                <div>
                    <div class="gvf-average-label">Average GVF</div>
                    <div class="gvf-average-value">${gvfAverage}%</div>
                </div>
            </div>
            <div class="gvf-rating" style="background: ${gvfRatingColor}22; color: ${gvfRatingColor};">
                <span class="material-icons">${gvfRatingIcon}</span>
                ${gvfRating}
            </div>
        </div>
    `;
    
    container.innerHTML = html;
    
    // Draw the stacked area chart
    drawIsovistHistoryChart();
}

function drawIsovistHistoryChart() {
    const canvas = document.getElementById('isovist-history-canvas');
    if (!canvas || isovistHistory.data.length < 2) return;
    
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;  // Higher resolution
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    
    const width = rect.width;
    const height = rect.height;
    const data = isovistHistory.data;
    const numPoints = data.length;
    const xStep = width / (isovistHistory.maxPoints - 1);
    const xOffset = (isovistHistory.maxPoints - numPoints) * xStep;
    
    // Draw stacked areas from TOP to BOTTOM (reverse order so layers don't cover each other)
    const reversedOrder = [...isovistHistory.order].reverse();
    
    reversedOrder.forEach(type => {
        ctx.beginPath();
        
        // Start at bottom-left
        ctx.moveTo(xOffset, height);
        
        // Draw top edge (cumulative up to and including this type)
        for (let i = 0; i < numPoints; i++) {
            const x = xOffset + i * xStep;
            let cumulative = 0;
            
            // Sum from bottom of stack up to and including this type
            for (let j = 0; j <= isovistHistory.order.indexOf(type); j++) {
                cumulative += data[i][isovistHistory.order[j]] || 0;
            }
            
            const y = height - (cumulative / 100 * height);
            ctx.lineTo(x, y);
        }
        
        // Close back to bottom-right then bottom-left
        ctx.lineTo(xOffset + (numPoints - 1) * xStep, height);
        ctx.closePath();
        
        ctx.fillStyle = isovistHistory.colors[type];
        ctx.fill();
    });
    
    // Draw subtle grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 0.5;
    [25, 50, 75].forEach(pct => {
        const y = height - (pct / 100 * height);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    });
}

function updateBirdDashboard(activeBirds) {
    const container = document.getElementById('active-birds-container');
    if (!container) return;

    // Only update if Bird Sounds is the active layer (checked via button state)
    const birdBtn = document.querySelector('.control-btn[data-target="bird-sounds-btn"]');
    if (!birdBtn || !birdBtn.classList.contains('active')) return;

    if (!activeBirds || activeBirds.length === 0) {
        container.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Active Birds</div>
                <p>Listening for bird calls...</p>
            </div>
        `;
        return;
    }

    let html = `
        <style>
            .bird-card {
                background: #fff;
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                margin-bottom: 6px;
                border-left: 3px solid transparent;
                display: flex;
                height: 50px;
            }
            .bird-image-container {
                width: 50px;
                height: 50px;
                flex-shrink: 0;
            }
            .bird-image {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            .bird-info {
                padding: 4px 8px;
                flex-grow: 1;
                display: flex;
                align-items: center;
                gap: 8px;
                overflow: hidden;
            }
            .bird-name {
                font-weight: 600;
                font-size: 0.8rem;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                min-width: 0;
            }
            .sensor-info {
                font-size: 0.7rem;
                color: #888;
                display: flex;
                align-items: center;
                gap: 2px;
                flex-shrink: 0;
            }
            
            /* CSS Waveform Animation */
            .waveform-visualizer {
                display: flex;
                align-items: center;
                gap: 1px;
                height: 20px;
                flex-shrink: 0;
            }
            .wave-bar {
                width: 2px;
                background-color: #ccc;
                animation: wave 1s ease-in-out infinite;
                border-radius: 1px;
            }
            @keyframes wave {
                0%, 100% { height: 20%; }
                50% { height: 100%; }
            }
        </style>
        <div class="dashboard-card" style="padding: 0.5rem;">
            <div class="dashboard-section-title" style="margin-bottom: 0.5rem; font-size: 0.85rem;">Active Birds</div>
            <div style="display: flex; flex-direction: column;">
    `;

    activeBirds.forEach(item => {
        // Generate random animation delays for a more organic look
        const bars = Array.from({length: 8}, (_, i) => {
            const delay = Math.random() * 1;
            return `<div class="wave-bar" style="background-color: ${item.bird.color}; animation-delay: -${delay}s;"></div>`;
        }).join('');

        html += `
            <div class="bird-card" style="border-left-color: ${item.bird.color};">
                <div class="bird-image-container">
                    <img src="${item.bird.image}" alt="${item.bird.name}" class="bird-image">
                </div>
                <div class="bird-info">
                    <div class="bird-name" style="color: ${item.bird.color};">${item.bird.name}</div>
                    <div class="sensor-info">
                        <span class="material-icons" style="font-size: 10px;">sensors</span>
                        #${item.sensor.id}
                    </div>
                    <div class="waveform-visualizer">
                        ${bars}
                    </div>
                </div>
            </div>
        `;
    });
    html += '</div></div>';
    container.innerHTML = html;
}

// ============================================
// FCC DEMO DASHBOARD FUNCTIONS
// ============================================

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

// ============================================
// END FCC DEMO DASHBOARD FUNCTIONS
// ============================================

// Update slideshow dashboard with live metadata and controls
function updateSlideshowDashboard() {
    const dashboardContent = document.getElementById('dashboard-content');
    const legendContent = document.getElementById('legend-content');
    
    if (!slideshowState.isActive) {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">slideshow</span>
                        Slideshow
                    </div>
                    <div class="info-box" style="border-left-color: #8b5cf6; margin-bottom: 1rem;">
                        <div class="info-title">Ready to Start</div>
                        <p class="info-text">
                            The slideshow is currently stopped.
                        </p>
                    </div>
                    <button id="slideshow-start-btn" class="modern-btn primary" style="width: 100%;">
                        <span class="material-icons">play_arrow</span> Start Slideshow
                    </button>
                </div>
            </div>
        `;
        
        // Add listener for start button
        setTimeout(() => {
            const startBtn = document.getElementById('slideshow-start-btn');
            if (startBtn) {
                startBtn.addEventListener('click', () => {
                    // Send toggle command
                    channel.postMessage({
                        type: MSG_TYPES.CONTROL_ACTION,
                        target: 'slideshow-btn'
                    });
                    // Show loading state locally
                    dashboardContent.innerHTML = '<div class="dashboard-container"><div class="dashboard-card"><p>Starting...</p></div></div>';
                });
            }
        }, 0);

        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <p style="color: #6b7280; font-size: 0.9rem;">Start the slideshow to see slide-specific legends.</p>
            </div>
        `;
        return;
    }
    
    const meta = slideshowState.metadata || {};
    const slideNum = slideshowState.currentIndex + 1;
    const totalSlides = slideshowState.totalSlides;
    
    // Build dashboard content
    dashboardContent.innerHTML = `
        <div class="dashboard-container">
            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">slideshow</span>
                    Navigation
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
                    <button id="slideshow-prev-btn" class="modern-btn" style="flex: 1;">
                        <span class="material-icons">chevron_left</span> Previous
                    </button>
                    <div style="padding: 0 1rem; text-align: center;">
                        <div style="font-size: 1.5rem; font-weight: 600; color: #1f2937;">${slideNum} / ${totalSlides}</div>
                        <div style="font-size: 0.75rem; color: #6b7280;">Slide</div>
                    </div>
                    <button id="slideshow-next-btn" class="modern-btn" style="flex: 1;">
                        Next <span class="material-icons">chevron_right</span>
                    </button>
                </div>
                <div style="text-align: center;">
                    <button id="slideshow-stop-btn" class="modern-btn" style="background: #fef2f2; border-color: #fecaca; color: #dc2626;">
                        <span class="material-icons">stop</span> Stop Slideshow
                    </button>
                </div>
                <div style="margin-top: 1rem; padding: 0.75rem; background: #f3f4f6; border-radius: 8px; text-align: center; color: #6b7280; font-size: 0.85rem;">
                    <span class="material-icons" style="font-size: 14px; vertical-align: middle;">keyboard</span>
                    Use <kbd style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">←</kbd> <kbd style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">→</kbd> arrow keys to navigate
                </div>
            </div>

            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">info</span>
                    Current Slide
                </div>
                ${meta.title ? `<div style="font-size: 1.1rem; font-weight: 600; color: #1f2937; margin-bottom: 0.5rem;">${meta.title}</div>` : ''}
                ${meta.description ? `<p class="info-text" style="margin-bottom: 0.75rem;">${meta.description}</p>` : ''}
                ${meta.source ? `<p style="font-size: 0.8rem; color: #9ca3af; font-style: italic;">Source: ${meta.source}</p>` : ''}
                ${slideshowState.slideType ? `<div style="margin-top: 0.5rem;"><span style="background: #e5e7eb; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; text-transform: uppercase;">${slideshowState.slideType}</span></div>` : ''}
            </div>
        </div>
    `;
    
    // Build legend from slide metadata
    if (meta.legend && meta.legend.items && meta.legend.items.length > 0) {
        // Build reverse color map (color -> property value) for highlighting
        const colorToValue = {};
        if (meta.style && meta.style.colorMap) {
            Object.entries(meta.style.colorMap).forEach(([value, color]) => {
                colorToValue[color] = value;
            });
        }
        
        let legendHtml = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <div id="slideshow-legend-items" style="display: flex; flex-direction: column; gap: 0.5rem;">
        `;
        
        meta.legend.items.forEach(item => {
            const propertyValue = colorToValue[item.color] || '';
            legendHtml += `
                <div class="legend-item slideshow-legend-item" data-value="${propertyValue}" style="transition: all 0.3s ease; opacity: 0.6;">
                    <div class="legend-color" style="background: ${item.color};"></div>
                    <span class="legend-label">${item.label}</span>
                </div>
            `;
        });
        
        legendHtml += `
                </div>
            </div>
        `;
        legendContent.innerHTML = legendHtml;
    } else {
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <p style="color: #6b7280; font-size: 0.9rem;">No legend for this slide.</p>
            </div>
        `;
    }
    
    // Attach event listeners for navigation buttons
    const prevBtn = document.getElementById('slideshow-prev-btn');
    const nextBtn = document.getElementById('slideshow-next-btn');
    const stopBtn = document.getElementById('slideshow-stop-btn');
    
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'previous' });
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'next' });
        });
    }
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'stop' });
        });
    }
}

// Highlight legend item in controller to match main window animation
function highlightControllerLegendItem(propertyValue) {
    const legendItems = document.querySelectorAll('.slideshow-legend-item');
    legendItems.forEach(item => {
        const itemValue = item.getAttribute('data-value');
        if (propertyValue && itemValue === propertyValue) {
            // Active state - match main window styling
            item.style.opacity = '1';
            item.style.background = 'rgba(59, 130, 246, 0.1)';
            item.style.transform = 'scale(1.05)';
            item.style.boxShadow = '0 0 12px rgba(59, 130, 246, 0.4)';
            item.style.borderColor = '#3b82f6';
        } else {
            // Inactive state
            item.style.opacity = '0.6';
            item.style.background = '';
            item.style.transform = '';
            item.style.boxShadow = '';
            item.style.borderColor = '';
        }
    });
}

function updateMetadata(layerId) {
    welcomeScreen.classList.add('hidden');
    const metaLayer = document.getElementById('meta-layer');
    const metaDesc = document.getElementById('meta-desc');
    const legendContent = document.getElementById('legend-content');
    
    let name = 'None';
    let desc = 'Interactive map of the district. Use controls to toggle layers.';
    let legend = '<p>Select a simulation to view its legend.</p>';

    switch(layerId) {
        case 'cfd-simulation-btn':
            name = 'CFD Wind Simulation';
            desc = 'Computational Fluid Dynamics simulation showing wind flow patterns around buildings. Colors indicate wind speed.';
            legend = `
                <div style="display: flex; align-items: center; gap: 10px; margin-top: 10px;">
                    <div style="width: 20px; height: 100px; background: linear-gradient(to top, blue, green, yellow, red);"></div>
                    <div style="display: flex; flex-direction: column; justify-content: space-between; height: 100px;">
                        <span>High Speed (> 10 m/s)</span>
                        <span>Medium Speed (5 m/s)</span>
                        <span>Low Speed (< 1 m/s)</span>
                    </div>
                </div>
            `;
            break;
        case 'bird-sounds-btn':
            name = 'Bird Sounds';
            desc = 'Simulated bird sensors detecting local species. Visualizes sound intensity at sensor locations.';
            legend = `
                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="width: 12px; height: 12px; border-radius: 50%; background: #FFD700;"></span>
                            <span style="font-weight: bold;">Thrush Nightingale</span>
                        </div>
                        <div style="font-size: 0.85rem; color: #666; margin-left: 22px;">
                            Known for its powerful and melodic song, often heard at night.
                        </div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="width: 12px; height: 12px; border-radius: 50%; background: #00BFFF;"></span>
                            <span style="font-weight: bold;">European Pied Flycatcher</span>
                        </div>
                        <div style="font-size: 0.85rem; color: #666; margin-left: 22px;">
                            A small passerine bird with a rhythmic, repetitive song.
                        </div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="width: 12px; height: 12px; border-radius: 50%; background: #FF4500;"></span>
                            <span style="font-weight: bold;">Black Redstart</span>
                        </div>
                        <div style="font-size: 0.85rem; color: #666; margin-left: 22px;">
                            Adapts well to urban environments, known for its warbling tail.
                        </div>
                    </div>
                </div>
            `;
            break;
        case 'stormwater-btn':
            name = 'Stormwater Flow';
            desc = 'Simulation of water accumulation and flow during heavy rainfall events. Highlights potential flood risk areas.';
            legend = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="width: 15px; height: 15px; background: #0000ff; display: inline-block;"></span> Water Accumulation
                </div>
            `;
            break;
        case 'sun-study-btn':
            name = 'Sun Study';
            desc = 'Shadow analysis showing sunlight exposure at different times of day/year.';
            legend = '<p>Shadows cast by buildings based on solar position.</p>';
            break;
        case 'slideshow-btn':
            name = 'Slideshow';
            // Use live metadata if available
            if (slideshowState.isActive && slideshowState.metadata) {
                desc = slideshowState.metadata.title || 'Cycling through project visualizations.';
            } else {
                desc = 'Cycling through various data visualizations and views of the project.';
            }
            legend = '<p>See Legend panel for slide-specific legend.</p>';
            break;
        case 'grid-animation-btn':
            name = 'Grid Animation';
            desc = 'Animated grid overlay effect.';
            legend = '<p>Grid overlay active.</p>';
            break;
        case 'isovist-btn':
            name = 'Interactive Isovist';
            desc = 'Visual field analysis from a specific point. Shows what is visible from the selected location.';
            legend = '<p>Click on map to set view point.</p>';
            break;
        case 'calibrate-btn':
            name = 'Projector Calibration';
            desc = 'Configure map projection to align with physical model.';
            legend = '';
            break;
        case 'credits-btn':
            name = 'Credits';
            desc = 'The team behind the ACE MR Studio project.';
            legend = '';
            break;
    }

    metaLayer.textContent = name;
    metaDesc.textContent = desc;
    legendContent.innerHTML = legend;
}

// --- Tour Logic ---

const tourSteps = [
    { selector: '[data-target="cfd-simulation-btn"]', title: 'CFD Wind Simulation', desc: 'Visualize wind flow patterns and speeds around buildings.' },
    { selector: '[data-target="stormwater-btn"]', title: 'Stormwater Flow', desc: 'Simulate water accumulation and flood risks during heavy rain.' },
    { selector: '[data-target="sun-study-btn"]', title: 'Sun Study', desc: 'Analyze sunlight exposure and shadows throughout the day.' },
    { selector: '[data-target="slideshow-btn"]', title: 'Slideshow', desc: 'Cycle through curated project views and visualizations.' },
    { selector: '[data-target="grid-animation-btn"]', title: 'Grid Animation', desc: 'Toggle the animated grid overlay for spatial reference.' },
    { selector: '[data-target="isovist-btn"]', title: 'Interactive Isovist', desc: 'Analyze visibility fields from specific vantage points.' },
    { selector: '[data-target="bird-sounds-btn"]', title: 'Bird Sounds', desc: 'Listen to simulated bird sensors and view real-time activity.' },
    { selector: '#reset-view-btn', title: 'Reset View', desc: 'Return the map to the default starting position.' },
    { selector: '#fullscreen-btn', title: 'Full Screen', desc: 'Toggle full screen mode for this controller.' }
];

let tourInterval;
let currentStep = 0;
const tourInfo = document.getElementById('tour-info');
const tourTitle = document.getElementById('tour-title');
const tourDesc = document.getElementById('tour-desc');

function startTour() {
    if (tourInterval) clearInterval(tourInterval);
    currentStep = 0;
    tourInfo.classList.add('active');
    showTourStep();
    tourInterval = setInterval(nextTourStep, 4000); // 4 seconds per step
}

function nextTourStep() {
    currentStep = (currentStep + 1) % tourSteps.length;
    showTourStep();
}

function showTourStep() {
    // Note: We no longer highlight buttons during tour to avoid confusion
    // with actually selected/active buttons
    
    const step = tourSteps[currentStep];
    
    // Update text with fade effect
    tourInfo.style.opacity = 0;
    setTimeout(() => {
        tourTitle.textContent = step.title;
        tourDesc.textContent = step.desc;
        tourInfo.style.opacity = 1;
    }, 300);

    // Set background effect
    if (step.selector.includes('cfd')) setEffect('wind');
    else if (step.selector.includes('stormwater')) setEffect('rain');
    else if (step.selector.includes('sun')) setEffect('sun');
    else if (step.selector.includes('isovist')) setEffect('isovist');
    else if (step.selector.includes('grid')) setEffect('grid');
    else if (step.selector.includes('slideshow')) setEffect('slideshow');
    else if (step.selector.includes('bird-sounds')) setEffect('soundwaves');
    else setEffect('default');
}

function stopTour() {
    if (tourInterval) {
        clearInterval(tourInterval);
        tourInterval = null;
    }
    tourInfo.classList.remove('active');
    setEffect('default'); // Stop effects
}

// Start tour initially
// startTour(); // Moved to end of file to ensure all functions are defined

// --- Background Animation Logic ---

const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');
let animationId;
let particles = [];
let currentEffect = 'default';

function resizeCanvas() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function initParticles(effect) {
    particles = [];
    
    if (effect === 'sun') {
        // Single sun object
        particles.push({
            angle: Math.PI, // Start at left (sunrise)
            radius: 60,
            speed: 0.005
        });
        return;
    }

    if (effect === 'grid') {
        const gridSize = 40;
        const cols = Math.ceil(canvas.width / gridSize) + 1;
        const rows = Math.ceil(canvas.height / gridSize) + 1;
        
        for (let i = 0; i < cols; i++) {
            particles.push({
                type: 'vertical',
                x: i * gridSize,
                speed: 0.5
            });
        }
        
        for (let i = 0; i < rows; i++) {
            particles.push({
                type: 'horizontal',
                y: i * gridSize,
                speed: 0.5
            });
        }
        return;
    }

    const count = effect === 'isovist' ? 5 : 100;
    for (let i = 0; i < count; i++) {
        particles.push(createParticle(effect));
    }
}

function createParticle(effect) {
    const w = canvas.width;
    const h = canvas.height;
    
    if (effect === 'wind') {
        const speed = Math.random() * 15 + 5;
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            speed: speed,
            length: Math.random() * 120 + 60, // Even longer streamlines
            width: Math.random() * 3 + 2, // Thicker
            opacity: Math.random() * 0.4 + 0.6, // Higher opacity
            speedRatio: speed / 20 // Normalized 0-1 for color
        };
    } else if (effect === 'rain') {
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            speed: Math.random() * 15 + 10,
            length: Math.random() * 35 + 20, // Longer
            width: Math.random() * 3 + 1.5, // Thicker
            opacity: Math.random() * 0.3 + 0.7 // Much higher opacity
        };
    } else if (effect === 'isovist') {
        // Points moving around
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            vx: (Math.random() - 0.5) * 3,
            vy: (Math.random() - 0.5) * 3,
            radius: Math.random() * 8 + 8, // Larger circles
            opacity: Math.random() * 0.3 + 0.7, // Much higher opacity
            angle: Math.random() * Math.PI * 2,
            angleSpeed: (Math.random() - 0.5) * 0.08,
            trail: []
        };
    } else if (effect === 'grid') {
        // Grid lines
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            size: Math.random() * 50 + 20,
            opacity: 0,
            targetOpacity: Math.random() * 0.3,
            life: 0
        };
    } else if (effect === 'slideshow') {
        // Floating squares
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            size: Math.random() * 50 + 15,
            vx: (Math.random() - 0.5) * 1.5,
            vy: (Math.random() - 0.5) * 1.5,
            opacity: Math.random() * 0.4 + 0.5 // Much higher opacity
        };
    } else if (effect === 'soundwaves') {
        // Floating sine waves
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            width: Math.random() * 150 + 80, // Wider waves
            amplitude: Math.random() * 30 + 10, // Bigger amplitude
            frequency: Math.random() * 0.1 + 0.02,
            speed: Math.random() * 2 + 0.5,
            phase: Math.random() * Math.PI * 2,
            opacity: Math.random() * 0.3 + 0.7, // Much higher opacity
            lineWidth: Math.random() * 4 + 3 // Thicker lines
        };
    }
    
    return {};
}

function updateParticles() {
    const w = canvas.width;
    const h = canvas.height;
    
    particles.forEach(p => {
        if (currentEffect === 'wind') {
            p.x += p.speed;
            if (p.x > w) p.x = -p.length;
        } else if (currentEffect === 'rain') {
            p.y += p.speed;
            p.x += 1; // Slight wind
            if (p.y > h) {
                p.y = -p.length;
                p.x = Math.random() * w;
            }
        } else if (currentEffect === 'sun') {
            p.angle += p.speed;
            if (p.angle > 2 * Math.PI) p.angle = Math.PI; // Loop back to sunrise
        } else if (currentEffect === 'isovist') {
            // Update trail
            p.trail.push({x: p.x, y: p.y});
            if (p.trail.length > 20) p.trail.shift();

            p.x += p.vx;
            p.y += p.vy;
            
            // Bounce off walls
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;

            // Look around
            p.angle += p.angleSpeed;
        } else if (currentEffect === 'grid') {
            const gridSize = 40;
            if (p.type === 'vertical') {
                p.x += p.speed;
                if (p.x > canvas.width) p.x = -gridSize;
            } else {
                p.y += p.speed;
                if (p.y > canvas.height) p.y = -gridSize;
            }
        } else if (currentEffect === 'slideshow') {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;
        } else if (currentEffect === 'soundwaves') {
            p.x += p.speed;
            p.phase += 0.1;
            if (p.x > w) p.x = -p.width;
        }
    });
}

function drawParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (currentEffect === 'wind') {
        // CFD-style streamlines with speed-based colors (blue=slow, cyan, green, yellow, red=fast)
        particles.forEach(p => {
            const t = p.speedRatio;
            let r, g, b;
            if (t < 0.25) {
                // Blue to Cyan
                const s = t / 0.25;
                r = 0; g = Math.floor(150 + 105 * s); b = 255;
            } else if (t < 0.5) {
                // Cyan to Green
                const s = (t - 0.25) / 0.25;
                r = 0; g = 255; b = Math.floor(255 * (1 - s));
            } else if (t < 0.75) {
                // Green to Yellow
                const s = (t - 0.5) / 0.25;
                r = Math.floor(255 * s); g = 255; b = 0;
            } else {
                // Yellow to Red
                const s = (t - 0.75) / 0.25;
                r = 255; g = Math.floor(255 * (1 - s)); b = 0;
            }
            ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.lineWidth = p.width;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + p.length, p.y);
            ctx.globalAlpha = p.opacity;
            ctx.stroke();
        });
    } else if (currentEffect === 'rain') {
        ctx.strokeStyle = 'rgba(120, 200, 255, 1)'; // Very bright cyan-blue
        ctx.lineCap = 'round';
        particles.forEach(p => {
            ctx.lineWidth = p.width;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + 2, p.y + p.length);
            ctx.globalAlpha = p.opacity;
            ctx.stroke();
        });
    } else if (currentEffect === 'sun') {
        const sun = particles[0];
        const cx = canvas.width / 2;
        const cy = canvas.height * 0.8;
        const radius = Math.min(canvas.width, canvas.height) * 0.4;
        
        const sunX = cx + Math.cos(sun.angle) * radius;
        const sunY = cy + Math.sin(sun.angle) * radius;
        
        const progress = (sun.angle - Math.PI) / Math.PI;
        let skyColor1;
        
        if (progress < 0.5) {
            const t = progress * 2;
            skyColor1 = `rgba(${255 * (1-t)}, ${100 + 155 * t}, ${255 * t}, 0.7)`; // Much higher opacity
        } else {
            const t = (progress - 0.5) * 2;
            skyColor1 = `rgba(${255 * t}, ${255 * (1-t)}, ${255 * (1-t)}, 0.7)`; // Much higher opacity
        }
        
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, skyColor1);
        gradient.addColorStop(1, 'rgba(255, 150, 50, 0.2)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw Sun with intense glow
        ctx.shadowBlur = 60;
        ctx.shadowColor = 'rgba(255, 150, 0, 1)';
        ctx.fillStyle = 'rgba(255, 220, 50, 1)';
        ctx.beginPath();
        ctx.arc(sunX, sunY, sun.radius, 0, Math.PI * 2);
        ctx.fill();
        
        // Inner bright core
        ctx.shadowBlur = 30;
        ctx.shadowColor = 'rgba(255, 255, 200, 1)';
        ctx.fillStyle = 'rgba(255, 255, 200, 1)';
        ctx.beginPath();
        ctx.arc(sunX, sunY, sun.radius * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        
    } else if (currentEffect === 'isovist') {
        particles.forEach(p => {
            ctx.save();
            
            // Draw Trail with glow
            if (p.trail && p.trail.length > 1) {
                ctx.beginPath();
                ctx.moveTo(p.trail[0].x, p.trail[0].y);
                for (let i = 1; i < p.trail.length; i++) {
                    ctx.lineTo(p.trail[i].x, p.trail[i].y);
                }
                ctx.lineTo(p.x, p.y);
                ctx.strokeStyle = `rgba(255, 100, 50, ${p.opacity * 0.8})`;
                ctx.lineWidth = 4;
                ctx.lineCap = 'round';
                ctx.stroke();
            }

            ctx.globalAlpha = p.opacity;
            
            // Draw circle with glow
            ctx.shadowBlur = 20;
            ctx.shadowColor = 'rgba(255, 100, 0, 0.8)';
            ctx.fillStyle = 'rgba(255, 120, 50, 1)';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            
            // Draw cone oriented to p.angle - brighter
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            
            ctx.fillStyle = 'rgba(255, 220, 100, 0.5)';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(180, -50);
            ctx.lineTo(180, 50);
            ctx.closePath();
            ctx.fill();
            
            ctx.restore();
        });
    } else if (currentEffect === 'grid') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; // Brighter white lines
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        particles.forEach(p => {
            if (p.type === 'vertical') {
                ctx.moveTo(p.x, 0);
                ctx.lineTo(p.x, canvas.height);
            } else {
                ctx.moveTo(0, p.y);
                ctx.lineTo(canvas.width, p.y);
            }
        });
        ctx.stroke();
    } else if (currentEffect === 'slideshow') {
        ctx.fillStyle = 'rgba(167, 139, 250, 0.9)'; // Very bright violet/purple
        particles.forEach(p => {
            ctx.globalAlpha = p.opacity;
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'rgba(139, 92, 246, 0.5)';
            ctx.fillRect(p.x, p.y, p.size, p.size * 0.6);
        });
        ctx.shadowBlur = 0;
    } else if (currentEffect === 'soundwaves') {
        particles.forEach(p => {
            ctx.strokeStyle = 'rgba(244, 114, 182, 1)'; // Very bright pink
            ctx.lineWidth = p.lineWidth || 4; // Use particle's line width
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.globalAlpha = p.opacity;
            for (let i = 0; i < p.width; i++) {
                const y = p.y + Math.sin(i * p.frequency + p.phase) * p.amplitude;
                if (i === 0) ctx.moveTo(p.x + i, y);
                else ctx.lineTo(p.x + i, y);
            }
            ctx.stroke();
        });
    }
    
    ctx.globalAlpha = 1;
}

function animate() {
    updateParticles();
    drawParticles();
    animationId = requestAnimationFrame(animate);
}

function setEffect(effectName) {
    if (currentEffect !== effectName) {
        currentEffect = effectName;
        initParticles(effectName);
    }
}

// Start animation loop
animate();

// Start tour initially (now that everything is defined)
startTour();

// Keyboard controls for slideshow navigation when slideshow is active
document.addEventListener('keydown', (e) => {
    // Check if slideshow button is active
    const slideshowBtn = document.querySelector('.control-btn[data-target="slideshow-btn"]');
    if (!slideshowBtn || !slideshowBtn.classList.contains('active')) return;
    if (!slideshowState.isActive) return;
    
    if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'next' });
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'previous' });
    } else if (e.key === 'Escape') {
        e.preventDefault();
        channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'stop' });
    }
});

// ===========================================
// Auto-Calibration System
// ===========================================

let autoCalibrator = null;
let calibratorScriptLoaded = false;

async function loadAutoCalibrator() {
    if (calibratorScriptLoaded) return true;
    
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'calibration/auto-calibrate.js';
        script.onload = () => {
            calibratorScriptLoaded = true;
            console.log('[Controller] AutoCalibrator script loaded');
            resolve(true);
        };
        script.onerror = () => {
            console.error('[Controller] Failed to load AutoCalibrator script');
            reject(new Error('Failed to load auto-calibrate.js'));
        };
        document.head.appendChild(script);
    });
}

async function initAutoCalibrator() {
    // Prevent re-initialization
    if (autoCalibrator) {
        return;
    }
    
    try {
        await loadAutoCalibrator();
    } catch (err) {
        console.error('Could not load auto-calibrator:', err);
        const statusEl = document.getElementById('camera-status');
        if (statusEl) statusEl.textContent = 'Error: Could not load calibrator';
        return;
    }
    
    // Initialize calibrator
    autoCalibrator = new window.AutoCalibrator({
        debug: true,
        tableWidth: parseFloat(document.getElementById('ctrl-table-w')?.value || 100),
        tableHeight: parseFloat(document.getElementById('ctrl-table-h')?.value || 60),
        screenWidth: parseFloat(document.getElementById('ctrl-screen-w')?.value || 111.93),
        screenHeight: parseFloat(document.getElementById('ctrl-screen-h')?.value || 62.96)
    });
    
    // Set up callbacks
    autoCalibrator.onDebugFrame = (canvas) => {
        const preview = document.getElementById('camera-preview');
        if (preview) {
            const ctx = preview.getContext('2d');
            preview.width = canvas.width;
            preview.height = canvas.height;
            ctx.drawImage(canvas, 0, 0);
        }
    };
    
    autoCalibrator.onStatusUpdate = (message) => {
        const statusEl = document.getElementById('camera-status');
        if (statusEl) statusEl.textContent = message;
    };
    
    autoCalibrator.onProgress = (progress) => {
        const progressContainer = document.getElementById('calibration-progress');
        const phaseEl = document.getElementById('calibration-phase');
        const iterationEl = document.getElementById('calibration-iteration');
        const progressBar = document.getElementById('calibration-progress-bar');
        
        if (!progressContainer) return;
        
        progressContainer.style.display = 'block';
        
        if (progress.phase === 'detecting') {
            phaseEl.textContent = `Detecting markers (${progress.markersFound}/4)`;
            iterationEl.textContent = `Sample ${progress.sample}/${progress.total}`;
            progressBar.style.width = `${(progress.sample / progress.total) * 100}%`;
        } else if (progress.phase === 'calibrating') {
            phaseEl.textContent = 'Calibrating...';
            iterationEl.textContent = `Iteration ${progress.iteration}/${progress.maxIterations}`;
            progressBar.style.width = `${(progress.iteration / progress.maxIterations) * 100}%`;
        } else if (progress.phase === 'adjusting') {
            phaseEl.textContent = `Adjusting (error: ${progress.error?.toFixed(1) || '?'}px)`;
            iterationEl.textContent = `Iteration ${progress.iteration}/${progress.maxIterations}`;
        }
    };
    
    // Populate camera list
    const cameraSelect = document.getElementById('ctrl-camera-select');
    if (cameraSelect) {
        try {
            // Request permission first to get device labels
            await navigator.mediaDevices.getUserMedia({ video: true })
                .then(stream => stream.getTracks().forEach(t => t.stop()))
                .catch(() => {});
            
            const cameras = await autoCalibrator.getCameras();
            console.log('[Controller] Available cameras:', cameras.map(c => c.label));
            
            cameraSelect.innerHTML = '<option value="">Select camera...</option>';
            cameras.forEach(cam => {
                const option = document.createElement('option');
                option.value = cam.deviceId;
                option.textContent = cam.label;
                cameraSelect.appendChild(option);
            });
            
            // Don't auto-start camera - let user manually select
            // Just pre-select an external camera if available
            if (cameras.length > 0) {
                const builtInKeywords = ['facetime', 'macbook', 'built-in', 'isight', 'internal', 'iphone'];
                const externalCamera = cameras.find(cam => {
                    const label = cam.label.toLowerCase();
                    return !builtInKeywords.some(keyword => label.includes(keyword));
                });
                
                if (externalCamera) {
                    // Pre-select the external camera in the dropdown, but don't start it
                    cameraSelect.value = externalCamera.deviceId;
                    console.log('[Controller] Pre-selected external camera:', externalCamera.label);
                }
                
                const statusEl = document.getElementById('camera-status');
                if (statusEl) statusEl.textContent = 'Select camera to start preview';
            }
        } catch (err) {
            console.error('Error getting cameras:', err);
            const statusEl = document.getElementById('camera-status');
            if (statusEl) statusEl.textContent = 'Camera access denied';
        }
        
        // Handle camera change
        cameraSelect.addEventListener('change', async () => {
            if (cameraSelect.value) {
                await startCameraPreview(cameraSelect.value);
            } else {
                autoCalibrator.stopPreview();
                const statusEl = document.getElementById('camera-status');
                if (statusEl) statusEl.textContent = 'No camera selected';
            }
        });
    }
    
    // Start auto-calibration button
    const startBtn = document.getElementById('ctrl-start-auto-calibrate');
    const stopBtn = document.getElementById('ctrl-stop-auto-calibrate');
    
    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            if (!autoCalibrator) return;
            
            startBtn.disabled = true;
            stopBtn.disabled = false;
            
            try {
                // Get current calibration values (we'll request from main window)
                const currentCalibration = await getCurrentCalibration();
                
                const cameraId = cameraSelect?.value || null;
                const result = await autoCalibrator.calibrate(channel, currentCalibration, cameraId);
                
                // Show result
                const statusEl = document.getElementById('camera-status');
                if (statusEl) {
                    statusEl.textContent = `Done! Zoom: ${result.zoom.toFixed(3)}, Bearing: ${result.bearing.toFixed(2)}°`;
                }
                
                // Restart preview
                if (cameraId) {
                    setTimeout(() => startCameraPreview(cameraId), 500);
                }
            } catch (err) {
                console.error('Calibration error:', err);
                const statusEl = document.getElementById('camera-status');
                if (statusEl) statusEl.textContent = 'Error: ' + err.message;
            } finally {
                startBtn.disabled = false;
                stopBtn.disabled = true;
            }
        });
    }
    
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            console.log('[Controller] Stop button clicked');
            if (autoCalibrator) {
                autoCalibrator.cancel();
                // Restart preview after stopping
                const cameraId = cameraSelect?.value;
                if (cameraId) {
                    setTimeout(() => startCameraPreview(cameraId), 300);
                }
            }
            startBtn.disabled = false;
            stopBtn.disabled = true;
            
            // Hide calibration markers
            channel.postMessage({
                type: MSG_TYPES.CALIBRATE_ACTION,
                action: 'hide_calibration_markers'
            });
        });
    }
}

async function startCameraPreview(deviceId) {
    if (!autoCalibrator) return;
    
    // Stop any existing preview first
    autoCalibrator.stopPreview();
    
    const statusEl = document.getElementById('camera-status');
    if (statusEl) statusEl.textContent = 'Starting preview...';
    
    try {
        await autoCalibrator.startPreview(deviceId);
    } catch (err) {
        console.error('Preview error:', err);
        if (statusEl) statusEl.textContent = 'Camera error: ' + err.message;
    }
}

function getCurrentCalibration() {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            // Use default values if we can't get current
            resolve({
                center: { lng: 11.977770568930168, lat: 57.68839377903814 },
                zoom: 15.806953679037164,
                bearing: -92.58546386659737
            });
        }, 2000);
        
        const handler = (event) => {
            if (event.data.type === 'calibration_data') {
                clearTimeout(timeout);
                channel.removeEventListener('message', handler);
                // Parse the calibration from the text response
                try {
                    const match = event.data.text.match(/JSON:\s*(\{[\s\S]*\})/);
                    if (match) {
                        resolve(JSON.parse(match[1]));
                    } else {
                        resolve({
                            center: { lng: 11.977770568930168, lat: 57.68839377903814 },
                            zoom: 15.806953679037164,
                            bearing: -92.58546386659737
                        });
                    }
                } catch (e) {
                    resolve({
                        center: { lng: 11.977770568930168, lat: 57.68839377903814 },
                        zoom: 15.806953679037164,
                        bearing: -92.58546386659737
                    });
                }
            }
        };
        
        channel.addEventListener('message', handler);
        channel.postMessage({ type: MSG_TYPES.CALIBRATE_ACTION, action: 'copy_calibration' });
    });
}

// ============================================
// STREET VIEW STATIC API SYSTEM (Controller Side)
// ============================================

let streetViewApiKey = null;
let streetViewCurrentPosition = null;
let streetViewCurrentHeading = 0;

async function loadStreetViewConfig() {
    if (streetViewApiKey) return true;
    try {
        const response = await fetch('trafik-config.json');
        const config = await response.json();
        streetViewApiKey = config.streetViewApiKey;
        console.log('Street View API key loaded');
        return true;
    } catch (e) {
        console.warn('Could not load Street View API key:', e);
        return false;
    }
}

function initStreetViewControls() {
    const leftBtn = document.getElementById('sv-rotate-left');
    const rightBtn = document.getElementById('sv-rotate-right');
    
    if (leftBtn) {
        leftBtn.addEventListener('click', () => {
            streetViewCurrentHeading = (streetViewCurrentHeading - 45 + 360) % 360;
            if (streetViewCurrentPosition) {
                updateStreetViewImage();
            }
        });
    }
    
    if (rightBtn) {
        rightBtn.addEventListener('click', () => {
            streetViewCurrentHeading = (streetViewCurrentHeading + 45) % 360;
            if (streetViewCurrentPosition) {
                updateStreetViewImage();
            }
        });
    }
}

function updateStreetViewImage() {
    const img = document.getElementById('street-view-image');
    const noCoverageMsg = document.getElementById('street-view-no-coverage');
    const coordsDisplay = document.getElementById('street-view-coords');
    const controls = document.getElementById('street-view-heading-controls');
    
    if (!img || !streetViewApiKey || !streetViewCurrentPosition) return;
    
    const { lat, lng } = streetViewCurrentPosition;
    
    // Update coordinates display
    if (coordsDisplay) {
        coordsDisplay.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)} | Heading: ${streetViewCurrentHeading}°`;
    }
    
    // Build Street View Static API URL
    const size = '640x350';
    const url = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${lat},${lng}&heading=${streetViewCurrentHeading}&pitch=0&fov=100&key=${streetViewApiKey}`;
    
    // Set up image load handlers
    img.onload = () => {
        // Check if we got an actual image (not the "no imagery" placeholder)
        // The static API returns a gray image with text if no coverage
        img.style.display = 'block';
        if (noCoverageMsg) noCoverageMsg.style.display = 'none';
        if (coordsDisplay) coordsDisplay.style.display = 'block';
        if (controls) controls.style.display = 'flex';
    };
    
    img.onerror = () => {
        img.style.display = 'none';
        if (coordsDisplay) coordsDisplay.style.display = 'none';
        if (noCoverageMsg) {
            noCoverageMsg.innerHTML = `
                <span style="font-size: 48px; margin-bottom: 12px;">📷</span>
                <span style="font-size: 16px; margin-bottom: 4px;">No Street View Coverage</span>
                <span style="font-size: 12px; color: #555;">Try clicking a different location on the map</span>
            `;
            noCoverageMsg.style.display = 'flex';
        }
        if (controls) controls.style.display = 'none';
    };
    
    img.src = url;
}

function updateStreetViewPosition(position, heading) {
    streetViewCurrentPosition = position;
    // Use provided heading or keep current if not provided
    if (heading !== undefined) {
        streetViewCurrentHeading = Math.round(heading);
    }
    
    // Load API key if needed
    if (!streetViewApiKey) {
        loadStreetViewConfig().then(hasKey => {
            if (hasKey) {
                updateStreetViewImage();
            }
        });
        return;
    }
    
    updateStreetViewImage();
}

// --- SAM Segmentation (Controller side) ---
const SAM_SERVER_URL = 'http://localhost:8000';

function setSamStatus(msg, ok) {
    const el = document.getElementById('sam-server-status');
    if (!el) return;
    el.textContent = 'SAM Server: ' + msg;
    el.style.color = ok ? '#22c55e' : '#ef4444';
}

async function checkSamServer() {
    try {
        const r = await fetch(SAM_SERVER_URL + '/');
        if (r.ok) {
            setSamStatus('Ready', true);
            return true;
        }
    } catch (e) {
        // ignore
    }
    setSamStatus('Unavailable', false);
    return false;
}

// Render an interactive SVG pie chart for segmentation categories
function renderSegmentationBarChart(segData) {
    const container = document.getElementById('sam-pie-chart');
    if (!container) return;

    const cats = (segData && segData.categories) ? segData.categories : {};
    const entries = Object.entries(cats).map(([k,v]) => ({
        name: k,
        percent: (v && v.pixel_ratio_percent) ? parseFloat(v.pixel_ratio_percent) : 0
    })).filter(e => e.percent > 0 || e.name === 'Open View' || e.name === 'Trees');

    if (entries.length === 0) {
        container.innerHTML = '<div style="color:#aaa; font-size:0.95rem;">No segmentation categories to display</div>';
        return;
    }

    // Distinct, intuitive palette
    const palette = {
        'Open View': '#1f78b4',
        'Trees': '#33a02c',
        'Bostad': '#e31a1c',
        'Verksamhet': '#ff7f00',
        'Samhällsfunktion': '#6a3d9a',
        'Komplementbyggnad': '#b15928',
        'Unknown': '#8c8c8c'
    };
    // Assign colors, fallback to palette cycling
    const fallback = ['#1f78b4','#33a02c','#e31a1c','#ff7f00','#6a3d9a','#b15928','#8c8c8c'];
    entries.forEach((e,i) => {
        e.color = palette[e.name] || fallback[i % fallback.length];
    });

    // Build bar chart
    container.innerHTML = '';
    const chart = document.createElement('div');
    chart.style.display = 'flex';
    chart.style.flexDirection = 'column';
    chart.style.gap = '8px';

    const total = entries.reduce((s,e)=>s+e.percent,0) || 1;
    entries.sort((a,b)=>b.percent - a.percent).forEach((e, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';

        const label = document.createElement('div');
        label.textContent = e.name;
        label.style.width = '110px';
        label.style.color = '#ddd';
        label.style.fontSize = '0.95rem';

        const barWrap = document.createElement('div');
        barWrap.style.flex = '1';
        barWrap.style.background = 'rgba(255,255,255,0.04)';
        barWrap.style.height = '18px';
        barWrap.style.borderRadius = '6px';
        barWrap.style.overflow = 'hidden';

        const bar = document.createElement('div');
        bar.style.height = '100%';
        bar.style.width = Math.max(1, (e.percent/total)*100) + '%';
        bar.style.background = e.color;
        bar.style.transition = 'width 0.2s, opacity 0.12s, transform 0.12s';

        const pct = document.createElement('div');
        pct.textContent = e.percent.toFixed(1) + '%';
        pct.style.width = '56px';
        pct.style.textAlign = 'right';
        pct.style.color = '#ddd';

        barWrap.appendChild(bar);
        row.appendChild(label);
        row.appendChild(barWrap);
        row.appendChild(pct);

        // interactions
        row.addEventListener('mouseenter', () => { bar.style.transform = 'scaleY(1.04)'; bar.style.opacity = '0.95'; showBarTooltip(e.name, e.percent, row); });
        row.addEventListener('mouseleave', () => { bar.style.transform = 'scaleY(1)'; bar.style.opacity = '1'; hideBarTooltip(); });
        row.addEventListener('click', () => {
            // toggle dimming
            const siblings = chart.querySelectorAll('div[data-role="bar-row"]');
            const isActive = row.getAttribute('data-active') === '1';
            siblings.forEach(s => { s.querySelector('div > div').style.opacity = '0.35'; s.setAttribute('data-active','0'); });
            if (!isActive) { row.querySelector('div > div').style.opacity = '1'; row.setAttribute('data-active','1'); }
        });

        row.setAttribute('data-role','bar-row');
        chart.appendChild(row);
    });

    // Tooltip
    let tooltip = container.querySelector('.bar-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'bar-tooltip';
        tooltip.style.position = 'absolute';
        tooltip.style.padding = '6px 8px';
        tooltip.style.background = 'rgba(0,0,0,0.85)';
        tooltip.style.color = '#fff';
        tooltip.style.borderRadius = '6px';
        tooltip.style.fontSize = '0.9rem';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.display = 'none';
        container.style.position = 'relative';
        container.appendChild(tooltip);
    }
    function showBarTooltip(name, pct, anchor) {
        tooltip.textContent = `${name}: ${pct.toFixed(2)}%`;
        tooltip.style.display = 'block';
        const rect = anchor.getBoundingClientRect();
        const parentRect = container.getBoundingClientRect();
        tooltip.style.left = Math.max(8, rect.left - parentRect.left + 8) + 'px';
        tooltip.style.top = (rect.top - parentRect.top - 34) + 'px';
    }
    function hideBarTooltip() { tooltip.style.display = 'none'; }

    container.appendChild(chart);
}

async function initSamSegmentation() {
    const btn = document.getElementById('sam-segment-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const img = document.getElementById('street-view-image');
        if (!img || !img.src || img.style.display === 'none') {
            alert('No Street View image available to segment');
            return;
        }

        const available = await checkSamServer();
        if (!available) {
            alert('SAM server not available at ' + SAM_SERVER_URL);
            return;
        }

        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = 'Segmenting...';
        setSamStatus('Processing...', true);

        try {
            const imageResp = await fetch(img.src);
            const imageBlob = await imageResp.blob();
            const fd = new FormData();
            fd.append('file', imageBlob, 'streetview.jpg');

            const resp = await fetch(SAM_SERVER_URL + '/segment', {
                method: 'POST',
                body: fd
            });

            if (!resp.ok) throw new Error('Server returned ' + resp.status);

            // If server returns JSON (mask as data URL + results), prefer that
            const contentType = (resp.headers.get('content-type') || '').toLowerCase();
            let segData = null;
            if (contentType.includes('application/json')) {
                const body = await resp.json();
                segData = body.results || body;

                // If mask is provided as a data URL, use it directly
                if (body.mask) {
                    const maskContainer = document.getElementById('sam-mask-container');
                    if (maskContainer) {
                        maskContainer.innerHTML = `<img src="${body.mask}" style="max-width:100%; border-radius:8px; border:2px solid #444; margin-bottom:0.5rem;" alt="Segmentation Mask" />`;
                    }
                }
            } else {
                // Older server: image blob + header JSON
                const maskBlob = await resp.blob();
                const segJson = resp.headers.get('X-Segmentation-JSON');

                // Prefer explicit mask file (e.g. *_mask.png) referenced in segmentation JSON
                let finalMaskBlob = maskBlob;
                if (segJson) {
                    try {
                        const data = JSON.parse(segJson);
                        const candidates = [];
                        if (data.mask_url) candidates.push(data.mask_url);
                        if (data.mask) candidates.push(data.mask);
                        if (data.mask_filename) candidates.push(data.mask_filename);
                        if (data.files && typeof data.files === 'object') {
                            Object.values(data.files).forEach(v => candidates.push(v));
                        }
                        if (data.output_files && typeof data.output_files === 'object') {
                            Object.values(data.output_files).forEach(v => candidates.push(v));
                        }

                        let chosen = null;
                        for (const c of candidates) {
                            if (!c) continue;
                            const s = String(c);
                            if (/mask/i.test(s) || /_mask\./i.test(s)) { chosen = s; break; }
                            if (/https?:\/\/.+\.(png|jpg|jpeg|webp)$/i.test(s)) { chosen = s; break; }
                        }

                        if (chosen) {
                            const candidateUrl = (/^https?:\/\//i.test(chosen)) ? chosen : (SAM_SERVER_URL + '/' + chosen.replace(/^\//, ''));
                            try {
                                const r2 = await fetch(candidateUrl);
                                if (r2.ok) {
                                    const b2 = await r2.blob();
                                    const ct = r2.headers.get('content-type') || '';
                                    if (ct.startsWith('image/') || b2.size > 0) {
                                        finalMaskBlob = b2;
                                    }
                                }
                            } catch (e) {
                                // ignore and fall back to returned blob
                            }
                        }
                        segData = data;
                    } catch (e) {
                        // invalid JSON - ignore
                    }
                }

                // Display mask
                const maskUrl = URL.createObjectURL(finalMaskBlob);
                const maskContainer = document.getElementById('sam-mask-container');
                if (maskContainer) {
                    maskContainer.innerHTML = `<img src="${maskUrl}" style="max-width:100%; border-radius:8px; border:2px solid #444; margin-bottom:0.5rem;" alt="Segmentation Mask" />`;
                }

                // If segData still null and segJson existed, segData was set above; otherwise try parse header
                if (!segData && segJson) {
                    try { segData = JSON.parse(segJson); } catch (e) { segData = null; }
                }
            }

            // Display class table and pie chart from segData if available
            if (segData) {
                const data = segData;
                const cats = data.categories || {};
                const palette = {
                    'Open View': '#1f78b4',
                    'Trees': '#33a02c',
                    'Bostad': '#e31a1c',
                    'Verksamhet': '#ff7f00',
                    'Samhällsfunktion': '#6a3d9a',
                    'Komplementbyggnad': '#b15928',
                    'Unknown': '#8c8c8c'
                };
                let table = '<table style="width:100%; font-size:1rem; color:#eee; border-collapse:collapse;">';
                table += '<tr><th style="text-align:left; color:#60a5fa;">Class</th></tr>';
                Object.entries(cats).sort((a,b)=> (b[1].pixel_ratio_percent||0) - (a[1].pixel_ratio_percent||0)).forEach(([cat, val]) => {
                    const color = palette[cat] || '#777';
                    table += `<tr><td style="padding:6px 4px; display:flex; align-items:center; gap:8px;"><span style="width:12px; height:12px; background:${color}; display:inline-block; border-radius:2px;"></span><span>${cat}</span></td></tr>`;
                });
                table += '</table>';
                const classTable = document.getElementById('sam-class-table');
                if (classTable) classTable.innerHTML = table;

                // Render interactive pie chart
                try { renderSegmentationBarChart(data); } catch (e) { console.error('Bar chart render error', e); }
            } else {
                const pieContainer = document.getElementById('sam-pie-chart');
                if (pieContainer) pieContainer.innerHTML = '';
            }

            setSamStatus('Done', true);
        } catch (err) {
            console.error('Segmentation error', err);
            setSamStatus('Error', false);
            alert('Segmentation failed: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    });

    // initial check
    checkSamServer();

    // Bind Spacebar to trigger segmentation (when not typing in an input)
    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        // Ignore if modifier keys are held
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
        // Prevent page scroll
        e.preventDefault();
        // Only trigger if button exists
        const segBtn = document.getElementById('sam-segment-btn');
        if (segBtn && !segBtn.disabled) {
            segBtn.click();
        }
    });
}

// bind when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSamSegmentation);
} else {
    initSamSegmentation();
}
