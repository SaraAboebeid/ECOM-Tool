// MapLibre GL JS implementation for interactive_map
// Native bearing/rotation support and raster basemap switching

// Global function to compute overlay pixel size based on physical dimensions
// Defaults match the controller values
window.computeOverlayPixelSize = function() {
  const SCREEN_WIDTH_CM = 111.93;
  // const SCREEN_HEIGHT_CM = 62.96; // Not used for width-based scaling
  const TABLE_WIDTH_CM = 100;
  const TABLE_HEIGHT_CM = 60;
  
  const pxPerCm = window.innerWidth / SCREEN_WIDTH_CM;
  const w = Math.round(TABLE_WIDTH_CM * pxPerCm);
  const h = Math.round(TABLE_HEIGHT_CM * pxPerCm);
  
  return { w, h };
};

// Handle Start Overlay and Audio Context
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('start-overlay');
  if (overlay) {
    overlay.addEventListener('click', () => {
      // Resume any existing audio contexts or create a dummy one to unlock
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      ctx.resume().then(() => {
        console.log('AudioContext unlocked');
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);
      });
    });
  }
});

// Helper: read DOM elements
const toastContainer = document.getElementById('toast-container');
function showToast(msg, timeout = 3000) {
  if (!toastContainer) return console.log(msg);
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 300); }, timeout);
}

// Default fallback values (used if calibration file fails to load)
let tableCenter = [11.977770568930168, 57.68839377903814]; // [lon, lat]
let initialZoom = 15.806953679037164;
let initialBearing = -92.58546386659737; // degrees

// Try to load calibration synchronously via XMLHttpRequest (for compatibility with other scripts)
try {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'map-calibration.json', false); // synchronous request
  xhr.send(null);
  if (xhr.status === 200) {
    const calibration = JSON.parse(xhr.responseText);
    tableCenter = [calibration.center.lng, calibration.center.lat];
    initialZoom = calibration.zoom;
    initialBearing = calibration.bearing;
    console.log('Loaded map calibration from map-calibration.json');
  }
} catch (e) {
  console.warn('Could not load map-calibration.json, using defaults:', e);
}

// Create the map with loaded (or default) calibration
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: []
  },
  center: tableCenter,
  zoom: initialZoom,
  bearing: initialBearing,
  pitch: 0
});

// Navigation controls hidden - map is calibrated for projection

// Raster basemap sources and layers
// Note: MapLibre doesn't support {s} placeholder - use explicit subdomain URLs
const basemaps = {
  osm: {
    id: 'osm-source',
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
    ],
    tileSize: 256,
    attribution: '&copy; OpenStreetMap contributors'
  },
  cartoPositron: {
    id: 'carto-pos-source',
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
    ],
    tileSize: 256,
    attribution: '&copy; CARTO & OpenStreetMap'
  },
  cartoDark: {
    id: 'carto-dark-source',
    tiles: [
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
    ],
    tileSize: 256,
    attribution: '&copy; CARTO & OpenStreetMap'
  },
  esri: {
    id: 'esri-source',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    attribution: '&copy; Esri'
  },
  opentopo: {
    id: 'opentopo-source',
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'
    ],
    tileSize: 256,
    attribution: '&copy; OpenTopoMap'
  }
};

