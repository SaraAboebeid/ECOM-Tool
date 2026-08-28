// ===== Västtrafik Live Transit Animation =====
// Real-time public transit overlay using Västtrafik API
// Displays live positions of buses, trams, trains, and ferries

(function() {
  'use strict';

// Canvas setup
const trafikCanvas = document.createElement('canvas');
trafikCanvas.id = 'trafik-canvas';
trafikCanvas.style.cssText = `
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 850;
  pointer-events: none;
  display: none;
`;
document.body.appendChild(trafikCanvas);

const trafikCtx = trafikCanvas.getContext('2d');

// Animation state
let trafikAnimationFrame = null;
let isTrafikAnimating = false;
let vehicles = [];
let lastFetchTime = 0;
let updateInterval = null;

// API Configuration - loaded from config file (not .env since this is client-side)
let apiConfig = {
  accessToken: null,
  tokenExpiry: 0,
  clientId: null,
  clientSecret: null,
  authenticationKey: null
};

// Configuration
const CONFIG = {
  // API settings
  apiBaseUrl: 'https://ext-api.vasttrafik.se/pr/v4',
  configPath: 'trafik-config.json',  // Local config file (gitignored)
  fetchInterval: 3000,               // Fetch every 3 seconds to avoid rate limiting
  tokenRefreshBuffer: 60000,          // Refresh token 1 minute before expiry
  positionsLimit: 200,                // Max vehicles per API call
  
  // Bounding box loaded from config, defaults to Gothenburg area
  boundingBox: {
    minLat: 57.677523,
    maxLat: 57.699659,
    minLng: 11.936224,
    maxLng: 12.018278
  },
  
  // Transport mode filter (only show these types)
  transportModes: ['tram', 'bus'],
  
  // Visual settings
  vehicleSize: 16,           // Larger icons
  glowRadius: 28,
  trailHistoryLength: 100,   // Capped trail for GPU performance
  interpolationSpeed: 0.08,  // Smooth glide factor (0-1)
  trailWidth: 5,             // Trail line width
  trailFadeStart: 0.8,       // Trail opacity at start (more visible)
  
  // Vehicle type colors (Västtrafik brand colors + data viz palette)
  colors: {
    BUS: {
      fill: '#00A5E0',      // Västtrafik blue
      glow: 'rgba(0, 165, 224, 0.6)',
      trail: 'rgba(0, 165, 224, 0.3)'
    },
    TRAM: {
      fill: '#FFD700',      // Gold/Yellow for trams
      glow: 'rgba(255, 215, 0, 0.6)',
      trail: 'rgba(255, 215, 0, 0.3)'
    },
    TRAIN: {
      fill: '#E31837',      // Red for trains
      glow: 'rgba(227, 24, 55, 0.6)',
      trail: 'rgba(227, 24, 55, 0.3)'
    },
    FERRY: {
      fill: '#00B4A0',      // Teal for ferries
      glow: 'rgba(0, 180, 160, 0.6)',
      trail: 'rgba(0, 180, 160, 0.3)'
    },
    UNKNOWN: {
      fill: '#FFFFFF',
      glow: 'rgba(255, 255, 255, 0.6)',
      trail: 'rgba(255, 255, 255, 0.3)'
    }
  },
  
  // Label settings
  showLabels: true,
  labelFont: '10px "Inter", sans-serif',
  labelColor: '#FFFFFF',
  labelBackground: 'rgba(0, 0, 0, 0.7)'
};

// Vehicle history for smooth interpolation
const vehicleHistory = new Map();

// ===== API Functions =====

// Load configuration from local file
async function loadConfig() {
  try {
    console.log('Trafik: Loading config from', CONFIG.configPath);
    const response = await fetch(CONFIG.configPath);
    if (!response.ok) {
      throw new Error(`Config file not found: ${CONFIG.configPath} (status: ${response.status})`);
    }
    const config = await response.json();
    console.log('Trafik: Config JSON parsed:', Object.keys(config));
    
    // Store credentials in apiConfig
    apiConfig.accessToken = config.accessToken;
    apiConfig.tokenExpiry = config.tokenExpiry || 0;
    apiConfig.clientId = config.clientId;
    apiConfig.clientSecret = config.clientSecret;
    apiConfig.authenticationKey = config.authenticationKey;
    
    console.log('✓ Trafik: Credentials loaded:', {
      hasClientId: !!apiConfig.clientId,
      hasClientSecret: !!apiConfig.clientSecret,
      hasAuthKey: !!apiConfig.authenticationKey,
      hasAccessToken: !!apiConfig.accessToken
    });
    
    // Load bounding box from config if provided [minLng, minLat, maxLng, maxLat]
    if (config.bbox && Array.isArray(config.bbox) && config.bbox.length === 4) {
      CONFIG.boundingBox = {
        minLng: config.bbox[0],
        minLat: config.bbox[1],
        maxLng: config.bbox[2],
        maxLat: config.bbox[3]
      };
      console.log(`✓ Trafik: Using custom bounding box: ${config.bbox.join(', ')}`);
    }
    
    console.log('✓ Trafik: Loaded API configuration');
    return true;
  } catch (err) {
    console.warn('Trafik: Could not load config file. Create trafik-config.json with your API credentials.');
    console.warn('See .env for the required fields.');
    return false;
  }
}

// Refresh OAuth2 access token
async function refreshAccessToken() {
  // Can use either authenticationKey or clientId/clientSecret
  if (!apiConfig.authenticationKey && (!apiConfig.clientId || !apiConfig.clientSecret)) {
    console.warn('Trafik: Missing client credentials for token refresh', {
      hasAuthKey: !!apiConfig.authenticationKey,
      hasClientId: !!apiConfig.clientId,
      hasClientSecret: !!apiConfig.clientSecret
    });
    return false;
  }
  
  try {
    // Use pre-encoded auth key if available, otherwise encode it
    const authKey = apiConfig.authenticationKey || btoa(`${apiConfig.clientId}:${apiConfig.clientSecret}`);
    console.log('Trafik: Refreshing access token...');
    
    const response = await fetch('https://ext-api.vasttrafik.se/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authKey}`
      },
      body: 'grant_type=client_credentials'
    });
    
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }
    
    const data = await response.json();
    apiConfig.accessToken = data.access_token;
    apiConfig.tokenExpiry = Date.now() + (data.expires_in * 1000);
    
    console.log('✓ Trafik: Access token refreshed');
    return true;
  } catch (err) {
    console.error('Trafik: Token refresh error:', err);
    return false;
  }
}

