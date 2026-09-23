"""Capture what a library prints, without taking stdout from everyone else.

The toolkit and the optimizer both print as they work, and neither offers a
way to turn it off. The obvious answer - `contextlib.redirect_stdout` - swaps
`sys.stdout` for the whole process, which is fine in a script and wrong in a
threaded server. Two things went wrong with it here:

  * A dispatch takes about a second and an optimisation over a year takes
    minutes, so hundreds of dispatches begin and end inside one run. Each
    swapped `sys.stdout` and swapped it back, and Pyomo - which checks that
    the stream it was handed is still the one in place - stopped the run with
    "Captured output does not match sys.stdout". A year died after four
    minutes of work because somebody touched the controller.

  * The other way round, a dispatch that did not redirect printed into
    whatever sink the optimiser had installed, and into a closed one once that
    run had finished: "I/O operation on closed file".

So: `sys.stdout` is replaced exactly once, by a router that keeps the real
stream and sends each write to the sink belonging to the thread doing the
writing, if that thread has asked for one. `sys.stdout` is then the same
object from start to finish, which is all Pyomo wanted, and two threads
capturing at once each get their own text.

    with quiet.capture() as sink:
        noisy()
    log = sink.getvalue()

Anything printed by a thread that has not asked for a sink goes where it
always did.
"""
from __future__ import annotations

import contextlib
import io
import sys
import threading


class _Router(io.TextIOBase):
    """Writes to this thread's sink if it has one, else to the real stream."""

    def __init__(self, real):
        self._real = real
        self._local = threading.local()

    # -- where this thread's writes go --------------------------------------

    @property
    def sink(self):
        return getattr(self._local, "sink", None)

    @sink.setter
    def sink(self, value):
        self._local.sink = value

    # -- the stream itself ---------------------------------------------------

    def write(self, text):
        target = self.sink or self._real
        return target.write(text)

    def flush(self):
        target = self.sink or self._real
        flush = getattr(target, "flush", None)
        if flush:
            flush()

    def isatty(self):
        return False

    def fileno(self):
        # Pyomo asks when it wants to tee a subprocess solver's output. That
        # output goes to the real stream: a file descriptor belongs to the
        # process, and no amount of Python can give one thread its own.
        return self._real.fileno()

    @property
    def encoding(self):
        return getattr(self._real, "encoding", "utf-8")

    def writable(self):
        return True


_install_lock = threading.Lock()
_router_installed: _Router | None = None


def install() -> _Router:
    """Put the router in place. Safe to call repeatedly; only the first counts.

    Called at startup rather than on first capture, and the router is then held
    here rather than looked up again. That matters: Pyomo replaces sys.stdout
    with a wrapper of its own for the duration of a solve, and checks on the
    way out that its wrapper is still in place. A capture starting on another
    thread mid-solve used to find something that was not a router, install a
    second one over Pyomo's wrapper, and end the run with "Captured output does
    not match sys.stdout" - the same failure by a different route.

    Writes still arrive: Pyomo's wrapper wraps the router, so the router is
    underneath it and each thread's sink keeps working.
    """
    global _router_installed
    with _install_lock:
        if _router_installed is None:
            _router_installed = _Router(sys.stdout)
            sys.stdout = _router_installed
        return _router_installed


@contextlib.contextmanager
def capture(enabled: bool = True):
    """Collect this thread's prints into a buffer for the duration."""
    sink = io.StringIO()
    if not enabled:
        yield sink
        return

    router = install()
    previous = router.sink
    router.sink = sink
    try:
        yield sink
    finally:
        router.sink = previous
