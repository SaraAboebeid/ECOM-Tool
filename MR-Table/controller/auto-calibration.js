// Auto-Calibration System (extracted from controller.js)
// =============================================
// Handles camera-based auto-calibration for projector alignment.
// Exposes globals: autoCalibrator, loadAutoCalibrator, initAutoCalibrator,
//   startCameraPreview, getCurrentCalibration
// Dependencies (resolved at call time): channel, MSG_TYPES

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
