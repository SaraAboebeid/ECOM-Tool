"""PV module and PV plant specifications."""
from __future__ import annotations

from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .common import Coordinates

# Gothenburg, matching PVPlant.DEFAULT_LAT / DEFAULT_LON.
DEFAULT_LAT = 57.688730
DEFAULT_LON = 11.977887


class PVModuleSpec(BaseModel):
    """A panel type. Defaults match PVModule's own defaults."""

    model_config = ConfigDict(extra="forbid")

    name: str = "Default 400W Panel"
    rating: Annotated[float, Field(gt=0)] = Field(400.0, description="Rated power at STC, W")
    size_x: Annotated[float, Field(gt=0)] = Field(1.0, description="Length, m")
    size_y: Annotated[float, Field(gt=0)] = Field(2.0, description="Width, m")
    cost_per_kwp: Annotated[float, Field(gt=0)] = Field(3100.0, description="SEK/kWp")
    embodied_co2_per_kwp: Annotated[float, Field(gt=0)] = Field(615.0, description="kgCO2e/kWp")

    @field_validator("cost_per_kwp")
    @classmethod
    def _avoid_unit_guessing(cls, v: float) -> float:
        # PVModule.__init__ does: cost_per_kwp = cost * 1000 if cost < 100 else cost
        # That heuristic guesses SEK/Wp vs SEK/kWp, and it is discontinuous: a
        # cost slider crossing 100 would jump the value by 1000x. Refuse the
        # ambiguous range rather than inherit the jump.
        if v < 100:
            raise ValueError(
                f"cost_per_kwp={v} is below 100, where PVModule silently "
                f"reinterprets the value as SEK/Wp and multiplies by 1000. "
                f"Give the cost in SEK/kWp (e.g. 3100)."
            )
        return v

    @property
    def area(self) -> float:
        return self.size_x * self.size_y

    # Previews, so the UI can show panel figures without building anything.
    @property
    def efficiency(self) -> float:
        """Percent, matching PVModule.efficiency."""
        return (self.rating / (self.area * 1000.0)) * 100.0

    @property
    def cost_per_panel(self) -> float:
        return (self.rating / 1000.0) * self.cost_per_kwp

    @property
    def embodied_co2_per_panel(self) -> float:
        return (self.rating / 1000.0) * self.embodied_co2_per_kwp


class PVPlantSpec(BaseModel):
    """A PV installation.

    Outside Rhino there is no surface to measure, so `surface_area` replaces the
    Brep and orientation must be given explicitly: PVPlant._get_orientation
    returns (0, 0) - flat, due south - when there is no geometry.
    """

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)]
    surface_area: Annotated[float, Field(gt=0)] = Field(
        description="Gross mounting surface in m2. Replaces the Rhino surface."
    )
    percentage: Annotated[float, Field(gt=0, le=100)] = Field(
        70.0, description="Percent of the surface actually covered in panels."
    )
    system_loss: Annotated[float, Field(ge=0, lt=100)] = Field(
        14.0, description="System losses in percent, passed to PVGIS."
    )

    slope: Annotated[float, Field(ge=0, le=90)] = Field(
        30.0, description="Tilt from horizontal in degrees. 0 is flat."
    )
    azimuth: Annotated[float, Field(ge=0, lt=360)] = Field(
        0.0, description="Compass bearing the panels face, degrees. 0 is due "
        "south, matching PVPlant's convention before PVGIS conversion.",
    )

    lat: float = DEFAULT_LAT
    lon: float = DEFAULT_LON

    module: PVModuleSpec = Field(default_factory=PVModuleSpec)
    location: Optional[Coordinates] = None

    @property
    def usable_area(self) -> float:
        return self.surface_area * (self.percentage / 100.0)

    @property
    def module_count(self) -> int:
        """Whole panels that fit. Mirrors PVPlant's floor division."""
        return int(self.usable_area // self.module.area)

    @property
    def installed_capacity(self) -> float:
        """kWp. Recomputed here so the UI can show it without a PVGIS call."""
        return (self.module_count * self.module.rating) / 1000.0
