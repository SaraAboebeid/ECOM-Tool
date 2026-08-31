"""Charge points in the dispatch: the wire between a charger and the community.

Until this was written the dispatcher added a CP_ node to the graph and then
never mentioned it again - no edges, no demand in the hourly balance, and a
standing TODO where the dispatch should have been. A charge point drew nothing
however many vehicles were plugged into it, and the MR table drew a marker with
no line reaching it.

These tests run the real dispatcher over a real ChargePoint and pin the two
things that were missing: the energy has to arrive, and it has to be counted.
"""
import contextlib
import io
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path

from ECOMToolkit.analysis.data import DataCategory, DataUnit, HourlyData
from ECOMToolkit.analysis.dispatcher import ECOMDispatcher
from ECOMToolkit.entities.building import Building
from ECOMToolkit.entities.charge_point import ChargePoint
from ECOMToolkit.entities.electric_vehicle import ElectricVehicle
from ECOMToolkit.entities.energy_community import EnergyCommunity
from ECOMToolkit.entities.grid import Grid
from ECOMToolkit.entities.pv_plant import PVPlant

OWNER = "Akademiska Hus"
DAY = (0, 23)                          # 1 January, so hoy 1..24
NIGHT = [1] * 7 + [0] * 11 + [1] * 6   # plugged in 18:00-07:00, like the campus EV
PLUGGED_IN_HOURS = sum(NIGHT)
DAILY_KWH = 6.4                        # 40 km at 16 kWh/100km
PER_HOUR = DAILY_KWH / PLUGGED_IN_HOURS


def hourly(values):
    """An HourlyData of 8760 values, the shape every entity here expects."""
    return HourlyData(
        pd.DataFrame({"hoy": range(1, 8761), "value": np.asarray(values, dtype=float)}),
        meta={"type": "test"}, title="test", source="test",
        units=DataUnit.KILOWATT_HOUR, category=DataCategory.ENERGY,
    )


def make_building(demand_per_hour=10.0, pv=None):
    return Building(
        name="B1", footprints=500.0, building_type="Office",
        occupancy_schedule=[1] * 24, owner=OWNER, number_of_floors=2,
        electric_demand=hourly(np.full(8760, demand_per_hour)),
        PV_plant=pv,
    )


def make_roof(profile):
    """A real PVPlant carrying a generation profile we choose.

    Its own profile would come from PVGIS through a Rhino surface; neither is
    available here, and what is under test is what the dispatch does with
    generation, not where the numbers came from.
    """
    plant = PVPlant(name="Roof")
    plant.hourly_result = hourly(profile)
    return plant


def make_charge_point(v2g=False, power=11.0, availability=NIGHT):
    ev = ElectricVehicle(name="EV", schedule=availability, capacity=60.0,
                         efficiency=16.0, daily_distance=40.0,
                         max_charging_power=power, v2g_enabled=v2g)
    return ChargePoint(name="CP", point=None, capacity=22.0, charger_type="AC Level 2",
                       is_v2g=v2g, owner=OWNER, ev_list=[ev])


def dispatch(community, period=DAY):
    """Run a dispatch, swallowing the toolkit per-hour log."""
    with contextlib.redirect_stdout(io.StringIO()):
        dispatcher = ECOMDispatcher(community=community, analysis_period=period)
        dispatcher.run()
    return dispatcher


def flow(dispatcher, source, target):
    if not dispatcher.G.has_edge(source, target):
        return None
    return np.asarray(dispatcher.G.edges[source, target]["flow"], dtype=float)


def community_with(charge_points=None, pv=None):
    return EnergyCommunity(building=[make_building(pv=pv)],
                           charging_points=charge_points,
                           grid=Grid(analysis_period=DAY))


# --------------------------------------------------------------- the energy

def test_the_grid_supplies_the_charge_point():
    dispatcher = dispatch(community_with([make_charge_point()]))

    served = flow(dispatcher, "GRID", "CP_CP")
    assert served is not None, "no GRID -> CP edge exists at all"
    # Nothing local can supply it, so the whole daily requirement is imported.
    assert served.sum() == pytest.approx(DAILY_KWH)


def test_it_arrives_in_the_hours_the_car_is_plugged_in():
    served = flow(dispatch(community_with([make_charge_point()])), "GRID", "CP_CP")

    charging = [hour for hour, value in enumerate(served) if value > 0]
    assert charging == [hour for hour, on in enumerate(NIGHT) if on]
    # Spread evenly over the plugged-in hours, under the 11 kW power limit.
    assert served[0] == pytest.approx(PER_HOUR)
    assert served[12] == 0.0


