import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Channel the MR Studio table already listens on (MR-Table/main.js:387).
 * Reused rather than invented so the existing controller and this panel are
 * interchangeable senders.
 */
const CHANNEL = 'map_controller_channel';

/** Where the table is served from, through the Vite proxy. */
const DISPLAY_URL = '/mr/index.html';
const CONTROLLER_URL = '/mr/controller.html';

interface MRTablePanelProps {
  /** Hour the dashboard is showing, pushed to the table when sync is on. */
  currentHour: number;
  totalHours: number;
}

/**
 * Drives the ACE MR Studio projection table from the dashboard.
 *
 * BroadcastChannel is same-origin, so the table has to be opened through this
 * app's own origin - the Vite proxy maps /mr to the static server in MR-Table/.
 * Opening it on :8090 directly puts it in another origin and nothing sent from
 * here would arrive.
 */
export const MRTablePanel: React.FC<MRTablePanelProps> = ({ currentHour, totalHours }) => {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [syncHour, setSyncHour] = useState(false);
  const [lastSent, setLastSent] = useState<string | null>(null);

  useEffect(() => {
    // Guard: BroadcastChannel is unavailable in a few embedded webviews, and
    // the panel should degrade rather than throw on mount.
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channelRef.current = channel;
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const send = useCallback((message: Record<string, unknown>, label: string) => {
    channelRef.current?.postMessage(message);
    setLastSent(label);
  }, []);

  // Push the hour whenever it moves, but only while sync is armed - otherwise
  // scrubbing the dashboard would drag a table someone else is presenting on.
  useEffect(() => {
    if (!syncHour) return;
    channelRef.current?.postMessage({ type: 'ecom_hour', hour: currentHour, totalHours });
    setLastSent(`hour ${String(currentHour % 24).padStart(2, '0')}:00`);
  }, [syncHour, currentHour, totalHours]);

  const available = typeof BroadcastChannel !== 'undefined';

  return (
    <div className="space-y-3">
      <p className="mr-note">
        Open the table display in a second window, then drive it from here. It has
        to be opened through this link so both share an origin.
      </p>

      <div className="flex gap-2">
        <a className="mr-btn mr-btn--primary" href={DISPLAY_URL} target="_blank" rel="noreferrer">
          Open display
        </a>
        <a className="mr-btn" href={CONTROLLER_URL} target="_blank" rel="noreferrer">
          Their controller
        </a>
      </div>

      <label className="mr-toggle">
        <input
          type="checkbox"
          checked={syncHour}
          onChange={(e) => setSyncHour(e.target.checked)}
          disabled={!available}
        />
        <span>
          <span className="mr-toggle__title">Follow the timeline</span>
          <span className="mr-toggle__detail">
            Sends the hour to the table as you scrub
          </span>
        </span>
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          className="mr-btn"
          disabled={!available}
          onClick={() => send({ type: 'reset_view' }, 'reset view')}
        >
          Reset view
        </button>
        <button
          type="button"
          className="mr-btn"
          disabled={!available}
          onClick={() =>
            send({ type: 'control_action', target: 'ecom-energy-btn' }, 'toggle energy layer')
          }
        >
          Toggle energy layer
        </button>
      </div>

      <p className="mr-status">
        {!available
          ? 'BroadcastChannel is not available in this browser.'
          : lastSent
            ? `Sent: ${lastSent}`
            : 'Nothing sent yet.'}
      </p>

      {/* The layer these target now exists, so the note says where the knobs
          live rather than what is missing. */}
      <p className="mr-note mr-note--callout">
        The table has its own copy of this console: open its controller and the
        Community Controls column drives the same parameters, re-dispatching
        through <code>/api/mr/layer</code>. Editing here and editing there are
        two hands on one table - the last apply wins.
      </p>
    </div>
  );
};

export default MRTablePanel;
