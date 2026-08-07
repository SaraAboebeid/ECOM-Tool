"""Run a dispatch and serialise it for the dashboard.

The graph serializer here is explicit, unlike ECOMDispatcher.export_graph_json,
which reflects over dir(obj) and emits whatever it finds. That is why the
dashboard's current graph.json carries electric_demand as a repr string,
area: 0.0 and breps: []. An explicit serializer keeps the frontend contract
stable when the toolkit's attributes change.

Output matches Dashboard/src/types.ts: {nodes, links, kpis}.
"""
from __future__ import annotations

import contextlib
import io
import math
from typing import Any, Optional

import numpy as np

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from app.builders.community import BuiltCommunity, build_community
from app.schemas.community import CommunitySpec
from app.services.nordpool import NordPoolClient

from ECOMToolkit.analysis.dispatcher import ECOMDispatcher


def _f(value: Any, default: float = 0.0) -> float:
    """Coerce numpy scalars and None to a JSON-safe float."""
    try:
        if value is None:
            return default
        out = float(value)
        return out if np.isfinite(out) else default
    except (TypeError, ValueError):
        return default


def run_dispatch(
    spec: CommunitySpec,
    nordpool: Optional[NordPoolClient] = None,
    capture_log: bool = True,
    include_idle_links: bool = False,
) -> dict:
    """Build, dispatch and serialise. Returns the dashboard graph payload."""
    built = build_community(spec, nordpool=nordpool)

    # The toolkit prints a per-hour flow summary; at 8760 hours that is tens of
    # thousands of lines into the server log.
    sink = io.StringIO()
    ctx = contextlib.redirect_stdout(sink) if capture_log else contextlib.nullcontext()
    with ctx:
        dispatcher = ECOMDispatcher(
            community=built.community,
            dispatch_mode=spec.dispatch_mode,
            analysis_period=spec.analysis_period.as_tuple,
            community_internal_price_buying=spec.internal_price_buying,
            community_internal_price_selling=spec.internal_price_selling,
        )
        dispatcher.run()

    payload = serialise_graph(dispatcher, built, include_idle_links=include_idle_links)
    payload["meta"] = {
        "community": spec.name,
        "period": spec.analysis_period.label,
        "hours": spec.analysis_period.n_hours,
        "dispatch_mode": spec.dispatch_mode,
    }
    return payload


def serialise_graph(dispatcher: ECOMDispatcher, built: BuiltCommunity,
                    include_idle_links: bool = False) -> dict:
    spec = built.spec
    by_name = {
        "building": {b.name: b for b in spec.buildings},
        "pv": {p.name: p for p in spec.pv_plants},
        "battery": {b.name: b for b in spec.batteries},
        "charge_point": {c.name: c for c in spec.charge_points},
    }

    nodes = []
    for node_id in dispatcher.G.nodes():
        kind = built.node_kinds.get(node_id, "grid" if node_id == "GRID" else "building")
        node: dict[str, Any] = {"id": node_id, "type": kind, "name": node_id}

        position = built.node_positions.get(node_id)
        if position is not None:
            node["x"], node["y"] = position

        if kind == "building" and node_id in by_name["building"]:
            b = by_name["building"][node_id]
            demand = b.demand.to_hourly_values()
            node.update(
                name=b.name,
                owner=b.owner,
                building_type=b.building_type,
                area=b.total_area,
                total_energy_demand=_f(sum(demand)) if demand else 0.0,
                total_pv_capacity=_f(sum(
                    by_name["pv"][n].installed_capacity for n in b.pv_plants)),
            )
            node["total_installed_capacity"] = node["total_pv_capacity"]

        elif kind == "pv":
            plant = _find(by_name["pv"], node_id, ("PV_",))
            if plant is not None:
                node.update(
                    name=plant.name,
                    installed_capacity=_f(plant.installed_capacity),
                    total_pv_capacity=_f(plant.installed_capacity),
                    total_cost=_f(plant.module_count * plant.module.cost_per_panel),
                    total_embodied_co2=_f(
                        plant.module_count * plant.module.embodied_co2_per_panel),
                    annual_production=_f(_annual_pv(dispatcher, plant.name)),
                )

        elif kind == "battery":
            battery = by_name["battery"].get(node_id[len("BAT_"):])
            if battery is not None:
                node.update(
                    name=battery.name,
                    capacity=_f(battery.capacity),
                    total_installed_capacity=_f(battery.capacity),
                    total_cost=_f(battery.total_cost),
                    total_embodied_co2=_f(battery.total_embodied_co2),
                )

        elif kind == "charge_point":
            cp = by_name["charge_point"].get(node_id[len("CP_"):])
            if cp is not None:
                node.update(
                    name=cp.name,
                    capacity=_f(cp.capacity),
                    owner=cp.owner,
                    charger_type=cp.charger_type,
                    is_v2g=cp.is_v2g,
                    total_connected_evs=1 if cp.ev is not None else 0,
                )

        nodes.append(node)

    _anchor_pv_nodes(nodes)

    links = []
    dropped = 0
    for source, target, data in dispatcher.G.edges(data=True):
        flow = [_f(v) for v in data.get("flow", [])]
        total = _f(sum(flow))
        # The dispatcher creates an edge for every possible peer-to-peer pair,
        # so a 36-building community has ~1,260 building-to-building edges of
        # which a handful ever carry energy. Drawing them all buries the real
        # flows. Only edges that actually moved energy are emitted.
        if total <= 0 and not include_idle_links:
            dropped += 1
            continue
        links.append({
            "source": source,
            "target": target,
            "type": data.get("type", "energy"),
            "flow": flow,
            "total": total,
        })

    return {
        "nodes": nodes,
        "links": links,
        "kpis": _kpis(dispatcher),
        "idle_links_omitted": dropped,
    }