// When map loads, add raster sources and layers
map.on('load', () => {
  // add each source and a raster layer; only cartoDark will be visible by default
  Object.keys(basemaps).forEach(key => {
    const bm = basemaps[key];
    map.addSource(bm.id, { type: 'raster', tiles: bm.tiles, tileSize: bm.tileSize });
    map.addLayer({
      id: bm.id + '-layer',
      type: 'raster',
      source: bm.id,
      layout: { visibility: key === 'cartoDark' ? 'visible' : 'none' }
    });
  });

  // Add table polygon and markers as a GeoJSON source
  const tableCorners = [
    [11.98451803339398,57.682927961987396],
    [11.983585758783713,57.6941405253463],
    [11.971022042873042,57.693840269664186],
    [11.971958186071914,57.68262783563063]
  ];

  const tableGeo = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...tableCorners, tableCorners[0]]] }, properties: {} },
      // corners as points
      ...tableCorners.map((pt, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: { corner: i+1 } })),
      // center
      { type: 'Feature', geometry: { type: 'Point', coordinates: tableCenter }, properties: { center: true } }
    ]
  };

  map.addSource('table', { type: 'geojson', data: tableGeo });

  // polygon fill and outline
  map.addLayer({ id: 'table-fill', type: 'fill', source: 'table', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' }, paint: { 'fill-color': '#ffb266', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'table-line', type: 'line', source: 'table', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' }, paint: { 'line-color': '#ff7800', 'line-width': 2 } });

  // corner circles (filter points without center property)
  map.addLayer({ id: 'table-corners', type: 'circle', source: 'table', filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'corner']], layout: { visibility: 'none' }, paint: { 'circle-radius': 6, 'circle-color': '#ff7800', 'circle-stroke-color': '#fff', 'circle-stroke-width':1 } });

  // center circle
  map.addLayer({ id: 'table-center', type: 'circle', source: 'table', filter: ['has', 'center'], layout: { visibility: 'none' }, paint: { 'circle-radius': 6, 'circle-color': '#0078d4', 'circle-stroke-color': '#fff', 'circle-stroke-width':1 } });

  // click handlers to show popups for points
  map.on('click', 'table-corners', (e) => {
    const props = e.features && e.features[0] && e.features[0].properties;
    const coords = e.features[0].geometry.coordinates.slice();
    new maplibregl.Popup().setLngLat(coords).setHTML(`Corner ${props.corner}<br/>lon=${coords[0]}<br/>lat=${coords[1]}`).addTo(map);
  });
  map.on('click', 'table-center', (e) => {
    const coords = e.features[0].geometry.coordinates.slice();
    new maplibregl.Popup().setLngLat(coords).setHTML(`Center<br/>lon=${coords[0]}<br/>lat=${coords[1]}`).addTo(map);
  });

  // fit to table bounds initially (optional - commented out since we have calibrated view)
  // try { map.fitBounds([[...tableCorners[0]], [...tableCorners[2]]], { padding: 20 }); } catch(e){}
  
  // Bearing is set via initialBearing in map constructor
  
  // Table markers visibility is now controlled via controller
});

// Simple basemap switcher (call setBasemap('cartoDark') etc.)
function setBasemap(key) {
  Object.keys(basemaps).forEach(k => {
    const layerId = basemaps[k].id + '-layer';
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', k === key ? 'visible' : 'none');
  });
}

// Wire up existing UI controls
const fileInput = document.getElementById('geojson-input');
const loadGeojsonBtn = document.getElementById('load-geojson-btn');

// Trigger file input when icon button is clicked
loadGeojsonBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const geojson = JSON.parse(ev.target.result);
      addUserGeo(geojson);
    } catch (err) { showToast('Invalid JSON file'); }
  };
  reader.readAsText(file);
});

// drag & drop
const mapEl = document.getElementById('map');
['dragenter','dragover'].forEach(evt => mapEl.addEventListener(evt, e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }));
mapEl.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try { addUserGeo(JSON.parse(ev.target.result)); }
    catch (err) { showToast('Invalid GeoJSON dropped.'); }
  };
  reader.readAsText(f);
});

