"""Report exactly which data is still missing, per building.

    python scripts/report_data_gaps.py

Reads the generated campus definition plus every upstream source and says, for
each of the 39 buildings, whether demand, footprint, floor count and map
position are known - and where each known value came from.
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
DASHBOARD = BACKEND.parent
GRAPH_JSON = DASHBOARD / "public" / "graph.json"


def slug(text: str) -> str:
    stripped = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", stripped.lower())


def load(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else default


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")

    graph = load(GRAPH_JSON, {"nodes": []})
    definition = load(BACKEND / "data" / "campus_community.json", {"buildings": []})
    osm = load(BACKEND / "data" / "osm_footprints.json", {"buildings": []})
    rhino = load(BACKEND / "data" / "rhino_geometry.json", {"buildings": {}})
    name_map = load(BACKEND / "data" / "footprint_name_map.json", {})
    coords = load(DASHBOARD / "public" / "node-coordinates.json", {}).get("nodePositions", {})

    def is_building(node_id: str) -> bool:
        return not (node_id.startswith("BAT_") or node_id.startswith("CP_")
                    or node_id == "GRID" or "_PV_" in node_id or node_id.startswith("PV_"))

    all_names = [n["id"] for n in graph["nodes"] if is_building(n["id"])]
    stated_floors = {
        n["id"]: n.get("number_of_floors")
        for n in graph["nodes"] if is_building(n["id"])
    }

    built = {b["name"]: b for b in definition["buildings"]}
    coord_slugs = {slug(k) for k in coords}
    osm_levels = {b["name"]: b.get("levels") for b in osm.get("buildings", []) if b.get("name")}

    mapped = {}
    for tier in ("confirmed", "likely"):
        for ours, theirs in (name_map.get(tier) or {}).items():
            if not ours.startswith("_"):
                mapped[ours] = (tier, theirs)
    ambiguous = {k: v for k, v in (name_map.get("ambiguous") or {}).items()
                 if not k.startswith("_")}

    # Rhino layers that survived the confidence filter.
    trusted_rhino = set()
    for layer, info in rhino.get("buildings", {}).items():
        if info.get("confidence") == "trusted":
            trusted_rhino.add(slug(re.sub(r"_\d+$", "", layer)))
    trusted_rhino |= {slug("Bibliotek"), slug("Elkraftteknik")}   # alias targets

    rows = []
    for name in all_names:
        key = slug(name)
        entry = built.get(name)

        # demand
        if entry is None:
            demand = "MISSING"
        elif entry["demand"].get("csv_path") and os.path.isfile(entry["demand"]["csv_path"]):
            demand = "ok"
        else:
            demand = "MISSING"

        # footprint
        if name in mapped:
            tier, theirs = mapped[name]
            footprint = f"measured ({tier})"
        elif key in trusted_rhino:
            footprint = "Rhino (trusted)"
        elif name in ambiguous:
            footprint = "AMBIGUOUS"
        else:
            footprint = "MISSING"

        # floors
        raw = stated_floors.get(name)
        has_stated = isinstance(raw, list) and raw
        osm_name = mapped.get(name, (None, None))[1]
        has_osm = osm_name and osm_levels.get(osm_name) is not None
        if has_stated:
            floors = f"graph.json ({int(float(raw[0]))})"
        elif has_osm:
            floors = f"OSM ({osm_levels[osm_name]})"
        elif entry and entry.get("number_of_floors", 1) > 1:
            floors = f"ESTIMATED ({entry['number_of_floors']})"
        else:
            floors = "MISSING"

        position = "ok" if key in coord_slugs else "MISSING"
        rows.append((name, demand, footprint, floors, position))

    print(f"{'building':32} {'demand':>9}  {'footprint':<20} {'floors':<22} {'position'}")
    print("-" * 100)
    for row in rows:
        print(f"{row[0][:32]:32} {row[1]:>9}  {row[2]:<20} {row[3]:<22} {row[4]}")

    def count(index, predicate):
        return sum(1 for r in rows if predicate(r[index]))

    print("\n" + "=" * 100)
    total = len(rows)
    print(f"{total} buildings")
    print(f"  demand      {count(1, lambda v: v == 'ok'):>3} ok   "
          f"{count(1, lambda v: v != 'ok'):>3} missing")
    print(f"  footprint   {count(2, lambda v: v.startswith(('measured', 'Rhino'))):>3} ok   "
          f"{count(2, lambda v: v == 'AMBIGUOUS'):>3} ambiguous   "
          f"{count(2, lambda v: v == 'MISSING'):>3} missing")
    print(f"  floors      {count(3, lambda v: v.startswith(('graph', 'OSM'))):>3} real "
          f"{count(3, lambda v: v.startswith('ESTIMATED')):>3} estimated "
          f"{count(3, lambda v: v == 'MISSING'):>3} missing")
    print(f"  position    {count(4, lambda v: v == 'ok'):>3} ok   "
          f"{count(4, lambda v: v != 'ok'):>3} missing")

    print("\nASK AKADEMISKA HUS / CHALMERSFASTIGHETER FOR:")
    need_floors = [r[0] for r in rows if not r[3].startswith(("graph", "OSM"))]
    print(f"\n  Floor count or BTA, {len(need_floors)} buildings:")
    for chunk in range(0, len(need_floors), 4):
        print("     " + ", ".join(need_floors[chunk:chunk + 4]))

    need_fp = [r[0] for r in rows if r[2] in ("MISSING", "AMBIGUOUS")]
    print(f"\n  Footprint still unresolved, {len(need_fp)} buildings:")
    for chunk in range(0, len(need_fp), 4):
        print("     " + ", ".join(need_fp[chunk:chunk + 4]))

    need_demand = [r[0] for r in rows if r[1] != "ok"]
    if need_demand:
        print(f"\n  Hourly electricity demand, {len(need_demand)} buildings:")
        print("     " + ", ".join(need_demand))

    need_pos = [r[0] for r in rows if r[4] != "ok"]
    if need_pos:
        print(f"\n  Map position, {len(need_pos)} buildings:")
        print("     " + ", ".join(need_pos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
