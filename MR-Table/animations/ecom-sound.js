// ECOM Energy Sonification
// ========================
// The energy community, heard.
//
// Nothing here is a recording. Every sound is synthesised from the hour the
// table is showing, so it carries the same three readings the picture does and
// cannot drift from them:
//
//   grid import      the rush: filtered noise, the sound of current in a cable
//                    rather than a note. It swells as the campus leans on the
//                    grid and thins out as it covers itself, breathing slowly
//                    so it moves the way a load does.
//
//   self-sufficiency the colour of that rush. Running on its own roofs it is
//                    dark and distant; leaning on the grid it opens up and
//                    comes forward.
//
//   the buzz         underneath it, a transformer under load: 100 Hz and its
//                    first two harmonics, the spectrum a core actually makes
//                    when magnetostriction pulls it twice per mains cycle. It
//                    is the electricity itself, and it loads up with the grid,
//                    rising in pitch as it does.
//
// Two things have been taken out along the way and stay out: a pulse train
// carrying grid import, and a bell on the hour. A repeating click is the one
// texture a room cannot stop hearing, and a table is stood around for an
// afternoon; a chime every 1.1 seconds is the same problem wearing a nicer
// coat. Nothing is an event any more - the sound is continuous and slow, and
// everything it says it says by changing.
//
// The buzz is a drone, which was tried and rejected twice before - but the
// versions that failed were a sawtooth stack sitting on top of the room and,
// after that, a bare sine with nothing electrical about it. This one is built
// from the harmonics a transformer core actually produces, and it is mixed at
// a fraction of the level those were: it is the floor of the sound, under the
// rush, not a note anyone is asked to listen to.
//
// The sound comes up with the energy layer and goes away with it. It is a
// reading of what is on the table, so it belongs to the layer rather than to a
// switch someone has to know about - and the layer is itself switched on by
// hand, so nothing here ever starts on an unattended table.
//
// Turning it off in the controller mutes it for the session: it stays off
// through any number of layer switches until it is asked for again.
//
// Exposes globals: ecomSound

