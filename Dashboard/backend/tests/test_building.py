"""Building entity: schema validation and construction against the real toolkit."""
import math
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.builders.building import BuildingBuildError, build_building
from app.schemas.building import BuildingSpec
from app.schemas.common import HOURS_PER_YEAR, DemandSpec

DAILY = [60 + 40 * math.sin(h / 24 * 2 * math.pi) for h in range(24)]


def make_spec(**overrides):
    base = dict(
        name="TestHall",
        owner="Akademiska Hus",
        building_type="College",
        footprint_area=1200.0,
        number_of_floors=3,
        demand=DemandSpec(annual_kwh=500_000, shape=DAILY),
    )
    base.update(overrides)
    return BuildingSpec(**base)


# ---------------------------------------------------------------- demand

def test_annual_kwh_scales_to_exact_total():
    values = DemandSpec(annual_kwh=500_000, shape=DAILY).to_hourly_values()
    assert len(values) == HOURS_PER_YEAR
    assert sum(values) == pytest.approx(500_000)


def test_annual_kwh_preserves_shape():
    values = DemandSpec(annual_kwh=500_000, shape=DAILY).to_hourly_values()
    # The daily pattern must survive scaling, not be flattened.
    assert values[6] > values[18]
    assert len(set(round(v, 6) for v in values[:24])) > 1


def test_annual_kwh_without_shape_is_rejected():
    with pytest.raises(ValidationError, match="requires an explicit shape"):
        DemandSpec(annual_kwh=500_000)


def test_hourly_must_be_8760():
    with pytest.raises(ValidationError, match="exactly 8760"):
        DemandSpec(hourly=[1.0] * 100)


def test_multiple_sources_rejected():
    with pytest.raises(ValidationError, match="exactly one of"):
        DemandSpec(hourly=[1.0] * HOURS_PER_YEAR, annual_kwh=1000, shape=DAILY)


def test_no_source_rejected():
    with pytest.raises(ValidationError, match="exactly one of"):
        DemandSpec()


# ---------------------------------------------------------------- schema

def test_invalid_owner_rejected():
    with pytest.raises(ValidationError):
        make_spec(owner="Someone Else")


def test_unknown_field_rejected():
    # extra="forbid" catches typos in hand-written JSON.
    with pytest.raises(ValidationError):
        BuildingSpec(
            name="X", owner="Akademiska Hus", footprint_area=100,
            demand=DemandSpec(hourly=[1.0] * HOURS_PER_YEAR),
            construction_embodied_co2=500,
        )


def test_zero_floors_rejected():
    with pytest.raises(ValidationError):
        make_spec(number_of_floors=0)


# ---------------------------------------------------------------- build

def test_builds_against_real_toolkit():
    b = build_building(make_spec())
    assert b.name == "TestHall"
    assert b.area == pytest.approx(3600.0)
    assert b.total_energy_demand == pytest.approx(500_000, rel=1e-6)
    assert b.owner == "Akademiska Hus"


def test_location_sets_xy():
    b = build_building(make_spec(location={"x": 12.5, "y": -3.0}))
    assert (b.x, b.y) == (12.5, -3.0)


def test_missing_location_leaves_xy_none():
    b = build_building(make_spec())
    assert b.x is None and b.y is None


def test_unknown_pv_plant_names_the_building():
    with pytest.raises(BuildingBuildError, match="TestHall.*unknown PV plant"):
        build_building(make_spec(pv_plants=["ghost"]))


def test_hourly_demand_path():
    b = build_building(make_spec(demand=DemandSpec(hourly=[2.0] * HOURS_PER_YEAR)))
    assert b.total_energy_demand == pytest.approx(2.0 * HOURS_PER_YEAR)


def test_area_scales_with_floors():
    one = build_building(make_spec(number_of_floors=1)).area
    five = build_building(make_spec(number_of_floors=5)).area
    assert five == pytest.approx(one * 5)
