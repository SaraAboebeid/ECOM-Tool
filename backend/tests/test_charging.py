"""Charge point and EV: the single-EV constraint, V2G flags, and demand."""
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.builders.charging import (ChargingBuildError, build_charge_point,
                                   build_electric_vehicle)
from app.schemas.charging import ChargePointSpec, ElectricVehicleSpec

# Plugged in overnight, 18:00-07:00.
NIGHT = [1] * 7 + [0] * 11 + [1] * 6


def make_ev(**overrides):
    base = dict(name="EV-01", capacity=60.0, max_charging_power=11.0, availability=NIGHT)
    base.update(overrides)
    return ElectricVehicleSpec(**base)


def make_cp(**overrides):
    base = dict(name="CP-01", capacity=22.0, owner="Akademiska Hus", ev=make_ev())
    base.update(overrides)
    return ChargePointSpec(**base)


# ---------------------------------------------------------------- ev derived

def test_daily_energy_demand():
    ev = make_ev(efficiency=16.0, daily_distance=35.0)
    assert ev.daily_energy_demand == pytest.approx(5.6)


def test_hybrid_reserves_capacity():
    assert make_ev(capacity=100, is_hybrid=True).usable_capacity == pytest.approx(70.0)
    assert make_ev(capacity=100, is_hybrid=False).usable_capacity == pytest.approx(100.0)


def test_availability_hours_counted():
    assert make_ev(availability=NIGHT).hours_available_per_day == 13


def test_charging_feasibility_detected():
    # 13 h x 11 kW = 143 kWh available for a 5.6 kWh need.
    assert make_ev().charging_is_feasible is True
    # 1 h x 1 kW against a 40 kWh/day need.
    tight = make_ev(availability=[1] + [0] * 23, max_charging_power=1.0,
                    efficiency=20.0, daily_distance=200.0)
    assert tight.charging_is_feasible is False


# ---------------------------------------------------------------- ev validation

def test_availability_must_be_binary():
    with pytest.raises(ValidationError, match="binary"):
        make_ev(availability=[2] * 24)


def test_availability_wrong_length_rejected():
    with pytest.raises(ValidationError, match="24 or 8760"):
        make_ev(availability=[1] * 12)


def test_never_plugged_in_rejected():
    with pytest.raises(ValidationError, match="never plugged in"):
        make_ev(availability=[0] * 24)


# ---------------------------------------------------------------- single ev

def test_ev_is_singular_not_a_list():
    """A list would let callers express what neither subsystem can model."""
    with pytest.raises(ValidationError):
        ChargePointSpec(name="CP", capacity=22, owner="Akademiska Hus",
                        ev=[make_ev(), make_ev(name="EV-02")])


def test_single_ev_produces_demand():
    cp = build_charge_point(make_cp())
    assert float(cp.hourlydemand.df["value"].sum()) > 0
    assert cp.total_connected_evs == 1


# ---------------------------------------------------------------- v2g

def test_v2g_mismatch_rejected():
    """ChargePoint reads only the vehicle's flag, so a mismatch silently
    changes the daily budget by 20%."""
    with pytest.raises(ValidationError, match="reads only"):
        make_cp(is_v2g=False, ev=make_ev(v2g_enabled=True))


def test_v2g_agreement_accepted():
    cp = build_charge_point(make_cp(is_v2g=True, ev=make_ev(v2g_enabled=True)))
    assert cp.is_v2g is True


def test_v2g_raises_daily_budget():
    plain = build_charge_point(make_cp(name="A"))
    v2g = build_charge_point(make_cp(name="B", is_v2g=True, ev=make_ev(v2g_enabled=True)))
    plain_total = float(plain.hourlydemand.df["value"].sum())
    v2g_total = float(v2g.hourlydemand.df["value"].sum())
    assert v2g_total == pytest.approx(plain_total * 1.2)


# ---------------------------------------------------------------- charge point

def test_validate_passes_without_rhino_point():
    """Before the fix, validate() failed for every charge point outside Rhino."""
    cp = build_charge_point(make_cp())
    assert cp.validate().startswith("Charge Point")


def test_effective_power_is_the_lower_limit():
    assert make_cp(capacity=22.0, ev=make_ev(max_charging_power=11.0)).effective_charging_power == 11.0
    assert make_cp(capacity=7.0, ev=make_ev(max_charging_power=11.0)).effective_charging_power == 7.0


def test_power_limit_reaches_the_demand_profile():
    slow = build_charge_point(make_cp(name="S", capacity=1.0))
    peak = float(slow.hourlydemand.df["value"].max())
    assert peak <= 1.0 + 1e-9


def test_invalid_owner_rejected():
    with pytest.raises(ValidationError):
        make_cp(owner="Someone Else")


def test_location_sets_xy():
    cp = build_charge_point(make_cp(location={"x": 5.0, "y": 6.0}))
    assert (cp.x, cp.y) == (5.0, 6.0)


def test_charge_point_without_ev_builds():
    cp = build_charge_point(make_cp(ev=None))
    assert cp.total_connected_evs == 0
    assert float(cp.hourlydemand.df["value"].sum()) == 0.0


def test_zero_distance_vehicle_is_rejected_not_silent():
    with pytest.raises(ChargingBuildError, match="annual demand profile is zero"):
        build_charge_point(make_cp(ev=make_ev(daily_distance=0.0)))


def test_standalone_ev_builder():
    ev = build_electric_vehicle(make_ev())
    assert ev.name == "EV-01"
    assert ev.daily_energy_demand == pytest.approx(5.6)
