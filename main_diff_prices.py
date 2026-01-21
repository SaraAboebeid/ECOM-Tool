# ADMM algorithm
from dso_opt1 import *
from lec_opt1 import *
import numpy as np
import pandas as pd

# Initialize agents
T = 24
spot_prices = [0.609, 0.636, 0.650, 0.642, 0.620, 0.651, 0.946, 1.449, 2.004, 1.785, 1.115, 0.846, 0.744,
               0.789, 0.880, 1.066, 1.403, 1.750, 2.063, 2.2366, 1.989, 1.478, 1.003, 0.665]

# 24-hour realistic load and PV
load = [8.1, 7.6, 7.3, 7.8, 8.2, 10.1, 18.0, 19.1, 18.5, 16.3, 15.2, 16.1, 17.5, 18.0, 17.8, 18.4, 22.3, 23.1, 22.5,
        21.0, 20.2, 18.0, 14.5, 10.1]
pv_production = [0, 0, 0, 0, 0, 0, 1.5, 4.4, 7.2, 9.4, 10.8, 11.2, 11.0, 10.1, 8.3, 5.2, 2.1, 0.4, 0, 0, 0, 0, 0, 0]
load1 = [10.5, 10.2, 10.1, 10.3, 11.0, 14.1, 23.2, 24.5, 23.8, 22.4, 21.0, 22.3, 23.0, 24.1, 24.8, 25.3, 27.9, 28.2,
         27.5, 26.2, 25.4, 22.1, 19.8, 15.0]
pv_production1 = [0, 0, 0, 0, 0, 0, 2.0, 6.0, 10.1, 13.3, 14.7, 15.0, 14.5, 13.4, 11.2, 7.8, 4.0, 0.9, 0, 0, 0, 0, 0, 0]

cp1 = charging_point(name='cp1', ev_capacity=[45, 65], ev_max_power=[10, 12], ev_arrival=[1, 2],
                     ev_departure=[20, 23], ev_arrival_soc=[0.5, 0.3], ev_desired_soc=[0.75, 0.6])
cp2 = charging_point(name='cp2', ev_capacity=[55, 95], ev_max_power=[10, 12], ev_arrival=[2, 4],
                     ev_departure=[22, 24], ev_arrival_soc=[0.4, 0.7], ev_desired_soc=[0.75, 0.75])
cp3 = charging_point(name='cp3', ev_capacity=[45, 65], ev_max_power=[10, 12], ev_arrival=[1, 2],
                     ev_departure=[20, 23], ev_arrival_soc=[0.5, 0.3], ev_desired_soc=[0.75, 0.6])
cp4 = charging_point(name='cp4', ev_capacity=[55, 95], ev_max_power=[10, 12], ev_arrival=[2, 4],
                     ev_departure=[22, 24], ev_arrival_soc=[0.4, 0.7], ev_desired_soc=[0.75, 0.75])
cp5 = charging_point(name='cp5', ev_capacity=[45, 65], ev_max_power=[10, 12], ev_arrival=[1, 2],
                     ev_departure=[20, 23], ev_arrival_soc=[0.5, 0.3], ev_desired_soc=[0.75, 0.6])
cp6 = charging_point(name='cp6', ev_capacity=[55, 95], ev_max_power=[10, 12], ev_arrival=[2, 4],
                     ev_departure=[22, 24], ev_arrival_soc=[0.4, 0.7], ev_desired_soc=[0.75, 0.75])

b1 = building(name='b1', load=load, pv_production=pv_production, bess_capacity=500, bess_initial_soc=0.8,
              bess_max_power=50)
b2 = building(name='b2', load=load1, pv_production=pv_production1, bess_capacity=400, bess_initial_soc=0.8,
              bess_max_power=80)
b3 = building(name='b3', load=[0 * i for i in range(len(load1))],
              pv_production=[0 * i for i in range(len(pv_production1))],
              bess_capacity=300, bess_initial_soc=0.8, bess_max_power=60)

rho = 0.1  # ADMM penalty
# ========================================================================
# STEP 1: INITIALIZATION
# ========================================================================
# Initialize dso exchanged power
P_dso_import_init = [0.0 for _ in range(T)]
P_dso_export_init = [0.0 for _ in range(T)]

# Initialize flexibility variable (kW)
flex_price_init = [0.0 for _ in range(T)]

# DSO configuration
buses = ['B0', 'B1', 'B2', 'B3']
lec_buses = ['B2', 'B3']
VOLL = 1000.0  # $/kWh (Value of Lost Load)
grid_limit_kW = 5000.0

