#! python3
# r: pandas, numpy

ghenv.Component.Name = 'ECOM Opt Prep'
ghenv.Component.NickName = 'ECOMOptPrep'
ghenv.Component.Message = '0.1.0'
ghenv.Component.Category = 'ECOM4Future'
ghenv.Component.SubCategory = '2 :: Optimization'
ghenv.Component.AdditionalHelpFromDocStrings = '2'

"""
Prepare optimization inputs for the LEC optimization wrapper.

IMPORTANT - the analysis_period must extend LOOKAHEAD_HOURS (12 h) past the last
day you want optimized. The rolling horizon advances 24 h but looks ahead 36 h,
so the final day is silently under-constrained without that tail. The 'days'
output already subtracts it.

Inputs:
    run: Boolean toggle.
    community: EnergyCommunity object.
    analysis_period: Ladybug AnalysisPeriod.
    start_date: String, e.g. "2024-01-01 00:00:00".
    spot_price: Scalar, list, DataFrame, or price object (SEK/kWh by default).
    temperature: Scalar or list, degrees C.
    fcrn_prices, fcrdu_prices, fcrdd_prices: Optional scalar/list.
    reg_up_prices, reg_down_prices: Optional scalar/list.
    act_fcrn_up, act_fcrn_down, act_fcrd_up, act_fcrd_down: Optional, 0-1 fractions.
    prices_are_sek_per_kwh: Boolean, default True.
    fix_activation_scaling: Boolean, default True. See ACTIVATION note below.

Outputs:
    building_data: Dict[name] -> DataFrame with optimizer-required columns.
    charge_point_data_raw: Dict[cp_name] -> metadata used by EV Session Builder.
    prices_df, temperature_df, activation_df: DataFrames with exact optimizer columns.
    days: Integer, already reduced by the 12 h look-ahead.
    current_month: Integer derived from start_date.
    bess_soc_map: Dict[name] -> initial SOC. The optimizer only accepts a scalar,
                  so this is for inspection / manual seeding.
    report: Summary and warning text. READ THIS.

ACTIVATION note:
    functions1.py:1218-1221 multiplies the activation columns by 11.1/1000, which
    is copy-pasted from the price lines above. Activation is a dimensionless
    fraction (see functions1.py:280), so that scaling is a bug and it makes FCR-N
    activation ~90x too small.
    fix_activation_scaling=True pre-multiplies by 1000/11.1 to cancel it, giving
    physically correct activation. Results then DIFFER from the repo notebooks.
    Set it to False to reproduce notebook behaviour, or patch functions1.py and
    set it to False permanently.

UNITS:
    Building electricity_load and pv_production must be average power in kW.
    functions1.py:1080 divides them by the resolution to obtain energy.
"""

import pandas as pd
import numpy as np

# Must match the hardcoded 11.1 in functions1.py:1211. Do not expose as an input:
# the prep divides by it and functions1 multiplies by its own constant, so any
# mismatch silently rescales every price.
SEK_PER_EUR = 11.1
LOOKAHEAD_HOURS = 12  # horizon_hours (36) - store_hours (24)

warnings_out = []


def _warn(text):
    warnings_out.append(text)


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


def _analysis_steps(ap):
    if ap is None:
        raise ValueError("analysis_period is required.")
    if not hasattr(ap, "hoys"):
        raise ValueError("analysis_period must expose 'hoys'.")
    return len(list(ap.hoys))


def _resolution(ap):
    return max(int(getattr(ap, "timestep", 1) or 1), 1)


def _build_index(start_date_text, steps, resolution):
    start_ts = pd.Timestamp(start_date_text)
    freq_minutes = int(round(60.0 / float(resolution)))
    return pd.date_range(start=start_ts, periods=steps, freq="{}min".format(freq_minutes))


