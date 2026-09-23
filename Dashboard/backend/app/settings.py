"""Local settings and secrets, out of the repository.

A `.env` beside the backend holds the things that belong to a machine rather
than to the project: which solver to use, and the Gurobi licence that makes the
faster one legal. It is git-ignored, so nothing here ends up in the history.

    Dashboard/backend/.env

Nothing in it is required. With no file at all the backend runs exactly as it
did before: HiGHS, which needs no licence.

Recognised:

    ECOM_SOLVER=gurobi          which solver the optimizer asks Pyomo for.
                                Default appsi_highs. 'gurobi' also accepts
                                'gurobi_direct' and 'appsi_gurobi'.

    GRB_LICENSE_FILE=C:\\path\\gurobi.lic
                                a licence file you already have. Pointed at
                                directly - nothing is copied or rewritten.

    WLSACCESSID=...             a Web License Service licence, as the three
    WLSSECRET=...               values the Gurobi portal gives you. These are
    LICENSEID=...               written into cache/gurobi/gurobi.lic - also
                                git-ignored - because gurobipy reads a file,
                                not environment variables.

    GUROBI_LICENSE_KEY=...      a bare licence key, the kind gurobi.com hands
                                out for a named-user academic licence. Kept
                                here so it is not lost, but it is NOT a licence
                                and nothing can use it as one: it has to be
                                exchanged for a gurobi.lic by running
                                `grbgetkey <key>` on the university network,
                                and grbgetkey ships with the full Gurobi
                                Optimizer install rather than with pip. Point
                                GRB_LICENSE_FILE at the result.

Values already in the environment win: a variable set in the shell is a
deliberate act for that run, and a file should not override it.
"""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = BACKEND_ROOT / ".env"
LICENCE_DIR = BACKEND_ROOT / "cache" / "gurobi"

# What the optimizer falls back to: in the repository, needs no licence.
DEFAULT_SOLVER = "appsi_highs"


def load_env_file(path: Path = ENV_FILE) -> dict:
    """Read KEY=value lines into the environment, without overwriting it."""
    if not path.is_file():
        return {}
    found = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        # Quotes are how you would write a Windows path with spaces, and are
        # not part of the value.
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        found[key] = value
        os.environ.setdefault(key, value)
    return found


def ensure_gurobi_licence() -> str | None:
    """Make a WLS licence usable, and say which file Gurobi will read.

    gurobipy looks for a file - GRB_LICENSE_FILE, then the home directory - and
    has no way to take a licence from the environment. So three values in .env
    become a file here, in the cache directory that is already ignored.
    """
    existing = os.environ.get("GRB_LICENSE_FILE")
    if existing and Path(existing).is_file():
        return existing

    wanted = ("WLSACCESSID", "WLSSECRET", "LICENSEID")
    if not all(os.environ.get(key) for key in wanted):
        return None

    LICENCE_DIR.mkdir(parents=True, exist_ok=True)
    path = LICENCE_DIR / "gurobi.lic"
    path.write_text(
        "".join(f"{key}={os.environ[key]}\n" for key in wanted), encoding="utf-8")
    os.environ["GRB_LICENSE_FILE"] = str(path)
    return str(path)


def gurobi_licence_state() -> str | None:
    """What is missing, if anything, before Gurobi can be licensed here."""
    if os.environ.get("GRB_LICENSE_FILE") and Path(os.environ["GRB_LICENSE_FILE"]).is_file():
        return None
    if all(os.environ.get(key) for key in ("WLSACCESSID", "WLSSECRET", "LICENSEID")):
        return None
    if os.environ.get("GUROBI_LICENSE_KEY"):
        return (
            "GUROBI_LICENSE_KEY is set, but a key is not a licence. Exchange it "
            "on the Chalmers network with `grbgetkey <key>` (it comes with the "
            "full Gurobi Optimizer download, not with pip), then put "
            "GRB_LICENSE_FILE=<path to gurobi.lic> in Dashboard/backend/.env. "
            "If the key came from the Gurobi User Portal as a Web License "
            "Service key, use WLSACCESSID, WLSSECRET and LICENSEID instead - "
            "the portal shows all three."
        )
    return (
        "No Gurobi licence found. Put GRB_LICENSE_FILE, or WLSACCESSID/"
        "WLSSECRET/LICENSEID, in Dashboard/backend/.env - see .env.example."
    )


def solver_name() -> str:
    """Which solver the optimizer should ask for."""
    name = (os.environ.get("ECOM_SOLVER") or "").strip()
    return name or DEFAULT_SOLVER


def apply(path: Path = ENV_FILE) -> dict:
    """Load the file, put any licence in place, and report what happened."""
    found = load_env_file(path)
    licence = ensure_gurobi_licence()
    return {
        "env_file": str(path) if path.is_file() else None,
        "keys": sorted(found),
        "solver": solver_name(),
        "gurobi_licence": licence,
    }
