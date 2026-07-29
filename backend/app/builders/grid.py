"""Turn a GridSpec into an ECOMToolkit Grid."""
from __future__ import annotations

from typing import Optional

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.schemas.grid import HOURS_PER_YEAR, GridSpec
from app.services.nordpool import NordPoolClient, resolve_price_values

from ECOMToolkit.entities import Grid


class GridBuildError(ValueError):
    """Raised with the offending field named."""


def build_grid(spec: GridSpec, nordpool: Optional[NordPoolClient] = None) -> Grid:
    """Construct a toolkit Grid.

    Every series is expanded to a full 8760 values first, so Grid never takes
    the branch that back-fills unspecified hours with its 1.5 SEK/kWh default.
    """
    try:
        buying = spec.buying_price.expand(resolve_price_values(spec.buying_price, nordpool))
    except Exception as err:
        raise GridBuildError(f"buying_price: {err}") from err

    try:
        selling = spec.selling_price.expand(resolve_price_values(spec.selling_price, nordpool))
    except Exception as err:
        raise GridBuildError(f"selling_price: {err}") from err

    try:
        carbon = spec.carbon_intensity.expand()
    except Exception as err:
        raise GridBuildError(f"carbon_intensity: {err}") from err

    for label, series in (("buying_price", buying), ("selling_price", selling),
                          ("carbon_intensity", carbon)):
        if len(series) != HOURS_PER_YEAR:
            raise GridBuildError(
                f"{label} expanded to {len(series)} values, expected {HOURS_PER_YEAR}"
            )

    try:
        grid = Grid(
            electricity_market_buying_price=buying,
            electricity_market_selling_price=selling,
            electricity_market_carbon_intensity=carbon,
            analysis_period=spec.analysis_period,
        )
    except Exception as err:
        raise GridBuildError(f"grid: {err}") from err

    # Grid never sets a name, but EnergyCommunity.validate and __repr__ read one.
    grid.name = spec.name

    message = grid.validate()
    if isinstance(message, str) and message.startswith("Error:"):
        raise GridBuildError(f"grid {spec.name!r}: {message[len('Error: '):]}")

    return grid
