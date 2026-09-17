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


# ------------------------------------------------------------- footprints

def _seam(lon0, lon1, lat):
    """A ring that runs out along a line and straight back: what a join
    between two parts of a footprint was left behind as. No area, 30 m long."""
    return [[lon0, lat], [lon1, lat], [lon1, lat + 1e-9], [lon0, lat]]


def _drawn(layer_json, footprint_id):
    return next(f["geometry"] for f in layer_json["buildings"]["features"]
                if f["properties"]["id"] == footprint_id)


def _use_footprints(monkeypatch, *features):
    text = json.dumps({"type": "FeatureCollection", "features": list(features)})
    monkeypatch.setattr(mr_layer, "_footprint_text", lambda: text)


def test_a_seam_is_not_drawn_as_part_of_the_building(client, monkeypatch):
    """The table strokes every ring of a footprint, so a seam comes out as a
    bright line across the roof. A real courtyard is a ring too, and stays."""
    outer = square(11.973, 57.688)[0]
    courtyard = square(11.9731, 57.6881, size=0.0001)[0]
    _use_footprints(
        monkeypatch,
        {"type": "Feature", "properties": {"id": "hall-a"},
         "geometry": {"type": "Polygon", "coordinates": [
             outer, _seam(11.9730, 11.9735, 57.6883), courtyard]}},
        {"type": "Feature", "properties": {"id": "idealara"},
         "geometry": {"type": "Polygon", "coordinates": square(11.976, 57.689)}},
    )
    response = client.post("/api/mr/layer", json=definition())
    assert response.status_code == 200, response.text

    geometry = _drawn(response.json(), "hall-a")
    assert geometry["coordinates"] == [outer, courtyard]


def test_a_sliver_part_goes_with_its_seam(client, monkeypatch):
    """A part whose outer ring has no width has nothing inside it to keep."""
    _use_footprints(
        monkeypatch,
        {"type": "Feature", "properties": {"id": "hall-a"},
         "geometry": {"type": "MultiPolygon", "coordinates": [
             square(11.973, 57.688), [_seam(11.9740, 11.9745, 57.6885)]]}},
        {"type": "Feature", "properties": {"id": "idealara"},
         "geometry": {"type": "Polygon", "coordinates": square(11.976, 57.689)}},
    )
    response = client.post("/api/mr/layer", json=definition())
    assert response.status_code == 200, response.text

    geometry = _drawn(response.json(), "hall-a")
    assert geometry == {"type": "Polygon",
                        "coordinates": square(11.973, 57.688)}


def test_a_footprint_that_is_nothing_but_seams_is_left_alone():
    """Better a stray line on the table than a building that silently isn't."""
    geometry = {"type": "Polygon",
                "coordinates": [_seam(11.9730, 11.9735, 57.6883)]}
    assert mr_layer._without_seams(geometry) == geometry


def test_the_campus_footprints_carry_no_seams():
    """The real file, not a stub: every ring the table strokes is a shape."""
    geo = json.loads(mr_layer.FOOTPRINTS.read_text(encoding="utf-8"))
    for feature in geo["features"]:
        feature["geometry"] = mr_layer._without_seams(feature["geometry"])

    rings = [ring for f in geo["features"] for ring in mr_layer._rings_of(f)]
    assert rings
    assert min(mr_layer._ring_width(r) for r in rings) >= mr_layer.SEAM_WIDTH_M

    # And the courtyards EDIT is built around are still open.
    edit = next(f for f in geo["features"] if f["properties"]["id"] == "edit")
    assert len(edit["geometry"]["coordinates"]) == 3     # outer + 2 courtyards


def _campus():
    return json.loads(mr_layer.FOOTPRINTS.read_text(encoding="utf-8"))["features"]


def test_the_table_draws_the_mr_studios_outlines():
    """Lantmäteriet's buildings, as every other layer on the table has them -
    not the Rhino model's. A building that falls back is one the MR Studio's
    footprints do not have, and worth knowing about."""
    fallen_back = [f["properties"]["id"] for f in _campus()
                   if f["properties"].get("geometry_source") != "Lantmäteriet"]
    assert fallen_back == []


def test_no_campus_building_is_drawn_in_pieces_that_share_a_wall():
    """Each piece of a footprint is stroked, so two pieces meeting along a wall
    draw a line across the roof. Pieces are fine; pieces touching are not."""
    def to_m(point, origin):
        kx = 111_320.0 * math.cos(math.radians(origin[1]))
        return ((point[0] - origin[0]) * kx, (point[1] - origin[1]) * 110_540.0)

    def gap(a, b):
        """Nearest approach of two rings, vertex to edge, in metres."""
        def point_to_segment(p, s, e):
            dx, dy = e[0] - s[0], e[1] - s[1]
            length = dx * dx + dy * dy
            t = 0 if not length else max(0, min(1, ((p[0] - s[0]) * dx
                                                    + (p[1] - s[1]) * dy) / length))
            return math.dist(p, (s[0] + t * dx, s[1] + t * dy))
        return min(min(point_to_segment(p, s, e) for s, e in zip(b, b[1:])
                       for p in a),
                   min(point_to_segment(p, s, e) for s, e in zip(a, a[1:])
                       for p in b))

    touching = []
    for feature in _campus():
        geometry = feature["geometry"]
        if geometry["type"] != "MultiPolygon":
            continue
        origin = geometry["coordinates"][0][0][0]
        outers = [[to_m(p, origin) for p in part[0]]
                  for part in geometry["coordinates"]]
        for i in range(len(outers)):
            for j in range(i + 1, len(outers)):
                if gap(outers[i], outers[j]) < 0.2:
                    touching.append(feature["properties"]["id"])
    assert touching == []


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


