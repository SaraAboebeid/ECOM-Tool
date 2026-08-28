/**
 * Stormwater Flow Animation
 * 
 * Visualizes stormwater drainage using particle-based flow animation.
 * Dynamically computes flow direction and accumulation from DEM GeoTIFF
 * using the D8 algorithm - no Python preprocessing required!
 */

class StormwaterFlowAnimation {
  constructor(map, canvas) {
    this.map = map;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.isActive = false;
    this.animationFrame = null;
    
    // Particle system
    this.particles = [];
    this.maxParticles = 4000;
    this.particleSpawnRate = 40;
    
    // Offscreen canvas for particle glow (pre-rendered sprite)
    this.glowSprite = null;
    this.poolingGlowSprite = null;  // Separate sprite for pooling particles
    this.glowSpriteSize = 20;
    
    // DEM and flow data (computed dynamically)
    this.dem = null;
    this.demWidth = 0;
    this.demHeight = 0;
    this.flowDir = null;
    this.flowAcc = null;
    this.flowData = null;
    this.buildingFootprints = null;
    
    // Spatial index for faster flow lookups
    this.flowGrid = null;
    this.flowGridCellSize = 20; // pixels per grid cell
    
    // Animation parameters
    this.particleSpeed = 1.5;
    this.particleLifetime = 300; // frames
    this.particleSize = 2;
    this.flowIntensity = 1.0;
    this.showDEM = false;  // Hide DEM elevation background
    this.showPools = false; // Disabled - just show particles
    this.debugFlowLines = false;
    
    // Glow parameters
    this.glowIntensity = 0.5;
    this.poolingGlowIntensity = 1.2;  // Extra glow for stagnating/pooling particles
    
    // Smoothing parameters for fluid motion
    this.velocitySmoothing = 0.85;
    this.noiseScale = 0.3;
    
    // Pooling detection parameters
    this.poolingThreshold = 15;  // frames of low displacement to be considered pooling
    this.poolingDisplacementThreshold = 20;  // pixels - if particle hasn't moved this far, it's pooling
    
    // DEM visualization
    this.demImageData = null;
    this.elevationMin = 0;
    this.elevationMax = 100;
    
    // Colors
    this.particleColor = 'rgba(0, 150, 255, 0.7)';
    this.particleTrailColor = 'rgba(0, 150, 255, 0.3)';
    
    // Audio setup
    this.rainAudio = new Audio('media/sound/rain.mp3');
    this.rainAudio.loop = true;
    
    // Bind methods
    this.animate = this.animate.bind(this);
    this.handleResize = this.handleResize.bind(this);
  }
  
