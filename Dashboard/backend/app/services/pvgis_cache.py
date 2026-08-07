"""Cached PVGIS lookups, normalised per kWp.

PVGIS output is linear in `peakpower`: doubling installed capacity doubles every
hourly value. So the yield profile depends only on the *orientation* - latitude,
longitude, tilt, azimuth and system loss - not on plant size.

This module queries once per orientation, stores the profile scaled to 1 kWp,
and multiplies by capacity on use. Changing a plant's area, coverage percentage
or panel type then costs no network round trip, which is what makes the
dashboard's sliders usable.

Install it with `install_provider()` before building any PVPlant.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pandas as pd

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path

from ECOMToolkit.entities import pv_plant as pv_plant_module

HOURS_PER_YEAR = 8760
_CACHE_VERSION = 1


class PVGISUnavailable(RuntimeError):
    """PVGIS could not be reached and no cached profile exists.

    Raised rather than returning zeros, because a plant reporting no production
    is indistinguishable from a real result once it reaches the dashboard.
    """


@dataclass(frozen=True)
class Orientation:
    lat: float
    lon: float
    slope: float
    azimuth: float
    system_loss: float

    def key(self) -> str:
        return "v{}_{:.4f}_{:.4f}_{:.1f}_{:.1f}_{:.1f}".format(
            _CACHE_VERSION, self.lat, self.lon, self.slope, self.azimuth, self.system_loss
        ).replace("-", "m")


class PVGISCache:
    def __init__(self, cache_dir: Path, allow_network: bool = True):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.allow_network = allow_network
        self._memory: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self.stats = {"memory_hits": 0, "disk_hits": 0, "network_calls": 0}

    # ---------------------------------------------------------------- lookup

    def profile_per_kwp(self, orientation: Orientation) -> list[float]:
        """Hourly production for a 1 kWp plant at this orientation, in Wh."""
        key = orientation.key()

        with self._lock:
            if key in self._memory:
                self.stats["memory_hits"] += 1
                return self._memory[key]

        path = self.cache_dir / f"{key}.json"
        if path.is_file():
            values = json.loads(path.read_text(encoding="utf-8"))["values"]
            with self._lock:
                self._memory[key] = values
                self.stats["disk_hits"] += 1
            return values

        if not self.allow_network:
            raise PVGISUnavailable(
                f"No cached PVGIS profile for {orientation} and network access is "
                f"disabled. Warm the cache first, or set allow_network=True."
            )

        values = self._fetch_per_kwp(orientation)
        path.write_text(
            json.dumps({"orientation": orientation.__dict__, "values": values}),
            encoding="utf-8",
        )
        with self._lock:
            self._memory[key] = values
            self.stats["network_calls"] += 1
        return values

    def _fetch_per_kwp(self, orientation: Orientation) -> list[float]:
        """One live PVGIS query at 1 kWp, via the toolkit's own request code."""
        probe = _OrientationProbe(orientation)
        # Temporarily clear the provider so the toolkit performs a real request
        # instead of recursing back into this cache.
        previous = pv_plant_module.PVGIS_PROVIDER
        pv_plant_module.PVGIS_PROVIDER = None
        try:
            df, _ = pv_plant_module.PVPlant._get_pvgis_data(probe)
        finally:
            pv_plant_module.PVGIS_PROVIDER = previous

        if df is None or df.empty or "value" not in df.columns:
            raise PVGISUnavailable(
                f"PVGIS returned no usable data for {orientation}"
                + (f": {probe.pvgis_error}" if probe.pvgis_error else "")
            )

        values = [float(v) for v in df["value"].tolist()]
        if len(values) != HOURS_PER_YEAR:
            raise PVGISUnavailable(
                f"PVGIS returned {len(values)} hourly values for {orientation}, "
                f"expected {HOURS_PER_YEAR}"
            )
        return values

    # ---------------------------------------------------------------- provider

    def provider(self):
        """Return a callable suitable for ECOMToolkit's PVGIS_PROVIDER hook."""

        def _provide(plant) -> tuple[pd.DataFrame, float]:
            orientation = Orientation(
                lat=float(plant.lat),
                lon=float(plant.lon),
                slope=float(plant.slope),
                azimuth=float(plant.azimuth),
                system_loss=float(plant.system_loss),
            )
            per_kwp = self.profile_per_kwp(orientation)
            capacity = float(plant.installed_capacity)
            scaled = [v * capacity for v in per_kwp]
            df = pd.DataFrame({"hoy": range(1, len(scaled) + 1), "value": scaled})
            return df, float(sum(scaled))

        return _provide

    def install_provider(self) -> None:
        pv_plant_module.PVGIS_PROVIDER = self.provider()


def uninstall_provider() -> None:
    pv_plant_module.PVGIS_PROVIDER = None


class _OrientationProbe:
    """Minimal stand-in exposing exactly what _get_pvgis_data reads.

    Avoids constructing a real PVPlant, which would itself trigger a query.
    """

    def __init__(self, orientation: Orientation):
        self.lat = orientation.lat
        self.lon = orientation.lon
        self.slope = orientation.slope
        self.azimuth = orientation.azimuth
        self.system_loss = orientation.system_loss
        self.installed_capacity = 1.0  # kWp - the normalisation basis
        self.pvgis_error: Optional[str] = None
