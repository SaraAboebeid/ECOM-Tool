"""Run the LEC rolling-horizon optimizer on a CommunitySpec.

The dispatcher applies a fixed priority order (self-consumption, then peers,
then battery, then grid). The optimizer instead minimises cost over a 36-hour
look-ahead, so it will charge a battery in cheap hours to cover expensive ones
and shift EV charging within its plugged-in window. Comparing the two is the
point: the difference is what the optimisation is worth.

Timing measured on this machine with HiGHS, 60-minute resolution:

    1 building   1 day     0.4 s
    6 buildings  1 day     1.6 s
    6 buildings  7 days    8.3 s
    36 buildings 1 day     9.0 s
    36 buildings 7 days   63.5 s

so roughly 0.25 s per building-day. A full campus year is about an hour, which
is why this runs as a job rather than inside a request.
"""
from __future__ import annotations

import contextlib
import io
import math
import sys
from pathlib import Path
from typing import Callable, Optional

import pandas as pd

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.builders.community import build_community
from app.schemas.community import CommunitySpec
from app.services.nordpool import NordPoolClient

LEC_OPT_ROOT = Path(__file__).resolve().parents[4] / "Optimization" / "LEC-Opt"

# functions1.py multiplies prices by 11.1/1000 to get SEK/kWh, so it expects
# EUR/MWh on the way in. Our specs are in SEK/kWh.
SEK_PER_EUR = 11.1
HOURS_PER_YEAR = 8760

DEFAULT_TEMPERATURE_C = 18.0

# functions1.building.__init__ sets self.efficiency = 0.93 (functions1.py:119)
# and the SOC balance at functions1.py:606 uses it. It is not a parameter.
LEC_OPT_FIXED_EFFICIENCY_PCT = 93.0


class OptimizerUnavailable(RuntimeError):
    """The optimizer or its solver could not be loaded."""


def _import_lec():
    if str(LEC_OPT_ROOT) not in sys.path:
        sys.path.insert(0, str(LEC_OPT_ROOT))
    try:
        import functions1
        return functions1
    except ImportError as err:
        raise OptimizerUnavailable(
            f"Could not import functions1 from {LEC_OPT_ROOT}: {err}. "
            f"Install pyomo and highspy."
        ) from err


def solver_status() -> dict:
    """Which solver the optimizer would use, and whether it is usable."""
    try:
        functions1 = _import_lec()
    except OptimizerUnavailable as err:
        return {"available": False, "detail": str(err)}

    import pyomo.environ as pyo

    name = functions1.SOLVER_NAME
    try:
        available = bool(pyo.SolverFactory(name).available(exception_flag=False))
    except Exception as err:
        return {"available": False, "solver": name, "detail": str(err)}
    return {
        "available": available,
        "solver": name,
        "time_limit_s": functions1.SOLVER_TIME_LIMIT,
        "detail": None if available else f"solver {name!r} is not installed or licensed",
    }


# --------------------------------------------------------------- inputs


def _hour_index(spec: CommunitySpec, extra_hours: int) -> pd.DatetimeIndex:
    """Hourly index covering the analysis period plus the look-ahead tail."""
    start = pd.Timestamp("2024-01-01") + pd.Timedelta(hours=spec.analysis_period.start_hoy)
    return pd.date_range(start, periods=spec.analysis_period.n_hours + extra_hours, freq="60min")


def _slice(values: list[float], spec: CommunitySpec, length: int) -> list[float]:
    """Take `length` hours from an 8760-value series, starting at the period."""
    start = spec.analysis_period.start_hoy
    out = [values[(start + i) % HOURS_PER_YEAR] for i in range(length)]
    return out


