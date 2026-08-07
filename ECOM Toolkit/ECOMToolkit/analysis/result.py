#depricated #replaced by hourly data class
import pandas as pd
from typing import Any, Dict, Optional, Union
from enum import Enum


# Enum for result categories
class ResultCategory(Enum):
    POWER = "power"
    ENERGY = "energy"
    COST = "cost"
    CARBON = "carbon"
    OTHER = "other"

# Enum for standard units (expand as needed)
class ResultUnit(Enum):
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

class Result:
    """
    Generic result class for analysis outputs.
    Stores a DataFrame and associated metadata (type, units, etc).
    """
    def __init__(
        self,
        df: pd.DataFrame,
        result_type: Optional[str] = None,
        units: Optional[Union[str, Dict[str, Union[str, ResultUnit]]]] = None,
        meta: Optional[Dict[str, Any]] = None,
        title: Optional[str] = None,
        source_entity: Optional[str] = None,
        category: Optional[ResultCategory] = None,
        column_map: Optional[Dict[str, str]] = None,
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
        self.result_type = result_type
        self.units = units  # Can be a string, enum, or dict mapping columns to units
        self.meta = meta or {}
        self.title = title
        self.source_entity = source_entity
        self.category = category
        self.column_map = column_map or {}

    def __repr__(self):
        # Human-readable, multi-line summary
        lines = []
        if self.title:
            lines.append(f"{self.title}")
        if self.result_type:
            lines.append(f"Type: {self.result_type}")
        if self.category:
            cat = self.category.name if isinstance(self.category, Enum) else self.category
            lines.append(f"Category: {cat}")
        if self.units:
            if isinstance(self.units, Enum):
                units = self.units.name
            elif isinstance(self.units, dict):
                # Show mapping for first 2 columns only for brevity
                preview = ', '.join(f"{k}: {v.name if isinstance(v, Enum) else v}" for k, v in list(self.units.items())[:2])
                units = f"{{{preview}{', ...' if len(self.units) > 2 else ''}}}"
            else:
                units = str(self.units)
            lines.append(f"Units: {units}")
        if self.source_entity:
            lines.append(f"Source: {self.source_entity}")
        lines.append(f"Shape: {self.df.shape}")
        # Show columns and first row as preview
        if hasattr(self.df, 'columns') and hasattr(self.df, 'head'):
            cols = ', '.join(map(str, self.df.columns))
            lines.append(f"Columns: {cols}")
            if len(self.df) > 0:
                first_row = self.df.iloc[0].to_dict()
                row_preview = ', '.join(f"{k}: {v}" for k, v in first_row.items())
                lines.append(f"First row: {row_preview}")
                # Add total, average, highest, lowest for numeric columns (exclude 'hoy')
                numeric_cols = [col for col in self.df.select_dtypes(include='number').columns if col != 'hoy']
                # Try to get unit suffix for value column
                unit_suffix = ''
                if self.units:
                    if isinstance(self.units, dict) and 'value' in self.units:
                        u = self.units['value']
                        if isinstance(u, Enum):
                            unit_suffix = f" {u.value}"
                        else:
                            unit_suffix = f" {u}"
                    elif isinstance(self.units, Enum):
                        unit_suffix = f" {self.units.value}"
                    elif isinstance(self.units, str):
                        unit_suffix = f" {self.units}"
                if len(numeric_cols) > 0:
                    stats = []
                    for col in numeric_cols:
                        total = self.df[col].sum()
                        avg = self.df[col].mean()
                        highest = self.df[col].max()
                        lowest = self.df[col].min()
                        # Format with commas and add unit suffix for 'value' column
                        if col == 'value':
                            stats.append(f"{col} | Total: {total:,.2f}{unit_suffix}, Avg: {avg:,.2f}{unit_suffix}, Max: {highest:,.2f}{unit_suffix}, Min: {lowest:,.2f}{unit_suffix}")
                        else:
                            stats.append(f"{col} | Total: {total:,.2f}, Avg: {avg:,.2f}, Max: {highest:,.2f}, Min: {lowest:,.2f}")
                    lines.append("\n".join(stats))
        return '\n'.join(lines)

    def get_unit(self, column: str) -> Optional[Union[str, ResultUnit]]:
        if isinstance(self.units, dict):
            return self.units.get(column)
        return self.units

    def standardize_columns(self):
        if self.column_map:
            self.df.rename(columns=self.column_map, inplace=True)
