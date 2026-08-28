// Isovist Dashboard (extracted from controller.js)
// =============================================
// Handles the isovist pie chart, GVF metrics, and history chart.
// Exposes globals: isovistHistory, updateIsovistChart, drawIsovistHistoryChart

// Historical data for isovist stacked area chart
const isovistHistory = {
    maxPoints: 100,
    data: [],
    gvfHistory: [], // Track GVF values for rolling average
    colors: {
        'Open View': '#87CEEB',
        'Trees': '#2D5A27',
        'Bostad': '#E57373',
        'Verksamhet': '#00ACC1',
        'Samhällsfunktion': '#9C27B0',
        'Komplementbyggnad': '#FF9800',
        'Unknown': '#888888'
    },
    order: ['Unknown', 'Komplementbyggnad', 'Samhällsfunktion', 'Verksamhet', 'Bostad', 'Trees', 'Open View']
};

function updateIsovistChart(stats) {
    const container = document.getElementById('isovist-stats-container');
    if (!container) return;
    
    // Check if isovist is active
    const isovistBtn = document.querySelector('.control-btn[data-target="isovist-btn"]');
    if (!isovistBtn || !isovistBtn.classList.contains('active')) return;
    
    const totalRays = stats.totalRays || 1;
    const openRays = stats.openRays || 0;
    const treeRays = stats.treeRays || 0;
    const buildingTypeRays = stats.buildingTypeRays || {};
    
    // Calculate ray-based percentages (these will add up to 100%)
    const buildingTypes = {
        'Open View': { rays: openRays, color: '#87CEEB', percent: ((openRays / totalRays) * 100).toFixed(1) },
        'Trees': { rays: treeRays, color: '#2D5A27', percent: ((treeRays / totalRays) * 100).toFixed(1) },
        'Bostad': { rays: buildingTypeRays['Bostad'] || 0, color: '#E57373', percent: (((buildingTypeRays['Bostad'] || 0) / totalRays) * 100).toFixed(1) },
        'Verksamhet': { rays: buildingTypeRays['Verksamhet'] || 0, color: '#00ACC1', percent: (((buildingTypeRays['Verksamhet'] || 0) / totalRays) * 100).toFixed(1) },
        'Samhällsfunktion': { rays: buildingTypeRays['Samhällsfunktion'] || 0, color: '#9C27B0', percent: (((buildingTypeRays['Samhällsfunktion'] || 0) / totalRays) * 100).toFixed(1) },
        'Komplementbyggnad': { rays: buildingTypeRays['Komplementbyggnad'] || 0, color: '#FF9800', percent: (((buildingTypeRays['Komplementbyggnad'] || 0) / totalRays) * 100).toFixed(1) },
        'Unknown': { rays: buildingTypeRays['Unknown'] || 0, color: '#888888', percent: (((buildingTypeRays['Unknown'] || 0) / totalRays) * 100).toFixed(1) }
    };
    
    // Calculate GVF (Green View Factor) - percentage of view that is trees/vegetation
    // Cap at 100% to handle any floating point rounding issues
    const gvf = Math.min(100, parseFloat(buildingTypes['Trees'].percent));
    
    // Add to GVF rolling history
    isovistHistory.gvfHistory.push(gvf);
    if (isovistHistory.gvfHistory.length > isovistHistory.maxPoints) {
        isovistHistory.gvfHistory.shift();
    }
    
    // Calculate rolling average GVF
    const gvfAverage = isovistHistory.gvfHistory.length > 0 
        ? (isovistHistory.gvfHistory.reduce((a, b) => a + b, 0) / isovistHistory.gvfHistory.length).toFixed(1)
        : 0;
    
    // Determine GVF rating
    let gvfRating, gvfRatingColor, gvfRatingIcon;
    if (gvfAverage >= 30) {
        gvfRating = 'Good';
        gvfRatingColor = '#4CAF50';
        gvfRatingIcon = 'check_circle';
    } else if (gvfAverage >= 15) {
        gvfRating = 'Fair';
        gvfRatingColor = '#FF9800';
        gvfRatingIcon = 'info';
    } else {
        gvfRating = 'Poor';
        gvfRatingColor = '#f44336';
        gvfRatingIcon = 'warning';
    }
    
    // Filter out types with 0 rays (except Open View and Trees which we always show if enabled)
    const activeTypes = Object.entries(buildingTypes).filter(([type, data]) => 
        type === 'Open View' || type === 'Trees' || data.rays > 0
    );
    
    // Add to history
    isovistHistory.data.push({
        'Open View': parseFloat(buildingTypes['Open View'].percent),
        'Trees': parseFloat(buildingTypes['Trees'].percent),
        'Bostad': parseFloat(buildingTypes['Bostad'].percent),
        'Verksamhet': parseFloat(buildingTypes['Verksamhet'].percent),
        'Samhällsfunktion': parseFloat(buildingTypes['Samhällsfunktion'].percent),
        'Komplementbyggnad': parseFloat(buildingTypes['Komplementbyggnad'].percent),
        'Unknown': parseFloat(buildingTypes['Unknown'].percent)
    });
    if (isovistHistory.data.length > isovistHistory.maxPoints) {
        isovistHistory.data.shift();
    }
    
    // Build conic-gradient for pie chart
    let gradientParts = [];
    let currentAngle = 0;
    activeTypes.forEach(([type, data]) => {
        const percent = parseFloat(data.percent);
        const nextAngle = currentAngle + (percent * 3.6); // 3.6 degrees per percent
        gradientParts.push(`${data.color} ${currentAngle}deg ${nextAngle}deg`);
        currentAngle = nextAngle;
    });
    // Fill remaining with dark if not 100%
    if (currentAngle < 360) {
        gradientParts.push(`rgba(50,50,50,0.5) ${currentAngle}deg 360deg`);
    }
    const gradient = gradientParts.join(', ');
    
    let html = `
        <style>
            .isovist-pie-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 12px;
            }
            .pie-chart {
                width: 200px;
                height: 200px;
                border-radius: 50%;
                background: conic-gradient(${gradient});
                flex-shrink: 0;
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                position: relative;
            }
            .pie-chart::after {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 90px;
                height: 90px;
                background: #2a2a2a;
                border-radius: 50%;
            }
            .pie-chart-gvf {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                text-align: center;
                z-index: 1;
            }
            .gvf-value {
                font-size: 26px;
                font-weight: 700;
                color: #ffffff;
                line-height: 1;
            }
            .gvf-label {
                font-size: 10px;
                color: #2D5A27;
                text-transform: uppercase;
                letter-spacing: 1px;
                margin-top: 4px;
                font-weight: 600;
            }
            .pie-stats {
                display: flex;
                justify-content: center;
                gap: 20px;
                font-size: 12px;
                color: #ccc;
                width: 100%;
            }
            .pie-stat-item {
                text-align: center;
            }
            .pie-stat-value {
                font-weight: 700;
                font-size: 18px;
                color: #fff;
                display: block;
            }
            .pie-stat-label {
                font-size: 10px;
                color: #888;
                text-transform: uppercase;
            }
            .pie-legend {
                display: flex;
                flex-wrap: wrap;
                gap: 4px 10px;
                margin-top: 12px;
                padding-top: 10px;
                border-top: 1px solid rgba(255,255,255,0.1);
            }
            .pie-legend-item {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 10px;
                color: #aaa;
            }
            .pie-legend-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .building-legend {
                display: flex;
                flex-wrap: wrap;
                gap: 4px 8px;
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid rgba(255,255,255,0.08);
            }
            .building-legend-item {
                display: flex;
                align-items: center;
                gap: 3px;
                font-size: 9px;
                color: #777;
            }
            .building-legend-color {
                width: 10px;
                height: 10px;
                border-radius: 2px;
                flex-shrink: 0;
            }
            .history-chart-container {
                margin-top: 12px;
                padding-top: 10px;
                border-top: 1px solid rgba(255,255,255,0.1);
            }
            .history-chart-title {
                font-size: 10px;
                color: #666;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 8px;
            }
            .history-canvas {
                width: 100%;
                height: 80px;
                border-radius: 4px;
                background: rgba(0,0,0,0.2);
            }
            .gvf-average-container {
                margin-top: 10px;
                padding: 10px;
                background: rgba(0,0,0,0.2);
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .gvf-average-left {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .gvf-average-label {
                font-size: 10px;
                color: #888;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .gvf-average-value {
                font-size: 18px;
                font-weight: 700;
                color: #fff;
            }
            .gvf-rating {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 600;
            }
            .gvf-rating .material-icons {
                font-size: 14px;
            }
        </style>
        <div class="isovist-pie-container">
            <div class="pie-chart">
                <div class="pie-chart-gvf">
                    <div class="gvf-value">${gvf.toFixed(1)}%</div>
                    <div class="gvf-label">GVF</div>
                </div>
            </div>
            <div class="pie-stats">
                <div class="pie-stat-item">
                    <span class="pie-stat-value">${stats.totalBuildings || 0}</span>
                    <span class="pie-stat-label">Buildings</span>
                </div>
                <div class="pie-stat-item">
                    <span class="pie-stat-value">${stats.totalTrees || 0}</span>
                    <span class="pie-stat-label">Trees</span>
                </div>
                <div class="pie-stat-item">
                    <span class="pie-stat-value">${buildingTypes['Open View'].percent}%</span>
                    <span class="pie-stat-label">Open View</span>
                </div>
            </div>
        </div>
        <div class="pie-legend">
    `;
    
    activeTypes.forEach(([type, data]) => {
        const displayName = type === 'Samhällsfunktion' ? 'Public' : 
                           type === 'Komplementbyggnad' ? 'Outbld' :
                           type === 'Verksamhet' ? 'Comm.' :
                           type === 'Bostad' ? 'Resid.' : 
                           type === 'Open View' ? 'Open' :
                           type === 'Trees' ? 'Trees' : type;
        html += `
            <div class="pie-legend-item">
                <div class="pie-legend-dot" style="background: ${data.color};"></div>
                <span>${displayName} ${data.percent}%</span>
            </div>
        `;
    });
    
    html += `</div>
        <div class="building-legend">
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #E57373;"></div>
                <span>Residential</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #00ACC1;"></div>
                <span>Commercial</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #9C27B0;"></div>
                <span>Public</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #FF9800;"></div>
                <span>Outbuilding</span>
            </div>
            <div class="building-legend-item">
                <div class="building-legend-color" style="background: #2D5A27;"></div>
                <span>Trees</span>
            </div>
        </div>
        <div class="history-chart-container">
            <div class="history-chart-title">Visibility History</div>
            <canvas id="isovist-history-canvas" class="history-canvas"></canvas>
        </div>
        <div class="gvf-average-container">
            <div class="gvf-average-left">
                <div>
                    <div class="gvf-average-label">Average GVF</div>
                    <div class="gvf-average-value">${gvfAverage}%</div>
                </div>
            </div>
            <div class="gvf-rating" style="background: ${gvfRatingColor}22; color: ${gvfRatingColor};">
                <span class="material-icons">${gvfRatingIcon}</span>
                ${gvfRating}
            </div>
        </div>
    `;
    
    container.innerHTML = html;
    
    // Draw the stacked area chart
    drawIsovistHistoryChart();
}

