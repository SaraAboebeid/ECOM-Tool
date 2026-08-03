class EnergyCommunity:
    """Energy Community container object."""

    def __init__(self, building=None, PV_plant=None, Battery=None, charging_points=None, grid=None):
        self.building = building if isinstance(building, list) else ([building] if building else [])
        self.PV_plant = PV_plant if isinstance(PV_plant, list) else ([PV_plant] if PV_plant else [])
        self.battery = Battery if isinstance(Battery, list) else ([Battery] if Battery else [])
        self.charge_point = charging_points if isinstance(charging_points, list) else ([charging_points] if charging_points else [])
        self.grid = grid

    def validate(self):
        # Count PV inside buildings separately
        building_pv_count = sum(len(b.PV_plant) for b in self.building if hasattr(b, "PV_plant"))
        standalone_pv_count = len(self.PV_plant)

        return ("Energy Community merged successfully:\n"
                "- Building: {} (with {} integrated PV plant)\n"
                "- Standalone PV Plants: {}\n"
                "- Standalone Batteries: {}\n"
                "- Charge Points: {}\n"
                "- Grid: {}"
                .format(
                    len(self.building),
                    building_pv_count,
                    standalone_pv_count,
                    len(self.battery),
                    len(self.charge_point),
                    getattr(self.grid, "name", "Grid") if self.grid else "None"
                ))

    def __repr__(self):
        lines = [
            f"Energy Community Summary:",
            f"  Grid: {getattr(self.grid, 'name', 'Grid') if self.grid else 'None'}",
            f"  Buildings: {len(self.building)}",
        ]
        for i, b in enumerate(self.building, 1):
            lines.append(f"    [{i}] {repr(b).replace(chr(10), chr(10)+'      ')}")
        lines.append(f"  Standalone PV Plants: {len(self.PV_plant)}")
        for i, pv in enumerate(self.PV_plant, 1):
            lines.append(f"    [{i}] {repr(pv).replace(chr(10), chr(10)+'      ')}")
        lines.append(f"  Standalone Batteries: {len(self.battery)}")
        for i, bat in enumerate(self.battery, 1):
            lines.append(f"    [{i}] {repr(bat).replace(chr(10), chr(10)+'      ')}")
        lines.append(f"  Charge Points: {len(self.charge_point)}")
        for i, cp in enumerate(self.charge_point, 1):
            lines.append(f"    [{i}] {repr(cp).replace(chr(10), chr(10)+'      ')}")
        return "\n".join(lines)
