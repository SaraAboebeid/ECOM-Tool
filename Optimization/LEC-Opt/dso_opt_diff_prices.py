import pyomo.environ as pyo
import numpy as np
import pandas as pd

class DSO:
    def __init__(self, flex_price, P_lec_imp, P_lec_exp, VOLL,
                 S_base_MVA=100, V_base_kV=11, roh=0.1):
        self.T = 24
        self.buses = {}
        self.lines = {}
        self.loads = {}
        self.lecs = {}

        # Grid import/export limits in kW
        self.grid_limit = 1000

        # Input data (all in kW)
        self.flex_price = flex_price
        self.P_lec_imp = P_lec_imp  # dict keyed by (t, bus)
        self.P_lec_exp = P_lec_exp  # dict keyed by (t, bus)
        self.VOLL = VOLL
        self.roh = roh

        # Per-unit conversion bases
        self.S_base_MVA = S_base_MVA
        self.S_base_kW = S_base_MVA * 1000  # Convert to kW
        self.V_base_kV = V_base_kV

    # -----------------------
    # System definitions
    # -----------------------
    def add_buses(self, bus_df):
        """Add buses from DataFrame with columns: Bus, Type"""
        for _, row in bus_df.iterrows():
            self.buses[row['Bus']] = {'Type': row['Type']}

    def add_lines(self, line_df):
        """
        Add lines from DataFrame
        Expected columns: From, To, X_ohm, Pline_limit
        Converts reactance to per-unit based on S_base and V_base
        """
        for _, row in line_df.iterrows():
            line_id = f"{row['From']}_{row['To']}"
            # Convert ohms to per-unit: X_pu = X_ohm * S_base / V_base^2
            # (using same simplified unit treatment as originally)
            X_pu = row['X_ohm'] * self.S_base_MVA / (self.V_base_kV ** 2)
            self.lines[line_id] = {
                'from': row['From'],
                'to': row['To'],
                'X_pu': X_pu,
                'X_ohm': row['X_ohm'],
                'Pline_limit': row['Pline_limit']
            }

    def add_loads(self, load_df):
        """
        Add loads from DataFrame
        Expected columns: Bus, 0, 1, 2, ..., T-1 (loads in kW)
        """
        T = self.T
        for _, row in load_df.iterrows():
            bus = row['Bus']
            for t in range(T):
                if t not in row.index:
                    raise KeyError(f"Missing column {t} in load_df")
                self.loads[(bus, t)] = row[t]  # kW

    def add_lecs(self, lec_bus_list):
        """Define which buses have LECs"""
        for b in lec_bus_list:
            self.lecs[b] = True

    def set_grid_limit(self, p_grid_limit=1000):
        """Set grid import/export limit in kW"""
        self.grid_limit = p_grid_limit

    def validate_data(self):
        """Validate that required data is present"""
        if not self.buses:
            raise ValueError("No buses defined.")
        if not self.loads:
            raise ValueError("No loads defined.")
        slack_buses = [b for b, info in self.buses.items() if info['Type'] == 'slack']
        if not slack_buses:
            raise ValueError("No slack bus defined.")

    # -----------------------
    # Build DC OPF model
    # -----------------------
    def build_dc_opf(self):
        """Build the DC Optimal Power Flow model with proper unit handling"""
        self.validate_data()

        model = pyo.ConcreteModel()
        T = self.T

        model.T = pyo.Set(initialize=range(T))
        model.B = pyo.Set(initialize=list(self.buses.keys()))
        model.L = pyo.Set(initialize=list(self.lines.keys()))

        slack_bus = [b for b, info in self.buses.items() if info['Type'] == 'slack'][0]

        # -------------------------
        # Variables (all in kW except angles)
        # -------------------------
        model.Pshed = pyo.Var(model.T, model.B, within=pyo.NonNegativeReals)

        # Voltage angles in radians (unbounded is also OK but keep reasonable bounds)
        model.theta = pyo.Var(model.T, model.B, bounds=(-np.pi, np.pi))

        # Line flows in kW (will convert to/from per-unit internally)
        # Individual line limits will be enforced with constraints below.
        model.P_line = pyo.Var(model.T, model.L, bounds=(-self.grid_limit, self.grid_limit))

        # Grid import/export in kW (single global grid interaction at slack bus)
        model.P_grid_import = pyo.Var(model.T, bounds=(0, self.grid_limit))
        model.P_grid_export = pyo.Var(model.T, bounds=(0, self.grid_limit))

        # LEC import/export in kW for every bus (but only LEC buses will appear in objective/constraints)
        model.P_dso_import = pyo.Var(model.T, model.B, bounds=(0, self.grid_limit))
        model.P_dso_export = pyo.Var(model.T, model.B, bounds=(0, self.grid_limit))

        # -------------------------
        # Objective function
        # -------------------------
        def obj_rule(m):
            # Load shedding cost
            Pshed_cost = sum(m.Pshed[t, b] * self.VOLL for t in m.T for b in m.B)

            # ADMM-like penalty for LEC deviations (only for LEC buses)
            penalty_cost = (sum(self.flex_price[t, b]*(m.P_dso_import[t, b] - m.P_dso_export[t, b])
                               for t in m.T for b in self.lecs) +
                            (self.roh / 2) * sum(((self.P_lec_imp.get((t, b), 0.0)-self.P_lec_exp.get((t, b), 0.0))
                                 +(m.P_dso_import[t, b] - m.P_dso_export[t, b]))**2 for t in m.T for b in self.lecs))

            return Pshed_cost + penalty_cost

        model.obj = pyo.Objective(rule=obj_rule, sense=pyo.minimize)

        # -------------------------
        # Constraints
        # -------------------------

        # Fix slack bus angle to zero
        def slack_angle_rule(m, t):
            return m.theta[t, slack_bus] == 0
        model.slack_angle = pyo.Constraint(model.T, rule=slack_angle_rule)

        # DC power flow equations: P_kW = (θ_from - θ_to) / X_pu * S_base_kW
        def line_flow_rule(m, t, l):
            line_data = self.lines[l]
            X_pu = line_data['X_pu']
            # protect against zero reactance
            if abs(X_pu) < 1e-12:
                return pyo.Constraint.Skip
            theta_from = m.theta[t, line_data['from']]
            theta_to = m.theta[t, line_data['to']]
            return m.P_line[t, l] == ((theta_from - theta_to) / X_pu) * self.S_base_kW
        model.line_flow = pyo.Constraint(model.T, model.L, rule=line_flow_rule)

        # Line flow limits (use per-line Pline_limit, they are in kW already)
        def line_flow_limit_rule_upper(m, t, l):
            return m.P_line[t, l] <= self.lines[l]['Pline_limit']
        model.line_flow_limit_upper = pyo.Constraint(model.T, model.L, rule=line_flow_limit_rule_upper)

        def line_flow_limit_rule_lower(m, t, l):
            return m.P_line[t, l] >= -self.lines[l]['Pline_limit']
        model.line_flow_limit_lower = pyo.Constraint(model.T, model.L, rule=line_flow_limit_rule_lower)

        # Power balance at each bus (all in kW)
        def power_balance_rule(m, t, b):
            # Generation at slack bus represented by grid import-export at slack
            P_gen = (m.P_grid_import[t] - m.P_grid_export[t]) if b == slack_bus else 0.0

            # Load (after shedding)
            P_load = self.loads.get((b, t), 0.0)

            # Shedding power
            P_shed = m.Pshed[t, b]

            # LEC net power (import - export) only if bus is a LEC
            P_lec = (m.P_dso_export[t, b] - m.P_dso_import[t, b]) if (b in self.lecs) else 0.0

            # Net line flow (positive = leaving bus)
            line_sum = sum(
                (m.P_line[t, l] if self.lines[l]['from'] == b else
                 -m.P_line[t, l] if self.lines[l]['to'] == b else 0)
                for l in self.lines.keys()
            )

            # Power balance: generation - (load - shed) - LEC = net outflow
            return P_gen - (P_load - P_shed) - P_lec == line_sum

        model.power_balance = pyo.Constraint(model.T, model.B, rule=power_balance_rule)

        return model

    # -----------------------
    # Solve
    # -----------------------
    def solve_dc_opf(self, solver_name='glpk', verbose=False):
        """
        Solve the DC OPF problem

        Parameters:
        -----------
        solver_name : str
            Solver to use (default 'glpk')
        verbose : bool
            Print solver output (default False)

        Returns:
        --------
        dict : Solution with all results in kW
        """
        model = self.build_dc_opf()
        solver = pyo.SolverFactory('cplex')

        if not solver.available():
            raise RuntimeError(f"Solver '{'cplex'}' is not available on this system.")

        res = solver.solve(model, tee=verbose)

        if res.solver.termination_condition != pyo.TerminationCondition.optimal:
            print(f"Warning: Solver status = {res.solver.status}")
            print(f"Termination condition = {res.solver.termination_condition}")

        # Extract results (all in kW)
        P_line = {(t, l): pyo.value(model.P_line[t, l]) for t in model.T for l in model.L}
        P_grid_import = {t: pyo.value(model.P_grid_import[t]) for t in model.T}
        P_grid_export = {t: pyo.value(model.P_grid_export[t]) for t in model.T}
        P_dso_import = {(t, b): pyo.value(model.P_dso_import[t, b]) for t in model.T for b in self.lecs.keys()}
        P_dso_export = {(t, b): pyo.value(model.P_dso_export[t, b]) for t in model.T for b in self.lecs.keys()}
        theta = {(t, b): pyo.value(model.theta[t, b]) for t in model.T for b in model.B}
        Pshed = {(t, b): pyo.value(model.Pshed[t, b]) for t in model.T for b in model.B}

        return {
            'P_line': P_line,  # kW
            'P_grid_import': P_grid_import,  # kW
            'P_grid_export': P_grid_export,  # kW
            'P_dso_import': P_dso_import,  # kW
            'P_dso_export': P_dso_export,  # kW
            'theta': theta,  # radians
            'Pshed': Pshed,  # kW
            'objective': pyo.value(model.obj),  # $
            'solver_res': res
        }

    def get_results_dataframe(self, results):
        """Convert results dictionary to pandas DataFrame"""
        T = self.T

        data = {
            'Time': list(range(T)),
            'P_grid_import': [results['P_grid_import'][t] for t in range(T)],
            'P_grid_export': [results['P_grid_export'][t] for t in range(T)],
            'Net_import_kW': [results['P_grid_import'][t] - results['P_grid_export'][t] for t in range(T)]
        }

        # Add line flows
        for line in self.lines:
            data[f'P_line_{line}_kW'] = [results['P_line'][(t, line)] for t in range(T)]

        # Add load shedding
        for bus in self.buses:
            data[f'Pshed_{bus}_kW'] = [results['Pshed'][(t, bus)] for t in range(T)]

        return pd.DataFrame(data)


