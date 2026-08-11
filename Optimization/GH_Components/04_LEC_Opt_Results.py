#! python3
# r: pandas, numpy

ghenv.Component.Name = 'LEC Opt Results'
ghenv.Component.NickName = 'LECOptResults'
ghenv.Component.Message = '0.1.0'
ghenv.Component.Category = 'ECOM4Future'
ghenv.Component.SubCategory = '2 :: Optimization'
ghenv.Component.AdditionalHelpFromDocStrings = '2'

"""
Parse optimizer outputs into Grasshopper-friendly structures.

Two corrections against a naive read of the results frame:

1. ENERGY vs POWER. P_import_all and P_export_all are average power in kW -
   functions1.py:834 divides by the resolution to get energy. Summing them
   directly gives a figure that is 4x too high at 15-min resolution. This
   component divides by the resolution inferred from the index.

2. AGING COST. functions1.py:1297-1298 builds Cyc_Cost and Cal_Cost with
   regex '_CycCost$', which only matches the building columns
   '{building}_bess_CycCost'. The EV-side equivalents are named
   '{cp}_Cyclic_cost' and '{cp}_Calendar_cost' and are silently excluded.
   Both are reported separately here so nothing is hidden.

EV SOC WARNING: '{cp}_soc' is the SUM of every EV session's SOC at that charge
point (functions1.py:950), not a state of charge. With more than one session it
exceeds 1.0 and is not interpretable. Read it alongside ev_connection.

Inputs:
    run: Boolean toggle.
    raw_results: DataFrame from LEC Optimizer Core.
    strict: Boolean, default True. Raise if an expected column is missing rather
        than reporting a zero that looks like a real result.

Outputs:
    dispatch: DataFrame of the grid and cost timeseries.
    battery_soc: Dict[building] -> SOC list.
    ev_soc: Dict[charge point] -> summed session SOC list. See warning above.
    ev_connection: Dict[charge point] -> active ev_id per timestep.
    cost_breakdown: Dict of aggregated costs and revenues, in SEK.
    energy_summary: Dict of energy totals, in kWh.
    scenario: Flat summary dict.
    report: Summary and warning text. READ THIS.
"""

import pandas as pd
import numpy as np

DISPATCH_COLUMNS = ["P_import_spot", "P_export_spot", "P_import_all", "P_export_all",
                    "P_bid_fcrn", "P_bid_fcrdu", "P_bid_fcrdd",
                    "Transmission cost", "Supplier cost", "Peak cost", "DSO cost",
                    "Tax cost", "FCRN returns", "FCRD returns", "Overall cost"]

# Present only once the rolling wrapper has finished; missing means the run
# ended early inside the day loop.
WRAPPER_COLUMNS = ["Peak cost", "DSO cost", "Tax cost", "Overall cost",
                   "Cyc_Age", "Cal_Age", "Cyc_Cost", "Cal_Cost"]

warnings_out = []


def _warn(text):
    warnings_out.append(text)


def _colsum(df, name, required):
    if name in df.columns:
        return float(df[name].fillna(0.0).sum())
    if required and strict_mode:
        raise KeyError(
            "Expected column '{}' is missing from raw_results. The optimizer "
            "probably ended early inside the day loop - check the Rhino output "
            "panel. Set strict=False to report zeros instead.".format(name))
    _warn("Column '{}' is missing, reported as 0.0.".format(name))
    return 0.0


def _regex_sum(df, pattern):
    sub = df.filter(regex=pattern)
    if sub.empty:
        return 0.0, []
    return float(sub.fillna(0.0).sum().sum()), list(sub.columns)


if not run:
    dispatch = pd.DataFrame()
    battery_soc = {}
    ev_soc = {}
    ev_connection = {}
    cost_breakdown = {}
    energy_summary = {}
    scenario = {}
    report = "Toggle run to True."
elif raw_results is None or len(raw_results) == 0:
    dispatch = pd.DataFrame()
    battery_soc = {}
    ev_soc = {}
    ev_connection = {}
    cost_breakdown = {}
    energy_summary = {}
    scenario = {}
    report = ("raw_results is empty. The optimizer did not return rows - read the "
              "report on LEC Optimizer Core.")
