"""FastAPI service for the ECOM dashboard.

Dispatch runs in the request: a 48-hour community takes about a second, so it is
fast enough to drive sliders directly. The LEC-Opt MILP is a different matter -
120 s per simulated day - and will need a job queue rather than this endpoint.

    uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.builders.community import CommunityBuildError, build_community
from app.schemas.community import CommunitySpec
from app.services.dispatch import run_dispatch
from app.services.nordpool import NordPoolClient, NordPoolUnavailable
from app.services.pvgis_cache import PVGISCache, PVGISUnavailable

CACHE_ROOT = Path(__file__).resolve().parents[1] / "cache"

pvgis = PVGISCache(cache_dir=CACHE_ROOT / "pvgis")
nordpool = NordPoolClient(cache_dir=CACHE_ROOT / "nordpool")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Must be installed before any PVPlant is constructed, or the toolkit makes
    # a live PVGIS request per plant.
    pvgis.install_provider()
    yield


app = FastAPI(
    title="ECOM Dashboard API",
    description="Build energy communities and dispatch them from JSON.",
    version="0.1.0",
    lifespan=lifespan,
)

# The Vite dev server runs on a different port.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class Health(BaseModel):
    status: str
    pvgis_cached_orientations: int
    nordpool_cached_days: int


@app.get("/api/health", response_model=Health)
def health() -> Health:
    return Health(
        status="ok",
        pvgis_cached_orientations=len(list(pvgis.cache_dir.glob("*.json"))),
        nordpool_cached_days=len(list(nordpool.cache_dir.glob("*.json"))),
    )


SCENARIO_DIR = Path(__file__).resolve().parents[1] / "data"


@app.get("/api/scenarios")
def list_scenarios() -> dict:
    """Saved community definitions on disk, e.g. the generated campus model.

    The data directory also holds extraction outputs (footprints, EPC records,
    name maps), so entries are filtered to files that actually parse as a
    community rather than listing every JSON file.
    """
    if not SCENARIO_DIR.is_dir():
        return {"scenarios": []}

    found = []
    for path in sorted(SCENARIO_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not (isinstance(payload, dict) and "buildings" in payload and "grid" in payload):
            continue
        found.append({
            "name": path.stem,
            "title": payload.get("name", path.stem),
            "buildings": len(payload.get("buildings") or []),
        })
    return {"scenarios": found}


@app.get("/api/scenarios/{name}")
def get_scenario(name: str) -> dict:
    # Reject traversal: the name is a bare stem, not a path.
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise HTTPException(status_code=400, detail="invalid scenario name")

    path = SCENARIO_DIR / f"{name}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"no scenario named {name!r}")

    definition = json.loads(path.read_text(encoding="utf-8"))
    # Validate before handing it out, so a stale file fails here rather than
    # halfway through the frontend's first dispatch.
    CommunitySpec(**definition)
    return definition


@app.post("/api/validate")
def validate(spec: CommunitySpec) -> dict:
    """Check a definition and return its headline figures without dispatching.

    Cheap enough to call on every edit: no PVGIS lookup, no dispatch.
    """
    return {
        "valid": True,
        "name": spec.name,
        "period": spec.analysis_period.label,
        "hours": spec.analysis_period.n_hours,
        "buildings": len(spec.buildings),
        "pv_plants": len(spec.pv_plants),
        "community_pv_plants": len(spec.community_pv_plants),
        "batteries": len(spec.batteries),
        "charge_points": len(spec.charge_points),
        "total_pv_capacity_kw": spec.total_pv_capacity,
        "total_battery_capacity_kwh": spec.total_battery_capacity,
        "total_annual_demand_kwh": spec.total_annual_demand,
    }


@app.post("/api/dispatch")
def dispatch(spec: CommunitySpec) -> dict:
    """Build the community, run the dispatch, return {nodes, links, kpis}.

    The shape matches Dashboard/src/types.ts, so the frontend can swap
    fetch('/graph.json') for this endpoint unchanged.
    """
    try:
        return run_dispatch(spec, nordpool=nordpool)
    except (CommunityBuildError, PVGISUnavailable, NordPoolUnavailable) as err:
        # Definition problems are the caller's to fix, not server faults.
        raise HTTPException(status_code=422, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err


@app.post("/api/community/preview")
def preview(spec: CommunitySpec) -> dict:
    """Build every entity without dispatching.

    Surfaces construction errors - unreachable PVGIS, infeasible EV schedules -
    separately from dispatch problems.
    """
    try:
        built = build_community(spec, nordpool=nordpool)
    except (CommunityBuildError, PVGISUnavailable, NordPoolUnavailable, ValueError) as err:
        raise HTTPException(status_code=422, detail=str(err)) from err

    return {
        "nodes": [{"id": node_id, "type": kind}
                  for node_id, kind in sorted(built.node_kinds.items())],
        "validation": built.community.validate(),
    }
