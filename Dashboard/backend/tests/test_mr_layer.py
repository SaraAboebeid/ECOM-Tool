"""The MR table layer: the dispatch-to-GeoJSON transform and its endpoint.

Footprints are stubbed rather than read from public/buildings.geojson, so these
test the join and the geometry rather than the current campus - a building
renamed in the real file should not turn into a failure here.
"""
import json
import math
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import mr_layer
from app.services.mr_layer import build_layer, canonical
from app.services.pvgis_cache import HOURS_PER_YEAR, PVGISCache, uninstall_provider

DAILY = [60 + 40 * math.sin(h / 24 * 2 * math.pi) for h in range(24)]


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


def square(lon, lat, size=0.0004):
    return [[[lon, lat], [lon + size, lat], [lon + size, lat + size],
             [lon, lat + size], [lon, lat]]]


@pytest.fixture(autouse=True)
def fake_footprints(monkeypatch):
    """Two members and one building that is not in the community.

    'Idealara' carries an accent in the dispatch and none in the footprint id,
    which is the case exact matching used to drop silently.
    """
    geo = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"id": "hall-a"},
             "geometry": {"type": "Polygon", "coordinates": square(11.973, 57.688)}},
            {"type": "Feature", "properties": {"id": "idealara"},
             "geometry": {"type": "Polygon", "coordinates": square(11.976, 57.689)}},
            {"type": "Feature", "properties": {"id": "not-a-member"},
             "geometry": {"type": "Polygon", "coordinates": square(11.980, 57.690)}},
        ],
    }
    text = json.dumps(geo)
    monkeypatch.setattr(mr_layer, "_footprint_text", lambda: text)


def definition(**overrides) -> dict:
    base = {
        "name": "Test Community",
        "buildings": [
            {"name": "Hall A", "owner": "Akademiska Hus", "footprint_area": 1200.0,
             "number_of_floors": 3, "demand": {"annual_kwh": 500000, "shape": DAILY},
             "pv_plants": ["RoofA"]},
            {"name": "Idealära", "owner": "Chalmersfastigheter",
             "footprint_area": 800.0, "number_of_floors": 2,
             "demand": {"annual_kwh": 300000, "shape": DAILY}, "pv_plants": []},
        ],
        "pv_plants": [{"name": "RoofA", "surface_area": 1000.0, "slope": 30.0}],
        "batteries": [{"name": "BAT01", "capacity": 500.0}],
        "grid": {"buying_price": {"fixed": 1.2}, "selling_price": {"fixed": 0.6},
                 "carbon_intensity": {"fixed": 45.0}},
        "analysis_period": {"start_month": 6, "start_day": 1, "start_hour": 0,
                            "end_month": 6, "end_day": 1, "end_hour": 23},
    }
    base.update(overrides)
    return base


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)


@pytest.fixture
def layer(client):
    response = client.post("/api/mr/layer", json=definition())
    assert response.status_code == 200, response.text
    return response.json()


# ------------------------------------------------------------------- join

def test_canonical_folds_case_accents_and_punctuation():
    assert canonical("Idealära") == canonical("idealara") == "idealara"
    assert canonical("CA-Huset") == "cahuset"


def test_members_are_matched_by_canonical_name(layer):
    """Exact matching drops accented and punctuated names silently."""
    assert layer["matched"] == 2

    by_id = {f["properties"]["id"]: f["properties"]
             for f in layer["buildings"]["features"]}
    assert by_id["hall-a"]["ecom"]["name"] == "Hall A"
    assert by_id["idealara"]["ecom"]["name"] == "Idealära"


def test_non_members_are_null_not_zero(layer):
    """The table styles "not in the community" apart from "used nothing"."""
    by_id = {f["properties"]["id"]: f["properties"]
             for f in layer["buildings"]["features"]}
    assert by_id["not-a-member"]["ecom"] is None
    assert layer["unmatched"] == ["not-a-member"]


