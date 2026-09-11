"""Give the table's buildings the MR Studio's outlines.

The dashboard's footprints (public/buildings.geojson) come out of the Rhino
model, and Rhino models a building in pieces: Maskinteknik is seven, SSPA seven,
Kårhus seven. The pieces sit edge to edge, so a fill never shows the joins - but
the table strokes every ring it draws, outline and solar halo both, and each
join comes out as a line across the roof. Nothing on the table says those lines
are construction joints in a 3D model rather than walls.

The MR Studio already has the campus's buildings, from Lantmäteriet, in
MR-Table/media/building-footprints.geojson - the outlines every other layer on
the table uses. This script puts those outlines under the dashboard's
identities: which footprint is AWL, which is Kemi, is still decided by the
Rhino model, because that is what the dispatch is keyed to. What is drawn is
Lantmäteriet's.

    python scripts/build_table_footprints.py

Writes data/table_footprints.geojson, which app/services/mr_layer.py reads.
Rerun after refresh_from_rhino.py or after the MR Studio's footprints change.
Needs shapely; nothing at runtime does.

How a Lantmäteriet building is given out:

* Mostly inside one dashboard building - it is that building, whole.
* Spread across several - Lantmäteriet draws Vasa as one building where the
  dashboard has three, each with its own demand. It is cut between them along
  the Rhino boundaries, so its outside edge stays Lantmäteriet's and the only
  line through it is the one between two buildings the table colours apart.
* Mostly outside every dashboard building - a neighbour, not ours.

The pieces of one building are fused where they touch, so the walls between
Lantmäteriet's own parts do not come back as lines either.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import transform, unary_union

sys.stdout.reconfigure(encoding="utf-8")

BACKEND = Path(__file__).resolve().parents[1]
DASHBOARD = BACKEND.parent
RHINO = DASHBOARD / "public" / "buildings.geojson"
STUDIO = DASHBOARD.parent / "MR-Table" / "media" / "building-footprints.geojson"
OUT = BACKEND / "data" / "table_footprints.geojson"

# A Lantmäteriet building belongs to the dashboard building holding at least
# this share of it. Below, it is someone else's building that a Rhino outline
# happens to clip.
WHOLE_SHARE = 0.5
# Each of several dashboard buildings holding this much of one Lantmäteriet
# building makes it shared, and cut. Measured on the campus: the three shared
# buildings split 38/31/30, 69/31 and 78/21; nothing else gives a second
# building more than a few percent.
SPLIT_SHARE = 0.15
# Anything under this share is overlap from two outlines drawn a little
# differently, not a claim on the building.
NOISE_SHARE = 0.02

# Parts closer than this are fused. Lantmäteriet's parts of one complex meet
# wall to wall but not always to the millimetre, and a hair-width gap left open
# is the seam problem again. Real gaps between buildings are metres.
FUSE_M = 0.25
# Fused output is then held to the same rule as mr_layer: nothing narrower
# than this is kept as a hole or as a part of its own.
SEAM_WIDTH_M = 1.5

# Local metric frame, so buffers and areas are in metres rather than degrees -
# a degree of longitude is half a degree of latitude up here.
LON0, LAT0 = 11.975, 57.689
KX = 111_320.0 * math.cos(math.radians(LAT0))
KY = 110_540.0


def to_m(geom):
    return transform(lambda x, y, z=None: ((x - LON0) * KX, (y - LAT0) * KY), geom)


def to_deg(geom):
    return transform(lambda x, y, z=None: (x / KX + LON0, y / KY + LAT0), geom)


def polygons(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def width(ring_polygon: Polygon) -> float:
    """Mean width, twice the area over the perimeter - see mr_layer."""
    return 2 * ring_polygon.area / ring_polygon.length if ring_polygon.length else 0.0


def tidy(geom):
    """Fuse near-touching parts and drop what is narrower than a seam."""
    fused = (geom.buffer(FUSE_M, join_style="mitre", mitre_limit=4)
                 .buffer(-FUSE_M, join_style="mitre", mitre_limit=4))
    kept = []
    for part in polygons(fused):
        if width(Polygon(part.exterior)) < SEAM_WIDTH_M:
            continue
        holes = [h for h in part.interiors if width(Polygon(h)) >= SEAM_WIDTH_M]
        kept.append(Polygon(part.exterior, holes))
    return unary_union(kept) if kept else fused


def load(path: Path) -> list:
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def main() -> None:
    rhino = load(RHINO)
    studio = load(STUDIO)

    first = studio[0]["geometry"]["coordinates"][0][0][0]
    if not (11 < first[0] < 13 and 57 < first[1] < 58):
        sys.exit(f"{STUDIO.name} is not in lon/lat: first point {first}")

    # buffer(0) takes the Rhino seams out: a hole with no area is not a hole.
    ours = [(f, to_m(shape(f["geometry"])).buffer(0)) for f in rhino]
    theirs = [(f["properties"].get("objektidentitet"), to_m(shape(f["geometry"])).buffer(0))
              for f in studio]

    pieces = {f["properties"]["id"]: [] for f, _ in ours}
    sources = {f["properties"]["id"]: [] for f, _ in ours}
    shared_log = []

    for object_id, building in theirs:
        if building.is_empty or building.area == 0:
            continue
        shares = []
        for feature, footprint in ours:
            if building.intersects(footprint):
                share = building.intersection(footprint).area / building.area
                if share > NOISE_SHARE:
                    shares.append((share, feature["properties"]["id"], footprint))
        if not shares:
            continue
        shares.sort(key=lambda s: s[0], reverse=True)
        claimants = [s for s in shares if s[0] >= SPLIT_SHARE]

        if len(claimants) >= 2 and sum(s[0] for s in claimants) >= WHOLE_SHARE:
            # Cut along the Rhino boundaries, then hand out whatever falls
            # between them - the gap where two Rhino outlines did not quite
            # meet - to whichever piece it touches most.
            cut = {bid: building.intersection(fp) for _, bid, fp in claimants}
            rest = building.difference(unary_union(list(cut.values())))
            for leftover in polygons(rest):
                grown = leftover.buffer(0.5)
                best = max(cut, key=lambda bid: (grown.intersection(cut[bid]).area,
                                                 -leftover.distance(cut[bid])))
                cut[best] = unary_union([cut[best], leftover])
            for bid, piece in cut.items():
                pieces[bid].append(piece)
                sources[bid].append(object_id)
            shared_log.append((round(building.area),
                               [(bid, f"{s:.0%}") for s, bid, _ in claimants]))
        elif shares[0][0] >= WHOLE_SHARE:
            pieces[shares[0][1]].append(building)
            sources[shares[0][1]].append(object_id)

    features = []
    report = []
    for feature, footprint in ours:
        bid = feature["properties"]["id"]
        properties = dict(feature["properties"])
        if pieces[bid]:
            geom = tidy(unary_union(pieces[bid]))
            properties["geometry_source"] = "Lantmäteriet"
            properties["lantmateriet_ids"] = sorted(set(sources[bid]))
        else:
            # Nothing of Lantmäteriet's here. Better the model's outline than
            # a building missing from the table.
            geom = tidy(footprint)
            properties["geometry_source"] = "Rhino"
        report.append((bid, properties["geometry_source"], footprint.area, geom.area,
                       len(polygons(geom)),
                       sum(len(p.interiors) for p in polygons(geom))))
        features.append({"type": "Feature", "properties": properties,
                         "geometry": mapping(to_deg(geom))})

    collection = {
        "type": "FeatureCollection",
        "name": "table_footprints",
        "note": ("Lantmäteriet outlines from MR-Table/media/building-footprints."
                 "geojson under the ids of Dashboard/public/buildings.geojson. "
                 "Built by scripts/build_table_footprints.py - do not edit."),
        "features": features,
    }
    text = json.dumps(collection, ensure_ascii=False, separators=(",", ":"))
    # Seven decimals is about a centimetre; the rest is noise and file size.
    text = _round_coordinates(text)
    OUT.write_text(text, encoding="utf-8")

    print(f"wrote {OUT.relative_to(DASHBOARD.parent)}  ({len(text) // 1024} KB)")
    print("\nshared Lantmäteriet buildings, cut between:")
    for area, who in shared_log:
        print(f"  {area:6} m2  {who}")
    print(f"\n  {'building':32} {'source':13} {'model m2':>9} {'table m2':>9} "
          f"{'change':>7} parts holes")
    for bid, source, before, after, parts, holes in report:
        change = (after - before) / before if before else 0
        print(f"  {bid:32} {source:13} {before:9.0f} {after:9.0f} "
              f"{change:+7.0%} {parts:5} {holes:5}")


def _round_coordinates(text: str) -> str:
    import re
    return re.sub(r"(-?\d+\.\d{7})\d+", r"\1", text)


if __name__ == "__main__":
    main()
