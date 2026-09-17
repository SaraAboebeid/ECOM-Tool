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
    const OUTLINE_LAYER_ID = 'ecom-buildings-outline';
    const SOLAR_LAYER_ID = 'ecom-buildings-solar';

    const NODES_SOURCE_ID = 'ecom-nodes-source';
    const NODE_LAYER_ID = 'ecom-nodes';

    const FLOWS_SOURCE_ID = 'ecom-flows-source';
    const FLOW_LAYER_ID = 'ecom-flows';
    const FLOW_GLOW_ID = 'ecom-flows-glow';
    // One travelling light per line, and the glow around it.
    const FLOW_HEAD_SOURCE_ID = 'ecom-flow-heads-source';
    const FLOW_HEAD_GLOW_ID = 'ecom-flows-head-glow';
    const FLOW_HEAD_ID = 'ecom-flows-head';

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

    // The colour a building sits at when it is drawing nothing. Not black: an
    // unlit member is still a member, and the table has to show it as one.
    const DEMAND_COLD = '#2a0b23';

    // How much colour a member gets before its demand is counted at all.
    //
    // Everything is shaded against the busiest building-hour on the campus, and
    // that hour belongs to MC2 at 1,286 kW while Vasa 13 draws 0.04. Even under
    // a square root that put seventeen of the thirty-two members below 0.2 at
    // noon - a shade indistinguishable from unlit on a projection table, so
    // half the community looked as though it were not in it. Membership is the
    // first thing the table has to say; how hard each one is working is the
    // second. So a member starts here and its demand spends what is left.
    const MEMBER_FLOOR = 0.35;
    // Same argument for a roof: five buildings carry PV and the smallest array
    // would otherwise never be visible against the largest one at noon. Only
    // while the sun is actually on it - an unlit roof at night is the truth.
    const SOLAR_FLOOR = 0.3;
    const SOLAR_BASE_FILTER = ['==', ['get', 'has_pv'], 1];

    // The building that holds the community battery, drawn as the battery.
    //
    // A marker on the roof could not work at this scale: the icon was 21 m
    // across, its dark stage 29 m and its glow 75 m, over a footprint 74 m
    // wide - the battery covered the building it was meant to belong to, and
    // it sat on a wall, because AWL is modelled in three parts and the middle
    // of them all lands on a join. So the building itself is the vessel: its
    // outline lights and its floor fills as the charge goes in and out.
    // Two readings on one building, because a building can be both.
    //
    // AWL holds the battery and will have a demand of its own as soon as its
    // data arrives. Tinting the whole footprint red would overwrite the pink
    // that says what it is drawing, so the charge is drawn as a level rising
    // inside the outline instead - the same vessel-filling the battery marker
    // uses, at the size of a building. The pink fill underneath is untouched:
    // demand is the fill, charge is the level, solar is the halo.
    const BATTERY_HOST_FILL_ID = 'ecom-battery-host-fill';
    const BATTERY_HOST_LINE_ID = 'ecom-battery-host-line';
    const BATTERY_LEVEL_SOURCE_ID = 'ecom-battery-level-source';
    const BATTERY_LEVEL_ID = 'ecom-battery-level';
    const BATTERY_HOST_FILTER = ['==', ['get', 'batteryHost'], 1];
    const NODE_BASE_FILTER = ['!=', ['get', 'kind'], 'pv'];

    const ecomChannel = new BroadcastChannel('map_controller_channel');

    let layerData = null;
    // The busiest single building-hour on the campus. Every footprint is shaded
    // against this rather than against itself, because the question the table
    // is answering is which buildings are heavy, not whether each one is having
    // a busy morning by its own standards.
    let demandCeiling = 0;
    // The brightest roof-hour on the campus, so one building at noon is the
    // full halo and everything else is read against it.
    let solarCeiling = 0;
    let nodeData = null;
    let flowData = null;
    // Footprint ids that hold a battery, by folded name.
    let batteryHosts = {};
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

        // The routes changed, so the lights have new ground to cover.
        measureFlows();

        // Flows start at zero width; setHour fills them in.
        flowData.features.forEach(function (feature) {
            feature.properties.flowNow = 0;
            feature.properties.share = 0;
            // Fully drawn unless the introduction is bringing them in one at
            // a time. Multiplied into the opacity, so a line that has not
            // arrived yet is simply not painted.
            feature.properties.revealed = 1;
        });

        // Flatten the values the paint expressions need onto each feature.
        // MapLibre exposes nested GeoJSON properties as JSON strings, so an
        // expression cannot read a field inside `ecom` - demandNow has to be
        // written flat, hour by hour, for the fill to interpolate on it.
        // Which footprint holds the battery, if any. Folded the way the
        // backend folds it, so 'Kårhus' and 'karhus' are the same building.
        batteryHosts = {};
        nodeData.features.forEach(function (feature) {
            const props = feature.properties;
            if (props.kind !== 'battery' || !props.host) return;
            batteryHosts[foldName(props.host)] = true;
            // The marker steps aside for the building: a badge on the edge
            // rather than a disc over the roof.
            props.hostedBattery = 1;
        });

        // A battery in a building lies along the building. The marker is drawn
        // upright, and AWL runs at an angle across the table, so an upright
        // battery standing on it read as something dropped there rather than
        // something built in.
        nodeData.features.forEach(function (feature) {
            const props = feature.properties;
            props.iconRotate = 0;
            if (props.hostedBattery !== 1) return;
            const host = layerData.features.find(function (building) {
                return foldName(building.properties.id) === foldName(props.host);
            });
            if (host) props.iconRotate = alongBuilding(host);
        });

        // Where each building sits across the table, 0 at the left edge and 1
        // at the right, in screen terms: the map is turned about 93 degrees, so
        // "across the table" is not east-west.
        const bearing = (typeof map.getBearing === 'function' ? map.getBearing() : 0)
            * Math.PI / 180;
        const rightX = Math.cos(bearing);
        const rightY = -Math.sin(bearing);
        let minAcross = Infinity;
        let maxAcross = -Infinity;
        layerData.features.forEach(function (feature) {
            const centre = footprintCentre(feature);
            if (!centre) { feature.properties.sweepAt = 0; return; }
            const along = centre[0] * 0.5351 * rightX + centre[1] * rightY;
            feature.properties.sweepAt = along;
            if (along < minAcross) minAcross = along;
            if (along > maxAcross) maxAcross = along;
        });
        layerData.features.forEach(function (feature) {
            feature.properties.sweepAt = maxAcross > minAcross
                ? (feature.properties.sweepAt - minAcross) / (maxAcross - minAcross)
                : 0;
        });

        demandCeiling = 0;
        solarCeiling = 0;
        layerData.features.forEach(function (feature) {
            const ecom = feature.properties.ecom;
            feature.properties.hasData = ecom ? 1 : 0;
            feature.properties.batteryHost =
                batteryHosts[foldName(feature.properties.id)] ? 1 : 0;
            feature.properties.storedNow = 0;
            feature.properties.demandNow = 0;
            feature.properties.solarNow = 0;
            // The solar halo and the owner filter both read these off the
            // polygon, and neither can reach inside the nested `ecom` block.
            feature.properties.has_pv = (ecom && ecom.pv_kw > 0) ? 1 : 0;
            feature.properties.owner = (ecom && ecom.owner) || '';
            (ecom && ecom.demand_hourly ? ecom.demand_hourly : []).forEach(
                function (value) {
                    if (value > demandCeiling) demandCeiling = value;
                });
            (ecom && ecom.solar_hourly ? ecom.solar_hourly : []).forEach(
                function (value) {
                    if (value > solarCeiling) solarCeiling = value;
                });
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
        buildChargeCurves();

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

    // --------------------------------------------------------------- change
    //
    // Something joining or leaving the community, staged in three beats.
    //
    // A change used to simply happen: a second after Apply the table was
    // different, every line had shifted, and nobody in the room knew where to
    // look or what had caused it. A redraw with no warning reads as a fault.
    //
    //   announce   the rest of the table dims and the caption says what is
    //              coming. Nothing has changed yet; the room is told where to
    //              look. This beat also covers the dispatch round trip, so the
    //              new layer arrives inside the animation rather than after it.
    //
    //   land       the marker appears oversized and translucent on its own spot
    //              and contracts onto it, while a ring travels out across the
    //              map. The new dispatch lands as the ring passes, so the whole
    //              reshuffle reads as caused by the thing that just arrived.
    //
    //   settle     the table comes back up and the caption says what it did to
    //              the community, which is what turns "something happened" into
    //              something worth having watched.
    //
    // Removal is the same language backwards: the ring contracts, the marker
    // grows and fades, and the object is gone.
    const SCRIM_LAYER_ID = 'ecom-change-scrim';
    const SCRIM_SOURCE_ID = 'ecom-change-scrim-source';

    // The spotlight left open in the scrim, in metres. It closes from the
    // wider figure to the tighter one as the marker lands, so the darkness
    // itself moves inward onto the change rather than the change having to
    // compete with a flat wash for attention.
    const HOLE_OPEN_M = 240;
    const HOLE_CLOSED_M = 95;
    const CHANGE_SOURCE_ID = 'ecom-change-source';
    // Three, a beat apart. One ring reads as a circle drawn on the map; three
    // travelling out behind each other read as something spreading from a
    // place, which is what the moment is - and on a projection the wave is
    // legible from across the room where a single stroke is not.
    const CHANGE_RING_IDS = ['ecom-change-ring', 'ecom-change-ring-b',
                             'ecom-change-ring-c'];
    const RING_STAGGER = 0.17;
    const CHANGE_MARK_ID = 'ecom-change-mark';
    const CHANGE_GLOW_ID = 'ecom-change-glow';

    const ANNOUNCE_MS = 400;
    const LAND_MS = 800;
    const SETTLE_MS = 600;

    // How dark the rest of the table goes, and how much bigger the arriving
    // marker starts than it ends.
    const SCRIM_DEPTH = 0.62;
    const MARK_SCALE = 4;

    let change = null;              // the run in progress
    let changeFrame = null;

    function ensureChangeLayers() {
        if (!map.getSource(CHANGE_SOURCE_ID)) {
            map.addSource(CHANGE_SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }
        if (!map.getSource(SCRIM_SOURCE_ID)) {
            map.addSource(SCRIM_SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }
        // Added after every other layer, so the scrim covers the table and the
        // three change layers sit above the scrim rather than under it.
        //
        // A fill rather than a background, because a background cannot have a
        // hole in it: this is a polygon over the whole world with a circle cut
        // out of it where the change is, which is the difference between "the
        // table went dark" and "look here".
        if (!map.getLayer(SCRIM_LAYER_ID)) {
            map.addLayer({
                id: SCRIM_LAYER_ID,
                type: 'fill',
                source: SCRIM_SOURCE_ID,
                paint: { 'fill-color': '#000', 'fill-opacity': 0 }
            });
        }
        CHANGE_RING_IDS.forEach(function (id, index) {
            if (map.getLayer(id)) return;
            map.addLayer({
                id: id,
                type: 'circle',
                source: CHANGE_SOURCE_ID,
                paint: {
                    'circle-color': 'rgba(0,0,0,0)',
                    'circle-radius': 0,
                    'circle-stroke-color': ['get', 'colour'],
                    // The leading ring is the heaviest; the two behind it are
                    // its wake rather than three of the same thing.
                    'circle-stroke-width': 5 - index * 1.4,
                    'circle-stroke-opacity': 0
                }
            });
        });
        if (!map.getLayer(CHANGE_GLOW_ID)) {
            map.addLayer({
                id: CHANGE_GLOW_ID,
                type: 'circle',
                source: CHANGE_SOURCE_ID,
                paint: {
                    'circle-color': ['get', 'colour'],
                    'circle-blur': 0.9,
                    'circle-radius': 0,
                    'circle-opacity': 0
                }
            });
        }
        if (!map.getLayer(CHANGE_MARK_ID)) {
            map.addLayer({
                id: CHANGE_MARK_ID,
                type: 'symbol',
                source: CHANGE_SOURCE_ID,
                layout: {
                    'icon-image': ['get', 'icon'],
                    'icon-size': 1,
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true
                },
                paint: { 'icon-opacity': 0 }
            });
        }
    }

    /**
     * Everywhere, minus a circle around one point.
     *
     * The outer ring runs anticlockwise and the hole clockwise, which is what
     * GeoJSON asks for and what tells a renderer which part to leave alone.
     */
    function scrimWithHole(at, radiusMetres) {
        return scrimWithHoles(at ? [at] : [], radiusMetres);
    }

    /**
     * The same, with a hole for each place the change touches.
     *
     * "Panels on every roof" is one change in thirty places. Spotlighting the
     * first of them and letting the rest arrive afterwards said the change was
     * about that one building, which it was not.
     */
    function scrimWithHoles(points, radiusMetres) {
        const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
        const rings = [world];

        (points || []).forEach(function (at) {
            if (!at) return;
            const lat = at[1];
            const dLat = radiusMetres / 110540;
            const dLon = radiusMetres / (111320 * Math.cos(lat * Math.PI / 180));
            const hole = [];
            const steps = 48;
            for (let i = 0; i <= steps; i += 1) {
                // Clockwise, so it reads as a hole rather than a second island.
                const angle = -2 * Math.PI * (i / steps);
                hole.push([at[0] + Math.cos(angle) * dLon,
                           lat + Math.sin(angle) * dLat]);
            }
            rings.push(hole);
        });

        return {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {},
                         geometry: { type: 'Polygon', coordinates: rings } }]
        };
    }

    /** A colour mixed most of the way to black, for the scrim. */
    function darkened(hex, keep) {
        const value = String(hex).replace('#', '');
        if (value.length !== 6) return '#000';
        const channel = function (at) {
            return Math.round(parseInt(value.substr(at, 2), 16) * keep);
        };
        const pair = function (n) {
            const text = n.toString(16);
            return text.length === 1 ? '0' + text : text;
        };
        return '#' + pair(channel(0)) + pair(channel(2)) + pair(channel(4));
    }

    // MapLibre rejects an opacity outside 0..1 outright - it logs the value and
    // keeps the old one - so the frame is simply lost. Clamped here rather than
    // at each caller: this is the one place every one of them goes through.
    function held(value) {
        return Math.max(0, Math.min(1, value));
    }

    function paintChange(scrim, ringRadius, ringOpacity, glow, markSize, markOpacity,
                         holeMetres) {
        map.setPaintProperty(SCRIM_LAYER_ID, 'fill-opacity', held(scrim));
        if (change && holeMetres !== undefined && holeMetres !== change.hole) {
            change.hole = holeMetres;
            const source = map.getSource(SCRIM_SOURCE_ID);
            // A change in many places has no spotlight - set at the start of
            // the beat, and kept that way here, where every frame used to put
            // all thirty holes back.
            if (source) {
                source.setData(scrimWithHoles(
                    change.bulk ? [] : (change.places || [change.at]), holeMetres));
            }
        }
        // Rings travel from every feature in the source at once. For a change
        // in one place that is the point; for a change in thirty it is thirty
        // expanding rings crossing each other, so they are left out and the
        // lit roofs carry it.
        const rings = change && change.bulk ? 0 : ringOpacity;
        CHANGE_RING_IDS.forEach(function (id, index) {
            // Each ring is a beat behind the one in front, so the wave has a
            // direction rather than pulsing as one.
            const lag = index * RING_STAGGER;
            const share = Math.max(0, Math.min(1, (ringRadius / 420) - lag));
            map.setPaintProperty(id, 'circle-radius', share * 420);
            map.setPaintProperty(id, 'circle-stroke-opacity',
                                 share > 0 ? held(rings * (1 - index * 0.28)) : 0);
        });
        map.setPaintProperty(CHANGE_GLOW_ID, 'circle-radius',
                             change && change.bulk ? ringRadius * 0.3
                                                   : ringRadius * 0.55);
        map.setPaintProperty(CHANGE_GLOW_ID, 'circle-opacity', held(glow));
        map.setLayoutProperty(CHANGE_MARK_ID, 'icon-size', markSize);
        map.setPaintProperty(CHANGE_MARK_ID, 'icon-opacity', held(markOpacity));
    }

    function endChange() {
        change = null;
        if (changeFrame !== null) {
            cancelAnimationFrame(changeFrame);
            changeFrame = null;
        }
        if (map.getLayer(SCRIM_LAYER_ID)) {
            map.setPaintProperty(SCRIM_LAYER_ID, 'fill-opacity', 0);
            CHANGE_RING_IDS.forEach(function (id) {
                if (map.getLayer(id)) {
                    map.setPaintProperty(id, 'circle-stroke-opacity', 0);
                }
            });
            map.setPaintProperty(CHANGE_GLOW_ID, 'circle-opacity', 0);
            map.setPaintProperty(CHANGE_MARK_ID, 'icon-opacity', 0);
        }
        const scrimSource = map.getSource(SCRIM_SOURCE_ID);
        if (scrimSource) {
            scrimSource.setData({ type: 'FeatureCollection', features: [] });
        }
        const source = map.getSource(CHANGE_SOURCE_ID);
        if (source) source.setData({ type: 'FeatureCollection', features: [] });
        showCaption(null);
    }

    /** Case, accents and punctuation removed, matching the backend's canonical(). */
    function foldName(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    /** The middle of a footprint, however its rings are nested. */
    function footprintCentre(feature) {
        const points = [];
        const collect = function (part) {
            if (typeof part[0] === 'number') {
                points.push(part);
                return;
            }
            part.forEach(collect);
        };
        collect(feature.geometry.coordinates);
        if (!points.length) return null;
        return [points.reduce(function (sum, p) { return sum + p[0]; }, 0) / points.length,
                points.reduce(function (sum, p) { return sum + p[1]; }, 0) / points.length];
    }

    function announceChange(spec) {
        // A change with no place on the map - a tariff, a different day - still
        // dims the table and says what is coming. Only the landing is skipped,
        // because there is nowhere for it to land.
        if (!isActive || !spec) return;
        ensureChangeLayers();

        const removing = spec.action === 'remove';
        const colour = KIND_COLORS[spec.kind] || KIND_COLORS.action || '#e8eef6';
        // A roof array has no marker of its own - the building carries the
        // solar badge - so a PV change borrows it. Asking for 'ecom-pv', which
        // is never registered, drew nothing at all.
        const icon = spec.kind === 'pv' ? 'ecom-building-pv' : 'ecom-' + spec.kind;

        // A building joining is not in the layer the panel last drew, so it
        // arrives with a name and no position. Every footprint is here though,
        // members and non-members alike, so the place is a lookup away.
        //
        // Resolved into a local rather than written back onto the message. A
        // BroadcastChannel hands each listener its own structured clone, so
        // writing to it changes nothing anyone else can see - which makes it a
        // quiet way to look like you are sharing state when you are not.
        // Where the building the panel names is drawn.
        const placeOf = function (name) {
            if (!name || !layerData) return null;
            const want = foldName(name);
            const found = layerData.features.find(function (feature) {
                const ecom = feature.properties.ecom;
                return (ecom && foldName(ecom.name) === want) ||
                       foldName(feature.properties.id) === want;
            });
            return found ? footprintCentre(found) : null;
        };

        let at = spec.at || null;
        if (!at && spec.name && layerData) {
            // Folded before comparing, the way the backend matches a dispatch
            // to a footprint: the panel says "HA" and "Karhus entre", the
            // footprint is keyed "ha" and "karhus". Comparing them as typed
            // finds nothing, which is how a building being added ended up with
            // no landing even once it was being looked for.
            const want = foldName(spec.name);
            const found = layerData.features.find(function (feature) {
                const ecom = feature.properties.ecom;
                return (ecom && foldName(ecom.name) === want) ||
                       foldName(feature.properties.id) === want;
            });
            if (found) at = footprintCentre(found);
        }

        // Tinted towards whatever is arriving, so the darkness itself says
        // which of the community's parts this is about before anything lands.
        // Kept well down towards black: a saturated wash over the whole table
        // would be a colour cast, not a scrim.
        // Every place this change touches. One roof or thirty, the beat is the
        // same shape - the table dims, the places it happens to light up, the
        // marks land - because it is one change either way.
        const places = (spec.targets || [])
            .map(function (target) {
                return target && target.at ? target.at : placeOf(target && target.name);
            })
            .filter(Boolean);
        if (!places.length && at) places.push(at);

        // One place gets the spotlight and a marker landing on it. Many places
        // get neither. Thirty 240 m holes in one polygon overlap, and where
        // holes overlap they fill back in - the table came up patchy with dark
        // blotches rather than lit - and thirty markers popping in large and
        // shrinking was a swarm, not a change. So the table just dims, and the
        // change itself arrives as a wave across it when the layer lands.
        const many = places.length > 1;

        map.setPaintProperty(SCRIM_LAYER_ID, 'fill-color', darkened(colour, 0.22));
        map.getSource(SCRIM_SOURCE_ID).setData(
            scrimWithHoles(many ? [] : places, HOLE_OPEN_M));

        map.getSource(CHANGE_SOURCE_ID).setData({
            type: 'FeatureCollection',
            features: (many ? [] : places).map(function (point) {
                return {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: point },
                    properties: { colour: colour, icon: icon }
                };
            })
        });

        change = {
            spec: spec,
            at: places[0] || at,
            places: places,
            // Rings are drawn from the same source, so thirty places would send
            // thirty expanding rings across the table at once. With the whole
            // campus lighting up there is nothing left to point at anyway.
            bulk: many,
            // Panels on many roofs: the halos sweep in once the layer lands.
            sweepSolar: many && spec.kind === 'pv' && !removing,
            removing: removing,
            startedAt: performance.now(),
            settleLine: null
        };
        showCaption({ title: spec.title || 'Changing the community',
                      line: spec.line || '' });
        // The clock stands still for the beat: one thing moving at a time.
        stopClock();
        stepChange(change.startedAt);
    }

    function stepChange(now) {
        if (!change) return;
        // Never negative. requestAnimationFrame reports the time the frame
        // began, which can be a few milliseconds before the change was started
        // - the first beat then computed a scrim opacity below zero, which
        // MapLibre refuses, and the table's first frame of the change was lost.
        const elapsed = Math.max(0, now - change.startedAt);
        const total = ANNOUNCE_MS + LAND_MS + SETTLE_MS;

        if (elapsed < ANNOUNCE_MS) {
            // Dimming, nothing else. The room is being told where to look.
            const t = elapsed / ANNOUNCE_MS;
            paintChange(SCRIM_DEPTH * t, 0, 0, 0, MARK_SCALE, 0, HOLE_OPEN_M);
        } else if (elapsed < ANNOUNCE_MS + LAND_MS) {
            const t = (elapsed - ANNOUNCE_MS) / LAND_MS;
            const eased = 1 - Math.pow(1 - t, 3);
            // The ring travels out, or inward for a removal.
            const ring = change.removing ? (1 - eased) * 420 : eased * 420;
            const size = change.removing
                ? 1 + (MARK_SCALE - 1) * eased      // grows away
                : MARK_SCALE - (MARK_SCALE - 1) * eased;
            const markOpacity = change.removing ? 1 - eased : 0.25 + 0.75 * eased;
            // Closing onto the change as the marker lands.
            const hole = Math.round(
                HOLE_OPEN_M - (HOLE_OPEN_M - HOLE_CLOSED_M) * eased);
            paintChange(SCRIM_DEPTH, ring, 0.85 * (1 - t * 0.4),
                        0.5 * (1 - t), size, markOpacity, hole);
        } else if (elapsed < total) {
            const t = (elapsed - ANNOUNCE_MS - LAND_MS) / SETTLE_MS;
            // Back up to full, the marker handed over to the real layer - but
            // only once there is a real layer to hand over to. The dispatch
            // takes about two seconds and the beat is one and a half, so on a
            // slow one the marker used to fade out before the thing it stood
            // for existed, and the new charge point appeared to blink.
            paintChange(SCRIM_DEPTH * (1 - t), 0, 0, 0, 1,
                        change.removing ? 0 : (change.landed ? 1 - t : 1),
                        HOLE_CLOSED_M);
            if (change.settleLine && !change.settleShown) {
                change.settleShown = true;
                showCaption({ title: change.spec.title || '',
                              line: change.spec.line || '',
                              figure: change.settleLine });
            }
        } else {
            // Leave the outcome up for a moment before handing the table back.
            //
            // If the dispatch outran the beat, the marker is still standing in
            // for something that does not exist yet. It goes when the layer
            // lands, over a fifth of a second rather than in one frame: a cut
            // here reads as the thing vanishing, which is what it was doing.
            const handover = change.landedAt
                ? Math.min(1, (now - change.landedAt) / 200) : 0;
            paintChange(0, 0, 0, 0, 1, change.removing ? 0 : 1 - handover);
            if (change.holdUntil === undefined) {
                change.holdUntil = now + 2600;
            }
            if (now >= change.holdUntil) {
                endChange();
                startClock();
                return;
            }
        }

        changeFrame = requestAnimationFrame(stepChange);
    }

    // -------------------------------------------------------------- caption

    // A line of text on the table itself.
    //
    // The presenter stands at the controller and the audience stands round the
    // table; without this the table is the only thing being looked at and the
    // only thing that cannot say what it is showing. One line, bottom left,
    // out of the way of the campus.
    let captionBox = null;
    // Held when one arrives before the layer is up. Switching the layer on has
    // to load and parse the export first, and the introduction sends its first
    // caption in the same breath as the request to switch on - so the caption
    // for step one would arrive a moment too early and simply be dropped.
    let heldCaption = null;

    function showCaption(caption) {
        if (!isActive) {
            heldCaption = caption;
            if (captionBox) captionBox.style.opacity = '0';
            return;
        }
        heldCaption = null;
        paintCaption(caption);
    }

    function paintCaption(caption) {
        if (typeof document === 'undefined' || !document.body) return;

        if (!captionBox) {
            captionBox = document.createElement('div');
            captionBox.id = 'ecom-caption';
            // Clear of the KPI bar along the bottom edge (46px) and of the
            // left sidebar (60px): at left 28 / bottom 28 a change's caption
            // was drawn straight over the figures it had just changed.
            captionBox.style.cssText = [
                'position:fixed', 'left:78px', 'bottom:66px', 'z-index:900',
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

        // A step of the introduction shows its progress and nothing else.
        //
        // The words belong to whoever is presenting. On a projection table the
        // room is looking at the campus, and a paragraph in the corner is
        // either unread or read instead of listening - while the presenter is
        // saying the same thing better. What the table still owes the room is
        // where it has got to, which is what the dots are for.
        //
        // A change to the community is not a step, carries no progress row,
        // and keeps its text: nobody is narrating those, and "self-sufficiency
        // 10.77% to 10.76%" is the whole point of showing it.
        const isStep = typeof caption.step === 'number';

        captionBox.style.padding = isStep ? '12px 16px' : '14px 18px';
        captionBox.innerHTML = isStep
            ? '<div>' + dots.join('') + '</div>'
            : ('<div style="font-size:20px;font-weight:600;' +
                   'letter-spacing:0.01em">' +
                   escapeHtml(caption.title || '') + '</div>' +
               (caption.line
                   ? '<div style="font-size:14px;opacity:0.72;margin-top:5px;' +
                     'line-height:1.45">' + escapeHtml(caption.line) + '</div>'
                   : '') +
               (caption.figure
                   ? '<div style="font-size:15px;margin-top:9px;color:' +
                     (KIND_COLORS.action || '#e8eef6') + '">' +
                     escapeHtml(caption.figure) + '</div>'
                   : ''));
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

    // How much of tonight's charge the car has taken, hour by hour.
    //
    // Not the charging rate: a rate is a flow and the flows are already drawn.
    // This is the level in the car, which is what a filling icon means - it
    // climbs while energy is arriving, holds when the charger stops, and drops
    // to nothing when the car drives away.
    //
    // Measured against the stretch the car is plugged in for rather than
    // against its battery capacity, because the export carries what was
    // delivered and not the state of charge the car arrived with. So a full
    // icon means "tonight's charging is done", not "the battery is full".
    let chargeCurves = {};

    function buildChargeCurves() {
        chargeCurves = {};
        if (!nodeData || !flowData) return;

        nodeData.features.forEach(function (feature) {
            const props = feature.properties;
            if (props.kind !== 'charge_point') return;
            const schedule = props.plugged_hourly || [];
            const n = schedule.length;
            if (!n) return;

            // Everything arriving at this charger, whoever sent it.
            const inflow = [];
            for (let h = 0; h < n; h += 1) inflow.push(0);
            flowData.features.forEach(function (flow) {
                if (flow.properties.target !== props.id) return;
                const series = flow.properties.flow_hourly || [];
                for (let h = 0; h < n; h += 1) inflow[h] += series[h] || 0;
            });

            const curve = [];
            for (let h = 0; h < n; h += 1) curve.push(0);

            // The plugged-in stretches, wrapping past midnight: the table loops
            // a single day and the car's night runs through the join.
            const done = [];
            for (let h = 0; h < n; h += 1) done.push(false);
            const always = schedule.every(function (v) { return !!v; });

            for (let i = 0; i < n; i += 1) {
                if (!schedule[i] || done[i]) continue;
                // Only start at the beginning of a stretch, unless the car
                // never leaves, in which case any hour will do.
                if (!always && schedule[(i - 1 + n) % n]) continue;

                const run = [];
                let j = i;
                while (schedule[j] && !done[j] && run.length < n) {
                    done[j] = true;
                    run.push(j);
                    j = (j + 1) % n;
                }
                let total = 0;
                run.forEach(function (h) { total += inflow[h]; });
                let taken = 0;
                run.forEach(function (h) {
                    taken += inflow[h];
                    curve[h] = total > 0 ? taken / total : 0;
                });
            }

            chargeCurves[props.id] = curve;
        });
    }

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
                paint: {
                    // The building itself is the reading now, rather than a pin
                    // standing on it. Hue and opacity both climb with what the
                    // building is drawing this hour: a quiet one is a dark
                    // shape you can still see, a busy one glows.
                    'fill-color': [
                        'interpolate', ['linear'], ['get', 'demandNow'],
                        0, DEMAND_COLD,
                        1, KIND_COLORS.building
                    ],
                    'fill-opacity': [
                        'interpolate', ['linear'], ['get', 'demandNow'],
                        0, 0.16,
                        1, 0.78
                    ]
                }
            });
        }

        // The battery's building. Drawn from the footprint source, on its own
        // filter rather than the members' one: AWL holds the battery but is not
        // a member of the community - it has no measured demand - so without
        // this it is not drawn at all.
        if (!map.getLayer(BATTERY_HOST_FILL_ID)) {
            map.addLayer({
                id: BATTERY_HOST_FILL_ID,
                type: 'fill',
                source: SOURCE_ID,
                filter: BATTERY_HOST_FILTER,
                paint: {
                    'fill-color': KIND_COLORS.battery,
                    // Faint, and not driven by the charge: this only says the
                    // building holds a battery. How much is in it is the level
                    // above, and how much the building is drawing is the pink
                    // fill underneath, which this must not drown.
                    'fill-opacity': 0.12
                }
            });
        }

        // The charge itself, rising from the south edge of the footprint.
        if (!map.getSource(BATTERY_LEVEL_SOURCE_ID)) {
            map.addSource(BATTERY_LEVEL_SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }
        if (!map.getLayer(BATTERY_LEVEL_ID)) {
            map.addLayer({
                id: BATTERY_LEVEL_ID,
                type: 'fill',
                source: BATTERY_LEVEL_SOURCE_ID,
                paint: {
                    'fill-color': KIND_COLORS.battery,
                    'fill-opacity': 0.62
                }
            });
        }

        if (!map.getLayer(BATTERY_HOST_LINE_ID)) {
            map.addLayer({
                id: BATTERY_HOST_LINE_ID,
                type: 'line',
                source: SOURCE_ID,
                filter: BATTERY_HOST_FILTER,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    // Steady, not driven by the charge: the outline says which
                    // building holds the battery and has to say it whether the
                    // battery is full or flat. The level inside says how much.
                    'line-color': KIND_COLORS.battery,
                    // Heavy enough to hold its own beside a solar halo on the
                    // same footprint.
                    'line-width': 3.4,
                    'line-opacity': 0.95,
                    'line-blur': 1.2
                }
            });
        }

        // A thin edge, so a building nobody is using still reads as a building
        // rather than as a smudge on the map.
        if (!map.getLayer(OUTLINE_LAYER_ID)) {
            map.addLayer({
                id: OUTLINE_LAYER_ID,
                type: 'line',
                source: SOURCE_ID,
                filter: FILL_BASE_FILTER,
                paint: {
                    'line-color': KIND_COLORS.building,
                    'line-width': 0.9,
                    'line-opacity': [
                        'interpolate', ['linear'], ['get', 'demandNow'],
                        0, 0.42,
                        1, 0.95
                    ]
                }
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

        if (!map.getSource(FLOW_HEAD_SOURCE_ID)) {
            map.addSource(FLOW_HEAD_SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
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
                    'line-opacity': ['*', 0.16, ['get', 'share'],
                                     ['get', 'revealed']],
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
                    // The battery's lines get a floor. Width and opacity follow
                    // a line's share of the busiest flow on campus, which is the
                    // grid at over a megawatt; the battery moves a few kilowatts,
                    // so its lines came out at a fraction of a percent - there
                    // but invisible, and the only red on the table was gone.
                    // It is one asset the community is built around, and it
                    // has to be seen doing what it does however small that is.
                    'line-width': ['+',
                        ['case', ['==', ['get', 'kind'], 'battery'], 2.2, 0.8],
                        ['*', 6.5, ['get', 'share']]],
                    // Just short of full, so two crossing lines still read as
                    // two rather than as a join.
                    // Only while it is moving something: an idle battery line
                    // stays dark like any other.
                    'line-opacity': ['*', 0.82, ['get', 'revealed'],
                        ['case',
                            ['all', ['==', ['get', 'kind'], 'battery'],
                                    ['>', ['get', 'share'], 0]],
                            ['max', 0.6, ['get', 'share']],
                            ['get', 'share']]]
                }
            });
        }

        // Which way, and therefore to which building.
        //
        // The dash already travels, and it is not enough: a repeating pattern
        // has no beginning, so at a glance it reads as texture on a line rather
        // than as one thing going somewhere. Arrows were tried next and were
        // worse - forty lines of chevrons is a diagram, not a table.
        //
        // This is a single light per line instead. It sets off from whatever is
        // supplying, runs the length of the route, and goes out as it reaches
        // the building. One moving point is followable across a room in a way
        // that a pattern is not, and where it stops is the answer to the
        // question: that building, the one it just arrived at.
        if (!map.getLayer(FLOW_HEAD_GLOW_ID)) {
            map.addLayer({
                id: FLOW_HEAD_GLOW_ID,
                type: 'circle',
                source: FLOW_HEAD_SOURCE_ID,
                paint: {
                    'circle-color': colorByKind,
                    'circle-radius': ['*',
                        ['+', 9, ['*', 16, ['get', 'share']]],
                        ['+', 1, ['*', 1.1, ['get', 'land']]]],
                    'circle-opacity': ['*', 0.45, ['get', 'alpha']],
                    'circle-blur': 1
                }
            });
        }

        if (!map.getLayer(FLOW_HEAD_ID)) {
            map.addLayer({
                id: FLOW_HEAD_ID,
                type: 'circle',
                source: FLOW_HEAD_SOURCE_ID,
                paint: {
                    // Pushed towards white: the brightest thing a projector can
                    // make, so the head reads as the light and the line it runs
                    // along as the wire.
                    // Except the battery's. Red pushed that far towards white is
                    // salmon, and a salmon light leaving AWL read as one more
                    // pink building line - the battery's energy looked pink.
                    'circle-color': ['match', ['get', 'kind'],
                        'grid', lighten(KIND_COLORS.grid, 0.55),
                        'battery', lighten(KIND_COLORS.battery, 0.12),
                        'pv', lighten(KIND_COLORS.pv, 0.55),
                        lighten(KIND_COLORS.building, 0.55)],
                    'circle-radius': ['*',
                        ['+', 2.4, ['*', 4.4, ['get', 'share']]],
                        ['+', 1, ['*', 0.5, ['get', 'land']]]],
                    'circle-opacity': ['get', 'alpha'],
                    'circle-blur': 0.25
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
        // The assets have one look, gauge or not: this plain version is what
        // the change animation lands, and it hands over to the gauge in place.
        if (ASSET_DRAW[kind]) return makeFillIcon(kind, 1);

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

    // The three that read as a level rather than a state.
    //
    // Each fills for a different reason, and the reason is the honest part:
    //
    //   battery       its state of charge, integrated from what goes in and out
    //   grid          how hard the campus is drawing on it, against its own
    //                 busiest hour - a gauge, not a store
    //   charge point  how much of tonight's charge has been delivered to the
    //                 car, emptying when the car drives away
    //
    // Same vessel for all three so the eye reads them together, and each keeps
    // its own colour and glyph so they are still telling different stories.
    const FILLED_KINDS = ['battery', 'grid', 'charge_point'];

    // ---- The community's assets, drawn for a projector --------------------
    //
    // A projector has one ink, and it is light. The markers these replace were
    // dark rounded squares with a coloured hairline: on the table the square
    // was simply absent - black is what a projector shows by not shining - and
    // what was left was a 1.8px outline and a thin glyph on a 21px marker,
    // about twelve metres of campus. So every part of these emits:
    //
    //   * each has its own silhouette - pylon, cell, bolt-in-a-ring - because
    //     projected colour washes out and shape is what survives it;
    //   * the empty part of a gauge is dim, never dark, so an idle asset still
    //     reads as the thing it is;
    //   * strokes are thick and pushed toward white, the brightest thing a
    //     projector can make, keeping just enough hue to say which kind;
    //   * each carries its own glow, baked in;
    //   * a thin dark keyline under the light, which costs nothing on black
    //     and keeps them legible on the light basemaps.
    //
    // And roughly twice the size. Each still fills, the way each always has,
    // but in the shape of what it is: the pylon lights from the ground up with
    // how hard the campus is drawing on it, the battery fills cell by cell,
    // the charge point's ring sweeps round as the car charges.
    const ASSET_BOX = 56;          // CSS px, glow included

    function lighten(hex, amount) {
        const h = hex.replace('#', '');
        const mix = [0, 2, 4].map(function (i) {
            const v = parseInt(h.slice(i, i + 2), 16);
            return Math.round(v + (255 - v) * amount);
        });
        return 'rgb(' + mix.join(',') + ')';
    }

    function fade(hex, alpha) {
        const h = hex.replace('#', '');
        return 'rgba(' + [0, 2, 4].map(function (i) {
            return parseInt(h.slice(i, i + 2), 16);
        }).join(',') + ',' + alpha + ')';
    }

    // Path2D.roundRect is recent; arcTo has been everywhere for a decade.
    function roundedRect(x, y, w, h, r) {
        const p = new Path2D();
        p.moveTo(x + r, y);
        p.arcTo(x + w, y, x + w, y + h, r);
        p.arcTo(x + w, y + h, x, y + h, r);
        p.arcTo(x, y + h, x, y, r);
        p.arcTo(x, y, x + w, y, r);
        p.closePath();
        return p;
    }

    // Stroke a path three times: a dark keyline, a glow, then the light.
    function luminousStroke(ctx, path, colour, width) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = width + 2.2;
        ctx.stroke(path);
        ctx.shadowColor = colour;
        ctx.shadowBlur = 7 * ICON_SCALE;
        ctx.strokeStyle = lighten(colour, 0.35);
        ctx.lineWidth = width;
        ctx.stroke(path);
        ctx.restore();
    }

    // Fill a region dim, then light the bottom `level` of it.
    function gauge(ctx, region, colour, level, top, bottom) {
        ctx.save();
        ctx.clip(region);
        ctx.fillStyle = fade(colour, 0.2);
        ctx.fillRect(0, 0, ASSET_BOX, ASSET_BOX);
        if (level > 0) {
            const y = bottom - (bottom - top) * level;
            ctx.shadowColor = colour;
            ctx.shadowBlur = 5 * ICON_SCALE;
            ctx.fillStyle = fade(colour, 0.92);
            ctx.fillRect(0, y, ASSET_BOX, bottom - y + 1);
        }
        ctx.restore();
    }

    const ASSET_DRAW = {
        // A lattice pylon: the one shape everybody reads as "the grid".
        //
        // Here the whole tower is the gauge, not a fill behind it. Filling
        // the silhouette was tried first and could not be read: a lattice is
        // mostly strokes, and bright strokes over a fill looked the same at
        // nothing as at full. So the pylon stands as a dim ghost, and the
        // lattice itself lights up from the ground as the campus draws harder.
        grid: function (ctx, colour, level) {
            const tower = new Path2D(
                'M17 48 L24.5 13 L28 8 L31.5 13 L39 48 Z' +
                'M13 17 H43 V20.5 H13 Z M16 26 H40 V29.5 H16 Z');
            const frame = new Path2D(
                // legs and peak
                'M17 48 L24.5 13 L28 8 L31.5 13 L39 48' +
                // cross-arms, with insulators hanging off the tips
                'M13 18.5 H43 M16 27.5 H40' +
                'M13.5 18.5 V22.5 M42.5 18.5 V22.5 M16.5 27.5 V31 M39.5 27.5 V31');
            const bracing = new Path2D(
                'M24.5 13 L31.5 18.5 M31.5 13 L24.5 18.5' +
                'M23.3 18.5 L32.6 27.5 M32.7 18.5 L23.3 27.5' +
                'M21.4 27.5 L35.4 38 M34.6 27.5 L20.6 38' +
                'M20.6 38 L39 48 M35.4 38 L17 48');

            // The ghost: there even when nothing is flowing.
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.fillStyle = fade(colour, 0.1);
            ctx.fill(tower);
            [[frame, 2.6], [bracing, 1.4]].forEach(function (part) {
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = part[1] + 2.2;
                ctx.stroke(part[0]);
                ctx.strokeStyle = fade(colour, 0.4);
                ctx.lineWidth = part[1];
                ctx.stroke(part[0]);
            });
            ctx.restore();

            // The lit part, from the ground up. The range runs a little past
            // the peak and the feet so that full is the whole tower, strokes
            // and all.
            if (level > 0) {
                const top = 5, bottom = 51;
                const edge = bottom - (bottom - top) * level;
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, edge, ASSET_BOX, ASSET_BOX - edge);
                ctx.clip();
                gauge(ctx, tower, colour, 1, top, bottom);
                luminousStroke(ctx, frame, colour, 2.6);
                luminousStroke(ctx, bracing, colour, 1.4);
                ctx.restore();
            }
        },

        // An upright cell with its terminal: four segments that light from
        // the bottom, the gauge every phone has taught everybody to read.
        battery: function (ctx, colour, level) {
            const segments = 4;
            const gap = 2;
            const inner = { x: 21.5, y: 16.5, w: 13, h: 29 };
            const segH = (inner.h - gap * (segments - 1)) / segments;
            for (let i = 0; i < segments; i += 1) {
                const bottom = inner.y + inner.h - i * (segH + gap);
                const cell = new Path2D();
                cell.rect(inner.x, bottom - segH, inner.w, segH);
                const share = Math.max(0, Math.min(1, level * segments - i));
                gauge(ctx, cell, colour, share, bottom - segH, bottom);
            }
            luminousStroke(ctx, roundedRect(18, 13, 20, 36, 4), colour, 3);
            luminousStroke(ctx, roundedRect(24, 8, 8, 5, 1.5), colour, 2.4);
        },

        // A bolt inside a ring. The bolt is always lit - it is what the thing
        // is - and the ring is how far tonight's charge has got: sweeping
        // round clockwise from the top, and empty again once the car has gone.
        charge_point: function (ctx, colour, level) {
            const cx = 28, cy = 28, r = 19;
            ctx.save();
            ctx.lineCap = 'round';
            ctx.strokeStyle = 'rgba(0,0,0,0.55)';
            ctx.lineWidth = 5.6;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = fade(colour, 0.24);
            ctx.lineWidth = 3.4;
            ctx.stroke();
            if (level > 0) {
                ctx.shadowColor = colour;
                ctx.shadowBlur = 7 * ICON_SCALE;
                ctx.strokeStyle = lighten(colour, 0.35);
                ctx.beginPath();
                ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * level);
                ctx.stroke();
            }
            ctx.restore();

            const bolt = new Path2D('M30.5 11 L19 30 H27.5 L25.5 45 L37 26 H28.5 Z');
            ctx.save();
            ctx.lineJoin = 'round';
            ctx.strokeStyle = 'rgba(0,0,0,0.55)';
            ctx.lineWidth = 2.4;
            ctx.stroke(bolt);
            ctx.shadowColor = colour;
            ctx.shadowBlur = 8 * ICON_SCALE;
            ctx.fillStyle = lighten(colour, 0.45);
            ctx.fill(bolt);
            ctx.restore();
        }
    };

    function makeFillIcon(kind, level) {
        const size = ASSET_BOX * ICON_SCALE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.scale(ICON_SCALE, ICON_SCALE);
        ASSET_DRAW[kind](ctx, KIND_COLORS[kind], level);
        return ctx.getImageData(0, 0, size, size);
    }

    function registerIcons() {
        FILLED_KINDS.forEach(function (kind) {
            for (let step = 0; step <= FILL_STEPS; step += 1) {
                const name = 'ecom-' + kind + '-fill-' + step;
                if (!map.hasImage(name)) {
                    map.addImage(name, makeFillIcon(kind, step / FILL_STEPS),
                                 { pixelRatio: ICON_SCALE });
                }
            }
        });

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
    // From the edge of the dark stage outward: starting inside it, a ring was
    // hidden behind the marker for the first third of its run.
    const RING_MIN = 26;
    const RING_MAX = 70;

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
                        // Always wider than the stage below, so there is a rim
                        // of glow round it even when the asset is idle. Off
                        // entirely for an asset standing in a building: a 75 m
                        // glow over a 74 m roof is not a marker, it is a wash.
                        'circle-radius': ['case',
                            ['==', ['get', 'hostedBattery'], 1], 0,
                            ['+', 34, ['*', 30, level]]],
                        'circle-opacity': ['case',
                            ['==', ['get', 'hostedBattery'], 1], 0,
                            ['+', 0.22, ['*', 0.42, level]]],
                        'circle-blur': 1
                    }
                });
            }

            // A dark stage for the marker to stand on.
            //
            // This was a lit disc in the asset's colour - bright under a bright
            // icon, which on a projector is one blob. Dark reads as contrast
            // on the table: glow, then a ring of black, then the marker lit
            // inside it. On the black basemap it is simply a hole in the halo.
            if (!map.getLayer(pulse.coreId)) {
                map.addLayer({
                    id: pulse.coreId,
                    type: 'circle',
                    source: NODES_SOURCE_ID,
                    filter: pulse.filter,
                    paint: {
                        'circle-color': '#000000',
                        // No stage for a battery in a building: a black disc
                        // on the roof is a hole in the building it belongs to.
                        'circle-radius': ['case',
                            ['==', ['get', 'hostedBattery'], 1], 0, 25],
                        'circle-opacity': ['case',
                            ['==', ['get', 'hostedBattery'], 1], 0, 0.82],
                        'circle-blur': 0.25
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
            // A halo of the building's own outline rather than a blob at its
            // centre. The roof is what is generating, so the shape of the roof
            // is what should light up - and a circle sitting on the demand fill
            // was two marks competing for the same building.
            map.addLayer({
                id: SOLAR_LAYER_ID,
                type: 'line',
                source: SOURCE_ID,
                filter: SOLAR_BASE_FILTER,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': KIND_COLORS.pv,
                    // Blurred and wide: a glow around the footprint, not a
                    // second outline competing with the pink one.
                    'line-blur': 3,
                    'line-width': ['+', 1.5, ['*', 9, ['get', 'solarNow']]],
                    'line-opacity': ['*', 0.85, ['get', 'solarNow']]
                }
            });
        }

        // The battery's outline goes over the solar halo, not under it.
        //
        // AWL has panels as well as the battery, and the halo is wide and
        // blurred where the battery's edge is a line. Drawn in the order the
        // layers were added, the yellow buried the red - worst on the
        // introduction's battery step, where every roof is held lit and the
        // one building that step is about looked like any other solar roof.
        if (map.getLayer(BATTERY_HOST_LINE_ID)) {
            map.moveLayer(BATTERY_HOST_LINE_ID);
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
                        // These pick the image for their current level.
                        ['in', ['get', 'kind'], ['literal', FILLED_KINDS]],
                        ['concat', 'ecom-', ['get', 'kind'], '-fill-',
                            ['to-string', ['get', 'fillStep']]],
                        ['concat', 'ecom-', ['get', 'kind']]
                    ],
                    // Community assets read a step larger - they serve every
                    // member, and the grid connection vanishing into the
                    // building markers is the wrong emphasis.
                    // The assets are drawn at their own size (ASSET_BOX) -
                    // a battery standing in a building included. It was shrunk
                    // to a badge once the building became the gauge, but what
                    // covered the roof was never the icon: it was the dark disc
                    // and the 75 m glow under it, and those stay off for a
                    // hosted battery. At a badge's size the introduction's
                    // battery step had nothing on the table to point at.
                    'icon-size': [
                        'case',
                        ['==', ['get', 'kind'], 'building'], 0.62,
                        1
                    ],
                    // Zero for everything but a battery built into a building,
                    // which lies along it. Screen-relative, because the turn is
                    // already worked out against the map's own rotation.
                    'icon-rotate': ['coalesce', ['get', 'iconRotate'], 0],
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true,
                    // The label is part of the same symbol so it can never be
                    // placed away from the icon it belongs to.
                    // Assets are named; buildings are not. Thirty-two labels
                    // over thirty-two coloured footprints is a page of text
                    // where the point is the shapes - and the footprints say
                    // which building they are by being that building.
                    'text-field': [
                        'case', ['==', ['get', 'kind'], 'building'], '',
                        ['get', 'name']
                    ],
                    'text-font': ['Open Sans Regular'],
                    // Under the asset's body, clear of its glow: the markers
                    // are twice what they were and the old offset put the name
                    // across the bottom of the icon.
                    'text-size': 11,
                    'text-offset': [0, 2.3],
                    'text-anchor': 'top',
                    'text-optional': true,
                    'text-padding': 3
                },
                paint: {
                    // Buildings are drawn as coloured footprints now, so a pin
                    // would be a second marker for the same thing standing on
                    // top of it. The symbol stays - it carries the label, and a
                    // label detached from its building is worse than a pin -
                    // but for a building its icon is not painted.
                    'icon-opacity': [
                        'case', ['==', ['get', 'kind'], 'building'], 0, 1
                    ],
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
            FILL_LAYER_ID, OUTLINE_LAYER_ID, SOLAR_LAYER_ID,
            BATTERY_HOST_FILL_ID, BATTERY_LEVEL_ID, BATTERY_HOST_LINE_ID,
            FLOW_GLOW_ID, FLOW_LAYER_ID, FLOW_HEAD_GLOW_ID, FLOW_HEAD_ID,
            NODE_LAYER_ID
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

    // ---- the travelling lights ------------------------------------------
    //
    // Each route measured once, so stepping a light along it is a lookup and an
    // interpolation rather than a walk of every vertex on every tick. The
    // routes only change when a new layer lands, which is where this is rebuilt.
    let headPaths = [];

    function measureFlows() {
        headPaths = [];
        if (!flowData || !flowData.features) return;
        flowData.features.forEach(function (feature, index) {
            const coords = (feature.geometry && feature.geometry.coordinates) || [];
            if (coords.length < 2) return;
            const steps = [0];
            let total = 0;
            for (let i = 1; i < coords.length; i += 1) {
                // Flat enough over a campus; this is for pacing a dot, not
                // for navigation.
                const dx = (coords[i][0] - coords[i - 1][0]) * 0.5351;
                const dy = coords[i][1] - coords[i - 1][1];
                total += Math.sqrt(dx * dx + dy * dy);
                steps.push(total);
            }
            headPaths.push({
                coords: coords,
                steps: steps,
                total: total,
                // Spread along the cycle so they do not all set off together,
                // which would read as one pulse of the whole campus.
                offset: (index * 0.37) % 1,
                properties: feature.properties
            });
        });
    }

    /** Where along the route a fraction lands. */
    function pointAt(path, fraction) {
        const want = path.total * fraction;
        let i = 1;
        while (i < path.steps.length - 1 && path.steps[i] < want) i += 1;
        const span = path.steps[i] - path.steps[i - 1];
        const share = span > 0 ? (want - path.steps[i - 1]) / span : 0;
        const a = path.coords[i - 1];
        const b = path.coords[i];
        return [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share];
    }

    // One run from end to end. Slow enough to follow across a table, which is
    // the whole point of it: a light nobody can track says no more than a dash.
    const HEAD_PERIOD_MS = 4200;

    function paintHeads() {
        const source = map.getSource(FLOW_HEAD_SOURCE_ID);
        if (!source) return;
        if (flowStill || !headPaths.length) {
            source.setData({ type: 'FeatureCollection', features: [] });
            return;
        }

        const now = performance.now() / HEAD_PERIOD_MS;
        const features = [];
        headPaths.forEach(function (path) {
            const props = path.properties || {};
            const share = props.share || 0;
            const revealed = props.revealed === undefined ? 1 : props.revealed;
            // Nothing moving means no light: an idle line is still a wire.
            if (share <= 0.001 || revealed <= 0.01) return;
            const phase = (now + path.offset) % 1;
            // Full brightness for the run, not a bell curve: sin() put the
            // light at its dimmest exactly where it arrives, which is the one
            // place it has something to say. It fades up quickly as it leaves,
            // holds, and flares out over the last tenth - at the building.
            const arriving = phase > 0.9 ? (phase - 0.9) / 0.1 : 0;
            const alpha = Math.min(1, phase / 0.06) * (1 - arriving) * revealed;
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: pointAt(path, phase) },
                properties: Object.assign({}, props, {
                    alpha: alpha,
                    // Spreading as it is spent, so the last thing the eye sees
                    // is a small burst on the building it was going to.
                    land: arriving
                })
            });
        });
        source.setData({ type: 'FeatureCollection', features: features });
    }

    function startPulse() {
        if (pulseTimer !== null) return;
        pulseTimer = setInterval(function () {
            if (!map.getLayer(FLOW_LAYER_ID)) return;
            // Held still while the introduction is drawing them: a travelling
            // dash on a line that has only just been drawn says the energy is
            // already moving, and the whole point of the step is that it is not
            // moving yet.
            if (!flowStill) {
                pulseStep = (pulseStep + 1) % DASH_SEQUENCE.length;
                map.setPaintProperty(FLOW_LAYER_ID, 'line-dasharray',
                                     DASH_SEQUENCE[pulseStep]);
            }
            ringStep = (ringStep + 1) % RING_STEPS;
            paintRings();
            paintHeads();
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
            // Which of the eleven images to show. Rounded rather than
            // floored so a nearly full one does not read as 90%.
            if (feature.properties.kind === 'battery') {
                feature.properties.storedNow = stored;
                feature.properties.fillStep = Math.round(stored * FILL_STEPS);
            } else if (feature.properties.kind === 'grid') {
                // A gauge: how hard the campus is leaning on it this hour,
                // against its own busiest hour. The same number the halo
                // pulses by, so the two cannot disagree.
                feature.properties.fillStep =
                    Math.round((level.gridNow || 0) * FILL_STEPS);
            } else if (feature.properties.kind === 'charge_point') {
                const curve = chargeCurves[feature.properties.id];
                feature.properties.fillStep =
                    Math.round(((curve && curve[hour]) || 0) * FILL_STEPS);
            }

            PULSES.forEach(function (pulse) {
                feature.properties[pulse.field] =
                    feature.properties.kind === pulse.kind
                        ? (level[pulse.field] || 0) : 0;
            });
        });

        source.setData(nodeData);
        setFootprintHour(hour, stored);
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

    /**
     * How hard each building is working this hour, 0 to 1.
     *
     * Square rooted, like the flow widths: the campus runs from 14 kW to
     * 1,286 kW in a single hour, and on a linear scale everything but the
     * three biggest buildings would sit at the dark end all day.
     */
    /**
     * How far to turn an upright marker so it lies along a building, in degrees
     * clockwise on the screen.
     *
     * The long axis is the longest wall of the building's largest part - a
     * rectangle-ish block has one direction worth following and its longest
     * side is it. That direction is a compass bearing on the ground; the table's
     * map is itself turned (about -93 degrees), so the turn on screen is the
     * wall's bearing less the map's. Kept within a quarter turn either way, so
     * the battery's terminal points up the table rather than down it.
     */
    function alongBuilding(feature) {
        const geometry = feature.geometry || {};
        const parts = geometry.type === 'Polygon' ? [geometry.coordinates]
            : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        const toMetres = function (point, lat) {
            return [point[0] * 111320 * Math.cos(lat * Math.PI / 180),
                    point[1] * 110540];
        };
        const area = function (ring) {
            let sum = 0;
            for (let i = 0; i < ring.length - 1; i += 1) {
                sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
            }
            return Math.abs(sum);
        };
        let biggest = null;
        parts.forEach(function (part) {
            if (part && part[0] && (!biggest || area(part[0]) > area(biggest))) {
                biggest = part[0];
            }
        });
        if (!biggest || biggest.length < 3) return 0;

        const lat = biggest[0][1];
        let longest = 0;
        let bearing = 0;
        for (let i = 0; i < biggest.length - 1; i += 1) {
            const a = toMetres(biggest[i], lat);
            const b = toMetres(biggest[i + 1], lat);
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length > longest) {
                longest = length;
                bearing = Math.atan2(dx, dy) * 180 / Math.PI;
            }
        }

        const mapBearing = typeof map.getBearing === 'function' ? map.getBearing() : 0;
        let turn = bearing - mapBearing;
        turn = ((turn % 180) + 180) % 180;       // a wall has no direction: 0..180
        if (turn > 90) turn -= 180;              // and upright wins a tie: -90..90
        return turn;
    }

    /**
     * The part of a ring on the low side of a line.
     *
     * Sutherland-Hodgman against one edge: walk the ring, keep the points
     * under the line, and where a side crosses it put a point on the crossing.
     * Enough for a building - they are small and close to convex - and it
     * keeps courtyards as courtyards, because every ring is clipped alike.
     *
     * The line is given as a measure rather than a latitude, because the table
     * is rotated: its map runs at a bearing of about -93 degrees, so a level
     * rising with latitude rises sideways across the table. A vessel has to
     * fill towards the top of the table, whatever the map is doing.
     */
    function ringUnder(ring, measure, limit) {
        const out = [];
        for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            const fa = measure(a);
            const fb = measure(b);
            if (fa <= limit) out.push(a);
            if ((fa <= limit) !== (fb <= limit)) {
                const t = (limit - fa) / (fb - fa);
                out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        }
        if (out.length < 3) return null;
        out.push(out[0].slice());
        return out;
    }

    /** The charge drawn as a level inside the building that holds it. */
    function paintBatteryLevel(stored) {
        const source = map.getSource(BATTERY_LEVEL_SOURCE_ID);
        if (!source || !layerData) return;

        // Which way is up, on the table rather than on the globe. A map at
        // bearing b shows that compass direction at the top of the screen, so
        // "up" on the ground is (sin b, cos b) - and the level is measured
        // along it.
        const bearing = (typeof map.getBearing === 'function' ? map.getBearing() : 0)
            * Math.PI / 180;
        const ux = Math.sin(bearing);
        const uy = Math.cos(bearing);
        const metres = 111320 * Math.cos(57.689 * Math.PI / 180);
        const measure = function (point) {
            return point[0] * metres * ux + point[1] * 110540 * uy;
        };

        const features = [];
        layerData.features.forEach(function (feature) {
            if (feature.properties.batteryHost !== 1) return;
            const level = Math.max(0, Math.min(1, stored || 0));
            if (level <= 0.001) return;

            const geometry = feature.geometry;
            const parts = geometry.type === 'Polygon'
                ? [geometry.coordinates]
                : (geometry.type === 'MultiPolygon' ? geometry.coordinates : []);
            let low = Infinity;
            let high = -Infinity;
            parts.forEach(function (part) {
                part[0].forEach(function (point) {
                    const value = measure(point);
                    if (value < low) low = value;
                    if (value > high) high = value;
                });
            });
            if (!isFinite(low) || high <= low) return;
            const limit = low + (high - low) * level;

            const clipped = [];
            parts.forEach(function (part) {
                const rings = [];
                part.forEach(function (ring) {
                    const cut = ringUnder(ring, measure, limit);
                    if (cut) rings.push(cut);
                });
                // A hole whose outer ring was cut away has nothing to be a
                // hole of, so the part goes only if its outer ring survived.
                if (rings.length) clipped.push(rings);
            });
            if (!clipped.length) return;

            features.push({
                type: 'Feature',
                properties: { id: feature.properties.id, storedNow: level },
                geometry: { type: 'MultiPolygon', coordinates: clipped }
            });
        });
        source.setData({ type: 'FeatureCollection', features: features });
    }

    // The charge the table last showed. The reveal animations repaint the
    // footprints every frame without an hour change to recompute it from, and
    // passing nothing drained the battery's building to empty mid-animation.
    let lastStored = 0;

    function setFootprintHour(hour, stored) {
        if (!layerData) return;
        if (stored === undefined) stored = lastStored;
        lastStored = stored || 0;
        const source = map.getSource(SOURCE_ID);
        if (!source) return;

        layerData.features.forEach(function (feature) {
            const ecom = feature.properties.ecom;

            if (uniform) {
                // Every member alike, at whatever the reveal has reached.
                feature.properties.demandNow = ecom ? uniformBuildings : 0;
                feature.properties.solarNow =
                    feature.properties.has_pv ? uniformSolar : 0;
                return;
            }

            const series = (ecom && ecom.demand_hourly) || [];
            const now = series[hour] || 0;
            const shade = demandCeiling > 0
                ? Math.sqrt(now / demandCeiling) : 0;
            // A member is always visibly a member; a non-member stays dark.
            const demand = ecom
                ? MEMBER_FLOOR + (1 - MEMBER_FLOOR) * shade
                : 0;

            const sun = ((ecom && ecom.solar_hourly) || [])[hour] || 0;
            const glow = solarCeiling > 0
                ? Math.sqrt(sun / solarCeiling) : 0;
            // The wave: a roof lights once the sweep has passed its place on
            // the table, left to right, and is fully lit once it has gone by.
            // Only the roofs that just got panels - one that already had them
            // did not change, and going dark to come back with the rest said
            // it had.
            const across = feature.properties.sweepAt || 0;
            const reached = feature.properties.sweeping === 1
                ? Math.max(0, Math.min(1, solarSweep * 1.6 - across * 0.6))
                : 1;
            const solar = sun > 0
                ? (SOLAR_FLOOR + (1 - SOLAR_FLOOR) * glow) * reached
                : 0;

            if (handover > 0) {
                // Part way out of the introduction: the flat pink every member
                // shared, dissolving into what each one is actually drawing.
                const flat = ecom ? 1 : 0;
                const flatSun = feature.properties.has_pv ? 1 : 0;
                feature.properties.demandNow =
                    demand + (flat - demand) * handover;
                feature.properties.solarNow =
                    solar + (flatSun - solar) * handover;
                return;
            }

            feature.properties.demandNow = demand;
            feature.properties.solarNow = solar;
            // The battery's building fills and empties with it.
            if (feature.properties.batteryHost === 1) {
                feature.properties.storedNow = stored || 0;
            }
        });
        source.setData(layerData);
        paintBatteryLevel(stored);
    }

    // ------------------------------------------------------- uniform reveal
    //
    // During the introduction a building is a member of the community, not a
    // meter reading. Shading them by demand at that point answers a question
    // nobody has asked yet - and it answers it badly, because one hall dwarfs
    // the rest and thirty-one others come up almost black, which reads as "most
    // of these are not really in it".
    //
    // So for the entity steps every member is drawn alike, and comes up rather
    // than appearing: the footprints fade in together to a flat pink, and the
    // roofs light afterwards the same way. The demand shading returns at the
    // last step, where the day starts running and the number means something.
    let uniform = false;
    let uniformBuildings = 0;
    let uniformSolar = 0;
    // How much of the uniform picture is still showing while the introduction
    // hands the footprints back to their readings. One is the flat pink every
    // member shares, zero is each building shaded by what it is drawing.
    let handover = 0;
    let revealFrame = null;
    let reveals = [];

    const REVEAL_MS = 1400;
    const HANDOVER_MS = 1600;

    // The roofs get longer and a gentler curve than the footprints.
    //
    // Both were on the same ease-out, which is front-loaded: a quarter of the
    // way up in the first eighth of a second. The footprints get away with it
    // because they start as visible dark shapes and the reveal is a shift in
    // colour - the halo starts from nothing at all, so the same curve reads as
    // the yellow simply appearing and then settling. Eased in as well as out,
    // it grows from nothing the way the eye expects light to.
    const SOLAR_REVEAL_MS = 2000;

    // Panels arriving on many roofs at once: the halos come in as a wave across
    // the table rather than all in one frame. One is fully arrived.
    let solarSweep = 1;
    const SWEEP_MS = 2400;

    function levelOf(target) {
        if (target === 'solar') return uniformSolar;
        if (target === 'handover') return handover;
        if (target === 'sweep') return solarSweep;
        return uniformBuildings;
    }

    function setLevel(target, value) {
        if (target === 'solar') uniformSolar = value;
        else if (target === 'handover') handover = value;
        else if (target === 'sweep') solarSweep = value;
        else uniformBuildings = value;
    }

    function startRamp(target, to, duration, ease) {
        // A second request for the same thing - stepping back and forward -
        // picks up from where it is rather than flashing to nothing first.
        reveals = reveals.filter(function (r) { return r.target !== target; });
        reveals.push({
            target: target,
            from: levelOf(target),
            to: to,
            duration: duration,
            ease: ease || 'out',
            startedAt: performance.now()
        });
        if (revealFrame === null) {
            revealFrame = requestAnimationFrame(stepReveal);
        }
    }

    function startReveal(target) {
        startRamp(target, 1, target === 'solar' ? SOLAR_REVEAL_MS : REVEAL_MS,
                  target === 'solar' ? 'inOut' : 'out');
    }

    function stepReveal(now) {
        revealFrame = null;
        let running = false;

        reveals.forEach(function (reveal) {
            const t = Math.min(1, (now - reveal.startedAt) / reveal.duration);
            // Eased, so they arrive rather than ramp.
            const eased = reveal.ease === 'inOut'
                ? (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
                : 1 - Math.pow(1 - t, 3);
            setLevel(reveal.target,
                     reveal.from + (reveal.to - reveal.from) * eased);
            if (t < 1) running = true;
        });
        reveals = reveals.filter(function (reveal) {
            return now - reveal.startedAt < reveal.duration;
        });

        setFootprintHour(currentHour);
        if (running) revealFrame = requestAnimationFrame(stepReveal);
    }

    function setUniform(on, reveal) {
        const was = uniform;
        uniform = !!on;
        if (!uniform) {
            if (was) {
                // The last step of the introduction is where the day starts
                // running and the footprints stop being members and start
                // being readings. Cutting between the two pictures made the
                // whole campus change colour in one frame; this dissolves it,
                // so the buildings that are working hardest come forward out
                // of the flat pink rather than replacing it.
                handover = 1;
                startRamp('handover', 0, HANDOVER_MS);
            } else {
                reveals = [];
                handover = 0;
            }
            uniformBuildings = 0;
            uniformSolar = 0;
            setFootprintHour(currentHour);
            return;
        }
        if (!was) {
            // Entering the introduction with nothing shown yet.
            uniformBuildings = 0;
            uniformSolar = 0;
            handover = 1;
            reveals = reveals.filter(function (r) { return r.target !== 'handover'; });
        }
        if (reveal) startReveal(reveal);
        setFootprintHour(currentHour);
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

    // ------------------------------------------------------- drawing the lines
    //
    // The last step of the introduction draws the connections one at a time and
    // holds them still, and pressing Finish sets them going. Everything arriving
    // at once is the moment the picture stops being followable: forty-one lines
    // appearing together is a web, whereas one after another is a community
    // being wired up.
    //
    // The order is the story rather than the data's own: what the grid supplies
    // first, then what the battery covers, then the roofs, and peer-to-peer
    // sharing last - which is the point the whole introduction has been walking
    // towards.
    const KIND_ORDER = { grid: 0, battery: 1, pv: 2, building: 3 };
    const FLOW_REVEAL_MS = 2600;
    const FLOW_STILL_DASH = [2, 2];

    let flowStill = false;
    let flowRevealFrame = null;
    let flowRevealStartedAt = 0;

    function flowOrder() {
        return flowData.features
            .map(function (feature, index) { return { feature: feature, index: index }; })
            .sort(function (a, b) {
                const kindA = KIND_ORDER[a.feature.properties.kind];
                const kindB = KIND_ORDER[b.feature.properties.kind];
                if (kindA !== kindB) return (kindA || 9) - (kindB || 9);
                // Biggest first within a kind, so the line that matters most
                // is the one drawn while the room is still watching closely.
                return (b.feature.properties.peak || 0) -
                       (a.feature.properties.peak || 0);
            });
    }

    function setFlowMode(mode) {
        if (!flowData) return;
        const source = map.getSource(FLOWS_SOURCE_ID);
        if (!source) return;

        if (mode !== 'still') {
            flowStill = false;
            if (flowRevealFrame !== null) {
                cancelAnimationFrame(flowRevealFrame);
                flowRevealFrame = null;
            }
            flowData.features.forEach(function (feature) {
                feature.properties.revealed = 1;
            });
            source.setData(flowData);
            startPulse();
            return;
        }

        // Still: the dashes stop travelling and every line starts undrawn.
        flowStill = true;
        if (map.getLayer(FLOW_LAYER_ID)) {
            map.setPaintProperty(FLOW_LAYER_ID, 'line-dasharray', FLOW_STILL_DASH);
        }
        flowData.features.forEach(function (feature) {
            feature.properties.revealed = 0;
        });
        source.setData(flowData);

        flowRevealStartedAt = performance.now();
        if (flowRevealFrame === null) {
            flowRevealFrame = requestAnimationFrame(stepFlowReveal);
        }
    }

    function stepFlowReveal(now) {
        flowRevealFrame = null;
        if (!flowStill || !flowData) return;
        const source = map.getSource(FLOWS_SOURCE_ID);
        if (!source) return;

        const order = flowOrder();
        const each = FLOW_REVEAL_MS / Math.max(1, order.length);
        const elapsed = now - flowRevealStartedAt;
        let running = false;

        order.forEach(function (entry, position) {
            // Each line takes a little longer than its slot, so two are always
            // arriving at once and the sequence reads as a wave rather than a
            // metronome.
            const t = Math.max(0, Math.min(1, (elapsed - position * each) / (each * 2.5)));
            entry.feature.properties.revealed = t * t * (3 - 2 * t);
            if (t < 1) running = true;
        });
        source.setData(flowData);

        if (running) flowRevealFrame = requestAnimationFrame(stepFlowReveal);
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
    // The community's headline figures, for the KPI bars. A live dispatch sends
    // them alongside the layer; the committed export keeps them in its meta.
    let layerKpis = null;

    function announceKpis() {
        const kpis = layerKpis ||
            (layerData && layerData.ecom_meta && layerData.ecom_meta.kpis) || null;
        if (kpis) ecomChannel.postMessage({ type: 'ecom_kpis', kpis: kpis });
    }

    function applyLayer(layer) {
        if (!layer || !layer.buildings || !layer.nodes || !layer.flows) return;
        layerKpis = layer.kpis || null;

        layerData = layer.buildings;
        nodeData = layer.nodes;
        flowData = layer.flows;

        // The change beat can now hand over: what it was standing in for is
        // real. Until this arrives the marker holds, because a marker that
        // fades on a timer leaves a gap - the charge point blinked out and came
        // back a second later when the dispatch finally answered.
        let sweep = false;
        if (change && !change.landed) {
            change.landed = true;
            change.landedAt = performance.now();
            sweep = !!change.sweepSolar;
        }
        // Held dark until the repaint below, then brought up as a wave. Only
        // while the layer is on: nothing would ever bring it back up otherwise.
        if (sweep && isActive) solarSweep = 0;
        else sweep = false;
        // Which roofs the wave is for: the ones the change named.
        const newRoofs = {};
        if (sweep && change && change.spec && change.spec.targets) {
            change.spec.targets.forEach(function (target) {
                if (target && target.name) newRoofs[foldName(target.name)] = true;
            });
        }

        // prepare() re-derives flowCeiling from these flows, so the width scale
        // follows the new community rather than the one it replaced.
        prepare();

        layerData.features.forEach(function (feature) {
            const ecom = feature.properties.ecom;
            feature.properties.sweeping =
                sweep && ecom && newRoofs[foldName(ecom.name)] ? 1 : 0;
        });

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
        if (sweep) startRamp('sweep', 1, SWEEP_MS, 'inOut');

        ecomChannel.postMessage({ type: 'ecom_summary', summary: buildSummary() });
        announceKpis();

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
        // The lit building is the battery, so it goes when the battery goes -
        // otherwise unticking Storage leaves a red building behind with
        // nothing on the table to say what it is.
        [BATTERY_HOST_FILL_ID, BATTERY_HOST_LINE_ID, BATTERY_LEVEL_ID]
            .forEach(function (id) {
            if (map.getLayer(id)) {
                map.setLayoutProperty(id, 'visibility',
                                      shown('battery') ? 'visible' : 'none');
            }
        });
    }

    function applyFilters(filters) {
        viewFilters = filters || null;
        if (!map.getLayer(NODE_LAYER_ID)) return;

        if (!filters) {
            map.setFilter(NODE_LAYER_ID, NODE_BASE_FILTER);
            map.setFilter(SOLAR_LAYER_ID, SOLAR_BASE_FILTER);
            map.setFilter(FLOW_LAYER_ID, null);
            map.setFilter(FLOW_GLOW_ID, null);
            map.setFilter(FLOW_HEAD_GLOW_ID, null);
            map.setFilter(FLOW_HEAD_ID, null);
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
        // The heads carry their line's properties, so one filter serves both:
        // a hidden flow must not leave its light running across the table.
        map.setFilter(FLOW_LAYER_ID, flowFilter);
        map.setFilter(FLOW_GLOW_ID, flowFilter);
        map.setFilter(FLOW_HEAD_GLOW_ID, flowFilter);
        map.setFilter(FLOW_HEAD_ID, flowFilter);
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

        // Whatever arrived while this was loading.
        if (heldCaption) showCaption(heldCaption);

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
        announceKpis();
    }

    function deactivate() {
        setFlowMode('running');
        setUniform(false, null);
        endChange();
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

        // Switched on from the panel. The introduction needs the layer up
        // before its first step means anything, and the layer is otherwise only
        // switched on by hand at the table - so a presenter with the panel in
        // front of them had no way to do it, and the first step captioned a
        // table that was still showing bare streets.
        if (data.type === 'ecom_activate') {
            if (!isActive) activate();
            return;
        }

        if (data.type === 'ecom_flows') {
            setFlowMode(data.mode || 'running');
            return;
        }

        if (data.type === 'ecom_uniform') {
            setUniform(data.on, data.reveal || null);
            return;
        }

        if (data.type === 'ecom_change') {
            announceChange(data.change || null);
            return;
        }

        // What the change did, once the dispatch has been run. Arrives while
        // the animation is still going: the beats keep their own time so a slow
        // backend cannot stall them, and the outcome is shown when it lands.
        if (data.type === 'ecom_change_result') {
            if (change) {
                change.settleLine = data.line || '';
                if (data.line) {
                    showCaption({ title: change.spec.title || '',
                                  line: change.spec.line || '',
                                  figure: data.line });
                    change.settleShown = true;
                }
            }
            return;
        }

        if (data.type === 'ecom_caption') {
            // Handed over whole. showCaption is what decides whether the layer
            // is ready for it: replacing it with null here threw away the very
            // caption it was meant to hold, because switching the layer on
            // takes a moment and the caption arrives in the same breath.
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