# ========================================================================
# STEP 2: CALCULATE BASELINE (No Coordination)
# ========================================================================
# lec2 connected to bus 2
opt_lec2_baseline = lec_opt([cp1, cp2, cp3], [b1, b2], spot_prices,
                       flex_price=flex_price_init, P_dso_import=P_dso_import_init,
                       P_dso_export=P_dso_export_init, roh=rho)
opt_lec2_baseline.solve(use_extended=False)
lec2_baseline_results = opt_lec2_baseline.get_results()

# lec1 connected to bus 3
opt_lec3_baseline = lec_opt([cp4, cp5, cp6], [b3], spot_prices,
                       flex_price=flex_price_init, P_dso_import=P_dso_import_init,
                       P_dso_export=P_dso_export_init, roh=rho)
opt_lec3_baseline.solve(use_extended=False)
lec3_baseline_results = opt_lec3_baseline.get_results()

# Extract baseline power (kW)
P_lec_import = {}
P_lec_export = {}

for t in range(T):
    for b in buses:
        if b in lec_buses:
            bus_num = int(b[1:])  # extract number from 'B1' → 1

            # Build variable name like "lec1_baseline_results"
            var_name = f"lec{bus_num}_baseline_results"

            # Access the variable dynamically
            lec_data = globals()[var_name]

            P_lec_import[(t, b)] = float(lec_data['P_import'][t])
            P_lec_export[(t, b)] = float(lec_data['P_export'][t])
        else:
            P_lec_import[(t, b)] = 0
            P_lec_export[(t, b)] = 0

print(P_lec_import)
print(P_lec_export)

# ========================================================================
# STEP 3: PREPARE DSO GRID DATA
# ========================================================================
bus_data = pd.DataFrame({
    'Bus': ['B0', 'B1', 'B2', 'B3'],
    'Type': ['slack', 'PQ', 'PQ', 'PQ']
})

line_data = pd.DataFrame({
    'From': ['B0', 'B0', 'B2'],
    'To': ['B1', 'B2', 'B3'],
    'X_ohm': [0.1, 0.15, 0.10],
    'Pline_limit': [1500, 150, 2500]  # line power limit in kW
})

# Load profiles (kW)
load_profile_b1 = [0] * 24
load_profile_b2 = [0] * 24
load_profile_b3 = [0] * 24

load_dict = {'Bus': ['B0', 'B1', 'B2', 'B3']}
for t in range(T):
    load_dict[t] = [0.0, float(load_profile_b1[t]), float(load_profile_b2[t]), float(load_profile_b3[t])]
load_data = pd.DataFrame(load_dict)

# ADMM parameters
# ---------------------
# User-tunable settings
# ---------------------
max_iters = 500
tol_abs = 1e-2
tol_rel = 1e-2
verbose = True

# ---------------------
# ADMM initialization
# ---------------------
flex_price = {}
P_dso_import = {}
P_dso_export = {}

for t in range(T):
    for b in lec_buses:
        flex_price[(t,b)] = 0
        P_dso_import[(t,b)] = 0  # Added: initialize for first iteration
        P_dso_export[(t,b)] = 0  # Added: initialize for first iteration
history = {'primal_norm': [], 'dual_norm': [], 'obj': []}

