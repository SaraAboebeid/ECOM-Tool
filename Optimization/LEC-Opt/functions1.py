import pyomo.environ as pyo
import pandas as pd
import math
import numpy as np
from collections import defaultdict
from datetime import timedelta
from pyomo.util.infeasible import log_infeasible_constraints
import matplotlib.pyplot as plt
from pyomo.opt import TerminationCondition
from pathlib import Path
import warnings
warnings.simplefilter(action='ignore', category=FutureWarning)

# ---------------------------------------------------------------------------
# Solver configuration
#
# This used to be a hardcoded SolverFactory('gurobi'). Gurobi needs a licence,
# so the name is configurable and defaults to HiGHS, which pip installs via
# `highspy` and needs no licence. Set functions1.SOLVER_NAME = 'gurobi' to go
# back to Gurobi where it is available.
# ---------------------------------------------------------------------------
SOLVER_NAME = 'appsi_highs'
SOLVER_TIME_LIMIT = 120          # seconds per solve

# ---------------------------------------------------------------------------
# Tunable parameters
#
# These were literals inside the classes below. Hoisting them to module level
# lets a caller set them before building the model. They must be set BEFORE
# construction: the constraints and the objective read them during __init__,
# and pyo.Objective(rule=...) evaluates its rule immediately, so assigning to
# model.Effect_fee afterwards has no effect on the expression already built.
#
# Every default is unchanged, so existing notebooks behave exactly as before.
# ---------------------------------------------------------------------------
# One-way, NOT round-trip: the SOC balance applies it on charge and divides by
# it on discharge (soc += (ch*e - ds/e)/capacity), so the round-trip figure is
# e**2. At the 0.93 default that is 86.5% round trip. The old comment here said
# "round-trip", which made every value set from a datasheet too optimistic.
EFFICIENCY = 0.93                      # one-way, fraction (EV charge points)
# The battery gets its own constant so a community BESS can be set from its
# datasheet without also changing how efficiently every EV charges.
BESS_EFFICIENCY = 0.93                 # one-way, fraction (building BESS)
BATTERY_COST_EUR_PER_KWH = 137         # replacement value used by the aging model
BESS_SOC_MIN = 0.0                     # lower bound on battery state of charge

PEAK_MULTIPLIER = 5                    # multiplier on the monthly peak charge
SUBSCRIPTION_FEE_SEK_PER_MONTH = 605   # SEK per 30 days
EFFECT_FEE_SEK_PER_KW_MONTH = 61.55    # SEK/kW per 30 days
TRANSMISSION_FEE = 0.113               # SEK/kWh
TRANSMISSION_HEALTH_INCENTIVE = 0.04   # SEK/kWh, paid on export
ENERGY_TAX = 0.439                     # SEK/kWh
ENERGY_CERTIFICATE = 0.005             # SEK/kWh
COMPENSATION_FEE = 0.02                # SEK/kWh
VAT_RATE = 0.25                        # on supplier cost, DSO cost and energy tax

# Each solver spells its wall-clock limit differently.
_TIME_LIMIT_OPTION = {
    'gurobi': 'TimeLimit',
    'cbc': 'seconds',
    'glpk': 'tmlim',
    'cplex': 'timelimit',
}


def _apply_time_limit(solver, name, seconds):
    """Set the solve time limit whatever the solver calls it."""
    if not seconds:
        return
    if name.startswith('appsi'):
        # appsi solvers expose a typed config rather than an options dict.
        try:
            solver.config.time_limit = seconds
            return
        except Exception:
            pass
    key = _TIME_LIMIT_OPTION.get(name)
    if key:
        try:
            solver.options[key] = seconds
        except Exception:
            pass


def _termination_condition(results):
    """Termination condition from either results object shape.

    The classic Pyomo interface nests it under `.solver`; appsi solvers put it
    at the top level. functions1 previously assumed the classic shape only.
    """
    solver_block = getattr(results, 'solver', None)
    if solver_block is not None and hasattr(solver_block, 'termination_condition'):
        return solver_block.termination_condition
    return getattr(results, 'termination_condition', None)


def _hit_time_limit(results):
    condition = _termination_condition(results)
    return str(condition).lower().replace('_', '') in ('maxtimelimit', 'timelimit')
class charging_point():
    def __init__(self, name, ev_id, session_id, ev_capacity, ev_max_power, ev_arrival_soc, ev_arrival, ev_departure, ev_desired_soc):
        self.efficiency = EFFICIENCY
        # Input validation using assertions
        assert isinstance(ev_capacity, list), "ev_capacity must be a list"
        assert isinstance(ev_max_power, list), "ev_max_power must be a list"
        assert isinstance(ev_arrival_soc, list), "ev_arrival_soc must be a list"
        assert isinstance(ev_arrival, list), "ev_arrival must be a list"
        assert isinstance(ev_departure, list), "ev_departure must be a list"
        assert isinstance(ev_desired_soc, list), "ev_desired_soc must be a list"

        assert len(ev_arrival) == len(ev_departure), "ev_arrival and ev_departure must have the same length"
        assert len(ev_arrival) == len(ev_desired_soc), "ev_arrival and ev_desired_soc must have the same length"
        assert len(ev_arrival_soc) == len(ev_desired_soc), "ev_arrival_soc and ev_desired_soc must have the same length"
        assert len(ev_capacity) == len(ev_desired_soc), "ev_capacity and ev_desired_soc must have the same length"
        assert len(ev_max_power) == len(ev_desired_soc), "ev_max_power and ev_desired_soc must have the same length"

        for i in range(len(ev_arrival)):
            assert ev_arrival[i] < ev_departure[i], f"ev_arrival[{i}] must be less than ev_departure[{i}]"
            assert 0.2 <= ev_arrival_soc[i] <= 1, f"ev_arrival_soc[{i}] must be between 0.2 and 1"
            assert 0 <= ev_desired_soc[i] <= 1, f"ev_desired_soc[{i}] must be between 0 and 1"
            min_time_to_charge = ev_departure[i] - ev_arrival[i]
            min_req_charge = (ev_desired_soc[i] - ev_arrival_soc[i]) * ev_capacity[i] / self.efficiency
            min_req_charge_per_time = min_req_charge / min_time_to_charge
            assert min_req_charge_per_time <= ev_max_power[i], f"min_req_charge_per_time ({min_req_charge_per_time:.2f}) must be less than or equal to ev_max_power[{i}] ({ev_max_power[i]}) for {name}"
            if min_req_charge_per_time * 4 >= ev_max_power[i]:
                warnings.warn(f"Charging would not work for 15-min resolution for {name}")


        self.name = name
        self.ev_capacity = ev_capacity
        self.ev_max_power = ev_max_power
        self.ev_arrival_soc = ev_arrival_soc
        self.ev_desired_soc = ev_desired_soc
        self.ev_arrival = ev_arrival
        self.ev_departure = ev_departure
        self.num_evs = len(ev_capacity) # Store the number of EVs
        self.ev_id = ev_id
        self.session_id = session_id

        #EV aging parameters:
        self.BatVol = 400 #Battery voltage in V
        self.eoi = 0.2 # End-of-life of battery in percentage (20%)
        self.SalRep = 0.5 # Salvation value over replacement value
        self.Rep = [11.1*BATTERY_COST_EUR_PER_KWH*i for i in self.ev_capacity] # replacement value of battery (SEK/kWh)
        self.discount = 0.05 # discount rate (5%)
        self.life = 10 # lifetime of battery (10 years)
        self.OM = [0.02 * i for i in self.Rep] # operation and maintenance cost of battery (2% of replacement cost)

class building():
    def __init__(self, name, load, pv_production, bess_capacity, bess_max_power, bess_initial_soc):
        self.efficiency = BESS_EFFICIENCY
        self.name = name
        self.load = load
        self.pv_production = pv_production
        self.bess_capacity = bess_capacity
        self.bess_max_power = bess_max_power
        self.bess_initial_soc = bess_initial_soc
        
        #BESS aging parameters:
        self.bess_BatVol = 400 #Battery voltage in V
        self.bess_eoi = 0.2 # End-of-life of battery in percentage (20%)
        self.bess_SalRep = 0.5 # Salvation value over replacement value
        self.bess_Rep = 11.1*BATTERY_COST_EUR_PER_KWH*self.bess_capacity # replacement value of battery (SEK/kWh)
        self.bess_discount = 0.05 # discount rate (5%)
        self.bess_life = 10 # lifetime of battery (10 years)
        self.bess_OM = 0.02 *self.bess_Rep # operation and maintenance cost of battery (2% of replacement cost)

