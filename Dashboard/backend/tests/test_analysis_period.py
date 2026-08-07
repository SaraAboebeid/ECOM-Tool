"""Analysis period, cross-checked against Ladybug so the conventions cannot drift."""
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas.analysis_period import (HOURS_PER_YEAR, AnalysisPeriodSpec,
                                         hour_of_year)

ladybug_ap = pytest.importorskip("ladybug.analysisperiod", reason="ladybug not installed")


# ---------------------------------------------------------------- convention

@pytest.mark.parametrize("month,day,hour,expected", [
    (1, 1, 0, 0),
    (1, 1, 23, 23),
    (1, 2, 0, 24),
    (6, 1, 0, 3624),      # verified against Ladybug
    (12, 31, 23, 8759),
])
def test_known_hours_of_year(month, day, hour, expected):
    assert hour_of_year(month, day, hour) == expected


@pytest.mark.parametrize("period", [
    (1, 1, 0, 1, 1, 23),
    (6, 1, 0, 6, 7, 23),
    (1, 1, 0, 12, 31, 23),
    (2, 28, 0, 3, 1, 23),
    (7, 4, 0, 8, 20, 23),
])
def test_matches_ladybug_for_whole_day_periods(period):
    """Definitions come from Grasshopper, so whole-day periods must line up with
    Ladybug's hours of the year exactly. Sub-day periods diverge by design - see
    test_ladybug_hour_filter_is_per_day."""
    sm, sd, sh, em, ed, eh = period
    lb = ladybug_ap.AnalysisPeriod(sm, sd, sh, em, ed, eh, 1)
    lb_hoys = [int(h) for h in lb.hoys]

    spec = AnalysisPeriodSpec(
        start_month=sm, start_day=sd, start_hour=sh,
        end_month=em, end_day=ed, end_hour=eh,
    )
    assert spec.start_hoy == lb_hoys[0]
    assert spec.end_hoy == lb_hoys[-1]
    assert spec.n_hours == len(lb_hoys)
    assert spec.hoys == lb_hoys


def test_ladybug_hour_filter_is_per_day():
    """Pins the divergence so nobody assumes the two are interchangeable.

    Ladybug reads start_hour/end_hour as a daily window; this spec reads them as
    the endpoints of one continuous block. Only the continuous form can reach
    the toolkit, because Grid.__init__ unpacks a 2-tuple.
    """
    lb = ladybug_ap.AnalysisPeriod(3, 15, 6, 9, 30, 18, 1)
    spec = AnalysisPeriodSpec(start_month=3, start_day=15, start_hour=6,
                              end_month=9, end_day=30, end_hour=18)

    assert len(lb.hoys) == 2600      # 200 days x 13 hours, non-contiguous
    assert spec.n_hours == 4789      # one continuous block
    assert spec.start_hoy == int(lb.hoys[0])   # same start
    assert spec.end_hoy == int(lb.hoys[-1])    # same end
    assert spec.hoys == list(range(spec.start_hoy, spec.end_hoy + 1))


def test_full_year_covers_8760_hours():
    spec = AnalysisPeriodSpec.full_year()
    assert spec.start_hoy == 0
    assert spec.end_hoy == HOURS_PER_YEAR - 1
    assert spec.n_hours == HOURS_PER_YEAR


# ---------------------------------------------------------------- derived

def test_tuple_form_for_the_toolkit():
    spec = AnalysisPeriodSpec(start_month=6, start_day=1, start_hour=0,
                              end_month=6, end_day=2, end_hour=23)
    assert spec.as_tuple == (3624, 3671)
    assert spec.n_hours == 48
    assert spec.n_days == pytest.approx(2.0)


def test_label_is_readable():
    spec = AnalysisPeriodSpec(start_month=6, start_day=1, start_hour=0,
                              end_month=6, end_day=7, end_hour=23)
    assert spec.label == "June 1 00:00 - June 7 23:00 (168 h)"


# ---------------------------------------------------------------- validation

def test_impossible_date_rejected():
    with pytest.raises(ValidationError, match="does not exist in June"):
        AnalysisPeriodSpec(start_month=6, start_day=31)


def test_leap_day_rejected_with_explanation():
    with pytest.raises(ValidationError, match="leap days are not modelled"):
        AnalysisPeriodSpec(start_month=2, start_day=29)


def test_wrapping_period_rejected():
    """Ladybug allows Dec -> Feb, but ECOMDispatcher takes a plain (start, end)
    tuple and would produce an empty range."""
    with pytest.raises(ValidationError, match="wrap the new year"):
        AnalysisPeriodSpec(start_month=12, start_day=1, end_month=2, end_day=1)


def test_out_of_range_month_rejected():
    with pytest.raises(ValidationError):
        AnalysisPeriodSpec(start_month=13)


def test_out_of_range_hour_rejected():
    with pytest.raises(ValidationError):
        AnalysisPeriodSpec(start_hour=24)
