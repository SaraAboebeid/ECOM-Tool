"""Build a CommunitySpec JSON for the Chalmers campus from the real data.

Sources, none of which are modified:

    Data/energy_data/*.csv          hourly demand, "hoy,value", 8760 rows
    Dashboard/public/graph.json     owner, building type, area, PV geometry,
                                    battery and charge point settings
    Dashboard/public/node-coordinates.json   map positions

Demand is referenced by csv_path rather than inlined: 36 buildings x 8760
values would be a ~10 MB definition to push over HTTP on every edit.

    python scripts/build_campus_definition.py --year 2022
    python scripts/build_campus_definition.py --year 2023 -o data/campus_2023.json

Anything missing is reported and left out rather than filled with a plausible
guess. Run with --list-gaps to see what is still needed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

ECOM_ROOT = Path(__file__).resolve().parents[3]
ENERGY_DATA = ECOM_ROOT / "Data" / "energy_data"
GRAPH_JSON = ECOM_ROOT / "Dashboard" / "public" / "graph.json"
COORDS_JSON = ECOM_ROOT / "Dashboard" / "public" / "node-coordinates.json"
RHINO_GEOMETRY = Path(__file__).resolve().parents[1] / "data" / "rhino_geometry.json"

# Rhino layer names that differ from the building names in graph.json.
# Both of these are misspellings in the Rhino model, kept here rather than
# corrected in the .3dm so the model is never modified.
RHINO_LAYER_ALIASES = {
    "bibiotek": "Bibliotek",
    "elkrafteknik": "Elkraftteknik",
}

# Rhino layer -> building, where one name could plausibly mean several
# buildings. 'karhus' could be Kårhus entré, Kårresturangen or Emils kårhus,
# so it is left unassigned rather than guessed.
RHINO_AMBIGUOUS = {"karhus"}

TYPICAL_FLOOR_HEIGHT = 3.5

# Standalone PV arrays - ones graph.json lists without a host building. Off,
# because the only such array sat as an unanchored node in the middle of the
# campus with no building to belong to. Roof arrays are unaffected: they are
# folded into their host and shown by its PV badge.
INCLUDE_COMMUNITY_PV = False

# Above this, a stated floor count is not believable for a teaching or lab
# building and is treated as a placeholder. Deliberately generous - a genuine
# single-storey hall clears 5.5 m, so only clearly wrong values are overridden.
IMPLAUSIBLE_STOREY_HEIGHT = 5.5

# Round-trip efficiency below this is not a battery. Lithium systems run 85-95%;
# the Grasshopper model currently emits 20 for Battery-01, which is low enough
# that storing energy would cost more than it saves and the optimizer would
# rationally never cycle it. Treated as a placeholder, the same way an
# implausible storey height is.
IMPLAUSIBLE_ROUND_TRIP_PCT = 50.0
DEFAULT_ROUND_TRIP_PCT = 90.0

# Roof PV that exists in the Rhino model but was never wired into the
# Grasshopper definition, so it is absent from graph.json.
#
# Areas come from integrating the Rhino surfaces (extract_rhino_geometry's
# PointAt sampling). That is exact for untrimmed surfaces - it reproduces
# graph.json for SB1, Bibliotek and PV-Plant to 0.01 m2 - but it ignores trim
# curves, so trimmed surfaces come out too large. MC2's raw figure of 6,041 m2
# is 101% of its own footprint, which is impossible, hence the coverage cap
# below. Replace `surface_area` with a measured value when you have one.
PV_OVERRIDES = {
    "MC2": {
        "plants": [{"name": "MC2-PV", "surface_area": 4785.6, "slope": 10.0,
                    "azimuth": 180.0, "percentage": 70.0}],
        "module": {"name": "MC2 350W Panel", "rating": 350.0,
                   "size_x": 1.0, "size_y": 2.0},
        "note": "Rhino integration gives 6,041 m2 across 23 surfaces, but that "
                "is 101% of the building footprint because several surfaces are "
                "trimmed. Set to 80% roof coverage (4,785.6 m2 of a 5,982 m2 "
                "footprint) pending a measured area.",
    },
    "Kårhus entré": {
        "plants": [{"name": "Karhus-PV", "surface_area": 1138.0, "slope": 10.0,
                    "azimuth": 180.0, "percentage": 70.0}],
        "module": {"name": "Karhus 350W Panel", "rating": 350.0,
                   "size_x": 1.0, "size_y": 2.0},
        "note": "Single surface, 1,138 m2 from Rhino integration. Unverified - "
                "the surface has 7 edges so it is trimmed and this is an upper "
                "bound. Assigned to Kårhus entré; move it if the array belongs "
                "to Emils kårhus or Kårresturangen instead.",
    },
}

# Where the campus meets the grid: on Aschebergsgatan, by the substation. The
# Grasshopper model has no geographic position for it - only a spot on its own
# canvas - so this is the one place the coordinate lives, and every rebuild of
# the definition carries it. Chosen as the point on the street, within sight
# of the substation, furthest from any Lantmäteriet building (18 m): the tie
# is drawn with a glow several times its own size, and on the projection table
# a marker that spills onto a roof reads as belonging to that building.
GRID_SUBSTATION = {"lat": 57.690634, "lon": 11.973668}

# Coordinates are drawn in a ~1200 x 1200 image space with y increasing
# downward; the graph canvas centres on the origin with y increasing upward.
COORD_CENTRE = 600.0
COORD_SCALE = 1.0


def slug(text: str) -> str:
    """Accent- and case-insensitive key, so 'Idelara' matches 'Idélära'."""
    stripped = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", stripped.lower())


def is_building_node(node_id: str) -> bool:
    return not (
        node_id.startswith("BAT_")
        or node_id.startswith("CP_")
        or node_id == "GRID"
        or "_PV_" in node_id
        or node_id.startswith("PV_")
    )


def find_demand_csvs(year: str) -> dict[str, Path]:
    """Map slugged building name -> CSV path, preferring top-level files."""
    found: dict[str, Path] = {}

    for path in sorted(ENERGY_DATA.glob("*.csv")):
        match = re.match(rf"^(?:[\d.]+_)?(.+?)_{year}\.csv$", path.name)
        if match:
            found[slug(match.group(1).replace("_", " "))] = path

    # Subfolders hold the same series as electricity_<year>.csv. Only used when
    # a building has no top-level file (Idelara is the one that needs this).
    for folder in sorted(p for p in ENERGY_DATA.iterdir() if p.is_dir()):
        candidate = folder / f"electricity_{year}.csv"
        if not candidate.is_file():
            continue
        name = re.sub(r"^[\d.]+\s+", "", folder.name)
        found.setdefault(slug(name), candidate)

    return found


def load_rhino_footprints() -> dict[str, dict]:
    """Footprint area and height per building, from extract_rhino_geometry.py.

    Layers split across parts (SB3_1 .. SB3_11) are summed; the tallest part
    sets the height. Returns {} when the extraction has not been run.
    """
    if not RHINO_GEOMETRY.is_file():
        return {}

    raw = json.loads(RHINO_GEOMETRY.read_text(encoding="utf-8")).get("buildings", {})
    grouped: dict[str, list[dict]] = {}
    for layer, info in raw.items():
        if "footprint_area" not in info:
            continue
        # Only layers holding a single massing solid, or whose area is confirmed
        # by a closed footprint outline. Multi-part layers over-count badly:
        # JSP's mesh sum is 8,232 m2 against a 1,113 m2 outline.
        if info.get("confidence") != "trusted":
            continue
        base = re.sub(r"_\d+$", "", layer)          # SB3_7 -> SB3
        if slug(base) in RHINO_AMBIGUOUS:
            continue
        grouped.setdefault(RHINO_LAYER_ALIASES.get(slug(base), base), []).append(info)

    out: dict[str, dict] = {}
    for name, parts in grouped.items():
        height = max(p["height"] for p in parts)
        out[slug(name)] = {
            "layer": name,
            "footprint_area": round(sum(p["footprint_area"] for p in parts), 1),
            "height": height,
            "estimated_floors": max(1, round(height / TYPICAL_FLOOR_HEIGHT)),
            "parts": len(parts),
        }
    return out


def load_survey_footprints() -> dict[str, dict]:
    """Footprints from the external dataset, keyed by our building name.

    Currently OpenStreetMap (see fetch_building_footprints.py); the same file
    format accepts a DTCC or Lantmateriet export. Only 'confirmed' and 'likely'
    name matches are used - 'ambiguous' entries, where one polygon covers
    several of our buildings, are deliberately left out.
    """
    footprints = Path(__file__).resolve().parents[1] / "data" / "osm_footprints.json"
    mapping_file = Path(__file__).resolve().parents[1] / "data" / "footprint_name_map.json"
    if not (footprints.is_file() and mapping_file.is_file()):
        return {}

    payload = json.loads(footprints.read_text(encoding="utf-8"))
    by_name: dict[str, dict] = {}
    for building in payload.get("buildings", []):
        name = building.get("name")
        # Keep the largest polygon when a name repeats (annexes share names).
        if name and building["footprint_m2"] > by_name.get(name, {}).get("footprint_m2", 0):
            by_name[name] = building

    mapping = json.loads(mapping_file.read_text(encoding="utf-8"))
    resolved: dict[str, dict] = {}
    for tier in ("confirmed", "likely"):
        for ours, theirs in (mapping.get(tier) or {}).items():
            if ours.startswith("_") or theirs not in by_name:
                continue
            entry = dict(by_name[theirs])
            entry["match_tier"] = tier
            entry["matched_name"] = theirs
            entry["dataset"] = payload.get("source", "unknown")
            resolved[slug(ours)] = entry
    return resolved


def load_epc() -> dict[str, dict]:
    """Surveyed floor counts and heated area, keyed by our building name.

    EgenAntalPlan is the only surveyed floor count available anywhere, and it
    replaces the height / 3.5 m guess. EgenAtemp is the heated area, which is a
    better denominator for energy intensity than footprint x floors.
    """
    epc_file = Path(__file__).resolve().parents[1] / "data" / "epc_attributes.json"
    mapping_file = Path(__file__).resolve().parents[1] / "data" / "footprint_name_map.json"
    if not (epc_file.is_file() and mapping_file.is_file()):
        return {}

    mapping = json.loads(mapping_file.read_text(encoding="utf-8"))
    # outline name -> our building name, for unambiguous entries only.
    reverse: dict[str, str] = {}
    for tier in ("confirmed", "likely"):
        for ours, theirs in (mapping.get(tier) or {}).items():
            if not ours.startswith("_"):
                reverse.setdefault(theirs, ours)

    out: dict[str, dict] = {}
    for cert in json.loads(epc_file.read_text(encoding="utf-8")).get("certificates", []):
        outline = cert.get("matched_outline")
        ours = reverse.get(outline) if outline else None
        if not ours or not cert.get("floors"):
            continue
        key = slug(ours)
        # A complex can hold several certificates; keep the largest, which is
        # the main building rather than an annexe.
        if cert.get("atemp_m2", 0) > out.get(key, {}).get("atemp_m2", 0):
            out[key] = cert
    return out


def position_for(coords: dict, *names) -> dict | None:
    """Map position for a non-building node, tried under several names."""
    for name in names:
        if not name:
            continue
        hit = coords.get(slug(name))
        if hit:
            return {"x": round(hit[0], 2), "y": round(hit[1], 2)}
    return None


def load_coordinates() -> dict[str, tuple[float, float]]:
    raw = json.loads(COORDS_JSON.read_text(encoding="utf-8"))
    positions = raw.get("nodePositions", raw)
    return {
        slug(name): (
            (p["x"] - COORD_CENTRE) * COORD_SCALE,
            (COORD_CENTRE - p["y"]) * COORD_SCALE,   # flip to y-up
        )
        for name, p in positions.items()
        if isinstance(p, dict) and "x" in p and "y" in p
    }


def build(year: str, include_without_demand: bool,
          verified_only: bool = False) -> tuple[dict, list[str]]:
    graph = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
    demand_csvs = find_demand_csvs(year)
    coords = load_coordinates()
    rhino = load_rhino_footprints()
    footprints = load_survey_footprints()
    epc = load_epc()
    notes: list[str] = []

    if epc:
        notes.append(f"Loaded surveyed floor counts from {len(epc)} energy "
                     f"performance certificate(s).")

    if footprints:
        notes.append(f"Loaded {len(footprints)} measured building outlines from "
                     f"the footprint dataset.")

    if not rhino:
        notes.append("No Rhino geometry found. Run extract_rhino_geometry.py "
                     "first to get real footprint areas.")

    nodes = {n["id"]: n for n in graph["nodes"]}
    building_nodes = [n for n in graph["nodes"] if is_building_node(n["id"])]

    # --- PV plants, grouped by the building they sit on ---------------------
    pv_by_building: dict[str, list[dict]] = {}
    community_pv: list[dict] = []
    for node in graph["nodes"]:
        node_id = node["id"]
        if "_PV_" not in node_id and not node_id.startswith("PV_"):
            continue

        surface = float(node.get("total_surface") or 0.0)
        if surface <= 0:
            notes.append(f"PV {node_id}: no surface area, skipped")
            continue

        plant = {
            "name": str(node.get("name") or node_id),
            "surface_area": round(surface, 2),
            "percentage": round(float(node.get("percentage") or 70.0), 2),
            "system_loss": round(float(node.get("system_loss") or 14.0), 2),
            "slope": round(float(node.get("slope") or 0.0), 3),
            # graph.json carries -0.0 and values outside [0, 360).
            "azimuth": round(float(node.get("azimuth") or 0.0) % 360.0, 3),
            "lat": float(node.get("lat") or 57.688730),
            "lon": float(node.get("lon") or 11.977887),
        }

        if "_PV_" in node_id:
            owner_name = node_id.rsplit("_PV_", 1)[0]
            pv_by_building.setdefault(owner_name, []).append(plant)
        elif INCLUDE_COMMUNITY_PV:
            # Standalone arrays are their own map node, so they need a position.
            where = position_for(coords, plant["name"], "PV-Plant")
            if where:
                plant["location"] = where
            community_pv.append(plant)
        else:
            notes.append(
                f"PV {node_id}: standalone community array, excluded "
                f"(INCLUDE_COMMUNITY_PV is off). It has no host building, so it "
                f"was drawn as a lone node in the middle of the campus.")

    # --- buildings ----------------------------------------------------------
    buildings: list[dict] = []
    pv_plants: list[dict] = []
    skipped: list[str] = []
    unverified: list[str] = []
    area_sources: dict[str, int] = {}

    for node in building_nodes:
        name = node["id"]
        key = slug(name)
        csv_path = demand_csvs.get(key)

        if csv_path is None and not include_without_demand:
            skipped.append(name)
            continue

        # graph.json's `area` is gross floor area: verified against Rhino as
        # footprint x floors for Idelara, HC and AWL, matching to 0.1 m2.
        gross_area = float(node.get("area") or 0.0)

        stated_floors = None
        floors_raw = node.get("number_of_floors")
        if isinstance(floors_raw, list) and floors_raw:
            try:
                stated_floors = max(1, int(float(floors_raw[0])))
            except (TypeError, ValueError):
                stated_floors = None

        # A surveyed floor count beats anything stated in graph.json or guessed
        # from height, so it takes priority.
        certificate = epc.get(key)
        if certificate:
            surveyed = int(certificate["floors"])
            heated = certificate.get("atemp_m2") or 0
            outline = (rhino.get(key) or {}).get("footprint_area") \
                or (footprints.get(key) or {}).get("footprint_m2") or 0
            # A certificate whose heated area is far below the building's own
            # footprint belongs to an annexe, not the building. Maskinteknik was
            # picking up a 1,515 m2 certificate against an 8,329 m2 footprint
            # and dropping from 7 floors to 3.
            if outline and heated and heated < 0.8 * outline:
                notes.append(
                    f"{name}: nearest energy certificate covers only "
                    f"{heated:,.0f} m2 against a {outline:,.0f} m2 footprint, so "
                    f"it is an annexe. Floor count NOT taken from it."
                )
            else:
                if stated_floors and stated_floors != surveyed:
                    notes.append(f"{name}: graph.json said {stated_floors} floors, "
                                 f"the energy certificate says {surveyed}. Used "
                                 f"the certificate.")
                stated_floors = surveyed

        survey = footprints.get(key)
        geometry = rhino.get(key)

        if geometry is not None:
            # A Rhino layer is per building, so it beats the external dataset
            # wherever one polygon covers several of our buildings - the whole
            # Samhallsbyggnad complex is a single OSM shape, but SB1, SB2 and
            # SB3 each have their own layer here.
            footprint = geometry["footprint_area"]
            floors = stated_floors or (survey.get("levels") if survey else None) \
                or geometry["estimated_floors"]

            # A stated floor count that implies an absurd storey height is a
            # placeholder, not a survey. Elkraftteknik arrives from graph.json
            # as ['1'] against a 13.2 m Rhino height - one storey four metres
            # taller than a typical lab floor. `stated_floors or ...` cannot
            # catch this on its own because 1 is truthy, so the placeholder wins
            # over a better estimate.
            implied_storey = geometry["height"] / max(1, floors)
            if implied_storey > IMPLAUSIBLE_STOREY_HEIGHT:
                notes.append(
                    f"{name}: stated {floors} floor(s) against a "
                    f"{geometry['height']:.1f} m height implies "
                    f"{implied_storey:.1f} m per storey. Treated as a "
                    f"placeholder and replaced with "
                    f"{geometry['estimated_floors']} from the height."
                )
                floors = geometry["estimated_floors"]
                stated_floors = None   # no longer a sourced value

            source = "Rhino model (union)"
            if survey and abs(survey["footprint_m2"] - footprint) / footprint > 0.15:
                notes.append(
                    f"{name}: Rhino gives {footprint:,.0f} m2, the footprint "
                    f"dataset {survey['footprint_m2']:,.0f} m2 "
                    f"({survey['matched_name']!r}, {survey['match_tier']}). Used "
                    f"Rhino - its layer is specific to this building."
                )
        elif survey is not None:
            footprint = survey["footprint_m2"]
            floors = stated_floors or survey.get("levels") or 1
            source = f"{survey['dataset'].split(' via ')[0]} ({survey['match_tier']})"
            if not stated_floors and not survey.get("levels"):
                notes.append(f"{name}: footprint known but no floor count; assumed 1.")
        elif gross_area > 0:
            footprint = gross_area / (stated_floors or 1)
            floors = stated_floors or 1
            source = "graph.json"
        else:
            footprint, floors, source = 0.0, 1, "none"
            notes.append(f"{name}: NO AREA from Rhino or graph.json. Sent as 0.")

        # A building is "verified" only when demand, footprint and floor count
        # all come from a real source - no height/3.5 estimates, no defaults.
        # stated_floors covers graph.json and the energy certificate; OSM's
        # building:levels is surveyed too and counts as real.
        floors_is_real = bool(stated_floors) or bool(
            survey.get("levels") if survey else None)
        if verified_only and not (csv_path is not None and footprint > 0 and floors_is_real):
            unverified.append(name)
            continue

        entry: dict = {
            "name": name,
            "owner": node.get("owner") or "Akademiska Hus",
            "building_type": node.get("building_type") or "College",
            "footprint_area": round(footprint, 2),
            "number_of_floors": floors,
            "pv_plants": [p["name"] for p in pv_by_building.get(name, [])],
        }

        # Roof arrays present in Rhino but missing from graph.json.
        override = PV_OVERRIDES.get(name)
        if override:
            for plant in override["plants"]:
                extra = dict(plant)
                extra.setdefault("system_loss", 14.0)
                extra["module"] = dict(override["module"], cost_per_kwp=3100.0,
                                       embodied_co2_per_kwp=615.0)
                pv_by_building.setdefault(name, []).append(extra)
                entry["pv_plants"].append(extra["name"])
            notes.append(f"{name}: added {len(override['plants'])} roof array(s) "
                         f"from the Rhino model. {override['note']}")
        area_sources[source] = area_sources.get(source, 0) + 1

        if csv_path is not None:
            entry["demand"] = {"csv_path": str(csv_path)}
        else:
            entry["demand"] = {"annual_kwh": 1.0, "shape": [1.0] * 24}
            notes.append(f"{name}: NO DEMAND DATA. Included with a placeholder "
                         f"1 kWh/year because --include-without-demand was set.")

        position = coords.get(key)
        if position is not None:
            entry["location"] = {"x": round(position[0], 2), "y": round(position[1], 2)}
        else:
            notes.append(f"{name}: no map coordinates; the graph will place it "
                         f"with the force layout.")

        buildings.append(entry)
        pv_plants.extend(pv_by_building.get(name, []))

    pv_plants.extend(community_pv)

    # --- battery and charge point ------------------------------------------
    batteries = []
    for node_id, node in nodes.items():
        if not node_id.startswith("BAT_"):
            continue
        capacity = float(node.get("capacity") or 0.0)
        if capacity <= 0:
            notes.append(f"{node_id}: capacity is 0, skipped")
            continue
        efficiency = float(node.get("efficiency") or DEFAULT_ROUND_TRIP_PCT)
        if efficiency < IMPLAUSIBLE_ROUND_TRIP_PCT:
            notes.append(
                f"{node_id}: round-trip efficiency is {efficiency:.0f}%, which is "
                f"not a battery - lithium systems are 85-95%. Treated as a "
                f"placeholder and replaced with {DEFAULT_ROUND_TRIP_PCT:.0f}%. "
                f"Fix the Grasshopper input to carry the real datasheet figure."
            )
            efficiency = DEFAULT_ROUND_TRIP_PCT
        soc_kwh = float(node.get("initial_soc") or 0.0)
        battery_entry = {
            "name": str(node.get("name") or node_id[4:]),
            "capacity": round(capacity, 2),
            "cost_per_kwh": round(float(node.get("cost_per_kwh") or 5000.0), 2),
            "embodied_co2_per_kwh": round(float(node.get("embodied_co2_per_kwh") or 120.0), 2),
            "efficiency": round(efficiency, 2),
            "lifespan": round(float(node.get("lifespan") or 15.0), 2),
            # graph.json stores the fraction already divided by 100.
            "degradation": round(float(node.get("degradation") or 0.02) * 100.0, 3),
            "initial_soc_fraction": round(min(1.0, soc_kwh / capacity), 4),
        }
        where = position_for(coords, node.get("name"), node_id, "Battery")
        if where:
            battery_entry["location"] = where
        batteries.append(battery_entry)

    charge_points = []
    for node_id, node in nodes.items():
        if not node_id.startswith("CP_"):
            continue
        cp_entry = {
            "name": str(node.get("name") or node_id[3:]),
            "capacity": round(float(node.get("capacity") or 22.0), 2),
            "charger_type": str(node.get("charger_type") or "AC Level 2"),
            "is_v2g": bool(node.get("is_v2g")),
            "owner": node.get("owner") or "Akademiska Hus",
            "ev": {
                "name": f"{node.get('name') or node_id[3:]}-EV",
                "capacity": 60.0,
                "max_charging_power": min(11.0, float(node.get("capacity") or 22.0)),
                "daily_distance": 40.0,
                "v2g_enabled": bool(node.get("is_v2g")),
                "availability": [1] * 7 + [0] * 11 + [1] * 6,
            },
        }
        where = position_for(coords, node.get("name"), node_id)
        if where:
            cp_entry["location"] = where
        charge_points.append(cp_entry)
        notes.append(
            f"{node_id}: graph.json records no vehicle details, only that "
            f"{node.get('total_connected_evs', 0)} EV is connected. A 60 kWh "
            f"vehicle on an overnight schedule was assumed."
        )

    definition = {
        "name": f"Chalmers Campus {year}" + (" (verified subset)" if verified_only else ""),
        "buildings": buildings,
        "pv_plants": pv_plants,
        "batteries": batteries,
        "charge_points": charge_points,
        "grid": {
            "name": "SE3",
            "buying_price": {"fixed": 1.35},
            "selling_price": {"fixed": 0.55},
            "carbon_intensity": {"fixed": 41.0},
            **({"location": grid_where} if (grid_where := position_for(coords, "GRID")) else {}),
            **GRID_SUBSTATION,
        },
        "analysis_period": {
            "start_month": 6, "start_day": 1, "start_hour": 0,
            "end_month": 6, "end_day": 2, "end_hour": 23,
        },
        "dispatch_mode": "community",
    }

    if unverified:
        notes.insert(0, f"VERIFIED SUBSET: dropped {len(unverified)} building(s) "
                        f"lacking a real demand, footprint or floor count.")
    if skipped:
        notes.insert(0, f"EXCLUDED {len(skipped)} building(s) with no demand "
                        f"data: {', '.join(skipped)}. Re-run with "
                        f"--include-without-demand to keep them as placeholders.")
    notes.insert(0, "Footprint areas by source: " + ", ".join(
        f"{count} from {source}" for source, count in sorted(area_sources.items())))
    return definition, notes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", default="2022", choices=["2022", "2023"],
                        help="Demand year. The existing graph.json was built "
                             "from 2022 (35/35 buildings match within 2%%).")
    parser.add_argument("-o", "--output", type=Path,
                        default=Path(__file__).resolve().parents[1] / "data" / "campus_community.json")
    parser.add_argument("--verified-only", action="store_true",
                        help="Keep only buildings whose demand, footprint and "
                             "floor count all come from a real source.")
    parser.add_argument("--include-without-demand", action="store_true",
                        help="Keep buildings that have no CSV, using a "
                             "placeholder demand of 1 kWh/year.")
    args = parser.parse_args()

    definition, notes = build(args.year, args.include_without_demand, args.verified_only)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(definition, indent=2, ensure_ascii=False),
                           encoding="utf-8")

    print(f"Wrote {args.output}")
    print(f"  buildings     {len(definition['buildings'])}")
    print(f"  PV plants     {len(definition['pv_plants'])}")
    print(f"  batteries     {len(definition['batteries'])}")
    print(f"  charge points {len(definition['charge_points'])}")
    print(f"  size          {args.output.stat().st_size / 1024:.1f} kB")

    if notes:
        print(f"\n{len(notes)} note(s):")
        for note in notes:
            print(f"  - {note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