def test_the_charge_point_gets_what_it_asked_for():
    """The dispatch must deliver ChargePoint's own profile, hour by hour."""
    charge_point = make_charge_point()
    dispatcher = dispatch(community_with([charge_point]))

    asked = charge_point.hourlydemand.df.loc[
        charge_point.hourlydemand.df["hoy"].between(1, 24), "value"].to_numpy()
    assert flow(dispatcher, "GRID", "CP_CP") == pytest.approx(asked)


def test_v2g_raises_what_is_delivered():
    """The vehicle's flag raises its daily budget by 20%, and that must show."""
    for charge_point, expected in ((make_charge_point(v2g=False), DAILY_KWH),
                                   (make_charge_point(v2g=True), DAILY_KWH * 1.2)):
        served = flow(dispatch(community_with([charge_point])), "GRID", "CP_CP")
        assert served.sum() == pytest.approx(expected)


def test_a_roof_surplus_charges_the_car_before_the_grid_does():
    """Local energy first, exactly as for a building.

    The car is plugged in overnight and the roof produces only at 06:00, an hour
    it is still plugged in for. That surplus must reach the charger rather than
    being exported while the grid supplies the car.
    """
    surplus_hour = 6
    profile = np.zeros(8760)
    profile[surplus_hour] = 14.0            # 10 covers the building, 4 spare
    dispatcher = dispatch(community_with([make_charge_point()],
                                         pv=[make_roof(profile)]))

    local = flow(dispatcher, "B1", "CP_CP")
    from_grid = flow(dispatcher, "GRID", "CP_CP")

    assert local[surplus_hour] == pytest.approx(PER_HOUR)
    assert from_grid[surplus_hour] == 0.0
    # The hour before, with no sun, is still the grid's.
    assert from_grid[surplus_hour - 1] == pytest.approx(PER_HOUR)


def test_the_surplus_is_not_spent_twice():
    """What goes to the car must not also be exported."""
    surplus_hour = 6
    profile = np.zeros(8760)
    profile[surplus_hour] = 14.0
    dispatcher = dispatch(community_with([make_charge_point()],
                                         pv=[make_roof(profile)]))

    to_car = flow(dispatcher, "B1", "CP_CP")[surplus_hour]
    exported = flow(dispatcher, "B1", "GRID")[surplus_hour]
    assert to_car + exported == pytest.approx(4.0)


# ----------------------------------------------------------------- the books

def test_charging_is_counted_as_demand():
    """Otherwise a community could raise its self-sufficiency by adding chargers."""
    bare = dispatch(community_with(None)).get_kpis()
    charged = dispatch(community_with([make_charge_point()])).get_kpis()

    assert bare.total_demand == pytest.approx(240.0)                 # 24 h x 10 kWh
    assert charged.total_demand == pytest.approx(240.0 + DAILY_KWH)
    assert charged.total_grid_import == pytest.approx(240.0 + DAILY_KWH)
    # Neither community generates anything, so both are wholly grid-fed.
    assert bare.self_sufficiency == pytest.approx(0.0)
    assert charged.self_sufficiency == pytest.approx(0.0)


def test_self_sufficiency_falls_when_a_charger_joins_a_solar_community():
    """The honest direction: a new load the roofs cannot cover lowers the share."""
    profile = np.zeros(8760)
    profile[10:16] = 30.0            # a midday surplus, hours the car is away

    bare = dispatch(community_with(None, pv=[make_roof(profile)])).get_kpis()
    charged = dispatch(community_with([make_charge_point()],
                                      pv=[make_roof(profile)])).get_kpis()

    assert bare.self_sufficiency > 0
    assert charged.self_sufficiency < bare.self_sufficiency


def test_the_hourly_summary_includes_charging():
    hours = dispatch(community_with([make_charge_point()])).get_hourly_dispatch()

    # Hour 0: 10 kWh for the building, and the car's share of its daily energy.
    assert hours[0]["grid_import"] == pytest.approx(10.0 + PER_HOUR)
    # Hour 12: the car is away.
    assert hours[12]["grid_import"] == pytest.approx(10.0)


def test_a_charge_point_with_no_vehicle_draws_nothing():
    """No EV means no demand - and no phantom edge carrying energy either."""
    empty = ChargePoint(name="CP", point=None, capacity=22.0, charger_type="AC Level 2",
                        is_v2g=False, owner=OWNER, ev_list=[])
    dispatcher = dispatch(community_with([empty]))

    assert flow(dispatcher, "GRID", "CP_CP").sum() == pytest.approx(0.0)
    assert dispatcher.get_kpis().total_demand == pytest.approx(240.0)
