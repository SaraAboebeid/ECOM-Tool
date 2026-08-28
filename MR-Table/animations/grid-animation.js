// ===== Grid Animation System =====
// Sci-fi holographic grid overlay showing physical table tile boundaries

const gridCanvas = document.getElementById('grid-animation-canvas');
const gridCtx = gridCanvas.getContext('2d');
const gridBtn = document.getElementById('grid-animation-btn');
const gridChannel = new BroadcastChannel('map_controller_channel');

// Table physical dimensions
const TABLE_WIDTH_CM = 100;
const TABLE_HEIGHT_CM = 60;
const TILE_SIZE_CM = 20;
const COLS = Math.floor(TABLE_WIDTH_CM / TILE_SIZE_CM); // 5
const ROWS = Math.floor(TABLE_HEIGHT_CM / TILE_SIZE_CM); // 3

let animationFrame = null;
let isAnimating = false;

function resizeGridCanvas() {
  // Use the same calculation as table overlay
  const s = computeOverlayPixelSize();
  gridCanvas.width = s.w;
  gridCanvas.height = s.h;
  gridCanvas.style.width = s.w + 'px';
  gridCanvas.style.height = s.h + 'px';
}

function drawGlowingGrid(time) {
  const width = gridCanvas.width;
  const height = gridCanvas.height;
  
  gridCtx.clearRect(0, 0, width, height);
  
  // Calculate tile size in pixels
  const tileWidth = width / COLS;
  const tileHeight = height / ROWS;
  
  // Sci-fi glow effect parameters
  const baseAlpha = 0.3 + Math.sin(time * 0.002) * 0.15;
  const pulseSpeed = 0.003;
  const waveSpeed = 0.001;
  
  // Draw vertical lines
  for (let i = 0; i <= COLS; i++) {
    const x = i * tileWidth;
    const phase = i * 0.5;
    const pulse = Math.sin(time * pulseSpeed + phase) * 0.5 + 0.5;
    const wave = Math.sin(time * waveSpeed + phase * 2) * 0.3 + 0.7;
    
    // Multi-layer glow
    for (let layer = 0; layer < 3; layer++) {
      gridCtx.strokeStyle = `rgba(0, 255, 255, ${baseAlpha * pulse * wave * (0.4 - layer * 0.1)})`;
      gridCtx.lineWidth = 3 + layer * 2;
      gridCtx.shadowBlur = 15 + layer * 10;
      gridCtx.shadowColor = `rgba(0, 255, 255, ${pulse * 0.8})`;
      
      gridCtx.beginPath();
      gridCtx.moveTo(x, 0);
      gridCtx.lineTo(x, height);
      gridCtx.stroke();
    }
  }
  
  // Draw horizontal lines
  for (let i = 0; i <= ROWS; i++) {
    const y = i * tileHeight;
    const phase = i * 0.5 + COLS * 0.5; // Offset from vertical lines
    const pulse = Math.sin(time * pulseSpeed + phase) * 0.5 + 0.5;
    const wave = Math.sin(time * waveSpeed + phase * 2) * 0.3 + 0.7;
    
    // Multi-layer glow
    for (let layer = 0; layer < 3; layer++) {
      gridCtx.strokeStyle = `rgba(0, 255, 255, ${baseAlpha * pulse * wave * (0.4 - layer * 0.1)})`;
      gridCtx.lineWidth = 3 + layer * 2;
      gridCtx.shadowBlur = 15 + layer * 10;
      gridCtx.shadowColor = `rgba(0, 255, 255, ${pulse * 0.8})`;
      
      gridCtx.beginPath();
      gridCtx.moveTo(0, y);
      gridCtx.lineTo(width, y);
      gridCtx.stroke();
    }
  }
  
  // Draw corner nodes with pulsing effect
  for (let row = 0; row <= ROWS; row++) {
    for (let col = 0; col <= COLS; col++) {
      const x = col * tileWidth;
      const y = row * tileHeight;
      const phase = (row + col) * 0.3;
      const pulse = Math.sin(time * pulseSpeed * 1.5 + phase) * 0.5 + 0.5;
      
      gridCtx.shadowBlur = 20;
      gridCtx.shadowColor = `rgba(0, 255, 255, ${pulse})`;
      gridCtx.fillStyle = `rgba(0, 255, 255, ${0.6 + pulse * 0.4})`;
      
      gridCtx.beginPath();
      gridCtx.arc(x, y, 4 + pulse * 2, 0, Math.PI * 2);
      gridCtx.fill();
      
      // Outer ring
      gridCtx.strokeStyle = `rgba(0, 255, 255, ${0.3 + pulse * 0.3})`;
      gridCtx.lineWidth = 2;
      gridCtx.beginPath();
      gridCtx.arc(x, y, 6 + pulse * 3, 0, Math.PI * 2);
      gridCtx.stroke();
    }
  }
  
  // Reset shadow for next frame
  gridCtx.shadowBlur = 0;
}

function animateGrid() {
  if (!isAnimating) return;
  
  const time = performance.now();
  drawGlowingGrid(time);
  
  animationFrame = requestAnimationFrame(animateGrid);
}

function startGridAnimation() {
  if (isAnimating) {
    stopGridAnimation();
    return;
  }
  
  isAnimating = true;
  gridCanvas.classList.add('active');
  gridChannel.postMessage({ type: 'animation_state', animationId: 'grid-animation-btn', isActive: true });
  resizeGridCanvas();
  animateGrid();
  
  // Auto-stop after 10 seconds
  setTimeout(() => {
    if (isAnimating) stopGridAnimation();
  }, 10000);
}

function stopGridAnimation() {
  isAnimating = false;
  gridCanvas.classList.remove('active');
  gridChannel.postMessage({ type: 'animation_state', animationId: 'grid-animation-btn', isActive: false });
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
}

// Wire up grid animation button
gridBtn.addEventListener('click', startGridAnimation);

// Resize canvas on window resize
window.addEventListener('resize', () => {
  if (isAnimating) resizeGridCanvas();
});
