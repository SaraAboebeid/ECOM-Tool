"""Battery specification.

UNITS WARNING
    ECOMToolkit's Battery.initial_soc is an absolute energy in kWh, clamped to
    capacity (battery.py:27). LEC-Opt's initial_bess_soc is a fraction of
    capacity (0.5 = half full). Same concept, different units, and nothing in
    either codebase says so.

    This schema takes a fraction, because that is what survives a capacity
    change: set 50% and it stays half-full whatever the slider does. The
    absolute kWh value is derived when the toolkit object is built.
"""
from __future__ import annotations

from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field

from .common import Coordinates


class BatterySpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)] = Field(
        description="Unique within the community. Becomes the graph node id, "
        "prefixed with BAT_."
    )

    capacity: Annotated[float, Field(gt=0)] = Field(description="Usable storage, kWh")
    cost_per_kwh: Annotated[float, Field(gt=0)] = Field(5000.0, description="SEK/kWh")
    embodied_co2_per_kwh: Annotated[float, Field(gt=0)] = Field(120.0, description="kgCO2e/kWh")

    efficiency: Annotated[float, Field(gt=0, le=100)] = Field(
        90.0, description="Round-trip efficiency, percent."
    )
    lifespan: Annotated[float, Field(gt=0)] = Field(15.0, description="Years")
    degradation: Annotated[float, Field(ge=0, le=100)] = Field(
        2.0, description="Capacity lost per year, percent. Applied linearly by "
        "the toolkit, not compounded.",
    )

    initial_soc_fraction: Annotated[float, Field(ge=0, le=1)] = Field(
        0.5,
        description="State of charge at hour 0, as a fraction of capacity. "
        "Converted to kWh for the toolkit and used directly by LEC-Opt.",
    )

    location: Optional[Coordinates] = None

    # Which building it stands in, by footprint id - "awl", "sb2" and so on.
    #
    # A community battery is a cabinet in a plant room, not a thing in a field,
    # and the table should draw it where it actually is. Named rather than given
    # as a coordinate pair so it follows the building if the footprint is ever
    # resurveyed, and so the scenario file says something a reader recognises.
    #
    # Any footprint in the export can host one, including buildings that are not
    # members of the community: a landlord can put a battery in a building whose
    # meter is not in the scheme.
    host: Optional[Annotated[str, Field(min_length=1)]] = Field(
        default=None,
        description='Footprint id of the building it stands in, e.g. "awl". '
                    "Placed with the other shared assets when absent.",
    )

    # -------------------------------------------------- derived previews

    @property
    def initial_soc_kwh(self) -> float:
        """What ECOMToolkit's Battery.initial_soc actually expects."""
        return self.capacity * self.initial_soc_fraction

    @property
    def total_cost(self) -> float:
        return self.capacity * self.cost_per_kwh

    @property
    def total_embodied_co2(self) -> float:
        return self.capacity * self.embodied_co2_per_kwh

    @property
    def capacity_eol(self) -> float:
        """Capacity at end of life. Mirrors the toolkit's linear model."""
        return max(self.capacity * (1 - (self.degradation / 100.0) * self.lifespan), 0.0)

    @property
    def average_capacity(self) -> float:
        return (self.capacity + self.capacity_eol) / 2.0

    @property
    def fully_degraded_before_eol(self) -> bool:
        """True when degradation x lifespan >= 100%, i.e. the linear model
        reaches zero capacity within the stated lifespan. The toolkit clamps at
        zero silently, so a 5%/year battery with a 25-year life quietly ends at
        nothing."""
        return (self.degradation / 100.0) * self.lifespan >= 1.0