// Check if token needs refresh
async function ensureValidToken() {
  if (!apiConfig.accessToken) {
    return await refreshAccessToken();
  }
  
  if (Date.now() >= apiConfig.tokenExpiry - CONFIG.tokenRefreshBuffer) {
    return await refreshAccessToken();
  }
  
  return true;
}

// Fetch live vehicle positions from Västtrafik API
async function fetchLivePositions() {
  if (!await ensureValidToken()) {
    console.warn('Trafik: No valid access token');
    return [];
  }
  
  try {
    // Build the API URL with bounding box per Västtrafik API spec
    const bbox = CONFIG.boundingBox;
    const url = new URL(`${CONFIG.apiBaseUrl}/positions`);
    url.searchParams.set('lowerLeftLat', bbox.minLat);
    url.searchParams.set('lowerLeftLong', bbox.minLng);
    url.searchParams.set('upperRightLat', bbox.maxLat);
    url.searchParams.set('upperRightLong', bbox.maxLng);
    url.searchParams.set('limit', CONFIG.positionsLimit);
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiConfig.accessToken}`,
        'Accept': 'application/json'
      }
    });
    
    if (response.status === 401) {
      // Token expired, refresh and retry
      await refreshAccessToken();
      return fetchLivePositions();
    }
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    return parseVehiclePositions(data);
    
  } catch (err) {
    console.error('Trafik: Fetch error:', err);
    return [];
  }
}

// Parse API response into vehicle objects
// Västtrafik /positions returns array of JourneyPositionApiModel
function parseVehiclePositions(data) {
  if (!data || !Array.isArray(data)) {
    console.warn('Trafik: Unexpected API response format', data);
    return [];
  }
  
  return data
    .filter(journey => {
      // Filter by configured transport modes
      const mode = journey.line?.transportMode?.toLowerCase();
      return CONFIG.transportModes.includes(mode);
    })
    .map(journey => {
    // Get transport mode from line details
    const transportMode = journey.line?.transportMode?.toUpperCase() || 'UNKNOWN';
    
    // Map Västtrafik transport modes to our types
    let type = 'UNKNOWN';
    if (transportMode === 'BUS') {
      type = 'BUS';
    } else if (transportMode === 'TRAM') {
      type = 'TRAM';
    } else if (transportMode === 'TRAIN') {
      type = 'TRAIN';
    } else if (transportMode === 'FERRY') {
      type = 'FERRY';
    } else if (transportMode === 'TAXI') {
      type = 'BUS'; // Render taxi as bus style
    }
    
    // Get line designation (number/name)
    const lineName = journey.line?.shortName || 
                     journey.line?.designation || 
                     journey.line?.name || 
                     journey.name || '';
    
    // Get colors from API if available
    const bgColor = journey.line?.backgroundColor;
    const fgColor = journey.line?.foregroundColor;
    
    return {
      id: journey.detailsReference || Math.random().toString(36),
      lat: journey.latitude,
      lng: journey.longitude,
      type: type,
      line: lineName,
      direction: journey.direction || '',
      directionDetails: journey.directionDetails,
      apiColors: bgColor ? { bg: bgColor, fg: fgColor } : null,
      isRealtime: journey.line?.isRealtimeJourney || false,
      timestamp: Date.now()
    };
  }).filter(v => v.lat && v.lng); // Filter out invalid positions
}

// ===== Rendering Functions =====

// Project coordinates to canvas
function projectToCanvas(lng, lat) {
  const point = map.project([lng, lat]);
  const mapContainer = document.getElementById('map');
  const mapRect = mapContainer.getBoundingClientRect();
  const canvasRect = trafikCanvas.getBoundingClientRect();
  
  return {
    x: point.x - (canvasRect.left - mapRect.left),
    y: point.y - (canvasRect.top - mapRect.top)
  };
}

// Check if position is on screen
function isOnScreen(pos, padding = 50) {
  return pos.x >= -padding && 
         pos.x <= trafikCanvas.width + padding && 
         pos.y >= -padding && 
         pos.y <= trafikCanvas.height + padding;
}

// Draw a single vehicle - smooth gliding circle with line number and trail
function drawVehicle(ctx, vehicle) {
  // Use interpolated position for smooth gliding
  const displayLng = vehicle.displayLng ?? vehicle.lng;
  const displayLat = vehicle.displayLat ?? vehicle.lat;
  
  const pos = projectToCanvas(displayLng, displayLat);
  if (!isOnScreen(pos)) return;
  
  // Use API colors if available, otherwise fall back to type-based colors
  let bgColor = CONFIG.colors[vehicle.type]?.fill || '#FFFFFF';
  let fgColor = '#FFFFFF';
  if (vehicle.apiColors) {
    bgColor = vehicle.apiColors.bg;
    fgColor = vehicle.apiColors.fg || '#FFFFFF';
  }
  
  const size = CONFIG.vehicleSize;
  
  ctx.save();
  
  // Draw trail from position history
  const history = vehicle.positionHistory || [];
  if (history.length > 1) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Draw trail segments with fading opacity
    for (let i = 1; i < history.length; i++) {
      const p1 = projectToCanvas(history[i - 1].lng, history[i - 1].lat);
      const p2 = projectToCanvas(history[i].lng, history[i].lat);
      
      // Calculate opacity based on position in trail (older = more faded)
      const progress = i / history.length;
      const opacity = CONFIG.trailFadeStart * progress;
      
      // Gradient width (thinner at tail)
      const width = CONFIG.trailWidth * (0.3 + 0.7 * progress);
      
      ctx.strokeStyle = bgColor + Math.round(opacity * 255).toString(16).padStart(2, '0');
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    
    // Draw line from last history point to current position
    if (history.length > 0) {
      const lastHist = history[history.length - 1];
      const p1 = projectToCanvas(lastHist.lng, lastHist.lat);
      ctx.strokeStyle = bgColor + 'CC';
      ctx.lineWidth = CONFIG.trailWidth;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
  }
  
  // Soft glow effect
  ctx.globalCompositeOperation = 'lighter';
  const glow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, CONFIG.glowRadius);
  glow.addColorStop(0, `${bgColor}88`);
  glow.addColorStop(0.5, `${bgColor}44`);
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, CONFIG.glowRadius, 0, Math.PI * 2);
  ctx.fill();
  
  // Circle body with line color
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = bgColor;
  ctx.shadowColor = bgColor;
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  
  // Line number inside circle
  if (vehicle.line) {
    ctx.font = `bold ${Math.round(size * 0.85)}px "Inter", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fgColor;
    ctx.fillText(vehicle.line, pos.x, pos.y + 1);
  }
  
  ctx.restore();
}

