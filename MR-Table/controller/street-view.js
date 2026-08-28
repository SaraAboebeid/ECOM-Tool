// Street View + SAM Segmentation (extracted from controller.js)
// =============================================
// Handles Street View Static API and SAM segmentation.
// Exposes globals: streetViewApiKey, loadStreetViewConfig, initStreetViewControls,
//   updateStreetViewImage, updateStreetViewPosition, SAM_SERVER_URL,
//   setSamStatus, checkSamServer, renderSegmentationBarChart, initSamSegmentation

let streetViewApiKey = null;
let streetViewCurrentPosition = null;
let streetViewCurrentHeading = 0;

async function loadStreetViewConfig() {
    if (streetViewApiKey) return true;
    try {
        const response = await fetch('trafik-config.json');
        const config = await response.json();
        streetViewApiKey = config.streetViewApiKey;
        console.log('Street View API key loaded');
        return true;
    } catch (e) {
        console.warn('Could not load Street View API key:', e);
        return false;
    }
}

function initStreetViewControls() {
    const leftBtn = document.getElementById('sv-rotate-left');
    const rightBtn = document.getElementById('sv-rotate-right');
    
    if (leftBtn) {
        leftBtn.addEventListener('click', () => {
            streetViewCurrentHeading = (streetViewCurrentHeading - 45 + 360) % 360;
            if (streetViewCurrentPosition) {
                updateStreetViewImage();
            }
        });
    }
    
    if (rightBtn) {
        rightBtn.addEventListener('click', () => {
            streetViewCurrentHeading = (streetViewCurrentHeading + 45) % 360;
            if (streetViewCurrentPosition) {
                updateStreetViewImage();
            }
        });
    }
}

function updateStreetViewImage() {
    const img = document.getElementById('street-view-image');
    const noCoverageMsg = document.getElementById('street-view-no-coverage');
    const coordsDisplay = document.getElementById('street-view-coords');
    const controls = document.getElementById('street-view-heading-controls');
    
    if (!img || !streetViewApiKey || !streetViewCurrentPosition) return;
    
    const { lat, lng } = streetViewCurrentPosition;
    
    // Update coordinates display
    if (coordsDisplay) {
        coordsDisplay.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)} | Heading: ${streetViewCurrentHeading}°`;
    }
    
    // Build Street View Static API URL
    const size = '640x350';
    const url = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${lat},${lng}&heading=${streetViewCurrentHeading}&pitch=0&fov=100&key=${streetViewApiKey}`;
    
    // Set up image load handlers
    img.onload = () => {
        // Check if we got an actual image (not the "no imagery" placeholder)
        // The static API returns a gray image with text if no coverage
        img.style.display = 'block';
        if (noCoverageMsg) noCoverageMsg.style.display = 'none';
        if (coordsDisplay) coordsDisplay.style.display = 'block';
        if (controls) controls.style.display = 'flex';
    };
    
    img.onerror = () => {
        img.style.display = 'none';
        if (coordsDisplay) coordsDisplay.style.display = 'none';
        if (noCoverageMsg) {
            noCoverageMsg.innerHTML = `
                <span style="font-size: 48px; margin-bottom: 12px;">📷</span>
                <span style="font-size: 16px; margin-bottom: 4px;">No Street View Coverage</span>
                <span style="font-size: 12px; color: #555;">Try clicking a different location on the map</span>
            `;
            noCoverageMsg.style.display = 'flex';
        }
        if (controls) controls.style.display = 'none';
    };
    
    img.src = url;
}

function updateStreetViewPosition(position, heading) {
    streetViewCurrentPosition = position;
    // Use provided heading or keep current if not provided
    if (heading !== undefined) {
        streetViewCurrentHeading = Math.round(heading);
    }
    
    // Load API key if needed
    if (!streetViewApiKey) {
        loadStreetViewConfig().then(hasKey => {
            if (hasKey) {
                updateStreetViewImage();
            }
        });
        return;
    }
    
    updateStreetViewImage();
}

