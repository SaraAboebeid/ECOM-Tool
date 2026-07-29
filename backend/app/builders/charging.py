"""Turn charging specifications into ECOMToolkit objects."""
from __future__ import annotations

from typing import Optional

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.schemas.charging import ChargePointSpec, ElectricVehicleSpec

from ECOMToolkit.entities import ChargePoint, ElectricVehicle


class ChargingBuildError(ValueError):
    """Raised with the offending charge point or vehicle named."""


def build_electric_vehicle(
    spec: ElectricVehicleSpec,
    analysis_period: Optional[tuple[int, int]] = None,
) -> ElectricVehicle:
    schedule = list(spec.availability) if spec.availability is not None else None

    try:
        ev = ElectricVehicle(
            name=spec.name,
            schedule=schedule,
            capacity=spec.capacity,
            is_hybrid=spec.is_hybrid,
            efficiency=spec.efficiency,
            daily_distance=spec.daily_distance,
            max_charging_power=spec.max_charging_power,
            v2g_enabled=spec.v2g_enabled,
            embodied_co2=spec.embodied_co2_per_kwh,
            analysis_period=analysis_period,
        )
    except Exception as err:
        raise ChargingBuildError(f"vehicle {spec.name!r}: {err}") from err

    # ElectricVehicle.validate returns a list of errors, or a string on success.
    result = ev.validate()
    if isinstance(result, list):
        raise ChargingBuildError(f"vehicle {spec.name!r}: {'; '.join(result)}")

    return ev


def build_charge_point(
    spec: ChargePointSpec,
    analysis_period: Optional[tuple[int, int]] = None,
) -> ChargePoint:
    ev_list = []
    if spec.ev is not None:
        ev_list = [build_electric_vehicle(spec.ev, analysis_period=analysis_period)]

    try:
        charge_point = ChargePoint(
            name=spec.name,
            point=None,                  # no Rhino geometry in the backend
            capacity=spec.capacity,
            charger_type=spec.charger_type,
            is_v2g=spec.is_v2g,
            owner=spec.owner,
            ev_list=ev_list,
        )
    except Exception as err:
        raise ChargingBuildError(f"charge point {spec.name!r}: {err}") from err

    # validate() returns a message rather than raising, so a broken charge point
    # would otherwise flow silently into the dispatch.
    message = charge_point.validate()
    if message.startswith("Error:"):
        raise ChargingBuildError(f"charge point {spec.name!r}: {message[len('Error: '):]}")

    if spec.location is not None:
        charge_point.x = spec.location.x
        charge_point.y = spec.location.y

    # A charge point with a vehicle attached but a flat zero demand profile means
    # the toolkit's single-EV branch did not fire, or the schedule never allows
    # charging. Either way the dispatch would show no EV load at all.
    if spec.ev is not None:
        total = float(charge_point.hourlydemand.df["value"].sum())
        if total <= 0:
            raise ChargingBuildError(
                f"charge point {spec.name!r}: vehicle {spec.ev.name!r} is attached "
                f"but the annual demand profile is zero. Check that availability "
                f"has plugged-in hours and daily_distance is greater than zero."
            )

    return charge_point
