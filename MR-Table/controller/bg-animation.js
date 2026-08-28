// Background Animation Logic (extracted from controller.js)
// =========================================================
// Renders particle effects on the welcome screen canvas.
// Exposes: setEffect(effectName) — called by tour and core controller.

const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');
let animationId;
let particles = [];
let currentEffect = 'default';

function resizeCanvas() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function initParticles(effect) {
    particles = [];
    
    if (effect === 'sun') {
        // Single sun object
        particles.push({
            angle: Math.PI, // Start at left (sunrise)
            radius: 60,
            speed: 0.005
        });
        return;
    }

    if (effect === 'grid') {
        const gridSize = 40;
        const cols = Math.ceil(canvas.width / gridSize) + 1;
        const rows = Math.ceil(canvas.height / gridSize) + 1;
        
        for (let i = 0; i < cols; i++) {
            particles.push({
                type: 'vertical',
                x: i * gridSize,
                speed: 0.5
            });
        }
        
        for (let i = 0; i < rows; i++) {
            particles.push({
                type: 'horizontal',
                y: i * gridSize,
                speed: 0.5
            });
        }
        return;
    }

    const count = effect === 'isovist' ? 5 : 100;
    for (let i = 0; i < count; i++) {
        particles.push(createParticle(effect));
    }
}

function createParticle(effect) {
    const w = canvas.width;
    const h = canvas.height;
    
    if (effect === 'wind') {
        const speed = Math.random() * 15 + 5;
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            speed: speed,
            length: Math.random() * 120 + 60, // Even longer streamlines
            width: Math.random() * 3 + 2, // Thicker
            opacity: Math.random() * 0.4 + 0.6, // Higher opacity
            speedRatio: speed / 20 // Normalized 0-1 for color
        };
    } else if (effect === 'rain') {
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            speed: Math.random() * 15 + 10,
            length: Math.random() * 35 + 20, // Longer
            width: Math.random() * 3 + 1.5, // Thicker
            opacity: Math.random() * 0.3 + 0.7 // Much higher opacity
        };
    } else if (effect === 'isovist') {
        // Points moving around
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            vx: (Math.random() - 0.5) * 3,
            vy: (Math.random() - 0.5) * 3,
            radius: Math.random() * 8 + 8, // Larger circles
            opacity: Math.random() * 0.3 + 0.7, // Much higher opacity
            angle: Math.random() * Math.PI * 2,
            angleSpeed: (Math.random() - 0.5) * 0.08,
            trail: []
        };
    } else if (effect === 'grid') {
        // Grid lines
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            size: Math.random() * 50 + 20,
            opacity: 0,
            targetOpacity: Math.random() * 0.3,
            life: 0
        };
    } else if (effect === 'slideshow') {
        // Floating squares
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            size: Math.random() * 50 + 15,
            vx: (Math.random() - 0.5) * 1.5,
            vy: (Math.random() - 0.5) * 1.5,
            opacity: Math.random() * 0.4 + 0.5 // Much higher opacity
        };
    } else if (effect === 'soundwaves') {
        // Floating sine waves
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            width: Math.random() * 150 + 80, // Wider waves
            amplitude: Math.random() * 30 + 10, // Bigger amplitude
            frequency: Math.random() * 0.1 + 0.02,
            speed: Math.random() * 2 + 0.5,
            phase: Math.random() * Math.PI * 2,
            opacity: Math.random() * 0.3 + 0.7, // Much higher opacity
            lineWidth: Math.random() * 4 + 3 // Thicker lines
        };
    }
    
    return {};
}

function updateParticles() {
    const w = canvas.width;
    const h = canvas.height;
    
    particles.forEach(p => {
        if (currentEffect === 'wind') {
            p.x += p.speed;
            if (p.x > w) p.x = -p.length;
        } else if (currentEffect === 'rain') {
            p.y += p.speed;
            p.x += 1; // Slight wind
            if (p.y > h) {
                p.y = -p.length;
                p.x = Math.random() * w;
            }
        } else if (currentEffect === 'sun') {
            p.angle += p.speed;
            if (p.angle > 2 * Math.PI) p.angle = Math.PI; // Loop back to sunrise
        } else if (currentEffect === 'isovist') {
            // Update trail
            p.trail.push({x: p.x, y: p.y});
            if (p.trail.length > 20) p.trail.shift();

            p.x += p.vx;
            p.y += p.vy;
            
            // Bounce off walls
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;

            // Look around
            p.angle += p.angleSpeed;
        } else if (currentEffect === 'grid') {
            const gridSize = 40;
            if (p.type === 'vertical') {
                p.x += p.speed;
                if (p.x > canvas.width) p.x = -gridSize;
            } else {
                p.y += p.speed;
                if (p.y > canvas.height) p.y = -gridSize;
            }
        } else if (currentEffect === 'slideshow') {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;
        } else if (currentEffect === 'soundwaves') {
            p.x += p.speed;
            p.phase += 0.1;
            if (p.x > w) p.x = -p.width;
        }
    });
}

function drawParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (currentEffect === 'wind') {
        // CFD-style streamlines with speed-based colors (blue=slow, cyan, green, yellow, red=fast)
        particles.forEach(p => {
            const t = p.speedRatio;
            let r, g, b;
            if (t < 0.25) {
                // Blue to Cyan
                const s = t / 0.25;
                r = 0; g = Math.floor(150 + 105 * s); b = 255;
            } else if (t < 0.5) {
                // Cyan to Green
                const s = (t - 0.25) / 0.25;
                r = 0; g = 255; b = Math.floor(255 * (1 - s));
            } else if (t < 0.75) {
                // Green to Yellow
                const s = (t - 0.5) / 0.25;
                r = Math.floor(255 * s); g = 255; b = 0;
            } else {
                // Yellow to Red
                const s = (t - 0.75) / 0.25;
                r = 255; g = Math.floor(255 * (1 - s)); b = 0;
            }
            ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.lineWidth = p.width;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + p.length, p.y);
            ctx.globalAlpha = p.opacity;
            ctx.stroke();
        });
    } else if (currentEffect === 'rain') {
        ctx.strokeStyle = 'rgba(120, 200, 255, 1)'; // Very bright cyan-blue
        ctx.lineCap = 'round';
        particles.forEach(p => {
            ctx.lineWidth = p.width;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + 2, p.y + p.length);
            ctx.globalAlpha = p.opacity;
            ctx.stroke();
        });
    } else if (currentEffect === 'sun') {
        const sun = particles[0];
        const cx = canvas.width / 2;
        const cy = canvas.height * 0.8;
        const radius = Math.min(canvas.width, canvas.height) * 0.4;
        
        const sunX = cx + Math.cos(sun.angle) * radius;
        const sunY = cy + Math.sin(sun.angle) * radius;
        
        const progress = (sun.angle - Math.PI) / Math.PI;
        let skyColor1;
        
        if (progress < 0.5) {
            const t = progress * 2;
            skyColor1 = `rgba(${255 * (1-t)}, ${100 + 155 * t}, ${255 * t}, 0.7)`; // Much higher opacity
        } else {
            const t = (progress - 0.5) * 2;
            skyColor1 = `rgba(${255 * t}, ${255 * (1-t)}, ${255 * (1-t)}, 0.7)`; // Much higher opacity
        }
        
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, skyColor1);
        gradient.addColorStop(1, 'rgba(255, 150, 50, 0.2)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw Sun with intense glow
        ctx.shadowBlur = 60;
        ctx.shadowColor = 'rgba(255, 150, 0, 1)';
        ctx.fillStyle = 'rgba(255, 220, 50, 1)';
        ctx.beginPath();
        ctx.arc(sunX, sunY, sun.radius, 0, Math.PI * 2);
        ctx.fill();
        
        // Inner bright core
        ctx.shadowBlur = 30;
        ctx.shadowColor = 'rgba(255, 255, 200, 1)';
        ctx.fillStyle = 'rgba(255, 255, 200, 1)';
        ctx.beginPath();
        ctx.arc(sunX, sunY, sun.radius * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        
    } else if (currentEffect === 'isovist') {
        particles.forEach(p => {
            ctx.save();
            
            // Draw Trail with glow
            if (p.trail && p.trail.length > 1) {
                ctx.beginPath();
                ctx.moveTo(p.trail[0].x, p.trail[0].y);
                for (let i = 1; i < p.trail.length; i++) {
                    ctx.lineTo(p.trail[i].x, p.trail[i].y);
                }
                ctx.lineTo(p.x, p.y);
                ctx.strokeStyle = `rgba(255, 100, 50, ${p.opacity * 0.8})`;
                ctx.lineWidth = 4;
                ctx.lineCap = 'round';
                ctx.stroke();
            }

            ctx.globalAlpha = p.opacity;
            
            // Draw circle with glow
            ctx.shadowBlur = 20;
            ctx.shadowColor = 'rgba(255, 100, 0, 0.8)';
            ctx.fillStyle = 'rgba(255, 120, 50, 1)';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            
            // Draw cone oriented to p.angle - brighter
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            
            ctx.fillStyle = 'rgba(255, 220, 100, 0.5)';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(180, -50);
            ctx.lineTo(180, 50);
            ctx.closePath();
            ctx.fill();
            
            ctx.restore();
        });
    } else if (currentEffect === 'grid') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; // Brighter white lines
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        particles.forEach(p => {
            if (p.type === 'vertical') {
                ctx.moveTo(p.x, 0);
                ctx.lineTo(p.x, canvas.height);
            } else {
                ctx.moveTo(0, p.y);
                ctx.lineTo(canvas.width, p.y);
            }
        });
        ctx.stroke();
    } else if (currentEffect === 'slideshow') {
        ctx.fillStyle = 'rgba(167, 139, 250, 0.9)'; // Very bright violet/purple
        particles.forEach(p => {
            ctx.globalAlpha = p.opacity;
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'rgba(139, 92, 246, 0.5)';
            ctx.fillRect(p.x, p.y, p.size, p.size * 0.6);
        });
        ctx.shadowBlur = 0;
    } else if (currentEffect === 'soundwaves') {
        particles.forEach(p => {
            ctx.strokeStyle = 'rgba(244, 114, 182, 1)'; // Very bright pink
            ctx.lineWidth = p.lineWidth || 4; // Use particle's line width
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.globalAlpha = p.opacity;
            for (let i = 0; i < p.width; i++) {
                const y = p.y + Math.sin(i * p.frequency + p.phase) * p.amplitude;
                if (i === 0) ctx.moveTo(p.x + i, y);
                else ctx.lineTo(p.x + i, y);
            }
            ctx.stroke();
        });
    }
    
    ctx.globalAlpha = 1;
}

function animate() {
    updateParticles();
    drawParticles();
    animationId = requestAnimationFrame(animate);
}

function setEffect(effectName) {
    if (currentEffect !== effectName) {
        currentEffect = effectName;
        initParticles(effectName);
    }
}

// Start animation loop
animate();
