"""LEC optimizer adapter and the job API.

These run the real solver on a deliberately tiny community, so they stay fast.
PVGIS is stubbed - no test touches the network.
"""
import math
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas.community import CommunitySpec
from app.services.optimize import (COMMUNITY_STORAGE_NODE, OptimizerUnavailable,
                                   _availability_blocks, build_optimizer_inputs,
                                   run_optimization, solver_status)
from app.services.pvgis_cache import HOURS_PER_YEAR, PVGISCache, uninstall_provider

DAILY = [60 + 40 * math.sin(h / 24 * 2 * math.pi) for h in range(24)]
NIGHT = [1] * 7 + [0] * 11 + [1] * 6


@pytest.fixture(autouse=True)
def fake_pvgis(monkeypatch, tmp_path):
    def _fetch(self, orientation):
        return [110.0] * HOURS_PER_YEAR

    monkeypatch.setattr(PVGISCache, "_fetch_per_kwp", _fetch)
    cache = PVGISCache(cache_dir=tmp_path / "pvgis")
    cache.install_provider()
    yield
    uninstall_provider()


def tiny_spec(**overrides) -> CommunitySpec:
    payload = {
        "name": "Opt test",
        "buildings": [{
            "name": "B1", "owner": "Akademiska Hus", "footprint_area": 800.0,
            "number_of_floors": 2, "demand": {"annual_kwh": 300000, "shape": DAILY},
            "pv_plants": ["Roof"],
        }],
        "pv_plants": [{"name": "Roof", "surface_area": 900.0, "slope": 30.0}],
        "batteries": [{"name": "BAT", "capacity": 200.0}],
        "charge_points": [{
            "name": "CP", "capacity": 22.0, "owner": "Akademiska Hus",
            "ev": {"name": "EV", "capacity": 60.0, "max_charging_power": 11.0,
                   "availability": NIGHT},
        }],
        "grid": {"buying_price": {"fixed": 1.4}, "selling_price": {"fixed": 0.4},
                 "carbon_intensity": {"fixed": 41.0}},
        "analysis_period": {"start_month": 6, "start_day": 1, "start_hour": 0,
                            "end_month": 6, "end_day": 2, "end_hour": 23},
    }
    payload.update(overrides)
    return CommunitySpec(**payload)


# ---------------------------------------------------------------- solver

def test_solver_is_available():
    """Without a solver nothing else here can work."""
    status = solver_status()
    assert status["available"], status.get("detail")
    assert status["solver"]


# ---------------------------------------------------------------- inputs

def test_inputs_have_the_five_frames():
    inputs = build_optimizer_inputs(tiny_spec())
    assert set(inputs) >= {"building_data", "charging_point_data", "prices",
                           "temperature", "activation", "start_date"}


def test_price_frames_share_one_index():
    """functions1.py:1044 aborts the day loop unless all three indices match."""
    i = build_optimizer_inputs(tiny_spec())
    assert i["prices"].index.equals(i["temperature"].index)
    assert i["prices"].index.equals(i["activation"].index)


def test_prices_converted_to_eur_per_mwh():
    """functions1 multiplies by 11.1/1000, so it wants EUR/MWh, not SEK/kWh."""
    i = build_optimizer_inputs(tiny_spec())
    spot = i["prices"]["Spot prices"].iloc[0]
    assert spot == pytest.approx(1.4 * 1000.0 / 11.1, rel=1e-6)
    # Round-tripping through the toolkit's own conversion returns the SEK price.
    assert spot * 11.1 / 1000.0 == pytest.approx(1.4, rel=1e-6)


def test_building_frame_has_required_columns():
    i = build_optimizer_inputs(tiny_spec())
    frame = i["building_data"]["B1"]
    for column in ("electricity_load", "pv_production", "bess_capacity", "bess_power"):
        assert column in frame.columns


def test_battery_sits_on_the_community_node():
    """LEC-Opt indexes storage by building, so a shared battery still has to
    live on some building object - but not on a real one.

    It used to be hung on the largest consumer, which made the reported flows
    and the state-of-charge series read as that member's private asset. A
    zero-load, zero-PV node carries it instead, so it belongs to the community
    and to no member.
    """
    spec = tiny_spec()
    spec.buildings.append(type(spec.buildings[0])(
        name="Small", owner="Akademiska Hus", footprint_area=100.0,
        demand={"annual_kwh": 1000, "shape": DAILY}))
    i = build_optimizer_inputs(spec)

    node = i["building_data"][COMMUNITY_STORAGE_NODE]
    assert node["bess_capacity"].iloc[0] == 200.0
    # How big the tank is against how wide the tap is: 200 kWh at the default
    # 0.25C is 50 kW, not the 200 kW an unstated 1C would have allowed.
    assert node["bess_power"].iloc[0] == 50.0
    # It carries storage and nothing else, so it cannot distort the balance.
    assert node["electricity_load"].iloc[0] == 0.0
    assert node["pv_production"].iloc[0] == 0.0

    for name in ("B1", "Small"):
        assert i["building_data"][name]["bess_capacity"].iloc[0] == 0.0
        assert i["building_data"][name]["bess_power"].iloc[0] == 0.0

    assert any("not attached to any member building" in n for n in i["notes"])


