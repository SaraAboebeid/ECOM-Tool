// Campus Demo Legend (extracted from controller.js)
// =============================================
// Handles the campus demo phase legend and progress display.
// Exposes globals: campusDemoShownPhases, updateCampusDemoLegend, resetCampusDemoLegend

// Track shown phases for cumulative legend display
let campusDemoShownPhases = [];

function updateCampusDemoLegend(phaseName, phaseIndex, label) {
    const legendContent = document.getElementById('legend-content');
    const campusLegend = document.getElementById('campus-demo-legend');
    const dashboardContent = document.getElementById('dashboard-content');
    
    if (!campusLegend) return;
    
    // Add this phase to shown phases if not already there
    if (!campusDemoShownPhases.includes(phaseName)) {
        campusDemoShownPhases.push(phaseName);
    }
    
    // Hide default legend, show campus demo legend
    legendContent.style.display = 'none';
    campusLegend.style.display = 'block';
    
    // Update legend title
    const legendTitle = document.getElementById('legend-title');
    if (legendTitle) {
        legendTitle.textContent = 'Campus Vision Legend';
    }
    
    // Show all phases up to current
    const allPhases = campusLegend.querySelectorAll('.legend-phase');
    allPhases.forEach(phaseEl => {
        const phase = phaseEl.getAttribute('data-phase');
        if (campusDemoShownPhases.includes(phase)) {
            phaseEl.style.display = 'block';
            // Highlight current phase
            if (phase === phaseName) {
                phaseEl.style.opacity = '1';
                phaseEl.style.transform = 'scale(1.02)';
                phaseEl.style.transition = 'all 0.3s ease';
            } else {
                phaseEl.style.opacity = '0.6';
                phaseEl.style.transform = 'scale(1)';
            }
        } else {
            phaseEl.style.display = 'none';
        }
    });
    
    // Update dashboard with current phase info
    dashboardContent.innerHTML = `
        <div class="dashboard-container">
            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">school</span>
                    Campus Vision Presentation
                </div>
                <div class="info-box" style="border-left-color: #3b82f6; margin-bottom: 1rem;">
                    <div class="info-title">${label}</div>
                    <p class="info-text">
                        Phase ${phaseIndex + 1} of 10
                    </p>
                </div>
                <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem;">
                    ${Array.from({length: 10}, (_, i) => `
                        <div style="
                            width: 24px; 
                            height: 24px; 
                            border-radius: 50%; 
                            background: ${i < phaseIndex ? '#888' : (i === phaseIndex ? '#4CAF50' : '#444')};
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 12px;
                            color: ${i <= phaseIndex ? '#fff' : '#666'};
                            transition: all 0.3s;
                        ">${i + 1}</div>
                    `).join('')}
                </div>
                <p style="color: #888; margin-top: 1rem; font-size: 0.9rem;">
                    Use ← → arrow keys to navigate
                </p>
            </div>
        </div>
    `;
}

// Reset campus demo legend when demo stops
function resetCampusDemoLegend() {
    campusDemoShownPhases = [];
    const legendContent = document.getElementById('legend-content');
    const campusLegend = document.getElementById('campus-demo-legend');
    const legendTitle = document.getElementById('legend-title');
    
    if (legendContent) legendContent.style.display = 'block';
    if (campusLegend) campusLegend.style.display = 'none';
    if (legendTitle) legendTitle.textContent = 'Legend';
    
    // Hide all phase legends
    if (campusLegend) {
        campusLegend.querySelectorAll('.legend-phase').forEach(el => {
            el.style.display = 'none';
        });
    }
    
    // Reset the metadata section back to default
    const metadataContent = document.getElementById('metadata-content');
    const metadataSection = metadataContent?.parentElement;
    if (metadataSection) {
        const metadataTitle = metadataSection.querySelector('h2');
        if (metadataTitle) metadataTitle.textContent = 'Metadata';
        metadataContent.className = '';
        metadataContent.innerHTML = `
            <div class="metadata-item">
                <div class="metadata-label">Current View</div>
                <div class="metadata-value" id="meta-view">Default</div>
            </div>
            <div class="metadata-item">
                <div class="metadata-label">Active Layer</div>
                <div class="metadata-value" id="meta-layer">None</div>
            </div>
             <div class="metadata-item">
                <div class="metadata-label">Description</div>
                <div class="metadata-value" id="meta-desc">Interactive map of the district. Use controls to toggle layers.</div>
            </div>
        `;
    }
}
