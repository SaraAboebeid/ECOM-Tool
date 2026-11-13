"""Assemble a CommunitySpec into an ECOMToolkit EnergyCommunity."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.builders.battery import build_battery
from app.builders.building import build_building
from app.builders.charging import build_charge_point
from app.builders.grid import build_grid
from app.builders.pv import build_pv_plant
from app.schemas.community import CommunitySpec
from app.services.nordpool import NordPoolClient

from ECOMToolkit.entities import EnergyCommunity


class CommunityBuildError(ValueError):
    """Raised with the offending entity named."""


@dataclass
class BuiltCommunity:
    """The toolkit community plus the lookups the graph serializer needs.

    Node types cannot be recovered reliably from the dispatch graph's node ids
    alone, so they are recorded here while the objects are still typed.
    """

    community: EnergyCommunity
    spec: CommunitySpec
    node_kinds: dict[str, str] = field(default_factory=dict)
    node_positions: dict[str, tuple[float, float]] = field(default_factory=dict)


def build_community(
    spec: CommunitySpec,
    nordpool: Optional[NordPoolClient] = None,
) -> BuiltCommunity:
    node_kinds: dict[str, str] = {}
    positions: dict[str, tuple[float, float]] = {}

    def remember(node_id: str, kind: str, location) -> None:
        node_kinds[node_id] = kind
        if location is not None:
            positions[node_id] = (location.x, location.y)

    # --- PV plants first: buildings reference them by name ---
    plants = {}
    for plant_spec in spec.pv_plants:
        plants[plant_spec.name] = build_pv_plant(plant_spec)

    attached = {n for b in spec.buildings for n in b.pv_plants}
    for plant_spec in spec.pv_plants:
        # Node ids follow the dispatcher: building PV is "{building}_PV_{name}",
        # community PV is "PV_{name}" (dispatcher._compute_kpis).
        if plant_spec.name in attached:
            owner = next(b.name for b in spec.buildings if plant_spec.name in b.pv_plants)
            remember(f"{owner}_PV_{plant_spec.name}", "pv", plant_spec.location)
        else:
            remember(f"PV_{plant_spec.name}", "pv", plant_spec.location)

    # --- buildings ---
    buildings = []
    for building_spec in spec.buildings:
        buildings.append(build_building(building_spec, pv_plants=plants))
        remember(building_spec.name, "building", building_spec.location)

    # --- batteries ---
    #
    # A battery names its host as a footprint id - "awl", "sb2" - because that
    # is what the table draws with. The dispatcher knows buildings by name, so
    # the two are matched loosely here: letters and digits only, folded to
    # lower case, which is enough to join "CSB Chabo" to "csb-chabo".
    def loose(text: str) -> str:
        return "".join(ch for ch in str(text).lower() if ch.isalnum())

    by_loose_name = {loose(b.name): b.name for b in spec.buildings}

    batteries = []
    for battery_spec in spec.batteries:
        # An unmatched host is community storage, not an error: a battery may
        # legitimately stand in a building whose meter is not in the scheme,
        # and the dispatcher pools anything it cannot wire privately.
        host = (by_loose_name.get(loose(battery_spec.host))
                if battery_spec.attached and battery_spec.host else None)
        batteries.append(build_battery(battery_spec, host_building=host))
        remember(f"BAT_{battery_spec.name}", "battery", battery_spec.location)

    # --- charge points ---
    charge_points = []
    period = spec.analysis_period.as_tuple
    for cp_spec in spec.charge_points:
        charge_points.append(build_charge_point(cp_spec, analysis_period=period))
        remember(f"CP_{cp_spec.name}", "charge_point", cp_spec.location)

    # --- grid ---
    grid = build_grid(spec.grid, nordpool=nordpool)
    remember("GRID", "grid", spec.grid.location)

    community = EnergyCommunity(
        building=buildings,
        PV_plant=[plants[p.name] for p in spec.community_pv_plants],
        Battery=batteries,
        charging_points=charge_points,
        grid=grid,
    )

    # The dispatcher replaces a missing grid with a 1.5 SEK/kWh default, so a
    # community that reaches it without one produces plausible but wrong costs.
    if getattr(community, "grid", None) is None:
        raise CommunityBuildError(
            "the assembled community has no grid; the dispatcher would silently "
            "substitute its 1.5 SEK/kWh default"
        )

    return BuiltCommunity(
        community=community,
        spec=spec,
        node_kinds=node_kinds,
        node_positions=positions,
    )
