#! python3
# r: pandas

try:
    import Rhino.Geometry as rg
except ImportError:
    rg = None
import math, urllib.request, urllib.parse, json
import pandas as pd

from ECOMToolkit.entities.pv_module import PVModule
from ECOMToolkit.analysis.data import HourlyData, DataUnit, DataCategory

# Seconds to wait for PVGIS before giving up.
PVGIS_TIMEOUT_SECONDS = 30

# Optional callable(plant) -> (DataFrame, annual_production). When set, it
# replaces the live PVGIS request entirely. The dashboard backend installs one
# that caches a per-kWp profile per orientation and scales it, so changing plant
# size costs no network round trip.
PVGIS_PROVIDER = None


class PVPlant:
    """
    Represents a photovoltaic (PV) plant, including geometry, module configuration, and energy estimation.
    """
    DEFAULT_NAME = "Default PV Plant"
    DEFAULT_PERCENTAGE = 80.0
    DEFAULT_SYSTEM_LOSS = 14.0
    DEFAULT_LAT = 57.688730
    DEFAULT_LON = 11.977887

    def __init__(
        self,
        name: str = None,
        surface=None,
        pv_module=None,
        percentage: float = None,
        system_loss: float = None,
        lat: float = None,
        lon: float = None,
        custom_slope: float = None,
        custom_azimuth: float = None
    ):
        # Set defaults if not provided
        if name is None:
            name = self.DEFAULT_NAME
        if percentage is None:
            percentage = self.DEFAULT_PERCENTAGE
        if system_loss is None:
            system_loss = self.DEFAULT_SYSTEM_LOSS
        if lat is None:
            lat = self.DEFAULT_LAT
        if lon is None:
            lon = self.DEFAULT_LON
        if pv_module is None:
            pv_module = PVModule()

        self.name: str = str(name)
        self.surface = surface
        self.pv_module = pv_module
        self.percentage: float = float(percentage)
        self.system_loss: float = float(system_loss)  # % (e.g., 14)
        self.lat: float = float(lat)
        self.lon: float = float(lon)
        self.custom_slope: float = custom_slope
        self.custom_azimuth: float = custom_azimuth

        # Surface area and usable area
        self.total_surface = self._get_surface_area(surface)
        self.usable_surface = self.total_surface * (self.percentage / 100.0)

        # Orientation
        detected_slope, detected_azimuth = self._get_orientation(surface)
        self.slope = float(self.custom_slope) if self.custom_slope is not None else detected_slope
        # Without Rhino geometry _get_orientation returns (0, 0), i.e. flat and
        # due south, so custom_azimuth is the only way to orient a plant.
        self.azimuth = float(self.custom_azimuth) if self.custom_azimuth is not None else detected_azimuth

        # Installed modules and power
        self.module_count = int(self.usable_surface // self.pv_module.area)
        self.installed_capacity = (self.module_count * self.pv_module.rating) / 1000.0  # kW

        # Total cost & embodied CO2
        self.total_cost = self.module_count * self.pv_module.total_cost
        self.total_embodied_co2 = self.module_count * self.pv_module.total_embodied_co2

        # Production estimation from PVGIS. Stays None on success; set to the
        # error text when the query fails, so zero production can be told apart
        # from a failed lookup.
        self.pvgis_error = None
        df, _ = self._get_pvgis_data()
        # Ensure 'value' is numeric before dividing
        if not df.empty and 'value' in df.columns:
            df["value"] = pd.to_numeric(df["value"], errors="coerce") / 1000.0  # kWh
        # Ensure only 'hoy' and 'value' columns are present
        if not df.empty:
            df = df[[col for col in ['hoy', 'value'] if col in df.columns]]
        else:
            # No PVGIS data, because capacity is zero or the query failed.
            # HourlyData rejects a frame without 'hoy'/'value', so an empty one
            # would abort construction with a message about DataFrame columns.
            # Produce an explicit zero-production year instead; pvgis_error
            # distinguishes a failed lookup from a genuinely empty plant.
            df = pd.DataFrame({'hoy': range(1, 8761), 'value': [0.0] * 8760})
        annual_production = df["value"].sum() if not df.empty and 'value' in df.columns else 0.0
        self.hourly_result = HourlyData(
            df=df,
            units=DataUnit.KILOWATT_HOUR,
            category=DataCategory.ENERGY,
            meta={"annual_production": annual_production, "plant_name": self.name},
            title=f"Hourly PV Production for {self.name}",
            source=self.name
        )
        self.hourly_df = df
        self.annual_production = annual_production




    def _get_surface_area(self, surface) -> float:
        """
        Calculate the surface area of the given geometry.
        Returns 0 if the type is unsupported or invalid.
        """
        # Accept a plain number as an explicit area in m2, so the class is usable
        # outside Rhino where there is no geometry to measure.
        if isinstance(surface, (int, float)) and not isinstance(surface, bool):
            return float(surface)
        if rg is not None:
            if isinstance(surface, rg.Brep):
                return rg.AreaMassProperties.Compute(surface).Area
            elif isinstance(surface, rg.Surface):
                brep = rg.Brep.CreateFromSurface(surface)
                return rg.AreaMassProperties.Compute(brep).Area
        return 0.0

    def _get_orientation(self, surface) -> tuple:
        """
        Returns (slope, azimuth) in degrees for the given surface.
        """
        # Without Rhino geometry there is no normal to read. Callers outside Rhino
        # should pass custom_slope (and accept the default south-facing azimuth).
        if rg is not None and isinstance(surface, rg.Brep):
            normal = surface.Faces[0].NormalAt(0.5, 0.5)
        elif rg is not None and isinstance(surface, rg.Surface):
            centroid = rg.AreaMassProperties.Compute(surface).Centroid
            _, u, v = surface.ClosestPoint(centroid)
            normal = surface.NormalAt(u, v)
        else:
            return 0.0, 0.0
        normal.Unitize()
        if normal.Z < 0:
            normal.Reverse()
        slope = math.degrees(math.acos(abs(normal.Z)))
        azimuth = math.degrees(math.atan2(normal.X, normal.Y))
        if azimuth < 0:
            azimuth += 360
        return slope, azimuth

    def _get_pvgis_data(self) -> tuple:
        """
        Query PVGIS API for hourly production data and annual sum.
        Returns (DataFrame, annual_production_kWh).
        """
        if self.installed_capacity <= 0:
            return pd.DataFrame(), 0.0

        # A host application (e.g. the dashboard backend) can install a provider
        # to add caching, offline data or request throttling. It receives this
        # plant and returns (DataFrame, annual_production) just like a live call.
        if PVGIS_PROVIDER is not None:
            return PVGIS_PROVIDER(self)

        base_url = "https://re.jrc.ec.europa.eu/api/v5_2/seriescalc"
        peakpower = max(self.installed_capacity, 0.01)  # PVGIS min 0.01 kW

        # Convert azimuth to PVGIS convention (0 = South, [-180, 180])
        pvgis_aspect = ((self.azimuth + 180) % 360) - 180

        params = {
            "lat": self.lat,
            "lon": self.lon,
            "pvcalculation": 1,
            "peakpower": peakpower,
            "loss": self.system_loss,  # already in %
            "angle": self.slope,
            "aspect": pvgis_aspect,
            "outputformat": "json",
            "startyear": 2020,
            "endyear": 2020
        }

        url_params = urllib.parse.urlencode(params)
        full_url = f"{base_url}?{url_params}"
        print(f"PVGIS API URL: {full_url}")

        try:
            print(f"Requesting PVGIS URL: {full_url}")
            # Without a timeout a slow PVGIS blocks the caller indefinitely.
            response = urllib.request.urlopen(full_url, timeout=PVGIS_TIMEOUT_SECONDS)
            data = json.loads(response.read().decode("utf-8"))
            print(f"PVGIS response keys: {list(data.keys())}")
            if 'outputs' in data and 'hourly' in data['outputs']:
                hourly = data["outputs"]["hourly"]
                print(f"Number of hourly records: {len(hourly)}")
                if len(hourly) > 0:
                    print(f"First hourly record: {hourly[0]}")
                df = pd.DataFrame(hourly)
                print(f"DataFrame columns: {df.columns.tolist()}")

                # Remove Feb 29th hours if present (leap years)
                if "time" in df.columns:
                    # PVGIS time format: YYYYMMDD:HHMM
                    df = df[~df["time"].str.startswith(tuple([f"{y}0229" for y in df["time"].str[:4].unique()]))]
                    df = df.reset_index(drop=True)
                # Only keep the 'P' column, rename to 'value', and add 'hoy' (hour of year)
                df = df[["P"]].rename(columns={"P": "value"})
                df.insert(0, "hoy", range(1, len(df) + 1))
                annual_production = df["value"].sum()
                return df, annual_production
            else:
                print("PVGIS response does not contain expected 'outputs'->'hourly' structure.")
                return pd.DataFrame(), 0.0

        except Exception as e:
            # Returning zeros here is indistinguishable from a plant that
            # genuinely produces nothing, so record why for callers that check.
            self.pvgis_error = str(e)
            print(f"PVGIS API error: {e}")
            return pd.DataFrame(), 0.0

    def validate(self) -> str:
        """
        Validate the PVPlant configuration. Returns a string with the result.
        """
        if not self.name:
            return "Error: Missing name"
        if self.total_surface <= 0:
            return "Error: Surface area <= 0"
        if self.percentage <= 0 or self.percentage > 100:
            return "Error: Percentage must be 0-100"
        if self.module_count <= 0:
            return "Warning: Not enough surface for modules"
        return f"PV Plant '{self.name}' valid: {self.module_count} modules, {self.annual_production:.1f} kWh/year."

    def __repr__(self) -> str:
        """
        String representation of the PVPlant.
        """
        return f"PVPlant: {self.name} | {self.installed_capacity:.1f} kW | {self.annual_production:.0f} kWh/year"
