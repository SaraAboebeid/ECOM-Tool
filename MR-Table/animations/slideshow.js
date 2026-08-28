// ===== Slideshow Animation System =====
// Display image/video/gif/geojson media with transitions and metadata

const slideshowCanvas = document.getElementById('slideshow-canvas');
const slideshowCtx = slideshowCanvas ? slideshowCanvas.getContext('2d') : null;
const slideshowBtn = document.getElementById('slideshow-btn');
const slideshowMetadata = document.getElementById('slideshow-metadata');

// BroadcastChannel for controller communication
const slideshowChannel = new BroadcastChannel('map_controller_channel');

// Slideshow state
let slideshowConfig = null;
let currentSlideIndex = 0;
let isSlideShowActive = false;
let slideshowTimer = null;
let currentMediaElement = null;
let currentMediaRotation = 0; // Track rotation of current media
let currentMediaFitMode = 'contain'; // Track fitMode of current media
let transitionProgress = 0;
let transitionAnimationFrame = null;

// Media cache
const mediaCache = new Map();

// Config path
const SLIDESHOW_CONFIG_PATH = 'media/slideshow/slideshow-config.json';
const SLIDESHOW_MEDIA_PATH = 'media/slideshow/';

// Load slideshow configuration
async function loadSlideshowConfig() {
  try {
    const response = await fetch(SLIDESHOW_CONFIG_PATH);
    if (!response.ok) {
      console.warn('Slideshow config not found. Using default empty config.');
      return { slides: [], settings: { loop: true, autoAdvance: true, showMetadata: true, metadataPosition: 'bottom-right', fitMode: 'contain' } };
    }
    const config = await response.json();
    return config;
  } catch (error) {
    console.error('Error loading slideshow config:', error);
    return { slides: [], settings: { loop: true, autoAdvance: true, showMetadata: true, metadataPosition: 'bottom-right', fitMode: 'contain' } };
  }
}

// Resize slideshow canvas to match table overlay
function resizeSlideshowCanvas() {
  if (!slideshowCanvas) return;
  const s = computeOverlayPixelSize();
  slideshowCanvas.width = s.w;
  slideshowCanvas.height = s.h;
  slideshowCanvas.style.width = s.w + 'px';
  slideshowCanvas.style.height = s.h + 'px';
}

// Preload media
async function preloadMedia(slide) {
  const mediaPath = SLIDESHOW_MEDIA_PATH + slide.media;
  
  if (mediaCache.has(mediaPath)) {
    return mediaCache.get(mediaPath);
  }
  
  if (slide.type === 'image' || slide.type === 'gif') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        mediaCache.set(mediaPath, img);
        resolve(img);
      };
      img.onerror = () => reject(new Error(`Failed to load image: ${mediaPath}`));
      img.src = mediaPath;
    });
  } else if (slide.type === 'video') {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.onloadeddata = () => {
        mediaCache.set(mediaPath, video);
        resolve(video);
      };
      video.onerror = () => reject(new Error(`Failed to load video: ${mediaPath}`));
      video.src = mediaPath;
    });
  } else if (slide.type === 'geojson') {
    try {
      const response = await fetch(mediaPath);
      const geojson = await response.json();
      mediaCache.set(mediaPath, geojson);
      return geojson;
    } catch (error) {
      throw new Error(`Failed to load GeoJSON: ${mediaPath}`);
    }
  }
}

