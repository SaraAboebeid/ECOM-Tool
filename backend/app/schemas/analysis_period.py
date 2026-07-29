"""Calendar-based analysis period.

The Grasshopper definitions use a Ladybug AnalysisPeriod. The dashboard needs
the same slice of the year expressed as JSON, and users think in dates rather
than hours of the year, so this converts month/day/hour to the HOY range the
toolkit expects.

The hour-of-year convention matches Ladybug - hoy 0 is 1 January 00:00 on a
365-day calendar, so 1 June 00:00 is 3624. test_analysis_period cross-checks
this against Ladybug itself whenever it is installed, so the two cannot drift.

DIVERGENCE FROM LADYBUG - READ THIS
    In Ladybug, start_hour and end_hour are a *daily* filter, not the endpoints
    of a range. AnalysisPeriod(3, 15, 6, 9, 30, 18) means "06:00 to 18:00 on
    every day from 15 March to 30 September" - 2600 non-contiguous hours.

    This spec models a *continuous* block: 15 March 06:00 straight through to
    30 September 18:00, 4789 hours.

    Continuous is the only form the toolkit can use. Grid.__init__ unpacks
    `self.start_hour, self.end_hour = self._prepare_period(period)`, so it needs
    a 2-tuple; a list of hours of the year fails to unpack, and a Ladybug
    AnalysisPeriod object is rejected outright by _prepare_period.

    The two agree exactly when start_hour is 0 and end_hour is 23, which is how
    whole-day periods are expressed. The tests assert that agreement and pin the
    divergence separately.

Ladybug is deliberately not a dependency: it is a large install, and the
arithmetic is a day-of-year offset.
"""
from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

HOURS_PER_YEAR = 8760
DAYS_PER_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_MONTH_START_DAY = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)

MONTH_NAMES = ("January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December")


def day_of_year(month: int, day: int) -> int:
    """1-based day of a 365-day year. 1 January is 1."""
    return _MONTH_START_DAY[month - 1] + day


def hour_of_year(month: int, day: int, hour: int) -> int:
    """0-based hour of year, matching Ladybug. 1 January 00:00 is 0."""
    return (day_of_year(month, day) - 1) * 24 + hour


class AnalysisPeriodSpec(BaseModel):
    """A slice of the year, inclusive at both ends.

    Leap days are not modelled, matching the toolkit's fixed 8760-hour year.
    """

    model_config = ConfigDict(extra="forbid")

    start_month: Annotated[int, Field(ge=1, le=12)] = 1
    start_day: Annotated[int, Field(ge=1, le=31)] = 1
    start_hour: Annotated[int, Field(ge=0, le=23)] = 0

    end_month: Annotated[int, Field(ge=1, le=12)] = 12
    end_day: Annotated[int, Field(ge=1, le=31)] = 31
    end_hour: Annotated[int, Field(ge=0, le=23)] = 23

    @model_validator(mode="after")
    def _check(self) -> "AnalysisPeriodSpec":
        for label, month, day in (("start", self.start_month, self.start_day),
                                  ("end", self.end_month, self.end_day)):
            limit = DAYS_PER_MONTH[month - 1]
            if day > limit:
                raise ValueError(
                    f"{label}_day {day} does not exist in {MONTH_NAMES[month - 1]}, "
                    f"which has {limit} days"
                    + (" (leap days are not modelled)" if month == 2 else "")
                )

        if self.end_hoy < self.start_hoy:
            # Ladybug supports periods that wrap the new year, but
            # ECOMDispatcher._prepare_period takes a plain (start, end) tuple
            # and would silently produce an empty range.
            raise ValueError(
                f"the period ends before it starts "
                f"({MONTH_NAMES[self.start_month - 1]} {self.start_day} -> "
                f"{MONTH_NAMES[self.end_month - 1]} {self.end_day}). "
                f"Periods that wrap the new year are not supported."
            )
        return self

    # -------------------------------------------------- derived

    @property
    def start_hoy(self) -> int:
        return hour_of_year(self.start_month, self.start_day, self.start_hour)

    @property
    def end_hoy(self) -> int:
        return hour_of_year(self.end_month, self.end_day, self.end_hour)

    @property
    def n_hours(self) -> int:
        return self.end_hoy - self.start_hoy + 1

    @property
    def n_days(self) -> float:
        return self.n_hours / 24.0

    @property
    def as_tuple(self) -> tuple[int, int]:
        """The (start, end) form the toolkit entities expect."""
        return (self.start_hoy, self.end_hoy)

    @property
    def hoys(self) -> list[int]:
        return list(range(self.start_hoy, self.end_hoy + 1))

    @property
    def label(self) -> str:
        return (f"{MONTH_NAMES[self.start_month - 1]} {self.start_day} "
                f"{self.start_hour:02d}:00 - "
                f"{MONTH_NAMES[self.end_month - 1]} {self.end_day} "
                f"{self.end_hour:02d}:00 ({self.n_hours} h)")

    @classmethod
    def full_year(cls) -> "AnalysisPeriodSpec":
        return cls()