class LEC_Opt_spot_fcrn_fcrd():
    def __init__(self, charging_points, buildings, spot_prices, temperature, fcrn_prices, reg_up, reg_down, fcrdu_prices, fcrdd_prices, act_fcrn_up, act_fcrn_down, 
                 act_fcrd_up, act_fcrd_down, previous_monthly_peak=0, v2g_on=1, fcrn_on = 1, fcrdu_on = 1, fcrdd_on = 1, aging = 1, resolution = 1, incentive_per_kwh=0.1, dc = False):
        self.M = 10000
        self.charging_points = charging_points
        self.buildings = buildings
        self.spot_prices = spot_prices
        self.temperature = temperature
        self.incentive_per_kwh = incentive_per_kwh
        self.v2g_on = v2g_on
        self.fcrn_on = fcrn_on
        self.fcrdu_on = fcrdu_on
        self.fcrdd_on = fcrdd_on
        self.previous_monthly_peak = previous_monthly_peak
        self.reg_up = reg_up
        self.reg_down = reg_down
        self.act_fcrn_up = act_fcrn_up
        self.act_fcrn_down = act_fcrn_down
        self.act_fcrd_up = act_fcrd_up
        self.act_fcrd_down = act_fcrd_down
        self.fcrn_prices = fcrn_prices
        self.fcrdu_prices = fcrdu_prices
        self.fcrdd_prices = fcrdd_prices
        self.resolution = resolution #quaterly = 4 #TRY TO AUTOMATICALLY GET THIS FROM INPUT SPOT PRICES
        self.aging = aging
        self.dc = dc
        self.model = pyo.ConcreteModel()
        self.build_model()

    def build_model(self):
        self.model.T = pyo.Set(initialize=range(len(self.spot_prices)))
        self.model.spot_prices = self.spot_prices
        self.model.temperature = self.temperature
        self.model.previous_monthly_peak = self.previous_monthly_peak
        self.model.fcrn_prices = self.fcrn_prices
        self.model.fcrdu_prices = self.fcrdu_prices
        self.model.fcrdd_prices = self.fcrdd_prices
        self.model.reg_up = self.reg_up
        self.model.reg_down = self.reg_down
        self.model.act_fcrn_up = self.act_fcrn_up
        self.model.act_fcrn_down = self.act_fcrn_down
        self.model.act_fcrd_up = self.act_fcrd_up
        self.model.act_fcrd_down = self.act_fcrd_down
        self.model.aging = self.aging
        self.model.monthly_peak = pyo.Var(initialize = 0)
        self.model.P_im_grid = pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 100000))
        self.model.P_ex_grid = pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 100000))
        self.model.P_im_total = pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 100000))
        self.model.P_ex_total = pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 100000))
        self.model.B_im_grid = pyo.Var(self.model.T, within=pyo.Binary)
        self.model.Peakload = pyo.Var(within=pyo.NonNegativeReals)
        self.model.transmission_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.supplier_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.overall_dso_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.tax_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.peak_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.Pbid_fcrn = pyo.Var(self.model.T, within=pyo.NonNegativeReals)
        self.model.fcrn_returns = pyo.Var(self.model.T, within=pyo.NonNegativeReals)
        self.model.Pbid_fcrd = pyo.Var(self.model.T, within=pyo.NonNegativeReals)
        self.model.fcrd_returns = pyo.Var(self.model.T, within=pyo.NonNegativeReals)
        self.model.Subscription_fee = SUBSCRIPTION_FEE_SEK_PER_MONTH/30  # SEK/30 days
        self.model.Transmission_fee = TRANSMISSION_FEE   # Electricity transmission fee SEK/kWh
        self.model.Transmission_health_incentive = TRANSMISSION_HEALTH_INCENTIVE #SEK/kWh
        self.model.Effect_fee = EFFECT_FEE_SEK_PER_KW_MONTH/30       # Effect fee SEK/kW/30 days
        self.model.Energy_tax = ENERGY_TAX           # Tax fee SEK/kWh
        self.model.Energy_certificate = ENERGY_CERTIFICATE   #Energy certificate SEK/kWh
        self.model.compensation_fee = COMPENSATION_FEE    # Transfer compensation fee SEK/kWh
        self.model.resolution = self.resolution

        for charge_point in self.charging_points:
            setattr(self.model, f'{charge_point.name}_P', pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000), initialize = 0))
            setattr(self.model, f'{charge_point.name}_Cyclic_cost', pyo.Var(self.model.T, within = pyo.Reals, bounds=(-1000000, 1000000), initialize = 0))
            setattr(self.model, f'{charge_point.name}_Calendar_cost', pyo.Var(self.model.T, within = pyo.Reals, bounds=(-1000000, 1000000), initialize = 0))
            setattr(self.model, f'{charge_point.name}_Pbid_fcrn', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrn_on * self.v2g_on)))
            setattr(self.model, f'{charge_point.name}_Pch_fcrn', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrn_on)))
            setattr(self.model, f'{charge_point.name}_Pds_fcrn', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrn_on)))
            setattr(self.model, f'{charge_point.name}_Pbid_fcrdu', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrdu_on * self.v2g_on)))
            setattr(self.model, f'{charge_point.name}_Pbid_fcrdd', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrdd_on)))
            setattr(self.model, f'{charge_point.name}_Pch_fcrd', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrdd_on)))
            setattr(self.model, f'{charge_point.name}_Pds_fcrd', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrdu_on * self.v2g_on)))

            # Iterate through each EV charging session at the charging point
            for ev_index in range(len(charge_point.session_id)):
                ev_name = f'{charge_point.name}_S{charge_point.session_id[ev_index]}'  # Unique name for each EV
                setattr(self.model, f'{ev_name}_ch', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, charge_point.ev_max_power[ev_index])))
                setattr(self.model, f'{ev_name}_ds', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, self.v2g_on * charge_point.ev_max_power[ev_index])))
                setattr(self.model, f'{ev_name}_soc', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1)))
                setattr(self.model, f'{ev_name}_Bch', pyo.Var(self.model.T, within=pyo.Binary))
                #setattr(self.model, f'{ev_name}_soc', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1)))

                #Aging decision variables:
                setattr(self.model, f'{ev_name}_Ba', pyo.Var(self.model.T, within=pyo.Binary))
                setattr(self.model, f'{ev_name}_Bb', pyo.Var(self.model.T, within=pyo.Binary))
                setattr(self.model, f'{ev_name}_Bc', pyo.Var(self.model.T, within=pyo.Binary))
                setattr(self.model, f'{ev_name}_Ka', pyo.Var(self.model.T, within=pyo.NonNegativeReals))
                setattr(self.model, f'{ev_name}_Kb', pyo.Var(self.model.T, within=pyo.NonNegativeReals))
                setattr(self.model, f'{ev_name}_Kc', pyo.Var(self.model.T, within=pyo.NonNegativeReals))
                setattr(self.model, f'{ev_name}_CalAg', pyo.Var(self.model.T, within=pyo.NonNegativeReals, initialize = 0))
                setattr(self.model, f'{ev_name}_CycAg', pyo.Var(self.model.T, within=pyo.NonNegativeReals, initialize = 0))
                setattr(self.model, f'{ev_name}_CalCost', pyo.Var(self.model.T, within=pyo.NonNegativeReals, initialize = 0))
                setattr(self.model, f'{ev_name}_CycCost', pyo.Var(self.model.T, within=pyo.NonNegativeReals, initialize = 0))

                #FCR-N variables:
                setattr(self.model, f'{ev_name}_Pch_fcrn', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, charge_point.ev_max_power[ev_index])))
                setattr(self.model, f'{ev_name}_Pds_fcrn', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, charge_point.ev_max_power[ev_index])))
                setattr(self.model, f'{ev_name}_Pbid_fcrn', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrn_on)))
                setattr(self.model, f'{ev_name}_Pch_fcrd', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, charge_point.ev_max_power[ev_index])))
                setattr(self.model, f'{ev_name}_Pds_fcrd', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, charge_point.ev_max_power[ev_index])))
                setattr(self.model, f'{ev_name}_Pbid_fcrdu', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrdu_on)))
                setattr(self.model, f'{ev_name}_Pbid_fcrdd', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1000000*self.fcrdd_on)))

                ev_capacity = charge_point.ev_capacity[ev_index]
                ev_arrival_soc = charge_point.ev_arrival_soc[ev_index]
                ev_arrival = charge_point.ev_arrival[ev_index]
                ev_departure = charge_point.ev_departure[ev_index]
                ev_desired_soc = charge_point.ev_desired_soc[ev_index]
                ev_voltage = charge_point.BatVol
                ev_SalRep = charge_point.SalRep
                ev_Rep = charge_point.Rep[ev_index]
                ev_discount = charge_point.discount
                ev_life = charge_point.life
                ev_OM = charge_point.OM[ev_index]
                ev_eoi = charge_point.eoi

                def ev_soc_rule(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ch = (getattr(model, f'{ev_name}_ch')[t] + getattr(model, f'{ev_name}_Pch_fcrn')[t] + getattr(model, f'{ev_name}_Pch_fcrd')[t]) / self.resolution #15-min conversion
                    ev_ds = (getattr(model, f'{ev_name}_ds')[t] + getattr(model, f'{ev_name}_Pds_fcrn')[t] + getattr(model, f'{ev_name}_Pds_fcrd')[t]) / self.resolution 
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    if t == ev_arrival:
                        return ev_soc == ev_arrival_soc + (ev_ch * charge_point.efficiency - ev_ds / charge_point.efficiency) / ev_capacity
                    elif ev_arrival < t <= ev_departure:
                        ev_previous_soc = getattr(model, f'{ev_name}_soc')[t - 1]
                        return ev_soc == ev_previous_soc + (ev_ch * charge_point.efficiency - ev_ds / charge_point.efficiency) / ev_capacity
                    else:
                        return pyo.Constraint.Skip
                setattr(self.model, f'{ev_name}_soc_constraint', pyo.Constraint(self.model.T, rule=ev_soc_rule))

                def ev_soc_min_rule(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    ev_arrival = charge_point.ev_arrival[ev_index]
                    ev_departure = charge_point.ev_departure[ev_index]
                    if ev_arrival <= t <= ev_departure:
                        return ev_soc >= 0.2
                    return ev_soc == 0
                setattr(self.model, f'{ev_name}_soc_min_constraint', pyo.Constraint(self.model.T, rule=ev_soc_min_rule))

                def ev_max_ch(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_Bch = getattr(model, f'{ev_name}_Bch')[t]
                    ev_ch = getattr(model, f'{ev_name}_ch')[t]
                    return ev_ch <= ev_Bch * charge_point.ev_max_power[ev_index]
                setattr(self.model, f'{ev_name}_max_ch_constraint', pyo.Constraint(self.model.T, rule=ev_max_ch))

                def ev_max_ds(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_Bch = getattr(model, f'{ev_name}_Bch')[t]
                    ev_ds = getattr(model, f'{ev_name}_ds')[t]
                    return ev_ds <= (1 - ev_Bch) * charge_point.ev_max_power[ev_index]
                setattr(self.model, f'{ev_name}_max_ds_constraint', pyo.Constraint(self.model.T, rule=ev_max_ds))

                def ev_avail_ch(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ch = getattr(model, f'{ev_name}_ch')[t] + getattr(model, f'{ev_name}_Pch_fcrn')[t] + getattr(model, f'{ev_name}_Pch_fcrd')[t]
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return ev_ch >= 0
                    return ev_ch == 0
                setattr(self.model, f'{ev_name}_avail_ch_constraint', pyo.Constraint(self.model.T, rule=ev_avail_ch))

                def ev_avail_ds(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ds = getattr(model, f'{ev_name}_ds')[t] + getattr(model, f'{ev_name}_Pds_fcrn')[t] + getattr(model, f'{ev_name}_Pds_fcrd')[t]
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return ev_ds >= 0
                    return ev_ds == 0
                setattr(self.model, f'{ev_name}_avail_ds_constraint', pyo.Constraint(self.model.T, rule=ev_avail_ds))

                def ev_desired_soc_function(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    if t == charge_point.ev_departure[ev_index]:
                        return ev_soc == charge_point.ev_desired_soc[ev_index]
                    return pyo.Constraint.Skip
                setattr(self.model, f'{ev_name}_desired_soc_constraint', pyo.Constraint(self.model.T, rule=ev_desired_soc_function))

                def ev_max_ch_fcr(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ch = getattr(model, f'{ev_name}_ch')[t] + 1.34 * getattr(model, f'{ev_name}_Pbid_fcrn')[t] + 0.2 * getattr(model, f'{ev_name}_Pbid_fcrdu')[t] + getattr(model, f'{ev_name}_Pbid_fcrdd')[t]
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return ev_ch <= charge_point.ev_max_power[ev_index]
                    else:
                        return ev_ch == 0
                setattr(self.model, f'{ev_name}_max_ch_fcr_constraint', pyo.Constraint(self.model.T, rule=ev_max_ch_fcr))

                def ev_max_ds_fcr(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ds = getattr(model, f'{ev_name}_ds')[t] + 1.34 * getattr(model, f'{ev_name}_Pbid_fcrn')[t] + 0.2 * getattr(model, f'{ev_name}_Pbid_fcrdd')[t] + getattr(model, f'{ev_name}_Pbid_fcrdu')[t]
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return ev_ds <= charge_point.ev_max_power[ev_index]
                    else:
                        return ev_ds == 0
                setattr(self.model, f'{ev_name}_max_ds_fcr_constraint', pyo.Constraint(self.model.T, rule=ev_max_ds_fcr))

                def ev_fcrn_ch_act(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ch_fcrn = getattr(model, f'{ev_name}_Pch_fcrn')[t]
                    ev_fcrn_bid = getattr(model, f'{ev_name}_Pbid_fcrn')[t]
                    down_act_fcrn = self.act_fcrn_down[t]
                    return ev_ch_fcrn == ev_fcrn_bid * down_act_fcrn
                setattr(self.model, f'{ev_name}_ev_fcrn_ch_act_constraint', pyo.Constraint(self.model.T, rule = ev_fcrn_ch_act))

                def ev_fcrn_ds_act(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ds_fcrn = getattr(model, f'{ev_name}_Pds_fcrn')[t]
                    ev_fcrn_bid = getattr(model, f'{ev_name}_Pbid_fcrn')[t]
                    up_act_fcrn = self.act_fcrn_up[t]
                    return ev_ds_fcrn == ev_fcrn_bid * up_act_fcrn
                setattr(self.model, f'{ev_name}_ev_fcrn_ds_act_constraint', pyo.Constraint(self.model.T, rule = ev_fcrn_ds_act))

                def ev_fcrd_ch_act(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ch_fcrd = getattr(model, f'{ev_name}_Pch_fcrd')[t]
                    ev_fcrdd_bid = getattr(model, f'{ev_name}_Pbid_fcrdd')[t]
                    down_act_fcrd = self.act_fcrd_down[t]
                    return ev_ch_fcrd == ev_fcrdd_bid * down_act_fcrd
                setattr(self.model, f'{ev_name}_ev_fcrd_ch_act_constraint', pyo.Constraint(self.model.T, rule = ev_fcrd_ch_act))

                def ev_fcrd_ds_act(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ds_fcrd = getattr(model, f'{ev_name}_Pds_fcrd')[t]
                    ev_fcrdu_bid = getattr(model, f'{ev_name}_Pbid_fcrdu')[t]
                    up_act_fcrd = self.act_fcrd_up[t]
                    return ev_ds_fcrd == ev_fcrdu_bid * up_act_fcrd
                setattr(self.model, f'{ev_name}_ev_fcrd_ds_act_constraint', pyo.Constraint(self.model.T, rule = ev_fcrd_ds_act))

                def ev_fcr_tech_req_up(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_fcrn_bid = getattr(model, f'{ev_name}_Pbid_fcrn')[t]
                    ev_fcrdu_bid = getattr(model, f'{ev_name}_Pbid_fcrdu')[t]
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    if ev_arrival <= t <= ev_departure:
                        return ev_soc >= 0.2 + ((1.34 * ev_fcrn_bid + ev_fcrdu_bid)* charge_point.efficiency) / ev_capacity / self.resolution
                    else:
                        return pyo.Constraint.Skip
                setattr(self.model, f'{ev_name}_ev_fcrn_tech_req_up_constraint', pyo.Constraint(self.model.T, rule = ev_fcr_tech_req_up))

                def ev_fcr_tech_req_down(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_fcrn_bid = getattr(model, f'{ev_name}_Pbid_fcrn')[t]
                    ev_fcrdd_bid = getattr(model, f'{ev_name}_Pbid_fcrdd')[t]
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    if ev_arrival <= t <= ev_departure:
                        return ev_soc <= 1 - ((1.34 * ev_fcrn_bid + ev_fcrdd_bid) / charge_point.efficiency) / ev_capacity / self.resolution
                    else:
                        return pyo.Constraint.Skip
                setattr(self.model, f'{ev_name}_ev_fcrn_tech_req_down_constraint', pyo.Constraint(self.model.T, rule = ev_fcr_tech_req_down))

                def ev_fcrd_market_manipulation_check1(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_fcrdu_bid = getattr(model, f'{ev_name}_Pbid_fcrdu')[t]
                    ev_Bch = getattr(model, f'{ev_name}_Bch')[t]
                    return ev_fcrdu_bid <= (1 - ev_Bch) * self.M
                setattr(self.model, f'{ev_name}_ev_fcrd_market_manipulation_check1_constraint', pyo.Constraint(self.model.T, rule = ev_fcrd_market_manipulation_check1))

                def ev_fcrd_market_manipulation_check2(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_fcrdd_bid = getattr(model, f'{ev_name}_Pbid_fcrdd')[t]
                    ev_Bch = getattr(model, f'{ev_name}_Bch')[t]
                    return ev_fcrdd_bid <= (ev_Bch) * self.M
                setattr(self.model, f'{ev_name}_ev_fcrd_market_manipulation_check2_constraint', pyo.Constraint(self.model.T, rule = ev_fcrd_market_manipulation_check2))

                #Aging constraints:
                def ev_calendar_aging(model, t, charging_point=charge_point, ev_index=ev_index):
                    calendar_aging = getattr(model, f'{ev_name}_CalAg')[t]
                    Ka = getattr(model, f'{ev_name}_Ka')[t]
                    Ba = getattr(model, f'{ev_name}_Ba')[t]
                    Kb = getattr(model, f'{ev_name}_Kb')[t]
                    Bb = getattr(model, f'{ev_name}_Bb')[t]
                    Kc = getattr(model, f'{ev_name}_Kc')[t]
                    Bc = getattr(model, f'{ev_name}_Bc')[t]
                    day = 1 #dummy day
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return calendar_aging == 0*0.01*((36.7*Ka + 1224.6*Ba) + (168.7*Kb + 3103.7*Bb) + (41.9*Kc + 6265.2*Bc))*(math.exp(-24500/(model.temperature[t]*8.314))*0.5*0.042)/((day+90)**0.5)
                    else:
                        return calendar_aging == 0
                setattr(self.model, f'{ev_name}_calendar_aging_constraint', pyo.Constraint(self.model.T, rule=ev_calendar_aging))

                def cal_aging_2(model, t, charging_point=charge_point, ev_index=ev_index):
                    Ba = getattr(model, f'{ev_name}_Ba')[t]
                    Bb = getattr(model, f'{ev_name}_Bb')[t]
                    Bc = getattr(model, f'{ev_name}_Bc')[t]
                    return Ba + Bb + Bc == 1
                setattr(self.model, f'{ev_name}_cal_aging_2_contraint', pyo.Constraint(self.model.T, rule=cal_aging_2))

                def cal_aging_3(model, t, charging_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    Ba = getattr(model, f'{ev_name}_Ba')[t]
                    Bb = getattr(model, f'{ev_name}_Bb')[t]
                    Bc = getattr(model, f'{ev_name}_Bc')[t]
                    return ev_soc >= ((0.5*Bb) - (self.M*Ba) + (0.7*Bc))
                setattr(self.model, f'{ev_name}_cal_aging_3_constraint', pyo.Constraint(self.model.T, rule=cal_aging_3))

                def cal_aging_4(model, t, charging_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    Ba = getattr(model, f'{ev_name}_Ba')[t]
                    Bb = getattr(model, f'{ev_name}_Bb')[t]
                    Bc = getattr(model, f'{ev_name}_Bc')[t]
                    return ev_soc <= ((0.5*Ba) + (self.M*Bc) + (0.7*Bb))
                setattr(self.model, f'{ev_name}_cal_aging_4_constraint', pyo.Constraint(self.model.T, rule=cal_aging_4))

                def cal_aging_5(model, t, charging_point=charge_point, ev_index=ev_index):
                    Ba = getattr(model, f'{ev_name}_Ba')[t]
                    Ka = getattr(model, f'{ev_name}_Ka')[t]
                    return Ka <= self.M*Ba
                setattr(self.model, f'{ev_name}_cal_aging_5_constraint', pyo.Constraint(self.model.T, rule=cal_aging_5))

                def cal_aging_6(model, t, charging_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    Ka = getattr(model, f'{ev_name}_Ka')[t]
                    return Ka <= ev_soc
                setattr(self.model, f'{ev_name}_cal_aging_6_constraint', pyo.Constraint(self.model.T, rule=cal_aging_6))

                def cal_aging_7(model, t, charging_point=charge_point, ev_index=ev_index):
                    Ba = getattr(model, f'{ev_name}_Ba')[t]
                    Ka = getattr(model, f'{ev_name}_Ka')[t]
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    return (ev_soc - (1-Ba) * self.M) <= Ka
                setattr(self.model, f'{ev_name}_cal_aging_7_constraint', pyo.Constraint(self.model.T, rule=cal_aging_7))

                def cal_aging_8(model, t, charging_point=charge_point, ev_index=ev_index):
                    Bb = getattr(model, f'{ev_name}_Bb')[t]
                    Kb = getattr(model, f'{ev_name}_Kb')[t]
                    return Kb <= self.M*Bb
                setattr(self.model, f'{ev_name}_cal_aging_8_constraint', pyo.Constraint(self.model.T, rule=cal_aging_8))

                def cal_aging_9(model, t, charging_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    Kb = getattr(model, f'{ev_name}_Kb')[t]
                    return Kb <= ev_soc
                setattr(self.model, f'{ev_name}_cal_aging_9_constraint', pyo.Constraint(self.model.T, rule=cal_aging_9))

                def cal_aging_10(model, t, charging_point=charge_point, ev_index=ev_index):
                    Bb = getattr(model, f'{ev_name}_Bb')[t]
                    Kb = getattr(model, f'{ev_name}_Kb')[t]
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    return (ev_soc - (1-Bb) * self.M) <= Kb
                setattr(self.model, f'{ev_name}_cal_aging_10_constraint', pyo.Constraint(self.model.T, rule=cal_aging_10))

                def cal_aging_11(model, t, charging_point=charge_point, ev_index=ev_index):
                    Bc = getattr(model, f'{ev_name}_Bc')[t]
                    Kc = getattr(model, f'{ev_name}_Kc')[t]
                    return Kc <= self.M*Bc
                setattr(self.model, f'{ev_name}_cal_aging_11_constraint', pyo.Constraint(self.model.T, rule=cal_aging_11))

                def cal_aging_12(model, t, charging_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    Kc = getattr(model, f'{ev_name}_Kc')[t]
                    return Kc <= ev_soc
                setattr(self.model, f'{ev_name}_cal_aging_12_constraint', pyo.Constraint(self.model.T, rule=cal_aging_12))

                def cal_aging_13(model, t, charging_point=charge_point, ev_index=ev_index):
                    Bc = getattr(model, f'{ev_name}_Bc')[t]
                    Kc = getattr(model, f'{ev_name}_Kc')[t]
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    return (ev_soc - (1-Bc) * self.M) <= Kc
                setattr(self.model, f'{ev_name}_cal_aging_13_constraint', pyo.Constraint(self.model.T, rule=cal_aging_13))

                def ev_calendar_aging_cost(model, t, charging_point=charge_point, ev_index=ev_index):
                    calendar_aging = getattr(model, f'{ev_name}_CalAg')[t]
                    calendar_aging_cost = getattr(model, f'{ev_name}_CalCost')[t]
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return calendar_aging_cost == (((1-ev_SalRep)*ev_Rep/((1+ev_discount)**ev_life)+ev_OM\
                                                        *(((1+ev_discount)**ev_life)-1)/(ev_discount*(1+ev_discount)**ev_life))\
                                                        /(ev_eoi))*(calendar_aging) 
                    else:
                        return calendar_aging_cost == 0
                setattr(self.model, f'{ev_name}_calendar_aging_cost_constraint', pyo.Constraint(self.model.T, rule=ev_calendar_aging_cost))

                def ev_cyclic_aging(model, t, charging_point=charge_point, ev_index=ev_index):
                    cyclic_aging = getattr(model, f'{ev_name}_CycAg')[t]
                    ev_ch = (getattr(model, f'{ev_name}_ch')[t] + getattr(model, f'{ev_name}_Pch_fcrn')[t] + getattr(model, f'{ev_name}_Pch_fcrd')[t]) / self.resolution
                    ev_ds = (getattr(model, f'{ev_name}_ds')[t] + getattr(model, f'{ev_name}_Pds_fcrn')[t] + getattr(model, f'{ev_name}_Pds_fcrd')[t]) / self.resolution
                    return cyclic_aging >= (0.01*(((0.0000086*(self.temperature[t]**2)-0.0051*self.temperature[t]+0.763)*\
                                                      (67.15*ev_ch+67.15*ev_ds-2.94))/(ev_voltage*ev_capacity)))
                setattr(self.model, f'{ev_name}_cyclic_aging_constraint', pyo.Constraint(self.model.T, rule=ev_cyclic_aging))

                def ev_cyclic_aging_cost(model, t, charging_point=charge_point, ev_index=ev_index):
                    cyclic_aging_cost = getattr(model, f'{ev_name}_CycCost')[t]
                    cyclic_aging = getattr(model, f'{ev_name}_CycAg')[t]
                    return cyclic_aging_cost == (((1-ev_SalRep)*ev_Rep/((1+ev_discount)**ev_life)+ev_OM\
                                                *(((1+ev_discount)**ev_life)-1)/(ev_discount*(1+ev_discount)**ev_life))\
                                                /(ev_eoi))*(cyclic_aging)
                setattr(self.model, f'{ev_name}_cyclic_aging_cost_constraint', pyo.Constraint(self.model.T, rule=ev_cyclic_aging_cost))

            def consumption(model, t, charge_point=charge_point): #Power from spot or LEC and not FCR
                P = getattr(model, f'{charge_point.name}_P')[t]
                ev_power = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_ch')[t] - getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_ds')[t] for ev_index in range(charge_point.num_evs))
                return  ev_power == P
            setattr(self.model, f'{charge_point.name}_consumption_constraint', pyo.Constraint(self.model.T, rule=consumption))

            def fcrn_bids_chargers(model, t, charge_point=charge_point):
                ev_fcrn_bids = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_Pbid_fcrn')[t] for ev_index in range(charge_point.num_evs))
                P_bid_fcrn = getattr(model, f'{charge_point.name}_Pbid_fcrn')[t]
                return ev_fcrn_bids == P_bid_fcrn
            setattr(self.model, f'{charge_point.name}_fcrn_bids_chargers_constraint', pyo.Constraint(self.model.T, rule=fcrn_bids_chargers))

            def fcrn_act_up_chargers(model, t, charge_point=charge_point):
                ev_fcrn_ds = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_Pds_fcrn')[t] for ev_index in range(charge_point.num_evs))
                P_ds_fcrn = getattr(model, f'{charge_point.name}_Pds_fcrn')[t]
                return ev_fcrn_ds == P_ds_fcrn
            setattr(self.model, f'{charge_point.name}_fcrn_act_up_chargers_constraint', pyo.Constraint(self.model.T, rule=fcrn_act_up_chargers))

            def fcrn_act_down_chargers(model, t, charge_point=charge_point):
                ev_fcrn_ch = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_Pch_fcrn')[t] for ev_index in range(charge_point.num_evs))
                P_ch_fcrn = getattr(model, f'{charge_point.name}_Pch_fcrn')[t]
                return ev_fcrn_ch == P_ch_fcrn
            setattr(self.model, f'{charge_point.name}_fcrn_act_down_chargers_constraint', pyo.Constraint(self.model.T, rule=fcrn_act_down_chargers))

            def fcrdu_bids_chargers(model, t, charge_point=charge_point):
                ev_fcrdu_bids = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_Pbid_fcrdu')[t] for ev_index in range(charge_point.num_evs))
                P_bid_fcrdu = getattr(model, f'{charge_point.name}_Pbid_fcrdu')[t]
                return ev_fcrdu_bids == P_bid_fcrdu
            setattr(self.model, f'{charge_point.name}_fcrdu_bids_chargers_constraint', pyo.Constraint(self.model.T, rule=fcrdu_bids_chargers))

            def fcrdd_bids_chargers(model, t, charge_point=charge_point):
                ev_fcrdd_bids = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_Pbid_fcrdd')[t] for ev_index in range(charge_point.num_evs))
                P_bid_fcrdd = getattr(model, f'{charge_point.name}_Pbid_fcrdd')[t]
                return ev_fcrdd_bids == P_bid_fcrdd
            setattr(self.model, f'{charge_point.name}_fcrdd_bids_chargers_constraint', pyo.Constraint(self.model.T, rule=fcrdd_bids_chargers))

            def fcrd_act_up_chargers(model, t, charge_point=charge_point):
                ev_fcrd_ds = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_Pds_fcrd')[t] for ev_index in range(charge_point.num_evs))
                P_ds_fcrd = getattr(model, f'{charge_point.name}_Pds_fcrd')[t]
                return ev_fcrd_ds == P_ds_fcrd
            setattr(self.model, f'{charge_point.name}_fcrd_act_up_chargers_constraint', pyo.Constraint(self.model.T, rule=fcrd_act_up_chargers))

            def fcrd_act_down_chargers(model, t, charge_point=charge_point):
                ev_fcrd_ch = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_Pch_fcrd')[t] for ev_index in range(charge_point.num_evs))
                P_ch_fcrd = getattr(model, f'{charge_point.name}_Pch_fcrd')[t]
                return ev_fcrd_ch == P_ch_fcrd
            setattr(self.model, f'{charge_point.name}_fcrd_act_down_chargers_constraint', pyo.Constraint(self.model.T, rule=fcrd_act_down_chargers))

            def cyclic_cost(model, t, charge_point = charge_point):
                cyclic_cost = getattr(model, f'{charge_point.name}_Cyclic_cost')[t]
                charge_point_cyclic_cost = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_CycCost')[t] for ev_index in range(charge_point.num_evs))
                return cyclic_cost == charge_point_cyclic_cost
            setattr(self.model, f'{charge_point.name}_cyclic_cost_constraint', pyo.Constraint(self.model.T, rule=cyclic_cost))

            def calendar_cost(model, t, charge_point = charge_point):
                calendar_cost = getattr(model, f'{charge_point.name}_Calendar_cost')[t]
                charge_point_calendar_cost = sum(getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_CalCost')[t] for ev_index in range(charge_point.num_evs))
                return calendar_cost == charge_point_calendar_cost
            setattr(self.model, f'{charge_point.name}_calendar_cost_constraint', pyo.Constraint(self.model.T, rule=calendar_cost))
            
        #Building constraints         
        for building in self.buildings:
            setattr(self.model, f'{building.name}_P', pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000)))
            setattr(self.model, f'{building.name}_bess_Pbid_fcrn', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1000000*self.fcrn_on*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_Pch_fcrn', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1000000*self.fcrn_on*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_Pds_fcrn', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1000000*self.fcrn_on*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_Pbid_fcrdu', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1000000*self.fcrdu_on*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_Pbid_fcrdd', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1000000*self.fcrdd_on*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_Pch_fcrd', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1000000*self.fcrdd_on*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_Pds_fcrd', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1000000*self.fcrdu_on*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_soc', pyo.Var(self.model.T, within=pyo.Reals, bounds=(BESS_SOC_MIN, 1)))
            setattr(self.model, f'{building.name}_bess_ch', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, building.bess_max_power)))
            setattr(self.model, f'{building.name}_bess_ds', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, building.bess_max_power)))
            setattr(self.model, f'{building.name}_bess_Bch', pyo.Var(self.model.T, within=pyo.Binary))
            setattr(self.model, f'{building.name}_bess_CycAg', pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000), initialize = 0))
            setattr(self.model, f'{building.name}_bess_CalAg', pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000), initialize = 0))
            setattr(self.model, f'{building.name}_bess_CycCost', pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000), initialize = 0))
            setattr(self.model, f'{building.name}_bess_CalCost', pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000), initialize = 0))
            setattr(self.model, f'{building.name}_bess_Ba', pyo.Var(self.model.T, within=pyo.Binary, initialize = 0))
            setattr(self.model, f'{building.name}_bess_Ka', pyo.Var(self.model.T, within=pyo.NonNegativeReals, initialize = 0, bounds=(0,1)))
            setattr(self.model, f'{building.name}_bess_Bb', pyo.Var(self.model.T, within=pyo.Binary, initialize = 0))
            setattr(self.model, f'{building.name}_bess_Kb', pyo.Var(self.model.T, within=pyo.NonNegativeReals, initialize = 0, bounds=(0,1)))
            setattr(self.model, f'{building.name}_bess_Bc', pyo.Var(self.model.T, within=pyo.Binary, initialize = 0))
            setattr(self.model, f'{building.name}_bess_Kc', pyo.Var(self.model.T, within=pyo.NonNegativeReals, initialize = 0, bounds=(0,1)))

            def bess_soc_rule(model, t, building = building):
                bess_ch = (getattr(model, f'{building.name}_bess_ch')[t] + getattr(model, f'{building.name}_bess_Pch_fcrn')[t] + getattr(model, f'{building.name}_bess_Pch_fcrd')[t]) / self.resolution
                bess_ds = (getattr(model, f'{building.name}_bess_ds')[t] + getattr(model, f'{building.name}_bess_Pds_fcrn')[t] + getattr(model, f'{building.name}_bess_Pds_fcrd')[t]) / self.resolution
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                if building.bess_capacity == 0:
                    return bess_soc == 0
                elif t == 0:
                    return bess_soc == building.bess_initial_soc + (bess_ch*building.efficiency - bess_ds/building.efficiency)/building.bess_capacity
                else:
                    bess_previous_soc = getattr(model, f'{building.name}_bess_soc')[t-1]
                    return bess_soc == bess_previous_soc + (bess_ch*building.efficiency - bess_ds/building.efficiency)/building.bess_capacity
            setattr(self.model, f'{building.name}_bess_soc_constraint', pyo.Constraint(self.model.T, rule = bess_soc_rule))

            def bess_soc_min_rule(model, t, building = building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                if building.bess_capacity == 0:
                    return bess_soc == 0
                return bess_soc >= 0.2
            setattr(self.model, f'{building.name}_bess_soc_min_constraint', pyo.Constraint(self.model.T, rule = bess_soc_min_rule))  

            def bess_max_ch(model, t, building = building):
                bess_Bch = getattr(model, f'{building.name}_bess_Bch')[t]
                bess_ch = getattr(model, f'{building.name}_bess_ch')[t]
                if building.bess_capacity == 0:
                    return bess_ch == 0
                return bess_ch <= bess_Bch*building.bess_max_power
            setattr(self.model, f'{building.name}_bess_max_ch_constraint', pyo.Constraint(self.model.T, rule = bess_max_ch))

            def bess_max_ds(model, t, building = building):
                bess_Bch = getattr(model, f'{building.name}_bess_Bch')[t]
                bess_ds = getattr(model, f'{building.name}_bess_ds')[t]
                if building.bess_capacity == 0:
                    return bess_ds == 0
                return bess_ds <= (1-bess_Bch)*building.bess_max_power
            setattr(self.model, f'{building.name}_bess_max_ds_constraint', pyo.Constraint(self.model.T, rule = bess_max_ds))

            def bess_max_ch_fcr(model, t, building = building):
                bess_ch = getattr(model, f'{building.name}_bess_ch')[t]
                bess_ch_fcr = 1.34 * getattr(model, f'{building.name}_bess_Pbid_fcrn')[t] + 0.2 * getattr(model, f'{building.name}_bess_Pbid_fcrdu')[t] + getattr(model, f'{building.name}_bess_Pbid_fcrdd')[t]
                if building.bess_capacity == 0:
                    return bess_ch + bess_ch_fcr == 0
                else:
                    return bess_ch + bess_ch_fcr <= building.bess_max_power
            setattr(self.model, f'{building.name}_bess_max_ch_fcr_constraint', pyo.Constraint(self.model.T, rule = bess_max_ch_fcr))

            def bess_max_ds_fcr(model, t, building = building):
                bess_ds = getattr(model, f'{building.name}_bess_ch')[t]
                bess_ds_fcr = 1.34 * getattr(model, f'{building.name}_bess_Pbid_fcrn')[t] + 0.2 * getattr(model, f'{building.name}_bess_Pbid_fcrdd')[t] + getattr(model, f'{building.name}_bess_Pbid_fcrdu')[t]
                if building.bess_capacity == 0:
                    return bess_ds + bess_ds_fcr == 0
                else:
                    return bess_ds + bess_ds_fcr <= building.bess_max_power
            setattr(self.model, f'{building.name}_bess_max_ds_fcr_constraint', pyo.Constraint(self.model.T, rule = bess_max_ds_fcr))

            def bess_ch_fcrn_act(model, t, building = building):
                bess_ch_fcrn = getattr(model, f'{building.name}_bess_Pch_fcrn')[t]
                bess_Pbid_fcrn = getattr(model, f'{building.name}_bess_Pbid_fcrn')[t]
                down_act_fcrn = self.act_fcrn_down[t]
                return bess_ch_fcrn == bess_Pbid_fcrn * down_act_fcrn
            setattr(self.model, f'{building.name}_bess_ch_fcrn_constraint', pyo.Constraint(self.model.T, rule = bess_ch_fcrn_act))

            def bess_ds_fcrn_act(model, t, building = building):
                bess_ds_fcrn = getattr(model, f'{building.name}_bess_Pds_fcrn')[t]
                bess_Pbid_fcrn = getattr(model, f'{building.name}_bess_Pbid_fcrn')[t]
                up_act_fcrn = self.act_fcrn_up[t]
                return bess_ds_fcrn == bess_Pbid_fcrn * up_act_fcrn
            setattr(self.model, f'{building.name}_bess_ds_fcrn_constraint', pyo.Constraint(self.model.T, rule = bess_ds_fcrn_act))

            def bess_ch_fcrd_act(model, t, building = building):
                bess_ch_fcrd = getattr(model, f'{building.name}_bess_Pch_fcrd')[t]
                bess_Pbid_fcrdd = getattr(model, f'{building.name}_bess_Pbid_fcrdd')[t]
                down_act_fcrd = self.act_fcrd_down[t]
                return bess_ch_fcrd == bess_Pbid_fcrdd * down_act_fcrd
            setattr(self.model, f'{building.name}_bess_ch_fcrd_constraint', pyo.Constraint(self.model.T, rule = bess_ch_fcrd_act))

            def bess_ds_fcrd_act(model, t, building = building):
                bess_ds_fcrd = getattr(model, f'{building.name}_bess_Pds_fcrd')[t]
                bess_Pbid_fcrdu = getattr(model, f'{building.name}_bess_Pbid_fcrdu')[t]
                up_act_fcrd = self.act_fcrd_up[t]
                return bess_ds_fcrd == bess_Pbid_fcrdu * up_act_fcrd
            setattr(self.model, f'{building.name}_bess_ds_fcrd_constraint', pyo.Constraint(self.model.T, rule = bess_ds_fcrd_act))

            def building_consumption(model, t, building = building): #from spot/LEC
                P = getattr(model, f'{building.name}_P')[t]
                # .iloc, not [t]: these are Series with a DatetimeIndex, and
                # positional lookup via [int] was removed in pandas 3.0.
                load = building.load.iloc[t]
                pv = building.pv_production.iloc[t]
                bess_ch = getattr(model, f'{building.name}_bess_ch')[t]
                bess_ds = getattr(model, f'{building.name}_bess_ds')[t]
                return load - pv - bess_ds + bess_ch == P
            setattr(self.model, f'{building.name}_consumption_constraint', pyo.Constraint(self.model.T, rule = building_consumption))

            def building_bess_fcr_tech_req_up(model, t , building = building):
                bess_Pbid_fcrn = getattr(model, f'{building.name}_bess_Pbid_fcrn')[t]
                bess_Pbid_fcrdu = getattr(model, f'{building.name}_bess_Pbid_fcrdu')[t]
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                if building.bess_capacity == 0:
                    return pyo.Constraint.Skip
                return bess_soc >= 0.2 + ((1.34 * bess_Pbid_fcrn + bess_Pbid_fcrdu) * building.efficiency) / building.bess_capacity / self.resolution
            setattr(self.model, f'{building.name}_bess_fcrn_tech_req_up_constraint', pyo.Constraint(self.model.T, rule = building_bess_fcr_tech_req_up))

            def building_bess_fcr_tech_req_down(model, t , building = building):
                bess_Pbid_fcrn = getattr(model, f'{building.name}_bess_Pbid_fcrn')[t]
                bess_Pbid_fcrdd = getattr(model, f'{building.name}_bess_Pbid_fcrdd')[t]
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                if building.bess_capacity == 0:
                    return pyo.Constraint.Skip
                return bess_soc <= 1 - ((1.34 * bess_Pbid_fcrn + bess_Pbid_fcrdd) / building.efficiency) / building.bess_capacity / self.resolution
            setattr(self.model, f'{building.name}_bess_fcrn_tech_req_down_constraint', pyo.Constraint(self.model.T, rule = building_bess_fcr_tech_req_down))

            def building_bess_fcrd_market_manipulation_check1(model, t, building = building):
                bess_Pbid_fcrdu = getattr(model, f'{building.name}_bess_Pbid_fcrdu')[t]
                bess_Bch = getattr(model, f'{building.name}_bess_Bch')[t]
                return bess_Pbid_fcrdu <= (1 - bess_Bch) * self.M
            setattr(self.model, f'{building.name}_building_bess_fcrd_market_manipulation_check1_constraint', pyo.Constraint(self.model.T, rule = building_bess_fcrd_market_manipulation_check1))

            def building_bess_fcrd_market_manipulation_check2(model, t, building = building):
                bess_Pbid_fcrdd = getattr(model, f'{building.name}_bess_Pbid_fcrdd')[t]
                bess_Bch = getattr(model, f'{building.name}_bess_Bch')[t]
                return bess_Pbid_fcrdd <= (bess_Bch) * self.M
            setattr(self.model, f'{building.name}_building_bess_fcrd_market_manipulation_check2_constraint', pyo.Constraint(self.model.T, rule = building_bess_fcrd_market_manipulation_check2))

            #Aging Constraints

            def building_bess_cyclic_aging(model, t, building = building):
                cyclic_aging = getattr(model, f'{building.name}_bess_CycAg')[t]
                bess_ch = (getattr(model, f'{building.name}_bess_ch')[t] + getattr(model, f'{building.name}_bess_Pch_fcrn')[t] + getattr(model, f'{building.name}_bess_Pch_fcrd')[t]) / self.resolution
                bess_ds = (getattr(model, f'{building.name}_bess_ds')[t] + getattr(model, f'{building.name}_bess_Pds_fcrn')[t] + getattr(model, f'{building.name}_bess_Pds_fcrd')[t]) / self.resolution
                if building.bess_capacity == 0:
                    return cyclic_aging == 0
                return cyclic_aging == (0.01*(((0.0000086*(self.temperature[t]**2)-0.0051*self.temperature[t]+0.763)*\
                                                      (67.15*bess_ch+67.15*bess_ds-2.94))/(building.bess_BatVol*building.bess_capacity)))
            setattr(self.model, f'{building.name}_bess_cyclic_aging_constraint', pyo.Constraint(self.model.T, rule = building_bess_cyclic_aging))

            def building_bess_cyclic_aging_cost(model, t, building = building):
                cyclic_aging = getattr(model, f'{building.name}_bess_CycAg')[t]
                cyclic_aging_cost = getattr(model, f'{building.name}_bess_CycCost')[t]
                return cyclic_aging_cost == (((1-building.bess_SalRep)*building.bess_Rep/((1+building.bess_discount)**building.bess_life)+building.bess_OM\
                                                *(((1+building.bess_discount)**building.bess_life)-1)/(building.bess_discount*(1+building.bess_discount)**building.bess_life))\
                                                /(building.bess_eoi))*(cyclic_aging)
            setattr(self.model, f'{building.name}_bess_cyclic_aging_cost_constraint', pyo.Constraint(self.model.T, rule=building_bess_cyclic_aging_cost))

            def building_bess_caldendar_aging(model, t, building = building):
                calendar_aging = getattr(model, f'{building.name}_bess_CalAg')[t]
                Ka = getattr(model, f'{building.name}_bess_Ka')[t]
                Ba = getattr(model, f'{building.name}_bess_Ba')[t]
                Kb = getattr(model, f'{building.name}_bess_Kb')[t]
                Bb = getattr(model, f'{building.name}_bess_Bb')[t]
                Kc = getattr(model, f'{building.name}_bess_Kc')[t]
                Bc = getattr(model, f'{building.name}_bess_Bc')[t]
                day = 1 #dummy day
                return calendar_aging == 0.01*((36.7*Ka + 1224.6*Ba) + (168.7*Kb + 3103.7*Bb) + (41.9*Kc + 6265.2*Bc))*(math.exp(-24500/(model.temperature[t]*8.314))*0.5*0.042)/((day+90)**0.5) 
            setattr(self.model, f'{building.name}_building_bess_calendar_againg_constraint', pyo.Constraint(self.model.T, rule = building_bess_caldendar_aging))

            def buidling_bess_calendar_aging_cost(model, t, building = building):
                    calendar_aging = getattr(model, f'{building.name}_bess_CalAg')[t]
                    calendar_aging_cost = getattr(model, f'{building.name}_bess_CalCost')[t]
                    return calendar_aging_cost == (((1-building.bess_SalRep)*building.bess_Rep/((1+building.bess_discount)**building.bess_life)+building.bess_OM\
                                                *(((1+building.bess_discount)**building.bess_life)-1)/(building.bess_discount*(1+building.bess_discount)**building.bess_life))\
                                                /(building.bess_eoi))*(calendar_aging)
            setattr(self.model, f'{building.name}_building_besscalendar_aging_cost_constraint', pyo.Constraint(self.model.T, rule=buidling_bess_calendar_aging_cost))

            def building_bess_cal_aging_2(model, t, building = building):
                Ba = getattr(model, f'{building.name}_bess_Ba')[t]
                Bb = getattr(model, f'{building.name}_bess_Bb')[t]
                Bc = getattr(model, f'{building.name}_bess_Bc')[t]
                return Ba + Bb + Bc == 1
            setattr(self.model, f'{building.name}_bess_cal_aging_2_contraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_2))

            def building_bess_cal_aging_3(model, t, building = building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                Ba = getattr(model, f'{building.name}_bess_Ba')[t]
                Bb = getattr(model, f'{building.name}_bess_Bb')[t]
                Bc = getattr(model, f'{building.name}_bess_Bc')[t]
                return bess_soc >= ((0.5*Bb) - (self.M*Ba) + (0.7*Bc))
            setattr(self.model, f'{building.name}_bess_cal_aging_3_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_3))

            def building_bess_cal_aging_4(model, t, building = building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                Ba = getattr(model, f'{building.name}_bess_Ba')[t]
                Bb = getattr(model, f'{building.name}_bess_Bb')[t]
                Bc = getattr(model, f'{building.name}_bess_Bc')[t]
                return bess_soc <= ((0.5*Ba) + (self.M*Bc) + (0.7*Bb))
            setattr(self.model, f'{building.name}_bess_cal_aging_4_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_4))

            def building_bess_cal_aging_5(model, t, building = building):
                Ba = getattr(model, f'{building.name}_bess_Ba')[t]
                Ka = getattr(model, f'{building.name}_bess_Ka')[t]
                return Ka <= self.M*Ba
            setattr(self.model, f'{building.name}_bess_cal_aging_5_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_5))

            def building_bess_cal_aging_6(model, t, building = building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                Ka = getattr(model, f'{building.name}_bess_Ka')[t]
                return Ka <= bess_soc
            setattr(self.model, f'{building.name}_bess_cal_aging_6_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_6))

            def building_bess_cal_aging_7(model, t, building = building):
                Ba = getattr(model, f'{building.name}_bess_Ba')[t]
                Ka = getattr(model, f'{building.name}_bess_Ka')[t]
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                return (bess_soc - (1-Ba) * self.M) <= Ka
            setattr(self.model, f'{building.name}_bess_cal_aging_7_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_7))

            def building_bess_cal_aging_8(model, t, building = building):
                Bb = getattr(model, f'{building.name}_bess_Bb')[t]
                Kb = getattr(model, f'{building.name}_bess_Kb')[t]
                return Kb <= self.M*Bb
            setattr(self.model, f'{building.name}_bess_cal_aging_8_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_8))

            def building_bess_cal_aging_9(model, t, building = building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                Kb = getattr(model, f'{building.name}_bess_Kb')[t]
                return Kb <= bess_soc
            setattr(self.model, f'{building.name}_bess_cal_aging_9_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_9))

            def building_bess_cal_aging_10(model, t, building = building):
                Bb = getattr(model, f'{building.name}_bess_Bb')[t]
                Kb = getattr(model, f'{building.name}_bess_Kb')[t]
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                return (bess_soc - (1-Bb) * self.M) <= Kb
            setattr(self.model, f'{building.name}_bess_cal_aging_10_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_10))

            def building_bess_cal_aging_11(model, t, building = building):
                Bc = getattr(model, f'{building.name}_bess_Bc')[t]
                Kc = getattr(model, f'{building.name}_bess_Kc')[t]
                return Kc <= self.M*Bc
            setattr(self.model, f'{building.name}_bess_cal_aging_11_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_11))

            def building_bess_cal_aging_12(model, t, building = building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                Kc = getattr(model, f'{building.name}_bess_Kc')[t]
                return Kc <= bess_soc
            setattr(self.model, f'{building.name}_bess_cal_aging_12_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_12))

            def building_bess_cal_aging_13(model, t, building = building):
                Bc = getattr(model, f'{building.name}_bess_Bc')[t]
                Kc = getattr(model, f'{building.name}_bess_Kc')[t]
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                return (bess_soc - (1-Bc) * self.M) <= Kc
            setattr(self.model, f'{building.name}_bess_cal_aging_13_constraint', pyo.Constraint(self.model.T, rule=building_bess_cal_aging_13))

        def power_balance(model, t):
            overall_consumption = sum(getattr(model, f'{charge_point.name}_P')[t] for charge_point in self.charging_points) + \
                                    sum(getattr(model, f'{building.name}_P')[t] for building in self.buildings)
            P_im = self.model.P_im_grid[t]
            P_ex = self.model.P_ex_grid[t]
            return P_im - P_ex == overall_consumption
        self.model.power_balance_constarint = pyo.Constraint(self.model.T, rule=power_balance)

        def power_balance_total(model, t):
            overall_consumption = sum(getattr(model, f'{charge_point.name}_P')[t] 
                                      + getattr(model, f'{charge_point.name}_Pch_fcrn')[t] 
                                      - getattr(model, f'{charge_point.name}_Pds_fcrn')[t]
                                      + getattr(model, f'{charge_point.name}_Pch_fcrd')[t] 
                                      - getattr(model, f'{charge_point.name}_Pds_fcrd')[t] for charge_point in self.charging_points) + \
                                    sum(getattr(model, f'{building.name}_P')[t]
                                      + getattr(model, f'{building.name}_bess_Pch_fcrn')[t]
                                      - getattr(model, f'{building.name}_bess_Pds_fcrn')[t] 
                                      + getattr(model, f'{building.name}_bess_Pch_fcrd')[t]
                                      - getattr(model, f'{building.name}_bess_Pds_fcrd')[t] for building in self.buildings) 
            P_im = self.model.P_im_total[t]
            P_ex = self.model.P_ex_total[t]
            return P_im - P_ex == overall_consumption
        self.model.power_balance_total_constarint = pyo.Constraint(self.model.T, rule=power_balance_total)

        def power_import(model, t):
            P_im = self.model.P_im_grid[t]
            B_im = self.model.B_im_grid[t]
            return P_im <= self.M * B_im
        self.model.power_import_constraint = pyo.Constraint(self.model.T, rule=power_import)

        def power_export(model, t):
            P_ex = self.model.P_ex_grid[t]
            B_im = self.model.B_im_grid[t]
            return P_ex <= self.M * (1 - B_im)
        self.model.power_export_constraint = pyo.Constraint(self.model.T, rule=power_export)

        def peak_load_constraint(model, t): #changed from grid to total since DSO needs to be payed for the transmission of FCR services as well??
            return model.Peakload >= model.P_im_total[t] - model.P_ex_total[t] 
        self.model.peak_load_constraint = pyo.Constraint(self.model.T, rule=peak_load_constraint)

        def previous_peak_check1(model):
            return model.monthly_peak >= model.Peakload
        self.model.previous_peak_check1_constraint = pyo.Constraint(rule=previous_peak_check1)

        def previous_peak_check2(model):
            return model.monthly_peak >= model.previous_monthly_peak
        self.model.previous_peak_check2_constraint = pyo.Constraint(rule=previous_peak_check2)

        def tranmission_cost(model, t):
            return model.transmission_cost[t] == (model.P_im_total[t] / self.resolution) * model.Transmission_fee - (model.P_ex_total[t] / self.resolution) * model.Transmission_health_incentive
        self.model.tranmission_cost_constraint = pyo.Constraint(self.model.T, rule = tranmission_cost)

        def supplier_cost_cal(model, t):
            return model.supplier_cost[t] == (model.P_im_grid[t] / self.resolution) * (model.spot_prices[t] + model.Energy_certificate) \
                                            - (model.P_ex_grid[t] / self.resolution) * (model.spot_prices[t] + model.Energy_certificate + model.compensation_fee) 
        self.model.supplier_cost_constraint = pyo.Constraint(self.model.T, rule = supplier_cost_cal)

        def fcrn_returns_cal(model, t):
            bids = sum(getattr(model, f'{charge_point.name}_Pbid_fcrn')[t] for charge_point in self.charging_points) \
                    + sum(getattr(model, f'{building.name}_bess_Pbid_fcrn')[t] for building in self.buildings)
            up_act = (sum(getattr(model, f'{charge_point.name}_Pds_fcrn')[t] for charge_point in self.charging_points) \
                    + sum(getattr(model, f'{building.name}_bess_Pds_fcrn')[t] for building in self.buildings)) / self.resolution
            down_act = (sum(getattr(model, f'{charge_point.name}_Pch_fcrn')[t] for charge_point in self.charging_points) \
                    + sum(getattr(model, f'{building.name}_bess_Pch_fcrn')[t] for building in self.buildings)) / self.resolution
            bids_returns = bids*self.fcrn_prices[t] / self.resolution #get paid hourly
            act_returns = up_act*self.reg_up[t] + down_act*self.reg_down[t]
            return model.fcrn_returns[t] == bids_returns + act_returns
        self.model.fcrn_returns_cal_constraint = pyo.Constraint(self.model.T, rule = fcrn_returns_cal)

        def fcrd_returns_cal(model, t):
            up_bids = sum(getattr(model, f'{charge_point.name}_Pbid_fcrdu')[t] for charge_point in self.charging_points) \
                        + sum(getattr(model, f'{building.name}_bess_Pbid_fcrdu')[t] for building in self.buildings)
            down_bids = sum(getattr(model, f'{charge_point.name}_Pbid_fcrdd')[t] for charge_point in self.charging_points) \
                        + sum(getattr(model, f'{building.name}_bess_Pbid_fcrdd')[t] for building in self.buildings)
            return model.fcrd_returns[t] == (up_bids * self.fcrdu_prices[t] + down_bids * self.fcrdd_prices[t]) / self.resolution #get paid hourly
        self.model.fcrd_returns_cal_constraint = pyo.Constraint(self.model.T, rule = fcrd_returns_cal)
            

        def objective_rule(model):
            subscription_fee = model.Subscription_fee
            supplier_cost = sum(model.supplier_cost[t] for t in model.T)
            transmission_cost = sum(model.transmission_cost[t] for t in model.T)
            peak_cost = model.Effect_fee * model.monthly_peak * PEAK_MULTIPLIER
            dso_cost = transmission_cost + peak_cost + subscription_fee
            tax_cost = (supplier_cost + dso_cost)*VAT_RATE + ((1 + VAT_RATE) * model.Energy_tax * sum(model.P_im_grid[t] - model.P_ex_grid[t] for t in model.T) / self.resolution)
            ev_aging_cost = sum(sum(getattr(model, f'{charge_point.name}_Cyclic_cost')[t] + getattr(model, f'{charge_point.name}_Calendar_cost')[t] \
                                    for charge_point in self.charging_points) for t in model.T)
            building_bess_aging_cost = sum(sum(getattr(model, f'{building.name}_bess_CycCost')[t] + getattr(model, f'{building.name}_bess_CalCost')[t] \
                                    for building in self.buildings) for t in model.T)
            fcrn_returns = sum(model.fcrn_returns[t] for t in model.T)
            fcrd_returns = sum(model.fcrd_returns[t] for t in model.T)
            overall_cost = dso_cost + tax_cost + supplier_cost + ev_aging_cost * self.aging + building_bess_aging_cost - fcrn_returns - fcrd_returns
            return overall_cost
        self.model.obj = pyo.Objective(rule=objective_rule, sense=pyo.minimize)

        def objective_rule_dc(model):
            subscription_fee = model.Subscription_fee
            supplier_cost = sum(model.supplier_cost[t] for t in model.T)
            transmission_cost = sum(model.transmission_cost[t] for t in model.T)
            peak_cost = model.Effect_fee * model.monthly_peak * PEAK_MULTIPLIER
            dso_cost = transmission_cost + peak_cost + subscription_fee
            tax_cost = (supplier_cost + dso_cost)*VAT_RATE + ((1 + VAT_RATE) * model.Energy_tax * sum(model.P_im_grid[t] - model.P_ex_grid[t] for t in model.T) / self.resolution)
            building_bess_aging_cost = sum(sum(getattr(model, f'{building.name}_bess_CycCost')[t] + getattr(model, f'{building.name}_bess_CalCost')[t] \
                                    for building in self.buildings) for t in model.T)
            ev_soc = sum(t * (getattr(model, f'{charge_point.name}_S{charge_point.session_id[ev_index]}_soc')[t]) for charge_point in self.charging_points for ev_index in range(charge_point.num_evs) for t in model.T)
            overall_cost = dso_cost + tax_cost + supplier_cost + building_bess_aging_cost - ev_soc * 1000
            return overall_cost
        self.model.obj_dc = pyo.Objective(rule=objective_rule_dc, sense=pyo.minimize)

    def solve(self):
        solver = pyo.SolverFactory(SOLVER_NAME)
        _apply_time_limit(solver, SOLVER_NAME, SOLVER_TIME_LIMIT)
        if self.dc:
            self.model.obj.deactivate()
            self.model.obj_dc.activate()
        else:
            self.model.obj.activate()
            self.model.obj_dc.deactivate()
        self.results = solver.solve(self.model)
        return self.results
    
    def get_results(self):
        print(f'Objective value: {pyo.value(self.model.obj)}')
        print(f"⏱ Time steps in model: {len(self.model.T)}")

        results = {}
        
        for cp in self.charging_points:
            T = list(self.model.T)

            # ---------- AGGREGATED EV VARIABLES ----------
            ch = []
            ds = []
            soc = []
            ch_fcrn = []
            ds_fcrn = []
            ch_fcrd = []
            ds_fcrd = []
            cyc_ag = []
            cal_ag = []
            ev_connection = []
            session_connection = []

            for t in T:
                ch_t = 0.0
                ds_t = 0.0
                soc_weighted = 0.0
                cap_sum = 0.0
                ch_fcrn_t = 0.0
                ds_fcrn_t = 0.0
                ch_fcrd_t = 0.0
                ds_fcrd_t = 0.0
                cyc_ag_t = 0.0
                cal_ag_t = 0.0
                connected_evs_t = None
                soc_ev_t = 0.0
                session_id_t = None

                for ev in range(cp.num_evs):
                    ev_name = f"{cp.name}_S{cp.session_id[ev]}"

                    ch_t += pyo.value(getattr(self.model, f"{ev_name}_ch")[t])
                    ds_t += pyo.value(getattr(self.model, f"{ev_name}_ds")[t])

                    soc_ev = pyo.value(getattr(self.model, f"{ev_name}_soc")[t])
                    soc_ev_t += soc_ev

                    ch_fcrn_t += pyo.value(getattr(self.model, f"{ev_name}_Pch_fcrn")[t])
                    ds_fcrn_t += pyo.value(getattr(self.model, f"{ev_name}_Pds_fcrn")[t])
                    ch_fcrd_t += pyo.value(getattr(self.model, f"{ev_name}_Pch_fcrd")[t])
                    ds_fcrd_t += pyo.value(getattr(self.model, f"{ev_name}_Pds_fcrd")[t])

                    cyc_ag_t += pyo.value(getattr(self.model, f"{ev_name}_CycAg")[t])
                    cal_ag_t += pyo.value(getattr(self.model, f"{ev_name}_CalAg")[t])

                    if cp.ev_arrival[ev] <= t < cp.ev_departure[ev]:
                        connected_evs_t = cp.ev_id[ev]
                        session_id_t = cp.session_id[ev]
                
                ev_connection.append(connected_evs_t)
                session_connection.append(session_id_t)

                ch.append(ch_t)
                ds.append(ds_t)
                soc.append(soc_ev_t)
                ch_fcrn.append(ch_fcrn_t)
                ds_fcrn.append(ds_fcrn_t)
                ch_fcrd.append(ch_fcrd_t)
                ds_fcrd.append(ds_fcrd_t)
                cyc_ag.append(cyc_ag_t * 100)
                cal_ag.append(cal_ag_t * 100)

            # ---------- STORE CP-LEVEL RESULTS ----------
            results[f"{cp.name}_EV_connection"] = ev_connection
            results[f"{cp.name}_Session"] = session_connection
            results[f"{cp.name}_ch"] = ch
            results[f"{cp.name}_ds"] = ds
            results[f"{cp.name}_soc"] = soc
            results[f"{cp.name}_ch_fcrn"] = ch_fcrn
            results[f"{cp.name}_ds_fcrn"] = ds_fcrn
            results[f"{cp.name}_ch_fcrd"] = ch_fcrd
            results[f"{cp.name}_ds_fcrd"] = ds_fcrd
            results[f"{cp.name}_CycAg"] = cyc_ag
            results[f"{cp.name}_CalAg"] = cal_ag

            # ---------- EXISTING CP VARIABLES ----------
            results[f"{cp.name}_P"] = [pyo.value(getattr(self.model, f"{cp.name}_P")[t]) for t in T]
            results[f"{cp.name}_Pbid_fcrn"] = [pyo.value(getattr(self.model, f"{cp.name}_Pbid_fcrn")[t]) for t in T]
            results[f"{cp.name}_Pbid_fcrdu"] = [pyo.value(getattr(self.model, f"{cp.name}_Pbid_fcrdu")[t]) for t in T]
            results[f"{cp.name}_Pbid_fcrdd"] = [pyo.value(getattr(self.model, f"{cp.name}_Pbid_fcrdd")[t]) for t in T]
            results[f"{cp.name}_Cyclic_cost"] = [pyo.value(getattr(self.model, f"{cp.name}_Cyclic_cost")[t]) for t in T]
            results[f"{cp.name}_Calendar_cost"] = [pyo.value(getattr(self.model, f"{cp.name}_Calendar_cost")[t]) for t in T]
        for building in self.buildings:
            results[f'{building.name}_bess_ch'] = [pyo.value(getattr(self.model, f'{building.name}_bess_ch')[t]) for t in self.model.T]
            results[f'{building.name}_bess_ds'] = [pyo.value(getattr(self.model, f'{building.name}_bess_ds')[t]) for t in self.model.T]
            results[f'{building.name}_bess_ch_fcrn'] = [pyo.value(getattr(self.model, f'{building.name}_bess_Pch_fcrn')[t]) for t in self.model.T]
            results[f'{building.name}_bess_ds_fcrn'] = [pyo.value(getattr(self.model, f'{building.name}_bess_Pds_fcrn')[t]) for t in self.model.T]
            results[f'{building.name}_bess_ch_fcrd'] = [pyo.value(getattr(self.model, f'{building.name}_bess_Pch_fcrd')[t]) for t in self.model.T]
            results[f'{building.name}_bess_ds_fcrd'] = [pyo.value(getattr(self.model, f'{building.name}_bess_Pds_fcrd')[t]) for t in self.model.T]
            results[f'{building.name}_bess_soc'] = [pyo.value(getattr(self.model, f'{building.name}_bess_soc')[t]) for t in self.model.T]
            results[f'{building.name}_P'] = [pyo.value(getattr(self.model, f'{building.name}_P')[t]) for t in self.model.T]
            results[f'{building.name}_Pbid_fcrn'] = [pyo.value(getattr(self.model, f'{building.name}_bess_Pbid_fcrn')[t]) for t in self.model.T]
            results[f'{building.name}_Pbid_fcrdu'] = [pyo.value(getattr(self.model, f'{building.name}_bess_Pbid_fcrdu')[t]) for t in self.model.T]
            results[f'{building.name}_Pbid_fcrdd'] = [pyo.value(getattr(self.model, f'{building.name}_bess_Pbid_fcrdd')[t]) for t in self.model.T]
            results[f'{building.name}_bess_CycAg'] = [pyo.value(getattr(self.model, f'{building.name}_bess_CycAg')[t]) * 100 for t in self.model.T]
            results[f'{building.name}_bess_CycCost'] = [pyo.value(getattr(self.model, f'{building.name}_bess_CycCost')[t]) for t in self.model.T]
            results[f'{building.name}_bess_CalAg'] = [pyo.value(getattr(self.model, f'{building.name}_bess_CalAg')[t]) * 100 for t in self.model.T]
            results[f'{building.name}_bess_CalCost'] = [pyo.value(getattr(self.model, f'{building.name}_bess_CalCost')[t]) for t in self.model.T]
        
        results['P_bid_fcrn'] = [sum(pyo.value(getattr(self.model, f'{charge_point.name}_Pbid_fcrn')[t]) for charge_point in self.charging_points) +
                                sum(pyo.value(getattr(self.model, f'{building.name}_bess_Pbid_fcrn')[t]) for building in self.buildings)
                                for t in self.model.T]
        results['P_bid_fcrdu'] = [sum(pyo.value(getattr(self.model, f'{charge_point.name}_Pbid_fcrdu')[t]) for charge_point in self.charging_points) +
                                sum(pyo.value(getattr(self.model, f'{building.name}_bess_Pbid_fcrdu')[t]) for building in self.buildings)
                                for t in self.model.T]
        results['P_bid_fcrdd'] = [sum(pyo.value(getattr(self.model, f'{charge_point.name}_Pbid_fcrdd')[t]) for charge_point in self.charging_points) +
                                sum(pyo.value(getattr(self.model, f'{building.name}_bess_Pbid_fcrdd')[t]) for building in self.buildings)
                                for t in self.model.T]
        results['P_import_spot'] = [pyo.value(self.model.P_im_grid[t]) for t in self.model.T]
        results['P_export_spot'] = [pyo.value(self.model.P_ex_grid[t]) for t in self.model.T]
        results['P_import_all'] = [pyo.value(self.model.P_im_total[t]) for t in self.model.T]
        results['P_export_all'] = [pyo.value(self.model.P_ex_total[t]) for t in self.model.T]
        results['Transmission cost'] = [pyo.value(self.model.transmission_cost[t]) for t in self.model.T]
        results['Supplier cost'] = [pyo.value(self.model.supplier_cost[t]) for t in self.model.T]
        results['FCRN returns'] = [pyo.value(self.model.fcrn_returns[t]) for t in self.model.T]
        results['FCRD returns'] = [pyo.value(self.model.fcrd_returns[t]) for t in self.model.T]
        return pd.DataFrame(results)

def optimization_function_lec(charging_point_data, building_data, prices, temperature, activation, start_date, days, horizon_hours = 36, fcrn_on=0, fcrdd_on=0, fcrdu_on=0, aging=0, v2g_on=0, dc=False, store_hours = 24, building_on = 1, previous_monthly_peak = 0, current_month = 1, initial_bess_soc = 0.5, pv_on = 1, bess_on = 1):
    previous_soc = pd.DataFrame(index=range(1), columns=list(building_data.keys()))
    previous_soc.iloc[:, :] = initial_bess_soc
    unfeasible_days = []
    # Store rolling results
    rolling_results = pd.DataFrame()

    # Track ongoing EV sessions across days
    ongoing_sessions = {cp_name: [] for cp_name in charging_point_data.keys()}

    for day in range(days):
        if not prices.index.equals(activation.index):
            print('Prices and activation index do not match!!!')
            break
        elif not prices.index.equals(temperature.index):
            print('Prices and temperature index do not match!!')
            break
        elif not temperature.index.equals(activation.index):
            print('Temperature and activation index do not match!!!')
            break
        else:
            print('All index are correct - starting rolling-horizon')

        print("=" * 40)
        print(f"🔄 Day {day + 1} Optimization ({horizon_hours}h Horizon)")

        resolution = int(3600/(prices['Spot prices'].index[1] - prices['Spot prices'].index[0]).total_seconds())
        if resolution == 1:
            freq_index = '60min'
        elif resolution == 4:
            freq_index = '15min'
        else:
            print('Resolution of spot prices is not 15 min or 60 min!! - CHECK')
            break
        start_time = start_date + timedelta(days=day)
        end_time = start_time + timedelta(hours=horizon_hours) - pd.Timedelta(seconds=1)
        opt_end_time = start_time + timedelta(hours=store_hours) - pd.Timedelta(seconds=1)
        full_index = pd.date_range(start=start_time,end=end_time,freq=f'{freq_index}')
        
        # 1. Build buildings
        print("Step 1: Initializing buildings")
        building_list = []
        if building_on == 1:
            for name in building_data.keys():
                
                load = building_data[name].loc[start_time:end_time - timedelta(hours=1), 'electricity_load']
                load = load[~load.index.duplicated(keep='first')]
                load = load.reindex(full_index, method = 'ffill') / resolution

                pv = building_data[name].loc[start_time:end_time - timedelta(hours=1), 'pv_production']
                pv = pv[~pv.index.duplicated(keep='first')] * pv_on
                pv = pv.reindex(full_index, method = 'ffill') / resolution

                bess_capacity = building_data[name]['bess_capacity'].iloc[0] * bess_on
                bess_max_power = building_data[name]['bess_power'].iloc[0]

                print(f"  - Building {name} with initial SOC {previous_soc[name].iloc[0]}")
                building_list.append(building(
                    name=name,
                    load=load,
                    pv_production=pv,
                    bess_capacity=bess_capacity,
                    bess_initial_soc=previous_soc[name].iloc[0],
                    bess_max_power=bess_max_power
                ))
        else:
            print('Skipped buildings!!!')
        # 2. Charging Points
        print("Step 2: Preparing charging points")
        charging_point_list = []
        new_ongoing_sessions = {cp_name: [] for cp_name in charging_point_data.keys()}
        new_sessions_starting_tomorrow = []

        for cp_name in charging_point_data.keys():
            print(f"  ⛽ Charging Point: {cp_name}")
            cp_df = charging_point_data[cp_name]
            capacities, max_powers, arrivals, departures = [], [], [], []
            arrival_socs, desired_socs, ev_ids, session_ids = [], [], [], []

            # a) Add ongoing sessions
            print("   ↪ Checking ongoing sessions from previous day")
            for idx, session in enumerate(ongoing_sessions[cp_name]):
                if session['departure_time'] > start_time:
                    dep_time = int((session['departure_time'] - start_time).total_seconds() // (60 * 60 / resolution))
                    ev_index = len(capacities)
                    session['ev_index'] = ev_index
                    capacities.append(session['capacity'])
                    max_powers.append(session['max_power'])
                    arrivals.append(0)
                    departures.append(min(dep_time, horizon_hours * 4))
                    arrival_socs.append(session['last_soc'])
                    if session['departure_time'] < end_time:
                        desired_socs.append(session['last_desired_soc'])
                    else:
                        desired_socs.append(session['last_desired_soc'])
                    ev_ids.append(session['ev_id'])
                    session_ids.append(session['session_id'])

                    print(f"     ✅ Continued EV{session['ev_id']}: dep_time_slot={dep_time}, SOC={session['last_soc']}")
                    if session['departure_time'] > opt_end_time:
                        new_ongoing_sessions[cp_name].append(session)

            # b) Add new sessions that start in first 24 hours
            print("   ↪ Adding new sessions starting in first 24 hours")
            today_sessions = cp_df[
                (cp_df['Arrival'] >= start_time) &
                (cp_df['Arrival'] < start_time + timedelta(hours=store_hours))
            ]

            for idx, row in today_sessions.iterrows():
                arrival_time = int((row['Arrival'] - start_time).total_seconds() // (60 * 60 / resolution))
                departure_time = int((row['Departure'] - start_time).total_seconds() // (60 * 60 / resolution))

                capacities.append(row['Capacity'])
                max_powers.append(row['Max_Power'])
                arrivals.append(arrival_time)

                if row['Departure'] > end_time:
                    connected_time = departure_time - arrival_time
                    slope_linear = (row['Desired SOC'] - row['Arrival SOC']) / connected_time
                    linear_requested = slope_linear * (horizon_hours * resolution - arrival_time)
                    departures.append(horizon_hours * resolution) #need to fix if they connect just before the end of horizon then what should be desired soc?
                    session = {
                        'capacity': row['Capacity'],
                        'max_power': row['Max_Power'],
                        'departure_time': row['Departure'],
                        'last_soc': None,
                        'desired_soc': row['Arrival SOC'] + linear_requested, #row['Desired SOC'],
                        'last_desired_soc': row['Desired SOC'],
                        'cp_name': cp_name,
                        'ev_index': len(capacities) - 1,
                        'ev_id': row['ev_id'],
                        'session_id': row['session_id']
                    }
                    new_ongoing_sessions[cp_name].append(session)
                    new_sessions_starting_tomorrow.append(session)
                    print(f"     ➕ New EV (spans days): arrival {arrival_time}, will depart next day and can end day with SOC: {row['Arrival SOC'] + linear_requested}")
                    
                elif row['Departure'] > opt_end_time:
                    departures.append(departure_time)
                    session = {
                        'capacity': row['Capacity'],
                        'max_power': row['Max_Power'],
                        'departure_time': row['Departure'],
                        'last_soc': None,
                        'desired_soc': row['Desired SOC'],
                        'last_desired_soc': row['Desired SOC'],
                        'cp_name': cp_name,
                        'ev_index': len(capacities) - 1,
                        'ev_id': row['ev_id'],
                        'session_id': row['session_id']
                    }
                    print(f"     ➕ New EV (spans days): arrival {arrival_time}, will depart next day at: {departure_time}")
                    new_ongoing_sessions[cp_name].append(session)
                    new_sessions_starting_tomorrow.append(session)
                else:
                    departures.append(departure_time)
                    print(f"     ➕ New EV: arrival {arrival_time}, departure {departure_time}")

                arrival_socs.append(row['Arrival SOC'])
                desired_socs.append(row['Desired SOC'])
                ev_ids.append(row['ev_id'])
                session_ids.append(row['session_id'])

            charging_point_list.append(charging_point(
                name=cp_name,
                ev_id = ev_ids,
                session_id= session_ids,
                ev_capacity=capacities,
                ev_max_power=max_powers,
                ev_arrival=arrivals,
                ev_departure=departures,
                ev_arrival_soc=arrival_socs,
                ev_desired_soc=desired_socs
            ))

        # 3. Run optimization
        print("Step 3: Solving optimization model")
        spot_prices = np.array(prices['Spot prices'].loc[start_time:end_time] * 11.1 / 1000) #€/MWh to SEK/kWh
        temperatures = np.array(temperature['Temperature'].loc[start_time:end_time])
        fcrn_prices = np.array(prices['FCRN prices'].loc[start_time:end_time] * 11.1 / 1000)
        fcrdu_prices = np.array(prices['FCRDU prices'].loc[start_time:end_time] * 11.1 / 1000)
        fcrdd_prices = np.array(prices['FCRDD prices'].loc[start_time:end_time] * 11.1 / 1000)
        up_reg = np.array(prices['Up reg prices'].loc[start_time:end_time] * 11.1 / 1000)
        down_reg = np.array(prices['Down reg prices'].loc[start_time:end_time] * 11.1 / 1000)
        act_up_fcrn = np.array(activation['FCR-N-up'].loc[start_time:end_time] * 11.1 / 1000)
        act_up_fcrd = np.array(activation['FCR-D-up'].loc[start_time:end_time] * 11.1 / 1000)
        act_down_fcrn = np.array(activation['FCR-N-down'].loc[start_time:end_time] * 11.1 / 1000)
        act_down_fcrd = np.array(activation['FCR-D-down'].loc[start_time:end_time] * 11.1 / 1000)
        
        opt_model = LEC_Opt_spot_fcrn_fcrd(charging_point_list, building_list, spot_prices, temperature=temperatures, fcrn_prices=fcrn_prices, fcrdu_prices=fcrdu_prices, fcrdd_prices=fcrdd_prices,
                                    reg_up=up_reg, reg_down=down_reg, act_fcrn_up=act_up_fcrn, act_fcrn_down=act_down_fcrn, 
                                    act_fcrd_up=act_up_fcrd, act_fcrd_down=act_down_fcrd, fcrn_on=fcrn_on, fcrdd_on=fcrdd_on, fcrdu_on=fcrdu_on, aging=aging, resolution=resolution ,v2g_on=v2g_on, dc = dc)

        results_df = opt_model.solve()
        if _hit_time_limit(results_df):
            print("Solver stopped due to time limit and trying only with SC ")
            unfeasible_days.append(day)
            opt_model = LEC_Opt_spot_fcrn_fcrd(charging_point_list, building_list, spot_prices, temperature=temperatures, fcrn_prices=fcrn_prices, fcrdu_prices=fcrdu_prices, fcrdd_prices=fcrdd_prices,
                                    reg_up=up_reg, reg_down=down_reg, act_fcrn_up=act_up_fcrn, act_fcrn_down=act_down_fcrn, 
                                    act_fcrd_up=act_up_fcrd, act_fcrd_down=act_down_fcrd, fcrn_on=0, fcrdd_on=0, fcrdu_on=0, aging=0, resolution=resolution ,v2g_on=0, dc = False)
            results_df = opt_model.solve()
            if _hit_time_limit(results_df):
                print(f"Solver stopped due to time limit with SC - recheck every input data on day {day}")
                break
        df = opt_model.get_results()
        df.index = prices.loc[start_time:end_time, 'Spot prices'].index

        print("   ✅ Optimization complete")
        for col in df.columns:
            if '_soc' in col:
                print(col, "→", df[col].iloc[store_hours * resolution - 1])
        print("\n✅ Columns in results DataFrame:")
        print([col for col in df.columns if '_soc' in col])

        # Save first 24h of results
        print("Step 3: Saving 24h results to cumulative DataFrame")
        rolling_results = pd.concat([rolling_results, df.iloc[:store_hours * resolution]])
        opt_month = rolling_results.index[-1].month
        if current_month - opt_month == 0:
            opt_peak = (df['P_import_all'].iloc[:store_hours * resolution] - df['P_export_all'].iloc[:store_hours * resolution]).max()   #needs to be from the opt
            if previous_monthly_peak < opt_peak:
                previous_monthly_peak = opt_peak
        else:
            previous_monthly_peak = 0
            current_month = opt_month

        # 4. Update building SOCs
        if building_on == 1:
            print("Step 4: Updating building SOCs")
            for name in building_data.keys():
                soc_val = df[f'{name}_bess_soc'].iloc[store_hours * resolution - 1]
                # Single-step .loc assignment. The previous form,
                # previous_soc[name].iloc[0] = soc_val, is chained assignment:
                # under pandas 3.0 Copy-on-Write it writes to a temporary and
                # silently does nothing, so every day restarted from the initial
                # SOC instead of carrying the battery state forward.
                previous_soc.loc[previous_soc.index[0], name] = soc_val
                print(f"  🔋 {name} end-of-day SOC: {soc_val:.2f}")
        else:
            print('Step 4. No buildings available')

        # 5. Update ongoing sessions' SOCs
        print("Step 5: Updating ongoing session SOCs from Day", day + 1)
        for cp_name in ongoing_sessions.keys():
            for session in ongoing_sessions[cp_name]:
                ev_name = f"{session['cp_name']}"
                if ev_name + "_soc" in df.columns:
                    session['last_soc'] = df[f'{ev_name}_soc'].iloc[store_hours * resolution - 1]
                    print(f"🔄 Updated {ev_name} SOC = {session['last_soc']:.2f}")
                else:
                    print(f"⚠️ Warning: {ev_name}_soc not found in results")

        # 6. Update new sessions for tomorrow with today’s end SOC
        print("Step 6: Updating sessions starting today that continue to tomorrow")
        for session in new_sessions_starting_tomorrow:
            ev_name = f"{session['cp_name']}"
            if f"{ev_name}_soc" in df.columns:
                session['last_soc'] = float(df[f"{ev_name}_soc"].iloc[store_hours * resolution - 1])
                print(f"🚚 {ev_name}: SOC carried to next day = {session['last_soc']:.2f}")
            else:
                print(f"⚠️ Could not update SOC for {ev_name}")

        # 7. Carry forward ongoing sessions
        print("Step 7: Updating ongoing_sessions for next day")
        ongoing_sessions = new_ongoing_sessions

        print("=" * 40 + "\n")
    rolling_results['Cyc_Age'] = rolling_results.filter(regex='_CycAg$').sum(axis=1) * 100
    rolling_results['Cal_Age'] = rolling_results.filter(regex='_CalAg$').sum(axis=1) * 100
    rolling_results['Cyc_Cost'] = rolling_results.filter(regex='_CycCost$').sum(axis=1) 
    rolling_results['Cal_Cost'] = rolling_results.filter(regex='_CalCost$').sum(axis=1) 
    # 'M' was removed in pandas 3.0; 'ME' is the month-end alias.
    # These reported costs are recomputed here rather than read back from the
    # model, so they carried a second copy of the tariff constants - 61.533,
    # 0.25 and 0.439 written inline. That meant tuning the model changed the
    # solution but not the numbers reported for it. They now read the same
    # module-level parameters the model was built from.
    peak_load = (rolling_results['P_import_all']-rolling_results['P_export_all']).resample('ME').max()
    monthly_peak_costs = peak_load * EFFECT_FEE_SEK_PER_KW_MONTH / 30 / 24 / resolution
    month_end_index = rolling_results.index.to_period('M').to_timestamp('M')
    rolling_results['Peak cost'] = month_end_index.map(monthly_peak_costs)
    rolling_results['DSO cost'] = rolling_results['Transmission cost'] + rolling_results['Peak cost']
    rolling_results['Tax cost'] = VAT_RATE * (rolling_results['Supplier cost'] + rolling_results['DSO cost']) + (1 + VAT_RATE) * ENERGY_TAX * (rolling_results['P_import_all'] - rolling_results['P_export_all']) / resolution
    rolling_results['Overall cost'] = rolling_results['DSO cost'] + rolling_results['Supplier cost'] + rolling_results['Tax cost'] - rolling_results['FCRN returns'] - rolling_results['FCRD returns']
    print(f'\n \n Overall simulation completed - number of unfesible days: {len(unfeasible_days)} and they are: {unfeasible_days}')
    return rolling_results