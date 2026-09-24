// ECOM timeline - the day, along the bottom of the display.
//
// The table runs its own clock, an hour every few seconds, and until now the
// only sign of that was the picture changing: roofs lighting up, the battery
// filling, lines thickening. Anyone walking up to it could see that something
// was moving without being able to say what time it was, and "the battery
// covers the evening" means nothing if the evening is not marked.
//
// So: a strip of the whole span with the hours on it, the part already played
// filled in, and a marker on the hour showing now. Day and night are shaded
// differently, because half of what the table shows - solar, the battery
// emptying, the car arriving - is a story about the sun.
//
// The span is whatever the community was dispatched over: one day in the
// opening picture, two from the panel, more if someone asks for it. Labels
// thin out as the span grows, so a week does not become a picket fence.
//
// Sits above the bottom KPI bar and follows the same rule: hidden during the
// introduction, shown once the table is running.
//
// Listens on the controller channel for: ecom_clock (hour and span, from
// ecom-energy.js), ecom_applied (the dates behind those hours), ecom_caption,
// ecom_release, ecom_change, animation_state.
//
// Exposes globals: ecomTimeline

(function () {
    'use strict';

    // Clear of the display's own sidebars, and sitting on top of the KPI bar.
    const EDGE_PX = 60;
    const BAR_HEIGHT = 52;

    const palette = (window.ECOM_PALETTE && window.ECOM_PALETTE.semantic) || {};
    const SUN = palette.pv || '#eaff00';
    const INK = '#e8eef6';

    // Dawn and dusk, near enough for a campus at this latitude in summer. The
    // shading says "this is the part of the day with sun in it", which is a
    // claim about the picture rather than about sunrise to the minute.
    const DAY_FROM = 6;
    const DAY_TO = 20;

    const style = document.createElement('style');
    style.textContent = [
        '.ecom-timeline{position:fixed;left:' + EDGE_PX + 'px;right:' + EDGE_PX + 'px;',
        'bottom:' + BAR_HEIGHT + 'px;height:34px;z-index:849;',
        'display:flex;align-items:center;gap:14px;padding:0 16px 0 14px;',
        'box-sizing:border-box;pointer-events:none;',
        'background:rgba(6,9,12,0.72);color:' + INK + ';',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif;',
        'border-top:1px solid rgba(255,255,255,0.06);',
        'opacity:0;transition:opacity 700ms ease}',
        '.ecom-timeline.is-on{opacity:1}',
        // The clock reading, wide enough that 09:00 and 23:00 do not shuffle
        // the track between them.
        '.ecom-timeline-now{font-size:19px;font-weight:650;letter-spacing:0.02em;',
        'font-variant-numeric:tabular-nums;min-width:62px}',
        '.ecom-timeline-date{font-size:11px;opacity:0.6;white-space:nowrap;',
        'max-width:210px;overflow:hidden;text-overflow:ellipsis}',
        '.ecom-timeline-track{position:relative;flex:1;height:18px;min-width:120px}',
        // Night is the ground the strip is drawn on; day is lifted out of it.
        '.ecom-timeline-night{position:absolute;left:0;right:0;top:6px;height:6px;',
        'border-radius:3px;background:rgba(255,255,255,0.07)}',
        '.ecom-timeline-day{position:absolute;top:6px;height:6px;border-radius:3px;',
        'background:rgba(234,255,0,0.13)}',
        '.ecom-timeline-played{position:absolute;left:0;top:6px;height:6px;',
        'border-radius:3px;background:rgba(232,238,246,0.16)}',
        '.ecom-timeline-tick{position:absolute;top:4px;width:1px;height:10px;',
        'background:rgba(255,255,255,0.18)}',
        '.ecom-timeline-tick.is-major{top:1px;height:16px;background:rgba(255,255,255,0.32)}',
        '.ecom-timeline-label{position:absolute;top:-13px;transform:translateX(-50%);',
        'font-size:10px;opacity:0.55;font-variant-numeric:tabular-nums}',
        // The marker: a line the full height of the track with a head on it, so
        // it is findable across a room and still lands on one hour.
        '.ecom-timeline-head{position:absolute;top:0;width:2px;height:18px;',
        'margin-left:-1px;background:' + SUN + ';box-shadow:0 0 8px ' + SUN + '}',
        '.ecom-timeline-dot{position:absolute;top:5px;width:8px;height:8px;',
        'margin-left:-4px;border-radius:50%;background:' + SUN + ';',
        'box-shadow:0 0 10px ' + SUN + '}'
    ].join('');
    document.head.appendChild(style);

    const strip = document.createElement('div');
    strip.className = 'ecom-timeline';
    strip.innerHTML =
        '<span class="ecom-timeline-now"></span>' +
        '<div class="ecom-timeline-track">' +
            '<div class="ecom-timeline-night"></div>' +
            '<div class="ecom-timeline-days"></div>' +
            '<div class="ecom-timeline-played"></div>' +
            '<div class="ecom-timeline-marks"></div>' +
            '<div class="ecom-timeline-head" hidden></div>' +
            '<div class="ecom-timeline-dot" hidden></div>' +
        '</div>' +
        '<span class="ecom-timeline-date"></span>';
    document.body.appendChild(strip);

    const parts = {
        now: strip.querySelector('.ecom-timeline-now'),
        days: strip.querySelector('.ecom-timeline-days'),
        played: strip.querySelector('.ecom-timeline-played'),
        marks: strip.querySelector('.ecom-timeline-marks'),
        head: strip.querySelector('.ecom-timeline-head'),
        dot: strip.querySelector('.ecom-timeline-dot'),
        date: strip.querySelector('.ecom-timeline-date')
    };

    let hours = 24;
    let hour = 0;
    let built = 0;          // the span the ticks were drawn for

    const clock = function (value) {
        return String(value % 24).padStart(2, '0') + ':00';
    };

    /** Every how many hours to write a number, so labels stay legible. */
    function labelEvery(span) {
        if (span <= 24) return 6;
        if (span <= 48) return 12;
        if (span <= 24 * 7) return 24;
        return 24 * 7;
    }

    function build() {
        const span = Math.max(1, hours);
        const step = labelEvery(span);
        const marks = [];
        const daylight = [];

        for (let h = 0; h < span; h += 1) {
            const at = (h / span) * 100;
            const major = h % step === 0;
            if (major || span <= 48) {
                marks.push('<div class="ecom-timeline-tick' +
                    (major ? ' is-major' : '') + '" style="left:' + at + '%"></div>');
            }
            if (major) {
                marks.push('<div class="ecom-timeline-label" style="left:' + at + '%">' +
                    clock(h) + '</div>');
            }
        }

        // One lit band per day in the span.
        for (let day = 0; day * 24 < span; day += 1) {
            const from = day * 24 + DAY_FROM;
            const to = Math.min(day * 24 + DAY_TO, span);
            if (from >= span) break;
            const left = (from / span) * 100;
            const width = ((to - from) / span) * 100;
            daylight.push('<div class="ecom-timeline-day" style="left:' + left +
                '%;width:' + width + '%"></div>');
        }

        parts.marks.innerHTML = marks.join('');
        parts.days.innerHTML = daylight.join('');
        built = span;
    }

    function paint() {
        if (built !== Math.max(1, hours)) build();
        const span = Math.max(1, hours);
        const at = (hour / span) * 100;
        parts.now.textContent = clock(hour);
        parts.played.style.width = at + '%';
        parts.head.style.left = at + '%';
        parts.dot.style.left = at + '%';
        parts.head.hidden = false;
        parts.dot.hidden = false;
        // Which day of the span, when there is more than one.
        const day = Math.floor(hour / 24);
        parts.now.title = 'hour ' + hour + ' of ' + span;
        if (span > 24) {
            parts.now.textContent = clock(hour) + ' · day ' + (day + 1);
        }
    }

    // ------------------------------------------------------------ visibility

    let layerOn = false;
    let inIntroduction = false;
    let settled = false;

    function syncVisibility() {
        strip.classList.toggle('is-on', layerOn && settled && !inIntroduction);
    }

    const channel = new BroadcastChannel('map_controller_channel');
    channel.addEventListener('message', function (event) {
        const data = event.data || {};

        if (data.type === 'ecom_clock') {
            layerOn = true;
            if (!settled) {
                // The same beat the KPI bars wait: the introduction starts a
                // moment after the layer comes up, and a strip that flashed on
                // and off again would read as a fault.
                setTimeout(function () { settled = true; syncVisibility(); }, 1800);
            }
            if (typeof data.hours === 'number' && data.hours > 0) hours = data.hours;
            if (typeof data.hour === 'number') hour = data.hour;
            if (typeof data.period === 'string' && data.period) {
                parts.date.textContent = data.period;
            }
            paint();
            syncVisibility();
            return;
        }
        if (data.type === 'ecom_applied') {
            if (typeof data.hours === 'number' && data.hours > 0) hours = data.hours;
            // "June 1 00:00 - June 2 23:00 (48 h)" - the dates behind the hours.
            parts.date.textContent = data.period || '';
            paint();
            return;
        }
        if (data.type === 'animation_state' && data.animationId === 'ecom-energy-btn') {
            layerOn = !!data.isActive;
            syncVisibility();
            return;
        }
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

    window.ecomTimeline = {
        isShowing: function () { return strip.classList.contains('is-on'); },
        reading: function () { return { hour: hour, hours: hours,
                                        label: parts.now.textContent,
                                        period: parts.date.textContent }; }
    };
})();
