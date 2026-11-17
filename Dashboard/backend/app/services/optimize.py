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
import threading
from pathlib import Path
from typing import Callable, Optional

import pandas as pd

from app import settings
from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.builders.community import build_community
from app.schemas.community import CommunitySpec
from app.services import quiet
from app.services.nordpool import NordPoolClient
from app.schemas.optimizer_params import OptimizerParameters

LEC_OPT_ROOT = Path(__file__).resolve().parents[4] / "Optimization" / "LEC-Opt"

# functions1.py multiplies prices by 11.1/1000 to get SEK/kWh, so it expects
# EUR/MWh on the way in. Our specs are in SEK/kWh.
SEK_PER_EUR = 11.1
HOURS_PER_YEAR = 8760

DEFAULT_TEMPERATURE_C = 18.0


# One run at a time.
#
# The job runner has two workers, and a run captures the toolkit's chatter by
# redirecting stdout for its whole duration - a process-wide change. Two runs
# at once therefore redirect it twice, and Pyomo, which checks that the stream
# it is writing to is still the one it was handed, stops with "Captured output
# does not match sys.stdout". That is what a year-long run did when a week was
# started beside it: it died after nearly four minutes of work.
#
# Serialised rather than made thread-safe: these runs are CPU-bound and take
# minutes, so running two at once would halve the speed of each anyway. The
# second simply waits.
_RUN_LOCK = threading.Lock()



class OptimizerUnavailable(RuntimeError):
    """The optimizer or its solver could not be loaded."""


def _import_lec():
    if str(LEC_OPT_ROOT) not in sys.path:
        sys.path.insert(0, str(LEC_OPT_ROOT))
    try:
        import functions1
        # Which solver, from .env rather than from the toolkit's own constant:
        # the toolkit ships HiGHS because it needs no licence, and a machine
        # with a Gurobi licence should not have to edit a vendored file to use
        # it. See app/settings.py.
        functions1.SOLVER_NAME = settings.solver_name()
        return functions1
    except ImportError as err:
        raise OptimizerUnavailable(
            f"Could not import functions1 from {LEC_OPT_ROOT}: {err}. "
            f"Install pyomo and highspy."
        ) from err


_SOLVER_OK: dict | None = None
_SOLVER_CHECK_LOCK = threading.Lock()


def solver_status() -> dict:
    """Which solver the optimizer would use, and whether it is usable.

    A good answer is remembered for the life of the process. Every optimizer
    request asks this first, and the check imports Pyomo and asks the solver
    to start. Once, in a long-running server, that check hung for a minute and
    then reported a working HiGHS as unavailable: every automatic run after it
    was refused, and the comparison never reached the display. A solver that
    worked once keeps working, so it is not asked again. A bad answer is not
    remembered, so installing a solver does not need a restart.
    """
    global _SOLVER_OK
    if _SOLVER_OK is not None:
        return _SOLVER_OK
    with _SOLVER_CHECK_LOCK:
        if _SOLVER_OK is not None:
            return _SOLVER_OK
        status = _check_solver()
        if status.get("available"):
            _SOLVER_OK = status
        return status


def _check_solver() -> dict:
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

    # Installed is not the same as licensed. gurobipy imports and builds a
    # model perfectly well on the licence that ships with the pip package, and
    # then refuses anything past two thousand variables - which is every real
    # community here. Better to say so on this endpoint than to fail a run.
    licence = None
    if "gurobi" in name and available:
        licence = _gurobi_licence_note()

    return {
        "available": available and licence is None,
        "solver": name,
        "time_limit_s": functions1.SOLVER_TIME_LIMIT,
        "licence": licence,
        "detail": licence
        or (None if available else f"solver {name!r} is not installed or licensed"),
    }