// Draw image/video on canvas with fit mode and optional rotation
function drawMediaOnCanvas(media, fitMode = 'contain', rotation = 0) {
  if (!slideshowCtx) return;
  
  const canvasWidth = slideshowCanvas.width;
  const canvasHeight = slideshowCanvas.height;
  
  let mediaWidth, mediaHeight;
  
  if (media instanceof HTMLVideoElement) {
    mediaWidth = media.videoWidth;
    mediaHeight = media.videoHeight;
  } else {
    mediaWidth = media.width;
    mediaHeight = media.height;
  }
  
  if (!mediaWidth || !mediaHeight) return;
  
  // If rotating 90 or 270 degrees, swap dimensions for aspect ratio calculation
  const rotatedDimensions = (rotation === 90 || rotation === 270);
  const effectiveMediaWidth = rotatedDimensions ? mediaHeight : mediaWidth;
  const effectiveMediaHeight = rotatedDimensions ? mediaWidth : mediaHeight;
  
  let drawWidth, drawHeight, drawX, drawY;
  
  if (fitMode === 'contain') {
    // Scale to fit inside canvas while maintaining aspect ratio
    const scale = Math.min(canvasWidth / effectiveMediaWidth, canvasHeight / effectiveMediaHeight);
    drawWidth = effectiveMediaWidth * scale;
    drawHeight = effectiveMediaHeight * scale;
    drawX = (canvasWidth - drawWidth) / 2;
    drawY = (canvasHeight - drawHeight) / 2;
  } else if (fitMode === 'cover') {
    // Scale to cover entire canvas while maintaining aspect ratio
    const scale = Math.max(canvasWidth / effectiveMediaWidth, canvasHeight / effectiveMediaHeight);
    drawWidth = effectiveMediaWidth * scale;
    drawHeight = effectiveMediaHeight * scale;
    drawX = (canvasWidth - drawWidth) / 2;
    drawY = (canvasHeight - drawHeight) / 2;
  } else {
    // Stretch to fill canvas
    drawWidth = canvasWidth;
    drawHeight = canvasHeight;
    drawX = 0;
    drawY = 0;
  }
  
  slideshowCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  
  // Apply rotation if needed
  if (rotation !== 0) {
    slideshowCtx.save();
    
    // Move to center of where the image will be drawn
    const centerX = drawX + drawWidth / 2;
    const centerY = drawY + drawHeight / 2;
    
    slideshowCtx.translate(centerX, centerY);
    slideshowCtx.rotate((rotation * Math.PI) / 180);
    
    // For 90/270 degree rotations, we need to adjust the drawing rectangle
    // because the image dimensions are swapped
    if (rotatedDimensions) {
      slideshowCtx.drawImage(media, -drawHeight / 2, -drawWidth / 2, drawHeight, drawWidth);
    } else {
      slideshowCtx.drawImage(media, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    }
    
    slideshowCtx.restore();
  } else {
    slideshowCtx.drawImage(media, drawX, drawY, drawWidth, drawHeight);
  }
}

// Apply transition effect
function applyTransition(oldMedia, newMedia, progress, transitionType, oldRotation = 0, newRotation = 0, oldFitMode = 'contain', newFitMode = 'contain') {
  if (!slideshowCtx) return;
  
  const canvasWidth = slideshowCanvas.width;
  const canvasHeight = slideshowCanvas.height;
  
  slideshowCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  
  switch (transitionType) {
    case 'fade':
      if (oldMedia) {
        slideshowCtx.globalAlpha = 1 - progress;
        drawMediaOnCanvas(oldMedia, oldFitMode, oldRotation);
      }
      if (newMedia) {
        slideshowCtx.globalAlpha = progress;
        drawMediaOnCanvas(newMedia, newFitMode, newRotation);
      }
      slideshowCtx.globalAlpha = 1;
      break;
      
    case 'slide-left':
      if (oldMedia) {
        slideshowCtx.save();
        slideshowCtx.translate(-canvasWidth * progress, 0);
        drawMediaOnCanvas(oldMedia, oldFitMode, oldRotation);
        slideshowCtx.restore();
      }
      if (newMedia) {
        slideshowCtx.save();
        slideshowCtx.translate(canvasWidth * (1 - progress), 0);
        drawMediaOnCanvas(newMedia, newFitMode, newRotation);
        slideshowCtx.restore();
      }
      break;
      
    case 'slide-right':
      if (oldMedia) {
        slideshowCtx.save();
        slideshowCtx.translate(canvasWidth * progress, 0);
        drawMediaOnCanvas(oldMedia, oldFitMode, oldRotation);
        slideshowCtx.restore();
      }
      if (newMedia) {
        slideshowCtx.save();
        slideshowCtx.translate(-canvasWidth * (1 - progress), 0);
        drawMediaOnCanvas(newMedia, newFitMode, newRotation);
        slideshowCtx.restore();
      }
      break;
      
    case 'zoom':
      if (oldMedia) {
        const scale = 1 + progress * 0.5;
        slideshowCtx.globalAlpha = 1 - progress;
        slideshowCtx.save();
        slideshowCtx.translate(canvasWidth / 2, canvasHeight / 2);
        slideshowCtx.scale(scale, scale);
        slideshowCtx.translate(-canvasWidth / 2, -canvasHeight / 2);
        drawMediaOnCanvas(oldMedia, oldFitMode, oldRotation);
        slideshowCtx.restore();
        slideshowCtx.globalAlpha = 1;
      }
      if (newMedia) {
        const scale = 0.5 + progress * 0.5;
        slideshowCtx.globalAlpha = progress;
        slideshowCtx.save();
        slideshowCtx.translate(canvasWidth / 2, canvasHeight / 2);
        slideshowCtx.scale(scale, scale);
        slideshowCtx.translate(-canvasWidth / 2, -canvasHeight / 2);
        drawMediaOnCanvas(newMedia, newFitMode, newRotation);
        slideshowCtx.restore();
        slideshowCtx.globalAlpha = 1;
      }
      break;
      
    default: // instant
      if (newMedia) {
        drawMediaOnCanvas(newMedia, newFitMode, newRotation);
      }
  }
}

// Animate transition
function animateTransition(oldMedia, newMedia, transitionType, duration = 500, oldRotation = 0, newRotation = 0, oldFitMode = 'contain', newFitMode = 'contain') {
  return new Promise((resolve) => {
    const startTime = performance.now();
    
    function animate(currentTime) {
      const elapsed = currentTime - startTime;
      transitionProgress = Math.min(elapsed / duration, 1);
      
      applyTransition(oldMedia, newMedia, transitionProgress, transitionType, oldRotation, newRotation, oldFitMode, newFitMode);
      
      if (transitionProgress < 1) {
        transitionAnimationFrame = requestAnimationFrame(animate);
      } else {
        resolve();
      }
    }
    
    transitionAnimationFrame = requestAnimationFrame(animate);
  });
}

// Display metadata
function displayMetadata(slide, highlightValue = null) {
  // Hide metadata overlay in main window - it's now shown in controller
  if (slideshowMetadata) {
    slideshowMetadata.style.display = 'none';
  }
  
  // Still broadcast to controller
  broadcastSlideshowState(slide);
}

// Broadcast slideshow state to controller window
function broadcastSlideshowState(slide) {
  // Allow broadcasting even if config is missing (e.g. during loading or error)
  const total = slideshowConfig && slideshowConfig.slides ? slideshowConfig.slides.length : 0;
  
  slideshowChannel.postMessage({
    type: 'slideshow_update',
    isActive: isSlideShowActive,
    currentIndex: currentSlideIndex,
    totalSlides: total,
    metadata: slide?.metadata || null,
    slideType: slide?.type || null
  });
}

// Update legend to highlight current attribute - broadcasts to controller only
function highlightLegendItem(slide, propertyValue) {
  // Broadcast highlight state to controller
  slideshowChannel.postMessage({
    type: 'slideshow_legend_highlight',
    highlightValue: propertyValue
  });
}

// GeoJSON animation state
let geojsonAnimationFrame = null;
let geojsonAnimationActive = false;

// Extract unique values for a property from GeoJSON
function getUniquePropertyValues(geojson, propertyName) {
  const values = new Set();
  if (geojson.features) {
    geojson.features.forEach(feature => {
      const value = feature.properties?.[propertyName];
      if (value !== undefined && value !== null) {
        values.add(value);
      }
    });
  }
  return Array.from(values);
}

// Animate GeoJSON by sequentially highlighting each unique attribute value
async function animateGeoJSONByProperty(geojson, slide) {
  const style = slide.metadata?.style || {};
  const colorProperty = style.colorProperty;
  
  if (!colorProperty || !style.colorMap) {
    // No property-based animation, just display normally
    return;
  }
  
  geojsonAnimationActive = true;
  const uniqueValues = Object.keys(style.colorMap);
  
  // Animation parameters
  const glowDuration = 800; // Duration of glow effect in ms
  const fillDuration = 400; // Duration of fill effect in ms
  const pauseBetween = 200; // Pause between attributes
  
  for (let i = 0; i < uniqueValues.length && geojsonAnimationActive; i++) {
    const value = uniqueValues[i];
    const color = style.colorMap[value];
    
    // Highlight current legend item
    highlightLegendItem(slide, value);
    
    // Phase 1: Intense glow outline
    await animateGlow(value, color, glowDuration, colorProperty);
    
    // Phase 2: Fill/stroke appears
    if (geojsonAnimationActive) {
      await animateFill(value, color, fillDuration, colorProperty, style.fillOpacity || 0.5, style.strokeOpacity || 0.8, uniqueValues, style.colorMap);
    }
    
    // Small pause before next attribute
    if (i < uniqueValues.length - 1 && geojsonAnimationActive) {
      await new Promise(resolve => setTimeout(resolve, pauseBetween));
    }
  }
  
  // Broadcast clear highlight to controller
  slideshowChannel.postMessage({
    type: 'slideshow_legend_highlight',
    highlightValue: null
  });
  
  // Return true if animation completed successfully
  return geojsonAnimationActive;
}

// Animate glowing outline for a specific property value
function animateGlow(propertyValue, color, duration, propertyName) {
  return new Promise((resolve) => {
    const startTime = performance.now();
    
    // Add glow layer if it doesn't exist
    if (!map.getLayer('slideshow-glow')) {
      map.addLayer({
        id: 'slideshow-glow',
        type: 'line',
        source: 'slideshow-geojson',
        paint: {
          'line-color': color,
          'line-width': 0,
          'line-blur': 0,
          'line-opacity': 0
        }
      });
    }
    
    function animate(currentTime) {
      if (!geojsonAnimationActive) {
        resolve();
        return;
      }
      
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Glow effect: pulse from 0 to max and back
      const glowProgress = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
      const maxWidth = 8;
      const maxBlur = 10;
      const maxOpacity = 1;
      
      map.setPaintProperty('slideshow-glow', 'line-width', glowProgress * maxWidth);
      map.setPaintProperty('slideshow-glow', 'line-blur', glowProgress * maxBlur);
      map.setPaintProperty('slideshow-glow', 'line-opacity', glowProgress * maxOpacity);
      map.setPaintProperty('slideshow-glow', 'line-color', color);
      map.setFilter('slideshow-glow', ['==', ['get', propertyName], propertyValue]);
      
      if (progress < 1) {
        geojsonAnimationFrame = requestAnimationFrame(animate);
      } else {
        resolve();
      }
    }
    
    geojsonAnimationFrame = requestAnimationFrame(animate);
  });
}

// Animate fill/stroke for a specific property value
function animateFill(propertyValue, color, duration, propertyName, targetFillOpacity, targetStrokeOpacity, allValues, colorMap) {
  return new Promise((resolve) => {
    const startTime = performance.now();
    const currentIndex = allValues.indexOf(propertyValue);
    const previousValues = allValues.slice(0, currentIndex);
    
    function animate(currentTime) {
      if (!geojsonAnimationActive) {
        resolve();
        return;
      }
      
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Show all values up to and including current one
      const visibleValues = allValues.slice(0, currentIndex + 1);
      
      // Build match expression with opacity per feature for fills
      const fillOpacityExpression = ['match', ['get', propertyName]];
      previousValues.forEach(val => {
        fillOpacityExpression.push(val, targetFillOpacity);
      });
      const currentFillOpacity = progress * targetFillOpacity;
      fillOpacityExpression.push(propertyValue, currentFillOpacity);
      fillOpacityExpression.push(0);
      
      // Build match expression with opacity per feature for lines/strokes
      const strokeOpacityExpression = ['match', ['get', propertyName]];
      previousValues.forEach(val => {
        strokeOpacityExpression.push(val, targetStrokeOpacity);
      });
      const currentStrokeOpacity = progress * targetStrokeOpacity;
      strokeOpacityExpression.push(propertyValue, currentStrokeOpacity);
      strokeOpacityExpression.push(0);
      
      // Build color match expression
      const colorExpression = ['match', ['get', propertyName]];
      visibleValues.forEach(val => {
        colorExpression.push(val, colorMap[val]);
      });
      colorExpression.push('#cccccc'); // default color
      
      const multiFilter = ['any', ...visibleValues.map(v => ['==', ['get', propertyName], v])];
      
      // Update fill layer (for polygons)
      if (map.getLayer('slideshow-fill')) {
        map.setFilter('slideshow-fill', ['all', ['==', ['geometry-type'], 'Polygon'], multiFilter]);
        map.setPaintProperty('slideshow-fill', 'fill-opacity', fillOpacityExpression);
        map.setPaintProperty('slideshow-fill', 'fill-color', colorExpression);
      }
      
      // Update line layer (for LineStrings like streets)
      if (map.getLayer('slideshow-line')) {
        map.setFilter('slideshow-line', ['all', ['==', ['geometry-type'], 'LineString'], multiFilter]);
        map.setPaintProperty('slideshow-line', 'line-opacity', strokeOpacityExpression);
        map.setPaintProperty('slideshow-line', 'line-color', colorExpression);
      }
      
      if (progress < 1) {
        geojsonAnimationFrame = requestAnimationFrame(animate);
      } else {
        resolve();
      }
    }
    
    geojsonAnimationFrame = requestAnimationFrame(animate);
  });
}

// Stop GeoJSON animation
function stopGeoJSONAnimation() {
  geojsonAnimationActive = false;
  if (geojsonAnimationFrame) {
    cancelAnimationFrame(geojsonAnimationFrame);
    geojsonAnimationFrame = null;
  }
  
  // Remove glow layer
  if (map.getLayer('slideshow-glow')) {
    map.removeLayer('slideshow-glow');
  }
}

// Remove all slideshow GeoJSON layers from the map
function removeGeoJSONLayers() {
  stopGeoJSONAnimation();
  
  if (map.getSource('slideshow-geojson')) {
    ['slideshow-fill', 'slideshow-line', 'slideshow-polygon-outline', 'slideshow-point', 'slideshow-glow'].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    map.removeSource('slideshow-geojson');
  }
}

// Handle GeoJSON display
async function displayGeoJSON(geojson, slide) {
  // Stop any ongoing animation
  stopGeoJSONAnimation();
  
  // Remove previous slideshow GeoJSON layers
  if (map.getSource('slideshow-geojson')) {
    ['slideshow-fill', 'slideshow-line', 'slideshow-polygon-outline', 'slideshow-point', 'slideshow-glow'].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    map.removeSource('slideshow-geojson');
  }
  
  // Add new GeoJSON layer
  map.addSource('slideshow-geojson', { type: 'geojson', data: geojson });
  
  // Get style from metadata or use defaults
  const style = slide.metadata?.style || {};
  const fillOpacity = style.fillOpacity || 0.4;
  const strokeWidth = style.strokeWidth || 2;
  const pointRadius = style.pointRadius || 5;
  
  // Check if we have property-based styling (colorProperty and colorMap)
  let fillColor, strokeColor, pointColor;
  
  if (style.colorProperty && style.colorMap) {
    // Build match expression for data-driven styling
    // Format: ['match', ['get', 'property'], value1, color1, value2, color2, ..., defaultColor]
    const matchExpression = ['match', ['get', style.colorProperty]];
    
    // Add each property value and its color
    Object.entries(style.colorMap).forEach(([value, color]) => {
      matchExpression.push(value, color);
    });
    
    // Add default color
    matchExpression.push(style.fillColor || '#3388ff');
    
    fillColor = matchExpression;
    strokeColor = style.strokeColor || ['match', ['get', style.colorProperty],
      ...Object.entries(style.colorMap).flatMap(([value, color]) => [value, color]),
      style.strokeColor || '#0066cc'
    ];
    pointColor = matchExpression;
  } else {
    // Use single color for all features
    fillColor = style.fillColor || '#3388ff';
    strokeColor = style.strokeColor || '#0066cc';
    pointColor = style.pointColor || '#ff7800';
  }
  
  // Add fill layer for polygons (initially invisible for animation)
  map.addLayer({
    id: 'slideshow-fill',
    type: 'fill',
    source: 'slideshow-geojson',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': fillColor,
      'fill-opacity': 0 // Start invisible for animation
    }
  });
  
  // Add line layer for LineString geometries (e.g., streets)
  map.addLayer({
    id: 'slideshow-line',
    type: 'line',
    source: 'slideshow-geojson',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: {
      'line-color': strokeColor,
      'line-width': strokeWidth,
      'line-opacity': 0 // Start invisible for animation
    }
  });
  
  // Add line layer for polygon outlines
  map.addLayer({
    id: 'slideshow-polygon-outline',
    type: 'line',
    source: 'slideshow-geojson',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'line-color': strokeColor,
      'line-width': 1,
      'line-opacity': 0.3 // Subtle outline during animation
    }
  });
  
  // Add circle layer for points
  map.addLayer({
    id: 'slideshow-point',
    type: 'circle',
    source: 'slideshow-geojson',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': pointRadius,
      'circle-color': pointColor,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1
    }
  });
  
  // Start the sequential animation
  let animationCompleted = false;
  if (style.colorProperty && style.colorMap) {
    animationCompleted = await animateGeoJSONByProperty(geojson, slide);
    
    // After animation completes, set final state
    if (geojsonAnimationActive) {
      const strokeOpacity = style.strokeOpacity || 0.8;
      map.setPaintProperty('slideshow-fill', 'fill-opacity', fillOpacity);
      map.setPaintProperty('slideshow-line', 'line-opacity', strokeOpacity);
      map.setPaintProperty('slideshow-polygon-outline', 'line-opacity', 1);
    }
  } else {
    // No animation, show immediately
    const strokeOpacity = style.strokeOpacity || 0.8;
    map.setPaintProperty('slideshow-fill', 'fill-opacity', fillOpacity);
    map.setPaintProperty('slideshow-line', 'line-opacity', strokeOpacity);
    map.setPaintProperty('slideshow-polygon-outline', 'line-opacity', 1);
  }
  
  return animationCompleted;
}

