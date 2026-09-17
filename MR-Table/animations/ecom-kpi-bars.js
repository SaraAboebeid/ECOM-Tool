// ECOM KPI bars - the community's two headline figures along the table's edges.
//
// One along the top of the display and one along the bottom, each showing a
// figure that moves when the community does: panels added, a charger added, a
// building leaving. The numbers glide to their new values and a chip says by how
// much and whether that was the better way, so a change on the panel reads on
// the table as a consequence and not only as a picture.
//
// WHICH TWO. Not settled yet, so it is a choice here and not a design: set TOP
// and BOTTOM to any key in KPIS. Every one of them is a ratio. The table's
// opening picture is a 24-hour export and a live change dispatches the
// definition's own period (48 hours), so an absolute total - "124 MWh bought" -
// would double the first time anyone touched the panel while nothing had got
// better or worse. A share of demand does not.
//
// Hidden during the introduction - the community is not running yet, and a
// self-sufficiency figure for something that has not been assembled answers a
// question nobody has asked - and faded in when it finishes.
//
// Listens on the controller channel for: ecom_kpis (from ecom-energy.js),
// ecom_caption (a step of the introduction), ecom_release, animation_state.
//
// Exposes globals: ecomKpiBars

(function () {
    'use strict';

    const TOP = 'self_sufficiency';
    const BOTTOM = 'grid_exchange';

    // The top bar is turned to face the far side of the table. People stand
    // round a projection table, and a strip of text along its far edge is read
    // by the people standing there, not by the ones who would see it upside
    // down. False if the display is on a wall.
    const FACE_FAR_SIDE = true;

    // Clear of the display's own sidebars.
    const EDGE_PX = 60;
    const GLIDE_MS = 1200;
    const CHIP_MS = 4500;

    const palette = (window.ECOM_PALETTE && window.ECOM_PALETTE.semantic) || {};
    const COLOURS = {
        pv: palette.pv || '#eaff00',
        grid: palette.grid || '#00ffe5',
        building: palette.building || '#ff00a6',
        better: '#4ade80',
        worse: '#f87171'
    };

    const share = function (part, whole) {
        return whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0;
    };

    const KPIS = {
        self_sufficiency: {
            label: 'Self-sufficiency',
            note: 'of the demand met inside the community',
            colour: COLOURS.pv,
            better: 'up',
            value: function (k) { return k.self_sufficiency || 0; }
        },
        self_consumption: {
            label: 'Self-consumption',
            note: 'of the solar used on campus',
            colour: COLOURS.pv,
            better: 'up',
            value: function (k) { return k.self_consumption || 0; }
        },
        grid_import: {
            label: 'Bought from the grid',
            note: 'of the demand',
            colour: COLOURS.grid,
            better: 'down',
            value: function (k) { return share(k.total_grid_import, k.total_demand); }
        },
        // One bar, two directions: bought grows left from the middle, sold
        // grows right. Reading both at once is the point - more panels push the
        // left side in and, once there is a surplus, the right side out.
        grid_exchange: {
            split: true,
            label: 'Grid',
            left: {
                label: 'bought', note: 'of demand', colour: COLOURS.grid, better: 'down',
                value: function (k) { return share(k.total_grid_import, k.total_demand); }
            },
            right: {
                label: 'sold', note: 'of generation', colour: COLOURS.pv, better: 'up',
                value: function (k) { return share(k.total_grid_export, k.total_pv_gen); }
            }
        }
    };

    // ------------------------------------------------------------------ DOM

    const style = document.createElement('style');
    style.textContent = [
        '.ecom-kpi-bar{position:fixed;left:' + EDGE_PX + 'px;right:' + EDGE_PX + 'px;',
        'height:46px;z-index:850;display:flex;align-items:center;gap:18px;',
        'padding:0 22px;box-sizing:border-box;pointer-events:none;',
        'background:rgba(6,9,12,0.82);color:#e8eef6;',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif;',
        'opacity:0;transition:opacity 700ms ease}',
        '.ecom-kpi-bar.is-on{opacity:1}',
        '.ecom-kpi-top{top:0;border-bottom:1px solid rgba(255,255,255,0.08)}',
        '.ecom-kpi-bottom{bottom:0;border-top:1px solid rgba(255,255,255,0.08)}',
        '.ecom-kpi-top.faces-far{transform:rotate(180deg)}',
        '.ecom-kpi-label{font-size:12px;letter-spacing:0.12em;text-transform:uppercase;',
        'opacity:0.7;white-space:nowrap}',
        '.ecom-kpi-value{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;',
        'min-width:88px;text-align:right;white-space:nowrap}',
        '.ecom-kpi-note{font-size:12px;opacity:0.55;white-space:nowrap}',
        '.ecom-kpi-track{flex:1;height:10px;border-radius:5px;position:relative;',
        'background:rgba(255,255,255,0.09);overflow:hidden}',
        '.ecom-kpi-fill{position:absolute;top:0;bottom:0;border-radius:5px}',
        '.ecom-kpi-mid{position:absolute;top:-4px;bottom:-4px;left:50%;width:2px;',
        'margin-left:-1px;background:rgba(255,255,255,0.35)}',
        '.ecom-kpi-chip{font-size:13px;font-weight:600;padding:3px 9px;border-radius:10px;',
        'white-space:nowrap;opacity:0;transition:opacity 400ms ease;',
        'font-variant-numeric:tabular-nums}',
        '.ecom-kpi-chip.is-on{opacity:1}'
    ].join('');
    document.head.appendChild(style);

    function makeBar(position) {
        const bar = document.createElement('div');
        bar.className = 'ecom-kpi-bar ecom-kpi-' + position +
            (position === 'top' && FACE_FAR_SIDE ? ' faces-far' : '');
        document.body.appendChild(bar);
        return bar;
    }

    const bars = { top: makeBar('top'), bottom: makeBar('bottom') };

    // What each bar is showing right now, mid-glide included.
    const shown = { top: null, bottom: null };
    const chipTimers = { top: null, bottom: null };
    let glideFrame = null;
    let glides = [];

    function fmt(value) {
        return (value < 10 ? value.toFixed(1) : value.toFixed(0)) + '%';
    }

    function render(position, key, values) {
        const spec = KPIS[key];
        const bar = bars[position];
        if (!spec || !values) return;

        if (spec.split) {
            const left = values.left;
            const right = values.right;
            bar.innerHTML =
                '<span class="ecom-kpi-label">' + spec.label + '</span>' +
                '<span class="ecom-kpi-value" style="color:' + spec.left.colour + '">' +
                    fmt(left) + '</span>' +
                '<span class="ecom-kpi-note">' + spec.left.label + ' &middot; ' +
                    spec.left.note + '</span>' +
                '<span class="ecom-kpi-chip" data-side="left"></span>' +
                '<div class="ecom-kpi-track">' +
                    '<div class="ecom-kpi-fill" style="right:50%;width:' +
                        (left / 2) + '%;background:' + spec.left.colour + '"></div>' +
                    '<div class="ecom-kpi-fill" style="left:50%;width:' +
                        (right / 2) + '%;background:' + spec.right.colour + '"></div>' +
                    '<div class="ecom-kpi-mid"></div>' +
                '</div>' +
                '<span class="ecom-kpi-chip" data-side="right"></span>' +
                '<span class="ecom-kpi-note">' + spec.right.label + ' &middot; ' +
                    spec.right.note + '</span>' +
                '<span class="ecom-kpi-value" style="color:' + spec.right.colour + '">' +
                    fmt(right) + '</span>';
            return;
        }

        bar.innerHTML =
            '<span class="ecom-kpi-label">' + spec.label + '</span>' +
            '<span class="ecom-kpi-value" style="color:' + spec.colour + '">' +
                fmt(values.value) + '</span>' +
            '<span class="ecom-kpi-chip" data-side="value"></span>' +
            '<div class="ecom-kpi-track">' +
                '<div class="ecom-kpi-fill" style="left:0;width:' + values.value +
                    '%;background:' + spec.colour + '"></div>' +
            '</div>' +
            '<span class="ecom-kpi-note">' + spec.note + '</span>';
    }

    function valuesFor(key, kpis) {
        const spec = KPIS[key];
        if (!spec) return null;
        if (spec.split) {
            return { left: spec.left.value(kpis), right: spec.right.value(kpis) };
        }
        return { value: spec.value(kpis) };
    }

    // A chip for each side that moved by a visible amount, green if it moved
    // the better way. Placed after the glide starts, so it rides on top of the
    // bar that is changing rather than appearing before it does.
    function showChips(position, key, from, to) {
        const spec = KPIS[key];
        const bar = bars[position];
        const sides = spec.split ? ['left', 'right'] : ['value'];
        let any = false;
        sides.forEach(function (side) {
            const delta = to[side] - from[side];
            const chip = bar.querySelector('.ecom-kpi-chip[data-side="' + side + '"]');
            if (!chip) return;
            if (Math.abs(delta) < 0.05) { chip.textContent = ''; return; }
            const better = (spec.split ? spec[side].better : spec.better) === 'up'
                ? delta > 0 : delta < 0;
            chip.textContent = (delta > 0 ? '+' : '−') + Math.abs(delta).toFixed(1) + ' pts';
            chip.style.color = '#081014';
            chip.style.background = better ? COLOURS.better : COLOURS.worse;
            chip.classList.add('is-on');
            any = true;
        });
        if (!any) return;
        if (chipTimers[position]) clearTimeout(chipTimers[position]);
        chipTimers[position] = setTimeout(function () {
            bar.querySelectorAll('.ecom-kpi-chip').forEach(function (chip) {
                chip.classList.remove('is-on');
            });
        }, CHIP_MS);
    }

    function step(now) {
        glideFrame = null;
        let running = false;
        glides.forEach(function (glide) {
            const t = Math.min(1, (now - glide.startedAt) / GLIDE_MS);
            const eased = 1 - Math.pow(1 - t, 3);
            const current = {};
            Object.keys(glide.to).forEach(function (side) {
                current[side] = glide.from[side] + (glide.to[side] - glide.from[side]) * eased;
            });
            shown[glide.position] = current;
            // Re-rendered each frame, so the chip has to be put back.
            const chips = {};
            bars[glide.position].querySelectorAll('.ecom-kpi-chip').forEach(function (c) {
                chips[c.dataset.side] = { text: c.textContent, style: c.style.cssText,
                                          on: c.classList.contains('is-on') };
            });
            render(glide.position, glide.key, current);
            bars[glide.position].querySelectorAll('.ecom-kpi-chip').forEach(function (c) {
                const was = chips[c.dataset.side];
                if (!was) return;
                c.textContent = was.text;
                c.style.cssText = was.style;
                if (was.on) c.classList.add('is-on');
            });
            if (t < 1) running = true;
        });
        glides = glides.filter(function (glide) {
            return now - glide.startedAt < GLIDE_MS;
        });
        if (running) glideFrame = requestAnimationFrame(step);
    }

    function update(kpis) {
        [['top', TOP], ['bottom', BOTTOM]].forEach(function (pair) {
            const position = pair[0];
            const key = pair[1];
            const to = valuesFor(key, kpis);
            if (!to) return;
            const from = shown[position];
            if (!from) {
                // The first figures: shown, not animated from nothing.
                shown[position] = to;
                render(position, key, to);
                return;
            }
            render(position, key, from);
            showChips(position, key, from, to);
            glides = glides.filter(function (g) { return g.position !== position; });
            glides.push({ position: position, key: key, from: from, to: to,
                          startedAt: performance.now() });
        });
        if (glideFrame === null && glides.length) {
            glideFrame = requestAnimationFrame(step);
        }
    }

    // ------------------------------------------------------------ visibility

    let layerOn = false;
    let inIntroduction = false;
    let haveFigures = false;
    // The figures arrive the moment the layer comes up, a beat before the
    // controller starts the introduction - shown at once, the bars flashed on
    // and straight back off. So they wait to see whether one is starting.
    let settled = false;

    function syncVisibility() {
        const on = layerOn && haveFigures && settled && !inIntroduction;
        bars.top.classList.toggle('is-on', on);
        bars.bottom.classList.toggle('is-on', on);
    }

    const channel = new BroadcastChannel('map_controller_channel');
    channel.addEventListener('message', function (event) {
        const data = event.data || {};

        if (data.type === 'ecom_kpis' && data.kpis) {
            // Figures only arrive while the energy layer is up, so they are
            // also the evidence that it is.
            layerOn = true;
            if (!haveFigures) {
                setTimeout(function () { settled = true; syncVisibility(); }, 1800);
            }
            haveFigures = true;
            update(data.kpis);
            syncVisibility();
            return;
        }

        if (data.type === 'animation_state' && data.animationId === 'ecom-energy-btn') {
            layerOn = !!data.isActive;
            syncVisibility();
            return;
        }

        // A step of the introduction carries a step number; leaving it, or
        // finishing it, clears the caption.
        if (data.type === 'ecom_caption') {
            inIntroduction = !!(data.caption && typeof data.caption.step === 'number');
            syncVisibility();
            return;
        }

        if (data.type === 'ecom_release') {
            inIntroduction = false;
            syncVisibility();
        }
    });

    window.ecomKpiBars = {
        top: TOP,
        bottom: BOTTOM,
        kpis: Object.keys(KPIS),
        isShowing: function () { return bars.top.classList.contains('is-on'); },
        shown: function () { return { top: shown.top, bottom: shown.bottom }; }
    };
})();