// Draw all vehicles with smooth interpolation
function drawAllVehicles() {
  const width = trafikCanvas.width;
  const height = trafikCanvas.height;
  
  // Clear canvas
  trafikCtx.clearRect(0, 0, width, height);
  
  // Draw each vehicle
  vehicles.forEach(v => drawVehicle(trafikCtx, v));
}

// Draw legend in corner
function drawLegend(ctx) {
  const x = 20;
  let y = trafikCanvas.height - 100;
  const lineHeight = 18;
  
  // Count vehicles by type
  const counts = { BUS: 0, TRAM: 0 };
  vehicles.forEach(v => {
    if (counts.hasOwnProperty(v.type)) counts[v.type]++;
  });
  
  ctx.save();
  ctx.globalAlpha = 0.9;
  
  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.beginPath();
  ctx.roundRect(x - 10, y - 15, 115, 90, 5);
  ctx.fill();
  
  ctx.font = 'bold 11px "Inter", sans-serif';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText('VÄSTTRAFIK LIVE', x, y);
  y += lineHeight;
  
  // Total count
  ctx.font = '10px "Inter", sans-serif';
  ctx.fillStyle = '#AAAAAA';
  ctx.fillText(`${vehicles.length} fordon`, x, y);
  y += lineHeight + 4;
  
  // Vehicle type indicators with counts (tram/bus only)
  const types = [
    { type: 'TRAM', label: 'Spårvagn' },
    { type: 'BUS', label: 'Buss' }
  ];
  
  ctx.font = '10px "Inter", sans-serif';
  types.forEach(({ type, label }) => {
    const colors = CONFIG.colors[type];
    const count = counts[type];
    
    // Draw circle shape (matching vehicle display)
    ctx.fillStyle = colors.fill;
    ctx.shadowColor = colors.fill;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(x + 5, y - 4, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    // Label with count
    ctx.fillStyle = count > 0 ? '#FFFFFF' : '#666666';
    ctx.fillText(`${label} (${count})`, x + 15, y);
    y += lineHeight;
  });
  
  ctx.restore();
}

// ===== Animation Loop =====

async function updateVehicles() {
  const now = Date.now();
  
  // Fetch new positions at interval
  if (now - lastFetchTime > CONFIG.fetchInterval) {
    const newPositions = await fetchLivePositions();
    if (newPositions.length > 0) {
      // Merge with existing vehicles for smooth interpolation
      const existingMap = new Map(vehicles.map(v => [v.id, v]));
      
      newPositions.forEach(v => {
        const existing = existingMap.get(v.id);
        if (existing) {
          // Preserve display position for interpolation
          v.displayLng = existing.displayLng ?? existing.lng;
          v.displayLat = existing.displayLat ?? existing.lat;
          
          // Preserve and update position history
          v.positionHistory = existing.positionHistory || [];
          
          // Add current display position to history if it moved
          const lastHist = v.positionHistory[v.positionHistory.length - 1];
          if (!lastHist || 
              Math.abs(lastHist.lng - v.displayLng) > 0.00001 || 
              Math.abs(lastHist.lat - v.displayLat) > 0.00001) {
            v.positionHistory.push({ lng: v.displayLng, lat: v.displayLat });
            // Trim history to max length
            if (v.positionHistory.length > CONFIG.trailHistoryLength) {
              v.positionHistory.shift();
            }
          }
        } else {
          // New vehicle starts at actual position with empty history
          v.displayLng = v.lng;
          v.displayLat = v.lat;
          v.positionHistory = [];
        }
      });
      
      vehicles = newPositions;
      console.log(`Trafik: Updated ${vehicles.length} vehicle positions (tram/bus only)`);
    }
    lastFetchTime = now;
  }
}

// Smooth interpolation towards target position and record history
function interpolateVehicles() {
  const speed = CONFIG.interpolationSpeed;
  vehicles.forEach(v => {
    if (v.displayLng !== undefined && v.displayLat !== undefined) {
      // Record position before interpolation (for trail)
      const prevLng = v.displayLng;
      const prevLat = v.displayLat;
      
      // Lerp towards target
      v.displayLng += (v.lng - v.displayLng) * speed;
      v.displayLat += (v.lat - v.displayLat) * speed;
      
      // Add to history frequently for smooth persistent trail
      if (!v.positionHistory) v.positionHistory = [];
      const lastHist = v.positionHistory[v.positionHistory.length - 1];
      // Record every tiny movement for smooth trail
      if (!lastHist || 
          Math.abs(lastHist.lng - v.displayLng) > 0.0000005 || 
          Math.abs(lastHist.lat - v.displayLat) > 0.0000005) {
        v.positionHistory.push({ lng: v.displayLng, lat: v.displayLat });
        if (v.positionHistory.length > CONFIG.trailHistoryLength) {
          v.positionHistory.shift();
        }
      }
    }
  });
}

function animateTrafik() {
  if (!isTrafikAnimating) return;
  
  interpolateVehicles();
  drawAllVehicles();
  trafikAnimationFrame = requestAnimationFrame(animateTrafik);
}

// ===== Canvas Management =====

function resizeTrafikCanvas() {
  const s = computeOverlayPixelSize();
  trafikCanvas.width = s.w;
  trafikCanvas.height = s.h;
  trafikCanvas.style.width = s.w + 'px';
  trafikCanvas.style.height = s.h + 'px';
}

// ===== Public API =====

async function startTrafikAnimation() {
  if (isTrafikAnimating) return;
  
  // Load config
  const configLoaded = await loadConfig();
  if (!configLoaded) {
    console.warn('Trafik: Cannot start without valid configuration');
    console.warn('Create trafik-config.json with your Västtrafik API credentials');
    return;
  }
  
  isTrafikAnimating = true;
  trafikCanvas.style.display = 'block';
  resizeTrafikCanvas();
  
  // Initial fetch
  await updateVehicles();
  
  // Start update interval
  updateInterval = setInterval(() => {
    if (isTrafikAnimating) {
      updateVehicles();
    } else {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  }, CONFIG.fetchInterval);
  
  animateTrafik();
  console.log('✓ Trafik: Live transit animation started');
}

function stopTrafikAnimation() {
  isTrafikAnimating = false;
  trafikCanvas.style.display = 'none';
  
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  
  if (trafikAnimationFrame) {
    cancelAnimationFrame(trafikAnimationFrame);
    trafikAnimationFrame = null;
  }
  
  trafikCtx.clearRect(0, 0, trafikCanvas.width, trafikCanvas.height);
  vehicles = [];
  vehicleHistory.clear();
  
  console.log('Trafik: Live transit animation stopped');
}

// Handle window resize
window.addEventListener('resize', () => {
  if (isTrafikAnimating) {
    resizeTrafikCanvas();
  }
});

// Expose for external control
window.trafikAnimation = {
  start: startTrafikAnimation,
  stop: stopTrafikAnimation,
  isActive: () => isTrafikAnimating,
  getVehicles: () => vehicles,
  updateBoundingBox: (bbox) => {
    CONFIG.boundingBox = { ...CONFIG.boundingBox, ...bbox };
  }
};

console.log('Trafik: Live transit animation module loaded');

})();