// Display a slide
async function displaySlide(index) {
  if (!slideshowConfig || !slideshowConfig.slides || index >= slideshowConfig.slides.length) {
    return;
  }
  
  const slide = slideshowConfig.slides[index];
  const oldMedia = currentMediaElement;
  const oldRotation = currentMediaRotation;
  const oldFitMode = currentMediaFitMode;
  const newRotation = slide.rotation || 0; // Get rotation from slide config
  const newFitMode = slide.fitMode || slideshowConfig.settings.fitMode || 'contain'; // Get fitMode from slide or global config
  
  try {
    // Preload media
    const media = await preloadMedia(slide);
    
    // Handle different media types
    if (slide.type === 'geojson') {
      // For GeoJSON, hide canvas and display on map with animation
      if (slideshowCanvas) {
        slideshowCanvas.classList.remove('active');
      }
      if (slideshowCtx) {
        slideshowCtx.clearRect(0, 0, slideshowCanvas.width, slideshowCanvas.height);
      }
      // Display metadata first so it's visible during animation
      displayMetadata(slide);
      const animationCompleted = await displayGeoJSON(media, slide);
      currentMediaElement = null;
      currentMediaRotation = 0; // GeoJSON doesn't use rotation
      currentMediaFitMode = 'contain'; // Reset fitMode
      
      // Auto-advance after GeoJSON animation completes
      if (animationCompleted && isSlideShowActive) {
        // Small pause before advancing to next slide
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (isSlideShowActive) {
          advanceSlide();
          return; // Exit early, don't schedule another timer
        }
      }
    } else if (slide.type === 'video') {
      // Remove any GeoJSON layers from previous slide
      removeGeoJSONLayers();
      
      // For video, show canvas and play it
      if (slideshowCanvas) {
        slideshowCanvas.classList.add('active');
      }
      media.currentTime = 0;
      await media.play();
      currentMediaElement = media;
      currentMediaRotation = newRotation;
      currentMediaFitMode = newFitMode;
      
      // Animate transition
      await animateTransition(oldMedia, media, slide.transition || 'fade', 500, oldRotation, newRotation, oldFitMode, newFitMode);
      
      // Draw video frames continuously
      function drawVideoFrame() {
        if (isSlideShowActive && currentSlideIndex === index && !media.paused && !media.ended) {
          drawMediaOnCanvas(media, newFitMode, newRotation);
          requestAnimationFrame(drawVideoFrame);
        }
      }
      drawVideoFrame();
      // Display metadata for video
      displayMetadata(slide);
    } else {
      // Remove any GeoJSON layers from previous slide
      removeGeoJSONLayers();
      
      // For images/gifs, show canvas
      if (slideshowCanvas) {
        slideshowCanvas.classList.add('active');
      }
      currentMediaElement = media;
      currentMediaRotation = newRotation;
      currentMediaFitMode = newFitMode;
      await animateTransition(oldMedia, media, slide.transition || 'fade', 500, oldRotation, newRotation, oldFitMode, newFitMode);
      // Display metadata for image/gif types
      displayMetadata(slide);
    }
    
    // Schedule next slide
    if (slideshowConfig.settings.autoAdvance) {
      const duration = slide.duration || 5000;
      slideshowTimer = setTimeout(() => {
        advanceSlide();
      }, duration);
    }
    
  } catch (error) {
    console.error('Error displaying slide:', error);
    // Try next slide on error
    advanceSlide();
  }
}