def _gurobi_licence_note() -> str | None:
    """None when Gurobi can solve something of our size, else what is wrong."""
    missing = settings.gurobi_licence_state()
    if missing:
        return missing

    try:
        import gurobipy as gp
    except ImportError as err:
        return f"gurobipy is not installed: {err}"

    try:
        model = gp.Model("licence check")
        model.Params.OutputFlag = 0
        # Past the size-limited licence's 2,000 variables, and trivial to solve.
        model.addVars(2500, vtype=gp.GRB.BINARY)
        model.optimize()
    except gp.GurobiError as err:
        return (f"Gurobi is installed but its licence will not take a model this "
                f"size: {err}. Put a licence in Dashboard/backend/.env - see "
                f"app/settings.py - or set ECOM_SOLVER=appsi_highs.")
    return None


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
    # A battery that names a member building belongs to it; the rest are the
    # community store. LEC-Opt already carries bess_capacity per building, so
    # a hosted battery lands on that building's own row and only the unhosted
    # remainder goes to the community node.
    def _loose(text: object) -> str:
        return "".join(ch for ch in str(text).lower() if ch.isalnum())

    by_loose_name = {_loose(b.name): b.name for b in spec.buildings}
    hosted: dict[str, list] = {}
    shared = []
    for battery in spec.batteries:
        name = (by_loose_name.get(_loose(battery.host))
                if battery.attached and battery.host else None)
        if name is None:
            shared.append(battery)
        else:
            hosted.setdefault(name, []).append(battery)

    total_battery = sum(b.capacity for b in shared)
    # Was `sum(b.capacity ...)` - an unstated 1C, which let a 54 kWh battery
    # answer a 54 kW peak. The spec now carries the rate, defaulting to the
    # 0.25C the campus workbook applies to a battery that states no rate.
    total_power = sum(b.power_kw for b in shared)

    if hosted:
        notes.append(
            f"{sum(b.capacity for v in hosted.values() for b in v):,.0f} kWh of "
            f"storage is attached to {len(hosted)} member "
            f"building{'s' if len(hosted) != 1 else ''} and serves "
            f"{'them' if len(hosted) != 1 else 'it'} first: "
            + ", ".join(sorted(hosted)) + "."
        )

    if total_battery > 0:
        notes.append(
            f"{total_battery:,.0f} kWh of storage is modelled as a community "
            f"asset on the node {COMMUNITY_STORAGE_NODE!r}, not attached to any "
            f"member building."
        )

        rates = {b.c_rate for b in spec.batteries}
        if len(rates) == 1:
            rate = next(iter(rates))
            notes.append(
                f"Storage is rated {total_power:,.1f} kW, which is {rate:g}C - "
                f"{1 / rate:.1f} hours to fill or empty."
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

        # A building holds whatever is hosted in it, and nothing otherwise -
        # the unhosted remainder sits on the community node below.
        mine = hosted.get(building.name, [])
        building_data[building.name] = pd.DataFrame({
            "electricity_load": _slice(demand, spec, n),
            "pv_production": _slice(pv_total, spec, n),
            "bess_capacity": [sum(b.capacity for b in mine)] * n,
            "bess_power": [sum(b.power_kw for b in mine)] * n,
        }, index=index)

    # Solar the community owns - panels no building names, a ground array or a
    # roof rented from a building outside the scheme. It used to be left out of
    # the optimizer altogether: the loop above reads only the plants attached to
    # a building, so a community array was in the dispatch and every KPI beside
    # it and absent from the one model that prices the result.
    #
    # It goes on the same zero-load node as the community battery, which already
    # exists to hold what belongs to the community and to no member.
    community_pv = [0.0] * HOURS_PER_YEAR
    for plant in getattr(built.community, "PV_plant", None) or []:
        series = plant.hourly_result.df["value"].tolist()
        for i in range(min(len(series), HOURS_PER_YEAR)):
            community_pv[i] += series[i]
    has_community_pv = any(v > 0 for v in community_pv)
    if has_community_pv:
        notes.append(
            "Community-owned solar is modelled on the node "
            f"{COMMUNITY_STORAGE_NODE!r}, with the community battery."
        )

    if total_battery > 0 or has_community_pv:
        building_data[COMMUNITY_STORAGE_NODE] = pd.DataFrame({
            "electricity_load": [0.0] * n,
            "pv_production": _slice(community_pv, spec, n),
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
                # As the optimization team set it: the car leaves with what the
                # time it was plugged in can put in, at the charger's power and
                # 0.93 charging efficiency, up to a full battery. So arrival and
                # departure decide how much it charges, not only when. Arrival
                # SOC stays 0.3: LEC-Opt works between 0.2 and 1, and refuses an
                # arrival below 0.2.
                # LEC-Opt charges only in the hours strictly between arrival and
                # departure (arrival < t < departure), one fewer than the stay,
                # and holds departure SOC to exactly the target - so a target
                # counted over every hour of the stay was out of reach for a
                # short one and the solve had no solution at all. Counted over
                # the hours it can charge, less a hair for rounding.
                charging_hours = max(0.0, hours - 1.0)
                reachable = cp.ev.capacity and (
                    0.3 + (min(cp.capacity, cp.ev.max_charging_power) * charging_hours * 0.93)
                    / cp.ev.capacity - 0.001)
                rows.append({
                    "Arrival": arrival,
                    "Departure": departure,
                    "Capacity": float(cp.ev.capacity),
                    "Max_Power": float(min(cp.capacity, cp.ev.max_charging_power)),
                    "Arrival SOC": 0.3,
                    "Desired SOC": round(min(1.0, reachable or 1.0), 3),
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


# Charging is modelled as workplace charging: plugged in between 06:00 and
# midnight, never across it. LEC-Opt handles an overnight session within one
# run, but each run here starts fresh and does not remember a session left open
# by the day before - so, as the optimization team advised, a session ends at
# midnight and none starts before six.
WORKPLACE_FROM_HOUR = 6


def _availability_blocks(availability, horizon: int) -> list[tuple[int, int]]:
    """Contiguous plugged-in blocks, as (start_hour, end_hour) within horizon.

    Clipped to the working day (06:00-24:00) and cut at midnight, so a
    schedule that runs overnight becomes the part of it inside each day.
    """
    if not availability:
        return []
    pattern = list(availability)
    full = (pattern * (horizon // len(pattern) + 2))[:horizon]
    full = [value if hour % 24 >= WORKPLACE_FROM_HOUR else 0
            for hour, value in enumerate(full)]

    blocks, start = [], None
    for hour, value in enumerate(full):
        if value and start is not None and hour % 24 == 0:
            blocks.append((start, hour))     # midnight ends a session
            start = None
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
    mode: str = "community",
) -> dict:
    """Run the rolling-horizon optimizer and summarise the result.

    mode "community" optimises the buildings together, as one energy community
    on one grid connection - the model LEC-Opt is. mode "separate" optimises the
    same buildings as they are today, each on its own: its own connection, its
    own subscription and peak charge, no sharing with its neighbours, and none
    of the community's own solar or battery. Run both and the difference is what
    the community is worth to the optimizer.
    """
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, not {mode!r}")
    functions1 = _import_lec()
    status = solver_status()
    if not status["available"]:
        raise OptimizerUnavailable(status["detail"] or "no solver available")

    lookahead = max(0, horizon_hours - store_hours)
    inputs = build_optimizer_inputs(spec, lookahead_hours=lookahead + 24,
                                    temperature_c=temperature_c, nordpool=nordpool)

    n_days = days if days else max(1, spec.analysis_period.n_hours // 24)

    # The inputs are sliced to the community's own period, so asking for more
    # days than it holds walks off the end of the series - which surfaced as a
    # bare "IndexError: single positional indexer is out-of-bounds" from deep
    # inside pandas. Say what is actually wrong instead.
    available = max(1, spec.analysis_period.n_hours // 24)
    if n_days > available:
        raise ValueError(
            f"asked for {n_days} days, but this community's analysis period "
            f"covers {available} ({spec.analysis_period.label}). Widen the "
            f"period to at least {n_days} days and run it again."
        )

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

    def solve(building_data, charging_point_data, building_on=1):
        return functions1.optimization_function_lec(
            charging_point_data=charging_point_data,
            building_data=building_data,
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
            building_on=building_on,
            previous_monthly_peak=0.0,
            current_month=inputs["start_date"].month,
            initial_bess_soc=0.5,
            pv_on=1, bess_on=1,
        )

    sites: list[dict] = []
    with _RUN_LOCK, quiet.capture() as sink, \
            _applied_parameters(functions1, effective):
        # The grid subscription: a fixed fee per connection, so it changes no
        # decision and is left out of the solve - but it is a real cost, and the
        # number of connections is the one thing a community changes about it.
        # Read here, inside the parameter override, so an edited fee counts.
        fee_per_hour = float(functions1.SUBSCRIPTION_FEE_SEK_PER_MONTH) / 30.0 / 24.0
        vat = float(functions1.VAT_RATE)

        if mode == "community":
            frame = solve(inputs["building_data"], inputs["charging_point_data"])
            if frame is None or len(frame) == 0:
                raise OptimizerUnavailable(
                    "the optimizer returned no rows; the solver log is in the "
                    "server output")
            totals, series = _totals(frame), _series(frame)
            hours = len(frame)
            # One shared connection for the whole community.
            _add_subscription(totals, connections=1, hours=hours,
                              fee_per_hour=fee_per_hour, vat=vat)
        else:
            frames = []
            to_solve = _separate_sites(spec, inputs, notes)
            for number, site in enumerate(to_solve, start=1):
                if progress:
                    progress(f"{site['name']} on its own "
                             f"({number} of {len(to_solve)})")
                one = solve(site["building_data"], site["charging_point_data"],
                            building_on=site["building_on"])
                if one is None or len(one) == 0:
                    raise OptimizerUnavailable(
                        f"the optimizer returned no rows for {site['name']}; the "
                        f"solver log is in the server output")
                frames.append(one)
                t = _totals(one)
                # As today every building has its own connection and pays its
                # own subscription. A site with no building (chargers only)
                # does not count as one.
                if site.get("building_on", 1):
                    _add_subscription(t, connections=1, hours=len(one),
                                      fee_per_hour=fee_per_hour, vat=vat)
                sites.append({
                    "name": site["name"],
                    "overall_cost": t["overall_cost"],
                    "grid_import_kwh": t["grid_import_kwh"],
                    "grid_export_kwh": t["grid_export_kwh"],
                    "peak_net_import_kw": t["peak_net_import_kw"],
                })
            totals, series = _combine_totals(frames), _combine_series(frames)
            hours = len(frames[0])
            connections = sum(1 for site in to_solve if site.get("building_on", 1))
            _add_subscription(totals, connections=connections, hours=hours,
                              fee_per_hour=fee_per_hour, vat=vat)

    return {
        "solver": status["solver"],
        "mode": mode,
        # Whether the cars were allowed to give energy back (vehicle-to-grid).
        "v2g": bool(v2g),
        "days": int(n_days),
        "hours": hours,
        "notes": notes,
        "totals": totals,
        "series": series,
        # Per building, for a run where each was solved on its own.
        "sites": sites,
        "log_tail": sink.getvalue().splitlines()[-12:],
    }


MODES = ("community", "separate")


def _separate_sites(spec: CommunitySpec, inputs: dict, notes: list) -> list[dict]:
    """What an "as today" run solves: every member building on its own.

    A site is one grid connection. Each building is one, with its own roof
    panels, its own battery and the chargers mounted on it. Anything the
    community owns - the shared battery, shared solar - is not in any of them,
    because without a community there is nobody to own it.

    A charger that belongs to no building is a connection of its own, so it is
    solved on its own rather than quietly handed to a building it was never
    mounted on.
    """
    def loose(text: object) -> str:
        return "".join(ch for ch in str(text).lower() if ch.isalnum())

    names = [n for n in inputs["building_data"] if n != COMMUNITY_STORAGE_NODE]
    by_loose = {loose(n): n for n in names}

    owned: dict[str, dict] = {n: {} for n in names}
    loose_chargers: dict = {}
    for cp in spec.charge_points:
        frame = inputs["charging_point_data"].get(cp.name)
        if frame is None:
            continue
        owner = by_loose.get(loose(cp.host)) if cp.host else None
        (owned[owner] if owner else loose_chargers)[cp.name] = frame

    sites = [{
        "name": n,
        "building_data": {n: inputs["building_data"][n]},
        "charging_point_data": owned[n],
        "building_on": 1,
    } for n in names]

    if loose_chargers:
        # building_on=0: no building in this connection, only the chargers. A
        # building's data still has to be handed over - the model sizes its
        # timeline from it - but it is not built.
        sites.append({
            "name": "Chargers with no building",
            "building_data": {names[0]: inputs["building_data"][names[0]]},
            "charging_point_data": loose_chargers,
            "building_on": 0,
        })

    dropped = []
    if COMMUNITY_STORAGE_NODE in inputs["building_data"]:
        dropped.append("the community battery and solar")
        # The notes written while the inputs were built describe the community's
        # shared store and its sizing against the community peak. None of that is
        # in this run, and leaving it reads as though it were. What belongs to a
        # building stays.
        notes[:] = [n for n in notes if "attached to" in n]
    notes.append(
        f"Each of the {len(names)} buildings is solved on its own, as today: its "
        f"own grid connection, its own peak charge and subscription, nothing "
        f"shared with its neighbours"
        + (f", and without {' and '.join(dropped)}" if dropped else "") + "."
    )
    return sites


def _combine_totals(frames: list) -> dict:
    """Add up one run per site into the figures for all of them together.

    Every figure is a plain sum - each building pays its own bill - including the
    peak: separate connections are charged on their own peaks, so the number
    that matters is the sum of those, which is larger than the peak of the sum.
    """
    keys = _totals(frames[0]).keys()
    out = {key: 0.0 for key in keys}
    for frame in frames:
        for key, value in _totals(frame).items():
            out[key] += value
    return out


def _combine_series(frames: list) -> dict:
    """The hourly series of every site, added together."""
    out = {}
    first = _series(frames[0])
    for key in ("P_import_all", "P_export_all", "Overall cost", "Supplier cost"):
        if key in first:
            out[key] = [0.0] * len(first[key])
    soc: dict = {}
    for frame in frames:
        one = _series(frame)
        for key in out:
            for i, value in enumerate(one.get(key, [])):
                if i < len(out[key]):
                    out[key][i] += value
        soc.update(one.get("soc", {}))
    out = {k: [round(v, 4) for v in vs] for k, vs in out.items()}
    out["soc"] = soc
    out["timestamps"] = first["timestamps"]
    return out


def _num(frame: pd.DataFrame, column: str) -> float:
    if column not in frame.columns:
        return 0.0
    value = float(frame[column].fillna(0.0).sum())
    return value if math.isfinite(value) else 0.0


def _add_subscription(totals: dict, connections: int, hours: int,
                      fee_per_hour: float, vat: float) -> None:
    """Put the grid subscription into a run's reported costs, in place.

    functions1 keeps the subscription in its objective but leaves it out of the
    costs it reports: its grid (DSO) cost is transmission plus peak fee only.
    Added here as one fee per connection over the hours run - every building's
    own as today, one shared one for a community - into the grid cost, with
    VAT on it as functions1 puts VAT on the rest of the grid cost.
    """
    fee = fee_per_hour * hours * connections
    totals["subscription_cost"] = totals.get("subscription_cost", 0.0) + fee
    totals["connections"] = connections
    totals["dso_cost"] = totals.get("dso_cost", 0.0) + fee
    totals["tax_cost"] = totals.get("tax_cost", 0.0) + fee * vat
    totals["overall_cost"] = totals.get("overall_cost", 0.0) + fee * (1.0 + vat)


def _ev_total(frame: pd.DataFrame, suffix: str) -> float:
    """kWh into (`_ch`) or out of (`_ds`) the cars, over every charge point.

    functions1 writes one `{charge point}_ch` / `_ds` column per charger, beside
    `{building}_bess_ch` / `_ds` for the batteries - which are not cars, so they
    are left out. Discharge is only ever non-zero with V2G on.
    """
    total = 0.0
    for column in frame.columns:
        name = str(column)
        if name.endswith(suffix) and not name.endswith("_bess" + suffix):
            total += float(pd.to_numeric(frame[column], errors="coerce").fillna(0.0).sum())
    return total


def _totals(frame: pd.DataFrame) -> dict:
    resolution = 1  # the adapter always builds a 60-minute index
    return {
        "ev_charge_kwh": _ev_total(frame, "_ch") / resolution,
        "ev_discharge_kwh": _ev_total(frame, "_ds") / resolution,
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
