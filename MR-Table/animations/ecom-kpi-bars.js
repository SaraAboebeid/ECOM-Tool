// ECOM KPI bars - the community's figures along the table's edges.
//
// One along the top of the display and one along the bottom. Numbers glide to
// their new values and a chip says by how much, green for the better way and
// red for the worse, so a touch on the panel reads on the table as a
// consequence and not only as a picture.
//
// WHICH ONES. One figure for each control on the panel, so every touch moves
// something, and the result underneath:
//
//   top      Members      buildings in the community     the member switches
//            Solar        kWh a day from the roofs       the PV controls
//            Chargers     charge points                  add / remove a CP
//            EV charging  kWh a day to the cars          the same
//
//   bottom   Self-sufficiency   share of demand met on campus
//            Grid import        kWh a day
//            Grid export        kWh a day
//
// Why not only the results: measured one change at a time, a charge point
// moves grid import by about 15 kWh a day against 62,000 and self-sufficiency
// not at all, and switching MC2 off moves self-sufficiency by 0.3 pt. Honest,
// and invisible. The top bar is what was changed, the bottom what it did.
//
// PER DAY. The opening picture is a one-day export and the panel dispatches its
// own span (two days by default), so a raw total would double on the first
// touch. And when the span itself changes the new figures are the reference and
// no chip is claimed: what moved is the calendar, not the community.
//
// Hidden during the introduction and faded in when it ends - or as soon as the
// community is changed, whatever the introduction is doing.
//
// Listens on the controller channel for: ecom_kpis (from ecom-energy.js, with
// the hours they cover and the member, charger and EV counts), ecom_caption,
// ecom_release, ecom_change, animation_state.
//
// Exposes globals: ecomKpiBars