// Advance to next slide
function advanceSlide() {
  if (!isSlideShowActive || !slideshowConfig) return;
  
  // Stop any ongoing GeoJSON animation
  stopGeoJSONAnimation();
  
  // Stop current video if playing
  if (currentMediaElement instanceof HTMLVideoElement) {
    currentMediaElement.pause();
  }
  
  // Clear timer
  if (slideshowTimer) {
    clearTimeout(slideshowTimer);
    slideshowTimer = null;
  }
  
  currentSlideIndex++;
  
  // Loop or stop
  if (currentSlideIndex >= slideshowConfig.slides.length) {
    if (slideshowConfig.settings.loop) {
      currentSlideIndex = 0;
    } else {
      stopSlideshow();
      return;
    }
  }
  
  displaySlide(currentSlideIndex);
}

// Start slideshow
async function startSlideshow() {
  if (isSlideShowActive) {
    stopSlideshow();
    return;
  }
  
  // Load config
  slideshowConfig = await loadSlideshowConfig();
  
  if (!slideshowConfig.slides || slideshowConfig.slides.length === 0) {
    showToast('No slides found in slideshow configuration');
    broadcastSlideshowState(null);
    return;
  }
  
  isSlideShowActive = true;
  currentSlideIndex = 0;
  
  // Broadcast animation state to controller
  slideshowChannel.postMessage({ type: 'animation_state', animationId: 'slideshow-btn', isActive: true });
  
  // Broadcast initial state immediately
  if (slideshowConfig && slideshowConfig.slides && slideshowConfig.slides.length > 0) {
    broadcastSlideshowState(slideshowConfig.slides[0]);
  } else {
    // Broadcast empty/loading state if config failed or empty
    slideshowChannel.postMessage({
      type: 'slideshow_update',
      isActive: true, // Still active, just empty
      currentIndex: 0,
      totalSlides: 0,
      metadata: { title: "No Slides Found", description: "Check configuration." },
      slideType: null
    });
  }
  
  // Prepare canvas (but don't show it yet - displaySlide will decide)
  if (slideshowCanvas) {
    resizeSlideshowCanvas();
  }
  
  if (slideshowMetadata) {
    slideshowMetadata.style.display = 'block';
  }
  
  // Update button state
  if (slideshowBtn) {
    slideshowBtn.classList.add('active');
  }
  
  // Start first slide
  displaySlide(currentSlideIndex);
  
  showToast('Slideshow started • Use ← → to navigate • ESC to exit');
}

