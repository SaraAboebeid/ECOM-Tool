// ECOM Energy Sonification
// ========================
// The energy community, heard.
//
// Nothing here is a recording. Every sound is synthesised from the hour the
// table is showing, so it carries the same three readings the picture does and
// cannot drift from them:
//
//   grid import      a pulse train. The harder the campus leans on the grid,
//                    the denser the pulses - one every few seconds when it is
//                    nearly self-sufficient, a steady patter when it is not.
//
//   self-sufficiency the texture. High, and the mains hum is filtered back to a
//                    soft low tone and the local generation rings a clean fifth
//                    above it. Low, and the filter opens, a detuned second
//                    oscillator beats against the first, and it gets restless.
//
//   solar now        a bell on the hour when the roofs are producing, brighter
//                    at midday than at dawn.
//
// The pitch is not arbitrary. The drone sits at 100 Hz - the second harmonic of
// the 50 Hz Swedish grid, which is the sound a transformer actually makes. When
// the campus is importing hard you are listening to mains hum; when it is
// running on its own roofs, that hum recedes and a clean tone takes over. The
// mapping is the point, not the prettiness.
//
// Sound is off until asked for. A projection table runs unattended for hours,
// and audio that starts by itself is audio someone has to go and find the
// switch for.
//
// Exposes globals: ecomSound

