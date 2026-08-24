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
from app.schemas.optimizer_params import OptimizerParameters

LEC_OPT_ROOT = Path(__file__).resolve().parents[4] / "Optimization" / "LEC-Opt"

# functions1.py multiplies prices by 11.1/1000 to get SEK/kWh, so it expects
# EUR/MWh on the way in. Our specs are in SEK/kWh.
SEK_PER_EUR = 11.1
HOURS_PER_YEAR = 8760

DEFAULT_TEMPERATURE_C = 18.0


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


# Name of the synthetic node that carries the community battery. Used as a
# Pyomo component prefix (f'{name}_bess_soc'), so it must stay free of spaces
# and punctuation.
COMMUNITY_STORAGE_NODE = "Community_Storage"


def _community_peak_kw(built) -> float:
    """Highest total demand across all buildings at any single hour.

    The sum at each hour, not the largest individual peak: buildings do not all
    peak together, so max-of-maxima overstates what the community connection
    ever carries and understates how small a battery is against it.
    """
    frames = [b.electric_demand.df["value"] for b in built.community.building]
    if not frames:
        return 0.0
    total = frames[0].copy()
    for frame in frames[1:]:
        total = total.add(frame, fill_value=0.0)
    return float(total.max())


def _one_way_efficiency(spec) -> float | None:
    """Spec round-trip percent -> the one-way fraction LEC-Opt expects.

    LEC-Opt multiplies by its efficiency on charge and divides by it on
    discharge, so the constant is one-way and the round trip is its square.
    """
    values = [b.efficiency for b in spec.batteries if b.efficiency]
    if not values:
        return None
    mean_round_trip = sum(values) / len(values) / 100.0
    return max(0.01, min(1.0, mean_round_trip ** 0.5))


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
    # The community battery gets its own node rather than being attached to the
    # largest consumer.
    #
    # LEC-Opt indexes storage by building, so a shared battery has to live on
    # some building object. Hanging it on a real one made the reported flows and
    # the state-of-charge series look like that building's private asset. It was
    # never physically private - power_balance sums every building's net power
    # into one grid connection and the per-building net power is a free variable,
    # so a discharge anywhere already offsets consumption everywhere - but the
    # attribution was wrong and the note said so in a way that implied a
    # distortion that does not exist.
    #
    # A zero-load, zero-PV node carries the battery instead, so it belongs to the
    # community and to no member. Every constraint that touches storage is
    # already guarded with `if building.bess_capacity == 0`, so the real
    # buildings are unaffected.
    total_battery = sum(b.capacity for b in spec.batteries)
    total_power = sum(b.capacity for b in spec.batteries)  # 1C unless specified

    if total_battery > 0:
        notes.append(
            f"{total_battery:,.0f} kWh of storage is modelled as a community "
            f"asset on the node {COMMUNITY_STORAGE_NODE!r}, not attached to any "
            f"member building."
        )

        # LEC-Opt applies its efficiency on charge and divides by it on
        # discharge, so the constant is one-way and the round-trip figure is its
        # square. The spec quotes round-trip, hence the square root.
        spec_efficiency = {b.efficiency for b in spec.batteries}
        if len(spec_efficiency) == 1:
            round_trip_pct = next(iter(spec_efficiency))
            notes.append(
                f"Battery round-trip efficiency {round_trip_pct:.0f}% from the "
                f"spec, applied as a one-way factor of "
                f"{(round_trip_pct / 100.0) ** 0.5:.3f}."
            )
            if round_trip_pct < 50:
                notes.append(
                    f"{round_trip_pct:.0f}% round trip is implausibly low for a "
                    f"battery - a lithium system is 85-95%. The value comes from "
                    f"the Grasshopper model and is worth correcting at source, "
                    f"because at this efficiency storing energy costs more than "
                    f"it saves and the optimizer will leave the battery idle."
                )
        else:
            notes.append(
                f"Batteries quote different efficiencies "
                f"({', '.join(f'{e:.0f}%' for e in sorted(spec_efficiency))}); "
                f"LEC-Opt has one battery efficiency, so the mean is used."
            )

        # Sizing, reported against the community peak. The old note compared the
        # battery to the largest single building's peak and then printed a fixed
        # "under 15 minutes", which is the threshold rather than the measurement.
        community_peak = _community_peak_kw(built)
        if community_peak > 0:
            minutes = 60.0 * total_battery / community_peak
            if minutes < 15:
                notes.append(
                    f"{total_battery:,.0f} kWh against a {community_peak:,.0f} kW "
                    f"community peak is {minutes:.1f} minutes at full load. The "
                    f"battery cannot shift a meaningful amount of energy at this "
                    f"size, so a flat state of charge is the correct answer "
                    f"rather than a broken model."
                )

    building_data = {}
    for building in built.community.building:
        demand = building.electric_demand.df["value"].tolist()
        pv_total = [0.0] * HOURS_PER_YEAR
        for plant in getattr(building, "PV_plant", []):
            series = plant.hourly_result.df["value"].tolist()
            for i in range(min(len(series), HOURS_PER_YEAR)):
                pv_total[i] += series[i]

        building_data[building.name] = pd.DataFrame({
            "electricity_load": _slice(demand, spec, n),
            "pv_production": _slice(pv_total, spec, n),
            # Member buildings hold no storage; the community node does.
            "bess_capacity": [0.0] * n,
            "bess_power": [0.0] * n,
        }, index=index)

    if total_battery > 0:
        building_data[COMMUNITY_STORAGE_NODE] = pd.DataFrame({
            "electricity_load": [0.0] * n,
            "pv_production": [0.0] * n,
            "bess_capacity": [total_battery] * n,
            "bess_power": [total_power] * n,
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
    # BESS_EFFICIENCY, not EFFICIENCY: the latter is the EV charge-point
    # figure, and the two used to be one constant so setting a battery from
    # its datasheet silently changed how efficiently every car charged.
    "battery_efficiency": "BESS_EFFICIENCY",
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

    # The spec's battery efficiency is applied here rather than only warned
    # about, so the optimizer and the dispatcher model the same battery. An
    # explicit override from the caller still wins - model_fields_set tells a
    # value the caller actually sent from one that is merely the schema default.
    effective = parameters
    one_way = _one_way_efficiency(spec)
    if one_way is not None and (
        parameters is None
        or "battery_efficiency" not in parameters.model_fields_set
    ):
        base = parameters if parameters is not None else OptimizerParameters()
        effective = base.model_copy(update={"battery_efficiency": one_way})

    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), _applied_parameters(functions1, effective):
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