# ---------------------
# ADMM main loop
# ---------------------
for k in range(max_iters):

    # Store previous DSO net power for dual residual calculation
    P_dso_net_prev = np.array([
        [P_dso_import[(t, b)] - P_dso_export[(t, b)] for b in lec_buses]
        for t in range(T)
    ])
    # =================================================================
    # STEP 1: DSO UPDATE (with current flex_price and previous LEC power)
    # =================================================================
    dso = DSO(flex_price, P_lec_imp=P_lec_import, P_lec_exp=P_lec_export,
              VOLL=VOLL, S_base_MVA=100, V_base_kV=11, roh=rho)

    dso.add_buses(bus_data)
    dso.add_lines(line_data)
    dso.add_loads(load_data)
    dso.add_lecs(lec_buses)
    dso.set_grid_limit(p_grid_limit=grid_limit_kW)

    dso_results = dso.solve_dc_opf(solver_name='cplex', verbose=False)

    # Extract NEW DSO power
    P_dso_import_new = {}
    P_dso_export_new = {}
    for t in range(T):
        for b in lec_buses:
            P_dso_import_new[(t,b)]=float(dso_results['P_dso_import'][(t, b)])
            P_dso_export_new[(t,b)]=float(dso_results['P_dso_export'][(t, b)])

    # =================================================================
    # STEP 2: LEC UPDATE (with current flex_price and NEW DSO power)
    # =================================================================
    opt_lec2 = lec_opt([cp1, cp2, cp3], [b1, b2], spot_prices,
                    flex_price=[flex_price[(t, lec_buses[0])] for t in range(24)],
                    P_dso_import = [P_dso_import_new[(t, lec_buses[0])] for t in range(24)],
                    P_dso_export = [P_dso_export_new[(t, lec_buses[0])] for t in range(24)],
                    roh = rho)
    opt_lec2.solve(use_extended=True)
    lec2_results = opt_lec2.get_results()

    opt_lec3 = lec_opt([cp1, cp2, cp3, cp4, cp5, cp6], [b1, b2, b3], spot_prices,
                      flex_price=[flex_price[(t,lec_buses[1])] for t in range(24)],
                      P_dso_import=[P_dso_import_new[(t,lec_buses[1])] for t in range(24)],
                      P_dso_export=[P_dso_export_new[(t,lec_buses[1])] for t in range(24)],
                      roh=rho)
    opt_lec3.solve(use_extended=True)
    lec3_results = opt_lec3.get_results()

    # Extract NEW LEC power
    P_lec_import_new ={}
    P_lec_export_new ={}
    for t in range(T):
        for b in buses:
            if b in lec_buses:
                bus_num = int(b[1:])  # extract number from 'B1' → 1

                # Build variable name like "lec1_baseline_results"
                var_name = f"lec{bus_num}_results"

                # Access the variable dynamically
                lec_data = globals()[var_name]

                P_lec_import_new[(t, b)] = float(lec_data['P_import'][t])
                P_lec_export_new[(t, b)] = float(lec_data['P_export'][t])
            else:
                P_lec_import_new[(t, b)] = 0
                P_lec_export_new[(t, b)] = 0


    # =================================================================
    # STEP 3: DUAL UPDATE (with NEW LEC and NEW DSO power)
    # =================================================================
    flex_price_new = {}
    for t in range(T):
        for b in buses:
            if b in lec_buses:
                flex_price_new[(t,b)] = flex_price[(t,b)] + rho * (
                    (P_lec_import_new[(t,b)] - P_lec_export_new[(t,b)]) +
                    (P_dso_import_new[(t,b)] - P_dso_export_new[(t,b)])
            )
            else:
                flex_price_new[(t,b)] = 0

    # =================================================================
    # STEP 4: CONVERGENCE CHECK
    # =================================================================
    # Calculate net powers with NEW values
    P_lec_net_new = np.array([
        [P_lec_import_new[(t, b)] - P_lec_export_new[(t, b)] for b in lec_buses]
        for t in range(T)
    ])

    P_dso_net_new = np.array([
        [P_dso_import_new[(t, b)] - P_dso_export_new[(t, b)] for b in lec_buses]
        for t in range(T)
    ])


    # Primal residual: r^{k+1} = x^{k+1} + z^{k+1}
    primal_res = np.linalg.norm(P_lec_net_new + P_dso_net_new)

    # Dual residual: s^{k+1} = ρ(z^{k+1} - z^k)
    dual_res = np.linalg.norm(rho * (P_dso_net_new - P_dso_net_prev))

    # Stopping tolerances
    eps_pri = np.sqrt(T) * tol_abs + tol_rel * max(
        np.linalg.norm(P_lec_net_new),
        np.linalg.norm(P_dso_net_new)
    )
    eps_dual = np.sqrt(T) * tol_abs + tol_rel * rho * np.linalg.norm(np.array(list(flex_price_new.values())))

    history['primal_norm'].append(primal_res)
    history['dual_norm'].append(dual_res)

    if verbose:
        print(f"Iter {k}: primal_res={primal_res:.6f}, dual_res={dual_res:.6f}, "
              f"eps_pri={eps_pri:.6f}, eps_dual={eps_dual:.6f}")

    # Check convergence
    if primal_res <= eps_pri and dual_res <= eps_dual:
        print(f"\nADMM converged in {k + 1} iterations.")
        break

    # =================================================================
    # STEP 5: UPDATE FOR NEXT ITERATION
    # =================================================================
    P_lec_import = P_lec_import_new
    P_lec_export = P_lec_export_new
    P_dso_import = P_dso_import_new
    P_dso_export = P_dso_export_new
    flex_price = flex_price_new

else:
    print("Reached max iterations without convergence")

print("\nFinal Results:")
print(f"Primal residual: {primal_res:.6f}")
print(f"Dual residual: {dual_res:.6f}")