(function () {
    'use strict';

    const channel = new BroadcastChannel('map_controller_channel');

    // A harmonic of the 50 Hz Swedish grid: magnetostriction pulls the core
    // twice per cycle, so a transformer hums at 100 Hz and at every multiple of
    // it. 200 Hz - the fourth harmonic - rather than the second, because the
    // table's speakers are small: 100 Hz is below what they reproduce, and a
    // drone nobody can hear is a reading nobody gets.
    const MAINS_HZ = 200;

    // Pulses per second at full grid import, and at none. Chosen by ear against
    // the campus data: at 0.9 import - which is most of this scenario's day -
    // it should feel busy but countable, not a buzz.
    const PULSE_MIN_HZ = 0.35;
    const PULSE_MAX_HZ = 6.5;

    let ctx = null;
    let master = null;
    let enabled = false;

    // What the table is showing. Updated from the layer, never computed here:
    // a second opinion about the same hour is a second thing to keep in step.
    const state = {
        gridNow: 0,          // 0..1, how hard the campus is drawing
        selfSufficiency: 0,  // 0..1
        solarNow: 0,         // 0..1
        hour: 0
    };

    let drone = null;
    let droneBeat = null;
    let droneGain = null;
    let beatGain = null;
    let filter = null;
    let localTone = null;
    let localGain = null;
    let pulseTimer = null;

    // ------------------------------------------------------------- graph

    function build() {
        if (ctx) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        ctx = new Ctx();

        master = ctx.createGain();
        master.gain.value = 0;              // faded in by enable()
        master.connect(ctx.destination);

        // The grid hum, and its detuned twin. The twin only comes up when
        // self-sufficiency is low: two oscillators a fraction apart beat
        // against each other, and that beating is the restlessness.
        filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 300;
        filter.Q.value = 0.7;
        filter.connect(master);

        droneGain = ctx.createGain();
        droneGain.gain.value = 0;
        droneGain.connect(filter);

        drone = ctx.createOscillator();
        drone.type = 'sawtooth';
        drone.frequency.value = MAINS_HZ;
        drone.connect(droneGain);
        drone.start();

        beatGain = ctx.createGain();
        beatGain.gain.value = 0;
        beatGain.connect(filter);

        droneBeat = ctx.createOscillator();
        droneBeat.type = 'sawtooth';
        // A little over half a hertz apart: slow enough to hear as a pulse in
        // the tone rather than as a second note.
        droneBeat.frequency.value = MAINS_HZ + 0.6;
        droneBeat.connect(beatGain);
        droneBeat.start();

        // Local generation: a clean fifth above the mains hum. Consonant on
        // purpose - the community running on its own roofs should sound
        // resolved, and the grid hum should not.
        localGain = ctx.createGain();
        localGain.gain.value = 0;
        localGain.connect(master);

        localTone = ctx.createOscillator();
        localTone.type = 'sine';
        localTone.frequency.value = MAINS_HZ * 1.5;
        localTone.connect(localGain);
        localTone.start();
    }

    // ------------------------------------------------------------ voices

    /** A short click: one parcel of energy arriving from outside. */
    function pulse() {
        if (!ctx || !enabled) return;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        // Rises with import, so a hard-drawing campus is higher as well as
        // busier. Two cues for one reading is easier to hear than either alone.
        osc.frequency.value = 180 + state.gridNow * 140;

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.05 + state.gridNow * 0.06, now + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + 0.1);
    }

    /** A bell on the hour, when the roofs are making something. */
    function chime() {
        if (!ctx || !enabled || state.solarNow <= 0.02) return;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        // Higher at midday than at dawn, so the arc of the day is audible.
        osc.frequency.value = MAINS_HZ * (4 + state.solarNow * 2);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.03 + state.solarNow * 0.05, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + 1.3);
    }

    // ------------------------------------------------------------ mapping

    function apply() {
        if (!ctx || !enabled) return;
        const now = ctx.currentTime;
        const ease = 0.4;                   // seconds, so nothing jumps

        const calm = state.selfSufficiency;
        const strain = 1 - calm;

        // The hum recedes as the community covers more of its own demand.
        droneGain.gain.setTargetAtTime(0.012 + state.gridNow * 0.05, now, ease);

        // Beating only under strain. At high self-sufficiency it is silent and
        // the tone is steady.
        beatGain.gain.setTargetAtTime(strain * strain * 0.035, now, ease);

        // Calm closes the filter: darker, softer, further away.
        filter.frequency.setTargetAtTime(180 + strain * 900, now, ease);

        // And the local tone comes up with self-sufficiency.
        localGain.gain.setTargetAtTime(calm * 0.05, now, ease);

        schedulePulses();
    }

    function pulseGapMs() {
        // Density is the headline mapping: pulses per second rise with import.
        const rate = PULSE_MIN_HZ + state.gridNow * (PULSE_MAX_HZ - PULSE_MIN_HZ);
        return Math.max(60, 1000 / Math.max(rate, 0.01));
    }

    // Each pulse books the next one.
    //
    // This was a setInterval rebuilt on every reading, which arrive once an
    // hour-tick. Any gap longer than that tick was cleared before it could ever
    // fire, so a self-sufficient community - the quiet end, where a pulse
    // carries the most information - fell completely silent.
    function schedulePulses() {
        if (pulseTimer !== null) {
            clearTimeout(pulseTimer);
            pulseTimer = null;
        }
        if (!enabled) return;
        pulseTimer = setTimeout(function () {
            pulseTimer = null;
            pulse();
            schedulePulses();
        }, pulseGapMs());
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
            if (p && typeof p.then === 'function') p.then(announce, announce);
            else announce();
        } catch (err) {
            announce();
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
            // The scheduler can be lost if a pulse ever threw; this restarts it.
            if (pulseTimer === null) schedulePulses();
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
        return true;
    }

    function disable() {
        enabled = false;
        if (pulseTimer !== null) {
            clearTimeout(pulseTimer);
            pulseTimer = null;
        }
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
            if (data.on === true) enable();
            else if (data.on === false) disable();
            else toggle();
            return;
        }

        if (data.type === 'ecom_sound_request') {
            announce();
            return;
        }

        if (data.type === 'ecom_audio' && data.reading) {
            const reading = data.reading;
            const changedHour = reading.hour !== state.hour;
            state.gridNow = reading.gridNow || 0;
            state.selfSufficiency = reading.selfSufficiency || 0;
            state.solarNow = reading.solarNow || 0;
            state.hour = reading.hour || 0;
            apply();
            if (changedHour) chime();
        }

        // The layer went away; so does the sound. Leaving a hum running over a
        // different simulation would be describing something nobody is looking
        // at.
        if (data.type === 'animation_state' &&
            data.animationId === 'ecom-energy-btn' && !data.isActive) {
            disable();
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
                hum: droneGain.gain.value,
                beat: beatGain.gain.value,
                local: localGain.gain.value,
                cutoff: filter.frequency.value,
                pulsesPerSecond: PULSE_MIN_HZ +
                    state.gridNow * (PULSE_MAX_HZ - PULSE_MIN_HZ)
            };
        }
    };
})();
