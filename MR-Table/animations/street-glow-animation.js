// ===== Street Network Glow Animation =====
// Animated glowing paths along street network GeoJSON

const streetCanvas = document.createElement('canvas');
streetCanvas.id = 'street-animation-canvas';
streetCanvas.style.cssText = `
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 850;
  pointer-events: none;
  display: none;
`;
document.body.appendChild(streetCanvas);

const streetCtx = streetCanvas.getContext('2d');
let streetAnimationFrame = null;
let isStreetAnimating = false;
let streetSegments = [];
let flowParticles = [];
let streetGeoJSON = null;
let streetDataLoading = false;
let streetDataLoaded = false;
let animationStartTime = 0;

// Color palette for different street types (more vibrant!)
const streetColors = {
  'motorway': 'rgba(255, 50, 50, ',
  'trunk': 'rgba(255, 120, 50, ',
  'primary': 'rgba(255, 200, 50, ',
  'secondary': 'rgba(50, 255, 150, ',
  'tertiary': 'rgba(50, 180, 255, ',
  'unclassified': 'rgba(180, 150, 255, ',
  'residential': 'rgba(50, 255, 100, ',
  'living_street': 'rgba(200, 255, 50, ',
  'service': 'rgba(220, 220, 220, ',
  'pedestrian': 'rgba(255, 100, 255, ',
  'footway': 'rgba(255, 80, 255, ',
  'cycleway': 'rgba(100, 255, 255, ',
  'path': 'rgba(150, 255, 150, ',
  'track': 'rgba(200, 200, 120, ',
  'default': 'rgba(180, 180, 180, '
};

let streetTypes = [];
let visibleStreetTypes = [];
let typeRevealProgress = 0;

// Group segments by type for efficient rendering
let segmentsByType = {};

// Load default street network on page load
streetDataLoading = true;
fetch('media/street-network.geojson')
  .then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then(geojson => {
    streetGeoJSON = geojson;
    parseStreetGeoJSON(geojson);
    streetDataLoaded = true;
    streetDataLoading = false;
    console.log(`✓ Loaded ${streetSegments.length} street segments from media/street-network.geojson`);
  })
  .catch(err => {
    streetDataLoading = false;
    console.warn('Could not load media/street-network.geojson:', err);
    console.log('Street animation will require manually loaded GeoJSON');
  });

// Convert lat/lng to canvas pixel coordinates
function projectToCanvas(lng, lat, canvasWidth, canvasHeight) {
  // Project using MapLibre's built-in projection to screen coordinates
  const point = map.project([lng, lat]);
  
  // Get the map container position
  const mapContainer = document.getElementById('map');
  const mapRect = mapContainer.getBoundingClientRect();
  
  // Get canvas position (centered on screen)
  const canvasRect = streetCanvas.getBoundingClientRect();
  
  // Convert from map coordinates to canvas coordinates
  // Account for canvas being centered and potentially offset from map
  const offsetX = canvasRect.left - mapRect.left;
  const offsetY = canvasRect.top - mapRect.top;
  
  return {
    x: point.x - offsetX,
    y: point.y - offsetY
  };
}

// Parse GeoJSON and extract line segments with type info
function parseStreetGeoJSON(geojson) {
  streetSegments = [];
  segmentsByType = {};
  const typeSet = new Set();
  
  if (!geojson || !geojson.features) return;
  
  geojson.features.forEach(feature => {
    const highway = feature.properties?.highway || 'default';
    typeSet.add(highway);
    
    if (!segmentsByType[highway]) {
      segmentsByType[highway] = [];
    }
    
    if (feature.geometry.type === 'LineString') {
      const coords = feature.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const segment = {
          start: { lng: coords[i][0], lat: coords[i][1] },
          end: { lng: coords[i + 1][0], lat: coords[i + 1][1] },
          type: highway
        };
        streetSegments.push(segment);
        segmentsByType[highway].push(segment);
      }
    } else if (feature.geometry.type === 'MultiLineString') {
      feature.geometry.coordinates.forEach(line => {
        for (let i = 0; i < line.length - 1; i++) {
          const segment = {
            start: { lng: line[i][0], lat: line[i][1] },
            end: { lng: line[i + 1][0], lat: line[i + 1][1] },
            type: highway
          };
          streetSegments.push(segment);
          segmentsByType[highway].push(segment);
        }
      });
    }
  });
  
  streetTypes = Array.from(typeSet);
  console.log(`Parsed ${streetSegments.length} street segments with ${streetTypes.length} types:`, streetTypes);
  console.log('Segments by type:', Object.keys(segmentsByType).map(k => `${k}: ${segmentsByType[k].length}`).join(', '));
}

// Create flowing particles along streets
function initializeParticles() {
  flowParticles = [];
  
  // Reduce particles for large networks
  const totalParticles = Math.min(streetSegments.length * 0.3, 500); // Max 500 particles
  const segmentsPerParticle = Math.max(1, Math.floor(streetSegments.length / totalParticles));
  
  for (let i = 0; i < streetSegments.length; i += segmentsPerParticle) {
    flowParticles.push({
      segmentIdx: i,
      progress: Math.random(), // 0 to 1 along segment
      speed: 0.003 + Math.random() * 0.005,
      phase: Math.random() * Math.PI * 2,
      size: 2 + Math.random() * 2
    });
  }
  
  console.log(`Created ${flowParticles.length} particles for ${streetSegments.length} segments`);
}

