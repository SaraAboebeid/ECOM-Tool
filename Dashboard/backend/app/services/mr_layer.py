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

import json
import math
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[3]
FOOTPRINTS = DASHBOARD / "public" / "buildings.geojson"

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


def elbow(a, b, key: str):
    """Right-angled route from a to b, in the campus frame.

    Mirrors buildStructuredPath: the bend is offset by a hash of the link so
    parallel runs between the same pair of areas do not lie on top of one
    another, and the leg order flips with the dominant axis.
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

    if abs(dx) >= abs(dy) or route_hash % 3 == 0:
        via_x = start[0] + dx * 0.5 + sign * bend
        points = [start, (via_x, start[1]), (via_x, end[1]), end]
    else:
        via_y = start[1] + dy * 0.5 + sign * bend
        points = [start, (start[0], via_y), (end[0], via_y), end]

    return [to_lonlat(p) for p in points]


@lru_cache(maxsize=1)
def _footprint_text() -> str:
    return FOOTPRINTS.read_text(encoding="utf-8")


def load_footprints() -> dict:
    """A fresh copy of the footprints per call - the caller writes into it."""
    return json.loads(_footprint_text())


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
    for index, node in enumerate(assets):
        fixed = placements.get(node["id"])
        host = centroids.get(canonical(node.get("host") or ""))
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
        flow_features.append({
            "type": "Feature",
            "geometry": {"type": "LineString",
                         "coordinates": elbow(a, b, f"{source}->{target}")},
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
