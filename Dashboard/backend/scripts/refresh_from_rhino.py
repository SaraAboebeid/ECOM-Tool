"""Rebuild everything derived from the Rhino campus model.

Run this after editing Model/background image.3dm - adding a building, renaming
a layer, moving geometry. Building names come from that file's layer names under
BuildingBrep::, so a rename there is a rename everywhere downstream.

    python scripts/refresh_from_rhino.py

The order matters, because each step reads the one before:

    1. extract_rhino_geometry.py    -> backend/data/rhino_geometry.json
       Footprint areas, heights, estimated floors, PV surfaces.

    2. export_footprints_geojson.py -> public/buildings.geojson
                                    -> src/data/buildingFootprints.json
       Polygons for the 2D viewer, plus the centroids and roof areas the
       frontend imports.

    3. build_campus_definition.py   -> backend/data/campus_community.json
       The community the dashboard dispatches.

WHEN THE MODEL MOVES
    export_footprints_geojson.py carries a fitted LOCAL_TO_SWEREF transform,
    because background image.3dm sits in a local coordinate system rather than
    SWEREF99. Moving the model invalidates it and every footprint lands in the
    wrong place - visibly, by hundreds of metres. This script checks for that
    and says so rather than writing a plausible-looking wrong answer.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
BACKEND = SCRIPTS.parent
DASHBOARD = BACKEND.parent

STEPS = [
    ("extract_rhino_geometry.py", "footprint areas, heights, floors"),
    ("export_footprints_geojson.py", "polygons, centroids, roof areas"),
    ("build_campus_definition.py", "community definition"),
]

# The campus sits here. A centroid outside this box means the fitted transform
# no longer matches the model - almost always because the model was moved.
CAMPUS_BOUNDS = {"minLon": 11.94, "maxLon": 12.02, "minLat": 57.66, "maxLat": 57.71}


def run(script: str, description: str) -> bool:
    print(f"\n=== {script} - {description} ===")
    result = subprocess.run([sys.executable, str(SCRIPTS / script)],
                            cwd=BACKEND, text=True,
                            capture_output=True)
    if result.returncode != 0:
        print(result.stdout[-2000:])
        print(result.stderr[-2000:], file=sys.stderr)
        return False
    tail = [line for line in result.stdout.splitlines() if line.strip()][-3:]
    for line in tail:
        print(f"  {line}")
    return True


def check_placement() -> bool:
    """Are the regenerated footprints still on the campus?"""
    path = DASHBOARD / "src" / "data" / "buildingFootprints.json"
    if not path.is_file():
        print(f"  {path.name} was not written", file=sys.stderr)
        return False

    data = json.loads(path.read_text(encoding="utf-8"))
    stray = []
    for name, record in data.items():
        lon, lat = record["centroid"]
        if not (CAMPUS_BOUNDS["minLon"] <= lon <= CAMPUS_BOUNDS["maxLon"]
                and CAMPUS_BOUNDS["minLat"] <= lat <= CAMPUS_BOUNDS["maxLat"]):
            stray.append((name, lon, lat))

    if stray:
        print(f"\n  {len(stray)} of {len(data)} buildings landed off-campus:",
              file=sys.stderr)
        for name, lon, lat in stray[:5]:
            print(f"    {name:<28} lon {lon:.5f} lat {lat:.5f}", file=sys.stderr)
        print("\n  The model was probably moved. LOCAL_TO_SWEREF in "
              "export_footprints_geojson.py needs re-fitting against a model "
              "that is still in SWEREF99 - Campus3D or Curves only.3dm.",
              file=sys.stderr)
        return False

    print(f"  {len(data)} buildings, all within the campus bounds")
    return True


def main() -> int:
    for script, description in STEPS:
        if not run(script, description):
            print(f"\nFAILED at {script}; nothing further was run.", file=sys.stderr)
            return 1

    print("\n=== placement check ===")
    if not check_placement():
        return 1

    print("\nDone. Restart the backend so it reloads the definition, and reload "
          "the dashboard.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