# Example usage template
def example_usage():
    """Example of how to use the corrected DSO class"""

    T = 24

    # Flexibility price ($/kWh)
    flex_price = [0.4] * T

    # Base power (kW) - keys are (t, bus)
    P_lec_imp = {}
    P_lec_exp = {}

    for t in range(T):
        for bus in ['B0', 'B1', 'B2']:
            if bus == 'B2':
                # LEC schedules (kW) - keys are (t, bus)
                P_lec_imp[(t, bus)] = 19.127
                P_lec_exp[(t, bus)] = 0.0
            else:
                P_lec_imp[(t, bus)] = 0.0
                P_lec_exp[(t, bus)] = 0.0

    VOLL = 1000  # $/kWh

    # Create DSO instance
    dso = DSO(flex_price, P_lec_imp, P_lec_exp, VOLL, roh=0.1)

    # Add buses
    bus_data = pd.DataFrame({
        'Bus': ['B0', 'B1', 'B2'],
        'Type': ['slack', 'PQ', 'PQ']
    })
    dso.add_buses(bus_data)

    # Add lines (reactance in ohms)
    line_data = pd.DataFrame({
        'From': ['B0', 'B0'],
        'To':   ['B1', 'B2'],
        'X_ohm': [0.1, 0.15],
        'Pline_limit': [5000, 18]
    })
    dso.add_lines(line_data)

    # Add loads (kW)
    load_dict = {'Bus': ['B0', 'B1', 'B2']}
    for t in range(T):
        load_dict[t] = [0, 0, 0]
    load_data = pd.DataFrame(load_dict)
    dso.add_loads(load_data)

    # Define LEC buses
    dso.add_lecs(['B2'])

    # Set limits
    dso.set_grid_limit(p_grid_limit=10000)

    # Solve (use glpk by default here; change to your available solver)
    results = dso.solve_dc_opf(solver_name='glpk', verbose=True)

    # Get results as DataFrame
    df_results = dso.get_results_dataframe(results)

    print("\nResults Summary:")
    print(f"Objective: ${results['objective']:.2f}")
    print(f"Total Import: {sum(results['P_grid_import'].values()):.2f} kWh")
    print(f"Line power flows (sample): {list(results['P_line'].items())[:6]} kW")

    return dso, results, df_results


if __name__ == "__main__":
    dso, results, df_results = example_usage()
    print("\n", df_results.head())
    print("end")
