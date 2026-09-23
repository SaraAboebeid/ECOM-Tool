"""Turn a dispatch result into the three GeoJSON layers the MR table draws.

This was the body of scripts/export_mr_layer.py, which wrote the files once and
offline. It lives here now because the table's controller can move a slider and
needs the layer rebuilt inside the request - the same transform on the same
footprints, so a live rebuild and a committed export cannot drift apart.

The join is the awkward part. Footprints are keyed by slug ('ca-huset') and the
dispatch by display name ('CA-Huset', 'Fysik origo'), so the two are matched on
the same canonical key the frontend uses - case, accents and punctuation folded
away. Exact matching drops buildings silently, which is how Bibliotek went
missing from the viewer once already.
"""
from __future__ import annotations

import heapq
import json
import math
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[3]
# The outlines the table draws: the MR Studio's own buildings (Lantmäteriet),
# under the dashboard's ids. Not public/buildings.geojson directly - that is the
# Rhino model, which builds a hall out of pieces, and the table strokes every
# piece's edge as a line across the roof. scripts/build_table_footprints.py
# makes this file from both; rerun it when either changes.
FOOTPRINTS = DASHBOARD / "backend" / "data" / "table_footprints.geojson"

# The same street network the table draws under everything else. Flows follow
# it because that is where a cable goes: under the road, not through the middle
# of a lecture hall. Bending an L-shaped route around the halls was tried first
# and cannot work here - the campus is dense enough that of forty-one flows only
# seventeen could find a clear elbow, however finely the bend was swept.
STREETS = DASHBOARD.parent / "MR-Table" / "media" / "street-network.geojson"

# How close two street vertices must be to count as the same junction. The
# survey draws some junctions as separate ends a few metres apart.
JOIN_M = 20.0

# What a street segment costs when it runs through a building.
#
# Three per cent of the surveyed segments do - a path clipped across a
# courtyard, a footprint drawn a little over its kerb - and they were the
# source of forty-seven of the forty-nine building crossings left after the
# flows were put on the roads. Priced as a two kilometre detour: far more than
# any route across this campus, so they are taken only when there is genuinely
# no other way through.
BLOCKED_EDGE_PENALTY_M = 2000.0

# How many junctions to try at each end before giving up on the streets.
# Six covers a node whose closest joins are all on the same disconnected
# stub, without turning a failed route into a search of the whole campus.
JOIN_TRIES = 6

# Further than this from any street and a node is not on the network at all -
# the grid tie, say, before it was given a real position. Those fall back to
# the elbow rather than being dragged to a road they are nowhere near.
SNAP_LIMIT_M = 250.0

# The grid connection, the community battery and the charge point have no
# location: they are community-scale assets that belong to no member, and the
# 2D viewer places them by hand in its own image frame, which means nothing on a
# map. They are put at the middle of the community instead - the mean of the
# member centroids - so the flows radiate from the centre of the campus rather
# than dragging every line off to one corner. Computed rather than fixed, so it
# follows the membership if that changes.
ANCHOR_SPREAD_DEG = 0.00022

# Flow lines are elbowed, not straight, matching buildStructuredPath in
# Dashboard/src/components/Graph/GraphLinks.tsx. The bends are laid out in the
# campus frame rather than along north: the Rhino model is turned 18.84 deg, so
# the building rows run at that angle and elbows squared to true north would
# cut across them diagonally - which is the thing the elbow is there to avoid.
CAMPUS_ROTATION_DEG = 18.838776

# Mirrors src/utils/canonicalName.ts. Kept in step by hand; the alias list is
# two entries and has not changed since the Rhino layers were named.
ALIASES = {
    "elkrafteknik": "elkraftteknik",
    "bibiotek": "bibliotek",
}


def canonical(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value)
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    folded = re.sub(r"[^a-z0-9]", "", folded.lower())
    return ALIASES.get(folded, folded)


def _hash(value: str) -> int:
    """Same rolling hash the viewer uses, so a link bends the same way in both."""
    h = 0
    for ch in value:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return abs(h)


