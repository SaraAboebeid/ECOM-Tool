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

    // state.year, not DATA_YEAR: the year picker can move off the scenario's
    // own year, and this date is what the sky card prints. Pinned to the
    // constant it showed "Sep 21, 2022" while the table was running 2023 -
    // wrong year, and a weekday to match.
    function isoDate(month, day) {
        return (state.year || DATA_YEAR) + '-' + pad(month) + '-' + pad(day);
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
    // Nothing is connected to anything until the last step. The entities are
    // introduced as objects on a campus - a building, a roof, a substation, a
    // store, a charger - and only then does energy start moving between them.
    // That is what makes the last step land: the community is not another
    // object to add, it is the lines appearing between the ones already there.
    //
    // One new entity per step and nothing is ever taken away, so the picture
    // accumulates instead of being replaced. The encodings arrive in order of
    // how hard they grab attention - colour, then lines, then a moving level,
    // then motion, then sound - because a car driving about and a transformer
    // buzzing from the first step means nobody hears the first three sentences.
    //
    // The clock is held still until the last step. Time moving and a new
    // entity appearing at once is where an audience loses the thread.
    /**
     * The hour at which one colour of line carries the most.
     *
     * A step that introduces a colour has to be shown at an hour when that
     * colour exists. Typed in by hand it goes stale: the red step was set to
     * seven in the evening, which reads right - a battery covering the evening
     * - and in this community the battery discharges at midnight and nowhere
     * else, so the step that introduces red had no red on it at all.
     *
     * Read off the dispatched layer instead, so it follows the data: resize
     * the battery or put panels on every roof and the step moves with it.
     */
    function busiestHour(kind, fallback) {
        // The introduction's own campus while it is running, not the panel's.
        const shown = storyLayer || state.layer;
        const flows = shown && shown.flows && shown.flows.features;
        if (!flows) return fallback;
        const total = [];
        flows.forEach(function (feature) {
            // By the node a line leaves: a building's shared solar is drawn
            // yellow but is still a building's line.
            const from = feature.properties.origin || feature.properties.kind;
            if (from !== kind) return;
            (feature.properties.flow_hourly || []).forEach(function (value, hour) {
                total[hour] = (total[hour] || 0) + (value || 0);
            });
        });
        let best = -1;
        let most = 0;
        total.forEach(function (value, hour) {
            if (value > most) { most = value; best = hour; }
        });
        return best >= 0 ? best : fallback;
    }

    const STORY = [
        {
            key: 'buildings',
            title: 'The buildings',
            // Counts are filled in from the scenario when the step is sent -
            // see storyText. They were typed in once, and went stale the day
            // AWL's measurements arrived and the community grew by one.
            line: '{members} buildings on campus, each with a year of measured ' +
                  'electricity behind it. This is the demand the community has ' +
                  'to cover.',
            figure: 'Members of the energy community',
            kinds: ['building'],
            pairs: [],
            hour: 12,
            // Every member alike, faded in together. Shading them by demand
            // here would answer a question nobody has asked yet, and answer it
            // badly: one hall dwarfs the rest, so thirty-one of the thirty-two
            // would come up nearly black on the very step that introduces them
            // as the community.
            uniform: true,
            reveal: 'buildings'
        },
        {
            key: 'solar',
            title: 'The roofs',
            // Arrays and roofs are counted separately: several roofs carry two
            // arrays, and an earlier wording that counted arrays as buildings
            // was contradicted by the table, where fewer footprints light up.
            line: '{arrays} arrays on {roofs} of the {members} roofs. Brightest at ' +
                  'midday, nothing at night - and never enough on its own.',
            figure: 'Generation, where it is made',
            kinds: ['building', 'pv'],
            pairs: [],
            hour: 12,
            uniform: true,
            reveal: 'solar'
        },
        {
            key: 'grid',
            title: 'The grid',
            line: 'The connection to everything outside the campus, at ' +
                  'Kraftcentralen. Today every building buys from it on ' +
                  'its own account.',
            figure: 'Where the electricity comes from today',
            kinds: ['building', 'pv', 'grid'],
            pairs: [],
            hour: 12,
            uniform: true
        },
        {
            key: 'battery',
            title: 'The battery',
            line: 'The battery already installed in AWL. It fills when there ' +
                  'is more sun than demand and empties again after dark.',
            figure: 'Shifting energy through the day',
            kinds: ['building', 'pv', 'grid', 'battery'],
            pairs: [],
            hour: 19,
            uniform: true
        },
        {
            key: 'charging',
            title: 'The charge point',
            line: 'A charger in the P-hus, where the cars on this campus ' +
                  'park. It draws in the evening and overnight, when the ' +
                  'roofs have nothing left to give.',
            figure: 'A new load, on a schedule',
            kinds: ['building', 'pv', 'grid', 'battery', 'charge_point'],
            pairs: [],
            hour: 20,
            uniform: true
        },
        {
            key: 'lines-grid',
            title: 'Teal: bought from the grid',
            // The lines have a grammar and nobody is told it. Three steps, one
            // colour each and only that colour - the previous one is taken
            // away before the next arrives, because two colours on the table
            // at once is a comparison, and this is a vocabulary.
            //
            // Teal first because it is the whole picture today: at this hour
            // every building draws from Kraftcentralen and nothing else.
            line: 'A teal line is electricity bought from outside. At this ' +
                  'hour it is every line on the table - the campus as it is ' +
                  'now, each building on its own account.',
            figure: 'Teal - from the grid',
            kinds: ['building', 'pv', 'grid', 'battery', 'charge_point'],
            pairs: ['grid>building', 'grid>charge_point'],
            hour: 'grid',
            fallbackHour: 20,
            flows: 'still',
            uniform: false
        },
        {
            key: 'lines-sharing',
            title: 'Yellow: solar shared between members',
            // Midday, because sharing needs sunshine to exist at all: at
            // nineteen hundred there is nothing to share.
            line: 'Yellow between buildings is solar being shared: a roof with ' +
                  'more than it needs supplying a neighbour, filling the ' +
                  'battery, or charging the car. This is what a community adds ' +
                  '- the teal lines were the campus without one.',
            figure: 'Yellow - solar shared inside the community',
            kinds: ['building', 'pv', 'grid', 'battery', 'charge_point'],
            pairs: ['building>building', 'building>battery',
                    'building>charge_point', 'building>grid'],
            // Only the solar in them: a building's line can carry the battery
            // too, and red has its own step next.
            carries: ['pv'],
            hour: 'building',
            fallbackHour: 12,
            flows: 'still',
            uniform: false
        },
        {
            key: 'lines-battery',
            title: 'Red: out of the battery',
            line: 'Red is the battery giving back what the roofs made today. ' +
                  'A few kilowatts against the grid\'s thousands, which is why ' +
                  'the line is drawn heavier than its share - it is small, and ' +
                  'it is the one thing on the table that moves energy through ' +
                  'time rather than across the campus.',
            figure: 'Red - out of the store. Press Finish to build your own.',
            kinds: ['building', 'pv', 'grid', 'battery', 'charge_point'],
            // From the battery itself, and the battery's share of what a
            // building passes on.
            pairs: ['battery>building', 'battery>charge_point',
                    'building>building', 'building>charge_point', 'building>grid'],
            carries: ['battery'],
            hour: 'battery',
            fallbackHour: 19,
            flows: 'still',
            uniform: false
        }
        // There used to be a ninth step, the whole community wired up and set
        // running. The introduction now ends on the last colour and hands the
        // table back empty: the point is for the room to build one themselves.
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
        peaks: [],            // busiest hour and day of each of those years
        noGeometry: [],       // scenario buildings with no outline on the table: not offered
        kpiDetails: false,    // the three detail columns under the KPI tiles, folded away
        paramInfo: {},        // optimizer constants whose explanation is open, by name
        profileMode: 'kw',    // load profiles in kW, or each as a share of its own peak
        profileView: 'profiles', // the card beside the parameters: 'profiles' or 'sharing'
        shareMode: 'period',     // the sharing graph: totals over the period, or this 'hour'
        profileFocus: null,   // the one building being followed on that chart
        // For a building that is not a member: whether the community rents its
        // roof ('community') or the panels are the building's own and sit
        // dormant ('own', the default - it changes no numbers).
        // Equipment of buildings outside the community that it rents, by kind and
        // building: 'pv:SB2', 'battery:AWL', 'charger:HC'. Absent is own use.
        rented: {},
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
        flash: null,          // the control keeping time with a change on the table
        layer: null,          // the last layer dispatched, for the hourly PV readout
        openGroup: 'members',
        status: 'Looking for the backend…',
        statusKind: 'idle',
        busy: false,
        dirty: false,
        autoApply: true,
        live: null,            // the real battery's last reading
        optimizer: null,       // last optimizer run, or an in-flight job
        optimizerSpan: 'day',  // how much of the year to solve
        optimizerMode: 'both', // community | separate | both
        // Re-solve whenever something changes, and show the answer against the
        // one before the change. Off, the optimizer runs only when asked.
        autoOptimize: true,
        spotByYear: {},        // hourly SE3 spot prices by year, SEK/kWh
        spotHover: null,       // the hour under the pointer on the spot chart
        optimizerPrevious: null, // the last complete set of results, before this run
        optimizerResults: {},  // finished runs by mode, for the display
        optimizerRunning: '',  // the mode being solved right now
        optimizerStartedAt: 0  // when the run began, for the clock while it waits
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

    // --------------------------------------------- what a building owns
    //
    // A building's own battery and its own chargers, told apart from the
    // community's by their host. Community storage has none - that is what
    // makes it the community's - and a community charger likewise.

    /** Coverage given to a roof added from the Members list. */
    const ADDED_ROOF_COVERAGE = 40;

    /** Capacity of a battery added from the Members list, kWh. */
    const ADDED_BATTERY_KWH = 50;

    /** Power of the first charger added to a building, kW. */
    const ADDED_CHARGER_KW = 22;

    /** The most chargers one building will be given from the panel. */
    const MAX_CHARGERS_PER_BUILDING = 8;

    function ownBattery(name) {
        return (state.working.batteries || []).find(function (b) {
            return b.attached && sameBuilding(b.host, name);
        }) || null;
    }

    function ownChargers(name) {
        return (state.working.charge_points || []).filter(function (cp) {
            return sameBuilding(cp.host, name);
        });
    }

    // The same two spellings the backend reconciles. The Rhino layer for the
    // electrical engineering building was named "Elkrafteknik" and never
    // corrected, and the footprint file inherited it.
    const NAME_ALIASES = { elkrafteknik: 'elkraftteknik', bibiotek: 'bibliotek' };

    /** A building's name reduced to what is the same in every spelling of it.
     *
     * Accents come off before anything else is dropped: "Idélära" has to meet
     * the footprint "idealara", and stripping everything that is not a-z first
     * leaves "idlra", which meets nothing. That is what silently refused a
     * charger on four buildings - Idélära, Kårhus entré, Kårresturangen and
     * Elkraftteknik - with a message about there being no room, when the real
     * fault was that their outline was never found.
     *
     * Mirrors canonical() in services/mr_layer.py, which is what decides which
     * footprint a member is drawn on: this has to agree with it, or the panel
     * and the table disagree about which building is which.
     */
    function canonicalName(value) {
        const folded = String(value == null ? '' : value).normalize('NFKD')
            .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return NAME_ALIASES[folded] || folded;
    }

    /** Footprint ids and building names are spelled differently; match them. */
    function sameBuilding(a, b) {
        return !!a && !!b && canonicalName(a) === canonicalName(b);
    }

    /** Resize a building's panels, battery or charger. */
    function setKitSize(kind, name, value) {
        if (kind === 'pv') {
            setRoofCoverage(name, value);
            return;
        }
        if (kind === 'battery') {
            const mine = ownBattery(name);
            // Zero is not a battery: the backend wants a positive capacity, so
            // dragging to the bottom takes it out rather than leaving a battery
            // that holds nothing.
            if (!mine) return;
            if (value <= 0) {
                state.working.batteries = (state.working.batteries || [])
                    .filter(function (b) { return b !== mine; });
                render();
                return;
            }
            mine.capacity = value;
            return;
        }
        if (kind === 'charger') {
            ownChargers(name).forEach(function (cp) { cp.capacity = Math.max(3, value); });
        }
    }

    /** Add or remove one piece of kit on one building.
     *
     * A toggle rather than an add button, because the question at the table is
     * "does this building have solar?" and the answer should be reversible by
     * pressing the same thing again.
     */
    async function toggleKit(kind, name) {
        if (kind === 'pv') {
            setRoofCoverage(name,
                roofCoverage(name) > 0 ? 0 : ADDED_ROOF_COVERAGE);
            render();
            markDirty();
            return;
        }

        if (kind === 'battery') {
            const mine = ownBattery(name);
            state.working.batteries = state.working.batteries || [];
            if (mine) {
                state.working.batteries = state.working.batteries
                    .filter(function (b) { return b !== mine; });
            } else {
                state.working.batteries.push({
                    name: name + ' battery',
                    capacity: ADDED_BATTERY_KWH,
                    // The campus rate, same as the community unit.
                    c_rate: 0.25,
                    efficiency: 90.0,
                    initial_soc_fraction: 0.5,
                    host: name,
                    // What makes it this building's rather than a community
                    // battery that happens to stand in it.
                    attached: true
                });
            }
            render();
            markDirty();
            return;
        }

        if (kind === 'charger') {
            // The chip is on/off for the building's chargers as a whole: off
            // takes every one of them away. One at a time is the stepper's job.
            const mine = ownChargers(name);
            if (mine.length) {
                const drop = new Set(mine);
                state.working.charge_points = (state.working.charge_points || [])
                    .filter(function (cp) { return !drop.has(cp); });
                render();
                markDirty();
                return;
            }
            await addCharger(name);
        }
    }

    /** One more charger outside this building.
     *
     * A building can have several; each is placed away from the ones already
     * standing, so a second does not land on the first. The new one copies the
     * power of the building's existing chargers, so "add another" gives another
     * of the same rather than snapping back to a default.
     */
    async function addCharger(name) {
        state.working.charge_points = state.working.charge_points || [];
        const existing = ownChargers(name);
        if (existing.length >= MAX_CHARGERS_PER_BUILDING) {
            setStatus(name + ' already has ' + existing.length + ' chargers - that ' +
                      'is as many as the panel will add to one building.', 'error');
            return;
        }

        // Outside the building and clear of its neighbours. Worked out before
        // anything is added, so a building with nowhere to put one says so
        // rather than dropping a marker in a wall - and says WHICH of the two
        // it is, because "no room" and "no outline" need different fixes.
        let spot = null;
        try {
            const footprintsById = await loadFootprints();
            const found = Object.keys(footprintsById).some(function (id) {
                return sameBuilding(id, name);
            });
            if (!found) {
                setStatus('The table has no outline for ' + name + ', so there is ' +
                          'nowhere to stand a charger.', 'error');
                return;
            }
            const taken = state.working.charge_points
                .filter(function (cp) { return cp.lon != null && cp.lat != null; })
                .map(function (cp) { return [cp.lon, cp.lat]; });
            spot = await outsideSpot(name, taken);
        } catch (error) {
            setStatus('Could not read the footprints: ' + error.message, 'error');
            return;
        }
        if (!spot) {
            setStatus('No room outside ' + name + ' for another charger clear of ' +
                      'its neighbours.', 'error');
            return;
        }

        // Numbered, never reused while one stands: names are node ids in the
        // dispatch, and two chargers with one name would be one node.
        const taken = new Set(state.working.charge_points.map(function (cp) {
            return cp.name;
        }));
        let n = existing.length + 1;
        while (taken.has(name + ' CP ' + n)) n += 1;

        state.working.charge_points.push({
            name: name + ' CP ' + n,
            capacity: existing.length ? existing[0].capacity : ADDED_CHARGER_KW,
            charger_type: 'AC Level 2',
            owner: 'Akademiska Hus',
            host: name,
            lon: spot[0],
            lat: spot[1],
            // A vehicle per charger: the toolkit computes demand for exactly one,
            // so a charger without it draws nothing at all. Plugged in from the
            // evening to the morning, the way the campus charger already is -
            // with the backend's defaults it was a 3.7 kW car driving 35 km a
            // day, which is eleven kilowatt-hours over two days: a charger that
            // is there and does nothing.
            ev: {
                name: name + ' EV ' + n,
                capacity: 60,
                max_charging_power: 11,
                daily_distance: 40,
                v2g_enabled: false,
                availability: plugSchedule(DEFAULT_PLUG.arrival, DEFAULT_PLUG.departure)
            }
        });
        render();
        markDirty();
    }

    /** Take one charger away from a building: the newest. */
    function removeCharger(name) {
        const mine = ownChargers(name);
        if (!mine.length) return;
        const last = mine[mine.length - 1];
        state.working.charge_points = (state.working.charge_points || [])
            .filter(function (cp) { return cp !== last; });
        render();
        markDirty();
    }

    /** Take out the buildings the table has no outline for.
     *
     * A member with no footprint is dispatched and counted in every total and
     * then drawn nowhere: it adds demand to the community that nobody at the
     * table can see, and it can be ticked in without anything on the display
     * changing. So it is not offered. The backend says which buildings those
     * are, using the same test the layer builder joins on, so this list and the
     * table cannot disagree about who can be a member.
     *
     * Removed from the base definition itself, not just from the list, so they
     * are in no total, no roof count, no colour index and no dispatch. Roof
     * arrays named only by a removed building go with it: left behind, an
     * unattached plant is promoted to community PV and would keep generating
     * for a building that is not there.
     *
     * An older backend has no such endpoint; then everyone is offered, as
     * before, rather than the panel failing to open.
     */
    async function restrictToGeometry() {
        state.noGeometry = [];
        let geo;
        try {
            geo = await getJson('/api/scenarios/' + SCENARIO + '/geometry');
        } catch (error) {
            return;
        }
        const keep = new Set(geo.with_geometry || []);
        const dropped = (state.base.buildings || []).filter(function (b) {
            return !keep.has(b.name);
        });
        if (!dropped.length) return;

        const gone = new Set(dropped.map(function (b) { return b.name; }));
        const orphaned = new Set();
        dropped.forEach(function (b) {
            (b.pv_plants || []).forEach(function (name) { orphaned.add(name); });
        });

        state.base.buildings = state.base.buildings.filter(function (b) {
            return !gone.has(b.name);
        });
        state.base.pv_plants = (state.base.pv_plants || []).filter(function (p) {
            return !orphaned.has(p.name);
        });
        state.noGeometry = dropped.map(function (b) { return b.name; });
    }

    /** How many buildings are actually in the community. */
    function memberCount() {
        if (!state.base || !state.base.buildings) return 0;
        return state.base.buildings.length - state.excluded.size;
    }

    /**
     * Whether a building outside the community rents its equipment to it.
     *
     * By default a building that is not ticked keeps its panels, battery and
     * chargers for its own use: they serve that building, which is not part of
     * the community, so they are not in its dispatch. The OWN USE / RENTED
     * badge on its row rents them to the community instead ('community'): they
     * then feed the members and are drawn on that building, panels with their
     * halo. A member's equipment is always its own and always in.
     */
    function sharesAssets(name, kind) {
        return !!state.rented[kind + ':' + name];
    }

    /**
     * OWN USE / RENTED for one kind of equipment on a building outside the
     * community. Own use: it serves the building, which is not a member, so the
     * community does not have it. Rented: the community uses it and the table
     * draws it on the building.
     */
    function ownerBadge(name, kind, label, noun) {
        const rented = sharesAssets(name, kind);
        // A two-sided switch, both choices always visible, the one in force lit:
        // a single tag read as a status, and nobody guessed it could be tapped.
        const side = function (value, text, on, title) {
            return '<button type="button" class="ecom-owner-side' + (on ? ' is-on' : '') +
                (value === 'rented' ? ' is-rented' : ' is-own') + '"' +
                ' data-roofowner="' + esc(name) + '" data-owner-kind="' + kind + '"' +
                ' data-owner-set="' + value + '" aria-pressed="' + on + '"' +
                ' title="' + esc(title) + '">' + esc(text) + '</button>';
        };
        return '<span class="ecom-owner-switch is-' + kind + '" role="group"' +
                ' aria-label="' + esc(label) + ': own use or rented">' +
            '<span class="ecom-owner-kind">' + esc(label) + '</span>' +
            side('own', 'Own use', !rented,
                 'The ' + noun + ' serve this building only. It is not in the ' +
                 'community, so they do not count in the KPIs or the optimization.') +
            side('rented', 'Rented', rented,
                 'The community rents the ' + noun + ': they feed the members, ' +
                 'count in the KPIs and the optimization, and their lines are drawn.') +
        '</span>';
    }

    /** The definition to dispatch: the working copy minus excluded members. */
    function buildSpec() {
        const spec = clone(state.working);

        if (state.excluded.size) {
            // Which non-members' roofs the community uses, and which keep
            // their panels to themselves. A shared array stays in the spec
            // attached to nobody, which is how the builder recognises a
            // community plant, and carries a host so the table still draws it
            // on the right roof. A dormant one leaves with its building.
            const rented = new Set();
            const dormant = new Set();
            spec.buildings.forEach(function (b) {
                if (!state.excluded.has(b.name)) return;
                const names = b.pv_plants || [];
                if (!names.length) return;
                const target = sharesAssets(b.name, 'pv') ? rented : dormant;
                names.forEach(function (name) { target.add(name); });
            });

            const hostOf = {};
            spec.buildings.forEach(function (b) {
                (b.pv_plants || []).forEach(function (name) {
                    if (rented.has(name)) hostOf[name] = b.name;
                });
            });

            spec.buildings = spec.buildings.filter(function (b) {
                return !state.excluded.has(b.name);
            });

            const kept = new Set();
            spec.buildings.forEach(function (b) {
                (b.pv_plants || []).forEach(function (name) { kept.add(name); });
            });
            spec.pv_plants = (spec.pv_plants || []).filter(function (p) {
                return kept.has(p.name) || rented.has(p.name);
            }).map(function (p) {
                // Named by no building any more, so it needs to say where it is.
                if (rented.has(p.name) && hostOf[p.name]) {
                    p.host = hostOf[p.name];
                }
                return p;
            });

            // A battery in a building outside the community: shared, it becomes
            // a store the community uses - unattached, which is what makes it
            // everyone's - still drawn in its building by its host. Dormant, it
            // leaves with the building. Community storage stays regardless.
            spec.batteries = (spec.batteries || []).filter(function (b) {
                return !(b.attached && b.host && state.excluded.has(b.host) &&
                         !sharesAssets(b.host, 'battery'));
            }).map(function (b) {
                if (b.attached && b.host && state.excluded.has(b.host)) b.attached = false;
                return b;
            });
            // Chargers the same: shared, they stay and the community supplies
            // them; dormant, they go with the building.
            spec.charge_points = (spec.charge_points || []).filter(function (cp) {
                return !(cp.host && state.excluded.has(cp.host) && !sharesAssets(cp.host, 'charger'));
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

    // Where a charge point can go: in the P-hus, the campus parking house.
    //
    // It used to be a stretch of Gibraltarvallsvägen, on the reasoning that a
    // charger belongs on a road. It belongs in the car park: that is where the
    // cars on this campus stand long enough to charge, and it is where CP was
    // put. A new charger appearing on the old street read as the table undoing
    // the move.
    //
    // Read out of the footprints the table itself draws rather than a list of
    // coordinates typed in here, so the bays follow the building. A position
    // along the building is one number, which is a far easier thing to set on a
    // touch screen than a pair of decimals.
    const CP_PLACE = 'the P-hus';
    const CP_PLACE_ID = 'p-hus';
    const FOOTPRINTS_URL = 'media/ecom/ecom-buildings.geojson';

    // Bays inside the building, ordered along its length. Kept this far from
    // its walls, because the marker is drawn with a glow several times its own
    // size and one on the edge reads as standing in the street outside.
    const BAY_CLEARANCE_M = 8;

    let bays = null;                // [[lon, lat], ...] one end of the house to the other
    let footprints = null;          // every campus footprint, by id

    // How far outside its own wall a charger stands, and how far it has to stay
    // from anybody else's. The first is a pavement's width - close enough to
    // read as this building's. The second is what keeps the marker, which is
    // drawn with a glow several times its own size, from sitting on top of the
    // neighbour it is not plugged into.
    const CHARGER_STANDOFF_M = 12;
    const CHARGER_NEIGHBOUR_M = 14;

    function ringsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(function (part) { return part[0]; });
        }
        return [];
    }

    function insideRing(point, ring) {
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if (((yi > point[1]) !== (yj > point[1])) &&
                (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi)) hit = !hit;
        }
        return hit;
    }

    // Longitude degrees are shorter than latitude ones; at this latitude by
    // this much. Enough for distances across one building.
    const LON_SCALE = 0.5351;
    const M_PER_DEG = 111320;

    function metresFromWalls(point, ring) {
        let near = Infinity;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            const dx = (b[0] - a[0]) * LON_SCALE, dy = b[1] - a[1];
            const px = (point[0] - a[0]) * LON_SCALE, py = point[1] - a[1];
            const t = Math.max(0, Math.min(1,
                (px * dx + py * dy) / (dx * dx + dy * dy || 1e-12)));
            near = Math.min(near, Math.hypot(px - t * dx, py - t * dy));
        }
        return near * M_PER_DEG;
    }

    /** Every campus footprint, keyed by its id. Fetched once. */
    async function loadFootprints() {
        if (footprints) return footprints;
        const response = await fetch(FOOTPRINTS_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(FOOTPRINTS_URL + ': ' + response.status);
        const data = await response.json();
        footprints = {};
        (data.features || []).forEach(function (feature) {
            const id = (feature.properties || {}).id;
            if (!id) return;
            const rings = ringsOf(feature.geometry);
            if (rings.length) footprints[id] = rings;
        });
        return footprints;
    }

    /** Somewhere outside this building to stand a charger.
     *
     * A charger is not in the building, it is against it - so the candidates
     * are points a pavement's width out from each wall, and the one chosen is
     * the one with the most room around it. Any candidate that lands inside
     * another building, or too close to one, is discarded rather than nudged:
     * a charger drawn through a neighbour's wall is worse than one on the far
     * side of its own.
     *
     * Returns [lon, lat], or null when the building has no footprint we know
     * or every side of it is blocked.
     */
    async function outsideSpot(buildingName, taken) {
        const all = await loadFootprints();
        const key = Object.keys(all).find(function (id) {
            return sameBuilding(id, buildingName);
        });
        if (!key) return null;

        // Comfortable clearances first, then tighter ones. A building hemmed in
        // by its neighbours - Edit is the one on this campus - has no wall with
        // twelve metres of pavement and fourteen of daylight around it, and
        // refusing to give it a charger is a worse answer than giving it a
        // close one. The first fit wins, so nothing is cramped unnecessarily.
        for (const [standoff, clearance] of [[CHARGER_STANDOFF_M, CHARGER_NEIGHBOUR_M],
                                             [9, 10], [7, 7], [5, 4]]) {
            const spot = spotAround(all, key, standoff, clearance, taken);
            if (spot) return spot;
        }
        return null;
    }

    /** One pass of the search, at a given standoff and neighbour clearance. */
    function spotAround(all, key, standoff, clearance, taken) {
        const mine = all[key].slice().sort(function (a, b) {
            return b.length - a.length;
        })[0];
        const others = Object.keys(all).filter(function (id) { return id !== key; })
            .reduce(function (list, id) { return list.concat(all[id]); }, []);

        let best = null;
        let bestRoom = -Infinity;

        for (let i = 0, j = mine.length - 1; i < mine.length; j = i++) {
            const a = mine[j];
            const b = mine[i];
            const dx = (b[0] - a[0]) * LON_SCALE;
            const dy = b[1] - a[1];
            const len = Math.hypot(dx, dy);
            if (len <= 0) continue;

            // Three points along each wall rather than only its middle. With one
            // candidate per wall a four-walled building ran out of places after
            // four chargers and the fifth went on top of one of them; the
            // middle comes first in the list so a lone charger still sits where
            // it always did.
            for (const along of WALL_POINTS) {
                const mx = a[0] + (b[0] - a[0]) * along;
                const my = a[1] + (b[1] - a[1]) * along;

                // The outward normal to the wall. Which of the two normals
                // points out is decided by testing one of them.
                const step = standoff / M_PER_DEG;
                let nx = (dy / len) * step / LON_SCALE;
                let ny = (-dx / len) * step;
                if (insideRing([mx + nx, my + ny], mine)) { nx = -nx; ny = -ny; }

                const spot = [mx + nx, my + ny];
                if (insideRing(spot, mine)) continue;

                // Room: how far the nearest other building is, and how far the
                // nearest charger already placed. Both matter, so take the worse.
                let room = Infinity;
                for (const ring of others) {
                    if (insideRing(spot, ring)) { room = -1; break; }
                    room = Math.min(room, metresFromWalls(spot, ring));
                }
                if (room < clearance) continue;

                (taken || []).forEach(function (other) {
                    const ddx = (spot[0] - other[0]) * LON_SCALE;
                    const ddy = spot[1] - other[1];
                    room = Math.min(room, Math.hypot(ddx, ddy) * M_PER_DEG);
                });

                // Strictly better, so a tie keeps the earlier candidate: the
                // middle of the first wall, as before.
                if (room > bestRoom) {
                    bestRoom = room;
                    best = spot;
                }
            }
        }
        return best;
    }

    // Where along a wall a charger may stand, as a fraction of its length.
    const WALL_POINTS = [0.5, 0.25, 0.75];

    async function loadBays() {
        if (bays) return bays;
        try {
            const response = await fetch(FOOTPRINTS_URL, { cache: 'no-store' });
            if (!response.ok) throw new Error(FOOTPRINTS_URL + ': ' + response.status);
            const data = await response.json();
            const house = (data.features || []).find(function (feature) {
                return (feature.properties || {}).id === CP_PLACE_ID;
            });
            const ring = ringsOf(house && house.geometry).sort(function (a, b) {
                return b.length - a.length;
            })[0];
            if (!ring) throw new Error('no ' + CP_PLACE_ID + ' footprint');

            // The building's own length: the two corners furthest apart.
            let axis = null;
            ring.forEach(function (a) {
                ring.forEach(function (b) {
                    const dx = (b[0] - a[0]) * LON_SCALE, dy = b[1] - a[1];
                    const span = dx * dx + dy * dy;
                    if (!axis || span > axis.span) axis = { a: a, b: b, span: span };
                });
            });

            const xs = ring.map(function (p) { return p[0]; });
            const ys = ring.map(function (p) { return p[1]; });
            const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
            const y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
            const found = [];
            for (let i = 0; i <= 40; i += 1) {
                for (let j = 0; j <= 40; j += 1) {
                    const point = [x0 + (x1 - x0) * i / 40, y0 + (y1 - y0) * j / 40];
                    if (!insideRing(point, ring)) continue;
                    if (metresFromWalls(point, ring) < BAY_CLEARANCE_M) continue;
                    // Where it falls along the building's length, so the slider
                    // runs end to end rather than across the grid's rows.
                    const dx = (axis.b[0] - axis.a[0]) * LON_SCALE, dy = axis.b[1] - axis.a[1];
                    const px = (point[0] - axis.a[0]) * LON_SCALE, py = point[1] - axis.a[1];
                    found.push({ point: point, at: (px * dx + py * dy) / (axis.span || 1e-12) });
                }
            }
            found.sort(function (a, b) { return a.at - b.at; });
            bays = found.length ? found.map(function (f) { return f.point; }) : null;
        } catch (error) {
            bays = null;
        }
        return bays;
    }

    /** A bay some fraction of the way along the building, 0 to 1. */
    function alongHouse(fraction) {
        if (!bays || !bays.length) return null;
        const at = Math.max(0, Math.min(1, fraction));
        const index = Math.round(at * (bays.length - 1));
        return bays[index];
    }

    /**
     * Space the chargers out along the car park, as evenly as it allows.
     *
     * Called with the new one already in the list. The building is about
     * seventy metres long, so three chargers put one at each end and one in the
     * middle; picking a free spot for the new one alone left the third twenty
     * metres from the first, which at table scale is one blur of two markers.
     * Positions set by hand on the slider are overwritten - a charger being
     * added is the moment to lay them out again.
     */
    function spaceOut(points) {
        if (!bays || !bays.length) return;
        const n = points.length;
        points.forEach(function (cp, index) {
            const spot = alongHouse(n === 1 ? 0.5 : index / (n - 1));
            if (spot) { cp.lon = spot[0]; cp.lat = spot[1]; }
        });
    }

    /** How far along the building a charge point currently stands. */
    function housePosition(cp) {
        if (!bays || cp.lat == null) return 0.5;
        let best = 0;
        let bestGap = Infinity;
        bays.forEach(function (point, index) {
            const gap = Math.abs(point[1] - cp.lat) + Math.abs(point[0] - cp.lon);
            if (gap < bestGap) { bestGap = gap; best = index; }
        });
        return bays.length > 1 ? best / (bays.length - 1) : 0.5;
    }

    function chargePoints() {
        return (state.working || {}).charge_points || [];
    }

    /** A charger like the ones already there, on a free stretch of the street. */
    function addChargePoint() {
        const points = chargePoints();
        const template = points[0];

        let name = 'CP ' + (points.length + 1);
        const taken = new Set(points.map(function (cp) { return cp.name; }));
        let n = points.length + 1;
        while (taken.has(name)) { n += 1; name = 'CP ' + n; }

        const spot = alongHouse(0.5) || [null, null];

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
                    : plugSchedule(DEFAULT_PLUG.arrival, DEFAULT_PLUG.departure)
            }
        };
        if (spot[0] != null) { cp.lon = spot[0]; cp.lat = spot[1]; }

        state.working.charge_points = points.concat([cp]);
        spaceOut(state.working.charge_points);
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

        // The spot price goes with the demand: 2023's buildings are priced at
        // 2023's spot. Only while the import price is on spot - a fixed price
        // is somebody's choice and stays.
        const grid = state.working.grid;
        const prices = state.spotByYear[year];
        if (grid && grid.buying_price && Array.isArray(grid.buying_price.hourly) && prices) {
            grid.buying_price = { hourly: prices.slice() };
        }
    }

    // Tolerates a missing spec: the table can announce its own totals before
    // the panel's scenario fetch has landed, and renderKpis reads this to fill
    // the "Settings on this run" column. Without the guard that announcement
    // threw and the headline tiles it carries never appeared.
    /** The community's own store: the battery that belongs to no building.
     *
     * Buildings can hold batteries of their own now, and those sit in the same
     * list. Taking the first one would hand the Storage group whichever
     * battery happened to be added first and let its sliders resize a
     * building's private asset.
     */
    function battery() {
        return ((state.working || {}).batteries || []).find(function (b) {
            return !b.attached;
        }) || null;
    }

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
    // Something changed while a dispatch was running. It is sent when that one
    // lands, as a single follow-up carrying everything touched in the meantime.
    let applyPending = false;
    // Whoever asked for those changes, waiting for the follow-up to land - so
    // "await apply()" still means "until my change is on the table", queued or
    // not, rather than returning the moment it was put in the queue.
    let pendingWaiters = [];

    function markDirty() {
        // Someone is building a community: the introduction gives way. It starts
        // by itself when the page loads and can take a while to prepare, and
        // arriving at step one over a community already being built - members
        // ticked, panels added - took the table away from the person using it.
        if (storyLoading) storySkipRequested = true;
        if (state.story >= 0) {
            state.story = -1;
            storyLayer = null;
            storySpec = null;
            channel.postMessage({ type: 'ecom_caption', caption: null });
            channel.postMessage({ type: 'ecom_uniform', on: false });
            channel.postMessage({ type: 'ecom_flows', mode: 'running' });
            pushFilters();
            channel.postMessage({ type: 'ecom_release' });
            render();
        }
        state.dirty = true;
        renderKpis();       // dims them, rather than leaving last run looking live
        paintProfiles();    // and so does the load-profile chart
        if (state.autoApply) {
            // Straight away, not when the debounce fires: the wait starts at
            // the touch, and that is what it should acknowledge.
            setBusy('Updating…');
            scheduleApply();
        } else {
            setStatus('Edited - press Apply.', 'idle');
        }
        scheduleOptimize();
    }

    // How long to wait after the last change before solving. A slider drag is
    // dozens of changes a second and each solve is seconds long; this lets go of
    // it first, and runOptimizer drops the answer of any run that a newer one
    // has overtaken.
    const AUTO_OPTIMIZE_DEBOUNCE_MS = 1800;
    let optimizeTimer = null;

    function scheduleOptimize() {
        if (!state.autoOptimize || state.api === null || state.api === undefined) return;
        // Not while the introduction is on the table: a solve in the middle of
        // it would hold the room's picture up for something they did not ask for.
        if (state.story >= 0) return;
        if (optimizeTimer !== null) clearTimeout(optimizeTimer);
        optimizeTimer = setTimeout(function () {
            optimizeTimer = null;
            // Nobody in the community is nothing to optimise.
            if (!memberCount() || state.story >= 0) return;
            runOptimizer();
        }, AUTO_OPTIMIZE_DEBOUNCE_MS);
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

        // An empty community has nothing to dispatch. The backend refuses it
        // outright - every KPI would be zero - so the table is cleared here
        // instead, which is also what the panel shows on the way in.
        if (!memberCount()) {
            if (applyTimer !== null) {
                clearTimeout(applyTimer);
                applyTimer = null;
            }
            state.layer = null;
            state.dirty = false;
            finishBusy();
            channel.postMessage({ type: 'ecom_empty' });
            setStatus('No members yet - tick a building to start.', 'idle');
            render();
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

        // One dispatch at a time, and a running one is never cancelled.
        //
        // It used to be: a new change aborted the dispatch in flight, so requests
        // could not land out of order. But a dispatch takes about eight seconds,
        // and a person does not wait eight seconds between touches - so most
        // changes were cancelled before they landed. Two things followed. A
        // charge point was announced, its marker landed and held, and the layer
        // that would have drawn it never came: the marker timed out and the icon
        // vanished. And the next change was described against the last one that
        // HAD landed, so a grid price moved after an unfinished battery change
        // was announced as "A bigger battery".
        //
        // Now the change waits its turn. Order is still guaranteed - there is
        // never more than one request out - and everything touched meanwhile
        // goes in one follow-up, described against what the table then shows.
        if (inFlight) {
            applyPending = true;
            setStatus('Queued - the table catches up when this one lands…', 'busy');
            return new Promise(function (resolve) { pendingWaiters.push(resolve); });
        }
        const controller = new AbortController();
        inFlight = controller;

        state.busy = true;
        setBusy('Dispatching…');
        setStatus('Dispatching…', 'busy');

        const spec = buildSpec();
        // Announced first, and deliberately not awaited: the announce beat is
        // what the dispatch round trip happens inside, so the new layer lands
        // during the animation instead of arriving after it as a jump.
        const changing = describeChange(spec);
        // Said here, beside the spinner, for every change - the table only
        // shows it. A change with no place on the map is not sent at all.
        panelChange = changing || null;
        if (changing) {
            setBusy(changing.title, changing.line);
            if (!changing.onPanel) {
                channel.postMessage({ type: 'ecom_change', change: changing });
            }
            flashControl(changing);
        }

        try {
            // baseline=true: the backend also dispatches the same buildings with
            // no community, so the KPIs can be shown against what the members
            // would have managed apart. It is a second dispatch - the whole
            // request takes about twice as long - and what the performance strip
            // is for.
            const layer = await postJson('/api/mr/layer?baseline=true', spec,
                                         controller.signal);
            if (controller.signal.aborted) return;
            channel.postMessage({ type: 'ecom_layer', layer: layer });
            const outcome = changing ? outcomeLine(layer) : null;
            if (changing && !changing.onPanel) reportOutcome(layer);
            lastApplied = clone(spec);
            lastKpis = layer.kpis;
            // The backend is done; the table is not. Keep waiting.
            awaitDraw(outcome);
            state.dirty = false;

            // A shorter span can leave the hour past the end of the new day.
            state.layer = layer;
            state.hours = layer.meta.hours || state.hours;
            // A day to run now exists; with no display linked, run it here.
            syncLocalClock();
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
            // The chart for the same reason: it reads the same flags, and it is
            // where a newly ticked building's line finally appears.
            paintProfiles();
            // What was touched while this ran, now that it has landed.
            if (applyPending && inFlight === null) {
                applyPending = false;
                const waiters = pendingWaiters;
                pendingWaiters = [];
                setTimeout(function () {
                    applyNow().then(function () {
                        waiters.forEach(function (resolve) { resolve(); });
                    });
                }, 0);
            }
        }
    }

    function resetAll() {
        state.working = clone(state.base);
        // The scenario comes back in its own year - its demand files and its
        // spot prices - while the picker may be on another. Put the picker's
        // year back on it, or a reset on 2023 quietly ran 2022.
        const shownYear = state.year;
        const fileYear = (state.working.buildings || []).map(function (b) {
            const m = ((b.demand || {}).csv_path || '').match(/_(\d{4})\.csv$/);
            return m ? Number(m[1]) : null;
        }).filter(Boolean)[0];
        if (fileYear && fileYear !== shownYear) {
            state.year = fileYear;
            setYear(shownYear);
        }
        // Reset is itself a change, and the next Apply should describe the
        // difference from what the table is showing - not from the scenario
        // it happens to be returning to.
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

    /**
     * A step's words with the community's own numbers in them.
     *
     * Members are the buildings the table actually colours - the layer's
     * match count - not every building in the definition: four of those have
     * a demand and no footprint, and a figure the table cannot show is a
     * figure the room can check against the table and find wrong.
     */
    function storyText(text) {
        if (!text) return text;
        // While the introduction runs, its own example campus: those are the
        // roofs and arrays the table is showing.
        const base = storySpec || state.base || {};
        const buildings = base.buildings || [];
        const shown = storyLayer || state.layer;
        const members = (shown && shown.matched) || buildings.length;
        const roofs = buildings.filter(function (b) {
            return (b.pv_plants || []).length > 0;
        }).length;
        const arrays = (base.pv_plants || []).length;
        return String(text)
            .replace(/\{members\}/g, members)
            .replace(/\{roofs\}/g, roofs)
            .replace(/\{arrays\}/g, arrays);
    }

    // The whole campus, dispatched for the introduction alone. The panel's own
    // community is not touched: it opens empty and stays empty, because building
    // it up is the room's to do once the introduction has shown what there is.
    let storyLayer = null;
    let storySpec = null;
    let storyLoading = false;

    // The introduction is an example, not the campus as measured. With only
    // the panels that are really there (SB2's), there is almost no surplus at
    // midday and the pink step - the one that shows what a community adds -
    // had next to nothing on it. So the example puts panels on every roof that
    // has none, at the same share of the roof the Members list gives one, and
    // keeps the measured arrays as they are.
    const STORY_ROOF_COVERAGE = ADDED_ROOF_COVERAGE;

    /** The campus the introduction shows: everyone in, panels on every roof. */
    function storyExampleSpec() {
        const keptWorking = state.working;
        const keptExcluded = state.excluded;
        state.working = clone(keptWorking);
        state.excluded = new Set();
        try {
            (state.working.buildings || []).forEach(function (b) {
                if (!roofPlants(b.name).length) setRoofCoverage(b.name, STORY_ROOF_COVERAGE);
            });
            // The campus has no chargers until someone adds one, but the
            // introduction has a step for the charge point: the example gets
            // one at the P-hus, where Community's "Add a charger" would put it.
            if (!chargePoints().length) addChargePoint();
            const spec = buildSpec();
            // The red step needs red lines. AWL's battery belongs to AWL, so it
            // only ever discharges into AWL itself - a line with no length,
            // drawn nowhere. In the example it is a store the whole community
            // shares, so its discharge runs out to the members and can be seen.
            (spec.batteries || []).forEach(function (b) { b.attached = false; });
            return spec;
        } finally {
            state.working = keptWorking;
            state.excluded = keptExcluded;
        }
    }

    /**
     * Fetch the campus with every building in it, hand it to the table, then
     * show the step.
     *
     * The introduction paints every building pink, then brings in the roofs,
     * the grid, the battery and the charger, then the flows between them. An
     * empty community has none of that - the table drops it all when told the
     * campus is empty - so the introduction needs a full one to show. It gets
     * one of its own, and the members list in the panel stays as it was.
     */
    // Skip pressed while the introduction is still being prepared: when the
    // example arrives it is dropped instead of shown.
    let storySkipRequested = false;

    function loadStoryLayer(index) {
        if (storyLoading) return;
        storyLoading = true;
        storySkipRequested = false;
        const spec = storyExampleSpec();
        setStatus('Preparing the introduction…', 'busy');
        render();          // the strip shows "Preparing" with a Skip button
        postJson('/api/mr/layer?baseline=true', spec).then(function (layer) {
            if (storySkipRequested) return;
            storyLayer = layer;
            storySpec = spec;
            channel.postMessage({ type: 'ecom_layer', layer: layer });
        }, function (error) {
            if (storySkipRequested) return;
            setStatus('The introduction could not load the campus: ' +
                      String(error.message || error), 'error');
        }).then(function () {
            storyLoading = false;
            if (storySkipRequested) {
                storySkipRequested = false;
                setStatus('No members yet - tick a building to start.', 'idle');
                render();
                return;
            }
            if (storyLayer) storyGo(index);
        });
    }

    /** Back to the community the panel actually has, once the introduction ends. */
    function restorePanelCommunity() {
        storyLayer = null;
        storySpec = null;
        if (!memberCount()) {
            // Empty, as the panel is: the table goes back to a campus nobody
            // has joined yet.
            state.layer = null;
            channel.postMessage({ type: 'ecom_empty' });
            setStatus('No members yet - tick a building to start.', 'idle');
        } else {
            // Someone ticked buildings before or during the introduction; the
            // table shows theirs, not the introduction's.
            applyNow();
        }
    }

    function storyGo(index) {
        const from = state.story;
        const leaving = state.story >= 0 && index < 0;
        const starting = state.story < 0 && index >= 0;

        if (starting && !storyLayer) {
            loadStoryLayer(index);
            return;
        }
        // Finishing the introduction is not the same as walking out of it. The
        // last step ends with a community wired up and standing still, and
        // Finish is the moment it starts running - so that hands the table over
        // with the day going and the sound up, where Exit puts back whatever
        // was there before.
        const finishing = leaving && from === STORY.length - 1;
        if (starting) soundBeforeStory = state.sound;
        state.story = index;

        if (index < 0) {
            // Back to whatever the panel's own view filters say, the table's
            // own clock, and no caption.
            channel.postMessage({ type: 'ecom_caption', caption: null });
            channel.postMessage({ type: 'ecom_uniform', on: false });
            channel.postMessage({ type: 'ecom_flows', mode: 'running' });
            pushFilters();
            if (leaving) {
                channel.postMessage({ type: 'ecom_release' });
                // Every step mutes the sound, so quitting at step three used to
                // leave the table silent with no way to tell why. Finishing
                // hands over to a running table and brings it up; exiting part
                // way puts back whatever was there before.
                // An empty community has nothing to play, so Finish only brings
                // the sound up when there are members to hear.
                if (finishing && memberCount()) {
                    channel.postMessage({ type: 'ecom_sound', on: true });
                } else if (soundBeforeStory !== null) {
                    channel.postMessage({ type: 'ecom_sound',
                                          on: !!soundBeforeStory });
                }
                soundBeforeStory = null;
                // The introduction's example campus goes; the panel's own
                // community - empty unless someone has ticked buildings -
                // comes back.
                restorePanelCommunity();
            }
            render();
            return;
        }

        const step = STORY[index];

        // First, because everything below describes a layer that has to be on.
        // Harmless when it already is.
        channel.postMessage({ type: 'ecom_activate' });

        channel.postMessage({
            type: 'ecom_filters',
            filters: (step.kinds === null && step.pairs === null)
                ? null
                : { kinds: step.kinds || NODE_KINDS.map(function (k) { return k.key; }),
                    pairs: step.pairs,
                    // What the lines may carry - solar for the yellow step,
                    // battery for the red - so a step shows its own colour only.
                    carries: step.carries || null }
        });

        // A held hour for every step but the last, so only one thing is moving
        // at a time. The last hands the clock back and lets the day run.
        const hour = typeof step.hour === 'string'
            ? busiestHour(step.hour, step.fallbackHour) : step.hour;
        if (typeof hour === 'number') {
            channel.postMessage({ type: 'ecom_hour', hour: hour });
        } else {
            channel.postMessage({ type: 'ecom_release' });
        }

        channel.postMessage({
            type: 'ecom_uniform',
            on: !!step.uniform,
            reveal: step.reveal || null
        });

        channel.postMessage({
            type: 'ecom_flows',
            mode: step.flows === 'still' ? 'still' : 'running'
        });

        // Sound arrives with the community, not before it.
        channel.postMessage({ type: 'ecom_sound', on: !!step.sound });

        channel.postMessage({
            type: 'ecom_caption',
            caption: { title: step.title, line: storyText(step.line),
                       figure: storyText(step.figure),
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
                        : (storyLoading && !storySkipRequested)
                            ? 'Preparing the introduction…' : 'Introduction') +
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
                          'data-action="story-exit" title="Leave the introduction ' +
                          'and start building a community">Skip</button>'
                    : (storyLoading && !storySkipRequested)
                    // Skippable before it has even started.
                    ? '<button type="button" class="ecom-ctl-btn" disabled>Preparing…</button>' +
                      '<button type="button" class="ecom-ctl-btn" ' +
                          'data-action="story-skip" title="Do not show the ' +
                          'introduction - start building a community">Skip</button>'
                    : '<button type="button" class="ecom-ctl-btn ' +
                          'ecom-ctl-btn--primary" data-action="story-next">' +
                          'Start the introduction</button>') +
            '</div>' +
        '</div>';
    }

    // --------------------------------------------------------------- change
    //
    // The community as it was when the table was last drawn, so the next Apply
    // can say what is different. Only the panel knows this: the backend is
    // handed a whole community each time and has no idea which part of it the
    // hand on the slider just moved.
    // Seeded when the scenario loads, not left empty until the first Apply.
    // Empty meant the first change anyone made - the one most likely to be
    // demonstrated - was the one change that went unannounced.
    let lastApplied = null;
    let lastKpis = null;

    function memberNames(spec) {
        return (spec.buildings || []).map(function (b) { return b.name; });
    }

    function chargerNames(spec) {
        return (spec.charge_points || []).map(function (cp) { return cp.name; });
    }

    function firstDifference(before, after) {
        const gone = before.filter(function (n) { return after.indexOf(n) === -1; });
        const came = after.filter(function (n) { return before.indexOf(n) === -1; });
        if (came.length) return { name: came[0], action: 'add' };
        if (gone.length) return { name: gone[0], action: 'remove' };
        return null;
    }

    /** Where the table draws a building, from the layer it last drew. */
    function buildingAt(name) {
        const nodes = (state.layer && state.layer.nodes &&
                       state.layer.nodes.features) || [];
        const found = nodes.find(function (feature) {
            return feature.properties.kind === 'building' &&
                   feature.properties.name === name;
        });
        return found ? found.geometry.coordinates : null;
    }

    /** Where the table draws a shared asset, from the layer it last drew. */
    function assetAt(kind) {
        const nodes = (state.layer && state.layer.nodes &&
                       state.layer.nodes.features) || [];
        const found = nodes.find(function (feature) {
            return feature.properties.kind === kind;
        });
        return found ? found.geometry.coordinates : null;
    }

    /** Each roof array by name, with how much panel it carries. */
    function plantAreas(spec) {
        const out = {};
        (spec.pv_plants || []).forEach(function (plant) {
            out[plant.name] = Math.round((plant.surface_area || 0) *
                                         (plant.percentage || 100) / 100);
        });
        return out;
    }

    /** The building whose roof a given array sits on. */
    function hostOfPlant(spec, plantName) {
        const found = (spec.buildings || []).find(function (building) {
            return (building.pv_plants || []).indexOf(plantName) !== -1;
        });
        return found ? found.name : null;
    }

    function roofTotal(spec) {
        return (spec.pv_plants || []).reduce(function (total, plant) {
            return total + (plant.surface_area || 0) * (plant.percentage || 100) / 100;
        }, 0);
    }

    function periodLabel(spec) {
        const p = spec.analysis_period || {};
        return [p.start_month, p.start_day, p.start_hour,
                p.end_month, p.end_day, p.end_hour].join('-');
    }

    /**
     * One sentence about what this Apply is about to do, or null.
     *
     * One thing at a time on purpose: a change worth announcing is a change
     * someone made deliberately, and a run of them is better told one after
     * another than summed into "four things moved".
     *
     * Everything that re-dispatches is announced, not only the two kinds that
     * have a marker to land. A tariff or a date has no place on the map, so it
     * gets the dimming and the caption without a landing - the room still needs
     * to know the table is about to change and why, and silence for those was
     * most of the silence.
     */
    function describeChange(spec) {
        if (!lastApplied) return null;
        // Nothing to announce when nothing is different. Pressing Apply on an
        // untouched community, or the panel's own opening dispatch, would
        // otherwise dim the table and declare a recomputation that changes not
        // one number on it.
        if (JSON.stringify(lastApplied) === JSON.stringify(spec)) return null;

        const charger = firstDifference(chargerNames(lastApplied),
                                        chargerNames(spec));
        if (charger) {
            const list = charger.action === 'add' ? spec.charge_points
                                                  : lastApplied.charge_points;
            const cp = (list || []).find(function (c) {
                return c.name === charger.name;
            });
            if (cp && cp.lat != null && cp.lon != null) {
                return {
                    kind: 'charge_point',
                    action: charger.action,
                    title: charger.action === 'add'
                        ? 'Adding a charge point' : 'Removing a charge point',
                    line: charger.name + ' · ' + CP_PLACE,
                    at: [cp.lon, cp.lat]
                };
            }
        }

        const member = firstDifference(memberNames(lastApplied),
                                       memberNames(spec));
        if (member) {
            return {
                kind: 'building',
                action: member.action,
                title: member.action === 'add'
                    ? 'Joining the energy community'
                    : 'Leaving the energy community',
                line: member.name,
                // Named as well as described, because the panel cannot always
                // place it. A building being removed is on the table and has a
                // centroid; a building being added is not drawn yet and has
                // none - which is why adding one used to get the dimming and
                // the caption but no landing, while removing the same building
                // got the whole thing. The table knows where every footprint
                // is, member or not, so it resolves the name itself.
                name: member.name,
                at: buildingAt(member.name)
            };
        }

        const wasBattery = (lastApplied.batteries || [])[0];
        const nowBattery = (spec.batteries || [])[0];
        if (wasBattery && nowBattery &&
                Math.round(wasBattery.capacity) !== Math.round(nowBattery.capacity)) {
            const bigger = nowBattery.capacity > wasBattery.capacity;
            return {
                kind: 'battery',
                action: bigger ? 'add' : 'remove',
                title: bigger ? 'A bigger battery' : 'A smaller battery',
                line: Math.round(wasBattery.capacity) + ' → ' +
                      Math.round(nowBattery.capacity) + ' kWh',
                at: assetAt('battery')
            };
        }

        // Roof solar, named by the building it sits on so the table can land
        // it there. Panels are not community assets standing on their own -
        // they are a thing that happens to a roof, and the roof is where the
        // room should be looking.
        // Every roof that changed, not the first one found.
        //
        // "Cover every roof at 80%" is one press and thirty roofs, and naming
        // only the first of them sent the table to spotlight one building while
        // the other twenty-nine quietly turned yellow behind the scrim. It read
        // as a change to that building.
        const wasPlants = plantAreas(lastApplied);
        const nowPlants = plantAreas(spec);
        const plantNames = Object.keys(nowPlants).concat(Object.keys(wasPlants));
        const changed = [];
        const seen = {};
        plantNames.forEach(function (plant) {
            if (seen[plant]) return;
            seen[plant] = true;
            const before = wasPlants[plant];
            const after = nowPlants[plant];
            if (before === after) return;
            changed.push({
                plant: plant,
                before: before,
                after: after,
                host: hostOfPlant(spec, plant) || hostOfPlant(lastApplied, plant),
                growing: (after || 0) > (before || 0)
            });
        });

        if (changed.length) {
            const growing = changed.filter(function (c) { return c.growing; }).length
                            >= changed.length / 2;
            const area = function (rows, pick) {
                return Math.round(rows.reduce(function (sum, c) {
                    return sum + (pick(c) || 0);
                }, 0));
            };
            const one = changed.length === 1 ? changed[0] : null;
            return {
                kind: 'pv',
                action: growing ? 'add' : 'remove',
                title: one
                    ? (one.after === undefined ? 'Taking the panels off a roof'
                       : one.before === undefined ? 'Putting panels on a roof'
                       : one.growing ? 'More panel on a roof' : 'Less panel on a roof')
                    : (growing ? 'Panels on ' + changed.length + ' roofs'
                               : 'Panels off ' + changed.length + ' roofs'),
                line: one
                    ? ((one.host ? one.host + ' · ' : '') +
                       (one.before === undefined ? (one.after + ' m²')
                        : one.after === undefined ? ('was ' + one.before + ' m²')
                        : (one.before + ' → ' + one.after + ' m²')))
                    : (area(changed, function (c) { return c.before; }) + ' → ' +
                       area(changed, function (c) { return c.after; }) + ' m² of panel'),
                // Named as well as placed: a roof on a building the table has
                // not drawn - one outside the community - still has a
                // footprint the table can find for itself.
                name: one ? one.host : null,
                at: one && one.host ? buildingAt(one.host) : null,
                // Every roof it touches, so the table can light them together.
                targets: changed.filter(function (c) { return c.host; })
                    .map(function (c) {
                        return { name: c.host, at: buildingAt(c.host) };
                    })
            };
        }

        const wasRoof = Math.round(roofTotal(lastApplied));
        const nowRoof = Math.round(roofTotal(spec));
        if (wasRoof !== nowRoof) {
            return {
                kind: 'pv',
                action: nowRoof > wasRoof ? 'add' : 'remove',
                title: nowRoof > wasRoof ? 'More roof solar' : 'Less roof solar',
                line: wasRoof + ' → ' + nowRoof + ' m² of panel',
                at: null
            };
        }

        if (periodLabel(lastApplied) !== periodLabel(spec)) {
            return {
                kind: 'action', action: 'add',
                title: 'A different day',
                line: 'Re-running the community over a new period',
                at: null
            };
        }

        // Something else re-dispatched: a tariff, the carbon intensity, the
        // dispatch mode. No place on the map, so it is said on the panel, beside
        // the spinner, by whoever changed it - the table just moves to the new
        // figures.
        return {
            kind: 'action', action: 'add',
            title: 'Recomputing the community',
            line: 'The parameters changed',
            at: null,
            onPanel: true
        };
    }

    // The beats the table is running, so the panel can keep time with it.
    const BEAT_MS = 400 + 800 + 600;

    /**
     * Flash the control that caused the change, while the table dims.
     *
     * Two screens, one event. Without this the panel gives no sign that the
     * thing under your hand is what the room is now looking at - and on a
     * table with a controller at one end and a projection at the other, that
     * connection is the whole point of having both.
     *
     * Held in state rather than written straight onto the element, because the
     * panel re-renders while the beat is still running and a class set on a
     * node that is about to be replaced lasts no time at all.
     */
    function flashControl(changing) {
        state.flash = { kind: changing.kind, name: changing.line, at: Date.now() };
        paintFlash();
        setTimeout(function () {
            state.flash = null;
            paintFlash();
        }, BEAT_MS);
    }

    // The one element currently keeping time, so it can be released without
    // sweeping the document for whatever was flashed last.
    let flashed = null;

    function paintFlash() {
        if (flashed && flashed.classList) {
            flashed.classList.remove('ecom-ctl-flash');
        }
        flashed = null;
        if (!state.flash) return;

        const target = flashTarget(state.flash);
        if (target && target.classList) {
            target.classList.add('ecom-ctl-flash');
            flashed = target;
        }
    }

    function flashTarget(flash) {
        if (flash.kind === 'charge_point') {
            // The name is the first half of "CP 2 · Gibraltarvallsvagen".
            const name = String(flash.name).split(' · ')[0];
            const button = document.querySelector(
                '[data-cp-remove="' + name.replace(/"/g, '') + '"]');
            if (button) return button.parentElement || button;
        }
        if (flash.kind === 'building') {
            // By attribute rather than by reading every label's text: the name
            // is already on the row, and matching on rendered text breaks the
            // moment a row shows anything but the bare name.
            const row = document.querySelector(
                '[data-member="' + String(flash.name).replace(/"/g, '') + '"]');
            if (row) return row;
        }
        // Everything else - a tariff, a different day, a resized battery - has
        // no single row of its own. The status line is where the panel already
        // says what it is doing, so that is what keeps time.
        return document.getElementById('ecom-ctl-status');
    }

    function outcomeLine(layer) {
        const before = lastKpis && lastKpis.self_sufficiency;
        const after = layer.kpis && layer.kpis.self_sufficiency;
        if (typeof before !== 'number' || typeof after !== 'number') return null;
        return 'Self-sufficiency ' + before.toFixed(1) + '% → ' + after.toFixed(1) + '%';
    }

    function reportOutcome(layer) {
        const line = outcomeLine(layer);
        if (line) channel.postMessage({ type: 'ecom_change_result', line: line });
    }

    // ------------------------------------------------------------ optimizer

    // How much of the year to optimise, and what that costs in waiting.
    //
    // Measured on this campus with Gurobi: about 2.4 s a day for 38 buildings,
    // near enough linear, so the estimates below are honest rather than
    // hopeful. The dispatch the table animates is unaffected either way - the
    // optimizer returns costs, not flows.
    //
    // A year is the calendar year, because the analysis period cannot wrap it:
    // "a year from today" would end before it started. A month and a week run
    // from the day the table is on, and slide back from the end of December if
    // they would overrun it.
    const OPTIMIZER_SPANS = [
        { key: 'day', label: 'A day', days: 1 },
        { key: 'week', label: 'A week', days: 7 },
        { key: 'month', label: 'A month', days: 30 },
        { key: 'year', label: 'A year', days: DAYS_PER_YEAR }
    ];
    const SECONDS_PER_DAY_SOLVED = 2.4;

    function currentSpan() {
        return OPTIMIZER_SPANS.find(function (option) {
            return option.key === state.optimizerSpan;
        }) || OPTIMIZER_SPANS[0];
    }

    /** "about 12 minutes", for a number of days. */
    function optimizerEstimate(days) {
        const seconds = Math.round(days * SECONDS_PER_DAY_SOLVED);
        if (seconds < 90) return 'about ' + seconds + ' s';
        const minutes = Math.round(seconds / 60);
        return 'about ' + minutes + (minutes === 1 ? ' minute' : ' minutes');
    }

    /** "1 - 7 June", or "the whole year", for a period. */
    function periodLabel(period) {
        if (period.start_month === 1 && period.start_day === 1 &&
            period.end_month === 12 && period.end_day === 31) {
            return 'the whole year';
        }
        const from = period.start_day + ' ' + MONTH_NAMES[period.start_month - 1];
        const to = period.end_day + ' ' + MONTH_NAMES[period.end_month - 1];
        if (period.start_month === period.end_month) {
            if (period.start_day === period.end_day) return to;
            return period.start_day + ' - ' + to;
        }
        return from + ' - ' + to;
    }

    /** The period to optimise over, as the backend wants it. */
    function optimizerPeriod(days) {
        if (days >= DAYS_PER_YEAR) {
            return { start_month: 1, start_day: 1, start_hour: 0,
                     end_month: 12, end_day: 31, end_hour: 23 };
        }
        // From the day the table is on, pulled back if it would run past the
        // end of December - the period is not allowed to wrap the new year.
        const wanted = dayOfYear(state.startMonth, state.startDay);
        const first = Math.min(wanted, DAYS_PER_YEAR - days + 1);
        const from = fromDayOfYear(first);
        const to = fromDayOfYear(first + days - 1);
        return { start_month: from.month, start_day: from.day, start_hour: 0,
                 end_month: to.month, end_day: to.day, end_hour: 23 };
    }

    let pollTimer = null;

    const OPTIMIZER_MODE_LABELS = {
        separate: 'As today',
        community: 'As an energy community'
    };
    let optimizerRun = 0;

    /** Tell the display what the optimizer is doing and what it found. */
    // ------------------------------------------------- calculating, on the panel
    //
    // The optimizer is quick - seconds for a day - but a cost figure that just
    // changes, with nothing to say it was being worked out, reads as a number
    // that was always there. A pill on the panel says a calculation is under
    // way and which scenario it is on, then that it is done. Attached to the
    // body, so a re-render of the panel cannot take it away mid-run.
    let optBusyEl = null;
    let optBusyTimer = null;

    function paintOptimizerBusy() {
        if (!document.body || !document.createElement) return;
        if (!optBusyEl) {
            optBusyEl = document.createElement('div');
            optBusyEl.className = 'ecom-opt-busy';
            optBusyEl.setAttribute('role', 'status');
            optBusyEl.setAttribute('aria-live', 'polite');
            document.body.appendChild(optBusyEl);
        }
        if (optBusyTimer !== null) { clearTimeout(optBusyTimer); optBusyTimer = null; }

        const running = state.optimizerRunning;
        const job = state.optimizer;
        if (running) {
            const modes = state.optimizerMode === 'both' ? ['separate', 'community'] : [running];
            const step = modes.indexOf(running) + 1;
            const seconds = state.optimizerStartedAt
                ? Math.max(0, Math.round((Date.now() - state.optimizerStartedAt) / 1000)) : 0;
            optBusyEl.innerHTML =
                '<span class="ecom-busy-spinner"></span>' +
                '<span><b>Calculating costs</b> - ' +
                    esc((OPTIMIZER_MODE_LABELS[running] || running).toLowerCase()) +
                    (modes.length > 1 ? ' (' + step + ' of ' + modes.length + ')' : '') +
                    '&hellip; <span class="ecom-opt-busy-time">' + seconds + ' s</span></span>';
            optBusyEl.className = 'ecom-opt-busy is-on';
            return;
        }
        if (job && job.status === 'error') {
            optBusyEl.innerHTML = '<span class="ecom-opt-busy-mark is-error">!</span>' +
                '<span>Cost calculation failed - ' + esc(job.error || 'see the Optimizer tab') + '</span>';
            optBusyEl.className = 'ecom-opt-busy is-on is-error';
            optBusyTimer = setTimeout(function () { optBusyEl.className = 'ecom-opt-busy'; }, 6000);
            return;
        }
        if (Object.keys(state.optimizerResults || {}).length &&
            optBusyEl.classList.contains('is-on')) {
            optBusyEl.innerHTML = '<span class="ecom-opt-busy-mark">&#10003;</span>' +
                '<span>Costs updated - see the table</span>';
            optBusyEl.className = 'ecom-opt-busy is-on is-done';
            optBusyTimer = setTimeout(function () { optBusyEl.className = 'ecom-opt-busy'; }, 2500);
            return;
        }
        optBusyEl.className = 'ecom-opt-busy';
    }

    function broadcastOptimization() {
        paintOptimizerBusy();
        // The KPI panel carries the optimizer's figures too: "calculating…"
        // while it runs, its numbers when it is done.
        renderKpis();
        const job = state.optimizer;
        channel.postMessage({
            type: 'ecom_optimization',
            optimization: {
                running: state.optimizerRunning || '',
                error: job && job.status === 'error' ? (job.error || 'failed') : '',
                label: currentSpan().label,
                period: periodLabel(optimizerPeriod(currentSpan().days)),
                results: state.optimizerResults,
                previous: state.optimizerPrevious
            }
        });
    }

    /** Wait for one job to finish, keeping the panel's clock moving. */
    function waitForJob(jobId, token) {
        return new Promise(function (resolve, reject) {
            pollTimer = setInterval(async function () {
                try {
                    const job = await getJson('/api/optimize/' + encodeURIComponent(jobId));
                    if (token !== optimizerRun) { stopPolling(); return; }
                    state.optimizer = job;
                    // A heartbeat for the display. It lightens itself while a run
                    // is solving and must be able to tell "still solving" from "the
                    // controller went away" - which it cannot if the only message
                    // is the one that says the run started.
                    if (state.optimizerRunning) broadcastOptimization();
                    if (job.status === 'done') { stopPolling(); resolve(job); }
                    else if (job.status === 'error') {
                        stopPolling();
                        reject(new Error(job.error || 'the optimizer failed'));
                    }
                    render();
                } catch (error) {
                    stopPolling();
                    reject(error);
                }
            }, 2000);
        });
    }

    async function runOptimizer() {
        if (state.api === null) return;
        stopPolling();
        const token = ++optimizerRun;
        const modes = state.optimizerMode === 'both'
            ? ['separate', 'community'] : [state.optimizerMode];
        state.optimizer = { status: 'queued', progress: 0 };
        // What the last finished run found, kept to set this one against. Only
        // a complete set counts: a run cut short by a newer change has half an
        // answer, and comparing against half of one would mislead.
        if (modes.every(function (m) { return state.optimizerResults[m]; })) {
            state.optimizerPrevious = state.optimizerResults;
        }
        state.optimizerResults = {};
        state.optimizerStartedAt = Date.now();
        state.optimizerRunning = modes[0];
        render();
        broadcastOptimization();

        try {
            const span = currentSpan();
            // The community as the panel has it, over the span being asked
            // for. The table's own period is left alone: it is showing a day,
            // and optimising a year should not move it off that day.
            const spec = clone(buildSpec());
            spec.analysis_period = optimizerPeriod(span.days);
            for (const mode of modes) {
                state.optimizerRunning = mode;
                state.optimizerStartedAt = Date.now();
                render();
                broadcastOptimization();
                const job = await postJson('/api/optimize', {
                    community: spec,
                    days: span.days,
                    mode: mode,
                    // The optimizer has one switch for every car, not one per
                    // charger: on when any charger in the community offers V2G.
                    v2g: (spec.charge_points || []).some(function (cp) {
                        return cp.is_v2g;
                    }),
                    horizon_hours: OPTIMIZER_LOOKAHEAD_H,
                    store_hours: OPTIMIZER_KEEP_H,
                    parameters: Object.keys(state.paramValues).length
                        ? state.paramValues : null
                });
                state.optimizer = job;
                const done = await waitForJob(job.id, token);
                if (token !== optimizerRun) return;
                state.optimizerResults[mode] = done.result;
                broadcastOptimization();
            }
            state.optimizerRunning = '';
            render();
            broadcastOptimization();
        } catch (error) {
            if (token !== optimizerRun) return;
            state.optimizerRunning = '';
            state.optimizer = { status: 'error', error: String(error.message || error) };
            render();
            broadcastOptimization();
        }
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
    // A change announced on the panel rather than on the table, kept up
    // through the draw so its title does not give way to the generic one.
    let panelChange = null;

    function setBusy(text, detail) {
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
            panelChange = null;
            busyEl.className = 'ecom-busy';
            return;
        }

        busyEl.innerHTML =
            '<span class="ecom-busy-spinner"></span>' +
            '<span class="ecom-busy-body">' +
                '<span class="ecom-busy-text">' + esc(text) + '</span>' +
                (detail ? '<span class="ecom-busy-detail">' + esc(detail) + '</span>' : '') +
            '</span>';
        busyEl.className = 'ecom-busy is-on' + (detail ? ' has-detail' : '');
    }

    /** Waiting on the table now, with a limit. */
    // How long a change's card stays up, spinner gone, once the table has it.
    const DONE_HOLD_MS = 2600;
    let drawnOutcome = null;

    /**
     * The table has redrawn. A plain dispatch just clears; a change keeps its
     * card a moment longer with what it did, since the table no longer says.
     */
    function finishBusy() {
        if (!panelChange || !busyEl || !drawnOutcome) {
            setBusy(null);
            return;
        }
        if (drawTimer !== null) clearTimeout(drawTimer);
        setBusy(panelChange.title, drawnOutcome);
        busyEl.className += ' is-done';
        drawTimer = setTimeout(function () {
            drawTimer = null;
            setBusy(null);
        }, DONE_HOLD_MS);
    }

    function awaitDraw(outcome) {
        drawnOutcome = outcome || null;
        if (panelChange) setBusy(panelChange.title, 'Drawing on the table…');
        else setBusy('Drawing on the table…');
        drawTimer = setTimeout(function () {
            drawTimer = null;
            panelChange = null;
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

    // The day, when there is no table to run it.
    //
    // The display owns the clock: this panel only tells it to run or to hold,
    // and follows the hour it reports back. With no display answering - not
    // opened yet, or opened from a different address, which BroadcastChannel
    // cannot cross - nothing reports an hour and "play" does nothing at all,
    // which reads as a broken button rather than a missing display.
    //
    // So with no display linked the panel runs the day itself, at the table's
    // own pace, and the sky, the scrubber and the line on the load-profile chart
    // all move. The moment a display answers, its clock takes over again: two
    // clocks driving one hour is a stutter, so this one stands down.
    //
    // Keep in step with HOUR_MS in animations/ecom-energy.js.
    const LOCAL_HOUR_MS = 3000;
    let localClock = null;

    function syncLocalClock() {
        const wanted = state.playing && !state.link.up &&
                       !!state.layer && state.hours > 0;

        if (wanted && localClock === null) {
            localClock = setInterval(function () {
                // Re-checked on every tick: a display can answer, or someone
                // can press pause, at any point between two of them.
                if (!state.playing || state.link.up || !state.layer) {
                    syncLocalClock();
                    return;
                }
                state.hour = (state.hour + 1) % Math.max(1, state.hours);
                const scrub = document.getElementById('ecom-hour');
                if (scrub) scrub.value = String(state.hour);
                paintSky();
            }, LOCAL_HOUR_MS);
        } else if (!wanted && localClock !== null) {
            clearInterval(localClock);
            localClock = null;
        }
    }

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
        // The link changing is exactly when the local clock should start or
        // stand down, so it is decided here and not left to a timer to notice.
        syncLocalClock();

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
        // `typed`: the figure beside the slider is a box that can be typed in,
        // not just a readout. Applied on commit, up to the slider's own maximum.
        const figure = opts.typed
            ? '<span class="ecom-kw-field">' +
                  '<input type="number" inputmode="decimal" min="0"' +
                      ' step="' + opts.step + '"' +
                      ' data-slider-typed="' + esc(opts.name) + '"' +
                      ' data-readout="' + esc(opts.name) + '"' +
                      ' data-typed-max="' + opts.max + '"' +
                      ' aria-label="' + esc(opts.label) + '"' +
                      ' value="' + Math.round(value) + '">' +
                  '<i>' + esc(opts.unit || '') + '</i></span>'
            : '<b data-readout="' + esc(opts.name) + '">' +
                  esc(opts.format ? opts.format(value) : value) +
                  ' ' + esc(opts.unit || '') +
              '</b>';
        return '' +
            '<label class="ecom-ctl-slider">' +
                '<span class="ecom-ctl-slider-head">' +
                    '<span>' + esc(opts.label) + '</span>' +
                    figure +
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
        community: { icon: 'solar_power', accent: 'yellow' },
        grid: { icon: 'bolt', accent: 'cyan' },
        view: { icon: 'visibility', accent: 'slate' },
        optimizer: { icon: 'insights', accent: 'violet' }
    };

    // The parameter sections are tabs, not an accordion.
    //
    // They were cards that opened and closed, side by side across the width of
    // the page. Put in a column beside the load-profile chart, five accordion
    // sections stack, and opening one pushes the rest down the page - the Members
    // list, which needs the most height, ends up scrolling inside a scrolling
    // column. A tab shows exactly one section and gives it the whole column.
    //
    // Each *Group() function still calls group() with its title, a one-line
    // summary and its body, so none of them had to change; group() now files
    // the section away and paramsMarkup() lays them out.
    let sections = [];

    function group(id, title, note, body) {
        sections.push({ id: id, title: title, note: note, body: body });
        return '';
    }

    /** The tab bar and the section it has selected. */
    function paramsMarkup() {
        sections = [];
        membersGroup();
        communityGroup();
        gridGroup();
        optimizerGroup();

        const active = sections.some(function (s) { return s.id === state.openGroup; })
            ? state.openGroup : sections[0].id;
        const current = sections.find(function (s) { return s.id === active; });

        const tabs = sections.map(function (s) {
            const style = GROUP_STYLE[s.id] || { icon: 'tune', accent: 'slate' };
            return '<button type="button" role="tab" class="ecom-tab ecom-tab--' +
                style.accent + (s.id === active ? ' is-on' : '') + '"' +
                ' data-group="' + s.id + '"' +
                ' aria-selected="' + (s.id === active) + '">' +
                '<span class="material-icons ecom-tab-icon">' + style.icon + '</span>' +
                '<span class="ecom-tab-title">' + esc(s.title) + '</span>' +
                '<span class="ecom-tab-note">' + esc(s.note) + '</span>' +
            '</button>';
        }).join('');

        return '<div class="ecom-params">' +
                   '<div class="ecom-tabs" role="tablist">' + tabs + '</div>' +
                   '<div class="ecom-tabpanel" role="tabpanel">' + current.body + '</div>' +
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

    /** A tile with one of the optimizer's costs, or what it is waiting for. */
    function optTile(mode, label, tone, hint) {
        const result = (state.optimizerResults || {})[mode];
        const cost = result && result.totals ? result.totals.overall_cost : null;
        const value = state.optimizerRunning ? 'calculating…'
            : cost != null ? Math.round(cost).toLocaleString() + ' SEK' : 'not run yet';
        return tile('payments', value, label, tone, hint);
    }

    function row(icon, label, value, hint) {
        return '' +
            '<div class="ecom-kpi-row"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>' +
                '<span class="material-icons ecom-kpi-row-icon">' + icon + '</span>' +
                '<span>' + esc(label) + '</span>' +
                '<b>' + value + '</b>' +
            '</div>';
    }

    // ---------------------------------------------- with and without a community
    //
    // A community's figures mean little alone: 19% self-sufficient is a number,
    // and whether it is a good one depends on what the same buildings would have
    // managed apart. The backend dispatches both - the members sharing, and the
    // same members each on their own - and each tile shows the first with the
    // second beneath it and the difference between them.
    //
    // "On their own" has no community-owned solar and no community battery, since
    // those belong to nobody once there is no community; what it keeps is what
    // is a building's own. So the difference is what sharing adds.

    /** Whether the layer came back with the other half to compare against. */
    function comparable(layer) {
        const b = layer && layer.baseline;
        return !!(b && b.kpis && Object.keys(b.kpis).length);
    }

    /** Solar that ended up used on the campus rather than exported.
     *
     * Not the layer's own "self-consumption": that counts only solar used inside
     * the building that made it, so a roof's surplus lent to the building next
     * door counts as not consumed - which makes it the one KPI sharing cannot
     * move, and a comparison of two equal numbers.
     */
    function solarUsedOnCampus(kpis) {
        if (!kpis || !(kpis.total_pv_gen > 0)) return null;
        return Math.max(0, 1 - (kpis.total_grid_export || 0) / kpis.total_pv_gen) * 100;
    }

    function signed(value, digits) {
        const text = Math.abs(value).toLocaleString(undefined, {
            minimumFractionDigits: digits, maximumFractionDigits: digits });
        return (value < 0 ? '−' : '+') + text;
    }

    function compareMarkup(k, layer) {
        const base = layer.baseline;
        const bk = base.kpis;
        const members = layer.matched;

        // better: which way is an improvement. null means the difference is not
        // good or bad in itself - less export is more solar used on site, but it
        // is also less sold - so it is shown without a verdict.
        const metrics = [
            { label: 'Self-sufficient', tone: 'green', better: 'up',
              hint: 'Share of demand met without importing from the grid.',
              get: function (x) { return x.self_sufficiency; },
              show: function (v) { return v.toFixed(1) + ' %'; },
              diff: function (d) { return signed(d, 1) + ' pts'; } },
            { label: 'Solar used on site', tone: 'yellow', better: 'up',
              hint: 'Share of the solar that was used on the campus rather than ' +
                    'exported - including what a building lent to its neighbours.',
              get: solarUsedOnCampus,
              show: function (v) { return v.toFixed(1) + ' %'; },
              diff: function (d) { return signed(d, 1) + ' pts'; } },
            { label: 'Peak from grid', tone: 'pink', better: 'down',
              hint: 'The most the whole community draws from the grid in any one ' +
                    'hour. The grid operator charges for this peak.',
              get: function (x) { return x.peak_grid_import_kw; },
              show: function (v) { return Math.round(v).toLocaleString() + ' kW'; },
              diff: function (d) { return signed(d, 0) + ' kW'; } },
            // From the optimizer, not the dispatch: its community run against
            // its "as today" run, which are the same two rows this table has.
            // Grid import and export used to be the dispatch's figures here,
            // beside the optimizer's own on the table - two numbers for one
            // thing. And the grid bill could only be worked out at a fixed
            // price, so with spot prices it was always a dash.
            { label: 'Grid import (optimized)', tone: 'cyan', better: 'down', opt: 'grid_import_kwh',
              hint: 'Bought from the grid, as the optimizer runs the buildings.',
              show: function (v) { return Math.round(v).toLocaleString() + ' kWh'; },
              diff: function (d) { return signed(d, 0) + ' kWh'; } },
            { label: 'Grid export (optimized)', tone: 'blue', better: null, opt: 'grid_export_kwh',
              hint: 'Sold to the grid, as the optimizer runs the buildings.',
              show: function (v) { return Math.round(v).toLocaleString() + ' kWh'; },
              diff: function (d) { return signed(d, 0) + ' kWh'; } },
            { label: 'Cost (optimized)', tone: 'green', better: 'down', opt: 'overall_cost',
              hint: 'Everything the optimizer counts: electricity, grid fees and ' +
                    'subscription, tax and VAT. The difference is what being a ' +
                    'community saves.',
              show: function (v) { return Math.round(v).toLocaleString() + ' SEK'; },
              diff: function (d) { return signed(d, 0) + ' SEK'; } }
        ];

        // The optimizer's two runs, if both have come back.
        const optWith = (state.optimizerResults || {}).community;
        const optAlone = (state.optimizerResults || {}).separate;
        const optTotals = function (result, key) {
            return result && result.totals ? result.totals[key] : undefined;
        };

        // One column per measure, one row per way of running the same buildings:
        // with the community, each on its own, and what the difference is. Side by
        // side the two figures can be read straight across, which two numbers
        // folded into a tile could not.
        const cols = metrics.map(function (m) {
            const have = function (v) {
                return v !== null && v !== undefined && isFinite(v);
            };
            if (m.opt) {
                // Not run yet, or running now: say which, rather than a dash.
                if (state.optimizerRunning) return { m: m, pending: 'calculating…' };
                const a = optTotals(optWith, m.opt);
                const b = optTotals(optAlone, m.opt);
                if (!have(a)) return { m: m, pending: 'run the optimizer' };
                const out = { m: m, mine: m.show(a) };
                if (have(b)) {
                    const d = a - b;
                    const same = Math.abs(d) < 0.5;
                    out.theirs = m.show(b);
                    out.diff = same ? 'no difference' : m.diff(d);
                    out.verdict = same || m.better === null ? 'neutral'
                        : ((d > 0) === (m.better === 'up') ? 'good' : 'bad');
                }
                return out;
            }
            // The baseline's peak comes from its own sub-object, the rest from
            // its kpis; fold the peak in so every getter reads one shape.
            const mine = m.get(k);
            const theirs = m.get(Object.assign({}, bk,
                { peak_grid_import_kw: base.peak_grid_import_kw }));

            if (!have(mine)) {
                // Not "N/A": that reads as a fault. The usual reason is simply
                // that there is nothing to measure - no solar in this community
                // means no share of it to be used.
                return { m: m, none: true };
            }
            const out = { m: m, mine: m.show(mine) };
            if (have(theirs)) {
                const d = mine - theirs;
                // "No difference" rather than +0.0: one building, or members
                // with nothing to share, genuinely are the same alone.
                const same = Math.abs(d) < 1e-6 + Math.abs(theirs) * 5e-4;
                out.theirs = m.show(theirs);
                out.diff = same ? 'no difference' : m.diff(d);
                out.verdict = same || m.better === null ? 'neutral'
                    : ((d > 0) === (m.better === 'up') ? 'good' : 'bad');
            }
            return out;
        });

        const cell = function (cls, tone, content, title) {
            return '<div class="ecom-kpi-cell ' + cls + ' tone-' + tone + '"' +
                (title ? ' title="' + esc(title) + '"' : '') + '>' + content + '</div>';
        };

        const head = cols.map(function (c) {
            return cell('is-colhead', c.m.tone, esc(c.m.label), c.m.hint);
        }).join('');

        const row = function (name, cls, pick) {
            return '<div class="ecom-kpi-rowhead ' + cls + '">' + name + '</div>' +
                cols.map(function (c) {
                    if (c.pending) {
                        // Said once, in the first row; the others stay quiet.
                        return cell(cls + ' is-pending', c.m.tone,
                                    cls === 'is-with' ? esc(c.pending) : '',
                                    'The optimizer works these out. Make a change ' +
                                    'or press Run in the Optimizer tab.');
                    }
                    if (c.none) {
                        return cell(cls, c.m.tone, '&ndash;',
                                    'Nothing to measure for this in the community.');
                    }
                    return cell(cls, c.m.tone, pick(c));
                }).join('');
        };

        const rows =
            row('With the community', 'is-with', function (c) { return esc(c.mine); }) +
            row('Each building alone', 'is-alone', function (c) {
                return c.theirs === undefined ? '&ndash;' : esc(c.theirs);
            }) +
            row('Difference', 'is-diff', function (c) {
                return c.diff === undefined ? '&ndash;'
                    : '<span class="ecom-kpi-delta is-' + c.verdict + '">' +
                      esc(c.diff) + '</span>';
            });

        return '<div class="ecom-kpi-compare-head">' +
                   '<b>' + members + ' building' + (members === 1 ? '' : 's') + '</b>' +
                   ' &middot; ' + esc(mwh(k.total_demand)) + ' demand &middot; ' +
                   esc(mwh(k.total_pv_gen)) + ' solar' +
               '</div>' +
               '<div class="ecom-kpi-table" style="--kpi-cols:' + cols.length + '">' +
                   '<div class="ecom-kpi-corner"></div>' + head + rows +
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
            (comparable(layer)
                ? compareMarkup(k, layer)
                : '<div class="ecom-kpi-tiles">' +
                tile('eco', percent(k.self_sufficiency), 'Self-sufficient', 'green',
                     'Share of demand met without importing from the grid.') +
                tile('bolt', mwh(k.total_demand), 'Total demand', 'pink',
                     'Everything the member buildings consumed over the period.') +
                tile('wb_sunny', mwh(k.total_pv_gen), 'PV generated', 'yellow',
                     'What the roof arrays produced.') +
                // The optimizer's costs in place of the dispatch's grid import
                // and export - the table shows the optimizer's, so these do too.
                optTile('community', 'Cost as a community', 'cyan',
                        'Optimized cost of running the buildings as an energy community.') +
                optTile('separate', 'Cost as today', 'blue',
                        'Optimized cost of the same buildings each on its own connection.') +
                tile('recycling', percent(k.self_consumption), 'Self-consumed', 'green',
                     'Share of what the panels made that the community used itself.') +
            '</div>') +

            // The three columns below the tiles are detail, not headline. In the
            // strip along the foot of the page they are folded away until asked
            // for, so the figures that matter sit in one short row.
            '<button type="button" class="ecom-kpi-more" data-action="kpi-more"' +
                ' aria-expanded="' + !!state.kpiDetails + '">' +
                (state.kpiDetails ? 'Hide details' : 'Details') +
                '<span class="material-icons">' +
                    (state.kpiDetails ? 'expand_less' : 'expand_more') + '</span>' +
            '</button>' +

            '<div class="ecom-kpi-columns' + (state.kpiDetails ? ' is-open' : '') + '">' +
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
                        ((((state.working || {}).grid || {}).selling_price || {}).fixed === undefined
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

    /** Shortcuts to the hardest moments in each year of measured demand.
     *
     * A campus day picked at random is a mild one, and a battery or a tariff
     * that looks fine on it has not been asked a hard question. The peak hour
     * is the hour the community would have to answer for; the peak day is the
     * day a peak charge would be struck on. Both come from the backend, which
     * sums the measured CSVs - see app/services/peaks.py.
     */
    function peakChips() {
        if (!state.peaks || !state.peaks.length) return '';
        const label = function (month, day) {
            return day + ' ' + (MONTH_NAMES[month - 1] || '').slice(0, 3);
        };
        const chips = state.peaks.map(function (p) {
            const h = p.peak_hour;
            const d = p.peak_day;
            return '' +
                '<button type="button" class="ecom-peak-chip" ' +
                    'data-peak="hour" data-peak-year="' + p.year + '" ' +
                    'data-peak-month="' + h.month + '" data-peak-day="' + h.day + '" ' +
                    'data-peak-hour="' + h.hour + '" ' +
                    'title="The single busiest hour of ' + p.year + ': ' +
                        Math.round(h.kwh).toLocaleString() + ' kWh in that hour. ' +
                        'Loads that day and stops on it.">' +
                    '<b>' + p.year + ' peak hour</b>' +
                    '<span>' + label(h.month, h.day) + ' ' + pad(h.hour) + ':00</span>' +
                '</button>' +
                '<button type="button" class="ecom-peak-chip" ' +
                    'data-peak="day" data-peak-year="' + p.year + '" ' +
                    'data-peak-month="' + d.month + '" data-peak-day="' + d.day + '" ' +
                    'data-peak-hour="' + d.busiest_hour + '" ' +
                    'title="The busiest day of ' + p.year + ': ' +
                        Math.round(d.kwh).toLocaleString() + ' kWh over the day. ' +
                        'Opens on its busiest hour.">' +
                    '<b>' + p.year + ' peak day</b>' +
                    '<span>' + label(d.month, d.day) + '</span>' +
                '</button>';
        }).join('');
        return '<div class="ecom-peak-row">' +
                   '<label>Jump to</label>' + chips +
               '</div>';
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
                        '<span>solar now</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<div class="ecom-when">' +
                // Three selects rather than <input type="date">: the native
                // picker offers a year scroller that ignores min/max for
                // display, so it listed years going back to 2018 with no data
                // behind any of them. These can only offer what exists.
                '<div class="ecom-when-row ecom-when-row--date">' +
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

                '<div class="ecom-when-row ecom-when-row--span">' +
                    '<label for="ecom-span">Span</label>' +
                    '<input type="range" id="ecom-span" data-when="span"' +
                        ' min="1" max="14" step="1" value="' + state.spanDays + '">' +
                    '<b id="ecom-span-value" class="ecom-when-value">' +
                        spanLabel() +
                    '</b>' +
                '</div>' +
                '<span id="ecom-span-note" class="ecom-when-note"></span>' +
                // Filled once the backend answers; empty until then, so the
                // row does not flash an empty label on every render.
                '<div id="ecom-peaks">' + peakChips() + '</div>' +
                // Which control costs a dispatch and which is free, in one line
                // rather than a paragraph under every row.
                '<div class="ecom-when-legend">' +
                    '<span><i class="ecom-when-dot ecom-when-dot--cost"></i>' +
                        'date &amp; year re-dispatch</span>' +
                    '<span><i class="ecom-when-dot ecom-when-dot--free"></i>' +
                        'hour is free</span>' +
                '</div>' +

                '<div class="ecom-when-row ecom-when-row--hour">' +
                    '<label for="ecom-hour">Hour</label>' +
                    '<input type="range" id="ecom-hour" data-when="hour"' +
                        ' min="0" max="' + Math.max(0, state.hours - 1) + '" step="1"' +
                        ' value="' + state.hour + '">' +
                    '<button type="button" class="ecom-when-play" data-action="play"' +
                        ' title="' + esc(playTitle()) + '">' +
                        (state.playing ? '❚❚' : '▶') +
                    '</button>' +
                '</div>' +
            '</div>';
    }

    // Patched in place, never re-rendered: this runs on every tick of the
    // table clock, and rebuilding the panel each second would snatch away
    // whatever slider is under a finger.
    function paintSky() {
        // The spot chart keeps the table's hour too. Here, because every hour
        // change already comes through this function.
        paintSpotNow();
        // And the sharing graph, when it is showing one hour: it is that hour's
        // picture, so it is redrawn as the hour moves on.
        if (state.profileView === 'sharing' && state.shareMode === 'hour' &&
            state.hour !== lastSharingHour) {
            lastSharingHour = state.hour;
            paintProfiles();
        }
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
        // The same hour, on the load-profile chart.
        paintProfileCursor();
    }

    // ---------------------------------------------------- load profiles
    //
    // The hourly demand of every building in the community, on one chart. Tick a
    // building in Members and its line joins the others; untick it and it goes.
    // It sits beside the Members list rather than in a group of its own, so the
    // thing being changed and the thing it changes are in the same view - and it
    // is not part of the one-group-open-at-a-time accordion, because a chart
    // that vanishes when you open the list that drives it is no use.
    //
    // Read from the dispatched layer, which carries `demand_hourly` on every
    // building node, so it shows exactly the hours the table is running and
    // changes when the date, the span or the year does.

    // Where the last chart put its axes, so the clock cursor and the hover line
    // can be moved without rebuilding it.
    let profileGeom = null;

    /** A colour for a building that stays its colour as others come and go.
     *
     * Indexed by where the building sits in the whole campus list rather than in
     * the current members, or every line would change colour each time someone
     * was ticked in. The golden angle spreads the hues so neighbours in the list
     * are not neighbours on the colour wheel.
     */
    function profileColour(name) {
        const all = (state.base && state.base.buildings) || [];
        let index = all.findIndex(function (b) { return b.name === name; });
        if (index < 0) index = all.length;
        return 'hsl(' + Math.round((index * 137.508) % 360) + ', 78%, 64%)';
    }

    /** The members' hourly demand, from the layer on the table. */
    function memberProfiles() {
        const layer = state.layer;
        if (!layer || !layer.nodes) return [];
        const all = (state.base && state.base.buildings) || [];
        const order = function (name) {
            const i = all.findIndex(function (b) { return b.name === name; });
            return i < 0 ? all.length : i;
        };
        return (layer.nodes.features || [])
            .map(function (f) { return f.properties || {}; })
            .filter(function (p) {
                return p.kind === 'building' && Array.isArray(p.demand_hourly) &&
                       p.demand_hourly.length;
            })
            .map(function (p) {
                return { name: p.name || p.id, owner: p.owner || '',
                         series: p.demand_hourly };
            })
            .sort(function (a, b) { return order(a.name) - order(b.name); });
    }

    /** A round number at or above v, from the 1-2-5 ladder. */
    function niceCeiling(v) {
        if (!(v > 0)) return 1;
        const power = Math.pow(10, Math.floor(Math.log10(v)));
        const f = v / power;
        return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power;
    }

    function compactNumber(v) {
        if (v >= 1000) return (v / 1000).toLocaleString(undefined,
            { maximumFractionDigits: 1 }) + 'k';
        return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }

    /** "2 Jun 14:00" for hour i of the period on the table. */
    function profileWhen(i) {
        const day = fromDayOfYear(dayOfYear(state.startMonth, state.startDay) +
                                  Math.floor(i / 24));
        return day.day + ' ' + (MONTH_NAMES[day.month - 1] || '').slice(0, 3) +
               ' ' + pad(i % 24) + ':00';
    }

    /** The size to draw the chart at: the size it will be shown at.
     *
     * SVG text scales with its box, so a drawing made at one size and shown at
     * another comes out too big or - worse, on a panel already told off for it -
     * too small. The card is measured instead of assumed, and the height is
     * whatever the card has left after its heading, readout, legend and hints,
     * so the chart fills the card rather than pushing the legend off the end.
     * Before the card exists there is nothing to measure, and a default stands
     * in until render() has put it on the page and measured it.
     */
    function profileSize() {
        const body = document.getElementById('ecom-profiles');
        const card = body && body.closest('.ecom-profiles-card');
        if (!body || !card || !body.clientWidth) return { w: 640, h: 320 };
        const w = Math.max(420, body.clientWidth - 24);
        const h = Math.max(200, Math.min(400, card.clientHeight - 245));
        return { w: Math.round(w), h: Math.round(h) };
    }

    function profileChart(profiles) {
        const size = profileSize();
        const W = size.w, H = size.h, L = 50, R = 12, T = 12, B = 42;
        const plotW = W - L - R;
        const plotH = H - T - B;
        const share = state.profileMode === 'share';

        const lines = profiles.map(function (p) {
            const peak = Math.max.apply(null, p.series.concat([0]));
            return {
                name: p.name,
                peak: peak,
                values: share
                    ? p.series.map(function (v) { return peak > 0 ? v / peak * 100 : 0; })
                    : p.series
            };
        });

        const n = Math.max.apply(null, lines.map(function (l) { return l.values.length; }));
        const top = share ? 100 : niceCeiling(Math.max.apply(null,
            lines.map(function (l) { return Math.max.apply(null, l.values); })));
        const xAt = function (i) { return L + (n > 1 ? i / (n - 1) : 0.5) * plotW; };
        const yAt = function (v) { return T + plotH - Math.min(v, top) / top * plotH; };

        profileGeom = { width: W, height: H, left: L, plotW: plotW, top: T,
                        bottom: T + plotH, n: n, lines: lines, share: share,
                        yAt: yAt };

        // Horizontal gridlines: five equal steps up to a round number.
        let grid = '';
        for (let s = 0; s <= 5; s += 1) {
            const v = top * s / 5;
            grid += '<line class="ecom-prof-grid" x1="' + L + '" x2="' + (L + plotW) +
                    '" y1="' + yAt(v).toFixed(1) + '" y2="' + yAt(v).toFixed(1) + '"/>' +
                    '<text class="ecom-prof-tick" x="' + (L - 8) + '" y="' +
                    (yAt(v) + 4).toFixed(1) + '" text-anchor="end">' +
                    esc(share ? Math.round(v) + '%' : compactNumber(v)) + '</text>';
        }

        // Vertical: every six hours on a short period, every midnight on a long
        // one. Midnights are always marked, with the date underneath.
        let axis = '';
        const everyDay = n > 72;
        for (let h = 0; h < n; h += 1) {
            const midnight = h % 24 === 0;
            const mark = everyDay ? midnight : (h % 6 === 0);
            if (!mark) continue;
            const x = xAt(h).toFixed(1);
            axis += '<line class="ecom-prof-vgrid' + (midnight ? ' is-day' : '') +
                    '" x1="' + x + '" x2="' + x + '" y1="' + T + '" y2="' + (T + plotH) + '"/>';
            if (!everyDay) {
                axis += '<text class="ecom-prof-tick" x="' + x + '" y="' + (T + plotH + 16) +
                        '" text-anchor="middle">' + pad(h % 24) + '</text>';
            }
            if (midnight) {
                const d = fromDayOfYear(dayOfYear(state.startMonth, state.startDay) + h / 24);
                axis += '<text class="ecom-prof-day" x="' + x + '" y="' + (T + plotH + 33) +
                        '" text-anchor="' + (h === 0 ? 'start' : 'middle') + '">' +
                        d.day + ' ' + esc((MONTH_NAMES[d.month - 1] || '').slice(0, 3)) + '</text>';
            }
        }

        // The followed building is drawn last, so it sits on top.
        const focus = state.profileFocus;
        const ordered = lines.slice().sort(function (a, b) {
            return (a.name === focus ? 1 : 0) - (b.name === focus ? 1 : 0);
        });
        const paths = ordered.map(function (line) {
            const points = line.values.map(function (v, i) {
                return xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1);
            }).join(' ');
            const dim = focus && line.name !== focus;
            return '<polyline class="ecom-prof-line' + (line.name === focus ? ' is-focus' : '') +
                   '" data-name="' + esc(line.name) +
                   '" points="' + points + '" stroke="' + profileColour(line.name) +
                   '" style="opacity:' + (dim ? 0.12 : 1) + '"><title>' +
                   esc(line.name) + ' - peak ' + Math.round(line.peak).toLocaleString() +
                   ' kW</title></polyline>';
        }).join('');

        return '<svg class="ecom-prof-svg" viewBox="0 0 ' + W + ' ' + H + '"' +
                   ' role="img" aria-label="Hourly demand of each member building">' +
                   grid + axis + paths +
                   '<line id="ecom-prof-now" class="ecom-prof-now" y1="' + T + '" y2="' +
                       (T + plotH) + '" x1="' + xAt(state.hour % n).toFixed(1) + '" x2="' +
                       xAt(state.hour % n).toFixed(1) + '"/>' +
                   '<line id="ecom-prof-hover" class="ecom-prof-hover" y1="' + T + '" y2="' +
                       (T + plotH) + '" x1="0" x2="0" style="display:none"/>' +
                   // Which building the pointer is on: a dot on the line and its
                   // name beside it, filled in by onProfileMove.
                   '<g id="ecom-prof-tip" class="ecom-prof-tip" style="display:none">' +
                       '<circle r="5"/><text></text></g>' +
               '</svg>';
    }

    /** What is inside the card: it is rebuilt on its own, without the band. */
    function profilesBody() {
        const profiles = memberProfiles();
        if (!profiles.length) {
            profileGeom = null;
            return '<p class="ecom-ctl-empty">' +
                (memberCount()
                    ? 'Working out the profiles…'
                    : 'Tick a building in Members to see its load profile here. ' +
                      'Each one you add joins the same chart.') +
                '</p>';
        }

        const stale = state.dirty || state.busy;
        const layer = state.layer || {};
        const mode = state.profileMode === 'share' ? 'share' : 'kw';

        const chips = profiles.map(function (p) {
            const on = state.profileFocus === p.name;
            return '<button type="button" class="ecom-prof-chip' + (on ? ' is-on' : '') + '"' +
                ' data-profile-focus="' + esc(p.name) + '" title="' +
                esc(p.name) + ' - tap to follow this one">' +
                '<i style="background:' + profileColour(p.name) + '"></i>' +
                esc(p.name) + '</button>';
        }).join('');

        return '' +
            '<div class="ecom-prof-top">' +
                '<span class="ecom-prof-count">' + profiles.length + ' building' +
                    (profiles.length > 1 ? 's' : '') +
                    (layer.meta && layer.meta.period
                        ? ' &middot; ' + esc(layer.meta.period) : '') +
                    (stale ? ' &middot; <em>updating…</em>' : '') + '</span>' +
                '<span class="ecom-seg">' +
                    '<button type="button" data-profile-mode="kw"' +
                        (mode === 'kw' ? ' class="is-on"' : '') +
                        ' title="Each building in kW, on one shared scale.">kW</button>' +
                    '<button type="button" data-profile-mode="share"' +
                        (mode === 'share' ? ' class="is-on"' : '') +
                        ' title="Each building as a share of its own peak, so the ' +
                        'shapes can be compared whatever the size.">% of own peak</button>' +
                '</span>' +
            '</div>' +
            '<div id="ecom-prof-readout" class="ecom-prof-readout">&nbsp;</div>' +
            '<div class="ecom-prof-plot' + (stale ? ' is-stale' : '') + '">' +
                profileChart(profiles) + '</div>' +
            '<div class="ecom-prof-legend">' + chips + '</div>' +
            profileScaleHint(profiles, mode) +
            '<span class="ecom-ctl-hint">Tap a name to follow one building. ' +
                'The vertical line is the hour on the table.</span>';
    }

    /** Say why most of the lines are flat, when they are.
     *
     * One large building sets the scale for all of them: MC2 draws about a
     * megawatt against tens of kilowatts for most of the campus, so on a shared
     * kW axis everyone else is a line along the bottom - which looks like a bug
     * rather than a scale. The other view exists for exactly this.
     */
    function profileScaleHint(profiles, mode) {
        if (mode !== 'kw' || profiles.length < 2) return '';
        const peaks = profiles.map(function (p) {
            return { name: p.name, peak: Math.max.apply(null, p.series) };
        }).sort(function (a, b) { return b.peak - a.peak; });
        const median = peaks[Math.floor(peaks.length / 2)].peak;
        if (!(median > 0) || peaks[0].peak < median * 8) return '';
        return '<span class="ecom-ctl-hint ecom-prof-scale">' + esc(peaks[0].name) +
            ' is far larger than the rest, so they sit near zero on this scale. ' +
            'Switch to <b>% of own peak</b> to compare their shapes.</span>';
    }

    function profilesCard() {
        const sharingView = state.profileView === 'sharing';
        return '<div class="ecom-ctl-group ecom-ctl-group--pink is-open ecom-profiles-card">' +
            '<div class="ecom-ctl-head ecom-profiles-head">' +
                '<span class="material-icons ecom-ctl-head-icon">' +
                    (sharingView ? 'hub' : 'timeline') + '</span>' +
                // Two views in one card: the space is there, and a second card
                // would squeeze both.
                '<span class="ecom-seg ecom-view-tabs">' +
                    '<button type="button" data-profile-view="profiles"' +
                        (sharingView ? '' : ' class="is-on"') + '>Load profiles</button>' +
                    '<button type="button" data-profile-view="sharing"' +
                        (sharingView ? ' class="is-on"' : '') + '>Sharing</button>' +
                '</span>' +
            '</div>' +
            '<div id="ecom-profiles" class="ecom-ctl-body ecom-profiles-body">' +
                (sharingView ? sharingBody() : profilesBody()) +
            '</div>' +
        '</div>';
    }

    /** Rebuild the chart in place. Cheap, and safe mid-drag: nothing under a
     *  finger is inside it. */
    function paintProfiles() {
        const body = document.getElementById('ecom-profiles');
        if (body) body.innerHTML = state.profileView === 'sharing' ? sharingBody() : profilesBody();
    }

    // ------------------------------------------------------- sharing graph
    //
    // Who gives energy to whom inside the community, over the period on the
    // table: a weighted directed graph. Each member sits where it is on the
    // campus, shrunk to the card, so "nearest first" can be seen for what it
    // is; an arrow A -> B is what A gave B, as thick as the kWh, yellow where
    // it was mostly solar and red where it was mostly a battery's. Only the
    // strongest connections are drawn - thirty buildings all linked is a
    // hairball - and the ones left out are counted.
    const SHARE_W = 600;
    const SHARE_H = 300;
    const SHARE_PAD = 34;
    const SHARE_MAX_EDGES = 12;
    const SHARING_RULE_LABELS = {
        order: 'in list order',
        proportional: 'in proportion to need',
        nearest: 'nearest first'
    };

    /**
     * Totals per link from the layer, [{from, to, kwh, solar, battery, origin}]:
     * member to member (the sharing), and the grid, a community battery and
     * community solar to the members - so a community with nothing to share
     * still shows where its energy comes from.
     */
    /** A series summed over the period, or its value at one hour. */
    function shareAmount(series, hour) {
        const s = series || [];
        if (hour !== null && hour !== undefined) return Math.max(0, s[hour] || 0);
        return s.reduce(function (t, v) { return t + Math.max(0, v || 0); }, 0);
    }

    function sharingEdges(layer, hour) {
        const pairs = {};
        ((layer && layer.flows && layer.flows.features) || []).forEach(function (f) {
            const p = f.properties || {};
            const origin = p.origin || p.kind;
            const into = p.target_kind;
            const wanted = origin === 'building'
                ? into === 'building'
                : (origin === 'grid' || origin === 'battery' || origin === 'pv') &&
                  (into === 'building' || into === 'charge_point');
            if (!wanted) return;
            const kwh = shareAmount(p.flow_hourly, hour);
            if (!(kwh > 0.0005)) return;
            const key = p.source + '>' + p.target;
            const e = pairs[key] || (pairs[key] = {
                from: p.source, to: p.target, kwh: 0, solar: 0, battery: 0, origin: origin
            });
            e.kwh += kwh;
            if (p.kind === 'battery') e.battery += kwh;
            else if (p.kind === 'pv') e.solar += kwh;
        });
        return Object.keys(pairs).map(function (k) { return pairs[k]; })
            .sort(function (a, b) { return b.kwh - a.kwh; });
    }

    // The grid supplies far more than members pass between them: on one scale
    // every sharing arrow would be a hairline next to it. So the grid's arrows
    // are scaled among themselves, drawn thinner and fainter, and capped.
    const SHARE_MAX_GRID_EDGES = 10;
    // The hour the sharing graph was last drawn for, so a repaint of the sky
    // that is not an hour change does not redraw it.
    let lastSharingHour = null;
    const SHARE_COLOURS = { grid: '#00ffe5', battery: '#fa3600', solar: '#eaff00', building: '#ff2bd6' };

    function sharingBody() {
        const layer = state.layer;
        const rule = (state.working && state.working.sharing_rule) || 'order';
        const ruleLine = '<span class="ecom-ctl-hint">Sharing rule: <b>' +
            esc(SHARING_RULE_LABELS[rule] || rule) + '</b> - change it in the Community tab.</span>';
        if (!layer || !layer.flows) {
            return '<p class="ecom-ctl-empty">Tick buildings in Members and the energy they ' +
                'share with each other appears here.</p>' + ruleLine;
        }
        // The whole period, or the hour the table is on - which then redraws
        // as the clock moves (see paintSky).
        const hours = (layer.meta && layer.meta.hours) || state.hours || 24;
        const hourMode = state.shareMode === 'hour';
        const hour = hourMode ? ((state.hour || 0) % Math.max(1, hours)) : null;
        const when = hourMode
            ? 'at ' + String(hour % 24).padStart(2, '0') + ':00, day ' + (Math.floor(hour / 24) + 1)
            : 'over ' + ((layer.meta && layer.meta.period) || 'the period');
        const toggle = '<span class="ecom-seg">' +
            '<button type="button" data-share-mode="period"' + (hourMode ? '' : ' class="is-on"') +
                ' title="Totals over the days on the table.">Whole period</button>' +
            '<button type="button" data-share-mode="hour"' + (hourMode ? ' class="is-on"' : '') +
                ' title="The hour the table is on, following its clock.">This hour</button>' +
            '</span>';

        const everything = sharingEdges(layer, hour);
        const all = everything.filter(function (e) { return e.origin === 'building'; });
        const supply = everything.filter(function (e) { return e.origin !== 'building'; });

        // Each member's own solar, used where it was made - never an arrow,
        // because it never leaves the building. The ring around a member.
        const ownSolar = {};
        ((layer.nodes && layer.nodes.features) || []).forEach(function (f) {
            const p = f.properties || {};
            if (p.kind === 'building') ownSolar[p.id] = shareAmount(p.solar_hourly, hour);
        });
        if (!everything.length && !Object.keys(ownSolar).some(function (k) { return ownSolar[k] > 0; })) {
            return '<div class="ecom-share-top">' + toggle + '</div>' +
                '<p class="ecom-ctl-empty">Nothing flowed ' + esc(when) + '.</p>' + ruleLine;
        }
        const gridEdges = supply.filter(function (e) { return e.origin === 'grid'; })
            .slice(0, SHARE_MAX_GRID_EDGES);
        const localEdges = supply.filter(function (e) { return e.origin !== 'grid'; });
        const edges = all.slice(0, SHARE_MAX_EDGES).concat(localEdges);

        // Where everything is, from the layer's own markers, and what it is.
        const where = {};
        const kindOf = {};
        ((layer.nodes && layer.nodes.features) || []).forEach(function (f) {
            if (f.properties && f.geometry) {
                where[f.properties.id] = f.geometry.coordinates;
                kindOf[f.properties.id] = f.properties.kind;
            }
        });
        // Every member, arrows or not - at an hour when a building only uses its
        // own solar it still belongs on the picture, with its ring.
        const names = Object.keys(ownSolar);
        edges.concat(gridEdges).forEach(function (e) {
            [e.from, e.to].forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });
        });
        const pts = names.map(function (n) { return where[n]; }).filter(Boolean);
        const lat0 = pts.length ? pts.reduce(function (s, c) { return s + c[1]; }, 0) / pts.length : 57.69;
        const kx = Math.cos(lat0 * Math.PI / 180);
        const xs = pts.map(function (c) { return c[0] * kx; });
        const ys = pts.map(function (c) { return c[1]; });
        const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
        const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        // One scale for both directions, the largest that fits the card both
        // ways - so the campus keeps its shape and nothing falls off an edge.
        const scale = Math.min((SHARE_W - 2 * SHARE_PAD) / Math.max(maxX - minX, 1e-6),
                               (SHARE_H - 2 * SHARE_PAD) / Math.max(maxY - minY, 1e-6));
        const pos = {};
        names.forEach(function (n, i) {
            const c = where[n];
            if (c) {
                pos[n] = {
                    x: SHARE_W / 2 + ((c[0] * kx) - (minX + maxX) / 2) * scale,
                    y: SHARE_H / 2 - (c[1] - (minY + maxY) / 2) * scale + 6
                };
            } else {
                // No marker for it: on a ring, so it is still shown.
                const a = 2 * Math.PI * i / names.length;
                pos[n] = { x: SHARE_W / 2 + 0.4 * SHARE_W * Math.cos(a), y: SHARE_H / 2 + 0.4 * SHARE_H * Math.sin(a) };
            }
        });

        const maxShare = Math.max(1e-6, edges.reduce(function (m, e) { return Math.max(m, e.kwh); }, 0));
        const maxGrid = Math.max(1e-6, gridEdges.reduce(function (m, e) { return Math.max(m, e.kwh); }, 0));
        const given = {}, received = {}, bought = {};
        all.forEach(function (e) {
            given[e.from] = (given[e.from] || 0) + e.kwh;
            received[e.to] = (received[e.to] || 0) + e.kwh;
        });
        supply.forEach(function (e) {
            if (e.origin === 'grid') bought[e.to] = (bought[e.to] || 0) + e.kwh;
        });

        // What an arrow carries decides its colour: the grid teal, a battery red,
        // solar yellow. A member's line takes the colour of what it mostly carried.
        const colourOf = function (e) {
            if (e.origin === 'grid') return 'grid';
            if (e.origin === 'battery' || e.battery > e.solar) return 'battery';
            return 'solar';
        };
        const R = 7;
        const arrow = function (e, isGrid) {
            const a = pos[e.from], b = pos[e.to];
            if (!a || !b) return '';
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.max(1, Math.hypot(dx, dy));
            // Curved, so A->B and B->A are two arcs rather than one line, and
            // stopped short of the circles so the arrowhead shows.
            const ux = dx / len, uy = dy / len;
            const sx = a.x + ux * R, sy = a.y + uy * R, ex = b.x - ux * (R + 3), ey = b.y - uy * (R + 3);
            const bend = Math.min(40, len * 0.2);
            const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
            const c = colourOf(e);
            const width = isGrid ? 0.8 + 3.2 * e.kwh / maxGrid : 1.2 + 6 * e.kwh / maxShare;
            const label = e.from + ' -> ' + e.to + ': ' + Math.round(e.kwh).toLocaleString() + ' kWh' +
                (e.origin === 'building'
                    ? ' (' + Math.round(e.solar).toLocaleString() + ' solar, ' +
                      Math.round(e.battery).toLocaleString() + ' battery)' : '');
            return '<path d="M' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' +
                cy.toFixed(1) + ' ' + ex.toFixed(1) + ' ' + ey.toFixed(1) + '" fill="none" stroke="' +
                SHARE_COLOURS[c] + '" stroke-opacity="' + (isGrid ? 0.5 : 0.88) +
                '" stroke-width="' + width.toFixed(1) + '" marker-end="url(#share-arrow-' + c + ')">' +
                '<title>' + esc(label) + '</title></path>';
        };
        // Grid first, underneath; what members share on top.
        const lines = gridEdges.map(function (e) { return arrow(e, true); }).join('') +
                      edges.map(function (e) { return arrow(e, false); }).join('');

        const maxOwn = Math.max(1e-6, Object.keys(ownSolar).reduce(function (m, k) {
            return Math.max(m, ownSolar[k]);
        }, 0));
        const fmt = function (v) { return (hourMode ? v.toFixed(1) : Math.round(v).toLocaleString()) + ' kWh'; };
        const dots = names.map(function (n) {
            const p = pos[n];
            if (!p) return '';
            const kind = kindOf[n] || 'building';
            const fill = kind === 'grid' ? SHARE_COLOURS.grid
                : kind === 'battery' ? SHARE_COLOURS.battery
                : kind === 'pv' ? SHARE_COLOURS.solar
                : kind === 'charge_point' ? '#34d399' : SHARE_COLOURS.building;
            const label = kind === 'grid' ? 'Grid' : n;
            const tip = kind === 'building'
                ? n + ' ' + when + ': own solar ' + fmt(ownSolar[n] || 0) +
                  ', from members ' + fmt(received[n] || 0) +
                  ', from the grid ' + fmt(bought[n] || 0) +
                  ', gave to members ' + fmt(given[n] || 0)
                : label;
            // Own solar, used where it was made: a yellow ring round the member,
            // wider the more it used. It never leaves the building, so it is
            // not an arrow - but it is used first, before anything is shared.
            const own = kind === 'building' ? (ownSolar[n] || 0) : 0;
            const ring = own > 0
                ? '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' +
                  (R + 2 + 7 * own / maxOwn).toFixed(1) + '" fill="' + SHARE_COLOURS.solar +
                  '" fill-opacity="0.28" stroke="' + SHARE_COLOURS.solar + '" stroke-opacity="0.7"' +
                  ' stroke-width="1"><title>' + esc(n + ' used ' + fmt(own) + ' of its own solar ' + when) +
                  '</title></circle>'
                : '';
            if (ring) return '<g>' + ring + dotShape(n, p, kind, fill, tip, label) + '</g>';
            return '<g>' + dotShape(n, p, kind, fill, tip, label) + '</g>';
        }).join('');
        function dotShape(n, p, kind, fill, tip, label) {
            // The grid, a battery and community solar are squares: sources, not members.
            const shape = kind === 'building'
                ? '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + R + '"'
                : '<rect x="' + (p.x - R).toFixed(1) + '" y="' + (p.y - R).toFixed(1) +
                  '" width="' + (2 * R) + '" height="' + (2 * R) + '" rx="2"';
            return shape + ' fill="' + fill + '" stroke="#1a1a1e" stroke-width="2">' +
                '<title>' + esc(tip) + '</title></' + (kind === 'building' ? 'circle' : 'rect') + '>' +
                '<text x="' + p.x.toFixed(1) + '" y="' + (p.y - R - 11).toFixed(1) +
                '" text-anchor="middle" fill="#e4e4e7" font-size="12">' + esc(label) + '</text>';
        }
        const marker = function (id, colour) {
            return '<marker id="share-arrow-' + id + '" viewBox="0 0 10 10" refX="8" refY="5" ' +
                'markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
                '<path d="M0 0 L10 5 L0 10 z" fill="' + colour + '"/></marker>';
        };

        const top = function (map, n) {
            return Object.keys(map).filter(function (k) { return map[k] > 0.0005; })
                .sort(function (a, b) { return map[b] - map[a]; }).slice(0, n)
                .map(function (k) { return '<b>' + esc(k) + '</b> ' + fmt(map[k]); })
                .join(' &middot; ');
        };
        const stale = state.dirty || state.busy;
        const rank =
            '<span>Own solar used first: ' + (top(ownSolar, 5) || 'none ' + esc(when)) + '</span>' +
            (all.length
                ? '<span>Receives most from members: ' + top(received, 3) + '</span>' +
                  '<span>Gives most to members: ' + top(given, 3) + '</span>'
                : '<span>No member gave energy to another ' + esc(when) + ' - that needs ' +
                  'solar left over after a building has covered itself.</span>');
        return '<div class="ecom-share-top">' +
                '<span>' + all.length + ' sharing link' + (all.length === 1 ? '' : 's') +
                    (all.length > SHARE_MAX_EDGES ? ' &middot; strongest ' + SHARE_MAX_EDGES + ' shown' : '') +
                    ' &middot; ' + esc(when) +
                    (stale ? ' &middot; <em>updating…</em>' : '') + '</span>' +
                toggle +
            '</div>' +
            '<svg class="ecom-share-svg' + (stale ? ' is-stale' : '') + '" viewBox="0 0 ' + SHARE_W + ' ' + SHARE_H + '"' +
                ' role="img" aria-label="Where the members\' energy comes from">' +
                '<defs>' + marker('solar', SHARE_COLOURS.solar) + marker('battery', SHARE_COLOURS.battery) +
                    marker('grid', SHARE_COLOURS.grid) + '</defs>' +
                lines + dots +
            '</svg>' +
            '<div class="ecom-share-rank">' + rank +
                '<span>Buys most from the grid: ' + (top(bought, 3) || '-') + '</span>' +
            '</div>' +
            '<span class="ecom-ctl-hint">The yellow ring is a member\'s own solar, used ' +
                'first and never shared. Arrows show where the rest of its energy came from; ' +
                'thicker is more. Teal from the grid (on a scale of its own, ' +
                'it is much larger), yellow solar, red battery - between members or from the ' +
                'community\'s own. Members are circles, sources squares, where they are on the campus.</span>' +
            ruleLine;
    }
    /** Move the clock line to the hour the table is on. */
    function paintProfileCursor() {
        const line = document.getElementById('ecom-prof-now');
        if (!line || !profileGeom) return;
        const g = profileGeom;
        const i = g.n > 0 ? state.hour % g.n : 0;
        const x = g.left + (g.n > 1 ? i / (g.n - 1) : 0.5) * g.plotW;
        line.setAttribute('x1', x.toFixed(1));
        line.setAttribute('x2', x.toFixed(1));
    }

    /** Follow the pointer along the chart: the hour, and what the community
     *  draws at it. */
    // How far from a line, in the chart's own units, the pointer still counts as
    // being on it. A line is a pixel or two wide and a finger is not, so it is a
    // reach rather than an exact hit.
    const PROFILE_REACH = 16;

    // The line last named, so the DOM is only touched when it changes.
    let profileHovered = null;

    function clearProfileHover(svg) {
        profileHovered = null;
        const tip = document.getElementById('ecom-prof-tip');
        if (tip) tip.style.display = 'none';
        const hover = document.getElementById('ecom-prof-hover');
        if (hover) hover.style.display = 'none';
        if (svg) {
            svg.classList.remove('has-hover');
            svg.querySelectorAll('.ecom-prof-line.is-hover').forEach(function (l) {
                l.classList.remove('is-hover');
            });
        }
    }

    /** Follow the pointer along the chart: the hour, what the community draws
     *  at it, and - when the pointer is on a line - whose line that is.
     *
     *  Every line is the same thin stroke in a different colour, and with thirty
     *  of them the legend is a key to a pattern nobody can match by eye. So the
     *  line under the pointer is found, lifted out of the rest, and named. */
    function onProfileMove(event) {
        const svg = event.target && event.target.closest
            ? event.target.closest('.ecom-prof-svg') : null;
        const readout = document.getElementById('ecom-prof-readout');
        if (!svg || !profileGeom) {
            clearProfileHover(document.querySelector('.ecom-prof-svg'));
            return;
        }
        const g = profileGeom;
        const box = svg.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const vx = (event.clientX - box.left) / box.width * g.width;
        const vy = (event.clientY - box.top) / box.height * g.height;
        const frac = (vx - g.left) / g.plotW;
        const i = Math.max(0, Math.min(g.n - 1, Math.round(frac * (g.n - 1))));
        const x = g.left + (g.n > 1 ? i / (g.n - 1) : 0.5) * g.plotW;

        const hover = document.getElementById('ecom-prof-hover');
        if (hover) {
            hover.setAttribute('x1', x.toFixed(1));
            hover.setAttribute('x2', x.toFixed(1));
            hover.style.display = '';
        }

        // The line nearest the pointer, at the hour the pointer is over.
        let near = null;
        let gap = Infinity;
        g.lines.forEach(function (line) {
            const y = g.yAt(line.values[i] || 0);
            const d = Math.abs(y - vy);
            if (d < gap) { gap = d; near = { line: line, y: y }; }
        });
        if (gap > PROFILE_REACH) near = null;

        const tip = document.getElementById('ecom-prof-tip');
        if (near) {
            const unit = g.share ? '%' : ' kW';
            const value = Math.round(near.line.values[i] || 0).toLocaleString() + unit;

            if (profileHovered !== near.line.name) {
                profileHovered = near.line.name;
                svg.classList.add('has-hover');
                svg.querySelectorAll('.ecom-prof-line').forEach(function (l) {
                    const on = l.getAttribute('data-name') === near.line.name;
                    l.classList.toggle('is-hover', on);
                    // Drawn last, so it is not buried under the lines after it.
                    if (on && tip) l.parentNode.insertBefore(l, tip);
                });
            }
            if (tip) {
                const colour = profileColour(near.line.name);
                const circle = tip.querySelector('circle');
                const label = tip.querySelector('text');
                circle.setAttribute('cx', x.toFixed(1));
                circle.setAttribute('cy', near.y.toFixed(1));
                circle.setAttribute('fill', colour);
                label.textContent = near.line.name + '  ' + value;
                // On the side with room: a name running off the edge of the
                // chart is a name nobody can read.
                const right = x < g.width * 0.62;
                label.setAttribute('x', (right ? x + 10 : x - 10).toFixed(1));
                label.setAttribute('y', Math.max(14, near.y - 9).toFixed(1));
                label.setAttribute('text-anchor', right ? 'start' : 'end');
                label.setAttribute('fill', colour);
                tip.style.display = '';
            }
        } else if (profileHovered !== null) {
            clearProfileHover(svg);
            // The cursor line belongs to the pointer, not to a building.
            if (hover) hover.style.display = '';
        }

        if (!readout) return;
        let text = profileWhen(i);
        if (!g.share) {
            const total = g.lines.reduce(function (sum, line) {
                return sum + (line.values[i] || 0);
            }, 0);
            text += ' &middot; community ' + Math.round(total).toLocaleString() + ' kW';
        }
        // The building under the pointer wins over the one being followed.
        const focus = state.profileFocus;
        const one = near ? near.line
            : (focus && g.lines.find(function (line) { return line.name === focus; }));
        if (one) {
            text += ' &middot; <b style="color:' + profileColour(one.name) + '">' +
                    esc(one.name) + '</b> ' +
                    Math.round(one.values[i] || 0).toLocaleString() +
                    (g.share ? '%' : ' kW');
        }
        readout.innerHTML = text;
    }

    /** Community arrays: the plants no building names. */
    function communityPlants() {
        const named = new Set();
        (state.working.buildings || []).forEach(function (b) {
            (b.pv_plants || []).forEach(function (n) { named.add(n); });
        });
        return (state.working.pv_plants || []).filter(function (p) {
            return !named.has(p.name);
        });
    }

    function sharedPv() {
        const plants = communityPlants();
        if (!plants.length) return '';
        return plants.map(function (p, index) {
            const kw = Math.round(plantKw(p));
            return '<div class="ecom-kit-size is-pv">' +
                '<label><span class="material-icons">solar_power</span>' +
                    esc(p.name) + '</label>' +
                '<input type="range" data-shared-size="pv" data-shared-index="' +
                    index + '" min="50" max="20000" step="50" value="' +
                    Math.round(p.surface_area || 0) + '">' +
                '<b data-shared-readout="pv:' + index + '">' + kw + ' kW</b>' +
                '</div>';
        }).join('');
    }

    // ---------------------------------------------------- the real battery
    //
    // AWL's battery is a real one, and the site publishes what it is doing. The
    // model above is a proposal; this is the building. Shown side by side and
    // labelled, because the two will not agree - the site runs its own control
    // and the model does not know about it - and a reader who cannot tell
    // which is which learns nothing from either.
    //
    // Read-only. The same gateway takes setpoints; this panel never sends one.
    const LIVE_EVERY_MS = 5000;

    let liveTimer = null;

    function watchLive() {
        if (liveTimer !== null || state.api === null) return;
        const tick = async function () {
            try {
                const reading = await getJson('/api/live/battery');
                const was = JSON.stringify(state.live);
                state.live = reading;
                // Only when something changed, and only the reading itself: this
                // fires every five seconds, and re-rendering the members list
                // under a finger moves the slider it is resting on.
                if (JSON.stringify(reading) !== was) paintLive();
            } catch (error) {
                state.live = { available: false, detail: String(error.message || error) };
            }
        };
        tick();
        liveTimer = setInterval(tick, LIVE_EVERY_MS);
    }

    // The building the gateway reports for. The readout sits on its row in
    // Members, under its battery, because that is the battery it is reading.
    const LIVE_BATTERY_HOST = 'AWL';

    /** The readout with the wrapper paintLive finds it by. */
    function liveBlock() {
        return '<div id="ecom-live-battery" class="ecom-kit-live">' + liveBattery() + '</div>';
    }

    /** Swap in a new reading without redrawing the panel around it. */
    function paintLive() {
        const el = document.getElementById('ecom-live-battery');
        if (el) el.innerHTML = liveBattery();
    }

    /** The live reading of the real battery. */
    function liveBattery() {
        const live = state.live;
        if (!live) return '';
        if (!live.available) {
            return '<span class="ecom-ctl-hint">No live reading: ' +
                esc(live.detail || 'the gateway did not answer') + '</span>';
        }

        const one = function (reading, unit, digits) {
            if (!reading || reading.value === null || reading.value === undefined) {
                return '--';
            }
            return reading.value.toFixed(digits === undefined ? 1 : digits) + ' ' + unit;
        };
        const power = live.power_kw || {};
        const stale = power.fresh === false;
        // No timestamp means the gateway has never held a value for the tag,
        // so there is nothing to date and nothing to say it is doing.
        const reported = !!power.at;
        const doing = live.doing === 'charging' ? 'charging'
            : live.doing === 'discharging' ? 'discharging'
            : live.doing === 'idle' ? 'idle' : null;

        // "15:04" is enough while it is today's reading; once it is older than
        // that, the day matters more than the minute.
        const seenAt = function (at) {
            const text = String(at || '');
            const day = text.slice(0, 10);
            const time = text.slice(11, 16);
            const today = new Date().toISOString().slice(0, 10);
            return day === today ? time : day + ' ' + time;
        };

        return '' +
            '<div class="ecom-ctl-live' + (stale || !reported ? ' is-stale' : '') + '">' +
                '<div class="ecom-ctl-live-head">' +
                    '<span class="ecom-ctl-live-dot"></span>' +
                    (reported ? 'The battery' : 'The battery - no reading') +
                    '<span class="ecom-ctl-note">' +
                        (reported
                            ? (stale ? 'last updated ' : 'updated ') +
                              esc(seenAt(power.at))
                            : 'the gateway holds no value for these tags') +
                    '</span>' +
                '</div>' +
                '<div class="ecom-ctl-live-rows">' +
                    '<div><span>Power</span><b>' + one(power, 'kW') +
                        (doing ? ' &middot; ' + doing : '') + '</b></div>' +
                    '<div><span>Charge</span><b>' +
                        one(live.soc_percent, '%', 0) + '</b></div>' +
                    '<div><span>Roof</span><b>' + one(live.solar_kw, 'kW') + '</b></div>' +
                    '<div><span>Setpoint</span><b>' + one(live.setpoint_kw, 'kW') +
                        // Null is "nobody said", which is not the same as
                        // "stopped" - the one claims the battery is off.
                        ((live.command || {}).value == null ? ''
                            : ' &middot; ' +
                              ((live.command || {}).value ? 'running' : 'stopped')) +
                        '</b></div>' +
                '</div>' +
                '<span class="ecom-ctl-hint">Positive is discharging, negative is ' +
                'charging, as the site reads it. Read-only: the table never ' +
                'sends the battery a command.</span>' +
            '</div>';
    }

    /** One window for what the community owns outright: solar and storage.
     *
     * These were two groups, and Solar was mostly a list of every roof on the
     * campus - a per-building thing, which now lives on the building's own row
     * in Members. What is left is the part that belongs to the scheme rather
     * than to any building: arrays on no member's roof, and a store that
     * answers any member.
     */
    function communityGroup() {
        const arrays = communityPlants();
        const store = battery();
        const arrayKw = arrays.reduce(function (sum, p) {
            return sum + plantKw(p);
        }, 0);
        const inBuildings = (state.working.batteries || []).filter(function (b) {
            return b.attached;
        }).length;

        const solar =
            '<div class="ecom-community-assets">' +
                '<div class="ecom-ctl-subhead">Solar</div>' +
                (arrays.length
                    ? sharedPv()
                    : '<p class="ecom-ctl-empty">No community solar.</p>') +
                '<button type="button" class="ecom-add-shared" data-shared="pv"' +
                    ' title="Panels the scheme owns, on no member\'s roof. They ' +
                    'feed whoever needs them. Panels on a building are added from ' +
                    'its row in Members.">' +
                    '<span class="material-icons">add</span>Add solar array' +
                '</button>' +
            '</div>';

        let battery_;
        if (store) {
            battery_ =
                slider({
                    name: 'battery_kwh', label: 'Battery capacity',
                    value: store.capacity, min: 0, max: 5000, step: 50, unit: 'kWh',
                    typed: true,
                    format: function (v) { return Number(v).toLocaleString(); }
                }) +
                slider({
                    name: 'battery_soc', label: 'Starting charge',
                    value: Math.round((store.initial_soc_fraction != null
                        ? store.initial_soc_fraction : 0.5) * 100),
                    min: 0, max: 100, step: 5, unit: '%',
                    hint: 'A fraction of capacity, so it holds as the battery resizes.'
                }) +
                // How fast it can run, not how much it holds. Shown in kW as
                // well as in C, because the rate is the number people argue
                // about and the kW is the number they recognise.
                slider({
                    // The C goes in the format, not the unit: the slider puts a
                    // space before the unit, and "0.25 C" is not how a rate is
                    // written.
                    name: 'battery_crate', label: 'Charge rate',
                    value: cRate(store), min: 0.05, max: 2, step: 0.05, unit: '',
                    format: function (v) { return Number(v).toFixed(2) + 'C'; },
                    hint: rateHint(store.capacity, cRate(store))
                }) +
                '<button type="button" class="ecom-add-shared"' +
                    ' data-shared="battery-remove" title="Take the community ' +
                    'store out. Batteries owned by individual buildings are ' +
                    'left alone.">' +
                    '<span class="material-icons">remove</span>Remove battery' +
                '</button>';
        } else {
            battery_ =
                '<p class="ecom-ctl-empty">' +
                    (inBuildings
                        ? 'No community store. ' + inBuildings + ' ' +
                          (inBuildings > 1 ? 'batteries are' : 'battery is') +
                          ' owned by individual buildings - see Members.'
                        : 'No battery in this community.') +
                '</p>' +
                '<button type="button" class="ecom-add-shared" data-shared="battery"' +
                    ' title="A store the scheme owns, which answers any member ' +
                    'rather than one building. Batteries added to a building ' +
                    'from Members are that building\'s.">' +
                    '<span class="material-icons">add</span>Add battery' +
                '</button>';
        }

        const chargerCount = chargePoints().length;
        // Who gets a member's spare solar first when there is not enough for
        // everyone short at that hour. It decides the table's lines, not the
        // optimizer's costs: the optimizer shares however is cheapest.
        const rule = state.working.sharing_rule || 'order';
        const sharing =
            '<div class="ecom-community-assets">' +
                '<div class="ecom-ctl-subhead">Sharing between members</div>' +
                '<div class="ecom-ctl-span">' +
                    [['order', 'In list order'],
                     ['proportional', 'In proportion to need'],
                     ['nearest', 'Nearest first']].map(function (r) {
                        return '<button type="button" class="ecom-ctl-chip' +
                            (r[0] === rule ? ' is-on' : '') + '" data-sharing-rule="' +
                            r[0] + '">' + r[1] + '</button>';
                    }).join('') +
                '</div>' +
                '<span class="ecom-ctl-hint">' +
                    (rule === 'proportional'
                        ? 'A member\'s spare solar is split between everyone short ' +
                          'at that hour, in proportion to how short each one is.'
                        : rule === 'nearest'
                            ? 'A member\'s spare solar goes to the closest building ' +
                              'first, then the next closest, until it runs out.'
                            : 'A member\'s spare solar goes to the members in the ' +
                              'order they are listed, until it runs out.') +
                    ' The total shared is the same; only who gets it changes.' +
                '</span>' +
            '</div>';
        return group('community', 'Community',
            Math.round(arrayKw).toLocaleString() + ' kW · ' +
                (store ? Math.round(store.capacity).toLocaleString() : '0') + ' kWh · ' +
                chargerCount + (chargerCount === 1 ? ' charger' : ' chargers'),
            sharing +
            solar +
            '<div class="ecom-community-assets">' +
                '<div class="ecom-ctl-subhead">Battery</div>' +
                battery_ +
            '</div>' +
            '<div class="ecom-community-assets">' +
                '<div class="ecom-ctl-subhead">Charging</div>' +
                chargingMarkup() +
            '</div>');
    }

    /** Add a community asset: one the scheme owns rather than any building. */
    function addShared(kind) {
        if (kind === 'battery-remove') {
            const shared = battery();
            if (shared) {
                state.working.batteries = (state.working.batteries || [])
                    .filter(function (b) { return b !== shared; });
            }
            render();
            markDirty();
            return;
        }
        if (kind === 'battery') {
            state.working.batteries = state.working.batteries || [];
            state.working.batteries.push({
                name: 'Community battery ' +
                      (state.working.batteries.length + 1),
                capacity: 200,
                c_rate: 0.25,
                efficiency: 90.0,
                initial_soc_fraction: 0.5
                // No host and not attached: that is what makes it shared.
            });
        } else if (kind === 'pv') {
            state.working.pv_plants = state.working.pv_plants || [];
            const n = communityPlants().length + 1;
            state.working.pv_plants.push({
                name: 'Community array ' + n,
                // A ground array rather than a roof: sized directly in square
                // metres, fully covered, because there is no building whose
                // footprint sets the ceiling.
                surface_area: 2000,
                percentage: 100,
                slope: ADDED_ROOF_TILT,
                azimuth: 0
            });
        }
        // The group is left as it is. The button is always inside one that is
        // already open, and only one can be open at a time, so forcing a
        // particular group shut the one the person was standing in.
        render();
        markDirty();
    }

    /** The battery's C-rate, defaulting to what the campus workbook assumes. */
    function cRate(bat) {
        return bat && bat.c_rate != null ? bat.c_rate : 0.25;
    }

    /** The same rate said twice: as power, and as time to empty. */
    function rateHint(capacity, rate) {
        const kw = capacity * rate;
        const hours = 1 / rate;
        return kw.toFixed(1) + ' kW - ' +
            (hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)) +
            ' h to fill or empty. The campus unit at AWL holds 247 kWh ' +
            'against 112 kW.';
    }

    /** The hourly spot prices for the year being shown (SEK/kWh, 8760). */
    function spotPrices() {
        if (state.spotByYear[state.year]) return state.spotByYear[state.year];
        const base = state.base && state.base.grid && state.base.grid.buying_price;
        return base && Array.isArray(base.hourly) && base.hourly.length ? base.hourly : null;
    }

    /** Mean, low and high of the spot price over the hours the table is showing. */
    function spotWindow(hourly) {
        const first = (dayOfYear(state.startMonth, state.startDay) - 1) * 24;
        const span = Math.max(1, state.spanDays || 1) * 24;
        const slice = hourly.slice(first, first + span);
        const values = slice.length ? slice : hourly;
        let sum = 0;
        let low = Infinity;
        let high = -Infinity;
        values.forEach(function (v) {
            sum += v;
            if (v < low) low = v;
            if (v > high) high = v;
        });
        return { mean: sum / values.length, low: low, high: high, whole: !slice.length };
    }

    function gridGroup() {
        const grid = state.working.grid || {};
        const buying = grid.buying_price || {};
        const spot = spotPrices();
        // On spot while the working copy still carries an hourly series.
        const onSpot = Array.isArray(buying.hourly);
        const sell = (grid.selling_price || {}).fixed;
        const win = spot ? spotWindow(spot) : null;

        // The import price: the real hourly SE3 day-ahead price, or one flat
        // price for every hour. The slider used to be the only control, so it
        // showed a 1.35 that was not in use and, once touched, silently swapped
        // the hourly prices for a flat one.
        let importMarkup = '';
        if (spot) {
            importMarkup =
                '<div class="ecom-ctl-span">' +
                    '<button type="button" class="ecom-ctl-chip' + (onSpot ? ' is-on' : '') +
                        '" data-price-mode="spot">Spot price (SE3, hourly)</button>' +
                    '<button type="button" class="ecom-ctl-chip' + (onSpot ? '' : ' is-on') +
                        '" data-price-mode="fixed">Fixed price</button>' +
                '</div>';
        }
        if (onSpot && win) {
            importMarkup +=
                '<span class="ecom-ctl-hint">Import is the day-ahead spot price, hour ' +
                'by hour - used by the table and by the optimizer. ' +
                (win.whole ? 'Over the year' : 'Over the days shown') + ': ' +
                'average <b>' + win.mean.toFixed(2) + '</b> SEK/kWh, from ' +
                win.low.toFixed(2) + ' to ' + win.high.toFixed(2) + '. ' +
                'Spot only - grid fees, tax and VAT are not in it.</span>';
        } else {
            importMarkup += slider({
                name: 'buy_price', label: 'Import price',
                value: buying.fixed != null ? buying.fixed : 1.35,
                min: 0, max: 5, step: 0.05, unit: 'SEK/kWh'
            });
        }

        return group('grid', 'Grid',
            onSpot && win
                ? 'spot · avg ' + win.mean.toFixed(2) + ' SEK/kWh'
                : Number(buying.fixed != null ? buying.fixed : 1.35).toFixed(2) + ' SEK/kWh in',
            importMarkup +
            slider({
                name: 'sell_price', label: 'Export price',
                value: sell != null ? sell : 0.55,
                min: 0, max: 5, step: 0.05, unit: 'SEK/kWh'
            }) +
            (spot ? spotChart(spot, onSpot ? null : buying.fixed) : '')
        );
    }

    // ------------------------------------------------------- spot chart
    //
    // The import price over the days the table is showing: what a cheap or a
    // dear hour actually is, so that a battery charging at midday or a car
    // waiting until night has a reason anyone can see. With a fixed price
    // chosen, that price is drawn over the spot line it replaces.
    const SPOT_W = 600;
    const SPOT_H = 210;
    const SPOT_PAD = { left: 44, right: 12, top: 14, bottom: 30 };
    const SPOT_COLOUR = '#00ffe5';

    /** The hours of the spot series the table is showing. */
    function spotSlice(hourly) {
        const first = (dayOfYear(state.startMonth, state.startDay) - 1) * 24;
        const span = Math.max(1, state.spanDays || 1) * 24;
        return { first: first, values: hourly.slice(first, first + span) };
    }

    function spotChart(hourly, fixed) {
        const slice = spotSlice(hourly);
        const v = slice.values;
        if (!v.length) return '';
        const lo = Math.min(0, Math.min.apply(null, v), fixed != null ? fixed : Infinity);
        let hi = Math.max.apply(null, v.concat(fixed != null ? [fixed] : []));
        if (hi - lo < 0.1) hi = lo + 0.1;
        const plotW = SPOT_W - SPOT_PAD.left - SPOT_PAD.right;
        const plotH = SPOT_H - SPOT_PAD.top - SPOT_PAD.bottom;
        const x = function (i) { return SPOT_PAD.left + (v.length > 1 ? i / (v.length - 1) : 0) * plotW; };
        const y = function (p) { return SPOT_PAD.top + (1 - (p - lo) / (hi - lo)) * plotH; };

        const line = v.map(function (p, i) {
            return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p).toFixed(1);
        }).join(' ');
        const area = line + ' L' + x(v.length - 1).toFixed(1) + ' ' + y(lo).toFixed(1) +
                     ' L' + x(0).toFixed(1) + ' ' + y(lo).toFixed(1) + ' Z';
        const mean = v.reduce(function (s, p) { return s + p; }, 0) / v.length;

        // Price ticks: the bottom, the top and one between, in SEK/kWh.
        let ticks = '';
        [lo, (lo + hi) / 2, hi].forEach(function (p) {
            ticks += '<line x1="' + SPOT_PAD.left + '" x2="' + (SPOT_W - SPOT_PAD.right) +
                '" y1="' + y(p).toFixed(1) + '" y2="' + y(p).toFixed(1) +
                '" stroke="#3f3f46" stroke-width="1"/>' +
                '<text x="' + (SPOT_PAD.left - 6) + '" y="' + (y(p) + 4).toFixed(1) +
                '" text-anchor="end" fill="#8b8b93" font-size="11">' + p.toFixed(2) + '</text>';
        });
        // Hour ticks every six hours, with the date at each midnight.
        for (let i = 0; i < v.length; i += 6) {
            const midnight = i % 24 === 0;
            ticks += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) +
                '" y1="' + SPOT_PAD.top + '" y2="' + (SPOT_H - SPOT_PAD.bottom) +
                '" stroke="' + (midnight ? '#52525b' : '#2f2f35') + '" stroke-width="1"/>';
            let label = String(i % 24).padStart(2, '0');
            if (midnight) {
                const day = fromDayOfYear(dayOfYear(state.startMonth, state.startDay) + i / 24);
                label = day.day + ' ' + MONTH_NAMES[day.month - 1].slice(0, 3);
            }
            ticks += '<text x="' + x(i).toFixed(1) + '" y="' + (SPOT_H - SPOT_PAD.bottom + 16) +
                '" text-anchor="middle" fill="' + (midnight ? '#c4c4cc' : '#8b8b93') +
                '" font-size="11">' + label + '</text>';
        }

        const now = Math.min(Math.max(0, state.hour || 0), v.length - 1);
        return '<div class="ecom-spot" data-spot-key="' + spotKey(fixed) + '">' +
            '<div class="ecom-spot-head">' +
                '<span>Spot price, SE3 &middot; ' + state.year + '</span>' +
                '<b id="ecom-spot-now-text">' + v[now].toFixed(2) + ' SEK/kWh now</b>' +
            '</div>' +
            '<svg class="ecom-spot-svg" viewBox="0 0 ' + SPOT_W + ' ' + SPOT_H + '"' +
                ' preserveAspectRatio="none" role="img" aria-label="Hourly spot price">' +
                ticks +
                '<path d="' + area + '" fill="' + SPOT_COLOUR + '" fill-opacity="0.08"/>' +
                '<path d="' + line + '" fill="none" stroke="' + SPOT_COLOUR +
                    '" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
                '<line x1="' + SPOT_PAD.left + '" x2="' + (SPOT_W - SPOT_PAD.right) +
                    '" y1="' + y(mean).toFixed(1) + '" y2="' + y(mean).toFixed(1) +
                    '" stroke="' + SPOT_COLOUR + '" stroke-opacity="0.55" stroke-dasharray="5 4"/>' +
                (fixed != null
                    ? '<line x1="' + SPOT_PAD.left + '" x2="' + (SPOT_W - SPOT_PAD.right) +
                      '" y1="' + y(fixed).toFixed(1) + '" y2="' + y(fixed).toFixed(1) +
                      '" stroke="#ffc247" stroke-width="2"/>'
                    : '') +
                '<line id="ecom-spot-now" x1="' + x(now).toFixed(1) + '" x2="' + x(now).toFixed(1) +
                    '" y1="' + SPOT_PAD.top + '" y2="' + (SPOT_H - SPOT_PAD.bottom) +
                    '" stroke="#facc15" stroke-width="1.5"/>' +
                '<circle id="ecom-spot-dot" cx="' + x(now).toFixed(1) + '" cy="' + y(v[now]).toFixed(1) +
                    '" r="4" fill="#facc15"/>' +
            '</svg>' +
            '<div class="ecom-spot-key">' +
                '<span><i style="background:' + SPOT_COLOUR + '"></i>spot, hourly</span>' +
                '<span><i class="is-dash" style="border-color:' + SPOT_COLOUR + '"></i>average ' +
                    mean.toFixed(2) + '</span>' +
                (fixed != null
                    ? '<span><i style="background:#ffc247"></i>fixed ' + fixed.toFixed(2) + '</span>'
                    : '') +
                '<span><i style="background:#facc15"></i>hour on the table</span>' +
                '<span class="ecom-spot-unit">SEK/kWh</span>' +
            '</div>' +
        '</div>';
    }

    /** What the chart was drawn for: when this changes it is redrawn, not moved. */
    function spotKey(fixed) {
        return state.year + ':' + dayOfYear(state.startMonth, state.startDay) + ':' +
            (state.spanDays || 1) + ':' + (fixed != null ? fixed : 'spot');
    }

    /**
     * Keep the chart with the table: move the hour marker, or redraw the chart
     * when the days, the year or the fixed price it was drawn for have changed.
     */
    function paintSpotNow() {
        const chart = document.querySelector('.ecom-spot');
        if (!chart) return;
        const hourly = spotPrices();
        if (!hourly) return;
        const grid = state.working && state.working.grid;
        const buying = (grid && grid.buying_price) || {};
        const shownFixed = Array.isArray(buying.hourly) ? null : buying.fixed;
        if (chart.getAttribute('data-spot-key') !== spotKey(shownFixed)) {
            chart.outerHTML = spotChart(hourly, shownFixed);
            return;
        }
        const marker = document.getElementById('ecom-spot-now');
        if (!marker) return;
        const v = spotSlice(hourly).values;
        if (!v.length) return;
        // Same scale as spotChart: read it back off the drawn ticks would be
        // fragile, so it is recomputed - cheap for at most a year of hours.
        const fixed = shownFixed;
        const lo = Math.min(0, Math.min.apply(null, v), fixed != null ? fixed : Infinity);
        let hi = Math.max.apply(null, v.concat(fixed != null ? [fixed] : []));
        if (hi - lo < 0.1) hi = lo + 0.1;
        const plotW = SPOT_W - SPOT_PAD.left - SPOT_PAD.right;
        const plotH = SPOT_H - SPOT_PAD.top - SPOT_PAD.bottom;
        const now = Math.min(Math.max(0, state.hour || 0), v.length - 1);
        const px = SPOT_PAD.left + (v.length > 1 ? now / (v.length - 1) : 0) * plotW;
        const py = SPOT_PAD.top + (1 - (v[now] - lo) / (hi - lo)) * plotH;
        marker.setAttribute('x1', px.toFixed(1));
        marker.setAttribute('x2', px.toFixed(1));
        const dot = document.getElementById('ecom-spot-dot');
        if (dot) { dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', py.toFixed(1)); }
        const text = document.getElementById('ecom-spot-now-text');
        if (text) text.textContent = v[now].toFixed(2) + ' SEK/kWh now';
    }

    /** Switch the import price between the hourly spot series and a flat one. */
    function setPriceMode(mode) {
        const spot = spotPrices();
        const grid = state.working.grid;
        if (!spot || !grid) return;
        if (mode === 'spot') {
            grid.buying_price = { hourly: spot.slice() };
        } else {
            // Starts at the spot average of the days shown, so switching does
            // not jump the bill before the slider has been touched.
            const mean = spotWindow(spot).mean;
            grid.buying_price = { fixed: Number((Math.round(mean / 0.05) * 0.05).toFixed(2)) };
        }
        render();
        markDirty();
    }

    /**
     * The chargers, as the Charging section of the Community tab. It was a tab
     * of its own (Mobility); it lives with the other things the community runs
     * on now - solar, storage and charging - and lists every charger, the ones
     * added from a building's row too, each labelled with its building.
     */
    function chargingMarkup() {
        const points = chargePoints();

        const addButton =
            '<button type="button" class="ecom-add-shared" data-action="cp-add"' +
                ' title="A charger the community owns, in the P-hus car park. ' +
                'Chargers at a building are added from its row in Members.">' +
                '<span class="material-icons">add</span>Add a charger' +
            '</button>';

        if (!points.length) {
            return '<p class="ecom-ctl-empty">No chargers in this community.</p>' + addButton;
        }

        const rows = points.map(function (cp, index) {
            const placed = cp.lat != null;
            const position = Math.round(housePosition(cp) * 100);
            return '' +
                '<div class="ecom-cp">' +
                    '<div class="ecom-cp-head">' +
                        '<span class="ecom-cp-name">' + esc(cp.name) +
                            (cp.host ? ' &middot; ' + esc(hostLabel(cp.host)) : '') + '</span>' +
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
                    // When the car is plugged in. Both models read this: the
                    // table spreads the day's charging over these hours and the
                    // optimizer makes one charging session of each stay.
                    slider({
                        name: 'cp_arr:' + index, label: 'Arrives',
                        value: plugWindow(cp).arrival, min: WORK_FROM, max: WORK_TO - 1,
                        step: 1, unit: '', format: clockHour
                    }) +
                    slider({
                        name: 'cp_dep:' + index, label: 'Leaves',
                        value: plugWindow(cp).departure, min: WORK_FROM + 1, max: WORK_TO,
                        step: 1, unit: '', format: clockHour,
                        hint: plugHint(plugWindow(cp))
                    }) +
                    (bays
                        ? slider({
                              name: 'cp_pos:' + index,
                              label: 'Along ' + CP_PLACE,
                              value: position, min: 0, max: 100, step: 2,
                              unit: '%',
                              hint: placed ? '' : 'Not placed yet - move this to put it in the car park.'
                          })
                        : '<span class="ecom-ctl-hint">The footprints have not ' +
                          'loaded, so this one stays at the middle of the ' +
                          'campus with the other shared assets.</span>') +
                    '<label class="ecom-ctl-check">' +
                        '<input type="checkbox" data-cp-v2g="' + index + '"' +
                            (cp.is_v2g ? ' checked' : '') + '>' +
                        '<span>Vehicle-to-grid</span>' +
                    '</label>' +
                '</div>';
        }).join('');

        return '<div class="ecom-cps">' + rows + '</div>' + addButton;
    }

    // ------------------------------------------------ plugged-in hours
    //
    // A car's availability is 24 hours of 0/1 - plugged in or not. The panel
    // offers it as an arrival and a departure time: from arrival up to (not
    // including) departure, wrapping past midnight when it leaves earlier in
    // the day than it came. The same time for both means plugged in all day.

    // Workplace charging: the car comes and goes within one day, between 06:00
    // and midnight. The optimizer starts each run fresh and cannot carry a
    // session over midnight into the next day, so - as the optimization team
    // advised - arrival is from 06:00 and departure by 24:00, same day.
    const WORK_FROM = 6;
    const WORK_TO = 24;
    const DEFAULT_PLUG = { arrival: 8, departure: 17 };

    function clockHour(h) { return String(h).padStart(2, '0') + ':00'; }

    /** The arrival and departure the car's schedule describes, inside 06-24. */
    function plugWindow(cp) {
        const a = (cp.ev && cp.ev.availability) || null;
        if (!a || a.length !== 24) return DEFAULT_PLUG;
        let first = null;
        let last = null;
        for (let h = WORK_FROM; h < WORK_TO; h += 1) {
            if (a[h]) {
                if (first === null) first = h;
                last = h;
            }
        }
        return first === null ? DEFAULT_PLUG : { arrival: first, departure: last + 1 };
    }

    /** 24 hours of 0/1: plugged in from arrival up to, not including, departure. */
    function plugSchedule(arrival, departure) {
        const out = [];
        for (let h = 0; h < 24; h += 1) out.push(h >= arrival && h < departure ? 1 : 0);
        return out;
    }

    function plugHint(window_) {
        return 'Plugged in ' + (window_.departure - window_.arrival) + ' h, ' +
            clockHour(window_.arrival) + '-' + clockHour(window_.departure) +
            ' - workplace charging, within the day.';
    }

    /** A building's display name from a charger's host (a footprint id or a name). */
    function hostLabel(host) {
        const building = ((state.base && state.base.buildings) || []).find(function (b) {
            return sameBuilding(b.name, host);
        });
        return building ? building.name : host;
    }

    /** The toggles and size sliders under one building's row.
     *
     * Panels are offered whether or not the building is a member: a roof is a
     * roof, and the community may rent one from a building whose meter is not
     * in the scheme - the Solar group is where that is said. A battery or a
     * charger is only offered to a member, because one on a building outside
     * the community has nobody to serve and would be quietly dropped from
     * every dispatch.
     */
    function buildingKit(b, isMember) {
        const name = b.name;
        const coverage = Math.round(roofCoverage(name));
        const battery = ownBattery(name);
        const chargers = ownChargers(name);

        const chip = function (kind, on, icon, label, title) {
            return '<button type="button" class="ecom-kit' + (on ? ' is-on' : '') + '"' +
                ' data-kit="' + kind + '" data-kit-building="' + esc(name) + '"' +
                ' title="' + esc(title) + '">' +
                '<span class="material-icons">' + icon + '</span>' + esc(label) +
                '</button>';
        };

        const sizer = function (kind, icon, label, value, min, max, step, unit, readout) {
            // Panels can be typed as well as dragged: the slider moves the share
            // of the roof covered, the box beside it is the capacity that share
            // comes to, and typing there sets the share to match.
            const end = kind === 'pv'
                ? '<span class="ecom-kw-field">' +
                      '<input type="number" inputmode="decimal" min="0" step="1"' +
                          ' data-size-kw="' + esc(name) + '"' +
                          ' data-size-readout="pv:' + esc(name) + '"' +
                          ' aria-label="Panel capacity in kW"' +
                          ' value="' + Math.round(roofKw(name)) + '">' +
                      '<i>kW</i></span>'
                : kind === 'battery'
                ? '<span class="ecom-kw-field">' +
                      '<input type="number" inputmode="decimal" min="0" step="10"' +
                          ' data-size-kwh="' + esc(name) + '"' +
                          ' data-size-max="' + max + '"' +
                          ' data-size-readout="battery:' + esc(name) + '"' +
                          ' aria-label="Battery capacity in kWh"' +
                          ' value="' + Math.round(value) + '">' +
                      '<i>kWh</i></span>'
                : '<b data-size-readout="' + kind + ':' + esc(name) + '">' +
                      esc(readout) + '</b>';
            return '<div class="ecom-kit-size is-' + kind + '">' +
                '<label><span class="material-icons">' + icon + '</span>' +
                    esc(label) + '</label>' +
                '<input type="range" data-size="' + kind + '"' +
                    ' data-size-building="' + esc(name) + '"' +
                    ' min="' + min + '" max="' + max + '" step="' + step + '"' +
                    ' value="' + value + '">' +
                end +
                '</div>';
        };

        // What the roof is, whether or not there are panels on it. The Solar
        // list used to carry this on every row - the area in square metres, or
        // "no roof data" - and so did a tag for roofs measured off the Rhino
        // model rather than sized from a footprint. Both went when the list did,
        // and both are what makes the panel sliders mean something: 40% of what?
        const area = Math.round(roofArea(b));
        const surveyed = roofPlants(name).length > 0 &&
                         b.pv_plants && b.pv_plants.length &&
                         b.pv_plants[0] !== name + ' roof';
        // Inside the same strip as the buttons, ahead of them, rather than a line
        // of its own: a row was three lines tall - name, roof, buttons - and in
        // a list that is the thing you scroll, a third of the height was the
        // middle line.
        const roofLine = '<span class="ecom-roof-info' + (area > 0 ? '' : ' is-blocked') + '">' +
            '<span class="ecom-roof-area">' +
                (area > 0 ? 'Roof ' + area.toLocaleString() + ' m²' : 'no roof data') +
            '</span>' +
            (surveyed
                ? '<i class="ecom-roof-tag" title="Panels already on this roof, ' +
                  'taken from the campus model: its real surface, tilt and ' +
                  'azimuth, rather than an array sized from the footprint here.">' +
                  'installed</i>'
                : '') +
            '</span>';

        let rows = '<div class="ecom-ctl-member-kit">' + roofLine +
            chip('pv', coverage > 0, 'wb_sunny',
                 coverage > 0 ? Math.round(roofKw(name)) + ' kW' : 'PV',
                 roofArea(b) > 0
                    ? 'Panels on this roof. Tap to add or remove; the slider ' +
                      'under it sets how much of the roof they cover.'
                    : 'No footprint for this building, so there is no roof to size.') +
            // Offered whether or not the building is a member. Outside the
            // community they wait, exactly as a roof's panels do, and start
            // counting the moment the building is ticked in - buildSpec drops
            // them from the dispatch until then.
            chip('battery', !!battery, 'battery_charging_full',
                 battery ? Math.round(battery.capacity) + ' kWh' : 'Battery',
                 'A battery in this building. It takes this building\'s ' +
                 'surplus before the neighbours see it and covers its own ' +
                 'demand first. Community storage is separate.' +
                 (isMember ? '' : ' The building is not a member: while its ' +
                  'equipment is RENTED the community uses it; by default it serves the building itself.')) +
            chip('charger', chargers.length > 0, 'ev_station',
                 chargers.length ? chargers.length + ' charger' +
                     (chargers.length > 1 ? 's' : '') : 'Charger',
                 'A charge point outside this building, placed clear of its ' +
                 'neighbours. Tap again to take them all away; the + and - below ' +
                 'add or remove one at a time.' +
                 (isMember ? '' : ' The building is not a member: while its ' +
                  'equipment is RENTED the community uses it; by default it serves the building itself.')) +
            '</div>';

        // Who uses the equipment of a building outside the community, once it
        // has any - a switch per kind, on a line of its own so it reads as a
        // choice to make rather than a status. OWN USE (the default): the
        // building itself, which is not a member, so none of it is in the
        // community. RENTED: the community uses it, it counts in the KPIs and
        // the optimization, and the table draws its lines.
        if (!isMember && (coverage > 0 || battery || chargers.length)) {
            rows += '<div class="ecom-owner-row">' +
                '<span class="ecom-owner-lead">Not a member - who uses it?</span>' +
                (coverage > 0 ? ownerBadge(name, 'pv', 'Solar', 'panels') : '') +
                (battery ? ownerBadge(name, 'battery', 'Battery', 'battery') : '') +
                (chargers.length ? ownerBadge(name, 'charger', 'Chargers', 'chargers') : '') +
            '</div>';
        }

        if (coverage > 0 && roofArea(b) > 0) {
            rows += sizer('pv', 'wb_sunny', 'Roof', Math.min(coverage, MAX_ROOF_COVERAGE),
                          0, MAX_ROOF_COVERAGE, 5, '%',
                          Math.round(roofKw(name)) + ' kW');
        }
        if (battery) {
            rows += sizer('battery', 'battery_charging_full', 'Storage',
                          Math.round(battery.capacity), 0, 1000, 10, 'kWh',
                          Math.round(battery.capacity) + ' kWh');
            // What the real one is doing right now, under the modelled one.
            if (sameBuilding(name, LIVE_BATTERY_HOST)) rows += liveBlock();
        }
        if (chargers.length) {
            // How many, and how powerful each one is. The power slider sets all
            // of this building's chargers at once: they are a bank of the same
            // kind, and a slider per charger would be eight sliders for one
            // answer.
            const power = Math.round(chargers[0].capacity);
            rows += '<div class="ecom-kit-size ecom-kit-chargers is-charger">' +
                '<label><span class="material-icons">ev_station</span>' +
                    (chargers.length > 1 ? 'Chargers' : 'Charger') + '</label>' +
                '<span class="ecom-stepper" role="group" aria-label="Number of chargers">' +
                    '<button type="button" data-charger-step="-1"' +
                        ' data-kit-building="' + esc(name) + '"' +
                        ' aria-label="One charger fewer">&minus;</button>' +
                    '<b>' + chargers.length + '</b>' +
                    '<button type="button" data-charger-step="1"' +
                        ' data-kit-building="' + esc(name) + '"' +
                        (chargers.length >= MAX_CHARGERS_PER_BUILDING ? ' disabled' : '') +
                        ' aria-label="One charger more">+</button>' +
                '</span>' +
                '<input type="range" data-size="charger"' +
                    ' data-size-building="' + esc(name) + '"' +
                    ' min="3" max="150" step="1" value="' + power + '">' +
                '<b data-size-readout="charger:' + esc(name) + '">' + power +
                    ' kW' + (chargers.length > 1 ? ' each' : '') + '</b>' +
                '</div>' +
                // Vehicle-to-grid for this building's chargers, all of them at
                // once like the power slider: the cars may give energy back to
                // the community, not only take it. The optimizer runs with V2G
                // on whenever any charger has it.
                '<label class="ecom-ctl-check ecom-kit-v2g" title="Vehicle-to-grid: ' +
                    'the cars on these chargers can also discharge into the ' +
                    'community when that is worth more than holding the charge. ' +
                    'They still leave with the charge their trip needs.">' +
                    '<input type="checkbox" data-kit-v2g="' + esc(name) + '"' +
                        (chargers.every(function (cp) { return cp.is_v2g; })
                            ? ' checked' : '') + '>' +
                    '<span>V2G - the cars can give energy back</span>' +
                '</label>';
        }
        return rows;
    }

    function membersGroup() {
        const all = state.base.buildings;
        const inCount = all.length - state.excluded.size;
        const withRoofs = all.filter(function (b) {
            return roofPlants(b.name).length;
        }).length;
        const rows = all.map(function (b) {
            const on = !state.excluded.has(b.name);
            // What this building already has of its own. Only offered once it
            // is a member: a battery or a charger on a building outside the
            // scheme has nobody to serve, and the panel should not pretend
            // otherwise by letting one be added.
            const kit = buildingKit(b, on);

            return '' +
                '<div class="ecom-ctl-member-row' + (on ? '' : ' is-off') + '">' +
                    '<label class="ecom-ctl-member' + (on ? '' : ' is-off') + '"' +
                    ' title="' + esc(b.name) + '"' +
                    ' data-member="' + esc(b.name) + '">' +
                        '<input type="checkbox" data-member="' + esc(b.name) + '"' +
                            (on ? ' checked' : '') + '>' +
                        '<span class="ecom-ctl-member-name">' + esc(b.name) + '</span>' +
                    '</label>' +
                    kit +
                '</div>';
        }).join('');

        return group('members', 'Members', inCount + ' of ' + all.length,
            // One toolbar, not two stacked rows: who is in, and every roof at
            // once. They were two lines of the panel's height spent on buttons
            // before the list had started, on a screen where the list is short.
            // The roof shortcut was the head of the Solar group, which is gone:
            // panels are per building now, so it lives with the buildings.
            '<div class="ecom-members-toolbar">' +
                '<button type="button" class="ecom-ctl-btn" data-members="all">All in</button>' +
                '<button type="button" class="ecom-ctl-btn" data-members="none">All out</button>' +
                '<span class="ecom-members-roofs">' +
                    '<span>Roofs &middot; ' + withRoofs + ' of ' + all.length + '</span>' +
                    '<button type="button" class="ecom-mini" data-roofs="40">40%</button>' +
                    '<button type="button" class="ecom-mini" data-roofs="' +
                        MAX_ROOF_COVERAGE + '">' + MAX_ROOF_COVERAGE + '%</button>' +
                    '<button type="button" class="ecom-mini" data-roofs="0">Clear</button>' +
                '</span>' +
            '</div>' +
            '<div class="ecom-ctl-members">' + rows + '</div>'
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

    // Constants the optimizer has but the panel does not offer for editing.
    // The value is not removed, only the control: a run sends nothing for it
    // and LEC-Opt uses the number it was written with.
    //
    // The peak multiplier weights the monthly peak charge in the optimizer's
    // cost. It is derived from the input data rather than chosen, and moving it
    // changes the objective being minimised rather than a price anyone pays, so
    // it is not a knob to be turned at the table.
    const HIDDEN_PARAMS = ['peak_multiplier'];

    // The rolling window: each day is solved looking this far ahead, and only
    // the first part of the answer is kept. Looking 36 hours ahead and keeping
    // 24 stops the battery being emptied at midnight, which a day solved on its
    // own 24 hours cannot see coming. Sent with every run rather than left to a
    // default, so the request says what the run does.
    const OPTIMIZER_LOOKAHEAD_H = 36;
    const OPTIMIZER_KEEP_H = 24;

    /** The explanation under a constant, when its info icon is open. */
    function paramInfo(p) {
        const range = (p.minimum != null || p.maximum != null)
            ? ' &middot; range ' + (p.minimum != null ? p.minimum : '…') + ' to ' +
              (p.maximum != null ? p.maximum : '…')
            : '';
        return '<div class="ecom-ctl-param-info">' +
            '<p>' + esc(p.meaning || 'No description has been written for this one.') + '</p>' +
            '<span class="ecom-ctl-param-default">Default ' + esc(String(p.default)) +
                (p.unit ? ' ' + esc(p.unit) : '') + range + '</span>' +
            // Said again here, not only by the marker: a dot beside the name
            // does not say what is wrong with the number.
            (p.outdated
                ? '<span class="ecom-ctl-param-warn"><b class="ecom-ctl-stale">●</b> ' +
                  'The optimization team flagged this value as out of date.</span>'
                : '') +
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

        // What is offered for editing. A constant can be left out of the list
        // and still be in the model: it keeps the value LEC-Opt was written
        // with, which is what a run uses when nothing is sent for it.
        const offered = state.params.filter(function (p) {
            return HIDDEN_PARAMS.indexOf(p.name) === -1;
        });

        const byGroup = {};
        offered.forEach(function (p) {
            (byGroup[p.group] = byGroup[p.group] || []).push(p);
        });

        const fields = Object.keys(byGroup).map(function (name) {
            const rows = byGroup[name].map(function (p) {
                const value = state.paramValues[p.name] != null
                    ? state.paramValues[p.name] : p.default;
                const isChanged = state.paramValues[p.name] !== undefined;
                const open = !!state.paramInfo[p.name];
                return '' +
                    '<div class="ecom-ctl-param-block' + (open ? ' is-open' : '') + '">' +
                        '<label class="ecom-ctl-param' + (isChanged ? ' is-changed' : '') + '">' +
                            '<span>' + esc(p.name.replace(/_/g, ' ')) +
                                (p.outdated ? ' <b class="ecom-ctl-stale">●</b>' : '') +
                            '</span>' +
                            // A button, not a tooltip: there is no hover on a
                            // touch screen, so a title attribute is an
                            // explanation nobody at the table could ever read.
                            '<button type="button" class="ecom-info' + (open ? ' is-on' : '') + '"' +
                                ' data-param-info="' + esc(p.name) + '"' +
                                ' aria-expanded="' + open + '"' +
                                ' aria-label="What ' + esc(p.name.replace(/_/g, ' ')) +
                                ' stands for">' +
                                '<i class="material-icons">info</i>' +
                            '</button>' +
                            '<input type="number" step="any" data-param="' + esc(p.name) + '"' +
                                ' value="' + value + '">' +
                            '<em>' + esc(p.unit || '') + '</em>' +
                        '</label>' +
                        (open ? paramInfo(p) : '') +
                    '</div>';
            }).join('');
            return '<div class="ecom-ctl-sub">' + esc(name) + '</div>' + rows;
        }).join('');

        const job = state.optimizer;
        let readout = '';
        const finished = Object.keys(state.optimizerResults || {});
        const resultMarkup = finished.map(function (mode) {
            const totals = (state.optimizerResults[mode] || {}).totals || {};
            return '<div class="ecom-ctl-result">' +
                    '<h5>' + esc(OPTIMIZER_MODE_LABELS[mode] || mode) + '</h5>' +
                    '<div><span>Overall cost</span><b>' +
                        Math.round(totals.overall_cost || 0).toLocaleString() + ' SEK</b></div>' +
                    '<div><span>Grid import</span><b>' +
                        Math.round(totals.grid_import_kwh || 0).toLocaleString() + ' kWh</b></div>' +
                    '<div><span>Grid export</span><b>' +
                        Math.round(totals.grid_export_kwh || 0).toLocaleString() + ' kWh</b></div>' +
                    '<div><span>Peak import</span><b>' +
                        Math.round(totals.peak_net_import_kw || 0).toLocaleString() + ' kW</b></div>' +
                '</div>';
        }).join('');
        const running = !!state.optimizerRunning;
        if (job && job.status === 'error') {
            readout = resultMarkup + '<p class="ecom-ctl-empty ecom-ctl-error">' +
                      esc(job.error || 'the optimizer failed') + '</p>';
        } else if (running) {
            const waiting = state.optimizerStartedAt
                ? Math.round((Date.now() - state.optimizerStartedAt) / 1000) : 0;
            readout = resultMarkup + '<p class="ecom-ctl-empty">Solving ' +
                      currentSpan().label.toLowerCase() + ' ' +
                      esc((OPTIMIZER_MODE_LABELS[state.optimizerRunning] || '').toLowerCase()) +
                      '… ' + waiting + ' s</p>';
        } else if (finished.length) {
            readout = resultMarkup +
                '<span class="ecom-ctl-hint">Shown at the bottom of the table too.</span>';
        } else if (job) {
            // Elapsed rather than a percentage: the rolling horizon reports
            // progress in steps that are not evenly spaced, and a bar that
            // sticks at 4% for a minute reads as a hang. A clock that keeps
            // counting says the same thing and cannot be wrong.
            const waiting = state.optimizerStartedAt
                ? Math.round((Date.now() - state.optimizerStartedAt) / 1000) : 0;
            readout = '<p class="ecom-ctl-empty">Solving ' +
                      currentSpan().label.toLowerCase() + '… ' + waiting + ' s of ' +
                      optimizerEstimate(currentSpan().days) + '</p>';
        }

        return group('optimizer', 'Optimizer',
            changed ? changed + ' changed' : offered.length + ' constants',
            '<div class="ecom-ctl-span">' +
                [['community', 'As an energy community'],
                 ['separate', 'As today'],
                 ['both', 'Compare both']].map(function (m) {
                    return '<button type="button" class="ecom-ctl-chip' +
                        (m[0] === state.optimizerMode ? ' is-on' : '') +
                        '" data-optimizer-mode="' + m[0] + '">' + m[1] + '</button>';
                }).join('') +
                '<span class="ecom-ctl-hint">' +
                    (state.optimizerMode === 'separate'
                        ? 'Each building on its own connection: its own subscription and peak fee, no sharing.'
                        : state.optimizerMode === 'both'
                            ? 'Runs both and shows what the community saves.'
                            : 'The buildings selected share solar, storage and the grid connection.') +
                '</span>' +
            '</div>' +
            '<div class="ecom-ctl-span">' +
                OPTIMIZER_SPANS.map(function (option) {
                    return '<button type="button" class="ecom-ctl-chip' +
                        (option.key === state.optimizerSpan ? ' is-on' : '') +
                        '" data-optimizer-span="' + option.key + '">' +
                        option.label + '</button>';
                }).join('') +
                '<span class="ecom-ctl-hint">' +
                    esc(periodLabel(optimizerPeriod(currentSpan().days))) +
                    ' &middot; ' + optimizerEstimate(currentSpan().days) + '</span>' +
            '</div>' +
            '<label class="ecom-ctl-check ecom-ctl-check--inline">' +
                '<input type="checkbox" data-toggle="autoopt"' +
                    (state.autoOptimize ? ' checked' : '') + '>' +
                '<span>Run automatically when something changes, and compare ' +
                    'with the previous run</span>' +
            '</label>' +
            '<div class="ecom-ctl-actions">' +
                '<button type="button" class="ecom-ctl-btn ecom-ctl-btn--primary"' +
                    ' data-action="optimize"' + (state.optimizerRunning ? ' disabled' : '') + '>' +
                    'Run ' + currentSpan().label.toLowerCase() + '</button>' +
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
        if (state.api === null || state.stale || !state.base || !state.working) {
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
            // The parameters on the left, the chart they drive on the right.
            groupHost.innerHTML = paramsMarkup() + profilesCard();
            // Drawn once more now that the card is on the page and can be
            // measured; the first pass above had to guess its size.
            paintProfiles();
        }

        paintSpan();
        paintSky();
        paintLink();
        paintFlash();
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

        // Size, from the row under a building's toggles. Patched rather than
        // re-rendered: these fire continuously under a finger, and rebuilding
        // the panel mid-drag snatches the slider away.
        const size = target.getAttribute && target.getAttribute('data-size');
        if (size) {
            const name = target.getAttribute('data-size-building');
            const value = Number(target.value);
            setKitSize(size, name, value);
            const readout = document.querySelector(
                '[data-size-readout="' + size + ':' + String(name).replace(/"/g, '') + '"]');
            if (size === 'pv' || size === 'battery') {
                // The chip above the slider carries the same figure. Patched
                // with it, or it keeps the old number until something redraws.
                const chip = document.querySelector('[data-kit="' + size +
                    '"][data-kit-building="' + String(name).replace(/"/g, '') + '"]');
                if (chip && chip.lastChild) {
                    const figure = size === 'pv' ? Math.round(roofKw(name))
                                                 : Math.round(value);
                    chip.lastChild.textContent = figure > 0
                        ? figure + (size === 'pv' ? ' kW' : ' kWh')
                        : (size === 'pv' ? 'PV' : 'Battery');
                }
            }
            if (readout && readout.tagName === 'INPUT') {
                // The typed capacity follows the slider. Not while it has focus,
                // so a number half-typed is not overwritten.
                if (document.activeElement !== readout) {
                    readout.value = size === 'pv' ? Math.round(roofKw(name))
                                                  : Math.round(value);
                }
            } else if (readout) {
                readout.textContent =
                    size === 'pv' ? Math.round(roofKw(name)) + ' kW'
                    : size === 'battery' ? Math.round(value) + ' kWh'
                    : Math.round(value) + ' kW' +
                      (ownChargers(name).length > 1 ? ' each' : '');
            }
            markDirty();
            return;
        }

        // A community array's size, in square metres of panel.
        const sharedSize = target.getAttribute && target.getAttribute('data-shared-size');
        if (sharedSize) {
            const index = Number(target.getAttribute('data-shared-index'));
            const plant = communityPlants()[index];
            if (plant) {
                plant.surface_area = Number(target.value);
                const readout = document.querySelector(
                    '[data-shared-readout="pv:' + index + '"]');
                if (readout) readout.textContent = Math.round(plantKw(plant)) + ' kW';
                markDirty();
            }
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
            // An optimizer constant changes the answer, so it counts as a change.
            scheduleOptimize();
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

    /** What the button will do, which depends on whether a table is there to do it. */
    function playTitle() {
        if (state.playing) return 'Hold the hour';
        return state.link.up
            ? 'Let the table run the day'
            : 'Run the day here - no display is linked, so this panel keeps the clock';
    }

    function setPlayButton() {
        const btn = document.querySelector('.ecom-when-play');
        if (!btn) return;
        btn.textContent = state.playing ? '❚❚' : '▶';
        btn.title = playTitle();
    }

    function applySlider(name, value, readout) {
        const set = function (text) {
            if (!readout) return;
            if (readout.tagName === 'INPUT') {
                // A typed figure follows the slider, but not out from under a
                // number being typed.
                if (document.activeElement !== readout) readout.value = String(Math.round(value));
            } else {
                readout.textContent = text;
            }
        };
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
            } else if (parts[0] === 'cp_arr' || parts[0] === 'cp_dep') {
                if (cp.ev) {
                    const now = plugWindow(cp);
                    let arrival = parts[0] === 'cp_arr' ? value : now.arrival;
                    let departure = parts[0] === 'cp_dep' ? value : now.departure;
                    // Always at least an hour plugged in, and leaving after it
                    // arrives: the slider not being moved gives way.
                    if (departure <= arrival) {
                        if (parts[0] === 'cp_arr') departure = Math.min(WORK_TO, arrival + 1);
                        else arrival = Math.max(WORK_FROM, departure - 1);
                    }
                    cp.ev.availability = plugSchedule(arrival, departure);
                    const other = parts[0] === 'cp_arr' ? 'cp_dep' : 'cp_arr';
                    const otherValue = other === 'cp_dep' ? departure : arrival;
                    const otherSlider = document.querySelector('[data-slider="' + other + ':' + parts[1] + '"]');
                    if (otherSlider && Number(otherSlider.value) !== otherValue) {
                        otherSlider.value = otherValue;
                        const otherReadout = document.querySelector('[data-readout="' + other + ':' + parts[1] + '"]');
                        if (otherReadout) otherReadout.textContent = clockHour(otherValue) + ' ';
                    }
                    // The "Plugged in N h" line under Leaves follows both sliders.
                    const hint = document.querySelector(
                        '[data-slider="cp_dep:' + parts[1] + '"] + .ecom-ctl-hint');
                    if (hint) hint.textContent = plugHint({ arrival: arrival, departure: departure });
                }
                set(clockHour(value));
            } else if (parts[0] === 'cp_pos') {
                const spot = alongHouse(value / 100);
                if (spot) { cp.lon = spot[0]; cp.lat = spot[1]; }
                set(value + ' %');
            }
            markDirty();
            return;
        }

        // These three belong to the community's store, which is not necessarily
        // the first battery in the list: buildings can hold batteries of their
        // own now, and one added after the store was removed and re-added sits
        // ahead of it. Indexing [0] would have resized a building's battery.
        const store = (w.batteries || []).find(function (b) { return !b.attached; });

        switch (name) {
            case 'battery_kwh':
                if (!store) break;
                // The backend requires a positive capacity.
                store.capacity = Math.max(1, value);
                set(value.toLocaleString() + ' kWh');
                markDirty();
                break;
            case 'battery_soc':
                if (!store) break;
                store.initial_soc_fraction = value / 100;
                set(value + ' %');
                markDirty();
                break;
            case 'battery_crate':
                if (!store) break;
                store.c_rate = value;
                set(value.toFixed(2) + 'C');
                markDirty();
                break;
            case 'buy_price':
                w.grid.buying_price = { fixed: value };
                set(value.toFixed(2) + ' SEK/kWh');
                paintSpotNow();     // the fixed line moves with the slider
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
        'data-members', 'data-roofs', 'data-cp-remove', 'data-story-step', 'data-price-mode',
        'data-sharing-rule',
        'data-optimizer-span', 'data-optimizer-mode', 'data-peak', 'data-kit', 'data-roofowner',
        'data-shared', 'data-profile-mode', 'data-profile-focus', 'data-profile-view',
        'data-share-mode',
        'data-param-info', 'data-charger-step'
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
            // A tab selects; it does not toggle. Tapping the one already open
            // used to close an accordion card, and a tab panel with nothing in
            // it is not a state anyone wants to be in.
            state.openGroup = groupId;
            render();
            return;
        }

        const jump = el.getAttribute('data-story-step');
        if (jump !== null) { storyGo(Number(jump)); return; }

        const priceMode = el.getAttribute('data-price-mode');
        if (priceMode) { setPriceMode(priceMode); return; }

        // How members share a surplus. Re-dispatches: the lines change.
        const sharingRule = el.getAttribute('data-sharing-rule');
        if (sharingRule) {
            if ((state.working.sharing_rule || 'order') === sharingRule) return;
            state.working.sharing_rule = sharingRule;
            render();
            markDirty();
            return;
        }

        const action = el.getAttribute('data-action');
        if (action === 'kpi-more') {
            state.kpiDetails = !state.kpiDetails;
            renderKpis();
            return;
        }
        if (action === 'story-next') {
            // Started again after a Skip while the example is still on its way:
            // let that load carry on rather than ignoring the press.
            if (state.story < 0 && storyLoading && storySkipRequested) {
                storySkipRequested = false;
                render();
                return;
            }
            storyGo(state.story + 1 >= STORY.length ? -1 : state.story + 1);
            return;
        }
        if (action === 'story-back') { storyGo(Math.max(0, state.story - 1)); return; }
        if (action === 'story-exit') { storyGo(-1); return; }
        if (action === 'story-skip') { storySkipRequested = true; render(); return; }
        if (action === 'apply') { applyNow(); return; }

        // Jump to the busiest hour or the busiest day of a measured year.
        // Unlike the other date controls this dispatches on its own: the point
        // of a shortcut is to arrive, not to set three pickers and then press
        // Apply.
        const peak = el.getAttribute('data-peak');
        if (peak) {
            const year = Number(el.getAttribute('data-peak-year'));
            const hour = Number(el.getAttribute('data-peak-hour'));
            if (year !== state.year) setYear(year);
            state.startMonth = Number(el.getAttribute('data-peak-month'));
            state.startDay = Number(el.getAttribute('data-peak-day'));
            state.spanDays = 1;        // one day, so the hour index is the hour
            applyPeriod();

            const dayList = document.getElementById('ecom-day');
            if (dayList) dayList.innerHTML = dayOptions();
            render();
            paintSpan();
            paintSky();

            applyNow().then(function () {
                // Land on the hour worth looking at rather than at midnight.
                // After the dispatch, or the scrub would be against the
                // previous day's window. Stopping the table's own clock, for
                // the same reason the hour slider does: two things driving the
                // hour at once reads as a stutter.
                state.hour = Math.max(0, Math.min(state.hours - 1, hour));
                state.playing = false;
                setPlayButton();
                channel.postMessage({
                    type: 'ecom_hour', hour: state.hour, totalHours: state.hours
                });
                const slider = document.getElementById('ecom-hour');
                if (slider) slider.value = String(state.hour);
                paintSky();
            });
            return;
        }
        if (action === 'reset') { resetAll(); return; }
        if (action === 'play') {
            state.playing = !state.playing;
            setPlayButton();
            syncLocalClock();
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
        const optMode = el.getAttribute('data-optimizer-mode');
        if (optMode) {
            state.optimizerMode = optMode;
            render();
            return;
        }
        const span = el.getAttribute('data-optimizer-span');
        if (span) {
            state.optimizerSpan = span;
            render();
            return;
        }
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

        // Who owns the panels on a roof outside the community.
        const roofOwner = el.getAttribute('data-roofowner');
        if (roofOwner) {
            const ownerKind = el.getAttribute('data-owner-kind') || 'pv';
            const key = ownerKind + ':' + roofOwner;
            // A side of the switch sets that side; anything else flips it.
            const want = el.getAttribute('data-owner-set');
            const rent = want ? want === 'rented' : !state.rented[key];
            if (!!state.rented[key] === rent) return;     // already that way
            if (rent) state.rented[key] = true;
            else delete state.rented[key];
            render();
            markDirty();
            return;
        }

        // One more charger at a building, or one fewer.
        const step = el.getAttribute('data-charger-step');
        if (step) {
            const building = el.getAttribute('data-kit-building');
            if (building) {
                if (Number(step) > 0) addCharger(building);
                else removeCharger(building);
            }
            return;
        }

        // What an optimizer constant stands for: open or close its explanation.
        const infoFor = el.getAttribute('data-param-info');
        if (infoFor) {
            event.preventDefault();       // it sits inside the constant's label
            state.paramInfo[infoFor] = !state.paramInfo[infoFor];
            render();
            return;
        }

        // The sharing graph: the whole period, or the hour on the table.
        const shareMode = el.getAttribute('data-share-mode');
        if (shareMode) {
            state.shareMode = shareMode === 'hour' ? 'hour' : 'period';
            paintProfiles();
            return;
        }

        // Load profiles or the sharing graph, in the same card.
        const profileView = el.getAttribute('data-profile-view');
        if (profileView) {
            state.profileView = profileView === 'sharing' ? 'sharing' : 'profiles';
            render();
            return;
        }

        // Load profiles: the scale, and which building to follow.
        const profileMode = el.getAttribute('data-profile-mode');
        if (profileMode) {
            state.profileMode = profileMode === 'share' ? 'share' : 'kw';
            paintProfiles();
            return;
        }
        const profileFocus = el.getAttribute('data-profile-focus');
        if (profileFocus) {
            // Tapping the one already followed lets it go.
            state.profileFocus = state.profileFocus === profileFocus ? null : profileFocus;
            paintProfiles();
            return;
        }

        // A community asset, belonging to the scheme rather than a building.
        const shared = el.getAttribute('data-shared');
        if (shared) {
            addShared(shared);
            return;
        }

        // Give a member a roof, a battery or a charger - or take it away again.
        const kit = el.getAttribute('data-kit');
        if (kit) {
            const name = el.getAttribute('data-kit-building');
            if (name) toggleKit(kit, name);
            return;
        }

        const members = el.getAttribute('data-members');
        if (members) {
            if (members === 'all') {
                state.excluded = new Set();
            } else {
                // Everyone out, including the last one. The panel opens in
                // this state, so it has to be reachable from the buttons.
                state.excluded = new Set(state.base.buildings
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

            // An empty community is a legitimate place to be - it is where the
            // panel starts - so taking the last member out is allowed. What it
            // cannot do is dispatch: the backend refuses a community with no
            // buildings, and every KPI would be zero. markDirty handles that;
            // see applyNow, which clears the table instead of posting.
            target.parentElement.classList.toggle('is-off', !target.checked);
            // The per-building controls appear and disappear with membership,
            // so the whole panel is rebuilt rather than this one row patched.
            render();
            markDirty();
            return;
        }

        // A panel capacity typed in kW. Applied on commit (Enter or leaving the
        // box), not per keystroke: "1" on the way to "150" is not a request for
        // 1 kW. The roof's share of panels is set to give that capacity, within
        // the same ceiling as the slider, and the panel is redrawn so the
        // slider and the box both show what was actually applied.
        const kwBuilding = target.getAttribute && target.getAttribute('data-size-kw');
        if (kwBuilding) {
            const typed = Number(target.value);
            const percent = roofCoverage(kwBuilding);
            const kw = roofKw(kwBuilding);
            if (target.value === '' || !isFinite(typed) || typed < 0 || percent <= 0 || kw <= 0) {
                render();                       // nothing usable: put the old value back
                return;
            }
            const perPercent = kw / percent;    // kW for each point of roof covered
            const next = typed === 0
                ? 0
                : Math.min(Math.max(Math.round(typed / perPercent * 10) / 10, 0.1),
                           MAX_ROOF_COVERAGE);
            setRoofCoverage(kwBuilding, next);
            render();
            markDirty();
            return;
        }

        // A building's battery capacity typed in kWh. Same rules as the panels:
        // on commit, capped at the slider's maximum, 0 takes the battery out.
        const kwhBuilding = target.getAttribute && target.getAttribute('data-size-kwh');
        if (kwhBuilding) {
            const typed = Number(target.value);
            const cap = Number(target.getAttribute('data-size-max')) || 1000;
            if (target.value === '' || !isFinite(typed) || typed < 0) {
                render();
                return;
            }
            setKitSize('battery', kwhBuilding, Math.min(typed, cap));
            render();
            markDirty();
            return;
        }

        // The community battery's capacity typed in the Community tab.
        const typedSlider = target.getAttribute && target.getAttribute('data-slider-typed');
        if (typedSlider) {
            const typed = Number(target.value);
            const cap = Number(target.getAttribute('data-typed-max')) || 5000;
            if (target.value === '' || !isFinite(typed) || typed < 0) {
                render();
                return;
            }
            applySlider(typedSlider, Math.min(Math.max(typed, 1), cap), null);
            render();
            return;
        }

        // V2G for every charger at one building, from its row in Members. Both
        // flags together, as the switch in Community's Charging list does: the backend refuses a
        // car with V2G on behind a charger without it.
        const v2gBuilding = target.getAttribute && target.getAttribute('data-kit-v2g');
        if (v2gBuilding) {
            ownChargers(v2gBuilding).forEach(function (cp) {
                cp.is_v2g = target.checked;
                if (cp.ev) cp.ev.v2g_enabled = target.checked;
            });
            render();
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
        if (toggle === 'autoopt') {
            state.autoOptimize = target.checked;
            // Switching it off must not leave a queued run to fire anyway.
            if (!state.autoOptimize && optimizeTimer !== null) {
                clearTimeout(optimizeTimer);
                optimizeTimer = null;
            }
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
            // Only buildings the table can draw are offered at all.
            await restrictToGeometry();
            // Nobody is in the community until someone is put in it. The
            // campus is a set of buildings that could join, not a scheme that
            // exists and can be whittled down, and starting from empty is the
            // difference between demonstrating that and asserting it.
            state.excluded = new Set(state.base.buildings.map(function (b) {
                return b.name;
            }));
            // Said out loud, straight away. The display loads the committed
            // export when it comes up - a full community, baked in - and with
            // nothing to contradict it the table would show a scheme the panel
            // says has no members in it.
            channel.postMessage({ type: 'ecom_empty' });
        } catch (error) {
            state.api = null;
            loaded = false;
            render();
            return;
        }

        // The real battery, every few seconds, for the Storage group.
        watchLive();

        // The car park the chargers stand in, for the position slider. Not
        // awaited: the panel opens on Members and the group is closed until
        // someone asks for it.
        loadBays().then(function () {
            if (state.openGroup === 'community') render();
        });

        // Started here, not awaited: the panel is useful without them, but
        // waiting until after the opening dispatch meant a quick tap on the
        // Optimizer group arrived before the request had even been made.
        loadParams();

        state.working = clone(state.base);
        // The community as it stands before anyone has touched anything. The
        // first edit is measured against this, so the first change made after
        // opening the panel - the one most likely to be demonstrated - is
        // announced like any other instead of passing in silence.
        lastApplied = clone(state.base);

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

        // The spot prices of every year there is demand for, fetched now so
        // that changing year can swap them in at once, before the dispatch it
        // triggers goes out. A year without a price file keeps the scenario's.
        await Promise.all((state.years.length ? state.years : [state.year]).map(
            async function (year) {
                try {
                    const prices = await getJson('/api/prices/se3/' + year);
                    if (Array.isArray(prices.hourly)) state.spotByYear[year] = prices.hourly;
                } catch (error) { /* stays on the scenario's own prices */ }
            }));
        if (state.openGroup === 'grid') render();

        // The two days of each year worth aiming at. Same reasoning as the
        // year list: late enough not to hold up the panel, early enough to be
        // there before anyone looks for a hard day to test against.
        try {
            const found = await getJson('/api/scenarios/' + SCENARIO + '/peaks');
            state.peaks = found.peaks || [];
            const host = document.getElementById('ecom-peaks');
            if (host) host.innerHTML = peakChips();
        } catch (error) { /* no shortcuts, the date pickers still work */ }

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
            host.addEventListener('pointermove', onProfileMove);
        });

        // On the document, not on the panel: the keys have to work wherever the
        // focus happens to be in this window.
        document.addEventListener('keydown', onStoryKey);

        // A controller that has just opened is not solving anything. If the last
        // one was closed or reloaded mid-run, the display is still lightened and
        // still waiting to be told the run is over; say so.
        channel.postMessage({
            type: 'ecom_optimization',
            optimization: { running: '', error: '', results: {}, previous: null }
        });

        // The chart is drawn at the size of its card, so a resized window
        // needs it drawn again. Waited out, because a window being dragged
        // fires this dozens of times a second and the chart is rebuilt whole.
        let resizeTimer = null;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(paintProfiles, 150);
        });
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
            finishBusy();
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