// Stop slideshow
function stopSlideshow() {
  isSlideShowActive = false;
  
  // Broadcast animation state to controller
  slideshowChannel.postMessage({ type: 'animation_state', animationId: 'slideshow-btn', isActive: false });
  
  // Clear timer
  if (slideshowTimer) {
    clearTimeout(slideshowTimer);
    slideshowTimer = null;
  }
  
  // Stop video if playing
  if (currentMediaElement instanceof HTMLVideoElement) {
    currentMediaElement.pause();
  }
  
  // Cancel transition animation
  if (transitionAnimationFrame) {
    cancelAnimationFrame(transitionAnimationFrame);
    transitionAnimationFrame = null;
  }
  
  // Stop GeoJSON animation
  stopGeoJSONAnimation();
  
  // Clear canvas
  if (slideshowCtx) {
    slideshowCtx.clearRect(0, 0, slideshowCanvas.width, slideshowCanvas.height);
  }
  
  // Hide canvas and metadata
  if (slideshowCanvas) {
    slideshowCanvas.classList.remove('active');
  }
  
  if (slideshowMetadata) {
    slideshowMetadata.style.display = 'none';
  }
  
  // Remove GeoJSON layers
  if (map.getSource('slideshow-geojson')) {
    ['slideshow-fill', 'slideshow-line', 'slideshow-polygon-outline', 'slideshow-point', 'slideshow-glow'].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    map.removeSource('slideshow-geojson');
  }
  
  // Update button state
  if (slideshowBtn) {
    slideshowBtn.classList.remove('active');
  }
  
  currentMediaElement = null;
  currentSlideIndex = 0;
  
  // Broadcast stop state to controller
  slideshowChannel.postMessage({
    type: 'slideshow_update',
    isActive: false,
    currentIndex: 0,
    totalSlides: 0,
    metadata: null,
    slideType: null
  });
  
  showToast('Slideshow stopped');
}

