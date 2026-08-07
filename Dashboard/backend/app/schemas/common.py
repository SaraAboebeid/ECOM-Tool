"""Shared schema pieces for community definitions.

The backend authors communities from JSON, so anything that Grasshopper used to
supply as Rhino geometry arrives here as a number: areas in m2, positions as x/y.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

HOURS_PER_YEAR = 8760

# Building._validate_owner rejects anything outside this list.
Owner = Literal["Akademiska Hus", "Studentbostäder", "Chalmersfastigheter"]


class Coordinates(BaseModel):
    """Map position for a node.

    The toolkit only derives x/y from a Rhino Point3d, which does not exist
    outside Rhino, so the backend carries coordinates itself and assigns them
    after construction.
    """

    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    z: float = 0.0


class DemandSpec(BaseModel):
    """An annual electricity demand profile, in kWh per hour.

    Exactly one source must be given:

    hourly     8760 values, used as-is.
    csv_path   a CSV of 8760 values, read by HourlyData.from_csv.
    annual_kwh a yearly total, distributed over 8760 hours using `shape`.

    The annual_kwh form is what the old Grasshopper docstring promised but the
    toolkit never implemented. It is offered here only with an explicit shape,
    because spreading a yearly total flat across 8760 hours destroys the peaks
    that drive battery sizing, grid import and demand charges.
    """

    model_config = ConfigDict(extra="forbid")

    hourly: Optional[Sequence[float]] = None
    csv_path: Optional[str] = None
    annual_kwh: Optional[Annotated[float, Field(gt=0)]] = None
    shape: Optional[Sequence[float]] = Field(
        default=None,
        description="Relative load shape for annual_kwh: 24 values (a daily "
        "pattern, tiled across the year) or 8760 values. Scaled to match "
        "annual_kwh, so absolute magnitude is irrelevant.",
    )

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "DemandSpec":
        sources = [
            ("hourly", self.hourly is not None),
            ("csv_path", self.csv_path is not None),
            ("annual_kwh", self.annual_kwh is not None),
        ]
        given = [n for n, present in sources if present]
        if len(given) != 1:
            raise ValueError(
                "provide exactly one of hourly, csv_path or annual_kwh; got "
                + (", ".join(given) if given else "none")
            )

        if self.hourly is not None and len(self.hourly) != HOURS_PER_YEAR:
            raise ValueError(
                f"hourly must contain exactly {HOURS_PER_YEAR} values, got {len(self.hourly)}"
            )

        if self.annual_kwh is not None:
            if self.shape is None:
                raise ValueError(
                    "annual_kwh requires an explicit shape. A flat profile would "
                    "hide the peaks that drive battery and grid sizing."
                )
            if len(self.shape) not in (24, HOURS_PER_YEAR):
                raise ValueError(
                    f"shape must have 24 or {HOURS_PER_YEAR} values, got {len(self.shape)}"
                )
            if any(v < 0 for v in self.shape):
                raise ValueError("shape values must be non-negative")
            if sum(self.shape) <= 0:
                raise ValueError("shape must sum to more than zero")

        if self.shape is not None and self.annual_kwh is None:
            raise ValueError("shape is only meaningful together with annual_kwh")

        return self

    def to_hourly_values(self) -> Optional[list[float]]:
        """Return 8760 hourly values, or None when the source is a CSV path.

        CSV is left to the toolkit so HourlyData.from_csv stays the single
        reader for that format.
        """
        if self.hourly is not None:
            return [float(v) for v in self.hourly]

        if self.annual_kwh is not None:
            shape = list(self.shape or [])
            if len(shape) == 24:
                shape = shape * 365
            total = float(sum(shape))
            scale = float(self.annual_kwh) / total
            return [float(v) * scale for v in shape]

        return None
