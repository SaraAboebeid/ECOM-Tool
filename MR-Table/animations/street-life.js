// ===== Street Life Animation =====
// Animated pedestrians, cars, and buses following the street network
// Active by default when no other visualization is running

(function() {
  'use strict';

const streetLifeCanvas = document.createElement('canvas');
streetLifeCanvas.id = 'street-life-canvas';
streetLifeCanvas.style.cssText = `
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 845;
  pointer-events: none;
  display: none;
`;
document.body.appendChild(streetLifeCanvas);

const streetLifeCtx = streetLifeCanvas.getContext('2d');

// Offscreen canvas for static layers (streetlights + buildings) — only redrawn on map move
let staticLayerCanvas = null;
let staticLayerCtx = null;
let staticLayerDirty = true; // Flag to redraw static layer
let lastMapCenter = null;
let lastMapZoom = null;
let lastMapBearing = null;

// Animation state
let streetLifeAnimationFrame = null;
let isStreetLifeAnimating = false;
let streetLifeData = null;
let streetLifeDataLoaded = false;

// Entity collections
let vehicles = [];
let pedestrians = [];
let streetlights = []; // Static infrastructure lights
let streetPaths = []; // Full paths for navigation
let buildings = []; // Building footprints for glow effect
let buildingFlickerStates = []; // Track which buildings are flickering
let emergencyVehicle = null; // Single active emergency vehicle
let emergencySpawnTimer = null;

// City ambient sound
let cityAmbientAudio = null;
let audioFadeInterval = null;
const AUDIO_FADE_DURATION = 1500; // 1.5 seconds fade in/out
const AUDIO_MAX_VOLUME = 0.5; // Maximum volume level
const AUDIO_FADE_STEPS = 30; // Smooth fade steps

// Configuration
const CONFIG = {
  maxCars: 18,
  maxBuses: 4,
  maxBicycles: 10,
  maxTaxis: 5,
  maxPedestrians: 200,   // Reduced for low-end GPU performance
  carSpeed: 0.002,       // Progress per frame along path
  busSpeed: 0.0012,      // Buses are slower
  bicycleSpeed: 0.0015,  // Cyclists between cars and pedestrians
  pedestrianSpeed: 0.0005, // Faster walking speed
  spawnInterval: 200,    // Faster spawning for density
  
  // Streetlight Configuration (Warm Sodium Vapor look)
  streetlightColor: 'rgba(255, 210, 150, 0.6)', // Brighter warm glow
  streetlightRadius: 60,   // Size of the light pool in pixels
  streetlightSpacing: 0.0008, // Moderate spacing between lights
  
  // Building Window Lights Configuration
  buildingGlowColor: 'rgba(255, 220, 150, 0.25)',  // Brighter warm glow
  buildingDashLength: 8,    // Length of lit "window" dashes
  buildingGapLength: 12,    // Gap between dashes
  buildingGlowWidth: 2,     // Width of the glow stroke
  
  // Emergency Vehicle Configuration (Narrative Events)
  emergencySpawnMin: 10000,   // Min time between spawns (10 sec)
  emergencySpawnMax: 20000,   // Max time between spawns (20 sec)
  emergencySpeedMultiplier: 1.5, // Faster than normal cars
  emergencyLightRadius: 60,   // Size of spinning light beam (small)
  emergencyFlashRate: 20,     // Flashes per second (VERY fast)
  
  // Building flicker configuration
  buildingFlickerChance: 0.0003, // Chance per frame for a building to flicker (very rare)
  
  // Trail effect control
  trailFade: 0.96,       // High = long trails, Low = short trails
  
  // Visual sizes (in pixels)
  carLength: 12,
  carWidth: 6,
  busLength: 22,
  busWidth: 7,
  bicycleLength: 6,
  bicycleWidth: 3,
  pedestrianSize: 4,
  
  // Dark Mode "Data Visualization" Palette - Professional Urban Informatics
  carColors: [
    // Cyan (Data Stream) - primary accent
    { body: '#00f2ff', headlight: '#ffffff', taillight: '#ff0055' },
    // White (Clean)
    { body: '#e0e0e0', headlight: '#ffffff', taillight: '#ff0055' },
    // Deep Blue (Stealth)
    { body: '#1a2b45', headlight: '#aaddff', taillight: '#ff0055' },
    // Soft Teal
    { body: '#2d6a6a', headlight: '#aaffff', taillight: '#ff0055' },
    // Muted Purple (accent)
    { body: '#4a3a6a', headlight: '#ddccff', taillight: '#ff0055' },
  ],
  taxiColors: [
    // Gold (Public Transit Highlighting) - stands out on dark map
    { body: '#ffcc00', headlight: '#ffffff', taillight: '#ff0055', sign: '#00ff88' },
    // Electric Yellow
    { body: '#e6e600', headlight: '#ffffff', taillight: '#ff0055', sign: '#00ff88' },
  ],
  busColors: [
    // Gold (Public Transit Highlighting) - clear visibility
    { body: '#ffcc00', windows: '#1a1a2e', lights: '#ffffff' },
    // Transit Blue
    { body: '#0088cc', windows: '#1a1a2e', lights: '#ffffff' },
  ],
  bicycleColors: [
    // Subtle accent colors that pop on dark background
    { frame: '#00f2ff', rider: '#445566' },
    { frame: '#00cc88', rider: '#445566' },
    { frame: '#ff6688', rider: '#445566' },
  ],
  // Ghostly pedestrians - subtle but visible
  pedestrianColors: [
    '#334455', '#445566', '#556677', '#3a4a5a', '#4a5a6a',
    '#00aaaa', '#00aa88' // occasional cyan accent
  ]
};

// Road types suitable for vehicles vs pedestrians
const vehicleRoads = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service'];
const pedestrianPaths = ['footway', 'path', 'pedestrian', 'cycleway', 'residential', 'living_street', 'service', 'tertiary', 'secondary'];
const busRoutes = ['primary', 'secondary', 'tertiary', 'trunk'];
const cycleRoutes = ['cycleway', 'path', 'residential', 'tertiary', 'secondary', 'living_street'];

// Load street network data
function loadStreetLifeData() {
  if (streetLifeDataLoaded) return Promise.resolve();
  
  return fetch('media/street-network.geojson')
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(geojson => {
      streetLifeData = geojson;
      parseStreetPaths(geojson);
      
      // Generate static streetlights along paths
      generateStreetlights();
      
      // Load building footprints
      loadBuildingFootprints();
      
      streetLifeDataLoaded = true;
      console.log(`✓ Street Life: Loaded ${streetPaths.length} paths for animation`);
    })
    .catch(err => {
      console.warn('Street Life: Could not load street network:', err);
    });
}

// Parse GeoJSON into usable paths with PRE-CALCULATED cumulative distances
// This is critical for performance - avoids Math.sqrt() every frame
function parseStreetPaths(geojson) {
  streetPaths = [];
  
  if (!geojson || !geojson.features) return;
  
  geojson.features.forEach(feature => {
    const highway = feature.properties?.highway || 'default';
    
    let coordinates = [];
    
    if (feature.geometry.type === 'LineString') {
      coordinates = feature.geometry.coordinates;
    } else if (feature.geometry.type === 'MultiLineString') {
      // Flatten multi-line strings
      feature.geometry.coordinates.forEach(line => {
        if (coordinates.length > 0) {
          coordinates.push(null);
        }
        coordinates = coordinates.concat(line);
      });
    }
    
    // Filter out null markers
    coordinates = coordinates.filter(c => c !== null);
    
    if (coordinates.length >= 2) {
      // Pre-calculate cumulative lengths (OPTIMIZATION)
      let totalLength = 0;
      const cumulativeLengths = [0];
      const segmentAngles = []; // Pre-calculate angles too!
      
      for (let i = 0; i < coordinates.length - 1; i++) {
        // Scale longitude by cos(latitude) to correct for Mercator projection.
        // Without this, diagonal roads appear rotated ~10-15° at high latitudes.
        const cosLat = Math.cos(coordinates[i][1] * Math.PI / 180);
        const dx = (coordinates[i + 1][0] - coordinates[i][0]) * cosLat;
        const dy = coordinates[i + 1][1] - coordinates[i][1];
        const segLen = Math.sqrt(dx * dx + dy * dy);
        totalLength += segLen;
        cumulativeLengths.push(totalLength);
        // Pre-calculate segment angle (now Mercator-corrected)
        segmentAngles.push(Math.atan2(dy, dx));
      }
      
      streetPaths.push({
        coords: coordinates,
        cumulativeLengths: cumulativeLengths, // O(1) lookup!
        segmentAngles: segmentAngles,          // Pre-calculated angles!
        totalLength: totalLength,
        type: highway,
        isVehicleRoad: vehicleRoads.includes(highway),
        isPedestrianPath: pedestrianPaths.includes(highway),
        isBusRoute: busRoutes.includes(highway),
        isCycleRoute: cycleRoutes.includes(highway)
      });
    }
  });
  
  // Sort by length for better distribution
  streetPaths.sort((a, b) => b.totalLength - a.totalLength);
  
  console.log(`✓ Street Life: Pre-calculated distances for ${streetPaths.length} paths`);
}

// Project coordinates to canvas
function projectToStreetLifeCanvas(lng, lat) {
  const point = map.project([lng, lat]);
  const mapContainer = document.getElementById('map');
  const mapRect = mapContainer.getBoundingClientRect();
  const canvasRect = streetLifeCanvas.getBoundingClientRect();
  
  return {
    x: point.x - (canvasRect.left - mapRect.left),
    y: point.y - (canvasRect.top - mapRect.top)
  };
}

// Get point along a path at given progress (0-1)
// OPTIMIZED: Uses pre-calculated cumulative lengths - no Math.sqrt() per frame!
function getPointAlongPath(path, progress) {
  if (path.coords.length < 2) return null;
  
  const targetDist = progress * path.totalLength;
  
  // Find segment using simple search (arrays are typically short)
  // For very long paths, could upgrade to binary search
  let i = 0;
  while (i < path.cumulativeLengths.length - 1 && path.cumulativeLengths[i + 1] < targetDist) {
    i++;
  }
  
  // Handle edge case at path end
  if (i >= path.coords.length - 1) {
    i = path.coords.length - 2;
  }
  
  // Interpolate position within segment
  const segmentStartDist = path.cumulativeLengths[i];
  const segmentLen = path.cumulativeLengths[i + 1] - segmentStartDist;
  const segmentProgress = segmentLen > 0 ? (targetDist - segmentStartDist) / segmentLen : 0;
  
  const p1 = path.coords[i];
  const p2 = path.coords[i + 1];
  
  return {
    lng: p1[0] + (p2[0] - p1[0]) * segmentProgress,
    lat: p1[1] + (p2[1] - p1[1]) * segmentProgress,
    angle: path.segmentAngles[i] // Pre-calculated angle - zero computation!
  };
}

// Spawn a new car - with smart spawning based on road hierarchy
function spawnCar() {
  if (vehicles.filter(v => v.type === 'car').length >= CONFIG.maxCars) return;
  
  const eligiblePaths = streetPaths.filter(p => p.isVehicleRoad && p.totalLength > 0.001);
  if (eligiblePaths.length === 0) return;
  
  // SMART SPAWNING: Filter for major roads first
  const majorRoads = streetPaths.filter(p => 
    (p.type === 'motorway' || p.type === 'primary' || p.type === 'trunk' || p.type === 'secondary') && 
    p.totalLength > 0.001
  );
  
  // 70% chance to pick a major road, 30% chance for random street
  let pool = (Math.random() < 0.7 && majorRoads.length > 0) ? majorRoads : eligiblePaths;
  
  const path = pool[Math.floor(Math.random() * pool.length)];
  const colorScheme = CONFIG.carColors[Math.floor(Math.random() * CONFIG.carColors.length)];
  const reverse = Math.random() > 0.5;
  
  vehicles.push({
    type: 'car',
    path: path,
    progress: reverse ? 1 : 0,
    speed: CONFIG.carSpeed * (0.8 + Math.random() * 0.4),
    speedVar: 0.9 + Math.random() * 0.2, // Natural speed variance
    direction: reverse ? -1 : 1,
    colors: colorScheme,
    headlightsOn: true,
    wobble: Math.random() * Math.PI * 2
  });
}

// Spawn a new bus
function spawnBus() {
  if (vehicles.filter(v => v.type === 'bus').length >= CONFIG.maxBuses) return;
  
  const eligiblePaths = streetPaths.filter(p => p.isBusRoute && p.totalLength > 0.002);
  if (eligiblePaths.length === 0) return;
  
  const path = eligiblePaths[Math.floor(Math.random() * eligiblePaths.length)];
  const colorScheme = CONFIG.busColors[Math.floor(Math.random() * CONFIG.busColors.length)];
  const reverse = Math.random() > 0.5;
  
  vehicles.push({
    type: 'bus',
    path: path,
    progress: reverse ? 1 : 0,
    speed: CONFIG.busSpeed * (0.9 + Math.random() * 0.2),
    speedVar: 0.9 + Math.random() * 0.2, // Natural speed variance
    direction: reverse ? -1 : 1,
    colors: colorScheme,
    stopTimer: 0,
    isAtStop: false
  });
}

// Spawn a taxi - prefers major roads where fares are
function spawnTaxi() {
  if (vehicles.filter(v => v.type === 'taxi').length >= CONFIG.maxTaxis) return;
  
  const eligiblePaths = streetPaths.filter(p => p.isVehicleRoad && p.totalLength > 0.001);
  if (eligiblePaths.length === 0) return;
  
  // Taxis prefer commercial/major roads
  const majorRoads = streetPaths.filter(p => 
    (p.type === 'primary' || p.type === 'secondary' || p.type === 'tertiary') && 
    p.totalLength > 0.001
  );
  
  let pool = (Math.random() < 0.8 && majorRoads.length > 0) ? majorRoads : eligiblePaths;
  
  const path = pool[Math.floor(Math.random() * pool.length)];
  const colorScheme = CONFIG.taxiColors[Math.floor(Math.random() * CONFIG.taxiColors.length)];
  const reverse = Math.random() > 0.5;
  
  vehicles.push({
    type: 'taxi',
    path: path,
    progress: reverse ? 1 : 0,
    speed: CONFIG.carSpeed * (0.7 + Math.random() * 0.3),
    speedVar: 0.9 + Math.random() * 0.2, // Natural speed variance
    direction: reverse ? -1 : 1,
    colors: colorScheme,
    headlightsOn: true,
    isAvailable: Math.random() > 0.3
  });
}

// Spawn a bicycle
function spawnBicycle() {
  if (vehicles.filter(v => v.type === 'bicycle').length >= CONFIG.maxBicycles) return;
  
  const eligiblePaths = streetPaths.filter(p => p.isCycleRoute && p.totalLength > 0.0008);
  if (eligiblePaths.length === 0) return;
  
  const path = eligiblePaths[Math.floor(Math.random() * eligiblePaths.length)];
  const colorScheme = CONFIG.bicycleColors[Math.floor(Math.random() * CONFIG.bicycleColors.length)];
  const reverse = Math.random() > 0.5;
  
  vehicles.push({
    type: 'bicycle',
    path: path,
    progress: reverse ? 1 : 0,
    speed: CONFIG.bicycleSpeed * (0.7 + Math.random() * 0.6),
    speedVar: 0.9 + Math.random() * 0.2, // Natural speed variance
    direction: reverse ? -1 : 1,
    colors: colorScheme,
    pedalPhase: Math.random() * Math.PI * 2
  });
}

// Spawn a pedestrian
function spawnPedestrian() {
  if (pedestrians.length >= CONFIG.maxPedestrians) return;
  
  const eligiblePaths = streetPaths.filter(p => p.isPedestrianPath && p.totalLength > 0.0005);
  if (eligiblePaths.length === 0) return;
  
  const path = eligiblePaths[Math.floor(Math.random() * eligiblePaths.length)];
  const color = CONFIG.pedestrianColors[Math.floor(Math.random() * CONFIG.pedestrianColors.length)];
  const reverse = Math.random() > 0.5;
  
  pedestrians.push({
    path: path,
    progress: reverse ? 1 : 0,
    speed: CONFIG.pedestrianSpeed * (0.6 + Math.random() * 0.8),
    direction: reverse ? -1 : 1,
    color: color,
    wobblePhase: Math.random() * Math.PI * 2,
    size: CONFIG.pedestrianSize * (0.8 + Math.random() * 0.4)
  });
}

// Spawn an emergency vehicle (ambulance or police)
function spawnEmergencyVehicle() {
  // Only one at a time
  if (emergencyVehicle) return;
  
  // Use any road that cars can use for emergency vehicles
  const eligiblePaths = streetPaths.filter(p => 
    ['primary', 'secondary', 'tertiary', 'trunk', 'motorway', 'residential', 'unclassified'].includes(p.highway) && 
    p.totalLength > 0.001
  );
  
  // Fallback to ANY path if no eligible ones found
  const pathsToUse = eligiblePaths.length > 0 ? eligiblePaths : streetPaths.filter(p => p.totalLength > 0.001);
  if (pathsToUse.length === 0) {
    console.log('🚨 No paths available for emergency vehicle!');
    return;
  }
  
  const path = pathsToUse[Math.floor(Math.random() * pathsToUse.length)];
  const reverse = Math.random() > 0.5;
  const isPolice = Math.random() > 0.5;
  
  emergencyVehicle = {
    path: path,
    progress: reverse ? 1 : 0,
    speed: CONFIG.carSpeed * CONFIG.emergencySpeedMultiplier,
    direction: reverse ? -1 : 1,
    vehicleType: isPolice ? 'police' : 'ambulance',
    flashPhase: 0,
    spinPhase: 0
  };
  
  console.log(`🚨 Emergency ${emergencyVehicle.vehicleType} dispatched!`);
}

// Schedule next emergency vehicle spawn
function scheduleEmergencySpawn() {
  const delay = CONFIG.emergencySpawnMin + 
    Math.random() * (CONFIG.emergencySpawnMax - CONFIG.emergencySpawnMin);
  
  emergencySpawnTimer = setTimeout(() => {
    if (isStreetLifeAnimating) {
      spawnEmergencyVehicle();
      scheduleEmergencySpawn(); // Schedule next one
    }
  }, delay);
}

// Draw emergency vehicle with flashing lights and spinning beam
function drawEmergencyVehicle(ctx, pos, angle, vehicle) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  
  const finalAngle = vehicle.direction === 1 ? angle + Math.PI : angle;
  ctx.rotate(finalAngle);
  
  // Determine which light is on (alternating red/blue)
  const flashState = Math.floor(vehicle.flashPhase) % 2;
  const primaryColor = flashState === 0 ? '#ff0000' : '#0055ff';
  const secondaryColor = flashState === 0 ? '#0055ff' : '#ff0000';
  
  // 1. SPINNING LIGHT BEAM (large sweeping effect)
  ctx.globalCompositeOperation = 'lighter';
  const beamAngle = vehicle.spinPhase;
  const beamLength = CONFIG.emergencyLightRadius;
  
  // Red beam - subtle
  ctx.save();
  ctx.rotate(beamAngle);
  const redGrad = ctx.createLinearGradient(0, 0, beamLength, 0);
  redGrad.addColorStop(0, 'rgba(255, 80, 80, 0.6)');
  redGrad.addColorStop(0.3, 'rgba(255, 0, 0, 0.3)');
  redGrad.addColorStop(1, 'rgba(255, 0, 0, 0)');
  ctx.fillStyle = redGrad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(beamLength, -beamLength * 0.5);
  ctx.lineTo(beamLength, beamLength * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  
  // Blue beam (opposite direction) - subtle
  ctx.save();
  ctx.rotate(beamAngle + Math.PI);
  const blueGrad = ctx.createLinearGradient(0, 0, beamLength, 0);
  blueGrad.addColorStop(0, 'rgba(80, 120, 255, 0.6)');
  blueGrad.addColorStop(0.3, 'rgba(0, 80, 255, 0.3)');
  blueGrad.addColorStop(1, 'rgba(0, 80, 255, 0)');
  ctx.fillStyle = blueGrad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(beamLength, -beamLength * 0.5);
  ctx.lineTo(beamLength, beamLength * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  
  // 2. FLASHING LIGHT HALO (subtle pulsing glow around vehicle)
  const pulseIntensity = 0.3 + Math.abs(Math.sin(vehicle.flashPhase * 2)) * 0.2;
  
  // Red halo - small
  const redHalo = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
  redHalo.addColorStop(0, `rgba(255, 50, 50, ${pulseIntensity * (flashState === 0 ? 0.6 : 0.15)})`);
  redHalo.addColorStop(0.5, `rgba(255, 0, 0, ${pulseIntensity * (flashState === 0 ? 0.2 : 0.03)})`);
  redHalo.addColorStop(1, 'rgba(255, 0, 0, 0)');
  ctx.fillStyle = redHalo;
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();
  
  // Blue halo - small
  const blueHalo = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
  blueHalo.addColorStop(0, `rgba(50, 100, 255, ${pulseIntensity * (flashState === 1 ? 0.6 : 0.15)})`);
  blueHalo.addColorStop(0.5, `rgba(0, 100, 255, ${pulseIntensity * (flashState === 1 ? 0.2 : 0.03)})`);
  blueHalo.addColorStop(1, 'rgba(0, 100, 255, 0)');
  ctx.fillStyle = blueHalo;
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();
  
  // 3. VEHICLE BODY (white core)
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();
  
  // 4. FLASHING LIGHT BARS (small with glow)
  ctx.globalCompositeOperation = 'lighter';
  
  // Red light bar with glow
  const redBarGlow = ctx.createRadialGradient(-5, 0, 0, -5, 0, 12);
  redBarGlow.addColorStop(0, flashState === 0 ? 'rgba(255, 50, 50, 0.8)' : 'rgba(255, 50, 50, 0.3)');
  redBarGlow.addColorStop(0.5, flashState === 0 ? 'rgba(255, 0, 0, 0.4)' : 'rgba(255, 0, 0, 0.1)');
  redBarGlow.addColorStop(1, 'rgba(255, 0, 0, 0)');
  ctx.fillStyle = redBarGlow;
  ctx.beginPath();
  ctx.arc(-5, 0, 12, 0, Math.PI * 2);
  ctx.fill();
  
  // Blue light bar with glow
  const blueBarGlow = ctx.createRadialGradient(5, 0, 0, 5, 0, 12);
  blueBarGlow.addColorStop(0, flashState === 1 ? 'rgba(50, 100, 255, 0.8)' : 'rgba(50, 100, 255, 0.3)');
  blueBarGlow.addColorStop(0.5, flashState === 1 ? 'rgba(0, 80, 255, 0.4)' : 'rgba(0, 80, 255, 0.1)');
  blueBarGlow.addColorStop(1, 'rgba(0, 80, 255, 0)');
  ctx.fillStyle = blueBarGlow;
  ctx.beginPath();
  ctx.arc(5, 0, 12, 0, Math.PI * 2);
  ctx.fill();
  
  // Solid light bar cores
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = flashState === 0 ? '#ff3333' : '#ff6666';
  ctx.beginPath();
  ctx.arc(-5, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.fillStyle = flashState === 1 ? '#3366ff' : '#6699ff';
  ctx.beginPath();
  ctx.arc(5, 0, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Update all entities with smooth organic movement
function updateStreetLifeEntities() {
  // Update vehicles - smooth movement using speedVar
  vehicles = vehicles.filter(v => {
    // Bus stop logic
    if (v.type === 'bus' && v.isAtStop) {
      v.stopTimer--;
      if (v.stopTimer <= 0) v.isAtStop = false;
      return true;
    }
    
    // Random bus stop
    if (v.type === 'bus' && !v.isAtStop && Math.random() < 0.001) {
      v.isAtStop = true;
      v.stopTimer = 60 + Math.floor(Math.random() * 120);
      return true;
    }
    
    // Bicycle pedal animation
    if (v.type === 'bicycle') v.pedalPhase += 0.2;
    
    // SMOOTH MOVEMENT: Multiply by unique speedVar so vehicles don't move in lockstep
    const variance = v.speedVar || 1.0;
    v.progress += v.speed * variance * v.direction;
    
    return v.progress >= 0 && v.progress <= 1;
  });
  
  // Update pedestrians with "Organic Wobble"
  pedestrians = pedestrians.filter(p => {
    p.progress += p.speed * p.direction;
    // Organic movement: changes wobble over time for natural flow
    p.wobblePhase += 0.05;
    return p.progress >= 0 && p.progress <= 1;
  });
  
  // Auto-replenish to keep the city busy (O(1) type counting)
  let carCount = 0, taxiCount = 0, busCount = 0, bicycleCount = 0;
  for (let i = 0; i < vehicles.length; i++) {
    switch (vehicles[i].type) {
      case 'car': carCount++; break;
      case 'taxi': taxiCount++; break;
      case 'bus': busCount++; break;
      case 'bicycle': bicycleCount++; break;
    }
  }
  while (carCount < CONFIG.maxCars) { spawnCar(); carCount++; }
  while (taxiCount < CONFIG.maxTaxis) { spawnTaxi(); taxiCount++; }
  while (busCount < CONFIG.maxBuses) { spawnBus(); busCount++; }
  while (bicycleCount < CONFIG.maxBicycles) { spawnBicycle(); bicycleCount++; }
  while (pedestrians.length < CONFIG.maxPedestrians) spawnPedestrian();
  
  // Update emergency vehicle
  if (emergencyVehicle) {
    emergencyVehicle.progress += emergencyVehicle.speed * emergencyVehicle.direction;
    emergencyVehicle.flashPhase += CONFIG.emergencyFlashRate * 0.1;
    emergencyVehicle.spinPhase += 0.15;
    
    // Remove when off path
    if (emergencyVehicle.progress < 0 || emergencyVehicle.progress > 1) {
      console.log(`🚨 Emergency ${emergencyVehicle.vehicleType} has left the area`);
      emergencyVehicle = null;
    }
  }
  
  // Connect to Calibration Grid - trigger pulses when vehicles pass near nodes
  if (window.triggerGridNodePulse && window.calibrationNodes) {
    vehicles.forEach(v => {
      if (Math.random() > 0.1) return; // Only check 10% of frames
      const point = getPointAlongPath(v.path, v.progress);
      if (!point) return;
      const pos = projectToStreetLifeCanvas(point.lng, point.lat);
      
      window.calibrationNodes.forEach(node => {
        const dx = pos.x - node.screenX;
        const dy = pos.y - node.screenY;
        if (dx*dx + dy*dy < 1600) {
          window.triggerGridNodePulse(node.id);
        }
      });
    });
  }
}

// Draw a car - High-Tech with Volumetric Beams
function drawCar(ctx, pos, angle, colors, headlightsOn, direction = 1) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  
  const rotationOffset = direction < 0 ? Math.PI : 0;
  ctx.rotate(-angle + Math.PI + rotationOffset);
  
  const len = CONFIG.carLength;
  const width = CONFIG.carWidth;
  
  // 1. VOLUMETRIC HEADLIGHTS (Gradient Cones)
  if (headlightsOn) {
    const beamLen = 50; // Longer beam
    // Create gradient: Bright -> Invisible
    const grad = ctx.createLinearGradient(0, -len/2, 0, -len/2 - beamLen);
    grad.addColorStop(0, 'rgba(255, 255, 220, 0.4)'); // Source
    grad.addColorStop(1, 'rgba(255, 255, 220, 0)');   // Fade out
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-width/2 + 1, -len/2);
    ctx.lineTo(-width - 2, -len/2 - beamLen); // Flare out left
    ctx.lineTo(width + 2, -len/2 - beamLen);  // Flare out right
    ctx.lineTo(width/2 - 1, -len/2);
    ctx.fill();
  }
  
  // 2. BODY GLOW (The "Neon" look)
  ctx.shadowColor = colors.body;
  ctx.shadowBlur = 18; // This makes the car look like a light source
  ctx.fillStyle = colors.body;
  
  ctx.beginPath();
  ctx.roundRect(-width / 2, -len / 2, width, len, 3);
  ctx.fill();
  
  // 3. TAILLIGHTS (Intense Red Trails)
  // We draw these slightly offset so they leave red streaks
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#ff2222';
  ctx.fillRect(-width/2 + 1, len/2 - 1, 2, 2);
  ctx.fillRect(width/2 - 3, len/2 - 1, 2, 2);
  
  ctx.shadowBlur = 0;
  ctx.restore();
}

// Draw a bus - with volumetric headlights
function drawBus(ctx, pos, angle, colors, isAtStop, direction = 1) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  // Flip 180° when traveling in reverse so headlights face forward
  const rotationOffset = direction < 0 ? Math.PI : 0;
  ctx.rotate(-angle + Math.PI + rotationOffset);
  
  const len = CONFIG.busLength;
  const width = CONFIG.busWidth;
  
  // Volumetric headlight beams (Gradient Cones)
  const beamLen = 60;
  const grad = ctx.createLinearGradient(0, -len/2, 0, -len/2 - beamLen);
  grad.addColorStop(0, 'rgba(255, 255, 200, 0.35)');
  grad.addColorStop(1, 'rgba(255, 255, 200, 0)');
  
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-width/2 + 1, -len/2);
  ctx.lineTo(-width - 5, -len/2 - beamLen);
  ctx.lineTo(width + 5, -len/2 - beamLen);
  ctx.lineTo(width/2 - 1, -len/2);
  ctx.fill();
  
  // Bus body with glow
  ctx.shadowColor = colors.body;
  ctx.shadowBlur = 20;
  ctx.fillStyle = colors.body;
  ctx.beginPath();
  ctx.roundRect(-width / 2, -len / 2, width, len, 3);
  ctx.fill();
  
  // Windows (multiple along the side) - illuminated from inside
  ctx.shadowColor = colors.windows;
  ctx.shadowBlur = 8;
  ctx.fillStyle = colors.windows;
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(-width / 2 + 1, -len / 2 + 4 + i * 5, width - 2, 3);
  }
  
  // Front window
  ctx.fillRect(-width / 2 + 1, -len / 2 + 1, width - 2, 2);
  
  // Taillights (Intense Red Trails)
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ff2222';
  ctx.fillRect(-width/2 + 1, len/2 - 2, 2, 3);
  ctx.fillRect(width/2 - 3, len/2 - 2, 2, 3);
  
  // If at stop, show indicator
  if (isAtStop) {
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(0, -len / 2 - 5, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  
  ctx.shadowBlur = 0;
  ctx.restore();
}

// Draw a pedestrian
function drawPedestrian(ctx, pos, wobblePhase, color, size) {
  ctx.save();
  
  // Walking wobble animation
  const wobbleX = Math.sin(wobblePhase) * 1.5;
  const wobbleY = Math.abs(Math.sin(wobblePhase * 2)) * 0.5;
  
  ctx.translate(pos.x + wobbleX, pos.y - wobbleY);
  
  // Glow effect
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  
  // Head
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, -size * 0.3, size * 0.4, 0, Math.PI * 2);
  ctx.fill();
  
  // Body
  ctx.beginPath();
  ctx.arc(0, size * 0.2, size * 0.5, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.shadowBlur = 0;
  ctx.restore();
}

// Draw a taxi - with volumetric headlights
function drawTaxi(ctx, pos, angle, colors, isAvailable, direction = 1) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  // Flip 180° when traveling in reverse so headlights face forward
  const rotationOffset = direction < 0 ? Math.PI : 0;
  ctx.rotate(-angle + Math.PI + rotationOffset);
  
  const len = CONFIG.carLength + 2; // Slightly larger than regular cars
  const width = CONFIG.carWidth + 1;
  
  // Volumetric headlight beams
  const beamLen = 50;
  const grad = ctx.createLinearGradient(0, -len/2, 0, -len/2 - beamLen);
  grad.addColorStop(0, 'rgba(255, 255, 220, 0.4)');
  grad.addColorStop(1, 'rgba(255, 255, 220, 0)');
  
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-width/2 + 1, -len/2);
  ctx.lineTo(-width - 2, -len/2 - beamLen);
  ctx.lineTo(width + 2, -len/2 - beamLen);
  ctx.lineTo(width/2 - 1, -len/2);
  ctx.fill();
  
  // Taxi body with glow
  ctx.shadowColor = colors.body;
  ctx.shadowBlur = 18;
  ctx.fillStyle = colors.body;
  ctx.beginPath();
  ctx.roundRect(-width / 2, -len / 2, width, len, 2);
  ctx.fill();
  
  // Taxi roof sign with glow
  const signColor = isAvailable ? '#00ff00' : '#ff0000';
  ctx.fillStyle = signColor;
  ctx.shadowColor = signColor;
  ctx.shadowBlur = 20;
  ctx.fillRect(-2, -len / 4 - 3, 4, 3);
  
  // Taillights (Intense Red Trails)
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#ff2222';
  ctx.fillRect(-width/2 + 1, len/2 - 1, 2, 2);
  ctx.fillRect(width/2 - 3, len/2 - 1, 2, 2);
  
  ctx.shadowBlur = 0;
  ctx.restore();
}

// Draw a bicycle with rider - direction param flips orientation
function drawBicycle(ctx, pos, angle, colors, pedalPhase, direction = 1) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  // Flip 180° when traveling in reverse
  const rotationOffset = direction < 0 ? Math.PI : 0;
  ctx.rotate(-angle + Math.PI + rotationOffset);
  
  const len = CONFIG.bicycleLength;
  const width = CONFIG.bicycleWidth;
  
  // Bicycle frame
  ctx.strokeStyle = colors.frame;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = colors.frame;
  ctx.shadowBlur = 10;
  
  // Frame triangle
  ctx.beginPath();
  ctx.moveTo(0, -len / 2 + 1); // Front
  ctx.lineTo(-1, len / 4); // Bottom bracket
  ctx.lineTo(0, len / 2 - 1); // Rear
  ctx.lineTo(0, -len / 2 + 1);
  ctx.stroke();
  
  // Wheels
  ctx.beginPath();
  ctx.arc(0, -len / 2 + 1, 2, 0, Math.PI * 2); // Front wheel
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, len / 2 - 1, 2, 0, Math.PI * 2); // Rear wheel
  ctx.stroke();
  
  // Rider (bobbing with pedaling motion)
  const bobY = Math.sin(pedalPhase) * 0.5;
  ctx.fillStyle = colors.rider;
  ctx.shadowColor = colors.rider;
  ctx.shadowBlur = 12;
  
  // Rider body
  ctx.beginPath();
  ctx.ellipse(0, -len / 4 + bobY, width / 2, len / 4, 0, 0, Math.PI * 2);
  ctx.fill();
  
  // Rider head
  ctx.beginPath();
  ctx.arc(0, -len / 2 - 1 + bobY, 2, 0, Math.PI * 2);
  ctx.fill();
  
  // Pedaling legs (animated)
  const pedalX = Math.cos(pedalPhase) * 1.5;
  const pedalY = Math.sin(pedalPhase) * 1;
  ctx.strokeStyle = colors.rider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-1, len / 4);
  ctx.lineTo(-1 + pedalX, len / 4 + pedalY + 2);
  ctx.moveTo(-1, len / 4);
  ctx.lineTo(-1 - pedalX, len / 4 - pedalY + 2);
  ctx.stroke();
  
  ctx.shadowBlur = 0;
  ctx.restore();
}