function drawIsovistHistoryChart() {
    const canvas = document.getElementById('isovist-history-canvas');
    if (!canvas || isovistHistory.data.length < 2) return;
    
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;  // Higher resolution
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    
    const width = rect.width;
    const height = rect.height;
    const data = isovistHistory.data;
    const numPoints = data.length;
    const xStep = width / (isovistHistory.maxPoints - 1);
    const xOffset = (isovistHistory.maxPoints - numPoints) * xStep;
    
    // Draw stacked areas from TOP to BOTTOM (reverse order so layers don't cover each other)
    const reversedOrder = [...isovistHistory.order].reverse();
    
    reversedOrder.forEach(type => {
        ctx.beginPath();
        
        // Start at bottom-left
        ctx.moveTo(xOffset, height);
        
        // Draw top edge (cumulative up to and including this type)
        for (let i = 0; i < numPoints; i++) {
            const x = xOffset + i * xStep;
            let cumulative = 0;
            
            // Sum from bottom of stack up to and including this type
            for (let j = 0; j <= isovistHistory.order.indexOf(type); j++) {
                cumulative += data[i][isovistHistory.order[j]] || 0;
            }
            
            const y = height - (cumulative / 100 * height);
            ctx.lineTo(x, y);
        }
        
        // Close back to bottom-right then bottom-left
        ctx.lineTo(xOffset + (numPoints - 1) * xStep, height);
        ctx.closePath();
        
        ctx.fillStyle = isovistHistory.colors[type];
        ctx.fill();
    });
    
    // Draw subtle grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 0.5;
    [25, 50, 75].forEach(pct => {
        const y = height - (pct / 100 * height);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    });
}
