// Bird Dashboard (extracted from controller.js)
// =============================================
// Handles the bird sounds active birds display.
// Exposes globals: updateBirdDashboard

function updateBirdDashboard(activeBirds) {
    const container = document.getElementById('active-birds-container');
    if (!container) return;

    // Only update if Bird Sounds is the active layer (checked via button state)
    const birdBtn = document.querySelector('.control-btn[data-target="bird-sounds-btn"]');
    if (!birdBtn || !birdBtn.classList.contains('active')) return;

    if (!activeBirds || activeBirds.length === 0) {
        container.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-section-title">Active Birds</div>
                <p>Listening for bird calls...</p>
            </div>
        `;
        return;
    }

    let html = `
        <style>
            .bird-card {
                background: #fff;
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                margin-bottom: 6px;
                border-left: 3px solid transparent;
                display: flex;
                height: 50px;
            }
            .bird-image-container {
                width: 50px;
                height: 50px;
                flex-shrink: 0;
            }
            .bird-image {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            .bird-info {
                padding: 4px 8px;
                flex-grow: 1;
                display: flex;
                align-items: center;
                gap: 8px;
                overflow: hidden;
            }
            .bird-name {
                font-weight: 600;
                font-size: 0.8rem;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                min-width: 0;
            }
            .sensor-info {
                font-size: 0.7rem;
                color: #888;
                display: flex;
                align-items: center;
                gap: 2px;
                flex-shrink: 0;
            }
            
            /* CSS Waveform Animation */
            .waveform-visualizer {
                display: flex;
                align-items: center;
                gap: 1px;
                height: 20px;
                flex-shrink: 0;
            }
            .wave-bar {
                width: 2px;
                background-color: #ccc;
                animation: wave 1s ease-in-out infinite;
                border-radius: 1px;
            }
            @keyframes wave {
                0%, 100% { height: 20%; }
                50% { height: 100%; }
            }
        </style>
        <div class="dashboard-card" style="padding: 0.5rem;">
            <div class="dashboard-section-title" style="margin-bottom: 0.5rem; font-size: 0.85rem;">Active Birds</div>
            <div style="display: flex; flex-direction: column;">
    `;

    activeBirds.forEach(item => {
        // Generate random animation delays for a more organic look
        const bars = Array.from({length: 8}, (_, i) => {
            const delay = Math.random() * 1;
            return `<div class="wave-bar" style="background-color: ${item.bird.color}; animation-delay: -${delay}s;"></div>`;
        }).join('');

        html += `
            <div class="bird-card" style="border-left-color: ${item.bird.color};">
                <div class="bird-image-container">
                    <img src="${item.bird.image}" alt="${item.bird.name}" class="bird-image">
                </div>
                <div class="bird-info">
                    <div class="bird-name" style="color: ${item.bird.color};">${item.bird.name}</div>
                    <div class="sensor-info">
                        <span class="material-icons" style="font-size: 10px;">sensors</span>
                        #${item.sensor.id}
                    </div>
                    <div class="waveform-visualizer">
                        ${bars}
                    </div>
                </div>
            </div>
        `;
    });
    html += '</div></div>';
    container.innerHTML = html;
}