(function () {
    'use strict';

    const channel = new BroadcastChannel('map_controller_channel');

    // The band the rush sits in. Low and narrow when the community is running
    // on itself, opening upward as it leans on the grid - the same move a
    // transformer room makes as it loads up.
    const FLOW_HZ_CALM = 240;
    const FLOW_HZ_STRAINED = 900;

    // Magnetostriction pulls a transformer core twice per mains cycle, so it
    // hums at twice the 50 Hz supply and at every multiple of that. Three
    // partials is enough to be recognisably electrical; more and it starts to
    // buzz in the way that grates.
    const BUZZ_HZ = 100;
    const BUZZ_PARTIALS = [1, 2, 3];
    const BUZZ_WEIGHTS = [1, 0.55, 0.28];

    // It does not sit on one frequency. A fixed pitch reads as a test tone, and
    // there is something worth saying with the movement: the whole buzz rises
    // as the campus loads up, so the pitch is the reading and not just decor.
    // On top of that a very slow wander keeps it from ever being quite still.
    const BUZZ_LOAD_RISE = 0.22;    // up to a fifth higher under full import
    const BUZZ_WANDER_HZ = 2.5;     // how far it drifts
    const BUZZ_WANDER_RATE = 0.06;  // a cycle every sixteen seconds or so

    let ctx = null;
    let master = null;
    let enabled = false;

    // Set when someone turns the sound off from the controller, so bringing the
    // layer back does not bring the sound back with it.
    let muted = false;

    // What the table is showing. Updated from the layer, never computed here:
    // a second opinion about the same hour is a second thing to keep in step.
    const state = {
        gridNow: 0,          // 0..1, how hard the campus is drawing
        selfSufficiency: 0,  // 0..1
        solarNow: 0,         // 0..1
        hour: 0
    };

    let flow = null;                // the noise source
    let flowGain = null;
    let filter = null;
    let breath = null;              // slow swell on the rush
    let breathGain = null;
    let buzzGain = null;            // the transformer, all partials together
    let buzzShape = null;           // rolls the harmonics off
    let buzzTones = [];             // the partials themselves, to retune

    // ------------------------------------------------------------- graph

    function build() {
        if (ctx) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        ctx = new Ctx();

        master = ctx.createGain();
        master.gain.value = 0;              // faded in by enable()
        master.connect(ctx.destination);

        // Two seconds of noise on a loop, band-passed: the rush of energy
        // moving. Two seconds because a shorter loop has a period the ear
        // starts to hear as a rhythm.
        const seconds = 2;
        const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
        const samples = buffer.getChannelData(0);
        let low = 0;
        for (let i = 0; i < samples.length; i += 1) {
            // Rolled off as it is generated, so the raw hiss never gets through
            // even if the filter is wide open.
            low = low * 0.86 + (Math.random() * 2 - 1) * 0.14;
            samples[i] = low;
        }

        filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = FLOW_HZ_CALM;
        // Broad. A narrow band rings, and a ringing band is a note again.
        filter.Q.value = 0.6;
        filter.connect(master);

        flowGain = ctx.createGain();
        flowGain.gain.value = 0;
        flowGain.connect(filter);

        flow = ctx.createBufferSource();
        flow.buffer = buffer;
        flow.loop = true;
        flow.connect(flowGain);
        flow.start();

        // The transformer. Additive rather than a sawtooth, because a sawtooth
        // brings every harmonic up to about 5 kHz with it and those are what
        // make a drone unbearable to stand next to. Three partials, rolled off
        // above them, and nothing above that at all.
        buzzShape = ctx.createBiquadFilter();
        buzzShape.type = 'lowpass';
        buzzShape.frequency.value = 420;
        buzzShape.Q.value = 0.4;
        buzzShape.connect(master);

        buzzGain = ctx.createGain();
        buzzGain.gain.value = 0;
        buzzGain.connect(buzzShape);

        // The wander, shared by every partial so they move together and the
        // spectrum stays a transformer rather than drifting apart into chords.
        const wander = ctx.createOscillator();
        wander.type = 'sine';
        wander.frequency.value = BUZZ_WANDER_RATE;
        wander.start();

        buzzTones = BUZZ_PARTIALS.map(function (partial, index) {
            const level = ctx.createGain();
            level.gain.value = BUZZ_WEIGHTS[index];
            level.connect(buzzGain);

            const tone = ctx.createOscillator();
            tone.type = 'sine';
            tone.frequency.value = BUZZ_HZ * partial;
            tone.connect(level);
            tone.start();

            // Each partial wanders by its own multiple, so the harmonic
            // relationship holds while the whole thing moves.
            const depth = ctx.createGain();
            depth.gain.value = BUZZ_WANDER_HZ * partial;
            depth.connect(tone.frequency);
            wander.connect(depth);

            return { tone: tone, partial: partial };
        });

        // And a slow swell over the top of it, so the rush moves the way a
        // load does rather than sitting perfectly still.
        breathGain = ctx.createGain();
        breathGain.gain.value = 0;
        breathGain.connect(flowGain.gain);

        breath = ctx.createOscillator();
        breath.type = 'sine';
        breath.frequency.value = 0.08;        // a cycle every twelve seconds
        breath.connect(breathGain);
        breath.start();
    }

    // ------------------------------------------------------------ voices

    // ------------------------------------------------------------ mapping

    function apply() {
        if (!ctx || !enabled) return;
        const now = ctx.currentTime;
        const ease = 0.4;                   // seconds, so nothing jumps

        const calm = state.selfSufficiency;
        const strain = 1 - calm;

        // The rush is the backing now, not the main voice: the buzz is what
        // was asked for and it has to be the thing you hear. A third of what
        // it was.
        const level = 0.004 + state.gridNow * 0.010;
        flowGain.gain.setTargetAtTime(level, now, ease);
        // The swell is a fraction of that, so it breathes rather than pumps.
        breathGain.gain.setTargetAtTime(level * 0.35, now, ease);

        // Self-sufficiency sets its colour: dark and far off when the roofs
        // are covering the campus, open and forward when the grid is.
        filter.frequency.setTargetAtTime(
            FLOW_HZ_CALM + strain * (FLOW_HZ_STRAINED - FLOW_HZ_CALM), now, ease);

        // The transformer, and it is meant to be heard: it was mixed at a
        // fiftieth of this and simply was not there. It loads up with the grid
        // like everything else.
        buzzGain.gain.setTargetAtTime(0.030 + state.gridNow * 0.055, now, ease);
        // And its harmonics open under load, the way a core does - far enough
        // now to let the second and third through, which is where the buzz in
        // a transformer buzz actually lives.
        buzzShape.frequency.setTargetAtTime(360 + state.gridNow * 420, now, ease);

        // The pitch rises with the load. Slowly - a whole hour of the day is
        // 1.1 seconds here, and a buzz that lurched from hour to hour would be
        // a siren rather than a room.
        const pitch = BUZZ_HZ * (1 + state.gridNow * BUZZ_LOAD_RISE);
        buzzTones.forEach(function (voice) {
            voice.tone.frequency.setTargetAtTime(pitch * voice.partial, now, 1.2);
        });
    }

    // ------------------------------------------------- keeping it running

    // A browser can suspend an AudioContext at any time - a tab losing focus,
    // an autoplay policy deciding the page has been quiet too long, an audio
    // device changing under it. When that happens currentTime freezes, every
    // scheduled ramp stops arriving, and the sound simply stops with nothing
    // said about it.
    //
    // So: resume on any gesture in this document, watch for the state changing,
    // and check every couple of seconds that it is still running and still
    // pulsing. Whatever the cause, it comes back.
    let watchdog = null;
    let unlockBound = false;

    // Older implementations return nothing from resume() rather than a promise,
    // and a resume inside the watchdog that throws would stop the watchdog -
    // taking away the very thing meant to recover the sound.
    function tryResume() {
        if (!ctx || ctx.state !== 'suspended') return;
        try {
            const p = ctx.resume();
            if (p && typeof p.then === 'function') {
                p.then(announce, function () { announce(); blocked(); });
            } else {
                announce();
            }
        } catch (err) {
            announce();
            blocked();
        }
    }

    // Said on the table itself, because the table is where the click has to
    // happen: a press on the controller is a gesture in that document and not
    // in this one, and a browser will not start audio for a page nobody has
    // touched.
    let toldThem = false;
    function blocked() {
        if (toldThem || !enabled) return;
        toldThem = true;
        if (typeof showToast === 'function') {
            showToast('Click the table once to let the sound play', 6000);
        }
    }

    function bindUnlock() {
        if (unlockBound) return;
        unlockBound = true;
        const unlock = tryResume;
        ['click', 'touchstart', 'keydown'].forEach(function (type) {
            document.addEventListener(type, unlock, { passive: true });
        });
    }

    // Watching ctx.currentTime is the one test that separates the two ways this
    // can go quiet. A frozen clock means the browser stopped the context and no
    // amount of level-setting will be heard. A clock that keeps advancing while
    // nothing is audible means the graph is running and the sound is simply too
    // quiet or too low to come out of these speakers - a different problem, and
    // not one to fix by resuming things that are already running.
    let lastClock = 0;
    let clockMoving = true;

    function startWatchdog() {
        if (watchdog !== null) return;
        lastClock = ctx ? ctx.currentTime : 0;
        watchdog = setInterval(function () {
            if (!enabled || !ctx) return;
            const moved = ctx.currentTime > lastClock + 0.001;
            lastClock = ctx.currentTime;
            if (moved !== clockMoving) {
                clockMoving = moved;
                announce();
            }
            tryResume();
        }, 2000);
    }

    // ------------------------------------------------------------ control

    function enable() {
        build();
        if (!ctx) return false;
        enabled = true;
        bindUnlock();
        startWatchdog();

        // The press that asked for this happened on the controller, in another
        // document - it is not a gesture here, so the context may refuse to
        // start until someone touches the table's own window. announce() says
        // which, rather than leaving a button claiming sound that is not there.
        tryResume();
        if (ctx.onstatechange === null) ctx.onstatechange = announce;

        master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.6);
        apply();
        announce();
        // The hour it should be describing. Without asking, the sound opens on
        // whatever it last heard - silence, at startup - until the next tick,
        // and the day clock can be stopped altogether.
        channel.postMessage({ type: 'ecom_audio_request' });
        return true;
    }

    function disable() {
        enabled = false;
        if (watchdog !== null) {
            clearInterval(watchdog);
            watchdog = null;
        }
        if (ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
        announce();
    }

    function toggle() {
        return enabled ? (disable(), false) : enable();
    }

    function announce() {
        channel.postMessage({
            type: 'ecom_sound_state',
            on: enabled,
            // What the browser is actually doing with it. A button that says
            // "playing" over a suspended context is worse than one that says
            // nothing.
            running: !!ctx && ctx.state === 'running',
            contextState: ctx ? ctx.state : 'none',
            clock: ctx ? Math.round(ctx.currentTime * 10) / 10 : 0,
            clockMoving: clockMoving
        });
    }

    // ------------------------------------------------------------ inputs

    // The layer reports the hour it just drew, so the sound is of the same
    // hour rather than of one computed a second later from the same data.
    channel.addEventListener('message', function (event) {
        const data = event.data || {};

        if (data.type === 'ecom_sound') {
            if (data.on === true) { muted = false; enable(); }
            else if (data.on === false) { muted = true; disable(); }
            else { muted = enabled; toggle(); }
            return;
        }

        if (data.type === 'ecom_sound_request') {
            announce();
            return;
        }

        if (data.type === 'ecom_audio' && data.reading) {
            const reading = data.reading;
            state.gridNow = reading.gridNow || 0;
            state.selfSufficiency = reading.selfSufficiency || 0;
            state.solarNow = reading.solarNow || 0;
            state.hour = reading.hour || 0;
            apply();
        }

        // The sound follows the layer both ways. Leaving a hum running over a
        // different simulation would be describing something nobody is looking
        // at; and a layer with no sound was the commonest way to end up
        // wondering where the sound had gone.
        if (data.type === 'animation_state' &&
            data.animationId === 'ecom-energy-btn') {
            if (!data.isActive) disable();
            else if (!muted) enable();
        }
    });

    window.ecomSound = {
        enable: enable,
        disable: disable,
        toggle: toggle,
        isOn: function () { return enabled; },
        // For the harness: what the graph is currently set to.
        reading: function () { return Object.assign({}, state); },
        levels: function () {
            if (!ctx) return null;
            return {
                master: master.gain.value,
                flow: flowGain.gain.value,
                breath: breathGain.gain.value,
                buzz: buzzGain.gain.value,
                buzzCutoff: buzzShape.frequency.value,
                // Neither a held tone nor a beat. Kept so a test can say so.
                pulsesPerSecond: 0,
                cutoff: filter.frequency.value
            };
        }
    };
})();