// Wire up slideshow button
if (slideshowBtn) {
  slideshowBtn.addEventListener('click', startSlideshow);
}

// Resize canvas on window resize
window.addEventListener('resize', () => {
  if (isSlideShowActive && slideshowCanvas) {
    resizeSlideshowCanvas();
    if (currentMediaElement && !(currentMediaElement instanceof HTMLVideoElement)) {
      drawMediaOnCanvas(currentMediaElement, slideshowConfig.settings.fitMode);
    }
  }
});

// Keyboard controls for manual navigation
document.addEventListener('keydown', (e) => {
  if (!isSlideShowActive) return;
  
  if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault();
    // Stop any ongoing GeoJSON animation
    stopGeoJSONAnimation();
    advanceSlide();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    // Stop any ongoing GeoJSON animation
    stopGeoJSONAnimation();
    // Go to previous slide
    if (slideshowTimer) {
      clearTimeout(slideshowTimer);
      slideshowTimer = null;
    }
    if (currentMediaElement instanceof HTMLVideoElement) {
      currentMediaElement.pause();
    }
    currentSlideIndex = currentSlideIndex - 1;
    if (currentSlideIndex < 0) {
      currentSlideIndex = slideshowConfig.slides.length - 1;
    }
    displaySlide(currentSlideIndex);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    stopSlideshow();
  }
});

// Listen for slideshow control messages from controller
slideshowChannel.addEventListener('message', (event) => {
  const data = event.data;
  if (data.type !== 'slideshow_control') return;
  
  if (data.action === 'next') {
    if (!isSlideShowActive) return;
    stopGeoJSONAnimation();
    advanceSlide();
  } else if (data.action === 'previous') {
    if (!isSlideShowActive) return;
    stopGeoJSONAnimation();
    if (slideshowTimer) {
      clearTimeout(slideshowTimer);
      slideshowTimer = null;
    }
    if (currentMediaElement instanceof HTMLVideoElement) {
      currentMediaElement.pause();
    }
    currentSlideIndex = currentSlideIndex - 1;
    if (currentSlideIndex < 0) {
      currentSlideIndex = slideshowConfig.slides.length - 1;
    }
    displaySlide(currentSlideIndex);
  } else if (data.action === 'stop') {
    stopSlideshow();
  } else if (data.action === 'request_status') {
    const slide = slideshowConfig?.slides?.[currentSlideIndex];
    broadcastSlideshowState(slide);
  }
});
