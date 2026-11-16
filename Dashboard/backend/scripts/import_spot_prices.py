"""Turn the ENTSO-E day-ahead export for SE3 into an hourly SEK/kWh file.

Source (as exported, semicolon separated, decimal point in the price column and
decimal comma in the rate column):

    MTU (CET/CEST);Day-ahead Price (EUR/MWh);<EUR->SEK rate>
    01/01/2022 00:00:00 - 01/01/2022 01:00:00;46.6;10,262

The third column is the EUR/SEK rate the export carries for that hour, so the
conversion uses it rather than a constant:  SEK/kWh = EUR/MWh * rate / 1000.

    python scripts/import_spot_prices.py "<path>/Elpriser SE3 2022-2024.csv" --year 2022

Writes Data/prices/se3_spot_<year>.csv with columns hoy,sek_per_kwh and exactly
8760 rows (hoy 1..8760, the same convention as Data/energy_data). Hours the
source lacks are reported and refused rather than filled; a leap year drops
29 February so the series stays 8760 long.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

ECOM_ROOT = Path(__file__).resolve().parents[3]
OUT_DIR = ECOM_ROOT / "Data" / "prices"


def convert(src: Path, year: int) -> pd.DataFrame:
    raw = pd.read_csv(src, sep=";", decimal=",", dtype=str, encoding="utf-8-sig")
    raw = raw.iloc[:, :3]
    raw.columns = ["mtu", "eur_mwh", "rate"]
    raw["eur_mwh"] = pd.to_numeric(raw["eur_mwh"], errors="coerce")
    raw["rate"] = pd.to_numeric(raw["rate"].str.replace(",", ".", regex=False),
                                errors="coerce")

    # The export has one row per elapsed hour. Daylight-saving days are written
    # with "(CET)"/"(CEST)" tags - 23 rows in March, 25 in October - so the
    # wall-clock labels are not unique. Counting rows is. A year is therefore a
    # run of rows, and where each one starts is checked against the label.
    first = raw["mtu"].str.contains(r"^01/01/\d{4} 00:00:00", regex=True)
    starts = list(raw.index[first])
    years = [int(raw["mtu"][i][6:10]) for i in starts]
    if year not in years:
        sys.exit(f"no 1 January {year} in {src}; the file starts years {years}")
    begin = starts[years.index(year)]
    year_rows = raw.iloc[begin:begin + 8760]
    nxt = begin + 8760
    if nxt < len(raw) and not raw["mtu"][nxt].startswith(f"01/01/{year + 1} 00:00"):
        sys.exit(f"{year} is not 8760 rows long: row {nxt} reads {raw['mtu'][nxt]!r}")
    if len(year_rows) != 8760:
        sys.exit(f"{year} has only {len(year_rows)} rows")

    bad = year_rows[year_rows["eur_mwh"].isna() | year_rows["rate"].isna()]
    if len(bad):
        sys.exit(f"{len(bad)} rows have no price or rate, first: {bad['mtu'].iloc[0]!r}")

    return pd.DataFrame({
        "hoy": range(1, 8761),
        "sek_per_kwh": (year_rows["eur_mwh"] * year_rows["rate"] / 1000.0).round(5).values,
    })


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source", type=Path)
    ap.add_argument("--year", type=int, default=2022)
    args = ap.parse_args()

    out = convert(args.source, args.year)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / f"se3_spot_{args.year}.csv"
    out.to_csv(target, index=False)
    s = out["sek_per_kwh"]
    print(f"wrote {target}  ({len(out)} rows)")
    print(f"SEK/kWh  mean {s.mean():.3f}  min {s.min():.3f}  max {s.max():.3f}  "
          f"negative hours {(s < 0).sum()}")


if __name__ == "__main__":
    main()
