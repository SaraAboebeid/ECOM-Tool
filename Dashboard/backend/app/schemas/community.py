"""The complete energy community definition - the dashboard's JSON contract.

GRID IS REQUIRED
    ECOMDispatcher.__init__ silently substitutes a default Grid when the
    community has none (dispatcher.py:97), at 1.5 SEK/kWh and 18 kgCO2e/kWh.
    The Grasshopper EnergyCommunity component passes None, so every community
    built through it has been running on those defaults.

    `grid` is therefore mandatory here. A missing grid must be a validation
    error, not a silent substitution of plausible-looking numbers.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .analysis_period import AnalysisPeriodSpec
from .battery import BatterySpec
from .building import BuildingSpec
from .charging import ChargePointSpec
from .grid import GridSpec
from .pv import PVPlantSpec


class CommunitySpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)] = "Energy Community"

    buildings: list[BuildingSpec] = Field(default_factory=list)
    pv_plants: list[PVPlantSpec] = Field(
        default_factory=list,
        description="All PV plants. Those named in a building's pv_plants are "
        "attached to it; the rest are community-owned.",
    )
    batteries: list[BatterySpec] = Field(default_factory=list)
    charge_points: list[ChargePointSpec] = Field(default_factory=list)

    grid: GridSpec = Field(description="Required - see the module docstring.")
    analysis_period: AnalysisPeriodSpec = Field(default_factory=AnalysisPeriodSpec)

    dispatch_mode: Literal["community", "market"] = "community"
    internal_price_buying: Annotated[float, Field(ge=0)] = Field(
        1.0, description="Price for peer-to-peer trades within the community, SEK/kWh."
    )
    internal_price_selling: Annotated[float, Field(ge=0)] = 1.0

    # ------------------------------------------------------------- validation

    @model_validator(mode="after")
    def _check(self) -> "CommunitySpec":
        if not self.buildings:
            # _compute_kpis iterates self.community.building for demand, grid
            # flows and PV use. With none, every KPI is zero.
            raise ValueError("a community needs at least one building")

        self._reject_duplicates()
        self._check_pv_references()
        self._align_grid_period()
        return self

    def _reject_duplicates(self) -> None:
        # Node ids must be unique: the dispatch graph is keyed by name, and
        # Pyomo component names are built from them downstream.
        seen: dict[str, str] = {}
        for kind, items in (("building", self.buildings), ("pv plant", self.pv_plants),
                            ("battery", self.batteries), ("charge point", self.charge_points)):
            for item in items:
                if item.name in seen:
                    raise ValueError(
                        f"duplicate name {item.name!r}: used by both a "
                        f"{seen[item.name]} and a {kind}. Names must be unique "
                        f"across the whole community."
                    )
                seen[item.name] = kind

        ev_names = [cp.ev.name for cp in self.charge_points if cp.ev is not None]
        duplicates = {n for n in ev_names if ev_names.count(n) > 1}
        if duplicates:
            raise ValueError(f"duplicate vehicle name(s): {sorted(duplicates)}")

    def _check_pv_references(self) -> None:
        known = {p.name for p in self.pv_plants}
        for building in self.buildings:
            missing = [n for n in building.pv_plants if n not in known]
            if missing:
                raise ValueError(
                    f"building {building.name!r} references PV plant(s) {missing} "
                    f"that are not defined. Known: {sorted(known) or 'none'}"
                )

        claimed = [n for b in self.buildings for n in b.pv_plants]
        twice = {n for n in claimed if claimed.count(n) > 1}
        if twice:
            raise ValueError(
                f"PV plant(s) {sorted(twice)} are attached to more than one "
                f"building. Their production would be counted twice."
            )

    def _align_grid_period(self) -> None:
        # Grid carries its own analysis period and the dispatcher carries
        # another. If they disagree, prices are read for different hours than
        # the flows they price.
        start, end = self.analysis_period.as_tuple
        if (self.grid.analysis_start_hour, self.grid.analysis_end_hour) != (start, end):
            if (self.grid.analysis_start_hour, self.grid.analysis_end_hour) != (0, 8759):
                raise ValueError(
                    f"grid analysis period "
                    f"({self.grid.analysis_start_hour}-{self.grid.analysis_end_hour}) "
                    f"does not match the community period ({start}-{end}). Leave the "
                    f"grid period at its default to inherit the community's."
                )
            self.grid.analysis_start_hour = start
            self.grid.analysis_end_hour = end

    # ------------------------------------------------------------- helpers

    @property
    def community_pv_plants(self) -> list[PVPlantSpec]:
        """Plants not attached to any building."""
        attached = {n for b in self.buildings for n in b.pv_plants}
        return [p for p in self.pv_plants if p.name not in attached]

    @property
    def total_pv_capacity(self) -> float:
        return sum(p.installed_capacity for p in self.pv_plants)

    @property
    def total_battery_capacity(self) -> float:
        return sum(b.capacity for b in self.batteries)

    @property
    def total_annual_demand(self) -> float:
        return sum(
            sum(b.demand.to_hourly_values() or [])
            for b in self.buildings
            if b.demand.to_hourly_values() is not None
        )
