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

    // A car comes in from off the table and leaves the same way. Appearing a
    // hundred metres up the road is the thing this replaced: on a projection
    // table, something materialising mid-street reads as a glitch rather than
    // as a car.

    // A departing car does not stop existing at the end of the block. It keeps
    // going until it is off the table, so the way out is followed across
    // junctions for further than the frame can be at the calibrated zoom, and
    // the car is dropped only once it is outside the view or out of road.
    // Two kilometres of road: the table window is calibrated at about a metre
    // to the pixel, so the far edge of a large display can be most of a
    // kilometre from a charger, and the exit has to outlast the frame rather
    // than the other way round.
    const EXIT_M = 2000;
    const JOIN_M = 25;          // how close two street ends must be to be one road
    const TURN_LIMIT_DEG = 100; // sharper than this at a junction is a U-turn

    // Metres per second of wall clock. Departure is measured in distance rather
    // than in a fixed duration, so a long exit is a longer drive rather than a
    // faster car - and the edge of the frame can be a kilometre away, which at
    // the approach speed would leave a car still driving twenty simulated hours
    // after it left. It pulls away faster than it arrived, which is also what a
    // car does.
    // Speed is a profile, and it is measured in pixels.
    //
    // Metres per second was the wrong unit and it hid a factor of two.
    // MapLibre's tiles are 512 px, so at this table's calibration a metre is
    // 0.58 px, not the 1.17 assumed: a car set to 110 m/s was crossing the
    // screen at 188 px/s, far too fast to follow, and the visible map is half
    // the width that number implied - so it was off the edge and gone almost
    // as soon as it appeared. Anchoring to the screen fixes both and survives
    // any recalibration or zoom.
    //
    // Quick out on the open road, slowing over the last stretch, creeping into
    // the bay. Same in reverse on the way out.
    // 140, not the 188 px/s that was too fast to follow, and not lower: the
    // car is only plugged in for thirteen hours, which is fourteen seconds at
    // the table's clock, and every second spent driving is a second it is not
    // parked at the charger. This is the fastest it may be while still being
    // followable, and the slowest it may be while still getting there.
    const CRUISE_PX = 140;       // pixels per second, out on the open road
    const PARK_PX = 10;          // pixels per second into the bay
    const SLOW_PX = 150;         // pixels from the bay where it starts braking
    const PULL_AWAY_PX = 200;    // pixels it takes to get back up to speed

    // How far beyond the frame edge a car waits before driving in, and the
    // furthest out it is worth looking for that point.
    const CLEARANCE_M = 40;
    const MAX_ENTRY_M = 3000;

    // The longest approach worth watching, in pixels of screen.
    //
    // The arithmetic is fixed by the table: an hour every 1.1 s, a car plugged
    // in for thirteen of them, so about fourteen seconds from arrival to
    // departure. An approach of 1300 px at a followable speed eats all of it
    // and there is never a car standing at the charger - which is the thing
    // the layer is drawing a charger for. 780 px leaves half the stay parked.
    //
    // Where the road in is longer than this, the car joins it part way rather
    // than driving the whole thing, and fades in over a moment so it does not
    // pop into being.
    const MAX_APPROACH_PX = 780;
    const FADE_IN_MS = 450;

    // The street data ends at the edge of the surveyed campus, about a
    // kilometre of driving from the chargers - and a kilometre of road can
    // still loop around inside the frame. Past the last vertex the car carries
    // straight on along its final heading until it is genuinely off the table;
    // it has left the mapped area, which is exactly what leaving looks like.
    const OVERRUN_M = 1500;

    // And if the view cannot be read at all - a map with no getBounds - it
    // fades at the end of the overrun rather than blinking out.
    const FADE_MS = 500;

    // Parked cars stand beside the charger, not on top of its marker.
    const BAY_OFFSET_M = 7;

    // How far a charger has to move before its car's roads are found again.
    // Above the noise in a re-exported coordinate, below the length of a
    // parking bay.
    const MOVED_M = 3;

    // Choosing the road a charger is served by: how far out to look for one,
    // and how much road is enough to both drive in on and leave by. A charger
    // stands in a building now, so the nearest line can be a service way or a
    // footpath that leads nowhere.
    const SNAP_SEARCH_M = 140;
    const ROAD_ENOUGH_M = 500;      // road to come in on; more than this is no better
    const ROAD_LEAST_M = 150;       // road to leave by, below which it counts against
    // What a degree off the arrival corner is worth against a metre of road.
    const CORNER_WEIGHT_M = 4;
    // How far back along a road to look for where a car will appear. About the
    // approach the table has room for.
    const APPROACH_LOOK_M = 250;

    const palette = (typeof window !== 'undefined' && window.ECOM_PALETTE) || {};
    const CAR_COLOR = palette.charge_point || '#00ff5e';

    let active = false;
    // Hidden when the view has the charge points switched off - during the
    // introduction the charger has not been shown yet, and a car parked at a
    // marker nobody can see is a car parked in mid-air.
    let allowed = true;
    let streets = null;              // the street network, once fetched
    let graph = null;                // and the junction graph built from it
    let streetsPromise = null;
    let frame = null;

    // One entry per charge point, keyed by node id.
    const vehicles = new Map();

    // ------------------------------------------------------------ geometry

    /**
     * How many metres one screen pixel covers, at the map's current zoom.
     *
     * MapLibre serves 512 px tiles, hence the extra halving that the familiar
     * 156543/2^zoom formula leaves out. Read live rather than from the
     * calibration file, because a table can be zoomed after it is calibrated.
     */
    function metresPerPixel() {
        if (typeof map === 'undefined' || !map ||
            typeof map.getZoom !== 'function') return 0.6;
        const zoom = map.getZoom();
        const lat = (typeof map.getCenter === 'function' && map.getCenter())
            ? map.getCenter().lat : 57.69;
        return 156543.03392 * Math.cos(lat * Math.PI / 180) /
            Math.pow(2, zoom + 1);
    }

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

    /**
     * How fast the car is going, given how far it has come and how far is left.
     *
     * `remaining` is null on the way out, where there is no bay to stop at.
     */
    function speedAt(covered, remaining) {
        // Everything in metres here, converted from the screen at the zoom the
        // table is on right now.
        const scale = metresPerPixel();
        const cruise = CRUISE_PX * scale;
        const park = PARK_PX * scale;
        const slow = SLOW_PX * scale;
        const pullAway = PULL_AWAY_PX * scale;

        const pullingAway = covered < pullAway
            ? park + (cruise - park) * (covered / pullAway)
            : cruise;
        if (remaining === null) return pullingAway;
        const braking = remaining < slow
            ? park + (cruise - park) * (remaining / slow)
            : cruise;
        return Math.min(pullingAway, braking);
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

    // ------------------------------------------------------------- network

    /**
     * The street network as a graph: a node per junction, an edge per street.
     *
     * Built once, when the network loads, because a greedy walk cannot do this
     * job. Taking the straightest continuation at each junction dead-ends, and
     * a walk has no way to back out of one: the approach used to manage 286 m
     * of road and then cut 647 m straight across the campus to reach the edge
     * of the table, which is not a thing a car does. A search over the whole
     * network finds the way out whenever one exists.
     */
    function buildGraph(lines) {
        const buckets = new Map();
        const nodes = [];
        const edges = [];
        const edgeOfLine = new Map();

        // Junctions are drawn as separate street ends up to about 20 m apart in
        // this data, so endpoints within JOIN_M are one junction. A grid keyed
        // in metres keeps that lookup local rather than scanning every node.
        const cellKey = function (point, dx, dy) {
            const scale = metresPerDegree(point[1]);
            return (Math.floor(point[0] * scale.lon / JOIN_M) + dx) + ':' +
                   (Math.floor(point[1] * scale.lat / JOIN_M) + dy);
        };

        const lookup = function (point) {
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dy = -1; dy <= 1; dy += 1) {
                    const bucket = buckets.get(cellKey(point, dx, dy));
                    if (!bucket) continue;
                    for (let i = 0; i < bucket.length; i += 1) {
                        if (distance(nodes[bucket[i]], point) <= JOIN_M) {
                            return bucket[i];
                        }
                    }
                }
            }
            return -1;
        };

        const nodeAt = function (point) {
            const found = lookup(point);
            if (found !== -1) return found;
            const index = nodes.push(point) - 1;
            const key = cellKey(point, 0, 0);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(index);
            return index;
        };

        lines.forEach(function (line) {
            if (line.length < 2) return;
            const a = nodeAt(line[0]);
            const b = nodeAt(line[line.length - 1]);
            if (a === b) return;              // a street that returns to its own junction
            const index = edges.push({ a: a, b: b, coords: line,
                                       length: pathLength(line) }) - 1;
            edgeOfLine.set(line, index);
        });

        const from = nodes.map(function () { return []; });
        edges.forEach(function (edge, index) {
            from[edge.a].push(index);
            from[edge.b].push(index);
        });

        return { nodes: nodes, edges: edges, from: from,
                 locate: lookup, edgeOf: function (line) {
                     const index = edgeOfLine.get(line);
                     return index === undefined ? -1 : index;
                 } };
    }

    /**
     * The way out of the network from one junction, in road.
     *
     * Dijkstra, stopping at the first junction that is off the table - the
     * shortest way out rather than a wander. Where the network never leaves the
     * frame, it stops at the junction furthest from the charger and the caller
     * carries on from there.
     */
    function roadOut(startNode, bannedEdge, origin, preferred) {
        if (!graph || startNode < 0) return [];

        const best = new Map([[startNode, { cost: 0, edge: -1, prev: -1 }]]);
        const queue = [startNode];
        let farthest = { node: startNode,
                         gap: distance(origin, graph.nodes[startNode]) };
        let exit = -1;
        let exitScore = Infinity;

        while (queue.length) {
            // A few hundred junctions, so scanning for the cheapest is cheaper
            // than keeping a heap in order.
            let at = 0;
            for (let i = 1; i < queue.length; i += 1) {
                if (best.get(queue[i]).cost < best.get(queue[at]).cost) at = i;
            }
            const node = queue.splice(at, 1)[0];
            const here = best.get(node);
            if (here.cost > EXIT_M) break;

            if (node !== startNode && offFrame(graph.nodes[node])) {
                if (preferred === undefined) {
                    exit = node;
                    break;
                }
                // Asked for a side: keep looking, and take the way out that
                // best points that way without going miles about. Twenty
                // metres of extra road cancel a degree of aim, so a kilometre
                // of detour has to buy fifty degrees to be worth it - the
                // difference between arriving from the right and touring the
                // campus first.
                const off = angleBetween(bearing(origin, graph.nodes[node]), preferred);
                const score = off + here.cost / 4;
                if (score < exitScore) {
                    exitScore = score;
                    exit = node;
                }
                continue;
            }
            const gap = distance(origin, graph.nodes[node]);
            if (gap > farthest.gap) farthest = { node: node, gap: gap };

            graph.from[node].forEach(function (index) {
                if (index === bannedEdge) return;
                const edge = graph.edges[index];
                const next = edge.a === node ? edge.b : edge.a;
                const cost = here.cost + edge.length;
                const known = best.get(next);
                if (known && known.cost <= cost) return;
                best.set(next, { cost: cost, edge: index, prev: node });
                if (queue.indexOf(next) === -1) queue.push(next);
            });
        }

        const parts = [];
        let node = exit !== -1 ? exit : farthest.node;
        while (node !== startNode) {
            const step = best.get(node);
            if (!step || step.edge === -1) break;
            const edge = graph.edges[step.edge];
            parts.unshift(edge.a === step.prev
                ? edge.coords : edge.coords.slice().reverse());
            node = step.prev;
        }

        const out = [];
        parts.forEach(function (coords) {
            Array.prototype.push.apply(out, out.length ? coords.slice(1) : coords);
        });
        return out;
    }

    /**
     * Where a charge point sits on the network, and the road each way from it.
     *
     * The charger is placed on a street, so the nearest vertex of the nearest
     * line is its bay. The rest of that street each way gives the two
     * directions a car can come and go by; the search continues from whichever
     * junction each half ends at.
     */
    function routeFor(position, lines) {
        const candidates = [];
        lines.forEach(function (line) {
            let near = null;
            line.forEach(function (vertex, index) {
                const gap = distance(position, vertex);
                if (!near || gap < near.gap) near = { line: line, index: index, gap: gap };
            });
            if (near && near.gap <= SNAP_SEARCH_M) candidates.push(near);
        });
        if (!candidates.length) {
            // Nothing within reach: fall back to the nearest vertex anywhere,
            // which is what this did before there was anything to choose from.
            lines.forEach(function (line) {
                line.forEach(function (vertex, index) {
                    const gap = distance(position, vertex);
                    if (!candidates[0] || gap < candidates[0].gap) {
                        candidates[0] = { line: line, index: index, gap: gap };
                    }
                });
            });
        }
        if (!candidates.length) return null;
        candidates.sort(function (a, b) { return a.gap - b.gap; });

        const routeAt = function (near) {
            const walk = function (step) {
                const path = [];
                let i = near.index;
                while (i >= 0 && i < near.line.length) {
                    path.push(near.line[i]);
                    i += step;
                }
                return path;                   // ordered from the bay outwards
            };

            const half = function (part) {
                if (part.length < 2) return null;
                return { part: part,
                         node: graph ? graph.locate(part[part.length - 1]) : -1 };
            };

            const back = half(walk(-1));
            const forward = half(walk(1));
            // One way in and the other way out, so a car does not arrive and
            // leave along the same kerb. A charger on a dead end uses the one
            // it has.
            const entry = back || forward;
            const exit = forward || back;

            return {
                entry: entry,
                exit: exit,
                ownEdge: graph ? graph.edgeOf(near.line) : -1,
                ownLine: near.line,
                position: position,
                // The bay sits beside the road, offset across the direction of
                // travel so a parked car does not cover the charger's own
                // marker.
                bay: offsetBay(position, entry ? entry.part : [position])
            };
        };

        // The nearest line is not always the one to drive on. A charger inside
        // the P-hus is nearest a 126 m service way that joins nothing, and a
        // car given that one drove its 126 m and then covered the remaining
        // half kilometre in a straight line across the campus. So the nearest
        // road that actually leads off the table wins, and only if none does
        // is the nearest line used after all.
        //
        // Both ways are measured, not their total: a car comes in by one and
        // leaves by the other, and a road that is long one way and a stub the
        // other strands it at the end of the block.
        //
        // Among the roads that will do, the one whose far end lies nearest the
        // top right of the table wins, because that is the corner cars arrive
        // from and the room learns to look there. Reach decides which roads are
        // candidates at all; the corner decides between them.
        // Three things matter and none of them is decisive on its own, so they
        // are weighed rather than applied as thresholds: how much road there is
        // to drive in on, whether that road runs towards the corner of the
        // table cars arrive from, and how far the charger is from it. A cliff
        // in any one of them picked a different road for each table window -
        // in one view a 900 m way out with a 182 m way in, so the car appeared
        // mid-table, on the wrong side.
        const aim = screenTopRight();
        let best = null;
        for (let i = 0; i < candidates.length && i < 16; i += 1) {
            const route = routeAt(candidates[i]);
            const ways = [roadFrom(route, 'entry'), roadFrom(route, 'exit')];
            // Measured where the car will actually come into view, not at the
            // far end of the road: the approach is capped at a few hundred
            // metres, and a road that ends up at the right corner can spend its
            // first stretch curling the other way - which is the half the room
            // sees.
            const angles = ways.map(function (way) {
                const seen = alongPath(way, Math.min(pathLength(way), APPROACH_LOOK_M));
                return angleBetween(bearing(position, seen.point), aim);
            });
            // The car comes in by whichever way runs towards that corner, and
            // leaves by the other.
            const inBy = angles[0] <= angles[1] ? 0 : 1;
            const comingIn = Math.min(pathLength(ways[inBy]), ROAD_ENOUGH_M);
            const goingOut = pathLength(ways[1 - inBy]);
            const score = comingIn
                - CORNER_WEIGHT_M * angles[inBy]
                - (goingOut < ROAD_LEAST_M ? ROAD_LEAST_M - goingOut : 0)
                - candidates[i].gap;
            if (!best || score > best.score) best = { route: route, score: score };
        }
        return best ? best.route : routeAt(candidates[0]);
    }

    /**
     * Carry a path on across junctions, taking the straightest continuation.
     *
     * This is how the departure has always been built and it reads well, so it
     * stays that way. It cannot do the job in the other direction - a greedy
     * walk dead-ends and has no way to back out of one, which is why the
     * approach searches the network instead - but on the way out a car that
     * simply keeps going straight at each junction is exactly right.
     */
    function continueOn(path, lines, firstLine, origin) {
        const out = path.slice();
        let last = firstLine;
        // The street it set off along counts as driven; without it the search
        // turns round at the first junction and drives back to the charger.
        const used = firstLine ? [firstLine] : [];
        let total = pathLength(out);

        while (total < EXIT_M) {
            const tip = out[out.length - 1];
            const heading = out.length > 1 ? bearing(out[out.length - 2], tip) : null;
            const reached = distance(origin, tip);
            let best = null;

            lines.forEach(function (line) {
                if (line.length < 2 || used.indexOf(line) !== -1) return;
                const fromHead = distance(tip, line[0]);
                const fromTail = distance(tip, line[line.length - 1]);
                const gap = Math.min(fromHead, fromTail);
                if (gap > JOIN_M) return;

                const coords = fromHead <= fromTail ? line : line.slice().reverse();

                // Never a street that ends up nearer the charger than the car
                // already is: without this the chain wandered the campus loop
                // and drove home past the charger it had just left.
                if (distance(origin, coords[coords.length - 1]) <= reached) return;

                let turn = 0;
                if (heading !== null) {
                    turn = Math.abs(
                        ((bearing(tip, coords[1]) - heading + 540) % 360) - 180);
                    if (turn > TURN_LIMIT_DEG) return;   // that is the way it came
                }
                // The straightest continuation, not the closest join: at a
                // junction a car carries on rather than taking whichever kerb
                // happens to be nearest.
                if (!best || turn < best.turn) {
                    best = { turn: turn, coords: coords, line: line };
                }
            });

            if (!best) break;                 // the road really does end here
            // The original, not the reversed copy: identity is what marks a
            // street as driven, and a reversed copy is a different array.
            used.push(best.line);
            last = best.line;
            Array.prototype.push.apply(out, best.coords.slice(1));
            total = pathLength(out);
        }
        return { path: out, lastLine: last };
    }

    /**
     * The full road one way out of a bay, found now rather than when the route
     * was built: it depends on where the frame edge currently is, and the table
     * can be recalibrated under a running layer.
     *
     * The two directions are found differently on purpose. Leaving, the car
     * carries straight on across junctions and off the table, which is what it
     * did before any of this and what it should keep doing. Arriving, it has to
     * come in from beyond the frame, and only a search over the network can
     * find a way in that stays on the road the whole distance.
     */
    function roadFrom(route, side) {
        const half = route[side] || route.entry || route.exit;
        if (!half) return [route.position];

        const path = [route.position].concat(half.part.slice(1));

        if (side === 'exit') {
            return continueOn(path, streets || [], route.ownLine, route.position).path;
        }

        const onward = half.node >= 0
            ? roadOut(half.node, route.ownEdge, route.position) : [];
        if (onward.length > 1) {
            Array.prototype.push.apply(path, onward.slice(1));
        }
        return path;
    }

    /** A point `metres` along `heading` from `origin`. */
    function project(origin, heading, metres) {
        const radians = heading * Math.PI / 180;
        const scale = metresPerDegree(origin[1]);
        return [
            origin[0] + (Math.sin(radians) * metres) / scale.lon,
            origin[1] + (Math.cos(radians) * metres) / scale.lat
        ];
    }

    /**
     * The way in: the way out, driven backwards.
     *
     * Not a route of its own. The departure carries straight on at each
     * junction and off the table, and that movement reads well, so the arrival
     * is the same road in reverse - the car comes in by the road it will later
     * leave by. A separate route in the other direction was tried and was
     * wrong twice over: as a greedy chain it dead-ended after 286 m and cut
     * the remaining 647 m straight across the campus, and as a network search
     * it found a way in that was on the road the whole way but 1232 m long and
     * nothing like the way out.
     *
     * The street chain stops at the edge of the surveyed campus, which can
     * still be inside the view; where it does, the path carries on radially
     * until it is off the table, so the car drives in from beyond the edge
     * rather than appearing on a road in the middle of the scene.
     */
    function entryPath(route) {
        // In from the top right of the table. Both halves of the charger's own
        // street are tried and the one that gets out nearest that corner wins,
        // so the car arrives from where the room expects rather than from
        // wherever the network happens to end first.
        const aim = screenTopRight();
        let chain = null;
        let chainScore = Infinity;

        [route.entry, route.exit].forEach(function (half, index) {
            if (!half) return;
            // The searched way out, not the greedy one the departure uses.
            // Carrying straight on at junctions is right for leaving - it is
            // never seen for long - but as a way in it wanders: 1.6 km of road
            // to cover 600 m of screen, most of a night's parking spent
            // driving. The search takes the short well-aimed road instead.
            const path = [route.position].concat(half.part.slice(1));
            if (graph && half.node >= 0) {
                const onward = roadOut(half.node, route.ownEdge,
                                       route.position, aim);
                if (onward.length > 1) {
                    Array.prototype.push.apply(path, onward.slice(1));
                }
            }

            // Aimed by where the car will be seen, not by where the road ends.
            // The approach is cut to the last stretch before the charger, so a
            // road that ends up at the right corner but leaves the car park the
            // other way brings the car in from the wrong side of the room.
            const length = pathLength(path);
            const ceiling = MAX_APPROACH_PX * metresPerPixel();
            const seen = alongPath(path, Math.min(length, ceiling));

            // Length still matters. The table shows an hour every 1.1 s and the
            // car is only plugged in for thirteen of them - about fourteen
            // seconds - so an approach of much over half a kilometre uses the
            // whole stay and there is never a car standing at the charger. Four
            // metres of road cost a degree of aim. And a road too short to
            // reach the edge of the table leaves the car appearing in the
            // middle of the scene, which costs the same way.
            const score = angleBetween(bearing(route.bay.point, seen.point), aim) +
                Math.min(length, ceiling) / 4 +
                Math.max(0, ceiling - length) / 4;
            if (score < chainScore) {
                chainScore = score;
                chain = path;
                // Remembered so the departure can take the other half and the
                // car drives through the bay rather than backing out of it.
                route.cameBy = index === 0 ? 'entry' : 'exit';
            }
        });

        if (!chain) return [route.position, route.bay.point];

        // Cut at the first vertex that is off the table. The road out can run
        // for another kilometre beyond the edge, and driving that stretch is
        // time spent off-stage: the car would still be arriving hours after it
        // was due at the charger. offFrame already allows a margin, so the
        // first point past it is comfortably out of sight.
        for (let i = 0; i < chain.length; i += 1) {
            if (offFrame(chain[i])) {
                chain = chain.slice(0, i + 1);
                break;
            }
        }

        // Trimmed to the last stretch before the charger when the road in is
        // longer than there is time for. The chain runs bay-first, so this
        // keeps the head of it and drops the far tail.
        const ceiling = MAX_APPROACH_PX * metresPerPixel();
        let capped = false;
        let along = 0;
        for (let i = 1; i < chain.length; i += 1) {
            along += distance(chain[i - 1], chain[i]);
            if (along > ceiling) {
                chain = chain.slice(0, i + 1);
                capped = true;
                break;
            }
        }

        const far = chain[chain.length - 1];
        const heading = chain.length > 1
            ? bearing(route.bay.point, far) : 0;

        // Only when the road itself stops short of the frame. A capped
        // approach is meant to begin part way along, in view and fading in;
        // carrying it back out to the edge in a straight line would undo both
        // the cap and the promise that the car stays on streets.
        if (!capped) {
            let extra = 0;
            while (extra < MAX_ENTRY_M && !offFrame(project(far, heading, extra))) {
                extra += 60;
            }
            if (extra > 0) chain.push(project(far, heading, extra + CLEARANCE_M));
        }

        // Ending at the bay rather than at the charger itself, so the car rolls
        // into its space instead of reaching the marker and then jumping the
        // few metres sideways to park.
        return chain.reverse().concat([route.bay.point]);
    }

    /**
     * The compass direction of the top right corner of the table.
     *
     * The map is rotated to face the room - a bearing of about -93 degrees on
     * this table - so the corner a car is asked to come in from is not any
     * compass direction anyone would name. Up the screen is the map's bearing
     * and right of it is that plus 90, so the corner between them is plus 45.
     * Recalibrate the table and this follows it.
     */
    function screenTopRight() {
        const bearing = (typeof map !== 'undefined' && map &&
                         typeof map.getBearing === 'function') ? map.getBearing() : 0;
        return ((bearing + 45) % 360 + 360) % 360;
    }

    /** How far apart two compass directions are, 0 to 180. */
    function angleBetween(a, b) {
        return Math.abs(((a - b + 540) % 360) - 180);
    }

    /** Whether a point has left the table view, with a margin so it clears it. */
    function offFrame(point) {
        if (typeof map === 'undefined' || !map ||
            typeof map.getBounds !== 'function') return false;
        const bounds = map.getBounds();
        if (!bounds) return false;
        const west = bounds.getWest(), east = bounds.getEast();
        const south = bounds.getSouth(), north = bounds.getNorth();
        // Just past the edge. A generous margin used to cost the arrival a
        // couple of hundred metres of driving nobody can see, which at the
        // slower speed is a second and a half of a stay that is only about
        // twelve seconds long.
        const padLon = (east - west) * 0.03;
        const padLat = (north - south) * 0.03;
        return point[0] < west - padLon || point[0] > east + padLon ||
               point[1] < south - padLat || point[1] > north + padLat;
    }

    function offsetBay(position, entry) {
        // `entry` runs outward from the bay, so the direction a car faces on
        // arrival is the reverse of its first step.
        if (entry.length < 2) return { point: position, heading: 0 };
        const approach = bearing(entry[1], position);
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

    // Half as big again as it was, drawn at three times the resolution and lit
    // like the rest of the layer. At the old 28px and 0.85 the car was about
    // fourteen metres of campus in a dark body colour: on the projector it was
    // a speck you had to already know about to follow across a street.
    const CAR_SCALE = 3;
    const CAR_GROW = 1.55;

    /** A small car, drawn once and handed to MapLibre as an image. */
    function makeCarIcon() {
        const size = 46;
        const canvas = document.createElement('canvas');
        canvas.width = size * CAR_SCALE;
        canvas.height = size * CAR_SCALE;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.scale(CAR_SCALE, CAR_SCALE);
        // Pointing up: icon-rotate turns it to the heading.
        ctx.translate(size / 2, size / 2);
        ctx.scale(CAR_GROW, CAR_GROW);

        const body = function () {
            ctx.beginPath();
            ctx.moveTo(-4.5, -9);
            ctx.lineTo(4.5, -9);
            ctx.lineTo(6, -2);
            ctx.lineTo(6, 8);
            ctx.lineTo(-6, 8);
            ctx.lineTo(-6, -2);
            ctx.closePath();
        };

        // A dark keyline first, so it still reads on a pale basemap.
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 2.4;
        body();
        ctx.stroke();

        ctx.shadowColor = CAR_COLOR;
        ctx.shadowBlur = 5 * CAR_SCALE;
        ctx.fillStyle = CAR_COLOR;
        body();
        ctx.fill();
        ctx.shadowBlur = 0;

        // Windscreen, so the car has a front at a glance.
        ctx.fillStyle = 'rgba(0, 20, 8, 0.55)';
        ctx.beginPath();
        ctx.moveTo(-3.5, -7.5);
        ctx.lineTo(3.5, -7.5);
        ctx.lineTo(4.5, -3);
        ctx.lineTo(-4.5, -3);
        ctx.closePath();
        ctx.fill();

        return ctx.getImageData(0, 0, size * CAR_SCALE, size * CAR_SCALE);
    }

    function ensureLayer() {
        if (typeof map === 'undefined' || !map) return false;

        if (!map.hasImage(ICON_ID)) {
            const image = makeCarIcon();
            if (image) map.addImage(ICON_ID, image, { pixelRatio: CAR_SCALE });
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
                    'icon-size': 1,
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
            const seconds = step(vehicle, now);

            if (vehicle.state === 'arriving') {
                const remaining = vehicle.pathLength - vehicle.covered;
                vehicle.covered += speedAt(vehicle.covered, remaining) * seconds;
                vehicle.at = alongPath(vehicle.path,
                                       Math.min(vehicle.covered, vehicle.pathLength));
                // Fades up if it started inside the frame; already invisible
                // off the edge, so this costs nothing when it is not needed.
                vehicle.opacity = offFrame(vehicle.path[0]) ? 1
                    : Math.min(1, (now - vehicle.fadeInAt) / FADE_IN_MS);
                if (vehicle.covered >= vehicle.pathLength) {
                    vehicle.state = 'parked';
                    vehicle.at = vehicle.route.bay;
                    // It may already be due to leave.
                    settle(vehicle);
                    if (vehicle.state !== 'parked') moving = true;
                } else {
                    moving = true;
                }
            } else if (vehicle.state === 'leaving') {
                // Distance, not a duration: it drives at a steady speed until it
                // is off the table or out of road, however far away that is.
                const path = vehicle.path;
                const total = vehicle.pathLength;
                // No bay ahead, so nothing to brake for: it pulls away and goes.
                vehicle.covered += speedAt(vehicle.covered, null) * seconds;
                const covered = vehicle.covered;

                if (covered <= total) {
                    vehicle.at = alongPath(path, covered);
                } else {
                    // Off the end of the mapped streets: straight on, away from
                    // the charger. Radially rather than along the last kerb, so
                    // a road that happens to end on a bend still takes the car
                    // out of the frame instead of back across it.
                    const last = path[path.length - 1];
                    const heading = bearing(vehicle.route.bay.point, last);
                    vehicle.at = { point: project(last, heading, covered - total),
                                   heading: heading };
                }
                vehicle.opacity = 1;

                if (offFrame(vehicle.at.point)) {
                    vehicle.state = 'away';
                    vehicle.at = null;
                    settle(vehicle);
                    if (vehicle.state !== 'away') moving = true;
                } else if (covered >= total + OVERRUN_M) {
                    // Nothing has told us it is off screen and it has driven a
                    // kilometre and a half past the last road. Bow out.
                    vehicle.state = 'fading';
                    vehicle.startedAt = now;
                    moving = true;
                } else {
                    moving = true;
                }
            } else if (vehicle.state === 'fading') {
                const done = Math.min(1, (now - vehicle.startedAt) / FADE_MS);
                vehicle.opacity = 1 - done;
                if (done >= 1) {
                    vehicle.state = 'away';
                    vehicle.at = null;
                    settle(vehicle);
                    if (vehicle.state !== 'away') moving = true;
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

    /**
     * Seconds since this vehicle last moved.
     *
     * Capped, because a table whose window has been behind another runs no
     * animation frames at all: the first frame back would otherwise carry a
     * gap of minutes and teleport the car to the end of its route.
     */
    function step(vehicle, now) {
        const last = vehicle.steppedAt || now;
        vehicle.steppedAt = now;
        return Math.max(0, Math.min(0.1, (now - last) / 1000));
    }

    /**
     * Act on the schedule, but only from a standstill.
     *
     * A drive takes several seconds and the table turns an hour every 1.1, so
     * the schedule can easily change while a car is halfway down a street. It
     * used to act immediately: the car vanished from wherever it had got to and
     * reappeared at the charger, because a departure begins at the bay. Now an
     * arriving car finishes arriving and a leaving car finishes leaving, and
     * the intention is acted on when it gets there. Nothing ever teleports.
     */
    function settle(vehicle) {
        if (vehicle.wants === 'here' && vehicle.state === 'away') {
            start(vehicle, 'arriving');
        } else if (vehicle.wants === 'gone' && vehicle.state === 'parked') {
            start(vehicle, 'leaving');
        }
    }

    // Placed at the head of its path as the state changes, rather than left
    // without a position until the first animation frame: a frame can be a
    // while coming - a table whose window is not in front runs no frames at all
    // - and until then the car would be travelling and drawn nowhere.
    function start(vehicle, state) {
        // The way in is built now rather than with the route, because it
        // depends on where the frame edge currently is - the table can be
        // recalibrated, and a car should still come in from off it.
        // Faded in only when it has to join the road part way. Coming in from
        // beyond the frame edge there is nothing to hide.
        vehicle.fadeInAt = state === 'arriving' ? performance.now() : 0;
        vehicle.path = state === 'arriving'
            ? entryPath(vehicle.route)
            // Out of the bay, not out of the charger: it leaves from where it
            // was actually standing - and by the other half of the road from
            // the one it came in on, so it drives through rather than reversing
            // back out the way it arrived.
            : [vehicle.route.bay.point].concat(
                roadFrom(vehicle.route,
                         vehicle.route.cameBy === 'exit' ? 'entry' : 'exit'));
        vehicle.pathLength = pathLength(vehicle.path);
        vehicle.covered = 0;
        vehicle.steppedAt = performance.now();
        vehicle.state = state;
        vehicle.startedAt = vehicle.steppedAt;
        vehicle.at = alongPath(vehicle.path, 0);
        // Transparent from the very first draw when it is joining the road in
        // view, not just from the first animation frame: a frame can be a while
        // coming, and one frame at full opacity is the pop this avoids.
        vehicle.opacity = (state === 'arriving' && !offFrame(vehicle.path[0]))
            ? 0 : 1;
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
            // A charger that has moved - dragged along its building on the
            // panel, or moved in the definition - needs its roads found again.
            // Kept by id alone, a car went on driving to where the charger used
            // to be and parked in the street it had left.
            const moved = vehicle &&
                distance(vehicle.route.position, [point.lon, point.lat]) > MOVED_M;
            if (!vehicle || moved) {
                const route = routeFor([point.lon, point.lat], streets);
                if (!route) return;
                if (moved) {
                    // Off the table and back in by the new road, rather than
                    // sliding across the campus from the old bay to the new one.
                    vehicle.route = route;
                    vehicle.state = 'away';
                    vehicle.at = null;
                    vehicle.path = null;
                    vehicle.pathLength = 0;
                } else {
                    vehicle = { id: point.id, name: point.name, route: route,
                                state: 'away', at: null, opacity: 1, charging: false,
                                wants: 'gone' };
                    vehicles.set(point.id, vehicle);
                }
            }
            vehicle.charging = !!point.charging;

            // What the schedule wants of it, which is not the same as what it
            // can do this instant.
            vehicle.wants = point.plugged ? 'here' : 'gone';
            settle(vehicle);
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
                graph = buildGraph(streets);
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
        allowed = true;
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

        if (data.type === 'ecom_filters') {
            const kinds = (data.filters && data.filters.kinds) || null;
            const shown = !kinds || kinds.indexOf('charge_point') !== -1;
            if (shown !== allowed) {
                allowed = shown;
                if (!allowed) {
                    vehicles.clear();
                    draw();
                } else if (active) {
                    // Ask where they should be: the day clock may be stopped.
                    channel.postMessage({ type: 'ecom_vehicles_request' });
                }
            }
            return;
        }

        if (data.type === 'ecom_vehicles') {
            if (!active || !allowed) return;
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
                           exitMetres: Math.round(pathLength(roadFrom(vehicle.route, 'exit'))),
                           entryMetres: Math.round(pathLength(roadFrom(vehicle.route, 'entry'))),
                           driveMetres: Math.round(vehicle.pathLength || 0),
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
