"""Battery entity: the kWh-vs-fraction trap, degradation, and validation."""
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.builders.battery import BatteryBuildError, build_battery
from app.schemas.battery import BatterySpec
from app.schemas.pv import PVModuleSpec


def make_spec(**overrides):
    base = dict(name="BAT-01", capacity=500.0)
    base.update(overrides)
    return BatterySpec(**base)


# ---------------------------------------------------------------- soc units

def test_fraction_converts_to_kwh():
    spec = make_spec(capacity=500.0, initial_soc_fraction=0.5)
    assert spec.initial_soc_kwh == pytest.approx(250.0)


def test_toolkit_receives_kwh_not_the_fraction():
    """The trap: passing 0.5 straight through means 0.5 kWh, not half full."""
    battery = build_battery(make_spec(capacity=500.0, initial_soc_fraction=0.5))
    assert battery.initial_soc == pytest.approx(250.0)
    assert battery.initial_soc != pytest.approx(0.5)


def test_soc_fraction_tracks_capacity_changes():
    """Why the schema stores a fraction: resizing keeps the battery half full."""
    small = build_battery(make_spec(capacity=100.0, initial_soc_fraction=0.5))
    big = build_battery(make_spec(capacity=1000.0, initial_soc_fraction=0.5))
    assert small.initial_soc == pytest.approx(50.0)
    assert big.initial_soc == pytest.approx(500.0)


def test_soc_fraction_bounds():
    with pytest.raises(ValidationError):
        make_spec(initial_soc_fraction=1.5)
    with pytest.raises(ValidationError):
        make_spec(initial_soc_fraction=-0.1)


# ---------------------------------------------------------------- derived

def test_cost_and_co2_scale_with_capacity():
    spec = make_spec(capacity=500.0, cost_per_kwh=5000.0, embodied_co2_per_kwh=120.0)
    battery = build_battery(spec)
    assert battery.total_cost == pytest.approx(2_500_000)
    assert battery.total_embodied_co2 == pytest.approx(60_000)
    assert spec.total_cost == pytest.approx(battery.total_cost)
    assert spec.total_embodied_co2 == pytest.approx(battery.total_embodied_co2)


def test_degradation_is_linear_not_compounded():
    spec = make_spec(capacity=100.0, degradation=2.0, lifespan=15.0)
    # Linear: 100 x (1 - 0.02 x 15) = 70. Compounded would be ~73.9.
    assert spec.capacity_eol == pytest.approx(70.0)
    assert build_battery(spec).capacity_eol == pytest.approx(70.0)


def test_average_capacity_matches_toolkit():
    spec = make_spec(capacity=100.0, degradation=2.0, lifespan=15.0)
    assert build_battery(spec).average_capacity == pytest.approx(spec.average_capacity)


def test_full_degradation_is_detectable():
    """The toolkit clamps eol capacity at zero without saying so."""
    spec = make_spec(capacity=100.0, degradation=5.0, lifespan=25.0)
    assert spec.fully_degraded_before_eol is True
    assert spec.capacity_eol == 0.0
    assert build_battery(spec).capacity_eol == 0.0


def test_normal_battery_is_not_flagged():
    assert make_spec(degradation=2.0, lifespan=15.0).fully_degraded_before_eol is False


# ---------------------------------------------------------------- validation

def test_zero_capacity_rejected():
    with pytest.raises(ValidationError):
        make_spec(capacity=0)


def test_efficiency_above_100_rejected():
    with pytest.raises(ValidationError):
        make_spec(efficiency=120)


def test_unknown_field_rejected():
    with pytest.raises(ValidationError):
        BatterySpec(name="B", capacity=10, point=[0, 0, 0])


# ---------------------------------------------------------------- pv module guard

def test_pv_cost_below_100_rejected():
    """PVModule multiplies costs under 100 by 1000, so a slider crossing that
    boundary would jump the value 1000x."""
    with pytest.raises(ValidationError, match="reinterprets"):
        PVModuleSpec(cost_per_kwp=99.0)


def test_pv_module_previews_match_toolkit():
    from app.builders.pv import build_pv_module

    spec = PVModuleSpec(rating=400, size_x=1.0, size_y=2.0)
    module = build_pv_module(spec)
    assert spec.efficiency == pytest.approx(module.efficiency)
    assert spec.cost_per_panel == pytest.approx(module.total_cost)
    assert spec.embodied_co2_per_panel == pytest.approx(module.total_embodied_co2)
