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
from typing import Literal

from pydantic import BaseModel, Field

from app import settings

# Before anything that reads the environment: the solver choice and the Gurobi
# licence live in a git-ignored .env beside this package.
SETTINGS = settings.apply()

from app.builders.community import CommunityBuildError, build_community
from app.schemas.community import CommunitySpec
from app.services.dispatch import run_dispatch
from app.services.nordpool import NordPoolClient, NordPoolUnavailable
from app.services.jobs import runner
from app.services.mr_layer import build_layer
from app.services.optimize import run_optimization, solver_status
from app.services.sweep import run_sweep
from app.schemas.optimizer_params import OptimizerParameters, describe_parameters
from app.services.pvgis_cache import PVGISCache, PVGISUnavailable
from app.services import optimize_process, quiet

CACHE_ROOT = Path(__file__).resolve().parents[1] / "cache"

pvgis = PVGISCache(cache_dir=CACHE_ROOT / "pvgis")
nordpool = NordPoolClient(cache_dir=CACHE_ROOT / "nordpool")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Must be installed before any PVPlant is constructed, or the toolkit makes
    # a live PVGIS request per plant.
    pvgis.install_provider()
    # And before any solve: it replaces sys.stdout once, so that capturing a
    # library's chatter on one thread cannot disturb another's. See quiet.py.
    quiet.install()
    yield


app = FastAPI(
    title="ECOM Dashboard API",
    description="Build energy communities and dispatch them from JSON.",
    version="0.1.0",
    lifespan=lifespan,
)

# Every dev origin that talks to this API, each on a different port.
#
# The MR table is served by its own static server and its controller calls
# /api/mr/layer directly. Opening it through the dashboard proxy makes it
# same-origin and needs nothing here, but it is just as often opened straight
# off :8090 - without that origin listed, the browser blocks the call and the
# panel can only report that it found no backend.
# Live Server on :5500 is the third way in, for working on the table rather than
# showing it. Its proxy forwards /api and makes those calls same-origin as well,
# so that entry is only a safety net: with the proxy off the panel falls back to
# calling :8000 outright, and this is what keeps the browser from blocking it.
# Vite claims 5173 and walks up from there when it is taken - another project
# left running, or a dev server that did not shut down - so the dashboard can
# land anywhere in that range. Two named ports meant the dashboard came up on
# 5180 one morning and every call it made was blocked, with nothing in the UI
# to say why. The regex covers the range Vite actually searches.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8090", "http://127.0.0.1:8090",   # MR-Table
        "http://localhost:5500", "http://127.0.0.1:5500",   # MR-Table via Live Server
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):51[7-9][0-9]",
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


class OptimizeRequest(BaseModel):
    """A community plus the optimizer's own knobs."""

    community: CommunitySpec
    days: int | None = Field(
        None, description="Days to optimise. Defaults to the analysis period. "
        "Roughly 0.25 s per building-day.")
    horizon_hours: int = Field(36, ge=2, le=72,
                               description="Look-ahead window per rolling step.")
    store_hours: int = Field(24, ge=1, le=48,
                            description="Hours kept from each step before rolling on.")
    aging: bool = Field(False, description="Include battery degradation cost.")
    v2g: bool = Field(False, description="Allow vehicle-to-grid discharge.")
    parameters: OptimizerParameters | None = Field(
        None, description="Overrides for LEC-Opt's hardcoded constants.")
    temperature_c: float = Field(18.0, description="Ambient temperature for aging.")


@app.get("/api/optimize/solver")
def optimizer_solver() -> dict:
    """Whether the optimizer can run here, and with which solver."""
    return solver_status()


@app.get("/api/optimize/parameters")
def optimizer_parameters() -> dict:
    """Tunable LEC-Opt constants: defaults, bounds and where each came from.

    Served rather than duplicated in the frontend so the provenance - including
    which values are known to be out of date - has one source.
    """
    return {"parameters": describe_parameters()}


class SweepRequest(BaseModel):
    community: CommunitySpec
    variable: Literal["battery_kwh", "pv_percent"] = Field(
        description="What to vary across runs.")
    values: list[float] = Field(
        description="Sizes to solve at. Each is a full optimisation, so keep "
        "the count and the day count small.",
        min_length=1, max_length=12)
    days: int | None = None
    horizon_hours: int = Field(36, ge=2, le=72)
    store_hours: int = Field(24, ge=1, le=48)
    aging: bool = False
    v2g: bool = False
    parameters: OptimizerParameters | None = None


