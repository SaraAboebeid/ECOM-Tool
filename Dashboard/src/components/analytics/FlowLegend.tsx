import { NODE_COLORS } from '../../types';

/**
 * Key for the flows drawn on the map, pinned to the viewer's bottom-right.
 *
 * Uses NODE_COLORS directly rather than the analytics palette: this legend sits
 * on the map, so it has to match what the map actually draws - a link takes the
 * colour of the node it flows out of.
 */
const ENTRIES: { type: string; label: string }[] = [
  { type: 'grid', label: 'Grid supply' },
  { type: 'pv', label: 'Solar generation' },
  { type: 'building', label: 'Shared between buildings' },
  { type: 'battery', label: 'Battery flow' },
];

export const FlowLegend: React.FC = () => (
  <div className="flow-legend" aria-label="Flow colour key">
    <span className="flow-legend__title">Energy flow</span>
    <ul>
      {ENTRIES.map(({ type, label }) => (
        <li key={type}>
          <span className="flow-legend__line"
                style={{ background: NODE_COLORS[type] ?? '#94a3b8' }} aria-hidden />
          <span>{label}</span>
        </li>
      ))}
    </ul>
    {/* Width carries magnitude, so the key would be misread as "all flows look
        like this" without saying so. */}
    <span className="flow-legend__note">Line width follows flow size</span>
  </div>
);

export default FlowLegend;
