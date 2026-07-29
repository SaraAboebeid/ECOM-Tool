"""Grid connection and electricity price specifications.

DEFAULT-FILL TRAP
    Grid._prepare_market_price fills every hour outside the analysis period with
    DEFAULT_MARKET_PRICE = 1.5 SEK/kWh (grid.py:96). Hand it 48 hours of real
    prices and the remaining 8712 hours quietly become 1.5.

    So PriceSpec always expands to a full 8760 series here, with an explicit
    fill strategy, and the toolkit only ever sees a complete year.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

HOURS_PER_YEAR = 8760

# What Grid uses when it has nothing better. Named so the trap is greppable.
TOOLKIT_DEFAULT_PRICE = 1.5
TOOLKIT_DEFAULT_CARBON = 18.0


class PriceSpec(BaseModel):
    """An electricity price series in SEK/kWh.

    Exactly one source:

    fixed     one value for every hour of the year.
    hourly    a series of any length; `fill` decides how the rest of the year
              is covered.
    nordpool  day-ahead prices fetched for a date range and area.
    """

    model_config = ConfigDict(extra="forbid")

    fixed: Optional[float] = None
    hourly: Optional[Sequence[float]] = None

    nordpool_area: Optional[str] = Field(None, description='Price area, e.g. "SE3"')
    nordpool_start: Optional[str] = Field(None, description="YYYY-MM-DD, inclusive")
    nordpool_end: Optional[str] = Field(None, description="YYYY-MM-DD, inclusive")

    fill: Literal["repeat", "mean", "value"] = Field(
        "repeat",
        description="How to cover hours the source does not supply. 'repeat' "
        "tiles the series, 'mean' uses its average, 'value' uses fill_value. "
        "There is deliberately no option to inherit the toolkit's 1.5 default.",
    )
    fill_value: Optional[float] = None

    @model_validator(mode="after")
    def _check(self) -> "PriceSpec":
        nordpool = any(v is not None for v in
                       (self.nordpool_area, self.nordpool_start, self.nordpool_end))
        given = [n for n, present in
                 (("fixed", self.fixed is not None),
                  ("hourly", self.hourly is not None),
                  ("nordpool", nordpool)) if present]
        if len(given) != 1:
            raise ValueError(
                "provide exactly one of fixed, hourly or nordpool_*; got "
                + (", ".join(given) if given else "none")
            )

        if nordpool and not all((self.nordpool_area, self.nordpool_start, self.nordpool_end)):
            raise ValueError("nordpool needs all of nordpool_area, nordpool_start, nordpool_end")

        if self.hourly is not None and len(self.hourly) == 0:
            raise ValueError("hourly must not be empty")

        if self.fill == "value" and self.fill_value is None:
            raise ValueError("fill='value' requires fill_value")

        return self

    @property
    def is_nordpool(self) -> bool:
        return self.nordpool_area is not None

    def expand(self, values: Optional[Sequence[float]] = None) -> list[float]:
        """Return exactly 8760 hourly values.

        `values` supplies the fetched series for nordpool sources; other modes
        ignore it.
        """
        if self.fixed is not None:
            return [float(self.fixed)] * HOURS_PER_YEAR

        source = list(values) if values is not None else list(self.hourly or [])
        if not source:
            raise ValueError("no price values to expand")

        source = [float(v) for v in source]
        if len(source) >= HOURS_PER_YEAR:
            return source[:HOURS_PER_YEAR]

        if self.fill == "repeat":
            reps = -(-HOURS_PER_YEAR // len(source))  # ceil
            return (source * reps)[:HOURS_PER_YEAR]

        pad = (sum(source) / len(source)) if self.fill == "mean" else float(self.fill_value)
        return source + [pad] * (HOURS_PER_YEAR - len(source))


class CarbonSpec(BaseModel):
    """Grid carbon intensity in kgCO2e/kWh."""

    model_config = ConfigDict(extra="forbid")

    fixed: Optional[float] = None
    hourly: Optional[Sequence[float]] = None
    fill: Literal["repeat", "mean", "value"] = "repeat"
    fill_value: Optional[float] = None

    @model_validator(mode="after")
    def _check(self) -> "CarbonSpec":
        if (self.fixed is None) == (self.hourly is None):
            raise ValueError("provide exactly one of fixed or hourly")
        if self.fill == "value" and self.fill_value is None:
            raise ValueError("fill='value' requires fill_value")
        return self

    def expand(self) -> list[float]:
        return PriceSpec(
            fixed=self.fixed,
            hourly=self.hourly,
            fill=self.fill,
            fill_value=self.fill_value,
        ).expand()


class GridSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field("Grid", description="Display label. The dispatch graph "
                      "always uses the node id 'GRID'.")

    buying_price: PriceSpec = Field(
        default_factory=lambda: PriceSpec(fixed=1.2),
        description="Import tariff, SEK/kWh.",
    )
    selling_price: PriceSpec = Field(
        default_factory=lambda: PriceSpec(fixed=0.6),
        description="Export tariff, SEK/kWh.",
    )
    carbon_intensity: CarbonSpec = Field(
        default_factory=lambda: CarbonSpec(fixed=45.0),
        description="Operational carbon, kgCO2e/kWh.",
    )

    analysis_start_hour: Annotated[int, Field(ge=0, le=8759)] = 0
    analysis_end_hour: Annotated[int, Field(ge=0, le=8759)] = 8759

    @model_validator(mode="after")
    def _period_is_ordered(self) -> "GridSpec":
        if self.analysis_end_hour < self.analysis_start_hour:
            raise ValueError(
                f"analysis_end_hour ({self.analysis_end_hour}) is before "
                f"analysis_start_hour ({self.analysis_start_hour})"
            )
        return self

    @property
    def analysis_period(self) -> tuple[int, int]:
        return (self.analysis_start_hour, self.analysis_end_hour)

    @property
    def n_hours(self) -> int:
        return self.analysis_end_hour - self.analysis_start_hour + 1
