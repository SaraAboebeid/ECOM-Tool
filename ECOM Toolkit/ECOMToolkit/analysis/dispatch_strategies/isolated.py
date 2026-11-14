from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from ECOMToolkit.analysis.dispatcher import ECOMDispatcher


class IsolatedDispatchStrategy:
    """
    Every building on its own: the same buildings with no energy community.

    This is the baseline a community is measured against. What a building can do
    for itself is all it gets: its own panels first, its own battery after that,
    the grid for whatever is left, and the grid again for any surplus. Nothing
    is shared.

    It is the community strategy with the three sharing steps taken out -
    peer-to-peer exchange, community-owned PV and the community battery - so
    that the two differ by exactly the thing being compared and by nothing else.
    The order of everything that remains is unchanged.

    Charge points stay: the cars still need charging, and with no community
    there is nobody to charge them from but the grid, which is part of what
    being without one costs.
    """

    def dispatch(self, dispatcher: 'ECOMDispatcher', strategy: str = "default"):
        dispatcher.dispatch_strategy = strategy
        dispatcher.last_battery_soc = dispatcher._init_battery_soc()
        state = dispatcher._init_state()

        for t, hour in enumerate(dispatcher.hours):
            state["deficit"], state["surplus"] = {}, {}

            building_demand, building_pv = dispatcher._collect_building_data(hour)
            # Collected so that PV owned by nobody in particular is exported
            # rather than silently dropped; with no community to own it, it has
            # nowhere else to go.
            community_pv = dispatcher._collect_community_pv(hour)
            charge_point_demand = dispatcher._collect_charge_point_demand(hour)

            dispatcher._dispatch_self_consumption(t, hour, state, building_demand, building_pv)
            dispatcher._add_charge_point_demand(t, state, charge_point_demand)

            # A battery in a building is that building's: it covers its own
            # deficit and takes its own surplus, and does not look further.
            dispatcher._own_battery_discharge(t, state)
            dispatcher._own_battery_charge(t, state)

            # --- no peer-to-peer, no community PV, no community battery ---

            dispatcher._dispatch_grid_import(t, state)
            dispatcher._dispatch_grid_export(t, state, community_pv)
            dispatcher._log_hourly_flows(t, hour)

        dispatcher._compute_kpis(dispatcher.last_battery_soc)