// ALTERNATIVE: Draw vehicles as "Data Comets" - minimal abstract style
// Set CONFIG.useDataComet = true to enable this mode
function drawDataComet(ctx, pos, angle, color, direction = 1) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  const rotationOffset = direction < 0 ? Math.PI : 0;
  ctx.rotate(-angle + Math.PI + rotationOffset);
  
  // Draw the head (Data Packet) - white hot center
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 2, 0, Math.PI * 2);
  ctx.fill();
  
  // Draw the tail (Speed Streak)
  const tailLen = 30;
  const grad = ctx.createLinearGradient(0, 0, 0, tailLen);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-1, 0);
  ctx.lineTo(0, tailLen);
  ctx.lineTo(1, 0);
  ctx.fill();
  
  ctx.shadowBlur = 0;
  ctx.restore();
}

// Check if the map camera has moved (used to invalidate static layer cache)
function hasMapMoved() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const bearing = map.getBearing();
  
  if (!lastMapCenter || 
      Math.abs(center.lng - lastMapCenter.lng) > 0.000001 ||
      Math.abs(center.lat - lastMapCenter.lat) > 0.000001 ||
      Math.abs(zoom - lastMapZoom) > 0.001 ||
      Math.abs(bearing - lastMapBearing) > 0.01) {
    lastMapCenter = { lng: center.lng, lat: center.lat };
    lastMapZoom = zoom;
    lastMapBearing = bearing;
    return true;
  }
  return false;
}