@app.post("/api/optimize/sweep")
def start_sweep(request: SweepRequest) -> dict:
    """Queue a sizing sweep. LEC-Opt cannot size anything itself - capacity is
    an input, not a decision variable - so this solves once per candidate size
    and returns the cost curve."""
    status = solver_status()
    if not status["available"]:
        raise HTTPException(status_code=503, detail=status["detail"])

    def work(report):
        return run_sweep(
            request.community,
            variable=request.variable,
            values=request.values,
            days=request.days,
            horizon_hours=request.horizon_hours,
            store_hours=request.store_hours,
            aging=request.aging,
            v2g=request.v2g,
            parameters=request.parameters,
            nordpool=nordpool,
            progress=report,
        )

    job = runner.submit("sweep", work, meta={
        "community": request.community.name,
        "variable": request.variable,
        "points": len(request.values),
        "days": request.days or max(1, request.community.analysis_period.n_hours // 24),
    })
    return job.as_dict()


@app.post("/api/optimize")
def start_optimization(request: OptimizeRequest) -> dict:
    """Queue an optimization run and return its job id immediately.

    Not synchronous: a full campus year takes about an hour. Poll
    /api/optimize/{job_id} for status and results.
    """
    status = solver_status()
    if not status["available"]:
        raise HTTPException(status_code=503, detail=status["detail"])

    spec = request.community

    def work(report):
        days = request.days or max(1, spec.analysis_period.n_hours // 24)
        report(f"optimising {len(spec.buildings)} buildings over {days} day(s)")
        # In a process of its own: Pyomo owns sys.stdout during a solve, and a
        # year is hundreds of them. See services/optimize_process.py.
        return optimize_process.run({
            "spec": spec.model_dump(mode="json"),
            "days": request.days,
            "horizon_hours": request.horizon_hours,
            "store_hours": request.store_hours,
            "aging": request.aging,
            "v2g": request.v2g,
            "temperature_c": request.temperature_c,
            "parameters": (request.parameters.model_dump(mode="json")
                           if request.parameters else None),
            "cache_root": str(CACHE_ROOT),
        })

    job = runner.submit("optimize", work, meta={
        "community": spec.name,
        "buildings": len(spec.buildings),
        "period": spec.analysis_period.label,
        "days": request.days or max(1, spec.analysis_period.n_hours // 24),
    })
    return job.as_dict()


@app.get("/api/optimize/{job_id}")
def optimization_status(job_id: str) -> dict:
    job = runner.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no job {job_id!r}")
    return job.as_dict()


@app.get("/api/jobs")
def list_jobs() -> dict:
    return {"jobs": [j.as_dict(include_result=False) for j in runner.list()]}


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


@app.get("/api/scenarios/{name}/years")
def scenario_years(name: str) -> dict:
    """Which years of measured demand this scenario can be run for.

    Buildings carry a csv_path ending in the year, and the measured files sit
    beside each other - _2022.csv, _2023.csv. Rather than let the controller
    guess, or offer a year picker full of years nobody has data for, the set is
    derived from the files on disk: a year counts only if EVERY building has one,
    because a partial year would silently drop members from the community.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise HTTPException(status_code=400, detail="invalid scenario name")

    path = SCENARIO_DIR / f"{name}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"no scenario named {name!r}")

    definition = json.loads(path.read_text(encoding="utf-8"))
    buildings = definition.get("buildings") or []

    year_pattern = re.compile(r"^(?P<stem>.*_)(?P<year>\d{4})(?P<ext>\.csv)$")
    current: set[str] = set()
    per_building: list[set[str]] = []

    for building in buildings:
        csv_path = (building.get("demand") or {}).get("csv_path")
        if not csv_path:
            # Demand given as an annual total and a shape has no year to vary.
            continue
        match = year_pattern.match(csv_path)
        if not match:
            continue
        current.add(match.group("year"))

        folder = Path(match.group("stem")).parent
        prefix = Path(match.group("stem")).name
        found = set()
        if folder.is_dir():
            for candidate in folder.glob(f"{prefix}*.csv"):
                other = year_pattern.match(str(candidate))
                if other and other.group("stem") == match.group("stem"):
                    found.add(other.group("year"))
        per_building.append(found)

    # Only years every building can supply.
    complete = set.intersection(*per_building) if per_building else set()

    return {
        "years": sorted(int(y) for y in complete),
        "current": int(sorted(current)[0]) if len(current) == 1 else None,
        "buildings_with_measured_demand": len(per_building),
    }

# --------------------------------------------------------------- MR table


@app.post("/api/mr/layer")
def mr_layer(spec: CommunitySpec) -> dict:
    """Dispatch a community and return it as the MR table's three GeoJSON layers.

    The table is a static site with no build step and no access to this app's
    code, so it cannot do the dispatch-to-map transform itself. Its controller
    posts a definition here and broadcasts the result to the display, which is
    the same path scripts/export_mr_layer.py takes offline - one transform, so a
    slider moved at the table and the committed export cannot disagree.

    A one-day campus dispatch is about a second, which is what makes a slider
    on the controller worth having.
    """
    try:
        dispatch = run_dispatch(spec, nordpool=nordpool)
    except (CommunityBuildError, PVGISUnavailable, NordPoolUnavailable) as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err

    # Assets that know where they stand. The dispatcher prefixes charge point
    # ids with CP_, matching builders/community.py.
    placements = {
        f"CP_{cp.name}": (cp.lon, cp.lat)
        for cp in spec.charge_points
        if cp.lat is not None and cp.lon is not None
    }
    return build_layer(dispatch, placements=placements)
