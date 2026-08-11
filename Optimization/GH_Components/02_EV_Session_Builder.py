#! python3
# r: pandas, numpy

ghenv.Component.Name = 'EV Session Builder'
ghenv.Component.NickName = 'EVSessions'
ghenv.Component.Message = '0.1.0'
ghenv.Component.Category = 'ECOM4Future'
ghenv.Component.SubCategory = '2 :: Optimization'
ghenv.Component.AdditionalHelpFromDocStrings = '2'

"""
Build optimizer-ready EV charging sessions from ChargePoint and EV objects.

Every session is validated against the assertions in functions1.py:13-40 before
it leaves this component. An assertion failing inside the optimizer aborts a
multi-day run with no partial results, so infeasible sessions are clamped or
dropped here and listed in the report.

Inputs:
    run: Boolean toggle.
    charge_point_data_raw: Output from ECOM Opt Prep.
    analysis_period: Ladybug AnalysisPeriod.
    start_date: String, e.g. "2024-01-01 00:00:00".
    default_arrival_soc: Default arrival SOC if the EV has none. Default 0.3.
    default_desired_soc: Default departure SOC if the EV has none. Default 0.8.
    min_session_steps: Drop sessions shorter than this many timesteps. Default 2.
    clamp_infeasible: Boolean, default True. Reduce Desired SOC to what the
        connector can physically deliver instead of dropping the session.

Outputs:
    charging_point_data: Dict[cp_name] -> DataFrame with optimizer EV columns.
    session_table: Combined DataFrame for inspection.
    dropped_table: Sessions that were dropped or clamped, with the reason.
    report: Summary and warning text. READ THIS.

A missing or unrecognised availability schedule is an ERROR here, not a default.
Treating it as "always connected" produces one year-long session and results
that look plausible but are meaningless.
"""

import pandas as pd
import numpy as np

CHARGING_EFFICIENCY = 0.93   # functions1.py:15
MIN_ARRIVAL_SOC = 0.2        # functions1.py:32
SESSION_COLUMNS = ["Arrival", "Departure", "Capacity", "Max_Power",
                   "Arrival SOC", "Desired SOC", "ev_id", "session_id"]

warnings_out = []
dropped_rows = []


def _warn(text):
    warnings_out.append(text)


def _drop(cp_name, ev_name, reason, action):
    dropped_rows.append({"cp_name": cp_name, "ev_id": ev_name,
                         "reason": reason, "action": action})


def _get_any(obj, names, default=None):
    for name in names:
        if isinstance(obj, dict):
            if name in obj:
                return obj[name]
        elif hasattr(obj, name):
            return getattr(obj, name)
    return default


def _has_any(obj, names):
    sentinel = object()
    return _get_any(obj, names, sentinel) is not sentinel


