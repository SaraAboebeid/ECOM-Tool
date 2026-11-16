"""Measured PV production, for the plants that have a meter.

Every other plant gets a PVGIS simulation (see pvgis_cache). A plant named here
takes its hourly output from the building's own PV meter instead - the files in
Data/pv written by scripts/import_pv_meter.py - so what the table shows for it
is what the panels did, not what a model says they should.

The meter covers a whole building, not one array. So the profile is stored per
kWp, by dividing the metered energy by `reference_kwp`, and scaled by whatever a
plant's installed capacity is. At the reference capacity the plants together
reproduce the meter exactly; resizing them scales that real shape up or down,
which is what the controller's slider and kW box do.

`reference_kwp` is the capacity the meter's energy corresponds to. It is not
recorded anywhere in the data. It is inferred, and it is the number to replace
when the real installed kWp is known - see MEASURED below.
"""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Optional

import pandas as pd

HOURS_PER_YEAR = 8760

# Dashboard/backend/app/services/pv_measured.py -> ECOM/
_DEFAULT_DIR = Path(__file__).resolve().parents[4] / "Data" / "pv"

MEASURED = [
    {
        # Both SB2 arrays share one meter, so both take the same per-kWp shape.
        "plants": re.compile(r"^SB2-PV"),
        "csv": "sb2_pv_2022.csv",
        # 35,507 kWh metered in 2022 / ~767 kWh per kWp (what PVGIS gives for
        # these two orientations) = 46.3 kWp, rounded to what the arrays hold at
        # the coverage set in campus_community.json (23.2 + 22.8 kW).
        # REPLACE with the real installed capacity when it is known.
        "reference_kwp": 46.0,
    },
]

_lock = threading.Lock()
_cache: dict[str, list[float]] = {}


def data_dir() -> Path:
    override = os.environ.get("ECOM_PV_DIR")
    return Path(override).expanduser() if override else _DEFAULT_DIR


def _entry_for(plant_name: str) -> Optional[dict]:
    for entry in MEASURED:
        if entry["plants"].match(plant_name or ""):
            return entry
    return None


def is_measured(plant_name: str) -> bool:
    return _entry_for(plant_name) is not None


def profile_per_kwp_wh(plant_name: str) -> Optional[list[float]]:
    """Hourly Wh for 1 kWp, from the plant's meter - or None if it has none.

    Raises if the meter file is missing or the wrong length. A plant that has a
    meter must not quietly fall back to the simulation: the table would then
    show modelled output as if it were measured, which is the thing this exists
    to prevent.
    """
    entry = _entry_for(plant_name)
    if entry is None:
        return None

    key = entry["csv"]
    with _lock:
        if key in _cache:
            return _cache[key]

    path = data_dir() / entry["csv"]
    if not path.is_file():
        raise FileNotFoundError(
            f"{plant_name!r} is a metered plant but {path} does not exist. Run "
            f"scripts/import_pv_meter.py to write it, or take the plant out of "
            f"pv_measured.MEASURED.")
    kwh = pd.read_csv(path)["kwh"].astype(float).tolist()
    if len(kwh) != HOURS_PER_YEAR:
        raise ValueError(f"{path} has {len(kwh)} rows, expected {HOURS_PER_YEAR}")

    per_kwp_wh = [v * 1000.0 / entry["reference_kwp"] for v in kwh]
    with _lock:
        _cache[key] = per_kwp_wh
    return per_kwp_wh
