"""Grid, prices and the Nord Pool client. No test touches the network."""
import json
import sys
from datetime import date
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.builders.grid import GridBuildError, build_grid
from app.schemas.grid import (HOURS_PER_YEAR, TOOLKIT_DEFAULT_PRICE, CarbonSpec,
                              GridSpec, PriceSpec)
from app.services.nordpool import NordPoolClient, NordPoolUnavailable


# ---------------------------------------------------------------- price expand

def test_fixed_covers_the_year():
    values = PriceSpec(fixed=1.2).expand()
    assert len(values) == HOURS_PER_YEAR
    assert set(values) == {1.2}


def test_short_series_never_inherits_the_toolkit_default():
    """The trap: Grid back-fills unspecified hours with 1.5 SEK/kWh."""
    values = PriceSpec(hourly=[0.5] * 48).expand()
    assert len(values) == HOURS_PER_YEAR
    assert TOOLKIT_DEFAULT_PRICE not in set(values)


def test_repeat_fill_tiles_the_series():
    values = PriceSpec(hourly=[1.0, 2.0], fill="repeat").expand()
    assert values[:4] == [1.0, 2.0, 1.0, 2.0]
    assert len(values) == HOURS_PER_YEAR


def test_mean_fill_pads_with_the_average():
    values = PriceSpec(hourly=[1.0, 3.0], fill="mean").expand()
    assert values[:2] == [1.0, 3.0]
    assert values[2] == pytest.approx(2.0)


def test_value_fill_requires_a_value():
    with pytest.raises(ValidationError, match="requires fill_value"):
        PriceSpec(hourly=[1.0], fill="value")


def test_value_fill_uses_it():
    values = PriceSpec(hourly=[1.0], fill="value", fill_value=0.0).expand()
    assert values[1] == 0.0


def test_long_series_is_truncated():
    assert len(PriceSpec(hourly=[1.0] * 9000).expand()) == HOURS_PER_YEAR


def test_exactly_one_source_required():
    with pytest.raises(ValidationError, match="exactly one of"):
        PriceSpec(fixed=1.0, hourly=[1.0])
    with pytest.raises(ValidationError, match="exactly one of"):
        PriceSpec()


def test_partial_nordpool_rejected():
    with pytest.raises(ValidationError, match="needs all of"):
        PriceSpec(nordpool_area="SE3", nordpool_start="2024-01-01")


# ---------------------------------------------------------------- grid build

def test_builds_with_defaults():
    grid = build_grid(GridSpec())
    assert grid.n_hours == HOURS_PER_YEAR
    assert grid.name == "Grid"


def test_name_is_set_for_community_validate():
    """Grid never sets a name, but EnergyCommunity.validate reads one."""
    grid = build_grid(GridSpec(name="SE3 connection"))
    assert getattr(grid, "name") == "SE3 connection"


def test_prices_reach_the_toolkit():
    spec = GridSpec(buying_price=PriceSpec(fixed=2.5), selling_price=PriceSpec(fixed=0.25))
    grid = build_grid(spec)
    assert grid.electricity_market_buying_price.df["value"].iloc[0] == pytest.approx(2.5)
    assert grid.electricity_market_selling_price.df["value"].iloc[0] == pytest.approx(0.25)


def test_short_price_series_does_not_leak_the_default_into_the_grid():
    spec = GridSpec(
        buying_price=PriceSpec(hourly=[0.5] * 48, fill="value", fill_value=0.9),
        analysis_start_hour=0,
        analysis_end_hour=47,
    )
    grid = build_grid(spec)
    values = grid.electricity_market_buying_price.df["value"].tolist()
    assert values[:48] == [0.5] * 48
    assert set(values[48:]) == {0.9}
    assert TOOLKIT_DEFAULT_PRICE not in set(values)


def test_analysis_period_reaches_the_grid():
    grid = build_grid(GridSpec(analysis_start_hour=0, analysis_end_hour=47))
    assert grid.n_hours == 48


def test_reversed_period_rejected():
    with pytest.raises(ValidationError, match="is before"):
        GridSpec(analysis_start_hour=100, analysis_end_hour=50)


def test_carbon_intensity_reaches_the_grid():
    grid = build_grid(GridSpec(carbon_intensity=CarbonSpec(fixed=33.0)))
    assert grid.electricity_market_carbon_intensity.df["value"].iloc[0] == pytest.approx(33.0)


def test_nordpool_without_client_is_an_error():
    spec = GridSpec(buying_price=PriceSpec(
        nordpool_area="SE3", nordpool_start="2024-01-01", nordpool_end="2024-01-02"))
    with pytest.raises(GridBuildError, match="no NordPoolClient"):
        build_grid(spec)


# ---------------------------------------------------------------- nordpool

def _entry(hour, price, day="2024-01-01"):
    return {"deliveryStart": f"{day}T{hour:02d}:00:00Z",
            "entryPerArea": {"SE3": price}}


def test_parse_converts_mwh_to_kwh():
    data = {"multiAreaEntries": [_entry(0, 500.0), _entry(1, 1000.0)]}
    stamps, prices = NordPoolClient._parse(data, "SE3", date(2024, 1, 1))
    assert prices == [0.5, 1.0]
    assert stamps[0].startswith("2024-01-01T00:00")


def test_parse_uses_api_timestamps_not_the_index():
    """A 23-hour DST day would misalign if timestamps came from list position."""
    data = {"multiAreaEntries": [_entry(0, 100.0), _entry(3, 200.0)]}
    stamps, _ = NordPoolClient._parse(data, "SE3", date(2024, 1, 1))
    assert "T03:00" in stamps[1]


def test_parse_skips_other_areas():
    data = {"multiAreaEntries": [
        {"deliveryStart": "x", "entryPerArea": {"SE4": 100.0}},
        _entry(1, 200.0),
    ]}
    _, prices = NordPoolClient._parse(data, "SE3", date(2024, 1, 1))
    assert prices == [0.2]


def test_parse_empty_raises():
    with pytest.raises(NordPoolUnavailable, match="no entries"):
        NordPoolClient._parse({"multiAreaEntries": []}, "SE3", date(2024, 1, 1))


def test_offline_without_cache_raises(tmp_path):
    client = NordPoolClient(cache_dir=tmp_path, allow_network=False)
    with pytest.raises(NordPoolUnavailable, match="No Nord Pool prices"):
        client.fetch_range("SE3", "2024-01-01", "2024-01-02")


def test_cache_is_used_and_missing_days_recorded(tmp_path):
    client = NordPoolClient(cache_dir=tmp_path, allow_network=False)
    path = client._cache_path("SE3", date(2024, 1, 1), "SEK")
    path.write_text(json.dumps({"timestamps": ["t"] * 24, "prices": [0.4] * 24}),
                    encoding="utf-8")

    series = client.fetch_range("SE3", "2024-01-01", "2024-01-02")
    assert len(series) == 24
    assert series.average == pytest.approx(0.4)
    # Day two had no cache and no network: recorded, not silently dropped.
    assert series.missing_days == ["2024-01-02"]
    assert client.stats["cache_hits"] == 1


def test_reversed_date_range_rejected(tmp_path):
    client = NordPoolClient(cache_dir=tmp_path, allow_network=False)
    with pytest.raises(ValueError, match="before start date"):
        client.fetch_range("SE3", "2024-01-05", "2024-01-01")
