// ECOM Energy Dashboard
// =====================
// The right-hand column of the controller while the energy layer is up.
//
// It owns the column's markup and nothing else. Both cards in it are empty
// slots that controller/ecom-controls.js fills, because that file holds the
// dispatch the figures come from and the filter state the legend toggles -
// two files writing one innerHTML is how half a panel disappears.
//
// It used to render the numbers itself, from a summary the layer broadcast.
// That summary is a subset of the dispatch the controls already have, so the
// panel and the parameters beside it could disagree about the same community.
// Now there is one source.
//
// Exposes globals: renderEcomDashboard

function renderEcomDashboard() {
    const dashboardContent = document.getElementById('dashboard-content');
    const dashboardTitle = document.getElementById('dashboard-title');
    const legendTitle = document.getElementById('legend-title');

    if (dashboardTitle) dashboardTitle.textContent = 'Energy Community';
    // The left column carries the date and hour picker plus the apply bar
    // (controller/ecom-controls.js); the parameter groups sit in the full-width
    // band below, and the legend is a card in this panel now, merged with the
    // view filters that were a duplicate of it.
    if (legendTitle) legendTitle.textContent = 'Date & Time';
    if (!dashboardContent) return;

    // Two cards were dropped from here: a Community totals card whose figures
    // the Performance panel now carries in full, and a Selected building card
    // that sat empty saying "tap a building" whether or not anything had been
    // tapped. A tap now shows as a strip inside Performance, and only when
    // there is a selection to show.
    dashboardContent.innerHTML = `
        <div class="dashboard-container">
            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">gradient</span>
                    Legend &amp; View
                </div>
                <div id="ecom-view" class="ecom-view"></div>
            </div>

            <div class="dashboard-card">
                <div class="dashboard-section-title">
                    <span class="material-icons" style="font-size: 18px;">insights</span>
                    Community Performance
                </div>
                <div id="ecom-kpis" class="ecom-kpis"></div>
            </div>
        </div>
    `;

    // Rebuilding the column replaced both slots, so their contents go back in.
    if (typeof renderEcomView === 'function') renderEcomView();
    if (typeof renderEcomKpis === 'function') renderEcomKpis();
}
