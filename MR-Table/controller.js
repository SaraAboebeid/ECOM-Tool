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


// State objects loaded from their respective module files:
// - slideshowState from controller/slideshow-dashboard.js
// - fccDemoState from controller/fcc-demo-dashboard.js
// - sunStudyState from controller/sun-study-ui.js



// Sun Study UI loaded from controller/sun-study-ui.js
// Exposes globals: sunStudyState, setSunStudyLayout, updateSunStudySky, etc.


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
    'campus-demo-btn',
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
        if (targetId === 'sun-study-btn') {
            setSunStudyLayout(false);
        }
        // Reset campus demo legend when it's deactivated
        if (targetId === 'campus-demo-btn') {
            resetCampusDemoLegend();
        }
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
    setSunStudyLayout(false);
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
    const mainPanel = document.getElementById('main-panel');

    // Check if already in sun study mode to avoid duplicate setup
    if (targetId === 'sun-study-btn' && mainPanel && mainPanel.classList.contains('sun-study-mode')) {
        return;
    }

    if (targetId !== 'sun-study-btn') {
        setSunStudyLayout(false);
    }

    // Reset titles by default
    if (dashboardTitle) dashboardTitle.textContent = 'Dashboard';
    if (legendTitle) legendTitle.textContent = 'Legend';
    
    // Hide SAM segmentation section by default (only shown for street-view-btn)
    const samSection = document.getElementById('sam-segmentation-section');
    if (samSection && targetId !== 'street-view-btn') {
        samSection.style.display = 'none';
    }
    
    // Campus Demo dashboard
    if (targetId === 'campus-demo-btn') {
        if (dashboardTitle) dashboardTitle.textContent = 'Campus Vision';
        if (legendTitle) legendTitle.textContent = 'Campus Vision Legend';

        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">school</span>
                        Chalmers Campus Vision
                    </div>
                    <div class="info-box" style="border-left-color: #3b82f6;">
                        <div class="info-title">Interactive Campus Presentation</div>
                        <p class="info-text">
                            Navigate through the campus vision with layers showing routes, activity nodes, and green spaces.
                        </p>
                    </div>
                    <p style="color: #888; margin-top: 1rem; font-size: 0.9rem;">
                        Press → to start, use ← → to navigate
                    </p>
                </div>
            </div>
        `;
        
        // Show the campus demo legend container, hide default
        const campusLegend = document.getElementById('campus-demo-legend');
        if (campusLegend) {
            legendContent.style.display = 'none';
            campusLegend.style.display = 'block';
        } else {
            legendContent.innerHTML = `
                <div class="dashboard-card">
                    <div class="dashboard-section-title">Ready to Start</div>
                    <p style="color: #888;">Press → to begin the presentation</p>
                </div>
            `;
        }
        
        // Show Campus Demo Contributors in the metadata section
        const metadataContent = document.getElementById('metadata-content');
        const metadataSection = metadataContent?.parentElement;
        if (metadataSection) {
            const metadataTitle = metadataSection.querySelector('h2');
            if (metadataTitle) metadataTitle.textContent = 'Contributors';
            metadataContent.className = 'credits-grid';
            metadataContent.innerHTML = `
                <div class="credit-item">
                    <div class="credit-role">Chalmers Fastigheter</div>
                    <div class="credit-name">Ida Gäskeby</div>
                </div>
                <div class="credit-item">
                    <div class="credit-role">Spacescape</div>
                    <div class="credit-contribution">Spatial Planning & Analysis</div>
                    <div class="credit-name">Selma Sinanovic Gabrallah</div>
                    <div class="credit-name">Malin Dahlhielm</div>
                </div>
                <div class="credit-item">
                    <div class="credit-role">Chalmers Rektors Office</div>
                    <div class="credit-name">Stefan Forsaeus Nilsson</div>
                    <div class="credit-contribution">Rådgivare, Ledningskansliet, Chalmers verksamhetsstöd</div>
                </div>
                <div class="credit-item">
                    <div class="credit-role">Visualisation Developer</div>
                    <div class="credit-name">Sanjay Somanath</div>
                </div>
            `;
        }
        
        return;
    }

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
        setSunStudyLayout(true);

        if (dashboardTitle) dashboardTitle.textContent = 'Sun Study Sky';
        if (legendTitle) legendTitle.textContent = 'Sun Study';

        const timeLabel = `${Math.floor(sunStudyState.time).toString().padStart(2, '0')}:${Math.floor((sunStudyState.time % 1) * 60).toString().padStart(2, '0')}`;

        dashboardContent.innerHTML = `
            <div class="sun-sky-card">
                <div id="sun-sky" class="sun-sky">
                    <svg class="sun-path" viewBox="0 0 100 100" preserveAspectRatio="none">
                        <path d="M10 70 Q50 10 90 70" stroke="rgba(255,255,255,0.35)" stroke-width="0.6" fill="none" stroke-dasharray="2 2" />
                    </svg>
                    <div class="sun-cloud"></div>
                    <div class="sun-cloud cloud-2"></div>
                    <div id="sun-orb" class="sun-orb"></div>
                    <div class="sun-horizon"></div>
                    <div class="sun-time-center">
                        <div id="sun-time-label" class="sun-time">${timeLabel}</div>
                        <div id="sun-date-label" class="sun-date">${formatSunDate(sunStudyState.date)}</div>
                    </div>
                    <div class="sunrise-label">Sunrise <span id="sunrise-time">06:00</span></div>
                    <div class="sunset-label">Sunset <span id="sunset-time">18:00</span></div>
                </div>
            </div>
        `;

        if (legendContent) legendContent.innerHTML = '';

        const metadataContent = document.getElementById('metadata-content');
        if (metadataContent) {
            metadataContent.innerHTML = `
                <div class="sun-study-bottom-grid">
                    <div class="sun-compact-card">
                        <div class="sun-compact-title">Controls</div>
                        <div class="sun-compact-row">
                            <label>Date</label>
                            <input type="date" id="sun-date" class="modern-date" value="${sunStudyState.date}">
                        </div>
                        <div class="sun-compact-row">
                            <label>Time</label>
                            <input type="range" id="sun-time" class="modern-range" min="0" max="24" step="0.25" value="${sunStudyState.time}">
                            <span id="time-display" class="control-value">${timeLabel}</span>
                        </div>
                        <div class="sun-compact-row">
                            <label>Shadow Opacity</label>
                            <input type="range" id="shadow-opacity" class="modern-range" min="0.1" max="1.0" step="0.1" value="0.8">
                        </div>
                        <div class="sun-compact-row">
                            <label>Speed</label>
                            <input type="range" id="sun-speed" class="modern-range" min="0.5" max="5" step="0.5" value="2">
                            <span id="speed-display" class="control-value">2x</span>
                        </div>
                        <div class="action-grid" style="grid-template-columns: repeat(3, 1fr);">
                            <button id="sun-animate-btn" class="modern-btn primary">
                                <span class="material-icons">play_arrow</span>
                                Animate
                            </button>
                            <button id="false-color-btn" class="modern-btn">
                                <span class="material-icons">palette</span>
                                False
                            </button>
                            <button id="toggle-trees-btn" class="modern-btn">
                                <span class="material-icons">park</span>
                                Trees
                            </button>
                        </div>
                    </div>

                    <div class="sun-compact-card">
                        <div class="sun-compact-title">Live Sun</div>
                        <div class="sun-compact-row">
                            <span>Altitude</span>
                            <span id="altitude-display" class="control-value">--</span>
                        </div>
                        <div class="sun-compact-row">
                            <span>Azimuth</span>
                            <span id="azimuth-display" class="control-value">--</span>
                        </div>
                        <div class="sun-compact-row">
                            <span>Trees</span>
                            <span id="trees-status-display" class="control-value">Off</span>
                        </div>
                    </div>

                    <div class="sun-compact-card">
                        <div class="sun-compact-title">Legend</div>
                        <div class="sun-compact-legend">
                            <div class="legend-item">
                                <div class="legend-color" style="background: rgba(0,0,0,0.5);"></div>
                                <span class="legend-label">Shadow Cast</span>
                            </div>
                            <div class="legend-item">
                                <div class="legend-color" style="background: linear-gradient(to right, #f5d866, #ff6626, #f23319);"></div>
                                <span class="legend-label">Sun Exposure</span>
                            </div>
                            <div class="legend-item">
                                <div class="legend-color" style="background: #26409a;"></div>
                                <span class="legend-label">Building/Terrain</span>
                            </div>
                            <div class="legend-item">
                                <div class="legend-color" style="background: #268040;"></div>
                                <span class="legend-label">Tree Shadow</span>
                            </div>
                            <div class="legend-item">
                                <div class="legend-color" style="background: #8c268c;"></div>
                                <span class="legend-label">Combined</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

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

        if (dateInput) {
            dateInput.addEventListener('change', (e) => {
                sunStudyState.date = e.target.value;
                updateSunStudySky(sunStudyState.time, sunStudyState.date);
                sendControl('set_date', e.target.value);
            });
        }
        
        if (timeInput && timeDisplay) {
            timeInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const h = Math.floor(val);
                const m = Math.floor((val - h) * 60);
                timeDisplay.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
                sunStudyState.time = val;
                updateSunStudySky(val, sunStudyState.date);
                sendControl('set_time', val);
            });
        }

        if (opacityInput) {
            opacityInput.addEventListener('input', (e) => sendControl('set_opacity', e.target.value));
        }
        
        if (animateBtn) {
            animateBtn.addEventListener('click', () => {
                animateBtn.classList.toggle('active');
                const isActive = animateBtn.classList.contains('active');
                animateBtn.innerHTML = isActive 
                    ? '<span class="material-icons">pause</span> Pause'
                    : '<span class="material-icons">play_arrow</span> Animate';
                sendControl('toggle_animation');
            });
        }

        if (speedInput && speedDisplay) {
            speedInput.addEventListener('input', (e) => {
                speedDisplay.textContent = e.target.value + 'x';
                sendControl('set_speed', e.target.value);
            });
        }

        if (falseColorBtn) {
            falseColorBtn.addEventListener('click', () => {
                falseColorBtn.classList.toggle('active');
                sendControl('toggle_false_color');
            });
        }

        const toggleTreesBtn = document.getElementById('toggle-trees-btn');
        if (toggleTreesBtn) {
            toggleTreesBtn.addEventListener('click', () => {
                toggleTreesBtn.classList.toggle('active');
                sendControl('toggle_trees');
            });
        }

        // Update sky visualization
        updateSunStudySky(sunStudyState.time, sunStudyState.date);
        
        // Sync initial date and time to sun-study.js
        sendControl('set_date', sunStudyState.date);
        sendControl('set_time', sunStudyState.time);

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
                            <option value="200" selected>Low</option>
                            <option value="500">Medium</option>
                            <option value="1000">High</option>
                        </select>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Particle Speed</label>
                        <input type="range" id="particle-speed" class="modern-range" min="2" max="40" step="2" value="20">
                        <span id="particle-speed-display" class="control-value">20x</span>
                    </div>

                    <div class="control-row">
                        <label class="control-label">Viscosity</label>
                        <input type="range" id="viscosity" class="modern-range" min="0" max="1" step="0.1" value="0">
                    </div>

                    <div class="control-row">
                        <label class="control-label">Grid Resolution</label>
                        <select id="grid-resolution" class="modern-date" style="width: 100px;">
                            <option value="100" selected>100 (Fast)</option>
                            <option value="150">150</option>
                            <option value="200">200 (Normal)</option>
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
            </div>
        `;

        // Set metadata to Educational Context for CFD
        const metadataContent = document.getElementById('metadata-content');
        const metadataSection = metadataContent?.parentElement;
        if (metadataSection) {
            const metadataTitle = metadataSection.querySelector('h2');
            if (metadataTitle) metadataTitle.textContent = 'Educational Context';
            metadataContent.innerHTML = `
                <div class="dashboard-card" style="border: none; background: transparent; padding: 0;">
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
            `;
        }
        
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
        
        // Show SAM segmentation section for Street View
        const samSection = document.getElementById('sam-segmentation-section');
        if (samSection) samSection.style.display = 'block';
        
    } else {
        // Default or other tools
        dashboardContent.innerHTML = '<p>Select a simulation to view details.</p>';
        legendContent.innerHTML = '<p>Select a simulation to view its legend.</p>';
        
        // Hide SAM segmentation section for non-Street View
        const samSection = document.getElementById('sam-segmentation-section');
        if (samSection) samSection.style.display = 'none';
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
        updateSunStudySky(sunStudyState.time, sunStudyState.date, data.altitude);
    } else if (data.type === MSG_TYPES.SUN_TIME_UPDATE) {
        const timeSlider = document.getElementById('sun-time');
        const timeDisplay = document.getElementById('time-display');
        if (timeSlider && timeDisplay) {
            timeSlider.value = data.time;
            const h = Math.floor(data.time);
            const m = Math.floor((data.time - h) * 60);
            timeDisplay.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
        }
        sunStudyState.time = data.time;
        updateSunStudySky(data.time, sunStudyState.date);
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
    } else if (data.type === 'campus_demo_phase') {
        // Update campus demo legend based on current phase
        updateCampusDemoLegend(data.phase, data.phaseIndex, data.label);
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


// Isovist dashboard loaded from controller/isovist-dashboard.js
// Bird dashboard loaded from controller/bird-dashboard.js



// FCC demo dashboard loaded from controller/fcc-demo-dashboard.js



// Campus demo legend loaded from controller/campus-demo-legend.js



// Slideshow dashboard loaded from controller/slideshow-dashboard.js


function updateMetadata(layerId) {
    welcomeScreen.classList.add('hidden');
    
    // Sun Study uses custom layout - skip standard metadata update
    if (layerId === 'sun-study-btn') {
        return;
    }
    
    const metaLayer = document.getElementById('meta-layer');
    const metaDesc = document.getElementById('meta-desc');
    const legendContent = document.getElementById('legend-content');
    
    // Guard against null elements (can happen if layout was modified)
    if (!metaLayer || !metaDesc || !legendContent) {
        return;
    }
    
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


// Tour logic loaded from controller/tour.js

// Background animation loaded from controller/bg-animation.js
// Exposes global: setEffect(effectName)

// Start tour initially (now that everything is defined)
startTour();


// Keyboard controls for slideshow navigation when slideshow is active
document.addEventListener('keydown', (e) => {
    // Check if slideshow button is active
    const slideshowBtn = document.querySelector('.control-btn[data-target="slideshow-btn"]');
    if (slideshowBtn && slideshowBtn.classList.contains('active') && slideshowState.isActive) {
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
        return;
    }
    
    // Check if campus demo button is active
    const campusDemoBtn = document.querySelector('.control-btn[data-target="campus-demo-btn"]');
    if (campusDemoBtn && campusDemoBtn.classList.contains('active')) {
        if (e.key === ' ') {
            e.preventDefault();
            channel.postMessage({ type: 'campus_demo_control', action: 'autoplay' });
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            channel.postMessage({ type: 'campus_demo_control', action: 'next' });
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            channel.postMessage({ type: 'campus_demo_control', action: 'previous' });
        } else if (e.key === 'Escape') {
            e.preventDefault();
            channel.postMessage({ type: 'campus_demo_control', action: 'stop' });
        }
        return;
    }
});


// Auto-Calibration loaded from controller/auto-calibration.js


// Street View + SAM loaded from controller/street-view.js

