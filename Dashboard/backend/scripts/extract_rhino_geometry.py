"""Extract building and PV geometry from the Rhino campus model.

READ ONLY. Opens Model/background image.3dm, computes areas from the cached
render meshes, and writes a JSON summary. It never writes to the .3dm and never
touches the dashboard's community definition.

    python scripts/extract_rhino_geometry.py

rhino3dm is a file reader with no geometry engine - there is no
AreaMassProperties here - so areas come from the render meshes Rhino saved with
each object:

    footprint   sum of the XY-projected area of upward-facing triangles. For a
                closed building solid this equals the plan area.
    pv surface  true 3D triangle area, since a tilted panel field covers more
                surface than its shadow on the ground.
    tilt/azimuth  area-weighted mean of the face normals.

Heights come from the bounding box, and floor counts from height / 3.5 m.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import rhino3dm as r3

ECOM_ROOT = Path(__file__).resolve().parents[3]
MODEL = ECOM_ROOT / "Model" / "background image.3dm"
# Same layer names, curves only. Used to cross-check the mesh-derived areas.
CURVES_MODEL = ECOM_ROOT / "Model" / "Curves only.3dm"

TYPICAL_FLOOR_HEIGHT = 3.5   # m, used only to estimate storeys
BUILDING_PREFIX = "BuildingBrep::"
PV_SUFFIX = " - PV"


def triangles(mesh) -> list[tuple]:
    """Yield triangles as 3-tuples of (x, y, z), splitting any quads."""
    out = []
    verts = mesh.Vertices
    for i in range(len(mesh.Faces)):
        face = mesh.Faces[i]
        idx = list(face)
        pts = [(verts[j].X, verts[j].Y, verts[j].Z) for j in idx[:4]]
        if len(idx) == 4 and idx[2] != idx[3]:
            out.append((pts[0], pts[1], pts[2]))
            out.append((pts[0], pts[2], pts[3]))
        else:
            out.append((pts[0], pts[1], pts[2]))
    return out


def projected_area(tri) -> float:
    """Signed XY area. Positive means the triangle faces upward."""
    (x1, y1, _), (x2, y2, _), (x3, y3, _) = tri
    return 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1))


def surface_area_and_normal(tri) -> tuple[float, tuple[float, float, float]]:
    """True 3D area and unit normal."""
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = tri
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length == 0:
        return 0.0, (0.0, 0.0, 1.0)
    return 0.5 * length, (nx / length, ny / length, nz / length)


def meshes_for(geometry) -> list:
    """Collect render meshes from an Extrusion, Brep or Mesh."""
    kind = type(geometry).__name__
    found = []
    try:
        if kind == "Mesh":
            found.append(geometry)
        elif kind == "Extrusion":
            mesh = geometry.GetMesh(r3.MeshType.Any)
            if mesh:
                found.append(mesh)
        elif kind == "Brep":
            for i in range(len(geometry.Faces)):
                mesh = geometry.Faces[i].GetMesh(r3.MeshType.Any)
                if mesh:
                    found.append(mesh)
    except Exception:
        pass
    return found


def union_footprint(triangles_up) -> float:
    """Area of the union of upward-facing triangles projected onto XY.

    Summing the projections instead double-counts stacked parts: JSP's 14
    objects summed to 8,232 m2 against a true footprint of 2,275 m2. The union
    is validated against independent sources - MC2 5,982 vs OSM 5,971,
    Bibliotek 2,519 vs OSM 2,513, SB1 3,055 vs its own survey record 3,066.
    """
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    polygons = []
    for tri in triangles_up:
        polygon = Polygon([(p[0], p[1]) for p in tri])
        if not polygon.is_valid:
            polygon = polygon.buffer(0)
        if not polygon.is_empty:
            polygons.append(polygon)
    if not polygons:
        return 0.0
    return float(unary_union(polygons).area)


def analyse(objects) -> dict:
    up_area = down_area = surface = 0.0
    weighted = [0.0, 0.0, 0.0]
    xs, ys, zs = [], [], []
    missing_mesh = 0
    up_triangles = []

    for geometry in objects:
        meshes = meshes_for(geometry)
        if not meshes:
            missing_mesh += 1
            continue
        for mesh in meshes:
            for tri in triangles(mesh):
                planar = projected_area(tri)
                if planar > 0:
                    up_area += planar
                    up_triangles.append(tri)
                else:
                    down_area += -planar
                area3d, normal = surface_area_and_normal(tri)
                surface += area3d
                for k in range(3):
                    weighted[k] += normal[k] * area3d
                for point in tri:
                    xs.append(point[0]); ys.append(point[1]); zs.append(point[2])

    if not xs:
        return {"error": "no render mesh on any object"}

    length = math.sqrt(sum(c * c for c in weighted)) or 1.0
    nx, ny, nz = (c / length for c in weighted)
    if nz < 0:
        nx, ny, nz = -nx, -ny, -nz

    tilt = math.degrees(math.acos(max(-1.0, min(1.0, abs(nz)))))
    azimuth = math.degrees(math.atan2(nx, ny)) % 360.0
    height = max(zs) - min(zs)

    return {
        "footprint_area": round(union_footprint(up_triangles), 1),
        "projected_sum": round(max(up_area, down_area), 1),
        "roof_plan_area": round(up_area, 1),
        "surface_area_3d": round(surface, 1),
        "height": round(height, 2),
        "estimated_floors": max(1, round(height / TYPICAL_FLOOR_HEIGHT)),
        "tilt": round(tilt, 2),
        "azimuth": round(azimuth, 2),
        "centroid": {
            "x": round((min(xs) + max(xs)) / 2, 2),
            "y": round((min(ys) + max(ys)) / 2, 2),
        },
        "bbox": {
            "min": [round(min(xs), 2), round(min(ys), 2), round(min(zs), 2)],
            "max": [round(max(xs), 2), round(max(ys), 2), round(max(zs), 2)],
        },
        "objects_without_mesh": missing_mesh,
    }


def closed_curve_areas(model_path: Path) -> dict[str, list[float]]:
    """Largest closed footprint polyline per layer, by the shoelace formula.

    Used only as a cross-check. Where a layer holds one clean massing solid the
    mesh and curve areas agree exactly (AWL 1980 vs 1979, HC 1005 vs 1005).
    Where they diverge the layer holds several buildings or stacked parts, and
    the mesh sum over-counts.
    """
    if not model_path.is_file():
        return {}

    model = r3.File3dm.Read(str(model_path))
    layers = {i: layer.FullPath for i, layer in enumerate(model.Layers)}
    per_layer: dict[str, list[float]] = defaultdict(list)

    for obj in model.Objects:
        geometry = obj.Geometry
        if type(geometry).__name__ != "PolylineCurve" or not getattr(geometry, "IsClosed", False):
            continue
        layer = layers.get(obj.Attributes.LayerIndex, "")
        if layer in ("streets", "google", "context"):
            continue
        try:
            count = geometry.PointCount
            points = [geometry.Point(i) for i in range(count)]
            total = sum(points[i].X * points[i + 1].Y - points[i + 1].X * points[i].Y
                        for i in range(count - 1))
            area = abs(total) / 2.0
        except Exception:
            continue
        if area > 5:
            per_layer[layer].append(area)

    return dict(per_layer)


def classify(info: dict, curves: list[float]) -> tuple[str, str]:
    """Say whether a footprint can be trusted, and why.

    The union removes the double-counting that made multi-object layers
    unreliable, so every layer with geometry is now usable. The classification
    is kept to surface how much the union corrected, which is a useful signal
    that a layer holds stacked parts.
    """
    area = info.get("footprint_area")
    if not area:
        return "unknown", "no render mesh"

    summed = info.get("projected_sum", area)
    overlap = (summed - area) / summed if summed else 0.0
    if info.get("object_count") == 1:
        return "trusted", "single massing solid"
    if overlap < 0.02:
        return "trusted", f"{info['object_count']} objects, no overlap"
    return "trusted", (f"{info['object_count']} objects, union removed "
                       f"{overlap:.0%} of overlapping projection "
                       f"({summed:,.0f} -> {area:,.0f} m2)")


def visible_layers(model) -> set:
    """Indices of layers switched on in Rhino, ancestors included.

    A child is only on if every layer above it is on too. The model carries
    context massing, streets, terrain and PV surfaces that are present but
    hidden; reading them anyway would report geometry the author has turned off.
    """
    by_path = {layer.FullPath: layer for layer in model.Layers}

    def on(layer) -> bool:
        parts = layer.FullPath.split("::")
        for depth in range(1, len(parts) + 1):
            ancestor = by_path.get("::".join(parts[:depth]))
            if ancestor is not None and not ancestor.Visible:
                return False
        return True

    return {i for i, layer in enumerate(model.Layers) if on(layer)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("-o", "--output", type=Path,
                        default=Path(__file__).resolve().parents[1] / "data" / "rhino_geometry.json")
    args = parser.parse_args()

    if not args.model.is_file():
        print(f"Model not found: {args.model}", file=sys.stderr)
        return 1

    print(f"Reading {args.model.name} ({args.model.stat().st_size / 1e6:.0f} MB), read-only...")
    model = r3.File3dm.Read(str(args.model))
    layers = {i: layer.FullPath for i, layer in enumerate(model.Layers)}

    on = visible_layers(model)
    skipped = 0

    grouped: dict[str, list] = defaultdict(list)
    points: list[dict] = []
    for obj in model.Objects:
        if obj.Attributes.LayerIndex not in on:
            skipped += 1
            continue
        layer = layers.get(obj.Attributes.LayerIndex, "")
        geometry = obj.Geometry
        if type(geometry).__name__ == "Point":
            location = geometry.Location
            points.append({
                "layer": layer,
                "name": obj.Attributes.Name or None,
                "x": round(location.X, 3),
                "y": round(location.Y, 3),
                "z": round(location.Z, 3),
            })
            continue
        if layer.startswith(BUILDING_PREFIX) or layer.endswith(PV_SUFFIX) or layer == "PV-Plant":
            grouped[layer].append(geometry)

    if skipped:
        print(f"Skipped {skipped} object(s) on switched-off layers.")

    print(f"Cross-checking against {CURVES_MODEL.name}...")
    curve_areas = closed_curve_areas(CURVES_MODEL)

    buildings, pv = {}, {}
    for layer, objects in sorted(grouped.items()):
        result = analyse(objects)
        result["object_count"] = len(objects)
        if layer.startswith(BUILDING_PREFIX):
            short = layer[len(BUILDING_PREFIX):]
            curves = curve_areas.get(short, [])
            if curves:
                result["curve_outline_max"] = round(max(curves), 1)
                result["curve_outline_count"] = len(curves)
            result["confidence"], result["confidence_reason"] = classify(result, curves)
            buildings[short] = result
        else:
            pv[layer[:-len(PV_SUFFIX)] if layer.endswith(PV_SUFFIX) else layer] = result

    payload = {
        "source": str(args.model),
        "note": "Areas derived from cached render meshes; rhino3dm has no "
                "geometry engine. Treat as close estimates, not survey data.",
        "buildings": buildings,
        "pv_surfaces": pv,
        "points": points,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\nWrote {args.output}\n")
    print(f"{'building layer':24} {'footprint m2':>13} {'height m':>9} "
          f"{'objs':>5}  confidence")
    for name, info in buildings.items():
        if "error" in info:
            print(f"{name:24} {'-- ' + info['error']:>13}")
            continue
        print(f"{name:24} {info['footprint_area']:>13,.0f} {info['height']:>9.1f} "
              f"{info['object_count']:>5}  {info['confidence']}")
    trusted = sum(1 for i in buildings.values() if i.get("confidence") == "trusted")
    corrected = sum(1 for i in buildings.values()
                    if i.get("projected_sum", 0) > i.get("footprint_area", 0) * 1.02)
    print(f"\n{trusted} of {len(buildings)} footprints usable. The union removed "
          f"overlapping projections on {corrected} multi-part layer(s).")

    print(f"\n{'PV layer':30} {'3D area m2':>13} {'tilt':>7} {'azimuth':>9} {'objs':>5}")
    for name, info in pv.items():
        if "error" in info:
            print(f"{name:30} {'-- ' + info['error']:>13}")
            continue
        print(f"{name:30} {info['surface_area_3d']:>13,.0f} {info['tilt']:>7.1f} "
              f"{info['azimuth']:>9.1f} {info['object_count']:>5}")

    print(f"\npoints: {len(points)} ({sum(1 for p in points if p['name'])} named)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