// Render static layers (streetlights + buildings) to offscreen canvas
function renderStaticLayer(width, height) {
  if (!staticLayerCanvas) {
    staticLayerCanvas = document.createElement('canvas');
    staticLayerCtx = staticLayerCanvas.getContext('2d');
  }
  staticLayerCanvas.width = width;
  staticLayerCanvas.height = height;
  staticLayerCtx.clearRect(0, 0, width, height);
  
  staticLayerCtx.globalCompositeOperation = 'lighter';
  drawStreetlights(staticLayerCtx, width, height);
  drawBuildings(staticLayerCtx, width, height);
  
  staticLayerDirty = false;
}

// Main draw function — optimized for lower-end GPUs
function drawStreetLife() {
  const width = streetLifeCanvas.width;
  const height = streetLifeCanvas.height;
  
  // 1. CLEAR CANVAS
  streetLifeCtx.clearRect(0, 0, width, height);
  
  // 2. PREPARE FOR DRAWING
  streetLifeCtx.globalCompositeOperation = 'source-over';
  
  // GET MAP BEARING
  const mapBearing = (map.getBearing() || 0) * (Math.PI / 180);
  
  // --- DRAW STATIC LAYERS (cached offscreen canvas) ---
  // Only re-render streetlights + buildings when the map camera moves
  if (staticLayerDirty || hasMapMoved()) {
    renderStaticLayer(width, height);
  }
  streetLifeCtx.globalCompositeOperation = 'lighter';
  streetLifeCtx.drawImage(staticLayerCanvas, 0, 0);
  
  // --- DRAW VEHICLES ---
  vehicles.forEach(v => {
    const point = getPointAlongPath(v.path, v.progress);
    if (!point) return;
    const pos = projectToStreetLifeCanvas(point.lng, point.lat);
    
    if (!isOnScreen(pos, width, height)) return;
    
    const screenAngle = -point.angle + mapBearing;
    
    if (v.type === 'car') {
      drawFastLight(streetLifeCtx, pos, screenAngle, v.colors.body, 25, 8, v.direction);
    } else if (v.type === 'taxi') {
      drawFastLight(streetLifeCtx, pos, screenAngle, v.colors.body, 25, 8, v.direction);
    } else if (v.type === 'bus') {
      drawFastLight(streetLifeCtx, pos, screenAngle, v.colors.body, 35, 12, v.direction);
    } else if (v.type === 'bicycle') {
      drawFastLight(streetLifeCtx, pos, screenAngle, v.colors.frame, 10, 4, v.direction);
    }
  });
  
  // --- DRAW EMERGENCY VEHICLE (if active) ---
  if (emergencyVehicle) {
    const ePoint = getPointAlongPath(emergencyVehicle.path, emergencyVehicle.progress);
    if (ePoint) {
      const ePos = projectToStreetLifeCanvas(ePoint.lng, ePoint.lat);
      if (isOnScreen(ePos, width, height)) {
        const eAngle = -ePoint.angle + mapBearing;
        drawEmergencyVehicle(streetLifeCtx, ePos, eAngle, emergencyVehicle);
      }
    }
  }
  
  // --- DRAW PEDESTRIANS (batched by color for minimal state changes) ---
  streetLifeCtx.globalCompositeOperation = 'source-over';
  
  // Group pedestrians by color and draw each group in one path
  const pedsByColor = {};
  pedestrians.forEach(p => {
    const point = getPointAlongPath(p.path, p.progress);
    if (!point) return;
    
    const offsetMag = Math.sin(p.wobblePhase) * 1.5;
    const perpAngle = -point.angle + mapBearing + Math.PI / 2;
    const offsetX = Math.cos(perpAngle) * offsetMag;
    const offsetY = Math.sin(perpAngle) * offsetMag;
    
    const pos = projectToStreetLifeCanvas(point.lng, point.lat);
    if (!isOnScreen(pos, width, height)) return;
    
    if (!pedsByColor[p.color]) pedsByColor[p.color] = [];
    pedsByColor[p.color].push(pos.x + offsetX, pos.y + offsetY);
  });
  
  // One beginPath + fill per color group instead of per pedestrian
  const PI2 = Math.PI * 2;
  for (const color in pedsByColor) {
    const coords = pedsByColor[color];
    streetLifeCtx.fillStyle = color;
    streetLifeCtx.beginPath();
    for (let i = 0; i < coords.length; i += 2) {
      streetLifeCtx.moveTo(coords[i] + 1.5, coords[i + 1]);
      streetLifeCtx.arc(coords[i], coords[i + 1], 1.5, 0, PI2);
    }
    streetLifeCtx.fill();
  }
  
  // Reset for next frame
  streetLifeCtx.globalCompositeOperation = 'source-over';
}

