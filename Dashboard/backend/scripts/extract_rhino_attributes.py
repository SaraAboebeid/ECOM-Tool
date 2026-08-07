"""Extract building attribute metadata stored as Rhino user text.

READ ONLY. Several objects in the campus models carry a survey-style attribute
record - floor count, height, footprint, construction year, materials - keyed by
the same 07.XX_Name codes as the energy CSVs. This is far better than inferring
floors from height / 3.5 m.

    python scripts/extract_rhino_attributes.py

Two caveats found in the data and reported rather than silently corrected:

* Some records are shifted by one field, so 'Construction year' holds a building
  use and 'Number of floors' holds a floor-to-floor height in mm. Records are
  flagged when a value fails a plausibility check.
* The same building appears on several sub-layers with differing floor counts
  (Gamla Matte parts report 3 and 5), because the parts genuinely differ in
  height. The maximum is kept and the spread reported.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import rhino3dm as r3

ECOM_ROOT = Path(__file__).resolve().parents[3]
MODELS = [
    ECOM_ROOT / "Model" / "Campus3D model 20022025.3dm",
    ECOM_ROOT / "Model" / "background image.3dm",
]

# Field name -> (canonical key, plausible range). The range is what flags the
# off-by-one shifts rather than letting nonsense through.
FIELDS = {
    "building name": ("building_code", None),
    "fid": ("fid", None),
    "property designation": ("property", None),
    "address": ("address", None),
    "construction year": ("construction_year", None),
    "building use": ("use", None),
    "building footprint (epsg 3006) (m2)": ("footprint_m2", (20.0, 50000.0)),
    "number of floors": ("floors", (1.0, 40.0)),
    "building height": ("height_m", (2.0, 150.0)),
}


def canonical(key: str) -> tuple[str, tuple | None] | None:
    # Keys appear as both "Number of floors" and "number_of_floors".
    cleaned = key.strip().lower().rstrip(":").replace("_", " ")
    for pattern, mapping in FIELDS.items():
        if cleaned.startswith(pattern):
            return mapping
    return None


def as_number(value: str) -> float | None:
    try:
        return float(str(value).replace(",", ".").strip())
    except (TypeError, ValueError):
        return None


def collect(model_path: Path) -> dict[str, list[dict]]:
    model = r3.File3dm.Read(str(model_path))
    layers = {i: layer.FullPath for i, layer in enumerate(model.Layers)}
    records: dict[str, list[dict]] = defaultdict(list)

    for obj in model.Objects:
        try:
            strings = dict(obj.Attributes.GetUserStrings() or {})
        except Exception:
            continue
        if not strings:
            continue

        record: dict = {"layer": layers.get(obj.Attributes.LayerIndex, "?"),
                        "source": model_path.name, "suspect": []}
        for raw_key, raw_value in strings.items():
            mapped = canonical(raw_key)
            if mapped is None:
                continue
            key, valid = mapped
            if valid is None:
                record[key] = raw_value
                continue
            number = as_number(raw_value)
            if number is None or not (valid[0] <= number <= valid[1]):
                record["suspect"].append(f"{key}={raw_value!r}")
                continue
            record[key] = number

        label = record.get("building_code") or record["layer"]
        records[str(label)].append(record)

    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-o", "--output", type=Path,
                        default=Path(__file__).resolve().parents[1] / "data" / "rhino_attributes.json")
    args = parser.parse_args()

    merged: dict[str, dict] = {}
    for model in MODELS:
        if not model.is_file():
            print(f"skipping missing {model.name}", file=sys.stderr)
            continue
        print(f"Reading {model.name} ({model.stat().st_size / 1e6:.0f} MB), read-only...")
        for label, records in collect(model).items():
            entry = merged.setdefault(label, {
                "building_code": label, "parts": 0, "sources": set(),
                "layers": set(), "suspect": [], "floors_seen": [], "heights_seen": [],
            })
            for record in records:
                entry["parts"] += 1
                entry["sources"].add(record["source"])
                entry["layers"].add(record["layer"])
                entry["suspect"].extend(record["suspect"])
                if "floors" in record:
                    entry["floors_seen"].append(record["floors"])
                if "height_m" in record:
                    entry["heights_seen"].append(record["height_m"])
                for key in ("fid", "property", "address", "construction_year",
                            "use", "footprint_m2"):
                    if key in record and key not in entry:
                        entry[key] = record[key]

    out: dict[str, dict] = {}
    for label, entry in sorted(merged.items()):
        floors = entry.pop("floors_seen")
        heights = entry.pop("heights_seen")
        entry["sources"] = sorted(entry["sources"])
        entry["layers"] = sorted(entry["layers"])
        entry["suspect"] = sorted(set(entry["suspect"]))
        if floors:
            entry["floors"] = max(floors)
            if len(set(floors)) > 1:
                entry["floors_range"] = [min(floors), max(floors)]
        if heights:
            entry["height_m"] = max(heights)
        out[label] = entry

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\nWrote {args.output}\n")
    print(f"{'building code':26} {'floors':>7} {'height':>8} {'footprint':>10} {'parts':>6}  use")
    for label, entry in out.items():
        print(f"{label[:26]:26} {entry.get('floors', '-'):>7} "
              f"{entry.get('height_m', '-'):>8} {entry.get('footprint_m2', '-'):>10} "
              f"{entry['parts']:>6}  {entry.get('use', '')}")
        if entry["suspect"]:
            print(f"{'':26} SUSPECT (field shift?): {', '.join(entry['suspect'][:4])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
