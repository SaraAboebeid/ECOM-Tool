"""Export Rhino building footprints as GeoJSON for the dashboard map.

READ ONLY on the .3dm. Companion to extract_rhino_geometry.py, which computes
the same union footprint but keeps only its area; this keeps the polygon.

    python scripts/export_footprints_geojson.py

Output: Dashboard/public/buildings.geojson, in WGS84 (EPSG:4326).

Why WGS84 and not the render's pixel frame: the dashboard draws CartoDB tiles
for the campus, so emitting lon/lat lets the viewer put footprints through the
exact same Web Mercator mapping as the tiles. Alignment is then exact by
construction, rather than a fitted approximation of a raster render.

Two feature classes come out:

    building   a named layer under BuildingBrep::, carrying its id, footprint
               area, height and estimated storeys. These are the ones that can
               be joined to energy data and made interactive.
    context    surrounding massing with no per-building identity, replacing
               what the 3d_topview.png overlay used to provide.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import rhino3dm as r3
from pyproj import Transformer
from shapely.geometry import Polygon, mapping
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_rhino_geometry import meshes_for, projected_area, triangles  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
ECOM_ROOT = BACKEND.parents[1]
MODEL = ECOM_ROOT / "Model" / "background image.3dm"
DEFAULT_OUT = BACKEND.parent / "public" / "buildings.geojson"

BUILDING_PREFIX = "BuildingBrep::"
CONTEXT_LAYERS = {"BuildingMesh", "context"}
PV_SUFFIX = " - PV"
TYPICAL_FLOOR_HEIGHT = 3.5

# Model/metadata.json says the campus data is SWEREF99 TM, and Campus3D and
# Curves only.3dm are indeed still in it. background image.3dm is not: it was
# rotated and moved to a local origin before the 3d_topview.png render, so its
# coordinates sit around (-1100..456, -1220..39).
MODEL_CRS = "EPSG:3006"

# Recovered by running the identical mesh-union footprint construction on both
# models and fitting a similarity transform over the buildings whose areas agree
# to within 3% - AWL, Climbing hall, CSB chabo, JSP, MC2, P-hus, SB1, SB2, SB3,
# Science Park, Vasa 9. The fitted scale came out at 1.000063, confirming the
# two models hold the same geometry rather than a rebuild, and the residuals
# were 0.08 m mean / 0.17 m max. Layers whose areas disagreed (karhus, Kemi,
# lokal kontor, Bibiotek) hold extra context geometry in Campus3D and were
# excluded from the fit rather than allowed to drag it.
LOCAL_TO_SWEREF = {
    "scale": 1.000063490,
    "rotation_deg": 18.838776,
    "translate": (319361.704, 6398596.943),
}


def local_to_sweref(x: float, y: float) -> tuple[float, float]:
    """Place background-image local coordinates back into EPSG:3006."""
    import math

    s = LOCAL_TO_SWEREF["scale"]
    a = math.radians(LOCAL_TO_SWEREF["rotation_deg"])
    tx, ty = LOCAL_TO_SWEREF["translate"]
    cos_a, sin_a = math.cos(a), math.sin(a)
    return (s * (cos_a * x - sin_a * y) + tx,
            s * (sin_a * x + cos_a * y) + ty)

# Simplification tolerance in metres. The union of thousands of mesh triangles
# carries a vertex every few centimetres; at campus zoom that detail is
# invisible but would dominate the payload.
SIMPLIFY_M = 0.35


def slug(text: str) -> str:
    """Stable id: accent- and case-insensitive, punctuation dropped."""
    stripped = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", stripped.lower()).strip("-")


def part_base(name: str) -> str:
    """'SB3_7' -> 'SB3'. Underscore only: 'MC2' and 'Vasa 9' are whole buildings."""
    return re.sub(r"_\d+$", "", name).strip()


def footprint_polygon(objects) -> tuple[Polygon | None, float]:
    """Union of upward-facing render triangles, projected to XY.

    Same construction extract_rhino_geometry.union_footprint uses, and validated
    the same way there (MC2 5,982 vs OSM 5,971; SB1 3,055 vs survey 3,066).
    Summing instead of unioning double-counts stacked parts.
    """
    polygons = []
    zs: list[float] = []
    for geometry in objects:
        for mesh in meshes_for(geometry):
            for tri in triangles(mesh):
                zs.extend(p[2] for p in tri)
                if projected_area(tri) <= 0:
                    continue
                poly = Polygon([(p[0], p[1]) for p in tri])
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if not poly.is_empty:
                    polygons.append(poly)
    if not polygons:
        return None, 0.0
    merged = unary_union(polygons).buffer(0)
    height = (max(zs) - min(zs)) if zs else 0.0
    return merged, height


def to_wgs84(geom, transformer: Transformer):
    """Reproject a shapely polygon/multipolygon ring-wise into lon/lat."""
    def ring(coords):
        placed = [local_to_sweref(c[0], c[1]) for c in coords]
        xs, ys = zip(*placed)
        lons, lats = transformer.transform(xs, ys)
        return [[round(lon, 7), round(lat, 7)] for lon, lat in zip(lons, lats)]

    gj = mapping(geom)
    if gj["type"] == "Polygon":
        gj["coordinates"] = [ring(r) for r in gj["coordinates"]]
    elif gj["type"] == "MultiPolygon":
        gj["coordinates"] = [[ring(r) for r in poly] for poly in gj["coordinates"]]
    return gj


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--simplify", type=float, default=SIMPLIFY_M,
                        help="metres; 0 disables")
    args = parser.parse_args()

    if not args.model.is_file():
        print(f"Model not found: {args.model}", file=sys.stderr)
        return 1

    print(f"Reading {args.model.name} "
          f"({args.model.stat().st_size / 1e6:.0f} MB), read-only...")
    model = r3.File3dm.Read(str(args.model))
    layers = {i: layer.FullPath for i, layer in enumerate(model.Layers)}

    named: dict[str, list] = defaultdict(list)
    context: list = []
    for obj in model.Objects:
        layer = layers.get(obj.Attributes.LayerIndex, "")
        if layer.endswith(PV_SUFFIX) or layer == "PV-Plant":
            continue
        if layer.startswith(BUILDING_PREFIX):
            named[part_base(layer[len(BUILDING_PREFIX):])].append(obj.Geometry)
        elif layer.split("::")[0] in CONTEXT_LAYERS:
            context.append(obj.Geometry)

    transformer = Transformer.from_crs(MODEL_CRS, "EPSG:4326", always_xy=True)
    features = []

    print(f"\n{'building':28} {'area m2':>10} {'height m':>9} {'parts':>6}")
    for name, objects in sorted(named.items()):
        poly, height = footprint_polygon(objects)
        if poly is None or poly.is_empty:
            print(f"{name:28} {'-- no render mesh':>10}")
            continue
        if args.simplify:
            poly = poly.simplify(args.simplify, preserve_topology=True)
        print(f"{name:28} {poly.area:>10,.0f} {height:>9.1f} {len(objects):>6}")
        features.append({
            "type": "Feature",
            "id": slug(name),
            "properties": {
                "id": slug(name),
                "rhino_layer": name,
                "kind": "building",
                "footprint_m2": round(poly.area, 1),
                "height_m": round(height, 2),
                "estimated_floors": max(1, round(height / TYPICAL_FLOOR_HEIGHT)),
            },
            "geometry": to_wgs84(poly, transformer),
        })

    if context:
        poly, _ = footprint_polygon(context)
        if poly is not None and not poly.is_empty:
            if args.simplify:
                poly = poly.simplify(args.simplify, preserve_topology=True)
            features.append({
                "type": "Feature",
                "id": "context",
                "properties": {"id": "context", "kind": "context"},
                "geometry": to_wgs84(poly, transformer),
            })
            print(f"\ncontext massing: {poly.area:,.0f} m2 from {len(context)} objects")

    payload = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "source": str(args.model),
        "note": "Footprints are the XY union of upward-facing render mesh "
                "triangles, reprojected from EPSG:3006. Close estimates, not "
                "survey data.",
        "features": features,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":"),
                                      ensure_ascii=False), encoding="utf-8")
    size = args.output.stat().st_size
    buildings = sum(1 for f in features if f["properties"]["kind"] == "building")
    print(f"\nWrote {args.output} ({size / 1024:.0f} KB) - "
          f"{buildings} buildings + {len(features) - buildings} context layer(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