  /**
   * Load DEM from GeoTIFF and compute flow direction/accumulation
   */
  async loadData() {
    try {
      console.log('Loading DEM GeoTIFF and computing flow...');
      
      // Check if GeoTIFF library is available
      if (typeof GeoTIFF === 'undefined') {
        throw new Error('GeoTIFF library not loaded');
      }
      
      // Load the DEM GeoTIFF file
      const response = await fetch('media/clipped_dem.geotiff.tif');
      if (!response.ok) {
        throw new Error('DEM file not found at media/clipped_dem.geotiff.tif');
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
      const image = await tiff.getImage();
      
      // Get raster data
      const rasters = await image.readRasters();
      const elevationData = rasters[0]; // First band = elevation
      
      this.demWidth = image.getWidth();
      this.demHeight = image.getHeight();
      
      // Convert typed array to 2D array for easier processing
      this.dem = [];
      for (let row = 0; row < this.demHeight; row++) {
        this.dem[row] = [];
        for (let col = 0; col < this.demWidth; col++) {
          const idx = row * this.demWidth + col;
          this.dem[row][col] = elevationData[idx];
        }
      }
      
      console.log(`DEM loaded: ${this.demWidth}x${this.demHeight} pixels`);
      const elevStats = this.getMinMax(elevationData);
      this.elevationMin = elevStats.min;
      this.elevationMax = elevStats.max;
      console.log(`Elevation range: ${elevStats.min.toFixed(1)}m - ${elevStats.max.toFixed(1)}m`);
      
      // Create DEM visualization image
      console.log('Creating DEM visualization...');
      this.createDEMVisualization();
      
      // Compute flow direction using D8 algorithm
      console.log('Computing D8 flow direction...');
      this.flowDir = this.computeD8FlowDirection();
      
      // Compute flow accumulation
      console.log('Computing flow accumulation...');
      this.flowAcc = this.computeFlowAccumulation();
      
      // Generate flow lines and start points for particle animation
      console.log('Generating flow data for animation...');
      this.flowData = this.generateFlowData();
      
      // Load building footprints (optional)
      try {
        const buildingsResponse = await fetch('media/building-footprints.geojson');
        if (buildingsResponse.ok) {
          this.buildingFootprints = await buildingsResponse.json();
        }
      } catch (e) {
        console.log('Building footprints not loaded (optional)');
      }
      
      console.log('Stormwater flow data computed:', {
        flowLines: this.flowData.flow_lines.length,
        startPoints: this.flowData.start_points.length
      });
      
      return true;
    } catch (error) {
      console.error('Error loading/computing stormwater flow:', error);
      alert('Error loading DEM: ' + error.message);
      return false;
    }
  }
  
  /**
   * Get min/max from typed array
   */
  getMinMax(arr) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (!isNaN(arr[i])) {
        min = Math.min(min, arr[i]);
        max = Math.max(max, arr[i]);
      }
    }
    return { min, max };
  }
  
  /**
   * Create DEM visualization as an offscreen canvas
   * Uses terrain colors: low = green/tan, high = brown/white
   * Rotates 90° counter-clockwise to match screen orientation (DEM is tall, canvas is wide)
   */
  createDEMVisualization() {
    // The DEM is stored as rows×cols (height×width)
    // We need to rotate 90° counter-clockwise for landscape canvas
    // After rotation: width = demHeight, height = demWidth
    
    // Create offscreen canvas with ROTATED dimensions
    this.demCanvas = document.createElement('canvas');
    this.demCanvas.width = this.demHeight;  // Rotated: height becomes width
    this.demCanvas.height = this.demWidth;  // Rotated: width becomes height
    const ctx = this.demCanvas.getContext('2d');
    
    // Create image data with rotated dimensions
    const imageData = ctx.createImageData(this.demHeight, this.demWidth);
    const data = imageData.data;
    
    const elevRange = this.elevationMax - this.elevationMin;
    
    // Rotate 90° clockwise: new(x, y) = old(row, col) where
    // new_x = demHeight - 1 - row (flip vertical then transpose)
    // new_y = col
    // Actually for 90° CW: new_x = old_row, new_y = demWidth - 1 - old_col
    // Wait, let's think again:
    // Original: dem[row][col] where row=0 is north, col=0 is west
    // 90° clockwise rotation:
    //   - Top of new image = left of old (col=0)
    //   - Left of new image = top of old (row=0)
    // So: new_x = old_row, new_y = old_col for the data
    // But we need to FLIP to match what Python did (rotate -90 = 90 CW)
    
    for (let row = 0; row < this.demHeight; row++) {
      for (let col = 0; col < this.demWidth; col++) {
        const elev = this.dem[row][col];
        
        // 90° counter-clockwise rotation transformation
        // new_x = demHeight - 1 - row (so row 0 goes to right edge)
        // new_y = col (column stays as Y)
        const newX = this.demHeight - 1 - row;
        const newY = col;
        const idx = (newY * this.demHeight + newX) * 4;
        
        if (isNaN(elev)) {
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 0;
        } else {
          const t = (elev - this.elevationMin) / elevRange;
          let r, g, b;
          
          if (t < 0.3) {
            const s = t / 0.3;
            r = Math.floor(100 + s * 80);
            g = Math.floor(140 + s * 20);
            b = Math.floor(80 - s * 20);
          } else if (t < 0.7) {
            const s = (t - 0.3) / 0.4;
            r = Math.floor(180 - s * 30);
            g = Math.floor(160 - s * 50);
            b = Math.floor(60 + s * 30);
          } else {
            const s = (t - 0.7) / 0.3;
            r = Math.floor(150 + s * 70);
            g = Math.floor(110 + s * 90);
            b = Math.floor(90 + s * 100);
          }
          
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 180;
        }
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    // Add corner markers for orientation debugging (on rotated canvas)
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = 'green';
    ctx.fillRect(this.demHeight - 20, 0, 20, 20);
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, this.demWidth - 20, 20, 20);
    ctx.fillStyle = 'yellow';
    ctx.fillRect(this.demHeight - 20, this.demWidth - 20, 20, 20);
    
    console.log('Corner elevations (original DEM orientation):');
    console.log(`  DEM[0][0] (row=0, col=0):     ${this.dem[0][0]?.toFixed(1)}m`);
    console.log(`  DEM[0][last] (row=0, col=max): ${this.dem[0][this.demWidth-1]?.toFixed(1)}m`);
    console.log(`  DEM[last][0] (row=max, col=0): ${this.dem[this.demHeight-1][0]?.toFixed(1)}m`);
    console.log(`  DEM[last][last]:               ${this.dem[this.demHeight-1][this.demWidth-1]?.toFixed(1)}m`);
    console.log(`DEM visualization created: ${this.demHeight}x${this.demWidth}px (rotated 90° CW)`);
  }

  /**
   * D8 Flow Direction Algorithm
   * Returns flow direction codes:
   *   32  64  128
   *   16   0    1
   *    8   4    2
   */
  computeD8FlowDirection() {
    const rows = this.demHeight;
    const cols = this.demWidth;
    const flowDir = [];
    
    // D8 neighbor offsets: [rowOffset, colOffset, directionCode]
    const neighbors = [
      [-1,  1, 128], // NE
      [ 0,  1,   1], // E
      [ 1,  1,   2], // SE
      [ 1,  0,   4], // S
      [ 1, -1,   8], // SW
      [ 0, -1,  16], // W
      [-1, -1,  32], // NW
      [-1,  0,  64]  // N
    ];
    
    for (let i = 0; i < rows; i++) {
      flowDir[i] = [];
      for (let j = 0; j < cols; j++) {
        const centerElev = this.dem[i][j];
        
        // Skip nodata/NaN values
        if (isNaN(centerElev)) {
          flowDir[i][j] = 0;
          continue;
        }
        
        let maxSlope = -Infinity;
        let direction = 0;
        
        for (const [dr, dc, dirCode] of neighbors) {
          const ni = i + dr;
          const nj = j + dc;
          
          // Check bounds
          if (ni >= 0 && ni < rows && nj >= 0 && nj < cols) {
            const neighborElev = this.dem[ni][nj];
            
            if (!isNaN(neighborElev)) {
              // Calculate slope (elevation difference / distance)
              const distance = Math.sqrt(dr * dr + dc * dc);
              const slope = (centerElev - neighborElev) / distance;
              
              if (slope > maxSlope) {
                maxSlope = slope;
                direction = dirCode;
              }
            }
          }
        }
        
        // Only assign direction if water flows downhill
        flowDir[i][j] = maxSlope > 0 ? direction : 0;
      }
    }
    
    return flowDir;
  }
  
  /**
   * Flow Accumulation Algorithm
   * Counts how many upstream cells flow into each cell
   */
  computeFlowAccumulation() {
    const rows = this.demHeight;
    const cols = this.demWidth;
    
    // Initialize accumulation to 1 (each cell contributes itself)
    const flowAcc = [];
    for (let i = 0; i < rows; i++) {
      flowAcc[i] = new Float32Array(cols).fill(1);
    }
    
    // Direction code to offset mapping
    const dirToOffset = {
      128: [-1,  1], // NE
        1: [ 0,  1], // E
        2: [ 1,  1], // SE
        4: [ 1,  0], // S
        8: [ 1, -1], // SW
       16: [ 0, -1], // W
       32: [-1, -1], // NW
       64: [-1,  0]  // N
    };
    
    // Iteratively propagate flow downstream
    const maxIterations = 30;
    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = false;
      
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const dir = this.flowDir[i][j];
          if (dir === 0) continue;
          
          const offset = dirToOffset[dir];
          if (!offset) continue;
          
          const ni = i + offset[0];
          const nj = j + offset[1];
          
          if (ni >= 0 && ni < rows && nj >= 0 && nj < cols) {
            // Avoid runaway accumulation
            if (flowAcc[ni][nj] > 1e6) continue;
            
            const oldAcc = flowAcc[ni][nj];
            flowAcc[ni][nj] += flowAcc[i][j];
            
            if (Math.abs(flowAcc[ni][nj] - oldAcc) > 0.1) {
              changed = true;
            }
          }
        }
      }
      
      if (!changed) {
        console.log(`  Flow accumulation converged after ${iter + 1} iterations`);
        break;
      }
    }
    
    // Cap extreme values
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        flowAcc[i][j] = Math.min(flowAcc[i][j], 1e6);
      }
    }
    
    return flowAcc;
  }
  
  /**
   * Generate flow lines and start points for particle animation
   * Uses normalized coordinates (0-1) for screen-independent rendering
   * Applies 90° counter-clockwise rotation to match DEM visualization
   */
  generateFlowData() {
    const rows = this.demHeight;
    const cols = this.demWidth;
    const flowThreshold = 10; // Minimum accumulation to show flow
    const startPointSpacing = 5;
    
    const dirToOffset = {
      128: [-1,  1],
        1: [ 0,  1],
        2: [ 1,  1],
        4: [ 1,  0],
        8: [ 1, -1],
       16: [ 0, -1],
       32: [-1, -1],
       64: [-1,  0]
    };
    
    const flowLines = [];
    const startPoints = [];
    
    // Helper function to apply 90° counter-clockwise rotation
    // Original DEM: dem[row][col] where row is Y (0=north), col is X (0=west)
    // After 90° CCW rotation: new_x = 1 - row/rows, new_y = col/cols
    const rotatePoint = (row, col) => {
      return {
        x: 1 - (row / rows),     // row becomes X (flipped: row=0 -> right)
        y: col / cols            // col becomes Y (col=0 -> top)
      };
    };
    
    // Extract flow lines
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const dir = this.flowDir[i][j];
        const acc = this.flowAcc[i][j];
        
        if (dir === 0 || acc < flowThreshold) continue;
        
        const offset = dirToOffset[dir];
        if (!offset) continue;
        
        const ni = i + offset[0];
        const nj = j + offset[1];
        
        if (ni >= 0 && ni < rows && nj >= 0 && nj < cols) {
          // Apply 90° clockwise rotation to coordinates
          const from = rotatePoint(i, j);
          const to = rotatePoint(ni, nj);
          
          flowLines.push({
            from_x_norm: from.x,
            from_y_norm: from.y,
            to_x_norm: to.x,
            to_y_norm: to.y,
            accumulation: acc,
            direction: dir
          });
        }
      }
    }
    
    // Detect pools (sinks) - cells with no outflow or very high accumulation
    const pools = [];
    const poolThreshold = 2000; // Higher threshold = only significant pools
    
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const dir = this.flowDir[i][j];
        const acc = this.flowAcc[i][j];
        
        // Pool conditions: true sinks OR very high accumulation
        if ((dir === 0 && acc > 100) || acc > poolThreshold) {
          const pt = rotatePoint(i, j);
          pools.push({
            x_norm: pt.x,
            y_norm: pt.y,
            accumulation: acc,
            isSink: dir === 0
          });
        }
      }
    }
    
    // Create start points on a grid (with same rotation)
    for (let i = 0; i < rows; i += startPointSpacing) {
      for (let j = 0; j < cols; j += startPointSpacing) {
        const acc = this.flowAcc[i][j];
        if (acc >= 1.0 && !isNaN(acc)) {
          const pt = rotatePoint(i, j);
          startPoints.push({
            position_norm: [pt.x, pt.y],
            weight: acc
          });
        }
      }
    }
    
    // Limit to reasonable number for performance
    const maxFlowLines = 50000;
    const maxStartPoints = 5000;
    
    console.log(`Detected ${pools.length} pool/sink areas`);
    
    return {
      flow_lines: this.sampleEvenly(flowLines, maxFlowLines),
      start_points: this.sampleEvenly(startPoints, maxStartPoints),
      pools: pools
    };
  }
  
  /**
   * Build spatial index for fast flow direction lookups
   */
  buildFlowGrid() {
    if (!this.flowData?.flow_lines_screen) return;
    
    const cellSize = this.flowGridCellSize;
    const cols = Math.ceil(this.canvas.width / cellSize);
    const rows = Math.ceil(this.canvas.height / cellSize);
    
    // Initialize grid
    this.flowGrid = [];
    for (let r = 0; r < rows; r++) {
      this.flowGrid[r] = [];
      for (let c = 0; c < cols; c++) {
        this.flowGrid[r][c] = [];
      }
    }
    
    // Populate grid with flow lines
    for (const line of this.flowData.flow_lines_screen) {
      const c = Math.floor(line.from_x / cellSize);
      const r = Math.floor(line.from_y / cellSize);
      if (r >= 0 && r < rows && c >= 0 && c < cols) {
        this.flowGrid[r][c].push(line);
      }
    }
    
    console.log(`Built flow grid: ${cols}x${rows} cells`);
  }
  
  /**
  /**
   * Sample items evenly from array
   */
  sampleEvenly(items, maxCount) {
    if (items.length <= maxCount) return items;
    
    const step = items.length / maxCount;
    const result = [];
    for (let i = 0; i < maxCount; i++) {
      result.push(items[Math.floor(i * step)]);
    }
    return result;
  }
  
  async start() {
    if (this.isActive) return;
    
    // Load and compute data if not already done
    if (!this.flowData) {
      const loaded = await this.loadData();
      if (!loaded) return;
    }
    
    // Create pre-rendered glow sprite for performance
    this.createGlowSprite();
    
    this.isActive = true;
    this.canvas.classList.add('active');
    
    // Broadcast state to controller
    const channel = new BroadcastChannel('map_controller_channel');
    channel.postMessage({ type: 'animation_state', animationId: 'stormwater-btn', isActive: true });
    
    this.handleResize();
    
    // Play rain sound
    this.rainAudio.play().catch(e => console.warn("Audio play failed:", e));
    
    // Scale normalized flow data to current canvas size
    this.scaleFlowToScreen();
    
    // Initialize particles
    this.particles = [];
    
    // Add resize listener
    window.addEventListener('resize', () => {
      this.handleResize();
      this.scaleFlowToScreen();
    });
    
    // Start animation loop
    this.animate();
    
    console.log('Stormwater flow animation started');
  }
  
  /**
   * Scale normalized flow data (0-1 range) to current canvas dimensions
   */
  scaleFlowToScreen() {
    if (!this.flowData) return;
    
    const width = this.canvas.width;
    const height = this.canvas.height;
    
    // Calculate max accumulation for color scaling
    const accValues = this.flowData.flow_lines.map(line => line.accumulation);
    this.maxAccumulation = Math.max(...accValues);
    this.logMaxAcc = Math.log10(this.maxAccumulation + 1);
    
    // Scale flow lines from normalized (0-1) to pixel coordinates
    this.flowData.flow_lines_screen = this.flowData.flow_lines.map(line => ({
      from_x: line.from_x_norm * width,
      from_y: line.from_y_norm * height,
      to_x: line.to_x_norm * width,
      to_y: line.to_y_norm * height,
      accumulation: line.accumulation,
      direction: line.direction
    }));
    
    // Scale start points from normalized (0-1) to pixel coordinates
    this.flowData.start_points_screen = this.flowData.start_points.map(point => ({
      x: point.position_norm[0] * width,
      y: point.position_norm[1] * height,
      weight: point.weight
    }));
    
    // Build spatial index for fast lookups
    this.buildFlowGrid();
    
    console.log(`Scaled ${this.flowData.flow_lines_screen.length} flow lines to ${width}x${height}px`);
  }
  
  /**
   * Create pre-rendered glow sprite for efficient particle rendering
   * This avoids creating expensive radial gradients every frame
   */
  createGlowSprite() {
    const size = this.glowSpriteSize;
    
    // Create flowing water sprite (blue)
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    const center = size / 2;
    
    // Tighter, less diffuse glow
    const gradient1 = ctx.createRadialGradient(center, center, 0, center, center, center * 0.7);
    gradient1.addColorStop(0, 'rgba(120, 200, 255, 0.9)');
    gradient1.addColorStop(0.4, 'rgba(80, 180, 255, 0.4)');
    gradient1.addColorStop(0.8, 'rgba(60, 160, 255, 0.1)');
    gradient1.addColorStop(1, 'rgba(60, 160, 255, 0)');
    
    ctx.fillStyle = gradient1;
    ctx.fillRect(0, 0, size, size);
    
    // Bright core
    const coreSize = size * 0.2;
    const gradient2 = ctx.createRadialGradient(center, center, 0, center, center, coreSize);
    gradient2.addColorStop(0, 'rgba(240, 255, 255, 0.95)');
    gradient2.addColorStop(0.6, 'rgba(150, 220, 255, 0.6)');
    gradient2.addColorStop(1, 'rgba(100, 200, 255, 0)');
    
    ctx.fillStyle = gradient2;
    ctx.beginPath();
    ctx.arc(center, center, coreSize, 0, Math.PI * 2);
    ctx.fill();
    
    this.glowSprite = canvas;
    
    // Create pooling water sprite (teal/cyan-green) - also tighter glow
    const poolCanvas = document.createElement('canvas');
    poolCanvas.width = size;
    poolCanvas.height = size;
    const poolCtx = poolCanvas.getContext('2d');
    
    // Tighter glow - teal/cyan color for pooling
    const poolGradient1 = poolCtx.createRadialGradient(center, center, 0, center, center, center * 0.7);
    poolGradient1.addColorStop(0, 'rgba(60, 220, 180, 0.9)');
    poolGradient1.addColorStop(0.4, 'rgba(40, 200, 160, 0.4)');
    poolGradient1.addColorStop(0.8, 'rgba(30, 180, 140, 0.1)');
    poolGradient1.addColorStop(1, 'rgba(30, 180, 140, 0)');
    
    poolCtx.fillStyle = poolGradient1;
    poolCtx.fillRect(0, 0, size, size);
    
    // Bright core - slightly greenish white
    const poolGradient2 = poolCtx.createRadialGradient(center, center, 0, center, center, coreSize);
    poolGradient2.addColorStop(0, 'rgba(230, 255, 245, 0.95)');
    poolGradient2.addColorStop(0.6, 'rgba(120, 230, 200, 0.6)');
    poolGradient2.addColorStop(1, 'rgba(50, 220, 180, 0)');
    
    poolCtx.fillStyle = poolGradient2;
    poolCtx.beginPath();
    poolCtx.arc(center, center, coreSize, 0, Math.PI * 2);
    poolCtx.fill();
    
    this.poolingGlowSprite = poolCanvas;
  }
  
  stop() {
    if (!this.isActive) return;
    
    this.isActive = false;
    this.canvas.classList.remove('active');
    
    // Broadcast state to controller
    const channel = new BroadcastChannel('map_controller_channel');
    channel.postMessage({ type: 'animation_state', animationId: 'stormwater-btn', isActive: false });
    
    // Stop rain sound
    this.rainAudio.pause();
    this.rainAudio.currentTime = 0;
    
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    
    window.removeEventListener('resize', this.handleResize);
    
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.particles = [];
    
    console.log('Stormwater flow animation stopped');
  }
  
  toggle() {
    if (this.isActive) {
      this.stop();
    } else {
      this.start();
    }
  }
  
  handleResize() {
    const s = typeof computeOverlayPixelSize === 'function' 
      ? computeOverlayPixelSize() 
      : { w: window.innerWidth - 120, h: window.innerHeight };
    
    this.canvas.width = s.w;
    this.canvas.height = s.h;
    this.canvas.style.width = s.w + 'px';
    this.canvas.style.height = s.h + 'px';
  }
  
  /**
   * Create a new particle at a spawn point
   */
  createParticle() {
    const startPointsScreen = this.flowData?.start_points_screen;
    if (!startPointsScreen || startPointsScreen.length === 0) {
      return null;
    }
    
    // Select a random start point, weighted by flow accumulation
    const totalWeight = startPointsScreen.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;
    
    let selectedPoint = startPointsScreen[0];
    for (const point of startPointsScreen) {
      random -= point.weight;
      if (random <= 0) {
        selectedPoint = point;
        break;
      }
    }
    
    // Add small random offset for variety
    const offsetX = (Math.random() - 0.5) * 10;
    const offsetY = (Math.random() - 0.5) * 10;
    
    return {
      x: selectedPoint.x + offsetX,
      y: selectedPoint.y + offsetY,
      age: 0,
      trail: [],
      velocity: { x: 0, y: 0 },
      prevVelocity: { x: 0, y: 0 },  // For smoothing
      accumulation: selectedPoint.weight,
      stationaryTime: 0,
      size: this.particleSize + Math.random() * 1,  // Slight size variation
      // Pooling detection
      startX: selectedPoint.x + offsetX,
      startY: selectedPoint.y + offsetY,
      checkpointX: selectedPoint.x + offsetX,
      checkpointY: selectedPoint.y + offsetY,
      checkpointAge: 0,
      isPooling: false,
      poolingIntensity: 0  // 0-1 for color blending
    };
  }
  
  /**
   * Find flow direction at a given screen position using spatial grid
   */
  getFlowDirection(screenX, screenY) {
    if (!this.flowGrid) return { x: 0, y: 0 };
    
    const cellSize = this.flowGridCellSize;
    const col = Math.floor(screenX / cellSize);
    const row = Math.floor(screenY / cellSize);
    
    // Search current cell and neighbors
    let nearestLine = null;
    let minDist = Infinity;
    
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        const c = col + dc;
        
        if (r >= 0 && r < this.flowGrid.length && 
            c >= 0 && c < this.flowGrid[0].length) {
          for (const line of this.flowGrid[r][c]) {
            const dx = line.from_x - screenX;
            const dy = line.from_y - screenY;
            const dist = dx * dx + dy * dy;  // Skip sqrt for speed
            
            if (dist < minDist) {
              minDist = dist;
              nearestLine = line;
            }
          }
        }
      }
    }
    
    // Use 40 pixel search radius (squared)
    if (!nearestLine || minDist > 1600) {
      return { x: 0, y: 0, isPool: false };
    }
    
    // Calculate direction vector in screen space
    const dx = nearestLine.to_x - nearestLine.from_x;
    const dy = nearestLine.to_y - nearestLine.from_y;
    const mag = Math.sqrt(dx * dx + dy * dy);
    
    if (mag === 0) return { x: 0, y: 0 };
    
    // Normalize and scale by accumulation
    // Slower in high accumulation areas (pooling)
    const accFactor = Math.min(nearestLine.accumulation / 100, 3);
    const speed = (0.5 + accFactor * 0.5) * this.particleSpeed;
    
    return {
      x: (dx / mag) * speed,
      y: (dy / mag) * speed,
      accumulation: nearestLine.accumulation,
      isPool: nearestLine.accumulation > 50
    };
  }
  
  /**
   * Update particle positions with smooth physics
   */
  updateParticles() {
    // Spawn new particles
    for (let i = 0; i < this.particleSpawnRate && this.particles.length < this.maxParticles; i++) {
      const particle = this.createParticle();
      if (particle) {
        this.particles.push(particle);
      }
    }
    
    const smoothing = this.velocitySmoothing;
    
    // Update existing particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age++;
      
      // Remove old particles
      if (p.age > this.particleLifetime) {
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      
      // Get flow direction at current position
      const flow = this.getFlowDirection(p.x, p.y);
      
      // Smooth velocity transition (lerp between previous and new)
      const targetVx = flow.x;
      const targetVy = flow.y;
      
      // Apply smoothing - blend previous velocity with target
      p.velocity.x = p.prevVelocity.x * smoothing + targetVx * (1 - smoothing);
      p.velocity.y = p.prevVelocity.y * smoothing + targetVy * (1 - smoothing);
      
      // Store for next frame
      p.prevVelocity.x = p.velocity.x;
      p.prevVelocity.y = p.velocity.y;
      
      // Update accumulation
      if (flow.accumulation) {
        p.accumulation = Math.max(p.accumulation, flow.accumulation);
      }
      
      // Store previous position for trail (every 3rd frame for performance)
      if (p.age % 3 === 0) {
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 8) {  // Shorter trails for performance
          p.trail.shift();
        }
      }
      
      // Update position with smoothed velocity
      p.x += p.velocity.x;
      p.y += p.velocity.y;
      
      // Add subtle Perlin-like noise for natural flow (use sin waves for cheap noise)
      const noiseX = Math.sin(p.age * 0.1 + p.x * 0.01) * this.noiseScale;
      const noiseY = Math.cos(p.age * 0.1 + p.y * 0.01) * this.noiseScale;
      p.x += noiseX;
      p.y += noiseY;
      
      // Track stationary time for particle growth (pooling effect)
      const speed = Math.sqrt(p.velocity.x * p.velocity.x + p.velocity.y * p.velocity.y);
      if (speed < 0.3) {
        p.stationaryTime++;
        // Particles in pools grow and become more opaque
        p.size = Math.min(p.size + 0.02, 6);
      } else {
        p.stationaryTime = Math.max(0, p.stationaryTime - 1);
      }
      
      // Pooling detection: check displacement from checkpoint every N frames
      const checkInterval = 20;  // frames between checks
      if (p.age - p.checkpointAge >= checkInterval) {
        const dx = p.x - p.checkpointX;
        const dy = p.y - p.checkpointY;
        const displacement = Math.sqrt(dx * dx + dy * dy);
        
        if (displacement < this.poolingDisplacementThreshold) {
          // Not moving much - increase pooling intensity
          p.poolingIntensity = Math.min(1, p.poolingIntensity + 0.15);
          p.isPooling = p.poolingIntensity > 0.3;
        } else {
          // Moving - decrease pooling intensity
          p.poolingIntensity = Math.max(0, p.poolingIntensity - 0.1);
          p.isPooling = p.poolingIntensity > 0.3;
        }
        
        // Update checkpoint
        p.checkpointX = p.x;
        p.checkpointY = p.y;
        p.checkpointAge = p.age;
      }
      
      // Remove particles off screen
      if (p.x < 0 || p.x > this.canvas.width || 
          p.y < 0 || p.y > this.canvas.height) {
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
      }
    }
  }
  
  /**
   * Get particle color based on flow accumulation
   */
  getParticleColor(accumulation) {
    if (!accumulation || !this.logMaxAcc) {
      return 'rgba(200, 220, 255, 0.7)';
    }
    
    const accNorm = Math.log10(accumulation + 1) / this.logMaxAcc;
    
    // White to blue gradient
    const r = Math.floor(255 - accNorm * 245);
    const g = Math.floor(255 - accNorm * 205);
    const b = 255;
    const a = 0.65 + accNorm * 0.3;
    
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  
  /**
   * Get particle size based on flow accumulation and stationary time
   */
  getParticleSize(accumulation, stationaryTime) {
    let size = this.particleSize;
    
    if (accumulation && this.logMaxAcc) {
      const accNorm = Math.log10(accumulation + 1) / this.logMaxAcc;
      size += accNorm * 1.5;
    }
    
    return size;
  }
  
  /**
   * Draw particles
   */
  drawParticles() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Debug: Draw flow direction arrows
    if (this.debugFlowLines && this.flowData?.flow_lines_screen) {
      this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
      this.ctx.lineWidth = 1;
      
      for (let i = 0; i < this.flowData.flow_lines_screen.length; i += 50) {
        const line = this.flowData.flow_lines_screen[i];
        this.ctx.beginPath();
        this.ctx.moveTo(line.from_x, line.from_y);
        this.ctx.lineTo(line.to_x, line.to_y);
        this.ctx.stroke();
      }
    }
    
    // Draw simple trails (no shadowBlur for performance)
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    for (const p of this.particles) {
      if (p.trail.length > 2) {
        const alpha = Math.max(0.1, 1.0 - (p.age / this.particleLifetime));
        
        // Draw trail as simple line (skip every other point for performance)
        this.ctx.beginPath();
        this.ctx.moveTo(p.trail[0].x, p.trail[0].y);
        
        for (let i = 2; i < p.trail.length; i += 2) {
          this.ctx.lineTo(p.trail[i].x, p.trail[i].y);
        }
        this.ctx.lineTo(p.x, p.y);
        
        // Trail color changes based on pooling state
        if (p.isPooling) {
          this.ctx.strokeStyle = `rgba(50, 200, 170, ${alpha * 0.4})`;
        } else {
          this.ctx.strokeStyle = `rgba(80, 170, 255, ${alpha * 0.4})`;
        }
        this.ctx.lineWidth = p.size * 0.8;
        this.ctx.stroke();
      }
    }
    
    // Draw particles using pre-rendered glow sprite (much faster than gradients)
    if (this.glowSprite && this.poolingGlowSprite) {
      const spriteSize = this.glowSpriteSize;
      const halfSprite = spriteSize / 2;
      
      for (const p of this.particles) {
        const lifeRatio = p.age / this.particleLifetime;
        const alpha = Math.max(0.3, 1.0 - lifeRatio * 0.6);
        const scale = (p.size / 3) * (0.8 + 0.4 * (1 - lifeRatio)); // Shrink as it ages
        
        // Pooling particles get slightly larger
        const poolScale = p.isPooling ? 1.0 + p.poolingIntensity * 0.4 : 1.0;
        
        // Calculate glow intensity - pooling particles get more glow
        const baseGlow = this.glowIntensity;
        const extraPoolGlow = p.poolingIntensity * (this.poolingGlowIntensity - this.glowIntensity);
        const effectiveGlow = baseGlow + extraPoolGlow;
        
        this.ctx.globalAlpha = alpha * effectiveGlow;
        
        // Draw scaled sprite at particle position
        const drawSize = spriteSize * scale * poolScale;
        const halfDraw = drawSize / 2;
        
        // Choose sprite based on pooling intensity
        // Blend between sprites by drawing both with adjusted alpha for smooth transition
        if (p.poolingIntensity > 0) {
          // Draw pooling sprite with pooling intensity (with extra glow)
          this.ctx.globalAlpha = alpha * effectiveGlow * p.poolingIntensity;
          this.ctx.drawImage(
            this.poolingGlowSprite,
            p.x - halfDraw,
            p.y - halfDraw,
            drawSize,
            drawSize
          );
          
          // Draw flowing sprite with remaining intensity
          this.ctx.globalAlpha = alpha * baseGlow * (1 - p.poolingIntensity);
          this.ctx.drawImage(
            this.glowSprite,
            p.x - halfDraw,
            p.y - halfDraw,
            drawSize,
            drawSize
          );
        } else {
          // Just draw flowing sprite
          this.ctx.globalAlpha = alpha * baseGlow;
          this.ctx.drawImage(
            this.glowSprite,
            p.x - halfDraw,
            p.y - halfDraw,
            drawSize,
            drawSize
          );
        }
      }
      this.ctx.globalAlpha = 1.0;
    }
  }
  
  /**
   * Main animation loop
   */
  animate() {
    if (!this.isActive) return;
    
    this.updateParticles();
    this.drawParticles();
    
    this.animationFrame = requestAnimationFrame(this.animate);
  }
}

// Initialize animation when DOM is ready
let stormwaterFlowAnimation = null;

function initStormwaterFlow() {
  const canvas = document.getElementById('stormwater-canvas');
  
  if (!canvas) {
    console.error('Stormwater canvas not found');
    return;
  }
  
  // Wait for map to be initialized
  const checkMap = setInterval(() => {
    if (window.map) {
      clearInterval(checkMap);
      
      stormwaterFlowAnimation = new StormwaterFlowAnimation(window.map, canvas);
      
      // Set up button handler
      const btn = document.getElementById('stormwater-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          stormwaterFlowAnimation.toggle();
          btn.classList.toggle('active');
        });
      }
      
      console.log('Stormwater flow animation initialized (dynamic DEM processing)');
    }
  }, 100);
}

// Initialize when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStormwaterFlow);
} else {
  initStormwaterFlow();
}
