"""Turn a building's PV meter export into an hourly production file.

The campus meters (the `el_925` files under Database/El/PV in the building
folders) are *cumulative* counters read about once an hour:

    Tidpunkt             Ändrat av  Status    Värde     Norm.  Diff
    2022-12-31 23:00:01  EOV        Giltigt   204124.6

Hourly production is the rise of the counter across each hour, so this
interpolates the counter onto the clock hours and differences it. Only rows
marked Giltigt (valid) are used; the ones the system filled in itself
(INTERPOL / Ogiltigt, written as 0) would show as a drop to zero and back, and
are skipped, so the counter is interpolated across them instead.

    python scripts/import_pv_meter.py "<zip>" --entry "07.23 SB2/Database/El/PV/O0007023_el_925_v1_2022-01-01_2022-12-31.xlsx" --out sb2_pv_2022.csv

Writes Data/pv/<out> with columns hoy,kwh and exactly 8760 rows (clock hours of
the meter's own local time, hour 1 = 00:00-01:00 on 1 January), the same
convention as Data/energy_data.
"""
from __future__ import annotations

import argparse
import io
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ECOM_ROOT = Path(__file__).resolve().parents[3]
OUT_DIR = ECOM_ROOT / "Data" / "pv"

# A counter that reads the same number this long, then jumps this much, froze.
FROZEN_MIN_HOURS = 48
CATCHUP_MIN_KWH = 100.0


def hourly_from_counter(raw: pd.DataFrame, year: int) -> tuple[pd.DataFrame, dict]:
    d = raw.iloc[1:, 1:5].copy()
    d.columns = ["t", "by", "status", "v"]
    d["t"] = pd.to_datetime(d["t"], errors="coerce")
    d["v"] = pd.to_numeric(d["v"], errors="coerce")
    d = d.dropna(subset=["t", "v"]).sort_values("t", kind="stable")

    total = len(d)
    valid = d[d["status"] == "Giltigt"].drop_duplicates("t", keep="last")
    if valid["v"].diff().dropna().lt(0).any():
        sys.exit("the valid readings are not monotonic - this is not a cumulative counter")

    grid = pd.date_range(f"{year}-01-01", f"{year + 1}-01-01", freq="h")   # 8761 edges
    # Hours since the start of the year. Divided by a Timedelta rather than cast
    # to an integer: the timestamp unit (ns or us) depends on the pandas version,
    # and the thresholds below are in real hours.
    origin = pd.Timestamp(f"{year}-01-01")
    one_hour = pd.Timedelta(hours=1)
    xs = ((valid["t"] - origin) / one_hour).to_numpy(dtype=float)
    edges = ((grid - origin) / one_hour).to_numpy(dtype=float)
    counter = np.interp(edges, xs, valid["v"].to_numpy())
    kwh = np.diff(counter)
    if len(kwh) != 8760:
        sys.exit(f"expected 8760 hours, got {len(kwh)}")

    # A counter can freeze - still marked valid, reading the same number for
    # days - and then catch up in one step. SB2 sat at 176,023.6 from 21 to 28
    # April and then rose 1,704.7 kWh in a single hour, which as hourly data is a
    # 1,700 kW spike at midnight and eight days of nothing. The energy is real
    # but its timing is lost, so it is spread over the frozen days in the shape
    # of the following week's production (same hours of the day, weighted by
    # what the panels actually did then). Reported, never silent.
    repaired = []
    v, t = valid["v"].to_numpy(), xs
    run_start = 0
    for i in range(1, len(v)):
        if v[i] == v[i - 1]:
            continue
        frozen_h = t[i - 1] - t[run_start]
        rise = v[i] - v[i - 1]
        if frozen_h >= FROZEN_MIN_HOURS and rise >= CATCHUP_MIN_KWH:
            # Hours kwh[lo:hi] run from the freeze to the hour holding the jump.
            lo = int(np.searchsorted(edges, t[run_start], side="left"))
            hi = int(np.searchsorted(edges, t[i], side="left"))
            if hi + 24 * 7 > 8760:
                sys.exit(f"frozen counter at {valid['t'].iloc[run_start]} but no week "
                         f"of production after it to take the shape from")
            shape = kwh[hi: hi + 24 * 7].reshape(-1, 24).mean(axis=0)   # kWh by hour of day
            weight = shape[np.arange(lo, hi) % 24]
            if weight.sum() <= 0:
                sys.exit("no daylight weight inside the frozen span")
            energy = kwh[lo:hi].sum()                     # exactly what the window held
            kwh[lo:hi] = energy * weight / weight.sum()
            repaired.append((valid["t"].iloc[run_start], valid["t"].iloc[i], energy))
        run_start = i

    stats = {
        "repaired": repaired,
        "rows": total, "valid": len(valid), "invalid_skipped": total - len(valid),
        "first": valid["t"].iloc[0], "last": valid["t"].iloc[-1],
        "annual_kwh": float(kwh.sum()),
        "peak_kwh_per_hour": float(kwh.max()),
        "producing_hours": int((kwh > 0.05).sum()),
    }
    return pd.DataFrame({"hoy": range(1, 8761), "kwh": np.round(kwh, 4)}), stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("zip", type=Path)
    ap.add_argument("--entry", required=True, help="path of the .xlsx inside the zip")
    ap.add_argument("--year", type=int, default=2022)
    ap.add_argument("--out", required=True, help="file name written under Data/pv")
    args = ap.parse_args()

    with zipfile.ZipFile(args.zip) as z:
        raw = pd.read_excel(io.BytesIO(z.read(args.entry)), header=None)
    out, s = hourly_from_counter(raw, args.year)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / args.out
    out.to_csv(target, index=False)
    print(f"wrote {target}")
    print(f"  {s['rows']} readings, {s['valid']} valid, {s['invalid_skipped']} skipped as invalid")
    print(f"  valid from {s['first']} to {s['last']}")
    print(f"  annual {s['annual_kwh']:,.0f} kWh, peak {s['peak_kwh_per_hour']:.1f} kWh/h, "
          f"{s['producing_hours']} producing hours")
    for start, end, energy in s["repaired"]:
        print(f"  REPAIRED frozen counter {start} -> {end}: {energy:,.0f} kWh "
              f"spread over the frozen days")


if __name__ == "__main__":
    main()