def test_a_member_accounts_for_every_hour_it_was_served(layer):
    ecom = next(f["properties"]["ecom"] for f in layer["buildings"]["features"]
                if f["properties"]["id"] == "hall-a")
    assert len(ecom["demand_hourly"]) == layer["meta"]["hours"] == 24
    assert ecom["demand_kwh"] == pytest.approx(
        ecom["grid_kwh"] + ecom["local_kwh"], rel=1e-3)
    assert 0.0 <= ecom["self_sufficiency"] <= 100.0


# ------------------------------------------------------------------ nodes

def test_buildings_sit_on_their_footprint_centroid(layer):
    node = next(f for f in layer["nodes"]["features"]
                if f["properties"]["id"] == "Hall A")
    lon, lat = node["geometry"]["coordinates"]
    # The stub square starts at (11.973, 57.688) and is 0.0004 on a side.
    assert lon == pytest.approx(11.9732, abs=1e-4)
    assert lat == pytest.approx(57.6882, abs=1e-4)


def test_nodes_carry_what_the_view_filters_read(layer):
    """The controller filters by kind, owner and capacity, all on the feature."""
    for feature in layer["nodes"]["features"]:
        props = feature["properties"]
        assert props["kind"] in {"building", "pv", "grid", "battery", "charge_point"}
        assert "owner" in props
        assert isinstance(props["capacity"], (int, float))

    owners = {f["properties"]["owner"] for f in layer["nodes"]["features"]
              if f["properties"]["kind"] == "building"}
    assert owners == {"Akademiska Hus", "Chalmersfastigheter"}


def test_community_assets_are_placed_at_the_centre(layer):
    """They have no location of their own; a fixed point would drag every line
    into a corner."""
    kinds = {f["properties"]["kind"] for f in layer["nodes"]["features"]}
    assert {"grid", "battery"} <= kinds

    buildings = [f["geometry"]["coordinates"] for f in layer["nodes"]["features"]
                 if f["properties"]["kind"] == "building"]
    anchor_lon = sum(c[0] for c in buildings) / len(buildings)

    grid = next(f for f in layer["nodes"]["features"]
                if f["properties"]["kind"] == "grid")
    assert grid["geometry"]["coordinates"][0] == pytest.approx(anchor_lon, abs=0.001)


def test_a_roof_array_lands_on_its_host(layer):
    pv = next(f for f in layer["nodes"]["features"]
              if f["properties"]["kind"] == "pv")
    host = next(f for f in layer["nodes"]["features"]
                if f["properties"]["id"] == pv["properties"]["host"])
    assert pv["geometry"]["coordinates"] == host["geometry"]["coordinates"]
    assert pv["properties"]["owner"] == host["properties"]["owner"]


# ------------------------------------------------------------------ flows

def test_flows_are_elbowed_not_straight(layer):
    """Straight lines cut diagonally across the campus grid; the viewer bends
    them, and the table has to bend them the same way."""
    assert layer["flows"]["features"]
    for feature in layer["flows"]["features"]:
        assert len(feature["geometry"]["coordinates"]) == 4


def test_flows_carry_both_owners_and_a_peak(layer):
    for feature in layer["flows"]["features"]:
        props = feature["properties"]
        assert "source_owner" in props and "target_owner" in props
        assert props["peak"] == pytest.approx(max(props["flow_hourly"]))
        assert len(props["flow_hourly"]) == layer["meta"]["hours"]


def test_a_flow_that_never_moves_anything_is_dropped(layer):
    for feature in layer["flows"]["features"]:
        assert any(v > 0 for v in feature["properties"]["flow_hourly"])


# --------------------------------------------------------------- endpoint

def test_layer_answers_with_every_collection_the_table_needs(layer):
    assert set(layer) >= {"buildings", "nodes", "flows", "meta", "kpis"}
    assert layer["buildings"]["ecom_meta"] == layer["meta"]
    assert layer["meta"]["hours"] == 24