def _ensure_list(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    try:
        return list(value)
    except Exception:
        return [value]


def _steps(ap):
    return len(list(ap.hoys))


def _resolution(ap):
    return max(int(getattr(ap, "timestep", 1) or 1), 1)


def _index(start_date_text, steps_count, res):
    freq_minutes = int(round(60.0 / float(res)))
    return pd.date_range(start=pd.Timestamp(start_date_text),
                         periods=steps_count, freq="{}min".format(freq_minutes))


def _extract_schedule_values(schedule_obj):
    """Return the raw schedule values, or None if nothing recognisable is found."""
    if schedule_obj is None:
        return None
    if isinstance(schedule_obj, (list, tuple, np.ndarray)):
        return [float(v) for v in schedule_obj]
    if isinstance(schedule_obj, pd.Series):
        return [float(v) for v in schedule_obj.tolist()]

    for attr in ("values", "hourly_values"):
        if hasattr(schedule_obj, attr):
            try:
                return [float(v) for v in list(getattr(schedule_obj, attr))]
            except Exception:
                pass
    if hasattr(schedule_obj, "data_collection"):
        try:
            return [float(v) for v in list(schedule_obj.data_collection.values)]
        except Exception:
            pass
    return None


def _slice_schedule(values, ap, label):
    steps_count = _steps(ap)
    vals = [float(v) for v in values]
    if len(vals) == steps_count:
        return vals

    res = _resolution(ap)
    hoys = list(getattr(ap, "hoys", []))
    if not hoys:
        return [vals[i % len(vals)] for i in range(steps_count)]

    if len(vals) >= 8760 * res and res > 1:
        start_i = int(round(float(hoys[0]) * res))
    else:
        if res > 1 and len(vals) < 8760 * res:
            _warn("{}: schedule has {} values at a {}x-resolution analysis period. "
                  "Each value is repeated across the sub-hourly steps."
                  .format(label, len(vals), res))
        start_i = int(round(float(hoys[0])))
    start_i = start_i % len(vals)
    return [vals[(start_i + i) % len(vals)] for i in range(steps_count)]


def _find_sessions(binary_values):
    """Return (start, end) pairs with an exclusive end index."""
    sessions = []
    start_i = None
    for i, v in enumerate(binary_values):
        connected = float(v) > 0.5
        if connected and start_i is None:
            start_i = i
        elif not connected and start_i is not None:
            sessions.append((start_i, i))
            start_i = None
    if start_i is not None:
        sessions.append((start_i, len(binary_values)))
    return sessions


def _empty_session_frame():
    df = pd.DataFrame(columns=SESSION_COLUMNS)
    return df.astype({"Arrival": "datetime64[ns]", "Departure": "datetime64[ns]"})


# ---------------------------------------------------------------- main

if not run:
    charging_point_data = {}
    session_table = pd.DataFrame()
    dropped_table = pd.DataFrame()
    report = "Toggle run to True."
else:
    if not charge_point_data_raw:
        raise ValueError("charge_point_data_raw is empty. Run ECOM Opt Prep first.")
    if not start_date:
        raise ValueError("start_date is required and must match ECOM Opt Prep.")

    arrival_default = 0.3 if default_arrival_soc is None else float(default_arrival_soc)
    desired_default = 0.8 if default_desired_soc is None else float(default_desired_soc)
    min_steps = 2 if min_session_steps is None else max(1, int(min_session_steps))
    do_clamp = True if clamp_infeasible is None else bool(clamp_infeasible)

    steps_count = _steps(analysis_period)
    res = _resolution(analysis_period)
    idx = _index(start_date, steps_count, res)

    # One extra timestamp so a session running to the end of the period gets a
    # departure strictly after its arrival (functions1.py:31 asserts arr < dep).
    step_delta = idx[1] - idx[0]
    idx_ext = idx.append(pd.DatetimeIndex([idx[-1] + step_delta]))

    charging_point_data = {}
    combined_rows = []
    total_sessions = 0
    total_clamped = 0

    for cp_name, cp_meta in charge_point_data_raw.items():
        cp_power = float(_get_any(cp_meta, ["max_power", "capacity"], 0.0))
        evs = _ensure_list(_get_any(cp_meta, ["evs"], []))

        rows = []
        session_id = 1  # unique per charge point; becomes a Pyomo component name

        for ev in evs:
            ev_name = str(_get_any(ev, ["name", "id"], "EV"))

            ev_capacity = float(_get_any(ev, ["capacity"], 0.0))
            if ev_capacity <= 0:
                _drop(cp_name, ev_name, "battery capacity is {}".format(ev_capacity),
                      "EV skipped")
                continue

            if _has_any(ev, ["max_charging_power", "charging_power", "power"]):
                ev_max_power = float(_get_any(
                    ev, ["max_charging_power", "charging_power", "power"], 0.0))
            elif cp_power > 0:
                ev_max_power = cp_power
                _warn("{}/{}: EV has no power rating, using the charge point's "
                      "{} kW.".format(cp_name, ev_name, cp_power))
            else:
                _drop(cp_name, ev_name, "no EV or charge point power rating",
                      "EV skipped")
                continue
            if cp_power > 0:
                ev_max_power = min(ev_max_power, cp_power)
            if ev_max_power <= 0:
                _drop(cp_name, ev_name, "max power is {}".format(ev_max_power),
                      "EV skipped")
                continue

            arrival_soc = float(_get_any(ev, ["arrival_soc", "arrival_soc_default"],
                                         arrival_default))
            desired_soc = float(_get_any(ev, ["desired_soc", "desired_soc_default"],
                                         desired_default))

            if not (MIN_ARRIVAL_SOC <= arrival_soc <= 1.0):
                clamped = min(max(arrival_soc, MIN_ARRIVAL_SOC), 1.0)
                _warn("{}/{}: arrival SOC {:.3f} is outside the [{}, 1.0] range "
                      "asserted at functions1.py:32, clamped to {:.3f}."
                      .format(cp_name, ev_name, arrival_soc, MIN_ARRIVAL_SOC, clamped))
                arrival_soc = clamped
            desired_soc = min(max(desired_soc, 0.0), 1.0)

            schedule_obj = _get_any(
                ev, ["schedule", "availability_schedule", "availability"], None)
            raw_vals = _extract_schedule_values(schedule_obj)
            if raw_vals is None or not raw_vals:
                _drop(cp_name, ev_name,
                      "no availability schedule found (tried schedule, "
                      "availability_schedule, availability)", "EV skipped")
                continue

            sched_vals = _slice_schedule(raw_vals, analysis_period,
                                         "{}/{}".format(cp_name, ev_name))
            session_pairs = _find_sessions(sched_vals)
            if not session_pairs:
                _warn("{}/{}: schedule never exceeds 0.5, no sessions built."
                      .format(cp_name, ev_name))
                continue

            for (arr_i, dep_i) in session_pairs:
                slots = dep_i - arr_i
                if slots < min_steps:
                    _drop(cp_name, ev_name,
                          "session of {} timestep(s) at {}".format(slots, idx[arr_i]),
                          "dropped, below min_session_steps={}".format(min_steps))
                    continue

                arr_ts = idx_ext[arr_i]
                dep_ts = idx_ext[dep_i]

                # functions1.py:36-37 asserts the requested charge fits in the
                # session. Compute the true power requirement (kWh over hours),
                # which is stricter than the repo's per-timestep comparison.
                hours = slots / float(res)
                reachable = arrival_soc + (
                    ev_max_power * hours * CHARGING_EFFICIENCY) / ev_capacity
                session_desired = desired_soc

                if desired_soc > reachable + 1e-9:
                    if do_clamp:
                        session_desired = max(arrival_soc, min(reachable * 0.99, 1.0))
                        total_clamped += 1
                        _drop(cp_name, ev_name,
                              "desired SOC {:.3f} needs {:.1f} kW over {:.2f} h but "
                              "the connector is {:.1f} kW".format(
                                  desired_soc,
                                  (desired_soc - arrival_soc) * ev_capacity
                                  / CHARGING_EFFICIENCY / hours,
                                  hours, ev_max_power),
                              "clamped to {:.3f}".format(session_desired))
                    else:
                        _drop(cp_name, ev_name,
                              "desired SOC {:.3f} unreachable in {:.2f} h".format(
                                  desired_soc, hours),
                              "dropped (clamp_infeasible=False)")
                        continue

                row = {
                    "Arrival": arr_ts,
                    "Departure": dep_ts,
                    "Capacity": ev_capacity,
                    "Max_Power": ev_max_power,
                    "Arrival SOC": arrival_soc,
                    "Desired SOC": session_desired,
                    "ev_id": ev_name,
                    "session_id": session_id,
                }
                rows.append(row)
                combined_rows.append(dict(row, cp_name=cp_name))
                session_id += 1
                total_sessions += 1

        if rows:
            df = pd.DataFrame(rows, columns=SESSION_COLUMNS)
            df["Arrival"] = pd.to_datetime(df["Arrival"])
            df["Departure"] = pd.to_datetime(df["Departure"])
            charging_point_data[cp_name] = df

            # functions1.py:950 sums EV SOC per charge point, so concurrent
            # sessions corrupt the day-to-day SOC carry-over at line 1275.
            ordered = df.sort_values("Arrival")
            overlaps = int((ordered["Arrival"].values[1:]
                            < ordered["Departure"].values[:-1]).sum())
            if overlaps:
                _warn("{}: {} overlapping session pair(s). functions1.py reports a "
                      "single summed SOC per charge point, so overlapping sessions "
                      "corrupt the next day's arrival SOC. Split them across "
                      "separate charge points.".format(cp_name, overlaps))
        else:
            charging_point_data[cp_name] = _empty_session_frame()
            _warn("{}: no valid sessions built.".format(cp_name))

    session_table = (pd.DataFrame(combined_rows) if combined_rows
                     else pd.DataFrame(columns=SESSION_COLUMNS + ["cp_name"]))
    dropped_table = (pd.DataFrame(dropped_rows) if dropped_rows
                     else pd.DataFrame(columns=["cp_name", "ev_id", "reason", "action"]))

    lines = ["Built {} session(s) across {} charge point(s).".format(
                 total_sessions, len(charging_point_data)),
             "  clamped for feasibility: {}".format(total_clamped),
             "  dropped / skipped:       {}".format(
                 len([r for r in dropped_rows if "clamped" not in r["action"]])),
             "  period: {} -> {} at {} steps/hour".format(idx[0], idx[-1], res)]
    if total_sessions == 0:
        lines.append("")
        lines.append("NOTHING WAS BUILT - check dropped_table.")
    if warnings_out:
        lines.append("")
        lines.append("WARNINGS ({}):".format(len(warnings_out)))
        lines.extend("  - " + w for w in warnings_out)
    report = "\n".join(lines)
