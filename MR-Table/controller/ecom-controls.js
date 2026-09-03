// ECOM Community Controls
// =======================
// The ECOM dashboard's console, on the table's controller.
//
// The dashboard has five panels of knobs; this brings them to the touch screen
// so the community can be changed at the table with no laptop in the loop. A
// control either re-dispatches (POST /api/mr/layer, about a second for a campus
// day) or it only hides what is already drawn - the two are kept in separate
// groups, because one costs a round trip and the other does not.
//
// Nothing is recomputed here. The backend owns the model and the
// dispatch-to-map transform, so what a slider puts on the table and what
// export_mr_layer.py writes to disk come out of the same code.
//
// Exposes globals: ecomControls

(function () {
    'use strict';

    const channel = new BroadcastChannel('map_controller_channel');

    const SCENARIO = 'campus_community';

    // The year the demand CSVs cover, and the year the sky is drawn for. The
    // backend models a fixed 365-day year with no leap day, so a leap year here
    // would put the sun on the wrong day for everything after February.
    // Fallback only. The real list comes from /api/scenarios/{name}/years,
    // which reads the measured-demand files on disk - offering a year nobody
    // has data for is how a picker ends up listing 2018.
    const DATA_YEAR = 2022;

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                         'July', 'August', 'September', 'October', 'November',
                         'December'];

    // How long to wait for the display to answer a ping before calling the link
    // down. BroadcastChannel delivery is effectively instant when it works at
    // all - it either arrives on the same origin or never.
    const PONG_TIMEOUT_MS = 900;

    const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const DAYS_PER_YEAR = 365;

    // Mirrors app/schemas/analysis_period.py: 1 January is day 1.
    function dayOfYear(month, day) {
        return MONTH_START[month - 1] + day;
    }

    function fromDayOfYear(doy) {
        const clamped = Math.max(1, Math.min(DAYS_PER_YEAR, doy));
        let month = 0;
        let remaining = clamped;
        while (remaining > DAYS_PER_MONTH[month]) {
            remaining -= DAYS_PER_MONTH[month];
            month += 1;
        }
        return { month: month + 1, day: remaining };
    }

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function isoDate(month, day) {
        return DATA_YEAR + '-' + pad(month) + '-' + pad(day);
    }

    function parseIso(value) {
        const parts = String(value).split('-');
        return { month: Number(parts[1]), day: Number(parts[2]) };
    }

    // How long to wait after the last touch before dispatching. A drag fires
    // input continuously and each one is a second of backend work, so only the
    // value the finger came to rest on is worth sending.
    const APPLY_DEBOUNCE_MS = 450;

    // Colours from ecom-palette.js, so a swatch here is the same colour the
    // table draws. They used to be a second hardcoded list, which is how a
    // legend ends up describing a picture nobody is looking at.
    const PALETTE = (window.ECOM_PALETTE && window.ECOM_PALETTE.semantic) || {};
    const NODE_KINDS = [
        { key: 'building', label: 'Buildings', color: PALETTE.building || '#ff00a6' },
        { key: 'pv', label: 'Solar', color: PALETTE.pv || '#eaff00' },
        { key: 'grid', label: 'Grid', color: PALETTE.grid || '#00ffe5' },
        { key: 'battery', label: 'Battery', color: PALETTE.battery || '#fa3600' },
        { key: 'charge_point', label: 'Charging', color: PALETTE.charge_point || '#00ff5e' }
    ];

    // ----------------------------------------------------------- the story
    //
    // An introduction, for showing the community to a room. The entities are
    // introduced one at a time and only then do they start trading, because
    // sharing cannot be explained until there is something to share between.
    //
    // The order is demand, then supply, then the outside world, then the two
    // new things, then the community. Buildings first because they are what
    // the room already recognises; the grid third rather than last because it
    // is the reference point - total dependency is what makes self-sufficiency
    // mean anything two steps later.
    //
    // One new entity per step and nothing is ever taken away, so the picture
    // accumulates instead of being replaced. The encodings arrive in order of
    // how hard they grab attention - colour, then lines, then a moving level,
    // then motion, then sound - because a car driving about and a transformer
    // buzzing from the first step means nobody hears the first three sentences.
    //
    // The clock is held still until the last step. Time moving and a new
    // entity appearing at once is where an audience loses the thread.
    const STORY = [
        {
            key: 'buildings',
            title: 'The buildings',
            line: 'Thirty-two buildings on campus, each with a year of measured ' +
                  'electricity behind it. This is the demand the community has ' +
                  'to cover.',
            figure: 'Members of the energy community',
            kinds: ['building'],
            pairs: [],
            hour: 12
        },
        {
            key: 'solar',
            title: 'The roofs',
            line: 'Eight of them carry solar. Brightest at midday, nothing at ' +
                  'night - and never enough on its own.',
            figure: 'Generation, where it is made',
            kinds: ['building', 'pv'],
            pairs: [],
            hour: 12
        },
        {
            key: 'grid',
            title: 'The grid',
            line: 'Today every building buys separately from the grid. These ' +
                  'are the lines that cost money and carry carbon.',
            figure: 'The baseline: one connection each',
            kinds: ['building', 'pv', 'grid'],
            pairs: ['grid>building'],
            hour: 12
        },
        {
            key: 'battery',
            title: 'The battery',
            line: 'A community store. It fills when there is more sun than ' +
                  'demand and empties into the campus after dark.',
            figure: 'Shifting energy through the day',
            kinds: ['building', 'pv', 'grid', 'battery'],
            pairs: ['grid>building', 'battery>building', 'building>battery',
                    'pv>battery', 'grid>battery'],
            hour: 19
        },
        {
            key: 'charging',
            title: 'The charge point',
            line: 'A charger on Gibraltarvallsvagen, and the car that uses it. ' +
                  'It arrives in the evening and leaves in the morning.',
            figure: 'A new load, on a schedule',
            kinds: ['building', 'pv', 'grid', 'battery', 'charge_point'],
            pairs: ['grid>building', 'battery>building', 'building>battery',
                    'pv>battery', 'grid>battery',
                    'grid>charge_point', 'battery>charge_point',
                    'building>charge_point', 'pv>charge_point'],
            hour: 20
        },
        {
            key: 'community',
            title: 'The energy community',
            line: 'The same buildings, now trading with each other before ' +
                  'anyone buys from outside. A surplus roof supplies a ' +
                  'neighbour, the battery covers the evening, and the grid ' +
                  'makes up the rest.',
            figure: 'Sharing, and the day running',
            kinds: null,          // everything
            pairs: null,          // every flow, peer to peer included
            hour: null,           // and the table takes its clock back
            sound: true
        }
    ];

    const state = {
        api: undefined,        // '' same origin, a URL, or null when unreachable
        stale: false,          // reachable, but too old to have /api/mr/layer
        base: null,            // the scenario as the server holds it
        working: null,         // the same, with this panel's edits applied
        selection: null,       // the building last tapped on the table
        excluded: new Set(),   // buildings dropped from the community
        params: null,          // optimizer constant descriptions
        paramsError: null,     // why they are not here, if they are not
        paramsLoading: false,
        paramValues: {},       // overrides, by name
        // Only what the panel can actually change. The layer still understands
        // owners, minFlow and minCapacity - see applyFilters in
        // animations/ecom-energy.js - but nothing here sets them any more, and
        // carrying three fields frozen at their defaults made pushFilters read
        // as though it did more than it does.
        filters: {
            kinds: NODE_KINDS.map(function (k) { return k.key; })
        },
        // When the table is looking at. The date re-dispatches; the hour only
        // scrubs a day that has already been computed.
        startMonth: 6,
        startDay: 1,
        year: DATA_YEAR,
        years: [],            // what the backend says there is data for
        // Whether a display is actually listening. Without this the panel looks
        // identical whether the table is following along or the two are on
        // different origins and nothing is getting through.
        link: { up: false, active: false, at: 0, checking: false },
        spanDays: 1,
        hour: 0,
        hours: 24,
        playing: true,        // whether the table is running its own clock
        sound: false,         // the table's sonification, off until asked for
        story: -1,            // which step of the introduction, -1 for none
        layer: null,          // the last layer dispatched, for the hourly PV readout
        openGroup: 'members',
        status: 'Looking for the backend…',
        statusKind: 'idle',
        busy: false,
        dirty: false,
        autoApply: true,
        optimizer: null        // last optimizer run, or an in-flight job
    };

    // ------------------------------------------------------------------ api

    // The optimizer's model constants.
    //
    // Its own function because it has its own failure: a swallowed error here
    // used to leave the group saying "Loading the model constants..." for the
    // rest of the session, which is indistinguishable from a slow network and
    // impossible to act on. Now it either has them, is fetching them, or says
    // what went wrong and offers to try again.
    async function loadParams() {
        if (state.paramsLoading) return;
        state.paramsLoading = true;
        state.paramsError = null;
        if (state.openGroup === 'optimizer') render();

        try {
            const payload = await getJson('/api/optimize/parameters');
            state.params = payload.parameters || [];
            if (!state.params.length) {
                state.paramsError = 'the backend returned no constants';
            }
        } catch (error) {
            state.params = null;
            state.paramsError = String(error.message || error);
        } finally {
            state.paramsLoading = false;
            // Only when it is on screen: this can land while a finger is on a
            // slider, and re-rendering would take the slider with it.
            if (state.openGroup === 'optimizer') render();
        }
    }

    function url(path) {
        return (state.api || '') + path;
    }

    // Same origin first: opened through the dashboard's /mr proxy, which is what
    // also makes BroadcastChannel work between the table and this panel. Then
    // the backend directly, for a controller opened straight off the static
    // server - which needs that origin in the backend's CORS list.
    const API_CANDIDATES = ['', 'http://localhost:8000', 'http://127.0.0.1:8000'];

    async function findApi() {
        for (const base of API_CANDIDATES) {
            try {
                const response = await fetch(base + '/api/health', { cache: 'no-store' });
                if (response.ok) return base;
            } catch (error) { /* try the next one */ }
        }
        return null;
    }

    /** Whether the reachable backend is new enough to rebuild the layer.
     *
     * A backend started before /api/mr/layer existed answers /api/health
     * perfectly well, so reachability alone would let the panel render every
     * control and only fail on the first Apply. An empty POST is the cheap
     * probe: 404 means the route is missing, and anything else - a 422 for the
     * body it just refused - means it is there.
     */
    async function hasLayerRoute() {
        try {
            const response = await fetch(url('/api/mr/layer'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            return response.status !== 404;
        } catch (error) {
            return false;
        }
    }

    async function getJson(path) {
        const response = await fetch(url(path), { cache: 'no-store' });
        if (!response.ok) throw new Error(path + ': ' + response.status);
        return response.json();
    }

    async function postJson(path, body, signal) {
        const response = await fetch(url(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: signal
        });
        if (!response.ok) {
            let detail = response.status + ' ' + response.statusText;
            try {
                const payload = await response.json();
                if (typeof payload.detail === 'string') {
                    detail = payload.detail;
                } else if (Array.isArray(payload.detail)) {
                    // Pydantic's own field errors. A whole-model validator
                    // reports loc ['body'] with nothing after it, so the path
                    // is only prefixed when there is one - otherwise every
                    // community-level error reads as ": ...".
                    detail = payload.detail.map(function (e) {
                        const path = (e.loc || []).slice(1).join('.');
                        return path ? path + ': ' + e.msg : e.msg;
                    }).join('; ');
                }
            } catch (error) { /* keep the status line */ }
            throw new Error(detail);
        }
        return response.json();
    }

    // ------------------------------------------------------- the definition

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    /** The definition to dispatch: the working copy minus excluded members. */
    function buildSpec() {
        const spec = clone(state.working);

        if (state.excluded.size) {
            spec.buildings = spec.buildings.filter(function (b) {
                return !state.excluded.has(b.name);
            });
            // A roof array left behind when its host leaves is not orphaned -
            // the builder promotes an unattached plant to a community plant, so
            // it would keep generating for a building nobody can see. Dropped
            // with its host instead.
            const kept = new Set();
            spec.buildings.forEach(function (b) {
                (b.pv_plants || []).forEach(function (name) { kept.add(name); });
            });
            spec.pv_plants = (spec.pv_plants || []).filter(function (p) {
                return kept.has(p.name);
            });
        }

        return spec;
    }

    // --------------------------------------------------------------- solar
    //
    // Two kinds of array, which the backend already distinguishes and this
    // panel now does too:
    //
    //   roof (BIPV)   a plant named in building.pv_plants[]. Node id
    //                 "{building}_PV_{plant}", drawn on that building.
    //   community     a plant attached to no building. Node id "PV_{plant}",
    //                 drawn with the shared assets at the middle of the campus.
    //
    // Eight of the roof arrays are surveyed - real surface, tilt and azimuth
    // off the Rhino model - so coverage changes their `percentage` and leaves
    // the geometry alone. A building with no survey gets a plant sized from its
    // footprint instead, which is the only roof area we actually know.

    // A community array - one attached to no building - is still part of the
    // model and the table still draws it: app/services/mr_layer.py places it
    // with the grid tie and the battery, and a scenario file can define one.
    // There is just no control for it here.

    // Tilt for a roof this panel adds. Surveyed roofs keep their measured tilt;
    // this is only for the ones sized from a footprint, where there is no
    // measurement to keep. 30 degrees is also PVPlantSpec's own default, so an
    // added roof matches what the backend would assume on its own.
    const ADDED_ROOF_TILT = 30;

    // The most of a roof that can actually carry panels.
    //
    // 100% is not a roof anyone can build: plant, walkways, access, edge
    // setbacks and self-shading between rows all take space. The surveyed
    // arrays on this campus sit at 70-93% of their own measured mounting
    // surface, and those surfaces already exclude the obstructions - a whole
    // footprint does not. 80 is the honest ceiling for a footprint-sized roof,
    // and offering 100 invited a number nobody could build.
    const MAX_ROOF_COVERAGE = 80;

    // Where a charge point can go.
    //
    // Read out of the same street network the table draws, rather than a list
    // of coordinates typed in here: a charger belongs on a road, and this is
    // the road they are being put on. A position along it is one number, which
    // is a far easier thing to set on a touch screen than a pair of decimals.
    const CP_STREET = 'Gibraltarvallsvägen';
    const STREET_URL = 'media/street-network.geojson';

    let streetPath = null;          // [[lon, lat], ...] south to north

    async function loadStreet() {
        if (streetPath) return streetPath;
        try {
            const response = await fetch(STREET_URL, { cache: 'no-store' });
            if (!response.ok) throw new Error(STREET_URL + ': ' + response.status);
            const data = await response.json();
            const points = [];
            (data.features || []).forEach(function (feature) {
                const name = (feature.properties || {}).name || '';
                // The file is latin-1 in places, so match on the stem rather
                // than the accented spelling.
                if (name.indexOf('Gibraltarvallsv') !== 0) return;
                const coords = feature.geometry.coordinates;
                const flat = typeof coords[0][0] === 'number'
                    ? coords
                    : coords.reduce(function (all, part) { return all.concat(part); }, []);
                points.push.apply(points, flat);
            });
            points.sort(function (a, b) { return a[1] - b[1]; });
            streetPath = points.length ? points : null;
        } catch (error) {
            streetPath = null;
        }
        return streetPath;
    }

    /** A point some fraction of the way along the street, 0 south to 1 north. */
    function alongStreet(fraction) {
        if (!streetPath || !streetPath.length) return null;
        const at = Math.max(0, Math.min(1, fraction));
        const index = Math.round(at * (streetPath.length - 1));
        return streetPath[index];
    }

    /** How far along the street a charge point currently sits. */
    function streetPosition(cp) {
        if (!streetPath || cp.lat == null) return 0.5;
        let best = 0;
        let bestGap = Infinity;
        streetPath.forEach(function (point, index) {
            const gap = Math.abs(point[1] - cp.lat) + Math.abs(point[0] - cp.lon);
            if (gap < bestGap) { bestGap = gap; best = index; }
        });
        return streetPath.length > 1 ? best / (streetPath.length - 1) : 0.5;
    }

    function chargePoints() {
        return state.working.charge_points || [];
    }

    /** A charger like the ones already there, on a free stretch of the street. */
    function addChargePoint() {
        const points = chargePoints();
        const template = points[0];

        let name = 'CP ' + (points.length + 1);
        const taken = new Set(points.map(function (cp) { return cp.name; }));
        let n = points.length + 1;
        while (taken.has(name)) { n += 1; name = 'CP ' + n; }

        // Spread down the street rather than stacked on the last one.
        const spot = alongStreet((points.length + 1) / 6) || [null, null];

        const cp = {
            name: name,
            capacity: template ? template.capacity : 22,
            charger_type: template ? template.charger_type : 'A',
            is_v2g: false,
            owner: template ? template.owner : 'Akademiska Hus',
            ev: {
                // A vehicle per charger: the toolkit computes demand for
                // exactly one, so a charger without it draws nothing at all.
                name: name + ' EV',
                capacity: 60,
                max_charging_power: 11,
                daily_distance: 40,
                v2g_enabled: false,
                availability: template && template.ev && template.ev.availability
                    ? template.ev.availability.slice()
                    : [1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1]
            }
        };
        if (spot[0] != null) { cp.lon = spot[0]; cp.lat = spot[1]; }

        state.working.charge_points = points.concat([cp]);
    }

    function removeChargePoint(name) {
        state.working.charge_points = chargePoints().filter(function (cp) {
            return cp.name !== name;
        });
    }

    /** Plants belonging to a building, in the working definition. */
    function roofPlants(name) {
        const building = (state.working.buildings || []).find(function (b) {
            return b.name === name;
        });
        if (!building) return [];
        const names = building.pv_plants || [];
        return (state.working.pv_plants || []).filter(function (p) {
            return names.indexOf(p.name) !== -1;
        });
    }

    /** kWp for a plant, mirroring PVPlantSpec.installed_capacity. */
    function plantKw(plant) {
        const module = plant.module || {};
        const area = (module.size_x || 1) * (module.size_y || 2);
        const rating = module.rating || 400;
        const usable = (plant.surface_area || 0) * ((plant.percentage || 0) / 100);
        return Math.floor(usable / area) * rating / 1000;
    }

    function roofKw(name) {
        return roofPlants(name).reduce(function (sum, p) {
            return sum + plantKw(p);
        }, 0);
    }

    /** The mounting surface available on a roof: surveyed if we have it. */
    function roofArea(building) {
        const plants = roofPlants(building.name);
        if (plants.length) {
            return plants.reduce(function (sum, p) {
                return sum + (p.surface_area || 0);
            }, 0);
        }
        return building.footprint_area || 0;
    }

    function roofCoverage(name) {
        const plants = roofPlants(name);
        if (!plants.length) return 0;
        // Surveyed roofs can carry different coverages; the row shows the mean.
        return plants.reduce(function (sum, p) {
            return sum + (p.percentage || 0);
        }, 0) / plants.length;
    }

    /** Set a building's roof coverage, creating or removing the plant. */
    function setRoofCoverage(name, percent) {
        // Clamped here as well as on the control, so a surveyed roof that
        // already sits above the ceiling is not pushed higher by a bulk action.
        percent = Math.min(percent, MAX_ROOF_COVERAGE);
        const building = (state.working.buildings || []).find(function (b) {
            return b.name === name;
        });
        if (!building) return;

        const existing = roofPlants(name);

        if (percent <= 0) {
            // Off means gone, not a zero-area plant: `percentage` must be > 0
            // and a plant left behind unattached would become community PV.
            const drop = new Set(existing.map(function (p) { return p.name; }));
            state.working.pv_plants = (state.working.pv_plants || [])
                .filter(function (p) { return !drop.has(p.name); });
            building.pv_plants = [];
            return;
        }

        if (existing.length) {
            // Surveyed geometry is kept; only the share covered in panels moves.
            existing.forEach(function (p) { p.percentage = percent; });
            return;
        }

        const area = building.footprint_area || 0;
        if (area <= 0) return;          // nothing to mount on that we know of

        const plantName = name + ' roof';
        state.working.pv_plants = state.working.pv_plants || [];
        state.working.pv_plants.push({
            name: plantName,
            surface_area: Math.round(area),
            percentage: percent,
            slope: ADDED_ROOF_TILT,
            azimuth: 0
        });
        building.pv_plants = [plantName];
    }

    /** Point every building at the measured file for a different year.
     *
     * The demand files sit beside each other and differ only in the year in the
     * name, so switching is a rename rather than a different data source. The
     * backend only offers years every building has, so this cannot leave one
     * pointing at a file that is not there.
     */
    function setYear(year) {
        const from = new RegExp('_' + state.year + '\\.csv$');
        state.working.buildings.forEach(function (building) {
            const demand = building.demand || {};
            if (demand.csv_path) {
                demand.csv_path = demand.csv_path.replace(from, '_' + year + '.csv');
            }
        });
        state.year = year;
    }

    function battery() { return (state.working.batteries || [])[0] || null; }

    /** How many days the period really covers.
     *
     * A period cannot wrap the new year - the backend rejects it outright,
     * because the dispatcher takes a plain (start, end) hour pair and a wrapped
     * range comes out empty. So a span running past 31 December is cut short,
     * and spanLabel says so rather than quietly handing back a shorter run than
     * the slider is showing.
     */
    function effectiveSpan() {
        const start = dayOfYear(state.startMonth, state.startDay);
        return Math.min(state.spanDays, DAYS_PER_YEAR - start + 1);
    }

    function spanLabel() {
        const actual = effectiveSpan();
        const text = actual + (actual === 1 ? ' day' : ' days');
        return actual < state.spanDays ? text + ' *' : text;
    }

    function paintSpan() {
        const label = document.getElementById('ecom-span-value');
        if (label) label.textContent = spanLabel();

        const note = document.getElementById('ecom-span-note');
        if (note) {
            const short = effectiveSpan() < state.spanDays;
            note.textContent = short
                ? '* cut to ' + effectiveSpan() + ' days: a period cannot cross ' +
                  'into the next year.'
                : '';
        }
    }

    /** Write the chosen date and span onto the definition as a date range.
     *
     * The span is counted inclusively and rolls over month ends, which the old
     * fixed "days from 1 June" could not do - it wrote end_day directly, so
     * anything past the 30th was a day that does not exist in June.
     */
    function applyPeriod() {
        const start = dayOfYear(state.startMonth, state.startDay);
        const end = fromDayOfYear(start + effectiveSpan() - 1);
        state.working.analysis_period = {
            start_month: state.startMonth,
            start_day: state.startDay,
            start_hour: 0,
            end_month: end.month,
            end_day: end.day,
            end_hour: 23
        };
    }

    /** The date the table is on, which drifts past midnight on a longer span. */
    function tableDateIso() {
        const doy = dayOfYear(state.startMonth, state.startDay) +
                    Math.floor(state.hour / 24);
        const date = fromDayOfYear(doy);
        return isoDate(date.month, date.day);
    }

    /**
     * Community PV output for the hour on the table, from the layer it drew.
     *
     * The layer can also be assembled from a display's summary broadcast, which
     * carries totals but no nodes - so an absent layer is not the only case to
     * guard. Reading through to `.features` there threw and took the whole
     * panel render down with it, before any Apply had been made.
     */
    function pvNow() {
        const nodes = state.layer && state.layer.nodes;
        if (!nodes || !nodes.features) return null;
        let total = 0;
        nodes.features.forEach(function (feature) {
            const series = feature.properties.solar_hourly;
            if (series) total += series[state.hour] || 0;
        });
        return total;
    }

    // ---------------------------------------------------------------- apply

    let applyTimer = null;
    let inFlight = null;

    function markDirty() {
        state.dirty = true;
        renderKpis();       // dims them, rather than leaving last run looking live
        if (state.autoApply) {
            // Straight away, not when the debounce fires: the wait starts at
            // the touch, and that is what it should acknowledge.
            setBusy('Updating…');
            scheduleApply();
        } else {
            setStatus('Edited - press Apply.', 'idle');
        }
    }

    function scheduleApply() {
        if (applyTimer !== null) clearTimeout(applyTimer);
        setStatus('Queued…', 'busy');
        applyTimer = setTimeout(function () {
            applyTimer = null;
            applyNow();
        }, APPLY_DEBOUNCE_MS);
    }

    async function applyNow() {
        if (state.api === null) {
            setStatus('No backend - start it and reload.', 'error');
            return;
        }

        // This run supersedes any queued one. Without cancelling it, a debounce
        // armed by the last slider touch fires mid-flight and aborts the very
        // request it would have made itself, leaving the table on the previous
        // community with nothing to say why.
        if (applyTimer !== null) {
            clearTimeout(applyTimer);
            applyTimer = null;
        }

        // A drag that outruns the dispatch would otherwise stack requests and
        // land them out of order, painting the table with an older community
        // than the one the slider is showing.
        if (inFlight) inFlight.abort();
        const controller = new AbortController();
        inFlight = controller;

        state.busy = true;
        setBusy('Dispatching…');
        setStatus('Dispatching…', 'busy');

        try {
            const layer = await postJson('/api/mr/layer', buildSpec(),
                                         controller.signal);
            if (controller.signal.aborted) return;
            channel.postMessage({ type: 'ecom_layer', layer: layer });
            // The backend is done; the table is not. Keep waiting.
            awaitDraw();
            state.dirty = false;

            // A shorter span can leave the hour past the end of the new day.
            state.layer = layer;
            state.hours = layer.meta.hours || state.hours;
            renderKpis();
            if (state.hour >= state.hours) state.hour = state.hour % state.hours;
            const scrub = document.getElementById('ecom-hour');
            if (scrub) {
                scrub.max = Math.max(0, state.hours - 1);
                scrub.value = state.hour;
            }
            paintSky();
            const members = layer.matched;
            const flows = layer.flows.features.length;
            setStatus(members + ' members, ' + flows + ' flows · ' +
                      layer.meta.period, 'ok');

            pingDisplay();
        } catch (error) {
            if (error.name === 'AbortError') return;
            setBusy(null);
            setStatus(String(error.message || error), 'error');
        } finally {
            if (inFlight === controller) inFlight = null;
            state.busy = false;
            // Repainted after busy clears, not before: the KPIs read that flag
            // to decide whether they are describing the run in flight or the
            // one before it, so painting them inside the request leaves them
            // dimmed and captioned "previous run" over figures that are current.
            renderKpis();
        }
    }

    function resetAll() {
        state.working = clone(state.base);
        applyPeriod();          // the picker keeps the date; only the model resets
        state.excluded = new Set();
        state.paramValues = {};
        state.filters.kinds = NODE_KINDS.map(function (k) { return k.key; });
        pushFilters();
        render();
        markDirty();
    }

    // -------------------------------------------------------------- filters

    function pushFilters() {
        // Every kind selected is no filter at all; sending null lets the layer
        // drop back to its own base filters rather than rebuilding an
        // equivalent expression on every touch.
        const all = state.filters.kinds.length === NODE_KINDS.length;
        channel.postMessage({
            type: 'ecom_filters',
            filters: all ? null : { kinds: state.filters.kinds }
        });
    }

    // -------------------------------------------------------------- story

    // Once per session. Coming back out of the introduction is a decision, and
    // the next display ping should not undo it.
    let storyOffered = false;

    /**
     * Start at the first step when the layer comes up.
     *
     * The introduction is the first thing the room sees, so the table opens on
     * the buildings rather than on the finished community - the whole point is
     * to arrive at that, not to begin with it. Exit or Finish leaves it, and it
     * does not come back until the page does.
     */
    function offerStory() {
        if (storyOffered || state.story >= 0) return;
        storyOffered = true;
        storyGo(0);
    }

    // What the sound was doing before the introduction muted it.
    let soundBeforeStory = null;

    function storyGo(index) {
        const leaving = state.story >= 0 && index < 0;
        const starting = state.story < 0 && index >= 0;
        if (starting) soundBeforeStory = state.sound;
        state.story = index;

        if (index < 0) {
            // Back to whatever the panel's own view filters say, the table's
            // own clock, and no caption.
            channel.postMessage({ type: 'ecom_caption', caption: null });
            pushFilters();
            if (leaving) {
                channel.postMessage({ type: 'ecom_release' });
                // Every step but the last mutes the sound, so quitting at step
                // three used to leave the table silent with no way to tell why.
                // Put it back the way it was found.
                if (soundBeforeStory !== null) {
                    channel.postMessage({ type: 'ecom_sound',
                                          on: !!soundBeforeStory });
                }
                soundBeforeStory = null;
            }
            render();
            return;
        }

        const step = STORY[index];
        channel.postMessage({
            type: 'ecom_filters',
            filters: (step.kinds === null && step.pairs === null)
                ? null
                : { kinds: step.kinds || NODE_KINDS.map(function (k) { return k.key; }),
                    pairs: step.pairs }
        });

        // A held hour for every step but the last, so only one thing is moving
        // at a time. The last hands the clock back and lets the day run.
        if (typeof step.hour === 'number') {
            channel.postMessage({ type: 'ecom_hour', hour: step.hour });
        } else {
            channel.postMessage({ type: 'ecom_release' });
        }

        // Sound arrives with the community, not before it.
        channel.postMessage({ type: 'ecom_sound', on: !!step.sound });

        channel.postMessage({
            type: 'ecom_caption',
            caption: { title: step.title, line: step.line, figure: step.figure,
                       step: index + 1, of: STORY.length }
        });

        render();
    }

    /**
     * Space or right arrow for the next step, left for back, Escape to leave.
     *
     * Bound on the panel document, because that is the window the presenter has
     * a hand on. Ignored while typing into a field, so renaming a charge point
     * does not advance the story under you.
     */
    function onStoryKey(event) {
        const tag = (event.target && event.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;

        if (event.key === ' ' || event.key === 'ArrowRight') {
            // Space scrolls a page by default, which on a panel this tall is
            // the last thing wanted mid-sentence.
            event.preventDefault();
            storyGo(state.story + 1 >= STORY.length ? -1 : state.story + 1);
            return;
        }
        if (state.story < 0) return;          // the rest only while running
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            storyGo(Math.max(0, state.story - 1));
        } else if (event.key === 'Escape') {
            storyGo(-1);
        }
    }

    function storyMarkup() {
        const running = state.story >= 0;
        const step = running ? STORY[state.story] : null;
        const last = state.story === STORY.length - 1;

        const dots = STORY.map(function (item, index) {
            return '<button type="button" class="ecom-ctl-dot' +
                (index === state.story ? ' is-on' : '') +
                (index < state.story ? ' is-done' : '') +
                '" data-story-step="' + index + '" title="' + esc(item.title) +
                '"></button>';
        }).join('');

        return '<div class="ecom-ctl-story' + (running ? ' is-running' : '') + '">' +
            '<div class="ecom-ctl-story-head">' +
                '<span class="ecom-ctl-story-label" title="Space or right arrow ' +
                    'for the next step, left arrow to go back, Escape to leave.">' +
                    (running
                        ? esc(step.title) + ' &middot; ' + (state.story + 1) +
                          ' of ' + STORY.length
                        : 'Introduction') +
                '</span>' +
                '<div class="ecom-ctl-dots">' + dots + '</div>' +
            '</div>' +
            '<div class="ecom-ctl-story-bar">' +
                (running
                    ? '<button type="button" class="ecom-ctl-btn" ' +
                          'data-action="story-back"' +
                          (state.story === 0 ? ' disabled' : '') + '>Back</button>' +
                      '<button type="button" class="ecom-ctl-btn ' +
                          'ecom-ctl-btn--primary" data-action="story-next">' +
                          (last ? 'Finish' : 'Next') + '</button>' +
                      '<button type="button" class="ecom-ctl-btn" ' +
                          'data-action="story-exit">Exit</button>'
                    : '<button type="button" class="ecom-ctl-btn ' +
                          'ecom-ctl-btn--primary" data-action="story-next">' +
                          'Start the introduction</button>') +
            '</div>' +
        '</div>';
    }

    // ------------------------------------------------------------ optimizer

    let pollTimer = null;

    async function runOptimizer() {
        if (state.api === null) return;
        stopPolling();
        state.optimizer = { status: 'queued', progress: 0 };
        render();

        try {
            const job = await postJson('/api/optimize', {
                community: buildSpec(),
                // One day. The MILP is roughly 0.25 s per building-day, so a
                // 36-building campus is already a couple of minutes - long
                // enough that anything more would not finish while someone is
                // standing at the table.
                days: 1,
                parameters: Object.keys(state.paramValues).length
                    ? state.paramValues : null
            });
            state.optimizer = job;
            render();
            poll(job.id);
        } catch (error) {
            state.optimizer = { status: 'error', error: String(error.message || error) };
            render();
        }
    }

    function poll(jobId) {
        pollTimer = setInterval(async function () {
            try {
                const job = await getJson('/api/optimize/' + encodeURIComponent(jobId));
                state.optimizer = job;
                if (job.status === 'done' || job.status === 'error') stopPolling();
                render();
            } catch (error) {
                state.optimizer = { status: 'error', error: String(error.message || error) };
                stopPolling();
                render();
            }
        }, 2000);
    }

    function stopPolling() {
        if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // --------------------------------------------------------------- render

    // ---------------------------------------------------------------- busy
    //
    // Shown from the moment a control moves until the display says it has
    // redrawn - not until the backend answers. Those are different moments and
    // only the second one is what someone at the table is waiting for: the
    // dispatch can return in a second and the picture still be the old one.
    //
    // Attached to the body rather than into a panel, so a re-render cannot take
    // it away mid-flight.

    // How long to keep waiting for the display after the backend has answered.
    // Past this the table is not going to confirm - it is closed, on another
    // origin, or running older code - and a spinner that never stops is worse
    // than none.
    const DRAW_TIMEOUT_MS = 2500;

    let busyEl = null;
    let drawTimer = null;

    function setBusy(text) {
        if (drawTimer !== null) {
            clearTimeout(drawTimer);
            drawTimer = null;
        }

        // Guarded: this runs in contexts without a body, and a missing overlay
        // must not take the panel down with it.
        if (!document.body || !document.createElement) return;

        if (!busyEl) {
            busyEl = document.createElement('div');
            busyEl.id = 'ecom-busy';
            busyEl.className = 'ecom-busy';
            document.body.appendChild(busyEl);
        }

        if (!text) {
            busyEl.className = 'ecom-busy';
            return;
        }

        busyEl.innerHTML =
            '<span class="ecom-busy-spinner"></span>' +
            '<span class="ecom-busy-text">' + esc(text) + '</span>';
        busyEl.className = 'ecom-busy is-on';
    }

    /** Waiting on the table now, with a limit. */
    function awaitDraw() {
        setBusy('Drawing on the table…');
        drawTimer = setTimeout(function () {
            drawTimer = null;
            setBusy(null);
            if (!state.link.up) {
                setStatus('Dispatched, but no display is listening - see the ' +
                          'link chip above.', 'error');
            }
        }, DRAW_TIMEOUT_MS);
    }

    // ------------------------------------------------------------- the link
    //
    // BroadcastChannel is same-origin and silent about it: a controller on
    // :8090 talking to a display opened through the dashboard proxy sends
    // messages that simply never arrive, and every control looks like it is
    // doing nothing. So the panel asks, and says what it found.

    let pingTimer = null;
    let pongTimer = null;

    function pingDisplay() {
        state.link.checking = true;
        channel.postMessage({ type: 'ecom_ping' });

        if (pongTimer !== null) clearTimeout(pongTimer);
        pongTimer = setTimeout(function () {
            pongTimer = null;
            state.link.checking = false;
            if (Date.now() - state.link.at > PONG_TIMEOUT_MS) {
                state.link.up = false;
                paintLink();
            }
        }, PONG_TIMEOUT_MS);
    }

    function paintLink() {
        const el = document.getElementById('ecom-ctl-link');
        if (!el) return;

        const up = state.link.up;
        el.className = 'ecom-ctl-link ' +
            (up ? (state.link.active ? 'is-live' : 'is-idle') : 'is-down');
        el.textContent = up
            ? (state.link.active ? 'Table live' : 'Table idle')
            : 'No display';
        el.title = up
            ? (state.link.active
                ? 'The display is showing the energy layer and following this panel.'
                : 'The display is listening, but the energy layer is switched off.')
            : 'No display answered. Open the table display from the same address ' +
              'as this controller - they talk over BroadcastChannel, which only ' +
              'works within one origin. If it is already open, reload it: a page ' +
              'loaded before these controls existed cannot answer.';
    }

    function setStatus(text, kind) {
        state.status = text;
        state.statusKind = kind || 'idle';
        // Patched rather than re-rendered: the status changes while a finger is
        // on a slider, and rebuilding the panel would take the slider with it.
        const el = document.getElementById('ecom-ctl-status');
        if (el) {
            el.textContent = text;
            el.className = 'ecom-ctl-status ecom-ctl-status--' + state.statusKind;
        }
    }

    function esc(value) {
        return String(value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function slider(opts) {
        const value = opts.value;
        return '' +
            '<label class="ecom-ctl-slider">' +
                '<span class="ecom-ctl-slider-head">' +
                    '<span>' + esc(opts.label) + '</span>' +
                    '<b data-readout="' + esc(opts.name) + '">' +
                        esc(opts.format ? opts.format(value) : value) +
                        ' ' + esc(opts.unit || '') +
                    '</b>' +
                '</span>' +
                '<input type="range" data-slider="' + esc(opts.name) + '"' +
                    ' min="' + opts.min + '" max="' + opts.max + '"' +
                    ' step="' + opts.step + '" value="' + value + '">' +
                (opts.hint ? '<span class="ecom-ctl-hint">' + esc(opts.hint) + '</span>' : '') +
            '</label>';
    }

    // Icon and accent per group, following the layer's own palette: members are
    // the building colour, solar the PV colour, and so on, so a group header and
    // the markers it governs are the same colour on the table.
    const GROUP_STYLE = {
        members: { icon: 'apartment', accent: 'pink' },
        solar: { icon: 'wb_sunny', accent: 'yellow' },
        storage: { icon: 'battery_charging_full', accent: 'orange' },
        grid: { icon: 'bolt', accent: 'cyan' },
        mobility: { icon: 'ev_station', accent: 'green' },
        view: { icon: 'visibility', accent: 'slate' },
        optimizer: { icon: 'insights', accent: 'violet' }
    };

    function group(id, title, note, body) {
        const open = state.openGroup === id;
        const style = GROUP_STYLE[id] || { icon: 'tune', accent: 'slate' };
        return '' +
            '<div class="ecom-ctl-group ecom-ctl-group--' + style.accent +
                (open ? ' is-open' : '') + '">' +
                '<button type="button" class="ecom-ctl-head" data-group="' + id + '">' +
                    '<span class="material-icons ecom-ctl-head-icon">' +
                        style.icon + '</span>' +
                    '<span>' + esc(title) + '</span>' +
                    '<span class="ecom-ctl-note">' + esc(note) + '</span>' +
                    '<span class="ecom-ctl-caret">' + (open ? '−' : '+') + '</span>' +
                '</button>' +
                (open ? '<div class="ecom-ctl-body">' + body + '</div>' : '') +
            '</div>';
    }

    // -------------------------------------------------------------- the KPIs
    //
    // The same figures the ECOM dashboard prints in its header, from the same
    // dispatch, in the controller's metadata band. Every one of them moves when
    // a parameter moves - that is the point of putting them next to the knobs.

    // Formatting mirrors DashboardHeader.tsx so a number read off the table and
    // the same number read off the dashboard cannot appear to disagree.
    /** Matches the reading the table's popup gives for the same building. */
    function formatEcomEnergyLocal(kwh) {
        if (kwh >= 1000) return (kwh / 1000).toFixed(1) + ' MWh';
        return Math.round(kwh).toLocaleString() + ' kWh';
    }

    function mwh(kwh) {
        if (kwh === null || kwh === undefined) return 'N/A';
        return (kwh / 1000).toFixed(2) + ' MWh';
    }

    function percent(value) {
        if (value === null || value === undefined) return 'N/A';
        return value.toFixed(2) + '%';
    }

    function compact(value) {
        if (value === null || value === undefined) return 'N/A';
        const abs = Math.abs(value);
        if (abs >= 1e6) return (value / 1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'k';
        return value.toFixed(1);
    }

    /** Installed PV across the members that were actually drawn. */
    function installedPvKw() {
        if (!state.layer || !state.layer.nodes) return null;
        return state.layer.nodes.features.reduce(function (sum, feature) {
            return sum + (feature.properties.pv_kw || 0);
        }, 0);
    }

    function tile(icon, value, label, tone, hint) {
        return '' +
            '<div class="ecom-kpi-tile ecom-kpi-tile--' + tone + '"' +
                (hint ? ' title="' + esc(hint) + '"' : '') + '>' +
                '<span class="material-icons ecom-kpi-icon">' + icon + '</span>' +
                '<span class="ecom-kpi-value">' + value + '</span>' +
                '<span class="ecom-kpi-label">' + esc(label) + '</span>' +
            '</div>';
    }

    function row(icon, label, value, hint) {
        return '' +
            '<div class="ecom-kpi-row"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>' +
                '<span class="material-icons ecom-kpi-row-icon">' + icon + '</span>' +
                '<span>' + esc(label) + '</span>' +
                '<b>' + value + '</b>' +
            '</div>';
    }

    function renderKpis() {
        const host = document.getElementById('ecom-kpis');
        if (!host) return;

        const pick = state.selection;
        const selected = pick
            ? '<div class="ecom-pick">' +
                  '<span class="material-icons ecom-pick-icon">apartment</span>' +
                  '<span class="ecom-pick-name">' + esc(pick.name) + '</span>' +
                  '<span><b>' + pick.self_sufficiency.toFixed(1) + '%</b> self-sufficient</span>' +
                  '<span><b>' + formatEcomEnergyLocal(pick.demand_kwh) + '</b> demand</span>' +
                  '<span><b>' + pick.pv_kw.toFixed(1) + ' kW</b> PV</span>' +
              '</div>'
            : '';

        const layer = state.layer;
        if (!layer || !layer.kpis || !Object.keys(layer.kpis).length) {
            host.innerHTML =
                '<p class="ecom-kpi-empty">Apply a change, or switch the layer on, ' +
                'and the community\'s figures appear here.</p>';
            return;
        }

        const k = layer.kpis;

        // While an edit is pending these describe the previous run. Dimmed and
        // said out loud, because a KPI that looks live and is one dispatch
        // behind is worse than no KPI.
        const stale = state.dirty || state.busy;

        host.className = 'ecom-kpis' + (stale ? ' is-stale' : '');
        host.innerHTML =
            selected +
            '<div class="ecom-kpi-tiles">' +
                tile('eco', percent(k.self_sufficiency), 'Self-sufficient', 'green',
                     'Share of demand met without importing from the grid.') +
                tile('bolt', mwh(k.total_demand), 'Total demand', 'pink',
                     'Everything the member buildings consumed over the period.') +
                tile('wb_sunny', mwh(k.total_pv_gen), 'PV generated', 'yellow',
                     'What the roof arrays produced.') +
                tile('south', mwh(k.total_grid_import), 'Grid import', 'cyan',
                     'Drawn from the grid.') +
                tile('north', mwh(k.total_grid_export), 'Grid export', 'blue',
                     'Sent back to the grid.') +
                tile('recycling', percent(k.self_consumption), 'Self-consumed', 'green',
                     'Share of what the panels made that the community used itself.') +
            '</div>' +

            '<div class="ecom-kpi-columns">' +
                '<div class="ecom-kpi-column">' +
                    '<div class="ecom-kpi-heading">Also</div>' +
                    row('solar_power', 'PV used', mwh(k.total_pv_used)) +
                    row('apartment', 'Avg. building self-cons.',
                        percent(k.avg_building_self_consumption)) +
                    row('co2', 'Carbon intensity', compact(k.avg_grid_carbon_intensity),
                        'kgCO2e per kWh, as the model declares it. 41 is the ' +
                        'Swedish grid factor in GRAMS - the figure and the ' +
                        'declared unit disagree by 1000, upstream of this panel.') +
                    row('cloud', 'Carbon imported', compact(k.total_grid_carbon_import),
                        'Import multiplied by intensity, so it carries the same ' +
                        'unit ambiguity.') +
                '</div>' +
                '<div class="ecom-kpi-column">' +
                    '<div class="ecom-kpi-heading">This run</div>' +
                    row('groups', 'In community',
                        (state.base
                            ? (state.base.buildings.length - state.excluded.size) +
                              ' of ' + state.base.buildings.length
                            : String(layer.matched))) +
                    row('place', 'Drawn on table', String(layer.matched),
                        'Members whose footprint is in the campus file. The rest ' +
                        'are dispatched but have nothing to draw on.') +
                    row('timeline', 'Flows drawn', String(layer.flows.features.length)) +
                    row('calendar_month', 'Measured year', String(state.year)) +
                    row('schedule', 'Hours dispatched', String(layer.meta.hours),
                        layer.meta.period) +
                '</div>' +

                // What the knobs in the band are actually set to. These come
                // from the definition that produced this run, not from the
                // sliders as they stand, so they describe the picture on the
                // table rather than an edit nobody has applied yet.
                '<div class="ecom-kpi-column">' +
                    '<div class="ecom-kpi-heading">Settings on this run</div>' +
                    row('solar_power', 'Installed PV',
                        (installedPvKw() === null ? 'N/A'
                         : Math.round(installedPvKw()).toLocaleString() + ' kW')) +
                    row('battery_charging_full', 'Battery',
                        (battery() ? Math.round(battery().capacity).toLocaleString() +
                         ' kWh' : 'none')) +
                    row('payments', 'Import price',
                        (k.avg_grid_price_import === undefined ? 'N/A'
                         : k.avg_grid_price_import.toFixed(2) + ' SEK/kWh')) +
                    row('sell', 'Export price',
                        (((state.working.grid || {}).selling_price || {}).fixed === undefined
                         ? 'N/A'
                         : state.working.grid.selling_price.fixed.toFixed(2) + ' SEK/kWh')) +
                    row('ev_station', 'Charge points',
                        (function () {
                            const points = chargePoints();
                            if (!points.length) return 'none';
                            const v2g = points.filter(function (cp) {
                                return cp.is_v2g;
                            }).length;
                            return points.length + (v2g ? ', ' + v2g + ' V2G' : '');
                        }())) +
                '</div>' +
            '</div>' +

            (stale ? '<div class="ecom-kpi-stale">These are the previous run. ' +
                     'Apply to bring them up to date.</div>' : '');
    }

    // ------------------------------------------------------------- the sky
    //
    // The same sky the sun study draws, over the energy panel: at a table, the
    // hour is the thing everyone is pointing at, and a number in a box does not
    // say "this is early morning" the way a low sun does. It reuses
    // controller/sun-study-ui.js rather than carrying a second copy of the
    // solar maths - one set of sunrise times for the whole controller.
    //
    // The two controls under it cost very different things, and are grouped to
    // say so: the date re-dispatches, the hour scrubs a day already computed.

    function option(value, label, selected) {
        return '<option value="' + value + '"' + (selected ? ' selected' : '') +
               '>' + esc(label) + '</option>';
    }

    function yearOptions() {
        // Before the backend answers there is exactly one year worth offering:
        // the one the scenario is already using.
        const years = state.years.length ? state.years : [state.year];
        return years.map(function (year) {
            return option(year, year, year === state.year);
        }).join('');
    }

    function monthOptions() {
        return MONTH_NAMES.map(function (name, index) {
            return option(index + 1, name, index + 1 === state.startMonth);
        }).join('');
    }

    function dayOptions() {
        const days = DAYS_PER_MONTH[state.startMonth - 1];
        const options = [];
        for (let day = 1; day <= days; day += 1) {
            options.push(option(day, day, day === state.startDay));
        }
        return options.join('');
    }

    function heroMarkup() {
        return '' +
            '<div class="ecom-sky-card">' +
                '<div id="ecom-sky" class="sun-sky">' +
                    '<svg class="sun-path" viewBox="0 0 100 100" preserveAspectRatio="none">' +
                        '<path d="M10 78 L90 78" stroke="rgba(255,255,255,0.35)" ' +
                              'stroke-width="0.6" fill="none" stroke-dasharray="2 2" />' +
                    '</svg>' +
                    '<div class="sun-cloud"></div>' +
                    '<div class="sun-cloud cloud-2"></div>' +
                    '<div class="sun-orb"></div>' +
                    '<div class="sun-horizon"></div>' +
                    '<div class="sun-time-center">' +
                        '<div id="ecom-sky-time" class="sun-time">--:--</div>' +
                        '<div id="ecom-sky-date" class="sun-date"></div>' +
                    '</div>' +
                    '<div class="sunrise-label">Sunrise <span id="ecom-sunrise">--:--</span></div>' +
                    '<div class="sunset-label">Sunset <span id="ecom-sunset">--:--</span></div>' +
                    '<div class="ecom-sky-pv">' +
                        '<b id="ecom-sky-pv-value">--</b>' +
                        '<span>community solar now</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<div class="ecom-when">' +
                // Three selects rather than <input type="date">: the native
                // picker offers a year scroller that ignores min/max for
                // display, so it listed years going back to 2018 with no data
                // behind any of them. These can only offer what exists.
                '<div class="ecom-when-row">' +
                    '<label for="ecom-month">Date</label>' +
                    '<select id="ecom-month" data-when="month" class="ecom-when-select">' +
                        monthOptions() +
                    '</select>' +
                    '<select id="ecom-day" data-when="day"' +
                        ' class="ecom-when-select ecom-when-select--day">' +
                        dayOptions() +
                    '</select>' +
                    '<select id="ecom-year" data-when="year"' +
                        ' class="ecom-when-select ecom-when-select--year"' +
                        ' title="Which year of measured demand to run.">' +
                        yearOptions() +
                    '</select>' +
                '</div>' +

                '<div class="ecom-when-row">' +
                    '<label for="ecom-span">Span</label>' +
                    '<input type="range" id="ecom-span" data-when="span"' +
                        ' min="1" max="14" step="1" value="' + state.spanDays + '">' +
                    '<b id="ecom-span-value" class="ecom-when-value">' +
                        spanLabel() +
                    '</b>' +
                '</div>' +
                '<span id="ecom-span-note" class="ecom-when-note"></span>' +
                // Which control costs a dispatch and which is free, in one line
                // rather than a paragraph under every row.
                '<div class="ecom-when-legend">' +
                    '<span><i class="ecom-when-dot ecom-when-dot--cost"></i>' +
                        'date &amp; year re-dispatch</span>' +
                    '<span><i class="ecom-when-dot ecom-when-dot--free"></i>' +
                        'hour is free</span>' +
                '</div>' +

                '<div class="ecom-when-row">' +
                    '<label for="ecom-hour">Hour</label>' +
                    '<input type="range" id="ecom-hour" data-when="hour"' +
                        ' min="0" max="' + Math.max(0, state.hours - 1) + '" step="1"' +
                        ' value="' + state.hour + '">' +
                    '<button type="button" class="ecom-when-play" data-action="play"' +
                        ' title="' + (state.playing ? 'Hold the hour' : 'Let the table run') + '">' +
                        (state.playing ? '❚❚' : '▶') +
                    '</button>' +
                '</div>' +
            '</div>';
    }

    // Patched in place, never re-rendered: this runs on every tick of the
    // table clock, and rebuilding the panel each second would snatch away
    // whatever slider is under a finger.
    function paintSky() {
        const sky = document.getElementById('ecom-sky');
        // sun-study-ui.js owns the solar maths and loads after this file. If it
        // is missing the panel is still usable - the sky just stays flat.
        if (!sky || typeof getSkyPalette !== 'function') return;

        const date = tableDateIso();
        const hourOfDay = state.hour % 24;

        const sun = calculateSunriseSunset(date);
        const palette = getSkyPalette(hourOfDay, sun.sunrise, sun.sunset,
                                      getMaxSunAltitude(date));

        // Where the orb sits: along the arc between sunrise and sunset, and
        // parked below the horizon at night, matching updateSunStudySky.
        const horizonY = 78;
        const maxPeak = 55;
        let sunX;
        let sunY;
        let sunOpacity;

        if (hourOfDay >= sun.sunrise && hourOfDay <= sun.sunset) {
            const progress = (hourOfDay - sun.sunrise) / (sun.sunset - sun.sunrise);
            const altitude = calculateSunAltitude(date, hourOfDay);
            sunX = 10 + progress * 80;
            sunY = horizonY - (Math.max(0, altitude) / MAX_POSSIBLE_ALTITUDE) * maxPeak;
            sunOpacity = 1;
        } else {
            const night = 24 - sun.sunset + sun.sunrise;
            const progress = hourOfDay > sun.sunset
                ? (hourOfDay - sun.sunset) / night
                : (24 - sun.sunset + hourOfDay) / night;
            sunX = 90 - progress * 80;
            sunY = horizonY + 20;
            sunOpacity = 0;
        }

        sky.style.setProperty('--sky-top', 'rgb(' + palette.top.join(',') + ')');
        sky.style.setProperty('--sky-mid', 'rgb(' + palette.mid.join(',') + ')');
        sky.style.setProperty('--sky-bottom', 'rgb(' + palette.bottom.join(',') + ')');
        sky.style.setProperty('--sun-x', sunX + '%');
        sky.style.setProperty('--sun-y', sunY + '%');
        sky.style.setProperty('--sun-opacity', String(sunOpacity));

        const arc = sky.querySelector('.sun-path path');
        if (arc) arc.setAttribute('d', generateSunArcPath(date, sun.sunrise, sun.sunset));

        const set = function (id, text) {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };
        set('ecom-sky-time', pad(hourOfDay) + ':00');
        set('ecom-sky-date', formatSunDate(date));
        set('ecom-sunrise', formatTimeHHMM(sun.sunrise));
        set('ecom-sunset', formatTimeHHMM(sun.sunset));

        // The energy half of the picture: what the roofs are actually making at
        // the hour the sun is drawn at. Without it the sky is decoration.
        const pv = pvNow();
        set('ecom-sky-pv-value', pv === null ? '--' : Math.round(pv).toLocaleString() + ' kW');
    }

    function solarGroup() {
        const buildings = (state.working.buildings || []);
        const withPv = buildings.filter(function (b) {
            return roofPlants(b.name).length;
        });

        const roofTotal = buildings.reduce(function (sum, b) {
            return sum + roofKw(b.name);
        }, 0);

        const rows = buildings.map(function (b) {
            const area = Math.round(roofArea(b));
            const coverage = Math.round(roofCoverage(b.name));
            const surveyed = roofPlants(b.name).length > 0 &&
                             b.pv_plants && b.pv_plants.length &&
                             b.pv_plants[0] !== b.name + ' roof';
            // A building with no footprint in the campus file has no roof we
            // can size, so it is shown and disabled rather than quietly absent.
            const usable = area > 0;
            return '' +
                '<div class="ecom-roof' + (coverage > 0 ? ' is-on' : '') +
                    (usable ? '' : ' is-blocked') + '">' +
                    '<span class="ecom-roof-name">' + esc(b.name) +
                        (surveyed ? '<i class="ecom-roof-tag" title="Surveyed ' +
                         'from the Rhino model - real surface, tilt and azimuth">' +
                         'surveyed</i>' : '') +
                    '</span>' +
                    '<span class="ecom-roof-area">' +
                        (usable ? area.toLocaleString() + ' m²' : 'no roof data') +
                    '</span>' +
                    (usable
                        ? '<input type="range" data-roof="' + esc(b.name) + '"' +
                              ' min="0" max="' + MAX_ROOF_COVERAGE + '" step="5"' +
                              ' value="' + Math.min(coverage, MAX_ROOF_COVERAGE) + '">' +
                          '<b class="ecom-roof-kw">' +
                              (coverage > 0 ? Math.round(roofKw(b.name)) + ' kW' : 'off') +
                          '</b>'
                        : '<span class="ecom-roof-blocked">—</span>') +
                '</div>';
        }).join('');

        return group('solar', 'Solar',
            Math.round(roofTotal).toLocaleString() + ' kW',
            '<div class="ecom-roof-bar">' +
                '<span>' + withPv.length + ' of ' + buildings.length + '</span>' +
                '<button type="button" class="ecom-mini" data-roofs="40">40%</button>' +
                '<button type="button" class="ecom-mini" data-roofs="' +
                    MAX_ROOF_COVERAGE + '">' + MAX_ROOF_COVERAGE + '%</button>' +
                '<button type="button" class="ecom-mini" data-roofs="0">Clear</button>' +
            '</div>' +
            '<div class="ecom-roofs">' + rows + '</div>');
    }

    function storageGroup() {
        const bat = battery();
        if (!bat) {
            return group('storage', 'Storage', 'none',
                '<p class="ecom-ctl-empty">No battery in this community.</p>');
        }
        return group('storage', 'Storage', Math.round(bat.capacity) + ' kWh',
            slider({
                name: 'battery_kwh', label: 'Battery capacity',
                value: bat.capacity, min: 0, max: 5000, step: 50, unit: 'kWh',
                format: function (v) { return Number(v).toLocaleString(); }
            }) +
            slider({
                name: 'battery_soc', label: 'Starting charge',
                value: Math.round((bat.initial_soc_fraction != null
                    ? bat.initial_soc_fraction : 0.5) * 100),
                min: 0, max: 100, step: 5, unit: '%',
                hint: 'A fraction of capacity, so it holds as the battery resizes.'
            })
        );
    }

    function gridGroup() {
        const grid = state.working.grid || {};
        const buy = (grid.buying_price || {}).fixed;
        const sell = (grid.selling_price || {}).fixed;
        const carbon = (grid.carbon_intensity || {}).fixed;
        return group('grid', 'Grid',
            (buy != null ? buy : 1.35) + ' SEK/kWh in',
            slider({
                name: 'buy_price', label: 'Import price',
                value: buy != null ? buy : 1.35,
                min: 0, max: 5, step: 0.05, unit: 'SEK/kWh'
            }) +
            slider({
                name: 'sell_price', label: 'Export price',
                value: sell != null ? sell : 0.55,
                min: 0, max: 5, step: 0.05, unit: 'SEK/kWh'
            }) +
            slider({
                name: 'carbon', label: 'Carbon intensity',
                value: carbon != null ? carbon : 41,
                min: 0, max: 400, step: 1, unit: 'g/kWh'
            })
        );
    }

    function mobilityGroup() {
        const points = chargePoints();

        if (!points.length) {
            return group('mobility', 'Mobility', 'none',
                '<span class="ecom-ctl-hint">No charge points in this ' +
                'community.</span>' +
                '<div class="ecom-ctl-actions">' +
                    '<button type="button" class="ecom-ctl-btn ecom-ctl-btn--primary"' +
                        ' data-action="cp-add">Add a charge point</button>' +
                '</div>');
        }

        const total = points.reduce(function (sum, cp) {
            return sum + (cp.capacity || 0);
        }, 0);

        const rows = points.map(function (cp, index) {
            const placed = cp.lat != null;
            const position = Math.round(streetPosition(cp) * 100);
            return '' +
                '<div class="ecom-cp">' +
                    '<div class="ecom-cp-head">' +
                        '<span class="ecom-cp-name">' + esc(cp.name) + '</span>' +
                        '<span class="ecom-cp-kw">' + Math.round(cp.capacity) + ' kW</span>' +
                        (points.length > 1
                            ? '<button type="button" class="ecom-mini"' +
                              ' data-cp-remove="' + esc(cp.name) + '"' +
                              ' title="Remove this charge point">Remove</button>'
                            : '') +
                    '</div>' +
                    slider({
                        name: 'cp_kw:' + index, label: 'Charger power',
                        value: cp.capacity, min: 4, max: 150, step: 1, unit: 'kW'
                    }) +
                    slider({
                        name: 'cp_km:' + index, label: 'Daily driving',
                        value: (cp.ev && cp.ev.daily_distance) || 35,
                        min: 0, max: 200, step: 5, unit: 'km'
                    }) +
                    (streetPath
                        ? slider({
                              name: 'cp_pos:' + index,
                              label: 'Along ' + CP_STREET,
                              value: position, min: 0, max: 100, step: 2,
                              unit: '% north',
                              hint: placed ? '' : 'Not placed yet - move this to put it on the street.'
                          })
                        : '<span class="ecom-ctl-hint">The street network has ' +
                          'not loaded, so this one stays at the middle of the ' +
                          'campus with the other shared assets.</span>') +
                    '<label class="ecom-ctl-check">' +
                        '<input type="checkbox" data-cp-v2g="' + index + '"' +
                            (cp.is_v2g ? ' checked' : '') + '>' +
                        '<span>Vehicle-to-grid</span>' +
                    '</label>' +
                '</div>';
        }).join('');

        return group('mobility', 'Mobility',
            points.length + (points.length === 1 ? ' charger · ' : ' chargers · ') +
                Math.round(total) + ' kW',
            '<div class="ecom-cps">' + rows + '</div>' +
            '<div class="ecom-ctl-actions">' +
                '<button type="button" class="ecom-ctl-btn" data-action="cp-add">' +
                    'Add a charge point</button>' +
            '</div>' +
            '<span class="ecom-ctl-hint">The charger and its car move together ' +
            'on vehicle-to-grid: the backend rejects a car with it on behind a ' +
            'charger without it.</span>');
    }

    function membersGroup() {
        const all = state.base.buildings;
        const inCount = all.length - state.excluded.size;
        const rows = all.map(function (b) {
            const on = !state.excluded.has(b.name);
            return '' +
                '<label class="ecom-ctl-member' + (on ? '' : ' is-off') + '">' +
                    '<input type="checkbox" data-member="' + esc(b.name) + '"' +
                        (on ? ' checked' : '') + '>' +
                    '<span class="ecom-ctl-member-name">' + esc(b.name) + '</span>' +
                    '<span class="ecom-ctl-member-owner">' + esc(b.owner || '') + '</span>' +
                '</label>';
        }).join('');

        return group('members', 'Members', inCount + ' of ' + all.length,
            '<div class="ecom-ctl-actions">' +
                '<button type="button" class="ecom-ctl-btn" data-members="all">All in</button>' +
                '<button type="button" class="ecom-ctl-btn" data-members="none">All out</button>' +
            '</div>' +
            '<div class="ecom-ctl-members">' + rows + '</div>' +
            '<span class="ecom-ctl-hint">Dropping a member takes its roof array with it, ' +
            'so the panels do not keep generating for a building that has left.</span>'
        );
    }

    // The legend and the view filters were the same list twice: a colour and a
    // label, next to a chip with the same colour and label that could turn it
    // off. They are one control now, in the panel beside the table.
    function renderView() {
        const host = document.getElementById('ecom-view');
        if (!host) return;

        const kinds = NODE_KINDS.map(function (k) {
            const on = state.filters.kinds.indexOf(k.key) !== -1;
            return '<button type="button" class="ecom-ctl-chip' + (on ? ' is-on' : '') + '"' +
                   ' data-kind="' + k.key + '"' +
                   ' title="Show or hide ' + esc(k.label.toLowerCase()) + ' on the table">' +
                   '<span class="ecom-ctl-dot" style="background:' + k.color + '"></span>' +
                   esc(k.label) + '</button>';
        }).join('');

        // Owner chips and the two "hide below" sliders were here. The layer
        // still supports all three - applyFilters in animations/ecom-energy.js
        // reads owners, minFlow and minCapacity - so restoring them is markup,
        // not plumbing. They are just not what anyone reaches for at the table.
        host.innerHTML =
            '<div class="ecom-ctl-chips">' + kinds + '</div>' +
            '<div class="ecom-legend-note">' +
                'Tap a swatch to hide that kind. Line width follows flow size.' +
            '</div>';
    }

    function optimizerGroup() {
        if (state.api === null) {
            return group('optimizer', 'Optimizer', 'offline',
                '<p class="ecom-ctl-empty">Needs the backend.</p>');
        }
        if (state.paramsLoading) {
            return group('optimizer', 'Optimizer', 'loading',
                '<p class="ecom-ctl-empty">Loading the model constants…</p>');
        }
        // An empty list is a failure too - it means the request went through and
        // came back with nothing to tune, which is not a panel worth drawing.
        if (!state.params || !state.params.length) {
            return group('optimizer', 'Optimizer', 'unavailable',
                '<p class="ecom-ctl-empty ecom-ctl-error">' +
                    esc(state.paramsError ||
                        'the model constants have not been fetched') +
                '</p>' +
                '<span class="ecom-ctl-hint">The rest of the panel works ' +
                'without these - they only feed the MILP optimizer.</span>' +
                '<div class="ecom-ctl-actions">' +
                    '<button type="button" class="ecom-ctl-btn"' +
                        ' data-action="params-retry">Try again</button>' +
                '</div>');
        }

        const changed = Object.keys(state.paramValues).length;

        const byGroup = {};
        state.params.forEach(function (p) {
            (byGroup[p.group] = byGroup[p.group] || []).push(p);
        });

        const fields = Object.keys(byGroup).map(function (name) {
            const rows = byGroup[name].map(function (p) {
                const value = state.paramValues[p.name] != null
                    ? state.paramValues[p.name] : p.default;
                const isChanged = state.paramValues[p.name] !== undefined;
                return '' +
                    '<label class="ecom-ctl-param' + (isChanged ? ' is-changed' : '') + '"' +
                        ' title="' + esc(p.description || '') + '">' +
                        '<span>' + esc(p.name.replace(/_/g, ' ')) +
                            (p.outdated ? ' <b class="ecom-ctl-stale">●</b>' : '') +
                        '</span>' +
                        '<input type="number" step="any" data-param="' + esc(p.name) + '"' +
                            ' value="' + value + '">' +
                        '<em>' + esc(p.unit || '') + '</em>' +
                    '</label>';
            }).join('');
            return '<div class="ecom-ctl-sub">' + esc(name) + '</div>' + rows;
        }).join('');

        const job = state.optimizer;
        let readout = '';
        if (job && job.status === 'done' && job.result) {
            const totals = job.result.totals || {};
            readout =
                '<div class="ecom-ctl-result">' +
                    '<div><span>Overall cost</span><b>' +
                        Math.round(totals.overall_cost || 0).toLocaleString() + ' SEK</b></div>' +
                    '<div><span>Grid import</span><b>' +
                        Math.round(totals.grid_import_kwh || 0).toLocaleString() + ' kWh</b></div>' +
                    '<div><span>Grid export</span><b>' +
                        Math.round(totals.grid_export_kwh || 0).toLocaleString() + ' kWh</b></div>' +
                    '<div><span>Peak import</span><b>' +
                        Math.round(totals.peak_net_import_kw || 0).toLocaleString() + ' kW</b></div>' +
                '</div>';
        } else if (job && job.status === 'error') {
            readout = '<p class="ecom-ctl-empty ecom-ctl-error">' +
                      esc(job.error || 'the optimizer failed') + '</p>';
        } else if (job) {
            readout = '<p class="ecom-ctl-empty">Solving… ' +
                      Math.round((job.progress || 0) * 100) + '%</p>';
        }

        return group('optimizer', 'Optimizer',
            changed ? changed + ' changed' : state.params.length + ' constants',
            '<span class="ecom-ctl-hint">These drive the MILP optimizer, not the ' +
            'dispatch the table animates - a run is minutes, and it returns costs ' +
            'rather than a new set of flows. Changing one leaves the table as it is.</span>' +
            '<div class="ecom-ctl-actions">' +
                '<button type="button" class="ecom-ctl-btn ecom-ctl-btn--primary"' +
                    ' data-action="optimize"' + (job && job.status === 'running' ? ' disabled' : '') + '>' +
                    'Run one day</button>' +
                (changed ? '<button type="button" class="ecom-ctl-btn" data-action="params-reset">' +
                    'Reset constants</button>' : '') +
            '</div>' +
            readout +
            '<div class="ecom-ctl-params">' + fields + '</div>' +
            '<span class="ecom-ctl-hint"><b class="ecom-ctl-stale">●</b> marks a ' +
            'value the optimization team flagged as out of date.</span>'
        );
    }

    // Two homes, because the two halves want different shapes: the sky and the
    // apply bar are a narrow column, and seven parameter groups are a wide band
    // where they can sit side by side instead of one above the other.
    function render() {
        const host = document.getElementById('legend-content');
        const groupHost = document.getElementById('ecom-groups');
        if (!host) return;

        if (state.api === undefined) {
            host.innerHTML = '<p class="ecom-ctl-empty">Looking for the backend…</p>';
            if (groupHost) groupHost.innerHTML = '';
            return;
        }
        if (state.api === null || state.stale || !state.base) {
            // The offline card belongs with the apply bar, not duplicated into
            // the band; the band simply has nothing to show.
            if (groupHost) groupHost.innerHTML = '';
            // Two different faults, and the fix is different for each: nothing
            // answering at all, versus a backend that answers but predates the
            // endpoint. Saying "no backend" for the second sends someone off to
            // start a server that is already running.
            host.innerHTML = state.stale
                ? '<div class="ecom-ctl-offline">' +
                      '<b>The backend is out of date.</b>' +
                      '<p>It is answering, but it has no <code>/api/mr/layer</code> ' +
                      'yet - it was started before that endpoint existed. Restart it ' +
                      'and these controls come up:</p>' +
                      '<code>cd Dashboard/backend</code>' +
                      '<code>python -m uvicorn app.main:app --reload --port 8000</code>' +
                      '<p><code>--reload</code> so the next backend change does not ' +
                      'need this again.</p>' +
                      '<button type="button" class="ecom-ctl-btn ecom-ctl-btn--primary" ' +
                          'data-action="retry">Try again</button>' +
                  '</div>'
                : '<div class="ecom-ctl-offline">' +
                      '<b>No backend.</b>' +
                      '<p>These controls re-dispatch the community, which needs the ' +
                      'ECOM dashboard API:</p>' +
                      '<code>cd Dashboard/backend</code>' +
                      '<code>python -m uvicorn app.main:app --reload --port 8000</code>' +
                      '<p>The table keeps animating its exported layer meanwhile - ' +
                      'only the parameters are unavailable.</p>' +
                      '<button type="button" class="ecom-ctl-btn ecom-ctl-btn--primary" ' +
                          'data-action="retry">Try again</button>' +
                  '</div>';
            return;
        }

        host.innerHTML =
            '<div class="ecom-ctl">' +
                heroMarkup() +
                '<div class="ecom-ctl-bar">' +
                    '<label class="ecom-ctl-check ecom-ctl-check--inline">' +
                        '<input type="checkbox" data-toggle="auto"' +
                            (state.autoApply ? ' checked' : '') + '>' +
                        '<span>Live</span>' +
                    '</label>' +
                    '<button type="button" class="ecom-ctl-btn ecom-ctl-btn--primary"' +
                        ' data-action="apply">Apply</button>' +
                    '<button type="button" class="ecom-ctl-btn" data-action="reset">Reset</button>' +
                    '<button type="button" class="ecom-ctl-sound' +
                        (state.sound ? ' is-on' : '') + '" data-action="sound"' +
                        ' title="Play the community. Grid import sets how dense ' +
                        'the pulses are; self-sufficiency sets how calm the ' +
                        'texture is. The drone is 100 Hz - twice mains, the note ' +
                        'a transformer actually hums at.">' +
                        '<span class="material-icons">' +
                            (state.sound ? 'volume_up' : 'volume_off') +
                        '</span>' +
                    '</button>' +
                    '<span id="ecom-ctl-link" class="ecom-ctl-link is-down"' +
                        ' title="Checking for a display...">Checking</span>' +
                '</div>' +
                '<div id="ecom-ctl-status" class="ecom-ctl-status ecom-ctl-status--' +
                    state.statusKind + '">' + esc(state.status) + '</div>' +
                storyMarkup() +
            '</div>';

        if (groupHost) {
            groupHost.innerHTML =
                membersGroup() +
                solarGroup() +
                storageGroup() +
                gridGroup() +
                mobilityGroup() +
                optimizerGroup();
        }

        paintSpan();
        paintSky();
        paintLink();
        renderKpis();
        renderView();
        pingDisplay();
    }

    // ---------------------------------------------------------------- input
    //
    // Delegated from the host, once. Re-rendering the panel replaces every
    // control in it, so listeners bound per control would be lost on the first
    // group someone opens.

    function onInput(event) {
        const target = event.target;

        const when = target.getAttribute && target.getAttribute('data-when');
        if (when) {
            onWhen(when, target);
            return;
        }

        const roof = target.getAttribute && target.getAttribute('data-roof');
        if (roof) {
            const percent = Number(target.value);
            setRoofCoverage(roof, percent);
            // Patched, not re-rendered: this fires continuously under a finger.
            const row = target.parentElement;
            if (row) {
                row.classList.toggle('is-on', percent > 0);
                const kw = row.querySelector('.ecom-roof-kw');
                if (kw) {
                    kw.textContent = percent > 0
                        ? Math.round(roofKw(roof)) + ' kW' : 'off';
                }
            }
            markDirty();
            return;
        }

        const name = target.getAttribute && target.getAttribute('data-slider');
        if (name) {
            const value = Number(target.value);
            const readout = document.querySelector('[data-readout="' + name + '"]');
            applySlider(name, value, readout);
            return;
        }

        const param = target.getAttribute && target.getAttribute('data-param');
        if (param) {
            const raw = target.value;
            if (raw === '') delete state.paramValues[param];
            else state.paramValues[param] = Number(raw);
            target.parentElement.classList.toggle('is-changed', raw !== '');
            // The optimizer constants are inputs to a separate run, not to the
            // dispatch the table draws, so nothing is re-sent here.
            return;
        }
    }

    function onWhen(control, target) {
        if (control === 'year') {
            setYear(Number(target.value));
            paintSky();
            markDirty();
            return;
        }

        if (control === 'month') {
            state.startMonth = Number(target.value);
            // February has no 30th. Clamp before the day list is rebuilt, or
            // the definition carries a date that does not exist.
            const limit = DAYS_PER_MONTH[state.startMonth - 1];
            if (state.startDay > limit) state.startDay = limit;
            const dayList = document.getElementById('ecom-day');
            if (dayList) dayList.innerHTML = dayOptions();
            applyPeriod();
            paintSpan();
            paintSky();
            markDirty();
            return;
        }

        if (control === 'day') {
            state.startDay = Number(target.value);
            applyPeriod();
            paintSpan();      // a late date can shorten the span
            paintSky();
            markDirty();
            return;
        }

        if (control === 'span') {
            state.spanDays = Number(target.value);
            applyPeriod();
            paintSpan();
            markDirty();
            return;
        }

        if (control === 'hour') {
            // Scrubbing takes the day off the table's own clock - two things
            // driving the hour at once reads as a stutter - so the button
            // flips to "play" to hand it back.
            state.hour = Number(target.value);
            state.playing = false;
            setPlayButton();
            channel.postMessage({
                type: 'ecom_hour', hour: state.hour, totalHours: state.hours
            });
            paintSky();
        }
    }

    function setPlayButton() {
        const btn = document.querySelector('.ecom-when-play');
        if (!btn) return;
        btn.textContent = state.playing ? '❚❚' : '▶';
        btn.title = state.playing ? 'Hold the hour' : 'Let the table run';
    }

    function applySlider(name, value, readout) {
        const set = function (text) { if (readout) readout.textContent = text; };
        const w = state.working;

        // Per-charger sliders carry their index: `cp_kw:2`. One handler for
        // however many chargers there are, rather than a fixed set of three.
        if (name.indexOf('cp_') === 0) {
            const parts = name.split(':');
            const cp = chargePoints()[Number(parts[1])];
            if (!cp) return;
            if (parts[0] === 'cp_kw') {
                cp.capacity = value;
                set(value + ' kW');
            } else if (parts[0] === 'cp_km') {
                if (cp.ev) cp.ev.daily_distance = Math.max(1, value);
                set(value + ' km');
            } else if (parts[0] === 'cp_pos') {
                const spot = alongStreet(value / 100);
                if (spot) { cp.lon = spot[0]; cp.lat = spot[1]; }
                set(value + ' % north');
            }
            markDirty();
            return;
        }

        switch (name) {
            case 'battery_kwh':
                // The backend requires a positive capacity.
                w.batteries[0].capacity = Math.max(1, value);
                set(value.toLocaleString() + ' kWh');
                markDirty();
                break;
            case 'battery_soc':
                w.batteries[0].initial_soc_fraction = value / 100;
                set(value + ' %');
                markDirty();
                break;
            case 'buy_price':
                w.grid.buying_price = { fixed: value };
                set(value.toFixed(2) + ' SEK/kWh');
                markDirty();
                break;
            case 'sell_price':
                w.grid.selling_price = { fixed: value };
                set(value.toFixed(2) + ' SEK/kWh');
                markDirty();
                break;
            case 'carbon':
                w.grid.carbon_intensity = { fixed: value };
                set(value + ' g/kWh');
                markDirty();
                break;
            default:
                break;
        }
    }

    // Every attribute onClick dispatches on, in one place. It was a selector
    // literal, and adding a handler without adding its attribute here made the
    // control silently inert - which is what happened to the solar tabs and the
    // bulk roof buttons: the handlers were right there and never ran, because
    // closest() had nothing to match.
    const CLICK_ATTRIBUTES = [
        'data-group', 'data-action', 'data-kind',
        'data-members', 'data-roofs', 'data-cp-remove', 'data-story-step'
    ];
    const CLICK_SELECTOR = CLICK_ATTRIBUTES.map(function (name) {
        return '[' + name + ']';
    }).join(',');

    function onClick(event) {
        const el = event.target.closest
            ? event.target.closest(CLICK_SELECTOR) : null;
        if (!el) return;

        const groupId = el.getAttribute('data-group');
        if (groupId) {
            state.openGroup = state.openGroup === groupId ? null : groupId;
            render();
            return;
        }

        const jump = el.getAttribute('data-story-step');
        if (jump !== null) { storyGo(Number(jump)); return; }

        const action = el.getAttribute('data-action');
        if (action === 'story-next') {
            storyGo(state.story + 1 >= STORY.length ? -1 : state.story + 1);
            return;
        }
        if (action === 'story-back') { storyGo(Math.max(0, state.story - 1)); return; }
        if (action === 'story-exit') { storyGo(-1); return; }
        if (action === 'apply') { applyNow(); return; }
        if (action === 'reset') { resetAll(); return; }
        if (action === 'play') {
            state.playing = !state.playing;
            setPlayButton();
            channel.postMessage(state.playing
                ? { type: 'ecom_release' }
                : { type: 'ecom_hour', hour: state.hour, totalHours: state.hours });
            return;
        }
        if (action === 'retry') {
            // Starting the backend should not also mean reloading the
            // controller and losing whatever is on the table.
            el.disabled = true;
            el.textContent = 'Looking…';
            loaded = false;
            state.api = undefined;
            state.stale = false;
            load();
            return;
        }
        if (action === 'optimize') { runOptimizer(); return; }
        if (action === 'params-reset') {
            state.paramValues = {};
            render();
            return;
        }
        if (action === 'params-retry') { loadParams(); return; }
        if (action === 'sound') {
            // The table owns the audio - it is the machine with the speakers,
            // and this is a projection driven from a second screen. This asks;
            // the table answers with ecom_sound_state.
            channel.postMessage({ type: 'ecom_sound', on: !state.sound });
            return;
        }
        if (action === 'cp-add') {
            addChargePoint();
            render();
            markDirty();
            return;
        }

        const remove = el.getAttribute('data-cp-remove');
        if (remove) {
            removeChargePoint(remove);
            render();
            markDirty();
            return;
        }

        const kind = el.getAttribute('data-kind');
        if (kind) {
            const at = state.filters.kinds.indexOf(kind);
            if (at === -1) state.filters.kinds.push(kind);
            else state.filters.kinds.splice(at, 1);
            el.classList.toggle('is-on', at === -1);
            pushFilters();
            return;
        }

        const roofs = el.getAttribute('data-roofs');
        if (roofs !== null) {
            const percent = Number(roofs);
            (state.working.buildings || []).forEach(function (b) {
                setRoofCoverage(b.name, percent);
            });
            render();
            markDirty();
            return;
        }

        const members = el.getAttribute('data-members');
        if (members) {
            if (members === 'all') {
                state.excluded = new Set();
            } else {
                // One member has to stay: the backend refuses a community with
                // no buildings, and every KPI would be zero anyway.
                state.excluded = new Set(state.base.buildings.slice(1)
                    .map(function (b) { return b.name; }));
            }
            render();
            markDirty();
            return;
        }
    }

    function onChange(event) {
        const target = event.target;

        const member = target.getAttribute && target.getAttribute('data-member');
        if (member) {
            if (target.checked) state.excluded.delete(member);
            else state.excluded.add(member);

            if (state.excluded.size >= state.base.buildings.length) {
                // Refuse rather than let the dispatch 422 on an empty community.
                state.excluded.delete(member);
                target.checked = true;
                setStatus('A community needs at least one building.', 'error');
                return;
            }

            target.parentElement.classList.toggle('is-off', !target.checked);
            markDirty();
            return;
        }

        const toggle = target.getAttribute && target.getAttribute('data-toggle');
        const v2gIndex = target.getAttribute && target.getAttribute('data-cp-v2g');
        if (v2gIndex !== null && v2gIndex !== undefined) {
            const cp = chargePoints()[Number(v2gIndex)];
            if (cp) {
                // Both together: the backend rejects a car with V2G on behind
                // a charger without it.
                cp.is_v2g = target.checked;
                if (cp.ev) cp.ev.v2g_enabled = target.checked;
                markDirty();
            }
            return;
        }
        if (toggle === 'auto') {
            state.autoApply = target.checked;
            if (state.autoApply && state.dirty) scheduleApply();
            return;
        }
    }

    // ----------------------------------------------------------------- boot

    function isShowing() {
        const btn = document.querySelector('.control-btn[data-target="ecom-energy-btn"]');
        return btn && btn.classList.contains('active');
    }

    let loaded = false;

    async function load() {
        // Switching to another simulation and back wipes the legend column, so
        // reopening the panel has to redraw even though nothing needs fetching
        // a second time.
        if (loaded) { render(); return; }
        loaded = true;
        render();

        state.api = await findApi();
        if (state.api === null) {
            loaded = false;          // so Try again can look for it a second time
            render();
            return;
        }

        state.stale = !(await hasLayerRoute());
        if (state.stale) {
            loaded = false;
            render();
            return;
        }

        try {
            state.base = await getJson('/api/scenarios/' + SCENARIO);
        } catch (error) {
            state.api = null;
            loaded = false;
            render();
            return;
        }

        // The road the chargers stand on, for the position slider. Not awaited:
        // the panel opens on Members and the group is closed until someone asks
        // for it.
        loadStreet().then(function () {
            if (state.openGroup === 'mobility') render();
        });

        // Started here, not awaited: the panel is useful without them, but
        // waiting until after the opening dispatch meant a quick tap on the
        // Optimizer group arrived before the request had even been made.
        loadParams();

        state.working = clone(state.base);

        // Seed the picker from the scenario rather than a hardcoded June, so
        // the date shown is the date the table is actually about to dispatch.
        const period = state.base.analysis_period || {};
        state.startMonth = period.start_month || 6;
        state.startDay = period.start_day || 1;
        state.spanDays = Math.max(1, Math.min(14,
            dayOfYear(period.end_month || state.startMonth,
                      period.end_day || state.startDay) -
            dayOfYear(state.startMonth, state.startDay) + 1));
        applyPeriod();


        setStatus('Ready - dispatching the community…', 'busy');
        render();

        // One dispatch on open. Otherwise the KPI panel sits empty until
        // someone happens to move a control, which reads as "no KPIs" rather
        // than "not asked for any yet" - and the table is already showing this
        // very community, so it changes nothing on screen.
        applyNow();

        // Re-checked rather than probed once: the display can be opened, closed
        // or reloaded at any point while this panel sits there.
        if (pingTimer === null) {
            pingTimer = setInterval(function () {
                if (isShowing()) pingDisplay();
            }, 4000);
        }

        // Which years there is measured demand for. Late enough not to hold up
        // the panel, early enough that the picker is right before anyone
        // reaches for it.
        try {
            const payload = await getJson('/api/scenarios/' + SCENARIO + '/years');
            state.years = payload.years || [];
            if (payload.current) state.year = payload.current;
            const select = document.getElementById('ecom-year');
            if (select) select.innerHTML = yearOptions();
        } catch (error) { /* the picker keeps the scenario year only */ }

    }

    function attach() {
        // Both containers, since the controls are split across them now. Bound
        // to the containers rather than the controls: every render replaces
        // what is inside, so per-control listeners would not survive opening a
        // single group.
        // dashboard-content too: the view filters live in its Legend panel now.
        // Bound to the container, which is static markup, rather than to the
        // card - ecom-dashboard.js rebuilds that on every selection.
        ['legend-content', 'ecom-groups', 'dashboard-content'].forEach(function (id) {
            const host = document.getElementById(id);
            if (!host) return;
            host.addEventListener('input', onInput);
            host.addEventListener('change', onChange);
            host.addEventListener('click', onClick);
        });

        // On the document, not on the panel: the keys have to work wherever the
        // focus happens to be in this window.
        document.addEventListener('keydown', onStoryKey);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attach);
    } else {
        attach();
    }

    // The panel only builds itself once the ECOM layer is on, so switching to
    // another simulation does not pay for a scenario fetch nobody will read.
    channel.addEventListener('message', function (event) {
        const data = event.data || {};

        if (data.type === 'animation_state' &&
            data.animationId === 'ecom-energy-btn' &&
            data.isActive) {
            load();
        }

        // The layer was already up when the panel opened: it reports its own
        // totals, which is enough for the headline tiles before any Apply.
        // The layer has just come on at the table.
        if (data.type === 'animation_state' &&
            data.animationId === 'ecom-energy-btn' && data.isActive &&
            state.base) {
            offerStory();
        }

        if (data.type === 'ecom_summary' && data.summary && !state.layer) {
            const summary = data.summary;
            state.layer = {
                kpis: {
                    total_demand: summary.demandKwh,
                    total_pv_used: summary.solarKwh,
                    self_sufficiency: summary.selfSufficiency,
                    total_grid_import: summary.demandKwh - summary.localKwh
                },
                matched: summary.members,
                // Empty rather than missing, so anything reading the layer sees
                // the shape it expects and finds nothing in it.
                nodes: { features: [] },
                flows: { features: [] },
                meta: { period: summary.period, hours: summary.hours }
            };
            renderKpis();
        }

        // Kept here rather than in a card of its own: an empty "tap a building"
        // box sat in the panel whether or not anything had been tapped.
        if (data.type === 'ecom_selection' && data.building) {
            state.selection = data.building;
            renderKpis();
        }

        // A re-dispatched community: the selected building's numbers describe
        // the run before it, and it may not even be a member any more. Same
        // when the layer is switched off and there is nothing to have selected.
        if (data.type === 'ecom_layer' ||
            (data.type === 'animation_state' &&
             data.animationId === 'ecom-energy-btn' && !data.isActive)) {
            if (state.selection) {
                state.selection = null;
                renderKpis();
            }
        }

        // The table reports what its audio is actually doing, rather than the
        // button assuming the press worked - a browser can refuse to start it.
        if (data.type === 'ecom_sound_state') {
            state.sound = !!data.on;
            // Asked for but not actually running: the browser has suspended the
            // context, usually because the press happened on this screen and
            // the table's own window has had no gesture. Saying so beats a
            // button that claims sound nobody can hear.
            //
            // clockMoving === false is the same fault caught a different way -
            // a context that says "running" while its clock is frozen is not
            // producing anything either.
            const stalled = state.sound &&
                (data.running === false || data.clockMoving === false);
            state.soundReport = data;
            const btn = document.querySelector('.ecom-ctl-sound');
            if (btn) {
                btn.classList.toggle('is-on', state.sound && !stalled);
                btn.classList.toggle('is-stalled', stalled);
                const icon = btn.querySelector('.material-icons');
                if (icon) {
                    icon.textContent = stalled ? 'volume_off'
                        : (state.sound ? 'volume_up' : 'volume_off');
                }
                btn.title = stalled
                    ? 'The table is not playing: audio ' + (data.contextState || '?') +
                      ', clock ' + (data.clock || 0) + 's' +
                      (data.clockMoving === false ? ' (stopped)' : '') +
                      '. Click once on the display window itself - a browser ' +
                      'will not run audio for a page nobody has touched.'
                    : 'Play the community. Grid import sets how dense the pulses ' +
                      'are; self-sufficiency sets how calm the texture is.';
            }
            if (stalled) {
                setStatus('Sound is on, but the display window needs a click ' +
                          'before its browser will play audio.', 'error');
            }
            return;
        }

        if (data.type === 'ecom_pong') {
            state.link.up = true;
            state.link.active = !!data.active;
            state.link.at = Date.now();
            if (typeof data.hours === 'number') state.hours = data.hours;
            paintLink();
            // The usual order of events: the table is already running and the
            // panel is opened onto it. The introduction should start here too,
            // not only when the layer is switched on with the panel watching.
            if (state.link.active && state.base) offerStory();
        }

        // The display confirming it redrew. Reported instead of the dispatch
        // result, because "the backend answered" and "the table changed" are
        // different claims and only the second one is what was asked for.
        if (data.type === 'ecom_applied') {
            state.link.up = true;
            state.link.active = true;
            state.link.at = Date.now();
            // What the spinner was waiting for: the table has redrawn.
            setBusy(null);
            paintLink();
            setStatus('Table redrew: ' + data.flows + ' flows · ' + data.period, 'ok');
            channel.postMessage({ type: 'ecom_sound_request' });
        }

        // The layer being switched on or off changes what the chip should say.
        if (data.type === 'animation_state' &&
            data.animationId === 'ecom-energy-btn') {
            state.link.up = true;
            state.link.active = !!data.isActive;
            state.link.at = Date.now();
            paintLink();
        }

        // The table runs the day itself. The sky follows it rather than keeping
        // its own clock, so the sun over the panel and the flows on the table
        // are always the same hour.
        if (data.type === 'ecom_clock' && typeof data.hour === 'number') {
            state.hour = data.hour;
            state.hours = data.hours || state.hours;
            state.playing = true;
            state.link.up = true;
            state.link.active = true;
            state.link.at = Date.now();
            paintLink();
            const scrub = document.getElementById('ecom-hour');
            if (scrub) {
                scrub.max = Math.max(0, state.hours - 1);
                scrub.value = state.hour;
            }
            setPlayButton();
            paintSky();
        }
    });

    // ecom-dashboard.js owns the right-hand column and rebuilds it on every
    // selection, which replaces the slot these go in. It calls this afterwards.
    window.renderEcomKpis = renderKpis;
    window.renderEcomView = renderView;

    window.ecomControls = {
        load: load,
        render: render,
        apply: applyNow,
        state: state,
        isShowing: isShowing
    };
})();
