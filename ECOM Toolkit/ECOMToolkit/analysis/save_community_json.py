"""
Save Community to JSON

Inputs (call signature):
    save_community_to_json(community, file_path, save=True, ensure_ascii=False)

Arguments:
    community : EnergyCommunity instance, dict, or other toolkit object
    file_path : Full path (string) to save the JSON file
    save      : Boolean flag to trigger writing (default True)
    ensure_ascii : Pass to json.dumps (default False for UTF-8)

Returns:
    (path, json_str)
        path     : File path written (or None on failure / when save=False)
        json_str : JSON string (or error message string on failure)

Notes:
    - The serializer walks through nested objects, dataclasses, mappings, iterables, numpy types, and
      objects exposing __dict__ while skipping private attributes (prefixed with '_').
    - Cyclic references are protected using an id() registry and converted to {"__ref__": <object_id>} markers.
    - HourlyData objects (if available) are converted to a dict with records orientation for the dataframe.
    - This module can also be executed in a Grasshopper-style environment if variables named
      'community', 'file_path', and 'save' are present in globals().
"""
from __future__ import annotations

import json
import os
import dataclasses
from collections.abc import Mapping, Iterable

try:  # Optional import
    from ECOMToolkit.analysis.data import HourlyData  # type: ignore
except Exception:  # pragma: no cover - fallback path
    HourlyData = None  # type: ignore


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_primitive(x):
    return isinstance(x, (int, float, str, bool)) or x is None


def _serialize_hourlydata(hd):  # pragma: no cover - simple accessor
    """Convert HourlyData to a compact dict representation."""
    try:
        df = getattr(hd, "df", None)
        return {
            "__type__": "HourlyData",
            "title": getattr(hd, "title", None),
            "units": getattr(hd, "units", None),
            "meta": getattr(hd, "meta", {}),
            "data": df.to_dict(orient="records") if hasattr(df, "to_dict") else None,
        }
    except Exception as e:  # pragma: no cover - defensive
        return {"__type__": "HourlyData", "error": f"unserializable: {e}"}


def _serialize_object(obj, visited: set[int]):
    oid = id(obj)
    if oid in visited:
        return {"__ref__": oid}

    # Primitives
    if _is_primitive(obj):
        return obj

    # Dataclass
    if dataclasses.is_dataclass(obj):
        visited.add(oid)
        return {
            "__type__": type(obj).__name__,
            **{f.name: _serialize_object(getattr(obj, f.name), visited) for f in dataclasses.fields(obj)}
        }

    # HourlyData
    if HourlyData and isinstance(obj, HourlyData):  # type: ignore
        return _serialize_hourlydata(obj)

    # Mapping
    if isinstance(obj, Mapping):
        visited.add(oid)
        return {str(k): _serialize_object(v, visited) for k, v in obj.items()}

    # Iterable (but not string/bytes)
    if isinstance(obj, Iterable) and not isinstance(obj, (str, bytes)):
        visited.add(oid)
        return [_serialize_object(v, visited) for v in obj]

    # Numpy types
    try:  # Local import to avoid hard dependency
        import numpy as np  # type: ignore
        if isinstance(obj, (np.integer, np.floating)):
            return obj.item()
        if isinstance(obj, np.ndarray):
            return obj.tolist()
    except Exception:  # pragma: no cover - optional path
        pass

    # Objects with __dict__
    if hasattr(obj, "__dict__"):
        visited.add(oid)
        data = {}
        for k, v in obj.__dict__.items():
            if k.startswith("_"):
                continue  # skip private/internal attributes
            try:
                data[k] = _serialize_object(v, visited)
            except Exception as e:  # pragma: no cover - defensive
                data[k] = f"<<unserializable: {e}>>"
        data["__type__"] = type(obj).__name__
        return data

    # Fallback: string cast
    return str(obj)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def serialize_community(community):
    """Return a JSON-serializable nested structure for the community object."""
    return _serialize_object(community, visited=set())


def save_community_to_json(community, file_path: str, save: bool = True, ensure_ascii: bool = False):
    """Serialize and optionally write community object to JSON.

    Parameters
    ----------
    community : Any
        Object to serialize.
    file_path : str
        Target JSON file path.
    save : bool, default True
        If False, only returns the JSON string without writing.
    ensure_ascii : bool, default False
        Passed to json.dumps.

    Returns
    -------
    (path, json_str) : tuple[str | None, str]
        path is None on failure or when save=False; json_str contains the JSON or an error message.
    """
    try:
        community_dict = serialize_community(community)
        json_str = json.dumps(community_dict, indent=2, ensure_ascii=ensure_ascii)

        if not save:
            return None, json_str

        directory = os.path.dirname(file_path)
        if directory and not os.path.exists(directory):
            os.makedirs(directory, exist_ok=True)

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(json_str)

        return file_path, json_str
    except Exception as e:  # Broad catch to propagate as string (per requested behavior)
        return None, f"Error: {e}"


# ---------------------------------------------------------------------------
# Grasshopper-style script execution (if run directly where inputs exist)
# ---------------------------------------------------------------------------
if {name in globals() for name in ("community", "file_path", "save")} == {True}:
    path, json_str = save_community_to_json(globals()["community"], globals()["file_path"], globals()["save"])

__all__ = [
    "serialize_community",
    "save_community_to_json",
]
