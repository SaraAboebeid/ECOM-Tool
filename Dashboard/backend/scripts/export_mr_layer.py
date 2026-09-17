"""Export the campus energy layer for the ACE MR Studio projection table.

The table (MR-Table/) is a static site with no build step, so it cannot import
anything from the dashboard. It reads plain GeoJSON instead, written here.

The transform itself lives in app/services/mr_layer.py, because the table's
controller now rebuilds the layer live over POST /api/mr/layer when a slider
moves. Both go through build_layer, so the committed export and whatever the
controller puts on the table are the same picture.

Run with the backend up:
    python scripts/export_mr_layer.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.mr_layer import build_layer  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

DASHBOARD = Path(__file__).resolve().parents[2]
OUT_DIR = DASHBOARD.parent / "MR-Table" / "media" / "ecom"
OUT_FILE = OUT_DIR / "ecom-buildings.geojson"
NODES_FILE = OUT_DIR / "ecom-nodes.geojson"
FLOWS_FILE = OUT_DIR / "ecom-flows.geojson"

# One ordinary working day, so the table loops a full daily cycle rather than
# two days of which the second is never reached. Wednesday 1 June 2022: a
# midweek day in term time, and clear of the Swedish public holidays that fall
# later in the month (National Day on the 6th, Midsummer on the 24th-25th),
# which would show an atypically empty campus.
ANALYSIS_DAY = {"start_month": 6, "start_day": 1, "start_hour": 0,
                "end_month": 6, "end_day": 1, "end_hour": 23}

# Overridable, because port 8000 is a common default and not always ours: on
# this machine another project's API has held it, answering /api/health like
# any backend and returning a web page for everything else.
API = os.environ.get("ECOM_API", "http://127.0.0.1:8000")


def fetch(path: str, payload=None):
    url = f"{API}{path}"
    if payload is None:
        with urllib.request.urlopen(url, timeout=120) as response:
            return json.load(response)
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)


def main() -> int:
    try:
        spec = fetch("/api/scenarios/campus_community")
        spec["analysis_period"] = dict(ANALYSIS_DAY)
        dispatch = fetch("/api/dispatch", spec)
    except Exception as error:                       # noqa: BLE001
        print(f"Could not reach the backend at {API}: {error}")
        print("Start it with: cd backend && python -m uvicorn app.main:app --port 8000")
        return 1

    # Assets that know where they stand, the same way POST /api/mr/layer does.
    # Without this the committed export puts a charge point back on the ring of
    # shared assets while a live dispatch puts it on its street - two pictures
    # of one community, differing by which route drew them.
    placements = {
        f"CP_{cp['name']}": (cp["lon"], cp["lat"])
        for cp in (spec.get("charge_points") or [])
        if cp.get("lat") is not None and cp.get("lon") is not None
    }
    layer = build_layer(dispatch, placements=placements)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Stamped so the table can say which export it is showing. A GeoJSON
    # object may carry foreign members, and readers ignore what they do not
    # know, so this costs nothing to anything else that reads these files.
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    for part in ("buildings", "nodes", "flows"):
        layer[part]["generated"] = stamp

    # The community's headline figures, so the table's KPI bars have something
    # to show from the moment it opens rather than only after the first change.
    # A live POST /api/mr/layer carries the same block; this is that block for
    # the committed picture.
    kpis = layer.get("kpis") or dispatch.get("kpis")
    if kpis:
        layer["buildings"].setdefault("ecom_meta", {})["kpis"] = kpis

    OUT_FILE.write_text(json.dumps(layer["buildings"]), encoding="utf-8")
    NODES_FILE.write_text(json.dumps(layer["nodes"]), encoding="utf-8")
    FLOWS_FILE.write_text(json.dumps(layer["flows"]), encoding="utf-8")

    size_kb = OUT_FILE.stat().st_size / 1024
    total = len(layer["buildings"]["features"])
    print(f"wrote {OUT_FILE.relative_to(DASHBOARD.parent)}  ({size_kb:,.0f} KB)")
    print(f"  {layer['matched']} of {total} footprints carry energy data")
    print(f"  {layer['meta']['hours']} h, {layer['meta']['period']}")
    print(f"wrote {NODES_FILE.name}  ({len(layer['nodes']['features'])} nodes)")
    print(f"wrote {FLOWS_FILE.name}  ({len(layer['flows']['features'])} flow lines)")
    if layer["unmatched"]:
        print(f"  no dispatch data for: {', '.join(layer['unmatched'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
