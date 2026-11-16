// ECOM optimization - what the optimizer found, along the bottom of the display.
//
// The controller runs the optimizer (LEC-Opt, minutes for a year) and used to
// keep the answer to itself. This puts it where the room can see it: one card
// per way of running the buildings - "as today", each on its own connection,
// and "as an energy community", sharing solar, storage and the grid - with the
// saving between them when both have been run.
//
// Sits above the timeline strip. Appears while a run is going (so the wait is
// explained) and stays once there is something to read.
//
// Listens on the controller channel for: ecom_optimization, animation_state,
// ecom_caption, ecom_release, ecom_change, ecom_empty.
//
// Exposes globals: ecomOptimization

(function () {
    'use strict';

    const EDGE_PX = 60;
    const BOTTOM_PX = 86;     // KPI bar (52) + timeline strip (34)
    const INK = '#e8eef6';
    const GOOD = '#5fd48a';
    const BAD = '#ff8a7a';

    const LABELS = { separate: 'As today', community: 'As an energy community' };
    const ORDER = ['separate', 'community'];

    const style = document.createElement('style');
    style.textContent = [
        '.ecom-opt{position:fixed;left:' + EDGE_PX + 'px;right:' + EDGE_PX + 'px;',
        'bottom:' + BOTTOM_PX + 'px;z-index:848;box-sizing:border-box;',
        'display:flex;align-items:stretch;gap:22px;padding:10px 18px;',
        'background:rgba(6,9,12,0.8);color:' + INK + ';pointer-events:none;',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif;',
        'border-top:1px solid rgba(255,255,255,0.08);',
        'opacity:0;transform:translateY(6px);',
        'transition:opacity 600ms ease,transform 600ms ease}',
        '.ecom-opt.is-on{opacity:1;transform:none}',
        '.ecom-opt-head{display:flex;flex-direction:column;justify-content:center;',
        'min-width:150px;max-width:210px}',
        '.ecom-opt-title{font-size:13px;font-weight:650;letter-spacing:0.06em;',
        'text-transform:uppercase;opacity:0.85}',
        '.ecom-opt-sub{font-size:12px;opacity:0.6;margin-top:2px}',
        '.ecom-opt-card{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0;',
        'padding-left:18px;border-left:1px solid rgba(255,255,255,0.12)}',
        '.ecom-opt-name{font-size:13px;font-weight:650;opacity:0.9}',
        '.ecom-opt-row{display:flex;gap:26px;flex-wrap:wrap;align-items:baseline}',
        '.ecom-opt-m{display:flex;flex-direction:column}',
        '.ecom-opt-m b{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;',
        'line-height:1.1}',
        '.ecom-opt-m span{font-size:11px;opacity:0.58;text-transform:uppercase;',
        'letter-spacing:0.05em}',
        '.ecom-opt-m.is-big b{font-size:30px}',
        '.ecom-opt-wait{align-self:center;font-size:15px;opacity:0.8}',
        '.ecom-opt-save{flex:0 0 auto;display:flex;flex-direction:column;',
        'justify-content:center;padding-left:18px;border-left:1px solid rgba(255,255,255,0.12)}',
        '.ecom-opt-save b{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;',
        'line-height:1.1}',
        '.ecom-opt-save span{font-size:11px;opacity:0.6;text-transform:uppercase;',
        'letter-spacing:0.05em}',
        '.ecom-opt-err{align-self:center;color:' + BAD + ';font-size:14px}'
    ].join('');
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'ecom-opt';
    document.body.appendChild(bar);

    let layerOn = false;
    let inIntroduction = false;
    let payload = null;

    const num = function (value) {
        return Math.round(value || 0).toLocaleString('en-US').replace(/,/g, ' ');
    };

    function metric(label, value, unit, big) {
        return '<div class="ecom-opt-m' + (big ? ' is-big' : '') + '"><b>' +
            num(value) + '<small style="font-size:0.55em;font-weight:500;opacity:0.7"> ' +
            unit + '</small></b><span>' + label + '</span></div>';
    }

    function card(mode, result) {
        const t = (result && result.totals) || {};
        return '<div class="ecom-opt-card" data-mode="' + mode + '">' +
            '<div class="ecom-opt-name">' + LABELS[mode] + '</div>' +
            '<div class="ecom-opt-row">' +
                metric('Overall cost', t.overall_cost, 'SEK', true) +
                metric('Grid import', t.grid_import_kwh, 'kWh') +
                metric('Grid export', t.grid_export_kwh, 'kWh') +
                metric('Peak import', t.peak_net_import_kw, 'kW') +
            '</div></div>';
    }

    function render() {
        const o = payload;
        const results = (o && o.results) || {};
        const done = ORDER.filter(function (m) { return results[m]; });
        const running = o && o.running;
        const failed = o && o.error;
        const has = done.length || running || failed;

        bar.classList.toggle('is-on', !!(layerOn && !inIntroduction && has));
        if (!has) { bar.innerHTML = ''; return; }

        let html = '<div class="ecom-opt-head"><span class="ecom-opt-title">Optimization</span>' +
            '<span class="ecom-opt-sub">' + (o.label || '') +
            (o.period ? ' &middot; ' + o.period : '') + '</span></div>';

        done.forEach(function (m) { html += card(m, results[m]); });

        if (running) {
            html += '<div class="ecom-opt-card"><span class="ecom-opt-wait">Solving ' +
                (LABELS[running] || running).toLowerCase() + '…</span></div>';
        }
        if (failed && !running) {
            html += '<div class="ecom-opt-card"><span class="ecom-opt-err">' +
                String(o.error).replace(/</g, '&lt;') + '</span></div>';
        }
        if (results.separate && results.community) {
            const saved = (results.separate.totals.overall_cost || 0) -
                          (results.community.totals.overall_cost || 0);
            const pct = results.separate.totals.overall_cost
                ? saved / results.separate.totals.overall_cost * 100 : 0;
            html += '<div class="ecom-opt-save"><b style="color:' +
                (saved >= 0 ? GOOD : BAD) + '">' + (saved >= 0 ? '−' : '+') +
                num(Math.abs(saved)) + ' SEK</b><span>' +
                (saved >= 0 ? 'saved' : 'extra') + ' as a community (' +
                Math.abs(pct).toFixed(1) + '%)</span></div>';
        }
        bar.innerHTML = html;
    }

    const channel = new BroadcastChannel('map_controller_channel');
    channel.addEventListener('message', function (event) {
        const data = event.data || {};
        if (data.type === 'ecom_optimization') {
            payload = data.optimization || null;
            layerOn = true;
            render();
            return;
        }
        if (data.type === 'ecom_clock') { layerOn = true; render(); return; }
        if (data.type === 'animation_state' && data.animationId === 'ecom-energy-btn') {
            layerOn = !!data.isActive;
            render();
            return;
        }
        if (data.type === 'ecom_caption') {
            inIntroduction = !!(data.caption && typeof data.caption.step === 'number');
            render();
            return;
        }
        if (data.type === 'ecom_release' || data.type === 'ecom_change') {
            inIntroduction = false;
            render();
            return;
        }
        if (data.type === 'ecom_empty') { layerOn = false; render(); }
    });

    window.ecomOptimization = {
        isShowing: function () { return bar.classList.contains('is-on'); },
        reading: function () { return { text: bar.innerText, payload: payload }; }
    };
})();
