"""Live readings from the EHUB gateway at AWL.

The battery in AWL is a real one, and the site publishes its tags over a small
REST gateway on the Chalmers network. This reads a handful of them - what the
battery is doing right now, how full it is, what setpoint it has been given -
so the dashboard can show the building as it actually is rather than only as
the model says it should be.

Read-only, deliberately. The same gateway accepts setpoints and start/stop
commands, and nothing here writes one: a projection table that can charge a
battery by accident is not a thing worth building. The notebook beside the
repository is where commands are sent, by hand, by someone watching.

Configured in Dashboard/backend/.env, which is git-ignored:

    EHUB_URL=http://<gateway-host>:8090/api/v1
    EHUB_USER=...
    EHUB_PASSWORD=...

With none of those set, every call reports "not configured" and the dashboard
simply does not show a live panel. Off the Chalmers network the gateway is
unreachable, which reports the same way: the table keeps working.

Signs, as the site uses them:

    power   positive discharging, negative charging
    soc     per cent

Two units live side by side on the gateway and this is not our choice: the
reading PBAT_PV is in kW, the setpoint TOTALCHARGE_SP is in W. The setpoint is
converted here so that one panel does not show -30000 beside 13.5.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

import requests

# How long a reading is served from memory before the gateway is asked again.
# The table polls every few seconds and several clients may watch at once; the
# gateway is quick (about 70 ms a tag) but there is no reason to ask it twice
# for the same second.
CACHE_SECONDS = 2.0

# Long enough for a busy gateway, short enough that a dead one does not hold a
# request open while someone is standing at the table.
TIMEOUT_SECONDS = 4.0

# What the dashboard shows. The gateway publishes 606 tags for this site; these
# are the ones that answer "what is the battery doing".
TAGS = {
    "power": "O0007044_EHUB_PBAT_PV",            # kW, + discharging
    "soc": "O0007044_EHUB_SOC_PV",               # per cent
    "solar": "O0007044_EHUB_PPV_PV",             # kW on the building's own roof
    "mode": "O7044_BATTERY_MODE_V",              # mode readback
    "setpoint": "O7044_BATTERY_TOTALCHARGE_SP",  # W, + discharging
    "command": "O7044_BATTERY_TOTAL_CMD1",       # 1 running, 0 stopped
}

# The gateway marks a value it has not refreshed lately. Saying so is the whole
# point: a dashboard showing yesterday's number as though it were now is worse
# than one showing nothing.
FRESH = "OK"


class EHubUnavailable(RuntimeError):
    """The gateway could not be reached, or is not configured."""


_lock = threading.Lock()
_token: Optional[str] = None
_cache: Optional[dict] = None
_cached_at = 0.0


def settings() -> dict:
    return {
        "url": (os.environ.get("EHUB_URL") or "").rstrip("/"),
        "user": os.environ.get("EHUB_USER") or "",
        "password": os.environ.get("EHUB_PASSWORD") or "",
    }


def configured() -> bool:
    found = settings()
    return bool(found["url"] and found["user"] and found["password"])


def _fetch_token(force: bool = False) -> str:
    global _token
    if _token and not force:
        return _token
    found = settings()
    reply = requests.get(f"{found['url']}/access/token",
                         params={"username": found["user"],
                                 "password": found["password"]},
                         timeout=TIMEOUT_SECONDS)
    reply.raise_for_status()
    _token = reply.json().get("Token")
    if not _token:
        raise EHubUnavailable("the gateway returned no token")
    return _token


def _read(tag: str, token: str) -> dict:
    found = settings()
    reply = requests.get(f"{found['url']}/tag/read",
                         headers={"accept": "application/json", "token": token},
                         params={"tag": tag}, timeout=TIMEOUT_SECONDS)
    reply.raise_for_status()
    return reply.json().get(tag) or {}


def _number(entry: dict) -> Optional[float]:
    try:
        return float(entry.get("Value"))
    except (TypeError, ValueError):
        return None


def _reading(entry: dict, scale: float = 1.0) -> dict:
    value = _number(entry)
    stamp = entry.get("Timestamp") or ""
    return {
        "value": None if value is None else value * scale,
        "at": stamp if not stamp.startswith("0001-") else None,
        # The gateway's own word for it, kept rather than interpreted.
        "status": entry.get("Status"),
        "fresh": entry.get("Status") == FRESH,
    }


def battery(force: bool = False) -> dict:
    """What the battery is doing, as the gateway last saw it."""
    global _cache, _cached_at

    if not configured():
        raise EHubUnavailable(
            "no gateway configured - set EHUB_URL, EHUB_USER and EHUB_PASSWORD "
            "in Dashboard/backend/.env (see .env.example)")

    with _lock:
        if _cache is not None and not force and time.time() - _cached_at < CACHE_SECONDS:
            return _cache

        try:
            token = _fetch_token()
            entries = {}
            for name, tag in TAGS.items():
                try:
                    entries[name] = _read(tag, token)
                except requests.HTTPError as err:
                    # A token lives for a while and then does not. One retry,
                    # with a fresh one, rather than failing the whole reading.
                    if err.response is not None and err.response.status_code in (401, 403):
                        token = _fetch_token(force=True)
                        entries[name] = _read(tag, token)
                    else:
                        raise
        except requests.RequestException as err:
            raise EHubUnavailable(
                f"the gateway at {settings()['url']} did not answer: "
                f"{type(err).__name__}") from err

        power = _reading(entries.get("power", {}))
        reading = {
            "available": True,
            # kW, positive discharging - the site's own convention, kept so
            # that what the dashboard says matches what the notebook says.
            "power_kw": power,
            "soc_percent": _reading(entries.get("soc", {})),
            "solar_kw": _reading(entries.get("solar", {})),
            "mode": _reading(entries.get("mode", {})),
            # W on the gateway, kW here, so the panel can put the setpoint
            # beside the reading without a unit change in the middle.
            "setpoint_kw": _reading(entries.get("setpoint", {}), scale=0.001),
            "command": _reading(entries.get("command", {})),
            "doing": _doing(power.get("value")),
            "read_at": time.time(),
        }
        _cache = reading
        _cached_at = time.time()
        return reading


def _doing(power: Optional[float]) -> str:
    """Charging, discharging or idle, in a word."""
    if power is None:
        return "unknown"
    if power > 0.2:
        return "discharging"
    if power < -0.2:
        return "charging"
    return "idle"
