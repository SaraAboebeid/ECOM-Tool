"""Fetch real building footprints for Chalmers Johanneberg.

Areas are computed in SWEREF99 TM (EPSG:3006), the same projection the Rhino
attribute records use for 'Building footprint (EPSG 3006) (m2)', so the numbers
are directly comparable.

    python scripts/fetch_building_footprints.py

PROVENANCE
    DTCC's building data is, in its own words, "an initial datalake scraped of
    LM's repository" - Lantmateriet. It is served through a Chalmers-hosted API
    and dtcc-core is a CMake project not published on PyPI, so it cannot be
    installed or queried here without credentials.

    This script therefore reads OpenStreetMap via the Overpass API. For a
    university campus OSM building outlines are generally traced from the same
    official sources, but they are community data, not survey data. Swap in a
    DTCC or Lantmateriet export when you have one - see --from-geojson.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS = "https://overpass-api.de/api/interpreter"

# Chalmers Johanneberg campus and immediate surroundings.
BBOX = (57.6820, 11.9640, 57.6960, 11.9900)   # south, west, north, east

QUERY = """
[out:json][timeout:120];
(
  way["building"]({s},{w},{n},{e});
  relation["building"]({s},{w},{n},{e});
);
out geom;
"""


def fetch_overpass(bbox) -> dict:
    south, west, north, east = bbox
    query = QUERY.format(s=south, w=west, n=north, e=east)
    data = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(
        OVERPASS, data=data,
        headers={"User-Agent": "ECOM4Future-research/1.0 (Chalmers)"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            if err.code in (429, 504) and attempt < 2:
                time.sleep(10 * (attempt + 1))     # Overpass rate limit
                continue
            raise
    raise RuntimeError("Overpass did not respond")


def rings_from(element: dict) -> list[list[tuple[float, float]]]:
    """Outer rings as (lon, lat) lists. Relation inners are ignored."""
    if element["type"] == "way":
        geometry = element.get("geometry") or []
        if len(geometry) < 4:
            return []
        return [[(p["lon"], p["lat"]) for p in geometry]]

    rings = []
    for member in element.get("members", []):
        if member.get("role") != "outer":
            continue
        geometry = member.get("geometry") or []
        if len(geometry) >= 4:
            rings.append([(p["lon"], p["lat"]) for p in geometry])
    return rings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-o", "--output", type=Path,
                        default=Path(__file__).resolve().parents[1] / "data" / "osm_footprints.json")
    parser.add_argument("--from-geojson", type=Path,
                        help="Use a local DTCC/Lantmateriet GeoJSON instead of Overpass.")
    args = parser.parse_args()

    from shapely.geometry import Polygon
    from shapely.ops import transform
    from pyproj import Transformer

    # WGS84 -> SWEREF99 TM. always_xy keeps the (lon, lat) ordering.
    to_sweref = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True).transform

    records = []
    if args.from_geojson:
        payload = json.loads(args.from_geojson.read_text(encoding="utf-8"))
        source = str(args.from_geojson)
        for feature in payload.get("features", []):
            geom = feature.get("geometry") or {}
            if geom.get("type") != "Polygon":
                continue
            props = feature.get("properties", {})
            records.append((props.get("name"), props, [
                [(x, y) for x, y in geom["coordinates"][0]]
            ]))
    else:
        print(f"Querying Overpass for buildings in {BBOX}...")
        payload = fetch_overpass(BBOX)
        source = "OpenStreetMap via Overpass API"
        for element in payload.get("elements", []):
            tags = element.get("tags", {})
            rings = rings_from(element)
            if rings:
                records.append((tags.get("name"), tags, rings))

    buildings = []
    for name, tags, rings in records:
        area = 0.0
        centroid_x = centroid_y = 0.0
        for ring in rings:
            try:
                polygon = transform(to_sweref, Polygon(ring))
            except Exception:
                continue
            if not polygon.is_valid:
                polygon = polygon.buffer(0)
            if polygon.is_empty:
                continue
            area += polygon.area
            centroid_x, centroid_y = polygon.centroid.x, polygon.centroid.y
        if area < 20:
            continue

        levels = tags.get("building:levels")
        try:
            levels = int(float(levels)) if levels is not None else None
        except (TypeError, ValueError):
            levels = None

        street = tags.get("addr:street")
        number = tags.get("addr:housenumber")
        buildings.append({
            "name": name,
            "footprint_m2": round(area, 1),
            "levels": levels,
            "height_m": tags.get("height"),
            "building": tags.get("building"),
            "operator": tags.get("operator"),
            "ref": tags.get("ref"),
            # Addresses let EPC certificates be matched by street rather than
            # by proximity, which mismatches when one certificate covers a
            # complex and its centroid sits between buildings.
            "street": street,
            "housenumber": number,
            "address": f"{street} {number}".strip() if street else None,
            "centroid_sweref": [round(centroid_x, 2), round(centroid_y, 2)],
        })

    buildings.sort(key=lambda b: -b["footprint_m2"])
    named = [b for b in buildings if b["name"]]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "source": source,
        "crs_for_areas": "EPSG:3006 (SWEREF99 TM)",
        "bbox_wgs84": BBOX,
        "note": "Not DTCC/Lantmateriet survey data - see the module docstring.",
        "buildings": buildings,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\nWrote {args.output}")
    print(f"  {len(buildings)} building polygons, {len(named)} with a name\n")
    print(f"{'name':44} {'footprint m2':>13} {'levels':>7}")
    for b in named[:45]:
        print(f"{(b['name'] or '')[:44]:44} {b['footprint_m2']:>13,.0f} "
              f"{b['levels'] if b['levels'] is not None else '-':>7}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
