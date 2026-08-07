"""Size a battery or a PV fleet by sweeping it.

LEC-Opt cannot size anything: bess_capacity is a plain float on the building
object, used in variable bounds and as a divisor in the SOC balance, never a
pyo.Var. It optimises operation for a battery you have already chosen.

Sizing therefore has to be an outer loop - solve at each candidate size and
compare. That makes it N times the cost of one run, which is why it reports
progress per point and why the caller should keep the day count small.
"""
from __future__ import annotations

import copy
from typing import Callable, Optional

from app.schemas.community import CommunitySpec
from app.services.nordpool import NordPoolClient
from app.services.optimize import run_optimization

MAX_POINTS = 12


def _with_battery(spec: CommunitySpec, capacity_kwh: float) -> CommunitySpec:
    """Same community, one battery resized. Zero removes storage entirely."""
    clone = spec.model_copy(deep=True)
    if capacity_kwh <= 0:
        clone.batteries = []
        return clone
    if not clone.batteries:
        raise ValueError(
            "the community has no battery to resize; add one before sweeping")
    # Put the whole amount on the first battery and drop the rest, so the swept
    # quantity is unambiguous.
    first = clone.batteries[0]
    first.capacity = capacity_kwh
    clone.batteries = [first]
    return clone


def _with_pv_coverage(spec: CommunitySpec, percent: float) -> CommunitySpec:
    """Same community, every PV plant set to one roof coverage."""
    clone = spec.model_copy(deep=True)
    if percent <= 0:
        clone.pv_plants = []
        for building in clone.buildings:
            building.pv_plants = []
        return clone
    if not clone.pv_plants:
        raise ValueError(
            "the community has no PV plants to resize; add PV before sweeping")
    for plant in clone.pv_plants:
        plant.percentage = percent
    return clone


def run_sweep(
    spec: CommunitySpec,
    variable: str,
    values: list[float],
    days: Optional[int] = None,
    horizon_hours: int = 36,
    store_hours: int = 24,
    aging: bool = False,
    v2g: bool = False,
    parameters=None,
    nordpool: Optional[NordPoolClient] = None,
    progress: Optional[Callable[[str], None]] = None,
) -> dict:
    """Solve once per value and return the cost curve."""
    if variable not in ("battery_kwh", "pv_percent"):
        raise ValueError(f"unknown sweep variable {variable!r}")
    if not values:
        raise ValueError("no values to sweep")
    if len(values) > MAX_POINTS:
        raise ValueError(
            f"{len(values)} points requested; the cap is {MAX_POINTS} because "
            f"each point is a full optimisation")

    build = _with_battery if variable == "battery_kwh" else _with_pv_coverage

    points = []
    failures = []
    for index, value in enumerate(sorted(values), start=1):
        if progress:
            progress(f"point {index}/{len(values)}: {variable}={value:g}")
        try:
            candidate = build(spec, value)
        except ValueError as err:
            raise ValueError(str(err)) from err

        try:
            result = run_optimization(
                candidate,
                days=days,
                horizon_hours=horizon_hours,
                store_hours=store_hours,
                aging=aging,
                v2g=v2g,
                nordpool=nordpool,
                parameters=parameters,
            )
        except Exception as err:  # one bad point should not lose the curve
            failures.append({"value": value, "error": str(err)[:200]})
            continue

        totals = result["totals"]
        points.append({
            "value": value,
            "overall_cost": totals["overall_cost"],
            "supplier_cost": totals["supplier_cost"],
            "dso_cost": totals["dso_cost"],
            "tax_cost": totals["tax_cost"],
            "grid_import_kwh": totals["grid_import_kwh"],
            "grid_export_kwh": totals["grid_export_kwh"],
            "peak_net_import_kw": totals["peak_net_import_kw"],
        })

    if not points:
        raise ValueError("every point failed; see the failures list")

    best = min(points, key=lambda p: p["overall_cost"])
    baseline = points[0]
    saving = baseline["overall_cost"] - best["overall_cost"]

    notes = []
    if best is baseline:
        notes.append(
            "The cheapest point is the smallest one swept, so the optimum may "
            "lie below this range - or the extra capacity does not pay for "
            "itself over this period.")
    if best is points[-1]:
        notes.append(
            "The cheapest point is the largest one swept, so the optimum may "
            "lie above this range.")
    if failures:
        notes.append(f"{len(failures)} point(s) failed and are missing from the curve.")

    return {
        "variable": variable,
        "unit": "kWh" if variable == "battery_kwh" else "% roof",
        "days": points and days or days,
        "points": points,
        "best": best,
        "baseline": baseline,
        "saving_vs_baseline": saving,
        "failures": failures,
        "notes": notes,
    }