def _metres(a, b) -> float:
    """Distance in metres between two lon/lat points, near enough at campus size."""
    lon_scale = 111320.0 * math.cos(math.radians((a[1] + b[1]) / 2.0))
    return math.hypot((b[0] - a[0]) * lon_scale, (b[1] - a[1]) * 110540.0)


@lru_cache(maxsize=1)
def _street_graph():
    """The street network as junctions and the runs between them.

    Every vertex is a node, not just the ends of each drawn line: a flow has to
    be able to join and leave the network anywhere, and a route that could only
    turn at block corners would cut across whatever lies between them.
    """
    if not STREETS.is_file():
        return None

    geo = json.loads(STREETS.read_text(encoding="utf-8"))
    points: list = []
    adjacency: dict = {}
    buckets: dict = {}

    # The buildings the streets have to be judged against. Every footprint,
    # not only the members: a line through a hall looks wrong whether or not
    # that hall is in the scheme.
    try:
        boxes = _ring_boxes(
            [ring for group in _footprint_rings(load_footprints()).values()
             for ring in group])
    except Exception:
        boxes = []

    # A grid a little coarser than the join tolerance, so a lookup only has to
    # check the nine cells around a point rather than every node so far.
    cell = JOIN_M * 1.5

    def cell_of(point):
        lon_scale = 111320.0 * math.cos(math.radians(point[1]))
        return (int(point[0] * lon_scale // cell), int(point[1] * 110540.0 // cell))

    def node_at(point) -> int:
        cx, cy = cell_of(point)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for index in buckets.get((cx + dx, cy + dy), ()):  # noqa: B007
                    if _metres(points[index], point) <= JOIN_M:
                        return index
        index = len(points)
        points.append((point[0], point[1]))
        buckets.setdefault((cx, cy), []).append(index)
        adjacency[index] = []
        return index

    def add_line(coords):
        previous = None
        for raw in coords:
            current = node_at(raw)
            if previous is not None and previous != current:
                weight = _metres(points[previous], points[current])
                if boxes and _segment_blocked(points[previous], points[current],
                                              boxes):
                    weight += BLOCKED_EDGE_PENALTY_M
                adjacency[previous].append((current, weight))
                adjacency[current].append((previous, weight))
            previous = current

    for feature in geo.get("features", []):
        geometry = feature.get("geometry") or {}
        kind = geometry.get("type")
        if kind == "LineString":
            add_line(geometry["coordinates"])
        elif kind == "MultiLineString":
            for part in geometry["coordinates"]:
                add_line(part)

    return {"points": points, "adjacency": adjacency, "buckets": buckets,
            "cell": cell}


def _nearest_street_node(graph, point, obstacles=(), want_all=False):
    """Where to join the network from a point.

    The nearest node is not always the right one. A building's centre is
    several metres inside it, and the closest road may be on the far side of a
    neighbour - so the straight stub joining them cuts through that neighbour,
    which is exactly what routing along streets was meant to stop. Candidates
    are taken in order of distance and the first with a clear stub wins; if
    none is clear, the closest is used, because a line that has to cross
    something is still better than no line.

    With want_all the whole ranked list comes back instead of the winner. The
    nearest junction is not always one you can get anywhere from: the battery
    in AWL joins a service drive seventeen metres away that connects to nothing
    else, so the search for a route failed and its lines fell back to a
    diagonal across the campus - which on the table crossed three buildings and
    looked nothing like the lines around it.
    """
    lon_scale = 111320.0 * math.cos(math.radians(point[1]))
    cell = graph["cell"]
    cx, cy = int(point[0] * lon_scale // cell), int(point[1] * 110540.0 // cell)

    candidates = []
    reach = max(1, int(SNAP_LIMIT_M / cell) + 1)
    for radius in range(reach + 1):
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                if max(abs(dx), abs(dy)) != radius:
                    continue
                for index in graph["buckets"].get((cx + dx, cy + dy), ()):
                    gap = _metres(graph["points"][index], point)
                    if gap <= SNAP_LIMIT_M:
                        candidates.append((gap, index))
        # One ring past the first hits, so a slightly further but clear join is
        # still in the running.
        if candidates and radius >= 2:
            break

    if not candidates:
        return None
    candidates.sort()

    ranked = [index for _, index in candidates]
    if obstacles:
        clear = [index for index in ranked[:12]
                 if _route_hits([list(point), list(graph["points"][index])],
                                obstacles) == 0]
        ranked = clear + [index for index in ranked if index not in clear]
    return ranked if want_all else ranked[0]


def street_route(a, b, obstacles=()):
    """The shortest way along the streets from a to b, or None.

    The two ends are joined to the network by a straight run from the node's own
    position to the nearest street: a cable leaves the building it serves, and
    that stub crosses only the building it belongs to.
    """
    graph = _street_graph()
    if not graph or not graph["points"]:
        return None

    starts = _nearest_street_node(graph, a, obstacles, want_all=True) or []
    goals = _nearest_street_node(graph, b, obstacles, want_all=True) or []
    if not starts or not goals:
        return None

    # A junction on a stub that joins nothing is no use however close it is,
    # so the nearest pair that can actually reach each other wins. The usual
    # case still takes the first pair and stops.
    for start in starts[:JOIN_TRIES]:
        for goal in goals[:JOIN_TRIES]:
            if start == goal:
                continue
            route = _walk(graph, a, b, start, goal)
            if route is not None:
                return route
    return None


def _walk(graph, a, b, start, goal):
    """The shortest way between two junctions, joined to a and b at the ends."""
    adjacency = graph["adjacency"]
    seen = {start: 0.0}
    previous: dict = {}
    queue = [(0.0, start)]
    found = False
    while queue:
        cost, node = heapq.heappop(queue)
        if node == goal:
            found = True
            break
        if cost > seen.get(node, math.inf):
            continue
        for neighbour, weight in adjacency[node]:
            through = cost + weight
            if through < seen.get(neighbour, math.inf):
                seen[neighbour] = through
                previous[neighbour] = node
                heapq.heappush(queue, (through, neighbour))

    if not found:
        return None

    path = [goal]
    while path[-1] != start:
        path.append(previous[path[-1]])
    path.reverse()

    points = [list(a)] + [list(graph["points"][i]) for i in path] + [list(b)]

    # Drop points that repeat, which the joins at either end can produce.
    trimmed = [points[0]]
    for point in points[1:]:
        if _metres(trimmed[-1], point) > 0.5:
            trimmed.append(point)
    return trimmed if len(trimmed) > 2 else None


def _rings_of(feature) -> list:
    """Every closed ring of a footprint, however it is nested."""
    geometry = feature.get("geometry") or {}
    kind = geometry.get("type")
    if kind == "Polygon":
        return list(geometry["coordinates"])
    if kind == "MultiPolygon":
        return [ring for polygon in geometry["coordinates"] for ring in polygon]
    return []


def _footprint_rings(geo: dict) -> dict:
    """Footprint outlines by canonical id, for the router to steer around."""
    rings = {}
    for feature in geo["features"]:
        key = canonical(feature["properties"].get("id", ""))
        if not key:
            continue
        rings.setdefault(key, []).extend(_rings_of(feature))
    return rings


def _side(p, q, r) -> float:
    """Which side of pq the point r falls on."""
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def _crosses(p1, p2, p3, p4) -> bool:
    """Whether segment p1p2 crosses segment p3p4."""
    d1 = _side(p3, p4, p1)
    d2 = _side(p3, p4, p2)
    d3 = _side(p1, p2, p3)
    d4 = _side(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def _ring_boxes(rings) -> list:
    """Rings with their bounding boxes, so most can be skipped outright."""
    boxes = []
    for ring in rings:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        boxes.append((min(xs), min(ys), max(xs), max(ys), ring))
    return boxes


def _segment_blocked(p1, p2, boxes) -> bool:
    """Whether one segment cuts through any of the boxed rings."""
    lo_x, hi_x = (p1[0], p2[0]) if p1[0] <= p2[0] else (p2[0], p1[0])
    lo_y, hi_y = (p1[1], p2[1]) if p1[1] <= p2[1] else (p2[1], p1[1])
    for min_x, min_y, max_x, max_y, ring in boxes:
        if max_x < lo_x or min_x > hi_x or max_y < lo_y or min_y > hi_y:
            continue
        for i in range(len(ring) - 1):
            if _crosses(p1, p2, ring[i], ring[i + 1]):
                return True
    return False


def _route_hits(points, rings) -> int:
    """How many of these outlines the route cuts through.

    Counted per building rather than per crossing: a line clipping one corner
    of a hall is one problem, not two, and the router should not prefer a route
    that slices three buildings once each over one that clips a single building
    twice.
    """
    hits = 0
    for ring in rings:
        for i in range(len(points) - 1):
            p1, p2 = points[i], points[i + 1]
            crossed = False
            for j in range(len(ring) - 1):
                if _crosses(p1, p2, ring[j], ring[j + 1]):
                    crossed = True
                    break
            if crossed:
                hits += 1
                break
    return hits


def elbow(a, b, key: str, obstacles=()):
    """Right-angled route from a to b, in the campus frame.

    Mirrors buildStructuredPath: the bend is offset by a hash of the link so
    parallel runs between the same pair of areas do not lie on top of one
    another, and the leg order flips with the dominant axis.

    `obstacles` are footprint rings the route should keep out of. Energy does
    not run through the middle of a lecture hall, and on a projection table a
    line crossing a lit building reads as belonging to that building. The
    original route is tried first and kept when it is clear, so a picture that
    was already right does not move; otherwise the bend is walked out to either
    side and the leg order flipped, and whichever candidate crosses fewest
    buildings wins. Ties go to the least-moved route, which keeps the fan of
    parallel runs that the hash offset exists to create.

    Nothing here is a general path finder. It cannot route around a building
    that sits squarely between two others, and when every candidate is blocked
    it takes the least bad one rather than inventing a detour - a wrong-looking
    line is better than a line that wanders somewhere no cable would go.
    """
    angle = math.radians(CAMPUS_ROTATION_DEG)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    # Latitude scaling, so a degree east and a degree north are comparable
    # before the rotation; without it the bend lands in the wrong place.
    lat_scale = math.cos(math.radians((a[1] + b[1]) / 2.0))

    def to_frame(point):
        x = (point[0] - a[0]) * lat_scale
        y = point[1] - a[1]
        return (x * cos_a + y * sin_a, -x * sin_a + y * cos_a)

    def to_lonlat(point):
        x, y = point
        gx = x * cos_a - y * sin_a
        gy = x * sin_a + y * cos_a
        return [a[0] + gx / lat_scale, a[1] + gy]

    start = to_frame(a)
    end = to_frame(b)
    dx = end[0] - start[0]
    dy = end[1] - start[1]

    route_hash = _hash(key)
    # 14-38 px in the viewer, expressed here as a fraction of a degree at the
    # same visual weight for this campus.
    bend = (14 + (route_hash % 4) * 8) * 1.1e-6
    sign = 1 if route_hash % 2 == 0 else -1
    x_first = abs(dx) >= abs(dy) or route_hash % 3 == 0

    def route(first_x: bool, offset: float):
        if first_x:
            via_x = start[0] + dx * 0.5 + offset
            return [start, (via_x, start[1]), (via_x, end[1]), end]
        via_y = start[1] + dy * 0.5 + offset
        return [start, (start[0], via_y), (end[0], via_y), end]

    original = sign * bend
    if not obstacles:
        return [to_lonlat(p) for p in route(x_first, original)]

    # The route as it would have been, then the bend walked out to either side
    # in small increments. Twelve candidates found a clear line for sixteen of
    # the campus's forty-one flows; the campus is dense enough that the gaps
    # between halls are narrow, and finding one needs a fine sweep rather than
    # a few big steps. A degree of longitude is about 60 km here, so this
    # considers every offset out to roughly 170 m either way, in 6 m steps.
    steps = [original]
    for extra in (1, 2, 3, 4, 6, 8):
        for direction in (sign, -sign):
            steps.append(direction * (bend + extra * 22 * 1.1e-6))

    best = None
    for first_x in (x_first, not x_first):
        for index, offset in enumerate(steps):
            points = [to_lonlat(p) for p in route(first_x, offset)]
            hits = _route_hits(points, obstacles)
            # Order of preference: fewest buildings crossed, then the leg order
            # the hash chose, then the smallest departure from the original.
            score = (hits, 0 if first_x == x_first else 1, index)
            if best is None or score < best[0]:
                best = (score, points)
            if hits == 0 and score[1] == 0 and index == 0:
                return points          # already clear: nothing to choose
    return best[1]


@lru_cache(maxsize=1)
def _footprint_text() -> str:
    return FOOTPRINTS.read_text(encoding="utf-8")


# Narrower than this and a ring is a seam in the data, not a shape of the
# building. The footprints were assembled from parts, and where two parts met
# the join was often left behind as a "hole" that runs out along a wall and
# straight back: no area, so a fill never shows it, but the table's outline and
# solar halo stroke every ring, and each one comes out as a bright line through
# the middle of a roof. 1.5 m is under three pixels at the table's scale. The
# real courtyards in the set are 3.4 m across and up.
SEAM_WIDTH_M = 1.5


def _ring_width(ring) -> float:
    """Mean width of a ring in metres: twice its area over its perimeter.

    A square 10 m on a side is 5 m wide by this measure, a ring that doubles
    back on itself is 0 m wide whatever its length - which is the distinction
    that matters, and one that area alone cannot draw: a long seam and a small
    real light-well can have similar areas.
    """
    if len(ring) < 4:
        return 0.0
    lon0, lat0 = ring[0][0], ring[0][1]
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 110_540.0
    pts = [((lon - lon0) * kx, (lat - lat0) * ky) for lon, lat, *_ in ring]
    area = abs(sum(x1 * y2 - x2 * y1
                   for (x1, y1), (x2, y2) in zip(pts, pts[1:]))) / 2
    perimeter = sum(math.dist(p, q) for p, q in zip(pts, pts[1:]))
    return 2 * area / perimeter if perimeter else 0.0


def _without_seams(geometry: dict) -> dict:
    """The same footprint with its zero-width rings taken out.

    A seam among the holes is dropped on its own. A seam as the outer ring of
    a part takes the whole part with it: there is nothing inside a ring with
    no width for its holes to be holes of. A footprint that would lose every
    part is left alone rather than made to vanish from the table.
    """
    kind = geometry.get("type")
    if kind == "Polygon":
        parts = [geometry["coordinates"]]
    elif kind == "MultiPolygon":
        parts = geometry["coordinates"]
    else:
        return geometry

    kept = []
    for part in parts:
        if not part or _ring_width(part[0]) < SEAM_WIDTH_M:
            continue
        kept.append([part[0]] + [hole for hole in part[1:]
                                 if _ring_width(hole) >= SEAM_WIDTH_M])
    if not kept:
        return geometry
    if kind == "Polygon" or len(kept) == 1:
        return {"type": "Polygon", "coordinates": kept[0]}
    return {"type": "MultiPolygon", "coordinates": kept}


def load_footprints() -> dict:
    """A fresh copy of the footprints per call - the caller writes into it.

    Cleaned of seams on the way in, so every consumer sees the same buildings:
    the drawn layer, the router's obstacles and the centroids things are placed
    on, which would otherwise be averaged over the seams' vertices too.
    """
    geo = json.loads(_footprint_text())
    for feature in geo.get("features", []):
        if feature.get("geometry"):
            feature["geometry"] = _without_seams(feature["geometry"])
    return geo


def _centroids(geo: dict) -> dict:
    centroids = {}
    for feature in geo["features"]:
        key = canonical(feature["properties"].get("id", ""))
        coords = []

        def collect(part):
            if isinstance(part[0], (int, float)):
                coords.append(part)
                return
            for item in part:
                collect(item)

        collect(feature["geometry"]["coordinates"])
        if coords:
            centroids[key] = (
                sum(c[0] for c in coords) / len(coords),
                sum(c[1] for c in coords) / len(coords),
            )
    return centroids


def _main_block_centres(geo: dict) -> dict:
    """The middle of each footprint's largest part, weighted by area.

    Where something stands *inside* a building - the battery in AWL - it has to
    be inside it. The vertex average _centroids gives is fine for a line to aim
    at, but for a footprint in several parts it is the middle of the corners,
    not of the building: AWL is three blocks, and that average fell exactly on
    the join between two of them, so the battery stood on a wall. The area
    centroid of the biggest block is inside that block for any building shaped
    like one.
    """
    centres = {}
    for feature in geo["features"]:
        key = canonical(feature["properties"].get("id", ""))
        geometry = feature.get("geometry") or {}
        kind = geometry.get("type")
        parts = ([geometry["coordinates"]] if kind == "Polygon"
                 else geometry["coordinates"] if kind == "MultiPolygon" else [])
        best = None
        for part in parts:
            if not part:
                continue
            ring = part[0]
            # Measured from the first corner. In raw degrees every cross
            # product is a few hundred while the area they sum to is a ten
            # millionth, and the cancellation cost a sixth of a metre.
            ox, oy = ring[0][0], ring[0][1]
            area = cx = cy = 0.0
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                x1, y1, x2, y2 = x1 - ox, y1 - oy, x2 - ox, y2 - oy
                cross = x1 * y2 - x2 * y1
                area += cross
                cx += (x1 + x2) * cross
                cy += (y1 + y2) * cross
            if abs(area) < 1e-18:
                continue
            centre = (ox + cx / (3 * area), oy + cy / (3 * area))
            if best is None or abs(area) > best[0]:
                best = (abs(area), centre)
        if best is not None:
            centres[key] = best[1]
    return centres


def _endpoint(value):
    return value if isinstance(value, str) else value.get("id", "")


def build_layer(dispatch: dict, placements: dict | None = None) -> dict:
    """{buildings, nodes, flows, meta} from a /api/dispatch result.

    `buildings` is the footprint collection with an `ecom` block per member and
    an explicit null on everything else, so the table can style "not a member"
    rather than drawing it as zero demand.

    `placements` maps a node id to (lon, lat) for assets that know where they
    stand - a charge point on a particular street, say. Anything without one
    keeps the old behaviour and is spread around the middle of the campus.
    """
    placements = placements or {}
    nodes = {n["id"]: n for n in dispatch["nodes"] if n.get("type") == "building"}
    type_of = {n["id"]: n.get("type") for n in dispatch["nodes"]}
    owner_of = {n["id"]: (n.get("owner") or "") for n in dispatch["nodes"]}

    # Hourly supply per building, split into what it imported and what it met
    # locally. Solar is the roof arrays feeding their own host; shared is other
    # members. Both count as local.
    hours = max((len(link.get("flow") or []) for link in dispatch["links"]), default=0)
    local = {bid: [0.0] * hours for bid in nodes}
    grid = {bid: [0.0] * hours for bid in nodes}
    solar = {bid: [0.0] * hours for bid in nodes}

    for link in dispatch["links"]:
        target = _endpoint(link["target"])
        if target not in nodes:
            continue
        source_type = type_of.get(_endpoint(link["source"]))
        for hour, raw in enumerate(link.get("flow") or []):
            value = float(raw or 0.0)
            if value <= 0:
                continue
            if source_type == "grid":
                grid[target][hour] += value
            else:
                local[target][hour] += value
                if source_type == "pv":
                    solar[target][hour] += value

    by_key = {canonical(bid): bid for bid in nodes}

    geo = load_footprints()
    matched = 0
    unmatched = []

    for feature in geo["features"]:
        props = feature["properties"]
        bid = by_key.get(canonical(props.get("id", "")))
        if bid is None:
            unmatched.append(props.get("id"))
            props["ecom"] = None
            continue

        matched += 1
        node = nodes[bid]
        total_local = sum(local[bid])
        total_grid = sum(grid[bid])
        served = total_local + total_grid
        props["ecom"] = {
            "name": node.get("name") or bid,
            "owner": node.get("owner"),
            "demand_kwh": round(served, 1),
            "grid_kwh": round(total_grid, 1),
            "local_kwh": round(total_local, 1),
            "solar_kwh": round(sum(solar[bid]), 1),
            "pv_kw": round(float(node.get("total_pv_capacity") or 0.0), 1),
            "self_sufficiency": round(100.0 * total_local / served, 2) if served else 0.0,
            # Hourly, so the table can animate against the dashboard's timeline.
            "demand_hourly": [round(local[bid][h] + grid[bid][h], 2) for h in range(hours)],
            "solar_hourly": [round(solar[bid][h], 2) for h in range(hours)],
        }

    # ------------------------------------------------------------ nodes
    # Buildings sit on their footprint centroid; roof arrays sit on their host,
    # nudged so the two are distinguishable at table scale.
    centroids = _centroids(geo)
    node_features = []
    placed = {}

    for bid, node in nodes.items():
        point = centroids.get(canonical(bid))
        if point is None:
            continue
        placed[bid] = point
        total_grid = sum(grid[bid])
        served = sum(local[bid]) + total_grid
        pv_kw = float(node.get("total_pv_capacity") or 0.0)
        node_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [point[0], point[1]]},
            "properties": {
                "id": bid,
                "kind": "building",
                "name": node.get("name") or bid,
                # Carried so the table can filter by owner and by size the way
                # the dashboard's legend does, without a second lookup.
                "owner": owner_of.get(bid, ""),
                "capacity": round(pv_kw, 1),
                "pv_kw": round(pv_kw, 1),
                "has_pv": 1 if pv_kw > 0 else 0,
                "self_sufficiency": round(100.0 * (served - total_grid) / served, 2) if served else 0.0,
                "demand_hourly": [round(local[bid][h] + grid[bid][h], 2) for h in range(hours)],
                "solar_hourly": [round(solar[bid][h], 2) for h in range(hours)],
            },
        })

    # Community assets, spread around the anchor so their markers and the lines
    # between them do not collapse onto one point.
    anchor = (
        sum(p[0] for p in placed.values()) / len(placed),
        sum(p[1] for p in placed.values()) / len(placed),
    ) if placed else (11.9783, 57.6887)

    # Community PV belongs here, not with the roof arrays below. Its node id is
    # "PV_{name}" with no "_PV_" separator, so the host lookup that places a roof
    # array on its building finds nothing and used to drop it silently - a
    # ground array was dispatched, counted in every KPI, and drawn nowhere.
    def is_community_pv(node):
        return node.get("type") == "pv" and "_PV_" not in node["id"]

    assets = [n for n in dispatch["nodes"]
              if n.get("type") in ("grid", "battery", "charge_point")
              or is_community_pv(n)]
    block_centres = _main_block_centres(geo)
    for index, node in enumerate(assets):
        fixed = placements.get(node["id"])
        # In the middle of the building it stands in, not on a wall of it.
        host_key = canonical(node.get("host") or "")
        host = block_centres.get(host_key) or centroids.get(host_key)
        carried = ((node["lon"], node["lat"])
                   if node.get("lat") is not None and node.get("lon") is not None
                   else None)
        if fixed is not None:
            lon, lat = fixed
        elif carried is not None:
            # A position the node brought with it. Nothing for a caller to
            # assemble, so nothing for a caller to leave out.
            lon, lat = carried
        elif host is not None:
            # Standing in a building: drawn on that footprint rather than out on
            # the ring with the assets that have nowhere of their own.
            lon, lat = host
        else:
            # No position of its own: out on the ring with the rest, so the
            # markers and the lines between them do not collapse onto a point.
            angle = (2 * math.pi * index) / max(1, len(assets))
            lon = anchor[0] + ANCHOR_SPREAD_DEG * math.cos(angle) * 1.85
            lat = anchor[1] + ANCHOR_SPREAD_DEG * math.sin(angle)
        placed[node["id"]] = (lon, lat)
        properties = {
            "id": node["id"],
            "kind": node["type"],
            "name": node.get("name") or node["id"],
            "owner": node.get("owner") or "",
            "capacity": float(node.get("total_pv_capacity")
                              or node.get("capacity")
                              or node.get("installed_capacity") or 0.0),
            "placeholder": True,
        }
        # The building it stands in, if it stands in one. The table draws a
        # hosted battery as the building itself rather than as a marker on top
        # of it - at table scale the marker and its glow were as wide as the
        # roof - so it has to know which footprint that is.
        if node.get("host"):
            properties["host"] = canonical(node["host"])
        if node["type"] == "charge_point":
            # The table draws the vehicle itself, so it needs to know there is
            # one and when it is there. Without the schedule it could only infer
            # presence from the charging flow, which stops when the battery is
            # full while the car stays parked.
            properties.update({
                "charger_type": node.get("charger_type") or "",
                "connected_evs": int(node.get("total_connected_evs") or 0),
                "ev_name": node.get("ev_name") or "",
                "plugged_hourly": [int(v) for v in (node.get("ev_plugged") or [])],
            })
        node_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": properties,
        })

    # Roof arrays land on their host; the layer offsets them for legibility.
    # Community arrays are already placed above, with the other shared assets.
    for node in dispatch["nodes"]:
        if node.get("type") != "pv" or is_community_pv(node):
            continue
        host = node["id"].split("_PV_")[0]
        point = placed.get(host)
        if point is None:
            continue
        node_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [point[0], point[1]]},
            "properties": {
                "id": node["id"],
                "kind": "pv",
                "name": node.get("name") or node["id"],
                "owner": owner_of.get(host, ""),
                "capacity": float(node.get("total_pv_capacity")
                                  or node.get("capacity") or 0.0),
                "host": host,
            },
        })

    # ------------------------------------------------------------ flows
    # The outlines every line has to keep out of. A flow ends on its own
    # building's centroid, so that building - and the one it came from - are
    # taken out of the obstacle set for that line: otherwise every route would
    # be scored as crossing the thing it is supposed to reach.
    rings_by_id = _footprint_rings(geo)
    # An asset standing in a building has to leave it. The battery lives in
    # AWL, so its cable crossing AWL is not a line cutting through a building
    # it has no business in - it is the cable coming out of its own plant room.
    host_of = {node["id"]: canonical(node.get("host") or "")
               for node in dispatch["nodes"] if node.get("host")}
    # One line per link that has both ends placed. Roof array to its own host is
    # dropped: it is internal, so the line would have zero length.
    flow_features = []
    for link in dispatch["links"]:
        source = _endpoint(link["source"])
        target = _endpoint(link["target"])
        a = placed.get(source)
        b = placed.get(target)
        if a is None or b is None or a == b:
            continue
        series = [round(float(v or 0.0), 2) for v in (link.get("flow") or [])]
        if not any(series):
            continue
        own = {canonical(source), canonical(target),
               host_of.get(source, ""), host_of.get(target, "")} - {""}
        obstacles = [ring
                     for key, rings in rings_by_id.items() if key not in own
                     for ring in rings]

        # Down the streets if the network reaches both ends, and an elbow
        # steered as clear as it can be if it does not. The fallback matters:
        # an asset placed away from any road - a ground array in a field -
        # should still be joined to the picture.
        route = street_route(a, b, obstacles)
        if route is None:
            route = elbow(a, b, f"{source}->{target}", obstacles)

        flow_features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": route},
            "properties": {
                "source": source,
                "target": target,
                "kind": type_of.get(source) or "unknown",
                # Both ends, so the table can run a line as a gradient from the
                # colour of what it leaves to the colour of what it reaches.
                # `kind` alone said only where it came from.
                "target_kind": type_of.get(target) or "unknown",
                "source_owner": owner_of.get(source, ""),
                "target_owner": owner_of.get(target, ""),
                "peak": round(max(series), 2),
                "flow_hourly": series,
            },
        })

    meta = {
        "period": dispatch["meta"]["period"],
        "hours": dispatch["meta"]["hours"],
        "community": dispatch["meta"]["community"],
        "source": "ECOM dashboard /api/dispatch",
    }
    geo["ecom_meta"] = meta

    return {
        "buildings": geo,
        "nodes": {"type": "FeatureCollection", "features": node_features},
        "flows": {"type": "FeatureCollection", "features": flow_features},
        "meta": meta,
        "kpis": dispatch.get("kpis") or {},
        "matched": matched,
        "unmatched": sorted(filter(None, unmatched)),
    }
