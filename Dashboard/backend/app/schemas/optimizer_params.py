"""Tunable parameters for the LEC-Opt run.

Every value here is hardcoded inside functions1.py. The optimization team
confirmed they should become user-settable with the current values as defaults,
so this schema carries the default and the provenance for each, and
services/optimize.py applies them without editing the LEC-Opt repo.

Provenance matters as much as the number: several are dated, and one is known
to describe a scheme that no longer exists.
"""
from __future__ import annotations

from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field


class OptimizerParameters(BaseModel):
    """Overrides for LEC-Opt's hardcoded constants. Omit to keep the default."""

    model_config = ConfigDict(extra="forbid")

    # --- battery ---------------------------------------------------------
    battery_efficiency: Annotated[float, Field(gt=0, le=1)] = Field(
        0.93,
        description="Round-trip efficiency as a fraction. functions1.py:119 "
        "fixes this at 0.93 for every battery and EV. The team asked that it "
        "stay within 0-1 for numerical consistency.",
    )
    battery_cost_eur_per_kwh: Annotated[float, Field(gt=0)] = Field(
        137.0,
        description="Replacement value used by the aging model "
        "(functions1.py:131, as 11.1 x 137 x capacity). From the team's earlier "
        "model and kept for comparability; roughly a 2022 pack price.",
    )
    bess_soc_min: Annotated[float, Field(ge=0, lt=1)] = Field(
        0.0,
        description="Lower bound on battery state of charge. Zero by design - "
        "the team notes it lets the battery participate in several markets "
        "while the aging cost restrains cycling.",
    )

    # --- DSO tariff ------------------------------------------------------
    peak_multiplier: Annotated[float, Field(ge=0, le=30)] = Field(
        5.0,
        description="Multiplier on the monthly peak charge (functions1.py:924). "
        "Derived from the input data; the team suggested 0-30 as a sensible "
        "tuning range.",
    )
    subscription_fee_sek_per_month: Annotated[float, Field(ge=0)] = Field(
        605.0,
        description="Subscription fee, SEK per 30 days. Goteborg Energi, 2025. "
        "The '14 days' in the source comment is outdated - the team confirmed "
        "these are 30-day figures.",
    )
    effect_fee_sek_per_kw_month: Annotated[float, Field(ge=0)] = Field(
        61.55,
        description="Effect fee, SEK/kW per 30 days. Goteborg Energi, 2025.",
    )
    transmission_fee_sek_per_kwh: Annotated[float, Field(ge=0)] = Field(
        0.113, description="Transmission fee, SEK/kWh. Goteborg Energi, 2025."
    )
    transmission_health_incentive_sek_per_kwh: Annotated[float, Field(ge=0)] = Field(
        0.04,
        description="Paid on export. OUTDATED - the team reports the incentive "
        "is now much smaller than this.",
    )
    compensation_fee_sek_per_kwh: Annotated[float, Field(ge=0)] = Field(
        0.02,
        description="Transfer compensation, SEK/kWh. OUTDATED - the team "
        "reports this compensation no longer exists; set to 0 to model today.",
    )

    # --- tax -------------------------------------------------------------
    energy_tax_sek_per_kwh: Annotated[float, Field(ge=0)] = Field(
        0.439,
        description="Energy tax, SEK/kWh. 2023 rate - the team kept it for lack "
        "of a citable source for later years. The 2024 rate was 0.535.",
    )
    energy_certificate_sek_per_kwh: Annotated[float, Field(ge=0)] = Field(
        0.005, description="Energy certificate, SEK/kWh."
    )
    vat_rate: Annotated[float, Field(ge=0, le=1)] = Field(
        0.25,
        description="VAT on supplier cost, DSO cost and energy tax. The team "
        "confirmed the 25% and the 1.25 multiplier on energy tax are the same "
        "scheme applied correctly.",
    )

    # --- solver ----------------------------------------------------------
    solver_time_limit_s: Annotated[int, Field(ge=5, le=3600)] = Field(
        120,
        description="Seconds per solve. Chosen to keep multi-year batches "
        "tractable, accepting under ~5% optimality gap. Raise it if you enable "
        "the FCR markets. A hit limit returns the incumbent, not the optimum.",
    )


class ParameterInfo(BaseModel):
    """One parameter's default and provenance, for the UI to render."""

    name: str
    default: float
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    unit: str = ""
    group: str
    description: str
    outdated: bool = False


UNITS = {
    "battery_efficiency": "",
    "battery_cost_eur_per_kwh": "EUR/kWh",
    "bess_soc_min": "fraction",
    "peak_multiplier": "x",
    "subscription_fee_sek_per_month": "SEK/30d",
    "effect_fee_sek_per_kw_month": "SEK/kW/30d",
    "transmission_fee_sek_per_kwh": "SEK/kWh",
    "transmission_health_incentive_sek_per_kwh": "SEK/kWh",
    "compensation_fee_sek_per_kwh": "SEK/kWh",
    "energy_tax_sek_per_kwh": "SEK/kWh",
    "energy_certificate_sek_per_kwh": "SEK/kWh",
    "vat_rate": "fraction",
    "solver_time_limit_s": "s",
}

GROUPS = {
    "battery_efficiency": "Battery",
    "battery_cost_eur_per_kwh": "Battery",
    "bess_soc_min": "Battery",
    "peak_multiplier": "Grid tariff",
    "subscription_fee_sek_per_month": "Grid tariff",
    "effect_fee_sek_per_kw_month": "Grid tariff",
    "transmission_fee_sek_per_kwh": "Grid tariff",
    "transmission_health_incentive_sek_per_kwh": "Grid tariff",
    "compensation_fee_sek_per_kwh": "Grid tariff",
    "energy_tax_sek_per_kwh": "Tax",
    "energy_certificate_sek_per_kwh": "Tax",
    "vat_rate": "Tax",
    "solver_time_limit_s": "Solver",
}


def describe_parameters() -> list[dict]:
    """Defaults, bounds and provenance, so the UI need not duplicate them."""
    out = []
    for name, field in OptimizerParameters.model_fields.items():
        minimum = maximum = None
        for meta in field.metadata:
            for attr, key in (("ge", "min"), ("gt", "min"), ("le", "max"), ("lt", "max")):
                value = getattr(meta, attr, None)
                if value is not None:
                    if key == "min":
                        minimum = float(value)
                    else:
                        maximum = float(value)
        description = field.description or ""
        out.append(ParameterInfo(
            name=name,
            default=float(field.default),
            minimum=minimum,
            maximum=maximum,
            unit=UNITS.get(name, ""),
            group=GROUPS.get(name, "Other"),
            description=description,
            outdated="OUTDATED" in description,
        ).model_dump())
    return out
