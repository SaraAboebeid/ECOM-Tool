// Campus Demo - Dynamic SVG Layer Presentation
// Animates campus.svg layers in sequence with keyboard controls
// Version: 0.4 - Slideshow mode (arrow keys to navigate)

(function() {
  const channel = new BroadcastChannel('map_controller_channel');
  let active = false;
  let container = null;
  let svgDoc = null;
  let rafId = null;
  let animationPhase = -1; // Start at -1, first arrow press goes to 0
  let phaseStartTime = 0;
  let svgLoaded = false;
  let phaseComplete = false; // Track if current phase animation is done
  let autoPlayActive = false; // Auto-advance through all phases

  // Remember previous states so we can restore when campus demo stops
  let prevStreetLifeActive = false;
  let prevTrafikActive = false;

  // --- Performance: filter throttle & cache ---
  let frameCount = 0;
  const FILTER_THROTTLE = 4; // Update filters every 4th frame (~15fps)
  const filterCache = new WeakMap(); // Cache last filter string per element

  function shouldUpdateFilter() {
    return (frameCount % FILTER_THROTTLE) === 0;
  }

  function setFilterCached(el, filterStr) {
    if (filterCache.get(el) !== filterStr) {
      el.style.filter = filterStr;
      filterCache.set(el, filterStr);
    }
  }

  // Promote an element to its own GPU compositor layer
  function gpuPromote(el) {
    if (!el.dataset.gpuPromoted) {
      el.style.willChange = 'filter, transform, opacity';
      el.dataset.gpuPromoted = '1';
    }
  }

  // Inject CSS keyframe animations for steady-state glow once
  let glowStylesInjected = false;
  function injectGlowStyles() {
    if (glowStylesInjected) return;
    const style = document.createElement('style');
    style.textContent = `
      @keyframes campus-glow-pulse-boundary {
        0%, 100% { filter: drop-shadow(0 0 6px rgba(200,200,255,0.8)) drop-shadow(0 0 18px rgba(140,140,240,0.4)); }
        50% { filter: drop-shadow(0 0 16px rgba(200,200,255,1.0)) drop-shadow(0 0 32px rgba(140,140,240,0.6)); }
      }
      @keyframes campus-glow-pulse-path {
        0%, 100% { filter: drop-shadow(0 0 4px var(--glow-color, rgba(219,87,19,0.8))); }
        50% { filter: drop-shadow(0 0 14px var(--glow-color, rgba(219,87,19,0.8))); }
      }
      @keyframes campus-glow-pulse-marker {
        0%, 100% { filter: drop-shadow(0 0 6px var(--glow-color, rgba(237,192,6,0.9))); }
        50% { filter: drop-shadow(0 0 18px var(--glow-color, rgba(237,192,6,0.9))); }
      }
      @keyframes campus-glow-pulse-green {
        0%, 100% { filter: drop-shadow(0 0 8px rgba(140,186,99,0.5)); transform: scale(1); }
        50% { filter: drop-shadow(0 0 22px rgba(140,186,99,0.8)); transform: scale(1.04); }
      }
      @keyframes campus-glow-pulse-asterix-center {
        0%, 100% { filter: drop-shadow(0 0 12px rgba(230,168,50,0.6)) drop-shadow(0 0 28px rgba(230,168,50,0.3)); }
        50% { filter: drop-shadow(0 0 20px rgba(230,168,50,0.9)) drop-shadow(0 0 40px rgba(230,168,50,0.5)); }
      }
      .campus-glow-steady-boundary { animation: campus-glow-pulse-boundary 2.5s ease-in-out infinite; }
      .campus-glow-steady-path { animation: campus-glow-pulse-path 2s ease-in-out infinite; }
      .campus-glow-steady-marker { animation: campus-glow-pulse-marker 1.5s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
      .campus-glow-steady-green { animation: campus-glow-pulse-green 3s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
      .campus-glow-steady-asterix-center { animation: campus-glow-pulse-asterix-center 2.5s ease-in-out infinite; }
    `;
    document.head.appendChild(style);
    glowStylesInjected = true;
  }

  // Positioning controls state
  let positionControls = null;
  let svgTransform = {
    translateX: 128,
    translateY: -35,
    scale: 2.45,
    rotation: 3  // in 90-degree increments (0, 1, 2, 3 = 0°, -90°, -180°, -270°)
  };
  const SHOW_POSITION_CONTROLS = false; // Set to true to show calibration controls

  // Buildings overlay state
  let buildingsLayerAdded = false;
  const BUILDINGS_SOURCE_ID = 'campus-demo-buildings';
  const BUILDINGS_LAYER_ID = 'campus-demo-buildings-fill';
  const BUILDINGS_OUTLINE_ID = 'campus-demo-buildings-outline';

  // Animation phases configuration - Updated for campus_v2.svg structure
  const PHASES = [
    { name: 'boundary', duration: 3000, label: 'Project Boundary' },
    { name: 'living-primary', duration: 4000, label: 'Living Campus - Primary Routes' },
    { name: 'living-secondary', duration: 3000, label: 'Living Campus - Secondary Routes' },
    { name: 'living-points', duration: 3000, label: 'Living Campus - Points' },
    { name: 'living-asterix', duration: 2000, label: 'Living Campus - Activity Nodes' },
    { name: 'health-primary', duration: 4000, label: 'Health Campus - Primary Routes' },
    { name: 'health-secondary', duration: 3000, label: 'Health Campus - Secondary Routes' },
    { name: 'health-tertiary', duration: 3000, label: 'Health Campus - Tertiary Routes' },
    { name: 'health-points', duration: 3000, label: 'Health Campus - Points' },
    { name: 'green-spaces', duration: 4000, label: 'Green Meeting Spaces' },
  ];

  // Phase indicator UI
  let phaseIndicator = null;

  function createPhaseIndicator() {
    if (phaseIndicator) return;
    phaseIndicator = document.createElement('div');
    phaseIndicator.id = 'campus-phase-indicator';
    phaseIndicator.style.cssText = `
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 16px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
    `;
    phaseIndicator.innerHTML = `
      <span class="phase-label" style="min-width: 200px;">Press → to start</span>
      <span class="phase-dots" style="display: flex; gap: 6px;"></span>
      <span class="phase-hint" style="opacity: 0.6; font-size: 12px;">← → &nbsp; Space: Auto</span>
    `;
    document.body.appendChild(phaseIndicator);
    updatePhaseIndicator();
  }

  function updatePhaseIndicator() {
    if (!phaseIndicator) return;
    const label = phaseIndicator.querySelector('.phase-label');
    const dots = phaseIndicator.querySelector('.phase-dots');
    const hint = phaseIndicator.querySelector('.phase-hint');
    
    if (animationPhase < 0) {
      label.textContent = autoPlayActive ? '▶ Auto-playing…' : 'Press → to start';
    } else if (animationPhase < PHASES.length) {
      label.textContent = (autoPlayActive ? '▶ ' : '') + PHASES[animationPhase].label;
    } else {
      label.textContent = 'Complete - Press ← to review';
    }
    
    if (hint) {
      hint.textContent = autoPlayActive ? 'Space: Stop auto' : '← →   Space: Auto';
    }
    
    // Update dots
    dots.innerHTML = PHASES.map((_, i) => {
      const isActive = i === animationPhase;
      const isPast = i < animationPhase;
      const color = isActive ? '#4CAF50' : (isPast ? '#888' : '#444');
      return `<span style="width: 8px; height: 8px; border-radius: 50%; background: ${color}; transition: background 0.3s;"></span>`;
    }).join('');
  }

  function removePhaseIndicator() {
    if (phaseIndicator && phaseIndicator.parentNode) {
      phaseIndicator.parentNode.removeChild(phaseIndicator);
      phaseIndicator = null;
    }
  }

  // Load saved transform from localStorage
  function loadSavedTransform() {
    try {
      const saved = localStorage.getItem('campus-demo-transform');
      if (saved) {
        const parsed = JSON.parse(saved);
        svgTransform = { ...svgTransform, ...parsed };
        console.log('Campus Demo: Loaded saved transform:', svgTransform);
      }
    } catch (e) {
      console.warn('Campus Demo: Could not load saved transform:', e);
    }
  }

  // Save transform to localStorage
  function saveTransform() {
    try {
      localStorage.setItem('campus-demo-transform', JSON.stringify(svgTransform));
      console.log('Campus Demo: Saved transform:', svgTransform);
    } catch (e) {
      console.warn('Campus Demo: Could not save transform:', e);
    }
  }

  // Apply current transform to SVG
  function applyTransform() {
    if (!svgDoc) return;
    const rotation = svgTransform.rotation * -90; // Convert to degrees (anticlockwise)
    svgDoc.style.transform = `
      translate(${svgTransform.translateX}px, ${svgTransform.translateY}px)
      scale(${svgTransform.scale})
      rotate(${rotation}deg)
    `;
    svgDoc.style.transformOrigin = 'center center';
  }

  // Create positioning controls panel
  function createPositionControls() {
    if (positionControls) return;
    
    loadSavedTransform();
    
    positionControls = document.createElement('div');
    positionControls.id = 'campus-position-controls';
    positionControls.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 16px;
      border-radius: 12px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      z-index: 200;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.15);
      min-width: 220px;
      pointer-events: auto;
    `;
    
    positionControls.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 12px; font-size: 14px;">SVG Position Controls</div>
      
      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; opacity: 0.7;">Rotation (90° steps)</label>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button id="pos-rotate-ccw" style="padding: 6px 12px; cursor: pointer; border-radius: 4px; border: 1px solid #555; background: #333; color: white;">↺ -90°</button>
          <span id="pos-rotation-val" style="min-width: 50px; text-align: center;">${svgTransform.rotation * -90}°</span>
          <button id="pos-rotate-cw" style="padding: 6px 12px; cursor: pointer; border-radius: 4px; border: 1px solid #555; background: #333; color: white;">↻ +90°</button>
        </div>
      </div>
      
      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; opacity: 0.7;">Translate X: <span id="pos-x-val">${svgTransform.translateX}</span>px</label>
        <input type="range" id="pos-translate-x" min="-500" max="500" value="${svgTransform.translateX}" style="width: 100%; cursor: pointer;">
      </div>
      
      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; opacity: 0.7;">Translate Y: <span id="pos-y-val">${svgTransform.translateY}</span>px</label>
        <input type="range" id="pos-translate-y" min="-500" max="500" value="${svgTransform.translateY}" style="width: 100%; cursor: pointer;">
      </div>
      
      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; opacity: 0.7;">Scale: <span id="pos-scale-val">${svgTransform.scale.toFixed(2)}</span></label>
        <input type="range" id="pos-scale" min="0.1" max="3" step="0.05" value="${svgTransform.scale}" style="width: 100%; cursor: pointer;">
      </div>
      
      <div style="display: flex; gap: 8px; margin-top: 16px;">
        <button id="pos-reset" style="flex: 1; padding: 8px; cursor: pointer; border-radius: 4px; border: 1px solid #555; background: #333; color: white;">Reset</button>
        <button id="pos-save" style="flex: 1; padding: 8px; cursor: pointer; border-radius: 4px; border: none; background: #4CAF50; color: white;">Save</button>
      </div>
      
      <div style="margin-top: 12px; opacity: 0.5; font-size: 11px;">Use arrow keys + Shift for fine control</div>
    `;
    
    document.body.appendChild(positionControls);
    
    // Wire up event listeners
    positionControls.querySelector('#pos-rotate-ccw').addEventListener('click', () => {
      svgTransform.rotation = (svgTransform.rotation + 1) % 4;
      positionControls.querySelector('#pos-rotation-val').textContent = `${svgTransform.rotation * -90}°`;
      applyTransform();
    });
    
    positionControls.querySelector('#pos-rotate-cw').addEventListener('click', () => {
      svgTransform.rotation = (svgTransform.rotation - 1 + 4) % 4;
      positionControls.querySelector('#pos-rotation-val').textContent = `${svgTransform.rotation * -90}°`;
      applyTransform();
    });
    
    positionControls.querySelector('#pos-translate-x').addEventListener('input', (e) => {
      svgTransform.translateX = parseFloat(e.target.value);
      positionControls.querySelector('#pos-x-val').textContent = svgTransform.translateX;
      applyTransform();
    });
    
    positionControls.querySelector('#pos-translate-y').addEventListener('input', (e) => {
      svgTransform.translateY = parseFloat(e.target.value);
      positionControls.querySelector('#pos-y-val').textContent = svgTransform.translateY;
      applyTransform();
    });
    
    positionControls.querySelector('#pos-scale').addEventListener('input', (e) => {
      svgTransform.scale = parseFloat(e.target.value);
      positionControls.querySelector('#pos-scale-val').textContent = svgTransform.scale.toFixed(2);
      applyTransform();
    });
    
    positionControls.querySelector('#pos-reset').addEventListener('click', () => {
      svgTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
      positionControls.querySelector('#pos-translate-x').value = 0;
      positionControls.querySelector('#pos-translate-y').value = 0;
      positionControls.querySelector('#pos-scale').value = 1;
      positionControls.querySelector('#pos-x-val').textContent = '0';
      positionControls.querySelector('#pos-y-val').textContent = '0';
      positionControls.querySelector('#pos-scale-val').textContent = '1.00';
      positionControls.querySelector('#pos-rotation-val').textContent = '0°';
      applyTransform();
    });
    
    positionControls.querySelector('#pos-save').addEventListener('click', () => {
      saveTransform();
      const btn = positionControls.querySelector('#pos-save');
      const originalText = btn.textContent;
      btn.textContent = 'Saved!';
      btn.style.background = '#2E7D32';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '#4CAF50';
      }, 1000);
    });
    
    // Apply initial transform
    applyTransform();
  }

  // Remove positioning controls
  function removePositionControls() {
    if (positionControls && positionControls.parentNode) {
      positionControls.parentNode.removeChild(positionControls);
      positionControls = null;
    }
  }

  // Handle keyboard shortcuts for fine position control
  function handlePositionKeydown(e) {
    if (!active || !e.shiftKey) return;
    
    const step = e.ctrlKey ? 10 : 1; // Ctrl for larger steps
    let handled = false;
    
    switch (e.key) {
      case 'ArrowUp':
        svgTransform.translateY -= step;
        handled = true;
        break;
      case 'ArrowDown':
        svgTransform.translateY += step;
        handled = true;
        break;
      case 'ArrowLeft':
        if (e.altKey) {
          // Alt+Shift+Left = rotate anticlockwise
          svgTransform.rotation = (svgTransform.rotation + 1) % 4;
        } else {
          svgTransform.translateX -= step;
        }
        handled = true;
        break;
      case 'ArrowRight':
        if (e.altKey) {
          // Alt+Shift+Right = rotate clockwise
          svgTransform.rotation = (svgTransform.rotation - 1 + 4) % 4;
        } else {
          svgTransform.translateX += step;
        }
        handled = true;
        break;
      case '+':
      case '=':
        svgTransform.scale = Math.min(3, svgTransform.scale + 0.05);
        handled = true;
        break;
      case '-':
      case '_':
        svgTransform.scale = Math.max(0.1, svgTransform.scale - 0.05);
        handled = true;
        break;
    }
    
    if (handled) {
      e.preventDefault();
      applyTransform();
      updatePositionControlsUI();
    }
  }

  // Update the controls UI to reflect current values
  function updatePositionControlsUI() {
    if (!positionControls) return;
    positionControls.querySelector('#pos-translate-x').value = svgTransform.translateX;
    positionControls.querySelector('#pos-translate-y').value = svgTransform.translateY;
    positionControls.querySelector('#pos-scale').value = svgTransform.scale;
    positionControls.querySelector('#pos-x-val').textContent = svgTransform.translateX;
    positionControls.querySelector('#pos-y-val').textContent = svgTransform.translateY;
    positionControls.querySelector('#pos-scale-val').textContent = svgTransform.scale.toFixed(2);
    positionControls.querySelector('#pos-rotation-val').textContent = `${svgTransform.rotation * -90}°`;
  }

  // Load and display buildings overlay on map
  async function addBuildingsOverlay() {
    if (buildingsLayerAdded) return;
    if (typeof window.map === 'undefined') {
      console.warn('Campus Demo: Map not available for buildings overlay');
      return;
    }
    
    const map = window.map;
    
    try {
      const response = await fetch('media/building-footprints.geojson');
      if (!response.ok) {
        console.warn('Campus Demo: Building footprints file not found');
        return;
      }
      
      const geojson = await response.json();
      
      // Add source if it doesn't exist
      if (!map.getSource(BUILDINGS_SOURCE_ID)) {
        map.addSource(BUILDINGS_SOURCE_ID, {
          type: 'geojson',
          data: geojson
        });
      }
      
      // Add fill layer - very light overlay
      if (!map.getLayer(BUILDINGS_LAYER_ID)) {
        map.addLayer({
          id: BUILDINGS_LAYER_ID,
          type: 'fill',
          source: BUILDINGS_SOURCE_ID,
          paint: {
            'fill-color': '#8899aa',
            'fill-opacity': 0.08  // Very light - just a hint of buildings
          }
        });
      }
      
      // Add outline layer - very subtle
      if (!map.getLayer(BUILDINGS_OUTLINE_ID)) {
        map.addLayer({
          id: BUILDINGS_OUTLINE_ID,
          type: 'line',
          source: BUILDINGS_SOURCE_ID,
          paint: {
            'line-color': '#667788',
            'line-width': 0.5,
            'line-opacity': 0.15  // Very subtle outline
          }
        });
      }
      
      buildingsLayerAdded = true;
      console.log('Campus Demo: Buildings overlay added');
      
    } catch (error) {
      console.warn('Campus Demo: Failed to load buildings overlay:', error);
    }
  }

  // Remove buildings overlay from map
  function removeBuildingsOverlay() {
    if (!buildingsLayerAdded) return;
    if (typeof window.map === 'undefined') return;
    
    const map = window.map;
    
    try {
      if (map.getLayer(BUILDINGS_OUTLINE_ID)) {
        map.removeLayer(BUILDINGS_OUTLINE_ID);
      }
      if (map.getLayer(BUILDINGS_LAYER_ID)) {
        map.removeLayer(BUILDINGS_LAYER_ID);
      }
      if (map.getSource(BUILDINGS_SOURCE_ID)) {
        map.removeSource(BUILDINGS_SOURCE_ID);
      }
      buildingsLayerAdded = false;
      console.log('Campus Demo: Buildings overlay removed');
    } catch (error) {
      console.warn('Campus Demo: Error removing buildings overlay:', error);
    }
  }

  function createContainer() {
    if (container) return;
    container = document.createElement('div');
    container.id = 'campus-demo-container';
    container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    document.body.appendChild(container);
  }

  async function loadSVG() {
    if (svgLoaded) return;
    try {
      const response = await fetch('media/campus_v2.svg');
      const svgText = await response.text();
      
      // Parse SVG
      const parser = new DOMParser();
      svgDoc = parser.parseFromString(svgText, 'image/svg+xml').documentElement;
      
      // Style the SVG container
      svgDoc.style.cssText = `
        width: 80%;
        height: 80%;
        max-width: 900px;
        max-height: 1100px;
        filter: drop-shadow(0 0 20px rgba(0,0,0,0.5));
      `;
      
      // Hide all main layers initially
      ['projektgräns', 'LEVANDE-CAMPUS', 'HÄLSOFRÄMJANDE-CAMPUS', 'Gröna-mötesplatser'].forEach(id => {
        const layer = svgDoc.getElementById(id);
        if (layer) {
          layer.style.opacity = '0';
          layer.style.visibility = 'hidden';
        }
      });
      
      // Prepare paths for stroke animation
      prepareRoutePaths(svgDoc);
      
      // Hide all elements initially
      hideAllElements(svgDoc);
      
      container.appendChild(svgDoc);
      svgLoaded = true;
      
      // Apply any saved transform
      loadSavedTransform();
      applyTransform();
      
      console.log('Campus Demo: SVG loaded (campus_v2.svg)');
      console.log('  Layer structure:');
      console.log('  - projektgräns: Project boundary');
      console.log('  - LEVANDE-CAMPUS: Primary Path, Secondary Path, Points, Asterix');
      console.log('  - HÄLSOFRÄMJANDE-CAMPUS: Primary Path, Secondary Path, Tertiary Path, Points');
      console.log('  - Gröna-mötesplatser: Green blobs');
    } catch (e) {
      console.error('Campus Demo: Failed to load SVG:', e);
    }
  }

  // Find group by title within a layer
  function findGroupByTitle(layer, titleText) {
    const groups = layer.querySelectorAll('g');
    for (const g of groups) {
      const title = g.querySelector(':scope > title');
      if (title && title.textContent.includes(titleText)) {
        return g;
      }
    }
    // Debug: list all titles found
    console.log(`Campus Demo: Looking for "${titleText}" in layer "${layer.id}". Found titles:`);
    groups.forEach(g => {
      const t = g.querySelector(':scope > title');
      if (t) console.log(`  - "${t.textContent}"`);
    });
    return null;
  }

  function prepareRoutePaths(svg) {
    // Prepare stroke-dasharray for all paths with strokes (for draw animation)
    svg.querySelectorAll('path').forEach(path => {
      const stroke = path.getAttribute('stroke') || path.style.stroke;
      if (stroke && stroke !== 'none' && path.getTotalLength) {
        try {
          const length = path.getTotalLength();
          path.dataset.pathLength = length;
          path.dataset.originalDasharray = path.style.strokeDasharray || path.getAttribute('stroke-dasharray') || '';
        } catch (e) {
          // Some paths may not support getTotalLength
        }
      }
    });
  }

  function hideAllElements(svg) {
    // Hide all paths, lines in the main layers
    ['projektgräns', 'LEVANDE-CAMPUS', 'HÄLSOFRÄMJANDE-CAMPUS', 'Gröna-mötesplatser'].forEach(layerId => {
      const layer = svg.getElementById(layerId);
      if (layer) {
        layer.querySelectorAll('path, line').forEach(el => {
          el.style.opacity = '0';
        });
        // Also hide nested groups
        layer.querySelectorAll('g').forEach(g => {
          g.style.opacity = '0';
        });
      }
    });
  }

  // Track which groups have been animated (for dimming old layers)
  const shownGroups = [];

  // Dim previous layers when showing new content
  function dimPreviousLayers() {
    shownGroups.forEach(({ group, layer }) => {
      if (group) {
        group.style.opacity = '0.4';
        group.querySelectorAll('path, line').forEach(el => {
          el.style.filter = 'none';
        });
      }
    });
  }

  // Register a group as shown (for tracking)
  function registerShownGroup(group, layer) {
    if (group && !shownGroups.find(g => g.group === group)) {
      shownGroups.push({ group, layer });
    }
  }

  // Animate a group of paths with draw effect and glow
  function animatePathGroup(group, progress, glowColor, layer) {
    if (!group) return;
    
    // Dim previous layers when starting a new animation
    if (progress < 0.1) {
      dimPreviousLayers();
    }
    
    group.style.opacity = '1';
    registerShownGroup(group, layer);
    
    const updateFilter = shouldUpdateFilter();
    const time = performance.now() * 0.001;
    const paths = group.querySelectorAll('path');
    
    paths.forEach((path, i) => {
      gpuPromote(path);
      const title = path.querySelector('title');
      const isArrow = title && title.textContent === 'Arrow';
      
      if (isArrow) {
        const arrowProgress = Math.max(0, (progress - 0.7) / 0.3);
        path.style.opacity = arrowProgress;
        if (arrowProgress > 0 && updateFilter) {
          const pulse = 0.5 + Math.sin(time * 3) * 0.5;
          const size = Math.round(8 * arrowProgress * (0.7 + pulse * 0.3));
          setFilterCached(path, `drop-shadow(0 0 ${size}px ${glowColor})`);
        }
      } else if (path.dataset.pathLength) {
        const length = parseFloat(path.dataset.pathLength);
        const delay = i * 0.03;
        const localProgress = Math.max(0, Math.min(1, (progress - delay) * 1.2));
        
        // Draw effect (update every frame — cheap)
        path.style.strokeDasharray = length;
        path.style.strokeDashoffset = length * (1 - localProgress);
        path.style.opacity = '1';
        
        // Glow (throttled)
        if (localProgress > 0 && updateFilter) {
          const pulse = 0.5 + Math.sin(time * 2.5 + i * 0.3) * 0.5;
          const g = Math.round((8 + pulse * 12) * localProgress);
          setFilterCached(path, `drop-shadow(0 0 ${g}px ${glowColor})`);
        }
        
        // Switch to CSS animation once draw-in completes
        if (localProgress >= 1 && !path.classList.contains('campus-glow-steady-path')) {
          path.style.setProperty('--glow-color', glowColor);
          path.classList.add('campus-glow-steady-path');
          path.style.filter = ''; // Hand off to CSS
          filterCache.delete(path);
        }
      } else {
        path.style.opacity = progress;
        if (progress > 0 && updateFilter) {
          const pulse = 0.5 + Math.sin(time * 2) * 0.5;
          const size = Math.round(8 * pulse * progress);
          setFilterCached(path, `drop-shadow(0 0 ${size}px ${glowColor})`);
        }
      }
    });
  }

  // Animate markers (circular points) with radiating circles and pulsing glow
  function animateMarkerGroup(group, progress, glowColor, layer) {
    if (!group) return;
    
    // Dim previous layers when starting a new animation
    if (progress < 0.1) {
      dimPreviousLayers();
    }
    
    // Make sure group and all parent groups are visible
    group.style.opacity = '1';
    group.style.visibility = 'visible';
    registerShownGroup(group, layer);
    
    const updateFilter = shouldUpdateFilter();
    const time = performance.now() * 0.001;
    const markers = group.querySelectorAll('path');
    
    if (progress < 0.05) {
      console.log(`animateMarkerGroup: found ${markers.length} markers in group`);
    }
    
    markers.forEach((marker, i) => {
      gpuPromote(marker);
      const delay = i * 0.06;
      const localProgress = Math.max(0, Math.min(1, (progress - delay) * 1.5));
      
      marker.style.visibility = 'visible';
      
      // Pop-in with bounce effect
      const bounce = localProgress < 1 ? 
        Math.sin(localProgress * Math.PI) * 0.2 : 0;
      const baseScale = 0.3 + localProgress * 0.7;
      const pulseScale = 1 + Math.sin(time * 3 + i * 0.5) * 0.08;
      const scale = baseScale * pulseScale + bounce;
      
      marker.style.opacity = localProgress;
      marker.style.transform = `scale(${scale})`;
      marker.style.transformOrigin = 'center';
      marker.style.transformBox = 'fill-box';
      
      if (localProgress > 0 && updateFilter) {
        // Single glow layer — blended to approximate the 3-layer look
        const wave = 0.5 + Math.sin(time * 2.5 + i * 0.4) * 0.5;
        const glowSize = Math.round((10 + wave * 14) * localProgress);
        setFilterCached(marker, `drop-shadow(0 0 ${glowSize}px ${glowColor})`);
      }
      
      // Switch to CSS animation once pop-in completes
      if (localProgress >= 1 && !marker.classList.contains('campus-glow-steady-marker')) {
        marker.style.setProperty('--glow-color', glowColor);
        marker.classList.add('campus-glow-steady-marker');
        marker.style.filter = '';
        filterCache.delete(marker);
      }
    });
  }

  // Animate activity nodes with radiating pulsing circles (replacing asterisks)
  function animateAsterixGroup(group, progress, glowColor, layer) {
    if (!group) return;
    
    // Dim previous layers when starting a new animation
    if (progress < 0.1) {
      dimPreviousLayers();
    }
    
    group.style.opacity = '1';
    group.style.visibility = 'visible';
    registerShownGroup(group, layer);
    
    const time = performance.now() * 0.001;
    
    // Find all asterisk groups (they have title "Asterix")
    const asterixGroups = Array.from(group.querySelectorAll('g')).filter(g => {
      const title = g.querySelector(':scope > title');
      return title && title.textContent === 'Asterix';
    });
    
    if (progress < 0.05) {
      console.log(`animateAsterixGroup: found ${asterixGroups.length} asterix groups`);
    }
    
    asterixGroups.forEach((asterix, i) => {
      const delay = i * 0.12;
      const localProgress = Math.max(0, Math.min(1, (progress - delay) * 1.3));
      
      // Make sure the asterix group itself is visible
      asterix.style.opacity = '1';
      asterix.style.visibility = 'visible';
      
      // Get all paths in this asterisk
      const paths = asterix.querySelectorAll('path, line');
      
      // Hide the original asterisk lines
      paths.forEach(line => {
        line.style.opacity = '0';
      });
      
      // Check if we already added radiating circles
      let circleContainer = asterix.querySelector('.radiating-circles');
      if (!circleContainer) {
        // Create SVG circles for radiating effect
        circleContainer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        circleContainer.setAttribute('class', 'radiating-circles');
        
        // Get center position from the asterisk's bounding box
        // Need to temporarily show paths to get bbox
        let cx = 0, cy = 0;
        try {
          // Get bbox of the whole asterisk group
          const bbox = asterix.getBBox();
          cx = bbox.x + bbox.width / 2;
          cy = bbox.y + bbox.height / 2;
          if (progress < 0.05) {
            console.log(`  Asterix ${i}: center at (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
          }
        } catch (e) {
          // Fallback: try to get from first path
          const firstPath = paths[0];
          if (firstPath) {
            try {
              firstPath.style.opacity = '1'; // Temporarily show to get bbox
              const bbox = firstPath.getBBox();
              cx = bbox.x + bbox.width / 2;
              cy = bbox.y + bbox.height / 2;
              firstPath.style.opacity = '0';
            } catch (e2) {
              console.warn('Could not get asterix bbox:', e2);
            }
          }
        }
        
        // Create multiple concentric circles - larger and more spread out
        // Use warm yellow-gold color to differentiate from orange paths
        const ringColor = '#e6a832'; // Warm golden yellow
        for (let r = 0; r < 5; r++) {
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', cx);
          circle.setAttribute('cy', cy);
          circle.setAttribute('r', 12 + r * 20); // Larger base and spacing
          circle.setAttribute('fill', 'none');
          circle.setAttribute('stroke', ringColor);
          circle.setAttribute('stroke-width', 4 - r * 0.6); // Thicker strokes
          circle.setAttribute('data-ring', r);
          circle.style.opacity = '0';
          circle.style.visibility = 'hidden'; // Start fully hidden
          circleContainer.appendChild(circle);
        }
        
        // Add center dot - larger
        const centerDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        centerDot.setAttribute('cx', cx);
        centerDot.setAttribute('cy', cy);
        centerDot.setAttribute('r', 10); // Larger center dot
        centerDot.setAttribute('fill', ringColor);
        centerDot.setAttribute('data-center', 'true');
        centerDot.style.opacity = '0';
        centerDot.style.visibility = 'hidden'; // Start fully hidden
        circleContainer.appendChild(centerDot);
        
        // Keep the container hidden until animation starts
        circleContainer.style.visibility = 'hidden';
        
        asterix.appendChild(circleContainer);
      }
      
      // Animate the circles
      const circles = circleContainer.querySelectorAll('circle');
      
      // Show the container when animation progresses
      if (localProgress > 0) {
        circleContainer.style.visibility = 'visible';
      }
      
      const updateFilter = shouldUpdateFilter();
      
      circles.forEach((circle) => {
        gpuPromote(circle);
        const ringIndex = circle.getAttribute('data-ring');
        const isCenter = circle.getAttribute('data-center');
        
        if (isCenter) {
          const scale = 1 + Math.sin(time * 0.8 + i * 0.5) * 0.25;
          circle.style.opacity = localProgress;
          circle.style.visibility = localProgress > 0 ? 'visible' : 'hidden';
          circle.style.transform = `scale(${scale})`;
          circle.style.transformOrigin = 'center';
          circle.style.transformBox = 'fill-box';
          
          if (updateFilter) {
            const pulse = 0.7 + Math.sin(time * 1.2 + i) * 0.3;
            const g = Math.round(20 * pulse * localProgress);
            setFilterCached(circle, `drop-shadow(0 0 ${g}px rgba(230, 168, 50, 0.8))`);
          }
          
          // Hand off to CSS once fully visible
          if (localProgress >= 1 && !circle.classList.contains('campus-glow-steady-asterix-center')) {
            circle.classList.add('campus-glow-steady-asterix-center');
            circle.style.filter = '';
            filterCache.delete(circle);
          }
        } else {
          const ringNum = parseInt(ringIndex);
          const wavePhase = (time * 0.6 + ringNum * 0.5 + i * 0.2) % 1;
          const ringOpacity = Math.sin(wavePhase * Math.PI) * 0.9;
          const ringScale = 1 + wavePhase * 0.8;
          
          circle.style.opacity = ringOpacity * localProgress;
          circle.style.visibility = (ringOpacity * localProgress) > 0.01 ? 'visible' : 'hidden';
          circle.style.transform = `scale(${ringScale})`;
          circle.style.transformOrigin = 'center';
          circle.style.transformBox = 'fill-box';
          
          if (updateFilter) {
            const glowSize = Math.round((10 + (1 - wavePhase) * 25) * localProgress);
            setFilterCached(circle, `drop-shadow(0 0 ${glowSize}px rgba(230, 168, 50, 0.7))`);
          }
        }
      });
    });
  }

  function animateBoundary(progress) {
    const layer = svgDoc?.getElementById('projektgräns');
    if (!layer) return;

    // Dim previous layers when starting
    if (progress < 0.1) {
      dimPreviousLayers();
    }

    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    registerShownGroup(layer, layer);
    
    const path = layer.querySelector('path');
    if (path) {
      gpuPromote(path);
      if (!path.dataset.pathLength && path.getTotalLength) {
        path.dataset.pathLength = path.getTotalLength();
      }
      
      if (path.dataset.pathLength) {
        const length = parseFloat(path.dataset.pathLength);
        const drawProgress = Math.min(1, progress * 1.2);
        const time = performance.now() * 0.001;
        
        path.style.opacity = '1';
        path.style.strokeWidth = '5';
        
        // Color shift (throttled — only recalc on filter frames)
        if (shouldUpdateFilter()) {
          const hue = 230 + Math.sin(time * 0.8) * 25;
          path.style.stroke = `hsl(${hue}, 50%, 70%)`;
          
          // Single glow layer during draw-in
          if (!path.classList.contains('campus-glow-steady-boundary')) {
            const glowPulse = 0.5 + Math.sin(time * 2.5 * Math.PI) * 0.5;
            const g = Math.round(10 + glowPulse * 20);
            setFilterCached(path, `drop-shadow(0 0 ${g}px rgba(200, 200, 255, 0.85))`);
          }
        }
        
        // Dash pattern settings
        const dashLength = 25;
        const gapLength = 18;
        const patternLength = dashLength + gapLength;
        const marchOffset = (time * 60) % patternLength;
        
        const drawnLength = length * drawProgress;
        
        if (drawProgress < 1) {
          path.style.strokeDasharray = `${drawnLength}, ${length}`;
          path.style.strokeDashoffset = 0;
        } else {
          path.style.strokeDasharray = `${dashLength}, ${gapLength}`;
          path.style.strokeDashoffset = -marchOffset;
          
          // Hand off glow to CSS once fully drawn
          if (!path.classList.contains('campus-glow-steady-boundary')) {
            path.classList.add('campus-glow-steady-boundary');
            path.style.filter = '';
            filterCache.delete(path);
          }
        }
      }
    }
  }

  function animateLivingPrimary(progress) {
    const layer = svgDoc?.getElementById('LEVANDE-CAMPUS');
    if (!layer) return;
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    const primaryGroup = findGroupByTitle(layer, '01_Primary Path');
    animatePathGroup(primaryGroup, progress, 'rgba(219, 87, 19, 0.8)', layer);
  }

  function animateLivingSecondary(progress) {
    const layer = svgDoc?.getElementById('LEVANDE-CAMPUS');
    if (!layer) return;
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    const secondaryGroup = findGroupByTitle(layer, '02_Secondary Path');
    animatePathGroup(secondaryGroup, progress, 'rgba(219, 87, 19, 0.6)', layer);
  }

  function animateLivingPoints(progress) {
    const layer = svgDoc?.getElementById('LEVANDE-CAMPUS');
    if (!layer) return;
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    const pointsGroup = findGroupByTitle(layer, '03_Points');
    animateMarkerGroup(pointsGroup, progress, 'rgba(237, 192, 6, 0.9)', layer);
  }

  function animateLivingAsterix(progress) {
    const layer = svgDoc?.getElementById('LEVANDE-CAMPUS');
    if (!layer) return;
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    const asterixGroup = findGroupByTitle(layer, '04_Asterix');
    animateAsterixGroup(asterixGroup, progress, 'rgba(230, 168, 50, 0.8)', layer);
  }

  function animateHealthPrimary(progress) {
    const layer = svgDoc?.getElementById('HÄLSOFRÄMJANDE-CAMPUS');
    if (!layer) return;
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    const primaryGroup = findGroupByTitle(layer, '01_Primary Path');
    animatePathGroup(primaryGroup, progress, 'rgba(86, 130, 0, 0.8)', layer);
  }

  function animateHealthSecondary(progress) {
    const layer = svgDoc?.getElementById('HÄLSOFRÄMJANDE-CAMPUS');
    if (!layer) return;
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    const secondaryGroup = findGroupByTitle(layer, '02_Secondary Path');
    animatePathGroup(secondaryGroup, progress, 'rgba(86, 130, 0, 0.6)', layer);
  }

  function animateHealthTertiary(progress) {
    const layer = svgDoc?.getElementById('HÄLSOFRÄMJANDE-CAMPUS');
    if (!layer) return;
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    const tertiaryGroup = findGroupByTitle(layer, '03_Tertiary Path');
    animatePathGroup(tertiaryGroup, progress, 'rgba(226, 144, 77, 0.7)', layer);
  }

  function animateHealthPoints(progress) {
    const layer = svgDoc?.getElementById('HÄLSOFRÄMJANDE-CAMPUS');
    if (!layer) {
      console.warn('Campus Demo: Health layer not found!');
      return;
    }
    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    
    // Debug: log at start of phase
    if (progress < 0.05) {
      console.log('Campus Demo: animateHealthPoints starting');
      console.log('  Layer found:', layer.id);
    }
    
    const pointsGroup = findGroupByTitle(layer, '04_Points');
    if (!pointsGroup) {
      // Try to find by id as fallback
      const fallback = layer.querySelector('#object-0');
      if (fallback) {
        if (progress < 0.05) console.log('Campus Demo: Using fallback #object-0 for health points');
        animateMarkerGroup(fallback, progress, 'rgba(183, 179, 99, 0.8)', layer);
      } else {
        console.warn('Campus Demo: Health points group not found by title or id!');
      }
      return;
    }
    if (progress < 0.05) console.log('Campus Demo: Found health points group:', pointsGroup.id || '(no id)');
    animateMarkerGroup(pointsGroup, progress, 'rgba(183, 179, 99, 0.8)', layer);
  }

  function animateGreenSpaces(progress) {
    const layer = svgDoc?.getElementById('Gröna-mötesplatser');
    if (!layer) return;

    // Dim previous layers when starting
    if (progress < 0.1) {
      dimPreviousLayers();
    }

    layer.style.opacity = '1';
    layer.style.visibility = 'visible';
    registerShownGroup(layer, layer);

    const updateFilter = shouldUpdateFilter();
    const time = performance.now() * 0.001;
    const blobs = layer.querySelectorAll('path');
    
    blobs.forEach((blob, i) => {
      gpuPromote(blob);
      const delay = i * 0.08;
      const localProgress = Math.max(0, Math.min(1, (progress - delay) * 1.5));
      
      // Breathing scale animation
      const breatheCycle = Math.sin(time * 0.6 + i * 0.5) * 0.5 + 0.5;
      const breatheScale = 1 + breatheCycle * 0.08;
      const scale = localProgress * breatheScale;
      const opacity = localProgress * (0.75 + breatheCycle * 0.15);
      
      blob.style.opacity = opacity;
      blob.style.transform = `scale(${scale})`;
      blob.style.transformOrigin = 'center';
      blob.style.transformBox = 'fill-box';
      
      // Single glow layer (throttled)
      if (updateFilter) {
        const glowBreath = Math.sin(time * 0.6 + i * 0.5) * 0.5 + 0.5;
        const glowSize = Math.round((10 + glowBreath * 16) * localProgress);
        const glowOpacity = (0.5 + glowBreath * 0.4).toFixed(2);
        setFilterCached(blob, `drop-shadow(0 0 ${glowSize}px rgba(140, 186, 99, ${glowOpacity}))`);
      }
      
      // Hand off to CSS once fully faded in
      if (localProgress >= 1 && !blob.classList.contains('campus-glow-steady-green')) {
        blob.classList.add('campus-glow-steady-green');
        blob.style.filter = '';
        filterCache.delete(blob);
      }
    });
  }

  function animateHold(progress) {
    // All phases complete — CSS keyframes handle the steady-state glow.
    // Only do minimal ambient work here (no per-element filter updates).
  }

  function animate(timestamp) {
    if (!active || !svgDoc) return;

    frameCount++;

    // If no phase selected yet, just keep the loop running
    if (animationPhase < 0) {
      rafId = requestAnimationFrame(animate);
      return;
    }

    const currentPhase = PHASES[animationPhase];
    if (!currentPhase) {
      // All phases complete, just do ambient animation
      animateHold(0);
      rafId = requestAnimationFrame(animate);
      return;
    }

    const elapsed = timestamp - phaseStartTime;
    const progress = Math.min(1, elapsed / currentPhase.duration);

    // Run appropriate animation based on phase
    switch (currentPhase.name) {
      case 'boundary':
        animateBoundary(progress);
        break;
      case 'living-primary':
        animateLivingPrimary(progress);
        break;
      case 'living-secondary':
        animateLivingSecondary(progress);
        break;
      case 'living-points':
        animateLivingPoints(progress);
        break;
      case 'living-asterix':
        animateLivingAsterix(progress);
        break;
      case 'health-primary':
        animateHealthPrimary(progress);
        break;
      case 'health-secondary':
        animateHealthSecondary(progress);
        break;
      case 'health-tertiary':
        animateHealthTertiary(progress);
        break;
      case 'health-points':
        animateHealthPoints(progress);
        break;
      case 'green-spaces':
        animateGreenSpaces(progress);
        break;
    }

    // Mark phase as complete when animation finishes
    if (progress >= 1) {
      phaseComplete = true;
      
      // Auto-advance to next phase if auto-play is active
      if (autoPlayActive && animationPhase < PHASES.length - 1) {
        nextPhase();
      } else if (autoPlayActive && animationPhase >= PHASES.length - 1) {
        // Reached the end — stop auto-play
        autoPlayActive = false;
        updatePhaseIndicator();
        channel.postMessage({ type: 'campus_demo_autoplay', active: false });
      }
    }

    // Continue animation loop (for glow effects etc)
    rafId = requestAnimationFrame(animate);
  }

  function toggleAutoPlay() {
    if (!active) return;
    autoPlayActive = !autoPlayActive;
    console.log(`Campus Demo: Auto-play ${autoPlayActive ? 'ON' : 'OFF'}`);
    
    if (autoPlayActive) {
      // If we haven't started yet, kick off the first phase
      if (animationPhase < 0) {
        nextPhase();
      } else if (phaseComplete && animationPhase < PHASES.length - 1) {
        // Current phase already done, advance immediately
        nextPhase();
      }
    }
    
    updatePhaseIndicator();
    channel.postMessage({ type: 'campus_demo_autoplay', active: autoPlayActive });
  }

  function nextPhase() {
    if (!active || !svgDoc) return;
    
    if (animationPhase < PHASES.length - 1) {
      animationPhase++;
      phaseStartTime = performance.now();
      phaseComplete = false;
      updatePhaseIndicator();
      // Broadcast phase update to controller
      channel.postMessage({ 
        type: 'campus_demo_phase', 
        phase: PHASES[animationPhase].name,
        phaseIndex: animationPhase,
        totalPhases: PHASES.length,
        label: PHASES[animationPhase].label
      });
      console.log(`Campus Demo: Starting phase "${PHASES[animationPhase].name}"`);
    }
  }

  function prevPhase() {
    if (!active || !svgDoc) return;
    
    if (animationPhase > 0) {
      // Need to reset and replay up to the previous phase
      const targetPhase = animationPhase - 1;
      resetAllLayers();
      animationPhase = -1;
      
      // Replay all phases up to target (instantly complete them)
      for (let i = 0; i <= targetPhase; i++) {
        animationPhase = i;
        phaseStartTime = performance.now() - PHASES[i].duration - 100; // Force complete
        // Run one frame to complete the phase
        const phase = PHASES[i];
        switch (phase.name) {
          case 'boundary': animateBoundary(1); break;
          case 'living-primary': animateLivingPrimary(1); break;
          case 'living-secondary': animateLivingSecondary(1); break;
          case 'living-points': animateLivingPoints(1); break;
          case 'living-asterix': animateLivingAsterix(1); break;
          case 'health-primary': animateHealthPrimary(1); break;
          case 'health-secondary': animateHealthSecondary(1); break;
          case 'health-tertiary': animateHealthTertiary(1); break;
          case 'health-points': animateHealthPoints(1); break;
          case 'green-spaces': animateGreenSpaces(1); break;
        }
      }
      
      phaseComplete = true;
      updatePhaseIndicator();
      // Broadcast phase update to controller
      channel.postMessage({ 
        type: 'campus_demo_phase', 
        phase: PHASES[animationPhase].name,
        phaseIndex: animationPhase,
        totalPhases: PHASES.length,
        label: PHASES[animationPhase].label
      });
      console.log(`Campus Demo: Back to phase "${PHASES[animationPhase].name}"`);
    } else if (animationPhase === 0) {
      // Go back to initial state
      resetAllLayers();
      animationPhase = -1;
      phaseComplete = false;
      updatePhaseIndicator();
    }
  }

  function resetAllLayers() {
    if (!svgDoc) return;
    
    // Clear tracking array
    shownGroups.length = 0;
    
    // Hide all main layers
    svgDoc.querySelectorAll('g[id]').forEach(layer => {
      layer.style.opacity = '0';
      layer.style.visibility = 'hidden';
    });
    
    // Reset all paths, lines, and circles
    svgDoc.querySelectorAll('path, line, circle').forEach(el => {
      // Reset route paths dashoffset
      if (el.dataset.isRoute === 'true' && el.dataset.pathLength) {
        el.style.strokeDashoffset = el.dataset.pathLength;
      }
      el.style.opacity = '0';
      el.style.filter = '';
      el.style.transform = '';
      el.style.willChange = '';
      delete el.dataset.gpuPromoted;
      // Remove CSS glow classes so JS can re-drive draw-in
      el.classList.remove(
        'campus-glow-steady-boundary',
        'campus-glow-steady-path',
        'campus-glow-steady-marker',
        'campus-glow-steady-green',
        'campus-glow-steady-asterix-center'
      );
      filterCache.delete(el);
    });
    
    // Reset nested groups in green spaces
    const greenLayer = svgDoc.getElementById('Gröna-mötesplatser');
    if (greenLayer) {
      greenLayer.querySelectorAll('g').forEach(g => {
        g.style.opacity = '0';
      });
    }
  }

  function handleKeydown(e) {
    if (!active) return;
    
    if (e.key === ' ') {
      e.preventDefault();
      toggleAutoPlay();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextPhase();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prevPhase();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stop();
    }
  }

  async function start() {
    if (active) return;
    active = true;

    // Stop competing visualizations
    try {
      if (window.streetLifeAnimation && typeof window.streetLifeAnimation.isActive === 'function') {
        prevStreetLifeActive = !!window.streetLifeAnimation.isActive();
        if (prevStreetLifeActive && typeof window.streetLifeAnimation.stop === 'function') {
          window.streetLifeAnimation.stop();
        }
      }
    } catch (e) {
      console.warn('Campus Demo: error checking/stopping streetLife:', e);
    }

    try {
      if (window.trafikAnimation && typeof window.trafikAnimation.isActive === 'function') {
        prevTrafikActive = !!window.trafikAnimation.isActive();
        if (prevTrafikActive && typeof window.trafikAnimation.stop === 'function') {
          window.trafikAnimation.stop();
        }
      }
    } catch (e) {
      console.warn('Campus Demo: error checking/stopping trafik:', e);
    }

    // Force-hide canvases
    try {
      const sCanvas = document.getElementById('street-life-canvas');
      if (sCanvas) sCanvas.style.display = 'none';
    } catch (e) {}
    try {
      const tCanvas = document.getElementById('trafik-canvas');
      if (tCanvas) tCanvas.style.display = 'none';
    } catch (e) {}

    // Highlight button
    try {
      const btn = document.querySelector('[data-target="campus-demo-btn"]');
      if (btn) btn.classList.add('active');
    } catch (e) {}

    createContainer();
    await loadSVG();
    
    // Inject CSS keyframe animations for steady-state glow
    injectGlowStyles();
    
    // Add buildings overlay on map
    await addBuildingsOverlay();

    // Reset animation state
    animationPhase = -1; // Start before first phase
    phaseStartTime = performance.now();
    phaseComplete = false;
    frameCount = 0;

    // Reset all layers to hidden
    resetAllLayers();

    // Create phase indicator
    createPhaseIndicator();

    // Create position controls (only if enabled for calibration)
    if (SHOW_POSITION_CONTROLS) {
      createPositionControls();
    } else {
      // Still load saved transform and apply it
      loadSavedTransform();
      applyTransform();
    }

    // Add keyboard listeners
    document.addEventListener('keydown', handleKeydown);
    if (SHOW_POSITION_CONTROLS) {
      document.addEventListener('keydown', handlePositionKeydown);
    }

    channel.postMessage({ type: 'animation_state', animationId: 'campus-demo-btn', isActive: true });
    rafId = requestAnimationFrame(animate);
    console.log('Campus Demo: Started - Press → to advance');
  }

  function stop() {
    if (!active) return;
    active = false;
    autoPlayActive = false;
    
    channel.postMessage({ type: 'animation_state', animationId: 'campus-demo-btn', isActive: false });
    
    // Remove keyboard listeners
    document.removeEventListener('keydown', handleKeydown);
    if (SHOW_POSITION_CONTROLS) {
      document.removeEventListener('keydown', handlePositionKeydown);
    }
    
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    // Remove phase indicator
    removePhaseIndicator();

    // Remove position controls
    removePositionControls();

    // Remove buildings overlay
    removeBuildingsOverlay();

    // Remove container and SVG
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
      container = null;
      svgDoc = null;
      svgLoaded = false;
    }

    // Remove button highlight
    try {
      const btn = document.querySelector('[data-target="campus-demo-btn"]');
      if (btn) btn.classList.remove('active');
    } catch (e) {}

    // Restore previous visualizations
    try {
      if (prevStreetLifeActive && window.streetLifeAnimation && typeof window.streetLifeAnimation.start === 'function') {
        window.streetLifeAnimation.start();
      }
    } catch (e) {
      console.warn('Campus Demo: error restarting streetLife:', e);
    }

    try {
      if (prevTrafikActive && window.trafikAnimation && typeof window.trafikAnimation.start === 'function') {
        window.trafikAnimation.start();
      }
    } catch (e) {
      console.warn('Campus Demo: error restarting trafik:', e);
    }

    prevStreetLifeActive = false;
    prevTrafikActive = false;
    console.log('Campus Demo: Stopped');
  }

  function toggle() {
    if (active) stop(); else start();
  }

  // Respond to control actions
  channel.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.type === 'control_action' && d.target === 'campus-demo-btn') {
      if (d.action === 'click') toggle();
    }
    // Handle keyboard controls from controller
    if (d.type === 'campus_demo_control') {
      if (d.action === 'next') {
        nextPhase();
      } else if (d.action === 'previous') {
        prevPhase();
      } else if (d.action === 'autoplay') {
        toggleAutoPlay();
      } else if (d.action === 'stop') {
        stop();
      }
    }
  };

  // Wire up button if present
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('[data-target="campus-demo-btn"]');
    if (btn) btn.addEventListener('click', toggle);
  });

  console.log('Campus Demo: Module loaded');
})();