def _centre_of(ring):
    """The same average the layer takes, so the two cannot drift apart."""
    points = ring[0]
    return (sum(p[0] for p in points) / len(points),
            sum(p[1] for p in points) / len(points))


def _asset(layer, kind):
    return next(f for f in layer["nodes"]["features"]
                if f["properties"]["kind"] == kind)


def test_a_battery_stands_in_the_building_that_hosts_it(client):
    """A community battery is a cabinet in a plant room, not a thing in a field.

    'not-a-member' is deliberate: a landlord can put a battery in a building
    whose meter is not in the scheme. (On the campus AWL was exactly that until
    its measurements arrived.)

    In the middle of the building, not the average of its corners. The corner
    average counts the ring's closing point twice, which drags it toward one
    corner, and for a footprint in several parts it lands between them - AWL's
    battery stood on the wall where two of its blocks meet.
    """
    spec = definition(batteries=[{"name": "BAT01", "capacity": 500.0,
                                  "host": "not-a-member"}])
    layer = client.post("/api/mr/layer", json=spec).json()

    lon, lat = _asset(layer, "battery")["geometry"]["coordinates"]
    # square(11.980, 57.690) is 0.0004 on a side: its middle is half that in.
    assert (lon, lat) == pytest.approx((11.9802, 57.6902), abs=1e-9)


def test_a_battery_in_a_building_of_several_parts_stands_in_the_largest(client, monkeypatch):
    """A small annexe must not pull the battery out onto the join between blocks."""
    main = square(11.980, 57.690)[0]
    annexe = square(11.9806, 57.6900, size=0.0001)[0]
    text = json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"id": "hall-a"},
         "geometry": {"type": "Polygon", "coordinates": square(11.973, 57.688)}},
        {"type": "Feature", "properties": {"id": "idealara"},
         "geometry": {"type": "Polygon", "coordinates": square(11.976, 57.689)}},
        {"type": "Feature", "properties": {"id": "plant-room"},
         "geometry": {"type": "MultiPolygon", "coordinates": [[main], [annexe]]}},
    ]})
    monkeypatch.setattr(mr_layer, "_footprint_text", lambda: text)
    spec = definition(batteries=[{"name": "BAT01", "capacity": 500.0,
                                  "host": "plant-room"}])
    layer = client.post("/api/mr/layer", json=spec).json()

    lon, lat = _asset(layer, "battery")["geometry"]["coordinates"]
    assert (lon, lat) == pytest.approx((11.9802, 57.6902), abs=1e-9)


def test_the_lines_move_with_it(client):
    """Placing the node is not enough if the flows still meet where it was."""
    spec = definition(batteries=[{"name": "BAT01", "capacity": 500.0,
                                  "host": "not-a-member"}])
    layer = client.post("/api/mr/layer", json=spec).json()

    battery = _asset(layer, "battery")
    at = battery["geometry"]["coordinates"]
    touching = [f for f in layer["flows"]["features"]
                if battery["properties"]["id"] in (f["properties"]["source"],
                                                   f["properties"]["target"])]
    assert touching, "the battery should be carrying something"
    for flow in touching:
        ends = flow["geometry"]["coordinates"]
        end = (ends[0] if flow["properties"]["source"] == battery["properties"]["id"]
               else ends[-1])
        assert end == pytest.approx(at)


def test_a_battery_with_no_host_goes_out_with_the_shared_assets(layer):
    """The default is unchanged: nowhere of its own, so out on the ring."""
    lon, lat = _asset(layer, "battery")["geometry"]["coordinates"]
    for ring in (square(11.973, 57.688), square(11.976, 57.689),
                 square(11.980, 57.690)):
        assert (lon, lat) != pytest.approx(_centre_of(ring))


def test_a_host_that_matches_no_footprint_falls_back(client):
    """A typo in a scenario file should cost a position, not the whole layer."""
    spec = definition(batteries=[{"name": "BAT01", "capacity": 500.0,
                                  "host": "no-such-building"}])
    response = client.post("/api/mr/layer", json=spec)

    assert response.status_code == 200, response.text
    battery = _asset(response.json(), "battery")
    assert battery["geometry"]["coordinates"]


SUBSTATION = {"buying_price": {"fixed": 1.2}, "selling_price": {"fixed": 0.6},
              "carbon_intensity": {"fixed": 45.0},
              "lat": 57.6915, "lon": 11.9736}


