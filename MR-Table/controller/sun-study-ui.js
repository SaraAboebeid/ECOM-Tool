// Sun Study UI (extracted from controller.js)
// =============================================
// Handles sky visualization, solar calculations, and sun study layout.
// Exposes globals: sunStudyState, setSunStudyLayout, updateSunStudySky,
//   lerp, lerpColor, getSkyPalette, formatSunDate, calculateSunriseSunset,
//   formatTimeHHMM, calculateSunAltitude, getMaxSunAltitude, MAX_POSSIBLE_ALTITUDE,
//   generateSunArcPath

// Sun Study UI state
let sunStudyState = {
    time: 12,
    date: new Date().toISOString().split('T')[0],
    altitude: null
};

function setSunStudyLayout(isActive) {
    const mainPanel = document.getElementById('main-panel');
    const legendSection = document.getElementById('legend-section');
    const dashboardSection = document.getElementById('dashboard-section');
    const metadataSection = document.getElementById('metadata-section');
    const metadataTitle = metadataSection?.querySelector('h2');

    if (!mainPanel || !legendSection || !dashboardSection || !metadataSection) {
        console.warn('[SunStudy] Missing elements for layout switch');
        return;
    }

    if (isActive) {
        mainPanel.classList.add('sun-study-mode');
        legendSection.classList.add('sun-study-hidden');
        dashboardSection.classList.add('sun-study-hero');
        metadataSection.classList.add('sun-study-bottom');
        if (metadataTitle) metadataTitle.textContent = 'Sun Study Controls';
    } else {
        mainPanel.classList.remove('sun-study-mode');
        legendSection.classList.remove('sun-study-hidden');
        dashboardSection.classList.remove('sun-study-hero');
        metadataSection.classList.remove('sun-study-bottom');
        if (metadataTitle) metadataTitle.textContent = 'Metadata';
        
        // Restore default content when exiting sun study mode
        const dashboardContent = document.getElementById('dashboard-content');
        const legendContent = document.getElementById('legend-content');
        const dashboardTitle = document.getElementById('dashboard-title');
        const legendTitle = document.getElementById('legend-title');
        const metadataContent = document.getElementById('metadata-content');
        
        if (dashboardTitle) dashboardTitle.textContent = 'Dashboard';
        if (legendTitle) legendTitle.textContent = 'Legend';
        if (dashboardContent) dashboardContent.innerHTML = '<p>No active data.</p>';
        if (legendContent) legendContent.innerHTML = '<p>Select a simulation to view its legend.</p>';
        if (metadataContent) {
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
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
    return [
        Math.round(lerp(c1[0], c2[0], t)),
        Math.round(lerp(c1[1], c2[1], t)),
        Math.round(lerp(c1[2], c2[2], t))
    ];
}

function getSkyPalette(time, sunrise = 6, sunset = 18, maxAltitude = 56) {
    const nightTop = [11, 16, 32];
    const nightMid = [27, 43, 85];
    const nightBottom = [43, 59, 107];

    const dawnTop = [32, 44, 88];
    const dawnMid = [102, 120, 191];
    const dawnBottom = [255, 183, 111];

    // Adjust day colors based on sun altitude
    const altitudeRatio = Math.min(1, Math.max(0, maxAltitude / MAX_POSSIBLE_ALTITUDE));
    
    const summerDayTop = [64, 139, 255];
    const summerDayMid = [125, 190, 255];
    const summerDayBottom = [255, 224, 168];
    
    const winterDayTop = [85, 130, 200];
    const winterDayMid = [150, 175, 210];
    const winterDayBottom = [255, 210, 150];
    
    const dayTop = lerpColor(winterDayTop, summerDayTop, altitudeRatio);
    const dayMid = lerpColor(winterDayMid, summerDayMid, altitudeRatio);
    const dayBottom = lerpColor(winterDayBottom, summerDayBottom, altitudeRatio);

    const duskTop = [36, 52, 97];
    const duskMid = [255, 130, 92];
    const duskBottom = [253, 206, 138];

    const dawnStart = sunrise - 1;
    const dawnEnd = sunrise + 1;
    const duskStart = sunset - 1;
    const duskEnd = sunset + 1;
    const solarNoon = (sunrise + sunset) / 2;

    const clampTime = Math.max(0, Math.min(24, time));
    let t;

    if (clampTime < dawnStart) {
        return { top: nightTop, mid: nightMid, bottom: nightBottom };
    }
    if (clampTime < sunrise) {
        t = (clampTime - dawnStart) / (sunrise - dawnStart);
        return {
            top: lerpColor(nightTop, dawnTop, t),
            mid: lerpColor(nightMid, dawnMid, t),
            bottom: lerpColor(nightBottom, dawnBottom, t)
        };
    }
    if (clampTime < solarNoon) {
        t = (clampTime - sunrise) / (solarNoon - sunrise);
        return {
            top: lerpColor(dawnTop, dayTop, t),
            mid: lerpColor(dawnMid, dayMid, t),
            bottom: lerpColor(dawnBottom, dayBottom, t)
        };
    }
    if (clampTime < duskStart) {
        t = (clampTime - solarNoon) / (duskStart - solarNoon);
        return {
            top: lerpColor(dayTop, dayTop, t),
            mid: lerpColor(dayMid, dayMid, t),
            bottom: lerpColor(dayBottom, dayBottom, t)
        };
    }
    if (clampTime < sunset) {
        t = (clampTime - duskStart) / (sunset - duskStart);
        return {
            top: lerpColor(dayTop, duskTop, t),
            mid: lerpColor(dayMid, duskMid, t),
            bottom: lerpColor(dayBottom, duskBottom, t)
        };
    }
    if (clampTime < duskEnd) {
        t = (clampTime - sunset) / (duskEnd - sunset);
        return {
            top: lerpColor(duskTop, nightTop, t),
            mid: lerpColor(duskMid, nightMid, t),
            bottom: lerpColor(duskBottom, nightBottom, t)
        };
    }
    return { top: nightTop, mid: nightMid, bottom: nightBottom };
}

function formatSunDate(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

function calculateSunriseSunset(dateStr) {
    const LATITUDE = 57.68839377903814;
    const date = new Date(dateStr);
    
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    
    const declination = 23.45 * Math.sin((360 / 365) * (dayOfYear - 81) * Math.PI / 180);
    
    const latRad = LATITUDE * Math.PI / 180;
    const declRad = declination * Math.PI / 180;
    
    const cosHourAngle = -Math.tan(latRad) * Math.tan(declRad);
    
    if (cosHourAngle < -1) {
        return { sunrise: 0, sunset: 24, isPolarDay: true, isPolarNight: false };
    } else if (cosHourAngle > 1) {
        return { sunrise: 12, sunset: 12, isPolarDay: false, isPolarNight: true };
    }
    
    const hourAngle = Math.acos(cosHourAngle) * 180 / Math.PI;
    const sunriseHour = 12 - hourAngle / 15;
    const sunsetHour = 12 + hourAngle / 15;
    
    return { 
        sunrise: sunriseHour, 
        sunset: sunsetHour,
        isPolarDay: false,
        isPolarNight: false
    };
}

function formatTimeHHMM(decimalHours) {
    const h = Math.floor(decimalHours);
    const m = Math.floor((decimalHours - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function calculateSunAltitude(dateStr, timeOfDay) {
    const LATITUDE = 57.68839377903814;
    const date = new Date(dateStr);
    
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    
    const declination = 23.45 * Math.sin((360 / 365) * (dayOfYear - 81) * Math.PI / 180);
    const hourAngle = (timeOfDay - 12.0) * 15;
    
    const latRad = LATITUDE * Math.PI / 180;
    const declRad = declination * Math.PI / 180;
    const hourRad = hourAngle * Math.PI / 180;
    
    const sinAlt = Math.sin(latRad) * Math.sin(declRad) + 
                   Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourRad);
    const altitude = Math.asin(sinAlt) * 180 / Math.PI;
    
    return altitude;
}

function getMaxSunAltitude(dateStr) {
    return calculateSunAltitude(dateStr, 12);
}

// Maximum possible sun altitude at this latitude (summer solstice)
const MAX_POSSIBLE_ALTITUDE = 56;

function generateSunArcPath(dateStr, sunrise, sunset) {
    const points = [];
    const horizonY = 78;
    const maxAltitude = getMaxSunAltitude(dateStr);
    const maxPeakHeight = 55;
    const peakHeight = (maxAltitude / MAX_POSSIBLE_ALTITUDE) * maxPeakHeight;
    
    const numPoints = 24;
    for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        const time = sunrise + t * (sunset - sunrise);
        const altitude = calculateSunAltitude(dateStr, time);
        
        const x = 10 + t * 80;
        const y = horizonY - (altitude / MAX_POSSIBLE_ALTITUDE) * maxPeakHeight;
        
        points.push({ x, y });
    }
    
    if (points.length < 2) return 'M10 78 L90 78';
    
    let path = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    
    for (let i = 1; i < points.length - 1; i++) {
        const p0 = points[i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];
        
        const cp1x = p0.x + (p1.x - p0.x) * 0.5;
        const cp1y = p0.y + (p1.y - p0.y) * 0.5;
        const cp2x = p1.x - (p2.x - p0.x) * 0.15;
        const cp2y = p1.y - (p2.y - p0.y) * 0.15;
        
        path += ` S${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
    }
    
    const last = points[points.length - 1];
    path += ` L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
    
    return path;
}

function updateSunStudySky(timeValue, dateValue, altitudeValue) {
    const sky = document.getElementById('sun-sky');
    const timeLabel = document.getElementById('sun-time-label');
    const dateLabel = document.getElementById('sun-date-label');
    const sunriseLabel = document.getElementById('sunrise-time');
    const sunsetLabel = document.getElementById('sunset-time');
    if (!sky) return;

    const time = typeof timeValue === 'number' ? timeValue : sunStudyState.time;
    const date = dateValue || sunStudyState.date;

    sunStudyState.time = time;
    sunStudyState.date = date;
    if (altitudeValue !== undefined) sunStudyState.altitude = altitudeValue;

    const sunTimes = calculateSunriseSunset(date);
    const sunrise = sunTimes.sunrise;
    const sunset = sunTimes.sunset;
    
    if (sunriseLabel) sunriseLabel.textContent = formatTimeHHMM(sunrise);
    if (sunsetLabel) sunsetLabel.textContent = formatTimeHHMM(sunset);

    const calculatedAltitude = calculateSunAltitude(date, time);
    const maxAltitude = getMaxSunAltitude(date);
    
    const altitude = (typeof sunStudyState.altitude === 'number') 
        ? sunStudyState.altitude 
        : calculatedAltitude;
    
    const horizonY = 78;
    const maxPeakHeight = 55;
    let sunX, sunY, sunOpacity;
    
    const nightDuration = 24 - sunset + sunrise;
    
    if (time >= sunrise && time <= sunset) {
        const dayProgress = (time - sunrise) / (sunset - sunrise);
        sunX = 10 + dayProgress * 80;
        sunY = horizonY - (Math.max(0, altitude) / MAX_POSSIBLE_ALTITUDE) * maxPeakHeight;
        sunOpacity = 1;
    } else {
        let nightProgress;
        if (time > sunset) {
            nightProgress = (time - sunset) / nightDuration;
        } else {
            nightProgress = (24 - sunset + time) / nightDuration;
        }
        sunX = 90 - nightProgress * 80;
        sunY = horizonY + 20;
        sunOpacity = 0;
    }

    const maxAltitudeForDate = getMaxSunAltitude(date);
    const palette = getSkyPalette(time, sunrise, sunset, maxAltitudeForDate);
    sky.style.setProperty('--sky-top', `rgb(${palette.top.join(',')})`);
    sky.style.setProperty('--sky-mid', `rgb(${palette.mid.join(',')})`);
    sky.style.setProperty('--sky-bottom', `rgb(${palette.bottom.join(',')})`);
    sky.style.setProperty('--sun-x', `${sunX}%`);
    sky.style.setProperty('--sun-y', `${sunY}%`);
    sky.style.setProperty('--sun-opacity', `${sunOpacity}`);

    const sunPathSvg = sky.querySelector('.sun-path path');
    if (sunPathSvg) {
        const arcPath = generateSunArcPath(date, sunrise, sunset);
        sunPathSvg.setAttribute('d', arcPath);
    }

    if (timeLabel) {
        const h = Math.floor(time);
        const m = Math.floor((time - h) * 60);
        timeLabel.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    }
    if (dateLabel) {
        dateLabel.textContent = formatSunDate(date);
    }
}
