try:
    import Rhino.Geometry as rg
except ImportError:
    rg = None

# Valid owner constants
AKADEMISKA_HUS = "Akademiska Hus"
STUDENTBOSTADER = "Studentbostäder"
CHALMERSFASTIGHETER = "Chalmersfastigheter"

class ChargePoint:
    """An EV Charge Point object for Grasshopper use (ECOM4Future)."""

    VALID_OWNERS = [AKADEMISKA_HUS, STUDENTBOSTADER, CHALMERSFASTIGHETER]

    def __init__(self, name, point, capacity, charger_type, is_v2g, owner, ev_list=None):
        self.name = str(name)
        self.point = point if (rg and isinstance(point, rg.Point3d)) else None
        self.capacity = float(capacity)  # kW
        self.charger_type = str(charger_type)
        self.is_v2g = bool(is_v2g)
        self.owner = self._validate_owner(owner)
        self.ev_list = ev_list if isinstance(ev_list, list) else ([ev_list] if ev_list else [])

        # Derived properties
        self.total_connected_evs = len(self.ev_list)
        self.v2g_enabled_evs = sum(1 for ev in self.ev_list if getattr(ev, "v2g_enabled", False))

        # Calculate hourly demand from connected EV (only one allowed)
        # This logic computes the charge point's hourly energy demand based on the EV's schedule and charging needs.
        # - If an EV is connected and V2G is enabled, it can charge up to 120% of its daily energy requirement.
        # - If V2G is not enabled, it can charge up to 100% of its daily energy requirement.
        # - Charging is distributed over the hours when the EV is available (schedule == 1),
        #   but never exceeds the charge point's or EV's max charging power per hour.
        # - Charging stops for the day once the daily max is reached.
        # - If no EV is connected, or daily requirement is zero, demand is zero for all hours.
        from ECOMToolkit.analysis.data import HourlyData, DataCategory, DataUnit
        import numpy as np
        import pandas as pd
        hoys_full = pd.Series(range(1, 8761))
        hourly_demand_arr = np.zeros(8760)
        if self.ev_list and len(self.ev_list) == 1:
            ev = self.ev_list[0]
            # Get EV schedule (HourlyData, 8760 binary values)
            schedule = ev.schedule.df['value'].values.astype(int)
            # Use the lower of charge point capacity and EV max charging power
            max_power = min(self.capacity, getattr(ev, "max_charging_power", self.capacity))
            # Daily energy requirement (kWh)
            daily_req = getattr(ev, "daily_energy_demand", 0)
            # Set daily max: 120% if V2G enabled, else 100%
            if getattr(ev, "v2g_enabled", False):
                daily_max = 1.2 * daily_req if daily_req else 0
            else:
                daily_max = daily_req if daily_req else 0
            # Loop over each day of the year (365 days)
            for day in range(365):
                start = day * 24
                end = start + 24
                # Get schedule for the current day (24 hours)
                sched_day = schedule[start:end]
                # Count how many hours the EV is available for charging
                hours_on = np.sum(sched_day)
                if hours_on > 0 and daily_max > 0:
                    # Distribute daily_max over scheduled hours, but not exceeding max_power per hour
                    per_hour = min(max_power, daily_max / hours_on)
                    charged = 0  # Track cumulative energy charged for the day
                    for i in range(24):
                        idx = start + i
                        # If EV is available and daily max not yet reached
                        if sched_day[i] and charged < daily_max:
                            # Charge either per_hour or remaining needed to reach daily_max
                            charge = min(per_hour, daily_max - charged)
                            hourly_demand_arr[idx] = charge
                            charged += charge
                        else:
                            # Not available or already reached daily max
                            hourly_demand_arr[idx] = 0
                else:
                    # No available hours or no daily requirement: no charging for this day
                    hourly_demand_arr[start:end] = 0
        # Create HourlyData object for charge point demand (kWh per hour)
        df_hourly = pd.DataFrame({'hoy': hoys_full, 'value': hourly_demand_arr})
        self.hourlydemand = HourlyData(
            df_hourly,
            meta={'type': 'charge_point_demand'},
            title=f'Charge Point Hourly Demand ({self.name})',
            source='ChargePoint Entity',
            units=DataUnit.KILOWATT_HOUR,
            category=DataCategory.ENERGY
        )

    def _validate_owner(self, owner):
        if owner not in self.VALID_OWNERS:
            raise ValueError(f"Invalid owner '{owner}'. Must be one of: {self.VALID_OWNERS}")
        return owner

    def validate(self):
        if not self.name:
            return "Error: Charge Point name is missing."
        # Only require geometry when Rhino is actually available. Outside Rhino
        # (dashboard backend) self.point is always None, and callers supply
        # coordinates separately, so this would fail every charge point.
        if rg is not None and not self.point:
            return "Error: Valid Rhino Point3d required."
        if self.capacity <= 0:
            return "Error: Charger capacity must be greater than 0 kW."
        return "Charge Point '{}' is valid ({} kW, {} EVs connected, Owner: {}).".format(
            self.name, self.capacity, self.total_connected_evs, self.owner)

    def __repr__(self):
        return ("Charge Point: {}\n"
                "Location: {}\n"
                "Capacity: {:.1f} kW | Type: {} | V2G: {}\n"
                "Owner: {}\n"
                "Connected EVs: {} ({} V2G-enabled)"
                .format(
                    self.name,
                    (self.point.X, self.point.Y, self.point.Z) if self.point else "N/A",
                    self.capacity,
                    self.charger_type,
                    self.is_v2g,
                    self.owner,
                    self.total_connected_evs,
                    self.v2g_enabled_evs
                ))
