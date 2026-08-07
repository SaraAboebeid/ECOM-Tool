from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from ECOMToolkit.analysis.dispatcher import ECOMDispatcher

class MarketDispatchStrategy:
    """
    Implements the 'market' dispatch logic for ECOMDispatcher.
    Prioritizes selling energy when profitable, rather than self-consumption.
    """
    def dispatch(self, dispatcher: 'ECOMDispatcher', strategy: str = "default"):
        dispatcher.dispatch_strategy = strategy
        dispatcher.last_battery_soc = dispatcher._init_battery_soc()
        state = dispatcher._init_state()

        for t, hour in enumerate(dispatcher.hours):
            state["deficit"], state["surplus"] = {}, {}

            building_demand, building_pv = dispatcher._collect_building_data(hour)
            community_pv = dispatcher._collect_community_pv(hour)

            # --- MARKET LOGIC ---
            grid_price = getattr(dispatcher.community.grid, "buying_price", None)
            internal_price = dispatcher.community_internal_price_selling
            for building in dispatcher.community.building:
                building_name = building.name
                pv_available_total = 0.0
                for photovoltaic in getattr(building, "PV_plant", []):
                    pv_node = f"{building_name}_PV_{photovoltaic.name}"
                    if hasattr(photovoltaic, "hourly_result"):
                        pv_series = photovoltaic.hourly_result.df.loc[photovoltaic.hourly_result.df["hoy"] == hour + 1, "value"]
                        pv_available = pv_series.iloc[0] if not pv_series.empty else 0.0
                    else:
                        pv_available = 0.0
                    pv_available_total += pv_available
                    price = grid_price.df.loc[grid_price.df["hoy"] == hour + 1, "value"].iloc[0] if grid_price else 0.0
                    if price > internal_price:
                        dispatcher._update_flow(pv_node, "GRID", t, pv_available)
                        state["surplus"][building_name] = 0.0
                        state["deficit"][building_name] = building_demand[building_name]
                    else:
                        used_pv = min(building_demand[building_name], pv_available)
                        dispatcher._update_flow(pv_node, building_name, t, used_pv)
                        state["deficit"][building_name] = building_demand[building_name] - used_pv
                        state["surplus"][building_name] = pv_available - used_pv

            dispatcher._dispatch_peer_to_peer(t, state)

            for pv_name, pv_energy in community_pv.items():
                price = grid_price.df.loc[grid_price.df["hoy"] == hour + 1, "value"].iloc[0] if grid_price else 0.0
                if price > internal_price:
                    dispatcher._update_flow(f"PV_{pv_name}", "GRID", t, pv_energy)
                else:
                    deficit_buildings = [b for b, d in state["deficit"].items() if d > 0]
                    for deficit_building in deficit_buildings:
                        deficit = state["deficit"][deficit_building]
                        transfer = min(pv_energy, deficit)
                        if transfer > 0:
                            dispatcher._update_flow(f"PV_{pv_name}", deficit_building, t, transfer)
                            community_pv[pv_name] -= transfer
                            state["deficit"][deficit_building] -= transfer
                            pv_energy -= transfer
                            if community_pv[pv_name] <= 0:
                                break

            dispatcher._dispatch_battery_discharge(t, state)
            dispatcher._dispatch_grid_import(t, state)
            dispatcher._dispatch_battery_charge(t, state)
            dispatcher._dispatch_grid_export(t, state, community_pv)
            # Consistent logging for each hour
            dispatcher._log_hourly_flows(t, hour)

        # Consistent KPI computation and reporting
        dispatcher._compute_kpis(dispatcher.last_battery_soc)