def build_optimizer_inputs(
    spec: CommunitySpec,
    lookahead_hours: int = 36,
    temperature_c: float = DEFAULT_TEMPERATURE_C,
    nordpool: Optional[NordPoolClient] = None,
) -> dict:
    """Translate a CommunitySpec into the five frames functions1 expects."""
    built = build_community(spec, nordpool=nordpool)
    index = _hour_index(spec, lookahead_hours)
    n = len(index)
    notes: list[str] = []

    # --- prices ---------------------------------------------------------
    buying = spec.grid.buying_price.expand()
    selling = spec.grid.selling_price.expand()
    to_eur_mwh = 1000.0 / SEK_PER_EUR
    prices = pd.DataFrame({
        "Spot prices": [v * to_eur_mwh for v in _slice(buying, spec, n)],
        # Reserve markets are out of scope until the dashboard exposes them.
        "FCRN prices": [0.0] * n,
        "FCRDU prices": [0.0] * n,
        "FCRDD prices": [0.0] * n,
        "Up reg prices": [v * to_eur_mwh for v in _slice(buying, spec, n)],
        "Down reg prices": [v * to_eur_mwh for v in _slice(selling, spec, n)],
    }, index=index)

    temperature = pd.DataFrame({"Temperature": [temperature_c] * n}, index=index)
    activation = pd.DataFrame(
        {k: [0.0] * n for k in ("FCR-N-up", "FCR-N-down", "FCR-D-up", "FCR-D-down")},
        index=index)

    # --- buildings ------------------------------------------------------
    # LEC-Opt models one battery per building; a CommunitySpec battery is
    # community-owned. Attach the total to the largest consumer and say so.
    total_battery = sum(b.capacity for b in spec.batteries)
    total_power = sum(b.capacity for b in spec.batteries)  # 1C unless specified
    host = None
    if total_battery > 0 and built.community.building:
        # Rank on the built objects: spec.demand.to_hourly_values() returns None
        # for CSV-backed demand, which silently scored every building as zero.
        host = max(built.community.building,
                   key=lambda b: float(b.electric_demand.df["value"].sum())).name
        notes.append(
            f"LEC-Opt puts a battery on a building, not on the community, so "
            f"{total_battery:,.0f} kWh of storage was attached to {host!r} (the "
            f"largest consumer). Flows between buildings and the battery will "
            f"differ from the dispatcher's community-level model."
        )

        # functions1.building.__init__ hardcodes self.efficiency = 0.93 and
        # uses it in the SOC balance, with no way to pass another value. A spec
        # that says otherwise is therefore honoured by the dispatcher and
        # ignored here, so the two models silently simulate different batteries.
        spec_efficiency = {b.efficiency for b in spec.batteries}
        if any(abs(e - LEC_OPT_FIXED_EFFICIENCY_PCT) > 0.5 for e in spec_efficiency):
            notes.append(
                f"Battery round-trip efficiency is "
                f"{', '.join(f'{e:.0f}%' for e in sorted(spec_efficiency))} in the "
                f"spec, but LEC-Opt hardcodes "
                f"{LEC_OPT_FIXED_EFFICIENCY_PCT:.0f}% (functions1.py:119) and "
                f"offers no way to override it. The optimizer therefore models a "
                f"different battery from the dispatcher; the cost comparison is "
                f"not like for like until they agree."
            )

        # Storage this small cannot shift anything, and a flat state of charge
        # then looks like a broken model rather than an unused one.
        peak_demand = max(
            (float(b.electric_demand.df["value"].max()) for b in built.community.building),
            default=0.0,
        )
        if peak_demand > 0 and total_battery < peak_demand * 0.25:
            notes.append(
                f"{total_battery:,.0f} kWh of storage against a {peak_demand:,.0f} kW "
                f"peak is under 15 minutes at full load, so the optimizer has "
                f"little to gain by cycling it and the state of charge may stay "
                f"flat."
            )

    building_data = {}
    for building in built.community.building:
        demand = building.electric_demand.df["value"].tolist()
        pv_total = [0.0] * HOURS_PER_YEAR
        for plant in getattr(building, "PV_plant", []):
            series = plant.hourly_result.df["value"].tolist()
            for i in range(min(len(series), HOURS_PER_YEAR)):
                pv_total[i] += series[i]

        is_host = building.name == host
        building_data[building.name] = pd.DataFrame({
            "electricity_load": _slice(demand, spec, n),
            "pv_production": _slice(pv_total, spec, n),
            "bess_capacity": [total_battery if is_host else 0.0] * n,
            "bess_power": [total_power if is_host else 0.0] * n,
        }, index=index)

    # --- EV sessions ----------------------------------------------------
    charging_point_data = {}
    for cp in spec.charge_points:
        rows = []
        if cp.ev is not None:
            for session_id, (start_h, end_h) in enumerate(
                    _availability_blocks(cp.ev.availability, n), start=1):
                arrival, departure = index[start_h], index[min(end_h, n - 1)]
                if departure <= arrival:
                    continue
                hours = (departure - arrival).total_seconds() / 3600.0
                reachable = cp.ev.capacity and (
                    0.3 + (min(cp.capacity, cp.ev.max_charging_power) * hours * 0.93)
                    / cp.ev.capacity)
                rows.append({
                    "Arrival": arrival,
                    "Departure": departure,
                    "Capacity": float(cp.ev.capacity),
                    "Max_Power": float(min(cp.capacity, cp.ev.max_charging_power)),
                    "Arrival SOC": 0.3,
                    "Desired SOC": round(min(0.8, reachable or 0.8), 3),
                    "ev_id": cp.ev.name,
                    "session_id": session_id,
                })
        charging_point_data[cp.name] = pd.DataFrame(
            rows, columns=["Arrival", "Departure", "Capacity", "Max_Power",
                           "Arrival SOC", "Desired SOC", "ev_id", "session_id"])

    return {
        "building_data": building_data,
        "charging_point_data": charging_point_data,
        "prices": prices,
        "temperature": temperature,
        "activation": activation,
        "start_date": index[0],
        "notes": notes,
        "built": built,
    }