def test_battery_power_follows_the_declared_c_rate():
    """The spec carries the rate, so a faster battery gets a wider tap.

    These are the campus figures: the AWL unit holds 247 kWh and is rated
    112 kW, which is 0.4534C quoted to the four decimals a C-rate is normally
    written with - 111.99 kW, and 112 kW to the nearest kilowatt.
    """
    spec = tiny_spec(batteries=[{"name": "BAT", "capacity": 247.0,
                                 "c_rate": 0.4534}])
    node = build_optimizer_inputs(spec)["building_data"][COMMUNITY_STORAGE_NODE]
    assert node["bess_capacity"].iloc[0] == 247.0
    assert node["bess_power"].iloc[0] == pytest.approx(247.0 * 0.4534)
    assert round(node["bess_power"].iloc[0]) == 112


def test_ev_sessions_are_built_from_availability():
    i = build_optimizer_inputs(tiny_spec())
    sessions = i["charging_point_data"]["CP"]
    assert len(sessions) > 0
    assert (sessions["Departure"] > sessions["Arrival"]).all()
    assert (sessions["Arrival SOC"] >= 0.2).all()
    assert (sessions["Desired SOC"] <= 1.0).all()


def test_availability_blocks_wrap_and_filter():
    assert _availability_blocks([1, 1, 0, 0], 8) == [(0, 2), (4, 6)]
    # One-hour blocks are dropped: they trip the toolkit's feasibility assert.
    assert _availability_blocks([1, 0, 1, 0], 8) == []
    assert _availability_blocks(None, 8) == []


# ---------------------------------------------------------------- run

def test_optimization_runs_and_reports_cost():
    result = run_optimization(tiny_spec(), days=1)
    assert result["hours"] == 24
    assert result["totals"]["overall_cost"] > 0
    assert result["totals"]["grid_import_kwh"] >= 0
    assert result["solver"]


def test_cheaper_grid_lowers_cost():
    """A sanity check that the objective actually responds to prices."""
    dear = run_optimization(tiny_spec(), days=1)["totals"]["overall_cost"]
    cheap_spec = tiny_spec()
    cheap_spec.grid.buying_price.fixed = 0.2
    cheap = run_optimization(cheap_spec, days=1)["totals"]["overall_cost"]
    assert cheap < dear


def test_series_are_json_safe():
    import json

    result = run_optimization(tiny_spec(), days=1)
    json.dumps(result)          # raises on numpy scalars or NaN
    assert len(result["series"]["timestamps"]) == result["hours"]


def test_a_day_is_solved_over_36_hours_and_24_are_kept(monkeypatch):
    """The optimizer looks 36 hours ahead and keeps the first 24.

    Solving each day on its own 24 hours would let the battery empty itself at
    midnight, because nothing after midnight would be in view. The rolling
    window is what stops that, so it is asserted rather than left to a default
    nobody is looking at: what the solver is actually HANDED, not what the
    request model says it will be handed.
    """
    from app.services import optimize

    seen = {}
    functions1 = optimize._import_lec()
    real = functions1.optimization_function_lec

    def spy(*args, **kwargs):
        seen["horizon_hours"] = kwargs["horizon_hours"]
        seen["store_hours"] = kwargs["store_hours"]
        seen["input_hours"] = len(next(iter(kwargs["building_data"].values())))
        return real(*args, **kwargs)

    monkeypatch.setattr(functions1, "optimization_function_lec", spy)

    # Exactly the arguments the controller sends: a span, and nothing about the
    # window.
    result = run_optimization(tiny_spec(), days=1)

    assert seen["horizon_hours"] == 36
    assert seen["store_hours"] == 24
    assert result["hours"] == 24            # the 24 kept, not the 36 solved
    # The last day's window reaches 12 hours past the end of the period, so the
    # inputs have to run past it.
    assert seen["input_hours"] >= 24 + (36 - 24)


def _two_buildings(**overrides) -> CommunitySpec:
    spec = tiny_spec(**overrides)
    spec.buildings.append(type(spec.buildings[0])(
        name="Small", owner="Akademiska Hus", footprint_area=300.0,
        demand={"annual_kwh": 120000, "shape": DAILY}))
    return spec


