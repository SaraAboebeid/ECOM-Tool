#! python3
# r: pandas, numpy, pyomo, matplotlib

ghenv.Component.Name = 'LEC Optimizer Core'
ghenv.Component.NickName = 'LECOptimizer'
ghenv.Component.Message = '0.1.0'
ghenv.Component.Category = 'ECOM4Future'
ghenv.Component.SubCategory = '2 :: Optimization'
ghenv.Component.AdditionalHelpFromDocStrings = '2'

"""
Run the rolling-horizon LEC optimization from the repository.

matplotlib is in the # r: header because functions1.py:8 imports pyplot at
module level - the import fails without it even though nothing plots.

SOLVER: functions1.py:895 hardcodes SolverFactory('gurobi'). pyomo from pip
ships no solver, so Gurobi must be installed and licensed on this machine with
gurobi.bat on PATH. solver_name redirects that call without editing the repo,
but only to solvers using the classic Pyomo results object (gurobi, cbc, glpk).
appsi_highs will NOT work: functions1.py:1228 reads
results.solver.termination_condition, which appsi does not expose.

Every input is validated before the solve starts. A bad index or an infeasible
EV session otherwise fails via an assertion deep inside the day loop, after
minutes of solving, with no partial results.

Inputs:
    run: Boolean toggle.
    repo_root: Folder containing functions1.py.
    building_data, charging_point_data, prices_df, temperature_df, activation_df
    start_date: String, must match ECOM Opt Prep.
    days: Integer, use the ECOM Opt Prep output.
    horizon_hours: Default 36.
    store_hours: Default 24.
    fcrn_on, fcrdu_on, fcrdd_on, aging_on, v2g_on, dc, building_on, pv_on, bess_on
    previous_monthly_peak: Float.
    current_month: Integer 1-12, use the ECOM Opt Prep output.
    initial_bess_soc: Float.
    solver_name: Default 'gurobi'.
    solver_time_limit: Seconds per solve. Default 120.
    cache_folder: Optional. Caches raw_results keyed by an input hash so an
        accidental recompute does not re-solve. Delete the folder to invalidate.

Outputs:
    raw_results: DataFrame returned by optimization_function_lec.
    total_cost: Sum of Overall cost.
    solved: Boolean, True only if a solve actually produced results.
    report: Summary or error text. READ THIS.

Grasshopper blocks completely while solving. At solver_time_limit per day, a
30-day run can freeze the canvas for hours. Use cache_folder.
"""

import os
import sys
import hashlib
import traceback
import pandas as pd
import numpy as np

REQUIRED_PRICES = ["Spot prices", "FCRN prices", "FCRDU prices", "FCRDD prices",
                   "Up reg prices", "Down reg prices"]
REQUIRED_TEMPERATURE = ["Temperature"]
REQUIRED_ACTIVATION = ["FCR-N-up", "FCR-N-down", "FCR-D-up", "FCR-D-down"]
REQUIRED_BUILDING = ["electricity_load", "pv_production", "bess_capacity", "bess_power"]
REQUIRED_SESSION = ["Arrival", "Departure", "Capacity", "Max_Power",
                    "Arrival SOC", "Desired SOC", "ev_id", "session_id"]

# Pyomo option key for a wall-clock limit, per solver.
TIME_LIMIT_KEYS = {"gurobi": "TimeLimit", "cbc": "seconds", "glpk": "tmlim",
                   "cplex": "timelimit", "xpress": "maxtime"}


def _flag(value, default):
    """GH panels deliver strings and bool('0') is True. Normalize properly."""
    if value is None:
        return int(default)
    if isinstance(value, str):
        return int(value.strip().lower() in ("1", "true", "yes", "on", "t", "y"))
    return int(bool(value))


class _AliasOptions(object):
    """Maps the hardcoded 'TimeLimit' key onto the active solver's own key."""

    def __init__(self, inner, key):
        self._inner = inner
        self._key = key

    def __setitem__(self, key, value):
        self._inner["TimeLimit" if self._key is None else
                    (self._key if key == "TimeLimit" else key)] = value

    def __getitem__(self, key):
        return self._inner[self._key if key == "TimeLimit" else key]

    def __getattr__(self, item):
        return getattr(self._inner, item)


class _SolverProxy(object):
    def __init__(self, inner, key, time_limit):
        self._inner = inner
        self.options = _AliasOptions(inner.options, key)
        if key is not None and time_limit:
            inner.options[key] = time_limit

    def __getattr__(self, item):
        return getattr(self._inner, item)


def _hash_inputs(parts):
    h = hashlib.sha256()
    for p in parts:
        if isinstance(p, pd.DataFrame):
            h.update(str(list(p.columns)).encode())
            h.update(pd.util.hash_pandas_object(p, index=True).values.tobytes())
        else:
            h.update(repr(p).encode())
    return h.hexdigest()[:16]


raw_results = pd.DataFrame()
total_cost = 0.0
solved = False
report = ""
problems = []
notes = []

