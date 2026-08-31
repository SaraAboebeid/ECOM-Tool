"""Electric vehicle and charge point specifications.

ONE EV PER CHARGE POINT
    ChargePoint computes hourly demand only when exactly one EV is attached
    (charge_point.py:41). With two or more it silently produces a zero demand
    profile - no warning, the charge point just draws nothing.

    LEC-Opt has the same constraint from the other direction: it reports a
    single summed SOC per charge point, so concurrent sessions corrupt the
    day-to-day carry-over.

    So `ev` is a single optional object here, not a list. A list would let
    callers express something neither subsystem can model.
"""
from __future__ import annotations

from typing import Annotated, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .common import Coordinates, Owner

HOURS_PER_YEAR = 8760


class ElectricVehicleSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)]

    capacity: Annotated[float, Field(gt=0)] = Field(50.0, description="Battery capacity, kWh")
    is_hybrid: bool = Field(
        False, description="PHEV. Reserves 30% of capacity for the engine, so "
        "usable capacity is 70% of nominal.",
    )
    efficiency: Annotated[float, Field(gt=0)] = Field(16.0, description="Consumption, kWh/100km")
    daily_distance: Annotated[float, Field(ge=0)] = Field(35.0, description="km/day")
    max_charging_power: Annotated[float, Field(gt=0)] = Field(3.7, description="kW")
    v2g_enabled: bool = Field(
        False, description="Vehicle-to-grid. Raises the charge point's daily "
        "energy budget to 120% of the driving requirement.",
    )
    embodied_co2_per_kwh: Annotated[float, Field(gt=0)] = Field(75.0, description="kgCO2e/kWh")

    availability: Optional[Sequence[int]] = Field(
        default=None,
        description="Binary plugged-in schedule: 24 values (a daily pattern "
        "repeated across the year) or 8760 values. Defaults to always "
        "available, which is rarely what you want.",
    )

    @model_validator(mode="after")
    def _check_availability(self) -> "ElectricVehicleSpec":
        if self.availability is None:
            return self
        if len(self.availability) not in (24, HOURS_PER_YEAR):
            raise ValueError(
                f"availability must have 24 or {HOURS_PER_YEAR} values, "
                f"got {len(self.availability)}"
            )
        bad = {v for v in self.availability} - {0, 1}
        if bad:
            raise ValueError(f"availability must be binary 0/1, found {sorted(bad)}")
        if not any(self.availability):
            raise ValueError(
                "availability is all zeros, so the vehicle is never plugged in "
                "and the charge point would draw nothing."
            )
        return self

    # -------------------------------------------------- derived previews

    @property
    def usable_capacity(self) -> float:
        return self.capacity * (0.7 if self.is_hybrid else 1.0)

    @property
    def daily_energy_demand(self) -> float:
        """kWh/day needed for driving."""
        return (self.efficiency * self.daily_distance) / 100.0

    @property
    def total_embodied_co2(self) -> float:
        return self.capacity * self.embodied_co2_per_kwh

    @property
    def hours_available_per_day(self) -> Optional[int]:
        if self.availability is None:
            return 24
        if len(self.availability) == 24:
            return int(sum(self.availability))
        return None  # varies across the year

    @property
    def charging_is_feasible(self) -> Optional[bool]:
        """Whether the daily requirement fits in the plugged-in hours.

        The toolkit caps per-hour charging at max_charging_power and stops at
        the daily budget, so an over-constrained schedule quietly under-charges
        instead of reporting a problem.
        """
        hours = self.hours_available_per_day
        if hours is None:
            return None
        budget = self.daily_energy_demand * (1.2 if self.v2g_enabled else 1.0)
        return hours * self.max_charging_power >= budget


class ChargePointSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)] = Field(
        description="Unique within the community. Becomes the graph node id, "
        "prefixed with CP_."
    )
    capacity: Annotated[float, Field(gt=0)] = Field(description="Maximum charging power, kW")
    charger_type: str = Field("AC Level 2", description='e.g. "AC Level 2", "DC Fast"')
    is_v2g: bool = False
    owner: Owner

    ev: Optional[ElectricVehicleSpec] = Field(
        default=None,
        description="The single vehicle assigned to this charger. See the "
        "module docstring for why this is not a list.",
    )

    location: Optional[Coordinates] = None

    # Where it actually stands, in WGS84. `location` above is a Rhino-frame
    # x/y like the buildings carry, which means nothing to a map; these are what
    # the MR table places the marker by. Optional, because a charger with no
    # position still dispatches perfectly well - it just gets drawn with the
    # other community assets at the middle of the campus.
    #
    # Named lat/lon rather than reusing Coordinates so it cannot be confused
    # with the Rhino frame, matching PVPlantSpec which already does this.
    lat: Optional[Annotated[float, Field(ge=-90, le=90)]] = None
    lon: Optional[Annotated[float, Field(ge=-180, le=180)]] = None

    @model_validator(mode="after")
    def _position_is_complete(self) -> "ChargePointSpec":
        # Half a coordinate places nothing, and silently falling back to the
        # campus centre would hide the typo that caused it.
        if (self.lat is None) != (self.lon is None):
            raise ValueError(
                "a charge point needs both lat and lon, or neither; "
                f"got lat={self.lat!r} lon={self.lon!r}"
            )
        return self

    @model_validator(mode="after")
    def _v2g_flags_must_agree(self) -> "ChargePointSpec":
        # ChargePoint sizes the daily budget from ev.v2g_enabled and ignores its
        # own is_v2g flag, so a mismatch changes demand by 20% invisibly.
        if self.ev is not None and self.ev.v2g_enabled and not self.is_v2g:
            raise ValueError(
                f"charge point {self.name!r} has is_v2g=False but its vehicle "
                f"{self.ev.name!r} has v2g_enabled=True. ChargePoint reads only "
                f"the vehicle's flag, so the daily charging budget would be "
                f"raised to 120% while the charger claims not to support V2G."
            )
        return self

    @property
    def effective_charging_power(self) -> Optional[float]:
        """The binding power limit: the lower of charger and vehicle."""
        if self.ev is None:
            return None
        return min(self.capacity, self.ev.max_charging_power)