def test_the_grid_tie_stands_where_the_substation_does(client):
    """The connection to the outside world is a building on a street.

    Drawn out on the ring with the community's own assets it says the opposite,
    and the ring is a layout device rather than a place.
    """
    layer = client.post("/api/mr/layer", json=definition(grid=SUBSTATION)).json()

    lon, lat = _asset(layer, "grid")["geometry"]["coordinates"]
    assert (lat, lon) == pytest.approx((57.6915, 11.9736))


def test_the_grid_lines_move_with_it(client):
    layer = client.post("/api/mr/layer", json=definition(grid=SUBSTATION)).json()

    grid = _asset(layer, "grid")
    at = grid["geometry"]["coordinates"]
    feeds = [f for f in layer["flows"]["features"]
             if f["properties"]["source"] == grid["properties"]["id"]]
    assert feeds, "the grid should be supplying something"
    for flow in feeds:
        assert flow["geometry"]["coordinates"][0] == pytest.approx(at)


def test_a_grid_with_no_position_is_placed_as_before(layer):
    """Unchanged by default: out with the shared assets."""
    lon, lat = _asset(layer, "grid")["geometry"]["coordinates"]
    assert (lat, lon) != pytest.approx((57.6915, 11.9736))


def test_half_a_coordinate_is_refused(client):
    """A dropped longitude should be a complaint, not a tie in the wrong place."""
    half = dict(SUBSTATION)
    half.pop("lon")
    response = client.post("/api/mr/layer", json=definition(grid=half))

    assert response.status_code == 422
    assert "lat and lon" in response.text


def test_a_roof_array_lands_on_its_host(layer):
    pv = next(f for f in layer["nodes"]["features"]
              if f["properties"]["kind"] == "pv")
    host = next(f for f in layer["nodes"]["features"]
                if f["properties"]["id"] == pv["properties"]["host"])
    assert pv["geometry"]["coordinates"] == host["geometry"]["coordinates"]
    assert pv["properties"]["owner"] == host["properties"]["owner"]


# ------------------------------------------------------------------ flows

def _square_on(point, size=0.0002):
    """A little footprint ring centred on a point."""
    lon, lat = point
    return [[lon - size, lat - size], [lon + size, lat - size],
            [lon + size, lat + size], [lon - size, lat + size],
            [lon - size, lat - size]]


def test_a_route_steers_around_a_building_in_the_way():
    """The obstacle is built from the route it is meant to block.

    Placing it by hand would only prove the router avoids a square somewhere
    near the line; deriving it from the unobstructed geometry means the test
    cannot pass by luck.
    """
    a, b = (11.9730, 57.6890), (11.9760, 57.6905)
    plain = mr_layer.elbow(a, b, "A->B")

    # A building sitting on the middle of the bend.
    midpoint = plain[1]
    blocker = [_square_on(midpoint)]
    assert mr_layer._route_hits(plain, blocker) == 1, "the blocker must block"

    routed = mr_layer.elbow(a, b, "A->B", blocker)
    assert mr_layer._route_hits(routed, blocker) == 0
    # Still a route between the same two points.
    assert routed[0] == pytest.approx(list(a))
    assert routed[-1] == pytest.approx(list(b))


def test_a_clear_route_is_left_exactly_as_it_was():
    """A picture that was already right must not shuffle when routing is on."""
    a, b = (11.9730, 57.6890), (11.9760, 57.6905)
    plain = mr_layer.elbow(a, b, "A->B")
    far_away = [_square_on((11.9900, 57.6990))]

    assert mr_layer.elbow(a, b, "A->B", far_away) == plain


def test_the_campus_lines_cross_fewer_buildings_for_being_routed(layer):
    """The whole layer, measured: routed against the same links unrouted."""
    rings = mr_layer._footprint_rings(mr_layer.load_footprints())

    before = after = 0
    for flow in layer["flows"]["features"]:
        props = flow["properties"]
        own = {canonical(props["source"]), canonical(props["target"])}
        obstacles = [ring for key, group in rings.items() if key not in own
                     for ring in group]
        drawn = flow["geometry"]["coordinates"]
        after += mr_layer._route_hits(drawn, obstacles)
        before += mr_layer._route_hits(
            mr_layer.elbow(drawn[0], drawn[-1],
                           f'{props["source"]}->{props["target"]}'),
            obstacles)

    assert after <= before, "routing must never make the crossings worse"


def test_flows_are_never_drawn_straight(layer):
    """Straight lines cut diagonally across the campus grid.

    This used to assert exactly four points, which was the elbow rather than
    the claim. Flows now follow the street network where it reaches both ends -
    a dozen or more points - and fall back to a bent elbow where it does not.
    What must remain true either way is that no flow is a bare line from one
    end to the other.
    """
    assert layer["flows"]["features"]
    for feature in layer["flows"]["features"]:
        points = feature["geometry"]["coordinates"]
        assert len(points) >= 3, "a flow should bend, not cut across"
        # And it genuinely departs from the straight line between its ends,
        # rather than having extra points strung along it.
        first, last = points[0], points[-1]
        span = max(abs(last[0] - first[0]), abs(last[1] - first[1]))
        wandered = max(
            max(abs(p[0] - first[0]), abs(p[1] - first[1])) for p in points[1:-1])
        assert wandered > span * 0.05


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
