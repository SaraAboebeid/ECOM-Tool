import pandas as pd
from typing import Optional, Dict, Any, Union
from enum import Enum

# Enum for data categories (input/result types)
class DataCategory(Enum):
    POWER = "power"
    ENERGY = "energy"
    COST = "cost"
    CARBON = "carbon"
    OTHER = "other"

# Enum for standard units (expand as needed)
class DataUnit(Enum):
    KILOWATT = "kW"
    MEGAWATT = "MW"
    KILOWATT_HOUR = "kWh"
    MEGAWATT_HOUR = "MWh"
    EURO = "EUR"
    USD = "USD"
    SEK = "SEK"
    TONNE_CO2 = "tCO2"
    KILOGRAM_CO2 = "kgCO2"
    UNKNOWN = "unknown"

class HourlyData:
    """
    Generic class for hourly data (input or result).
    Always expects two columns: 'hoy' (hour of year, 1-8760) and 'value'.
    Can be loaded from CSV or constructed from DataFrame.
    """
    def __init__(
        self,
        df: pd.DataFrame,
        meta: Optional[Dict[str, Any]] = None,
        title: Optional[str] = None,
        source: Optional[str] = None,
        units: Optional[Union[str, DataUnit, Dict[str, Any]]] = None,
        category: Optional[DataCategory] = None,
    ):
        # Ensure DataFrame has only 'hoy' and 'value' columns
        if not set(['hoy', 'value']).issubset(df.columns):
            raise ValueError("DataFrame must contain 'hoy' and 'value' columns.")
        df = df[['hoy', 'value']].copy()
        # Ensure 'value' is numeric
        df['value'] = pd.to_numeric(df['value'], errors='coerce')
        # Ensure 'hoy' is integer and consecutive from 1 to 8760
        df['hoy'] = pd.to_numeric(df['hoy'], errors='coerce').astype(int)
        if not (df['hoy'].min() == 1 and df['hoy'].max() == 8760 and (df['hoy'].diff().dropna() == 1).all()):
            raise ValueError("'hoy' must be consecutive integers from 1 to 8760.")
        self.df = df
        self.meta = meta or {}
        self.title = title
        self.source = source
        self.units = units
        self.category = category

    @classmethod
    def from_csv(cls, path: str, **kwargs):
        """
        Load HourlyData from a CSV file with columns 'hoy' and 'value'.
        """
        df = pd.read_csv(path, **kwargs)
        return cls(df)

    def to_csv(self, path: str, **kwargs):
        """
        Save HourlyData to a CSV file with columns 'hoy' and 'value'.
        """
        self.df.to_csv(path, index=False, **kwargs)

    def __repr__(self):
        lines = []
        if self.title:
            lines.append(f"{self.title}")
        if self.category:
            cat = self.category.name if isinstance(self.category, Enum) else self.category
            lines.append(f"Category: {cat}")
        if self.units:
            if isinstance(self.units, Enum):
                units = self.units.name
            else:
                units = str(self.units)
            lines.append(f"Units: {units}")
        if self.source:
            lines.append(f"Source: {self.source}")
        lines.append(f"Shape: {self.df.shape}")
        cols = ', '.join(map(str, self.df.columns))
        lines.append(f"Columns: {cols}")
        if len(self.df) > 0:
            first_row = self.df.iloc[0].to_dict()
            row_preview = ', '.join(f"{k}: {v}" for k, v in first_row.items())
            lines.append(f"First row: {row_preview}")
            # Add total, average, highest, lowest for 'value'
            total = self.df['value'].sum()
            avg = self.df['value'].mean()
            highest = self.df['value'].max()
            lowest = self.df['value'].min()
            unit_suffix = f" {self.units.value}" if isinstance(self.units, Enum) else (f" {self.units}" if self.units else "")
            lines.append(f"value | Total: {total:,.2f}{unit_suffix}, Avg: {avg:,.2f}{unit_suffix}, Max: {highest:,.2f}{unit_suffix}, Min: {lowest:,.2f}{unit_suffix}")
        return '\n'.join(lines)