# Building-mounted arrays are drawn just outside their building. The offset is
# in the same units as the map coordinates.
PV_ORBIT_RADIUS = 34.0


def _anchor_pv_nodes(nodes: list[dict]) -> None:
    """Place PV nodes beside the building they sit on.

    A rooftop array has no coordinates of its own, so without this the force
    layout drifts it away from its building and the graph reads as if the PV
    belonged to nothing.
    """
    positions = {n["id"]: (n["x"], n["y"])
                 for n in nodes if n.get("x") is not None and n.get("y") is not None}

    per_parent: dict[str, list[dict]] = {}
    for node in nodes:
        if node["type"] != "pv" or node.get("x") is not None:
            continue
        parent = node["id"].split("_PV_", 1)[0] if "_PV_" in node["id"] else None
        if parent in positions:
            per_parent.setdefault(parent, []).append(node)

    for parent, arrays in per_parent.items():
        px, py = positions[parent]
        # Fan several arrays around the building rather than stacking them.
        for index, node in enumerate(arrays):
            angle = (2 * math.pi * index) / len(arrays) - math.pi / 2
            node["x"] = round(px + PV_ORBIT_RADIUS * math.cos(angle), 2)
            node["y"] = round(py + PV_ORBIT_RADIUS * math.sin(angle), 2)
            node["anchored_to"] = parent


def _find(plants: dict, node_id: str, prefixes: tuple[str, ...]):
    """Resolve a PV node id back to its spec.

    The dispatcher names building-mounted plants "{building}_PV_{name}" and
    community plants "PV_{name}". Split on the FIRST "_PV_": plant names
    routinely contain "PV_" themselves, and splitting on the last occurrence
    turned "SB2_PV_SB2-PV_1" into "1", silently reporting those arrays as
    0 kWp with no production.
    """
    if "_PV_" in node_id:
        return plants.get(node_id.split("_PV_", 1)[1])
    if node_id.startswith("PV_"):
        return plants.get(node_id[len("PV_"):])
    return None


def _annual_pv(dispatcher: ECOMDispatcher, plant_name: str) -> float:
    for plant in getattr(dispatcher.community, "PV_plant", []):
        if plant.name == plant_name:
            return getattr(plant, "annual_production", 0.0)
    for building in getattr(dispatcher.community, "building", []):
        for plant in getattr(building, "PV_plant", []):
            if plant.name == plant_name:
                return getattr(plant, "annual_production", 0.0)
    return 0.0


def _kpis(dispatcher: ECOMDispatcher) -> dict:
    result = dispatcher.get_kpis()
    if result is None:
        return {}
    raw = result.as_dict()
    payload = {k: _f(v) for k, v in raw.items() if not isinstance(v, dict)}
    payload["building_self_consumption"] = {
        k: _f(v) for k, v in (raw.get("building_self_consumption") or {}).items()
    }
    return payload