function addUserGeo(geojson) {
  // remove previous user layer(s)
  if (map.getSource('usergeo')) {
    ['user-fill','user-line','user-point'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    map.removeSource('usergeo');
  }
  map.addSource('usergeo', { type: 'geojson', data: geojson });
  // add simple styling - only fill for polygons, no stroke or points
  map.addLayer({ id: 'user-fill', type: 'fill', source: 'usergeo', paint: { 'fill-color':'#3388ff','fill-opacity':0.2 } }, Object.keys(map.getStyle().layers).slice(-1)[0]);
  // No line or point layers for cleaner building visualization
}

// Calibration overlay (DOM rectangle centered on screen)
const tableOverlay = document.getElementById('table-overlay');

// Hide overlay by default
if (tableOverlay) tableOverlay.style.display = 'none';

let centerLocked = false;
let calibrationModeActive = false;

// Function to enable/disable map interactions based on calibration mode
function setCalibrationMode(enabled) {
  calibrationModeActive = enabled;
  if (enabled) {
    // Enable all interactions for calibration
    try { map.dragPan.enable(); } catch(e){}
    try { map.doubleClickZoom.enable(); } catch(e){}
    try { map.scrollZoom.enable(); } catch(e){}
    try { map.boxZoom.enable(); } catch(e){}
    try { map.keyboard.enable(); } catch(e){}
    try { map.touchZoomRotate.enable(); } catch(e){}
    showToast('Calibration mode: Zoom/Pan enabled');
  } else {
    // Disable zoom/pan interactions when not in calibration mode
    map.dragPan.disable();
    map.doubleClickZoom.disable();
    map.scrollZoom.disable();
    map.boxZoom.disable();
    map.keyboard.disable();
    map.touchZoomRotate.disable();
    showToast('Calibration mode off: Zoom/Pan disabled');
  }
}

// Disable zoom/pan by default after map loads
map.on('load', () => {
  // Disable all zoom/pan interactions by default
  map.dragPan.disable();
  map.doubleClickZoom.disable();
  map.scrollZoom.disable();
  map.boxZoom.disable();
  map.keyboard.disable();
  map.touchZoomRotate.disable();
  console.log('Map interactions disabled by default (enable via calibration mode)');
});

function setInteractionLock(locked) {
  centerLocked = locked;
  if (locked) {
    map.dragPan.disable();
    map.doubleClickZoom.disable();
    map.scrollZoom.disable();
    map.boxZoom.disable();
    map.keyboard.disable();
    map.touchZoomRotate.disable();
    // keep center fixed on table center
    map.jumpTo({ center: tableCenter });
    showToast('Center locked');
  } else {
    // Only enable if calibration mode is active
    if (calibrationModeActive) {
      try { map.dragPan.enable(); } catch(e){}
      try { map.doubleClickZoom.enable(); } catch(e){}
      try { map.scrollZoom.enable(); } catch(e){}
      try { map.boxZoom.enable(); } catch(e){}
      try { map.keyboard.enable(); } catch(e){}
      try { map.touchZoomRotate.enable(); } catch(e){}
    }
    showToast('Center unlocked');
  }
}

// if centerLocked, keep map centered when user attempts programmatic moves via buttons
const originalZoomTo = map.zoomTo.bind(map);
map.zoomTo = (z) => {
  if (centerLocked) map.jumpTo({ center: tableCenter, zoom: z });
  else originalZoomTo(z);
};

// fullscreen handling
const fsToggle = document.getElementById('fullscreen-toggle');
function isFullScreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement); }
function updateFsButton() { if (!fsToggle) return; fsToggle.title = isFullScreen() ? 'Exit Fullscreen' : 'Fullscreen'; }
fsToggle && fsToggle.addEventListener('click', () => { if (!isFullScreen()) document.documentElement.requestFullscreen().catch(()=>{}); else document.exitFullscreen().catch(()=>{}); });
['fullscreenchange','webkitfullscreenchange','mozfullscreenchange','MSFullscreenChange'].forEach(ev => document.addEventListener(ev, () => { updateFsButton(); setTimeout(()=>{ map.resize(); if (tableOverlay.style.display !== 'none') showOverlay(); },250); }));
updateFsButton();

// Resize overlay on window resize
window.addEventListener('resize', () => {
  if (tableOverlay && tableOverlay.style.display !== 'none') showOverlay();
});

// Basemap switcher
const basemapKeys = ['cartoDark', 'cartoPositron', 'osm', 'esri', 'opentopo'];
let currentBasemapIndex = 0; // Start with cartoDark

