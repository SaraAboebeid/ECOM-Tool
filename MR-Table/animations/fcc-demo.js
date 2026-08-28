// FCC Demo - Synchronized VR Flythrough with Isovist Visualization
// Plays VR recording video synchronized with isovist movement along recorded path
// Version: 1.0

(function() {
  if (typeof window.map === 'undefined') {
    console.warn('FCC Demo: Map not ready yet, will initialize when available');
  }

  const channel = new BroadcastChannel('map_controller_channel');
  
  let fccDemoActive = false;
  let pathCoordinates = []; // Loaded from VR-movement.geojson
  let totalPathLength = 0; // Total path length in meters
  let segmentLengths = []; // Length of each segment
  let cumulativeLengths = []; // Cumulative distance at each point
  
  // Playback state
  let currentProgress = 0; // 0-1 progress along path
  let isPlaying = false;
  let playbackSpeed = 1.0; // Multiplier for playback speed
  let animationFrameId = null;
  let lastTimestamp = null;
  
  // Video duration sync
  let videoDuration = 20; // Default 20 seconds, updated from video metadata
  
  // Isovist settings (mirrors isovist.js)
  let MAX_VIEW_DISTANCE = 200;
  const RAY_COUNT = 180;
  const DEG2RAD = Math.PI / 180;
  let HUMAN_FOV = 120;
  let USE_HUMAN_FOV = true;
  
  // Obstacle data (loaded from building footprints)
  let obstacles = [];
  let treeObstacles = [];
  let INCLUDE_TREES = true;
  
  // Street View position broadcast throttling
  let lastBroadcastPosition = null;
  let lastBroadcastHeading = null;
  const BROADCAST_MIN_DISTANCE = 2; // meters between broadcasts
  const BROADCAST_MIN_HEADING_CHANGE = 10; // degrees between heading broadcasts
  
  // Listen for control messages from controller
  channel.onmessage = (event) => {
    const data = event.data;
    if (data.type === 'fcc_demo_control') {
      switch (data.action) {
        case 'play':
          startPlayback();
          break;
        case 'pause':
          pausePlayback();
          break;
        case 'seek':
          seekTo(parseFloat(data.value));
          break;
        case 'set_speed':
          playbackSpeed = parseFloat(data.value);
          break;
        case 'set_video_duration':
          videoDuration = parseFloat(data.value);
          break;
        case 'toggle':
          toggleFCCDemo();
          break;
      }
    }
  };
  
  // Initialize FCC Demo mode
  function initFCCDemo() {
    const btn = document.getElementById('fcc-demo-btn');
    if (!btn) return;
    
    btn.addEventListener('click', toggleFCCDemo);
  }
  
  function toggleFCCDemo() {
    fccDemoActive = !fccDemoActive;
    const btn = document.getElementById('fcc-demo-btn');
    
    if (fccDemoActive) {
      if (btn) {
        btn.classList.add('toggled-off');
        btn.style.background = '#0078d4';
        btn.style.color = '#fff';
      }
      activateFCCDemo();
      showToast('FCC Demo activated - Use controller to play flythrough');
    } else {
      if (btn) {
        btn.classList.remove('toggled-off');
        btn.style.background = '';
        btn.style.color = '';
      }
      deactivateFCCDemo();
      showToast('FCC Demo deactivated');
    }
  }
  
  async function activateFCCDemo() {
    // Broadcast state to controller
    channel.postMessage({ 
      type: 'animation_state', 
      animationId: 'fcc-demo-btn', 
      isActive: true 
    });
    
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
    
    // Load path from GeoJSON
    await loadPathData();
    
    // Load building obstacles
    loadBuildingObstacles();
    
    // Load tree obstacles
    await loadTreeObstacles();
    
    // Add map layers for visualization
    addMapLayers();
    
    // Set initial position
    seekTo(0);
    
    // Notify controller that demo is ready
    channel.postMessage({
      type: 'fcc_demo_ready',
      data: {
        pathLength: totalPathLength,
        pointCount: pathCoordinates.length
      }
    });
  }
  
  function deactivateFCCDemo() {
    // Broadcast state to controller
    channel.postMessage({ 
      type: 'animation_state', 
      animationId: 'fcc-demo-btn', 
      isActive: false 
    });
    
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
    
    // Stop playback
    pausePlayback();
    
    // Remove map layers
    removeMapLayers();
    
    // Reset state
    currentProgress = 0;
    pathCoordinates = [];
    obstacles = [];
    treeObstacles = [];
    lastBroadcastPosition = null;
    lastBroadcastHeading = null;
  }
  
  async function loadPathData() {
    try {
      const response = await fetch('media/VR-movement.geojson');
      const geojson = await response.json();
      
      if (geojson.features && geojson.features.length > 0) {
        const feature = geojson.features[0];
        if (feature.geometry.type === 'LineString') {
          pathCoordinates = feature.geometry.coordinates;
          
          // Calculate segment lengths and total path length
          segmentLengths = [];
          cumulativeLengths = [0];
          totalPathLength = 0;
          
          for (let i = 1; i < pathCoordinates.length; i++) {
            const segLength = distance(pathCoordinates[i-1], pathCoordinates[i]);
            segmentLengths.push(segLength);
            totalPathLength += segLength;
            cumulativeLengths.push(totalPathLength);
          }
          
          console.log(`FCC Demo: Loaded path with ${pathCoordinates.length} points, ${totalPathLength.toFixed(1)}m total`);
        }
      }
    } catch (e) {
      console.error('FCC Demo: Failed to load path data:', e);
    }
  }
  
  function loadBuildingObstacles() {
    // Check if building footprints are already loaded on the map
    const source = map.getSource('building-footprints');
    if (source && source._data) {
      processGeoJSON(source._data);
      return;
    }
    
    // Try to fetch from file
    fetch('media/building-footprints.geojson')
      .then(res => res.json())
      .then(data => processGeoJSON(data))
      .catch(e => console.warn('FCC Demo: Could not load building footprints:', e));
  }
  
  function processGeoJSON(geojson) {
    obstacles = [];
    if (!geojson.features) return;
    
    geojson.features.forEach(feature => {
      if (feature.geometry.type === 'Polygon') {
        addObstacle(feature.geometry.coordinates[0], feature.properties);
      } else if (feature.geometry.type === 'MultiPolygon') {
        feature.geometry.coordinates.forEach(polygon => {
          addObstacle(polygon[0], feature.properties);
        });
      }
    });
    
    console.log(`FCC Demo: Loaded ${obstacles.length} building obstacles`);
  }
  
  function addObstacle(ring, properties = {}) {
    const lons = ring.map(c => c[0]);
    const lats = ring.map(c => c[1]);
    obstacles.push({
      ring: ring,
      bbox: {
        minLon: Math.min(...lons),
        maxLon: Math.max(...lons),
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats)
      },
      properties: properties
    });
  }
  
  async function loadTreeObstacles() {
    treeObstacles = [];
    
    try {
      const response = await fetch('media/trees.geojson');
      const geojson = await response.json();
      
      if (geojson.features) {
        geojson.features.forEach((feature, index) => {
          if (feature.geometry.type === 'Point') {
            const coords = feature.geometry.coordinates;
            const height = feature.properties?.height || 10;
            const radius = 2 + Math.random() * 1.5 + height * 0.3;
            
            treeObstacles.push({
              center: coords,
              radius: radius,
              height: height,
              index: index,
              properties: feature.properties || {}
            });
          }
        });
        console.log(`FCC Demo: Loaded ${treeObstacles.length} tree obstacles`);
      }
    } catch (e) {
      console.warn('FCC Demo: Could not load trees:', e);
    }
  }
  
  function addMapLayers() {
    // Add ALL buildings layer (background, lower opacity)
    if (!map.getSource('fcc-demo-all-buildings')) {
      // Create features from obstacles
      const buildingFeatures = obstacles.map(obs => ({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [obs.ring]
        },
        properties: obs.properties
      }));
      
      map.addSource('fcc-demo-all-buildings', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: buildingFeatures }
      });
      
      map.addLayer({
        id: 'fcc-demo-all-buildings-fill',
        type: 'fill',
        source: 'fcc-demo-all-buildings',
        paint: {
          'fill-color': '#888888',
          'fill-opacity': 0.15
        }
      });
      
      map.addLayer({
        id: 'fcc-demo-all-buildings-outline',
        type: 'line',
        source: 'fcc-demo-all-buildings',
        paint: {
          'line-color': '#666666',
          'line-width': 1,
          'line-opacity': 0.3
        }
      });
    }
    
    // Add ALL trees layer (background, lower opacity)
    if (!map.getSource('fcc-demo-all-trees')) {
      // Create circle features for all trees
      const treeFeatures = treeObstacles.map(tree => {
        const circleCoords = [];
        for (let a = 0; a <= 360; a += 30) {
          circleCoords.push(destination(tree.center, tree.radius, a));
        }
        circleCoords.push(circleCoords[0]);
        
        return {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [circleCoords]
          },
          properties: tree.properties
        };
      });
      
      map.addSource('fcc-demo-all-trees', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: treeFeatures }
      });
      
      map.addLayer({
        id: 'fcc-demo-all-trees-fill',
        type: 'fill',
        source: 'fcc-demo-all-trees',
        paint: {
          'fill-color': '#2D5A27',
          'fill-opacity': 0.15
        }
      });
      
      map.addLayer({
        id: 'fcc-demo-all-trees-outline',
        type: 'line',
        source: 'fcc-demo-all-trees',
        paint: {
          'line-color': '#2D5A27',
          'line-width': 1,
          'line-opacity': 0.3
        }
      });
    }
    
    // Add path line layer
    if (!map.getSource('fcc-demo-path')) {
      map.addSource('fcc-demo-path', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: pathCoordinates
          }
        }
      });
      
      map.addLayer({
        id: 'fcc-demo-path-line',
        type: 'line',
        source: 'fcc-demo-path',
        paint: {
          'line-color': '#00ff88',
          'line-width': 4,
          'line-opacity': 0.6,
          'line-dasharray': [2, 2]
        }
      });
    }
    
    // Add isovist polygon layer
    if (!map.getSource('fcc-demo-isovist')) {
      map.addSource('fcc-demo-isovist', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addLayer({
        id: 'fcc-demo-isovist-fill',
        type: 'fill',
        source: 'fcc-demo-isovist',
        paint: {
          'fill-color': '#00ffcc',
          'fill-opacity': 0.25
        }
      });
      
      map.addLayer({
        id: 'fcc-demo-isovist-line',
        type: 'line',
        source: 'fcc-demo-isovist',
        paint: {
          'line-color': '#00ffcc',
          'line-width': 3,
          'line-opacity': 0.8
        }
      });
    }
    
    // Add viewer position marker
    if (!map.getSource('fcc-demo-viewer')) {
      map.addSource('fcc-demo-viewer', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addLayer({
        id: 'fcc-demo-viewer-point',
        type: 'circle',
        source: 'fcc-demo-viewer',
        paint: {
          'circle-radius': 10,
          'circle-color': '#ff0066',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3
        }
      });
      
      map.addLayer({
        id: 'fcc-demo-viewer-direction',
        type: 'line',
        source: 'fcc-demo-viewer',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': '#ff0066',
          'line-width': 4,
          'line-opacity': 1
        }
      });
    }
    
    // Add viewed buildings layer
    if (!map.getSource('fcc-demo-viewed-buildings')) {
      map.addSource('fcc-demo-viewed-buildings', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addLayer({
        id: 'fcc-demo-viewed-buildings-fill',
        type: 'fill',
        source: 'fcc-demo-viewed-buildings',
        paint: {
          'fill-color': '#ffaa00',
          'fill-opacity': 0.4
        }
      });
    }
    
    // Add viewed trees layer
    if (!map.getSource('fcc-demo-viewed-trees')) {
      map.addSource('fcc-demo-viewed-trees', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addLayer({
        id: 'fcc-demo-viewed-trees-fill',
        type: 'fill',
        source: 'fcc-demo-viewed-trees',
        paint: {
          'fill-color': '#00ff44',
          'fill-opacity': 0.5
        }
      });
    }
  }
  
  function removeMapLayers() {
    const layers = [
      'fcc-demo-all-buildings-fill',
      'fcc-demo-all-buildings-outline',
      'fcc-demo-all-trees-fill',
      'fcc-demo-all-trees-outline',
      'fcc-demo-path-line',
      'fcc-demo-isovist-fill',
      'fcc-demo-isovist-line',
      'fcc-demo-viewer-point',
      'fcc-demo-viewer-direction',
      'fcc-demo-viewed-buildings-fill',
      'fcc-demo-viewed-trees-fill'
    ];
    
    const sources = [
      'fcc-demo-all-buildings',
      'fcc-demo-all-trees',
      'fcc-demo-path',
      'fcc-demo-isovist',
      'fcc-demo-viewer',
      'fcc-demo-viewed-buildings',
      'fcc-demo-viewed-trees'
    ];
    
    layers.forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    
    sources.forEach(id => {
      if (map.getSource(id)) map.removeSource(id);
    });
  }
  
  function startPlayback() {
    if (isPlaying) return;
    isPlaying = true;
    lastTimestamp = performance.now();
    animationFrameId = requestAnimationFrame(playbackLoop);
    
    channel.postMessage({
      type: 'fcc_demo_playback_state',
      isPlaying: true
    });
  }
  
  function pausePlayback() {
    isPlaying = false;
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    
    channel.postMessage({
      type: 'fcc_demo_playback_state',
      isPlaying: false
    });
  }
  
  function playbackLoop(timestamp) {
    if (!isPlaying || !fccDemoActive) return;
    
    const deltaTime = (timestamp - lastTimestamp) / 1000; // seconds
    lastTimestamp = timestamp;
    
    // Progress based on video duration
    const progressIncrement = (deltaTime * playbackSpeed) / videoDuration;
    currentProgress = Math.min(1, currentProgress + progressIncrement);
    
    // Update visualization
    updateVisualization();
    
    // Broadcast progress to controller for video sync
    channel.postMessage({
      type: 'fcc_demo_progress',
      progress: currentProgress,
      time: currentProgress * videoDuration
    });
    
    // Continue if not at end
    if (currentProgress < 1) {
      animationFrameId = requestAnimationFrame(playbackLoop);
    } else {
      pausePlayback();
    }
  }
  
  function seekTo(progress) {
    currentProgress = Math.max(0, Math.min(1, progress));
    
    // Reset broadcast state to force immediate update
    lastBroadcastPosition = null;
    lastBroadcastHeading = null;
    
    updateVisualization();
    
    // Broadcast to controller
    channel.postMessage({
      type: 'fcc_demo_progress',
      progress: currentProgress,
      time: currentProgress * videoDuration
    });
  }
  
  function updateVisualization() {
    if (pathCoordinates.length < 2) return;
    
    // Get position and look direction along path
    const { position, direction } = getPositionAlongPath(currentProgress);
    
    // Broadcast position for Street View (throttled)
    broadcastStreetViewPosition(position, direction);
    
    // Update viewer marker
    const viewerFeatures = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: position }
        }
      ]
    };
    
    // Add direction line
    if (direction) {
      const directionEnd = destination(position, 30, direction);
      viewerFeatures.features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [position, directionEnd]
        }
      });
    }
    
    if (map.getSource('fcc-demo-viewer')) {
      map.getSource('fcc-demo-viewer').setData(viewerFeatures);
    }
    
    // Calculate and update isovist
    if (obstacles.length > 0 || treeObstacles.length > 0) {
      const result = calculateIsovist(position, direction);
      
      if (map.getSource('fcc-demo-isovist')) {
        map.getSource('fcc-demo-isovist').setData({
          type: 'FeatureCollection',
          features: [result.polygon]
        });
      }
      
      if (map.getSource('fcc-demo-viewed-buildings')) {
        map.getSource('fcc-demo-viewed-buildings').setData({
          type: 'FeatureCollection',
          features: result.viewedBuildings
        });
      }
      
      if (map.getSource('fcc-demo-viewed-trees')) {
        map.getSource('fcc-demo-viewed-trees').setData({
          type: 'FeatureCollection',
          features: result.viewedTrees
        });
      }
      
      // Broadcast stats to controller
      channel.postMessage({
        type: 'fcc_demo_stats',
        data: result.stats
      });
    }
  }
  
  // Broadcast position to controller for Street View (throttled)
  function broadcastStreetViewPosition(position, heading) {
    if (!position) return;
    
    const currentHeading = heading || 0;
    const positionChanged = !lastBroadcastPosition || 
      distance([lastBroadcastPosition.lng, lastBroadcastPosition.lat], position) > BROADCAST_MIN_DISTANCE;
    const headingChanged = lastBroadcastHeading === null || 
      Math.abs(currentHeading - lastBroadcastHeading) > BROADCAST_MIN_HEADING_CHANGE;
    
    if (positionChanged || headingChanged) {
      lastBroadcastPosition = { lng: position[0], lat: position[1] };
      lastBroadcastHeading = currentHeading;
      
      channel.postMessage({
        type: 'street_view_position',
        position: {
          lng: position[0],
          lat: position[1]
        },
        heading: currentHeading
      });
    }
  }
  
  function getPositionAlongPath(progress) {
    if (pathCoordinates.length < 2) {
      return { position: pathCoordinates[0] || [0, 0], direction: 0 };
    }
    
    const targetDistance = progress * totalPathLength;
    
    // Find the segment containing this distance
    let segmentIndex = 0;
    for (let i = 0; i < cumulativeLengths.length - 1; i++) {
      if (targetDistance >= cumulativeLengths[i] && targetDistance <= cumulativeLengths[i + 1]) {
        segmentIndex = i;
        break;
      }
    }
    
    // Interpolate within segment
    const segmentStart = cumulativeLengths[segmentIndex];
    const segmentEnd = cumulativeLengths[segmentIndex + 1];
    const segmentProgress = segmentEnd > segmentStart 
      ? (targetDistance - segmentStart) / (segmentEnd - segmentStart)
      : 0;
    
    const p1 = pathCoordinates[segmentIndex];
    const p2 = pathCoordinates[segmentIndex + 1] || p1;
    
    const position = [
      p1[0] + (p2[0] - p1[0]) * segmentProgress,
      p1[1] + (p2[1] - p1[1]) * segmentProgress
    ];
    
    // Direction is bearing to next point
    const direction = calculateBearing(p1, p2);
    
    return { position, direction };
  }
  
  function calculateIsovist(origin, lookDirection) {
    const rays = [];
    const viewedObstacleIndices = new Set();
    const viewedTreeIndices = new Set();
    
    // Ray casting parameters
    let startAngle, endAngle, angleStep;
    
    if (USE_HUMAN_FOV && lookDirection !== null) {
      const halfFOV = (HUMAN_FOV / 2) * Math.PI / 180;
      const viewAngle = lookDirection * Math.PI / 180;
      startAngle = viewAngle - halfFOV;
      endAngle = viewAngle + halfFOV;
      angleStep = (endAngle - startAngle) / RAY_COUNT;
    } else {
      startAngle = 0;
      endAngle = 2 * Math.PI;
      angleStep = (2 * Math.PI) / RAY_COUNT;
    }
    
    // Stats tracking
    let openRays = 0;
    let buildingRays = 0;
    let treeRays = 0;
    const buildingTypeRays = {};
    
    // Cast rays
    for (let angle = startAngle; angle < endAngle; angle += angleStep) {
      const bearing = (angle * 180 / Math.PI + 360) % 360;
      const maxPoint = destination(origin, MAX_VIEW_DISTANCE, bearing);
      
      let closestDist = MAX_VIEW_DISTANCE;
      let hitType = 'open';
      let hitObstacleIdx = -1;
      let hitTreeIdx = -1;
      let hitBuildingType = null;
      
      // Check building intersections
      for (let i = 0; i < obstacles.length; i++) {
        const obs = obstacles[i];
        
        // Bounding box check
        const rayBbox = {
          minLon: Math.min(origin[0], maxPoint[0]),
          maxLon: Math.max(origin[0], maxPoint[0]),
          minLat: Math.min(origin[1], maxPoint[1]),
          maxLat: Math.max(origin[1], maxPoint[1])
        };
        
        if (rayBbox.maxLon < obs.bbox.minLon || rayBbox.minLon > obs.bbox.maxLon ||
            rayBbox.maxLat < obs.bbox.minLat || rayBbox.minLat > obs.bbox.maxLat) {
          continue;
        }
        
        // Check each edge of the obstacle
        const ring = obs.ring;
        for (let j = 0; j < ring.length - 1; j++) {
          const intersection = lineIntersection(origin, maxPoint, ring[j], ring[j + 1]);
          if (intersection) {
            const dist = distance(origin, intersection);
            if (dist < closestDist) {
              closestDist = dist;
              hitType = 'building';
              hitObstacleIdx = i;
              hitBuildingType = obs.properties?.ANDESSION || 'Unknown';
            }
          }
        }
      }
      
      // Check tree intersections
      if (INCLUDE_TREES) {
        for (let i = 0; i < treeObstacles.length; i++) {
          const tree = treeObstacles[i];
          const treeDist = rayCircleIntersection(origin, maxPoint, tree.center, tree.radius);
          
          if (treeDist !== null && treeDist < closestDist) {
            closestDist = treeDist;
            hitType = 'tree';
            hitTreeIdx = i;
            hitObstacleIdx = -1;
          }
        }
      }
      
      // Record ray result
      const hitPoint = destination(origin, closestDist, bearing);
      rays.push(hitPoint);
      
      // Track stats
      if (hitType === 'open') {
        openRays++;
      } else if (hitType === 'building') {
        buildingRays++;
        viewedObstacleIndices.add(hitObstacleIdx);
        buildingTypeRays[hitBuildingType] = (buildingTypeRays[hitBuildingType] || 0) + 1;
      } else if (hitType === 'tree') {
        treeRays++;
        viewedTreeIndices.add(hitTreeIdx);
      }
    }
    
    // Build isovist polygon
    const polygonCoords = [origin, ...rays, origin];
    const polygon = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [polygonCoords]
      }
    };
    
    // Build viewed buildings features
    const viewedBuildings = [];
    viewedObstacleIndices.forEach(idx => {
      viewedBuildings.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [obstacles[idx].ring]
        },
        properties: obstacles[idx].properties
      });
    });
    
    // Build viewed trees features (as circles)
    const viewedTrees = [];
    viewedTreeIndices.forEach(idx => {
      const tree = treeObstacles[idx];
      // Create approximate circle
      const circleCoords = [];
      for (let a = 0; a <= 360; a += 30) {
        circleCoords.push(destination(tree.center, tree.radius, a));
      }
      circleCoords.push(circleCoords[0]);
      
      viewedTrees.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [circleCoords]
        },
        properties: tree.properties
      });
    });
    
    const totalRays = rays.length;
    const stats = {
      totalRays,
      openRays,
      buildingRays,
      treeRays,
      buildingTypeRays,
      viewedBuildingCount: viewedObstacleIndices.size,
      viewedTreeCount: viewedTreeIndices.size
    };
    
    return { polygon, viewedBuildings, viewedTrees, stats };
  }
  
  // Ray-circle intersection helper
  function rayCircleIntersection(rayStart, rayEnd, circleCenter, radiusMeters) {
    const dx = rayEnd[0] - rayStart[0];
    const dy = rayEnd[1] - rayStart[1];
    
    const fx = rayStart[0] - circleCenter[0];
    const fy = rayStart[1] - circleCenter[1];
    
    // Convert radius from meters to approximate degrees
    const radiusDeg = radiusMeters / 111320;
    
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - radiusDeg * radiusDeg;
    
    const discriminant = b * b - 4 * a * c;
    
    if (discriminant < 0) return null;
    
    const sqrtDisc = Math.sqrt(discriminant);
    let t = (-b - sqrtDisc) / (2 * a);
    
    if (t < 0) {
      t = (-b + sqrtDisc) / (2 * a);
    }
    
    if (t >= 0 && t <= 1) {
      const hitPoint = [
        rayStart[0] + t * dx,
        rayStart[1] + t * dy
      ];
      return distance(rayStart, hitPoint);
    }
    
    return null;
  }
  
  // Geometric helpers
  function calculateBearing(from, to) {
    const lon1 = from[0] * Math.PI / 180;
    const lat1 = from[1] * Math.PI / 180;
    const lon2 = to[0] * Math.PI / 180;
    const lat2 = to[1] * Math.PI / 180;
    
    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
    
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }
  
  function destination(origin, distMeters, bearingDegrees) {
    // Fast flat-earth approximation (accurate within 0.1% for distances < 1km)
    const brng = bearingDegrees * DEG2RAD;
    const cosLat = Math.cos(origin[1] * DEG2RAD);
    return [
      origin[0] + Math.sin(brng) * distMeters / (111320 * cosLat),
      origin[1] + Math.cos(brng) * distMeters / 110540
    ];
  }
  
  function distance(point1, point2) {
    // Fast flat-earth approximation (accurate within 0.1% for distances < 1km)
    const latMid = (point1[1] + point2[1]) * 0.5 * DEG2RAD;
    const cosLat = Math.cos(latMid);
    const dx = (point2[0] - point1[0]) * 111320 * cosLat;
    const dy = (point2[1] - point1[1]) * 110540;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  function lineIntersection(p1, p2, p3, p4) {
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];
    const x3 = p3[0], y3 = p3[1];
    const x4 = p4[0], y4 = p4[1];
    
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-10) return null;
    
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    }
    
    return null;
  }
  
  // Toast helper
  function showToast(msg) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
    } else {
      console.log('FCC Demo:', msg);
    }
  }
  
  // Initialize when map is ready
  if (window.map && window.map.loaded()) {
    initFCCDemo();
  } else {
    const checkMap = setInterval(() => {
      if (window.map && window.map.loaded()) {
        clearInterval(checkMap);
        initFCCDemo();
      }
    }, 100);
    
    // Fallback
    setTimeout(() => {
      clearInterval(checkMap);
      if (window.map) {
        window.map.on('load', initFCCDemo);
      }
    }, 5000);
  }
  
})();
