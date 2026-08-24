import { Node, Link, NODE_COLORS } from '../../types';
import FlowSparkline from './components/FlowSparkline';

interface NodeDetailsPanelProps {
  selectedNode: Node | null;
  onClose: () => void;
  links?: Link[];
  /**
   * Every node from the dispatch, before filtering.
   *
   * Roof arrays are hidden from the map - the building already shows a PV badge
   * and its combined capacity - but their per-array detail still has to be
   * reachable, so it is listed here on the building that owns them.
   */
  allNodes?: Node[];
}

interface Stat {
  label: string;
  value: string;
}

const TYPE_LABELS: Record<string, string> = {
  building: 'Building',
  pv: 'Solar array',
  battery: 'Battery',
  charge_point: 'Charge point',
  grid: 'Grid connection',
};

const num = (value: number, digits = 2): string =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/**
 * Facts for a node, as a list rather than bespoke markup per type.
 *
 * The five branches this replaced were the same row repeated thirty-odd times
 * with a different field name, which is why they had drifted into different
 * spacing and different treatments of a missing value.
 */
const statsFor = (node: Node): Stat[] => {
  const stats: Stat[] = [];
  const add = (label: string, value: unknown, format: (v: any) => string) => {
    // Explicitly allow zero: `if (value)` hid a battery at 0% and a PV array
    // with no production, which are exactly the cases worth seeing.
    if (value === undefined || value === null || value === '') return;
    stats.push({ label, value: format(value) });
  };

  switch (node.type) {
    case 'building':
      add('Type', node.building_type, String);
      add('Floor area', node.area, (v) => `${num(v, 0)} m²`);
      add('Owner', node.owner, String);
      add('Annual demand', node.total_energy_demand, (v) => `${num(v, 0)} kWh`);
      add('PV capacity', node.total_pv_capacity, (v) => `${num(v, 1)} kW`);
      break;
    case 'pv':
      add('Capacity', node.installed_capacity, (v) => `${num(v, 1)} kW`);
      add('Annual yield', node.annual_production, (v) => `${num(v, 0)} kWh`);
      add('Tilt', node.custom_slope, (v) => `${v}°`);
      add('Azimuth', node.azimuth, (v) => `${v}°`);
      add('Cost', node.total_cost, (v) => `${num(v, 0)} SEK`);
      add('Embodied CO₂', node.total_embodied_co2, (v) => `${num(v, 0)} kgCO₂e`);
      break;
    case 'battery':
      add('Capacity', node.capacity, (v) => `${num(v, 1)} kWh`);
      add('Cost', node.total_cost, (v) => `${num(v, 0)} SEK`);
      add('Embodied CO₂', node.total_embodied_co2, (v) => `${num(v, 0)} kgCO₂e`);
      break;
    case 'charge_point':
      add('Capacity', node.capacity, (v) => `${num(v, 1)} kW`);
      add('V2G', node.is_v2g, (v) => (v ? 'Enabled' : 'Not enabled'));
      add('Connected EVs', node.total_connected_evs, (v) => String(v));
      add('Owner', node.owner, String);
      break;
    default:
      break;
  }
  return stats;
};

/**
 * Detail drawer for the selected node.
 *
 * Sits above the viewer's own controls. It used to be z-10 against FABs at
 * z-50 and the flow key at z-40, so those drew straight through it - which is
 * why its close button looked missing.
 */
export const NodeDetailsPanel: React.FC<NodeDetailsPanelProps> = ({
  selectedNode, onClose, links = [], allNodes = [],
}) => {
  if (!selectedNode) return null;

  const accent = NODE_COLORS[selectedNode.type] ?? '#94a3b8';
  const stats = statsFor(selectedNode);

  /** Roof arrays mounted on this building. Ids are '<host>_PV_<plant>'. */
  const roofArrays = selectedNode.type === 'building'
    ? allNodes.filter((n) => n.type === 'pv' && n.id.startsWith(`${selectedNode.id}_PV_`))
    : [];

  return (
    <aside className="detail-drawer" role="dialog" aria-label="Node details">
      <header className="detail-drawer__head">
        <span className="detail-type" style={{ ['--accent' as string]: accent }}>
          <span className="detail-type__dot" aria-hidden />
          {TYPE_LABELS[selectedNode.type] ?? selectedNode.type}
        </span>
        <button type="button" onClick={onClose} className="detail-close"
                aria-label="Close details" title="Close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth={2.2} strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="detail-drawer__body">
        <h2 className="detail-name">{selectedNode.name || selectedNode.id}</h2>
        <p className="detail-id">{selectedNode.id}</p>

        {selectedNode.type === 'grid' && (
          <p className="detail-note">
            Import and export point for the whole community.
          </p>
        )}

        {stats.length > 0 && (
          <dl className="detail-stats">
            {stats.map((stat) => (
              <div key={stat.label} className="detail-stat">
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {roofArrays.length > 0 && (
          <section className="detail-section">
            <h3 className="detail-section__title">
              Roof arrays <span>{roofArrays.length}</span>
            </h3>
            <ul className="detail-arrays">
              {roofArrays.map((array) => (
                <li key={array.id}>
                  <span className="detail-array__name">
                    {array.name || array.id.split('_PV_')[1]}
                  </span>
                  <span className="detail-array__meta">
                    {[
                      array.installed_capacity != null && `${array.installed_capacity.toFixed(1)} kW`,
                      array.annual_production != null && `${(array.annual_production / 1000).toFixed(1)} MWh/yr`,
                      array.custom_slope != null && `${array.custom_slope}° tilt`,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {links.length > 0 && (
          <section className="detail-section">
            <h3 className="detail-section__title">Energy flow</h3>
            <FlowSparkline node={selectedNode} links={links} />
          </section>
        )}
      </div>
    </aside>
  );
};

export default NodeDetailsPanel;