const basemapToggleBtn = document.getElementById('basemap-toggle');
basemapToggleBtn.addEventListener('click', () => {
  currentBasemapIndex = (currentBasemapIndex + 1) % basemapKeys.length;
  const newBasemap = basemapKeys[currentBasemapIndex];
  setBasemap(newBasemap);
  showToast(`Basemap: ${newBasemap}`);
});

// expose setBasemap for debugging
window.setBasemap = setBasemap;
window.map = map;

// Laser pointer cursor tracking
const laserPointer = document.getElementById('laser-pointer');
document.addEventListener('mousemove', (e) => {
  laserPointer.style.left = e.clientX + 'px';
  laserPointer.style.top = e.clientY + 'px';
});

// Hide laser pointer when mouse leaves window
document.addEventListener('mouseleave', () => {
  laserPointer.style.display = 'none';
});
document.addEventListener('mouseenter', () => {
  laserPointer.style.display = 'block';
});

// end of MapLibre main.js

// --- Controller / Second Screen Logic ---

// Debug mode for controller messages - set to false in production
const CONTROLLER_DEBUG = false;

const controllerChannel = new BroadcastChannel('map_controller_channel');

controllerChannel.onmessage = (event) => {
    const data = event.data;
    if (CONTROLLER_DEBUG) console.log('Main window received:', data);

    if (data.type === 'control_action') {
        const targetId = data.target;
        const btn = document.getElementById(targetId);
        
        // Handle calibration mode toggle
        if (targetId === 'calibrate-btn') {
            // Toggle calibration mode
            setCalibrationMode(!calibrationModeActive);
        }
        
        if (btn) {
            // Simulate click or trigger the function directly
            // Using click() is easiest as it triggers existing event listeners
            btn.click();
            
            // Show toast to confirm action from controller
            showToast(`Remote command: ${targetId}`);
        }
    } else if (data.type === 'reset_view') {
        map.flyTo({
            center: tableCenter,
            zoom: initialZoom,
            bearing: initialBearing,
            pitch: 0
        });
        // Also restart street life animation when resetting to default view
        if (window.streetLifeAnimation) {
            setTimeout(() => {
                window.streetLifeAnimation.updateVisibility();
            }, 500);
        }
    } else if (data.type === 'calibrate_action') {
        const action = data.action;
        
        if (action === 'show_overlay') {
            const { sw, sh, tw, th } = data.params;
            const px = window.innerWidth / parseFloat(sw);
            const w = Math.round(parseFloat(tw) * px);
            const h = Math.round(parseFloat(th) * px);
            
            const tableOverlay = document.getElementById('table-overlay');
            if (tableOverlay) {
                tableOverlay.style.width = w + 'px';
                tableOverlay.style.height = h + 'px';
                tableOverlay.style.display = 'block';
            }
            
        } else if (action === 'hide_overlay') {
            const tableOverlay = document.getElementById('table-overlay');
            if (tableOverlay) tableOverlay.style.display = 'none';
            
        } else if (action === 'copy_calibration') {
            const center = map.getCenter();
            const zoom = map.getZoom();
            const bearing = map.getBearing();
            
            const calibration = {
                center: { lng: center.lng, lat: center.lat },
                zoom: zoom,
                bearing: bearing
            };
            
            const calibrationText = `Map Calibration:
Center: [${center.lng.toFixed(8)}, ${center.lat.toFixed(8)}]
Zoom: ${zoom.toFixed(4)}
Bearing: ${bearing.toFixed(4)}°

JSON:
${JSON.stringify(calibration, null, 2)}`;

            // Send back to controller
            controllerChannel.postMessage({
                type: 'calibration_data',
                text: calibrationText
            });
            
        } else if (action === 'zoom_in') {
            map.zoomTo(Math.min(map.getZoom()+0.1, 22));
        } else if (action === 'zoom_out') {
            map.zoomTo(Math.max(map.getZoom()-0.1, 0));
        } else if (action === 'rotate_left') {
            map.rotateTo((map.getBearing() - 0.1) % 360);
        } else if (action === 'rotate_right') {
            map.rotateTo((map.getBearing() + 0.1) % 360);
        } else if (action === 'reset_rotation') {
            map.rotateTo(0);
        } else if (action === 'lock_center') {
            setInteractionLock(data.value);
        } else if (action === 'toggle_table_markers') {
            const visibility = data.value ? 'visible' : 'none';
            ['table-fill', 'table-line', 'table-corners', 'table-center'].forEach(layerId => {
                if (map.getLayer(layerId)) {
                    map.setLayoutProperty(layerId, 'visibility', visibility);
                }
            });
        } else if (action === 'show_calibration_markers') {
            // Show bright calibration markers at table corners for camera detection
            showCalibrationMarkers(data.params || {});
        } else if (action === 'hide_calibration_markers') {
            hideCalibrationMarkers();
        } else if (action === 'get_overlay_positions') {
            // Return current calibration marker positions in screen coordinates
            const positions = getCalibrationMarkerPositions();
            controllerChannel.postMessage({
                type: 'calibration_overlay_positions',
                positions: positions
            });
        } else if (action === 'show_calibration_tile') {
            // Show a single calibration tile (20x20cm) in top-left for camera detection
            showCalibrationTile(data.params || {});
        } else if (action === 'hide_calibration_tile') {
            hideCalibrationTile();
        } else if (action === 'get_tile_position') {
            // Return expected tile position in screen coordinates
            const tile = getCalibrationTilePosition();
            controllerChannel.postMessage({
                type: 'calibration_tile_position',
                tile: tile
            });
        } else if (action === 'apply_calibration') {
            // Apply new calibration values from auto-calibrator
            const cal = data.calibration;
            if (cal) {
                map.jumpTo({
                    zoom: cal.zoom,
                    bearing: cal.bearing,
                    center: cal.center ? [cal.center.lng, cal.center.lat] : undefined
                });
                showToast(`Calibration updated: zoom=${cal.zoom.toFixed(3)}, bearing=${cal.bearing.toFixed(2)}°`);
            }
        } else if (action === 'show_white_screen') {
            // Project white screen to illuminate markers during calibration
            showWhiteScreen();
        } else if (action === 'hide_white_screen') {
            hideWhiteScreen();
        }
    }
};

