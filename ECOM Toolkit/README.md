# ECOMToolkit

ECOMToolkit is a Python-based toolkit designed for the analysis, simulation, and optimization of energy communities. It provides modules for modeling various energy entities (such as buildings, batteries, PV plants, electric vehicles, and grids), analyzing energy data, and simulating different dispatch strategies within an energy community context.

## Author
Sara Abouebeid

## Features
- **Entity Modeling:** Classes for batteries, buildings, charge points, electric vehicles, PV modules, PV plants, and grids.
- **Data Analysis:** Tools for loading, processing, and visualizing energy demand and supply data.
- **Dispatch Strategies:** Implementations of community and market-based dispatch strategies.
- **KPI Calculation:** Functions to compute key performance indicators for energy communities.
- **Result Visualization:** Utilities to visualize dispatch results and community performance.

## Project Structure
```
ECOMToolkit/
    analysis/
        data.py                # Data loading and processing
        dispatcher.py          # Dispatch logic and simulation
        kpi.py                 # KPI calculations
        result.py              # Result handling
        visualize_dispatch.py  # Visualization tools
        dispatch_strategies/
            community.py       # Community-based dispatch
            market.py          # Market-based dispatch
    entities/
        battery.py             # Battery entity model
        building.py            # Building entity model
        charge_point.py        # EV charge point model
        electric_vehicle.py    # Electric vehicle model
        energy_community.py    # Community aggregation logic
        grid.py                # Grid connection model
        pv_module.py           # PV module model
        pv_plant.py            # PV plant model
    data/
        sample_el_demand.csv   # Example demand data
    __init__.py
ECOM_toolkit.gh                # Grasshopper component file (if used with Rhino/Grasshopper)
```

## Getting Started
1. **Clone the repository:**
   ```powershell
   git clone <repo-url>
   cd GH_Components
   ```
2. **Install dependencies:**
   (If requirements.txt is provided, otherwise ensure Python 3.8+ is installed.)
   ```powershell
   pip install -r requirements.txt
   ```
3. **Run analysis or simulations:**
   Import the relevant modules from `ECOMToolkit` in your Python scripts or Jupyter notebooks.
   ```python
   from ECOMToolkit.analysis import dispatcher, kpi
   from ECOMToolkit.entities import building, battery
   # ...
   ```

## Example Usage
```python
from ECOMToolkit.analysis import data, dispatcher
from ECOMToolkit.entities import building, battery

# Load sample demand data
demand = data.load_demand('ECOMToolkit/data/sample_el_demand.csv')

# Create building and battery objects
bldg = building.Building(...)
batt = battery.Battery(...)

# Simulate dispatch
results = dispatcher.simulate_dispatch([bldg, batt], demand)
```

## Notes
- The toolkit is modular and can be extended with new entity types or dispatch strategies.
- The `ECOM_toolkit.gh` file can be used as a Grasshopper component for visual scripting in Rhino (if applicable).


## Contact
saraabouebeid@gmail.com