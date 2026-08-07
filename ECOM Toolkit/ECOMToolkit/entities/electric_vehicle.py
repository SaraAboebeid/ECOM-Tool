class ElectricVehicle:
    """
    An Electric Vehicle (EV) object for Grasshopper use (ECOM4Future).

    Attributes:
        name (str): Name of the EV.
        schedule (list[int]): List of 24 binary values (0/1) indicating hourly availability.
        capacity (float): Total battery capacity in kWh.
        is_hybrid (bool): True if the vehicle is a plug-in hybrid (PHEV), False if BEV.
        efficiency (float, optional): Energy consumption in kWh/100km.
        daily_distance (float, optional): Average daily driving distance in km.
        max_charging_power (float, optional): Maximum charging power in kW.
        v2g_enabled (bool): Whether vehicle-to-grid is enabled.
        embodied_co2_per_kwh (float, optional): Embodied CO₂ per kWh of battery (kgCO₂e/kWh).
        usable_capacity (float): Usable battery capacity in kWh (accounts for hybrid reserve).
        daily_energy_demand (float, optional): Estimated daily energy demand in kWh.
        total_embodied_co2 (float, optional): Total embodied CO₂ for the battery in kgCO₂e.
    """


    def __init__(self, name, schedule=None, capacity=None, is_hybrid=None,
                 efficiency=None, daily_distance=None, max_charging_power=None,
                 v2g_enabled=None, embodied_co2=None, analysis_period=None):
        """
        Initialize an ElectricVehicle instance.

        Args:
            name (str): Name of the EV.
            schedule (list[int] or int or float or str, optional): 24-value binary list or a single 0/1 value. Defaults to always available.
            capacity (float, optional): Battery capacity in kWh. Default 50.0.
            is_hybrid (bool, optional): True if PHEV, False if BEV. Default False.
            efficiency (float, optional): Consumption in kWh/100km. Default 16.0.
            daily_distance (float, optional): Daily driving distance in km. Default 35.0.
            max_charging_power (float, optional): Max charging power in kW. Default 3.7.
            v2g_enabled (bool, optional): Enable vehicle-to-grid. Default False.
            embodied_co2 (float, optional): Embodied CO₂ per kWh (kgCO₂e/kWh). Default 75.0.
            analysis_period (tuple or list, optional): (start_hoy, end_hoy) or list of hoys (integers) for analysis period. Default is full year.
        """

        self.name = str(name)  # Vehicle name
        # Prepare analysis period
        period_info = self._prepare_period(analysis_period)
        if isinstance(period_info, tuple):
            self.start_hour, self.end_hour = period_info
            self.hoys = list(range(self.start_hour, self.end_hour + 1))
        else:
            self.hoys = sorted(period_info)
            self.start_hour = min(self.hoys)
            self.end_hour = max(self.hoys)
        self.n_hours = len(self.hoys)

        # Prepare schedule as HourlyData, pad to 8760
        from ECOMToolkit.analysis.data import HourlyData, DataCategory, DataUnit
        import numpy as np
        import pandas as pd
        hoys_full = pd.Series(range(1, 8761))
        schedule_arr = self._prepare_schedule(schedule)
        full_schedule = np.zeros(8760, dtype=int)
        # If analysis period is a list of HOYs, set those indices
        for idx, hoy in enumerate(self.hoys):
            if 0 <= hoy < 8760:
                full_schedule[hoy] = schedule_arr[idx]
        df_schedule = pd.DataFrame({'hoy': hoys_full, 'value': full_schedule})
        self.schedule = HourlyData(
            df_schedule,
            meta={'type': 'availability'},
            title=f'EV Schedule ({self.name})',
            source='ElectricVehicle Entity',
            units=DataUnit.UNKNOWN,
            category=DataCategory.OTHER
        )

        self.capacity = float(capacity) if capacity is not None else 50.0  # Battery capacity (kWh)
        self.is_hybrid = bool(is_hybrid) if is_hybrid is not None else False  # Plug-in hybrid or BEV
        self.efficiency = float(efficiency) if efficiency is not None else 16.0  # kWh/100km
        self.daily_distance = float(daily_distance) if daily_distance is not None else 35.0  # km/day
        self.max_charging_power = float(max_charging_power) if max_charging_power is not None else 3.7  # kW
        self.v2g_enabled = bool(v2g_enabled) if v2g_enabled is not None else False  # Vehicle-to-grid enabled
        self.embodied_co2_per_kwh = float(embodied_co2) if embodied_co2 is not None else 75.0  # kgCO₂e/kWh

        # Usable capacity (PHEV reserves some for ICE)
        self.usable_capacity = self.capacity * (0.7 if self.is_hybrid else 1.0)  # kWh

        # Daily energy demand (kWh/day)
        self.daily_energy_demand = (self.efficiency * self.daily_distance) / 100.0 if self.efficiency and self.daily_distance else None

        # Total embodied CO2 (kgCO₂e)
        self.total_embodied_co2 = self.capacity * self.embodied_co2_per_kwh if self.embodied_co2_per_kwh else None

    def _prepare_schedule(self, schedule):
        """
        Convert schedule to an array matching the analysis period length.
        Accepts:
        - single value (0/1): fills analysis period with that value
        - list of 24: repeats for analysis period
        - list/array matching analysis period length: uses directly
        """
        DEFAULT_SCHEDULE = 1
        period_length = self.n_hours
        import numpy as np
        if schedule is None:
            return np.full(period_length, DEFAULT_SCHEDULE, dtype=int)
        if isinstance(schedule, (int, float, str)):
            try:
                value = int(float(schedule))
                if value in (0, 1):
                    return np.full(period_length, value, dtype=int)
            except Exception:
                pass
        if isinstance(schedule, list):
            arr = np.array(schedule, dtype=int)
            if arr.size == 24:
                # Repeat the 24h pattern for the analysis period
                reps = int(np.ceil(period_length / 24))
                arr = np.tile(arr, reps)[:period_length]
                return arr
            if arr.size == period_length:
                return arr
        if isinstance(schedule, np.ndarray):
            if schedule.size == 24:
                reps = int(np.ceil(period_length / 24))
                arr = np.tile(schedule, reps)[:period_length]
                return arr
            if schedule.size == period_length:
                return schedule
        raise ValueError("Schedule must be a single 0/1 value, a list/array of 24 binary values, or match the analysis period length.")

    def _prepare_period(self, period):
        """Accepts tuple (start, end) or list of hoys. Returns tuple or list of hoys."""
        if period is None:
            return 0, 8759
        if isinstance(period, tuple) and len(period) == 2 and all(isinstance(x, int) for x in period):
            return max(0, period[0]), min(period[1], 8759)
        if isinstance(period, list) and all(isinstance(x, int) for x in period):
            # Filter out-of-range HOYs
            hoys = [h for h in period if 0 <= h < 8760]
            if not hoys:
                raise ValueError("analysis_period list must contain at least one valid HOY (0..8759)")
            return hoys
        raise ValueError("analysis_period must be a tuple (start, end) or a list of HOYs (integers)")

    def validate(self):
        errors = []
        if not self.name:
            errors.append("Error: EV name is missing.")
        if self.capacity <= 0:
            errors.append("Error: Battery capacity must be greater than 0.")
        if self.schedule is None:
            errors.append("Error: Schedule is missing.")
        return errors if errors else f"EV '{self.name}' is valid ({self.capacity} kWh, {'Hybrid' if self.is_hybrid else 'BEV'} mode)."

    def __repr__(self):
        lines = [
            f"Electric Vehicle: {self.name}",
            f"  Type: {'Plug-in Hybrid (PHEV)' if self.is_hybrid else 'Battery Electric (BEV)'}",
            f"  Battery Capacity: {self.capacity:.1f} kWh",
            f"  Usable Capacity: {self.usable_capacity:.1f} kWh",
            f"  Efficiency: {self.efficiency:.1f} kWh/100km" if self.efficiency is not None else "  Efficiency: N/A",
            f"  Daily Distance: {self.daily_distance:.1f} km" if self.daily_distance is not None else "  Daily Distance: N/A",
            f"  Daily Energy Demand: {self.daily_energy_demand:.2f} kWh/day" if self.daily_energy_demand is not None else "  Daily Energy Demand: N/A",
            f"  Max Charging Power: {self.max_charging_power:.1f} kW" if self.max_charging_power is not None else "  Max Charging Power: N/A",
            f"  V2G Enabled: {'Yes' if self.v2g_enabled else 'No'}",
            f"  Embodied CO₂ per kWh: {self.embodied_co2_per_kwh:.1f} kgCO₂e/kWh" if self.embodied_co2_per_kwh is not None else "  Embodied CO₂ per kWh: N/A",
            f"  Total Embodied CO₂: {self.total_embodied_co2:.1f} kgCO₂e" if self.total_embodied_co2 is not None else "  Total Embodied CO₂: N/A",
            f"  Schedule (first 3): {self.schedule.df['value'][:3].tolist()} (HourlyData)",
            f"  Analysis period: {self.hoys if hasattr(self, 'hoys') and len(self.hoys) < 20 else f'{self.start_hour} to {self.end_hour}'}"
        ]
        return "\n".join(lines)
