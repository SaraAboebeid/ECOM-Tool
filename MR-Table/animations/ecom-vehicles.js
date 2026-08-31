// ECOM Electric Vehicles
// ======================
// The cars that use the charge points, drawn arriving, parked and leaving.
//
// Not decoration, and not a traffic simulation either: one vehicle per charge
// point, moving on the schedule the dispatch already runs on. When the vehicle
// spec says it is plugged in from 18:00, the car drives up at 18:00; when the
// schedule releases it at 07:00, it drives away. The same schedule decides how
// much energy the charger draws, so the picture and the numbers cannot drift.
//
// Presence is the schedule, not the flow. A car that has finished charging is
// still parked, and one that is away is not merely idle - drawing the car by
// the flow would empty the bay the moment the battery filled.
//
// It drives on the street the charger actually stands on, read out of the same
// street-network.geojson the table draws, rather than sliding across the map.
//
// Exposes globals: ecomVehicles

(function () {
    'use strict';

    const channel = new BroadcastChannel('map_controller_channel');

    const STREETS_URL = 'media/street-network.geojson';
    const SOURCE_ID = 'ecom-vehicles-source';
    const LAYER_ID = 'ecom-vehicles';
    const ICON_ID = 'ecom-car';

    // How far back down the street a car appears before it arrives. Long enough
    // to read as an approach, short enough to finish inside one hour tick.
    const APPROACH_M = 140;
    const DRIVE_MS = 2000;

    // Parked cars stand beside the charger, not on top of its marker.
    const BAY_OFFSET_M = 7;

    const palette = (typeof window !== 'undefined' && window.ECOM_PALETTE) || {};
    const CAR_COLOR = palette.charge_point || '#00ff5e';

    let active = false;
    let streets = null;              // the street network, once fetched
    let streetsPromise = null;
    let frame = null;

    // One entry per charge point, keyed by node id.
    const vehicles = new Map();

    // ------------------------------------------------------------ geometry

    function metresPerDegree(lat) {
        return {
            lon: 111320 * Math.cos(lat * Math.PI / 180),
            lat: 110540
        };
    }

    function distance(a, b) {
        const scale = metresPerDegree((a[1] + b[1]) / 2);
        const dx = (b[0] - a[0]) * scale.lon;
        const dy = (b[1] - a[1]) * scale.lat;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** Compass bearing from a to b, for rotating the car to face its travel. */
    function bearing(a, b) {
        const scale = metresPerDegree((a[1] + b[1]) / 2);
        const dx = (b[0] - a[0]) * scale.lon;
        const dy = (b[1] - a[1]) * scale.lat;
        return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    }

    /** A point some distance along a path, with the heading it is travelling. */
    function alongPath(path, metres) {
        if (path.length < 2) return { point: path[0], heading: 0 };
        let walked = 0;
        for (let i = 1; i < path.length; i += 1) {
            const step = distance(path[i - 1], path[i]);
            if (walked + step >= metres || i === path.length - 1) {
                const into = step > 0 ? Math.min(1, (metres - walked) / step) : 1;
                return {
                    point: [
                        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * into,
                        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * into
                    ],
                    heading: bearing(path[i - 1], path[i])
                };
            }
            walked += step;
        }
        return { point: path[path.length - 1], heading: 0 };
    }

    function pathLength(path) {
        let total = 0;
        for (let i = 1; i < path.length; i += 1) total += distance(path[i - 1], path[i]);
        return total;
    }

    /** Every LineString in the network, MultiLineStrings unpacked. */
    function streetLines(geojson) {
        const lines = [];
        (geojson.features || []).forEach(function (feature) {
            const geometry = feature.geometry || {};
            if (geometry.type === 'LineString') {
                lines.push(geometry.coordinates);
            } else if (geometry.type === 'MultiLineString') {
                geometry.coordinates.forEach(function (part) { lines.push(part); });
            }
        });
        return lines;
    }

    /**
     * The drive in and the drive out for one charge point.
     *
     * The charger is placed on a street, so the nearest vertex of the nearest
     * line is the bay. The approach is the stretch of road leading up to it and
     * the departure continues past it; where the road ends first, the car
     * leaves the way it came, which is what a dead end forces anyway.
     */
    function routeFor(position, lines) {
        let best = null;
        lines.forEach(function (line) {
            line.forEach(function (vertex, index) {
                const gap = distance(position, vertex);
                if (!best || gap < best.gap) best = { line: line, index: index, gap: gap };
            });
        });
        if (!best) return null;

        const walk = function (step) {
            const path = [];
            let travelled = 0;
            let i = best.index;
            while (i >= 0 && i < best.line.length && travelled < APPROACH_M) {
                path.push(best.line[i]);
                const next = i + step;
                if (next < 0 || next >= best.line.length) break;
                travelled += distance(best.line[i], best.line[next]);
                i = next;
            }
            return path;                       // ordered from the bay outwards
        };

        const back = walk(-1);
        const forward = walk(1);
        // Inbound runs towards the charger, so the outward walk is reversed.
        const inbound = back.length > 1 ? back.slice().reverse() : forward.slice().reverse();
        const outbound = forward.length > 1 ? forward : back;

        return {
            inbound: inbound.concat([position]),
            outbound: [position].concat(outbound.slice(1)),
            // The bay sits beside the road, offset across the direction of
            // travel so a parked car does not cover the charger's own marker.
            bay: offsetBay(position, inbound)
        };
    }

    function offsetBay(position, inbound) {
        if (inbound.length < 2) return { point: position, heading: 0 };
        const approach = bearing(inbound[inbound.length - 2], position);
        const across = (approach + 90) * Math.PI / 180;
        const scale = metresPerDegree(position[1]);
        return {
            point: [
                position[0] + (Math.sin(across) * BAY_OFFSET_M) / scale.lon,
                position[1] + (Math.cos(across) * BAY_OFFSET_M) / scale.lat
            ],
            heading: approach
        };
    }

    // ---------------------------------------------------------------- icon

    /** A small car, drawn once and handed to MapLibre as an image. */
    function makeCarIcon() {
        const size = 28;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Pointing up: icon-rotate turns it to the heading.
        ctx.translate(size / 2, size / 2);

        ctx.fillStyle = CAR_COLOR;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1;

        // Body.
        ctx.beginPath();
        ctx.moveTo(-4.5, -9);
        ctx.lineTo(4.5, -9);
        ctx.lineTo(6, -2);
        ctx.lineTo(6, 8);
        ctx.lineTo(-6, 8);
        ctx.lineTo(-6, -2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Windscreen, so the car has a front at a glance.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.beginPath();
        ctx.moveTo(-3.5, -7.5);
        ctx.lineTo(3.5, -7.5);
        ctx.lineTo(4.5, -3);
        ctx.lineTo(-4.5, -3);
        ctx.closePath();
        ctx.fill();

        return ctx.getImageData(0, 0, size, size);
    }

    function ensureLayer() {
        if (typeof map === 'undefined' || !map) return false;

        if (!map.hasImage(ICON_ID)) {
            const image = makeCarIcon();
            if (image) map.addImage(ICON_ID, image);
        }
        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }
        if (!map.getLayer(LAYER_ID)) {
            map.addLayer({
                id: LAYER_ID,
                type: 'symbol',
                source: SOURCE_ID,
                layout: {
                    'icon-image': ICON_ID,
                    'icon-size': 0.85,
                    'icon-rotate': ['get', 'heading'],
                    // Turn with the map: a car is on a road, and a road turns
                    // when the table's map is rotated to face the room.
                    'icon-rotation-alignment': 'map',
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true
                },
                paint: {
                    'icon-opacity': ['get', 'opacity']
                }
            });
        }
        return true;
    }

    // --------------------------------------------------------------- state

    function draw() {
        const source = typeof map !== 'undefined' && map && map.getSource(SOURCE_ID);
        if (!source) return;

        const features = [];
        vehicles.forEach(function (vehicle) {
            if (vehicle.state === 'away' || !vehicle.at) return;
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: vehicle.at.point },
                properties: {
                    id: vehicle.id,
                    name: vehicle.name,
                    heading: vehicle.at.heading,
                    state: vehicle.state,
                    opacity: vehicle.opacity
                }
            });
        });
        source.setData({ type: 'FeatureCollection', features: features });
    }

    function tick(now) {
        let moving = false;

        vehicles.forEach(function (vehicle) {
            if (vehicle.state === 'arriving' || vehicle.state === 'leaving') {
                const path = vehicle.state === 'arriving'
                    ? vehicle.route.inbound : vehicle.route.outbound;
                const progress = Math.min(1, (now - vehicle.startedAt) / DRIVE_MS);
                // Ease out on arrival and in on departure: a car that stops
                // dead at the bay reads as a jump rather than a park.
                const eased = vehicle.state === 'arriving'
                    ? 1 - Math.pow(1 - progress, 2)
                    : progress * progress;
                vehicle.at = alongPath(path, eased * pathLength(path));
                vehicle.opacity = 1;
                if (progress >= 1) {
                    if (vehicle.state === 'arriving') {
                        vehicle.state = 'parked';
                        vehicle.at = vehicle.route.bay;
                    } else {
                        vehicle.state = 'away';
                        vehicle.at = null;
                    }
                } else {
                    moving = true;
                }
            } else if (vehicle.state === 'parked') {
                vehicle.at = vehicle.route.bay;
                // Breathing while it charges, steady once it is only parked.
                // The charger's own marker says how much; this says whether.
                if (vehicle.charging) {
                    vehicle.opacity = 0.72 + 0.28 * (0.5 + 0.5 *
                        Math.sin(now / 420));
                    moving = true;
                } else {
                    vehicle.opacity = 1;
                }
            }
        });

        draw();

        if (active && moving) {
            frame = requestAnimationFrame(tick);
        } else {
            frame = null;
        }
    }

    // Placed at the head of its path as the state changes, rather than left
    // without a position until the first animation frame: a frame can be a
    // while coming - a table whose window is not in front runs no frames at all
    // - and until then the car would be travelling and drawn nowhere.
    function start(vehicle, state, path) {
        vehicle.state = state;
        vehicle.startedAt = performance.now();
        vehicle.at = alongPath(path, 0);
        vehicle.opacity = 1;
    }

    function nudge() {
        if (!active || frame !== null) return;
        frame = requestAnimationFrame(tick);
    }

    /** Apply an hour's worth of truth: who is here, who is charging. */
    function report(points) {
        if (!streets) return;

        (points || []).forEach(function (point) {
            let vehicle = vehicles.get(point.id);
            if (!vehicle) {
                const route = routeFor([point.lon, point.lat], streets);
                if (!route) return;
                vehicle = { id: point.id, name: point.name, route: route,
                            state: 'away', at: null, opacity: 1, charging: false };
                vehicles.set(point.id, vehicle);
            }
            vehicle.charging = !!point.charging;

            const here = vehicle.state === 'parked' || vehicle.state === 'arriving';
            if (point.plugged && !here) {
                start(vehicle, 'arriving', vehicle.route.inbound);
            } else if (!point.plugged && here) {
                start(vehicle, 'leaving', vehicle.route.outbound);
            }
        });

        // A charger that has gone from the community takes its car with it.
        const live = new Set((points || []).map(function (p) { return p.id; }));
        vehicles.forEach(function (vehicle, id) {
            if (!live.has(id)) vehicles.delete(id);
        });

        draw();
        nudge();
    }

    // ------------------------------------------------------------- control

    function loadStreets() {
        if (streetsPromise) return streetsPromise;
        streetsPromise = fetch(STREETS_URL, { cache: 'no-store' })
            .then(function (response) {
                if (!response.ok) throw new Error(STREETS_URL + ': ' + response.status);
                return response.json();
            })
            .then(function (geojson) {
                streets = streetLines(geojson);
                return streets;
            })
            .catch(function (error) {
                // No street network means no roads to drive on. The rest of the
                // layer is unaffected, so this stays quiet beyond the log.
                console.warn('[ecom] vehicles: ' + error.message);
                streetsPromise = null;
                return null;
            });
        return streetsPromise;
    }

    function enable() {
        active = true;
        loadStreets().then(function () {
            if (!active) return;
            ensureLayer();
            if (map.getLayer(LAYER_ID)) {
                map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
            }
            if (pending) {
                report(pending);
                pending = null;
            } else {
                // Nothing has been broadcast since we came up. The day clock
                // may be stopped, so ask rather than wait for a tick that is
                // not coming.
                channel.postMessage({ type: 'ecom_vehicles_request' });
            }
        });
    }

    function disable() {
        active = false;
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        vehicles.clear();
        if (typeof map !== 'undefined' && map && map.getLayer(LAYER_ID)) {
            map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
        }
        draw();
    }

    // A report can arrive before the street network has finished loading; the
    // hour it describes is still the hour to draw when it does.
    let pending = null;

    channel.addEventListener('message', function (event) {
        const data = event.data || {};

        if (data.type === 'ecom_vehicles') {
            if (!active) return;
            if (!streets) { pending = data.chargePoints; return; }
            report(data.chargePoints);
            return;
        }

        if (data.type === 'animation_state' && data.animationId === 'ecom-energy-btn') {
            if (data.isActive) enable();
            else disable();
        }
    });

    window.ecomVehicles = {
        enable: enable,
        disable: disable,
        isOn: function () { return active; },
        // For the harness: what is on the road right now.
        fleet: function () {
            const out = [];
            vehicles.forEach(function (vehicle) {
                out.push({ id: vehicle.id, state: vehicle.state,
                           at: vehicle.at ? vehicle.at.point : null,
                           heading: vehicle.at ? vehicle.at.heading : null,
                           opacity: vehicle.opacity, charging: vehicle.charging });
            });
            return out;
        },
        // For the harness: advance the animation without a real clock.
        step: function (now) { tick(now); }
    };
})();