// --- SAM Segmentation (Controller side) ---
const SAM_SERVER_URL = 'http://localhost:8000';

function setSamStatus(msg, ok) {
    const el = document.getElementById('sam-server-status');
    if (!el) return;
    el.textContent = 'SAM Server: ' + msg;
    el.style.color = ok ? '#22c55e' : '#ef4444';
}

async function checkSamServer() {
    try {
        const r = await fetch(SAM_SERVER_URL + '/');
        if (r.ok) {
            setSamStatus('Ready', true);
            return true;
        }
    } catch (e) {
        // ignore
    }
    setSamStatus('Unavailable', false);
    return false;
}

// Render an interactive SVG pie chart for segmentation categories
function renderSegmentationBarChart(segData) {
    const container = document.getElementById('sam-pie-chart');
    if (!container) return;

    const cats = (segData && segData.categories) ? segData.categories : {};
    const entries = Object.entries(cats).map(([k,v]) => ({
        name: k,
        percent: (v && v.pixel_ratio_percent) ? parseFloat(v.pixel_ratio_percent) : 0
    })).filter(e => e.percent > 0 || e.name === 'Open View' || e.name === 'Trees');

    if (entries.length === 0) {
        container.innerHTML = '<div style="color:#aaa; font-size:0.95rem;">No segmentation categories to display</div>';
        return;
    }

    // Distinct, intuitive palette
    const palette = {
        'Open View': '#1f78b4',
        'Trees': '#33a02c',
        'Bostad': '#e31a1c',
        'Verksamhet': '#ff7f00',
        'Samhällsfunktion': '#6a3d9a',
        'Komplementbyggnad': '#b15928',
        'Unknown': '#8c8c8c'
    };
    // Assign colors, fallback to palette cycling
    const fallback = ['#1f78b4','#33a02c','#e31a1c','#ff7f00','#6a3d9a','#b15928','#8c8c8c'];
    entries.forEach((e,i) => {
        e.color = palette[e.name] || fallback[i % fallback.length];
    });

    // Build bar chart
    container.innerHTML = '';
    const chart = document.createElement('div');
    chart.style.display = 'flex';
    chart.style.flexDirection = 'column';
    chart.style.gap = '8px';

    const total = entries.reduce((s,e)=>s+e.percent,0) || 1;
    entries.sort((a,b)=>b.percent - a.percent).forEach((e, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';

        const label = document.createElement('div');
        label.textContent = e.name;
        label.style.width = '110px';
        label.style.color = '#ddd';
        label.style.fontSize = '0.95rem';

        const barWrap = document.createElement('div');
        barWrap.style.flex = '1';
        barWrap.style.background = 'rgba(255,255,255,0.04)';
        barWrap.style.height = '18px';
        barWrap.style.borderRadius = '6px';
        barWrap.style.overflow = 'hidden';

        const bar = document.createElement('div');
        bar.style.height = '100%';
        bar.style.width = Math.max(1, (e.percent/total)*100) + '%';
        bar.style.background = e.color;
        bar.style.transition = 'width 0.2s, opacity 0.12s, transform 0.12s';

        const pct = document.createElement('div');
        pct.textContent = e.percent.toFixed(1) + '%';
        pct.style.width = '56px';
        pct.style.textAlign = 'right';
        pct.style.color = '#ddd';

        barWrap.appendChild(bar);
        row.appendChild(label);
        row.appendChild(barWrap);
        row.appendChild(pct);

        // interactions
        row.addEventListener('mouseenter', () => { bar.style.transform = 'scaleY(1.04)'; bar.style.opacity = '0.95'; showBarTooltip(e.name, e.percent, row); });
        row.addEventListener('mouseleave', () => { bar.style.transform = 'scaleY(1)'; bar.style.opacity = '1'; hideBarTooltip(); });
        row.addEventListener('click', () => {
            // toggle dimming
            const siblings = chart.querySelectorAll('div[data-role="bar-row"]');
            const isActive = row.getAttribute('data-active') === '1';
            siblings.forEach(s => { s.querySelector('div > div').style.opacity = '0.35'; s.setAttribute('data-active','0'); });
            if (!isActive) { row.querySelector('div > div').style.opacity = '1'; row.setAttribute('data-active','1'); }
        });

        row.setAttribute('data-role','bar-row');
        chart.appendChild(row);
    });

    // Tooltip
    let tooltip = container.querySelector('.bar-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'bar-tooltip';
        tooltip.style.position = 'absolute';
        tooltip.style.padding = '6px 8px';
        tooltip.style.background = 'rgba(0,0,0,0.85)';
        tooltip.style.color = '#fff';
        tooltip.style.borderRadius = '6px';
        tooltip.style.fontSize = '0.9rem';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.display = 'none';
        container.style.position = 'relative';
        container.appendChild(tooltip);
    }
    function showBarTooltip(name, pct, anchor) {
        tooltip.textContent = `${name}: ${pct.toFixed(2)}%`;
        tooltip.style.display = 'block';
        const rect = anchor.getBoundingClientRect();
        const parentRect = container.getBoundingClientRect();
        tooltip.style.left = Math.max(8, rect.left - parentRect.left + 8) + 'px';
        tooltip.style.top = (rect.top - parentRect.top - 34) + 'px';
    }
    function hideBarTooltip() { tooltip.style.display = 'none'; }

    container.appendChild(chart);
}