def test_separate_mode_solves_every_building_on_its_own_connection():
    """"As today": no sharing, and each building pays its own bill."""
    spec = _two_buildings(batteries=[], charge_points=[])
    result = run_optimization(spec, days=1, mode="separate")

    assert result["mode"] == "separate"
    assert [s["name"] for s in result["sites"]] == ["B1", "Small"]
    # The totals are the sites added up - including the peak, because separate
    # connections are charged on their own peaks, not on the peak of the sum.
    for key, site_key in (("overall_cost", "overall_cost"),
                          ("grid_import_kwh", "grid_import_kwh"),
                          ("peak_net_import_kw", "peak_net_import_kw")):
        assert result["totals"][key] == pytest.approx(
            sum(s[site_key] for s in result["sites"]), rel=1e-6), key
    assert result["hours"] == 24


def test_the_community_does_not_cost_more_than_the_same_buildings_apart():
    """One connection means one subscription fee and one peak charge, and the
    buildings can use each other's surplus - so together cannot be dearer."""
    spec = _two_buildings(batteries=[], charge_points=[])
    together = run_optimization(spec, days=1, mode="community")["totals"]["overall_cost"]
    apart = run_optimization(spec, days=1, mode="separate")["totals"]["overall_cost"]
    assert together < apart


def test_community_solar_is_in_the_optimizer_and_separate_mode_leaves_it_out():
    """Panels no building names used to be absent from the optimizer entirely."""
    spec = tiny_spec(
        batteries=[], charge_points=[],
        pv_plants=[{"name": "Roof", "surface_area": 500.0, "slope": 30.0},
                   {"name": "Ground", "surface_area": 4000.0, "slope": 30.0}])
    inputs = build_optimizer_inputs(spec)

    node = inputs["building_data"][COMMUNITY_STORAGE_NODE]
    assert node["pv_production"].sum() > 0          # the ground array is there
    assert node["electricity_load"].sum() == 0      # and it carries nothing else
    assert node["bess_capacity"].iloc[0] == 0       # no battery was asked for

    separate = run_optimization(spec, days=1, mode="separate")
    assert [s["name"] for s in separate["sites"]] == ["B1"]   # no community site


def test_an_unknown_optimizer_mode_is_refused():
    with pytest.raises(ValueError):
        run_optimization(tiny_spec(), days=1, mode="neighbours")


def test_every_optimizer_parameter_says_what_it_stands_for():
    """The controller shows this beside each constant, so none can be blank."""
    from app.schemas.optimizer_params import describe_parameters

    for p in describe_parameters():
        assert len(p["meaning"].strip()) > 40, f"{p['name']} has no meaning"
        # Provenance stays separate: a file and line number is not an
        # explanation for someone at the table.
        assert "functions1.py" not in p["meaning"], p["name"]


# ---------------------------------------------------------------- job api

@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def test_job_lifecycle(client):
    spec = tiny_spec()
    response = client.post("/api/optimize",
                           json={"community": spec.model_dump(mode="json"), "days": 1})
    assert response.status_code == 200, response.text
    job = response.json()
    assert job["status"] in ("queued", "running")

    for _ in range(120):
        state = client.get(f"/api/optimize/{job['id']}").json()
        if state["status"] in ("done", "failed"):
            break
        time.sleep(0.5)

    assert state["status"] == "done", state.get("error")
    assert state["result"]["totals"]["overall_cost"] > 0
    assert state["elapsed_s"] > 0


def test_unknown_job_is_404(client):
    assert client.get("/api/optimize/nope").status_code == 404


def test_solver_endpoint(client):
    assert client.get("/api/optimize/solver").json()["available"] is True


def test_jobs_listing_excludes_results(client):
    body = client.get("/api/jobs").json()
    assert "jobs" in body
    for job in body["jobs"]:
        assert "result" not in job


def test_ev_totals_count_the_cars_and_not_the_batteries():
    """`_ch` / `_ds` per charger are the cars; `_bess_ch` / `_bess_ds` are not."""
    import pandas as pd
    from app.services.optimize import _totals
    frame = pd.DataFrame({
        "CP1_ch": [2.0, 3.0], "CP1_ds": [0.0, 1.5],
        "CP2_ch": [1.0, 0.0], "CP2_ds": [0.5, 0.0],
        "AWL_bess_ch": [50.0, 0.0], "AWL_bess_ds": [0.0, 40.0],
        "CP1_ch_fcrn": [9.0, 9.0],          # reserve bids, not energy delivered
        "P_import_all": [10.0, 10.0], "P_export_all": [0.0, 0.0],
        "Overall cost": [1.0, 1.0],
    })
    t = _totals(frame)
    assert t["ev_charge_kwh"] == 6.0
    assert t["ev_discharge_kwh"] == 2.0
