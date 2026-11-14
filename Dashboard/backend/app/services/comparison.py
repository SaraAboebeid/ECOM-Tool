"""The same buildings, with and without an energy community.

A community's figures mean little on their own: 19% self-sufficient is a number,
and whether it is a good one depends on what the buildings would have managed
apart. So the table can ask for the other half - the same members on the same
days, each on its own - and set the two side by side.

"On its own" is the community dispatch with the sharing taken away, and nothing
else changed (see IsolatedDispatchStrategy):

  * no exchange between buildings;
  * no community-owned solar - panels that belong to nobody in particular have
    nobody to feed once there is no community, so they are not in this run;
  * no community battery, for the same reason;
  * a building's own panels and its own battery stay, because they are the
    building's and would be there regardless;
  * chargers stay, because the cars still need charging - they just have only
    the grid to charge from.

What it measures is therefore what the community adds, not what the panels add.
"""
from __future__ import annotations

from typing import Optional

from app.schemas.community import CommunitySpec
from app.services.dispatch import run_dispatch
from app.services.nordpool import NordPoolClient


def _endpoint(value) -> str:
    return value if isinstance(value, str) else value.get("id", "")


def peak_grid_import_kw(dispatch: dict) -> float:
    """The most the whole community draws from the grid in any one hour.

    Summed across every building before the maximum is taken: the grid operator
    charges for the peak of the connection, not for each building's own peak, so
    this is the figure a community changes by flattening what it draws together.
    The hours are one hour wide, so kWh in an hour is kW.
    """
    grid_ids = {n["id"] for n in dispatch["nodes"] if n.get("type") == "grid"}
    hours = max((len(link.get("flow") or []) for link in dispatch["links"]), default=0)
    total = [0.0] * hours
    for link in dispatch["links"]:
        if _endpoint(link["source"]) not in grid_ids:
            continue
        for hour, raw in enumerate(link.get("flow") or []):
            value = float(raw or 0.0)
            if value > 0:
                total[hour] += value
    return max(total, default=0.0)


def _loose(text: object) -> str:
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def alone(spec: CommunitySpec) -> tuple[CommunitySpec, dict]:
    """The same buildings with no community, and what was taken out to get there."""
    members = {_loose(b.name) for b in spec.buildings}
    named = {name for b in spec.buildings for name in b.pv_plants}

    # A battery is a building's own only if it is attached AND its host is one
    # of the members - the same test the dispatcher applies, so a battery in a
    # building outside the scheme is community storage here too.
    own_batteries = [
        b for b in spec.batteries
        if b.attached and b.host and _loose(b.host) in members
    ]

    removed = {
        "community_pv": [p.name for p in spec.pv_plants if p.name not in named],
        "community_batteries": [b.name for b in spec.batteries if b not in own_batteries],
    }

    baseline = spec.model_copy(deep=True)
    baseline.dispatch_mode = "isolated"
    baseline.pv_plants = [p for p in baseline.pv_plants if p.name in named]
    baseline.batteries = [
        b for b in baseline.batteries
        if b.name in {o.name for o in own_batteries}
    ]
    return baseline, removed


def compare(spec: CommunitySpec, nordpool: Optional[NordPoolClient] = None) -> dict:
    """What the same members would have managed with no community."""
    baseline_spec, removed = alone(spec)
    dispatch = run_dispatch(baseline_spec, nordpool=nordpool)
    return {
        "kpis": dispatch.get("kpis") or {},
        "peak_grid_import_kw": peak_grid_import_kw(dispatch),
        "removed": removed,
    }
