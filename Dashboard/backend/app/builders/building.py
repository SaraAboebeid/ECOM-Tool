"""Turn a BuildingSpec into an ECOMToolkit Building."""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Mapping, Optional

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.schemas.building import BuildingSpec

from ECOMToolkit.entities import Building


@lru_cache(maxsize=256)
def _load_demand_csv(path: str, mtime: float) -> tuple[float, ...]:
    """Read an 8760-row demand CSV once and keep it.

    A campus definition references one CSV per building, and re-reading all of
    them costs about a second per dispatch - the dominant build cost when a
    slider moves. Keyed on mtime so editing a CSV invalidates the entry.
    """
    from ECOMToolkit.analysis.data import HourlyData

    hourly = HourlyData.from_csv(path)
    return tuple(float(v) for v in hourly.df["value"].tolist())


def load_demand_csv(path: str) -> list[float]:
    try:
        mtime = os.path.getmtime(path)
    except OSError as err:
        raise BuildingBuildError(f"demand CSV {path!r}: {err}") from err
    return list(_load_demand_csv(path, mtime))


class BuildingBuildError(ValueError):
    """Raised with the offending building named, rather than a bare ValueError
    from somewhere inside the toolkit."""


def build_building(
    spec: BuildingSpec,
    pv_plants: Optional[Mapping[str, object]] = None,
) -> Building:
    """Construct a toolkit Building from a specification.

    pv_plants maps plant name -> already-built PVPlant object. Only the plants
    named in spec.pv_plants are attached.
    """
    available = dict(pv_plants or {})
    missing = [n for n in spec.pv_plants if n not in available]
    if missing:
        raise BuildingBuildError(
            f"building {spec.name!r} references unknown PV plant(s): {missing}. "
            f"Known plants: {sorted(available) or 'none'}"
        )
    attached = [available[n] for n in spec.pv_plants]

    # CSVs are read through a cache rather than handed to the toolkit as a
    # path, so a campus of 36 buildings does not re-parse 36 files per request.
    # HourlyData.from_csv is still the reader, just memoised.
    demand_values = spec.demand.to_hourly_values()
    if demand_values is None:
        demand_values = load_demand_csv(spec.demand.csv_path)
    electric_demand = demand_values

    try:
        building = Building(
            name=spec.name,
            footprints=spec.footprint_area,   # numeric area, no Rhino needed
            building_type=spec.building_type,
            occupancy_schedule=None,
            electric_demand=electric_demand,
            PV_plant=attached,
            owner=spec.owner,
            convert_schedule_to_df=False,
            breps=None,
            number_of_floors=spec.number_of_floors,
            point=None,
        )
    except Exception as err:
        raise BuildingBuildError(f"building {spec.name!r}: {err}") from err

    # Building derives x/y from a Rhino Point3d, which does not exist here, so
    # coordinates are assigned from the spec instead.
    if spec.location is not None:
        building.x = spec.location.x
        building.y = spec.location.y

    expected = spec.total_area
    if abs(building.area - expected) > 1e-6:
        raise BuildingBuildError(
            f"building {spec.name!r}: expected area {expected} m2 "
            f"({spec.footprint_area} x {spec.number_of_floors} floors) but the "
            f"toolkit computed {building.area}. The numeric-footprint path in "
            f"Building.__init__ may have changed."
        )

    return building
