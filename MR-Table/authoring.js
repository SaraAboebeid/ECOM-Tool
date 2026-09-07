// Authoring view - where district-scale interventions get placed.
//
// Runs as a second window on the presenter's machine for now, and is written to
// move to an iPad unchanged: 48px targets, no hover, no keyboard. The only thing
// that has to change for the iPad is the transport inside scene.js.
//
// Two rules make this view work alongside the table rather than fighting it:
//
//   1. The cameras are decoupled. This map pans and zooms freely; the display
//      stays locked at map-calibration.json. Only edits cross the channel, never
//      the viewport. The dashed rectangle shows which patch of ground is
//      actually on the physical model.
//
//   2. The bearing is locked to the table's. Rotation is disabled, so what is up
//      here is up on the model, and nobody has to re-orient between looking down
//      at the iPad and looking at the tiles.

(function () {
    'use strict';

    const CONTEXT_ZOOM_HINT = 'Pinch to zoom in before drawing — one fingertip covers ~70 m at table scale.';
    const TREE_SPACING_M = 15;
    const TREE_HEIGHT_M = 12;

    const channel = new BroadcastChannel('map_controller_channel');

    let map = null;
    let tool = null;
    let vertices = [];          // [lng, lat] while drawing a block or a belt
    let selectedStreet = null;  // { osm_id, name, features }

    const el = {
        hint: document.getElementById('hint'),
        pending: document.getElementById('pending'),
        pendingLabel: document.getElementById('pending-label'),
        heightRow: document.getElementById('height-row'),
        height: document.getElementById('height'),
        heightValue: document.getElementById('height-value'),
        commit: document.getElementById('commit-btn'),
        cancel: document.getElementById('cancel-btn'),
        undo: document.getElementById('undo-btn'),
        clear: document.getElementById('clear-btn'),
        list: document.getElementById('scene-list'),
        empty: document.getElementById('scene-empty'),
        count: document.getElementById('scene-count')
    };

    // ---------------------------------------------------------------- geometry

    function metres(a, b) {
        const R = 6371000;
        const dLat = (b[1] - a[1]) * Math.PI / 180;
        const dLng = (b[0] - a[0]) * Math.PI / 180;
        const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
        const x = dLng * Math.cos(lat);
        return Math.sqrt(x * x + dLat * dLat) * R;
    }

    function sampleAlong(coords, spacing) {
        const out = [];
        let carry = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i];
            const b = coords[i + 1];
            const len = metres(a, b);
            if (len <= 0) continue;
            let d = carry;
            while (d <= len) {
                const t = d / len;
                out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
                d += spacing;
            }
            carry = d - len;
        }
        return out;
    }

    function areaHectares(ring) {
        // Planar shoelace on metres-from-first-vertex. Fine at block scale, and
        // this number is only ever read as a sanity check.
        if (ring.length < 3) return 0;
        const origin = ring[0];
        const pts = ring.map(function (p) {
            return [
                metres(origin, [p[0], origin[1]]) * (p[0] < origin[0] ? -1 : 1),
                metres(origin, [origin[0], p[1]]) * (p[1] < origin[1] ? -1 : 1)
            ];
        });
        let sum = 0;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            sum += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(sum / 2) / 10000;
    }

    function pointToSegment(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + t * dx;
        const cy = a.y + t * dy;
        return Math.hypot(p.x - cx, p.y - cy);
    }

    // The hit layer is deliberately wider than a street, so a tap usually lands
    // on several at once - at table scale eighteen pixels is about twenty metres,
    // which in this network is three or four streets. queryRenderedFeatures
    // returns them in render order, not by distance, so taking the first hit
    // picks an arbitrary one: aiming at the middle of Aschebergsgatan selected an
    // unnamed service stub beside it. Nearest centreline is what a tap means.
    function nearestFeature(point, features) {
        let best = null;
        let bestDistance = Infinity;

        features.forEach(function (feature) {
            const geometry = feature.geometry || {};
            const lines = geometry.type === 'LineString' ? [geometry.coordinates]
                : geometry.type === 'MultiLineString' ? geometry.coordinates
                : [];

            lines.forEach(function (line) {
                for (let i = 0; i < line.length - 1; i++) {
                    const distance = pointToSegment(point, map.project(line[i]), map.project(line[i + 1]));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = feature;
                    }
                }
            });
        });

        return best;
    }

    const EMPTY = { type: 'FeatureCollection', features: [] };
    function fc(features) { return { type: 'FeatureCollection', features: features }; }
    function setData(id, data) {
        const source = map && map.getSource(id);
        if (source) source.setData(data);
    }

    // ------------------------------------------------------------------- setup

    fetch('map-calibration.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (calibration) {
            const c = calibration || {
                center: { lng: 11.977770568930168, lat: 57.68839377903814 },
                zoom: 15.807,
                bearing: -92.585
            };
            init(c);
        });

    function init(calibration) {
        map = new maplibregl.Map({
            container: 'map',
            style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
            center: [calibration.center.lng, calibration.center.lat],
            zoom: calibration.zoom,
            bearing: calibration.bearing,
            pitch: 0,
            attributionControl: true
        });

        // Locked, not merely defaulted. Rule 2 above.
        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();
        if (map.keyboard && map.keyboard.disableRotation) map.keyboard.disableRotation();

        map.on('load', function () {
            addContextLayers();
            loadContextData();
            map.on('click', onMapClick);
            askForTableBounds();
        });
    }

    function addContextLayers() {
        ['ctx-streets', 'ctx-buildings', 'scene-areas', 'scene-points', 'scene-lines',
            'draft-shape', 'draft-points', 'table-extent'].forEach(function (id) {
            map.addSource(id, { type: 'geojson', data: EMPTY });
        });

        // Context. Dim on purpose - it is there to be tapped and to orient, not
        // to compete with what gets placed on top of it.
        map.addLayer({
            id: 'ctx-buildings', type: 'fill', source: 'ctx-buildings',
            paint: { 'fill-color': '#5c6b7d', 'fill-opacity': 0.22 }
        });
        map.addLayer({
            id: 'ctx-streets', type: 'line', source: 'ctx-streets',
            paint: { 'line-color': '#8fa3ba', 'line-opacity': 0.45, 'line-width': 1.2 }
        });
        // Invisible, generously wide, and the only thing the street tool queries.
        // Tapping within ~9 m of the centreline is not a realistic ask; tapping
        // within a fingertip is.
        map.addLayer({
            id: 'ctx-streets-hit', type: 'line', source: 'ctx-streets',
            paint: { 'line-color': '#000000', 'line-opacity': 0.01, 'line-width': 18 }
        });

        map.addLayer({
            id: 'scene-lines-glow', type: 'line', source: 'scene-lines',
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#eaff00', 'line-width': 9, 'line-opacity': 0.2, 'line-blur': 5 }
        });
        map.addLayer({
            id: 'scene-lines-core', type: 'line', source: 'scene-lines',
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#eaff00', 'line-width': 2.6 }
        });
        map.addLayer({
            id: 'scene-points-dot', type: 'circle', source: 'scene-points',
            paint: { 'circle-color': '#7dffb0', 'circle-radius': 3.2, 'circle-opacity': 0.85 }
        });
        map.addLayer({
            id: 'scene-areas-fill', type: 'fill', source: 'scene-areas',
            paint: { 'fill-color': '#ff00a6', 'fill-opacity': 0.3 }
        });
        map.addLayer({
            id: 'scene-areas-line', type: 'line', source: 'scene-areas',
            paint: { 'line-color': '#ff00a6', 'line-width': 1.8 }
        });

        map.addLayer({
            id: 'table-extent', type: 'line', source: 'table-extent',
            paint: { 'line-color': '#00ffe5', 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [3, 3] }
        });

        map.addLayer({
            id: 'draft-fill', type: 'fill', source: 'draft-shape',
            paint: { 'fill-color': '#e8eef6', 'fill-opacity': 0.16 }
        });
        map.addLayer({
            id: 'draft-line', type: 'line', source: 'draft-shape',
            paint: { 'line-color': '#e8eef6', 'line-width': 1.8, 'line-dasharray': [2, 2] }
        });
        map.addLayer({
            id: 'draft-points', type: 'circle', source: 'draft-points',
            paint: {
                'circle-color': '#e8eef6', 'circle-radius': 5,
                'circle-stroke-color': '#141a22', 'circle-stroke-width': 2
            }
        });
    }

    function loadContextData() {
        fetch('media/street-network.geojson')
            .then(function (r) { return r.json(); })
            .then(function (geojson) {
                setData('ctx-streets', Scene.resolve('streets', geojson));
                renderScene();
            })
            .catch(function (err) { console.warn('Authoring: no street network', err); });

        fetch('media/building-footprints.geojson')
            .then(function (r) { return r.json(); })
            .then(function (geojson) {
                setData('ctx-buildings', Scene.resolve('buildings', geojson));
                renderScene();
            })
            .catch(function (err) { console.warn('Authoring: no building footprints', err); });
    }

    // The display owns this: the table rectangle is sized from its window width
    // in centimetres, which this view has no way to know. Asked for on start and
    // then whenever the display moves.
    function askForTableBounds() {
        channel.postMessage({ type: 'scene_request_bounds' });
        // Asked once more in case this view opened before the display did. No
        // answer just means no rectangle - the tools all still work.
        setTimeout(function () {
            const source = map.getSource('table-extent');
            const data = source && source._data;
            if (!data || !data.features || !data.features.length) {
                channel.postMessage({ type: 'scene_request_bounds' });
            }
        }, 2500);
    }

    channel.addEventListener('message', function (event) {
        const data = event.data || {};
        if (data.type !== 'scene_table_bounds' || !data.corners) return;
        setData('table-extent', fc([{
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: data.corners.concat([data.corners[0]]) }
        }]));
    });

    // ------------------------------------------------------------------- tools

    function setTool(next) {
        tool = tool === next ? null : next;
        vertices = [];
        selectedStreet = null;
        document.querySelectorAll('.tool').forEach(function (button) {
            button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
        });
        el.heightRow.classList.toggle('show', tool === 'block');
        renderDraft();
        updateHint();
    }

    document.querySelectorAll('.tool').forEach(function (button) {
        button.addEventListener('click', function () { setTool(button.dataset.tool); });
    });

    el.height.addEventListener('input', function () {
        el.heightValue.textContent = el.height.value + ' m';
        updatePending();
    });

    function onMapClick(event) {
        if (!tool) return;

        if (tool === 'street') {
            const box = [
                [event.point.x - 12, event.point.y - 12],
                [event.point.x + 12, event.point.y + 12]
            ];
            const hits = map.queryRenderedFeatures(box, { layers: ['ctx-streets-hit'] });
            if (!hits.length) return;

            const hit = nearestFeature(event.point, hits);
            if (!hit) return;
            const props = hit.properties || {};

            // osm_id is unique per feature in this export, so matching on it
            // would pedestrianise the twenty metres under the finger and nothing
            // else. The name is what groups a street into the thing anyone
            // actually means by "pedestrianise Aschebergsgatan" - so match on
            // that where there is one, and fall back to the single segment for
            // the unnamed three-quarters of the network.
            const hasOsmId = props.osm_id !== undefined && props.osm_id !== null;
            const match = props.name ? { name: props.name }
                : hasOsmId ? { osm_id: props.osm_id }
                : null;
            if (!match) return;

            const streets = Scene.dataset('streets');
            const features = (streets ? streets.features : []).filter(function (f) {
                const p = f.properties || {};
                return Object.keys(match).every(function (k) { return p[k] === match[k]; });
            });

            selectedStreet = {
                match: match,
                name: props.name || 'unnamed segment',
                features: features
            };
        } else {
            vertices = vertices.concat([[event.lngLat.lng, event.lngLat.lat]]);
        }

        renderDraft();
        updatePending();
    }

    function renderDraft() {
        if (tool === 'street') {
            setData('draft-shape', selectedStreet ? fc(selectedStreet.features) : EMPTY);
            setData('draft-points', EMPTY);
            return;
        }

        setData('draft-points', fc(vertices.map(function (v) {
            return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: v } };
        })));

        if (tool === 'block' && vertices.length >= 3) {
            setData('draft-shape', fc([{
                type: 'Feature', properties: {},
                geometry: { type: 'Polygon', coordinates: [vertices.concat([vertices[0]])] }
            }]));
        } else if (vertices.length >= 2) {
            setData('draft-shape', fc([{
                type: 'Feature', properties: {},
                geometry: { type: 'LineString', coordinates: vertices }
            }]));
        } else {
            setData('draft-shape', EMPTY);
        }
    }

    function updateHint() {
        if (!tool) {
            el.hint.innerHTML = 'Pick a tool below. The table shows the result as you commit.';
        } else if (tool === 'block') {
            el.hint.innerHTML = '<b>Block</b> — tap three or more corners, set a height, then Place. ' + CONTEXT_ZOOM_HINT;
        } else if (tool === 'street') {
            el.hint.innerHTML = '<b>Pedestrianise</b> — tap a street. A named street is taken whole; an unnamed one, segment by segment.';
        } else {
            el.hint.innerHTML = '<b>Tree belt</b> — tap along a line. Trees are placed every ' + TREE_SPACING_M + ' m as porous obstacles.';
        }
    }

    function updatePending() {
        let ready = false;
        let label = '';

        if (tool === 'block') {
            ready = vertices.length >= 3;
            label = ready
                ? '<b>New block</b> — ' + vertices.length + ' corners, ' +
                  areaHectares(vertices).toFixed(2) + ' ha, ' + el.height.value + ' m tall'
                : '<b>New block</b> — ' + vertices.length + ' of 3 corners';
            el.commit.textContent = 'Place block';
        } else if (tool === 'street') {
            ready = Boolean(selectedStreet && selectedStreet.features.length);
            label = selectedStreet
                ? '<b>' + selectedStreet.name + '</b> — ' + selectedStreet.features.length + ' segments'
                : '<b>No street selected</b>';
            el.commit.textContent = 'Pedestrianise';
        } else if (tool === 'treeline') {
            const count = vertices.length >= 2 ? sampleAlong(vertices, TREE_SPACING_M).length : 0;
            ready = count > 0;
            label = ready
                ? '<b>Tree belt</b> — ' + count + ' trees'
                : '<b>Tree belt</b> — tap at least two points';
            el.commit.textContent = 'Plant belt';
        }

        el.pendingLabel.innerHTML = label;
        el.commit.disabled = !ready;
        el.pending.classList.toggle('show', Boolean(tool));
    }

    // Nothing reaches the table until Place is pressed. A stray tap in front of
    // an audience should not re-rasterize the wind field.
    el.commit.addEventListener('click', function () {
        if (tool === 'block' && vertices.length >= 3) {
            Scene.apply({
                op: 'add',
                dataset: 'buildings',
                label: 'New block, ' + areaHectares(vertices).toFixed(2) + ' ha',
                features: [{
                    type: 'Feature',
                    properties: { height: Number(el.height.value), use: 'proposed', name: 'Proposed block' },
                    geometry: { type: 'Polygon', coordinates: [vertices.concat([vertices[0]])] }
                }]
            });
        } else if (tool === 'street' && selectedStreet) {
            Scene.apply({
                op: 'modify',
                dataset: 'streets',
                label: 'Pedestrianised ' + selectedStreet.name,
                match: selectedStreet.match,
                props: { highway: 'pedestrian' }
            });
        } else if (tool === 'treeline') {
            const points = sampleAlong(vertices, TREE_SPACING_M);
            Scene.apply({
                op: 'add',
                dataset: 'trees',
                label: 'Tree belt, ' + points.length + ' trees',
                features: points.map(function (p) {
                    return {
                        type: 'Feature',
                        properties: { height: TREE_HEIGHT_M, planted: true },
                        geometry: { type: 'Point', coordinates: p }
                    };
                })
            });
        }

        vertices = [];
        selectedStreet = null;
        renderDraft();
        updatePending();
    });

    el.cancel.addEventListener('click', function () { setTool(null); });
    el.undo.addEventListener('click', function () { Scene.undo(); });
    el.clear.addEventListener('click', function () {
        if (Scene.edits().length && confirm('Remove every intervention from the scene?')) Scene.clear();
    });

    // ------------------------------------------------------------------ render

    function renderScene() {
        if (!map || !map.getSource('scene-areas')) return;

        const areas = [];
        const points = [];
        const lines = [];

        Scene.edits().forEach(function (edit) {
            if (edit.op !== 'add') return;
            (edit.features || []).forEach(function (feature) {
                const type = feature.geometry && feature.geometry.type;
                if (type === 'Polygon' || type === 'MultiPolygon') areas.push(feature);
                else if (type === 'Point') points.push(feature);
                else lines.push(feature);
            });
        });

        const streets = Scene.dataset('streets');
        if (streets) {
            streets.features.forEach(function (feature) {
                if (feature.properties && feature.properties._scene_edit) lines.push(feature);
            });
            setData('ctx-streets', streets);
        }
        const buildings = Scene.dataset('buildings');
        if (buildings) setData('ctx-buildings', buildings);

        setData('scene-areas', fc(areas));
        setData('scene-points', fc(points));
        setData('scene-lines', fc(lines));

        renderList();
    }

    function renderList() {
        const edits = Scene.edits();
        el.count.textContent = String(edits.length);
        el.empty.style.display = edits.length ? 'none' : 'block';
        el.list.innerHTML = '';

        edits.slice().reverse().forEach(function (edit) {
            const item = document.createElement('li');
            item.className = edit.dataset;
            item.innerHTML = '<span>' + (edit.label || edit.op + ' ' + edit.dataset) + '</span>' +
                '<small>' + edit.dataset + '</small>';
            el.list.appendChild(item);
        });
    }

    Scene.onChange(renderScene);
    Scene.requestState();
    renderList();
    updateHint();

    // For the console and for tests: the map lives inside this closure, so
    // without a handle there is no way to turn a coordinate into a tap.
    window.authoringView = {
        map: function () { return map; },
        tool: function () { return tool; },
        pending: function () {
            if (tool === 'street') return selectedStreet;
            return vertices.slice();
        }
    };

})();
