#! python3
# r: pandas, numpy, networkx

import numpy as np
import pandas as pd
import networkx as nx

from ECOMToolkit.analysis.data import HourlyData
from ECOMToolkit.analysis.kpi import KPIResult



class ECOMDispatcher:
    """
    ECOMDispatcher
    --------------
    A simulation engine for energy communities.

    Tracks and dispatches hourly energy flows:
        - Self-consumption of building PVs.
        - Peer-to-peer (P2P) energy exchange between buildings.
        - Community PV utilization.
        - Battery operations (charge/discharge at building & community levels).
        - Grid import/export.

    Uses a NetworkX directed graph (DiGraph) where:
        - Nodes represent entities (buildings, PVs, batteries, grid).
        - Edges store hourly energy flows in an array `flow[t]`.

    Typical usage:
        1. Instantiate with an EnergyCommunity object.
        2. Call run() to simulate dispatch for the chosen period.
        3. Retrieve results with get_kpis(), get_hourly_dispatch(), and report().
    """

    # ================================================================
    # === Initialization & Setup Methods ===
    # ================================================================

    def __init__(self,
                 community,
                 dispatch_mode: str = "community",
                 analysis_period: tuple[int, int] = None,
                 community_internal_price_buying: float = 1.0,
                 community_internal_price_selling: float = 1.0):
        """
        Initialize the dispatcher.

        Args:
            community: EnergyCommunity instance (buildings, PV, batteries, etc.)
            dispatch_mode: Dispatch mode, e.g., "community"
            analysis_period: (start_hour, end_hour), default full year (0..8759)
            community_internal_price_buying: Internal energy trade price in the community (buying)
            community_internal_price_selling: Internal energy trade price in the community (selling)
        """
        from ECOMToolkit.entities.energy_community import EnergyCommunity
        from ECOMToolkit.entities.grid import Grid

        if not (type(community).__name__ == "EnergyCommunity" and "energy_community" in type(community).__module__):
            raise TypeError("community must be an EnergyCommunity instance")

        self.community = community
        self.dispatch_mode = dispatch_mode.lower().strip()
        self.community_internal_price_buying = float(community_internal_price_buying)
        self.community_internal_price_selling = float(community_internal_price_selling)
        self.start_hour, self.end_hour = self._prepare_period(analysis_period)
        self.hours = np.arange(self.start_hour, self.end_hour + 1)
        self.n_hours = len(self.hours)

        # Initialize grid entity from community
        if getattr(self.community, "grid", None) is None:
            self.community.grid = Grid(analysis_period=(self.start_hour, self.end_hour))

        # Network graph to store nodes and energy flows
        self.G = nx.DiGraph()

        # Initialize graph structure
        self._init_graph_nodes()
        self._init_graph_edges()

        # KPIs will be computed after simulation
        self.kpis = {}

        # --- Additional checks and warnings ---
        self._check_pv_hourly_result()
        self._check_battery_initial_soc()
        print("[INIT] Checking community type...")
        if not (type(community).__name__ == "EnergyCommunity" and "energy_community" in type(community).__module__):
            raise TypeError("community must be an EnergyCommunity instance")
        self._check_grid_node()
        print(f"[INIT] Community type OK: {type(community).__name__}")
        print(f"[INIT] Dispatch mode: {self.dispatch_mode}")
        print(f"[INIT] Internal price (buy): {self.community_internal_price_buying}, (sell): {self.community_internal_price_selling}")
        print(f"[INIT] Analysis period: {self.start_hour} to {self.end_hour}")
        print(f"[INIT] Number of hours: {self.n_hours}")
        if getattr(self.community, "grid", None) is None:
            print("[INIT] No grid found in community. Initializing grid entity...")
            self.community.grid = Grid(analysis_period=(self.start_hour, self.end_hour))
        else:
            print("[INIT] Grid entity found in community.")
        print("[INIT] Creating network graph...")
        print("[INIT] Adding nodes to graph...")
        print("[INIT] Adding edges to graph...")
        print("[INIT] Checking PV hourly results...")
        print("[INIT] Checking battery initial state of charge...")

    # ------------------------------------------------
    # --- Public API Methods ---
    # ------------------------------------------------

    def get_hourly_dispatch(self):
        """
        Return a list of dicts for each hour with all relevant energy flows.
        Each dict contains: hour, pv_used, p2p_energy, battery_charge/discharge, grid import/export, and battery SoC.
        """
        dispatch = []
        for t, hour in enumerate(self.hours):
            entry = {
                "hour": hour,
                "pv_used": sum(self.G.edges[edge]["flow"][t] for edge in self.G.edges if "PV" in edge[0] and edge[1] in [b.name for b in self.community.building]),
                "p2p_energy": sum(self.G.edges[edge]["flow"][t] for edge in self.G.edges if edge[0] in [b.name for b in self.community.building] and edge[1] in [b.name for b in self.community.building] and edge[0] != edge[1]),
                "battery_charge": sum(self.G.edges[edge]["flow"][t] for edge in self.G.edges if "BAT" in edge[1]),
                "battery_discharge": sum(self.G.edges[edge]["flow"][t] for edge in self.G.edges if "BAT" in edge[0]),
                "grid_import": sum(self.G.edges["GRID", b.name]["flow"][t] for b in self.community.building if self.G.has_edge("GRID", b.name)),
                "grid_export": sum(self.G.edges[b.name, "GRID"]["flow"][t] for b in self.community.building if self.G.has_edge(b.name, "GRID")),
                "soc": {bat.name: self.last_battery_soc[f"BAT_{bat.name}"][t] for bat in getattr(self.community, "battery", [])}
            }
            dispatch.append(entry)
        return dispatch

    def get_battery_soc(self):
        """
        Return dict of battery SoC arrays for all batteries.
        Key: battery name, Value: SoC array for analysis period.
        """
        return {bat.name: self.last_battery_soc[f"BAT_{bat.name}"] for bat in getattr(self.community, "battery", [])}

    def get_kpis(self) -> KPIResult:
        """
        Return computed KPIs after running the simulation.
        """
        return self.kpis

    def report(self) -> str:
        """
        Generate a human-readable text report summarizing inputs, steps, and results.
        """
        lines = []
        lines.append("=== ECOMDispatcher Report ===\n")
        lines.append(f"Community: {getattr(self.community, 'name', 'Unnamed')}")
        lines.append(f"Dispatch mode: {self.dispatch_mode}")
        lines.append(f"Analysis period: {self.start_hour} to {self.end_hour} (n_hours={self.n_hours})")
        lines.append("\n--- Grid Entity ---")
        lines.append(self.community.grid.report())
        lines.append("\n--- KPI Results ---")
        if self.kpis:
            k = self.kpis
            lines.append(f"Total demand: {k.total_demand:.2f} kWh")
            lines.append(f"Grid import: {k.total_grid_import:.2f} kWh")
            lines.append(f"Grid export: {k.total_grid_export:.2f} kWh")
            lines.append(f"PV used: {k.total_pv_used:.2f} kWh / PV gen: {k.total_pv_gen:.2f} kWh")
            lines.append(f"Self-sufficiency: {k.self_sufficiency:.2f}%")
            lines.append(f"Self-consumption: {k.self_consumption:.2f}%")
        else:
            lines.append("(Run the simulation to compute KPIs.)")

        return "\n".join(lines)

    def export_graph_json(self, path):
        """
        Export the dispatch graph (nodes, edges, hourly flows, all node/edge details, and KPIs) to a JSON file.
        Each edge includes a 'flow' array of hourly values and all edge attributes.
        All node attributes are included. KPIs are included if available.
        """
        import json
        # Collect all node details
        nodes = []
        for node, data in self.G.nodes(data=True):
            node_dict = {"id": node}
            # Add all node attributes
            for k, v in data.items():
                if k == "obj" and v is not None:
                    # Extract all public attributes from the class instance (excluding methods and private)
                    obj_attrs = {}
                    for attr in dir(v):
                        if not attr.startswith("_") and not callable(getattr(v, attr)):
                            try:
                                val = getattr(v, attr)
                                # Try to serialize, else convert to string
                                json.dumps(val)
                                obj_attrs[attr] = val
                            except Exception:
                                obj_attrs[attr] = str(getattr(v, attr))
                    node_dict.update(obj_attrs)
                else:
                    try:
                        json.dumps(v)  # test if serializable
                        node_dict[k] = v
                    except Exception:
                        node_dict[k] = str(v)
            nodes.append(node_dict)
        # Collect all edge details
        links = []
        for from_node, to_node, data in self.G.edges(data=True):
            link = {"source": from_node, "target": to_node}
            for k, v in data.items():
                if k == "flow":
                    link[k] = [float(f) for f in v]
                else:
                    try:
                        json.dumps(v)
                        link[k] = v
                    except Exception:
                        link[k] = str(v)
            links.append(link)
        # Collect KPIs if available
        kpis = None
        if self.kpis:
            try:
                # If KPIResult is a dataclass or has __dict__
                if hasattr(self.kpis, "__dict__"):
                    kpis = {k: (float(v) if isinstance(v, (int, float, np.floating, np.integer)) else v)
                             for k, v in self.kpis.__dict__.items()}
                else:
                    kpis = dict(self.kpis)
            except Exception:
                kpis = str(self.kpis)
        graph = {"nodes": nodes, "links": links, "kpis": kpis}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(graph, f, indent=2)

    # ================================================================
    # === Validation & Graph Setup Methods ===
    # ================================================================

    def _check_pv_hourly_result(self):
        """
        Warn if any PV (building or community) is missing or has empty hourly_result.
        """
        # ...existing code...

    def _check_battery_initial_soc(self):
        """
        Warn if any battery initial_soc is not set or is equal to capacity (fully charged).
        """
        # ...existing code...

    def _check_grid_node(self):
        """
        Warn if the community has no grid node (no grid import/export possible).
        """
        # ...existing code...

    def _prepare_period(self, period) -> tuple[int, int]:
        """
        Ensure analysis period stays within [0..8759]. Accepts tuple (start, end) or list of hoys.
        """
        # ...existing code...

    def _init_graph_nodes(self):
        """
        Add buildings, PVs, batteries, charge points, and grid as graph nodes.
        """
        # ...existing code...

    def _init_graph_edges(self):
        """
        Create all possible edges for energy flows between nodes.
        """
        # ...existing code...

    # ================================================================
    # === Core Simulation (Run) ===
    # ================================================================

    def run(self, strategy: str = "default"):
        """
        Run the dispatch simulation for each hour in the analysis period.

        Sequence per hour:
            1. Self-consumption (buildings use own PV first).
            2. Peer-to-peer energy exchange (surplus to deficits).
            3. Community PV covers remaining deficits.
            4. Batteries discharge to cover remaining deficits.
            5. Grid import covers any remaining deficit.
            6. Batteries charge with remaining surplus.
            7. Remaining surplus exported to grid.
        """
        # ...existing code...

    def _log_hourly_flows(self, t, hour):
        """
        Log all relevant energy flows for the hour in a structured format.
        """
        # ...existing code...

    # ================================================================
    # === Helper & Dispatch Methods ===
    # ================================================================

    def _update_flow(self, from_node: str, to_node: str, t: int, value: float):
        """
        Add energy flow to the graph for a specific hour.
        """
        # ...existing code...

    def _init_battery_soc(self) -> dict:
        """
        Initialize battery state of charge (SoC) for all battery nodes.
        Handles empty DataFrames gracefully to avoid pandas errors.
        """
        # ...existing code...

    def _init_state(self) -> dict:
        """
        Initialize hourly state tracking (deficit, surplus, battery SoC).
        """
        # ...existing code...

    def _collect_building_data(self, hour: int) -> tuple[dict, dict]:
        """
        Collect building electricity demand and PV generation for a given hour.
        """
        # ...existing code...

    def _collect_community_pv(self, hour: int) -> dict:
        """
        Collect community-level PV generation for a given hour. Prints debug info for each PV plant.
        """
        # ...existing code...

    def _dispatch_self_consumption(self, t, hour, state, building_demand, building_pv):
        """
        Buildings use their own PVs first (self-consumption), supporting multiple PVs per building.
        """
        # ...existing code...

    def _dispatch_peer_to_peer(self, t, state):
        """
        Surplus from one building supplies deficit in another (P2P exchange).
        """
        # ...existing code...

    def _dispatch_community_pv(self, t, state, community_pv):
        """
        Community PV plants supply remaining deficits.
        """
        # ...existing code...

    def _dispatch_battery_discharge(self, t, state):
        """
        Community-level batteries discharge to cover remaining deficits.
        """
        # ...existing code...

    def _dispatch_grid_import(self, t, state):
        """
        Grid imports cover remaining deficits after all other sources.
        """
        # ...existing code...

    def _dispatch_battery_charge(self, t, state):
        """
        Charge community-level batteries with remaining surplus from all entities.
        """
        # ...existing code...

    def _dispatch_grid_export(self, t, state, community_pv):
        """
        Export remaining surplus to the grid.
        """
        # ...existing code...

    # ================================================================
    # === KPI Calculation & Reporting ===
    # ================================================================

    def _compute_kpis(self, battery_soc):
        """
        Compute KPIs (self-sufficiency, self-consumption, etc.).
        """
        # ...existing code...

    # ================================================================
    # === Initialization & Setup Methods ===
    # ================================================================

    def __init__(self,
                 community,
                 dispatch_mode: str = "community",
                 analysis_period: tuple[int, int] = None,
                 community_internal_price_buying: float = 1.0,
                 community_internal_price_selling: float = 1.0):
        """
        Initialize the dispatcher.

        Args:
            community: EnergyCommunity instance (buildings, PV, batteries, etc.)
            dispatch_mode: Dispatch mode, e.g., "community"
            analysis_period: (start_hour, end_hour), default full year (0..8759)
            community_internal_price_buying: Internal energy trade price in the community (buying)
            community_internal_price_selling: Internal energy trade price in the community (selling)
        """
        from ECOMToolkit.entities.energy_community import EnergyCommunity
        from ECOMToolkit.entities.grid import Grid

        if not (type(community).__name__ == "EnergyCommunity" and "energy_community" in type(community).__module__):
            raise TypeError("community must be an EnergyCommunity instance")

        self.community = community
        self.dispatch_mode = dispatch_mode.lower().strip()
        self.community_internal_price_buying = float(community_internal_price_buying)
        self.community_internal_price_selling = float(community_internal_price_selling)
        self.start_hour, self.end_hour = self._prepare_period(analysis_period)
        self.hours = np.arange(self.start_hour, self.end_hour + 1)
        self.n_hours = len(self.hours)

        # Initialize grid entity from community
        if getattr(self.community, "grid", None) is None:
            self.community.grid = Grid(analysis_period=(self.start_hour, self.end_hour))

        # Network graph to store nodes and energy flows
        self.G = nx.DiGraph()

        # Initialize graph structure
        self._init_graph_nodes()
        self._init_graph_edges()

        # KPIs will be computed after simulation
        self.kpis = {}

        # --- Additional checks and warnings ---
        self._check_pv_hourly_result()
        self._check_battery_initial_soc()
        print("[INIT] Checking community type...")
        if not (type(community).__name__ == "EnergyCommunity" and "energy_community" in type(community).__module__):
            raise TypeError("community must be an EnergyCommunity instance")
        self._check_grid_node()
        print(f"[INIT] Community type OK: {type(community).__name__}")
        print(f"[INIT] Dispatch mode: {self.dispatch_mode}")
        print(f"[INIT] Internal price (buy): {self.community_internal_price_buying}, (sell): {self.community_internal_price_selling}")
        print(f"[INIT] Analysis period: {self.start_hour} to {self.end_hour}")
        print(f"[INIT] Number of hours: {self.n_hours}")
        if getattr(self.community, "grid", None) is None:
            print("[INIT] No grid found in community. Initializing grid entity...")
            self.community.grid = Grid(analysis_period=(self.start_hour, self.end_hour))
        else:
            print("[INIT] Grid entity found in community.")
        print("[INIT] Creating network graph...")
        print("[INIT] Adding nodes to graph...")
        print("[INIT] Adding edges to graph...")
        print("[INIT] Checking PV hourly results...")
        print("[INIT] Checking battery initial state of charge...")

    def _check_pv_hourly_result(self):
        """Warn if any PV (building or community) is missing or has empty hourly_result."""
        missing = []
        # Check building PVs
        for building in getattr(self.community, "building", []):
            for pv in getattr(building, "PV_plant", []):
                if not (hasattr(pv, "hourly_result") and isinstance(pv.hourly_result, HourlyData)):
                    missing.append(f"Building PV: {building.name}.{getattr(pv, 'name', 'unnamed')}")
                elif getattr(pv.hourly_result, "df", None) is not None and pv.hourly_result.df.empty:
                    missing.append(f"Building PV (empty): {building.name}.{getattr(pv, 'name', 'unnamed')}")
        # Check community PVs
        for pv in getattr(self.community, "PV_plant", []):
            if not (hasattr(pv, "hourly_result") and isinstance(pv.hourly_result, HourlyData)):
                missing.append(f"Community PV: {getattr(pv, 'name', 'unnamed')}")
            elif getattr(pv.hourly_result, "df", None) is not None and pv.hourly_result.df.empty:
                missing.append(f"Community PV (empty): {getattr(pv, 'name', 'unnamed')}")
        if missing:
            print("[WARNING] The following PVs are missing or have empty hourly_result. PV generation will be underestimated:")
            for m in missing:
                print("  -", m)
        else:
            print("[INFO] All PVs are present and have valid hourly_result.")

    def _check_battery_initial_soc(self):
        """Warn if any battery initial_soc is not set or is equal to capacity (fully charged)."""
        # Building-level batteries are no longer supported. Only community-level batteries are checked below.
        for bat in getattr(self.community, "battery", []):
            cap = getattr(bat, "capacity", None)
            soc = getattr(bat, "initial_soc", None)
            if soc is None:
                print(f"[WARNING] Community battery {getattr(bat, 'name', 'unnamed')} has no initial_soc set. Defaulting to 0.0.")
            elif cap is not None and soc >= cap:
                print(f"[WARNING] Community battery {getattr(bat, 'name', 'unnamed')} starts fully charged (initial_soc = capacity = {cap}). This may artificially increase self-sufficiency.")
            else :
                print(f"[INFO] Community battery {getattr(bat, 'name', 'unnamed')} initial_soc is set to {soc} kWh.")

    def _check_grid_node(self):
        """Warn if the community has no grid node (no grid import/export possible)."""
        if not getattr(self.community, "grid", None):
            print("[WARNING] No grid node found in the community. No grid import/export will be possible. Self-sufficiency will always be 100%.")
        else:
            print("[INFO] Grid node is present in the community.")

    def _prepare_period(self, period) -> tuple[int, int]:
        """Ensure analysis period stays within [0..8759]. Accepts tuple (start, end) or list of hoys."""
        if period is None:
            print("[PERIOD] No analysis period provided. Using full year (0..8759).")
            return 0, 8759
        if isinstance(period, (tuple, list)):
            if len(period) == 2 and all(isinstance(x, int) for x in period):
                print(f"[PERIOD] Using analysis period tuple: {period}")
                return max(0, period[0]), min(period[1], 8759)
            # If it's a list of hoys (not a tuple)
            if len(period) > 2 and all(isinstance(x, int) for x in period):
                print(f"[PERIOD] Using analysis period list: {period}")
                return max(0, min(period)), min(max(period), 8759)
        print("[PERIOD] Invalid analysis period format.")
        raise ValueError("analysis_period must be a tuple (start, end) or a list of hoys (integers)")

    def _init_graph_nodes(self):
        """Add buildings, PVs, batteries, charge points, and grid as graph nodes."""
        for building in self.community.building:
            self.G.add_node(building.name, obj=building, type="building")
            print(f"[GRAPH] Adding building node: {building.name}")
            for photovoltaic in getattr(building, "PV_plant", []):
                self.G.add_node(f"{building.name}_PV_{photovoltaic.name}", obj=photovoltaic, type="pv")
                print(f"[GRAPH] Adding building PV node: {building.name}_PV_{photovoltaic.name}")

        for photovoltaic in getattr(self.community, "PV_plant", []):
            self.G.add_node(f"PV_{photovoltaic.name}", obj=photovoltaic, type="pv")
            print(f"[GRAPH] Adding community PV node: PV_{photovoltaic.name}")

        for battery in getattr(self.community, "battery", []):
            self.G.add_node(f"BAT_{battery.name}", obj=battery, type="battery")
            print(f"[GRAPH] Adding community battery node: BAT_{battery.name}")
            # Add edges from battery to all buildings and grid (discharge)
            for building in self.community.building:
                self.G.add_edge(f"BAT_{battery.name}", building.name, flow=np.zeros(self.n_hours))
                print(f"[GRAPH] Adding edge: BAT_{battery.name} -> {building.name}")
            self.G.add_edge(f"BAT_{battery.name}", "GRID", flow=np.zeros(self.n_hours))
            print(f"[GRAPH] Adding edge: BAT_{battery.name} -> GRID")
            # Add edges from all buildings and grid to battery (charge)
            for building in self.community.building:
                self.G.add_edge(building.name, f"BAT_{battery.name}", flow=np.zeros(self.n_hours))
                print(f"[GRAPH] Adding edge: {building.name} -> BAT_{battery.name}")
            self.G.add_edge("GRID", f"BAT_{battery.name}", flow=np.zeros(self.n_hours))
            print(f"[GRAPH] Adding edge: GRID -> BAT_{battery.name}")

        for charge_point in getattr(self.community, "charge_point", []):
            self.G.add_node(f"CP_{charge_point.name}", obj=charge_point, type="charge_point")
            print(f"[GRAPH] Adding charge point node: CP_{charge_point.name}")

        # Always add grid node using the grid entity from community
        self.G.add_node("GRID", obj=self.community.grid, type="grid")
        print("[GRAPH] Adding grid node: GRID")

    def _init_graph_edges(self):
        """Create all possible edges for energy flows between nodes."""
        for building in self.community.building:
            for photovoltaic in getattr(building, "PV_plant", []):
                edge_from = f"{building.name}_PV_{photovoltaic.name}"
                edge_to = building.name
                self.G.add_edge(edge_from, edge_to, flow=np.zeros(self.n_hours))
                print(f"[GRAPH] Adding edge: {edge_from} -> {edge_to}")
            self.G.add_edge("GRID", building.name, flow=np.zeros(self.n_hours))
            print(f"[GRAPH] Adding edge: GRID -> {building.name}")
            self.G.add_edge(building.name, "GRID", flow=np.zeros(self.n_hours))
            print(f"[GRAPH] Adding edge: {building.name} -> GRID")
            for other_building in self.community.building:
                if other_building != building:
                    self.G.add_edge(building.name, other_building.name, flow=np.zeros(self.n_hours))
                    print(f"[GRAPH] Adding edge: {building.name} -> {other_building.name}")

        for photovoltaic in getattr(self.community, "PV_plant", []):
            for building in self.community.building:
                edge_from = f"PV_{photovoltaic.name}"
                edge_to = building.name
                self.G.add_edge(edge_from, edge_to, flow=np.zeros(self.n_hours))
                print(f"[GRAPH] Adding edge: {edge_from} -> {edge_to}")
            self.G.add_edge(f"PV_{photovoltaic.name}", "GRID", flow=np.zeros(self.n_hours))
            print(f"[GRAPH] Adding edge: PV_{photovoltaic.name} -> GRID")

    # ================================================================
    # === Core Simulation (Run) ===
    # ================================================================

    def run(self, strategy: str = "default"):
        """
        Run the dispatch simulation using the selected strategy.
        Delegates to the appropriate DispatchStrategy class.
        """
        if self.dispatch_mode == "community":
            from ECOMToolkit.analysis.dispatch_strategies.community import CommunityDispatchStrategy
            CommunityDispatchStrategy().dispatch(self, strategy)
        elif self.dispatch_mode == "market":
            from ECOMToolkit.analysis.dispatch_strategies.market import MarketDispatchStrategy
            MarketDispatchStrategy().dispatch(self, strategy)
        else:
            raise ValueError(f"Unknown dispatch mode: {self.dispatch_mode}")
    def _log_hourly_flows(self, t, hour):
        """Log all relevant energy flows for the hour in a structured format."""
        lines = []
        lines.append(f"\n[HOUR {hour} | t={t}] Energy Flows Summary")
        lines.append("="*60)
        # PV generation
        pv_gen = {}
        for building in self.community.building:
            for photovoltaic in getattr(building, "PV_plant", []):
                pv_node = f"{building.name}_PV_{photovoltaic.name}"
                if hasattr(photovoltaic, "hourly_result"):
                    df = photovoltaic.hourly_result.df
                    val = df.loc[df["hoy"] == hour + 1, "value"]
                    pv_gen[pv_node] = val.iloc[0] if not val.empty else 0.0
        for photovoltaic in getattr(self.community, "PV_plant", []):
            pv_node = f"PV_{photovoltaic.name}"
            if hasattr(photovoltaic, "hourly_result"):
                df = photovoltaic.hourly_result.df
                val = df.loc[df["hoy"] == hour + 1, "value"]
                pv_gen[pv_node] = val.iloc[0] if not val.empty else 0.0
        if pv_gen:
            lines.append("PV Generation:")
            for k, v in pv_gen.items():
                lines.append(f"  {k:20s}: {v:6.2f} kWh")
        # PV to Building
        lines.append("PV to Building:")
        for edge in self.G.edges:
            from_node, to_node = edge
            if "PV" in from_node and to_node in [b.name for b in self.community.building]:
                flow = self.G.edges[from_node, to_node]["flow"][t]
                if flow > 0:
                    lines.append(f"  {from_node:20s} -> {to_node:10s}: {flow:6.2f} kWh")
        # Building to Building
        lines.append("Building to Building:")
        for edge in self.G.edges:
            from_node, to_node = edge
            if from_node in [b.name for b in self.community.building] and to_node in [b.name for b in self.community.building] and from_node != to_node:
                flow = self.G.edges[from_node, to_node]["flow"][t]
                if flow > 0:
                    lines.append(f"  {from_node:10s} -> {to_node:10s}: {flow:6.2f} kWh")
        # To Battery
        lines.append("To Battery:")
        for edge in self.G.edges:
            from_node, to_node = edge
            if "BAT" in to_node:
                flow = self.G.edges[from_node, to_node]["flow"][t]
                if flow > 0:
                    lines.append(f"  {from_node:15s} -> {to_node:10s}: {flow:6.2f} kWh")
        # From Grid
        lines.append("From Grid:")
        for edge in self.G.edges:
            from_node, to_node = edge
            if from_node == "GRID" and to_node in [b.name for b in self.community.building]:
                flow = self.G.edges[from_node, to_node]["flow"][t]
                if flow > 0:
                    lines.append(f"  GRID           -> {to_node:10s}: {flow:6.2f} kWh")
        print("\n".join(lines))

    # ================================================================
    # === Helper & Dispatch Methods (all rewritten) ===
    # ================================================================

    def _update_flow(self, from_node: str, to_node: str, t: int, value: float):
        """Add energy flow to the graph for a specific hour."""
        if self.G.has_edge(from_node, to_node):
            self.G.edges[from_node, to_node]["flow"][t] += value

    def _init_battery_soc(self) -> dict:
        """Initialize battery state of charge (SoC) for all battery nodes.
        Handles empty DataFrames gracefully to avoid pandas errors.
        """
        battery_soc = {}
        for node, data in self.G.nodes(data=True):
            if data["type"] == "battery":
                battery = data["obj"]
                soc_array = None
                if hasattr(battery, "hourly_soc"):
                    hourly_soc = battery.hourly_soc
                    # If HourlyData object, get DataFrame
                    if hasattr(hourly_soc, "df"):
                        df = hourly_soc.df
                        # Ensure 'hoy' column exists and is int
                        if "hoy" in df.columns:
                            # COMMENT: Check for empty DataFrame before set_index/reindex
                            if df.empty:
                                soc_array = np.zeros(self.n_hours + 1)
                            else:
                                soc_series = df.set_index("hoy")["value"].reindex(self.hours, fill_value=0.0)
                                soc_array = soc_series.to_numpy()
                        else:
                            soc_array = df["value"].to_numpy() if not df.empty else np.zeros(self.n_hours + 1)
                    # If pandas DataFrame
                    elif hasattr(hourly_soc, "values"):
                        soc_array = hourly_soc["value"].to_numpy()
                if soc_array is not None:
                    # Pad or trim to match n_hours+1
                    if len(soc_array) < self.n_hours + 1:
                        soc_array = np.pad(soc_array, (0, self.n_hours + 1 - len(soc_array)), 'constant')
                    elif len(soc_array) > self.n_hours + 1:
                        soc_array = soc_array[:self.n_hours + 1]
                    battery_soc[node] = soc_array
                else:
                    battery_soc[node] = np.zeros(self.n_hours + 1)
                    battery_soc[node][0] = getattr(battery, "initial_soc", 0.0)
        return battery_soc

    def _init_state(self) -> dict:
        """Initialize hourly state tracking (deficit, surplus, battery SoC)."""
        return {
            "deficit": {},
            "surplus": {},
            "battery_soc": self.last_battery_soc,
        }

    def _collect_building_data(self, hour: int) -> tuple[dict, dict]:
        """Collect building electricity demand and PV generation for a given hour."""
        building_demand = {}
        building_pv = {}

        for building in self.community.building:
            # Demand
            if hasattr(building, "electric_demand") and isinstance(building.electric_demand, HourlyData):
                demand_series = building.electric_demand.df.loc[building.electric_demand.df["hoy"] == hour + 1, "value"]
                demand = demand_series.iloc[0] if not demand_series.empty else 0.0
            else:
                demand = getattr(building, "total_energy_demand", 0.0) / 8760.0

            # EV demand (if present)
            if hasattr(building, "ev_demand") and isinstance(building.ev_demand, HourlyData):
                ev_series = building.ev_demand.df.loc[building.ev_demand.df["hoy"] == hour + 1, "value"]
                demand += ev_series.iloc[0] if not ev_series.empty else 0.0

            building_demand[building.name] = demand

            # PV generation
            pv_sum = 0.0
            for photovoltaic in getattr(building, "PV_plant", []):
                if hasattr(photovoltaic, "hourly_result") and isinstance(photovoltaic.hourly_result, HourlyData):
                    pv_series = photovoltaic.hourly_result.df.loc[photovoltaic.hourly_result.df["hoy"] == hour + 1, "value"]
                    pv_sum += pv_series.iloc[0] if not pv_series.empty else 0.0
            building_pv[building.name] = pv_sum

        return building_demand, building_pv

    def _collect_community_pv(self, hour: int) -> dict:
        """Collect community-level PV generation for a given hour. Prints debug info for each PV plant."""
        community_pv = {}
        for photovoltaic in getattr(self.community, "PV_plant", []):
            if hasattr(photovoltaic, "hourly_result") and isinstance(photovoltaic.hourly_result, HourlyData):
                pv_series = photovoltaic.hourly_result.df.loc[photovoltaic.hourly_result.df["hoy"] == hour + 1, "value"]
                val = pv_series.iloc[0] if not pv_series.empty else 0.0
                print(f"[DEBUG] Hour {hour+1} PV {getattr(photovoltaic, 'name', 'unnamed')}: {val} kWh")
            else:
                val = getattr(photovoltaic, "installed_capacity", 0.0) / 8760.0
                print(f"[DEBUG] Hour {hour+1} PV {getattr(photovoltaic, 'name', 'unnamed')}: fallback {val} kWh (no hourly_result)")
            community_pv[photovoltaic.name] = val
        return community_pv

    def _dispatch_self_consumption(self, t, hour, state, building_demand, building_pv):
        """Buildings use their own PVs first (self-consumption), supporting multiple PVs per building."""
        event_occurred = False
        for building in self.community.building:
            building_name = building.name
            demand = building_demand[building_name]
            pv_used_total = 0.0
            pv_available_total = 0.0
            # Distribute self-consumption across all PVs for this building
            for photovoltaic in getattr(building, "PV_plant", []):
                pv_node = f"{building_name}_PV_{photovoltaic.name}"
                # Get PV generation for this hour
                if hasattr(photovoltaic, "hourly_result") and isinstance(photovoltaic.hourly_result, HourlyData):
                    pv_series = photovoltaic.hourly_result.df.loc[photovoltaic.hourly_result.df["hoy"] == hour + 1, "value"]
                    pv_available = pv_series.iloc[0] if not pv_series.empty else 0.0
                else:
                    pv_available = 0.0
                # Use as much as possible for self-consumption
                used_pv = min(demand - pv_used_total, pv_available)
                if used_pv > 0:
                    self._update_flow(pv_node, building_name, t, used_pv)
                    print(f"[BUILDING SELF-CONSUME] Hour {t} {pv_node} -> {building_name}: {used_pv:.2f} kWh")
                    event_occurred = True
                pv_used_total += used_pv
                pv_available_total += pv_available
            # Deficit is what remains after all building PVs
            state["deficit"][building_name] = demand - pv_used_total
            state["surplus"][building_name] = pv_available_total - pv_used_total
        if event_occurred:
            print()

    def _dispatch_peer_to_peer(self, t, state):
        """Surplus from one building supplies deficit in another (P2P exchange)."""
        deficit_buildings = [b for b, d in state["deficit"].items() if d > 0]
        surplus_buildings = [b for b, s in state["surplus"].items() if s > 0]

        for surplus_building in surplus_buildings:
            surplus = state["surplus"][surplus_building]
            for deficit_building in deficit_buildings:
                deficit = state["deficit"][deficit_building]
                transfer = min(surplus, deficit)
                if transfer > 0:
                    self._update_flow(surplus_building, deficit_building, t, transfer)
                    state["surplus"][surplus_building] -= transfer
                    state["deficit"][deficit_building] -= transfer
                    surplus -= transfer
                    if state["surplus"][surplus_building] <= 0:
                        break

    def _dispatch_community_pv(self, t, state, community_pv):
        """Community PV plants supply remaining deficits."""
        event_occurred = False
        deficit_buildings = [b for b, d in state["deficit"].items() if d > 0]
        for pv_name, pv_energy in community_pv.items():
            for deficit_building in deficit_buildings:
                deficit = state["deficit"][deficit_building]
                transfer = min(pv_energy, deficit)
                if transfer > 0:
                    self._update_flow(f"PV_{pv_name}", deficit_building, t, transfer)
                    print(f"[COMMUNITY PV] Hour {t} PV_{pv_name} -> {deficit_building}: {transfer:.2f} kWh")
                    community_pv[pv_name] -= transfer
                    state["deficit"][deficit_building] -= transfer
                    pv_energy -= transfer
                    event_occurred = True
                    if community_pv[pv_name] <= 0:
                        break
        if event_occurred:
            print()

    def _dispatch_battery_discharge(self, t, state):
        """Community-level batteries discharge to cover remaining deficits."""
        event_occurred = False
        for battery in getattr(self.community, "battery", []):
            bat_node = f"BAT_{battery.name}"
            soc = state["battery_soc"].get(bat_node, None)
            if soc is None:
                continue
            available = soc[t]  # kWh available at start of hour
            eff = battery.efficiency / 100.0 if hasattr(battery, "efficiency") else 1.0
            # Discharge to all entities with deficit
            for entity_name, deficit in state["deficit"].items():
                discharge = min(available, deficit / eff)
                if discharge > 0:
                    self._update_flow(bat_node, entity_name, t, discharge * eff)
                    print(f"[BATTERY DISCHARGE] Hour {t} {bat_node} -> {entity_name}: {discharge * eff:.2f} kWh (SoC before: {available:.2f})")
                    state["deficit"][entity_name] -= discharge * eff
                    available -= discharge
                    event_occurred = True
            soc[t+1] = available
        if event_occurred:
            print()

    def _dispatch_grid_import(self, t, state):
        """Grid imports cover remaining deficits after all other sources."""
        for building in self.community.building:
            building_name = building.name
            deficit = state["deficit"][building_name]
            if deficit > 0:
                self._update_flow("GRID", building_name, t, deficit)
                state["deficit"][building_name] = 0.0

    #TODO: Add support for EV charging points dispatch for charge and discharge

    def _dispatch_battery_charge(self, t, state):
        """Charge community-level batteries with remaining surplus from all entities."""
        event_occurred = False
        for battery in getattr(self.community, "battery", []):
            bat_node = f"BAT_{battery.name}"
            soc = state["battery_soc"].get(bat_node, None)
            if soc is None:
                continue
            available_capacity = battery.capacity - soc[t+1]  # kWh available after discharge
            eff = battery.efficiency / 100.0 if hasattr(battery, "efficiency") else 1.0
            # Charge with surplus from all entities
            for entity_name, surplus in state["surplus"].items():
                charge = min(available_capacity, surplus * eff)
                if charge > 0:
                    self._update_flow(entity_name, bat_node, t, charge / eff)
                    print(f"[BATTERY CHARGE] Hour {t} {entity_name} -> {bat_node}: {charge / eff:.2f} kWh (SoC before: {soc[t+1]:.2f})")
                    state["surplus"][entity_name] -= charge / eff
                    available_capacity -= charge
                    event_occurred = True
            soc[t+1] = battery.capacity - available_capacity
        if event_occurred:
            print()

    def _dispatch_grid_export(self, t, state, community_pv):
        """Export remaining surplus to the grid."""
        for building in self.community.building:
            building_name = building.name
            surplus = state["surplus"][building_name]
            if surplus > 0:
                self._update_flow(building_name, "GRID", t, surplus)
        for pv_name, pv_energy in community_pv.items():
            if pv_energy > 0:
                self._update_flow(f"PV_{pv_name}", "GRID", t, pv_energy)

    # ================================================================
    # === KPI Calculation & Reporting ===
    # ================================================================

    def _compute_kpis(self, battery_soc):
        """Compute KPIs (self-sufficiency, self-consumption, etc.)."""
        total_demand = 0.0
        total_grid_import = 0.0
        total_pv_used = 0.0
        total_pv_generation = 0.0
        total_grid_export = 0.0
        total_grid_carbon_import = 0.0
        total_grid_price_import = 0.0
        total_grid_price_export = 0.0
        total_grid_carbon_intensity = 0.0
        n_grid_import_hours = 0
        n_grid_export_hours = 0
        building_self_consumption = {}

        # Only consider hours in self.hours
        hours_set = set(self.hours + 1)  # DataFrames use hoy=1-based

        for building in self.community.building:
            building_name = building.name

            # Grid import/export flows for analysis period
            if self.G.has_edge("GRID", building_name):
                flow = self.G.edges["GRID", building_name]["flow"]
                total_grid_import += np.sum(flow)
                n_grid_import_hours += np.count_nonzero(flow)
            if self.G.has_edge(building_name, "GRID"):
                flow = self.G.edges[building_name, "GRID"]["flow"]
                total_grid_export += np.sum(flow)
                n_grid_export_hours += np.count_nonzero(flow)

            # Demand for analysis period
            if hasattr(building, "electric_demand") and isinstance(building.electric_demand, HourlyData):
                df = building.electric_demand.df
                mask = df["hoy"].isin(hours_set)
                total_demand += df.loc[mask, "value"].sum()
            else:
                total_demand += getattr(building, "total_energy_demand", 0.0) * (self.n_hours / 8760.0)

            # PV generation and self-consumption for analysis period
            pv_used = 0.0
            pv_gen = 0.0
            for photovoltaic in getattr(building, "PV_plant", []):
                pv_node = f"{building_name}_PV_{photovoltaic.name}"
                if self.G.has_edge(pv_node, building_name):
                    flow = self.G.edges[pv_node, building_name]["flow"]
                    pv_used += np.sum(flow)
                if hasattr(photovoltaic, "hourly_result") and isinstance(photovoltaic.hourly_result, HourlyData):
                    df = photovoltaic.hourly_result.df
                    mask = df["hoy"].isin(hours_set)
                    pv_gen += df.loc[mask, "value"].sum()
            building_self_consumption[building_name] = 100 * (pv_used / pv_gen) if pv_gen > 0 else 0.0
            total_pv_used += pv_used
            total_pv_generation += pv_gen

        for photovoltaic in getattr(self.community, "PV_plant", []):
            pv_node = f"PV_{photovoltaic.name}"
            pv_used = 0.0
            if hasattr(photovoltaic, "hourly_result") and isinstance(photovoltaic.hourly_result, HourlyData):
                df = photovoltaic.hourly_result.df
                mask = df["hoy"].isin(hours_set)
                pv_gen = df.loc[mask, "value"].sum()
                total_pv_generation += pv_gen
            for building in self.community.building:
                if self.G.has_edge(pv_node, building.name):
                    flow = self.G.edges[pv_node, building.name]["flow"]
                    pv_used += np.sum(flow)
            total_pv_used += pv_used

        # Grid metrics for analysis period
        grid = getattr(self.community, "grid", None)
        if grid is not None:
            # Grid names these electricity_market_buying_price and
            # electricity_market_carbon_intensity. This block used to look for
            # grid.buying_price and grid.carbon_intensity, which are never set,
            # so it was unreachable and all three grid KPIs below stayed at 0.
            # The short names are still accepted in case anything supplies them.
            df_price = getattr(grid, "electricity_market_buying_price",
                               getattr(grid, "buying_price", None))
            df_carbon = getattr(grid, "electricity_market_carbon_intensity",
                                getattr(grid, "carbon_intensity", None))

            carbon_vals = None
            if isinstance(df_carbon, HourlyData):
                df = df_carbon.df
                carbon_series = df.loc[df["hoy"].isin(hours_set), "value"]
                total_grid_carbon_intensity = carbon_series.mean()
                carbon_vals = carbon_series.values

            if isinstance(df_price, HourlyData):
                df = df_price.df
                total_grid_price_import = df.loc[df["hoy"].isin(hours_set), "value"].mean()

            # grid.hourly_import is initialised to zeros and never written by
            # the dispatch, so multiplying by it always gave zero. Take the
            # imported energy from the dispatched flows instead, using the same
            # GRID -> building edges that total_grid_import is summed from.
            if carbon_vals is not None:
                import_by_hour = np.zeros(self.n_hours, dtype=float)
                for building in self.community.building:
                    if self.G.has_edge("GRID", building.name):
                        flow = np.asarray(self.G.edges["GRID", building.name]["flow"], dtype=float)
                        import_by_hour[:len(flow)] += flow[:self.n_hours]
                n = min(len(import_by_hour), len(carbon_vals))
                total_grid_carbon_import = float(np.sum(import_by_hour[:n] * carbon_vals[:n]))

        self.kpis = KPIResult(
            total_demand=total_demand,
            total_grid_import=total_grid_import,
            total_grid_export=total_grid_export,
            total_pv_used=total_pv_used,
            total_pv_gen=total_pv_generation,
            self_sufficiency=100 * (1 - total_grid_import / total_demand) if total_demand > 0 else 0.0,
            self_consumption=100 * (total_pv_used / total_pv_generation) if total_pv_generation > 0 else 0.0,
            avg_grid_carbon_intensity=total_grid_carbon_intensity,
            total_grid_carbon_import=total_grid_carbon_import,
            avg_grid_price_import=total_grid_price_import,
            avg_building_self_consumption=np.mean(list(building_self_consumption.values())) if building_self_consumption else 0.0,
            building_self_consumption=building_self_consumption
        )

    def get_kpis(self) -> KPIResult:
        """Return computed KPIs after running the simulation."""
        return self.kpis

    def report(self) -> str:
        """Generate a human-readable text report summarizing inputs, steps, and results."""
        lines = []
        lines.append("=== ECOMDispatcher Report ===\n")
        lines.append(f"Community: {getattr(self.community, 'name', 'Unnamed')}")
        lines.append(f"Dispatch mode: {self.dispatch_mode}")
        lines.append(f"Analysis period: {self.start_hour} to {self.end_hour} (n_hours={self.n_hours})")
        lines.append("\n--- Grid Entity ---")
        lines.append(self.community.grid.report())
        lines.append("\n--- KPI Results ---")
        if self.kpis:
            k = self.kpis
            lines.append(f"Total demand: {k.total_demand:.2f} kWh")
            lines.append(f"Grid import: {k.total_grid_import:.2f} kWh")
            lines.append(f"Grid export: {k.total_grid_export:.2f} kWh")
            lines.append(f"PV used: {k.total_pv_used:.2f} kWh / PV gen: {k.total_pv_gen:.2f} kWh")
            lines.append(f"Self-sufficiency: {k.self_sufficiency:.2f}%")
            lines.append(f"Self-consumption: {k.self_consumption:.2f}%")
        else:
            lines.append("(Run the simulation to compute KPIs.)")

        return "\n".join(lines)
