"""Run an optimisation in a process of its own.

Not for speed - for stdout. Pyomo replaces `sys.stdout` for the duration of
every solve and restores it afterwards, and a rolling year is 365 solves. That
is a process-wide change, so anything else printing in the same process during
one of those windows writes to a stream Pyomo has just closed:

    dispatch: 422 Unprocessable Entity - "write to closed file"

and, the other way round, a dispatch that redirected stdout while a solve was
in flight ended the run with "Captured output does not match sys.stdout". Both
were real: a year-long run died after four minutes because somebody touched the
controller, and the table's own dispatches failed while a run was going.

Nothing in one process can fix that, because the offending state is a module
global in a library neither we nor the toolkit control. A child process has its
own `sys.stdout`, so the table can dispatch all it likes while a year solves.

One worker: these runs are CPU-bound and minutes long, so a second concurrent
one would only halve the speed of both. The pool is started on first use and
kept, because starting it costs a Python interpreter and the imports behind it -
about a second - which is worth paying once rather than per run.
"""
from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from typing import Optional

_pool: Optional[ProcessPoolExecutor] = None


def _child(payload: dict) -> dict:
    """Runs in the child: rebuild the spec and optimise it."""
    # Imported here rather than at module scope: the child imports this module
    # to find the function, and the toolkit behind these is slow to load.
    from app.schemas.community import CommunitySpec
    from app.schemas.optimizer_params import OptimizerParameters
    from app.services.nordpool import NordPoolClient
    from app.services.optimize import run_optimization
    from app.services.pvgis_cache import PVGISCache

    cache_root = payload.get("cache_root")
    if cache_root:
        # The same caches the server uses, so the child does not go to PVGIS or
        # Nord Pool over the network for data already on disk.
        PVGISCache(cache_dir=os.path.join(cache_root, "pvgis")).install_provider()
        nordpool = NordPoolClient(cache_dir=os.path.join(cache_root, "nordpool"))
    else:
        nordpool = None

    spec = CommunitySpec.model_validate(payload["spec"])
    parameters = payload.get("parameters")
    return run_optimization(
        spec,
        days=payload.get("days"),
        horizon_hours=payload.get("horizon_hours", 36),
        store_hours=payload.get("store_hours", 24),
        aging=payload.get("aging", False),
        v2g=payload.get("v2g", False),
        temperature_c=payload.get("temperature_c", 18.0),
        nordpool=nordpool,
        parameters=OptimizerParameters.model_validate(parameters) if parameters else None,
    )


def pool() -> ProcessPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ProcessPoolExecutor(max_workers=1)
    return _pool


def run(payload: dict) -> dict:
    """Optimise in the child and wait for the answer.

    Called from a job thread, so waiting here blocks nothing the table needs.
    """
    return pool().submit(_child, payload).result()


def shutdown() -> None:
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None
