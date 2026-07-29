"""Community assembly, dispatch and the HTTP API. No network."""
import math
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas.community import CommunitySpec
from app.services import pvgis_cache
from app.services.pvgis_cache import HOURS_PER_YEAR, PVGISCache, uninstall_provider

DAILY = [60 + 40 * math.sin(h / 24 * 2 * math.pi) for h in range(24)]
NIGHT = [1] * 7 + [0] * 11 + [1] * 6


@pytest.fixture(autouse=True)
def fake_pvgis(monkeypatch, tmp_path):
    """Deterministic PVGIS so no test touches the network."""
    def _fetch(self, orientation):
        return [120.0] * HOURS_PER_YEAR      # Wh per kWp per hour

    monkeypatch.setattr(PVGISCache, "_fetch_per_kwp", _fetch)
    cache = PVGISCache(cache_dir=tmp_path / "pvgis")
    cache.install_provider()
    yield cache
    uninstall_provider()


def definition(**overrides) -> dict:
    base = {
        "name": "Test Community",
        "buildings": [{
            "name": "HallA",
            "owner": "Akademiska Hus",
            "footprint_area": 1200.0,
            "number_of_floors": 3,
            "location": {"x": 0.0, "y": 0.0},
            "demand": {"annual_kwh": 500000, "shape": DAILY},
            "pv_plants": ["RoofA"],
        }],
        "pv_plants": [{"name": "RoofA", "surface_area": 1000.0, "slope": 30.0}],
        "batteries": [{"name": "BAT01", "capacity": 500.0}],
        "charge_points": [{
            "name": "CP01", "capacity": 22.0, "owner": "Akademiska Hus",
            "ev": {"name": "EV01", "capacity": 60.0,
                   "max_charging_power": 11.0, "availability": NIGHT},
        }],
        "grid": {"buying_price": {"fixed": 1.2}, "selling_price": {"fixed": 0.6},
                 "carbon_intensity": {"fixed": 45.0}},
        "analysis_period": {"start_month": 6, "start_day": 1, "start_hour": 0,
                            "end_month": 6, "end_day": 2, "end_hour": 23},
    }
    base.update(overrides)
    return base


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)


# ---------------------------------------------------------------- spec

def test_grid_is_required():
    """The dispatcher silently substitutes a 1.5 SEK/kWh default otherwise."""
    payload = definition()
    del payload["grid"]
    with pytest.raises(ValidationError):
        CommunitySpec(**payload)


def test_community_needs_a_building():
    with pytest.raises(ValidationError, match="at least one building"):
        CommunitySpec(**definition(buildings=[]))


def test_duplicate_names_rejected():
    payload = definition()
    payload["batteries"] = [{"name": "HallA", "capacity": 10.0}]
    with pytest.raises(ValidationError, match="duplicate name"):
        CommunitySpec(**payload)


def test_unknown_pv_reference_rejected():
    payload = definition()
    payload["buildings"][0]["pv_plants"] = ["Nope"]
    with pytest.raises(ValidationError, match="not defined"):
        CommunitySpec(**payload)


def test_pv_shared_between_buildings_rejected():
    payload = definition()
    payload["buildings"].append({
        "name": "HallB", "owner": "Akademiska Hus", "footprint_area": 100.0,
        "demand": {"annual_kwh": 1000, "shape": DAILY}, "pv_plants": ["RoofA"],
    })
    with pytest.raises(ValidationError, match="more than one building"):
        CommunitySpec(**payload)


def test_grid_period_inherits_the_community_period():
    spec = CommunitySpec(**definition())
    assert (spec.grid.analysis_start_hour, spec.grid.analysis_end_hour) == \
        spec.analysis_period.as_tuple


def test_conflicting_grid_period_rejected():
    payload = definition()
    payload["grid"]["analysis_start_hour"] = 100
    payload["grid"]["analysis_end_hour"] = 200
    with pytest.raises(ValidationError, match="does not match the community period"):
        CommunitySpec(**payload)