def test_a_bigger_battery_changes_the_flows(client, layer):
    """The point of the slider: the table has to show a different picture."""
    bigger = definition()
    bigger["batteries"][0]["capacity"] = 5000.0
    response = client.post("/api/mr/layer", json=bigger)
    assert response.status_code == 200, response.text

    def battery_throughput(payload):
        return sum(sum(f["properties"]["flow_hourly"])
                   for f in payload["flows"]["features"]
                   if f["properties"]["kind"] == "battery")

    assert battery_throughput(response.json()) > battery_throughput(layer)


def test_an_empty_community_is_a_422_the_panel_can_show(client):
    response = client.post("/api/mr/layer", json=definition(buildings=[]))
    assert response.status_code == 422
    assert "at least one building" in response.text


def test_the_export_script_uses_the_same_transform():
    """Two copies of the elbow maths is how the table and the file drift."""
    source = (Path(__file__).resolve().parents[1] /
              "scripts" / "export_mr_layer.py").read_text(encoding="utf-8")
    assert "from app.services.mr_layer import build_layer" in source
    assert "def elbow" not in source


# ------------------------------------------------------------ community PV

def community_definition() -> dict:
    """The same community plus a ground array attached to no building."""
    payload = definition()
    payload["pv_plants"] = payload["pv_plants"] + [
        {"name": "Ground array", "surface_area": 4000.0,
         "percentage": 80.0, "slope": 35.0},
    ]
    return payload


@pytest.fixture
def community_pv_layer(client):
    response = client.post("/api/mr/layer", json=community_definition())
    assert response.status_code == 200, response.text
    return response.json()


def test_a_ground_array_is_drawn(community_pv_layer):
    """It was dispatched, counted in every KPI, and drawn nowhere.

    Its node id is "PV_{name}" with no "_PV_" separator, so the lookup that puts
    a roof array on its host building found nothing and skipped it - the one
    asset you could add and then not find on the table.
    """
    pv = [f for f in community_pv_layer["nodes"]["features"]
          if f["properties"]["kind"] == "pv"]
    community = [f for f in pv if "_PV_" not in f["properties"]["id"]]
    assert len(community) == 1
    assert community[0]["properties"]["id"] == "PV_Ground array"
    assert community[0]["properties"]["capacity"] > 0


def test_a_ground_array_sits_with_the_shared_assets(community_pv_layer):
    """It belongs to no building, so it goes to the middle of the community
    with the grid tie and the battery rather than onto somebody's roof."""
    nodes = community_pv_layer["nodes"]["features"]
    ground = next(f for f in nodes
                  if f["properties"]["kind"] == "pv"
                  and "_PV_" not in f["properties"]["id"])
    buildings = [f for f in nodes if f["properties"]["kind"] == "building"]

    anchor = (
        sum(f["geometry"]["coordinates"][0] for f in buildings) / len(buildings),
        sum(f["geometry"]["coordinates"][1] for f in buildings) / len(buildings),
    )
    point = ground["geometry"]["coordinates"]
    spread = math.dist(point, anchor)
    # The shared assets ring the anchor at ANCHOR_SPREAD_DEG, x-scaled by 1.85.
    assert spread <= mr_layer.ANCHOR_SPREAD_DEG * 1.85 * 1.1

    for building in buildings:
        assert point != building["geometry"]["coordinates"]


def test_a_ground_array_feeds_the_community(community_pv_layer):
    flows = [f for f in community_pv_layer["flows"]["features"]
             if f["properties"]["source"] == "PV_Ground array"]
    assert flows
    assert all(f["properties"]["kind"] == "pv" for f in flows)


def test_roof_arrays_still_land_on_their_host(community_pv_layer):
    """Adding the community case must not move the roof case."""
    nodes = {f["properties"]["id"]: f for f in community_pv_layer["nodes"]["features"]}
    roof = next(f for key, f in nodes.items()
                if f["properties"]["kind"] == "pv" and "_PV_" in key)
    host = nodes[roof["properties"]["host"]]
    assert roof["geometry"]["coordinates"] == host["geometry"]["coordinates"]
