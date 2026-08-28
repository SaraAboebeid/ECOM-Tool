/**
 * Camera-based Auto-Calibration System
 * =====================================
 * Uses computer vision to detect ArUco markers on the physical table
 * and automatically adjusts map zoom/rotation/center to align the
 * digital overlay with the physical model.
 * 
 * This version detects 4 ArUco markers (DICT_4X4_50, IDs 0-3) placed at 
 * corners of a 20x20cm reference tile. Works with grayscale printing.
 * 
 * Requirements:
 * - 4 ArUco markers printed on a 20x20cm tile
 * - Markers at corners: #0=TL, #1=TR, #2=BR, #3=BL
 * - Camera positioned to view the tile area
 */

class AutoCalibrator {
    constructor(options = {}) {
        // Configuration
        this.config = {
            // Physical table dimensions in cm
            tableWidth: options.tableWidth || 100,
            tableHeight: options.tableHeight || 60,
            
            // Reference tile dimensions in cm (defined by ArUco markers)
            tileSize: options.tileSize || 20,
            
            // Tile position from top-left corner of table (cm)
            tileOffsetX: options.tileOffsetX || 5,
            tileOffsetY: options.tileOffsetY || 5,
            
            // Screen dimensions in cm
            screenWidth: options.screenWidth || 111.93,
            screenHeight: options.screenHeight || 62.96,
            
            // ArUco detection settings
            markerSizeMin: 8,   // Minimum marker size in pixels (lowered for high-res cameras)
            markerSizeMax: 400, // Maximum marker size in pixels (increased for close-up views)
            
            // Calibration settings
            numSamples: options.numSamples || 15,
            sampleInterval: options.sampleInterval || 200, // ms
            
            // Convergence thresholds
            positionThreshold: 5, // pixels
            maxIterations: 15,
            
            // Debug mode
            debug: options.debug !== false // Default true
        };
        
        // ArUco 4x4 patterns (DICT_4X4_50, IDs 0-3)
        // Inner 4x4 data bits only (border is always black)
        // 0 = black (dark), 1 = white (light) - matches detection threshold
        // Extracted from the 6x6 patterns, rows 1-4, cols 1-4
        this.arucoPatterns = {
            // From HTML: inner where 1=black in HTML, inverted here so 0=black
            // HTML 0 inner (1=black): [[0,1,0,0],[1,0,1,1],[0,1,1,0],[0,1,0,0]]
            0: [[1,0,1,1],[0,1,0,0],[1,0,0,1],[1,0,1,1]],
            // HTML 1 inner (1=black): [[1,0,1,1],[0,0,0,1],[1,1,1,0],[0,0,1,1]]
            1: [[0,1,0,0],[1,1,1,0],[0,0,0,1],[1,1,0,0]],
            // HTML 2 inner (1=black): [[1,0,0,0],[0,1,0,0],[0,0,0,1],[1,0,0,1]]
            2: [[0,1,1,1],[1,0,1,1],[1,1,1,0],[0,1,1,0]],
            // HTML 3 inner (1=black): [[0,0,0,0],[1,1,0,0],[0,0,1,1],[0,1,1,0]]
            3: [[1,1,1,1],[0,0,1,1],[1,1,0,0],[1,0,0,1]]
        };
        
        // State
        this.video = null;
        this.canvas = null;
        this.ctx = null;
        this.isCalibrating = false;
        this.stream = null;
        this._previewLoopId = 0; // Used to cancel old preview loops
        
        // Camera rotation offset (radians) - compensates for tilted camera mount
        this.cameraRotationOffset = 0;
        
        // Callbacks
        this.onProgress = null;
        this.onDebugFrame = null;
        this.onStatusUpdate = null;
        
        // Current calibration
        this.currentCalibration = null;
    }