def test_community_pv_excludes_building_mounted():
    payload = definition()
    payload["pv_plants"].append({"name": "Field", "surface_area": 500.0})
    spec = CommunitySpec(**payload)
    assert [p.name for p in spec.community_pv_plants] == ["Field"]


# ---------------------------------------------------------------- dispatch

def test_dispatch_returns_the_frontend_shape(client):
    r = client.post("/api/dispatch", json=definition())
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) >= {"nodes", "links", "kpis"}

    ids = {n["id"] for n in body["nodes"]}
    assert {"HallA", "GRID", "BAT_BAT01", "CP_CP01"} <= ids

    kinds = {n["id"]: n["type"] for n in body["nodes"]}
    assert kinds["HallA"] == "building"
    assert kinds["GRID"] == "grid"
    assert kinds["BAT_BAT01"] == "battery"
    assert kinds["CP_CP01"] == "charge_point"


def test_flow_arrays_match_the_period(client):
    body = client.post("/api/dispatch", json=definition()).json()
    assert body["meta"]["hours"] == 48
    for link in body["links"]:
        assert len(link["flow"]) == 48


def test_building_carries_real_values_not_reprs(client):
    """export_graph_json emitted electric_demand as a repr string and area 0.0."""
    body = client.post("/api/dispatch", json=definition()).json()
    hall = next(n for n in body["nodes"] if n["id"] == "HallA")
    assert hall["area"] == pytest.approx(3600.0)
    assert isinstance(hall["total_energy_demand"], float)
    assert hall["total_energy_demand"] == pytest.approx(500_000, rel=1e-6)
    assert hall["owner"] == "Akademiska Hus"
    assert (hall["x"], hall["y"]) == (0.0, 0.0)


def test_grid_kpis_are_not_zero(client):
    """These were structurally zero before the dispatcher name fix."""
    kpis = client.post("/api/dispatch", json=definition()).json()["kpis"]
    assert kpis["avg_grid_price_import"] == pytest.approx(1.2)
    assert kpis["avg_grid_carbon_intensity"] == pytest.approx(45.0)
    assert kpis["total_grid_carbon_import"] > 0


def test_battery_capacity_changes_the_result(client):
    """The parametric loop: a slider must move the numbers."""
    small = definition()
    small["batteries"] = [{"name": "BAT01", "capacity": 10.0}]
    big = definition()
    big["batteries"] = [{"name": "BAT01", "capacity": 5000.0}]

    a = client.post("/api/dispatch", json=small).json()["kpis"]
    b = client.post("/api/dispatch", json=big).json()["kpis"]
    assert a["total_grid_import"] != b["total_grid_import"]


def test_pv_area_changes_self_sufficiency(client):
    none_pv = definition()
    none_pv["pv_plants"] = [{"name": "RoofA", "surface_area": 10.0}]
    lots = definition()
    lots["pv_plants"] = [{"name": "RoofA", "surface_area": 20000.0}]

    a = client.post("/api/dispatch", json=none_pv).json()["kpis"]
    b = client.post("/api/dispatch", json=lots).json()["kpis"]
    assert b["total_pv_gen"] > a["total_pv_gen"]
    assert b["self_sufficiency"] > a["self_sufficiency"]


def test_json_is_serialisable(client):
    """No numpy scalars or NaN may reach the browser."""
    import json
    body = client.post("/api/dispatch", json=definition()).json()
    json.dumps(body)   # raises on non-JSON types


# ---------------------------------------------------------------- endpoints

def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_validate_is_cheap_and_informative(client):
    body = client.post("/api/validate", json=definition()).json()
    assert body["valid"] is True
    assert body["hours"] == 48
    assert body["buildings"] == 1
    assert body["total_battery_capacity_kwh"] == 500.0
    assert body["total_pv_capacity_kw"] > 0


def test_preview_lists_nodes(client):
    body = client.post("/api/community/preview", json=definition()).json()
    assert {"id": "GRID", "type": "grid"} in body["nodes"]
    assert "Energy Community merged successfully" in body["validation"]


def test_bad_definition_is_422_not_500(client):
    payload = definition()
    payload["buildings"][0]["owner"] = "Nobody"
    assert client.post("/api/dispatch", json=payload).status_code == 422