if not _flag(run, 0):
    report = "Toggle run to True."
elif not repo_root:
    report = "repo_root must point to the folder containing functions1.py."
elif not os.path.isfile(os.path.join(str(repo_root), "functions1.py")):
    report = "functions1.py not found in '{}'.".format(repo_root)
else:
    try:
        if str(repo_root) not in sys.path:
            sys.path.append(str(repo_root))
        import pyomo.environ as pyo
        import functions1
        from functions1 import optimization_function_lec

        solver = str(solver_name).strip() if solver_name else "gurobi"
        time_limit = int(solver_time_limit) if solver_time_limit else 120

        # ---- solver availability, checked before anything expensive ----
        try:
            available = pyo.SolverFactory(solver).available(exception_flag=False)
        except Exception as solver_err:
            available = False
            notes.append("Solver probe raised: {}".format(solver_err))
        if not available:
            problems.append(
                "Solver '{}' is not available to this Python process. pyomo from "
                "pip ships no solver: install it and make sure its executable is "
                "on PATH, then restart Rhino.".format(solver))
        if solver.startswith("appsi"):
            problems.append(
                "'{}' uses the appsi results object, but functions1.py:1228 reads "
                "results.solver.termination_condition. Patch functions1.py before "
                "using an appsi solver.".format(solver))

        # ---- data frames ----
        frames = (("prices_df", prices_df, REQUIRED_PRICES),
                  ("temperature_df", temperature_df, REQUIRED_TEMPERATURE),
                  ("activation_df", activation_df, REQUIRED_ACTIVATION))
        for label, frame, cols in frames:
            if frame is None or not isinstance(frame, pd.DataFrame) or frame.empty:
                problems.append("{} is missing or empty.".format(label))
                continue
            missing = [c for c in cols if c not in frame.columns]
            if missing:
                problems.append("{} lacks columns: {}".format(label, missing))
            if not isinstance(frame.index, pd.DatetimeIndex):
                problems.append("{} needs a DatetimeIndex.".format(label))

        if not problems:
            # functions1.py:1044-1052 breaks out of the day loop on any mismatch,
            # leaving an empty frame that then fails with a bare KeyError at 1301.
            if not prices_df.index.equals(temperature_df.index):
                problems.append("prices_df and temperature_df indices differ.")
            if not prices_df.index.equals(activation_df.index):
                problems.append("prices_df and activation_df indices differ.")

        # ---- buildings and charge points ----
        b_on = _flag(building_on, 1)
        if b_on and not building_data:
            problems.append("building_data is empty but building_on is 1.")
        for name, frame in (building_data or {}).items():
            missing = [c for c in REQUIRED_BUILDING if c not in frame.columns]
            if missing:
                problems.append("building_data['{}'] lacks columns: {}".format(name, missing))

        if not charging_point_data:
            problems.append("charging_point_data is empty. functions1.py requires "
                            "at least one charge point.")
        total_sessions = 0
        for name, frame in (charging_point_data or {}).items():
            missing = [c for c in REQUIRED_SESSION if c not in frame.columns]
            if missing:
                problems.append("charging_point_data['{}'] lacks columns: {}"
                                .format(name, missing))
            else:
                total_sessions += len(frame)
        if not problems and total_sessions == 0:
            notes.append("No EV sessions in any charge point - the EV side of the "
                         "model will be empty.")

        # ---- horizon coverage ----
        horizon = int(horizon_hours) if horizon_hours else 36
        store = int(store_hours) if store_hours else 24
        if store > horizon:
            problems.append("store_hours ({}) cannot exceed horizon_hours ({})."
                            .format(store, horizon))

        if not problems:
            start_ts = pd.Timestamp(start_date)
            if start_ts not in prices_df.index:
                problems.append("start_date {} is not in the prices_df index, which "
                                "runs {} -> {}. functions1.py slices by label, so a "
                                "misaligned start yields an empty model."
                                .format(start_ts, prices_df.index[0], prices_df.index[-1]))
            else:
                step_s = (prices_df.index[1] - prices_df.index[0]).total_seconds()
                res = int(round(3600.0 / step_s))
                if res not in (1, 4):
                    problems.append("Resolution is {} steps/hour. functions1.py:1060 "
                                    "supports only 1 or 4.".format(res))

                n_days = int(days) if days and int(days) > 0 else None
                if n_days is None:
                    span_h = len(prices_df.index[prices_df.index >= start_ts]) / float(res)
                    n_days = max(1, int((span_h - (horizon - store)) // 24))
                    notes.append("days not supplied, inferred {}.".format(n_days))

                needed_h = n_days * 24 + (horizon - store)
                have_h = len(prices_df.index[prices_df.index >= start_ts]) / float(res)
                if have_h < needed_h:
                    notes.append(
                        "Only {:.1f} h of data after start_date but {} day(s) with a "
                        "{} h horizon needs {:.1f} h. The final day's horizon is "
                        "truncated, so EV departure-SOC constraints past the end are "
                        "silently skipped (functions1.py:255)."
                        .format(have_h, n_days, horizon, needed_h))

        if problems:
            report = "Input check failed - nothing was solved:\n- " + "\n- ".join(problems)
        else:
            kwargs = dict(
                charging_point_data=charging_point_data,
                building_data=building_data,
                prices=prices_df,
                temperature=temperature_df,
                activation=activation_df,
                start_date=start_ts,
                days=n_days,
                horizon_hours=horizon,
                store_hours=store,
                fcrn_on=_flag(fcrn_on, 0),
                fcrdd_on=_flag(fcrdd_on, 0),
                fcrdu_on=_flag(fcrdu_on, 0),
                aging=_flag(aging_on, 1),
                v2g_on=_flag(v2g_on, 0),
                dc=bool(_flag(dc, 0)),
                building_on=b_on,
                previous_monthly_peak=float(previous_monthly_peak or 0.0),
                current_month=int(current_month) if current_month else start_ts.month,
                initial_bess_soc=float(0.5 if initial_bess_soc is None
                                       else initial_bess_soc),
                pv_on=_flag(pv_on, 1),
                bess_on=_flag(bess_on, 1),
            )

            cache_path = None
            if cache_folder:
                key = _hash_inputs([prices_df, temperature_df, activation_df,
                                    sorted((building_data or {}).keys()),
                                    [(k, len(v)) for k, v in
                                     sorted((charging_point_data or {}).items())],
                                    sorted((v for k, v in kwargs.items()
                                            if not isinstance(v, (dict, pd.DataFrame))),
                                           key=repr),
                                    solver, time_limit])
                if not os.path.isdir(str(cache_folder)):
                    os.makedirs(str(cache_folder))
                cache_path = os.path.join(str(cache_folder),
                                          "lec_results_{}.csv".format(key))

            if cache_path and os.path.isfile(cache_path):
                raw_results = pd.read_csv(cache_path, index_col=0, parse_dates=True)
                solved = True
                notes.append("Loaded from cache: {}".format(os.path.basename(cache_path)))
            else:
                # Redirect the hardcoded SolverFactory('gurobi') at
                # functions1.py:895 and translate the TimeLimit option key.
                original_factory = functions1.pyo.SolverFactory
                limit_key = TIME_LIMIT_KEYS.get(solver)
                if limit_key is None:
                    notes.append("No known time-limit option for '{}'; the 120 s "
                                 "limit in functions1.py may be ignored.".format(solver))

                def _factory(name, *a, **kw):
                    inner = original_factory(
                        solver if name == "gurobi" else name, *a, **kw)
                    return _SolverProxy(inner, limit_key, time_limit)

                functions1.pyo.SolverFactory = _factory
                try:
                    raw_results = optimization_function_lec(**kwargs)
                finally:
                    functions1.pyo.SolverFactory = original_factory

                if raw_results is None or len(raw_results) == 0:
                    problems.append("The optimizer returned no rows. Check the Rhino "
                                    "output panel for the day-loop messages.")
                else:
                    solved = True
                    if cache_path:
                        raw_results.to_csv(cache_path)
                        notes.append("Cached to {}".format(os.path.basename(cache_path)))

            if solved:
                expected_rows = n_days * 24 * res
                if len(raw_results) < expected_rows:
                    notes.append("Got {} rows, expected {}. A day ended early - look "
                                 "for 'unfeasible' or index messages in the output "
                                 "panel.".format(len(raw_results), expected_rows))
                if "Overall cost" in raw_results.columns:
                    total_cost = float(raw_results["Overall cost"].sum())
                else:
                    notes.append("'Overall cost' is missing from the results.")

                lines = ["Optimization completed.",
                         "  solver:    {} ({} s limit)".format(solver, time_limit),
                         "  days:      {}".format(n_days),
                         "  rows:      {} at {} steps/hour".format(len(raw_results), res),
                         "  period:    {} -> {}".format(raw_results.index[0],
                                                        raw_results.index[-1]),
                         "  total cost: {:.3f}".format(total_cost)]
            else:
                lines = ["Optimization did not produce results:\n- "
                         + "\n- ".join(problems)]

            if notes:
                lines.append("")
                lines.append("NOTES ({}):".format(len(notes)))
                lines.extend("  - " + n for n in notes)
            report = "\n".join(lines)

    except ImportError as import_err:
        report = ("Import failed: {}\nCheck that repo_root is correct and that the "
                  "# r: header lists every package functions1.py imports "
                  "(pandas, numpy, pyomo, matplotlib).".format(import_err))
    except AssertionError as assert_err:
        report = ("An EV session failed a feasibility assertion inside "
                  "functions1.py:\n  {}\nFix it in EV Session Builder - check its "
                  "dropped_table.\n\n{}".format(assert_err, traceback.format_exc()))
    except Exception as solve_err:
        raw_results = pd.DataFrame()
        total_cost = 0.0
        solved = False
        report = "Failed: {}\n\n{}".format(solve_err, traceback.format_exc())