    /**
     * Start camera capture
     */
    async startCamera(deviceId = null) {
        // Stop any existing camera/preview first
        this.stopCamera();
        
        try {
            this.updateStatus('Requesting camera access...');
            
            const constraints = {
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    deviceId: deviceId ? { exact: deviceId } : undefined
                }
            };
            
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            this.video = document.createElement('video');
            this.video.srcObject = this.stream;
            this.video.autoplay = true;
            this.video.playsInline = true;
            
            await new Promise((resolve, reject) => {
                this.video.onloadedmetadata = () => {
                    this.video.play().then(resolve).catch(reject);
                };
                setTimeout(() => reject(new Error('Video load timeout')), 5000);
            });
            
            // Create processing canvas
            this.canvas = document.createElement('canvas');
            this.canvas.width = this.video.videoWidth;
            this.canvas.height = this.video.videoHeight;
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
            
            this.log(`Camera started: ${this.canvas.width}x${this.canvas.height}`);
            this.updateStatus(`Camera ready: ${this.canvas.width}x${this.canvas.height}`);
            return true;
        } catch (err) {
            this.log('Camera error: ' + err.message);
            this.updateStatus('Camera error: ' + err.message);
            throw new Error('Could not access camera: ' + err.message);
        }
    }

    /**
     * Get list of available cameras
     */
    async getCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices
                .filter(d => d.kind === 'videoinput')
                .map((d, i) => ({
                    deviceId: d.deviceId,
                    label: d.label || `Camera ${i + 1}`
                }));
        } catch (err) {
            return [];
        }
    }

    /**
     * Stop camera
     */
    stopCamera() {
        // Increment loop ID to immediately invalidate any running preview loops
        this._previewLoopId++;
        
        // Reset throttle timer so new camera starts fresh
        this._lastPreviewTime = null;
        
        if (this.video) {
            this.video.pause();
            this.video.srcObject = null;
            this.video.onloadedmetadata = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        // Clear canvas to prevent showing stale frames
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.video = null;
        this.canvas = null;
        this.ctx = null;
    }

    /**
     * Create grayscale array from image data
     */
    toGrayscale(imageData) {
        const data = imageData.data;
        const w = imageData.width;
        const h = imageData.height;
        const gray = new Uint8Array(w * h);
        
        for (let i = 0; i < w * h; i++) {
            const j = i * 4;
            gray[i] = Math.round((data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114));
        }
        return gray;
    }

    /**
     * Build integral image for fast box sum computation
     */
    buildIntegralImage(gray, w, h) {
        const integral = new Uint32Array((w + 1) * (h + 1));
        const iw = w + 1;
        
        for (let y = 0; y < h; y++) {
            let rowSum = 0;
            for (let x = 0; x < w; x++) {
                rowSum += gray[y * w + x];
                integral[(y + 1) * iw + (x + 1)] = rowSum + integral[y * iw + (x + 1)];
            }
        }
        return integral;
    }

    /**
     * Apply adaptive threshold using integral image - O(1) per pixel instead of O(blockSize²)
     */
    adaptiveThreshold(gray, w, h, blockSize = 15) {
        const binary = new Uint8Array(w * h);
        const halfBlock = Math.floor(blockSize / 2);
        
        // Build integral image for O(1) box sum queries
        const integral = this.buildIntegralImage(gray, w, h);
        const iw = w + 1;
        
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                // Clamp box coordinates
                const x1 = Math.max(0, x - halfBlock);
                const y1 = Math.max(0, y - halfBlock);
                const x2 = Math.min(w - 1, x + halfBlock);
                const y2 = Math.min(h - 1, y + halfBlock);
                
                const count = (x2 - x1 + 1) * (y2 - y1 + 1);
                
                // Sum using integral image: I(D) - I(B) - I(C) + I(A)
                const sum = integral[(y2 + 1) * iw + (x2 + 1)]
                          - integral[(y1) * iw + (x2 + 1)]
                          - integral[(y2 + 1) * iw + (x1)]
                          + integral[(y1) * iw + (x1)];
                
                const mean = sum / count;
                const idx = y * w + x;
                // Pixel is "dark" if significantly darker than local average
                binary[idx] = gray[idx] < mean - 7 ? 0 : 255;
            }
        }
        return binary;
    }

    /**
     * Find marker candidates using sliding window (simpler, more reliable)
     */
    findMarkerCandidates(gray, binary, w, h) {
        const candidates = [];
        const minSize = this.config.markerSizeMin;
        const maxSize = this.config.markerSizeMax;
        
        // Scan with multiple window sizes - use very fine steps to not miss markers
        for (let size = minSize; size <= maxSize; size += 6) {
            const step = Math.max(3, Math.floor(size / 8));
            
            // Two passes with offset to catch markers between grid lines
            for (let offsetPass = 0; offsetPass < 2; offsetPass++) {
                const offset = offsetPass * Math.floor(step / 2);
                
                for (let y = offset; y < h - size; y += step) {
                    for (let x = offset; x < w - size; x += step) {
                        // Check if this could be a marker (has black border with lighter interior)
                        if (this.hasBlackBorder(gray, w, x, y, size)) {
                            // Create corner points for perspective transform
                            const corners = [
                                { x: x, y: y },
                                { x: x + size, y: y },
                                { x: x + size, y: y + size },
                                { x: x, y: y + size }
                            ];
                            
                            candidates.push({
                                x, y,
                                width: size,
                                height: size,
                                centerX: x + size / 2,
                                centerY: y + size / 2,
                                corners: corners
                        });
                        // Don't skip ahead - let overlap filtering handle it
                    }
                }
            }
            } // end offsetPass loop
        }
        
        // Remove overlapping candidates, keep best scoring ones
        return this.filterOverlappingCandidates(candidates, gray, w);
    }

    /**
     * Check if a region has a black border (characteristic of ArUco markers)
     */
    hasBlackBorder(gray, w, x, y, size) {
        const cellSize = size / 6;
        let borderSum = 0;
        let borderCount = 0;
        let innerSum = 0;
        let innerCount = 0;
        
        // Sample multiple points per cell for robustness
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) {
                // Sample 3x3 grid within each cell
                let cellSum = 0, cellCount = 0;
                for (let si = -1; si <= 1; si++) {
                    for (let sj = -1; sj <= 1; sj++) {
                        const px = Math.floor(x + (j + 0.5 + sj * 0.2) * cellSize);
                        const py = Math.floor(y + (i + 0.5 + si * 0.2) * cellSize);
                        
                        if (px >= 0 && px < w && py >= 0 && py < gray.length / w) {
                            cellSum += gray[py * w + px];
                            cellCount++;
                        }
                    }
                }
                
                if (cellCount === 0) continue;
                const cellAvg = cellSum / cellCount;
                
                if (i === 0 || i === 5 || j === 0 || j === 5) {
                    borderSum += cellAvg;
                    borderCount++;
                } else {
                    innerSum += cellAvg;
                    innerCount++;
                }
            }
        }
        
        if (borderCount === 0 || innerCount === 0) return false;
        
        const borderAvg = borderSum / borderCount;
        const innerAvg = innerSum / innerCount;
        
        // Border should be darker than inner with reasonable contrast
        // Relaxed thresholds: border < 150 (was 100), contrast > 20 (was 30)
        return borderAvg < 150 && borderAvg < innerAvg - 20;
    }

    /**
     * Filter overlapping candidates, keeping the best ones
     */
    filterOverlappingCandidates(candidates, gray, w) {
        if (candidates.length === 0) return [];
        
        // Score each candidate by contrast
        const scored = candidates.map(c => ({
            ...c,
            score: this.scoreCandidate(gray, w, c)
        }));
        
        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);
        
        // Non-maximum suppression
        const kept = [];
        for (const c of scored) {
            let dominated = false;
            for (const k of kept) {
                const overlapX = Math.max(0, Math.min(c.x + c.width, k.x + k.width) - Math.max(c.x, k.x));
                const overlapY = Math.max(0, Math.min(c.y + c.height, k.y + k.height) - Math.max(c.y, k.y));
                const overlapArea = overlapX * overlapY;
                const cArea = c.width * c.height;
                
                if (overlapArea > cArea * 0.5) {
                    dominated = true;
                    break;
                }
            }
            if (!dominated) {
                kept.push(c);
            }
        }
        
        return kept;
    }

    /**
     * Score a candidate by how well it matches marker characteristics
     * Higher score = more likely to be a valid marker
     */
    scoreCandidate(gray, w, c) {
        // For contour-based candidates with corners, use perspective scoring
        if (c.corners) {
            return c.perimeter || 100; // Larger markers score higher
        }
        
        const cellSize = c.width / 6;
        let borderSum = 0, borderCount = 0;
        let innerSum = 0, innerCount = 0;
        
        // Sample all cells
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) {
                const px = Math.floor(c.x + (j + 0.5) * cellSize);
                const py = Math.floor(c.y + (i + 0.5) * cellSize);
                
                if (px < 0 || px >= w) continue;
                
                const val = gray[py * w + px];
                
                if (i === 0 || i === 5 || j === 0 || j === 5) {
                    borderSum += val;
                    borderCount++;
                } else {
                    innerSum += val;
                    innerCount++;
                }
            }
        }
        
        if (borderCount === 0 || innerCount === 0) return 0;
        
        const borderAvg = borderSum / borderCount;
        const innerAvg = innerSum / innerCount;
        
        // Score based on: dark border + contrast with inner
        const contrast = innerAvg - borderAvg;
        const darkness = 255 - borderAvg;
        
        return contrast + darkness * 0.5;
    }

    /**
     * Try to identify ArUco marker ID from a candidate region
     * Uses direct sampling with Otsu thresholding
     */
    identifyMarker(gray, w, h, candidate) {
        const { x, y, width, height } = candidate;
        
        // Sample the inner 4x4 grid (skip the border)
        const cellW = width / 6;
        const cellH = height / 6;
        
        // Collect all sample values first
        const samples = [];
        for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 4; col++) {
                const cx = Math.floor(x + (col + 1.5) * cellW);
                const cy = Math.floor(y + (row + 1.5) * cellH);
                
                // Average a small region for more robust sampling
                let sum = 0, count = 0;
                const sampleRadius = Math.max(2, Math.floor(cellW / 4));
                for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
                    for (let dx = -sampleRadius; dx <= sampleRadius; dx++) {
                        const px = cx + dx;
                        const py = cy + dy;
                        if (px >= 0 && px < w && py >= 0 && py < h) {
                            sum += gray[py * w + px];
                            count++;
                        }
                    }
                }
                samples.push(count > 0 ? sum / count : 128);
            }
        }
        
        // Use Otsu threshold
        const threshold = this.computeOtsuThreshold(samples);
        const range = Math.max(...samples) - Math.min(...samples);
        
        // Need sufficient contrast (relaxed for varied lighting)
        if (range < 30) return null;
        
        // Build binary grid
        const grid = [];
        for (let row = 0; row < 4; row++) {
            grid[row] = [];
            for (let col = 0; col < 4; col++) {
                // 0 = black (dark), 1 = white (bright)
                grid[row][col] = samples[row * 4 + col] > threshold ? 1 : 0;
            }
        }
        
        // Debug: log rejected candidates (no match found)
        if (this._gridDebugCount === undefined) this._gridDebugCount = 0;
        if (this._gridDebugCount < 10) {
            this._gridDebugCount++;
            this.log(`[ArUco] Grid: ${JSON.stringify(grid)}, range: ${range.toFixed(0)}, thresh: ${threshold.toFixed(0)}, minVal: ${Math.min(...samples).toFixed(0)}, maxVal: ${Math.max(...samples).toFixed(0)}`);
        }
        
        // Compare with known patterns (and rotations)
        // Find the BEST match, not just any match
        let bestMatch = null;
        let bestMismatches = 16;
        
        for (let id = 0; id < 4; id++) {
            for (let rotation = 0; rotation < 4; rotation++) {
                const pattern = this.rotatePattern(this.arucoPatterns[id], rotation);
                const mismatches = this.countPatternMismatches(grid, pattern);
                if (mismatches < bestMismatches) {
                    bestMismatches = mismatches;
                    bestMatch = { id, rotation, grid, mismatches };
                }
            }
        }
        
        // Accept if confident (allow 2 mismatches for robustness to noise/lighting)
        if (bestMatch && bestMismatches <= 2) {
            return bestMatch;
        }
        
        // Log near-matches for debugging
        if (bestMatch && bestMismatches <= 4 && this._nearMissCount === undefined) {
            this._nearMissCount = 0;
        }
        if (bestMatch && bestMismatches <= 4 && this._nearMissCount < 10) {
            this._nearMissCount++;
            this.log(`[NEAR MISS] Best was ID #${bestMatch.id} with ${bestMismatches} mismatches`);
        }
        
        return null;
    }

    /**
     * Compute Otsu threshold for bimodal distribution
     */
    computeOtsuThreshold(data) {
        const histogram = new Array(256).fill(0);
        for (const val of data) {
            histogram[Math.min(255, Math.max(0, Math.round(val)))]++;
        }
        
        const total = data.length;
        let sum = 0;
        for (let i = 0; i < 256; i++) {
            sum += i * histogram[i];
        }
        
        let sumB = 0, wB = 0, wF = 0;
        let maxVariance = 0, threshold = 128;
        
        for (let t = 0; t < 256; t++) {
            wB += histogram[t];
            if (wB === 0) continue;
            
            wF = total - wB;
            if (wF === 0) break;
            
            sumB += t * histogram[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            
            const variance = wB * wF * (mB - mF) * (mB - mF);
            if (variance > maxVariance) {
                maxVariance = variance;
                threshold = t;
            }
        }
        
        return threshold;
    }

    /**
     * Rotate a 4x4 pattern by 90 degrees * times
     */
    rotatePattern(pattern, times) {
        let result = pattern;
        for (let t = 0; t < times; t++) {
            const rotated = [];
            for (let i = 0; i < 4; i++) {
                rotated[i] = [];
                for (let j = 0; j < 4; j++) {
                    rotated[i][j] = result[3 - j][i];
                }
            }
            result = rotated;
        }
        return result;
    }

    /**
     * Check if two 4x4 patterns match (with minimal tolerance)
     * Returns number of mismatches (0 = perfect match)
     */
    countPatternMismatches(a, b) {
        let mismatches = 0;
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (a[i][j] !== b[i][j]) {
                    mismatches++;
                }
            }
        }
        return mismatches;
    }

    /**
     * Check if two 4x4 patterns match (strict - max 1 mismatch allowed)
     */
    matchPattern(a, b) {
        return this.countPatternMismatches(a, b) <= 1;
    }

    /**
     * Deduplicate candidates from multiple threshold passes
     */
    deduplicateCandidates(candidates) {
        if (candidates.length === 0) return [];
        
        const unique = [];
        const threshold = 20; // pixels
        
        for (const c of candidates) {
            let isDuplicate = false;
            for (const u of unique) {
                const dist = Math.hypot(c.centerX - u.centerX, c.centerY - u.centerY);
                if (dist < threshold) {
                    isDuplicate = true;
                    // Keep the larger one (likely better detected)
                    if ((c.perimeter || c.width * 4) > (u.perimeter || u.width * 4)) {
                        Object.assign(u, c);
                    }
                    break;
                }
            }
            if (!isDuplicate) {
                unique.push(c);
            }
        }
        
        return unique;
    }

    /**
     * Detect ArUco markers in the current frame
     */
    detectArucoMarkers() {
        if (!this.video || !this.ctx) return null;
        
        // Capture frame
        this.ctx.drawImage(this.video, 0, 0);
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        const w = this.canvas.width;
        const h = this.canvas.height;
        
        // Convert to grayscale
        const gray = this.toGrayscale(imageData);
        
        // Adaptive threshold
        const binary = this.adaptiveThreshold(gray, w, h, 21);
        
        // Find marker candidates
        const candidates = this.findMarkerCandidates(gray, binary, w, h);
        
        if (this.config.debug) {
            this.log(`Found ${candidates.length} marker candidates in region 0-${Math.round(w * 0.65)}`);
            // Log first few candidates for debugging
            candidates.slice(0, 5).forEach((c, i) => {
                this.log(`  Candidate ${i}: (${c.x}, ${c.y}) size=${c.width}`);
            });
        }
        
        // Try to identify each candidate
        // Filter out candidates on the right side of frame (likely TV reflections)
        const reflectionThreshold = w * 0.65; // Ignore markers in rightmost 35% of frame
        const markers = {};
        let identifiedCount = 0;
        
        for (const candidate of candidates) {
            // Skip candidates that are likely reflections (on the right side)
            if (candidate.centerX > reflectionThreshold) {
                if (this.config.debug) {
                    this.log(`Skipping candidate at x=${Math.round(candidate.centerX)} (likely reflection, threshold=${Math.round(reflectionThreshold)})`);
                }
                continue;
            }
            
            const result = this.identifyMarker(gray, w, h, candidate);
            if (result) {
                const score = candidate.width * (4 - result.mismatches); // Bigger + fewer mismatches = better
                
                // Log every match for debugging
                this.log(`[MATCH] ID #${result.id} at (${Math.round(candidate.centerX)}, ${Math.round(candidate.centerY)}) size=${candidate.width} mismatches=${result.mismatches} score=${Math.round(score)}`);
                
                // Only accept if better than existing detection for same ID
                const existing = markers[result.id];
                if (!existing || score > existing.score) {
                    if (existing) {
                        this.log(`  -> Replacing previous detection at (${Math.round(existing.center.x)}, ${Math.round(existing.center.y)}) score=${Math.round(existing.score)}`);
                    }
                    markers[result.id] = {
                        id: result.id,
                        center: { x: candidate.centerX, y: candidate.centerY },
                        bounds: candidate,
                        corners: candidate.corners,
                        rotation: result.rotation,
                        mismatches: result.mismatches,
                        score: score
                    };
                    if (!existing) {
                        identifiedCount++;
                    }
                }
            }
        }
        
        // Log summary periodically
        if (this.config.debug && this._detectCount === undefined) this._detectCount = 0;
        this._detectCount++;
        if (this._detectCount % 30 === 0) {
            this.log(`Detection summary: ${candidates.length} candidates, ${identifiedCount} identified, frame ${w}x${h}`);
        }
        
        return markers;
    }

    /**
     * Order markers into corners based on their IDs
     * #0=TL, #1=TR, #2=BR, #3=BL
     */
    orderMarkers(markers) {
        if (!markers[0] || !markers[1] || !markers[2] || !markers[3]) {
            return null;
        }
        
        // Verify geometric consistency - markers should form a roughly square shape
        // All 4 markers should be close together (within reasonable bounds)
        const centers = [markers[0].center, markers[1].center, markers[2].center, markers[3].center];
        
        // Calculate pairwise distances
        const dist01 = Math.hypot(centers[1].x - centers[0].x, centers[1].y - centers[0].y);
        const dist12 = Math.hypot(centers[2].x - centers[1].x, centers[2].y - centers[1].y);
        const dist23 = Math.hypot(centers[3].x - centers[2].x, centers[3].y - centers[2].y);
        const dist30 = Math.hypot(centers[0].x - centers[3].x, centers[0].y - centers[3].y);
        const diag02 = Math.hypot(centers[2].x - centers[0].x, centers[2].y - centers[0].y);
        const diag13 = Math.hypot(centers[3].x - centers[1].x, centers[3].y - centers[1].y);
        
        // The 4 edge lengths should be roughly similar (within 3x of each other)
        const edgeLengths = [dist01, dist12, dist23, dist30];
        const minEdge = Math.min(...edgeLengths);
        const maxEdge = Math.max(...edgeLengths);
        
        if (minEdge < 20 || maxEdge > minEdge * 3) {
            if (this.config && this.config.debug) {
                this.log(`Rejecting markers - edge lengths inconsistent: ${edgeLengths.map(e => e.toFixed(0)).join(', ')}`);
            }
            return null;
        }
        
        // Diagonals should be roughly similar (within 2x of each other)
        if (Math.max(diag02, diag13) > Math.min(diag02, diag13) * 2) {
            if (this.config && this.config.debug) {
                this.log(`Rejecting markers - diagonals inconsistent: ${diag02.toFixed(0)}, ${diag13.toFixed(0)}`);
            }
            return null;
        }
        
        return {
            tl: markers[0],
            tr: markers[1],
            br: markers[2],
            bl: markers[3]
        };
    }

    /**
     * Calculate tile properties from 4 corner markers
     */
    calculateTileFromMarkers(orderedMarkers) {
        const { tl, tr, br, bl } = orderedMarkers;
        
        // Calculate center
        const center = {
            x: (tl.center.x + tr.center.x + br.center.x + bl.center.x) / 4,
            y: (tl.center.y + tr.center.y + br.center.y + bl.center.y) / 4
        };
        
        // Calculate width (average of top and bottom edges)
        const topWidth = Math.hypot(tr.center.x - tl.center.x, tr.center.y - tl.center.y);
        const bottomWidth = Math.hypot(br.center.x - bl.center.x, br.center.y - bl.center.y);
        const width = (topWidth + bottomWidth) / 2;
        
        // Calculate height (average of left and right edges)
        const leftHeight = Math.hypot(bl.center.x - tl.center.x, bl.center.y - tl.center.y);
        const rightHeight = Math.hypot(br.center.x - tr.center.x, br.center.y - tr.center.y);
        const height = (leftHeight + rightHeight) / 2;
        
        // Calculate rotation from top edge
        const angle = Math.atan2(
            tr.center.y - tl.center.y,
            tr.center.x - tl.center.x
        );
        
        return {
            corners: [tl.center, tr.center, br.center, bl.center],
            center,
            width,
            height,
            angle,
            angleDeg: angle * 180 / Math.PI
        };
    }

    /**
     * Draw debug visualization
     */
    drawDebugFrame(markers, detectedTile, expectedTile) {
        if (!this.canvas) return;
        
        const debugCanvas = document.createElement('canvas');
        debugCanvas.width = this.canvas.width;
        debugCanvas.height = this.canvas.height;
        const ctx = debugCanvas.getContext('2d');
        
        // Draw camera frame
        ctx.drawImage(this.canvas, 0, 0);
        
        // Draw detected markers
        if (markers) {
            Object.values(markers).forEach(marker => {
                const { bounds, id, center, corners } = marker;
                
                // Draw marker outline
                ctx.strokeStyle = '#00ff00';
                ctx.lineWidth = 2;
                
                if (corners && corners.length === 4) {
                    // Draw actual quadrilateral from contour detection
                    ctx.beginPath();
                    ctx.moveTo(corners[0].x, corners[0].y);
                    for (let i = 1; i < 4; i++) {
                        ctx.lineTo(corners[i].x, corners[i].y);
                    }
                    ctx.closePath();
                    ctx.stroke();
                    
                    // Mark first corner (top-left) with a small circle
                    ctx.beginPath();
                    ctx.arc(corners[0].x, corners[0].y, 4, 0, Math.PI * 2);
                    ctx.fillStyle = '#ff0000';
                    ctx.fill();
                } else {
                    // Fall back to bounding box
                    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
                }
                
                // Draw center
                ctx.beginPath();
                ctx.arc(center.x, center.y, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#00ff00';
                ctx.fill();
                
                // Draw ID label
                ctx.font = 'bold 14px Arial';
                ctx.fillStyle = '#00ff00';
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 3;
                ctx.strokeText(`#${id}`, bounds.x, bounds.y - 5);
                ctx.fillText(`#${id}`, bounds.x, bounds.y - 5);
            });
        }
        
        // Draw detected tile outline
        if (detectedTile && detectedTile.corners) {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(detectedTile.corners[0].x, detectedTile.corners[0].y);
            for (let i = 1; i < 4; i++) {
                ctx.lineTo(detectedTile.corners[i].x, detectedTile.corners[i].y);
            }
            ctx.closePath();
            ctx.stroke();
        }
        
        // Draw expected tile position (red dashed)
        if (expectedTile && expectedTile.corners) {
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(expectedTile.corners[0].x, expectedTile.corners[0].y);
            for (let i = 1; i < 4; i++) {
                ctx.lineTo(expectedTile.corners[i].x, expectedTile.corners[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
        }
        
        // Draw info overlay
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(10, 10, 300, 100);
        ctx.font = '14px monospace';
        ctx.fillStyle = '#00ff00';
        ctx.fillText('ArUco Marker Detection', 20, 30);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`Status: ${this.isCalibrating ? 'Calibrating...' : 'Ready'}`, 20, 50);
        
        const foundIds = markers ? Object.keys(markers).map(Number).sort() : [];
        ctx.fillText(`Markers: ${foundIds.length}/4 [${foundIds.join(', ')}]`, 20, 70);
        
        if (detectedTile) {
            const rotDeg = (this.cameraRotationOffset * 180 / Math.PI).toFixed(1);
            ctx.fillText(`Tile: ${detectedTile.width.toFixed(0)}×${detectedTile.height.toFixed(0)}px | Cam: ${rotDeg}°`, 20, 90);
        }
        
        if (this.onDebugFrame) {
            this.onDebugFrame(debugCanvas);
        }
        
        return debugCanvas;
    }

    /**
     * Collect marker detection samples
     */
    async collectMarkerSamples() {
        const samples = [];
        const numSamples = this.config.numSamples;
        
        for (let i = 0; i < numSamples && this.isCalibrating; i++) {
            await new Promise(r => setTimeout(r, this.config.sampleInterval));
            
            const markers = this.detectArucoMarkers();
            const ordered = this.orderMarkers(markers);
            
            if (ordered) {
                const tile = this.calculateTileFromMarkers(ordered);
                samples.push(tile);
            }
            
            this.drawDebugFrame(markers, ordered ? this.calculateTileFromMarkers(ordered) : null, null);
            
            if (this.onProgress) {
                this.onProgress({
                    phase: 'detecting',
                    sample: i + 1,
                    total: numSamples,
                    markersFound: markers ? Object.keys(markers).length : 0
                });
            }
        }
        
        // Check if cancelled
        if (!this.isCalibrating) {
            throw new Error('Calibration cancelled');
        }
        
        if (samples.length < 1) {
            throw new Error(`Insufficient samples: ${samples.length}. Ensure all 4 ArUco markers are visible.`);
        }
        
        return this.averageTileSamples(samples);
    }

    /**
     * Average tile samples
     */
    averageTileSamples(samples) {
        const avg = {
            corners: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
            center: { x: 0, y: 0 },
            width: 0,
            height: 0,
            angle: 0
        };
        
        samples.forEach(s => {
            for (let i = 0; i < 4; i++) {
                avg.corners[i].x += s.corners[i].x;
                avg.corners[i].y += s.corners[i].y;
            }
            avg.center.x += s.center.x;
            avg.center.y += s.center.y;
            avg.width += s.width;
            avg.height += s.height;
            avg.angle += s.angle;
        });
        
        const n = samples.length;
        for (let i = 0; i < 4; i++) {
            avg.corners[i].x /= n;
            avg.corners[i].y /= n;
        }
        avg.center.x /= n;
        avg.center.y /= n;
        avg.width /= n;
        avg.height /= n;
        avg.angle /= n;
        avg.angleDeg = avg.angle * 180 / Math.PI;
        
        return avg;
    }

    /**
     * Calculate alignment from detected tile vs expected tile
     */
    calculateTileAlignment(detectedTile, expectedTile) {
        const detectedSize = (detectedTile.width + detectedTile.height) / 2;
        const expectedSize = (expectedTile.width + expectedTile.height) / 2;
        
        const scaleFactor = expectedSize / detectedSize;
        const zoomDelta = Math.log2(scaleFactor);
        
        let rotationDelta = (expectedTile.angle - detectedTile.angle) * 180 / Math.PI;
        while (rotationDelta > 180) rotationDelta -= 360;
        while (rotationDelta < -180) rotationDelta += 360;
        
        const posError = Math.hypot(
            detectedTile.center.x - expectedTile.center.x,
            detectedTile.center.y - expectedTile.center.y
        );
        
        const sizeError = Math.abs(detectedSize - expectedSize);
        const error = posError + sizeError * 0.5;
        
        return { scaleFactor, zoomDelta, rotationDelta, posError, sizeError, error };
    }

    /**
     * Request expected tile position from main window
     */
    async getExpectedTilePosition(channel) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for tile position'));
            }, 5000);
            
            const handler = (event) => {
                if (event.data.type === 'calibration_tile_position') {
                    clearTimeout(timeout);
                    channel.removeEventListener('message', handler);
                    const tile = event.data.tile;
                    // Use camera rotation offset to account for tilted camera mount
                    tile.angle = this.cameraRotationOffset;
                    resolve(tile);
                }
            };
            
            channel.addEventListener('message', handler);
            channel.postMessage({
                type: 'calibrate_action',
                action: 'get_tile_position'
            });
        });
    }

    /**
     * Capture the camera rotation offset from currently detected markers
     * This compensates for a tilted camera mount
     */
    captureCameraRotationOffset() {
        const markers = this.detectArucoMarkers();
        if (!markers || !markers[0] || !markers[1]) {
            this.log('Cannot capture camera rotation - markers 0 and 1 not detected');
            return false;
        }
        
        // Calculate angle from marker 0 (TL) to marker 1 (TR)
        const dx = markers[1].center.x - markers[0].center.x;
        const dy = markers[1].center.y - markers[0].center.y;
        this.cameraRotationOffset = Math.atan2(dy, dx);
        
        this.log(`Camera rotation offset captured: ${(this.cameraRotationOffset * 180 / Math.PI).toFixed(2)}°`);
        return true;
    }

    /**
     * Main calibration routine
     */
    async calibrate(channel, initialCalibration, cameraDeviceId = null) {
        this.isCalibrating = true;
        this.currentCalibration = { ...initialCalibration };
        
        try {
            this.updateStatus('Starting camera...');
            if (this.onProgress) {
                this.onProgress({ phase: 'starting', message: 'Starting camera...' });
            }
            
            await this.startCamera(cameraDeviceId);
            
            // Wait for camera to stabilize
            await new Promise(r => setTimeout(r, 500));
            
            // Capture camera rotation offset to compensate for tilted camera mount
            this.updateStatus('Detecting camera orientation...');
            let rotationCaptured = false;
            for (let attempt = 0; attempt < 5 && !rotationCaptured; attempt++) {
                rotationCaptured = this.captureCameraRotationOffset();
                if (!rotationCaptured) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
            if (!rotationCaptured) {
                this.log('Warning: Could not capture camera rotation offset, using 0');
            }
            
            let iteration = 0;
            let lastError = Infinity;
            
            while (this.isCalibrating && iteration < this.config.maxIterations) {
                iteration++;
                
                this.updateStatus(`Calibrating... iteration ${iteration}/${this.config.maxIterations}`);
                if (this.onProgress) {
                    this.onProgress({ 
                        phase: 'calibrating', 
                        iteration,
                        maxIterations: this.config.maxIterations,
                        message: `Iteration ${iteration}...`
                    });
                }
                
                let detectedTile;
                try {
                    detectedTile = await this.collectMarkerSamples();
                } catch (err) {
                    this.updateStatus('Could not detect markers: ' + err.message);
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                
                let expectedTile;
                try {
                    expectedTile = await this.getExpectedTilePosition(channel);
                } catch (err) {
                    this.updateStatus('Could not get expected position');
                    continue;
                }
                
                const markers = this.detectArucoMarkers();
                this.drawDebugFrame(markers, detectedTile, expectedTile);
                
                const alignment = this.calculateTileAlignment(detectedTile, expectedTile);
                
                this.log(`Iteration ${iteration}: error=${alignment.error.toFixed(2)}px, ` +
                         `zoom=${alignment.zoomDelta.toFixed(4)}, rotation=${alignment.rotationDelta.toFixed(2)}°`);
                
                if (alignment.error < this.config.positionThreshold) {
                    this.updateStatus(`Converged! Error: ${alignment.error.toFixed(1)}px`);
                    break;
                }
                
                if (iteration > 2 && alignment.error >= lastError * 0.95) {
                    this.updateStatus(`Stopped - not improving. Error: ${alignment.error.toFixed(1)}px`);
                    break;
                }
                
                lastError = alignment.error;
                
                const damping = 0.5;
                const newCalibration = {
                    zoom: this.currentCalibration.zoom + alignment.zoomDelta * damping,
                    bearing: this.currentCalibration.bearing + alignment.rotationDelta * damping,
                    center: this.currentCalibration.center
                };
                
                channel.postMessage({
                    type: 'calibrate_action',
                    action: 'apply_calibration',
                    calibration: newCalibration
                });
                
                this.currentCalibration = newCalibration;
                
                await new Promise(r => setTimeout(r, 500));
                
                if (this.onProgress) {
                    this.onProgress({
                        phase: 'adjusting',
                        iteration,
                        error: alignment.error,
                        calibration: newCalibration
                    });
                }
            }
            
            channel.postMessage({
                type: 'calibrate_action',
                action: 'hide_calibration_tile'
            });
            
            this.updateStatus('Calibration complete!');
            return this.currentCalibration;
            
        } finally {
            this.stopCamera();
            this.isCalibrating = false;
        }
    }

    /**
     * Preview camera without calibrating
     */
    async startPreview(cameraDeviceId = null) {
        await this.startCamera(cameraDeviceId);
        // Start new preview loop with current ID and current video reference
        const loopId = this._previewLoopId;
        const video = this.video;
        this.previewLoop(loopId, video);
    }

    previewLoop(loopId, expectedVideo) {
        // Exit if this loop has been superseded by a newer one
        if (loopId !== this._previewLoopId) return;
        // Exit if video element changed (camera was switched)
        if (this.video !== expectedVideo) return;
        if (!this.video || !this.ctx) return;
        
        // Check if video has valid frames ready
        if (this.video.readyState < 2) {
            // Video not ready yet, wait and try again
            requestAnimationFrame(() => this.previewLoop(loopId, expectedVideo));
            return;
        }
        
        // Throttle to ~15fps max for performance
        const now = performance.now();
        if (this._lastPreviewTime && now - this._lastPreviewTime < 66) {
            requestAnimationFrame(() => this.previewLoop(loopId, expectedVideo));
            return;
        }
        this._lastPreviewTime = now;
        
        const markers = this.detectArucoMarkers();
        const ordered = this.orderMarkers(markers);
        const tile = ordered ? this.calculateTileFromMarkers(ordered) : null;
        this.drawDebugFrame(markers, tile, null);
        
        if (this.video && loopId === this._previewLoopId && this.video === expectedVideo) {
            requestAnimationFrame(() => this.previewLoop(loopId, expectedVideo));
        }
    }

    stopPreview() {
        this.stopCamera();
    }

    cancel() {
        console.log('[AutoCalibrator] Cancel called, isCalibrating was:', this.isCalibrating);
        this.isCalibrating = false;
        this.updateStatus('Calibration cancelled');
        // Don't stop camera here - let the caller decide if they want to restart preview
    }

    updateStatus(message) {
        this.log(message);
        if (this.onStatusUpdate) {
            this.onStatusUpdate(message);
        }
    }

    log(...args) {
        if (this.config.debug) {
            console.log('[AutoCalibrator]', ...args);
        }
    }
}

// Export for use
window.AutoCalibrator = AutoCalibrator;
