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

    // Node and flow colours follow the 2D dashboard, so a building is the same
    // colour in both tools. A link takes the colour of the node it flows out
    // of, which is the rule the dashboard's map uses.
    const KIND_COLORS = {
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
            const responses = await Promise.all([
                fetch(DATA_URL),
                fetch(NODES_URL),
                fetch(FLOWS_URL)
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
        });

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
                    'line-width': ['+', 2, ['*', 16, ['get', 'share']]],
                    'line-opacity': ['*', 0.22, ['get', 'share']],
                    'line-blur': 5
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
                    'line-width': ['+', 0.8, ['*', 7, ['get', 'share']]],
                    'line-opacity': ['*', 0.95, ['get', 'share']]
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

    function registerIcons() {
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

    function addNodeLayers() {
        if (!map.getSource(NODES_SOURCE_ID)) {
            map.addSource(NODES_SOURCE_ID, { type: 'geojson', data: nodeData });
        }

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
        ].forEach(function (id) {
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

    let pulseTimer = null;
    let pulseStep = 0;

    function startPulse() {
        if (pulseTimer !== null) return;
        pulseTimer = setInterval(function () {
            if (!map.getLayer(FLOW_LAYER_ID)) return;
            pulseStep = (pulseStep + 1) % DASH_SEQUENCE.length;
            map.setPaintProperty(FLOW_LAYER_ID, 'line-dasharray', DASH_SEQUENCE[pulseStep]);
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

        nodeData.features.forEach(function (feature) {
            const series = feature.properties.solar_hourly || [];
            const peak = series.length ? Math.max.apply(null, series) : 0;
            const now = series[hour] || 0;
            feature.properties.solarNow = peak > 0 ? now / peak : 0;
        });

        source.setData(nodeData);
        setFlowHour(hour);
    }

    // Line width is scaled against the largest flow anywhere in the horizon,
    // not against each line's own peak. Per-line normalising would draw a
    // 0.3 kW trickle as wide as a 1,269 kW grid feed, which is exactly the
    // comparison the picture is meant to make.
    let flowCeiling = 0;

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
            feature.properties.share = flowCeiling > 0
                ? Math.sqrt(now / flowCeiling)
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

    function applyFilters(filters) {
        viewFilters = filters || null;
        if (!map.getLayer(NODE_LAYER_ID)) return;

        if (!filters) {
            map.setFilter(NODE_LAYER_ID, NODE_BASE_FILTER);
            map.setFilter(SOLAR_LAYER_ID, SOLAR_BASE_FILTER);
            map.setFilter(FLOW_LAYER_ID, null);
            map.setFilter(FLOW_GLOW_ID, null);
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
            flowTests.push(['in', ['get', 'kind'], ['literal', kinds]]);
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

        map.setFilter(NODE_LAYER_ID, ['all'].concat(nodeTests));
        map.setFilter(SOLAR_LAYER_ID, ['all'].concat(solarTests));
        const flowFilter = flowTests.length ? ['all'].concat(flowTests) : null;
        map.setFilter(FLOW_LAYER_ID, flowFilter);
        map.setFilter(FLOW_GLOW_ID, flowFilter);
    }

    // -------------------------------------------------------------- control

    async function activate() {
        const ok = await loadData();
        if (!ok) return;

        addLayers();
        // Filters can be set before the layer is switched on; the layers are
        // built unfiltered, so they are re-applied here rather than lost.
        applyFilters(viewFilters);
        setLayerVisibility(true);
        isActive = true;
        setHour(currentHour);

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
        setLayerVisibility(false);
        isActive = false;

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
