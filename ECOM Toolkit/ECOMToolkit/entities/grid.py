#! python3
# r: pandas, numpy

import numpy as np
import pandas as pd
from ECOMToolkit.analysis.data import HourlyData

class Grid:
    """
    Grid entity for energy community simulation.
    Stores market prices, carbon intensity, and hourly import/export data.
    Dispatcher updates its values; not used for direct dispatch logic.
    """
    def __init__(self,
                 electricity_market_buying_price=None,
                 electricity_market_selling_price=None,
                 electricity_market_carbon_intensity=None,
                 analysis_period=None):
        self.start_hour, self.end_hour = self._prepare_period(analysis_period)
        self.n_hours = self.end_hour - self.start_hour + 1
        # Prepare market price and carbon as HourlyData
        from ECOMToolkit.analysis.data import DataCategory, DataUnit
        hoys_full = pd.Series(range(1, 8761))
        # Buying price
        buying_price_arr = self._prepare_market_price(electricity_market_buying_price)
        df_buying = pd.DataFrame({'hoy': hoys_full, 'value': buying_price_arr})
        self.electricity_market_buying_price = HourlyData(
            df_buying,
            meta={'type': 'buying_price'},
            title='Market Buying Price',
            source='Grid Entity',
            units=DataUnit.SEK,
            category=DataCategory.COST
        )
        # Selling price
        selling_price_arr = self._prepare_market_price(electricity_market_selling_price)
        df_selling = pd.DataFrame({'hoy': hoys_full, 'value': selling_price_arr})
        self.electricity_market_selling_price = HourlyData(
            df_selling,
            meta={'type': 'selling_price'},
            title='Market Selling Price',
            source='Grid Entity',
            units=DataUnit.SEK,
            category=DataCategory.COST
        )
        # Carbon intensity
        carbon_arr = self._prepare_market_carbon(electricity_market_carbon_intensity)
        df_carbon = pd.DataFrame({'hoy': hoys_full, 'value': carbon_arr})
        self.electricity_market_carbon_intensity = HourlyData(
            df_carbon,
            meta={'type': 'carbon_intensity'},
            title='Market Carbon Intensity',
            source='Grid Entity',
            units=DataUnit.KILOGRAM_CO2,
            category=DataCategory.CARBON
        )
        from ECOMToolkit.analysis.data import DataCategory, DataUnit

        # Pad import/export to full 8760 HOYs, fill analysis period with zeros, rest also zeros
        hoys = pd.Series(range(1, 8761))
        import_values = np.zeros(8760)
        export_values = np.zeros(8760)
        # Optionally, you could fill analysis period with other values if needed
        df_import = pd.DataFrame({'hoy': hoys, 'value': import_values})
        df_export = pd.DataFrame({'hoy': hoys, 'value': export_values})
        self.hourly_import = HourlyData(
            df_import,
            meta={'type': 'import'},
            title='Grid Import',
            source='Grid Entity',
            units=DataUnit.KILOWATT_HOUR,
            category=DataCategory.ENERGY
        )
        self.hourly_export = HourlyData(
            df_export,
            meta={'type': 'export'},
            title='Grid Export',
            source='Grid Entity',
            units=DataUnit.KILOWATT_HOUR,
            category=DataCategory.ENERGY
        )

    def _prepare_market_price(self, price) -> np.ndarray:
        DEFAULT_MARKET_PRICE = 1.5
        if price is None:
            return np.full(8760, DEFAULT_MARKET_PRICE)
        if isinstance(price, (int, float)):
            return np.full(8760, float(price))
        period_length = self.end_hour - self.start_hour + 1
        if isinstance(price, (list, np.ndarray)):
            arr = np.array(price, dtype=float)
            if arr.size == 1:
                return np.full(8760, float(arr[0]))
            if arr.size == 8760:
                return arr
            if arr.size == period_length:
                full_arr = np.full(8760, DEFAULT_MARKET_PRICE, dtype=float)
                full_arr[self.start_hour:self.end_hour+1] = arr
                return full_arr
            raise ValueError(f"Market price array must have 8760 values, a single value, or match the analysis period length ({period_length}).")
        if isinstance(price, pd.Series):
            arr = price.values
            if arr.size == 1:
                return np.full(8760, float(arr[0]))
            if arr.size == 8760:
                return arr
            if arr.size == period_length:
                full_arr = np.full(8760, DEFAULT_MARKET_PRICE, dtype=float)
                full_arr[self.start_hour:self.end_hour+1] = arr
                return full_arr
            raise ValueError(f"Market price Series must have 8760 values, a single value, or match the analysis period length ({period_length}).")
        if isinstance(price, pd.DataFrame) and "price" in price.columns:
            arr = price["price"].values
            if arr.size == 1:
                return np.full(8760, float(arr[0]))
            if arr.size == 8760:
                return arr
            if arr.size == period_length:
                full_arr = np.full(8760, DEFAULT_MARKET_PRICE, dtype=float)
                full_arr[self.start_hour:self.end_hour+1] = arr
                return full_arr
            raise ValueError(f"Market price DataFrame must have 8760 values, a single value, or match the analysis period length ({period_length}).")
        raise TypeError("market_price must be float, list, np.ndarray, Series, or DataFrame with 'price' column.")

    def _prepare_market_carbon(self, carbon) -> np.ndarray:
        DEFAULT_MARKET_CARBON = 18
        if carbon is None:
            return np.full(8760, DEFAULT_MARKET_CARBON)
        if isinstance(carbon, (int, float)):
            return np.full(8760, float(carbon))
        period_length = self.end_hour - self.start_hour + 1
        if isinstance(carbon, (list, np.ndarray)):
            arr = np.array(carbon, dtype=float)
            if arr.size == 1:
                return np.full(8760, float(arr[0]))
            if arr.size == 8760:
                return arr
            if arr.size == period_length:
                full_arr = np.full(8760, DEFAULT_MARKET_CARBON, dtype=float)
                full_arr[self.start_hour:self.end_hour+1] = arr
                return full_arr
            raise ValueError(f"Market carbon array must have 8760 values, a single value, or match the analysis period length ({period_length}).")
        if isinstance(carbon, pd.Series):
            arr = carbon.values
            if arr.size == 1:
                return np.full(8760, float(arr[0]))
            if arr.size == 8760:
                return arr
            if arr.size == period_length:
                full_arr = np.full(8760, DEFAULT_MARKET_CARBON, dtype=float)
                full_arr[self.start_hour:self.end_hour+1] = arr
                return full_arr
            raise ValueError(f"Market carbon Series must have 8760 values, a single value, or match the analysis period length ({period_length}).")
        if isinstance(carbon, pd.DataFrame) and "carbon" in carbon.columns:
            arr = carbon["carbon"].values
            if arr.size == 1:
                return np.full(8760, float(arr[0]))
            if arr.size == 8760:
                return arr
            if arr.size == period_length:
                full_arr = np.full(8760, DEFAULT_MARKET_CARBON, dtype=float)
                full_arr[self.start_hour:self.end_hour+1] = arr
                return full_arr
            raise ValueError(f"Market carbon DataFrame must have 8760 values, a single value, or match the analysis period length ({period_length}).")
        raise TypeError("market_carbon must be float, list, np.ndarray, Series, or DataFrame with 'carbon' column.")

    def _prepare_period(self, period):
        """Ensure analysis period stays within [0..8759]. Accepts tuple (start, end) or list of hoys."""
        if period is None:
            return 0, 8759
        if isinstance(period, (tuple, list)):
            if len(period) == 2 and all(isinstance(x, int) for x in period):
                return max(0, period[0]), min(period[1], 8759)
            # If it's a list of hoys (not a tuple)
            if len(period) > 2 and all(isinstance(x, int) for x in period):
                return max(0, min(period)), min(max(period), 8759)
        raise ValueError("analysis_period must be a tuple (start, end) or a list of hoys (integers)")

    def validate(self):
        errors = []
        if self.electricity_market_buying_price is None:
            errors.append("Missing buying price.")
        if self.electricity_market_selling_price is None:
            errors.append("Missing selling price.")
        if self.electricity_market_carbon_intensity is None:
            errors.append("Missing carbon intensity.")
        return errors

    def report(self):
        lines = [f"Grid Entity Report:",
                 f"  Analysis period: {self.start_hour} to {self.end_hour}",
                 f"  Buying price (first 3): {self.electricity_market_buying_price.df['value'][:3].tolist()}",
                 f"  Selling price (first 3): {self.electricity_market_selling_price.df['value'][:3].tolist()}",
                 f"  Carbon intensity (first 3): {self.electricity_market_carbon_intensity.df['value'][:3].tolist()}",
                 f"  Hourly import (first 3): {self.hourly_import.df['value'][:3].tolist()}",
                 f"  Hourly export (first 3): {self.hourly_export.df['value'][:3].tolist()}"]
        errors = self.validate()
        if errors:
            lines.append("  Validation errors:")
            lines.extend([f"    - {e}" for e in errors])
        else:
            lines.append("  Validation: OK")
        return "\n".join(lines)

    def __repr__(self):
        lines = [
            f"Grid Entity Summary:",
            f"  Analysis period: {self.start_hour} to {self.end_hour}",
            f"  Market Buying Price: first 3 = {self.electricity_market_buying_price.df['value'].head(3).tolist()} SEK",
            f"  Market Selling Price: first 3 = {self.electricity_market_selling_price.df['value'][:3].tolist()} SEK",
            f"  Market Carbon Intensity: first 3 = {self.electricity_market_carbon_intensity.df['value'][:3].tolist()} kgCO2",
            f"  Hourly Import: first 3 = {self.hourly_import.df['value'][:3].tolist()} kWh",
            f"  Hourly Export: first 3 = {self.hourly_export.df['value'][:3].tolist()} kWh",
            f"  Meta: Buying={self.electricity_market_buying_price.meta}, Selling={self.electricity_market_selling_price.meta}, Carbon={self.electricity_market_carbon_intensity.meta}"
        ]
        return "\n".join(lines)
