// Tour Logic (extracted from controller.js)
// =============================================
// Handles the welcome tour that cycles through features.
// Exposes globals: tourSteps, startTour, nextTourStep, showTourStep, stopTour
// Depends on: setEffect() from bg-animation.js (resolved at call time)

const tourSteps = [
    { selector: '[data-target="cfd-simulation-btn"]', title: 'CFD Wind Simulation', desc: 'Visualize wind flow patterns and speeds around buildings.' },
    { selector: '[data-target="stormwater-btn"]', title: 'Stormwater Flow', desc: 'Simulate water accumulation and flood risks during heavy rain.' },
    { selector: '[data-target="sun-study-btn"]', title: 'Sun Study', desc: 'Analyze sunlight exposure and shadows throughout the day.' },
    { selector: '[data-target="slideshow-btn"]', title: 'Slideshow', desc: 'Cycle through curated project views and visualizations.' },
    { selector: '[data-target="grid-animation-btn"]', title: 'Grid Animation', desc: 'Toggle the animated grid overlay for spatial reference.' },
    { selector: '[data-target="isovist-btn"]', title: 'Interactive Isovist', desc: 'Analyze visibility fields from specific vantage points.' },
    { selector: '[data-target="bird-sounds-btn"]', title: 'Bird Sounds', desc: 'Listen to simulated bird sensors and view real-time activity.' },
    { selector: '#reset-view-btn', title: 'Reset View', desc: 'Return the map to the default starting position.' },
    { selector: '#fullscreen-btn', title: 'Full Screen', desc: 'Toggle full screen mode for this controller.' }
];

let tourInterval;
let currentStep = 0;
const tourInfo = document.getElementById('tour-info');
const tourTitle = document.getElementById('tour-title');
const tourDesc = document.getElementById('tour-desc');

function startTour() {
    if (tourInterval) clearInterval(tourInterval);
    currentStep = 0;
    tourInfo.classList.add('active');
    showTourStep();
    tourInterval = setInterval(nextTourStep, 4000); // 4 seconds per step
}

function nextTourStep() {
    currentStep = (currentStep + 1) % tourSteps.length;
    showTourStep();
}

function showTourStep() {
    // Note: We no longer highlight buttons during tour to avoid confusion
    // with actually selected/active buttons
    
    const step = tourSteps[currentStep];
    
    // Update text with fade effect
    tourInfo.style.opacity = 0;
    setTimeout(() => {
        tourTitle.textContent = step.title;
        tourDesc.textContent = step.desc;
        tourInfo.style.opacity = 1;
    }, 300);

    // Set background effect
    if (step.selector.includes('cfd')) setEffect('wind');
    else if (step.selector.includes('stormwater')) setEffect('rain');
    else if (step.selector.includes('sun')) setEffect('sun');
    else if (step.selector.includes('isovist')) setEffect('isovist');
    else if (step.selector.includes('grid')) setEffect('grid');
    else if (step.selector.includes('slideshow')) setEffect('slideshow');
    else if (step.selector.includes('bird-sounds')) setEffect('soundwaves');
    else setEffect('default');
}

function stopTour() {
    if (tourInterval) {
        clearInterval(tourInterval);
        tourInterval = null;
    }
    tourInfo.classList.remove('active');
    setEffect('default'); // Stop effects
}
