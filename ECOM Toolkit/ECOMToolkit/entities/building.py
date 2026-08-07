# Building: Honeybee-Compatible Building Entity (MIT)
# Version: 0.0.7 (Added Owner Input)
# Designed for use inside Grasshopper (GH) for Rhino by ECOM4Future

"""
Create a Honeybee-compatible Building object for energy community simulations.
"""

import os
import csv
try:
    import Rhino.Geometry as rg
except ImportError:
    rg = None

try:
    from honeybee.typing import clean_ep_string
    from honeybee.schedule.ruleset import ScheduleRuleset, ScheduleFixedInterval
    from honeybee_energy.lib.programtypes import program_types
except ImportError:
    clean_ep_string = lambda x: x
    ScheduleRuleset, ScheduleFixedInterval, program_types = None, None, []

try:
    import pandas as pd
except ImportError:
    pd = None

from ECOMToolkit.analysis.data import HourlyData

class Building:
    @property
    def electric_demand_from_program(self):
        """
        Returns HourlyData of absolute (kWh) electric demand for this building, using the program type and total built-up area.
        """
        frac = self.fractional_hourly_electric_demand
        if frac is None or self.area is None:
            return None
        # Convert W/m2 to kWh per hour: (W/m2 * total built-up area [m2]) / 1000 = kWh/h
        df = frac.df.copy()
        df['value'] = df['value'] * self.area / 1000.0
        return HourlyData(df, title=f"Electric Demand (program) for {self.name}", units="kWh", category=None)
    @staticmethod
    def _get_program(program):
        """
        Accepts only a string identifier and returns a ProgramType object.
        Prints errors if import or lookup fails, or if input is not a string.
        """
        import traceback
        try:
            from honeybee_energy.lib.programtypes import program_type_by_identifier, building_program_type_by_identifier
            if isinstance(program, str):
                try:
                    return building_program_type_by_identifier(program)
                except ValueError:
                    return program_type_by_identifier(program)
            else:
                print(f"[ERROR] _get_program: Input must be a string identifier, got {type(program)}")
                return None
        except Exception as e:
            print(f"[ERROR] _get_program failed: {e}\n{traceback.format_exc()}")
            return None

    @staticmethod
    def _schedule_to_annual(schedule, timestep=1):
        import traceback
        try:
            from honeybee_energy.schedule.ruleset import ScheduleRuleset
            from honeybee_energy.lib.schedules import schedule_by_identifier
            from ladybug.dt import Date
            import pandas as pd
            start_date = Date(1, 1)
            end_date = Date(12, 31)
            if isinstance(schedule, str):
                schedule = schedule_by_identifier(schedule)
            if isinstance(schedule, ScheduleRuleset):
                data = schedule.data_collection(timestep, start_date, end_date)
            else:
                data = schedule.data_collection_at_timestep(timestep, start_date, end_date)
            return data.values
        except Exception as e:
            print(f"[ERROR] _schedule_to_annual failed: {e}\n{traceback.format_exc()}")
            return None

    @staticmethod
    def _combined_load_df(program):
        import traceback
        try:
            import pandas as pd
            prog = Building._get_program(program)
            if not prog:
                print(f"[ERROR] _combined_load_df: Could not get program for {program}")
                return None
            lighting = prog.lighting
            equipment = prog.electric_equipment
            lighting_values = Building._schedule_to_annual(lighting.schedule)
            equipment_values = Building._schedule_to_annual(equipment.schedule)
            if lighting_values is None or equipment_values is None:
                print(f"[ERROR] _combined_load_df: Could not get lighting/equipment values for {program}")
                return None
            total_w_per_m2 = [l + e for l, e in zip(lighting_values, equipment_values)]
            df = pd.DataFrame({
                "hoy": list(range(1, len(total_w_per_m2) + 1)),
                "value": total_w_per_m2
            })
            return df
        except Exception as e:
            print(f"[ERROR] _combined_load_df failed: {e}\n{traceback.format_exc()}")
            return None

    def _fractional_hourly_electric_demand(self):
        df = self._combined_load_df(self.building_type)
        if df is not None:
            return HourlyData(df, title=f"Fractional Electric Demand for {self.name}", units="W/m2", category=None)
        return None

    @property
    def fractional_hourly_electric_demand(self):
        """Returns HourlyData of fractional (W/m2) electric demand for this building type."""
        return self._fractional_hourly_electric_demand()
    """A Honeybee-compatible Building entity for energy community modeling."""

    VALID_OWNERS = ["Akademiska Hus", "Studentbostäder", "Chalmersfastigheter"]

    def __init__(self, name, footprints, building_type, occupancy_schedule,
                 electric_demand,
                 PV_plant=None, owner=None, convert_schedule_to_df=False, breps=None, number_of_floors=None, point=None):

        # footprints: list of curves/surfaces/breps; breps: list of breps (optional)
        self.area = 0.0

        self.name = clean_ep_string(name)
        # Accept a plain number as an explicit footprint area in m2, so the class
        # is usable outside Rhino where there is no geometry to measure. It is
        # multiplied by number_of_floors exactly like a measured footprint.
        self._explicit_footprint_area = None
        if isinstance(footprints, (int, float)) and not isinstance(footprints, bool):
            self._explicit_footprint_area = float(footprints)

        # Accept single or list for footprints
        if self._explicit_footprint_area is not None:
            self.footprints = []
        elif rg:
            if isinstance(footprints, (rg.Brep, rg.Surface, rg.Curve)):
                self.footprints = [footprints]
            elif isinstance(footprints, list):
                self.footprints = [f for f in footprints if isinstance(f, (rg.Brep, rg.Surface, rg.Curve))]
            else:
                self.footprints = []
        else:
            self.footprints = []

        # Accept single or list for breps
        if rg:
            if breps is not None:
                if isinstance(breps, rg.Brep):
                    self.breps = [breps]
                elif isinstance(breps, list):
                    self.breps = [b for b in breps if isinstance(b, rg.Brep)]
                else:
                    self.breps = []
            else:
                # fallback: extract breps from footprints
                self.breps = [f for f in self.footprints if isinstance(f, rg.Brep)]
        else:
            self.breps = []

        self.number_of_floors = number_of_floors
        if self._explicit_footprint_area is not None:
            floors = number_of_floors if isinstance(number_of_floors, (int, float)) and number_of_floors else 1
            self.area = self._explicit_footprint_area * float(floors)
        else:
            self.area = self._calc_area_from_footprints(self.footprints, self.number_of_floors)

        self.building_type = self._validate_building_type(building_type)
        self.occupancy_schedule = self._validate_schedule(occupancy_schedule, convert_schedule_to_df)
        self.electric_demand = self._parse_electric_demand(electric_demand)
        self.owner = self._validate_owner(owner)


        self.PV_plant = PV_plant if isinstance(PV_plant, list) else ([PV_plant] if PV_plant else [])

        # Derived properties
        self.total_energy_demand = self._calc_total_energy_demand()
        self.total_pv_capacity = self._calc_total_pv_capacity()
        self.total_installed_capacity = self.total_pv_capacity
        self.point = point if (rg and isinstance(point, rg.Point3d)) else None
        self.x = self.point.X if self.point else None
        self.y = self.point.Y if self.point else None


    def _calc_area_from_footprints(self, footprints, number_of_floors=None):
        """
        Calculates the total built-up area by multiplying each footprint's area by its corresponding number_of_floors from the provided list.
        If number_of_floors is not provided or is shorter than footprints, defaults to 0 for missing entries.
        """
        if not rg or not footprints:
            return 0.0
        total_area = 0.0
        if number_of_floors is None:
            number_of_floors = [0] * len(footprints)
        for i, fp in enumerate(footprints):
            # Use number_of_floors from the provided list, default 0 if not enough entries
            try:
                num_floors = number_of_floors[i] if i < len(number_of_floors) else 0
                num_floors = int(num_floors)
            except Exception as e:
                print(f"Error reading number_of_floors for footprint {i}: {e}")
                num_floors = 0
            # Calculate footprint area
            footprint_area = 0.0
            if isinstance(fp, rg.Brep):
                footprint_area = sum([f.Area for f in fp.Faces])
            elif isinstance(fp, rg.Surface):
                footprint_area = rg.AreaMassProperties.Compute(fp).Area
            elif isinstance(fp, rg.Curve):
                if fp.IsClosed:
                    amp = rg.AreaMassProperties.Compute(fp)
                    if amp:
                        footprint_area = amp.Area
            total_area += footprint_area * num_floors
        return total_area

    def _validate_owner(self, owner):
        if owner not in self.VALID_OWNERS:
            raise ValueError(f"Invalid owner '{owner}'. Must be one of: {self.VALID_OWNERS}")
        return owner

    def _validate_building_type(self, bld_type):
        try:
            from honeybee_energy.programtype import ProgramType
            if isinstance(bld_type, ProgramType):
                return bld_type
        except ImportError:
            pass
        hb_types = [pt.identifier for pt in program_types] if program_types else []
        if hb_types and bld_type not in hb_types:
            raise ValueError(f"Building type '{bld_type}' not in Honeybee library.\nValid types: {hb_types[:10]}")
        return bld_type

    def _validate_schedule(self, schedule, convert_to_df):
        if ScheduleRuleset and ScheduleFixedInterval:
            if isinstance(schedule, (ScheduleRuleset, ScheduleFixedInterval)):
                if convert_to_df and pd:
                    return pd.DataFrame({"hour": range(8760), "value": schedule.values})
                return schedule
            raise TypeError("Occupancy schedule must be a Honeybee ScheduleRuleset or ScheduleFixedInterval.")
        return schedule

    def _parse_electric_demand(self, electric_demand):
        # Only accept HourlyData, list of 8760, or CSV with 8760 values
        if isinstance(electric_demand, HourlyData):
            hd = electric_demand
        elif isinstance(electric_demand, list):
            if len(electric_demand) != 8760:
                raise ValueError("Electric demand list must have exactly 8760 hourly values.")
            import pandas as pd
            df = pd.DataFrame({
                'hoy': range(1, 8761),
                'value': [float(v) for v in electric_demand]
            })
            hd = HourlyData(df, title=f"Electric Demand for {self.name}", units="kWh", category=None)
        elif isinstance(electric_demand, str) and os.path.isfile(electric_demand):
            hd = HourlyData.from_csv(electric_demand)
            hd.title = f"Electric Demand for {self.name}"
            hd.units = "kWh"
        else:
            raise ValueError("Electric demand must be HourlyData, a list of 8760 values, or a valid CSV file with 8760 values.")
        # Enrich HourlyData with meta info
        if hd:
            hd.meta['building'] = self.name
            hd.title = hd.title or f"Electric Demand for {self.name}"
            hd.units = hd.units or "kWh"
        return hd

    def _calc_total_energy_demand(self):
        if isinstance(self.electric_demand, list):
            return sum(self.electric_demand)
        elif hasattr(self.electric_demand, "df"):
            # Sum the 'value' column of the HourlyData DataFrame
            return float(self.electric_demand.df['value'].sum())
        else:
            return float(self.electric_demand)

    def _calc_total_pv_capacity(self):
        total = 0.0
        for pv in self.PV_plant:
            try:
                total += pv.installed_capacity
            except AttributeError:
                continue
        return total


    # Building no longer supports batteries. Battery capacity is managed at the community level.



    def validate(self):
        if not self.name:
            return "Error: Building name is missing."
        if not self.footprints or len(self.footprints) == 0:
            return "Error: At least one valid Rhino Brep, Surface, or Curve required."
        if self.total_energy_demand <= 0:
            return "Warning: Electric demand is 0 or not defined."
        return (f"Building '{self.name}' (Owner: {self.owner}) is valid ({self.total_energy_demand} kWh/year, PV: {self.total_pv_capacity:.1f} kW).")

    def __repr__(self):
        return ("Building: {}\n"
                "Owner: {}\n"
                "Type: {}\n"
                "Num Footprints: {}\n"
                "Total Area: {:.1f} m2\n"
                "Total Energy Demand: {:.1f} kWh/year\n"
                "Total PV Capacity: {:.1f} kWp"
                
                .format(
                    self.name,
                    self.owner,
                    self.building_type,
                    len(self.footprints),
                    self.area,
                    self.total_energy_demand,
                    self.total_pv_capacity,
                    
                ))
