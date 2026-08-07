"""In-process background jobs.

The optimizer takes seconds for a small community and about an hour for a full
campus year, so it cannot run inside a request. This is deliberately the
simplest thing that works: a thread pool and a dict. Jobs do not survive a
restart, which is fine for a single-user dashboard - swap in Redis/RQ when it
needs to outlive the process.
"""
from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"          # queued | running | done | failed | cancelled
    progress: str = ""
    result: Optional[Any] = None
    error: Optional[str] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    meta: dict = field(default_factory=dict)

    def as_dict(self, include_result: bool = True) -> dict:
        payload = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "error": self.error,
            "meta": self.meta,
        }
        if self.started_at and self.finished_at:
            payload["elapsed_s"] = round(self.finished_at - self.started_at, 2)
        if include_result and self.status == "done":
            payload["result"] = self.result
        return payload


class JobRunner:
    def __init__(self, max_workers: int = 2, keep: int = 20):
        self._pool = ThreadPoolExecutor(max_workers=max_workers,
                                        thread_name_prefix="ecom-job")
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._keep = keep

    def submit(self, kind: str, work: Callable[[Callable[[str], None]], Any],
               meta: Optional[dict] = None) -> Job:
        """Queue `work`, which receives a `report(message)` progress callback."""
        import time

        job = Job(id=uuid.uuid4().hex[:12], kind=kind, meta=meta or {})
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            # Keep the map from growing without bound across a long session.
            while len(self._order) > self._keep:
                self._jobs.pop(self._order.pop(0), None)

        def run() -> None:
            job.status = "running"
            job.started_at = time.time()

            def report(message: str) -> None:
                job.progress = message

            try:
                job.result = work(report)
                job.status = "done"
            except Exception as err:
                job.status = "failed"
                # The message alone rarely says which input was at fault.
                job.error = f"{type(err).__name__}: {err}"
                job.meta["traceback"] = traceback.format_exc().splitlines()[-12:]
            finally:
                job.finished_at = time.time()

        self._pool.submit(run)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return [self._jobs[i] for i in reversed(self._order) if i in self._jobs]


runner = JobRunner()