// ===========================================
// White Screen for Calibration
// ===========================================

let whiteScreenOverlay = null;

function showWhiteScreen() {
    hideWhiteScreen();
    
    whiteScreenOverlay = document.createElement('div');
    whiteScreenOverlay.id = 'white-screen-overlay';
    whiteScreenOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: white;
        z-index: 10000;
    `;
    document.body.appendChild(whiteScreenOverlay);
}

function hideWhiteScreen() {
    if (whiteScreenOverlay) {
        whiteScreenOverlay.remove();
        whiteScreenOverlay = null;
    }
}

// ===========================================
// Calibration Markers for Auto-Calibration
// ===========================================

let calibrationMarkersContainer = null;

function showCalibrationMarkers(params = {}) {
    // Remove existing markers
    hideCalibrationMarkers();
    
    // Get table overlay dimensions
    const { sw = 111.93, sh = 62.96, tw = 100, th = 60 } = params;
    const px = window.innerWidth / parseFloat(sw);
    const tableW = Math.round(parseFloat(tw) * px);
    const tableH = Math.round(parseFloat(th) * px);
    
    // Calculate table overlay position (centered on screen)
    const offsetX = (window.innerWidth - tableW) / 2;
    const offsetY = (window.innerHeight - tableH) / 2;
    
    // Create markers container
    calibrationMarkersContainer = document.createElement('div');
    calibrationMarkersContainer.id = 'calibration-markers';
    calibrationMarkersContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 9000;
    `;
    
    // Marker positions relative to table (corners with margin)
    const markerPositions = [
        { id: 0, x: 0.08, y: 0.08 },   // Top-left
        { id: 1, x: 0.92, y: 0.08 },   // Top-right
        { id: 2, x: 0.92, y: 0.92 },   // Bottom-right
        { id: 3, x: 0.08, y: 0.92 }    // Bottom-left
    ];
    
    const markerColors = ['#ff0000', '#00ff00', '#0088ff', '#ffff00'];
    const markerSize = 60;
    
    markerPositions.forEach((pos, i) => {
        const marker = document.createElement('div');
        marker.className = 'calibration-marker';
        marker.dataset.markerId = pos.id;
        
        const x = offsetX + tableW * pos.x - markerSize / 2;
        const y = offsetY + tableH * pos.y - markerSize / 2;
        
        marker.style.cssText = `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            width: ${markerSize}px;
            height: ${markerSize}px;
            background: ${markerColors[i]};
            border: 4px solid white;
            border-radius: 50%;
            box-shadow: 0 0 20px ${markerColors[i]}, 0 0 40px ${markerColors[i]};
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            font-weight: bold;
            color: white;
            text-shadow: 0 0 5px black;
        `;
        marker.textContent = pos.id;
        
        calibrationMarkersContainer.appendChild(marker);
    });
    
    // Add center crosshair
    const crosshair = document.createElement('div');
    crosshair.style.cssText = `
        position: absolute;
        left: ${window.innerWidth / 2 - 30}px;
        top: ${window.innerHeight / 2 - 30}px;
        width: 60px;
        height: 60px;
        border: 3px solid rgba(255,255,255,0.8);
        border-radius: 50%;
    `;
    
    const crossH = document.createElement('div');
    crossH.style.cssText = `
        position: absolute;
        left: ${window.innerWidth / 2 - 40}px;
        top: ${window.innerHeight / 2}px;
        width: 80px;
        height: 2px;
        background: rgba(255,255,255,0.8);
    `;
    
    const crossV = document.createElement('div');
    crossV.style.cssText = `
        position: absolute;
        left: ${window.innerWidth / 2}px;
        top: ${window.innerHeight / 2 - 40}px;
        width: 2px;
        height: 80px;
        background: rgba(255,255,255,0.8);
    `;
    
    calibrationMarkersContainer.appendChild(crosshair);
    calibrationMarkersContainer.appendChild(crossH);
    calibrationMarkersContainer.appendChild(crossV);
    
    document.body.appendChild(calibrationMarkersContainer);
    showToast('Calibration markers shown');
}