import numpy as np
import matplotlib.pyplot as plt



def plot_lec_load_and_cost(
        df_baseline,
        df_optimal,
        spot_prices,
        flex_price_dict,
        bus_name,
        timestep_hours=1.0,
        title_suffix=""
):
    """
    Compare baseline and optimal LEC load profiles and energy cost.

    Parameters
    ----------
    df_baseline : dict
        Results from baseline LEC optimization
    df_optimal : dict
        Results from ADMM-optimal LEC optimization
    spot_prices : list or array
        Spot prices [SEK/kWh]
    flex_price_dict : dict
        Flexibility prices {(t, bus): price}
    bus_name : str
        Bus name (e.g., 'B1', 'B2')
    timestep_hours : float
        Length of one timestep (default 1.0 for hourly)
    title_suffix : str
        Optional string to add to plot title
    """
    # -----------------------------
    # Net LEC load (import - export)
    # -----------------------------
    P_base = np.array(df_baseline['P_import']) - np.array(df_baseline['P_export'])
    P_opt = np.array(df_optimal['P_import']) - np.array(df_optimal['P_export'])

    # -----------------------------
    # Extract flexibility prices for this bus
    # -----------------------------
    T = len(P_base)
    flex_prices_list = [flex_price_dict.get((t, bus_name), 0) for t in range(T)]

    # -----------------------------
    # Energy cost calculation
    # -----------------------------
    # Calculate cost from the results (import * spot_price * timestep)
    cost_base = df_baseline['obj'][0]
    cost_opt = df_optimal['obj'][0]

    flex_cost = abs(cost_base - cost_opt)

    # -----------------------------
    # Plot load profiles
    # -----------------------------
    x = np.arange(T)
    bar_width = 0.4

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8))

    # Plot 1: Load comparison
    ax1.bar(
        x - bar_width / 2,
        P_base,
        width=bar_width,
        label='Baseline LEC load',
        alpha=0.8
    )
    ax1.bar(
        x + bar_width / 2,
        P_opt,
        width=bar_width,
        label='Optimal LEC load (ADMM)',
        alpha=0.8
    )
    ax1.set_xlabel('Time step (hour)', fontsize=11)
    ax1.set_ylabel('Net LEC Load (kW)', fontsize=11)
    ax1.set_title(f'LEC Load Profile Comparison - {bus_name} {title_suffix}', fontsize=12)
    ax1.legend()
    ax1.grid(True, axis='y', alpha=0.3)

    # Plot 2: Flexibility price
    ax2.plot(x, flex_prices_list, linewidth=2, marker='o', color='green')
    ax2.set_xlabel('Time step (hour)', fontsize=11)
    ax2.set_ylabel('Flexibility price (SEK/kW)', fontsize=11)
    ax2.set_title(f'Flexibility Price (ADMM) - {bus_name} {title_suffix}', fontsize=12)
    ax2.grid(True, alpha=0.3)
    ax2.axhline(y=0, color='k', linestyle='--', linewidth=0.8)

    plt.tight_layout()
    plt.show()

    # -----------------------------
    # Print cost summary
    # -----------------------------
    print(f'\n================ LEC COST SUMMARY ({bus_name}) ================')
    print(f'Baseline energy cost : {cost_base:.2f} SEK')
    print(f'Optimal energy cost  : {cost_opt:.2f} SEK')
    print(f'Flexibility cost     : {flex_cost:.2f} SEK')
    print(f'Cost increment   : {abs(flex_cost / cost_base) * 100:.2f}%')
    print('=' * 55)

    # -----------------------------
    # Return results for further use
    # -----------------------------
    return {
        'P_baseline': P_base,
        'P_optimal': P_opt,
        'cost_baseline': cost_base,
        'cost_optimal': cost_opt,
        'Flexibility cost': flex_cost
    }


# Call the function for LEC1 (Bus B1)
results_lec1 = plot_lec_load_and_cost(
    df_baseline=lec2_baseline_results,
    df_optimal=lec2_results,
    spot_prices=spot_prices,
    flex_price_dict=flex_price,
    bus_name='B2',
    timestep_hours=1.0,
    title_suffix="(ADMM Coordination)"
)

# Call the function for LEC2 (Bus B2)
results_lec2 = plot_lec_load_and_cost(
    df_baseline=lec3_baseline_results,
    df_optimal=lec3_results,
    spot_prices=spot_prices,
    flex_price_dict=flex_price,
    bus_name='B3',
    timestep_hours=1.0,
    title_suffix="(ADMM Coordination)"
)


