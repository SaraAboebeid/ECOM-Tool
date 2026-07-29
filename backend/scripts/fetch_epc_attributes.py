"""Pull floor counts, heated area and energy performance from the Swedish EPC register.

READ ONLY against the energideklaration database assembled in the Project
Planning Guide project. Nothing in that project is modified.

    python scripts/fetch_epc_attributes.py

Method mirrors compare_floors.py there: take the EPC footprints, join them to
the certificate table, and spatially match to named building outlines.

WHAT THIS SOLVES
    EgenAntalPlan is a surveyed floor count, which is the single biggest gap in
    the campus model - height / 3.5 m was only ever a guess. EgenAtemp is the
    heated floor area, which is better than footprint x floors for energy
    intensity because it excludes unheated volume.

CAVEATS
    One certificate covers a whole complex and is repeated per entrance, so
    records are deduplicated by FormularId. Atemp is then the area of the whole
    complex, not of one address.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_EPC_DB = (Path.home() / "Desktop" / "Project Planning Guide" /
                  "Project-Planning-Guide" / "data" / "sensitivity" / "epc_sweden.duckdb")

# Chalmers owns the Johanneberg 31:x properties. Wider patterns pulled in
# unrelated Vasastaden and Lorensberg housing hundreds of metres away.
# Chalmers owns Johanneberg 31:x plus a few Krokslatt properties - 109:20 is
# Gamla Matte (confirmed by the Rhino attribute record) and 185:2 is Chalmers
# Teknikpark. Found by searching footprints for byggnadsnamn1 ILIKE '%chalmers%'.
PROPERTY_PATTERNS = [
    "JOHANNEBERG 31:%", "JOHANNEBERG 707:%",
    "KROKSLÄTT 109:%", "KROKSLÄTT 185:%",
]

# Centroid matching only. A certificate covering a complex sits between its
# buildings, so anything beyond this is more likely a neighbour than a match -
# at 60 m Horsal A was being matched to a building on Gibraltarvallsvagen.
MATCH_RADIUS_M = 20.0


ADDRESS_CACHE = BACKEND / "data" / "osm_addresses.json"
CAMPUS_BBOX = (57.6820, 11.9640, 57.6960, 11.9900)
ADDRESS_TO_OUTLINE_M = 45.0


def fetch_address_points(force: bool = False) -> dict[str, tuple[float, float]]:
    """Map 'street housenumber' -> (lon, lat) from OSM address objects.

    Building polygons on this campus carry no addr:* tags, but standalone
    address nodes exist for most streets. They give each certificate a precise
    position, which is far more reliable than the centroid of a complex.
    """
    if ADDRESS_CACHE.is_file() and not force:
        return {k: tuple(v) for k, v in
                json.loads(ADDRESS_CACHE.read_text(encoding="utf-8")).items()}

    import urllib.parse
    import urllib.request

    south, west, north, east = CAMPUS_BBOX
    query = f"""
    [out:json][timeout:120];
    (
      node["addr:housenumber"]({south},{west},{north},{east});
      way["addr:housenumber"]({south},{west},{north},{east});
    );
    out center tags;
    """
    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "ECOM4Future-research/1.0 (Chalmers)"},
    )
    payload = json.loads(urllib.request.urlopen(request, timeout=180).read())

    index: dict[str, tuple[float, float]] = {}
    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        street, number = tags.get("addr:street"), tags.get("addr:housenumber")
        if not (street and number):
            continue
        if element["type"] == "node":
            lon, lat = element.get("lon"), element.get("lat")
        else:
            centre = element.get("center") or {}
            lon, lat = centre.get("lon"), centre.get("lat")
        if lon is None or lat is None:
            continue
        index.setdefault(f"{street} {number}".strip().lower(), (lon, lat))

    ADDRESS_CACHE.parent.mkdir(parents=True, exist_ok=True)
    ADDRESS_CACHE.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    print(f"Cached {len(index)} OSM address points")
    return index


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--epc-db", type=Path, default=DEFAULT_EPC_DB)
    parser.add_argument("-o", "--output", type=Path,
                        default=BACKEND / "data" / "epc_attributes.json")
    args = parser.parse_args()

    if not args.epc_db.is_file():
        print(f"EPC database not found: {args.epc_db}", file=sys.stderr)
        return 1

    import duckdb
    from pyproj import Transformer

    con = duckdb.connect(str(args.epc_db), read_only=True)
    con.execute("INSTALL spatial; LOAD spatial;")

    where = " OR ".join(f"upper(f.fastighetsbeteckning) LIKE '{p}'" for p in PROPERTY_PATTERNS)
    rows = con.execute(f"""
        SELECT e.FormularId,
               any_value(e.EgenAntalPlan)          AS floors,
               any_value(e.EgenAntalKallarplan)    AS basement_floors,
               any_value(e.EgenAtemp)              AS atemp,
               any_value(e.EgenBTA)                AS bta,
               any_value(e.EgenNybyggAr)           AS built_year,
               any_value(e.EgenByggnadsTyp)        AS building_type,
               any_value(e.EgiEnergiPrestanda)     AS energy_performance,
               any_value(e.EgiEnergiklass)         AS energy_class,
               any_value(f.fastighetsbeteckning)   AS property,
               string_agg(DISTINCT e.IdAdr, ' | ') AS addresses,
               count(*)                            AS entrances,
               avg(ST_X(ST_Centroid(ST_GeomFromWKB(f.geom)))) AS lon,
               avg(ST_Y(ST_Centroid(ST_GeomFromWKB(f.geom)))) AS lat
        FROM footprints f
        JOIN epc e ON f.FormularId = e.FormularId
        WHERE {where}
        GROUP BY e.FormularId
    """).fetchall()
    con.close()
    print(f"{len(rows)} distinct certificates on the campus properties")

    to_sweref = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True).transform

    certificates = []
    for r in rows:
        (fid, floors, basement, atemp, bta, year, btype, performance,
         cls, prop, addresses, entrances, lon, lat) = r
        if lon is None or lat is None:
            continue
        x, y = to_sweref(lon, lat)
        certificates.append({
            "formular_id": fid,
            "floors": int(floors) if floors else None,
            "basement_floors": int(basement) if basement else None,
            "atemp_m2": float(atemp) if atemp else None,
            "bta_m2": float(bta) if bta else None,
            "built_year": year,
            "building_type": btype,
            "energy_performance_kwh_m2": float(performance) if performance else None,
            "energy_class": cls,
            "property": prop,
            "addresses": addresses,
            "entrances": entrances,
            "centroid_sweref": [round(x, 2), round(y, 2)],
        })

    # --- match to the named building outlines we already have ---------------
    osm_path = BACKEND / "data" / "osm_footprints.json"
    osm = json.loads(osm_path.read_text(encoding="utf-8")).get("buildings", []) \
        if osm_path.is_file() else []
    named = [b for b in osm if b.get("name") and b.get("centroid_sweref")]

    # Address index. A certificate lists every entrance, so any one of them
    # hitting a named outline identifies the building.
    by_address: dict[str, str] = {}
    for building in osm:
        if building.get("address") and building.get("name"):
            by_address.setdefault(building["address"].strip().lower(), building["name"])

    try:
        address_points = fetch_address_points()
    except Exception as err:
        print(f"could not fetch OSM address points: {err}", file=sys.stderr)
        address_points = {}

    for cert in certificates:
        cert["matched_outline"] = None
        cert["match_method"] = None
        cert["match_distance_m"] = None

        for address in (cert["addresses"] or "").split("|"):
            hit = by_address.get(address.strip().lower())
            if hit:
                cert["matched_outline"] = hit
                cert["match_method"] = f"address tag ({address.strip()})"
                break

        # Locate each entrance via an OSM address point, then take the named
        # outline nearest to it. Votes are pooled so the building serving the
        # most entrances wins.
        if cert["matched_outline"] is None and address_points:
            votes: dict[str, list[float]] = {}
            for address in (cert["addresses"] or "").split("|"):
                point = address_points.get(address.strip().lower())
                if not point:
                    continue
                ax, ay = to_sweref(point[0], point[1])
                near, near_d = None, None
                for building in named:
                    bx, by = building["centroid_sweref"]
                    d = math.hypot(bx - ax, by - ay)
                    if near_d is None or d < near_d:
                        near, near_d = building, d
                if near and near_d <= ADDRESS_TO_OUTLINE_M:
                    votes.setdefault(near["name"], []).append(near_d)
            if votes:
                winner = max(votes.items(), key=lambda kv: (len(kv[1]), -min(kv[1])))
                # SUGGESTION ONLY. Tested against known buildings this method
                # produces confident-looking errors: the Horsalsvagen 7A/7B
                # address points sit beside Horsal A, but the building there is
                # M-huset, so a 27,944 m2 certificate was assigned to a 1,085 m2
                # lecture hall. Plausibility guards on Atemp/footprint do not
                # separate the good from the bad either - they reject Fysik,
                # which is correct, and accept Linsen, which is not.
                cert["suggested_outline"] = winner[0]
                cert["suggested_method"] = (f"address point ({len(winner[1])} "
                                            f"entrance(s), nearest {min(winner[1]):.0f} m)")

        cx, cy = cert["centroid_sweref"]
        best, best_d = None, None
        for building in named:
            bx, by = building["centroid_sweref"]
            d = math.hypot(bx - cx, by - cy)
            if best_d is None or d < best_d:
                best, best_d = building, d
        cert["match_distance_m"] = round(best_d, 1) if best_d is not None else None

        if cert["matched_outline"] is None and best and best_d <= MATCH_RADIUS_M:
            cert["matched_outline"] = best["name"]
            cert["match_method"] = f"centroid ({best_d:.1f} m)"
            cert["outline_footprint_m2"] = best["footprint_m2"]

    certificates.sort(key=lambda c: -(c["atemp_m2"] or 0))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "source": str(args.epc_db),
        "note": "Swedish energideklaration register. One certificate can cover a "
                "whole complex, so atemp is complex-wide.",
        "certificates": certificates,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Wrote {args.output}\n")
    matched = [c for c in certificates if c["matched_outline"]]
    print(f"{'matched outline':34} {'Atemp':>9} {'fl':>3} {'yr':>5} {'kWh/m2':>7} {'cls':>4} {'d(m)':>5}")
    for c in certificates:
        if c["matched_outline"]:
            name = c["matched_outline"]
        elif c.get("suggested_outline"):
            name = "? " + c["suggested_outline"]
        else:
            name = "(unmatched) " + (c["addresses"] or "")[:22]
        atemp = f"{c['atemp_m2']:,.0f}" if c["atemp_m2"] else "-"
        perf = f"{c['energy_performance_kwh_m2']:.0f}" if c["energy_performance_kwh_m2"] else "-"
        print(f"{name[:34]:34} {atemp:>9} {str(c['floors'] or '-'):>3} "
              f"{str(c['built_year'] or '-'):>5} {perf:>7} "
              f"{str(c['energy_class'] or '-'):>4} {str(c['match_distance_m'] or '-'):>5}")
    print(f"\n{len(matched)}/{len(certificates)} certificates matched to a named outline "
          f"within {MATCH_RADIUS_M:.0f} m.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
