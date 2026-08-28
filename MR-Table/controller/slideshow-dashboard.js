// Slideshow Dashboard (extracted from controller.js)
// =============================================
// Handles the slideshow navigation, metadata display, and legend.
// Exposes globals: slideshowState, updateSlideshowDashboard, highlightControllerLegendItem
// Dependencies (resolved at call time): channel, MSG_TYPES

// Slideshow state tracking (declared early as it's used by updateDashboard)
let slideshowState = {
    isActive: false,
    currentIndex: 0,
    totalSlides: 0,
    metadata: null,
    slideType: null
};

// Update slideshow dashboard with live metadata and controls
function updateSlideshowDashboard() {
    const dashboardContent = document.getElementById('dashboard-content');
    const legendContent = document.getElementById('legend-content');
    
    if (!slideshowState.isActive) {
        dashboardContent.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-card">
                    <div class="dashboard-section-title">
                        <span class="material-icons" style="font-size: 18px;">slideshow</span>
                        Slideshow
                    </div>
                    <div class="info-box" style="border-left-color: #8b5cf6; margin-bottom: 1rem;">
                        <div class="info-title">Ready to Start</div>
                        <p class="info-text">
                            The slideshow is currently stopped.
                        </p>
                    </div>
                    <button id="slideshow-start-btn" class="modern-btn primary" style="width: 100%;">
                        <span class="material-icons">play_arrow</span> Start Slideshow
                    </button>
                </div>
            </div>
        `;
        
        // Add listener for start button
        setTimeout(() => {
            const startBtn = document.getElementById('slideshow-start-btn');
            if (startBtn) {
                startBtn.addEventListener('click', () => {
                    // Send toggle command
                    channel.postMessage({
                        type: MSG_TYPES.CONTROL_ACTION,
                        target: 'slideshow-btn'
                    });
                    // Show loading state locally
                    dashboardContent.innerHTML = '<div class="dashboard-container"><div class="dashboard-card"><p>Starting...</p></div></div>';
                });
            }
        }, 0);

        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <p style="color: #6b7280; font-size: 0.9rem;">Start the slideshow to see slide-specific legends.</p>
            </div>
        `;
        return;
    }
    
    const meta = slideshowState.metadata || {};
    const slideNum = slideshowState.currentIndex + 1;
    const totalSlides = slideshowState.totalSlides;
    
    // Build dashboard content
    dashboardContent.innerHTML = `
        <div class="dashboard-container">
            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">slideshow</span>
                    Navigation
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
                    <button id="slideshow-prev-btn" class="modern-btn" style="flex: 1;">
                        <span class="material-icons">chevron_left</span> Previous
                    </button>
                    <div style="padding: 0 1rem; text-align: center;">
                        <div style="font-size: 1.5rem; font-weight: 600; color: #1f2937;">${slideNum} / ${totalSlides}</div>
                        <div style="font-size: 0.75rem; color: #6b7280;">Slide</div>
                    </div>
                    <button id="slideshow-next-btn" class="modern-btn" style="flex: 1;">
                        Next <span class="material-icons">chevron_right</span>
                    </button>
                </div>
                <div style="text-align: center;">
                    <button id="slideshow-stop-btn" class="modern-btn" style="background: #fef2f2; border-color: #fecaca; color: #dc2626;">
                        <span class="material-icons">stop</span> Stop Slideshow
                    </button>
                </div>
                <div style="margin-top: 1rem; padding: 0.75rem; background: #f3f4f6; border-radius: 8px; text-align: center; color: #6b7280; font-size: 0.85rem;">
                    <span class="material-icons" style="font-size: 14px; vertical-align: middle;">keyboard</span>
                    Use <kbd style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">←</kbd> <kbd style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">→</kbd> arrow keys to navigate
                </div>
            </div>

            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">info</span>
                    Current Slide
                </div>
                ${meta.title ? `<div style="font-size: 1.1rem; font-weight: 600; color: #1f2937; margin-bottom: 0.5rem;">${meta.title}</div>` : ''}
                ${meta.description ? `<p class="info-text" style="margin-bottom: 0.75rem;">${meta.description}</p>` : ''}
                ${meta.source ? `<p style="font-size: 0.8rem; color: #9ca3af; font-style: italic;">Source: ${meta.source}</p>` : ''}
                ${slideshowState.slideType ? `<div style="margin-top: 0.5rem;"><span style="background: #e5e7eb; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; text-transform: uppercase;">${slideshowState.slideType}</span></div>` : ''}
            </div>
        </div>
    `;
    
    // Build legend from slide metadata
    if (meta.legend && meta.legend.items && meta.legend.items.length > 0) {
        // Build reverse color map (color -> property value) for highlighting
        const colorToValue = {};
        if (meta.style && meta.style.colorMap) {
            Object.entries(meta.style.colorMap).forEach(([value, color]) => {
                colorToValue[color] = value;
            });
        }
        
        let legendHtml = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <div id="slideshow-legend-items" style="display: flex; flex-direction: column; gap: 0.5rem;">
        `;
        
        meta.legend.items.forEach(item => {
            const propertyValue = colorToValue[item.color] || '';
            legendHtml += `
                <div class="legend-item slideshow-legend-item" data-value="${propertyValue}" style="transition: all 0.3s ease; opacity: 0.6;">
                    <div class="legend-color" style="background: ${item.color};"></div>
                    <span class="legend-label">${item.label}</span>
                </div>
            `;
        });
        
        legendHtml += `
                </div>
            </div>
        `;
        legendContent.innerHTML = legendHtml;
    } else {
        legendContent.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Legend</div>
                <p style="color: #6b7280; font-size: 0.9rem;">No legend for this slide.</p>
            </div>
        `;
    }
    
    // Attach event listeners for navigation buttons
    const prevBtn = document.getElementById('slideshow-prev-btn');
    const nextBtn = document.getElementById('slideshow-next-btn');
    const stopBtn = document.getElementById('slideshow-stop-btn');
    
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'previous' });
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'next' });
        });
    }
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            channel.postMessage({ type: MSG_TYPES.SLIDESHOW_CONTROL, action: 'stop' });
        });
    }
}

// Highlight legend item in controller to match main window animation
function highlightControllerLegendItem(propertyValue) {
    const legendItems = document.querySelectorAll('.slideshow-legend-item');
    legendItems.forEach(item => {
        const itemValue = item.getAttribute('data-value');
        if (propertyValue && itemValue === propertyValue) {
            // Active state - match main window styling
            item.style.opacity = '1';
            item.style.background = 'rgba(59, 130, 246, 0.1)';
            item.style.transform = 'scale(1.05)';
            item.style.boxShadow = '0 0 12px rgba(59, 130, 246, 0.4)';
            item.style.borderColor = '#3b82f6';
        } else {
            // Inactive state
            item.style.opacity = '0.6';
            item.style.background = '';
            item.style.transform = '';
            item.style.boxShadow = '';
            item.style.borderColor = '';
        }
    });
}
