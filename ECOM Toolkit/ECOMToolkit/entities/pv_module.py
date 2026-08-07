class PVModule:
    """
    A class to represent a photovoltaic (PV) module, including cost and embodied carbon.
    """

    def __init__(
        self,
        name: str = None,
        rating: float = None,
        size_x: float = None,
        size_y: float = None,
        cost: float = None,
        embodied_co2: float = None
    ):
        """
        Initialize a PVModule instance. If no arguments are provided, defaults are used:
            name = 'Default 400W Panel'
            rating = 400 (W)
            size_x = 1.0 (m)
            size_y = 2.0 (m)
            cost = 3100 (SEK/kWp)
            embodied_co2 = 615 (kgCO2e/kWp)
        Args:
            name: Module name or model identifier.
            rating: Rated power under STC (Watts).
            size_x: Module length (m).
            size_y: Module width (m).
            cost: Cost per kWp (SEK/kWp).
            embodied_co2: Embodied carbon per kWp (kgCO2e/kWp).
        """
        # Set defaults if not provided
        if name is None:
            name = 'Default 400W Panel'
        if rating is None:
            rating = 400.0
        if size_x is None:
            size_x = 1.0
        if size_y is None:
            size_y = 2.0
        if cost is None:
            cost = 3100.0 / 1000.0  # 3.1 SEK/Wp -> 3100 SEK/kWp
        if embodied_co2 is None:
            embodied_co2 = 615.0  # kgCO2e/kWp

        if not name:
            raise ValueError("Module name is required.")
        if rating <= 0:
            raise ValueError("Rating must be greater than 0.")
        if size_x <= 0 or size_y <= 0:
            raise ValueError("Module dimensions must be greater than 0.")
        if cost <= 0:
            raise ValueError("Cost must be greater than 0.")
        if embodied_co2 <= 0:
            raise ValueError("Embodied CO2 must be greater than 0.")

        self.name = str(name)
        self.rating = float(rating)  # W
        self.size_x = float(size_x)  # m
        self.size_y = float(size_y)  # m
        self.cost_per_kwp = float(cost) * 1000.0 if cost < 100 else float(cost)  # SEK/kWp
        self.embodied_co2_per_kwp = float(embodied_co2)  # kgCO2e/kWp

        self.area = self.size_x * self.size_y
        self.efficiency = (self.rating / (self.area * 1000)) * 100
        self.total_cost = (self.rating / 1000.0) * self.cost_per_kwp  # SEK/panel
        self.total_embodied_co2 = (self.rating / 1000.0) * self.embodied_co2_per_kwp  # kgCO2e/panel

    def validate(self) -> str:
        """
        Validate the PV module's attributes.

        Returns:
            str: Validation message.
        """
        if not self.name:
            return "Error: Module name is missing."
        if self.rating <= 0:
            return "Error: Rating must be greater than 0."
        if self.area <= 0:
            return "Error: Area must be greater than 0."
        if self.cost_per_kwp <= 0:
            return "Error: Cost must be greater than 0."
        if self.embodied_co2_per_kwp <= 0:
            return "Error: Embodied CO2 must be greater than 0."
        return f"PV Module '{self.name}' is valid."

    def __repr__(self) -> str:
        """
        String representation of the PVModule.

        Returns:
            str: Formatted string with module details.
        """
        return (
            f"PV Module: {self.name}\n"
            f"Rated Power: {self.rating} W\n"
            f"Area: {self.area:.2f} m² | Efficiency: {self.efficiency:.2f} %\n"
            f"Total Cost: {self.total_cost:.2f} SEK/panel\n"
            f"Total Embodied CO₂: {self.total_embodied_co2:.2f} kgCO₂e/panel"
        )