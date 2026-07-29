"""Locate and import ECOMToolkit without requiring Rhino.

ECOMToolkit is not pip-installed; it lives beside the dashboard on disk. This
module puts its parent directory on sys.path once, so every other backend module
can simply `from ECOMToolkit.entities import Building`.

Override the location with the ECOM_TOOLKIT_ROOT environment variable.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_ENV_VAR = "ECOM_TOOLKIT_ROOT"

# Dashboard/backend/app/toolkit.py -> Dashboard/backend/app -> ... -> ECOM/
_DEFAULT_CANDIDATES = [
    Path(__file__).resolve().parents[3] / "ECOM Toolkit",
    Path(__file__).resolve().parents[4] / "ECOM Toolkit",
]


def toolkit_root() -> Path:
    """Return the directory that *contains* the ECOMToolkit package."""
    override = os.environ.get(_ENV_VAR)
    if override:
        root = Path(override).expanduser().resolve()
        if not (root / "ECOMToolkit" / "__init__.py").is_file():
            raise RuntimeError(
                f"{_ENV_VAR} is set to {root}, but no ECOMToolkit package was found "
                f"there. It must be the folder *containing* ECOMToolkit."
            )
        return root

    for candidate in _DEFAULT_CANDIDATES:
        if (candidate / "ECOMToolkit" / "__init__.py").is_file():
            return candidate.resolve()

    raise RuntimeError(
        "Could not locate the ECOMToolkit package. Looked in:\n  "
        + "\n  ".join(str(c) for c in _DEFAULT_CANDIDATES)
        + f"\nSet the {_ENV_VAR} environment variable to the folder containing it."
    )


def ensure_toolkit_on_path() -> Path:
    root = toolkit_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    return root


ensure_toolkit_on_path()