async function initSamSegmentation() {
    const btn = document.getElementById('sam-segment-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const img = document.getElementById('street-view-image');
        if (!img || !img.src || img.style.display === 'none') {
            alert('No Street View image available to segment');
            return;
        }

        const available = await checkSamServer();
        if (!available) {
            alert('SAM server not available at ' + SAM_SERVER_URL);
            return;
        }

        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = 'Segmenting...';
        setSamStatus('Processing...', true);

        try {
            const imageResp = await fetch(img.src);
            const imageBlob = await imageResp.blob();
            const fd = new FormData();
            fd.append('file', imageBlob, 'streetview.jpg');

            const resp = await fetch(SAM_SERVER_URL + '/segment', {
                method: 'POST',
                body: fd
            });

            if (!resp.ok) throw new Error('Server returned ' + resp.status);

            // If server returns JSON (mask as data URL + results), prefer that
            const contentType = (resp.headers.get('content-type') || '').toLowerCase();
            let segData = null;
            if (contentType.includes('application/json')) {
                const body = await resp.json();
                segData = body.results || body;

                // If mask is provided as a data URL, use it directly
                if (body.mask) {
                    const maskContainer = document.getElementById('sam-mask-container');
                    if (maskContainer) {
                        maskContainer.innerHTML = `<img src="${body.mask}" style="max-width:100%; border-radius:8px; border:2px solid #444; margin-bottom:0.5rem;" alt="Segmentation Mask" />`;
                    }
                }
            } else {
                // Older server: image blob + header JSON
                const maskBlob = await resp.blob();
                const segJson = resp.headers.get('X-Segmentation-JSON');

                // Prefer explicit mask file (e.g. *_mask.png) referenced in segmentation JSON
                let finalMaskBlob = maskBlob;
                if (segJson) {
                    try {
                        const data = JSON.parse(segJson);
                        const candidates = [];
                        if (data.mask_url) candidates.push(data.mask_url);
                        if (data.mask) candidates.push(data.mask);
                        if (data.mask_filename) candidates.push(data.mask_filename);
                        if (data.files && typeof data.files === 'object') {
                            Object.values(data.files).forEach(v => candidates.push(v));
                        }
                        if (data.output_files && typeof data.output_files === 'object') {
                            Object.values(data.output_files).forEach(v => candidates.push(v));
                        }

                        let chosen = null;
                        for (const c of candidates) {
                            if (!c) continue;
                            const s = String(c);
                            if (/mask/i.test(s) || /_mask\./i.test(s)) { chosen = s; break; }
                            if (/https?:\/\/.+\.(png|jpg|jpeg|webp)$/i.test(s)) { chosen = s; break; }
                        }

                        if (chosen) {
                            const candidateUrl = (/^https?:\/\//i.test(chosen)) ? chosen : (SAM_SERVER_URL + '/' + chosen.replace(/^\//, ''));
                            try {
                                const r2 = await fetch(candidateUrl);
                                if (r2.ok) {
                                    const b2 = await r2.blob();
                                    const ct = r2.headers.get('content-type') || '';
                                    if (ct.startsWith('image/') || b2.size > 0) {
                                        finalMaskBlob = b2;
                                    }
                                }
                            } catch (e) {
                                // ignore and fall back to returned blob
                            }
                        }
                        segData = data;
                    } catch (e) {
                        // invalid JSON - ignore
                    }
                }

                // Display mask
                const maskUrl = URL.createObjectURL(finalMaskBlob);
                const maskContainer = document.getElementById('sam-mask-container');
                if (maskContainer) {
                    maskContainer.innerHTML = `<img src="${maskUrl}" style="max-width:100%; border-radius:8px; border:2px solid #444; margin-bottom:0.5rem;" alt="Segmentation Mask" />`;
                }

                // If segData still null and segJson existed, segData was set above; otherwise try parse header
                if (!segData && segJson) {
                    try { segData = JSON.parse(segJson); } catch (e) { segData = null; }
                }
            }

            // Display class table and pie chart from segData if available
            if (segData) {
                const data = segData;
                const cats = data.categories || {};
                const palette = {
                    'Open View': '#1f78b4',
                    'Trees': '#33a02c',
                    'Bostad': '#e31a1c',
                    'Verksamhet': '#ff7f00',
                    'Samhällsfunktion': '#6a3d9a',
                    'Komplementbyggnad': '#b15928',
                    'Unknown': '#8c8c8c'
                };
                let table = '<table style="width:100%; font-size:1rem; color:#eee; border-collapse:collapse;">';
                table += '<tr><th style="text-align:left; color:#60a5fa;">Class</th></tr>';
                Object.entries(cats).sort((a,b)=> (b[1].pixel_ratio_percent||0) - (a[1].pixel_ratio_percent||0)).forEach(([cat, val]) => {
                    const color = palette[cat] || '#777';
                    table += `<tr><td style="padding:6px 4px; display:flex; align-items:center; gap:8px;"><span style="width:12px; height:12px; background:${color}; display:inline-block; border-radius:2px;"></span><span>${cat}</span></td></tr>`;
                });
                table += '</table>';
                const classTable = document.getElementById('sam-class-table');
                if (classTable) classTable.innerHTML = table;

                // Render interactive pie chart
                try { renderSegmentationBarChart(data); } catch (e) { console.error('Bar chart render error', e); }
            } else {
                const pieContainer = document.getElementById('sam-pie-chart');
                if (pieContainer) pieContainer.innerHTML = '';
            }

            setSamStatus('Done', true);
        } catch (err) {
            console.error('Segmentation error', err);
            setSamStatus('Error', false);
            alert('Segmentation failed: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    });

    // initial check
    checkSamServer();

    // Bind Spacebar to trigger segmentation (only when street-view is active)
    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        // Ignore if modifier keys are held
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
        // Only trigger when street-view is the active animation
        const streetViewBtn = document.querySelector('.control-btn[data-target="street-view-btn"]');
        if (!streetViewBtn || !streetViewBtn.classList.contains('active')) return;
        // Prevent page scroll
        e.preventDefault();
        // Only trigger if button exists
        const segBtn = document.getElementById('sam-segment-btn');
        if (segBtn && !segBtn.disabled) {
            segBtn.click();
        }
    });
}

// bind when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSamSegmentation);
} else {
    initSamSegmentation();
}
