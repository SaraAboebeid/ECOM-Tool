class KPIResult:
    """
    Container for scenario KPIs and summary statistics for an energy community dispatch run.
    """
    def __init__(self, total_demand=0.0, total_grid_import=0.0, total_grid_export=0.0, total_pv_used=0.0, total_pv_gen=0.0,
                 self_sufficiency=0.0, self_consumption=0.0, **kwargs):
        self.total_demand = total_demand
        self.total_grid_import = total_grid_import
        self.total_grid_export = total_grid_export
        self.total_pv_used = total_pv_used
        self.total_pv_gen = total_pv_gen
        self.self_sufficiency = self_sufficiency
        self.self_consumption = self_consumption
        # Store any additional KPIs
        for k, v in kwargs.items():
            setattr(self, k, v)

    def as_dict(self):
        return self.__dict__

    def __repr__(self):
        return (f"KPIResult(total_demand={self.total_demand:.1f}, total_grid_import={self.total_grid_import:.1f}, "
                f"total_grid_export={self.total_grid_export:.1f}, total_pv_used={self.total_pv_used:.1f}, "
                f"total_pv_gen={self.total_pv_gen:.1f}, self_sufficiency={self.self_sufficiency:.1f}%, "
                f"self_consumption={self.self_consumption:.1f}%)")