function resizeStreetCanvas() {
  const s = computeOverlayPixelSize();
  streetCanvas.width = s.w;
  streetCanvas.height = s.h;
  streetCanvas.style.width = s.w + 'px';
  streetCanvas.style.height = s.h + 'px';
}

function drawStreetGlow(time) {
  const width = streetCanvas.width;
  const height = streetCanvas.height;
  
  // Clear canvas
  streetCtx.clearRect(0, 0, width, height);
  
  // Calculate time relative to animation start
  const elapsed = time - animationStartTime;
  
  const baseGlow = 0.5 + Math.sin(elapsed * 0.001) * 0.25;
  
  // Incrementally reveal street types (one every 0.5 seconds)
  const targetTypes = Math.min(streetTypes.length, Math.floor(elapsed / 500) + 1);
  visibleStreetTypes = streetTypes.slice(0, targetTypes);
  
  // Draw each visible type in batches (much more efficient)
  visibleStreetTypes.forEach((type, typeIndex) => {
    const segments = segmentsByType[type] || [];
    if (segments.length === 0) return;
    
    // Type reveal fade-in effect
    const revealProgress = Math.min(1, (elapsed / 500) - typeIndex);
    const fadeIn = Math.max(0, Math.min(1, revealProgress));
    
    if (fadeIn <= 0) return;
    
    // Get color for this street type
    const colorBase = streetColors[type] || streetColors['default'];
    
    // Reduced sampling: draw more segments for continuous roads
    const maxSegments = 1500; // Reduced for low-end GPU performance
    const sampleRate = Math.max(1, Math.ceil(segments.length / maxSegments));
    
    // Set styles once per type (not per segment!)
    const pulse = Math.sin(elapsed * 0.003 + typeIndex) * 0.4 + 0.6;
    streetCtx.strokeStyle = colorBase + (baseGlow * pulse * 0.8 * fadeIn) + ')';
    streetCtx.lineWidth = 2.5;
    streetCtx.shadowBlur = 12;
    streetCtx.shadowColor = colorBase + (pulse * 0.9 * fadeIn) + ')';
    streetCtx.lineCap = 'round';
    
    // Begin a single path for all segments of this type
    streetCtx.beginPath();
    
    for (let i = 0; i < segments.length; i += sampleRate) {
      const segment = segments[i];
      const start = projectToCanvas(segment.start.lng, segment.start.lat, width, height);
      const end = projectToCanvas(segment.end.lng, segment.end.lat, width, height);
      
      streetCtx.moveTo(start.x, start.y);
      streetCtx.lineTo(end.x, end.y);
    }
    
    // Draw all segments of this type at once
    streetCtx.stroke();
  });
  
  streetCtx.shadowBlur = 0;
  
  // Draw legend showing current types
  streetCtx.font = '12px system-ui';
  streetCtx.textAlign = 'left';
  let yOffset = 20;
  visibleStreetTypes.forEach(type => {
    const colorBase = streetColors[type] || streetColors['default'];
    streetCtx.fillStyle = colorBase + '0.8)';
    streetCtx.fillRect(10, yOffset - 8, 30, 3);
    streetCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    streetCtx.fillText(type, 45, yOffset);
    yOffset += 18;
  });
}

function animateStreets() {
  if (!isStreetAnimating) return;
  
  const time = performance.now();
  drawStreetGlow(time);
  
  streetAnimationFrame = requestAnimationFrame(animateStreets);
}

function startStreetAnimation() {
  // Check if data is still loading
  if (streetDataLoading) {
    alert('Street network is still loading, please wait a moment...');
    return;
  }
  
  // Check if we have street network data (either loaded from default or map source)
  if (streetSegments.length === 0) {
    // Try to get from map source if available
    if (map.getSource('user-geojson')) {
      const source = map.getSource('user-geojson');
      if (source && source._data) {
        parseStreetGeoJSON(source._data);
      }
    }
    
    if (streetSegments.length === 0) {
      alert('No street network data found!\n\n' +
            '1. Make sure media/street-network.geojson exists, or\n' +
            '2. Load a GeoJSON file with street LineStrings using the upload button');
      return;
    }
  }
  
  // If already animating, stop and restart
  if (isStreetAnimating) {
    stopStreetAnimation();
  }
  
  // Reset reveal progress and start time
  visibleStreetTypes = [];
  typeRevealProgress = 0;
  animationStartTime = performance.now();
  
  isStreetAnimating = true;
  streetCanvas.style.display = 'block';
  resizeStreetCanvas();
  animateStreets();
  
  // Auto-stop after all types revealed + 5 seconds
  const revealDuration = streetTypes.length * 500 + 5000;
  setTimeout(() => {
    if (isStreetAnimating) stopStreetAnimation();
  }, revealDuration);
}

function stopStreetAnimation() {
  isStreetAnimating = false;
  streetCanvas.style.display = 'none';
  if (streetAnimationFrame) {
    cancelAnimationFrame(streetAnimationFrame);
    streetAnimationFrame = null;
  }
  streetCtx.clearRect(0, 0, streetCanvas.width, streetCanvas.height);
  flowParticles = [];
}

// Button removed as per request


// Resize on window resize
window.addEventListener('resize', () => {
  if (isStreetAnimating) resizeStreetCanvas();
});
