import matplotlib.pyplot as plt
import networkx as nx
from matplotlib.animation import FuncAnimation

# Step 1: Load or import your dispatcher from wherever it was saved or run
from ECOMToolkit.analysis.dispatcher import ECOMDispatcher
# You must instantiate dispatcher with a valid EnergyCommunity object, e.g.:
# from ECOMToolkit.entities.energy_community import EnergyCommunity
# community = EnergyCommunity(...)  # fill in with actual parameters
# dispatcher = ECOMDispatcher(community)

# Step 2: Helper function to extract the graph at hour `t`
def get_hourly_graph(dispatcher, t: int):
    G_hourly = nx.DiGraph()

    for node, attrs in dispatcher.G.nodes(data=True):
        G_hourly.add_node(node, **attrs)

    for u, v, attrs in dispatcher.G.edges(data=True):
        flow = attrs["flow"][t]
        if flow > 0:
            G_hourly.add_edge(u, v, flow=flow)

    return G_hourly

# Step 3: Function to animate hourly dispatch
def animate_dispatch(dispatcher, hours=None, interval=200):
    if hours is None:
        hours = range(dispatcher.n_hours)

    fig, ax = plt.subplots(figsize=(10, 8))
    pos = nx.spring_layout(dispatcher.G, seed=42)  # consistent layout

    # Timeline bar setup
    timeline_ax = fig.add_axes([0.1, 0.92, 0.8, 0.03])
    timeline_ax.set_xlim(0, len(hours) - 1)
    timeline_ax.set_ylim(0, 1)
    timeline_ax.axis('off')
    timeline_bar = timeline_ax.barh([0], [0], height=1, color='skyblue')

    # Color map for flows
    import matplotlib.cm as cm
    import numpy as np
    cmap = cm.get_cmap('coolwarm')

    def update(t):
        ax.clear()
        G_t = get_hourly_graph(dispatcher, t)
        flows = [G_t.edges[u, v]['flow'] for u, v in G_t.edges]
        max_flow = max(flows) if flows else 1

        # Color edges by flow magnitude
        if flows:
            norm_flows = np.array(flows) / max_flow
            edge_colors = [cmap(f) for f in norm_flows]
            widths = [3 * f for f in norm_flows]
        else:
            edge_colors = 'gray'
            widths = 1

        nx.draw(G_t, pos, ax=ax, with_labels=True,
                node_color='lightblue', edge_color=edge_colors,
                node_size=1000, font_size=8,
                width=widths)

        ax.set_title(f"Hour {dispatcher.hours[t]}")
        ax.axis("off")

        # Update timeline bar
        timeline_bar[0].set_width(t)
        timeline_ax.clear()
        timeline_ax.barh([0], [t], height=1, color='skyblue')
        timeline_ax.set_xlim(0, len(hours) - 1)
        timeline_ax.axis('off')
        timeline_ax.text(t, 0.5, f"Hour {dispatcher.hours[t]}", va='center', ha='right', fontsize=10)

        # Add legend for flow magnitude
        sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(vmin=0, vmax=max_flow))
        sm.set_array([])
        cbar = plt.colorbar(sm, ax=ax, orientation='vertical', fraction=0.03, pad=0.02)
        cbar.set_label('Flow Magnitude')

    ani = FuncAnimation(fig, update, frames=hours, interval=interval, repeat=False)

    # Save animation as GIF (optional, comment out if not needed)
    try:
        ani.save('dispatch_animation.gif', writer='pillow')
        print('Animation saved as dispatch_animation.gif')
    except Exception as e:
        print(f'Could not save animation: {e}')

    plt.show()

# Step 4: Call the function
animate_dispatch(dispatcher)
