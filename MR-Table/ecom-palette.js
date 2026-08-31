// ECOM palette
// ============
// One source for the colours that carry meaning, read by both screens.
//
// They were declared three times - KIND_COLORS in animations/ecom-energy.js for
// the table, NODE_KINDS in controller/ecom-controls.js for the legend, and
// literal hexes throughout controller/ecom-controls.css - so a colour could be
// changed in one place and quietly disagree in another. The legend on the
// controller is only useful if it matches the table exactly.
//
// The CSS custom properties are set from the same map at load, so the
// stylesheet has no hex of its own to drift from.
//
// Exposes globals: ECOM_PALETTE

(function () {
    'use strict';

    // What each kind of node is, and every flow leaving one.
    //
    // Teal grid, pink buildings, yellow solar, red battery - the colours the
    // ECOM dashboard's 2D viewer uses, so a node is the same colour in both.
    //
    // A flow is no longer painted in one of these. It runs as a gradient from
    // the colour of where it leaves to the colour of where it arrives, so a
    // roof array charging the battery reads yellow at one end and red at the
    // other, and which way it is going is in the picture rather than in a key.
    const SEMANTIC = {
        building: '#ff00a6',
        pv: '#eaff00',
        grid: '#00ffe5',
        battery: '#fa3600',
        charge_point: '#00ff5e'
    };

    // The panel's own furniture. Quiet on purpose: neon is for what the data
    // means, and a control that shouts as loudly as a measurement makes the
    // measurement harder to find.
    const CHROME = {
        ink: '#e8e8e8',
        inkDim: '#9a9a9a',
        inkFaint: '#7d7d7d',
        panel: '#2f2f2f',
        panelRaised: '#383838',
        line: '#454545',
        lineStrong: '#5c6b7d',
        // Primary action: neutral high-contrast rather than a semantic colour,
        // which on a button would claim a meaning the button does not have.
        action: '#e8eef6',
        actionInk: '#141a22',
        ok: '#7dffb0',
        warn: '#ffc247',
        error: '#ff9d7a'
    };

    function apply() {
        const root = document.documentElement;
        if (!root || !root.style) return;
        Object.keys(SEMANTIC).forEach(function (key) {
            root.style.setProperty('--ecom-' + key.replace(/_/g, '-'), SEMANTIC[key]);
        });
        Object.keys(CHROME).forEach(function (key) {
            const name = key.replace(/([A-Z])/g, '-$1').toLowerCase();
            root.style.setProperty('--ecom-' + name, CHROME[key]);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }
    // Also immediately: a stylesheet is parsed before DOMContentLoaded, and a
    // var() with no value falls back to nothing rather than to a sensible
    // colour, which shows up as an invisible control for one frame.
    apply();

    window.ECOM_PALETTE = { semantic: SEMANTIC, chrome: CHROME };
})();
