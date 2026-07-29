"""Turn a BatterySpec into an ECOMToolkit Battery."""
from __future__ import annotations

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.schemas.battery import BatterySpec

from ECOMToolkit.entities import Battery


class BatteryBuildError(ValueError):
    """Raised with the offending battery named."""


def build_battery(spec: BatterySpec) -> Battery:
    try:
        battery = Battery(
            name=spec.name,
            capacity=spec.capacity,
            point=None,                      # no Rhino geometry in the backend
            cost=spec.cost_per_kwh,
            embodied_co2=spec.embodied_co2_per_kwh,
            efficiency=spec.efficiency,
            lifespan=spec.lifespan,
            degradation=spec.degradation,
            initial_soc=spec.initial_soc_kwh,  # toolkit wants kWh, not a fraction
        )
    except Exception as err:
        raise BatteryBuildError(f"battery {spec.name!r}: {err}") from err

    # Battery.validate() returns a message string rather than raising, so an
    # invalid battery would otherwise flow silently into the dispatch.
    message = battery.validate()
    if message.startswith("Error:"):
        raise BatteryBuildError(f"battery {spec.name!r}: {message[len('Error: '):]}")

    if spec.location is not None:
        battery.x = spec.location.x
        battery.y = spec.location.y

    if abs(battery.initial_soc - spec.initial_soc_kwh) > 1e-6:
        raise BatteryBuildError(
            f"battery {spec.name!r}: requested {spec.initial_soc_kwh} kWh initial "
            f"charge ({spec.initial_soc_fraction:.0%} of {spec.capacity} kWh) but "
            f"the toolkit stored {battery.initial_soc}. It clamps to [0, capacity]."
        )

    return battery
