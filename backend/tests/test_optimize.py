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
from app.services.optimize import (OptimizerUnavailable, _availability_blocks,
                                   build_optimizer_inputs, run_optimization,
                                   solver_status)
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


def test_battery_is_attached_to_the_largest_consumer():
    """LEC-Opt has no community battery, so it must land on a building."""
    spec = tiny_spec()
    spec.buildings.append(type(spec.buildings[0])(
        name="Small", owner="Akademiska Hus", footprint_area=100.0,
        demand={"annual_kwh": 1000, "shape": DAILY}))
    i = build_optimizer_inputs(spec)
    assert i["building_data"]["B1"]["bess_capacity"].iloc[0] == 200.0
    assert i["building_data"]["Small"]["bess_capacity"].iloc[0] == 0.0
    assert any("attached to" in n for n in i["notes"])


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
