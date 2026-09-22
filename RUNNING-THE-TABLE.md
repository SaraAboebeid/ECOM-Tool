# Running the ECOM projection table

The display and the controller for the Chalmers campus energy community, as
shown on the ACE MR Studio table.

If you have pulled this repository and the table looks older than you expected,
**step 1 is almost certainly why**.

---

## 1. Make sure you are on the current code

`main` now carries the table. It did not until 22 September 2026: until then the
work sat on the `ECOM_MR` branch and `main` was a hundred and thirty commits
behind, so **a clone or pull from before that date is the August version**, with
no energy layer on it at all.

```bash
git fetch origin
git switch main         # or ECOM_MR - they are the same commit
git pull
```

Check:

```bash
git log -1 --oneline    # 7bc5b00 or later
git status --short      # should print nothing
```

If `git pull` says "Already up to date" but the pages still look old, either you
are on some other branch (`git branch --show-current`) or the browser is showing
you a cached script - see step 5.

---

## 2. Open the right pages

The display and the controller are:

| | |
|---|---|
| Display | `MR-Table/index.html` |
| Controller | `MR-Table/controller.html` |
| Launcher (opens both, one per screen) | `MR-Table/launcher.html` |

**There is no `display.html`.** A stale comment in `.vscode/settings.json`
mentions one; ignore it.

Three things in this repository look like the table and are not:

- `MR-Table/archive/controller.html` - the controller as it was before any of
  this work. It opens without complaint and contains none of the energy layer.
  If you have been looking at an old controller, it is probably this one.
- `Dashboard/` - a React dashboard that draws the same campus from the same
  model, with its own energy graph. A different application.
- `Dashboard/dist/` - a build of that dashboard from late August.

Both the display and the controller must be served from **one address**. They
talk over BroadcastChannel, which does not cross origins: a display on one port
and a controller on another cannot hear each other, and every control looks
dead.

---

## 3. The display on its own - no backend, no data

The opening picture is committed, so this works from a clean clone:

```bash
cd MR-Table
python serve.py                 # http://127.0.0.1:8090
```

Open <http://127.0.0.1:8090/index.html>, click once to start it, and open
<http://127.0.0.1:8090/controller.html> beside it. You get the campus, the
introduction, the flows and the day.

What you do not get: anything that re-runs the model. The controller will say
"No backend", and switching a building off or adding panels will not recompute.
For that, continue below.

Use `serve.py` rather than `python -m http.server`. It stamps every script with
its modification time and sends `Cache-Control: no-store`, so a reload cannot
leave you running yesterday's JavaScript - which is the other way to think you
have an old version.

---

## 4. The full table - backend and data

### The backend

```bash
cd Dashboard/backend
python -m venv .venv
.venv\Scripts\activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

`ECOMToolkit` is not installed from pip - it is imported from the `ECOM Toolkit`
folder next to the dashboard, so keep the repository layout intact. If you move
it, set `ECOM_TOOLKIT_ROOT` to the folder *containing* `ECOMToolkit`.

Then serve the table pointing at it:

```bash
cd MR-Table
python serve.py 8090 http://127.0.0.1:8000
```

Everything is then on `http://127.0.0.1:8090` - launcher, display, controller,
and `/api` forwarded to the backend, so there is no CORS to configure.

### The demand data

The hourly demand CSVs are **not in the repository** (`.gitignore` keeps the
large inputs out), and every building in
`Dashboard/backend/data/campus_community.json` points at them by absolute path:

```json
"demand": { "csv_path": "C:\\Users\\saraabo\\Desktop\\ECOM\\Data\\energy_data\\07.01_Fysik_origo_2022.csv" }
```

Those paths are from the machine the file was built on. With the `energy_data`
folder copied to your own machine, repoint them once:

```bash
python - <<'PY'
import json, pathlib
HERE = pathlib.Path(r"C:\path\to\your\Data\energy_data")   # <- your copy
for name in ["Dashboard/backend/data/campus_community.json",
             "Dashboard/backend/data/variants/campus_verified.json"]:
    path = pathlib.Path(name)
    spec = json.loads(path.read_text(encoding="utf-8"))
    for building in spec["buildings"]:
        demand = building.get("demand", {})
        if "csv_path" in demand:
            demand["csv_path"] = str(HERE / pathlib.Path(demand["csv_path"]).name)
    path.write_text(json.dumps(spec, indent=2, ensure_ascii=False), encoding="utf-8")
    print("repointed", name)
PY
```

Keep that change local - do not commit it, or the paths break for everyone else.

A few buildings keep their CSV in a subfolder (`07.18 Idelära/electricity_2022.csv`);
if one of those is missing after the rewrite, point it at the file by hand.

Solar production is **not** read from those files. It is modelled from PVGIS
irradiance and cached under `Dashboard/backend/cache/pvgis/`, which is also not
in the repository - the first run fetches it, so the backend needs network
access once. After that it is offline.

---

## 5. If it still looks old

1. **Hard-reload both pages** - Ctrl+F5, or open DevTools and tick
   "Disable cache". A browser that loaded `ecom-energy.js` before you pulled
   will happily keep running it.
2. **Check the branch**: `git branch --show-current` must print `ECOM_MR`.
3. **Check you are on the right page** - `MR-Table/index.html`, not anything
   under `MR-Table/archive/`, and not the Dashboard.
4. **Check both pages are on the same port.** The controller shows a chip at
   the top: "Table live" means it has found the display. "No display" means
   they are on different origins or the display is not open.
5. **Check the backend port matches.** `serve.py` defaults to forwarding
   `/api` to port 8000. If you run the backend elsewhere, pass it:
   `python serve.py 8090 http://127.0.0.1:8001`.

---

## 6. What to look at first

On the display, after the introduction:

- **Top bar** - members, solar per day, chargers, EV charging per day.
- **Bottom bar** - self-sufficiency, grid import, grid export.
- **The campus** - pink footprints are members, brightness is demand; yellow
  roofs are solar; travelling lights follow the flows; the pylon at
  Kraftcentralen is the grid connection, the charge point stands in the P-hus,
  and AWL is the battery - the building itself fills as it charges.

On the controller: switch a building off, or add panels to a roof, and watch
the bars move. Each change says what it did on the controller's own card while
the table redraws.

Dispatching a change takes about ten seconds for the whole campus.