def _availability_blocks(availability, horizon: int) -> list[tuple[int, int]]:
    """Contiguous plugged-in blocks, as (start_hour, end_hour) within horizon."""
    if not availability:
        return []
    pattern = list(availability)
    full = (pattern * (horizon // len(pattern) + 2))[:horizon]

    blocks, start = [], None
    for hour, value in enumerate(full):
        if value and start is None:
            start = hour
        elif not value and start is not None:
            blocks.append((start, hour))
            start = None
    if start is not None:
        blocks.append((start, horizon))
    # Sessions shorter than two hours are not worth modelling and trip the
    # toolkit's feasibility assertion.
    return [(a, b) for a, b in blocks if b - a >= 2]


# ------------------------------------------------------- parameter overrides


# Our parameter name -> the module-level name in functions1.py.
_PARAMETER_MAP = {
    "battery_efficiency": "EFFICIENCY",
    "battery_cost_eur_per_kwh": "BATTERY_COST_EUR_PER_KWH",
    "bess_soc_min": "BESS_SOC_MIN",
    "peak_multiplier": "PEAK_MULTIPLIER",
    "subscription_fee_sek_per_month": "SUBSCRIPTION_FEE_SEK_PER_MONTH",
    "effect_fee_sek_per_kw_month": "EFFECT_FEE_SEK_PER_KW_MONTH",
    "transmission_fee_sek_per_kwh": "TRANSMISSION_FEE",
    "transmission_health_incentive_sek_per_kwh": "TRANSMISSION_HEALTH_INCENTIVE",
    "compensation_fee_sek_per_kwh": "COMPENSATION_FEE",
    "energy_tax_sek_per_kwh": "ENERGY_TAX",
    "energy_certificate_sek_per_kwh": "ENERGY_CERTIFICATE",
    "vat_rate": "VAT_RATE",
    "solver_time_limit_s": "SOLVER_TIME_LIMIT",
}


@contextlib.contextmanager
def _applied_parameters(functions1, params):
    """Apply user parameters for the duration of one run, then restore them.

    These have to be set before the model is constructed, not after. The
    constraints and the objective read them during __init__, and
    pyo.Objective(rule=...) evaluates its rule immediately - so assigning to
    model.Effect_fee once the object exists changes nothing, because the
    expression was already built from the old float. That is why they are
    module-level constants in functions1.py rather than something we can patch
    onto the finished object.

    Restoring on exit matters: the module is imported once and reused, so
    without this one run's settings would leak into the next.
    """
    if params is None:
        yield
        return

    previous = {}
    for field, target in _PARAMETER_MAP.items():
        previous[target] = getattr(functions1, target)
        setattr(functions1, target, getattr(params, field))
    try:
        yield
    finally:
        for target, value in previous.items():
            setattr(functions1, target, value)


# --------------------------------------------------------------- run


def run_optimization(
    spec: CommunitySpec,
    days: Optional[int] = None,
    horizon_hours: int = 36,
    store_hours: int = 24,
    aging: bool = False,
    v2g: bool = False,
    temperature_c: float = DEFAULT_TEMPERATURE_C,
    nordpool: Optional[NordPoolClient] = None,
    progress: Optional[Callable[[str], None]] = None,
    parameters=None,
) -> dict:
    """Run the rolling-horizon optimizer and summarise the result."""
    functions1 = _import_lec()
    status = solver_status()
    if not status["available"]:
        raise OptimizerUnavailable(status["detail"] or "no solver available")

    lookahead = max(0, horizon_hours - store_hours)
    inputs = build_optimizer_inputs(spec, lookahead_hours=lookahead + 24,
                                    temperature_c=temperature_c, nordpool=nordpool)

    n_days = days if days else max(1, spec.analysis_period.n_hours // 24)
    if progress:
        progress(f"optimising {len(inputs['building_data'])} buildings over {n_days} day(s)")

    notes = list(inputs["notes"])
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), _applied_parameters(functions1, parameters):
        frame = functions1.optimization_function_lec(
            charging_point_data=inputs["charging_point_data"],
            building_data=inputs["building_data"],
            prices=inputs["prices"],
            temperature=inputs["temperature"],
            activation=inputs["activation"],
            start_date=inputs["start_date"],
            days=int(n_days),
            horizon_hours=int(horizon_hours),
            store_hours=int(store_hours),
            fcrn_on=0, fcrdd_on=0, fcrdu_on=0,
            aging=int(bool(aging)),
            v2g_on=int(bool(v2g)),
            dc=False,
            building_on=1,
            previous_monthly_peak=0.0,
            current_month=inputs["start_date"].month,
            initial_bess_soc=0.5,
            pv_on=1, bess_on=1,
        )

    if frame is None or len(frame) == 0:
        raise OptimizerUnavailable(
            "the optimizer returned no rows; the solver log is in the server output")

    return {
        "solver": status["solver"],
        "days": int(n_days),
        "hours": len(frame),
        "notes": notes,
        "totals": _totals(frame),
        "series": _series(frame),
        "log_tail": sink.getvalue().splitlines()[-12:],
    }


def _num(frame: pd.DataFrame, column: str) -> float:
    if column not in frame.columns:
        return 0.0
    value = float(frame[column].fillna(0.0).sum())
    return value if math.isfinite(value) else 0.0


def _totals(frame: pd.DataFrame) -> dict:
    resolution = 1  # the adapter always builds a 60-minute index
    return {
        "grid_import_kwh": _num(frame, "P_import_all") / resolution,
        "grid_export_kwh": _num(frame, "P_export_all") / resolution,
        "supplier_cost": _num(frame, "Supplier cost"),
        "transmission_cost": _num(frame, "Transmission cost"),
        "peak_cost": _num(frame, "Peak cost"),
        "dso_cost": _num(frame, "DSO cost"),
        "tax_cost": _num(frame, "Tax cost"),
        "fcrn_returns": _num(frame, "FCRN returns"),
        "fcrd_returns": _num(frame, "FCRD returns"),
        "overall_cost": _num(frame, "Overall cost"),
        "peak_net_import_kw": float(
            (frame.get("P_import_all", 0) - frame.get("P_export_all", 0)).max())
        if "P_import_all" in frame.columns else 0.0,
    }


def _series(frame: pd.DataFrame) -> dict:
    """Hourly series the dashboard can chart against the dispatch result."""
    wanted = ["P_import_all", "P_export_all", "Overall cost", "Supplier cost"]
    out = {c: [round(float(v), 4) for v in frame[c].fillna(0.0)]
           for c in wanted if c in frame.columns}
    out["soc"] = {c: [round(float(v), 4) for v in frame[c].fillna(0.0)]
                  for c in frame.columns if c.endswith("_bess_soc")}
    out["timestamps"] = [str(t) for t in frame.index]
    return out
