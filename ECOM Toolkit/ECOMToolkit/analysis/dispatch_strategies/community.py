from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from ECOMToolkit.analysis.dispatcher import ECOMDispatcher

class CommunityDispatchStrategy:
    """
    Implements the 'community' dispatch logic for ECOMDispatcher.
    """
    
    def dispatch(self, dispatcher: 'ECOMDispatcher', strategy: str = "default"):
        dispatcher.dispatch_strategy = strategy
        dispatcher.last_battery_soc = dispatcher._init_battery_soc()
        state = dispatcher._init_state()

        for t, hour in enumerate(dispatcher.hours):
            state["deficit"], state["surplus"] = {}, {}

            building_demand, building_pv = dispatcher._collect_building_data(hour)
            community_pv = dispatcher._collect_community_pv(hour)

            dispatcher._dispatch_self_consumption(t, hour, state, building_demand, building_pv)
            dispatcher._dispatch_peer_to_peer(t, state)
            dispatcher._dispatch_community_pv(t, state, community_pv)
            dispatcher._dispatch_battery_discharge(t, state)
            dispatcher._dispatch_grid_import(t, state)
            dispatcher._dispatch_battery_charge(t, state)
            dispatcher._dispatch_grid_export(t, state, community_pv)
            dispatcher._log_hourly_flows(t, hour)

        dispatcher._compute_kpis(dispatcher.last_battery_soc)