function hideCalibrationMarkers() {
    if (calibrationMarkersContainer) {
        calibrationMarkersContainer.remove();
        calibrationMarkersContainer = null;
    }
}

function getCalibrationMarkerPositions() {
    const positions = {};
    
    if (calibrationMarkersContainer) {
        calibrationMarkersContainer.querySelectorAll('.calibration-marker').forEach(marker => {
            const id = marker.dataset.markerId;
            const rect = marker.getBoundingClientRect();
            positions[id] = {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        });
    }
    
    return positions;
}

// ===========================================
// Single Tile Calibration (20x20cm reference)
// ===========================================

let calibrationTileContainer = null;
let calibrationTileParams = { tileSize: 20, offsetX: 5, offsetY: 5 };

function showCalibrationTile(params = {}) {
    // Remove existing tile
    hideCalibrationTile();
    
    // Store params for position calculation
    calibrationTileParams = {
        tileSize: params.tileSize || 20,
        offsetX: params.offsetX || 5,
        offsetY: params.offsetY || 5,
        sw: params.sw || 111.93,
        sh: params.sh || 62.96,
        tw: params.tw || 100,
        th: params.th || 60
    };
    
    const { tileSize, offsetX, offsetY, sw, tw, th } = calibrationTileParams;
    
    // Calculate pixel dimensions
    const pxPerCm = window.innerWidth / parseFloat(sw);
    const tableW = Math.round(parseFloat(tw) * pxPerCm);
    const tableH = Math.round(parseFloat(th) * pxPerCm);
    const tilePx = Math.round(tileSize * pxPerCm);
    
    // Table overlay position (centered on screen)
    const tableOffsetX = (window.innerWidth - tableW) / 2;
    const tableOffsetY = (window.innerHeight - tableH) / 2;
    
    // Tile position within table
    const tileX = tableOffsetX + offsetX * pxPerCm;
    const tileY = tableOffsetY + offsetY * pxPerCm;
    
    // Create tile container
    calibrationTileContainer = document.createElement('div');
    calibrationTileContainer.id = 'calibration-tile';
    calibrationTileContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 9000;
    `;
    
    // Create the tile (bright white square)
    const tile = document.createElement('div');
    tile.className = 'calibration-tile-marker';
    tile.style.cssText = `
        position: absolute;
        left: ${tileX}px;
        top: ${tileY}px;
        width: ${tilePx}px;
        height: ${tilePx}px;
        background: white;
        border: 4px solid #00ff00;
        box-shadow: 0 0 30px white, 0 0 60px white;
    `;
    
    // Add corner markers for better detection
    const corners = [
        { x: 0, y: 0, color: '#ff0000' },          // TL - red
        { x: tilePx - 10, y: 0, color: '#00ff00' }, // TR - green  
        { x: tilePx - 10, y: tilePx - 10, color: '#0088ff' }, // BR - blue
        { x: 0, y: tilePx - 10, color: '#ffff00' }  // BL - yellow
    ];
    
    corners.forEach(c => {
        const corner = document.createElement('div');
        corner.style.cssText = `
            position: absolute;
            left: ${c.x}px;
            top: ${c.y}px;
            width: 10px;
            height: 10px;
            background: ${c.color};
        `;
        tile.appendChild(corner);
    });
    
    // Add label
    const label = document.createElement('div');
    label.style.cssText = `
        position: absolute;
        left: ${tileX}px;
        top: ${tileY + tilePx + 10}px;
        color: white;
        font-size: 14px;
        font-weight: bold;
        text-shadow: 0 0 5px black;
    `;
    label.textContent = `Calibration Tile (${tileSize}×${tileSize}cm)`;
    
    calibrationTileContainer.appendChild(tile);
    calibrationTileContainer.appendChild(label);
    document.body.appendChild(calibrationTileContainer);
    
    showToast('Calibration tile shown');
}

function hideCalibrationTile() {
    if (calibrationTileContainer) {
        calibrationTileContainer.remove();
        calibrationTileContainer = null;
    }
}

function getCalibrationTilePosition() {
    const { tileSize, offsetX, offsetY, sw = 111.93, tw = 100, th = 60 } = calibrationTileParams;
    
    // Calculate pixel dimensions (same as showCalibrationTile)
    const pxPerCm = window.innerWidth / parseFloat(sw);
    const tableW = Math.round(parseFloat(tw) * pxPerCm);
    const tableH = Math.round(parseFloat(th) * pxPerCm);
    const tilePx = Math.round(tileSize * pxPerCm);
    
    // Table overlay position
    const tableOffsetX = (window.innerWidth - tableW) / 2;
    const tableOffsetY = (window.innerHeight - tableH) / 2;
    
    // Tile position
    const tileX = tableOffsetX + offsetX * pxPerCm;
    const tileY = tableOffsetY + offsetY * pxPerCm;
    
    // Return corners and center
    return {
        corners: [
            { x: tileX, y: tileY },                      // TL
            { x: tileX + tilePx, y: tileY },             // TR
            { x: tileX + tilePx, y: tileY + tilePx },    // BR
            { x: tileX, y: tileY + tilePx }              // BL
        ],
        center: {
            x: tileX + tilePx / 2,
            y: tileY + tilePx / 2
        },
        width: tilePx,
        height: tilePx
    };
}

// Broadcast state changes to controller
function broadcastState(activeLayerId) {
    controllerChannel.postMessage({
        type: 'state_update',
        activeLayer: activeLayerId
    });
}

// Hook into existing buttons to broadcast state
['cfd-simulation-btn', 'stormwater-btn', 'sun-study-btn', 'slideshow-btn', 'grid-animation-btn', 'isovist-btn', 'bird-sounds-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
        btn.addEventListener('click', () => {
            broadcastState(id);
        });
    }
});


