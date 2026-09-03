// ECOM Energy Community
// =====================
// The energy community drawn over the table: a node marker per member and the
// hourly flows between them, in the same icons, colours and elbowed routing the
// ECOM dashboard's 2D viewer uses, so the two read as one tool. Data comes from
// that dashboard, exported by Dashboard/backend/scripts/export_mr_layer.py into
// media/ecom/ - this site has no build step, so the layer reads a plain GeoJSON
// rather than importing anything from that app.
//
// Nothing paints the building footprints. They are already drawn by the basemap
// and, more to the point, they exist physically in the 3D print the projector is
// aimed at. Only what the model cannot show is drawn: who is a member, and what
// is moving between them.
//
// The footprints need no reprojection - the table's calibrated centre sits
// about 50 m from the campus centroid and the export is CRS84.
//
// Exposes globals: ecomEnergyLayer

(function () {
    'use strict';

    const DATA_URL = 'media/ecom/ecom-buildings.geojson';
    const NODES_URL = 'media/ecom/ecom-nodes.geojson';
    const FLOWS_URL = 'media/ecom/ecom-flows.geojson';

    const SOURCE_ID = 'ecom-buildings-source';
    const FILL_LAYER_ID = 'ecom-buildings-fill';
    const SOLAR_LAYER_ID = 'ecom-buildings-solar';

    const NODES_SOURCE_ID = 'ecom-nodes-source';
    const NODE_LAYER_ID = 'ecom-nodes';

    const FLOWS_SOURCE_ID = 'ecom-flows-source';
    const FLOW_LAYER_ID = 'ecom-flows';
    const FLOW_GLOW_ID = 'ecom-flows-glow';

    // Two nodes get a pulse rather than just a marker: the grid tie and the
    // battery. Both are places energy passes THROUGH in a direction, and the
    // direction is the thing worth watching - every other node is identified
    // well enough by an icon.
    //
    // One rule for both, which is what lets them be read together:
    //
    //     rings travelling outward   energy leaving this node
    //     rings travelling inward    energy arriving at it
    //
    // So the grid pushes rings out while it supplies the campus and draws them
    // in while the campus exports; the battery pushes out while discharging and
    // draws in while charging.
    const PULSES = [
        { key: 'grid', kind: 'grid' },
        { key: 'battery', kind: 'battery' }
    ].map(function (spec) {
        return {
            key: spec.key,
            kind: spec.kind,
            filter: ['==', ['get', 'kind'], spec.kind],
            // Each node needs its own field: the two can be moving energy in
            // opposite directions in the same hour, which is exactly what a
            // battery charging off the grid looks like.
            field: spec.key + 'Now',
            haloId: 'ecom-' + spec.key + '-halo',
            coreId: 'ecom-' + spec.key + '-core',
            ringIds: ['ecom-' + spec.key + '-ring-a', 'ecom-' + spec.key + '-ring-b'],
            direction: 1
        };
    });

    const PULSE_LAYER_IDS = PULSES.reduce(function (ids, pulse) {
        return ids.concat([pulse.haloId, pulse.coreId], pulse.ringIds);
    }, []);

    // A link takes the colour of the node it flows out of, which is the rule
    // the dashboard's map uses. The values come from ecom-palette.js so the
    // legend on the controller cannot drift from what the table draws; the
    // literals are a fallback for the layer being loaded on its own.
    const KIND_COLORS = (window.ECOM_PALETTE && window.ECOM_PALETTE.semantic) || {
        building: '#ff00a6',
        pv: '#eaff00',
        grid: '#00ffe5',
        battery: '#fa3600',
        charge_point: '#00ff5e'
    };
    const SOLAR_COLOR = KIND_COLORS.pv;
    const LABEL_INK = '#eef6ff';
    const LABEL_CHIP = '#1e293b';

    // A layer's own reason to hide a feature, kept apart from the view
    // filters the controller sends. The two are combined rather than one
    // overwriting the other: without this, filtering to "buildings only" would
    // also drop the hasData test and start drawing footprints with no dispatch.
    const FILL_BASE_FILTER = ['==', ['get', 'hasData'], 1];
    const SOLAR_BASE_FILTER = ['==', ['get', 'has_pv'], 1];
    const NODE_BASE_FILTER = ['!=', ['get', 'kind'], 'pv'];

    const ecomChannel = new BroadcastChannel('map_controller_channel');

    let layerData = null;
    let nodeData = null;
    let flowData = null;
    let isLoaded = false;
    let isActive = false;
    let currentHour = 0;

    // ---------------------------------------------------------------- data

    async function loadData() {
        if (isLoaded) return true;

        try {
            // no-store, because these three are regenerated whenever the
            // community changes and the table has no way to know it. serve.py
            // stamps asset URLs it finds in the HTML, but these are fetched
            // from here - a copy cached under a plain http.server, which sends
            // Last-Modified and no Cache-Control, is heuristically reusable and
            // the browser serves it without asking. That is a table quietly
            // showing last week's campus.
            const noStore = { cache: 'no-store' };
            const responses = await Promise.all([
                fetch(DATA_URL, noStore),
                fetch(NODES_URL, noStore),
                fetch(FLOWS_URL, noStore)
            ]);
            responses.forEach(function (response) {
                if (!response.ok) {
                    throw new Error(response.url + ': ' + response.status);
                }
            });
            const parsed = await Promise.all(responses.map(function (r) { return r.json(); }));
            layerData = parsed[0];
            nodeData = parsed[1];
            flowData = parsed[2];

            // Which export this is. A table showing an old one looks exactly
            // like a table showing a new one, so it has to say.
            console.info('[ecom] layer data generated ' +
                (nodeData.generated || 'unknown') + ' - ' +
                (nodeData.features || []).length + ' nodes, ' +
                (flowData.features || []).length + ' flows');
        } catch (error) {
            console.error('ECOM: could not load the export', error);
            if (typeof showToast === 'function') {
                showToast('ECOM data missing - run export_mr_layer.py');
            }
            return false;
        }

        prepare();
        isLoaded = true;
        return true;
    }

    // The per-feature fields the paint expressions read, derived once whichever
    // way the data arrived - fetched from the export, or pushed by the
    // controller after a slider moved.
    function prepare() {
        hourCount = (layerData.ecom_meta && layerData.ecom_meta.hours) || 24;

        // Flows start at zero width; setHour fills them in.
        flowData.features.forEach(function (feature) {
            feature.properties.flowNow = 0;
            feature.properties.share = 0;
        });

        // Flatten the values the paint expressions need onto each feature.
        // MapLibre exposes nested GeoJSON properties as JSON strings, so an
        // expression cannot read a field inside `ecom`.
        // Only hasData is still needed: the footprints are drawn by nobody,
        // and this source exists purely so a click can find a building.
        layerData.features.forEach(function (feature) {
            feature.properties.hasData = feature.properties.ecom ? 1 : 0;
        });

        nodeData.features.forEach(function (feature) {
            feature.properties.solarNow = 0;
            feature.properties.storedNow = 0;
            feature.properties.fillStep = 0;
            PULSES.forEach(function (pulse) {
                feature.properties[pulse.field] = 0;
            });
        });

        buildStorageCurve();

        // The scale every line width and the "hide small flows" filter are
        // measured against. Derived here rather than on the first setFlowHour,
        // because applyFilters can run before any hour has been set - against a
        // ceiling of zero it would measure the threshold in kW instead of as a
        // share, and hide almost nothing.
        flowCeiling = 0;
        flowData.features.forEach(function (feature) {
            const peak = feature.properties.peak || 0;
            if (peak > flowCeiling) flowCeiling = peak;
        });
    }

    // -------------------------------------------------------------- caption

    // A line of text on the table itself.
    //
    // The presenter stands at the controller and the audience stands round the
    // table; without this the table is the only thing being looked at and the
    // only thing that cannot say what it is showing. One line, bottom left,
    // out of the way of the campus.
    let captionBox = null;

    function showCaption(caption) {
        if (typeof document === 'undefined' || !document.body) return;

        if (!captionBox) {
            captionBox = document.createElement('div');
            captionBox.id = 'ecom-caption';
            captionBox.style.cssText = [
                'position:fixed', 'left:28px', 'bottom:28px', 'z-index:900',
                'max-width:520px', 'padding:14px 18px',
                'background:rgba(8,12,16,0.82)',
                'border:1px solid rgba(255,255,255,0.10)',
                'border-left:3px solid ' + (KIND_COLORS.action || '#e8eef6'),
                'border-radius:10px', 'color:#e8eef6',
                'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
                'pointer-events:none',
                'transition:opacity 320ms ease', 'opacity:0'
            ].join(';');
            document.body.appendChild(captionBox);
        }

        if (!caption) {
            captionBox.style.opacity = '0';
            return;
        }

        const dots = [];
        for (let i = 1; i <= (caption.of || 0); i += 1) {
            dots.push('<span style="display:inline-block;width:' +
                (i === caption.step ? '18px' : '6px') +
                ';height:6px;border-radius:3px;margin-right:5px;background:' +
                (i <= caption.step ? (KIND_COLORS.action || '#e8eef6')
                                   : 'rgba(255,255,255,0.22)') + '"></span>');
        }

        captionBox.innerHTML =
            '<div style="margin-bottom:9px">' + dots.join('') + '</div>' +
            '<div style="font-size:20px;font-weight:600;letter-spacing:0.01em">' +
                escapeHtml(caption.title || '') + '</div>' +
            (caption.line
                ? '<div style="font-size:14px;opacity:0.72;margin-top:5px;' +
                  'line-height:1.45">' + escapeHtml(caption.line) + '</div>'
                : '') +
            (caption.figure
                ? '<div style="font-size:15px;margin-top:9px;color:' +
                  (KIND_COLORS.action || '#e8eef6') + '">' +
                  escapeHtml(caption.figure) + '</div>'
                : '');
        captionBox.style.opacity = '1';
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"]/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
        });
    }

    // -------------------------------------------------------------- storage

    // How full the battery is, hour by hour.
    //
    // Charge is not reported: the export carries flows, not a state of charge.
    // So it is integrated from what goes in and out, against the battery's own
    // capacity, which the node does carry. The starting level is taken as the
    // least that keeps the run non-negative - a battery cannot discharge energy
    // it never had. That is a floor rather than a reading, so a battery that
    // starts fuller than it ever needs looks emptier here than it is.
    let storageCurve = null;

    function buildStorageCurve() {
        storageCurve = null;
        if (!nodeData || !flowData) return;

        const battery = nodeData.features.find(function (feature) {
            return feature.properties.kind === 'battery';
        });
        if (!battery) return;

        const id = battery.properties.id;
        const hours = (flowData.features[0] &&
                       (flowData.features[0].properties.flow_hourly || []).length) || 0;
        if (!hours) return;

        const net = new Array(hours).fill(0);
        flowData.features.forEach(function (feature) {
            const props = feature.properties;
            const series = props.flow_hourly || [];
            const sign = props.target === id ? 1 : (props.source === id ? -1 : 0);
            if (!sign) return;
            for (let h = 0; h < hours; h += 1) net[h] += sign * (series[h] || 0);
        });

        // The level at the START of each hour, so a discharge during hour h
        // reads as the drop between h and h+1 rather than having already
        // happened before the hour is drawn.
        let level = 0;
        const before = net.map(function (delta) {
            const at = level;
            level += delta;
            return at;
        });

        const capacity = battery.properties.capacity || 0;
        const floor = Math.max(0, -Math.min.apply(null, before.concat([level])));

        if (capacity > 0) {
            storageCurve = before.map(function (value) {
                return Math.max(0, Math.min(1, (floor + value) / capacity));
            });
            return;
        }

        const low = Math.min.apply(null, before);
        const high = Math.max.apply(null, before);
        const span = high - low;
        storageCurve = before.map(function (value) {
            return span > 0 ? (value - low) / span : 0;
        });
    }

    // --------------------------------------------------------------- layers

    function addLayers() {
        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, {
                type: 'geojson',
                data: layerData
            });
        }

        // Invisible, and only for hit-testing. The basemap already draws these
        // buildings and the table projects onto a physical model of them, so
        // filling them again would be the same footprint three times over.
        // A zero-opacity fill is still queryable, which keeps the click popup
        // working without painting anything.
        if (!map.getLayer(FILL_LAYER_ID)) {
            map.addLayer({
                id: FILL_LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                filter: FILL_BASE_FILTER,
                paint: { 'fill-opacity': 0 }
            });
        }

        addFlowLayers();
        // The node source has to exist before the pulse layers name it.
        // MapLibre does not throw on a layer whose source is missing - it fires
        // an error event and drops the layer - so the halo, core and rings were
        // silently never added while every other layer came up fine.
        ensureNodesSource();
        addPulseLayers();
        addNodeLayers();
        bindInteraction();
    }

    // Flows: a wide low-opacity glow with a dashed core on top, which is how
    // the dashboard draws them. The dash is uniform - a wide line swallows its
    // own gaps and reads as solid, so "solid" means "high flow" without a
    // second encoding having to say so.
    //
    // Colour follows the source node, and width follows magnitude, matching
    // the 2D viewer exactly.
    //
    // A gradient from the source colour to the target colour was tried here and
    // taken out again. It needed one layer per source/target pair, because
    // line-gradient cannot be data-driven, and it could not be dashed at all -
    // line-dasharray disables line-gradient. Losing the travelling dash cost
    // more legibility than the second colour bought.
    function addFlowLayers() {
        if (!map.getSource(FLOWS_SOURCE_ID)) {
            map.addSource(FLOWS_SOURCE_ID, { type: 'geojson', data: flowData });
        }

        const colorByKind = [
            'match', ['get', 'kind'],
            'grid', KIND_COLORS.grid,
            'battery', KIND_COLORS.battery,
            'pv', KIND_COLORS.pv,
            KIND_COLORS.building
        ];

        if (!map.getLayer(FLOW_GLOW_ID)) {
            map.addLayer({
                id: FLOW_GLOW_ID,
                type: 'line',
                source: FLOWS_SOURCE_ID,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': colorByKind,
                    // Narrow and faint: around the grid tie a dozen glows
                    // overlapped into one mass and the individual runs stopped
                    // being separable.
                    'line-width': ['+', 1.5, ['*', 11, ['get', 'share']]],
                    'line-opacity': ['*', 0.16, ['get', 'share']],
                    'line-blur': 4
                }
            });
        }

        if (!map.getLayer(FLOW_LAYER_ID)) {
            map.addLayer({
                id: FLOW_LAYER_ID,
                type: 'line',
                source: FLOWS_SOURCE_ID,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': colorByKind,
                    'line-width': ['+', 0.8, ['*', 6.5, ['get', 'share']]],
                    // Just short of full, so two crossing lines still read as
                    // two rather than as a join.
                    'line-opacity': ['*', 0.82, ['get', 'share']]
                }
            });
        }
    }

    // Node icons, drawn to a canvas and registered with the map.
    //
    // MapLibre has no vector-shape marker, so the dashboard's rounded-square
    // glyph has to become a raster image. Drawn at 3x and declared with a
    // pixelRatio so it stays crisp on the projector, which runs well above CSS
    // resolution.
    const ICON_SIZE = 26;
    const ICON_SCALE = 3;

    // Single-path glyphs on a 24x24 grid, matching the dashboard's node icons.
    const GLYPHS = {
        building: 'M4 21V7l8-4 8 4v14M9 21v-5h6v5M8 11h2M14 11h2',
        grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
        battery: 'M7 7h10v10H7zM10 4h4M11 9v6M9 12h4',
        charge_point: 'M13 2 L4 14h7l-1 8 9-12h-7z'
    };

    // Relative luminance, so the glyph is legible on every node colour. White
    // fails badly on this palette's yellow and cyan.
    function inkOn(hex) {
        const h = hex.replace('#', '');
        const channels = [0, 2, 4].map(function (i) {
            return parseInt(h.slice(i, i + 2), 16) / 255;
        }).map(function (v) {
            return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        const lum = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        const contrastDark = (lum + 0.05) / 0.0552;
        const contrastWhite = 1.05 / (lum + 0.05);
        return contrastDark >= contrastWhite ? '#0f172a' : '#ffffff';
    }

    function makeIcon(kind, withPv) {
        const size = ICON_SIZE * ICON_SCALE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const color = KIND_COLORS[kind] || KIND_COLORS.building;

        // Rounded square, the shape the dashboard uses for a node.
        const r = 7 * ICON_SCALE;
        const pad = 1.5 * ICON_SCALE;
        const w = size - pad * 2;
        ctx.beginPath();
        ctx.moveTo(pad + r, pad);
        ctx.arcTo(pad + w, pad, pad + w, pad + w, r);
        ctx.arcTo(pad + w, pad + w, pad, pad + w, r);
        ctx.arcTo(pad, pad + w, pad, pad, r);
        ctx.arcTo(pad, pad, pad + w, pad, r);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        ctx.strokeStyle = inkOn(color);
        ctx.lineWidth = 1.9 * ICON_SCALE;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.save();
        const inset = 4 * ICON_SCALE;
        ctx.translate(inset, inset);
        ctx.scale((size - inset * 2) / 24, (size - inset * 2) / 24);
        ctx.stroke(new Path2D(GLYPHS[kind] || GLYPHS.building));
        ctx.restore();

        // Roof PV: a yellow bar across the top of the marker, the same badge
        // the dashboard puts on a building that owns panels. Drawn inside the
        // icon rather than as a second marker, so it cannot drift away from the
        // building it describes.
        if (withPv) {
            const bw = w * 0.52;
            const bh = 3.4 * ICON_SCALE;
            const bx = pad + (w - bw) / 2;
            const by = pad + 2.2 * ICON_SCALE;
            const br = bh / 2;
            ctx.beginPath();
            ctx.moveTo(bx + br, by);
            ctx.arcTo(bx + bw, by, bx + bw, by + bh, br);
            ctx.arcTo(bx + bw, by + bh, bx, by + bh, br);
            ctx.arcTo(bx, by + bh, bx, by, br);
            ctx.arcTo(bx, by, bx + bw, by, br);
            ctx.closePath();
            ctx.fillStyle = KIND_COLORS.pv;
            ctx.fill();
            ctx.strokeStyle = 'rgba(15,23,42,0.55)';
            ctx.lineWidth = 0.8 * ICON_SCALE;
            ctx.stroke();
        }

        return ctx.getImageData(0, 0, size, size);
    }

    // The battery marker, drawn at a given charge.
    //
    // A ring says which way energy is moving; it cannot say how much is in
    // there. This is the marker itself filling from the bottom, which is the
    // one reading a battery has that nothing else on the table does.
    //
    // Eleven images rather than one animated shape: MapLibre has no way to
    // paint part of a symbol, so the level is baked in and the layer picks the
    // nearest tenth. Registered once, at activation.
    const FILL_STEPS = 10;

    function makeBatteryIcon(level) {
        const size = ICON_SIZE * ICON_SCALE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const colour = KIND_COLORS.battery;

        const r = 7 * ICON_SCALE;
        const pad = 1.5 * ICON_SCALE;
        const w = size - pad * 2;

        const shell = function () {
            ctx.beginPath();
            ctx.moveTo(pad + r, pad);
            ctx.arcTo(pad + w, pad, pad + w, pad + w, r);
            ctx.arcTo(pad + w, pad + w, pad, pad + w, r);
            ctx.arcTo(pad, pad + w, pad, pad, r);
            ctx.arcTo(pad, pad, pad + w, pad, r);
            ctx.closePath();
        };

        // An empty vessel: outline only, so an empty battery still reads as a
        // battery rather than disappearing.
        shell();
        ctx.fillStyle = 'rgba(10, 20, 24, 0.72)';
        ctx.fill();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.8 * ICON_SCALE;
        ctx.stroke();

        // The charge, rising from the bottom.
        if (level > 0) {
            ctx.save();
            shell();
            ctx.clip();
            const height = w * level;
            ctx.fillStyle = colour;
            ctx.globalAlpha = 0.9;
            ctx.fillRect(pad, pad + w - height, w, height);
            ctx.restore();
        }

        // The glyph over the top, in whichever ink stays legible against the
        // part of the marker it happens to sit on.
        ctx.strokeStyle = level > 0.55 ? '#04212a' : colour;
        ctx.lineWidth = 1.9 * ICON_SCALE;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.save();
        const inset = 4 * ICON_SCALE;
        ctx.translate(inset, inset);
        ctx.scale((size - inset * 2) / 24, (size - inset * 2) / 24);
        ctx.stroke(new Path2D(GLYPHS.battery));
        ctx.restore();

        return ctx.getImageData(0, 0, size, size);
    }

    function registerIcons() {
        for (let step = 0; step <= FILL_STEPS; step += 1) {
            const name = 'ecom-battery-fill-' + step;
            if (!map.hasImage(name)) {
                map.addImage(name, makeBatteryIcon(step / FILL_STEPS),
                             { pixelRatio: ICON_SCALE });
            }
        }

        Object.keys(GLYPHS).forEach(function (kind) {
            const name = 'ecom-' + kind;
            if (!map.hasImage(name)) {
                map.addImage(name, makeIcon(kind, false), { pixelRatio: ICON_SCALE });
            }
        });
        if (!map.hasImage('ecom-building-pv')) {
            map.addImage('ecom-building-pv', makeIcon('building', true),
                         { pixelRatio: ICON_SCALE });
        }
    }

    // Rings leaving the grid tie, and a halo under it.
    //
    // Added before the node icons so the marker sits on top of its own light
    // rather than behind it. Radius and opacity are stepped on the same timer
    // as the travelling dashes - MapLibre cannot keyframe a paint property, and
    // one timer keeps the two motions in step instead of beating against each
    // other.
    const RING_MIN = 11;
    const RING_MAX = 52;

    function addPulseLayers() {
        PULSES.forEach(function (pulse) {
            const colour = KIND_COLORS[pulse.kind];
            const level = ['get', pulse.field];

            if (!map.getLayer(pulse.haloId)) {
                map.addLayer({
                    id: pulse.haloId,
                    type: 'circle',
                    source: NODES_SOURCE_ID,
                    filter: pulse.filter,
                    paint: {
                        'circle-color': colour,
                        'circle-radius': ['+', 18, ['*', 30, level]],
                        'circle-opacity': ['+', 0.18, ['*', 0.42, level]],
                        'circle-blur': 1
                    }
                });
            }

            // A lit disc for the marker to sit on. The halo alone reads as a
            // smudge behind an icon; this is what makes the node look like
            // something energy is passing through.
            if (!map.getLayer(pulse.coreId)) {
                map.addLayer({
                    id: pulse.coreId,
                    type: 'circle',
                    source: NODES_SOURCE_ID,
                    filter: pulse.filter,
                    paint: {
                        'circle-color': colour,
                        'circle-radius': ['+', 9, ['*', 4, level]],
                        'circle-opacity': ['+', 0.45, ['*', 0.35, level]],
                        'circle-blur': 0.55
                    }
                });
            }

            pulse.ringIds.forEach(function (id) {
                if (map.getLayer(id)) return;
                map.addLayer({
                    id: id,
                    type: 'circle',
                    source: NODES_SOURCE_ID,
                    filter: pulse.filter,
                    paint: {
                        'circle-color': 'rgba(0,0,0,0)',
                        'circle-stroke-color': colour,
                        'circle-stroke-width': 2.6,
                        'circle-stroke-opacity': 0,
                        'circle-radius': RING_MIN,
                        'circle-blur': 0.15
                    }
                });
            });
        });
    }

    // Slower than the travelling dashes: a ring has to be followable across its
    // whole run, and faster than this it crossed before the eye could track it.
    const RING_STEPS = 52;
    let ringStep = 0;

    function paintRings() {
        PULSES.forEach(function (pulse) {
            pulse.ringIds.forEach(function (id, index) {
                if (!map.getLayer(id)) return;

                // Half a cycle apart, so one ring is always going out as the
                // other fades. A single ring reads as a blink.
                let phase = ((ringStep / RING_STEPS) + index * 0.5) % 1;

                // Direction is the meaning. Inward means energy arriving: the
                // campus exporting to the grid, or the battery charging.
                if (pulse.direction < 0) phase = 1 - phase;

                map.setPaintProperty(id, 'circle-radius',
                    RING_MIN + phase * (RING_MAX - RING_MIN));

                // Faint at both ends, brightest in the middle of the run.
                // Ramping down from full made the ring brightest when it was
                // smallest, so the eye caught each new one at the centre and
                // read the whole thing as collapsing inward.
                const travel = pulse.direction < 0 ? 1 - phase : phase;
                const visibility = Math.sin(Math.PI * travel);
                map.setPaintProperty(id, 'circle-stroke-opacity',
                    ['*', visibility * 0.95,
                         ['+', 0.4, ['*', 0.6, ['get', pulse.field]]]]);
                // Thinning as it goes reads as spreading out rather than looming.
                map.setPaintProperty(id, 'circle-stroke-width', 3.2 - travel * 1.8);
            });
        });
    }

    function ensureNodesSource() {
        if (!map.getSource(NODES_SOURCE_ID)) {
            map.addSource(NODES_SOURCE_ID, { type: 'geojson', data: nodeData });
        }
    }

    function addNodeLayers() {
        ensureNodesSource();

        registerIcons();

        // Solar output for the hour, as a halo behind the building marker.
        // On the node points, not the footprints - a circle layer on a polygon
        // draws one circle per vertex, which is what produced the ring of
        // yellow blobs around each roof.
        if (!map.getLayer(SOLAR_LAYER_ID)) {
            map.addLayer({
                id: SOLAR_LAYER_ID,
                type: 'circle',
                source: NODES_SOURCE_ID,
                filter: SOLAR_BASE_FILTER,
                paint: {
                    'circle-color': KIND_COLORS.pv,
                    'circle-blur': 0.75,
                    'circle-radius': ['+', 6, ['*', 22, ['get', 'solarNow']]],
                    'circle-opacity': ['*', 0.55, ['get', 'solarNow']]
                }
            });
        }


        // Roof arrays get no marker of their own: they sit on their host, and
        // the building already carries the solar halo.
        if (!map.getLayer(NODE_LAYER_ID)) {
            map.addLayer({
                id: NODE_LAYER_ID,
                type: 'symbol',
                source: NODES_SOURCE_ID,
                filter: NODE_BASE_FILTER,
                layout: {
                    'icon-image': [
                        'case',
                        ['==', ['get', 'has_pv'], 1], 'ecom-building-pv',
                        // The battery picks the image for its current charge.
                        ['==', ['get', 'kind'], 'battery'],
                        ['concat', 'ecom-battery-fill-',
                            ['to-string', ['get', 'fillStep']]],
                        ['concat', 'ecom-', ['get', 'kind']]
                    ],
                    // Community assets read a step larger - they serve every
                    // member, and the grid connection vanishing into the
                    // building markers is the wrong emphasis.
                    'icon-size': [
                        'case',
                        ['==', ['get', 'kind'], 'building'], 0.62,
                        0.82
                    ],
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true,
                    // The label is part of the same symbol so it can never be
                    // placed away from the icon it belongs to.
                    'text-field': ['get', 'name'],
                    'text-font': ['Open Sans Regular'],
                    'text-size': 9.5,
                    'text-offset': [0, 1.5],
                    'text-anchor': 'top',
                    'text-optional': true,
                    'text-padding': 3
                },
                paint: {
                    'text-color': LABEL_INK,
                    // A wide dark halo stands in for the dashboard's label
                    // chip; MapLibre has no background box for a text field.
                    'text-halo-color': LABEL_CHIP,
                    'text-halo-width': 2,
                    'text-halo-blur': 0.4
                }
            });
        }
    }

    function setLayerVisibility(visible) {
        const value = visible ? 'visible' : 'none';
        [
            FILL_LAYER_ID, SOLAR_LAYER_ID,
            FLOW_GLOW_ID, FLOW_LAYER_ID, NODE_LAYER_ID
        ].concat(PULSE_LAYER_IDS).forEach(function (id) {
            if (map.getLayer(id)) {
                map.setLayoutProperty(id, 'visibility', value);
            }
        });

        if (visible) {
            startPulse();
            startClock();
        } else {
            stopPulse();
            stopClock();
        }
    }

    // Travelling dashes.
    //
    // A precomputed sequence stepped on a timer, not a fractional dasharray set
    // every frame: MapLibre rebuilds its dash texture atlas whenever the array
    // changes, so feeding it new fractional values at 60 fps thrashes that
    // atlas and the animation stalls after about a second. Integer patterns
    // cycled at ~50 ms is the pattern Mapbox's own "ant path" example uses, and
    // it stays smooth because each entry is cached.
    const DASH_SEQUENCE = [
        [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5],
        [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5],
        [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5],
        [0, 3, 3, 1], [0, 3.5, 3, 0.5]
    ];

    let pulseStep = 0;

    let pulseTimer = null;

    function startPulse() {
        if (pulseTimer !== null) return;
        pulseTimer = setInterval(function () {
            if (!map.getLayer(FLOW_LAYER_ID)) return;
            pulseStep = (pulseStep + 1) % DASH_SEQUENCE.length;
            map.setPaintProperty(FLOW_LAYER_ID, 'line-dasharray',
                                 DASH_SEQUENCE[pulseStep]);
            ringStep = (ringStep + 1) % RING_STEPS;
            paintRings();
        }, 55);
    }

    function stopPulse() {
        if (pulseTimer !== null) {
            clearInterval(pulseTimer);
            pulseTimer = null;
        }
    }

    // Scale each roof's halo to its output this hour, against its own best hour
    // rather than nameplate capacity - the arrays never reach nameplate, so
    // scaling to it leaves every halo invisible even at midday.
    function setHour(hour) {
        currentHour = hour;
        if (!isActive || !layerData) return;

        const source = map.getSource(NODES_SOURCE_ID);
        if (!source) return;

        // What the grid tie is pushing into the campus this hour, against its
        // own busiest hour. Scaled to itself rather than to the largest flow on
        // the table: the question the pulse answers is "is the campus leaning
        // on the grid right now", which is about this node over the day.
        // Net through each pulsing node: what it sends out, less what it takes
        // in. Counting one direction only made an importing node and an
        // exporting one look identical, which is the whole point of the pulse.
        const level = {};
        if (flowData) {
            const hours = (flowData.features[0] &&
                (flowData.features[0].properties.flow_hourly || []).length) || 0;

            PULSES.forEach(function (pulse) {
                const node = nodeData.features.find(function (feature) {
                    return feature.properties.kind === pulse.kind;
                });
                if (!node) {
                    pulse.direction = 1;
                    level[pulse.field] = 0;
                    return;
                }
                const id = node.properties.id;

                const netAt = function (h) {
                    let net = 0;
                    flowData.features.forEach(function (feature) {
                        const props = feature.properties;
                        const value = (props.flow_hourly || [])[h] || 0;
                        if (props.source === id) net += value;
                        else if (props.target === id) net -= value;
                    });
                    return net;
                };

                // Against its own busiest hour in either direction, so each
                // node is measured against itself. The battery moves three
                // orders of magnitude less than the grid tie and on a shared
                // scale would never light at all.
                let peak = 0;
                for (let h = 0; h < hours; h += 1) {
                    const magnitude = Math.abs(netAt(h));
                    if (magnitude > peak) peak = magnitude;
                }

                const net = netAt(hour);
                // Positive means energy leaving the node: the grid supplying
                // the campus, or the battery discharging.
                pulse.direction = net < 0 ? -1 : 1;
                level[pulse.field] = peak > 0 ? Math.abs(net) / peak : 0;
            });
        }

        const stored = storageCurve ? (storageCurve[hour] || 0) : 0;

        nodeData.features.forEach(function (feature) {
            const series = feature.properties.solar_hourly || [];
            const peak = series.length ? Math.max.apply(null, series) : 0;
            const now = series[hour] || 0;
            feature.properties.solarNow = peak > 0 ? now / peak : 0;
            if (feature.properties.kind === 'battery') {
                feature.properties.storedNow = stored;
                // Which of the eleven images to show. Rounded rather than
                // floored so a nearly full battery does not read as 90%.
                feature.properties.fillStep = Math.round(stored * FILL_STEPS);
            }

            PULSES.forEach(function (pulse) {
                feature.properties[pulse.field] =
                    feature.properties.kind === pulse.kind
                        ? (level[pulse.field] || 0) : 0;
            });
        });

        source.setData(nodeData);
        setFlowHour(hour);
        reportForSound(hour, stored);
        reportVehicles(hour);
    }

    // Where the cars are this hour, sent to animations/ecom-vehicles.js.
    //
    // Presence comes from the vehicle's own schedule, not from the charging
    // flow: a car that has finished charging is still parked, and drawing it
    // away at that moment would say something the model does not.
    function reportVehicles(hour) {
        if (!nodeData) return;
        const points = [];
        nodeData.features.forEach(function (feature) {
            const props = feature.properties;
            if (props.kind !== 'charge_point') return;
            const schedule = props.plugged_hourly || [];
            let charging = false;
            if (flowData) {
                charging = flowData.features.some(function (flow) {
                    return flow.properties.target === props.id &&
                        ((flow.properties.flow_hourly || [])[hour] || 0) > 0;
                });
            }
            points.push({
                id: props.id,
                name: props.name,
                lon: feature.geometry.coordinates[0],
                lat: feature.geometry.coordinates[1],
                // No schedule means no vehicle to draw, rather than one that
                // is always there: an empty charger should look empty.
                plugged: schedule.length ? !!schedule[hour] : false,
                charging: charging
            });
        });
        ecomChannel.postMessage({ type: 'ecom_vehicles', hour: hour,
                                  chargePoints: points });
    }

    // What the hour sounds like, sent to animations/ecom-sound.js.
    //
    // Broadcast from here rather than recomputed there: the sound has to be of
    // the hour that was just drawn, and a second calculation from the same data
    // is a second thing that can fall out of step.
    function reportForSound(hour, stored) {
        // Self-sufficiency for this hour, not the period total: what the
        // texture is describing is now.
        let localKwh = 0;
        let gridKwh = 0;
        if (flowData) {
            flowData.features.forEach(function (feature) {
                const props = feature.properties;
                if (props.target_kind !== 'building') return;
                const value = (props.flow_hourly || [])[hour] || 0;
                if (props.kind === 'grid') gridKwh += value;
                else localKwh += value;
            });
        }
        const served = localKwh + gridKwh;

        // Roof output against the campus's best hour, so the bell tracks the
        // arc of the day rather than each roof's own noon.
        let solar = 0;
        let solarPeak = 0;
        nodeData.features.forEach(function (feature) {
            const series = feature.properties.solar_hourly || [];
            solar += series[hour] || 0;
            series.forEach(function (v) { if (v > solarPeak) solarPeak = v; });
        });

        const gridNode = nodeData.features.find(function (feature) {
            return feature.properties.kind === 'grid';
        });

        ecomChannel.postMessage({
            type: 'ecom_audio',
            reading: {
                hour: hour,
                gridNow: gridNode ? (gridNode.properties.gridNow || 0) : 0,
                selfSufficiency: served > 0 ? localKwh / served : 0,
                solarNow: solarPeak > 0 ? Math.min(1, solar / (solarPeak * 8)) : 0,
                storedNow: stored || 0
            }
        });
    }

    // Line width is scaled against the largest flow anywhere in the horizon,
    // not against each line's own peak. Per-line normalising would draw a
    // 0.3 kW trickle as wide as a 1,269 kW grid feed, which is exactly the
    // comparison the picture is meant to make.
    let flowCeiling = 0;

    // A floor under the width and opacity scale.
    //
    // The scale is a ratio, and below a point the ratio stops being the useful
    // thing to say. One charge point drawing 0.6 kW beside a campus importing
    // 2,400 works out at 1% opacity - a line that exists in the data and not on
    // the table, which reads as a missing connection rather than a small one.
    // Floored, it is drawn faintly: unmistakably slighter than a real flow, but
    // there. Zero is still zero - nothing is invented for a line carrying
    // nothing this hour.
    const MIN_VISIBLE_SHARE = 0.22;

    function setFlowHour(hour) {
        if (!flowData) return;
        const source = map.getSource(FLOWS_SOURCE_ID);
        if (!source) return;

        flowData.features.forEach(function (feature) {
            const series = feature.properties.flow_hourly || [];
            const now = series[hour] || 0;
            feature.properties.flowNow = now;
            // Square root, so the small community flows stay visible next to
            // grid imports three orders of magnitude larger.
            feature.properties.share = (now > 0 && flowCeiling > 0)
                ? Math.max(Math.sqrt(now / flowCeiling), MIN_VISIBLE_SHARE)
                : 0;
        });

        source.setData(flowData);
    }

    // Day clock.
    //
    // The table runs the day on its own: it is a display with nobody at a
    // keyboard, so a static hour would just look broken. The ECOM dashboard can
    // still take over - a timeline message stops the clock, because two things
    // driving the hour at once reads as a stutter.
    const HOUR_MS = 1100;

    let clockTimer = null;
    let hourCount = 24;
    let externalControl = false;

    function startClock() {
        if (clockTimer !== null || externalControl) return;
        clockTimer = setInterval(function () {
            setHour((currentHour + 1) % hourCount);
            ecomChannel.postMessage({
                type: 'ecom_clock', hour: currentHour, hours: hourCount
            });
        }, HOUR_MS);
    }

    function stopClock() {
        if (clockTimer !== null) {
            clearInterval(clockTimer);
            clockTimer = null;
        }
    }

    // ---------------------------------------------------------- interaction

    let interactionBound = false;

    function bindInteraction() {
        if (interactionBound) return;
        interactionBound = true;

        map.on('click', FILL_LAYER_ID, function (e) {
            const feature = e.features && e.features[0];
            if (!feature) return;

            let ecom = feature.properties.ecom;
            if (typeof ecom === 'string') {
                try {
                    ecom = JSON.parse(ecom);
                } catch (err) {
                    ecom = null;
                }
            }
            if (!ecom) return;

            new maplibregl.Popup({ closeButton: true, className: 'ecom-popup' })
                .setLngLat(e.lngLat)
                .setHTML(
                    '<strong>' + ecom.name + '</strong><br>' +
                    ecom.self_sufficiency.toFixed(1) + '% self-sufficient<br>' +
                    Math.round(ecom.demand_kwh).toLocaleString() + ' kWh demand<br>' +
                    ecom.pv_kw.toFixed(1) + ' kW PV'
                )
                .addTo(map);

            // The controller dashboard mirrors whatever is selected here.
            ecomChannel.postMessage({ type: 'ecom_selection', building: ecom });
        });

        map.on('mouseenter', FILL_LAYER_ID, function () {
            map.getCanvas().style.cursor = 'pointer';
        });

        map.on('mouseleave', FILL_LAYER_ID, function () {
            map.getCanvas().style.cursor = '';
        });
    }

    // ------------------------------------------------- live layer + filters

    // A layer pushed by the controller, already dispatched by the backend.
    //
    // This is the same payload the committed export holds, built by the same
    // app/services/mr_layer.py, so a slider moved at the table and a file
    // written by export_mr_layer.py cannot draw two different pictures.
    function applyLayer(layer) {
        if (!layer || !layer.buildings || !layer.nodes || !layer.flows) return;

        layerData = layer.buildings;
        nodeData = layer.nodes;
        flowData = layer.flows;

        // prepare() re-derives flowCeiling from these flows, so the width scale
        // follows the new community rather than the one it replaced.
        prepare();

        // Marked loaded so a later activate() uses what was pushed rather than
        // fetching the export over the top of it.
        isLoaded = true;

        // Sources are written even while the layer is off. They outlive a
        // deactivation - only their visibility is toggled - so skipping this
        // would leave the previous community sitting in them, and switching the
        // layer back on would draw it.
        const fillSource = map.getSource(SOURCE_ID);
        const nodeSource = map.getSource(NODES_SOURCE_ID);
        const flowSource = map.getSource(FLOWS_SOURCE_ID);
        if (fillSource) fillSource.setData(layerData);
        if (nodeSource) nodeSource.setData(nodeData);
        if (flowSource) flowSource.setData(flowData);

        if (!isActive) return;

        applyFilters(viewFilters);
        setHour(currentHour % hourCount);

        ecomChannel.postMessage({ type: 'ecom_summary', summary: buildSummary() });

        // Sent after the sources are written, not before: this is the
        // controller's evidence that the table actually redrew, rather than
        // that a message was sent into the void.
        ecomChannel.postMessage({
            type: 'ecom_applied',
            period: (layer.meta && layer.meta.period) || '',
            hours: hourCount,
            nodes: nodeData.features.length,
            flows: flowData.features.length
        });
    }

    // What the controller's View group hides. Held so a layer swap can put the
    // same filters back - MapLibre filters live on the layer, and the data
    // under them changing does not re-apply them, but a re-added layer starts
    // unfiltered.
    let viewFilters = null;

    /**
     * The halos, which a kind filter never used to reach.
     *
     * The grid ring, the battery glow and the solar bloom are layers of their
     * own, each drawn from the nodes source with its own per-kind filter, so
     * filtering the marker layer left them all pulsing away. At step one of the
     * introduction - buildings only - the grid still rang and the battery still
     * glowed, which rather gave the game away.
     */
    function applyHaloVisibility(kinds) {
        const shown = function (kind) {
            return !kinds || !kinds.length || kinds.indexOf(kind) !== -1;
        };
        PULSES.forEach(function (pulse) {
            const on = shown(pulse.kind) ? 'visible' : 'none';
            [pulse.haloId, pulse.coreId].concat(pulse.ringIds)
                .forEach(function (id) {
                    if (map.getLayer(id)) {
                        map.setLayoutProperty(id, 'visibility', on);
                    }
                });
        });
        if (map.getLayer(SOLAR_LAYER_ID)) {
            map.setLayoutProperty(SOLAR_LAYER_ID, 'visibility',
                                  shown('pv') ? 'visible' : 'none');
        }
    }

    function applyFilters(filters) {
        viewFilters = filters || null;
        if (!map.getLayer(NODE_LAYER_ID)) return;

        if (!filters) {
            map.setFilter(NODE_LAYER_ID, NODE_BASE_FILTER);
            map.setFilter(SOLAR_LAYER_ID, SOLAR_BASE_FILTER);
            map.setFilter(FLOW_LAYER_ID, null);
            map.setFilter(FLOW_GLOW_ID, null);
            applyHaloVisibility(null);
            return;
        }

        const kinds = filters.kinds || null;
        const owners = filters.owners || null;
        // A fraction of the largest flow in the horizon, matching how the line
        // widths are scaled - an absolute kW threshold would mean something
        // different every time the community is resized.
        const minShare = filters.minFlow || 0;

        const nodeTests = [NODE_BASE_FILTER];
        const solarTests = [SOLAR_BASE_FILTER];
        if (kinds && kinds.length) {
            nodeTests.push(['in', ['get', 'kind'], ['literal', kinds]]);
        }
        if (owners && owners.length) {
            // Community assets - the grid tie, the battery, the charge point -
            // carry an owner only sometimes. Keeping the unowned ones visible
            // stops an owner filter from cutting the flows off at both ends.
            nodeTests.push(['any',
                ['==', ['get', 'owner'], ''],
                ['in', ['get', 'owner'], ['literal', owners]]
            ]);
            solarTests.push(['any',
                ['==', ['get', 'owner'], ''],
                ['in', ['get', 'owner'], ['literal', owners]]
            ]);
        }
        if (typeof filters.minCapacity === 'number' && filters.minCapacity > 0) {
            nodeTests.push(['any',
                ['!', ['has', 'capacity']],
                ['>=', ['get', 'capacity'], filters.minCapacity]
            ]);
        }

        const ceiling = flowCeiling || 1;
        const flowTests = [];
        if (kinds && kinds.length) {
            // Both ends, not just the source. A line needs somewhere to come
            // from and somewhere to go: with only the source tested, unticking
            // Charging left the grid's line to the charger drawn, running to a
            // marker that was no longer on the table.
            flowTests.push(['in', ['get', 'kind'], ['literal', kinds]]);
            flowTests.push(['in', ['get', 'target_kind'], ['literal', kinds]]);
        }
        if (owners && owners.length) {
            flowTests.push(['any',
                ['==', ['get', 'source_owner'], ''],
                ['in', ['get', 'source_owner'], ['literal', owners]],
                ['==', ['get', 'target_owner'], ''],
                ['in', ['get', 'target_owner'], ['literal', owners]]
            ]);
        }
        if (minShare > 0) {
            flowTests.push(['>=', ['get', 'peak'], minShare * ceiling]);
        }

        // An allow-list of source>target pairs, used to introduce the community
        // one relationship at a time. Both endpoints being visible is not
        // enough for that: building-to-building sharing would be on screen from
        // the first step, which is the punchline of the whole sequence.
        const pairs = filters.pairs || null;
        if (pairs) {
            if (!pairs.length) {
                // An empty list means no flows at all - the entities alone.
                flowTests.push(['==', ['get', 'kind'], '\u0000never']);
            } else {
                flowTests.push(['any'].concat(pairs.map(function (pair) {
                    const ends = String(pair).split('>');
                    return ['all',
                        ['==', ['get', 'kind'], ends[0]],
                        ['==', ['get', 'target_kind'], ends[1]]
                    ];
                })));
            }
        }

        map.setFilter(NODE_LAYER_ID, ['all'].concat(nodeTests));
        map.setFilter(SOLAR_LAYER_ID, ['all'].concat(solarTests));
        applyHaloVisibility(kinds);
        const flowFilter = flowTests.length ? ['all'].concat(flowTests) : null;
        map.setFilter(FLOW_LAYER_ID, flowFilter);
        map.setFilter(FLOW_GLOW_ID, flowFilter);
    }

    // -------------------------------------------------------------- control

    // Traffic and live transit are ambient, and street-life.js turns them off
    // by itself for every simulation layer - it reads the button classes. Asked
    // for explicitly as well, because this layer can be switched on in code
    // (ecomEnergyLayer.activate) without a button ever changing class, and
    // because activation is async: the class flips when the toggle resolves,
    // which is after the flows are already on the table.
    function quietTheStreets(layerIsOn) {
        const streets = window.streetLifeAnimation;
        if (!streets) return;

        // Stopped directly, not by asking street-life.js to re-read the button.
        // It decides from `ecom-energy-btn` carrying the class `active`, and
        // syncButton sets that in a .then() after toggle() resolves - which is
        // after this runs. Calling updateVisibility here therefore asked a
        // button that was not yet marked active, got told nothing was running,
        // and STARTED the cars. Worse than not calling it at all.
        if (layerIsOn) {
            if (typeof streets.stop === 'function') streets.stop();
            return;
        }

        // On the way out the button class is equally stale, but here the right
        // answer is "whatever else is on", which is exactly what it computes.
        if (typeof streets.updateVisibility === 'function') {
            setTimeout(streets.updateVisibility, 60);
        }
    }

    async function activate() {
        const ok = await loadData();
        if (!ok) return;

        addLayers();
        // Visibility first, then filters. setLayerVisibility shows every layer
        // it knows about, halos included, so running it second would undo the
        // hiding a kind filter had just done - the introduction's first step
        // would come up with the grid ringing and the battery glowing.
        setLayerVisibility(true);
        // Filters can be set before the layer is switched on; the layers are
        // built unfiltered, so they are re-applied here rather than lost.
        applyFilters(viewFilters);
        isActive = true;
        setHour(currentHour);

        // Marked active here, not in the .then() after toggle() resolves.
        // street-life.js re-reads this class from three places - a mutation
        // observer, its own click handler and a 2.5 s startup timer - and any
        // of them firing while it still said "inactive" restarted the cars
        // straight after this layer had stopped them.
        syncButton();
        quietTheStreets(true);

        ecomChannel.postMessage({
            type: 'animation_state',
            animationId: 'ecom-energy-btn',
            isActive: true
        });

        // Totals for the controller panel, so it does not refetch the export.
        ecomChannel.postMessage({
            type: 'ecom_summary',
            summary: buildSummary()
        });
    }

    function deactivate() {
        showCaption(null);
        setLayerVisibility(false);
        isActive = false;
        syncButton();
        quietTheStreets(false);

        ecomChannel.postMessage({
            type: 'animation_state',
            animationId: 'ecom-energy-btn',
            isActive: false
        });
    }

    async function toggle() {
        if (isActive) {
            deactivate();
        } else {
            await activate();
        }
    }

    function buildSummary() {
        if (!layerData) return null;

        let demand = 0;
        let local = 0;
        let solar = 0;
        let pv = 0;
        let members = 0;

        layerData.features.forEach(function (feature) {
            const ecom = feature.properties.ecom;
            if (!ecom) return;
            members += 1;
            demand += ecom.demand_kwh;
            local += ecom.local_kwh;
            solar += ecom.solar_kwh;
            pv += ecom.pv_kw;
        });

        return {
            members: members,
            demandKwh: demand,
            localKwh: local,
            solarKwh: solar,
            pvKw: pv,
            selfSufficiency: demand > 0 ? (local / demand) * 100 : 0,
            period: (layerData.ecom_meta && layerData.ecom_meta.period) || '',
            hours: (layerData.ecom_meta && layerData.ecom_meta.hours) || 0
        };
    }

    function syncButton() {
        const btn = document.getElementById('ecom-energy-btn');
        if (btn) btn.classList.toggle('active', isActive);
    }

    // The controller drives every layer by clicking its display button, so the
    // button is the whole public surface.
    //
    // Bound when the map is ready rather than on DOMContentLoaded, matching
    // isovist: activate() touches map sources immediately, and the button can
    // be clicked before the style has finished loading.
    function initEcomLayer() {
        const btn = document.getElementById('ecom-energy-btn');
        if (!btn) return;

        btn.addEventListener('click', function () {
            // toggle() is async - awaiting it is what makes the button state
            // follow the layer instead of leading it by one click.
            toggle().then(syncButton).catch(function (error) {
                console.error('ECOM: toggle failed', error);
                if (typeof showToast === 'function') showToast('ECOM layer failed - see console');
                syncButton();
            });
        });
    }

    if (window.map && window.map.loaded()) {
        initEcomLayer();
    } else if (window.map) {
        window.map.on('load', initEcomLayer);
    } else {
        const waitForMap = setInterval(function () {
            if (!window.map) return;
            clearInterval(waitForMap);
            if (window.map.loaded()) {
                initEcomLayer();
            } else {
                window.map.on('load', initEcomLayer);
            }
        }, 100);
    }

    ecomChannel.addEventListener('message', function (event) {
        const data = event.data || {};

        // Timeline position, sent by the ECOM dashboard's MR table panel.
        if (data.type === 'ecom_hour' && typeof data.hour === 'number') {
            externalControl = true;
            stopClock();
            setHour(data.hour);
        }

        // Hand the day back to the table.
        if (data.type === 'ecom_release') {
            externalControl = false;
            if (isActive) startClock();
        }

        // The controller asks for totals when its panel opens.
        if (data.type === 'ecom_request_summary' && isActive) {
            ecomChannel.postMessage({ type: 'ecom_summary', summary: buildSummary() });
        }

        // A re-dispatched community, sent by the controller's parameter panel.
        if (data.type === 'ecom_layer' && data.layer) {
            applyLayer(data.layer);
        }

        // View filters. These hide what is already on the table, so they need
        // no dispatch and are applied as the control moves.
        // The cars ask for the current hour when they come up, because the
        // day clock can be stopped - the dashboard may be driving the hour -
        // and then no tick would ever arrive to tell them where to be.
        if (data.type === 'ecom_vehicles_request') {
            if (isActive) reportVehicles(currentHour);
            return;
        }

        // The sound asks the same question when it comes up, for the same
        // reason: the day clock may be stopped, and an hour it has not been
        // told about is an hour it cannot describe.
        if (data.type === 'ecom_audio_request') {
            if (isActive) {
                reportForSound(currentHour,
                               storageCurve ? (storageCurve[currentHour] || 0) : 0);
            }
            return;
        }

        if (data.type === 'ecom_caption') {
            showCaption(data.caption || null);
            return;
        }

        if (data.type === 'ecom_filters') {
            applyFilters(data.filters || null);
        }

        // "Is anyone out there?" - answered whether or not the layer is on, so
        // the controller can tell a display that is present but idle from no
        // display at all. A page loaded before this handler existed stays
        // silent, which is the answer the controller needs about that too.
        if (data.type === 'ecom_ping') {
            ecomChannel.postMessage({
                type: 'ecom_pong',
                active: isActive,
                hours: hourCount,
                hour: currentHour
            });
        }
    });

    window.ecomEnergyLayer = {
        activate: activate,
        deactivate: deactivate,
        toggle: toggle,
        setHour: setHour,
        applyLayer: applyLayer,
        applyFilters: applyFilters,
        getSummary: buildSummary,
        isActive: function () { return isActive; }
    };
})();
