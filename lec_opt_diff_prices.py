import pyomo.environ as pyo
import numpy as np
import pandas as pd

class charging_point():
    def __init__(self, name, ev_capacity, ev_max_power, ev_arrival_soc, ev_arrival, ev_departure, ev_desired_soc):
        self.efficiency = 0.93
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
            assert min_req_charge_per_time <= ev_max_power[
                i], f"min_req_charge_per_time ({min_req_charge_per_time:.2f}) must be less than or equal to ev_max_power[{i}] ({ev_max_power[i]}) for {name}"

        self.name = name
        self.ev_capacity = ev_capacity
        self.ev_max_power = ev_max_power
        self.ev_arrival_soc = ev_arrival_soc
        self.ev_desired_soc = ev_desired_soc
        self.ev_arrival = ev_arrival
        self.ev_departure = ev_departure
        self.num_evs = len(ev_capacity)  # Store the number of EVs


class building():
    def __init__(self, name, load, pv_production, bess_capacity, bess_max_power, bess_initial_soc):
        self.efficiency = 0.93
        self.name = name
        self.load = load
        self.pv_production = pv_production
        self.bess_capacity = bess_capacity
        self.bess_max_power = bess_max_power
        self.bess_initial_soc = bess_initial_soc


class lec_opt():
    def __init__(self, charging_points, buildings, spot_prices, flex_price, P_dso_import,
                 P_dso_export, previous_monthly_peak=0, v2g_on=1, incentive_per_kwh=0.1, roh=0.1):
        self.M = 10000
        self.roh = roh
        self.charging_points = charging_points
        self.buildings = buildings
        self.spot_prices = spot_prices
        self.incentive_per_kwh = incentive_per_kwh
        self.v2g_on = v2g_on
        self.previous_monthly_peak = previous_monthly_peak
        self.flex_price = flex_price
        self.P_dso_import = P_dso_import
        self.P_dso_export = P_dso_export
        self.model = pyo.ConcreteModel()
        self.build_model()

    def build_model(self):
        self.model.T = pyo.Set(initialize=range(len(self.spot_prices)))
        self.model.spot_prices = self.spot_prices
        self.model.previous_monthly_peak = self.previous_monthly_peak
        self.model.monthly_peak = pyo.Var(initialize=0)
        self.model.P_im_grid = pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 20000))
        self.model.P_ex_grid = pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 20000))
        self.model.B_im_grid = pyo.Var(self.model.T, within=pyo.Binary)
        self.model.Peakload = pyo.Var(within=pyo.NonNegativeReals)
        self.model.transmission_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.supplier_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.overall_dso_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.tax_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.peak_cost = pyo.Var(self.model.T, within=pyo.Reals)
        self.model.Subscription_fee = 605 / 30  # Subscription fee SEK/14 days
        self.model.Transmission_fee = 0.113  # Electricity transmission fee SEK/kWh
        self.model.Transmission_health_incentive = 0.04  # Transmission health incentive SEK/kWh
        self.model.Effect_fee = 61.55 / 30  # Effect fee SEK/kW/14 days
        self.model.Energy_tax = 0.439  # Tax fee SEK/kWh
        self.model.Energy_certificate = 0.005  # Energy certificate SEK/kWh
        self.model.compensation_fee = 0.02  # Transfer compensation fee SEK/kWh

        for charge_point in self.charging_points:
            setattr(self.model, f'{charge_point.name}_P',
                    pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000)))

            # Iterate through each EV at the charging point
            for ev_index in range(charge_point.num_evs):
                ev_name = f'{charge_point.name}_ev{ev_index}'  # Unique name for each EV
                setattr(self.model, f'{ev_name}_ch', pyo.Var(self.model.T, within=pyo.NonNegativeReals,
                                                             bounds=(0, charge_point.ev_max_power[ev_index])))
                setattr(self.model, f'{ev_name}_ds', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0,
                                                                                                                self.v2g_on *
                                                                                                                charge_point.ev_max_power[
                                                                                                                    ev_index])))
                setattr(self.model, f'{ev_name}_soc', pyo.Var(self.model.T, within=pyo.NonNegativeReals, bounds=(0, 1)))
                setattr(self.model, f'{ev_name}_Bch', pyo.Var(self.model.T, within=pyo.Binary))

                ev_capacity = charge_point.ev_capacity[ev_index]
                ev_arrival_soc = charge_point.ev_arrival_soc[ev_index]
                ev_arrival = charge_point.ev_arrival[ev_index]
                ev_departure = charge_point.ev_departure[ev_index]
                ev_desired_soc = charge_point.ev_desired_soc[ev_index]

                def ev_soc_rule(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ch = getattr(model, f'{ev_name}_ch')[t]
                    ev_ds = getattr(model, f'{ev_name}_ds')[t]
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    if t == ev_arrival:
                        return ev_soc == ev_arrival_soc + (
                                    ev_ch * charge_point.efficiency - ev_ds / charge_point.efficiency) / ev_capacity
                    elif ev_arrival < t <= ev_departure:
                        ev_previous_soc = getattr(model, f'{ev_name}_soc')[t - 1]
                        return ev_soc == ev_previous_soc + (
                                    ev_ch * charge_point.efficiency - ev_ds / charge_point.efficiency) / ev_capacity
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
                    ev_ch = getattr(model, f'{ev_name}_ch')[t]
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return ev_ch >= 0
                    return ev_ch == 0

                setattr(self.model, f'{ev_name}_avail_ch_constraint', pyo.Constraint(self.model.T, rule=ev_avail_ch))

                def ev_avail_ds(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_ds = getattr(model, f'{ev_name}_ds')[t]
                    if charge_point.ev_arrival[ev_index] < t < charge_point.ev_departure[ev_index]:
                        return ev_ds >= 0
                    return ev_ds == 0

                setattr(self.model, f'{ev_name}_avail_ds_constraint', pyo.Constraint(self.model.T, rule=ev_avail_ds))

                def ev_desired_soc(model, t, charge_point=charge_point, ev_index=ev_index):
                    ev_soc = getattr(model, f'{ev_name}_soc')[t]
                    if t == charge_point.ev_departure[ev_index]:
                        return ev_soc >= charge_point.ev_desired_soc[ev_index]
                    return pyo.Constraint.Skip

                setattr(self.model, f'{ev_name}_desired_soc_constraint',
                        pyo.Constraint(self.model.T, rule=ev_desired_soc))

            def consumption(model, t, charge_point=charge_point):
                P = getattr(model, f'{charge_point.name}_P')[t]
                ev_power = sum(getattr(model, f'{charge_point.name}_ev{ev_index}_ch')[t] -
                               getattr(model, f'{charge_point.name}_ev{ev_index}_ds')[t] for ev_index in
                               range(charge_point.num_evs))
                return ev_power == P

            setattr(self.model, f'{charge_point.name}_consumption_constraint',
                    pyo.Constraint(self.model.T, rule=consumption))

        # Building constraints:
        for building in self.buildings:
            setattr(self.model, f'{building.name}_P',
                    pyo.Var(self.model.T, within=pyo.Reals, bounds=(-1000000, 1000000)))
            setattr(self.model, f'{building.name}_bess_soc', pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, 1)))
            setattr(self.model, f'{building.name}_bess_ch',
                    pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, building.bess_max_power)))
            setattr(self.model, f'{building.name}_bess_ds',
                    pyo.Var(self.model.T, within=pyo.Reals, bounds=(0, building.bess_max_power)))
            setattr(self.model, f'{building.name}_bess_Bch', pyo.Var(self.model.T, within=pyo.Binary))

            def bess_soc_rule(model, t, building=building):
                bess_ch = getattr(model, f'{building.name}_bess_ch')[t]
                bess_ds = getattr(model, f'{building.name}_bess_ds')[t]
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                if building.bess_capacity == 0:
                    return bess_soc == 0
                elif t == 0:
                    return bess_soc == building.bess_initial_soc + (
                                bess_ch * building.efficiency - bess_ds / building.efficiency) / building.bess_capacity
                else:
                    bess_previous_soc = getattr(model, f'{building.name}_bess_soc')[t - 1]
                    return bess_soc == bess_previous_soc + (
                                bess_ch * building.efficiency - bess_ds / building.efficiency) / building.bess_capacity

            setattr(self.model, f'{building.name}_bess_soc_constraint',
                    pyo.Constraint(self.model.T, rule=bess_soc_rule))

            def bess_soc_min_rule(model, t, building=building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                if building.bess_capacity == 0:
                    return bess_soc == 0
                return bess_soc >= 0.2

            setattr(self.model, f'{building.name}_bess_soc_min_constraint',
                    pyo.Constraint(self.model.T, rule=bess_soc_min_rule))

            def bess_soc_max_rule(model, t, building=building):
                bess_soc = getattr(model, f'{building.name}_bess_soc')[t]
                if building.bess_capacity == 0:
                    return pyo.Constraint.Skip
                return bess_soc <= 1.0

            setattr(self.model, f'{building.name}_bess_soc_max_constraint',
                    pyo.Constraint(self.model.T, rule=bess_soc_max_rule))


            def bess_max_ch(model, t, building=building):
                bess_Bch = getattr(model, f'{building.name}_bess_Bch')[t]
                bess_ch = getattr(model, f'{building.name}_bess_ch')[t]
                if building.bess_capacity == 0:
                    return bess_ch == 0
                return bess_ch <= bess_Bch * building.bess_max_power

            setattr(self.model, f'{building.name}_bess_max_ch_constraint',
                    pyo.Constraint(self.model.T, rule=bess_max_ch))

            def bess_max_ds(model, t, building=building):
                bess_Bch = getattr(model, f'{building.name}_bess_Bch')[t]
                bess_ds = getattr(model, f'{building.name}_bess_ds')[t]
                if building.bess_capacity == 0:
                    return bess_ds == 0
                return bess_ds <= (1 - bess_Bch) * building.bess_max_power

            setattr(self.model, f'{building.name}_bess_max_ds_constraint',
                    pyo.Constraint(self.model.T, rule=bess_max_ds))

            def building_consumption(model, t, building=building):
                P = getattr(model, f'{building.name}_P')[t]
                load = building.load[t]
                pv = building.pv_production[t]
                bess_ch = getattr(model, f'{building.name}_bess_ch')[t]
                bess_ds = getattr(model, f'{building.name}_bess_ds')[t]
                return load - pv - bess_ds + bess_ch == P

            setattr(self.model, f'{building.name}_consumption_constraint',
                    pyo.Constraint(self.model.T, rule=building_consumption))

        def power_balance(model, t):
            overall_consumption = sum(
                getattr(model, f'{charge_point.name}_P')[t] for charge_point in self.charging_points) + \
                                  sum(getattr(model, f'{building.name}_P')[t] for building in self.buildings)
            P_im = self.model.P_im_grid[t]
            P_ex = self.model.P_ex_grid[t]
            return P_im - P_ex == overall_consumption

        self.model.power_balance_constarint = pyo.Constraint(self.model.T, rule=power_balance)

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

        def peak_load_constraint(model, t):
            return model.Peakload >= model.P_im_grid[t] - model.P_ex_grid[t]

        self.model.peak_load_constraint = pyo.Constraint(self.model.T, rule=peak_load_constraint)

        def previous_peak_check1(model):
            return model.monthly_peak >= model.Peakload

        self.model.previous_peak_check1_constraint = pyo.Constraint(rule=previous_peak_check1)

        def previous_peak_check2(model):
            return model.monthly_peak >= model.previous_monthly_peak

        self.model.previous_peak_check2_constraint = pyo.Constraint(rule=previous_peak_check2)

        def tranmission_cost(model, t):
            return model.transmission_cost[t] == model.P_im_grid[t] * model.Transmission_fee - model.P_ex_grid[
                t] * model.Transmission_health_incentive

        self.model.tranmission_cost_constraint = pyo.Constraint(self.model.T, rule=tranmission_cost)

        def supplier_cost(model, t):
            return model.supplier_cost[t] == model.P_im_grid[t] * (model.spot_prices[t] + model.Energy_certificate) - \
                model.P_ex_grid[t] * (model.spot_prices[t] + model.Energy_certificate + model.compensation_fee)

        self.model.supplier_cost_constraint = pyo.Constraint(self.model.T, rule=supplier_cost)

        # Base objective: without flex_income and penalty_cost
        def base_objective_rule(model):
            subscription_fee = model.Subscription_fee
            supplier_cost = sum((model.spot_prices[t] + model.Energy_certificate) * model.P_im_grid[t] / 4 - (
                        model.spot_prices[t] + model.Energy_certificate + model.compensation_fee)
                                * model.P_ex_grid[t] / 4 for t in model.T)
            transmission_cost = sum(
                (model.Transmission_fee) * model.P_im_grid[t] / 4 - (model.Transmission_health_incentive)
                * model.P_ex_grid[t] / 4 for t in model.T)
            peak_cost = model.Effect_fee * model.monthly_peak * 0.25
            dso_cost = transmission_cost + peak_cost + subscription_fee
            tax_cost = (supplier_cost + dso_cost) * 0.25 + (
                        1.25 * model.Energy_tax * sum(model.P_im_grid[t] - model.P_ex_grid[t] for t in model.T) / 4)
            overall_cost = dso_cost + tax_cost + supplier_cost
            return overall_cost

        self.model.base_obj = pyo.Objective(rule=base_objective_rule, sense=pyo.minimize)

        # Extended objective: with flex_income and penalty_cost
        def extended_obj_rule(model):
            subscription_fee = model.Subscription_fee
            supplier_cost = sum((model.spot_prices[t] + model.Energy_certificate) * model.P_im_grid[t] / 4 - (
                        model.spot_prices[t] + model.Energy_certificate + model.compensation_fee)
                                * model.P_ex_grid[t] / 4 for t in model.T)
            transmission_cost = sum(
                (model.Transmission_fee) * model.P_im_grid[t] / 4 - (model.Transmission_health_incentive)
                * model.P_ex_grid[t] / 4 for t in model.T)
            peak_cost = model.Effect_fee * model.monthly_peak * 0.25
            dso_cost = transmission_cost + peak_cost + subscription_fee
            tax_cost = (supplier_cost + dso_cost) * 0.25 + (
                        1.25 * model.Energy_tax * sum(model.P_im_grid[t] - model.P_ex_grid[t] for t in model.T) / 4)

            penalty_cost = (sum(self.flex_price[t] * (model.P_im_grid[t] - model.P_ex_grid[t]) for t in model.T)
                            + (self.roh / 2) * sum(
                ((model.P_im_grid[t] - model.P_ex_grid[t]) +
                 (self.P_dso_import[t] - self.P_dso_export[t]))** 2 for t in model.T))
            overall_cost = dso_cost + tax_cost + supplier_cost + penalty_cost
            return overall_cost

        self.model.extended_obj = pyo.Objective(rule=extended_obj_rule, sense=pyo.minimize)

    def solve(self, use_extended=False):
        solver = pyo.SolverFactory('cplex')
        if use_extended:
            self.model.base_obj.deactivate()
            self.model.extended_obj.activate()
        else:
            self.model.extended_obj.deactivate()
            self.model.base_obj.activate()

        self.results = solver.solve(self.model)
        return self.results

    def get_results(self):
        results = {}
        for charge_point in self.charging_points:
            for ev_index in range(charge_point.num_evs):
                ev_name = f'{charge_point.name}_ev{ev_index}'
                results[f'{ev_name}_ch'] = [pyo.value(getattr(self.model, f'{ev_name}_ch')[t]) for t in self.model.T]
                results[f'{ev_name}_ds'] = [pyo.value(getattr(self.model, f'{ev_name}_ds')[t]) for t in self.model.T]
                results[f'{ev_name}_soc'] = [pyo.value(getattr(self.model, f'{ev_name}_soc')[t]) for t in self.model.T]
            results[f'{charge_point.name}_P'] = [pyo.value(getattr(self.model, f'{charge_point.name}_P')[t]) for t in
                                                 self.model.T]
        for building in self.buildings:
            results[f'{building.name}_bess_ch'] = [pyo.value(getattr(self.model, f'{building.name}_bess_ch')[t]) for t
                                                   in self.model.T]
            results[f'{building.name}_bess_ds'] = [pyo.value(getattr(self.model, f'{building.name}_bess_ds')[t]) for t
                                                   in self.model.T]
            results[f'{building.name}_bess_soc'] = [pyo.value(getattr(self.model, f'{building.name}_bess_soc')[t]) for t
                                                    in self.model.T]
            results[f'{building.name}_P'] = [pyo.value(getattr(self.model, f'{building.name}_P')[t]) for t in
                                             self.model.T]
        results['P_import'] = [pyo.value(self.model.P_im_grid[t]) for t in self.model.T]
        results['P_export'] = [pyo.value(self.model.P_ex_grid[t]) for t in self.model.T]
        results['Transmission cost'] = [pyo.value(self.model.transmission_cost[t]) for t in self.model.T]
        results['Supplier cost'] = [pyo.value(self.model.supplier_cost[t]) for t in self.model.T]
        results['obj'] = pyo.value(self.model.base_obj) if self.model.base_obj.active else pyo.value(self.model.extended_obj)

        return pd.DataFrame(results)