def _slice_annual(values, steps, ap, label):
    """Align an annual or arbitrary-length series onto the analysis period."""
    vals = [float(v) for v in _ensure_list(values)]
    if not vals:
        return [0.0] * steps
    if len(vals) == steps:
        return vals

    res = _resolution(ap)
    hoys = list(getattr(ap, "hoys", []))
    if hoys:
        # hoys are in hours; the source array may be hourly or sub-hourly. Only
        # scale by timestep when the array length implies sub-hourly data.
        if len(vals) >= 8760 * res and res > 1:
            start_i = int(round(float(hoys[0]) * res))
        else:
            if res > 1 and len(vals) < 8760 * res:
                _warn("{}: source has {} values but the analysis period is at "
                      "{}x resolution. Values are being repeated per timestep."
                      .format(label, len(vals), res))
            start_i = int(round(float(hoys[0])))
        start_i = start_i % len(vals)
        return [vals[(start_i + i) % len(vals)] for i in range(steps)]

    if len(vals) > steps:
        _warn("{}: truncating {} values to {} steps.".format(label, len(vals), steps))
        return vals[:steps]
    _warn("{}: only {} values for {} steps, tiling.".format(label, len(vals), steps))
    return [vals[i % len(vals)] for i in range(steps)]


def _coerce_numeric_series(value, steps, ap, default, label):
    if value is None:
        return [float(default)] * steps
    if isinstance(value, (int, float, np.integer, np.floating)):
        return [float(value)] * steps

    if isinstance(value, pd.Series):
        return _slice_annual(value.tolist(), steps, ap, label)

    if isinstance(value, pd.DataFrame):
        numeric_cols = list(value.select_dtypes(include=[np.number]).columns)
        if not numeric_cols:
            raise ValueError("{}: DataFrame has no numeric columns.".format(label))
        if len(numeric_cols) > 1:
            _warn("{}: DataFrame has {} numeric columns, using '{}'."
                  .format(label, len(numeric_cols), numeric_cols[0]))
        return _slice_annual(value[numeric_cols[0]].tolist(), steps, ap, label)

    for attr in ("price_data", "price", "values", "hourly_values"):
        if isinstance(value, dict) and attr in value:
            return _coerce_numeric_series(value[attr], steps, ap, default, label)
        if not isinstance(value, dict) and hasattr(value, attr):
            return _coerce_numeric_series(getattr(value, attr), steps, ap, default, label)

    return _slice_annual(value, steps, ap, label)


def _sum_profiles(objects, attr_names, steps, ap, label):
    total = np.zeros(steps, dtype=float)
    for i, obj in enumerate(_ensure_list(objects)):
        if not _has_any(obj, attr_names):
            _warn("{}[{}]: none of {} found, contributing zero.".format(label, i, attr_names))
            continue
        candidate = _get_any(obj, attr_names, [])
        total += np.array(
            _coerce_numeric_series(candidate, steps, ap, 0.0, "{}[{}]".format(label, i)),
            dtype=float)
    return total.tolist()


# ---------------------------------------------------------------- main

if not run:
    building_data = {}
    charge_point_data_raw = {}
    prices_df = pd.DataFrame()
    temperature_df = pd.DataFrame()
    activation_df = pd.DataFrame()
    days = 0
    current_month = 1
    bess_soc_map = {}
    report = "Toggle run to True."
