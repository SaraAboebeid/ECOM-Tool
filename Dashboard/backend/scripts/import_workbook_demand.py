"""Pull a building's measured demand out of the campus workbook.

The community is built from Data/energy_data/*.csv - one file per building per
year, "hoy,value", 8760 rows - and a building with no file is dropped from the
community entirely. That is why AWL was missing from the table: it has a
footprint, a Rhino model and a node in graph.json, but no CSV.

The measurements live in a workbook with a sheet per building:

    Chalmers_campus_data_1.xlsx
        07.44 AWL      Time | El | Synthetic_tag | electricity_load |
                       pv_production | bus | bess_capacity | bess_power | ...

This writes one of those sheets out in the convention build_campus_definition.py
reads, which is the filename doing the matching:

    Data/energy_data/07.44_AWL_2022.csv     ->  slug "awl"  ->  node "AWL"

    python scripts/import_workbook_demand.py --sheet "07.44 AWL" --year 2022
    python scripts/import_workbook_demand.py --list

A WORD ABOUT VINTAGES. The CSVs already in Data/energy_data do not come from
this workbook - or not from this revision of it. Checked hour by hour, Fysik
origo 2022 disagrees at 1,131 of 8,760 hours (up to 10.7 kWh in one hour, 0.004%
over the year) and HA 2022 at 1,359. So a file written from here sits beside
files from a different vintage. That is a reason to be told, not a reason to
stop: the difference is small, and a building missing from the community is a
much larger error than a building whose hours are from a later revision.

Existing files are never overwritten without --force, so importing one building
cannot quietly replace the set.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

BACKEND = Path(__file__).resolve().parents[1]
ECOM_ROOT = BACKEND.parents[1]
ENERGY_DATA = ECOM_ROOT / "Data" / "energy_data"
DEFAULT_BOOK = Path.home() / "Desktop" / "EIVI" / "Data" / "Chalmers_campus_data_1.xlsx"

# The column the existing CSVs hold: hourly electricity taken by the building.
# 'El' is identical to it wherever both exist; 'electricity_load' is the one
# named for what it is.
LOAD_COLUMN = "electricity_load"
FALLBACK_COLUMN = "El"


def out_name(sheet: str, year: int) -> str:
    """'07.44 AWL' -> '07.44_AWL_2022.csv', which is what the builder matches."""
    return sheet.strip().replace(" ", "_") + f"_{year}.csv"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book", type=Path, default=DEFAULT_BOOK)
    parser.add_argument("--sheet", help="sheet name, e.g. '07.44 AWL'")
    parser.add_argument("--year", type=int, default=2022)
    parser.add_argument("--list", action="store_true", help="list the sheets and stop")
    parser.add_argument("--force", action="store_true", help="overwrite an existing CSV")
    args = parser.parse_args()

    if not args.book.is_file():
        sys.exit(f"no workbook at {args.book}")

    book = pd.ExcelFile(args.book)
    if args.list or not args.sheet:
        print(f"{args.book.name}: {len(book.sheet_names)} sheets")
        for name in book.sheet_names:
            print("   ", name)
        if not args.sheet:
            sys.exit(0 if args.list else "nothing to do: pass --sheet")
        return

    if args.sheet not in book.sheet_names:
        sys.exit(f"no sheet named {args.sheet!r}. Try --list.")

    frame = book.parse(args.sheet)
    column = (LOAD_COLUMN if LOAD_COLUMN in frame.columns
              else FALLBACK_COLUMN if FALLBACK_COLUMN in frame.columns else None)
    if column is None:
        sys.exit(f"{args.sheet!r} has neither {LOAD_COLUMN!r} nor {FALLBACK_COLUMN!r}: "
                 f"{list(frame.columns)}")

    frame["Time"] = pd.to_datetime(frame["Time"])
    year = frame[frame["Time"].dt.year == args.year].copy()
    if year.empty:
        sys.exit(f"{args.sheet!r} has no rows for {args.year}")

    # A year is 8760 hours. A leap year has 8784, and the dispatch reads the
    # series by hour of year, so a longer one would walk off the end of every
    # other building's day. Trimmed rather than accepted quietly.
    hours = len(year)
    values = year[column].to_numpy()[:8760]
    if len(values) < 8760:
        sys.exit(f"{args.sheet!r} has only {len(values)} hours in {args.year}")

    missing = int(pd.isna(values).sum())
    if missing:
        sys.exit(f"{args.sheet!r} has {missing} missing hours in {args.year}")

    # Negative hours mean the meter is net: the building was exporting, so
    # there is generation behind it and this column is consumption MINUS that
    # generation, not what the building used. Written anyway - SB3's committed
    # 2023 file already looks like this - but said out loud, because if the
    # definition also attaches a PV array to this building, the dispatch counts
    # the same sunshine twice. AWL 2023 is the case that found this: 625
    # negative hours, April to August, daytime, none marked synthetic.
    negative = int((values < 0).sum())
    synthetic = (int(year["Synthetic_tag"].iloc[:8760].sum())
                 if "Synthetic_tag" in year.columns else None)

    ENERGY_DATA.mkdir(parents=True, exist_ok=True)
    target = ENERGY_DATA / out_name(args.sheet, args.year)
    if target.exists() and not args.force:
        sys.exit(f"{target.name} exists already. Pass --force to replace it - but "
                 f"read the note about vintages at the top of this script first.")

    out = pd.DataFrame({"hoy": range(1, 8761), "value": values})
    out.to_csv(target, index=False)

    print(f"wrote {target.relative_to(ECOM_ROOT)}")
    print(f"   from {args.sheet!r}, column {column!r}, {args.year}")
    print(f"   {hours} hours in the sheet, 8760 written")
    print(f"   {values.sum():,.0f} kWh over the year, "
          f"peak {values.max():,.1f} kW, lowest {values.min():,.1f} kW")
    if synthetic is not None:
        print(f"   {synthetic} of the hours are marked synthetic (gap-filled)")
    if negative:
        print(f"\n   WARNING: {negative} hours are negative. This meter is NET - it has "
              f"generation behind it, so these values are consumption minus that "
              f"generation. If the campus definition also gives this building a PV "
              f"array, its sunshine is counted twice in {args.year}.")
    print("\nNow rebuild what reads it:")
    print("   python scripts/build_campus_definition.py --year", args.year)
    print("   python scripts/export_mr_layer.py")


if __name__ == "__main__":
    main()
