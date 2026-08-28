// Google Street View Integration
// Map interaction module - sends click positions to controller
// Version: 3.2 - Shows actual camera position from Street View metadata

// Street View + SAM Segmentation Integration
(function() {
  const channel = new BroadcastChannel('map_controller_channel');
  
  // State
  let streetViewActive = false;
  let buttonInitialized = false;
  let viewerPosition = null;
  let cursorPosition = null;
  let actualCameraPosition = null; // The real Street View camera location
  let apiKey = null;
  
  // Follow cursor settings (matching isovist behavior)
  let FOLLOW_CURSOR = true;
  const FOLLOW_THRESHOLD = 30; // meters before viewer starts following
  const FOLLOW_SPEED = 0.15; // how fast viewer follows (0-1)
  
  // Broadcast throttling
  let lastBroadcastPosition = null;
  let lastBroadcastHeading = null;
  let lastMetadataFetch = null;
  const BROADCAST_MIN_DISTANCE = 3; // meters
  const BROADCAST_MIN_HEADING_CHANGE = 15; // degrees
  const METADATA_FETCH_DISTANCE = 5; // meters - fetch new metadata if moved this far
  
  // Direction line settings
  const DIRECTION_LINE_LENGTH = 50; // meters
  
  // Camera position history for fading trail
  const cameraHistory = [];
  const MAX_HISTORY = 10; // Number of past positions to show
  
  console.log('Street View module loaded (v3.4 - with SAM segmentation)');

  // --- SAM Segmentation Integration ---
  const SAM_SERVER_URL = 'http://localhost:8000';
  let samServerAvailable = false;

  // Check if the SAM server is running
  async function checkSamServer() {
    try {
      const resp = await fetch(SAM_SERVER_URL + '/');
      if (resp.ok) {
        samServerAvailable = true;
        setSamStatus('Ready', true);
      } else {
        samServerAvailable = false;
        setSamStatus('Unavailable', false);
      }
    } catch (e) {
      samServerAvailable = false;
      setSamStatus('Unavailable', false);
    }
  }

  function setSamStatus(msg, ok) {
    const el = document.getElementById('sam-server-status');
    if (el) {
      el.textContent = 'SAM Server: ' + msg;
      el.style.color = ok ? '#22c55e' : '#ef4444';
    }
  }

  // Handle segmentation button click
  function initSamSegmentation() {
    const btn = document.getElementById('sam-segment-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      await checkSamServer();
      if (!samServerAvailable) {
        showToast('SAM server not available');
        return;
      }
      // Get the current Street View image element
      const img = document.getElementById('street-view-image');
      if (!img || !img.src || img.style.display === 'none') {
        showToast('No Street View image to segment');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Segmenting...';
      setSamStatus('Processing...', true);
      try {
        // Fetch the image as a blob
        const imageBlob = await fetch(img.src).then(r => r.blob());
        const formData = new FormData();
        formData.append('file', imageBlob, 'streetview.jpg');
        // Optionally add confidence/lite params
        // formData.append('confidence', '0.3');
        // formData.append('lite', 'true');
        const resp = await fetch(SAM_SERVER_URL + '/segment', {
          method: 'POST',
          body: formData
        });
        if (!resp.ok) throw new Error('Segmentation failed');

        const contentType = (resp.headers.get('content-type') || '').toLowerCase();
        let segData = null;
        if (contentType.includes('application/json')) {
          const body = await resp.json();
          segData = body.results || body;
          if (body.mask) {
            const maskContainer = document.getElementById('sam-mask-container');
            if (maskContainer) {
              maskContainer.innerHTML = `<img src="${body.mask}" style="max-width:100%; border-radius:8px; border:2px solid #444; margin-bottom:0.5rem;" alt="Segmentation Mask" />`;
            }
          }
        } else {
          // Older behavior: image blob + X-Segmentation-JSON header
          const maskBlob = await resp.blob();
          const segJson = resp.headers.get('X-Segmentation-JSON');

          let finalMaskBlob = maskBlob;
          if (segJson) {
            try {
              const data = JSON.parse(segJson);
              const candidates = [];
              if (data.mask_url) candidates.push(data.mask_url);
              if (data.mask) candidates.push(data.mask);
              if (data.mask_filename) candidates.push(data.mask_filename);
              if (data.files && typeof data.files === 'object') Object.values(data.files).forEach(v => candidates.push(v));
              if (data.output_files && typeof data.output_files === 'object') Object.values(data.output_files).forEach(v => candidates.push(v));

              let chosen = null;
              for (const c of candidates) {
                if (!c) continue;
                const s = String(c);
                if (/mask/i.test(s) || /_mask\./i.test(s)) { chosen = s; break; }
                if (/^https?:\/\/.+\.(png|jpg|jpeg|webp)$/i.test(s)) { chosen = s; break; }
              }

              if (chosen) {
                const candidateUrl = (/^https?:\/\//i.test(chosen)) ? chosen : (SAM_SERVER_URL + '/' + chosen.replace(/^\//, ''));
                try {
                  const r2 = await fetch(candidateUrl);
                  if (r2.ok) {
                    const b2 = await r2.blob();
                    const ct = r2.headers.get('content-type') || '';
                    if (ct.startsWith('image/') || b2.size > 0) finalMaskBlob = b2;
                  }
                } catch (e) {
                  // ignore
                }
              }
              segData = data;
            } catch (e) {
              // ignore
            }
          }

          const maskUrl = URL.createObjectURL(finalMaskBlob);
          const maskContainer = document.getElementById('sam-mask-container');
          if (maskContainer) {
            maskContainer.innerHTML = `<img src="${maskUrl}" style="max-width:100%; border-radius:8px; border:2px solid #444; margin-bottom:0.5rem;" alt="Segmentation Mask" />`;
          }
        }
        // Show class breakdown
        if (segJson) {
          const data = JSON.parse(segJson);
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
          Object.entries(cats).sort((a,b)=>b[1].pixel_ratio_percent-a[1].pixel_ratio_percent).forEach(([cat, val]) => {
            const color = palette[cat] || '#777';
            table += `<tr><td style="padding:6px 4px; display:flex; align-items:center; gap:8px;"><span style="width:12px; height:12px; background:${color}; display:inline-block; border-radius:2px;"></span><span>${cat}</span></td></tr>`;
          });
          table += '</table>';
          const classTable = document.getElementById('sam-class-table');
          if (classTable) classTable.innerHTML = table;
        }
        setSamStatus('Done', true);
      } catch (err) {
        setSamStatus('Error', false);
        showToast('Segmentation failed: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Segment Street View';
      }
    });
    // Initial status check
    checkSamServer();
  }

  // Wait for DOM and initialize SAM integration
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSamSegmentation);
  } else {
    initSamSegmentation();
  }
  
  // Load API key from config (try multiple paths)
  async function loadApiKey() {
    const paths = ['trafik-config.json', './trafik-config.json', '../trafik-config.json'];
    for (const path of paths) {
      try {
        const response = await fetch(path);
        if (response.ok) {
          const config = await response.json();
          // Try both possible key names
          const key = config.streetViewApiKey || config.googleMapsApiKey;
          if (key) {
            apiKey = key;
            console.log('Street View API key loaded from', path);
            return;
          }
        }
      } catch (e) {
        // Try next path
      }
    }
    console.warn('Could not load API key from any path');
  }
  loadApiKey();
  
  // Listen for control messages from controller
  channel.onmessage = (event) => {
    const data = event.data;
    
    if (data.type === 'street_view_control') {
      switch (data.action) {
        case 'activate':
          activateStreetView();
          break;
        case 'deactivate':
          deactivateStreetView();
          break;
        case 'toggle_follow':
          FOLLOW_CURSOR = !FOLLOW_CURSOR;
          showToast(FOLLOW_CURSOR ? 'Follow cursor enabled' : 'Follow cursor disabled');
          break;
      }
    }
  };
  
  // Activate Street View mode - enable map clicks and follow
  function activateStreetView() {
    if (streetViewActive) return;
    streetViewActive = true;
    
    console.log('Street View activating...');
    
    // Hide street life animation canvas
    const streetLifeCanvas = document.getElementById('street-life-canvas');
    if (streetLifeCanvas) {
      streetLifeCanvas.style.display = 'none';
    }
    
    // Hide trafik (tram/bus) canvas
    const trafikCanvas = document.getElementById('trafik-canvas');
    if (trafikCanvas) {
      trafikCanvas.style.display = 'none';
    }
    
    // Broadcast state
    channel.postMessage({ 
      type: 'animation_state', 
      animationId: 'street-view-btn', 
      isActive: true 
    });
    
    // Add map layers for visualization
    addMapLayers();
    
    // Add map event listeners
    if (window.map) {
      console.log('Adding map listeners');
      window.map.on('click', onMapClick);
      window.map.on('mousemove', onMapMouseMove);
      window.map.getCanvas().style.cursor = 'crosshair';
    } else {
      console.warn('Map not available');
    }
    
    showToast('Street View active - click to place viewer, move to look around');
  }
  
  // Deactivate Street View mode
  function deactivateStreetView() {
    if (!streetViewActive) return;
    streetViewActive = false;
    
    console.log('Street View deactivating...');
    
    // Show street life animation canvas again
    const streetLifeCanvas = document.getElementById('street-life-canvas');
    if (streetLifeCanvas) {
      streetLifeCanvas.style.display = 'block';
    }
    
    // Show trafik (tram/bus) canvas again
    const trafikCanvas = document.getElementById('trafik-canvas');
    if (trafikCanvas) {
      trafikCanvas.style.display = 'block';
    }
    
    // Broadcast state
    channel.postMessage({ 
      type: 'animation_state', 
      animationId: 'street-view-btn', 
      isActive: false 
    });
    
    // Remove map event listeners
    if (window.map) {
      window.map.off('click', onMapClick);
      window.map.off('mousemove', onMapMouseMove);
      window.map.getCanvas().style.cursor = '';
    }
    
    // Clear map layers
    clearMapLayers();
    
    // Reset state
    viewerPosition = null;
    cursorPosition = null;
    actualCameraPosition = null;
    lastBroadcastPosition = null;
    lastBroadcastHeading = null;
    lastMetadataFetch = null;
    cameraHistory.length = 0; // Clear history
    
    showToast('Street View deactivated');
  }
  
  // Add map layers for viewer visualization
  function addMapLayers() {
    if (!window.map) return;
    
    // Note: Google Street View coverage overlay requires the full Google Maps JavaScript API
    // which would conflict with MapLibre. The coverage isn't available as public tiles.
    
    // Add source for viewer point and direction (user's requested position)
    if (!window.map.getSource('streetview-viewer')) {
      window.map.addSource('streetview-viewer', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });
      
      // Direction line layer (rendered first, below point)
      window.map.addLayer({
        id: 'streetview-direction',
        type: 'line',
        source: 'streetview-viewer',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': '#00aaff',
          'line-width': 4,
          'line-opacity': 0.9
        },
        layout: {
          'line-cap': 'round'
        }
      });
      
      // Field of view cone (semi-transparent)
      window.map.addLayer({
        id: 'streetview-fov',
        type: 'fill',
        source: 'streetview-viewer',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': '#00aaff',
          'fill-opacity': 0.15
        }
      });
      
      window.map.addLayer({
        id: 'streetview-fov-outline',
        type: 'line',
        source: 'streetview-viewer',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'line-color': '#00aaff',
          'line-width': 2,
          'line-opacity': 0.5,
          'line-dasharray': [2, 2]
        }
      });
      
      // Viewer point outer glow (user's requested position)
      window.map.addLayer({
        id: 'streetview-viewer-glow',
        type: 'circle',
        source: 'streetview-viewer',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'type'], 'camera']],
        paint: {
          'circle-radius': 16,
          'circle-color': '#00aaff',
          'circle-opacity': 0.3,
          'circle-blur': 1
        }
      });
      
      // Viewer point layer (user's requested position - blue)
      window.map.addLayer({
        id: 'streetview-viewer-point',
        type: 'circle',
        source: 'streetview-viewer',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'type']]],
        paint: {
          'circle-radius': 10,
          'circle-color': '#00aaff',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3
        }
      });
      
      // Historical camera positions (fading green trail)
      window.map.addLayer({
        id: 'streetview-camera-history',
        type: 'circle',
        source: 'streetview-viewer',
        filter: ['==', ['get', 'type'], 'camera-history'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#00ff88',
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-stroke-opacity': ['get', 'opacity']
        }
      });
      
      // Actual camera position glow (green - brightest)
      window.map.addLayer({
        id: 'streetview-camera-glow',
        type: 'circle',
        source: 'streetview-viewer',
        filter: ['==', ['get', 'type'], 'camera'],
        paint: {
          'circle-radius': 22,
          'circle-color': '#00ff88',
          'circle-opacity': 0.5,
          'circle-blur': 1
        }
      });
      
      // Actual camera position point (green - brightest, on top)
      window.map.addLayer({
        id: 'streetview-camera-point',
        type: 'circle',
        source: 'streetview-viewer',
        filter: ['==', ['get', 'type'], 'camera'],
        paint: {
          'circle-radius': 14,
          'circle-color': '#00ff88',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 4
        }
      });
      
      console.log('Street View viewer layers added');
    }
  }
  
  // Clear map layers
  function clearMapLayers() {
    if (!window.map) return;
    
    // Clear viewer data
    if (window.map.getSource('streetview-viewer')) {
      window.map.getSource('streetview-viewer').setData({
        type: 'FeatureCollection',
        features: []
      });
    }
  }
  
  // Update map visualization
  function updateMapVisualization() {
    if (!window.map || !viewerPosition) return;
    
    const features = [];
    
    // Add viewer point
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: viewerPosition
      },
      properties: {}
    });
    
    // Add direction line and FOV cone if cursor is set
    if (cursorPosition) {
      const bearing = calculateBearing(viewerPosition, cursorPosition);
      const endPoint = destination(viewerPosition, DIRECTION_LINE_LENGTH, bearing);
      
      // Direction line
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [viewerPosition, endPoint]
        },
        properties: {}
      });
      
      // FOV cone (100° field of view to match Street View)
      const fovAngle = 50; // half of 100°
      const fovDistance = DIRECTION_LINE_LENGTH * 1.5;
      const leftPoint = destination(viewerPosition, fovDistance, (bearing - fovAngle + 360) % 360);
      const rightPoint = destination(viewerPosition, fovDistance, (bearing + fovAngle) % 360);
      
      // Create arc points for smoother cone
      const arcPoints = [viewerPosition];
      const arcSteps = 20;
      for (let i = 0; i <= arcSteps; i++) {
        const angle = bearing - fovAngle + (i / arcSteps) * (fovAngle * 2);
        arcPoints.push(destination(viewerPosition, fovDistance, (angle + 360) % 360));
      }
      arcPoints.push(viewerPosition); // close the polygon
      
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [arcPoints]
        },
        properties: {}
      });
    }
    
    // Add historical camera positions (fading trail)
    cameraHistory.forEach((pos, index) => {
      const opacity = 1 - ((index + 1) / (MAX_HISTORY + 1)); // Fade from ~0.9 to ~0.1
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: pos
        },
        properties: { 
          type: 'camera-history',
          opacity: opacity,
          index: index
        }
      });
    });
    
    // Add actual camera position if available (green marker - brightest)
    if (actualCameraPosition) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: actualCameraPosition
        },
        properties: { type: 'camera' }
      });
    }
    
    // Update source
    if (window.map.getSource('streetview-viewer')) {
      window.map.getSource('streetview-viewer').setData({
        type: 'FeatureCollection',
        features: features
      });
    }
  }
  
  // Fetch Street View metadata to get actual camera position
  async function fetchStreetViewMetadata(position) {
    if (!apiKey) {
      console.warn('No API key for Street View metadata');
      return;
    }
    
    // Throttle metadata fetches
    if (lastMetadataFetch && distance(lastMetadataFetch, position) < METADATA_FETCH_DISTANCE) {
      return;
    }
    lastMetadataFetch = [...position];
    
    const lat = position[1];
    const lng = position[0];
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${apiKey}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.status === 'OK' && data.location) {
        const newCameraPos = [data.location.lng, data.location.lat];
        
        // Add to history if different from last position (avoid duplicates)
        if (!actualCameraPosition || 
            distance(actualCameraPosition, newCameraPos) > 2) {
          // Add previous position to history before updating
          if (actualCameraPosition) {
            cameraHistory.unshift([...actualCameraPosition]);
            // Trim history to max size
            while (cameraHistory.length > MAX_HISTORY) {
              cameraHistory.pop();
            }
          }
        }
        
        actualCameraPosition = newCameraPos;
        console.log('Actual camera at:', actualCameraPosition, 'Date:', data.date);
        
        // Update visualization with camera position
        updateMapVisualization();
      } else {
        actualCameraPosition = null;
        console.log('No Street View coverage at this location');
        updateMapVisualization();
      }
    } catch (err) {
      console.warn('Failed to fetch Street View metadata:', err);
    }
  }
  
  // Handle map clicks - place viewer position
  function onMapClick(e) {
    if (!streetViewActive) return;
    
    viewerPosition = [e.lngLat.lng, e.lngLat.lat];
    cursorPosition = viewerPosition; // Initialize cursor at click point
    console.log('Viewer placed at:', viewerPosition);
    
    // Fetch actual camera position
    fetchStreetViewMetadata(viewerPosition);
    
    // Update map visualization
    updateMapVisualization();
    
    // Immediately broadcast the new position
    broadcastPosition();
    
    showToast('Viewer placed - move cursor to look around');
  }
  
  // Handle mouse move - update heading and follow
  function onMapMouseMove(e) {
    if (!streetViewActive || !viewerPosition) return;
    
    cursorPosition = [e.lngLat.lng, e.lngLat.lat];
    
    // Auto-follow cursor if enabled
    if (FOLLOW_CURSOR) {
      const dist = distance(viewerPosition, cursorPosition);
      
      if (dist > FOLLOW_THRESHOLD) {
        // Move viewer toward cursor
        const newLng = viewerPosition[0] + (cursorPosition[0] - viewerPosition[0]) * FOLLOW_SPEED;
        const newLat = viewerPosition[1] + (cursorPosition[1] - viewerPosition[1]) * FOLLOW_SPEED;
        viewerPosition = [newLng, newLat];
        
        // Fetch metadata for new position (throttled internally)
        fetchStreetViewMetadata(viewerPosition);
      }
    }
    
    // Update map visualization
    updateMapVisualization();
    
    // Broadcast position update (throttled)
    broadcastPosition();
  }
  
  // Broadcast position to controller (throttled)
  function broadcastPosition() {
    if (!viewerPosition) return;
    
    const currentHeading = cursorPosition ? calculateBearing(viewerPosition, cursorPosition) : 0;
    const positionChanged = !lastBroadcastPosition || distance(lastBroadcastPosition, viewerPosition) > BROADCAST_MIN_DISTANCE;
    const headingChanged = lastBroadcastHeading === null || Math.abs(currentHeading - lastBroadcastHeading) > BROADCAST_MIN_HEADING_CHANGE;
    
    if (positionChanged || headingChanged) {
      lastBroadcastPosition = [...viewerPosition];
      lastBroadcastHeading = currentHeading;
      
      channel.postMessage({
        type: 'street_view_position',
        position: {
          lng: viewerPosition[0],
          lat: viewerPosition[1]
        },
        heading: currentHeading
      });
    }
  }
  
  // Calculate bearing between two points
  function calculateBearing(from, to) {
    const dLon = to[0] - from[0];
    const y = Math.sin(dLon * Math.PI / 180) * Math.cos(to[1] * Math.PI / 180);
    const x = Math.cos(from[1] * Math.PI / 180) * Math.sin(to[1] * Math.PI / 180) -
              Math.sin(from[1] * Math.PI / 180) * Math.cos(to[1] * Math.PI / 180) * 
              Math.cos(dLon * Math.PI / 180);
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  }
  
  // Calculate destination point given start, distance (meters), and bearing (degrees)
  function destination(origin, dist, bearing) {
    const R = 6371000; // Earth radius in meters
    const lat1 = origin[1] * Math.PI / 180;
    const lon1 = origin[0] * Math.PI / 180;
    const brng = bearing * Math.PI / 180;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dist / R) +
      Math.cos(lat1) * Math.sin(dist / R) * Math.cos(brng)
    );

    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(dist / R) * Math.cos(lat1),
      Math.cos(dist / R) - Math.sin(lat1) * Math.sin(lat2)
    );

    return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
  }
  
  // Calculate distance between two points in meters
  function distance(point1, point2) {
    const R = 6371000; // Earth radius in meters
    const lat1 = point1[1] * Math.PI / 180;
    const lat2 = point2[1] * Math.PI / 180;
    const dLat = (point2[1] - point1[1]) * Math.PI / 180;
    const dLon = (point2[0] - point1[0]) * Math.PI / 180;

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
  
  // Toast notification helper
  function showToast(message) {
    let toast = document.getElementById('toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast-notification';
      toast.style.cssText = 'position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: rgba(0, 0, 0, 0.85); color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 14px; z-index: 10000; transition: opacity 0.3s ease; pointer-events: none;';
      document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.style.opacity = '1';
    
    setTimeout(() => {
      toast.style.opacity = '0';
    }, 3000);
  }
  
  // Initialize button on main map
  function initStreetViewButton() {
    if (buttonInitialized) return;
    const btn = document.getElementById('street-view-btn');
    if (!btn) {
      console.log('Street View button not found');
      return;
    }
    console.log('Initializing Street View button');
    buttonInitialized = true;
    btn.addEventListener('click', () => {
      console.log('Street View button clicked, active:', streetViewActive);
      if (streetViewActive) {
        deactivateStreetView();
      } else {
        activateStreetView();
      }
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStreetViewButton);
  } else {
    initStreetViewButton();
  }

  // Also try when map is ready
  const checkMap = setInterval(() => {
    if (window.map) {
      clearInterval(checkMap);
      initStreetViewButton();
      console.log('Map ready, Street View initialized');
    }
  }, 100);
  setTimeout(() => clearInterval(checkMap), 10000);

})();
