"""Building specification.

Mirrors ECOMToolkit.entities.Building, with Rhino geometry replaced by numbers.
Fields the toolkit does not implement are deliberately absent - see the notes at
the bottom of this module.
"""
from __future__ import annotations

from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field

from .common import Coordinates, DemandSpec, Owner


class BuildingSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)] = Field(
        description="Unique within the community. Becomes the graph node id."
    )
    owner: Owner
    building_type: str = Field(
        default="College",
        description="Honeybee program type. Validated against the Honeybee "
        "library only when honeybee_energy is installed.",
    )

    footprint_area: Annotated[float, Field(ge=0)] = Field(
        description="Footprint area in m2. Replaces the Rhino Brep/Surface. "
        "Multiplied by number_of_floors to give the building's total area."
    )
    number_of_floors: Annotated[int, Field(ge=1)] = 1

    demand: DemandSpec
    location: Optional[Coordinates] = Field(
        default=None,
        description="Map position. Without it the dashboard falls back to a "
        "force-directed layout.",
    )

    pv_plants: list[str] = Field(
        default_factory=list,
        description="Names of PV plants mounted on this building, resolved "
        "against the community's pv_plants at build time.",
    )

    @property
    def total_area(self) -> float:
        return self.footprint_area * self.number_of_floors


# Not modelled, and why:
#
# construction_embodied_co2 / total_embodied_co2
#     The old Grasshopper docstring listed both, but Building implements
#     neither. Adding them here would mean inventing a calculation the toolkit
#     does not perform, and reporting zeros as if they were measured.
#
# batteries
#     Not a Building input in the toolkit. Batteries belong to the
#     EnergyCommunity, so they are modelled at that level.
#
# occupancy_schedule
#     Building._validate_schedule accepts only Honeybee ScheduleRuleset or
#     ScheduleFixedInterval objects, which cannot be expressed in JSON. Program
#     based demand needs honeybee_energy installed; supply `demand` instead.
