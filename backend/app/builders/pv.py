"""Turn PV specifications into ECOMToolkit objects."""
from __future__ import annotations

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.schemas.pv import PVModuleSpec, PVPlantSpec

from ECOMToolkit.entities import PVModule, PVPlant


class PVBuildError(ValueError):
    """Raised with the offending plant named."""


def build_pv_module(spec: PVModuleSpec) -> PVModule:
    return PVModule(
        name=spec.name,
        rating=spec.rating,
        size_x=spec.size_x,
        size_y=spec.size_y,
        cost=spec.cost_per_kwp,
        embodied_co2=spec.embodied_co2_per_kwp,
    )


def build_pv_plant(spec: PVPlantSpec, strict: bool = True) -> PVPlant:
    """Construct a toolkit PVPlant.

    strict=True turns a failed PVGIS lookup into an error. With strict=False the
    plant is returned with zero production and `pvgis_error` set - only useful
    when a partially broken result is genuinely better than none.
    """
    module = build_pv_module(spec.module)

    try:
        plant = PVPlant(
            name=spec.name,
            surface=spec.surface_area,   # numeric area, no Rhino needed
            pv_module=module,
            percentage=spec.percentage,
            system_loss=spec.system_loss,
            lat=spec.lat,
            lon=spec.lon,
            custom_slope=spec.slope,
            custom_azimuth=spec.azimuth,
        )
    except Exception as err:
        raise PVBuildError(f"PV plant {spec.name!r}: {err}") from err

    if strict and getattr(plant, "pvgis_error", None):
        raise PVBuildError(
            f"PV plant {spec.name!r}: PVGIS lookup failed ({plant.pvgis_error}). "
            f"Production would be reported as zero, which is indistinguishable "
            f"from a real result."
        )

    if spec.location is not None:
        plant.x = spec.location.x
        plant.y = spec.location.y

    # The spec computes capacity independently so the UI can preview it without
    # a PVGIS call. If the two disagree, the preview is lying to the user.
    if abs(plant.installed_capacity - spec.installed_capacity) > 1e-6:
        raise PVBuildError(
            f"PV plant {spec.name!r}: toolkit computed "
            f"{plant.installed_capacity} kWp but the spec predicted "
            f"{spec.installed_capacity} kWp. The sizing logic has diverged."
        )

    return plant