(function () {
    'use strict';

    // Whether the top bar is turned to face the far side of the table.
    const FACE_FAR_SIDE = false;

    // Clear of the display's own sidebars.
    const EDGE_PX = 60;
    const GLIDE_MS = 1200;
    const CHIP_MS = 6000;

    const palette = (window.ECOM_PALETTE && window.ECOM_PALETTE.semantic) || {};
    const COLOURS = {
        building: palette.building || '#ff2bd6',
        pv: palette.pv || '#eaff00',
        grid: palette.grid || '#00ffe5',
        ev: palette.ev || palette.charge_point || '#39ff88',
        better: '#4ade80',
        worse: '#f87171'
    };

    const whole = function (v) { return Math.round(v).toLocaleString('en-GB'); };
    const percent = function (v) { return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%'; };

    // kind: 'count' (whole numbers, chip in units), 'amount' (kWh/day, chip in
    // kWh), 'share' (percent, chip in points). better: which way is good, or
    // null for a figure that is neither (more members is not better or worse).
    const BARS = {
        top: [
            { key: 'members', label: 'Members', unit: 'buildings', kind: 'count',
              colour: COLOURS.building, better: null,
              value: function (k) { return k.members || 0; } },
            { key: 'solar', label: 'Solar', unit: 'kWh / day', kind: 'amount',
              colour: COLOURS.pv, better: 'up',
              value: function (k, days) { return (k.total_pv_gen || 0) / days; } },
            { key: 'chargers', label: 'Chargers', unit: 'charge points', kind: 'count',
              colour: COLOURS.ev, better: null,
              value: function (k) { return k.chargers || 0; } },
            { key: 'ev', label: 'EV charging', unit: 'kWh / day', kind: 'amount',
              colour: COLOURS.ev, better: null,
              value: function (k, days) { return (k.total_ev_charging || 0) / days; } }
        ],
        bottom: [
            { key: 'self_sufficiency', label: 'Self-sufficiency', unit: 'met on campus',
              kind: 'share', colour: COLOURS.pv, better: 'up', track: true,
              value: function (k) { return k.self_sufficiency || 0; } },
            { key: 'import', label: 'Grid import', unit: 'kWh / day', kind: 'amount',
              colour: COLOURS.grid, better: 'down',
              value: function (k, days) { return (k.total_grid_import || 0) / days; } },
            { key: 'export', label: 'Grid export', unit: 'kWh / day', kind: 'amount',
              colour: COLOURS.pv, better: 'up',
              value: function (k, days) { return (k.total_grid_export || 0) / days; } }
        ]
    };

    // What the lines mean. The introduction teaches this one colour at a
    // time; the key is for everyone who walks up to the table afterwards,
    // which is most of the room.
    const KEY = [
        { label: 'From the grid', colour: COLOURS.grid },
        { label: 'Between members', colour: COLOURS.building },
        { label: 'From the battery', colour: '#fa3600' },
        { label: 'Solar on the roof', colour: COLOURS.pv }
    ];

    // ------------------------------------------------------------------ DOM

    const style = document.createElement('style');
    style.textContent = [
        '.ecom-kpi-bar{position:fixed;left:' + EDGE_PX + 'px;right:' + EDGE_PX + 'px;',
        'height:52px;z-index:850;display:flex;align-items:stretch;',
        'padding:0 12px;box-sizing:border-box;pointer-events:none;',
        'background:rgba(6,9,12,0.84);color:#e8eef6;',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif;',
        'opacity:0;transition:opacity 700ms ease}',
        '.ecom-kpi-bar.is-on{opacity:1}',
        '.ecom-kpi-top{top:0;border-bottom:1px solid rgba(255,255,255,0.08)}',
        // Room on the right for the display's own "Open Controller" button.
        '.ecom-kpi-bottom{bottom:0;border-top:1px solid rgba(255,255,255,0.08);',
        'padding-right:150px}',
        '.ecom-kpi-top.faces-far{transform:rotate(180deg)}',
        '.ecom-kpi-cell{flex:1;min-width:0;display:flex;align-items:center;gap:10px;',
        'padding:0 14px;border-left:1px solid rgba(255,255,255,0.07)}',
        '.ecom-kpi-cell:first-child{border-left:none}',
        '.ecom-kpi-words{display:flex;flex-direction:column;line-height:1.15;min-width:0}',
        '.ecom-kpi-label{font-size:11px;letter-spacing:0.12em;text-transform:uppercase;',
        'opacity:0.72;white-space:nowrap}',
        '.ecom-kpi-unit{font-size:11px;opacity:0.5;white-space:nowrap}',
        '.ecom-kpi-value{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;',
        'white-space:nowrap;margin-left:auto}',
        '.ecom-kpi-track{flex:1;min-width:40px;height:8px;border-radius:4px;position:relative;',
        'background:rgba(255,255,255,0.09);overflow:hidden}',
        '.ecom-kpi-fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px}',
        '.ecom-kpi-chip{font-size:13px;font-weight:650;padding:3px 8px;border-radius:10px;',
        'white-space:nowrap;opacity:0;transition:opacity 400ms ease;color:#081014;',
        'font-variant-numeric:tabular-nums}',
        '.ecom-kpi-chip.is-on{opacity:1}',
        '.ecom-kpi-key{display:flex;align-items:center;gap:14px;padding:0 16px 0 4px;',
        'border-right:1px solid rgba(255,255,255,0.07);flex:none}',
        '.ecom-kpi-key-item{display:flex;align-items:center;gap:6px;font-size:11px;',
        'letter-spacing:0.04em;opacity:0.82;white-space:nowrap}',
        '.ecom-kpi-key-line{width:18px;height:3px;border-radius:2px;flex:none}'
    ].join('');
    document.head.appendChild(style);

    const bars = {};
    const cells = {};

    function makeBar(position) {
        const bar = document.createElement('div');
        bar.className = 'ecom-kpi-bar ecom-kpi-' + position +
            (position === 'top' && FACE_FAR_SIDE ? ' faces-far' : '');
        if (position === 'bottom') {
            const key = document.createElement('div');
            key.className = 'ecom-kpi-key';
            key.innerHTML = KEY.map(function (item) {
                return '<span class="ecom-kpi-key-item">' +
                    '<span class="ecom-kpi-key-line" style="background:' +
                    item.colour + '"></span>' + item.label + '</span>';
            }).join('');
            bar.appendChild(key);
        }
        BARS[position].forEach(function (spec) {
            const cell = document.createElement('div');
            cell.className = 'ecom-kpi-cell';
            cell.innerHTML =
                '<span class="ecom-kpi-words">' +
                    '<span class="ecom-kpi-label"></span>' +
                    '<span class="ecom-kpi-unit"></span>' +
                '</span>' +
                (spec.track ? '<div class="ecom-kpi-track"><div class="ecom-kpi-fill"></div></div>' : '') +
                '<span class="ecom-kpi-value"></span>' +
                '<span class="ecom-kpi-chip"></span>';
            cell.querySelector('.ecom-kpi-label').textContent = spec.label;
            cell.querySelector('.ecom-kpi-unit').textContent = spec.unit;
            cell.querySelector('.ecom-kpi-value').style.color = spec.colour;
            const fill = cell.querySelector('.ecom-kpi-fill');
            if (fill) fill.style.background = spec.colour;
            bar.appendChild(cell);
            cells[position + ':' + spec.key] = {
                value: cell.querySelector('.ecom-kpi-value'),
                chip: cell.querySelector('.ecom-kpi-chip'),
                fill: fill
            };
        });
        document.body.appendChild(bar);
        return bar;
    }

    bars.top = makeBar('top');
    bars.bottom = makeBar('bottom');

    // Per bar: what is on screen now, and where it is heading ({key: number}).
    const shown = { top: null, bottom: null };
    const target = { top: null, bottom: null };
    const chipTimers = {};
    let glideFrame = null;
    let glides = [];

    function format(spec, v) {
        if (spec.kind === 'share') return percent(v);
        return whole(v);
    }

    function paint(position, values) {
        BARS[position].forEach(function (spec) {
            const cell = cells[position + ':' + spec.key];
            const v = values[spec.key];
            cell.value.textContent = format(spec, v);
            if (cell.fill) cell.fill.style.width = Math.max(0, Math.min(100, v)) + '%';
        });
    }

    function chipText(spec, delta) {
        if (spec.kind === 'share') {
            return Math.abs(delta) >= 0.05
                ? (delta > 0 ? '+' : '−') + Math.abs(delta).toFixed(1) + ' pts' : '';
        }
        return Math.round(Math.abs(delta)) >= 1
            ? (delta > 0 ? '+' : '−') + whole(Math.abs(delta)) : '';
    }

    function showChip(position, spec, from, to) {
        const id = position + ':' + spec.key;
        const chip = cells[id].chip;
        const text = chipText(spec, to - from);
        if (!text) return;      // this figure did not move; any chip it has stays
        if (chipTimers[id]) clearTimeout(chipTimers[id]);
        const delta = to - from;
        chip.textContent = text;
        chip.style.background = spec.better === null
            ? '#e8eef6'
            : ((spec.better === 'up' ? delta > 0 : delta < 0) ? COLOURS.better : COLOURS.worse);
        chip.classList.add('is-on');
        chipTimers[id] = setTimeout(function () {
            chip.classList.remove('is-on');
        }, CHIP_MS);
    }

    function clearChips(position) {
        BARS[position].forEach(function (spec) {
            const id = position + ':' + spec.key;
            if (chipTimers[id]) clearTimeout(chipTimers[id]);
            cells[id].chip.classList.remove('is-on');
        });
    }

    function step(now) {
        glideFrame = null;
        let running = false;
        glides.forEach(function (glide) {
            const t = Math.min(1, (now - glide.startedAt) / GLIDE_MS);
            const eased = 1 - Math.pow(1 - t, 3);
            const current = {};
            Object.keys(glide.to).forEach(function (key) {
                current[key] = glide.from[key] + (glide.to[key] - glide.from[key]) * eased;
            });
            shown[glide.position] = current;
            paint(glide.position, current);
            if (t < 1) running = true;
        });
        glides = glides.filter(function (glide) {
            return now - glide.startedAt < GLIDE_MS;
        });
        if (running) glideFrame = requestAnimationFrame(step);
    }

    // The span the last figures covered, to tell a change of calendar from a
    // change of community.
    let lastHours = null;

    function same(a, b) {
        return Object.keys(a).every(function (key) {
            return Math.abs(a[key] - b[key]) < 1e-6;
        });
    }

    function update(kpis, hours) {
        const span = Math.max(1, hours || 24);
        const days = span / 24;
        const newPeriod = lastHours !== null && span !== lastHours;
        lastHours = span;
        let changed = false;

        ['top', 'bottom'].forEach(function (position) {
            const to = {};
            BARS[position].forEach(function (spec) {
                to[spec.key] = spec.value(kpis, days);
            });
            const was = target[position];
            if (was === null) {
                target[position] = to;
                shown[position] = to;
                paint(position, to);
                return;
            }
            // The same figures again - the display announces a layer more than
            // once as it settles. Nothing to glide, and above all no chip: a
            // repeat used to be measured from mid-glide and claimed a fraction
            // of the real change.
            if (same(was, to)) return;
            changed = true;
            target[position] = to;

            if (newPeriod) {
                clearChips(position);
            } else {
                // Measured from where it was heading, never from what happens
                // to be on screen mid-glide.
                BARS[position].forEach(function (spec) {
                    showChip(position, spec, was[spec.key], to[spec.key]);
                });
            }
            glides = glides.filter(function (g) { return g.position !== position; });
            glides.push({ position: position, from: shown[position], to: to,
                          startedAt: performance.now() });
        });
        if (glideFrame === null && glides.length) {
            glideFrame = requestAnimationFrame(step);
        }
        return changed;
    }

    // ------------------------------------------------------------ visibility

    let layerOn = false;
    let inIntroduction = false;
    let haveFigures = false;
    // The figures arrive the moment the layer comes up, a beat before the
    // controller starts the introduction; shown at once, the bars flashed on
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
            layerOn = true;
            if (!haveFigures) {
                setTimeout(function () { settled = true; syncVisibility(); }, 1800);
            }
            haveFigures = true;
            update(data.kpis, data.hours);
            syncVisibility();
            return;
        }
        if (data.type === 'animation_state' && data.animationId === 'ecom-energy-btn') {
            layerOn = !!data.isActive;
            syncVisibility();
            return;
        }
        // Someone changed the community: whatever the introduction was doing,
        // the room now wants to see what that did. The controller opens with
        // the introduction running, and a person who starts using the controls
        // without finishing it used to get bars that never came up at all.
        if (data.type === 'ecom_change') {
            inIntroduction = false;
            settled = true;
            syncVisibility();
            return;
        }
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
        bars: { top: BARS.top.map(function (s) { return s.key; }),
                bottom: BARS.bottom.map(function (s) { return s.key; }) },
        isShowing: function () { return bars.top.classList.contains('is-on'); },
        why: function () {
            return { layerOn: layerOn, haveFigures: haveFigures, settled: settled,
                     inIntroduction: inIntroduction };
        },
        shown: function () { return { top: shown.top, bottom: shown.bottom }; },
        target: function () { return { top: target.top, bottom: target.bottom }; }
    };
})();