// Generate static streetlights along paths (called once on load)
function generateStreetlights() {
  streetlights = [];
  if (streetPaths.length === 0) return;
  
  console.time('Generating Streetlights');
  
  streetPaths.forEach(path => {
    // Only put lights on MAJOR roads (not residential/service/footways)
    const majorRoads = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
    if (!majorRoads.includes(path.type)) return;
    // Skip very short segments
    if (path.totalLength < CONFIG.streetlightSpacing * 2) return;
    
    // Calculate how many lights fit on this path segment
    const numLights = Math.floor(path.totalLength / CONFIG.streetlightSpacing);
    
    // Place them evenly along the path
    for (let i = 1; i <= numLights; i++) {
      const progress = i / (numLights + 1);
      const point = getPointAlongPath(path, progress);
      if (point) {
        streetlights.push({ lng: point.lng, lat: point.lat });
      }
    }
  });
  
  console.timeEnd('Generating Streetlights');
  console.log(`✓ Generated ${streetlights.length} static streetlights`);
}

// Draw static streetlights efficiently
function drawStreetlights(ctx, width, height) {
  const radius = CONFIG.streetlightRadius;
  
  streetlights.forEach(light => {
    const pos = projectToStreetLifeCanvas(light.lng, light.lat);
    
    // Strict bounds check with padding for radius
    if (pos.x < -radius || pos.x > width + radius ||
        pos.y < -radius || pos.y > height + radius) {
      return;
    }
    
    // Create Radial Gradient with gradual spread
    const grad = ctx.createRadialGradient(
      pos.x, pos.y, 0,      // Inner circle (center point)
      pos.x, pos.y, radius  // Outer circle
    );
    grad.addColorStop(0, CONFIG.streetlightColor);   // Warm center
    grad.addColorStop(0.3, 'rgba(255, 210, 150, 0.12)'); // Gradual falloff
    grad.addColorStop(0.7, 'rgba(255, 210, 150, 0.05)'); // Soft spread
    grad.addColorStop(1, 'rgba(0,0,0,0)');           // Fade to nothing
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Load building footprints for ambient glow
function loadBuildingFootprints() {
  fetch('media/building-footprints.geojson')
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(geojson => {
      buildings = [];
      if (!geojson || !geojson.features) return;
      
      geojson.features.forEach(feature => {
        if (feature.geometry.type === 'MultiPolygon') {
          feature.geometry.coordinates.forEach(polygon => {
            // Get outer ring (first element)
            if (polygon[0] && polygon[0].length >= 3) {
              buildings.push({
                coords: polygon[0],
                type: feature.properties?.objekttyp || 'building'
              });
            }
          });
        } else if (feature.geometry.type === 'Polygon') {
          if (feature.geometry.coordinates[0] && feature.geometry.coordinates[0].length >= 3) {
            buildings.push({
              coords: feature.geometry.coordinates[0],
              type: feature.properties?.objekttyp || 'building'
            });
          }
        }
      });
      
      console.log(`✓ Loaded ${buildings.length} building footprints for glow effect`);
      // Invalidate static layer cache so buildings get drawn
      staticLayerDirty = true;
    })
    .catch(err => {
      console.warn('Street Life: Could not load building footprints:', err);
    });
}

// Draw building outlines with dashed warm glow (like lit windows) + random flicker
function drawBuildings(ctx, width, height) {
  if (buildings.length === 0) return;
  
  // Initialize flicker states if needed
  if (buildingFlickerStates.length !== buildings.length) {
    buildingFlickerStates = buildings.map(() => ({ isOff: false, offTimer: 0 }));
  }
  
  // Update flicker states
  buildingFlickerStates.forEach((state, i) => {
    if (state.isOff) {
      state.offTimer--;
      if (state.offTimer <= 0) {
        state.isOff = false;
      }
    } else if (Math.random() < CONFIG.buildingFlickerChance) {
      // Random building turns off briefly
      state.isOff = true;
      state.offTimer = 5 + Math.floor(Math.random() * 20); // Off for 5-25 frames
    }
  });
  
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = CONFIG.buildingGlowWidth;
  ctx.setLineDash([CONFIG.buildingDashLength, CONFIG.buildingGapLength]);
  ctx.lineCap = 'round';
  
  buildings.forEach((building, index) => {
    // Skip if this building is flickered off
    if (buildingFlickerStates[index]?.isOff) return;
    
    // Project all coordinates
    const screenCoords = building.coords.map(coord => 
      projectToStreetLifeCanvas(coord[0], coord[1])
    );
    
    // Quick bounds check - skip if all points off screen
    const anyOnScreen = screenCoords.some(p => 
      p.x >= -50 && p.x <= width + 50 && p.y >= -50 && p.y <= height + 50
    );
    if (!anyOnScreen) return;
    
    // Some buildings are white, others are warm - seeded by index
    const isWhite = ((index * 7) % 5) === 0; // ~20% of buildings are white
    const brightness = 0.15 + (((index * 7) % 13) / 13) * 0.25;
    if (isWhite) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${brightness + 0.1})`; // Pure white, brighter
    } else {
      ctx.strokeStyle = `rgba(255, 220, 150, ${brightness})`; // Warm glow
    }
    ctx.beginPath();
    ctx.moveTo(screenCoords[0].x, screenCoords[0].y);
    for (let i = 1; i < screenCoords.length; i++) {
      ctx.lineTo(screenCoords[i].x, screenCoords[i].y);
    }
    ctx.closePath();
    ctx.stroke();
  });
  
  // Reset line dash
  ctx.setLineDash([]);
  ctx.restore();
}

// GPU-optimized vehicle drawing — NO shadowBlur, fewer gradients
function drawFastLight(ctx, pos, angle, color, length, width, direction = 1) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  
  const finalAngle = direction === 1 ? angle + Math.PI : angle;
  ctx.rotate(finalAngle);
  
  // Headlight Beam (single gradient cone — replaces halo + beam)
  const beamGrad = ctx.createLinearGradient(1, 0, length, 0);
  beamGrad.addColorStop(0, 'rgba(255, 255, 220, 0.5)');
  beamGrad.addColorStop(1, 'rgba(255, 255, 200, 0)');
  ctx.fillStyle = beamGrad;
  ctx.beginPath();
  ctx.moveTo(1, 0);
  ctx.lineTo(length, -width / 2);
  ctx.lineTo(length, width / 2);
  ctx.closePath();
  ctx.fill();
  
  // Body core — colored dot, NO shadowBlur
  const coreSize = Math.max(2.5, width / 3);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, coreSize + 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, coreSize * 0.6, 0, Math.PI * 2);
  ctx.fill();
  
  // Taillight — simple gradient trail, no shadowBlur
  const tailLen = 14;
  const tailGrad = ctx.createLinearGradient(-2, 0, -2 - tailLen, 0);
  tailGrad.addColorStop(0, 'rgba(255, 60, 60, 0.5)');
  tailGrad.addColorStop(1, 'rgba(255, 0, 0, 0)');
  ctx.fillStyle = tailGrad;
  ctx.beginPath();
  ctx.moveTo(-2, -1.5);
  ctx.lineTo(-2 - tailLen, -0.5);
  ctx.lineTo(-2 - tailLen, 0.5);
  ctx.lineTo(-2, 1.5);
  ctx.closePath();
  ctx.fill();
  
  // Taillight core dot
  ctx.fillStyle = '#ff4444';
  ctx.beginPath();
  ctx.arc(-2, 0, 1.2, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.restore();
}

// Helper for bounds checking
function isOnScreen(pos, w, h) {
  return pos.x >= -50 && pos.x <= w + 50 && pos.y >= -50 && pos.y <= h + 50;
}

// Animation loop
function animateStreetLife() {
  if (!isStreetLifeAnimating) return;
  
  updateStreetLifeEntities();
  drawStreetLife();
  
  streetLifeAnimationFrame = requestAnimationFrame(animateStreetLife);
}

// Spawn timer
let spawnTimer = null;

function startSpawning() {
  if (spawnTimer) clearInterval(spawnTimer);
  
  // Initial spawn burst - populate the city immediately
  for (let i = 0; i < 20; i++) spawnCar();
  for (let i = 0; i < 6; i++) spawnTaxi();
  for (let i = 0; i < 5; i++) spawnBus();
  for (let i = 0; i < 12; i++) spawnBicycle();
  for (let i = 0; i < 100; i++) spawnPedestrian();
  
  // Continuous spawning (auto-replenish handles most of it now)
  spawnTimer = setInterval(() => {
    if (!isStreetLifeAnimating) return;
    
    // Top up any that despawned
    if (Math.random() < 0.4) spawnCar();
    if (Math.random() < 0.2) spawnTaxi();
    if (Math.random() < 0.15) spawnBus();
    if (Math.random() < 0.3) spawnBicycle();
    if (Math.random() < 0.5) spawnPedestrian();
  }, CONFIG.spawnInterval);
}

function stopSpawning() {
  if (spawnTimer) {
    clearInterval(spawnTimer);
    spawnTimer = null;
  }
}

// Resize canvas
function resizeStreetLifeCanvas() {
  const s = computeOverlayPixelSize();
  streetLifeCanvas.width = s.w;
  streetLifeCanvas.height = s.h;
  streetLifeCanvas.style.width = s.w + 'px';
  streetLifeCanvas.style.height = s.h + 'px';
}

// Fade in city ambient sound
function fadeInCitySound() {
  // Clear any existing fade
  if (audioFadeInterval) {
    clearInterval(audioFadeInterval);
    audioFadeInterval = null;
  }
  
  // Create audio if it doesn't exist
  if (!cityAmbientAudio) {
    cityAmbientAudio = new Audio('media/sound/city.mp3');
    cityAmbientAudio.loop = true;
    cityAmbientAudio.volume = 0;
  }
  
  // Start playing at volume 0
  cityAmbientAudio.volume = 0;
  cityAmbientAudio.play().catch(err => {
    console.warn('City ambient sound could not play:', err);
  });
  
  // Gradually fade in
  const stepDuration = AUDIO_FADE_DURATION / AUDIO_FADE_STEPS;
  const volumeStep = AUDIO_MAX_VOLUME / AUDIO_FADE_STEPS;
  let currentStep = 0;
  
  audioFadeInterval = setInterval(() => {
    currentStep++;
    if (currentStep >= AUDIO_FADE_STEPS) {
      cityAmbientAudio.volume = AUDIO_MAX_VOLUME;
      clearInterval(audioFadeInterval);
      audioFadeInterval = null;
    } else {
      cityAmbientAudio.volume = Math.min(volumeStep * currentStep, AUDIO_MAX_VOLUME);
    }
  }, stepDuration);
}

// Fade out city ambient sound
function fadeOutCitySound() {
  // Clear any existing fade
  if (audioFadeInterval) {
    clearInterval(audioFadeInterval);
    audioFadeInterval = null;
  }
  
  if (!cityAmbientAudio) return;
  
  const startVolume = cityAmbientAudio.volume;
  if (startVolume === 0) {
    cityAmbientAudio.pause();
    return;
  }
  
  // Gradually fade out
  const stepDuration = AUDIO_FADE_DURATION / AUDIO_FADE_STEPS;
  const volumeStep = startVolume / AUDIO_FADE_STEPS;
  let currentStep = 0;
  
  audioFadeInterval = setInterval(() => {
    currentStep++;
    if (currentStep >= AUDIO_FADE_STEPS) {
      cityAmbientAudio.volume = 0;
      cityAmbientAudio.pause();
      clearInterval(audioFadeInterval);
      audioFadeInterval = null;
    } else {
      cityAmbientAudio.volume = Math.max(startVolume - (volumeStep * currentStep), 0);
    }
  }, stepDuration);
}

// Start animation
function startStreetLifeAnimation() {
  if (isStreetLifeAnimating) return;
  
  loadStreetLifeData().then(() => {
    if (streetPaths.length === 0) {
      console.warn('Street Life: No paths available for animation');
      return;
    }
    
    isStreetLifeAnimating = true;
    streetLifeCanvas.style.display = 'block';
    resizeStreetLifeCanvas();
    
    // Start city ambient sound with fade in
    fadeInCitySound();
    
    // Clear any existing entities
    vehicles = [];
    pedestrians = [];
    emergencyVehicle = null;
    buildingFlickerStates = [];
    
    // Invalidate static layer cache on start
    staticLayerDirty = true;
    
    startSpawning();
    
    // Emergency vehicles disabled - users found them distracting
    // setTimeout(() => {
    //   if (isStreetLifeAnimating) {
    //     spawnEmergencyVehicle();
    //     scheduleEmergencySpawn();
    //   }
    // }, 1000);
    
    animateStreetLife();
    
    // Start Västtrafik live transit overlay
    if (window.trafikAnimation) {
      window.trafikAnimation.start();
    }
    
    console.log('Street Life animation started');
  });
}

// Stop animation
function stopStreetLifeAnimation() {
  isStreetLifeAnimating = false;
  streetLifeCanvas.style.display = 'none';
  stopSpawning();
  
  // Fade out city ambient sound
  fadeOutCitySound();
  
  if (streetLifeAnimationFrame) {
    cancelAnimationFrame(streetLifeAnimationFrame);
    streetLifeAnimationFrame = null;
  }
  
  streetLifeCtx.clearRect(0, 0, streetLifeCanvas.width, streetLifeCanvas.height);
  vehicles = [];
  pedestrians = [];
  emergencyVehicle = null;
  if (emergencySpawnTimer) {
    clearTimeout(emergencySpawnTimer);
    emergencySpawnTimer = null;
  }
  
  // Stop Västtrafik live transit overlay
  if (window.trafikAnimation) {
    window.trafikAnimation.stop();
  }
  
  console.log('Street Life animation stopped');
}

// Check if any visualization is active
function isAnyVisualizationActive() {
  // Check for active/toggled-on/toggled-off buttons
  const activeButtons = [
    'cfd-simulation-btn',
    'stormwater-btn', 
    'sun-study-btn',
    'slideshow-btn',
    'grid-animation-btn',
    'isovist-btn',
    'bird-sounds-btn',
    'fcc-demo-btn'
  ];
  
  for (const id of activeButtons) {
    const btn = document.getElementById(id);
    if (btn && (btn.classList.contains('active') || btn.classList.contains('toggled-on') || btn.classList.contains('toggled-off'))) {
      return true;
    }
  }
  
  // Also check if any visualization canvas is active/visible
  const canvasIds = [
    'cfd-simulation-canvas',
    'stormwater-canvas',
    'slideshow-canvas',
    'grid-animation-canvas',
    'bird-sounds-canvas'
  ];
  
  for (const id of canvasIds) {
    const canvas = document.getElementById(id);
    if (canvas && canvas.classList.contains('active')) {
      return true;
    }
  }
  
  return false;
}

// Auto-manage street life based on other visualizations
function updateStreetLifeVisibility() {
  if (isAnyVisualizationActive()) {
    if (isStreetLifeAnimating) {
      stopStreetLifeAnimation();
    }
  } else {
    if (!isStreetLifeAnimating) {
      startStreetLifeAnimation();
    }
  }
}

// Listen for button clicks to manage visibility - using MutationObserver for reliable detection
function setupVisibilityObserver() {
  const buttons = document.querySelectorAll('.icon-btn');
  
  // Use MutationObserver to watch for class changes on buttons
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        // Delay slightly to let other handlers complete
        setTimeout(updateStreetLifeVisibility, 50);
      }
    });
  });
  
  buttons.forEach(btn => {
    observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
    // Also listen for direct clicks
    btn.addEventListener('click', () => {
      setTimeout(updateStreetLifeVisibility, 100);
    });
  });
  
  // Also watch canvases
  const canvases = document.querySelectorAll('canvas');
  canvases.forEach(canvas => {
    observer.observe(canvas, { attributes: true, attributeFilter: ['class'] });
  });
}

// Initialize on load
function initStreetLife() {
  setupVisibilityObserver();
  
  // Start street life animation after a delay (let map and other things load)
  setTimeout(() => {
    if (!isAnyVisualizationActive()) {
      startStreetLifeAnimation();
    }
  }, 2500);
}

// Wait for DOM and map to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStreetLife);
} else {
  // DOM already loaded, but wait for map
  setTimeout(initStreetLife, 1000);
}

// Handle window resize
window.addEventListener('resize', () => {
  if (isStreetLifeAnimating) {
    resizeStreetLifeCanvas();
    staticLayerDirty = true;
  }
});

// Expose for external control
window.streetLifeAnimation = {
  start: startStreetLifeAnimation,
  stop: stopStreetLifeAnimation,
  isActive: () => isStreetLifeAnimating,
  updateVisibility: updateStreetLifeVisibility
};

console.log('Street Life animation module loaded');

})();
