// ECOM Energy Dashboard
// =====================
// Controller panel for the ECOM energy community layer. Shows community totals
// and whichever building was last tapped on the table.
//
// The layer owns the data - this panel never fetches the export itself. It asks
// over the shared channel and renders whatever comes back, so the two cannot
// disagree about what is on the table.
//
// Exposes globals: renderEcomDashboard, ecomState

const ecomState = {
    summary: null,
    selection: null,
    hour: null,
    hours: 24
};

// What the table actually draws: node markers and the flows between them, in
// the same colours as the ECOM dashboard's 2D viewer. A flow takes the colour
// of the node it leaves.
const ECOM_KEY = [
    { color: '#ff00a6', label: 'Building' },
    { color: '#00ffe5', label: 'Grid' },
    { color: '#fa3600', label: 'Battery' },
    { color: '#00ff5e', label: 'Charge point' },
    { color: '#eaff00', label: 'Solar' }
];

function formatEcomEnergy(kwh) {
    if (kwh >= 1000) return (kwh / 1000).toFixed(1) + ' MWh';
    return Math.round(kwh).toLocaleString() + ' kWh';
}

function renderEcomDashboard() {
    const dashboardContent = document.getElementById('dashboard-content');
    const dashboardTitle = document.getElementById('dashboard-title');
    const legendTitle = document.getElementById('legend-title');

    if (dashboardTitle) dashboardTitle.textContent = 'Energy Community';
    if (legendTitle) legendTitle.textContent = 'Self-Sufficiency';
    if (!dashboardContent) return;

    const summary = ecomState.summary;
    const selection = ecomState.selection;

    // Until the layer is switched on there is nothing to report, and inventing
    // placeholder numbers here would be worse than saying so.
    const totals = summary
        ? `
            <div class="ecom-metrics">
                <div class="ecom-metric">
                    <span class="ecom-metric-value">${summary.selfSufficiency.toFixed(1)}%</span>
                    <span class="ecom-metric-label">Self-sufficient</span>
                </div>
                <div class="ecom-metric">
                    <span class="ecom-metric-value">${summary.members}</span>
                    <span class="ecom-metric-label">Members</span>
                </div>
                <div class="ecom-metric">
                    <span class="ecom-metric-value">${formatEcomEnergy(summary.demandKwh)}</span>
                    <span class="ecom-metric-label">Demand</span>
                </div>
                <div class="ecom-metric">
                    <span class="ecom-metric-value">${summary.pvKw.toFixed(0)} kW</span>
                    <span class="ecom-metric-label">Installed PV</span>
                </div>
            </div>
            <div class="ecom-period">${summary.period}</div>
        `
        : '<div class="ecom-empty">Switch the layer on to load the community.</div>';

    const selected = selection
        ? `
            <div class="ecom-selected-name">${selection.name}</div>
            <div class="ecom-selected-rows">
                <div><span>Self-sufficient</span><b>${selection.self_sufficiency.toFixed(1)}%</b></div>
                <div><span>Demand</span><b>${formatEcomEnergy(selection.demand_kwh)}</b></div>
                <div><span>From grid</span><b>${formatEcomEnergy(selection.grid_kwh)}</b></div>
                <div><span>Solar used</span><b>${formatEcomEnergy(selection.solar_kwh)}</b></div>
                <div><span>Installed PV</span><b>${selection.pv_kw.toFixed(1)} kW</b></div>
            </div>
        `
        : '<div class="ecom-empty">Tap a building on the table.</div>';

    const legend = ECOM_KEY.map(function (entry) {
        return `
            <div class="ecom-legend-row">
                <span class="ecom-swatch" style="background:${entry.color}"></span>
                <span>${entry.label}</span>
            </div>
        `;
    }).join('');

    dashboardContent.innerHTML = `
        <div class="dashboard-container">
            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">bolt</span>
                    Community
                </div>
                ${totals}
                ${ecomState.hour === null ? '' : `
                    <div class="ecom-clock">
                        <span class="material-icons" style="font-size:15px;">schedule</span>
                        <span id="ecom-clock-time">${String(ecomState.hour).padStart(2, '0')}:00</span>
                        <span class="ecom-clock-note">of ${ecomState.hours} h, playing</span>
                    </div>
                `}
            </div>

            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">apartment</span>
                    Selected building
                </div>
                ${selected}
            </div>

            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">gradient</span>
                    Legend
                </div>
                <div class="ecom-legend">${legend}</div>
                <div class="ecom-legend-note">
                    Line width follows flow size. Only community members are
                    marked - the rest of the campus is basemap and model.
                </div>
            </div>
        </div>
    `;
}

// The layer broadcasts totals when it activates and a selection on each tap.
// Re-rendering only while the panel is showing keeps this off the critical path
// when another layer is up.
(function () {
    'use strict';

    const channel = new BroadcastChannel('map_controller_channel');

    function isShowing() {
        const btn = document.querySelector('.control-btn[data-target="ecom-energy-btn"]');
        return btn && btn.classList.contains('active');
    }

    channel.addEventListener('message', function (event) {
        const data = event.data || {};

        if (data.type === 'ecom_summary' && data.summary) {
            ecomState.summary = data.summary;
            if (isShowing()) renderEcomDashboard();
        }

        // The table runs the day on its own; this only reports where it is.
        // Patched in place rather than re-rendered: the clock ticks every
        // second and rebuilding the panel each time would discard the reader's
        // scroll position for a two-character change.
        if (data.type === 'ecom_clock' && typeof data.hour === 'number') {
            const first = ecomState.hour === null;
            ecomState.hour = data.hour;
            ecomState.hours = data.hours || ecomState.hours;
            if (!isShowing()) return;

            const el = document.getElementById('ecom-clock-time');
            if (el && !first) {
                el.textContent = String(data.hour).padStart(2, '0') + ':00';
            } else {
                renderEcomDashboard();
            }
        }

        if (data.type === 'ecom_selection' && data.building) {
            ecomState.selection = data.building;
            if (isShowing()) renderEcomDashboard();
        }

        // The layer went away; drop the selection so a stale building cannot
        // sit in the panel describing something no longer drawn.
        if (data.type === 'animation_state' &&
            data.animationId === 'ecom-energy-btn' &&
            data.isActive === false) {
            ecomState.selection = null;
        }
    });
})();