else:
    strict_mode = True if strict is None else bool(strict)
    df = raw_results.copy()

    if not isinstance(df.index, pd.DatetimeIndex):
        raise TypeError("raw_results needs a DatetimeIndex to infer the resolution.")
    if len(df) < 2:
        raise ValueError("raw_results has {} row(s); at least 2 are needed to infer "
                         "the resolution.".format(len(df)))

    step_s = (df.index[1] - df.index[0]).total_seconds()
    resolution = int(round(3600.0 / step_s))
    if resolution not in (1, 4):
        _warn("Inferred {} steps/hour from the index, which functions1.py does not "
              "produce. Energy totals may be wrong.".format(resolution))

    missing_wrapper = [c for c in WRAPPER_COLUMNS if c not in df.columns]
    if missing_wrapper:
        _warn("Wrapper columns missing: {}. The run ended before "
              "functions1.py:1296-1306 completed, so cost totals are partial."
              .format(missing_wrapper))

    # ---- SOC series ----
    battery_soc = {}
    ev_soc = {}
    ev_connection = {}
    for col in df.columns:
        if col.endswith("_bess_soc"):
            battery_soc[col[:-len("_bess_soc")]] = df[col].fillna(0.0).tolist()
        elif col.endswith("_soc"):
            ev_soc[col[:-len("_soc")]] = df[col].fillna(0.0).tolist()
        elif col.endswith("_EV_connection"):
            name = col[:-len("_EV_connection")]
            ev_connection[name] = [None if pd.isna(v) else v for v in df[col].tolist()]

    for cp_name, series in ev_soc.items():
        peak = max(series) if series else 0.0
        if peak > 1.0 + 1e-6:
            _warn("{}_soc peaks at {:.2f}. functions1.py:950 sums SOC across "
                  "concurrent EV sessions at a charge point, so this is not a state "
                  "of charge and the day-to-day carry-over at functions1.py:1275 is "
                  "corrupted. Use one EV per charge point."
                  .format(cp_name, peak))

    # ---- dispatch timeseries, as a frame rather than a dict per row ----
    present = [c for c in DISPATCH_COLUMNS if c in df.columns]
    dispatch = df[present].copy()
    dispatch["Energy import kWh"] = df.get(
        "P_import_all", pd.Series(0.0, index=df.index)) / resolution
    dispatch["Energy export kWh"] = df.get(
        "P_export_all", pd.Series(0.0, index=df.index)) / resolution

    # ---- costs, all in SEK ----
    building_cyc, b_cyc_cols = _regex_sum(df, r"_bess_CycCost$")
    building_cal, b_cal_cols = _regex_sum(df, r"_bess_CalCost$")
    ev_cyc, ev_cyc_cols = _regex_sum(df, r"_Cyclic_cost$")
    ev_cal, ev_cal_cols = _regex_sum(df, r"_Calendar_cost$")
    if (ev_cyc_cols or ev_cal_cols) and "Cyc_Cost" in df.columns:
        _warn("EV aging cost columns {} are excluded from the repo's Cyc_Cost / "
              "Cal_Cost totals (functions1.py:1297 regex). Reported separately as "
              "ev_cyclic_aging_cost / ev_calendar_aging_cost."
              .format(ev_cyc_cols + ev_cal_cols))

    cost_breakdown = {
        "supplier_cost": _colsum(df, "Supplier cost", True),
        "transmission_cost": _colsum(df, "Transmission cost", True),
        "peak_cost": _colsum(df, "Peak cost", False),
        "dso_cost": _colsum(df, "DSO cost", False),
        "tax_cost": _colsum(df, "Tax cost", False),
        "fcrn_returns": _colsum(df, "FCRN returns", True),
        "fcrd_returns": _colsum(df, "FCRD returns", True),
        "building_cyclic_aging_cost": building_cyc,
        "building_calendar_aging_cost": building_cal,
        "ev_cyclic_aging_cost": ev_cyc,
        "ev_calendar_aging_cost": ev_cal,
        "total_aging_cost": building_cyc + building_cal + ev_cyc + ev_cal,
        "overall_cost": _colsum(df, "Overall cost", False),
    }

    # ---- energy, all in kWh ----
    import_kwh = _colsum(df, "P_import_all", True) / resolution
    export_kwh = _colsum(df, "P_export_all", True) / resolution
    energy_summary = {
        "resolution_steps_per_hour": resolution,
        "grid_import_kwh": import_kwh,
        "grid_export_kwh": export_kwh,
        "net_import_kwh": import_kwh - export_kwh,
        "spot_import_kwh": _colsum(df, "P_import_spot", False) / resolution,
        "spot_export_kwh": _colsum(df, "P_export_spot", False) / resolution,
        "peak_net_import_kw": float((df.get("P_import_all", 0.0)
                                     - df.get("P_export_all", 0.0)).max())
                              if "P_import_all" in df.columns else 0.0,
    }

    aging_pct = {"cyclic_aging_pct": _colsum(df, "Cyc_Age", False) / max(len(df), 1),
                 "calendar_aging_pct": _colsum(df, "Cal_Age", False) / max(len(df), 1)}

    scenario = {"timesteps": int(len(df)),
                "days": round(len(df) / (24.0 * resolution), 2),
                "start": str(df.index[0]),
                "end": str(df.index[-1])}
    scenario.update(energy_summary)
    scenario.update(cost_breakdown)
    scenario.update(aging_pct)

    if "Peak cost" in df.columns:
        _warn("peak_cost is pro-rated per timestep (functions1.py:1301). Over a "
              "partial month it is a fraction of the real monthly demand charge.")

    lines = ["Parsed optimization results.",
             "  rows:       {} at {} steps/hour ({:.2f} days)".format(
                 len(df), resolution, len(df) / (24.0 * resolution)),
             "  period:     {} -> {}".format(df.index[0], df.index[-1]),
             "  buildings:  {}".format(sorted(battery_soc.keys())),
             "  charge pts: {}".format(sorted(ev_soc.keys())),
             "",
             "  grid import: {:>12.2f} kWh".format(import_kwh),
             "  grid export: {:>12.2f} kWh".format(export_kwh),
             "  peak net:    {:>12.2f} kW".format(energy_summary["peak_net_import_kw"]),
             "",
             "  supplier:    {:>12.2f} SEK".format(cost_breakdown["supplier_cost"]),
             "  DSO:         {:>12.2f} SEK".format(cost_breakdown["dso_cost"]),
             "  tax:         {:>12.2f} SEK".format(cost_breakdown["tax_cost"]),
             "  FCR-N:       {:>12.2f} SEK".format(-cost_breakdown["fcrn_returns"]),
             "  FCR-D:       {:>12.2f} SEK".format(-cost_breakdown["fcrd_returns"]),
             "  aging:       {:>12.2f} SEK (not in Overall cost)".format(
                 cost_breakdown["total_aging_cost"]),
             "  OVERALL:     {:>12.2f} SEK".format(cost_breakdown["overall_cost"])]
    if warnings_out:
        lines.append("")
        lines.append("WARNINGS ({}):".format(len(warnings_out)))
        lines.extend("  - " + w for w in warnings_out)
    report = "\n".join(lines)
