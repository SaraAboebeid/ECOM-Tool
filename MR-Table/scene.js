// Scene - the interventions someone places, held as diffs on the data the
// layers already read.
//
// Every layer in animations/ begins by fetching one GeoJSON file: street-life
// reads street-network.geojson, the CFD reads building-footprints.geojson and
// trees.geojson. Nothing here adds a parallel "interventions" system that each
// layer would then have to special-case. An intervention is an edit against one
// of those named datasets, and a layer opts in by routing its fetch through
// Scene.resolve() and re-reading itself on change.
//
// That is what makes a pedestrianised street cost no new drawing code.
// street-life classifies every path by properties.highway alone - isVehicleRoad,
// isPedestrianPath, isBusRoute - so flipping that one property on the source
// feature is what moves the cars off the street and the pedestrians onto it.
// The animation never learns that an intervention exists.
//
// An edit is one of:
//
//   { op: 'add',    dataset: 'buildings', features: [ <GeoJSON Feature>, ... ] }
//   { op: 'modify', dataset: 'streets',   match: { name: 'Aschebergsgatan' },
//                                         props: { highway: 'pedestrian' } }
//
// `match` compares against properties, so it selects by whatever identifies a
// feature in that file - and what that is has to be checked per dataset rather
// than assumed. In this street export osm_id is unique per feature (1246
// features, 1246 ids), so matching on it changes one twenty-metre segment.
// `name` is what groups a street: Aschebergsgatan is twenty features. So the
// authoring view matches on name where a street has one, which is also the
// intervention an urban designer means, and falls back to osm_id for the 74% of
// segments that are unnamed.
//
// Sync is BroadcastChannel, which reaches other windows on this machine only.
// That is deliberate for now: it proves the mechanism without any networking.
// Moving the authoring view to an iPad means replacing the channel here, and
// nowhere else.
//
// Exposes global: Scene

(function () {
    'use strict';

    const CHANNEL_NAME = 'map_controller_channel';
    const STORAGE_KEY = 'mr_scene_v1';

    // Base data exactly as it came off disk, keyed by the name a layer resolved
    // it under. Kept so that undo needs no refetch: every merge is recomputed
    // from base + the current edits, never applied on top of the last result.
    const bases = {};
    const memo = {};
    let edits = [];
    const listeners = [];

    let channel = null;
    try {
        channel = new BroadcastChannel(CHANNEL_NAME);
    } catch (err) {
        // Sync is a convenience, not a requirement - both the authoring view and
        // the display still work on their own.
        console.warn('Scene: BroadcastChannel unavailable, running unsynced', err);
    }

    function newId() {
        return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }

    function matches(feature, match) {
        if (!match) return false;
        const props = feature.properties || {};
        return Object.keys(match).every(function (key) { return props[key] === match[key]; });
    }

    // base + edits -> the collection a layer should read. Added features and
    // modified ones both carry _scene_edit so the display overlay can draw the
    // intervention itself, not only its effect.
    function merge(name) {
        const base = bases[name];
        if (!base) return null;
        if (memo[name]) return memo[name];

        const relevant = edits.filter(function (edit) { return edit.dataset === name; });

        const features = base.features.map(function (feature) {
            let out = feature;
            relevant.forEach(function (edit) {
                if (edit.op !== 'modify' || !matches(out, edit.match)) return;
                out = {
                    type: 'Feature',
                    geometry: out.geometry,
                    properties: Object.assign({}, out.properties, edit.props, { _scene_edit: edit.id })
                };
            });
            return out;
        });

        relevant.forEach(function (edit) {
            if (edit.op !== 'add') return;
            (edit.features || []).forEach(function (feature) {
                features.push({
                    type: 'Feature',
                    geometry: feature.geometry,
                    properties: Object.assign({}, feature.properties, {
                        _scene_edit: edit.id,
                        _scene_added: true
                    })
                });
            });
        });

        memo[name] = { type: 'FeatureCollection', features: features };
        return memo[name];
    }

    function invalidate(names) {
        names.forEach(function (name) { delete memo[name]; });
        listeners.forEach(function (fn) {
            try {
                fn(names);
            } catch (err) {
                console.error('Scene: listener failed', err);
            }
        });
    }

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
        } catch (err) {
            // Private mode, or a full quota. The scene still works for this
            // session; it just will not survive a reload.
        }
    }

    function restore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            edits = raw ? (JSON.parse(raw) || []) : [];
        } catch (err) {
            edits = [];
        }
    }

    function datasetsOf(list) {
        const seen = {};
        list.forEach(function (edit) { seen[edit.dataset] = true; });
        return seen;
    }

    // Wholesale replacement, used by undo and clear. Both the datasets that were
    // touched before and the ones touched after have to be told, or a layer
    // whose last edit was just removed never hears that it changed.
    function setEdits(next, broadcast) {
        const affected = Object.assign({}, datasetsOf(edits), datasetsOf(next));
        edits = next;
        persist();
        invalidate(Object.keys(affected));
        if (broadcast && channel) channel.postMessage({ type: 'scene_state', edits: edits });
    }

    function apply(edit) {
        const full = Object.assign({ id: newId(), op: 'add' }, edit);
        if (!full.dataset) throw new Error('Scene.apply: an edit needs a dataset');
        if (full.op === 'add' && !full.features) {
            full.features = full.feature ? [full.feature] : [];
            delete full.feature;
        }
        edits = edits.concat([full]);
        persist();
        invalidate([full.dataset]);
        if (channel) channel.postMessage({ type: 'scene_edit', edit: full });
        return full;
    }

    if (channel) {
        channel.addEventListener('message', function (event) {
            const data = event.data || {};

            if (data.type === 'scene_edit' && data.edit) {
                // BroadcastChannel does not echo to the sender, so this is a
                // peer's edit - unless a state exchange crossed it in flight.
                if (edits.some(function (e) { return e.id === data.edit.id; })) return;
                edits = edits.concat([data.edit]);
                persist();
                invalidate([data.edit.dataset]);

            } else if (data.type === 'scene_state') {
                setEdits(data.edits || [], false);

            } else if (data.type === 'scene_request') {
                channel.postMessage({ type: 'scene_state', edits: edits });
            }
        });
    }

    restore();

    window.Scene = {
        // A layer calls this once, with what it fetched, and reads the result
        // instead. Registering the base is what lets the scene be recomputed
        // later without going back to the network.
        resolve: function (name, geojson) {
            bases[name] = geojson;
            delete memo[name];
            return merge(name) || geojson;
        },

        // The merged collection, or null if no layer has registered a base yet.
        dataset: function (name) { return merge(name); },

        hasBase: function (name) { return Boolean(bases[name]); },

        apply: apply,

        undo: function () {
            if (!edits.length) return null;
            const last = edits[edits.length - 1];
            setEdits(edits.slice(0, -1), true);
            return last;
        },

        clear: function () { setEdits([], true); },

        edits: function () { return edits.slice(); },

        onChange: function (fn) { listeners.push(fn); },

        // Asks any peer window for its edits. Only needed when localStorage was
        // unavailable, or when a window opened mid-session.
        requestState: function () {
            if (channel) channel.postMessage({ type: 'scene_request' });
        }
    };

    console.log('Scene module loaded (' + edits.length + ' edit' + (edits.length === 1 ? '' : 's') + ' restored)');

})();
