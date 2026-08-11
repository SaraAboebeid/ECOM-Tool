# LEC Optimization — Grasshopper components

Four components wrapping `Optimization/LEC-Opt/functions1.py`. Wire them in order:

```
ECOM Opt Prep ──┬─→ building_data, prices_df, temperature_df, activation_df, days, current_month ──┐
                └─→ charge_point_data_raw ──→ EV Session Builder ──→ charging_point_data ──────────┤
                                                                                                   ▼
                                                                                        LEC Optimizer Core
                                                                                                   │
                                                                                                   ▼
                                                                                          LEC Opt Results
```

Each component's `report` output carries validation warnings. Panel it and read it —
the components are deliberately loud rather than defaulting silently.

## Before the first run

1. **Solver.** `functions1.py:895` hardcodes `SolverFactory('gurobi')` and pip's
   pyomo ships no solver. Install Gurobi (a Chalmers academic licence covers it),
   confirm `gurobi.bat` is on PATH, then verify from a bare GH Python component:

   ```python
   #! python3
   # r: pyomo
   import pyomo.environ as pyo
   a = pyo.SolverFactory('gurobi').available(exception_flag=False)
   ```

   `LEC Optimizer Core` checks this before solving and its `solver_name` input can
   redirect to `cbc` or `glpk` without editing the repo. It cannot redirect to
   `appsi_highs` — see the repo patches below.

2. **Analysis period.** Must extend **12 hours** past the last day you want
   optimized. The rolling horizon advances 24 h but looks ahead 36 h. `ECOM Opt
   Prep` already subtracts this from its `days` output.

3. **Boolean inputs.** Use Boolean Toggles, never text panels. `bool("False")` is
   `True`. The components normalize strings defensively, but toggles are correct.

4. **One EV per charge point.** `functions1.py:950` sums EV SOC per charge point,
   and `functions1.py:1275` feeds that sum into the next day's arrival SOC. With
   concurrent sessions the value exceeds 1.0 and trips the assertion at
   `functions1.py:32` on day 2.

## Suggested first run

Get this working end to end before enabling anything else:

```
1 building, 1 charge point, 1 EV, 2 days, 60-min resolution
fcrn_on=0  fcrdu_on=0  fcrdd_on=0  v2g_on=0  aging=0  dc=0
building_on=1  pv_on=1  bess_on=1
```

Then enable aging, then FCR-N, then FCR-D — one at a time. Each flag activates a
different constraint block, and an infeasible model with all of them on is very
hard to diagnose.

## Repo patches still required

These live in `functions1.py` and cannot be fixed from Grasshopper.

| Location | Problem | Fix |
|---|---|---|
| `functions1.py:1218-1221` | Activation columns are multiplied by `11.1/1000`, copy-pasted from the price lines above. Activation is a dimensionless fraction (`functions1.py:280`), so FCR-N activation is ~90× too small. | Drop the `* 11.1 / 1000`, then set `fix_activation_scaling=False` on ECOM Opt Prep. |
| `functions1.py:1297-1298` | `Cyc_Cost` / `Cal_Cost` use regex `_CycCost$`, matching only building batteries. EV columns are `{cp}_Cyclic_cost`. | Widen to `(_CycCost\|_Cyclic_cost)$`. LEC Opt Results reports both separately meanwhile. |
| `functions1.py:1300` | `.resample('M')` is deprecated in pandas 2.2 and removed in 3.0. | Change to `.resample('ME')`. |
| `functions1.py:950, 1275` | EV SOC is summed per charge point, breaking multi-session carry-over. | Emit `{cp}_S{session_id}_soc` and read the session-specific column in the carry-over. |
| `functions1.py:1228` | Reads `results.solver.termination_condition`, which appsi solvers do not expose. | Branch on the results type to allow `appsi_highs`. |

Until the activation fix lands, `ECOM Opt Prep` defaults to `fix_activation_scaling=True`,
which cancels the bug and gives physically correct activation — **results will differ
from the repo notebooks**. Set it to `False` to reproduce notebook behaviour.

## Units

| Quantity | Unit |
|---|---|
| `electricity_load`, `pv_production` | kW (average power). `functions1.py:1080` divides by resolution. |
| `prices_df` columns | EUR/MWh. `functions1.py:1211` multiplies by 11.1/1000. Prep converts from SEK/kWh. |
| `activation_df` columns | Dimensionless fraction, 0–1. |
| `P_import_all`, `P_export_all` | kW. Divide by resolution for kWh — LEC Opt Results does this. |
| Cost columns | SEK per timestep. |
