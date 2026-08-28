"""Export the campus energy layer for the ACE MR Studio projection table.

The table (MR-Table/) is a static site with no build step, so it cannot import
anything from the dashboard. It reads a plain GeoJSON instead, written here.

The join is the awkward part. Footprints are keyed by slug ('ca-huset') and the
dispatch by display name ('CA-Huset', 'Fysik origo'), so the two are matched on
the same canonical key the frontend uses - case, accents and punctuation folded
away. Exact matching drops buildings silently, which is how Bibliotek went
missing from the viewer once already.

Run with the backend up:
    python scripts/export_mr_layer.py
"""
from __future__ import annotations

import json
import math
import re
import sys
import unicodedata
from pathlib import Path

import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

DASHBOARD = Path(__file__).resolve().parents[2]
FOOTPRINTS = DASHBOARD / "public" / "buildings.geojson"
OUT_DIR = DASHBOARD.parent / "MR-Table" / "media" / "ecom"
OUT_FILE = OUT_DIR / "ecom-buildings.geojson"
NODES_FILE = OUT_DIR / "ecom-nodes.geojson"
FLOWS_FILE = OUT_DIR / "ecom-flows.geojson"

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

# One ordinary working day, so the table loops a full daily cycle rather than
# two days of which the second is never reached. Wednesday 1 June 2022: a
# midweek day in term time, and clear of the Swedish public holidays that fall
# later in the month (National Day on the 6th, Midsummer on the 24th-25th),
# which would show an atypically empty campus.
ANALYSIS_DAY = {"start_month": 6, "start_day": 1, "start_hour": 0,
                "end_month": 6, "end_day": 1, "end_hour": 23}

API = "http://127.0.0.1:8000"

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


def fetch(path: str, payload=None):
    url = f"{API}{path}"
    if payload is None:
        with urllib.request.urlopen(url, timeout=120) as response:
            return json.load(response)
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)


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


def main() -> int:
    try:
        spec = fetch("/api/scenarios/campus_community")
        spec["analysis_period"] = dict(ANALYSIS_DAY)
        dispatch = fetch("/api/dispatch", spec)
    except Exception as error:                       # noqa: BLE001
        print(f"Could not reach the backend at {API}: {error}")
        print("Start it with: cd backend && python -m uvicorn app.main:app --port 8000")
        return 1

    nodes = {n["id"]: n for n in dispatch["nodes"] if n.get("type") == "building"}
    type_of = {n["id"]: n.get("type") for n in dispatch["nodes"]}

    def endpoint(value):
        return value if isinstance(value, str) else value.get("id", "")

    # Hourly supply per building, split into what it imported and what it met
    # locally. Solar is the roof arrays feeding their own host; shared is other
    # members. Both count as local.
    hours = max((len(l.get("flow") or []) for l in dispatch["links"]), default=0)
    local = {bid: [0.0] * hours for bid in nodes}
    grid = {bid: [0.0] * hours for bid in nodes}
    solar = {bid: [0.0] * hours for bid in nodes}

    for link in dispatch["links"]:
        target = endpoint(link["target"])
        if target not in nodes:
            continue
        source_type = type_of.get(endpoint(link["source"]))
        flow = link.get("flow") or []
        for hour, raw in enumerate(flow):
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

    geo = json.loads(FOOTPRINTS.read_text(encoding="utf-8"))
    matched = 0
    unmatched = []

    for feature in geo["features"]:
        props = feature["properties"]
        key = canonical(props.get("id", ""))
        bid = by_key.get(key)
        if bid is None:
            unmatched.append(props.get("id"))
            # Explicitly null rather than absent, so the layer can style
            # "no data" instead of silently drawing it as zero demand.
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

    node_features = []
    placed = {}

    for bid, node in nodes.items():
        point = centroids.get(canonical(bid))
        if point is None:
            continue
        placed[bid] = point
        total_grid = sum(grid[bid])
        served = sum(local[bid]) + total_grid
        node_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [point[0], point[1]]},
            "properties": {
                "id": bid,
                "kind": "building",
                "name": node.get("name") or bid,
                "pv_kw": round(float(node.get("total_pv_capacity") or 0.0), 1),
                "has_pv": 1 if float(node.get("total_pv_capacity") or 0.0) > 0 else 0,
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

    assets = [n for n in dispatch["nodes"] if n.get("type") in ("grid", "battery", "charge_point")]
    for index, node in enumerate(assets):
        angle = (2 * math.pi * index) / max(1, len(assets))
        lon = anchor[0] + ANCHOR_SPREAD_DEG * math.cos(angle) * 1.85
        lat = anchor[1] + ANCHOR_SPREAD_DEG * math.sin(angle)
        placed[node["id"]] = (lon, lat)
        node_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": node["id"],
                "kind": node["type"],
                "name": node.get("name") or node["id"],
                "placeholder": True,
            },
        })

    # Roof arrays land on their host; the layer offsets them for legibility.
    for node in dispatch["nodes"]:
        if node.get("type") != "pv":
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
                "host": host,
            },
        })

    NODES_FILE.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": node_features,
    }), encoding="utf-8")

    # ------------------------------------------------------------ flows
    # One line per link that has both ends placed. Roof array to its own host is
    # dropped: it is internal, so the line would have zero length.
    flow_features = []
    for link in dispatch["links"]:
        source = endpoint(link["source"])
        target = endpoint(link["target"])
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
                "peak": round(max(series), 2),
                "flow_hourly": series,
            },
        })

    FLOWS_FILE.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": flow_features,
    }), encoding="utf-8")

    geo["ecom_meta"] = {
        "period": dispatch["meta"]["period"],
        "hours": dispatch["meta"]["hours"],
        "community": dispatch["meta"]["community"],
        "source": "ECOM dashboard /api/dispatch",
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(geo), encoding="utf-8")

    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"wrote {OUT_FILE.relative_to(DASHBOARD.parent)}  ({size_kb:,.0f} KB)")
    print(f"  {matched} of {len(geo['features'])} footprints carry energy data")
    print(f"  {hours} h, {dispatch['meta']['period']}")
    print(f"wrote {NODES_FILE.name}  ({len(node_features)} nodes)")
    print(f"wrote {FLOWS_FILE.name}  ({len(flow_features)} flow lines)")
    if unmatched:
        print(f"  no dispatch data for: {', '.join(sorted(filter(None, unmatched)))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
