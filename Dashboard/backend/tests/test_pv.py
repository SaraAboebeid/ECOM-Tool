"""PV entity: sizing, orientation control, and the PVGIS cache.

No test here touches the network - a fake provider stands in for PVGIS.
"""
import sys
from pathlib import Path

import pandas as pd
import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.builders.pv import PVBuildError, build_pv_module, build_pv_plant
from app.schemas.pv import PVModuleSpec, PVPlantSpec
from app.services import pvgis_cache
from app.services.pvgis_cache import (HOURS_PER_YEAR, Orientation, PVGISCache,
                                      PVGISUnavailable, uninstall_provider)


@pytest.fixture
def fake_pvgis(monkeypatch):
    """Replace PVGIS with a deterministic 1 kWp profile and count the calls."""
    calls = []

    def _fetch(self, orientation):
        calls.append(orientation)
        # Tilted south yields more than flat, so orientation effects are visible.
        base = 0.10 + 0.02 * (orientation.slope / 30.0)
        return [base * 1000.0] * HOURS_PER_YEAR

    monkeypatch.setattr(PVGISCache, "_fetch_per_kwp", _fetch)
    return calls


@pytest.fixture
def cache(tmp_path, fake_pvgis):
    c = PVGISCache(cache_dir=tmp_path / "pvgis")
    c.install_provider()
    yield c, fake_pvgis
    uninstall_provider()


def make_spec(**overrides):
    base = dict(name="Roof-A", surface_area=1000.0, percentage=70.0, slope=30.0, azimuth=0.0)
    base.update(overrides)
    return PVPlantSpec(**base)


# ---------------------------------------------------------------- sizing

def test_module_count_floors_to_whole_panels():
    # 1000 m2 x 70% = 700 m2 usable, 2 m2 per panel -> 350 panels
    spec = make_spec()
    assert spec.usable_area == pytest.approx(700.0)
    assert spec.module_count == 350
    assert spec.installed_capacity == pytest.approx(140.0)  # 350 x 400 W


def test_spec_capacity_matches_toolkit(cache):
    spec = make_spec()
    plant = build_pv_plant(spec)
    assert plant.installed_capacity == pytest.approx(spec.installed_capacity)


def test_percentage_bounds_enforced():
    with pytest.raises(ValidationError):
        make_spec(percentage=0)
    with pytest.raises(ValidationError):
        make_spec(percentage=101)


def test_azimuth_bounds_enforced():
    with pytest.raises(ValidationError):
        make_spec(azimuth=360)


# ---------------------------------------------------------------- orientation

def test_azimuth_reaches_the_toolkit(cache):
    """The gap this fixes: without custom_azimuth every plant faced due south."""
    plant = build_pv_plant(make_spec(azimuth=270.0))
    assert plant.azimuth == pytest.approx(270.0)


def test_slope_reaches_the_toolkit(cache):
    plant = build_pv_plant(make_spec(slope=45.0))
    assert plant.slope == pytest.approx(45.0)


def test_different_orientations_are_separate_cache_entries(cache):
    _, calls = cache
    build_pv_plant(make_spec(name="A", azimuth=0.0))
    build_pv_plant(make_spec(name="B", azimuth=180.0))
    assert len(calls) == 2


# ---------------------------------------------------------------- caching

def test_capacity_change_costs_no_network_call(cache):
    """The point of the cache: resizing a plant must not re-query PVGIS."""
    c, calls = cache
    build_pv_plant(make_spec(name="A", surface_area=1000.0))
    assert len(calls) == 1

    for area in (2000.0, 3000.0, 4000.0, 5000.0):
        build_pv_plant(make_spec(name=f"A{area}", surface_area=area))

    assert len(calls) == 1, "resizing should reuse the per-kWp profile"
    assert c.stats["network_calls"] == 1


def test_production_scales_linearly_with_capacity(cache):
    small = build_pv_plant(make_spec(name="S", surface_area=1000.0))
    big = build_pv_plant(make_spec(name="B", surface_area=2000.0))
    ratio = big.installed_capacity / small.installed_capacity
    assert big.annual_production == pytest.approx(small.annual_production * ratio)


def test_disk_cache_survives_a_new_process(tmp_path, fake_pvgis):
    first = PVGISCache(cache_dir=tmp_path / "pvgis")
    first.install_provider()
    build_pv_plant(make_spec())
    assert len(fake_pvgis) == 1
    uninstall_provider()

    # A fresh cache object with an empty memory dict, same folder on disk.
    second = PVGISCache(cache_dir=tmp_path / "pvgis")
    second.install_provider()
    build_pv_plant(make_spec(name="Roof-B"))
    uninstall_provider()

    assert len(fake_pvgis) == 1, "should have been served from disk"
    assert second.stats["disk_hits"] == 1


def test_offline_without_cache_raises(tmp_path):
    c = PVGISCache(cache_dir=tmp_path / "pvgis", allow_network=False)
    with pytest.raises(PVGISUnavailable, match="network access is disabled"):
        c.profile_per_kwp(Orientation(57.7, 12.0, 30.0, 0.0, 14.0))


# ---------------------------------------------------------------- failure modes

def test_pvgis_failure_is_an_error_not_zero_production(monkeypatch, tmp_path):
    """A failed lookup must not reach the dashboard as 'produces nothing'."""
    c = PVGISCache(cache_dir=tmp_path / "pvgis")

    def _boom(plant):
        plant.pvgis_error = "connection timed out"
        return pd.DataFrame(), 0.0

    monkeypatch.setattr(pvgis_cache.pv_plant_module, "PVGIS_PROVIDER", _boom)
    try:
        with pytest.raises(PVBuildError, match="PVGIS lookup failed"):
            build_pv_plant(make_spec())
    finally:
        uninstall_provider()


def test_non_strict_allows_zero_production(monkeypatch, tmp_path):
    def _boom(plant):
        plant.pvgis_error = "connection timed out"
        return pd.DataFrame(), 0.0

    monkeypatch.setattr(pvgis_cache.pv_plant_module, "PVGIS_PROVIDER", _boom)
    try:
        plant = build_pv_plant(make_spec(), strict=False)
        assert plant.annual_production == 0.0
        assert plant.pvgis_error == "connection timed out"
    finally:
        uninstall_provider()


# ---------------------------------------------------------------- module

def test_module_defaults_match_toolkit():
    m = build_pv_module(PVModuleSpec())
    assert m.rating == 400.0
    assert m.area == pytest.approx(2.0)


def test_custom_module_changes_panel_count():
    big_panel = PVModuleSpec(name="Big", rating=600, size_x=1.2, size_y=2.2)
    spec = make_spec(module=big_panel)
    assert spec.module_count == int(700 // 2.64)
