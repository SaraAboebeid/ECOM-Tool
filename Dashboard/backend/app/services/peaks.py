"""The busiest hour and the busiest day of each year of measured demand.

Somewhere to aim the table at. A campus day picked at random is a mild one, and
a battery or a tariff that looks fine on it has not been asked a hard question;
the peak hour is the hour the community would have to answer for, and the peak
day is the day a peak charge would be struck on.

Computed from the same CSVs the dispatch runs on - one file per building per
year, "hoy,value", 8760 rows - summed over every building in the scenario. No
weather model, no profile: the measured campus.

A WORD ABOUT THE CALENDAR. The model runs a fixed 365-day year with no leap day
(see app/schemas/period.py), so hour-of-year maps to month and day through a
non-leap calendar whatever the real year did. 2022 and 2023 are both non-leap,
so this is exact for the data on disk, and stays consistent with the controller
if a leap year ever arrives.
"""
from __future__ import annotations

import re
import threading
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

HOURS_PER_YEAR = 8760
HOURS_PER_DAY = 24
DAYS_PER_YEAR = 365

# Reading 37 files twice over is a second or so of disk; the controller asks on
# every load and the files do not change while the server is up.
_lock = threading.Lock()
_cache: dict[tuple, dict] = {}


def _read_series(path: Path) -> Optional[list[float]]:
    """kWh per hour of year, or None when the file is not there."""
    if not path.is_file():
        return None
    out = [0.0] * HOURS_PER_YEAR
    with path.open(encoding="utf-8") as handle:
        next(handle, None)  # header: hoy,value
        for line in handle:
            if not line.strip():
                continue
            parts = line.split(",")
            if len(parts) < 2:
                continue
            try:
                index = int(parts[0]) - 1
                value = float(parts[1])
            except ValueError:
                continue
            if 0 <= index < HOURS_PER_YEAR:
                out[index] = value
    return out


def _when(hour_of_year: int) -> tuple[int, int, int]:
    """0-based hour of year -> (month, day, hour) on a non-leap calendar."""
    day = date(2023, 1, 1) + timedelta(days=hour_of_year // HOURS_PER_DAY)
    return day.month, day.day, hour_of_year % HOURS_PER_DAY


def _for_year(definition: dict, year: int) -> Optional[dict]:
    """Totals for one year, or None if any building has no file for it.

    All or nothing, for the same reason the years endpoint is: a partial year
    would quietly drop members and report a peak for a smaller community than
    the one on the table.
    """
    total = [0.0] * HOURS_PER_YEAR
    counted = 0

    for building in definition.get("buildings") or []:
        demand = building.get("demand") or {}
        raw = demand.get("csv_path")
        if not raw:
            continue
        path = Path(re.sub(r"_20\d\d\.csv$", f"_{year}.csv", str(raw)))
        series = _read_series(path)
        if series is None:
            return None
        counted += 1
        for i, value in enumerate(series):
            total[i] += value

    if not counted:
        return None

    peak_hour = max(range(HOURS_PER_YEAR), key=total.__getitem__)
    month, day, hour = _when(peak_hour)

    daily = [
        sum(total[d * HOURS_PER_DAY:(d + 1) * HOURS_PER_DAY])
        for d in range(DAYS_PER_YEAR)
    ]
    peak_day = max(range(DAYS_PER_YEAR), key=daily.__getitem__)
    day_month, day_day, _ = _when(peak_day * HOURS_PER_DAY)
    busiest = max(
        range(HOURS_PER_DAY),
        key=lambda h: total[peak_day * HOURS_PER_DAY + h],
    )

    return {
        "year": year,
        "buildings": counted,
        "peak_hour": {
            "month": month, "day": day, "hour": hour,
            "kwh": round(total[peak_hour], 1),
        },
        "peak_day": {
            "month": day_month, "day": day_day,
            "kwh": round(daily[peak_day], 1),
            # Which hour of that day to drop the scrubber on, so the table
            # opens on the moment worth looking at rather than at midnight.
            "busiest_hour": busiest,
        },
    }


def for_scenario(definition: dict, years: list[int], key: tuple) -> dict:
    """Peaks for every year that has a complete set of files."""
    with _lock:
        if key in _cache:
            return _cache[key]

    found = [p for p in (_for_year(definition, y) for y in years) if p]
    answer = {"peaks": found}

    with _lock:
        _cache[key] = answer
    return answer