else:
    if not start_date:
        raise ValueError("start_date is required, for example '2024-01-01 00:00:00'.")
    if community is None:
        raise ValueError("community is required.")

    steps = _analysis_steps(analysis_period)
    res = _resolution(analysis_period)
    if res not in (1, 4):
        raise ValueError("functions1.py only supports 60-min or 15-min resolution, "
                         "got timestep={}.".format(res))

    idx = _build_index(start_date, steps, res)
    current_month = int(pd.Timestamp(start_date).month)

    # Reserve the look-ahead tail. The DataFrames still cover the full period.
    days = int((steps - LOOKAHEAD_HOURS * res) // (24 * res))
    if days < 1:
        days = 1
        _warn("Analysis period is shorter than 24 h + {} h look-ahead. Running 1 day "
              "with a truncated horizon: the last day's EV departure-SOC constraints "
              "will be skipped (functions1.py:255).".format(LOOKAHEAD_HOURS))

    if prices_are_sek_per_kwh is None:
        prices_are_sek_per_kwh = True
    if fix_activation_scaling is None:
        fix_activation_scaling = True

    price_factor = (1000.0 / SEK_PER_EUR) if prices_are_sek_per_kwh else 1.0
    act_factor = (1000.0 / SEK_PER_EUR) if fix_activation_scaling else 1.0

    def _prices(value, label):
        return (np.array(_coerce_numeric_series(value, steps, analysis_period, 0.0, label),
                         dtype=float) * price_factor).tolist()

    def _activation(value, label):
        arr = np.array(_coerce_numeric_series(value, steps, analysis_period, 0.0, label),
                       dtype=float)
        if arr.size and (arr.min() < -1e-9 or arr.max() > 1.0 + 1e-9):
            _warn("{}: values outside 0-1. Activation must be a fraction of the bid "
                  "(functions1.py:280). Range seen: {:.3f} to {:.3f}."
                  .format(label, float(arr.min()), float(arr.max())))
        return (arr * act_factor).tolist()

    prices_df = pd.DataFrame(index=idx)
    prices_df["Spot prices"] = _prices(spot_price, "spot_price")
    prices_df["FCRN prices"] = _prices(fcrn_prices, "fcrn_prices")
    prices_df["FCRDU prices"] = _prices(fcrdu_prices, "fcrdu_prices")
    prices_df["FCRDD prices"] = _prices(fcrdd_prices, "fcrdd_prices")
    prices_df["Up reg prices"] = _prices(reg_up_prices, "reg_up_prices")
    prices_df["Down reg prices"] = _prices(reg_down_prices, "reg_down_prices")

    temperature_df = pd.DataFrame(index=idx)
    temperature_df["Temperature"] = _coerce_numeric_series(
        temperature, steps, analysis_period, 20.0, "temperature")

    activation_df = pd.DataFrame(index=idx)
    activation_df["FCR-N-up"] = _activation(act_fcrn_up, "act_fcrn_up")
    activation_df["FCR-N-down"] = _activation(act_fcrn_down, "act_fcrn_down")
    activation_df["FCR-D-up"] = _activation(act_fcrd_up, "act_fcrd_up")
    activation_df["FCR-D-down"] = _activation(act_fcrd_down, "act_fcrd_down")

    # ---- buildings ----
    building_data = {}
    bess_soc_map = {}
    buildings = _ensure_list(_get_any(community, ["buildings", "building"], []))
    if not buildings:
        _warn("No buildings found on the community object. Set building_on=0 "
              "on the optimizer, or check the 'buildings' attribute name.")

    seen_names = set()
    for bldg in buildings:
        b_name = str(_get_any(bldg, ["name", "id"], "Building"))
        # Pyomo builds component names from these; collisions overwrite variables.
        if b_name in seen_names:
            raise ValueError("Duplicate building name '{}'. Names must be unique "
                             "and Pyomo-safe.".format(b_name))
        if not b_name.replace("_", "").isalnum():
            raise ValueError("Building name '{}' must be alphanumeric/underscore "
                             "only - it becomes a Pyomo component name.".format(b_name))
        seen_names.add(b_name)

        if not _has_any(bldg, ["electric_demand", "hourly_demand"]):
            _warn("{}: no electric_demand found, using zeros.".format(b_name))
        load = _coerce_numeric_series(
            _get_any(bldg, ["electric_demand", "hourly_demand"], []),
            steps, analysis_period, 0.0, "{}.electric_demand".format(b_name))

        pv_objects = _ensure_list(
            _get_any(bldg, ["PV_plant", "pv_plant", "PV_plants", "pv_plants"], []))
        pv_profile = _sum_profiles(
            pv_objects, ["hourly_result", "hourly_output", "hourly_production"],
            steps, analysis_period, "{}.PV".format(b_name))

        batteries = _ensure_list(_get_any(bldg, ["Battery", "battery", "batteries"], []))
        batt = batteries[0] if batteries else None
        if len(batteries) > 1:
            _warn("{}: {} batteries found, only the first is used - the optimizer "
                  "models one BESS per building.".format(b_name, len(batteries)))

        if batt is None:
            bess_capacity, bess_power, bess_soc = 0.0, 0.0, 0.5
        else:
            bess_capacity = float(_get_any(batt, ["capacity"], 0.0))
            if _has_any(batt, ["max_power", "power"]):
                bess_power = float(_get_any(batt, ["max_power", "power"], 0.0))
            else:
                # Never silently fall back to capacity: that implies a 1C battery.
                raise ValueError("{}: battery exposes no max_power/power. Set it "
                                 "explicitly - inferring it from capacity would "
                                 "silently assume a 1C rate.".format(b_name))
            bess_soc = float(_get_any(batt, ["initial_soc"], 0.5))
            if bess_capacity > 0 and bess_power <= 0:
                _warn("{}: battery power is 0, the BESS cannot cycle.".format(b_name))

        df = pd.DataFrame(index=idx)
        df["electricity_load"] = [float(v) for v in load]
        df["pv_production"] = [float(v) for v in pv_profile]
        df["bess_capacity"] = bess_capacity
        df["bess_power"] = bess_power

        if float(np.abs(df["electricity_load"]).sum()) == 0.0:
            _warn("{}: electricity_load is all zeros.".format(b_name))

        building_data[b_name] = df
        bess_soc_map[b_name] = bess_soc

    if len(set(round(v, 6) for v in bess_soc_map.values())) > 1:
        _warn("Buildings have different initial SOCs {} but functions1.py:1034 "
              "applies a single scalar to all of them. Per-building SOC is lost."
              .format({k: round(v, 3) for k, v in bess_soc_map.items()}))

    # ---- charge points ----
    charge_point_data_raw = {}
    charge_points = _ensure_list(
        _get_any(community, ["charging_points", "charge_point"], []))
    for cp in charge_points:
        cp_name = str(_get_any(cp, ["name", "id"], "ChargePoint"))
        if cp_name in charge_point_data_raw:
            raise ValueError("Duplicate charge point name '{}'.".format(cp_name))
        if not cp_name.replace("_", "").isalnum():
            raise ValueError("Charge point name '{}' must be alphanumeric/underscore "
                             "only - it becomes a Pyomo component name.".format(cp_name))

        cp_evs = _ensure_list(_get_any(cp, ["EV", "ev", "EVs", "evs"], []))
        cp_power = float(_get_any(cp, ["max_power", "rated_power", "capacity"], 0.0))
        if cp_power <= 0:
            _warn("{}: no max_power found (got {}). EVs without their own power "
                  "rating will fail the feasibility assertion at functions1.py:37."
                  .format(cp_name, cp_power))
        if len(cp_evs) > 1:
            _warn("{}: {} EVs on one charge point. functions1.py:950 sums EV SOC "
                  "per charge point, so the day-to-day carry-over at "
                  "functions1.py:1275 will exceed 1.0 and trip the arrival-SOC "
                  "assertion. Use one EV per charge point."
                  .format(cp_name, len(cp_evs)))

        charge_point_data_raw[cp_name] = {
            "name": cp_name,
            "charge_point_object": cp,
            "evs": cp_evs,
            "max_power": cp_power,
            "is_v2g": bool(_get_any(cp, ["is_v2g", "v2g_enabled"], False)),
        }

    if not charge_point_data_raw:
        _warn("No charge points found. functions1.py requires at least one.")

    lines = ["Prepared optimizer inputs.",
             "  buildings:      {}".format(len(building_data)),
             "  charge points:  {}".format(len(charge_point_data_raw)),
             "  timesteps:      {} at {} per hour".format(steps, res),
             "  optimized days: {} (+{} h look-ahead reserved)".format(days, LOOKAHEAD_HOURS),
             "  period:         {} -> {}".format(idx[0], idx[-1]),
             "  current_month:  {}".format(current_month),
             "  prices:         {}".format(
                 "converted SEK/kWh -> EUR/MWh" if prices_are_sek_per_kwh
                 else "passed through as EUR/MWh"),
             "  activation:     {}".format(
                 "PRE-SCALED to cancel the functions1.py:1218 bug - results will "
                 "NOT match the repo notebooks" if fix_activation_scaling
                 else "passed through raw, reproducing notebook behaviour "
                      "(activation is ~90x too small)")]
    if warnings_out:
        lines.append("")
        lines.append("WARNINGS ({}):".format(len(warnings_out)))
        lines.extend("  - " + w for w in warnings_out)
    report = "\n".join(lines)
