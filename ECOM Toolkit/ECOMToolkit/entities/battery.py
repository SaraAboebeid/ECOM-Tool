try:
    import Rhino.Geometry as rg
except ImportError:
    rg = None

class Battery:
    """A Battery object for Grasshopper use (ECOM4Future)."""

    def __init__(self, name, capacity, point, cost, embodied_co2, efficiency, lifespan, degradation, initial_soc=None):
        self.name = str(name)
        self.capacity = float(capacity)  # kWh (initial capacity)
        self.point = point if (rg and isinstance(point, rg.Point3d)) else None
        self.cost_per_kwh = float(cost)  # SEK/kWh
        self.embodied_co2_per_kwh = float(embodied_co2)  # kgCO2e/kWh
        self.efficiency = float(efficiency)  # %
        self.lifespan = float(lifespan)  # years
        self.degradation = float(degradation) / 100.0  # convert % to decimal

        # Initial state of charge (SoC)
        if initial_soc is None:
            self.initial_soc = 0.0
        else:
            self.initial_soc = float(initial_soc)
        # Ensure initial_soc is within [0, capacity]
        if self.initial_soc < 0:
            print(f"[WARNING] Battery '{self.name}' initial_soc < 0. Setting to 0.")
            self.initial_soc = 0.0
        elif self.initial_soc > self.capacity:
            print(f"[WARNING] Battery '{self.name}' initial_soc > capacity. Setting to capacity.")
            self.initial_soc = self.capacity

        # Derived properties
        self.total_cost = self.capacity * self.cost_per_kwh
        self.total_embodied_co2 = self.capacity * self.embodied_co2_per_kwh

        # Degraded capacity after lifespan
        self.capacity_eol = max(self.capacity * (1 - self.degradation * self.lifespan), 0)
        self.average_capacity = (self.capacity + self.capacity_eol) / 2.0

        # Hourly state of charge (SoC) for 8760 hours using HourlyData
        try:
            from ECOMToolkit.analysis.data import HourlyData, DataUnit, DataCategory
        except ImportError:
            HourlyData = None
            DataUnit = None
            DataCategory = None
        import pandas as pd
        hoy = list(range(1, 8761))
        value = [self.initial_soc] * 8760
        df = pd.DataFrame({'hoy': hoy, 'value': value})
        meta = {'battery_name': self.name}
        title = f"Hourly State of Charge for {self.name}"
        source = self.name
        units = DataUnit.KILOWATT_HOUR if DataUnit is not None else "kWh"
        category = DataCategory.ENERGY if DataCategory is not None else "energy"
        if HourlyData is not None:
            self.hourly_soc = HourlyData(df, meta=meta, title=title, source=source, units=units, category=category)
        else:
            self.hourly_soc = df

    def validate(self):
        if not self.name:
            return "Error: Battery name is missing."
        if self.capacity <= 0:
            return "Error: Capacity must be greater than 0."
        if self.cost_per_kwh <= 0:
            return "Error: Cost must be greater than 0."
        if self.embodied_co2_per_kwh <= 0:
            return "Error: Embodied CO₂ must be greater than 0."
        if self.efficiency <= 0 or self.efficiency > 100:
            return "Error: Efficiency must be between 0 and 100."
        if self.lifespan <= 0:
            return "Error: Lifespan must be greater than 0."
        if self.degradation < 0 or self.degradation > 1:
            return "Error: Degradation must be between 0 and 100%."
        return "Battery '{}' is valid ({} kWh, {:.1f}% efficiency, lifespan {} years).".format(
            self.name, self.capacity, self.efficiency, self.lifespan)

    def __repr__(self):
        return ("Battery: {}\n"
                "Capacity: {:.1f} kWh (EoL: {:.1f} kWh after {} yrs)\n"
                "Efficiency: {:.1f}% | Avg Usable Capacity: {:.1f} kWh\n"
                "Total Cost: {:.2f} SEK\n"
                "Total Embodied CO₂: {:.2f} kgCO₂e"
                .format(self.name, self.capacity, self.capacity_eol, self.lifespan,
                        self.efficiency, self.average_capacity,
                        self.total_cost, self.total_embodied_co2))
