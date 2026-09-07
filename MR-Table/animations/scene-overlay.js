// Scene overlay - draws the intervention itself on the table.
//
// The analysis layers show what an intervention *does*: the wind bends, the
// cars stop spawning. On their own that is a change with no visible cause, and
// an audience standing at the model cannot tell a pedestrianised street from a
// quiet one. This draws the cause - the new block, the new trees, the street
// that was changed - on top of the basemap, in the ECOM semantic colours.
//
// Display side only. Reads Scene; never writes to it.
//
// Exposes global: sceneOverlay

(function () {
    'use strict';

    if (typeof window.Scene === 'undefined') {
        console.warn('Scene overlay: scene.js must load first');
        return;
    }

    const EMPTY = { type: 'FeatureCollection', features: [] };

    const SOURCES = {
        'scene-areas': EMPTY,   // added polygons - new blocks, parks
        'scene-points': EMPTY,  // added points - trees
        'scene-lines': EMPTY    // modified lines - pedestrianised streets
    };

    let styleReady = false;

    function addLayers() {
        Object.keys(SOURCES).forEach(function (id) {
            if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: SOURCES[id] });
        });

        if (!map.getLayer('scene-areas-fill')) {
            map.addLayer({
                id: 'scene-areas-fill',
                type: 'fill',
                source: 'scene-areas',
                paint: { 'fill-color': '#ff00a6', 'fill-opacity': 0.32 }
            });
            map.addLayer({
                id: 'scene-areas-line',
                type: 'line',
                source: 'scene-areas',
                paint: { 'line-color': '#ff00a6', 'line-width': 1.6, 'line-opacity': 0.95 }
            });
        }

        // Drawn under the areas so a tree belt along a new block reads as
        // planting beside it rather than on top of it.
        if (!map.getLayer('scene-points-dot')) {
            map.addLayer({
                id: 'scene-points-dot',
                type: 'circle',
                source: 'scene-points',
                paint: {
                    'circle-color': '#7dffb0',
                    'circle-opacity': 0.75,
                    // A tree crown is under half a millimetre at table scale, so
                    // this is a symbol, not a footprint. Held at a constant
                    // screen size rather than scaled with zoom.
                    'circle-radius': 2.6,
                    'circle-blur': 0.4
                }
            }, 'scene-areas-fill');
        }

        if (!map.getLayer('scene-lines-glow')) {
            map.addLayer({
                id: 'scene-lines-glow',
                type: 'line',
                source: 'scene-lines',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#eaff00', 'line-width': 7, 'line-opacity': 0.18, 'line-blur': 4 }
            }, 'scene-areas-fill');
            map.addLayer({
                id: 'scene-lines-core',
                type: 'line',
                source: 'scene-lines',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#eaff00', 'line-width': 2.2, 'line-opacity': 0.9 }
            }, 'scene-areas-fill');
        }

        styleReady = true;
        refresh();
    }

    // A modified street is only drawable if something registered the base
    // collection it belongs to - the geometry lives there, not in the edit.
    // street-life registers it whenever it runs, so this fetch is the fallback
    // for a session where street-life was never switched on.
    let fetchingStreets = false;
    function ensureStreetBase() {
        if (Scene.hasBase('streets') || fetchingStreets) return;
        fetchingStreets = true;
        fetch('media/street-network.geojson')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (geojson) {
                if (geojson) {
                    Scene.resolve('streets', geojson);
                    refresh();
                }
            })
            .catch(function (err) { console.warn('Scene overlay: no street base', err); })
            .then(function () { fetchingStreets = false; });
    }

    function collect() {
        const areas = [];
        const points = [];
        const lines = [];

        // Added geometry is carried in the edit, so it needs no base at all.
        Scene.edits().forEach(function (edit) {
            if (edit.op !== 'add') return;
            (edit.features || []).forEach(function (feature) {
                const type = feature.geometry && feature.geometry.type;
                if (type === 'Polygon' || type === 'MultiPolygon') areas.push(feature);
                else if (type === 'Point' || type === 'MultiPoint') points.push(feature);
                else if (type === 'LineString' || type === 'MultiLineString') lines.push(feature);
            });
        });

        const modifiesStreets = Scene.edits().some(function (edit) {
            return edit.op === 'modify' && edit.dataset === 'streets';
        });

        if (modifiesStreets) {
            const streets = Scene.dataset('streets');
            if (streets) {
                streets.features.forEach(function (feature) {
                    if (feature.properties && feature.properties._scene_edit) lines.push(feature);
                });
            } else {
                ensureStreetBase();
            }
        }

        return {
            'scene-areas': { type: 'FeatureCollection', features: areas },
            'scene-points': { type: 'FeatureCollection', features: points },
            'scene-lines': { type: 'FeatureCollection', features: lines }
        };
    }

    function refresh() {
        if (!styleReady) return;
        const next = collect();
        Object.keys(next).forEach(function (id) {
            const source = map.getSource(id);
            if (source) source.setData(next[id]);
        });
    }

    // The authoring view needs to know which patch of ground is actually on the
    // physical model, and only the display can answer: the table overlay is
    // sized from this window's width in centimetres. Four unprojected corners
    // rather than a bounding box, because the map is rotated ~92 degrees.
    function tableBounds() {
        if (typeof window.computeOverlayPixelSize !== 'function') return null;
        const size = window.computeOverlayPixelSize();
        const rect = map.getContainer().getBoundingClientRect();
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;

        const corners = [
            [cx - size.w / 2, cy - size.h / 2],
            [cx + size.w / 2, cy - size.h / 2],
            [cx + size.w / 2, cy + size.h / 2],
            [cx - size.w / 2, cy + size.h / 2]
        ];

        return corners.map(function (point) {
            const lngLat = map.unproject([point[0] - rect.left, point[1] - rect.top]);
            return [lngLat.lng, lngLat.lat];
        });
    }

    const channel = new BroadcastChannel('map_controller_channel');

    function sendBounds() {
        const corners = tableBounds();
        if (corners) channel.postMessage({ type: 'scene_table_bounds', corners: corners });
    }

    channel.addEventListener('message', function (event) {
        if ((event.data || {}).type === 'scene_request_bounds') sendBounds();
    });

    if (typeof map === 'undefined') {
        console.warn('Scene overlay: no map, overlay disabled');
        return;
    }

    if (map.isStyleLoaded()) addLayers();
    else map.on('load', addLayers);

    map.on('moveend', sendBounds);
    window.addEventListener('resize', sendBounds);

    Scene.onChange(refresh);

    window.sceneOverlay = { refresh: refresh, tableBounds: tableBounds, sendBounds: sendBounds };

    console.log('Scene overlay module loaded');

})();
